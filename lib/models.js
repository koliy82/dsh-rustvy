/**
 * dsh-rustvy — model-list generation.
 *
 * The mirror answers two questions about a provider: what marks its models wear
 * (the icon half, in `./host.js`), and what models it actually serves right now
 * (this half). This file owns the second one, and it is deliberately pure: no
 * network, no filesystem, no Cordis. It turns what an origin publishes into the
 * exact entry shape a `@deepseek-ai/dsh-llm-pi-ai` route profile accepts, and it
 * reports the difference against what a profile currently has installed.
 *
 * Why the shape is what it is — every field here is a field that adapter's
 * config schema declares, and nothing else. A route profile's `models` list
 * *replaces* the route's catalog rather than extending it, and the GUI offers a
 * model for selection only when the route serves it, so this list is what
 * decides which models a profile can pick. Unknown fields would be dropped by
 * the schema at best and refuse the whole write at worst, so an entry carries
 * only:
 *
 *   `id`               the id the wire expects in a request;
 *   `name`             the label the picker shows;
 *   `contextWindow`    positive integer, tokens;
 *   `maxTokens`        positive integer, output cap;
 *   `input`            subset of `text`/`image`;
 *   `reasoningEfforts` `false`, or a dict of thinking level → wire spelling;
 *   `compat`           wire-compatibility switches, which only a profile author
 *                      can know — so this file never invents one and always
 *                      carries an existing one forward.
 *
 * A field the origin does not speak about is *omitted*, not defaulted: omitting
 * leaves the adapter's own fallback in charge and keeps a profile author's
 * hand-written value intact, whereas writing a guessed number would silently
 * pin it.
 *
 * @module dsh-rustvy/models
 */

/** Every thinking level a route profile may declare, in escalation order. */
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Every request modality a route profile may declare. */
export const MODALITIES = Object.freeze(['text', 'image'])

/**
 * Spellings an origin may use for a thinking level, mapped onto the adapter's
 * vocabulary. Anything not named here is dropped and reported, because a level
 * the adapter does not know would refuse the whole profile.
 */
const LEVEL_ALIASES = Object.freeze({
  off: 'off',
  none: 'off',
  no_thinking: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  mid: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  x_high: 'xhigh',
  max: 'max',
  max_thinking: 'max',
})

/** The capacity and modality spellings seen in the wild, per concept. */
const OUTPUT_KEYS = Object.freeze(['max_output_tokens', 'maxOutputTokens', 'max_tokens', 'maxTokens'])
const NAME_KEYS = Object.freeze(['display_name', 'displayName', 'name', 'label', 'title'])
const MODALITY_KEYS = Object.freeze(['modalities', 'input', 'input_modalities', 'inputModalities'])
const REASONING_KEYS = Object.freeze(['reasoning_levels', 'reasoningLevels', 'reasoning_efforts', 'reasoningEfforts'])

/** A positive integer, or `undefined` — the only numbers the schema accepts. */
function positiveInteger(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/** The first present key's value out of a record. */
function firstOf(record, keys) {
  if (typeof record !== 'object' || record === null) return undefined
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]
  return undefined
}

/** A non-empty string, trimmed, or `undefined`. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read a thinking-level list into the adapter's vocabulary.
 *
 * `off` is special: a declared `off` carrying no wire value means "this level is
 * offered and dispatch sends nothing", which is the correct spelling where not
 * thinking is the absence of a parameter. Every other level needs the string the
 * wire expects, so it carries its own name unless the origin says otherwise.
 *
 * @param levels - the levels as the origin publishes them.
 * @param options - `{ offerOff }` adds an `off` level to a reasoning model that
 *   does not declare one, which is what a profile hand-written against this
 *   origin already does.
 * @returns `{ efforts, unknown }`, where `efforts` is `false` for a
 *   non-reasoning model, `undefined` when the origin said nothing, and a dict
 *   otherwise; `unknown` lists the level names that could not be mapped.
 */
