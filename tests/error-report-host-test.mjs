// Host-half error-report test: a real collector on a loopback port the kernel
// picked, a fake event bus that composes waterfalls the way Cordis does, and a
// throwaway profile. Nothing here reaches the network — the model-list endpoint is
// a closed port, and the only server the test talks to is the one it started.
//
// The collector's API is one flat JSON object per POST: no envelope, no `events`
// array. It accepts with `200 {"ok":true,"id":…}`, refuses a body that carries
// neither a message nor a code with `400`, rate-limits with `429` and a
// `Retry-After`, and answers `503` when its storage is unavailable. Those four
// answers are the thing under test as much as the report is: a `429` and a `503`
// are retryable and must keep the record, a `400` is not and must drop it, and a
// report that never reaches the wire at all — a successful step — must still be
// counted locally, because it is what closes an outage.
//
// Delivery is driven explicitly through `POST /dsh-rustvy/errors { action: 'flush' }`
// rather than waited for, so the test has no wall-clock sleeps longer than the few
// milliseconds it takes to make a duration non-zero.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-rustvy-errors-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

/** Every POST the collector answered, with its parsed body and the answer it got. */
const collected = []

/**
 * Which verdict the collector gives. `'auto'` implements the documented rule — a
 * body carrying neither a message nor a code is refused — and the phases that need
 * a specific verdict set one, because a rate limit and a full database are the
 * collector's decisions and the plugin has to survive all of them.
 */
let answerMode = 'auto'

/** The `Retry-After` a rate-limited answer carries; both of its forms get tested. */
let retryAfter = '2'

/**
 * The answer for one report.
 * @param body - the parsed request body.
 * @returns `{ status, body, headers? }`.
 */
function answerFor(body) {
  if (answerMode === 'limited') {
    return { status: 429, body: { ok: false, error: 'rate limit exceeded' }, headers: { 'retry-after': retryAfter } }
  }
  if (answerMode === 'unavailable') return { status: 503, body: { ok: false, error: 'storage unavailable' } }
  if (answerMode === 'bad') return { status: 400, body: { ok: false, error: 'need a message or code field' } }
  // The v2 contract accepts a report whose `meta` exceeded 8 KB and was dropped whole,
  // and names the reason in `warnings` as a stable code — never prose, absent when
  // there are none. Still a 200, still accepted.
  if (answerMode === 'warned') {
    return { status: 200, body: { ok: true, id: Date.now(), warnings: ['meta_too_large'] } }
  }
  // A code this half has never heard of. The contract says consumers ignore unknown
  // codes, and "ignore" governs behaviour — the send must not fail, retry or drop —
  // not logging, so the code is printed rather than treated as an error.
  if (answerMode === 'warned-unknown') {
    return { status: 200, body: { ok: true, id: Date.now(), warnings: ['some_future_code'] } }
  }
  // Elements that are not strings at all: the object form the contract considered and
  // rejected, and a bare number. Printing them as they arrived is the rule, because
  // reading a field off them would be coding for a shape nobody promised — and if a
  // third-party collector named that field differently, extraction would silently
  // yield nothing, which is the failure the field exists to prevent.
  if (answerMode === 'warned-junk') {
    return { status: 200, body: { ok: true, id: Date.now(), warnings: [{ code: 'meta_too_large', detail: 'meta was 9123 bytes' }, 42] } }
  }
  const described = (typeof body?.message === 'string' && body.message !== '')
    || (typeof body?.code === 'string' && body.code !== '')
  // The accepted answer carries a server-side id this half never reads; a `send`
  // that insisted on a shape it knew would be one collector change away from
  // treating every success as a failure.
  return described ? { status: 200, body: { ok: true, id: Date.now() } } : { status: 400, body: { ok: false, error: 'need a message or code field' } }
}

/**
 * The uptime collector: a real HTTP server, because "the report arrived" is the
 * whole claim under test and a stubbed `send` would prove nothing about the wiring.
 */
const collector = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.once('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const answer = answerFor(body)
    collected.push({ method: request.method, url: request.url, text, body, answer })
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
    response.end(JSON.stringify(answer.body))
  })
})
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))

// Set before the import, because `readConfig()` reads the environment and the
// endpoint has to be this server from the first revision onwards.
process.env.DSH_RUSTVY_UPTIME_ENDPOINT = `http://127.0.0.1:${collector.address().port}/api/report`

// Icons off and model sync off, so nothing in `start()` reaches for the origin; a
// closed-port endpoint on the route itself, so even an accidental read fails at
// once instead of going out.
writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: false,
  syncModels: false,
  apiKeys: true,
  collectErrors: true,
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

const { start, build } = await import('../lib/host.js')
const { classifyFailure, FOLD_LIMITS } = await import('../lib/errors.js')

/**
 * A clock the test moves.
 *
 * The reporter holds itself to `MAX_PER_MINUTE` reports — deliberately well under
 * one install's share of the collector's own per-address limit — and this test
 * delivers about twice that many. The host passes no `limits`, so the allowance
 * cannot be raised from here, and waiting a real minute per phase is not an option
 * either. The clock the reporter reads is `Date.now()` behind the `now` the host
 * injects, so moving it turns the allowance over deterministically.
 *
 * Installed before `start()`, because the reporter would otherwise be built around
 * the real one, and restored before the tally. Real time still runs underneath —
 * `tick()` advances both — which is what makes a reported duration a real one.
 */
const realNow = Date.now.bind(Date)
let clockOffset = 0
Date.now = () => realNow() + clockOffset

/**
 * Turn the reporter's per-minute allowance over.
 *
 * Called at the start of a flush rather than at the end of one, so a `Retry-After`
 * the flush is handed is still measured against the clock the test reads when it
 * asserts how long delivery was postponed.
 */
function spendMinute() {
  clockOffset += FOLD_LIMITS.MINUTE_MS + 1
}

/** A key value, and a Windows path, that must never reach the collector. */
const SECRET = 'sk-live-supersecret-0001'
const WINDOWS_PATH = 'C:\\Users\\rutop\\AppData\\Local\\Programs\\DeepSeek Harness\\profiles\\desktop'
const MODEL = 'claude-opus-5-5'

/**
 * The public collector a fresh profile sends to when nothing overrides it.
 *
 * Named once here rather than spelled out in the assertions below, so a collector
 * that moves host or gains a hostname changes in exactly one place in the plugin and
 * one place in this test — which is what just happened.
 */
const PUBLIC_COLLECTOR = 'http://185.75.189.247:3789/api/report'

/**
 * The aliases the collector accepts for a concept this plugin already names.
 *
 * Sending two spellings of one thing is how a wire format acquires a second source
 * of truth, so the report is asserted to carry exactly one of each.
 */
const UNUSED_ALIASES = ['error', 'detail', 'type', 'kind', 'timestamp', 'source']

/** The credential store, in the shape `dsh-credentials-local` answers. */
const refs = new Map([['RUSTVY_API_KEY', SECRET]])
const credentials = {
  async resolve(ref) {
    return refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined
  },
  async describe(ref) {
    return { configured: refs.has(ref), source: refs.has(ref) ? 'file' : undefined, writable: true }
  },
  async set(ref, value) {
    if (typeof value !== 'string' || value === '') throw new Error('a credential value must not be empty')
    refs.set(ref, value)
  },
  async unset(ref) {
    refs.delete(ref)
  },
}

/**
 * The route exactly as a profile declares it, plus two neighbours that are not
 * ours: an api-key route on somebody else's site, and a hand-declared Rustvy route
 * the key ring has never seen — the catch-all `isReportedRoute` exists for.
 */
let liveConfig = {
  providers: {
    rustvy: {
      displayName: 'rustvy',
      apiKeyEnv: 'RUSTVY_API_KEY',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: MODEL, name: 'OPUS 5.5', maxTokens: 128000 }],
    },
    'rustvy-manual': {
      displayName: 'rustvy · объявлен руками',
      apiKeyEnv: 'RUSTVY_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://rustvy.xyz/v1',
      models: [{ id: MODEL, name: 'OPUS 5.5', maxTokens: 128000 }],
    },
    'deepseek-official': {
      displayName: 'DeepSeek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      api: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
    },
  },
}

const entry = {
  options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: liveConfig },
  fiber: {},
}
const logs = []

/**
 * The event bus, recording every listener under its event.
 *
 * A list per event rather than one listener per event, because `agent/request` now
 * has two: the key ring's swap and this feature's watcher, and the order they were
 * registered in is exactly what decides which provider a report names.
 */
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
      const next = change(structuredClone(liveConfig), {})
      liveConfig = next
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
 * Run one waterfall dispatch the way Cordis does: the recorded listeners compose
 * outermost-first, each `next()` calls the next one, and the last calls `base`.
 *
 * @param event - the event name.
 * @param payload - the payload, without the `agent` the scope filter injects.
 * @param base - the innermost callback.
 * @returns a promise of the outermost listener's answer.
 */
async function dispatch(event, payload, base) {
  const chain = [...(listeners.get(event) ?? [])]
  let index = 0
  const next = () => {
    const listener = chain[index]
    index += 1
    return listener === undefined ? base(payload, next) : listener(payload, next)
  }
  return await next()
}

