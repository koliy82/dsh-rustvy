// The proxy's boundary: which origins may be proxied, and which dispatcher each gets.
//
// Two levels, because undici resolves only inside the harness and `import("undici")` fails
// here (ERR_MODULE_NOT_FOUND, no vendored copy, and Node's internal undici exposes the
// installed dispatcher but not the constructors). So:
//
//   * the DECISION is proven purely — `proxyBranchFor` needs no undici at all;
//   * the CONSTRUCTION consequence is proven against an injected recorder that logs which
//     constructor the factory asked for.
//
// The traffic-level half — a real agent, a real socket, counted connections on a local
// proxy — cannot be proven from this repository and is verified by hand inside the running
// harness before release. Nothing here should be read as covering it.
import { parseProxySpec, proxyBranchFor, isProxiedOrigin, createOriginFactory, PROXY_MODES, PROXY_SCHEMES } from '../lib/proxy.js'

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

const RUSTVY = 'https://rustvy.xyz'
const HOSTS = ['rustvy.xyz']
const FOREIGN = ['https://api.deepseek.com', 'https://registry.npmjs.org', 'http://127.0.0.1:3789']

// --- the predicate is exact, not a substring ---------------------------------
check('the rustvy origin is in scope', isProxiedOrigin(RUSTVY, HOSTS) === true, RUSTVY)
check('a host that merely contains it is not', isProxiedOrigin('https://rustvy.xyz.evil.example', HOSTS) === false, 'rustvy.xyz.evil.example')
check('a host that merely starts like it is not', isProxiedOrigin('https://notrustvy.xyz', HOSTS) === false, 'notrustvy.xyz')
check('matching is case-insensitive on the hostname', isProxiedOrigin('https://RUSTVY.XYZ/v1', HOSTS) === true, 'RUSTVY.XYZ')
check('an unparseable origin is out of scope rather than throwing', isProxiedOrigin('not a url', HOSTS) === false, 'not a url')
check('and an empty host list proxies nothing', isProxiedOrigin(RUSTVY, []) === false && isProxiedOrigin(RUSTVY, undefined) === false, '[] / undefined')

// --- every mode routes the rustvy origin, and nothing else --------------------
// Two modes across the same three foreign origins, covering every branch `proxyBranchFor`
// can still return: `proxy-http`, `socks5` and `delegate`. There is no socks4 branch — the
// mode selector removed every way to ask for one, so the mode-level form of that property is
// asserted below instead: `socks` yields `socks5` and never `socks4`.
for (const mode of PROXY_MODES) {
  const spec = parseProxySpec('user:pass@proxy.example:1080', mode)
  const branch = proxyBranchFor(RUSTVY, spec, { enabled: true, proxiedHosts: HOSTS })
  const expected = mode === 'socks' ? 'socks5' : 'proxy-http'
  check(`mode ${mode} routes the rustvy origin to ${expected}`, branch.kind === expected, JSON.stringify({ got: branch.kind, mode }))
  check(`mode ${mode} carries the parsed spec through`, branch.spec?.host === 'proxy.example' && branch.spec?.port === 1080, JSON.stringify(branch.spec && { host: branch.spec.host, port: branch.spec.port }))
  check(`mode ${mode} derives the scheme the transport implements`, branch.spec?.scheme === (mode === 'socks' ? 'socks5' : 'http'), String(branch.spec?.scheme))
  // The boundary. This is the user's «больше никуда прокси работать не должно» as an
  // assertion, and it is the one that must redden if the branch is made unconditional.
  for (const origin of FOREIGN) {
    check(`mode ${mode} delegates ${new URL(origin).hostname} instead of proxying it`,
      proxyBranchFor(origin, spec, { enabled: true, proxiedHosts: HOSTS }).kind === 'delegate', origin)
  }
}
// The retired branch, asserted at mode level rather than string level.
check('socks mode never yields a socks4 branch', proxyBranchFor(RUSTVY, parseProxySpec('proxy.example:1080', 'socks'), { enabled: true, proxiedHosts: HOSTS }).kind !== 'socks4', 'socks4')
check('and no mode can produce one', PROXY_MODES.every(mode => proxyBranchFor(RUSTVY, parseProxySpec('proxy.example:1080', mode), { enabled: true, proxiedHosts: HOSTS }).kind !== 'socks4'), PROXY_MODES.join(', '))
check('a scheme this build has no transport for delegates rather than reaching a connector',
  proxyBranchFor(RUSTVY, { ok: true, mode: 'http', scheme: 'socks4', host: 'proxy.example', port: 1080, hasCredentials: false }, { enabled: true, proxiedHosts: HOSTS }).kind === 'delegate',
  JSON.stringify(proxyBranchFor(RUSTVY, { ok: true, mode: 'http', scheme: 'socks4', host: 'proxy.example', port: 1080, hasCredentials: false }, { enabled: true, proxiedHosts: HOSTS })))

