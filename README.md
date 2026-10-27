# dsh-workbuddy-billing · 积分看板

在**每条回复下方**显示这一轮消耗了多少积分、账号还剩多少积分。

```
⚡ 本轮消耗 −12.4 积分 · 剩余 3,420
```

鼠标悬停展开明细：输入 / 缓存读 / 缓存写 / 输出 / 推理 token 数、模型 id、
积分倍率、这个数字是**实测**还是**估算**、以及采样时间。

---

## 它为什么这样取数（重要）

DSH 上游**没有**暴露「这一轮扣了多少积分」这个字段，能读到的只有**余额**。
所以本插件按可靠性从高到低分三层取数，并把不确定性直接标在界面上：

| 层级 | 数据来源 | 准确性 | 界面标记 |
|---|---|---|---|
| 1 | `dsh-xdpool` 的用量账本（`/plugins/dsh-xdpool/usage`），按本轮时间窗把**该轮所有 step 的条目求和** | 上游给出的 token 数与模型，逐条精确 | `source:"usage-entry"`，`measured:true` |
| 2 | 余额差值：turn 开始与结束各采一次真实余额，相减 | **实测** | `source:"balance-delta"`，`measured:true` |
| 3 | 本地 token 用量 × 模型积分倍率 × `PRICE_BASIS` | 估算 | `source:"estimate"`，`measured:false` |

### 三个必须说清楚的事实

**① 一轮不等于一次上游调用。** DSH 的一个 turn 内部会跑多个 step（`step/start` →
`step/end`），每个 step 都是一次独立的上游请求。所以第 1 层是把落在本轮时间窗内的
**所有**条目**求和**，而不是"挑一条匹配的"。这一点如果按"唯一一条"实现，几乎每一轮
都匹配不上。

**② "实测"指的是 token 数，不是积分数。** 上游的用量账本里**没有任何积分/价格字段**
（已逐字节确认：71 KB 的 payload 里连 `"credit` 这个子串都不存在）。所以积分永远是
`tokens × 倍率 × PRICE_BASIS` 换算出来的。`measured` 只表示「这个 token 数是上游对
这一轮的真实记录」，不表示「这个积分数是上游扣的」。不把这两件事混为一谈，是
`source` 字段存在的全部理由。

**③ 匹配用时间窗，不用 id。** 账本里的 `turnId` 是 xdpool 自己的哈希
（如 `8bfcd38faebf147d`），和 DSH 的整数 turn 号没有关系，拿它匹配是猜。
时间戳不是猜的：条目带的 `at` 是那次调用结束的时刻，而本轮有真实的
`[turnStartMs, turnEndMs]`（取自 session 事件自带的 `time`）。

`PRICE_BASIS` 默认 `0.0001`（倍率 1.0 时每百万 token = 100 积分），
它是个**校准旋钮而不是真实单价**：如果你观察到自己账号的真实扣费比例不同，
可以在插件设置里改它。

### token 权重表（`TOKEN_WEIGHTS`）

| 桶 | 权重 | 说明 |
|---|---|---|
| `input` | 1 | 基准单位 |
| `cacheRead` | 0.1 | 缓存命中，通常便宜一个数量级 |
| `cacheWrite` | 1 | 缓存写入按新输入计价 |
| `output` | 4 | 输出是贵的方向，主流厂商普遍约 4 倍 |
| `reasoning` | 0 | **不额外加**：DSH 与 xdpool 的 payload 里推理 token 都**已包含在 output 内**，再加就是重复计费。明细里照样显示 |

两个"包含"关系在代码里是具名常量而不是隐式假设：
`CACHED_TOKENS_INCLUDED_IN_INPUT`（xdpool 的 `inputTokens` **已含** `cachedTokens`，
所以要先从 input 里扣掉缓存部分，否则同一批 prompt token 会被按全价和缓存价各算一次）、
`REASONING_TOKENS_INCLUDED_IN_OUTPUT`（同上）。两条都在真实 payload 上逐条验证过。

