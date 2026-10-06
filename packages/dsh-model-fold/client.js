/**
 * dsh-model-fold — browser half.
 *
 * Replaces the composer's model seat (`conversation.input.model`) with the same
 * picker, except that every provider is a COLLAPSED accordion row: the menu opens
 * showing only provider names, and one provider's models appear when its name is
 * clicked. Clicking the open provider again folds it back.
 *
 * How the shadow works
 * --------------------
 * `conversation.input.model` is a `single` slot. The shipped
 * `@deepseek-ai/dsh-client-ui-model-selection` occupies it at priority 0, and the
 * slot registry refuses a second registration at the same priority — so this
 * bundle registers at `priority: -1`, the lowest priority, which is the entry the
 * renderer picks ("lowest renders"). Disabling this plugin hands the seat straight
 * back to the shipped component; nothing is patched, wrapped, or mutated.
 *
 * Data contract
 * -------------
 * The component never talks to the Host. It renders the per-session directory
 * `ctx.modelDirectories.directoryFor(sessionId)` owns — the SAME instance the
 * shipped seat and the `/model` command use — so a switch made here is what every
 * other surface shows next. `inject(sessionId)` returns exactly the four keys the
 * shipped registration returns (`available`, `directory`, `load`, `select`), and
 * the directory snapshot is read verbatim:
 *
 *   { current, routable, groups, failures, status, pending, error, retainedEffort? }
 *
 * `current` is `{ provider, model, reasoningEffort? }`; `groups` is
 * `[{ id, name, models: [{ id, name, description?, reasoning? }] }]`; `select()`
 * resolves `{ ok: true }` or the raw `{ ok: false, error }` Remote failure.
 *
 * Presentation
 * ------------
 * Hand-authored bundle: no build step, so markup is `React.createElement` and the
 * stylesheet is one injected `<style>` keyed on the `.dmf_` prefix and built from
 * the harness's own design tokens. The two `--dsh-composer-model-*` display
 * variables are honoured, so the seat still collapses to an icon-only trigger when
 * the composer tool row runs out of width.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-fold',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const {
      useCallback,
      useEffect,
      useId,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React

    const {
      Input,
      MenuSurface,
      StateDot,
      Toast,
      rankByName,
      IconCheckOutlineRegular,
      IconChevronDownOutlineRegular,
      IconChevronRightOutlineRegular,
      IconCloseFillRegular,
      IconDataOutlineRegular,
      IconWarningOutlineRegular,
    } = primitives

    const module = { exports: {} }
    const exports = module.exports

    /** Locale namespace this plugin owns (deliberately NOT the shipped `model` one). */
    const NS = 'model-fold'
    /** Style tag identity, so the modules runtime can reclaim it on plugin removal. */
    const STYLE_TAG = 'dsh-model-fold/ModelFold.css'
    /**
     * Unplaced portal card: hidden but laid out at a fixed origin, so the first
     * measure pass reads real `offsetWidth`/`offsetHeight` before placement.
     */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    /** Viewport inset kept by the placed menu. */
    const MARGIN = 12
    /** Catalog size above which the picker shows its search field. */
    const SEARCH_THRESHOLD = 4

    /* ------------------------------------------------------------------ styles */

    const CSS = `
.dmf_root{min-width:0;position:relative}
.dmf_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex}
.dmf_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dmf_trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dmf_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dmf_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dmf_triggerEffort{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000;overflow:hidden}
.dmf_triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:none}
.dmf_triggerLabel,.dmf_triggerEffort{display:var(--dsh-composer-model-text-display,block)}
.dmf_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
.dmf_chevronOpen{transform:rotate(180deg)}
.dmf_menu{z-index:1100;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(260px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(420px,100vh - 96px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex-direction:column;padding:4px;display:flex;position:fixed;overflow:hidden}
.dmf_status,.dmf_empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}
.dmf_error,.dmf_warning{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;padding:6px 7px;font-size:11px;line-height:16px;display:flex}
.dmf_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}
.dmf_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}
.dmf_searchRow{flex-shrink:0;margin:2px 0 3px;position:relative}
.dmf_searchRow .dmf_search{border-radius:var(--dsw-radius-md);background:0 0;border:0 solid #0000;height:auto;padding:5px 7px;display:flex}
.dmf_searchRow .dmf_searchWithQuery{padding-right:34px}
.dmf_searchRow .dmf_search input{padding:0;font-size:12px;line-height:normal}
.dmf_searchRow .dmf_search input::placeholder{color:var(--dsw-alias-label-caption)}
.dmf_searchClear{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}
.dmf_searchClear:hover,.dmf_searchClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dmf_effortRow{border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center;gap:4px 6px;margin:0 0 4px;padding:2px 7px 7px;display:flex}
.dmf_effortLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:none}
.dmf_effortChips{flex-wrap:wrap;gap:4px;min-width:0;display:flex}
.dmf_chip{border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;outline:none;padding:2px 7px;font-size:11px;line-height:16px}
.dmf_chip:hover:not(:disabled),.dmf_chip:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dmf_chipSelected{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dmf_chip:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dmf_groups{min-height:0;overflow-y:auto}
.dmf_group{display:flex;flex-direction:column}
.dmf_groupHeader{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:100%;min-height:34px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;font-size:13px;font-weight:500;line-height:18px;display:flex}
.dmf_groupHeader:hover,.dmf_groupHeader:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dmf_groupHeader:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dmf_groupChevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
.dmf_groupChevronOpen{transform:rotate(90deg)}
.dmf_groupName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}
.dmf_groupCount{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;flex:none}
.dmf_models{flex-direction:column;display:flex}
.dmf_model{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;min-height:32px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px 5px 21px;display:flex}
.dmf_model:hover:not(:disabled),.dmf_model:focus-visible,.dmf_modelActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dmf_model:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dmf_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px;flex:1;min-width:0;overflow:hidden}
.dmf_check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}
.dmf_check svg{width:14px;height:14px}
`

    /** Inject the stylesheet once; the tag is reclaimable by the modules runtime. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-model-fold'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ----------------------------------------------------------------- helpers */

    /**
     * Put the account and official providers first, preserving every other relative
     * order. Mirrors the shipped picker so both entries agree on the directory.
     * @param groups - provider groups in catalog order.
     * @returns a sorted copy; model order within each group is unchanged.
     */
    function orderModelProviders(groups) {
      const rank = (id) => (id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2)
      return [...groups].sort((left, right) => rank(left.id) - rank(right.id))
    }

    /* --------------------------------------------------------------- component */

    /**
     * Render the composer model seat with collapsible provider groups.
     * @param props - owner share (`locked`) + injected face + the locale seat.
     * @returns the trigger and, while open, the accordion menu.
     */
    function ModelFold({ locked, available, directory, load, select, t }) {
      const state = useSyncExternalStore(
        (fn) => directory.subscribe(fn),
        () => directory.getSnapshot(),
      )

      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [expandedId, setExpandedId] = useState(null)
      const [highlightedIndex, setHighlightedIndex] = useState(null)
      const [selectionFocus, setSelectionFocus] = useState(false)
      const [toast, setToast] = useState(null)
      const [menuPos, setMenuPos] = useState(null)

      const toastSeq = useRef(0)
      const lastActionRef = useRef('load')
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const searchRef = useRef(null)
      const menuRef = useRef(null)
      const modelRefs = useRef([])
      const id = useId()

      const groups = useMemo(() => orderModelProviders(state.groups), [state.groups])
      const choices = useMemo(
        () => groups.flatMap((group) => group.models.map((model) => ({ group, model }))),
        [groups],
      )
      const showSearch = choices.length > SEARCH_THRESHOLD
      const trimmed = query.trim()
      const searching = trimmed !== ''

      /**
       * Providers that still hold a match, with their models ranked by the query.
       * An empty query returns every provider in catalog order.
       */
      const filteredGroups = useMemo(
        () =>
          groups
            .map((group) => ({
              ...group,
              models: rankByName(group.models, showSearch ? trimmed : ''),
            }))
            .filter((group) => group.models.length > 0),
        [groups, trimmed, showSearch],
      )

      /** Every visible model in render order — the index space of `highlightedIndex`. */
      const visibleModels = useMemo(
        () =>
          filteredGroups.flatMap((group) =>
            group.models.map((model) => ({ provider: group.id, model: model.id })),
          ),
        [filteredGroups],
      )

      const activeModelIndex = Math.min(
        highlightedIndex ?? 0,
        Math.max(0, visibleModels.length - 1),
      )

      const currentChoice = useMemo(() => {
        if (state.current === null) return undefined
        return choices.find(
          (choice) =>
            choice.group.id === state.current.provider && choice.model.id === state.current.model,
        )
      }, [choices, state.current])

      const reasoning = currentChoice?.model.reasoning
      const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel =
        reasoning === undefined
          ? state.retainedEffort
          : effectiveEffort === undefined
            ? t('effort.providerDefault')
            : (reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ??
              effectiveEffort)

      const effortChoices = useMemo(
        () =>
          reasoning === undefined
            ? []
            : [
                ...(reasoning.defaultEffort === undefined
                  ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
                  : []),
                ...reasoning.efforts.map((effort) => ({
                  key: `effort:${effort.id}`,
                  effort: effort.id,
                  label: effort.name,
                })),
              ],
        [reasoning, t],
      )

      const pending = state.pending
      const busy = pending !== null

      /**
       * Which provider is open. A search overrides the folded state and shows every
       * provider that still matches, so results are never hidden behind a header.
       */
      const isGroupOpen = (groupId) => (searching ? true : expandedId === groupId)

      const reload = useCallback(() => {
        lastActionRef.current = 'load'
        load()
      }, [load])

      const show = () => {
        setSelectionFocus(false)
        triggerRef.current?.focus()
        setQuery('')
        setHighlightedIndex(null)
        // Open fully folded; a single-provider catalog has nothing to fold.
        setExpandedId(groups.length === 1 ? groups[0].id : null)
        setOpen(true)
        reload()
      }

      const close = (restoreFocus = false) => {
        setOpen(false)
        if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus())
      }

      /** Fold/unfold one provider; during a search this also drops the query. */
      const toggleProvider = (groupId) => {
        setHighlightedIndex(null)
        if (searching) {
          setQuery('')
          setExpandedId(groupId)
          return
        }
        setExpandedId((current) => (current === groupId ? null : groupId))
      }

      const submit = (selection) => {
        lastActionRef.current = 'select'
        setSelectionFocus(true)
        triggerRef.current?.focus()
        Promise.resolve(select(selection)).then((settled) => {
          if (settled === undefined) return
          if (settled.ok) {
            if (rootRef.current !== null) {
              setSelectionFocus(true)
              close(true)
            }
            return
          }
          const error = settled.error
          toastSeq.current += 1
          setToast({
            seq: toastSeq.current,
            text:
              error.code === 'session/writer-held'
                ? t('error.sessionInUse')
                : t('error.action', { message: `${error.code}: ${error.message}` }),
          })
        })
      }

      const choose = (selection) => {
        if (
          state.current?.provider === selection.provider &&
          state.current.model === selection.model
        ) {
          setSelectionFocus(true)
          close(true)
          return
        }
        submit(selection)
      }

      const chooseEffort = (effort) => {
        if (state.current === null) return
        if (effectiveEffort === effort) {
          setSelectionFocus(true)
          close(true)
          return
        }
        submit({
          provider: state.current.provider,
          model: state.current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })
      }

      /* Outside click and focus loss close the menu, as the shipped seat does. */
      useEffect(() => {
        if (!open) return
        const closeOutside = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (menuRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [open])

      useEffect(() => {
        if (!showSearch) {
          setQuery('')
          setHighlightedIndex(null)
        }
      }, [showSearch])

      /* Placement: right-aligned to the trigger, opening upward, clamped to view. */
      useLayoutEffect(() => {
        if (!open) {
          setMenuPos(null)
          return
        }
        const place = () => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const width = menuRef.current?.offsetWidth ?? 0
          const height = menuRef.current?.offsetHeight ?? 0
          let x = rect.right - width
          let y = rect.top - 8 - height
          if (width > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - width - MARGIN)
          if (height > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - height - MARGIN)
          setMenuPos({ left: x, top: y })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, state, query, expandedId])

      /* Keep the highlighted search result in view. */
      useLayoutEffect(() => {
        if (!open || !searching) return
        modelRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
      }, [open, searching, activeModelIndex, visibleModels])

      /**
       * Roving focus over the menu's enabled controls, in DOM order. Read from the
       * DOM rather than a ref ledger: provider headers and effort chips interleave
       * with model rows, so a render-order index would not match the visual order.
       */
      const moveFocus = (offset) => {
        const root = menuRef.current
        if (root === null) return
        const items = [...root.querySelectorAll('button:not([disabled])')]
        if (items.length === 0) return
        const active = items.findIndex((item) => item === document.activeElement)
        const next =
          active === -1
            ? offset > 0
              ? 0
              : items.length - 1
            : (active + offset + items.length) % items.length
        items[next]?.focus()
      }

      const onRootKeyDown = (event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          close(true)
          return
        }
        if (!open) return
        const searchFocused =
          showSearch && event.target instanceof HTMLInputElement && event.target === searchRef.current
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && searchFocused) {
          event.preventDefault()
          if (busy || visibleModels.length === 0) return
          const step = event.key === 'ArrowDown' ? 1 : -1
          setHighlightedIndex((activeModelIndex + step + visibleModels.length) % visibleModels.length)
          return
        }
        if (event.key === 'Enter' && searchFocused) {
          event.preventDefault()
          const highlighted = visibleModels[activeModelIndex]
          if (!busy && highlighted !== undefined) {
            choose({ provider: highlighted.provider, model: highlighted.model })
          }
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }

      const onBlur = (event) => {
        if (
          event.relatedTarget instanceof Node &&
          (rootRef.current?.contains(event.relatedTarget) === true ||
            menuRef.current?.contains(event.relatedTarget) === true)
        ) {
          return
        }
        close()
      }

      if (!available) return null

      const waiting = state.current === null && state.status === 'loading'
      const modelLabel = waiting
        ? t('trigger.loading')
        : (currentChoice?.model.name ??
          (state.current === null
            ? t('trigger.fallback')
            : `${state.current.provider}/${state.current.model}`))
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      const triggerAria = waiting
        ? t('trigger.loading')
        : state.current === null
          ? t('trigger.selectAria')
          : effortLabel === undefined
            ? t('trigger.aria', { model: modelLabel })
            : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

      modelRefs.current = []
      let modelIndex = 0

      /** One provider: the accordion header, plus its models while that provider is open. */
      const renderGroup = (group) => {
        const label = group.id === 'deepseek-account' ? t('provider.account') : group.name
        const groupOpen = isGroupOpen(group.id)
        const listId = `${id}-group-${group.id}`
        const header = h(
          'button',
          {
            key: 'header',
            type: 'button',
            role: 'menuitem',
            className: 'dmf_groupHeader',
            'aria-expanded': groupOpen,
            'aria-controls': groupOpen ? listId : undefined,
            disabled: busy,
            onClick: () => toggleProvider(group.id),
            title: label,
          },
          h(IconChevronRightOutlineRegular, {
            className: groupOpen ? 'dmf_groupChevron dmf_groupChevronOpen' : 'dmf_groupChevron',
          }),
          h('span', { className: 'dmf_groupName' }, label),
          h('span', { className: 'dmf_groupCount' }, String(group.models.length)),
        )

        if (!groupOpen) return h('div', { key: group.id, className: 'dmf_group' }, header)

        const rows = group.models.map((model) => {
          const index = modelIndex++
          const selected =
            state.current?.provider === group.id && state.current.model === model.id
          return h(
            'button',
            {
              key: model.id,
              ref: (node) => {
                modelRefs.current[index] = node
              },
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected,
              id: `${id}-model-${index}`,
              'data-highlighted': searching && index === activeModelIndex ? '' : undefined,
              className:
                'dmf_model' +
                (searching && index === activeModelIndex ? ' dmf_modelActive' : ''),
              title: model.name,
              disabled: busy,
              onClick: () => choose({ provider: group.id, model: model.id }),
            },
            h('span', { className: 'dmf_modelName' }, model.name),
            h(
              'span',
              { className: 'dmf_check' },
              pending?.provider === group.id && pending.model === model.id
                ? h(StateDot, { state: 'ongoing' })
                : selected
                  ? h(IconCheckOutlineRegular, {})
                  : null,
            ),
          )
        })

        return h(
          'div',
          { key: group.id, className: 'dmf_group' },
          header,
          h('div', { className: 'dmf_models', id: listId }, rows),
        )
      }

      const menu = open
        ? ReactDOM.createPortal(
            h(
              MenuSurface,
              {
                ref: menuRef,
                id: `${id}-menu`,
                className: 'dmf_menu',
                style: menuPos ?? MEASURE_STYLE,
                role: 'menu',
                'aria-label': t('menu.aria'),
                'aria-busy': state.status === 'loading' || busy,
              },
              showSearch
                ? h(
                    'div',
                    { className: 'dmf_searchRow' },
                    h(Input, {
                      ref: searchRef,
                      className: 'dmf_search' + (query !== '' ? ' dmf_searchWithQuery' : ''),
                      type: 'text',
                      role: 'searchbox',
                      'aria-label': t('search.placeholder'),
                      'aria-controls': `${id}-groups`,
                      'aria-activedescendant':
                        !searching || visibleModels.length === 0
                          ? undefined
                          : `${id}-model-${activeModelIndex}`,
                      placeholder: t('search.placeholder'),
                      value: query,
                      readOnly: busy,
                      onChange: (event) => {
                        setQuery(event.target.value)
                        setHighlightedIndex(0)
                      },
                    }),
                    query !== ''
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dmf_searchClear',
                            'aria-label': t('search.clear'),
                            disabled: busy,
                            onClick: () => {
                              setQuery('')
                              setHighlightedIndex(null)
                              searchRef.current?.focus()
                            },
                          },
                          h(IconCloseFillRegular, {}),
                        )
                      : null,
                  )
                : null,
              reasoning !== undefined && effortChoices.length > 0
                ? h(
                    'div',
                    { className: 'dmf_effortRow' },
                    h('span', { className: 'dmf_effortLabel', id: `${id}-effort-label` }, t('menu.effort')),
                    h(
                      'div',
                      {
                        className: 'dmf_effortChips',
                        role: 'radiogroup',
                        'aria-labelledby': `${id}-effort-label`,
                      },
                      effortChoices.map((level) =>
                        h(
                          'button',
                          {
                            key: level.key,
                            type: 'button',
                            role: 'radio',
                            'aria-checked': effectiveEffort === level.effort,
                            className:
                              'dmf_chip' +
                              (effectiveEffort === level.effort ? ' dmf_chipSelected' : ''),
                            disabled: busy,
                            onClick: () => chooseEffort(level.effort),
                          },
                          level.label,
                        ),
                      ),
                    ),
                  )
                : null,
              state.status === 'loading'
                ? h('div', { className: 'dmf_status' }, t('status.loading'))
                : null,
              state.error !== null && lastActionRef.current === 'load'
                ? h(
                    'div',
                    { className: 'dmf_error' },
                    h('span', {}, t('error.action', { message: state.error })),
                    h(
                      'button',
                      { type: 'button', className: 'dmf_retry', onClick: reload },
                      t('action.reload'),
                    ),
                  )
                : null,
              state.failures.map((failure) =>
                h(
                  'div',
                  { className: 'dmf_warning', key: failure.id },
                  h(
                    'span',
                    {},
                    t('warning.groupLoad', {
                      name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name,
                      message: failure.message,
                    }),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dmf_retry', onClick: reload },
                    t('action.reload'),
                  ),
                ),
              ),
              h(
                'div',
                { id: `${id}-groups`, className: 'dmf_groups', hidden: filteredGroups.length === 0 },
                filteredGroups.map(renderGroup),
              ),
              state.status === 'ready' && filteredGroups.length === 0
                ? h(
                    'div',
                    { className: 'dmf_empty', role: 'status' },
                    t(choices.length === 0 ? 'empty.models' : 'search.empty'),
                  )
                : null,
            ),
            document.body,
          )
        : null

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dmf_root',
          onKeyDown: onRootKeyDown,
          onBlur,
          onMouseDown: (event) => {
            if (event.target instanceof Element && event.target.closest('button') !== null) {
              event.preventDefault()
            }
          },
        },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'dmf_trigger',
            'aria-label': triggerAria,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-controls': open ? `${id}-menu` : undefined,
            title: triggerLabel,
            'aria-busy': busy,
            'data-selection-focus': selectionFocus ? '' : undefined,
            disabled: locked,
            onBlur: () => setSelectionFocus(false),
            onClick: () => {
              if (open) close(true)
              else show()
            },
          },
          h(IconDataOutlineRegular, { className: 'dmf_triggerIcon', size: 16 }),
          h('span', { className: 'dmf_triggerLabel' }, modelLabel),
          effortLabel !== undefined
            ? h('span', { className: 'dmf_triggerEffort' }, effortLabel)
            : null,
          busy
            ? h(StateDot, { state: 'ongoing' })
            : h(IconChevronDownOutlineRegular, {
                className: open ? 'dmf_chevron dmf_chevronOpen' : 'dmf_chevron',
              }),
        ),
        menu,
        toast !== null
          ? h(Toast, {
              key: toast.seq,
              text: toast.text,
              icon: h(IconWarningOutlineRegular, {}),
              anchor: rootRef.current?.closest('[data-composer-card]') ?? null,
              onDone: () => setToast(null),
            })
          : null,
      )
    }

    /* --------------------------------------------------------------- locales */

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'provider.account': 'DeepSeek 账号',
      'trigger.fallback': '请选择模型',
      'trigger.loading': '正在加载模型…',
      'trigger.selectAria': '请选择模型',
      'trigger.aria': '选择模型，当前 {model}',
      'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
      'menu.aria': '模型与推理等级',
      'menu.effort': '推理等级',
      'effort.providerDefault': '默认',
      'status.loading': '正在刷新模型列表…',
      'error.action': '模型操作失败：{message}',
      'error.sessionInUse':
        '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
      'action.reload': '重新加载',
      'warning.groupLoad': '{name} 加载失败：{message}',
      'search.placeholder': '搜索模型…',
      'search.clear': '清除搜索',
      'search.empty': '没有匹配的模型。',
      'empty.models': '没有可用的模型。',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'provider.account': 'DeepSeek Account',
      'trigger.fallback': 'Select model',
      'trigger.loading': 'Loading models…',
      'trigger.selectAria': 'Select model',
      'trigger.aria': 'Select model, current {model}',
      'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
      'menu.aria': 'Model and reasoning effort',
      'menu.effort': 'Effort',
      'effort.providerDefault': 'Default',
      'status.loading': 'Refreshing the model list…',
      'error.action': 'Model action failed: {message}',
      'error.sessionInUse':
        'This session is held by another running DSH (for example another dsh web or the desktop app). Quit the other instance and try again.',
      'action.reload': 'Reload',
      'warning.groupLoad': '{name} failed to load: {message}',
      'search.placeholder': 'Search models…',
      'search.clear': 'Clear search',
      'search.empty': 'No matching models.',
      'empty.models': 'No models available.',
    }

    /**
     * Required services: the slot registry, the locale face (the registration
     * declares a namespace, so the renderer needs a locale face installed), and the
     * session wire face used to detect addressed subagent sessions.
     */
    const inject = ['slots', 'locale', 'sessions']

    /**
     * Client plugin body: register the dictionaries, then shadow the composer's
     * model seat with the collapsible picker.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-fold: dictionaries')

      ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope) => {
        const models = scope.modelDirectories
        const sessions = scope.sessions
        scope.slots.inject('conversation.input.model', () =>
          scope.slots.register(
            {
              name: 'conversation.input.model',
              // Negative priority is what makes this the winning entry: the shipped
              // seat sits at 0, and a second registration at the same priority throws.
              priority: -1,
              locale: NS,
              inject: (sessionId) => {
                const directory = models.directoryFor(sessionId)
                const available = sessions.subagentAddress(sessionId) === undefined
                return {
                  available,
                  directory: directory.store,
                  load: () => {
                    if (available) directory.load().catch(() => {})
                  },
                  select: (selection) =>
                    available ? directory.select(selection) : Promise.resolve(undefined),
                }
              },
            },
            ModelFold,
          ),
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
