// Host-half integration test: real routes, real origin, fake webServer and
// fake configEditor seeded with the profile's actual installed route.
import { EventEmitter } from 'node:events'
import { mkdirSync, copyFileSync, existsSync, rmSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Isolate the plugin's cache into a throwaway profile dir, then seed it from this
// machine's real mirror when there is one, so the island join is exercised against
// data nobody had to invent. Without a seed the test still passes: an empty mirror
// makes the host half re-read the catalog the first time it meets a model it does
// not know, which is the same path a first install takes.
const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-rustvy-test-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(join(STATE, 'logos'), { recursive: true })
const seed = join(
  process.env.DSH_PROFILE_DIR
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop'),
  '.dsh-rustvy', 'catalog.json',
)
if (existsSync(seed)) {
  copyFileSync(seed, join(STATE, 'catalog.json'))
  console.log(`note: seeded the mirror from ${seed}`)
} else {
  console.log(`note: no mirror to seed from (${seed}); the catalog will be read from the origin`)
}
process.env.DSH_PROFILE_DIR = PROFILE

const { start, build } = await import('../lib/host.js')

// The route exactly as the profile has it installed today.
const installedModels = [
  { id: 'claude-fable-5-1', name: 'claude-fable-5-1', maxTokens: 128000 },
  { id: 'claude-opus-5-5', name: 'claude-opus-5-5', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }, compat: { supportsDeveloperRole: true } },
  { id: 'claude-opus-5', name: 'claude-opus-5', maxTokens: 128000 },
  { id: 'glm-5.3', name: 'glm-5.3', maxTokens: 8192 },
  { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', maxTokens: 128000 },
  { id: 'fable-ultra-promax', name: 'fable-ultra-promax', maxTokens: 128000, compat: { supportsStore: true } },
]

let liveConfig = {
  providers: {
    rustvy: {
      displayName: 'rustvy',
      apiKeyEnv: 'RUSTVY_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://rustvy.xyz/v1',
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
check('plan offers ahmia-v7-pro', (p.added ?? []).includes('ahmia-v7-pro'), (p.added ?? []).join(', '))
check('plan retires claude-opus-5', (p.removed ?? []).includes('claude-opus-5'), (p.removed ?? []).join(', '))
check('plan retires fable-ultra-promax', (p.removed ?? []).includes('fable-ultra-promax'))
check('plan reports drift', p.upToDate === false, String(p.upToDate))
check('plan generated 12 entries', p.count === 12, String(p.count))

const ahmia = (p.entries ?? []).find(e => e.id === 'ahmia-v7-pro')
check('ahmia-v7-pro is fully described',
  ahmia?.name === 'Ahmia 7 Pro' && ahmia?.contextWindow === 1000000 && ahmia?.maxTokens === 128000
  && JSON.stringify(ahmia?.input) === '["text","image"]'
  && ahmia?.reasoningEfforts?.low === 'low' && ahmia?.reasoningEfforts?.max === 'max',
  JSON.stringify(ahmia))
check('ahmia-v7-pro carries no unknown field',
  Object.keys(ahmia ?? {}).every(k => ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'].includes(k)),
  Object.keys(ahmia ?? {}).join(', '))
check('glm-5.3 keeps its 8192 output cap',
  (p.entries ?? []).find(e => e.id === 'glm-5.3')?.maxTokens === 8192,
  String((p.entries ?? []).find(e => e.id === 'glm-5.3')?.maxTokens))

// A wire-compatibility switch is knowledge about the gateway that no catalog can
// supply, so it is the one field carried forward rather than regenerated.
check('a hand-written compat survives regeneration',
  (p.entries ?? []).find(e => e.id === 'claude-opus-5-5')?.compat?.supportsDeveloperRole === true,
  JSON.stringify((p.entries ?? []).find(e => e.id === 'claude-opus-5-5')?.compat))
check('compat is never invented for other models',
  (p.entries ?? []).filter(e => e.id !== 'claude-opus-5-5').every(e => e.compat === undefined),
  (p.entries ?? []).filter(e => e.compat !== undefined).map(e => e.id).join(', ') || 'none')

// --- paths and the manual-edit block ---------------------------------------
check('/state names every file this half touches',
  String(state.json?.paths?.catalog ?? '').endsWith('catalog.json')
  && String(state.json?.paths?.config ?? '').endsWith('config.json')
  && String(state.json?.paths?.backup ?? '').endsWith('models-backup.json')
  && state.json?.paths?.cache !== undefined,
  JSON.stringify(state.json?.paths))
check('/state names the profile patch document',
  state.json?.paths?.patch === 'C:\\profile\\cordis.patch.yml', String(state.json?.paths?.patch))
check('the plan carries the endpoint it reads', p.modelsUrl === 'https://rustvy.xyz/v1/models', String(p.modelsUrl))
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
  yaml.text.includes('baseURL: https://rustvy.xyz/v1')
  && yaml.text.includes('apiKeyEnv: RUSTVY_API_KEY')
  && yaml.text.includes('api: openai-completions'))
check('the block carries the generated models',
  yaml.text.includes('- id: ahmia-v7-pro') && yaml.text.includes('name: Ahmia 7 Pro'))
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
  && written.api === 'openai-completions' && written.baseURL === 'https://rustvy.xyz/v1',
  JSON.stringify({ displayName: written.displayName, api: written.api, baseURL: written.baseURL }))
check('route now serves 12 models', written.models.length === 12, String(written.models.length))
check('route now serves ahmia-v7-pro', written.models.some(m => m.id === 'ahmia-v7-pro'))
check('route no longer serves claude-opus-5', !written.models.some(m => m.id === 'claude-opus-5'))
check('claude-opus-5-5 kept its full description',
  JSON.stringify(written.models.find(m => m.id === 'claude-opus-5-5')?.reasoningEfforts)
  === '{"off":null,"low":"low","medium":"medium","high":"high","max":"max"}',
  JSON.stringify(written.models.find(m => m.id === 'claude-opus-5-5')))

const backupFile = join(PROFILE, '.dsh-rustvy', 'models-backup.json')
check('a backup was written', existsSync(backupFile))
const backup = JSON.parse(readFileSync(backupFile, 'utf8'))
check('backup holds the previous models',
  backup?.config?.providers?.rustvy?.models?.some(m => m.id === 'fable-ultra-promax'), String(backup?.at))

// The plan the write just resolved must not keep being reported as drift.
const stateAfter = await call('GET', '/dsh-rustvy/state')
check('/state drops the drift the write resolved',
  stateAfter.json?.modelSync?.upToDate === true && stateAfter.json?.modelSync?.installedCount === 12,
  JSON.stringify({ upToDate: stateAfter.json?.modelSync?.upToDate, installed: stateAfter.json?.modelSync?.installedCount }))

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
  && !liveConfig.providers.rustvy.models.some(m => m.id === 'ahmia-v7-pro'),
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

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (logs.filter(l => l[0] === 'error').length > 0) {
  console.log('\nerror logs:')
  for (const [, m, e] of logs.filter(l => l[0] === 'error')) console.log(`  ${m} ${e?.message ?? e ?? ''}`)
}
// `process.exit()` here can trip a libuv assertion on Windows while undici sockets
// from the origin fetches are still closing; setting the code lets teardown finish.
process.exitCode = failed.length === 0 ? 0 : 1