### 何时会"不敢给数"

以下情况**不汇报**一个漂亮的数字，而是退到下一层或标 `measured:false`：

- 时间窗内**没有**对应条目 → 退到余额差值；
- 时间窗比 15 分钟还宽（恢复、时钟跳变、陈旧条目）→ 不归属，退到余额差值；
- 余额**不降反升**（中途充值、退款、月度刷新）→ 差值为负的"消耗"比诚实估算更糟，退到估算；
- 差值大得不像一轮（> 5000 积分，多半是别人在同一账号上花钱）→ 退到估算；
- 余额字段缺失 → 报 `ok:false,"source":"unavailable"`，**绝不报 0**。

---

## 显示位置

注册在 ui-chat 的 `conversation.chat.turnTail` 列表插槽（session 作用域），
也就是每轮收尾的 assistant 文本之后、与文件交付物/计划卡片并列的位置。

- 轮次还在流式输出时不发任何请求、不渲染（`turn.status === "open"`）——
  避免在还没有收盘记录时把一次失败缓存成"无数据"。
- 渲染失败一律 `return null`，绝不把插件错误画进对话记录里。
- 提示文案走 DSH 的 locale 机制，内置中英双语文案，跟随界面语言。

---

## 安装

本插件是**本地开发插件**，不需要发布到 npm：

```powershell
# 一条命令即可：既写入 dependencies，也会把包名追加进 dsh.profile.bundles
dsh plugin --profile desktop add "<本仓库路径>"
```

`dsh plugin` 本身只是把参数转发给 profile 目录里的 pnpm，但 DSH 的插件安装流程
会在 pnpm 之后把包名补进 `dsh.profile.bundles`（实测：装完
`<DSH_HOME>/profiles/desktop/package.json` 里同时多了
`"dsh-workbuddy-billing": "link:<本仓库路径>"` 和 bundles 数组末尾的
`dsh-workbuddy-billing`）。

装完**必须重启** DeepSeek Harness：加载器按 `dsh.profile.bundles` 组合插件树，
运行中的 host 只持有它启动时的那份代码。重启后用
`GET /plugins/dsh-workbuddy-billing/health` 自查。

### 改名/换路径时

包名、`cordis.patch.yml` 里的 row id、`lib/index.js` 的 `ROUTE_PREFIX`、
`lib/client.js` 的 `__ModuleLoader__` id 与 locale namespace 必须一起改，否则
会出现「装上了但不显示」或「host 路由 404、browser 半部仍打旧地址」。
换路径时先在 profile 里 `remove` 旧包，再 `add` 新路径（直接改目录名会留下
指向旧路径的悬空 junction，`node_modules` 里那条链接需要清掉）。

---

## 结构与接口

```
dsh-workbuddy-billing/
  package.json          # dsh.bundle.patch + dsh.client.inject
  cordis.patch.yml      # 插入 host 行
  lib/index.js          # Host 半部：余额读取 + 逐轮账本 + HTTP 路由
  lib/client.js         # 浏览器半部：turnTail 里的 React 组件
  locale/zh.json        # 中文文案
  locale/en.json        # 英文文案
```

### Host 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/plugins/dsh-workbuddy-billing/credits` | 当前余额（含各积分包明细）+ `provider` 字段标明来源 |
| GET | `/plugins/dsh-workbuddy-billing/turn?turn=&session=&sinceMs=` | 单轮记录；未收盘时 `{ok:false,pending:true}` |
| GET | `/plugins/dsh-workbuddy-billing/health` | 自检：观察器是否挂上、provider 顺序、token 权重表、缓存状态、账本容量 |
| POST | `/plugins/dsh-workbuddy-billing/turn/begin` | 兜底：浏览器主动上报轮次开始 |
| POST | `/plugins/dsh-workbuddy-billing/turn/end` | 兜底：浏览器主动上报轮次结束 |

所有路由都过 loopback / 同源校验（`Host` 必须指向本机或本连接落地的地址，
`Origin` 存在时必须同样通过；两者都不是身份认证，只挡浏览器 CSRF 与 DNS rebinding）。

