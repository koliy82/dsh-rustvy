/**
 * Packet-level DPI evasion: downloading zapret's `winws` and running it as a service.
 *
 * Why this exists when the plugin already fragments the ClientHello. Every technique that
 * defeats a filter which *reassembles* TCP needs control of the packets, and no socket API has
 * it:
 *
 * - `--dpi-desync=fake` injects a decoy packet carrying a benign ClientHello onto the same
 *   connection, before the real one. Written through an ordinary socket it would simply be part
 *   of the real stream and corrupt it.
 * - `--dpi-desync-split-seqovl=N` makes the segments overlap in TCP sequence space, so the filter
 *   and the server reconstruct *different* streams. Sequence numbers are assigned by the kernel;
 *   a caller cannot express an overlap.
 *
 * Our own fragmentation is the `multisplit` family, and in zapret's published test data — 21
 * result files, aggregated per config — that family is the weakest: the default
 * `multisplit`+`split-seqovl` config scores 31.1% success against 78.6% for `fake,fakedsplit`.
 * So this module is not a nicer way to do what `lib/net.js` does; it is the only way to do what
 * `lib/net.js` cannot.
 *
 * **Licences.** `winws` is MIT (bol-van, Flowseal). WinDivert is LGPLv3 or GPLv2 at the
 * recipient's choice, and the distribution's own `LICENSE.txt` states the terms for shipping its
 * binaries unmodified. We ship them unmodified and keep their notices with them.
 *
 * **Elevation.** `winws.exe` carries a manifest requiring administrator, verified by trying to
 * start it: it refuses with «Запрошенная операция требует повышения». Installing the driver and
 * registering the service therefore needs one elevated call, and there is no way around that for
 * any kernel driver. After installation the service auto-starts at boot and the user is asked
 * nothing further — including for start/stop, because the install step grants this user's SID
 * control rights on the service descriptor.
 *
 * @module dsh-rustvy/zapret
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const run = promisify(execFile)

/**
 * Build PowerShell arguments that answer in UTF-8.
 *
 * Windows PowerShell 5.1 writes redirected stdout in the console's OEM code page — cp866 on a
 * Russian system — while Node decodes it as UTF-8, so a reason string meant for the user arrives
 * as mojibake and the page renders garbage where a diagnosis should be. Measured, not predicted:
 * `Stop-Service` on a missing service came back as `"    … \"dsh-rustvy-zapret\"."`. Setting the
 * console encoding inside the command fixes it for every caller at once.
 *
 * @param script - the PowerShell to run.
 * @returns the argument array for `execFile`.
 */
function psArgs(script) {
  return [
    '-NoProfile', '-Command',
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`,
  ]
}

/**
 * The release we install, pinned together with its digest.
 *
 * Pinned rather than following `releases/latest`, and the reason is that GitHub's API publishes
 * no authoritative per-asset digest: "verify whatever is newest" would mean verifying against a
 * value we fetched from the same place as the bytes, which proves nothing. A pinned digest must
 * be bumped by a human on purpose, and a stale one fails loudly instead of installing something
 * nobody reviewed.
 */
export const ZAPRET_VERSION = '1.10.4'
export const ZAPRET_SHA256 = '291AF673BD0238506F9548E0E94CA0ABF244000F4C9A06960544FB01C5F97B34'
export const ZAPRET_ARCHIVE = `zapret-discord-youtube-${ZAPRET_VERSION}.zip`
export const ZAPRET_URL =
  `https://github.com/Flowseal/zapret-discord-youtube/releases/download/${ZAPRET_VERSION}/${ZAPRET_ARCHIVE}`
/** The archive's single top-level directory, which every entry path is relative to. */
export const ZAPRET_ROOT = `zapret-discord-youtube-${ZAPRET_VERSION}`

/**
 * The pinned asset's byte length, measured on the downloaded file.
 *
 * Checked *before* the hash, because a truncated transfer and a tampered file are different
 * failures and the user should be told which one they had rather than reading a digest mismatch
 * for what was an interrupted connection.
 */
export const ZAPRET_BYTES = 1_518_649

/**
 * The notice we must supply ourselves, and where it lives.
 *
 * The upstream release archive carries **no** licence file: all 63 entries of
 * `zapret-discord-youtube-1.10.4.zip` were enumerated and there is no `LICENSE.txt` among them,
 * although the git checkout has one. Requiring the archive to carry it therefore refused every
 * real download, and a suite built entirely from synthetic archives that did include it could not
 * detect that. The obligation was ours all along — we are the redistributor, so we supply the
 * notices.
 *
 * `ZAPRET_NOTICE_FILE` is written into the install directory beside the binaries; its text comes
 * from `NOTICE-zapret.txt` in the package, which `package.json` `files` must list. The gate
 * asserts both, because a notice that silently stops shipping is a compliance failure with no
 * runtime symptom at all.
 */
export const ZAPRET_NOTICE_FILE = 'NOTICE.txt'
export const ZAPRET_NOTICE_SOURCE = 'NOTICE-zapret.txt'

/**
 * Read the bundled notice text.
 *
 * Resolved relative to this module rather than to the process working directory, which for a
 * plugin is wherever the harness happened to start. Returns `''` when the file cannot be read,
 * and callers must treat that as a refusal to install rather than installing without its notices.
 *
 * @returns the notice text, or `''`.
 */
export function zapretNoticeText() {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, '..', ZAPRET_NOTICE_SOURCE)
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    // Swallow only "it is not there". A broader catch here would turn a programming error — a
    // wrong path built by this very function — into a silent `''`, which is indistinguishable
    // from a package that shipped without its notices. That is precisely what happened once:
    // `fileURLToPath` was used without being imported, the ReferenceError was swallowed, and the
    // function reported an empty notice while looking correct.
    if (error?.code !== 'ENOENT') throw error
    return ''
  }
}

