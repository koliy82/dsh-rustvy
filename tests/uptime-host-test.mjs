// Host-half uptime-view test: a fake collector on a loopback port the kernel
// picked, serving `GET /api/view` the way the real one does, and a throwaway
// profile. Nothing here reaches the network — the model-list endpoint is a closed
// port, the origin is never asked for a catalog, and error collection is switched
// off so the only thing that can reach the fake collector is the view this half
// derives from the report address it was given.
//
// The address is set to `…/api/report` on purpose: the view URL is *derived* by
// replacing that path, so a hard-coded `/api/view` in the plugin would fail here.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-rustvy-uptime-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

/** Every request the fake collector saw, in order. */
const seen = []

/** Which fixture the collector answers with. */
let fixture = 'green'

/** Whether the collector is there at all; turning it off is the degradation test. */
let collectorUp = true

/** Whether it answers a status rather than disappearing. */
let collectorStatus = 0

/**
 * A plausible model census.
 *
 * Invented, and deliberately so: the collector's answer has only ever been observed
 * with `total: 0` and no populated `models`, so there is no real list to copy. The
 * only number about the payload that is actually observed is 48 buckets per range.
 * What this fixture is for is the shape, not the census — that every field the
 * monitor page reads survives the trip through the mirror.
 */
const MODEL_IDS = [
  'claude-opus-5-5', 'claude-sonnet-5', 'gpt-6.1-sol', 'gpt-6.1-terra',
  'gemini-3.5-pro', 'gemini-3.5-flash', 'grok-5', 'deepseek-v4',
  'deepseek-r2', 'qwen3.8-max', 'kimi-k3', 'glm-5.1',
]

/**
 * A row the collector should not have sent: a model with no id.
 *
 * Kept in the fixture because a mirror that passed it through would hand the panel a
 * row it cannot match against a catalog entry, and the normalizer's rule — drop the
 * unidentifiable, repair everything else — is only worth trusting if something
 * exercises it.
 */
const ID_LESS = { name: 'no id', errors: 0, uptime: 100, status: 'up', buckets: [], events: [], lastError: null }

/** The model that is down in the populated fixture, and the one that is slow. */
const DOWN = 'gpt-6.1-sol'
const SLOW = 'gemini-3.5-flash'

/**
 * One bucket strip, as the collector sends it: exactly 48 buckets whose width
 * changes meaning with the range.
 *
 * @param width - the milliseconds one bucket covers.
 * @param counts - one count for every bucket, or a number to fill the strip with.
 * @returns the 48 buckets.
 */
function strip(width, counts) {
  const now = Date.now()
  return Array.from({ length: 48 }, (_, index) => ({
    from: now - (48 - index) * width,
    count: typeof counts === 'number' ? counts : (counts[index] ?? 0),
  }))
}

/**
 * One model row, all green unless overridden.
 *
 * @param id - the model id.
 * @param overrides - the fields that differ from a healthy row.
 * @param width - the bucket width for this range.
 * @returns the row.
 */
function row(id, overrides, width) {
  return {
    id,
    name: id,
    errors: 0,
    uptime: 100,
    status: 'up',
    buckets: strip(width, 0),
    events: [],
    lastError: null,
    ...overrides,
  }
}

/**
 * The collector's answer.
 *
 * Two shapes, because production only ever answers one of them: the aggregation
 * currently ignores every report it accepts, so `total` is 0 and every model is
 * green. The populated shape is known only from the monitor page's own JavaScript,
 * and it is the one worth testing — a panel that has only ever rendered an
 * all-green answer has never had to draw an event, a `lastError`, or a bucket with
 * anything in it.
 *
 * @param mode - `'green'` or `'populated'`.
 * @param range - the window asked for.
 * @returns the payload.
 */
