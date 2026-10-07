/**
 * dsh-task-notify browser half.
 *
 * Three jobs, in the order they matter:
 *
 * 1. **Tell the user a turn ended**, even when the window is in the background:
 *    a short two-note chime, synthesized with Web Audio so the plugin ships no
 *    binary asset, plus a Windows notification through the browser's own
 *    `Notification` API.
 * 2. **Show it in the corner**: one card per completion, bottom-right, over the
 *    frame's floating layer (`shell.overlay`), carrying the session title, how
 *    long the turn ran, and a click that returns to that session.
 * 3. **Let the user turn each piece off**: a settings section with the sound,
 *    its volume, a preview button for every channel, and the desktop
 *    notification switch.
 *
 * Where the events come from
 * --------------------------
 * The host half watches `api-session/status` and serves completions over an SSE
 * route, because a hidden page's timers are throttled by the browser and a
 * completion chime exists for exactly those minutes. This half therefore opens
 * an `EventSource` and treats polling as a *repair* path, not the mechanism: the
 * opening frame carries the host's cursor, a single `task-notify/poll` closes
 * any gap left by a reload, and the same poll runs on a slow timer whenever the
 * stream is down.
 *
 * Written as a hand-authored bundle: no build step, so the components use
 * `React.createElement` rather than JSX, and styling is one injected stylesheet
 * keyed on the `.tn-` prefix using the harness's own design tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-notify',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** Channel and endpoints the host half registers. */
    const CHANNEL = '/api'
    const POLL_ENDPOINT = 'task-notify/poll'
    const ACK_ENDPOINT = 'task-notify/ack'
    const STREAM_URL = '/api/task-notify/stream'
    const STYLE_ID = 'dsh-task-notify-style'
    /** Locale namespace this plugin owns. */
    const NS = 'task-notify'
    /** Where the (client-side) preferences live. */
    const SETTINGS_KEY = 'dsh-task-notify:settings:v1'
    /**
     * A completion older than this when it reaches the page is history, not
     * news: a reload must not replay the morning's chimes. The host already
     * bounds its replay window; this is the tighter, presentation-side rule.
     */
    const FRESH_MS = 20_000
    /** How many cards may stack before the oldest is dropped. */
    const MAX_TOASTS = 3
    /** Poll cadence used only while the stream is unavailable. */
    const FALLBACK_POLL_MS = 5_000

    const DICT = {
      zh: {
        sectionTitle: '任务完成提醒',
        sectionIntro: '回合结束时提醒你：一声轻提示音，加右下角一张小卡片。DSH 不在前台时也能收到 Windows 系统通知。',
        sound: '提示音',
        soundHint: '回合结束时播放一声「叮咚」',
        volume: '音量',
        desktop: 'Windows 系统通知',
        desktopHint: '窗口最小化或不在前台时，在系统通知中心显示',
        desktopBlocked: '系统通知权限被拒绝，请在 Windows 通知设置里为本应用放行',
        desktopGrant: '启用系统通知',
        toasts: '右下角卡片通知',
        toastsHint: '在窗口右下角显示完成卡片，点击可回到该会话',
        subagents: '子代理完成也提醒',
        subagentsHint: '默认关闭：一次任务派出多个子代理时，只有你自己发起的回合会提醒',
        stay: '卡片停留',
        stayOptions: '4 秒|8 秒|15 秒|不自动关闭',
        preview: '试听',
        previewToast: '试一张卡片',
        previewDesktop: '试一条系统通知',
        previewBody: '这是一条测试通知。',
        previewTitle: '任务完成（测试）',
        nav: '任务提醒',
        done: '任务完成',
        failed: '任务结束（有错误）',
        unknownSession: '会话',
        dismiss: '关闭通知',
        open: '点击回到该会话',
        durationLabel: '用时 {duration}',
        justNow: '刚刚',
        minutesAgo: '{count} 分钟前',
        stateOn: '已开启',
        stateOff: '已关闭',
        statusTitle: '提醒通道',
        statusSound: '提示音',
        statusDesktop: '系统通知',
        statusStream: '事件流',
        streamLive: '已连接',
        streamPolling: '轮询中',
        streamIdle: '未连接',
        hintGestures: '若提示音没有声音，点击页面任意位置一次即可解锁浏览器的音频播放。',
      },
      en: {
        sectionTitle: 'Turn notifications',
        sectionIntro: 'A soft chime and a bottom-right card when a turn finishes, plus a Windows notification while the window is in the background.',
        sound: 'Chime',
        soundHint: 'Play a short two-note chime when a turn finishes',
        volume: 'Volume',
        desktop: 'Windows notification',
        desktopHint: 'Show it in the system notification centre while DSH is not in front',
        desktopBlocked: 'Notification permission was denied; allow this app in the Windows notification settings',
        desktopGrant: 'Enable notifications',
        toasts: 'Corner card',
        toastsHint: 'Show a completion card at the bottom right; click it to return to that session',
        subagents: 'Announce subagents too',
        subagentsHint: 'Off by default: with several delegated children, only the turn you started rings',
        stay: 'Card lifetime',
        stayOptions: '4 seconds|8 seconds|15 seconds|Keep until closed',
        preview: 'Preview',
        previewToast: 'Preview a card',
        previewDesktop: 'Preview a notification',
        previewBody: 'This is a test notification.',
        previewTitle: 'Turn finished (test)',
        nav: 'Turn alerts',
        done: 'Turn finished',
        failed: 'Turn ended with an error',
        unknownSession: 'Session',
        dismiss: 'Dismiss notification',
        open: 'Click to return to that session',
        durationLabel: 'ran {duration}',
        justNow: 'just now',
        minutesAgo: '{count} min ago',
        stateOn: 'on',
        stateOff: 'off',
        statusTitle: 'Channels',
        statusSound: 'Chime',
        statusDesktop: 'Desktop',
        statusStream: 'Event stream',
        streamLive: 'live',
        streamPolling: 'polling',
        streamIdle: 'offline',
        hintGestures: 'If the chime stays silent, click anywhere on the page once to unlock browser audio.',
      },
    }

    const CSS = `
.tn-layer{position:fixed;right:20px;bottom:20px;z-index:70;display:flex;flex-direction:column;
  gap:10px;align-items:flex-end;pointer-events:none}
.tn-card{box-sizing:border-box;width:308px;max-width:calc(100vw - 40px);pointer-events:auto;
  padding:11px 12px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;
  box-shadow:0 10px 30px rgba(0,0,0,.28);
  animation:tn-in 220ms cubic-bezier(.2,.9,.3,1)}
@keyframes tn-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.tn-card:hover{background:var(--dsw-alias-bg-layer-2)}
.tn-head{display:flex;align-items:center;gap:8px}
.tn-mark{flex:none;display:inline-flex;color:var(--dsw-alias-state-success-primary)}
.tn-card.tn-error .tn-mark{color:var(--dsw-alias-state-error-primary)}
.tn-title{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.tn-when{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.tn-close{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer}
.tn-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.tn-close svg{display:block}
.tn-session{margin-top:6px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tn-meta{margin-top:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.tn-hint{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
/* --- settings section --- */
.tn-sec{box-sizing:border-box;width:100%;text-align:left;color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:20px}
.tn-sec-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.tn-sec-intro{margin:4px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.tn-panel{margin-top:12px;padding:12px 14px;border-radius:12px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.tn-row{display:flex;align-items:center;gap:10px;padding:7px 0}
.tn-row+.tn-row{border-top:.5px solid var(--dsw-alias-border-l1)}
.tn-row-main{flex:1;min-width:0}
.tn-row-label{font-size:13px;line-height:18px}
.tn-row-hint{margin-top:2px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.tn-switch{flex:none;appearance:none;box-sizing:border-box;width:38px;height:22px;padding:0;
  border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  position:relative;cursor:pointer;transition:background 140ms ease}
.tn-switch::after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;
  border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform 140ms ease,background 140ms ease}
.tn-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.tn-switch[aria-checked="true"]::after{transform:translateX(16px);background:#fff}
.tn-switch:disabled{opacity:.5;cursor:default}
.tn-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}
.tn-btn{appearance:none;box-sizing:border-box;padding:6px 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.tn-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.tn-btn:disabled{opacity:.55;cursor:default}
.tn-gain-wrap{flex:none;display:inline-flex;align-items:center;gap:8px}
.tn-range{flex:none;width:150px}
.tn-gain{flex:none;width:38px;text-align:right;font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.tn-note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tn-warn{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.tn-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:999px;
  font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.tn-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.tn-dot.tn-on{background:var(--dsw-alias-state-success-primary)}
.tn-navmark{display:inline-flex;align-items:center;gap:6px;vertical-align:-3px}
button:has(.tn-navmark)>svg:first-child{display:none}
`

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Substitute `{name}` placeholders. */
    function format(template, params) {
      return Object.entries(params ?? {})
        .reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), String(template))
    }

    /** A local wall-clock `HH:mm`. */
    function clock(timestamp) {
      const target = new Date(timestamp)
      return `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`
    }

    /** Relative age, coarse on purpose: the card is a glance, not a log. */
    function ago(timestamp, t) {
      const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
      return minutes < 1 ? t('justNow') : format(t('minutesAgo'), { count: minutes })
    }

    /* ------------------------------------------------------------------ *
     * Preferences
     * ------------------------------------------------------------------ */

    /** Default: everything on, at a polite volume, cards for eight seconds. */
    const DEFAULT_SETTINGS = {
      sound: true,
      volume: 0.55,
      desktop: true,
      toasts: true,
      stayMs: 8_000,
      /**
       * Whether the internal children of a turn announce themselves.
       *
       * Off by default: a delegation is the agent's own machinery, so a chime
       * per child would turn one finished task into a burst. The turn the user
       * actually started always rings.
       */
      subagents: false,
    }

    /**
     * Client-side preferences.
     *
     * Deliberately `localStorage` rather than a Host Config schema: these are
     * per-window presentation choices, and reading them from the page means
     * changing the volume is instant — no Host round trip, no restart.
     */
    const store = {
      value: { ...DEFAULT_SETTINGS },
      listeners: new Set(),
      read() {
        try {
          const raw = window.localStorage?.getItem(SETTINGS_KEY)
          if (typeof raw === 'string' && raw !== '') {
            const parsed = JSON.parse(raw)
            if (parsed !== null && typeof parsed === 'object') {
              this.value = { ...DEFAULT_SETTINGS, ...parsed }
            }
          }
        } catch {
          // A blocked or corrupt store costs only the preferences.
        }
        return this.value
      },
      set(patch) {
        this.value = { ...this.value, ...patch }
        try {
          window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(this.value))
        } catch {
          // Ignored on purpose.
        }
        for (const listener of [...this.listeners]) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    /* ------------------------------------------------------------------ *
     * The chime
     * ------------------------------------------------------------------ */

    /** One shared AudioContext; created on the first user gesture. */
    let audio
    /**
     * Whether a gesture has already unlocked audio.
     *
     * Chromium refuses to start an AudioContext outside a user gesture. The
     * one-time document listener below creates and resumes the context the first
     * time the user clicks or types anywhere, so the context is already running
     * when a turn ends minutes later — the alternative is a silent chime that
     * only works after the user happens to interact with the settings panel.
     */
    let audioUnlocked = false

    /** Create (and try to resume) the shared context. */
    function audioContext() {
      const Ctor = window.AudioContext ?? window.webkitAudioContext
      if (Ctor === undefined) return undefined
      if (audio === undefined) audio = new Ctor()
      if (audio.state === 'suspended') {
        // A rejected resume is the browser's business, not an error to report:
        // the chime simply stays silent until the next gesture.
        Promise.resolve(audio.resume()).catch(() => undefined)
      }
      return audio
    }

    /** Unlock audio on the first gesture of the page's life. */
    function installAudioUnlock() {
      const unlock = () => {
        audioUnlocked = true
        audioContext()
        document.removeEventListener('pointerdown', unlock, true)
        document.removeEventListener('keydown', unlock, true)
      }
      document.addEventListener('pointerdown', unlock, true)
      document.addEventListener('keydown', unlock, true)
    }

    /**
     * Play the completion chime: a rising two-note figure.
     *
     * Synthesized rather than shipped as a file, so the plugin carries no
     * binary asset and the volume is a real gain stage instead of a re-encoded
     * file. The shape is the familiar "done" gesture — a lower note answered by
     * a fifth above — kept short (about 0.5 s) and soft, because it fires at the
     * end of work the user has already stopped watching.
     *
     * @param volume - 0..1 gain for this playback.
     * @param options.measure - tap the output with an analyser and report the
     *   peak it actually produced. A terminal cannot hear the speakers, so this
     *   is how "the graph is silent" is told apart from "the machine is muted".
     * @returns a promise resolving to the measurement when one was requested.
     */
    function playChime(volume, options = {}) {
      try {
        return playChimeUnsafe(volume, options)
      } catch (error) {
        // A silenced graph must not be a silent failure: Web Audio throws on a
        // non-finite AudioParam, and a thrown click handler would otherwise look
        // exactly like a machine with the speakers off.
        return Promise.resolve({ ok: false, reason: `threw:${String(error?.message ?? error)}` })
      }
    }

    /** The chime itself; see {@link playChime} for the contract. */
    async function playChimeUnsafe(volume, options = {}) {
      const context = audioContext()
      if (context === undefined) return { ok: false, reason: 'no-context' }
      const gainValue = Math.max(0, Math.min(1, Number(volume)))
      if (!Number.isFinite(gainValue)) return { ok: false, reason: 'volume-not-a-number' }
      if (gainValue === 0) return { ok: false, reason: 'volume-zero' }
      // Resume before scheduling, not after: notes scheduled against a
      // suspended context are dropped, and the resume promise settles on a
      // later microtask — so an ignored resume is exactly how a correct graph
      // ends up silent.
      if (context.state === 'suspended') {
        try {
          await context.resume()
        } catch {
          // A refused resume is reported by the caller's measurement, not here.
        }
      }
      const now = context.currentTime
      const master = context.createGain()
      master.gain.value = gainValue
      // A gentle low-pass keeps the sine pair from sounding like a test tone.
      const tone = context.createBiquadFilter()
      tone.type = 'lowpass'
      tone.frequency.value = 3_200
      tone.Q.value = 0.6
      tone.connect(master)
      master.connect(context.destination)
      const notes = [
        { frequency: 880.0, at: 0, duration: 0.34 },
        { frequency: 1318.5, at: 0.11, duration: 0.5 },
      ]
      for (const note of notes) {
        const oscillator = context.createOscillator()
        const envelope = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = note.frequency
        const start = now + note.at
        envelope.gain.setValueAtTime(0, start)
        envelope.gain.linearRampToValueAtTime(0.85, start + 0.012)
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + note.duration)
        oscillator.connect(envelope)
        envelope.connect(tone)
        oscillator.start(start)
        oscillator.stop(start + note.duration + 0.03)
      }
      window.setTimeout(() => {
        try {
          master.disconnect()
          tone.disconnect()
        } catch {
          // Already gone.
        }
      }, 1_400)
      if (options.measure !== true) return { ok: true }
      return await new Promise((resolve) => {
        const analyser = context.createAnalyser()
        analyser.fftSize = 2048
        // Tapping the master gain measures what leaves for the speakers, not an
        // idealised copy of it. A timer drives the sampling rather than
        // `requestAnimationFrame`: the frame callback is throttled or suspended
        // in exactly the situations this measurement is meant to explain, and a
        // measurement that never settles is indistinguishable from silence.
        master.connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        const startedAt = Date.now()
        let peak = 0
        const timer = window.setInterval(() => {
          try {
            analyser.getFloatTimeDomainData(samples)
          } catch {
            window.clearInterval(timer)
            resolve({ ok: false, reason: 'analyser-failed' })
            return
          }
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
          if (Date.now() - startedAt < 800) return
          window.clearInterval(timer)
          resolve({ ok: true, peak, state: context.state, sampleRate: context.sampleRate })
        }, 60)
      })
    }

    /* ------------------------------------------------------------------ *
     * Desktop notifications
     * ------------------------------------------------------------------ */

    /** The current permission, or 'unsupported'. */
    function notificationPermission() {
      if (typeof window.Notification !== 'function') return 'unsupported'
      return window.Notification.permission
    }

    /**
     * Raise one Windows notification.
     *
     * Silent when permission is missing: the in-app card is the primary channel,
     * so a denied permission costs the OS mirror and never an error box.
     *
     * @param title - headline.
     * @param body - one line of detail.
     */
    function desktopNotify(title, body) {
      if (notificationPermission() !== 'granted') return false
      try {
        const notification = new window.Notification(title, { body, tag: 'dsh-task-notify', silent: false })
        notification.onclick = () => {
          try {
            window.focus()
            notification.close()
          } catch {
            // Ignored on purpose.
          }
        }
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ *
     * The event feed
     * ------------------------------------------------------------------ */

    /**
     * Completions waiting to be painted.
     *
     * A plain module-level store rather than React state, because the feed lives
     * outside React: the stream and its fallback poll are installed once in
     * `apply`, while the cards are a component in a slot that mounts and
     * unmounts with the shell.
     */
    const feed = {
      toasts: [],
      listeners: new Set(),
      /** Highest sequence number this page has handled. */
      cursor: 0,
      /** 'live' while the stream is up, 'polling' while the fallback runs. */
      transport: 'idle',
      /**
       * Whether the card stack ever mounted.
       *
       * The one fact that separates "no completion arrived" from "the slot
       * never took my component": both look identical from the outside, and
       * only the second one is a bug in this plugin.
       */
      mounted: false,
      /** Everything the settings panel reports back. */
      counters: { received: 0, sounded: 0, desktop: 0, skipped: 0 },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      push(toast) {
        this.toasts = [toast, ...this.toasts].slice(0, MAX_TOASTS)
        this.emit()
      },
      dismiss(id) {
        this.toasts = this.toasts.filter((toast) => toast.id !== id)
        this.emit()
      },
      setTransport(transport) {
        if (this.transport === transport) return
        this.transport = transport
        this.emit()
      },
    }

    /** Registered by apply(); lets the feed reach client services. */
    const wiring = {
      /** Optional: opens the session a card points at. */
      openSession: undefined,
      /** Sends the black-box acknowledgement to the host half. */
      ack: undefined,
    }

    /**
     * What this page can actually do, packed into the ack's one free string.
     *
     * "Did it fire?" is answerable from the host side alone; "did the user see
     * it?" is not, because the answer lives in the browser's audio policy, the
     * OS notification permission, and the layout of a card nobody in a terminal
     * can look at. This collects those facts into the acknowledgement the host
     * already records, so a single reload answers every question — including
     * the one a screenshot could not: whether something else is painted on top
     * of the card at the card's own coordinates.
     *
     * @returns a compact `key=value` summary.
     */
    function selfCheck() {
      const parts = []
      const Ctor = window.AudioContext ?? window.webkitAudioContext
      parts.push(`audio=${audio === undefined ? (Ctor === undefined ? 'unsupported' : 'not-created') : audio.state}`)
      // The gain in force, because a slider clicked at its left end is a silent
      // chime that every other reading in this line would call healthy.
      parts.push(`volume=${store.value.volume.toFixed(2)}`)
      parts.push(`sound=${String(store.value.sound)}`)
      parts.push(`chimes=${String(feed.counters.sounded)}`)
      parts.push(`notif=${notificationPermission()}`)
      try {
        parts.push(`notifSupported=${String(window.Notification?.isSupported?.() ?? 'n/a')}`)
      } catch {
        parts.push('notifSupported=throw')
      }
      parts.push(`desktopShown=${String(feed.counters.desktop)}`)
      parts.push(`toasterMounted=${String(feed.mounted)}`)
      parts.push(`toasts=${String(feed.toasts.length)}`)
      const layer = document.querySelector('.tn-layer')
      parts.push(`layer=${layer === null ? 'absent' : 'ok'}`)
      if (layer !== null) {
        const rect = layer.getBoundingClientRect()
        parts.push(`layerRect=${[rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(',')}`)
      }
      const card = document.querySelector('.tn-card')
      if (card !== null) {
        const rect = card.getBoundingClientRect()
        parts.push(`cardRect=${[rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(',')}`)
        // The decisive probe: at the card's own centre, what is actually on top?
        const x = Math.round(rect.x + rect.width / 2)
        const y = Math.round(rect.y + rect.height / 2)
        let hit = 'null'
        try {
          const top = document.elementFromPoint(x, y)
          hit = top === null
            ? 'null'
            : (card.contains(top) ? 'self' : `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}`)
        } catch (error) {
          hit = `throw:${String(error?.name ?? error)}`
        }
        parts.push(`hit=${hit}`)
      }
      parts.push(`vp=${String(window.innerWidth)}x${String(window.innerHeight)}`)
      return parts.join(' ')
    }

    /** Report one diagnostic line through the ack the host already stores. */
    function report(tag, extra) {
      wiring.ack?.({
        lastSeq: feed.cursor,
        received: feed.counters.received,
        sound: store.value.sound,
        desktop: store.value.desktop,
        notificationsAllowed: notificationPermission(),
        note: `${tag} | ${selfCheck()}${extra === undefined ? '' : ` | ${extra}`}`,
      })
    }

    /**
     * Decide what one completion deserves.
     *
     * Called for every event, including replayed ones. Anything older than
     * {@link FRESH_MS}, and anything a delegated child produced while the
     * subagent channel is off, is counted and dropped: a page that was closed
     * for an hour must not open with a burst of chimes for work already
     * finished, and one task delegated to five children is one task.
     *
     * @param event - one host completion record.
     * @param options.silent - suppress the chime (a catch-up burst rings once).
     * @param options.t - bound translator, when the caller has one.
     * @returns whether the event was treated as fresh.
     */
    function handleEvent(event, options = {}) {
      feed.counters.received += 1
      const settings = store.value
      if (event.subagent === true && settings.subagents !== true) {
        feed.counters.skipped += 1
        return false
      }
      const endedAt = typeof event.endedAt === 'number' ? event.endedAt : Date.now()
      const fresh = Date.now() - endedAt <= FRESH_MS
      if (!fresh) {
        feed.counters.skipped += 1
        return false
      }
      const label = eventLabel(event)
      if (options.silent !== true && settings.sound) {
        playChime(settings.volume)
        feed.counters.sounded += 1
      }
      if (settings.desktop) {
        const headline = options.t ? options.t('done') : 'Task finished'
        const body = [label, event.durationText].filter((part) => part !== undefined).join(' · ')
        if (desktopNotify(headline, body === '' ? String(event.sessionId) : body)) feed.counters.desktop += 1
      }
      if (settings.toasts) {
        feed.push({
          id: `${String(event.seq)}-${String(endedAt)}`,
          sessionId: event.sessionId,
          title: typeof event.title === 'string' && event.title !== '' ? event.title : undefined,
          workspace: typeof event.workspace === 'string' && event.workspace !== '' ? event.workspace : undefined,
          endedAt,
          durationText: event.durationText,
          error: event.error === true,
        })
        // Measure on the frame that paints the card, so the report describes
        // what is on screen rather than what the store intends.
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => { report(`toast:${String(event.seq)}`) })
        })
      }
      return true
    }

    /** Apply a batch, collapsing a catch-up burst into one chime. */
    function handleBatch(events, t) {
      const sorted = [...events].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
      const fresh = sorted.filter((event) => Date.now() - (event.endedAt ?? 0) <= FRESH_MS)
      let first = true
      for (const event of sorted) {
        handleEvent(event, { silent: fresh.length > 1 && !first, t })
        first = false
      }
      if (fresh.length > 0) {
        // One acknowledgement per batch: the host records what the page
        // actually received, which is the only way to prove end-to-end delivery
        // from a terminal.
        wiring.ack?.({
          lastSeq: feed.cursor,
          received: feed.counters.received,
          sound: store.value.sound,
          desktop: store.value.desktop,
        })
      }
    }

    /** Ask the host for everything after the cursor (the repair path). */
    async function pollOnce(ctx, t) {
      try {
        const response = await ctx.connection.rpc.call(CHANNEL, POLL_ENDPOINT, { cursor: feed.cursor })
        if (response?.ok !== true) return
        const value = response.value
        if (value === null || typeof value !== 'object') return
        if (typeof value.cursor === 'number') feed.cursor = Math.max(feed.cursor, value.cursor)
        const events = Array.isArray(value.events) ? value.events : []
        if (events.length > 0) handleBatch(events, t)
      } catch {
        // A failed poll is expected while the host is restarting.
      }
    }

    /**
     * Open the live stream, with polling as the repair path.
     *
     * The opening frame tells us the host's cursor: if it is ahead of ours there
     * is a gap (a reload, a slept machine), and one poll closes it. `EventSource`
     * reconnects on its own, so a dropped carrier needs no timer of ours; the
     * slow poll only runs while the stream is known to be down.
     *
     * @param ctx - client plugin context.
     * @param t - bound translator.
     * @returns a disposer.
     */
    function connect(ctx, t) {
      let source
      let fallbackTimer
      let disposed = false

      const startFallback = () => {
        if (disposed || fallbackTimer !== undefined) return
        feed.setTransport('polling')
        pollOnce(ctx, t)
        fallbackTimer = window.setInterval(() => { pollOnce(ctx, t) }, FALLBACK_POLL_MS)
      }
      const stopFallback = () => {
        if (fallbackTimer === undefined) return
        window.clearInterval(fallbackTimer)
        fallbackTimer = undefined
      }

      if (typeof window.EventSource !== 'function') {
        startFallback()
        return () => { disposed = true; stopFallback() }
      }

      source = new window.EventSource(STREAM_URL)
      source.addEventListener('open', (frame) => {
        if (disposed) return
        feed.setTransport('live')
        stopFallback()
        try {
          const payload = JSON.parse(frame.data)
          if (typeof payload?.cursor === 'number' && payload.cursor > feed.cursor) pollOnce(ctx, t)
        } catch {
          // An unreadable opening frame only costs the gap check.
        }
      })
      source.addEventListener('message', (frame) => {
        if (disposed) return
        try {
          const event = JSON.parse(frame.data)
          if (typeof event?.seq === 'number') {
            if (event.seq <= feed.cursor) return
            feed.cursor = event.seq
          }
          handleBatch([event], t)
        } catch {
          // A malformed frame is dropped rather than taking the stream down.
        }
      })
      source.addEventListener('error', () => {
        if (disposed) return
        // EventSource is reconnecting; poll meanwhile so a completion in the
        // gap is late rather than lost.
        feed.setTransport('polling')
        startFallback()
      })

      // Catch up on anything that happened while this page was away, then trust
      // the stream. The acknowledgement is also sent here, and it carries the
      // page's own diagnosis: it is the only evidence the host ever gets that
      // this page is alive, listening, and able to show what it receives.
      pollOnce(ctx, t).then(() => {
        if (disposed) return
        report('connected')
      })

      return () => {
        disposed = true
        stopFallback()
        try {
          source.close()
        } catch {
          // Ignored on purpose.
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * The corner cards
     * ------------------------------------------------------------------ */

    /**
     * The card's headline for a finished session.
     *
     * A generated title is best, the workspace folder is the honest fallback
     * (a session has one long before the title service names it), and the raw
     * session id is the last resort — never an empty line.
     */
    function sessionLabel(toast, t) {
      if (typeof toast.title === 'string' && toast.title !== '') return toast.title
      if (typeof toast.workspace === 'string' && toast.workspace !== '') return toast.workspace
      if (typeof toast.sessionId === 'string' && toast.sessionId !== '') return toast.sessionId
      return t('unknownSession')
    }

    /** The same labelling rule for a raw host event (used by the desktop body). */
    function eventLabel(event) {
      if (typeof event.title === 'string' && event.title !== '') return event.title
      if (typeof event.workspace === 'string' && event.workspace !== '') return event.workspace
      return typeof event.sessionId === 'string' ? event.sessionId : undefined
    }

    /** One completion card. */
    function ToastCard({ toast, t }) {
      const [hovered, setHovered] = React.useState(false)
      const timer = React.useRef()

      const close = React.useCallback(() => { feed.dismiss(toast.id) }, [toast.id])

      React.useEffect(() => {
        const stay = store.value.stayMs
        if (stay <= 0 || hovered) return undefined
        timer.current = window.setTimeout(close, stay)
        return () => { window.clearTimeout(timer.current) }
      }, [close, hovered, toast.id])

      const open = () => {
        wiring.openSession?.(toast.sessionId)
        close()
      }

      // The workspace earns a place on the meta line only when it is not
      // already the headline: repeating it under itself reads as a bug.
      const labeled = typeof toast.title === 'string' && toast.title !== ''
      const meta = [
        labeled && typeof toast.workspace === 'string' && toast.workspace !== '' ? toast.workspace : undefined,
        toast.durationText === undefined ? undefined : format(t('durationLabel'), { duration: toast.durationText }),
        `${clock(toast.endedAt)} · ${ago(toast.endedAt, t)}`,
      ].filter((part) => part !== undefined).join(' · ')

      return h('div', {
        className: `tn-card${toast.error === true ? ' tn-error' : ''}`,
        role: 'status',
        title: t('open'),
        onClick: open,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      },
        h('div', { className: 'tn-head' },
          h('span', { className: 'tn-mark' }, toast.error === true ? h(WarnGlyph) : h(CheckGlyph)),
          h('span', { className: 'tn-title' }, toast.error === true ? t('failed') : t('done')),
          h('span', { className: 'tn-when' }, clock(toast.endedAt)),
          h('button', {
            type: 'button',
            className: 'tn-close',
            title: t('dismiss'),
            'aria-label': t('dismiss'),
            onClick: (event) => { event.stopPropagation(); close() },
          }, h(CloseGlyph)),
        ),
        h('div', { className: 'tn-session' }, sessionLabel(toast, t)),
        h('div', { className: 'tn-meta' }, meta),
      )
    }

    /** The bottom-right stack, registered into the frame's floating layer. */
    function Toaster(props) {
      const t = props.t ?? ((key) => key)
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        feed.mounted = true
        return feed.subscribe(force)
      }, [])
      if (feed.toasts.length === 0) return null
      return h('div', { className: 'tn-layer' },
        ...feed.toasts.map((toast) => h(ToastCard, { key: toast.id, toast, t })),
      )
    }

    /** A 12px check mark, in the built-in icon weight. */
    function CheckGlyph({ size = 13 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        h('path', {
          d: 'M2.2 6.4L4.7 8.9L9.8 3.2',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /** A 12px warning mark, for a turn that ended on an error. */
    function WarnGlyph({ size = 13 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        h('path', { d: 'M6 1.8L11 10.4H1L6 1.8Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
        h('path', { d: 'M6 5V7.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 6, cy: 8.9, r: 0.7, fill: 'currentColor' }),
      )
    }

    /** A 12px dismiss mark. */
    function CloseGlyph({ size = 12 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        h('path', { d: 'M3 3L9 9M9 3L3 9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    /** The bell this section is filed under, matching the built-in icon set. */
    function BellGlyph({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        h('path', {
          d: 'M8 2.2a3.6 3.6 0 0 0-3.6 3.6c0 2.6-.7 3.6-1.2 4.1-.2.2 0 .6.3.6h9c.3 0 .5-.4.3-.6-.5-.5-1.2-1.5-1.2-4.1A3.6 3.6 0 0 0 8 2.2Z',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M6.6 12.4a1.5 1.5 0 0 0 2.8 0', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Settings
     * ------------------------------------------------------------------ */

    /** One switch row. */
    function SwitchRow({ label, hint, checked, onChange, disabled, action }) {
      return h('div', { className: 'tn-row' },
        h('div', { className: 'tn-row-main' },
          h('div', { className: 'tn-row-label' }, label),
          hint === undefined ? null : h('div', { className: 'tn-row-hint' }, hint),
        ),
        action ?? null,
        h('button', {
          type: 'button',
          className: 'tn-switch',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          disabled: disabled === true,
          onClick: () => onChange(!checked),
        }),
      )
    }

    /** A one-line status chip. */
    function StatePill({ label, on }) {
      return h('span', { className: 'tn-pill' },
        h('span', { className: `tn-dot${on ? ' tn-on' : ''}` }),
        label,
      )
    }

    /**
     * The settings-panel section.
     *
     * The shell hands a section its own props (`close`, `t`, ...), so this reads
     * the plugin's own translator from `sectionT`, installed by `apply` — the
     * same pattern the other plugin in this profile uses, and the one that keeps
     * the panel following a language switch.
     */
    function NotifySettingsSection() {
      const t = sectionT
      const [, force] = React.useReducer((value) => value + 1, 0)
      const [permission, setPermission] = React.useState(notificationPermission())

      React.useEffect(() => store.subscribe(force), [])

      const settings = store.value
      const patch = (values) => { store.set(values) }

      return h('section', { className: 'tn-sec' },
        h('h2', { className: 'tn-sec-title' }, t('sectionTitle')),
        h('p', { className: 'tn-sec-intro' }, t('sectionIntro')),

        h('div', { className: 'tn-panel' },
          h(SwitchRow, {
            label: t('sound'),
            hint: t('soundHint'),
            checked: settings.sound,
            onChange: (value) => { patch({ sound: value }); if (value) playChime(settings.volume) },
            // The readout rides with the slider: a range input jumps its thumb to
            // wherever it is clicked, so "why is the chime silent" is usually
            // answered by seeing that the gain sits at zero.
            action: h('span', { className: 'tn-gain-wrap' },
              h('input', {
                className: 'tn-range',
                type: 'range',
                min: 0,
                max: 1,
                step: 0.05,
                value: settings.volume,
                'aria-label': t('volume'),
                disabled: !settings.sound,
                onChange: (event) => { patch({ volume: Number(event.target.value) }) },
                onMouseUp: () => { if (settings.sound) playChime(store.value.volume) },
              }),
              h('span', { className: 'tn-gain' }, `${String(Math.round(settings.volume * 100))}%`),
            ),
          }),
          h(SwitchRow, {
            label: t('toasts'),
            hint: t('toastsHint'),
            checked: settings.toasts,
            onChange: (value) => patch({ toasts: value }),
            action: h('select', {
              className: 'tn-btn',
              'aria-label': t('stay'),
              value: String(settings.stayMs),
              disabled: !settings.toasts,
              onChange: (event) => patch({ stayMs: Number(event.target.value) }),
            }, ...t('stayOptions').split('|').map((label, index) => h('option', {
              key: label,
              value: String([4_000, 8_000, 15_000, 0][index]),
            }, label))),
          }),
          h(SwitchRow, {
            label: t('subagents'),
            hint: t('subagentsHint'),
            checked: settings.subagents === true,
            onChange: (value) => patch({ subagents: value }),
          }),
          h(SwitchRow, {
            label: t('desktop'),
            hint: t('desktopHint'),
            checked: settings.desktop && permission === 'granted',
            disabled: permission === 'unsupported' || permission === 'denied',
            onChange: (value) => {
              if (value && permission !== 'granted') {
                Promise.resolve(window.Notification.requestPermission()).then((result) => {
                  setPermission(result)
                  if (result === 'granted') patch({ desktop: true })
                })
                return
              }
              patch({ desktop: value })
            },
          }),
        ),

        permission === 'denied' ? h('div', { className: 'tn-warn' }, t('desktopBlocked')) : null,

        h('div', { className: 'tn-actions' },
          h('button', {
            type: 'button',
            className: 'tn-btn',
            onClick: () => {
              // Two reports on purpose: the first lands before any audio work, so
              // "the handler never ran" can never be mistaken for "the graph was
              // silent"; the second carries the peak the graph actually
              // produced, which is what separates a silent synth from a muted
              // machine.
              report('test:chime:start', `vol=${store.value.volume.toFixed(2)}`)
              playChime(settings.volume, { measure: true }).then(
                (result) => {
                  const measured = result.peak === undefined
                    ? `reason=${String(result.reason)}`
                    : `peak=${result.peak.toFixed(4)} audio=${String(result.state)} rate=${String(result.sampleRate)}`
                  report('test:chime:end', measured)
                },
                (error) => { report('test:chime:end', `rejected=${String(error?.message ?? error)}`) },
              )
            },
          }, `${t('preview')} · ${t('sound')}`),
          h('button', {
            type: 'button',
            className: 'tn-btn',
            onClick: () => {
              feed.push({
                id: `preview-${String(Date.now())}`,
                sessionId: undefined,
                title: t('previewTitle'),
                endedAt: Date.now(),
                durationText: '42s',
                error: false,
              })
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => { report('test:toast') })
              })
            },
          }, t('previewToast')),
          h('button', {
            type: 'button',
            className: 'tn-btn',
            disabled: permission !== 'granted',
            onClick: () => {
              const shown = desktopNotify(t('previewTitle'), t('previewBody'))
              window.setTimeout(() => { report('test:desktop', `desktopNotify=${String(shown)}`) }, 200)
            },
          }, t('previewDesktop')),
        ),

        h('div', { className: 'tn-note' }, t('statusTitle'),
          ' · ',
          h(StatePill, { label: `${t('statusSound')} ${settings.sound ? t('stateOn') : t('stateOff')}`, on: settings.sound }),
          ' ',
          h(StatePill, {
            label: `${t('statusDesktop')} ${permission === 'granted' && settings.desktop ? t('stateOn') : t('stateOff')}`,
            on: permission === 'granted' && settings.desktop,
          }),
          ' ',
          h(StatePill, {
            label: `${t('statusStream')} ${feed.transport === 'live' ? t('streamLive') : feed.transport === 'polling' ? t('streamPolling') : t('streamIdle')}`,
            on: feed.transport === 'live',
          }),
        ),
        h('div', { className: 'tn-note' }, t('hintGestures')),
      )
    }

    /** Bound translator for the settings section; see NotifySettingsSection. */
    let sectionT = (key) => key

    /**
     * Install the feed, the cards, and the settings section.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyles()
      store.read()
      installAudioUnlock()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'task-notify: dictionaries')
      const t = ctx.locale.bind(NS)
      sectionT = t

      // The card opens the session it belongs to. `uiWorkspace` is optional on
      // purpose: a profile without the workspace UI keeps the cards, only the
      // click does nothing.
      const uiWorkspace = ctx.get('uiWorkspace')
      wiring.openSession = typeof uiWorkspace?.openSession === 'function'
        ? (sessionId) => {
          try {
            uiWorkspace.openSession(sessionId)
            window.focus()
          } catch {
            // A card that cannot navigate is still a card.
          }
        }
        : undefined
      wiring.ack = (payload) => {
        Promise.resolve(ctx.connection.rpc.call(CHANNEL, ACK_ENDPOINT, payload)).catch(() => undefined)
      }

      // The feed lives in `apply`, not in a component: the shell may unmount the
      // overlay while the page keeps running, and a completion that arrives then
      // must still ring.
      ctx.effect(() => connect(ctx, t), 'task-notify: event stream')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'task-notify',
        order: 110,
        label: () => h('span', { className: 'tn-navmark' }, h(BellGlyph, { size: 16 }), t('nav')),
        locale: NS,
        inject: () => ({ t }),
      }, NotifySettingsSection))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'task-notify-toasts',
        order: 40,
        inject: () => ({ t }),
      }, Toaster))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'locale']
    return module.exports
  },
})