/**
 * Licence notices that must travel with the binaries.
 *
 * Not part of {@link ZAPRET_FILES}, which is the set the service needs in order to run; these are
 * the set *we* may not ship without. Extracting `winws.exe` and `WinDivert64.sys` and leaving the
 * notices behind would not be a packaging shortcut, it would be redistribution without a licence.
 *
 * **They are written by the installer from this package, not extracted from the archive.** That is
 * a correction, not the original design: the published release asset contains no `LICENSE.txt` at
 * all — the file exists in the upstream git checkout but Flowseal does not put it in the zip — and
 * a live download against the real artifact refused at extraction while every test stayed green,
 * because the tests were built from synthetic archives that carried the same wrong assumption.
 * We are the redistributor, so the obligation was always ours; requiring upstream's archive to
 * satisfy it was never something we could rely on.
 */
export const ZAPRET_NOTICES = Object.freeze(['LICENSE.txt'])

/** Refuse anything larger, so a hostile or runaway response cannot exhaust memory. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

/**
 * The service name.
 *
 * Deliberately **not** `zapret`. A user may already have zapret installed under that name, and
 * creating, starting, stopping or deleting a service by that name would be acting on somebody
 * else's installation. Two packet-level engines desyncing the same traffic also break each other,
 * so a foreign install is detected and refused rather than joined — see {@link foreignZapret}.
 */
export const ZAPRET_SERVICE = 'dsh-rustvy-zapret'

/**
 * The files extracted from the archive, and only these.
 *
 * An allowlist rather than "everything under bin/": the archive is third-party and fetched over
 * the network, so a future release adding a file must not silently land on disk. `cygwin1.dll` is
 * mandatory — `winws.exe` names it in its imports and is a cygwin build — and it is 2.95 MB of
 * the 3.2 MB total, which is the honest cost of this feature.
 *
 * The two `fake-tls` decoys match the configuration measured as the strongest in zapret's own
 * test data, so they are not decoration.
 */
export const ZAPRET_FILES = Object.freeze([
  'bin/winws.exe',
  'bin/WinDivert.dll',
  'bin/WinDivert64.sys',
  'bin/cygwin1.dll',
  'bin/tls_clienthello_www_google_com.bin',
  'bin/stun.bin',
])

/**
 * Where the managed install lives. Everything is inside the plugin's own state directory, so
 * nothing is written outside the plugin and uninstalling is deleting one directory plus one
 * service.
 *
 * @param stateDir - the plugin's state directory.
 * @returns `{ root, bin, lists, hostlist, installer, result, log }`.
 */
export function zapretPaths(stateDir) {
  const root = join(String(stateDir), 'zapret')
  return {
    root,
    bin: join(root, 'bin'),
    lists: join(root, 'lists'),
    hostlist: join(root, 'lists', 'rustvy.txt'),
    installer: join(root, 'install.cmd'),
    result: join(root, 'install-result.txt'),
    log: join(root, 'install.log'),
  }
}

/**
 * Quote one argument for a Windows command line.
 *
 * Deliberately not `JSON.stringify`, which is a JSON encoder: it doubles every backslash, and
 * using it here put `C:\\state\\.dsh-rustvy\\…` into the service's `binPath` — a path that does
 * not exist, so winws would have started and immediately failed to open its hostlist, with the
 * failure surfacing as "the service will not stay running" and nothing pointing at quoting. The
 * rules are MSVCRT's: leave an argument alone when it needs no quoting, otherwise wrap it,
 * escaping each backslash run that precedes a quote and then the quote itself.
 *
 * @param value - the argument.
 * @returns the argument, quoted only if it must be.
 */
