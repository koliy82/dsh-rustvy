// The proxy address parser: two modes, no scheme in the string, a loud refusal on anything
// else, and no password in any output.
//
// The contract changed under this file, so the checks were re-pointed rather than patched.
// The hazard that re-pointing has to guard against is not a check that goes red — it is a
// **fixture that inverts meaning and still passes**. `parseProxySpec('host:1080')` used to be
// the "no scheme, therefore refused" case; under this contract a scheme-less `host:port` is
// exactly the valid form, so a check titled "unparsable" would have been asserting its title
// against an input that parses. When a contract changes every fixture has to be re-read
// against it, not only the ones that fail.
import { parseProxySpec, parseProxyMode, maskProxySpec, PROXY_MODES, PROXY_SCHEMES } from '../lib/proxy.js'

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

// --- the mode selector, which is where the family is chosen ------------------
check('there are exactly two modes', JSON.stringify(PROXY_MODES) === '["http","socks"]', JSON.stringify(PROXY_MODES))
check('http is the default for a missing mode', parseProxyMode(undefined) === 'http', String(parseProxyMode(undefined)))
check('and for a mode this build does not know', parseProxyMode('socks5') === 'http' && parseProxyMode('https') === 'http', `${parseProxyMode('socks5')} / ${parseProxyMode('https')}`)
check('the mode is case- and space-insensitive', parseProxyMode(' SOCKS ') === 'socks' && parseProxyMode('HTTP') === 'http', `${parseProxyMode(' SOCKS ')} / ${parseProxyMode('HTTP')}`)
check('an empty mode falls back rather than failing', parseProxyMode('') === 'http' && parseProxyMode(null) === 'http', 'empty / null')

// --- both modes parse the same address shape --------------------------------
for (const mode of PROXY_MODES) {
  const parsed = parseProxySpec('127.0.0.1:1080', mode)
  check(`${mode}: a bare host:port parses`, parsed.ok === true, JSON.stringify(parsed))
  check(`${mode}: host and port survive`, parsed.ok === true && parsed.host === '127.0.0.1' && parsed.port === 1080, JSON.stringify({ host: parsed.host, port: parsed.port }))
  check(`${mode}: the mode is recorded on the spec`, parsed.ok === true && parsed.mode === mode, String(parsed.mode))
  check(`${mode}: no credentials means none, not empty`, parsed.ok === true && parsed.hasCredentials === false && parsed.username === '', JSON.stringify(parsed))
}

// The family is derived, never typed — this is where the whole design lives. HTTP mode
// resolves to plaintext until a probe discovers TLS; SOCKS resolves to SOCKS5, because SOCKS4
// has no password auth at all while a passwordless SOCKS5 server still rejects a SOCKS4
// greeting, so the version cannot be inferred from anything the user writes.
check('http mode derives the http scheme', parseProxySpec('proxy.example:8080', 'http').scheme === 'http', String(parseProxySpec('proxy.example:8080', 'http').scheme))
check('socks mode derives socks5', parseProxySpec('proxy.example:1080', 'socks').scheme === 'socks5', String(parseProxySpec('proxy.example:1080', 'socks').scheme))
check('and never socks4, which is refused rather than guessed at', PROXY_MODES.every(mode => parseProxySpec('proxy.example:1080', mode).scheme !== 'socks4'), PROXY_MODES.map(mode => parseProxySpec('proxy.example:1080', mode).scheme).join(', '))
check('no mode produces a scheme the transport does not implement', PROXY_MODES.every(mode => PROXY_SCHEMES.includes(parseProxySpec('proxy.example:1080', mode).scheme)), PROXY_SCHEMES.join(', '))

// --- a scheme in the string is a refusal, and it names the selector ----------
// This replaces the old "no scheme is refused" case. The refusal moved rather than
// disappeared: the string used to have to carry the family, and now must not.
for (const scheme of PROXY_SCHEMES) {
  const prefixed = parseProxySpec(`${scheme}://proxy.example:1080`, 'http')
  check(`a ${scheme}:// prefix is refused`, prefixed.ok === false, JSON.stringify(prefixed))
  check('  and the refusal points at the selector, not at the field',
    prefixed.ok === false && String(prefixed.error).includes('переключателем'), String(prefixed.error))
}
check('a scheme is refused in socks mode too, so the selector stays the one source',
  parseProxySpec('socks5://proxy.example:1080', 'socks').ok === false, JSON.stringify(parseProxySpec('socks5://proxy.example:1080', 'socks')))
check('and an unknown scheme is refused for the same reason rather than a different one',
  String(parseProxySpec('ftp://proxy.example:21', 'http').error ?? '').includes('переключателем'), String(parseProxySpec('ftp://proxy.example:21', 'http').error))

