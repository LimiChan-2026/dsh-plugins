/**
 * dsh-workbuddy-cooldown host-half integration tests.
 *
 * Runs the REAL `index.js` against a real HTTP server acting as the wb2api
 * panel, so the things that can only break in the host half are covered: panel
 * shape normalization (including Go's zero time), the cache window, error
 * propagation, and the route contract.
 *
 * The panel is faked here because its 429 path cannot be exercised on demand:
 * `model_locks` was empty on this machine for the whole build, so a fake lets
 * the aggregation actually be asserted rather than hoped for.
 *
 * Run: node host-tests.mjs <path-to-index.js>
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const indexPath = process.argv[2]
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const home = mkdtempSync(join(tmpdir(), 'wbc-home-'))

const { apply, STATUS_PATH } = await import(pathToFileURL(indexPath).href)

/* --- a stand-in wb2api panel ------------------------------------------------- */
/** The panel document the fake serves; tests mutate it between assertions. */
let panelDocument = {}
/** Set to make the panel answer with a non-200 status. */
let panelStatus = 200
/** Set to make the panel hang until the client times out. */
let panelHangs = false
/** Every panel request the plugin made. */
const panelRequests = []

const panelServer = createServer((req, res) => {
  panelRequests.push(req.url)
  if (panelHangs) {
    // Never answer; the plugin's own timeout must recover.
    return
  }
  const payload = JSON.stringify(panelDocument)
  res.writeHead(panelStatus, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
})
await new Promise((resolve) => panelServer.listen(0, '127.0.0.1', resolve))
const panelBase = `http://127.0.0.1:${panelServer.address().port}`

/* --- harness context --------------------------------------------------------- */
const routes = new Map()
const effects = []
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
    for (const name of names) if (!(name in scope)) throw new Error(`scope is missing "${name}"`)
    cb(scope)
  },
}

let pluginConfig = { panelApiKey: 'test-key', panelBaseUrl: panelBase, panelTtlMs: 0 }
const reapply = () => apply(ctx, pluginConfig)
reapply()

check('the state route was registered', routes.has(STATUS_PATH))

/* --- panel fixtures ---------------------------------------------------------- */
const ZERO = '0001-01-01T00:00:00Z'
const account = (over = {}) => ({
  uid: 'uid-cn-1',
  nickname: 'acc-cn-1',
  credits: 500,
  realm: 'cn',
  cooling: false,
  disabled: false,
  until: ZERO,
  cool_kind: 0,
  breaker_until: ZERO,
  degrade_until: ZERO,
  last_err: '',
  ...over,
})
const FUTURE = Date.now() + 60 * 60 * 1000

