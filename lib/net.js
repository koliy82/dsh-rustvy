/**
 * dsh-rustvy — one outbound request, on whatever route this process has.
 *
 * The catalog and the logo set live on the provider's public site, and the
 * uptime collector lives behind that same site, so this module speaks both ways:
 * `getUrl` reads a document, `postJson` delivers one. Whichever it is, the
 * machine often reaches the origin only through the outbound proxy another
 * plugin (or the environment) installed. Two routes are tried, in order:
 *
 *   1. the process's own `fetch`, which resolves the live global dispatcher and
 *      therefore follows whatever egress route is installed right now;
 *   2. a connector built here from the proxy named in the environment, for the
 *      case where no dispatcher is installed — or where the installed one cannot
 *      reach the origin (a SOCKS5 endpoint that a plain undici agent ignores, for
 *      example).
 *
 * Route 2 spent one release describing a design it did not implement: its request
 * carried `agent: false`, which on Node 24 discards the request-level
 * `createConnection` and connects straight to the target instead of riding the
 * tunnel — the tunnel was built and then thrown away. Recorded here, and not only
 * in the regression test, because the next bug of this kind will look the same: a
 * route that is present, plausible and never actually used, whose failure names a
 * proxy that was consulted and a target that was never reached through it.
 *
 * Both routes honour `NO_PROXY`, and both answer with the body as bytes: the
 * caller decides whether those bytes are JSON-bearing HTML or an SVG document.
 *
 * Nothing here is specific to models or to reports; it is the smallest correct
 * "exchange one URL with this process, proxied or not" that the host half needs.
 *
 * @module dsh-rustvy/net
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { Duplex } from 'node:stream'

/** Loopback names that are never sent to a proxy, whatever the user typed. */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Environment names read for the proxy, in the order they are preferred. */
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']

/** Environment names read for the bypass list. */
const NO_PROXY_ENV_NAMES = ['NO_PROXY', 'no_proxy']

/** Largest body accepted; the catalog page is well under this. */
const MAX_BYTES = 12 * 1024 * 1024

/**
 * Read one environment name, tolerating an empty value.
 * @param name - the variable name.
 * @returns the trimmed value, or `undefined` when absent or empty.
 */
