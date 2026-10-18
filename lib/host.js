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
 * @module dsh-rustvy/host
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Build marker surfaced by `/state`; bump it to watch a reload land. */
export const build = 'rustvy-1'

/**
 * The revision this copy was loaded under, forwarded to the relative import so
 * Node's URL-keyed module cache hands a reload a fresh module graph.
 */
const REVISION = new URL(import.meta.url).searchParams.get('rev') ?? '0'

const NET = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'net.js')).href
const { getUrl, proxyForTarget } = await import(`${NET}?rev=${REVISION}`)

const MODELS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'models.js')).href
const {
  mirrorRecord, normalizeServedList, buildModelEntries, diffModels, servedFromCatalog, routePatchYaml,
} = await import(`${MODELS}?rev=${REVISION}`)

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
  }
  const origin = process.env[ENV_ORIGIN]
  if (typeof origin === 'string' && /^https?:\/\//iu.test(origin.trim())) merged.origin = origin.trim()
  const disabled = process.env[ENV_DISABLED]
  if (disabled === '1' || disabled === 'true') merged.enabled = false
  merged.origin = merged.origin.replace(/\/+$/u, '')
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
    config: { size: config.size, markTrigger: config.markTrigger, hideOtherMarks: config.hideOtherMarks, origin: config.origin },
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
  const usable = editor => (typeof editor?.edit === 'function' && typeof editor?.entries === 'function' ? editor : undefined)
  const attempts = [
    () => (typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined),
    () => (typeof ctx?.reflect?.get === 'function' ? ctx.reflect.get('configEditor') : undefined),
    () => ctx?.configEditor,
  ]
  for (const attempt of attempts) {
    try {
      const editor = usable(attempt())
      if (editor !== undefined) return editor
    } catch {
      // A context that refuses an undeclared read simply has nothing to offer.
    }
  }
  return undefined
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

  lastPlan = {
    available: editor !== undefined,
    entryId: entry?.options?.id ?? null,
    packageName: entry?.options?.name ?? PI_AI_PACKAGE,
    route: config.modelRoute,
    baseURL,
    modelsUrl: `${baseURL.replace(/\/+$/u, '')}/models`,
    providerFields,
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
  if (plan.diff.upToDate) {
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
      const providers = { ...(current?.providers ?? {}) }
      providers[config.modelRoute] = {
        ...(providers[config.modelRoute] ?? {}),
        models: structuredClone(plan.entries),
      }
      return { ...(current ?? {}), providers }
    })
  } catch (error) {
    log(ctx, 'error', 'список моделей не записался', error)
    return { ok: false, applied: false, error: error instanceof Error ? error.message : String(error) }
  }

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
  log(ctx, 'info', `маршрут ${config.modelRoute}: список моделей обновлён — добавлено ${plan.diff.added.length}, убрано ${plan.diff.removed.length}, изменено ${plan.diff.changed.length}, всего ${plan.count}`)
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
  return routePatchYaml({
    entryId: plan.entryId ?? 'llm-pi-ai',
    packageName: plan.packageName ?? PI_AI_PACKAGE,
    providerKey: plan.route,
    provider: plan.providerFields,
    models: plan.entries,
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
            },
            node: process.version,
            absentLogos: [...mirror.absent],
            logoFailures: Object.fromEntries(mirror.failures),
            modelSync: describePlan(plan),
            ...mirror.lastError === null ? {} : { error: mirror.lastError },
          })
        })().catch(error => {
          if (!response.headersSent) {
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })
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
      for (const task of logoInFlight.values()) void task.catch(() => {})
      logoInFlight.clear()
      if (existsSync(stateDir())) mirror.logos = countCachedLogos()
    },
  }
}
