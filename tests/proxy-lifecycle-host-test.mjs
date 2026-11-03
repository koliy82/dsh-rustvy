// The proxy's lifecycle inside the running plugin: install, rebuild, restore, close, and the
// password never reaching an output.
//
// `syncProxyDispatcher` is not exported, so this drives it the only way a user can — through
// `POST /dsh-rustvy/config` on a mounted `lib/host.js` — and observes it through a fake undici
// placed in a throwaway profile's `node_modules`.
//
// That placement is load-bearing for two reasons at once. It is how the test sees which
// constructors were asked for and which agents were closed, and it is the only way `undici`
// resolves at all from here: the bare `import('undici')` fails in this repository
// (ERR_MODULE_NOT_FOUND), so a fake reachable solely through `importFromProfile` also proves
// the resolver is threaded into `createOriginFactory` and not just into `syncProxyDispatcher`.
// Had the factory kept its own bare default, every install below would report
// `installed: false` and this suite would be red for the right reason.
//
// Nothing here reaches the network: the origin and the proxy are both closed loopback ports,
// so the failure the masking assertions examine is a real one rather than a staged string.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-proxy-lifecycle-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

const PASSWORD = 'hunter2-secret'
const HOST_A = 'proxy-a.example'
const HOST_B = 'proxy-b.example'

// A closed port on loopback: connecting fails fast and for a real reason.
const DEAD_ORIGIN = 'http://127.0.0.1:9'
const DEAD_PROXY_PORT = 9

/**
 * Write a fake undici into the throwaway profile's `node_modules`.
 *
 * It records every construction, every dispatcher install and every close, on a global the
 * test reads back — the module is loaded by `require` inside this process, so a global is the
 * only channel between it and the assertions.
 *
 * @returns nothing; the log is read from `globalThis.__undiciLog`.
 */
function installFakeUndici() {
  const dir = join(PROFILE, 'node_modules', 'undici')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'undici', version: '0.0.0-fake', main: 'index.js' }, null, 2)}\n`)
  writeFileSync(join(dir, 'index.js'), `
const log = globalThis.__undiciLog
class Recorded {
  constructor(kind, uri, options) {
    this.kind = kind
    this.uri = uri
    this.options = options
    this.closed = false
    // uriType is recorded beside the value because the regression this suite exists to
    // catch is an argument arriving in the wrong SHAPE, not with the wrong value: a proxy url
    // handed over as an options object still contains the right string, one property down.
    log.constructions.push({ kind, uri, uriType: uri === undefined ? 'absent' : typeof uri })
  }
  close() {
    this.closed = true
    log.closed.push(this.kind)
    return Promise.resolve()
  }
}
// Signatures read from the profile's undici 7.30.0 rather than modelled from memory — that
// is precisely how this suite stayed green at 38/38 while SOCKS5 was dead in production:
//   Agent(options)                    — dispatcher/agent.js
//   ProxyAgent(opts)                  — opts.uri mandatory, dispatcher/proxy-agent.js:96-98
//   Socks5ProxyAgent(proxyUrl, opts)  — the URL is the FIRST POSITIONAL, socks5-proxy-agent.js:31
//   Pool(origin, opts)                — origin first, dispatcher/proxy-agent.js:26
// ProxyAgent's own internals corroborate the socks5 shape: proxy-agent.js:139 calls
// new Socks5ProxyAgent(this[kProxy].uri, {...}), positionally. Passing an options object
// instead made typeof proxyUrl === 'string' false and .protocol undefined, so it threw
// "Proxy URL must use socks5:// or socks:// protocol" -- a message blaming the protocol
// for an argument shape. (No backticks in this block: it is inside a template literal.)
class Agent extends Recorded {
  constructor(options) {
    super('Agent', undefined, options)
    // Real undici invokes the factory once per origin as requests arrive, and only then are
    // the per-origin agents constructed. A recorder that never invoked it would report zero
    // ProxyAgents and zero closes no matter what the product did, so the factory is kept and
    // the test drives it explicitly — modelling "a request happened", not pretending undici
    // ran. That distinction is the reason the close assertions below are meaningful at all.
    log.factories.push(options && options.factory)
  }
}
class ProxyAgent extends Recorded { constructor(opts) { super('ProxyAgent', opts && opts.uri, opts) } }
class Socks5ProxyAgent extends Recorded {
  constructor(proxyUrl, options) {
    super('Socks5ProxyAgent', proxyUrl, options)
    // The exact property that regressed, recorded separately so a kind-count can never stand
    // in for it: what type arrived in the first position.
    log.socks5FirstArg.push(proxyUrl === undefined ? 'absent' : typeof proxyUrl)
  }
}
// Pool takes the origin first, unlike the agents, so it is recorded separately: a foreign
// origin's direct pool is the thing that used to leak.
class Pool extends Recorded {
  constructor(origin, options) {
    super('Pool', undefined, options)
    this.origin = String(origin)
    log.pools.push(String(origin))
  }
}
let current = log.preExisting
module.exports = {
  Agent, Pool, ProxyAgent, Socks5ProxyAgent,
  setGlobalDispatcher(dispatcher) { current = dispatcher; log.dispatchers.push(dispatcher); return dispatcher },
  getGlobalDispatcher() { return current },
}
`)
}

globalThis.__undiciLog = {
  constructions: [],
  closed: [],
  pools: [],
  dispatchers: [],
  factories: [],
  socks5FirstArg: [],
  // A stable sentinel standing for whatever dispatcher was installed before this plugin, so
  // "the previous dispatcher was restored" is an identity check rather than a guess.
  preExisting: { sentinel: 'pre-existing-dispatcher' },
}
installFakeUndici()

writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: true, syncModels: false, apiKeys: false, collectErrors: false, uptimeView: false,
  origin: DEAD_ORIGIN,
  uptimeEndpoint: `${DEAD_ORIGIN}/api/report`,
  proxyEnabled: false,
  proxySpec: '',
  proxyMode: 'http',
}, null, 2)}\n`)