function env(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The bypass list in force, as a set of lowercase rules.
 * @returns the entries of `NO_PROXY`, plus the loopback names always kept direct.
 */
function bypassRules() {
  const raw = NO_PROXY_ENV_NAMES.map(env).find(value => value !== undefined) ?? ''
  const entries = raw
    .split(/[,\s]+/u)
    .map(entry => entry.trim().toLowerCase().replace(/^\./u, ''))
    .filter(entry => entry !== '')
  return new Set([...entries, ...ALWAYS_DIRECT])
}

/**
 * Whether a hostname must stay direct under the current bypass list.
 * @param hostname - the target host, brackets allowed.
 * @returns true when the host is loopback or matched by a `NO_PROXY` entry.
 */
export function isDirect(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  const rules = bypassRules()
  if (rules.has('*')) return true
  if (rules.has(host)) return true
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true
  // A bare domain entry also covers its subdomains, the way curl and Node read it.
  for (const rule of rules) {
    if (rule !== '' && host.endsWith(`.${rule}`)) return true
  }
  return false
}

/**
 * The user's proxy setting, scoped to the hosts it governs.
 *
 * Two proxy policies exist and they are not the same thing. The environment's is broad and
 * inherited; this one is narrow, deliberate, and set by a switch on the settings page. While
 * that switch is on, **this one governs** — on the fallback path too, and even when the
 * environment says the host is bypassed.
 *
 * That precedence is a privacy invariant rather than a preference. The reason a user routes
 * rustvy traffic through a proxy is that the provider must not see his own address. If a
 * proxied attempt failed and the retry went out through whatever the environment named — or
 * direct, when the environment names nothing — his real IP would reach the provider on a
 * path he explicitly asked to be proxied, and an error reported afterwards would not undo a
 * request that already happened. So an in-scope host is routed by nothing but this policy.
 */
let userProxy = null

/**
 * Set or clear the user's scoped proxy policy.
 *
 * @param next - `{ spec, hosts }`, where `spec` is a parsed proxy and `hosts` the hostnames
 *   it governs; anything else clears it.
 * @returns whether a policy is now in force.
 */
export function setUserProxy(next) {
  userProxy = next !== null && typeof next === 'object'
    && next.spec !== null && typeof next.spec === 'object' && next.spec.ok === true
    && Array.isArray(next.hosts) && next.hosts.length > 0
    ? { spec: next.spec, hosts: next.hosts.map(host => String(host).toLowerCase()) }
    : null
  return userProxy !== null
}

/**
 * The user's proxy for one target, when the user's policy governs it.
 *
 * @param target - the parsed request URL.
 * @returns the proxy URL, or `undefined` when this target is not the user's business.
 */
function userProxyForTarget(target) {
  if (userProxy === null) return undefined
  const hostname = String(target.hostname).toLowerCase().replace(/^\[|\]$/gu, '')
  if (!userProxy.hosts.includes(hostname)) return undefined
  const { spec } = userProxy
  const auth = spec.hasCredentials
    ? `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password)}@`
    : ''
  try {
    return new URL(`${spec.scheme}://${auth}${spec.host}:${spec.port}`)
  } catch {
    // A spec that parsed but cannot be re-expressed as a URL is a programming error, and the
    // safe failure is to route nowhere rather than to route direct.
    return undefined
  }
}

/**
 * The proxy URL for one target: the user's policy first, the environment's second.
 *
 * The order is the invariant above, and it is why the user's check runs *before* `isDirect`:
 * a `NO_PROXY` entry inherited from the environment must not quietly exempt a host the user
 * asked to have proxied.
 *
 * @param target - the parsed request URL.
 * @returns the parsed proxy URL, or `undefined` for a direct route.
 */
export function proxyForTarget(target) {
  const user = userProxyForTarget(target)
  if (user !== undefined) return user
  if (isDirect(target.hostname)) return undefined
  const raw = PROXY_ENV_NAMES.map(env).find(value => value !== undefined)
  if (raw === undefined) return undefined
  try {
    const proxy = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`)
    return proxy.hostname === '' ? undefined : proxy
  } catch {
    return undefined
  }
}

/**
 * One plain or TLS-wrapped TCP connection.
 * @param host - the peer host.
 * @param port - the peer port.
 * @param secure - true to terminate TLS, with `host` as the SNI name.
 * @param timeoutMs - the connect budget.
 * @returns a promise of the connected socket.
 */
function connectTcp(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect(port, host)
    const fail = error => {
      socket.destroy()
      reject(error)
    }
    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs, () => { fail(new Error(`the connection to ${host}:${port} timed out after ${timeoutMs} ms`)) })
    socket.once('error', fail)
    const ready = secure ? 'secureConnect' : 'connect'
    socket.once(ready, () => {
      socket.setTimeout(0)
      socket.removeListener('error', fail)
      resolve(socket)
    })
  })
}

/**
 * Open one TCP stream to the origin through a SOCKS5 proxy.
 *
 * Username/password authentication is offered when the URL carries credentials,
 * which is the only form this profile's proxy uses; no-auth is offered otherwise.
 *
 * @param proxy - the parsed `socks5://` URL.
 * @param target - the parsed request URL.
 * @param timeoutMs - the whole-handshake budget.
 * @returns a promise of a connected socket to the origin.
 */
function connectSocks5(proxy, target, timeoutMs) {
  const port = target.port !== '' ? Number(target.port) : target.protocol === 'https:' ? 443 : 80
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port) || 1080, proxy.hostname)
    const deadline = setTimeout(() => { finish(new Error(`the SOCKS5 handshake timed out after ${timeoutMs} ms`)) }, timeoutMs)
    /** Settle the handshake once, whichever way it ended. */
    const finish = error => {
      clearTimeout(deadline)
      socket.removeListener('data', onData)
      if (error === undefined) {
        socket.setTimeout(0)
        socket.removeListener('error', onError)
        resolve(socket)
      } else {
        socket.destroy()
        reject(error)
      }
    }
    const onError = error => { finish(error) }
    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs)
    socket.once('error', onError)

    const user = decodeURIComponent(proxy.username || '')
    const pass = decodeURIComponent(proxy.password || '')
    const methods = user !== '' ? [0x00, 0x02] : [0x00]
    let stage = 'greeting'
    let pending = Buffer.alloc(0)

    /** Send the CONNECT request for the origin's host and port. */
    const requestConnect = () => {
      const hostBuffer = Buffer.from(target.hostname.replace(/^\[|\]$/gu, ''), 'utf8')
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]), hostBuffer,
        Buffer.from([port >> 8, port & 0xff]),
      ]))
      stage = 'reply'
    }

    /** Advance the handshake over whatever has arrived so far. */
    const step = () => {
      if (stage === 'greeting') {
        if (pending.length < 2) return
        const method = pending[1]
        pending = pending.subarray(2)
        if (method === 0xff) return finish(new Error('the SOCKS5 proxy refused every authentication method offered'))
        if (method === 0x02) {
          const userBuffer = Buffer.from(user, 'utf8')
          const passBuffer = Buffer.from(pass, 'utf8')
          socket.write(Buffer.concat([
            Buffer.from([0x01, userBuffer.length]), userBuffer,
            Buffer.from([passBuffer.length]), passBuffer,
          ]))
          stage = 'auth'
        } else {
          stage = 'connect'
          requestConnect()
        }
        return step()
      }
      if (stage === 'auth') {
        if (pending.length < 2) return
        const accepted = pending[1] === 0x00
        pending = pending.subarray(2)
        if (!accepted) return finish(new Error('the SOCKS5 proxy rejected the credentials in the proxy URL'))
        stage = 'connect'
        requestConnect()
        return step()
      }
      // Reply: VER REP RSV ATYP BND.ADDR BND.PORT
      if (pending.length < 5) return
      const reply = pending[1]
      const addressType = pending[3]
      const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? 1 + pending[4] : 0
      const total = 4 + addressLength + 2
      if (pending.length < total) return
      pending = pending.subarray(total)
      if (reply !== 0x00) return finish(new Error(`the SOCKS5 proxy refused the connection (reply code ${reply})`))
      finish(undefined)
    }

    const onData = chunk => {
      pending = Buffer.concat([pending, chunk])
      step()
    }
    socket.on('data', onData)
    socket.write(Buffer.from([0x05, methods.length, ...methods]))
  })
}

/**
 * Open one stream to the origin through an HTTP proxy.
 *
 * An `https:` target is CONNECT-tunnelled; an `http:` target gets a socket to the
 * proxy itself, over which the caller then sends an absolute-URI request.
 *
 * @param proxy - the parsed `http://` or `https://` proxy URL.
 * @param target - the parsed request URL.
 * @param timeoutMs - the connect budget.
 * @returns a promise of `{ socket, absoluteForm }`.
 */
