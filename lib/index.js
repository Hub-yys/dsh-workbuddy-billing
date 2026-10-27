/**
 * dsh-workbuddy-billing — Host half (Node / Cordis).
 *
 * Shows, under every assistant reply, **how many WorkBuddy credits this turn
 * spent** and **how many are left**. Two independent sources feed that number:
 *
 *   1. MEASURED — the delta of the real upstream balance across one turn,
 *      read through the already-installed `dsh-connect-workbuddy` plugin's own
 *      HTTP route (`/plugins/dsh-connect-workbuddy/usage`). This plugin never
 *      re-implements WorkBuddy auth, token refresh or the upstream call: it
 *      proxies a route that already exists. When that plugin is absent the
 *      route is unavailable and the answer degrades to (2).
 *
 *   2. ESTIMATED — `billableTokens x creditMultiplier x PRICE_BASIS`, driven by
 *      a model catalog table (`MODEL_CREDIT_MULTIPLIERS`). Every value produced
 *      this way is reported with `measured: false` so the UI can badge it.
 *
 * TURN BOUNDARIES come from the host's own session event log. `ctx.on('session/event', …)`
 * is the same seam `@deepseek-ai/dsh-session-persistence-jsonl` uses, and the
 * agent loop appends `turn/start` before its first step and `turn/end` in a
 * `finally` (see `@deepseek-ai/dsh-agent-loop`). That means the host can
 * bracket a turn by itself — the browser half does NOT have to report turns.
 * The `POST /turn/begin` and `POST /turn/end` routes are kept as a harmless
 * fallback for the case where `ctx.on` is unavailable in the mounting host;
 * they are never required.
 *
 * HARD CONSTRAINT: a listener on `session/event` runs inside the agent's own
 * append path. Anything thrown from it is contained per listener by the
 * session store, but a slow listener still stalls the turn, so every observer
 * body is synchronous, total, and wrapped in try/catch, and all I/O is
 * detached (fire-and-forget) — never awaited inside the handler.
 *
 * @module dsh-workbuddy-billing
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `@deepseek-ai/schemastery` is a peer dependency, and this STATIC import is
 * deliberate — verified against the real host, not assumed.
 *
 * It looks like it should fail: the copy on a packaged Desktop install lives
 * inside `app.asar`, which plain `require.resolve` from this plugin's directory
 * cannot reach (measured: `MODULE_NOT_FOUND`). It does NOT fail, because the
 * host loads plugin rows through `ctx.loader.internal.import(...)`, whose ESM
 * resolve hooks reach the packaged runtime. This plugin's row is composed and
 * its settings card renders on the live host today.
 *
 * A `createRequire(...)` guard was tried first and reverted on purpose:
 * `createRequire` uses CJS resolution, which does NOT pass through those ESM
 * hooks, so it would have silently dropped a working settings card. A static
 * import that is proven to resolve beats a defensive fallback that is proven
 * not to.
 *
 * Should a future host stop bridging the peer, the failure is loud and isolated
 * (`Config` is what the settings service reads) rather than a silent no-op, and
 * `DEFAULT_CONFIG` below is the single place the runtime defaults live.
 */
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'dsh-workbuddy-billing'

/**
 * Required services.
 *
 * Deliberately EMPTY, not `['webServer']`. An `inject` list is a hard gate: any
 * entry the running host does not provide keeps `apply` from ever executing, so
 * a missing `webServer` would also disable the turn observer (the half that
 * does not need a web server at all). Everything that needs a service is
 * mounted through `ctx.inject([...])` below, which defers until that service
 * appears and is equally safe on a host that never provides it.
 */
export const inject = []

//#region constants

/** Route namespace. Every route this plugin owns lives under this prefix. */
const ROUTE_PREFIX = '/plugins/dsh-workbuddy-billing'

/** Live balance readout. */
const CREDITS_ROUTE = `${ROUTE_PREFIX}/credits`

/** One turn's credit record, read by the turn-tail entry in the browser. */
const TURN_ROUTE = `${ROUTE_PREFIX}/turn`

/** Optional fallback: record the pre-turn balance. */
const TURN_BEGIN_ROUTE = `${ROUTE_PREFIX}/turn/begin`

/** Optional fallback: close a turn and compute its delta. */
const TURN_END_ROUTE = `${ROUTE_PREFIX}/turn/end`

/** Cheap self-description, for diagnosing "nothing renders". */
const HEALTH_ROUTE = `${ROUTE_PREFIX}/health`

/**
 * Provider #1: `dsh-xdpool`'s account status route.
 *
 * VERIFIED LIVE on this host (HTTP 200, ~12.6 kB). This is where the real
 * WorkBuddy balance lives: `accounts[].credits.total`.
 *
 * `dsh-connect-workbuddy` — the plugin the original design proxied — is NOT
 * installed in this profile (absent from `dsh.profile.bundles`, no
 * `node_modules` entry, its route answers 404), so it cannot be the primary
 * source. Building on it would have shown nothing, forever.
 */
const XDPOOL_STATUS_PATH = '/plugins/dsh-xdpool/status'

/**
 * Provider #1, per-turn half: `dsh-xdpool`'s usage ledger.
 *
 * VERIFIED LIVE (HTTP 200, ~71 kB). One `entries[]` item per upstream call,
 * each with **exact token counts** and a wall-clock `at` stamp. That is what
 * makes per-turn attribution possible without trusting a global balance delta.
 *
 * Measured shape of one entry:
 * `{region, model, account, turnId, at, ok, ttftMs, decodeMs,
 *   usage: {inputTokens, outputTokens, reasoningTokens, cachedTokens}}`
 *
 * Two token semantics were confirmed against the live payload and are load-
 * bearing (see `tokensFromUsageEntry`):
 *   - `inputTokens` INCLUDES `cachedTokens` (every entry has cached <= input);
 *   - `outputTokens` INCLUDES `reasoningTokens`.
 * There is NO credit/price field anywhere in the document — the conversion to
 * credits stays a modelled estimate, never a fabricated measurement.
 */
const XDPOOL_USAGE_PATH = '/plugins/dsh-xdpool/usage'

/**
 * Provider #2 (legacy / optional): `dsh-connect-workbuddy`'s usage route.
 *
 * Kept as a genuine second provider rather than deleted: a profile that DOES
 * have that package gets a free cross-check, and the `credits` projection is
 * already written. It is tried only after xdpool fails, so its 404 on this host
 * costs at most one request per refresh.
 */
const CONNECT_USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

/** Upstream query parameter naming the region whose card is being read. */
const UPSTREAM_REGION_PARAM = 'region'

/**
 * How far back a usage-ledger entry may be and still be considered, in ms.
 *
 * Used as a sanity bound on the TURN window, not on wall-clock age: a turn whose
 * recorded window is wider than this is not a single turn (a resume, a clock
 * jump, a stale ledger entry), and attributing entries across it would be
 * guesswork. Fifteen minutes is well beyond any real turn.
 */
const USAGE_LOOKBACK_MS = 15 * 60 * 1000

/**
 * Hard cap on how many ledger entries are parsed and scanned for one turn.
 *
 * The live ledger grows without bound (276 entries and counting). Attribution
 * only ever needs the entries near the turn, so the newest slice is enough, and
 * this keeps the per-turn work bounded however large the ledger gets.
 */
const USAGE_ENTRY_SCAN_LIMIT = 400

/**
 * Slack allowed on each side of a turn's [start, end] window, in ms.
 *
 * xdpool stamps an entry when the call finishes; our `turn/end` fires just
 * after. A little slack keeps a genuine entry inside the window without letting
 * a neighbouring turn's entry in.
 */
const TURN_WINDOW_SLACK_MS = 60 * 1000

/**
 * PRICE_BASIS — the single conversion constant between tokens and credits.
 *
 * UNIT: **credits charged per single billable input-token-equivalent at
 * `creditMultiplier = 1.0`.** Equivalently 100 credits per 1,000,000 base
 * tokens at multiplier 1.0.
 *
 * CALIBRATION (and its honesty): WorkBuddy publishes a `creditMultiplier` per
 * model, but that multiplier is a RELATIVE rate — the bundle contains no
 * absolute token→credit price, and the live xdpool documents carry no credit
 * field at all (checked: no `"credit` substring anywhere in the 71 kB usage
 * payload). The one absolute data point in the shipped code is the probe
 * measurement documented in `dsh-connect-workbuddy`: a 25,000-token probe
 * settles at `credit: 0.72`. Solving `25000 x m x BASIS = 0.72` puts BASIS near
 * 1e-4 for a multiplier inside the published range. That is ONE point, not a
 * fit.
 *
 * Therefore: credits are ALWAYS a conversion, never a reading. Whether a value
 * is called "measured" depends only on whether the TOKEN COUNT came from the
 * upstream ledger for exactly this turn — never on the conversion, which stays
 * modelled. See `TURN_MEASURED_SOURCES`. `Config.priceBasis` exists so a user
 * can recalibrate against their own invoice without patching this file.
 *
 * ── MEASURED CORRECTION (2026-10-27) ─────────────────────────────────────
 * The balance moved 5 credits across one turn and 8 across the next; the model
 * at 1e-4 predicted 2.62 and 2.69 for them. So 1e-4 is LOW by ~2x, and solving
 * `balance = weighted x mult x basis` per turn implies 1.91e-4 and 2.98e-4
 * (spread 1.56x — the deltas are whole credits, so this is coarse).
 *
 * It is NOT changed to the mid-point 2.4e-4 here, deliberately:
 *   - two samples of an integer-valued quantity is not a calibration;
 *   - the weight model itself (cacheRead 0.1, output 4) is still an assumption,
 *     so folding its error into one constant would hide it.
 * What changed instead is the error that actually caused the wild numbers: the
 * ledger's cache was being double-counted, worth ~10.5x. Fixing that moved the
 * figure from "obviously wrong" (23 credits on a ¥0.12 turn) to "same order as
 * reality". The remaining ~2x is documented here and left to `Config.priceBasis`,
 * which the settings card exposes for exactly this.
 */
const PRICE_BASIS = 1e-4

/**
 * Relative billing weight of each token bucket, in units of PRICE_BASIS.
 *
 * WEIGHTS, NOT PRICES: each number is unit-less and relative to a base
 * credit-per-token; multiplying by PRICE_BASIS and the model's creditMultiplier
 * yields credits. The table exists so the relationship lives in ONE reviewable
 * place instead of being spread through arithmetic.
 *
 * Why these values:
 * - `input` = 1 — the base unit, by definition of PRICE_BASIS.
 * - `cacheRead` = 0.1 — a cache hit is the classic ~10x discount. DSH's own
 *   chat UI treats `cacheReadTokens` as a separate, much cheaper bucket.
 * - `cacheWrite` = 1 — a cache write is billed like fresh input (it is prompt
 *   processing), not at the discounted read rate.
 * - `output` = 4 — output tokens are the expensive direction; 4x input matches
 *   the ratios published by every mainstream provider.
 * - `reasoning` = 0 — NEVER added on top of `output`, because both the DSH
 *   session format and the xdpool usage entries report reasoning as a SUBSET of
 *   output. Charging it again would double-bill thinking. It is still reported
 *   in the breakdown so the UI can show it.
 */
