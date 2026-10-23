// Regression test for the environment-proxy route in lib/net.js, written BEFORE the
// fix so that it fails red against the current file and green after it.
//
// The defect: `requestViaEnvironmentProxy` builds its request with
// `createConnection: () => stream` and `agent: false`. On Node 24 the `agent: false`
// puts the request on the one-off Agent path, where the request-level
// `createConnection` is discarded in favour of the agent's own connect — so the
// tunnel that was just built to the proxy is thrown away and the request goes
// straight to the target's own address instead.
//
// Making that observable needs a target that cannot be reached directly, or both the
// tunnelled and the direct path arrive at the same origin and the test passes either
// way. `192.0.2.1` is RFC 5737 TEST-NET-1, reserved for documentation and never
// routable, so a direct connect can only fail; the fake proxy deliberately does not
// resolve it either, and tunnels to the loopback origin instead.
//
// Two traps this file is built around, because both produce a pass for the wrong
// reason. The target must not be loopback, or `isDirect()` keeps it off the proxy
// entirely and a local origin answers without the proxy ever being consulted. And
// `NODE_USE_ENV_PROXY` must not be set, or Node's own `fetch` — route 1 — would go
// through the proxy and succeed, so route 2 would never run. The `via` field is
// asserted for the same reason: `'env-proxy'` is the only value that proves the
// second route answered.
//
// The `https:` CONNECT branch is not covered, and the reason is cost rather than
// doubt: tunnelling TLS to an origin means a certificate valid for the IP literal
// `192.0.2.1`, and this package is dependency-free with no cert tooling. What is
// covered is the `http:` target branch, which `connectHttpProxy` serves as an
// absolute-URI request over a socket to the proxy rather than as a CONNECT — and
// which is the branch this plugin's own traffic takes, since the default collector
// endpoint is `http://…:8249/api/report`.
import { request as httpRequest, createServer } from 'node:http'
import { exit, env } from 'node:process'

/** The body the origin answers with, so a response can be recognised as its own. */
const ORIGIN_BODY = 'proxy-route-ok'

/** A target that can never be reached directly. RFC 5737 TEST-NET-1. */
const TARGET_HOST = '192.0.2.1'
const TARGET_PATH = '/probe'
const TARGET_URL = `http://${TARGET_HOST}${TARGET_PATH}`

/**
 * Route 1 has to fail before route 2 runs, and an unroutable address fails inside
 * this.
 *
 * Load-bearing twice over. It bounds route 1's `fetch`, which aborts on the signal;
 * and it bounds route 2 in the red state, where the failure mode is a *timeout* on a
 * direct connect to an address that black-holes rather than an immediate refusal —
 * measured at the full budget, not at a few milliseconds. So a red run takes
 * noticeably longer than a green one, roughly two of these per call instead of one,
 * and that asymmetry is itself the signature of the defect: the tunnelled path
 * answers in milliseconds, and the only reason anything here waits is that the tunnel
 * was not used.
 */
const TIMEOUT_MS = 2500

/** Every request the fake proxy was handed, in order. */
const proxySaw = []

/** Every request the origin was handed, in order. */
const originSaw = []

/**
 * The origin: what the proxy is supposed to reach on the caller's behalf.
 *
 * Answers any method with a body that names it, so a response can be told apart from
 * anything else on the loopback, and echoes the method so a POST can be proved to
 * have arrived as one.
 */
const origin = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.once('end', () => {
    originSaw.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') })
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`${ORIGIN_BODY}:${request.method}`)
  })
})
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
const originPort = origin.address().port

/**
 * The fake proxy, in the shape an HTTP proxy takes for a plain `http:` target.
 *
 * It is handed an absolute-URI request line rather than a CONNECT, because that is
 * what `connectHttpProxy` sends for a non-`https:` target: a socket to the proxy
 * itself, over which the full URL is named. It records what it saw, forwards to the
 * real origin — which is what a proxy does — and pipes the answer back. The target
 * host in the request line is never resolved, which is the whole point: the test
 * passes because the proxy was consulted, not because the address works.
 */