async function connectHttpProxy(proxy, target, timeoutMs) {
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
  if (target.protocol !== 'https:') {
    return { socket: await connectTcp(proxy.hostname, proxyPort, proxy.protocol === 'https:', timeoutMs), absoluteForm: true }
  }
  const port = target.port !== '' ? Number(target.port) : 443
  const headers = proxy.username === ''
    ? { host: `${target.hostname}:${port}` }
    : {
        host: `${target.hostname}:${port}`,
        'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`, 'utf8').toString('base64')}`,
      }
  return await new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http
    const request = transport.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers,
      timeout: timeoutMs,
      // `agent: false` is correct here and wrong in `requestViaEnvironmentProxy`,
      // and the difference is not stylistic. This CONNECT is meant to reach the
      // proxy itself, so a direct connect is the intent, and there is no
      // request-level `createConnection` here for the one-off Agent path to
      // discard. The other call hands Node a socket that already ends at the
      // origin, where the same option silently replaces it. Same key, opposite
      // meanings, one file apart — read the note there before "unifying" them.
      agent: false,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`the HTTP proxy refused CONNECT (${response.statusCode})`))
        return
      }
      socket.setTimeout(0)
      resolve({ socket, absoluteForm: false })
    })
    request.once('timeout', () => { request.destroy(new Error(`the HTTP proxy CONNECT timed out after ${timeoutMs} ms`)) })
    request.once('error', reject)
    request.end()
  })
}

/**
 * Read one response body with a size cap.
 * @param response - the incoming message.
 * @returns a promise of the body bytes.
 */
function readBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    response.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BYTES) {
        response.destroy()
        reject(new Error(`the response exceeded ${MAX_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    response.once('end', () => { resolve(Buffer.concat(chunks)) })
    response.once('error', reject)
  })
}

/**
 * One request through the environment's proxy, on Node's own transports.
 *
 * @param url - the absolute URL to exchange.
 * @param options - `{ method, body, timeoutMs, headers }`; `body` is sent as
 *   bytes and, when present, must be accompanied by the header that describes it.
 * @returns a promise of `{ status, headers, body }`.
 */
async function requestViaEnvironmentProxy(url, options) {
  const target = new URL(url)
  const proxy = proxyForTarget(target)
  if (proxy === undefined) throw new Error('the environment names no proxy for this host')
  const timeoutMs = options.timeoutMs ?? 20_000
  const method = options.method ?? 'GET'
  const body = options.body === undefined ? null : Buffer.from(options.body)
  const secure = target.protocol === 'https:'
  const port = target.port !== '' ? Number(target.port) : secure ? 443 : 80

  // SOCKS5 only, and the narrowing is deliberate. The test here used to be
  // `/^socks[45]h?:$/u`, which matched socks4 and then handed it to `connectSocks5` — so an
  // environment naming a socks4 proxy received a SOCKS5 greeting the server would reject,
  // and the failure would read as a broken proxy rather than as the wrong handshake. A
  // refusal that names the version is recoverable; a handshake for a different protocol is
  // not.
  //
  // That refusal is the whole of SOCKS4 support, and it is a decision rather than a gap in
  // progress. There is no socks4 connector anywhere in this package and nothing is waiting
  // for one: the mode selector in `lib/proxy.js` removed every way to ask for socks4,
  // `proxyBranchFor` returns `delegate` for a scheme it has no transport for instead of
  // reaching for a connector, and `createOriginFactory` throws for a kind with no transport
  // rather than falling through to code that does not exist. What an environment naming a
  // socks4 proxy gets is the error below, which names the version.
  const isSocks5 = /^socks5h?:$/u.test(proxy.protocol)
  if (/^socks4h?:$/u.test(proxy.protocol)) {
    throw new Error('socks4 is not supported; refusing rather than sending a SOCKS5 handshake the proxy would reject')
  }
  const tunneled = isSocks5
    ? { socket: await connectSocks5(proxy, target, timeoutMs), absoluteForm: false }
    : await connectHttpProxy(proxy, target, timeoutMs)

  // A CONNECT tunnel or a SOCKS stream already ends at the origin, so TLS for an
  // https target is layered on top of it; an absolute-URI request through an HTTP
  // proxy keeps the proxy socket and names the full URL in its request line.
  const stream = secure && !tunneled.absoluteForm
    ? await new Promise((resolve, reject) => {
        const secureStream = tls.connect({ socket: tunneled.socket, servername: target.hostname })
        secureStream.once('error', reject)
        secureStream.once('secureConnect', () => { resolve(secureStream) })
      })
    : tunneled.socket

  return await new Promise((resolve, reject) => {
    const transport = secure ? https : http
    const request = transport.request({
      createConnection: () => stream,
      host: target.hostname,
      port,
      method,
      path: tunneled.absoluteForm ? target.href : `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        accept: '*/*',
        'user-agent': 'dsh-rustvy',
        ...options.headers,
        // Node's own client sets neither for a hand-built request, and a POST
        // without them is a request the origin may wait on forever.
        ...(body === null ? {} : { 'content-length': String(body.byteLength) }),
      },
      timeout: timeoutMs,
      // No `agent` key here, and the absence is load-bearing rather than an
      // omission. On Node 24 an explicit `agent: false` puts the request on the
      // one-off Agent path, which opens its own connection and discards the
      // request-level `createConnection` above — so the tunnel just built to the
      // proxy is thrown away and the request goes straight to the target's own
      // address, which in a proxy-only network is the address that cannot be
      // reached. With the option absent Node takes the no-agent path and honours
      // `createConnection`, and the socket lifecycle stays with this request,
      // which is what a one-off tunnelled call wants anyway.
      //
      // `connectHttpProxy` passes this same option and is right to; see the note
      // there, because one file holding the same key with opposite meanings is
      // exactly the trap that produced this bug.
    }, response => {
      readBody(response).then(
        responseBody => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: responseBody })
          response.destroy()
        },
        error => {
          response.destroy()
          reject(error)
        },
      )
    })
    request.once('error', reject)
    request.once('timeout', () => { request.destroy(new Error(`the request to ${target.host} timed out after ${timeoutMs} ms`)) })
    if (body === null) request.end()
    else request.end(body)
  })
}

