/**
 * dsh-rustvy — the API-key ring.
 *
 * Pure helpers for the feature that lets one profile hold several provider keys
 * and one chat use one of them: labels, credential-reference names, the route
 * names those references imply, the two documents the feature persists, and the
 * provider-map arithmetic that keeps a key's route a clone of the route the
 * profile already declares.
 *
 * Why a route per key: `@deepseek-ai/dsh-llm-pi-ai` resolves its credential from
 * `profile.apiKeyEnv` — a *name*, read through the harness credentials service on
 * every request — and neither `LlmCallConfig` nor `GenerateOptions` carries a
 * credential, so there is no per-request key to hand it. One route is therefore
 * one key, and "this chat sends requests with that key" is "this chat's request
 * names that route". The host half performs that swap on the `agent/request`
 * waterfall, which is the same seam the harness itself uses to apply a per-chat
 * model choice.
 *
 * This module deliberately holds no secret: a key *value* is written to the
 * harness credentials store (`$DSH_HOME/.credentials.yaml`, `refs`) and read back
 * from it, and what is persisted here is the ring's metadata — which reference
 * name belongs to which label and which route. Nothing in this file touches the
 * network, the filesystem or Cordis, so the arithmetic is testable on its own.
 *
 * @module dsh-rustvy/keys
 */

import { createHash } from 'node:crypto'

/** Shape of the ring document this module reads and writes. */
const DOCUMENT_VERSION = 1

/** A key value the adapter will accept: printable ASCII, no spaces. */
const KEY_VALUE = /^[\x21-\x7E]+$/u

/** A credential reference name, as the credentials service brands it. */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** A provider route key, as the adapter's config dictionary accepts it. */
const ROUTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** How long a label may be before it is cut. */
const LABEL_MAX = 48

/** How many keys one profile may hold; a ring, not a registry. */
export const MAX_KEYS = 12

/** The route suffix a key's clone is named with. */
const ROUTE_SUFFIX = '-k'

/**
 * Validate one pasted key value.
 *
 * The adapter trims a key and refuses anything empty or outside printable ASCII
 * with `INVALID_CREDENTIALIAL`, so a value that would fail there is refused here
 * with a sentence a person can act on instead of a failed request later.
 *
 * @param value - the pasted secret.
 * @returns `{ ok: true, value }` with the trimmed value, or `{ ok: false, error }`.
 */
export function checkKeyValue(value) {
  if (typeof value !== 'string') return { ok: false, error: 'ключ не передан' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, error: 'пустой ключ — вставьте значение или отмените добавление' }
  if (trimmed.length > 512) return { ok: false, error: 'ключ длиннее 512 символов — это не похоже на ключ провайдера' }
  if (!KEY_VALUE.test(trimmed)) {
    return { ok: false, error: 'в ключе есть пробел или символ вне печатного ASCII — маршрут такой не примет' }
  }
  return { ok: true, value: trimmed }
}

/**
 * The short form a key is shown as: enough to recognise it, never enough to use
 * it. A key that is too short to split is masked whole.
 *
 * @param value - the secret.
 * @returns the masked text.
 */
export function maskKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return '…'
  return `${value.slice(0, 3)}…${value.slice(-2)}`
}

/**
 * A stable, non-reversible handle for a key value.
 *
 * Two entries with the same fingerprint hold the same secret, which is how the
 * ring refuses to add a key twice without ever comparing secrets in the clear and
 * without storing one.
 *
 * @param value - the secret.
 * @returns eight hex characters.
 */
export function keyFingerprint(value) {
  if (typeof value !== 'string' || value === '') return ''
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/**
 * The label a key is shown under.
 *
 * @param value - what the user typed, if anything.
 * @param fallback - the label to use when they typed nothing.
 * @returns a label of at most {@link LABEL_MAX} characters.
 */
export function normalizeLabel(value, fallback) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (text === '') return fallback
  return text.length > LABEL_MAX ? text.slice(0, LABEL_MAX) : text
}

/**
 * The credential reference name of the n-th key.
 *
 * The first key keeps the reference the route already names, so a profile that
 * works today keeps working and the harness Models page keeps showing the same
 * credential. Every key after it is that name with its ordinal appended, which
 * stays inside the reference grammar and reads as belonging to the same route.
 *
 * @param baseRef - the route's own `apiKeyEnv`.
 * @param ordinal - 1 for the primary key.
 * @returns the reference name.
 */
