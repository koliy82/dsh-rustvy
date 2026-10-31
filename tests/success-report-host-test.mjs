// The four combinations of the two collection settings, end to end.
//
// §7 requires that turning success collection off stops *sending* and not *counting*,
// and that the two settings are independent. Independence is the part that is easy to
// get subtly wrong, because the reporter's own send gate (`enabled`) resolves to the
// error setting — so before the gate was split, "errors off" silenced the success
// counter too and combination 3 was impossible. These checks assert the wire, not the
// wiring: what actually reached a local collector, and what the counter read.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-success-matrix-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE
delete process.env.DSH_RUSTVY_NO_ERRORS
delete process.env.DSH_RUSTVY_NO_SUCCESSES
delete process.env.RUSTVY_API_KEY

const MODEL = 'claude-opus-5-5'
/**
 * The chat every attributed attempt in this file belongs to.
 *
 * It has to match the session the `assistant/message` event names, or the closing event
 * does not find the attempt the opening one recorded and the sample silently becomes an
 * unattributed one — which is the exact confusion this file now has a section for.
 */
const SESSION = 'sess-matrix'

/**
 * Drop everything the reporter persisted, keeping the settings.
 *
 * Every mount in this file shares one profile directory, and the reporter restores its
 * queue and its open success windows from disk on construction. Without this a window
 * left pending by one mount arrives in the *next* mount's flush and gets attributed to
 * whatever that mount was testing — which is how a measured `{"n":1,"s":2,"x":2}` came to
 * look like evidence about a sample that had never been aggregated. A shared fixture
 * directory is shared state, and shared state has to be reset between scenarios or the
 * scenarios are not separate.
 */
function clearReporterState() {
  for (const name of readdirSync(STATE)) {
    if (name === 'config.json' || name === 'keys.json') continue
    try {
      unlinkSync(join(STATE, name))
    } catch {
      // A directory, or a file already gone: neither is state a mount would restore.
    }
  }
}

const results = []
/**
 * Record one assertion.
 *
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside the label, truncated so a failure stays readable.
 */
