/**
 * Parsing and masking of the proxy string the user types.
 *
 * The address is `login:password@host:port` and **carries no scheme**: a bare `host:port` is
 * the correct and required format, while a scheme *in the string* is a refusal that says to
 * use the mode selector. The family is chosen there, by two positions — `http` for an
 * HTTP-speaking proxy whose encryption is discovered rather than declared, `socks` for
 * SOCKS5 — so there is one source of truth for it and the field and the selector cannot
 * disagree. (An earlier revision of this paragraph said the opposite, that a bare `host:port`
 * is refused and a scheme is required. It described the module's central guarantee backwards,
 * which is worse than a stale list: a reader would have taken the strictness for the thing it
 * had been replaced by.)
 *
 * Neither pair can be inferred from the address, which is why the selector exists and why
 * nothing here guesses: HTTPS versus HTTP for a proxy is whether the connection *to the proxy*
 * is TLS, independent of credentials; SOCKS4 versus SOCKS5 is the handshake version, and a
 * passwordless SOCKS5 server still rejects a SOCKS4 greeting. SOCKS4 is therefore not
 * offered at all — `./net.js` refuses it loudly rather than speaking the wrong handshake.
 *
 * Credentials are parsed out and kept out of every string this module returns for display.
 * `maskProxySpec` is the only supported way to put a proxy into a log, an error report or a
 * spoken summary; the password never appears in it.
 *
 * @module dsh-rustvy/proxy
 */

/**
 * The two proxy families the user chooses between.
 *
 * Two positions, not four, and the reason is that the other two are not the user's to pick.
 * HTTPS versus HTTP for a proxy is whether the connection *to the proxy* is TLS-encrypted,
 * and it is discovered rather than declared — an HTTPS proxy commonly has no auth and an
 * HTTP proxy very commonly does, its credentials travelling in `Proxy-Authorization` in the
 * clear. SOCKS4 versus SOCKS5 is the handshake version: SOCKS4 has no password auth at all,
 * but a passwordless SOCKS5 server is still SOCKS5 and rejects a SOCKS4 greeting. So neither
 * pair can be inferred from anything the user types, and inferring either from the presence
 * of credentials — the rule that was proposed — is false in both halves. `socks` therefore
 * means SOCKS5, and SOCKS4 is refused loudly rather than guessed at.
 */
export const PROXY_MODES = Object.freeze(['http', 'socks'])

/** Schemes that can appear inside a proxy URL. Not something the user types any more. */
export const PROXY_SCHEMES = Object.freeze(['http', 'https', 'socks5'])

/** The longest host:port plus credentials this will accept, so a paste cannot balloon it. */
const SPEC_MAX = 512

/**
 * Normalise the mode selector.
 *
 * @param value - what the settings carry.
 * @returns `'http'` or `'socks'`; anything unrecognised falls back to `'http'`, the default,
 *   because a settings file from an older build has no mode at all and must still work.
 */
export function parseProxyMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return PROXY_MODES.includes(text) ? text : 'http'
}

/**
 * Parse one proxy address.
 *
 * The address carries no scheme: `login:password@host:port`, credentials optional. A scheme
 * in the string is a **refusal**, not something to strip, because the family is chosen by the
 * mode selector and there must be one source of truth for it — a string that said `socks5://`
 * beside a selector set to HTTP would have the field and the button disagreeing, and the
 * disagreement would be invisible until a request failed.
 *
 * @param text - what the user typed.
 * @param mode - `'http'` or `'socks'`, from `parseProxyMode`.
 * @returns `{ ok: true, mode, scheme, host, port, username, password, hasCredentials }`, or
 *   `{ ok: false, error }` naming what is wrong in Russian, for the settings page. `scheme`
 *   is derived from the mode and is what the transport needs; `http` mode resolves to
 *   plaintext until a probe discovers otherwise.
 */