const { start } = await import('../lib/host.js')

const results = []
const logs = []
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

let route = null
const ctx = {
  logger: () => ({
    info: (message, error) => logs.push(['info', message, error]),
    warn: (message, error) => logs.push(['warn', message, error]),
    error: (message, error) => logs.push(['error', message, error]),
  }),
  profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
  on: () => () => {},
}
ctx.webServer = { register: r => { route = r; return () => { route = null } } }
ctx.configEditor = {
  entries: () => [],
  configuration: () => [],
  edit: async () => { throw new Error('not used by this suite') },
}

const handle = await start(ctx, {})

/**
 * Drive one plugin route.
 *
 * @param method - the HTTP method.
 * @param path - the route path.
 * @param body - the JSON body, if any.
 * @returns a promise of `{ status, json, text }`.
 */
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = method
    request.url = path
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); return this },
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
    setTimeout(() => reject(new Error(`timeout ${method} ${path}`)), 60_000).unref()
  })
}

const log = globalThis.__undiciLog
/**
 * How many times a global Agent was installed, which is how many rebuilds happened.
 *
 * @returns the count.
 */
const agents = () => log.constructions.filter(entry => entry.kind === 'Agent').length

/** A foreign origin, which must always go direct and never through the user's proxy. */
const FOREIGN_ORIGIN = 'https://registry.npmjs.org'

/**
 * Simulate requests arriving, so the current factory builds what undici would build.
 *
 * @param origins - the origins to route.
 * @returns a promise that settles once each has been dispatched.
 */
async function dispatch(origins) {
  const factory = log.factories[log.factories.length - 1]
  if (typeof factory !== 'function') return
  for (const origin of origins) await factory(origin, {})
}

// --- 1. switching on installs, and the resolver is threaded ------------------
check('nothing was installed at mount with the switch off', agents() === 0, String(agents()))
const on = await call('POST', '/dsh-rustvy/config', {
  proxyEnabled: true,
  proxySpec: `user:${PASSWORD}@${HOST_A}:${DEAD_PROXY_PORT}`,
  proxyMode: 'http',
})
check('the switch installs a dispatcher', on.json?.proxy?.installed === true, JSON.stringify(on.json?.proxy))
check('and it built exactly one global Agent', agents() === 1, String(agents()))
check('which was given the factory, not a promise', typeof log.constructions.find(entry => entry.kind === 'Agent')?.uri === 'undefined', JSON.stringify(log.constructions.find(entry => entry.kind === 'Agent')))
check('the install replaced the previous dispatcher', log.dispatchers.length === 1 && log.dispatchers[0] !== log.preExisting, String(log.dispatchers.length))
check('and the reported form is masked', on.json?.proxy?.masked === `http://user:***@${HOST_A}:${DEAD_PROXY_PORT}`, String(on.json?.proxy?.masked))

