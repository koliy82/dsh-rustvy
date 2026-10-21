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
//
// `PUBLISHING.md` is deliberately not in this list. It is a private maintainer
// guide, ignored by git and never pushed, so requiring it on disk would fail on
// every fresh clone. It is checked below only when it happens to be present.
for (const local of ['tests', 'docs', 'scripts', '.gitignore']) {
  check(`${local} exists on disk`, existsSync(join(ROOT, local)))
  check(`files does not ship ${local}`, !shipped.has(local), [...shipped].join(', '))
}
check('files does not ship PUBLISHING.md', !shipped.has('PUBLISHING.md'), [...shipped].join(', '))

/* --------------------------------- sources -------------------------------- */

const entry = manifest.main ?? 'lib/index.js'
check('the main entry exists', existsSync(join(ROOT, entry)), String(entry))
// The bootstrap re-imports these through a cache-busting query, so a renamed or
// missing one is a plugin that loads and then silently stops reloading.
for (const module of ['lib/host.js', 'lib/models.js', 'lib/keys.js', 'lib/net.js', 'lib/errors.js']) {
  check(`${module} exists`, existsSync(join(ROOT, module)))
}
check('the client bundle exists', existsSync(join(ROOT, 'client/client.js')))
check('no leftover duplicate entry ships', !existsSync(join(ROOT, 'lib/live.js')),
  existsSync(join(ROOT, 'lib/live.js')) ? 'the loader row no longer names it' : '')

// The pure mapping module can be imported without touching the network, which
// makes it a real smoke test available at publish time.
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

// The ring's arithmetic is pure too, and it owns the one property the whole key
// feature rests on: a second key's route is a *clone* of the profile's route, and
// the route the profile declares is left alone. Both are cheap to assert here and
// impossible to notice in a tarball that installs cleanly.
try {
  const keys = await import(`file://${join(ROOT, 'lib/keys.js').replace(/\\/g, '/')}`)
  const expected = ['checkKeyValue', 'maskKey', 'keyFingerprint', 'normalizeLabel', 'refFor', 'routeFor',
    'displayNameFor', 'emptyRing', 'readRing', 'writeRing', 'withPrimaryKey', 'newKeyEntry',
    'keyProviderProfile', 'isRingRoute', 'syncRingRoutes', 'routesToSync', 'readPicks', 'writePicks',
    'pickCounts', 'describeKey']
  const missing = expected.filter(name => typeof keys[name] !== 'function')
  check('lib/keys.js exports its whole surface', missing.length === 0, missing.join(', '))
  check('lib/keys.js exports its key limit', Number.isFinite(keys.MAX_KEYS) && keys.MAX_KEYS > 1, String(keys.MAX_KEYS))

  const base = {
    displayName: 'rustvy', apiKeyEnv: 'RUSTVY_API_KEY', api: 'openai-completions',
    baseURL: 'https://rustvy.xyz/v1', models: [{ id: 'x', name: 'X', maxTokens: 8 }],
  }
  const ring = keys.withPrimaryKey(keys.emptyRing(), base, 'rustvy')
  check('the primary key is the route the profile declares',
    ring.keys.length === 1 && ring.keys[0].primary === true && ring.keys[0].route === 'rustvy'
    && ring.keys[0].ref === 'RUSTVY_API_KEY', JSON.stringify(ring.keys[0]))
  const entry = keys.newKeyEntry(ring, { baseRef: base.apiKeyEnv, baseRoute: 'rustvy', label: 'Second' })
  const synced = keys.syncRingRoutes({ rustvy: base }, { ...ring, keys: [...ring.keys, entry] }, 'rustvy')
  const clone = synced.providers[entry.route]
  check('a second key is named by its ordinal', entry.route === 'rustvy-k2' && entry.ref === 'RUSTVY_API_KEY_2',
    `${entry.route} / ${entry.ref}`)
  check('its clone keeps the endpoint, the protocol and the model list',
    clone?.baseURL === base.baseURL && clone?.api === base.api
    && JSON.stringify(clone?.models) === JSON.stringify(base.models))
  check('the clone carries its own reference and the base route is untouched',
    clone?.apiKeyEnv === entry.ref && synced.providers.rustvy.apiKeyEnv === base.apiKeyEnv
    && synced.providers.rustvy.displayName === base.displayName)
  check('a foreign provider is never claimed as a clone',
    keys.isRingRoute('deepseek-account', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, 'rustvy', new Set([entry.ref])) === false
    && keys.isRingRoute(entry.route, clone, 'rustvy', new Set([entry.ref])) === true)
  check('a masked key is not a usable key',
    keys.maskKey('sk-live-secret-01') === 'sk-…01' && !keys.maskKey('sk-live-secret-01').includes('secret'),
    keys.maskKey('sk-live-secret-01'))
} catch (error) {
  check('lib/keys.js imports', false, error.message)
}

