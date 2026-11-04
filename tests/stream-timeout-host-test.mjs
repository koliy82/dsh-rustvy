// Host-half test for the stream idle timeout: the two routes, the write, the refusal, and the
// auto-apply — driven through the real `GET`/`POST /dsh-rustvy/timeout` handlers on a mounted
// `lib/host.js`, because those functions are not exported and the user can only reach them
// through the routes.
//
// Everything runs against a throwaway profile and a closed-port origin, so it is offline and
// deterministic. The `configEditor` is a fake, and it is deliberately faithful in the two ways
// that decide whether this suite can catch a profile being corrupted:
//
//   * `edit()` hands the mutator a **clone** of the live config and stores whatever the mutator
//     returns. A product that mutated `current` in place and returned nothing would therefore
//     write nothing here — which is the point, since the real editor behaves the same way and a
//     looser fake would let that pass.
//   * the provider set carries a **foreign** route beside the rustvy family, so "never touch
//     what is not ours" is asserted rather than assumed. It is the same boundary property the
//     proxy suite makes, and the one whose failure silently rewrites somebody else's route.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-stream-timeout-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

/** The base route and the ring's two clones — exactly the family this feature may write. */
const ROUTES = ['rustvy', 'rustvy-k2', 'rustvy-k3']
/** A provider that is not ours and must survive every write byte for byte. */
const FOREIGN = 'deepseek-official'
const MODEL = { id: 'claude-opus-5-5', name: 'OPUS 5.5', maxTokens: 128000 }

/**
 * One provider profile as a `cordis.patch.yml` row would declare it.
 *
 * @param route - the route name.
 * @param timeout - the pinned timeout, or `null` for no field at all.
 * @returns the profile object.
 */
function profileOf(route, timeout) {
  return {
    displayName: route,
    apiKeyEnv: route === 'rustvy' ? 'RUSTVY_API_KEY' : `RUSTVY_API_KEY_${route.slice(-1)}`,
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [MODEL],
    ...(timeout === null ? {} : { streamIdleTimeoutMs: timeout }),
  }
}

/** The foreign profile, held apart so "untouched" can be compared against the original. */
const FOREIGN_PROFILE = Object.freeze({
  displayName: 'DeepSeek',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  api: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
})

/**
 * A fresh provider set.
 *
 * @param timeout - the timeout every rustvy route starts pinned to, or `null`.
 * @returns the `providers` object a route config holds.
 */
function providersOf(timeout) {
  const providers = {}
  for (const route of ROUTES) providers[route] = profileOf(route, timeout)
  providers[FOREIGN] = structuredClone(FOREIGN_PROFILE)
  return providers
}

let liveConfig = { providers: providersOf(null) }
const entry = {
  options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: liveConfig },
  fiber: {},
}
const edits = []
const logs = []

const credentials = {
  async resolve(ref) { return ref === 'RUSTVY_API_KEY' ? { value: 'sk-live-primary', source: 'file' } : undefined },
  async describe(ref) { return { configured: ref === 'RUSTVY_API_KEY', writable: true } },
  async set() {},
  async unset() {},
}

let route = null
const ctx = {
  logger: () => ({
    info: (message, error) => logs.push(['info', message, error]),
    warn: (message, error) => logs.push(['warn', message, error]),
    error: (message, error) => logs.push(['error', message, error]),
  }),
  profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
  credentials,
  configEditor: {
    entries: () => [entry],
    edit: async (target, change) => {
      if (target !== entry) throw new Error('Configuration entry is no longer available')
      // A clone goes in and the return value is what is stored, so an in-place mutation of
      // `current` writes nothing — the same contract the real editor has.
      const next = change(structuredClone(liveConfig), {})
      edits.push({ before: structuredClone(liveConfig), after: structuredClone(next) })
      liveConfig = next
      entry.options.config = liveConfig
    },
  },
  on: () => () => {},
}
ctx.webServer = { register: registered => { route = registered; return () => { route = null } } }