/**
 * Deliver one emit-dispatch event to every recorded listener.
 *
 * Synchronous on purpose: `session/event` is an emit, so a listener that returned
 * a promise would have it discarded, and this is how a rejected one would escape.
 *
 * @param event - the event name.
 * @param args - the listener arguments.
 */
function emit(event, ...args) {
  for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
}

/** Let a few milliseconds pass, so a reported duration is a duration. */
function tick(ms = 5) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

let stepCounter = 0

/**
 * Open one attempt the way the harness does: an `agent/request` dispatch.
 *
 * The payload is the shape the loop driver actually passes — `{ agent, turn, step,
 * signal }`, with the agent injected by the scoped dispatch rather than by the call
 * site — and `next()` resolves to the call configuration, which is what a listener
 * is allowed to replace.
 *
 * @param sessionId - the chat.
 * @param provider - the route the profile names for this request.
 * @param model - the model it names.
 * @param turn - the turn, so one test may run several in one session.
 * @returns a promise of the attempt handle the seam drivers take.
 */
async function begin(sessionId, provider, model, turn = 1) {
  stepCounter += 1
  const resolved = await dispatch('agent/request', {
    agent: { session: { id: sessionId } },
    turn,
    step: stepCounter,
    signal: new AbortController().signal,
  }, async () => ({ provider, model }))
  return { sessionId, turn, step: stepCounter, resolved }
}

/**
 * Dispatch one `agent/request-error` event, with any field overridable.
 *
 * The overrides are the point rather than a convenience: the harness's own retry
 * plugin hedges with `payload?.code ?? payload?.failure?.code`, which is the harness
 * saying it has not settled where the failure lives, and the agent scope is injected
 * by the dispatcher rather than passed by the call site. A listener that assumes any
 * one of those is the shape that silently reports nothing.
 *
 * @param attempt - the coordinates to fail under, as `begin()` returned them.
 * @param failure - the failure document, `{ message, code }`.
 * @param overrides - payload fields to replace or add.
 * @returns a promise of the waterfall's answer, which must stay the harness's.
 */
function failEvent(attempt, failure, overrides = {}) {
  return dispatch('agent/request-error', {
    agent: { session: { id: attempt.sessionId } },
    turn: attempt.turn,
    step: attempt.step,
    provider: attempt.resolved.provider,
    failure,
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }, async () => undefined)
}

/**
 * Fail one attempt in band, the way `dsh-llm-pi-ai` delivers a provider fault.
 *
 * @param attempt - the attempt handle.
 * @param failure - the harness failure document.
 * @param provider - the route to name, when it is not the one recorded.
 * @returns a promise of the waterfall's answer.
 */
function failInBand(attempt, failure, provider) {
  return failEvent(attempt, failure, provider === undefined ? {} : { provider })
}

/**
 * End one attempt the way the loop ends a turn, optionally with a thrown fault.
 *
 * @param attempt - the attempt handle.
 * @param reason - the `turn/end` reason; an error reason carries the failure.
 */
function endTurn(attempt, reason) {
  emit('session/event', { id: attempt.sessionId }, {
    type: 'turn/end',
    seq: stepCounter * 2,
    time: Date.now(),
    data: { turn: attempt.turn, reason },
  })
}

/**
 * Complete one attempt with the assistant message a successful step appends.
 *
 * @param attempt - the attempt handle.
 * @param source - `{ provider, model }`, to exercise the fallback path.
 */
function succeed(attempt, source) {
  emit('session/event', { id: attempt.sessionId }, {
    type: 'assistant/message',
    seq: stepCounter * 2 + 1,
    time: Date.now(),
    data: {
      turn: attempt.turn,
      step: attempt.step,
      message: { source: source ?? { provider: attempt.resolved.provider, model: attempt.resolved.model } },
      stream: [],
    },
  })
}

/**
 * The reporter's counters, as the settings page reads them.
 *
 * Counters are cumulative for the life of a reporter and never reset, so every
 * comparison below is against a reading taken immediately before the phase that
 * must — or must not — move them.
 *
 * @returns a promise of the summary.
 */
async function summary() {
  return (await call('GET', '/dsh-rustvy/errors')).json
}

/**
 * The total of one of the summary's count maps.
 *
 * @param counts - a kind-to-count object, or anything at all.
 * @returns the sum, reading a missing or malformed map as zero.
 */
function sumOf(counts) {
  if (typeof counts !== 'object' || counts === null) return 0
  return Object.values(counts).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0)
}

/**
 * Deliver whatever the reporter owes the collector, and answer with only the
 * reports this one flush sent.
 *
 * The route settles every folding window before it sends, so a phase never has to
 * wait for a window to expire, and the minute allowance is turned over first so a
 * phase never inherits the previous one's budget. What a phase noted is what this
 * returns, and nothing a later phase notes can fold into it.
 *
 * @returns a promise of `{ answer, posts, reports, at }`, one report per POST,
 *   where `at` is the clock reading the reporter sent under — the reference a
 *   postponed-delivery assertion has to measure from, since the allowance this
 *   function spends moves the clock before the request goes out.
 */
async function drain() {
  spendMinute()
  const at = Date.now()
  const seen = collected.length
  const answer = await call('POST', '/dsh-rustvy/errors', { action: 'flush' })
  const posts = collected.slice(seen)
  return {
    answer,
    posts,
    at,
    reports: posts.map(post => post.body).filter(body => typeof body === 'object' && body !== null),
  }
}

/**
 * Open one attempt, fail it in band and deliver what the failure produced.
 *
 * @param failure - the harness failure document.
 * @param provider - the route to fail on.
 * @param sessionId - the chat.
 * @returns a promise of `{ drained, answer, attempt }`.
 */
async function reportOf(failure, provider = 'rustvy', sessionId = 'sess-1') {
  const attempt = await begin(sessionId, provider, MODEL)
  await tick()
  await failInBand(attempt, failure)
  const drained = await drain()
  return { drained, answer: drained.answer, attempt }
}

/** The gateway's own upstream verdicts, and what the classifier makes of them. */
const UPSTREAM_502 = { message: 'upstream_502: the gateway could not reach the model origin', code: 'PI_AI_ERROR' }
const UPSTREAM_503 = { message: 'upstream_503: the model origin is unavailable', code: 'PI_AI_ERROR' }

// --- mount -----------------------------------------------------------------
check('the request watcher is installed beside the key ring', (listeners.get('agent/request') ?? []).length === 2, String((listeners.get('agent/request') ?? []).length))
check('the failure watcher is installed', (listeners.get('agent/request-error') ?? []).length === 1)
check('the session watcher is installed', (listeners.get('session/event') ?? []).length === 1)

const state = await call('GET', '/dsh-rustvy/state')
check(`/state answers 200 for build ${build}`, state.status === 200 && state.json?.build === build, String(state.json?.build))
check('/state reports the error summary', typeof state.json?.errorReport === 'object' && state.json?.errorReport !== null, JSON.stringify(state.json?.errorReport))
check('/state reports the install id', typeof state.json?.errorReport?.installId === 'string' && state.json.errorReport.installId !== '', String(state.json?.errorReport?.installId))
check('/state reports collection as enabled', state.json?.errorReport?.enabled === true, String(state.json?.errorReport?.enabled))
check('/state names the identity file', typeof state.json?.paths?.install === 'string' && state.json.paths.install.endsWith('install.json'), String(state.json?.paths?.install))
check('/state names the queue file', typeof state.json?.paths?.errorsQueue === 'string' && state.json.paths.errorsQueue.endsWith('errors-queue.json'), String(state.json?.paths?.errorsQueue))
check('the settings page sees collectErrors through the catalog route too', (await call('GET', '/dsh-rustvy/catalog.json')).json?.config?.collectErrors === true)
check('install.json was created', existsSync(join(STATE, 'install.json')))

const identityOnDisk = JSON.parse(readFileSync(join(STATE, 'install.json'), 'utf8'))
check('install.json holds the reported id', identityOnDisk?.id === state.json?.errorReport?.installId, JSON.stringify(identityOnDisk))
check('install.json holds no secret', !readFileSync(join(STATE, 'install.json'), 'utf8').includes(SECRET))

const summaryRead = await call('GET', '/dsh-rustvy/errors')
check('GET /errors answers 200 with a summary', summaryRead.status === 200 && summaryRead.json?.ok === true, `status ${summaryRead.status}`)
check('GET /errors reports the endpoint it will use', summaryRead.json?.endpoint === process.env.DSH_RUSTVY_UPTIME_ENDPOINT, String(summaryRead.json?.endpoint))
check('the summary carries no file paths', !summaryRead.text.includes('install.json') && !summaryRead.text.includes('errors-queue.json'), summaryRead.text.slice(0, 200))
check('GET /errors refuses a POST-only method', (await call('PUT', '/dsh-rustvy/errors')).status === 405)
check('an unknown action is refused 400', (await call('POST', '/dsh-rustvy/errors', { action: 'frobnicate' })).status === 400)