// --- 2. an unchanged setting does not rebuild --------------------------------
const again = await call('POST', '/dsh-rustvy/config', {
  proxyEnabled: true,
  proxySpec: `user:${PASSWORD}@${HOST_A}:${DEAD_PROXY_PORT}`,
  proxyMode: 'http',
})
check('re-posting the identical setting rebuilds nothing', agents() === 1, `${agents()} agent(s)`)
check('and still reports installed', again.json?.proxy?.installed === true, JSON.stringify(again.json?.proxy))

// --- 3. a changed address rebuilds and closes the previous install -----------
// Dispatch first: the previous install's ProxyAgent only exists once a request has reached
// the factory, so without this there would be nothing to close and the assertion would pass
// vacuously against an empty log. The in-scope origin is `config.origin` — `proxiedHostsOf`
// derives the scope from the settings, so it is the dead loopback address here and *not*
// rustvy.xyz. Dispatching rustvy.xyz produced two direct pools and no proxy agent, which was
// the fixture being wrong about its own scope rather than the product failing to proxy.
await dispatch([DEAD_ORIGIN, FOREIGN_ORIGIN])
check('a routed rustvy origin built the HTTP proxy agent', log.constructions.some(entry => entry.kind === 'ProxyAgent'), JSON.stringify(log.constructions.map(entry => entry.kind)))
check('and the foreign origin built a direct pool instead', log.pools.some(origin => origin.startsWith('https://registry.npmjs.org')), JSON.stringify(log.pools))
const changed = await call('POST', '/dsh-rustvy/config', {
  proxyEnabled: true,
  proxySpec: `user:${PASSWORD}@${HOST_B}:${DEAD_PROXY_PORT}`,
  proxyMode: 'http',
})
check('a changed host rebuilds', agents() === 2, String(agents()))
check('and closes the previous install', log.closed.filter(kind => kind === 'ProxyAgent').length >= 1, JSON.stringify(log.closed))
check('the new install reports installed', changed.json?.proxy?.installed === true, JSON.stringify(changed.json?.proxy))

// --- 4. a mode change with an identical address must still rebuild -----------
// The case lead named: switching HTTP to SOCKS without retyping anything leaves host:port
// identical, so a signature built from the address alone would report "nothing changed" and
// keep the previous family — the selector would appear to work and the transport would not.
const beforeMode = agents()
const modeChange = await call('POST', '/dsh-rustvy/config', {
  proxyEnabled: true,
  proxySpec: `user:${PASSWORD}@${HOST_B}:${DEAD_PROXY_PORT}`,
  proxyMode: 'socks',
})
check('a mode change with an identical host:port rebuilds', agents() === beforeMode + 1, `${beforeMode} → ${agents()}`)
// Route through the new install before counting, or the SOCKS5 agent does not exist yet and
// the assertion would be reading the previous install's log.
await dispatch([DEAD_ORIGIN, FOREIGN_ORIGIN])
check('and it builds the SOCKS5 agent rather than the HTTP one',
  log.constructions.filter(entry => entry.kind === 'Socks5ProxyAgent').length === 1
  && log.constructions.filter(entry => entry.kind === 'ProxyAgent').length === 1,
  JSON.stringify(log.constructions.filter(entry => entry.kind === 'ProxyAgent' || entry.kind === 'Socks5ProxyAgent').map(entry => entry.kind)))
check('the mode change is reported as installed', modeChange.json?.proxy?.installed === true && modeChange.json?.proxy?.scheme === 'socks5', JSON.stringify(modeChange.json?.proxy))

