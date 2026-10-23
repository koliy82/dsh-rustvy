/**
 * dsh-rustvy — the collector's uptime view, normalized.
 *
 * The collector we report to is also the collector we read back from: the same
 * server, its read side, answering `GET /api/view?range=1h|24h|7d|30d` with a whole
 * status page in one JSON document. This module is the one place that knows what
 * that document is supposed to look like, and what to do when it does not.
 *
 * It exists because the document is rendered in a browser, straight into HTML. A
 * payload that arrives from a remote service — through whatever network, proxy and
 * version of the collector happens to be between us — is treated as hostile by
 * default. So nothing here trusts a type it has not checked, every number is coerced
 * into a range the renderer expects, every string is cut to a length the renderer can
 * lay out, and every array is capped: a collector that is buggy, or merely generous,
 * must not be able to hand the plugin megabytes and watch it paint them.
 *
 * The second thing this module decides is what a *wrong* answer looks like. One rule
 * dominates the rest: an unrecognised status falls back to the quiet state, never to
 * an outage. If the collector adds a fifth state tomorrow, or answers with something
 * this module has never seen, a working model must not be painted red in front of a
 * user who is trying to decide whether to trust it. Red is reserved for what the
 * collector actually said was red.
 *
 * The third thing is what is *not* here. This module never fetches, never caches,
 * never retries and never throws into a caller: the host owns the network and the
 * cache, the client owns the rendering, and this file owns the shape. It is pure,
 * has no imports, and can be reasoned about from its output alone — which is also
 * why a test can drive it with a hand-written payload instead of a live server.
 *
 * Two contracts live here at once, and that is deliberate rather than transitional
 * sloppiness. Contract v2 replaces the availability *percentage* with a *state*
 * derived from breadth and recency — `ok`, `single`, `issues`, `down` — because we
 * collect only errors and therefore have no denominator for a percentage: the old
 * `100 * (48 - downSlots) / 48` measured bucket occupancy, which changed with the
 * range, saturated at one error per bucket, and could not tell one person's broken
 * network from a provider-wide outage. v2 admits a percentage only where a real
 * denominator exists — distinct installs affected over distinct installs seen in a
 * 30-day reference window — and calls it `affectedPct`, never uptime. The deployed
 * v1 server still answers `up | slow | down` with a percentage, so this module reads
 * both vocabularies and maps the older onto the newer.
 *
 * One rule follows from that pairing and applies to every new field: **a number the
 * collector did not compute comes out as `null`, never as `0`.** `0%` and «делить не
 * на что» are different statements, and so are «0 установок» and «сервер этого не
 * считает»; a renderer can draw «—» for the second and cannot recover it from the
 * first. That is why `affectedPct`, `installs`, `firstAt`, `lastAt` and
 * `minutesSinceLast` are nullable here even where the contract types them as
 * integers — a v2 collector always sends them, so nothing is lost, and a v1 collector
 * sends none of them, so nothing is invented.
 *
 * @module dsh-rustvy/uptime
 */

/**
 * The ranges the collector accepts, and the only ones this plugin will ask for.
 *
 * Asking for anything else answers `400` with
 * `{"error":"range must be one of: 1h, 24h, 7d, 30d"}`, so the whitelist is the
 * collector's, not a preference.
 */
export const UPTIME_RANGES = Object.freeze(['1h', '24h', '7d', '30d'])

/**
 * The range shown before the user picks one.
 *
 * The panel defaults to a day because a day is the shortest window in which a
 * provider-wide outage and one person's bad afternoon are distinguishable. The
 * badges in the model picker use an hour instead, and ask for it separately.
 */
export const DEFAULT_RANGE = '24h'

/** The states this module emits: contract v2's vocabulary, and only that one. */
const STATUSES = Object.freeze(['ok', 'single', 'issues', 'down'])

/**
 * The deployed v1 vocabulary, mapped onto v2.
 *
 * `up` is quiet, `slow` was "something happened", and v2 splits that into `single`
 * (one install — probably local) and `issues` (several — probably the provider). A
 * v1 server cannot make that distinction, so everything it called `slow` becomes
 * `issues`: when in doubt, treat an unexplained fault as the broader one, because
 * the narrower claim is the one that needs evidence. `down` means the same thing in
 * both vocabularies and is listed for completeness.
 *
 * A `Map` rather than an object literal, so that a status named `constructor` or
 * `toString` cannot find an inherited entry and be treated as a known state.
 */
