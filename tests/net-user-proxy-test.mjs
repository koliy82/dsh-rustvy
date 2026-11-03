// The user's proxy policy governs the fallback route, and the ordering is the invariant.
//
// `exchange()` in `lib/net.js` tries `fetch` first and falls back to a hand-rolled tunnel on
// a transport failure. That fallback resolves its proxy through `proxyForTarget`, so if the
// user's scoped policy were not consulted there — and consulted *before* the environment's
// bypass list — a proxied attempt that failed would retry direct, and the user's real
// address would reach a provider he asked to reach through a proxy. The request having
// already been reported as failed does not undo it. That is a leak, not a nicety.
//
// These are pure functions over a target and an installed policy, so no real dispatcher is
// needed — which is why this is provable in the repository while the traffic-level version
// is not, and belongs to the manual harness pass instead.
//
// The environment is fixed once, before the module is imported, so nothing here depends on
// what this machine happens to export: an env proxy that is present, and a NO_PROXY entry
// naming the host the user asked to have proxied. That pairing is the point — the assertion
// that matters is the one where the environment says "direct" and the user says "proxied".
process.env.HTTP_PROXY = 'http://envproxy.example:8080'
process.env.http_proxy = 'http://envproxy.example:8080'
process.env.NO_PROXY = 'rustvy.xyz,bypassed.example'
process.env.no_proxy = 'rustvy.xyz,bypassed.example'

const { proxyForTarget, setUserProxy } = await import('../lib/net.js')
const { parseProxySpec } = await import('../lib/proxy.js')

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

// The family comes from the mode, not from the address: there is no scheme left to type.
const USER_SPEC = parseProxySpec('user:hunter2@userproxy.example:1080', 'socks')
const RUSTVY = new URL('https://rustvy.xyz/v1/models')
const FOREIGN = new URL('https://api.deepseek.com/v1/chat')
const BYPASSED = new URL('https://bypassed.example/thing')

check('the fixture spec parsed', USER_SPEC.ok === true, JSON.stringify(USER_SPEC))
/**
 * Describe a resolved proxy without ever printing a password.
 *
 * @param proxy - the URL `proxyForTarget` returned, or `undefined`.
 * @returns a safe string for a failure detail.
 */
function shown(proxy) {
  return proxy === undefined ? 'direct' : `${proxy.protocol}//${proxy.hostname}:${proxy.port}`
}

// --- 1. an in-scope host takes the user's spec, whatever the environment says ---
setUserProxy({ spec: USER_SPEC, hosts: ['rustvy.xyz'] })
const scoped = proxyForTarget(RUSTVY)
check('an in-scope host is routed by the user policy, not the environment one',
  scoped?.hostname === 'userproxy.example' && scoped.port === '1080', shown(scoped))
check('and it keeps the socks5 scheme the user chose rather than the env http one',
  scoped?.protocol === 'socks5:', String(scoped?.protocol))
check('the credentials survive into the tunnel URL', scoped?.username === 'user' && decodeURIComponent(scoped?.password ?? '') === 'hunter2', shown(scoped))

// --- 2. the ordering: NO_PROXY must not exempt a host the user asked to proxy ---
// `rustvy.xyz` is in NO_PROXY above. If the user's policy were consulted after `isDirect`,
// this would return `undefined` and the retry would go out with the user's real address.
check('a host the environment bypasses is STILL proxied, because the user policy is consulted first',
  scoped !== undefined, `${shown(scoped)} — an undefined here is the leak, and it is what a flipped order produces`)
check('while an env-bypassed host the user did not name stays direct', proxyForTarget(BYPASSED) === undefined, shown(proxyForTarget(BYPASSED)))

// --- 3. switching off returns the host to the environment's decision -------------
setUserProxy(null)
check('clearing the policy hands the host back to the environment', proxyForTarget(RUSTVY) === undefined, shown(proxyForTarget(RUSTVY)))
check('and an env-proxied host is unaffected by the user policy either way', proxyForTarget(FOREIGN)?.hostname === 'envproxy.example', shown(proxyForTarget(FOREIGN)))

// --- 4. a foreign origin is never matched by the user's host list ---------------
setUserProxy({ spec: USER_SPEC, hosts: ['rustvy.xyz'] })
check('a foreign origin does not take the user proxy', proxyForTarget(FOREIGN)?.hostname !== 'userproxy.example', shown(proxyForTarget(FOREIGN)))
check('it keeps the environment route instead', proxyForTarget(FOREIGN)?.hostname === 'envproxy.example', shown(proxyForTarget(FOREIGN)))
check('a host that merely contains the scoped name is not in scope',
  proxyForTarget(new URL('https://rustvy.xyz.evil.example/v1'))?.hostname !== 'userproxy.example',
  shown(proxyForTarget(new URL('https://rustvy.xyz.evil.example/v1'))))
check('and matching is case-insensitive on the hostname',
  proxyForTarget(new URL('https://RUSTVY.XYZ/v1/models'))?.hostname === 'userproxy.example',
  shown(proxyForTarget(new URL('https://RUSTVY.XYZ/v1/models'))))

// --- the setter refuses shapes it cannot honour -------------------------------
setUserProxy(null)
// `host:port` is now the *valid* form, so an unparsable fixture has to be genuinely bad —
// a missing port — rather than merely scheme-less. A check that kept the old string would
// have asserted "an unparsable spec installs nothing" against a spec that parses.
check('an unparsable spec installs nothing', setUserProxy({ spec: parseProxySpec('userproxy.example'), hosts: ['rustvy.xyz'] }) === false && proxyForTarget(RUSTVY) === undefined, shown(proxyForTarget(RUSTVY)))
check('an empty host list installs nothing', setUserProxy({ spec: USER_SPEC, hosts: [] }) === false, String(setUserProxy({ spec: USER_SPEC, hosts: [] })))
check('and a null policy is not an error', setUserProxy(null) === false, 'null')

// Leave no policy behind for whatever imports this module next.
setUserProxy(null)

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