/** Call the plugin's own state route as the browser would. */
async function callState(origin = 'http://127.0.0.1:19387') {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers)
    },
    end(payload) {
      this.body = payload
    },
  }
  await routes.get(STATUS_PATH)({ method: 'GET', headers: { host: '127.0.0.1', origin } }, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

async function main() {
  /* --- 1. a healthy pool ----------------------------------------------------- */
  panelDocument = {
    total: 2,
    healthy: 2,
    cooling: 0,
    accounts: [account(), account({ uid: 'uid-gl-1', nickname: 'acc-gl-1', realm: 'global' })],
    model_locks: [],
  }
  reapply()
  const healthy = await callState()
  check('the plugin asks the panel for /status', panelRequests.some((u) => u.includes('/status')))
  check('the state route answers 200', healthy.status === 200, `got ${healthy.status}`)
  check('a healthy pool reports no model locks', healthy.body.modelLocks.length === 0)
  check('both accounts are carried', healthy.body.accounts.length === 2)
  check('the panel reachability flag is true', healthy.body.reachable === true)
  check('the panel account count is surfaced', healthy.body.panelTotal === 2)

  /* --- 2. Go zero time is absence, not a past date --------------------------- */
  check(
    'a zero "until" is not reported as a cooldown',
    healthy.body.accounts.every((a) => a.untilMs === null),
  )

  /* --- 3. a model-level lock is carried through ------------------------------ */
  panelDocument = {
    total: 2,
    healthy: 0,
    cooling: 2,
    accounts: [
      account({ cooling: true, until: new Date(FUTURE).toISOString(), cool_kind: 6004 }),
      account({ uid: 'uid-cn-2', nickname: 'acc-cn-2', cooling: true, until: new Date(FUTURE + 30 * 60_000).toISOString(), cool_kind: 6004 }),
    ],
    model_locks: [
      {
        realm: 'cn',
        model: 'deepseek-v4.1-flash',
        available: 0,
        total: 2,
        locked_accounts: 2,
        state: 'cooling',
        earliest_unlock: new Date(FUTURE).toISOString(),
        full_pool_unlock: new Date(FUTURE + 30 * 60_000).toISOString(),
        reason: '将在 … 重置',
      },
    ],
  }
  reapply()
  const locked = await callState()
  check('a populated model_locks reaches the client', locked.body.modelLocks.length === 1)
  const lock = locked.body.modelLocks[0]
  check('the model id survives', lock.model === 'deepseek-v4.1-flash')
  check('the realm survives', lock.realm === 'cn')
  check('locked account count is carried', lock.lockedAccounts === 2)
  check('earliest unlock parses to a future time', lock.earliestUnlockMs > Date.now())
  check('full pool unlock parses to a later time', lock.fullPoolUnlockMs > lock.earliestUnlockMs)
  check('the upstream reason text is carried', lock.reason.includes('重置'))
  check('the raw panel entry is preserved for unknown fields', typeof lock.raw === 'object')

  /* --- 4. unknown lock fields are not dropped -------------------------------- */
  panelDocument.model_locks = [{ realm: 'cn', model: 'm1', someFutureField: 'x' }]
  reapply()
  const unknown = await callState()
  check('an unrecognized lock shape is still reported', unknown.body.modelLocks.length === 1)
  check('with its raw panel entry intact', unknown.body.modelLocks[0].raw.someFutureField === 'x')

  /* --- 5. accounts cooling without a model lock are visible ------------------ */
  const cooling = await callState()
  check('cooling accounts are counted', cooling.body.coolingAccounts === 2)
  check(
    'each cooling account carries its own deadline',
    cooling.body.accounts.every((a) => a.untilMs === null || a.untilMs > Date.now()),
  )

  /* --- 6. a disabled account is not counted as cooling ----------------------- */
  panelDocument.accounts = [account({ cooling: true, disabled: true })]
  reapply()
  const disabled = await callState()
  check('a disabled account is not counted as cooling', disabled.body.coolingAccounts === 0)

  /* --- 7. a panel failure is a reported error, not silence ------------------- */
  // The panel is switched to a failing status in place rather than closed: a
  // closed loopback socket can leave the node fetch agent waiting on a pooled
  // connection, which hangs the test instead of exercising the timeout.
  panelStatus = 503
  const down = await callState()
  check('a failing panel answers 502', down.status === 502, `got ${down.status}`)
  check('with reachability flagged false', down.body.reachable === false)
  check('and a diagnostic message', typeof down.body.error === 'string' && down.body.error.length > 0)

  /* --- 8. the panel recovers and the view follows ---------------------------- */
  panelStatus = 200
  panelDocument = {
    total: 1,
    healthy: 1,
    cooling: 0,
    accounts: [account()],
    model_locks: [],
  }
  reapply()
  const recovered = await callState()
  check('a recovered pool is reported healthy again', recovered.status === 200 && recovered.body.reachable === true)
  check('and carries no locks', recovered.body.modelLocks.length === 0)

  /* --- 9. disposal removes the route --------------------------------------- */
  for (const dispose of effects.reverse()) dispose()
  check('disposing unregisters the route', routes.size === 0)

  rmSync(home, { recursive: true, force: true })
  panelServer.close()

  const failed = results.filter((r) => !r.ok)
  for (const r of failed) console.log(`FAIL  ${r.name}${r.detail === undefined ? '' : ` - ${r.detail}`}`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
