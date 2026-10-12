/**
 * dsh-model-lock host-half integration tests.
 *
 * Runs the REAL `index.js` against a real HTTP server and a real lock file, so
 * the things that can only break in the host half are covered: atomic
 * persistence, the expiry sweep on write, the loopback guard, and the model
 * catalog the card renders.
 *
 * The lock file is redirected with `DSH_HOME`, which is also how the plugin
 * resolves it in production, so this exercises the real path logic rather than
 * a test-only seam.
 *
 * Run: node host-tests.mjs <path-to-index.js>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const indexPath = process.argv[2]
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const home = mkdtempSync(join(tmpdir(), 'dml-home-'))
process.env.DSH_HOME = home

const { apply } = await import(pathToFileURL(indexPath).href)

/* --- fake host context ------------------------------------------------------- */
const routes = new Map()
const effects = []
const providers = [
  { id: 'workbuddy-ai', name: 'WorkBuddy AI' },
  { id: 'command', name: 'command' },
]
const catalogs = {
  'workbuddy-ai': [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
  ],
  command: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
}
let failingProvider = undefined

const llm = {
  listProviders: () => providers,
  listModels: async (provider) => {
    if (provider === failingProvider) throw new Error('upstream exploded')
    return catalogs[provider] ?? []
  },
}

/**
 * The injected scope mirrors Cordis: it carries ONLY the services named in the
 * inject list, plus `effect`. A merged object here would hide the bug where a
 * handler reads a service its own scope does not declare, which is exactly what
 * a real profile did.
 */
