// The stream idle timeout's boundaries, tested as a pure function with no context, no config
// editor and no route.
//
// The reason these matter more than an ordinary validation suite: writing an out-of-range
// value into a provider profile does not degrade gracefully. `dsh-timeout:30` and
// `dsh-llm-pi-ai:1129` both throw on a non-positive `streamIdleTimeoutMs`, and the profile
// schema at `dsh-llm-pi-ai:1077` caps it at `MAX_TIMER_DELAY_MS` = 2147483647. A rejected
// profile takes the whole route out of every picker, so the user's models stop answering and
// the cause is a settings field this plugin accepted. Refusing early is the only safe answer.
//
// Every refusal is asserted on its *reason* and not merely on `ok: false`, so a refusal for
// the wrong cause reddens rather than passing quietly.
import { streamTimeoutValueOf } from '../lib/host.js'

const MAX = 2147483647
const results = []
/**
 * Record one assertion.
 *
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside the label.
 */
function check(label, ok, detail) {
  const shown = detail === undefined ? '' : `  — ${String(detail).slice(0, 300)}`
  results.push({ label, ok: ok === true, detail: shown })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${shown}`)
}

// --- the accepted shapes -----------------------------------------------------
check('null is accepted and means reset', streamTimeoutValueOf(null).ok === true && streamTimeoutValueOf(null).value === null, JSON.stringify(streamTimeoutValueOf(null)))
check('undefined is accepted and means reset, so a body without the key cannot write zero',
  streamTimeoutValueOf(undefined).ok === true && streamTimeoutValueOf(undefined).value === null, JSON.stringify(streamTimeoutValueOf(undefined)))
check('1 is accepted, the smallest value the adapter will take', streamTimeoutValueOf(1).ok === true && streamTimeoutValueOf(1).value === 1, JSON.stringify(streamTimeoutValueOf(1)))
check(`${MAX} is accepted, the largest the adapter's schema allows`, streamTimeoutValueOf(MAX).ok === true && streamTimeoutValueOf(MAX).value === MAX, JSON.stringify(streamTimeoutValueOf(MAX)))
check('the recommended preset is accepted', streamTimeoutValueOf(3600000).ok === true && streamTimeoutValueOf(3600000).value === 3600000, JSON.stringify(streamTimeoutValueOf(3600000)))
check('and a value passes through unchanged rather than being rounded or clamped', streamTimeoutValueOf(172800000).value === 172800000, String(streamTimeoutValueOf(172800000).value))

// --- 0 is refused, and this is the refusal that protects the user -----------
// Not a style choice: the adapter throws on non-positive timeouts, so 0 in a profile breaks
// the route. It is also a *different* zero from `DEFAULT_CONFIG.streamIdleTimeout`, where 0
// is a sentinel meaning "leave the routes alone" and never reaches a route.
const zero = streamTimeoutValueOf(0)
check('0 is refused, because writing it would break the route outright', zero.ok === false, JSON.stringify(zero))
check('  and the refusal says the minimum is 1 or null', zero.ok === false && String(zero.error).includes('не меньше 1') && String(zero.error).includes('null'), String(zero.error))
check('  and it says what would have happened, so nobody weakens it later', String(zero.error).includes('схема адаптера'), String(zero.error))
check('-1 is refused for the same reason as 0', streamTimeoutValueOf(-1).ok === false && String(streamTimeoutValueOf(-1).error).includes('не меньше 1'), String(streamTimeoutValueOf(-1).error))
check('and a large negative is refused too', streamTimeoutValueOf(-3600000).ok === false, JSON.stringify(streamTimeoutValueOf(-3600000)))

// --- above the adapter's ceiling --------------------------------------------
const over = streamTimeoutValueOf(MAX + 1)
check(`${MAX + 1} is refused, one past the adapter's ceiling`, over.ok === false, JSON.stringify(over))
check('  and the refusal names the ceiling', over.ok === false && String(over.error).includes(String(MAX)), String(over.error))
check('a much larger value is refused too', streamTimeoutValueOf(9e15).ok === false, JSON.stringify(streamTimeoutValueOf(9e15)))

// --- non-integers, which the adapter would silently truncate -----------------
const fractional = streamTimeoutValueOf(3600000.5)
check('a fractional value is refused rather than truncated', fractional.ok === false, JSON.stringify(fractional))
check('  and the reason names the truncation it would have caused', fractional.ok === false && String(fractional.error).includes('округлил'), String(fractional.error))
check('a fractional value below 1 is refused as a non-integer, not as too small', streamTimeoutValueOf(0.5).ok === false && String(streamTimeoutValueOf(0.5).error).includes('целое'), String(streamTimeoutValueOf(0.5).error))

// --- non-numbers -------------------------------------------------------------
const numericString = streamTimeoutValueOf('3600000')
check('a numeric string is refused rather than coerced', numericString.ok === false, JSON.stringify(numericString))
check('  and it says a number or null is wanted', numericString.ok === false && String(numericString.error).includes('число миллисекунд'), String(numericString.error))
// Asserted on what the reason is NOT, because the type guard and the finite guard produce
// messages that share the substring «число миллисекунд» — the finite one adds «конечное». A
// check that only looked for the shared substring passed with the type guard deleted, which
// a removal probe caught: 26/26 either way, proving nothing. The word that distinguishes a
// wrong type from a non-finite number is the one worth asserting.
check('  and it is refused as a wrong type, not as a non-finite number',
  numericString.ok === false && !String(numericString.error).includes('конечное'), String(numericString.error))
check('NaN is refused', streamTimeoutValueOf(Number.NaN).ok === false && String(streamTimeoutValueOf(Number.NaN).error).includes('конечное'), JSON.stringify(streamTimeoutValueOf(Number.NaN)))
check('Infinity is refused', streamTimeoutValueOf(Number.POSITIVE_INFINITY).ok === false, JSON.stringify(streamTimeoutValueOf(Number.POSITIVE_INFINITY)))
check('-Infinity is refused', streamTimeoutValueOf(Number.NEGATIVE_INFINITY).ok === false, JSON.stringify(streamTimeoutValueOf(Number.NEGATIVE_INFINITY)))
check('a boolean is refused', streamTimeoutValueOf(true).ok === false, JSON.stringify(streamTimeoutValueOf(true)))
check('an object is refused', streamTimeoutValueOf({ value: 3600000 }).ok === false, JSON.stringify(streamTimeoutValueOf({ value: 3600000 })))
check('an empty string is refused', streamTimeoutValueOf('').ok === false, JSON.stringify(streamTimeoutValueOf('')))

// --- no accepted value is ever outside the writable range --------------------
const accepted = [null, undefined, 1, 2, 300000, 3600000, 172800000, MAX]
check('every accepted value is null or an integer inside [1, MAX]',
  accepted.every(input => {
    const result = streamTimeoutValueOf(input)
    return result.ok === true && (result.value === null || (Number.isInteger(result.value) && result.value >= 1 && result.value <= MAX))
  }),
  JSON.stringify(accepted.map(input => streamTimeoutValueOf(input).value)))

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
