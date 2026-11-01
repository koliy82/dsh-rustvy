/* Throwaway: measure the traffic a success window actually costs. Deleted after use. */
import { successPayload, reportPayload, SUCCESS_WINDOW_MS } from '../lib/errors.js'

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')

/* A realistic install id and twelve realistic model ids. */
const ID = 'd66d4114-3f2a-4c81-9b7e-0a5f1c2d3e44'
const MODELS = [
  'claude-opus-5-5', 'claude-sonnet-4-5', 'gpt-6.1-sol', 'gpt-6.1-luna',
  'deepseek-chat', 'deepseek-reasoner', 'gemini-2.5-pro', 'gemini-2.5-flash',
  'qwen3-max', 'kimi-k2-instruct', 'llama-4-maverick', 'mistral-large-3',
]

function windowDoc(modelCount, countPerModel) {
  return successPayload({
    t: 1_761_763_200_000,
    to: 1_761_763_200_000 + SUCCESS_WINDOW_MS,
    route: 'rustvy',
    id: ID,
    c: MODELS.slice(0, modelCount).map(model => [model, countPerModel]),
  })
}

console.log('=== one success window report, by number of models ===')
for (const n of [1, 3, 6, 12]) {
  const doc = windowDoc(n, 8)
  console.log(`  ${String(n).padStart(2)} models: ${String(bytes(doc)).padStart(4)} bytes`)
}

const twelve = windowDoc(12, 8)
console.log(`\nthe 12-model document:\n  ${JSON.stringify(twelve)}`)
const size12 = bytes(twelve)

console.log('\n=== the constant part versus the per-model part ===')
const one = windowDoc(1, 8)
const two = windowDoc(2, 8)
const perModel = bytes(two) - bytes(one)
console.log(`  one model:   ${bytes(one)} bytes`)
console.log(`  two models:  ${bytes(two)} bytes`)
console.log(`  per model:   ${perModel} bytes (delta of two real documents, not an estimate)`)
console.log(`  constant:    ${bytes(one) - perModel} bytes`)

console.log('\n=== a working day ===')
const HOURS = 8
const windowsPerDay = (HOURS * 3_600_000) / SUCCESS_WINDOW_MS
console.log(`  window:                ${SUCCESS_WINDOW_MS / 60000} minutes`)
console.log(`  windows in ${HOURS} h:         ${windowsPerDay}`)
for (const models of [1, 3, 12]) {
  const size = bytes(windowDoc(models, 8))
  const day = size * windowsPerDay
  console.log(`  ${String(models).padStart(2)} models: ${String(size).padStart(4)} B/report x ${windowsPerDay} = ${String(Math.round(day)).padStart(6)} B = ${(day / 1024).toFixed(1)} KiB/day`)
}

console.log('\n=== against the contract estimate (~560 B/report, ~18 KiB/day) ===')
console.log(`  measured 12-model report: ${size12} bytes  (estimate 560, delta ${size12 - 560})`)
const dayBytes = size12 * windowsPerDay
console.log(`  measured 12-model day:    ${(dayBytes / 1024).toFixed(1)} KiB  (estimate 18 KiB)`)

console.log('\n=== what the alternative would have cost ===')
const requestsPerDay = 231
console.log(`  one report per success, ${requestsPerDay} requests/day:`)
const perRequest = bytes(reportPayload({
  t: 1_761_763_200_000, model: 'claude-opus-5-5', route: 'rustvy', kind: 'http_502',
  status: 502, ms: 1234, id: ID, code: 'PI_AI_ERROR', err: 'upstream_502: the gateway could not reach the model origin',
}))
console.log(`    an error report is ${perRequest} bytes; a success document would be similar`)
console.log(`    ${requestsPerDay} x ~${perRequest} B = ${((requestsPerDay * perRequest) / 1024).toFixed(1)} KiB and ${requestsPerDay} requests`)
console.log(`  aggregated: ${windowsPerDay} requests and ${(dayBytes / 1024).toFixed(1)} KiB`)
console.log(`    requests avoided: ${requestsPerDay - windowsPerDay} of ${requestsPerDay} (${(100 * (1 - windowsPerDay / requestsPerDay)).toFixed(0)}%)`)