export function reasoningEffortsOf(levels, options = {}) {
  if (levels === undefined || levels === null) return { efforts: undefined, unknown: [] }
  const list = Array.isArray(levels) ? levels : (typeof levels === 'object' ? Object.keys(levels) : [])
  if (list.length === 0) return { efforts: false, unknown: [] }
  const unknown = []
  const efforts = {}
  for (const raw of list) {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    const level = LEVEL_ALIASES[key]
    if (level === undefined) {
      if (key !== '') unknown.push(typeof raw === 'string' ? raw.trim() : String(raw))
      continue
    }
    // A level the origin spells with its own wire value keeps it; otherwise the
    // level name is the wire value, and `off` stays empty.
    const wire = typeof raw === 'object' && raw !== null ? text(firstOf(raw, ['wire', 'value', 'param'])) : undefined
    efforts[level] = level === 'off' ? (wire ?? null) : (wire ?? level)
  }
  const offersThinking = Object.keys(efforts).some(level => level !== 'off')
  if (!offersThinking) return { efforts: Object.keys(efforts).length === 0 ? false : efforts, unknown }
  if (options.offerOff === true && efforts.off === undefined) efforts.off = null
  // Escalation order, so the written YAML reads the same way every time and a
  // diff against the installed list is stable rather than reordered.
  const ordered = {}
  for (const level of THINKING_LEVELS) if (level in efforts) ordered[level] = efforts[level]
  return { efforts: ordered, unknown }
}

/**
 * Normalize one model as an origin's `/models` endpoint publishes it.
 *
 * Both shapes pi-ai's own discovery parser accepts are handled: the standard
 * `data` array, and an enriched map whose key is the request id even when the
 * entry names a different canonical id.
 *
 * @param candidate - one raw record.
 * @param mapId - the key this record was stored under, when it came from a map.
 * @returns the normalized model, or `undefined` when it carries no usable id.
 */
export function normalizeServedModel(candidate, mapId) {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const id = text(candidate.id) ?? text(mapId)
  if (id === undefined) return undefined
  const modalities = firstOf(candidate, MODALITY_KEYS)
  return {
    id,
    displayName: text(firstOf(candidate, NAME_KEYS)),
    vendor: text(candidate.vendor) ?? text(candidate.owned_by) ?? text(candidate.provider_label),
    icon: text(candidate.icon),
    contextWindow: contextWindowOf(candidate),
    maxTokens: positiveInteger(firstOf(candidate, OUTPUT_KEYS)),
    modalities: Array.isArray(modalities)
      ? [...new Set(modalities.map(value => (typeof value === 'string' ? value.trim().toLowerCase() : '')).filter(value => MODALITIES.includes(value)))]
      : undefined,
    reasoningLevels: firstOf(candidate, REASONING_KEYS),
    hot: candidate.hot === true,
    free: candidate.free === true,
    pricing: typeof candidate.pricing === 'object' && candidate.pricing !== null ? candidate.pricing : undefined,
  }
}

/**
 * The context window in tokens, from whichever spelling the record uses.
 * `context_k` counts thousands, so it is scaled; the rest are already tokens.
 *
 * @param record - one raw served model.
 * @returns a positive integer, or `undefined`.
 */
function contextWindowOf(record) {
  const k = positiveInteger(record.context_k) ?? positiveInteger(record.contextK)
  if (k !== undefined) return k * 1000
  return positiveInteger(record.context_window)
    ?? positiveInteger(record.contextWindow)
    ?? positiveInteger(record.context_length)
}

/**
 * Normalize a whole `/models` answer.
 *
 * @param payload - the parsed JSON body.
 * @returns the served models, in the order the origin gave them.
 */
export function normalizeServedList(payload) {
  if (typeof payload !== 'object' || payload === null) return []
  if (Array.isArray(payload.data)) {
    return payload.data.map(item => normalizeServedModel(item)).filter(item => item !== undefined)
  }
  if (Array.isArray(payload.models)) {
    return payload.models.map(item => normalizeServedModel(item)).filter(item => item !== undefined)
  }
  if (typeof payload.models === 'object' && payload.models !== null) {
    return Object.entries(payload.models)
      .map(([key, value]) => normalizeServedModel(
        typeof value === 'object' && value !== null ? value : { id: key },
        key,
      ))
      .filter(item => item !== undefined)
  }
  if (Array.isArray(payload)) return payload.map(item => normalizeServedModel(item)).filter(item => item !== undefined)
  return []
}

