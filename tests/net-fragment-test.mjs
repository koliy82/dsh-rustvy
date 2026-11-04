// Unit test for the fragmented-TLS transport in `lib/net.js`: the slicing helper, the settings
// API, the transport-state getter, and the plain↔frag auto-switch matrix.
//
// What this file deliberately does NOT test is the wire mechanism — whether a ClientHello
// really leaves in separate TCP segments. That needs a live origin and is measured by hand
// against `rustvy.xyz:443`; the mechanism is a seam (`setFragmentTransport`) precisely so it
// can be swapped without touching anything here. The seam itself is exercised below with a
// recording transport, which is what proves the mode logic reaches it at all.
//
// Everything below runs on a **fake clock**. The spec's 300-second probe is a number in the
// code, not a wait in the suite: `setTlsFragment({ now })` injects the clock and the matrix
// advances it by hand, so a test that says "the probe is due" completes in microseconds.
//
// The suite is fully hermetic. `fetch` is replaced for the duration, the proxy environment is
// cleared so the last-resort route cannot answer, and no socket is opened.
import { exit, env } from 'node:process'

/** The host the tests fragment. Only this one is ever in scope. */
const ORIGIN = 'https://rustvy.xyz/v1/models'
const ORIGIN_HOST = 'rustvy.xyz'

const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']
const savedEnv = new Map(PROXY_ENV_NAMES.map(name => [name, env[name]]))
for (const name of PROXY_ENV_NAMES) delete env[name]

const net = await import('../lib/net.js')

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

// --- the slicing helper and its boundaries ----------------------------------
// The three cases the spec names, plus two that the arithmetic makes easy to get wrong.
const sixteen = Buffer.alloc(16, 0x16)
const seventeen = Buffer.alloc(17, 0x16)

const oddSlices = net.fragmentSlices(seventeen, 16)
check('17 bytes at 16 is two pieces', oddSlices.length === 2, String(oddSlices.length))
check('and the split is 16 then 1', oddSlices[0]?.length === 16 && oddSlices[1]?.length === 1,
  JSON.stringify(oddSlices.map(piece => piece.length)))
check('and the pieces concatenate back to the input byte for byte',
  Buffer.concat(oddSlices).equals(seventeen), `${Buffer.concat(oddSlices).length} vs ${seventeen.length}`)

const exactSlices = net.fragmentSlices(sixteen, 16)
check('exactly 16 bytes at 16 is one piece, not two', exactSlices.length === 1, String(exactSlices.length))
check('and that piece is the whole buffer', exactSlices[0]?.length === 16, String(exactSlices[0]?.length))

check('an empty buffer yields no pieces at all', net.fragmentSlices(Buffer.alloc(0), 16).length === 0,
  JSON.stringify(net.fragmentSlices(Buffer.alloc(0), 16)))
check('a non-buffer yields no pieces rather than throwing', net.fragmentSlices('not a buffer', 16).length === 0)
check('a buffer shorter than the piece size yields the buffer itself',
  net.fragmentSlices(Buffer.alloc(3, 0x16), 16).length === 1)

// The real ClientHello is 1587 bytes on this platform, not the ~500 the spec assumed. The helper
// is checked against that size too, because 1587 at 16 is 100 pieces and a remainder of 3 — the
// arithmetic the mode's cost model depends on.
const hello = Buffer.alloc(1587, 0x16)
const helloSlices = net.fragmentSlices(hello, 16)
check('the measured 1587-byte ClientHello cuts into 100 pieces', helloSlices.length === 100,
  String(helloSlices.length))
check('with the last piece holding the 3-byte remainder', helloSlices[99]?.length === 3,
  String(helloSlices[99]?.length))

// --- the settings API --------------------------------------------------------
check('the default piece size is 16, which is the size that splits the SNI',
  net.getTlsFragment().fragmentBytes === 16, String(net.getTlsFragment().fragmentBytes))
check('and the default mode is off, so nothing changes until asked',
  net.getTlsFragment().mode === 'off', net.getTlsFragment().mode)

net.setTlsFragment({ mode: 'auto', host: ORIGIN_HOST })
check('an unknown mode is read as off rather than honoured',
  net.setTlsFragment({ mode: 'sideways' }).mode === 'off', net.getTlsFragment().mode)
