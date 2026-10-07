/**
 * dsh-task-notify host half: turn-completion detection for the notification UI.
 *
 * Why this half exists at all
 * ---------------------------
 * A "task finished" chime is only as good as the moment it fires. The browser
 * cannot see an Agent's running state for sessions it is not currently opening,
 * and polling a session snapshot would both miss background sessions and
 * inherit the browser's background-timer throttling — precisely the case that
 * matters, because a completion chime is for the minutes the user is *not*
 * looking at the window. The Host does know: the API session controller emits
 * `api-session/status` for every session it owns, the moment an Agent starts or
 * stops running. This half turns that feed into a small append-only event stream
 * and serves it to the browser half.
 *
 * The event shape is deliberately presentation-free: a session id, a title, the
 * start and end instants, a duration, and a sequence number. Nothing here
 * decides whether a turn is "worth" announcing, which sound plays, or how a card
 * looks — the browser half owns all of that, so a change of taste never needs a
 * Host restart.
 *
 * Two transports, on purpose
 * --------------------------
 * `GET /api/task-notify/stream` is the live one: Server-Sent Events over the
 * shared connection, so a completion reaches the page as it happens even while
 * the window is hidden. `POST /api/task-notify/poll` is the repair path: a
 * reconnecting page asks for everything after a cursor, which covers the gap
 * between the Host emitting and the page's stream being established (a reload,
 * a dropped connection, a slept machine). Both read the same ring buffer, so a
 * client cannot see an event twice, or miss one by switching transports.
 *
 * Both RPC routes are registered as exact Fetch routes and parse the shared
 * `client-request` envelope themselves, rather than through
 * `connection.rpc.handle`. That is not a preference: on this dsh line `handle`
 * mounts the channel with `owner.webServer`, whose resolution walks the
 * Connection plugin's own fiber chain — where `webServer` is never in scope —
 * so it throws `cannot get property "webServer" without inject` for any caller
 * outside that package, no matter what the caller injects. An exact route is
 * served by the same `/api` transport as the rest of the GUI, so it inherits the
 * Host/Origin fence and the browser-session cookie.
 *
 * Every completion is also mirrored into `~/.dsh/dsh-task-notify/status.json`,
 * together with what the browser half reports back. That file is the plugin's
 * own black box: it makes "did it fire, and did the page hear it?" answerable
 * from a terminal, without a screen recording of the corner of the window.
 *
 * @module dsh-task-notify
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Plugin name shown in the Loader inventory. */
export const name = 'task-notify'

/** The exact Fetch registry lives on the host Connection service. */
export const inject = ['connection']

/** Shared browser transport; routes under it inherit its fence and session. */
const CHANNEL = '/api'

/** Endpoint the browser posts to for catch-up. */
const POLL_ENDPOINT = 'task-notify/poll'

/** Endpoint the browser posts to for what it actually received. */
const ACK_ENDPOINT = 'task-notify/ack'

/** Exact Get route carrying the live stream. */
const STREAM_PATH = `${CHANNEL}/task-notify/stream`

/** How many completions stay replayable for a reconnecting page. */
const RING_SIZE = 50

/** Keep-alive comment cadence, so a quiet stream is not reaped as idle. */
const HEARTBEAT_MS = 20_000

/**
 * A completion older than this is not news any more.
 *
 * A page that was closed for hours must not open with a stack of stale
 * "finished" cards: the replay window is about a reload or a reconnect, not
 * about the history of the machine. An explicit cursor still wins, because a
 * client that asks for a specific sequence knows what it is doing.
 */
const REPLAY_MAX_MS = 30 * 60_000

/** `~/.dsh` (or `$DSH_HOME`), matching the rest of this checkout's layout. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * Where the black box lives.
 *
 * Its own directory beside the plugins rather than inside the package: a plugin
 * folder must stay a package, and a runtime file written into it would travel
 * with every copy of the source.
 */
function statusFile() {
  return path.join(dshHome(), 'dsh-task-notify-state', 'status.json')
}