console.log('\n=== a realistic day, not a continuous one ===')
// Most windows in a working day have activity, but not all: meetings, reading, thinking.
for (const active of [0.25, 0.5, 1]) {
  const activeWindows = windowsPerDay * active
  const day = size12 * activeWindows
  console.log(`  ${String(active * 100).padStart(3)}% of windows active: ${activeWindows.toFixed(0)} reports, ${(day / 1024).toFixed(1)} KiB/day`)
}
console.log('  an idle machine: 0 reports, 0 bytes (an empty window sends nothing)')

console.log('\n=== HTTP overhead, because the body is not the whole cost ===')
const requestLine = 'POST /api/report HTTP/1.1\r\nHost: rustvy.xyz\r\nContent-Type: application/json\r\nContent-Length: 0000\r\n\r\n'
console.log(`  request headers alone: ${bytes(requestLine)} bytes (before the body)`)
console.log(`  so one 12-model window on the wire is about ${bytes(requestLine) + size12} bytes of request`)
console.log(`  and ${windowsPerDay} of them a day is about ${(((bytes(requestLine) + size12) * windowsPerDay) / 1024).toFixed(1)} KiB of request data`)

/* ------------------------------------------------------------------ *
 * Duration aggregates: three options priced as real documents.
 *
 * Nothing here changes lib/errors.js. Each variant is built by taking the real
 * `successPayload` output and adding the keys an implementation would add to the
 * same `c` entries, so the byte count is of a document that could be sent, not of
 * a sketch of one. Field names are short for the same reason `c`/`m`/`n` are:
 * this document goes out from every install every window.
 * ------------------------------------------------------------------ */

console.log('\n\n########## duration aggregates ##########')

/* SELF-TEST FIRST. If the unchanged shape does not reproduce the 534 bytes already
   established and published, this script is not measuring what it should and none
   of the numbers below can be trusted. A measurement that cannot reproduce its own
   baseline cannot distinguish its cases. */
const BASELINE = 534
const baselineNow = bytes(windowDoc(12, 8))
console.log(`\n=== self-test: the current shape, no durations ===`)
console.log(`  measured now: ${baselineNow} bytes   already established: ${BASELINE} bytes`)
console.log(`  ${baselineNow === BASELINE ? 'MATCH — the numbers below are comparable to the published one' : 'MISMATCH — stop, the script is not measuring the published shape'}`)
if (baselineNow !== BASELINE) process.exit(1)

/* Realistic latencies for a model behind a gateway: a mean around 2.5 s, a tail to
   30 s, and a last value near the mean. The exact digits matter less than their
   WIDTH, because JSON costs characters: a five-digit sum and a two-digit count are
   not the same price. */
const COUNT = 8
const SUM_MS = 20_140          // 5 digits
const MAX_MS = 31_204          // 5 digits
const LAST_MS = 2_487          // 4 digits
/* Eight doubling bins, open-ended at the top: <0.5, 0.5-1, 1-2, 2-4, 4-8, 8-16,
   16-32, >=32 seconds. Log scale because LLM response times span more than two
   decades; linear bins put almost every sample in bin zero and show no tail. */
const HISTOGRAM = [0, 1, 5, 1, 1, 0, 0, 0]

function variantDoc(modelCount, extra) {
  const doc = windowDoc(modelCount, COUNT)
  doc.c = doc.c.map(entry => ({ ...entry, ...extra(entry) }))
  return doc
}

const VARIANTS = [
  { key: 'current', label: 'current — counts only (§2 as it stands)', extra: () => ({}) },
  { key: 'A', label: 'A — sum + count  (mean over any range)', extra: () => ({ s: SUM_MS }) },
  { key: 'B', label: 'B — sum + count + max  (the case a mean hides)', extra: () => ({ s: SUM_MS, x: MAX_MS }) },
  { key: 'C', label: 'C — 8-bin log histogram  (percentiles)', extra: () => ({ s: SUM_MS, x: MAX_MS, h: HISTOGRAM }) },
  { key: 'D', label: 'D — last value only ("current response time")', extra: () => ({ l: LAST_MS }) },
  { key: 'B+D', label: 'B+D — sum, count, max and last', extra: () => ({ s: SUM_MS, x: MAX_MS, l: LAST_MS }) },
]

