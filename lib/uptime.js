/**
 * dsh-rustvy — the collector's uptime view, normalized.
 *
 * The collector we report to is also the collector we read back from: the same
 * server, its read side, answering `GET /api/view?range=24h|7d|30d` with a whole
 * status page in one JSON document. This module is the one place that knows what
 * that document is supposed to look like, and what to do when it does not.
 *
 * It exists because the document is rendered in a browser, straight into HTML. A
 * payload that arrives from a remote service — through whatever network, proxy and
 * version of the collector happens to be between us — is treated as hostile by
 * default. So nothing here trusts a type it has not checked, every number is
 * coerced into the range the renderer expects, every string is cut to a length the
 * renderer can lay out, and every array is capped: a collector that is buggy, or
 * merely generous, must not be able to hand the plugin megabytes and watch it paint
 * them.
 *
 * The second thing this module decides is what a *wrong* answer looks like. One
 * rule dominates the rest: an unrecognised status falls back to `up`, never to
 * `down`. If the collector adds a fourth state tomorrow, or answers with something
 * the plugin has never seen, a working model must not be painted red in front of a
 * user who is trying to decide whether to trust it. Red is reserved for what the
 * collector actually said was red.
 *
 * The third thing is what is *not* here. This module never fetches, never caches,
 * never retries and never throws into a caller: the host owns the network and the
 * cache, the client owns the rendering, and this file owns the shape. It is pure,
 * has no imports, and can be reasoned about from its output alone — which is also
 * why a test can drive it with a hand-written payload instead of a live server.
 *
 * One observed caveat shapes the defensive rules below: the collector's aggregation
 * currently sees none of the reports it accepts. Eleven reports were sent to it,
 * every one answered `200 {"ok":true,"id":…}`, and `GET /api/view` answered
 * `total: 0` with empty `byCode`, `events` and `lastError` on all three ranges,
 * re-read two minutes later to rule out indexing lag. So an all-green, empty
 * payload is the *normal* answer, not the degenerate one, and the three fields that
 * carry detail have never been observed populated — their shapes come from the
 * collector's own monitor page. Those three get the most care.
 *
 * @module dsh-rustvy/uptime
 */

/**
 * The ranges the collector accepts, and the only ones this plugin will ask for.
 *
 * Asking for anything else answers `400` with
 * `{"error":"range must be one of: 24h, 7d, 30d"}`, so the whitelist is the
 * collector's, not a preference.
 */
export const UPTIME_RANGES = Object.freeze(['24h', '7d', '30d'])

/** The range shown before the user picks one. */
export const DEFAULT_RANGE = '24h'

/** The three states the collector's own monitor page knows how to draw. */
const STATUSES = Object.freeze(['up', 'slow', 'down'])

/**
 * What `up` means when the collector says something else.
 *
 * Deliberately not `down`: an unknown status is a gap in *our* knowledge, and the
 * cost of guessing wrong is a working model shown as failed, which is exactly the
 * kind of lie a status page must not tell. Guessing `up` costs one green pill.
 */
const FALLBACK_STATUS = 'up'

/**
 * The caps, each a multiple of what the collector actually sends.
 *
 * Today that is a dozen models, 48 buckets each, and — because its aggregation
 * currently ignores every report it accepts — no events at all. The headroom is
 * therefore generous for a real answer and still bounds a hostile one: what matters
 * is the *product*, since a runaway collector multiplies models by buckets by events
 * by message length. At these values the worst payload this module can return is
 * under two megabytes, which a browser survives, instead of the gigabytes an
 * uncapped pass-through would allow.
 */
const MAX_MODELS = 50
/** Buckets per model. The collector sends exactly 48 for every range; this is 4× that. */
const MAX_BUCKETS = 200
/** Events per model. Never observed populated, so this is a ceiling on the unknown. */
const MAX_EVENTS = 25
/** How many `byCode` entries one payload may contribute. */
const MAX_BY_CODE = 100
/** How long an event or last-error message may be. */
const EVENT_MESSAGE_MAX = 500
/** How long any other string field may be. */
const FIELD_MAX = 128