// --- classification, on its own --------------------------------------------
// The gateway names its own upstream verdicts in the message text, which is what
// `classifyFailure` reads them from; the code beside it is the one
// `classifyPiAiError` would have produced for the same words.
const INFRA = [
  ['upstream_502: the gateway could not reach the model origin', 'PI_AI_ERROR', 'upstream_502', 502],
  ['upstream_503: the model origin is unavailable', 'PI_AI_ERROR', 'upstream_503', 503],
  ['upstream_400: the gateway rejected the request it relayed', 'PI_AI_ERROR', 'upstream_400', 400],
  ['upstream_404: the gateway has no route for that model', 'PI_AI_ERROR', 'upstream_404', 404],
]
for (const [message, code, kind, status] of INFRA) {
  const classified = classifyFailure({ message, code })
  check(`classifyFailure calls ${kind} infrastructure`, classified.infra === true, JSON.stringify(classified))
  check(`classifyFailure reads ${kind} as HTTP ${status}`, classified.status === status, String(classified.status))
  check(`classifyFailure names the kind ${kind}`, classified.kind === kind, String(classified.kind))
  check(`classifyFailure keeps ${kind}'s code`, classified.code === code.toUpperCase(), String(classified.code))
}

const CONNECT_TIMEOUT = 'Connect Timeout Error (attempted address: rustvy.xyz:443, timeout: 10000ms)'
const timeout = classifyFailure({ message: CONNECT_TIMEOUT, code: 'TRANSPORT' })
check('a connect timeout is infrastructure', timeout.infra === true, JSON.stringify(timeout))
check('a connect timeout has no HTTP status', timeout.status === 0, String(timeout.status))
check('a connect timeout is named as one', timeout.kind === 'connect_timeout', String(timeout.kind))

const IDLE_TIMEOUT = 'LLM stream idle timeout after 300000 ms (LLM_STREAM_IDLE_TIMEOUT)'
const idle = classifyFailure({ message: IDLE_TIMEOUT, code: 'TIMEOUT' })
check('an idle stream watchdog is infrastructure', idle.infra === true, JSON.stringify(idle))
check('an idle stream watchdog is a timeout, not a connect timeout', idle.kind === 'timeout', String(idle.kind))

const NOT_INFRA = [
  ['upstream_401: the gateway relayed an authentication refusal', 'AUTH'],
  ['upstream_429: the gateway relayed a rate limit', 'RATE_LIMIT'],
  ['You exceeded your current quota, please check your plan and billing details', 'QUOTA'],
  ['the api key stored under RUSTVY_API_KEY is invalid', 'AUTH'],
  ['rate limit reached, retry after 30 seconds', 'RATE_LIMIT'],
  ['the request was aborted', 'ABORTED'],
  ["this model's maximum context length is 1000000 tokens", 'CONTEXT_WINDOW_EXCEEDED'],
  ['no credential is stored under RUSTVY_API_KEY', 'MISSING_CREDENTIAL'],
]
for (const [message, code] of NOT_INFRA) {
  const classified = classifyFailure({ message, code })
  check(`classifyFailure does not call ${code} infrastructure`, classified.infra !== true, JSON.stringify(classified))
}

// --- the shape of one report -----------------------------------------------
const first = await reportOf(UPSTREAM_502)
const report = first.drained.reports[0]
check('an infrastructure failure reaches the collector', first.drained.reports.length === 1, JSON.stringify(first.drained.reports))
check('one report is one POST', first.drained.posts.length === 1, String(first.drained.posts.length))
check('the report is one flat object, not an envelope', typeof report === 'object' && !Array.isArray(report) && !Array.isArray(report?.events) && report?.events === undefined, JSON.stringify(report).slice(0, 240))
check('the report is not addressed to an envelope path', first.drained.posts[0]?.url === '/api/report', String(first.drained.posts[0]?.url))
check('the report names the plugin', report?.plugin === 'dsh-rustvy', String(report?.plugin))
check('the report names the route as its provider', report?.provider === 'rustvy', String(report?.provider))
check('the report names the model', report?.model === MODEL, String(report?.model))
check('the report carries our kind as its code', report?.code === 'upstream_502', String(report?.code))
check('the report carries the harness code in meta', report?.meta?.harnessCode === 'PI_AI_ERROR', String(report?.meta?.harnessCode))
check('the report carries the scrubbed text as its message', report?.message === UPSTREAM_502.message, String(report?.message))
check('the report carries the HTTP status', report?.status === 502, String(report?.status))
check('the report is stamped in epoch milliseconds', Number.isInteger(report?.ts) && Math.abs(report.ts - Date.now()) < 600_000, String(report?.ts))
check('the report carries the install id in meta', report?.meta?.id === identityOnDisk?.id, String(report?.meta?.id))
check('the report carries a non-zero duration in meta', typeof report?.meta?.ms === 'number' && report.meta.ms > 0, String(report?.meta?.ms))
check('an unfolded report carries no count', report?.meta?.n === undefined, String(report?.meta?.n))
check('the report keeps the install id off the top level', report?.id === undefined, String(report?.id))
check('the report spells each concept one way', UNUSED_ALIASES.every(alias => report?.[alias] === undefined), JSON.stringify(Object.keys(report ?? {})))
check('the collector accepted it', first.drained.posts[0]?.answer?.status === 200 && first.drained.posts[0]?.answer?.body?.ok === true, JSON.stringify(first.drained.posts[0]?.answer))
check('an accepted answer may carry fields we do not read', typeof first.drained.posts[0]?.answer?.body?.id === 'number', String(first.drained.posts[0]?.answer?.body?.id))
check('an accepted report leaves the queue', first.answer.json?.queued === 0, String(first.answer.json?.queued))
check('an accepted report is counted as sent', first.answer.json?.sent === 1, String(first.answer.json?.sent))
check('an accepted report is the last answer the summary keeps', first.answer.json?.lastStatus === 200 && first.answer.json?.lastError === null, JSON.stringify({ lastStatus: first.answer.json?.lastStatus, lastError: first.answer.json?.lastError }))

// A connect timeout has no HTTP status at all, and the API takes `status` only
// when there is one — so the field must be absent, not zero.
const timed = await reportOf({ message: CONNECT_TIMEOUT, code: 'TRANSPORT' })
check('a connect timeout is reported', timed.drained.reports.length === 1, JSON.stringify(timed.drained.reports))
check('a connect timeout is reported as one', timed.drained.reports[0]?.code === 'connect_timeout', String(timed.drained.reports[0]?.code))
check('a connect timeout carries no status field', !('status' in (timed.drained.reports[0] ?? {})), JSON.stringify(timed.drained.reports[0]))

// --- the watcher's own counters --------------------------------------------
// Read here rather than later on purpose. The attempt sweep runs on every insert and
// drops anything older than ten minutes, and every flush below moves the clock a
// minute to keep the reporter's own allowance from being spent — so past about ten
// phases a `tracked` delta stops meaning anything. This is the only point in the run
// where the clock has barely moved and the count is exact.
const trackedBefore = (await summary()).tracked
check('the unattributed counter starts at zero', (await summary()).unattributed === 0, String((await summary()).unattributed))

const trackedAttempt = await begin('sess-tracked', 'rustvy', MODEL)
check('a recorded attempt is tracked', (await summary()).tracked === trackedBefore + 1, `${trackedBefore} → ${(await summary()).tracked}`)
await tick()
succeed(trackedAttempt)
check('a completed step is released', (await summary()).tracked === trackedBefore, `${trackedBefore + 1} → ${(await summary()).tracked}`)

const failingAttempt = await begin('sess-tracked-fail', 'rustvy', MODEL)
await tick()
await failInBand(failingAttempt, UPSTREAM_502)
check('a reported failure keeps its attempt until the turn ends', (await summary()).tracked === trackedBefore + 1, String((await summary()).tracked))
endTurn(failingAttempt, { kind: 'error', error: { message: IDLE_TIMEOUT, code: 'TIMEOUT' } })
check('ending the turn releases the attempt', (await summary()).tracked === trackedBefore, `${trackedBefore + 1} → ${(await summary()).tracked}`)
const trackedDrain = await drain()
check('the turn end did not report that failure a second time', trackedDrain.reports.length === 1 && trackedDrain.reports[0]?.code === 'upstream_502', JSON.stringify(trackedDrain.reports))

for (const [message, code, kind, status] of INFRA.slice(1)) {
  const { drained } = await reportOf({ message, code })
  check(`${kind} is reported`, drained.reports.length === 1, JSON.stringify(drained.reports))
  check(`${kind} keeps its status`, drained.reports[0]?.status === status, String(drained.reports[0]?.status))
  check(`${kind} keeps its kind as the code`, drained.reports[0]?.code === kind, String(drained.reports[0]?.code))
  check(`${kind} keeps a non-zero duration`, Number.isInteger(drained.reports[0]?.meta?.ms) && drained.reports[0].meta.ms > 0, String(drained.reports[0]?.meta?.ms))
}

// Two queued reports are two requests: the API takes one object, so batching is
// the collector's problem and not something this half may assume.
const pairFirst = await begin('sess-pair', 'rustvy', MODEL)
await tick()
await failInBand(pairFirst, UPSTREAM_502)
const pairSecond = await begin('sess-pair', 'rustvy', MODEL)
await tick()
await failInBand(pairSecond, UPSTREAM_503)
const pair = await drain()
check('two failures are two POSTs', pair.posts.length === 2, String(pair.posts.length))
check('each POST carried one report', pair.reports.length === 2 && pair.reports.every(one => typeof one === 'object' && !Array.isArray(one)), JSON.stringify(pair.reports).slice(0, 240))
check('the two POSTs carried the two kinds', pair.reports.map(one => one?.code).sort().join(',') === 'upstream_502,upstream_503', JSON.stringify(pair.reports.map(one => one?.code)))