const HEADERS = bytes(requestLine)
const measured = {}
for (const variant of VARIANTS) {
  const twelveDoc = variantDoc(12, variant.extra)
  const oneDoc = variantDoc(1, variant.extra)
  const twoDoc = variantDoc(2, variant.extra)
  const size = bytes(twelveDoc)
  const perModel = bytes(twoDoc) - bytes(oneDoc)
  const constant = bytes(oneDoc) - perModel
  const dayBody = size * windowsPerDay
  const dayWire = (size + HEADERS) * windowsPerDay
  const base = measured.current ?? null
  measured[variant.key] = { size, perModel, constant, dayBody, dayWire }
  console.log(`\n=== ${variant.label} ===`)
  console.log(`  one entry looks like: ${JSON.stringify(twelveDoc.c[0])}`)
  console.log(`  12 models:      ${String(size).padStart(4)} bytes   (current ${BASELINE}, delta +${size - BASELINE}, +${(100 * (size - BASELINE) / BASELINE).toFixed(1)}%)`)
  console.log(`  constant part:  ${String(constant).padStart(4)} bytes   per model: ${perModel} bytes   (both as a delta of two real documents)`)
  console.log(`  ${HOURS} h day, ${windowsPerDay} windows:  body ${(dayBody / 1024).toFixed(1)} KiB   with HTTP headers ${(dayWire / 1024).toFixed(1)} KiB`)
  if (base) {
    console.log(`  growth over current:  body +${(100 * (dayBody - base.dayBody) / base.dayBody).toFixed(1)}%   on the wire +${(100 * (dayWire - base.dayWire) / base.dayWire).toFixed(1)}%  (the on-screen number is the one with headers)`)
  }
}

console.log('\n=== what one extra field costs, isolated ===')
const baseDoc = variantDoc(12, () => ({}))
for (const [name, extra] of [['s (sum)', { s: SUM_MS }], ['x (max)', { x: MAX_MS }], ['l (last)', { l: LAST_MS }], ['h (8 bins)', { h: HISTOGRAM }]]) {
  const withOne = bytes(variantDoc(12, () => extra))
  console.log(`  ${name.padEnd(11)} +${String(withOne - bytes(baseDoc)).padStart(3)} bytes per document   +${((withOne - bytes(baseDoc)) * windowsPerDay / 1024).toFixed(1)} KiB/day`)
}

console.log('\n=== does a duration aggregate make an empty window send? ===')
/* The rule "an empty window sends nothing" is not negotiable, so it is measured
   rather than reasoned about: a reporter that is told nothing sends nothing, with
   every duration field present in the aggregate it would have used. */
const { createReporter } = await import('../lib/errors.js')
let idlePosts = 0
let idleNow = 1_700_000_000_000
const idle = createReporter({
  endpoint: 'https://collector.test/api/report',
  identity: { id: ID },
  send: async () => { idlePosts += 1; return { status: 200 } },
  now: () => idleNow,
  limits: { SUCCESS_WINDOW_MS: 1000 },
})
idleNow += 5000
await idle.flush({ settle: true })
console.log(`  a reporter told nothing, five windows elapsed: ${idlePosts} requests`)
console.log(`  ${idlePosts === 0 ? 'an empty window still sends nothing' : 'REGRESSION: an empty window sent something'}`)
idle.dispose()

console.log('\n=== can "current response time" be derived instead of sent? ===')
console.log('  from the max:     no — the maximum of a window is not its last value')
console.log('  from a histogram: no — binning discards order, and "current" is an order claim')
console.log(`  from sum/count:   approximately, as the LATEST WINDOW MEAN — free once A is sent`)
console.log(`                    (A costs +${measured.A.size - BASELINE} bytes/document, +${((measured.A.dayWire - measured.current.dayWire) / 1024).toFixed(1)} KiB/day)`)
console.log(`  a true last value needs its own field: l costs +${bytes(variantDoc(12, () => ({ l: LAST_MS }))) - bytes(baseDoc)} bytes/document`)

