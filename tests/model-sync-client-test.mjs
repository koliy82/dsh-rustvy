// Client-half render test: mini-React + stubbed DOM, no browser needed.
// Drives the settings page against a fixture /state and asserts what it shows.

const results = []
function check(label, ok, detail) {
  results.push(ok === true)
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/* ------------------------------- DOM stub ------------------------------- */
// The key section in the model picker is plain DOM this half owns, so a stub
// that answers every `querySelectorAll` with `[]` would prove nothing about it.
// What follows is a small real tree: elements hold children and a parent link,
// `classList` reads the `class` attribute, and the selector engine understands
// exactly the shapes this half writes — a tag, `.class`, `[attr]`, `[attr="v"]`
// and `[attr*="v"]`, comma-separated, matched against descendants or against the
// ancestor chain for `closest`. Anything else matches nothing, which is the same
// answer a browser gives for a selector the tree does not contain.

function parseSelector(selector) {
  return String(selector).split(',').map(part => part.trim()).filter(part => part !== '' && part !== '*').map(part => {
    const compound = { tag: null, classes: [], attrs: [] }
    const pattern = /([a-zA-Z][\w-]*)|\.([-\w]+)|\[([-\w]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]/gu
    for (const found of part.matchAll(pattern)) {
      if (found[1] !== undefined) compound.tag = found[1].toUpperCase()
      else if (found[2] !== undefined) compound.classes.push(found[2])
      else compound.attrs.push({ name: found[3], op: found[4], value: found[5] })
    }
    return compound
  })
}

function matchCompound(node, compound) {
  if (compound.tag !== null && node.tagName !== compound.tag) return false
  for (const name of compound.classes) {
    if (!node.classList.contains(name)) return false
  }
  for (const attr of compound.attrs) {
    const held = node.attributes[attr.name]
    if (held === undefined || held === null) return false
    if (attr.op === undefined) continue
    if (attr.op === '=') { if (String(held) !== attr.value) return false } else if (attr.op === '*=') {
      if (!String(held).includes(attr.value)) return false
    } else if (attr.op === '^=') {
      if (!String(held).startsWith(attr.value)) return false
    }
  }
  return true
}

function matchesSelector(node, selector) {
  return parseSelector(selector).some(compound => matchCompound(node, compound))
}

/** Every descendant in document order, parents before children. */
function descendants(node, out = []) {
  for (const child of node.children) {
    out.push(child)
    descendants(child, out)
  }
  return out
}

function stubElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    attributes: {},
    style: { setProperty() {}, removeProperty() {} },
    /**
     * `dataset` really writes `data-*` attributes, the way a browser reflects it.
     * A stub that kept it in a separate object would let the code under test
     * believe it had marked a row when nothing an inspector — or a CSS selector,
     * or this test — could see had been written.
     */
    get dataset() {
      const owner = this
      const nameOf = key => `data-${String(key).replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`
      return new Proxy({}, {
        get: (_target, key) => (typeof key === 'string' ? owner.attributes[nameOf(key)] : undefined),
        set: (_target, key, value) => { owner.setAttribute(nameOf(key), value); return true },
        has: (_target, key) => owner.attributes[nameOf(key)] !== undefined,
        deleteProperty: (_target, key) => { owner.removeAttribute(nameOf(key)); return true },
        ownKeys: () => Object.keys(owner.attributes).filter(name => name.startsWith('data-')),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      })
    },
    listeners: {},
    value: '',
    innerHTML: '',
    type: undefined,
    title: undefined,
    get classList() {
      const names = String(this.attributes.class ?? '').split(/\s+/u).filter(name => name !== '')
      return {
        contains: name => names.includes(name),
        add: name => { if (!names.includes(name)) this.setAttribute('class', [...names, name].join(' ')) },
        remove: name => this.setAttribute('class', names.filter(held => held !== name).join(' ')),
      }
    },
    get className() { return String(this.attributes.class ?? '') },
    set className(value) { this.setAttribute('class', value) },
    get firstChild() { return this.children[0] ?? null },
    get nextElementSibling() {
      const held = this.parentNode?.children ?? []
      return held[held.indexOf(this) + 1] ?? null
    },
    contains(other) { return other === this || descendants(this).includes(other) },
    get textContent() {
      return this.children.map(child => (child.nodeType === 3 ? child.text : child.textContent)).join('') + (this._text ?? '')
    },
    set textContent(value) { this.children = []; this._text = String(value) },
    /**
     * Text set through `textContent` lives in `_text`, so `childNodes` has to hand
     * it back as a text node. The decorator reads a row's name through
     * `childNodes`, and without this every name in the stub is the empty string —
     * which silently draws no marks at all and lets an assertion about removing
     * them pass without any ever having been drawn.
     */
    get childNodes() {
      const nodes = [...this.children]
      if (this._text !== undefined && this._text !== '') nodes.push(textNode(this._text))
      return nodes
    },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    hasAttribute(name) { return this.attributes[name] !== undefined },
    matches(selector) { return matchesSelector(this, selector) },
    closest(selector) {
      for (let node2 = this; node2 !== null && node2 !== undefined; node2 = node2.parentNode) {
        if (node2.nodeType === 1 && matchesSelector(node2, selector)) return node2
      }
      return null
    },
    querySelectorAll(selector) { return descendants(this).filter(node2 => matchesSelector(node2, selector)) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    appendChild(child) {
      child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1)
      child.parentNode = this
      this.children.push(child)
      return child
    },
    insertBefore(child, ref) {
      child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1)
      child.parentNode = this
      const at = ref === null || ref === undefined ? -1 : this.children.indexOf(ref)
      if (at < 0) this.children.push(child)
      else this.children.splice(at, 0, child)
      return child
    },
    remove() {
      const held = this.parentNode?.children ?? []
      const at = held.indexOf(this)
      if (at >= 0) held.splice(at, 1)
      this.parentNode = null
    },
    select() {},
    blur() {},
    focus() {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) {
      const held = this.listeners[type] ?? []
      const at = held.indexOf(fn)
      if (at >= 0) held.splice(at, 1)
    },
    /** Run this node's own handlers for one type, with a minimal event object. */
    fire(type, extra = {}) {
      const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra }
      for (const fn of [...(this.listeners[type] ?? [])]) fn(event)
      return event
    },
  }
  return node
}

const textNode = text => ({ nodeType: 3, text: String(text), textContent: String(text), children: [], parentNode: null, remove() {} })

const documentStub = stubElement('html')
documentStub.head = stubElement('head')
documentStub.body = stubElement('body')
documentStub.documentElement = documentStub
documentStub.createElement = stubElement
documentStub.createTextNode = textNode
documentStub.getElementById = () => null
documentStub.appendChild(documentStub.head)
documentStub.appendChild(documentStub.body)