check('a piece size above 64 falls back to 16 rather than being honoured',
  net.setTlsFragment({ mode: 'auto', fragmentBytes: 128 }).fragmentBytes === 16,
  String(net.getTlsFragment().fragmentBytes))
check('a piece size of 0 falls back too, rather than producing zero-length pieces',
  net.setTlsFragment({ mode: 'auto', fragmentBytes: 0 }).fragmentBytes === 16,
  String(net.getTlsFragment().fragmentBytes))
check('a negative delay falls back, because a negative sleep is not a delay',
  net.setTlsFragment({ mode: 'auto', delayMs: -1 }).delayMs === 3, String(net.getTlsFragment().delayMs))
check('a valid byte size and delay are honoured',
  net.setTlsFragment({ mode: 'always', fragmentBytes: 32, delayMs: 7 }).fragmentBytes === 32
  && net.getTlsFragment().delayMs === 7, JSON.stringify(net.getTlsFragment()))
check('hosts are lowercased and brackets stripped so scope matching cannot miss',
  JSON.stringify(net.setTlsFragment({ mode: 'auto', hosts: ['[Rustvy.XYZ]'] }).hosts) === JSON.stringify([ORIGIN_HOST]),
  JSON.stringify(net.getTlsFragment().hosts))

// --- the transport state getter ---------------------------------------------
net.setTlsFragment({ mode: 'off' })
check('the transport state starts at plain', net.getTransportState().mode === 'plain', net.getTransportState().mode)
const alwaysState = net.setTlsFragment({ mode: 'always' })
check('and always is in force immediately rather than after a failure',
  net.getTransportState().mode === 'frag', JSON.stringify(net.getTransportState()))
check('the state carries a timestamp so /state can say since when',
  Number.isFinite(net.getTransportState().since), String(net.getTransportState().since))
check('setTlsFragment returns the settings without the injected functions',
  alwaysState.mode === 'always' && alwaysState.log === undefined && alwaysState.now === undefined,
  JSON.stringify(Object.keys(alwaysState)))

// --- the auto-switch matrix, on a fake clock ---------------------------------
/**
 * Drive `getUrl` with a controlled plain transport and a controlled fragment transport.
 *
 * `fetch` is the plain path and `setFragmentTransport` is the fragmented one; both are replaced
 * for the duration, so the matrix is about the decision and not about the wire.
 *
 * @param options - `{ plain, frag, clock }`, where `plain` answers each call with
 *   `{ status }` or `{ error }`.
 * @returns `{ call, log, fragCalls, advance, restore }`.
 */
async function bench(options) {
  const state = { now: 1_700_000_000_000, plainCalls: 0, fragCalls: 0, log: [] }
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => {
    state.plainCalls += 1
    const answer = options.plain(state.plainCalls)
    if (answer.error !== undefined) throw new Error(answer.error)
    return new Response(Buffer.from('ok'), { status: answer.status ?? 200 })
  }
  net.setFragmentTransport(async request => {
    state.fragCalls += 1
    const answer = options.frag === undefined ? { ok: true } : options.frag(state.fragCalls)
    if (answer.ok === false) throw new Error(answer.error)
    // The mechanism is not under test here, so a rejected promise is enough to prove the route
    // was chosen. Returning a non-socket makes the request itself fail, which is fine: the
    // assertions are about the mode and about which routes were tried.
    throw new Error('probe: the fragment route was reached')
  })
  net.setTlsFragment({
    mode: 'auto',
    hosts: [ORIGIN_HOST],
    now: () => state.now,
    log: line => state.log.push(line),
  })
  return {
    state,
    /** One request, with its failure swallowed: the assertions are about the mode. */
    async call() {
      try { await net.getUrl(ORIGIN, { timeoutMs: 50 }) } catch { /* the mode is the subject */ }
      return net.getTransportState()
    },
    advance: ms => { state.now += ms },
    restore() {
      globalThis.fetch = savedFetch
      net.setFragmentTransport(undefined)
    },
  }
}