export function refFor(baseRef, ordinal) {
  const base = typeof baseRef === 'string' && baseRef.trim() !== '' ? baseRef.trim() : 'RUSTVY_API_KEY'
  if (ordinal <= 1) return base
  return `${base}_${ordinal}`
}

/**
 * The provider route a key's clone is written under.
 *
 * @param baseRoute - the route the profile declares.
 * @param ordinal - 1 for the primary key, which keeps the base route.
 * @returns the route key.
 */
export function routeFor(baseRoute, ordinal) {
  const base = typeof baseRoute === 'string' && baseRoute.trim() !== '' ? baseRoute.trim() : 'rustvy'
  if (ordinal <= 1) return base
  return `${base}${ROUTE_SUFFIX}${ordinal}`
}

/**
 * The display name a key's route carries.
 *
 * It is what the model picker would show for the clone, and what the browser
 * half hides by: a group whose header reads like this is a key, not a provider,
 * and the same model list under it would only repeat the one above.
 *
 * @param baseName - the base route's `displayName`.
 * @param ordinal - the key's ordinal.
 * @param label - the key's own label, when it has one.
 * @returns the display name.
 */
export function displayNameFor(baseName, ordinal, label) {
  const base = typeof baseName === 'string' && baseName.trim() !== '' ? baseName.trim() : 'rustvy'
  if (ordinal <= 1) return base
  const suffix = typeof label === 'string' && label.trim() !== '' ? label.trim() : `ключ ${ordinal}`
  return `${base} · ${suffix}`
}

/**
 * An empty, valid ring document.
 * @returns the document.
 */
export function emptyRing() {
  return { version: DOCUMENT_VERSION, nextOrdinal: 1, keys: [], defaultKeyId: null }
}

/**
 * Read a persisted ring document, tolerating absence, corruption and documents
 * written by an older copy of this plugin.
 *
 * Anything unusable is dropped rather than repaired silently: a ring that cannot
 * be read is an empty ring, and the primary key is re-derived from the route on
 * the next pass, so a damaged file costs a label and never a key.
 *
 * @param raw - the parsed JSON, or `undefined`.
 * @returns a normalized document.
 */
export function readRing(raw) {
  const ring = emptyRing()
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.keys)) return ring
  let ordinal = 1
  for (const candidate of raw.keys) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const ref = typeof candidate.ref === 'string' && REF_NAME.test(candidate.ref) ? candidate.ref : ''
    const route = typeof candidate.route === 'string' && ROUTE_NAME.test(candidate.route) ? candidate.route : ''
    if (id === '' || ref === '' || route === '') continue
    const entry = {
      id,
      label: normalizeLabel(candidate.label, id),
      ref,
      route,
      primary: candidate.primary === true,
      ordinal: Number.isFinite(candidate.ordinal) ? Math.max(1, Math.round(candidate.ordinal)) : ordinal,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : null,
    }
    ordinal = Math.max(ordinal, entry.ordinal) + 1
    ring.keys.push(entry)
  }
  // Exactly one primary, and it is the first key: the primary is the route the
  // profile itself names, which is not a choice the document gets to move.
  const primaries = ring.keys.filter(key => key.primary)
  if (ring.keys.length > 0) {
    if (primaries.length === 0) ring.keys[0].primary = true
    else for (const key of primaries.slice(1)) key.primary = false
  }
  ring.nextOrdinal = Number.isFinite(raw.nextOrdinal)
    ? Math.max(ordinal, Math.round(raw.nextOrdinal))
    : ordinal
  ring.defaultKeyId = typeof raw.defaultKeyId === 'string' && ring.keys.some(key => key.id === raw.defaultKeyId)
    ? raw.defaultKeyId
    : (ring.keys.find(key => key.primary)?.id ?? ring.keys[0]?.id ?? null)
  return ring
}

/**
 * Serialize a ring for disk.
 * @param ring - the document.
 * @returns the JSON text, with a trailing newline.
 */
export function writeRing(ring) {
  return `${JSON.stringify({
    version: DOCUMENT_VERSION,
    nextOrdinal: ring.nextOrdinal,
    defaultKeyId: ring.defaultKeyId,
    keys: ring.keys.map(key => ({
      id: key.id,
      label: key.label,
      ref: key.ref,
      route: key.route,
      primary: key.primary === true,
      ordinal: key.ordinal,
      createdAt: key.createdAt,
    })),
  }, null, 2)}\n`
}