上表后两个 POST 是**兜底路径**：正常情况下 Host 通过 `ctx.on('session/event')`
自己就能看到 `turn/start` 与 `turn/end`，**不需要浏览器配合**。
`GET /turn` 也会在没有 begin/end 的情况下懒建基线，所以即使前端完全不上报、
或挂载环境没有 `ctx.on`，链路依然能走通——只是精度会退到估算。

### 积分来源（provider 顺序）

`readCreditTotal()` 里是一条有序 provider 链，任一可用即返回：

| # | provider | 路径 | 取的是哪一段 |
|---|---|---|---|
| 1 | `xdpool-status` | `GET /plugins/dsh-xdpool/status` | `accounts[]` 中 `id === activeAccountId` 的 `.credits.total` |
| 2 | `connect-usage` | `GET /plugins/dsh-connect-workbuddy/usage?region=cn` | 顶层 `.credits.total` |

provider 1 的三级回退：`activeAccountId` 命中的账号 → 带 `selected:true` 的账号 →
第一个**确实有** `credits` 的账号。只有当一个都选不出来时才求和（避免把陌生账号的余额
当成总余额）。

**`credits` 字段缺失 = 读不到，不等于 0。** 所有账号都没有余额时返回
`{ok:false,"source":"unavailable","error":"upstream-no-balance"}`，
界面显示「数据暂不可用」，绝不显示 `0`。

> 为什么不是 `dsh-connect-workbuddy`：本机 profile **没有安装**它
> （不在 `dsh.profile.bundles`、`node_modules` 里没有、路由返回 404）。
> 只依赖它会让这个插件永远什么都不显示，所以它降为可选的第二 provider。

---

## 验证情况

Host 半部在开发期用一个临时 harness 驱动真实插件代码验证（起一个假上游，喂**从本机
`127.0.0.1:8495` 原样抓下来的真实 xdpool 文档**，再用假的 ctx 模拟 Cordis 的
`effect` / `on` / `inject` 语义）。该 harness 是开发期脚本，**不随包发布**。

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `node --check` | `lib/index.js`、`lib/client.js` | 均通过 |
| Host 集成 | 路由注册、loopback 门禁、三层取数、多 step 求和、失败条目忽略、越界条目忽略、宽窗拒绝、LRU 上限、并发去重、无 `ctx.on`/`ctx.effect` 时降级 | **125/125** |
| 对抗性输入 | Proxy 抛错、循环引用、冻结对象、错误类型、缺字段的事件 | 无一处异常逃逸 |
| 真实 payload | 直接喂抓下来的 `xdpool/status` + `xdpool/usage`（含中文包名、276 条真实条目） | 全部解析正确 |
| 客户端行为（client-dev 负责） | 重试阶梯、pending→null、404 终止、locale 注册失败 | 65/65 |

真实数据读数（2026-10-27，`/plugins/dsh-xdpool/status` 实时）：

```
GET /plugins/dsh-workbuddy-billing/credits
→ {"ok":true,"total":12356,"source":"live","provider":"xdpool-status",
   "packages":[{"packageName":"CodeBuddy个人版国内运营裂变包","remain":45,…}], …}

GET /plugins/dsh-workbuddy-billing/turn?turn=1&session=s1
→ {"ok":true,"creditsSpent":0.256,"remaining":12356,"measured":true,
   "source":"usage-entry","matchedEntries":1,
   "tokenUsage":{"input":1697,"cacheRead":201728,"output":350,"reasoning":1},
   "model":"deepseek-v4.1-flash","creditMultiplier":0.11, …}
```

`total` 与 `dsh-xdpool/status` 里 `accounts[activeAccountId].credits.total` 逐位一致。

> 余额会随使用实时变化，上面是取样时刻的值，不是固定值。

---

## 五个已修正的真实缺陷（都由真实数据暴露）