const TOKEN_WEIGHTS = Object.freeze({
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1,
  output: 4,
  reasoning: 0,
})

/**
 * Whether `reasoningTokens` is already part of `outputTokens` in DSH's own
 * turn-usage shape.
 *
 * TRUE, and it is load-bearing: DSH's turn-usage normaliser in
 * `@deepseek-ai/dsh-client-ui-chat` rejects a sample where
 * `reasoningTokens > outputTokens`, i.e. reasoning is a subset of output. The
 * same holds for xdpool entries. Named rather than inlined so the assumption is
 * visible if a provider ever changes it.
 */
const REASONING_TOKENS_INCLUDED_IN_OUTPUT = true

/**
 * Whether the cache bucket is ALREADY INCLUDED in `inputTokens`.
 *
 * THIS DIFFERS BY SOURCE. That is the whole point of this comment: the same
 * field name means opposite things in the two places this plugin reads, and
 * applying one constant to both overstates a turn by ~10x on one of them.
 *
 * ── Source A: the xdpool usage ledger (`cachedTokens`) ────────────────────
 * INCLUDED = TRUE. Measured over 1040 live entries:
 *   - `inputTokens >= cachedTokens` in 1040/1040;
 *   - `cache / input` median = 0.9979 (the cache is ~99.8% of the prompt).
 * A ratio near 1.0 only makes sense if input is the TOTAL prompt and the cache
 * is a slice of it. So the uncached part is `input - cache`.
 *
 * ── Source B: DSH session events (`cacheReadTokens`) ──────────────────────
 * INCLUDED = FALSE. Measured over 535 settlements:
 *   - `inputTokens < cacheReadTokens` in 535/535;
 *   - `input + cacheRead + output === totalTokens` in 535/535.
 * So these buckets are DISJOINT and must simply be summed.
 *
 * The two constants below are therefore per-source, and `tokensFromUsageEntry`
 * vs `normalizeTokenUsage` each use their own. Collapsing them into one flag is
 * exactly the bug this replaces: with the disjoint rule applied to the ledger,
 * a turn that really cost 2.69 credits displayed 27.19 — a 10.1x overstatement.
 */
const LEDGER_CACHE_INCLUDED_IN_INPUT = true
const SESSION_CACHE_INCLUDED_IN_INPUT = false

/**
 * Kept for callers that only need the session-event answer, which is the
 * narrower and better-established of the two.
 * @deprecated prefer the explicit per-source constants above.
 */
const CACHED_TOKENS_INCLUDED_IN_INPUT = SESSION_CACHE_INCLUDED_IN_INPUT

/**
 * Every per-turn `source` value, and what `measured: true` means for each.
 *
 * DATA rather than scattered conditionals, and deliberately explicit about the
 * asymmetry that makes this honest:
 *
 * - `balance-delta` — the upstream BALANCE ITSELF moved by this amount. The
 *   credit figure is a reading, so `measured: true` needs no token count.
 * - `usage-entry`  — the upstream ledger reported EXACT token counts for this
 *   turn. The tokens are a fact; the credit value is still the conversion, so
 *   `measured: true` additionally requires tokens > 0.
 * - `estimate`    — our own accumulation from session events. Never measured.
 *
 * `TURN_SOURCES` is the closed vocabulary; anything else is a bug, not a
 * fourth state.
 */
const TURN_SOURCES = Object.freeze({
  USAGE_ENTRY: 'usage-entry',
  BALANCE_DELTA: 'balance-delta',
  ESTIMATE: 'estimate',
})

/**
 * Every model the estimate path knows a `creditMultiplier` for.
 *
 * DATA, deliberately: this is a table, not branches scattered through the code,
 * so refreshing it is a one-line edit and `Config.modelCatalog` can extend or
 * override it from settings without touching the source. Values mirror
 * WorkBuddy's published per-model multiplier (`0` means the model is free).
 */
const MODEL_CREDIT_MULTIPLIERS = Object.freeze({
  'deepseek-v4.1-flash': 0.11,
  'deepseek-v4-pro': 0.51,
  'hy4-preview': 0.29,
  'hy3': 0,
  'hy3-x': 0.05,
  'step-5-preview': 0.33,
  'space-bunny': 0.08,
  'glm-5.3': 0.69,
  'glm-5.3-flash': 0.08,
  'glm-5.2': 0.79,
  'glm-5.1': 0.79,
  'glm-5v-turbo': 0.71,
  'minimax-m3.1-flash': 0.08,
  'minimax-m3': 0.25,
  'kimi-k3.1-pro': 0.97,
  'kimi-k3-1': 1.62,
  'kimi-k2.8-preview': 0.77,
  'mimo-v2.6-pro': 0.13,
})

/** Multiplier assumed for a model id absent from the catalog. */
const DEFAULT_CREDIT_MULTIPLIER = 0.5

/** Ceiling on the turn ledger. Bounded so a long-lived host cannot grow it. */
const LEDGER_CAPACITY = 500

/** Upstream balance request budget. Kept short: this sits behind a render path. */
const UPSTREAM_TIMEOUT_MS = 8000

/** How long `turn/end` waits for that turn's baseline sample before giving up. */
const BASELINE_AWAIT_MS = 4000

/**
 * Largest credit delta still believed to be one turn's spend.
 *
 * A measured delta is `baseline - current` on a shared balance. A concurrent
 * spender, a mid-turn top-up, or a refund all produce numbers that are not this
 * turn's cost. A negative delta is unambiguously wrong ("spent -12") and a delta
 * above this ceiling is almost certainly someone else's spend; both fall back to
 * the estimate rather than printing a confident lie.
 */
const MAX_PLAUSIBLE_TURN_CREDITS = 5000

/** Body cap for the two POST fallback routes. They carry ids and token counts. */
const MAX_BODY_BYTES = 64 * 1024

/** Cache TTL bounds for the balance readout, in seconds. */
const MIN_REFRESH_SECONDS = 1
const MAX_REFRESH_SECONDS = 300

//#endregion

//#region locale loading

/**
 * User-facing copy, read from the package's own `locale/*.json`.
 *
 * The files are the single source of the wording (see README: the browser half
 * registers the very same keys through `ctx.locale.register`). The host needs a
 * couple of them at MODULE EVALUATION time — schemastery `.description()` is
 * baked into `Config` before any context exists — so they are read
 * synchronously, once, from `../locale/`. A missing or malformed file must never
 * take the plugin down: `copy()` falls back to the key name, which keeps the
 * settings card ugly but functional.
 */
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')

/** @type {Record<string, Record<string, string>>} */
const MESSAGES = loadMessages()

function loadMessages() {
  const out = {}
  for (const id of ['zh', 'en']) {
    try {
      const raw = readFileSync(join(LOCALE_DIR, `${id}.json`), 'utf8')
      // A JSON file saved by a Windows editor commonly carries a UTF-8 BOM,
      // and JSON.parse REJECTS it. Stripping it here means a locale file that
      // looks correct still loads correctly.
      const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out[id] = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
        )
      } else out[id] = {}
    } catch {
      // A missing locale file is not fatal: the key name is the fallback copy.
      out[id] = {}
    }
  }
  return out
}

/**
 * Locale used for copy that has to exist before a context does.
 *
 * `Config` is a module-level export, so the *host's* saved preference (which
 * only exists on a live context) is not readable here. The process environment
 * is the only honest signal at this point; it is used ONLY for schema
 * descriptions, and defaults to Chinese because this package's `displayName`
 * and `dshhub.summary` are Chinese.
 */
const LOAD_LOCALE = preferredLocaleAtLoad()

function preferredLocaleAtLoad() {
  try {
    const raw = `${process.env.DSH_LOCALE ?? ''} ${process.env.LC_ALL ?? ''} ${process.env.LC_MESSAGES ?? ''} ${process.env.LANG ?? ''}`
    const match = /(?:^|[\s=:])([a-z]{2,3})(?:[_-][a-z0-9]+)?/iu.exec(raw.trim())
    const language = match === null ? '' : match[1].toLowerCase()
    return language === 'zh' ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

/**
 * Read one locale key, falling back to the other locale and then to the key.
 * Never throws; never returns a non-string.
 */
function copy(key) {
  const primary = MESSAGES[LOAD_LOCALE]?.[key]
  if (typeof primary === 'string' && primary !== '') return primary
  const secondary = MESSAGES[LOAD_LOCALE === 'zh' ? 'en' : 'zh']?.[key]
  if (typeof secondary === 'string' && secondary !== '') return secondary
  return key
}

/** `description()` text for a settings field, sourced from `locale/*.json`. */
function describeSetting(field) {
  return copy(`settings.${field}.description`)
}

//#endregion

//#region config schema

/**
 * Settings, rendered by the DSH settings service as this plugin's configuration
 * card. Defaults here are mirrored by `DEFAULT_CONFIG` so a host that hands
 * `apply` an empty object behaves identically to one that runs the schema.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description(describeSetting('enabled')),
  region: z.union([
    z.const('cn'),
    z.const('global'),
  ]).default('cn').description(describeSetting('region')),
  refreshSeconds: z.number()
    .step(1)
    .min(MIN_REFRESH_SECONDS)
    .max(MAX_REFRESH_SECONDS)
    .default(5)
    .description(describeSetting('refreshSeconds')),
  showWhenEstimated: z.boolean().default(true).description(describeSetting('showWhenEstimated')),
  priceBasis: z.number().min(0).default(PRICE_BASIS).description(describeSetting('priceBasis')),
  modelCatalog: z.dict(z.number().min(0)).default({}).description(describeSetting('modelCatalog')),
  defaultCreditMultiplier: z.number().min(0).default(DEFAULT_CREDIT_MULTIPLIER)
    .description(describeSetting('defaultCreditMultiplier')),
  hostOrigin: z.string().default('').description(describeSetting('hostOrigin')),
  sessionEvents: z.boolean().default(true).description(describeSetting('sessionEvents')),
})

/** Schema defaults, kept in one place for hosts that never run the schema. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  region: 'cn',
  refreshSeconds: 5,
  showWhenEstimated: true,
  priceBasis: PRICE_BASIS,
  modelCatalog: {},
  defaultCreditMultiplier: DEFAULT_CREDIT_MULTIPLIER,
  hostOrigin: '',
  sessionEvents: true,
})

//#endregion

//#region small utilities

/** Coerce to a non-negative finite number, else 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Round a credit figure to a display-friendly precision. */
function roundCredits(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1000) / 1000
}

/** Clamp a refresh interval expressed in seconds. */
function refreshMsOf(config) {
  const seconds = Number(config.refreshSeconds)
  const bounded = Number.isFinite(seconds)
    ? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, seconds))
    : DEFAULT_CONFIG.refreshSeconds
  return bounded * 1000
}

//#endregion

//#region loopback guard