console.log('\n=== summary, the number that goes on screen ===')
console.log('  variant   bytes/doc   KiB/day body   KiB/day with headers   vs current')
for (const variant of VARIANTS) {
  const m = measured[variant.key]
  const growth = variant.key === 'current' ? '—' : `+${(100 * (m.dayWire - measured.current.dayWire) / measured.current.dayWire).toFixed(0)}%`
  console.log(`  ${variant.key.padEnd(9)} ${String(m.size).padStart(6)}   ${(m.dayBody / 1024).toFixed(1).padStart(10)}   ${(m.dayWire / 1024).toFixed(1).padStart(14)}   ${growth.padStart(10)}`)
}

/* ------------------------------------------------------------------ *
 * The implemented shape, measured through the real code path.
 *
 * The variants above synthesise fields on top of `successPayload` in order to price
 * options that were not chosen. Now that B is implemented, the number that matters is
 * what a real reporter puts on the wire, driven through `noteSuccess` and `flush`
 * rather than assembled here. If this does not equal the priced B, what ships is not
 * what the user agreed to pay for, and the agreement was made against a number.
 * ------------------------------------------------------------------ */
const PRICED_B = 774
/* `createReporter` is already in module scope from the empty-window check above; a
   second binding for the same import is a SyntaxError, and a probe that does not parse
   produces no numbers at all — which is louder than a wrong number, and better. */
let realNow = 1_700_000_000_000
const realBodies = []
const real = createReporter({
  endpoint: 'https://collector.test/api/report',
  identity: { id: ID },
  send: async body => { realBodies.push(body); return { status: 200 } },
  now: () => realNow,
  limits: { SUCCESS_WINDOW_MS: 1000 },
})
/* Eight successes per model: seven ordinary and one slow, a mean around 6 s and a
   maximum of 31 s. That is the case a mean hides and the reason B was chosen. */
for (const model of MODELS) {
  for (const ms of [2500, 2500, 2500, 2500, 2500, 2500, 2500, 31204]) real.noteSuccess({ model, route: 'rustvy', ms })
}
await real.flush({ settle: true })
real.dispose()

const realDoc = realBodies[0]
const realSize = bytes(realDoc)
console.log('\n=== the implemented shape, through noteSuccess and flush ===')
console.log(`  one entry looks like: ${JSON.stringify(realDoc?.c?.[0])}`)
console.log(`  12 models: ${realSize} bytes   priced at ${PRICED_B}   ${realSize === PRICED_B ? 'MATCH — what ships is what was priced' : 'MISMATCH — what ships is not what the user agreed to'}`)
console.log(`  documents for twelve models in one window: ${realBodies.length} (one, as priced)`)
console.log(`  on the wire: ${(((realSize + HEADERS) * windowsPerDay) / 1024).toFixed(1)} KiB/day with headers`)

console.log('')
console.log('########## task-64: what the one-minute window actually costs ##########')
console.log('')
// Two corrections to the arithmetic that preceded this measurement.
//
// First, a one-minute window does not hold eight samples per model, it holds about one,
// and a one-digit `n` beside a four-digit sum is a shorter entry than a one-digit `n`
// beside a five-digit one. So the shipped document at a one-minute window is not the 774
// that was priced at fifteen minutes; pricing it at 774 overstates the cost.
//
// Second, "requests avoided" was computed against every window in the day, but a window
// only exists if a success landed in it. With 231 successes a day spread over 480 minutes
// most minutes are empty and send nothing, so the report count is the number of OCCUPIED
// windows, which is what the formula below computes rather than assumes.
const shippedAt = (models, n, sum, max) => bytes(successPayload({
  t: 1_761_763_200_000, to: 1_761_763_200_000 + SUCCESS_WINDOW_MS, route: 'rustvy',
  id: ID, c: MODELS.slice(0, models).map(m => [m, { n, s: sum, x: max }]),
}))
const control = shippedAt(12, 8, 20140, 31204)
console.log(`=== the shipped shape, priced at the sample counts each window really holds ===`)
console.log(`  control, 12 models x 8 samples:  ${control} bytes   (must be 774: ${control === 774 ? 'MATCH' : 'MISMATCH - the numbers below are not comparable'})`)
for (const [models, n, sum, max, label] of [
  [1, 1, 2500, 2500, 'one model, one sample - a quiet minute'],
  [3, 1, 2500, 2500, 'three models, one sample each'],
  [12, 1, 2500, 2500, 'twelve models, one sample each'],
  [3, 3, 7500, 3100, 'three models, three samples each - a busy minute'],
]) {
  const size = shippedAt(models, n, sum, max)
  console.log(`  ${label.padEnd(44)} ${String(size).padStart(4)} bytes   ${(size + HEADERS)} on the wire`)
}

