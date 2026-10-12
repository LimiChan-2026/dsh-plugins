/**
 * dsh-model-lock — browser half.
 *
 * Filters locked models out of BOTH model pickers by intercepting the one
 * object they already share.
 *
 * How the filter works
 * --------------------
 * `@deepseek-ai/dsh-client-ui-model-selection` registers the `modelDirectories`
 * service, and both user-facing surfaces resolve their data through its single
 * `directoryFor(sessionId)` method: the `/model` command popup calls it for its
 * options, and the composer's `conversation.input.model` seat receives the very
 * same directory instance. Wrapping that ONE method therefore covers both
 * surfaces at once, without touching either of them.
 *
 * Shadowing the composer slot is deliberately NOT used: `dsh-model-fold`
 * already occupies it at `priority: -1`, and a second registration on a single
 * slot throws. The data seam is also strictly better — it fixes the `/model`
 * popup too, which a seat shadow cannot reach.
 *
 * What "locked" means
 * -------------------
 * Soft lock. A locked model disappears from the pickers, but a session already
 * using it keeps running: `directory.select()` is delegated untouched, and
 * `routable` is passed through verbatim. Recomputing `routable` after filtering
 * would make a session whose current model is locked report itself unroutable,
 * which is exactly the interruption a soft lock must not cause.
 *
 * Caveats worth knowing
 * ---------------------
 * This is foreign-state mutation: `directoryFor` belongs to another plugin, and
 * Cordis will not undo the patch for us. Two consequences are handled
 * explicitly — the original method is restored in our own `ctx.effect`
 * disposer, and the patch lives inside `ctx.inject(['modelDirectories'], …)` so
 * that a service reload (which re-evaluates injected fibers) re-applies it.
 *
 * Empty groups stay hidden, which the shipped layers already guarantee: the
 * Host drops model-less groups when it builds the catalog, and the client drops
 * them again before rendering. Locking every model of a provider therefore
 * removes that provider's group from both pickers.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-lock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const module = { exports: {} }
    const exports = module.exports

    /** Locale namespace this plugin owns. */
    const NS = 'model-lock'
    /** Injected style element identity, so the modules runtime reclaims it. */
    const STYLE_ID = 'dsh-model-lock/styles'
    /** Routes published by the host half. */
    const STATE_PATH = '/plugins/dsh-model-lock/state'
    const LOCK_PATH = '/plugins/dsh-model-lock/lock'

    /**
     * Duration presets the card offers, in milliseconds. `null` means "until I
     * unlock it".
     *
     * The week and month entries are longer than a browser timer can express in
     * one shot, which is exactly why `scheduleExpiry` clamps and re-arms rather
     * than trusting a single `setTimeout`.
     */
    const DURATIONS = [
      { key: 'forever', ms: null },
      { key: '30m', ms: 30 * 60 * 1000 },
      { key: '2h', ms: 2 * 60 * 60 * 1000 },
      { key: '8h', ms: 8 * 60 * 60 * 1000 },
      { key: '24h', ms: 24 * 60 * 60 * 1000 },
      { key: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
      { key: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
    ]

    /** Join a provider and model id into the one key the lock table uses. */
    function lockKey(provider, model) {
      return `${provider}\u0000${model}`
    }

    /**
     * The lock table the browser half filters with.
     *
     * Kept as a module-level singleton rather than React state: the filter runs
     * inside `directoryFor`, which is called by the shipped plugin outside any
     * component, so the list has to be readable from there.
     */
    const table = {
      /** `Map<lockKey, {untilMs, lockedAtMs}>` for locks in force. */
      locks: new Map(),
      /** Model catalog for the management card, as last read from the host. */
      catalog: [],
      /** Why the last host read failed, if it did. */
      error: undefined,
      /** Bumped on every change so subscribers can re-read. */
      revision: 0,
      listeners: new Set(),
      /** Entities whose snapshot facade must be invalidated on a change. */
      directories: new Set(),
    }

    /** Pending timer for the nearest deadline, so a temporary lock unlocks itself. */
    let expiryTimer

    /**
     * Largest delay a browser timer accepts. `setTimeout` stores its delay in a
     * 32-bit signed integer, so anything above this overflows and fires
     * immediately — which for a long lock would unlock the model at once.
     */
    const MAX_TIMER_DELAY = 2 ** 31 - 1

    /**
     * Arm a timer for the earliest deadline in the table.
     *
     * A temporary lock must stop hiding its model at the moment it expires, not
     * the next time something happens to re-read the table — and the card is not
     * necessarily open. One timer aimed at the nearest deadline does that
     * exactly, without polling: when it fires, the sweep removes whatever has
     * expired and the timer is re-armed for whatever is now next.
     *
     * A deadline further away than the largest representable delay is clamped
     * and simply re-armed when the clamp expires, so a lock of any length is
     * safe.
     */
    function scheduleExpiry() {
      if (expiryTimer !== undefined) {
        clearTimeout(expiryTimer)
        expiryTimer = undefined
      }
      let earliest = null
      for (const lock of table.locks.values()) {
        if (lock.untilMs === null) continue
        if (earliest === null || lock.untilMs < earliest) earliest = lock.untilMs
      }
      if (earliest === null) return
      // A small margin keeps the timer from firing a hair early on a coarse clock.
      const delay = Math.max(0, earliest - Date.now()) + 50
      expiryTimer = setTimeout(
        () => {
          expiryTimer = undefined
          sweepExpired(Date.now())
          // Re-arm unconditionally: the clamp above can fire long before the
          // real deadline, and a sweep that changed nothing publishes nothing.
          scheduleExpiry()
        },
        Math.min(delay, MAX_TIMER_DELAY),
      )
    }

    /** Stop the expiry timer; called when the plugin unloads. */
    function cancelExpiry() {
      if (expiryTimer === undefined) return
      clearTimeout(expiryTimer)
      expiryTimer = undefined
    }

    /** Notify every subscriber that the table changed. */
    function publish() {
      table.revision += 1
      for (const directory of table.directories) directory.invalidate()
      for (const listener of table.listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-model-lock] subscriber failed:', error)
        }
      }
      scheduleExpiry()
    }

    /** Subscribe to table changes; returns the unsubscriber. */
    function subscribeTable(listener) {
      table.listeners.add(listener)
      return () => table.listeners.delete(listener)
    }

    /** Whether one `provider/model` pair is locked right now. */
    function isLocked(provider, model) {
      return table.locks.has(lockKey(provider, model))
    }

    /**
     * Read the table and the model catalog from the host.
     *
     * A failed read leaves the previous table in place rather than clearing it:
     * a transient fetch error must not silently un-hide every locked model.
     */
    async function refresh(signal) {
      const response = await fetch(STATE_PATH, { credentials: 'same-origin', signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json()
      const now = typeof value.now === 'number' ? value.now : Date.now()
      const next = new Map()
      for (const lock of Array.isArray(value.locks) ? value.locks : []) {
        if (typeof lock?.provider !== 'string' || typeof lock?.model !== 'string') continue
        // A lock with no deadline is kept; a deadline already in the past is
        // dropped here so a stale response cannot re-hide a model.
        if (lock.untilMs !== null && !(typeof lock.untilMs === 'number' && lock.untilMs > now)) continue
        next.set(lockKey(lock.provider, lock.model), { untilMs: lock.untilMs, lockedAtMs: lock.lockedAtMs })
      }
      table.locks = next
      table.catalog = Array.isArray(value.catalog) ? value.catalog : []
      table.error = undefined
      publish()
      return value
    }

    /** Write one lock change and adopt the host's answer. */
    async function writeLock(provider, model, locked, durationMs) {
      const response = await fetch(LOCK_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider, model, locked, durationMs }),
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(typeof value?.error === 'string' ? value.error : `HTTP ${response.status}`)
      }
      const now = typeof value.now === 'number' ? value.now : Date.now()
      const next = new Map()
      for (const lock of Array.isArray(value.locks) ? value.locks : []) {
        next.set(lockKey(lock.provider, lock.model), { untilMs: lock.untilMs, lockedAtMs: lock.lockedAtMs })
      }
      table.locks = next
      publish()
      return value
    }

    /** Drop locks whose deadline passed while the page sat open. */
    function sweepExpired(now) {
      let changed = false
      for (const [key, lock] of table.locks) {
        if (lock.untilMs !== null && lock.untilMs <= now) {
          table.locks.delete(key)
          changed = true
        }
      }
      if (changed) publish()
      return changed
    }

    /**
     * Build the filtered view of one real directory.
     *
     * The snapshot is rebuilt only when the underlying snapshot or the lock
     * table actually changed, because `useSyncExternalStore` treats a new object
     * identity as a state change: returning a fresh object every read would
     * re-render forever.
     *
     * @param real - the shipped `ModelDirectory` instance.
     */
    function facadeOf(real) {
      const state = { source: undefined, revision: -1, snapshot: undefined }

      /** Drop locked models, then groups left with nothing to offer. */
      function project(snapshot) {
        if (table.locks.size === 0) return snapshot
        if (snapshot === null || typeof snapshot !== 'object') return snapshot
        const groups = Array.isArray(snapshot.groups) ? snapshot.groups : []
        const kept = []
        let removed = false
        for (const group of groups) {
          const models = Array.isArray(group?.models) ? group.models : []
          const visible = models.filter((model) => !isLocked(group.id, model?.id))
          if (visible.length === models.length) {
            kept.push(group)
            continue
          }
          removed = true
          if (visible.length > 0) kept.push({ ...group, models: visible })
        }
        if (!removed) return snapshot
        // `routable` is passed through verbatim: it answers "is this session's
        // current model still routable", and filtering must not turn an
        // already-locked model into a blocked send.
        return { ...snapshot, groups: kept }
      }

      const facade = {
        /** Invalidate the memoized snapshot after a table change. */
        invalidate() {
          state.revision = -1
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
          return real.store.subscribe(listener)
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

      // `directory`/`failures`/`current` are read off the snapshot by the
      // shipped surfaces; expose them as getters delegating to the filtered view.
      for (const key of ['current', 'routable', 'groups', 'failures', 'status', 'pending', 'error', 'retainedEffort']) {
        Object.defineProperty(facade, key, {
          get() {
            return facade.getSnapshot()?.[key]
          },
        })
      }

      table.directories.add(facade)
      return facade
    }

    /**
     * Patch `directoryFor` on the live resolver so every caller — the composer
     * seat and the `/model` popup alike — receives a filtered directory.
     *
     * @param scope - context carrying the `modelDirectories` service.
     * @returns a disposer restoring the original method.
     */
    function intercept(scope) {
      const resolver = scope.modelDirectories
      const original = resolver.directoryFor
      if (typeof original !== 'function') return () => {}

      // One facade per real directory, so the composer and the popup share the
      // exact same object identity across calls.
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
        facades.delete?.()
      }
    }

    //#region styles

    /** Theme tokens only, so light/dark both work without a second palette. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dml_card { display: flex; flex-direction: column; gap: 12px; }
.dml_muted { color: var(--dsw-alias-label-caption); }
.dml_row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dml_row:first-child { border-top: none; }
.dml_grow { flex: 1 1 auto; min-width: 0; }
.dml_name { color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dml_id { color: var(--dsw-alias-label-tertiary); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dml_group { margin-top: 8px; }
.dml_groupName { color: var(--dsw-alias-label-secondary); margin: 8px 0 2px; }
.dml_select, .dml_button {
  background: transparent; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  padding: 4px 8px; cursor: pointer;
}
.dml_select:hover, .dml_button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dml_button:disabled, .dml_select:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dml_button[data-danger="true"]:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dml_lock { color: var(--dsw-alias-state-warn-label); white-space: nowrap; }
.dml_error { color: var(--dsw-alias-state-error-primary); }
`
      document.head.appendChild(style)
    }

    //#endregion

    //#region dictionaries

    const zh = {
      title: '模型锁池',
      intro: '锁掉的模型会从模型选择器和 /model 弹窗里消失；已经在用该模型的会话不受影响。',
      forever: '锁到手动解锁',
      remaining: '剩余',
      expired: '已到期',
      lock: '锁定',
      unlock: '解锁',
      duration: '锁定时长',
      noModels: '当前没有可用的模型。',
      loadFailed: '读取失败',
      writeFailed: '保存失败',
      lockedCount: '已锁定 {count} 个模型',
      providerFailed: '该供应商目录读取失败：{message}',
      refresh: '刷新',
      writeFailedDetail: '没有保存成功，锁池未改变。',
      until: '解锁时间',
    }

    const en = {
      title: 'Model lock pool',
      intro: 'Locked models disappear from the model picker and the /model popup; sessions already using one keep working.',
      forever: 'Until I unlock it',
      remaining: 'Left',
      expired: 'Expired',
      lock: 'Lock',
      unlock: 'Unlock',
      duration: 'Lock for',
      noModels: 'No models are available right now.',
      loadFailed: 'Could not load',
      writeFailed: 'Could not save',
      lockedCount: '{count} model(s) locked',
      providerFailed: 'This provider failed to load: {message}',
      refresh: 'Refresh',
      writeFailedDetail: 'Nothing was saved; the lock pool is unchanged.',
      until: 'Unlocks at',
    }

    //#endregion

    //#region formatting

    /** Render a remaining duration compactly. */
    function formatRemaining(ms) {
      if (ms === null) return null
      if (ms <= 0) return '0s'
      const totalSeconds = Math.floor(ms / 1000)
      if (totalSeconds < 60) return `${totalSeconds}s`
      const minutes = Math.floor(totalSeconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ''}`
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }

    /** Interpolate `{name}` placeholders in a dictionary string. */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
    }

    //#endregion

    /**
     * The management card: every provider's models, each with a lock control.
     *
     * Mounted in `plugins.bundle.config`, which the Plugins panel renders per
     * bundle. The model list comes from the Host through the state route,
     * because a root-scoped card has no session and therefore cannot read the
     * per-session client directory.
     */
    function ModelLockPage({ t }) {
      const [revision, setRevision] = useState(table.revision)
      const [pending, setPending] = useState(new Set())
      const [failure, setFailure] = useState(undefined)
      const [durations, setDurations] = useState({})
      const [now, setNow] = useState(() => Date.now())
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      // Adopt the shared table as external state.
      useEffect(() => subscribeTable(() => setRevision(table.revision)), [])

      // Initial read, plus a re-read whenever the window regains focus, which is
      // when a lock made in another window should become visible here.
      useEffect(() => {
        const controller = new AbortController()
        refresh(controller.signal).catch((error) => {
          if (mounted.current && controller.signal.aborted !== true) {
            setFailure(error instanceof Error ? error.message : String(error))
          }
        })
        const onFocus = () => {
          refresh().catch(() => {})
        }
        window.addEventListener('focus', onFocus)
        return () => {
          controller.abort()
          window.removeEventListener('focus', onFocus)
        }
      }, [])

      // A one-second tick drives both the countdowns and expiry, so a lock that
      // runs out while the card is open unlocks itself without a reload.
      useEffect(() => {
        const timer = setInterval(() => {
          const current = Date.now()
          setNow(current)
          sweepExpired(current)
        }, 1000)
        return () => clearInterval(timer)
      }, [])

      const catalog = table.catalog
      const lockedCount = table.locks.size

      const onToggle = useCallback(
        (provider, model, locked) => {
          const key = lockKey(provider, model)
          setPending((previous) => new Set(previous).add(key))
          setFailure(undefined)
          const chosen = durations[key]
          writeLock(provider, model, locked, locked ? chosen ?? null : null)
            .catch((error) => {
              if (mounted.current) {
                setFailure(`${t('writeFailed')}: ${error instanceof Error ? error.message : String(error)} — ${t('writeFailedDetail')}`)
              }
            })
            .finally(() => {
              if (!mounted.current) return
              setPending((previous) => {
                const next = new Set(previous)
                next.delete(key)
                return next
              })
            })
        },
        [durations, t],
      )

      const onDuration = useCallback((key, value) => {
        setDurations((previous) => ({ ...previous, [key]: value }))
      }, [])

      // `revision` participates so the memo recomputes when the table changes.
      const rows = useMemo(() => (revision, catalog), [catalog, revision])

      return h(
        'div',
        { className: 'dml_card' },
        h('p', { className: 'dml_muted' }, t('intro')),
        h(
          'div',
          { className: 'dml_muted' },
          t('lockedCount').replace('{count}', String(lockedCount)),
        ),
        failure === undefined ? null : h('p', { className: 'dml_error' }, failure),
        rows.length === 0 ? h('p', { className: 'dml_muted' }, t('noModels')) : null,
        rows.map((entry) =>
          h(
            'div',
            { key: entry.provider, className: 'dml_group' },
            h('h4', { className: 'dml_groupName' }, entry.name ?? entry.provider),
            entry.error === undefined
              ? null
              : h('p', { className: 'dml_error' }, fill(t('providerFailed'), { message: entry.error })),
            entry.models.map((model) => {
              const key = lockKey(entry.provider, model.id)
              const lock = table.locks.get(key)
              const locked = lock !== undefined
              const remaining = lock === undefined ? null : lock.untilMs === null ? null : Math.max(0, lock.untilMs - now)
              const busy = pending.has(key)
              const value = durations[key] === undefined ? 'forever' : durations[key]
              return h(
                'div',
                { key, className: 'dml_row' },
                h(
                  'span',
                  { className: 'dml_grow' },
                  h('div', { className: 'dml_name' }, model.name ?? model.id),
                  h('div', { className: 'dml_id' }, `${entry.provider}/${model.id}`),
                ),
                locked
                  ? h(
                      'span',
                      { className: 'dml_lock' },
                      remaining === null ? t('forever') : `${t('remaining')} ${formatRemaining(remaining)}`,
                    )
                  : h(
                      'select',
                      {
                        className: 'dml_select',
                        value: String(value),
                        disabled: busy,
                        onChange: (event) => {
                          const raw = event.target.value
                          const preset = DURATIONS.find((item) => String(item.ms) === raw)
                          onDuration(key, preset === undefined ? null : preset.ms)
                        },
                      },
                      DURATIONS.map((item) =>
                        h('option', { key: item.key, value: String(item.ms) }, t(item.key === 'forever' ? 'forever' : item.key)),
                      ),
                    ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dml_button',
                    disabled: busy,
                    'data-danger': locked ? 'true' : 'false',
                    onClick: () => onToggle(entry.provider, model.id, !locked),
                  },
                  locked ? t('unlock') : t('lock'),
                ),
              )
            }),
          ),
        ),
      )
    }

    /**
     * Required services: the slot registry for the card, the locale face for its
     * dictionaries, and the model directory service the filter wraps.
     *
     * `modelDirectories` is deliberately NOT listed here — it is awaited through
     * `ctx.inject` below, so the plugin still loads (and simply filters nothing)
     * in a profile where the model-selection plugin is absent.
     */
    const inject = ['slots', 'locale']

    /**
     * Client plugin body: register dictionaries, patch the shared directory
     * resolver, and publish the management card.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-model-lock: dictionaries')
      const t = ctx.locale.bind(NS)

      // The filter is installed inside `ctx.inject` so that a service reload
      // re-evaluates this callback and the patch is re-applied to the new
      // resolver instance.
      ctx.inject(['modelDirectories'], (scope) => {
        scope.effect(() => {
          const restore = intercept(scope)
          // Adopt the host's table immediately; until it answers, nothing is
          // locked, which is the safe default (no model is hidden by accident).
          refresh().catch(() => {})
          // The table belongs to the profile, not to this window: a second
          // window (a remote Web UI over the same profile) can change it, so
          // re-read whenever this one regains focus and the two agree.
          const onFocus = () => {
            refresh().catch(() => {})
          }
          window.addEventListener('focus', onFocus)
          return () => {
            window.removeEventListener('focus', onFocus)
            cancelExpiry()
            restore()
          }
        }, 'dsh-model-lock: directory filter')
      })

      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-model-lock',
            locale: NS,
            inject: () => ({ t }),
          },
          ModelLockPage,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