/**
 * A non-negative integer, or a default.
 *
 * Every number in the payload ends up here, because the renderer does arithmetic on
 * all of them: a percentage that is `NaN` prints as `NaN%`, a bucket count that is
 * negative scales a bar backwards, and a `from` that is a string sorts wrong.
 *
 * @param value - the candidate.
 * @param fallback - what to return when it is not a usable number.
 * @returns a finite integer, at least zero.
 */
function toCount(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.trunc(number))
}

/**
 * A number that may legitimately be any timestamp, including one before 1970 in a
 * malformed payload — but not `NaN` or `Infinity`.
 *
 * @param value - the candidate.
 * @returns the finite number, or `null` when there is none.
 */
function toTimestamp(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return null
  return Math.trunc(number)
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
 * A percentage, clamped to the only range that means anything.
 *
 * The collector sends `uptime: 100` for a model with no errors, and there is no
 * reading of `140` or `-3` that a bar can draw. Clamping here means the renderer
 * does not have to.
 *
 * @param model - one entry of the payload's `models`, or anything at all.
 * @returns an integer from 0 to 100.
 */
export function uptimeOf(model) {
  // Every public entry point here is guarded, for the same reason in each case: the
  // promise is that nothing throws into a caller, unconditionally. A payload parsed
  // from JSON cannot break it — it has no getters and no proxies — but the host may
  // hand this module something else, and a caller should never have to reason about
  // which inputs are safe.
  try {
    const source = typeof model === 'object' && model !== null ? model : {}
    return Math.min(100, toCount(source.uptime, 0))
  } catch {
    return 0
  }
}

/**
 * The status of one model, as one of the three the monitor page knows how to draw.
 *
 * Anything the collector sends that is not `up`, `slow` or `down` — a new state, a
 * typo, a null, a number — comes back as `up`. See {@link FALLBACK_STATUS} for why
 * the fallback is green rather than red.
 *
 * @param model - one entry of the payload's `models`, or anything at all.
 * @returns `'up'`, `'slow'` or `'down'`.
 */
export function statusOf(model) {
  try {
    const source = typeof model === 'object' && model !== null ? model : {}
    const status = typeof source.status === 'string' ? source.status.trim().toLowerCase() : ''
    return STATUSES.includes(status) ? status : FALLBACK_STATUS
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
 * @returns true for `'24h'`, `'7d'` or `'30d'`.
 */
export function isUptimeRange(value) {
  return typeof value === 'string' && UPTIME_RANGES.includes(value)
}

/**
 * The numbers a bucket strip is scaled by.
 *
 * The collector sends exactly 48 buckets for every range, which means a bucket's
 * width changes meaning with the range: 30 minutes at `24h`, 3.5 hours at `7d`,
 * 15 hours at `30d`. Nothing here pads or resamples — the client draws what
 * arrived, and these five numbers are all it needs to do that without walking the
 * array itself.
 *
 * `max` is at least 1 by construction, so a strip of all-zero buckets scales to zero
 * height instead of dividing by zero. `first` and `last` are `null` when there are
 * no buckets, which is how a caller tells "an empty timeline" from "a timeline that
 * starts at the epoch".
 *
 * @param buckets - the array from one model, normalized or not.
 * @returns `{ count, max, first, last, errors }`, where `count` is how many buckets
 *   there are, `max` is the largest single bucket (at least 1), `first` and `last`
 *   are the outer `from` timestamps, and `errors` is their sum.
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
 * a quiet half-hour.
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
 * Events have never been observed populated — the collector's aggregation currently
 * ignores every report it accepts — so this shape comes from the monitor page's own
 * JavaScript, and it gets the strictest reading here. An entry without a numeric
 * timestamp cannot be placed or sorted and is dropped. `status` is kept only when
 * it is a real HTTP status, because `0` would render as a status and mean nothing.
 *
 * @param event - the candidate.
 * @returns `{ t, code?, status?, message?, plugin? }` or `null`.
 */
function toEvent(event) {
  const source = typeof event === 'object' && event !== null ? event : {}
  const at = toTimestamp(source.t)
  if (at === null) return null
  const code = toText(source.code)
  const message = toText(source.message, EVENT_MESSAGE_MAX)
  const plugin = toText(source.plugin)
  const status = toCount(source.status, 0)
  return {
    t: at,
    ...(code === '' ? {} : { code }),
    ...(status >= 100 && status <= 599 ? { status } : {}),
    ...(message === '' ? {} : { message }),
    ...(plugin === '' ? {} : { plugin }),
  }
}

/**
 * The model's last error, or `null`.
 *
 * The monitor page renders it as «последняя ошибка <время> — <код> <сообщение», so
 * it needs a time and at least one of the two things it would print. Anything less
 * is `null`, which the page draws as "no known error" rather than as a broken line.
 *
 * @param lastError - the candidate.
 * @returns `{ t, code?, message? }` or `null`.
 */
function toLastError(lastError) {
  const source = typeof lastError === 'object' && lastError !== null ? lastError : {}
  const at = toTimestamp(source.t)
  if (at === null) return null
  const code = toText(source.code)
  const message = toText(source.message, EVENT_MESSAGE_MAX)
  if (code === '' && message === '') return null
  return {
    t: at,
    ...(code === '' ? {} : { code }),
    ...(message === '' ? {} : { message }),
  }
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
 * @returns the normalized model, or `null`.
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
    uptime: uptimeOf(source),
    status: statusOf(source),
    buckets: keptBuckets,
    events: keptEvents,
    lastError: toLastError(source.lastError),
  }
}

/**
 * The collector's summary line, with every number guaranteed.
 *
 * Their page's footer reads «период: <range> · ошибок: <total> · хранилище:
 * <storage>» and the head of the panel reads the six counts, so all of them have to
 * be integers a template can print without a conditional.
 *
 * @param summary - the candidate.
 * @returns `{ totalModels, operational, slow, down, uptime, totalErrors }`.
 */
function toSummary(summary) {
  const source = typeof summary === 'object' && summary !== null ? summary : {}
  return {
    totalModels: toCount(source.totalModels, 0),
    operational: toCount(source.operational, 0),
    slow: toCount(source.slow, 0),
    down: toCount(source.down, 0),
    uptime: Math.min(100, toCount(source.uptime, 0)),
    totalErrors: toCount(source.totalErrors, 0),
  }
}

/**
 * Turn whatever the collector answered into something safe to render.
 *
 * The answer is one of two shapes, and a caller only ever has to look at `ok`:
 *
 * `{ ok: true, range, generatedAt, healthy, storage, total, summary, byCode, models }`
 * for a payload that described a view, and `{ ok: false, error }` with a Russian
 * sentence for one that did not. `error` is written for a user, since the host relays
 * it and the settings page prints it.
 *
 * Two rules are worth stating because they are choices rather than consequences.
 * `byCode` is passed through untouched when it is an array and replaced by `[]`
 * otherwise: their own page never reads it, so interpreting it here would be
 * inventing a contract nobody asked for. And a model is dropped only when it has no
 * `id` — every other defect is repaired, because a model with a broken uptime
 * percentage is still worth showing as a row, while a row nobody can identify is
 * not worth showing at all.
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
      generatedAt: toCount(raw.generatedAt, 0),
      // A payload that arrived and described its models is a healthy answer even if
      // the collector forgot to say so; only an explicit `false` means unhealthy.
      healthy: typeof raw.healthy === 'boolean' ? raw.healthy : true,
      storage: toText(raw.storage),
      total: toCount(raw.total, 0),
      summary: toSummary(raw.summary),
      // Passed through without interpretation — their own monitor page never reads
      // it, so inventing a shape for it here would be inventing a contract. Copied
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
