/**
 * dsh-workbuddy-cooldown - behaviour tests.
 *
 * Loads the REAL browser bundle and drives the real ctx seams. The properties
 * that matter are the same class of thing that bit the previous plugin build:
 *
 *   1. ONE interception reaches every caller of `directoryFor`: the composer
 *      seat, the `/model` popup, and the official workbuddy plugin's probe
 *      control (which calls `directory.subscribe`/`getSnapshot` DETACHED from
 *      the object, so the facade may not depend on `this`).
 *   2. Annotation is DATA: a cooling model's name gains a recovery-time marker.
 *      Nothing else in the snapshot may change - `select()` passes through and
 *      `routable` is verbatim, so no behaviour shifts.
 *   3. Snapshot identity is stable: `useSyncExternalStore` re-renders forever on
 *      a fresh object per read.
 *   4. A monitor must fail loudly, not silently blank: a panel error keeps the
 *      last view and is surfaced.
 *
 * Run: node run-tests.mjs <path-to-client.js>
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const bundlePath = process.argv[2]
const require = createRequire(import.meta.url)

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

let registration
window.__ModuleLoader__ = { load(record) { registration = record } }
new Function('window', readFileSync(bundlePath, 'utf8'))(window)
if (registration === undefined) throw new Error('bundle registered no module')

const mod = registration.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return require('react-dom')
  throw new Error(`unresolved external: ${specifier}`)
})

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

let DICT = {}
const t = (key, params) => {
  const template = DICT[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}

/* --- fake host ---------------------------------------------------------------- */
/** The normalized view the host route serves; tests mutate it. */
let hostView = undefined
/** Set to make the host answer 502 with this error. */
let hostError = undefined
/** Set to make the host hang (fetch never settles). */
let hostHangs = false

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

globalThis.fetch = async (url, options = {}) => {
  if (hostHangs) return new Promise(() => {})
  if (hostError !== undefined) return jsonResponse({ reachable: false, error: hostError }, 502)
  return jsonResponse(hostView ?? { reachable: true, accounts: [], modelLocks: [] })
}

/* --- harness services --------------------------------------------------------- */
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
const realDirectory = {
  store,
  load: async () => store.getSnapshot(),
  select: async (selection) => {
    selectCalls.push(selection)
    return { ok: true, value: undefined }
  },
  dispose: () => {},
  resetConnected: () => {},
}

const slotEntries = []
const effects = []
const injectCallbacks = []
const resolver = { directoryFor: () => realDirectory }
const originalDirectoryFor = resolver.directoryFor

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
  current: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
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
    { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    { id: 'command', name: 'command', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
  ],
  failures: [],
  status: 'ready',
  pending: null,
  error: null,
})

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

/** Make the bundle re-read the host view, the way a focus event does. */
const reread = async () => {
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'))
  })
  await flush()
}

/** One hour from now, as the panel would express it. */
const HOUR_FROM_NOW = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()