{
  // One transport failure must not flip the mode. Lead measured a `64/1` handshake that failed
  // once with ECONNRESET and succeeded on retry; with a threshold of one, that flake would
  // rewrite the transport.
  const single = await bench({ plain: () => ({ error: 'fetch failed' }) })
  await single.call()
  check('a single transport failure does not switch the mode',
    net.getTransportState().mode === 'plain', net.getTransportState().mode)
  check('and nothing was logged, because nothing changed',
    single.state.log.length === 0, JSON.stringify(single.state.log))
  single.restore()
}

{
  const streak = await bench({ plain: () => ({ error: 'fetch failed' }) })
  await streak.call()
  await streak.call()
  check('two transport failures in a row switch plain to frag',
    net.getTransportState().mode === 'frag', net.getTransportState().mode)
  check('and the switch is one log line in Russian, naming the reason',
    streak.state.log.length === 1 && /транспорт: plain → frag/u.test(streak.state.log[0]),
    JSON.stringify(streak.state.log))
  check('and the line carries the streak that caused it',
    String(streak.state.log[0]).includes('2'), String(streak.state.log[0]))
  streak.restore()
}

{
  // An HTTP answer is a working transport, whatever its status. A provider having a bad
  // afternoon must not be able to flip how the plugin reaches the network.
  for (const status of [404, 500, 502, 429]) {
    const answered = await bench({ plain: () => ({ status }) })
    await answered.call()
    await answered.call()
    check(`a ${status} answer does not flip the mode, because the transport works`,
      net.getTransportState().mode === 'plain', net.getTransportState().mode)
    answered.restore()
  }
}

{
  // A failure, then an answer, then a failure: the streak is consecutive and resets on success.
  const interleaved = await bench({ plain: n => (n === 2 ? { status: 200 } : { error: 'fetch failed' }) })
  await interleaved.call()
  await interleaved.call()
  await interleaved.call()
  check('an answer in between resets the streak, so two failures either side do not add up',
    net.getTransportState().mode === 'plain', net.getTransportState().mode)
  interleaved.restore()
}

{
  // In frag mode a request goes straight to the fragment route, and no probe happens until the
  // 300-second window has passed.
  const inFrag = await bench({ plain: () => ({ error: 'fetch failed' }) })
  await inFrag.call()
  await inFrag.call()
  check('the mode is frag after two failures', net.getTransportState().mode === 'frag',
    net.getTransportState().mode)
  const plainBefore = inFrag.state.plainCalls
  const fragBefore = inFrag.state.fragCalls
  await inFrag.call()
  check('a later request goes to the fragment route without trying plain first',
    inFrag.state.plainCalls === plainBefore && inFrag.state.fragCalls === fragBefore + 1,
    JSON.stringify({ plain: inFrag.state.plainCalls - plainBefore, frag: inFrag.state.fragCalls - fragBefore }))
  inFrag.advance(299_999)
  await inFrag.call()
  check('and no probe is attempted at 299 999 ms, because the window has not passed',
    inFrag.state.plainCalls === plainBefore, `${inFrag.state.plainCalls} vs ${plainBefore}`)
  inFrag.restore()
}

{
  // The probe itself: due at 300 s, one plain attempt, and a success returns to plain.
  const probe = await bench({ plain: n => (n <= 2 ? { error: 'fetch failed' } : { status: 200 }) })
  await probe.call()
  await probe.call()
  check('the mode is frag before the probe', net.getTransportState().mode === 'frag',
    net.getTransportState().mode)
  probe.advance(300_000)
  const before = probe.state.plainCalls
  await probe.call()
  check('a probe is attempted once the 300 s window has passed',
    probe.state.plainCalls === before + 1, `${probe.state.plainCalls} vs ${before}`)
  check('and a probe that succeeds returns the mode to plain',
    net.getTransportState().mode === 'plain', net.getTransportState().mode)
  check('and that return is one log line naming the probe',
    probe.state.log.some(line => /транспорт: frag → plain \(зонд прошёл\)/u.test(line)),
    JSON.stringify(probe.state.log))
  probe.restore()
}

