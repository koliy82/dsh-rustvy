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
 * The proxy URL the environment names for one target, when it names one.
 * @param target - the parsed request URL.
 * @returns the parsed proxy URL, or `undefined` for a direct route.
 */
export function proxyForTarget(target) {
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

  const isSocks = /^socks[45]h?:$/u.test(proxy.protocol)
  const tunneled = isSocks
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
      agent: false,
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
 * Exchange one URL: the process's own route first, the environment's proxy second.
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
  let firstError
  try {
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
  } catch (error) {
    firstError = error
  }
  try {
    const result = await requestViaEnvironmentProxy(url, { ...options, timeoutMs })
    return { ...result, via: 'env-proxy' }
  } catch (error) {
    const first = firstError instanceof Error ? firstError.message : String(firstError)
    const second = error instanceof Error ? error.message : String(error)
    throw new Error(`${first} (and through the environment proxy: ${second})`)
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

