/**
 * dsh-rustvy — the infrastructure-error report.
 *
 * The question this module answers is not "did this request fail" but "is the
 * provider's side down, for how many people, and since when". A request can fail
 * for a dozen reasons, and only some of them say anything about the service: a
 * connect timeout, a DNS failure, a refused socket, a 502 from the provider's own
 * upstream — those are outages. An exhausted quota, an ended subscription, a wrong
 * API key, a rate limit, a context window that did not fit, a chat the user
 * stopped halfway — those are this user's own situation, and reporting them would
 * turn somebody's unpaid balance into a blip on a status page that other people
 * read as an outage.
 *
 * So the first job here is a *classification*: `classifyFailure` turns the harness
 * `LlmFailure` shape into `{ infra, kind, status, code, text }`, and only `infra`
 * failures are ever queued. The second job is *reduction*. A failure text arrives
 * from an adapter that has just talked to a remote service, and it can carry
 * anything — an authorization header echoed back, a key, the absolute path of the
 * file that was being read. `scrubErrorText` removes all of it and keeps at most
 * the collector's own 2000-character ceiling of what is left, because the one field
 * worth sending is also the only field that can leak.
 *
 * The third job is *volume*. One outage produces one failure per request per
 * person, and a person who is watching a dead site retry. Reports are therefore
 * folded: repeated failures of the same model and kind inside a minute become one
 * report that counts them, and a success right after failures sends that folded
 * report out immediately, so the recovery moment is visible when it happened
 * rather than at the end of a window. Successes are sent too, but aggregated: one
 * report per window per route, carrying a count per model and no durations. That is
 * what gives uptime a denominator — `ok / (ok + fails)` becomes a measured ratio
 * instead of an inference from the absence of reports, which could only ever mean
 * "nothing went wrong that we saw". Aggregating is also what keeps it affordable: a
 * machine that made 230 requests in a day sends a few dozen small documents instead
 * of 230, and a machine that did nothing sends nothing at all. The whole thing is
 * capped per
 * minute, per hour and per queue, under a collector that allows 60 reports per
 * minute per IP. What is left is a small, anonymous, honest sample, delivered
 * without a single probe request burning tokens.
 *
 * The fourth job is *not being in the way*. This runs on the path of a live agent
 * request, so nothing here may throw into a caller: every public entry point
 * swallows its own failures, the sender is injected rather than imported (so no
 * network is touched by this file at all, and the queue survives a transport that
 * is itself broken), the queue is persisted so a restart during an outage still
 * delivers the backlog with its original timestamps, and the flush timer is
 * `unref()`'d so a report never holds the process open.
 *
 * Anonymity is a design constraint, not a claim: the only identifier that leaves
 * this machine is a random UUID generated on first use and stored in
 * `install.json`, carried in `meta.id` because the collector has no top-level
 * field for it. It is what lets the monitor count *people* rather than events, and
 * deleting that file makes this install somebody else.
 *
 * @module dsh-rustvy/errors
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The plugin's own version, read once.
 *
 * A collector that cannot tell 1.0.0 from 1.1.0 cannot tell a fixed bug from a
 * new one, and asking the host for it would put a second source of truth in the
 * record. It is read here, at load, and never again.
 */
const PACKAGE_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** The wire shape this module writes; a collector refuses records it cannot read. */
export const REPORT_VERSION = 1

/**
 * How much of a failure text is kept, and how long any one string field may be.
 *
 * The text limit is the collector's own ceiling for `message` rather than a guess:
 * a longer fault description survives intact, and a report that has to be
 * truncated is truncated at the length the receiving API documents.
 */
const TEXT_LIMIT = 2_000
const FIELD_MAX = 128

/** How much of a hostile message is examined before it is cut down to size. */
const INSPECT_MAX = 4_000

/** The two windows the per-install send allowances are counted over. */
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/**
 * Failure codes that are never infrastructure.
 *
 * These are the harness's own verdicts about a request that could not be made:
 * the account ran out, the credential is wrong or missing, the context did not
 * fit, the user stopped it, or the request itself was malformed. None of them
 * says anything about whether the provider's site is up, and a monitor built on
 * them would report an outage every time somebody's subscription ended.
 */
export const NON_INFRA_CODES = Object.freeze(new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'AUTH',
  'RATE_LIMIT',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'NO_CREDENTIAL_STORE',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'ABORTED',
  'INVALID_REQUEST',
  'INVALID_CONFIG',
  'INVALID_REPLAY_STATE',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'IMAGE_OFFLOAD_REQUIRED',
  'DISCOVERY_FAILED',
  'DISCOVERY_UNSUPPORTED',
  'UNSTORABLE_PROVIDER_ID',
]))

/** The codes that *can* describe an infrastructure fault, and so get read closely. */
const INFRA_CODES = new Set([
  'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR', 'STREAM_CLOSED',
  'LLM_STREAM_IDLE_TIMEOUT', 'UNKNOWN',
])

/**
 * Upstream answers that are the user's own situation even though they arrived
 * wrapped in an `upstream_` prefix: the provider's gateway faithfully relayed an
 * authentication, billing or rate-limit verdict. Everything else with that prefix
 * — 400, 404, 408, any 5xx — is the gateway or its origin failing, which is what
 * makes `upstream_400` reportable while a bare `400` is not.
 */
const UPSTREAM_USER_STATUSES = new Set([401, 402, 403, 429])

/**
 * The success-aggregation window, in milliseconds: fifteen minutes.
 *
 * Exported on its own and not only inside {@link FOLD_LIMITS} because the host's
 * `DEFAULT_CONFIG` needs the same literal. Two homes for one default is two
 * defaults, and they drift apart the first time one of them is edited. The host
 * imports this constant and stores only a user override in its config file.
 *
 * One minute is the value the traffic budget is measured against: one report per window
 * per route per install, so a working day costs hundreds of small reports rather than one
 * per successful request. A shorter window multiplies the requests; a longer one delays
 * the percentage the monitor exists to show.
 *
 * It was fifteen minutes and the user asked for this, because the delay is what the
 * monitor is for: a percentage that lags by up to fifteen minutes is a percentage nobody
 * can act on. The cost is fifteen times the requests, and it is paid in bytes rather than
 * in risk — the collector now derives the bucket width from the document's own
 * `window: {from, to}` rather than from its config, so the two halves no longer have to
 * agree by convention.
 *
 * One minute is also what `FAILURE_WINDOW_MS` already was, so the two windows are now the
 * same width. That is a simplification rather than a coincidence: a success settling a
 * folded failure of the same model used to be able to do so up to fifteen minutes after
 * the failure window had closed on its own, and now the two boundaries move together.
 */
export const SUCCESS_WINDOW_MS = 60_000

/**
 * What one install may spend of the collector's per-minute report budget.
 *
 * Declared outside `FOLD_LIMITS` because the hourly ceiling is derived from it, and a value
 * inside a frozen literal cannot read a sibling key. It is not exported on its own: the
 * frozen object is the public surface and carries the same number.
 */
const MAX_PER_MINUTE = 20

/**
 * The folding and volume ceilings, in one place.
 *
 * Exported because three parties have to agree on them: the queue, the `/state`
 * summary the settings page draws, and a test that needs a one-second window
 * instead of a minute-long one. Every value is overridable through
 * `createReporter`'s `limits`.
 *
 * The two send ceilings sit under a limit that is not ours: the collector accepts 60
 * reports per minute per IP, and one IP is often several installs behind one NAT.
 *
 * The per-minute ceiling is a **burst** allowance, not the sustained rate, and that
 * distinction is what keeps this honest. With the shipped settings one install sustains one
 * report per minute per route, so one to three a minute in practice — comfortably inside a
 * share of sixty. Twenty is what a burst of settled failures may spend, and four installs
 * bursting behind one NAT at the same moment would exhaust the collector's sixty between
 * them. So the earlier claim that this sits "well below a single install's share" was true
 * of the sustained rate and false of the ceiling: twenty a minute sustained would be a
 * third of the whole per-IP budget for one install.
 *
 * `MAX_BATCH` — now "reports per flush", since each report is its own POST — is what one
 * tick may spend.
 */
export const FOLD_LIMITS = Object.freeze({
  FAILURE_WINDOW_MS: 60_000,
  SUCCESS_WINDOW_MS,
  FLUSH_MS: 15_000,
  MAX_QUEUE: 500,
  MAX_BATCH: 10,
  SEND_TIMEOUT_MS: 10_000,
  RETRY_MS: 15_000,
  RETRY_MAX_MS: 600_000,
  MAX_PER_MINUTE,
  // Derived rather than restated. The hourly ceiling is what the per-minute ceiling amounts
  // to if it is held for an hour, so the two cannot contradict each other — and they did:
  // the hourly cap was a separate literal of 240 while 20 a minute implies 1200, a factor of
  // five, and nothing noticed until a one-minute success window put four continuously active
  // routes at exactly 240.
  MAX_PER_HOUR: MAX_PER_MINUTE * 60,
  PERSIST_MS: 5_000,
  MINUTE_MS,
  HOUR_MS,
})

/* ------------------------------- classification ------------------------------ */

/**
 * Every pattern below is bounded: fixed-width alternations, no nested
 * quantifiers, and the text they see is already collapsed and cut to
 * {@link INSPECT_MAX}. A failure message arrives from a remote service and may be
 * crafted, and a regex that backtracks catastrophically on it would hang the very
 * request this module is supposed to observe.
 */

/** An `upstream_NNN` verdict the provider's gateway named itself. */
const UPSTREAM_PATTERN = /\bupstream[_\s-]?([1-5]\d\d)\b/iu

/**
 * A three-digit status in an HTTP-ish context.
 *
 * The context matters: `attempted address: rustvy.xyz:443, timeout: 10000ms`
 * contains two plausible-looking numbers that are a port and a duration. Only a
 * status word in front of the digits, or an HTTP reason phrase after them, counts.
 */
const HTTP_STATUS_PATTERN = new RegExp(
  '\\b(?:https?|status(?:\\s*code)?|code|answered(?:\\s+with)?|responded|returned|replied|reply|response|errored|error|failed|failure|got|with|result|upstream)\\s*(?:code)?\\s*[:=\\-]?\\s*([1-5]\\d\\d)\\b'
  + '|\\b([1-5]\\d\\d)\\s+(?:bad\\s+gateway|service\\s+unavailable|gateway\\s+time-?out|internal\\s+server\\s+error|not\\s+found|too\\s+many\\s+requests|request\\s+time-?out|bad\\s+request|payment\\s+required|unprocessable)',
  'giu',
)

