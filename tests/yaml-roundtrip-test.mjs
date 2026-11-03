// YAML emitter round-trip: re-emit a real route row with the plugin's own emitter
// and check two independent parsers read it back.
//
// Two things are borrowed from the machine rather than vendored, and both degrade
// to a visible skip instead of a false pass:
//
//   - the parsers. js-yaml and yaml both ship inside a dsh profile (yaml is what
//     configEditor writes with), so the emitter is checked against the parser that
//     will actually read its output rather than against a dependency added just to
//     test it.
//   - the row. The profile's own cordis.patch.yml is parsed when there is one,
//     which proves the emitter reproduces a document a real deployment carries,
//     comments and all. Without one, a synthetic row of the same shape is used.
//
// A third thing used to be borrowed and was NOT documented: the model list. This file
// fetched https://rustvy.xyz/v1/models and /models on every run, which made the suite's
// outcome a fact about the network rather than about the emitter — the last suite in the
// tree that did so, and `prepublishOnly` runs every suite, so a provider hiccup could block
// a publish at an arbitrary moment. Both halves now come from a committed fixture, captured
// once from the real endpoint. The live path survives behind a flag, because it covers what
// a fixture cannot: that the provider's two answers still parse.
//
//     $env:DSH_RUSTVY_LIVE_YAML_ROUNDTRIP = '1'; node tests/yaml-roundtrip-test.mjs
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { routePatchYaml, yamlScalar, buildModelEntries, normalizeServedList, mirrorRecord } =
  await import('../lib/models.js')

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/yaml-roundtrip.json'), 'utf8'))
const LIVE = process.env.DSH_RUSTVY_LIVE_YAML_ROUNDTRIP === '1'