/**
 * Loopback / same-listener guard, mirroring `dsh-connect-workbuddy`'s gate.
 *
 * Two checks, and neither is authentication. Together they stop a foreign web
 * page from driving these routes (a browser picks `Origin` for us and
 * DNS-rebinding trips the `Host` comparison) — the CSRF/rebinding family. They
 * do NOT stop a local process that can already open a socket to the port.
 *
 * `Host` must be present and must name this machine or the very address this
 * connection landed on. `Origin`, when present, must clear the same rule; an
 * absent `Origin` passes because that is the shape of a same-origin GET and of
 * any non-browser client.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

/** Strip the port off a `Host`-header-shaped value. */
function hostnameOfHost(host) {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return trimmed
    const after = trimmed.slice(end + 1)
    if (after !== '' && !/^:\d+$/u.test(after)) return trimmed
    return trimmed.slice(0, end + 1)
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/u.test(trimmed.slice(colon + 1))) return trimmed.slice(0, colon)
  return trimmed
}

/** Whether a bare hostname names this machine. */
function isLocalHostname(hostname) {
  const name = hostname.endsWith('.') && !hostname.endsWith('..') ? hostname.slice(0, -1) : hostname
  if (LOOPBACK_HOSTNAMES.has(name)) return true
  return /^127(?:\.\d{1,3}){3}$/u.test(name)
}

/** Bare form of an IP literal, so `[::1]` and `::1` compare equal. */
function bareAddress(value) {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

/** Whether the `Host` header names the address this connection arrived on. */
function hostMatchesListener(host, localAddress) {
  if (typeof host !== 'string' || host.trim() === '') return false
  const hostname = hostnameOfHost(host)
  if (isLocalHostname(hostname)) return true
  if (hostname === '0.0.0.0' || hostname === '[::]' || hostname === '::') return false
  if (typeof localAddress !== 'string' || localAddress.trim() === '') return false
  const local = localAddress.trim().toLowerCase()
  return /^[0-9a-f:.]+$/u.test(local) && bareAddress(hostname) === bareAddress(local)
}

/** Whether a browser-sent `Origin` may drive these routes. */
function originIsLoopback(origin, localAddress) {
  if (typeof origin !== 'string' || origin.trim() === '') return true
  try {
    const url = new URL(origin)
    if (isLocalHostname(url.hostname)) return true
    return hostMatchesListener(url.hostname, localAddress)
  } catch {
    return false
  }
}

/** The full gate every one of this plugin's routes clears first. */
function requireLoopback(req, res) {
  try {
    const localAddress = req?.socket?.localAddress
    if (!hostMatchesListener(req?.headers?.host, localAddress)) {
      json(res, 403, { ok: false, error: 'host-not-trusted' })
      return false
    }
    if (!originIsLoopback(req?.headers?.origin, localAddress)) {
      json(res, 403, { ok: false, error: 'origin-not-trusted' })
      return false
    }
    return true
  } catch {
    try {
      json(res, 403, { ok: false, error: 'host-not-trusted' })
    } catch { /* the socket is already gone; nothing to answer */ }
    return false
  }
}

/** Write one JSON answer. Never throws; a dead socket is silently tolerated. */
function json(res, status, body) {
  try {
    if (res.writableEnded === true) return
    const payload = JSON.stringify(body ?? {})
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      // Balance and per-turn data are live; a cached copy can outlive its truth.
      'Cache-Control': 'no-store',
    })
    res.end(payload)
  } catch {
    try {
      res.end()
    } catch { /* nothing further to do */ }
  }
}

//#endregion

//#region request helpers