{
  // A probe that fails must not return to plain, and must not double-count a streak it is
  // already inside: the mode stays frag.
  const failingProbe = await bench({ plain: () => ({ error: 'fetch failed' }) })
  await failingProbe.call()
  await failingProbe.call()
  failingProbe.advance(300_000)
  await failingProbe.call()
  check('a probe that fails leaves the mode at frag',
    net.getTransportState().mode === 'frag', net.getTransportState().mode)
  check('and it does not log a second transition, because the mode did not change',
    failingProbe.state.log.length === 1, JSON.stringify(failingProbe.state.log))
  failingProbe.restore()
}

{
  // Scope: a host outside `hosts` is never fragmented, however bad the transport gets. That is
  // the ordering discipline — the scope check runs before anything else about the route.
  const outside = await bench({ plain: () => ({ error: 'fetch failed' }) })
  try { await net.getUrl('https://api.github.com/rate_limit', { timeoutMs: 50 }) } catch { /* expected */ }
  try { await net.getUrl('https://api.github.com/rate_limit', { timeoutMs: 50 }) } catch { /* expected */ }
  check('a host outside the scope never switches the mode and is never fragmented',
    net.getTransportState().mode === 'plain' && outside.state.fragCalls === 0,
    JSON.stringify({ mode: net.getTransportState().mode, frag: outside.state.fragCalls }))
  outside.restore()
}

{
  // The regression this block exists for, and it was found by a live run rather than by this
  // suite. With the mode already at `frag` and a host outside `hosts`, the route list used to be
  // `['frag']` alone; the loop skipped that only route as out of scope, and the request fell
  // straight to the env-proxy fallback, which throws when no proxy is configured. `uptimeEndpoint`
  // is a foreign host, so error reports to the collector stopped the moment the transport
  // flipped — and `auto` flips exactly during a blocking window, so the plugin would have lost
  // the ability to report the outage at the only time the report matters.
  //
  // Asserted on the ROUTE, never on timing. Lead's own probe asserted «the foreign origin stayed
  // fast» and it passed at 1 ms, because the request had failed instantly: a latency assertion
  // is satisfied by a failure. So this checks `via`, the status, and that plain was entered.
  //
  // One bench drives both halves. Two benches would not work: `setTlsFragment` now resets the
  // transport to plain on every write, so a second bench would undo the `frag` mode the first
  // one established. That reset is correct behaviour and this is what it costs a test.
  const collector = await bench({ plain: n => (n <= 2 ? { error: 'fetch failed' } : { status: 200 }) })
  await collector.call()
  await collector.call()
  check('the mode reached frag through two in-scope transport failures',
    net.getTransportState().mode === 'frag', net.getTransportState().mode)

  // Read as a delta rather than by resetting the counters: the fake `plain` closes over
  // `state.plainCalls` to decide what to answer, so zeroing it would also rewind the script and
  // make the next call fail again. The first version of this block did exactly that and asserted
  // a route that had been chosen against an answer the fake was no longer giving.
  const plainBefore = collector.state.plainCalls
  const fragBefore = collector.state.fragCalls
  // The collector's real host and scheme, so the case is the one production hits. No env proxy
  // is in scope — the suite clears the proxy environment at the top — so a fall-through here
  // throws instead of quietly succeeding through somebody else's tunnel.
  let result
  try {
    result = await net.getUrl('http://185.75.189.247:3789/api/report', { timeoutMs: 50 })
  } catch (error) {
    result = { threw: error instanceof Error ? error.message : String(error) }
  }
  check('a foreign host in frag mode still gets a plain attempt rather than falling through',
    collector.state.plainCalls === plainBefore + 1 && collector.state.fragCalls === fragBefore,
    JSON.stringify({
      plain: collector.state.plainCalls - plainBefore,
      frag: collector.state.fragCalls - fragBefore,
      result,
    }))
  check('and it is answered by the plain route, named by `via`',
    result?.via === 'fetch', JSON.stringify(result?.via ?? result?.threw))
  check('and it is a 200, so the collector was really reached',
    result?.status === 200, String(result?.status ?? result?.threw))
  check('and the mode stays at frag, because a foreign success says nothing about rustvy',
    net.getTransportState().mode === 'frag', net.getTransportState().mode)
  collector.restore()
}