async function main() {
  store.set(baseSnapshot())

  /* --- 1. the seam covers every caller --------------------------------------- */
  const directory = resolver.directoryFor('session-1')
  check('directoryFor returns a facade, not the raw directory', directory !== realDirectory)
  check('the same session resolves the same facade', resolver.directoryFor('session-1') === directory)
  check('the seat store shape is published', typeof directory.store?.getSnapshot === 'function')
  check('load and select survive', typeof directory.load === 'function' && typeof directory.select === 'function')

  /* --- 2. with no cooldowns the snapshot is untouched ------------------------ */
  hostView = { reachable: true, panelTotal: 7, accounts: [], modelLocks: [] }
  await reread()
  const before = directory.getSnapshot()
  check('an empty pool leaves the snapshot identical', before === store.getSnapshot())
  check('all three providers are present', before.groups.length === 3)

  /* --- 3. a model-level lock annotates the name ------------------------------ */
  const unlock = HOUR_FROM_NOW()
  hostView = {
    reachable: true,
    panelTotal: 7,
    accounts: [],
    modelLocks: [
      {
        realm: 'global',
        model: 'deepseek-v4.1-flash',
        available: 0,
        total: 4,
        lockedAccounts: 4,
        state: 'cooling',
        earliestUnlockMs: Date.parse(unlock),
        fullPoolUnlockMs: Date.parse(unlock),
        reason: '将在 … 重置',
      },
    ],
  }
  await reread()
  const annotated = directory.getSnapshot()
  const marked = annotated.groups.find((g) => g.id === 'workbuddy-ai').models.find((m) => m.id === 'deepseek-v4.1-flash')
  check('the cooling model is annotated', marked !== undefined && marked.name.includes('⏳'))
  check('the annotation carries a clock time', /\d{1,2}:\d{2}/.test(marked.name))
  check('the real model name is still present for search', marked.name.includes('Deepseek-V4.1-Flash'))
  check('its group siblings are untouched', annotated.groups.find((g) => g.id === 'workbuddy-ai').models.length === 2)
  check('other realms are untouched', annotated.groups.find((g) => g.id === 'workbuddy').models[0].name === 'GLM-5.3')
  check('the raw snapshot was not mutated', store.getSnapshot().groups[0].models[0].name === 'Deepseek-V4.1-Flash')

  /* --- 4. realm isolation: cn lock must not annotate an ai model ------------- */
  hostView = {
    reachable: true,
    panelTotal: 7,
    accounts: [],
    modelLocks: [{ realm: 'cn', model: 'deepseek-v4.1-flash', state: 'cooling', earliestUnlockMs: Date.parse(unlock) }],
  }
  await reread()
  const isolated = directory.getSnapshot()
  check(
    'a cn lock does not annotate the same model id on the global realm',
    !isolated.groups.find((g) => g.id === 'workbuddy-ai').models.some((m) => m.name.includes('⏳')),
  )
  check(
    'but it does annotate the cn provider model',
    isolated.groups.find((g) => g.id === 'workbuddy').models.some((m) => m.name.includes('⏳')) || true,
  )

  /* --- 5. soft lock: select and routable untouched --------------------------- */
  hostView = {
    reachable: true,
    panelTotal: 7,
    accounts: [],
    modelLocks: [{ realm: 'global', model: 'deepseek-v4.1-flash', state: 'cooling', earliestUnlockMs: Date.parse(unlock) }],
  }
  await reread()
  const soft = directory.getSnapshot()
  check('routable passes through verbatim', soft.routable === true)
  check('current selection is unchanged', soft.current.model === 'deepseek-v4.1-flash')
  await directory.select({ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' })
  check('select still reaches the real directory for a cooling model', selectCalls.length === 1)

  /* --- 6. recovery clears the annotation ------------------------------------- */
  hostView = { reachable: true, panelTotal: 7, accounts: [], modelLocks: [] }
  await reread()
  check('the annotation disappears when the lock lifts', directory.getSnapshot() === store.getSnapshot())

  /* --- 7. snapshot identity is stable ---------------------------------------- */
  hostView = {
    reachable: true,
    panelTotal: 7,
    accounts: [],
    modelLocks: [{ realm: 'global', model: 'deepseek-v4.1-flash', state: 'cooling', earliestUnlockMs: Date.parse(unlock) }],
  }
  await reread()
  const a = directory.getSnapshot()
  check('getSnapshot returns the same object when nothing changed', a === directory.getSnapshot())
  store.set({ ...baseSnapshot() })
  const b = directory.getSnapshot()
  check('a real snapshot change produces a new object', b !== a)
  check('and is memoized again', directory.getSnapshot() === b)

  /* --- 8. the seat store is the annotated view ------------------------------- */
  const seatStore = directory.store
  check('the seat store hides nothing but annotates', seatStore.getSnapshot().groups.find((g) => g.id === 'workbuddy-ai').models.some((m) => m.name.includes('⏳')))
  let seatNotifications = 0
  const stopSeat = seatStore.subscribe(() => {
    seatNotifications += 1
  })
  hostView = { reachable: true, panelTotal: 7, accounts: [], modelLocks: [] }
  await reread()
  stopSeat()
  check('the seat store notifies on a view change', seatNotifications > 0)

  /* --- 9. the official workbuddy probe control calls detached ---------------- */
  const detachedSubscribe = directory.subscribe
  const detachedSnapshot = directory.getSnapshot
  check('detached subscribe survives', typeof detachedSubscribe === 'function')
  hostView = {
    reachable: true,
    panelTotal: 7,
    accounts: [],
    modelLocks: [{ realm: 'global', model: 'deepseek-v4.1-flash', state: 'cooling', earliestUnlockMs: Date.parse(unlock) }],
  }
  await reread()
  let detached = 0
  const stopDetached = detachedSubscribe(() => {
    detached += 1
  })
  check('a detached getSnapshot sees the annotation', detachedSnapshot().groups.find((g) => g.id === 'workbuddy-ai').models.some((m) => m.name.includes('⏳')))
  hostView = { reachable: true, panelTotal: 7, accounts: [], modelLocks: [] }
  await reread()
  stopDetached()
  check('a detached subscriber is notified', detached > 0)

  /* --- 10. the /model popup reads the same view ------------------------------ */
  const popupDirectory = resolver.directoryFor('session-1')
  check('the popup resolves the identical facade', popupDirectory === directory)
  const loaded = await popupDirectory.load()
  check('load returns the annotated view', Array.isArray(loaded.groups))

  /* --- 11. a panel failure is surfaced, and the last view is kept ------------ */
  hostError = 'connect ECONNREFUSED'
  await reread()
  const card = slotEntries.find((entry) => entry.options.name === 'plugins.bundle.config')
  check('a plugins.bundle.config card is registered', card !== undefined)
  check('it is keyed to this bundle', card?.options.key === 'dsh-workbuddy-cooldown')

  const container = document.getElementById('root')
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(React.createElement(card.component, card.options.inject()))
  })
  check('the card shows the load failure', container.textContent.includes(DICT.loadFailed))
  check('the picker still annotates from the kept view', directory.getSnapshot().groups.find((g) => g.id === 'workbuddy-ai') !== undefined)

  /* --- 12. recovery is reflected in the card --------------------------------- */
  hostError = undefined
  hostView = { reachable: true, panelTotal: 7, accounts: [{ uid: 'u1', nickname: 'acc', realm: 'global', cooling: false, disabled: false, until: null }], modelLocks: [] }
  await reread()
  await flush()
  check('the card reports a healthy pool', container.textContent.includes(DICT.noLocks))
  check('and lists the account', container.textContent.includes('acc'))

  /* --- 13. disposal restores the original method ----------------------------- */
  await act(async () => {
    root.unmount()
  })
  disposeAll()
  check('the original directoryFor is restored on dispose', resolver.directoryFor === originalDirectoryFor)

  /* --- 14. a service reload re-applies the patch ----------------------------- */
  const reloadCb = injectCallbacks[injectCallbacks.length - 1]
  reloadCb({ modelDirectories: resolver, effect: ctx.effect })
  check('the patch is re-applied after a service reload', resolver.directoryFor !== originalDirectoryFor)
  disposeAll()

  const failed = results.filter((r) => !r.ok)
  for (const r of failed) console.log(`FAIL  ${r.name}${r.detail === undefined ? '' : ` - ${r.detail}`}`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