function viewFixture(mode, range) {
  const width = range === '24h' ? 1_800_000 : range === '7d' ? 12_600_000 : 54_000_000
  const at = Date.now()
  if (mode === 'green') {
    return {
      generatedAt: at,
      range,
      storage: 'mongo',
      healthy: true,
      total: 0,
      summary: { totalModels: MODEL_IDS.length, operational: MODEL_IDS.length, slow: 0, down: 0, uptime: 100, totalErrors: 0 },
      byCode: [],
      models: [...MODEL_IDS.map(id => row(id, {}, width)), ID_LESS],
    }
  }
  return {
    generatedAt: at,
    range,
    storage: 'mongo',
    healthy: false,
    total: 37,
    summary: { totalModels: MODEL_IDS.length, operational: 10, slow: 1, down: 1, uptime: 97, totalErrors: 37 },
    byCode: [
      { code: 'upstream_502', count: 22 },
      { code: 'connect_timeout', count: 9 },
      { code: 'upstream_503', count: 6 },
    ],
    models: MODEL_IDS.map(id => {
      if (id === DOWN) {
        return row(id, {
          errors: 31,
          uptime: 74,
          status: 'down',
          buckets: strip(width, 1),
          events: [
            { t: at - 900_000, code: 'upstream_502', status: 502, message: 'upstream_502: the gateway could not reach the model origin', plugin: 'dsh-rustvy' },
            { t: at - 600_000, code: 'connect_timeout', message: 'Connect Timeout Error (attempted address: rustvy.xyz:443, timeout: 10000ms)', plugin: 'dsh-rustvy' },
          ],
          lastError: { t: at - 60_000, code: 'upstream_503', message: 'upstream_503: the model origin is unavailable' },
        }, width)
      }
      if (id === SLOW) return row(id, { errors: 6, uptime: 99, status: 'slow' }, width)
      return row(id, {}, width)
    }),
  }
}

/**
 * The fake collector: a real HTTP server, because "the panel answered from the
 * collector" is the whole claim under test and a stubbed fetch would prove nothing
 * about the address this half derives or the degradation it falls back to.
 */
const collector = createServer((request, response) => {
  seen.push({ method: request.method, url: request.url })
  if (!collectorUp) {
    // Gone rather than refusing: a destroyed socket is what a host that stopped
    // answering looks like from here, and it is the branch a 5xx would not reach.
    request.destroy()
    return
  }
  const url = new URL(request.url ?? '/', 'http://local')
  if (collectorStatus !== 0) {
    response.writeHead(collectorStatus, { 'content-type': 'application/json' })
    response.end('{"error":"storage unavailable"}')
    return
  }
  if (url.pathname !== '/api/view') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"no such path"}')
    return
  }
  const range = url.searchParams.get('range')
  if (range !== '24h' && range !== '7d' && range !== '30d') {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end('{"error":"range must be one of: 24h, 7d, 30d"}')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(viewFixture(fixture, range)))
})
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))

// Set before the import, and set to the *report* path: the view address is derived
// from it, so this is what proves the derivation rather than a hard-coded URL.
process.env.DSH_RUSTVY_UPTIME_ENDPOINT = `http://127.0.0.1:${collector.address().port}/api/report`