/* ------------------------ fragmented TLS transport ------------------------ */

/** The modes `setTlsFragment` accepts. */
const TLS_FRAGMENT_MODES = ['off', 'auto', 'always']

/** The validated working point from the spec: 16 bytes, 3 ms. */
const FRAGMENT_BYTES = 16
const FRAGMENT_DELAY_MS = 3

/** How many transport failures in a row switch `auto` from plain to fragmented. */
const FRAG_FALLBACK_STREAK = 2

/** How often `auto` in `frag` mode tries plain again. */
const FRAG_PROBE_MS = 300_000

/**
 * Fragmentation settings, as the host sets them.
 *
 * Module-level rather than in the config file because `lib/host.js` owns the config and this
 * module may not add keys to it. The host calls {@link setTlsFragment} and reads
 * {@link getTransportState} for `/state`.
 *
 * `hosts` is the scope: nothing outside it is ever fragmented. The spec's rule is that only
 * the provider's own origin is fragmented, never github, npm or loopback.
 */
let tlsFragment = {
  mode: 'off',
  fragmentBytes: FRAGMENT_BYTES,
  delayMs: FRAGMENT_DELAY_MS,
  hosts: [],
  log: () => {},
  now: () => Date.now(),
}

/**
 * Which transport the plugin's own requests are using right now.
 *
 * Deliberately separate from any process-wide egress mode. This one governs the catalogue,
 * the logos, the uptime reports and the key checks; the process's own traffic is decided by
 * an origin factory elsewhere. Sharing one variable would let two failing catalogue reads
 * silently rewrite how the user's model requests leave the machine.
 */
let transport = { mode: 'plain', since: 0 }

/** Consecutive transport failures, reset by any answer at all — including a 4xx or 5xx. */
let plainFailStreak = 0

/** When `auto` last returned to plain, so the probe is rate-limited rather than continuous. */
let fragProbeAt = 0

/**
 * Set or clear the fragmented-TLS settings.
 *
 * Validation follows the spec: an unknown mode is read as `off` rather than honoured, the
 * piece size is an integer in 1..64, and the delay is 0..100 ms. Anything out of range falls
 * back to the validated working point instead of throwing, because a settings write must not
 * be able to make the plugin unable to reach the network.
 *
 * @param next - `{ mode, fragmentBytes, delayMs, hosts, log, now }`; `null` switches off.
 * @returns the settings now in force, without the injected functions.
 */
export function setTlsFragment(next) {
  const source = next !== null && typeof next === 'object' ? next : {}
  const bytes = Number(source.fragmentBytes)
  const delay = Number(source.delayMs)
  tlsFragment = {
    mode: TLS_FRAGMENT_MODES.includes(source.mode) ? source.mode : 'off',
    fragmentBytes: Number.isInteger(bytes) && bytes >= 1 && bytes <= 64 ? bytes : FRAGMENT_BYTES,
    delayMs: Number.isInteger(delay) && delay >= 0 && delay <= 100 ? delay : FRAGMENT_DELAY_MS,
    hosts: Array.isArray(source.hosts)
      ? source.hosts.map(host => String(host).toLowerCase().replace(/^\[|\]$/gu, '')).filter(host => host !== '')
      : [],
    log: typeof source.log === 'function' ? source.log : () => {},
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
  }
  // Switching to `off` or `always` takes effect immediately rather than waiting for the next
  // request to notice: a user turning fragmentation on expects it on, not on after two more
  // failures. The streak and the probe timer are reset with the mode, because a settings write
  // is a new start rather than a continuation — and because leaving them behind would make the
  // behaviour depend on what happened before the user touched the switch.
  plainFailStreak = 0
  fragProbeAt = 0
  // Every settings write starts from plain. Leaving a previous mode in place would mean a user
  // who switched from `always` to `auto` inherited `frag` and never saw the auto logic decide
  // anything — the mode would describe the old rule rather than the new one. `always` then sets
  // frag immediately below, so turning fragmentation on is still on rather than on-after-two-failures.
  setTransport('plain', '')
  if (tlsFragment.mode === 'always') setTransport('frag', '')
  return getTlsFragment()
}

/**
 * The settings currently in force, without the injected clock and logger.
 * @returns `{ mode, fragmentBytes, delayMs, hosts }`.
 */
export function getTlsFragment() {
  return {
    mode: tlsFragment.mode,
    fragmentBytes: tlsFragment.fragmentBytes,
    delayMs: tlsFragment.delayMs,
    hosts: [...tlsFragment.hosts],
  }
}

/**
 * The transport the plugin's own requests are using, for `/state`.
 * @returns `{ mode, since }` — `mode` is `plain` or `frag`, `since` a timestamp.
 */
export function getTransportState() {
  return { mode: transport.mode, since: transport.since }
}

/**
 * Record a transport change and say so once.
 *
 * One line per transition and none for a request that stays in the same mode, which is what
 * makes the log readable during an outage: the transitions are the events.
 *
 * @param mode - `plain` or `frag`.
 * @param message - the line to log, or empty for a silent reset.
 * @returns nothing.
 */
function setTransport(mode, message) {
  if (transport.mode === mode) {
    if (message !== '') fragProbeAt = tlsFragment.now()
    return
  }
  transport = { mode, since: tlsFragment.now() }
  if (mode === 'frag') fragProbeAt = tlsFragment.now()
  if (message !== '') {
    try { tlsFragment.log(message) } catch { /* a logger that throws must not break a request */ }
  }
}

