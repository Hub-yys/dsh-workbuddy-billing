/**
 * dsh-workbuddy-billing — browser half: per-turn credit footer.
 *
 * Renders ONE list-seat entry in `conversation.chat.turnTail` (session-scoped,
 * declared by @deepseek-ai/dsh-client-ui-chat as a child of the
 * `conversation.chat.node` / `turn-tail` registration):
 *
 *     ⚡ 本轮 −12.4 积分 · 剩余 3,420        （+ 「估算」 badge when estimated）
 *
 * Data comes from this plugin's own Host route (lib/index.js):
 *     GET /plugins/dsh-workbuddy-billing/turn?turn=<turnId>&session=<sessionId>&sinceMs=<ms>
 *
 * ─── SESSION ID: how a turnTail entry learns it ────────────────────────────
 * The render site (`TurnTailNodeView`) passes ONLY `{ turn, seq, openFile }` to
 * `renderSlot("conversation.chat.turnTail", …)`, so the session id is NOT among
 * the owner props. It is delivered through the entry's `inject` callback
 * instead: ui-renderer's `runInject(entry, binding, actions)` pushes
 * `binding.key` as the FIRST argument, and ui-session's `materialize()` sets
 * `key: binding.sessionId`. Verified end-to-end in the shipped bundles:
 *   - ui-renderer  lib/client.js  `runInject` → `if (binding !== void 0) args.push(binding.key)`
 *   - ui-session   lib/client.js  `materialize` → `{ key: binding.sessionId, … }`
 *   - ui-plan      lib/client.js  `inject: (sessionId) => …` on this very slot
 * Therefore: `inject: (sessionId) => ({ t, sessionId })`.
 *
 * Unlike ui-plan we never THROW for an unknown binding — this footer is
 * decoration, so a missing session degrades to a session-less lookup (turn ids
 * are unique enough for the Host ledger) rather than a crash face.
 *
 * ─── `turn` prop shape ────────────────────────────────────────────────────
 * `turn` is the Turn *record*, not the id: `{ turn: <number>, status, start,
 * end, data, … }`. The id is `turn.turn` (ui-plan reads `String(turn.turn)`;
 * ui-chat reads `location.turn.turn`). `turn.start.time` is epoch ms (the same
 * value ui-chat feeds to `formatMessageClock(time, t, now = Date.now())`).
 * `seq` is the closing final-node seq. We tolerate a bare id too.
 *
 * ─── LOCALE ───────────────────────────────────────────────────────────────
 * All copy goes through `t(...)`. The Host owns locale/*.json with the SAME
 * key set, but a browser client bundle cannot read those files (the module
 * loader resolves JS/JSON *modules* declared in the boot graph, not package
 * locale directories — that is why every real client plugin, including
 * dsh-connect-workbuddy, embeds its dictionaries inline). So the dictionaries
 * are embedded here as the authoritative default and used as a PER-KEY
 * fallback whenever `t()` returns the bare key.
 *
 * Never throws: every fetch, every render row, and `apply` itself is guarded.
 * A bug here must degrade to "no footer", never to a blank chat.
 */

