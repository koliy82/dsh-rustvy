// The catalogue comes from the collector, and what it carries survives into the route.
//
// Two separate failure modes are covered, and neither check would see the other:
//
//   * The user's actual bug — Qwen and DeepSeek lost their badges in the DSH picker —
//     was two catalogues disagreeing about an id. A badge is drawn by matching an id, so
//     `abyss/qwen3.8-max` beside `qwen3.8-max` leaves the model the user picks without a
//     mark. A "the catalogue loaded" assertion passes on that broken match, which is why
//     these checks are about matching rather than about arrival.
//   * The downgrade this task would have caused had the collector not been widened:
//     capacities dropped between `/api/catalog` and the written route. `contextWindow` and
//     `maxTokens` are checked on the *route profile* after a write, not on the collector's
//     answer, because the mapping in between is where they were going to be lost.
//
// Both servers are local. Nothing here reads the live collector or the live provider.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-catalog-source-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE
delete process.env.RUSTVY_API_KEY

const MODEL = 'claude-opus-5-5'
const results = []
/**
 * Record one assertion.
 *
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside the label, truncated so a failure stays readable.
 */
function check(label, ok, detail) {
  const shown = detail === undefined ? '' : `  — ${String(detail).slice(0, 400)}`
  results.push({ label, ok: ok === true, detail: shown })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${shown}`)
}

/**
 * The catalogue the fake collector publishes.
 *
 * Deliberately holds the canonical id *and* its zonal twin, with the same display name and
 * the same icon, because that pair is the defect: the picker shows the canonical model, and
 * a match that resolves the twin leaves the shown model bare. `glm-5.3` carries the one
 * output cap that differs from the rest, so a capacity read can be told from a default.
 */
const CATALOG = [
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', vendor: 'qwen', vendorLabel: 'Qwen', icon: 'qwen.svg', contextK: 1000, maxOutputTokens: 128000, modalities: ['text', 'image'], reasoningLevels: ['low', 'high'] },
  { id: 'abyss/qwen3.8-max', name: 'Qwen3.8 Max', vendor: 'qwen', vendorLabel: 'Qwen', icon: 'qwen.svg', contextK: 1000, maxOutputTokens: 128000, modalities: ['text', 'image'], reasoningLevels: ['low', 'high'] },
  { id: 'glm-5.3', name: 'GLM 5.3', vendor: 'zhipu', vendorLabel: 'Zhipu', icon: 'zhipu.svg', contextK: 1000, maxOutputTokens: 8192, modalities: ['text'], reasoningLevels: ['low', 'medium', 'high', 'max'] },
  // Present in the catalogue's history but absent from what the provider serves: the
  // collector only lists what is enabled, so this one is here to prove an id that arrives
  // without a usable icon still resolves to its row rather than disappearing.
  { id: 'kimi-k3', name: 'Kimi K3', vendor: 'kimi', vendorLabel: 'Kimi', icon: '', contextK: 1000, maxOutputTokens: 128000, modalities: ['text'], reasoningLevels: [] },
]

let collectorUp = true
let catalogOverride = null
let iconRequests = 0
let syncRequests = 0
const ICON_BYTES = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'
const collector = createServer((request, response) => {
  const url = request.url ?? '/'
  if (!collectorUp) {
    response.destroy()
    return
  }
  // Before the `/api/catalog` branch, which is a prefix of this path.
  if (url.startsWith('/api/catalog/sync')) {
    syncRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ synced: true, catalog: { version: 140, models: catalogOverride ?? CATALOG } }))
    return
  }
  if (url.startsWith('/api/catalog')) {
    const models = catalogOverride ?? CATALOG
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ version: 139, fetchedAt: Date.now(), source: 'provider', models, folded: 1, disabled: 24, lastError: '', lastAttempt: Date.now() }))
    return
  }
  if (url.startsWith('/api/icon/')) {
    iconRequests += 1
    // The collector serves what it has cached and 404s the rest. `kimi-k3` carries no icon
    // name precisely so the provider fallback has something of its own to answer for.
    if (url.includes('kimi')) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('')
      return
    }
    response.writeHead(200, { 'content-type': 'image/svg+xml' })
    response.end(ICON_BYTES)
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{}')
})
await new Promise(resolve => { collector.listen(0, '127.0.0.1', resolve) })
const COLLECTOR = `http://127.0.0.1:${collector.address().port}`

// The provider, which now supplies only *membership* — which models the route serves.
// Metadata (labels, icons, capacities) comes from the collector's catalogue, so the two
// agreeing on ids is the whole point of the change; the defect being fixed was two
// catalogues disagreeing about an id, not about a capacity.
const SERVED_IDS = ['qwen3.8-max', 'glm-5.3', 'kimi-k3']
let providerHits = 0
const provider = createServer((request, response) => {
  providerHits += 1
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ data: SERVED_IDS.map(id => ({ id })) }))
})
await new Promise(resolve => { provider.listen(0, '127.0.0.1', resolve) })
const ORIGIN = `http://127.0.0.1:${provider.address().port}`

writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: true, syncModels: true, apiKeys: false, collectErrors: false, uptimeView: false,
  origin: ORIGIN,
  uptimeEndpoint: `${COLLECTOR}/api/report`,
}, null, 2)}\n`)

const { start } = await import('../lib/host.js')

let liveConfig = {
  providers: {
    rustvy: { displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', api: 'openai-completions', baseURL: `${ORIGIN}/v1`, models: [{ id: MODEL, name: MODEL, maxTokens: 8192 }] },
  },
}
const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: liveConfig }, fiber: {} }
let route = null
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
  on: () => () => {},
}
ctx.webServer = { register: r => { route = r; return () => { route = null } } }
ctx.configEditor = {
  entries: () => [entry],
  configuration: () => [{ entry, inherited: {}, override: {} }],
  edit: async (target, change) => {
    const next = change(structuredClone(target.options.config ?? {}), {})
    target.options.config = next
    liveConfig = next
  },
}
const handle = await start(ctx, {})

const call = (method, path, body) => new Promise((resolve, reject) => {
  const request = new EventEmitter()
  request.method = method
  request.url = path
  request.socket = { remoteAddress: '127.0.0.1' }
  request.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
  const chunks = []
  const response = {
    status: 0,
    headers: {},
    writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); return this },
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
  setTimeout(() => reject(new Error(`timeout ${method} ${path}`)), 30_000).unref()
})

// --- the collector is the source, and the provider is not consulted ------------
const mirrored = await call('GET', '/dsh-rustvy/catalog.json')
check('the catalogue answers', mirrored.status === 200, String(mirrored.status))
// Proven by a field only the collector sends: `vendorLabel` and `icon` live in the
// catalogue and never on the provider's `/v1/models`, so their presence in the mirror is
// evidence of the source rather than of a successful call. Asserting on ids alone would
// pass on a provider fallback that happened to serve the same ids.
const records = mirrored.json?.records ?? []
const qwenRecord = records.find(record => record.id === 'qwen3.8-max')
check('the catalogue metadata came from the collector', qwenRecord?.vendorLabel === 'Qwen' && qwenRecord?.icon === 'qwen.svg', JSON.stringify({ vendorLabel: qwenRecord?.vendorLabel, icon: qwenRecord?.icon }))
check('the collector catalogue is what is mirrored', records.some(record => record.id === 'qwen3.8-max'), JSON.stringify(records.map(record => record.id)))

// --- matching: the icon belongs to the id the picker shows -------------------
// Both the canonical id and its zonal twin are in the catalogue with the same name and
// icon. The picker shows the canonical one, so the badge has to resolve there; a test that
// only asserted "qwen.svg is cached" would pass while the shown model stayed bare.
const canonical = records.find(record => record.id === 'qwen3.8-max')
const twin = records.find(record => record.id === 'abyss/qwen3.8-max')
check('the canonical model carries its icon name', canonical?.icon === 'qwen.svg', String(canonical?.icon))
check('the zonal twin does not shadow it', twin?.icon === 'qwen.svg' && twin.id !== canonical.id, JSON.stringify({ twin: twin?.id, canonical: canonical?.id }))
check('a model with no icon name still has its record rather than vanishing', records.some(record => record.id === 'kimi-k3' && record.icon === ''), JSON.stringify(records.filter(record => record.id === 'kimi-k3').map(record => record.icon)))

// --- capacities survive all the way into the written route --------------------
// The assertion lead asked for: not that the collector serves the fields, but that they
// reach the route profile after a write. The mapping between is where they were going to
// be lost, so a check on `/api/catalog` alone could not see it.
const applied = await call('POST', '/dsh-rustvy/apply-models', {})
check('the write was accepted', applied.status === 200 && applied.json?.applied === true, JSON.stringify(applied.json && { applied: applied.json.applied, error: applied.json.error }))
const written = liveConfig.providers.rustvy.models ?? []
const qwen = written.find(model => model.id === 'qwen3.8-max')
check('the written route serves the canonical qwen id', qwen !== undefined, JSON.stringify(written.map(model => model.id)))
// `contextK` is thousands, and the ×1000 is this side's job; the collector deliberately
// publishes the provider's own unit so that the multiplication cannot be mistaken for data.
check('the context window survived as a token count', qwen?.contextWindow === 1_000_000, String(qwen?.contextWindow))
check('the output cap survived', qwen?.maxTokens === 128_000, String(qwen?.maxTokens))
check('the modalities survived as the adapter input list', JSON.stringify(qwen?.input) === '["text","image"]', JSON.stringify(qwen?.input))
check('the reasoning levels survived', qwen?.reasoningEfforts?.high === 'high', JSON.stringify(qwen?.reasoningEfforts))
const glm = written.find(model => model.id === 'glm-5.3')
check('a model whose cap differs from the default kept its own', glm?.maxTokens === 8192, String(glm?.maxTokens))
check('and its narrower modality list was not widened', JSON.stringify(glm?.input) === '["text"]', JSON.stringify(glm?.input))

// --- icons come from the collector, with the provider behind it ----------------
// The refresh above already warmed the logo set the catalogue names. Provenance is
// unambiguous here for a structural reason: this fixture's provider answers JSON to every
// path, so it can never satisfy `isSvgDocument`. An icon in the local cache therefore came
// from the collector, and `iconRequests` says the collector was the one asked.
const stateAfterIcons = await call('GET', '/dsh-rustvy/state')
check('the collector was asked for icons', iconRequests > 0, String(iconRequests))
check('an icon reached the local cache from it', (stateAfterIcons.json?.logos ?? 0) > 0, String(stateAfterIcons.json?.logos))

// --- the refresh button forces the collector to re-sync ----------------------
// The catalogue the collector serves is otherwise whatever the hourly job last left there,
// so re-reading locally would be a button that appears to work and cannot. The host forces
// the sync and reports the outcome; a failed sync changes nothing locally.
const syncsBefore = syncRequests
const refreshed = await call('POST', '/dsh-rustvy/refresh', {})
check('the refresh answers', refreshed.status === 200, String(refreshed.status))
check('it asked the collector to re-sync', syncRequests === syncsBefore + 1, `${syncsBefore} → ${syncRequests}`)
check('and reports what the sync did', refreshed.json?.collectorSync?.attempted === true && refreshed.json?.collectorSync?.synced === true, JSON.stringify(refreshed.json?.collectorSync))
check('the catalogue still arrives after the sync', (refreshed.json?.records ?? []).some(record => record.id === 'qwen3.8-max'), JSON.stringify((refreshed.json?.records ?? []).map(record => record.id)))

// --- an old collector falls back to the provider ------------------------------
// The backward-compatibility rule: the criterion is a *usable* catalogue, not a status
// code. An empty list is the collector saying it has not synced, and the provider is then
// still the better answer.
collectorUp = false
const fellBack = await call('GET', '/dsh-rustvy/catalog.json')
check('an unreachable collector does not fail the catalogue', fellBack.status === 200, String(fellBack.status))
check('it fell back to the provider', fellBack.json?.source !== 'collector', String(fellBack.json?.source))
check('the provider was consulted this time', providerHits > 0, String(providerHits))
collectorUp = true
catalogOverride = []
const emptyCatalog = await call('GET', '/dsh-rustvy/catalog.json')
check('an empty catalogue is not usable either, so the provider still answers', emptyCatalog.json?.source !== 'collector', String(emptyCatalog.json?.source))
catalogOverride = null

await handle.dispose()
collector.close()
provider.close()
rmSync(PROFILE, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}