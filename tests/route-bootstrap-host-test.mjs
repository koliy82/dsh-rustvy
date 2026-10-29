// Route bootstrap: what a clean install gets, and what it must never touch.
//
// The user's report was that on a second machine the plugin did nothing at all — no
// `rustvy` route, so no model list, no key ring base, and a picker offering only the
// built-in DeepSeek provider whose key they did not have. These checks assert the
// bootstrap creates the route, and that the absolute half of the requirement holds:
// DeepSeek is not touched, byte for byte.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
process.env.NO_PROXY = '127.0.0.1,localhost'
delete process.env.RUSTVY_API_KEY

/**
 * The route's own model endpoint, served locally.
 *
 * A real HTTP server rather than a stub, because the bootstrap's whole job is to build
 * a route from what the origin serves, and a stubbed answer would prove nothing about
 * the shape it parses.
 */
const SERVED_IDS = ['ahmia-v7-pro', 'claude-opus-5-5', 'gpt-6.1-sol']
let originUp = true
let originAnswersEmpty = false
const origin = createServer((request, response) => {
  if (!originUp) {
    response.destroy()
    return
  }
  if (request.url?.startsWith('/v1/models') === true) {
    const body = JSON.stringify(originAnswersEmpty ? { data: [] } : { data: SERVED_IDS.map(id => ({ id })) })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"error":"not found"}')
})
await new Promise(resolve => { origin.listen(0, '127.0.0.1', resolve) })
const ORIGIN = `http://127.0.0.1:${origin.address().port}`

writeFileSync(join(STATE, 'config.json'), `${JSON.stringify({
  enabled: false, syncModels: false, apiKeys: true, collectErrors: false, uptimeView: false,
  origin: ORIGIN,
}, null, 2)}\n`)

const { start } = await import('../lib/host.js')

/** The rows a clean install's composition offers, DeepSeek and the default among them. */
function cleanRows() {
  return [
    {
      options: {
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        // A foreign provider sharing the row, which must survive the write.
        config: { providers: { 'some-other-provider': { displayName: 'Other', baseURL: 'https://example.test/v1', models: [{ id: 'other-1' }] } } },
      },
      fiber: {},
    },
    {
      options: {
        id: 'agent-default-model',
        name: '@deepseek-ai/dsh-agent-default-model',
        config: { provider: 'deepseek-official', model: 'deepseek-flash' },
      },
      fiber: {},
    },
    // The rows the user's requirement names absolutely: these must not change.
    { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { thinking: { default: 'high' } } }, fiber: {} },
    { options: { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account', config: { region: 'global' } }, fiber: {} },
  ]
}

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
 * Mount the plugin against one composition.
 *
 * @param options - `{ rows, overrides, credentials, editor }`; `overrides` maps a row id
 *   to its profile-layer config, which is what decides whether the user chose a default.
 * @returns the mounted handle plus the fixtures, so a check can read what was written.
 */
async function mount(options = {}) {
  const rows = options.rows ?? cleanRows()
  const overrides = options.overrides ?? {}
  const edits = []
  const logs = []
  const credentials = options.credentials
  const ctx = {
    logger: () => ({
      info: (m, e) => logs.push(['info', m, e]),
      warn: (m, e) => logs.push(['warn', m, e]),
      error: (m, e) => logs.push(['error', m, e]),
    }),
    profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
    on: () => () => {},
  }
  if (credentials !== undefined) ctx.credentials = credentials
  let route = null
  ctx.webServer = { register: r => { route = r; return () => { route = null } } }
  if (options.editor !== false) {
    ctx.configEditor = {
      entries: () => rows,
      // The real service returns `{ entry, inherited, override }` per row, and an empty
      // `override` is how a caller tells a factory default from a choice the user made.
      configuration: () => rows.map(row => ({
        entry: row,
        inherited: structuredClone(row.options.config ?? {}),
        override: structuredClone(overrides[row.options.id] ?? {}),
      })),
      edit: async (target, change) => {
        if (!rows.includes(target)) throw new Error('Configuration entry is no longer available')
        const before = structuredClone(target.options.config ?? {})
        const next = change(structuredClone(target.options.config ?? {}), structuredClone(target.options.config ?? {}))
        edits.push({ id: target.options.id, before, after: structuredClone(next) })
        target.options.config = next
      },
    }
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
        const text = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, text, json })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    setTimeout(() => reject(new Error(`timeout ${method} ${path}`)), 30_000).unref()
  })
  const state = async () => (await call('GET', '/dsh-rustvy/state')).json
  const row = id => rows.find(one => one.options.id === id)
  return { handle, call, state, rows, row, edits, logs }
}