/** Duration text: `8s`, `3m10s`, `1h04m`. */
function humanDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The id, title, workspace, and subagent origin of a session summary.
 *
 * `api-session/added` is the documented announcement, but its shape is the
 * session controller's business rather than ours: a build that renames a field
 * must cost a missing card title, never a thrown listener that takes the whole
 * feed down. `SessionSummary` carries no title of its own — a title lives in
 * `projections.values` — and marks delegated sessions with `origin: 'subagent'`
 * (or a parent id), which is the one signal that keeps a chime meant for the
 * user's own turn from firing for every internal child.
 *
 * @param summary - the announced summary, shape unknown by design.
 * @returns `{ id, title, cwd, subagent, running }` when the id can be read.
 */
function summaryOf(summary) {
  if (summary === null || typeof summary !== 'object') return undefined
  const id = summary.sessionId ?? summary.id ?? summary.session_id
  if (typeof id !== 'string' || id === '') return undefined
  const projections = summary.projections !== null && typeof summary.projections === 'object'
    ? summary.projections.values
    : undefined
  const fromProjections = projections !== null && typeof projections === 'object'
    ? projections.title ?? projections.sessionTitle ?? projections.name
    : undefined
  const candidate = summary.title ?? summary.name ?? fromProjections
  const cwd = summary.cwd
  return {
    id,
    title: typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : undefined,
    cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
    subagent: summary.origin === 'subagent' || typeof summary.parentSessionId === 'string',
    running: summary.running === true,
  }
}

/** The last path segment of a workspace path, for a card label. */
function basename(target) {
  if (typeof target !== 'string' || target === '') return undefined
  const parts = target.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || undefined
}

/**
 * Wrap one result in the `server-response` envelope the browser caller checks.
 * @param rpcId - the caller's correlation id, echoed back verbatim.
 * @param result - `{ ok: true, value }` or `{ ok: false, error }`.
 * @returns the HTTP response carrying that envelope.
 */
function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * An RPC error result, in the same shape the Connection transport uses.
 * @param rpcId - the caller's correlation id.
 * @param code - stable machine-readable code.
 * @param message - human-readable detail.
 * @returns the HTTP response carrying that error.
 */
function failure(rpcId, code, message) {
  return envelope(rpcId, { ok: false, error: { code, message, details: {} } })
}

/**
 * Register the completion feed on the host Connection service.
 *
 * @param ctx - host plugin context carrying the `connection` service.
 */