// Icons off, model sync off and error collection off, so the only thing that can
// reach the fake collector is a view request and every upstream count below means
// what it says.
writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: false,
  syncModels: false,
  collectErrors: false,
  uptimeView: true,
}, null, 2)}\n`)
writeFileSync(join(STATE, 'catalog.json'), `${JSON.stringify({
  version: 'test-island',
  fetchedAt: new Date().toISOString(),
  records: [
    {
      id: 'claude-opus-5-5', displayName: 'OPUS 5.5', vendor: 'anthropic', vendorLabel: 'Anthropic',
      icon: 'claude.svg', provider: '', zone: 'standard', contextK: 1000, contextWindow: 1000000,
      maxOutputTokens: 128000, modalities: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high'],
      inputPer1M: null, outputPer1M: null, hot: false, free: false, enabled: true, sortOrder: 1,
    },
  ],
}, null, 2)}\n`)

/**
 * A clock the test moves.
 *
 * The view cache lives 60 s and nothing in the plugin shortens it, so the stale
 * path — the one that matters most, because it is what the panel does when the
 * collector is the thing that is down — cannot be reached without either waiting a
 * minute or moving the clock the cache measures with. Real time still runs
 * underneath, so a `fetchedAt` is a real timestamp.
 */
const realNow = Date.now.bind(Date)
let clockOffset = 0
Date.now = () => realNow() + clockOffset

/**
 * Move the clock the cache measures with.
 * @param ms - how far forward.
 */
function advance(ms) {
  clockOffset += ms
}

const { start, build } = await import('../lib/host.js')
const { UPTIME_RANGES, bucketStats } = await import('../lib/uptime.js')

const credentials = {
  async resolve() { return undefined },
  async describe() { return { configured: false, writable: true } },
  async set() { throw new Error('this test stores no credentials') },
  async unset() {},
}

/** The route profile, with one api-key route and no clone of it. */
let liveConfig = {
  providers: {
    rustvy: {
      displayName: 'rustvy',
      apiKeyEnv: 'RUSTVY_API_KEY',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'claude-opus-5-5', name: 'OPUS 5.5' }],
    },
  },
}
const entry = {
  options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: liveConfig },
  fiber: {},
}

const logs = []
const listeners = new Map()

const ctx = {
  logger: () => ({
    info: (message, error) => logs.push(['info', message, error]),
    warn: (message, error) => logs.push(['warn', message, error]),
    error: (message, error) => logs.push(['error', message, error]),
  }),
  profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
  credentials,
  configEditor: {
    entries: () => [entry],
    edit: async (target, change) => {
      if (target !== entry) throw new Error('Configuration entry is no longer available')
      liveConfig = change(structuredClone(liveConfig), {})
      entry.options.config = liveConfig
    },
  },
  on: (event, listener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event)
      if (current === undefined) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) listeners.delete(event)
    }
  },
}

let route = null
ctx.webServer = { register: registered => { route = registered; return () => { route = null } } }

let handle = await start(ctx, {})

/** Drive one registered route handler with a request that is an EventEmitter. */
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = method
    request.url = path
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19388', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); return this },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        const text = Buffer.concat(chunks.map(chunk => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, headers: this.headers, text, json })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    setTimeout(() => reject(new Error(`timeout on ${method} ${path}`)), 30_000).unref()
  })
}

const results = []
function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/**
 * Read the panel's route and remember how many upstream requests it cost.
 *
 * @param range - the range to ask for, or `undefined` to ask for none.
 * @returns a promise of `{ answer, upstream }`, where `upstream` is the requests
 *   this one call made.
 */
async function view(range) {
  const before = seen.length
  const answer = await call('GET', range === undefined ? '/dsh-rustvy/uptime.json' : `/dsh-rustvy/uptime.json?range=${range}`)
  return { answer, upstream: seen.slice(before) }
}

/**
 * One model row out of an answer, by id.
 *
 * @param answer - a route answer.
 * @param id - the model to find.
 * @returns the row, or `undefined`.
 */
function modelOf(answer, id) {
  return (answer.json?.models ?? []).find(model => model?.id === id)
}

const MONITOR = `http://127.0.0.1:${collector.address().port}/`

// --- derivation ------------------------------------------------------------
const first = await view()
check('the panel answers 200', first.answer.status === 200, `status ${first.answer.status}`)
check('it asked the collector for the derived view path', first.upstream.length === 1 && first.upstream[0].url === '/api/view?range=24h', JSON.stringify(first.upstream))
check('it asked with GET', first.upstream[0]?.method === 'GET', String(first.upstream[0]?.method))
check('the answer is a view', first.answer.json?.ok === true, first.answer.text.slice(0, 200))
check('the answer names its range', first.answer.json?.range === '24h', String(first.answer.json?.range))
check('the answer is not stale', first.answer.json?.stale === false, String(first.answer.json?.stale))
check('the answer carries no host-side error', first.answer.json?.error === undefined, String(first.answer.json?.error))
check('the answer links the monitor page', first.answer.json?.monitorUrl === MONITOR, String(first.answer.json?.monitorUrl))
check('the answer is stamped with when it was read', Number.isInteger(first.answer.json?.fetchedAt) && Math.abs(first.answer.json.fetchedAt - Date.now()) < 60_000, String(first.answer.json?.fetchedAt))
check('the routing status did not leak into the body', !('status' in (first.answer.json ?? {})), JSON.stringify(Object.keys(first.answer.json ?? {})))
check('the answer names the collector healthy', first.answer.json?.healthy === true, String(first.answer.json?.healthy))
check('the answer names the storage', first.answer.json?.storage === 'mongo', String(first.answer.json?.storage))