/** Read and parse a bounded JSON body. Resolves `null` on anything unusable. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let settled = false
    let size = 0
    const chunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      req.on('data', (chunk) => {
        try {
          size += chunk.length
          if (size > limit) {
            finish(null)
            return
          }
          chunks.push(chunk)
        } catch {
          finish(null)
        }
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          if (text === '') return finish({})
          const parsed = JSON.parse(text)
          finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
        } catch {
          finish(null)
        }
      })
      req.on('error', () => finish(null))
      req.on('aborted', () => finish(null))
      req.on('close', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

/** Parse `req.url` into path + query, tolerating a malformed or relative URL. */
function parseUrl(req) {
  const raw = typeof req?.url === 'string' && req.url !== '' ? req.url : '/'
  try {
    return new URL(raw, 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

/** First non-empty string among the candidate query keys. */
function queryString(params, keys) {
  for (const key of keys) {
    const value = params.get(key)
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** First finite non-negative number among the candidate query keys. */
function queryNumber(params, keys) {
  for (const key of keys) {
    const raw = params.get(key)
    if (raw === null) continue
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

//#endregion

//#region origin discovery

/**
 * Remembered origin of the host that serves the GUI.
 *
 * The turn observer runs OUTSIDE any request, so it cannot derive a port from
 * `req.socket.localPort` the way a route handler can. Every route handler that
 * does see a request records the origin it was reached on here, which makes the
 * first browser request the anchor for all later background sampling. Before
 * that first request there is simply no origin and sampling is skipped — the
 * observer then falls back to the estimate, which is the same answer an absent
 * upstream would give.
 */
let rememberedOrigin = ''

/** Normalise `http://host:port/` to `http://host:port`; undefined if unusable. */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** Derive the origin of the host as seen by one incoming request. */
function originFromRequest(req) {
  try {
    const host = req?.headers?.host
    const localAddress = req?.socket?.localAddress
    if (hostMatchesListener(host, localAddress)) {
      const origin = normalizeOrigin(`http://${host}`)
      if (origin !== undefined) return origin
    }
    const port = req?.socket?.localPort
    if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Candidate origins to try for the upstream proxy, most trustworthy first.
 *
 * A live request always wins. Next the remembered origin (a real GUI request),
 * then the user's explicit override, then the process environment — which is
 * how every DSH host already learns its own port. No port is hard-coded.
 */
function candidateOrigins(req, config) {
  const out = []
  const push = (value) => {
    const origin = normalizeOrigin(value)
    if (origin !== undefined && !out.includes(origin)) out.push(origin)
  }
  push(originFromRequest(req))
  push(rememberedOrigin)
  push(config.hostOrigin)
  for (const key of ['DSH_WEB_ORIGIN', 'DSH_ORIGIN']) push(process.env[key])
  for (const key of ['DSH_WEB_PORT', 'DSH_PORT', 'PORT']) {
    const raw = process.env[key]
    const port = raw === undefined ? NaN : Number(raw)
    if (Number.isInteger(port) && port > 0) push(`http://127.0.0.1:${port}`)
  }
  return out
}

//#endregion

//#region credit providers

/**
 * Cached balance sample, and the single in-flight refresh promise.
 *
 * `turn/start` and `turn/end` both want a balance, the browser polls a third
 * time, and the usage ledger is read on turn close. One cache plus one shared
 * in-flight request keeps that from becoming a burst of upstream calls.
 */
const creditsCache = { atMs: 0, value: null, origin: '', provider: '' }
let creditsInflight = null

/**
 * Fetch one JSON document from this host's own plugin routes.
 *
 * Never rejects. Resolves `{ status, body }` where `body` is the parsed object
 * (or `undefined` when unparsable). `status: 0` means the request never landed.
 */
async function fetchHostJson(origin, path, signal) {
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
      redirect: 'error',
    })
    if (!response.ok) {
      // Drain the body so the socket can be reused; the payload is irrelevant.
      try {
        await response.arrayBuffer()
      } catch { /* nothing to drain */ }
      return { status: response.status, body: undefined }
    }
    try {
      const body = await response.json()
      return {
        status: response.status,
        body: body !== null && typeof body === 'object' && !Array.isArray(body) ? body : undefined,
      }
    } catch {
      return { status: response.status, body: undefined }
    }
  } catch {
    return { status: 0, body: undefined }
  }
}

/**
 * PROVIDER #1 — `dsh-xdpool` status.
 *
 * This is the live, verified source of the real WorkBuddy balance. Document
 * shape (abridged from the live payload):
 *
 * ```
 * { ok: true,
 *   activeAccountId: "<account id>",
 *   accounts: [
 *     { id, label, domain, cooling, disabled, creditReserve,
 *       credits: { total: 12409,
 *                  packages: [{packageName, remain, size, monthly, expiresAtMs}],
 *                  expiringSoon: 353, nearestExpiryMs: 1793203913000 } },
 *     … ] }
 * ```
 *
 * PATH TO THE TOTAL, exactly:
 *   `accounts[]` → the element whose `id === activeAccountId` → `.credits.total`
 * with a documented fallback chain for every way that can miss:
 *   1. the account matching `activeAccountId`;
 *   2. the account flagged `selected === true` (older payloads);
 *   3. the first account that HAS a `credits` object;
 *   4. sum of every account that has one (only when nothing identifies itself
 *      as active — better than reporting a stranger's balance as the total).
 *
 * An account whose `credits` is ABSENT means "balance could not be read": it is
 * skipped, never coerced to 0. If no account has a balance the provider reports
 * `upstream-no-balance`, and the caller says "unavailable" rather than "0".
 */
function readXdpoolStatus(document) {
  const atMs = Date.now()
  if (document === null || typeof document === 'object' === false) {
    return { ok: false, error: 'upstream-invalid', atMs }
  }
  if (document.ok === false) return { ok: false, error: 'upstream-error', atMs }
  const accounts = Array.isArray(document.accounts) ? document.accounts : []

  /** Accounts that actually carry a readable balance. */
  const withCredits = accounts.filter(
    (account) => account !== null
      && typeof account === 'object'
      && account.credits !== null
      && typeof account.credits === 'object'
      && Number.isFinite(Number(account.credits.total)),
  )

  const activeId = typeof document.activeAccountId === 'string' ? document.activeAccountId : ''
  const active = activeId === '' ? undefined : withCredits.find((account) => account.id === activeId)
  const selected = withCredits.find((account) => account.selected === true)
  const chosen = active ?? selected ?? withCredits[0]

  if (chosen === undefined) {
    // Every account either has no `credits` or none at all. Unavailable, not 0.
    return {
      ok: false,
      error: accounts.length === 0 ? 'no-accounts' : 'upstream-no-balance',
      atMs,
      provider: 'xdpool-status',
    }
  }

  // A single account is the ordinary case. Only sum when the payload's own
  // identifiers could not pick one, so the number never mixes two accounts.
  const source = active ?? selected ?? null
  const aggregate = source === null ? withCredits : [source]

  const normalized = aggregate.map((account) => normalizeCreditPackages(account.credits))
  const total = normalized.reduce((sum, item) => sum + item.total, 0)
  const expiringSoon = normalized.reduce((sum, item) => sum + item.expiringSoon, 0)
  const expiries = normalized
    .map((item) => item.nearestExpiryMs)
    .filter((value) => Number.isFinite(value))

  return {
    ok: true,
    total: roundCredits(total),
    packages: normalized.flatMap((item) => item.packages),
    expiringSoon: roundCredits(expiringSoon),
    ...expiries.length === 0 ? {} : { nearestExpiryMs: Math.min(...expiries) },
    accountId: typeof chosen.id === 'string' ? chosen.id : '',
    accountCount: withCredits.length,
    atMs,
    provider: 'xdpool-status',
  }
}

/**
 * PROVIDER #2 — `dsh-connect-workbuddy` usage.
 *
 * Kept for profiles that DO install that package. Its document puts the balance
 * at the TOP level: `{ status, credits: { total, packages, … } }`. Absent when
 * that plugin is missing (the case on this host: HTTP 404).
 */
function readConnectUsage(document) {
  const atMs = Date.now()
  if (document === null || typeof document !== 'object') {
    return { ok: false, error: 'upstream-invalid', atMs }
  }
  const credits = document.credits
  if (credits === null || typeof credits !== 'object') {
    return { ok: false, error: 'upstream-no-balance', atMs, provider: 'connect-usage' }
  }
  const normalized = normalizeCreditPackages(credits)
  if (!Number.isFinite(normalized.total)) {
    return { ok: false, error: 'upstream-invalid', atMs, provider: 'connect-usage' }
  }
  return {
    ok: true,
    total: normalized.total,
    packages: normalized.packages,
    expiringSoon: normalized.expiringSoon,
    ...normalized.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: normalized.nearestExpiryMs },
    atMs,
    provider: 'connect-usage',
  }
}

/** Project one provider `credits` object onto `{ total, packages, … }`. */
function normalizeCreditPackages(credits) {
  const packages = Array.isArray(credits.packages) ? credits.packages : []
  const normalized = packages
    .filter((pack) => pack !== null && typeof pack === 'object')
    .map((pack) => ({
      packageName: typeof pack.packageName === 'string' ? pack.packageName : '',
      remain: Number.isFinite(Number(pack.remain)) ? Number(pack.remain) : 0,
      size: Number.isFinite(Number(pack.size)) ? Number(pack.size) : 0,
      monthly: pack.monthly === true,
      ...Number.isFinite(Number(pack.cycleRefreshMs)) ? { cycleRefreshMs: Number(pack.cycleRefreshMs) } : {},
      ...Number.isFinite(Number(pack.expiresAtMs)) ? { expiresAtMs: Number(pack.expiresAtMs) } : {},
    }))
  return {
    total: Number.isFinite(Number(credits.total)) ? Number(credits.total) : NaN,
    packages: normalized,
    expiringSoon: Number.isFinite(Number(credits.expiringSoon)) ? Number(credits.expiringSoon) : 0,
    ...Number.isFinite(Number(credits.nearestExpiryMs))
      ? { nearestExpiryMs: Number(credits.nearestExpiryMs) }
      : {},
  }
}

/**
 * The provider chain, in the order they are tried.
 *
 * Ordering is a product decision, not an accident: `xdpool-status` is the
 * source verified to work on this host, so it is first; `connect-usage` is a
 * cross-check for profiles that install that plugin. Adding a provider is one
 * entry here plus one `read…` function — nothing else changes.
 */
const CREDIT_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'xdpool-status',
    path: XDPOOL_STATUS_PATH,
    read: readXdpoolStatus,
    // This route takes no region parameter; it reports every account it knows.
    regional: false,
  }),
  Object.freeze({
    id: 'connect-usage',
    path: CONNECT_USAGE_PATH,
    read: readConnectUsage,
    regional: true,
  }),
])

/**
 * Read the balance through the provider chain, behind a short cache.
 *
 * `force` is what a turn boundary uses — a delta between two CACHED samples
 * would be 0 for any turn shorter than the TTL. The single in-flight promise is
 * always reused, so `force` cannot stampede the host.
 *
 * @returns {Promise<object>} `{ ok, total?, …, atMs, source: 'live'|'unavailable' }`
 */
async function readCreditTotal(options = {}) {
  const config = options.config ?? currentConfig()
  const force = options.force === true

  if (config.enabled === false) {
    return { ok: false, error: 'disabled', atMs: Date.now(), source: 'unavailable' }
  }

  const origins = candidateOrigins(options.req, config)
  if (origins.length === 0) {
    return { ok: false, error: 'no-host-origin', atMs: Date.now(), source: 'unavailable' }
  }

  const ttl = refreshMsOf(config)
  if (!force && creditsCache.value !== null && Date.now() - creditsCache.atMs < ttl) {
    return { ...creditsCache.value, cached: true }
  }
  if (creditsInflight !== null) {
    try {
      return await creditsInflight
    } catch { /* fall through to a fresh attempt */ }
  }

  const attempt = (async () => {
    /** Answers from providers that existed but had nothing to report. */
    const answered = []
    /** Failures that only mean "this provider is not here". */
    const absent = []
    let unreachable = null

    for (const origin of origins) {
      for (const provider of CREDIT_PROVIDERS) {
        try {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
          const path = provider.regional
            ? `${provider.path}?${UPSTREAM_REGION_PARAM}=${encodeURIComponent(config.region)}`
            : provider.path
          const { status, body } = await fetchHostJson(origin, path, signal)

          if (status === 0) {
            unreachable = { ok: false, error: 'upstream-unreachable', atMs: Date.now(), provider: provider.id }
            continue
          }
          if (status === 404) {
            absent.push({ ok: false, error: 'provider-not-installed', atMs: Date.now(), status, provider: provider.id })
            continue
          }
          if (status === 403) {
            unreachable = { ok: false, error: 'provider-forbidden', atMs: Date.now(), status, provider: provider.id }
            continue
          }
          if (status !== 200 || body === undefined) {
            unreachable = { ok: false, error: 'upstream-error', atMs: Date.now(), status, provider: provider.id }
            continue
          }

          const answer = provider.read(body)
          if (answer.ok === true) {
            // Republish under a stable provider id regardless of which read
            // function produced it, so the route's `provider` field is a
            // contract rather than an implementation detail.
            const value = { ...answer, provider: provider.id, source: 'live', origin }
            creditsCache.atMs = value.atMs
            creditsCache.value = value
            creditsCache.origin = origin
            creditsCache.provider = provider.id
            return value
          }
          answered.push({ ...answer, provider: provider.id })
        } catch {
          unreachable = { ok: false, error: 'upstream-unreachable', atMs: Date.now(), provider: provider.id }
        }
      }
    }

    // Report the most INFORMATIVE failure, not merely the last one tried:
    // "the upstream answered but has no readable balance" says something about
    // the account, whereas "provider not installed" only says something about
    // the profile. Prefer the former.
    const chosen = answered[0] ?? unreachable ?? absent[0]
      ?? { ok: false, error: 'upstream-unreachable', atMs: Date.now() }
    return { ...chosen, source: 'unavailable' }
  })()

  creditsInflight = attempt
  try {
    return await attempt
  } finally {
    if (creditsInflight === attempt) creditsInflight = null
  }
}

/**
 * Detached balance sample: resolves a snapshot or `null`, never rejects.
 * This is the shape the turn observer needs, because a listener may not await.
 */
function sampleCreditsQuietly(options = {}) {
  try {
    return readCreditTotal({ ...options, force: options.force !== false }).then(
      (answer) => (answer.ok === true
        ? { total: answer.total, atMs: answer.atMs, origin: answer.origin ?? '', provider: answer.provider ?? '' }
        : null),
      () => null,
    )
  } catch {
    return Promise.resolve(null)
  }
}

//#endregion

//#region usage ledger reader (per-turn attribution)

/**
 * Read the xdpool usage ledger, returning its `entries[]` (newest first).
 *
 * VERIFIED ordering: the live document returns entries in DESCENDING `at`
 * order (newest first), so the first element is the most recent call. The sort
 * below is defensive rather than load-bearing — if that ever changes, the
 * attribution logic must not silently start reading the oldest turn in the
 * window.
 *
 * Resolves `null` on any failure; never rejects.
 */
async function readUsageEntries(options = {}) {
  const config = options.config ?? currentConfig()
  const origins = candidateOrigins(options.req, config)
  for (const origin of origins) {
    try {
      const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      const { status, body } = await fetchHostJson(origin, XDPOOL_USAGE_PATH, signal)
      if (status !== 200 || body === undefined) continue
      const entries = Array.isArray(body.entries) ? body.entries : []
      const parsed = []
      for (const entry of entries) {
        const item = parseUsageEntry(entry)
        if (item !== null) parsed.push(item)
      }
      if (parsed.length === 0) return null
      // Newest first. Attribution then selects by the TURN's own window.
      //
      // Deliberately NOT filtered against `Date.now()` here: the useful
      // reference point is the turn being attributed, not the instant this
      // function runs. A clock-relative filter would silently stop matching
      // (and would break any replayed or backfilled turn) the moment the
      // process clock and the ledger drifted. The scan is bounded by the turn
      // window in `attributeTurnToLedger`, and by a hard cap on array length.
      parsed.sort((a, b) => b.atMs - a.atMs)
      return parsed.length > USAGE_ENTRY_SCAN_LIMIT
        ? parsed.slice(0, USAGE_ENTRY_SCAN_LIMIT)
        : parsed
    } catch { /* try the next origin */ }
  }
  return null
}

/**
 * Parse one xdpool `entries[]` item.
 *
 * The two token-semantics facts this depends on were verified against the live
 * payload and are stated on `LEDGER_CACHE_INCLUDED_IN_INPUT` /
 * `REASONING_TOKENS_INCLUDED_IN_OUTPUT`. Note the ledger's semantics differ
 * from the session event's — see `LEDGER_CACHE_INCLUDED_IN_INPUT`. Returns
 * `null` for an entry without a usable timestamp: an unattributable entry is
 * worse than no entry.
 */
function parseUsageEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const atMs = Number(entry.at)
  if (!Number.isFinite(atMs) || atMs <= 0) return null
  const usage = entry.usage !== null && typeof entry.usage === 'object' ? entry.usage : {}
  return {
    atMs,
    model: typeof entry.model === 'string' ? entry.model : '',
    account: typeof entry.account === 'string' ? entry.account : '',
    turnId: typeof entry.turnId === 'string' ? entry.turnId : '',
    ok: entry.ok !== false,
    region: typeof entry.region === 'string' ? entry.region : '',
    usage: tokensFromUsageEntry(usage),
  }
}

/**
 * Convert an xdpool `usage` object into this plugin's five-bucket vocabulary.
 *
 * `inputTokens` INCLUDES `cachedTokens`, so the cached count is SPLIT OUT of
 * input here — otherwise the same prompt tokens would be charged twice (once at
 * the full input weight, once at the discounted cache weight). `outputTokens`
 * already includes `reasoningTokens`, so reasoning is reported but not
 * re-charged (its weight is 0 in `TOKEN_WEIGHTS` for that reason).
 */
