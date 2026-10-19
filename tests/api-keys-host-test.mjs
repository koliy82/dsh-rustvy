// Host-half key-ring test: fake credentials store, fake configEditor, fake event
// bus, no network. Everything here runs against a throwaway profile directory and
// a route whose endpoint is a closed port, so the test is deterministic offline.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-rustvy-keys-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

// Icons off (no origin reads), model sync on (so a write can be asked for), and a
// closed-port endpoint so the served-list read fails immediately and the mirrored
// island decides membership instead.
writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: false,
  syncModels: true,
  modelAutoApply: 'explicit',
  apiKeys: true,
}, null, 2)}\n`)
writeFileSync(join(STATE, 'catalog.json'), `${JSON.stringify({
  version: 'test-island',
  fetchedAt: new Date().toISOString(),
  records: [
    {
      id: 'claude-opus-5-5', displayName: 'OPUS 5.5', vendor: 'anthropic', vendorLabel: 'Anthropic',
      icon: 'claude.svg', provider: '', zone: 'standard', contextK: 1000, contextWindow: 1000000,
      maxOutputTokens: 128000, modalities: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high'],
      inputPer1M: null, outputPer1M: null, hot: false, free: false, enabled: true, sortOrder: 1,
    },
    {
      id: 'glm-5.3', displayName: 'GLM 5.3', vendor: 'zhipu', vendorLabel: 'Zhipu',
      icon: 'zhipu.svg', provider: '', zone: 'standard', contextK: 1000, contextWindow: 1000000,
      maxOutputTokens: 8192, modalities: ['text'], reasoningLevels: ['low', 'high'],
      inputPer1M: null, outputPer1M: null, hot: false, free: false, enabled: true, sortOrder: 2,
    },
  ],
}, null, 2)}\n`)

const { start, build } = await import('../lib/host.js')

const SECRET_ONE = 'sk-live-primary-0001'
const SECRET_TWO = 'sk-live-second-0002'

/** The credential store, in the shape `dsh-credentials-local` answers. */
const refs = new Map([['RUSTVY_API_KEY', SECRET_ONE]])
const credentials = {
  async resolve(ref) {
    return refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined
  },
  async describe(ref) {
    return { configured: refs.has(ref), source: refs.has(ref) ? 'file' : undefined, writable: true }
  },
  async set(ref, value) {
    if (typeof value !== 'string' || value === '') throw new Error('a credential value must not be empty')
    refs.set(ref, value)
  },
  async unset(ref) {
    refs.delete(ref)
  },
}

/** The route exactly as a profile declares it, plus a neighbour that is not ours. */
let liveConfig = {
  providers: {
    rustvy: {
      displayName: 'rustvy',
      apiKeyEnv: 'RUSTVY_API_KEY',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'claude-opus-5-5', name: 'OPUS 5.5', maxTokens: 128000 }],
    },
    'deepseek-official': {
      displayName: 'DeepSeek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      api: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
    },
  },
}

const entry = {
  options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: liveConfig },
  fiber: {},
}
const edits = []
const logs = []
const listeners = new Map()

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
      const next = change(structuredClone(liveConfig), {})
      edits.push({ before: structuredClone(liveConfig), after: structuredClone(next) })
      liveConfig = next
      entry.options.config = liveConfig
    },
  },
  on: (event, listener) => {
    listeners.set(event, listener)
    return () => {
      if (listeners.get(event) === listener) listeners.delete(event)
    }
  },
}

let route = null
ctx.webServer = { register: registered => { route = registered; return () => { route = null } } }

const handle = await start(ctx, {})

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = method
    request.url = path
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19388', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); return this },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        const text = Buffer.concat(chunks.map(chunk => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, headers: this.headers, text, json })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    setTimeout(() => reject(new Error(`timeout on ${method} ${path}`)), 30_000).unref()
  })
}

const results = []
function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/** Run one `agent/request` dispatch through the listener this half installed. */
async function request(sessionId, proposed) {
  const listener = listeners.get('agent/request')
  if (typeof listener !== 'function') throw new Error('no agent/request listener was installed')
  return listener({ agent: { session: { id: sessionId } }, turn: 1, step: 1 }, async () => proposed)
}

const providers = () => liveConfig.providers

// --- mount -----------------------------------------------------------------
check('the swap listener is installed', typeof listeners.get('agent/request') === 'function')
const state = await call('GET', '/dsh-rustvy/state')
check(`/state answers 200 for build ${build}`, state.status === 200 && state.json?.build === build, String(state.json?.build))
check('/state reports the ring', state.json?.apiKeys?.count === 1, JSON.stringify(state.json?.apiKeys))
check('/state reports the credentials service', state.json?.apiKeys?.credentials === true)

// --- the ring as a fresh profile has it ------------------------------------
const first = await call('GET', '/dsh-rustvy/keys')
check('GET /keys answers 200', first.status === 200, `status ${first.status}`)
check('the primary key is derived from the route', first.json?.keys?.[0]?.primary === true, JSON.stringify(first.json?.keys?.[0]))
check('the primary key keeps the route reference', first.json?.keys?.[0]?.ref === 'RUSTVY_API_KEY')
check('the primary key keeps the route name', first.json?.keys?.[0]?.route === 'rustvy')
check('a stored key reports present', first.json?.keys?.[0]?.present === true)
check('a stored key is masked', first.json?.keys?.[0]?.masked === 'sk-…01', String(first.json?.keys?.[0]?.masked))
check('no key value is served', !first.text.includes(SECRET_ONE))
check('the ring reports its own files', typeof first.json?.paths?.keys === 'string' && typeof first.json?.paths?.picks === 'string')
check('a lone key hides no group', (first.json?.hiddenGroups ?? []).length === 0)

// --- adding a key ----------------------------------------------------------
const added = await call('POST', '/dsh-rustvy/keys', { action: 'add', key: SECRET_TWO, label: 'Второй' })
check('POST /keys add answers 200', added.status === 200, `status ${added.status}`)
check('add reports ok', added.json?.ok === true, added.text.slice(0, 200))
check('add stored the value under a new reference', refs.get('RUSTVY_API_KEY_2') === SECRET_TWO)
check('add cloned the route', typeof providers()['rustvy-k2'] === 'object', JSON.stringify(Object.keys(providers())))
check('the clone points at the new reference', providers()['rustvy-k2']?.apiKeyEnv === 'RUSTVY_API_KEY_2')
check('the clone keeps the endpoint', providers()['rustvy-k2']?.baseURL === 'http://127.0.0.1:9/v1')
check('the clone keeps the protocol', providers()['rustvy-k2']?.api === 'openai-completions')
check('the clone keeps the model list', JSON.stringify(providers()['rustvy-k2']?.models) === JSON.stringify(providers().rustvy.models))
check('the clone is named for the key', providers()['rustvy-k2']?.displayName === 'rustvy · Второй', String(providers()['rustvy-k2']?.displayName))
check('the base route was not rewritten', providers().rustvy.apiKeyEnv === 'RUSTVY_API_KEY' && providers().rustvy.displayName === 'rustvy')
check('a neighbouring provider was not touched', JSON.stringify(providers()['deepseek-official']) === JSON.stringify({
  displayName: 'DeepSeek',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  api: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
}))
check('one configuration write was spent', edits.length === 1, `${edits.length} edit(s)`)
check('the ring document holds no secret', existsSync(join(STATE, 'keys.json')) && !readFileSync(join(STATE, 'keys.json'), 'utf8').includes(SECRET_TWO))
check('the ring document names the clone', JSON.parse(readFileSync(join(STATE, 'keys.json'), 'utf8')).keys.some(key => key.route === 'rustvy-k2'))

const two = await call('GET', '/dsh-rustvy/keys')
check('the ring now lists two keys', two.json?.keys?.length === 2, String(two.json?.keys?.length))
check('the second key is masked too', two.json?.keys?.[1]?.masked === 'sk-…02', String(two.json?.keys?.[1]?.masked))
check('the clone group is hidden from the picker', (two.json?.hiddenGroups ?? []).includes('rustvy · Второй'), JSON.stringify(two.json?.hiddenGroups))
check('no key value is served after an add', !two.text.includes(SECRET_TWO) && !two.text.includes(SECRET_ONE))

const rejected = await call('POST', '/dsh-rustvy/keys', { action: 'add', key: '  ' })
check('an empty key is refused', rejected.json?.ok === false && rejected.status === 409, `${rejected.status} ${rejected.json?.error}`)
const spaced = await call('POST', '/dsh-rustvy/keys', { action: 'add', key: 'sk has a space' })
check('a key with a space is refused', spaced.json?.ok === false, String(spaced.json?.error))
const unknown = await call('POST', '/dsh-rustvy/keys', { action: 'frobnicate' })
check('an unknown action is refused 400', unknown.status === 400 && unknown.json?.ok === false, `status ${unknown.status}`)

// --- per-chat picks --------------------------------------------------------
const picked = await call('POST', '/dsh-rustvy/session-key', { sessionId: 'sess-1', keyId: 'k2' })
check('POST /session-key answers 200', picked.status === 200, `status ${picked.status}`)
check('the pick is reported back', picked.json?.keyId === 'k2', String(picked.json?.keyId))
check('the pick is persisted', JSON.parse(readFileSync(join(STATE, 'session-keys.json'), 'utf8')).picks['sess-1'] === 'k2')

const swapped = await request('sess-1', { provider: 'rustvy', model: 'claude-opus-5-5', reasoningEffort: 'high', maxTokens: 4096 })
check('a picked key renames the route', swapped.provider === 'rustvy-k2', JSON.stringify(swapped))
check('the model survives the swap', swapped.model === 'claude-opus-5-5')
check('the effort survives the swap', swapped.reasoningEffort === 'high')
check('the rest of the call survives the swap', swapped.maxTokens === 4096)

const untouched = await request('sess-2', { provider: 'rustvy', model: 'claude-opus-5-5' })
check('a chat with no pick keeps the base route', untouched.provider === 'rustvy', JSON.stringify(untouched))
const foreign = await request('sess-1', { provider: 'deepseek-account', model: 'deepseek-chat' })
check('the DeepSeek account route is never renamed', foreign.provider === 'deepseek-account', JSON.stringify(foreign))
const official = await request('sess-1', { provider: 'deepseek-official', model: 'deepseek-chat' })
check('a neighbouring api-key route is never renamed', official.provider === 'deepseek-official')
const anonymous = await request(undefined, { provider: 'rustvy', model: 'claude-opus-5-5' })
check('a request with no session is left alone', anonymous.provider === 'rustvy')

const badSession = await call('GET', '/dsh-rustvy/session-key')
check('a session key read without an id is refused', badSession.status === 400, `status ${badSession.status}`)
const readPick = await call('GET', '/dsh-rustvy/session-key?sessionId=sess-1')
check('a session key read reports the pick', readPick.json?.keyId === 'k2' && readPick.json?.picked === true, JSON.stringify({ keyId: readPick.json?.keyId, picked: readPick.json?.picked }))

const defaulted = await call('POST', '/dsh-rustvy/keys', { action: 'default', id: 'k2' })
check('a default key is accepted', defaulted.json?.ok === true && defaulted.json?.defaultKeyId === 'k2', String(defaulted.json?.defaultKeyId))
const byDefault = await request('sess-9', { provider: 'rustvy', model: 'claude-opus-5-5' })
check('a chat with no pick follows the default key', byDefault.provider === 'rustvy-k2', JSON.stringify(byDefault))
const unserved = await request('sess-9', { provider: 'rustvy', model: 'glm-5.3' })
check('a model the clone does not serve stays on the base route', unserved.provider === 'rustvy', JSON.stringify(unserved))
const reported = await call('GET', '/dsh-rustvy/keys')
check('the refused swap is reported, not silent', typeof reported.json?.fallback?.reason === 'string' && reported.json?.fallback?.model === 'glm-5.3', JSON.stringify(reported.json?.fallback))
const backToDefault = await call('POST', '/dsh-rustvy/session-key', { sessionId: 'sess-1', keyId: null })
check('a null pick returns a chat to the default', backToDefault.json?.ok === true && backToDefault.json?.keyId === 'k2', JSON.stringify(backToDefault.json?.keyId))
await call('POST', '/dsh-rustvy/keys', { action: 'default', id: 'k1' })
await call('POST', '/dsh-rustvy/session-key', { sessionId: 'sess-9', keyId: 'k2' })

// --- a model-list write covers every route ---------------------------------
const applied = await call('POST', '/dsh-rustvy/apply-models')
check('apply-models answers 200', applied.status === 200, `status ${applied.status}`)
check('apply wrote the generated list', applied.json?.applied === true, JSON.stringify({ applied: applied.json?.applied, error: applied.json?.error }))
check('the base route serves the island list', (providers().rustvy.models ?? []).length === 2, String((providers().rustvy.models ?? []).length))
check('the clone serves the same list', JSON.stringify(providers()['rustvy-k2'].models) === JSON.stringify(providers().rustvy.models))
check('the clone kept its own reference through the write', providers()['rustvy-k2'].apiKeyEnv === 'RUSTVY_API_KEY_2')
const servedNow = await request('sess-9', { provider: 'rustvy', model: 'glm-5.3' })
check('after the write the clone serves that model too', servedNow.provider === 'rustvy-k2', JSON.stringify(servedNow))
const yaml = await call('GET', '/dsh-rustvy/models.yaml?cached=1')
check('the pasteable block carries the clone', yaml.text.includes('rustvy-k2:') && yaml.text.includes('RUSTVY_API_KEY_2'), yaml.text.slice(0, 120))

// --- rename, replace, repair, remove ---------------------------------------
const renamed = await call('POST', '/dsh-rustvy/keys', { action: 'rename', id: 'k2', label: 'Рабочий' })
check('a rename is accepted', renamed.json?.ok === true, renamed.text.slice(0, 160))
check('a rename follows into the display name', providers()['rustvy-k2'].displayName === 'rustvy · Рабочий', String(providers()['rustvy-k2'].displayName))
check('a rename keeps the reference', providers()['rustvy-k2'].apiKeyEnv === 'RUSTVY_API_KEY_2')

const replaced = await call('POST', '/dsh-rustvy/keys', { action: 'set', id: 'k2', key: 'sk-live-rotated-0003' })
check('a value can be replaced', replaced.json?.ok === true && refs.get('RUSTVY_API_KEY_2') === 'sk-live-rotated-0003')
check('replacing a value writes no configuration', edits.length === 3, `${edits.length} edit(s)`)

delete liveConfig.providers['rustvy-k2']
entry.options.config = liveConfig
const repaired = await call('POST', '/dsh-rustvy/keys', { action: 'repair' })
check('a lost route is reported', (repaired.json?.routes?.missing ?? []).includes('rustvy-k2') || repaired.json?.ok === true, JSON.stringify(repaired.json?.routes))
check('repair wrote the route back', typeof providers()['rustvy-k2'] === 'object', JSON.stringify(Object.keys(providers())))

const tested = await call('POST', '/dsh-rustvy/keys', { action: 'test', id: 'k2' })
check('a key test answers without throwing', tested.status === 200 && tested.json?.test?.id === 'k2', JSON.stringify(tested.json?.test))
check('a key test against a closed port reports failure', tested.json?.test?.ok === false)

const primaryRemoval = await call('POST', '/dsh-rustvy/keys', { action: 'remove', id: 'k1' })
check('removing the primary key is refused', primaryRemoval.json?.ok === false && primaryRemoval.status === 409, String(primaryRemoval.json?.error))
check('the primary reference is still stored', refs.get('RUSTVY_API_KEY') === SECRET_ONE)

await call('POST', '/dsh-rustvy/session-key', { sessionId: 'sess-3', keyId: 'k2' })
const removed = await call('POST', '/dsh-rustvy/keys', { action: 'remove', id: 'k2' })
check('removing a key is accepted', removed.json?.ok === true, removed.text.slice(0, 200))
check('the clone route is gone', providers()['rustvy-k2'] === undefined, JSON.stringify(Object.keys(providers())))
check('the neighbouring provider survived the removal', providers()['deepseek-official'] !== undefined)
check('the base route survived the removal', providers().rustvy !== undefined)
check('the stored value is gone', refs.has('RUSTVY_API_KEY_2') === false)
check('the ring lists one key again', removed.json?.keys?.length === 1, String(removed.json?.keys?.length))
check('picks of a removed key are dropped', JSON.parse(readFileSync(join(STATE, 'session-keys.json'), 'utf8')).picks['sess-3'] === undefined)
const afterRemoval = await request('sess-3', { provider: 'rustvy', model: 'claude-opus-5-5' })
check('a chat whose key was removed keeps the base route', afterRemoval.provider === 'rustvy', JSON.stringify(afterRemoval))

// --- what the swap reports about itself ------------------------------------
const counters = await call('GET', '/dsh-rustvy/keys')
check('the routing counters saw every dispatch', (counters.json?.routing?.seen ?? 0) >= 8, JSON.stringify(counters.json?.routing))
check('the routing counters report the swaps', (counters.json?.routing?.applied ?? 0) === 3, JSON.stringify(counters.json?.routing))

// --- the switch ------------------------------------------------------------
writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: false, syncModels: true, apiKeys: false,
}, null, 2)}\n`)
await call('POST', '/dsh-rustvy/keys', { action: 'add', key: SECRET_TWO, label: 'Выключен' })
const offSwitch = await request('sess-1', { provider: 'rustvy', model: 'claude-opus-5-5' })
check('with the feature off no request is renamed', offSwitch.provider === 'rustvy', JSON.stringify(offSwitch))
const offState = await call('GET', '/dsh-rustvy/keys')
check('with the feature off the ring reports itself disabled', offState.json?.enabled === false)

// --- unload ----------------------------------------------------------------
await handle.dispose()
check('dispose released the route', route === null)
check('dispose released the listener', listeners.has('agent/request') === false)

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail === undefined ? '' : ` — ${result.detail}`}`)
  process.exit(1)
}
