/**
 * dsh-model-lock — host half.
 *
 * Owns the lock table (which `provider/model` pairs the user has locked, and
 * until when) and exposes it to the browser half over two loopback routes.
 * The filtering itself happens in `client.js`, because the only seam that
 * covers BOTH model pickers (the composer seat and the `/model` popup) is the
 * client-side `modelDirectories` service.
 *
 * Why the table lives host-side instead of in `localStorage`:
 *
 *   - It is one profile's preference, not one browser's. The desktop app and a
 *     remote Web UI pointed at the same profile must agree on what is locked.
 *   - The management card needs a model list to lock from, and the Host
 *     already owns the authoritative one through `ctx.llm`. A root-scoped card
 *     has no session, so it cannot read the per-session client directory.
 *
 * The file is a version-tagged document written atomically, following the same
 * shape the other profile-side stores use: a corrupt or unreadable file reads
 * as "nothing locked", which only ever shows models the user could already
 * pick. A failed *write* propagates, so the card can report a lock that did
 * not persist instead of pretending it took.
 *
 * @module dsh-model-lock
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** On-disk format this reader accepts; other versions are discarded. */
const LOCK_FORMAT_VERSION = 1
/** Basename of the lock document inside the Harness home. */
const LOCK_FILENAME = '.dsh-model-lock.json'
/** Route the browser half reads the table from. */
const STATE_PATH = '/plugins/dsh-model-lock/state'
/** Route the browser half writes locks through. */
const LOCK_PATH = '/plugins/dsh-model-lock/lock'

/**
 * Resolve the Harness home without depending on a host service.
 *
 * `DSH_HOME` is exported into every profile-launched process; the `~/.dsh`
 * fallback matches the launcher's own default for the cases where it is not.
 *
 * @returns absolute path of the Harness home directory.
 */
function resolveHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  const profile = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(profile, '.dsh')
}

/** Absolute path of the lock document. */
function lockFilePath() {
  return join(resolveHome(), LOCK_FILENAME)
}

/** Whether a parsed value is a lock entry this reader can trust. */
function isLock(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (typeof value.provider !== 'string' || value.provider === '') return false
  if (typeof value.model !== 'string' || value.model === '') return false
  if (typeof value.lockedAtMs !== 'number' || !Number.isFinite(value.lockedAtMs)) return false
  if (value.untilMs !== null && (typeof value.untilMs !== 'number' || !Number.isFinite(value.untilMs))) return false
  return true
}

/**
 * The lock table: a list of `{ provider, model, untilMs, lockedAtMs }`.
 *
 * `untilMs === null` means "until I unlock it". An entry whose `untilMs` has
 * passed is expired: it is reported as absent and dropped on the next write,
 * so a temporary lock needs no timer to stop applying.
 */
class LockStore {
  /** @param options - `{ path }` override, or a path string. Used by tests. */
  constructor(options = {}) {
    this.path = typeof options === 'string' ? options : options.path ?? lockFilePath()
    this.cached = undefined
  }

  /** Resolved state-file path, for diagnostics. */
  filePath() {
    return this.path
  }