// --- the all-green answer production gives today ---------------------------
check('an all-green window reports no errors', first.answer.json?.total === 0, String(first.answer.json?.total))
check('an all-green window lists no codes', Array.isArray(first.answer.json?.byCode) && first.answer.json.byCode.length === 0, JSON.stringify(first.answer.json?.byCode))
check('an all-green window counts every model operational', first.answer.json?.summary?.operational === MODEL_IDS.length && first.answer.json?.summary?.down === 0, JSON.stringify(first.answer.json?.summary))
check('an all-green window reports full uptime', first.answer.json?.summary?.uptime === 100, String(first.answer.json?.summary?.uptime))
check('every model arrives', (first.answer.json?.models ?? []).length === MODEL_IDS.length, String((first.answer.json?.models ?? []).length))
check('a model the collector sent with no id never reaches the panel', (first.answer.json?.models ?? []).every(model => typeof model?.id === 'string' && model.id !== ''), JSON.stringify((first.answer.json?.models ?? []).map(model => model?.id)))
check('the models keep the order the collector sent them in', (first.answer.json?.models ?? []).map(model => model.id).join(',') === MODEL_IDS.join(','), JSON.stringify((first.answer.json?.models ?? []).map(model => model?.id)))
check('every model id survives', MODEL_IDS.every(id => modelOf(first.answer, id) !== undefined), JSON.stringify((first.answer.json?.models ?? []).map(model => model?.id)))
check('every model is up', (first.answer.json?.models ?? []).every(model => model.status === 'up'), JSON.stringify([...new Set((first.answer.json?.models ?? []).map(model => model.status))]))
check('no model carries an event', (first.answer.json?.models ?? []).every(model => Array.isArray(model.events) && model.events.length === 0))
check('no model carries a last error', (first.answer.json?.models ?? []).every(model => model.lastError === null))
// `buckets` is not padded to a fixed length by the normalizer, so the count is
// asserted through `bucketStats` — the helper a client scales a strip with — rather
// than against a number this test's own fixture happens to send.
const greenStrip = modelOf(first.answer, MODEL_IDS[0])?.buckets
const greenStats = bucketStats(greenStrip)
check('every model keeps the bucket strip it was sent', (first.answer.json?.models ?? []).every(model => bucketStats(model.buckets).count === 48), String(greenStats.count))
check('every bucket is a from and a count', (greenStrip ?? []).every(bucket => Number.isInteger(bucket.from) && Number.isInteger(bucket.count) && Object.keys(bucket).length === 2), JSON.stringify(greenStrip?.[0]))
check('an all-green strip sums to no errors', greenStats.errors === 0, String(greenStats.errors))
check('an all-green strip still scales', greenStats.max === 1, String(greenStats.max))
check('a strip keeps its outer stamps', Number.isInteger(greenStats.first) && Number.isInteger(greenStats.last) && greenStats.last > greenStats.first, `${greenStats.first} → ${greenStats.last}`)

// --- the cache -------------------------------------------------------------
const cached = await view()
check('a second read inside the TTL costs no upstream request', cached.upstream.length === 0, JSON.stringify(cached.upstream))
check('a second read answers from the cache', cached.answer.json?.fetchedAt === first.answer.json?.fetchedAt, `${first.answer.json?.fetchedAt} → ${cached.answer.json?.fetchedAt}`)
check('a cached read is not marked stale', cached.answer.json?.stale === false, String(cached.answer.json?.stale))

// --- the populated answer, on a range of its own ---------------------------
fixture = 'populated'
const week = await view('7d')
check('a second range is fetched separately', week.upstream.length === 1 && week.upstream[0].url === '/api/view?range=7d', JSON.stringify(week.upstream))
check('a second range answers for itself', week.answer.json?.range === '7d', String(week.answer.json?.range))
check('a populated window counts its errors', week.answer.json?.total === 37, String(week.answer.json?.total))
check('a populated window lists its codes', (week.answer.json?.byCode ?? []).length === 3 && week.answer.json.byCode[0].code === 'upstream_502', JSON.stringify(week.answer.json?.byCode))
check('a populated window reports itself unhealthy', week.answer.json?.healthy === false, String(week.answer.json?.healthy))
check('the summary counts the down model', week.answer.json?.summary?.down === 1 && week.answer.json?.summary?.slow === 1 && week.answer.json?.summary?.operational === 10, JSON.stringify(week.answer.json?.summary))
check('the summary carries the error total', week.answer.json?.summary?.totalErrors === 37, String(week.answer.json?.summary?.totalErrors))
check('every model still arrives in a populated window', (week.answer.json?.models ?? []).length === MODEL_IDS.length, String((week.answer.json?.models ?? []).length))