export function quoteArg(value) {
  const text = String(value)
  if (text !== '' && !/[\s"\\]/u.test(text)) return text
  let out = '"'
  let backslashes = 0
  for (const ch of text) {
    // Count backslashes without emitting them: how many are written depends on what follows.
    // Emitting them here as well is what doubled every one, because the next iteration flushed
    // the run again.
    if (ch === '\\') { backslashes++; continue }
    // Before a quote each pending backslash must itself be escaped, then the quote is escaped.
    // Anywhere else a backslash is literal.
    out += ch === '"'
      ? '\\'.repeat(backslashes * 2 + 1) + '"'
      : '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  // A trailing run precedes the closing quote, so it doubles.
  return out + '\\'.repeat(backslashes * 2) + '"'
}

/**
 * The winws argument list, built from the configuration measured as strongest.
 *
 * The strategy is `fake,fakedsplit` with timestamp fooling and six repeats, taken from the rule
 * in zapret's own `general (ALT).bat` that scored best across its published results — not from
 * `general.bat`, whose `multisplit`+`split-seqovl` scored worst. `--wf-tcp=443` narrows the
 * WinDivert capture filter to the port we care about, which is both faster and a smaller blast
 * radius than capturing everything.
 *
 * Only TCP 443 and only the configured origin's hostname. This is not a VPN and does not make
 * anything else reachable; pretending otherwise on the page would be the failure this module
 * exists to avoid.
 *
 * @param paths - from {@link zapretPaths}.
 * @param hostname - the origin hostname to cover.
 * @returns the argument array, without the executable.
 */
export function zapretArgs(paths, hostname) {
  // The hostname is not an argument winws takes; it appears here so a reader of the generated
  // service command line can see which origin the rule was built for. It reaches the engine
  // through the hostlist file instead.
  void hostname
  return [
    '--wf-tcp=443',
    '--filter-tcp=443',
    `--hostlist=${quoteArg(paths.hostlist)}`,
    '--dpi-desync=fake,fakedsplit',
    '--dpi-desync-repeats=6',
    '--dpi-desync-fooling=ts',
    '--dpi-desync-fakedsplit-pattern=0x00',
    `--dpi-desync-fake-tls=${quoteArg(join(paths.bin, 'tls_clienthello_www_google_com.bin'))}`,
    `--dpi-desync-fake-tls=${quoteArg(join(paths.bin, 'stun.bin'))}`,
  ]
}

/**
 * The hostlist contents.
 *
 * One hostname per line, which is the format winws reads. Generated from the configured origin
 * rather than hardcoded, so a profile pointed at a mirror gets the mirror covered.
 *
 * @param hostname - the origin hostname.
 * @returns the file text.
 */
export function zapretHostlist(hostname) {
  const name = String(hostname ?? '').trim().toLowerCase()
  if (name === '') return ''
  return `${name}\n`
}

/**
 * The text of the elevated installer.
 *
 * Three commands, and the second is what makes "one prompt and then nothing" true:
 *
 * 1. `sc create … start= auto` registers the service to start at boot.
 * 2. `sc sdset` grants **this user's SID** the rights to query, start, stop and interrogate the
 *    service. Without it every later start/stop from the plugin would need its own elevation, and
 *    the feature would ask for administrator rights forever instead of once.
 * 3. `sc start` brings it up now.
 *
 * The result is written to a file the plugin polls, because an elevated process has no channel
 * back to us — its stdout goes to a console window that closes. A missing result file after the
 * timeout means "we do not know", which the caller must report as such rather than as success.
 *
 * @param options - `{ paths, args, userSid }`.
 * @returns the .cmd text.
 */
export function zapretInstallerScript({ paths, args, userSid }) {
  const exe = join(paths.bin, 'winws.exe')
  const binPath = `"${exe}" ${args.join(' ')}`
  const sid = String(userSid ?? '').trim()
  // `CCLCSWRPWPDTLOCRRC` is query, start, stop, pause/continue, interrogate and read-control.
  // Not `DC` (delete): uninstalling stays an elevated action on purpose, so removing a kernel
  // driver always requires the user to mean it.
  const sd = sid === '' ? '' : `sc sdset ${ZAPRET_SERVICE} "D:(A;;CCLCSWRPWPDTLOCRRC;;;${sid})"`
  return [
    '@echo off',
    // The blanket quote-escaping is safe here because Windows forbids `"` in a file name, so no
    // path reaching `binPath` can already contain an escaped quote that this would double. If
    // that ever stops being true this line has to escape only unescaped quotes.
    `sc create ${ZAPRET_SERVICE} binPath= "${binPath.replace(/"/gu, '\\"')}" DisplayName= "dsh-rustvy zapret" start= auto`,
    sd,
    `sc start ${ZAPRET_SERVICE}`,
    `> "${paths.result}" echo done %ERRORLEVEL%`,
    '',
  ].filter(line => line !== '').join('\r\n')
}

/**
 * Read back the installer's verdict.
 *
 * @param paths - from {@link zapretPaths}.
 * @returns `{ ok, text }`, or `null` when the installer has not written anything yet.
 */
export function readInstallResult(paths) {
  if (!existsSync(paths.result)) return null
  const text = readFileSync(paths.result, 'utf8').trim()
  return { ok: /^done 0$/u.test(text), text }
}

/**
 * Query a service by name.
 *
 * Reading needs no elevation, which is what makes the status line possible without prompting. A
 * service that does not exist is reported as `absent` rather than as an error, because that is the
 * normal state for a user who has not pressed the button.
 *
 * **Not `sc.exe query`, and the reason is a false negative that was measured rather than
 * theorised.** `sc` prints localized labels — on a Russian Windows the line reads «СОСТОЯНИЕ», not
 * `STATE` — so a regex over its text matches nothing and every service, running or not, comes back
 * `unknown`. That made a genuinely running foreign `zapret` invisible to {@link foreignZapret},
 * which is the one failure this check exists to prevent: the plugin would install a second
 * packet-level engine on top of the first and both handshakes would break, with the panel showing
 * the bypass as on. `Get-Service`'s `Status` is an enum name, and enum names are not localized.
 *
 * @param names - service names to query.
 * @returns a promise of an object mapping each **valid** name to
 *   `'absent' | 'stopped' | 'running' | 'unknown'`. An invalid name is absent from the map rather
 *   than present as `unknown`, so a caller cannot mistake a rejected name for a queried one.
 */
export async function serviceStates(names) {
  const wanted = [...new Set((Array.isArray(names) ? names : [names]).map(name => String(name)))]
    .filter(name => /^[\w.-]+$/u.test(name))
  if (wanted.length === 0) return {}
  // One process for every name. A PowerShell start costs ~0.9 s here, and `zapretState` needs
  // three answers (ours plus two foreign candidates), so querying them separately made a single
  // status read cost ~2.7 s and the mounted-host suite 27 s. The cost is per spawn, not per
  // query, which is the kind of thing that reads as "the plugin is slow" and never as "we started
  // the same interpreter three times".
  const list = wanted.map(name => `'${name}'`).join(',')
  try {
    const { stdout } = await run('powershell.exe', psArgs(
      `$r = @{}; foreach ($n in @(${list})) { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; ` +
      `$r[$n] = if ($s) { "$($s.Status)" } else { 'ABSENT' } }; $r | ConvertTo-Json -Compress`,
    ), { windowsHide: true, timeout: 25_000 })
    const parsed = JSON.parse(String(stdout).trim() === '' ? '{}' : String(stdout).trim())
    const out = {}
    for (const name of wanted) {
      const value = String(parsed?.[name] ?? '').toUpperCase()
      if (value === 'ABSENT') out[name] = 'absent'
      else if (value === 'RUNNING') out[name] = 'running'
      else if (value === 'STOPPED') out[name] = 'stopped'
      // A status we do not recognise (START_PENDING, PAUSED) and a missing answer both come back
      // as unknown rather than as absent or stopped: "we could not read it" and "there is nothing
      // there" send the user in opposite directions.
      else out[name] = 'unknown'
    }
    return out
  } catch {
    return Object.fromEntries(wanted.map(name => [name, 'unknown']))
  }
}

/**
 * Query one service.
 *
 * A thin wrapper over {@link serviceStates}; the validation and the localized-output reasoning
 * live there. An invalid name comes back `unknown`, which is the honest answer — it was never
 * queried — and callers must not read it as `absent`.
 *
 * @param service - the service name.
 * @returns a promise of `'absent' | 'stopped' | 'running' | 'unknown'`.
 */
export async function serviceState(service = ZAPRET_SERVICE) {
  const name = String(service)
  const states = await serviceStates([name])
  return states[name] ?? 'unknown'
}

/**
 * Is somebody else's zapret running?
 *
 * A safety check, not a convenience. Two packet-level engines rewriting the same TCP segments
 * desync each other, and the symptom is a broken handshake that looks like the filter still
 * working — the hardest possible thing for a user to diagnose. So we refuse to install ours while
 * a foreign one runs, and say so.
 *
 * @returns a promise of `{ running, name }`; `name` is the service found, or `''`.
 */
export async function foreignZapret() {
  // One batched query for both candidates rather than two spawns; see `serviceStates`.
  const states = await serviceStates(['zapret', 'winws'])
  for (const name of ['zapret', 'winws']) {
    if (states[name] === 'running') return { running: true, name }
  }
  return { running: false, name: '' }
}

/**
 * The current user's SID, needed by {@link zapretInstallerScript} to grant service control.
 *
 * @returns a promise of the SID string, or `''` if it cannot be determined — in which case the
 *   installer omits the `sdset` line and later start/stop will need elevation. That degradation
 *   is reported rather than hidden.
 */
export async function currentUserSid() {
  try {
    const { stdout } = await run('powershell.exe', psArgs(
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ), { windowsHide: true, timeout: 20_000 })
    const sid = stdout.trim()
    return /^S-\d-(?:\d+-)*\d+$/u.test(sid) ? sid : ''
  } catch {
    return ''
  }
}

/**
 * Start or stop our own service without elevation.
 *
 * Works only because the install step granted this SID control rights; if it did not, `sc` fails
 * with access denied and that is reported as the reason rather than swallowed.
 *
 * @param action - `'start'` or `'stop'`.
 * @param service - the service name.
 * @returns a promise of `{ ok, reason }`.
 */
export async function controlService(action, service = ZAPRET_SERVICE) {
  if (action !== 'start' && action !== 'stop') return { ok: false, reason: `неизвестное действие ${action}` }
  const name = String(service)
  if (!/^[\w.-]+$/u.test(name)) return { ok: false, reason: `недопустимое имя службы «${name}»` }
  // PowerShell rather than `sc.exe`, for the same reason as `serviceState`: `sc`'s messages are
  // localized, and its error text arrives on stdout rather than stderr, so the previous version
  // could return an empty reason — a refusal with nothing to act on, which turns a diagnosable
  // problem into a mystery. `Start-Service` on an already-running service is also a silent
  // no-op, so the "already started" special case disappears rather than being translated.
  const verb = action === 'start' ? 'Start-Service' : 'Stop-Service'
  try {
    const { stdout } = await run('powershell.exe', psArgs(
      `try { ${verb} -Name '${name}' -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }`,
    ), { windowsHide: true, timeout: 60_000 })
    const text = stdout.trim()
    if (text === 'OK') return { ok: true, reason: '' }
    const detail = text.replace(/^ERR:/u, '').trim()
    return {
      ok: false,
      reason: detail === ''
        ? `${verb} для службы «${name}» не выполнен, но PowerShell не сообщил причину`
        : detail.slice(0, 200),
    }
  } catch (error) {
    const detail = String(error?.message ?? error).trim()
    return { ok: false, reason: detail === '' ? `${verb} для службы «${name}» не выполнен` : detail.slice(0, 200) }
  }
}

/**
 * Remove everything this module created: the service and the files.
 *
 * Deleting a service needs elevation, so this is the one control action that prompts again — and
 * that is deliberate, because it removes a kernel driver. The files are ours and are deleted
 * without prompting, but only after the service is confirmed gone, so we never delete the binary
 * out from under a running driver.
 *
 * @param paths - from {@link zapretPaths}.
 * @returns a promise of `{ ok, reason, serviceRemoved, filesRemoved }`.
 */
export async function uninstallZapret(paths) {
  const state = await serviceState()
  // An unreadable service is not a service that is gone. Elevating here would prompt for rights
  // and could delete the binary out from under a driver whose state we could not even read, so
  // this stops and says so instead.
  if (state === 'unknown') {
    return {
      ok: false,
      reason: 'не удалось прочитать состояние службы, поэтому удаление не начато: удалять файлы при неизвестном состоянии драйвера опасно',
      serviceRemoved: false,
      filesRemoved: false,
    }
  }
  if (state === 'running' || state === 'stopped') {
    await run('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process sc.exe -ArgumentList 'stop','${ZAPRET_SERVICE}' -Verb RunAs -Wait`,
    ], { windowsHide: true, timeout: 120_000 }).catch(() => {})
    try {
      await run('powershell.exe', [
        '-NoProfile', '-Command',
        `Start-Process sc.exe -ArgumentList 'delete','${ZAPRET_SERVICE}' -Verb RunAs -Wait`,
      ], { windowsHide: true, timeout: 120_000 })
    } catch {
      return { ok: false, reason: 'службу не удалось удалить; файлы не тронуты', serviceRemoved: false, filesRemoved: false }
    }
  }
  const after = await serviceState()
  if (after !== 'absent') {
    return { ok: false, reason: 'служба всё ещё существует; файлы не удалены, чтобы не вынуть бинарник из-под драйвера', serviceRemoved: false, filesRemoved: false }
  }
  let filesRemoved = false
  try {
    rmSync(paths.root, { recursive: true, force: true })
    filesRemoved = !existsSync(paths.root)
  } catch {
    filesRemoved = false
  }
  return { ok: true, reason: '', serviceRemoved: true, filesRemoved }
}

/**
 * Launch the elevated installer.
 *
 * One UAC prompt, which is the irreducible cost of registering a kernel driver. The installer is
 * written to disk first because `Start-Process -Verb RunAs` cannot take a complex command line
 * reliably, and because a file the user can read is better than an invisible argument string when
 * Windows asks them to approve it.
 *
 * @param paths - from {@link zapretPaths}.
 * @param options - `{ args, userSid }`.
 * @returns a promise of `{ ok, reason }`.
 */
export async function runInstaller(paths, { args, userSid }) {
  try {
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(paths.installer, zapretInstallerScript({ paths, args, userSid }), 'utf8')
    try { unlinkSync(paths.result) } catch { /* nothing to clear */ }
    await run('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process cmd.exe -ArgumentList '/c','""${paths.installer}""' -Verb RunAs`,
    ], { windowsHide: true, timeout: 30_000 })
    return { ok: true, reason: '' }
  } catch (error) {
    // A declined UAC prompt surfaces as "The operation was canceled by the user" (1223).
    const text = String(error?.stderr ?? error?.message ?? '')
    if (text.includes('1223') || /canceled by the user/iu.test(text)) {
      return { ok: false, reason: 'повышение прав отклонено — без прав администратора драйвер не зарегистрировать' }
    }
    return { ok: false, reason: text.trim().split(/\r?\n/u)[0].slice(0, 200) }
  }
}

/**
 * The whole picture, for `/state` and the settings page.
 *
 * Assembled from the filesystem and the service manager rather than from what the plugin
 * remembers doing, so a user who deleted the folder by hand sees the truth. Every field that
 * nobody determined is `null`, never a plausible default: an unknown service state rendered as
 * «не скачано» would send someone to reinstall something that is installed.
 *
 * @param paths - from {@link zapretPaths}.
 * @param hostname - the origin hostname the install would cover.
 * @returns a promise of the state object.
 */
export async function zapretState(paths, hostname) {
  // The licence notice counts towards "downloaded", because the binaries may not be
  // redistributed without it and `downloadZapret` refuses rather than write them unaccompanied.
  // Assembling state from the filesystem alone cannot know that, so it checks here too: a state
  // object saying «скачано» over a tree with no notice would be the same lie one level up as a
  // blank field implying a measurement.
  const expected = [...ZAPRET_FILES, ZAPRET_NOTICE_FILE]
  const missing = expected.filter(relative => !existsSync(join(paths.root, ...relative.split('/'))))
  const downloaded = missing.length === 0
  // One spawn for all three names. Calling `serviceState()` and `foreignZapret()` separately
  // starts PowerShell three times for a single status read, and the page reads status on open.
  const states = await serviceStates([ZAPRET_SERVICE, 'zapret', 'winws'])
  const service = states[ZAPRET_SERVICE] ?? 'unknown'
  const foreignName = ['zapret', 'winws'].find(candidate => states[candidate] === 'running') ?? ''
  const foreign = { running: foreignName !== '', name: foreignName }
  let covered = null
  if (existsSync(paths.hostlist)) {
    const text = readFileSync(paths.hostlist, 'utf8')
    covered = text.split(/\r?\n/u).map(line => line.trim().toLowerCase()).filter(line => line !== '' && !line.startsWith('#')).includes(String(hostname ?? '').trim().toLowerCase())
  }
  return {
    version: downloaded ? ZAPRET_VERSION : null,
    downloaded,
    missing,
    notices: existsSync(join(paths.root, ZAPRET_NOTICE_FILE)) ? [ZAPRET_NOTICE_FILE] : [],
    service,
    covered,
    foreignRunning: foreign.running,
    foreignName: foreign.name === '' ? null : foreign.name,
    hostlist: existsSync(paths.hostlist) ? paths.hostlist : null,
  }
}

/* ------------------------- download and extraction ------------------------- */

/** ZIP end-of-central-directory signature. */
const EOCD_SIGNATURE = 0x06054b50

/** ZIP central-directory entry signature. */
const CENTRAL_SIGNATURE = 0x02014b50

/** ZIP local-file-header signature. */
const LOCAL_SIGNATURE = 0x04034b50

/** CRC-32 table, built once. `zlib.crc32` is newer than this package's supported floor. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/**
 * CRC-32 of a buffer, in the form a ZIP entry stores it.
 * @param data - the bytes to checksum.
 * @returns the unsigned checksum.
 */
function crc32(data) {
  let value = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Split an archive entry name into safe relative segments, or refuse it.
 *
 * This is the zip-slip gate, and it rejects rather than repairs. A name that is absolute, that
 * carries a NUL, or that climbs with `..` is refused outright, because "cleaning" such a name
 * means guessing what a hostile author meant. Both separators are normalised first: archives built
 * on Windows carry `\`, and a `/`-only check would wave `..\..\evil.txt` straight through.
 *
 * @param name - the raw entry name from the archive.
 * @returns the segments, or `null` when the name must not be used at all.
 */
function safeSegments(name) {
  if (typeof name !== 'string' || name === '') return null
  if (name.includes('\0')) return null
  const normalized = name.replace(/\\/gu, '/')
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) return null
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some(segment => segment === '..')) return null
  return segments
}

/**
 * Locate the end-of-central-directory record by scanning backwards.
 *
 * Scanned rather than read from a fixed offset because a trailing archive comment is legal and
 * shifts it, and because a file fetched over the network may have anything appended.
 *
 * @param archive - the whole zip.
 * @returns the EOCD offset, or -1 when there is none.
 */
function findEocd(archive) {
  const size = 22
  if (archive.length < size) return -1
  const lowest = Math.max(0, archive.length - size - 0xffff)
  for (let offset = archive.length - size; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Read the central directory.
 * @param archive - the whole zip.
 * @returns `{ entries }`, or a one-sentence reason when the archive cannot be read.
 */
function readCentralDirectory(archive) {
  const eocd = findEocd(archive)
  if (eocd < 0) return 'the download is not a zip archive: it has no end-of-central-directory record'
  const count = archive.readUInt16LE(eocd + 10)
  const offset = archive.readUInt32LE(eocd + 16)
  // Zip64 is out of scope for a 1.5 MB asset, and refusing beats misreading a 64-bit size as a
  // 32-bit one and then trusting whatever offset that arithmetic produces.
  if (count === 0xffff || offset === 0xffffffff) return 'the archive is zip64, which this reader does not support'
  if (offset + 46 > archive.length) return 'the archive is truncated: its central directory starts beyond the end of the file'
  const entries = []
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return 'the archive is malformed: a central-directory entry is missing or misaligned'
    }
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    entries.push({
      name: archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      method: archive.readUInt16LE(cursor + 10),
      crc: archive.readUInt32LE(cursor + 16),
      compressed: archive.readUInt32LE(cursor + 20),
      size: archive.readUInt32LE(cursor + 24),
      localOffset: archive.readUInt32LE(cursor + 42),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return { entries }
}

/**
 * Read one entry's data and check it against the directory's own claims.
 *
 * Both the inflated length and the CRC-32 are verified, because an entry whose bytes do not match
 * its directory record is either corrupt or constructed — and in a third-party archive fetched
 * over the network, "constructed" is the case worth assuming.
 *
 * @param archive - the whole zip.
 * @param entry - the central-directory entry.
 * @returns the bytes, or a one-sentence reason.
 */
function readEntryData(archive, entry) {
  const start = entry.localOffset
  if (start + 30 > archive.length || archive.readUInt32LE(start) !== LOCAL_SIGNATURE) {
    return `the entry ${entry.name} has no local header at the offset its directory record names`
  }
  const nameLength = archive.readUInt16LE(start + 26)
  const extraLength = archive.readUInt16LE(start + 28)
  const from = start + 30 + nameLength + extraLength
  const to = from + entry.compressed
  if (to > archive.length) return `the entry ${entry.name} is truncated inside the archive`
  const raw = archive.subarray(from, to)
  let data
  if (entry.method === 0) data = Buffer.from(raw)
  else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw)
    } catch {
      return `the entry ${entry.name} could not be inflated`
    }
  } else {
    return `the entry ${entry.name} uses compression method ${entry.method}, which this reader does not support`
  }
  if (data.length !== entry.size) {
    return `the entry ${entry.name} inflated to ${data.length} bytes, not the ${entry.size} its directory record claims`
  }
  const actual = crc32(data)
  if (actual !== entry.crc) {
    return `the entry ${entry.name} failed its CRC-32 check: ${actual.toString(16)} rather than ${entry.crc.toString(16)}`
  }
  return data
}

/**
 * Whether an entry is one of ours.
 *
 * Matched against the two shapes the real archive can present — `<ZAPRET_ROOT>/bin/winws.exe` and
 * a bare `bin/winws.exe` — and on the whole remainder, so `evil/bin/winws.exe` does not match and
 * neither does a deeper nesting. The release folder is a known constant, not "any one segment",
 * which is what keeps this from being a pattern a hostile name can satisfy.
 *
 * @param segments - the entry's safe segments.
 * @param wanted - the relative path being looked for, with `/` separators.
 * @returns true when this entry is that file.
 */
function matchesWanted(segments, wanted) {
  const parts = wanted.split('/')
  if (segments.length === parts.length) return segments.every((segment, index) => segment === parts[index])
  if (segments.length === parts.length + 1) {
    return segments[0] === ZAPRET_ROOT && parts.every((part, index) => segments[index + 1] === part)
  }
  return false
}

/**
 * Download, verify and unpack the pinned zapret release.
 *
 * The whole function is written so that no failure can throw into a route handler: every refusal
 * is `{ ok: false, reason }` with one sentence, because the caller renders that sentence and a
 * thrown error would surface as a generic 500 with the cause lost.
 *
 * Progress is reported in bytes through `onProgress` rather than as a completion callback, which
 * is what lets the settings page show something other than a spinner on a 1.5 MB download that may
 * be crossing a throttled or filtered link.
 *
 * @param options - `{ version, dest, log, fetchImpl, now, onProgress }`. `version` defaults to the
 *   pinned release and any other value is refused: there is no digest to verify it against, and
 *   downloading bytes we cannot verify is the one thing this module exists to prevent. `fetchImpl`
 *   is injectable so tests never touch the network.
 * @returns a promise of `{ ok, reason, version, url, files, bytes, notices }`, where `files` lists
 *   what was written as `{ path, bytes }` relative to `dest`.
 */
export async function downloadZapret(rawOptions) {
  // Normalized explicitly rather than by a default parameter, because a default only applies to
  // `undefined`: `downloadZapret(null)` reached `options.version` and threw a `TypeError` into the
  // caller, which is the one thing this surface promises never to do.
  const options = rawOptions ?? {}
  const version = options.version ?? ZAPRET_VERSION
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const base = { ok: false, reason: '', version, url: ZAPRET_URL, files: [], bytes: 0, notices: [] }
  const refuse = reason => {
    log(`zapret: ${reason}`, { at: now() })
    return { ...base, reason }
  }

  if (version !== ZAPRET_VERSION) {
    return refuse(`version ${version} is not the pinned ${ZAPRET_VERSION}, and this build holds no digest for any other release`)
  }
  const dest = typeof options.dest === 'string' && options.dest !== '' ? options.dest : ''
  if (dest === '') return refuse('no destination directory was given')

  // An explicitly supplied `fetchImpl` that is not a function is refused rather than quietly
  // replaced by the global one. The substitution looks harmless and is not: the caller asked to
  // inject a transport and got a real network call instead. In the suite that produced `ok: true`
  // from a genuine download of the pinned artifact — a green result for the wrong reason, in a
  // test whose whole premise is that it never touches the network. A silently ignored injection is
  // the same failure shape as a silently unfragmented ClientHello.
  if ('fetchImpl' in options && typeof options.fetchImpl !== 'function') {
    return refuse('fetchImpl was supplied but is not a function; refusing to fall back to the global fetch')
  }
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') return refuse('no fetch implementation is available')

  // The URL and the digest are the only two values that ever reach a log line here. Neither is a
  // secret, and keeping that set deliberately small is what stops a future credential being added
  // out of habit rather than by decision.
  log(`zapret: downloading ${ZAPRET_URL}`, { at: now() })
  let response
  try {
    response = await doFetch(ZAPRET_URL, { redirect: 'follow' })
  } catch (error) {
    return refuse(`the download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    return refuse(`the download was refused with status ${response?.status ?? 'unknown'}`)
  }

  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  const total = Number.isFinite(declared) && declared > 0 ? declared : ZAPRET_BYTES
  const chunks = []
  let received = 0
  try {
    if (response.body !== null && typeof response.body?.[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        received += piece.byteLength
        // Checked as bytes arrive rather than after: a server that streams forever must be
        // stopped before it has allocated the memory, not after.
        if (received > MAX_DOWNLOAD_BYTES) return refuse(`the download passed ${MAX_DOWNLOAD_BYTES} bytes and was abandoned`)
        chunks.push(piece)
        onProgress({ received, total })
      }
    } else {
      const whole = Buffer.from(await response.arrayBuffer())
      received = whole.byteLength
      if (received > MAX_DOWNLOAD_BYTES) return refuse(`the download passed ${MAX_DOWNLOAD_BYTES} bytes and was abandoned`)
      chunks.push(whole)
      onProgress({ received, total })
    }
  } catch (error) {
    return refuse(`the download stopped part way: ${error instanceof Error ? error.message : String(error)}`)
  }
  const archive = Buffer.concat(chunks)

  if (archive.byteLength !== ZAPRET_BYTES) {
    return refuse(`the download was ${archive.byteLength} bytes rather than the pinned ${ZAPRET_BYTES}, so it is truncated or it is not the pinned release`)
  }
  const digest = createHash('sha256').update(archive).digest('hex')
  // Compared case-insensitively: the pinned constant is written uppercase and `createHash` emits
  // lowercase, and a mismatch caused by letter case would be the least useful failure to debug.
  if (digest !== ZAPRET_SHA256.toLowerCase()) {
    return refuse(`the sha256 was ${digest} rather than the pinned ${ZAPRET_SHA256.toLowerCase()}, so the archive was not what we published or was altered in transit; nothing was extracted`)
  }
  log(`zapret: verified sha256 ${digest}`, { at: now() })

  const extracted = extractZapretArchive(archive, dest, { log, now })
  return {
    ok: extracted.ok === true,
    reason: extracted.reason,
    version,
    url: ZAPRET_URL,
    files: extracted.files,
    bytes: extracted.bytes,
    notices: extracted.notices,
  }
}