这四个都不是写法风格问题，而是**在真实会话上会算错数**的 bug。前两个直接
对应「有时显示本轮 0 积分」。

### 1. 没见过 `turn/start` 的轮次，token 被整轮丢弃

`assistant/message` 事件到达时，如果该轮还没有账本记录（插件在这一轮中途才
挂上、或观察器错过了 `turn/start`），旧代码直接 `return`，把**唯一能拿到的
token 数扔掉了**。实测复现：

```
windowMs: -9   tokenUsage: 全 0   reason: no-token-usage   → 本轮 0 积分
```

修法：结算事件到来时按需建记录（标记 `synthetic`），并让窗口归属在窗口未知时
跳过，只用这一轮自己累计的 token。同一份数据修复后：

```
tokenUsage: {input:1219, cacheRead:397312, output:1206}   credits: 0.504
```

### 2. 合成条目的窗口变成负数，归属判定全部拒绝

`turn/end` 到达但没见过 `turn/start` 时，`ledger.open({synthetic:true})` 把
`startedAtMs` 取成 `Date.now()`；随后 `endedAtMs` 又被事件自带的（更早的）真实
时间覆盖 → 窗口为负 → 所有基于窗口的归属都拒绝。修法：合成条目不再假装知道
窗口，并保证窗口不倒挂。

### 3. `inputTokens` 的语义搞反了，每轮都被高估

旧代码假设「`inputTokens` 包含 `cacheReadTokens`」，于是做减法。**实测 366/366
条结算全部是反的**：

```
inputTokens + cacheReadTokens + outputTokens === totalTokens
```

例如 `input 955 / cacheRead 22144 / output 722 / total 23821`。所以
`inputTokens` 是**未缓存**的那一段，两者互不包含、应当直接相加。照旧假设做减法
会把新输入算成 0、缓存读算错价。

顺带修掉同一处的字段名 bug：xdpool 账本写 `cachedTokens`，会话事件写
`cacheReadTokens`，只读一个会让另一侧缓存恒为 0。

修复后用真实会话日志回放逐位对齐：

```
turn 1  插件 input=306673 cacheRead=58589184 output=127623  ← 与独立统计完全一致
        积分 73.437
turn 2  插件 input=25473  cacheRead=16032000 output=23054   ← 与独立统计完全一致
        积分 18.93
```

（turn 3 是当时进行中的轮次，按设计返回 `pending`、不渲染。）

---

## 第四个缺陷：同一个字段名，两个数据源里含义相反

这是「23.03 积分」那个数字的真正原因，也是最隐蔽的一个。

截图里同一轮同时显示：

```
本轮费用 ≈ ¥0.12378442     ← 上游真实计费
本轮 −23.03 积分           ← 插件显示
```

两个数放在一起就已经说明问题了。查下来是 **`inputTokens` 这个字段名在
两个数据源里语义相反**：

| 数据源 | 字段 | 语义 | 证据 |
|---|---|---|---|
| xdpool 账本 | `cachedTokens` | **包含**在 input 里 | 1040/1040 条 `input ≥ cache`，`cache/input` 中位数 **0.9979** |
| DSH 会话日志 | `cacheReadTokens` | **不包含**，互相独立 | 535/535 条 `input < cache`，且 `input+cache+output === totalTokens` |

比值 0.9979 只在「input 是总量、cache 是其中切片」时才会出现——这和截图里
「缓存命中 99%」完全吻合。

我上一轮只按会话日志的语义写了**一个**常量，结果应用到账本那条路径就会把
整段 prompt 计费两次。量化后：**虚报 10.1–10.7 倍**。

修法：拆成两个按数据源区分的常量。

```js
const LEDGER_CACHE_INCLUDED_IN_INPUT  = true   // 账本：input ⊇ cache
const SESSION_CACHE_INCLUDED_IN_INPUT = false  // 会话事件：互不包含
```

### 用余额校准（唯一可信的锚）

`¥` 是 API 等价成本，积分是另一套货币，不能直接换算。唯一可靠的锚是
**余额实际动了多少**：

