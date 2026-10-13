/**
 * dsh-workbuddy-cooldown — host half.
 *
 * Turns WorkBuddy 429s into a cooldown view: which model is rate-limited, and
 * until when it can be used again.
 *
 * Where the data comes from
 * -------------------------
 * The WorkBuddy upstream's `429` has two distinct shapes, and only one carries
 * a cooldown date:
 *
 *   - `code 6004` — that MODEL's usage is exhausted. Its message says
 *     「将在 YYYY-MM-DD HH:MM:SS UTC+8 重置」, a real wall-clock time.
 *   - plain `429` — account-level soft rate limit; no time is given, so the
 *     convention (from the wb2api gateway's own config) is a 600s base with
 *     2× backoff per consecutive hit, capped at 2h.
 *
 * DSH's workbuddy plugin talks to the upstream DIRECTLY with the desktop app's
 * credential, and it discards both the response headers and any record of the
 * failure — `classifyUpstreamError` only labels the answer `soft_rate` and the
 * error is then forwarded to the session, gone. So the raw 429 answer exists in
 * exactly one place: inside that plugin, at the moment it happens.
 *
 * A `pnpm patch` on `dsh-workbuddy-connect` therefore appends every 429 to
 * `$DSH_HOME/.workbuddy-429-log.jsonl` (see the patched `recordRateLimit` in
 * `host-heartbeat-*.js`). THIS half reads that log, turns entries into cooldown
 * windows, and serves the aggregated view to the browser half.
 *
 * Cooldown semantics
 * ------------------
 * - A 429 whose body carries a reset wall clock (「将在 … 重置」, parsed by
 *   `parseResetTime`) cools that model until exactly then.
 * - Any other 429 cools it for a base window with 2× backoff per consecutive
 *   hit, capped — mirroring what the upstream's own tooling does, because the
 *   account's real window is not observable from outside.
 * - Success clears the cooldown: the log cannot say that (absence of 429s is
 *   not evidence of recovery), so a soft cooldown is treated as expired once
 *   its window passes, and a `success` line written by the patch clears it
 *   early when the plugin can see one.
 *
 * @module dsh-workbuddy-cooldown
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Route the browser half reads the aggregated cooldown view from. */
export const STATUS_PATH = '/plugins/dsh-workbuddy-cooldown/state'

/**
 * Resolve the Harness home without a kernel dependency.
 *
 * `@deepseek-ai/dsh-home-paths` would be the canonical source, but it is a peer
 * dependency the Host provides, and keeping this package importable standalone
 * (for tests and for the wb2api-style tooling around it) is worth more than the
 * indirection: the launcher exports `DSH_HOME` into every profile process, and
 * falls back to `~/.dsh` exactly like this does.
 *
 * @returns absolute path of the Harness home directory.
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  const profile = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(profile, '.dsh')
}

/** Basename of the 429 log the patched workbuddy plugin appends to. */
const RATE_LIMIT_LOG_BASENAME = '.workbuddy-429-log.jsonl'
/** Basename of the success log the patched workbuddy plugin appends to. */
const SUCCESS_LOG_BASENAME = '.workbuddy-success-log.jsonl'

/** Soft-cooldown base window for a 429 with no reset wall clock. */
const SOFT_COOLDOWN_BASE_MS = 600_000
/** Soft-cooldown cap. */
const SOFT_COOLDOWN_MAX_MS = 2 * 60 * 60 * 1000
/** How long after its last 429 a model stays on the cooldown list. */
const COOLDOWN_MEMORY_MS = 24 * 60 * 60 * 1000
/** How long a panel/log answer stays trustworthy. */
const STATE_TTL_MS = 5_000

/** Map the panel realm to the DSH provider id that serves it. */
export const REALM_TO_PROVIDER = { cn: 'workbuddy', global: 'workbuddy-ai' }