/**
 * Unpack an already-verified archive buffer into `dest`.
 *
 * Split out from {@link downloadZapret} for testability rather than tidiness, and the reason is
 * worth stating because it is the kind of thing that gets "simplified" back later. Verification is
 * against a pinned digest, so **no archive a test can craft will ever satisfy it** — leaving the
 * zip-slip gate, the allowlist, the CRC checks and the licence-notice requirement reachable by
 * nothing. With the seam, `downloadZapret` is tested against its size and digest refusals while
 * extraction is tested against real hostile archives. The alternative, a digest override for
 * tests, is a bypass in a security path added for convenience, which is precisely what an attacker
 * would want to exist.
 *
 * **This function never consults `ZAPRET_SHA256` and performs no integrity check of its own.**
 * That is deliberate: the moment extraction knows about the digest, somebody makes the check
 * optional *here* instead of in the download. Calling it on bytes that did not come through
 * {@link downloadZapret} writes unverified third-party executables to disk, and not doing that is
 * the caller's responsibility.
 *
 * @param archive - the verified zip bytes.
 * @param dest - the directory to extract into.
 * @param options - `{ log, now }`.
 * @returns `{ ok, reason, files, bytes, notices }`, where `files` is `[{ path, bytes }]` for the
 *   binaries. `notices` is always empty from this function — the licence notices are ours to write
 *   and the installer writes them, so the archive is never asked to carry them.
 */