const proxy = createServer((request, response) => {
  proxySaw.push({ method: request.method, url: request.url })
  const asked = new URL(request.url, `http://${TARGET_HOST}`)
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: originPort,
    method: request.method,
    path: `${asked.pathname}${asked.search}`,
    // The origin's own host header, so it is not asked to serve a name it does not
    // have; a real proxy rewrites this the same way.
    headers: { ...request.headers, host: `127.0.0.1:${originPort}` },
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.once('error', () => { response.destroy() })
  request.pipe(upstream)
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

/**
 * The proxy environment this test needs, with everything that could interfere
 * removed.
 *
 * `PROXY_ENV_NAMES` is read in order and the first name that is set wins, so the
 * four ahead of `HTTP_PROXY` are cleared rather than merely left alone: a machine
 * that exports `HTTPS_PROXY` would otherwise have this test point at a proxy it did
 * not start. `NO_PROXY` is cleared because any entry matching the target would keep
 * it direct, and `NODE_USE_ENV_PROXY` is cleared because it would let route 1 answer
 * through the proxy and prove nothing about route 2.
 */
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']
const savedEnv = new Map(PROXY_ENV_NAMES.map(name => [name, env[name]]))
for (const name of PROXY_ENV_NAMES) delete env[name]
env.HTTP_PROXY = proxyUrl

const { getUrl, postJson, isDirect, proxyForTarget } = await import('../lib/net.js')

const results = []

/**
 * Record one assertion.
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside a failure, so a red run says why.
 */
function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/**
 * Run one call that is expected to resolve, and keep the failure when it does not.
 *
 * @param call - the call to make.
 * @returns a promise of `{ ok, value }` or `{ ok: false, message }`.
 */
async function attempt(call) {
  try {
    return { ok: true, value: await call() }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// --- the environment is the one the test thinks it is -----------------------
check('the target is not kept direct by the bypass rules', isDirect(TARGET_HOST) === false, String(isDirect(TARGET_HOST)))
check('the environment names the fake proxy for the target', proxyForTarget(new URL(TARGET_URL))?.href === `${proxyUrl}/`, String(proxyForTarget(new URL(TARGET_URL))?.href))
check('route 1 cannot answer through the proxy either', env.NODE_USE_ENV_PROXY === undefined, String(env.NODE_USE_ENV_PROXY))

// --- reading a URL through the environment proxy ----------------------------
proxySaw.length = 0
originSaw.length = 0
const read = await attempt(() => getUrl(TARGET_URL, { timeoutMs: TIMEOUT_MS }))
check('getUrl reached the origin through the proxy', read.ok === true, read.ok ? undefined : read.message)
check('it was route 2 that answered, not route 1', read.ok === true && read.value.via === 'env-proxy', String(read.value?.via))
check('the origin body came back', read.ok === true && read.value.body.toString('utf8') === `${ORIGIN_BODY}:GET`, String(read.value?.body?.toString('utf8')))
check('the answer was a 200', read.ok === true && read.value.status === 200, String(read.value?.status))
check('the proxy was consulted exactly once', proxySaw.length === 1, `${proxySaw.length}: ${JSON.stringify(proxySaw)}`)
check('it was consulted with an absolute-URI request line', proxySaw[0]?.url === TARGET_URL && proxySaw[0]?.method === 'GET', JSON.stringify(proxySaw[0] ?? null))
check('the proxy reached the origin exactly once', originSaw.length === 1 && originSaw[0]?.url === TARGET_PATH, JSON.stringify(originSaw))

// --- sending a JSON body through the same route ------------------------------
// `postJson` shares `exchange` with `getUrl`, and it is the call the error reports
// ride, so a proxy-only user losing the reports is the same defect wearing a
// different method and a body.
proxySaw.length = 0
originSaw.length = 0
const sent = await attempt(() => postJson(TARGET_URL, { probe: true }, { timeoutMs: TIMEOUT_MS }))
check('postJson reached the origin through the proxy', sent.ok === true, sent.ok ? undefined : sent.message)
check('it was route 2 that answered', sent.ok === true && sent.value.via === 'env-proxy', String(sent.value?.via))
check('the proxy was consulted exactly once', proxySaw.length === 1, `${proxySaw.length}: ${JSON.stringify(proxySaw)}`)
check('it arrived as a POST', originSaw.length === 1 && originSaw[0]?.method === 'POST', JSON.stringify(originSaw))
check('the body survived the proxy', originSaw[0]?.body === '{"probe":true}', String(originSaw[0]?.body))
check('the origin answered the POST', sent.ok === true && sent.value.body.toString('utf8') === `${ORIGIN_BODY}:POST`, String(sent.value?.body?.toString('utf8')))

// --- a proxy that answers badly is a result, not a transport failure -----------
// `exchange` documents a non-2xx as a result and only a transport failure as an
// error, and that distinction is the caller's to act on — a 502 from a proxy means
// the proxy was reached and said no, which is not the same fact as "nothing
// answered". Asserted here because it is the same route, and because a fix that made
// route 2 throw on a bad status would be a regression nobody else would catch.
const refusing = createServer((request, response) => {
  response.writeHead(502, { 'content-type': 'text/plain' })
  response.end('the proxy refused')
})
await new Promise(resolve => refusing.listen(0, '127.0.0.1', resolve))
const refusingPort = refusing.address().port
const savedProxy = env.HTTP_PROXY
env.HTTP_PROXY = `http://127.0.0.1:${refusingPort}`
const refused = await attempt(() => getUrl(TARGET_URL, { timeoutMs: TIMEOUT_MS }))
check('a proxy that answers 502 is a result rather than a throw', refused.ok === true, refused.ok ? undefined : refused.message)
check('the 502 is reported as the status it was', refused.ok === true && refused.value.status === 502, String(refused.value?.status))
check('the 502 still came from route 2', refused.ok === true && refused.value.via === 'env-proxy', String(refused.value?.via))
refusing.close()

// --- and a proxy nothing is listening on still fails, naming both routes -------
// Not the regression assertion — it holds red and green — but the fix must not
// swallow route 2's transport failures either, and the combined message is the only
// trace a caller gets of which routes were tried. The port is the one just closed,
// so nothing answers on it.
env.HTTP_PROXY = `http://127.0.0.1:${refusingPort}`
const unreachable = await attempt(() => getUrl(TARGET_URL, { timeoutMs: TIMEOUT_MS }))
check('a dead proxy is a transport failure, not a result', unreachable.ok === false, String(unreachable.value?.status))
check('the failure names both routes it tried', typeof unreachable.message === 'string' && unreachable.message.includes('and through the environment proxy'), unreachable.message)
env.HTTP_PROXY = savedProxy

// --- tear down ---------------------------------------------------------------
for (const [name, value] of savedEnv) {
  if (value === undefined) delete env[name]
  else env[name] = value
}
proxy.close()
origin.close()

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('\nred against the current lib/net.js is the expected state before the fix:')
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail === undefined ? '' : ` — ${result.detail}`}`)
  exit(1)
}