/**
 * Whether this target is one the user asked to fragment.
 *
 * The scope check runs before anything else about the route, in the same spirit as
 * `proxyForTarget` consulting the user's policy before the direct shortcut: a host outside
 * `hosts` is never fragmented, and a host inside it is fragmented whenever the mode allows,
 * rather than after some other rule has quietly exempted it.
 *
 * @param target - the parsed request URL.
 * @returns true when fragmentation governs this target.
 */
function fragmentApplies(target) {
  if (tlsFragment.mode === 'off') return false
  const hostname = String(target.hostname).toLowerCase().replace(/^\[|\]$/gu, '')
  return tlsFragment.hosts.includes(hostname)
}

/**
 * Cut one buffer into pieces of at most `fragmentBytes`.
 *
 * Exported for the unit test rather than because a caller needs it: the boundary cases —
 * exactly one piece, one short piece, no pieces for empty input — are the whole reason the
 * fragmentation is checkable at all.
 *
 * @param data - the buffer to cut.
 * @param fragmentBytes - the maximum piece length; a non-integer falls back to the default.
 * @returns the pieces in order; empty or non-buffer input yields none.
 */
export function fragmentSlices(data, fragmentBytes) {
  const size = Number.isInteger(fragmentBytes) && fragmentBytes > 0 ? fragmentBytes : FRAGMENT_BYTES
  if (!Buffer.isBuffer(data) || data.length === 0) return []
  const pieces = []
  for (let offset = 0; offset < data.length; offset += size) pieces.push(data.subarray(offset, offset + size))
  return pieces
}

/** The TLS handshake record content type. Only this is ever fragmented. */
const TLS_HANDSHAKE_CONTENT_TYPE = 0x16

/**
 * One TLS connection whose ClientHello leaves in TCP fragments.
 *
 * The technique is the application-level version of what zapret and goodbyedpi do: the first
 * outbound TLS record is written in small pieces with a pause between them, so a DPI that
 * does not reassemble the TCP stream sees no SNI in any single packet. The server reassembles
 * and answers normally; the measured cost is a one-off ~420 ms handshake against ~55 ms.
 *
 * Two things this does differently from the sketch it came from, both deliberate.
 *
 * **The ClientHello is identified, not assumed.** The sketch fragments "the first buffer the
 * TLS layer writes" and trusts that it is the hello. That holds for a fresh handshake, but a
 * resumed session or an early-data extension changes what the first write is, and fragmenting
 * the wrong record fails in a way that looks like a network problem rather than like a bug.
 * So the record's content type is checked: only a handshake record (0x16) is cut. Anything
 * else goes out whole and the connection still works, just unfragmented.
 *
 * **Backpressure between the pieces is honoured.** The sketch returns `true` from every piece
 * write. With a 16 KB socket high-water mark and a hello of a few hundred bytes the buffer is
 * never full, so discarding the signal is safe *in practice* — but that is an argument about
 * today's sizes, not about the code. If a piece write reports a full buffer, the next piece
 * waits for `'drain'`. The value returned to the TLS layer is still `true`, and that is the
 * one place the signal is not propagated: telling the TLS layer to pause would stall its state
 * machine until a drain this wrapper cannot synthesise, and the bytes it would then defer are
 * bounded by the buffer handed to us. The backpressure that matters is between the pieces.
 *
 * @param host - the SNI name and the DNS source of the address.
 * @param port - the peer port.
 * @param timeoutMs - the connect and handshake budget.
 * @param options - `{ fragmentBytes, delayMs, tls }`, where `tls` is spread into
 *   `tls.connect` so a caller can carry verification settings through.
 * @returns a promise of the connected and negotiated TLSSocket.
 */
/**
 * The mechanism that works, measured: route the TLS handshake through a JS `Duplex`.
 *
 * `tls.connect({ socket })` over a real `net.Socket` takes the socket's **native handle** and
 * writes to it directly, so overriding `socket.write` is never called and the fragmentation is
 * a silent no-op. A JS stream has no handle, which puts TLS on its `JSStreamSocket` path and
 * routes every handshake write through `_write` — including the ClientHello. Measured against
 * `rustvy.xyz:443`, full HTTP GET of `/v1/models`:
 *
 *     plain, through the same Duplex : TLS  113 ms, HTTP 200, body 6368 B, fragmented false
 *     frag 16 B / 3 ms               : TLS 1593 ms, HTTP 200, body 6368 B, fragmented true
 *     frag  8 B / 5 ms               : TLS 3142 ms, HTTP 200, body 6368 B, fragmented true
 *
 * The same 6368-byte body as the Python `ssl.MemoryBIO` measurement in the spec, so the server
 * accepts a fragmented hello. **Three of the spec's numbers are wrong on Windows** and this is
 * what to build against:
 *
 * - The ClientHello is **1587 bytes, not ~500** — TLS 1.3 with a post-quantum key share. At 16
 *   bytes that is 100 pieces rather than 31, three times the work the spec's arithmetic assumes.
 * - `setTimeout` granularity here is **~15.6 ms**, so delay 1 and delay 3 cost the same. Measured
 *   sweep: `16/0` → 749 ms, `16/1` → 1528 ms, `16/3` → 1587 ms, `32/1` → 760–786 ms,
 *   `64/1` → 797–1347 ms, `128/1` → 208 ms. The spec's «16/3 → ~420 ms» was measured on Linux,
 *   where a 3 ms sleep really is 3 ms. On Windows the cost is `pieces × ~15.6 ms` for any delay
 *   ≥ 1, and `pieces × ~7.5 ms` with `setImmediate` instead. At the spec's own working point
 *   that is a **14x** handshake slowdown per new connection, not the 7x its table implies. This
 *   is the price of the feature and it is paid per connection, not per request: a fragmented
 *   hello is a one-off and the connection then runs at ordinary speed.
 * - `64/1` failed once with `read ECONNRESET` and succeeded on retry. A flake, not a bad
 *   configuration — but it is why the auto-switch needs a streak of two rather than one.
 *
 * `raw.setNoDelay(true)` is load-bearing rather than tidy: it is what makes each 16-byte `write`
 * its own TCP segment, so the pieces stay separate without relying on the delay between them.
 *
 * **16 bytes stays the default and must not drift upward for speed.** It is the size that
 * provably splits the SNI; at 64 bytes the hostname can survive intact inside one packet, which
 * defeats the whole point while still costing the latency.
 *
 * @param request - the seam's arguments; see {@link setFragmentTransport}.
 * @returns a promise of the connected and negotiated TLSSocket.
 */