const down = modelOf(week.answer, DOWN)
check('the down model is marked down', down?.status === 'down', JSON.stringify(down && { id: down.id, status: down.status }))
check('the down model keeps its error count', down?.errors === 31, String(down?.errors))
check('the down model keeps its uptime', down?.uptime === 74, String(down?.uptime))
check('the down model keeps its name', down?.name === DOWN, String(down?.name))
const downStrip = bucketStats(down?.buckets)
check('the down model keeps its bucket strip', downStrip.count === 48, String(downStrip.count))
check('the down model buckets carry its errors', downStrip.errors === 48 && downStrip.max === 1, JSON.stringify(downStrip))
check('the down model keeps both events', (down?.events ?? []).length === 2, JSON.stringify(down?.events))
check('an event keeps its stamp and code', Number.isInteger(down?.events?.[0]?.t) && down.events[0].code === 'upstream_502', JSON.stringify(down?.events?.[0]))
check('an event keeps its HTTP status', down?.events?.[0]?.status === 502, String(down?.events?.[0]?.status))
check('an event keeps its message', down?.events?.[0]?.message === 'upstream_502: the gateway could not reach the model origin', String(down?.events?.[0]?.message))
check('an event keeps the plugin that reported it', down?.events?.[0]?.plugin === 'dsh-rustvy', String(down?.events?.[0]?.plugin))
check('an event with no status carries none', !('status' in (down?.events?.[1] ?? {})), JSON.stringify(down?.events?.[1]))
check('a connect timeout event keeps its own message', down?.events?.[1]?.code === 'connect_timeout' && down.events[1].message.includes('Connect Timeout Error'), JSON.stringify(down?.events?.[1]))
check('the down model keeps its last error', down?.lastError?.code === 'upstream_503' && Number.isInteger(down.lastError.t), JSON.stringify(down?.lastError))
check('the last error keeps its message', down?.lastError?.message === 'upstream_503: the model origin is unavailable', String(down?.lastError?.message))

const slow = modelOf(week.answer, SLOW)
check('the slow model is marked slow', slow?.status === 'slow', String(slow?.status))
check('the slow model keeps its uptime', slow?.uptime === 99, String(slow?.uptime))
check('a healthy model beside a down one is untouched', modelOf(week.answer, MODEL_IDS[0])?.status === 'up' && modelOf(week.answer, MODEL_IDS[0]).events.length === 0, JSON.stringify(modelOf(week.answer, MODEL_IDS[0]) && { status: modelOf(week.answer, MODEL_IDS[0]).status }))

// Ranges are cached apart: the week above must not have disturbed the day, and
// neither may a month read disturb either.
const weekAgain = await view('7d')
check('a cached range costs no upstream request', weekAgain.upstream.length === 0, JSON.stringify(weekAgain.upstream))
check('a cached range answers the same view', weekAgain.answer.json?.fetchedAt === week.answer.json?.fetchedAt && weekAgain.answer.json?.total === 37, String(weekAgain.answer.json?.total))
const month = await view('30d')
check('a third range is fetched separately', month.upstream.length === 1 && month.upstream[0].url === '/api/view?range=30d', JSON.stringify(month.upstream))
check('a third range answers for itself', month.answer.json?.range === '30d', String(month.answer.json?.range))
const dayAgain = await view('24h')
check('the first range is still cached beside the others', dayAgain.upstream.length === 0 && dayAgain.answer.json?.range === '24h', JSON.stringify(dayAgain.upstream))
check('the cached day is still the all-green one', dayAgain.answer.json?.total === 0, String(dayAgain.answer.json?.total))