/**
 * Normalize one record of the site's embedded catalog island.
 *
 * The island is the richer of the two sources — it is the only one that carries
 * a display name, a vendor and a logo file name — but it also lists models the
 * route cannot serve, so a caller decides membership and this only shapes one
 * record.
 *
 * @param record - the record as the site publishes it.
 * @returns the mirrored record, or `undefined` when it is unusable.
 */
export function mirrorRecord(record) {
  if (typeof record !== 'object' || record === null) return undefined
  const id = text(record.id)
  if (id === undefined) return undefined
  const modalities = Array.isArray(record.modalities)
    ? [...new Set(record.modalities.map(value => (typeof value === 'string' ? value.trim().toLowerCase() : '')).filter(value => MODALITIES.includes(value)))]
    : []
  const levels = Array.isArray(record.reasoningLevels)
    ? record.reasoningLevels.filter(value => typeof value === 'string')
    : []
  return {
    id,
    displayName: text(record.displayName) ?? id,
    vendor: text(record.vendor) ?? '',
    vendorLabel: text(record.vendorLabel) ?? '',
    icon: text(record.icon) ?? '',
    provider: text(record.provider) ?? '',
    zone: text(record.zone) ?? '',
    contextK: positiveInteger(record.contextK),
    contextWindow: contextWindowOf(record),
    maxOutputTokens: positiveInteger(record.maxOutputTokens),
    modalities,
    reasoningLevels: levels,
    inputPer1M: typeof record.inputPer1M === 'number' ? record.inputPer1M : null,
    outputPer1M: typeof record.outputPer1M === 'number' ? record.outputPer1M : null,
    hot: record.hot === true,
    free: record.free === true,
    enabled: record.enabled !== false,
    sortOrder: Number.isFinite(record.sortOrder) ? record.sortOrder : 0,
  }
}

/**
 * Read an island record as a served model.
 *
 * This is the fallback path: when the origin's `/models` endpoint does not
 * answer, the island's own `enabled` and `zone` fields decide membership instead
 * of the wire. The two agree on a healthy origin — the endpoint serves exactly
 * the enabled standard-zone records — so the fallback keeps a route current
 * rather than leaving it frozen at its last successful read.
 *
 * @param record - one mirrored island record, as `mirrorRecord` shaped it.
 * @returns the served-model view `toModelEntry` reads.
 */
export function servedFromCatalogRecord(record) {
  return {
    id: record.id,
    displayName: record.displayName,
    vendor: record.vendor,
    icon: record.icon,
    contextWindow: record.contextWindow,
    maxTokens: record.maxOutputTokens,
    modalities: record.modalities,
    reasoningLevels: record.reasoningLevels,
    hot: record.hot,
    free: record.free,
  }
}

/**
 * The island records a route may serve.
 *
 * @param records - the mirrored catalog.
 * @param options - `{ zones }`, the zones to admit; defaults to `['standard']`.
 *   The uncensored zone shares the route's endpoint but is published disabled by
 *   default, so it is opt-in.
 * @returns the served-model views, in the island's own sort order.
 */
export function servedFromCatalog(records, options = {}) {
  const zones = Array.isArray(options.zones) && options.zones.length > 0 ? options.zones : ['standard']
  return (records ?? [])
    .filter(record => record.enabled !== false && zones.includes(record.zone === '' ? 'standard' : record.zone))
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(servedFromCatalogRecord)
}

/**
 * Build one route-profile model entry.
 *
 * The served list decides membership; the island catalog supplies the label; the
 * installed entry supplies anything the origin cannot know. Every field falls
 * through in that order and is omitted when nobody speaks for it.
 *
 * @param served - one normalized served model.
 * @param catalogRecord - the island record of the same id, when the mirror has one.
 * @param installed - the entry currently in the route profile, when there is one.
 * @param options - `{ nameSource }`, `'displayName'` or `'id'`.
 * @returns `{ entry, notes }`, where `notes` collects what could not be mapped.
 */