// Three stored keys, not two. `withPrimaryKey` adopts the *first* stored key as the base
// route's own and marks it primary, so a two-entry ring yields one clone and `routes` would be
// 2 — the base plus a single clone. Listing the base route first means the adoption lands on
// the entry that already names it, and the two clones are the routes this feature must reach.
writeFileSync(join(STATE, 'keys.json'), `${JSON.stringify({
  keys: [
    { id: 'k1', label: 'Основной', route: 'rustvy', ref: 'RUSTVY_API_KEY' },
    { id: 'k2', label: 'Second', route: 'rustvy-k2', ref: 'RUSTVY_API_KEY_2' },
    { id: 'k3', label: 'Third', route: 'rustvy-k3', ref: 'RUSTVY_API_KEY_3' },
  ],
}, null, 2)}\n`)

/**
 * Write the plugin's own settings.
 *
 * @param patch - the settings to vary; everything else is a quiet default.
 * @returns nothing.
 */
function writeSettings(patch) {
  writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
    enabled: true,
    syncModels: false,
    apiKeys: true,
    collectErrors: false,
    uptimeView: false,
    origin: 'http://127.0.0.1:9',
    uptimeEndpoint: 'http://127.0.0.1:9/api/report',
    modelRoute: 'rustvy',
    modelEntryId: 'llm-pi-ai',
    proxyEnabled: false,
    proxySpec: '',
    proxyMode: 'http',
    streamIdleTimeout: 0,
    ...patch,
  }, null, 2)}\n`)
}
writeSettings({})

const { start } = await import('../lib/host.js')

const results = []
/**
 * Record one assertion.
 *
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside the label.
 */
function check(label, ok, detail) {
  const shown = detail === undefined ? '' : `  — ${String(detail).slice(0, 320)}`
  results.push({ label, ok: ok === true, detail: shown })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${shown}`)
}

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
        const text = Buffer.concat(chunks.map(part => Buffer.from(String(part)))).toString('utf8')
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

/**
 * The pinned timeout a route currently carries.
 *
 * @param name - the route name.
 * @returns the value, or `undefined` when the field is absent.
 */
const pinned = name => liveConfig.providers[name]?.streamIdleTimeoutMs

/* ---- 1. the mount with the sentinel leaves every route alone --------------- */
let handle = await start(ctx, {})
check('the sentinel 0 in settings performs no edit at mount', edits.length === 0, `${edits.length} edit(s)`)
check('and no route gained the field', ROUTES.every(name => pinned(name) === undefined), JSON.stringify(ROUTES.map(pinned)))

/* ---- 2. GET reads the route profiles, not the plugin's config.json --------- */
const first = await call('GET', '/dsh-rustvy/timeout')
check('GET reports the routes are available to write', first.json?.available === true, JSON.stringify(first.json))
check('GET reports no pinned value when the field is absent', first.json?.value === null, String(first.json?.value))
check('and it counts the base route plus both clones', first.json?.routes === 3, String(first.json?.routes))

// The proof that the value comes from the route and not from settings: pin a number by hand in
// the profile, the way a user editing `cordis.patch.yml` would, while settings still say 0.
liveConfig.providers.rustvy.streamIdleTimeoutMs = 999_999
const handSet = await call('GET', '/dsh-rustvy/timeout')
check('GET reports a value set by hand in the profile', handSet.json?.value === 999_999, String(handSet.json?.value))
check('so the settings sentinel is not what it reads', handSet.json?.value !== 0, 'it read the plugin config instead')
delete liveConfig.providers.rustvy.streamIdleTimeoutMs

/* ---- 3. POST writes the base route and every clone ------------------------- */
const before = structuredClone(liveConfig)
const write = await call('POST', '/dsh-rustvy/timeout', { value: 3_600_000 })
check('the write succeeds', write.json?.ok === true && write.status === 200, JSON.stringify(write.json))
check('it reports the value it wrote', write.json?.value === 3_600_000, String(write.json?.value))
check('and it names every route it touched', JSON.stringify(write.json?.routes) === JSON.stringify(ROUTES), JSON.stringify(write.json?.routes))
check('the base route carries the field', pinned('rustvy') === 3_600_000, String(pinned('rustvy')))
check('and so does the first clone', pinned('rustvy-k2') === 3_600_000, String(pinned('rustvy-k2')))
check('and the second', pinned('rustvy-k3') === 3_600_000, String(pinned('rustvy-k3')))
check('the read-back agrees with the profiles', write.json?.current === 3_600_000, String(write.json?.current))