// --- refusing a range locally ----------------------------------------------
const badRange = await view('1h')
check('an unknown range is refused 400', badRange.answer.status === 400, `status ${badRange.answer.status}`)
check('an unknown range is refused with an explanation', badRange.answer.json?.ok === false && typeof badRange.answer.json?.error === 'string', JSON.stringify(badRange.answer.json))
check('the refusal quotes the whitelist', UPTIME_RANGES.every(range => String(badRange.answer.json?.error ?? '').includes(range)), String(badRange.answer.json?.error))
check('an unknown range never reaches the collector', badRange.upstream.length === 0, JSON.stringify(badRange.upstream))

const longRange = await view('x'.repeat(5000))
check('an over-long range is refused 400', longRange.answer.status === 400, `status ${longRange.answer.status}`)
check('an over-long range is not echoed whole', String(longRange.answer.json?.error ?? '').length < 200, String(String(longRange.answer.json?.error ?? '').length))
check('an over-long range never reaches the collector', longRange.upstream.length === 0, JSON.stringify(longRange.upstream))

const noRange = await view(undefined)
check('no range at all defaults to a day', noRange.answer.json?.range === '24h', String(noRange.answer.json?.range))
check('the default costs no upstream request while the cache is warm', noRange.upstream.length === 0, JSON.stringify(noRange.upstream))

// --- the route's own manners ------------------------------------------------
check('a POST is refused 405', (await call('POST', '/dsh-rustvy/uptime.json')).status === 405)
check('the refusal names the allowed methods', (await call('POST', '/dsh-rustvy/uptime.json')).headers.allow === 'GET, HEAD', String((await call('POST', '/dsh-rustvy/uptime.json')).headers.allow))
const head = await call('HEAD', '/dsh-rustvy/uptime.json')
check('a HEAD is answered 200', head.status === 200, `status ${head.status}`)
check('a non-loopback peer is refused', await (async () => {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/dsh-rustvy/uptime.json'
  request.socket = { remoteAddress: '203.0.113.7' }
  request.headers = { host: '127.0.0.1:19388' }
  const answer = await new Promise(resolve => {
    const response = { writeHead(status) { this.status = status; return this }, end() { resolve(this.status) } }
    route.handler(request, response)
    request.emit('end')
  })
  return answer === 403
})())

// --- the collector going away ------------------------------------------------
// The cache has to be past its TTL for the fetch to be attempted at all, which is
// the only reason this test moves a clock.
advance(61_000)
collectorUp = false
const gone = await view('24h')
check('a collector that is gone still answers 200', gone.answer.status === 200, `status ${gone.answer.status}`)
check('it answers the view it had', gone.answer.json?.ok === true && (gone.answer.json?.models ?? []).length === MODEL_IDS.length, JSON.stringify(gone.answer.json?.summary))
check('it says the view is stale', gone.answer.json?.stale === true, String(gone.answer.json?.stale))
check('it says why', typeof gone.answer.json?.error === 'string' && gone.answer.json.error !== '', String(gone.answer.json?.error))
check('it keeps the original stamp', gone.answer.json?.fetchedAt === first.answer.json?.fetchedAt, `${first.answer.json?.fetchedAt} → ${gone.answer.json?.fetchedAt}`)
check('it still links the monitor page', gone.answer.json?.monitorUrl === MONITOR, String(gone.answer.json?.monitorUrl))
check('the failed fetch was logged, not thrown', logs.some(entry => entry[0] === 'warn' && String(entry[1]).includes('аптайм')), JSON.stringify(logs.filter(entry => entry[0] === 'warn').map(entry => entry[1]).slice(-2)))
check('a gone collector was still asked', gone.upstream.length === 1, String(gone.upstream.length))

collectorUp = true
collectorStatus = 500
advance(61_000)
const refusing = await view('24h')
check('a collector that answers 500 degrades the same way', refusing.answer.status === 200 && refusing.answer.json?.stale === true, `status ${refusing.answer.status}`)
check('a 500 is named in the reason', String(refusing.answer.json?.error ?? '').includes('500'), String(refusing.answer.json?.error))
collectorStatus = 0