/**
 * The ring as the installed route describes it, with one primary key.
 *
 * This is the migration path: a profile that has been running on a single
 * `apiKeyEnv` gets a ring whose first key *is* that reference, so nothing moves
 * and the first key added becomes the second.
 *
 * @param ring - the document read from disk.
 * @param provider - the installed base provider profile.
 * @param baseRoute - the base route key.
 * @returns the ring, with its primary key present.
 */
export function withPrimaryKey(ring, provider, baseRoute) {
  const route = typeof baseRoute === 'string' && baseRoute !== '' ? baseRoute : 'rustvy'
  const ref = typeof provider?.apiKeyEnv === 'string' && provider.apiKeyEnv.trim() !== ''
    ? provider.apiKeyEnv.trim()
    : 'RUSTVY_API_KEY'
  const existing = ring.keys.find(key => key.primary)
  if (existing !== undefined) {
    // The route's own reference wins over a stored one: the profile is what the
    // adapter reads, and a ring that disagrees with it would send the wrong key.
    existing.ref = ref
    existing.route = route
    return ring
  }
  const primary = {
    id: 'k1',
    label: normalizeLabel(provider?.displayName, 'Основной'),
    ref,
    route,
    primary: true,
    ordinal: 1,
    createdAt: new Date().toISOString(),
  }
  ring.keys = [primary, ...ring.keys.filter(key => key.id !== primary.id)]
  ring.nextOrdinal = Math.max(ring.nextOrdinal, 2)
  if (ring.defaultKeyId === null) ring.defaultKeyId = primary.id
  return ring
}

/**
 * A fresh key entry for the ring.
 *
 * @param ring - the document to take the next ordinal from; it is advanced.
 * @param options - `{ baseRef, baseRoute, baseDisplayName, label, ordinal }`;
 *   `ordinal` overrides the document's counter, which is how the host skips an
 *   ordinal whose route or reference is still installed.
 * @returns the entry, not yet inserted.
 */
export function newKeyEntry(ring, options) {
  const ordinal = Number.isFinite(options.ordinal) ? Math.max(2, Math.round(options.ordinal)) : ring.nextOrdinal
  ring.nextOrdinal = Math.max(ring.nextOrdinal, ordinal + 1)
  return {
    id: `k${ordinal}`,
    label: normalizeLabel(options.label, `Ключ ${ordinal}`),
    ref: refFor(options.baseRef, ordinal),
    route: routeFor(options.baseRoute, ordinal),
    primary: false,
    ordinal,
    createdAt: new Date().toISOString(),
  }
}

/**
 * The provider profile a key's route carries.
 *
 * A clone of the base profile — same protocol, same endpoint, same model list,
 * same hand-written compatibility switches — with the two fields that make it a
 * different key. Everything else is the profile author's knowledge about their
 * gateway, and a key is not a reason to lose it.
 *
 * @param baseProvider - the installed base profile.
 * @param key - the ring entry.
 * @param baseRoute - the base route key, for the display name.
 * @returns the profile to write under `key.route`.
 */
export function keyProviderProfile(baseProvider, key, baseRoute) {
  const base = typeof baseProvider === 'object' && baseProvider !== null ? baseProvider : {}
  const displayName = displayNameFor(base.displayName ?? baseRoute, key.ordinal, key.primary ? null : key.label)
  return { ...structuredClone(base), apiKeyEnv: key.ref, displayName }
}

/**
 * Whether one installed provider route belongs to this ring.
 *
 * Two rules, because a route has to stay recognisable after the key it was
 * created for is gone: a profile whose `apiKeyEnv` is one of the ring's
 * references is ours, and so is a route named the way this ring names its clones
 * (`<base>-k<n>`). Anything else in `providers` — a second gateway, a DeepSeek
 * route, somebody's hand-written row — is a neighbour and is never touched.
 *
 * @param route - the installed route key.
 * @param provider - the installed profile under it.
 * @param baseRoute - the base route key, which is never a clone.
 * @param refs - the ring's reference names.
 * @returns true when this ring owns the route.
 */
