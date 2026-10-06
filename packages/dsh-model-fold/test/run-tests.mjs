/**
 * dsh-model-fold — behaviour tests.
 *
 * Loads the REAL browser bundle through the same `window.__ModuleLoader__` facade
 * the harness uses, mounts the registered component into a jsdom document with
 * real React 18, and drives it with real DOM events. Only
 * `@deepseek-ai/dsh-client-ui-primitives` is stubbed (its own dependency graph —
 * shiki, katex, simple-icons — cannot load outside the browser bundle); the stub
 * keeps the same public shapes for the members this plugin consumes.
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
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
  writable: true,
})
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLInputElement = window.HTMLInputElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => window.clearTimeout(id)
/** React's act() gate; without it every render logs a "not configured" warning. */
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/** jsdom implements no layout, so the measurement APIs the picker uses are stubbed. */
window.Element.prototype.scrollIntoView = function scrollIntoView() {}
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 28, width: 320, height: 28, toJSON() {} }
}
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 320, configurable: true })
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 240, configurable: true })

const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { act } = require('react')

/* --- module-loader facade ---------------------------------------------------- */
let registration
window.__ModuleLoader__ = {
  load(record) {
    registration = record
  },
}
new Function('window', readFileSync(bundlePath, 'utf8'))(window)
if (registration === undefined) throw new Error('bundle registered no module')