// --- off, unparseable and absent all mean "not me" ---------------------------
const good = parseProxySpec('proxy.example:1080', 'socks')
check('an off switch delegates even the rustvy origin', proxyBranchFor(RUSTVY, good, { enabled: false, proxiedHosts: HOSTS }).kind === 'delegate', 'enabled:false')
check('a missing enabled flag delegates rather than defaulting to on', proxyBranchFor(RUSTVY, good, { proxiedHosts: HOSTS }).kind === 'delegate', 'enabled omitted')
// This fixture inverted under the new contract and would have kept passing for the wrong
// reason: `proxy.example:1080` used to be the "no scheme, therefore refused" case, and a
// bare `host:port` is now the *required* format. Asserting a refusal against it would test
// the guard against a spec that parses, so the string is genuinely bad — no port at all.
check('an unparseable string delegates rather than being treated as a proxy', proxyBranchFor(RUSTVY, parseProxySpec('proxy.example', 'http'), { enabled: true, proxiedHosts: HOSTS }).kind === 'delegate', 'no port')
check('the fixture above really is a refusal, so the check is not vacuous', parseProxySpec('proxy.example', 'http').ok === false, JSON.stringify(parseProxySpec('proxy.example', 'http')))
check('a refusal object delegates', proxyBranchFor(RUSTVY, { ok: false, error: 'x' }, { enabled: true, proxiedHosts: HOSTS }).kind === 'delegate', 'ok:false')
check('no spec at all delegates', proxyBranchFor(RUSTVY, undefined, { enabled: true, proxiedHosts: HOSTS }).kind === 'delegate', 'undefined')
check('an off switch delegates a foreign origin too, for every mode', PROXY_MODES.every(mode => FOREIGN.every(origin => proxyBranchFor(origin, parseProxySpec('p:1', mode), { enabled: false, proxiedHosts: HOSTS }).kind === 'delegate')), 'all delegate')
check('and a scheme-prefixed address is refused in every mode, so it can never reach a branch', PROXY_SCHEMES.every(scheme => parseProxySpec(`${scheme}://proxy.example:1080`, 'http').ok === false), PROXY_SCHEMES.join(', '))

// --- construction: which dispatcher the factory asks for ---------------------
/**
 * A recorder standing in for undici.
 *
 * @returns the fake module and the log of what was constructed.
 */
function fakeUndici() {
  const log = []
  /**
   * One recorded constructor.
   *
   * undici's constructors do **not** share a signature, and getting this wrong is not a
   * cosmetic problem in a fake: `ProxyAgent(options)` takes the proxy address inside the
   * options object, while `Socks5ProxyAgent(proxyUrl, options)` takes it as the **first
   * positional argument** (`lib/dispatcher/socks5-proxy-agent.js:31`). An earlier revision of
   * this recorder normalised both into one shape, so it accepted `new Socks5ProxyAgent({ uri })`
   * and recorded a plausible `uri` for it — while the real library throws
   * `InvalidArgumentError` on exactly that call and every SOCKS5 install died in ~2 ms. The
   * suite stayed green because the fake was modelling a signature from memory instead of from
   * the library. So each constructor names its real shape, and the log records which position
   * carried a string, which is what lets an assertion pin the asymmetry.
   *
   * @param kind - the name to log.
   * @param shape - `'options-only'`, `'origin-first'` or `'url-first'`, as undici really takes it.
   * @returns a constructor that records what it was given.
   */
  function recorder(kind, shape) {
    return class {
      constructor(first, second) {
        const options = shape === 'options-only' ? first : second
        const positional = shape === 'options-only' ? undefined : String(first)
        log.push({
          kind,
          shape,
          // `ProxyAgent` reads the address from here; `Socks5ProxyAgent` never sees it here.
          uri: options?.uri,
          // `Pool` reads the origin from here; `Socks5ProxyAgent` reads the proxy url from here.
          positional,
          firstWasString: typeof first === 'string',
          origin: shape === 'origin-first' ? positional : undefined,
          connect: typeof options?.connect,
        })
        this.closed = false
      }
      close() { this.closed = true; log.push({ kind: `${kind}:closed` }); return Promise.resolve() }
    }
  }
  return {
    log,
    module: {
      Pool: recorder('Pool', 'origin-first'),
      Agent: recorder('Agent', 'options-only'),
      ProxyAgent: recorder('ProxyAgent', 'options-only'),
      Socks5ProxyAgent: recorder('Socks5ProxyAgent', 'url-first'),
    },
  }
}