const scope = {
  effect: (fn) => {
    const dispose = fn()
    const wrapped = typeof dispose === 'function' ? dispose : () => {}
    effects.push(wrapped)
    return wrapped
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

const ctx = {
  inject: (names, cb) => {
    for (const name of names) {
      if (!(name in scope)) throw new Error(`test scope is missing injected service "${name}"`)
    }
    cb(scope)
  },
  // Cordis resolves a service by name from the context; `llm` is not on the
  // web-server scope, so the plugin must reach it this way.
  get: (name) => (name === 'llm' ? llm : undefined),
}

apply(ctx)

// A scope that leaked llm as an own property would hide the real bug.
check('the injected scope does not expose llm directly', scope.llm === undefined)

check('both routes were registered', routes.has('/plugins/dsh-model-lock/state') && routes.has('/plugins/dsh-model-lock/lock'))

/* --- real HTTP server -------------------------------------------------------- */
const { createServer } = await import('node:http')
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (handler === undefined) {
    res.writeHead(404).end()
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/** Call one route with explicit headers, so the guard can be probed. */
async function call(path, { method = 'GET', body, host, origin } = {}) {
  const headers = {}
  if (host !== undefined) headers.Host = host
  if (origin !== undefined) headers.Origin = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/* --- 1. the state route ------------------------------------------------------ */
const initial = await call('/plugins/dsh-model-lock/state')
check('GET /state answers 200', initial.status === 200, `got ${initial.status}`)
check('an empty pool reports no locks', Array.isArray(initial.body.locks) && initial.body.locks.length === 0)
check('the catalog lists every provider', initial.body.catalog.length === 2)
check(
  'the catalog carries each provider models',
  initial.body.catalog.find((entry) => entry.provider === 'workbuddy-ai').models.length === 2,
)
check('the state carries a server clock for countdowns', typeof initial.body.now === 'number')

/* --- 2. a provider that fails does not break the document ------------------- */
failingProvider = 'command'
const degraded = await call('/plugins/dsh-model-lock/state')
check('a failing provider still answers 200', degraded.status === 200)
check('the failing provider is reported, not hidden', typeof degraded.body.catalog.find((e) => e.provider === 'command').error === 'string')
check('the healthy provider is still listed', degraded.body.catalog.find((e) => e.provider === 'workbuddy-ai').models.length === 2)
failingProvider = undefined

/* --- 3. locking until manual unlock ----------------------------------------- */
const locked = await call('/plugins/dsh-model-lock/lock', {
  method: 'POST',
  body: { provider: 'workbuddy-ai', model: 'gpt-6-astra', locked: true, durationMs: null },
})
check('POST /lock answers 200', locked.status === 200, `got ${locked.status}`)
check('the write reports the new table', locked.body.locks.length === 1)
check('a null duration means no deadline', locked.body.locks[0].untilMs === null)
check('the entry records when it was locked', typeof locked.body.locks[0].lockedAtMs === 'number')

const stateAfter = await call('/plugins/dsh-model-lock/state')
check('the lock is visible on the next read', stateAfter.body.locks.length === 1)
check('the lock names the right target', stateAfter.body.locks[0].model === 'gpt-6-astra')
check('an untimed lock reports no remaining time', stateAfter.body.locks[0].remainingMs === null)

/* --- 4. persistence ---------------------------------------------------------- */
const file = join(home, '.dsh-model-lock.json')
check('the lock file was written', existsSync(file))
const document = JSON.parse(readFileSync(file, 'utf8'))
check('the document is version tagged', document.version === 1)
check('the document holds the entry', document.locks.length === 1)

/* --- 5. a timed lock --------------------------------------------------------- */
const timed = await call('/plugins/dsh-model-lock/lock', {
  method: 'POST',
  body: { provider: 'command', model: 'gpt-6.1-sol', locked: true, durationMs: 60 * 60 * 1000 },
})
const timedEntry = timed.body.locks.find((lock) => lock.provider === 'command')
check('a timed lock gets a deadline', typeof timedEntry.untilMs === 'number')
check('the deadline is in the future', timedEntry.untilMs > Date.now())
check('remaining time is reported', timedEntry.remainingMs > 0 && timedEntry.remainingMs <= 60 * 60 * 1000)

/* --- 6. unlocking ------------------------------------------------------------ */
const unlocked = await call('/plugins/dsh-model-lock/lock', {
  method: 'POST',
  body: { provider: 'workbuddy-ai', model: 'gpt-6-astra', locked: false },
})
check('unlocking removes only that entry', unlocked.body.locks.length === 1 && unlocked.body.locks[0].provider === 'command')

/* --- 7. an expired lock is swept on the next write -------------------------- */
const stale = {
  version: 1,
  locks: [
    { provider: 'shuai', model: 'glm-5.3', untilMs: Date.now() - 10_000, lockedAtMs: Date.now() - 20_000 },
    { provider: 'command', model: 'gpt-6.1-sol', untilMs: null, lockedAtMs: Date.now() - 20_000 },
  ],
}
writeFileSync(file, JSON.stringify(stale))
// A fresh read must still see the stale entry gone from `active`.
const swept = await call('/plugins/dsh-model-lock/state')
check('an expired entry is not reported as active', !swept.body.locks.some((lock) => lock.provider === 'shuai'))
check('the live entry survives the sweep', swept.body.locks.some((lock) => lock.provider === 'command'))

/* --- 8. the loopback guard --------------------------------------------------- */
// `fetch` refuses to send a forged `Host` (it is a forbidden header name), so
// the guard is probed over a raw socket, which is exactly how a DNS-rebinding
// page would reach this server.
async function rawGet(pathname, hostHeader) {
  const { connect } = await import('node:net')
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, '127.0.0.1', () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

const rebound = await rawGet('/plugins/dsh-model-lock/state', 'evil.example.com')
check('a non-loopback Host is refused on read', rebound.includes('403'), rebound.split('\r\n')[0])
const loopbackHost = await rawGet('/plugins/dsh-model-lock/state', '127.0.0.1')
check('a loopback Host is served', loopbackHost.includes('200'), loopbackHost.split('\r\n')[0])
const foreignOrigin = await call('/plugins/dsh-model-lock/lock', {
  method: 'POST',
  host: '127.0.0.1',
  origin: 'http://evil.example.com',
  body: { provider: 'command', model: 'gpt-6.1-sol', locked: true },
})
check('a non-loopback Origin is refused on write', foreignOrigin.status === 403, `got ${foreignOrigin.status}`)
const loopbackOrigin = await call('/plugins/dsh-model-lock/lock', {
  method: 'POST',
  host: '127.0.0.1',
  origin: 'http://127.0.0.1:19387',
  body: { provider: 'command', model: 'gpt-6.1-sol', locked: true, durationMs: null },
})
check('a loopback Origin is accepted', loopbackOrigin.status === 200)

/* --- 9. malformed input ------------------------------------------------------ */
const badMethod = await call('/plugins/dsh-model-lock/lock')
check('GET on the lock route is refused', badMethod.status === 405, `got ${badMethod.status}`)
const badTarget = await call('/plugins/dsh-model-lock/lock', { method: 'POST', body: { provider: '', model: 'x', locked: true } })
check('an empty provider is refused', badTarget.status === 400, `got ${badTarget.status}`)
const badJson = await fetch(`${base}/plugins/dsh-model-lock/lock`, { method: 'POST', headers: { Host: '127.0.0.1' }, body: '{not json' })
check('malformed JSON is refused', badJson.status === 400, `got ${badJson.status}`)
const badDuration = await call('/plugins/dsh-model-lock/lock', {
  method: 'POST',
  body: { provider: 'command', model: 'gpt-6.1-sol', locked: true, durationMs: -5 },
})
check('a negative duration degrades to "until I unlock it"', badDuration.body.locks.find((l) => l.provider === 'command').untilMs === null)

/* --- 10. a corrupt file reads as "nothing locked" --------------------------- */
writeFileSync(file, 'this is not json')
const corrupt = await call('/plugins/dsh-model-lock/state')
check('a corrupt file does not throw', corrupt.status === 200)
check('a corrupt file reads as nothing locked', corrupt.body.locks.length === 0)

/* --- 11. an external writer is noticed -------------------------------------- */
// Another Harness process (or a hand edit) can replace the file; a cached table
// that ignored that would keep answering from the version it read first.
const external = {
  version: 1,
  locks: [{ provider: 'shuai', model: 'glm-5.3', untilMs: null, lockedAtMs: Date.now() }],
}
writeFileSync(file, `${JSON.stringify(external, null, 2)}\n`)
const seen = await call('/plugins/dsh-model-lock/state')
check(
  'a lock written by another process becomes visible',
  seen.body.locks.some((lock) => lock.provider === 'shuai' && lock.model === 'glm-5.3'),
)
check('the previously cached table is not served instead', seen.body.locks.length === 1)

/* --- 12. disposal removes both routes --------------------------------------- */
for (const dispose of effects.reverse()) dispose()
check('disposing unregisters the routes', routes.size === 0)

server.close()
rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of failed) console.log(`FAIL  ${r.name}${r.detail === undefined ? '' : ` - ${r.detail}`}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)