// The report module is pure as well, and it owns the two decisions the whole
// monitor rests on: an infrastructure fault is reported and the user's own account
// trouble is not, and the report that goes out carries the fields the collector's
// API actually reads. All of it is cheap to assert here, and a classifier or a
// mapping that got it wrong is invisible in a tarball that installs cleanly — it
// simply reports nothing, reports somebody's unpaid balance as an outage, or
// reports to a field the collector ignores.
try {
  const errors = await import(`file://${join(ROOT, 'lib/errors.js').replace(/\\/g, '/')}`)
  const expected = ['classifyFailure', 'scrubErrorText', 'readInstallIdentity', 'eventRecord', 'reportPayload', 'createReporter']
  const missing = expected.filter(name => typeof errors[name] !== 'function')
  check('lib/errors.js exports its whole surface', missing.length === 0, missing.join(', '))
  check('lib/errors.js exports its report version',
    Number.isInteger(errors.REPORT_VERSION) && errors.REPORT_VERSION >= 1, String(errors.REPORT_VERSION))
  check('lib/errors.js exports its non-infra codes',
    errors.NON_INFRA_CODES instanceof Set && errors.NON_INFRA_CODES.size > 1, String(errors.NON_INFRA_CODES?.size))
  check('lib/errors.js exports its folding limits',
    Number.isFinite(errors.FOLD_LIMITS?.FAILURE_WINDOW_MS) && Number.isFinite(errors.FOLD_LIMITS?.MAX_BATCH)
    && Number.isFinite(errors.FOLD_LIMITS?.MAX_PER_MINUTE),
    Object.keys(errors.FOLD_LIMITS ?? {}).join(', '))

  const outage = errors.classifyFailure({ message: 'upstream_502', code: 'PI_AI_ERROR' })
  check('an upstream gateway fault counts as infrastructure',
    outage.infra === true && outage.kind === 'upstream_502' && outage.status === 502, JSON.stringify(outage))
  const quota = errors.classifyFailure({ message: 'You exceeded your current quota', code: 'QUOTA' })
  check('an exhausted quota does not', quota.infra === false, JSON.stringify(quota))

  // The wire mapping: `code` carries our kind, the harness verdict moves to
  // `meta.harnessCode`, `status` is absent rather than 0, and `message` is never
  // empty — a report with no text is worthless to whoever reads it.
  const record = errors.eventRecord({
    at: 1792435355423, model: 'gpt-6.1-sol', ok: false, status: 0, ms: 10683, err: '',
    route: 'rustvy', code: 'TIMEOUT', kind: 'connect_timeout', count: 1,
  }, { id: 'install-uuid' })
  const payload = errors.reportPayload(record)
  check('a report names its kind as the code and keeps the harness verdict in meta',
    payload.code === 'connect_timeout' && payload.meta?.harnessCode === 'TIMEOUT'
    && payload.plugin === 'dsh-rustvy' && payload.provider === 'rustvy'
    && payload.meta?.id === 'install-uuid' && payload.ts === 1792435355423, JSON.stringify(payload))
  check('a report omits an absent status and never sends an empty message',
    !('status' in payload) && typeof payload.message === 'string' && payload.message !== '', JSON.stringify(payload.message))
  check('a report sends exactly one alias per concept',
    !('error' in payload) && !('detail' in payload) && !('type' in payload) && !('kind' in payload)
    && !('timestamp' in payload) && !('source' in payload) && !('events' in payload), Object.keys(payload).join(', '))

  // The per-minute ceiling is the property that keeps one install from spending a
  // whole NAT's share of the collector's 60 reports/min/IP, and it is cheap to
  // reach only from here: a burst must pause, must not lose a single report, and
  // must publish the pause where a reader can see it. A regression that turned
  // this into a drop — or into a burst — would be invisible in a package that
  // installs cleanly and would only show up as everybody's 429s.
  const gateSent = []
  const gateClock = 1_000_000
  const gate = errors.createReporter({
    // The real collector's address, so this fixture cannot be mistaken for a
    // private one; `send` is injected, so nothing here reaches the network.
    endpoint: 'http://185.94.29.228:3789/api/report',
    identity: { id: 'publish-gate' },
    send: async report => { gateSent.push(report); return { status: 200 } },
    now: () => gateClock,
    limits: { MAX_PER_MINUTE: 1, MAX_BATCH: 5 },
  })
  gate.noteFailure({ model: 'a', kind: 'dns', err: 'ENOTFOUND', at: gateClock })
  gate.noteFailure({ model: 'b', kind: 'dns', err: 'ENOTFOUND', at: gateClock + 10 })
  gate.start()
  await gate.flush({ settle: true })
  const throttled = gate.summary()
  check('the per-minute ceiling pauses delivery instead of dropping it',
    gateSent.length === 1 && throttled.queued === 1 && throttled.dropped === 0 && throttled.failed === 0,
    `sent ${gateSent.length}, queued ${throttled.queued}, dropped ${throttled.dropped}, failed ${throttled.failed}`)
  check('and says so through nextFlushAt rather than only through the log',
    throttled.nextFlushAt === gateClock + errors.FOLD_LIMITS.MINUTE_MS, String(throttled.nextFlushAt))
  gate.dispose()
} catch (error) {
  check('lib/errors.js imports', false, error.message)
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

// The publishing guide is a private note that git ignores, so it never reaches
// GitHub. That decision is fine, but it has to be consistent: a file that is not
// pushed must not be linked from something that is, or the repository's front page
// carries a dead link — precisely what a catalog reviewer notices first.
check('the publishing guide stays out of git',
  read('.gitignore').split('\n').some(line => line.trim() === 'PUBLISHING.md'),
  'either ignore it or publish it; an untracked file nobody mentions is fine, a half-decision is not')
for (const file of ['README.md', 'README.en.md']) {
  if (!existsSync(join(ROOT, file))) continue
  check(`${file} does not link the untracked publishing guide`,
    !/\]\(\.?\/?PUBLISHING\.md\)/u.test(read(file)),
    'the link would be dead on GitHub')
}
if (existsSync(join(ROOT, 'PUBLISHING.md'))) {
  check('the publishing guide names the catalog repository',
    read('PUBLISHING.md').includes('awesome-dsh-plugin'),
    'the market reads that list, so the guide has to name it')
}

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) {
  console.error('\nFix the failures above before publishing: npm publish runs this gate and will stop.')
  process.exitCode = 1
}
