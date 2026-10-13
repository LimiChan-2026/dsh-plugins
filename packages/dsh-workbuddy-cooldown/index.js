/**
 * dsh-workbuddy-cooldown — host half.
 *
 * Bridges the wb2api account-pool panel's rate-limit state into the Harness.
 *
 * Where the data comes from
 * -------------------------
 * The WorkBuddy upstream's `429` has two distinct shapes, and only one carries
 * a cooldown date:
 *
 *   - `code 6004` — that MODEL's usage is exhausted. Its message says
 *     「将在 YYYY-MM-DD HH:MM:SS UTC+8 重置」, which is a real wall-clock time.
 *   - plain `429` — account-level soft rate limit; no time given, so the
 *     gateway backoff-exponentiates from `cooldown.soft_rate` (600s), capped
 *     at `soft_rate_max` (2h).
 *
 * The wb2api gateway (`wb2api.exe`, default `127.0.0.1:7863`) already classifies
 * both, cools accounts accordingly, and aggregates the per-model view on its
 * `/status` document as `model_locks`. It is the authoritative source, so this
 * plugin reads it rather than re-deriving anything.
 *
 * Why the panel and not DSH's own traffic: the WorkBuddy desktop credential
 * DSH signs in with is one of the accounts in that pool, and the panel watches
 * all of them — including 429s that fire while DSH is idle. Reading it covers
 * the whole pool instead of just what DSH happened to trigger.
 *
 * Why the host proxies rather than the browser fetching the panel directly:
 * the panel sends no CORS headers, and the Web UI origin (19387) differs from
 * the panel's (7863), so a browser fetch is blocked. Node fetch is not.
 *
 * @module dsh-workbuddy-cooldown
 */

/** Route the browser half reads the aggregated cooldown view from. */
export const STATUS_PATH = '/plugins/dsh-workbuddy-cooldown/state'

/** Panel base URL; loopback only, matching the gateway's own default listen. */
const PANEL_BASE = 'http://127.0.0.1:7863'
/** How long a panel answer stays trustworthy before a fresh one is needed. */
const PANEL_TTL_MS = 15_000
/** Upstream chat timeout for the panel request itself. */
const PANEL_TIMEOUT_MS = 5_000

/** Map the panel's realm to the DSH provider id that serves it. */
const REALM_TO_PROVIDER = { cn: 'workbuddy', global: 'workbuddy-ai' }

/**
 * Normalize one panel account into the fields this plugin cares about.
 *
 * The panel's zero-time for "not cooling" is Go's zero value
 * (`0001-01-01T00:00:00Z`), which must be read as *absent*, not as a date in
 * the past — treating it literally would make every account look expired.
 *
 * @param account - one entry of the panel's `accounts` array.
 * @returns the normalized view, or `undefined` for unusable entries.
 */
function normalizeAccount(account) {
  if (typeof account !== 'object' || account === null) return undefined
  const uid = typeof account.uid === 'string' ? account.uid : ''
  if (uid === '') return undefined
  const untilMs = cooldownUntilMs(account.until)
  return {
    uid,
    nickname: typeof account.nickname === 'string' ? account.nickname : '',
    realm: account.realm === 'global' ? 'global' : 'cn',
    cooling: account.cooling === true,
    untilMs,
    coolKind: typeof account.cool_kind === 'number' ? account.cool_kind : 0,
    disabled: account.disabled === true,
    breakerUntilMs: cooldownUntilMs(account.breaker_until),
    degradeUntilMs: cooldownUntilMs(account.degrade_until),
    lastErr: typeof account.last_err === 'string' ? account.last_err : '',
  }
}

/**
 * Parse a panel timestamp into epoch ms, reading Go's zero value as absent.
 *
 * @param value - an ISO timestamp string, or anything else.
 * @returns epoch milliseconds, or `null` when the value means "no deadline".
 */
function cooldownUntilMs(value) {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  // Go's zero time. Anything older than "recent" is a sentinel, not a deadline;
  // comparing against a year keeps this independent of the machine's clock.
  if (ms < Date.UTC(2000, 0, 1)) return null
  return ms
}

/**
 * Normalize the panel's `model_locks` aggregation.
 *
 * The shape is documented but was never observed populated on this machine
 * (no model was rate-limited while building), so every field is defensive and
 * unknown entries are carried through rather than dropped — a monitor that
 * hides data it does not understand would hide exactly the interesting case.
 *
 * @param locks - the panel's `model_locks` value.
 * @returns a list of per-model lock views.
 */