/** A bare `429`, but not one that is a duration or a size: `after 429 ms` is a timeout. */
const BARE_RATE_LIMIT = /(?:^|[\s(=:])429(?![\d.])(?!\s*(?:m?s|ms|msec|milliseconds?|secs?|seconds?|mins?|minutes?|hours?|bytes?|kib|mib|tokens?|attempts?|retries?|chars?|lines?|records?|events?))/iu

/**
 * A three-digit status that leads its own clause: `502 status code (no body)`,
 * `503 (no body)`, `502: {"message":"Provider authentication failed",…}`.
 *
 * {@link HTTP_STATUS_PATTERN} needs a status word *before* the digits, so a message
 * that opens with the number parses as no status at all, and a 502 storm then lands
 * on the dashboard as `unknown` instead of `http_502`. The picture stays right about
 * *something* having broken and wrong about *what* — the degradation nobody notices
 * until they compare the monitor against the provider's own status page.
 *
 * Both guards exclude measured false positives rather than hypothetical ones. The
 * number must be preceded by the start of the message, whitespace or an opening
 * paren, so a port (`rustvy.xyz:443`), a version (`v1.404`) and a longer number
 * (`300000ms`) cannot match. And it must be followed by a colon that ends its token,
 * the word `status`, or a parenthetical opening with `no`/`empty` — so a duration
 * (`after 429 ms`), a size (`512 bytes`), a count (`502 errors`, `line 502 (see
 * log)`) and a limit (`max retries 500`) cannot either. A wider paren branch was
 * tried and rejected: it read `error at line 502 (see log)` as a status.
 */
const LEADING_STATUS_PATTERN = /(?:^|[\s(])([1-5]\d\d)\s*(?::(?=\s|$)|\b(?=\s*(?:status\b|\(\s*(?:no|empty)\b)))/iu

/**
 * Account and request faults, in the order they are tried: the first hit names
 * the kind.
 *
 * Two details make these readable at all. `\b` is an ASCII construct, so no
 * Cyrillic pattern is anchored with one — «Недостаточно средств» would never
 * match, and a provider whose users read Russian writes half of its refusals in
 * Russian. And the gap between two words is `.{0,N}` rather than `[^.]{0,N}`: a
 * model id carries dots (`gpt-6.1-sol does not exist`), and what keeps a gap
 * cheap is its bound, not the exclusion of one character.
 */
const ACCOUNT_PATTERNS = [
  ['rate_limit', /\b(?:too\s+many\s+requests|rate[\s_-]?limit(?:ed|s)?|throttl(?:ed|ing|e)|retry[\s_-]after)\b/iu],
  ['rate_limit', /\b(?:http|https|status|code|answered|responded|returned|error|upstream[_\s-])\s*(?:code)?\s*[:=\-]?\s*429\b/iu],
  ['rate_limit', BARE_RATE_LIMIT],
  ['context', /\bcontext\s*(?:window|length|size)?\s*(?:exceeded|too\s+long|limit|overflow)/iu],
  ['context', /\b(?:maximum|reduce\s+the\s+length\s+of\s+your)\s+context\b/iu],
  ['context', /(?:превышен|не\s+помещается|не\s+влез).{0,32}?контекст/iu],
  ['context', /контекст.{0,32}?(?:превышен|не\s+поместился|слишком\s+велик)/iu],
  ['context', /\b(?:too\s+many\s+tokens|token\s+limit\s+exceeded|prompt\s+is\s+too\s+long)\b/iu],
  ['auth', /\b(?:invalid|missing|expired|malformed|incorrect|wrong|absent)\b.{0,40}?\b(?:api[\s_-]?key|access[\s_-]?key|credential|token|secret|bearer)\b/iu],
  ['auth', /\b(?:api[\s_-]?key|access[\s_-]?key|credential|token|secret)\b.{0,40}?\b(?:invalid|missing|expired|malformed|incorrect|wrong|not\s+(?:set|found|provided)|absent)\b/iu],
  ['auth', /\b(?:unauthori[sz]ed|forbidden|invalid[_\s]credentials?|no[_\s]credential[_\s]store|authentication\s+failed|bad\s+credentials)\b/iu],
  ['auth', /(?:ключ|токен)[а-яё]{0,10}.{0,20}?(?:не\s*(?:найден|задан|указан|передан)|неверен|недействителен|истёк|истек)/iu],
  ['billing', /\bsubscription\b.{0,48}?\b(?:expired|ended|inactive|cancelled|canceled|lapsed|required|missing)/iu],
  ['billing', /(?:\bexpired\b|\bended\b|\binactive\b|\blapsed\b).{0,32}?\bsubscription\b/iu],
  ['billing', /подписк[а-яё]{0,10}.{0,32}?(?:истекл|истёкш|закончил|неактивн|отсутствует|не\s+оформлен|не\s+оплачена)/iu],
  ['billing', /\b(?:arrears|in\s+arrears|overdue)\b|неоплачен|задолженн/iu],
  ['billing', /\baccount\b.{0,32}?\b(?:suspended|blocked|banned|deactivated|disabled|terminated|locked)/iu],
  ['billing', /(?:\bsuspended\b|\bblocked\b|\bbanned\b|\bdeactivated\b).{0,32}?\baccount\b/iu],
  ['billing', /(?:аккаунт|учётн[а-яё]{0,10}|учетн[а-яё]{0,10}).{0,20}?(?:заблокир|приостановлен|отключен|закрыт)/iu],
  ['billing', /\b(?:billing|payment|invoice)\b|оплат|платёж|платеж|биллинг/iu],
  ['quota', /\b(?:insufficient|not\s+enough|out\s+of|exhausted|exceeded|depleted|negative)\b.{0,40}?\b(?:quota|credit|credits|balance|funds|allowance|limit)\b/iu],
  ['quota', /\b(?:quota|credit|credits|balance|funds|allowance)\b.{0,40}?\b(?:insufficient|exhausted|exceeded|depleted|empty|zero|negative|ran\s+out|used\s+up)/iu],
  ['quota', /\b(?:no\s+(?:remaining\s+)?(?:quota|credits?|balance)|ran\s+out\s+of\s+(?:quota|credits?)|out\s+of\s+credits?)\b/iu],
  ['quota', /(?:квот|лимит|баланс|кредит)[а-яё]{0,10}.{0,32}?(?:исчерпан|закончил|превышен|недостаточ|пуст|обнулен|не\s+хватает)/iu],
  ['quota', /(?:недостаточно|не\s+хватает|нет)\s+(?:средств|кредитов?|квоты|баланса|денег)/iu],
  ['model', /\b(?:unknown|unsupported|invalid|unavailable|nonexistent|non-existent|not\s+(?:found|supported|available|recognized|recognised))\b.{0,32}?\bmodel\b/iu],
  ['model', /\bmodel\b.{0,32}?\b(?:not\s+(?:found|supported|available|recognized|recognised)|does\s+not\s+exist|is\s+unsupported|is\s+unknown)\b/iu],
  ['model', /(?:модель|модели)[а-яё]{0,10}.{0,32}?(?:не\s+(?:найдена|поддерживается|существует|известна)|неизвестн)/iu],
]

/** Codes whose meaning is already one of the non-infra kinds. */
const CODE_KINDS = Object.freeze({
  QUOTA: 'quota',
  ACCOUNT_QUOTA: 'quota',
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth',
  INVALID_CREDENTIAL: 'auth',
  MISSING_CREDENTIAL: 'auth',
  NO_CREDENTIAL_STORE: 'auth',
  CONTEXT_WINDOW_EXCEEDED: 'context',
  ABORTED: 'aborted',
  UNKNOWN_MODEL: 'model',
})

/** Transport faults, in the order they are tried; the first hit names the kind. */
const TRANSPORT_PATTERNS = [
  ['dns', /\b(?:ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|name\s+(?:or\s+service\s+)?not\s+known|no\s+such\s+host)\b/iu],
  ['refused', /\b(?:ECONNREFUSED|connection\s+(?:refused|was\s+refused)|actively\s+refused|connect\s+refused)\b/iu],
  ['unreachable', /\b(?:ENETUNREACH|EHOSTUNREACH|ENETDOWN|no\s+route\s+to\s+host|network\s+is\s+unreachable|host\s+is\s+unreachable)\b/iu],
  ['tls', /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_[A-Z_]+|SSL_ERROR_[A-Z_]+|certificate|handshake|\bSSL\b|\bTLS\b|x509)\b/iu],
  // Before the generic timeout, because a connect timeout is the site not
  // answering at all, while an idle timeout is a stream that stopped mid-answer.
  ['connect_timeout', /\b(?:connect(?:ion)?\s+timeout|connect\s+timeout\s+error|ETIMEDOUT|timed?\s+out\s+(?:after\s+)?\d+\s*ms\s+(?:while\s+)?connect|timeout\s+(?:while\s+)?connect|failed\s+to\s+connect|could\s+not\s+connect|connection\s+attempt\s+failed)/iu],
  // Before the generic timeout, for the same reason the connect timeout is: an idle timeout is
  // a stream that stopped mid-answer, which is the server's conduct, while a request deadline
  // with no response is the site not answering at all. The two have different owners, and this
  // file suppresses one and sends the other, so the distinction cannot live in prose.
  ['idle_timeout', /\b(?:LLM_STREAM_IDLE_TIMEOUT|idle\s+timeout|stream\s+idle)\b/iu],
  ['timeout', /\b(?:timeout|timed?\s*out|deadline\s+exceeded|ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError)\b/iu],
  ['reset', /\b(?:ECONNRESET|EPIPE|ECONNABORTED|socket\s+hang\s+up|other\s+side\s+closed|premature\s+close|connection\s+(?:reset|closed|terminated|aborted)|stream\s+(?:closed|aborted|terminated)|terminated|aborted)\b/iu],
  ['server', /\b(?:internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+time-?out|server\s+error|upstream\s+(?:error|unavailable|connect)|origin\s+(?:server\s+)?(?:error|unreachable)|5\d\d\s+(?:bad\s+gateway|service\s+unavailable))\b/iu],
  ['transport', /\b(?:fetch\s+failed|network\s+error|network\s+socket|socket|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+|EAI_AGAIN|request\s+failed|connection\s+(?:error|failure)|transport|stream\s+error|EOF|body\s+stream)\b/iu],
]

/**
 * One integer, or a fallback: the wire carries no `null` and no `NaN`.
 * @param value - the candidate.
 * @param fallback - what to use when it is not a finite number.
 * @returns a finite integer.
 */
function toInteger(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.trunc(number)
}

/**
 * One string field, cut to the wire's length.
 * @param value - the candidate.
 * @param max - the longest acceptable result.
 * @returns the trimmed string, or `''`.
 */
function toField(value, max = FIELD_MAX) {
  if (typeof value !== 'string') return value === undefined || value === null ? '' : String(value)
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * What a collector's answer means, in one line.
 *
 * A refusal body carries the only explanation anybody will ever see for a report
 * that was dropped — `{"ok":false,"error":"need a message or code field"}` — so it
 * is kept verbatim rather than paraphrased away into a bare status. It is scrubbed
 * like any other text that arrives from outside.
 *
 * @param status - the HTTP status answered.
 * @param answer - the transport's `{ status, retryAfterMs?, error? }`.
 * @returns the sentence for `summary().lastError`.
 */
function answerText(status, answer) {
  const reason = typeof answer?.error === 'string' ? scrubErrorText(answer.error, 200) : ''
  return reason === '' ? `the collector answered ${status}` : `the collector answered ${status}: ${reason}`
}

/**
 * The first HTTP status a message states in so many words.
 *
 * Two shapes are tried, keyword-first: a status word in front of the digits
 * (`status 503`, `got 502`, `HTTP 502`), then a number leading its own clause
 * (`502 status code (no body)`, `502: {…}`). The second is tried only when the
 * first finds nothing, so every status this module parsed before still parses to
 * the same value.
 *
 * @param text - the collapsed, length-capped message.
 * @returns the status, or `0` when the message names none.
 */
function parseStatus(text) {
  HTTP_STATUS_PATTERN.lastIndex = 0
  const match = HTTP_STATUS_PATTERN.exec(text)
  const keyworded = match === null ? NaN : Number(match[1] ?? match[2])
  if (Number.isInteger(keyworded) && keyworded >= 100 && keyworded <= 599) return keyworded
  const leading = LEADING_STATUS_PATTERN.exec(text)
  const status = leading === null ? NaN : Number(leading[1])
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0
}

/**
 * The harness's own verdict, when its code already names a non-infra kind.
 *
 * This is split out from the message scan because the two carry different weight. A
 * code is a structured verdict from the layer that actually made the request; a
 * message is prose that this module reads with a regex. `INVALID_REQUEST`,
 * `INVALID_CONFIG` and the rest of the codes in {@link NON_INFRA_CODES} that have no
 * kind of their own are reported as a request fault, because that is what they are.
 *
 * @param code - the uppercased failure code.
 * @returns the kind, or `undefined` when the code names nothing non-infra.
 */
function codeKind(code) {
  if (code === 'ABORTED') return 'aborted'
  if (CODE_KINDS[code] !== undefined) return CODE_KINDS[code]
  if (NON_INFRA_CODES.has(code)) return 'request'
  return undefined
}

/**
 * Which non-infra kind the message text names, if it names one.
 *
 * Kept separate from {@link codeKind} so that an outer 5xx can be placed between the
 * two: the harness's structured verdict still outranks everything, but prose in a
 * response body does not outrank the status that body arrived with. A message that
 * happens to mention a quota while a socket was refused should not be read as the
 * user's billing problem, and neither should «authentication failed» inside a 502.
 *
 * @param text - the collapsed, length-capped message.
 * @returns the kind, or `undefined` when the text names nothing non-infra.
 */
function accountKind(text) {
  for (const [kind, pattern] of ACCOUNT_PATTERNS) {
    if (pattern.test(text)) return kind
  }
  return undefined
}

/**
 * Which transport fault a message names, if it names one.
 * @param text - the collapsed, length-capped message.
 * @returns the kind, or `undefined`.
 */
function transportKind(text) {
  for (const [kind, pattern] of TRANSPORT_PATTERNS) {
    if (pattern.test(text)) return kind
  }
  return undefined
}

/**
 * Read one harness failure and decide whose problem it is.
 *
 * The order of the decisions is the point, and it runs five deep, strongest
 * evidence first. An `upstream_NNN` verdict wins outright — the provider's gateway
 * naming what its own origin answered — including for the user-level statuses in
 * {@link UPSTREAM_USER_STATUSES}. Next is the harness's own code, a structured
 * verdict from the layer that made the request, which outranks anything this module
 * infers. Then an outer 5xx, which outranks account-flavoured *prose* because a 5xx
 * is the provider's own machinery failing whatever the body text claims. Then the
 * account short-circuit on the message text, so a quota message is never reported as
 * an outage even when it also mentions a status. Only then do the transport patterns
 * and the remaining statuses decide.
 *
 * The gap between the second and third levels is a deliberate judgement rather than
 * an oversight, and it is the one place this order could reasonably be tightened:
 * moving the 5xx check above the code check would report a failure the harness coded
 * `AUTH` as a provider outage whenever its quoted body happened to carry a 5xx. That
 * trades a missed outage for a published credential problem, which is the worse of
 * the two on a public dashboard.
 *
 * @param failure - the harness `LlmFailure`: `{ message, code, status? }`. `status`
 *   is usually absent, so it is parsed out of the message as well.
 * @returns `{ infra, kind, status, code, text }` — `infra` decides whether this is
 *   reported at all, `kind` is the vocabulary in `docs/error-report.md`, `status`
 *   is `0` when unknown, and `text` is already scrubbed.
 */
export function classifyFailure(failure) {
  // A bare string is read as the message. `LlmFailure` is an object, but a caller
  // that forwards `String(error)` instead of the failure would otherwise get an
  // empty message, and an empty message classifies as `unknown` with no status —
  // a report that says something broke and nothing about what. Widening the input
  // here costs one branch and cannot misclassify anything an object input could.
  const source = typeof failure === 'object' && failure !== null
    ? failure
    : (typeof failure === 'string' ? { message: failure } : {})
  const code = toField(typeof source.code === 'string' ? source.code.toUpperCase() : '', FIELD_MAX) || 'UNKNOWN'
  const message = typeof source.message === 'string' ? source.message : ''
  const text = scrubErrorText(message)
  // Classification reads the collapsed message rather than the scrubbed one: the
  // scrubber cuts at 300 characters and blanks opaque runs, and the words that
  // decide whose problem this is can sit past either limit. Nothing here echoes
  // the message back — the answer is a kind from a fixed vocabulary.
  const collapsed = message.replace(/\s+/gu, ' ').trim()
  const inspected = collapsed.length > INSPECT_MAX ? collapsed.slice(0, INSPECT_MAX) : collapsed

  const declared = toInteger(source.status, 0)
  let status = declared >= 100 && declared <= 599 ? declared : parseStatus(inspected)

  const upstream = UPSTREAM_PATTERN.exec(inspected)
  // Resolved up front so the four decisions below read as one ordered chain rather
  // than as nested branches. It is only meaningful when the gateway did not already
  // name the status itself.
  const verdict = upstream === null ? codeKind(code) : undefined
  let kind
  let infra
  if (upstream !== null) {
    const upstreamStatus = Number(upstream[1])
    kind = `upstream_${upstream[1]}`
    infra = !UPSTREAM_USER_STATUSES.has(upstreamStatus)
    // The gateway named the status itself, which beats a number this module
    // happened to parse out of surrounding prose.
    status = upstreamStatus
  } else if (verdict !== undefined) {
    // The harness made the request and named the fault, so its structured verdict
    // outranks both a status this module parsed out of prose and the prose itself.
    // A failure the harness calls AUTH stays the user's key even when the body it
    // quotes arrived with a 502: publishing that as a provider outage would put
    // somebody's credential problem on a public dashboard, which is the one mistake
    // this classifier must not make. The code is a verdict from the layer that made
    // the call; the status and the text are both evidence this module inferred.
    kind = verdict
    infra = false
  } else if (status >= 500) {
    // An outer 5xx is the provider's own failure by definition, and it outranks
    // whatever the *body text* says about whose fault it was. The case that made
    // this a rule rather than a preference: `502: {"message":"Provider
    // authentication failed","type":"upstream_error"}` is Rustvy's gateway failing
    // to authenticate to *its own* upstream — an outage shared by every user — while
    // an auth-shaped sentence read on its own says "somebody's key is wrong".
    // Letting the prose win meant a provider-wide outage went unreported because it
    // happened to be worded like an account problem, and the monitor showed nothing
    // while everyone was down.
    //
    // Deliberately 5xx only. A 404 or a 429 carrying account prose is still the
    // user's problem — `404: model gpt-6.1-sol does not exist` is an unknown model,
    // and `429: rate limit exceeded` is a rate limit — so those keep falling through
    // to the account short-circuit below. The line is "did the provider's own
    // machinery fail", and only a 5xx answers that.
    kind = `http_${status}`
    infra = true
  } else {
    const account = accountKind(inspected)
    if (account !== undefined) {
      kind = account
      infra = false
    } else {
      const transport = transportKind(inspected)
      const statusKind = status > 0 ? `http_${status}` : undefined
      const infraStatus = status >= 500 || status === 404 || status === 408
      if (INFRA_CODES.has(code) || transport !== undefined || infraStatus) {
        kind = statusKind !== undefined
          ? statusKind
          : (transport ?? (code === 'SERVER' ? 'server' : (INFRA_CODES.has(code) ? 'unknown' : 'transport')))
        infra = statusKind !== undefined ? infraStatus : true
      } else {
        kind = statusKind ?? transport ?? 'unknown'
        infra = false
      }
    }
  }

  return { infra, kind, status, code, text }
}

/**
 * The kinds that mean nothing on the path ever answered.
 *
 * `dns`, `refused`, `unreachable` — the name never resolved, or the peer never accepted.
 * `transport` — the generic `fetch failed` / `network error` / socket family. `connect_timeout`
 * — the connect never completed. All five are a connection failing to **open**, which on this
 * user's network is the blocked path: VPN off, TSPU in between.
 *
 * The question this set answers is **did anything ever answer**, and it took three wrong proxies
 * to get here. Duration failed, because a block is slow rather than fast — a 62-second VPN-off
 * hang walked through a gate whose proxy for «local» was «instant». Status failed, because a
 * stream that stopped mid-answer arrives with no status either, so `status === 0` suppressed
 * five `timeout` and three `reset` records that were the provider's conduct. Kind name failed,
 * because «terminated» and «Request timed out.» are both status-less and both read as timeouts
 * until the classifier separates them. What survives all three is the question the family was
 * always trying to ask, and it is now asked directly.
 *
 * `timeout` is here because a request or connect deadline with no response means the site never
 * answered. `idle_timeout` is **not** here and is matched before the generic timeout in the
 * pattern table for exactly that reason — `pi-ai stream idle timeout after 300000ms` is rustvy's
 * long-poll giving up on a stream that was open, which is server-side conduct the user insists on
 * seeing. `reset` is not here either: `terminated`, `premature close` and `socket hang up` each
 * need a connection the other side opened, so a stream existed and something answered. Both of
 * those are in {@link ANSWER_STARTED_KINDS}, which outranks even a `TRANSPORT` harness code.
 *
 * @type {Set<string>}
 */
const NEVER_ANSWERED_KINDS = new Set(['dns', 'refused', 'unreachable', 'transport', 'connect_timeout', 'timeout'])

/**
 * The kinds that prove a response began, and are therefore sent whatever the harness code says.
 *
 * `reset` covers `terminated`, `premature close` and `socket hang up` — each needs a connection
 * the other side opened. `idle_timeout` is a stream that went quiet mid-answer, which is rustvy's
 * long-poll giving up and is server-side conduct the user insists on seeing.
 *
 * @type {Set<string>}
 */
const ANSWER_STARTED_KINDS = new Set(['reset', 'idle_timeout'])

/**
 * Whether one failure belongs to the never-answered family and is suppressed from the wire.
 *
 * **The status is a guard here, not the discriminator**, and that distinction is the whole
 * point of this function. Any HTTP status proves the gateway answered, so a status-carrying
 * failure is never suppressed — that is what keeps `502: {"message":"Upstream request failed:
 * fetch failed"}` out of reach at any duration. But the absence of a status **cannot** decide on
 * its own, and an earlier version of this rule that used it as the whole test is exactly why:
 * a stream that stopped mid-answer and a connection that never opened both arrive without one.
 * Reading the status alone made a server-side `pi-ai stream idle timeout` indistinguishable from
 * a blocked path, and suppressed five `timeout` and three `reset` records that were the
 * provider's conduct rather than the client's. That sentence is here so the next reader does not
 * simplify this back into a status test.
 *
 * Duration takes no part in the decision either, and that requirement came from production: a
 * VPN-off hang at 62 457 ms walked through a gate whose proxy for «local» was «instant», because
 * a block is slow rather than fast.
 *
 * **The cost, stated because it is real and chosen knowingly.** A provider whose listener is
 * down — accepts nothing at the TCP level — produces a `refused` or `connect_timeout` and is now
 * invisible. One record cannot tell a blocked path from a provider that is not listening, and a
 * heuristic that guesses will be wrong in the direction that looks fine, so there is deliberately
 * no heuristic here. The mitigation is structural rather than clever: when the provider is
 * TCP-down, success windows stop arriving too, so the picture degrades to «no data» for that
 * model rather than to a false green.
 *
 * @param kind - the classifier's verdict, unchanged by this gate.
 * @param status - the classified status, `0` when nothing named one.
 * @param harnessCode - the harness's own verdict, which outranks prose this module infers from
 *   a message. `TRANSPORT` means no response was ever received.
 * @returns true when this failure is suppressed from the wire.
 */
function isUnansweredFailure(kind, status, harnessCode) {
  if (toInteger(status, 0) !== 0) return false
  // A stream that existed is evidence something answered, and that outranks the harness code.
  // The production `reset` «terminated» at 191 164 ms carries `TRANSPORT` and is still sent:
  // «terminated» and «premature close» both need a response that began, and an idle timeout is
  // the server going quiet mid-answer. Which of those a block caused is not knowable from one
  // record, but a connection that never opened is a different fact and this is the line.
  if (ANSWER_STARTED_KINDS.has(kind)) return false
  if (NEVER_ANSWERED_KINDS.has(kind)) return true
  // The harness's own verdict, and the most direct signal available: `TRANSPORT` means no
  // response was ever received, asserted by the layer that made the request rather than
  // inferred from the wording. It catches what the family cannot — a kind this module named
  // from prose while the sender knew nothing came back.
  //
  // `TIMEOUT` is not a route here on its own. A request deadline with no response is already
  // the `timeout` kind above, and a stream that went idle is `idle_timeout` and is sent; the
  // code alone cannot separate them, which is why the kind does.
  return typeof harnessCode === 'string' && harnessCode.toUpperCase() === 'TRANSPORT'
}

/* ---------------------------------- scrubbing -------------------------------- */

/** A `sk-`-shaped key, bounded so a long run of dashes cannot stall it. */
const SECRET_KEY = /\bsk-[A-Za-z0-9_-]{1,256}/gu
/** A `Bearer <value>` pair; the value is what must not survive. */
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{0,256}={0,2}/giu
/** A credential-bearing header, as an adapter may echo one back into a message. */
const CREDENTIAL_HEADER = /\b(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-goog-api-key|x-rustvy-key|cookie|set-cookie)\s*:\s*(?:basic\s+|bearer\s+)?\S{0,256}/giu
/** A named credential: `key=…`, `token: …`, `apikey …`. */
const NAMED_SECRET = /\b(?:api[\s_-]?key|apikey|access[\s_-]?key|secret[\s_-]?key|secret|access[\s_-]?token|refresh[\s_-]?token|id[\s_-]?token|token|authorization|credential|credentials|session[\s_-]?key|private[\s_-]?key|client[\s_-]?secret)\b(?:\s*[:=]\s*|\s+)(["']?)[A-Za-z0-9._~+/=+-]{8,256}\1/giu
/**
 * One path character: anything but whitespace and the delimiters that end a path
 * in prose. One character per alternative, so the repetition cannot fold back on
 * itself.
 */
const PATH_CHAR = '[^\\s"\'`<>()|*?]'

/**
 * One step along a path: a path character, or a space the path plainly continues
 * past.
 *
 * Windows puts spaces in directory names — `Program Files`, and this harness's own
 * `…\Programs\DeepSeek Harness\profiles\…` — and a rule that stops at the first
 * space leaks the tail as `<path> Harness\profiles\desktop`. So a space is crossed
 * only when a separator follows it within a bounded run of non-space characters,
 * which is exactly what separates `DeepSeek Harness\profiles` from prose: in
 * `failed to open C:\foo bar baz qux and then the stream ended` no separator
 * follows, the match stops at `C:\foo`, and the rest of the sentence survives.
 * Never leaking beats never over-scrubbing, and a monitor needs the shape of the
 * fault rather than the directory a profile happens to live in.
 *
 * The lookahead is capped at 60 characters, the repetition at
 * {@link PATH_STEP_MAX} steps, and each alternative consumes one or two
 * characters, so there is nothing here for a hostile message to make backtrack.
 */
const PATH_STEP = `(?:${PATH_CHAR}| (?=[^ ]{0,60}[\\\\/])${PATH_CHAR})`

/** How many steps one path match may take: generous for any real path, bounded regardless. */
const PATH_STEP_MAX = 300

/** The tail both path rules share. */
const PATH_TAIL = `(?:${PATH_STEP}){0,${PATH_STEP_MAX}}`

/**
 * A Windows absolute path, UNC included.
 *
 * The preceding character is part of the pattern and is put back by the
 * replacement: without it, the `s:/` inside `https://rustvy.xyz` reads as a drive
 * letter, and a scrubber that eats the one URL worth keeping — the provider's own
 * — is worse than one that leaves a path in place.
 */
const WINDOWS_PATH = new RegExp(
  `(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\\\/]|\\\\\\\\[A-Za-z0-9._-]+[\\\\/])${PATH_TAIL}`,
  'gu',
)

/**
 * A POSIX absolute path under one of the directories that name a person or a
 * machine.
 *
 * It gets the same space-crossing tail, for `/home/user/My Documents/…`: rarer
 * than on Windows, but a leak is a leak, and one rule for both is one rule to keep
 * bounded.
 */
const POSIX_PATH = new RegExp(
  `(^|[^A-Za-z0-9:?])\\/(?:home|Users|users|root|mnt|media|var|tmp|etc|opt|srv|data|workspace|projects|Documents|Desktop)${PATH_TAIL}`,
  'gu',
)
/** A long opaque run: a blob, a JWT, a base64 document — never anything worth keeping. */
const LONG_RUN = /[A-Za-z0-9+/=_-]{41,}/gu

/** How much raw text scrubbing will even look at. */
const SCRUB_INPUT_MAX = 4_000

/**
 * Reduce a failure text to something safe to publish.
 *
 * Every pattern is bounded and the input is cut before any of them run: the text
 * comes from a remote service through an adapter, so it is treated as hostile.
 * What is removed is anything that identifies this user or carries a secret —
 * keys, tokens, authorization headers, absolute paths, opaque blobs — and what is
 * left is the shape of the fault, which is the only part a monitor needs.
 *
 * The order is part of the design: a path is blanked before a named credential is
 * looked for, because `api_key=/home/user/.rustvy/keys.json` names a file and not
 * a secret, and the path rule is the one that says so.
 *
 * @param text - the raw message; anything but a string is read as empty.
 * @param limit - the longest result, cut on a character boundary.
 * @returns the scrubbed text, at most `limit` characters.
 */
export function scrubErrorText(text, limit = TEXT_LIMIT) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : TEXT_LIMIT
  if (typeof text !== 'string' || text === '') return ''
  const source = text.length > SCRUB_INPUT_MAX ? `${text.slice(0, SCRUB_INPUT_MAX)}…` : text
  const scrubbed = source
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(SECRET_KEY, '<key>')
    .replace(BEARER, 'Bearer <redacted>')
    .replace(CREDENTIAL_HEADER, '<header>')
    .replace(WINDOWS_PATH, '$1<path>')
    .replace(POSIX_PATH, '$1<path>')
    .replace(NAMED_SECRET, '<secret>')
    .replace(LONG_RUN, '<blob>')
  if (scrubbed.length <= cap) return scrubbed
  return `${scrubbed.slice(0, Math.max(0, cap - 1))}…`
}

/* --------------------------------- identity --------------------------------- */

/**
 * Write a file atomically.
 *
 * A copy of `lib/host.js`'s helper rather than an import of it: the host module
 * mounts services at load, and an identity that could only be written while the
 * host is mounted would not be an identity this module can rely on.
 *
 * @param file - the destination path.
 * @param data - the text to write.
 */
function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, data)
  renameSync(temporary, file)
}

/**
 * This install's anonymous identity, creating it on first use.
 *
 * The identifier is a random UUID and nothing else: no hardware id, no account
 * name, no path. It exists so the monitor can count *people* — a thousand records
 * from one install is one person retrying, a thousand records from three hundred
 * installs is an outage — and deleting `install.json` makes this install somebody
 * else, which is the whole of the user's control over it.
 *
 * @param file - the identity file, normally `<profile>\.dsh-rustvy\install.json`.
 * @returns `{ id, createdAt }`. Never throws: an unwritable directory still yields
 *   a usable in-memory identity, and the next launch tries again.
 */
export function readInstallIdentity(file) {
  const fresh = () => ({ id: randomUUID(), createdAt: new Date().toISOString() })
  if (typeof file !== 'string' || file.trim() === '') return fresh()
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof stored?.id === 'string' && stored.id !== '' && stored.id.length <= FIELD_MAX) {
      return {
        id: stored.id,
        createdAt: typeof stored.createdAt === 'string' && stored.createdAt !== '' ? stored.createdAt : new Date().toISOString(),
      }
    }
  } catch {
    // Absent, unreadable or malformed: all three mean "generate one", and a
    // malformed file is overwritten rather than preserved, because an identity
    // nobody can read is not an identity.
  }
  const identity = fresh()
  try {
    writeAtomic(file, `${JSON.stringify({ version: REPORT_VERSION, ...identity }, null, 2)}\n`)
  } catch {
    // Not writable: the reporter still works, this install just looks new every
    // launch, which undercounts people and never overcounts them.
  }
  return identity
}

