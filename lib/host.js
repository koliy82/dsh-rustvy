/**
 * dsh-rustvy — host implementation.
 *
 * This file is loaded, and reloaded, by the package's stable entry
 * (`lib/index.js`; `lib/live.js` is a byte-identical copy of it). Everything a
 * reload replaces lives here: the loopback routes, the catalog mirror and the
 * logo cache. Nothing in this file uses `ctx.effect`, so a reload is a clean
 * dispose-and-start rather than an accumulating pile of fibers.
 *
 * What it is for: the browser half draws one monochrome vendor mark per model
 * row in the model picker, and it must not reach the internet to do it — the
 * page's own egress is exactly what this profile cannot rely on. So this half
 * mirrors two public things from the provider's site to loopback:
 *
 *   - the model catalog, which the site embeds as JSON in its own pages
 *     (`<script id="rustvy-catalog">`): model id → display name, vendor and the
 *     logo file name that vendor uses;
 *   - the logo files themselves (`/logos/<name>.svg`), copied into this profile's
 *     cache directory on first use and served from there afterwards.
 *
 * Both are read on the process's own outbound route (`./net.js`), so a proxy
 * installed by another plugin — or named in the environment — is followed, and
 * both are cached on disk, so the picker still has its marks when the origin is
 * unreachable.
 *
 * The same mirror also keeps the *model list* current. A profile routes this
 * provider through a hand-declared `@deepseek-ai/dsh-llm-pi-ai` route, whose
 * `models` list decides what the GUI may select — and a hand-written list goes
 * stale the day the provider ships a model. So this half reads the models the
 * route's own endpoint serves, turns them into that adapter's exact entry shape
 * (`./models.js`), reports the difference against what is installed, and writes
 * it back through `ctx.configEditor` when asked to. The list is generated, never
 * merged blindly: a wire-compatibility switch only a profile author could know
 * is carried forward, everything else follows the origin.
 *
 * The third thing it owns is the *key ring*: several provider keys in one
 * profile, and one chat sending its requests with the key its user picked. The
 * adapter resolves its credential from a route's `apiKeyEnv` — a reference name,
 * read through the harness credentials service on every request — and no call
 * configuration carries a key, so one route is one key. Adding a key therefore
 * stores the value under a new reference (`credentials.set`), clones the base
 * route under a new name with the same endpoint and the same generated model
 * list, and remembers which chat picked which key (`./keys.js`). The pick is
 * applied on the `agent/request` waterfall — the same seam the harness itself
 * uses to apply a per-chat model choice — by naming the clone instead of the base
 * route, and only ever for a route this ring owns, so an account-authenticated
 * provider is never touched.
 *
 * The fourth thing it owns is the *uptime report*. A model request that fails
 * because the provider's own infrastructure failed — a gateway answering 502, a
 * connection that was never accepted, a stream that went idle and had to be
 * killed — is one event, handed to a collector with no prompt, no key and
 * nothing in it that names anybody beyond an anonymous per-install id. What a
 * monitor builds from those events is when, for how many people, and on which
 * model which outage fell: the same answer an active probe would give, without
 * spending a token to ask. Faults the user owns are never reported — a spent
 * subscription, an exhausted quota, a rate limit, a bad key, an over-long
 * context, a pressed stop are theirs and not an outage — and no report may ever
 * cost a chat its request, so both the observing and the delivering are
 * contained: a failed send is a queued record and a `warn` line, and a listener
 * that throws loses one event rather than one step.
 *
 * @module dsh-rustvy/host
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Build marker surfaced by `/state`; bump it to watch a reload land. */
export const build = 'rustvy-3'

/**
 * The revision this copy was loaded under, forwarded to the relative import so
 * Node's URL-keyed module cache hands a reload a fresh module graph.
 */
const REVISION = new URL(import.meta.url).searchParams.get('rev') ?? '0'

const NET = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'net.js')).href
const { getUrl, postJson, proxyForTarget } = await import(`${NET}?rev=${REVISION}`)

const MODELS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'models.js')).href
const {
  mirrorRecord, normalizeServedList, buildModelEntries, diffModels, servedFromCatalog, providersPatchYaml,
} = await import(`${MODELS}?rev=${REVISION}`)

const KEYS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'keys.js')).href
const {
  checkKeyValue, readRing, writeRing, withPrimaryKey, newKeyEntry, syncRingRoutes, routesToSync,
  readPicks, writePicks, pickCounts, describeKey, displayNameFor, normalizeLabel, refFor, routeFor, MAX_KEYS,
} = await import(`${KEYS}?rev=${REVISION}`)

const ERRORS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'errors.js')).href
const { classifyFailure, readInstallIdentity, createReporter } = await import(`${ERRORS}?rev=${REVISION}`)

const UPTIME = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'uptime.js')).href
const { normalizeUptimeView, isUptimeRange, UPTIME_RANGES, DEFAULT_RANGE } = await import(`${UPTIME}?rev=${REVISION}`)

/** Loader-facing plugin name. */
export const name = 'dsh-rustvy'

/** Base path of every route this half registers. */
const PREFIX = '/dsh-rustvy'

/**
 * The pages that carry the embedded catalog, in the order they are tried. The
 * public page comes first: it needs no session, and it is the one the site keeps
 * stable for readers who are not signed in.
 */
const CATALOG_PAGES = ['/models', '/dashboard/models', '/pricing']

/** How long a cached catalog is considered current, in milliseconds. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a *cold* catalog read may hold the answer, in milliseconds. Past
 * this the route answers with an empty mirror and the browser half falls back to
 * its vendor rules, which resolve a model the mirror has never seen.
 */
const COLD_WAIT_MS = 6000

/** One request budget for the origin, in milliseconds. */
const ORIGIN_TIMEOUT_MS = 25_000

/** How long a cached uptime view is served without asking again, in milliseconds. */
const UPTIME_TTL_MS = 60_000

/** One request budget for the collector's view, in milliseconds. */
const UPTIME_TIMEOUT_MS = 15_000

/** Largest accepted logo; the site's marks are a few hundred bytes to a few KiB. */
const MAX_LOGO_BYTES = 512 * 1024

/** A logo file name this half is willing to fetch, cache and serve. */
const LOGO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.svg$/u

/** Default settings, overridable per profile and by the environment. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  origin: 'https://rustvy.xyz',
  size: 16,
  markTrigger: true,
  hideOtherMarks: true,
  syncModels: true,
  modelRoute: 'rustvy',
  modelEntryId: 'llm-pi-ai',
  modelAutoApply: 'explicit',
  modelNameSource: 'displayName',
  modelOfferOff: true,
  modelKeepUnknown: false,
  modelZones: ['standard'],
  apiKeys: true,
  collectErrors: true,
  uptimeView: true,
  // The public collector. Plain HTTP over a bare IP on purpose for now — a report
  // carries no secret worth intercepting, and a hostname and TLS arrive with the
  // collector's own deployment rather than with a release here. A profile repoints
  // it through `uptimeEndpoint` in the settings or `DSH_RUSTVY_UPTIME_ENDPOINT` in
  // the environment.
  uptimeEndpoint: 'http://185.75.189.247:3789/api/report',
})

/** The adapter package whose route profile carries the generated model list. */
const PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'

/** When a regenerated list may be written without being asked for. */
const AUTO_APPLY_MODES = Object.freeze(['off', 'explicit', 'always'])

/** What a generated model's label is taken from. */
const NAME_SOURCES = Object.freeze(['displayName', 'id'])

/** Environment overrides, so a deployment can point the mirror elsewhere. */
const ENV_ORIGIN = 'DSH_RUSTVY_ORIGIN'

/** Environment switch that keeps the plugin mounted but inert. */
const ENV_DISABLED = 'DSH_RUSTVY_DISABLED'

/** Environment override for the collector the uptime reports are sent to. */
const ENV_UPTIME_ENDPOINT = 'DSH_RUSTVY_UPTIME_ENDPOINT'

/** Environment switch that keeps the plugin mounted but reports no errors. */
const ENV_NO_ERRORS = 'DSH_RUSTVY_NO_ERRORS'

/** Environment switch that keeps the plugin mounted but hides the uptime panel. */
const ENV_NO_UPTIME = 'DSH_RUSTVY_NO_UPTIME'

/** The harness home directory, as the launcher publishes it. */
function homeDir() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh')
}

/** This profile's directory, as the launcher publishes it. */
function profileDir() {
  return process.env.DSH_PROFILE_DIR ?? join(homeDir(), 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

/** Where this plugin's cache and settings live. */
function stateDir() {
  return join(profileDir(), '.dsh-rustvy')
}

/** The mirrored catalog. */
function catalogFile() {
  return join(stateDir(), 'catalog.json')
}

/** The mirrored logo set. */
function logosDir() {
  return join(stateDir(), 'logos')
}

/**
 * The user's own settings for this plugin.
 * @returns the settings file path.
 */
function configFile() {
  return join(stateDir(), 'config.json')
}

/**
 * The route profile as it was before the last generated write.
 *
 * A regeneration replaces a whole model list, and "the provider retired a model"
 * looks exactly like "the provider's listing was momentarily wrong" from here,
 * so the previous list is always kept and one click puts it back.
 *
 * @returns the backup file path.
 */
function modelsBackupFile() {
  return join(stateDir(), 'models-backup.json')
}

/**
 * The key ring's metadata: which label owns which credential reference and which
 * provider route. The secrets themselves are not here — they live in the harness
 * credential store, where the adapter already reads them from.
 *
 * @returns the ring file path.
 */
function keysFile() {
  return join(stateDir(), 'keys.json')
}

/**
 * Which chat sends its requests with which key.
 *
 * Kept on disk rather than in the session log: it is a routing preference of this
 * plugin, and a plugin that wrote its own events into a durable log would leave
 * them behind in every session it was ever mounted in.
 *
 * @returns the picks file path.
 */
function picksFile() {
  return join(stateDir(), 'session-keys.json')
}

/**
 * This install's anonymous identity: one random id, and the moment it was made.
 *
 * It is what lets a monitor say "this outage fell for N people" without ever
 * learning who they are — the id names a profile directory, not a person, and it
 * carries no secret, no machine detail and nothing derived from either.
 *
 * @returns the identity file path.
 */
function installFile() {
  return join(stateDir(), 'install.json')
}

/**
 * The error reports that have not reached the collector yet.
 *
 * Kept on disk rather than in memory because the moment a report is worth sending
 * is usually the moment the collector is unreachable too: a site that is down
 * queues its own evidence, and the records go out on a later flush. Holds failure
 * kinds, model ids, routes and durations — no key, no prompt and no path.
 *
 * @returns the queue file path.
 */
function errorsQueueFile() {
  return join(stateDir(), 'errors-queue.json')
}

/**
 * The uptime views this profile has read, one entry per range.
 *
 * A fallback rather than a cache: the collector is the source of truth and the
 * in-memory views are what a page normally gets, so this file only earns its read
 * when the collector will not answer and the process has since restarted. It holds
 * every range fetched rather than only the last one, because the client reads the
 * hour window for badges and the day window for the panel as a matter of routine —
 * a single slot meant one of the two went blank on a cold mount during an outage,
 * which is precisely when somebody opens the panel to ask whether their provider is
 * down. Holds aggregated counts, model ids and failure kinds — nothing that names a
 * person.
 *
 * @returns the view file path.
 */
function uptimeFile() {
  return join(stateDir(), 'uptime.json')
}

/** The shape of the persisted views, so an older single-range file is recognized. */
const UPTIME_STORE_VERSION = 2

/**
 * The persisted views, as a range-keyed map.
 *
 * Reads both this shape and the single most-recent-range document it replaced, so a
 * profile that upgrades while its collector is unreachable keeps the last view it had
 * instead of losing it to a format change — the one moment the fallback exists for.
 *
 * Bounded by the whitelist rather than by a cap: only a range `isUptimeRange`
 * accepted can be written in the first place, so the map cannot grow past the number
 * of windows the contract defines however long the process runs.
 *
 * @returns a plain object of `range` to `{ fetchedAt, view }`, holding only entries
 *   that are still a usable view.
 */
function readUptimeStore() {
  const stored = readJsonFile(uptimeFile())
  if (typeof stored !== 'object' || stored === null) return {}
  const source = stored.version === UPTIME_STORE_VERSION && typeof stored.views === 'object' && stored.views !== null
    ? stored.views
    : (isUptimeRange(stored.range) ? { [stored.range]: { fetchedAt: stored.fetchedAt, view: stored.view } } : {})
  const views = {}
  for (const [range, entry] of Object.entries(source)) {
    if (!isUptimeRange(range)) continue
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.view !== 'object' || entry.view === null || entry.view.ok !== true) continue
    if (!Number.isFinite(entry.fetchedAt)) continue
    views[range] = { fetchedAt: entry.fetchedAt, view: entry.view }
  }
  return views
}

/** Log through the loader when it offers a logger, and the console otherwise. */
function log(ctx, level, message, error) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : ctx?.logger
  const sink = logger?.[level]
  if (typeof sink === 'function') sink.call(logger, message, ...(error === undefined ? [] : [error]))
  else if (level === 'warn' || level === 'error') console.error(`[${name}] ${message}`, error ?? '')
  else console.log(`[${name}] ${message}`)
}

/**
 * Write a file atomically: a half-written cache file would otherwise leave the
 * next launch reading a truncated document.
 *
 * @param file - the destination path.
 * @param data - the bytes or text to write.
 */
function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, data)
  renameSync(temporary, file)
}

/**
 * Read a JSON file, tolerating absence and corruption.
 * @param file - the path to read.
 * @returns the parsed value, or `undefined`.
 */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Whether a value names an `http(s)` endpoint this half may send to.
 *
 * Both the settings file and the environment are read without a schema, and a
 * collector address that does not parse would only fail later, inside a report
 * nobody is waiting on — so it is refused here and the value in force is kept.
 *
 * @param value - the candidate URL.
 * @returns true when it is an absolute `http:` or `https:` URL.
 */
function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || !URL.canParse(trimmed)) return false
  const protocol = new URL(trimmed).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/**
 * The settings in force: the stored ones, over the defaults, over the
 * environment. The environment wins so a deployment can repoint or silence the
 * mirror without editing a profile file.
 *
 * @returns `{ enabled, origin, size, markTrigger, hideOtherMarks }`.
 */