/** Every listener registered on one target, so a test can fire a document event. */
function fireOn(target, type) {
  const event = { type, target, preventDefault() {}, stopPropagation() {} }
  for (const fn of [...(target.listeners[type] ?? [])]) fn(event)
  return event
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
    install: 'C:\\profile\\.dsh-rustvy\\install.json',
    errorsQueue: 'C:\\profile\\.dsh-rustvy\\errors-queue.json',
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
  // The error collector's summary, in the shape `docs/error-report.md` specifies.
  // `config.collectErrors` is deliberately absent from the fixture above: the
  // default is on, and a page that needed the field present to draw the switch as
  // on would draw it off for every host half older than the feature. The endpoint is
  // the public collector the host really defaults to, and `200` is the answer it
  // gives for an accepted report — the fixture uses the shipped contract, not an
  // invented one.
  errorReport: {
    enabled: true,
    endpoint: 'http://185.94.29.228:3789/api/report',
    installId: 'a3f0c81b7d4e4f2a9c6b5d8e1f0a2b3c',
    queued: 2,
    sent: 5,
    failed: 1,
    dropped: 0,
    folded: 3,
    attempts: 9,
    failures: 2,
    successes: 5,
    lastSentAt: 1792472700000,
    lastStatus: 200,
    lastError: null,
    byKind: { upstream_502: 4, connect_timeout: 2, dns: 1 },
    nextFlushAt: 1792473000000,
  },
}
globalThis.document = documentStub
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }

/* --------------------------- API-key fixtures --------------------------- */
// Exactly the shape `docs/api-keys.md` specifies, plus the fields the host half
// added on top of it: never a value, only a mask and a fingerprint, and per key
// the route it owns, whether that route is in the profile, how many models it
// serves and how many chats chose it.
const KEY_ONE = {
  id: 'k1', label: 'Основной', ref: 'RUSTVY_API_KEY', route: 'rustvy', displayName: 'rustvy',
  primary: true, present: true, installed: true, models: 12, masked: 'sk-…f8', fingerprint: '9f2c1a7b',
  createdAt: '2026-10-19T15:00:00.000Z', sessions: 3,
}
const KEY_TWO = {
  id: 'k2', label: 'Второй', ref: 'RUSTVY_API_KEY_2', route: 'rustvy-k2', displayName: 'rustvy · ключ 2',
  primary: false, present: true, installed: true, models: 12, masked: 'sk-…12', fingerprint: '4b7e0d31',
  createdAt: '2026-10-19T16:00:00.000Z', sessions: 1,
}
const KEYS_FIXTURE = {
  ok: true, enabled: true, credentials: true, editor: true,
  route: 'rustvy', entryId: 'llm-pi-ai', baseURL: 'https://rustvy.xyz/v1',
  packageName: '@deepseek-ai/dsh-llm-pi-ai', modelsUrl: 'https://rustvy.xyz/v1/models',
  maxKeys: 12,
  defaultKeyId: 'k1', keys: [KEY_ONE, KEY_TWO],
  hiddenGroups: ['rustvy · ключ 2', 'rustvy · ключ 3'],
  routes: { missing: [], stale: [] },
  routing: { seen: 7, applied: 5 },
  fallback: null,
  picks: 1,
  paths: { keys: 'C:\\profile\\.dsh-rustvy\\keys.json', picks: 'C:\\profile\\.dsh-rustvy\\session-keys.json' },
  error: null,
}
let KEYS = structuredClone(KEYS_FIXTURE)
/** `sessionId → keyId`, the host's own map; `null` means "the default". */
const SESSION_KEYS = { 's-1': null }
/** `'ok'`, or `'missing'` to answer 404 with an empty body like an older host half. */
let KEYS_MODE = 'ok'
/** `'ok'`, `'down'` for a transport failure, or `'refused'` for the collector's `400`. */
let ERRORS_MODE = 'ok'
/**
 * `'bare'` for the envelope `POST /dsh-rustvy/errors` really answers with — the
 * summary spread at the top level — or `'wrapped'` for the nested `errorReport`
 * block that only `GET /state` uses. The bare one is the default because it is the
 * branch production takes; the wrapped one exists so `noticeFor`'s tolerance for it
 * is asserted rather than merely written.
 */
let ERRORS_ENVELOPE = 'bare'

/** One host-side key mutation, answered with a fresh list plus the result field. */
function mutateKeys(body) {
  const find = id => KEYS.keys.find(key => key.id === id)
  if (body.action === 'add') {
    const id = `k${KEYS.keys.length + 1}`
    KEYS.keys.push({
      ...KEY_TWO, id, sessions: 0, primary: false,
      label: body.label === '' || body.label === undefined ? undefined : body.label,
      ref: `RUSTVY_API_KEY_${id.slice(1)}`,
      route: `rustvy-${id}`,
      displayName: `rustvy · ${id}`,
      masked: 'sk-…00',
    })
    return { ...KEYS, added: id }
  }
  if (body.action === 'remove') {
    if (find(body.id)?.primary === true) {
      return { ok: false, error: 'основной ключ не удаляется: он владеет маршрутом профиля' }
    }
    KEYS.keys = KEYS.keys.filter(key => key.id !== body.id)
    return { ...KEYS, removed: body.id }
  }
  if (body.action === 'rename') {
    const target = find(body.id)
    if (target !== undefined) target.label = body.label
    return { ...KEYS, updated: body.id }
  }
  if (body.action === 'set') return { ...KEYS, updated: body.id }
  if (body.action === 'repair') {
    // What the host does: rewrite the routes it is missing, then answer with a
    // list in which every key is installed and nothing is missing.
    for (const key of KEYS.keys) key.installed = true
    KEYS.routes = { missing: [], stale: KEYS.routes?.stale ?? [] }
    return { ...KEYS, repaired: true }
  }
  if (body.action === 'default') {
    KEYS.defaultKeyId = body.id
    return { ...KEYS, defaultKeyId: body.id }
  }
  if (body.action === 'test') {
    return body.id === 'k2'
      ? { ...KEYS, test: { id: body.id, ok: false, status: 401, models: 0, error: 'ключ отклонён провайдером' } }
      : { ...KEYS, test: { id: body.id, ok: true, status: 200, models: 12, error: null } }
  }
  return { ok: false, error: `неизвестное действие ${body.action}` }
}

const json = payload => ({ ok: true, status: 200, json: async () => payload })