function duplexFragmentTransport(request) {
  const { host, port, timeoutMs, fragmentBytes, delayMs, pieces, handshakeRecord } = request
  const tlsOptions = request.tls ?? {}
  return new Promise((resolve, reject) => {
    const raw = net.connect(port, host)
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      raw.destroy()
      reject(error)
    }
    raw.setNoDelay(true)
    raw.setTimeout(timeoutMs, () => { fail(new Error(`fragmented connect to ${host}:${port} timed out after ${timeoutMs} ms`)) })
    raw.once('error', fail)

    let fragmented = false
    const duplex = new Duplex({
      read() { raw.resume() },
      write(chunk, encoding, callback) {
        // Only the first buffer that is actually a TLS handshake record and actually larger
        // than one piece. A resumed session or an early-data extension changes what the first
        // write is, and fragmenting the wrong record fails in a way that reads as a network
        // problem — so the record type is checked rather than the position assumed.
        if (!fragmented && Buffer.isBuffer(chunk) && chunk.length > fragmentBytes && handshakeRecord(chunk)) {
          fragmented = true
          const parts = pieces(chunk)
          let index = 0
          const sendNext = () => {
            if (raw.destroyed) return
            if (index >= parts.length) { callback(); return }
            // Backpressure between pieces is honoured rather than discarded: a full buffer
            // waits for `drain` instead of piling the rest on. With a 16 KB high-water mark and
            // a 1587-byte hello this cannot fire today, which is exactly why it is written down
            // rather than left as an argument about current sizes.
            const flushed = raw.write(parts[index++])
            if (flushed === false) { raw.once('drain', () => setTimeout(sendNext, delayMs)); return }
            setTimeout(sendNext, delayMs)
          }
          sendNext()
          return
        }
        const flushed = raw.write(chunk, encoding)
        if (flushed === false) raw.once('drain', callback)
        else callback()
      },
      final(callback) { raw.end(callback) },
      destroy(error, callback) { raw.destroy(); callback(error) },
    })
    raw.on('data', data => { if (!duplex.push(data)) raw.pause() })
    raw.on('end', () => duplex.push(null))
    raw.on('error', error => duplex.destroy(error))

    const secure = tls.connect({ socket: duplex, servername: host, ...tlsOptions })
    secure.once('secureConnect', () => {
      settled = true
      raw.setTimeout(0)
      raw.removeListener('error', fail)
      resolve(secure)
    })
    secure.once('error', fail)
  })
}

/** The installed mechanism, defaulted to the measured one and replaceable for tests. */
let fragmentTransport = duplexFragmentTransport

/**
 * Install the mechanism that actually sends a fragmented ClientHello.
 *
 * A seam rather than an implementation, and the reason is a measurement rather than a
 * preference. The spec's approach — replacing `socket.write` before `tls.connect({ socket })`
 * — was tried and does not work: the TLS wrap takes the socket's **native handle** and writes
 * to it directly, so the JavaScript `write` is never called for the handshake and the override
 * is a silent no-op. The connection then succeeds *unfragmented*, with a handshake faster than
 * plain, a clean 200 and no evidence anywhere that nothing was fragmented. That is the failure
 * mode that costs a user a working workaround while telling him it is on.
 *
 * So whatever mechanism survives measurement is injected here: a JS `Duplex` to force TLS onto
 * its `JSStreamSocket` path, or a loopback relay that fragments the first chunk at the TCP
 * level. The mode logic, the transport state and the test suite do not change when it does.
 *
 * The seam hands the mechanism two helpers so it does not re-derive them: `pieces(data)` cuts a
 * buffer on the same boundaries the tests assert, and `handshakeRecord(data)` says whether a
 * buffer is a TLS handshake record worth fragmenting at all.
 *
 * @param next - `(request) => Promise<TLSSocket>`, where `request` is
 *   `{ host, port, timeoutMs, fragmentBytes, delayMs, tls, pieces, handshakeRecord }`;
 *   anything else removes the mechanism.
 * @returns whether a transport is now installed.
 */
export function setFragmentTransport(next) {
  fragmentTransport = typeof next === 'function' ? next : null
  return fragmentTransport !== null
}

/**
 * One TLS connection whose ClientHello is meant to leave in TCP fragments.
 *
 * Delegates to the installed {@link setFragmentTransport} mechanism. With none installed it
 * **rejects** rather than connecting unfragmented: a silent fallback would mean the mode says
 * `frag`, the traffic is ordinary, and the only symptom is that the blocking is not fixed —
 * exactly the no-op described above.
 *
 * @param host - the SNI name and the DNS source of the address.
 * @param port - the peer port.
 * @param timeoutMs - the connect and handshake budget.
 * @param options - `{ fragmentBytes, delayMs, tls }`, where `tls` is passed to the mechanism so
 *   verification settings survive: a connector that drops them would skip hostname
 *   verification and turn a censorship workaround into a man-in-the-middle.
 * @returns a promise of the connected and negotiated TLSSocket.
 */