const delegated = []
const fake = fakeUndici()
const built = await createOriginFactory({
  loadUndici: async () => fake.module,
  // No scheme in the string: a bare `host:port` is the required format now, and a scheme in
  // the address is a refusal pointing at the mode selector. Under the old contract this
  // fixture carried `http://`, which parses as a refusal today — so the spec would be
  // `ok: false`, `proxyBranchFor` would delegate *everything* including the rustvy origin,
  // and every construction check below would fail on the wrong guard.
  spec: parseProxySpec('user:pass@proxy.example:8080', 'http'),
  enabled: true,
  proxiedHosts: HOSTS,
  delegate: (origin, options) => { delegated.push(String(origin)); return { delegated: true } },
})

const firstDispatcher = built.factory(RUSTVY)
const httpEntry = fake.log.find(entry => entry.kind === 'ProxyAgent')
check('the rustvy origin gets a ProxyAgent for an http proxy', firstDispatcher !== undefined && fake.log.some(entry => entry.kind === 'ProxyAgent'), JSON.stringify(fake.log))
// undici does not await its factory, so a factory returning a promise hands it something
// that is not a Dispatcher and fails in a way that looks like a network error. The bug was
// real — an earlier revision declared this factory `async` — and it was found by reading the
// harness's own `createPolicyDispatcher`, not by a test. This is that test.
check('the factory returns a dispatcher, not a promise, because undici does not await it',
  !(firstDispatcher instanceof Promise) && firstDispatcher !== null && typeof firstDispatcher === 'object',
  String(typeof firstDispatcher))
check('and the proxy uri carries the credentials it was given', fake.log.find(entry => entry.kind === 'ProxyAgent')?.uri === 'http://user:pass@proxy.example:8080', String(fake.log.find(entry => entry.kind === 'ProxyAgent')?.uri))
for (const origin of FOREIGN) {
  await built.factory(origin)
}
check('no foreign origin was given a ProxyAgent', fake.log.filter(entry => entry.kind === 'ProxyAgent').length === 1, JSON.stringify(fake.log.filter(entry => entry.kind === 'ProxyAgent')))
check('every foreign origin was delegated instead', delegated.length === FOREIGN.length && FOREIGN.every(origin => delegated.includes(origin)), JSON.stringify(delegated))

const socks5 = await createOriginFactory({
  loadUndici: async () => fake.module,
  // The family comes from the mode selector, not from the string: `socks` resolves to a
  // `socks5` scheme inside `parseProxySpec`, which is what selects undici's own agent.
  spec: parseProxySpec('proxy.example:1080', 'socks'),
  enabled: true,
  proxiedHosts: HOSTS,
  delegate: () => ({ delegated: true }),
})
fake.log.length = 0
await socks5.factory(RUSTVY)
await socks5.factory(FOREIGN[0])
const socksEntry = fake.log.find(entry => entry.kind === 'Socks5ProxyAgent')
check('socks5 uses undici own agent for the rustvy origin', socksEntry !== undefined, JSON.stringify(fake.log))
// The property that regressed and shipped: `Socks5ProxyAgent(proxyUrl, options)` takes the
// address as its FIRST POSITIONAL argument, unlike `ProxyAgent(options)` which takes it inside
// the options object. Asserting only "a Socks5ProxyAgent was built" is what let the wrong call
// shape through — the fake accepted `{ uri }`, recorded a plausible uri, and stayed green while
// the real library threw InvalidArgumentError and every SOCKS5 install died in ~2 ms.
check('and the address reaches it as a positional url, not inside an options object',
  socksEntry?.firstWasString === true && socksEntry?.positional === 'socks5://proxy.example:1080' && socksEntry?.uri === undefined,
  JSON.stringify(socksEntry))
check('while the http agent keeps the opposite shape, so the asymmetry is pinned both ways',
  httpEntry?.firstWasString === false && httpEntry?.uri === 'http://user:pass@proxy.example:8080',
  JSON.stringify(httpEntry))
check('and a foreign origin is still delegated, so only one socks5 agent was built',
  fake.log.filter(entry => entry.kind === 'Socks5ProxyAgent').length === 1, JSON.stringify(fake.log))