export function isRingRoute(route, provider, baseRoute, refs) {
  if (route === baseRoute) return false
  if (typeof provider?.apiKeyEnv === 'string' && refs.has(provider.apiKeyEnv)) return true
  if (typeof baseRoute !== 'string' || baseRoute === '') return false
  const escaped = baseRoute.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^${escaped}${ROUTE_SUFFIX}\\d+$`, 'u').test(route)
}

/**
 * Reconcile a `providers` map with the ring.
 *
 * Every non-primary key gets a route cloned from the base one, a route whose key
 * disappeared from the ring is removed, and a clone that has drifted from the
 * base — because the model list was regenerated, or the endpoint moved — is
 * brought back in step. The base route itself is never rewritten here: it is the
 * profile author's row.
 *
 * @param providers - the installed map.
 * @param ring - the ring document.
 * @param baseRoute - the base route key.
 * @returns `{ providers, added, removed, updated, changed }` with a new map.
 */
export function syncRingRoutes(providers, ring, baseRoute) {
  const source = typeof providers === 'object' && providers !== null ? providers : {}
  const base = source[baseRoute]
  const next = { ...source }
  const added = []
  const removed = []
  const updated = []
  if (typeof base !== 'object' || base === null) {
    return { providers: next, added, removed, updated, changed: false, error: `в профиле нет маршрута «${baseRoute}» — клонировать нечего` }
  }
  const wanted = new Map()
  for (const key of ring.keys) {
    if (key.primary) continue
    wanted.set(key.route, key)
  }
  const refs = new Set(ring.keys.map(key => key.ref))
  for (const [route, profile] of Object.entries(next)) {
    if (wanted.has(route)) continue
    // Only ever remove a route this ring recognises as its own clone; a foreign
    // row that happens to sit next to it is not ours to delete.
    if (isRingRoute(route, profile, baseRoute, refs)) removed.push(route)
  }
  for (const route of removed) delete next[route]
  for (const [route, key] of wanted) {
    const profile = keyProviderProfile(base, key, baseRoute)
    const existing = next[route]
    if (existing === undefined) {
      next[route] = profile
      added.push(route)
      continue
    }
    if (JSON.stringify(existing) !== JSON.stringify(profile)) {
      next[route] = profile
      updated.push(route)
    }
  }
  return { providers: next, added, removed, updated, changed: added.length > 0 || removed.length > 0 || updated.length > 0 }
}

/**
 * The routes whose models a regeneration has to write.
 *
 * The base route and every clone this ring already sees in the profile: a clone
 * that is missing is the reconciliation's job, not the model list's, and
 * inventing one here would write a route the ring has not been asked for.
 *
 * @param providers - the installed map.
 * @param ring - the ring document.
 * @param baseRoute - the base route key.
 * @returns the route keys, base first.
 */
export function routesToSync(providers, ring, baseRoute) {
  const source = typeof providers === 'object' && providers !== null ? providers : {}
  const routes = [baseRoute]
  for (const key of ring.keys) {
    if (key.primary) continue
    if (source[key.route] !== undefined) routes.push(key.route)
  }
  return routes
}

/**
 * Read persisted per-chat picks.
 *
 * @param raw - the parsed JSON, or `undefined`.
 * @param ring - the ring, so a pick naming a removed key is dropped.
 * @returns a `sessionId → keyId` map.
 */
export function readPicks(raw, ring) {
  const picks = new Map()
  const known = new Set(ring.keys.map(key => key.id))
  const source = typeof raw?.picks === 'object' && raw.picks !== null ? raw.picks : {}
  for (const [sessionId, keyId] of Object.entries(source)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof keyId !== 'string' || !known.has(keyId)) continue
    picks.set(sessionId, keyId)
  }
  return picks
}

/**
 * Serialize per-chat picks.
 * @param picks - a `sessionId → keyId` map.
 * @returns the JSON text, with a trailing newline.
 */
export function writePicks(picks) {
  return `${JSON.stringify({
    version: 1,
    picks: Object.fromEntries(picks),
  }, null, 2)}\n`
}

/**
 * How many chats named each key.
 *
 * @param picks - a `sessionId → keyId` map.
 * @returns a `keyId → count` map.
 */
export function pickCounts(picks) {
  const counts = new Map()
  for (const keyId of picks.values()) counts.set(keyId, (counts.get(keyId) ?? 0) + 1)
  return counts
}

/** One key as the browser half draws it: identity and status, never a value. */
export function describeKey(key, options = {}) {
  return {
    id: key.id,
    label: key.label,
    ref: key.ref,
    route: key.route,
    primary: key.primary === true,
    ordinal: key.ordinal,
    createdAt: key.createdAt ?? null,
    present: options.present === true,
    masked: typeof options.value === 'string' ? maskKey(options.value) : '',
    fingerprint: typeof options.value === 'string' ? keyFingerprint(options.value) : '',
    sessions: Number.isFinite(options.sessions) ? options.sessions : 0,
    installed: options.installed === true,
    models: Number.isFinite(options.models) ? options.models : 0,
    ...options.displayName === undefined ? {} : { displayName: options.displayName },
  }
}