/* --------------------------------- the record -------------------------------- */

/**
 * One queue record: the plugin's own durable shape for a single report.
 *
 * This is what is folded, queued and written to `errors-queue.json` — *not* what
 * goes on the wire. {@link reportPayload} maps it onto the collector's contract at
 * send time, and keeping the two apart is what lets the wire format change (as it
 * just did) without invalidating a backlog already sitting on somebody's disk, or
 * the next change without invalidating this one.
 *
 * The shape is flat and short on purpose: a collector stores a great many of these
 * and reads them back grouped by model and hour, so every field is one it can
 * index or aggregate on, and nothing is nested. `err` appears only on a failure,
 * `n` only when the record folds more than one event.
 *
 * @param input - `{ at, model, ok, status, ms, err, route, code, kind, count }`.
 * @param identity - `{ id }`, this install.
 * @returns the record, in a stable key order.
 */
export function eventRecord(input, identity) {
  const source = typeof input === 'object' && input !== null ? input : {}
  const ok = source.ok === true
  const count = Math.max(1, toInteger(source.count, 1))
  const at = toInteger(source.at, Date.now())
  const model = toField(source.model, FIELD_MAX) || 'unknown'
  return {
    v: REPORT_VERSION,
    id: toField(identity?.id, FIELD_MAX),
    t: at,
    model,
    ok,
    status: toInteger(source.status, 0),
    ms: Math.max(0, toInteger(source.ms, 0)),
    ...(ok ? {} : { err: scrubErrorText(source.err, TEXT_LIMIT) }),
    route: toField(source.route, FIELD_MAX),
    code: toField(source.code, FIELD_MAX),
    kind: toField(source.kind, FIELD_MAX),
    ...(count > 1 ? { n: count } : {}),
    // A refusal is a 4xx the provider made against the request rather than against the
    // caller. It travels on its own document kind so the collector can keep it out of the
    // percentage by construction instead of by remembering to filter it, and the flag is
    // omitted entirely for ordinary failures so their byte shape does not move.
    ...(source.refusal === true ? { refusal: true } : {}),
    ...(source.refusal === true ? { refusalCode: toField(source.refusalCode, FIELD_MAX) } : {}),
    plugin: 'dsh-rustvy',
    ver: PACKAGE_VERSION,
  }
}