// Node 24 exposes a read-only `navigator` with no clipboard, so `copyText` takes
// its textarea + execCommand branch here — which is the path worth exercising,
// since it is the one a page without clipboard permission has to survive.
const windowListeners = {}
globalThis.window = {
  addEventListener(type, fn) { (windowListeners[type] ??= []).push(fn) },
  removeEventListener(type, fn) {
    const held = windowListeners[type] ?? []
    const at = held.indexOf(fn)
    if (at >= 0) held.splice(at, 1)
  },
  // Real, because the settings page and the composer agree through this event: a
  // stub that swallowed it would hide the only sync the two surfaces have.
  dispatchEvent(event) {
    for (const fn of [...(windowListeners[event.type] ?? [])]) fn(event)
    return true
  },
  __ModuleLoader__: { load: descriptor => { globalThis.__descriptor = descriptor } },
}
globalThis.fetch = async (url, init = {}) => {
  const path = String(url)
  const method = (init.method ?? 'GET').toUpperCase()
  requests.push({ path, method, body: init.body })
  if (path.includes('/models.yaml')) return { ok: true, status: 200, text: async () => YAML_TEXT }
  if (/^\/dsh-rustvy\/(keys|session-key)/u.test(path) && KEYS_MODE === 'missing') {
    return { ok: false, status: 404, json: async () => { throw new Error('no body') } }
  }
  if (path.startsWith('/dsh-rustvy/keys')) {
    if (method === 'GET') return json(KEYS)
    return json(mutateKeys(JSON.parse(init.body ?? '{}')))
  }
  if (path.startsWith('/dsh-rustvy/session-key')) {
    if (method === 'GET') {
      const sessionId = new URL(path, 'http://local').searchParams.get('sessionId')
      return json({
        ok: true, sessionId, keyId: SESSION_KEYS[sessionId] ?? null,
        keys: KEYS.keys, hiddenGroups: KEYS.hiddenGroups,
        enabled: KEYS.enabled, credentials: KEYS.credentials,
      })
    }
    const body = JSON.parse(init.body ?? '{}')
    SESSION_KEYS[body.sessionId] = body.keyId ?? null
    return json({
      ok: true, sessionId: body.sessionId, keyId: body.keyId ?? null,
      keys: KEYS.keys, hiddenGroups: KEYS.hiddenGroups,
    })
  }
  // `/config` really is the same store `/keys` reads `enabled` from: a fixture
  // that accepted the write and then kept reporting the old value would let the
  // switch appear to work while proving nothing.
  if (path.endsWith('/config') && method === 'POST') {
    const body = JSON.parse(init.body ?? '{}')
    if (body.apiKeys !== undefined) KEYS.enabled = body.apiKeys !== false
    if (body.collectErrors !== undefined) STATE.config.collectErrors = body.collectErrors !== false
    return json(STATE)
  }
  // `/errors` answers with the fresh summary in the shape the host really sends —
  // `{ ok: true, ...summary }`, bare at the top level, where only `GET /state` nests
  // that same block as `errorReport`. `ERRORS_MODE` picks how the collector answers:
  // `'down'` is a transport failure with the reports still on disk, `'refused'` is a
  // `400` — a report the collector will not take and the host therefore drops rather
  // than retries. `ERRORS_ENVELOPE = 'wrapped'` answers the nested shape instead and
  // moves nothing at all, so one and the same summary can be read through both.
  if (path.endsWith('/errors')) {
    const body = JSON.parse(init.body ?? '{}')
    const report = STATE.errorReport
    if (method === 'POST' && ERRORS_ENVELOPE !== 'wrapped') {
      report.attempts += 1
      if (ERRORS_MODE === 'down') {
        report.failures += 1
        report.lastStatus = 0
        report.lastError = 'connect ECONNREFUSED 185.94.29.228:3789'
      } else if (ERRORS_MODE === 'refused') {
        report.failed += 1
        report.dropped += body.action === 'test' ? 1 : report.queued
        report.queued = body.action === 'test' ? report.queued : 0
        report.lastStatus = 400
        report.lastError = 'the collector answered 400'
      } else {
        report.successes += 1
        report.sent += body.action === 'test' ? 1 : report.queued
        report.queued = 0
        report.lastStatus = 200
        report.lastSentAt = 1792473300000
        report.lastError = null
      }
    }
    return json(ERRORS_ENVELOPE === 'wrapped'
      ? { ok: true, errorReport: report }
      : { ok: true, ...report })
  }
  const payload = path.endsWith('/apply-models')
    ? { ok: true, applied: true, count: 12, plan: STATE.modelSync }
    : path.endsWith('/revert-models')
      ? { ok: true, reverted: true, from: '2026-10-18T20:00:00.000Z', plan: STATE.modelSync }
      : path.endsWith('/catalog.json')
        ? { ok: true, enabled: true, config: STATE.config, records: [], count: 27, logos: 12 }
        : STATE
  return json(payload)
}
documentStub.execCommand = () => true

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

// One registration per slot, because this half fills two: the settings section
// and the composer's key selector. Keyed by what the harness keys it by.
const registrations = []
let renderPage = null
let renderKeyControl = null
const disposers = []
loaded.apply({
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  slots: {
    inject: (_name, fn) => { fn() },
    register: (registered, render) => {
      registrations.push({ ...registered, render })
      if (registered.name === 'settings.section') renderPage = render
      if (registered.id === 'rustvy-key') renderKeyControl = render
      return () => {}
    },
  },
})
const sectionLabel = registrations.find(item => item.name === 'settings.section')?.label()
const keySlot = registrations.find(item => item.id === 'rustvy-key')
check('the settings page was registered', typeof renderPage === 'function')
check('the settings section is named Rustvy', sectionLabel === 'Rustvy', String(sectionLabel))
// The key choice lives in exactly one place in a conversation: the composer's tool
// row, right after the permission/mode dropdown. The model picker stays about
// models, and the settings page is where keys are managed rather than chosen.
check('the composer key selector was registered', typeof renderKeyControl === 'function',
  registrations.map(item => item.id).join(', '))
check('the key selector sits in the composer tool row',
  keySlot?.name === 'conversation.input.left' && keySlot?.order === 60,
  `${String(keySlot?.name)}@${String(keySlot?.order)}`)
check('the key selector has its own label', keySlot?.label?.() === 'API-ключ', String(keySlot?.label?.()))
check('it is the only slot besides the settings section',
  registrations.length === 2, registrations.map(item => item.id).join(', '))

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
/**
 * One turn of the event loop, which is what drains the promise chains a fetch
 * answer arrives on.
 *
 * `setImmediate` rather than `setTimeout(0)`: both yield a full turn, but a zero
 * timer is clamped to the platform's clock granularity — about 15 ms on Windows —
 * and eight of them per render pass made this suite spend 15 s waiting on the
 * harness instead of exercising the code. Where there is no `setImmediate`, a
 * timer is still correct, only slower.
 *
 * One consequence worth knowing: a pass no longer advances the 16 ms frame the
 * decorator coalesces mutations into. Nothing here relies on that — the two
 * helpers that drive the decorator wait on a real timer of their own.
 */
