// Validate `lib/models.js` against both halves the plugin reads: the served model list from
// `/v1/models`, and the `rustvy-catalog` island on the provider's `/models` page. The property
// under test is that the two sources AGREE, which is what lets the island stand in as a
// fallback when the endpoint does not answer.
//
// The default mode is closed over `tests/fixtures/models-check.json` and a local server. It
// used to fetch `https://rustvy.xyz` on every run, which made the suite's outcome a fact about
// the network rather than about the code: host-wiring saw it time out at 21.8 s and lead saw it
// pass forty minutes later with nothing in the repository changed between. That matters beyond
// tidiness, because `npm publish` runs `prepublishOnly`, so a suite that reddens for external
// reasons can block a release at an arbitrary moment.
//
// The live path survives as an explicitly opt-in mode, because it covers something a fixture
// cannot — that the real provider's two answers still parse, and still agree:
//
//     $env:DSH_RUSTVY_LIVE_MODELS_CHECK = '1'; node tests/models-check.mjs
//
// In live mode the fixture-specific assertions skip by name rather than passing vacuously.
//
// This file also used to have no assertions at all: it printed a comparison and exited 0
// whatever the answer was, so "fallback agrees with wire: false" was a line in a log rather
// than a failure. Every printed claim below is now asserted.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeServedList, mirrorRecord, buildModelEntries, diffModels, servedFromCatalog }
  from '../lib/models.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/models-check.json'), 'utf8'))
const LIVE = process.env.DSH_RUSTVY_LIVE_MODELS_CHECK === '1'