console.log('')
console.log('=== occupied windows, not all windows ===')
const SUCCESSES = 231
const occupied = (windows, successes) => windows * (1 - Math.pow(1 - 1 / windows, successes))
const MINUTE_WINDOWS = (HOURS * 3_600_000) / 60_000
const QUARTER_WINDOWS = (HOURS * 3_600_000) / 900_000
for (const [label, windows] of [['15-minute window', QUARTER_WINDOWS], ['1-minute window', MINUTE_WINDOWS]]) {
  const active = occupied(windows, SUCCESSES)
  console.log(`  ${label.padEnd(17)} ${String(windows).padStart(4)} windows in ${HOURS} h, ${SUCCESSES} successes -> ${active.toFixed(0)} occupied`)
  console.log(`  ${''.padEnd(17)} reports ${active.toFixed(0)} instead of ${SUCCESSES}, so aggregation avoids ${(100 * (1 - active / SUCCESSES)).toFixed(0)}% of requests`)
}
console.log(`  the documented "86% of requests avoided" was measured at fifteen minutes;`)
console.log(`  at one minute the window is comparable to the gap between successes and the saving collapses`)

console.log('')
console.log('=== the day, at the shipped shape and the occupied-window count ===')
const minuteActive = occupied(MINUTE_WINDOWS, SUCCESSES)
for (const [models, n, sum, max, label] of [[1, 1, 2500, 2500, '1 model'], [3, 1, 2500, 2500, '3 models'], [12, 1, 2500, 2500, '12 models']]) {
  const size = shippedAt(models, n, sum, max)
  const body = size * minuteActive
  const wire = (size + HEADERS) * minuteActive
  console.log(`  ${label.padEnd(9)} ${String(size).padStart(4)} B/doc x ${minuteActive.toFixed(0)} occupied = body ${(body / 1024).toFixed(1)} KiB/day, with headers ${(wire / 1024).toFixed(1)} KiB/day`)
}
console.log(`  and the ceiling case lead priced, twelve models with eight samples each:`)
console.log(`    774 B x ${minuteActive.toFixed(0)} occupied = body ${(774 * minuteActive / 1024).toFixed(1)} KiB/day, with headers ${((774 + HEADERS) * minuteActive / 1024).toFixed(1)} KiB/day`)
console.log(`    774 B x ${MINUTE_WINDOWS} if every minute is busy = body ${(774 * MINUTE_WINDOWS / 1024).toFixed(1)} KiB/day, with headers ${((774 + HEADERS) * MINUTE_WINDOWS / 1024).toFixed(1)} KiB/day`)

console.log('')
console.log('=== the send ceilings, because the request rate rose fifteenfold ===')
const MAX_PER_MINUTE = 20
const MAX_PER_HOUR = 240
console.log(`  FOLD_LIMITS: MAX_PER_MINUTE ${MAX_PER_MINUTE}, MAX_PER_HOUR ${MAX_PER_HOUR}`)
console.log(`  one continuously active route produces 60 success windows an hour`)
for (const routes of [1, 2, 3, 4, 5]) {
  const perHour = 60 * routes
  const verdict = perHour > MAX_PER_HOUR ? `OVER the hourly ceiling by ${perHour - MAX_PER_HOUR} - windows are dropped` : `under it, ${MAX_PER_HOUR - perHour} left for error reports`
  console.log(`  ${routes} route(s): ${String(perHour).padStart(3)}/hour, ${routes}/minute -> ${verdict}`)
}
console.log(`  at fifteen minutes the same ceiling allowed ${Math.floor(MAX_PER_HOUR / 4)} continuously active routes`)
if (realSize !== PRICED_B) process.exit(1)