| 轮次 | 余额实际减少 | 修复前显示 | 修复后 | 修复前误差 |
|---|---|---|---|---|
| 93 | **5** | 39.943 | 2.62 | 8× |
| 94 | **8** | 23.030 | 2.69 | 2.9× |

修复消除了 10.5 倍那个量级错误。剩下的约 2 倍差距来自 `PRICE_BASIS` 是猜的
（用余额反解出 1.91e-4 与 2.98e-4，两个整数余额样本不足以定标），这一点在代码
注释里明确写了，并留给设置项 `priceBasis` 让用户按自己的实际扣费校准——
**没有把一个猜测伪装成精确值**。

---

## 第五个缺陷：同一账号在多台电脑上使用时，余额差值会算串

`余额差值` 那一层取的是 `baseline.total - snapshot.total`，但**余额是账号级的，
不是机器级的**。一个账号在多台电脑登录时，所有机器共用一个余额数字。
所以这个差值里混进了别处的消费——而旧代码把它当成「本机的实测值」。

实测复现（构造用例，精确到分）：

| 场景 | 本机实际消耗 | 别处同时消耗 | 余额变化 | 旧代码显示 |
|---|---|---|---|---|
| 单机 | 10 | 0 | −10 | 10 ✅ |
| 共享账号 | **10** | **500** | −510 | **510** ❌ 且标成 `measured` |

更糟的是这一层的优先级高于 token 估算，所以**即使本轮有完整的 token 数据也救不回来**。

### 修法：用本轮自己的 token 给差值设上界

当本轮有 token 数据时，先按 token 算出这轮「最多可能花多少」，再拿余额差值和它比：

```js
ceiling = tokenEstimate × SHARED_ACCOUNT_CEILING_FACTOR   // 8
if (delta > ceiling) → reason = 'shared-account-delta'   // 拒绝，退回 token 估算
```

系数取 8 是为了抓**数量级**错误（别处花 500 而本机花 10），而不是去质疑换算率。
重试风暴、轮次中途换模型这类真实波动通常在 8 倍以内，仍保留实测差值。

界面会用专门文案说明：*「余额的变化幅度超出了本轮 token 能解释的范围，说明这个账号同时在别处被使用」*——
而不是让用户看到一个莫名的高数字。

### 剩下的边界（诚实地留着）

如果本轮**完全没有 token 记录**（观察器漏了事件），就没有东西能给差值设上界，
此时仍会信任一个小于 5000 的差值。这是一个已知取舍：

- 拒绝所有差值 → 会毁掉绝大多数单机用户的真实数据
- 信任差值 → 在「观察器漏事件 + 同时有别处在花」这个双重巧合下会偏高

实际上会花钱的轮次一定产生 `assistant/message` 事件（因此一定有 token），
所以这条分支需要两个条件同时成立。`/health` 里的 `sharedAccount.balanceDeltasRejected`
会累计被拒绝的次数——非零就说明这个账号确实在被多处使用。

---

## 小数位：为什么以前会显示 0

旧实现是「≥1 显示 1 位、<1 显示 2 位，并删掉末尾的 0」。于是：

| 真实消耗 | 旧显示 | 现在显示 |
|---|---|---|
| 0.004 | `0` ← 假象 | `0.004` |
| 0.042 | `0.04` | `0.042` |
| 0.5 | `0.5` | `0.5` |
| 7.149 | `7.1` | `7.15` |
| 0.00004 | `0` ← 假象 | `<0.0001` |

新规则按量级定精度（<0.01 四位、<1 三位、<100 两位、≥100 整数），并加了一条
硬约束：**非零消耗永远不能渲染成 `0`** —— 因为「本轮消耗 0 积分」是一句假话，
会被读成「这一轮免费」。极小值改用 `<0.0001`。

`0` 只有一种情况会显示：估算值确实为 0（例如没有 token 的轮次）。此时
`reason` 字段会说明原因（`no-token-usage` / `no-baseline`）。

---

## 已知边界