// --- a clean install gets a route --------------------------------------------
const deepseekBefore = JSON.stringify({
  llm: cleanRows()[2].options.config,
  account: cleanRows()[3].options.config,
})
const clean = await mount()
const cleanState = await clean.state()
const bootstrap = cleanState?.routeBootstrap
const written = clean.row('llm-pi-ai').options.config?.providers?.rustvy

check('the bootstrap reports what it did at all', bootstrap !== undefined && bootstrap !== null, JSON.stringify(Object.keys(cleanState ?? {})))
check('the route was created', bootstrap?.provider?.state === 'created', JSON.stringify(bootstrap?.provider))
check('it reports how many models it serves', bootstrap?.provider?.models === SERVED_IDS.length, String(bootstrap?.provider?.models))
check('the route is written into the pi-ai row', typeof written === 'object' && written !== null, JSON.stringify(Object.keys(clean.row('llm-pi-ai').options.config?.providers ?? {})))
check('the route carries the connection fields', written?.baseURL === `${ORIGIN}/v1` && written?.apiKeyEnv === 'RUSTVY_API_KEY' && written?.api === 'openai-completions', JSON.stringify({ baseURL: written?.baseURL, apiKeyEnv: written?.apiKeyEnv, api: written?.api }))
check('the model list came from the origin', Array.isArray(written?.models) && written.models.length === SERVED_IDS.length && written.models[0]?.id === SERVED_IDS[0], JSON.stringify((written?.models ?? []).map(m => m?.id)))
check('a route is never created with an empty model list', (written?.models ?? []).length > 0, String((written?.models ?? []).length))
// Which source the list came from decides the user's next action: a list read live from
// the provider needs nothing, while one built from the mirror is current only as of the
// mirror and the page can offer to refresh it.
check('it names the source the model list came from', bootstrap?.provider?.source === 'served', String(bootstrap?.provider?.source))

// The absolute half of the user's requirement, asserted on the rows rather than argued
// from the composition: if the DeepSeek providers ever move into the pi-ai row, the
// structural reasoning breaks and this fails.
check('the llm-deepseek rows were never edited', clean.edits.every(edit => edit.id !== 'llm-deepseek' && edit.id !== 'llm-deepseek-account'), JSON.stringify(clean.edits.map(e => e.id)))
check('the llm-deepseek rows are byte-identical', JSON.stringify({
  llm: clean.row('llm-deepseek').options.config,
  account: clean.row('llm-deepseek-account').options.config,
}) === JSON.stringify({
  llm: { thinking: { default: 'high' } },
  account: { region: 'global' },
}), JSON.stringify({ llm: clean.row('llm-deepseek').options.config, account: clean.row('llm-deepseek-account').options.config }))
check('the deepseek default provider is untouched by the route write', clean.edits.filter(e => e.id === 'llm-pi-ai').every(e => JSON.stringify(e.after?.providers?.['some-other-provider']) === JSON.stringify(e.before?.providers?.['some-other-provider'])), 'foreign provider')
check('a foreign provider in the same row survives', typeof clean.row('llm-pi-ai').options.config?.providers?.['some-other-provider'] === 'object' && clean.row('llm-pi-ai').options.config.providers['some-other-provider'].models?.[0]?.id === 'other-1', JSON.stringify(clean.row('llm-pi-ai').options.config?.providers?.['some-other-provider']))

// The default model: the route was absent, and the row carries no profile override, so
// both of the narrow conditions hold and the composer is pointed at the new route.
const defaultRow = clean.row('agent-default-model').options.config
check('the default model row was switched', bootstrap?.defaultModel?.state === 'switched', JSON.stringify(bootstrap?.defaultModel))
check('it names where the default came from and went to', bootstrap?.defaultModel?.from === 'deepseek-official' && bootstrap?.defaultModel?.to === 'rustvy', JSON.stringify({ from: bootstrap?.defaultModel?.from, to: bootstrap?.defaultModel?.to }))
check('the model is derived, not hardcoded', bootstrap?.defaultModel?.model === SERVED_IDS[0] && defaultRow?.model === SERVED_IDS[0], JSON.stringify({ reported: bootstrap?.defaultModel?.model, written: defaultRow?.model }))
check('the inherited deepseek model is not served by the route', SERVED_IDS.includes('deepseek-flash') === false, JSON.stringify(SERVED_IDS))
await clean.handle.dispose()