export function extractZapretArchive(archive, dest, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const base = { ok: false, reason: '', files: [], bytes: 0, notices: [] }
  const refuse = reason => {
    log(`zapret: ${reason}`, { at: now() })
    return { ...base, reason }
  }
  if (!Buffer.isBuffer(archive)) return refuse('the archive is not a buffer')
  if (typeof dest !== 'string' || dest === '') return refuse('no destination directory was given')

  const directory = readCentralDirectory(archive)
  if (typeof directory === 'string') return refuse(directory)

  const destRoot = resolve(dest)
  // Only the binaries. The licence notices are deliberately NOT required from the archive: the
  // published release asset does not contain `LICENSE.txt` — it exists in the git checkout but
  // Flowseal does not put it in the zip — so requiring it made the feature dead on arrival while
  // every test stayed green, because the tests were built from synthetic archives that encoded the
  // same wrong assumption about the real artifact. Requiring upstream to carry our compliance
  // obligation was never something we could rely on: we are the redistributor, so the notices are
  // ours to write, and the installer writes them.
  const wanted = [...ZAPRET_FILES]
  const found = new Map()
  const unsafe = []

  for (const entry of directory.entries) {
    const segments = safeSegments(entry.name)
    if (segments === null) {
      // Recorded and refused rather than skipped: an archive carrying a climbing or absolute path
      // is hostile or corrupt, and the operator should see that even though nothing was written.
      unsafe.push(entry.name.replace(/[^\x20-\x7e]/gu, '?'))
      continue
    }
    for (const relative of wanted) {
      if (matchesWanted(segments, relative)) {
        found.set(relative, entry)
        break
      }
    }
  }

  if (unsafe.length > 0) {
    return refuse(`the archive holds ${unsafe.length} unsafe ${unsafe.length === 1 ? 'path' : 'paths'} (${unsafe.slice(0, 3).join(', ')}), so nothing was extracted`)
  }

  const missing = wanted.filter(relative => !found.has(relative))
  if (missing.length > 0) {
    // Refused before a single byte is written, so a partial install cannot be mistaken for
    // success: the service would fail to start later with no visible link to this download.
    return refuse(`the archive is missing ${missing.join(', ')}; nothing was extracted`)
  }

  const files = []
  const notices = []
  let written = 0
  for (const relative of wanted) {
    const data = readEntryData(archive, found.get(relative))
    if (typeof data === 'string') return refuse(data)
    if (data.byteLength === 0) return refuse(`${relative} extracted to zero bytes`)

    // The destination is built from our own constant and never from the entry name, so nothing the
    // archive contains can choose where these bytes land. The containment check below is then
    // defence in depth rather than the only thing standing between a hostile name and the profile.
    const target = resolve(destRoot, ...relative.split('/'))
    if (target !== destRoot && !target.startsWith(destRoot + sep)) {
      return refuse(`the resolved path for ${relative} falls outside the destination directory; nothing further was written`)
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      // Staged beside the target and renamed, so an interrupted extraction cannot leave a
      // half-written executable that a later service start treats as complete.
      const staged = `${target}.part`
      writeFileSync(staged, data)
      renameSync(staged, target)
    } catch (error) {
      return refuse(`writing ${relative} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    written += data.byteLength
    // Unconditional, because every entry in `wanted` is a binary now. `notices` stays empty by
    // construction and that is correct rather than a gap: extraction does not write notices, the
    // installer does. An empty array here must not be read as "shipped without a licence" — the
    // filesystem check in `zapretState` is what answers that question.
    files.push({ path: relative, bytes: data.byteLength })
  }

  // Re-checked from the filesystem rather than from the loop above. The claim "every file the
  // service needs is present" is a claim about the disk, and only the disk can confirm it — a
  // loop that believes it wrote something is exactly how a partial install reports success.
  const absent = ZAPRET_FILES.filter(relative => {
    const target = join(destRoot, ...relative.split('/'))
    return !existsSync(target) || readFileSync(target).byteLength === 0
  })
  if (absent.length > 0) {
    return refuse(`after extraction ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} missing or empty on disk`)
  }

  log(`zapret: extracted ${files.length} files (${written} bytes) into ${destRoot}`, { at: now() })
  return { ok: true, reason: '', files, bytes: written, notices }
}