export function connectFragmentedTls(host, port, timeoutMs = 20_000, options = {}) {
  if (fragmentTransport === null) {
    return Promise.reject(new Error(
      'no fragmenting transport is installed; refusing to connect unfragmented while the mode asks for fragmentation',
    ))
  }
  const fragmentBytes = Number.isInteger(options.fragmentBytes) && options.fragmentBytes > 0
    ? options.fragmentBytes
    : tlsFragment.fragmentBytes
  const delayMs = Number.isInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : tlsFragment.delayMs
  return Promise.resolve(fragmentTransport({
    host,
    port,
    timeoutMs,
    fragmentBytes,
    delayMs,
    tls: options.tls ?? {},
    pieces: data => fragmentSlices(data, fragmentBytes),
    handshakeRecord: data => Buffer.isBuffer(data) && data.length > 0 && data[0] === TLS_HANDSHAKE_CONTENT_TYPE,
  }))
}

/**
 * An undici-shaped `connect` that fragments the ClientHello for one origin.
 *
 * undici accepts either an object or a function for `connect`, and the difference is not
 * cosmetic — the trap is recorded in `lib/proxy.js` under «Why the connector was declined».
 * An object is spread into `buildConnector({ ...tls })` and undici performs the TLS upgrade
 * itself; a function **replaces** the connector and must return the final, already-negotiated
 * socket. {@link connectFragmentedTls} does its own TLS, so it satisfies that contract.
 *
 * The signature undici calls is `(options, callback)`, not the primitive's
 * `(host, port, timeoutMs, options)`. This adapter is the difference, and it is exported
 * separately so the primitive stays readable and testable.
 *
 * Verification is carried through, never defaulted. Every TLS setting undici passes — `ca`,
 * `rejectUnauthorized`, `minVersion`, `servername` — is forwarded to `tls.connect`. A
 * connector that quietly dropped them would skip hostname verification and turn a censorship
 * workaround into a man-in-the-middle, and that failure is invisible from the outside.
 *
 * @param options - `{ fragmentBytes, delayMs }`.
 * @returns a `connect(connectOptions, callback)` function.
 */
export function fragmentedConnector(options = {}) {
  return (connectOptions, callback) => {
    const settings = { ...(connectOptions ?? {}) }
    const hostname = settings.servername ?? settings.hostname
    // `??` is wrong here and looks right, which is what makes it worth a comment. undici 7.30.0
    // passes `port: ''` — an empty *string*, not undefined — for a default-port connect, and
    // `Number('')` is `0`, so `net.connect(0, host)` fails EADDRNOTAVAIL against a nonsense local
    // port. The protocol decides the default instead, and `||` rather than `??` is what catches
    // both the empty string and a real zero.
    const port = Number(settings.port) || (settings.protocol === 'https:' ? 443 : 80)
    const timeoutMs = Number.isFinite(settings.timeout) && settings.timeout > 0 ? settings.timeout : 20_000
    // Keys undici owns rather than tls.connect: passing them through would be noise at best.
    delete settings.hostname
    delete settings.port
    delete settings.timeout
    delete settings.protocol
    delete settings.httpSocket
    delete settings.socket
    delete settings.servername
    connectFragmentedTls(hostname, port, timeoutMs, {
      fragmentBytes: options.fragmentBytes,
      delayMs: options.delayMs,
      tls: { ...settings, servername: hostname },
    }).then(socket => callback(null, socket), error => callback(error))
  }
}

/**
 * One request over the fragmented transport, mirroring the proxy route.
 *
 * Deliberately the same shape as {@link requestViaEnvironmentProxy} — `https.request` with a
 * `createConnection` that hands over an already-negotiated socket, the same header set, the
 * same `readBody` — because the two differ in how the socket is obtained and in nothing else.
 * Re-deriving the request half would give the plugin two header policies that drift.
 *
 * @param url - the absolute https URL to exchange.
 * @param options - `{ method, body, timeoutMs, headers }`.
 * @returns a promise of `{ status, headers, body }`.
 */
async function requestViaFragmentedTransport(url, options) {
  const target = new URL(url)
  const timeoutMs = options.timeoutMs ?? 20_000
  const body = options.body === undefined ? null : Buffer.from(options.body)
  const port = target.port !== '' ? Number(target.port) : 443
  const stream = await connectFragmentedTls(target.hostname, port, timeoutMs)
  return await new Promise((resolve, reject) => {
    const request = https.request({
      createConnection: () => stream,
      host: target.hostname,
      port,
      method: options.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        accept: '*/*',
        'user-agent': 'dsh-rustvy',
        ...options.headers,
        ...(body === null ? {} : { 'content-length': String(body.byteLength) }),
      },
      timeout: timeoutMs,
      // No `agent` key, for the reason spelled out in `requestViaEnvironmentProxy`: an
      // explicit `agent: false` discards `createConnection` on Node 24 and the request goes
      // straight to the target's address, which is the address that cannot be reached.
    }, response => {
      readBody(response).then(
        responseBody => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: responseBody })
          response.destroy()
        },
        error => {
          response.destroy()
          reject(error)
        },
      )
    })
    request.once('error', reject)
    request.once('timeout', () => { request.destroy(new Error(`the request to ${target.host} timed out after ${timeoutMs} ms`)) })
    if (body === null) request.end()
    else request.end(body)
  })
}

/**
 * Count one worked answer — any status, including 4xx and 5xx — as evidence the transport works.
 *
 * A 404 for one logo and a 502 from the provider both mean a round trip completed. Treating
 * them as failures would let a provider having a bad afternoon flip the plugin's transport,
 * which is the exact confusion the spec warns about.
 *
 * @returns nothing.
 */