// --- what never reaches the collector --------------------------------------
const beforeSilence = await summary()
for (const [message, code] of NOT_INFRA) {
  const { drained } = await reportOf({ message, code })
  check(`${code} is not reported`, drained.reports.length === 0, JSON.stringify(drained.reports))
  check(`${code} opens no POST`, drained.posts.length === 0, String(drained.posts.length))
}
const foreign = await reportOf(UPSTREAM_502, 'deepseek-official')
check('a failure on a foreign route is not reported', foreign.drained.reports.length === 0, JSON.stringify(foreign.drained.reports))
check('a failure on a foreign route opens no POST', foreign.drained.posts.length === 0, String(foreign.drained.posts.length))
const account = await reportOf(UPSTREAM_502, 'deepseek-account')
check('a failure on the DeepSeek account is not reported', account.drained.reports.length === 0, JSON.stringify(account.drained.reports))
check('a failure on the DeepSeek account opens no POST', account.drained.posts.length === 0, String(account.drained.posts.length))
const afterSilence = await summary()
check('what was not reported was not counted as a failure either', afterSilence.failures === beforeSilence.failures, `${beforeSilence.failures} → ${afterSilence.failures}`)
check('what was not reported still reached the watcher', afterSilence.attempts === beforeSilence.attempts, `${beforeSilence.attempts} → ${afterSilence.attempts}`)

// --- which routes are ours -------------------------------------------------
const manual = await reportOf(UPSTREAM_503, 'rustvy-manual')
check('a hand-declared route on the origin host is reported', manual.drained.reports.length === 1, JSON.stringify(manual.drained.reports))
check('a hand-declared route is reported under its own name', manual.drained.reports[0]?.provider === 'rustvy-manual', String(manual.drained.reports[0]?.provider))

const addedKey = await call('POST', '/dsh-rustvy/keys', { action: 'add', key: 'sk-live-second-0002', label: 'Второй' })
check('a second key was added', addedKey.json?.ok === true, addedKey.text.slice(0, 200))
await call('POST', '/dsh-rustvy/session-key', { sessionId: 'sess-ring', keyId: 'k2' })
const ringed = await begin('sess-ring', 'rustvy', MODEL)
check('the watcher sees the route the ring renamed the request to', ringed.resolved.provider === 'rustvy-k2', JSON.stringify(ringed.resolved))
await tick()
await failInBand(ringed, UPSTREAM_502)
const ringDrain = await drain()
check("a key's route is reported", ringDrain.reports.length === 1, JSON.stringify(ringDrain.reports))
check("a key's route is reported under the clone, not the base", ringDrain.reports[0]?.provider === 'rustvy-k2', String(ringDrain.reports[0]?.provider))

// --- the thrown seam -------------------------------------------------------
const thrown = await begin('sess-thrown', 'rustvy', MODEL)
await tick()
endTurn(thrown, { kind: 'error', error: { message: IDLE_TIMEOUT, code: 'TIMEOUT' } })
const thrownDrain = await drain()
check('a thrown fault is reported once', thrownDrain.reports.length === 1, JSON.stringify(thrownDrain.reports))
check('a thrown fault is reported as a timeout', thrownDrain.reports[0]?.code === 'timeout', String(thrownDrain.reports[0]?.code))
check('a thrown fault keeps the harness code beside it', thrownDrain.reports[0]?.meta?.harnessCode === 'TIMEOUT', String(thrownDrain.reports[0]?.meta?.harnessCode))
check('a thrown fault carries its duration', Number.isInteger(thrownDrain.reports[0]?.meta?.ms) && thrownDrain.reports[0].meta.ms > 0, String(thrownDrain.reports[0]?.meta?.ms))

const both = await begin('sess-both', 'rustvy', MODEL)
await tick()
await failInBand(both, UPSTREAM_502)
endTurn(both, { kind: 'error', error: { message: IDLE_TIMEOUT, code: 'TIMEOUT' } })
const bothDrain = await drain()
check('a failure the in-band seam saw is not reported twice', bothDrain.reports.length === 1, JSON.stringify(bothDrain.reports))
check('the report kept the in-band verdict, not the thrown one', bothDrain.reports[0]?.code === 'upstream_502', String(bothDrain.reports[0]?.code))

const stopped = await begin('sess-stopped', 'rustvy', MODEL)
endTurn(stopped, { kind: 'aborted', reason: 'the user pressed stop' })
const stoppedDrain = await drain()
check('a turn the user stopped is not reported', stoppedDrain.reports.length === 0, JSON.stringify(stoppedDrain.reports))
const settled = await begin('sess-settled', 'rustvy', MODEL)
endTurn(settled, { kind: 'stop' })
check('a turn that ended normally is not reported', (await drain()).reports.length === 0)

// --- a failure this half cannot attribute -----------------------------------
// The regression this whole section exists for: a real provider 502 on a real route
// reached nobody, because the failure matched no recorded attempt and was dropped
// without a word, while the summary read `failures: 1` and the only trace was a
// stranger's harness log. Nothing here may be lost for want of a key.
const beforeUnattributed = await summary()

// The step the harness reports on the way back is not necessarily the step the
// request went out on, and the turn usually is — so the turn is tried second.
const mismatched = await begin('sess-mismatch', 'rustvy', MODEL)
await tick()
await failEvent(mismatched, UPSTREAM_502, { step: mismatched.step + 7 })
const mismatchDrain = await drain()
check('a failure whose step matches no attempt is still reported', mismatchDrain.reports.length === 1, JSON.stringify(mismatchDrain.reports))
check('it keeps the model the attempt recorded', mismatchDrain.reports[0]?.model === MODEL, String(mismatchDrain.reports[0]?.model))
check('it keeps the route the attempt recorded', mismatchDrain.reports[0]?.provider === 'rustvy', String(mismatchDrain.reports[0]?.provider))
check('it keeps a real duration, not a zero one', Number.isInteger(mismatchDrain.reports[0]?.meta?.ms) && mismatchDrain.reports[0].meta.ms > 0, String(mismatchDrain.reports[0]?.meta?.ms))
check('a turn-attributed failure is not counted as unattributed', (await summary()).unattributed === beforeUnattributed.unattributed, `${beforeUnattributed.unattributed} → ${(await summary()).unattributed}`)

// A request this half never saw go out: the watcher missed `agent/request`, so there
// is no attempt at all. The payload's own request context is what names the model —
// read the way the harness's retry plugin reads it.
await failEvent({ sessionId: 'sess-never-seen', turn: 9, step: 9, resolved: { provider: 'rustvy' } }, UPSTREAM_502, {
  agent: { session: { id: 'sess-never-seen', requestContext: () => ({ model: MODEL }) } },
})
const neverSeen = await drain()
check('a failure with no recorded attempt is still reported', neverSeen.reports.length === 1, JSON.stringify(neverSeen.reports))
check('it takes the model from the payload own context', neverSeen.reports[0]?.model === MODEL, String(neverSeen.reports[0]?.model))
check('it takes the route from the payload', neverSeen.reports[0]?.provider === 'rustvy', String(neverSeen.reports[0]?.provider))
check('it reports a zero duration rather than a wrong one', neverSeen.reports[0]?.meta?.ms === 0, String(neverSeen.reports[0]?.meta?.ms))
check('it is counted as unattributed', (await summary()).unattributed === beforeUnattributed.unattributed + 1, `${beforeUnattributed.unattributed} → ${(await summary()).unattributed}`)

// No agent scope at all. The dispatcher injects it today, and nothing promises it
// will: a strict read turns a numeric or absent id into a disabled failure path.
const agentless = await begin('sess-agentless', 'rustvy', MODEL)
await tick()
await failEvent(agentless, UPSTREAM_503, { agent: undefined })
const agentlessDrain = await drain()
check('a failure with no agent scope is still reported', agentlessDrain.reports.length === 1, JSON.stringify(agentlessDrain.reports))
check('it still names the route the payload carried', agentlessDrain.reports[0]?.provider === 'rustvy', String(agentlessDrain.reports[0]?.provider))
check('it falls back to an unknown model', agentlessDrain.reports[0]?.model === 'unknown', String(agentlessDrain.reports[0]?.model))
check('a second unattributed failure is counted too', (await summary()).unattributed === beforeUnattributed.unattributed + 2, String((await summary()).unattributed))

const warnTexts = logs.filter(entry => entry[0] === 'warn' && String(entry[1]).includes('без совпавшей попытки')).map(entry => String(entry[1]))
check('an unattributed failure is warned about, once', warnTexts.length === 1, `${warnTexts.length} warnings`)
check('the warning names the coordinates it looked for', /sess-never-seen/u.test(warnTexts[0] ?? '') && warnTexts[0].includes('ход 9') && warnTexts[0].includes('шаг 9'), warnTexts[0] ?? '(none)')