// The foreign route is the boundary. It must not gain the field, and it must not lose anything
// it had — a write that rebuilt the providers map carelessly would show up here first.
check('the foreign route did not gain the field', pinned(FOREIGN) === undefined, String(pinned(FOREIGN)))
check('and is otherwise byte for byte what it was',
  JSON.stringify(liveConfig.providers[FOREIGN]) === JSON.stringify(FOREIGN_PROFILE),
  JSON.stringify(liveConfig.providers[FOREIGN]))

// Neighbouring keys in the routes that *were* written. Dropping these is the failure that
// breaks a user's route outright, and it is invisible in the timeout value itself.
check('every written route kept its apiKeyEnv',
  ROUTES.every(name => liveConfig.providers[name].apiKeyEnv === before.providers[name].apiKeyEnv),
  JSON.stringify(ROUTES.map(name => liveConfig.providers[name].apiKeyEnv)))
check('every written route kept its models list',
  ROUTES.every(name => JSON.stringify(liveConfig.providers[name].models) === JSON.stringify([MODEL])),
  JSON.stringify(ROUTES.map(name => liveConfig.providers[name].models?.length)))
check('and its baseURL and api',
  ROUTES.every(name => liveConfig.providers[name].baseURL === 'http://127.0.0.1:9/v1'
    && liveConfig.providers[name].api === 'openai-completions'),
  JSON.stringify(ROUTES.map(name => liveConfig.providers[name].api)))
check('the write went through exactly one editor call, so the profile was replaced atomically',
  edits.length === 1, `${edits.length} edit(s)`)
check('and the mutator was handed the config as it was before the write',
  JSON.stringify(edits[0].before.providers.rustvy) === JSON.stringify(before.providers.rustvy),
  JSON.stringify(edits[0].before.providers.rustvy))
// An in-place mutation of `current` would leave `before` and `after` identical here, because
// the fake hands the mutator a clone and stores only the return value.
check('the stored result differs from what the mutator was given, so the return value is what landed',
  JSON.stringify(edits[0].after) !== JSON.stringify(edits[0].before), 'mutated in place and returned nothing')

/* ---- 4. /keys must not report a false clone drift after the write ---------- */
// HONEST LIMITATION, recorded because a removal probe found it. Deleting `routesCache.at = 0`
// from `setStreamTimeout` leaves both checks below green at 42/42, so **they are not coverage
// of that line** and must not be read as proving it is needed. Two reasons it cannot redden
// here, and neither is a fixture oversight I know how to close cheaply: `inStep` compares a
// clone's `models` against the plan's entries, and a timeout write changes no model — so in
// this fixture there is no mechanism by which a stale provider cache could report model drift;
// and with the origin on a closed port there is no plan at all, so `inStep` may never be
// computed, which makes "no `inStep:false` in the body" true for a reason unrelated to the
// cache. What these two do prove is narrower and still worth having: the timeout write leaves
// `/keys` answering and reporting nothing out of step. Whether `routesCache.at = 0` is
// load-bearing for this write at all — as opposed to being carried over from `applyModelPlan`,
// where models really do change — is an open question, not a settled one.
const keys = await call('GET', '/dsh-rustvy/keys')
check('`/keys` still answers after the timeout write', keys.json?.ok === true, JSON.stringify(keys.json).slice(0, 200))
check('and reports no clone out of step (see the limitation above: this does not cover `routesCache.at = 0`)',
  !keys.text.includes('"inStep":false'), keys.text.slice(0, 300))