/**
 * One report as `POST /api/report` accepts it: a single flat object, one POST per
 * report.
 *
 * The collector names several aliases for most of its fields — `message`/`error`/
 * `detail`, `code`/`type`/`kind`, `ts`/`timestamp`, `plugin`/`source` — and they
 * are alternatives for one stored column, not extras. This picks exactly one
 * spelling per concept and never sends two, because a server that receives both
 * gets to choose which one it keeps.
 *
 * Three of the choices are worth defending:
 *
 * `code` carries *our* kind, not the harness's code. The monitor groups by "which
 * errors fell on this model", and `upstream_502` answers that while `PI_AI_ERROR`
 * does not; the harness verdict is not lost, it moves to `meta.harnessCode`. If the
 * API author would rather have their own taxonomy in `code`, the flip is the one
 * line marked below.
 *
 * `status` is omitted when it is `0`, not sent as `0`. The contract reads "если
 * есть", and `0` is not an HTTP status — a connect timeout simply has none, while
 * `meta.ms` still carries how long it took to fail.
 *
 * `message` is never empty. An empty text with a present `code` would pass the
 * collector's own 400 rule and still be worthless to whoever reads the report, so
 * the kind stands in for it.
 *
 * @param record - one queue record from {@link eventRecord}, or restored from disk.
 * @returns the flat request body.
 */
export function reportPayload(record) {
  const source = typeof record === 'object' && record !== null ? record : {}
  const kind = toField(source.kind, FIELD_MAX) || 'unknown'
  const at = toInteger(source.t, Date.now())
  const status = toInteger(source.status, 0)
  const count = Math.max(1, toInteger(source.n, 1))
  return {
    plugin: 'dsh-rustvy',
    version: PACKAGE_VERSION,
    provider: toField(source.route, FIELD_MAX),
    // Absent for an ordinary error, which is how the collector already tells the two kinds
    // apart — a failure document has never carried `kind`, and `kind: 'ok'` marks the
    // success stream. A refusal needs its own word so it is neither counted as an outage
    // nor mistaken for a success window.
    ...(source.refusal === true ? { kind: 'refusal' } : {}),
    model: toField(source.model, FIELD_MAX) || 'unknown',
    // The one line to change if the collector wants the harness's own code here
    // instead of our kind: `toField(source.code, FIELD_MAX) || 'UNKNOWN'`.
    //
    // A refusal is the case that line was waiting for: the collector's block leads with this
    // string, so it must be the most specific identifier available — the provider's own
    // `type` — rather than the `http_400` our taxonomy derives from the status.
    code: source.refusal === true ? (toField(source.refusalCode, FIELD_MAX) || kind) : kind,
    ...(status >= 100 && status <= 599 ? { status } : {}),
    message: scrubErrorText(source.err, TEXT_LIMIT) || kind,
    ts: at,
    meta: {
      // There is no top-level field for the install uuid, and it is the only way
      // the monitor can answer "how many people saw this" — so it is the one meta
      // field that must never be dropped. The whole object stays near 150 bytes
      // against an 8 KB ceiling.
      id: toField(source.id, FIELD_MAX),
      ms: Math.max(0, toInteger(source.ms, 0)),
      ...(count > 1 ? { n: count } : {}),
      harnessCode: toField(source.code, FIELD_MAX),
      t: at,
    },
  }
}

