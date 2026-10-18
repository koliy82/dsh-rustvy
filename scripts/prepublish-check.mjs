/**
 * Pre-publish gate for dsh-rustvy.
 *
 * Everything checked here is a way the package can install successfully and
 * still be wrong in a place nobody looks: a loader row that resolves but shows up
 * in the plugins menu as a file path, a locale file the resolver cannot reach
 * because `exports` does not list it, an icon that throws inside the host's
 * metadata read, or a `repository` field still carrying a placeholder — which
 * silently unlinks the npm package from its repository, and with it the catalog
 * entry that points at both.
 *
 * It has no dependencies on purpose: the package has none, and a publish gate
 * that needs an install to run is a gate that gets skipped.
 *
 * Run directly, or let `npm publish` run it through `prepublishOnly`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function check(label, ok, detail) {
  results.push(ok === true)
  console.log(`${ok === true ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined || detail === '' ? '' : `  — ${detail}`}`)
}

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8')
}

function readJson(file) {
  try {
    return JSON.parse(read(file))
  } catch (error) {
    check(`${file} parses`, false, error.message)
    return undefined
  }
}

const manifest = readJson('package.json')
if (manifest === undefined) {
  console.error('\npackage.json is unreadable; nothing else can be checked.')
  process.exit(1)
}

/* -------------------------------- identity ------------------------------- */

const PLACEHOLDER = /YOUR_GITHUB_USER|CHANGE-ME|your-?name|TODO/iu
check('name is set', typeof manifest.name === 'string' && manifest.name !== '', String(manifest.name))
check('version looks like a release', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version)), String(manifest.version))
check('license is declared', typeof manifest.license === 'string' && manifest.license !== '', String(manifest.license))
check('repository carries no placeholder', !PLACEHOLDER.test(JSON.stringify(manifest.repository ?? '')), JSON.stringify(manifest.repository?.url ?? manifest.repository))
check('homepage carries no placeholder', !PLACEHOLDER.test(String(manifest.homepage ?? '')), String(manifest.homepage))
check('bugs carries no placeholder', !PLACEHOLDER.test(JSON.stringify(manifest.bugs ?? '')), JSON.stringify(manifest.bugs?.url ?? manifest.bugs))
// The catalog links an npm package to its repository through this field; a
// mismatch means the market shows the repo with no download figure beside it.
const repoUrl = String(manifest.repository?.url ?? manifest.repository ?? '')
check('repository and homepage name the same repo',
  repoUrl === '' || String(manifest.homepage ?? '').includes(repoUrl.replace(/^git\+/, '').replace(/\.git$/, '')),
  `${repoUrl} vs ${manifest.homepage}`)

/* ------------------------------ bundle manifest --------------------------- */

const patch = manifest.dsh?.bundle?.patch
check('dsh.bundle.patch is declared', typeof patch === 'string' && patch !== '', String(patch))
check('the patch file ships', typeof patch === 'string' && existsSync(join(ROOT, patch)), String(patch))
check('dsh.client declares the web platform', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))