const results = []
function check(name, ok, detail = '') {
  const passed = ok === true
  results.push({ name, ok: passed, detail: String(detail) })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : `  — ${detail}`}`)
}
/** A fixture-only assertion, named as skipped in live mode rather than passing vacuously. */
function fixtureOnly(name, run) {
  if (LIVE) { console.log(`SKIP  ${name}  — live mode, this asserts the fixture`); return }
  run()
}

// The island, as the provider's page carries it: a JSON script tag the regex below lifts out.
const islandHtml = island => `<!doctype html><html><body><main>models</main>
<script id="rustvy-catalog" type="application/json">${JSON.stringify(island)}</script>
</body></html>`

/**
 * One origin, standing in for both halves. Which served list it answers with is a parameter,
 * so the same server can serve the agreeing half and the disagreeing one.
 * @param served - the ids `/v1/models` should return.
 * @param island - the island object `/models` should embed, or `null` to omit the script tag.
 */
async function startOrigin(served, island) {
  const hits = []
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    hits.push(url)
    if (url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: served.map(id => ({ id, object: 'model' })) }))
      return
    }
    if (url.startsWith('/models')) {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(island === null ? '<!doctype html><html><body>no island here</body></html>' : islandHtml(island))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('')
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    hits,
    // `fetch` keeps sockets alive, and `server.close()` alone waits for them. Tearing one down
    // while the process exits trips a libuv assertion on Windows — `!(handle->flags &
    // UV_HANDLE_CLOSING)` in `src/win/async.c` — which surfaces as exit code 0xC0000409 instead
    // of the 1 this suite is trying to report. A crash is still a failure, but it hides the
    // summary and reads as an infrastructure fault rather than as a red test.
    close: async () => {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Read both halves from one origin, exactly as the plugin does. */
async function readBoth(origin) {
  const served = normalizeServedList(
    await (await fetch(`${origin}/v1/models`, { headers: { accept: 'application/json' } })).json(),
  )
  const html = await (await fetch(`${origin}/models`, { headers: { accept: 'text/html' } })).text()
  const match = /<script[^>]*\bid=["']?rustvy-catalog["']?[^>]*>([\s\S]*?)<\/script>/iu.exec(html)
  if (match === null) return { served, island: null, records: [] }
  const island = JSON.parse(match[1])
  return { served, island, records: island.records.map(mirrorRecord).filter(Boolean) }
}

const ids = list => list.map(model => model.id)

/* --------------------------- the agreeing half --------------------------- */

// Held so it can be closed: an open server keeps the event loop alive, and a suite that
// finishes its assertions but never exits is indistinguishable from a hang.
const agreeingOrigin = LIVE ? null : await startOrigin(FIXTURE.served, FIXTURE.island)
const agreeing = await readBoth(LIVE ? 'https://rustvy.xyz' : agreeingOrigin.origin)
const fallback = servedFromCatalog(agreeing.records)

console.log(`served by /v1/models: ${agreeing.served.length}`)
console.log(`island records: ${agreeing.records.length}; version ${agreeing.island?.version}`)
console.log(`island fallback would serve: ${fallback.length}`)
console.log(`  ids: ${ids(fallback).join(', ')}`)
console.log(`wire ids:     ${ids(agreeing.served).join(', ')}`)

// The property the whole file exists for. Asserted on ids AND order, because a fallback that
// served the right models in a different order would reshuffle the user's picker.
check('the island fallback agrees with the wire, in ids and in order',
  JSON.stringify(ids(fallback)) === JSON.stringify(ids(agreeing.served)),
  JSON.stringify({ fallback: ids(fallback), wire: ids(agreeing.served) }))
check('and the agreement is not vacuous — both halves are non-empty',
  agreeing.served.length > 0 && fallback.length > 0,
  JSON.stringify({ wire: agreeing.served.length, fallback: fallback.length }))

fixtureOnly('the island version is the fixture one, so this really came from the file', () => {
  check('the island version is the fixture version', agreeing.island?.version === FIXTURE.island.version,
    String(agreeing.island?.version))
})

/* ------------------- why the two halves can agree at all ------------------- */
// Agreement is only meaningful if the fallback actually filters. These are the two filters, and
// each is a record the fixture holds deliberately: a disabled one and a zonal one, both absent
// from the wire, both absent from the fallback.

fixtureOnly('a disabled record is excluded from the fallback, so the halves can agree', () => {
  check('the disabled record is in the island', agreeing.records.some(r => r.id === 'retired-model'),
    JSON.stringify(ids(agreeing.records)))
  check('and it is not served by the fallback', !ids(fallback).includes('retired-model'),
    JSON.stringify(ids(fallback)))
  check('and it is not on the wire either', !ids(agreeing.served).includes('retired-model'),
    JSON.stringify(ids(agreeing.served)))
})

fixtureOnly('a zonal record is excluded from the fallback, which is a different filter', () => {
  check('the zonal record is in the island', agreeing.records.some(r => r.id === 'abyss/qwen3.8-max'),
    JSON.stringify(ids(agreeing.records)))
  check('and it is not served by the fallback', !ids(fallback).includes('abyss/qwen3.8-max'),
    JSON.stringify(ids(fallback)))
  check('a zonal id is not the same membership as its canonical twin',
    !ids(fallback).some(id => id.startsWith('abyss/')), JSON.stringify(ids(fallback)))
})

fixtureOnly('the phantom id never reaches the agreeing half', () => {
  check('no phantom model is served in agreeing mode',
    !ids(agreeing.served).includes('phantom-model') && !ids(fallback).includes('phantom-model'),
    JSON.stringify({ wire: ids(agreeing.served), fallback: ids(fallback) }))
})

/* --------------------- the disagreeing half, asserted --------------------- */
// The agreement check above is only worth anything if it can fail. This drives the same
// comparison against the fixture's disagreeing wire half and asserts that it does NOT agree —
// the shape the live provider produced on 2026-11-02, when it dropped five models in the
// morning and re-enabled them in the afternoon.

if (!LIVE) {
  const disagreeingOrigin = await startOrigin(FIXTURE.disagreeing.served, FIXTURE.island)
  const disagreeing = await readBoth(disagreeingOrigin.origin)
  const disagreeingFallback = servedFromCatalog(disagreeing.records)
  console.log(`\ndisagreeing wire ids: ${ids(disagreeing.served).join(', ')}`)
  check('the disagreeing half does NOT agree, so the agreement check can fail',
    JSON.stringify(ids(disagreeingFallback)) !== JSON.stringify(ids(disagreeing.served)),
    JSON.stringify({ fallback: ids(disagreeingFallback), wire: ids(disagreeing.served) }))
  check('and the disagreement is the dropped id, not an accident of ordering',
    !ids(disagreeing.served).includes('kimi-k3') && ids(disagreeingFallback).includes('kimi-k3'),
    JSON.stringify({ wire: ids(disagreeing.served), fallback: ids(disagreeingFallback) }))
  check('and the phantom id is what the wire added',
    ids(disagreeing.served).includes('phantom-model') && !ids(disagreeingFallback).includes('phantom-model'),
    JSON.stringify(ids(disagreeing.served)))
  await disagreeingOrigin.close()

  // A page with no island at all must be a loud absence, not an empty fallback that quietly
  // agrees with an empty wire. `readBoth` returns `island: null` and no records for it.
  const bareOrigin = await startOrigin([], null)
  const bare = await readBoth(bareOrigin.origin)
  check('a page with no island yields no island rather than an empty one that looks like agreement',
    bare.island === null && bare.records.length === 0,
    JSON.stringify({ island: bare.island, records: bare.records.length }))
  await bareOrigin.close()
}

/* ------------------------- generation and schema ------------------------- */

const built = buildModelEntries(agreeing.served, agreeing.records, FIXTURE.installed, {
  nameSource: 'displayName',
  offerOff: true,
})
console.log(`\ngenerated ${built.entries.length} entries; notes: ${built.notes.length}`)
for (const note of built.notes) console.log(`  note: ${note}`)

check('generation produced one entry per served model', built.entries.length === agreeing.served.length,
  JSON.stringify({ entries: built.entries.length, served: agreeing.served.length }))

// Schema sanity: only fields the pi-ai modelProfile declares, with legal values. This was a
// printed count before; a non-zero count that exited 0 was a green suite describing a broken
// profile.
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
console.log(`schema problems: ${problems.length}`)
for (const p of problems) console.log(`  ${p}`)
check('every generated entry uses only declared profile fields with legal values',
  problems.length === 0, JSON.stringify(problems))

fixtureOnly('a capacity read from the catalogue is distinguishable from a default', () => {
  const glm = built.entries.find(entry => entry.id === 'glm-5.3')
  const opus = built.entries.find(entry => entry.id === 'claude-opus-5-5')
  check('glm-5.3 carries its own 8192 output cap rather than the common 128000',
    glm?.maxTokens === 8192, JSON.stringify(glm?.maxTokens))
  check('and the full record carries its display name, both modalities and the off level',
    opus?.name === 'OPUS 5.5' && JSON.stringify(opus?.input) === JSON.stringify(['text', 'image'])
    && opus?.reasoningEfforts?.off === null && opus?.reasoningEfforts?.max === 'max',
    JSON.stringify(opus))
})

fixtureOnly('an unpublished window stays unpublished rather than being invented', () => {
  const bare = built.entries.find(entry => entry.id === 'no-capacity-model')
  check('the capacity-less model generates an entry with no contextWindow and no maxTokens',
    bare !== undefined && bare.contextWindow === undefined && bare.maxTokens === undefined,
    JSON.stringify(bare))
})

/* ------------------------------ drift report ----------------------------- */

const diff = diffModels(FIXTURE.installed, built.entries)
console.log('\n--- drift vs installed ---')
console.log(`upToDate: ${diff.upToDate}`)
console.log(`added   : ${diff.added.join(', ') || '—'}`)
console.log(`removed : ${diff.removed.join(', ') || '—'}`)
console.log(`changed : ${diff.changed.length}`)
for (const change of diff.changed) {
  console.log(`  ${change.id}`)
  for (const f of change.fields) console.log(`     ${f.field}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`)
}

fixtureOnly('the drift is in both directions, so the diff is not retirement-only', () => {
  check('an installed model the provider no longer serves is removed',
    diff.removed.includes('fable-ultra-promax'), JSON.stringify(diff.removed))
  check('a served model that is not installed is added',
    diff.added.includes('kimi-k3') && diff.added.includes('gpt-6.1-sol'), JSON.stringify(diff.added))
  check('and the plan is therefore not up to date', diff.upToDate === false, String(diff.upToDate))
})

if (agreeingOrigin !== null) await agreeingOrigin.close()

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('')
  for (const result of failed) console.log(`FAIL  ${result.name}  — ${result.detail}`)
  // `exitCode` rather than `process.exit`: the process ends once its handles are done, which
  // is what keeps the teardown above honest instead of racing it.
  process.exitCode = 1
}