// --- 5. switching off restores what was there before -------------------------
// Dispatch again so the SOCKS5 agent exists and its close is observable rather than assumed.
await dispatch([DEAD_ORIGIN, FOREIGN_ORIGIN])
check('socks mode routed the rustvy origin through the SOCKS5 agent', log.constructions.some(entry => entry.kind === 'Socks5ProxyAgent'), JSON.stringify(log.constructions.map(entry => entry.kind)))
// The property that regressed, and the one a kind-count cannot see: undici's
// `Socks5ProxyAgent` takes the proxy URL as the FIRST POSITIONAL argument
// (socks5-proxy-agent.js:31), so `{ uri }` reaches it as an object, `.protocol` reads
// undefined, and the constructor throws «Proxy URL must use socks5:// or socks:// protocol».
// `ProxyAgent` really does take `{ uri }` (proxy-agent.js:96-98), which is why HTTP mode
// worked and only the second position on the selector was dead.
check('the SOCKS5 agent received its url as a string in the first position',
  log.socks5FirstArg.length > 0 && log.socks5FirstArg.every(type => type === 'string'),
  JSON.stringify(log.socks5FirstArg))
// Details print the scheme and the argument type, never the uri: the uri carries the
// credentials, and an assertion that leaks a password into its own diagnostic puts it in the
// test log, which is an output like any other.
const schemeOf = uri => (typeof uri === 'string' ? `${uri.split('://')[0]}://` : String(uri))
check('and that url is the socks5 uri rather than an options object carrying one',
  log.constructions.filter(entry => entry.kind === 'Socks5ProxyAgent')
    .every(entry => typeof entry.uri === 'string' && entry.uri.startsWith('socks5://')),
  JSON.stringify(log.constructions.filter(entry => entry.kind === 'Socks5ProxyAgent').map(entry => ({ scheme: schemeOf(entry.uri), uriType: entry.uriType }))))
check('while the HTTP agent still takes its uri inside the options object',
  log.constructions.filter(entry => entry.kind === 'ProxyAgent')
    .every(entry => typeof entry.uri === 'string' && entry.uri.startsWith('http')),
  JSON.stringify(log.constructions.filter(entry => entry.kind === 'ProxyAgent').map(entry => ({ scheme: schemeOf(entry.uri), uriType: entry.uriType }))))
const off = await call('POST', '/dsh-rustvy/config', { proxyEnabled: false })
check('switching off reports not installed', off.json?.proxy?.installed === false, JSON.stringify(off.json?.proxy))
check('and gives no reason, because off is not a failure', off.json?.proxy?.reason === '', JSON.stringify(off.json?.proxy?.reason))
check('the dispatcher in force afterwards is the one that was there before us',
  log.dispatchers[log.dispatchers.length - 1] === log.preExisting, String(log.dispatchers.length))
// The invariant is "everything built was closed", not a literal count: this recorder has no
// per-origin cache, so dispatching the same origin twice builds two agents where real undici
// would reuse one. Asserting a number here would be asserting the fake's behaviour.
const socksBuilt = log.constructions.filter(entry => entry.kind === 'Socks5ProxyAgent').length
const socksClosed = log.closed.filter(kind => kind === 'Socks5ProxyAgent').length
check('every SOCKS5 agent the install built was closed on the way out', socksBuilt > 0 && socksClosed === socksBuilt, `built ${socksBuilt}, closed ${socksClosed}`)

// --- 6. an enabled switch with a bad string reports the reason, masked -------
const bad = await call('POST', '/dsh-rustvy/config', { proxyEnabled: true, proxySpec: 'http://proxy.example:1080', proxyMode: 'http' })
check('a scheme in the address is refused rather than stripped', bad.json?.proxy?.installed === false, JSON.stringify(bad.json?.proxy))
check('and the reason names the selector', String(bad.json?.proxy?.reason).includes('переключателем'), String(bad.json?.proxy?.reason))
check('no dispatcher was installed for a refused string', agents() === beforeMode + 1, String(agents()))