const yieldTurn = typeof setImmediate === 'function'
  ? () => new Promise(resolve => setImmediate(resolve))
  : () => new Promise(resolve => setTimeout(resolve, 0))

async function settle() { for (let i = 0; i < 8; i++) await yieldTurn() }

/**
 * One render pass of one component. Effects are drained here, the way React runs
 * them after the paint: a field that follows the host's answer does so through an
 * effect, so a stub that never runs them reports the pre-effect value and hides
 * exactly the re-sync this page depends on.
 *
 * @param component - the slot's render function.
 * @param props - the standard props the slot hands it, if any.
 */
function renderComponent(component, props) {
  occurrences = new Map()
  const tree = component(props ?? {})
  for (const fn of effects.splice(0)) {
    try {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch { /* an effect that throws is the page's problem, not the stub's */ }
  }
  return tree
}

function render() { return renderComponent(renderPage) }

/** Render until the effects of the previous pass have settled into the tree. */
async function viewComponent(component, props) {
  let tree
  for (let pass = 0; pass < 3; pass++) {
    tree = renderComponent(component, props)
    await settle()
  }
  return tree
}

async function view() { return viewComponent(renderPage) }

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
check('eight switches render', boxes.length === 8, String(boxes.length))

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

/* ------------------------------- API keys ------------------------------- */
// The three surfaces share one state, so they are driven in the order a user
// meets them: the settings page adds a key, the composer picks one for a chat,
// and the picker offers the same choice where the effort levels are.
const SECRET = 'sk-test-value-do-not-leak'

/** One labelled field of a rendered tree, found the way a user finds it. */
function fieldOf(node, label) {
  return collect(node, 'input').find(item => item.props['aria-label'] === label)
}

/** Every button whose whole text is one label. */
function buttonsNamed(node, label) {
  return collect(node, 'button').filter(item => allText(item) === label)
}

/**
 * The key labels on the page.
 *
 * Read from the fields rather than from the text: a label is rendered as an
 * editable field's `value`, and `allText` only collects children — so a test that
 * looked for it in the text would pass on a page that showed no labels at all.
 */
function labelsOf(node) {
  return collect(node, 'input').filter(item => item.props.type === 'text').map(item => item.props.value)
}

tree = await view()
text = allText(tree)
check('the settings page names the keys section', text.includes('API-ключи'))
check('the key list is read from the host route',
  requests.some(item => item.path === '/dsh-rustvy/keys' && item.method === 'GET'),
  JSON.stringify(requests.map(item => item.path).slice(-4)))
check('both keys of the fixture are listed',
  labelsOf(tree).includes('Основной') && labelsOf(tree).includes('Второй'),
  labelsOf(tree).join('|'))
check('a key is shown by mask, ref, route and chat count',
  text.includes('sk-…f8') && text.includes('RUSTVY_API_KEY')
  && text.includes('маршрут rustvy') && text.includes('чатов: 3'))
check('the primary key explains why it cannot be deleted', text.includes('Основной ключ не удаляется'))
check('only the keys that may go offer a delete button',
  buttonsNamed(tree, 'Удалить').length === KEYS.keys.filter(key => key.primary !== true).length,
  String(buttonsNamed(tree, 'Удалить').length))
check('the key that is already default offers no "make default" button',
  buttonsNamed(tree, 'По умолчанию').length === KEYS.keys.length - 1,
  String(buttonsNamed(tree, 'По умолчанию').length))

// --- the "+" form ----------------------------------------------------------
check('no value field exists before "+" is pressed', fieldOf(tree, 'значение ключа') === undefined)
findButton(tree, '+').props.onClick()
await settle()
tree = await view()
check('"+" opens the inline add form', fieldOf(tree, 'значение ключа') !== undefined)
check('the add form takes a label, a submit and a cancel',
  fieldOf(tree, 'название ключа') !== undefined
  && findButton(tree, 'Добавить') !== undefined
  && findButton(tree, 'Отмена') !== undefined)
check('the value is masked until it is asked for', fieldOf(tree, 'значение ключа').props.type === 'password')
findButton(tree, 'показать').props.onClick()
tree = render()
check('the value can be shown and hidden again',
  fieldOf(tree, 'значение ключа').props.type === 'text' && findButton(tree, 'скрыть') !== undefined)

fieldOf(tree, 'название ключа').props.onChange({ target: { value: 'Рабочий' } })
fieldOf(tree, 'значение ключа').props.onChange({ target: { value: SECRET } })
tree = render()
requests.length = 0
findButton(tree, 'Добавить').props.onClick()
await settle()
const addRequest = requests.find(item => item.path === '/dsh-rustvy/keys' && item.method === 'POST')
check('the add was posted to /keys', addRequest !== undefined, JSON.stringify(requests.map(item => item.path)))
const addBody = JSON.parse(addRequest.body)
check('the add body carries the action, the value and the label',
  addBody.action === 'add' && addBody.key === SECRET && addBody.label === 'Рабочий',
  JSON.stringify({ ...addBody, key: '…' }))
check('no request carries the value in its URL', requests.every(item => !String(item.path).includes(SECRET)))
tree = await view()
check('the added key is listed', labelsOf(tree).includes('Рабочий'), labelsOf(tree).join('|'))
check('the form closed and the typed value is gone from the page',
  fieldOf(tree, 'значение ключа') === undefined && !allText(tree).includes(SECRET))
check('the notice names the route the new key got', allText(tree).includes('маршрут rustvy-k3'))

// --- rename on blur --------------------------------------------------------
requests.length = 0
const renameField = collect(tree, 'input').find(item => item.props.type === 'text' && item.props.value === 'Второй')
check('every key label is editable', renameField !== undefined)
renameField.props.onFocus()
renameField.props.onChange({ target: { value: 'Запасной' } })
tree = render()
collect(tree, 'input').find(item => item.props.value === 'Запасной').props.onBlur()
await settle()
check('renaming on blur posts the rename action',
  requests.some(item => item.method === 'POST' && JSON.parse(item.body ?? '{}').action === 'rename'
    && JSON.parse(item.body).label === 'Запасной'),
  JSON.stringify(requests.filter(item => item.method === 'POST').map(item => item.body)))

// --- checking a key --------------------------------------------------------
tree = await view()
requests.length = 0
check('every key can be checked', buttonsNamed(tree, 'Проверить').length === KEYS.keys.length,
  String(buttonsNamed(tree, 'Проверить').length))
buttonsNamed(tree, 'Проверить')[0].props.onClick()
await settle()
tree = await view()
check('"Проверить" posts the test action',
  requests.some(item => item.method === 'POST' && JSON.parse(item.body ?? '{}').action === 'test'))
check('a key that answers reports its status and model count',
  allText(tree).includes('HTTP 200') && allText(tree).includes('моделей 12'))
buttonsNamed(tree, 'Проверить')[1].props.onClick()
await settle()
tree = await view()
check('a key the provider rejects reports the rejection', allText(tree).includes('ключ отклонён провайдером'))

// --- the default key -------------------------------------------------------
tree = await view()
requests.length = 0
buttonsNamed(tree, 'По умолчанию')[0].props.onClick()
await settle()
check('"По умолчанию" posts the default action for that key',
  requests.some(item => item.method === 'POST' && JSON.parse(item.body ?? '{}').action === 'default'
    && JSON.parse(item.body).id === 'k2'),
  JSON.stringify(requests.filter(item => item.method === 'POST').map(item => item.body)))
tree = await view()
check('the section says which key is now the default', allText(tree).includes('Ключ по умолчанию — «Запасной»'))

// --- deleting a key --------------------------------------------------------
tree = await view()
requests.length = 0
buttonsNamed(tree, 'Удалить')[0].props.onClick()
tree = render()
check('delete asks before it acts',
  findButton(tree, 'Удалить навсегда') !== undefined && findButton(tree, 'Отмена') !== undefined)
findButton(tree, 'Удалить навсегда').props.onClick()
await settle()
check('the confirmed delete posts the remove action',
  requests.some(item => item.method === 'POST' && JSON.parse(item.body ?? '{}').action === 'remove'
    && JSON.parse(item.body).id === 'k2'),
  JSON.stringify(requests.filter(item => item.method === 'POST').map(item => item.body)))
tree = await view()
check('the deleted key is gone from the list', !allText(tree).includes('Запасной'))
check('the delete notice says where its chats now point', allText(tree).includes('основным'))

// --- a host that cannot take a key ----------------------------------------
KEYS.credentials = false
tree = await view()
check('a host without credentials explains itself', allText(tree).includes('credentials'))
check('the "+" button is disabled without credentials', findButton(tree, '+').props.disabled === true)
KEYS.credentials = true
tree = await view()
check('the "+" button comes back with the capability', findButton(tree, '+').props.disabled === false)

KEYS_MODE = 'missing'
tree = await view()
text = allText(tree)
check('an older host half is named as the reason', text.includes('устарела') && text.includes('/keys'))
check('no key is listed without the host route', !text.includes('sk-…f8'))
check('the "+" button is disabled without the host route', findButton(tree, '+').props.disabled === true)

KEYS_MODE = 'ok'
KEYS = structuredClone(KEYS_FIXTURE)
SESSION_KEYS['s-1'] = null
tree = await view()
check('the key list comes back with the host route',
  labelsOf(tree).includes('Основной') && labelsOf(tree).includes('Второй'), labelsOf(tree).join('|'))

// --- the fields the host half added on top of the contract ----------------
text = allText(tree)
// Eight, not seven: the page's own switches plus the ring's master switch, and the
// error-collection switch below. The ring switch is the seventh of them, which is
// the index the block after this one drives.
check('the master switch for the ring is offered',
  collect(tree, 'input').filter(item => item.props.type === 'checkbox').length === 8
  && text.includes('Ключи на несколько чатов'))
check('the key count is shown against the limit', text.includes('2 из 12'))
check('each key reports how many models its route serves', text.includes('моделей: 12'))
check('the substitution counters are shown', text.includes('запросов через подмену') && text.includes('5 из 7'))
check('the chats with a pick of their own are counted',
  text.includes('чатов со своим ключом') && text.includes('1'))
check('both key files are shown as copyable paths',
  text.includes('C:\\profile\\.dsh-rustvy\\keys.json')
  && text.includes('C:\\profile\\.dsh-rustvy\\session-keys.json'))
check('no repair is offered while every route is written', findButton(tree, 'Починить маршруты') === undefined)

requests.length = 0
const ringSwitch = collect(tree, 'input').filter(item => item.props.type === 'checkbox')[6]
check('the master switch reads the host answer', ringSwitch.props.checked === true)
ringSwitch.props.onChange({ target: { checked: false } })
await settle()
check('the master switch posts the config field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).apiKeys === false),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
check('the ring explains that it is off, and offers the switch back',
  allText(tree).includes('Ключи выключены') && findButton(tree, '+').props.disabled === true)
collect(tree, 'input').filter(item => item.props.type === 'checkbox')[6].props.onChange({ target: { checked: true } })
await settle()
tree = await view()
check('the ring comes back on', findButton(tree, '+').props.disabled === false)

// A route the profile lost: the key says so, and the section offers to rewrite it.
KEYS = structuredClone(KEYS_FIXTURE)
KEYS.keys[1].installed = false
KEYS.routes = { missing: ['rustvy-k2'], stale: ['rustvy-k2'] }
KEYS.fallback = {
  at: '2026-10-19T18:00:00.000Z', sessionId: 's-9', keyId: 'k2', keyLabel: 'Второй',
  route: 'rustvy-k2', provider: 'rustvy', model: 'claude-opus-5-5',
  reason: 'в маршруте нет этой модели',
}
tree = await view()
text = allText(tree)
check('a key whose route is missing says so', text.includes('маршрут не записан'))
check('the missing route is listed and can be repaired',
  text.includes('rustvy-k2') && findButton(tree, 'Починить маршруты') !== undefined)
check('a stale model list points at the button that writes it',
  text.includes('список моделей устарел') && text.includes('Записать список моделей'))
check('a request that missed its key is warned about',
  text.includes('не смог уйти своим ключом') && text.includes('в маршруте нет этой модели')
  && text.includes('«Второй»') && text.includes('s-9'), text.slice(0, 0))
requests.length = 0
findButton(tree, 'Починить маршруты').props.onClick()
await settle()
check('"Починить маршруты" posts the repair action',
  requests.some(item => item.method === 'POST' && JSON.parse(item.body ?? '{}').action === 'repair'),
  JSON.stringify(requests.filter(item => item.method === 'POST').map(item => item.body)))

// The host holds twelve keys; the thirteenth is refused before it is typed.
KEYS = structuredClone(KEYS_FIXTURE)
KEYS.maxKeys = 2
tree = await view()
check('the "+" is disabled at the limit', findButton(tree, '+').props.disabled === true)
check('the limit is explained', allText(tree).includes('Достигнут предел: 2 ключей'))
KEYS = structuredClone(KEYS_FIXTURE)
tree = await view()
check('the "+" returns below the limit', findButton(tree, '+').props.disabled === false)

/* ------------------------ error collection and uptime ---------------------- */
// The one setting on this page that sends anything off the machine, so it is
// asserted the way a user meets it: the switch and its exact label, the promise
// written underneath it, the counters the reports move, and what the two buttons
// post. The prose is checked by substring on purpose — a page that quietly dropped
// "never sends your prompts" would otherwise still pass every structural check.

/** The checkbox of the `label` whose whole text is one caption. */
function switchNamed(node, caption) {
  return collect(node, 'label')
    .filter(item => allText(item).trim() === caption)
    .map(item => collect(item, 'input').find(input => input.props.type === 'checkbox'))
    .find(item => item !== undefined)
}

/** One status row's value: the second span of the row whose first span is its name. */
function rowValue(node, name) {
  const row = collect(node, 'div').find(item => {
    const kids = item.children ?? []
    return kids.length >= 2 && kids[0]?.type === 'span' && kids[1]?.type === 'span'
      && allText(kids[0]).trim() === name
  })
  return row === undefined ? undefined : allText(row.children[1]).trim()
}

const COLLECT_LABEL = 'Собирать ошибки rustvy'
tree = await view()
text = allText(tree)
const collectSwitch = switchNamed(tree, COLLECT_LABEL)
check('the page names the collection block', text.includes('Сбор ошибок Rustvy'))
check('the collection switch carries its exact label', collectSwitch !== undefined)
// The fixture config omits `collectErrors`, which is the shape an older host half
// answers with: the default is on, and the switch has to say so rather than read a
// missing field as a refusal.
check('an absent collectErrors renders as on', collectSwitch?.props.checked === true,
  String(collectSwitch?.props.checked))
check('the description asks the user to leave it on',
  text.includes('Пожалуйста, оставьте сбор включённым'))
check('the description names what never leaves the machine',
  text.includes('содержание сообщений и чатов') && text.includes('содержимое и пути файлов')
  && text.includes('идентификатор сессии'))
check('the description says only failures are sent, and that nobody probes',
  text.includes('удачный запрос не отправляется никогда') && text.includes('отсутствие ошибок в окне')
  && text.includes('которые сжигали бы ваши токены'))
check('the description limits collection to the provider own faults',
  text.includes('upstream_502') && text.includes('закончившейся подписке')
  && text.includes('ограничении частоты'))
check('the description says an undelivered report is queued',
  text.includes('остаётся очередью на диске'))
check('the endpoint is shown read-only, with no field to edit it',
  rowValue(tree, 'адрес сборщика') === 'http://185.94.29.228:3789/api/report'
  && !collect(tree, 'input').some(item => item.props.value === 'http://185.94.29.228:3789/api/report'),
  String(rowValue(tree, 'адрес сборщика')))
check('the anonymous id is shown truncated',
  rowValue(tree, 'анонимный id') === 'a3f0c81b7d4e4f2a9c6b5d8e…', String(rowValue(tree, 'анонимный id')))
check('the sent, queued and dropped counters are shown',
  rowValue(tree, 'отправлено') === '5' && rowValue(tree, 'в очереди') === '2' && rowValue(tree, 'отброшено') === '0',
  JSON.stringify([rowValue(tree, 'отправлено'), rowValue(tree, 'в очереди'), rowValue(tree, 'отброшено')]))
check('the last answer carries the status and a local time',
  rowValue(tree, 'последний ответ') === `HTTP 200, ${new Date(1792472700000).toLocaleString()}`,
  String(rowValue(tree, 'последний ответ')))
check('a delivery that went through reports no send error', rowValue(tree, 'ошибка отправки') === undefined)
check('the failures are broken down by kind',
  rowValue(tree, 'сбои по видам') === 'upstream_502: 4; connect_timeout: 2; dns: 1',
  String(rowValue(tree, 'сбои по видам')))
check('both collector files are shown as copyable paths',
  text.includes('C:\\profile\\.dsh-rustvy\\install.json')
  && text.includes('C:\\profile\\.dsh-rustvy\\errors-queue.json'))
check('both send buttons are offered while collection is on',
  findButton(tree, 'Отправить тестовое событие')?.props.disabled === false
  && findButton(tree, 'Отправить очередь сейчас')?.props.disabled === false)

requests.length = 0
collectSwitch.props.onChange({ target: { checked: false } })
await settle()
check('the switch posts its own config field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).collectErrors === false),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
check('the switch reads the host answer back', switchNamed(tree, COLLECT_LABEL).props.checked === false)
check('both send buttons are disabled while collection is off',
  findButton(tree, 'Отправить тестовое событие').props.disabled === true
  && findButton(tree, 'Отправить очередь сейчас').props.disabled === true)

requests.length = 0
switchNamed(tree, COLLECT_LABEL).props.onChange({ target: { checked: true } })
await settle()
check('turning collection back on posts the same field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).collectErrors === true),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
check('the buttons come back with the switch',
  findButton(tree, 'Отправить тестовое событие').props.disabled === false
  && findButton(tree, 'Отправить очередь сейчас').props.disabled === false)

// A flush into an outage first, because it is the case the queue exists for: the
// events must be seen not to have moved, and the warning must not read as a success.
ERRORS_MODE = 'down'
requests.length = 0
findButton(tree, 'Отправить очередь сейчас').props.onClick()
await settle()
check('the flush button posts the flush action',
  requests.some(item => item.path === '/dsh-rustvy/errors' && item.method === 'POST'
    && JSON.parse(item.body ?? '{}').action === 'flush'),
  JSON.stringify(requests.map(item => item.body)))
tree = await view()
text = allText(tree)
check('a collector that is down is reported as a warning, not a success',
  text.includes('Сборщик не принял очередь') && text.includes('ECONNREFUSED')
  && !text.includes('Очередь отправлена сборщику'))
check('the failed delivery is shown in the status block',
  rowValue(tree, 'ошибка отправки') === 'connect ECONNREFUSED 185.94.29.228:3789',
  String(rowValue(tree, 'ошибка отправки')))
check('the events stay queued when the site does not answer', rowValue(tree, 'в очереди') === '2',
  String(rowValue(tree, 'в очереди')))

ERRORS_MODE = 'ok'
requests.length = 0
findButton(tree, 'Отправить тестовое событие').props.onClick()
await settle()
const errorRequest = requests.find(item => item.path === '/dsh-rustvy/errors' && item.method === 'POST')
check('the test button posts to /errors', errorRequest !== undefined,
  JSON.stringify(requests.map(item => `${item.method} ${item.path}`)))
check('it asks for one synthetic event', JSON.parse(errorRequest.body).action === 'test', String(errorRequest?.body))
// One literal, asserted through both envelopes: the host spreads the summary into its
// answer, and `noticeFor` also accepts it nested, so the same summary has to produce
// the same sentence whichever way it arrived.
const TEST_NOTICE = 'Тестовое событие отправлено: ответ HTTP 200 (всего 6, в очереди 0).'
tree = await view()
text = allText(tree)
check('the notice reports what the collector took', text.includes(TEST_NOTICE),
  String(text.includes('Тестовое событие')))
check('a delivery that went through drops the send-error row', rowValue(tree, 'ошибка отправки') === undefined)

// The same summary nested under `errorReport` — the shape only `GET /state` uses, and
// answered here without moving a single counter — has to render the identical notice.
// `noticeFor` claims to read either envelope; a claim nothing exercises is not a
// tolerance, it is a guess.
ERRORS_ENVELOPE = 'wrapped'
findButton(tree, 'Отправить тестовое событие').props.onClick()
await settle()
tree = await view()
check('a summary nested under errorReport renders the same notice', allText(tree).includes(TEST_NOTICE))
ERRORS_ENVELOPE = 'bare'

// A `400` is the collector refusing the report itself — neither `message` nor `code`
// in it — and the host drops that one rather than retrying it. The notice has to say
// so: "still queued, it will go when the site answers" would promise something nothing
// keeps. A `429` or a `5xx` means busy and stays queued, which is the case above.
ERRORS_MODE = 'refused'
findButton(tree, 'Отправить тестовое событие').props.onClick()
await settle()
tree = await view()
text = allText(tree)
check('a report refused as unusable is said to be dropped rather than kept',
  text.includes('Сборщик отклонил отчёт как непригодный') && text.includes('the collector answered 400')
  && text.includes('Он отброшен, а не оставлен в очереди'))
check('the dropped report is counted', rowValue(tree, 'отброшено') === '1',
  String(rowValue(tree, 'отброшено')))
ERRORS_MODE = 'ok'

// A host half older than the collector answers `/state` without the block. The page
// still has to draw — switch, prose and buttons — and draw no status rows at all,
// rather than throwing on a field that is not there.
const REPORT = STATE.errorReport
delete STATE.errorReport
tree = await view()
text = allText(tree)
check('an older host half still gets the switch and its description',
  switchNamed(tree, COLLECT_LABEL)?.props.checked === true && text.includes('Пожалуйста, оставьте сбор включённым'))
check('and no status rows it has nothing to fill them with',
  rowValue(tree, 'адрес сборщика') === undefined && rowValue(tree, 'сбои по видам') === undefined
  && !text.includes('Состояние сборщика'))
STATE.errorReport = REPORT
tree = await view()
check('the status block comes back with the summary',
  rowValue(tree, 'адрес сборщика') === 'http://185.94.29.228:3789/api/report')

/* -------------------------- the composer selector ------------------------- */
// The key choice lives in exactly one place in a conversation: the composer's tool
// row, right after the permission/mode dropdown. The model picker stays about
// models, so the block after this one asserts it grows nothing.
check('the selector renders nothing without a session',
  allText(await viewComponent(renderKeyControl, {})) === '')

let keyTree = await viewComponent(renderKeyControl, { sessionId: 's-1' })
check('the selector reads this chat choice from the host',
  requests.some(item => item.path.includes('/session-key?sessionId=s-1')),
  JSON.stringify(requests.map(item => item.path).slice(-3)))
check('the selector names the key this chat sends with',
  allText(keyTree).includes('ключ по умолчанию'), allText(keyTree))

const keyButton = collect(keyTree, 'button').find(item => /dmi-keybtn/u.test(String(item.props.className ?? '')))
check('the selector is a compact control with a popup', keyButton?.props['aria-haspopup'] === 'true')
keyButton.props.onClick()
await settle()
keyTree = await viewComponent(renderKeyControl, { sessionId: 's-1' })
const popupRows = collect(keyTree, 'button')
  .filter(item => /dmi-keypop-row/u.test(String(item.props.className ?? '')))
check('the popup lists every key plus the default and the "+"',
  popupRows.length === KEYS.keys.length + 2, String(popupRows.length))
check('the popup offers to add a key', allText(keyTree).includes('+ Добавить ключ'))
check('exactly one row of the popup carries the tick',
  popupRows.filter(item => item.props['data-dmi-active'] === '1').length === 1,
  String(popupRows.filter(item => item.props['data-dmi-active'] === '1').length))

requests.length = 0
popupRows[1].props.onClick()
await settle()
const choiceRequest = requests.find(item => item.path === '/dsh-rustvy/session-key' && item.method === 'POST')
check('picking a key posts to /session-key', choiceRequest !== undefined,
  JSON.stringify(requests.map(item => item.path)))
const choiceBody = JSON.parse(choiceRequest.body)
check('the choice carries this session and that key',
  choiceBody.sessionId === 's-1' && choiceBody.keyId === 'k2', JSON.stringify(choiceBody))
keyTree = await viewComponent(renderKeyControl, { sessionId: 's-1' })
check('the selector now names the chosen key', allText(keyTree).includes('Второй'), allText(keyTree))

// One key is no choice, so the selector goes away rather than showing a single row.
KEYS = structuredClone(KEYS_FIXTURE)
KEYS.keys = [KEYS_FIXTURE.keys[0]]
check('one key draws no selector at all',
  allText(await viewComponent(renderKeyControl, { sessionId: 's-1' })) === '')
KEYS = structuredClone(KEYS_FIXTURE)
check('the selector returns when a second key exists',
  allText(await viewComponent(renderKeyControl, { sessionId: 's-1' })) !== '')

/* ------------------ the picker: marks and clone-group hiding ---------------- */
/** One model row, in the shape the host's own bundle renders it. */
function pickerRow(model, parent) {
  const row = documentStub.createElement('button')
  row.setAttribute('role', 'menuitemradio')
  row.setAttribute('aria-checked', 'false')
  row.setAttribute('class', 'ms_option ms_modelOption')
  row.setAttribute('title', model)
  const copy = documentStub.createElement('span')
  copy.setAttribute('class', 'ms_optionCopy')
  const name = documentStub.createElement('span')
  name.setAttribute('class', 'ms_modelName')
  name.textContent = model
  copy.appendChild(name)
  row.appendChild(copy)
  const tick = documentStub.createElement('span')
  tick.setAttribute('class', 'ms_check')
  row.appendChild(tick)
  parent.appendChild(row)
  return row
}

/**
 * A picker menu in the shape the host's own bundle renders it: a portal child
 * `div[role="menu"]` whose classes match `_groups`, holding provider groups of
 * `button[role="menuitemradio"]` rows with `_optionCopy > _modelName` and a
 * trailing `_check`.
 *
 * A group is wrapped or flat, and both shapes are exercised on purpose: a header
 * cannot be matched by class — the primitives package that renders it is a frozen
 * platform module — so the hiding has to work from structure alone, and the two
 * shapes are the two ways a structure can carry "these rows belong to that name".
 *
 * @param groups - `[{ label, models, flat }]`.
 * @returns the menu, already in the document.
 */
function buildPickerMenu(groups) {
  const menu = documentStub.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'Модели')
  menu.setAttribute('class', 'ms_groups scrollable')
  for (const group of groups) {
    const head = documentStub.createElement('div')
    head.setAttribute('class', group.flat === true ? 'ms_stickyHeader' : 'ms_groupLabel')
    head.textContent = group.label
    if (group.flat === true) {
      menu.appendChild(head)
      for (const model of group.models) pickerRow(model, menu)
      continue
    }
    const box = documentStub.createElement('div')
    box.setAttribute('class', 'ms_group')
    box.appendChild(head)
    for (const model of group.models) pickerRow(model, box)
    menu.appendChild(box)
  }
  documentStub.body.appendChild(menu)
  return menu
}

/** Fire a document event, then wait out the frame the pass is coalesced into. */
async function pass() {
  fireOn(documentStub, 'pointerdown')
  await new Promise(resolve => setTimeout(resolve, 40))
}

// One group the user picks from, and two per-key clones the host cannot drop: a
// clone has to keep its models so the call still resolves once the swap has
// renamed the route. `KEYS_FIXTURE.hiddenGroups` names exactly the two clones.
const menu = buildPickerMenu([
  { label: 'rustvy', models: ['claude-opus-5-5', 'gpt-5'] },
  { label: 'rustvy · ключ 3', models: ['gpt-5'] },
  { label: 'rustvy · ключ 2', models: ['claude-opus-5-5'], flat: true },
])
// A menu none of whose headers is a clone, which must be left completely alone.
const plainMenu = buildPickerMenu([{ label: 'another provider', models: ['gpt-5'] }])

// The `/model` popup is a card rather than a menu, and it is the other surface a
// key section used to be appended to.
const modelPopup = documentStub.createElement('div')
modelPopup.setAttribute('class', 'cmd_card')
for (const model of ['claude-opus-5-5', 'gpt-5']) {
  const row = documentStub.createElement('div')
  row.setAttribute('class', 'cmd_row')
  const name = documentStub.createElement('span')
  name.setAttribute('class', 'cmd_labelText')
  name.textContent = model
  row.appendChild(name)
  modelPopup.appendChild(row)
}
documentStub.body.appendChild(modelPopup)

const hiddenOf = node => node.querySelectorAll('.dmi-hidden-group')
/** The model rows a user can still reach: neither hidden nor inside a hidden group. */
const visibleModels = () => menu.querySelectorAll('[role="menuitemradio"]')
  .filter(row => !row.classList.contains('dmi-hidden-group') && row.closest('.dmi-hidden-group') === null)
  .map(row => row.attributes.title)

await pass()
await pass()
// The positive control. Without it every "nothing was drawn here" assertion below
// would also pass on a stub the decorator never matched at all.
check('the marks still reach the picker menu', menu.querySelectorAll('.dmi-mark').length > 0,
  String(menu.querySelectorAll('.dmi-mark').length))
check('the picker menu grows no key section', menu.querySelectorAll('[data-dmi-keys]').length === 0)
check('the picker menu grows no key rows', menu.querySelectorAll('[data-dmi-key-row]').length === 0)
check('the /model popup grows no key section', modelPopup.querySelectorAll('[data-dmi-keys]').length === 0)

// The wrapped clone is hidden as one group element, the flat one as a header plus
// its rows — three elements for two groups.
check('both clone groups are hidden, in either shape', hiddenOf(menu).length === 3, String(hiddenOf(menu).length))
check('the provider the user picks from keeps every model',
  visibleModels().join('|') === 'claude-opus-5-5|gpt-5', visibleModels().join('|'))
check('a menu with no clone header hides nothing', hiddenOf(plainMenu).length === 0,
  String(hiddenOf(plainMenu).length))

await pass()
check('a second pass leaves the hidden groups alone', hiddenOf(menu).length === 3, String(hiddenOf(menu).length))
check('and still hides nothing it should not', hiddenOf(plainMenu).length === 0)

// --- the interaction throttle ---------------------------------------------
// Every pointerdown and focusin in the whole application reaches this half, and
// each read costs the host a credential resolve per key — so an interaction
// re-reads only once the answer it already holds has gone stale, while a
// deliberate open always reads.
const sessionReads = () => requests
  .filter(item => item.path.startsWith('/dsh-rustvy/session-key') && item.method === 'GET').length

/** One full interaction with the page: the press, and the focus it moves. */
async function interact() {
  fireOn(documentStub, 'pointerdown')
  fireOn(documentStub, 'focusin')
  await new Promise(resolve => setTimeout(resolve, 40))
}

/** The selector's own button, from a freshly rendered tree. */
function switchButton(node) {
  return collect(node, 'button').find(item => /dmi-keybtn/u.test(String(item.props.className ?? '')))
}

await new Promise(resolve => setTimeout(resolve, 2100))
requests.length = 0
await interact()
await interact()
check('two interactions in a row cost one key read', sessionReads() === 1, String(sessionReads()))

// Opening the selector is a deliberate act, so it reads inside the window too.
requests.length = 0
keyTree = renderComponent(renderKeyControl, { sessionId: 's-1' })
switchButton(keyTree).props.onClick()
await settle()
check('opening the selector forces a read of its own', sessionReads() === 1, String(sessionReads()))

requests.length = 0
await interact()
await interact()
check('and the interactions after it are throttled again', sessionReads() === 0, String(sessionReads()))

// A mutation's answer is itself a fresh list, so it must not be followed by a read.
keyTree = renderComponent(renderKeyControl, { sessionId: 's-1' })
switchButton(keyTree).props.onClick()
await settle()
keyTree = renderComponent(renderKeyControl, { sessionId: 's-1' })
requests.length = 0
collect(keyTree, 'button')
  .filter(item => /dmi-keypop-row/u.test(String(item.props.className ?? '')))[1].props.onClick()
await settle()
const afterChoice = requests.filter(item => item.path.startsWith('/dsh-rustvy/session-key'))
check('a choice costs one POST and no follow-up read',
  afterChoice.length === 1 && afterChoice[0].method === 'POST',
  JSON.stringify(afterChoice.map(item => `${item.method} ${item.path}`)))
await interact()
check('the next interaction is throttled by the answer that POST brought home',
  sessionReads() === 0, String(sessionReads()))

for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } }
check('unload ran without throwing', true)
check('unload took the marks with it', menu.querySelectorAll('.dmi-mark').length === 0)
// The groups this half hid are its doing, so an unload has to give them back:
// leaving the class behind would hide a whole provider with nothing able to
// restore it, since the stylesheet that reads the class goes too.
check('unload unhid every provider group',
  hiddenOf(menu).length === 0 && hiddenOf(plainMenu).length === 0,
  String(hiddenOf(menu).length))
check('unload left no key section or key row anywhere',
  menu.querySelectorAll('[data-dmi-keys], [data-dmi-key-row]').length === 0
  && modelPopup.querySelectorAll('[data-dmi-keys], [data-dmi-key-row]').length === 0)

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