// --- credentials -------------------------------------------------------------
const credentialed = parseProxySpec('user:secret@proxy.example:1080', 'socks')
check('login and password are split out', credentialed.ok === true && credentialed.username === 'user' && credentialed.password === 'secret', JSON.stringify({ u: credentialed.username, p: credentialed.password }))
check('and the host is not polluted by them', credentialed.ok === true && credentialed.host === 'proxy.example', String(credentialed.host))
const atPassword = parseProxySpec('user:p@ss@proxy.example:8080', 'http')
check('a password containing @ still parses, split on the last @', atPassword.ok === true && atPassword.password === 'p@ss' && atPassword.host === 'proxy.example', JSON.stringify({ p: atPassword.password, h: atPassword.host }))
const emptyPassword = parseProxySpec('user:@proxy.example:8080', 'http')
check('an empty password is credentials, not their absence', emptyPassword.ok === true && emptyPassword.hasCredentials === true && emptyPassword.password === '', JSON.stringify({ has: emptyPassword.hasCredentials, p: emptyPassword.password }))
const usernameOnly = parseProxySpec('user@proxy.example:8080', 'http')
check('a username with no colon is not a password', usernameOnly.ok === true && usernameOnly.username === 'user' && usernameOnly.password === '', JSON.stringify({ u: usernameOnly.username, p: usernameOnly.password }))
const ipv6 = parseProxySpec('[2001:db8::1]:1080', 'socks')
check('a bracketed IPv6 literal keeps its address and takes its port after the bracket', ipv6.ok === true && ipv6.host === '2001:db8::1' && ipv6.port === 1080, JSON.stringify({ h: ipv6.host, p: ipv6.port }))
// The rule that was proposed and refused: credentials must not change the family, in either
// direction. A password present does not mean TLS, and its absence does not mean SOCKS4.
check('credentials do not change the derived family', credentialed.scheme === parseProxySpec('proxy.example:1080', 'socks').scheme, String(credentialed.scheme))

// --- refusals, each naming its own reason ------------------------------------
/**
 * Assert one refusal and that the reason is specific.
 *
 * @param text - the input.
 * @param needle - a word the reason must contain, so the refusal is the right one.
 * @param mode - the mode to parse under.
 */
function refuses(text, needle, mode = 'http') {
  const parsed = parseProxySpec(text, mode)
  check(`refuses ${JSON.stringify(text)}`, parsed.ok === false, JSON.stringify(parsed))
  check(`  and says why (${needle})`, parsed.ok === false && String(parsed.error).includes(needle), String(parsed.error))
}

refuses('', 'пуст')
refuses('   ', 'пуст')
refuses('proxy.example', 'не указан порт')
refuses('proxy.example:notaport', 'не число')
refuses('proxy.example:0', 'вне диапазона')
refuses('proxy.example:70000', 'вне диапазона')
refuses('proxy.example:-1', 'не число')
refuses('pro xy.example:1080', 'пробел')
refuses('proxy.exa mple:1080', 'пробел')
refuses('user:pass@', 'после «@» нет адреса')
refuses('[2001:db8::1:1080', 'не закрыта скобка')
refuses(42, 'не строка')
refuses(null, 'не строка')
refuses(undefined, 'не строка')
refuses(`${'h'.repeat(600)}.example:1080`, 'длиннее')
// A refusal is not mode-dependent: the same address is refused under both.
refuses('proxy.example', 'не указан порт', 'socks')

// --- masking: the password appears in no output -----------------------------
check('a parsed proxy masks its password', maskProxySpec(credentialed) === 'socks5://user:***@proxy.example:1080', maskProxySpec(credentialed))
check('masking keeps the username, which is not a secret', maskProxySpec(credentialed).includes('user'), maskProxySpec(credentialed))
// The masked form carries the *derived* scheme, which the user never typed. That is
// deliberate — a log line should say which transport was chosen, and the mode is not a
// secret — and it is why the masked form is not round-trippable back into the field.
check('the masked form names the derived transport rather than echoing the field', maskProxySpec(parseProxySpec('proxy.example:8080', 'http')) === 'http://proxy.example:8080', maskProxySpec(parseProxySpec('proxy.example:8080', 'http')))
check('masking a proxy with no credentials adds none', maskProxySpec(parseProxySpec('proxy.example:1080', 'socks')) === 'socks5://proxy.example:1080', maskProxySpec(parseProxySpec('proxy.example:1080', 'socks')))
check('an unparsed string is masked too, because a refusal quotes what was typed', maskProxySpec('user:secret@proxy.example:8080') === 'user:***@proxy.example:8080', maskProxySpec('user:secret@proxy.example:8080'))
check('and a refusal for an unparseable string cannot leak it', !maskProxySpec('user:secret@bad host:1080').includes('secret'), maskProxySpec('user:secret@bad host:1080'))
check('a scheme-prefixed string is masked without eating the scheme', maskProxySpec('http://user:secret@proxy.example:8080') === 'http://user:***@proxy.example:8080', maskProxySpec('http://user:secret@proxy.example:8080'))
check('no parsed proxy carries its password into its own masked form', PROXY_MODES.every(mode => !maskProxySpec(parseProxySpec('user:hunter2@proxy.example:1080', mode)).includes('hunter2')), PROXY_MODES.map(mode => maskProxySpec(parseProxySpec('user:hunter2@proxy.example:1080', mode))).join(' | '))
check('a missing proxy says so rather than printing undefined', maskProxySpec(undefined) === '(прокси не задан)' && maskProxySpec(parseProxySpec('nonsense')) === '(прокси не задан)', maskProxySpec(parseProxySpec('nonsense')))

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}