/**
 * dsh-model-lock - behaviour tests.
 *
 * Loads the REAL browser bundle through the same `window.__ModuleLoader__`
 * facade the harness uses, and drives the real `ctx` seams the plugin depends
 * on. No React primitives are stubbed: this plugin renders plain elements, so
 * the only fakes are the harness services themselves (`slots`, `locale`,
 * `modelDirectories`) and `fetch`.
 *
 * What these tests are for
 * ------------------------
 * The filter is a patch on another plugin's service, so the interesting
 * properties are not "does the UI look right" but:
 *
 *   1. ONE interception reaches every caller: the composer seat and the
 *      `/model` popup both go through `directoryFor`, so a single wrapper must
 *      cover both.
 *   2. Soft-lock holds: `select()` is untouched, and `routable` is passed
 *      through verbatim, so a session already on a locked model keeps working.
 *   3. Snapshot identity is stable: `useSyncExternalStore` re-renders forever
 *      if `getSnapshot()` returns a fresh object each read.
 *   4. The patch is undone on dispose, and a service reload re-applies it.
 *
 * Run: node run-tests.mjs <path-to-client.js>
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const bundlePath = process.argv[2]
const require = createRequire(import.meta.url)

/* --- DOM --------------------------------------------------------------------- */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { act } = require('react')

/* --- module-loader facade ---------------------------------------------------- */
let registration
window.__ModuleLoader__ = { load(record) { registration = record } }
new Function('window', readFileSync(bundlePath, 'utf8'))(window)
if (registration === undefined) throw new Error('bundle registered no module')

const mod = registration.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return require('react-dom')
  throw new Error(`unresolved external: ${specifier}`)
})

/* --- test plumbing ----------------------------------------------------------- */
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

let DICT = {}
const t = (key, params) => {
  const template = DICT[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}

/* --- host responses the bundle fetches --------------------------------------- */
let hostLocks = []
let hostCatalog = []
let stateFails = false
let writeFails = false
const writes = []

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body }
}

globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/state')) {
    if (stateFails) throw new Error('network down')
    return jsonResponse({ now: Date.now(), locks: hostLocks, catalog: hostCatalog })
  }
  if (String(url).endsWith('/lock')) {
    const body = JSON.parse(options.body)
    writes.push(body)
    if (writeFails) return jsonResponse({ error: 'disk full' }, false)
    const next = hostLocks.filter((lock) => !(lock.provider === body.provider && lock.model === body.model))
    if (body.locked === true) {
      next.push({
        provider: body.provider,
        model: body.model,
        untilMs: typeof body.durationMs === 'number' && body.durationMs > 0 ? Date.now() + body.durationMs : null,
        lockedAtMs: Date.now(),
      })
    }
    hostLocks = next
    return jsonResponse({ state: 'updated', now: Date.now(), locks: next })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

/* --- harness services -------------------------------------------------------- */
function makeStore() {
  let snapshot = {}
  const listeners = new Set()
  return {
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: () => snapshot,
    set: (next) => {
      snapshot = next
      for (const fn of listeners) fn()
    },
  }
}

const store = makeStore()
const selectCalls = []
let loadCalls = 0

const realDirectory = {
  store,
  load: async () => {
    loadCalls += 1
    return store.getSnapshot()
  },
  select: async (selection) => {
    selectCalls.push(selection)
    return { ok: true, value: undefined }
  },
  dispose: () => {},
  resetConnected: () => {},
}

/**
 * Delays the plugin asked the global timer for. A delay above 2^31-1 cannot be
 * represented and is silently clamped to 1ms by the runtime, which turns a long
 * lock's single timer into a tight re-arm loop; recording the requested value is
 * the only way to observe that from JavaScript.
 */
const requestedDelays = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, delay, ...rest) => {
  requestedDelays.push(delay)
  return realSetTimeout(fn, delay, ...rest)
}

const slotEntries = []
const effects = []
const injectCallbacks = []
const resolver = { directoryFor: () => realDirectory }
const resolverPrototypeDirectoryFor = resolver.directoryFor

const ctx = {
  effect: (fn) => {
    const dispose = fn()
    const wrapped = typeof dispose === 'function' ? dispose : () => {}
    effects.push(wrapped)
    return wrapped
  },
  locale: {
    register: (ns, dicts) => {
      DICT = dicts.zh
      return () => {}
    },
    bind: () => t,
  },
  inject: (names, cb) => {
    injectCallbacks.push(cb)
    cb({ modelDirectories: resolver, effect: ctx.effect })
  },
  slots: {
    inject: (key, fn) => {
      fn()
      return () => {}
    },
    register: (options, component) => {
      slotEntries.push({ options, component })
      return () => {}
    },
  },
}