// The harness's own retry plugin reads `payload?.code ?? payload?.failure?.code`,
// so a payload that puts the code at the top level must still classify: a `SERVER`
// read as an `UNKNOWN` is a silent outage wearing a different label.
const topLevel = await begin('sess-topcode', 'rustvy', MODEL)
await tick()
await failEvent(topLevel, { message: 'the model origin answered 502' }, { code: 'SERVER' })
const topDrain = await drain()
check('a code only at the top level still classifies', topDrain.reports.length === 1, JSON.stringify(topDrain.reports))
check('it is read as the harness named it', topDrain.reports[0]?.meta?.harnessCode === 'SERVER', String(topDrain.reports[0]?.meta?.harnessCode))
check('it is not read as UNKNOWN', topDrain.reports[0]?.meta?.harnessCode !== 'UNKNOWN', String(topDrain.reports[0]?.meta?.harnessCode))
check('the status is still parsed out of the message', topDrain.reports[0]?.status === 502, String(topDrain.reports[0]?.status))

// A failure whose code sits only in `failure` and whose message sits only at the top
// level: the merge has to work in both directions.
const splitShape = await begin('sess-split', 'rustvy', MODEL)
await tick()
await failEvent(splitShape, { code: 'TRANSPORT' }, { message: 'fetch failed: other side closed' })
const splitDrain = await drain()
check('a split payload still classifies', splitDrain.reports.length === 1, JSON.stringify(splitDrain.reports))
check('the top-level message is used', String(splitDrain.reports[0]?.message ?? '').includes('other side closed'), String(splitDrain.reports[0]?.message))
check('the nested code is used', splitDrain.reports[0]?.meta?.harnessCode === 'TRANSPORT', String(splitDrain.reports[0]?.meta?.harnessCode))

// --- the success side ------------------------------------------------------
// A success is an uptime sample, and it is what closes an outage — but it is not a
// report, and under this API it never reaches the wire.
const beforeSuccess = await summary()
for (let index = 0; index < 3; index += 1) {
  const attempt = await begin('sess-ok', 'rustvy', MODEL, index + 1)
  await tick()
  succeed(attempt)
}
const successDrain = await drain()
check('no success reaches the collector', successDrain.posts.length === 0 && successDrain.reports.length === 0, JSON.stringify(successDrain.reports))
const afterSuccess = await summary()
check('successes are still counted locally', afterSuccess.successes === beforeSuccess.successes + 3, `${beforeSuccess.successes} → ${afterSuccess.successes}`)
check('counting a success still counts an attempt', afterSuccess.attempts === beforeSuccess.attempts + 3, `${beforeSuccess.attempts} → ${afterSuccess.attempts}`)

// The reason successes are observed at all: one closes the failure window it
// recovers from, and does so at note time. Proven on the queue rather than on
// delivery, because the flush below settles everything anyway and would hide it.
const recovering = await begin('sess-recover', 'rustvy', MODEL)
await tick()
await failInBand(recovering, UPSTREAM_503)
check('a failure still folding is not queued yet', (await summary()).queued === 0, String((await summary()).queued))
const recovered = await begin('sess-recover', 'rustvy', MODEL)
await tick()
succeed(recovered)
const afterRecovery = await summary()
check('a success flushes the failure it recovers from', afterRecovery.queued === 1, String(afterRecovery.queued))
const recoveryDrain = await drain()
check('only the outage is delivered, not the recovery', recoveryDrain.reports.length === 1, JSON.stringify(recoveryDrain.reports))
check('what is delivered is the outage', recoveryDrain.reports[0]?.code === 'upstream_503' && recoveryDrain.reports[0]?.status === 503, JSON.stringify(recoveryDrain.reports[0]))

// Two of the same failure inside one window are one outage that happened twice.
const folding = await begin('sess-fold', 'rustvy', MODEL)
await tick()
await failInBand(folding, UPSTREAM_502)
const foldingAgain = await begin('sess-fold', 'rustvy', MODEL)
await tick()
await failInBand(foldingAgain, UPSTREAM_502)
const foldedDrain = await drain()
check('a repeated failure folds into one report', foldedDrain.reports.length === 1, JSON.stringify(foldedDrain.reports))
check('a folded report counts both', foldedDrain.reports[0]?.meta?.n === 2, String(foldedDrain.reports[0]?.meta?.n))
check('a folded report keeps the kind', foldedDrain.reports[0]?.code === 'upstream_502', String(foldedDrain.reports[0]?.code))

// --- a message that carries a secret and a path ----------------------------
const leaky = await reportOf({
  message: `Connect Timeout Error for key ${SECRET} reading ${WINDOWS_PATH}`,
  code: 'TRANSPORT',
}, 'rustvy', 'sess-leak')
const scrubbed = leaky.drained.reports[0]
check('a leaky failure is still reported', leaky.drained.reports.length === 1, JSON.stringify(leaky.drained.reports))
check('the key is replaced, not sent', typeof scrubbed?.message === 'string' && scrubbed.message.includes('<key>'), String(scrubbed?.message))
check('the path is replaced, not sent', typeof scrubbed?.message === 'string' && scrubbed.message.includes('<path>'), String(scrubbed?.message))
check('the shape of the fault survives scrubbing', typeof scrubbed?.message === 'string' && scrubbed.message.includes('Connect Timeout Error'), String(scrubbed?.message))
check('no key value is in the report', !JSON.stringify(scrubbed ?? {}).includes('supersecret'), JSON.stringify(scrubbed))
check('no user name is in the report', !JSON.stringify(scrubbed ?? {}).includes('rutop'), JSON.stringify(scrubbed))
check('no profile path is in the report', !JSON.stringify(scrubbed ?? {}).includes('.dsh'), JSON.stringify(scrubbed))
// The path holds a space, which is the case that used to survive half-scrubbed:
// the pattern stopped at the whitespace and leaked everything after `DeepSeek`.
// Asserted on the tail, so a narrower pattern fails instead of quietly passing.
check('no tail of a spaced path is in the report', ['Harness', 'profiles', 'desktop'].every(part => !JSON.stringify(scrubbed ?? {}).includes(part)), JSON.stringify(scrubbed))
check('nothing the collector received carries the secret', collected.every(post => !post.text.includes(SECRET) && !post.text.includes('supersecret')))
check('nothing the collector received carries the path', collected.every(post => !post.text.includes(WINDOWS_PATH) && !post.text.includes('rutop')))
check('the queue file carries no secret either', !existsSync(join(STATE, 'errors-queue.json')) || !readFileSync(join(STATE, 'errors-queue.json'), 'utf8').includes('supersecret'))

// Scrubbing must keep the one thing a monitor needs: which endpoint failed. A rule
// that blanked paths by reading `s:/` in `https://` as a drive letter would eat it.
const located = await reportOf({
  message: 'fetch failed for https://rustvy.xyz/v1/chat/completions: other side closed',
  code: 'TRANSPORT',
}, 'rustvy', 'sess-where')
check('a transport reset is reported', located.drained.reports.length === 1, JSON.stringify(located.drained.reports))
check('the endpoint that failed survives scrubbing', String(located.drained.reports[0]?.message ?? '').includes('https://rustvy.xyz/v1/chat/completions'), String(located.drained.reports[0]?.message))
check('the fault wording survives beside it', String(located.drained.reports[0]?.message ?? '').includes('other side closed'), String(located.drained.reports[0]?.message))

// --- the collector's own verdicts ------------------------------------------
// A rate limit is retryable: the record is an outage that happened, and the
// collector is asking to hear about it later rather than never.
const beforeLimited = await summary()
answerMode = 'limited'
retryAfter = '2'
const limited = await reportOf(UPSTREAM_502, 'rustvy', 'sess-429')
check('a rate-limited collector was asked', limited.drained.posts.length === 1 && limited.drained.posts[0].answer.status === 429, JSON.stringify(limited.drained.posts[0]?.answer))
check('a rate limit keeps the record queued', limited.answer.json?.queued === 1, String(limited.answer.json?.queued))
check('a rate limit counts a failed attempt', limited.answer.json?.failed === beforeLimited.failed + 1, `${beforeLimited.failed} → ${limited.answer.json?.failed}`)
check('a rate limit drops nothing', limited.answer.json?.dropped === beforeLimited.dropped, `${beforeLimited.dropped} → ${limited.answer.json?.dropped}`)
check('a rate limit counts nothing as sent', limited.answer.json?.sent === beforeLimited.sent, `${beforeLimited.sent} → ${limited.answer.json?.sent}`)
check('a rate limit is reported as the last error', typeof limited.answer.json?.lastError === 'string' && limited.answer.json.lastError !== '', String(limited.answer.json?.lastError))
answerMode = 'auto'
const afterLimit = await drain()
check('the rate-limited record goes out once the collector accepts again', afterLimit.reports.length === 1 && afterLimit.reports[0].code === 'upstream_502', JSON.stringify(afterLimit.reports))
check('the queue empties after a retry succeeds', afterLimit.answer.json?.queued === 0, String(afterLimit.answer.json?.queued))