/**
 * One aggregated success window, mapped onto the collector's contract.
 *
 * A second document shape on the same endpoint, distinguished by `kind: 'ok'`. It
 * shares the error report's envelope — `plugin`, `version`, `provider`, `meta.id` —
 * so the collector parses one wrapper and branches on `kind` rather than maintaining
 * a second ingest path.
 *
 * Field names inside the window are deliberately short (`c`, `m`, `n`) because this
 * document is sent once per window per install by every install that exists, and the
 * user asked for the traffic to be minimised. The envelope stays long-named: it is
 * read by the same code that reads an error report, and saving four bytes there
 * would cost the collector a second parser.
 *
 * Durations are not sent. `ms` is measured on the host and arrives at
 * {@link createReporter}'s `noteSuccess`, and it is dropped here on purpose: v3 asks
 * for a percentage, not a response-time chart, and every extra aggregate is bytes on
 * every install. Adding one later is a contract change, not a local edit.
 *
 * @param record - the internal window record: `{ t, to, route, c, id }`, where `c`
 *   is an array of `[model, count]` pairs.
 * @returns the document to POST.
 */
/**
 * A duration in milliseconds, or `null` when there was not a usable one.
 *
 * Strict, and deliberately so: `Number(null)` is `0`, and a zero duration beside a
 * non-zero count publishes a mean response time of 0 ms — an instant answer that
 * nobody measured. That is the same coercion that once drew 1970 on a status page,
 * arriving from the other direction.
 *
 * @param value - the candidate.
 * @returns a non-negative integer, or `null`.
 */
function nullableMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

/**
 * Fold one success into a window's per-model aggregate.
 *
 * The aggregate is `{ n, s, x, complete }`: how many succeeded, the sum of their
 * durations in milliseconds, the longest of them, and whether every sample that was
 * counted also carried a usable duration.
 *
 * `complete` is the part that matters. `s` and `x` are published only when they
 * describe exactly the `n` samples the count does, because a sum over seven samples
 * beside a count of eight understates the mean — and understating is the reassuring
 * direction, the one a reader has no way to detect. Dropping both fields costs one
 * window its duration aggregate and says so by their absence; publishing a partial sum
 * costs the collector a wrong number that looks right.
 *
 * @param counts - the window's per-model map, mutated in place.
 * @param model - the model that served the request.
 * @param ms - the measured duration, or anything at all.
 * @returns true when the sample carried a usable duration, false when it did not. The
 *   caller counts the false case; this function does not, because it has no counters.
 */
function addSuccess(counts, model, ms) {
  const duration = nullableMs(ms)
  const seen = counts.get(model)
  if (seen === undefined) {
    counts.set(model, { n: 1, s: duration ?? 0, x: duration ?? 0, complete: duration !== null })
    return duration !== null
  }
  seen.n += 1
  if (duration === null) {
    seen.complete = false
    return false
  }
  seen.s += duration
  if (duration > seen.x) seen.x = duration
  return true
}

/**
 * One `c` entry, read from either of the two shapes it exists in.
 *
 * The queue file carries `{ n, s, x }` since durations were added, and a bare count in
 * every record written before that. Both the serialiser and the restore guard read
 * entries through this function, and that is the point: when the guard had its own
 * reading, `toInteger(entry[1])` saw an object, judged the count to be zero, and
 * silently dropped every new-format window on restart. A restore that discards
 * legitimate records looks exactly like an empty backlog.
 *
 * @param entry - `[model, aggregate]`, or `[model, count]` in an older record.
 * @returns `{ model, count, sum, max }` with `sum`/`max` possibly `null`, or `null`
 *   when the entry describes nothing countable.
 */
function cEntry(entry) {
  if (!Array.isArray(entry)) return null
  const model = toField(entry[0], FIELD_MAX)
  const aggregate = typeof entry[1] === 'object' && entry[1] !== null ? entry[1] : { n: entry[1] }
  const count = toInteger(aggregate.n, 0)
  if (model === '' || !Number.isFinite(count) || count <= 0) return null
  return { model, count, sum: nullableMs(aggregate.s), max: nullableMs(aggregate.x) }
}

export function successPayload(record) {
  const source = typeof record === 'object' && record !== null ? record : {}
  const from = toInteger(source.t, Date.now())
  const to = Math.max(from, toInteger(source.to, from))
  const counts = []
  for (const entry of Array.isArray(source.c) ? source.c : []) {
    // One reading of the entry shape, shared with the restore guard, so a window cannot
    // be serialised by one rule and judged unreadable by another.
    const shaped = cEntry(entry)
    if (shaped === null) continue
    counts.push({
      m: shaped.model,
      n: shaped.count,
      // Absent, not zero, when the sum was never measured: the rule for `n` and the rule
      // for `s` are opposites, because a row with no fold counter is exactly one failure
      // while a row with no sum was never timed.
      ...(shaped.sum === null ? {} : { s: shaped.sum }),
      ...(shaped.max === null ? {} : { x: shaped.max }),
    })
  }
  return {
    plugin: 'dsh-rustvy',
    version: PACKAGE_VERSION,
    provider: toField(source.route, FIELD_MAX),
    kind: 'ok',
    window: { from, to },
    c: counts,
    meta: { id: toField(source.id, FIELD_MAX) },
  }
}

/* --------------------------------- the reporter -------------------------------- */

/**
 * A folding queue that reports infrastructure failures to the error collector.
 *
 * The sender is injected, so this module never touches the network: a queue whose
 * transport is imported cannot be tested without one, and — more to the point
 * here — cannot be reasoned about while the site it reports on is the thing that
 * is down. The host hands it `postJson`; a test hands it a counter.
 *
 * One report is one POST, and the reports go out in order, one at a time: the
 * collector counts 60 requests per minute per IP, and an install that bursts a
 * backlog in parallel is an install that spends everybody's allowance at once.
 *
 * @param deps - `{ endpoint, identity, send, store?, enabled?, now?, log?, limits? }`.
 *   `endpoint` is a string or a function of no arguments, resolved at send time so
 *   a settings edit takes effect without a remount. `send` is
 *   `(payload, { timeoutMs }) => Promise<{ status, retryAfterMs?, error? }>`, where
 *   `payload` is one {@link reportPayload} object, `retryAfterMs` is the
 *   collector's own `Retry-After` in milliseconds when it sent one, and `error` is
 *   the refusal sentence from its body — the host parses both out of the response.
 *   `store` is `{ read(): record[] | undefined, write(records): void }` and may be
 *   absent.
 * @returns `{ noteFailure, noteSuccess, flush, start, dispose, summary }`. Every
 *   method is safe after `dispose()`, and none of them throws or rejects.
 */