export function toModelEntry(served, catalogRecord, installed, options = {}) {
  const notes = []
  const name = options.nameSource === 'id'
    ? served.id
    : (served.displayName ?? catalogRecord?.displayName ?? installed?.name ?? served.id)
  const contextWindow = served.contextWindow ?? catalogRecord?.contextWindow ?? positiveInteger(installed?.contextWindow)
  const maxTokens = served.maxTokens ?? catalogRecord?.maxOutputTokens ?? positiveInteger(installed?.maxTokens)
  const modalities = served.modalities !== undefined && served.modalities.length > 0
    ? served.modalities
    : (catalogRecord?.modalities?.length > 0 ? catalogRecord.modalities : undefined)
  const levels = served.reasoningLevels ?? (catalogRecord?.reasoningLevels?.length > 0 ? catalogRecord.reasoningLevels : undefined)
  const { efforts, unknown } = reasoningEffortsOf(levels, { offerOff: options.offerOff !== false })
  for (const level of unknown) notes.push(`уровень рассуждения «${level}» не известен адаптеру и пропущен`)

  const entry = { id: served.id, name }
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  else if (installed?.contextWindow === undefined) notes.push('окно контекста не опубликовано — останется запас адаптера')
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  else notes.push('лимит вывода не опубликован — останется запас адаптера')
  if (modalities !== undefined && modalities.length > 0) entry.input = modalities
  if (efforts !== undefined) entry.reasoningEfforts = efforts
  else if (installed?.reasoningEfforts !== undefined) entry.reasoningEfforts = installed.reasoningEfforts
  // Only a profile author knows a wire-compatibility switch, so an existing one
  // always survives a regeneration.
  if (installed?.compat !== undefined) entry.compat = installed.compat
  return { entry, notes }
}

/**
 * Build the whole `models` list for one route.
 *
 * @param served - the models the origin's endpoint says the route serves.
 * @param records - the mirrored island catalog, for labels and fallbacks.
 * @param installed - the route profile's current `models` list.
 * @param options - `{ nameSource, keepUnknown, offerOff }`. `keepUnknown`
 *   retains an installed model the origin no longer serves, which is what a
 *   profile wants when the origin's listing is momentarily wrong rather than
 *   genuinely retired.
 * @returns `{ entries, notes, kept }`.
 */
export function buildModelEntries(served, records, installed, options = {}) {
  const byId = new Map()
  for (const record of records ?? []) byId.set(record.id, record)
  const installedById = new Map()
  for (const entry of Array.isArray(installed) ? installed : []) {
    if (typeof entry === 'object' && entry !== null && typeof entry.id === 'string') installedById.set(entry.id, entry)
  }

  const entries = []
  const notes = []
  for (const model of served) {
    const { entry, notes: modelNotes } = toModelEntry(
      model,
      byId.get(model.id),
      installedById.get(model.id),
      { nameSource: options.nameSource, offerOff: options.offerOff },
    )
    entries.push(entry)
    for (const note of modelNotes) notes.push(`${model.id}: ${note}`)
  }

  const servedIds = new Set(entries.map(entry => entry.id))
  const kept = []
  if (options.keepUnknown === true) {
    for (const [id, entry] of installedById) {
      if (servedIds.has(id)) continue
      kept.push(id)
      entries.push(entry)
      notes.push(`${id}: оставлен, хотя источник его больше не отдаёт`)
    }
  }
  return { entries, notes, kept }
}

/** One field's difference, reduced to the values that actually moved. */
function fieldChanges(installed, generated) {
  const changes = []
  const keys = [...new Set([...Object.keys(installed ?? {}), ...Object.keys(generated ?? {})])].filter(key => key !== 'id')
  for (const key of keys.sort()) {
    const before = installed?.[key]
    const after = generated?.[key]
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue
    changes.push({ field: key, before: before ?? null, after: after ?? null })
  }
  return changes
}

/**
 * Compare a route's installed model list with the generated one.
 *
 * This is what the settings page shows before anything is written: a profile
 * author decides from the difference, not from a count.
 *
 * @param installed - the current `models` list.
 * @param generated - the list this file would write.
 * @returns `{ upToDate, added, removed, changed, installedIds, generatedIds }`.
 */
