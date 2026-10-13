/**
 * dsh-workbuddy-cooldown host-half tests.
 *
 * Exercises the REAL `index.js` aggregation over a REAL log directory. The
 * recorder that produces the log is not stubbed away: it is extracted verbatim
 * from the patched workbuddy plugin, so the tests cover the actual producer and
 * the actual consumer against each other.
 *
 * Run: node host-tests.mjs <patched-host-heartbeat.js> <index.js>
 */
import { readFileSync, writeFileSync, rmSync, mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginSrcPath = process.argv[2]
const indexPath = process.argv[3]

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const home = mkdtempSync(join(tmpdir(), 'wbc-home-'))
process.env.DSH_HOME = home

/* --- load the recorder from the patched plugin -------------------------------- */
const pluginSrc = readFileSync(pluginSrcPath, 'utf8')
const pStart = pluginSrc.indexOf('const RATE_LIMIT_LOG_BASENAME')
const pEnd = pluginSrc.indexOf('function classifyUpstreamError')
if (pStart < 0 || pEnd < 0) throw new Error('recorder block not found in the patched plugin')
const recorderHarness =
  'import { appendFileSync, mkdirSync } from "node:fs"\n' +
  'import { dirname, join } from "node:path"\n' +
  'const resolveDshHome = () => process.env.DSH_HOME\n' +
  pluginSrc.slice(pStart, pEnd) + '\n' +
  'export { recordRateLimit }\n'
const recorderPath = join(home, 'recorder.mjs')
writeFileSync(recorderPath, recorderHarness, 'utf8')
const { recordRateLimit: record } = await import(pathToFileURL(recorderPath).href)

/* --- load the aggregator ------------------------------------------------------- */
const { apply, STATUS_PATH, parseResetTime, REALM_TO_PROVIDER } = await import(pathToFileURL(indexPath).href)

const resetText = (iso) => `该模型使用量已达上限，将在 ${iso} UTC+8 重置`
// The upstream states its reset as a UTC+8 WALL CLOCK. To produce one that
// means "h hours from now", take the future instant and render it in the +08:00
// zone - i.e. add 8h to the UTC rendering. Getting this wrong makes every
// parsed deadline land 6-8h in the past, which is precisely the class of bug
// the bogus-reset fallback exists to catch.
const hoursFromNow = (h) => new Date(Date.now() + (h + 8) * 3600e3).toISOString().slice(0, 19) + '.108'

/* --- routes --------------------------------------------------------------------- */
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
apply({ inject: (names, cb) => cb(scope) }, { stateTtlMs: 0 })

async function callState() {
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(c, hh) { this.statusCode = c; Object.assign(this.headers, hh) },
    end(p) { this.body = p },
  }
  await routes.get(STATUS_PATH)({ method: 'GET', headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:19387' } }, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

async function main() {
  /* --- 1. reset-time parsing ------------------------------------------------ */
  const withMs = parseResetTime(resetText('2026-10-14 02:00:00.108'))
  const withoutMs = parseResetTime(resetText('2026-10-14 02:00:00'))
  check('a reset time with milliseconds parses', typeof withMs === 'number' && Number.isFinite(withMs))
  check('it lands on 18:00:00.108Z (02:00:00.108 UTC+8)', Math.abs(withMs - Date.parse('2026-10-13T18:00:00.108Z')) < 1000)
  check('a reset time without milliseconds parses', typeof withoutMs === 'number')
  check('the two agree to the second', Math.abs((withMs ?? 0) - (withoutMs ?? 0) - 108) < 1000)
  check('a plain soft-limit message has no reset time', parseResetTime('请求过于频繁，请稍后重试。') === undefined)
  check('an empty body has no reset time', parseResetTime('') === undefined)

  /* --- 2. an empty pool is empty, not an error ------------------------------ */
  const empty = await callState()
  check('with no 429s the view is empty and healthy', empty.status === 200 && empty.body.modelLocks.length === 0 && empty.body.coolingModels === 0)

  /* --- 3. a model-level 429 records and surfaces the wall clock ------------- */
  const reset = hoursFromNow(2)
  record('global', 'deepseek-v4.1-flash', 429, JSON.stringify({ code: 6004, message: resetText(reset) }))
  const locked = await callState()
  check('a 6004 429 surfaces as a model lock', locked.body.modelLocks.length === 1)
  const lock = locked.body.modelLocks[0]
  check('it maps to the workbuddy-ai provider', lock.provider === 'workbuddy-ai')
  check('it is flagged model-level', lock.modelLevel === true)
  check('its deadline is the upstream wall clock', typeof lock.untilMs === 'number' && Math.abs(lock.untilMs - Date.parse(reset.replace(' ', 'T') + '+08:00')) < 1000)
  check('remaining time is positive and under the 2h window', lock.remainingMs > 0 && lock.remainingMs <= 2 * 3600e3 + 5000)
  check('the upstream reason text is carried', lock.reason.includes('重置'))

  /* --- 4. realm isolation ---------------------------------------------------- */
  record('cn', 'deepseek-v4.1-flash', 429, JSON.stringify({ code: 6004, message: resetText(reset) }))
  const both = await callState()
  check('a cn lock for the same id is a separate entry', both.body.modelLocks.length === 2)
  check(
    'each maps to its own provider',
    both.body.modelLocks.every((l) => REALM_TO_PROVIDER[l.realm] === l.provider),
  )

  /* --- 5. a soft 429 gets the base window ----------------------------------- */
  record('cn', 'glm-5.3', 429, '请求过于频繁，请稍后重试。')
  const soft = await callState()
  const softLock = soft.body.modelLocks.find((l) => l.model === 'glm-5.3')
  check('a soft 429 surfaces as a lock', softLock !== undefined)
  check('it is not model-level', softLock.modelLevel === false)
  check('its window is near the 600s base', softLock.remainingMs > 540e3 && softLock.remainingMs <= 600e3 + 5000)

  /* --- 6. backoff on consecutive soft 429s ---------------------------------- */
  record('cn', 'glm-5.3', 429, '请求过于频繁，请稍后重试。')
  // The recorder collapses same-instant duplicates within its 5s window, so the
  // second hit must be a genuinely later one - the way a real retry is.
  await new Promise((resolve) => setTimeout(resolve, 5100))
  record('cn', 'glm-5.3', 429, '请求过于频繁，请稍后重试。')
  const backoff = await callState()
  const backoffLock = backoff.body.modelLocks.find((l) => l.model === 'glm-5.3')
  check('a second consecutive 429 doubles the window', backoffLock.hits === 2 && backoffLock.remainingMs > 1000e3, `hits=${backoffLock.hits} remaining=${backoffLock.remainingMs}`)

  /* --- 7. a success clears a soft cooldown but not a model-level one -------- */
  record('cn', 'glm-5.3', 200, '')
  const cleared = await callState()
  check('a success clears the soft cooldown', !cleared.body.modelLocks.some((l) => l.model === 'glm-5.3'))
  check('a success does NOT clear the model-level lock', cleared.body.modelLocks.some((l) => l.model === 'deepseek-v4.1-flash' && l.realm === 'global'))

  /* --- 8. a success on the model-level model also clears it ----------------- */
  record('global', 'deepseek-v4.1-flash', 200, '')
  record('cn', 'deepseek-v4.1-flash', 200, '')
  const allClear = await callState()
  check('a success on the locked model itself clears it', allClear.body.modelLocks.length === 0)

  /* --- 9. non-429 statuses are ignored -------------------------------------- */
  record('cn', 'kimi-k3', 500, 'server error')
  record('cn', 'kimi-k3', 402, 'insufficient credit')
  const ignored = await callState()
  check('a 500 and a 402 never become cooldowns', !ignored.body.modelLocks.some((l) => l.model === 'kimi-k3'))

  /* --- 10. old entries age out ---------------------------------------------- */
  const stale = { time: Date.now() - 25 * 3600e3, realm: 'cn', model: 'stale-model', status: 429, body: '' }
  appendFileSync(join(home, '.workbuddy-429-log.jsonl'), `${JSON.stringify(stale)}\n`, 'utf8')
  const aged = await callState()
  check('an entry older than the memory window is not surfaced', !aged.body.modelLocks.some((l) => l.model === 'stale-model'))

  /* --- 11. a torn trailing line does not break the read --------------------- */
  appendFileSync(join(home, '.workbuddy-429-log.jsonl'), '{"time":123,"realm":"cn","mo', 'utf8')
  const torn = await callState()
  check('a torn trailing line is skipped, the view still builds', torn.status === 200)

  /* --- 12. disposal removes the route --------------------------------------- */
  for (const dispose of effects.reverse()) dispose()
  check('disposing unregisters the route', routes.size === 0)

  const failed = results.filter((r) => !r.ok)
  for (const r of failed) console.log(`FAIL  ${r.name}${r.detail === undefined ? '' : ` - ${r.detail}`}`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