// `Retry-After` in delta-seconds, and then as an HTTP date: both forms the header
// allows. Measured from the clock the flush sent under, and compared against the
// reporter's own backoff, which is what separates "the header was read" from
// "delivery was postponed by something".
answerMode = 'limited'
retryAfter = '90'
const bySeconds = await reportOf(UPSTREAM_502, 'rustvy', 'sess-retry-seconds')
const secondsWait = (bySeconds.answer.json?.nextFlushAt ?? 0) - bySeconds.drained.at
check('a delta-seconds Retry-After postpones delivery by what it asked', Math.abs(secondsWait - 90_000) <= 2_000, `${secondsWait} ms`)
check('that is longer than the internal backoff would have waited', secondsWait > FOLD_LIMITS.RETRY_MS, `${secondsWait} vs ${FOLD_LIMITS.RETRY_MS}`)
answerMode = 'auto'
await drain()

answerMode = 'limited'
retryAfter = new Date(Date.now() + 200_000).toUTCString()
const byDate = await reportOf(UPSTREAM_502, 'rustvy', 'sess-retry-date')
// The wait the header asked for, measured the same way the plugin measures it: from
// the moment the report was sent to the moment the header named.
const dateExpected = Date.parse(retryAfter) - byDate.drained.at
const dateWait = (byDate.answer.json?.nextFlushAt ?? 0) - byDate.drained.at
check('an HTTP-date Retry-After postpones delivery to the moment it named', Math.abs(dateWait - dateExpected) <= 2_000, `${dateWait} ms, expected ${dateExpected}, header was ${retryAfter}`)
check('the date form was read as a date, not ignored', dateWait > FOLD_LIMITS.RETRY_MS && Math.abs(dateWait - secondsWait) > 20_000, `${secondsWait} vs ${dateWait}`)
answerMode = 'auto'
const afterRetry = await drain()
check('a postponed report goes out once the wait is over', afterRetry.reports.length === 1 && afterRetry.answer.json?.queued === 0, JSON.stringify({ reports: afterRetry.reports.length, queued: afterRetry.answer.json?.queued }))

// A 503 is the same deal: the collector's storage is down, the report is not wrong.
const beforeUnavailable = await summary()
answerMode = 'unavailable'
const unavailable = await reportOf(UPSTREAM_502, 'rustvy', 'sess-503')
check('an unavailable collector was asked', unavailable.drained.posts.length === 1 && unavailable.drained.posts[0].answer.status === 503, JSON.stringify(unavailable.drained.posts[0]?.answer))
check('a 503 keeps the record queued', unavailable.answer.json?.queued === 1, String(unavailable.answer.json?.queued))
check('a 503 counts a failed attempt', unavailable.answer.json?.failed === beforeUnavailable.failed + 1, `${beforeUnavailable.failed} → ${unavailable.answer.json?.failed}`)
check('a 503 drops nothing', unavailable.answer.json?.dropped === beforeUnavailable.dropped, `${beforeUnavailable.dropped} → ${unavailable.answer.json?.dropped}`)
check('a 503 explains itself on the settings page', String(unavailable.answer.json?.lastError ?? '').includes('storage unavailable') && String(unavailable.answer.json?.lastError).includes('503'), String(unavailable.answer.json?.lastError))
answerMode = 'auto'
await drain()
check('the 503 record goes out once storage is back', (await summary()).queued === 0, String((await summary()).queued))

// A 400 is the opposite: the collector will never accept this record, so retrying
// it forever would fill a queue that can never empty.
const beforeBad = await summary()
answerMode = 'bad'
const bad = await reportOf(UPSTREAM_502, 'rustvy', 'sess-400')
check('a refusing collector was asked', bad.drained.posts.length === 1 && bad.drained.posts[0].answer.status === 400, JSON.stringify(bad.drained.posts[0]?.answer))
check('a 400 empties the queue', bad.answer.json?.queued === 0, String(bad.answer.json?.queued))
check('a 400 counts the record as dropped', bad.answer.json?.dropped === beforeBad.dropped + 1, `${beforeBad.dropped} → ${bad.answer.json?.dropped}`)
check('a 400 is not retried on the next flush', (await drain()).posts.length === 0)
check('a 400 carries the collector own explanation', String(bad.answer.json?.lastError ?? '').includes('need a message or code field') && String(bad.answer.json?.lastError).includes('400'), String(bad.answer.json?.lastError))
answerMode = 'auto'
// The refusal emptied the queue, so a flush on its own has nothing to send and
// nothing to clear the reason with: a collector's sentence stays on the settings
// page until a send actually succeeds. Proven by making one.
const afterBad = await reportOf(UPSTREAM_502, 'rustvy', 'sess-after-400')
check('delivery works again after a refusal', afterBad.drained.reports.length === 1 && afterBad.answer.json?.lastError === null, JSON.stringify({ reports: afterBad.drained.reports.length, lastError: afterBad.answer.json?.lastError }))

// --- an accepted report the collector warned about ---------------------------
// The v2 contract answers 200 for a report whose `meta` exceeded 8 KB and was dropped
// whole, with the reason in `warnings`. `send` reduces an answer to the facts the
// reporter routes on, so without reading the warning the report would count as cleanly
// sent and the loss of `meta.id` — the only field that answers "how many people saw
// this" — would be silent, which is the one thing that clause exists to prevent.
const beforeWarned = await summary()
const warnedLines = () => logs.filter(entry => entry[0] === 'warn' && String(entry[1]).includes('предупреждением'))
const warnsBefore = warnedLines().length
answerMode = 'warned'
const warned = await reportOf(UPSTREAM_502, 'rustvy', 'sess-warned')
check('a warned report was still delivered', warned.drained.posts.length === 1 && warned.drained.posts[0]?.answer?.status === 200, JSON.stringify(warned.drained.posts[0]?.answer))
check('a warned report still counts as sent', warned.answer.json?.sent === beforeWarned.sent + 1, `${beforeWarned.sent} → ${warned.answer.json?.sent}`)
check('a warned report is neither dropped nor left queued', warned.answer.json?.dropped === beforeWarned.dropped && warned.answer.json?.queued === 0, JSON.stringify({ dropped: warned.answer.json?.dropped, queued: warned.answer.json?.queued }))
check('the warning was said, once', warnedLines().length === warnsBefore + 1, `${warnsBefore} → ${warnedLines().length}`)
check('the warning explains the code rather than printing it', String(warnedLines().at(-1)?.[1] ?? '').includes('8 КБ') && !String(warnedLines().at(-1)?.[1] ?? '').includes('meta_too_large'), String(warnedLines().at(-1)?.[1]))
check('the warning names the report it was about', String(warnedLines().at(-1)?.[1] ?? '').includes('upstream_502'), String(warnedLines().at(-1)?.[1]))
// Announced once per revision rather than per report: a client that consistently
// oversizes `meta` would otherwise log on every flush, through a channel nobody
// reading a chat can turn off.
const warnedAgain = await reportOf(UPSTREAM_503, 'rustvy', 'sess-warned-2')
check('a second warned report is delivered too', warnedAgain.drained.posts.length === 1 && warnedAgain.answer.json?.sent === warned.answer.json?.sent + 1, String(warnedAgain.answer.json?.sent))
check('a second warned report is not announced again', warnedLines().length === warnsBefore + 1, `${warnsBefore + 1} → ${warnedLines().length}`)
answerMode = 'auto'

// --- the switch ------------------------------------------------------------
const beforeSwitch = await summary()
const switchedOff = await call('POST', '/dsh-rustvy/config', { collectErrors: false })
check('the switch is written', switchedOff.status === 200 && switchedOff.json?.config?.collectErrors === false, JSON.stringify(switchedOff.json?.config))
check('the switch is refused a non-URL endpoint', (await call('POST', '/dsh-rustvy/config', { uptimeEndpoint: 'not a url' })).json?.config?.collectErrors === false)
const offReport = await reportOf(UPSTREAM_502, 'rustvy', 'sess-off')
check('with collection off nothing is delivered', offReport.drained.reports.length === 0, JSON.stringify(offReport.drained.reports))
check('with collection off nothing is queued', offReport.answer.json?.queued === 0, String(offReport.answer.json?.queued))
check('with collection off the summary says so', offReport.answer.json?.enabled === false, String(offReport.answer.json?.enabled))
check('with collection off nothing was counted', offReport.answer.json?.failures === beforeSwitch.failures && offReport.answer.json?.attempts === beforeSwitch.attempts, `${beforeSwitch.failures} → ${offReport.answer.json?.failures}`)
const offTest = await call('POST', '/dsh-rustvy/errors', { action: 'test' })
check('the self-test says so when collection is off', offTest.status === 200 && offTest.json?.ok === false, `status ${offTest.status}`)
check('the self-test explains itself in Russian', offTest.json?.error === 'сбор ошибок выключен настройкой плагина', String(offTest.json?.error))
check('the self-test still answers with a summary when off', typeof offTest.json?.installId === 'string', JSON.stringify(offTest.json).slice(0, 160))
await call('POST', '/dsh-rustvy/config', { collectErrors: true })
check('the switch turns back on', (await summary()).enabled === true)

// --- every failure accounted for --------------------------------------------
// One failure of each outcome, driven in sequence, and the identity that makes a
// missed outage answerable: whatever the seam was handed is in exactly one bucket.
// Before this, a failure that `classifyFailure` read as somebody's own problem was
// dropped by design and moved no number at all, so "the gateway's error page said
// «token»" and "the watcher is dead" looked identical from a browser.
const bucketsBefore = await summary()