  /**
   * Read the document, tolerating a missing or malformed file.
   *
   * The parsed table is cached, but the cache is keyed on the file's
   * modification time and size: this profile can be served by more than one
   * Harness process (the desktop app plus a remote Web UI), and the file can
   * also be edited by hand. A cache that ignored that would answer from a table
   * some other writer had already replaced.
   */
  load() {
    const stamp = this.stamp()
    if (this.cached !== undefined && this.cachedStamp === stamp) return this.cached
    let locks = []
    if (stamp !== undefined) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
        const raw = parsed?.version === LOCK_FORMAT_VERSION ? parsed.locks : undefined
        if (Array.isArray(raw)) locks = raw.filter(isLock)
      } catch {
        // A corrupt file is "nothing locked": the safe direction, since it only
        // ever makes models visible that the user could already select.
      }
    }
    this.cached = locks
    this.cachedStamp = stamp
    return locks
  }

  /** Identity of the current file contents, or `undefined` when it is absent. */
  stamp() {
    try {
      const stats = statSync(this.path)
      return `${stats.mtimeMs}:${stats.size}`
    } catch {
      return undefined
    }
  }

  /** Every entry, including one whose deadline has already passed. */
  all() {
    return this.load()
  }

  /** Entries still in force at `now`, i.e. locked with no deadline or a future one. */
  active(now = Date.now()) {
    return this.load().filter((lock) => lock.untilMs === null || lock.untilMs > now)
  }

  /**
   * Replace the table and persist it.
   *
   * Expired entries are dropped here rather than by a timer: any write is a
   * good moment to forget deadlines nobody can still be waiting on.
   *
   * The in-memory table is adopted only after the write succeeds, so a failed
   * write cannot leave this process believing in a lock the file never got.
   *
   * @param locks - the complete next table.
   * @param now - reference time for the expiry sweep.
   */
  replace(locks, now = Date.now()) {
    const next = locks.filter((lock) => lock.untilMs === null || lock.untilMs > now)
    this.persist(next)
    this.cached = next
    this.cachedStamp = this.stamp()
    return next
  }

  /** Write the document atomically, replacing the in-memory table only on success. */
  persist(locks) {
    const directory = dirname(this.path)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const document = { version: LOCK_FORMAT_VERSION, locks }
    const temporary = resolve(`${this.path}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(temporary, this.path)
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

/**
 * Whether a request came from this machine.
 *
 * The Host + Origin check drops DNS-rebinding pages, whose requests arrive
 * addressed to the attacker's domain. It is not authentication — any local
 * process can write `Host: 127.0.0.1` — but a lock write spends nothing and
 * changes only which models a picker offers, so it is proportionate here.
 */
function loopbackName(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  let host = value
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketed !== null) host = bracketed[1]
  else if (value.includes(':')) host = value.slice(0, value.lastIndexOf(':'))
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0'
}

/** Whether an Origin header names a loopback origin. */
function originIsLoopback(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return loopbackName(new URL(origin).host)
  } catch {
    return false
  }
}

/** Largest body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Read the request body with a hard ceiling, or `undefined` when oversized. */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The model catalog the management card renders: every provider route the Host
 * currently serves, with the models it advertises.
 *
 * A provider whose `listModels` throws becomes a `failure` entry rather than
 * failing the whole document, so one broken provider cannot hide the rest of
 * the card. This mirrors how the shipped catalog builder isolates failures.
 *
 * `llm` is read through `ctx.get` rather than as a service on the caller's own
 * scope: this runs from the web-server scope, which does not declare `llm` in
 * its inject list, and Cordis refuses an undeclared service read.
 *
 * @param ctx - Host context able to reach the LLM registry.
 * @returns one entry per provider, in registration order.
 */
async function describeCatalog(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  const providers = llm.listProviders()
  const entries = await Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id)
        return {
          provider: provider.id,
          name: provider.name,
          models: models.map((model) => ({ id: model.id, name: model.name })),
        }
      } catch (error) {
        return {
          provider: provider.id,
          name: provider.name,
          models: [],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
  return entries
}

/** Project one stored lock into the wire shape the card reads. */
function toWire(lock, now) {
  return {
    provider: lock.provider,
    model: lock.model,
    untilMs: lock.untilMs,
    lockedAtMs: lock.lockedAtMs,
    remainingMs: lock.untilMs === null ? null : Math.max(0, lock.untilMs - now),
  }
}

/**
 * Register the plugin against a Host context.
 *
 * `webServer` is optional: without it the plugin still owns the file and the
 * table, it simply has no route to publish them through, and the client half
 * degrades to "nothing locked". Declaring it through `ctx.inject` rather than
 * `inject` keeps the plugin loadable in a profile that has no web server.
 *
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const store = new LockStore()

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' })
            return
          }
          if (!loopbackName(req.headers.host) || !originIsLoopback(req.headers.origin)) {
            json(res, 403, { error: 'request-not-trusted' })
            return
          }
          const now = Date.now()
          try {
            json(res, 200, {
              now,
              locks: store.active(now).map((lock) => toWire(lock, now)),
              catalog: await describeCatalog(ctx),
            })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      return () => dispose()
    }, 'dsh-model-lock: state route')

    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: LOCK_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' })
            return
          }
          if (!loopbackName(req.headers.host) || !originIsLoopback(req.headers.origin)) {
            json(res, 403, { error: 'request-not-trusted' })
            return
          }
          const body = await readBody(req)
          if (body === undefined) {
            json(res, 413, { error: 'body too large' })
            return
          }
          let parsed
          try {
            parsed = JSON.parse(body)
          } catch {
            json(res, 400, { error: 'invalid body' })
            return
          }
          const provider = parsed?.provider
          const model = parsed?.model
          if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
            json(res, 400, { error: 'invalid target' })
            return
          }
          const now = Date.now()
          try {
            const current = store.active(now)
            const rest = current.filter((lock) => !(lock.provider === provider && lock.model === model))
            if (parsed.locked === true) {
              // A missing or non-positive duration means "until I unlock it".
              const durationMs = typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) && parsed.durationMs > 0
                ? parsed.durationMs
                : null
              rest.push({
                provider,
                model,
                untilMs: durationMs === null ? null : now + durationMs,
                lockedAtMs: now,
              })
            }
            const next = store.replace(rest, now)
            json(res, 200, {
              state: 'updated',
              now,
              locks: next.map((lock) => toWire(lock, now)),
            })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      return () => dispose()
    }, 'dsh-model-lock: lock route')
  })
}
