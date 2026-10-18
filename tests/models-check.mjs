// Validate models.js against the live origin and the profile's installed route.
import { normalizeServedList, mirrorRecord, buildModelEntries, diffModels, servedFromCatalog }
  from '../lib/models.js'

const ORIGIN = 'https://rustvy.xyz'

// The `models` list currently installed in the profile's llm-pi-ai rustvy route,
// transcribed from cordis.patch.yml so the diff is against the real thing.
const installed = [
  { id: 'claude-fable-5-1', name: 'claude-fable-5-1', maxTokens: 128000 },
  { id: 'claude-fable-5', name: 'claude-fable-5', maxTokens: 128000 },
  { id: 'claude-opus-5-5', name: 'claude-opus-5-5', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { id: 'claude-opus-5', name: 'claude-opus-5', maxTokens: 128000 },
  { id: 'gpt-6-astra', name: 'gpt-6-astra', maxTokens: 128000 },
  { id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', maxTokens: 128000 },
  { id: 'gpt-6-luna', name: 'gpt-6-luna', maxTokens: 128000 },
  { id: 'glm-5.3', name: 'glm-5.3', maxTokens: 8192 },
  { id: 'glm-5.3-flash', name: 'glm-5.3-flash', maxTokens: 128000 },
  { id: 'kimi-k3', name: 'kimi-k3', maxTokens: 128000 },
  { id: 'qwen3.8-max', name: 'qwen3.8-max', maxTokens: 128000 },
  { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', maxTokens: 128000 },
  { id: 'fable-ultra-promax', name: 'fable-ultra-promax', maxTokens: 128000 },
]

const served = normalizeServedList(await (await fetch(`${ORIGIN}/v1/models`, { headers: { accept: 'application/json' } })).json())
const html = await (await fetch(`${ORIGIN}/models`, { headers: { accept: 'text/html' } })).text()
const island = JSON.parse(/<script[^>]*\bid=["']?rustvy-catalog["']?[^>]*>([\s\S]*?)<\/script>/iu.exec(html)[1])
const records = island.records.map(mirrorRecord).filter(Boolean)

console.log(`served by /v1/models: ${served.length}`)
console.log(`island records: ${records.length}; version ${island.version}`)
console.log(`island fallback would serve: ${servedFromCatalog(records).length}`)
console.log(`  ids: ${servedFromCatalog(records).map(m => m.id).join(', ')}`)
console.log(`wire ids:     ${served.map(m => m.id).join(', ')}`)
const same = JSON.stringify(servedFromCatalog(records).map(m => m.id)) === JSON.stringify(served.map(m => m.id))
console.log(`fallback agrees with wire: ${same}`)

const built = buildModelEntries(served, records, installed, { nameSource: 'displayName', offerOff: true })
console.log(`\ngenerated ${built.entries.length} entries; notes: ${built.notes.length}`)
for (const note of built.notes) console.log(`  note: ${note}`)
console.log('\n--- generated (ahmia-v7-pro + claude-opus-5-5 + glm-5.3 + gpt-6.1-sol) ---')
for (const id of ['ahmia-v7-pro', 'claude-opus-5-5', 'glm-5.3', 'gpt-6.1-sol', 'deepseek-v4.1-flash-1017']) {
  console.log(JSON.stringify(built.entries.find(e => e.id === id), null, 1))
}

const diff = diffModels(installed, built.entries)
console.log('\n--- drift vs installed ---')
console.log(`upToDate: ${diff.upToDate}`)
console.log(`added   : ${diff.added.join(', ') || '—'}`)
console.log(`removed : ${diff.removed.join(', ') || '—'}`)
console.log(`changed : ${diff.changed.length}`)
for (const change of diff.changed) {
  console.log(`  ${change.id}`)
  for (const f of change.fields) console.log(`     ${f.field}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`)
}

// Schema sanity: only fields the pi-ai modelProfile declares, with legal values.
const ALLOWED = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const MODS = new Set(['text', 'image'])
const problems = []
for (const entry of built.entries) {
  for (const key of Object.keys(entry)) if (!ALLOWED.has(key)) problems.push(`${entry.id}: unknown field ${key}`)
  if (typeof entry.id !== 'string' || entry.id === '') problems.push(`${entry.id}: bad id`)
  if (typeof entry.name !== 'string' || entry.name === '') problems.push(`${entry.id}: bad name`)
  if (entry.contextWindow !== undefined && (!Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0)) problems.push(`${entry.id}: bad contextWindow`)
  if (entry.maxTokens !== undefined && (!Number.isInteger(entry.maxTokens) || entry.maxTokens <= 0)) problems.push(`${entry.id}: bad maxTokens`)
  if (entry.input !== undefined) {
    if (!Array.isArray(entry.input) || entry.input.length === 0) problems.push(`${entry.id}: empty input`)
    for (const m of entry.input ?? []) if (!MODS.has(m)) problems.push(`${entry.id}: bad modality ${m}`)
  }
  const efforts = entry.reasoningEfforts
  if (efforts !== undefined && efforts !== false) {
    const keys = Object.keys(efforts)
    if (keys.length === 0) problems.push(`${entry.id}: empty reasoningEfforts`)
    if (!keys.some(level => level !== 'off')) problems.push(`${entry.id}: reasoningEfforts offers nothing beyond off`)
    for (const [level, wire] of Object.entries(efforts)) {
      if (!LEVELS.has(level)) problems.push(`${entry.id}: bad level ${level}`)
      if (wire === null && level !== 'off') problems.push(`${entry.id}: ${level} may not be null`)
      if (typeof wire === 'string' && wire.length === 0) problems.push(`${entry.id}: ${level} empty wire string`)
    }
  }
}
console.log(`\nschema problems: ${problems.length}`)
for (const p of problems) console.log(`  ${p}`)
