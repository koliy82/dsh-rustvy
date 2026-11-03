// Host-half integration test: a local source, a fixture catalogue, a fake webServer and a
// fake configEditor seeded with a route whose shape matches the installed profile.
//
// The default is closed over the fixture in `tests/fixtures/model-sync.json`. It used to
// seed from this machine's live mirror and compare against whatever the provider served
// that morning, which made the suite a test of the provider: on 2026-11-02 the provider
// dropped five models and re-enabled them the same day, reddening this file twice inside
// `prepublishOnly` for reasons that were not defects. A test that reddens when the outside
// world changes is not testing code.
//
// The live path survives as an explicitly opt-in mode, because it does cover something the
// fixture cannot — that the real provider's answer still parses:
//
//     $env:DSH_RUSTVY_LIVE_MODEL_SYNC = '1'; node tests/model-sync-host-test.mjs
//
// In that mode the fixture-specific assertions skip by name rather than passing vacuously.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/model-sync.json'), 'utf8'))
const LIVE = process.env.DSH_RUSTVY_LIVE_MODEL_SYNC === '1'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-rustvy-test-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(join(STATE, 'logos'), { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

// The local source stands in for both halves the plugin reads: the collector's catalogue at
// `/api/catalog`, and the route's own membership endpoint at `/v1/models`. Both are local,
// so nothing in this file reaches the network in the default mode.
let sourceHits = 0
const source = createServer((request, response) => {
  sourceHits += 1
  const url = request.url ?? '/'
  if (url.startsWith('/api/catalog')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(FIXTURE.catalog))
    return
  }
  if (url.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: FIXTURE.served.map(id => ({ id })) }))
    return
  }
  // The island pages answer nothing: the catalogue comes from the collector, and a test
  // that silently fell back to parsing HTML would not be testing the fixture.
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('')
})
await new Promise(resolve => { source.listen(0, '127.0.0.1', resolve) })
const LOCAL = `http://127.0.0.1:${source.address().port}`

// In live mode the route points at the real provider and the served list is read from it,
// independently of the code under test. A failed probe yields 0, which makes every count
// comparison fail loudly rather than pass vacuously.
const BASE = LIVE ? 'https://rustvy.xyz' : LOCAL
const servedIds = LIVE
  ? await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(20_000) })
    .then(response => response.json())
    .then(body => (Array.isArray(body?.data) ? body.data : []).map(model => model?.id).filter(id => typeof id === 'string'))
    .catch(() => [])
  : [...FIXTURE.served]
const EXPECTED = servedIds.length
console.log(`note: ${LIVE ? 'LIVE mode' : 'fixture mode'} — the source serves ${EXPECTED} model(s)`)

const { start, build } = await import('../lib/host.js')
const { buildModelEntries, diffModels, mirrorRecord, normalizeServedList } = await import('../lib/models.js')

// The route as the profile has it installed, with its `baseURL` pointed at the source under
// test. In fixture mode the installed list comes from the fixture too, so the transitions
// are stated rather than discovered: two models installed but not served (retired), one
// served but not installed (added), and one served and installed with a description and a
// compat that must both survive.
const installedModels = LIVE
  ? [
    { id: 'claude-fable-5-1', name: 'claude-fable-5-1', maxTokens: 128000 },
    { id: 'claude-opus-5-5', name: 'claude-opus-5-5', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }, compat: { supportsDeveloperRole: true } },
    { id: 'claude-opus-5', name: 'claude-opus-5', maxTokens: 128000 },
    { id: 'glm-5.3', name: 'glm-5.3', maxTokens: 8192 },
    { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', maxTokens: 128000 },
    { id: 'fable-ultra-promax', name: 'fable-ultra-promax', maxTokens: 128000, compat: { supportsStore: true } },
  ]
  : structuredClone(FIXTURE.installed)

let liveConfig = {
  providers: {
    rustvy: {
      displayName: 'rustvy',
      apiKeyEnv: 'RUSTVY_API_KEY',
      api: 'openai-completions',
      baseURL: `${BASE}/v1`,
      models: structuredClone(installedModels),
    },
  },
}

const entry = {
  options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: liveConfig },
  fiber: {},
}
const edits = []
const logs = []