function normalizeModelLocks(locks) {
  if (!Array.isArray(locks)) return []
  return locks
    .filter((lock) => typeof lock === 'object' && lock !== null)
    .map((lock) => ({
      realm: lock.realm ?? lock.domain ?? '',
      model: typeof lock.model === 'string' ? lock.model : '',
      available: typeof lock.available === 'number' ? lock.available : undefined,
      total: typeof lock.total === 'number' ? lock.total : undefined,
      lockedAccounts: typeof lock.locked_accounts === 'number' ? lock.locked_accounts : undefined,
      state: typeof lock.state === 'string' ? lock.state : '',
      earliestUnlockMs: cooldownUntilMs(lock.earliest_unlock ?? lock.earliestUnlock),
      fullPoolUnlockMs: cooldownUntilMs(lock.full_pool_unlock ?? lock.fullPoolUnlock),
      reason: typeof lock.reason === 'string' ? lock.reason : '',
      raw: lock,
    }))
    .filter((lock) => lock.model !== '')
}

/** Reply with JSON and an explicit length. */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Whether an Origin header names a loopback origin. */
function originIsLoopback(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const host = new URL(origin).host.replace(/:\d+$/, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * The panel reader.
 *
 * Answers are cached for `PANEL_TTL_MS` because the card refreshes on focus and
 * on a timer, and hammering the gateway's status endpoint from several windows
 * buys nothing: the panel itself refreshes balances on its own schedule.
 */
export class PanelReader {
  /** @param options - `{ baseUrl, apiKey, timeoutMs, ttlMs }` overrides for tests. */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? PANEL_BASE
    this.apiKey = options.apiKey ?? ''
    this.timeoutMs = options.timeoutMs ?? PANEL_TIMEOUT_MS
    this.ttlMs = options.ttlMs ?? PANEL_TTL_MS
    this.cached = undefined
    this.cachedAt = 0
    this.inflight = undefined
  }

  /**
   * Read and normalize the panel status.
   *
   * A failed read is reported rather than swallowed: a monitor that pretended
   * "nothing is cooling" after losing its source would be a lie, and the card
   * shows the failure instead.
   *
   * @param now - reference time for the cache window.
   * @returns the normalized cooldown view.
   */
  async read(now = Date.now()) {
    if (this.cached !== undefined && now - this.cachedAt < this.ttlMs) return this.cached
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchPanel()
      .then((view) => {
        this.cached = view
        this.cachedAt = Date.now()
        return view
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Fetch one panel status document and shape it. */
  async fetchPanel() {
    const headers = { Accept: 'application/json' }
    if (this.apiKey !== '') headers.Authorization = `Bearer ${this.apiKey}`
    const response = await fetch(`${this.baseUrl}/status`, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`panel ${this.baseUrl}/status answered HTTP ${response.status}`)
    const body = await response.json()
    if (typeof body !== 'object' || body === null) throw new Error('panel status is not an object')
    const accounts = Array.isArray(body.accounts) ? body.accounts.map(normalizeAccount).filter((a) => a !== undefined) : []
    const cooling = accounts.filter((a) => a.cooling && !a.disabled)
    return {
      fetchedAtMs: Date.now(),
      reachable: true,
      panelTotal: accounts.length,
      healthy: typeof body.healthy === 'number' ? body.healthy : undefined,
      coolingAccounts: cooling.length,
      accounts,
      modelLocks: normalizeModelLocks(body.model_locks),
    }
  }

  /** Drop the cache so the next read goes to the panel. */
  invalidate() {
    this.cached = undefined
    this.cachedAt = 0
  }
}

/**
 * Register the plugin against a Host context.
 *
 * No `Config` schema is declared on purpose: the row config is then a plain
 * object, which keeps schemastery out of the dependency list. The panel key is
 * set from the user's own profile patch layer rather than the bundle, so it is
 * never committed to a public repository.
 *
 * ```yaml
 * - id: workbuddy-cooldown
 *   config:
 *     panelApiKey: <the wb2api api_key>
 * ```
 *
 * @param ctx - Host plugin context.
 * @param config - row config: `{ panelApiKey?, panelBaseUrl? }`.
 */
export function apply(ctx, config = {}) {
  const reader = new PanelReader({
    apiKey: typeof config.panelApiKey === 'string' ? config.panelApiKey : '',
    baseUrl: typeof config.panelBaseUrl === 'string' && config.panelBaseUrl !== '' ? config.panelBaseUrl : undefined,
    ttlMs: typeof config.panelTtlMs === 'number' && config.panelTtlMs >= 0 ? config.panelTtlMs : undefined,
  })

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' })
            return
          }
          if (!originIsLoopback(req.headers.origin)) {
            json(res, 403, { error: 'request-not-trusted' })
            return
          }
          try {
            json(res, 200, await reader.read())
          } catch (error) {
            json(res, 502, {
              reachable: false,
              error: error instanceof Error ? error.message : String(error),
              fetchedAtMs: Date.now(),
            })
          }
        },
      })
      return () => dispose()
    }, 'dsh-workbuddy-cooldown: state route')
  })
}