/**
 * Extract the upstream's reset wall clock from a 429 body.
 *
 * The message reads 「将在 YYYY-MM-DD HH:MM:SS UTC+8 重置」. Real samples also
 * carry milliseconds — 「将在 2026-10-13 16:05:58.108 UTC+8 重置」 — so the
 * seconds group must not assume the timestamp ends there. The wall clock is
 * explicitly UTC+8 and is parsed in that zone regardless of the local one.
 *
 * @param body - the upstream response body excerpt.
 * @returns epoch milliseconds of the reset, or `undefined` when absent.
 */
export function parseResetTime(body) {
  if (typeof body !== 'string' || body === '') return undefined
  const match = /将在\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*UTC\+8/.exec(body)
  if (match === null) return undefined
  // Construct the timestamp as if the wall clock were UTC, then subtract 8h to
  // get the true epoch: "2026-10-14 02:00:00 UTC+8" === 2026-10-13T18:00:00Z.
  // Fractional seconds are kept: Date.parse accepts them on the T-form.
  const asUtc = Date.parse(`${match[1].replace(' ', 'T')}Z`)
  if (!Number.isFinite(asUtc)) return undefined
  return asUtc - 8 * 60 * 60 * 1000
}

/**
 * Read one JSONL log, newest last, tolerating a missing or torn file.
 *
 * A torn trailing line (the patch appends with a plain append, which can be
 * interrupted) is dropped rather than failing the whole read.
 *
 * @param path - the log file path.
 * @param limit - at most this many trailing lines are parsed.
 * @returns parsed entries, oldest first.
 */
function readJsonl(path, limit = 4000) {
  if (!existsSync(path)) return []
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  const out = []
  for (const line of lines.slice(-limit)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) out.push(parsed)
    } catch {
      // Torn tail or garbage line: skip it, keep the rest.
    }
  }
  return out
}

/** The 429 log path. */
function rateLimitLogPath() {
  return join(resolveDshHome(), RATE_LIMIT_LOG_BASENAME)
}

/** The success log path. */
function successLogPath() {
  return join(resolveDshHome(), SUCCESS_LOG_BASENAME)
}

/**
 * Aggregate the 429 log into per-model cooldown windows.
 *
 * Realm is part of the key because the two endpoints share model ids and never
 * state: a `cn` lock must not annotate the same id on `workbuddy-ai`.
 *
 * @param now - reference time for windows and expiry.
 * @returns the cooldown map and the entry count scanned.
 */
export function aggregateCooldowns(now = Date.now()) {
  const entries = readJsonl(rateLimitLogPath())
  const cooldowns = new Map()
  let lastSuccessMs = 0
  if (existsSync(successLogPath())) {
    try {
      lastSuccessMs = statSync(successLogPath()).mtimeMs
    } catch {
      lastSuccessMs = 0
    }
  }
  for (const entry of entries) {
    const realm = entry.realm === 'global' ? 'global' : 'cn'
    const model = typeof entry.model === 'string' ? entry.model : ''
    if (model === '') continue
    const key = `${realm}\u0000${model}`
    const time = typeof entry.time === 'number' ? entry.time : 0
    if (time <= 0 || now - time > COOLDOWN_MEMORY_MS) continue
    const previous = cooldowns.get(key)
    const hits = (previous?.hits ?? 0) + 1
    // A reset wall clock replaces any estimated window — but only a FUTURE one.
    // A parsed reset in the past means either the clock drifted, the regex read
    // something that was not a UTC+8 wall clock, or the window has genuinely
    // rolled over. Silently dropping the entry would make a cooling model vanish
    // from the view (the exact bug this plugin exists to fix), so a stale or
    // bogus reset falls back to the estimated window instead.
    const resetMs = parseResetTime(entry.body)
    const resetUsable = resetMs !== undefined && resetMs > now
    const untilMs = resetUsable
      ? resetMs
      : Math.min(time + Math.min(SOFT_COOLDOWN_BASE_MS * 2 ** (hits - 1), SOFT_COOLDOWN_MAX_MS), now + SOFT_COOLDOWN_MAX_MS)
    cooldowns.set(key, {
      realm,
      model,
      hits,
      firstMs: previous?.firstMs ?? time,
      lastMs: time,
      untilMs: Math.max(untilMs, previous?.untilMs ?? 0) || untilMs,
      lastBody: typeof entry.body === 'string' ? entry.body.slice(0, 300) : '',
      modelLevel: resetUsable || (previous?.modelLevel ?? false),
      resetBogus: resetMs !== undefined && !resetUsable,
    })
  }
  // A success clears cooldowns — precisely, per model: the patch logs which
  // model answered 200, and a 200 on THAT model is the only evidence that its
  // quota window has ended (a 6004 lock cannot be re-tested while it holds, so
  // its own next success is the recovery signal). A success on a different
  // model says nothing about this one and clears nothing.
  const successes = readJsonl(successLogPath(), 500)
  const succeededKeys = new Set(
    successes
      .filter((entry) => typeof entry.model === 'string' && entry.model !== '')
      .map((entry) => `${entry.realm === 'global' ? 'global' : 'cn'}\u0000${entry.model}`),
  )
  for (const [key, cooldown] of [...cooldowns]) {
    if (succeededKeys.has(key) && lastSuccessMs > cooldown.lastMs) cooldowns.delete(key)
  }
  return { cooldowns, scanned: entries.length, lastSuccessMs }
}