const ctx = {
  logger: () => ({
    info: (m, e) => logs.push(['info', m, e]),
    warn: (m, e) => logs.push(['warn', m, e]),
    error: (m, e) => logs.push(['error', m, e]),
  }),
  // The host publishes the patch document it writes through; naming it lets the
  // settings page tell a profile author which file a manual edit belongs in.
  profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
  configEditor: {
    entries: () => [entry],
    // Mirror the real service: hand the callback the current config and take the
    // complete document it returns.
    edit: async (target, change) => {
      if (target !== entry) throw new Error('Configuration entry is no longer available')
      const next = change(structuredClone(liveConfig), {})
      edits.push({ before: structuredClone(liveConfig), after: structuredClone(next) })
      liveConfig = next
      entry.options.config = liveConfig
    },
  },
}

let route = null
ctx.webServer = { register: r => { route = r; return () => { route = null } } }

// The settings decide where the catalogue comes from: `uptimeEndpoint` names the collector,
// and in fixture mode that is the local source. Left at its default this file would reach
// the live collector — which is how `route-bootstrap-host-test.mjs` started depending on
// somebody else's deployment, invisibly, because the collector answered correctly.
writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: true, syncModels: true, apiKeys: false, collectErrors: false, uptimeView: false,
  origin: BASE,
  uptimeEndpoint: `${LIVE ? BASE : LOCAL}/api/report`,
}, null, 2)}\n`)

const handle = await start(ctx, {})

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
        const text = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, headers: this.headers, text, json })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    setTimeout(() => reject(new Error(`timeout on ${method} ${path}`)), 60_000).unref()
  })
}

const results = []
function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

// --- state -----------------------------------------------------------------
// The guard that stops every count comparison above from passing vacuously: a probe that
// returned nothing would make `EXPECTED` zero, and a plugin that generated nothing would
// then agree with it. Eight is the floor because this route has served at least that many
// for every release so far; a provider offering fewer is a change worth failing on.
check('the source serves the models the fixture names', EXPECTED >= (LIVE ? 8 : FIXTURE.served.length), `EXPECTED=${EXPECTED} from ${servedIds.length} id(s)`)
const state = await call('GET', '/dsh-rustvy/state')
check('GET /state answers 200', state.status === 200, `status ${state.status}`)
check(`/state reports build ${build}`, state.json?.build === build, String(state.json?.build))
check('/state carries a modelSync block', typeof state.json?.modelSync === 'object', JSON.stringify(Object.keys(state.json?.modelSync ?? {})))
check('/state modelSync sees the route', state.json?.modelSync?.route === 'rustvy', String(state.json?.modelSync?.route))
check('/state modelSync finds the entry', state.json?.modelSync?.entryId === 'llm-pi-ai', String(state.json?.modelSync?.entryId))

// --- plan ------------------------------------------------------------------
const plan = await call('GET', '/dsh-rustvy/models.json')
check('GET /models.json answers 200', plan.status === 200, `status ${plan.status}`)
const p = plan.json ?? {}
check('plan read the route endpoint', p.source === 'endpoint', String(p.source))
check('plan is writable (configEditor found)', p.available === true, String(p.available))
// Both directions of the transition, derived from the fixture rather than from live ids.
// A retirement-only fixture would have passed this morning and failed this afternoon, when
// the provider re-enabled five models; an addition-only one would have failed this morning.
// The pair is the property, so both are asserted and neither is a literal.
const installedIds = installedModels.map(model => model.id)
const ADDED = servedIds.filter(id => !installedIds.includes(id))
const RETIRED = installedIds.filter(id => !servedIds.includes(id))
const STABLE = servedIds.find(id => installedIds.includes(id) && id === 'glm-5.3') ?? servedIds.find(id => installedIds.includes(id))
check('the fixture expresses both directions', ADDED.length > 0 && RETIRED.length > 0 && STABLE !== undefined, JSON.stringify({ added: ADDED, retired: RETIRED, stable: STABLE }))
check('the plan adds every model that is served but not installed', ADDED.every(id => (p.added ?? []).includes(id)), `expected ${ADDED.join(', ')}; got ${(p.added ?? []).join(', ')}`)
check('the plan retires every model that is installed but not served', RETIRED.every(id => (p.removed ?? []).includes(id)), `expected ${RETIRED.join(', ')}; got ${(p.removed ?? []).join(', ')}`)
// Asserted through the plan's entries and the written route rather than through `kept`,
// whose meaning I did not verify: a stable model is one that is served and installed and
// stays installed, and that is a property of the two lists, not of a field I would be
// guessing at.
check('the plan keeps a model that is both served and installed', (p.entries ?? []).some(e => e.id === STABLE), `${STABLE} not in ${(p.entries ?? []).map(e => e.id).join(', ')}`)
check('plan retires fable-ultra-promax', (p.removed ?? []).includes('fable-ultra-promax'))
check('plan reports drift', p.upToDate === false, String(p.upToDate))
check('plan generated as many entries as the endpoint serves', p.count === EXPECTED, `plan ${p.count} vs endpoint ${EXPECTED}`)

// The fully described model is `claude-opus-5-5` in the fixture: a real display name, a
// 1000k context, image input and four effort levels. It is the model the live provider
// dropped and then restored on 2026-11-02, which is why it lives in a file rather than in
// the world.
const described = (p.entries ?? []).find(e => e.id === 'claude-opus-5-5')
check('claude-opus-5-5 is fully described from the catalogue',
  described?.name === 'OPUS 5.5' && described?.contextWindow === 1000000 && described?.maxTokens === 128000
  && JSON.stringify(described?.input) === '["text","image"]'
  && described?.reasoningEfforts?.low === 'low' && described?.reasoningEfforts?.max === 'max',
  JSON.stringify(described))
check('claude-opus-5-5 carries no unknown field',
  Object.keys(described ?? {}).every(k => ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'].includes(k)),
  Object.keys(described ?? {}).join(', '))
check('glm-5.3 keeps its 8192 output cap',
  (p.entries ?? []).find(e => e.id === 'glm-5.3')?.maxTokens === 8192,
  String((p.entries ?? []).find(e => e.id === 'glm-5.3')?.maxTokens))

// A wire-compatibility switch is knowledge about the gateway that no catalog can
// supply, so it is the one field carried forward rather than regenerated — but only for a
// model the route still serves. `claude-opus-5-5` is where the fixture writes it, and the
// provider dropping that model is a fact about the offering rather than a defect here, so
// the check skips by name instead of failing for a reason it cannot control.
const opusServed = servedIds.includes('claude-opus-5-5')
if (opusServed) {
  check('a hand-written compat survives regeneration',
    (p.entries ?? []).find(e => e.id === 'claude-opus-5-5')?.compat?.supportsDeveloperRole === true,
    JSON.stringify((p.entries ?? []).find(e => e.id === 'claude-opus-5-5')?.compat))
} else {
  console.log('SKIP  a hand-written compat survives regeneration  — the endpoint no longer serves claude-opus-5-5, so the model carrying it is not regenerated')
}
check('compat is never invented for other models',
  (p.entries ?? []).filter(e => e.id !== 'claude-opus-5-5').every(e => e.compat === undefined),
  (p.entries ?? []).filter(e => e.compat !== undefined).map(e => e.id).join(', ') || 'none')

// --- the remaining roles the fixture's `_roles` block promises ---------------
// Each id in `tests/fixtures/model-sync.json` is named there with the property it exists to
// express. Until now five of those names appeared nowhere in this file, so the fixture
// documented coverage the suite did not have: an id with no role is decoration, and a role
// with no assertion is a promise.
const entryOf = id => (p.entries ?? []).find(e => e.id === id)
// Declared here rather than beside its first consumer below, because two of the role checks
// need it and a `const` used before its declaration is a reference error, not a hoist.
const catalogRecords = FIXTURE.catalog.models.map(mirrorRecord).filter(Boolean)

check('an empty icon name is an ordinary answer and does not drop the record',
  entryOf('no-icon-model') !== undefined,
  JSON.stringify((p.entries ?? []).map(e => e.id)))
check('a model with no published capacity says so rather than inventing a window',
  entryOf('no-capacity-model') !== undefined
  && entryOf('no-capacity-model').contextWindow === undefined
  && entryOf('no-capacity-model').maxTokens === undefined,
  JSON.stringify(entryOf('no-capacity-model')))
// The pair above and below is what makes the absence meaningful: if capacity were simply
// never read, the capacity-less model would look correct and so would every other one.
check('a capacity that IS published is still read, so the absence above is not a blanket skip',
  entryOf('qwen3.8-max')?.contextWindow === 1000000 && entryOf('qwen3.8-max')?.maxTokens === 128000,
  JSON.stringify(entryOf('qwen3.8-max')))
// What this check does and does not prove, stated because a probe settled it. The plan is
// built from the served wire list, and the twin is not on that list, so it cannot reach the
// plan whatever else is true of it — removing a `zone` field from the twin reddened nothing.
// The zone filter itself lives in `servedFromCatalog`, the FALLBACK path, and this fixture's
// twin carries no `zone` field at all (its zonal nature is in the `abyss/` id prefix), so the
// filter is exercised in `models-check.mjs`, whose fixture does carry one. Asserting it here
// would have been asserting something false about this file.
check('the zonal twin is absent from the plan and does not shadow the canonical id it is named after',
  entryOf('qwen3.8-max') !== undefined && entryOf('abyss/qwen3.8-max') === undefined
  && (p.entries ?? []).filter(e => e.name === entryOf('qwen3.8-max')?.name).length === 1,
  JSON.stringify({
    canonical: entryOf('qwen3.8-max'),
    twin: entryOf('abyss/qwen3.8-max'),
    names: (p.entries ?? []).map(e => e.name),
  }))
check('a catalogue-only record never reaches the plan or the additions',
  entryOf('fixture-only-sentinel') === undefined && !(p.added ?? []).includes('fixture-only-sentinel'),
  JSON.stringify({ added: p.added, ids: (p.entries ?? []).map(e => e.id) }))

// Provenance, which is the sentinel's actual job: the live provider does not serve that id,
// so its presence in the mirrored catalogue on disk proves the mirror came from the fixture
// file rather than from a silent live read. Read as text rather than through a `models` key,
// because the assertion is about which file produced the mirror and not about its shape — and
// a shape assumption here would turn a real provenance failure into a confusing one.
const catalogPath = String(state.json?.paths?.catalog ?? '')
const catalogRaw = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : ''
check('the mirrored catalogue came from the fixture file, proven by a record the provider does not serve',
  catalogRaw.length > 0 && catalogRaw.includes('fixture-only-sentinel'),
  JSON.stringify({ path: catalogPath, bytes: catalogRaw.length }))

// --- degenerate served lists -------------------------------------------------
// Asserted on the generator rather than by driving a second host through the settings page.
// The property is that an empty or single-model served list produces a plan of the matching
// shape rather than a crash, a silently empty document, or a plan that claims to be up to
// date. What this does NOT cover is the host's own end-to-end handling of those states,
// which would need a second `start()` against a source serving them.
const generatorOptions = { nameSource: 'displayName', offerOff: true }

const emptyBuild = buildModelEntries([], catalogRecords, structuredClone(installedModels), generatorOptions)
const emptyDiff = diffModels(installedModels, emptyBuild.entries)
check('an empty served list generates no entries at all', emptyBuild.entries.length === 0,
  JSON.stringify(emptyBuild.entries.map(e => e.id)))
check('and retires everything that was installed rather than claiming to be up to date',
  emptyDiff.removed.length === installedModels.length && emptyDiff.upToDate === false,
  JSON.stringify({ removed: emptyDiff.removed, upToDate: emptyDiff.upToDate }))

const singleBuild = buildModelEntries(
  normalizeServedList({ data: [{ id: 'glm-5.3' }] }), catalogRecords, structuredClone(installedModels), generatorOptions)
const singleDiff = diffModels(installedModels, singleBuild.entries)
check('a single served model generates exactly one entry',
  singleBuild.entries.length === 1 && singleBuild.entries[0]?.id === 'glm-5.3',
  JSON.stringify(singleBuild.entries.map(e => e.id)))
check('and that entry keeps the capacity the catalogue publishes for it',
  singleBuild.entries[0]?.maxTokens === 8192, String(singleBuild.entries[0]?.maxTokens))
check('and the single-model plan still reports drift in both directions',
  singleDiff.removed.length === installedModels.length - 1 && singleDiff.upToDate === false,
  JSON.stringify({ removed: singleDiff.removed, upToDate: singleDiff.upToDate }))

// --- paths and the manual-edit block ---------------------------------------
check('/state names every file this half touches',
  String(state.json?.paths?.catalog ?? '').endsWith('catalog.json')
  && String(state.json?.paths?.config ?? '').endsWith('config.json')
  && String(state.json?.paths?.backup ?? '').endsWith('models-backup.json')
  && state.json?.paths?.cache !== undefined,
  JSON.stringify(state.json?.paths))
check('/state names the profile patch document',
  state.json?.paths?.patch === 'C:\\profile\\cordis.patch.yml', String(state.json?.paths?.patch))
check('the plan carries the endpoint it reads', p.modelsUrl === `${BASE}/v1/models`, String(p.modelsUrl))
check('the plan carries the route connection fields',
  p.providerFields?.api === 'openai-completions' && p.providerFields?.apiKeyEnv === 'RUSTVY_API_KEY',
  JSON.stringify(p.providerFields))
check('the plan omits the models it is about to replace', p.providerFields?.models === undefined)

const yaml = await call('GET', '/dsh-rustvy/models.yaml')
check('GET /models.yaml answers 200', yaml.status === 200, `status ${yaml.status}`)
check('GET /models.yaml answers YAML', /yaml/iu.test(String(yaml.headers['content-type'])), String(yaml.headers['content-type']))
check('the block is a patch row for this route',
  yaml.text.startsWith('- id: llm-pi-ai\n') && yaml.text.includes('name: "@deepseek-ai/dsh-llm-pi-ai"'),
  yaml.text.split('\n')[0])
check('the block keeps the connection fields',
  yaml.text.includes(`baseURL: ${BASE}/v1`)
  && yaml.text.includes('apiKeyEnv: RUSTVY_API_KEY')
  && yaml.text.includes('api: openai-completions'))
check('the block carries the generated models',
  yaml.text.includes('- id: claude-opus-5-5') && yaml.text.includes('name: OPUS 5.5'))
check('the block leaves out the models it replaces', !yaml.text.includes('fable-ultra-promax'))

// --- apply -----------------------------------------------------------------
const before = edits.length
const applied = await call('POST', '/dsh-rustvy/apply-models', {})
check('POST /apply-models answers 200', applied.status === 200, `status ${applied.status}`)
check('apply wrote through configEditor', edits.length === before + 1, `${edits.length - before} edit(s)`)
check('apply reports applied', applied.json?.applied === true, JSON.stringify(applied.json && { ok: applied.json.ok, applied: applied.json.applied, error: applied.json.error }))

const written = liveConfig.providers.rustvy
check('route kept displayName/apiKeyEnv/api/baseURL',
  written.displayName === 'rustvy' && written.apiKeyEnv === 'RUSTVY_API_KEY'
  && written.api === 'openai-completions' && written.baseURL === `${BASE}/v1`,
  JSON.stringify({ displayName: written.displayName, api: written.api, baseURL: written.baseURL }))
check('route now serves as many models as the endpoint serves', written.models.length === EXPECTED, `${written.models.length} vs endpoint ${EXPECTED}`)
check('the route now serves what the plan added', ADDED.every(id => written.models.some(m => m.id === id)), JSON.stringify(written.models.map(m => m.id)))
check('the route no longer serves what the plan retired', RETIRED.every(id => !written.models.some(m => m.id === id)), JSON.stringify(written.models.map(m => m.id)))
if (opusServed) {
  check('claude-opus-5-5 kept its full description',
    JSON.stringify(written.models.find(m => m.id === 'claude-opus-5-5')?.reasoningEfforts)
    === '{"off":null,"low":"low","medium":"medium","high":"high","max":"max"}',
    JSON.stringify(written.models.find(m => m.id === 'claude-opus-5-5')))
} else {
  console.log('SKIP  claude-opus-5-5 kept its full description  — the endpoint no longer serves it, so it is retired rather than regenerated')
}

const backupFile = join(PROFILE, '.dsh-rustvy', 'models-backup.json')
check('a backup was written', existsSync(backupFile))
const backup = JSON.parse(readFileSync(backupFile, 'utf8'))
check('backup holds the previous models',
  backup?.config?.providers?.rustvy?.models?.some(m => m.id === 'fable-ultra-promax'), String(backup?.at))

// The plan the write just resolved must not keep being reported as drift.
const stateAfter = await call('GET', '/dsh-rustvy/state')
// The write used the endpoint, while `/state` reports drift against the *mirror*
// (`skipFetch: true`). When the mirror is behind the endpoint those two legitimately
// disagree, so asserting "drift is resolved" unconditionally asserted that the provider
// and the local island must agree — which is a fact about the world, not about the code,
// and is exactly why this check was the fifth failure a number change could not fix.
check('/state reports the models the write installed', stateAfter.json?.modelSync?.installedCount === EXPECTED,
  JSON.stringify({ installed: stateAfter.json?.modelSync?.installedCount, expected: EXPECTED }))
const mirrorCount = stateAfter.json?.modelSync?.count
const mirrorLags = typeof mirrorCount === 'number' && mirrorCount !== EXPECTED
check('/state drift after a write is either resolved or explained by the mirror lagging',
  mirrorLags ? stateAfter.json?.modelSync?.upToDate === false : stateAfter.json?.modelSync?.upToDate === true,
  JSON.stringify({ upToDate: stateAfter.json?.modelSync?.upToDate, installed: stateAfter.json?.modelSync?.installedCount, mirrorCount, expected: EXPECTED, explainedByLag: mirrorLags, source: stateAfter.json?.modelSync?.source }))

// --- idempotence -----------------------------------------------------------
const again = await call('POST', '/dsh-rustvy/apply-models', {})
check('a second apply is a no-op', again.json?.applied === false && again.json?.upToDate === true,
  JSON.stringify(again.json && { applied: again.json.applied, upToDate: again.json.upToDate }))
check('a no-op apply did not touch the config', edits.length === before + 1, String(edits.length - before))

// --- revert ----------------------------------------------------------------
const reverted = await call('POST', '/dsh-rustvy/revert-models', {})
check('POST /revert-models answers 200', reverted.status === 200, `status ${reverted.status}`)
check('revert reports reverted', reverted.json?.reverted === true, JSON.stringify(reverted.json?.error))
check('revert restored the retired models',
  liveConfig.providers.rustvy.models.some(m => m.id === 'fable-ultra-promax')
  && RETIRED.every(id => liveConfig.providers.rustvy.models.some(m => m.id === id))
  && ADDED.every(id => !liveConfig.providers.rustvy.models.some(m => m.id === id)),
  String(liveConfig.providers.rustvy.models.length))
check('revert preserved the compat block',
  liveConfig.providers.rustvy.models.find(m => m.id === 'fable-ultra-promax')?.compat?.supportsStore === true)

// --- guards ----------------------------------------------------------------
const refused = await call('GET', '/dsh-rustvy/models.json', undefined)
const forbidden = await new Promise(resolve => {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/dsh-rustvy/models.json'
  request.socket = { remoteAddress: '203.0.113.7' }
  request.headers = { host: '127.0.0.1:19387' }
  const response = {
    status: 0,
    writeHead(status) { this.status = status; return this },
    end() { resolve(this.status) },
  }
  route.handler(request, response)
})
check('a non-loopback peer is refused', forbidden === 403, String(forbidden))
check('models.json survived the refused peer', refused.status === 200, String(refused.status))

const wrongMethod = await new Promise(resolve => {
  const request = new EventEmitter()
  request.method = 'DELETE'
  request.url = '/dsh-rustvy/models.json'
  request.socket = { remoteAddress: '127.0.0.1' }
  request.headers = { host: '127.0.0.1:19387' }
  const response = { status: 0, writeHead(status) { this.status = status; return this }, end() { resolve(this.status) } }
  route.handler(request, response)
})
check('a wrong method is refused 405', wrongMethod === 405, String(wrongMethod))

await handle.dispose()
check('dispose released the route', route === null)

rmSync(PROFILE, { recursive: true, force: true })

source.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (logs.filter(l => l[0] === 'error').length > 0) {
  console.log('\nerror logs:')
  for (const [, m, e] of logs.filter(l => l[0] === 'error')) console.log(`  ${m} ${e?.message ?? e ?? ''}`)
}
// `process.exit()` here can trip a libuv assertion on Windows while undici sockets
// from the origin fetches are still closing; setting the code lets teardown finish.
process.exitCode = failed.length === 0 ? 0 : 1