export function diffModels(installed, generated) {
  const installedList = Array.isArray(installed) ? installed.filter(entry => typeof entry === 'object' && entry !== null) : []
  const installedById = new Map(installedList.map(entry => [entry.id, entry]))
  const generatedById = new Map(generated.map(entry => [entry.id, entry]))
  const added = generated.filter(entry => !installedById.has(entry.id)).map(entry => entry.id)
  const removed = installedList.filter(entry => !generatedById.has(entry.id)).map(entry => entry.id)
  const changed = []
  for (const entry of generated) {
    const before = installedById.get(entry.id)
    if (before === undefined) continue
    const fields = fieldChanges(before, entry)
    if (fields.length > 0) changed.push({ id: entry.id, fields })
  }
  return {
    upToDate: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
    installedIds: installedList.map(entry => entry.id),
    generatedIds: generated.map(entry => entry.id),
  }
}

/* ------------------------------------------------------------------------- *
 * YAML
 *
 * The generated list is written through `ctx.configEditor`, which owns the
 * document, its comments and its atomic replace. This emitter exists for the
 * other path: a profile author who would rather paste the block into
 * `cordis.patch.yml` themselves, or diff it against what is there, or keep it in
 * a dotfiles repo. Handing them the exact text the machine would have written is
 * the difference between a fallback and a guess.
 * ------------------------------------------------------------------------- */

/** Strings YAML would read as something other than the text they are. */
const YAML_RESERVED = new Set([
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'null', 'Null', 'NULL', '~',
  'yes', 'Yes', 'YES', 'no', 'No', 'NO',
  'on', 'On', 'ON', 'off', 'Off', 'OFF', '',
])

/** A character that may not begin a plain YAML scalar. */
const YAML_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/u

/** A string that YAML would read back as a number, so it must be quoted. */
const YAML_NUMERIC = /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/u

/**
 * Render one scalar the way the profile's own patch file reads it: plain where
 * that is unambiguous, double-quoted where it is not.
 *
 * @param value - the scalar to render.
 * @returns one line of YAML.
 */
export function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  const safe = text === text.trim()
    && !YAML_RESERVED.has(text)
    && !YAML_NUMERIC.test(text)
    && !YAML_INDICATOR.test(text)
    && !/:\s|\s#|[\n\r\t]/u.test(text)
  if (safe) return text
  return `"${text.replace(/[\\"]/gu, character => `\\${character}`).replace(/\n/gu, '\\n').replace(/\r/gu, '\\r').replace(/\t/gu, '\\t')}"`
}

/** A plain object, as opposed to an array or a class instance worth flattening. */
function isMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render a value as block YAML lines, two spaces per level.
 *
 * @param value - the value to render.
 * @param depth - the indentation level to start at.
 * @returns the lines, already indented.
 */
export function yamlLines(value, depth = 0) {
  const pad = '  '.repeat(depth)
  if (Array.isArray(value)) {
    const lines = []
    for (const item of value) {
      if (isMap(item)) {
        const inner = yamlLines(item, depth + 1)
        lines.push(`${pad}- ${inner[0].slice((depth + 1) * 2)}`)
        lines.push(...inner.slice(1))
      } else {
        lines.push(`${pad}- ${yamlScalar(item)}`)
      }
    }
    return lines
  }
  if (isMap(value)) {
    const lines = []
    for (const [key, item] of Object.entries(value)) {
      if (isMap(item) || Array.isArray(item)) {
        const inner = yamlLines(item, depth + 1)
        if (inner.length === 0) {
          lines.push(`${pad}${key}: ${Array.isArray(item) ? '[]' : '{}'}`)
          continue
        }
        lines.push(`${pad}${key}:`)
        lines.push(...inner)
        continue
      }
      lines.push(`${pad}${key}: ${yamlScalar(item)}`)
    }
    return lines
  }
  return [`${pad}${yamlScalar(value)}`]
}

/**
 * The whole patch row a profile can paste into `cordis.patch.yml`.
 *
 * The provider's own connection fields are carried through untouched and the
 * generated `models` list replaces only itself, so the block is a drop-in for
 * the row already there rather than a partial edit somebody has to merge by
 * hand.
 *
 * @param options - `{ entryId, packageName, providerKey, provider, models }`.
 * @returns the row as YAML text, with a trailing newline.
 */
export function routePatchYaml(options) {
  const provider = { ...(options.provider ?? {}) }
  delete provider.models
  const row = {
    id: options.entryId,
    name: options.packageName,
    config: {
      providers: {
        [options.providerKey]: { ...provider, models: options.models ?? [] },
      },
    },
  }
  return `${yamlLines([row], 0).join('\n')}\n`
}
