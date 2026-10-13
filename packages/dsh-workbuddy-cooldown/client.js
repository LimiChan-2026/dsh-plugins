/**
 * dsh-workbuddy-cooldown — browser half.
 *
 * Shows which WorkBuddy models are rate-limited and when they recover, using
 * the wb2api account-pool panel's aggregated view.
 *
 * Two surfaces
 * ------------
 * 1. A card in `plugins.bundle.config`: the cooldown list (which model, how
 *    many accounts locked, when the pool recovers) plus account health.
 * 2. The model pickers: a cooling model's NAME is annotated with its recovery
 *    time, e.g. `Deepseek-V4.1-Flash ⏳21:30`. Annotation is chosen over hiding
 *    because the panel only represents its own account pool — the model may
 *    still be usable through accounts that are not locked — so the user should
 *    see the fact and decide, not lose the model silently.
 *
 * How the picker annotation works
 * -------------------------------
 * The composer seat and the `/model` popup both resolve the SAME
 * `ctx.modelDirectories.directoryFor(sessionId)` object, so wrapping that one
 * method covers both surfaces without touching either component. The wrapper
 * rewrites `name` in the projected snapshot; `select()`, `routable` and every
 * other field pass through untouched, so nothing else can change behaviour.
 *
 * The `name` rewrite must be deterministic and memoized —
 * `useSyncExternalStore` re-renders forever if `getSnapshot()` returns a fresh
 * object each read.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-cooldown',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const module = { exports: {} }
    const exports = module.exports

    /** Locale namespace this plugin owns. */
    const NS = 'workbuddy-cooldown'
    /** Style tag identity, so the modules runtime reclaims it on removal. */
    const STYLE_ID = 'dsh-workbuddy-cooldown/styles'
    /** Host route that serves the aggregated cooldown view. */
    const STATE_PATH = '/plugins/dsh-workbuddy-cooldown/state'

    /** Map the panel's realm to the DSH provider id that serves it. */
    const REALM_TO_PROVIDER = { cn: 'workbuddy', global: 'workbuddy-ai' }

    /** How often the card re-reads while it is open. */
    const CARD_REFRESH_MS = 20_000

    /**
     * The shared cooldown view, readable from outside any component.
     *
     * The picker wrapper runs inside `directoryFor`, which the shipped plugin
     * calls from its own render path, so the state cannot live in React.
     */
    const table = {
      view: undefined,
      error: undefined,
      revision: 0,
      listeners: new Set(),
      facades: new Set(),
    }

    /** Publish a new view to every subscriber. */
    function publish() {
      table.revision += 1
      for (const facade of table.facades) facade.invalidate()
      for (const listener of table.listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-workbuddy-cooldown] subscriber failed:', error)
        }
      }
    }

    /** Subscribe to view changes; returns the unsubscriber. */
    function subscribe(listener) {
      table.listeners.add(listener)
      return () => table.listeners.delete(listener)
    }

    /**
     * Read the aggregated view from the host half.
     *
     * A failed read keeps the previous view and reports the failure: a monitor
     * that silently went blank would look identical to "nothing is cooling".
     */
    async function refresh(signal) {
      const response = await fetch(STATE_PATH, { credentials: 'same-origin', signal })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) {
        table.error = typeof value?.error === 'string' ? value.error : `HTTP ${response.status}`
        table.revision += 1
        for (const listener of table.listeners) {
          try {
            listener()
          } catch {}
        }
        throw new Error(table.error)
      }
      table.view = value
      table.error = undefined
      publish()
      return value
    }

    /**
     * The cooldown entry for one DSH provider/model pair.
     *
     * Provider ids are matched against the panel realm (`workbuddy` ← cn,
     * `workbuddy-ai` ← global) so a model is only annotated by its own realm's
     * lock; the two endpoints share model ids and never state.
     *
     * @returns `{ untilMs, state, reason, available, total }` or `undefined`.
     */
    function cooldownFor(provider, model) {
      const view = table.view
      if (view === undefined) return undefined
      const realm = Object.entries(REALM_TO_PROVIDER).find(([, id]) => id === provider)?.[0]
      if (realm === undefined) return undefined
      return view.modelLocks?.find(
        (lock) => (lock.realm === '' || lock.realm === realm) && lock.model === model,
      )
    }

    /** Format an unlock time as a short local clock label. */
    function formatUnlock(untilMs, now) {
      if (typeof untilMs !== 'number') return undefined
      const date = new Date(untilMs)
      const sameDay = new Date(now).toDateString() === date.toDateString()
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
    }

    /** Human remaining time, e.g. `42m` or `3h 05m`. */
    function formatRemaining(ms) {
      if (ms <= 0) return null
      const totalMinutes = Math.ceil(ms / 60_000)
      if (totalMinutes < 60) return `${totalMinutes}m`
      const hours = Math.floor(totalMinutes / 60)
      return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`
    }

    /**
     * The annotated display name for one model.
     *
     * Appended rather than prefixed so fuzzy search still matches on the real
     * model name first (the pickers rank prefix and subsequence matches).
     */
    function annotate(name, cooldown, now) {
      if (cooldown === undefined) return name
      const label = formatUnlock(cooldown.earliestUnlockMs ?? cooldown.fullPoolUnlockMs, now)
      if (label === undefined) return `${name} ⏳`
      return `${name} ⏳${label}`
    }

    /**
     * Build the filtered/annotated view of one real directory.
     *
     * Mirrors the shipped directory's contract exactly: the composer seat is
     * handed `facade.store` and subscribes to THAT; the `/model` popup awaits
     * `facade.load()`; and the official workbuddy plugin's probe control calls
     * `facade.subscribe`/`facade.getSnapshot` DETACHED from the object, so none
     * of these may depend on `this`.
     *
     * @param real - the shipped `ModelDirectory` instance.
     */
    function facadeOf(real) {
      const state = { source: undefined, revision: -1, snapshot: undefined }
      /** Own subscribers: a cooldown change is invisible to the real store. */
      const listeners = new Set()
      const now = () => table.view?.fetchedAtMs ?? Date.now()

      function project(snapshot) {
        const view = table.view
        if (view === undefined || !Array.isArray(snapshot?.groups)) return snapshot
        let changed = false
        const groups = snapshot.groups.map((group) => {
          const models = Array.isArray(group?.models) ? group.models : []
          const next = models.map((model) => {
            const cooldown = cooldownFor(group.id, model?.id)
            if (cooldown === undefined) return model
            const annotated = annotate(model.name ?? model.id, cooldown, now())
            if (annotated === model.name) return model
            changed = true
            return { ...model, name: annotated }
          })
          if (next === models) return group
          return { ...group, models: next }
        })
        if (!changed) return snapshot
        return { ...snapshot, groups }
      }

      const facade = {
        /** Re-publish after a view change. */
        invalidate() {
          state.revision = -1
          for (const listener of listeners) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-workbuddy-cooldown] directory subscriber failed:', error)
            }
          }
        },
        getSnapshot() {
          const source = real.store.getSnapshot()
          if (state.source === source && state.revision === table.revision) return state.snapshot
          state.source = source
          state.revision = table.revision
          state.snapshot = project(source)
          return state.snapshot
        },
        subscribe(listener) {
          const unsubscribeReal = real.store.subscribe(listener)
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
            unsubscribeReal()
          }
        },
        async load() {
          const snapshot = await real.load()
          facade.invalidate()
          return project(snapshot)
        },
        select(selection) {
          return real.select(selection)
        },
        dispose() {
          real.dispose()
        },
        resetConnected() {
          return real.resetConnected()
        },
      }

      // The composer seat receives `directory.store`, not the facade itself.
      facade.store = {
        getSnapshot: () => facade.getSnapshot(),
        subscribe: (listener) => facade.subscribe(listener),
      }

      // Snapshot fields the shipped surfaces read off the directory.
      for (const key of ['current', 'routable', 'groups', 'failures', 'status', 'pending', 'error', 'retainedEffort']) {
        Object.defineProperty(facade, key, {
          get() {
            return facade.getSnapshot()?.[key]
          },
        })
      }

      table.facades.add(facade)
      return facade
    }

    /**
     * Patch `directoryFor` on the live resolver so every caller — the composer
     * seat, the `/model` popup, and the official workbuddy plugin's probe
     * control — sees the annotated view.
     *
     * This is foreign-state mutation; Cordis will not undo it. The original is
     * restored in this effect's disposer, and the patch lives inside
     * `ctx.inject(['modelDirectories'], …)` so a service reload re-applies it.
     */
    function intercept(scope) {
      const resolver = scope.modelDirectories
      const original = resolver.directoryFor
      if (typeof original !== 'function') return () => {}

      const facades = new WeakMap()
      resolver.directoryFor = (sessionId) => {
        const real = original.call(resolver, sessionId)
        const existing = facades.get(real)
        if (existing !== undefined) return existing
        const facade = facadeOf(real)
        facades.set(real, facade)
        return facade
      }

      return () => {
        resolver.directoryFor = original
      }
    }

    /** Inject the theme-token stylesheet once. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.wbc_card { display: flex; flex-direction: column; gap: 12px; }
.wbc_muted { color: var(--dsw-alias-label-caption); }
.wbc_secondary { color: var(--dsw-alias-label-secondary); }
.wbc_row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.wbc_row:first-child { border-top: none; }
.wbc_grow { flex: 1 1 auto; min-width: 0; }
.wbc_name { color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wbc_id { color: var(--dsw-alias-label-tertiary); font-size: 0.85em; }
.wbc_lock { color: var(--dsw-alias-state-warn-label); white-space: nowrap; }
.wbc_ok { color: var(--dsw-alias-label-dimmed); }
.wbc_error { color: var(--dsw-alias-state-error-primary); }
.wbc_group { margin-top: 8px; }
.wbc_groupName { color: var(--dsw-alias-label-secondary); margin: 8px 0 2px; }
.wbc_accounts { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.wbc_account { font-size: 0.9em; color: var(--dsw-alias-label-tertiary); }
.wbc_button {
  background: transparent; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  padding: 4px 8px; cursor: pointer;
}
.wbc_button:hover { background: var(--dsw-alias-interactive-bg-hover); }
`
      document.head.appendChild(style)
    }

    const zh = {
      title: 'WorkBuddy 429 冷却',
      intro: '数据来自 wb2api 账号池面板：哪些模型被限流（429）、冷却到几点恢复。模型名后带 ⏳ 的是冷却中，恢复后标注自动消失。',
      noLocks: '当前没有模型被限流。',
      locksHeading: '被限流的模型',
      accountsHeading: '账号池状态',
      earliestUnlock: '最早恢复',
      fullPoolUnlock: '全池恢复',
      lockedAccounts: '锁定账号',
      reason: '原因',
      state: '状态',
      cooling: '冷却中',
      fine: '正常',
      disabled: '已停用',
      loadFailed: '读取失败',
      unreachable: '面板不可达',
      notSignedIn: '未登录',
      refresh: '刷新',
      unknown: '未知',
    }

    const en = {
      title: 'WorkBuddy 429 cooldown',
      intro: 'Data from the wb2api account-pool panel: which models are rate-limited (429) and when they recover. A model whose name carries ⏳ is cooling; the marker disappears when it recovers.',
      noLocks: 'No model is currently rate-limited.',
      locksHeading: 'Rate-limited models',
      accountsHeading: 'Account pool',
      earliestUnlock: 'Earliest recovery',
      fullPoolUnlock: 'Full pool recovery',
      lockedAccounts: 'Locked accounts',
      reason: 'Reason',
      state: 'State',
      cooling: 'cooling',
      fine: 'healthy',
      disabled: 'disabled',
      loadFailed: 'Could not load',
      unreachable: 'panel unreachable',
      notSignedIn: 'not signed in',
      refresh: 'Refresh',
      unknown: 'unknown',
    }

    /** Interpolate `{name}` placeholders. */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
    }

    /** Short local time label for an epoch ms value. */
    const timeLabel = (ms) => formatUnlock(ms, Date.now())

    /** The management card. */
    function CooldownCard({ t }) {
      const [revision, setRevision] = useState(table.revision)
      const [busy, setBusy] = useState(false)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      useEffect(() => subscribe(() => setRevision(table.revision)), [])

      // Initial read, re-read on focus (another window may have triggered a 429),
      // and on a slow timer while the card stays open.
      useEffect(() => {
        const controller = new AbortController()
        refresh(controller.signal).catch(() => {})
        const onFocus = () => refresh().catch(() => {})
        window.addEventListener('focus', onFocus)
        const timer = setInterval(() => refresh().catch(() => {}), CARD_REFRESH_MS)
        return () => {
          controller.abort()
          window.removeEventListener('focus', onFocus)
          clearInterval(timer)
        }
      }, [])

      const onRefresh = useCallback(() => {
        setBusy(true)
        refresh()
          .catch(() => {})
          .finally(() => {
            if (mounted.current) setBusy(false)
          })
      }, [])

      // `revision` participates so the memo recomputes when the view changes.
      const view = useMemo(() => (revision, table.view), [table.view, revision])

      const header = h(
        'div',
        { className: 'wbc_row' },
        h('span', { className: 'wbc_grow' }, t('title')),
        h(
          'button',
          { type: 'button', className: 'wbc_button', disabled: busy, onClick: onRefresh },
          busy ? '…' : t('refresh'),
        ),
      )

      if (table.error !== undefined) {
        return h('div', { className: 'wbc_card' }, header, h('p', { className: 'wbc_error' }, `${t('loadFailed')}: ${table.error}`))
      }
      if (view === undefined) {
        return h('div', { className: 'wbc_card' }, header, h('p', { className: 'wbc_muted' }, '…'))
      }

      const locks = view.modelLocks ?? []
      const accounts = view.accounts ?? []

      return h(
        'div',
        { className: 'wbc_card' },
        header,
        h('p', { className: 'wbc_muted' }, t('intro')),
        locks.length === 0
          ? h('p', { className: 'wbc_ok' }, t('noLocks'))
          : h(
              'div',
              { className: 'wbc_group' },
              h('h4', { className: 'wbc_groupName' }, t('locksHeading')),
              locks.map((lock) => {
                const provider = REALM_TO_PROVIDER[lock.realm] ?? lock.realm
                const unlock = lock.earliestUnlockMs ?? lock.fullPoolUnlockMs
                return h(
                  'div',
                  { key: `${lock.realm}/${lock.model}`, className: 'wbc_row' },
                  h(
                    'span',
                    { className: 'wbc_grow' },
                    h('div', { className: 'wbc_name' }, lock.model),
                    h('div', { className: 'wbc_id' }, `${provider} · ${t('state')}: ${lock.state || t('unknown')}${lock.reason ? ` · ${t('reason')}: ${lock.reason}` : ''}`),
                  ),
                  h(
                    'span',
                    { className: 'wbc_lock' },
                    unlock === undefined && lock.fullPoolUnlockMs === undefined
                      ? '⏳'
                      : `${t('earliestUnlock')} ${timeLabel(lock.earliestUnlockMs)}${lock.fullPoolUnlockMs ? ` · ${t('fullPoolUnlock')} ${timeLabel(lock.fullPoolUnlockMs)}` : ''}`,
                  ),
                )
              }),
            ),
        h(
          'div',
          { className: 'wbc_group' },
          h('h4', { className: 'wbc_groupName' }, `${t('accountsHeading')} (${view.panelTotal ?? accounts.length})`),
          h(
            'div',
            { className: 'wbc_accounts' },
            accounts.map((account) => {
              const label = account.nickname || account.uid.slice(0, 8)
              const state = account.disabled
                ? t('disabled')
                : account.cooling
                  ? `${t('cooling')}${account.untilMs ? ` · ${timeLabel(account.untilMs)}` : ''}`
                  : t('fine')
              return h(
                'span',
                { key: account.uid, className: 'wbc_account' },
                `${label} · ${account.realm} · ${state}`,
              )
            }),
          ),
        ),
      )
    }

    /** Required services for the client half. */
    const inject = ['slots', 'locale']

    /**
     * Client plugin body: register dictionaries, wrap the shared directory, and
     * publish the card.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workbuddy-cooldown: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.inject(['modelDirectories'], (scope) => {
        scope.effect(() => {
          const restore = intercept(scope)
          refresh().catch(() => {})
          const onFocus = () => refresh().catch(() => {})
          window.addEventListener('focus', onFocus)
          return () => {
            window.removeEventListener('focus', onFocus)
            restore()
          }
        }, 'workbuddy-cooldown: directory annotation')
      })

      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-workbuddy-cooldown',
            locale: NS,
            inject: () => ({ t }),
          },
          CooldownCard,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