const primitives = await import('./primitives-stub.mjs')
const mod = registration.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return require('react-dom')
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unresolved external: ${specifier}`)
})

/* --- test plumbing ----------------------------------------------------------- */
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const t = (key, params) => {
  const template = DICT[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}
let DICT = {}

let captured = null
let selectCalls = []
let loadCalls = 0

/** The directory store the component subscribes to; `set` re-renders the tree. */
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

const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register: (ns, dicts) => {
      DICT = dicts.zh
      return () => {}
    },
    bind: () => t,
  },
  inject: (names, cb) => {
    cb({
      slots: {
        inject: (key, fn) => {
          fn()
          return () => {}
        },
        register: (options, component) => {
          captured = { options, component }
          return () => {}
        },
      },
      modelDirectories: {
        directoryFor: () => ({
          store,
          load: async () => {
            loadCalls++
            return store.getSnapshot()
          },
          select: async (selection) => {
            selectCalls.push(selection)
            return { ok: true, value: undefined }
          },
        }),
      },
      sessions: { subagentAddress: () => undefined },
    })
  },
}

mod.apply(ctx)

/* --- fixtures ---------------------------------------------------------------- */
const baseSnapshot = () => ({
  current: { provider: 'command', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  routable: true,
  groups: [
    {
      id: 'deepseek-account',
      name: 'deepseek-account',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    {
      id: 'command',
      name: 'command',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1 Sol',
          reasoning: {
            defaultEffort: 'medium',
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
            ],
          },
        },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      ],
    },
    { id: 'shuai', name: 'shuai', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] },
  ],
  failures: [],
  status: 'ready',
  pending: null,
  error: null,
})

/* --- mount / teardown -------------------------------------------------------- */
const injected = captured.options.inject('session-1')
const container = document.getElementById('root')
let root

const $ = (sel) => container.querySelector(sel)
const menu = () => document.body.querySelector('.dmf_menu')
const m$ = (sel) => menu()?.querySelector(sel)
const m$$ = (sel) => [...(menu()?.querySelectorAll(sel) ?? [])]
const text = (el) => el?.textContent ?? ''

/** Tear the tree down and drop every portaled node a stale root may have left. */
async function unmount() {
  if (root !== undefined) {
    await act(async () => {
      root.unmount()
    })
    root = undefined
  }
  for (const stale of document.body.querySelectorAll('.dmf_menu')) stale.remove()
  for (const stale of document.body.querySelectorAll('[data-toast]')) stale.remove()
  container.innerHTML = ''
}

/** Mount a fresh tree over the given snapshot overrides (`props` is merged onto the component). */
async function mount(overrides = {}) {
  await unmount()
  const { props: propOverrides, ...snapshotOverrides } = overrides
  store.set({ ...baseSnapshot(), ...snapshotOverrides })
  await act(async () => {
    root = ReactDOMClient.createRoot(container)
    root.render(
      React.createElement(captured.component, { ...injected, locked: false, t, ...propOverrides }),
    )
  })
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
async function key(el, k) {
  await act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
async function type(input, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

/* --- contract ---------------------------------------------------------------- */
check('module id', registration.id === 'dsh-model-fold', registration.id)
check(
  'inject declaration',
  JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale', 'sessions']),
  JSON.stringify(mod.inject),
)
check('seat name', captured?.options?.name === 'conversation.input.model', captured?.options?.name)
check('shadow priority -1', captured?.options?.priority === -1, String(captured?.options?.priority))
check(
  'inject face keys',
  JSON.stringify(Object.keys(injected).sort()) ===
    JSON.stringify(['available', 'directory', 'load', 'select']),
  JSON.stringify(Object.keys(injected)),
)
check('style injected', document.querySelector('style[data-plugin-css="dsh-model-fold/ModelFold.css"]') !== null)

/* --- closed state ------------------------------------------------------------ */
await mount()
check('trigger rendered', $('.dmf_trigger') !== null)
check('trigger label = current model', text($('.dmf_triggerLabel')) === 'GPT-6.1 Sol', text($('.dmf_triggerLabel')))
check('trigger effort caption', text($('.dmf_triggerEffort')) === 'Medium', text($('.dmf_triggerEffort')))
check('menu closed initially', menu() === null)
check('aria-expanded false', $('.dmf_trigger').getAttribute('aria-expanded') === 'false')
check('load() not called before open', loadCalls === 0, String(loadCalls))

/* --- open: everything folded ------------------------------------------------- */
await click($('.dmf_trigger'))
check('menu opened', menu() !== null)
check('menu portaled to body', document.body.contains(menu()))
check('load() called on open', loadCalls === 1, String(loadCalls))
check('search row shown (>4 models)', m$('.dmf_searchRow') !== null)

const headers = m$$('.dmf_groupHeader')
check('one header per provider', headers.length === 3, String(headers.length))
check('account label localized', text(headers[0]) === 'DeepSeek 账号2', text(headers[0]))
check(
  'provider names shown',
  headers.some((x) => text(x).startsWith('command')) && headers.some((x) => text(x).startsWith('shuai')),
)
check('ALL providers folded on open', headers.every((x) => x.getAttribute('aria-expanded') === 'false'))
check('no model rows while folded', m$$('.dmf_model').length === 0, String(m$$('.dmf_model').length))
check('counts rendered', m$$('.dmf_groupCount').map(text).join(',') === '2,2,1', m$$('.dmf_groupCount').map(text).join(','))

/* --- expand one provider by clicking its name -------------------------------- */
const commandHeader = headers.find((x) => text(x).startsWith('command'))
await click(commandHeader)
check('command expanded', commandHeader.getAttribute('aria-expanded') === 'true')
check('command models visible', m$$('.dmf_model').length === 2, String(m$$('.dmf_model').length))
check(
  'expanded models are command models',
  m$$('.dmf_model').map(text).join('|') === 'GPT-6.1 Sol|GPT-6 Luna',
  m$$('.dmf_model').map(text).join('|'),
)
check(
  'other providers still folded',
  m$$('.dmf_groupHeader').filter((x) => x.getAttribute('aria-expanded') === 'true').length === 1,
)
check(
  'current model checked',
  m$$('.dmf_model').some((x) => x.getAttribute('aria-checked') === 'true' && text(x).includes('GPT-6.1 Sol')),
)
check('effort chips for current model', m$$('.dmf_chip').length === 3, String(m$$('.dmf_chip').length))
check(
  'current effort chip selected',
  m$$('.dmf_chip').some((x) => x.className.includes('dmf_chipSelected') && text(x) === 'Medium'),
)

/* --- collapse again ---------------------------------------------------------- */
await click(commandHeader)
check('command collapsed again', commandHeader.getAttribute('aria-expanded') === 'false')
check('models hidden after collapse', m$$('.dmf_model').length === 0)
// The effort row is a control for the ALREADY-selected model, not part of a
// provider's model list, so folding providers must not take it away.
check('effort row survives collapse', m$('.dmf_effortRow') !== null)

/* --- expanding a different provider ------------------------------------------ */
const shuaiHeader = m$$('.dmf_groupHeader').find((x) => text(x).startsWith('shuai'))
await click(shuaiHeader)
check('shuai expanded', m$$('.dmf_model').map(text).join('|') === 'glm-5.3', m$$('.dmf_model').map(text).join('|'))

/* --- selecting a model ------------------------------------------------------- */
selectCalls = []
await click(m$('.dmf_model'))
check('select called once', selectCalls.length === 1, JSON.stringify(selectCalls))
check(
  'selection payload',
  JSON.stringify(selectCalls[0]) === JSON.stringify({ provider: 'shuai', model: 'glm-5.3' }),
  JSON.stringify(selectCalls[0]),
)
check('menu closed after selection', menu() === null)

/* --- search overrides folding ------------------------------------------------ */
await click($('.dmf_trigger'))
const searchInput = m$('input')
check('search input present', searchInput !== null)
await type(searchInput, 'sol')
check('search shows matching model without expanding', m$$('.dmf_model').length === 1, String(m$$('.dmf_model').length))
check('search result is the match', text(m$$('.dmf_model')[0]) === 'GPT-6.1 Sol', text(m$$('.dmf_model')[0]))
check('non-matching providers hidden', m$$('.dmf_groupHeader').length === 1, String(m$$('.dmf_groupHeader').length))

await type(searchInput, 'zzzz')
check('no-match status shown', m$('.dmf_empty') !== null && text(m$('.dmf_empty')) === '没有匹配的模型。', text(m$('.dmf_empty')))
check('groups hidden when no match', m$('.dmf_groups').hasAttribute('hidden'))

await type(searchInput, '')
check('clearing search restores providers', m$$('.dmf_groupHeader').length === 3, String(m$$('.dmf_groupHeader').length))
check('clearing search re-folds', m$$('.dmf_model').length === 0, String(m$$('.dmf_model').length))

/* --- effort switch ----------------------------------------------------------- */
await type(searchInput, 'gpt-6.1')
await click(m$$('.dmf_model')[0])
check('selecting the current model closes', menu() === null)

await click($('.dmf_trigger'))
const highChip = m$$('.dmf_chip').find((x) => text(x) === 'High')
await click(highChip)
check(
  'effort switch payload',
  JSON.stringify(selectCalls[1]) ===
    JSON.stringify({ provider: 'command', model: 'gpt-6.1-sol', reasoningEffort: 'high' }),
  JSON.stringify(selectCalls[1]),
)

/* --- keyboard: Escape closes ------------------------------------------------- */
await click($('.dmf_trigger'))
check('menu open before Escape', menu() !== null)
await key($('.dmf_trigger'), 'Escape')
check('Escape closes menu', menu() === null)

/* --- keyboard: arrow moves focus across headers and rows --------------------- */
await click($('.dmf_trigger'))
await click(m$$('.dmf_groupHeader').find((x) => text(x).startsWith('command')))
const focusable = [...menu().querySelectorAll('button:not([disabled])')]
check('focusable controls include header + models + chips', focusable.length >= 6, String(focusable.length))
focusable[0].focus()
await key(focusable[0], 'ArrowDown')
check('ArrowDown advances focus', document.activeElement !== focusable[0])
check('ArrowDown lands on the next control', document.activeElement === focusable[1], document.activeElement?.textContent)

/* --- subagent session -------------------------------------------------------- */
await mount({ props: { available: false } })
check('subagent session renders nothing', container.innerHTML === '', container.innerHTML)

/* --- busy state -------------------------------------------------------------- */
await mount({ pending: { provider: 'command', model: 'gpt-6-luna' } })
check('busy shows spinner in trigger', $('.dmf_trigger').getAttribute('aria-busy') === 'true')
check('busy replaces chevron', $('.dmf_chevron') === null)
await click($('.dmf_trigger'))
check('rows disabled while busy', m$$('.dmf_groupHeader').every((x) => x.disabled))

/* --- locked state ------------------------------------------------------------ */
await mount({ props: { locked: true } })
check('locked disables trigger', $('.dmf_trigger').disabled === true)

/* --- error and failure surfaces ---------------------------------------------- */
await mount({ status: 'error', error: 'boom: catalog exploded', current: null })
await click($('.dmf_trigger'))
check('load error strip shown', m$('.dmf_error') !== null && text(m$('.dmf_error')).includes('catalog exploded'), text(m$('.dmf_error')))
check('retry button offered', m$('.dmf_retry') !== null)

await mount({ failures: [{ id: 'shuai', name: 'shuai', message: 'no credentials' }] })
await click($('.dmf_trigger'))
check(
  'provider failure warning shown',
  m$('.dmf_warning') !== null && text(m$('.dmf_warning')).includes('no credentials'),
  text(m$('.dmf_warning')),
)

/* --- single-provider catalog auto-expands ------------------------------------ */
await mount({
  groups: [{ id: 'only', name: 'only', models: [{ id: 'm1', name: 'Solo Model' }] }],
  current: { provider: 'only', model: 'm1' },
})
await click($('.dmf_trigger'))
check('single provider auto-expanded', m$$('.dmf_model').length === 1, String(m$$('.dmf_model').length))
check('single provider: no search field (<=4 models)', m$('.dmf_searchRow') === null)

/* --- no models at all -------------------------------------------------------- */
await mount({ groups: [], current: null, status: 'ready' })
await click($('.dmf_trigger'))
check('empty catalog status', m$('.dmf_empty') !== null && text(m$('.dmf_empty')) === '没有可用的模型。', text(m$('.dmf_empty')))

/* --- report ------------------------------------------------------------------ */
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || r.detail === undefined ? '' : `   <- ${r.detail}`}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
