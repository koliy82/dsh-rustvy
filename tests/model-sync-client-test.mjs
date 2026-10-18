// Client-half render test: mini-React + stubbed DOM, no browser needed.
// Drives the settings page against a fixture /state and asserts what it shows.

const results = []
function check(label, ok, detail) {
  results.push(ok === true)
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/* ------------------------------- DOM stub ------------------------------- */
function element(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    attributes: {},
    textContent: '',
    value: '',
    setAttribute(k, v) { this.attributes[k] = v },
    removeAttribute(k) { delete this.attributes[k] },
    appendChild(node) { this.children.push(node); return node },
    remove() {},
    select() {},
    blur() {},
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
  }
}
const documentStub = {
  head: element('head'),
  documentElement: element('html'),
  body: element('body'),
  createElement: element,
  createTextNode: text => ({ text }),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => true,
}
const YAML_TEXT = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      rustvy:\n        models:\n          - id: ahmia-v7-pro\n            name: Ahmia 7 Pro\n'
const requests = []
const STATE = {
  ok: true,
  build: 'rustvy-1',
  revision: 'test.1',
  config: {
    enabled: true, origin: 'https://rustvy.xyz', size: 16, markTrigger: true, hideOtherMarks: true,
    syncModels: true, modelRoute: 'rustvy', modelEntryId: 'llm-pi-ai', modelAutoApply: 'explicit',
    modelNameSource: 'displayName', modelOfferOff: true, modelKeepUnknown: false, modelZones: ['standard'],
  },
  version: 130,
  fetchedAt: '2026-10-18T21:00:00.000Z',
  refreshing: false,
  models: 27,
  logos: 12,
  route: 'fetch',
  proxy: 'none',
  cacheDir: 'C:\\profile\\.dsh-rustvy',
  paths: {
    cache: 'C:\\profile\\.dsh-rustvy',
    catalog: 'C:\\profile\\.dsh-rustvy\\catalog.json',
    config: 'C:\\profile\\.dsh-rustvy\\config.json',
    backup: 'C:\\profile\\.dsh-rustvy\\models-backup.json',
    patch: 'C:\\profile\\cordis.patch.yml',
  },
  node: 'v22',
  absentLogos: [],
  logoFailures: {},
  modelSync: {
    available: true,
    entryId: 'llm-pi-ai',
    packageName: '@deepseek-ai/dsh-llm-pi-ai',
    route: 'rustvy',
    baseURL: 'https://rustvy.xyz/v1',
    modelsUrl: 'https://rustvy.xyz/v1/models',
    providerFields: { displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', api: 'openai-completions', baseURL: 'https://rustvy.xyz/v1' },
    source: 'endpoint',
    attemptedAt: '2026-10-18T21:00:00.000Z',
    count: 12,
    installedCount: 13,
    upToDate: false,
    added: ['ahmia-v7-pro', 'deepseek-v4.1-flash-1017'],
    removed: ['claude-opus-5', 'fable-ultra-promax'],
    changed: [{ id: 'glm-5.3', fields: [{ field: 'name', before: 'glm-5.3', after: 'GLM 5.3' }] }],
    notes: [],
    kept: [],
    entries: [{ id: 'ahmia-v7-pro', name: 'Ahmia 7 Pro' }],
    backup: null,
  },
}
globalThis.document = documentStub
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
// Node 24 exposes a read-only `navigator` with no clipboard, so `copyText` takes
// its textarea + execCommand branch here — which is the path worth exercising,
// since it is the one a page without clipboard permission has to survive.
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load: descriptor => { globalThis.__descriptor = descriptor } },
}
globalThis.fetch = async (url, init = {}) => {
  const path = String(url)
  const method = (init.method ?? 'GET').toUpperCase()
  requests.push({ path, method, body: init.body })
  if (path.includes('/models.yaml')) return { ok: true, status: 200, text: async () => YAML_TEXT }
  const payload = path.endsWith('/apply-models')
    ? { ok: true, applied: true, count: 12, plan: STATE.modelSync }
    : path.endsWith('/revert-models')
      ? { ok: true, reverted: true, from: '2026-10-18T20:00:00.000Z', plan: STATE.modelSync }
      : path.endsWith('/catalog.json')
        ? { ok: true, enabled: true, config: STATE.config, records: [], count: 27, logos: 12 }
        : STATE
  return { ok: true, status: 200, json: async () => payload }
}