// --- a cold mount reads the disk -------------------------------------------
// The collector has to be gone *before* the remount, or a cold mount simply fetches
// again and the disk never gets read — which is the whole thing under test here.
const persisted = readFileSync(join(STATE, 'uptime.json'), 'utf8')
const persistedParsed = JSON.parse(persisted)
check('the view was persisted', existsSync(join(STATE, 'uptime.json')) && typeof persistedParsed?.view === 'object', JSON.stringify(Object.keys(persistedParsed ?? {})))
check('the file holds the range fetched last', persistedParsed?.range === '30d', String(persistedParsed?.range))
check('the persisted view is the normalized one', persistedParsed?.view?.ok === true && Array.isArray(persistedParsed?.view?.models), JSON.stringify(Object.keys(persistedParsed?.view ?? {})))
check('the persisted document names its own stamp', Number.isInteger(persistedParsed?.fetchedAt), String(persistedParsed?.fetchedAt))
check('the persisted view carries no secret', !persisted.includes('RUSTVY_API_KEY'))

collectorUp = false
await handle.dispose()
check('dispose released the route', route === null)
check('dispose released every listener', listeners.size === 0, JSON.stringify([...listeners.keys()]))
handle = await start(ctx, {})
const cold = await view('30d')
check('a cold mount still answers 200', cold.answer.status === 200, `status ${cold.answer.status}`)
check('a cold mount reads the view from disk', cold.answer.json?.ok === true && (cold.answer.json?.models ?? []).length === MODEL_IDS.length, JSON.stringify(cold.answer.json?.summary))
check('a cold mount says the view is stale', cold.answer.json?.stale === true, String(cold.answer.json?.stale))
check('a cold mount kept the disk stamp', cold.answer.json?.fetchedAt === persistedParsed?.fetchedAt, `${persistedParsed?.fetchedAt} → ${cold.answer.json?.fetchedAt}`)
check('a cold mount asked the collector before falling back', cold.upstream.length === 1, String(cold.upstream.length))

// The disk holds only the range it was written for, so another range has nothing to
// fall back to and must be refused rather than mislabelled: a thirty-day picture
// wearing a twenty-four-hour label is worse than no picture at all.
const coldOther = await view('24h')
check('a cold mount with nothing on disk for that range is refused 502', coldOther.answer.status === 502, `status ${coldOther.answer.status}`)
check('the refusal explains itself', coldOther.answer.json?.ok === false && typeof coldOther.answer.json?.error === 'string', JSON.stringify(coldOther.answer.json))
check('a 502 carries no half-view', coldOther.answer.json?.models === undefined, JSON.stringify(Object.keys(coldOther.answer.json ?? {})))
check('a 502 does not claim to be a stale view', coldOther.answer.json?.stale === undefined, String(coldOther.answer.json?.stale))
collectorUp = true

// A collector that comes back clears the staleness — and a stale answer must not
// have been remembered as a good one, so this really is a fresh fetch.
const healed = await view('30d')
check('a collector that came back is asked again', healed.upstream.length === 1 && healed.upstream[0].url === '/api/view?range=30d', JSON.stringify(healed.upstream))
check('a fresh view is not stale', healed.answer.json?.stale === false, String(healed.answer.json?.stale))
check('a fresh view carries no host-side error', healed.answer.json?.error === undefined, String(healed.answer.json?.error))
check('a fresh view has a newer stamp', healed.answer.json?.fetchedAt > persistedParsed.fetchedAt, `${persistedParsed.fetchedAt} → ${healed.answer.json?.fetchedAt}`)

// --- the switch --------------------------------------------------------------
const switched = await call('POST', '/dsh-rustvy/config', { uptimeView: false })
check('the switch is written', switched.status === 200 && switched.json?.config?.uptimeView === false, JSON.stringify(switched.json?.config))
check('the switch did not disturb error collection', switched.json?.config?.collectErrors === false && switched.json?.config?.apiKeys === true, JSON.stringify(switched.json?.config))
const off = await view('24h')
check('with the panel off the route still answers 200', off.answer.status === 200, `status ${off.answer.status}`)
check('with the panel off the answer says so', off.answer.json?.ok === false, JSON.stringify(off.answer.json).slice(0, 200))
check('with the panel off the sentence is the settings one', off.answer.json?.error === 'аптайм выключен настройкой плагина', String(off.answer.json?.error))
check('with the panel off nothing is fetched', off.upstream.length === 0, JSON.stringify(off.upstream))
check('with the panel off the catalog route still echoes it', (await call('GET', '/dsh-rustvy/catalog.json')).json?.config?.uptimeView === false)
await call('POST', '/dsh-rustvy/config', { uptimeView: true })
check('the switch turns back on', (await call('GET', '/dsh-rustvy/catalog.json')).json?.config?.uptimeView === true)