// --- 7. masking against a REAL failure, not a staged string ------------------
// The probe dials a closed origin through a closed proxy, so this is the failure path a user
// actually meets. The password must survive it absent from every output.
await call('POST', '/dsh-rustvy/config', {
  proxyEnabled: true,
  proxySpec: `user:${PASSWORD}@127.0.0.1:${DEAD_PROXY_PORT}`,
  proxyMode: 'http',
})
const probe = await call('POST', '/dsh-rustvy/test-proxy', {})
check('the probe really failed, so the masking check is not vacuous', probe.json?.connected === false, JSON.stringify({ connected: probe.json?.connected, status: probe.json?.status, error: probe.json?.error }))
check('it reports no status, which is how a failure is told from a bad status', probe.json?.status === null, String(probe.json?.status))
check('and it measured the attempt rather than refusing to dial', typeof probe.json?.elapsedMs === 'number', String(probe.json?.elapsedMs))
check('the probe response carries the password nowhere', !probe.text.includes(PASSWORD), 'password present in response')
// The probe masks the *raw string*, not the parsed spec, because a refusal has to quote what
// the user typed — and what they typed has no scheme any more. So the masked form carries no
// scheme prefix either, and asserting one would be asserting the old contract.
check('the probe response is masked', probe.json?.masked === `user:***@127.0.0.1:${DEAD_PROXY_PORT}`, String(probe.json?.masked))
check('no log line the plugin emitted contains the password',
  !logs.some(entry => String(entry[1]).includes(PASSWORD) || String(entry[2]?.message ?? '').includes(PASSWORD)),
  JSON.stringify(logs.filter(entry => String(entry[1]).includes(PASSWORD)).map(entry => entry[1])))
// The masking invariant is deliberately narrow. `/state` publishes the whole raw config, so
// `config.proxySpec` reaches the client in the clear — and that is correct, not an oversight:
// the page renders it into the editable field, and when the user saves *without retyping* the
// client sends the stored value straight back. Redacting `/state` would therefore write
// `user:***@host:port` over the real password on an unrelated settings change, silently. So
// the assertion is about the places a secret must never appear — the probe response, the
// plugin's logs, and `/state`'s `proxy` object — and the check that actually protects the
// property is the round trip below, which goes red if anyone redacts `/state`.
const stateAfterProbe = await call('GET', '/dsh-rustvy/state')
check('the probe response carries the password in none of its own fields',
  !String(probe.json?.masked ?? '').includes(PASSWORD)
  && !String(probe.json?.error ?? '').includes(PASSWORD)
  && !String(probe.json?.reason ?? '').includes(PASSWORD),
  JSON.stringify({ masked: probe.json?.masked, error: probe.json?.error }))
check('`/state` proxy object is masked, not raw',
  !JSON.stringify(stateAfterProbe.json?.proxy ?? {}).includes(PASSWORD),
  JSON.stringify(stateAfterProbe.json?.proxy))
check('`/state` config does carry the raw spec, because the page must be able to edit it',
  stateAfterProbe.json?.config?.proxySpec === `user:${PASSWORD}@127.0.0.1:${DEAD_PROXY_PORT}`,
  'the raw spec is intentionally published to the editable field')
// The regression that matters: a save that does not retype the address must not disturb it.
// Read back through `/state` rather than the POST response, because `/state` is the shape the
// client binds to and the POST does not carry `config` at all.
const resaved = await call('POST', '/dsh-rustvy/config', { proxyEnabled: true })
const stateAfterResave = await call('GET', '/dsh-rustvy/state')
check('the save itself succeeded', resaved.status === 200, String(resaved.status))
check('saving without retyping preserves the stored spec byte for byte',
  stateAfterResave.json?.config?.proxySpec === `user:${PASSWORD}@127.0.0.1:${DEAD_PROXY_PORT}`,
  stateAfterResave.json?.config?.proxySpec === undefined ? 'absent' : 'changed')
check('and the switch stayed on across that save', stateAfterResave.json?.config?.proxyEnabled === true, String(stateAfterResave.json?.config?.proxyEnabled))
// Sweeps every failure detail this suite printed: an assertion that leaked a password into
// its own diagnostic would put it in the test log, which is an output like any other.
const leaked = results.filter(result => String(result.detail).includes(PASSWORD) || String(result.label).includes(PASSWORD))
check('no assertion detail printed the password either', leaked.length === 0, JSON.stringify(leaked.map(result => result.label)))

await handle.dispose()
check('disposing the plugin closes the install it was holding', log.closed.length > 0, JSON.stringify(log.closed))

rmSync(PROFILE, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}