/* --------------------- mini React, one hook store per component ---------- */
// Keyed by component type plus its occurrence index within one render, not by a
// global counter: the page's shape changes between its first render (no status
// yet) and the next, so a positional counter would hand a CopyButton the cells
// the page itself used a moment ago. Real React keys by instance identity.
const storesByKey = new Map()
let occurrences = new Map()
let activeHooks = []
let hookIndex = 0
let effects = []
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    if (typeof type === 'function') {
      const seen = occurrences.get(type) ?? 0
      occurrences.set(type, seen + 1)
      const key = `${type.name || 'anonymous'}#${seen}`
      const store = storesByKey.get(key) ?? []
      storesByKey.set(key, store)
      const prevHooks = activeHooks
      const prevIndex = hookIndex
      activeHooks = store
      hookIndex = 0
      const rendered = type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat })
      activeHooks = prevHooks
      hookIndex = prevIndex
      return rendered
    }
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    const store = activeHooks
    const index = hookIndex++
    if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
    const set = value => { store[index] = typeof value === 'function' ? value(store[index]) : value }
    return [store[index], set]
  },
  useCallback(fn) { return fn },
  useEffect(fn) { effects.push(fn) },
  useMemo(fn) { return fn() },
}

await import('../client/client.js')
const descriptor = globalThis.__descriptor
check('the bundle registered itself', descriptor?.id === 'dsh-rustvy', String(descriptor?.id))

const loaded = descriptor.factory(name => (name === 'react' ? React : undefined))
check('the factory returned a plugin', loaded?.name === 'dsh-rustvy' && typeof loaded.apply === 'function')

let renderPage = null
let sectionLabel = null
const disposers = []
loaded.apply({
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  slots: {
    inject: (_name, fn) => { fn() },
    register: (registered, render) => { renderPage = render; sectionLabel = registered.label(); return () => {} },
  },
})
check('the settings page was registered', typeof renderPage === 'function')
check('the settings section is named Rustvy', sectionLabel === 'Rustvy', String(sectionLabel))