function noteTransportWorked() {
  plainFailStreak = 0
}

/**
 * Count one transport failure and switch the mode when the streak reaches the threshold.
 *
 * @param applies - whether fragmentation governs this target.
 * @returns nothing.
 */
function noteTransportFailed(applies) {
  plainFailStreak += 1
  if (!applies || tlsFragment.mode !== 'auto' || transport.mode === 'frag') return
  if (plainFailStreak >= FRAG_FALLBACK_STREAK) {
    setTransport('frag', `транспорт: plain → frag (${plainFailStreak} transport-ошибки подряд)`)
  }
}

/**
 * Whether `auto` should spend this request on a plain probe to see if the blocking ended.
 *
 * Rate-limited rather than attempted per request: the probe is a request that is expected to
 * fail while the block lasts, so trying it every time would double the cost of an outage.
 *
 * @returns true when a probe is due.
 */
function probeDue() {
  if (tlsFragment.mode !== 'auto' || transport.mode !== 'frag') return false
  return tlsFragment.now() - fragProbeAt >= FRAG_PROBE_MS
}

/**
 * Exchange one URL: the plain transport, the fragmented one when it governs the target, and
 * the environment's proxy last.
 *
 * A non-2xx answer is a result, not an error — what a 404 for one logo or a 429
 * for one report means is the caller's business. Only transport failures fall
 * through to the second route, and only when the environment names a proxy for
 * that host at all.
 *
 * @param url - the absolute URL.
 * @param options - `{ method, body, timeoutMs, headers }`.
 * @returns a promise of `{ status, headers, body, via }`.
 * @throws the combined transport error when every route failed.
 */
async function exchange(url, options) {
  const timeoutMs = options.timeoutMs ?? 20_000
  const target = new URL(url)
  const applies = fragmentApplies(target)
  const errors = []

  /**
   * One plain attempt on the process's own transport.
   * @returns a promise of `{ status, headers, body, via }`.
   */
  const attemptPlain = async () => {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: '*/*', 'user-agent': 'dsh-rustvy', ...options.headers },
    })
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > MAX_BYTES) throw new Error(`the response exceeded ${MAX_BYTES} bytes`)
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, via: 'fetch' }
  }

  // The route order, and it is the whole of the auto-switch policy in one expression: plain
  // while the mode is plain; frag only while the mode is frag, except on a due probe, where
  // one plain attempt goes ahead of it to see whether the block has lifted.
  //
  // `&& applies` is load-bearing rather than tidy, and its absence was a live defect. Without
  // it an out-of-scope host in `frag` mode got `routes = ['frag']`, the loop below skipped that
  // only route, and the request fell straight to the env-proxy fallback — which throws when no
  // proxy is configured. The blast radius is the collector: `uptimeEndpoint` is a foreign host,
  // so the moment the transport flipped, error reports stopped arriving. And `auto` flips
  // precisely after two consecutive transport failures, which is a blocking window — the plugin
  // would have correctly detected that rustvy was unreachable and, in the same moment, lost the
  // ability to report it. The mode reshapes routing only for the hosts it governs.
  const probe = probeDue()
  const routes = transport.mode === 'frag' && applies
    ? (probe ? ['plain', 'frag'] : ['frag'])
    : ['plain']

  for (const route of routes) {
    if (route === 'frag' && !applies) continue
    try {
      const result = route === 'plain'
        ? await attemptPlain()
        : { ...(await requestViaFragmentedTransport(url, { ...options, timeoutMs })), via: 'frag' }
      noteTransportWorked()
      if (route === 'plain' && probe) setTransport('plain', 'транспорт: frag → plain (зонд прошёл)')
      return result
    } catch (error) {
      errors.push(error)
      if (route !== 'plain') continue
      if (probe) fragProbeAt = tlsFragment.now()
      noteTransportFailed(applies)
      // A failure that flipped the mode mid-request is retried on the new transport rather
      // than reported. The switch is still logged as the transition it is, but the caller
      // asked for a working request and not for the switch to be observable at its expense.
      if (applies && transport.mode === 'frag' && !routes.includes('frag')) routes.push('frag')
    }
  }

  // The environment proxy stays the last fallback, exactly as it was: it is the user's
  // configured route and nothing here should outrank it.
  try {
    const result = await requestViaEnvironmentProxy(url, { ...options, timeoutMs })
    return { ...result, via: 'env-proxy' }
  } catch (error) {
    const detail = errors.map(one => (one instanceof Error ? one.message : String(one))).join('; ')
    const proxy = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail} (and through the environment proxy: ${proxy})`)
  }
}

/**
 * Read one URL, on either route.
 * @param url - the absolute URL to read.
 * @param options - `{ timeoutMs, headers }`.
 * @returns a promise of `{ status, headers, body, via }`.
 * @throws the combined transport error when every route failed.
 */
export async function getUrl(url, options = {}) {
  return await exchange(url, { ...options, method: 'GET' })
}

/**
 * Send one JSON document, on either route.
 *
 * The report this carries is telemetry about an outage, so the budget is
 * deliberately tighter than a catalog read's: a send that has to wait for the
 * environment proxy is already a second attempt at reaching a site that is
 * probably down, and the caller queues the records again on any failure.
 *
 * @param url - the absolute URL to post to.
 * @param payload - the value to serialize as the request body.
 * @param options - `{ timeoutMs = 10_000, headers }`.
 * @returns a promise of `{ status, headers, body, via }`.
 * @throws the combined transport error when every route failed.
 */
export async function postJson(url, payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  return await exchange(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs,
    headers: { 'content-type': 'application/json', ...options.headers },
  })
}