/**
 * The aggregated view the browser half renders.
 *
 * @param now - reference time.
 * @returns the cooldown view document.
 */
export function buildCooldownView(now = Date.now()) {
  const { cooldowns, scanned, lastSuccessMs } = aggregateCooldowns(now)
  const locks = [...cooldowns.values()]
    .filter((c) => c.untilMs > now)
    .sort((a, b) => a.untilMs - b.untilMs)
    .map((c) => ({
      realm: c.realm,
      provider: REALM_TO_PROVIDER[c.realm] ?? c.realm,
      model: c.model,
      hits: c.hits,
      modelLevel: c.modelLevel,
      untilMs: c.untilMs,
      remainingMs: c.untilMs - now,
      firstMs: c.firstMs,
      lastMs: c.lastMs,
      reason: c.lastBody,
    }))
  return {
    fetchedAtMs: now,
    scanned,
    lastSuccessMs: lastSuccessMs || undefined,
    modelLocks: locks,
    coolingModels: locks.length,
  }
}

/**
 * The panel-free reader: no network, no key, just the local log files.
 *
 * Kept as a class only so the shape matches the previous PanelReader contract
 * the route handler was written against; a cooldown monitor over local files
 * has no async failure mode worth abstracting.
 */
export class CooldownReader {
  /** @param options - `{ ttlMs }` overrides for tests. */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? STATE_TTL_MS
    this.cached = undefined
    this.cachedAt = 0
  }

  /**
   * Read the aggregated view, cached briefly so bursts of card refreshes do not
   * rescan the log each time.
   *
   * @param now - reference time.
   * @returns the cooldown view document.
   */
  read(now = Date.now()) {
    if (this.cached !== undefined && now - this.cachedAt < this.ttlMs) return this.cached
    this.cached = buildCooldownView(now)
    this.cachedAt = now
    return this.cached
  }

  /** Drop the cache so the next read rescans the log. */
  invalidate() {
    this.cached = undefined
    this.cachedAt = 0
  }
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
 * Register the plugin against a Host context.
 *
 * No `Config` schema is declared on purpose: the row config is then a plain
 * object, which keeps schemastery out of the dependency list.
 *
 * @param ctx - Host plugin context.
 * @param config - row config: `{ stateTtlMs? }`.
 */
export function apply(ctx, config = {}) {
  const reader = new CooldownReader({
    ttlMs: typeof config.stateTtlMs === 'number' && config.stateTtlMs >= 0 ? config.stateTtlMs : undefined,
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
            json(res, 200, reader.read())
          } catch (error) {
            json(res, 500, {
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