/**
 * Normalize one xdpool usage-ledger payload.
 *
 * Uses `LEDGER_CACHE_INCLUDED_IN_INPUT` (TRUE), which is specific to this
 * source: here `inputTokens` is the TOTAL prompt and `cachedTokens` is the
 * cached slice of it, so the uncached remainder is `input - cache`. Using the
 * session-event rule here double-bills the whole prompt and overstated a real
 * turn 10.1x (2.69 credits shown as 27.19).
 *
 * Field names differ between the two sources too: the ledger spells it
 * `cachedTokens`, session events spell it `cacheReadTokens`. Reading only one
 * reports a cache of zero on the other, which is a six-figure undercount.
 */
function tokensFromUsageEntry(usage) {
  const input = count(usage.inputTokens)
  const cached = count(usage.cachedTokens ?? usage.cacheReadTokens)
  const output = count(usage.outputTokens)
  const reasoning = count(usage.reasoningTokens)
  const included = LEDGER_CACHE_INCLUDED_IN_INPUT
  const uncachedInput = included ? Math.max(0, input - cached) : input
  return {
    input: uncachedInput,
    // `Math.min` guards a payload that contradicts the measured shape: an
    // over-reported cache must never make the cached bucket exceed the prompt
    // it came from.
    cacheRead: included ? Math.min(cached, input) : cached,
    cacheWrite: count(usage.cacheWriteTokens),
    output,
    reasoning,
  }
}

/**
 * Attribute one turn to the upstream usage ledger.
 *
 * Strategy — WALL-CLOCK WINDOW, not id matching. The ledger's `turnId` is
 * xdpool's own hash (e.g. `8bfcd38faebf147d`), unrelated to DSH's integer
 * `event.data.turn`, so matching on it would be pure guesswork. Timestamps are
 * not guesswork: an entry's `at` is when that upstream call finished, and a turn
 * has a real `[startMs, endMs]` taken from the session log's own event times.
 *
 * SUMMING, not "exactly one". A DSH turn is not one LLM call: the agent loop
 * runs `step/start` … `step/end` repeatedly inside a single turn, and EVERY one
 * of those steps issues an upstream request. So a normal turn produces several
 * usage entries, and "pick the single matching entry" would fail to match on
 * essentially every real turn. All entries inside the window belong to the turn
 * and are summed.
 *
 * Attribution rules, chosen so a wrong answer is never confidently reported:
 *   - ignore failed entries (`ok: false`) — a failed call bills nothing;
 *   - FIRST try the STRICT window `[turnStartMs, turnEndMs]`, with no slack. A
 *     call cannot finish before the turn it ran in, so this window is exact and
 *     cannot absorb a neighbouring turn's entry;
 *   - ONLY if the strict window is empty, retry with `TURN_WINDOW_SLACK_MS` on
 *     each side, and accept that wider result only when it holds EXACTLY ONE
 *     entry. One entry is unambiguous even in a padded window; several would be
 *     guesswork about which side of the boundary they belong to, so that case
 *     returns null and the caller falls through to the balance delta.
 *
 * @returns {{ entries: object[], tokens: object, model: string, windowMs: number } | null}
 */
function attributeTurnToLedger(entries, turnStartMs, turnEndMs) {
  if (Array.isArray(entries) === false || entries.length === 0) return null
  if (!Number.isFinite(turnStartMs) || !Number.isFinite(turnEndMs)) return null
  const from = Math.min(turnStartMs, turnEndMs)
  const to = Math.max(turnStartMs, turnEndMs)
  // A window this wide is not one turn (a resume, a clock jump, a stale ledger
  // entry). Attributing entries across it would be guesswork dressed as data.
  if (to - from > USAGE_LOOKBACK_MS) return null

  // Pass 1: the exact window. A multi-step turn contributes several entries.
  let inside = entries.filter((entry) => entry.ok && entry.atMs >= from && entry.atMs <= to)
  if (inside.length === 0) {
    // Pass 2: padded window, tolerated only when it is unambiguous.
    const padded = entries.filter(
      (entry) => entry.ok
        && entry.atMs >= from - TURN_WINDOW_SLACK_MS
        && entry.atMs <= to + TURN_WINDOW_SLACK_MS,
    )
    if (padded.length !== 1) return null
    inside = padded
  }

  const tokens = emptyTokenUsage()
  for (const entry of inside) addTokenUsage(tokens, entry.usage)

  // The upstream's own record of which model served the call wins, and a
  // multi-step turn can legitimately span models (a cheap title model, say).
  // Report the model that did the most work rather than whichever came last.
  const byModel = new Map()
  for (const entry of inside) {
    if (entry.model === '') continue
    const weight = entry.usage.input + entry.usage.cacheRead + entry.usage.output
    byModel.set(entry.model, (byModel.get(entry.model) ?? 0) + weight)
  }
  let model = ''
  let bestWeight = -1
  for (const [candidate, weight] of byModel) {
    if (weight > bestWeight) {
      bestWeight = weight
      model = candidate
    }
  }

  return {
    entries: inside,
    tokens,
    model,
    windowMs: to - from,
    matchedAtMs: inside.reduce((max, entry) => Math.max(max, entry.atMs), 0),
    entryCount: inside.length,
  }
}

//#endregion

//#region model catalog

/**
 * Resolve a model id to its credit multiplier.
 *
 * Handles the spellings a provider actually emits: a `provider/model` prefix, a
 * `model@snapshot` or `model:variant` suffix, and mixed case. Exact hits win;
 * otherwise the LONGEST catalog id that prefixes the id is used, so a dated
 * variant (`deepseek-v4.1-flash-2026xx`) still resolves while a merely similar
 * name does not.
 *
 * @returns {{ multiplier: number, source: 'catalog'|'config'|'default' }}
 */
function resolveMultiplier(modelId, config) {
  const catalog = catalogOf(config)
  const normalized = normalizeModelId(modelId)
  if (normalized !== '') {
    if (Object.hasOwn(catalog, normalized)) {
      return { multiplier: catalog[normalized], source: 'catalog' }
    }
    let best = ''
    for (const key of Object.keys(catalog)) {
      if (normalized.startsWith(key) && key.length > best.length) best = key
    }
    if (best !== '') return { multiplier: catalog[best], source: 'catalog' }
  }
  const fallback = Number(config.defaultCreditMultiplier)
  return {
    multiplier: Number.isFinite(fallback) && fallback >= 0 ? fallback : DEFAULT_CREDIT_MULTIPLIER,
    source: 'default',
  }
}

/** The catalog in force: the built-in table overlaid with the settings override. */
function catalogOf(config) {
  const override = config?.modelCatalog
  if (override === null || typeof override !== 'object') return MODEL_CREDIT_MULTIPLIERS
  const merged = { ...MODEL_CREDIT_MULTIPLIERS }
  for (const [key, value] of Object.entries(override)) {
    const multiplier = Number(value)
    if (Number.isFinite(multiplier) && multiplier >= 0) merged[normalizeModelId(key)] = multiplier
  }
  return merged
}

/** Lower-case, provider-stripped, variant-stripped model id. */
function normalizeModelId(modelId) {
  if (typeof modelId !== 'string') return ''
  let value = modelId.trim().toLowerCase()
  const slash = value.lastIndexOf('/')
  if (slash !== -1) value = value.slice(slash + 1)
  const at = value.indexOf('@')
  if (at > 0) value = value.slice(0, at)
  const colon = value.indexOf(':')
  if (colon > 0) value = value.slice(0, colon)
  return value.trim()
}

//#endregion

//#region estimation

/**
 * Turn a token breakdown into credits.
 *
 * `credits = weightedTokens x creditMultiplier x priceBasis`
 *
 * where `weightedTokens = SUM(bucket x TOKEN_WEIGHTS[bucket])`. The weights are
 * relative units, not prices — see `TOKEN_WEIGHTS`.
 *
 * This function is used for EVERY path that reports credits, measured or not:
 * neither live provider exposes an explicit credit charge (the xdpool usage
 * document has no price field at all), so the value is always a conversion.
 * What `measured` distinguishes is whether the TOKEN COUNT is the upstream's
 * own record of this exact turn or our own accumulation.
 *
 * @returns {{ credits: number, tokens: number, weightedTokens: number, multiplier: number, multiplierSource: string, basis: number, model: string }}
 */
function estimateCredits(tokenUsage, modelId, config) {
  const usage = tokenUsage ?? {}
  const buckets = {
    input: count(usage.input),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    output: count(usage.output),
    reasoning: count(usage.reasoning),
  }

  /**
   * Weight of one bucket.
   *
   * `reasoning` is decided HERE, from the constant, rather than by hoping the
   * table's 0 and this platform's payloads stay in agreement: if a provider ever
   * stops including reasoning in output, setting
   * `REASONING_TOKENS_INCLUDED_IN_OUTPUT = false` makes reasoning bill at the
   * output weight instead — no table edit, and no silent double-charge.
   */
  const weightOf = (bucket) => {
    if (bucket === 'reasoning' && REASONING_TOKENS_INCLUDED_IN_OUTPUT === false) {
      return TOKEN_WEIGHTS.output
    }
    return TOKEN_WEIGHTS[bucket]
  }

  let tokens = 0
  let weightedTokens = 0
  for (const [bucket, value] of Object.entries(buckets)) {
    tokens += value
    weightedTokens += value * weightOf(bucket)
  }

  const { multiplier, source } = resolveMultiplier(modelId, config)
  const configuredBasis = Number(config.priceBasis)
  const basis = Number.isFinite(configuredBasis) && configuredBasis >= 0 ? configuredBasis : PRICE_BASIS

  return {
    credits: roundCredits(weightedTokens * multiplier * basis),
    tokens,
    weightedTokens,
    multiplier,
    multiplierSource: source,
    basis,
    model: typeof modelId === 'string' ? modelId : '',
  }
}

/** Normalise a loose token-usage payload into the five named buckets. */
function normalizeTokenUsage(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (...keys) => {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return 0
  }
  return {
    input: pick('input', 'inputTokens', 'uncachedInputTokens', 'cacheMiss'),
    cacheRead: pick('cacheRead', 'cacheReadTokens', 'cacheHit'),
    cacheWrite: pick('cacheWrite', 'cacheWriteTokens'),
    output: pick('output', 'outputTokens'),
    reasoning: pick('reasoning', 'reasoningTokens'),
  }
}

/** Sum two token-usage records, bucket by bucket. */
function addTokenUsage(target, addition) {
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']) {
    target[key] = count(target[key]) + count(addition?.[key])
  }
  return target
}

/** A fresh all-zero token-usage record. */
function emptyTokenUsage() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

//#endregion

//#region turn ledger

/**
 * Bounded LRU ledger of per-turn credit records, keyed `${sessionId}:${turnId}`.
 *
 * Insertion order IS the LRU order: a read re-inserts the key, and eviction
 * drops the first (least recently touched) entry once the cap is exceeded. No
 * timer, no sweep — a long-lived host simply cannot grow this past
 * `LEDGER_CAPACITY`.
 */
class TurnLedger {
  constructor(capacity = LEDGER_CAPACITY) {
    this.capacity = Math.max(1, capacity)
    /** @type {Map<string, object>} */
    this.entries = new Map()
  }

  keyOf(sessionId, turnId) {
    return `${sessionId}:${turnId}`
  }