export function apply(ctx) {
  const startedAt = Date.now()
  const file = statusFile()

  /** Monotonic sequence; the browser's cursor is compared against it. */
  let seq = 0
  /** @type {Array<object>} */
  const ring = []
  /**
   * One record per session this process has heard about.
   *
   * @type {Map<string, {title?: string, cwd?: string, subagent: boolean, runningSeen: boolean, startedAt?: number, error: boolean}>}
   */
  const sessions = new Map()
  /** Live SSE writers. */
  const writers = new Set()
  /** How many streams have been opened since this process started. */
  let streamConnects = 0
  /** What the browser half last told us it received. */
  let lastAck

  /** The record for one session, created on first mention. */
  const sessionOf = (id) => {
    let record = sessions.get(id)
    if (record === undefined) {
      record = { subagent: false, runningSeen: false, error: false }
      sessions.set(id, record)
    }
    return record
  }

  /**
   * Mirror the black box to disk.
   *
   * Best effort and never throwing: a read-only home directory costs the
   * diagnostics, not the notifications. Written beside the target and renamed,
   * so a reader never sees a half-written file.
   */
  const flush = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const payload = {
        version: 1,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
        writtenAt: new Date().toISOString(),
        cursor: seq,
        sessions: [...sessions.entries()].map(([id, record]) => ({
          sessionId: id,
          title: record.title,
          cwd: record.cwd,
          subagent: record.subagent,
          error: record.error,
          startedAt: record.startedAt === undefined ? undefined : new Date(record.startedAt).toISOString(),
        })),
        events: ring.map((event) => ({
          ...event,
          startedAt: event.startedAt === undefined ? undefined : new Date(event.startedAt).toISOString(),
          endedAt: new Date(event.endedAt).toISOString(),
        })),
        streamConnects,
        streamActive: writers.size,
        lastAck,
      }
      const temp = `${file}.${String(process.pid)}.tmp`
      writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8' })
      renameSync(temp, file)
    } catch {
      // Ignored on purpose: see above.
    }
  }

  /** Push one event to every live stream. */
  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const writer of [...writers]) {
      try {
        writer.write(line)
      } catch {
        writers.delete(writer)
      }
    }
  }

  /**
   * The presentation-neutral description of one session, for the card to label.
   *
   * `workspace` is the last path segment of the working directory: a card that
   * says "dsh-task-notify" is readable where a raw session id is not, and it is
   * the only label available before a session has a generated title.
   *
   * @param sessionId - the session the event belongs to.
   * @param info - its cached record.
   * @returns the label fields.
   */
  const describe = (sessionId, info) => ({
    sessionId,
    title: info.title,
    workspace: basename(info.cwd),
    cwd: info.cwd,
    subagent: info.subagent === true,
    error: info.error === true,
  })

  /**
   * Append one completion to the ring, announce it, and mirror the black box.
   *
   * @param event - the completion, without its sequence number.
   */
  const append = (event) => {
    seq += 1
    const full = { seq, ...event }
    ring.push(full)
    while (ring.length > RING_SIZE) ring.shift()
    const who = full.title ?? full.workspace ?? full.sessionId
    ctx.logger.info(
      `task-notify: turn finished · ${who} · ${full.durationText ?? 'start unseen'}${full.subagent ? ' · subagent' : ''}`,
    )
    broadcast(full)
    flush()
    return full
  }

  // The authoritative feed: one Agent changed running state. `running === false`
  // closes whatever `running === true` opened.
  ctx.on('api-session/status', (sessionId, isRunning) => {
    try {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const record = sessionOf(sessionId)
      if (isRunning === true) {
        if (record.startedAt === undefined) record.startedAt = Date.now()
        record.runningSeen = true
        record.error = false
        flush()
        return
      }
      if (isRunning !== false) return
      const startedAt = record.startedAt
      const witnessed = record.runningSeen === true
      record.startedAt = undefined
      record.runningSeen = false
      // A stop this process never saw start is only a completion when the
      // session was known to be running. A Host that enumerates idle sessions
      // at boot must not turn into a burst of cards for work finished hours ago,
      // while a turn that was already running when this process started — the
      // user restarted DSH mid-turn — still earns a card, just without a
      // duration claim it cannot support.
      if (startedAt === undefined && !witnessed) {
        flush()
        return
      }
      const endedAt = Date.now()
      const durationMs = startedAt === undefined ? undefined : Math.max(0, endedAt - startedAt)
      const finished = append({
        ...describe(sessionId, record),
        startedAt,
        endedAt,
        durationMs,
        durationText: humanDuration(durationMs),
      })
      record.error = false
      return finished
    } catch (error) {
      ctx.logger.warn(`task-notify: status listener failed: ${String(error)}`)
    }
  })

  // A turn that errored says so on its card, rather than looking like a clean
  // finish. The event carries an Agent, whose whole published shape is an id.
  ctx.on('agent/error', (payload) => {
    try {
      const candidate = payload?.agent?.id ?? payload?.agent?.sessionId ?? payload?.sessionId
      if (typeof candidate !== 'string' || candidate === '') return
      const record = sessions.get(candidate)
      if (record !== undefined) {
        record.error = true
        flush()
      }
    } catch {
      // Ignored on purpose.
    }
  })

  // Titles, workspaces, and subagent origin, cached as sessions are announced.
  // A failed read is not an error worth surfacing: the card falls back to the
  // workspace name and the rest still works.
  ctx.on('api-session/added', (summary) => {
    try {
      const parsed = summaryOf(summary)
      if (parsed === undefined) return
      const record = sessionOf(parsed.id)
      if (parsed.title !== undefined) record.title = parsed.title
      if (parsed.cwd !== undefined) record.cwd = parsed.cwd
      if (parsed.subagent) record.subagent = true
      // The announcement also carries the current running flag, which is what
      // makes a turn that outlived the previous Host process — a restart
      // mid-turn — report itself when it finally stops.
      if (parsed.running) record.runningSeen = true
      flush()
    } catch {
      // Ignored on purpose.
    }
  })

  /**
   * Answer one `task-notify/poll`: everything after the caller's cursor.
   * @param payload - the caller's `{ cursor }`.
   * @returns the current cursor and the events after it.
   */
  const poll = (payload) => {
    const cursor = payload !== null && typeof payload === 'object' && typeof payload.cursor === 'number'
      ? payload.cursor
      : 0
    const cutoff = Date.now() - REPLAY_MAX_MS
    return {
      cursor: seq,
      events: ring.filter((event) => event.seq > cursor && (cursor > 0 || event.endedAt >= cutoff)),
    }
  }

  /**
   * Read one `client-request` envelope, answering both RPC routes.
   *
   * @param request - the Fetch request the Connection bridge composed.
   * @param endpoint - the endpoint this route owns, for the method check.
   * @returns the response; never throws.
   */
  const serveRpc = (endpoint) => async (request) => {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const message = body !== null && typeof body === 'object' ? body : undefined
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    if (message?.type !== 'client-request' || typeof message.method !== 'string') {
      return failure(rpcId, 'bad-request', 'invalid client-request message')
    }
    if (message.method !== endpoint) {
      return failure(rpcId, 'bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`)
    }
    const payload = message.payload !== null && typeof message.payload === 'object' ? message.payload : undefined
    if (endpoint === ACK_ENDPOINT) {
      const record = payload ?? {}
      lastAck = {
        at: new Date().toISOString(),
        lastSeq: typeof record.lastSeq === 'number' ? record.lastSeq : undefined,
        received: typeof record.received === 'number' ? record.received : undefined,
        sound: record.sound === true,
        desktop: record.desktop === true,
        notificationsAllowed: typeof record.notificationsAllowed === 'string' ? record.notificationsAllowed : undefined,
        note: typeof record.note === 'string' ? record.note : undefined,
      }
      flush()
      return envelope(rpcId, { ok: true, value: { accepted: true } })
    }
    return envelope(rpcId, { ok: true, value: poll(payload) })
  }

  for (const endpoint of [POLL_ENDPOINT, ACK_ENDPOINT]) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${CHANNEL}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: serveRpc(endpoint),
    }), `task-notify: ${endpoint} route`)
  }

  // The live transport. One long-lived response per open page; the connection
  // owns authenticity, so this handler only has to speak SSE and clean up.
  ctx.effect(() => ctx.connection.fetch.register({
    path: STREAM_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const encoder = new TextEncoder()
      let heartbeat
      let writer
      const stream = new ReadableStream({
        start(controller) {
          writer = {
            write(chunk) {
              controller.enqueue(encoder.encode(chunk))
            },
          }
          writers.add(writer)
          streamConnects += 1
          // Opening frame: the client learns the current cursor immediately, so
          // it can decide whether to fetch a gap before trusting the stream.
          controller.enqueue(encoder.encode(`event: open\ndata: ${JSON.stringify({ cursor: seq })}\n\n`))
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'))
            } catch {
              clearInterval(heartbeat)
            }
          }, HEARTBEAT_MS)
          // A page that reloads closes the old stream; drop it from the fan-out
          // so a long session does not accumulate dead writers.
          request.signal?.addEventListener?.('abort', () => {
            writers.delete(writer)
            clearInterval(heartbeat)
            try {
              controller.close()
            } catch {
              // Already closed.
            }
          })
          flush()
        },
        cancel() {
          if (writer !== undefined) writers.delete(writer)
          if (heartbeat !== undefined) clearInterval(heartbeat)
          flush()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    },
  }), 'task-notify: stream route')

  ctx.logger.info(`task-notify: watching turn completions; stream at ${STREAM_PATH}`)
  flush()
}