function check(label, ok, detail) {
  const shown = detail === undefined ? '' : `  — ${String(detail).slice(0, 400)}`
  results.push({ label, ok: ok === true, detail: shown })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${shown}`)
}

/**
 * A collector that records what it was sent.
 *
 * @returns the server, the received bodies, and the port it is on.
 */
async function startCollector() {
  const received = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      received.push({ path: request.url, json, text })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return { server, received, port: server.address().port }
}

const { start } = await import('../lib/host.js')

/**
 * Mount the plugin for one combination of the two settings.
 *
 * @param collector - the recording collector.
 * @param settings - `{ collectSuccesses, collectErrors }`.
 * @returns helpers to open an attempt, close it successfully, and read state.
 */
async function mount(collector, settings) {
  writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
    enabled: false, syncModels: false, apiKeys: false, collectErrors: settings.collectErrors,
    collectSuccesses: settings.collectSuccesses, uptimeView: false,
    uptimeEndpoint: `http://127.0.0.1:${collector.port}/api/report`,
    // The bootstrap must not write a route into this fixture: the row already owns one.
    origin: `http://127.0.0.1:${collector.port}`,
  }, null, 2)}\n`)
  const listeners = new Map()
  let route = null
  const entry = {
    options: {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { rustvy: { displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', baseURL: `${ORIGIN}/v1`, models: [{ id: MODEL, name: MODEL, maxTokens: 8192 }] } } },
    },
    fiber: {},
  }
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
    on: (name, listener) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const at = list.indexOf(listener)
        if (at >= 0) list.splice(at, 1)
      }
    },
  }
  ctx.webServer = { register: r => { route = r; return () => { route = null } } }
  ctx.configEditor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: {} }],
    edit: async () => {},
  }
  clearReporterState()
  const handle = await start(ctx, {})
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = method
    request.url = path
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); return this },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        const text = Buffer.concat(chunks.map(c => Buffer.from(String(c)))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, json, text })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    setTimeout(() => reject(new Error(`timeout ${method} ${path}`)), 30_000).unref()
  })
  /**
   * Run one waterfall the way the harness does: outermost first, a listener that does
   * not call `next` vetoes the rest.
   *
   * @param name - the event.
   * @param payload - the payload; `agent` is injected, as the dispatcher does.
   * @param base - the innermost behaviour, standing in for the harness's own.
   * @returns the waterfall's answer.
   */
  async function dispatch(name, payload, base) {
    // The harness dispatcher injects the agent scope; the call site does not supply it
    // (`dsh-agent/lib/types/dispatch.js:42`, `{...payload, agent}`, spread first so a
    // caller cannot override it). Faking the payload without fusing the agent reads as
    // a plausible request and silently records nothing: the host takes the session id
    // from `payload.agent.session.id`, so without it `recordAttempt` returns early and
    // every success below takes the unattributed path while looking attributed.
    const fused = { ...payload, agent: { session: { id: SESSION } } }
    const chain = [...(listeners.get(name) ?? [])]
    let index = 0
    const next = () => {
      const listener = chain[index]
      index += 1
      return listener === undefined ? base(fused, next) : listener(fused, next)
    }
    return await next()
  }
  /**
   * Open one attempt and close it with a successful assistant message.
   *
   * @param turn - the turn number, unique per attempt.
   */
  async function succeed(turn) {
    await openOnly(turn)
    await closeOpen(turn)
  }
  /**
   * Open an attempt without closing it, so a test can change the settings underneath a
   * request that is genuinely in flight.
   *
   * @param turn - the turn number.
   */
  async function openOnly(turn) {
    await dispatch('agent/request', { turn, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'rustvy', model: MODEL }))
  }
  /**
   * Close an attempt opened by {@link openOnly}.
   *
   * @param turn - the turn number it was opened with.
   */
  async function closeOpen(turn) {
    for (const listener of listeners.get('session/event') ?? []) {
      listener({ id: SESSION }, {
        type: 'assistant/message',
        seq: turn * 2,
        time: Date.now(),
        data: { turn, step: 1, message: { source: { provider: 'rustvy', model: MODEL } } },
      })
    }
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
  /**
   * Close a step this half never saw a request for.
   *
   * The unattributed case, and the one the duration fix is about: there is no attempt,
   * so there is no `attempt.at` to measure against. Route and model come from the
   * message's own source, which is what makes the sample reportable at all — and what
   * makes its duration unknowable rather than merely unmeasured.
   *
   * @param turn - the turn number.
   */
  async function succeedUnattributed(turn) {
    for (const listener of listeners.get('session/event') ?? []) {
      listener({ id: 'sess-orphan' }, {
        type: 'assistant/message',
        seq: turn * 2 + 1,
        time: Date.now(),
        data: { turn, step: 1, message: { source: { provider: 'rustvy', model: MODEL } } },
      })
    }
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
  const state = async () => (await call('GET', '/dsh-rustvy/state')).json
  // Any POST to `/errors` ends in `reporter.flush({ settle: true })`, which is how a
  // window that would otherwise sit open for fifteen minutes is forced out.
  const flush = async () => call('POST', '/dsh-rustvy/errors', { action: 'flush' })
  return { handle, succeed, succeedUnattributed, openOnly, closeOpen, state, flush, call }
}

const collector = await startCollector()
const ORIGIN = `http://127.0.0.1:${collector.port}`

/**
 * The success reports a collector received.
 *
 * @param received - everything the collector saw.
 * @returns the bodies whose `kind` marks them as success windows.
 */
function successReportsOf(received) {
  return received.filter(one => one.json?.kind === 'ok')
}

// --- the four combinations ----------------------------------------------------
for (const [collectSuccesses, collectErrors] of [[true, true], [true, false], [false, true], [false, false]]) {
  const name = `successes=${collectSuccesses ? 'on ' : 'off'}, errors=${collectErrors ? 'on ' : 'off'}`
  collector.received.length = 0
  const mounted = await mount(collector, { collectSuccesses, collectErrors })
  const before = (await mounted.state())?.errorReport?.successes ?? 0
  await mounted.succeed(1)
  const counted = (await mounted.state())?.errorReport?.successes ?? 0
  await mounted.flush()
  await new Promise(resolve => { setTimeout(resolve, 60) })
  const successes = successReportsOf(collector.received)
  check(`${name}: the success was counted`, counted === before + 1, `${before} → ${counted}`)
  if (collectSuccesses) {
    check(`${name}: one success report left the process`, successes.length === 1, JSON.stringify(successes.map(one => one.json?.kind)))
    const record = successes[0]?.json
    check(`${name}: it carries per-model counters`, Array.isArray(record?.c) && record.c.some(one => one?.m === MODEL && one?.n === 1), JSON.stringify(record?.c))
    check(`${name}: it carries no durations`, JSON.stringify(record ?? {}).includes('"ms"') === false, JSON.stringify(record ?? {}).slice(0, 200))
    check(`${name}: it names the window`, typeof record?.window?.from === 'number' && typeof record?.window?.to === 'number', JSON.stringify(record?.window ?? null))
  } else {
    check(`${name}: nothing was sent`, successes.length === 0, JSON.stringify(successes.map(one => one.json)))
    check(`${name}: and no report of any kind left`, collector.received.length === 0, JSON.stringify(collector.received.map(one => one.json?.kind ?? one.path)))
  }
  await mounted.handle.dispose()
}

