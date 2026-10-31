// The `collectSuccesses` setting: its default, its three sources, and its publication.
//
// Deliberately separate from the four-combination behaviour matrix, which asserts what
// the reporter does with the setting and so depends on the success gate in
// `lib/errors.js`. Everything here is this half's own plumbing and is testable without
// it: a setting that does not survive a round trip through the settings file cannot be
// honoured at attempt time whatever the reporter does later.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-successes-'))
const STATE = join(PROFILE, '.dsh-rustvy')
mkdirSync(STATE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE
delete process.env.DSH_RUSTVY_NO_ERRORS
delete process.env.DSH_RUSTVY_NO_SUCCESSES

const { start } = await import('../lib/host.js')

const results = []
/**
 * Record one assertion.
 *
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside the label, truncated so a failure stays readable.
 */
function check(label, ok, detail) {
  const shown = detail === undefined ? '' : `  — ${String(detail).slice(0, 400)}`
  results.push({ label, ok: ok === true, detail: shown })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${shown}`)
}

/**
 * Mount the plugin and read its state.
 *
 * @returns the parsed `/state` answer, plus the handle so the caller can dispose.
 */
async function stateOf() {
  let route = null
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    profileContext: { patchPath: 'C:\\profile\\cordis.patch.yml' },
    on: () => () => {},
  }
  ctx.webServer = { register: r => { route = r; return () => { route = null } } }
  const handle = await start(ctx, {})
  const answer = await new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = 'GET'
    request.url = '/dsh-rustvy/state'
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); return this },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        resolve(JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(String(c)))).toString('utf8')))
      },
    }
    route.handler(request, response)
    request.emit('end')
    setTimeout(() => reject(new Error('timeout')), 30_000).unref()
  })
  return { answer, handle, call: (method, path, body) => new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = method
    request.url = path
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); return this },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        const text = Buffer.concat(chunks.map(c => Buffer.from(String(c)))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, json, text })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    setTimeout(() => reject(new Error(`timeout ${method} ${path}`)), 30_000).unref()
  }) }
}

const settingsFile = join(STATE, 'config.json')
/**
 * Write the settings file, replacing it entirely.
 *
 * @param values - the settings to store.
 */
function writeSettings(values) {
  writeFileSync(settingsFile, `${JSON.stringify(values, null, 2)}\n`)
}

// --- the default is on, and the two settings are independent keys --------------
writeSettings({})
let mounted = await stateOf()
check('the default is on', mounted.answer?.config?.collectSuccesses === true, String(mounted.answer?.config?.collectSuccesses))
check('it is a separate key from error collection', 'collectSuccesses' in (mounted.answer?.config ?? {}) && 'collectErrors' in (mounted.answer?.config ?? {}), JSON.stringify(Object.keys(mounted.answer?.config ?? {}).filter(k => k.startsWith('collect'))))
check('the error setting keeps its own default', mounted.answer?.config?.collectErrors === true, String(mounted.answer?.config?.collectErrors))
// The counter has to be readable for the page to tell "off" from "nothing yet", and it
// arrives through the reporter's own summary rather than as a field of mine.
check('the success counter is on the state the page reads', typeof mounted.answer?.errorReport?.successes === 'number', String(mounted.answer?.errorReport?.successes))
await mounted.handle.dispose()

// --- the stored setting is honoured, in both directions ------------------------
writeSettings({ collectSuccesses: false, collectErrors: true })
mounted = await stateOf()
check('a stored false is honoured', mounted.answer?.config?.collectSuccesses === false, String(mounted.answer?.config?.collectSuccesses))
check('it does not drag the error setting with it', mounted.answer?.config?.collectErrors === true, String(mounted.answer?.config?.collectErrors))
await mounted.handle.dispose()

writeSettings({ collectSuccesses: true, collectErrors: false })
mounted = await stateOf()
check('the reverse combination is honoured too', mounted.answer?.config?.collectSuccesses === true && mounted.answer?.config?.collectErrors === false, JSON.stringify({ successes: mounted.answer?.config?.collectSuccesses, errors: mounted.answer?.config?.collectErrors }))
await mounted.handle.dispose()

// A value that is not a boolean is not a setting: it is dropped rather than coerced, so
// a hand-edited file cannot turn the feature into something the page cannot render.
writeSettings({ collectSuccesses: 'yes' })
mounted = await stateOf()
check('a non-boolean falls back to the default rather than being coerced', mounted.answer?.config?.collectSuccesses === true, String(mounted.answer?.config?.collectSuccesses))
await mounted.handle.dispose()

// --- the environment has the same absolute say it has over errors --------------
writeSettings({ collectSuccesses: true })
process.env.DSH_RUSTVY_NO_SUCCESSES = '1'
mounted = await stateOf()
check('the environment silences it over the profile setting', mounted.answer?.config?.collectSuccesses === false, String(mounted.answer?.config?.collectSuccesses))
await mounted.handle.dispose()
process.env.DSH_RUSTVY_NO_SUCCESSES = 'true'
mounted = await stateOf()
check('the word true silences it as well', mounted.answer?.config?.collectSuccesses === false, String(mounted.answer?.config?.collectSuccesses))
await mounted.handle.dispose()
delete process.env.DSH_RUSTVY_NO_SUCCESSES
mounted = await stateOf()
check('unset, the profile setting is in force again', mounted.answer?.config?.collectSuccesses === true, String(mounted.answer?.config?.collectSuccesses))
await mounted.handle.dispose()

// --- the toggle round-trips through the settings write -------------------------
writeSettings({})
mounted = await stateOf()
const wrote = await mounted.call('POST', '/dsh-rustvy/config', { collectSuccesses: false })
check('the settings write is accepted', wrote.status === 200, `${wrote.status} ${wrote.text?.slice(0, 160)}`)
const stored = JSON.parse(readFileSync(settingsFile, 'utf8'))
check('the change reached the settings file', stored?.config?.collectSuccesses === false || stored?.collectSuccesses === false, JSON.stringify(stored).slice(0, 240))
const afterWrite = await mounted.call('GET', '/dsh-rustvy/state')
check('and is what the next state read reports', afterWrite.json?.config?.collectSuccesses === false, String(afterWrite.json?.config?.collectSuccesses))
// Writing one setting must not disturb the other, or the page's two toggles would be
// one toggle with two handles.
check('writing it left the error setting alone', afterWrite.json?.config?.collectErrors === true, String(afterWrite.json?.config?.collectErrors))
// A patch that does not mention the key keeps what is there: absence in a patch is not
// a request to reset.
const partial = await mounted.call('POST', '/dsh-rustvy/config', { collectErrors: false })
check('an unrelated patch is accepted', partial.status === 200, String(partial.status))
const afterPartial = await mounted.call('GET', '/dsh-rustvy/state')
check('a patch that omits the key does not reset it', afterPartial.json?.config?.collectSuccesses === false, String(afterPartial.json?.config?.collectSuccesses))
check('and the key it did name changed', afterPartial.json?.config?.collectErrors === false, String(afterPartial.json?.config?.collectErrors))
await mounted.handle.dispose()

// --- the window is published but is not a setting ------------------------------
// errors-core's question, answered with a measurement rather than an argument: the
// value sits in `config` beside real settings, so it looks editable, but it is the
// reporter's own constant published for display. If a hand edit could move it, the
// published number would stop describing the aggregation actually in force and one
// decider would have become two. Both normalization paths drop it, so it cannot.
writeSettings({ successWindowMs: 60_000, collectSuccesses: true })
mounted = await stateOf()
check('a hand-edited window is ignored, not honoured', mounted.answer?.config?.successWindowMs === 900_000, String(mounted.answer?.config?.successWindowMs))
await mounted.handle.dispose()

writeSettings({})
const windowPatch = await stateOf()
await windowPatch.call('POST', '/dsh-rustvy/config', { successWindowMs: 60_000 })
const afterWindowPatch = await windowPatch.call('GET', '/dsh-rustvy/state')
check('the settings write cannot move it either', afterWindowPatch.json?.config?.successWindowMs === 900_000, String(afterWindowPatch.json?.config?.successWindowMs))
await windowPatch.handle.dispose()

rmSync(PROFILE, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.label}${result.detail}`)
  process.exit(1)
}