export function parseProxySpec(text, mode = 'http') {
  const family = parseProxyMode(mode)
  if (typeof text !== 'string') return { ok: false, error: 'адрес прокси не строка' }
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'адрес прокси пуст' }
  if (trimmed.length > SPEC_MAX) return { ok: false, error: `адрес прокси длиннее ${SPEC_MAX} символов` }
  // Whitespace inside the address is never meaningful and almost always a copy-paste
  // artifact, so it is refused rather than stripped: stripping would accept a string the
  // user did not type and make the field disagree with what is used.
  if (/\s/u.test(trimmed)) return { ok: false, error: 'в адресе прокси есть пробел' }

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(trimmed)
  if (schemeMatch !== null) {
    return {
      ok: false,
      error: `схему «${schemeMatch[1].toLowerCase()}://» в адресе указывать не нужно — тип прокси выбирается переключателем рядом с полем, а адрес вводится как login:password@host:port`,
    }
  }

  const rest = trimmed

  // Credentials are everything before the last '@' that precedes the host, so a password
  // containing '@' still parses: `user:p@ss@host:1080` is user `user`, password `p@ss`.
  let username = ''
  let password = ''
  let authority = rest
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    const credentials = rest.slice(0, at)
    authority = rest.slice(at + 1)
    const colon = credentials.indexOf(':')
    if (colon === -1) {
      username = credentials
    } else {
      username = credentials.slice(0, colon)
      password = credentials.slice(colon + 1)
    }
    if (authority === '') return { ok: false, error: 'после «@» нет адреса' }
  }

  // An IPv6 literal is bracketed, and its port comes after the bracket. Getting this wrong
  // is how a proxy address turns into a host nobody can resolve.
  let host = authority
  let portText = ''
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close === -1) return { ok: false, error: 'в адресе прокси не закрыта скобка IPv6' }
    host = authority.slice(1, close)
    const after = authority.slice(close + 1)
    if (after !== '' && !after.startsWith(':')) return { ok: false, error: 'после адреса IPv6 ожидается «:порт»' }
    portText = after.slice(1)
  } else {
    const colon = authority.lastIndexOf(':')
    if (colon === -1) return { ok: false, error: 'не указан порт прокси' }
    host = authority.slice(0, colon)
    portText = authority.slice(colon + 1)
  }
  if (host === '') return { ok: false, error: 'не указан адрес прокси' }
  if (!/^[A-Za-z0-9._:-]+$/u.test(host)) return { ok: false, error: `адрес прокси «${host}» содержит недопустимые символы` }

  if (!/^\d+$/u.test(portText)) return { ok: false, error: `порт прокси «${portText}» не число` }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `порт прокси ${portText} вне диапазона 1–65535` }

  return {
    ok: true,
    mode: family,
    // Derived from the mode, never typed. `socks` is SOCKS5 because SOCKS4 has no password
    // auth at all while a passwordless SOCKS5 server still rejects a SOCKS4 greeting, so the
    // version cannot be inferred from anything the user writes. `http` starts as plaintext
    // and a probe may discover TLS; that result is reported separately as `transport` rather
    // than written back here, so this field never claims a measurement that was not made.
    scheme: family === 'socks' ? 'socks5' : 'http',
    host,
    port,
    username,
    password,
    // Named separately so a caller can tell "no credentials" from "empty password", which
    // are different on the wire: one omits the auth header, the other sends an empty one.
    hasCredentials: at !== -1,
  }
}

/**
 * A proxy string safe to log, report or say aloud.
 *
 * The password is replaced wholesale rather than partially revealed, because a partial
 * reveal still narrows a search and the user gets nothing from seeing it. The username is
 * kept: it is not a secret in any scheme this accepts, and without it a log line cannot
 * distinguish two proxies on one host.
 *
 * @param spec - a parsed proxy, or the raw string when parsing failed.
 * @returns the masked text.
 */
export function maskProxySpec(spec) {
  if (typeof spec === 'string') {
    // Unparsed input, which is the case that matters most: a refusal message quotes what
    // the user typed, and that text may carry a password. The scheme is stepped over
    // first, because its colon is not the credential separator — masking from it would
    // eat `http://` and print a mangled address that hides which proxy failed.
    const at = spec.lastIndexOf('@')
    if (at === -1) return spec
    const schemeMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(spec)
    const prefix = schemeMatch === null ? '' : schemeMatch[0]
    const credentials = spec.slice(prefix.length, at)
    const colon = credentials.indexOf(':')
    return colon === -1 ? spec : `${prefix}${credentials.slice(0, colon + 1)}***${spec.slice(at)}`
  }
  if (spec === null || typeof spec !== 'object' || spec.ok !== true) return '(прокси не задан)'
  const credentials = spec.hasCredentials ? `${spec.username}:***@` : ''
  return `${spec.scheme}://${credentials}${spec.host}:${spec.port}`
}

/* -------------------------------------------------------------------------- *
 * Which origins go through the proxy, and which dispatcher each one gets.
 * -------------------------------------------------------------------------- */

/**
 * Whether one origin is in scope for the proxy.
 *
 * This is the whole of the user's boundary — «только запросы rustvy, больше никуда» — as a
 * predicate. Everything downstream is mechanical, so it is kept separate and pure: a
 * decision buried inside a dispatcher factory cannot be tested from this repository,
 * because undici resolves only inside the harness (`import("undici")` gives
 * ERR_MODULE_NOT_FOUND here, and Node's internal copy is reachable only as an installed
 * dispatcher instance, never as the constructors).
 *
 * Matching is on hostname rather than substring, so `rustvy.xyz.evil.example` is out of
 * scope and so is `notrustvy.xyz`.
 *
 * @param origin - the origin to test: a URL, or a string that parses as one.
 * @param hosts - the hostnames in scope.
 * @returns whether this origin's traffic may be proxied.
 */