/* ------------------------------ tree walking ---------------------------- */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (node.children !== undefined) textOf(node.children, out)
  return out
}
function allText(node) { return textOf(node).join(' ') }
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}
function collect(node, type) {
  const out = []
  walk(node, item => { if (item.type === type) out.push(item) })
  return out
}
function findButton(node, label) {
  return collect(node, 'button').find(item => allText(item).includes(label))
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

/**
 * One render pass. Effects are drained here, the way React runs them after the
 * paint: a field that follows the host's answer does so through an effect, so a
 * stub that never runs them reports the pre-effect value and hides exactly the
 * re-sync this page depends on.
 */
function render() {
  occurrences = new Map()
  const tree = renderPage()
  for (const fn of effects.splice(0)) {
    try {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch { /* an effect that throws is the page's problem, not the stub's */ }
  }
  return tree
}

/** Render until the effects of the previous pass have settled into the tree. */
async function view() {
  let tree
  for (let pass = 0; pass < 3; pass++) {
    tree = render()
    await settle()
  }
  return tree
}

/* ------------------------------- rendering ------------------------------ */
effects = []
let tree = await view()
let text = allText(tree)

check('the page is titled Rustvy', collect(tree, 'h2').some(item => allText(item) === 'Rustvy'),
  collect(tree, 'h2').map(allText).join('|'))
check('the page still names the provider-models block', text.includes('Модели провайдера'))
check('the page names the mirror block', text.includes('Зеркало каталога'))

// --- outbound links --------------------------------------------------------
const links = collect(tree, 'a')
const hrefs = links.map(item => item.props.href)
check('the provider site is a real link', hrefs.includes('https://rustvy.xyz'), hrefs.join(' '))
check('the catalog page is a real link', hrefs.includes('https://rustvy.xyz/models'))
check('the models endpoint is a real link', hrefs.includes('https://rustvy.xyz/v1/models'))
check('every link opens outside the app', links.every(item => item.props.target === '_blank' && /noreferrer/.test(String(item.props.rel ?? ''))))

// --- copyable paths --------------------------------------------------------
const pathText = allText(tree)
for (const path of Object.values(STATE.paths)) {
  check(`the path ${path.split('\\').pop()} is shown`, pathText.includes(path))
}
check('paths offer a copy button', collect(tree, 'button').filter(b => allText(b) === 'копировать').length >= 5,
  String(collect(tree, 'button').filter(b => allText(b) === 'копировать').length))

// --- editable fields -------------------------------------------------------
const texts = collect(tree, 'input').filter(item => item.props.type === 'text')
const numbers = collect(tree, 'input').filter(item => item.props.type === 'number')
const selects = collect(tree, 'select')
const boxes = collect(tree, 'input').filter(item => item.props.type === 'checkbox')
check('the route is editable', texts.some(item => item.props.value === 'rustvy'), texts.map(i => i.props.value).join('|'))
check('the profile row is editable', texts.some(item => item.props.value === 'llm-pi-ai'))
check('the origin is editable', texts.some(item => item.props.value === 'https://rustvy.xyz'))
check('the mark size is editable', numbers.length === 1 && numbers[0].props.value === '16', JSON.stringify(numbers.map(i => i.props.value)))
check('both dropdowns render', selects.length === 2, String(selects.length))
check('auto-apply defaults to explicit', selects[0]?.props.value === 'explicit', String(selects[0]?.props.value))
check('the name source defaults to the provider label', selects[1]?.props.value === 'displayName', String(selects[1]?.props.value))
check('six switches render', boxes.length === 6, String(boxes.length))

// editing a field saves through /config; focusing first is what a real edit does,
// and it is what keeps the field from re-syncing over the keystroke
const routeField = texts.find(item => item.props.value === 'rustvy')
routeField.props.onFocus()
routeField.props.onChange({ target: { value: 'rustvy-2' } })
tree = await view()
const edited = collect(tree, 'input').filter(i => i.props.type === 'text').find(i => i.props.value === 'rustvy-2')
check('a field holds what was typed before it is saved', edited !== undefined)
edited.props.onBlur()
await settle()
check('blurring the field posts the new value',
  requests.some(r => r.path.endsWith('/config') && JSON.parse(r.body).modelRoute === 'rustvy-2'),
  JSON.stringify(requests.filter(r => r.path.endsWith('/config')).map(r => r.body)))

// a dropdown saves on change
selects[0].props.onChange({ target: { value: 'always' } })
await settle()
check('changing the dropdown posts the new mode',
  requests.some(r => r.path.endsWith('/config') && JSON.parse(r.body).modelAutoApply === 'always'))

// --- YAML panel ------------------------------------------------------------
tree = await view()
check('the manual-edit block is offered', findButton(tree, 'Показать блок для ручной правки') !== undefined)
findButton(tree, 'Показать блок для ручной правки').props.onClick()
await settle()
tree = await view()
const pre = collect(tree, 'pre')
check('the YAML panel fetched and shows the block', pre.length === 1 && pre[0].children.join('').includes('ahmia-v7-pro'),
  String(pre[0]?.children?.join('').slice(0, 60)))
check('the YAML was read from the host route', requests.some(r => r.path.includes('/models.yaml')))
check('the YAML panel offers to copy it', findButton(tree, 'копировать YAML') !== undefined)

// --- drift and the write path ---------------------------------------------
tree = await view()
text = allText(tree)
check('the page lists the new models', text.includes('ahmia-v7-pro') && text.includes('deepseek-v4.1-flash-1017'))
check('the page lists the retired models', text.includes('claude-opus-5') && text.includes('fable-ultra-promax'))
check('the page names the changed field', text.includes('glm-5.3') && text.includes('name'))
check('the write button is enabled while drift exists', findButton(tree, 'Записать список моделей').props.disabled === false)
check('revert is disabled with no backup', findButton(tree, 'Откатить к предыдущему').props.disabled === true)

requests.length = 0
findButton(tree, 'Записать список моделей').props.onClick()
await settle()
tree = await view()
text = allText(tree)
check('the write was posted to the host', requests.some(r => r.path.endsWith('/apply-models')), JSON.stringify(requests.map(r => r.path)))
check('the notice reports what moved', text.includes('Записано 12 моделей') && text.includes('ahmia-v7-pro'))
check('the notice names the retired models', text.includes('Убраны') && text.includes('fable-ultra-promax'))

STATE.modelSync = { ...STATE.modelSync, upToDate: true, added: [], removed: [], changed: [] }
tree = await view()
check('the write button is disabled once current', findButton(tree, 'Записать список моделей').props.disabled === true)
check('the page says the list is current', allText(tree).includes('список актуален'))

STATE.modelSync = { ...STATE.modelSync, upToDate: false, available: false, added: ['ahmia-v7-pro'] }
tree = await view()
check('a read-only host is explained', allText(tree).includes('configEditor'))
check('the write button is disabled without an editor', findButton(tree, 'Записать список моделей').props.disabled === true)

STATE.modelSync = { ...STATE.modelSync, available: true, backup: '2026-10-18T20:00:00.000Z' }
tree = await view()
check('revert is enabled once a backup exists', findButton(tree, 'Откатить к предыдущему').props.disabled === false)
requests.length = 0
findButton(tree, 'Откатить к предыдущему').props.onClick()
await settle()
check('the revert was posted', requests.some(r => r.path.endsWith('/revert-models')))
check('the revert notice carries the restored moment', allText(await view()).includes('откачен'))

for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } }
check('unload ran without throwing', true)

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
