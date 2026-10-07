/**
 * dsh-task-notify — host-half behaviour tests.
 *
 * The host half is the part a browser screenshot cannot check and the part that
 * needs a process restart to replace, so it is exercised directly: `apply()` is
 * driven through a stub context and the event sequences the real Host produces
 * are replayed, then the plugin's own black box is asserted.
 *
 * It is also the only half with branching worth testing — the completion feed
 * has to tell four look-alike situations apart: a turn this process watched from
 * start to finish, a turn that was already running when the process started, an
 * idle session the Host merely enumerated at boot, and a delegated child.
 *
 * Run: node run-tests.mjs
 *   (or through the repository script: pnpm test)
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* --- isolation ---------------------------------------------------------------- */
/**
 * A throwaway DSH home, so a test run never reads or rewrites the real black box
 * of the DSH installation that happens to be running on this machine.
 */
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-task-notify-test-'))
process.env.DSH_HOME = sandbox

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const packageRoot = path.dirname(here)
const STATUS = path.join(sandbox, 'dsh-task-notify-state', 'status.json')

const failures = []
const checks = []

function check(label, condition, detail) {
  checks.push({ label, ok: condition === true })
  if (condition !== true) failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A context stub with only what the plugin actually uses. */
function makeContext() {
  const handlers = new Map()
  const routes = []
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
    },
    on: (name, listener) => {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
      return () => undefined
    },
    effect: (callback) => callback(),
    connection: {
      fetch: { register: (route) => { routes.push(route); return async () => undefined } },
      rpc: { handle: () => async () => undefined, intercept: () => async () => undefined },
    },
  }
  const emit = (name, ...args) => {
    for (const listener of handlers.get(name) ?? []) listener(...args)
  }
  return { ctx, emit, routes, logs }
}

/** Read the black box the plugin just wrote. */
function state() {
  return JSON.parse(readFileSync(STATUS, 'utf8'))
}

/** Post one `client-request` envelope to a registered route. */
async function call(route, method, payload, rpcId = 'r1') {
  const response = await route.fetch(new Request('http://127.0.0.1/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  }))
  return await response.json()
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const module = await import(pathToFileURL(path.join(packageRoot, 'index.js')).href)
check('module exports apply()', typeof module.apply === 'function')
check('module injects connection', Array.isArray(module.inject) && module.inject.includes('connection'))

const { ctx, emit, routes, logs } = makeContext()
module.apply(ctx)

check('stream route registered', routes.some((route) => route.path === '/api/task-notify/stream'))
check('poll route registered', routes.some((route) => route.path === '/api/task-notify/poll'))
check('ack route registered', routes.some((route) => route.path === '/api/task-notify/ack'))
check('status file written on apply', state().version === 1)

// A user session is announced with a title projection and a workspace, then runs
// and stops: the one case that must always produce exactly one completion.
emit('api-session/added', {
  sessionId: 'session-user',
  running: true,
  cwd: 'C:\\Users\\me\\Documents\\my-project',
  projections: { kind: 'cached', asOfSeq: 1, values: { title: '实现完成提醒' } },
})
emit('api-session/status', 'session-user', true)
await wait(30)
emit('api-session/status', 'session-user', false)

let events = state().events
check('one completion recorded', events.length === 1, `saw ${String(events.length)}`)
check('completion carries the session id', events[0]?.sessionId === 'session-user')
check('completion carries the projected title', events[0]?.title === '实现完成提醒', JSON.stringify(events[0]?.title))
check('completion carries the workspace label', events[0]?.workspace === 'my-project', JSON.stringify(events[0]?.workspace))
check('completion carries a duration', typeof events[0]?.durationMs === 'number' && events[0].durationMs >= 0)
check('completion is not marked subagent', events[0]?.subagent === false)
check('cursor advanced', state().cursor === 1, String(state().cursor))

// A delegated child: announced with an origin, runs, stops. It must be recorded
// (the browser half filters it) but flagged so that filter is possible.
emit('api-session/added', { sessionId: 'session-child', origin: 'subagent', parentSessionId: 'session-user', running: true })
emit('api-session/status', 'session-child', true)
await wait(20)
emit('api-session/status', 'session-child', false)

events = state().events
check('child completion recorded', events.length === 2, `saw ${String(events.length)}`)
check('child completion is flagged subagent', events[1]?.subagent === true)

// A Host that enumerates an idle session at boot emits `false` with no start.
// That is not a finished turn and must not become a notification.
emit('api-session/status', 'session-idle', false)
check('boot-time idle enumeration is ignored', state().events.length === 2, `saw ${String(state().events.length)}`)

// A turn that was already running when the process started: announced running,
// then stopped without a witnessed start. It earns a card, without a duration.
emit('api-session/added', { sessionId: 'session-inherited', running: true, cwd: '/home/me/old-work' })
emit('api-session/status', 'session-inherited', false)
events = state().events
check('inherited running turn still reports', events.length === 3, `saw ${String(events.length)}`)
check('inherited turn has no duration claim', events[2]?.durationMs === undefined)
check('inherited turn keeps its workspace label', events[2]?.workspace === 'old-work')

// An error during a turn marks that turn's card.
emit('api-session/status', 'session-user', true)
emit('agent/error', { agent: { id: 'session-user' }, turn: 1, step: 1, error: new Error('boom') })
emit('api-session/status', 'session-user', false)
events = state().events
check('errored turn recorded', events.length === 4, `saw ${String(events.length)}`)
check('errored turn is flagged', events[3]?.error === true)

/* --- the two routes ----------------------------------------------------------- */
const poll = routes.find((route) => route.path === '/api/task-notify/poll')
const pollBody = await call(poll, 'task-notify/poll', { cursor: 3 })
check('poll returns the newer event only', pollBody.result?.value?.events?.length === 1, JSON.stringify(pollBody.result?.value?.events?.length))
check('poll echoes the cursor', pollBody.result?.value?.cursor === 4)

const ack = routes.find((route) => route.path === '/api/task-notify/ack')
await call(ack, 'task-notify/ack', { lastSeq: 4, received: 4, sound: true, note: 'test' }, 'r2')
check('ack recorded', state().lastAck?.note === 'test', JSON.stringify(state().lastAck))

const wrong = await call(poll, 'task-notify/other', {}, 'r3')
check('method mismatch is refused', wrong.result?.ok === false, JSON.stringify(wrong.result))

check('no listener warnings logged', logs.every((line) => !line.startsWith('warn')), logs.filter((line) => line.startsWith('warn')).join(' | '))

const passed = checks.filter((entry) => entry.ok).length
for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}`)
console.log(`\n${String(passed)}/${String(checks.length)} checks passed`)

rmSync(sandbox, { recursive: true, force: true })
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
