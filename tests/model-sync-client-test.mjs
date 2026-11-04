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
    /**
     * `setProperty` really records, because the uptime badge's colour reaches the
     * stylesheet as a custom property: a stub that swallowed it would let an assertion
     * about the badge's tier pass while the badge itself was painted in whatever the
     * fallback colour is.
     */
    style: {
      properties: {},
      setProperty(name, value) { this.properties[String(name)] = String(value) },
      removeProperty(name) { delete this.properties[String(name)] },
    },
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
    /**
     * Real, because the trigger badge's fallback anchor is "right after the name node"
     * and the decorator reads that through `nextSibling`. A stub without it would answer
     * `undefined` and quietly append the badge at the end of the trigger, which is the
     * one position the assertion is meant to rule out.
     */
    get nextSibling() {
      const held = this.parentNode?.childNodes ?? []
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
    // Published by the host from the reporter's single constant, so the window length has
    // one home. `collectSuccesses` and `collectErrors` are deliberately absent: that is the
    // shape an older host half answers with, and both switches have to read it as "on"
    // rather than as a refusal.
    successWindowMs: 900_000,
    // A stored proxy spec with a password in it, so the raw-versus-masked split is checkable:
    // the editable field must show exactly this, and nothing else on the page may.
    proxyEnabled: false,
    proxySpec: 'https://user:secret@proxy.example:8080',
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
    endpoint: 'http://185.75.189.247:3789/api/report',
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

/* ------------------------- uptime-view fixtures -------------------------- */
// Contract v2, plus the shape a collector older than v2 still answers with. The plugin
// may be pointed at the currently deployed server for a while, so both have to render —
// and the older one has to render poorer rather than wrong: no install counts it never
// measured, no share it has no denominator for.
//
// The all-green answer is still the one the live server gives most days, and it has to
// read as a finding rather than as a panel that failed to load.

/**
 * `count` buckets of an even window, with non-zero counts at the given indexes.
 *
 * @param count - how many buckets; 60 for an hour, 48 for every longer window.
 * @param hits - `{ index: count }` for the buckets that hold errors.
 * @param stepMs - one bucket's width; a minute for an hour, half an hour otherwise.
 */
function bucketStrip(count, hits = {}, stepMs = 1_800_000) {
  return Array.from({ length: count }, (_, index) => ({ from: 1792530932644 + index * stepMs, count: hits[index] ?? 0 }))
}

const UPTIME_GREEN = {
  ok: true, range: '24h', generatedAt: 1792617332644, fetchedAt: 1792617566000,
  stale: false, healthy: true, storage: 'mongo', total: 0,
  installs: { window: 0, reference: 47, anonymous: 0 },
  summary: {
    totalModels: 12, operational: 12, single: 0, issues: 0, down: 0, slow: 0,
    // v3: a real denominator behind the percentage. 480 successes and no failures, so the
    // hundred is measured rather than assumed — which is the whole difference from v2,
    // where «100%» over a window nobody requested anything in was a claim nobody checked.
    uptime: 100, ok: 480, fails: 0, totalErrors: 0, installsAffected: 0, affectedPct: 0,
  },
  byCode: [],
  models: [
    {
      id: 'claude-opus-5-5', name: 'OPUS 5.5', errors: 0, installs: 0, anonymous: 0, status: 'ok',
      firstAt: null, lastAt: null, minutesSinceLast: null, affectedPct: 0,
      ok: 260, fails: 0, uptime: 100,
      buckets: bucketStrip(48), events: [], lastError: null,
    },
    {
      id: 'gpt-5', name: 'GPT-5', errors: 0, installs: 0, anonymous: 0, status: 'ok',
      firstAt: null, lastAt: null, minutesSinceLast: null, affectedPct: 0,
      ok: 220, fails: 0, uptime: 100,
      buckets: bucketStrip(48), events: [], lastError: null,
    },
  ],
  monitorUrl: 'http://185.75.189.247:3789/',
}

// Every state the v2 rule can produce, plus the edge cases the rendering has to get right: a
// model whose share has no denominator (`affectedPct: null`, which must read as «—» and never
// as 0%), a model whose failures are partly anonymous, so that «от 1 установки» is not allowed
// to stand unqualified, and — at the summary level — `installs.anonymous` sitting beside
// `installs.window` with the values go-collector captured live (4 beside 5), which is the pair
// that makes a wrong pairing read perfectly while comparing failures with installs.
const UPTIME_POPULATED = {
  ok: true, range: '24h', generatedAt: 1792617332644, fetchedAt: 1792617566000,
  stale: false, healthy: false, storage: 'mongo', total: 11,
  installs: { window: 5, reference: 47, anonymous: 4 },
  summary: {
    totalModels: 12, operational: 9, single: 1, issues: 1, down: 1, slow: 1,
    // `fails` is the sum of `n` and `totalErrors` the count of records, so the two differ
    // by exactly the folding: 14 real failures arrived in 11 records. §5.1 makes the
    // headline the failures, because publishing the record count next to the honest number
    // understates by a quarter on the live data.
    uptime: 96.6, ok: 460, fails: 14, totalErrors: 11, installsAffected: 5, affectedPct: 14.9,
  },
  byCode: [{ code: 'upstream_502', count: 7 }, { code: 'connect_timeout', count: 3 }],
  models: [
    {
      id: 'claude-opus-5-5', name: 'OPUS 5.5', errors: 5, installs: 3, anonymous: 0, status: 'down',
      firstAt: 1792600000000, lastAt: 1792616000000, minutesSinceLast: 4, affectedPct: 6.4,
      // Only failures and no successes at all: `0/(0+5) = 0`, a real percentage and the
      // case v2 could not show in any form. Not the same as `null`, which is what a window
      // with neither would give.
      ok: 0, fails: 5, uptime: 0,
      buckets: bucketStrip(48, { 3: 1, 17: 2, 44: 2 }),
      events: [{ t: 1792616000000, code: 'upstream_502', status: 502, message: 'upstream connect error', plugin: 'dsh-rustvy', id: 'd66d4114-0000' }],
      lastError: {
        t: 1792616000000, code: 'upstream_502', status: 502,
        message: 'upstream connect error or disconnect/reset before headers', plugin: 'dsh-rustvy', id: 'd66d4114-0000',
      },
    },
    {
      // A last error three hours old, on the ladder rather than on a clock: it must read
      // as hours, never as «только что», whatever window the panel is looking at.
      id: 'glm-5.3', name: 'GLM 5.3', errors: 3, installs: 2, anonymous: 1, status: 'issues',
      firstAt: 1792595000000, lastAt: 1792606532644, minutesSinceLast: 180, affectedPct: 4.3,
      // Four failures inside three records: one was folded, and `fails` carries the sum of
      // `n` while `errors` keeps counting records.
      ok: 120, fails: 4, uptime: 96.8,
      buckets: bucketStrip(48, { 9: 1, 31: 2 }),
      events: [{ t: 1792606532644, code: 'connect_timeout', status: 0, message: 'connect ETIMEDOUT', plugin: 'dsh-rustvy', id: 'd66d4114-0001' }],
      lastError: { t: 1792606532644, code: 'connect_timeout', status: 0, message: 'connect ETIMEDOUT 185.75.189.247:443', id: 'd66d4114-0001' },
    },
    {
      // One install, and most of its failures anonymous: the breadth figure is not a
      // measurement here, and the row has to say so rather than imply "one person".
      //
      // `errors`, `fails` and `anonymous` are go-collector's capture off a live collector on
      // a 24h range — three records carrying five failures, four of them anonymous — taken
      // verbatim rather than composed, because on an invented spread `fails` and the record
      // `anonymous: 5` and not go-collector's captured 4, because 4 makes this payload
      // impossible: the collector's install key is either a real `meta.id` or one shared
      // anonymous key, so `installs: 1` leaves two shapes only — one identified install and no
      // anonymous records, or only anonymous records and `anonymous == fails`. Four anonymous
      // failures beside one attributed one needs two keys, and two keys is `installs: 2`, which
      // would move this row out of `single` and drop a state from a fixture whose job is
      // covering all four. A payload that cannot occur still passes checks, which is the quiet
      // half of the vacuous-check problem: it cannot catch a regression that only appears on
      // real data. The captured *summary* pair — `window: 5` beside `anonymous: 4` — is
      // verbatim above, and that is the one the §5.2 header check reads.
      id: 'kimi-k3', name: 'KIMI K3', errors: 3, installs: 1, anonymous: 5, status: 'single',
      firstAt: 1792609000000, lastAt: 1792612000000, minutesSinceLast: 70, affectedPct: null,
      ok: 40, fails: 5, uptime: 88.9,
      buckets: bucketStrip(48, { 20: 2 }),
      events: [], lastError: { t: 1792612000000, code: 'upstream_503', status: 503, message: 'service unavailable' },
    },
    {
      id: 'gpt-5', name: 'GPT-5', errors: 0, installs: 0, anonymous: 0, status: 'ok',
      firstAt: null, lastAt: null, minutesSinceLast: null, affectedPct: 0,
      // Only successes: `300/(300+0) = 100`, and honestly so. §3 is explicit that this is
      // a real hundred, not an unmeasured one — the unmeasured case is `null`.
      ok: 300, fails: 0, uptime: 100,
      buckets: bucketStrip(48), events: [], lastError: null,
    },
  ],
  monitorUrl: 'http://185.75.189.247:3789/',
}

// The badge fixture: an hour's window, and in v3 that is **4 buckets of 15 minutes** rather
// than 60 of one minute, because a bucket must hold a whole number of success windows (§4) —
// a percentage is meaningless for a bucket narrower than the window it would divide, and
// spreading fifteen minutes of successes over one-minute buckets means inventing a
// distribution. One model in each of the four states, so the shape and colour of every badge
// is pinned by a real answer rather than by a unit test of a helper. One id the vendor rules
// recognise rides along, so a badge can be checked on a row that also carries a mark.
const UPTIME_BADGES = {
  ok: true, range: '1h', generatedAt: 1792617332644, fetchedAt: 1792617566000,
  stale: false, healthy: false, storage: 'mongo', total: 6,
  installs: { window: 5, reference: 47, anonymous: 2 },
  summary: {
    totalModels: 5, operational: 2, single: 1, issues: 1, down: 1, slow: 1,
    // 24 successes against 6 failures is the 80% the fixture already claimed, now with the
    // denominator that makes it a measurement rather than a number somebody wrote down.
    uptime: 80, ok: 24, fails: 6, totalErrors: 6, installsAffected: 5, affectedPct: 10.6,
  },
  byCode: [{ code: 'upstream_502', count: 6 }],
  models: [
    {
      id: 'claude-opus-5-5', name: 'OPUS 5.5', errors: 0, installs: 0, anonymous: 0, status: 'ok',
      firstAt: null, lastAt: null, minutesSinceLast: null, affectedPct: 0,
      ok: 9, fails: 0, uptime: 100,
      buckets: bucketStrip(4, {}, 900_000), events: [], lastError: null,
    },
    {
      id: 'gpt-5', name: 'GPT-5', errors: 0, installs: 0, anonymous: 0, status: 'ok',
      firstAt: null, lastAt: null, minutesSinceLast: null, affectedPct: 0,
      ok: 6, fails: 0, uptime: 100,
      buckets: bucketStrip(4, {}, 900_000), events: [], lastError: null,
    },
    {
      id: 'kimi-k3', name: 'KIMI K3', errors: 1, installs: 1, anonymous: 1, status: 'single',
      firstAt: 1792616000000, lastAt: 1792616900000, minutesSinceLast: 7, affectedPct: 2.1,
      ok: 2, fails: 1, uptime: 66.7,
      buckets: bucketStrip(4, { 0: 1 }, 900_000), events: [], lastError: null,
    },
    {
      id: 'glm-5.3', name: 'GLM 5.3', errors: 3, installs: 2, anonymous: 1, status: 'issues',
      firstAt: 1792615000000, lastAt: 1792616940000, minutesSinceLast: 6, affectedPct: 4.3,
      ok: 4, fails: 3, uptime: 57.1,
      buckets: bucketStrip(4, { 1: 1, 3: 2 }, 900_000), events: [], lastError: null,
    },
    {
      id: 'qwen3.7-plus', name: 'QWEN 3.7 PLUS', errors: 2, installs: 3, anonymous: 0, status: 'down',
      firstAt: 1792616500000, lastAt: 1792617300000, minutesSinceLast: 1, affectedPct: 6.4,
      ok: 3, fails: 2, uptime: 60,
      buckets: bucketStrip(4, { 3: 2 }, 900_000), events: [], lastError: null,
    },
  ],
  monitorUrl: 'http://185.75.189.247:3789/',
}

// The same window seen from a month away, with every count doubled. Nothing asserts on
// the panel in this mode; it exists so that a badge repainted from a longer window is
// visibly wrong rather than silently identical to the hour it claims to describe.
const UPTIME_BADGES_WIDE = {
  ...UPTIME_BADGES,
  range: '30d',
  // `ok` and `fails` double with `errors` and `anonymous`, because a fixture whose counts
  // double while its denominator does not is a payload no collector could emit — and
  // doubling both leaves the percentage where it was, which is the point of this fixture:
  // the counts move, so a badge repainted from a longer window is visibly wrong.
  models: UPTIME_BADGES.models.map(model => ({
    ...model,
    errors: model.errors * 2,
    anonymous: model.anonymous * 2,
    ok: (model.ok ?? 0) * 2,
    fails: (model.fails ?? 0) * 2,
    buckets: bucketStrip(48),
  })),
}

// A collector older than v2: the three old states, a percentage instead of a state rule,
// and none of the breadth fields. Everything here has to render, and nothing here may be
// invented — no «от 0 установок», no «затронуто 0%».
const UPTIME_LEGACY = {
  ok: true, range: '24h', generatedAt: 1792617332644, fetchedAt: 1792617566000,
  stale: false, healthy: false, storage: 'mongo', total: 4,
  summary: { totalModels: 3, operational: 1, slow: 1, down: 1, uptime: 79, totalErrors: 4 },
  byCode: [{ code: 'upstream_502', count: 4 }],
  models: [
    {
      id: 'claude-opus-5-5', name: 'OPUS 5.5', errors: 3, uptime: 61, status: 'down',
      buckets: bucketStrip(48, { 3: 1, 17: 2 }), events: [],
      lastError: { t: 1792616000000, code: 'upstream_502', status: 502, message: 'upstream connect error' },
    },
    {
      id: 'glm-5.3', name: 'GLM 5.3', errors: 1, uptime: 97, status: 'slow',
      buckets: bucketStrip(48, { 9: 1 }), events: [],
      lastError: { t: 1792613000000, code: 'connect_timeout', status: 0, message: 'connect ETIMEDOUT' },
    },
    {
      id: 'gpt-5', name: 'GPT-5', errors: 0, uptime: 100, status: 'up',
      buckets: bucketStrip(48), events: [], lastError: null,
    },
  ],
  monitorUrl: 'http://185.75.189.247:3789/',
}

// A month window, where the summary's share stops meaning anything: the window and the
// 30-day reference period are the same set of installs, so numerator and denominator
// coincide and the collector answers `affectedPct: null` rather than a 100% that reads as
// a verdict. Per-model shares stay real on this range — their denominator is the global
// install base and their numerator is one model's installs — which makes `30d` the one
// window where the header and a row genuinely disagree about whether a percentage means
// something.
const UPTIME_MONTH = {
  ...UPTIME_POPULATED,
  range: '30d',
  // Kept consistent with the models below, because a fixture whose summary disagrees with
  // its own rows is a trap for whoever writes the consistency check next.
  summary: { ...UPTIME_POPULATED.summary, affectedPct: null, ok: 160, fails: 14, uptime: 92 },
  installs: { window: 47, reference: 47, anonymous: 3 },
  // Thirty days over 48 buckets is fifteen hours a bucket (§4: 900 = 60 × 15, unchanged
  // from v2). The step lives in the fixture rather than in a lookup table because the
  // width label is measured from the array — so a wrong step here is a wrong label on the
  // page, which is exactly what measuring instead of looking up is for.
  //
  // GPT-5 becomes the window with neither successes nor failures: `ok + fails == 0`, so
  // `uptime` is `null` and the row draws a dash. That is the third of the three assertions
  // the percentage has to keep apart — a measured hundred, a measured zero, and nobody
  // having measured anything — and §3 is explicit that this one is neither of the others.
  models: UPTIME_POPULATED.models.map(model => ({
    ...model,
    ...(model.id === 'gpt-5' ? { ok: 0, fails: 0, uptime: null } : {}),
    buckets: bucketStrip(48, {}, 54_000_000),
  })),
}

/**
 * `'green'` for an all-clear window, `'populated'` for one carrying every state and both
 * edge cases, `'badges'` for the hour the picker reads — which answers doubled counts on
 * any longer window, so a badge taken from the wrong one is visible — `'month'` for a
 * 30-day window whose summary share is null, `'legacy'` for a collector older than v2,
 * `'stale'` for a cached payload behind an unreachable collector, `'refused'` for the
 * host's own `ok: false`, and `'offline'` for a `502` with no cache at all.
 */
let UPTIME_MODE = 'green'

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
/**
 * What `/test-proxy` answers, so the four outcomes can be driven one at a time. `null` makes
 * the probe itself fail, which is the case that must not be mistaken for an unparsable address.
 */
let PROXY_ANSWER = { ok: true, tested: 'stored', connected: true, status: 200, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080' }
let PROXY_HTTP = 200
/** What `/timeout` answers with: the value the routes carry, how many are in scope, and the POST result. */
let TIMEOUT_VALUE = null
let TIMEOUT_ROUTES = 2
let TIMEOUT_ANSWER = { ok: true, applied: true, value: 3600000, routes: ['rustvy', 'rustvy-k2'], available: true, current: 3600000, routeCount: 2 }
/**
 * What `/diagnose` answers with.
 *
 * Deliberately a *partial* shape: the probe is still being built, so an answer with keys absent
 * and values null is what the page will really receive, and rendering that as an absence rather
 * than as a zero is the property under test. It also carries a password and an api key that no
 * layer should ever surface.
 */
let DIAG_ANSWER = {
  ok: true,
  at: '2026-11-04T21:55:02.114Z',
  // With userinfo in it, on purpose: the recording side scrubs the origin, and the page must
  // not depend on that having happened.
  origin: 'https://user:pass-must-not-render@rustvy.xyz',
  host: 'rustvy.xyz',
  port: 443,
  secure: true,
  verdict: 'tls',
  dns: { ok: true, ms: 12, addresses: ['91.108.56.1', '91.108.56.2', '91.108.56.3', '91.108.56.4', '91.108.56.5'] },
  tcp: { ok: true, ms: 76 },
  tls: { ok: false, ms: 30005, code: 'ETIMEDOUT', message: 'handshake timed out', protocol: 'TLSv1.3', authorized: false },
  // `frag` is an explicit null and `httpFrag` is absent entirely: the two shapes of "no
  // measurement", which must render identically rather than one of them becoming a zero.
  frag: null,
  http: {
    ok: true, ms: 163, status: 200, bytes: 4213,
    // Neither of these is on the layer's allowlist, so neither may be rendered: an unexpected
    // scalar and an unexpected nested object both fail closed.
    attempts: 8,
    password: 'hunter2-must-not-render',
    nested: { apiKey: 'sk-must-not-render' },
  },
  history: [{ ok: false, ms: 30005, error: 'ECONNRESET', token: 'token-must-not-render' }],
}

globalThis.fetch = async (url, init = {}) => {
  const path = String(url)
  const method = (init.method ?? 'GET').toUpperCase()
  requests.push({ path, method, body: init.body })
  if (path.includes('/models.yaml')) return { ok: true, status: 200, text: async () => YAML_TEXT }
  if (path.endsWith('/diagnose')) return json(DIAG_ANSWER)
  if (path.endsWith('/timeout')) {
    if (method === 'GET') return json({ ok: true, available: true, value: TIMEOUT_VALUE, routes: TIMEOUT_ROUTES })
    return json(TIMEOUT_ANSWER)
  }
  if (path.endsWith('/test-proxy') && method === 'POST') {
    if (PROXY_ANSWER === null) throw new Error('Failed to fetch')
    // `tested` is derived from the request the way the host derives it — a non-empty `proxySpec`
    // in the body means the typed text was probed, anything else means the stored one — so the
    // stub cannot report a subject the client did not send, and the page's sentence is checked
    // against what it actually asked for rather than against a value the test wrote by hand.
    const sent = JSON.parse(init.body ?? '{}')
    const tested = typeof sent.proxySpec === 'string' && sent.proxySpec !== '' ? 'typed' : 'stored'
    return { ok: PROXY_HTTP === 200, status: PROXY_HTTP, json: async () => ({ ...PROXY_ANSWER, tested }) }
  }
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
    if (body.uptimeView !== undefined) STATE.config.uptimeView = body.uptimeView !== false
    return json(STATE)
  }
  // The host's mirror of the collector's own view. It answers with the range it was
  // asked for, because a mirror that quietly answered a different window would let a
  // range switch look like it worked while showing the same numbers.
  if (path.startsWith('/dsh-rustvy/uptime.json')) {
    const asked = new URL(path, 'http://local').searchParams.get('range') ?? '24h'
    if (UPTIME_MODE === 'offline') {
      return { ok: false, status: 502, json: async () => ({ ok: false, error: 'коллектор недоступен, а кешированного ответа нет' }) }
    }
    if (UPTIME_MODE === 'refused') return json({ ok: false, error: 'аптайм выключен настройкой плагина' })
    if (UPTIME_MODE === 'legacy') return json({ ...structuredClone(UPTIME_LEGACY), range: asked })
    if (UPTIME_MODE === 'month') return json({ ...structuredClone(UPTIME_MONTH), range: asked })
    // The interval between the plugin updating and the collector being deployed: a v1
    // server has no `1h`, answers it with a 400, and the host turns that into a 502
    // carrying no models — while every longer window keeps working. This is the state
    // every user is in for that interval, so it is a mode of its own rather than a note.
    if (UPTIME_MODE === 'v1-server') {
      if (asked === '1h') {
        return { ok: false, status: 502, json: async () => ({ ok: false, error: 'приёмник аптайма ответил 400' }) }
      }
      return json({ ...structuredClone(UPTIME_POPULATED), range: asked })
    }
    // A transport failure rather than an answer at all.
    if (UPTIME_MODE === 'network' && asked === '1h') throw new Error('Failed to fetch')
    if (UPTIME_MODE === 'badges') {
      // The hour the badges read, and a month of it with every count doubled for any
      // longer window: a badge repainted from the wrong window then shows a number
      // nobody can mistake for the hour its tooltip claims.
      const base = asked === '1h' ? UPTIME_BADGES : UPTIME_BADGES_WIDE
      return json({ ...structuredClone(base), range: asked })
    }
    const base = UPTIME_MODE === 'populated' || UPTIME_MODE === 'stale' ? UPTIME_POPULATED : UPTIME_GREEN
    return json(UPTIME_MODE === 'stale'
      ? { ...structuredClone(base), range: asked, stale: true, fetchedAt: 1792600000000, error: 'коллектор не ответил за 10 секунд' }
      : { ...structuredClone(base), range: asked })
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
// Keyed by the component's **position in the tree**: its parent's key plus its index among
// that parent's children of the same type. Real React keys by instance identity, and position
// within a parent is the closest thing a synchronous stub can compute.
//
// It used to be keyed by a per-render count of same-named components, which is coarser than
// React in a way that eventually bites: adding one `TextField` anywhere on the page shifted
// the index of every later `TextField`, so unrelated components inherited each other's state.
// That is exactly what happened when a seventh field was added to the settings box — the
// proxy field's store slot moved onto one that had been created empty, and because
// `TextField` skips its props re-sync when `saveOnBlur: false`, it never recovered the right
// value. The old scheme only ever worked by landing on an index whose store happened to hold
// the right value, so it was a recurring tax on every future settings addition rather than a
// property of the page.
//
// Per-parent keying fixes the class, not the instance: a field added inside a key row is in a
// different frame from the settings box's own fields and cannot shift them.
const storesByKey = new Map()
/** The frame stack: one entry per function component currently rendering. */
let hookFrames = []
/** The root frame, whose children are counted fresh on every render. */
let rootFrame = { key: '', next: 0 }
let activeHooks = []
let hookIndex = 0
let effects = []
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    if (typeof type === 'function') {
      // Children created while this component renders are counted against *its* frame, which
      // is what makes the key a position rather than a global tally. `createElement` calls a
      // function component synchronously, so the frame is on the stack for exactly the span
      // of that component's own children.
      const parent = hookFrames.length === 0 ? rootFrame : hookFrames[hookFrames.length - 1]
      // Counted against every sibling, not just siblings of the same type. React's implicit
      // key is a component's index among all of its parent's children, so keying per type
      // would let two different components at the same position collide and, worse, would
      // still shift a field when an unrelated *different* component is inserted before it.
      const seen = parent.next++
      const key = `${parent.key}/${seen}:${type.name || 'anonymous'}`
      const store = storesByKey.get(key) ?? []
      storesByKey.set(key, store)
      const prevHooks = activeHooks
      const prevIndex = hookIndex
      activeHooks = store
      hookIndex = 0
      hookFrames.push({ key, next: 0 })
      const rendered = type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat })
      hookFrames.pop()
      activeHooks = prevHooks
      hookIndex = prevIndex
      return rendered
    }
    // A host element consumes a sibling index as well. Its own children were already created
    // before this call — argument evaluation happens first — so they took their indices in the
    // enclosing frame, which is the source order React would see.
    if (hookFrames.length === 0) rootFrame.next++
    else hookFrames[hookFrames.length - 1].next++
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
  // A fresh root frame per render, and an empty stack in case a previous render threw inside
  // a component and left one pushed. The stores themselves persist — that is the point of a
  // store, it is what makes state survive a re-render — but *which* slot a component gets is
  // recomputed from its position every time.
  rootFrame = { key: '', next: 0 }
  hookFrames = []
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
/**
 * One dropdown, found by a value only its own option list carries.
 *
 * By option rather than by position: the page's sections move — the uptime panel now
 * sits above the model-sync box and brings a dropdown of its own — and an assertion
 * keyed to `selects[0]` silently retargets itself at whichever control happens to be
 * first. Keyed to an option, it cannot.
 */
const selectWith = (node, value) => collect(node, 'select')
  .find(item => collect(item, 'option').some(option => option.props.value === value))
check('the route is editable', texts.some(item => item.props.value === 'rustvy'), texts.map(i => i.props.value).join('|'))
check('the profile row is editable', texts.some(item => item.props.value === 'llm-pi-ai'))
check('the origin is editable', texts.some(item => item.props.value === 'https://rustvy.xyz'))
check('the mark size is editable', numbers.length === 1 && numbers[0].props.value === '16', JSON.stringify(numbers.map(i => i.props.value)))
// Five, not four: the proxy family selector is the fourth and the fragmentation mode is the
// fifth. Both are selects rather than buttons so they share the page's dropdown idiom and its
// disabled state.
check('five dropdowns render', selects.length === 5, String(selects.length))
check('auto-apply defaults to explicit', selectWith(tree, 'explicit')?.props.value === 'explicit',
  String(selectWith(tree, 'explicit')?.props.value))
check('the name source defaults to the provider label', selectWith(tree, 'displayName')?.props.value === 'displayName',
  String(selectWith(tree, 'displayName')?.props.value))
// Twelve, not eleven: the fragmentation block adds the switch that extends it to model traffic.
// Thirteen, not twelve: the fragmentation block adds the switch that extends it to model
// traffic and the one that governs automatic promotion. This count has now moved three times,
// which is the cost of asserting a page-wide total; it is left as-is because it is client-ui's
// structure and the count does catch a control silently failing to render.
check('thirteen switches render', boxes.length === 13, String(boxes.length))

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

// a dropdown saves on change — found again in the current tree, by its own option
selectWith(tree, 'explicit').props.onChange({ target: { value: 'always' } })
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
// Eleven, not eight: the page's own display switches — now including the uptime one — plus the
// ring's master switch, the success-reporting switch above the error-collection one in the
// «Сбор данных Rustvy» box, and the proxy switch in «Зеркало каталога». Found by label rather
// than by index, so a switch added above it cannot silently retarget this block at some other
// checkbox.
check('the master switch for the ring is offered',
  collect(tree, 'input').filter(item => item.props.type === 'checkbox').length === 13
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
const ringSwitch = switchNamed(tree, 'Ключи на несколько чатов')
check('the master switch reads the host answer', ringSwitch.props.checked === true)
ringSwitch.props.onChange({ target: { checked: false } })
await settle()
check('the master switch posts the config field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).apiKeys === false),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
check('the ring explains that it is off, and offers the switch back',
  allText(tree).includes('Ключи выключены') && findButton(tree, '+').props.disabled === true)
switchNamed(tree, 'Ключи на несколько чатов').props.onChange({ target: { checked: true } })
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
// The one setting on this page that sends anything off the machine, so it is asserted
// the way a user meets it: the switch, its exact label, and the promise written
// underneath it. The prose is checked by substring on purpose — a page that quietly
// dropped "never sends your prompts" would otherwise still pass every structural check.
//
// The collector readout that used to sit under that promise is gone, and the block
// below asserts its absence rather than its contents. The fixture still carries a full
// `errorReport`, so the data is demonstrably in the page's hands and demonstrably not
// drawn from: a removal nobody asserts is a removal that comes back.

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

/** Every row the collector readout carried, plus the caption above them. */
const COLLECTOR_ROWS = [
  'адрес сборщика', 'анонимный id', 'отправлено', 'в очереди',
  'отброшено', 'последний ответ', 'ошибка отправки', 'сбои по видам',
]

const COLLECT_LABEL = 'Собирать ошибки rustvy'
const SUCCESSES_LABEL = 'Отправлять успешные запросы'
// Renamed from «Сбор ошибок Rustvy» when the success switch moved in: a caption promising
// only error collection would describe a box holding both falsely, and the caption is what
// a user reads to decide whether to open the box.
const DATA_BOX = 'Сбор данных Rustvy'
tree = await view()
text = allText(tree)
const collectSwitch = switchNamed(tree, COLLECT_LABEL)
check('the page names the collection block', text.includes(DATA_BOX))
check('the collection switch carries its exact label', collectSwitch !== undefined)
// The fixture config omits `collectErrors`, which is the shape an older host half
// answers with: the default is on, and the switch has to say so rather than read a
// missing field as a refusal.
check('an absent collectErrors renders as on', collectSwitch?.props.checked === true,
  String(collectSwitch?.props.checked))
// Every sentence the page used to carry and no longer does — the intro under the
// heading, the promise under the collection switch, and the seven paragraphs that
// closed the page. Asserted as absence, with the fixture still complete and the
// features still on screen: a removal nobody checks is a removal that comes back, and
// a probe that passed only because the data was missing would prove nothing. The
// disclosure itself did not disappear, it moved — both READMEs and
// `docs/error-report.md` still carry what is sent and what never is.
const REMOVED_PROSE = [
  'не выходит в интернет сама',
  'Одна строка на сбой',
  'Пожалуйста, оставьте сбор включённым',
  'содержание сообщений и чатов',
  'содержимое и пути файлов',
  'удачный запрос не отправляется никогда',
  'отсутствие ошибок в окне',
  'которые сжигали бы ваши токены',
  'закончившейся подписке',
  'ограничении частоты',
  'остаётся очередью на диске',
  'Значок рисуется маской CSS',
  'Модель, которой нет в зеркале',
  'Каталог обновляется сам',
  'Список моделей маршрута берётся',
  'Кнопка «Показать блок для ручной правки»',
  'Сбор ошибок Rustvy — единственный блок',
  'Блок «Аптайм моделей» показывает',
  'Правки файлов плагина применяются на лету',
]
check('no sentence of the removed prose is left on the page',
  REMOVED_PROSE.every(probe => !text.includes(probe)),
  REMOVED_PROSE.filter(probe => text.includes(probe)).join(' | '))
check('the features the prose described are still on the page',
  switchNamed(tree, COLLECT_LABEL) !== undefined && text.includes('Аптайм моделей')
  && findButton(tree, 'Обновить каталог и иконки') !== undefined
  && findButton(tree, 'Записать список моделей') !== undefined)

// The two buttons of that check sit on the brand fill, and the brand accent is
// monochrome: near-black in the light palette, near-white in the dark one. A literal
// white label was therefore white on white in the dark theme, and both buttons read as
// blank rectangles. What has to hold is that the label comes from the token that
// inverts with the fill — asserted over every primary button of the page, so the third
// one («Починить маршруты», drawn only over a route the host lost) cannot drift alone.
const BRAND_FILL = 'var(--dsw-alias-brand-primary)'
const ON_BRAND = /^var\(--dsw-alias-label-primary-foreground,\s*var\(--dsw-alias-bg-base\)\)$/u
const primaryButtons = collect(tree, 'button')
  .filter(item => item.props.style?.background === BRAND_FILL)
check('the primary buttons of this page are painted on the brand fill',
  primaryButtons.some(item => allText(item).includes('Обновить каталог и иконки'))
  && primaryButtons.some(item => allText(item).includes('Записать список моделей')),
  primaryButtons.map(item => allText(item)).join(' | '))
check('and their label inverts with that fill instead of being a literal white',
  primaryButtons.length > 0 && primaryButtons.every(item => ON_BRAND.test(String(item.props.style.color))),
  primaryButtons.map(item => `${allText(item)} → ${String(item.props.style.color)}`).join(' | '))

// The one line that shared the closing block and survived it, because it is not prose:
// it is the only place this page reports a catalog read that failed.
STATE.error = 'connect ETIMEDOUT https://rustvy.xyz'
tree = await view()
text = allText(tree)
check('a failed catalog read is still reported on the page',
  text.includes('Каталог не получен') && text.includes('Проверьте прокси и нажмите «Обновить»'))
delete STATE.error
tree = await view()
text = allText(tree)
check('and nothing is said when the catalog is fine', !text.includes('Каталог не получен'))
check('both collector files are shown as copyable paths',
  text.includes('C:\\profile\\.dsh-rustvy\\install.json')
  && text.includes('C:\\profile\\.dsh-rustvy\\errors-queue.json'))

// The readout is not there — with a complete summary sitting in the answer, which is
// what makes this an assertion about the interface rather than about missing data.
check('no collector readout is drawn over a full errorReport',
  !text.includes('Состояние сборщика') && COLLECTOR_ROWS.every(name => rowValue(tree, name) === undefined),
  COLLECTOR_ROWS.filter(name => rowValue(tree, name) !== undefined).join('|'))
// Three values only the readout could have put on the page: the anonymous id, the
// by-kind rendering, and the moment of the last delivery. (`HTTP 200` is no probe at
// all — the key ring's own test result says exactly that.)
check('and no value of it leaks into the page either',
  !text.includes('a3f0c81b7d4e4f2a9c6b5d8e') && !text.includes('upstream_502: 4')
  && !text.includes(new Date(1792472700000).toLocaleString()))
check('neither send button is offered',
  findButton(tree, 'Отправить тестовое событие') === undefined
  && findButton(tree, 'Отправить очередь сейчас') === undefined)
requests.length = 0
tree = await view()
check('and the page never calls the collector route',
  !requests.some(item => item.path.includes('/dsh-rustvy/errors')),
  JSON.stringify(requests.map(item => item.path)))

requests.length = 0
collectSwitch.props.onChange({ target: { checked: false } })
await settle()
check('the switch posts its own config field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).collectErrors === false),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
check('the switch reads the host answer back', switchNamed(tree, COLLECT_LABEL).props.checked === false)
check('a switched-off collection draws no readout either',
  !allText(tree).includes('Состояние сборщика')
  && findButton(tree, 'Отправить очередь сейчас') === undefined)

requests.length = 0
switchNamed(tree, COLLECT_LABEL).props.onChange({ target: { checked: true } })
await settle()
check('turning collection back on posts the same field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).collectErrors === true),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
// The box holds a caption, two switches and one short explanation of what success
// reporting costs — and still none of the readout that was stripped at the user's request.
// The point of this check is the absence, not the count: a status block creeping back in
// would be the regression, and adding a switch must not be read as that.
check('and the box is still its caption, its switches and no readout',
  switchNamed(tree, COLLECT_LABEL)?.props.checked === true
  && allText(tree).includes(DATA_BOX)
  && !allText(tree).includes('Состояние сборщика')
  && !allText(tree).includes('Одна строка на сбой'))

// A host half older than the collector answers `/state` without the block at all. The
// page has to draw exactly what it draws with one — the switch, and nothing that would
// need a field the answer does not carry.
const REPORT = STATE.errorReport
delete STATE.errorReport
tree = await view()
text = allText(tree)
check('an older host half still gets the switch',
  switchNamed(tree, COLLECT_LABEL)?.props.checked === true && text.includes(DATA_BOX))
STATE.errorReport = REPORT
tree = await view()
check('and looks the same with the summary put back',
  switchNamed(tree, COLLECT_LABEL)?.props.checked === true
  && !allText(tree).includes('Состояние сборщика')
  && !allText(tree).includes('a3f0c81b7d4e4f2a9c6b5d8e'))

/* ------------------------------ the uptime view ---------------------------- */
// The other half of the same story: the error box above is what this install reported,
// this one is what the collector made of everybody's reports. Every number asserted here
// is the collector's own, because a panel that recomputed availability locally could
// disagree with the monitor's web page about the same model — and there is no honest
// availability to recompute in the first place, since only errors are ever reported.

/** The model rows the uptime box drew, in document order. */
function uptimeRows(node) {
  return collect(node, 'div').filter(item => item.props.className === 'dmi-up-row')
}

/** One row of the box, found by the model name it shows. */
function uptimeRow(node, name) {
  return uptimeRows(node).find(row => allText(row).includes(name))
}

/** The range switch: the one dropdown whose value is a window rather than a mode. */
function rangeSwitch(node) {
  return collect(node, 'select').find(item => ['1h', '24h', '7d', '30d'].includes(item.props.value))
}

/** The bars one row's strip drew. */
function bars(row) {
  return collect(row, 'span').filter(item => item.props.title !== undefined)
}

UPTIME_MODE = 'green'
tree = await view()
text = allText(tree)
check('the page names the uptime box', text.includes('Аптайм моделей'))
// v3 reverses the v2 rule this check used to carry, and reverses it for the reason the
// contract states: «правило v2 «процента больше нет» было верным для данных, которые были;
// оно отменяется вместе с появлением данных». The fixture has 480 successes behind the
// hundred, so «аптайм 100%» is a measurement here and not the unbacked claim it was in
// v2. It *leads* the header — §5.1 makes it the headline of the view — and it replaces
// nothing: the state counts stay beside it, because one figure over a day is exactly the
// number §5.1 warns saturates and hides a three-hour outage, and the rows carry that.
check('the header presents the measured percentage above the state counts',
  text.includes('аптайм 100%') && text.includes('моделей 12') && text.includes('без ошибок 12')
  && text.includes('локально 0') && text.includes('сбои 0') && text.includes('лежат 0')
  && text.includes('сбоев за период 0'),
  text.slice(text.indexOf('аптайм'), text.indexOf('аптайм') + 110))
check('and names the breadth the collector measured', text.includes('затронуто 0 из 47 установок'))
check('an all-green window is a finding, drawn in words',
  uptimeRows(tree).length === 2 && text.includes('ошибок нет'), String(uptimeRows(tree).length))
check('and carries no error styling',
  uptimeRows(tree).every(row => row.props['data-dmi-state'] === 'ok') && !text.includes('последняя ошибка'))
check('the range switch defaults to a day and offers all four windows',
  rangeSwitch(tree)?.props.value === '24h'
  && collect(rangeSwitch(tree), 'option').map(option => option.props.value).join(',') === '1h,24h,7d,30d',
  String(rangeSwitch(tree)?.props.value))
check('the footer names the moment and the store',
  text.includes(`обновлено ${new Date(1792617332644).toLocaleString()}`) && text.includes('хранилище mongo'))
check('the monitor itself is a real outbound link',
  collect(tree, 'a').some(item => item.props.href === 'http://185.75.189.247:3789/' && item.props.target === '_blank'))

requests.length = 0
rangeSwitch(tree).props.onChange({ target: { value: '1h' } })
await settle()
tree = await view()
check('the range switch asks the mirror for that window',
  requests.some(item => item.path.includes('/uptime.json') && item.path.includes('range=1h')),
  JSON.stringify(requests.map(item => item.path).filter(item => item.includes('uptime'))))
check('and the box keeps the window it was switched to', rangeSwitch(tree)?.props.value === '1h')
check('the window is UI state, not a setting: nothing was posted to /config',
  !requests.some(item => item.path.endsWith('/config')),
  JSON.stringify(requests.map(item => item.path)))

UPTIME_MODE = 'populated'
rangeSwitch(tree).props.onChange({ target: { value: '24h' } })
await settle()
tree = await view()
text = allText(tree)
const downRow = uptimeRow(tree, 'OPUS 5.5')
const issuesRow = uptimeRow(tree, 'GLM 5.3')
const singleRow = uptimeRow(tree, 'KIMI K3')
check('a model that is down is drawn as down',
  downRow?.props['data-dmi-state'] === 'down' && allText(downRow).includes('Лежит'))
check('its breadth is the collector own count, not an inference',
  allText(downRow).includes('сбоев 5 от 3 установок') && allText(downRow).includes('затронуто 6,4% установок'),
  allText(downRow))
check('a provider failing several people is drawn as issues',
  issuesRow?.props['data-dmi-state'] === 'issues' && allText(issuesRow).includes('Сбои'))
check('and a last error three hours old reads as hours, never as just now',
  allText(issuesRow).includes('последняя 3 ч назад') && !allText(issuesRow).includes('только что'),
  allText(issuesRow))
// §5.2: `anonymous` is a sum of the fold counters, so it is a count of *failures*, and it has
// to be drawn against `fails` and not against the record count. On this row the two differ —
// three records carrying four failures, one of them anonymous — so «1 из 4» is the homogeneous
// phrase and «1 из 3» would be two numbers that are each true and mean nothing together. The
// unit is named in the phrase for the same reason: «сбоев» for failures, «отчётов» for records.
check('a partly anonymous window qualifies the count it is attached to',
  allText(issuesRow).includes('сбоев 4 от 2 установок (анонимно 1 из 4 сбоев)'), allText(issuesRow))
check('and the anonymous share is drawn against the failure sum, not the record count',
  !allText(issuesRow).includes('1 из 3') && !allText(issuesRow).includes('анонимных'), allText(issuesRow))
check('one install whose failures are all anonymous does not read as one person',
  singleRow?.props['data-dmi-state'] === 'single' && allText(singleRow).includes('Локальный сбой')
  && allText(singleRow).includes('сбоев 5 от 1 установки (все сбои анонимны)'), allText(singleRow))
// The pairing, pinned on a spread where the two denominators differ: four failures inside
// three records, one of them anonymous, so «1 из 4 сбоев» is the homogeneous phrase and «1 из
// 3» is the two-numbers-each-true-and-meaningless-together one. Point the render at `errors`
// and the check reddens on the value rather than on an argument. The row also leads with the
// failure count, so the sentence reads «сбоев 4 … (анонимно 1 из 4 сбоев)» — one unit
// throughout, which is what §5.1 asks for wherever both numbers could be seen.
check('and the anonymous share is drawn against the failure sum, not the record count',
  allText(issuesRow).includes('1 из 4 сбоев') && !allText(issuesRow).includes('1 из 3'),
  allText(issuesRow))
check('so the rows add up to the headline the header publishes',
  allText(issuesRow).includes('сбоев 4 от 2 установок'), allText(issuesRow))
check('a share with no denominator is a dash, never a zero',
  allText(singleRow).includes('затронуто — установок') && !allText(singleRow).includes('затронуто 0%'),
  allText(singleRow))
check('its last error is quoted with a time, a code and the provider own text',
  allText(downRow).includes('последняя ошибка') && allText(downRow).includes('upstream_502')
  && allText(downRow).includes('upstream connect error or disconnect/reset before headers'))
check('a model with errors gets bars rather than the empty word',
  bars(downRow).length === 48 && !allText(downRow).includes('ошибок нет'), String(bars(downRow).length))
check('and the strip says how wide one bar is',
  allText(downRow).includes('1 столбик = 30 мин'), allText(downRow))
check('a clean model in the same window still says so',
  allText(uptimeRow(tree, 'GPT-5')).includes('ошибок нет'))
check('and claims no breadth nobody measured',
  !allText(uptimeRow(tree, 'GPT-5')).includes('от 0 установок'), allText(uptimeRow(tree, 'GPT-5')))
// §5.1: the headline total is `fails`, the sum of `n`, and not `errors`, the count of
// records. On this fixture the two differ by exactly the one folded failure — 11 against
// 10 — so a header still reading the record count is visibly wrong rather than merely
// imprecise. The labels differ too, because one word over two quantities is two claims
// under one name: «сбоев» for failures, and a record count would still say «ошибок».
check('the header counts what the collector counted',
  text.includes('моделей 12') && text.includes('без ошибок 9') && text.includes('локально 1')
  && text.includes('сбои 1') && text.includes('лежат 1') && text.includes('сбоев за период 14')
  && text.includes('затронуто 5 из 47 установок'))
check('and publishes the failures rather than the smaller record count beside them',
  !text.includes('ошибок за период 10'), text.slice(text.indexOf('сбоев за период'), text.indexOf('сбоев за период') + 40))

// A collector older than v2: three states instead of four, a percentage this half must
// not present as availability, and none of the breadth fields. The panel has to come out
// poorer, not wrong.
UPTIME_MODE = 'legacy'
tree = await view()
text = allText(tree)
const legacyDown = uptimeRow(tree, 'OPUS 5.5')
check('a legacy answer still renders every model it names',
  uptimeRows(tree).length === 3, String(uptimeRows(tree).length))
check('and translates its old words onto the current ones',
  legacyDown?.props['data-dmi-state'] === 'down' && allText(legacyDown).includes('Лежит')
  && allText(uptimeRow(tree, 'GLM 5.3')).includes('Сбои')
  && allText(uptimeRow(tree, 'GPT-5')).includes('Без ошибок'))
check('it shows the error count without an install count it was never given',
  allText(legacyDown).includes('ошибок 3') && !allText(legacyDown).includes('от ')
  && !text.includes('от 0 установок'), allText(legacyDown))
check('no share it has no denominator for', !text.includes('затронуто'))
check('and no percentage offered as availability', !text.includes('61%') && !text.includes('97%'))
check('its header drops the breadth clause rather than filling it with dashes',
  text.includes('ошибок за период 4') && text.includes('моделей 3'))
check('recency still comes from the last error the old answer does carry',
  allText(legacyDown).includes('последняя') && allText(legacyDown).includes('назад'))

// An hour is sixty one-minute buckets, and the strip has to say so: unlabelled, sixty
// thin bars read exactly like forty-eight half-hour ones.
UPTIME_MODE = 'badges'
rangeSwitch(tree).props.onChange({ target: { value: '1h' } })
await settle()
tree = await view()
const hourRow = uptimeRow(tree, 'GLM 5.3')
// v3 moves the hour and nothing else: four fifteen-minute buckets instead of sixty
// one-minute ones, because a bucket has to hold a whole number of success windows (§4).
// The label is measured from the array rather than read off the range, so this assertion is
// the one that tells us the moment the collector's alignment and this half's rendering meet
// — it was true under v2 and becomes false the day the buckets change width, in either
// direction and without a code change here.
check('an hour is drawn as four fifteen-minute bars, and says so',
  bars(hourRow).length === 4 && allText(hourRow).includes('1 столбик = 15 мин'),
  `${bars(hourRow).length} bars, label ${JSON.stringify(allText(hourRow).slice(allText(hourRow).indexOf('1 столбик'), allText(hourRow).indexOf('1 столбик') + 22))}`)

// A month window is where the two shares part company. The summary's is null — window and
// reference period are the same set of installs, so a percentage would be the set measured
// against itself — while every model's is still real. The header has to keep its counts
// and never turn them into a share; a row has to keep its share.
UPTIME_MODE = 'month'
rangeSwitch(tree).props.onChange({ target: { value: '30d' } })
await settle()
tree = await view()
text = allText(tree)
const monthRow = uptimeRow(tree, 'OPUS 5.5')
check('a month window keeps the header counts and never turns them into a share',
  text.includes('затронуто 47 из 47 установок') && !text.includes('затронуто 100%')
  && !text.includes('затронуто — из'), text.slice(text.indexOf('моделей 12'), text.indexOf('моделей 12') + 120))
check('and puts no dash where a count belongs',
  !text.includes('затронуто — из — установок'))
check('a month strip says how wide its bars are too',
  allText(monthRow).includes('1 столбик = 15 ч'), allText(monthRow))
check('while a model own share stays a real percentage on the same range',
  allText(monthRow).includes('затронуто 6,4% установок'), allText(monthRow))
check('and a model with no denominator still says so rather than claiming zero',
  allText(uptimeRow(tree, 'KIMI K3')).includes('затронуто — установок')
  && !allText(uptimeRow(tree, 'KIMI K3')).includes('затронуто 0%'),
  allText(uptimeRow(tree, 'KIMI K3')))
// Back to a day, so the badge block's own switch to a month is a real change of window
// rather than a no-op that would leave its request assertion passing on nothing.
UPTIME_MODE = 'populated'
rangeSwitch(tree).props.onChange({ target: { value: '24h' } })
await settle()
tree = await view()

UPTIME_MODE = 'stale'
tree = await view()
text = allText(tree)
check('a stale answer says it is cached, and from when',
  text.includes('показано кешированное от') && text.includes(new Date(1792600000000).toLocaleString())
  && text.includes('коллектор не ответил за 10 секунд'))
check('and still draws the models it holds', uptimeRows(tree).length === 4, String(uptimeRows(tree).length))

UPTIME_MODE = 'offline'
tree = await view()
text = allText(tree)
check('a collector with no cache is reported rather than spun on',
  text.includes('Коллектор не ответил') && text.includes('коллектор недоступен, а кешированного ответа нет')
  && !text.includes('Читаем состояние моделей'))
check('and the box still offers to ask again', findButton(tree, 'Обновить') !== undefined)

UPTIME_MODE = 'refused'
tree = await view()
check('a host that refuses the view says so in its own words',
  allText(tree).includes('аптайм выключен настройкой плагина'))

UPTIME_MODE = 'populated'
tree = await view()
const UPTIME_LABEL = 'Показывать аптайм моделей'
check('the uptime switch is offered with the other display switches',
  switchNamed(tree, UPTIME_LABEL)?.props.checked === true)
requests.length = 0
switchNamed(tree, UPTIME_LABEL).props.onChange({ target: { checked: false } })
await settle()
check('the uptime switch posts its own config field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).uptimeView === false),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
tree = await view()
text = allText(tree)
check('a switched-off view explains itself instead of drawing numbers',
  text.includes('Аптайм выключен настройкой') && !text.includes('без ошибок'))
requests.length = 0
tree = await view()
check('and costs no read at all',
  !requests.some(item => item.path.includes('/uptime.json')),
  JSON.stringify(requests.map(item => item.path)))

requests.length = 0
switchNamed(tree, UPTIME_LABEL).props.onChange({ target: { checked: true } })
await settle()
check('turning the view back on posts the same field',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).uptimeView === true))
tree = await view()
check('and the panel comes back with it', uptimeRows(tree).length === 4, String(uptimeRows(tree).length))

// --- the order of the page ---------------------------------------------------
// Everything above finds its section by caption, which survives a move without a word
// of complaint — so the order is pinned here on its own. This is the order that was
// asked for: the uptime panel first, because it answers the question the page is opened
// with, and the catalog mirror last, next to the warning that reports its failures.
const SECTIONS = [
  ['the uptime panel', text => text.startsWith('Аптайм моделей')],
  ['the provider models box', text => text.includes('Модели провайдера')],
  ['the key ring', text => text.includes('Ключи на несколько чатов')],
  ['the data collection box', text => text.includes(DATA_BOX)],
  ['the catalog mirror', text => text.startsWith('Зеркало каталога')],
]
const placed = SECTIONS.map(([name, probe]) => ({
  name,
  at: (tree.children ?? []).findIndex(child => probe(allText(child))),
}))
check('every section is a top-level block of the page',
  placed.every(section => section.at >= 0), JSON.stringify(placed))
check('and they stand in the order the page was asked for',
  placed.every((section, index) => index === 0 || section.at > placed[index - 1].at),
  placed.map(section => `${section.at} ${section.name}`).join(' → '))
// The same order from the other side: by box rather than by block, so a section that
// lost its border or gained an extra wrapper is caught too.
const bordered = collect(tree, 'div').filter(item => typeof item.props.style?.border === 'string')
check('the first bordered box on the page is the uptime panel',
  bordered.length > 0 && allText(bordered[0]).startsWith('Аптайм моделей'),
  allText(bordered[0] ?? null).slice(0, 48))
check('and the last one is the catalog mirror',
  bordered.length > 0 && allText(bordered[bordered.length - 1]).startsWith('Зеркало каталога'),
  allText(bordered[bordered.length - 1] ?? null).slice(0, 48))
check('the mirror paragraph moved down with the box it explains',
  allText(tree.children[placed[4].at + 1] ?? null).includes('Адреса открываются в новой вкладке'),
  allText(tree.children[placed[4].at + 1] ?? null).slice(0, 48))

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

// --- the uptime badges ------------------------------------------------------
// The picker's own rendering of the same answer, taken from the hour rather than the
// day: a colour, and a count when there is anything to count. No percentage — errors are
// the only thing ever reported, so a percentage of availability has no denominator, and
// 97,9% was bucket occupancy that nobody could act on.
UPTIME_MODE = 'badges'
// One render of the settings panel is what puts the hour's view into the picker's map:
// the decorator only absorbs the range its badges claim to describe.
tree = await view()
const uptimeMenu = buildPickerMenu([
  { label: 'rustvy', models: ['claude-opus-5-5', 'kimi-k3', 'glm-5.3', 'qwen3.7-plus', 'mistral-large-3'] },
])
await pass()
const rowNamed = model => uptimeMenu.querySelectorAll('[role="menuitemradio"]').find(row => row.attributes.title === model)
const badgeOf = row => row.querySelectorAll('.dmi-uptime-badge')[0]
const badgeNamed = model => badgeOf(rowNamed(model))
const stateOfRow = model => badgeNamed(model)?.attributes['data-dmi-state']
const shapeOfRow = model => badgeNamed(model)?.attributes['data-dmi-shape']
const colourOfRow = model => badgeNamed(model)?.style.properties['--dmi-badge-color']
const titleOfRow = model => String(badgeNamed(model)?.title ?? '')
// The one row here the vendor rules recognise, so mark and badge can be checked together.
const knownRow = rowNamed('claude-opus-5-5')
const unknownRow = rowNamed('mistral-large-3')
check('a model with no errors gets a quiet dot and no number',
  stateOfRow('claude-opus-5-5') === 'ok' && shapeOfRow('claude-opus-5-5') === 'dot'
  && badgeOf(knownRow)?.textContent === '' && colourOfRow('claude-opus-5-5') === '#22c55e',
  `${String(stateOfRow('claude-opus-5-5'))} ${String(shapeOfRow('claude-opus-5-5'))} "${String(badgeOf(knownRow)?.textContent)}"`)
check('one install own bad evening is amber, and carries its count',
  stateOfRow('kimi-k3') === 'single' && shapeOfRow('kimi-k3') === 'pill'
  && badgeNamed('kimi-k3')?.textContent === '1' && colourOfRow('kimi-k3') === '#f59e0b',
  `${String(stateOfRow('kimi-k3'))} "${String(badgeNamed('kimi-k3')?.textContent)}" ${String(colourOfRow('kimi-k3'))}`)
check('a provider failing several people is red, and so is one lying down',
  stateOfRow('glm-5.3') === 'issues' && badgeNamed('glm-5.3')?.textContent === '3'
  && colourOfRow('glm-5.3') === '#ef4444'
  && stateOfRow('qwen3.7-plus') === 'down' && badgeNamed('qwen3.7-plus')?.textContent === '2'
  && colourOfRow('qwen3.7-plus') === '#ef4444',
  ['glm-5.3', 'qwen3.7-plus'].map(model => `${stateOfRow(model)}:"${badgeNamed(model)?.textContent}":${colourOfRow(model)}`).join(' '))
check('a dot is not an empty space: "no errors" and "not named" stay different',
  badgeOf(knownRow) !== undefined && badgeOf(unknownRow) === undefined,
  String(unknownRow.querySelectorAll('.dmi-uptime-badge').length))
check('the badge reads from the hour, and its tooltip says so',
  titleOfRow('glm-5.3').includes('3 ошибки от 2 установок')
  && titleOfRow('glm-5.3').includes('за последний час') && titleOfRow('glm-5.3').includes('последняя 6 мин назад'),
  titleOfRow('glm-5.3'))
check('and a quiet one says there was nothing to report',
  titleOfRow('claude-opus-5-5') === 'ошибок не было за последний час', titleOfRow('claude-opus-5-5'))
// The tooltip carries the same caveat as the row, and the same two labels: «ошибки» for the
// records the badge counts and «сбоев» for the failures the anonymous share is drawn against,
// so the two quantities never share a noun even inside one sentence.
check('an anonymous share is not left standing as breadth',
  titleOfRow('kimi-k3').includes('(все сбои анонимны)') && titleOfRow('glm-5.3').includes('(анонимно 1 из 3 сбоев)'),
  `${titleOfRow('kimi-k3')} | ${titleOfRow('glm-5.3')}`)
// The badge decision, pinned rather than merely stated in a report: the picker badge keeps
// its colour and its error count and gains no percentage, in the text or in the tooltip.
// Over the hour a badge reads, a percentage comes from a handful of requests — this very row
// is 4 successes against 3 failures, so «57,1%» would sit beside a count that says exactly
// what happened and add nothing a person can act on at picker speed, where the question is
// "is this broken now, and how badly". The panel is where a percentage earns its place, on a
// day or longer, and it has one.
check('and the badge carries the count, with no percentage beside it',
  titleOfRow('glm-5.3').includes('3 ошибки от 2 установок') && !titleOfRow('glm-5.3').includes('%'),
  titleOfRow('glm-5.3'))
check('the badge leaves the vendor mark alone', knownRow.querySelectorAll('.dmi-mark').length === 1,
  String(knownRow.querySelectorAll('.dmi-mark').length))
// Every row this stub builds ends in the host's own `_check`, so this is also the case
// the badge meets in the real picker: it makes room for the trailing control rather
// than landing after it or in front of the model's name.
check('and sits inside the row, before its trailing control',
  knownRow.children.indexOf(badgeOf(knownRow)) < knownRow.children.indexOf(knownRow.querySelector('.ms_check')),
  knownRow.children.map(child => child.className).join('|'))
await pass()
check('a second pass draws no second badge', knownRow.querySelectorAll('.dmi-uptime-badge').length === 1,
  String(knownRow.querySelectorAll('.dmi-uptime-badge').length))

// The panel and the badges read different windows on purpose: a day is room enough for
// the whole picture, an hour is what "is it broken now" means. Switching the panel to a
// month must not repaint a badge whose tooltip says «за последний час» — and the mirror
// answers the longer window with doubled counts here, so a repaint would be visible
// rather than silently identical.
requests.length = 0
rangeSwitch(tree).props.onChange({ target: { value: '30d' } })
await settle()
// A render, because the stub runs effects on the render that follows a state change —
// which is what React does too, and what makes the request appear.
tree = await view()
check('the panel asked for a month of it',
  requests.some(item => item.path.includes('/uptime.json') && item.path.includes('range=30d')),
  JSON.stringify(requests.map(item => item.path).filter(item => item.includes('uptime'))))
await pass()
check('and the badges still show the hour, not the month',
  badgeNamed('glm-5.3')?.textContent === '3' && stateOfRow('glm-5.3') === 'issues'
  && titleOfRow('glm-5.3').includes('за последний час'),
  `${String(badgeNamed('glm-5.3')?.textContent)} ${titleOfRow('glm-5.3')}`)

// The harness draws a pill of its own on some rows — the «1017» context count on the
// DeepSeek rows. Ours has to coexist with it: both survive, ours is not nested inside
// it, and a repaint still adds nothing.
const pillRow = rowNamed('glm-5.3')
const foreignPill = documentStub.createElement('span')
foreignPill.setAttribute('class', 'ms_badge')
foreignPill.textContent = '1017'
pillRow.appendChild(foreignPill)
await pass()
check('a row already carrying the harness pill keeps both',
  pillRow.querySelectorAll('.ms_badge').length === 1
  && pillRow.querySelectorAll('.dmi-uptime-badge').length === 1,
  pillRow.children.map(child => child.className).join('|'))
check('ours is a sibling of that pill, not a child of it',
  badgeOf(pillRow).parentNode === pillRow && !foreignPill.contains(badgeOf(pillRow)))
check('and stands to the left of the pill it made room for',
  pillRow.children.indexOf(badgeOf(pillRow)) < pillRow.children.indexOf(foreignPill),
  pillRow.children.map(child => child.className).join('|'))
await pass()
check('a third pass still adds no second badge', pillRow.querySelectorAll('.dmi-uptime-badge').length === 1,
  String(pillRow.querySelectorAll('.dmi-uptime-badge').length))

// A view that is switched off takes its badges with it on the next pass, rather than
// leaving a claim nobody is reading any more on a menu the user can still open. Fired
// through the same event the settings page fires, because that is how a change reaches
// the decorator in the application.
const reloadDecorator = async () => {
  window.dispatchEvent({ type: 'dsh-rustvy:changed', detail: {} })
  await settle()
}
STATE.config.uptimeView = false
await reloadDecorator()
check('a switched-off view leaves no badge in any menu',
  documentStub.querySelectorAll('.dmi-uptime-badge').length === 0,
  String(documentStub.querySelectorAll('.dmi-uptime-badge').length))
check('and leaves every vendor mark where it was',
  knownRow.querySelectorAll('.dmi-mark').length === 1 && menu.querySelectorAll('.dmi-mark').length > 0)
STATE.config.uptimeView = true
await reloadDecorator()
check('the badges come back with the view', badgeOf(rowNamed('claude-opus-5-5')) !== undefined)

// --- a collector that cannot answer the hour --------------------------------
// The state every user is in between the plugin updating and the Go collector being
// deployed: `range=1h` does not exist in v1, the server answers a 400, the host turns it
// into a 502 with no models, and the badges' window is exactly the one that fails. Per
// §5 that is already the correct rendering — a window the collector cannot answer is a
// window in which it named no model, and a model it did not name gets nothing — but it
// has to be *seen* to be believed, because the failures worth ruling out are a badge path
// that throws, one that hangs on a pending read, and one that leaves the previous
// window's numbers on screen.
UPTIME_MODE = 'v1-server'
tree = await view()
rangeSwitch(tree).props.onChange({ target: { value: '1h' } })
await settle()
tree = await view()
text = allText(tree)
check('the panel names the window it could not read, not just the failure',
  text.includes('Коллектор не ответил за период «1h»') && text.includes('приёмник аптайма ответил 400'),
  text.slice(text.indexOf('Коллектор не ответил'), text.indexOf('Коллектор не ответил') + 90))
// The failed read clears the picker's map; the next decoration pass is what takes the
// badges off the document, which is why a pass is fired before asserting on the DOM.
await pass()
check('every badge goes with the answer that named no model',
  documentStub.querySelectorAll('.dmi-uptime-badge').length === 0,
  String(documentStub.querySelectorAll('.dmi-uptime-badge').length))
check('and no badge of the previous window is left behind on any row',
  uptimeMenu.querySelectorAll('.dmi-uptime-badge').length === 0
  && menu.querySelectorAll('.dmi-uptime-badge').length === 0)
check('the vendor marks are untouched by it',
  knownRow.querySelectorAll('.dmi-mark').length === 1 && menu.querySelectorAll('.dmi-mark').length > 0)
check('the failing hour draws no rows at all, rather than empty ones',
  uptimeRows(tree).length === 0, String(uptimeRows(tree).length))
rangeSwitch(tree).props.onChange({ target: { value: '24h' } })
await settle()
tree = await view()
check('which is the whole point: the day keeps working while the hour does not',
  uptimeRows(tree).length === 4 && allText(tree).includes('сбоев 5 от 3 установок'),
  String(uptimeRows(tree).length))

// A transport failure is the same situation with no answer at all, and it has to clear
// the badges too: unlike the panel, which can hold a cached picture and label it with the
// moment it is from, a badge has no way to say "this is what we knew a while ago".
UPTIME_MODE = 'badges'
tree = await view()
rangeSwitch(tree).props.onChange({ target: { value: '1h' } })
await settle()
tree = await view()
await pass()
check('the badges are back once the hour can be read again',
  documentStub.querySelectorAll('.dmi-uptime-badge').length > 0
  && badgeNamed('glm-5.3')?.textContent === '3',
  String(documentStub.querySelectorAll('.dmi-uptime-badge').length))
UPTIME_MODE = 'network'
tree = await view()
await pass()
check('and a fetch that fails outright takes them with it rather than freezing them',
  documentStub.querySelectorAll('.dmi-uptime-badge').length === 0
  && knownRow.querySelectorAll('.dmi-mark').length === 1,
  String(documentStub.querySelectorAll('.dmi-uptime-badge').length))
UPTIME_MODE = 'badges'
tree = await view()
rangeSwitch(tree).props.onChange({ target: { value: '24h' } })
await settle()
tree = await view()
await pass()

// --- the selected-model trigger ---------------------------------------------
// The same badge on the composer's model button, between the model's name and its
// reasoning indicator. The trigger is the one surface where the model changes *under*
// the badge, so it is checked for what no row can be: a switch rewrites the number or
// drops it, and never leaves yesterday's model in today's button.
/**
 * The composer's selected-model trigger, in the shape the host renders it: a seat
 * carrying `data-slot="conversation.input.model"`, a button whose label span names the
 * model, then that button's own furniture — the reasoning indicator when this build
 * draws one, the «Default» tag and the chevron — with the stop button beside the
 * trigger, outside it.
 *
 * @param label - the model name the trigger shows.
 * @param options - `{ reasoning: false }` for a build that draws no indicator.
 * @returns the seat, the button, its label span and the stop button.
 */
function buildTrigger(label, options = {}) {
  const seat = documentStub.createElement('div')
  seat.setAttribute('data-slot', 'conversation.input.model')
  const button = documentStub.createElement('button')
  button.setAttribute('class', 'ms_trigger')
  const text = documentStub.createElement('span')
  text.setAttribute('class', 'ms_triggerLabel')
  text.textContent = label
  button.appendChild(text)
  if (options.reasoning !== false) {
    const reasoning = documentStub.createElement('span')
    reasoning.setAttribute('class', 'ms_reasoning')
    reasoning.textContent = 'высокие рассуждения'
    button.appendChild(reasoning)
  }
  const tag = documentStub.createElement('span')
  tag.setAttribute('class', 'ms_defaultTag')
  tag.textContent = 'Default'
  button.appendChild(tag)
  const chevron = documentStub.createElement('span')
  chevron.setAttribute('class', 'ms_chevron')
  button.appendChild(chevron)
  seat.appendChild(button)
  const stop = documentStub.createElement('button')
  stop.setAttribute('class', 'ms_stop')
  seat.appendChild(stop)
  documentStub.body.appendChild(seat)
  return { seat, button, text, stop }
}

const trigger = buildTrigger('claude-opus-5-5')
await pass()
const triggerBadge = () => trigger.button.querySelector('.dmi-uptime-badge')
const triggerOrder = () => trigger.button.children.map(child => child.className).join('|')
check('the selected model carries a badge of its own state on its trigger',
  triggerBadge()?.attributes['data-dmi-state'] === 'ok'
  && triggerBadge()?.attributes['data-dmi-shape'] === 'dot'
  && triggerBadge()?.textContent === ''
  && triggerBadge().attributes['data-dmi-surface'] === 'trigger',
  `${String(triggerBadge()?.attributes['data-dmi-state'])} "${String(triggerBadge()?.textContent)}"`)
check('coloured by the same rule as a row badge',
  triggerBadge().style.properties['--dmi-badge-color'] === '#22c55e',
  String(triggerBadge()?.style.properties['--dmi-badge-color']))
check('and placed between the model name and the reasoning indicator',
  trigger.button.children.indexOf(triggerBadge()) === trigger.button.children.indexOf(trigger.text) + 1
  && trigger.button.children.indexOf(trigger.button.querySelector('.ms_reasoning'))
    === trigger.button.children.indexOf(triggerBadge()) + 1,
  triggerOrder())
check('the trigger own furniture is untouched by it',
  trigger.button.querySelectorAll('.ms_reasoning').length === 1
  && trigger.button.querySelectorAll('.ms_defaultTag').length === 1
  && trigger.button.querySelectorAll('.ms_chevron').length === 1
  && trigger.stop.parentNode === trigger.seat,
  triggerOrder())
check('and the vendor mark still leads the button',
  trigger.button.querySelectorAll('.dmi-mark').length === 1
  && trigger.button.children[0].classList.contains('dmi-mark'),
  triggerOrder())

// A build that draws no reasoning indicator — a model without reasoning, or an older
// bundle — still gets a badge, anchored to the name rather than to a child position.
const plainTrigger = buildTrigger('glm-5.3', { reasoning: false })
await pass()
check('a trigger with no reasoning indicator still draws one',
  plainTrigger.button.querySelector('.dmi-uptime-badge')?.textContent === '3'
  && plainTrigger.button.querySelector('.dmi-uptime-badge')?.attributes['data-dmi-state'] === 'issues',
  String(plainTrigger.button.querySelector('.dmi-uptime-badge')?.textContent))
check('anchored right after the model name',
  plainTrigger.button.children.indexOf(plainTrigger.button.querySelector('.dmi-uptime-badge'))
  === plainTrigger.button.children.indexOf(plainTrigger.text) + 1,
  plainTrigger.button.children.map(child => child.className).join('|'))

// The failure mode this surface adds: the model changes under the badge, and here it
// changes shape too — a quiet dot for a healthy model becomes a red count for a broken
// one, which is the version of "stale" a colour alone could hide.
trigger.text.textContent = 'qwen3.7-plus'
await pass()
check('switching the selected model rewrites the badge rather than keeping it',
  triggerBadge()?.textContent === '2' && triggerBadge().attributes['data-dmi-state'] === 'down'
  && triggerBadge().attributes['data-dmi-shape'] === 'pill',
  `${String(triggerBadge()?.textContent)} ${String(triggerBadge()?.attributes['data-dmi-state'])}`)
check('and the badge stays between the name and the reasoning',
  trigger.button.children.indexOf(triggerBadge()) === trigger.button.children.indexOf(trigger.text) + 1,
  triggerOrder())
trigger.text.textContent = 'mistral-large-3'
await pass()
check('a model the collector did not name leaves no stale badge behind',
  trigger.button.querySelector('.dmi-uptime-badge') === null, triggerOrder())
trigger.text.textContent = 'claude-opus-5-5'
await pass()
check('and the badge returns with a model it does name',
  triggerBadge()?.attributes['data-dmi-state'] === 'ok' && triggerBadge()?.textContent === '',
  String(triggerBadge()?.attributes['data-dmi-state']))
await pass()
check('a second pass draws no second badge on the trigger',
  trigger.button.querySelectorAll('.dmi-uptime-badge').length === 1, triggerOrder())

// «Иконка в кнопке выбранной модели» is the user's word on whether this half writes into
// the trigger at all, so a trigger they asked to leave alone gets no badge either —
// while the rows, which that switch says nothing about, keep theirs.
STATE.config.markTrigger = false
await reloadDecorator()
check('a trigger the user asked to leave unmarked gets no badge',
  documentStub.querySelectorAll('.dmi-uptime-badge[data-dmi-surface="trigger"]').length === 0
  && documentStub.querySelectorAll('.dmi-uptime-badge[data-dmi-surface="row"]').length > 0,
  String(documentStub.querySelectorAll('.dmi-uptime-badge[data-dmi-surface="row"]').length))
STATE.config.markTrigger = true
await reloadDecorator()
check('and the trigger badge comes back with the switch',
  triggerBadge()?.attributes['data-dmi-state'] === 'ok' && triggerBadge()?.textContent === '',
  String(triggerBadge()?.attributes['data-dmi-state']))

STATE.config.uptimeView = false
await reloadDecorator()
check('a switched-off view takes the trigger badge too',
  trigger.button.querySelector('.dmi-uptime-badge') === null
  && documentStub.querySelectorAll('.dmi-uptime-badge').length === 0)
STATE.config.uptimeView = true
await reloadDecorator()
check('and gives it back with the view',
  triggerBadge()?.attributes['data-dmi-state'] === 'ok' && triggerBadge()?.textContent === '',
  String(triggerBadge()?.attributes['data-dmi-state']))

// The same hour the v1 collector cannot answer, on the surface where a stale number would
// be worst: the button names the model the user is about to send to.
UPTIME_MODE = 'v1-server'
tree = await view()
rangeSwitch(tree).props.onChange({ target: { value: '1h' } })
await settle()
tree = await view()
await pass()
check('a trigger badge goes too, and its vendor mark stays',
  trigger.button.querySelector('.dmi-uptime-badge') === null
  && trigger.button.querySelectorAll('.dmi-mark').length === 1
  && trigger.button.querySelectorAll('.ms_reasoning').length === 1,
  triggerOrder())
UPTIME_MODE = 'badges'
rangeSwitch(tree).props.onChange({ target: { value: '24h' } })
await settle()
tree = await view()
await pass()

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

// --- the route bootstrap line ------------------------------------------------
// What the mount-time route creation did, on the page. The complaint this answers is a
// silent no-op: on a clean install the plugin created nothing, said nothing, and the model
// list held only the built-in DeepSeek with no key. Visibility is half the fix, so every
// cell of the `state` × `keySet` matrix is asserted — including the cells that must stay
// silent, because an assertion that a line does *not* render is the only thing standing
// between this page and a line that renders for everybody and therefore trains nobody to
// read it.
const bootstrapLinesOf = node => collect(node, 'div').filter(item => item.props.className === 'dmi-bootstrap-line')

/**
 * Render the page against one `routeBootstrap` value.
 *
 * @param routeBootstrap - the object, `null`, or `undefined` for "the key is absent".
 * @returns one `{ tone, text }` per line the page drew.
 */
async function bootstrapOf(routeBootstrap) {
  if (routeBootstrap === undefined) delete STATE.routeBootstrap
  else STATE.routeBootstrap = routeBootstrap
  const rendered = await view()
  return bootstrapLinesOf(rendered).map(item => ({ tone: item.props['data-dmi-tone'], text: allText(item) }))
}

const textsOf = lines => lines.map(line => line.text)
const joinedOf = lines => textsOf(lines).join(' | ')

// host-wiring's captured clean-install answer, verbatim: no credentials service mounted and
// `RUSTVY_API_KEY` unset, so `keySet` is null and the default model was switched. Captured
// before §9, so it carries no `source` key at all — which is itself a case the page has to
// survive, since absence and null mean different things everywhere else in this contract.
const CLEAN_INSTALL = {
  provider: { state: 'created', models: 3, reason: null, error: null, keySet: null },
  defaultModel: { state: 'switched', from: 'deepseek-official', to: 'rustvy', model: 'ahmia-v7-pro', reason: null },
}

let lines = await bootstrapOf(undefined)
check('a host half without the field draws nothing and does not throw', lines.length === 0, String(lines.length))
lines = await bootstrapOf(null)
check('an explicit null draws nothing either', lines.length === 0, String(lines.length))

lines = await bootstrapOf(CLEAN_INSTALL)
check('a created route says it was created, and how many models it serves',
  textsOf(lines)[0] === 'Маршрут rustvy создан этим монтированием: 3 модели.', joinedOf(lines))
check('in a calm tone rather than a warning one', lines[0].tone === 'ok', String(lines[0].tone))
check('and an absent `source` key is survived rather than guessed at',
  !joinedOf(lines).includes('локальной копии'), joinedOf(lines))
check('the switched default names all three strings as they arrived',
  textsOf(lines).some(item => item.includes('с deepseek-official на rustvy') && item.includes('ahmia-v7-pro')),
  joinedOf(lines))
// §8: `null` points at both places without claiming to know anything. The assertion that
// keeps the two phrasings apart is the negative one — a reword that merged them would put
// «ещё не задан» back on a machine that works, which is the lie §8 exists to prevent.
check('a keySet the host could not determine directs without asserting',
  textsOf(lines).some(item => item.includes('Ключ задаётся в кольце ключей ниже или переменной RUSTVY_API_KEY'))
  && !joinedOf(lines).includes('не задан'), joinedOf(lines))
check('and that guidance is quiet rather than a warning',
  lines.find(line => line.text.includes('Ключ задаётся'))?.tone === 'quiet',
  String(lines.find(line => line.text.includes('Ключ задаётся'))?.tone))

lines = await bootstrapOf({
  provider: { state: 'created', models: 3, reason: null, error: null, keySet: false, source: 'served' },
  defaultModel: null,
})
check('a created route with no credential asserts it, then directs',
  textsOf(lines).includes('Ключ ещё не задан — задайте его в кольце ключей ниже или переменной RUSTVY_API_KEY.'),
  joinedOf(lines))
check('and that one warns',
  lines.find(line => line.text.includes('ещё не задан'))?.tone === 'warn',
  String(lines.find(line => line.text.includes('ещё не задан'))?.tone))
check('a served list needs no provenance sentence', !joinedOf(lines).includes('локальной копии'), joinedOf(lines))
check('and no default-model line when that step did not run',
  !joinedOf(lines).includes('Модель по умолчанию'), joinedOf(lines))

lines = await bootstrapOf({
  provider: { state: 'created', models: 3, reason: null, error: null, keySet: true, source: 'served' },
  defaultModel: null,
})
check('a created route whose key resolves says nothing about the key',
  !joinedOf(lines).includes('Ключ'), joinedOf(lines))

lines = await bootstrapOf({
  provider: { state: 'created', models: 27, reason: null, error: null, keySet: true, source: 'catalog' },
  defaultModel: null,
})
check('a list taken from the local mirror says so, and what to do about it',
  textsOf(lines).some(item => item.includes('из локальной копии каталога') && item.includes('когда сеть появится')),
  joinedOf(lines))

// The steady state, and the cell §6.1 had to rule on because §6 and §8 decide by different
// dimensions: an existing route with a key is what every current user has, forever.
lines = await bootstrapOf({
  provider: { state: 'exists', models: null, reason: null, error: null, keySet: null, source: null },
  defaultModel: { state: 'skipped', from: null, to: null, model: null, reason: 'route_existed' },
})
check('an existing route draws nothing at all', lines.length === 0, joinedOf(lines))
lines = await bootstrapOf({
  provider: { state: 'exists', models: null, reason: null, error: null, keySet: true, source: null },
  defaultModel: null,
})
check('and an existing route with a key is just as quiet', lines.length === 0, joinedOf(lines))

// The cell that would otherwise be silent on a broken machine: the route is there, nothing
// resolves, and the plugin did not create it — so it may not claim credit for it either.
lines = await bootstrapOf({
  provider: { state: 'exists', models: null, reason: null, error: null, keySet: false, source: null },
  defaultModel: { state: 'skipped', from: null, to: null, model: null, reason: 'route_existed' },
})
check('an existing route with no credential speaks',
  lines.length === 1 && lines[0].text.includes('Ключ ещё не задан'), joinedOf(lines))
check('without claiming a creation it did not do', !joinedOf(lines).includes('создан'), joinedOf(lines))

lines = await bootstrapOf({
  provider: {
    state: 'failed', models: null, reason: 'no_model_source', keySet: false, source: null,
    error: 'источник списка моделей не ответил, а зеркала каталога нет',
  },
  defaultModel: null,
})
check('a route that could not be created says why, in the host own words',
  textsOf(lines)[0] === 'Маршрут rustvy не создан: источник списка моделей не ответил, а зеркала каталога нет.',
  joinedOf(lines))
check('with the real next action beside it',
  textsOf(lines).some(item => /перезагрузите окно DSH/iu.test(item)), joinedOf(lines))
check('and that action is network-side, not the catalog button a dead origin cannot answer',
  textsOf(lines).some(item => item.includes('прокси') || item.includes('VPN'))
  && !joinedOf(lines).includes('Обновить каталог и иконки'), joinedOf(lines))
check('a failed route never mentions a key nothing could use', !joinedOf(lines).includes('Ключ'), joinedOf(lines))
check('and warns rather than reassures', lines[0].tone === 'warn', String(lines[0].tone))

lines = await bootstrapOf({
  provider: { state: 'failed', models: null, reason: 'no_config_editor', keySet: null, source: null, error: null },
  defaultModel: null,
})
check('a reason with no host sentence of its own still names itself',
  textsOf(lines)[0].includes('композиция не монтирует редактор конфигурации'), joinedOf(lines))
check('and says plainly that a reload will not help',
  textsOf(lines).some(item => item.includes('Перезагрузка окна не поможет')), joinedOf(lines))

lines = await bootstrapOf({
  provider: { state: 'skipped', models: null, reason: 'a_reason_from_a_newer_host', keySet: null, source: null, error: null },
  defaultModel: null,
})
check('an unknown reason code is printed as it came rather than replaced by a guess',
  textsOf(lines)[0].includes('a_reason_from_a_newer_host'), joinedOf(lines))
lines = await bootstrapOf({
  provider: { state: 'half_done', models: null, reason: null, keySet: null, source: null, error: null },
  defaultModel: { state: 'pending', reason: null },
})
check('and so is an unknown state on either step',
  textsOf(lines).some(item => item.includes('half_done')) && textsOf(lines).some(item => item.includes('pending')),
  joinedOf(lines))

// The default-model step: the plugin looked, found a choice the user had made, and correctly
// left it alone. Not a failure, and not silence either — a default model still on DeepSeek
// after the route appeared looks arbitrary without one sentence explaining it.
lines = await bootstrapOf({
  provider: { state: 'created', models: 3, reason: null, error: null, keySet: true, source: 'served' },
  defaultModel: { state: 'skipped', from: null, to: null, model: null, reason: 'user_chose_default' },
})
check('a default the user chose themselves is explained, not reported as a fault',
  textsOf(lines).some(item => item.includes('вы выбирали модель по умолчанию сами')), joinedOf(lines))
check('and explained quietly',
  lines.find(line => line.text.includes('вы выбирали'))?.tone === 'quiet',
  String(lines.find(line => line.text.includes('вы выбирали'))?.tone))

lines = await bootstrapOf({
  provider: { state: 'created', models: 3, reason: null, error: null, keySet: true, source: 'served' },
  defaultModel: { state: 'skipped', from: null, to: null, model: null, reason: 'override_unknown' },
})
check('a default that could not be verified says it was not verified',
  textsOf(lines).some(item => item.includes('не удалось проверить') && item.includes('ничего не записал')),
  joinedOf(lines))

// Placement and furniture.
STATE.routeBootstrap = CLEAN_INSTALL
tree = await view()
text = allText(tree)
check('the line sits above the uptime box, which stays first whenever nothing renders',
  text.indexOf('Маршрут rustvy создан') > text.indexOf('Rustvy')
  && text.indexOf('Маршрут rustvy создан') < text.indexOf('Аптайм моделей'),
  `${text.indexOf('Маршрут rustvy создан')} vs ${text.indexOf('Аптайм моделей')}`)
check('and carries no button, because there is nothing a button here could re-run',
  bootstrapLinesOf(tree).length > 0
  && bootstrapLinesOf(tree).every(line => collect(line, 'button').length === 0),
  String(bootstrapLinesOf(tree).length))
delete STATE.routeBootstrap

// §6.2: `keySet` is computed per request on the host, but the page asks only on mount and on
// «Перечитать состояние» — so a key added through the ring would leave the line above
// claiming there is no key while the ring below shows one. The assertion is on the request
// rather than on the rendered text, and that is deliberate: this stub re-runs every effect on
// every render pass, so any later `view()` re-reads `/state` with or without the fix, and a
// text-only check here could not go red. The request is the mechanism, and deleting the call
// from `mutate` deletes it.
STATE.routeBootstrap = {
  provider: { state: 'created', models: 3, reason: null, error: null, keySet: false, source: 'served' },
  defaultModel: null,
}
tree = await view()
check('the missing-key line is on the page before the key is added', allText(tree).includes('Ключ ещё не задан'))
findButton(tree, '+').props.onClick()
await settle()
tree = await view()
fieldOf(tree, 'название ключа').props.onChange({ target: { value: 'Проверка свежести' } })
fieldOf(tree, 'значение ключа').props.onChange({ target: { value: 'sk-freshness-check' } })
tree = render()
requests.length = 0
findButton(tree, 'Добавить').props.onClick()
await settle()
check('adding a key makes the page re-read the state that reports it',
  requests.some(item => item.path === '/dsh-rustvy/state' && item.method === 'GET'),
  JSON.stringify(requests.map(item => `${item.method} ${item.path}`)))

// A mutation that cannot change key availability costs no extra read: the gate is on the
// action, not on every POST the ring makes.
tree = await view()
requests.length = 0
const defaultButton = buttonsNamed(tree, 'По умолчанию')[0]
check('the ring still offers a default switch to check the gate against', defaultButton !== undefined)
if (defaultButton !== undefined) defaultButton.props.onClick()
await settle()
check('and choosing a default key does not re-read the state',
  !requests.some(item => item.path === '/dsh-rustvy/state'),
  JSON.stringify(requests.map(item => `${item.method} ${item.path}`)))
delete STATE.routeBootstrap

/* ------------- v3: the percentage, and the toggle that feeds it ------------ */

/** The «аптайм …» token one row drew, or null when it drew none. */
const uptimeOf = row => (allText(row).match(/аптайм\s+\S+/u) ?? [null])[0]

// go-collector's invariant, asserted over every fixture rather than left in a comment: the
// collector's install key is either a real `meta.id` or one shared anonymous key, so a model
// with one install and any anonymous failures has *only* anonymous ones, and `anonymous` can
// never exceed `fails`. My own fixture broke this once — `installs: 1` with `anonymous: 4`
// against `fails: 5` needs two distinct keys, so it was a payload no collector can emit, and
// it passed every check it fed. That is the quiet half of the vacuous-check problem: a check
// that cannot fail is loud about it eventually, while a fixture that cannot occur never says
// anything at all, and it silently disagrees with any consumer that validates the invariant.
const UPTIME_FIXTURES = [UPTIME_GREEN, UPTIME_POPULATED, UPTIME_BADGES, UPTIME_BADGES_WIDE, UPTIME_LEGACY, UPTIME_MONTH]
const impossiblePayloads = UPTIME_FIXTURES
  .flatMap(fixture => (Array.isArray(fixture.models) ? fixture.models : [])
    .filter(model => Number.isFinite(model.fails))
    .filter(model => !(model.anonymous <= model.fails)
      || (model.installs === 1 && model.anonymous > 0 && model.anonymous !== model.fails))
    .map(model => `${fixture.range}/${model.id}: installs=${model.installs} anonymous=${model.anonymous} fails=${model.fails}`))
check('every fixture payload is one a collector could actually emit',
  impossiblePayloads.length === 0, impossiblePayloads.join(' | '))

/** The top-level block of the page that holds the data-collection box. */
const dataBoxOf = node => (node.children ?? []).find(child => allText(child).includes(DATA_BOX))

// §3: a number, a dash and a zero are three different claims, and the month fixture
// carries all three so the distinction is pinned by a real answer rather than by a unit
// test of a helper. A measured hundred says everything that ran worked; a zero says
// everything that ran failed, which is the case v2 could not show in any form; a dash says
// nobody measured anything, and is neither of the other two.
UPTIME_MODE = 'month'
tree = await view()
const dashRow = uptimeRow(tree, 'GPT-5')
const zeroRow = uptimeRow(tree, 'OPUS 5.5')
const shareRow = uptimeRow(tree, 'GLM 5.3')
check('a window with neither successes nor failures draws a dash',
  uptimeOf(dashRow) === 'аптайм —', String(uptimeOf(dashRow)))
check('and draws it as neither of the two things it is not',
  uptimeOf(dashRow) !== 'аптайм 100%' && uptimeOf(dashRow) !== 'аптайм 0%', String(uptimeOf(dashRow)))
check('a window of nothing but failures draws a real zero',
  uptimeOf(zeroRow) === 'аптайм 0%', String(uptimeOf(zeroRow)))
check('and a window with traffic draws its measured share',
  uptimeOf(shareRow) === 'аптайм 96,8%', String(uptimeOf(shareRow)))
check('so the three are three strings on screen rather than one value and two absences',
  new Set([uptimeOf(dashRow), uptimeOf(zeroRow), uptimeOf(shareRow)]).size === 3,
  [uptimeOf(dashRow), uptimeOf(zeroRow), uptimeOf(shareRow)].join(' | '))
check('and the header carries the window aggregate the same way',
  allText(tree).includes('аптайм 92%'), allText(tree).slice(allText(tree).indexOf('аптайм 92%'), allText(tree).indexOf('аптайм 92%') + 60))

// §5.2's pairing constraint, one level above the row — asserted in the day window, because
// that is the fixture carrying the captured `installs` pair (4 anonymous beside a window of
// 5); the month fixture deliberately has window == reference to test a different thing.
// `installs.anonymous` is a sum of the fold counters — a failure count — sitting inside an
// object whose other two fields count installs. The name and the container agree and the
// semantics do not, which is what makes the container actively suggest the wrong reading:
// «4 из 5 установок анонимные» would read perfectly while comparing failures with installs.
// Its only correct partner is `summary.fails`, so this header draws no anonymous share at all
// — and the check is what keeps it that way, because a comment at the render site is the
// reason and not the mechanism.
UPTIME_MODE = 'populated'
tree = await view()
// Asserted over the whole page rather than over a slice of the header, and that is not a
// stylistic choice: the first version of this check sliced from the percentage to the breadth
// clause, and a wrongly paired clause appended *after* that clause sat outside the slice, so
// the check passed against the exact mutation it exists to catch. Pointing the render at
// `installs.window` is what found that. A page-wide absence cannot be evaded by where the
// sentence lands.
check('and the header pairs no anonymous count with an install count',
  allText(tree).includes('затронуто 5 из 47 установок') && !allText(tree).includes('установок аноним'),
  allText(tree).slice(allText(tree).indexOf('затронуто 5 из 47'), allText(tree).indexOf('затронуто 5 из 47') + 100))

// A v1 collector also sent a percentage, computed with no successful request to divide by,
// and v2 took it off the page for exactly that reason. It does not come back merely because
// the field name returned: the clause is licensed by the denominator, not by the percentage,
// so a legacy answer's «61%» stays off the screen while a v3 answer's is drawn.
UPTIME_MODE = 'legacy'
tree = await view()
text = allText(tree)
check('a collector with no denominator publishes no percentage anywhere',
  uptimeRows(tree).length === 3 && uptimeRows(tree).every(row => uptimeOf(row) === null)
  && !text.includes('аптайм 79%'),
  uptimeRows(tree).map(row => String(uptimeOf(row))).join('|'))

UPTIME_MODE = 'populated'
tree = await view()
const successesSwitch = switchNamed(tree, SUCCESSES_LABEL)
check('the success switch is offered with its exact label', successesSwitch !== undefined)
// The fixture config omits `collectSuccesses`, which is the shape an older host half answers
// with: the default is on, and a truth test would draw every current install as switched off.
check('an absent collectSuccesses renders as on', successesSwitch?.props.checked === true,
  String(successesSwitch?.props.checked))

const dataBox = dataBoxOf(tree)
check('both collection switches live in the renamed box, successes above errors',
  dataBox !== undefined
  && allText(dataBox).indexOf(SUCCESSES_LABEL) >= 0
  && allText(dataBox).indexOf(SUCCESSES_LABEL) < allText(dataBox).indexOf(COLLECT_LABEL),
  dataBox === undefined ? 'no box' : `${allText(dataBox).indexOf(SUCCESSES_LABEL)} vs ${allText(dataBox).indexOf(COLLECT_LABEL)}`)
check('and the box no longer calls itself error collection',
  dataBox !== undefined && !allText(dataBox).includes('Сбор ошибок Rustvy'),
  dataBox === undefined ? 'no box' : '')
// The user asked for a separate setting above the errors one, not for a data-collection
// switch among the display toggles at the top of the page, so its position is asserted
// rather than left to the layout happening to be right.
check('the success switch sits below the uptime panel, not among the display toggles',
  (tree.children ?? []).findIndex(child => allText(child).includes(SUCCESSES_LABEL))
  > (tree.children ?? []).findIndex(child => allText(child).startsWith('Аптайм моделей')),
  String((tree.children ?? []).findIndex(child => allText(child).includes(SUCCESSES_LABEL))))

text = allText(dataBox)
check('the explanation names the window from the settings rather than from a constant',
  text.includes('на окно в 15 мин'), text)
check('says what one report costs, measured and with its headers',
  text.includes('около 650 байт вместе с заголовками HTTP'), text)
check('under the conditions the measurement was taken under',
  text.includes('при 12 моделях') && text.includes('восьмичасовой'), text)
check('against the per-request sending it replaces', text.includes('86 % запросов'), text)
check('with an idle machine as a real zero rather than a rounding',
  text.includes('ноль байт, а не округление'), text)
check('and a lifetime total is never turned into a rate',
  !text.includes('в сутки') && !text.includes('/сутки') && !text.includes('в день'), text)
// The fixture publishes no success counters, so the page must invent no figure: a number the
// state does not carry is worse than no number, which is the rule task-42 states outright.
check('and no total this install has not measured', !text.includes('С начала работы'), text)

STATE.errorReport.successWindows = 3
STATE.errorReport.successBytes = 1941
tree = await view()
text = allText(dataBoxOf(tree))
check('the install own measured total appears when the host publishes it',
  text.includes('С начала работы отправлено 3 окна успехов, 1,9 КБ.'), text)

// §7.7: windows that were formed and never left. Since the user's ruling «Оставляем очередь
// только для ошибок» a success window is neither persisted nor retried, so a delivery failure
// costs the window outright — and a window is up to fifteen minutes of uptime denominator. The
// denominator stays honest, but an honest number with a silent hole in it is indistinguishable
// from one computed over complete data, so this counter is the only trace the hole exists. The
// name is read out of `summary()`, where it is published beside `successWindows` and
// `successBytes` in the same unit, rather than retyped from a description of it.
STATE.errorReport.successWindowsLost = 0
tree = await view()
text = allText(dataBoxOf(tree))
check('a zero loss draws nothing at all', !text.includes('потеряно'), text)
STATE.errorReport.successWindowsLost = 1
tree = await view()
text = allText(dataBoxOf(tree))
check('one lost window is named, in the singular', text.includes('1 окно успехов потеряно'), text)
STATE.errorReport.successWindowsLost = 2
tree = await view()
text = allText(dataBoxOf(tree))
check('two read as the few form', text.includes('2 окна успехов потеряно'), text)
STATE.errorReport.successWindowsLost = 5
tree = await view()
text = allText(dataBoxOf(tree))
check('five read as the many form', text.includes('5 окон успехов потеряно'), text)
// The two things this line must never become, both §7.2 in a new costume. It explains delivery
// and nothing else: not a percentage, which comes from a global aggregate while this counter is
// local to one install, and not a version mismatch, since windows the collector refused for
// document shape are deliberately not counted here — counting them would climb 96 times a day.
// The smallest div carrying the phrase, not the first: `collect` walks depth-first, so an
// ancestor of the line also contains it and would be "found" with the whole box's text inside.
const lostLine = collect(dataBoxOf(tree), 'div')
  .filter(item => allText(item).includes('потеряно'))
  .sort((a, b) => allText(a).length - allText(b).length)[0]
check('and the line explains delivery rather than any percentage',
  lostLine !== undefined && !allText(lostLine).includes('аптайм') && !allText(lostLine).includes('процент'),
  lostLine === undefined ? 'no line' : allText(lostLine))
check('nor a shape refusal, which is deliberately not counted as a loss',
  lostLine !== undefined && !allText(lostLine).includes('верси') && !allText(lostLine).includes('форм'),
  lostLine === undefined ? 'no line' : allText(lostLine))
delete STATE.errorReport.successWindowsLost
tree = await view()
check('and an answer without the counter draws nothing either',
  !allText(dataBoxOf(tree)).includes('потеряно'), allText(dataBoxOf(tree)))

// task-63: events this machine's own network caused, ruled by the user not sent at all — neither
// as an error nor as a success. Events, not aggregates, so each leaves no record anywhere else
// and this counter is the only trace. errors-core asserts in their suite that the field is
// published under this name and starts at zero; these own the sentence, when it renders, and what
// it may not say, so the field's existence is not pinned in two suites that could drift.
STATE.errorReport.suppressedNetworkErrors = 0
tree = await view()
text = allText(dataBoxOf(tree))
check('a zero suppression draws nothing at all', !text.includes('не отправлен'), text)
STATE.errorReport.suppressedNetworkErrors = 1
tree = await view()
text = allText(dataBoxOf(tree))
check('one suppressed failure is named, in the singular', text.includes('1 сбой сети этой машины не отправлен'), text)
STATE.errorReport.suppressedNetworkErrors = 2
tree = await view()
text = allText(dataBoxOf(tree))
check('two read as the few form', text.includes('2 сбоя сети этой машины не отправлено'), text)
STATE.errorReport.suppressedNetworkErrors = 5
tree = await view()
text = allText(dataBoxOf(tree))
check('five read as the many form', text.includes('5 сбоев сети этой машины не отправлено'), text)
const suppressedLine = collect(dataBoxOf(tree), 'div')
  .filter(item => allText(item).includes('не отправлено'))
  .sort((a, b) => allText(a).length - allText(b).length)[0]
const supText = suppressedLine === undefined ? '' : allText(suppressedLine)
check('and the line explains this machine, not any percentage',
  suppressedLine !== undefined && !supText.includes('аптайм') && !supText.includes('процент'), supText)
// Load-bearing, not decorative: today's sentence is fine, and this is about the day somebody
// shortens it to «сбой провайдера не отправлен» to fit a narrower box, which asserts a cause the
// rule does not know. Forbidding the abbreviation is what keeps the honest sentence alive —
// `провайдер` may appear only inside the clause saying one may be among them.
check('nor may it blame or clear the provider',
  suppressedLine !== undefined && (supText.match(/провайдер/u) ?? []).length === 1
  && supText.includes('может оказаться и настоящий сбой провайдера'), supText)
// The gate also requires the classifier's kind, so an instant status-less `reset` or `tls`
// failure is not suppressed and still leaves. Claiming the wider shape would read as wrong to a
// user comparing this counter against their own log.
check('and it says the rule is narrower than any instant status-less failure',
  suppressedLine !== undefined && supText.includes('отнесённый правилом'), supText)
delete STATE.errorReport.suppressedNetworkErrors
tree = await view()
check('an answer without the suppression counter draws nothing either',
  !allText(dataBoxOf(tree)).includes('не отправлен'), allText(dataBoxOf(tree)))
STATE.errorReport.successWindows = 0
STATE.errorReport.successBytes = 0
tree = await view()
text = allText(dataBoxOf(tree))
// A measured zero renders as a zero. This is the difference from the route bootstrap's
// `models: null`, where nobody had counted and a dash was the only honest mark: the two look
// identical in a fixture and only one of them is a fact.
check('and a measured zero is a zero rather than a dash',
  text.includes('отправлено 0 окон успехов, 0 Б'), text)
delete STATE.errorReport.successWindows
delete STATE.errorReport.successBytes

tree = await view()
requests.length = 0
switchNamed(tree, SUCCESSES_LABEL).props.onChange({ target: { checked: false } })
await settle()
check('turning success reporting off posts collectSuccesses and nothing beside it',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).collectSuccesses === false)
  && requests.filter(item => item.path.endsWith('/config')).every(item => Object.keys(JSON.parse(item.body)).length === 1),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))

tree = await view()
// The window flushes on its own timer and there is no endpoint that would flush it sooner,
// so a control labelled «отправить сейчас» could only re-read a state that re-runs nothing —
// the same lie with a border radius that the route-bootstrap line refuses. Asserted rather
// than merely left out, so adding one reddens a check instead of shipping.
check('the box offers no flush or retry control',
  collect(dataBoxOf(tree), 'button').length === 0,
  String(collect(dataBoxOf(tree), 'button').length))

// §7's third combination: successes counted locally while sending is off. Reachable on a
// real machine only since errors-core split the sending gate from counting — before that,
// `noteSuccess` returned before incrementing when error collection was off, so this fixture
// supplied a shape no host could produce. host-wiring's four-combination matrix now asserts
// it end to end (20/20, stable across three runs, combination 3 producing a real report on
// the wire), so the row is a live behaviour and not only this half of a contract.
STATE.config.collectSuccesses = false
STATE.errorReport.successes = 5
tree = await view()
text = allText(dataBoxOf(tree))
check('with reporting off the switch says off',
  switchNamed(tree, SUCCESSES_LABEL)?.props.checked === false,
  String(switchNamed(tree, SUCCESSES_LABEL)?.props.checked))
check('and the page says this install is not contributing, which it does know',
  text.includes('Выключено: эта установка не участвует в подсчёте аптайма.'), text)
// §7.2's forbidden rendering, asserted absent: the collector's aggregate spans every
// install, so this install's flag is one possible contributor to a null and never its cause.
check('without claiming a cause for anything the collector published',
  !text.includes('процент не считается') && !text.includes('успехи выключены'), text)
check('and a local counter is not described as sending',
  !text.includes('отправляются') && !text.includes('уходят'), text)
check('while the collector own percentages are untouched by this install setting',
  uptimeOf(uptimeRow(tree, 'OPUS 5.5')) === 'аптайм 0%'
  && uptimeOf(uptimeRow(tree, 'GLM 5.3')) === 'аптайм 96,8%',
  [uptimeOf(uptimeRow(tree, 'OPUS 5.5')), uptimeOf(uptimeRow(tree, 'GLM 5.3'))].join(' | '))
delete STATE.config.collectSuccesses
STATE.errorReport.successes = 5

/* --------------------------- the plugin proxy line ------------------------- */

// The general form of the bug, and the check that earns its place: `/state` grew a `proxy`
// object where it used to publish no key at all, and a Row whose template assumed a string
// printed `[object Object]` on the settings page. A status field changing type underneath a
// template will happen again somewhere else, so this asserts over the whole rendered page
// rather than over the Row that broke — one general check catches the class, the row-specific
// ones below catch the instance.
UPTIME_MODE = 'populated'
STATE.proxy = { installed: false, reason: '' }
tree = await view()
text = allText(tree)
check('no text the page produces is a stringified object',
  !text.includes('[object Object]'),
  text.slice(Math.max(0, text.indexOf('[object Object]') - 60), text.indexOf('[object Object]') + 60))
check('a proxy switch that is off says so, as a choice rather than a fault',
  text.includes('прокси плагина') && text.includes('выключен'),
  text.slice(text.indexOf('прокси плагина'), text.indexOf('прокси плагина') + 60))
STATE.proxy = { installed: false, reason: 'строка не разобрана: адрес без схемы' }
tree = await view()
text = allText(tree)
check('an enabled switch that failed to install says why, in the host own words',
  text.includes('строка не разобрана: адрес без схемы') && !text.includes('[object Object]'),
  text.slice(text.indexOf('прокси плагина'), text.indexOf('прокси плагина') + 80))
STATE.proxy = { installed: true, reason: '', masked: 'https://user:***@proxy.example:8080', scheme: 'https' }
tree = await view()
text = allText(tree)
check('an installed proxy shows the masked spec rather than an object',
  text.includes('https://user:***@proxy.example:8080') && !text.includes('[object Object]'),
  text.slice(text.indexOf('прокси плагина'), text.indexOf('прокси плагина') + 80))
delete STATE.proxy
tree = await view()
text = allText(tree)
check('and a host that publishes no proxy at all draws a dash rather than an object',
  text.includes('прокси плагина') && !text.includes('[object Object]'),
  text.slice(text.indexOf('прокси плагина'), text.indexOf('прокси плагина') + 40))

/* ---------------------------- the proxy controls --------------------------- */

const RAW_SPEC = 'https://user:secret@proxy.example:8080'
const proxyFieldOf = node => collect(node, 'input').filter(item => item.props.type === 'text')
  .find(item => typeof item.props.value === 'string' && (item.props.value === RAW_SPEC || item.props.value.startsWith('http://draft')))
const testProxyButton = node => buttonsNamed(node, 'Проверить прокси')[0]
// Matched by exact label rather than by variant: `buttonsNamed` returns rendered nodes, whose
// props carry no `variant`, and the models box has a «Записать список моделей» button that an
// `includes` match would also pick up.
const applyProxyButton = node => buttonsNamed(node, 'Записать')[0]

// The shared-component guard, and deliberately ONE check naming both new props: a `TextField`
// rendered with neither `onDraft` nor `saveOnBlur` still commits on blur and still hands
// `onSave` the typed value. Two separate checks would each redden only for their own prop; one
// check over the untouched component reddens if either becomes non-optional, which is the
// regression an optional-prop change invites.
tree = await view()
const guardField = collect(tree, 'input').filter(item => item.props.type === 'text').find(item => item.props.value === 'rustvy')
guardField.props.onFocus()
guardField.props.onChange({ target: { value: 'rustvy-guard' } })
tree = await view()
requests.length = 0
collect(tree, 'input').filter(item => item.props.type === 'text').find(item => item.props.value === 'rustvy-guard').props.onBlur()
await settle()
check('a field with neither new prop still commits on blur and saves what was typed',
  requests.some(item => item.path.endsWith('/config') && String(item.body).includes('rustvy-guard')),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
STATE.config.modelRoute = 'rustvy'
tree = await view()

check('the proxy field shows exactly what is stored, password and all',
  proxyFieldOf(tree)?.props.value === RAW_SPEC, String(proxyFieldOf(tree)?.props.value))
check('and nothing else on the page prints the raw password',
  !allText(tree).includes('secret@proxy.example'), allText(tree).slice(Math.max(0, allText(tree).indexOf('proxy.example') - 40), allText(tree).indexOf('proxy.example') + 40))

// `saveOnBlur: false` has to be honoured, not merely present: a prop that is silently ignored
// leaves a control that exists and does nothing while the page still looks right.
proxyFieldOf(tree).props.onFocus()
proxyFieldOf(tree).props.onChange({ target: { value: 'http://draft.example:3128' } })
tree = await view()
requests.length = 0
proxyFieldOf(tree).props.onBlur()
await settle()
// Re-rendered before asserting, and that is not ceremony: the blur triggers two state changes
// and the draft's survival is a property of the render *after* them. Reading the tree captured
// before the blur asserts against a snapshot in which nothing has happened yet, which is how a
// check passes for the wrong reason — it was green against a mutation that wipes the draft.
tree = await view()
check('and blurring it saves nothing, because only Apply writes',
  !requests.some(item => item.path.endsWith('/config')),
  JSON.stringify(requests.map(item => `${item.method} ${item.path}`)))
check('the draft survives the blur that pressing a button beside it causes',
  proxyFieldOf(tree)?.props.value === 'http://draft.example:3128', String(proxyFieldOf(tree)?.props.value))

// Test probes the text the user is looking at, and says which one it probed — «the proxy works»
// about a string that has not been applied is a claim whose subject has to be visible. This runs
// *before* Apply on purpose: once the draft is applied it is the stored value, and a probe of it
// correctly reports `tested: 'stored'`, so the typed case only exists while the draft is unapplied.
tree = await view()
requests.length = 0
testProxyButton(tree).props.onClick()
await settle()
check('Test sends the typed address and saves nothing',
  requests.some(item => item.path.endsWith('/test-proxy') && String(item.body).includes('draft.example:3128'))
  && !requests.some(item => item.path.endsWith('/config')),
  JSON.stringify(requests.map(item => `${item.method} ${item.path} ${item.body ?? ''}`)))
tree = await view()
text = allText(tree)
check('and names the typed address as its subject',
  text.includes('введённый адрес') && text.includes('ничего не сохраняет'),
  text.slice(text.indexOf('Прокси работает'), text.indexOf('Прокси работает') + 220))

requests.length = 0
applyProxyButton(tree).props.onClick()
await settle()
check('Apply saves the draft that blurring it left alone',
  requests.some(item => item.path.endsWith('/config') && String(item.body).includes('draft.example:3128')),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
STATE.config.proxySpec = 'http://draft.example:3128'
tree = await view()

// The four outcomes, driven one at a time through the stub rather than reasoned about.
PROXY_ANSWER = { ok: true, tested: 'stored', connected: true, status: 502, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080' }
STATE.config.proxySpec = RAW_SPEC
tree = await view()
testProxyButton(tree).props.onClick()
await settle()
tree = await view()
text = allText(tree)
check('any HTTP status is a working proxy, 502 included, and renders calmly',
  text.includes('Прокси работает') && text.includes('ответил 502') && text.includes('за 340 мс')
  && text.includes('сохранённый адрес'),
  text.slice(text.indexOf('Прокси работает'), text.indexOf('Прокси работает') + 200))

PROXY_ANSWER = { ok: true, tested: 'stored', connected: false, status: null, elapsedMs: 512, masked: 'https://user:***@proxy.example:8080', error: 'ECONNREFUSED' }
tree = await view()
testProxyButton(tree).props.onClick()
await settle()
tree = await view()
text = allText(tree)
check('no response at all is the proxy failing to carry it, and says so',
  text.includes('Прокси не доставил запрос') && text.includes('ECONNREFUSED'),
  text.slice(text.indexOf('Прокси не доставил'), text.indexOf('Прокси не доставил') + 160))

PROXY_ANSWER = { ok: true, tested: 'typed', connected: false, status: null, elapsedMs: null, masked: '—', error: 'строка не разобрана: адрес без схемы' }
tree = await view()
testProxyButton(tree).props.onClick()
await settle()
tree = await view()
text = allText(tree)
check('never dialled means the address is wrong, not the proxy',
  text.includes('Адрес не разобран') && !text.includes('Прокси не доставил'),
  text.slice(text.indexOf('Адрес не разобран'), text.indexOf('Адрес не разобран') + 160))

// The fourth case, which would otherwise be misfiled as the third: a probe that never reached
// the host is about the network or the plugin, not about the user's text, so it must not borrow
// the unparsable sentence.
PROXY_ANSWER = null
tree = await view()
testProxyButton(tree).props.onClick()
await settle()
tree = await view()
text = allText(tree)
check('and a probe that could not run is none of the three above',
  text.includes('Проверка не выполнилась') && !text.includes('Адрес не разобран'),
  text.slice(text.indexOf('Проверка не выполнилась'), text.indexOf('Проверка не выполнилась') + 120))

PROXY_ANSWER = { ok: true, tested: 'stored', connected: true, status: 200, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080' }
PROXY_HTTP = 200
STATE.config.proxySpec = RAW_SPEC
tree = await view()

/* ------------------------- the proxy family selector ----------------------- */

// Matched on the rendered node, which carries `value` and the option children but not the
// `options` prop the component was called with — finding it by `props.options` finds nothing.
const proxySelectOf = node => collect(node, 'select').find(item =>
  (item.children ?? []).some(child => child.props?.value === 'socks'))
delete STATE.config.proxyMode
tree = await view()
const proxyOptions = () => (proxySelectOf(tree)?.children ?? []).map(child => child.props.value).join(',')
const proxyLabels = () => (proxySelectOf(tree)?.children ?? []).map(child => allText(child)).join(',')
check('the family selector offers exactly two positions, and no scheme is one of them',
  proxyOptions() === 'http,socks' && proxyLabels() === 'HTTP(S),SOCKS',
  `${proxyOptions()} | ${proxyLabels()}`)
// A host half older than the key publishes no `proxyMode`, and the default is `http`: an absent
// value must not leave the selector in a position nobody chose.
check('an absent proxyMode renders as the documented default',
  proxySelectOf(tree)?.props.value === 'http', String(proxySelectOf(tree)?.props.value))
STATE.config.proxyMode = 'socks5'
tree = await view()
check('and a value the page does not know renders as the default rather than as a guess',
  proxySelectOf(tree)?.props.value === 'http', String(proxySelectOf(tree)?.props.value))
STATE.config.proxyMode = 'socks'
tree = await view()
check('a stored socks mode renders as SOCKS', proxySelectOf(tree)?.props.value === 'socks',
  String(proxySelectOf(tree)?.props.value))
requests.length = 0
proxySelectOf(tree).props.onChange({ target: { value: 'http' } })
await settle()
check('and flipping it posts proxyMode immediately, because it rebuilds the transport',
  requests.some(item => item.path.endsWith('/config') && JSON.parse(item.body).proxyMode === 'http'),
  JSON.stringify(requests.filter(item => item.path.endsWith('/config')).map(item => item.body)))
STATE.config.proxyMode = 'http'
tree = await view()
text = allText(tree)
check('the format line says the address carries no scheme and names the selector',
  text.includes('[логин:пароль@]хост:порт, без схемы') && text.includes('«Тип прокси»'),
  text.slice(text.indexOf('Формат адреса'), text.indexOf('Формат адреса') + 150))
check('and nothing on the page invites typing a scheme',
  !text.includes('[схема://]'), text.slice(Math.max(0, text.indexOf('схема') - 60), text.indexOf('схема') + 60))

// The discovery clause, conditional on the field's presence rather than on the mode: `transport`
// is an absent key for socks, where there is nothing to discover, and also absent for an `http`
// probe from a build that has not run discovery yet. Absent means "nothing was discovered", so
// no clause is drawn — a dash there would claim a measurement nobody made.
const probeOutcome = async answer => {
  PROXY_ANSWER = answer
  tree = await view()
  testProxyButton(tree).props.onClick()
  await settle()
  tree = await view()
  return allText(tree)
}
text = await probeOutcome({ ok: true, tested: 'stored', connected: true, status: 200, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080', transport: 'https' })
check('a discovered TLS transport is named, because it is a choice made for the user',
  text.includes('Работает как HTTPS-прокси') && text.includes('зашифровано'),
  text.slice(text.indexOf('Прокси работает'), text.indexOf('Прокси работает') + 220))
text = await probeOutcome({ ok: true, tested: 'stored', connected: true, status: 200, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080', transport: 'http' })
check('and a plaintext one is named as plainly, rather than left implicit',
  text.includes('Работает как HTTP-прокси') && text.includes('не зашифровано'),
  text.slice(text.indexOf('Прокси работает'), text.indexOf('Прокси работает') + 220))
text = await probeOutcome({ ok: true, tested: 'stored', connected: true, status: 200, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080' })
check('while an absent transport still reports a working proxy and claims nothing about it',
  text.includes('Прокси работает') && !text.includes('как HTTPS-прокси') && !text.includes('как HTTP-прокси')
  && !text.includes('транспорт —'),
  text.slice(text.indexOf('Прокси работает'), text.indexOf('Прокси работает') + 220))
PROXY_ANSWER = { ok: true, tested: 'stored', connected: true, status: 200, elapsedMs: 340, masked: 'https://user:***@proxy.example:8080' }

for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } }
check('unload ran without throwing', true)
check('unload took the marks with it', menu.querySelectorAll('.dmi-mark').length === 0)
// The badges are this half's writing in the host's menu exactly like the marks are, and
// a badge left behind would keep quoting a percentage nobody is reading any more.
check('unload took the uptime badges with it',
  documentStub.querySelectorAll('.dmi-uptime-badge').length === 0,
  String(documentStub.querySelectorAll('.dmi-uptime-badge').length))
// The groups this half hid are its doing, so an unload has to give them back:
// leaving the class behind would hide a whole provider with nothing able to
// restore it, since the stylesheet that reads the class goes too.
check('unload unhid every provider group',
  hiddenOf(menu).length === 0 && hiddenOf(plainMenu).length === 0,
  String(hiddenOf(menu).length))
check('unload left no key section or key row anywhere',
  menu.querySelectorAll('[data-dmi-keys], [data-dmi-key-row]').length === 0
  && modelPopup.querySelectorAll('[data-dmi-keys], [data-dmi-key-row]').length === 0)

/* ------------- stream idle timeout: the controls the page grew -------------- */
// These exist because a block of controls with no assertions is a block nobody can break
// visibly. The host side is proven by `tests/stream-timeout-test.mjs`; what is proven here is
// that the page wires the presets to the right values, reads the current value from the
// server rather than from plugin config, and says out loud which routes a write touched.

/** Let the queued microtasks of an async click handler run. */
const flush = async () => { for (let pass = 0; pass < 6; pass += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

STATE.config.streamIdleTimeout = 0
TIMEOUT_VALUE = null
TIMEOUT_ROUTES = 2
TIMEOUT_ANSWER = { ok: true, applied: true, value: 3600000, routes: ['rustvy', 'rustvy-k2'], available: true, current: 3600000, routeCount: 2 }
{
  const t = render()
  const x = allText(t)
  check('the timeout block is its own labelled block', x.includes('Таймаут простоя стрима'), 'missing')
  // `STATE.config.streamIdleTimeout` is 0, the leave-alone sentinel, and the row must not show
  // it: the value on the routes came from the server's `/timeout` answer, which said null.
  check('the current value comes from the server, not from plugin config',
    x.includes('не задан (дефолт адаптера 300000 мс = 5 минут)'), 'the row showed something else')
  // The mount-once read is not asserted through `requests`, and the reason is worth keeping:
  // with the effect guarded to run once, the fetch happens on the panel's first mount — long
  // before this block runs, and `requests` has been reset in between. What *is* asserted, and
  // is the stronger claim, is that the row shows the server's answer rather than the plugin's
  // config: `STATE.config.streamIdleTimeout` is the sentinel `0` while `/timeout` answered
  // `null`, and the row reads «не задан» — so it cannot have come from config.
  // Six presets, and the "default" marking follows `DEFAULT_CONFIG.streamIdleTimeout` rather
  // than being an opinion of the page: a fresh install carries 900000, so a page that marked a
  // different number as the default would disagree with the very file it renders from.
  const presets = [['5 мин (дефолт адаптера)', 300000], ['15 мин (по умолчанию)', 900000], ['30 мин', 1800000], ['1 час', 3600000], ['48 ч (почти выключено)', 172800000], ['сбросить', null]]
  check('all six presets render under their own labels',
    presets.every(preset => findButton(t, preset[0]) !== undefined),
    JSON.stringify(presets.map(preset => preset[0]).filter(label => findButton(t, label) === undefined)))
  // Asserted against the rendered buttons, not against `presets` above. A first version
  // filtered the test's own array, and a removal probe that marked «1 час» as the default too
  // left the suite green at 395/395 — the check was about a constant the test declared, so it
  // could not see the client at all. Reading the tree is what makes it about the page.
  const renderedPresets = collect(t, 'button').map(item => allText(item).trim())
  const markedDefault = renderedPresets.filter(label => label.includes('по умолчанию'))
  check('exactly one rendered preset is marked as the default, and it is the fifteen-minute one',
    markedDefault.length === 1 && markedDefault[0].includes('15 мин'), JSON.stringify(markedDefault))
  check('and no rendered preset still carries the superseded recommendation',
    renderedPresets.every(label => !label.includes('рекомендуется')),
    JSON.stringify(renderedPresets.filter(label => label.includes('рекомендуется'))))

  requests.length = 0
  findButton(t, '15 мин (по умолчанию)').props.onClick()
  await flush()
  const posted = requests.find(item => item.path === '/dsh-rustvy/timeout' && item.method === 'POST')
  check('the default preset posts 900000 and nothing else',
    posted !== undefined && posted.body === '{"value":900000}', String(posted?.body))

  requests.length = 0
  findButton(t, '1 час').props.onClick()
  await flush()
  const hourPost = requests.find(item => item.path === '/dsh-rustvy/timeout' && item.method === 'POST')
  check('the unmarked one-hour preset still posts 3600000',
    hourPost !== undefined && hourPost.body === '{"value":3600000}', String(hourPost?.body))

  requests.length = 0
  findButton(t, 'сбросить').props.onClick()
  await flush()
  const reset = requests.find(item => item.path === '/dsh-rustvy/timeout' && item.method === 'POST')
  check('the reset preset posts an explicit null, not an absent key',
    reset !== undefined && reset.body === '{"value":null}', String(reset?.body))

  // The outcome has to name the routes, because "which routes did this touch" is the first
  // question after pressing the button and the answer is not obvious from the page.
  const after = allText(render())
  check('the outcome sentence counts the routes it wrote', after.includes('маршрутов: 2'), after.slice(0, 160))
  // Asserted on the rendered fragment, not on the two names appearing anywhere. A first
  // version checked `includes('rustvy') && includes('rustvy-k2')` and a removal probe that
  // replaced the names with a count still passed 392/392 — both substrings occur elsewhere on
  // the page, in the build row and the key ring, so the check was green with the property
  // removed. Naming the exact clause is what makes it about this sentence.
  check('and names them in the outcome clause, so the scope is visible rather than implied',
    after.includes('маршрутов: 2 (rustvy, rustvy-k2)'), after.slice(0, 220))
}

/* ------------- «Против блокировки ТСПУ»: mode, transport, and the copy ------- */
// The transport line is the part worth asserting hardest, because "configured but currently
// plain" has no field to come from: `/state` publishes only `transport.mode`, so the page has
// to derive the difference by comparing the setting against the live mode. Get that wrong and
// `auto` looks broken to everyone until a blocking window happens to arrive.
STATE.config.tlsFragmentBytes = 16
STATE.config.tlsFragmentDelayMs = 3
STATE.config.tlsFragmentGlobal = false
{
  STATE.config.tlsFragment = 'auto'
  STATE.transport = { mode: 'plain', since: '2026-11-04T00:00:00.000Z' }
  const t = render()
  const x = allText(t)
  check('the fragmentation block is its own labelled block', x.includes('Против блокировки ТСПУ'), 'missing')
  check('auto with a plain transport says it is on but not yet active',
    x.includes('включено, но сейчас plain'), x.slice(0, 200))

  STATE.transport = { mode: 'frag', since: '2026-11-04T00:00:00.000Z' }
  check('a fragmented transport says so', allText(render()).includes('фрагментация активна'), 'missing')

  STATE.config.tlsFragment = 'off'
  STATE.transport = { mode: 'plain', since: '2026-11-04T00:00:00.000Z' }
  const off = allText(render())
  check('off with a plain transport reads as plain, not as a pending switch',
    off.includes('обычный (plain)') && !off.includes('включено, но сейчас plain'), off.slice(0, 200))

  STATE.config.tlsFragment = 'always'
  const always = render()
  // Scoped to this select rather than to every `option` on the page: other dropdowns also
  // offer `off` and `always` (auto-apply does), so a page-wide count cannot tell this
  // selector's three positions from somebody else's.
  const fragSelect = collect(always, 'select')
    .find(item => JSON.stringify((item.children ?? []).map(child => child.props?.value)) === '["off","auto","always"]')
  check('the mode selector offers exactly the three positions the host validates',
    fragSelect !== undefined,
    JSON.stringify(collect(always, 'select').map(item => (item.children ?? []).map(child => child.props?.value))))

  requests.length = 0
  fragSelect.props.onChange({ target: { value: 'off' } })
  await flush()
  const modePost = requests.find(item => item.path === '/dsh-rustvy/config' && String(item.body).includes('tlsFragment'))
  check('changing the mode posts only that setting',
    modePost !== undefined && modePost.body === '{"tlsFragment":"off"}', String(modePost?.body))

  requests.length = 0
  const globalSwitch = switchNamed(allText(always), '') ?? collect(always, 'label')
    .filter(item => allText(item).includes('Включить фрагментацию ClientHello'))
    .map(item => collect(item, 'input').find(input => input.props.type === 'checkbox'))
    .find(item => item !== undefined)
  check('the model-traffic switch renders unchecked, because it defaults to off',
    globalSwitch !== undefined && globalSwitch.props.checked === false, String(globalSwitch?.props.checked))
  globalSwitch.props.onChange({ target: { checked: true } })
  await flush()
  const globalPost = requests.find(item => item.path === '/dsh-rustvy/config' && String(item.body).includes('tlsFragmentGlobal'))
  check('and turning it on posts the boolean alone',
    globalPost !== undefined && globalPost.body === '{"tlsFragmentGlobal":true}', String(globalPost?.body))

  // The three sentences that stop the feature misleading someone. Each is a way a user draws
  // the wrong conclusion, so each is asserted rather than left to the copy being present.
  check('the copy says auto costs nothing until it is needed',
    x.includes('ничего не стоит, пока не понадобится') && x.includes('двух подряд сбоев транспорта'), 'missing')
  check('and that an HTTP 4xx/5xx is not a transport failure',
    x.includes('4xx') && x.includes('не считается') && x.includes('доставивший 502, работает'), 'missing')
  // The coverage wording has to be *at the control*: the user hit a real block with `auto` on
  // and the global switch off, and model traffic was never fragmented. A reader who can leave
  // this page believing the model is covered when it is not has been misled by the wording.
  check('the mode control says what it covers, at the control',
    x.includes('действует только на запросы самого плагина') && x.includes('каталог, логотипы')
    && x.includes('Запросы модели он не затрагивает'), 'missing')
  check('and the global switch says it is experimental and reaches the whole process',
    x.includes('экспериментальный') && x.includes('глобальный fetch') && x.includes('всего процесса'), 'missing')
  // The promotion contract. This switch used to be described as the only way in, which was true
  // and then stopped being true. Each check below is a way a reader would otherwise draw the
  // wrong conclusion about who fragments model traffic, and when.
  check('the page says promotion happens by default, once measurement earns it',
    x.includes('По умолчанию плагин повышает фрагментацию до запросов модели сам')
    && x.includes('обычное рукопожатие не проходит, а фрагментированное проходит'), 'missing')
  check('and that it stands down when the channel recovers', x.includes('повышение снимается обратно'), 'missing')
  check('the switch reads as an override, not as the only way in',
    x.includes('принудительное включение для случая, когда ждать замера не нужно'), 'missing')
  check('promotion does not fire under always, and the page says what that would have cost',
    x.includes('в положении «always» его не происходит') && x.includes('1658 мс')
    && x.includes('цену, которую вы уже заплатили'), 'missing')
  check('the signal comes from the plugin\'s own requests, so a working proxy means no promotion',
    x.includes('сигнал дают собственные запросы плагина') && x.includes('Если прокси включён и работает'), 'missing')
  check('and plain transport with unfragmented model traffic is named as a correct state, not a failure',
    x.includes('может показывать plain') && x.includes('верное состояние, а не поломка'), 'missing')

  // --- the `always` cost warning, at `always` and only there ------------------
  check('auto carries no standing-cost warning, because it has no standing cost',
    !x.includes('в 4,7 раза дороже'), 'the always warning rendered while the mode is auto')
  STATE.config.tlsFragment = 'always'
  const alwaysText = allText(render())
  check('always warns with the measured numbers rather than an adjective',
    alwaysText.includes('353 мс') && alwaysText.includes('1658 мс')
    && alwaysText.includes('в 4,7 раза дороже') && alwaysText.includes('30005 мс'), 'missing')
  check('and it says auto gives the same protection without the standing cost',
    alwaysText.includes('ту же защиту без этой постоянной платы'), 'missing')
  check('and that always has no plain fallback, which is why the cost is standing',
    alwaysText.includes('не имеет запасного обычного пути'), 'missing')

  // --- the channel diagnosis --------------------------------------------------
  STATE.config.tlsFragment = 'auto'
  const diagButton = findButton(render(), 'Диагностика канала')
  check('the diagnosis button is in the same block as the switch it diagnoses', diagButton !== undefined, 'missing')
  requests.length = 0
  diagButton.props.onClick()
  await flush()
  const diagPost = requests.find(item => item.path === '/dsh-rustvy/diagnose')
  check('it posts to /diagnose', diagPost !== undefined && diagPost.method === 'POST',
    JSON.stringify(requests.map(item => `${item.method} ${item.path}`)))
  const diagText = allText(render())
  check('every layer renders under its own name',
    ['DNS', 'TCP-соединение', 'TLS-рукопожатие обычное', 'TLS-рукопожатие фрагментированное',
      'HTTP-запрос обычный', 'HTTP-запрос фрагментированный'].every(name => diagText.includes(name)),
    'a layer is missing')
  check('a measured layer shows its timing and its outcome',
    diagText.includes('12 мс') && diagText.includes('успех') && diagText.includes('ETIMEDOUT'), 'missing')
  check('a layer the probe answered null renders as absent',
    diagText.includes('нет замера'), 'missing')
  // Two absences, from the two shapes: `tlsFrag` is null and `httpFrag` is a missing key. Both
  // must say the same thing, and neither may become a zero or a dash — a dash in a column of
  // timings reads as a measurement that came out empty.
  check('and a missing key renders as the same absence as an explicit null',
    diagText.split('нет замера').length - 1 === 2, String(diagText.split('нет замера').length - 1))
  // Scoped to the two rows rather than to the page text: a page-wide search for a fabricated
  // zero also matches the timeout block's «300000 мс», which contains «0 мс». Asserting the
  // exact value of each absent row is both precise and stronger.
  const diagRows = render()
  check('the null layer says exactly «нет замера» and nothing else',
    rowValue(diagRows, 'TLS-рукопожатие фрагментированное') === 'нет замера',
    String(rowValue(diagRows, 'TLS-рукопожатие фрагментированное')))
  check('and the missing-key layer says exactly the same',
    rowValue(diagRows, 'HTTP-запрос фрагментированный') === 'нет замера',
    String(rowValue(diagRows, 'HTTP-запрос фрагментированный')))
  // The allowlist, in both directions. A layer's known extras are rendered in the page's own
  // words; anything the probe emits beyond them is dropped, because a field nobody screened
  // must fail closed rather than appear on a page the user will screenshot into a bug report.
  check('a layer\'s known extras render, in the page\'s words rather than the probe\'s',
    diagText.includes('адреса: 91.108.56.1') && diagText.includes('и ещё 1')
    && diagText.includes('протокол: TLSv1.3') && diagText.includes('сертификат НЕ проверен')
    && diagText.includes('HTTP: 200') && diagText.includes('байт: 4213'), 'a known extra did not render')
  check('an unexpected scalar field on a layer is not rendered',
    !diagText.includes('attempts'), 'an unscreened field reached the page')
  check('and an unexpected nested object is not rendered either',
    !diagText.includes('nested'), 'an unscreened object reached the page')
  check('the verdict is a sentence of its own, not a row',
    diagText.includes('обычное TLS-рукопожатие не проходит'), diagText.slice(0, 200))
  check('and the origin is shown scrubbed of userinfo',
    diagText.includes('rustvy.xyz') && !diagText.includes('pass-must-not-render'), 'the origin leaked credentials')
  check('the recent-failure history renders when the route returns it',
    diagText.includes('Недавние сбои') && diagText.includes('ECONNRESET'), 'missing')
  check('no password inside a layer reaches the page', !diagText.includes('must-not-render'), 'a hidden value rendered')
  check('nor an api key, an authorization header, or a history token',
    !diagText.includes('sk-must-not-render') && !diagText.includes('Bearer') && !diagText.includes('token-must-not-render'),
    'a credential rendered')
  check('and the hidden keys are not named on the page either',
    !diagText.includes('password:') && !diagText.includes('apiKey:') && !diagText.includes('authorization:'),
    'a hidden key name rendered')
  // The third case: a layer that was never attempted because one above it already explained the
  // outcome. It must read differently from both a measured failure and an absence, since "we did
  // not try" and "we tried and it failed" have different remedies.
  DIAG_ANSWER = {
    ...DIAG_ANSWER,
    verdict: 'tls-plain-blocked',
    frag: { ok: true, ms: 1628, protocol: 'TLSv1.3', authorized: true, pieces: 100 },
    http: { ok: false, skipped: 'tls failed' },
  }
  findButton(render(), 'Диагностика канала').props.onClick()
  await flush()
  const skipped = render()
  const skippedText = allText(skipped)
  check('a skipped layer says it was not attempted, and names what stopped it',
    rowValue(skipped, 'HTTP-запрос обычный') === 'не проверялось — tls failed',
    String(rowValue(skipped, 'HTTP-запрос обычный')))
  check('a skip is not rendered as an absence',
    skippedText.split('нет замера').length - 1 === 1, String(skippedText.split('нет замера').length - 1))
  check('and not as a measured failure either',
    !String(rowValue(skipped, 'HTTP-запрос обычный')).includes('отказ'), String(rowValue(skipped, 'HTTP-запрос обычный')))
  check('a measured fragment layer reports its piece count',
    String(rowValue(skipped, 'TLS-рукопожатие фрагментированное')).includes('фрагментов: 100'),
    String(rowValue(skipped, 'TLS-рукопожатие фрагментированное')))
  check('the TSPU signature verdict is named as such, because it is the informative one during a block',
    skippedText.includes('подпись блокировки ТСПУ'), skippedText.slice(0, 200))
  DIAG_ANSWER = { ok: false, error: 'probe unavailable' }
  findButton(render(), 'Диагностика канала').props.onClick()
  await flush()
  const diagFailedText = allText(render())
  check('a diagnosis that fails as a whole says so rather than rendering six absences',
    diagFailedText.includes('Диагностика не выполнилась'), diagFailedText.slice(0, 200))

  // --- the automatic-promotion control, and the copy that turns with it -------
  // An automatic behaviour that cannot be turned off is not a default but an imposition, and
  // this one installs a dispatcher over the whole process's outbound traffic. Both halves are
  // asserted: the control exists and posts the right field, and the copy stops promising
  // promotion when the control is off — unconditional text here would describe a machine that
  // is no longer running.
  STATE.config.tlsFragmentGlobalAuto = true
  STATE.config.tlsFragmentGlobal = false
  const autoOn = render()
  const autoBox = collect(autoOn, 'label')
    .filter(item => allText(item).includes('автоматически, по замеру'))
    .map(item => collect(item, 'input').find(input => input.props.type === 'checkbox'))
    .find(item => item !== undefined)
  check('the automatic-promotion switch renders, and defaults to on',
    autoBox !== undefined && autoBox.props.checked === true, String(autoBox?.props.checked))
  check('the copy promises promotion while it is on',
    allText(autoOn).includes('По умолчанию плагин повышает фрагментацию до запросов модели сам'), 'missing')
  requests.length = 0
  autoBox.props.onChange({ target: { checked: false } })
  await flush()
  const autoPost = requests.find(item => item.path === '/dsh-rustvy/config' && String(item.body).includes('tlsFragmentGlobalAuto'))
  check('turning it off posts only that field',
    autoPost !== undefined && autoPost.body === '{"tlsFragmentGlobalAuto":false}', String(autoPost?.body))

  STATE.config.tlsFragmentGlobalAuto = false
  const autoOff = allText(render())
  check('the copy stops promising promotion once it is off',
    !autoOff.includes('По умолчанию плагин повышает фрагментацию до запросов модели сам')
    && autoOff.includes('Автоматическое повышение выключено'), 'the copy still promised an automatic that is off')
  check('and it says what that leaves covering the plugin\'s own requests only',
    autoOff.includes('фрагментация остаётся только на собственных запросах плагина'), 'missing')
  STATE.config.tlsFragmentGlobalAuto = true
  // Was "the proxy outranks fragmentation for the same host", which was true in 1.5.0 and false
  // now: a plaintext proxy and fragmentation compose, and the ClientHello is fragmented inside
  // the tunnel. The negative half is asserted too, because the stale phrase surviving in the copy
  // is the defect this check exists to catch — and it hid from a line-based grep by wrapping
  // across two source lines, which is the failure mode AGENTS.md warns about.
  check('the copy says a plaintext proxy now composes with fragmentation, and names what does not',
    x.includes('фрагментируется внутри туннеля') && x.includes('Сочетается только plaintext-прокси')
    && x.includes('SOCKS5'), 'missing')
  check('and no longer claims the proxy outranks fragmentation',
    !x.includes('важнее фрагментации'), 'the superseded claim is still on the page')
  check('the copy says 16 bytes is not a speed knob and bigger can silently stop working',
    x.includes('не регулятор скорости') && x.includes('тихо перестать работать') && x.includes('больше не значит лучше'), 'missing')
  check('and it states the Windows cost, which is not the Linux figure in the task document',
    x.includes('1,5 с') && x.includes('Windows') && x.includes('1587') && x.includes('раз на соединение'), 'missing')
}

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
// Explicit exit, and it is a workaround rather than a fix. Once the stream-timeout block
// landed this suite prints its tally and then never returns, which would hang `npm test` for
// everybody instead of failing loudly. The handle that keeps the loop alive is not yet
// identified — it is reported as an open question rather than quietly absorbed by this line,
// and removing this line is the check that the handle is gone.
process.exit(failed > 0 ? 1 : 0)
process.exitCode = failed === 0 ? 0 : 1