const results = []
const skipped = []
function check(label, ok, detail) {
  results.push(ok === true)
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

const PROFILE = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop')

let jsYaml
let YAML
try {
  const req = createRequire(join(PROFILE, 'package.json'))
  jsYaml = req('js-yaml')
  YAML = req('yaml')
} catch (error) {
  skipped.push(`no YAML parser reachable from ${PROFILE} (${error.code ?? error.message})`)
}

// --- scalar quoting --------------------------------------------------------
const scalars = [
  ['rustvy', 'rustvy'],
  ['Ahmia 7 Pro', 'Ahmia 7 Pro'],
  ['Qwen 3.8 Max 0902', 'Qwen 3.8 Max 0902'],
  ['gpt-6.1-sol', 'gpt-6.1-sol'],
  ['https://rustvy.xyz/v1', 'https://rustvy.xyz/v1'],
  ['RUSTVY_API_KEY', 'RUSTVY_API_KEY'],
  ['@deepseek-ai/dsh-llm-pi-ai', '"@deepseek-ai/dsh-llm-pi-ai"'],
  ['true', '"true"'],
  ['off', '"off"'],
  ['', '""'],
  ['123', '"123"'],
  ['1.5', '"1.5"'],
  ['a: b', '"a: b"'],
  ['lead ', '"lead "'],
  // A double quote mid-scalar is legal plain YAML — only a leading one is not —
  // so the emitter leaves it alone and the round-trip below proves it reads back.
  ['say "hi"', 'say "hi"'],
  ['"quoted"', '"\\"quoted\\""'],
]
for (const [input, want] of scalars) {
  const got = yamlScalar(input)
  check(`scalar ${JSON.stringify(input)} -> ${want}`, got === want, `got ${got}`)
}
check('scalar null', yamlScalar(null) === 'null')
check('scalar number', yamlScalar(128000) === '128000')
check('scalar boolean', yamlScalar(false) === 'false')

if (jsYaml === undefined) {
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed, ${skipped.length} skipped`)
  for (const note of skipped) console.log(`  skip: ${note}`)
  console.log('  (the parser-dependent half needs a dsh profile with js-yaml and yaml installed)')
  process.exitCode = results.every(Boolean) ? 0 : 1
} else {
  // Every quoted form must survive a real parser.
  for (const [input] of scalars) {
    const doc = jsYaml.load(`v: ${yamlScalar(input)}`)
    check(`scalar round-trip ${JSON.stringify(input)}`, doc.v === input, JSON.stringify(doc.v))
  }

  // --- the row under test ---------------------------------------------------
  const PATCH = join(PROFILE, 'cordis.patch.yml')
  let parsed
  let row
  if (existsSync(PATCH)) {
    parsed = jsYaml.load(readFileSync(PATCH, 'utf8'))
    row = Array.isArray(parsed) ? parsed.find(item => item?.config?.providers?.rustvy !== undefined) : undefined
  }
  if (row === undefined) {
    skipped.push(`no rustvy route row in ${PATCH}; using a synthetic row of the same shape`)
    row = {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          rustvy: {
            displayName: 'rustvy',
            apiKeyEnv: 'RUSTVY_API_KEY',
            api: 'openai-completions',
            baseURL: 'https://rustvy.xyz/v1',
            models: [{
              id: 'placeholder',
              name: 'placeholder',
              maxTokens: 8192,
              reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
            }],
          },
        },
      },
    }
  } else {
    check(`found the route row in ${PATCH}`, true, row.id)
  }
  const provider = row.config.providers.rustvy

  // Emit exactly what the plugin would hand a profile author: the installed
  // provider fields plus the models the origin serves.
  //
  // No local server stands in for the origin here, unlike model-sync-host-test and
  // models-check: nothing under test fetches. This suite's subject is the emitter and the
  // two parsers that read its output, so the served list and the island are inputs, and a
  // server would be scaffolding with nothing to stand in for.
  let served
  let records
  if (LIVE) {
    served = normalizeServedList(
      await (await fetch('https://rustvy.xyz/v1/models', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })).json(),
    )
    const html = await (await fetch('https://rustvy.xyz/models', { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(20_000) })).text()
    const islandMatch = /<script[^>]*\bid=["']?rustvy-catalog["']?[^>]*>([\s\S]*?)<\/script>/iu.exec(html)
    // Loud rather than an empty list: an empty island would generate zero models and every
    // assertion below about the emitted document would pass vacuously.
    if (islandMatch === null) throw new Error('live mode: no rustvy-catalog island on /models')
    records = JSON.parse(islandMatch[1]).records.map(mirrorRecord).filter(Boolean)
  } else {
    served = normalizeServedList({ data: FIXTURE.served.map(id => ({ id })) })
    records = FIXTURE.island.records.map(mirrorRecord).filter(Boolean)
  }
  // Shape, not count: the provider's enabled list oscillates (nine one morning, fourteen by
  // evening, same island version), so nothing below may pin a number the fixture happens to
  // hold today. What must be true is that there IS something to emit.
  check('the fixture yields models to emit, so the round-trip is not vacuous',
    served.length > 0 && records.length > 0,
    JSON.stringify({ served: served.length, records: records.length }))
  const { entries } = buildModelEntries(served, records, provider.models, {
    nameSource: 'displayName',
    offerOff: true,
  })
  check('and it yields generated entries from both halves', entries.length > 0, String(entries.length))

  const text = routePatchYaml({
    entryId: row.id,
    packageName: row.name,
    providerKey: 'rustvy',
    provider,
    models: entries,
  })

  console.log('\n--- emitted YAML (first 20 lines) ---')
  console.log(text.split('\n').slice(0, 20).map(line => `  ${line}`).join('\n'))
  console.log(`  ... (${text.split('\n').length} lines total)\n`)

  // Two independent parsers must both read it back, and agree.
  const viaJsYaml = jsYaml.load(text)
  const viaYaml = YAML.parse(text)
  check('js-yaml parses the emitted row', Array.isArray(viaJsYaml) && viaJsYaml.length === 1)
  check('yaml parses the emitted row', Array.isArray(viaYaml) && viaYaml.length === 1)
  check('both parsers agree', JSON.stringify(viaJsYaml) === JSON.stringify(viaYaml))

  const back = viaJsYaml[0]
  check('id preserved', back.id === row.id, String(back.id))
  check('package name preserved', back.name === row.name, String(back.name))
  const backProvider = back.config.providers.rustvy
  for (const field of ['displayName', 'apiKeyEnv', 'api', 'baseURL']) {
    check(`provider.${field} preserved`, backProvider[field] === provider[field],
      `${JSON.stringify(provider[field])} -> ${JSON.stringify(backProvider[field])}`)
  }
  check('models replaced with the generated list', backProvider.models.length === entries.length,
    `${provider.models.length} -> ${backProvider.models.length}`)
  check('emitted models deep-equal the generated entries',
    JSON.stringify(backProvider.models) === JSON.stringify(entries))
  check('every generated model keeps its id and a name',
    backProvider.models.every(m => typeof m.id === 'string' && typeof m.name === 'string'))
  check('reasoningEfforts.off survives as real null',
    backProvider.models.every(m => m.reasoningEfforts === false || m.reasoningEfforts?.off === null))
  check('input stays a list of known modalities',
    backProvider.models.every(m => m.input === undefined || m.input.every(v => v === 'text' || v === 'image')))
  check('no other provider row leaked in',
    Object.keys(back.config.providers).length === 1 && 'rustvy' in back.config.providers)

  // The emitted row must be substitutable into the document it came from.
  const document = parsed ?? [row]
  const substituted = document.map(item => (item?.id === row.id ? back : item))
  const reparsed = jsYaml.load(jsYaml.dump(substituted))
  check('the document still parses with the row substituted', reparsed.length === document.length)
  check('neighbouring rows are untouched',
    JSON.stringify(reparsed.filter(i => i?.id !== row.id))
    === JSON.stringify(document.filter(i => i?.id !== row.id)))

  const failed = results.filter(ok => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed, ${skipped.length} skipped`)
  for (const note of skipped) console.log(`  skip: ${note}`)
  // `process.exit()` here can trip a libuv assertion on Windows while undici
  // sockets from the two fetches are still closing; setting the code lets teardown finish.
  process.exitCode = failed === 0 ? 0 : 1
}