const bucketReported = await begin('sess-bucket-1', 'rustvy', MODEL)
await tick()
await failInBand(bucketReported, UPSTREAM_502)
// The same attempt again: the in-band seam already reported it, so this one is a
// duplicate rather than a second outage.
await failInBand(bucketReported, UPSTREAM_502)

// A session this half never saw a request for.
await failEvent({ sessionId: 'sess-bucket-none', turn: 3, step: 3, resolved: { provider: 'rustvy' } }, UPSTREAM_503)

const bucketNonInfra = await begin('sess-bucket-2', 'rustvy', MODEL)
await tick()
await failInBand(bucketNonInfra, { message: 'the request was aborted', code: 'ABORTED' })

const bucketForeign = await begin('sess-bucket-3', 'deepseek-official', MODEL)
await tick()
await failInBand(bucketForeign, UPSTREAM_502)

await call('POST', '/dsh-rustvy/config', { collectErrors: false })
const bucketOff = await begin('sess-bucket-4', 'rustvy', MODEL)
await tick()
await failInBand(bucketOff, UPSTREAM_502)
await call('POST', '/dsh-rustvy/config', { collectErrors: true })

const bucketsAfter = await summary()
const moved = key => (bucketsAfter[key] ?? 0) - (bucketsBefore[key] ?? 0)
check('six failures reached the seam', moved('seen') === 6, String(moved('seen')))
check('one was reported against its attempt', moved('reported') === 1, String(moved('reported')))
check('one was a duplicate of a reported attempt', moved('duplicates') === 1, String(moved('duplicates')))
check('one was reported without an attempt', moved('unattributed') === 1, String(moved('unattributed')))
check('one was dropped as somebody own problem', moved('ignoredNonInfra') === 1, String(moved('ignoredNonInfra')))
check('one was dropped as a foreign route', moved('ignoredRoute') === 1, String(moved('ignoredRoute')))
check('one was dropped because collection was off', moved('ignoredCollect') === 1, String(moved('ignoredCollect')))
check('none fell through the buckets', moved('ignoredInternal') === 0, String(moved('ignoredInternal')))
const bucketSum = moved('reported') + moved('unattributed') + moved('ignoredNonInfra') + moved('ignoredRoute') + moved('ignoredCollect') + moved('duplicates') + moved('ignoredInternal')
check('every failure the seam saw is in exactly one bucket', moved('seen') === bucketSum, `seen ${moved('seen')} vs buckets ${bucketSum}`)
check('the non-infra drop named the classification that dropped it', bucketsAfter.lastKind === 'aborted' && bucketsAfter.lastCode === 'ABORTED', JSON.stringify({ lastKind: bucketsAfter.lastKind, lastCode: bucketsAfter.lastCode }))
check('the histogram counted the drop that moved the last value', moved('ignoredNonInfra') === sumOf(bucketsAfter.ignoredByKind) - sumOf(bucketsBefore.ignoredByKind), `${sumOf(bucketsBefore.ignoredByKind)} → ${sumOf(bucketsAfter.ignoredByKind)}`)
check('the histogram names the kind that dropped it', (bucketsAfter.ignoredByKind?.aborted ?? 0) === (bucketsBefore.ignoredByKind?.aborted ?? 0) + 1, JSON.stringify(bucketsAfter.ignoredByKind))
check('the histogram totals the non-infra drops', sumOf(bucketsAfter.ignoredByKind) === bucketsAfter.ignoredNonInfra, `${sumOf(bucketsAfter.ignoredByKind)} vs ${bucketsAfter.ignoredNonInfra}`)
const bucketDrain = await drain()
check('only the two reported failures went out', bucketDrain.reports.length === 2, JSON.stringify(bucketDrain.reports.map(one => one?.code)))
check('the four dropped ones went nowhere', bucketDrain.reports.every(one => one?.code === 'upstream_502' || one?.code === 'upstream_503'), JSON.stringify(bucketDrain.reports.map(one => one?.code)))

// --- the hand-run diagnostic ------------------------------------------------
// The settings page no longer carries a button for this, so the route is a
// diagnostic somebody runs by hand — which is exactly why it must not leave a mark
// on a public dashboard.
const beforeSelfTest = await summary()
const tested = await call('POST', '/dsh-rustvy/errors', { action: 'test' })
check('the self-test answers 200', tested.status === 200, `status ${tested.status}`)
check('the self-test answers with a summary', tested.json?.ok === true && typeof tested.json?.installId === 'string', JSON.stringify(tested.json).slice(0, 200))
check('the self-test reports itself sent', tested.json?.sent === beforeSelfTest.sent + 1, `${beforeSelfTest.sent} → ${tested.json?.sent}`)
check('the self-test leaves nothing queued', tested.json?.queued === 0, String(tested.json?.queued))
const testPost = collected[collected.length - 1]
check('the self-test delivered one flat report', typeof testPost?.body === 'object' && testPost.body !== null && testPost.body.events === undefined, JSON.stringify(testPost?.body ?? null).slice(0, 240))
// The collector seeds its model universe from its own config and then adds any model
// id it sees in a report, so a self-test that named one invented a row on a public
// dashboard and left it there for the length of its retention. It must name nothing
// and land in the bucket every unidentified report already shares.
check('the self-test invents no model', testPost?.body?.model === 'unknown', String(testPost?.body?.model))
check('the self-test invents no route', testPost?.body?.provider === '', String(testPost?.body?.provider))
check('the self-test is still identifiable by its code', testPost?.body?.code === 'test', String(testPost?.body?.code))
check('the self-test still carries the harness code beside it', testPost?.body?.meta?.harnessCode === 'TEST', String(testPost?.body?.meta?.harnessCode))
check('the self-test report carries the settings page sentence', testPost?.body?.message === 'проверочное событие со страницы настроек плагина', String(testPost?.body?.message))
check('the self-test report is stamped now', Math.abs((testPost?.body?.ts ?? 0) - Date.now()) < 60_000, String(testPost?.body?.ts))

// --- a collector that is itself down ---------------------------------------
const queuedBefore = await summary()
const realEndpoint = process.env.DSH_RUSTVY_UPTIME_ENDPOINT
process.env.DSH_RUSTVY_UPTIME_ENDPOINT = 'http://127.0.0.1:9/api/report'
const unreachable = await begin('sess-down', 'rustvy', MODEL)
await tick()
await failInBand(unreachable, UPSTREAM_502)
const refused = await drain()
check('an unreachable collector rejects nothing', refused.answer.status === 200 && refused.answer.json?.ok === true, `status ${refused.answer.status}`)
check('an unreachable collector delivered nothing', refused.reports.length === 0 && refused.posts.length === 0, String(refused.posts.length))
check('the record stays queued', refused.answer.json?.queued === 1, String(refused.answer.json?.queued))
check('the failure is counted', refused.answer.json?.failed > queuedBefore.failed, `${queuedBefore.failed} → ${refused.answer.json?.failed}`)
check('nothing was dropped by a transport failure', refused.answer.json?.dropped === queuedBefore.dropped, `${queuedBefore.dropped} → ${refused.answer.json?.dropped}`)
check('the reason is reported', typeof refused.answer.json?.lastError === 'string' && refused.answer.json.lastError !== '', String(refused.answer.json?.lastError))
check('delivery is postponed after a transport failure', refused.answer.json?.nextFlushAt > Date.now(), String(refused.answer.json?.nextFlushAt))
check('the backlog was written to disk', existsSync(join(STATE, 'errors-queue.json')) && Array.isArray(JSON.parse(readFileSync(join(STATE, 'errors-queue.json'), 'utf8'))), String(readFileSync(join(STATE, 'errors-queue.json'), 'utf8').slice(0, 120)))
process.env.DSH_RUSTVY_UPTIME_ENDPOINT = realEndpoint
const backlog = await drain()
check('the backlog goes out once the collector is back', backlog.reports.length === 1 && backlog.reports[0].model === MODEL, JSON.stringify(backlog.reports))
check('the queue is empty again', backlog.answer.json?.queued === 0, String(backlog.answer.json?.queued))
check('the delivered backlog kept its original stamp', Number.isInteger(backlog.reports[0]?.ts) && backlog.reports[0].ts <= Date.now(), String(backlog.reports[0]?.ts))
check('a reachable collector clears the reason', backlog.answer.json?.lastError === null, String(backlog.answer.json?.lastError))
check('the endpoint setting survived the round trip', queuedBefore.endpoint === backlog.answer.json?.endpoint, `${queuedBefore.endpoint} → ${backlog.answer.json?.endpoint}`)