/* ---- 5. POST null removes the field and keeps everything else -------------- */
const cleared = await call('POST', '/dsh-rustvy/timeout', { value: null })
check('the reset succeeds', cleared.json?.ok === true, JSON.stringify(cleared.json))
check('and reports a null value', cleared.json?.value === null, String(cleared.json?.value))
check('every route lost the field', ROUTES.every(name => pinned(name) === undefined), JSON.stringify(ROUTES.map(pinned)))
check('the read-back agrees', cleared.json?.current === null, String(cleared.json?.current))
check('every route kept its neighbours through the delete',
  ROUTES.every(name => liveConfig.providers[name].apiKeyEnv !== undefined
    && JSON.stringify(liveConfig.providers[name].models) === JSON.stringify([MODEL])),
  JSON.stringify(ROUTES.map(name => Object.keys(liveConfig.providers[name]))))
check('and the foreign route is still untouched',
  JSON.stringify(liveConfig.providers[FOREIGN]) === JSON.stringify(FOREIGN_PROFILE),
  JSON.stringify(liveConfig.providers[FOREIGN]))

/* ---- 6. zero is refused and writes nothing -------------------------------- */
const editsBeforeRefusal = edits.length
const refused = await call('POST', '/dsh-rustvy/timeout', { value: 0 })
check('zero is refused', refused.json?.ok === false, JSON.stringify(refused.json))
// The status is 200 and the refusal is in the body, which is this route group's convention:
// `/refresh`, `/config`, `/test-proxy`, `/apply-models` and `/revert-models` all answer 200
// with `ok: false` and a sentence. Only the keys group turns a `status` into an HTTP code.
// Asserting a 400 here would be asserting a contract this group does not have.
check('the refusal travels in the body of a 200, the way every sibling route reports one',
  refused.status === 200 && refused.json?.ok === false, `${refused.status} ${JSON.stringify(refused.json?.ok)}`)
check('the refusal names the minimum and the way out', String(refused.json?.error).includes('не меньше 1') && String(refused.json?.error).includes('null'), String(refused.json?.error))
check('and it says what writing it would have broken', String(refused.json?.error).includes('схема адаптера'), String(refused.json?.error))
check('nothing was written by the refusal', edits.length === editsBeforeRefusal, `${edits.length - editsBeforeRefusal} edit(s)`)
check('and no route gained the field', ROUTES.every(name => pinned(name) === undefined), JSON.stringify(ROUTES.map(pinned)))

/* ---- 7. auto-apply writes only on a mismatch ------------------------------ */
await handle.dispose()

// A mismatch: settings ask for an hour, the routes carry nothing.
edits.length = 0
writeSettings({ streamIdleTimeout: 3_600_000 })
handle = await start(ctx, {})
check('a mount whose settings differ from the routes writes once', edits.length === 1, `${edits.length} edit(s)`)
check('and the routes now carry the configured value', ROUTES.every(name => pinned(name) === 3_600_000), JSON.stringify(ROUTES.map(pinned)))
await handle.dispose()

// No mismatch: the value is already there. This is the property that keeps a hand-set
// `cordis.patch.yml` value from being rewritten on every mount.
edits.length = 0
handle = await start(ctx, {})
check('a mount whose settings already match the routes writes nothing at all', edits.length === 0, `${edits.length} edit(s)`)
check('and leaves the value it found in place', ROUTES.every(name => pinned(name) === 3_600_000), JSON.stringify(ROUTES.map(pinned)))
await handle.dispose()

// A hand-set value the settings disagree with is the case the comparison exists for: the
// mount must not silently overwrite it, and the sentinel must not either.
liveConfig.providers.rustvy.streamIdleTimeoutMs = 1_800_000
liveConfig.providers['rustvy-k2'].streamIdleTimeoutMs = 1_800_000
liveConfig.providers['rustvy-k3'].streamIdleTimeoutMs = 1_800_000
edits.length = 0
writeSettings({ streamIdleTimeout: 0 })
handle = await start(ctx, {})
check('the sentinel leaves a hand-set profile value alone', edits.length === 0 && ROUTES.every(name => pinned(name) === 1_800_000), JSON.stringify(ROUTES.map(pinned)))
const handRead = await call('GET', '/dsh-rustvy/timeout')
check('and GET reports the hand-set value, not the sentinel', handRead.json?.value === 1_800_000, String(handRead.json?.value))
await handle.dispose()

rmSync(PROFILE, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
process.exit(0)