window.__ModuleLoader__.load({
	id: "dsh-workbuddy-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region constants
		/** Locale namespace shared with locale/zh.json + locale/en.json (Host-owned). */
		const NS = "dsh-workbuddy-billing";
		/** Stable client-plugin name. */
		const name = "dsh-workbuddy-billing-client";
		/** Host route that answers the per-turn credit record. */
		const TURN_ROUTE = "/plugins/dsh-workbuddy-billing/turn";
		/** List-seat this plugin contributes to. */
		const SLOT = "conversation.chat.turnTail";
		/** Registration id (list seats key entries by `id`). */
		const ENTRY_ID = "dsh-workbuddy-billing-turn-credits";
		/** Ordered after the Host's own turn-tail meta (default 0) and after ui-deliverables. */
		const ENTRY_ORDER = 10;
		/** Bounded retry budget per (session, turn, seq): 3 attempts, 700 ms apart. */
		const MAX_ATTEMPTS = 3;
		const RETRY_DELAY_MS = 700;
		/** Hard cap on the memoized terminal-outcome cache (long sessions stay bounded). */
		const CACHE_LIMIT = 400;
		/** Marks our single injected stylesheet so a second apply cannot duplicate it. */
		const STYLE_TAG_ID = "dsh-workbuddy-billing/client.css";
		//#endregion

		//#region dictionaries
		/**
		 * Embedded defaults. These are the fallback layer, not a second source of
		 * truth: whatever the Host registers under `NS` wins, key by key.
		 */
		const DICT_ZH = {
			"turn.spentLabel": "本轮",
			"turn.remainingLabel": "剩余",
			"turn.estimatedBadge": "估算",
			"turn.estimatedHint": "该数字由 token 数 × 模型积分倍率估算得出，并非上游余额的实际差值。",
			"turn.tokensHint": "输入 {input} · 缓存读 {cacheRead} · 缓存写 {cacheWrite} · 输出 {output} · 推理 {reasoning}",
			"turn.modelLabel": "模型",
			"turn.unavailable": "积分数据暂不可用",
			"credits.unit": "积分",
			"credits.thousandsSep": ","
		};
		const DICT_EN = {
			"turn.spentLabel": "This turn",
			"turn.remainingLabel": "Remaining",
			"turn.estimatedBadge": "est.",
			"turn.estimatedHint": "Derived from token counts × the model credit multiplier — not an actual upstream balance delta.",
			"turn.tokensHint": "in {input} · cache read {cacheRead} · cache write {cacheWrite} · out {output} · reasoning {reasoning}",
			"turn.modelLabel": "Model",
			"turn.unavailable": "Credit data unavailable",
			"credits.unit": "credits",
			"credits.thousandsSep": ","
		};
		//#endregion

		//#region styles
		const CSS = `
.dsh-workbuddy-billing-turn{display:flex;align-items:center;flex-wrap:wrap;gap:5px;max-width:100%;margin-top:6px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary,currentColor);font-variant-numeric:tabular-nums;user-select:none;transition:none}
.dsh-workbuddy-billing-turn__bolt{opacity:.9;flex:none;line-height:1}
.dsh-workbuddy-billing-turn__spent{color:var(--dsw-alias-label-secondary,currentColor);white-space:nowrap}
.dsh-workbuddy-billing-turn__sep{color:var(--dsw-alias-label-dimmed,currentColor);opacity:.75;flex:none}
.dsh-workbuddy-billing-turn__remaining{color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}
.dsh-workbuddy-billing-turn__badge{flex:none;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-tertiary,inherit);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 3px);line-height:1.5;cursor:help}
@media (prefers-reduced-motion:reduce){.dsh-workbuddy-billing-turn,.dsh-workbuddy-billing-turn *{transition:none!important;animation:none!important}}
`;
		/** Inject the stylesheet once; never throws, never blocks the entry. */
		function injectStyles() {
			try {
				if (typeof document === "undefined" || document.head === undefined || document.head === null) return;
				const selector = "style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]";
				if (document.querySelector(selector) !== null) return;
				const tag = document.createElement("style");
				tag.dataset.plugin = NS;
				tag.dataset.pluginCss = STYLE_TAG_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			} catch (error) {
				// A missing stylesheet only costs polish; the row still renders.
			}
		}
		//#endregion

		//#region locale
		/** Read the active locale id off the LocaleFace, deflating to "zh" | "en". */
		function readActiveLocale(face) {
			try {
				const snapshot = face !== undefined && face !== null && typeof face.getSnapshot === "function" ? face.getSnapshot() : undefined;
				const active = snapshot !== undefined && snapshot !== null && typeof snapshot === "object" ? snapshot.active : undefined;
				if (typeof active === "string" && /^zh/i.test(active)) return "zh";
			} catch (error) {
				// Fall through to English defaults.
			}
			return "en";
		}
		/** `{name}` interpolation matching the Host locale runtime's own template syntax. */
		function interpolate(template, params) {
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match));
		}
		/**
		 * Build a `t` that is resilient to a missing key on EITHER side.
		 *
		 * Order: Host dictionary → embedded dictionary for the active locale →
		 * embedded English → the key itself. The Host `t` returns the bare key when
		 * it has no entry, which is exactly the signal to fall back — so a
		 * half-registered locale file can never blank a label.
		 */
		function makeTranslator(boundT, activeLocale) {
			return function tr(key, params) {
				let value;
				try {
					if (typeof boundT === "function") value = boundT(key, params);
				} catch (error) {
					value = undefined;
				}
				if (typeof value === "string" && value !== "" && value !== key) return value;
				const zh = typeof activeLocale === "function" && activeLocale() === "zh";
				const primary = zh ? DICT_ZH : DICT_EN;
				let template = primary[key];
				if (typeof template !== "string") template = DICT_EN[key];
				if (typeof template !== "string") template = key;
				return interpolate(template, params);
			};
		}
		//#endregion

		//#region numbers
		function isFiniteNumber(value) {
			return typeof value === "number" && Number.isFinite(value);
		}
		function firstFinite() {
			for (let index = 0; index < arguments.length; index += 1) {
				if (isFiniteNumber(arguments[index])) return arguments[index];
			}
			return undefined;
		}
		function groupDigits(text, separator) {
			const joiner = typeof separator === "string" ? separator : ",";
			return text.replace(/\B(?=(\d{3})+(?!\d))/g, joiner);
		}
		/** Locale-number formatting without Intl: integer part grouped, fraction trimmed. */
		function formatNumber(value, separator, maxFraction) {
			if (!isFiniteNumber(value)) return "";
			// Up to 6: a small per-turn spend needs 4 decimals to stay non-zero
			// (see `formatAmount`), and the token counts still pass 0.
			const digits = Math.max(0, Math.min(6, isFiniteNumber(maxFraction) ? Math.trunc(maxFraction) : 0));
			const factor = Math.pow(10, digits);
			const rounded = Math.round(Math.abs(value) * factor) / factor;
			let text = rounded.toFixed(digits);
			if (text.indexOf(".") !== -1) text = text.replace(/0+$/, "").replace(/\.$/, "");
			const dot = text.indexOf(".");
			const integer = dot === -1 ? text : text.slice(0, dot);
			const fraction = dot === -1 ? "" : text.slice(dot + 1);
			return groupDigits(integer, separator) + (fraction === "" ? "" : "." + fraction);
		}
		/**
		 * Format a per-turn credit amount so a real, small spend never renders as "0".
		 *
		 * Precision is chosen from the magnitude, because per-turn cost spans four
		 * orders of magnitude: a cheap cached turn can spend 0.004 credits while a
		 * long agentic one spends 7.1. A fixed two decimals turns the first into
		 * "0", which reads as "this turn was free" — the single most misleading
		 * thing this footer could say.
		 *
		 *   0            → "0"        (genuinely nothing; the estimate really is 0)
		 *   < 0.01       → 4 decimals ("0.0042")
		 *   < 1          → 3 decimals ("0.042")
		 *   < 100        → 2 decimals ("7.15")
		 *   >= 100       → integer    ("1,234")
		 *
		 * Trailing zeros are still trimmed, so 0.5 renders "0.5", not "0.5000".
		 */
		function formatAmount(value, separator) {
			const magnitude = Math.abs(value);
			let digits;
			if (magnitude === 0) digits = 0;
			else if (magnitude < 0.01) digits = 4;
			else if (magnitude < 1) digits = 3;
			else if (magnitude < 100) digits = 2;
			else digits = 0;
			const text = formatNumber(value, separator, digits);
			// Invariant: a non-zero spend must never render as a bare "0".
			// Below 0.00005 even four decimals round away, and "本轮消耗 0 积分"
			// is a false statement — it reads as "this turn was free". Say
			// "<0.0001" instead, which is true and keeps the reader oriented.
			// The caller owns the sign, so this returns an unsigned magnitude.
			if (magnitude > 0 && /^0$/.test(text)) return "<0.0001";
			return text;
		}
		//#endregion

		//#region props
		/** The Turn id: accept the Turn record (`turn.turn`) or a bare id. */
		function readTurnId(turn) {
			if (turn === undefined || turn === null) return "";
			if (typeof turn === "number") return Number.isFinite(turn) ? String(turn) : "";
			if (typeof turn === "string") return turn;
			if (typeof turn !== "object") return "";
			const candidates = [turn.turn, turn.turnId, turn.id];
			for (let index = 0; index < candidates.length; index += 1) {
				const value = candidates[index];
				if (typeof value === "string" && value !== "") return value;
				if (typeof value === "number" && Number.isFinite(value)) return String(value);
			}
			return "";
		}
		/** `turn.start.time` when it is plausibly epoch ms; otherwise omit the hint. */
		function readSinceMs(turn) {
			try {
				if (turn === undefined || turn === null || typeof turn !== "object") return undefined;
				const start = turn.start;
				if (start === undefined || start === null || typeof start !== "object") return undefined;
				const time = start.time;
				if (!isFiniteNumber(time)) return undefined;
				if (time < 1e12) return undefined;
				return Math.floor(time);
			} catch (error) {
				return undefined;
			}
		}
		/**
		 * A still-streaming Turn has no closing record yet, and the Host has not
		 * written one. Skip the request entirely instead of burning the retry
		 * budget and caching a false negative; when the Turn closes its `seq`
		 * changes, which mints a new key and fetches for real.
		 */
		function isTurnOpen(turn) {
			try {
				return turn !== undefined && turn !== null && typeof turn === "object" && turn.status === "open";
			} catch (error) {
				return false;
			}
		}
		//#endregion

		//#region record
		function pickNumber(source, keys) {
			if (source === undefined || source === null || typeof source !== "object") return undefined;
			const values = [];
			for (let index = 0; index < keys.length; index += 1) values.push(source[keys[index]]);
			return firstFinite.apply(null, values);
		}
		/**
		 * Normalize a Host turn record, tolerating the documented shape plus a few
		 * obvious aliases. Unknown numbers stay `undefined` and are simply absent
		 * from the line — never coerced to 0.
		 */
		function toRecord(body) {
			const tokens = body.tokenUsage !== undefined && body.tokenUsage !== null && typeof body.tokenUsage === "object" ? body.tokenUsage : undefined;
			return {
				turnId: typeof body.turnId === "string" ? body.turnId : typeof body.turnId === "number" ? String(body.turnId) : undefined,
				creditsSpent: pickNumber(body, ["creditsSpent", "creditsDelta", "spent", "delta"]),
				remaining: pickNumber(body, ["remaining", "remainingCredits", "creditsRemaining"]),
				measured: body.measured === true ? true : body.measured === false ? false : undefined,
				estimated: body.estimated === true ? true : undefined,
				tokenUsage: {
					input: pickNumber(tokens, ["input", "inputTokens", "promptTokens"]),
					cacheRead: pickNumber(tokens, ["cacheRead", "cacheReadTokens", "cachedTokens"]),
					cacheWrite: pickNumber(tokens, ["cacheWrite", "cacheWriteTokens"]),
					output: pickNumber(tokens, ["output", "outputTokens", "completionTokens"]),
					reasoning: pickNumber(tokens, ["reasoning", "reasoningTokens"])
				},
				model: typeof body.model === "string" && body.model !== "" ? body.model : undefined,
				creditMultiplier: pickNumber(body, ["creditMultiplier", "multiplier"]),
				atMs: pickNumber(body, ["atMs", "at", "time"])
			};
		}
		function hasTokenUsage(usage) {
			if (usage === undefined || usage === null) return false;
			return isFiniteNumber(usage.input) || isFiniteNumber(usage.cacheRead) || isFiniteNumber(usage.cacheWrite) || isFiniteNumber(usage.output) || isFiniteNumber(usage.reasoning);
		}
		//#endregion

		//#region transport
		function buildUrl(turnId, sessionId, sinceMs) {
			let url = TURN_ROUTE + "?turn=" + encodeURIComponent(turnId);
			if (typeof sessionId === "string" && sessionId !== "") url += "&session=" + encodeURIComponent(sessionId);
			if (isFiniteNumber(sinceMs)) url += "&sinceMs=" + encodeURIComponent(String(sinceMs));
			return url;
		}
		function delay(ms) {
			return new Promise((resolve) => {
				try {
					window.setTimeout(resolve, ms);
				} catch (error) {
					resolve();
				}
			});
		}
		/**
		 * One request → one outcome. 404 is terminal ("no such turn"), a network
		 * or 5xx failure is retryable, `{ok:false,pending:true}` is retryable.
		 */
		async function requestOnce(url) {
			if (typeof fetch !== "function") return { kind: "absent" };
			let response;
			try {
				response = await fetch(url, {
					method: "GET",
					headers: { accept: "application/json" },
					credentials: "same-origin",
					cache: "no-store"
				});
			} catch (error) {
				return { kind: "error" };
			}
			if (response === undefined || response === null) return { kind: "error" };
			if (response.status === 404) return { kind: "absent" };
			if (response.ok !== true) return { kind: "error" };
			let body;
			try {
				body = await response.json();
			} catch (error) {
				return { kind: "error" };
			}
			if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return { kind: "error" };
			if (body.ok === false) {
				if (body.pending === true) return { kind: "pending" };
				return { kind: "absent" };
			}
			if (body.ok === true) return { kind: "ready", record: toRecord(body) };
			// No explicit verdict: accept it only if it actually carries figures.
			const record = toRecord(body);
			if (isFiniteNumber(record.creditsSpent) || isFiniteNumber(record.remaining)) return { kind: "ready", record };
			return { kind: "absent" };
		}
		/** Terminal outcomes, keyed by (session, turn, seq). Fresh Map = insertion-ordered LRU-ish. */
		const outcomes = new Map();
		/** In-flight promises, so remounts and sibling renders share one request. */
		const inflight = new Map();
		function remember(key, outcome) {
			try {
				if (outcomes.size >= CACHE_LIMIT && !outcomes.has(key)) {
					const oldest = outcomes.keys().next();
					if (oldest.done !== true) outcomes.delete(oldest.value);
				}
				outcomes.set(key, outcome);
			} catch (error) {
				// Cache is an optimization only.
			}
		}
		function readCached(key) {
			try {
				return outcomes.get(key);
			} catch (error) {
				return undefined;
			}
		}
		/** Bounded retry: at most MAX_ATTEMPTS, then give up SILENTLY and memoize. */
		async function load(key, url) {
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
				let outcome;
				try {
					outcome = await requestOnce(url);
				} catch (error) {
					outcome = { kind: "error" };
				}
				if (outcome.kind === "ready" || outcome.kind === "absent") {
					remember(key, outcome);
					return outcome;
				}
				if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
			}
			const giveUp = { kind: "absent" };
			remember(key, giveUp);
			return giveUp;
		}
		/** One fetch per key, ever (terminal outcomes are memoized). */
		function ensure(key, url) {
			const cached = readCached(key);
			if (cached !== undefined) return Promise.resolve(cached);
			const running = inflight.get(key);
			if (running !== undefined) return running;
			const pending = load(key, url).catch(() => {
				const fallback = { kind: "absent" };
				remember(key, fallback);
				return fallback;
			});
			inflight.set(key, pending);
			const clear = () => {
				if (inflight.get(key) === pending) inflight.delete(key);
			};
			pending.then(clear, clear);
			return pending;
		}
		//#endregion

		//#region view
		/**
		 * Build the hover/tooltip text: per-turn amount, remaining balance, model +
		 * multiplier, token breakdown, measured-vs-estimated, timestamp.
		 * Copy goes through `tr`; the timestamp uses the browser's own locale.
		 */
		function buildTooltip(tr, record, parts) {
			const lines = [];
			if (parts.hasSpent) lines.push(tr("turn.spentLabel") + ": " + parts.spentText);
			if (parts.hasRemaining) lines.push(tr("turn.remainingLabel") + ": " + parts.remainingAmount);
			if (typeof record.model === "string") {
				const multiplier = isFiniteNumber(record.creditMultiplier) ? " × " + String(record.creditMultiplier) : "";
				lines.push(tr("turn.modelLabel") + ": " + record.model + multiplier);
			}			if (hasTokenUsage(record.tokenUsage)) {
				const separator = parts.separator;
				const dash = "–";
				lines.push(
					tr("turn.tokensHint", {
						input: isFiniteNumber(record.tokenUsage.input) ? formatNumber(record.tokenUsage.input, separator, 0) : dash,
						cacheRead: isFiniteNumber(record.tokenUsage.cacheRead) ? formatNumber(record.tokenUsage.cacheRead, separator, 0) : dash,
						cacheWrite: isFiniteNumber(record.tokenUsage.cacheWrite) ? formatNumber(record.tokenUsage.cacheWrite, separator, 0) : dash,
						output: isFiniteNumber(record.tokenUsage.output) ? formatNumber(record.tokenUsage.output, separator, 0) : dash,
						reasoning: isFiniteNumber(record.tokenUsage.reasoning) ? formatNumber(record.tokenUsage.reasoning, separator, 0) : dash
					})
				);
			}
			if (record.measured === false || record.estimated === true) lines.push(tr("turn.estimatedHint"));
			else if (record.measured !== true) lines.push(tr("turn.unavailable"));
			if (isFiniteNumber(record.atMs)) {
				try {
					const at = new Date(record.atMs);
					if (!Number.isNaN(at.getTime())) lines.push(at.toLocaleString());
				} catch (error) {
					// A bad timestamp drops one tooltip line, nothing more.
				}
			}
			return lines.join("\n");
		}
		function renderRow(tr, record) {
			const separator = tr("credits.thousandsSep");
			const unit = tr("credits.unit");
			const hasSpent = isFiniteNumber(record.creditsSpent);
			const hasRemaining = isFiniteNumber(record.remaining);
			// Neither half available → draw nothing at all (no spinner, no placeholder).
			if (!hasSpent && !hasRemaining) return null;

			let spentAmount = "";
			let spentText = "";
			if (hasSpent) {
				const value = record.creditsSpent;
				const sign = value > 0 ? "\u2212" : value < 0 ? "+" : "";
				spentAmount = sign + formatAmount(value, separator);
				spentText = tr("turn.spentLabel") + " " + spentAmount + " " + unit;
			}
			const remainingAmount = hasRemaining ? formatNumber(record.remaining, separator, 1) : "";
			const remainingText = hasRemaining ? tr("turn.remainingLabel") + " " + remainingAmount : "";
			const estimated = record.measured === false || record.estimated === true;
			const tooltip = buildTooltip(tr, record, {
				hasSpent: hasSpent,
				hasRemaining: hasRemaining,
				// The tooltip supplies its own label, so pass the bare amount + unit.
				spentText: hasSpent ? spentAmount + " " + unit : "",
				remainingAmount: remainingAmount === "" ? "" : remainingAmount + " " + unit,
				separator: separator
			});

			const children = [];
			children.push(
				(0, react_jsx_runtime.jsx)("span", {
					className: "dsh-workbuddy-billing-turn__bolt",
					"aria-hidden": "true",
					children: "\u26a1"
				}, "bolt")
			);
			if (hasSpent) {
				children.push(
					(0, react_jsx_runtime.jsx)("span", {
						className: "dsh-workbuddy-billing-turn__spent",
						children: spentText
					}, "spent")
				);
			}
			if (hasSpent && hasRemaining) {
				children.push(
					(0, react_jsx_runtime.jsx)("span", {
						className: "dsh-workbuddy-billing-turn__sep",
						"aria-hidden": "true",
						children: "\u00b7"
					}, "sep")
				);
			}
			if (hasRemaining) {
				children.push(
					(0, react_jsx_runtime.jsx)("span", {
						className: "dsh-workbuddy-billing-turn__remaining",
						children: remainingText
					}, "remaining")
				);
			}
			if (estimated) {
				children.push(
					(0, react_jsx_runtime.jsx)("span", {
						className: "dsh-workbuddy-billing-turn__badge",
						title: tr("turn.estimatedHint"),
						children: tr("turn.estimatedBadge")
					}, "badge")
				);
			}
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-workbuddy-billing-turn",
				title: tooltip,
				"data-dsh-workbuddy-billing": "turn-credits",
				"data-measured": estimated ? "false" : "true",
				children: children
			});
		}
		/**
		 * One entry body. Hooks run unconditionally; only the pure render path is
		 * wrapped, so a malformed record can never take the chat down.
		 */
		function TurnCreditFooterImpl(props) {
			const turn = props !== undefined && props !== null ? props.turn : undefined;
			const sessionId = props !== undefined && props !== null && typeof props.sessionId === "string" ? props.sessionId : "";
			const seq = props !== undefined && props !== null && isFiniteNumber(props.seq) ? props.seq : -1;
			const turnId = readTurnId(turn);
			// An open (streaming) Turn is deliberately parked: no request, no retry budget.
			const key = turnId === "" || isTurnOpen(turn) ? "" : sessionId + "|" + turnId + "|" + String(seq);

			const [state, setState] = react.useState(() => ({
				key: key,
				outcome: key === "" ? undefined : readCached(key)
			}));

			react.useEffect(() => {
				if (key === "") return undefined;
				const cached = readCached(key);
				if (cached !== undefined) {
					setState({ key: key, outcome: cached });
					return undefined;
				}
				let live = true;
				const url = buildUrl(turnId, sessionId, readSinceMs(turn));
				ensure(key, url).then((outcome) => {
					if (!live) return;
					setState({ key: key, outcome: outcome });
				}, () => {
					// ensure() already resolves to a terminal outcome on failure.
				});
				return () => {
					live = false;
				};
			}, [key]);

			try {
				if (key === "") return null;
				// Ignore a cached outcome that belongs to a previous key.
				const outcome = state.key === key ? state.outcome : readCached(key);
				if (outcome === undefined || outcome === null || outcome.kind !== "ready") return null;
				const tr = makeTranslator(props !== undefined && props !== null ? props.t : undefined, props !== undefined && props !== null ? props.activeLocale : undefined);
				return renderRow(tr, outcome.record);
			} catch (error) {
				// Fail closed: no footer beats a broken transcript.
				return null;
			}
		}
		/** Memoized: parent re-renders must not re-run the render row or refetch. */
		const TurnCreditFooter = (0, react.memo)(TurnCreditFooterImpl);
		//#endregion

		//#region apply
		/** Client services this plugin needs: slot registry + dictionary registry. */
		const inject = ["slots", "locale"];

		/**
		 * Browser plugin body.
		 *
		 * Deliberately softer than ui-plan/ui-deliverables: this contribution is
		 * decoration, so a dictionary conflict or a slot-api drift logs and returns
		 * instead of failing the whole client plugin graph.
		 */
		function apply(ctx) {
			try {
				injectStyles();
			} catch (error) {
				// Style injection is best-effort; the row falls back to inline-safe defaults.
			}

			try {
				ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), "dsh-workbuddy-billing: dictionaries");
			} catch (error) {
				console.error("[dsh-workbuddy-billing] locale registration failed (footer still renders with embedded defaults):", error);
			}

			let boundT;
			try {
				boundT = ctx.locale.bind(NS);
			} catch (error) {
				boundT = undefined;
			}

			try {
				const localeFace = ctx.locale;
				ctx.slots.inject(SLOT, () => ctx.slots.register({
					name: SLOT,
					id: ENTRY_ID,
					order: ENTRY_ORDER,
					locale: NS,
					// `sessionId` is the first inject argument for session-scoped seats.
					inject: (sessionId) => ({
						t: boundT,
						sessionId: typeof sessionId === "string" ? sessionId : "",
						activeLocale: () => readActiveLocale(localeFace)
					})
				}, TurnCreditFooter));
			} catch (error) {
				console.error("[dsh-workbuddy-billing] turn-tail slot failed to register (host side unaffected):", error);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
