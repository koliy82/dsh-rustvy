/**
 * dsh-rustvy — stable loader entry.
 *
 * This file is deliberately tiny and rarely changes, because the harness caches
 * one ES module per resolved URL and does not evict that cache for a profile
 * plugin: editing a loaded host half in place has no effect until the process
 * restarts. So the entry does no work itself — it loads `./host.js`, and it can
 * load it again.
 *
 * How an edit becomes live without a restart:
 *
 *   - `./host.js` — and, through it, `./net.js`, `./models.js` and `./keys.js` —
 *     is imported through a cache-busting `?rev=<n>` query. Node keys its ESM
 *     cache by the full URL, so each revision is a distinct module and the file
 *     is really re-read from disk.
 *   - A one-second poll fingerprints this package's `lib` directory. When the
 *     fingerprint has been different twice in a row — so a half-copied file is
 *     never loaded — the implementation is disposed and started again.
 *
 * A reload disposes the previous implementation first and installs the next one
 * after, so the routes are registered by exactly one instance. A revision that
 * arrives while another instance still holds the route seat fails with a
 * duplicate-route error and retries with backoff instead of half installing.
 *
 * This file is the package main, and the bundle's `cordis.patch.yml` names the
 * package by its bare name so the plugin manager can read `locale/*.json` and
 * show the row as "Rustvy". That also means this bootstrap is read once per
 * process — the harness caches a module per resolved URL and never evicts it for
 * a profile plugin — which is why it deliberately owns no behaviour: everything
 * that changes lives in the modules it re-imports under a fresh `?rev=`.
 *
 * @module dsh-rustvy
 */

import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Loader-facing plugin name. */
export const name = 'dsh-rustvy'

/** Directory holding this entry and the implementation it loads. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The implementation module, re-imported under a new query on every reload.
 *
 * It is addressed as an absolute `file:` URL rather than as `./host.js` on
 * purpose: the harness routes relative and bare specifiers through its own
 * resolver, but an absolute file URL goes straight to Node, and a reload must
 * not depend on that router.
 */
const IMPL = pathToFileURL(join(HERE, 'host.js')).href

/** How often the `lib` directory is fingerprinted, in milliseconds. */
const POLL_MS = 1000

/** First retry delay after a lost route race, in milliseconds. */
const RETRY_MS = 500

/** Longest retry delay, in milliseconds. */
const RETRY_MAX_MS = 8000

/**
 * Per-instance prefix for revision ids. A plain counter would collide across
 * instances: two copies of this entry can coexist briefly — a row re-added after
 * a removal, or a patch that resolves a different specifier than the one a
 * running process already loaded — and the second copy would start its own
 * counter at one and import `host.js?rev=1`, which the first copy already cached.
 * It would then silently run the *older* implementation. A random per-instance
 * prefix makes every revision URL this instance asks for one it alone has asked
 * for.
 */
const INSTANCE = Math.random().toString(36).slice(2, 8)

let revision = 0
let running = null
let scoped = null
let timer = null
let busy = false
let signature = null
let candidate = null
let retryDelay = RETRY_MS
let retryTimer = null
let stopping = false

/** Log through the loader's logger, falling back to the console. */
function note(level, message, error) {
  const logger = typeof scoped?.logger === 'function' ? scoped.logger(name) : scoped?.logger
  const sink = logger?.[level]
  if (typeof sink === 'function') sink.call(logger, message, ...(error === undefined ? [] : [error]))
  else if (level === 'warn' || level === 'error') console.error(`[${name}] ${message}`, error ?? '')
  else console.log(`[${name}] ${message}`)
}

/**
 * Fingerprint every file in this package's `lib` directory by name, size and
 * modification time: cheap enough to run once a second, and sensitive to the
 * only thing that matters here — whether the code on disk changed.
 *
 * @returns a stable string that changes when any file changes.
 */
function fingerprint() {
  try {
    return readdirSync(HERE)
      .map(entry => {
        try {
          const stats = statSync(join(HERE, entry))
          return `${entry}:${stats.size}:${stats.mtimeMs}`
        } catch {
          return `${entry}:gone`
        }
      })
      .sort()
      .join('|')
  } catch (error) {
    note('warn', 'не удалось прочитать каталог плагина', error)
    return ''
  }
}

/**
 * Dispose the running implementation, if any. Failures are logged, because a
 * reload must proceed even if the previous revision refuses to let go.
 */
async function stopRunning() {
  const previous = running
  running = null
  if (previous === null) return
  try {
    await previous.dispose()
  } catch (error) {
    note('warn', 'предыдущая ревизия не выгрузилась чисто', error)
  }
}

/**
 * Install the newest revision of the implementation.
 *
 * @param reason - why the load is happening, for the log line.
 * @param attempt - retry attempt number, used to back off after a lost race.
 */
async function install(reason, attempt = 0) {
  if (scoped === null || stopping) return
  const ctx = scoped
  await stopRunning()
  const rev = `${INSTANCE}.${++revision}`
  try {
    const module = await import(`${IMPL}?rev=${rev}`)
    running = await module.start(ctx, { reload: why => install(why) })
    retryDelay = RETRY_MS
    note('info', `host-половина загружена: ревизия ${rev}, сборка ${module.build ?? '?'} (${reason})`)
  } catch (error) {
    const message = String(error?.message ?? error)
    // Another instance still holds the route seat: wait for it to go, rather
    // than failing the plugin. This is the takeover path during a swap.
    if (/duplicate|already registered|занят/iu.test(message)) {
      note('info', `маршруты ещё заняты предыдущей копией — повтор через ${retryDelay} мс`)
      if (retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
          void install('маршруты освободились', attempt + 1)
        }, retryDelay)
      }
      return
    }
    note('error', `не удалось загрузить host-половину (${reason})`, error)
  }
}

/**
 * Plugin entry point: wait for the web server, then keep the implementation
 * loaded and current for as long as the plugin is mounted.
 *
 * @param ctx - the host cordis context supplied by the loader.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], inner => {
    scoped = inner
    inner.effect(() => {
      stopping = false
      signature = fingerprint()
      candidate = null
      void install('первая загрузка')

      timer = setInterval(() => {
        if (busy || stopping) return
        busy = true
        try {
          const next = fingerprint()
          if (next === signature) {
            candidate = null
            return
          }
          // Seen once: a copy may still be in flight. Confirm on the next tick.
          if (next !== candidate) {
            candidate = next
            return
          }
          candidate = null
          signature = next
          void install('файлы изменились')
        } finally {
          busy = false
        }
      }, POLL_MS)

      return () => {
        stopping = true
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        scoped = null
        return stopRunning()
      }
    }, 'dsh-rustvy: implementation reload')
  })
}