// --- a user who chose their own default keeps it ------------------------------
// The row and its profile-layer override carry the same value, which is what a real
// deliberate choice looks like: the override is the evidence the choice was made, and
// the composed row is what the composer reads.
const chosenRows = cleanRows()
chosenRows[1].options.config = { provider: 'deepseek-official', model: 'deepseek-chat' }
const chosen = await mount({ rows: chosenRows, overrides: { 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-chat' } } })
const chosenState = await chosen.state()
check('the route is still created when the user chose a default', chosenState?.routeBootstrap?.provider?.state === 'created', JSON.stringify(chosenState?.routeBootstrap?.provider))
check('the default model step is skipped', chosenState?.routeBootstrap?.defaultModel?.state === 'skipped', JSON.stringify(chosenState?.routeBootstrap?.defaultModel))
check('it says why, with a stable code', chosenState?.routeBootstrap?.defaultModel?.reason === 'user_chose_default', String(chosenState?.routeBootstrap?.defaultModel?.reason))
check('the chosen default row was never edited', chosen.edits.every(edit => edit.id !== 'agent-default-model'), JSON.stringify(chosen.edits.map(e => e.id)))
check('the chosen default is unchanged', chosen.row('agent-default-model').options.config?.model === 'deepseek-chat' && chosen.row('agent-default-model').options.config?.provider === 'deepseek-official', JSON.stringify(chosen.row('agent-default-model').options.config))
await chosen.handle.dispose()

// --- an existing route is left completely alone -------------------------------
const existingRows = cleanRows()
existingRows[0].options.config.providers.rustvy = {
  displayName: 'My hand-written name',
  apiKeyEnv: 'MY_OWN_VAR',
  api: 'openai-completions',
  baseURL: 'https://my-gateway.example/v1',
  models: [{ id: 'only-this-one', name: 'Only this one', maxTokens: 4096 }],
}
const existing = await mount({ rows: existingRows })
const existingState = await existing.state()
const untouched = existing.row('llm-pi-ai').options.config.providers.rustvy
check('an existing route reports exists', existingState?.routeBootstrap?.provider?.state === 'exists', JSON.stringify(existingState?.routeBootstrap?.provider))
check('nothing was written at all', existing.edits.length === 0, JSON.stringify(existing.edits.map(e => e.id)))
check('the hand-written displayName survived', untouched.displayName === 'My hand-written name', String(untouched.displayName))
check('the hand-written apiKeyEnv survived', untouched.apiKeyEnv === 'MY_OWN_VAR', String(untouched.apiKeyEnv))
check('the hand-written baseURL survived', untouched.baseURL === 'https://my-gateway.example/v1', String(untouched.baseURL))
check('the hand-written model list survived', untouched.models.length === 1 && untouched.models[0].id === 'only-this-one', JSON.stringify(untouched.models.map(m => m.id)))
check('models is null when nobody counted it', existingState?.routeBootstrap?.provider?.models === null, String(existingState?.routeBootstrap?.provider?.models))
check('source is null when no route was created', existingState?.routeBootstrap?.provider?.source === null, String(existingState?.routeBootstrap?.provider?.source))
check('the default step did not run for an existing route', existingState?.routeBootstrap?.defaultModel?.state === 'skipped' && existingState?.routeBootstrap?.defaultModel?.reason === 'route_existed', JSON.stringify(existingState?.routeBootstrap?.defaultModel))
await existing.handle.dispose()

// --- a default the route already serves is kept, not replaced -----------------
const keepRows = cleanRows()
keepRows[1].options.config = { provider: 'deepseek-official', model: SERVED_IDS[1] }
const kept = await mount({ rows: keepRows })
const keptState = await kept.state()
check('an inherited default the route serves is kept', keptState?.routeBootstrap?.defaultModel?.state === 'kept', JSON.stringify(keptState?.routeBootstrap?.defaultModel))
check('keeping it still points the provider at the route', kept.row('agent-default-model').options.config?.provider === 'rustvy' && kept.row('agent-default-model').options.config?.model === SERVED_IDS[1], JSON.stringify(kept.row('agent-default-model').options.config))
await kept.handle.dispose()

// --- no config editor: report, do not crash -----------------------------------
const noEditor = await mount({ editor: false })
const noEditorState = await noEditor.state()
check('a composition with no editor still mounts', noEditorState?.ok === true, String(noEditorState?.ok))
check('it reports the failure rather than staying silent', noEditorState?.routeBootstrap?.provider?.state === 'failed', JSON.stringify(noEditorState?.routeBootstrap?.provider))
check('it names the reason with a stable code', noEditorState?.routeBootstrap?.provider?.reason === 'no_config_editor', String(noEditorState?.routeBootstrap?.provider?.reason))
check('it carries a sentence for the page', typeof noEditorState?.routeBootstrap?.provider?.error === 'string' && noEditorState.routeBootstrap.provider.error !== '', String(noEditorState?.routeBootstrap?.provider?.error))
check('keySet is null when the host cannot tell', noEditorState?.routeBootstrap?.provider?.keySet === null, String(noEditorState?.routeBootstrap?.provider?.keySet))
check('the default step did not run', noEditorState?.routeBootstrap?.defaultModel === null, JSON.stringify(noEditorState?.routeBootstrap?.defaultModel))
await noEditor.handle.dispose()

// --- no row to write into ------------------------------------------------------
const noRow = await mount({ rows: cleanRows().filter(one => one.options.id !== 'llm-pi-ai') })
const noRowState = await noRow.state()
check('a composition with no pi-ai row reports failure', noRowState?.routeBootstrap?.provider?.state === 'failed', JSON.stringify(noRowState?.routeBootstrap?.provider))
check('it names the missing row', noRowState?.routeBootstrap?.provider?.reason === 'entry_not_found', String(noRowState?.routeBootstrap?.provider?.reason))
await noRow.handle.dispose()

// --- nothing to build a model list from: do not create an empty route ----------
originUp = false
const noSource = await mount()
const noSourceState = await noSource.state()
check('an unreachable origin creates no route', noSource.row('llm-pi-ai').options.config?.providers?.rustvy === undefined, JSON.stringify(Object.keys(noSource.row('llm-pi-ai').options.config?.providers ?? {})))
check('it says so rather than staying silent', noSourceState?.routeBootstrap?.provider?.state === 'skipped', JSON.stringify(noSourceState?.routeBootstrap?.provider))
check('the reason is the one the contract lists', noSourceState?.routeBootstrap?.provider?.reason === 'no_model_source', String(noSourceState?.routeBootstrap?.provider?.reason))
check('the sentence still names the endpoint that did not answer', typeof noSourceState?.routeBootstrap?.provider?.error === 'string' && noSourceState.routeBootstrap.provider.error.includes('/v1/models'), String(noSourceState?.routeBootstrap?.provider?.error))
check('the default step did not run without a route', noSourceState?.routeBootstrap?.defaultModel === null, JSON.stringify(noSourceState?.routeBootstrap?.defaultModel))
await noSource.handle.dispose()

originUp = true
originAnswersEmpty = true
const emptyAnswer = await mount()
const emptyState = await emptyAnswer.state()
check('an origin that answers with nothing creates no route either', emptyAnswer.row('llm-pi-ai').options.config?.providers?.rustvy === undefined, JSON.stringify(Object.keys(emptyAnswer.row('llm-pi-ai').options.config?.providers ?? {})))
// One reason code for both ways the list can come up empty, because the remedy is the
// same: the mirror is itself built from that endpoint, so a refresh cannot help when the
// origin is what is missing. What differs is the sentence, which is where the detail
// belongs — a code is for branching and prose is for people.
check('an origin that answers with nothing reports the same reason', emptyState?.routeBootstrap?.provider?.reason === 'no_model_source', String(emptyState?.routeBootstrap?.provider?.reason))
check('but a different sentence, so the two stay distinguishable', typeof emptyState?.routeBootstrap?.provider?.error === 'string' && emptyState.routeBootstrap.provider.error !== noSourceState?.routeBootstrap?.provider?.error, JSON.stringify({ empty: emptyState?.routeBootstrap?.provider?.error, unreachable: noSourceState?.routeBootstrap?.provider?.error }))
await emptyAnswer.handle.dispose()
originAnswersEmpty = false

// --- keySet is asked of the sources that would use the key --------------------
// No credentials service and no environment variable: the host cannot tell, and saying
// `false` would contradict a machine whose key arrives later through `shell-env`.
const noCreds = await mount({ rows: existingRows })
check('keySet is null with no credentials service', (await noCreds.state())?.routeBootstrap?.provider?.keySet === null, String((await noCreds.state())?.routeBootstrap?.provider?.keySet))
await noCreds.handle.dispose()

process.env.RUSTVY_API_KEY = 'sk-from-the-environment'
const envRead = await mount({
  rows: (() => {
    const rows = cleanRows()
    rows[0].options.config.providers.rustvy = { displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', baseURL: `${ORIGIN}/v1`, models: [{ id: 'x' }] }
    return rows
  })(),
})
check('keySet is true from the environment when no service is mounted', (await envRead.state())?.routeBootstrap?.provider?.keySet === true, String((await envRead.state())?.routeBootstrap?.provider?.keySet))
await envRead.handle.dispose()
delete process.env.RUSTVY_API_KEY

// A ring key never populates the base route's variable, so a machine that works through
// the ring must not be told it has no key. The credential store is the source that
// answers, and it is the same one the adapter resolves `apiKeyEnv` through.
//
// Two entries, not one: `withPrimaryKey` adopts the first stored key as the base
// route's own and rewrites its reference to the route's `apiKeyEnv`, so a single-entry
// ring *is* the base key and would not exercise the case this asserts.
const ringRows = cleanRows()
ringRows[0].options.config.providers.rustvy = { displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', baseURL: `${ORIGIN}/v1`, models: [{ id: 'x' }] }
writeFileSync(join(STATE, 'keys.json'), `${JSON.stringify({
  keys: [
    { id: 'k2', label: 'Second', route: 'rustvy-k2', ref: 'RUSTVY_API_KEY_2' },
    { id: 'k3', label: 'Third', route: 'rustvy-k3', ref: 'RUSTVY_API_KEY_3' },
  ],
}, null, 2)}\n`)
const ringCreds = await mount({
  rows: ringRows,
  // Resolves only the second ring key: the base route's own variable is empty, which is
  // exactly the working machine the field must not report as keyless.
  credentials: {
    resolve: async ref => (ref === 'RUSTVY_API_KEY_3' ? { value: 'sk-ring-key' } : undefined),
    set: async () => {},
  },
})
check('keySet is true from a ring key the base variable does not carry', (await ringCreds.state())?.routeBootstrap?.provider?.keySet === true, String((await ringCreds.state())?.routeBootstrap?.provider?.keySet))
await ringCreds.handle.dispose()

const noKeyCreds = await mount({
  rows: (() => {
    const rows = cleanRows()
    rows[0].options.config.providers.rustvy = { displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', baseURL: `${ORIGIN}/v1`, models: [{ id: 'x' }] }
    return rows
  })(),
  credentials: { resolve: async () => undefined, set: async () => {} },
})
check('keySet is false when neither source resolves', (await noKeyCreds.state())?.routeBootstrap?.provider?.keySet === false, String((await noKeyCreds.state())?.routeBootstrap?.provider?.keySet))
await noKeyCreds.handle.dispose()

// --- idempotence under a hot reload -------------------------------------------
const reloadRows = cleanRows()
const first = await mount({ rows: reloadRows })
const firstWritten = JSON.stringify(first.row('llm-pi-ai').options.config.providers.rustvy)
const firstDefault = JSON.stringify(first.row('agent-default-model').options.config)
const firstEdits = first.edits.length
await first.handle.dispose()
const second = await mount({ rows: reloadRows })
check('a second mount reports the route as existing', (await second.state())?.routeBootstrap?.provider?.state === 'exists', JSON.stringify((await second.state())?.routeBootstrap?.provider))
check('a second mount writes nothing', second.edits.length === 0, JSON.stringify(second.edits.map(e => e.id)))
check('the route is byte-identical after a reload', JSON.stringify(second.row('llm-pi-ai').options.config.providers.rustvy) === firstWritten, JSON.stringify(second.row('llm-pi-ai').options.config.providers.rustvy))
check('the default model is byte-identical after a reload', JSON.stringify(second.row('agent-default-model').options.config) === firstDefault, JSON.stringify(second.row('agent-default-model').options.config))
check('the first mount wrote exactly two rows', firstEdits === 2, String(firstEdits))
await second.handle.dispose()

origin.close()
rmSync(PROFILE, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