- **逐轮精确扣费无法获得**。上游只给余额，不给单次扣费。第 2 层（余额差值）
  是最接近真实的，但免费额度/赠送包会让某些轮次差值为 0，此时会退到估算。
- **`PRICE_BASIS` 是校准值**。默认 0.0001 是按「100 积分 / 百万 token（倍率 1.0）」
  的常见量级取的，不是官方单价。校准方式：跑一轮已知消耗，用
  `真实扣费 ÷ (tokens × 倍率)` 反推后写进设置。
- **缓存读比新输入便宜**，插件按权重表区分 `cacheRead / input / output /
  reasoning`，但权重同样是估算而非官方价目。
- 余额采样缓存 5 秒；turn 开始与结束各强制采样一次，避免差值被缓存抹平。

---

## 安装后的一次实测（2026-10-27，真实 host）

插件已装进 `desktop` profile 并由运行中的 host 组合、路由活跃：

```
GET /plugins/dsh-workbuddy-billing/health
→ {"ok":true,"plugin":"dsh-workbuddy-billing","enabled":true,
   "sessionEvents":true,"sessionEventsSeen":90,"ledgerSize":2,
   "creditsProvider":"xdpool-status","creditsOrigin":"http://127.0.0.1:8495",
   "priceBasis":0.0001,"modelCatalogSize":18,
   "providers":["xdpool-status","connect-usage"],
   "tokenWeights":{"input":1,"cacheRead":0.1,"cacheWrite":1,"output":4,"reasoning":0},
   "recentLedgerKeys":["session-…:85","session-…:86"]}

GET /plugins/dsh-workbuddy-billing/credits
→ {"ok":true,"total":12302,"provider":"xdpool-status","source":"live","packages":47}
```

`sessionEventsSeen` 随对话持续增长、`ledgerSize` 随轮次增长，说明 host 侧的
`session/event` 观察器确实挂在真实会话上。`recentLedgerKeys` 是排查「页脚空白」
用的：拿这里的 `session:turn` 直接请求 `/turn` 就能分辨是「观察器没看到这轮」
还是「看到了但算不出」。

> 注意：**正在进行的轮次**请求 `/turn` 会得到 `{ok:false,pending:true}`，
> 这是设计行为——没收盘就没有结算记录，前端此时不渲染，避免页面闪烁。
> 插件也不回溯挂载前的历史轮次：没有观察到 `turn/start` 的轮次不会凭空
> 编出一个数字。

### 一处已修正的真实缺陷

开发期发现 `assistant/message` 并不在 `data.usage` 上带用量——用量在它内嵌的
compact 流里，是**最后一条 `type: "usage"` 的 chunk**（这正是
`@deepseek-ai/dsh-llm` 的 `lastAssistantStreamChunk(stream, 'usage')` 的读法，
也是 `dsh-token-meter` 的取数方式）。最初的实现只读 `data.usage`，在真实会话上
会一直 `reason: no-token-usage`、显示 0。现已按真实结构读取，并用真实形状的事件
验证：`input 1000 / cacheRead 800 / output 200 / reasoning 150`
→ weightedTokens 1880 → 0.02068 积分（与上报的 0.021 一致）。

### 关于 schemastery 的一个刻意选择

`@deepseek-ai/schemastery` 是 peer 依赖，在打包安装里它位于 `app.asar` 内，
用普通 `require.resolve` 从插件目录解析**会失败**（实测 `MODULE_NOT_FOUND`）。
但它在本机**实际可用**——因为 host 通过 `ctx.loader.internal.import(...)` 加载
插件行，其 ESM resolve hooks 能到达打包运行时。所以这里保留**静态 import**：
曾经改成 `createRequire` 兜底，但 CJS 解析不经过那套 ESM hooks，反而会
**弄丢本来正常工作的设置卡片**，因此改回并写下原因。设置 schema 缺失时
`Config` 才是问题所在，`DEFAULT_CONFIG` 是运行期默认值的唯一来源。

---

## License

MIT