// --- an endpoint that will not parse -----------------------------------------
// `readConfig()` refuses an `uptimeEndpoint` that is not an `http(s)` URL from
// *either* source, so the plugin can never end up holding an unparseable address
// and the derivation's own `undefined` branch is defence in depth, not a state a
// user can reach. What a user typing a bad address actually gets is this: the bad
// value is refused and the address in force is kept, so the panel carries on
// working instead of going dark.
const realEndpoint = process.env.DSH_RUSTVY_UPTIME_ENDPOINT
advance(61_000)
process.env.DSH_RUSTVY_UPTIME_ENDPOINT = 'not a url at all'
const brokenEnv = await view('24h')
check('an unparseable environment override is refused', brokenEnv.answer.json?.ok === true, JSON.stringify(brokenEnv.answer.json).slice(0, 200))
check('a refused override keeps the panel working', brokenEnv.answer.json?.monitorUrl === MONITOR && brokenEnv.answer.json?.stale === false, String(brokenEnv.answer.json?.monitorUrl))
check('a refused override still reaches the address in force', brokenEnv.upstream.length === 1 && brokenEnv.upstream[0].url === '/api/view?range=24h', JSON.stringify(brokenEnv.upstream))
process.env.DSH_RUSTVY_UPTIME_ENDPOINT = realEndpoint

// `/config` answers with the catalog payload, whose `config` block echoes only the
// fields the settings page draws, so the address is read back from `/state`, which
// carries the whole settings object.
const endpointInForce = async () => (await call('GET', '/dsh-rustvy/state')).json?.config?.uptimeEndpoint
const brokenPatch = await call('POST', '/dsh-rustvy/config', { uptimeEndpoint: 'not a url' })
check('an unparseable settings patch is refused too', (await endpointInForce()) === realEndpoint, String(await endpointInForce()))
check('a refused patch leaves the panel working', (await view('24h')).answer.json?.ok === true)
const goodPatch = await call('POST', '/dsh-rustvy/config', { uptimeEndpoint: `${MONITOR}api/report` })
check('a well-formed endpoint is accepted', (await endpointInForce()) === `${MONITOR}api/report`, String(await endpointInForce()))
check('an accepted endpoint repoints the panel', goodPatch.status === 200 && goodPatch.json?.ok === true, `status ${goodPatch.status}`)
await call('POST', '/dsh-rustvy/config', { uptimeEndpoint: realEndpoint })
check('the endpoint is put back', (await endpointInForce()) === realEndpoint, String(await endpointInForce()))

// --- the status page ---------------------------------------------------------
const state = await call('GET', '/dsh-rustvy/state')
check(`/state answers 200 for build ${build}`, state.status === 200 && state.json?.build === build, String(state.json?.build))
check('/state names the view file', typeof state.json?.paths?.uptime === 'string' && state.json.paths.uptime.endsWith('uptime.json'), String(state.json?.paths?.uptime))
check('/state still names the other files', typeof state.json?.paths?.install === 'string' && typeof state.json?.paths?.errorsQueue === 'string')
check('/state did not fetch a view to answer', state.json?.uptime === undefined, JSON.stringify(state.json?.uptime))
check('/state carries the new setting', state.json?.config?.uptimeView === true, String(state.json?.config?.uptimeView))
const beforeState = seen.length
await call('GET', '/dsh-rustvy/state')
check('a second /state costs no upstream request', seen.length === beforeState, String(seen.length - beforeState))

await handle.dispose()
collector.close()
Date.now = realNow
rmSync(PROFILE, { recursive: true, force: true })

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail === undefined ? '' : ` — ${result.detail}`}`)
  process.exit(1)
}