export function createReporter(deps = {}) {
  const source = typeof deps === 'object' && deps !== null ? deps : {}
  const identity = typeof source.identity === 'object' && source.identity !== null ? source.identity : { id: '' }
  const send = typeof source.send === 'function' ? source.send : undefined
  const store = typeof source.store?.read === 'function' && typeof source.store?.write === 'function' ? source.store : undefined
  const now = typeof source.now === 'function' ? source.now : Date.now
  const log = typeof source.log === 'function' ? source.log : () => {}
  const limits = { ...FOLD_LIMITS, ...(typeof source.limits === 'object' && source.limits !== null ? source.limits : {}) }
  const enabledOf = source.enabled
  const successEnabledOf = source.successEnabled

  /** The moment the current clock reads, without ever throwing about it. */
  const clock = () => {
    try {
      return toInteger(now(), Date.now())
    } catch {
      return Date.now()
    }
  }

  /**
   * Whether an *error* report may be put on the wire right now.
   *
   * This is a delivery gate and only that. It decides whether the queue is pumped
   * and whether a failure is turned into a record; it must never decide whether a
   * sample is counted, because under v3 the two collection settings are independent
   * and counting successes is how the monitor learns when an outage ended. A
   * reporter that stopped counting when error collection was off also stopped
   * settling folded failures, so the end of an outage was never learned while the
   * setting was off — in a feature whose whole purpose is saying whether a provider
   * recovered.
   */
  const enabled = () => {
    try {
      return typeof enabledOf === 'function' ? enabledOf() === true : enabledOf !== false
    } catch {
      return false
    }
  }

  /**
   * Whether an already-aggregated success window may be put on the wire right now.
   *
   * A second gate rather than a reuse of {@link enabled}, because the two settings
   * are independent: successes on with errors off is one of the four combinations
   * the contract requires, and a single gate cannot express it.
   *
   * This governs *delivery*, not collection. Which samples join a window is decided
   * per sample by `noteSuccess`'s `send` flag, read at attempt time by the host —
   * a reporter-level switch for that would race two attempts across a toggle. What
   * remains here is the other question: data collected while the setting was on may
   * still be sitting in the queue or on disk, and turning the setting off has to
   * stop it leaving. Without this gate a day of windows accumulated while the
   * collector was unreachable would go out after the user switched sending off,
   * which is what «Выключение останавливает отправку успехов» forbids.
   *
   * Absent, it defaults to sendable, so a host that has not wired it yet keeps the
   * behaviour the per-sample flag already provides.
   */
  const successEnabled = () => {
    try {
      return typeof successEnabledOf === 'function' ? successEnabledOf() === true : successEnabledOf !== false
    } catch {
      return false
    }
  }

  /** The endpoint to post to, resolved at send time. */
  const endpointOf = () => {
    try {
      const value = typeof source.endpoint === 'function' ? source.endpoint() : source.endpoint
      return typeof value === 'string' ? value.trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * Announce a condition once, until it is retracted.
   *
   * @param key - the condition's name; a second announcement is swallowed.
   * @param message - what to say, in English, for the harness log.
   * @param error - the error behind it, when there is one.
   * @returns nothing.
   */
  const announce = (key, message, error) => {
    if (announced.has(key)) return
    announced.add(key)
    try {
      log(message, error)
    } catch {
      // A logger that throws is the host's problem, and it must not become one
      // for the request this reporter is observing.
    }
  }

  /**
   * Let a condition be announced again, now that it has cleared.
   * @param key - the condition's name.
   * @returns nothing.
   */
  const retract = key => { announced.delete(key) }

  /** The records waiting to be sent, oldest first. */
  const queue = []
  /** `model|kind` → the failure record still inside its folding window. */
  const folded = new Map()
  /**
   * Route → the success window still open for it.
   *
   * Keyed by route rather than holding one window for the whole install, because a
   * window report names exactly one `provider`. An install using a key ring across
   * three routes would otherwise send one document whose `provider` field could only
   * be one of the three, or a merge of them that the collector cannot unmerge. The
   * cost is one report per route per window instead of one per window; it is still
   * bounded by windows and never by requests, which is the thing the user objected
   * to.
   */
  const successWindows = new Map()

  /**
   * One success window as a queue record.
   *
   * Built in one place because both the settling path and the persistence snapshot
   * need the same shape, and two builders would eventually disagree about a field.
   *
   * @param route - the route the window belongs to.
   * @param open - `{ from, counts, expiresAt }`.
   * @returns the record.
   */
  function successRecord(route, open) {
    return {
      v: REPORT_VERSION,
      // Marks a success window rather than a failure. `ok` alone would not do: a
      // failure record carries `ok: false`, but nothing else in the queue is `ok:
      // true`, and a marker that depends on an absence is one refactor away from
      // routing an error report through the success serialiser.
      w: true,
      t: open.from,
      to: open.expiresAt,
      route,
      // The aggregate is flattened here rather than in {@link successPayload}, because
      // what is persisted is what will be sent, and a record on disk that carried the
      // internal `complete` flag would be a fourth shape for the serialiser to know.
      c: [...open.counts].map(([model, aggregate]) => [
        model,
        aggregate.complete ? { n: aggregate.n, s: aggregate.s, x: aggregate.x } : { n: aggregate.n },
      ]),
      id: toField(identity.id, FIELD_MAX),
    }
  }

  /**
   * What belongs on disk: the queued error reports and the failure windows still
   * folding.
   *
   * A failure window that has not closed is still a report this install owes the
   * collector, and a restart that dropped it would lose the outage it describes.
   *
   * Success windows are absent from here by decision, both the queued ones and the ones
   * still open. The disk queue exists for errors, because an error needs durability and a
   * fifteen-minute aggregate does not: losing one shifts a daily percentage by a fraction
   * and the next window restores the picture, while losing an error report loses the only
   * record that an outage happened. Persisting them would also reintroduce the eviction
   * they were removed to prevent, since a full queue drops its oldest record to make room
   * for the newest.
   *
   * @returns the records, copies, queue first.
   */
  const snapshot = () => [
    ...queue.filter(record => record?.w !== true).map(record => ({ ...record })),
    ...[...folded.values()].map(entry => ({ ...entry.record })),
  ]

  const counters = {
    sent: 0, failed: 0, dropped: 0, folded: 0, attempts: 0, failures: 0, successes: 0,
    // Success traffic is counted separately because the user's constraint was
    // volume: the settings page has to be able to answer "what does this cost me"
    // with a measurement of this install rather than with the contract's estimate.
    // Both accumulate at the serialisation point, where the size is already known.
    successWindows: 0, successBytes: 0,
    // How often a success arrived with no usable duration, and how many windows that
    // cost their aggregate. §2.1 withholds `s` and `x` rather than publish a partial
    // sum, which is correct and cheap while such samples are rare — and quietly turns
    // the feature into mostly dashes if they are not. The size of that is not knowable
    // from the code, so it is counted here, off the wire, rather than guessed.
    //
    // Counted by the completeness path rather than by the `ms` value, so this stays
    // independent of the host's call shape. The consequence is that it reads zero on a
    // host that still reports an unattributed success as `ms: 0`: blind until that is
    // fixed, never wrong.
    successesWithoutDuration: 0, successWindowsWithoutDuration: 0,
    // Windows that were formed and did not leave. Named for what it is rather than what
    // was sent, and counted in windows rather than samples so that it sits beside
    // `successWindows` in the same unit: one is what left, this is what did not.
    successWindowsLost: 0,
    // Failures this machine's own network caused, counted here and not sent. The user's
    // decision, and the counter is the part that makes it survivable: without it a real
    // provider failure that happens to fail instantly would vanish with no record, no
    // number and no log line. That is the same form of loss already refused for success
    // windows, and worse here, because what disappears is an event rather than an
    // aggregate.
    suppressedNetworkErrors: 0,
  }
  const byKind = new Map()
  /**
   * The conditions already announced to `log`.
   *
   * A reporter runs on the path of every failed model request, and an outage
   * produces one failure per retry per person: logging each of them would flood
   * the harness log through a listener nobody can turn off. So a condition is
   * announced once, and announced again only after it has cleared — a state
   * change, not a count.
   */
  const announced = new Set()
  let lastSentAt = null
  let lastStatus = null
  let lastError = null
  let retryAt = 0
  let retryDelay = limits.RETRY_MS
  let inFlight = false
  /** The two rolling send-allowance windows, counted in reports rather than bytes. */
  let minute = { startedAt: clock(), count: 0 }
  let hour = { startedAt: clock(), count: 0 }
  let persistedAt = 0
  let timer = null
  let disposed = false
  /**
   * The collector's own sentence, once it has permanently refused a success document.
   *
   * Deliberately process state and never persisted: the refusal is a property of the
   * collector version this process is talking to, so a restart — which is also a
   * plugin or collector upgrade — has to be allowed to try again. Persisting it would
   * turn "this server does not understand this shape" into "this install never sends
   * successes again", which survives the fix it was describing.
   */
  let successRefused = null

  /**
   * Put one record at the end of the queue, making room at the front.
   * @param record - the record.
   */
  function enqueue(record) {
    if (queue.length >= limits.MAX_QUEUE) {
      // An error report is never evicted to make room for a success window. The window is
      // the disposable kind — it is not persisted and would be dropped on the next failed
      // send anyway — so when the queue is full the window is what goes, and it goes
      // counted. Without this the change that removed success windows from disk would
      // still have let one push an error report out of memory, which is the same trade
      // the user rejected, one layer up.
      if (record?.w === true) {
        counters.successWindowsLost += 1
        announce('overflow', `the report queue is full at ${limits.MAX_QUEUE} records; the success window is dropped rather than evicting an error report`, undefined)
        return
      }
      queue.shift()
      counters.dropped += 1
      announce('overflow', `the report queue reached ${limits.MAX_QUEUE} records; the oldest are being dropped`, undefined)
    }
    queue.push(record)
  }

  /**
   * Emit one folded failure window as a record of its own.
   * @param key - the `model|kind` key.
   */
  function settleFailure(key) {
    const entry = folded.get(key)
    if (entry === undefined) return
    folded.delete(key)
    enqueue({ ...entry.record })
  }

  /**
   * Close one open success window and queue what it counted.
   *
   * An empty window queues nothing at all. A user who did not work during a window
   * pays for no report, which is the whole point of aggregating rather than
   * streaming: the cost of watching an idle machine is zero bytes.
   *
   * The emptiness is guaranteed upstream rather than here — {@link countSuccess} is
   * the only thing that opens a window and it always counts into it, so an idle route
   * has no window to settle. The guard below is defence against a future caller that
   * opens one differently; the path an empty document can actually take today is a
   * restored backlog, and {@link restore} is where that is refused.
   *
   * @param route - the window's key.
   */
  function settleSuccess(route) {
    const open = successWindows.get(route)
    if (open === undefined) return
    successWindows.delete(route)
    if (open.counts.size === 0) return
    // The collector has already said it cannot store this document shape, and that
    // answer does not change within a process. Queueing another one would fill the
    // queue and the disk with records that cannot leave and would eventually push out
    // error reports that can — so the window is closed and discarded instead. It is
    // deliberately *not* counted as dropped: a counter climbing 96 times a day is the
    // silent failure this exists to prevent, and the single log line written at
    // refusal time is the record that it happened.
    if (successRefused !== null) return
    // Counted at settle and only for windows that actually go out. A window discarded
    // because the collector refused the shape never reaches anybody, so counting it
    // would inflate the very number that sizes a rendering problem. "At least one model
    // withheld" is the honest reading: a window may carry several models and lose only
    // one of their aggregates.
    if ([...open.counts.values()].some(aggregate => aggregate.complete !== true)) {
      counters.successWindowsWithoutDuration += 1
    }
    const record = successRecord(route, open)
    // Not deliverable, so not kept — there is nowhere to keep it any more. Counted as
    // lost rather than merely skipped, because the alternative is a percentage with a hole
    // in it that nothing reports. The refusal case returned above and is deliberately not
    // counted here: it has its own single log line, and counting it would make this
    // counter climb once per window for the rest of the process, which is the climbing
    // counter the refusal latch exists to avoid.
    if (!sendable(record)) {
      counters.successWindowsLost += 1
      return
    }
    enqueue(record)
  }

  /**
   * Count one success into the window open for its route, opening one if needed.
   *
   * A sample that arrives after its window expired closes that window first rather
   * than joining it, so a count is never attributed to an interval it did not happen
   * in — the same reason {@link sweep} runs before a failure opens its own window.
   *
   * A sample whose timestamp is *earlier* than the open window is counted into it
   * rather than reopening one. Clocks go backwards on NTP corrections and on a
   * resumed VM, and treating that as a new window would emit a short report per
   * jump — more traffic for less information, in a feature whose budget is the
   * constraint the user set.
   *
   * @param model - the model that answered.
   * @param route - the route that served it.
   * @param at - the clock reading for the sample.
   */
  function countSuccess(model, route, at, ms) {
    const open = successWindows.get(route)
    if (open !== undefined && at < open.expiresAt) {
      if (addSuccess(open.counts, model, ms) === false) counters.successesWithoutDuration += 1
      return
    }
    if (open !== undefined) settleSuccess(route)
    const counts = new Map()
    if (addSuccess(counts, model, ms) === false) counters.successesWithoutDuration += 1
    successWindows.set(route, { from: at, counts, expiresAt: at + limits.SUCCESS_WINDOW_MS })
  }

  /**
   * Close every window whose time has come, of both kinds.
   *
   * Failures fold by `model|kind` and successes by route; both are windows, and a
   * tick that closed only one kind would leave the other aggregating into an
   * interval that ended minutes ago.
   *
   * @param at - the clock reading to compare against.
   */
  function sweep(at) {
    for (const key of [...folded.keys()]) {
      const entry = folded.get(key)
      if (entry !== undefined && entry.expiresAt <= at) settleFailure(key)
    }
    for (const route of [...successWindows.keys()]) {
      const open = successWindows.get(route)
      if (open !== undefined && open.expiresAt <= at) settleSuccess(route)
    }
  }

  /**
   * Close every open window of both kinds, whatever its age.
   *
   * Each record goes out exactly as it stands, with the count it has folded so
   * far, and the maps are emptied as they are read, so no record is enqueued twice
   * and nothing is left half-folded behind it.
   *
   * @returns nothing.
   */
  function settleAll() {
    for (const key of [...folded.keys()]) settleFailure(key)
    for (const route of [...successWindows.keys()]) settleSuccess(route)
  }

  /**
   * Write the backlog out, at most once per `PERSIST_MS`.
   *
   * The point is a restart during an outage: the records that could not be
   * delivered while the site was down are still on disk afterwards, with the
   * timestamps they were created at, so the monitor's picture of the outage does
   * not depend on this process staying alive through it.
   *
   * @param at - the clock reading.
   * @param force - true to ignore the interval, as `dispose()` does.
   */
  function persist(at, force = false) {
    if (store === undefined) return
    if (!force && at - persistedAt < limits.PERSIST_MS) return
    persistedAt = at
    try {
      store.write(snapshot())
      retract('store-write')
    } catch (error) {
      announce('store-write', 'the report backlog could not be persisted', error)
    }
  }

  /**
   * Take the backlog from the store, once.
   *
   * Anything unusable is dropped rather than repaired: a truncated or foreign
   * queue file costs a few undelivered records and must never cost a launch.
   */
  function restore() {
    if (store === undefined) return
    let stored
    try {
      stored = store.read()
    } catch (error) {
      announce('store-read', 'the persisted report backlog could not be read', error)
      return
    }
    if (!Array.isArray(stored)) return
    for (const record of stored) {
      if (typeof record !== 'object' || record === null) continue
      if (!Number.isFinite(record.t)) continue
      // A success window found here was written by a version that persisted them. They
      // are not persisted any more, so it is discarded rather than delivered: honouring
      // the current rule means not treating it as backlog, and by now it may be days old.
      // Counted, because a window that vanishes silently leaves a hole in a percentage
      // that nothing reports. This replaces a guard against an empty window coming back
      // from a truncated or foreign file, which is no longer reachable: nothing writes
      // success windows to disk, and `countSuccess` could not produce an empty one.
      if (record.w === true) {
        counters.successWindowsLost += 1
        continue
      }
      enqueue({ ...record, id: toField(identity.id, FIELD_MAX), v: REPORT_VERSION })
    }
  }

  /**
   * Postpone the next attempt, doubling the wait up to the ceiling.
   *
   * A collector that says when to come back is obeyed: `floorMs` raises the wait
   * to at least that long, which is where a `Retry-After` answer lands. It is
   * still clamped to our own ceiling, because a bogus or hostile header must not
   * be able to stall reporting for days — and a 429 loses nothing by retrying
   * slightly early, since the record stays queued either way.
   *
   * Reaching the ceiling is itself worth one line in the harness log: from that
   * point on an outage looks quiet, and a reader who does not know why would
   * conclude the reporter stopped working.
   *
   * @param at - the clock reading.
   * @param floorMs - the shortest acceptable wait, from the collector's own answer.
   */
  function postpone(at, floorMs = 0) {
    retryAt = at + Math.min(limits.RETRY_MAX_MS, Math.max(retryDelay, Math.max(0, floorMs)))
    retryDelay = Math.min(limits.RETRY_MAX_MS, retryDelay * 2)
    if (retryDelay >= limits.RETRY_MAX_MS) {
      announce('backoff-max', `report delivery has backed off to its ceiling of ${limits.RETRY_MAX_MS} ms`, undefined)
    }
  }

  /**
   * Send what can be sent now: one report per POST, in order, stopping at the
   * first answer that is not an acceptance.
   *
   * Sequential rather than parallel because the collector counts 60 reports per
   * minute per IP, and a burst of parallel POSTs is exactly what earns a 429 which
   * every other install behind the same NAT then has to wait out. One send is in
   * flight at a time, so a timer that fires during a slow answer cannot hand the
   * collector a second report.
   *
   * The answers divide three ways, and the division is the point. A 2xx accepts
   * one report and clears the backoff. A 429 or a 5xx keeps the report queued and
   * backs off: the collector is busy or its storage is down, which says nothing
   * about the report, and treating a 429 as a refusal would throw away good
   * reports whenever the collector is busy. Any other 4xx — `400` in practice —
   * means this record itself is unusable and will be refused again, so it is
   * dropped and counted, and the collector's own `error` sentence is kept, because
   * it is the only explanation anybody will ever see for that report.
   *
   * @param force - true to ignore the backoff, as an explicit `flush()` does.
   * @returns a promise that always resolves.
   */
  /**
   * Whether one queued record may go out right now.
   *
   * Per record rather than per reporter, because the two collection settings are
   * independent and a single reporter-level gate cannot express "successes on,
   * errors off". Each kind keeps the gate that already applied to it: an error
   * report waits for {@link enabled}, a success window for {@link successEnabled}.
   *
   * A success window additionally waits for the collector not to have refused the
   * document shape. That refusal is permanent for the collector's version, so
   * retrying it every window would spend the rest of the process producing dropped
   * reports and a climbing counter instead of one line in the log.
   *
   * @param record - one queue record.
   * @returns true when this record may be sent on this tick.
   */
  function sendable(record) {
    if (record?.w !== true) return enabled()
    return successRefused === null && successEnabled()
  }

  /**
   * The document for one queued record, in the shape its own kind requires.
   * @param record - one queue record.
   * @returns the payload to POST.
   */
  function payloadOf(record) {
    return record?.w === true ? successPayload(record) : reportPayload(record)
  }

  /**
   * UTF-8 byte length of a serialised document, without ever throwing about it.
   *
   * Measured rather than estimated because the number is published on the settings
   * page as what this install actually costs, and an estimate there would be
   * indistinguishable from a measurement.
   *
   * @param text - the JSON body.
   * @returns the byte count, or `0` when it cannot be measured.
   */
  function byteLength(text) {
    try {
      if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') return Buffer.byteLength(text, 'utf8')
      return new TextEncoder().encode(text).length
    } catch {
      return 0
    }
  }

  async function pump(force = false) {
    // A reporter switched off in settings stops sending at once; what is already
    // queued stays queued, so switching it back on does not lose the backlog. That
    // is still true, but it is now a property of each record rather than of the
    // reporter, so the gate moved into the loop as `sendable` — an early return here
    // would stop success windows from leaving on a machine whose error collection is
    // off, which is one of the four combinations the contract requires.
    if (inFlight || queue.length === 0) return
    if (!force && retryAt > clock()) return
    inFlight = true
    try {
      const endpoint = endpointOf()
      if (endpoint === '') {
        announce('no-endpoint', 'no report endpoint is configured; the records stay queued', undefined)
        return
      }
      retract('no-endpoint')
      if (send === undefined) {
        announce('no-transport', 'no transport was given to the reporter; the records stay queued', undefined)
        return
      }
      retract('no-transport')

      for (let posted = 0; posted < limits.MAX_BATCH && queue.length > 0; posted += 1) {
        // The first record whose own gate is open, not simply the oldest: an error
        // backlog at the head of the queue must not block a success window behind it
        // on a machine whose error collection is off. Always taking the first
        // sendable one preserves the order within each kind, which is what the
        // collector's picture of an outage depends on.
        const index = queue.findIndex(sendable)
        if (index < 0) return
        const record = queue[index]
        // Read the clock per report rather than once per pump: ten sequential
        // POSTs, each allowed ten seconds, can outlast the minute they started in.
        const at = clock()
        if (at - minute.startedAt >= limits.MINUTE_MS) minute = { startedAt: at, count: 0 }
        if (at - hour.startedAt >= limits.HOUR_MS) hour = { startedAt: at, count: 0 }
        if (minute.count >= limits.MAX_PER_MINUTE) {
          // Spent, not lost: the minute turns over in under a minute and the next
          // tick carries on with the same reports and their original timestamps.
          //
          // The pause is also published where the settings page already looks.
          // Without this, `nextFlushAt` would promise a flush in 15 s that can only
          // come back and find the same ceiling, and a caller watching `queued`
          // rise with neither `failed` nor `dropped` moving would have no way to
          // tell self-throttling from a stalled transport.
          retryAt = Math.max(retryAt, minute.startedAt + limits.MINUTE_MS)
          announce('throttled', `the per-minute report allowance of ${limits.MAX_PER_MINUTE} is spent; the rest waits for the next minute`, undefined)
          return
        }
        if (hour.count >= limits.MAX_PER_HOUR) {
          // The hour's allowance is the hard ceiling on what one install may send, and what
          // it stops is *sending*, not keeping. Clearing the queue here discarded the error
          // reports as well — the durable half, and the reason the queue exists — which turned
          // a throttle into data loss. They now wait for the hour to turn over, which is
          // precisely what their durability buys.
          //
          // The disposable half is still dropped rather than held, because there is nowhere to
          // hold it: success windows are not persisted, so holding one for an hour would only
          // lose it at the next restart. Counted in both places — dropped, because it was, and
          // lost as a window, because the loss counter is what a user reads to learn that the
          // percentage is missing data.
          const windows = queue.filter(record => record?.w === true).length
          if (windows > 0) {
            counters.dropped += windows
            counters.successWindowsLost += windows
            for (let cursor = queue.length - 1; cursor >= 0; cursor -= 1) {
              if (queue[cursor]?.w === true) queue.splice(cursor, 1)
            }
          }
          // The count is not in the message on purpose: this announces once per condition, so
          // a number here would be the figure at the first announcement and would sit in the
          // log looking current as the queue grew behind it.
          announce('allowance', 'the hourly report allowance is spent; sending stops until the next hour and the queue is kept', undefined)
          return
        }

        const payload = payloadOf(record)
        // Serialised here rather than left to the transport, so the byte counter
        // records the size of what actually left this machine. `JSON.stringify` is
        // deterministic for one object, so the transport's own serialisation of the
        // same payload is the same length.
        const body = JSON.stringify(payload)

        let answer
        try {
          answer = await send(payload, { timeoutMs: limits.SEND_TIMEOUT_MS })
        } catch (error) {
          counters.failed += 1
          // A success window is not retained for retry: it is dropped and counted, while
          // an error report stays queued exactly as before. A collector that is briefly
          // unreachable therefore costs up to fifteen minutes of uptime denominator
          // instead of delaying it — the trade the user accepted. The denominator stays
          // honest either way, because this removes data rather than inventing any.
          const lost = record.w === true
          if (lost) {
            queue.splice(index, 1)
            counters.successWindowsLost += 1
          }
          lastError = scrubErrorText(error instanceof Error ? error.message : String(error), 200)
          postpone(clock())
          announce('send-failed', lost
            ? 'a success window could not be delivered; it is dropped rather than retried'
            : 'a report could not be delivered; it stays queued and the next attempt is postponed', error)
          return
        }
        const status = toInteger(answer?.status, 0)
        lastStatus = status
        // A request that was refused still counted against the collector's own
        // per-minute limit, so it counts against ours too.
        minute.count += 1
        hour.count += 1

        if (status >= 200 && status < 300) {
          queue.splice(index, 1)
          counters.sent += 1
          if (record.w === true) {
            counters.successWindows += 1
            counters.successBytes += byteLength(body)
          }
          lastSentAt = clock()
          lastError = null
          retryAt = 0
          retryDelay = limits.RETRY_MS
          // Delivery works again, so the next failure is a state change worth one
          // more line — and the ceilings that were reached no longer hold.
          retract('send-failed')
          retract('backoff-max')
          retract('overflow')
          retract('allowance')
          retract('throttled')
          retract('refused')
          continue
        }

        if (status === 429 || status >= 500) {
          counters.failed += 1
          // Same rule as a transport failure: a window is disposable, an error report is
          // not. A 429 is the collector being busy, which for an error report is worth
          // waiting out and for a fifteen-minute aggregate is not.
          const lostWindow = record.w === true
          if (lostWindow) {
            queue.splice(index, 1)
            counters.successWindowsLost += 1
          }
          lastError = answerText(status, answer)
          postpone(clock(), toInteger(answer?.retryAfterMs, 0))
          announce('send-failed', lostWindow
            ? `the collector answered ${status}; the success window is dropped rather than retried`
            : `the collector answered ${status}; the report stays queued and the next attempt is postponed`, undefined)
          return
        }

        queue.splice(index, 1)
        counters.dropped += 1
        lastError = answerText(status, answer)
        if (record.w === true) {
          // A 4xx other than 429 on a success document is not a verdict on this
          // record, it is a verdict on the document kind: this collector has never
          // seen `kind: 'ok'` and will not learn within its own version. A 429 or a
          // 5xx never reaches this branch, so only the permanent case does. Error
          // reports keep their previous behaviour exactly — a 400 there really is
          // about one record, and dropping just that one is correct.
          successRefused = lastError
          announce('success-refused',
            `the collector refused a success report (${lastError}); it does not understand this document shape, so no further success windows are sent until this plugin restarts — error reporting is unaffected`,
            undefined)
          continue
        }
        // The collector's own sentence goes in the log line too: this is the only
        // moment anybody learns why a report was thrown away, and the announce-once
        // rule means it is said exactly once rather than once per dropped report.
        announce('refused', `${lastError}; the report is dropped rather than retried`, undefined)
      }
    } catch (error) {
      counters.failed += 1
      lastError = scrubErrorText(error instanceof Error ? error.message : String(error), 200)
      postpone(clock())
      announce('send-failed', 'report delivery failed; the queue is left as it is and the next attempt is postponed', error)
    } finally {
      inFlight = false
    }
  }

  /**
   * One failure, folded into the window that is already open for it.
   *
   * @param input - `{ model, route, status, ms, err, code, kind, at }`, where
   *   `kind`, `status` and `code` come from {@link classifyFailure} and `err` is
   *   the already-scrubbed `text`.
   * @returns nothing; a disabled or disposed reporter simply does not count it.
   */
  function noteFailure(input = {}) {
    if (disposed || !enabled()) return
    try {
      const note = typeof input === 'object' && input !== null ? input : {}
      counters.attempts += 1
      counters.failures += 1
      const model = toField(note.model, FIELD_MAX) || 'unknown'
      const kind = toField(note.kind, FIELD_MAX) || 'unknown'
      const at = clock()
      // Settle whatever has already expired before opening a window: an idle
      // reporter whose timer has not fired yet would otherwise keep folding into
      // a window that closed minutes ago, and the record it describes would carry
      // the timestamp of the first failure in a much longer stretch.
      sweep(at)
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
      // Suppression is a gate on the wire, not a fourth classification: the verdict above
      // came from `classifyFailure` and nothing here changes it. Everything local has
      // already happened — the attempt and failure counters and the per-kind tally — so
      // this machine's own view still sees the error and the rule stays distinguishable
      // from not noticing. What is skipped is the fold and the record, because a folded
      // record would carry this occurrence's count onto the wire inside a later one.
      //
      // Announced once per revision and deliberately not retracted: nothing observable
      // proves the path recovered, only that a different failure arrived, and a line that
      // flapped would be worse than one that stays.
      if (isUnansweredFailure(kind, note.status, note.code)) {
        counters.suppressedNetworkErrors += 1
        announce('unanswered', 'a failure belongs to the never-answered family — no connection ever opened; it is counted locally and not sent', undefined)
        return
      }
      const record = eventRecord({
        // The reporter's own clock is the default, not `Date.now()`: a caller that
        // injects `now` — a test, or a host replaying an attempt it timed itself —
        // has to see the folding windows measured in the same time it is measured in.
        at: toInteger(note.at, at),
        model,
        ok: false,
        status: note.status,
        ms: note.ms,
        err: note.err,
        route: note.route,
        code: note.code,
        kind,
        refusal: note.refusal === true,
        // Without this the refusal falls back to its kind, and the collector's block — which
        // leads with `code` — would render `http_450` instead of the provider's own
        // identifier. That is exactly what the `code` rule exists to prevent, and it is
        // invisible until somebody reads the rendered block.
        refusalCode: note.refusalCode,
        count: 1,
      }, identity)
      const key = `${model}|${kind}`
      const open = folded.get(key)
      if (open !== undefined && record.t - open.record.t >= 0 && record.t - open.record.t < limits.FAILURE_WINDOW_MS) {
        // One record per model and kind per window: `t` stays at the first
        // failure, because that is when the outage started, and `ms` takes the
        // last, because that is how long the site is taking now.
        open.record.ms = record.ms
        open.record.n = (open.record.n ?? 1) + 1
        open.expiresAt = record.t + limits.FAILURE_WINDOW_MS
        counters.folded += 1
        persist(at)
        return
      }
      if (open !== undefined) settleFailure(key)
      folded.set(key, { record: { ...record }, expiresAt: record.t + limits.FAILURE_WINDOW_MS })
      persist(at)
    } catch (error) {
      announce('note-failed', 'a failure could not be noted', error)
    }
  }

  /**
   * One success: two local jobs and one wire job, gated separately.
   *
   * The local jobs run whenever the watcher is alive, and no collection setting
   * gates them. Counting is what lets `/state` say the plugin is watching rather
   * than silently idle. Settling any failure of the same model that is still folding
   * is the only way the monitor learns *when* an outage ended: the failure report
   * carries the moment it began, and its arrival right after a success is the
   * recovery. Both used to sit behind `enabled()`, which resolves to the *error*
   * collection setting — so switching error collection off also stopped settling,
   * and the end of an outage went unlearned on exactly the machines whose owner had
   * decided to stop reporting. That was invisible while uptime had no denominator to
   * be wrong about; with one, it is the difference between a real percentage and a
   * page of zeros.
   *
   * The wire job is aggregation into the window that becomes one report, and it is
   * gated by the caller's per-sample `send` flag rather than by a reporter-level
   * switch. The host reads that setting at attempt time, so a request which went out
   * while success collection was on is not reclassified by a later toggle, and two
   * attempts inside one turn may legitimately differ. A sample noted with
   * `send: false` is never aggregated, so it cannot leave the machine later even if
   * the setting is switched back on: that request happened under a promise it would
   * not be sent, and re-enabling afterwards does not retroactively grant permission
   * for a request that already occurred.
   *
   * Whether an aggregated window may be *delivered* is a third question, asked at send
   * time by {@link successEnabled}, and its answer is deliberately **asymmetric** with
   * the error path.
   *
   * A sample collected while the setting was off is never aggregated and never leaves,
   * whatever happens afterwards: that request occurred under a promise it would not be
   * sent, and re-enabling does not grant permission retroactively. That half is the
   * privacy-critical one and nothing here changes it.
   *
   * A sample collected while the setting was on leaves if it can be delivered, and is
   * dropped and counted if it cannot — success windows are neither persisted nor retried,
   * because the disk queue exists for error reports. An error report waits for delivery
   * and survives a restart; a success window does neither. The asymmetry is the design
   * rather than an oversight: an error needs durability and a fifteen-minute aggregate
   * does not, since losing one shifts a daily percentage by a fraction while the next
   * window restores the picture. The cost is that a brief collector outage removes up to
   * fifteen minutes of denominator instead of delaying it, and `successWindowsLost` is
   * what makes that visible rather than leaving a user to infer it from a percentage that
   * moved.
   *
   * @param input - `{ model, route, ms, at, send }`. `ms` is aggregated into the
   *   window's duration sum and maximum — it is not transmitted per request, and no
   *   sequence of individual durations ever leaves. The argument was accepted before
   *   that was true, on the argument that a duration aggregate later would then be a
   *   local change rather than a second edit at every call site; it was, and it is.
   *   `send` defaults to true.
   * @returns nothing.
   */
  function noteSuccess(input = {}) {
    if (disposed) return
    try {
      const note = typeof input === 'object' && input !== null ? input : {}
      counters.attempts += 1
      counters.successes += 1
      const model = toField(note.model, FIELD_MAX) || 'unknown'
      const at = toInteger(note.at, clock())
      sweep(at)
      for (const key of [...folded.keys()]) {
        const entry = folded.get(key)
        if (entry !== undefined && entry.record.model === model) settleFailure(key)
      }
      if (note.send !== false) countSuccess(model, toField(note.route, FIELD_MAX), at, note.ms)
      persist(at)
    } catch (error) {
      announce('note-success-failed', 'a success could not be noted', error)
    }
  }

  /**
   * Send what is ready, now, ignoring the backoff.
   *
   * Without arguments this closes only the windows whose time has come, which is
   * what the periodic timer and `dispose()` want: a teardown that settled every
   * open window would chop real folding windows into fragments on every hot reload
   * of the host half, and the folding is the whole reason the volume is what it is.
   *
   * `settle: true` closes *every* window before pumping. It exists for an explicit
   * "send now" from the settings page, which has to answer with what it actually
   * sent: a record folded three seconds ago is inside a window that has not
   * expired, and a button whose only job is to prove the path end to end while the
   * user watches must not report `sent: 0` because of it. A window that has not
   * expired is still a record this install owes the collector — settling it early
   * delivers it whole, with the count it has folded so far.
   *
   * @param options - `{ settle }`; `settle: true` closes every open window first.
   * @returns a promise that always resolves.
   */
  async function flush(options = {}) {
    if (disposed) return
    try {
      const at = clock()
      if (typeof options === 'object' && options !== null && options.settle === true) settleAll()
      else sweep(at)
      await pump(true)
      persist(at)
    } catch (error) {
      announce('flush-failed', 'the report queue could not be flushed', error)
    }
  }

  /**
   * Start the periodic flush.
   *
   * The timer is `unref()`'d: a telemetry queue must never be the reason a process
   * stays alive, and an idle harness waiting on it would be a plugin that outlives
   * its user's session.
   *
   * @returns nothing.
   */
  function start() {
    if (disposed || timer !== null) return
    try {
      timer = setInterval(() => {
        // One tick does everything time-based: close the windows whose time has
        // come, try the queue if the backoff has expired, and write the backlog
        // out no more often than `PERSIST_MS` allows.
        try {
          const at = clock()
          sweep(at)
          persist(at)
          void pump(false)
        } catch (error) {
          announce('tick-failed', 'the periodic report flush failed', error)
        }
      }, Math.max(250, toInteger(limits.FLUSH_MS, FOLD_LIMITS.FLUSH_MS)))
      if (typeof timer.unref === 'function') timer.unref()
    } catch (error) {
      timer = null
      announce('timer-failed', 'the report timer could not be started', error)
    }
  }

  /**
   * Stop for good: no timer, one last write, one unwaited flush.
   *
   * The flush is deliberately not awaited — `dispose()` is called from a teardown
   * path that must not block, and the persisted backlog is what makes an
   * undelivered batch survivable rather than lost.
   *
   * @returns nothing.
   */
  function dispose() {
    if (disposed) return
    disposed = true
    try {
      if (timer !== null) clearInterval(timer)
    } catch {
      // A timer that will not clear is a timer this process is ending anyway.
    }
    timer = null
    try {
      sweep(clock())
    } catch (error) {
      announce('dispose-failed', 'the report windows could not be closed', error)
    }
    persist(clock(), true)
    // `sendable` rather than `enabled()`, so tearing down with error collection off
    // still delivers a success window that was aggregated while it was on.
    if (queue.some(sendable) && send !== undefined && endpointOf() !== '') {
      const attempt = pump(true)
      if (typeof attempt?.catch === 'function') attempt.catch(() => {})
    }
  }

  /**
   * What the settings page shows: the state of this queue, and nothing else.
   *
   * The endpoint is masked of any credentials and no path appears here, because
   * this summary is handed to the browser half and the paths belong to the host.
   *
   * @returns the summary object.
   */
  function summary() {
    const endpoint = endpointOf()
    const at = clock()
    // Counted here rather than kept in a counter, because the windows are the state
    // and a second tally of them would be a second thing to keep in step.
    let pendingSuccesses = 0
    for (const open of successWindows.values()) {
      for (const aggregate of open.counts.values()) pendingSuccesses += aggregate.n
    }
    return {
      enabled: enabled(),
      endpoint: endpoint.replace(/\/\/[^@/]+@/u, '//***@'),
      installId: toField(identity.id, FIELD_MAX),
      queued: queue.length,
      sent: counters.sent,
      failed: counters.failed,
      dropped: counters.dropped,
      folded: counters.folded,
      attempts: counters.attempts,
      failures: counters.failures,
      successes: counters.successes,
      // The success side gets its own numbers because the user's constraint was
      // volume, and the settings page has to answer "what does this cost me" with a
      // measurement of this install rather than with the contract's estimate. Both
      // accumulate where the document is serialised, so they count what left, and
      // they are lifetime totals with no elapsed span beside them — a renderer that
      // turns `successBytes` into "KiB per day" would be inventing the denominator.
      //
      // The resolved delivery gate is deliberately *not* published here. Whether
      // success sending is on is already on the wire as `config.collectSuccesses`,
      // which is the surface the toggle writes, and a second copy of one fact is two
      // facts the moment they disagree. The predicate itself is load-bearing below,
      // in `sendable`, where it decides delivery rather than describing a setting.
      successWindows: counters.successWindows,
      successBytes: counters.successBytes,
      // Read as a ratio against `successes`, and read the window count as a share of
      // `successWindows`: the first says how many samples arrived undated, the second
      // how many windows that cost their duration aggregate entirely. A near-zero pair
      // means §2.1's rule costs nothing; a large one means the feature is rendering
      // mostly dashes and the fallback — a `k` beside `n`, measured at +72 bytes a
      // document — is worth its price. Both are lifetime totals like the rest, so
      // neither is a rate until something divides it by an elapsed span.
      successesWithoutDuration: counters.successesWithoutDuration,
      successWindowsWithoutDuration: counters.successWindowsWithoutDuration,
      // Windows that were formed and did not leave: the delivery gate was closed at
      // settle time, the send failed, or the queue was full of error reports. Success
      // windows are neither persisted nor retried, so this counter is the only trace
      // that the gap exists — without it a user would infer lost data from a percentage
      // that moved, which is the inference this exists to prevent. Excludes windows
      // discarded because the collector refused the document shape; that condition has
      // its own single log line and would otherwise climb once per window forever.
      successWindowsLost: counters.successWindowsLost,
      // Failures suppressed as this machine's own network. Published beside the window
      // loss for the same reason: a rule that discards events has to leave a number
      // behind, or a real provider failure that happened to fail instantly disappears
      // with no trace. This counts events, not aggregates, so it is the more serious of
      // the two.
      suppressedNetworkErrors: counters.suppressedNetworkErrors,
      successWindowMs: limits.SUCCESS_WINDOW_MS,
      pendingSuccesses,
      lastSentAt,
      lastStatus,
      lastError,
      byKind: Object.fromEntries([...byKind.entries()].sort()),
      nextFlushAt: timer === null || disposed ? null : (retryAt > at ? retryAt : at + limits.FLUSH_MS),
    }
  }

  restore()

  return { noteFailure, noteSuccess, flush, start, dispose, summary }
}