// SOCKS4 has no branch at all now, so the construction-level question changed: not "does it
// build our own connector" but "does it build nothing". The spec is hand-crafted because
// `parseProxySpec` cannot produce a socks4 scheme any more — the mode selector removed every
// way to ask for one — and the point is what the factory does with a scheme it has no
// transport for. It must delegate rather than throw: `createOriginFactory` throws for such a
// kind, and a throw here would mean an unproxyable scheme taking the process down instead of
// falling back to a direct connection.
const retired = await createOriginFactory({
  loadUndici: async () => fake.module,
  spec: { ok: true, mode: 'http', scheme: 'socks4', host: 'proxy.example', port: 1080, hasCredentials: false },
  enabled: true,
  proxiedHosts: HOSTS,
  delegate: (origin) => ({ delegated: true, origin: String(origin) }),
})
fake.log.length = 0
const retiredDispatcher = retired.factory(RUSTVY)
check('a scheme with no transport delegates instead of building a connector',
  fake.log.length === 0 && retiredDispatcher?.delegated === true, JSON.stringify(fake.log))
check('and no constructor in the factory still names socks4', !fake.log.some(entry => /socks4/iu.test(entry.kind)), JSON.stringify(fake.log))

// --- level 2: fragmenting our own https origin, and what it must not touch -----
// `fragment` is the undici-shaped `connect` that `lib/net.js` exports as `fragmentedConnector`.
// It performs its own TLS and returns the negotiated socket, so handing it to a plaintext origin
// would attempt a handshake against a port that is not speaking TLS. The collector is
// `http://<ip>:3789`, so that mistake would break the plugin's own error reports — during a
// blocking window, which is the only moment the user turned fragmentation on.
const fragConnect = () => {}
const fragSpec = parseProxySpec('proxy.example:8080', 'http')
const fragmenting = await createOriginFactory({
  loadUndici: async () => fake.module,
  spec: fragSpec,
  enabled: false,
  proxiedHosts: HOSTS,
  fragment: fragConnect,
  delegate: (origin) => ({ delegated: true, origin: String(origin) }),
})
fake.log.length = 0
const fragDispatcher = fragmenting.factory(RUSTVY)
const fragEntry = fake.log.find(entry => entry.kind === 'Pool')
check('with fragmentation on, our own https origin gets a Pool carrying the connect function',
  fragEntry !== undefined && fragEntry.connect === 'function' && fragEntry.origin === RUSTVY,
  JSON.stringify(fake.log))
check('and it is not delegated, so fragmentation is actually on the path',
  fragDispatcher?.delegated === undefined, JSON.stringify(fragDispatcher))
check('and the Pool is tracked, so switching off closes it instead of leaking a socket pool',
  fragmenting.created.includes(fragDispatcher), `created=${fragmenting.created.length}`)

fake.log.length = 0
const plainScoped = fragmenting.factory('http://rustvy.xyz')
check('an in-scope but PLAINTEXT origin is never given a TLS connect — that is the collector',
  fake.log.some(entry => entry.kind === 'Pool') === false && plainScoped?.delegated === true,
  JSON.stringify(fake.log))

fake.log.length = 0
const foreignFrag = fragmenting.factory('https://registry.npmjs.org')
check('and a foreign https origin is delegated rather than fragmented',
  fake.log.some(entry => entry.kind === 'Pool' && entry.connect === 'function') === false
  && foreignFrag?.delegated === true, JSON.stringify(fake.log))

// A proxy the user configured is a route he chose deliberately, so it outranks fragmentation —
// the same rule the environment proxy gets.
const both = await createOriginFactory({
  loadUndici: async () => fake.module,
  spec: fragSpec,
  enabled: true,
  proxiedHosts: HOSTS,
  fragment: fragConnect,
  delegate: () => ({ delegated: true }),
})
fake.log.length = 0
both.factory(RUSTVY)
check('with a proxy installed, the proxy wins over fragmentation for the same origin',
  fake.log.some(entry => entry.kind === 'ProxyAgent')
  && fake.log.some(entry => entry.kind === 'Pool' && entry.connect === 'function') === false,
  JSON.stringify(fake.log))

// --- close-on-disable: a privacy property, not tidiness ----------------------
const closable = await createOriginFactory({
  loadUndici: async () => fake.module,
  spec: parseProxySpec('proxy.example:8080', 'http'),
  enabled: true,
  proxiedHosts: HOSTS,
  delegate: () => ({ delegated: true }),
})
fake.log.length = 0
await closable.factory(RUSTVY)
await closable.factory(RUSTVY)
const agents = closable.created.length
await closable.close()
check('every agent the factory built is closed on disable', agents > 0 && fake.log.filter(entry => /:closed$/u.test(entry.kind)).length === agents, `built ${agents}, closed ${fake.log.filter(entry => /:closed$/u.test(entry.kind)).length}`)
check('and the list is emptied so a second disable closes nothing twice', closable.created.length === 0, String(closable.created.length))

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