// --- the setting is read per attempt, so a toggle needs no restart ------------
collector.received.length = 0
const live = await mount(collector, { collectSuccesses: true, collectErrors: true })
await live.succeed(1)
await live.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
check('a success sent while the setting was on left the process', successReportsOf(collector.received).length === 1, JSON.stringify(successReportsOf(collector.received).map(one => one.json?.c)))
// Flip the setting under the running revision, the way the page does.
writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: false, syncModels: false, apiKeys: false, collectErrors: true, collectSuccesses: false,
  uptimeView: false, uptimeEndpoint: `http://127.0.0.1:${collector.port}/api/report`, origin: ORIGIN,
}, null, 2)}\n`)
collector.received.length = 0
await live.succeed(2)
check('the next attempt sees the change without a restart', (await live.state())?.config?.collectSuccesses === false, String((await live.state())?.config?.collectSuccesses))
await live.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
check('and its success is counted but not sent', successReportsOf(collector.received).length === 0, JSON.stringify(successReportsOf(collector.received).map(one => one.json)))
const afterFlip = (await live.state())?.errorReport?.successes ?? 0
check('the counter kept moving across the toggle', afterFlip >= 2, String(afterFlip))
await live.handle.dispose()

// --- an unattributed success must not invent a duration ------------------------
// `ms: at - (attempt?.at ?? at)` reads like a safe default and is not one. With no
// attempt it evaluates to `at - at`, which is zero; zero is finite and non-negative so
// it is accepted as a measurement, the window's completeness flag stays true, and the
// fabricated zero joins the duration sum. The published mean then understates the real
// one by exactly the unattributed fraction — linear in it, never upward, and a zero
// never raises a maximum, so the only wrong number is the one a reader cannot detect.
const duration = await mount(collector, { collectSuccesses: true, collectErrors: true })
collector.received.length = 0
await duration.succeedUnattributed(11)
await duration.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
const orphanReports = successReportsOf(collector.received)
const orphanEntry = orphanReports[0]?.json?.c?.find(one => one?.m === MODEL)
check('an unattributed success still reaches the collector', orphanReports.length === 1 && orphanEntry?.n === 1, JSON.stringify(orphanReports.map(one => one.json?.c)))
check('its window carries no duration sum', orphanEntry !== undefined && !('s' in orphanEntry), JSON.stringify(orphanEntry))
check('its window carries no duration maximum', orphanEntry !== undefined && !('x' in orphanEntry), JSON.stringify(orphanEntry))
await duration.handle.dispose()

// Every sample attributed: the aggregates are still published, so the fix removes a
// wrong number rather than removing the number.
const measured = await mount(collector, { collectSuccesses: true, collectErrors: true })
collector.received.length = 0
await measured.succeed(21)
await measured.succeed(22)
await measured.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
const measuredEntry = successReportsOf(collector.received)[0]?.json?.c?.find(one => one?.m === MODEL)
check('a fully attributed window still counts its samples', measuredEntry?.n === 2, String(measuredEntry?.n))
check('and still carries a duration sum', typeof measuredEntry?.s === 'number', JSON.stringify(measuredEntry))
check('and still carries a duration maximum', typeof measuredEntry?.x === 'number', JSON.stringify(measuredEntry))
// A genuine zero, pinned beside the fabricated one task-55 removed, because the two are
// byte-identical on the wire. These attempts open and close inside the same millisecond,
// so `at - attempt.at` really is 0 — observed as `{"n":2,"s":0,"x":0}` — which is the same
// value an unattributed sample used to carry. What separates them is not the number but
// the key: an attributed window has `s` and `x` whose values may be zero, an unattributed
// one has neither. That is why `nullableMs` cannot decide by value and has to decide by
// presence, and why the fix was to pass `undefined` rather than a sentinel. Asserted as
// presence rather than as `s === 0`, because the zero depends on how fast the machine is
// and the presence does not.
check('an attributed window carries both aggregate keys', 's' in (measuredEntry ?? {}) && 'x' in (measuredEntry ?? {}), JSON.stringify(measuredEntry))
check('an unattributed one carries neither, so absence is the whole distinction', !('s' in (orphanEntry ?? {})) && !('x' in (orphanEntry ?? {})), JSON.stringify({ unattributed: orphanEntry, attributed: measuredEntry }))
check('and a real measurement is never negative, so zero is a value and not a sentinel', typeof measuredEntry?.s === 'number' && measuredEntry.s >= 0, String(measuredEntry?.s))
await measured.handle.dispose()

// One unattributed sample among attributed ones. The mean would be biased, so the
// aggregate is withheld for the entry rather than published partially — a partial sum
// satisfies the letter of "the plugin does not publish a partial sum" and violates its
// meaning, which is how this shipped.
const mixed = await mount(collector, { collectSuccesses: true, collectErrors: true })
collector.received.length = 0
await mixed.succeed(31)
await mixed.succeedUnattributed(32)
await mixed.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
const mixedEntry = successReportsOf(collector.received)[0]?.json?.c?.find(one => one?.m === MODEL)
check('a mixed window still counts every sample', mixedEntry?.n === 2, String(mixedEntry?.n))
check('but publishes no mean built on a fabricated zero', mixedEntry !== undefined && !('s' in mixedEntry), JSON.stringify(mixedEntry))
await mixed.handle.dispose()

// --- the setting in force when the request left, against a toggle mid-flight -----
// RESOLVED. An earlier version of this section was deleted because it failed in a
// direction the code did not explain: opened under `collectSuccesses: true` then flipped
// to false sent nothing, while opened under `false` then flipped to `true` sent a report
// carrying a measured `{"n":1,"s":2,"x":2}`. Read as one call, those contradict each
// other, because `send` and `ms` read the same `attempt` variable.
//
// They were not one call, and they were not one state of the file. Instrumenting with a
// fresh profile per scenario (`tmp/probe-attempt-send.mjs`) showed `tracked: 1` in all
// four cases, so the attempt *was* recorded and did carry its setting. The two
// observations decompose as:
//
//   * Nothing is decided by one gate. The per-attempt `send` decides whether a sample is
//     *aggregated* into a window; the reporter's `successEnabled()` reads the setting
//     again at *delivery* and decides whether the window may leave. "Opened ON, flipped
//     OFF" aggregates the sample and then refuses to deliver it — which is not an
//     inversion of `send`, it is the second gate doing its job.
//   * The measured `s: 2` was never about that sample. Every mount here shares one
//     profile directory and the reporter restores its open windows from disk, so a
//     window left pending by an earlier mount arrived in a later mount's flush and was
//     read as evidence about a sample that had not been aggregated at all. That is what
//     `clearReporterState()` above now prevents.
//
// So the product code was right and both old observations were artifacts — one of
// composition, one of shared fixture state. What follows pins the composed behaviour,
// including the case lead named as release-blocking if it ever failed.
/**
 * Run one in-flight scenario: open an attempt, rewrite the setting, complete the request.
 *
 * @param openedWith - `collectSuccesses` while the request is in flight.
 * @param flippedTo - the value rewritten before the request completes.
 * @returns the success windows that reached the collector, and the counter's move.
 */
async function inFlight(openedWith, flippedTo) {
  const mounted = await mount(collector, { collectSuccesses: openedWith, collectErrors: true })
  await mounted.openOnly(71)
  const tracked = (await mounted.state())?.errorReport?.tracked
  writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
    enabled: false, syncModels: false, apiKeys: false, collectErrors: true,
    collectSuccesses: flippedTo, uptimeView: false,
    uptimeEndpoint: `http://127.0.0.1:${collector.port}/api/report`, origin: ORIGIN,
  }, null, 2)}\n`)
  const flipped = (await mounted.state())?.config?.collectSuccesses
  const before = (await mounted.state())?.errorReport?.successes ?? 0
  collector.received.length = 0
  await mounted.closeOpen(71)
  await mounted.flush()
  await new Promise(resolve => { setTimeout(resolve, 60) })
  const after = (await mounted.state())?.errorReport?.successes ?? 0
  const windows = successReportsOf(collector.received)
  await mounted.handle.dispose()
  return { tracked, flipped, windows, counted: after - before }
}

for (const [openedWith, flippedTo, expectSent, label] of [
  [true, true, true, 'on, left on'],
  [false, false, false, 'off, left off'],
  [true, false, false, 'on, turned off mid-flight'],
  [false, true, false, 'off, turned on mid-flight'],
]) {
  const run = await inFlight(openedWith, flippedTo)
  check(`${label}: the attempt was recorded`, run.tracked === 1, String(run.tracked))
  check(`${label}: the flip took effect without a restart`, run.flipped === flippedTo, String(run.flipped))
  check(`${label}: the success was still counted`, run.counted === 1, String(run.counted))
  check(`${label}: sending is ${expectSent ? 'expected' : 'not expected'}`, (run.windows.length === 1) === expectSent, JSON.stringify(run.windows.map(one => one.json?.c)))
}

// The privacy property, stated on its own because it is the one that blocks a release: a
// request that went out while success collection was OFF must not leave the machine
// because somebody turned the setting ON while it was in flight. It is the promise
// `send: false` exists to keep, and it is asserted here rather than inferred from the
// gate's existence.
const privacy = await inFlight(false, true)
check('a request that left under "do not collect" never leaves, even if the setting is turned on mid-flight', privacy.windows.length === 0, JSON.stringify(privacy.windows.map(one => one.json)))
// And the aggregate that does leave carries a real measurement, so the four cases above
// are not all passing by sending nothing.
const control = await inFlight(true, true)
check('the control case carries a measured duration, so the others are not passing vacuously', typeof control.windows[0]?.json?.c?.[0]?.s === 'number', JSON.stringify(control.windows[0]?.json?.c))

// --- permission attaches to the request, and a later toggle neither grants nor
// --- withdraws it — for a sample collected while OFF, which is the half that survived.
// The other half was cancelled by the user's «Оставляем очередь только для ошибок»:
// success windows are neither persisted nor retried, so a window the delivery gate blocks
// is dropped and counted rather than held. The error path is untouched and still durable,
// which makes the two paths deliberately asymmetric; see the note on the assertion below.
/**
 * Rewrite the settings file under a running revision.
 *
 * @param collectSuccesses - the value to set.
 */
function rewriteSettings(collectSuccesses) {
  writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
    enabled: false, syncModels: false, apiKeys: false, collectErrors: true, collectSuccesses,
    uptimeView: false, uptimeEndpoint: `http://127.0.0.1:${collector.port}/api/report`, origin: ORIGIN,
  }, null, 2)}\n`)
}

const reenable = await mount(collector, { collectSuccesses: true, collectErrors: true })
await reenable.succeed(81)
rewriteSettings(false)
check('the setting reads as off before the first flush', (await reenable.state())?.config?.collectSuccesses === false, String((await reenable.state())?.config?.collectSuccesses))
const lostBefore = (await reenable.state())?.errorReport?.successWindowsLost ?? 0
collector.received.length = 0
await reenable.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
check('nothing leaves while the setting is off', successReportsOf(collector.received).length === 0, JSON.stringify(successReportsOf(collector.received).map(one => one.json?.c)))
// Task-58: a blocked window is dropped rather than held, and the drop is counted in
// windows rather than samples. The count is what makes the loss knowable — without it the
// only evidence would be a percentage that quietly stopped including fifteen minutes.
const lostAfter = (await reenable.state())?.errorReport?.successWindowsLost ?? 0
check('the blocked window is dropped and counted, not held for later', lostAfter === lostBefore + 1, `${lostBefore} → ${lostAfter}`)
rewriteSettings(true)
check('and reads as on again before the second flush', (await reenable.state())?.config?.collectSuccesses === true, String((await reenable.state())?.config?.collectSuccesses))
collector.received.length = 0
await reenable.flush()
await new Promise(resolve => { setTimeout(resolve, 60) })
const late = successReportsOf(collector.received)
// The cancelled rule, kept as a named assertion rather than deleted. This used to require
// that the window leaves once the setting returns, on the principle that permission
// attaches to the request and a later toggle neither grants nor withdraws it. The user
// ruled «Оставляем очередь только для ошибок»: success windows are neither persisted nor
// retried, so the window was dropped at the flush above and re-enabling cannot bring it
// back. What survives of the principle is the privacy-critical half, asserted in the
// in-flight section — a sample collected while the setting was off never leaves, whatever
// happens afterwards. Asserting the reversal explicitly is what stops a future refactor
// "restoring" durability and silently re-widening the promise nobody re-approved.
check('re-enabling does not resurrect a window dropped while the setting was off', late.length === 0, JSON.stringify(late.map(one => one.json?.c)))
await reenable.handle.dispose()

collector.server.close()
rmSync(PROFILE, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