const LEGACY_STATUSES = new Map([['up', 'ok'], ['slow', 'issues'], ['down', 'down']])

/**
 * The state an unrecognised status becomes.
 *
 * Deliberately the quiet one, and the reasoning survives the change of vocabulary.
 * An unknown status is a gap in *this module's* knowledge, not a statement about the
 * model, and a collector newer than this file is entitled to have states we have
 * never seen. Guessing an outage costs a red pill on a model that may be perfectly
 * healthy, which is the one lie a status page must not tell; guessing quiet costs
 * one green pill. We would rather under-warn than invent an outage.
 *
 * The one exception is in {@link statusOf}: when the same model reports errors, the
 * fallback becomes `single` rather than `ok`, because a green state beside a
 * non-zero error count is a contradiction the renderer would print verbatim.
 */
const FALLBACK_STATUS = 'ok'

/**
 * The caps, each a multiple of what a collector can legitimately send.
 *
 * What matters is the *product*, since a runaway collector multiplies models by
 * buckets by events by message length. At these values the worst payload this module
 * can return is a couple of megabytes, which a browser survives, instead of the
 * gigabytes an uncapped pass-through would allow.
 */
const MAX_MODELS = 50
/** Buckets per model. `1h` arrives with 60 and every other range with 48; this is 3× the larger. */
const MAX_BUCKETS = 200
/** Events per model. The collector caps its own at 500; we render a strip and one line. */
const MAX_EVENTS = 25
/** How many `byCode` entries one payload may contribute. */
const MAX_BY_CODE = 100
/** How long an event or last-error message may be. */
const EVENT_MESSAGE_MAX = 500
/** How long any other string field may be. */
const FIELD_MAX = 128
/**
 * The ceiling on any count — errors, installs, summary counters.
 *
 * A count is now something a hostile collector can claim rather than something it
 * merely reports: v2 added `installs`, and «от 1000000000 установок» is a sentence a
 * renderer would happily print. A million is beyond any plausible install base or
 * error volume and still far short of the numbers that make arithmetic absurd.
 */
const MAX_COUNT = 1_000_000
/**
 * The ceiling on `minutesSinceLast`.
 *
 * Bounded so an absurd claim cannot render absurdly. A year is generous against the
 * longest window the contract defines (30 days) and leaves room for a longer one.
 */
const MAX_MINUTES = 525_600

/**
 * A non-negative integer, or a default.
 *
 * Every number in the payload ends up here, because the renderer does arithmetic on
 * all of them: a percentage that is `NaN` prints as `NaN%`, a bucket count that is
 * negative scales a bar backwards, and a `from` that is a string sorts wrong.
 *
 * @param value - the candidate.
 * @param fallback - what to return when it is not a usable number.
 * @param cap - the largest acceptable result.
 * @returns a finite integer, at least zero and at most `cap`.
 */
function toCount(value, fallback = 0, cap = MAX_COUNT) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(cap, Math.max(0, Math.trunc(number)))
}

/**
 * A count that may legitimately be *unknown*, as distinct from zero.
 *
 * The distinction is the whole point, so the type check is strict: only a real
 * number counts. `Number(null)` is `0` and `Number(true)` is `1`, and either would
 * turn "the collector did not compute this" into a claim about the world.
 *
 * @param value - the candidate.
 * @param cap - the largest acceptable result.
 * @returns a non-negative integer, or `null` when there was nothing to report.
 */
function toNullableCount(value, cap = MAX_COUNT) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(cap, Math.max(0, Math.trunc(value)))
}

/**
 * A percentage that may legitimately be undefined, kept to the collector's own
 * precision of one decimal.
 *
 * `null` means "there was no denominator", which the renderer draws as «—». Zero
 * means "nobody was affected", which it draws as 0%. Coercing one into the other
 * would make the panel state something the collector never said.
 *
 * @param value - the candidate.
 * @returns a number from 0 to 100 with at most one decimal, or `null`.
 */
function toNullablePercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

/**
 * A timestamp, strictly.
 *
 * Only a finite number is a timestamp. A missing one yields `null`, which callers
 * read as "drop this entry" for buckets and events and as "not reported" for a
 * model's first and last error — in neither case is `0` an acceptable substitute,
 * since the epoch is a moment and would be drawn as one.
 *
 * @param value - the candidate.
 * @returns the integer timestamp, or `null`.
 */
function toTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/**
 * One string field, cut to a length the renderer can lay out.
 *
 * @param value - the candidate.
 * @param max - the longest acceptable result.
 * @param fallback - what to return when it is not a string.
 * @returns the trimmed string, or `fallback`.
 */
function toText(value, max = FIELD_MAX, fallback = '') {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * A deprecated availability percentage, clamped to the only range that means
 * anything.
 *
 * Contract v2 keeps this field so a client written against v1 still reads, but it is
 * bucket occupancy rather than availability and the panel no longer presents it as a
 * headline. It is carried at the collector's own precision — one decimal — because
 * truncating 97.9 to 97 would make the legacy server's number wrong in a way nobody
 * could trace back to this file.
 *
 * @param model - one entry of the payload's `models`, or anything at all.
 * @returns a number from 0 to 100 with at most one decimal.
 */
export function uptimeOf(model) {
  // Every public entry point here is guarded, for the same reason in each case: the
  // promise is that nothing throws into a caller, unconditionally. A payload parsed
  // from JSON cannot break it — it has no getters and no proxies — but the host may
  // hand this module something else, and a caller should never have to reason about
  // which inputs are safe.
  try {
    const source = typeof model === 'object' && model !== null ? model : {}
    const value = typeof source.uptime === 'number' && Number.isFinite(source.uptime) ? source.uptime : 0
    return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
  } catch {
    return 0
  }
}

/**
 * The status of one model, in contract v2's vocabulary.
 *
 * Accepts the union of both vocabularies and always answers in the newer one:
 * `ok`, `single`, `issues` and `down` pass through, the deployed server's `up` and
 * `slow` map onto `ok` and `issues`, and anything else falls back. See
 * {@link FALLBACK_STATUS} for why the fallback is quiet rather than red.
 *
 * What can actually reach the fallback is worth spelling out, because "unknown maps
 * to the quiet state" reads like a bug to anyone who has not read this far. The
 * collector's contract pins its output to exactly four states — `single` is the final
 * `else` of its rule, so it has no fifth branch and cannot emit one — which means an
 * unrecognised status can only come from one of four places: the deployed v1 server,
 * whose three states are mapped above and never fall through; a corrupted or hostile
 * payload; a collector *newer* than this module, which is entitled to have added a
 * state we have never seen; or a bug in the collector. Only the third is a normal
 * event, and for it the choice is between under-warning and inventing an outage.
 *
 * The fallback has one refinement, and it is the only place this module reasons
 * about a field other than `status`: when the same model reports errors, an
 * unrecognised status becomes `single` rather than `ok`. Under-warning is still the
 * choice — `single` is the mildest non-quiet state, amber rather than red — but a
 * green state printed beside «ошибок 3» is not under-warning, it is contradicting
 * the number next to it, and the renderer prints both.
 *
 * @param model - one entry of the payload's `models`, or anything at all.
 * @returns `'ok'`, `'single'`, `'issues'` or `'down'`.
 */
export function statusOf(model) {
  try {
    const source = typeof model === 'object' && model !== null ? model : {}
    const raw = typeof source.status === 'string' ? source.status.trim().toLowerCase() : ''
    if (STATUSES.includes(raw)) return raw
    const legacy = LEGACY_STATUSES.get(raw)
    if (legacy !== undefined) return legacy
    return toCount(source.errors, 0) > 0 ? 'single' : FALLBACK_STATUS
  } catch {
    return FALLBACK_STATUS
  }
}

/**
 * Whether a value is a range the collector will answer.
 *
 * The host checks this before fetching, so a bad range is refused locally instead of
 * spending a request to be told `400`.
 *
 * @param value - the candidate.
 * @returns true for `'1h'`, `'24h'`, `'7d'` or `'30d'`.
 */
export function isUptimeRange(value) {
  return typeof value === 'string' && UPTIME_RANGES.includes(value)
}

/**
 * The numbers a bucket strip is scaled by.
 *
 * The bucket count depends on the range — 60 for `1h`, 48 for the rest — and a
 * bucket's width depends on it too, from one minute to fifteen hours. Nothing here
 * pads, truncates to a canonical length or resamples: the client draws what arrived
 * and labels the strip with the width, and these five numbers are all it needs to do
 * that without walking the array itself.
 *
 * `max` is at least 1 by construction, so a strip of all-zero buckets scales to zero
 * height instead of dividing by zero. `first` and `last` are `null` when there are no
 * buckets, which is how a caller tells "an empty timeline" from "a timeline that
 * starts at the epoch".
 *
 * `first` is the OLDEST timestamp in the array and `last` the NEWEST, and they are
 * found by comparison rather than taken from the two ends. That distinction is the
 * reason a caller can wire them into anything time-sensitive: the contract pins
 * `buckets` as ascending by `from`, so the oldest value is also the first element —
 * but the agreement is a consequence of the contract, not of this function. Were a
 * producer to emit newest-first, an index-based reader would silently invert the
 * meaning of a field called `first` and nothing would throw, because taking the outer
 * values of an array is correct whatever its order. Finding the extremes by
 * comparison makes that failure unreachable, which is the property worth preserving
 * if this function is ever rewritten. The loud consumer — a strip drawn in array
 * order — is deliberately left dependent on the contract's promise, so that a
 * reversing producer fails visibly instead of being quietly re-sorted here.
 *
 * It is worth being precise about what that buys, because the intuition runs the
 * other way. A *reversed* array is the loud failure, not the quiet one: its `from`
 * descends in uniform negative steps, so any direction check catches it, and
 * comparison merely makes this function immune to something that was already
 * detectable. The quiet failure is a correctly ordered array whose *counts* are
 * mirrored — `from` ascending, steps uniform, both edges exact, every count in the
 * wrong bar. Nothing here can catch that, and neither can anything else on the
 * consumer's side: mirroring preserves the sum, so even comparing `errors` against
 * the bucket total stays silent. Only a semantic test at the producer detects it,
 * which is why the collector asserts that an error from now lands in the last bucket
 * rather than merely that the array is sorted.
 *
 * @param buckets - the array from one model, normalized or not.
 * @returns `{ count, max, first, last, errors }`, where `count` is how many buckets
 *   there are, `max` is the largest single bucket (at least 1), `first` is the oldest
 *   `from` and `last` the newest, and `errors` is the sum of the counts.
 */
export function bucketStats(buckets) {
  try {
    const list = Array.isArray(buckets) ? buckets : []
    let max = 0
    let errors = 0
    let first = null
    let last = null
    for (const bucket of list) {
      const source = typeof bucket === 'object' && bucket !== null ? bucket : {}
      const from = toTimestamp(source.from)
      const count = toCount(source.count, 0)
      if (count > max) max = count
      errors += count
      if (from !== null) {
        if (first === null || from < first) first = from
        if (last === null || from > last) last = from
      }
    }
    return { count: list.length, max: Math.max(1, max), first, last, errors }
  } catch {
    return { count: 0, max: 1, first: null, last: null, errors: 0 }
  }
}

/**
 * One bucket, or `null` when it is not one.
 *
 * A bucket without a numeric `from` is dropped rather than repaired: it has no
 * position on the timeline, and a strip that invents one would be drawing a lie.
 * A missing `count` is a zero bucket, which is a real thing the collector sends for
 * a quiet minute.
 *
 * @param bucket - the candidate.
 * @returns `{ from, count }` or `null`.
 */
function toBucket(bucket) {
  const source = typeof bucket === 'object' && bucket !== null ? bucket : {}
  const from = toTimestamp(source.from)
  if (from === null) return null
  return { from, count: toCount(source.count, 0) }
}

/**
 * One event, or `null` when it is not one.
 *
 * An entry without a numeric timestamp cannot be placed or sorted and is dropped.
 * `status` is kept only when it is a real HTTP status, because the collector stores
 * `null` for "there was no response" and a zero would render as a status meaning
 * nothing. `id` is the reporting install's anonymous UUID, which contract v2 added
 * to events on purpose: «от скольких людей» is the question the whole `installs`
 * field exists to answer, and hiding it inside the event list would waste it.
 *
 * @param event - the candidate.
 * @returns `{ t, code?, status?, message?, plugin?, id? }` or `null`.
 */
function toEvent(event) {
  const source = typeof event === 'object' && event !== null ? event : {}
  const at = toTimestamp(source.t)
  if (at === null) return null
  const code = toText(source.code)
  const message = toText(source.message, EVENT_MESSAGE_MAX)
  const plugin = toText(source.plugin)
  const id = toText(source.id)
  const status = toCount(source.status, 0, 599)
  return {
    t: at,
    ...(code === '' ? {} : { code }),
    ...(status >= 100 && status <= 599 ? { status } : {}),
    ...(message === '' ? {} : { message }),
    ...(plugin === '' ? {} : { plugin }),
    ...(id === '' ? {} : { id }),
  }
}

/**
 * The model's last error, or `null`.
 *
 * The same shape as an event, because that is what it is — contract v2 defines
 * `lastError` with the event's fields, and keeping one rule for both removes an
 * asymmetry that only ever existed because an earlier version of this file inferred
 * the shape from a dashboard's rendering code. It needs a time and at least one of
 * the two things a last-error line would print; anything less is `null`, which the
 * renderer draws as "no known error" rather than as a broken line.
 *
 * @param lastError - the candidate.
 * @returns `{ t, code?, status?, message?, plugin?, id? }` or `null`.
 */
function toLastError(lastError) {
  const source = typeof lastError === 'object' && lastError !== null ? lastError : {}
  const at = toTimestamp(source.t)
  if (at === null) return null
  const code = toText(source.code)
  const message = toText(source.message, EVENT_MESSAGE_MAX)
  if (code === '' && message === '') return null
  return toEvent({ ...source, t: at })
}

/**
 * One model, or `null` when it cannot be shown.
 *
 * `id` is required and everything else has a fallback, because `id` is what the
 * model picker matches against: a model with no id cannot be tied to a catalog
 * entry, and drawing an unnamed row would only confuse the picker beside it. `name`
 * falls back to `id`, so a catalog without display names still renders something
 * readable.
 *
 * @param model - the candidate.
 * @returns the normalized model, in the contract's field order, or `null`.
 */
function toModel(model) {
  const source = typeof model === 'object' && model !== null ? model : {}
  const id = toText(source.id)
  if (id === '') return null
  const buckets = Array.isArray(source.buckets) ? source.buckets : []
  const events = Array.isArray(source.events) ? source.events : []
  const keptBuckets = []
  for (const bucket of buckets) {
    if (keptBuckets.length >= MAX_BUCKETS) break
    const shaped = toBucket(bucket)
    if (shaped !== null) keptBuckets.push(shaped)
  }
  const keptEvents = []
  for (const event of events) {
    if (keptEvents.length >= MAX_EVENTS) break
    const shaped = toEvent(event)
    if (shaped !== null) keptEvents.push(shaped)
  }
  return {
    id,
    name: toText(source.name, FIELD_MAX, id),
    errors: toCount(source.errors, 0),
    installs: toNullableCount(source.installs),
    // A count rather than a nullable, deliberately, and the one new field that
    // breaks the "not computed ⇒ null" rule. `anonymous` exists to make an
    // understatement visible: reports with no usable `meta.id` all collapse onto a
    // single sentinel install, so ten plugins reporting one outage read as
    // `installs: 1` and `status: single` — "probably local". Zero is the honest
    // answer both when the collector counted none and when it did not count at all,
    // and a reader who needs to tell those apart looks at whether `installs` is
    // `null`. Rendering «0 анонимных» next to a null install count is a line the
    // client does not draw.
    anonymous: toCount(source.anonymous, 0),
    status: statusOf(source),
    firstAt: toTimestamp(source.firstAt),
    lastAt: toTimestamp(source.lastAt),
    minutesSinceLast: toNullableCount(source.minutesSinceLast, MAX_MINUTES),
    affectedPct: toNullablePercent(source.affectedPct),
    uptime: uptimeOf(source),
    buckets: keptBuckets,
    events: keptEvents,
    lastError: toLastError(source.lastError),
  }
}

/**
 * The collector's summary line.
 *
 * The counts a v1 server produces are integers a template can print without a
 * conditional. The ones only v2 produces are nullable, for the reason given in the
 * module banner: `single` cannot be derived from a v1 answer at all, since v1 had no
 * way to distinguish one install's bad afternoon from a provider-wide fault, and
 * printing `0` there would claim a distinction nobody made.
 *
 * `issues` is derived when only the legacy `slow` arrived, and `slow` is emitted as a
 * mirror of `issues` so that whichever of the two a client reads, the two agree.
 *
 * @param summary - the candidate.
 * @returns `{ totalModels, operational, single, issues, down, slow, uptime,
 *   totalErrors, installsAffected, affectedPct }`.
 */
function toSummary(summary) {
  const source = typeof summary === 'object' && summary !== null ? summary : {}
  const issues = toNullableCount(source.issues) ?? toCount(source.slow, 0)
  return {
    totalModels: toCount(source.totalModels, 0),
    operational: toCount(source.operational, 0),
    single: toNullableCount(source.single),
    issues,
    down: toCount(source.down, 0),
    slow: issues,
    uptime: uptimeOf(source),
    totalErrors: toCount(source.totalErrors, 0),
    installsAffected: toNullableCount(source.installsAffected),
    affectedPct: toNullablePercent(source.affectedPct),
  }
}

/**
 * The install counts for the whole window, with the reference denominator beside
 * them.
 *
 * `window` is how many distinct installs reported errors in this range; `reference`
 * is how many distinct installs reported anything over the collector's 30-day
 * reference period, and it is the only honest denominator available to a system that
 * collects errors alone. Both are nullable: a v1 server computes neither, and
 * `{ window: 0, reference: 0 }` would read as "we counted and found nobody" rather
 * than "we did not count".
 *
 * `anonymous` counts the reports in the window that carried no usable install id.
 * It is the field that keeps the sentinel honest — see {@link toModel}.
 *
 * @param installs - the candidate object.
 * @returns `{ window, reference, anonymous }`; the first two may be `null`.
 */
function toInstalls(installs) {
  const source = typeof installs === 'object' && installs !== null ? installs : {}
  return {
    window: toNullableCount(source.window),
    reference: toNullableCount(source.reference),
    anonymous: toCount(source.anonymous, 0),
  }
}

/**
 * Turn whatever the collector answered into something safe to render.
 *
 * The answer is one of two shapes, and a caller only ever has to look at `ok`:
 *
 * `{ ok: true, range, generatedAt, healthy, storage, total, installs, summary, byCode, models }`
 * for a payload that described a view, and `{ ok: false, error }` with a Russian
 * sentence for one that did not. `error` is written for a user, since the host relays
 * it and the settings page prints it.
 *
 * Three rules are worth stating because they are choices rather than consequences.
 * `byCode` is passed through untouched when it is an array and replaced by `[]`
 * otherwise: the plugin renders no breakdown by code, so interpreting it here would
 * be inventing a contract nobody asked for. A model is dropped only when it has no
 * `id` — every other defect is repaired, because a model with a broken percentage is
 * still worth showing as a row, while a row nobody can identify is not worth showing
 * at all. And `healthy` is passed through rather than interpreted, because it does
 * not mean what its name says: see the comment at its assignment.
 *
 * @param raw - the parsed body of `GET /api/view`, of any shape at all.
 * @returns the normalized view, or `{ ok: false, error }`.
 */
export function normalizeUptimeView(raw) {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'приёмник вернул не объект' }
    }
    if (!Array.isArray(raw.models)) {
      return { ok: false, error: 'в ответе приёмника нет списка моделей' }
    }
    const models = []
    for (const model of raw.models) {
      if (models.length >= MAX_MODELS) break
      const shaped = toModel(model)
      if (shaped !== null) models.push(shaped)
    }
    return {
      ok: true,
      range: isUptimeRange(raw.range) ? raw.range : DEFAULT_RANGE,
      generatedAt: toCount(raw.generatedAt, 0, Number.MAX_SAFE_INTEGER),
      // Not storage health, whatever the name suggests. The collector computes this
      // as "no rows in range", so `true` means quiet and `false` means there were
      // errors — `false` is the case where the collector worked and has something to
      // show, and rendering it as a collector failure would be exactly backwards.
      // Storage health is the `storage` field below and `/api/health`.
      //
      // Passed through rather than interpreted, and defaulted to `true` when absent
      // only because nothing renders the field today. That default is not a claim
      // that a payload without it was quiet; it is the one value that cannot become
      // a red banner. The semantics are owned by docs/uptime-view.md, not restated
      // here, so there is one place to correct if the collector changes its mind.
      healthy: typeof raw.healthy === 'boolean' ? raw.healthy : true,
      storage: toText(raw.storage),
      total: toCount(raw.total, 0),
      installs: toInstalls(raw.installs),
      summary: toSummary(raw.summary),
      // Passed through without interpretation — the plugin renders no breakdown by
      // code, so inventing a shape for it here would be inventing a contract. Copied
      // rather than aliased, and capped like every other array, so the returned view
      // is a snapshot the caller can hand to a renderer without the collector's array
      // sitting behind it.
      byCode: Array.isArray(raw.byCode) ? raw.byCode.slice(0, MAX_BY_CODE) : [],
      models,
    }
  } catch {
    // Unreachable from a JSON.parse'd body, and the reason the promise does not
    // depend on that: a payload with a throwing getter is refused, not propagated.
    return { ok: false, error: 'ответ приёмника не удалось разобрать' }
  }
}