// The plugins menu reads display text with metaOf(row.name), which skips any
// specifier that is not a bare package name. A relative row name installs fine
// and then shows up as that path, with no title, description or icon.
if (typeof patch === 'string' && existsSync(join(ROOT, patch))) {
  const text = read(patch)
  const names = [...text.matchAll(/^\s*name:\s*(.+?)\s*$/gmu)].map(match => match[1].replace(/^['"]|['"]$/g, ''))
  const bare = names.filter(name => !name.startsWith('.') && !name.startsWith('/') && !name.startsWith('file:'))
  check('every loader row names a bare package', names.length > 0 && bare.length === names.length, names.join(', '))
  check('a loader row names this package', bare.includes(manifest.name), `${manifest.name} vs ${bare.join(', ')}`)
  check('every loader row has an id', /^\s*-\s*id:\s*\S/mu.test(text))
}

/* --------------------------------- locale --------------------------------- */

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const localeDir = join(ROOT, 'locale')
check('locale/en.json exists — it is the anchor the host resolves first', existsSync(join(localeDir, 'en.json')))
check('exports lets the host resolve ./locale/*.json',
  manifest.exports?.['./locale/*.json'] === './locale/*.json', String(manifest.exports?.['./locale/*.json']))
check('exports lets the host resolve ./package.json', manifest.exports?.['./package.json'] === './package.json')

if (existsSync(localeDir)) {
  for (const entry of readdirSync(localeDir)) {
    if (!entry.endsWith('.json')) continue
    const language = entry.slice(0, -'.json'.length)
    check(`locale/${entry} is named with a language id`, LANGUAGE_ID.test(language), language)
    const parsed = readJson(`locale/${entry}`)
    if (parsed === undefined) continue
    const title = parsed.meta?.title
    const description = parsed.meta?.description
    // The host throws on a present-but-empty field, so both must be real text.
    check(`locale/${entry} meta.title is a non-empty string`, typeof title === 'string' && title.trim() !== '', JSON.stringify(title))
    check(`locale/${entry} meta.description is a non-empty string`,
      typeof description === 'string' && description.trim() !== '', JSON.stringify(description))
    check(`locale/${entry} declares nothing but meta`, Object.keys(parsed).join(',') === 'meta', Object.keys(parsed).join(','))
  }
}

/* ---------------------------------- icon ---------------------------------- */

const ICON_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const MAX_ICON_BYTES = 256 * 1024
const icon = manifest.icon
if (icon === undefined) {
  check('icon is declared', false, 'the plugins menu will show no mark')
} else {
  check('icon is a relative path', !isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), String(icon))
  const file = resolve(ROOT, icon)
  check('icon stays inside the package', !relative(ROOT, file).startsWith('..'), String(icon))
  check('icon exists', existsSync(file), String(icon))
  check('icon has an admitted extension', ICON_TYPES.has(extname(icon).toLowerCase()), extname(icon))
  if (existsSync(file)) {
    const size = statSync(file).size
    check('icon is at most 256 KiB', size <= MAX_ICON_BYTES, `${size} bytes`)
    check('icon is a regular file', statSync(file).isFile())
  }
}

/* --------------------------------- files ---------------------------------- */

const shipped = new Set(manifest.files ?? [])
for (const required of ['lib', 'client', 'locale', 'assets', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']) {
  check(`files lists ${required}`, shipped.has(required), [...shipped].join(', '))
  check(`${required} exists on disk`, existsSync(join(ROOT, required)))
}
// Repository-only material: a reader of the source needs it, an installer does not,
// and shipping the gate that judges the package is exactly the kind of noise that
// makes a tarball hard to review.
for (const local of ['tests', 'docs', 'scripts', 'PUBLISHING.md', '.gitignore']) {
  check(`${local} exists on disk`, existsSync(join(ROOT, local)))
  check(`files does not ship ${local}`, !shipped.has(local), [...shipped].join(', '))
}

/* --------------------------------- sources -------------------------------- */

const entry = manifest.main ?? 'lib/index.js'
check('the main entry exists', existsSync(join(ROOT, entry)), String(entry))
// The bootstrap re-imports these through a cache-busting query, so a renamed or
// missing one is a plugin that loads and then silently stops reloading.
for (const module of ['lib/host.js', 'lib/models.js', 'lib/net.js']) {
  check(`${module} exists`, existsSync(join(ROOT, module)))
}
check('the client bundle exists', existsSync(join(ROOT, 'client/client.js')))
check('no leftover duplicate entry ships', !existsSync(join(ROOT, 'lib/live.js')),
  existsSync(join(ROOT, 'lib/live.js')) ? 'the loader row no longer names it' : '')

// The pure mapping module can be imported without touching the network, which
// makes it the one real smoke test available at publish time.
try {
  const models = await import(`file://${join(ROOT, 'lib/models.js').replace(/\\/g, '/')}`)
  const expected = ['mirrorRecord', 'normalizeServedList', 'buildModelEntries', 'diffModels', 'servedFromCatalog', 'routePatchYaml', 'yamlScalar', 'yamlLines', 'reasoningEffortsOf']
  const missing = expected.filter(name => typeof models[name] !== 'function')
  check('lib/models.js exports its whole surface', missing.length === 0, missing.join(', '))
  const emitted = models.routePatchYaml({
    entryId: 'llm-pi-ai',
    packageName: '@deepseek-ai/dsh-llm-pi-ai',
    providerKey: 'rustvy',
    provider: { baseURL: 'https://rustvy.xyz/v1', apiKeyEnv: 'RUSTVY_API_KEY' },
    models: [{ id: 'x', name: 'X', maxTokens: 8, reasoningEfforts: { off: null, low: 'low' } }],
  })
  check('the YAML emitter still produces a patch row', emitted.startsWith('- id: llm-pi-ai\n') && emitted.includes('off: null'), emitted.split('\n')[0])
} catch (error) {
  check('lib/models.js imports', false, error.message)
}

/* --------------------------------- readme --------------------------------- */

// The primary README is Russian — the provider this plugin is written against is
// Russian — and README.en.md is the English one. Both have to exist, both have to
// document installation, and both have to point at the other, because the catalog's
// reviewer reads whichever of the two they can and an install nobody can follow is
// a defect in either language.
for (const file of ['README.md', 'README.en.md']) {
  if (!existsSync(join(ROOT, file))) {
    check(`${file} exists`, false)
    continue
  }
  const readme = read(file)
  check(`${file} titles the plugin`, /^#\s+\S/mu.test(readme))
  check(`${file} documents installation`, /^##\s+(?:Install|Установка)\s*$/imu.test(readme),
    'the catalog review reads the repo')
  check(`${file} carries no placeholder`, !PLACEHOLDER.test(readme),
    'a placeholder in a README reads as an unfinished submission')
  check(`${file} links the other language`,
    /(?:README\.md|README\.en\.md)\)/u.test(readme), 'a reader who picked the wrong one needs a way back')
}

if (existsSync(join(ROOT, 'PUBLISHING.md'))) {
  check('PUBLISHING.md names the catalog repository',
    read('PUBLISHING.md').includes('awesome-dsh-plugin'),
    'the market reads that list, so the guide has to name it')
}

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) {
  console.error('\nFix the failures above before publishing: npm publish runs this gate and will stop.')
  process.exitCode = 1
}