{
  // With no mechanism installed the transport must refuse rather than connect unfragmented.
  // That is the failure this whole feature exists to avoid: a mode that says frag while the
  // traffic is ordinary, and no evidence anywhere until a blocking window.
  net.setFragmentTransport(undefined)
  // Written as an async wrapper rather than `.then(onFulfilled, onRejected)` on the call, and
  // the difference is not stylistic: a removal probe that deleted the refusal guard made the
  // function throw *synchronously* instead of rejecting, so `.then` was never reached, the
  // suite died before printing its summary, and the probe reported zero failures. A test that
  // crashes instead of failing says nothing about the assertion it was protecting.
  const missing = await (async () => {
    try {
      await net.connectFragmentedTls(ORIGIN_HOST, 443, 100)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })()
  check('with no fragmenting transport installed the connect refuses rather than connecting plain',
    missing.ok === false, String(missing.message))
  check('and the refusal says why, so it is not mistaken for a network fault',
    typeof missing.message === 'string' && missing.message.includes('refusing to connect unfragmented'),
    missing.message)
}

// --- the undici-shaped connector, and the port trap --------------------------
{
  // undici 7.30.0 passes `port: ''` for a default-port connect. `Number('')` is 0, so
  // `Number(port ?? 443)` yields 0 and `net.connect(0, host)` fails EADDRNOTAVAIL against a
  // nonsense local port. The protocol decides the default instead.
  const seen = []
  net.setFragmentTransport(async request => {
    seen.push({ host: request.host, port: request.port, bytes: request.fragmentBytes })
    throw new Error('probe: recorded, not connected')
  })
  const connector = net.fragmentedConnector({ fragmentBytes: 16 })
  const dial = options => new Promise(resolve => { connector(options, () => resolve()) })
  await dial({ hostname: ORIGIN_HOST, port: '', protocol: 'https:' })
  await dial({ hostname: ORIGIN_HOST, port: '8443', protocol: 'https:' })
  await dial({ hostname: 'example.test', port: '', protocol: 'http:' })
  check('an empty-string port on https resolves to 443, not to 0',
    seen[0]?.port === 443, JSON.stringify(seen[0]))
  check('an explicit port is kept', seen[1]?.port === 8443, JSON.stringify(seen[1]))
  check('an empty-string port on http resolves to 80', seen[2]?.port === 80, JSON.stringify(seen[2]))
  check('no dial ever asked for port 0', seen.every(entry => entry.port !== 0),
    JSON.stringify(seen.map(entry => entry.port)))
  check('the connector passes the SNI host through to the transport',
    seen[0]?.host === ORIGIN_HOST, JSON.stringify(seen[0]))
  net.setFragmentTransport(undefined)
}

// --- the handshake-record guard ---------------------------------------------
{
  // Only a TLS handshake record may be fragmented. A resumed session or an early-data write
  // changes what the first buffer is, and cutting the wrong record fails in a way that reads as
  // a network problem — so the guard is a predicate the mechanism receives, not an assumption
  // about position.
  let guard
  net.setFragmentTransport(async request => {
    guard = request.handshakeRecord
    throw new Error('probe: recorded')
  })
  await net.connectFragmentedTls(ORIGIN_HOST, 443, 100).catch(() => {})
  check('the mechanism is handed a handshake-record predicate', typeof guard === 'function', typeof guard)
  if (typeof guard === 'function') {
    check('a handshake record (content type 0x16) is accepted for fragmentation',
      guard(Buffer.from([0x16, 0x03, 0x01, 0x00])) === true)
    check('an application-data record (0x17) is not', guard(Buffer.from([0x17, 0x03, 0x03, 0x00])) === false)
    check('an empty buffer is not a handshake record', guard(Buffer.alloc(0)) === false)
    check('a non-buffer is not a handshake record', guard('nope') === false)
  }
  net.setFragmentTransport(undefined)
}

// --- tear down ---------------------------------------------------------------
net.setTlsFragment({ mode: 'off' })
for (const [name, value] of savedEnv) {
  if (value === undefined) delete env[name]
  else env[name] = value
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('')
  for (const result of failed) console.log(`FAIL  ${result.label}${result.detail === undefined ? '' : `  — ${result.detail}`}`)
  exit(1)
}