  /** Read one entry, refreshing its LRU position. */
  get(sessionId, turnId) {
    const key = this.keyOf(sessionId, turnId)
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /** Store one entry, evicting the least recently touched past the cap. */
  set(entry) {
    const key = this.keyOf(entry.sessionId, entry.turnId)
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
    return entry
  }

  /** Create a fresh, unmeasured record for one turn. */
  open(sessionId, turnId, extra = {}) {
    const existing = this.get(sessionId, turnId)
    if (existing !== undefined) return existing
    const nowMs = Date.now()
    return this.set({
      sessionId,
      turnId,
      openedAtMs: nowMs,
      // The wall-clock window this turn is attributed against. Set explicitly by
      // the observer from the event time; `openedAtMs` is the fallback so a
      // lazily-created entry still has a window.
      startedAtMs: Number.isFinite(extra.startedAtMs) ? extra.startedAtMs : nowMs,
      touchedAtMs: nowMs,
      baseline: null,
      baselinePromise: null,
      tokens: emptyTokenUsage(),
      model: '',
      status: 'armed',
      result: null,
      reason: '',
      synthetic: extra.synthetic === true,
      ...extra,
    })
  }

  /** Most recently touched open turn for a session, or undefined. */
  latestOpen(sessionId) {
    let found
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId && entry.result === null) found = entry
    }
    return found
  }

  /**
   * The most recently touched `${sessionId}:${turnId}` keys, newest last.
   *
   * Diagnostics only: `GET /health` publishes these so "the footer is blank"
   * can be separated from "the observer never saw the turn" without attaching a
   * debugger. A key's session segment is the id the host reported on
   * `session/event`, which is what the browser must pass to `GET /turn`.
   */
  recentKeys(limit = 8) {
    const all = [...this.entries.keys()]
    return all.slice(Math.max(0, all.length - limit))
  }

  get size() {
    return this.entries.size
  }
}

const ledger = new TurnLedger()

//#endregion

//#region per-turn computation

/**
 * Close one turn: sample the balance, derive the delta, and fall back to the
 * estimate whenever the delta cannot be trusted.
 *
 * Runs DETACHED — the caller (a `session/event` listener) must not await it. The
 * result lands on the ledger entry, and `GET /turn` reports `pending: true`
 * until it does.
 */
async function finalizeTurn(entry, config) {
  try {
    const turnEndMs = Number.isFinite(entry.endedAtMs) ? entry.endedAtMs : Date.now()
    const turnStartMs = Number.isFinite(entry.startedAtMs)
      ? entry.startedAtMs
      : (Number.isFinite(entry.openedAtMs) ? entry.openedAtMs : turnEndMs)

    // The balance is needed on every path, both for `remaining` and for the
    // delta fallback. Sample it once, in parallel with the usage read.
    const [snapshot, usageEntries] = await Promise.all([
      sampleCreditsQuietly({ config, force: true }),
      readUsageEntries({ config }),
    ])

    // The turn/start sample, awaited only briefly: a short turn can easily
    // finish before its own baseline request does.
    let baseline = entry.baseline
    if (baseline === null && entry.baselinePromise !== null) {
      baseline = await withTimeout(entry.baselinePromise, BASELINE_AWAIT_MS)
      entry.baseline = baseline
    }

    const ownTokens = { ...entry.tokens }
    let tokenUsage = ownTokens
    let model = entry.model
    let source = TURN_SOURCES.ESTIMATE
    let reason = 'no-token-usage'
    let creditsSpent = 0
    /** The upstream ledger entries attributed to this turn, if any. */
    let matched = null

    // ---- Tier 1: upstream usage entries inside this turn's window. A turn
    // spans several steps, so this SUMS every entry that landed in the window.
    //
    // Skipped when the window itself is unknown (`windowUnknown`: a turn/end we
    // never saw a start for). Attribution needs a real boundary; without one it
    // would either match nothing or match a neighbour's calls. The turn's own
    // accumulated tokens are still complete, and Tier 3 converts them.
    const attribution = entry.windowUnknown === true
      ? null
      : attributeTurnToLedger(usageEntries, turnStartMs, turnEndMs)
    if (attribution !== null) {
      matched = attribution
      tokenUsage = { ...attribution.tokens }
      // The upstream's own record of which model served the calls wins over our
      // best guess from the session log.
      if (attribution.model !== '') model = attribution.model
      source = TURN_SOURCES.USAGE_ENTRY
      reason = 'measured'
    }

    // ---- Tier 2: the balance moved by this amount during the turn.
    if (
      matched === null
      && baseline !== null && Number.isFinite(baseline.total)
      && snapshot !== null && Number.isFinite(snapshot.total)
    ) {
      const delta = baseline.total - snapshot.total
      if (!Number.isFinite(delta)) {
        reason = 'no-baseline'
      } else if (delta < 0) {
        // The balance went UP during the turn: a top-up, a refund, or a
        // monthly rollover. A negative "spent" is worse than an honest guess.
        reason = 'balance-increased'
      } else if (delta > MAX_PLAUSIBLE_TURN_CREDITS) {
        // Someone else spent against the same balance, or a cached sample
        // straddled a top-up. Refuse to attribute it to this turn.
        reason = 'implausible-delta'
      } else {
        source = TURN_SOURCES.BALANCE_DELTA
        reason = 'measured'
        creditsSpent = delta
      }
    } else if (matched === null && baseline === null) {
      reason = 'no-baseline'
    } else if (matched === null) {
      reason = 'upstream-unavailable'
    }

    // ---- The conversion. Runs on every path: none of the providers exposes an
    // explicit credit charge, so credits are always `tokens x mult x basis`.
    const converted = estimateCredits(tokenUsage, model, config)
    if (source !== TURN_SOURCES.BALANCE_DELTA) {
      creditsSpent = converted.tokens > 0 ? converted.credits : 0
      if (converted.tokens === 0) reason = 'no-token-usage'
    }

    // `measured` requires a real basis for the number:
    //  - balance-delta: the BALANCE ITSELF moved; token counts are irrelevant.
    //  - usage-entry: the upstream reported exact tokens for this turn.
    //  - estimate: never measured.
    const measured = source === TURN_SOURCES.BALANCE_DELTA
      || (source === TURN_SOURCES.USAGE_ENTRY && converted.tokens > 0)
    const fresh = snapshot !== null && Number.isFinite(snapshot.total)
    const cachedTotal = creditsCache.value !== null && Number.isFinite(creditsCache.value.total)
      ? creditsCache.value.total
      : null
    // `remaining` prefers the freshly sampled balance. A stale last-known value
    // is still more useful than nothing, but it is LABELLED so the UI can age it
    // instead of presenting minutes-old data as current.
    const remaining = fresh ? snapshot.total : (creditsCache.value === null ? null : cachedTotal)
    const remainingSource = fresh ? 'live' : (cachedTotal === null ? 'unavailable' : 'cache')

    entry.result = {
      ok: true,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      creditsSpent: roundCredits(creditsSpent),
      remaining,
      remainingSource,
      measured,
      source,
      reason,
      tokenUsage,
      model: model === '' ? null : model,
      creditMultiplier: converted.multiplier,
      creditMultiplierSource: converted.multiplierSource,
      atMs: Date.now(),
      windowMs: turnEndMs - turnStartMs,
      // Present whenever the number is a conversion rather than a balance
      // movement, so the UI can explain how it was derived.
      ...source === TURN_SOURCES.BALANCE_DELTA ? {} : {
        estimate: {
          tokens: converted.tokens,
          weightedTokens: roundCredits(converted.weightedTokens),
          basis: converted.basis,
          multiplier: converted.multiplier,
        },
      },
      ...matched === null ? {} : {
        matchedAtMs: matched.matchedAtMs,
        matchedEntries: matched.entryCount,
      },
    }
    entry.status = 'done'
    entry.touchedAtMs = Date.now()
    ledger.set(entry)
  } catch {
    // Never let a detached task surface as an unhandled rejection; an untouched
    // entry simply keeps answering `pending: true`.
    entry.status = 'failed'
    entry.reason = 'internal-error'
  }
}

/** Await a promise, resolving `null` on timeout or rejection. */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const timer = setTimeout(() => finish(null), ms)
      if (typeof timer?.unref === 'function') timer.unref()
      promise.then(
        (value) => { clearTimeout(timer); finish(value) },
        () => { clearTimeout(timer); finish(null) },
      )
    } catch {
      finish(null)
    }
  })
}

//#endregion

//#region session event observer

/** Availability flag for the turn observer, reported so the UI can explain itself. */
const observer = { available: false, seen: 0, lastAtMs: 0 }

/**
 * Subscribe to the host session event stream.
 *
 * `ctx.on('session/event', (session, event) => …)` is the same seam
 * `@deepseek-ai/dsh-session-persistence-jsonl` uses to write the log, and the
 * agent loop emits `turn/start` before its first step and `turn/end` from a
 * `finally`. That gives this plugin exact turn boundaries without the browser
 * having to report them.
 *
 * The `function*` body is Cordis's effect idiom: every `yield`ed value is a
 * disposer the effect owns, so unloading the plugin unsubscribes cleanly.
 *
 * Everything here degrades: a host without `ctx.on` leaves `observer.available`
 * false and the HTTP fallback routes keep working.
 */
function attachSessionObserver(ctx) {
  try {
    if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') return
    ctx.effect(function* () {
      const off = ctx.on('session/event', (session, event) => {
        // The single most important line in this file: a throw from here would
        // run inside the agent's own append path.
        try {
          observeSessionEvent(session, event)
        } catch { /* contained by design */ }
      })
      observer.available = true
      yield () => {
        observer.available = false
        try {
          if (typeof off === 'function') off()
        } catch { /* the fiber is already gone */ }
      }
    }, 'dsh-workbuddy-billing: session turn observer')
  } catch {
    observer.available = false
  }
}

/** Dispatch one session event. Synchronous, total, and never awaited. */
function observeSessionEvent(session, event) {
  const config = currentConfig()
  if (config.enabled === false || config.sessionEvents === false) return

  const sessionId = typeof session?.id === 'string' ? session.id : ''
  if (sessionId === '') return
  const type = typeof event?.type === 'string' ? event.type : ''
  if (type === '') return

  observer.seen += 1
  observer.lastAtMs = Date.now()

  if (type === 'turn/start') {
    onTurnStart(sessionId, event, config)
    return
  }
  if (type === 'turn/end') {
    onTurnEnd(sessionId, event, config)
    return
  }
  if (type === 'assistant/message' || type === 'assistant/attempt') {
    onAssistantEvent(sessionId, event, config)
    return
  }
  if (type === 'request/header') {
    onRequestHeader(sessionId, event)
  }
}

/**
 * `turn/start`: open the record and start the baseline sample (never awaited).
 *
 * The event carries a `time` stamp from the session log; that is what the later
 * usage-ledger attribution measures against, so it is recorded here rather than
 * guessed at close time.
 */