function readConfig() {
  const stored = readJsonFile(configFile())
  const merged = { ...DEFAULT_CONFIG, modelZones: [...DEFAULT_CONFIG.modelZones] }
  if (typeof stored === 'object' && stored !== null) {
    if (typeof stored.enabled === 'boolean') merged.enabled = stored.enabled
    if (typeof stored.origin === 'string' && /^https?:\/\//iu.test(stored.origin)) merged.origin = stored.origin
    if (Number.isFinite(stored.size)) merged.size = Math.min(32, Math.max(10, Math.round(stored.size)))
    if (typeof stored.markTrigger === 'boolean') merged.markTrigger = stored.markTrigger
    if (typeof stored.hideOtherMarks === 'boolean') merged.hideOtherMarks = stored.hideOtherMarks
    if (typeof stored.syncModels === 'boolean') merged.syncModels = stored.syncModels
    if (typeof stored.modelRoute === 'string' && stored.modelRoute.trim() !== '') merged.modelRoute = stored.modelRoute.trim()
    if (typeof stored.modelEntryId === 'string' && stored.modelEntryId.trim() !== '') merged.modelEntryId = stored.modelEntryId.trim()
    if (AUTO_APPLY_MODES.includes(stored.modelAutoApply)) merged.modelAutoApply = stored.modelAutoApply
    if (NAME_SOURCES.includes(stored.modelNameSource)) merged.modelNameSource = stored.modelNameSource
    if (typeof stored.modelOfferOff === 'boolean') merged.modelOfferOff = stored.modelOfferOff
    if (typeof stored.modelKeepUnknown === 'boolean') merged.modelKeepUnknown = stored.modelKeepUnknown
    if (Array.isArray(stored.modelZones)) {
      const zones = stored.modelZones.filter(zone => typeof zone === 'string' && zone.trim() !== '').map(zone => zone.trim())
      if (zones.length > 0) merged.modelZones = zones
    }
    if (typeof stored.apiKeys === 'boolean') merged.apiKeys = stored.apiKeys
    if (typeof stored.collectErrors === 'boolean') merged.collectErrors = stored.collectErrors
    if (typeof stored.uptimeView === 'boolean') merged.uptimeView = stored.uptimeView
    if (isHttpUrl(stored.uptimeEndpoint)) merged.uptimeEndpoint = stored.uptimeEndpoint.trim()
  }
  const origin = process.env[ENV_ORIGIN]
  if (typeof origin === 'string' && /^https?:\/\//iu.test(origin.trim())) merged.origin = origin.trim()
  const disabled = process.env[ENV_DISABLED]
  if (disabled === '1' || disabled === 'true') merged.enabled = false
  const endpoint = process.env[ENV_UPTIME_ENDPOINT]
  if (isHttpUrl(endpoint)) merged.uptimeEndpoint = endpoint.trim()
  // Silencing the reports is a deployment decision, so the environment gets the
  // same absolute say over it that it has over the mirror's origin.
  const noErrors = process.env[ENV_NO_ERRORS]
  if (noErrors === '1' || noErrors === 'true') merged.collectErrors = false
  const noUptime = process.env[ENV_NO_UPTIME]
  if (noUptime === '1' || noUptime === 'true') merged.uptimeView = false
  merged.origin = merged.origin.replace(/\/+$/u, '')
  merged.uptimeEndpoint = merged.uptimeEndpoint.replace(/\/+$/u, '')
  return merged
}

/**
 * Persist the user-editable part of the settings.
 * @param patch - the fields to change.
 * @returns the settings in force after the write.
 */
function writeConfig(patch) {
  const current = readConfig()
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    // A patch that does not mention the origin keeps the one in force: a settings
    // toggle must not quietly repoint the mirror at the default.
    origin: typeof patch.origin === 'string' && /^https?:\/\//iu.test(patch.origin.trim())
      ? patch.origin.trim().replace(/\/+$/u, '')
      : current.origin,
    size: Number.isFinite(patch.size) ? Math.min(32, Math.max(10, Math.round(patch.size))) : current.size,
    markTrigger: typeof patch.markTrigger === 'boolean' ? patch.markTrigger : current.markTrigger,
    hideOtherMarks: typeof patch.hideOtherMarks === 'boolean' ? patch.hideOtherMarks : current.hideOtherMarks,
    syncModels: typeof patch.syncModels === 'boolean' ? patch.syncModels : current.syncModels,
    modelRoute: typeof patch.modelRoute === 'string' && patch.modelRoute.trim() !== ''
      ? patch.modelRoute.trim()
      : current.modelRoute,
    modelEntryId: typeof patch.modelEntryId === 'string' && patch.modelEntryId.trim() !== ''
      ? patch.modelEntryId.trim()
      : current.modelEntryId,
    modelAutoApply: AUTO_APPLY_MODES.includes(patch.modelAutoApply) ? patch.modelAutoApply : current.modelAutoApply,
    modelNameSource: NAME_SOURCES.includes(patch.modelNameSource) ? patch.modelNameSource : current.modelNameSource,
    modelOfferOff: typeof patch.modelOfferOff === 'boolean' ? patch.modelOfferOff : current.modelOfferOff,
    modelKeepUnknown: typeof patch.modelKeepUnknown === 'boolean' ? patch.modelKeepUnknown : current.modelKeepUnknown,
    modelZones: Array.isArray(patch.modelZones)
      && patch.modelZones.every(zone => typeof zone === 'string' && zone.trim() !== '')
      && patch.modelZones.length > 0
      ? patch.modelZones.map(zone => zone.trim())
      : current.modelZones,
    apiKeys: typeof patch.apiKeys === 'boolean' ? patch.apiKeys : current.apiKeys,
    collectErrors: typeof patch.collectErrors === 'boolean' ? patch.collectErrors : current.collectErrors,
    uptimeView: typeof patch.uptimeView === 'boolean' ? patch.uptimeView : current.uptimeView,
    // Same rule as the origin: a patch that does not name a collector keeps the one
    // in force, so a settings toggle cannot quietly repoint the reports. And an
    // address that is not an `http(s)` URL is refused rather than written — a send
    // to a malformed endpoint fails in the background, where nobody would see it.
    uptimeEndpoint: isHttpUrl(patch.uptimeEndpoint)
      ? patch.uptimeEndpoint.trim().replace(/\/+$/u, '')
      : current.uptimeEndpoint,
  }
  writeFileAtomic(configFile(), `${JSON.stringify(next, null, 2)}\n`)
  return readConfig()
}

/**
 * Pull the embedded catalog document out of one of the site's pages.
 *
 * The site renders its model table from a JSON island in the page itself, which
 * is why an unauthenticated reader can be handed the same data the dashboard
 * shows. The island's attributes are matched loosely: the site is free to add
 * one, and the payload is what matters.
 *
 * @param html - the page text.
 * @returns the parsed catalog, or `undefined` when the page carries none.
 */
function parseCatalogIsland(html) {
  const match = /<script[^>]*\bid=["']?rustvy-catalog["']?[^>]*>([\s\S]*?)<\/script>/iu.exec(html)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(match[1])
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.records)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Reduce one raw catalog record to the fields the mirror keeps.
 *
 * The shaping itself lives in `./models.js`, shared with the model-list
 * generator, so one read of the island serves both halves. What stays here is
 * the one thing only this half needs: the icon name is a file name this process
 * will fetch and later serve, so it is matched against one strict shape and
 * dropped when it does not fit, rather than being carried into a URL.
 *
 * @param record - the record as the site publishes it.
 * @returns the mirrored record, or `undefined` when it is unusable.
 */
function mirrorCatalogRecord(record) {
  const mirrored = mirrorRecord(record)
  if (mirrored === undefined) return undefined
  return { ...mirrored, icon: LOGO_NAME.test(mirrored.icon) ? mirrored.icon : '' }
}

/**
 * The mirror's own state: what is cached, how old it is, and what went wrong
 * last. Reported by `/state` and carried along with `/catalog.json`.
 *
 * `lastError` is reserved for the catalog: a logo the origin does not have is an
 * ordinary answer (that vendor's rows fall back to a monogram), not a fault of
 * the mirror, and mixing the two would put a permanent red line on a healthy
 * status page.
 */
const mirror = {
  version: null,
  fetchedAt: null,
  count: 0,
  logos: 0,
  lastError: null,
  lastRoute: null,
  refreshing: false,
  /** Logo names the origin answered 404 for, so a retry is not pointless. */
  absent: new Set(),
  /** Logo names whose fetch really failed, with the reason, for the status page. */
  failures: new Map(),
}

/** In-memory catalog, so a route answer never re-reads the disk. */
let catalog = null

/** In-flight dedupe: one refresh and one fetch per logo at a time. */
let refreshInFlight = null
const logoInFlight = new Map()

/**
 * Load the cached catalog into memory.
 * @returns the cached catalog, or `undefined` when there is none.
 */
function loadCachedCatalog() {
  const stored = readJsonFile(catalogFile())
  if (typeof stored !== 'object' || stored === null || !Array.isArray(stored.records)) {
    catalog = null
    return undefined
  }
  catalog = stored
  mirror.version = stored.version ?? null
  mirror.fetchedAt = typeof stored.fetchedAt === 'string' ? stored.fetchedAt : null
  mirror.count = stored.records.length
  return catalog
}

/**
 * Count the cached logo files, for the status line.
 * @returns how many `.svg` files the cache holds.
 */
function countCachedLogos() {
  try {
    return readdirSync(logosDir()).filter(entry => entry.toLowerCase().endsWith('.svg')).length
  } catch {
    return 0
  }
}

/**
 * Read one logo from the cache.
 * @param logo - a validated file name.
 * @returns the bytes, or `undefined` when the file is absent or unreadable.
 */
function readCachedLogo(logo) {
  const file = join(logosDir(), logo)
  try {
    return statSync(file).isFile() ? readFileSync(file) : undefined
  } catch {
    return undefined
  }
}

/**
 * Decide whether cached bytes really are an SVG document. The origin answers a
 * missing file with its HTML shell, so the content type alone is not enough.
 *
 * @param status - the response status.
 * @param headers - the response headers.
 * @param body - the response bytes.
 * @returns true when the body may be cached as a logo.
 */
function isSvgDocument(status, headers, body) {
  if (status !== 200 || body.length === 0 || body.length > MAX_LOGO_BYTES) return false
  const type = String(headers['content-type'] ?? headers.get?.('content-type') ?? '')
  // Only the *leading* byte-order mark and whitespace are trimmed: some marks
  // start with an XML declaration, and a global whitespace strip would weld
  // `<?xml …?><svg …>` into a string the shape test below cannot read.
  const head = body.subarray(0, 512).toString('utf8').replace(/^\uFEFF/u, '').trimStart()
  const looksLikeSvg = head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg[\s>]/u.test(head))
  return looksLikeSvg && (type === '' || /svg|xml|octet-stream|text\//iu.test(type))
}

/**
 * Fetch one logo from the origin and cache it.
 *
 * @param ctx - the plugin context, for logging.
 * @param logo - a validated file name, `something.svg`.
 * @param config - the settings in force, for the origin.
 * @param options - `{ force: true }` retries a name the origin already answered
 *   404 for.
 * @returns a promise of the cached bytes, or `undefined` when the origin does
 *   not have that logo.
 */
async function fetchLogo(ctx, logo, config, options = {}) {
  const cached = readCachedLogo(logo)
  if (cached !== undefined) return cached
  if (options.force !== true && mirror.absent.has(logo)) return undefined
  const pending = logoInFlight.get(logo)
  if (pending !== undefined) return pending
  const task = (async () => {
    const url = `${config.origin}/logos/${logo}`
    try {
      const result = await getUrl(url, { timeoutMs: ORIGIN_TIMEOUT_MS })
      mirror.lastRoute = result.via
      if (result.status === 404) {
        // An ordinary answer: the site has no mark for that vendor. Remembered so
        // a page that asks for it a hundred times does not fetch a hundred times.
        mirror.absent.add(logo)
        mirror.failures.delete(logo)
        return undefined
      }
      if (!isSvgDocument(result.status, result.headers, result.body)) {
        mirror.failures.set(logo, `HTTP ${result.status}, the answer is not an SVG document`)
        return undefined
      }
      writeFileAtomic(join(logosDir(), logo), result.body)
      mirror.absent.delete(logo)
      mirror.failures.delete(logo)
      mirror.logos = countCachedLogos()
      return result.body
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mirror.failures.set(logo, message)
      log(ctx, 'warn', `не удалось получить ${logo} с ${config.origin}`, error)
      return undefined
    } finally {
      logoInFlight.delete(logo)
    }
  })()
  logoInFlight.set(logo, task)
  return task
}

/**
 * Fetch the catalog from the origin, cache it, and make sure every logo the
 * catalog names is cached too — so the picker's first open does not turn into a
 * burst of origin requests from the browser half.
 *
 * @param ctx - the plugin context, for logging.
 * @param config - the settings in force.
 * @returns a promise of the mirrored catalog, or `undefined` on failure.
 */
async function refreshCatalog(ctx, config) {
  if (refreshInFlight !== null) return refreshInFlight
  mirror.refreshing = true
  // A refresh is the user's way of saying "try again", so both the negative
  // caches go: a vendor the site did not have a mark for yesterday may have one
  // today.
  mirror.absent.clear()
  mirror.failures.clear()
  refreshInFlight = (async () => {
    try {
      let document = null
      let pageUsed = ''
      let lastFailure = ''
      for (const page of CATALOG_PAGES) {
        const url = `${config.origin}${page}`
        try {
          const result = await getUrl(url, { timeoutMs: ORIGIN_TIMEOUT_MS, headers: { accept: 'text/html' } })
          if (result.status !== 200) {
            lastFailure = `${page}: HTTP ${result.status}`
            continue
          }
          const parsed = parseCatalogIsland(result.body.toString('utf8'))
          if (parsed === undefined) {
            lastFailure = `${page}: no catalog island in the page`
            continue
          }
          document = parsed
          pageUsed = page
          mirror.lastRoute = result.via
          break
        } catch (error) {
          lastFailure = `${page}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (document === null) {
        mirror.lastError = `каталог не получен (${lastFailure})`
        log(ctx, 'warn', `catalog refresh failed: ${lastFailure}`)
        return catalog ?? undefined
      }

      const records = document.records.map(mirrorCatalogRecord).filter(record => record !== undefined)
      const payload = {
        version: Number.isFinite(document.version) ? document.version : null,
        origin: config.origin,
        page: pageUsed,
        fetchedAt: new Date().toISOString(),
        via: mirror.lastRoute,
        records,
      }
      writeFileAtomic(catalogFile(), `${JSON.stringify(payload, null, 2)}\n`)
      catalog = payload
      mirror.version = payload.version
      mirror.fetchedAt = payload.fetchedAt
      mirror.count = records.length
      mirror.lastError = null

      // Warm the logo set the catalog names; a missing one is not a failure of
      // the refresh, it just stays absent until the next attempt.
      const logos = [...new Set(records.map(record => record.icon).filter(icon => icon !== ''))]
      await Promise.all(logos.map(logo => fetchLogo(ctx, logo, config)))
      mirror.logos = countCachedLogos()
      log(ctx, 'info', `каталог моделей обновлён: версия ${payload.version ?? '?'}, ${records.length} моделей, ${mirror.logos} иконок (${config.origin}${pageUsed})`)
      return payload
    } finally {
      mirror.refreshing = false
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * The catalog the routes answer with: the memory copy, or the cache loaded from
 * disk. A cold cache is worth waiting for — briefly — because the first answer
 * is what the picker draws from; a merely stale one refreshes in the background
 * and the rows keep the marks they already have.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param options - `{ force: true }` refreshes before answering, without a bound.
 * @returns a promise of the payload the client renders.
 */
async function catalogPayload(ctx, config, options = {}) {
  if (catalog === null) loadCachedCatalog()
  const age = mirror.fetchedAt === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(mirror.fetchedAt)
  if (options.force === true) {
    await refreshCatalog(ctx, config)
  } else if (catalog === null) {
    // Bounded: an unreachable origin must not hang the page, and the client's
    // vendor rules still resolve a model the mirror has never seen.
    await Promise.race([
      refreshCatalog(ctx, config),
      new Promise(resolve => { setTimeout(resolve, COLD_WAIT_MS) }),
    ])
  } else if (age > CATALOG_TTL_MS) {
    void refreshCatalog(ctx, config)
      .then(() => (autoApplies(config, 'background')
        ? modelPlan(ctx, config).then(plan => applyModelPlan(ctx, config, plan))
        : undefined))
      .catch(() => {})
  }
  mirror.logos = countCachedLogos()
  return {
    ok: true,
    enabled: config.enabled,
    config: { size: config.size, markTrigger: config.markTrigger, hideOtherMarks: config.hideOtherMarks, origin: config.origin, apiKeys: config.apiKeys, collectErrors: config.collectErrors, uptimeView: config.uptimeView },
    version: mirror.version,
    fetchedAt: mirror.fetchedAt,
    refreshing: mirror.refreshing,
    count: catalog?.records.length ?? 0,
    logos: mirror.logos,
    records: catalog?.records ?? [],
    ...mirror.lastError === null ? {} : { error: mirror.lastError },
  }
}

/* ------------------------------------------------------------------------- *
 * Model-list synchronization
 *
 * The icon half answers "what does this model look like". This half answers
 * "what models does this provider serve today", and keeps the profile's route
 * list in step with the answer.
 *
 * The route is a hand-declared `@deepseek-ai/dsh-llm-pi-ai` profile: its
 * `models` list *replaces* the route's catalog, and the GUI offers a model only
 * when the route serves it. So the list is the whole story — a model the origin
 * shipped this morning is unpickable until it lands there. The adapter's own
 * endpoint discovery does not help: it answers a form that is drafting a route
 * and stores nothing.
 *
 * What is written is generated, not merged. Membership and capacities follow the
 * origin; the only thing carried forward from the installed entry is a
 * `compat` block, because a wire-compatibility switch is knowledge about the
 * gateway that no catalog can supply.
 * ------------------------------------------------------------------------- */

/** The most recent plan, so `/state` can report drift without a fresh fetch. */
let lastPlan = null

/**
 * The profile's configuration editor, when this composition mounts one.
 *
 * Read through the context's own reflect seam rather than declared as a
 * dependency, and read defensively. `ctx.get(name)` is the accessor Cordis
 * provides for exactly this case — a service read without the inject
 * requirement, answering `undefined` when it is not (yet) provided — so a
 * composition that mounts no editor costs this plugin its write path and nothing
 * else. Declaring it in the entry's inject list instead would be all-or-nothing:
 * a profile without `config-editor` would leave the whole plugin, marks
 * included, permanently waiting on a service that never arrives.
 *
 * @param ctx - the plugin context.
 * @returns the editor, or `undefined` when there is nothing to write through.
 */
function configEditorOf(ctx) {
  return serviceOf(ctx, 'configEditor', editor => (typeof editor?.edit === 'function' && typeof editor?.entries === 'function' ? editor : undefined))
}

/**
 * Read one service off the context without declaring it as a dependency.
 *
 * `ctx.get(name)` is the accessor Cordis provides for exactly this case — a
 * service read without the inject requirement, answering `undefined` when it is
 * not (yet) provided. A context that refuses an undeclared read is asked through
 * its reflect seam and then through the plain property, and a composition that
 * mounts the service under none of the three costs this plugin that one
 * capability and nothing else.
 *
 * @param ctx - the plugin context.
 * @param key - the service name.
 * @param usable - predicate that recognises the real service.
 * @returns the service, or `undefined` when there is nothing to use.
 */
function serviceOf(ctx, key, usable) {
  const attempts = [
    () => (typeof ctx?.get === 'function' ? ctx.get(key) : undefined),
    () => (typeof ctx?.reflect?.get === 'function' ? ctx.reflect.get(key) : undefined),
    () => ctx?.[key],
  ]
  for (const attempt of attempts) {
    try {
      const service = usable(attempt())
      if (service !== undefined) return service
    } catch {
      // A context that refuses an undeclared read simply has nothing to offer.
    }
  }
  return undefined
}

/**
 * The harness credential store, when this composition mounts one.
 *
 * This is where a key *value* lives: `set` writes it into
 * `$DSH_HOME/.credentials.yaml` under `refs`, which is the same place the
 * adapter's own `apiKeyEnv` resolution reads and the same place the harness
 * Models page writes to. The plugin's own files carry names and labels, never a
 * secret.
 *
 * @param ctx - the plugin context.
 * @returns the credential service, or `undefined` when keys cannot be stored.
 */
function credentialsOf(ctx) {
  return serviceOf(ctx, 'credentials', service => (typeof service?.resolve === 'function' && typeof service?.set === 'function' ? service : undefined))
}

/**
 * The profile's own patch document, when this composition publishes one.
 *
 * Read to be *named*, not written: the settings page shows the file a manual
 * edit belongs in, and every write this half performs goes through
 * `configEditor`, which owns the document, its comments and its atomic replace.
 *
 * @param ctx - the plugin context.
 * @returns the patch file path, or `undefined` when it is not published.
 */
function patchPathOf(ctx) {
  try {
    const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : ctx?.profileContext
    const path = profile?.patchPath
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * The loader entry whose config carries the route.
 *
 * Found by its patch id first, because that is what a profile author wrote and
 * what `configEditor.entries()` addresses; the adapter's package name and the
 * mere presence of the route are fallbacks for a profile that named the row
 * differently.
 *
 * @param editor - the configuration editor.
 * @param config - the settings in force, for the entry id and route name.
 * @returns the entry, or `undefined` when the profile has no such row.
 */
function findRouteEntry(editor, config) {
  let entries = []
  try {
    entries = editor.entries()
  } catch {
    return undefined
  }
  const owns = entry => {
    const providers = entry?.options?.config?.providers
    return typeof providers?.[config.modelRoute] === 'object' && providers[config.modelRoute] !== null
  }
  return entries.find(entry => entry?.options?.id === config.modelEntryId && owns(entry))
    ?? entries.find(entry => entry?.options?.id === config.modelEntryId)
    ?? entries.find(entry => entry?.options?.name === PI_AI_PACKAGE && owns(entry))
    ?? entries.find(owns)
}

/**
 * Read the models the route's own endpoint serves.
 *
 * This is the authoritative membership list: it is the same URL the adapter's
 * discovery interrogates, and it answers with exactly the models a request may
 * name. A key is attached only when the process already holds one under the
 * name the route's `apiKeyEnv` declares, and it is never logged.
 *
 * @param ctx - the plugin context, for logging.
 * @param providerConfig - the installed route profile, for `apiKeyEnv`.
 * @param baseURL - the route's endpoint root.
 * @returns a promise of `{ served, error }`.
 */
async function fetchServed(ctx, providerConfig, baseURL) {
  const url = `${baseURL.replace(/\/+$/u, '')}/models`
  const headers = { accept: 'application/json' }
  const reference = typeof providerConfig?.apiKeyEnv === 'string' ? providerConfig.apiKeyEnv.trim() : ''
  const secret = reference === '' ? undefined : process.env[reference]
  if (typeof secret === 'string' && secret !== '') headers.authorization = `Bearer ${secret}`
  try {
    const result = await getUrl(url, { timeoutMs: ORIGIN_TIMEOUT_MS, headers })
    mirror.lastRoute = result.via
    if (result.status !== 200) return { served: [], error: `${url}: HTTP ${result.status}` }
    const served = normalizeServedList(JSON.parse(result.body.toString('utf8')))
    if (served.length === 0) return { served: [], error: `${url}: в ответе нет ни одной модели` }
    return { served, error: null }
  } catch (error) {
    log(ctx, 'warn', `список моделей с ${url} не получен`, error)
    return { served: [], error: `${url}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Build the list this route should serve, and how it differs from the installed
 * one. Nothing here writes: a plan is safe to compute as often as a page asks.
 *
 * When the endpoint does not answer, the mirrored island decides membership
 * instead — its enabled standard-zone records are the same set on a healthy
 * origin, so a route stays current through an endpoint outage rather than
 * freezing at its last successful read.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param options - `{ skipFetch }` reuses the mirror and makes no request.
 * @returns a promise of the plan: `{ available, entryId, route, baseURL, source,
 *   count, installedCount, entries, notes, kept, diff, attemptedAt, error? }`.
 */
async function modelPlan(ctx, config, options = {}) {
  const editor = configEditorOf(ctx)
  const entry = editor === undefined ? undefined : findRouteEntry(editor, config)
  const providerConfig = entry?.options?.config?.providers?.[config.modelRoute]
  const baseURL = typeof providerConfig?.baseURL === 'string' && providerConfig.baseURL.trim() !== ''
    ? providerConfig.baseURL.trim()
    : `${config.origin}/v1`
  const installed = Array.isArray(providerConfig?.models) ? providerConfig.models : []
  if (catalog === null) loadCachedCatalog()
  let records = catalog?.records ?? []

  let served = []
  let source = 'none'
  let error = null
  if (options.skipFetch !== true) {
    const read = await fetchServed(ctx, providerConfig, baseURL)
    served = read.served
    error = read.error
    if (served.length > 0) source = 'endpoint'
    // A model the endpoint serves and the mirror has never seen is the signal
    // that the island is behind the wire — which is exactly when a release lands,
    // and exactly when the label and the logo matter most. Re-read the island
    // then, bounded, so a page never hangs on it and a cold origin costs at most
    // one short wait.
    const known = new Set(records.map(record => record.id))
    if (served.some(model => !known.has(model.id))) {
      await Promise.race([
        refreshCatalog(ctx, config).catch(() => {}),
        new Promise(resolve => { setTimeout(resolve, COLD_WAIT_MS) }),
      ])
      records = catalog?.records ?? []
    }
  }
  if (served.length === 0) {
    served = servedFromCatalog(records, { zones: config.modelZones })
    if (served.length > 0) source = options.skipFetch === true ? 'mirror' : 'catalog'
  }

  const built = buildModelEntries(served, records, installed, {
    nameSource: config.modelNameSource,
    offerOff: config.modelOfferOff,
    keepUnknown: config.modelKeepUnknown,
  })
  // The connection fields the route already carries, without the list this half
  // regenerates: they are what the YAML fallback has to preserve, and what the
  // settings page shows so a manual edit changes one field rather than all.
  const providerFields = { ...(providerConfig ?? {}) }
  delete providerFields.models

  // Every route this plugin's key ring owns carries the same generated list: a
  // chat that sends its requests with another key must be able to name the same
  // models, and a clone whose list lags behind the base is a clone that fails on
  // the request rather than on the picker.
  const providers = entry?.options?.config?.providers ?? {}
  const keyRoutes = routesToSync(providers, ringOf(ctx, config), config.modelRoute).slice(1).map(route => {
    const fields = { ...(providers[route] ?? {}) }
    const models = Array.isArray(fields.models) ? fields.models : []
    delete fields.models
    return { route, providerFields: fields, models }
  })

  lastPlan = {
    available: editor !== undefined,
    entryId: entry?.options?.id ?? null,
    packageName: entry?.options?.name ?? PI_AI_PACKAGE,
    route: config.modelRoute,
    baseURL,
    modelsUrl: `${baseURL.replace(/\/+$/u, '')}/models`,
    providerFields,
    keyRoutes,
    source,
    attemptedAt: new Date().toISOString(),
    count: built.entries.length,
    installedCount: installed.length,
    entries: built.entries,
    notes: built.notes,
    kept: built.kept,
    diff: diffModels(installed, built.entries),
    ...error === null ? {} : { error },
  }
  return lastPlan
}

/**
 * The provider map a generated list is written into.
 *
 * The base route gets the list, and every clone the key ring owns gets it too —
 * as an exact copy of the base profile with its own `apiKeyEnv` and display name,
 * which is what `syncRingRoutes` produces. One write therefore keeps every key's
 * route as current as the route the profile names, and a chat that sends its
 * requests with another key never sees a shorter model list than its neighbour.
 *
 * @param current - the installed configuration of the route's entry.
 * @param plan - the plan `modelPlan` built.
 * @param config - the settings in force.
 * @param doc - the key ring.
 * @returns the providers map to persist.
 */
function providersWithModels(current, plan, config, doc) {
  const providers = { ...(current?.providers ?? {}) }
  // Without the base route there is nothing to clone and nothing to write: a
  // profile whose row disappeared between the plan and the edit is left exactly
  // as the editor found it rather than gaining a half-declared provider.
  if (typeof providers[config.modelRoute] !== 'object' || providers[config.modelRoute] === null) return providers
  providers[config.modelRoute] = {
    ...providers[config.modelRoute],
    models: structuredClone(plan.entries),
  }
  return syncRingRoutes(providers, doc, config.modelRoute).providers
}

/**
 * Whether every key route already carries the list this plan generated.
 *
 * The base route's own drift is `plan.diff`; this is the rest of the answer to
 * "is a write needed", so an up-to-date base with a lagging clone is still a
 * write worth spending a reconciliation on.
 *
 * @param plan - the plan `modelPlan` built.
 * @returns true when no clone differs.
 */
function clonesInStep(plan) {
  const want = JSON.stringify(plan.entries)
  return (plan.keyRoutes ?? []).every(route => JSON.stringify(route.models) === want)
}

/**
 * Write a plan into the route profile.
 *
 * Two refusals are deliberate. An empty list is never written, because the only
 * way to get one is a failed read and a route with no models serves nothing. And
 * an up-to-date list is not written either: `configEditor.edit()` reconciles the
 * whole loader, so spending one on a no-op would reload a live profile for
 * nothing.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param plan - the plan to write, as `modelPlan` built it.
 * @returns a promise of `{ ok, applied, ... }`.
 */
async function applyModelPlan(ctx, config, plan) {
  if (!plan.available) {
    return { ok: false, applied: false, error: 'хост не отдаёт configEditor — список моделей не записать' }
  }
  if (plan.count === 0) {
    return {
      ok: false,
      applied: false,
      error: `список моделей пуст${plan.error === undefined ? '' : ` (${plan.error})`} — установленный оставлен как есть`,
    }
  }
  if (plan.diff.upToDate && clonesInStep(plan)) {
    return { ok: true, applied: false, upToDate: true, count: plan.count, diff: plan.diff }
  }
  const editor = configEditorOf(ctx)
  const entry = editor === undefined ? undefined : findRouteEntry(editor, config)
  if (entry === undefined) {
    return {
      ok: false,
      applied: false,
      error: `в профиле нет строки «${config.modelEntryId}» с маршрутом «${config.modelRoute}»`,
    }
  }

  // Captured inside the change callback, so the backup is the document the
  // editor is actually replacing rather than a copy read a moment earlier.
  let previous = null
  try {
    await editor.edit(entry, current => {
      previous = structuredClone(current ?? {})
      return { ...(current ?? {}), providers: providersWithModels(current, plan, config, ringOf(ctx, config)) }
    })
  } catch (error) {
    log(ctx, 'error', 'список моделей не записался', error)
    return { ok: false, applied: false, error: error instanceof Error ? error.message : String(error) }
  }
  routesCache.at = 0

  try {
    writeFileAtomic(modelsBackupFile(), `${JSON.stringify({
      at: new Date().toISOString(),
      entryId: config.modelEntryId,
      route: config.modelRoute,
      config: previous,
    }, null, 2)}\n`)
  } catch (error) {
    log(ctx, 'warn', 'не удалось сохранить предыдущий список моделей', error)
  }
  log(ctx, 'info', `маршрут ${config.modelRoute}: список моделей обновлён — добавлено ${plan.diff.added.length}, убрано ${plan.diff.removed.length}, изменено ${plan.diff.changed.length}, всего ${plan.count}${plan.keyRoutes.length > 0 ? `, маршрутов ключей записано ${plan.keyRoutes.length}` : ''}`)
  // The plan describes a state that no longer exists. Drop it, so the next
  // status read recomputes against what is installed now instead of reporting
  // the drift this write just resolved.
  lastPlan = null
  return { ok: true, applied: true, count: plan.count, diff: plan.diff, backup: modelsBackupFile() }
}

/**
 * Put the previous route profile back.
 *
 * The state this displaces becomes the next backup, so a revert is itself
 * revertible rather than a one-way door.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns a promise of `{ ok, reverted, ... }`.
 */
async function revertModels(ctx, config) {
  const backup = readJsonFile(modelsBackupFile())
  if (typeof backup?.config !== 'object' || backup.config === null) {
    return { ok: false, reverted: false, error: 'нет сохранённой копии — откатывать нечего' }
  }
  const editor = configEditorOf(ctx)
  const entry = editor === undefined ? undefined : findRouteEntry(editor, config)
  if (entry === undefined) {
    return { ok: false, reverted: false, error: `в профиле нет строки «${config.modelEntryId}»` }
  }
  let displaced = null
  try {
    await editor.edit(entry, current => {
      displaced = structuredClone(current ?? {})
      return structuredClone(backup.config)
    })
  } catch (error) {
    log(ctx, 'error', 'откат списка моделей не удался', error)
    return { ok: false, reverted: false, error: error instanceof Error ? error.message : String(error) }
  }
  routesCache.at = 0
  try {
    writeFileAtomic(modelsBackupFile(), `${JSON.stringify({
      at: new Date().toISOString(),
      entryId: config.modelEntryId,
      route: config.modelRoute,
      config: displaced,
      revertedFrom: typeof backup.at === 'string' ? backup.at : null,
    }, null, 2)}\n`)
  } catch (error) {
    log(ctx, 'warn', 'не удалось сохранить состояние до отката', error)
  }
  log(ctx, 'info', `маршрут ${config.modelRoute}: список моделей откачен к состоянию на ${backup.at ?? '?'}`)
  lastPlan = null
  return { ok: true, reverted: true, from: typeof backup.at === 'string' ? backup.at : null }
}

/**
 * Whether a catalog refresh of this kind may write the model list on its own.
 *
 * The default is `explicit`: a button press is a decision, a background
 * expiry is not. Rewriting a live profile's loader config while nobody asked is
 * the kind of surprise worth an opt-in.
 *
 * @param config - the settings in force.
 * @param trigger - `'explicit'` for a user action, `'background'` for a timer.
 * @returns true when the refresh may apply what it finds.
 */
function autoApplies(config, trigger) {
  if (!config.syncModels) return false
  if (config.modelAutoApply === 'always') return true
  if (config.modelAutoApply === 'explicit') return trigger === 'explicit'
  return false
}

/**
 * A plan reduced to what a route answer carries.
 *
 * Kept separate from the plan itself so the in-memory object stays free to hold
 * anything, and so every route reports the drift in one shape.
 *
 * @param plan - the plan `modelPlan` built.
 * @returns the JSON-safe summary the browser half draws.
 */
function describePlan(plan) {
  return {
    available: plan.available,
    entryId: plan.entryId,
    packageName: plan.packageName,
    route: plan.route,
    baseURL: plan.baseURL,
    modelsUrl: plan.modelsUrl,
    providerFields: plan.providerFields,
    source: plan.source,
    attemptedAt: plan.attemptedAt,
    count: plan.count,
    installedCount: plan.installedCount,
    upToDate: plan.diff.upToDate,
    added: plan.diff.added,
    removed: plan.diff.removed,
    changed: plan.diff.changed,
    notes: plan.notes,
    kept: plan.kept,
    entries: plan.entries,
    keyRoutes: (plan.keyRoutes ?? []).map(clone => ({
      route: clone.route,
      count: clone.models.length,
      inStep: JSON.stringify(clone.models) === JSON.stringify(plan.entries),
    })),
    backup: existsSync(modelsBackupFile()) ? readJsonFile(modelsBackupFile())?.at ?? null : null,
    ...plan.error === undefined ? {} : { error: plan.error },
  }
}

/**
 * The patch row a profile author can paste by hand.
 *
 * Same bytes the automatic write would have produced, so the two paths cannot
 * disagree: whoever prefers to edit `cordis.patch.yml` themselves is not
 * transcribing a summary of what the plugin does.
 *
 * @param plan - the plan to render.
 * @returns the row as YAML text.
 */
function planYaml(plan) {
  return providersPatchYaml({
    entryId: plan.entryId ?? 'llm-pi-ai',
    packageName: plan.packageName ?? PI_AI_PACKAGE,
    providers: [
      { key: plan.route, provider: plan.providerFields, models: plan.entries },
      // The key ring's clones belong in the pasteable block too: whoever edits
      // the row by hand should not have to reconstruct them from a description.
      ...(plan.keyRoutes ?? []).map(clone => ({
        key: clone.route,
        provider: clone.providerFields,
        models: plan.entries,
      })),
    ],
  })
}

/* ------------------------------------------------------------------------- *
 * The API-key ring
 *
 * Several provider keys in one profile, and one chat sending its requests with
 * the key its user picked.
 *
 * The adapter has no per-request credential: it reads `profile.apiKeyEnv` — a
 * reference name — through the harness credentials service on every call, and
 * neither the call configuration nor the generate options carry a key. So one
 * route is one key, and "this chat uses that key" is "this chat's request names
 * that route". Adding a key stores the value under a new reference, clones the
 * base route with the same endpoint and the same generated model list, and
 * remembers the pick per chat; the pick is applied on the `agent/request`
 * waterfall, which is the seam the harness itself uses to apply a per-chat model
 * choice.
 *
 * The swap is deliberately narrow: it fires only for a route this ring owns, so
 * an account-authenticated provider — the built-in DeepSeek account among them —
 * is never rewritten, and a clone that is missing or short of the model is
 * reported rather than used, so a request never fails because of a key.
 * ------------------------------------------------------------------------- */

/** The ring in memory, and the base route it was derived from. */
let ring = null
let ringRoute = null

/** Which chat picked which key: `sessionId → keyId`. */
let picks = new Map()

/** Whether the picks have been read from disk in this revision. */
let picksLoaded = false

/** The last request a key route could not serve, for the settings page. */
let lastKeyFallback = null

/**
 * What the swap has done since this revision loaded.
 *
 * `seen` counts every request the waterfall handed this half, which is how a
 * composition that never dispatches it — or a plugin mounted without events — is
 * told apart from a ring that simply has nothing to swap. `applied` counts the
 * requests that were renamed to a key's route.
 */
const routing = { seen: 0, applied: 0 }

/** Installed provider routes, briefly cached: the swap reads it per request. */
let routesCache = { at: 0, routes: new Set(), providers: {} }

/** How long the installed-route cache is trusted, in milliseconds. */
const ROUTES_TTL_MS = 5000

/** One configuration write at a time: two keys added at once is one edit each. */
let keyWrite = Promise.resolve()

/**
 * Serialize the ring's configuration writes.
 *
 * `configEditor.edit()` reconciles the whole loader, so two overlapping writes
 * would each reconcile against a document the other had just replaced.
 *
 * @param task - the write to run.
 * @returns a promise of its result.
 */
function withKeyWrite(task) {
  const run = keyWrite.then(task, task)
  keyWrite = run.then(() => {}, () => {})
  return run
}

/**
 * The ring in force: what is on disk, with the primary key derived from the
 * route the profile actually declares.
 *
 * The profile wins over the document, because the profile is what the adapter
 * reads: a ring that disagreed with it would send a chat's requests with a key
 * nobody chose.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns the normalized ring document.
 */
function ringOf(ctx, config) {
  const provider = baseProviderOf(ctx, config)
  // Cached only while the base route is readable: the primary key's reference
  // comes from that route's own `apiKeyEnv`, and a ring derived before the
  // configuration editor arrived would carry a guessed name for it.
  if (ring !== null && ringRoute === config.modelRoute && provider !== undefined) return ring
  const doc = withPrimaryKey(readRing(readJsonFile(keysFile())), provider, config.modelRoute)
  if (provider !== undefined) {
    ring = doc
    ringRoute = config.modelRoute
  }
  if (!picksLoaded) {
    picks = readPicks(readJsonFile(picksFile()), doc)
    picksLoaded = true
  } else {
    prunePicks(doc)
  }
  return doc
}

/** Persist the ring's metadata. Never a secret: values live in the credential store. */
function saveRing(doc) {
  ring = doc
  writeFileAtomic(keysFile(), writeRing(doc))
}

/** Persist the per-chat picks. */
function savePicks() {
  writeFileAtomic(picksFile(), writePicks(picks))
}

/**
 * Drop picks that name a key the ring no longer has.
 * @param doc - the ring.
 * @returns true when a pick was dropped.
 */
function prunePicks(doc) {
  const known = new Set(doc.keys.map(key => key.id))
  let dropped = false
  for (const [sessionId, keyId] of picks) {
    if (!known.has(keyId)) {
      picks.delete(sessionId)
      dropped = true
    }
  }
  return dropped
}

/**
 * What the profile's route entry holds right now.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns `{ entry, providers }`, both `undefined`/empty without an editor.
 */
function installedOf(ctx, config) {
  const editor = configEditorOf(ctx)
  const entry = editor === undefined ? undefined : findRouteEntry(editor, config)
  return { editor, entry, providers: entry?.options?.config?.providers ?? {} }
}

/**
 * The installed provider routes, from the cache when it is fresh.
 *
 * The swap asks this on every request, and the answer changes only when a
 * configuration write lands — which is why every write here resets it.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns `{ routes, providers }`.
 */
function installedRoutes(ctx, config) {
  const now = Date.now()
  if (now - routesCache.at < ROUTES_TTL_MS) return routesCache
  const { providers } = installedOf(ctx, config)
  routesCache = { at: now, routes: new Set(Object.keys(providers)), providers }
  return routesCache
}

/**
 * The base route's installed profile.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns the profile, or `undefined` when the profile has no such route.
 */
function baseProviderOf(ctx, config) {
  return installedRoutes(ctx, config).providers[config.modelRoute]
}

/**
 * The first ordinal whose reference and route are both free.
 *
 * A removed key leaves its reference behind in the credential store until it is
 * unset, and a hand-written row may already sit on the name this ring would
 * invent, so the next key steps over both rather than replacing either.
 *
 * @param doc - the ring.
 * @param providers - the installed provider map.
 * @param baseRef - the base route's `apiKeyEnv`.
 * @param baseRoute - the base route key.
 * @returns an ordinal of 2 or more.
 */
function freeOrdinal(doc, providers, baseRef, baseRoute) {
  const takenRefs = new Set(doc.keys.map(key => key.ref))
  const takenRoutes = new Set(Object.keys(providers))
  for (let ordinal = 2; ordinal <= MAX_KEYS + doc.keys.length + 2; ordinal += 1) {
    if (!takenRefs.has(refFor(baseRef, ordinal)) && !takenRoutes.has(routeFor(baseRoute, ordinal))) return ordinal
  }
  return doc.nextOrdinal
}

/**
 * Make the profile's provider map match the ring.
 *
 * One `configEditor.edit()`, and none at all when the map already matches: a
 * reconciliation reloads a live profile, and spending one on a no-op is exactly
 * what the model-list write refuses to do.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param doc - the ring the profile should match.
 * @param reason - what the write is for, for the log line and the backup.
 * @returns a promise of `{ ok, added, removed, updated }` or `{ ok: false, error }`.
 */
async function ensureRingRoutes(ctx, config, doc, reason) {
  const { editor, entry, providers } = installedOf(ctx, config)
  if (editor === undefined) {
    return { ok: false, error: 'хост не отдаёт configEditor — маршрут для ключа не добавить' }
  }
  if (entry === undefined) {
    return { ok: false, error: `в профиле нет строки «${config.modelEntryId}» с маршрутом «${config.modelRoute}»` }
  }
  const wanted = syncRingRoutes(providers, doc, config.modelRoute)
  if (wanted.error !== undefined) return { ok: false, error: wanted.error }
  if (!wanted.changed) {
    routesCache.at = 0
    return { ok: true, added: [], removed: [], updated: [], skipped: true }
  }
  let previous = null
  try {
    await withKeyWrite(() => editor.edit(entry, current => {
      previous = structuredClone(current ?? {})
      const again = syncRingRoutes(current?.providers ?? {}, doc, config.modelRoute)
      if (!again.changed) return current ?? {}
      return { ...(current ?? {}), providers: again.providers }
    }))
  } catch (error) {
    log(ctx, 'error', `маршруты ключей не записались (${reason})`, error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  routesCache.at = 0
  lastPlan = null
  try {
    writeFileAtomic(modelsBackupFile(), `${JSON.stringify({
      at: new Date().toISOString(),
      entryId: config.modelEntryId,
      route: config.modelRoute,
      reason,
      config: previous,
    }, null, 2)}\n`)
  } catch (error) {
    log(ctx, 'warn', 'не удалось сохранить профиль маршрутов до правки ключей', error)
  }
  log(ctx, 'info', `маршруты ключей (${reason}): добавлено ${wanted.added.length}, убрано ${wanted.removed.length}, обновлено ${wanted.updated.length}`)
  return { ok: true, added: wanted.added, removed: wanted.removed, updated: wanted.updated }
}

/**
 * Read one key's value from the credential store, for a mask and a fingerprint.
 *
 * The value never leaves this process: what a route answers with is the masked
 * form and an eight-character digest, which is enough to recognise a key and to
 * notice that two entries hold the same one.
 *
 * @param ctx - the plugin context.
 * @param ref - the credential reference name.
 * @returns a promise of the value, or `undefined`.
 */
async function keyValueOf(ctx, ref) {
  const credentials = credentialsOf(ctx)
  if (credentials === undefined) return undefined
  try {
    const resolved = await credentials.resolve(ref)
    return typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : undefined
  } catch {
    return undefined
  }
}

/**
 * The ring as the browser half draws it.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns a promise of the `/keys` payload.
 */
async function describeRing(ctx, config) {
  const doc = ringOf(ctx, config)
  const credentials = credentialsOf(ctx)
  const { editor, entry, providers } = installedOf(ctx, config)
  const base = providers[config.modelRoute]
  const baseURL = typeof base?.baseURL === 'string' && base.baseURL.trim() !== ''
    ? base.baseURL.trim()
    : `${config.origin}/v1`
  const counts = pickCounts(picks)
  const baseModels = JSON.stringify(base?.models ?? [])
  const keys = []
  for (const key of doc.keys) {
    const value = await keyValueOf(ctx, key.ref)
    const profile = providers[key.route]
    keys.push(describeKey(key, {
      value,
      present: value !== undefined,
      sessions: counts.get(key.id) ?? 0,
      displayName: typeof profile?.displayName === 'string' ? profile.displayName : key.label,
      installed: profile !== undefined,
      models: Array.isArray(profile?.models) ? profile.models.length : 0,
    }))
  }
  return {
    ok: true,
    enabled: config.apiKeys === true,
    credentials: credentials !== undefined,
    editor: editor !== undefined,
    route: config.modelRoute,
    entryId: entry?.options?.id ?? config.modelEntryId,
    packageName: entry?.options?.name ?? PI_AI_PACKAGE,
    baseURL,
    modelsUrl: `${baseURL.replace(/\/+$/u, '')}/models`,
    defaultKeyId: doc.defaultKeyId,
    maxKeys: MAX_KEYS,
    keys,
    // What the picker hides: a clone is a key, not a provider, and its model list
    // is the base route's list again.
    hiddenGroups: doc.keys
      .filter(key => key.primary !== true)
      .map(key => providers[key.route]?.displayName ?? displayNameFor(config.modelRoute, key.ordinal, key.label)),
    routes: {
      missing: doc.keys.filter(key => key.primary !== true && providers[key.route] === undefined).map(key => key.route),
      // A clone whose model list differs from the base route's is a clone that
      // will refuse a model the picker offers, so it is reported as drift rather
      // than discovered by a failed step.
      stale: doc.keys
        .filter(key => key.primary !== true
          && providers[key.route] !== undefined
          && JSON.stringify(providers[key.route].models ?? []) !== baseModels)
        .map(key => key.route),
    },
    picks: picks.size,
    routing: { seen: routing.seen, applied: routing.applied },
    paths: { keys: keysFile(), picks: picksFile() },
    fallback: lastKeyFallback,
  }
}

/**
 * The ring in brief, for the status page.
 *
 * Synchronous and secret-free on purpose: `/state` is read often and answers
 * without a credential lookup, so it reports counts and route drift rather than
 * masks.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns the summary.
 */
function ringSummary(ctx, config) {
  try {
    const doc = ringOf(ctx, config)
    const installed = installedRoutes(ctx, config)
    return {
      enabled: config.apiKeys === true,
      credentials: credentialsOf(ctx) !== undefined,
      editor: configEditorOf(ctx) !== undefined,
      count: doc.keys.length,
      defaultKeyId: doc.defaultKeyId,
      routes: doc.keys.filter(key => key.primary !== true).map(key => key.route),
      missing: doc.keys.filter(key => key.primary !== true && !installed.routes.has(key.route)).map(key => key.route),
      picks: picks.size,
      routing: { seen: routing.seen, applied: routing.applied },
      fallback: lastKeyFallback,
    }
  } catch {
    return { enabled: false, credentials: false, editor: false, count: 0, routes: [], missing: [], picks: 0 }
  }
}

/**
 * Add one key: store the value, clone the route, remember the entry.
 *
 * The order matters. The value is stored first, because a route whose reference
 * resolves to nothing fails every request that names it; the configuration write
 * comes second, and if it fails the value is taken back out, so a failed add
 * leaves nothing behind. The ring document is written last, once both exist.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param body - `{ key, label? }`.
 * @returns a promise of `{ ok, added }` or `{ ok: false, error }`.
 */
async function addKey(ctx, config, body) {
  const credentials = credentialsOf(ctx)
  if (credentials === undefined) {
    return { ok: false, error: 'хост не отдаёт сервис credentials — значение ключа негде хранить' }
  }
  const checked = checkKeyValue(body?.key)
  if (!checked.ok) return { ok: false, error: checked.error }
  const doc = ringOf(ctx, config)
  if (doc.keys.length >= MAX_KEYS) return { ok: false, error: `больше ${MAX_KEYS} ключей этот плагин не держит` }
  const { providers } = installedOf(ctx, config)
  const base = providers[config.modelRoute]
  if (typeof base !== 'object' || base === null) {
    return { ok: false, error: `в профиле нет маршрута «${config.modelRoute}» — клонировать нечего` }
  }
  const baseRef = typeof base.apiKeyEnv === 'string' && base.apiKeyEnv.trim() !== '' ? base.apiKeyEnv.trim() : 'RUSTVY_API_KEY'
  const draft = { ...doc, keys: [...doc.keys] }
  const entry = newKeyEntry(draft, {
    baseRef,
    baseRoute: config.modelRoute,
    label: body?.label,
    ordinal: freeOrdinal(doc, providers, baseRef, config.modelRoute),
  })
  if (doc.keys.some(key => key.ref === entry.ref)) {
    return { ok: false, error: `ключ с именем «${entry.ref}» уже есть в кольце` }
  }
  try {
    await credentials.set(entry.ref, checked.value)
  } catch (error) {
    log(ctx, 'error', `ключ ${entry.ref} не записался в хранилище учётных данных`, error)
    return { ok: false, error: `хранилище учётных данных отказало: ${error instanceof Error ? error.message : String(error)}` }
  }
  const next = { ...draft, keys: [...draft.keys, entry], defaultKeyId: draft.defaultKeyId ?? entry.id }
  const routed = await ensureRingRoutes(ctx, config, next, `ключ «${entry.label}»`)
  if (!routed.ok) {
    try {
      await credentials.unset(entry.ref)
    } catch {
      // A value left behind under a fresh name is inert; the ring does not list it.
    }
    return routed
  }
  saveRing(next)
  log(ctx, 'info', `добавлен ключ «${entry.label}» (${entry.ref} → маршрут ${entry.route})`)
  return { ok: true, added: entry.id, routes: routed }
}

/**
 * Replace one key's value.
 *
 * The reference does not move, so the route needs no rewrite and the change
 * reaches the next request: the adapter resolves its credential per call.
 *
 * @param ctx - the plugin context.
 * @param body - `{ id, key }`.
 * @returns a promise of `{ ok, updated }` or `{ ok: false, error }`.
 */
async function setKeyValue(ctx, body) {
  const credentials = credentialsOf(ctx)
  if (credentials === undefined) return { ok: false, error: 'хост не отдаёт сервис credentials — значение ключа негде хранить' }
  const checked = checkKeyValue(body?.key)
  if (!checked.ok) return { ok: false, error: checked.error }
  const doc = ringOf(ctx, readConfig())
  const key = doc.keys.find(candidate => candidate.id === body?.id)
  if (key === undefined) return { ok: false, error: 'такого ключа в кольце нет' }
  try {
    await credentials.set(key.ref, checked.value)
  } catch (error) {
    return { ok: false, error: `хранилище учётных данных отказало: ${error instanceof Error ? error.message : String(error)}` }
  }
  log(ctx, 'info', `значение ключа «${key.label}» заменено (${key.ref})`)
  return { ok: true, updated: key.id }
}

/**
 * Rename one key.
 *
 * A label is metadata, so this writes no configuration and touches no secret —
 * but the clone's display name follows the label, which is what the picker hides
 * by, so the route is refreshed too.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param body - `{ id, label }`.
 * @returns a promise of `{ ok, updated }` or `{ ok: false, error }`.
 */
async function renameKey(ctx, config, body) {
  const doc = ringOf(ctx, config)
  const key = doc.keys.find(candidate => candidate.id === body?.id)
  if (key === undefined) return { ok: false, error: 'такого ключа в кольце нет' }
  const next = {
    ...doc,
    keys: doc.keys.map(candidate => (candidate.id === key.id
      ? { ...candidate, label: normalizeLabel(body?.label, candidate.label) }
      : candidate)),
  }
  if (!key.primary) {
    const routed = await ensureRingRoutes(ctx, config, next, `название ключа «${next.keys.find(candidate => candidate.id === key.id).label}»`)
    if (!routed.ok) return routed
  }
  saveRing(next)
  return { ok: true, updated: key.id }
}

/**
 * Remove one key: its route, its stored value, and every chat's pick of it.
 *
 * The primary key is refused. It owns the route the profile itself names and the
 * reference that route was configured with, so removing it would not remove a key
 * — it would break the provider for every chat, including the ones that never
 * used the ring. Its value can be replaced instead.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param body - `{ id }`.
 * @returns a promise of `{ ok, removed, sessions }` or `{ ok: false, error }`.
 */
async function removeKey(ctx, config, body) {
  const doc = ringOf(ctx, config)
  const key = doc.keys.find(candidate => candidate.id === body?.id)
  if (key === undefined) return { ok: false, error: 'такого ключа в кольце нет' }
  if (key.primary === true) {
    return { ok: false, error: 'основной ключ принадлежит маршруту профиля: удалить его нельзя, можно заменить значение' }
  }
  const next = { ...doc, keys: doc.keys.filter(candidate => candidate.id !== key.id) }
  next.defaultKeyId = next.defaultKeyId === key.id
    ? (next.keys.find(candidate => candidate.primary)?.id ?? next.keys[0]?.id ?? null)
    : next.defaultKeyId
  const routed = await ensureRingRoutes(ctx, config, next, `удаление ключа «${key.label}»`)
  if (!routed.ok) return routed
  saveRing(next)
  const credentials = credentialsOf(ctx)
  if (credentials !== undefined) {
    try {
      await credentials.unset(key.ref)
    } catch (error) {
      log(ctx, 'warn', `значение ключа ${key.ref} не стёрлось из хранилища`, error)
    }
  }
  let dropped = 0
  for (const [sessionId, keyId] of picks) {
    if (keyId === key.id) {
      picks.delete(sessionId)
      dropped += 1
    }
  }
  if (dropped > 0) savePicks()
  log(ctx, 'info', `ключ «${key.label}» удалён; чатов сброшено на ключ по умолчанию: ${dropped}`)
  return { ok: true, removed: key.id, sessions: dropped, routes: routed }
}

/**
 * Choose the key a new chat starts with.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param body - `{ id }`.
 * @returns `{ ok, defaultKeyId }` or `{ ok: false, error }`.
 */
function setDefaultKey(ctx, config, body) {
  const doc = ringOf(ctx, config)
  const key = doc.keys.find(candidate => candidate.id === body?.id)
  if (key === undefined) return { ok: false, error: 'такого ключа в кольце нет' }
  saveRing({ ...doc, defaultKeyId: key.id })
  log(ctx, 'info', `ключ по умолчанию: «${key.label}» (${key.route})`)
  return { ok: true, defaultKeyId: key.id }
}

/**
 * Write the ring's routes again, for a profile that lost them.
 *
 * A hand edit of `cordis.patch.yml`, a model-list rollback or a reverted backup
 * can all leave a key whose clone is gone; the settings page offers this rather
 * than reconciling a live profile on its own initiative.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @returns a promise of `{ ok, ... }`.
 */
async function repairRoutes(ctx, config) {
  const doc = ringOf(ctx, config)
  routesCache.at = 0
  return ensureRingRoutes(ctx, config, doc, 'восстановление маршрутов ключей')
}

/**
 * Ask the provider whether one key works.
 *
 * The same endpoint the model list is read from, with this key and no other: a
 * `200` with models is a key that will serve requests, and anything else is the
 * provider's own answer, quoted as it came.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param body - `{ id }`.
 * @returns a promise of `{ ok, test }`.
 */
async function testKey(ctx, config, body) {
  const doc = ringOf(ctx, config)
  const key = doc.keys.find(candidate => candidate.id === body?.id)
  if (key === undefined) return { ok: false, error: 'такого ключа в кольце нет' }
  const value = await keyValueOf(ctx, key.ref)
  if (value === undefined) return { ok: true, test: { id: key.id, ok: false, error: 'значение ключа не найдено в хранилище учётных данных' } }
  const base = baseProviderOf(ctx, config)
  const baseURL = typeof base?.baseURL === 'string' && base.baseURL.trim() !== '' ? base.baseURL.trim() : `${config.origin}/v1`
  const url = `${baseURL.replace(/\/+$/u, '')}/models`
  try {
    const result = await getUrl(url, {
      timeoutMs: ORIGIN_TIMEOUT_MS,
      headers: { accept: 'application/json', authorization: `Bearer ${value}` },
    })
    let models = 0
    if (result.status === 200) {
      try {
        models = normalizeServedList(JSON.parse(result.body.toString('utf8'))).length
      } catch {
        models = 0
      }
    }
    return {
      ok: true,
      test: {
        id: key.id,
        ok: result.status === 200 && models > 0,
        status: result.status,
        models,
        ...result.status === 200 && models > 0 ? {} : { error: `HTTP ${result.status}${models === 0 ? ', в ответе нет ни одной модели' : ''}` },
      },
    }
  } catch (error) {
    return { ok: true, test: { id: key.id, ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Run one key-ring action.
 *
 * @param ctx - the plugin context.
 * @param body - `{ action, ... }`.
 * @returns a promise of the action's result merged with a fresh ring payload.
 */
async function keyAction(ctx, body) {
  const config = readConfig()
  const action = typeof body?.action === 'string' ? body.action : ''
  let result
  switch (action) {
    case 'add': result = await addKey(ctx, config, body); break
    case 'set': result = await setKeyValue(ctx, body); break
    case 'rename': result = await renameKey(ctx, config, body); break
    case 'remove': result = await removeKey(ctx, config, body); break
    case 'default': result = setDefaultKey(ctx, config, body); break
    case 'repair': result = await repairRoutes(ctx, config); break
    case 'test': result = await testKey(ctx, config, body); break
    default: return { ok: false, status: 400, error: `неизвестное действие «${action}»` }
  }
  if (result.ok !== true) return { ...result, status: 409 }
  return { ...result, ...(await describeRing(ctx, readConfig())) }
}

/**
 * The key a chat sends its requests with.
 *
 * Its own pick when it has one, the ring's default otherwise, and the primary key
 * when the ring has no default — which is the state a profile is in before
 * anybody adds a second key.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param sessionId - the chat.
 * @returns the key id, or `null`.
 */
function effectiveKeyId(ctx, config, sessionId) {
  const doc = ringOf(ctx, config)
  const picked = typeof sessionId === 'string' ? picks.get(sessionId) : undefined
  const keyId = picked ?? doc.defaultKeyId
  return doc.keys.some(key => key.id === keyId) ? keyId : (doc.keys.find(key => key.primary)?.id ?? null)
}

/**
 * Record one chat's pick.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param body - `{ sessionId, keyId }`; a `null` key returns the chat to the default.
 * @returns `{ ok, sessionId, keyId }` or `{ ok: false, error }`.
 */
function setSessionKey(ctx, config, body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) return { ok: false, error: 'не передан идентификатор чата' }
  const doc = ringOf(ctx, config)
  const keyId = body?.keyId === null || body?.keyId === undefined ? null : String(body.keyId)
  if (keyId !== null && !doc.keys.some(key => key.id === keyId)) {
    return { ok: false, error: 'такого ключа в кольце нет' }
  }
  if (keyId === null || keyId === effectiveKeyId(ctx, config, null)) picks.delete(sessionId)
  else picks.set(sessionId, keyId)
  savePicks()
  return { ok: true, sessionId, keyId: keyId ?? effectiveKeyId(ctx, config, sessionId) }
}

/** What this half accepts as a chat identifier. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/u

/**
 * Name the route of the key this chat picked.
 *
 * The whole per-chat half of the feature, and the reason it is safe: the config
 * that comes back is changed in exactly one field, only when the request was
 * already going to one of this ring's own routes, and only when the target route
 * is installed and serves the model. Everything else — the built-in DeepSeek
 * account, any other provider, a chat with no pick — is returned untouched.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param payload - the waterfall payload, for the agent's session.
 * @param resolved - the call configuration the harness assembled.
 * @returns the configuration to send.
 */
function routeForPick(ctx, config, payload, resolved) {
  if (config.apiKeys !== true) return resolved
  if (typeof resolved !== 'object' || resolved === null) return resolved
  const sessionId = payload?.agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return resolved
  const doc = ringOf(ctx, config)
  if (doc.keys.length < 2) return resolved
  const keyId = picks.get(sessionId) ?? doc.defaultKeyId
  const key = doc.keys.find(candidate => candidate.id === keyId)
  if (key === undefined || key.primary === true) return resolved
  const from = typeof resolved.provider === 'string' ? resolved.provider : ''
  if (!doc.keys.some(candidate => candidate.route === from)) return resolved
  if (from === key.route) return resolved
  const installed = installedRoutes(ctx, config)
  const profile = installed.providers[key.route]
  if (profile === undefined) {
    return keyFallback(ctx, sessionId, key, resolved, `маршрут «${key.route}» не установлен в профиле — нажмите «Починить маршруты»`)
  }
  const model = typeof resolved.model === 'string' ? resolved.model : ''
  if (model !== '' && Array.isArray(profile.models) && !profile.models.some(entry => entry?.id === model)) {
    return keyFallback(ctx, sessionId, key, resolved, `маршрут «${key.route}» не отдаёт модель «${model}» — список моделей устарел`)
  }
  routing.applied += 1
  return { ...resolved, provider: key.route }
}

/**
 * Leave a request on the route it was going to use, and say why.
 *
 * A key whose route is not ready is a configuration problem, and the answer to it
 * is a working request plus a visible warning rather than a failed step: the chat
 * keeps running on the route the profile names, and the settings page names the
 * reason.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the chat.
 * @param key - the key that could not be used.
 * @param resolved - the untouched configuration.
 * @param reason - what went wrong.
 * @returns the configuration, unchanged.
 */
function keyFallback(ctx, sessionId, key, resolved, reason) {
  const at = new Date().toISOString()
  const changed = lastKeyFallback?.reason !== reason || lastKeyFallback?.keyId !== key.id
  lastKeyFallback = { at, sessionId, keyId: key.id, keyLabel: key.label, route: key.route, provider: resolved.provider, model: resolved.model, reason }
  if (changed) log(ctx, 'warn', `ключ «${key.label}» не применён: ${reason}`)
  return resolved
}

/**
 * Install the per-chat swap for as long as this revision runs.
 *
 * One listener on the plugin's own context: the harness dispatches
 * `agent/request` from the agent's scope, and a listener here sees every agent,
 * which is what a per-chat rule wants. A context that carries no `on` — a test
 * harness, or a composition that mounts this half without events — costs the
 * feature its per-chat half and nothing else.
 *
 * @param ctx - the plugin context.
 * @returns the disposer.
 */
function installKeyRouting(ctx) {
  if (typeof ctx?.on !== 'function') return () => {}
  const dispose = ctx.on('agent/request', async (payload, next) => {
    routing.seen += 1
    const resolved = await next()
    try {
      return routeForPick(ctx, readConfig(), payload, resolved)
    } catch (error) {
      log(ctx, 'warn', 'подмена маршрута ключа не удалась — запрос идёт как шёл', error)
      return resolved
    }
  })
  return typeof dispose === 'function' ? dispose : () => {}
}

/* ------------------------------------------------------------------------- *
 * Uptime error reports
 *
 * One event per infrastructure failure, so a monitor can say when, for how many
 * installs, and on which model the provider's site fell over — derived from the
 * traffic the plugin already makes instead of from probe requests that would
 * spend tokens to ask a question a failed chat has just answered for free.
 *
 * No single seam sees the whole outage, which is why this half watches three.
 * `agent/request` is where a step becomes a route and a model, so that is where an
 * attempt is opened. `agent/request-error` sees the faults `dsh-llm-pi-ai`
 * delivers in band, a gateway's 502 among them. And `session/event` sees both
 * endings: the `assistant/message` that says a step produced output, and the
 * `turn/end` a *thrown* fault leaves behind. The thrown ones matter most — a
 * stream that goes idle and is killed by the watchdog never reaches
 * `request-error` at all, and "the site accepted the connection and then said
 * nothing" is exactly the outage worth reporting.
 *
 * Two rules keep this feature honest. Only a route this plugin speaks for is ever
 * reported, so the built-in DeepSeek account's bad day is not counted against
 * anybody else's site. And only what `./errors.js` classifies as infrastructure is
 * reported: a spent subscription, an exhausted quota, a rate limit, a bad key, an
 * over-long context and a pressed stop are the user's own, and never leave this
 * process.
 * ------------------------------------------------------------------------- */

/** How long an in-flight attempt is remembered, in milliseconds. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000

/** One report send's budget, in milliseconds. */
const REPORT_TIMEOUT_MS = 10_000

/**
 * The longest wait a collector's `Retry-After` may impose, in milliseconds.
 *
 * The header is answered by a remote service, so it is treated as untrusted input:
 * a broken or hostile value that named next year would postpone delivery forever
 * and quietly turn the feature off.
 */
const REPORT_RETRY_AFTER_MAX_MS = 10 * 60 * 1000

/** How much of a collector's own error sentence is carried into the summary. */
const COLLECTOR_ERROR_MAX = 300

/**
 * How much of a collector's warning is carried into a log line.
 *
 * Capped because the sentence comes from a remote service and ends up in the harness's
 * own log, which is a channel nobody reading a chat can turn off.
 */
const WARNING_MAX = 200

/** How many of a collector's warnings one log line carries. */
const WARNINGS_MAX = 4

/**
 * The model requests this half is currently watching.
 *
 * Keyed `sessionId|turn|step` because that triple is the only identity a step has
 * across the three seams that see it: `agent/request` opens it, and either an
 * `assistant/message` or a `request-error`/`turn/end` closes it.
 */
const attempts = new Map()

/**
 * How many infra failures were reported without a matching attempt.
 *
 * Zero is the healthy case and a non-zero number is not an error: a report that
 * could not be timed is still a report, and the collector takes it. The number
 * exists so "is the watcher seeing anything at all" is answerable from a browser,
 * which is the question that could not be answered the night a real outage went
 * unreported while the summary sat at `failures: 1`.
 */
let unattributedCount = 0

/**
 * Whether the unattributed-failure warning has been said for this revision.
 *
 * Said once, like the reporter's own announcements: an outage retries, and a
 * listener that warned per failure would flood the harness log through a channel
 * nobody can turn off.
 */
let warnedUnattributed = false

/**
 * Whether the collector-warnings announcement has been said for this revision.
 *
 * Separate from {@link warnedUnattributed} because they announce different failures:
 * that one says a failure could not be timed, this one says a report was accepted
 * with something missing from it. Both are once per revision, for the same reason.
 */
let warnedCollectorWarnings = false

/**
 * Why the failures this half saw did not reach the collector, one bucket each.
 *
 * Every failure observed on `agent/request-error` lands in exactly one of these, and
 * the identity `seen == reported + unattributed + ignoredNonInfra + ignoredRoute +
 * ignoredCollect + duplicates + ignoredInternal` is what makes a missed outage
 * answerable from a browser. Before these existed, a failure that `classifyFailure`
 * read as somebody's own problem was dropped by design and moved no number at all —
 * so a real 502 whose gateway body happened to contain a word like «token» or «auth»
 * was indistinguishable from a watcher that had stopped working.
 *
 * All of them are per-revision, like `tracked`: they describe this watcher, and a
 * reload is a different watcher. The reporter's own counters are cumulative and are
 * a different thing — `seen` counts what this seam was handed, `failures` counts what
 * the reporter was told to queue, and the self-test moves the second without the
 * first.
 */
let seenCount = 0
let reportedCount = 0
let ignoredNonInfra = 0
let ignoredRoute = 0
let ignoredCollect = 0
let duplicateCount = 0
let ignoredInternal = 0

/**
 * The classification of the last failure dropped as somebody's own problem.
 *
 * Kept beside the histogram rather than replaced by it: the map answers "which kinds
 * are eating failures" and this answers "what was the most recent one", and during a
 * storm those are different questions with different answers.
 */
let lastIgnoredCode = null
let lastIgnoredKind = null

/**
 * How many kinds the histogram keeps before the rest share one bucket.
 *
 * Twice the non-infra vocabulary `./errors.js` can actually produce, so the headroom
 * is for the open-ended cases: `http_NNN` and `upstream_NNN` name a status, and a
 * gateway may answer with any of them.
 */
const IGNORED_KIND_MAX = 24

/** The bucket everything past the cap is counted in. */
const IGNORED_KIND_OTHER = 'other'

/** Non-infra drops by the kind that dropped them. */
const ignoredByKind = new Map()

/**
 * Count one non-infra drop against its kind.
 *
 * Bounded by folding rather than by evicting, and the reason is the incident this
 * exists for: the kinds worth reading are the rare ones, because a single `http_418`
 * in a storm of `auth` *is* the diagnosis, and dropping the least-seen entry would
 * discard exactly that signal. Folding also keeps the histogram's total equal to
 * `ignoredNonInfra` however long the process runs, which is what makes the invariant
 * assertable rather than approximate.
 *
 * @param kind - the classification's kind.
 */
function countIgnoredKind(kind) {
  const key = typeof kind === 'string' && kind !== '' ? kind : 'unknown'
  if (ignoredByKind.has(key)) {
    ignoredByKind.set(key, ignoredByKind.get(key) + 1)
    return
  }
  if (ignoredByKind.size >= IGNORED_KIND_MAX) {
    ignoredByKind.set(IGNORED_KIND_OTHER, (ignoredByKind.get(IGNORED_KIND_OTHER) ?? 0) + 1)
    return
  }
  ignoredByKind.set(key, 1)
}

/**
 * Count one observed failure into the bucket its outcome belongs to.
 *
 * @param reason - what {@link noteAttemptFailure} answered.
 */
function countFailureOutcome(reason) {
  if (reason === 'reported') reportedCount += 1
  else if (reason === 'unattributed') unattributedCount += 1
  else if (reason === 'duplicate') duplicateCount += 1
  else if (reason === 'non-infra') ignoredNonInfra += 1
  else if (reason === 'foreign-route') ignoredRoute += 1
  else if (reason === 'collect-off') ignoredCollect += 1
  else ignoredInternal += 1
}

/**
 * The chat one event belongs to, read defensively.
 *
 * The harness injects the agent scope rather than passing it, and nothing promises
 * the session id is a string — a strict `typeof` check turns a numeric id into a
 * silently disabled failure path, which is one revision away from the whole feature
 * reporting nothing. Every place the id can hide is read, and the answer is always
 * a string.
 *
 * @param payload - the event payload.
 * @returns the session id, or `''` when the event carries none.
 */
function sessionIdOf(payload) {
  return String(payload?.agent?.session?.id ?? payload?.sessionId ?? payload?.session?.id ?? '')
}

/**
 * The failure document one error event carries, read from every place it can live.
 *
 * The harness builds the payload with `failure: { message, code }` today, but its own
 * retry plugin hedges with `payload?.code ?? payload?.failure?.code` — which is the
 * harness saying it is not settled where the code lives. Reading both costs nothing
 * and means a harness that moves the code to the top level cannot turn a `SERVER`
 * into an `UNKNOWN`, which is exactly the difference between a reported outage and
 * a silent one.
 *
 * @param failure - the payload's `failure` object.
 * @param payload - the whole payload.
 * @returns the merged failure document.
 */
function failureOf(failure, payload) {
  const source = typeof failure === 'object' && failure !== null ? failure : {}
  return {
    message: typeof source.message === 'string' ? source.message : payload?.message,
    code: typeof source.code === 'string' ? source.code : payload?.code,
    status: source.status ?? payload?.status,
  }
}

/**
 * The model one failure was for, when the payload itself names it.
 *
 * Read off the session's request context, the way the harness's own retry plugin
 * reads it, because that is the only place a failure payload carries the model when
 * this half has no attempt to take it from. Both a function and a plain object are
 * accepted, and a getter that throws is the harness's business rather than this
 * half's — a model name is a nicety and must never cost a report.
 *
 * @param payload - the event payload.
 * @returns the model id, or `''` when the payload names none.
 */
function modelOfPayload(payload) {
  try {
    const session = payload?.agent?.session
    const context = typeof session?.requestContext === 'function' ? session.requestContext() : session?.requestContext
    if (typeof context?.model === 'string' && context.model !== '') return context.model
    const header = typeof payload?.requestHeader === 'function' ? payload.requestHeader() : payload?.requestHeader
    if (typeof header?.config?.model === 'string' && header.config.model !== '') return header.config.model
  } catch {
    // A context that throws is not worth a report of its own.
  }
  return ''
}

/**
 * The key one attempt is remembered under.
 *
 * The numbers are normalized here rather than at the call sites so a listener that
 * is handed a numeric turn and one that is handed its string form agree on a key.
 *
 * @param sessionId - the chat.
 * @param turn - the turn.
 * @param step - the step inside it.
 * @returns the map key.
 */
function attemptKey(sessionId, turn, step) {
  return `${sessionId}|${Number(turn)}|${Number(step)}`
}

/**
 * Drop the attempts that never ended.
 *
 * A step that ends in neither a message nor an error — a process killed mid-turn,
 * a harness that stopped dispatching — would otherwise stay in the map for the
 * life of the revision. Run on every insert, so the sweep costs no timer of its
 * own and an idle process holds nothing.
 */
function sweepAttempts() {
  const cutoff = Date.now() - ATTEMPT_TTL_MS
  for (const [key, attempt] of attempts) {
    if (attempt.at < cutoff) attempts.delete(key)
  }
}

/**
 * The attempt one seam is asking about.
 *
 * @param sessionId - the chat, already normalized to a string.
 * @param turn - the turn.
 * @param step - the step.
 * @returns the attempt, or `undefined` when this half never opened one.
 */
function lookupAttempt(sessionId, turn, step) {
  if (sessionId === '') return undefined
  return attempts.get(attemptKey(sessionId, turn, step))
}

/**
 * Remember one model request as it goes out.
 *
 * The setting is captured here, once. A toggle in the middle of a session then
 * neither re-reads the settings file on every session event — which fires for
 * every event of every session in the process — nor changes its mind about an
 * attempt that is already in flight.
 *
 * @param payload - the waterfall payload, for the agent's session.
 * @param resolved - the call configuration this half will send.
 * @returns the recorded attempt, or `undefined` when it cannot be keyed.
 */
function recordAttempt(payload, resolved) {
  const sessionId = sessionIdOf(payload)
  if (sessionId === '') return undefined
  const turn = Number(payload?.turn)
  const step = Number(payload?.step)
  if (!Number.isFinite(turn) || !Number.isFinite(step)) return undefined
  sweepAttempts()
  const attempt = {
    sessionId,
    turn,
    step,
    provider: typeof resolved?.provider === 'string' ? resolved.provider : '',
    model: typeof resolved?.model === 'string' ? resolved.model : '',
    at: Date.now(),
    collect: readConfig().collectErrors === true,
    reported: false,
  }
  attempts.set(attemptKey(sessionId, turn, step), attempt)
  return attempt
}

/**
 * The attempt a `turn/end` error belongs to.
 *
 * The event names a turn and no step, and a thrown fault closes the turn rather
 * than the step, so the newest attempt of that turn is the one that failed. An
 * attempt from another turn is taken only when this turn left none: a slightly
 * older outage is still worth more than a lost one.
 *
 * @param sessionId - the chat.
 * @param turn - the turn that ended, when the event carries one.
 * @returns the attempt, or `undefined` when the session has none unreported.
 */
function newestUnreportedAttempt(sessionId, turn) {
  let best
  for (const attempt of attempts.values()) {
    if (attempt.sessionId !== sessionId || attempt.reported === true) continue
    if (best === undefined) {
      best = attempt
      continue
    }
    const wanted = attempt.turn === turn ? 1 : 0
    const held = best.turn === turn ? 1 : 0
    if (wanted > held || (wanted === held && attempt.at >= best.at)) best = attempt
  }
  return best
}

/**
 * Whether two endpoints name the same site.
 *
 * Compared by hostname rather than by whole URL: a route may carry a path prefix
 * or spell out a port the origin setting leaves off, and neither changes whose
 * site is down.
 *
 * @param left - the first URL.
 * @param right - the second URL.
 * @returns true when both parse and their hosts match.
 */
function sameSite(left, right) {
  try {
    if (!URL.canParse(left) || !URL.canParse(right)) return false
    return new URL(left).hostname.toLowerCase() === new URL(right).hostname.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Whether one provider route is a Rustvy route this feature speaks for.
 *
 * Three answers count as ours: the route the profile names, any route the key ring
 * owns, and — the catch-all for a route declared by hand that the ring has never
 * seen — an installed route whose endpoint sits on the same site as the origin.
 * Everything else, the built-in DeepSeek account above all, is somebody else's
 * outage and is never reported.
 *
 * Both helpers it reads through are already cached, so this is cheap enough to ask
 * per failure and per success.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param provider - the route name a request went out on.
 * @returns true when a failure on that route belongs in the report.
 */
function isReportedRoute(ctx, config, provider) {
  if (typeof provider !== 'string' || provider === '') return false
  if (provider === config.modelRoute) return true
  if (ringOf(ctx, config).keys.some(key => key.route === provider)) return true
  const baseURL = installedRoutes(ctx, config).providers[provider]?.baseURL
  return typeof baseURL === 'string' && baseURL.trim() !== '' && sameSite(baseURL.trim(), config.origin)
}

/**
 * Hand one failure to the reporter, when it is a failure worth reporting.
 *
 * Both seams that see a failure end here, so the rule about what the collector is
 * told exists once rather than twice. A route this plugin does not speak for, an
 * attempt that was opened with collection off, an attempt already reported by the
 * other seam, and anything `./errors.js` does not call infrastructure are all
 * dropped here and never reach the network.
 *
 * A failure that matches no attempt is *not* one of those. Attribution is best
 * effort by design: an attempt supplies the duration and the model, and without one
 * the report goes out with `ms: 0` and whatever model the payload itself names. A
 * report with a wrong duration is worth infinitely more than no report — this
 * feature exists for the outage nobody was positioned to watch for, the collector
 * tolerates both a missing model and a zero duration, and the alternative was a real
 * 502 on a real route that reached nobody and left no trace but a `failures: 1`.
 *
 * @param ctx - the plugin context.
 * @param reporter - the reporter to hand the event to.
 * @param attempt - the matching attempt, when one was found.
 * @param provider - the route the request went out on, as the seam names it.
 * @param failure - the failure document, already merged from every place it can live.
 * @param context - `{ sessionId, turn, step, model }`: the coordinates the warning
 *   names, and the best-effort model when no attempt was found.
 * @returns why the failure did or did not reach the collector: `'reported'`,
 *   `'unattributed'`, `'duplicate'`, `'non-infra'`, `'foreign-route'` or
 *   `'collect-off'`. A string rather than a boolean, because "was it dropped" is not
 *   the question anybody needs answered — "which rule dropped it" is, and the caller
 *   is what turns the answer into a counter.
 */
function noteAttemptFailure(ctx, reporter, attempt, provider, failure, context = {}) {
  const config = readConfig()
  // An attempt carries the setting as it was when the request went out; a failure
  // this half has no attempt for has to ask the settings as they are now.
  const collect = attempt !== undefined ? attempt.collect === true : config.collectErrors === true
  if (collect !== true) return 'collect-off'
  if (attempt !== undefined && attempt.reported === true) return 'duplicate'
  const classified = classifyFailure(failure)
  if (classified.infra !== true) {
    // Remembered because this is the drop nobody can see: it is correct behaviour,
    // it moves no counter of the reporter's, and the only way to tell "the gateway's
    // error page said «token»" from "the watcher is dead" is what is left behind
    // here. The histogram is the part that survives a storm; the last-value pair is
    // the part that says what just happened.
    lastIgnoredCode = classified.code
    lastIgnoredKind = classified.kind
    countIgnoredKind(classified.kind)
    return 'non-infra'
  }
  const route = typeof provider === 'string' && provider !== '' ? provider : (attempt?.provider ?? '')
  if (!isReportedRoute(ctx, config, route)) return 'foreign-route'
  const at = Date.now()
  const namedModel = typeof context?.model === 'string' && context.model !== '' ? context.model : 'unknown'
  if (attempt === undefined) announceUnattributed(ctx, context)
  reporter.noteFailure({
    model: attempt !== undefined && attempt.model !== '' ? attempt.model : namedModel,
    route,
    status: classified.status,
    ms: attempt !== undefined ? at - attempt.at : 0,
    err: classified.text,
    code: classified.code,
    kind: classified.kind,
    at,
  })
  if (attempt !== undefined) attempt.reported = true
  return attempt === undefined ? 'unattributed' : 'reported'
}

/**
 * Say, once per revision, that an infra failure could not be matched to an attempt.
 *
 * Named with the coordinates it looked for, because that is the only thing a reader
 * can act on: a session and step that never appears in `tracked` says the watcher
 * missed the request, while one that does says the key was built differently on the
 * way out than on the way back. Either way it is one line, not one per retry.
 *
 * @param ctx - the plugin context.
 * @param context - `{ sessionId, turn, step }`.
 */
function announceUnattributed(ctx, context) {
  if (warnedUnattributed) return
  warnedUnattributed = true
  log(ctx, 'warn', `сбой инфраструктуры учтён без совпавшей попытки: сессия «${context?.sessionId ?? ''}», ход ${Number(context?.turn)}, шаг ${Number(context?.step)} — событие отправлено с нулевой длительностью`)
}

/**
 * Close one attempt as a success.
 *
 * The assistant message is the only signal that a step really produced output, and
 * a request that reached the site and came back with tokens is an uptime sample.
 * Those samples are the whole of the monitor's "is this model up" answer, which is
 * why it needs no probe: passive traffic says it for free.
 *
 * Synchronous, and it stays that way — `session/event` is an emit dispatch, so a
 * promise returned from here would be discarded and a rejection would land on the
 * harness's own log rather than on this file's.
 *
 * @param ctx - the plugin context.
 * @param reporter - the reporter to hand the sample to.
 * @param sessionId - the chat.
 * @param data - the event's data, for the turn, the step and the message source.
 */
function noteAttemptSuccess(ctx, reporter, sessionId, data) {
  const key = attemptKey(sessionId, data?.turn, data?.step)
  const attempt = attempts.get(key)
  attempts.delete(key)
  const source = data?.message?.source
  const route = attempt?.provider ?? (typeof source?.provider === 'string' ? source.provider : '')
  const model = attempt?.model ?? (typeof source?.model === 'string' ? source.model : '')
  if (route === '' || model === '') return
  // An attempt carries the setting as it was when the request went out, so the
  // common path reads the settings file once, for the route test alone; only a step
  // this half never saw a request for has to ask whether collection is on at all.
  if (attempt !== undefined && attempt.collect !== true) return
  const config = readConfig()
  if (attempt === undefined && config.collectErrors !== true) return
  if (!isReportedRoute(ctx, config, route)) return
  const at = Date.now()
  reporter.noteSuccess({ model, route, ms: at - (attempt?.at ?? at), at })
}

/**
 * Forget every attempt of one turn.
 *
 * A turn that has ended has no step in flight, whatever its reason and whether or
 * not its failure was already reported. Without this, an attempt reported in band
 * lingers until the ten-minute sweep and `tracked` reads as a watcher that has
 * stopped seeing requests when it has not — which is the one thing the counter exists
 * to rule out.
 *
 * @param sessionId - the chat.
 * @param turn - the turn that ended; when the event names none, all of the session's.
 */
function releaseTurnAttempts(sessionId, turn) {
  const wanted = Number(turn)
  for (const [key, attempt] of attempts) {
    if (attempt.sessionId !== sessionId) continue
    if (Number.isNaN(wanted) || attempt.turn === wanted) attempts.delete(key)
  }
}

/**
 * Close a turn that ended in a thrown fault.
 *
 * The seam the in-band path cannot cover: a stream that goes idle and is killed by
 * the watchdog, a socket closed mid-chunk, a credential that resolved to nothing.
 * These are thrown out of the step, so they never reach `agent/request-error`, and
 * the only trace they leave is a `turn/end` whose reason carries the failure.
 *
 * @param ctx - the plugin context.
 * @param reporter - the reporter to hand the failure to.
 * @param sessionId - the chat.
 * @param data - the event's data, for the turn and the reason.
 */
function noteTurnError(ctx, reporter, sessionId, data) {
  // Found before the turn is released, because releasing is what makes `tracked`
  // mean "steps in flight" and looking afterwards would find nothing.
  const attempt = newestUnreportedAttempt(sessionId, data?.turn)
  releaseTurnAttempts(sessionId, data?.turn)
  // A turn the user stopped is not an outage and a turn that ended normally is not
  // a failure; both are ignored here rather than classified and dropped later.
  if (data?.reason?.kind !== 'error') return
  const failure = failureOf(data.reason.error, data.reason)
  // No attempt left to attribute this to means one of two things, and neither is
  // reportable from here. Either the in-band seam already reported this same fault —
  // the ordinary case, since a failure the retry plugin declines to retry ends the
  // turn too, and reporting it again would count one outage twice — or this half
  // never saw the request go out, in which case a `turn/end` names no route and
  // there is nothing to test ownership against. The route is the one field this
  // seam cannot reconstruct, which is why the request-error seam is the one that
  // reports unattributed failures.
  if (attempt === undefined) return
  noteAttemptFailure(ctx, reporter, attempt, attempt.provider, failure, { sessionId, turn: data?.turn })
}

/**
 * Watch every model request this process makes, for as long as this revision runs.
 *
 * Independent of the key ring's own `agent/request` listener rather than folded
 * into it: Cordis composes a waterfall outermost-first, so installing this one
 * *before* the ring's puts it outside, and `await next()` then answers with the
 * route the ring settled on rather than the one the profile named. That route is
 * the one worth reporting.
 *
 * Nothing here may cost a chat its request, so every path is wrapped and a
 * listener that throws is a `warn` line and a lost event. `agent/request-error`
 * hands the waterfall straight on: recovery is the harness retry plugin's
 * decision, and answering it here would change how often a failing step is
 * repeated, which is not this feature's business.
 *
 * @param ctx - the plugin context.
 * @param reporter - the reporter failures and successes are handed to.
 * @returns the disposer, which removes all three listeners.
 */
function installErrorWatch(ctx, reporter) {
  if (typeof ctx?.on !== 'function') return () => {}

  const onRequest = async (payload, next) => {
    // `await next()` stays outside the guard: a request that failed to be assembled
    // must reach the loop as a failure, not as an `undefined` configuration.
    const resolved = await next()
    try {
      recordAttempt(payload, resolved)
    } catch (error) {
      log(ctx, 'warn', 'запрос модели не учтён наблюдателем ошибок — на сам запрос это не влияет', error)
    }
    return resolved
  }

  const onRequestError = (payload, next) => {
    // Counted before any decision is made about it, so `seen` is every failure this
    // seam was handed and the buckets below account for all of it without a gap. A
    // failure that throws on the way through lands in `ignoredInternal`, which is
    // the one bucket that should always read zero and is itself the alarm when it
    // does not.
    seenCount += 1
    let outcome = 'internal'
    try {
      const sessionId = sessionIdOf(payload)
      // The exact key first, then the newest unreported attempt of that turn, then
      // nothing at all. Each miss costs the report a little accuracy — a duration,
      // then a model name — and must never cost the collector the event, which is
      // what happened the night a real 502 went unreported.
      const attempt = lookupAttempt(sessionId, payload?.turn, payload?.step)
        ?? newestUnreportedAttempt(sessionId, payload?.turn)
      outcome = noteAttemptFailure(ctx, reporter, attempt, payload?.provider, failureOf(payload?.failure, payload), {
        sessionId,
        turn: payload?.turn,
        step: payload?.step,
        model: modelOfPayload(payload),
      })
    } catch (error) {
      log(ctx, 'warn', 'ошибка модели не учтена наблюдателем ошибок — на повтор запроса это не влияет', error)
    }
    countFailureOutcome(outcome)
    return next()
  }

  const onSessionEvent = (session, event) => {
    // An emit dispatch on every event of every session in the process: the type
    // guard comes first so a streaming tool call costs this listener one compare.
    const type = event?.type
    if (type !== 'assistant/message' && type !== 'turn/end') return
    try {
      const sessionId = String(session?.id ?? '')
      if (sessionId === '') return
      if (type === 'assistant/message') noteAttemptSuccess(ctx, reporter, sessionId, event.data)
      else noteTurnError(ctx, reporter, sessionId, event.data)
    } catch (error) {
      log(ctx, 'warn', 'событие сессии не обработано наблюдателем ошибок', error)
    }
  }

  const disposers = [
    ctx.on('agent/request', onRequest),
    ctx.on('agent/request-error', onRequestError),
    ctx.on('session/event', onSessionEvent),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // A listener already gone is not a failure to unload.
      }
    }
  }
}

/**
 * The reporter's log line, on this file's own logger.
 *
 * Everything lands on `warn`: a report that could not be sent is worth seeing once
 * and worth no more than that, and nothing the reporter can say is a reason to
 * fail a chat or to shout on `error` beside a real fault. The settings page reads
 * the persistent case — a collector that will not answer — from
 * `summary().lastError` on `/state`, which is where a user actually looks.
 *
 * @param ctx - the plugin context.
 * @returns the function to hand `createReporter`.
 */
function reporterLog(ctx) {
  return (message, error) => log(ctx, 'warn', message, error)
}

/**
 * The reports still waiting for the collector.
 *
 * Read back as a bare array, because that is what the reporter queues: the file
 * holds records, and the shape the collector takes is built from one record at a
 * time at send time, in `./errors.js`. A file that *is* a batch envelope is
 * unwrapped rather than discarded, so a queue left behind by an older revision of
 * this half — which did send one envelope per batch — still delivers its backlog
 * instead of being read as corruption; anything else, absent or truncated or not a
 * list of records at all, reads as "nothing queued".
 *
 * @returns the queued records, or `undefined` when there is nothing readable.
 */
function readQueuedReports() {
  const stored = readJsonFile(errorsQueueFile())
  const records = Array.isArray(stored) ? stored : (Array.isArray(stored?.events) ? stored.events : undefined)
  if (records === undefined) return undefined
  return records.filter(record => typeof record === 'object' && record !== null && !Array.isArray(record))
}

/**
 * One `Retry-After` answer, in milliseconds.
 *
 * The collector rate-limits per address and says how long to wait, and a reporter
 * that ignored it would spend its next attempt on the same refusal — so the wait is
 * read here and handed on as the backoff's floor. Both forms the header allows are
 * accepted, a count of seconds and an HTTP date, because a server may send either,
 * and the answer is capped because it comes from a remote service.
 *
 * @param headers - the response headers, as `postJson` answers them.
 * @returns the wait in milliseconds, or `undefined` when the header is absent,
 *   unparseable, or names no time ahead of this one.
 */
function retryAfterMsOf(headers) {
  const raw = headers?.['retry-after'] ?? headers?.get?.('retry-after')
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const text = raw.trim()
  const seconds = Number(text)
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(text) - Date.now()
  if (!Number.isFinite(wait) || wait <= 0) return undefined
  return Math.min(REPORT_RETRY_AFTER_MAX_MS, Math.round(wait))
}

/**
 * The collector's own explanation of a refusal, when it offered one.
 *
 * `summary().lastError` is what a user reads on the settings page, and the
 * collector's sentence says what to fix while a status number only says that
 * something did. Parsed defensively, because the body is whatever a remote service
 * answered with: absent, not JSON, or JSON without an `error` all read as "no
 * explanation offered" and leave the reporter's own wording in place. Control
 * characters are collapsed and the length capped, since this string is rendered.
 *
 * @param body - the response bytes, as `postJson` answers them.
 * @returns the explanation, or `undefined`.
 */
function collectorErrorOf(body) {
  try {
    if (!Buffer.isBuffer(body) || body.length === 0) return undefined
    const parsed = JSON.parse(body.toString('utf8'))
    if (typeof parsed?.error !== 'string') return undefined
    const text = parsed.error.replace(/[\u0000-\u001F\u007F]+/gu, ' ').trim()
    if (text === '') return undefined
    return text.length > COLLECTOR_ERROR_MAX ? `${text.slice(0, COLLECTOR_ERROR_MAX - 1)}…` : text
  } catch {
    return undefined
  }
}

/**
 * The warning codes a collector attached to an answer it nonetheless accepted.
 *
 * The v2 contract answers `200` for a report whose `meta` exceeded 8 KB and was
 * dropped whole, and names the reason in `warnings` — precisely so that losing
 * `meta.id`, the only field that answers "how many people saw this", is not silent.
 * `send` reduces an answer to the facts the reporter routes on, so without reading
 * this the report would count as cleanly sent and the warning would evaporate: a
 * contract clause no code reads is worse than no clause, because the next reader
 * assumes it is handled.
 *
 * The field carries stable `lower_snake_case` codes, absent when there are none, and
 * never prose — so this reads codes. Only a 2xx is inspected; a warning attached to a
 * refusal is part of the refusal and reaches the settings page through
 * `collectorErrorOf` instead.
 *
 * Tolerance here means two things, and the second is the easy one to miss. Nothing a
 * remote service answers may throw, so a non-array, a non-string and junk inside all
 * read as nothing rather than as a fault. But an element that is present and could not
 * be read is *not* dropped quietly — and how it is not dropped matters, because both
 * obvious answers are wrong. Parsing a foreign shape (reading `code` off an object)
 * means writing code for a form the contract rejected, and if a third-party collector
 * names that field differently the extraction silently yields nothing, which is the
 * exact failure this field exists to prevent, now hidden behind a branch that looks
 * like it handles the case. Counting instead ("N unrecognized") throws away content the
 * collector did send. So an unrecognized element is printed as it arrived: stringified,
 * control characters replaced, truncated. No field name is assumed, and nothing is
 * lost.
 *
 * @param status - the answer's status.
 * @param body - the response bytes, as `postJson` answers them.
 * @returns one line of text per warning element, capped.
 */
function collectorWarningsOf(status, body) {
  if (!(status >= 200 && status <= 299)) return []
  try {
    if (!Buffer.isBuffer(body) || body.length === 0) return []
    const warnings = JSON.parse(body.toString('utf8'))?.warnings
    if (!Array.isArray(warnings)) return []
    const said = warnings.slice(0, WARNINGS_MAX).map(item => {
      const raw = typeof item === 'string' ? item : stringifyWarning(item)
      const text = raw.replace(/[\u0000-\u001F\u007F]+/gu, ' ').trim()
      // An element that stringifies to nothing still arrived, so it says so rather
      // than vanishing and leaving the line reading as "the collector said nothing".
      if (text === '') return '(пусто)'
      return text.length > WARNING_MAX ? `${text.slice(0, WARNING_MAX - 1)}…` : text
    })
    // The cap protects the log line, and this protects the reader from concluding the
    // collector said less than it did.
    if (warnings.length > WARNINGS_MAX) said.push(`ещё ${warnings.length - WARNINGS_MAX} не показано`)
    return said
  } catch {
    return []
  }
}

/**
 * One warning element that is not a string, as text.
 *
 * @param item - the element.
 * @returns its JSON form, or `String(item)` when it has none — a circular object, or
 *   a value JSON cannot represent.
 */
function stringifyWarning(item) {
  try {
    const text = JSON.stringify(item)
    return text === undefined ? String(item) : text
  } catch {
    return String(item)
  }
}

/**
 * The warning codes this half can put into words.
 *
 * A translation table rather than a contract: codes are stable and never renamed or
 * reused, and a code this map has not heard of is passed through verbatim. "Ignore
 * unknown codes" must not mean "drop them quietly", because announcing a loss is the
 * entire reason the field exists — an unrecognized code is the more interesting one,
 * since it means the collector grew a way to lose data that this half does not know
 * about yet.
 */
const WARNING_TEXTS = Object.freeze({
  meta_too_large: 'метаданные отчёта превысили 8 КБ и отброшены целиком, поэтому событие не участвует в подсчёте «у скольких людей»',
})

/**
 * Say, once per revision, that the collector accepted a report but warned about it.
 *
 * Once rather than per report: a client that consistently oversizes `meta` would
 * otherwise log on every flush, through a channel nobody can turn off, and a log that
 * repeats stops being read. The report is named by its model and code, which is enough
 * to tell a one-off from a pattern without putting an install id into a log line.
 *
 * @param ctx - the plugin context.
 * @param report - the report the collector warned about.
 * @param warnings - the warning codes.
 */
function announceCollectorWarnings(ctx, report, warnings) {
  if (warnedCollectorWarnings) return
  warnedCollectorWarnings = true
  const model = typeof report?.model === 'string' && report.model !== '' ? report.model : 'без модели'
  const code = typeof report?.code === 'string' && report.code !== '' ? report.code : 'без кода'
  const said = warnings.map(item => WARNING_TEXTS[item] ?? item).join('; ')
  log(ctx, 'warn', `приёмник принял отчёт (${model}, ${code}) с предупреждением: ${said} — на отправку это не влияет`)
}

/**
 * Build the reporter this revision sends its events through.
 *
 * Everything it needs is injected rather than imported: the endpoint and the
 * switch are read live from the settings so a toggle takes effect on the next
 * event, the send goes out on this process's own route, and the queue is this
 * profile's file. What comes back is the reporter's own business — folding
 * repeats, capping a backlog, scrubbing a secret out of a message — and none of
 * it may throw at a caller that is in the middle of a chat.
 *
 * @param ctx - the plugin context.
 * @returns the reporter.
 */
function createErrorReporter(ctx) {
  return createReporter({
    endpoint: () => readConfig().uptimeEndpoint,
    identity: readInstallIdentity(installFile()),
    enabled: () => readConfig().collectErrors,
    log: reporterLog(ctx),
    now: () => Date.now(),
    // One report per request, as the collector's API takes it: the body is already
    // the finished document, so this hands it over verbatim and reduces the answer
    // to the three facts the reporter routes on — the status, which decides whether
    // the record is accepted, retried or dropped; the wait the collector asked for
    // when it refused one; and its own explanation, which is what the settings page
    // shows instead of a bare number.
    send: async (body, options) => {
      const result = await postJson(readConfig().uptimeEndpoint, body, {
        timeoutMs: options?.timeoutMs ?? REPORT_TIMEOUT_MS,
        headers: { accept: 'application/json' },
      })
      const retryAfterMs = retryAfterMsOf(result.headers)
      const error = collectorErrorOf(result.body)
      // An accepted report that carried warnings is still accepted, so the status is
      // handed on untouched and the reporter counts it as sent; the warning is
      // surfaced here because nothing downstream of `send` will see it.
      const warnings = collectorWarningsOf(result.status, result.body)
      if (warnings.length > 0) announceCollectorWarnings(ctx, body, warnings)
      return {
        status: result.status,
        ...retryAfterMs === undefined ? {} : { retryAfterMs },
        ...error === undefined ? {} : { error },
      }
    },
    store: {
      read: () => readQueuedReports(),
      write: records => { writeFileAtomic(errorsQueueFile(), `${JSON.stringify(records, null, 2)}\n`) },
    },
  })
}

/**
 * The reporter's counters plus this half's two watcher counters, or an inert
 * summary when the reporter cannot answer.
 *
 * `/state` is read often and is the page a person opens to find out what is wrong,
 * so a telemetry feature that throws on `summary()` costs the status page one
 * block and nothing else. The watcher's own numbers are added here rather than
 * kept separate because they are read for the same reason: `tracked` says whether
 * requests are being seen at all, and `unattributed` says how many failures had to
 * be reported without one.
 *
 * @param reporter - the reporter.
 * @returns the summary.
 */
function errorSummary(reporter) {
  // This half's own numbers ride along with the reporter's: they are the only answer
  // to "is the watcher seeing anything, and what happened to the failure it saw" that
  // does not require reading a harness log file, and a settings page is where
  // somebody looks first. `seen` is every failure the request-error seam was handed;
  // everything else is where each one went, and the seven buckets always add back up
  // to it. `reported` counts the ones that had a matching attempt and `unattributed`
  // the ones that did not, so the two together are everything queued.
  const watcher = {
    tracked: attempts.size,
    seen: seenCount,
    reported: reportedCount,
    unattributed: unattributedCount,
    ignoredNonInfra,
    ignoredRoute,
    ignoredCollect,
    duplicates: duplicateCount,
    ignoredInternal,
    lastCode: lastIgnoredCode,
    lastKind: lastIgnoredKind,
    // A fresh plain object rather than the live map: the summary is serialized into
    // an answer, and handing out the map itself would let a reader mutate a counter
    // this half owns.
    ignoredByKind: Object.fromEntries(ignoredByKind),
  }
  try {
    return { ...reporter.summary(), ...watcher }
  } catch {
    return {
      enabled: false,
      endpoint: null,
      installId: null,
      queued: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      folded: 0,
      attempts: 0,
      failures: 0,
      successes: 0,
      lastSentAt: null,
      lastStatus: null,
      lastError: null,
      byKind: {},
      nextFlushAt: null,
      ...watcher,
    }
  }
}

/**
 * Run one error-report action from the settings page.
 *
 * `test` proves the whole path end to end — one synthetic record through the same
 * queue, the same scrubber and the same POST a real outage uses — so a person can
 * watch the collector answer without waiting for the site to fall over. `flush`
 * only empties what a real outage already queued.
 *
 * Both settle the folding windows before they send, and both answer with the
 * summary as it stands afterwards, so the page shows what the button actually did.
 *
 * @param reporter - the reporter to drive.
 * @param body - `{ action }`.
 * @returns a promise of `{ ok, ... }` with a fresh summary.
 */
async function errorAction(reporter, body) {
  const action = typeof body?.action === 'string' ? body.action : ''
  if (action !== 'test' && action !== 'flush') {
    return { ok: false, status: 400, error: `неизвестное действие «${action}»` }
  }
  // Answered the way `/apply-models` answers a disabled feature rather than
  // silently doing nothing: the button is off in the UI in this state, so this only
  // fires when the settings changed behind the page's back, and the sentence is
  // what its notice shows.
  if (action === 'test' && readConfig().collectErrors !== true) {
    return { ok: false, status: 200, error: 'сбор ошибок выключен настройкой плагина', ...errorSummary(reporter) }
  }
  if (action === 'test') {
    // Neither a model nor a route is named, on purpose. The collector builds its
    // model universe from its own config and then adds any model id it sees in a
    // report, so a self-test that called itself `rustvy-selftest` invented a row on
    // somebody's public dashboard and left it there for the length of their
    // retention. With no model the record falls into the shared «Без модели» bucket
    // every unidentified report already shares, and with no route it names no
    // provider that does not exist. `code` is what identifies this as a self-test,
    // and it stays.
    reporter.noteFailure({
      status: 503,
      ms: 0,
      err: 'проверочное событие со страницы настроек плагина',
      code: 'TEST',
      kind: 'test',
      at: Date.now(),
    })
  }
  // Settling is what makes either button mean *now*. A record noted a second ago is
  // still inside a folding window that has not expired, so an ordinary flush would
  // find an empty queue and answer `sent: 0` to somebody watching it prove the path
  // works. A window that has not expired is still a record this install owes the
  // collector, and settling delivers it whole with the count it has folded so far.
  await reporter.flush({ settle: true })
  return { ok: true, ...errorSummary(reporter) }
}

/* ------------------------------------------------------------------------- *
 * The uptime panel's mirror
 *
 * The read side of the collector this half already reports to: one aggregated
 * answer per window, mirrored to loopback so the settings page draws it from the
 * same origin as everything else on the page and a browser never talks to a
 * public host directly.
 *
 * Two decisions shape this block. The view's address is *derived* from the report
 * address rather than configured beside it, so one setting names one server and the
 * two paths cannot drift apart. And a view that cannot be fetched is answered from
 * whatever was fetched before, marked stale, rather than refused: an uptime panel
 * that goes blank exactly when the collector is unreachable is a panel that cannot
 * answer the only question anybody ever asked it.
 * ------------------------------------------------------------------------- */

/** The views read so far, one per range, each with the moment it was read. */
const uptimeViews = new Map()

/** In-flight dedupe: one view fetch per range at a time. */
const uptimeInFlight = new Map()

/**
 * The collector's two addresses, derived from the one the settings name.
 *
 * One setting, two paths: the reports and the view live on the same server, so
 * deriving one from the other is what makes them unable to disagree. A profile that
 * repoints the reports repoints the panel with it, and a collector that moves host
 * leaves no stale view address behind.
 *
 * @param config - the settings in force.
 * @returns `{ view, monitor }`, or `undefined` when the endpoint will not parse.
 */
function uptimeUrls(config) {
  // `isHttpUrl` already parsed the value, so the `new URL` below cannot throw — the
  // guard is here for the same reason `sameSite` has one: a derivation that throws
  // would reach a route as a 500 rather than as an answer that says the feature is
  // unavailable, and this runs on a request a panel is waiting on.
  if (!isHttpUrl(config?.uptimeEndpoint)) return undefined
  try {
    const view = new URL(config.uptimeEndpoint)
    view.pathname = '/api/view'
    view.search = ''
    return { view, monitor: `${view.origin}/` }
  } catch {
    return undefined
  }
}

/**
 * The view persisted for one range, when the file holds that range.
 *
 * A range that was never fetched finds nothing here and is refused rather than
 * answered from another range's entry: a thirty-day picture wearing a twenty-four-hour
 * label is worse than no picture at all, and the map is keyed by range for exactly
 * that reason.
 *
 * @param range - the range asked for.
 * @returns `{ range, fetchedAt, view }`, or `undefined`.
 */
function readUptimeFile(range) {
  const entry = readUptimeStore()[range]
  if (entry === undefined) return undefined
  return { range, fetchedAt: entry.fetchedAt, view: entry.view }
}

/**
 * Read one window's view from the collector.
 *
 * @param range - the window to aggregate over.
 * @param urls - the derived collector addresses.
 * @returns a promise of the normalized view.
 * @throws when the collector is unreachable, refuses, or answers something that is
 *   not a view — the caller turns a throw into a stale answer or a 502.
 */
async function fetchUptimeView(range, urls) {
  const target = new URL(urls.view)
  target.searchParams.set('range', range)
  const result = await getUrl(target.href, {
    timeoutMs: UPTIME_TIMEOUT_MS,
    headers: { accept: 'application/json' },
  })
  if (result.status !== 200) throw new Error(`приёмник аптайма ответил ${result.status}`)
  let raw
  try {
    raw = JSON.parse(result.body.toString('utf8'))
  } catch {
    throw new Error('приёмник аптайма ответил не JSON-документом')
  }
  const normalized = normalizeUptimeView(raw)
  if (normalized.ok !== true) throw new Error(normalized.error ?? 'приёмник аптайма не назвал ни одной модели')
  return normalized
}

/**
 * Remember one view: in memory against its range, and on disk as the cold fallback.
 *
 * The whole map is rewritten rather than appended to, so there is one file and one
 * atomic write, and a range that has not been fetched simply is not in it. Reading it
 * back first is what keeps a range another revision fetched from being dropped by
 * this one.
 *
 * A failed write costs the next cold start its fallback and nothing else, so it is
 * logged and swallowed rather than thrown into a route that already has an answer.
 *
 * @param ctx - the plugin context.
 * @param range - the window the view describes.
 * @param view - the normalized view.
 * @returns the cached entry.
 */
function rememberUptimeView(ctx, range, view) {
  const entry = { range, fetchedAt: Date.now(), view }
  uptimeViews.set(range, entry)
  try {
    const views = { ...readUptimeStore(), [range]: { fetchedAt: entry.fetchedAt, view } }
    writeFileAtomic(uptimeFile(), `${JSON.stringify({ version: UPTIME_STORE_VERSION, views }, null, 2)}\n`)
  } catch (error) {
    log(ctx, 'warn', 'картина аптайма не сохранилась на диск', error)
  }
  return entry
}

/**
 * Answer one uptime view request.
 *
 * Cache first, then the collector, then whatever was fetched before — memory, then
 * disk — marked stale and carrying the reason it is stale. Refused only when there
 * is nothing at all to show. Nothing here holds a request open past the fetch
 * budget, and nothing throws out of the route: a panel is a convenience, and a
 * convenience that can hang a page is worse than no panel.
 *
 * @param ctx - the plugin context.
 * @param config - the settings in force.
 * @param range - the window asked for, already validated.
 * @returns a promise of the payload to answer with.
 */
async function uptimePayload(ctx, config, range) {
  if (config.uptimeView !== true) {
    return { ok: false, error: 'аптайм выключен настройкой плагина' }
  }
  const urls = uptimeUrls(config)
  if (urls === undefined) {
    return { ok: false, error: 'адрес сборщика не задан или не является адресом http(s)' }
  }

  const cached = uptimeViews.get(range)
  if (cached !== undefined && Date.now() - cached.fetchedAt <= UPTIME_TTL_MS) {
    return { ...cached.view, fetchedAt: cached.fetchedAt, stale: false, monitorUrl: urls.monitor }
  }

  // One fetch per range at a time: a page that repaints, or one that asks for all
  // three windows at once, must not become a burst at a collector that rate-limits
  // by address — the same address this install's error reports are sent from.
  const flying = uptimeInFlight.get(range)
  const task = flying ?? fetchUptimeView(range, urls)
    .then(view => rememberUptimeView(ctx, range, view))
    .finally(() => { uptimeInFlight.delete(range) })
  if (flying === undefined) uptimeInFlight.set(range, task)

  try {
    const entry = await task
    return { ...entry.view, fetchedAt: entry.fetchedAt, stale: false, monitorUrl: urls.monitor }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(ctx, 'warn', `картину аптайма за период «${range}» получить не удалось`, error)
    const fallback = cached ?? readUptimeFile(range)
    if (fallback !== undefined) {
      return { ...fallback.view, fetchedAt: fallback.fetchedAt, stale: true, error: reason, monitorUrl: urls.monitor }
    }
    return { ok: false, status: 502, error: reason }
  }
}

/**
 * Read one request body, with a limit.
 *
 * @param request - the incoming request.
 * @param limit - the largest accepted body, in bytes.
 * @returns a promise of the parsed JSON, or `{}` for an empty body.
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        request.destroy()
        reject(new Error('the request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text === '' ? {} : JSON.parse(text))
      } catch {
        reject(new Error('the request body is not JSON'))
      }
    })
    request.once('error', () => reject(new Error('the request body could not be read')))
  })
}

/** Answer one request with JSON and no caching. */
function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Answer one request with plain text and no caching. */
function sendText(response, status, body, type, method) {
  const bytes = Buffer.from(body)
  response.writeHead(status, {
    'content-type': type,
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
  })
  response.end(method === 'HEAD' ? undefined : bytes)
}

/** Refuse any method outside the given list. */
function methodRefused(request, response, methods) {
  if (request.method !== undefined && methods.includes(request.method)) return false
  response.writeHead(405, { allow: methods.join(', ') })
  response.end()
  return true
}

/**
 * Only this machine may read the mirror: these routes are plugin registrations
 * on the bare web server, so the host's own request fence never sees them and
 * this check stands in for it. The catalog carries no secrets, but a route that
 * answers a remote peer with locally fetched bytes is a proxy, and this plugin
 * is not one.
 *
 * @param request - the incoming request.
 * @returns an HTTP status to refuse with, or `undefined` to admit the request.
 */
function refusalOf(request) {
  const address = String(request.socket?.remoteAddress ?? '')
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const loopback = plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(plain)
  if (!loopback) return 403
  const host = request.headers.host
  if (host !== undefined) {
    if (!URL.canParse(`http://${host}`)) return 403
    const hostname = new URL(`http://${host}`).hostname
    if (hostname !== 'localhost' && hostname !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/u.test(hostname)) return 403
  }
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 403
  const origin = request.headers.origin
  if (origin === undefined) return undefined
  if (!URL.canParse(origin)) return 403
  return new URL(origin).host === host ? undefined : 403
}

/**
 * Mount the mirror's routes, warm the cache, and hand back the disposer.
 *
 * Routes are registered before any network work so a duplicate registration —
 * another revision of this plugin still holding the seat — fails here rather
 * than after a fetch has been started.
 *
 * @param ctx - a context that already has the web server.
 * @param options - `{ reload }`, invoked by the status page's reload button.
 * @returns `{ dispose }`, awaited by the stable entry on reload and unload.
 */
export async function start(ctx, options = {}) {
  const reload = typeof options.reload === 'function' ? options.reload : () => {}
  const server = ctx.webServer
  if (server === null || server === undefined || typeof server.register !== 'function') {
    throw new Error('the host carries no webServer service, so this plugin has nowhere to serve its mirror')
  }

  loadCachedCatalog()
  mirror.logos = countCachedLogos()

  // Built before the routes are registered, because both `/state` and `/errors`
  // answer from it. One identity per install, read or created here: it is what
  // lets the collector count people without ever being told who they are.
  const reporter = createErrorReporter(ctx)

  const disposers = []
  const register = route => {
    try {
      const dispose = server.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(ctx, 'error', 'маршрут не зарегистрировался', error)
      throw error
    }
  }

  register({
    kind: 'prefix',
    path: PREFIX,
    handler: (request, response) => {
      const refused = refusalOf(request)
      if (refused !== undefined) {
        sendJson(response, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      const sub = new URL(request.url ?? '/', 'http://local').pathname.slice(PREFIX.length)
      const config = readConfig()

      if (sub === '/catalog.json') {
        if (methodRefused(request, response, ['GET', 'HEAD'])) return
        void catalogPayload(ctx, config).then(
          payload => { sendJson(response, 200, payload) },
          error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }

      if (sub === '/models.json') {
        if (methodRefused(request, response, ['GET', 'HEAD'])) return
        // `?cached=1` reports the drift already computed, for a settings page that
        // repaints often; the default reads the route's endpoint, because a stale
        // answer to "what does the provider serve" is the wrong answer.
        const cached = new URL(request.url ?? '/', 'http://local').searchParams.get('cached') === '1'
        void modelPlan(ctx, config, { skipFetch: cached }).then(
          plan => { sendJson(response, 200, { ok: true, ...describePlan(plan) }) },
          error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }

      if (sub === '/models.yaml') {
        if (methodRefused(request, response, ['GET', 'HEAD'])) return
        const cached = new URL(request.url ?? '/', 'http://local').searchParams.get('cached') === '1'
        void modelPlan(ctx, config, { skipFetch: cached }).then(
          plan => { sendText(response, 200, planYaml(plan), 'text/yaml; charset=utf-8', request.method) },
          error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }

      if (sub === '/uptime.json') {
        if (methodRefused(request, response, ['GET', 'HEAD'])) return
        // Capped before it is echoed back: unlike a body, a query string has no
        // length limit of its own.
        const asked = (new URL(request.url ?? '/', 'http://local').searchParams.get('range') ?? DEFAULT_RANGE).slice(0, 64)
        if (!isUptimeRange(asked)) {
          // The collector's own sentence in this file's language, whitelist and all:
          // naming the accepted values is what turns a 400 into something a caller
          // can act on instead of something it has to guess at.
          sendJson(response, 400, { ok: false, error: `недопустимый период «${asked}»; допустимы: ${UPTIME_RANGES.join(', ')}` })
          return
        }
        void uptimePayload(ctx, config, asked).then(
          payload => {
            // `status` routes the answer and is not part of it: a body that carried
            // its own HTTP status would be a second source of truth for one fact.
            const { status, ...body } = payload
            sendJson(response, status ?? 200, body)
          },
          error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }

      if (sub === '/state') {
        if (methodRefused(request, response, ['GET', 'HEAD'])) return
        // The status page must stay cheap, so drift is reported from the last
        // computed plan, or from the mirror alone when there is none yet. Either
        // way no request leaves the process to answer it.
        void (async () => {
          const plan = lastPlan ?? await modelPlan(ctx, config, { skipFetch: true })
          sendJson(response, 200, {
            ok: true,
            build,
            revision: REVISION,
            config,
            version: mirror.version,
            fetchedAt: mirror.fetchedAt,
            refreshing: mirror.refreshing,
            models: catalog?.records.length ?? 0,
            logos: countCachedLogos(),
            route: mirror.lastRoute,
            proxy: proxyForTarget(new URL(config.origin))?.href.replace(/\/\/[^@/]+@/u, '//***@') ?? 'none',
            cacheDir: stateDir(),
            // Named so a profile author can open every file this half touches,
            // including the patch document a manual model-list edit belongs in.
            paths: {
              cache: stateDir(),
              catalog: catalogFile(),
              config: configFile(),
              backup: modelsBackupFile(),
              patch: patchPathOf(ctx) ?? null,
              install: installFile(),
              errorsQueue: errorsQueueFile(),
              uptime: uptimeFile(),
            },
            node: process.version,
            absentLogos: [...mirror.absent],
            logoFailures: Object.fromEntries(mirror.failures),
            modelSync: describePlan(plan),
            apiKeys: ringSummary(ctx, config),
            errorReport: errorSummary(reporter),
            ...mirror.lastError === null ? {} : { error: mirror.lastError },
          })
        })().catch(error => {
          if (!response.headersSent) {
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })
        return
      }

      if (sub === '/keys') {
        if (request.method === 'GET' || request.method === 'HEAD') {
          void describeRing(ctx, config).then(
            payload => { sendJson(response, 200, payload) },
            error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }
        if (request.method !== 'POST') {
          methodRefused(request, response, ['GET', 'HEAD', 'POST'])
          return
        }
        // A key value travels in the body, never in a query string: a URL is
        // logged, cached and shown in a browser's history, and a secret is none
        // of those things' business.
        void readBody(request, 16_384).then(
          body => keyAction(ctx, body).then(
            payload => { sendJson(response, payload.ok === false ? (payload.status ?? 409) : 200, payload) },
            error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          ),
          error => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }

      if (sub === '/session-key') {
        const query = new URL(request.url ?? '/', 'http://local').searchParams
        if (request.method === 'GET' || request.method === 'HEAD') {
          const sessionId = query.get('sessionId') ?? ''
          if (!SESSION_ID.test(sessionId)) {
            sendJson(response, 400, { ok: false, error: 'не передан идентификатор чата' })
            return
          }
          void (async () => {
            const payload = await describeRing(ctx, config)
            sendJson(response, 200, {
              ...payload,
              sessionId,
              keyId: effectiveKeyId(ctx, config, sessionId),
              picked: picks.has(sessionId),
            })
          })().catch(error => {
            if (!response.headersSent) {
              sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          })
          return
        }
        if (request.method !== 'POST') {
          methodRefused(request, response, ['GET', 'POST'])
          return
        }
        void readBody(request, 4096).then(body => {
          const result = setSessionKey(ctx, config, body)
          if (result.ok !== true) {
            sendJson(response, 400, result)
            return
          }
          void describeRing(ctx, readConfig()).then(
            payload => { sendJson(response, 200, { ...payload, sessionId: result.sessionId, keyId: result.keyId }) },
            error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
        }, error => {
          sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
        return
      }

      if (sub === '/errors') {
        if (request.method === 'GET' || request.method === 'HEAD') {
          sendJson(response, 200, { ok: true, ...errorSummary(reporter) })
          return
        }
        if (request.method !== 'POST') {
          methodRefused(request, response, ['GET', 'HEAD', 'POST'])
          return
        }
        void readBody(request, 4096).then(
          body => errorAction(reporter, body).then(
            payload => { sendJson(response, payload.ok === false ? (payload.status ?? 400) : 200, payload) },
            error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          ),
          error => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }

      if (sub === '/refresh' || sub === '/config' || sub === '/apply-models' || sub === '/revert-models') {
        if (methodRefused(request, response, ['POST'])) return
        const chunks = []
        let size = 0
        request.on('data', chunk => {
          size += chunk.length
          if (size > 4096) request.destroy()
          else chunks.push(chunk)
        })
        request.once('end', () => {
          let body = {}
          try {
            const text = Buffer.concat(chunks).toString('utf8').trim()
            body = text === '' ? {} : JSON.parse(text)
          } catch {
            sendJson(response, 400, { ok: false, error: 'the request body is not JSON' })
            return
          }
          const apply = async () => {
            // `/config` only writes settings: a toggle must not turn into a round
            // trip to the origin. `/refresh` is the one that fetches.
            if (sub === '/config') {
              writeConfig(body)
              return catalogPayload(ctx, readConfig())
            }
            if (sub === '/apply-models') {
              const next = readConfig()
              if (!next.syncModels) {
                return { ok: false, applied: false, error: 'синхронизация моделей выключена настройкой плагина' }
              }
              const plan = await modelPlan(ctx, next)
              return { ...await applyModelPlan(ctx, next, plan), plan: describePlan(plan) }
            }
            if (sub === '/revert-models') {
              const next = readConfig()
              const result = await revertModels(ctx, next)
              return { ...result, plan: describePlan(await modelPlan(ctx, next, { skipFetch: true })) }
            }
            // `/refresh` is an explicit "try again", so it refreshes both halves:
            // the marks, and the list of models the route serves.
            const next = readConfig()
            await refreshCatalog(ctx, next)
            const payload = await catalogPayload(ctx, next)
            if (!next.syncModels) return payload
            const plan = await modelPlan(ctx, next)
            const result = autoApplies(next, 'explicit')
              ? await applyModelPlan(ctx, next, plan)
              : { ok: true, applied: false, held: true }
            payload.modelSync = { ...result, plan: describePlan(plan) }
            return payload
          }
          void apply().then(
            payload => { sendJson(response, 200, payload) },
            error => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
        })
        request.once('error', () => {
          if (!response.headersSent) sendJson(response, 400, { ok: false, error: 'the request body could not be read' })
        })
        return
      }

      if (sub.startsWith('/logo/')) {
        if (methodRefused(request, response, ['GET', 'HEAD'])) return
        const logo = decodeURIComponent(sub.slice('/logo/'.length))
        // The name is matched against one strict shape and never joined with a
        // caller-controlled path, so the cache directory is the whole reachable
        // filesystem for this route.
        if (!LOGO_NAME.test(logo) || logo.includes('..')) {
          response.writeHead(400, { 'cache-control': 'no-store' })
          response.end()
          return
        }
        const answer = async () => {
          const bytes = readCachedLogo(logo) ?? await fetchLogo(ctx, logo, config)
          if (bytes === undefined) {
            response.writeHead(404, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          response.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'content-length': String(bytes.byteLength),
            // The name is not content-hashed, so this is a short-lived cache: a
            // changed mark at the origin arrives within a day, and the browser
            // revalidates on the way.
            'cache-control': 'public, max-age=3600',
          })
          response.end(request.method === 'HEAD' ? undefined : bytes)
        }
        void answer().catch(error => {
          log(ctx, 'warn', `не удалось отдать ${logo}`, error)
          if (!response.headersSent) {
            response.writeHead(500, { 'cache-control': 'no-store' })
            response.end()
          }
        })
        return
      }

      response.writeHead(404, { 'cache-control': 'no-store' })
      response.end()
    },
  })

  // Warm the mirror once at mount, without holding the mount on the network: a
  // stale or empty cache refreshes in the background, and the picker draws its
  // marks from whatever the cache already holds.
  const config = readConfig()
  const age = mirror.fetchedAt === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(mirror.fetchedAt)
  const stale = catalog === null || age > CATALOG_TTL_MS
  if (config.enabled) {
    if (stale) void refreshCatalog(ctx, config).catch(() => {})
  } else {
    log(ctx, 'info', 'иконки моделей выключены настройкой плагина')
  }

  // Model sync is its own feature behind its own switch: a profile that wants no
  // marks may still want a current model list, and the list's primary source is
  // the route's endpoint rather than the mirrored island.
  if (config.syncModels) {
    void (async () => {
      if (stale && config.enabled) await refreshCatalog(ctx, config)
      const plan = await modelPlan(ctx, config)
      if (!plan.available) {
        log(ctx, 'warn', 'синхронизация моделей недоступна: хост не отдаёт configEditor')
        return
      }
      if (autoApplies(config, 'background')) {
        const result = await applyModelPlan(ctx, config, plan)
        if (result.applied === true) {
          log(ctx, 'info', `маршрут ${plan.route}: список моделей синхронизирован при запуске (${plan.count})`)
        } else if (result.ok === false) {
          log(ctx, 'warn', `маршрут ${plan.route}: список моделей не обновлён — ${result.error}`)
        }
      } else if (!plan.diff.upToDate) {
        log(ctx, 'info', `маршрут ${plan.route}: список моделей устарел — добавить ${plan.diff.added.length}, убрать ${plan.diff.removed.length}, изменить ${plan.diff.changed.length}`)
      }
    })().catch(error => log(ctx, 'warn', 'синхронизация моделей при запуске не удалась', error))
  }

  // Registration order is load-bearing here, and it is the only place in this file
  // where it is: Cordis composes a waterfall outermost-first, so the error watcher
  // has to go on *before* the key ring's to sit outside it. `await next()` in the
  // watcher then answers with the route the ring renamed the request to, which is
  // the route a failure really fell on — installed the other way round, every
  // report would name the base route and the monitor could not tell one key's
  // outage from another's. A future edit that reorders these two lines silently
  // breaks the uptime data and nothing else.
  disposers.push(installErrorWatch(ctx, reporter))
  reporter.start()
  if (!config.collectErrors) log(ctx, 'info', 'сбор ошибок rustvy выключен настройкой плагина')

  // The per-chat key swap lives exactly as long as this revision: one listener,
  // disposed with the routes, so a reload never leaves two of them rewriting
  // provider routes and a chat's requests never go to a key nobody picked.
  disposers.push(installKeyRouting(ctx))
  if (config.apiKeys) {
    const ringState = ringSummary(ctx, config)
    if (ringState.count > 1) {
      log(ctx, 'info', `кольцо ключей: ${ringState.count}, по умолчанию «${ringState.defaultKeyId}», чатов с собственным выбором ${ringState.picks}`)
    }
    if (!ringState.credentials) log(ctx, 'warn', 'сервис credentials не смонтирован — добавить ключ в плагине нельзя')
    else if (!ringState.editor) log(ctx, 'warn', 'configEditor не отдан — значение ключа сохранить можно, маршрут для него нет')
    if (ringState.missing.length > 0) {
      log(ctx, 'warn', `маршруты ключей отсутствуют в профиле: ${ringState.missing.join(', ')} — кнопка «Починить маршруты» на странице настроек`)
    }
  }

  log(ctx, 'info', `host-половина загружена: ревизия ${REVISION}, сборка ${build}, каталог ${mirror.count} моделей, ${mirror.logos} иконок`)
  let disposed = false
  return {
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A route already gone is not a failure to unload.
        }
      }
      try {
        reporter.dispose()
      } catch {
        // A reporter that will not stop is not a failure to unload either.
      }
      // Nothing is observing any more, so an attempt left open would only be a
      // step the next revision has no listener for.
      attempts.clear()
      // Both watcher counters belong to the revision that counted them: a reload is
      // a clean dispose-and-start, and a number carried over from a revision whose
      // listeners are gone would describe a watcher that no longer exists.
      unattributedCount = 0
      warnedUnattributed = false
      warnedCollectorWarnings = false
      seenCount = 0
      reportedCount = 0
      ignoredNonInfra = 0
      ignoredRoute = 0
      ignoredCollect = 0
      duplicateCount = 0
      ignoredInternal = 0
      lastIgnoredCode = null
      lastIgnoredKind = null
      ignoredByKind.clear()
      for (const task of logoInFlight.values()) void task.catch(() => {})
      logoInFlight.clear()
      for (const task of uptimeInFlight.values()) void task.catch(() => {})
      uptimeInFlight.clear()
      // The same rule as the attempts: a reload is a clean dispose-and-start, so a
      // view fetched by the old revision is not the new one's to serve. What was
      // persisted stays on disk, which is exactly the fallback a cold mount wants.
      uptimeViews.clear()
      if (existsSync(stateDir())) mirror.logos = countCachedLogos()
    },
  }
}