mod.apply(ctx)

function disposeAll() {
  while (effects.length > 0) effects.pop()()
}

const baseSnapshot = () => ({
  current: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
  routable: true,
  groups: [
    {
      id: 'workbuddy-ai',
      name: 'WorkBuddy AI',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
        { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
      ],
    },
    {
      id: 'command',
      name: 'command',
      models: [
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      ],
    },
    { id: 'shuai', name: 'shuai', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] },
  ],
  failures: [],
  status: 'ready',
  pending: null,
  error: null,
})

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

const reread = async () => {
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'))
  })
  await flush()
}

/**
 * Wait real time so the plugin's own expiry timer can fire. jsdom uses real
 * Node timers, so this advances the clock the plugin scheduled against.
 */
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

async function main() {
  /* --- 1. the seam covers every caller --------------------------------------- */
  const directory = resolver.directoryFor('session-1')
  check('directoryFor returns a facade, not the raw directory', directory !== realDirectory)
  check('the same session resolves the same facade object', resolver.directoryFor('session-1') === directory)
  check(
    'the facade exposes the snapshot surface the seats read',
    typeof directory.getSnapshot === 'function' && typeof directory.subscribe === 'function',
  )
  check('load() is still callable', typeof directory.load === 'function')
  check('select() is still callable', typeof directory.select === 'function')

  /* --- 2. unfiltered passthrough --------------------------------------------- */
  store.set(baseSnapshot())
  const before = directory.getSnapshot()
  check('with nothing locked the snapshot is the original object', before === store.getSnapshot())
  check('the group list is untouched', before.groups.length === 3)

  /* --- 3. locking hides the model from the shared directory ------------------ */
  hostLocks = [{ provider: 'workbuddy-ai', model: 'gpt-6-astra', untilMs: null, lockedAtMs: Date.now() }]
  await reread()
  const locked = directory.getSnapshot()
  check(
    'the locked model is gone from its group',
    !locked.groups.find((g) => g.id === 'workbuddy-ai').models.some((m) => m.id === 'gpt-6-astra'),
  )
  check(
    'its siblings survive',
    locked.groups.find((g) => g.id === 'workbuddy-ai').models.some((m) => m.id === 'deepseek-v4.1-flash'),
  )
  check('other providers are untouched', locked.groups.length === 3)
  check('the original snapshot object was not mutated', store.getSnapshot().groups[0].models.length === 2)

  /* --- 4. soft lock: routable and select survive ----------------------------- */
  check('routable is passed through verbatim', locked.routable === true)
  check('current selection is unchanged', locked.current.model === 'deepseek-v4.1-flash')
  await directory.select({ provider: 'workbuddy-ai', model: 'gpt-6-astra' })
  check(
    'select() still reaches the real directory for a locked model',
    selectCalls.length === 1 && selectCalls[0].model === 'gpt-6-astra',
  )

  /* --- 5. a session whose CURRENT model is locked stays routable -------------- */
  hostLocks = [{ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', untilMs: null, lockedAtMs: Date.now() }]
  await reread()
  const currentLocked = directory.getSnapshot()
  check(
    'the locked current model is hidden from the picker',
    !currentLocked.groups.find((g) => g.id === 'workbuddy-ai').models.some((m) => m.id === 'deepseek-v4.1-flash'),
  )
  check('routable stays true so the session keeps sending', currentLocked.routable === true)

  /* --- 6. a group with every model locked disappears ------------------------- */
  hostLocks = [
    { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', untilMs: null, lockedAtMs: Date.now() },
    { provider: 'workbuddy-ai', model: 'gpt-6-astra', untilMs: null, lockedAtMs: Date.now() },
  ]
  await reread()
  const emptied = directory.getSnapshot()
  check('a fully locked provider group is dropped', !emptied.groups.some((g) => g.id === 'workbuddy-ai'))
  check('the remaining providers are intact', emptied.groups.length === 2)

  /* --- 7. snapshot identity is stable ---------------------------------------- */
  const a = directory.getSnapshot()
  const b = directory.getSnapshot()
  check('getSnapshot returns the same object when nothing changed', a === b)
  store.set({ ...baseSnapshot() })
  const c = directory.getSnapshot()
  check('a real snapshot change produces a new object', c !== a)
  check('and it is memoized again', directory.getSnapshot() === c)

  /* --- 8. expired locks stop applying ---------------------------------------- */
  hostLocks = [{ provider: 'command', model: 'gpt-6.1-sol', untilMs: Date.now() - 1000, lockedAtMs: Date.now() - 5000 }]
  await reread()
  const expired = directory.getSnapshot()
  check(
    'an already-expired lock does not hide its model',
    expired.groups.find((g) => g.id === 'command').models.some((m) => m.id === 'gpt-6.1-sol'),
  )

  /* --- 9. a failed read does not un-hide models ------------------------------ */
  hostLocks = [{ provider: 'shuai', model: 'glm-5.3', untilMs: null, lockedAtMs: Date.now() }]
  await reread()
  const withLock = directory.getSnapshot()
  check('the lock applies', !withLock.groups.some((g) => g.id === 'shuai'))
  stateFails = true
  const held = directory.getSnapshot()
  check('a failed refresh keeps the previous table', !held.groups.some((g) => g.id === 'shuai'))
  stateFails = false

  /* --- 10. the composer seat consumes `directory.store`, not the facade ------ */
  // The shipped seat registration hands the component `directory.store` and the
  // component subscribes to that object. A facade that published its filtered
  // view only through its own getSnapshot() would leave the seat reading the raw
  // snapshot, so locked models would stay visible in the composer.
  hostLocks = [{ provider: 'shuai', model: 'glm-5.3', untilMs: null, lockedAtMs: Date.now() }]
  await reread()
  const seatStore = directory.store
  check('the facade publishes a store-shaped object', seatStore !== undefined && typeof seatStore.getSnapshot === 'function')
  check('that store is not the raw store', seatStore !== store)
  check(
    'the seat store hides the locked model',
    !seatStore.getSnapshot().groups.some((g) => g.id === 'shuai'),
  )
  check('the seat store keeps the other providers', seatStore.getSnapshot().groups.length === 2)
  check('the raw store still holds every model', store.getSnapshot().groups.length === 3)

  // A subscriber attached the way the component attaches one must be notified
  // when the table changes, or the open menu would never repaint.
  let seatNotifications = 0
  const unsubscribeSeat = seatStore.subscribe(() => {
    seatNotifications += 1
  })
  hostLocks = []
  await reread()
  unsubscribeSeat()
  check('the seat store notifies its subscribers on a table change', seatNotifications > 0)
  check('the seat store shows the model again once unlocked', seatStore.getSnapshot().groups.some((g) => g.id === 'shuai'))

  // `useSyncExternalStore` calls getSnapshot repeatedly and re-renders forever on
  // a fresh identity, so the store must be as stable as the facade.
  check('the seat store snapshot is identity-stable', seatStore.getSnapshot() === seatStore.getSnapshot())

  /* --- 11. a temporary lock lifts on its own, with no card open -------------- */
  hostLocks = [{ provider: 'shuai', model: 'glm-5.3', untilMs: Date.now() + 300, lockedAtMs: Date.now() }]
  await reread()
  check('a lock with a near deadline hides its model', !directory.getSnapshot().groups.some((g) => g.id === 'shuai'))
  await wait(600)
  check(
    'the lock lifts when its deadline passes, with nothing else happening',
    directory.getSnapshot().groups.some((g) => g.id === 'shuai'),
  )

  /* --- 12. a long lock does not overflow its timer and unlock at once -------- */
  // `setTimeout` stores its delay in 32 bits: a delay above 2^31-1 fires almost
  // immediately. A 30-day lock must therefore still be in force a moment later.
  hostLocks = [{ provider: 'command', model: 'gpt-6.1-sol', untilMs: Date.now() + 30 * 24 * 60 * 60 * 1000, lockedAtMs: Date.now() }]
  await reread()
  check('a 30-day lock hides its model', !directory.getSnapshot().groups.find((g) => g.id === 'command').models.some((m) => m.id === 'gpt-6.1-sol'))
  await wait(120)
  check(
    'a 30-day lock is still in force a moment later (no timer overflow)',
    !directory.getSnapshot().groups.find((g) => g.id === 'command').models.some((m) => m.id === 'gpt-6.1-sol'),
  )
  // A delay the runtime cannot represent would be clamped to 1ms, re-arming the
  // timer in a tight loop for the whole month.
  const longDelays = requestedDelays.filter((delay) => delay > 2 ** 31 - 1)
  check('no timer delay exceeds the 32-bit ceiling', longDelays.length === 0, `saw ${longDelays.length}`)
  const longLockTimers = requestedDelays.filter((delay) => delay === 2 ** 31 - 1)
  check('the long lock armed a clamped timer instead', longLockTimers.length >= 1)

  /* --- 13. the /model popup reads the same filtered view --------------------- */
  const popupDirectory = resolver.directoryFor('session-1')
  check('the popup resolves the identical facade', popupDirectory === directory)
  const loaded = await popupDirectory.load()
  check('load() resolves the filtered snapshot', Array.isArray(loaded.groups))
  check('load() reached the real directory', loadCalls > 0)

  /* --- 11. the management card is registered --------------------------------- */
  const card = slotEntries.find((entry) => entry.options.name === 'plugins.bundle.config')
  check('a plugins.bundle.config card is registered', card !== undefined)
  check('it is keyed to this bundle', card?.options.key === 'dsh-model-lock')
  check('it declares its locale namespace', card?.options.locale === 'model-lock')

  /* --- 12. disposal restores the original method ----------------------------- */
  disposeAll()
  check('the original directoryFor is restored on dispose', resolver.directoryFor === resolverPrototypeDirectoryFor)

  /* --- 13. a service reload re-applies the patch ----------------------------- */
  const reloadCb = injectCallbacks[injectCallbacks.length - 1]
  reloadCb({ modelDirectories: resolver, effect: ctx.effect })
  check('the patch is re-applied after a service reload', resolver.directoryFor !== resolverPrototypeDirectoryFor)

  /* --- 17. the card renders the host catalog and writes locks ---------------- */
  hostCatalog = [
    { provider: 'workbuddy-ai', name: 'WorkBuddy AI', models: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }] },
    { provider: 'command', name: 'command', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
  ]
  hostLocks = []
  await reread()

  const container = document.getElementById('root')
  const root = ReactDOMClient.createRoot(container)
  const cardEntry = slotEntries[slotEntries.length - 1]
  await act(async () => {
    root.render(React.createElement(cardEntry.component, cardEntry.options.inject()))
  })

  const rows = [...container.querySelectorAll('.dml_row')]
  check('the card lists every model the host reported', rows.length === 2)
  check('provider names are shown', container.textContent.includes('WorkBuddy AI'))
  check('model ids are shown', container.textContent.includes('workbuddy-ai/deepseek-v4.1-flash'))
  const buttons = [...container.querySelectorAll('.dml_button')]
  check('each row offers a lock button', buttons.length === 2 && buttons[0].textContent === DICT.lock)

  await act(async () => {
    buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush()
  check('clicking lock posted a lock write', writes.length === 1 && writes[0].locked === true)
  check(
    'the write named the right model',
    writes[0].provider === 'workbuddy-ai' && writes[0].model === 'deepseek-v4.1-flash',
  )
  check('the default duration is "until I unlock it"', writes[0].durationMs === null)

  const afterLock = [...container.querySelectorAll('.dml_button')]
  check('the row now offers to unlock', afterLock[0].textContent === DICT.unlock)
  check('the row shows the lock state', container.textContent.includes(DICT.forever))

  const selects = [...container.querySelectorAll('.dml_select')]
  check('unlocked rows offer a duration picker', selects.length === 1)
  await act(async () => {
    selects[0].value = String(2 * 60 * 60 * 1000)
    selects[0].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  const secondButton = [...container.querySelectorAll('.dml_button')][1]
  await act(async () => {
    secondButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush()
  const timedWrite = writes[writes.length - 1]
  check('a chosen duration is sent as a deadline offset', timedWrite.durationMs === 2 * 60 * 60 * 1000)
  check('a timed lock shows a countdown', /1h|2h/.test(container.textContent))

  const unlockButton = [...container.querySelectorAll('.dml_button')][0]
  await act(async () => {
    unlockButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush()
  check('unlocking posts locked:false', writes[writes.length - 1].locked === false)
  check('the row returns to the lock state', [...container.querySelectorAll('.dml_button')][0].textContent === DICT.lock)

  /* --- 18. a failed write is surfaced, not swallowed ------------------------- */
  writeFails = true
  const failButton = [...container.querySelectorAll('.dml_button')][0]
  await act(async () => {
    failButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush()
  check('a rejected write reports the failure', container.querySelector('.dml_error') !== null)
  check('and says the pool is unchanged', container.textContent.includes(DICT.writeFailedDetail))
  writeFails = false

  await act(async () => {
    root.unmount()
  })

  // Tear the plugin down as an unload would. This also cancels the expiry timer
  // the last lock armed, which would otherwise keep the process alive for the
  // full two-hour duration.
  disposeAll()

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    if (!r.ok) console.log(`FAIL  ${r.name}${r.detail === undefined ? '' : ` - ${r.detail}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  // Exit explicitly: a stray timer must not turn a finished run into a hang.
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})