function onTurnStart(sessionId, event, config) {
  try {
    const turnId = turnIdOf(event)
    if (turnId === '') return
    const startedAtMs = eventTimeOf(event)
    const entry = ledger.open(sessionId, turnId, { startedAtMs })
    if (Number.isFinite(startedAtMs)) entry.startedAtMs = startedAtMs
    if (entry.baselinePromise !== null) return
    // Fire-and-forget: a turn/start listener must not add latency.
    entry.baselinePromise = sampleCreditsQuietly({ config }).then((snapshot) => {
      entry.baseline = snapshot
      return snapshot
    })
  } catch { /* never throw into the session */ }
}

/** `assistant/message` / `assistant/attempt`: accumulate usage and model. */
/**
 * Pull token usage out of one assistant settlement.
 *
 * A settled `assistant/message` does NOT carry `data.usage`. It carries the
 * provider's compact timed stream (`data.stream`), and the counts live in the
 * LAST raw chunk whose `type` is `'usage'` — exactly how
 * `@deepseek-ai/dsh-llm`'s own `lastAssistantStreamChunk(stream, 'usage')`
 * reads them, and how `@deepseek-ai/dsh-token-meter` feeds
 * `normalizeUsage`. Field names inside that chunk are
 * `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens /
 * reasoningTokens / totalTokens`.
 *
 * Several shapes are tolerated because this is the one input the plugin cannot
 * prove against every host build: a direct `data.usage`, the last `usage`
 * stream chunk, and a top-level `data.stream`. The first that yields a count
 * wins; none yields zero rather than a guess.
 *
 * @returns a normalized usage record, or `undefined` when the event has none.
 */
function usageFromAssistantEvent(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== null && typeof data.usage === 'object') {
    return normalizeTokenUsage(data.usage)
  }
  const stream = Array.isArray(data.stream) ? data.stream : undefined
  if (stream === undefined) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object') continue
    if (record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage'
      && chunk.usage !== null && typeof chunk.usage === 'object') {
      return normalizeTokenUsage(chunk.usage)
    }
  }
  return undefined
}

function onAssistantEvent(sessionId, event, config) {
  try {
    const data = event?.data
    if (data === null || typeof data !== 'object') return
    const turnId = turnIdOf(event)
    if (turnId === '') return

    const usage = usageFromAssistantEvent(data)
    const model = modelIdOf(data)

    // Create the record when it does not exist yet, instead of dropping the
    // settlement. This is the difference between "the footer shows 0" and "the
    // footer shows the turn's real tokens" whenever the observer missed the
    // turn/start (plugin enabled mid-turn, or a turn whose start predates the
    // observer): the assistant settlements still arrive, and they carry the only
    // token counts this plugin can get. Dropping them loses the whole number.
    //
    // A record created here is marked `synthetic`, so it does not pretend the
    // window is known (see `onTurnEnd`).
    const existing = ledger.get(sessionId, turnId) ?? ledger.latestOpen(sessionId)
    if (existing !== undefined && existing.result !== null) return
    const entry = existing ?? ledger.open(sessionId, turnId, {
      synthetic: true,
      startedAtMs: eventTimeOf(event),
    })

    if (usage !== undefined) addTokenUsage(entry.tokens, usage)
    if (model !== '') entry.model = model
    entry.touchedAtMs = Date.now()
  } catch { /* never throw into the session */ }
}

/** `request/header`: the only reliable place the routed model id appears. */
function onRequestHeader(sessionId, event) {
  try {
    const model = modelIdOf(event?.data)
    if (model === '') return
    const turnId = turnIdOf(event)
    const entry = (turnId === '' ? undefined : ledger.get(sessionId, turnId))
      ?? ledger.latestOpen(sessionId)
    if (entry === undefined || entry.result !== null) return
    if (entry.model === '') entry.model = model
  } catch { /* never throw into the session */ }
}

/** `turn/end`: mark pending and hand the close to a detached task. */
function onTurnEnd(sessionId, event, config) {
  try {
    const turnId = turnIdOf(event)
    if (turnId === '') return
    const endedAtMs = eventTimeOf(event)
    const known = ledger.get(sessionId, turnId)
    const entry = known ?? ledger.open(sessionId, turnId, { synthetic: true })
    if (entry.result !== null) return

    // A synthetic entry means this turn/end arrived WITHOUT its turn/start:
    // the observer was mounted mid-turn, or the plugin was enabled while a turn
    // was already running. `ledger.open` fills `startedAtMs` from `Date.now()`
    // in that case, which is LATER than the turn really began and later still
    // than the end event's own (already stamped) time — so the window comes out
    // NEGATIVE and every window-based attribution refuses, throwing away token
    // counts that were accumulated perfectly well.
    //
    // Fix: when we never saw the start, stop pretending we know the window.
    // Widen it to the earliest moment this entry could represent, so the
    // turn's own accumulated tokens are still usable and usage-ledger
    // attribution is not gated on a boundary we never observed.
    if (known === undefined || entry.synthetic === true) {
      entry.synthetic = true
      entry.startedAtMs = Number.isFinite(endedAtMs) ? endedAtMs : Date.now()
      entry.windowUnknown = true
    }

    entry.status = 'closing'
    entry.endedAtMs = Number.isFinite(endedAtMs) ? endedAtMs : Date.now()
    // A backwards window can only come from mixed time sources (log stamp vs
    // wall clock). Never let it leak into the attribution maths.
    if (entry.endedAtMs < entry.startedAtMs) entry.startedAtMs = entry.endedAtMs
    entry.touchedAtMs = Date.now()
    // Detached: the listener returns immediately, the ledger fills in later.
    void finalizeTurn(entry, config).catch(() => {})
  } catch { /* never throw into the session */ }
}

/** The event's own wall-clock stamp, or NaN when the host did not supply one. */
function eventTimeOf(event) {
  const raw = event?.time
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : NaN
}

/** Pull the turn number out of an event's payload as a stable string id. */
function turnIdOf(event) {
  const raw = event?.data?.turn
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw !== '') return raw
  return ''
}