export function isProxiedOrigin(origin, hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return false
  let hostname = ''
  try {
    hostname = (origin instanceof URL ? origin : new URL(String(origin))).hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname === '') return false
  return hosts.some(host => typeof host === 'string' && host !== '' && host.toLowerCase() === hostname)
}

/**
 * The branch one origin takes under one proxy setting.
 *
 * Four kinds, and only three of them proxy anything:
 *
 * - `delegate` — not ours to decide. Hand the origin to whatever dispatcher was already
 *   installed, so a user's own `dsh-http-proxy-config` policy keeps working instead of
 *   being replaced. An off switch, an unparseable string and a foreign origin all return
 *   this, because in each case the honest answer is "not me".
 * - `proxy-http` — an http or https proxy, via undici's `ProxyAgent`.
 * - `socks5` — via undici's `Socks5ProxyAgent`, native in the bundled undici **8.11.2**
 *   (read from `dsh/node_modules/undici/index.js` inside the installed app.asar). Using
 *   undici's own agent is deliberate rather than convenient: it performs the handshake and
 *   the TLS itself, so the trap below cannot arise on this path.
 * - `socks4` — **refused, not implemented.** No native agent exists in undici 8.11.2
 *   (`lib/core/socks4-client.js` is absent from the bundle), and writing the handshake and the
 *   TLS-over-tunnel wrap ourselves was declined, for the reason in the next paragraph. The
 *   refusal is total rather than partial: the mode selector removes every way to ask for
 *   socks4, this function returns `delegate` for a scheme it has no transport for, and
 *   `createOriginFactory` throws for a kind with no transport. Re-derive that undici fact with
 *   one grep when the harness ships a new version; the version is named here so the decision
 *   is dated rather than assumed.
 *
 * Why the connector was declined. Kept because it is the reason for the refusal above and not
 * a description of shipped behaviour — nothing here builds a connector: undici's `connect`
 * option accepts an object **or a function** (`lib/dispatcher/client.js:201`). An object is
 * spread into `buildConnector({...tls, ...})`, so undici performs the TLS upgrade. A function
 * *replaces* the connector entirely and must return the final socket — so a custom connector
 * that returns a plain tunneled socket for an https origin hands undici an unencrypted socket
 * where it expects a negotiated one. A tunnel that TLS ignores is worse than no tunnel, and
 * the failure is silent.
 *
 * @param origin - the origin undici is about to connect to.
 * @param spec - a parsed proxy spec, or anything else when there is none.
 * @param options - `{ enabled, proxiedHosts }`.
 * @returns `{ kind }`, plus the spec when the kind proxies.
 */
export function proxyBranchFor(origin, spec, options = {}) {
  // The cheap check first, and the order is deliberate: an off switch must not depend on
  // the string parsing, or a malformed string could look like "on".
  if (options.enabled !== true) return { kind: 'delegate' }
  if (spec === null || typeof spec !== 'object' || spec.ok !== true) return { kind: 'delegate' }
  if (!isProxiedOrigin(origin, options.proxiedHosts)) return { kind: 'delegate' }
  if (spec.scheme === 'http' || spec.scheme === 'https') return { kind: 'proxy-http', spec }
  if (spec.scheme === 'socks5') return { kind: 'socks5', spec }
  return { kind: 'delegate' }
}

/**
 * Build the origin factory a global undici `Agent` is constructed with.
 *
 * The loader is injectable for one reason: undici cannot be imported from this repository,
 * so a test supplies a recorder instead and asserts *which constructor the factory asked
 * for*. That is the construction-level half of the boundary. The traffic-level half — real
 * agent, real socket, counted connections — cannot be proven here and is verified by hand
 * inside the running harness before release.
 *
 * undici caches a factory's result per origin, so a changed proxy string cannot be applied
 * by mutating anything: the caller disposes and reinstalls, and must `close()` the agents
 * this built. An agent left open after the switch goes off is a live socket pool to a
 * server the user asked us to stop using — a privacy property, not tidiness, and one that
 * reads as "the toggle works" on screen while it does not.
 *
 * @param options - `{ loadUndici, spec, enabled, proxiedHosts, delegate, fragment }`, where `fragment` is an undici-shaped `connect` that fragments the ClientHello and is used only for an in-scope **https** origin no proxy is handling.
 * @returns a promise of `{ factory, created, close }`.
 */