// --- the default endpoint --------------------------------------------------
// Read in a child process, because the default is exactly what this test
// overrides: the point is what a profile with no settings file and no environment
// gets, which must be the public collector and not a leftover loopback address.
const defaultProfile = mkdtempSync(join(tmpdir(), 'dsh-rustvy-default-'))
const defaultEndpoint = await new Promise((resolve, reject) => {
  const script = [
    'process.env.DSH_PROFILE_DIR = process.argv[1]',
    'delete process.env.DSH_RUSTVY_UPTIME_ENDPOINT',
    "delete process.env.DSH_RUSTVY_NO_ERRORS",
    "const { start } = await import('./lib/host.js')",
    'let registered = null',
    'const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), webServer: { register: route => { registered = route; return () => {} } } }',
    'const handle = await start(ctx, {})',
    "const request = new (await import('node:events')).EventEmitter()",
    "request.method = 'GET'",
    "request.url = '/dsh-rustvy/state'",
    "request.socket = { remoteAddress: '127.0.0.1' }",
    "request.headers = { host: '127.0.0.1:1' }",
    'let text = ""',
    "const response = { writeHead() { return this }, end(payload) { text += payload === undefined ? '' : String(payload) } }",
    'registered.handler(request, response)',
    "request.emit('end')",
    'await new Promise(resolve => { setTimeout(resolve, 50) })',
    'const parsed = JSON.parse(text)',
    'console.log(JSON.stringify({ endpoint: parsed.errorReport?.endpoint, config: parsed.config?.uptimeEndpoint, collect: parsed.config?.collectErrors }))',
    'await handle.dispose()',
  ].join('\n')
  execFile(process.execPath, ['--input-type=module', '-e', script, defaultProfile], { cwd: process.cwd() }, (error, stdout) => {
    if (error !== null) reject(error)
    else resolve(JSON.parse(stdout.trim()))
  })
})
check('the default endpoint is the public collector', defaultEndpoint?.endpoint === PUBLIC_COLLECTOR, String(defaultEndpoint?.endpoint))
check('the default is what the settings file would carry', defaultEndpoint?.config === PUBLIC_COLLECTOR, String(defaultEndpoint?.config))
check('collection defaults to on', defaultEndpoint?.collect === true, String(defaultEndpoint?.collect))
rmSync(defaultProfile, { recursive: true, force: true })

// --- the histogram is bounded -----------------------------------------------
// A failure storm produces many kinds, and an unbounded map would be the one part of
// this summary that could grow for the life of the process. Driven well past the cap
// on purpose, with `http_NNN` because that is the open-ended family a real gateway
// can emit — one kind per status it happens to answer with.
const beforeHistogram = await summary()
const kindsBefore = Object.keys(beforeHistogram.ignoredByKind ?? {}).length
// 430-459 rather than 400-429: `./errors.js` calls 404 and 408 infrastructure by
// design — a gateway with no route for the model it was asked to route, and a request
// that never finished, are both facts about the service rather than about the caller
// — so a range including them mixes reported failures into what is meant to be a run
// of drops, and the arithmetic below would measure two things at once.
for (let status = 430; status < 460; status += 1) {
  const capped = await begin(`sess-cap-${status}`, 'rustvy', MODEL)
  await failInBand(capped, { message: `the origin answered ${status}`, code: 'SERVER' })
}
const afterHistogram = await summary()
const kinds = Object.keys(afterHistogram.ignoredByKind ?? {})
check('the histogram grew while there was room', kinds.length > kindsBefore, `${kindsBefore} → ${kinds.length}`)
check('the histogram stops at its cap plus the overflow bucket', kinds.length === 25, `${kinds.length} keys`)
check('what did not fit is folded into one overflow bucket', Number.isInteger(afterHistogram.ignoredByKind?.other) && afterHistogram.ignoredByKind.other >= 1, String(afterHistogram.ignoredByKind?.other))
check('every drop was still counted', afterHistogram.ignoredNonInfra === beforeHistogram.ignoredNonInfra + 30, `${beforeHistogram.ignoredNonInfra} → ${afterHistogram.ignoredNonInfra}`)
check('the histogram totals the drops even past the cap', sumOf(afterHistogram.ignoredByKind) === afterHistogram.ignoredNonInfra, `${sumOf(afterHistogram.ignoredByKind)} vs ${afterHistogram.ignoredNonInfra}`)
check('a rare kind survived the cap rather than being evicted', kinds.some(kind => /^http_4/u.test(kind)), JSON.stringify(kinds.slice(0, 6)))
check('none of the capped failures reached the collector', (await drain()).reports.length === 0)

// The same identity over the whole run rather than over one phase: every failure
// this revision was handed, from the first shape check to the last, is in exactly
// one bucket. Checked before the reload below, which resets them by design.
const whole = await summary()
const wholeSum = whole.reported + whole.unattributed + whole.ignoredNonInfra + whole.ignoredRoute + whole.ignoredCollect + whole.duplicates + whole.ignoredInternal
check('every failure this revision saw is accounted for', whole.seen === wholeSum, `seen ${whole.seen} vs ${wholeSum}: ${JSON.stringify({ reported: whole.reported, unattributed: whole.unattributed, ignoredNonInfra: whole.ignoredNonInfra, ignoredRoute: whole.ignoredRoute, ignoredCollect: whole.ignoredCollect, duplicates: whole.duplicates, ignoredInternal: whole.ignoredInternal })}`)
check('nothing fell through the buckets all run', whole.ignoredInternal === 0, String(whole.ignoredInternal))
check('the histogram totals the non-infra drops all run', sumOf(whole.ignoredByKind) === whole.ignoredNonInfra, `${sumOf(whole.ignoredByKind)} vs ${whole.ignoredNonInfra}`)
check('the drop counters are on the summary the page reads', ['seen', 'reported', 'ignoredNonInfra', 'ignoredRoute', 'ignoredCollect', 'duplicates', 'ignoredByKind', 'lastCode', 'lastKind'].every(key => key in whole), JSON.stringify(Object.keys(whole)))

// --- a reload keeps the identity -------------------------------------------
const installId = (await summary()).installId
await handle.dispose()
check('dispose released the route', route === null)
check('dispose released every listener', listeners.size === 0, JSON.stringify([...listeners.keys()]))
handle = await start(ctx, {})
const reloaded = await summary()
check('a reload starts the watcher counters over', reloaded.seen === 0 && reloaded.reported === 0 && reloaded.unattributed === 0 && reloaded.tracked === 0, JSON.stringify({ seen: reloaded.seen, reported: reloaded.reported, unattributed: reloaded.unattributed, tracked: reloaded.tracked }))
check('a reload clears the last dropped classification', reloaded.lastCode === null && reloaded.lastKind === null, JSON.stringify({ lastCode: reloaded.lastCode, lastKind: reloaded.lastKind }))
check('a reload clears the histogram', sumOf(reloaded.ignoredByKind) === 0 && Object.keys(reloaded.ignoredByKind ?? {}).length === 0, JSON.stringify(reloaded.ignoredByKind))
check('a second mount reinstalls the watchers', (listeners.get('agent/request') ?? []).length === 2 && (listeners.get('agent/request-error') ?? []).length === 1 && (listeners.get('session/event') ?? []).length === 1)
const remounted = await call('GET', '/dsh-rustvy/state')
check('a second mount reuses the install id', remounted.json?.errorReport?.installId === installId, `${installId} → ${remounted.json?.errorReport?.installId}`)
check('the identity on disk is unchanged', JSON.parse(readFileSync(join(STATE, 'install.json'), 'utf8'))?.id === installId)
check('a second mount reads the queue back', Number.isInteger(remounted.json?.errorReport?.queued), String(remounted.json?.errorReport?.queued))

// The announcement is once per *revision*, so a reload re-arms it — and this is also
// where an unknown code gets exercised, since the known one was already announced by
// the revision above.
const warnsAfterReload = warnedLines().length
answerMode = 'warned-unknown'
const unknownWarning = await reportOf(UPSTREAM_502, 'rustvy', 'sess-warned-unknown')
check('a warned report after a reload is announced again', warnedLines().length === warnsAfterReload + 1, `${warnsAfterReload} → ${warnedLines().length}`)
check('an unknown code is passed through rather than dropped', String(warnedLines().at(-1)?.[1] ?? '').includes('some_future_code'), String(warnedLines().at(-1)?.[1]))
check('an unknown code still counts as sent', unknownWarning.answer.json?.sent === reloaded.sent + 1, `${reloaded.sent} → ${unknownWarning.answer.json?.sent}`)
answerMode = 'auto'
await handle.dispose()

// A third revision, for the case the contract is most specific about: elements that are
// not strings at all. Printing them as they arrived is the rule; counting them instead
// would throw away content the collector did send, and parsing them would mean coding
// for a shape the contract considered and rejected.
handle = await start(ctx, {})
const beforeJunk = await summary()
const warnsBeforeJunk = warnedLines().length
answerMode = 'warned-junk'
const junkWarning = await reportOf(UPSTREAM_502, 'rustvy', 'sess-warned-junk')
check('a warning this half cannot read is still announced', warnedLines().length === warnsBeforeJunk + 1, `${warnsBeforeJunk} → ${warnedLines().length}`)
const junkLine = String(warnedLines().at(-1)?.[1] ?? '')
// The detail text could only reach the log by printing the object as it arrived: this
// half never looks at a `detail` field, and never will.
check('an unrecognized element is printed as it arrived', junkLine.includes('meta was 9123 bytes'), junkLine)
check('it is printed as text rather than translated', junkLine.includes('{"code"'), junkLine)
check('a non-string element is printed too', junkLine.includes('42'), junkLine)
check('an unrecognized warning still counts as sent', junkWarning.answer.json?.sent === beforeJunk.sent + 1, `${beforeJunk.sent} → ${junkWarning.answer.json?.sent}`)
answerMode = 'auto'
await handle.dispose()

collector.close()
Date.now = realNow
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail === undefined ? '' : ` — ${result.detail}`}`)
  process.exit(1)
}