/** Pull a model id out of an event payload, trying every shape the log uses. */
function modelIdOf(data) {
  const candidates = [
    data?.message?.source?.model,
    data?.source?.model,
    data?.model,
    data?.header?.config?.model,
    data?.config?.model,
    data?.modelId,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

//#endregion

//#region config plumbing

/**
 * The live config, flattened.
 *
 * Cordis hands volatile fields through as `{ get() }` live references; a plain
 * spread would store the reference object, not the value. Reading through
 * `get()` on every access also means a settings change takes effect without a
 * reload.
 */
function currentConfig() {
  try {
    const source = configRef
    if (source === null || typeof source !== 'object') return { ...DEFAULT_CONFIG }
    const out = { ...DEFAULT_CONFIG }
    for (const [key, value] of Object.entries(source)) {
      out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function'
        ? value.get()
        : value
    }
    return out
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** The config object handed to `apply`, captured for `currentConfig`. */
let configRef = null

//#endregion

//#region routes

/** `GET /credits` — the live balance, or a structured "unavailable". */
async function handleCredits(req, res) {
  try {
    const config = currentConfig()
    rememberOrigin(req)
    const answer = await readCreditTotal({ req, config })
    if (answer.ok === true) {
      json(res, 200, {
        ok: true,
        total: answer.total,
        packages: answer.packages,
        expiringSoon: answer.expiringSoon,
        ...answer.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: answer.nearestExpiryMs },
        atMs: answer.atMs,
        source: 'live',
        // Which upstream document this came from. `xdpool-status` is the live
        // source on this host; see CREDIT_PROVIDERS for the order.
        provider: answer.provider,
        cached: answer.cached === true,
        region: config.region,
      })
      return
    }
    // Degrade, never 500: an absent upstream plugin is a supported state, and
    // "unavailable" must never be reported as a balance of 0.
    json(res, 200, {
      ok: false,
      total: null,
      packages: [],
      expiringSoon: 0,
      atMs: answer.atMs,
      source: 'unavailable',
      error: answer.error,
      ...answer.provider === undefined ? {} : { provider: answer.provider },
      ...answer.status === undefined ? {} : { status: answer.status },
      region: config.region,
    })
  } catch {
    json(res, 200, {
      ok: false, total: null, packages: [], expiringSoon: 0,
      atMs: Date.now(), source: 'unavailable', error: 'internal-error',
    })
  }
}

/** `GET /turn` — one turn's record, an estimate, or `pending`. */
async function handleTurn(req, res) {
  try {
    const config = currentConfig()
    rememberOrigin(req)
    const url = parseUrl(req)
    const params = url.searchParams

    const sessionId = queryString(params, ['session', 'sessionId'])
    const turnId = queryString(params, ['turn', 'turnId'])
    if (turnId === '') {
      json(res, 400, { ok: false, pending: false, error: 'turn-required' })
      return
    }

    const entry = ledger.get(sessionId, turnId)
    if (entry !== undefined && entry.result !== null) {
      json(res, 200, entry.result)
      return
    }

    // Lazily create a baseline so this still works if no POST and no host
    // observer ever reported the turn: a later read of the same turn can then
    // still produce a measured delta instead of nothing.
    //
    // The sample is NOT forced here, deliberately. This route is polled, and a
    // chat page can easily ask about a screenful of historical turns at once —
    // each request would become an upstream call. `force: false` lets the shared
    // cache (and the single in-flight promise) collapse the whole burst into at
    // most one request per TTL.
    const target = entry ?? ledger.open(sessionId, turnId, { synthetic: true })
    if (target.baselinePromise === null) {
      target.baselinePromise = sampleCreditsQuietly({ config, req, force: false })
        .then((snapshot) => {
          target.baseline = snapshot
          return snapshot
        })
    }

    // An estimate needs tokens. The browser may supply them (it can derive the
    // turn's own usage), in which case the answer is immediate and honest about
    // being an estimate rather than waiting for a delta that may never come.
    const tokenUsage = tokenUsageFromQuery(params)
    const model = queryString(params, ['model'])
    if (tokenUsage !== null) {
      const effectiveModel = model !== '' ? model : target.model
      const estimate = estimateCredits(tokenUsage, effectiveModel, config)
      const cachedTotal = creditsCache.value !== null && Number.isFinite(creditsCache.value.total)
        ? creditsCache.value.total
        : null
      const result = {
        ok: true,
        sessionId,
        turnId,
        creditsSpent: estimate.credits,
        remaining: cachedTotal,
        remainingSource: cachedTotal === null ? 'unavailable' : 'cache',
        measured: false,
        source: 'estimate',
        reason: entry === undefined ? 'client-estimate' : 'estimated',
        tokenUsage,
        model: effectiveModel === '' ? null : effectiveModel,
        creditMultiplier: estimate.multiplier,
        creditMultiplierSource: estimate.multiplierSource,
        atMs: Date.now(),
        estimate: {
          tokens: estimate.tokens,
          weightedTokens: roundCredits(estimate.weightedTokens),
          basis: estimate.basis,
          multiplier: estimate.multiplier,
        },
      }
      target.result = result
      target.status = 'done'
      ledger.set(target)
      json(res, 200, result)
      return
    }

    json(res, 200, {
      ok: false,
      pending: true,
      sessionId,
      turnId,
      atMs: Date.now(),
      sessionEvents: observer.available,
      ...queryNumber(params, ['sinceMs']) === undefined
        ? {}
        : { sinceMs: queryNumber(params, ['sinceMs']) },
    })
  } catch {
    json(res, 200, { ok: false, pending: true, error: 'internal-error' })
  }
}

/**
 * Build a token-usage record from query parameters, or `null` when absent.
 *
 * Accepts either the five named buckets (`input`, `cacheRead`, `cacheWrite`,
 * `output`, `reasoning`) or a single billable `tokens` total, which is charged
 * as plain input.
 */
function tokenUsageFromQuery(params) {
  const named = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']
  const usage = emptyTokenUsage()
  let found = false
  for (const key of named) {
    const value = queryNumber(params, [key, `${key}Tokens`])
    if (value !== undefined) {
      usage[key] = value
      found = true
    }
  }
  if (found) return usage
  const total = queryNumber(params, ['tokens', 'totalTokens'])
  if (total === undefined) return null
  usage.input = total
  return usage
}

/**
 * `POST /turn/begin` — the optional fallback: record this turn's baseline.
 *
 * Kept because a host that mounts this plugin without a usable `ctx.on` (a test
 * harness, an embedding without the session service) can still be driven by the
 * browser. It is deliberately harmless when never called: it only writes a
 * ledger entry, and `GET /turn` creates the same entry lazily anyway.
 */
async function handleTurnBegin(req, res) {
  try {
    const body = await readJsonBody(req)
    if (body === null) {
      json(res, 400, { ok: false, error: 'invalid-body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const turnId = typeof body.turnId === 'string' ? body.turnId : (typeof body.turn === 'string' ? body.turn : '')
    if (turnId === '') {
      json(res, 400, { ok: false, error: 'turn-required' })
      return
    }
    const config = currentConfig()
    const entry = ledger.open(sessionId, turnId)
    if (entry.baselinePromise === null) {
      entry.baselinePromise = sampleCreditsQuietly({ config, req, force: true })
        .then((snapshot) => {
          entry.baseline = snapshot
          return snapshot
        })
    }
    const baseline = await withTimeout(entry.baselinePromise, BASELINE_AWAIT_MS)
    entry.baseline = baseline
    json(res, 200, {
      ok: true,
      turnId,
      sessionId,
      baseline: baseline === null ? null : { total: baseline.total, atMs: baseline.atMs },
      measuredAvailable: baseline !== null,
      atMs: Date.now(),
    })
  } catch {
    json(res, 200, { ok: false, error: 'internal-error' })
  }
}

/**
 * `POST /turn/end` — the optional fallback: close a turn and answer its delta.
 *
 * Same contract as the observer path: `measured` is true only for a trusted
 * balance delta, and the estimate carries `measured: false`.
 */
async function handleTurnEnd(req, res) {
  try {
    const body = await readJsonBody(req)
    if (body === null) {
      json(res, 400, { ok: false, error: 'invalid-body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const turnId = typeof body.turnId === 'string' ? body.turnId : (typeof body.turn === 'string' ? body.turn : '')
    if (turnId === '') {
      json(res, 400, { ok: false, error: 'turn-required' })
      return
    }
    const config = currentConfig()
    const entry = ledger.open(sessionId, turnId)

    if (body.tokenUsage !== null && typeof body.tokenUsage === 'object') {
      addTokenUsage(entry.tokens, normalizeTokenUsage(body.tokenUsage))
    }
    if (typeof body.model === 'string' && body.model !== '') entry.model = body.model

    if (entry.baselinePromise === null) {
      entry.baselinePromise = sampleCreditsQuietly({ config, req })
        .then((snapshot) => {
          entry.baseline = snapshot
          return snapshot
        })
    }
    if (entry.baseline === null) {
      entry.baseline = await withTimeout(entry.baselinePromise, BASELINE_AWAIT_MS)
    }
    entry.status = 'closing'
    await finalizeTurn(entry, config)
    json(res, 200, entry.result ?? { ok: false, pending: true, turnId, sessionId, atMs: Date.now() })
  } catch {
    json(res, 200, { ok: false, error: 'internal-error', atMs: Date.now() })
  }
}

/** `GET /health` — what is wired right now, for diagnosing a blank footer. */
function handleHealth(req, res) {
  try {
    const config = currentConfig()
    json(res, 200, {
      ok: true,
      plugin: name,
      enabled: config.enabled !== false,
      region: config.region,
      sessionEvents: observer.available,
      sessionEventsSeen: observer.seen,
      lastSessionEventAtMs: observer.lastAtMs === 0 ? null : observer.lastAtMs,
      ledgerSize: ledger.size,
      ledgerCapacity: LEDGER_CAPACITY,
      creditsCached: creditsCache.value !== null,
      creditsCachedAtMs: creditsCache.value === null ? null : creditsCache.atMs,
      creditsOrigin: creditsCache.origin === '' ? null : creditsCache.origin,
      originKnown: rememberedOrigin !== '',
      refreshSeconds: config.refreshSeconds,
      priceBasis: Number.isFinite(Number(config.priceBasis)) ? Number(config.priceBasis) : PRICE_BASIS,
      modelCatalogSize: Object.keys(catalogOf(config)).length,
      // The provider order as implemented, so a blank footer can be diagnosed
      // without reading this file.
      providers: CREDIT_PROVIDERS.map((provider) => provider.id),
      creditsProvider: creditsCache.provider === '' ? null : creditsCache.provider,
      tokenWeights: { ...TOKEN_WEIGHTS },
      // Which cache-inclusion rule THIS RUNNING PROCESS was built with.
      //
      // A plugin installed as a link edits its source on disk while the host
      // keeps the module it imported at boot, so a fixed file and a running
      // process can disagree silently for hours. That happened here: a
      // cache-double-counting bug was fixed on disk while the live process kept
      // reporting 10.5x-high numbers, and there was no way to tell from the
      // outside which build was answering. Exposing the rule makes the
      // disagreement visible instead of looking like a bad fix.
      cacheSemantics: {
        ledgerCacheIncludedInInput: LEDGER_CACHE_INCLUDED_IN_INPUT,
        sessionCacheIncludedInInput: SESSION_CACHE_INCLUDED_IN_INPUT,
        // Bumped whenever the token arithmetic changes, so a caller can compare
        // this against the package version it expects.
        arithmeticRevision: 2,
      },
      // Recent ledger keys, so a blank footer can be diagnosed without a
      // devtools session: `?session=` must name the same session id the host
      // reported on `session/event`, or `GET /turn` cannot find the record.
      // Ids are safe to expose here — they are already in the URL bar.
      recentLedgerKeys: ledger.recentKeys(8),
      atMs: Date.now(),
    })
  } catch {
    json(res, 200, { ok: false, error: 'internal-error' })
  }
}

/** Record the origin this request arrived on, for the detached observer. */
function rememberOrigin(req) {
  try {
    const origin = originFromRequest(req)
    if (origin !== undefined) rememberedOrigin = origin
  } catch { /* an unusable origin just leaves the previous one in place */ }
}

/** Reject a wrong method with a JSON 405 rather than letting it fall through. */
function methodNotAllowed(res) {
  json(res, 405, { ok: false, error: 'method-not-allowed' })
}

//#endregion

//#region plugin entry

/**
 * Mount the plugin.
 *
 * The routes are registered through `ctx.inject(['webServer'], …)` so that a
 * Desktop host whose web server comes up after this plugin still gets them —
 * and so that a headless host simply never mounts them. The session observer is
 * attached unconditionally because it needs no service at all.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - validated settings.
 */
export function apply(ctx, config) {
  configRef = config ?? null

  // 1. Turn boundaries, from the host's own event stream. No service required.
  attachSessionObserver(ctx)

  // NOTE: there is deliberately no settings-registration call here.
  //
  // The `settings` service builds its card by reading `entry.fiber.runtime.Config`
  // off each Loader entry (see `SettingsForms#describe` / `schema(entry)`), i.e.
  // it discovers the exported `Config` schema by itself. There is no
  // `register`/`installSection` seam to call, and calling a plausible-looking
  // one would be dead code that silently does nothing. Exporting `Config` above
  // IS the registration.

  // 2. HTTP routes, only where a web server exists.
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const registrations = []
      const register = (path, handler, label) => {
        try {
          const dispose = webCtx.webServer.register({ kind: 'exact', path, handler })
          registrations.push([label, dispose])
        } catch { /* one route failing must not cost the others */ }
      }

      register(CREDITS_ROUTE, (req, res) => {
        if (req?.method !== 'GET') return methodNotAllowed(res)
        if (!requireLoopback(req, res)) return undefined
        return handleCredits(req, res)
      }, 'credits')

      register(TURN_ROUTE, (req, res) => {
        if (req?.method !== 'GET') return methodNotAllowed(res)
        if (!requireLoopback(req, res)) return undefined
        return handleTurn(req, res)
      }, 'turn')

      register(TURN_BEGIN_ROUTE, (req, res) => {
        if (req?.method !== 'POST') return methodNotAllowed(res)
        if (!requireLoopback(req, res)) return undefined
        return handleTurnBegin(req, res)
      }, 'turn-begin')

      register(TURN_END_ROUTE, (req, res) => {
        if (req?.method !== 'POST') return methodNotAllowed(res)
        if (!requireLoopback(req, res)) return undefined
        return handleTurnEnd(req, res)
      }, 'turn-end')

      register(HEALTH_ROUTE, (req, res) => {
        if (req?.method !== 'GET') return methodNotAllowed(res)
        if (!requireLoopback(req, res)) return undefined
        return handleHealth(req, res)
      }, 'health')

      /**
       * Route teardown.
       *
       * Registration itself is done ABOVE, directly, rather than inside an
       * `effect` body. Doing the work inside `ctx.effect` looks tidier but ties
       * the very existence of the routes to that API: a host (or an embedding)
       * that injects `webServer` but does not expose `ctx.effect` would register
       * nothing at all, silently. The effect exists only to own the disposers,
       * so its absence degrades to "routes are not auto-removed on unload"
       * instead of "there are no routes".
       */
      const disposeAll = () => {
        for (const [label, dispose] of registrations.reverse()) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            warn(ctx, `route "${label}" failed to dispose`)
          }
        }
      }
      try {
        if (typeof webCtx.effect === 'function') {
          webCtx.effect(() => disposeAll, 'dsh-workbuddy-billing: web routes')
        }
      } catch { /* registration already succeeded; only teardown is affected */ }
    })
  } catch { /* a host without a web server keeps the observer */ }
}

/** Warn once, with a structured message and no payload data. */
function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`dsh-workbuddy-billing: ${message}`)
  } catch { /* logging must never be the thing that fails */ }
}

//#endregion

export { MODEL_CREDIT_MULTIPLIERS, PRICE_BASIS, TurnLedger }