export async function createOriginFactory(options = {}) {
  const loadUndici = typeof options.loadUndici === 'function' ? options.loadUndici : () => import('undici')
  const undici = await loadUndici()
  const created = []
  /**
   * The dispatcher for one origin.
   *
   * Synchronous on purpose. undici's own `createPolicyDispatcher` builds an `Agent` whose
   * factory returns a dispatcher directly, so a factory that returned a promise would hand
   * undici something it does not await. Everything this needs — the module, the spec, the
   * delegate — is resolved before the factory is built, in `createOriginFactory`.
   *
   * @param origin - the origin undici wants to connect to.
   * @param connectOptions - undici's per-connection options, passed through untouched.
   * @returns the dispatcher to use.
   */
  function factory(origin, connectOptions = {}) {
    const branch = proxyBranchFor(origin, options.spec, options)
    if (branch.kind === 'delegate') {
      // Level 2 of the anti-blocking transport: our own origin, no proxy in the way, and the
      // user asked for a fragmented ClientHello. Inside the delegate branch on purpose — a
      // configured proxy is a route the user chose deliberately and it outranks fragmentation,
      // exactly as an environment proxy does. Fragmenting inside somebody else's tunnel is a
      // different question and not one this branch answers.
      //
      // **https only, and that guard is load-bearing.** `options.fragment` is an undici
      // `connect` function that performs its own TLS and returns the negotiated socket. Handing
      // it to a plaintext origin would attempt a handshake against a port that is not speaking
      // TLS. The collector is `http://<ip>:3789`, so without this check turning fragmentation on
      // would break the plugin's own error reports — and it would break them during a blocking
      // window, which is the only time the user turned it on.
      //
      // `isProxiedOrigin` is tested first because it swallows an unparseable origin and answers
      // false, which is what makes the `new URL` below safe to call.
      if (typeof options.fragment === 'function'
        && isProxiedOrigin(origin, options.proxiedHosts)
        && new URL(String(origin)).protocol === 'https:') {
        const pool = new undici.Pool(origin, { ...connectOptions, connect: options.fragment })
        created.push(pool)
        return pool
      }
      // Not ours. Whatever was installed before keeps its policy, so the two plugins
      // compose instead of one silently replacing the other.
      if (typeof options.delegate === 'function') return options.delegate(origin, connectOptions)
      // The fallback Pool is ours even though it proxies nothing, so it is tracked like
      // every other agent this factory built. It is the branch *every* foreign origin takes
      // in a deployment without the harness proxy plugin, which makes it the most-used
      // branch here — and an untracked Pool is one `close()` never sees, so every hot toggle
      // would leave a direct pool open. Not proxying is not the same as not holding sockets.
      const pool = new undici.Pool(origin, connectOptions)
      created.push(pool)
      return pool
    }
    const auth = branch.spec.hasCredentials
      ? `${encodeURIComponent(branch.spec.username)}:${encodeURIComponent(branch.spec.password)}@`
      : ''
    const uri = `${branch.spec.scheme}://${auth}${branch.spec.host}:${branch.spec.port}`
    if (branch.kind === 'proxy-http') {
      const agent = new undici.ProxyAgent({ ...connectOptions, uri })
      created.push(agent)
      return agent
    }
    if (branch.kind === 'socks5') {
      // `Socks5ProxyAgent` does NOT share `ProxyAgent`'s signature. `ProxyAgent(options)` takes
      // the uri inside an options object; `Socks5ProxyAgent(proxyUrl, options)` takes the URL as
      // its **first positional argument** (`lib/dispatcher/socks5-proxy-agent.js:31`, read from
      // the profile's undici 7.30.0). Handing it `{ uri }` makes its `typeof proxyUrl ===
      // 'string'` test false, so it reads `.protocol` off a plain object, gets `undefined`, and
      // throws «Proxy URL must use socks5:// or socks:// protocol» — a message that blames the
      // protocol while the real problem is the argument shape. Every SOCKS5 install failed in
      // about 2 ms this way, and the fake undici in both test suites accepted the wrong shape
      // and recorded a plausible uri, so the suites stayed green. Two constructors in one
      // library, two signatures; the fakes now model both.
      const agent = new undici.Socks5ProxyAgent(uri, connectOptions)
      created.push(agent)
      return agent
    }
    // Unreachable: `proxyBranchFor` returns `delegate` for any scheme it has no transport
    // for, so the only kinds that reach here are the two above. Throwing rather than falling
    // through to a connector is deliberate — a scheme this build cannot proxy must fail
    // visibly here instead of handing undici a socket built by code that does not exist.
    throw new Error(`no transport for a ${branch.kind} proxy`)
  }
  /**
   * Close every agent this factory built.
   *
   * @returns a promise that settles once all of them are closed.
   */
  async function close() {
    const agents = created.splice(0, created.length)
    await Promise.all(agents.map(agent => (typeof agent?.close === 'function'
      ? Promise.resolve(agent.close()).catch(() => {})
      : Promise.resolve())))
  }
  return { factory, created, close }
}
