// Download and extraction tests for `lib/zapret.js`.
//
// Hermetic by construction: nothing here touches the network. A crafted zip is served from a
// loopback `http.Server` this file controls, or handed to `extractZapretArchive` directly.
//
// That second route is why the split exists. `downloadZapret` verifies against a pinned digest,
// so no archive a test can build will ever satisfy it — which would leave the zip-slip gate, the
// allowlist, the CRC checks and the licence-notice requirement tested by nothing at all. So the
// download path is tested against its size, digest and transport refusals, and the extraction
// path against real hostile archives. There is deliberately no digest override anywhere: a bypass
// added for test convenience in a security path is what an attacker would want to exist.
//
// Zip-slip assertions check the FILESYSTEM, not the return value. "The function refused" and "no
// file appeared outside dest" are different claims, and only the second one is the property that
// matters — a refusal that still wrote the file would pass a return-value check.
import { createServer } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { exit } from 'node:process'

const {
  ZAPRET_FILES, ZAPRET_NOTICES, ZAPRET_ROOT, ZAPRET_BYTES, ZAPRET_SHA256, ZAPRET_URL,
  downloadZapret, extractZapretArchive,
} = await import('../lib/zapret.js')

const results = []
/**
 * Record one assertion.
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside a failure, so a red run says why.
 */
function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/* ------------------------------- zip writer -------------------------------- */

/** CRC-32, matching the table `lib/zapret.js` builds. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()
function crc32(data) {
  let value = 0xffffffff
  for (let index = 0; index < data.length; index += 1) value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Build a zip from entries.
 *
 * Writes the same field offsets `lib/zapret.js` reads, so a bug in either shows up as a mismatch
 * rather than as a silent agreement between two copies of the same mistake.
 *
 * @param entries - `[{ name, data, method, crcOverride, sizeOverride }]`.
 * @returns the archive bytes.
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const method = entry.method ?? 0
    const crc = (entry.crcOverride ?? crc32(data)) >>> 0
    const declared = entry.sizeOverride ?? data.length
    const stored = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(declared, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, stored)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(declared, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + stored.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

/**
 * A well-formed archive carrying the binaries, optionally mutated.
 *
 * **The default archive contains no `LICENSE.txt`, because the real published asset does not.**
 * That is the correction this suite exists to encode: an earlier version added the notice by
 * default, the extraction code required it, and every test passed against an archive shape the
 * real artifact does not have — so a live download refused and the suite was green. A fixture
 * built from an assumption rather than from the artifact proves the assumption, not the artifact.
 *
 * @param mutate - receives the entry list and may change it in place.
 * @param options - `{ withNotice }`; pass true to build an archive that does carry a notice.
 * @returns the archive bytes.
 */
function archive(mutate, options = {}) {
  const entries = [
    ...ZAPRET_FILES.map(path => ({ name: `${ZAPRET_ROOT}/${path}`, data: Buffer.from(`the bytes of ${path}`) })),
  ]
  if (options.withNotice === true) {
    entries.push(...ZAPRET_NOTICES.map(path => ({ name: `${ZAPRET_ROOT}/${path}`, data: Buffer.from('MIT and LGPLv3-or-GPLv2 notices') })))
  }
  if (typeof mutate === 'function') mutate(entries)
  return makeZip(entries)
}

/** A fresh empty destination directory. */
function tempDest() {
  return mkdtempSync(join(tmpdir(), 'zapret-dest-'))
}

/**
 * Run one call and keep the failure rather than throwing it at the suite.
 * @param call - the call to make.
 * @returns a promise of `{ ok, value }` or `{ ok: false, message }`.
 */
async function attempt(call) {
  try {
    return { ok: true, value: await call() }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Call `extractZapretArchive` and turn an unexpected throw into a failure value.
 *
 * This wrapper exists because of a failure mode in the suite itself, and it is the third time the
 * class has appeared. Without it, a throw escapes to the top level, the process dies before the
 * summary is printed, and a removal probe reports *zero failures* — which reads as a pass. "The
 * code threw" and "nothing failed" become indistinguishable, and the second is what a green run
 * looks like. Probe Z2 hit exactly this: removing the licence-notice refusal made the write loop
 * dereference `undefined`, the suite died mid-run, and the probe looked clean.
 *
 * It wraps **every** call rather than the one that happened to crash, because the next unexpected
 * throw will not come from the line anyone was watching. The wrapper is also what makes `threw`
 * available as a distinct field, so an assertion can tell a refusal from an exception instead of
 * collapsing both into `ok === false`.
 *
 * @param archiveBuffer - the archive bytes.
 * @param dest - the destination directory.
 * @param options - passed through.
 * @returns the module's result with `threw: null`, or a synthesized failure carrying the message.
 */
function extract(archiveBuffer, dest, options) {
  try {
    return { ...extractZapretArchive(archiveBuffer, dest, options), threw: null }
  } catch (error) {
    return {
      ok: false,
      reason: `the call threw instead of returning a failure: ${error instanceof Error ? error.message : String(error)}`,
      files: [],
      bytes: 0,
      notices: [],
      threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

/**
 * Call `downloadZapret` with the same protection, for a rejection rather than a throw.
 *
 * `downloadZapret` is documented as never throwing into a caller, so a rejection is itself the
 * finding — and an unhandled one would take the summary down with it.
 *
 * @param options - passed through.
 * @returns a promise of the module's result with `threw: null`, or a synthesized failure.
 */
async function download(options) {
  try {
    return { ...(await downloadZapret(options)), threw: null }
  } catch (error) {
    return {
      ok: false,
      reason: `the call rejected instead of returning a failure: ${error instanceof Error ? error.message : String(error)}`,
      files: [],
      bytes: 0,
      notices: [],
      threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

/* --------- the contract that neither function may throw into its caller ------- */
{
  // Asserted directly, because the wrappers above would otherwise hide a regression in the very
  // property they exist to protect. A throw from either function is a defect in `lib/zapret.js`,
  // not something the suite should quietly absorb.
  const badInputs = [
    ['a non-buffer archive', () => extractZapretArchive('not a buffer', tempDest())],
    ['a null archive', () => extractZapretArchive(null, tempDest())],
    ['an undefined archive', () => extractZapretArchive(undefined, tempDest())],
    ['a numeric archive', () => extractZapretArchive(42, tempDest())],
    ['an empty destination', () => extractZapretArchive(archive(), '')],
    ['a null destination', () => extractZapretArchive(archive(), null)],
    ['garbage bytes', () => extractZapretArchive(Buffer.from('not a zip at all'), tempDest())],
    ['a buffer too short for any header', () => extractZapretArchive(Buffer.alloc(4), tempDest())],
  ]
  for (const [label, call] of badInputs) {
    let threw = null
    let value
    try {
      value = call()
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(`extractZapretArchive returns a refusal rather than throwing on ${label}`,
      threw === null && value?.ok === false,
      JSON.stringify({ threw, ok: value?.ok }))
  }

  const downloadInputs = [
    ['no options at all', () => downloadZapret()],
    ['a null options object', () => downloadZapret(null)],
    ['a fetchImpl that is not a function', () => downloadZapret({ dest: tempDest(), fetchImpl: 'nope' })],
    ['a fetchImpl that throws synchronously', () => downloadZapret({
      dest: tempDest(),
      fetchImpl: () => { throw new Error('synchronous throw from fetch') },
    })],
    ['a response with no headers object', () => downloadZapret({
      dest: tempDest(),
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(4) }),
    })],
  ]
  for (const [label, call] of downloadInputs) {
    let threw = null
    let value
    try {
      value = await call()
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(`downloadZapret returns a refusal rather than throwing on ${label}`,
      threw === null && value?.ok === false,
      JSON.stringify({ threw, ok: value?.ok, reason: String(value?.reason ?? '').slice(0, 70) }))
  }
}

/* ------------------------- extraction: the happy path ----------------------- */
{
  const dest = tempDest()
  const result = extract(archive(), dest)
  check('a correct archive extracts successfully', result.ok === true, result.reason)
  check('and it reports every binary it wrote',
    result.files.length === ZAPRET_FILES.length
    && ZAPRET_FILES.every(path => result.files.some(file => file.path === path)),
    JSON.stringify(result.files.map(file => file.path)))
  check('it writes no licence notices, because they are the installer\'s to write and not the archive\'s',
    result.notices.length === 0, JSON.stringify(result.notices))
  check('every binary is on disk and non-empty',
    ZAPRET_FILES.every(path => existsSync(join(dest, path)) && readFileSync(join(dest, path)).byteLength > 0),
    JSON.stringify(ZAPRET_FILES.map(path => ({ path, exists: existsSync(join(dest, path)) }))))
  const binaryBytes = result.files.reduce((sum, file) => sum + file.bytes, 0)
  check('and the bytes reported equal exactly the binaries on disk',
    result.bytes === binaryBytes && result.bytes > 0, `${result.bytes} vs ${binaryBytes}`)
  // Guarded, and guarded in a way that cannot pass on an absent directory. The first version
  // called `readdirSync(join(dest, 'bin'))` directly, which threw ENOENT whenever extraction had
  // (correctly) refused and written nothing — so a removal probe printed its real FAILs and then
  // died before the summary, and "the suite crashed" still looked like "nothing failed". Requiring
  // `staged.length > 0` is the other half: an empty list would otherwise satisfy `every(...)`
  // trivially and the check could not distinguish "no leftovers" from "nothing was written".
  const staged = existsSync(join(dest, 'bin')) ? readdirSync(join(dest, 'bin')) : []
  check('and nothing was staged and left behind',
    staged.length > 0 && staged.every(name => !name.endsWith('.part')),
    JSON.stringify(staged))
  rmSync(dest, { recursive: true, force: true })
}

/* ------------------------- extraction: the allowlist ------------------------ */
{
  // A future release adding a file must not silently land on disk. The allowlist decides, so an
  // extra entry is ignored rather than extracted — and this is asserted on the filesystem, since
  // "we did not report it" and "we did not write it" are different claims.
  const dest = tempDest()
  const result = extract(archive(entries => {
    entries.push({ name: `${ZAPRET_ROOT}/bin/evil.dll`, data: Buffer.from('not on the allowlist') })
    entries.push({ name: `${ZAPRET_ROOT}/lists/rustvy.txt`, data: Buffer.from('also not on it') })
  }), dest)
  check('an archive with extra entries still extracts', result.ok === true, result.reason)
  check('and nothing outside the allowlist was written',
    !existsSync(join(dest, 'bin', 'evil.dll')) && !existsSync(join(dest, 'lists')),
    JSON.stringify(readdirSync(dest)))
  rmSync(dest, { recursive: true, force: true })
}

/* --------------------------- extraction: zip-slip --------------------------- */
{
  // The archive is refused AND the file must not exist outside `dest`. Both halves, because a
  // refusal that wrote the file first would pass a return-value-only check.
  const dest = tempDest()
  const outside = resolve(dest, '..', 'evil.txt')
  const deepOutside = resolve(dest, '..', '..', 'deep-evil.txt')
  const result = extract(archive(entries => {
    entries.push({ name: `${ZAPRET_ROOT}/bin/../../evil.txt`, data: Buffer.from('escaped') })
    entries.push({ name: `../../../deep-evil.txt`, data: Buffer.from('escaped further') })
  }), dest)
  check('a climbing entry is refused', result.ok === false, result.reason)
  check('and the reason names it as an unsafe path rather than as a generic failure',
    /unsafe path/u.test(result.reason), result.reason)
  check('and no file appeared one level above the destination',
    !existsSync(outside), outside)
  check('and none appeared two levels above it either',
    !existsSync(deepOutside), deepOutside)
  check('and nothing was written into the destination at all, since the refusal comes first',
    !existsSync(join(dest, 'bin')), JSON.stringify(existsSync(join(dest, 'bin')) ? readdirSync(join(dest, 'bin')) : []))
  rmSync(dest, { recursive: true, force: true })
}
{
  const dest = tempDest()
  const absoluteTarget = process.platform === 'win32' ? 'C:\\Windows\\Temp\\zapret-evil.txt' : '/tmp/zapret-evil.txt'
  const result = extract(archive(entries => {
    entries.push({ name: absoluteTarget, data: Buffer.from('absolute') })
  }), dest)
  check('an absolute-path entry is refused', result.ok === false, result.reason)
  check('and nothing was written at that absolute path', !existsSync(absoluteTarget), absoluteTarget)
  rmSync(dest, { recursive: true, force: true })
}
{
  const dest = tempDest()
  const result = extract(archive(entries => {
    entries.push({ name: `${ZAPRET_ROOT}/bin/nul\0.txt`, data: Buffer.from('nul byte') })
  }), dest)
  check('an entry with a NUL in its name is refused', result.ok === false, result.reason)
  rmSync(dest, { recursive: true, force: true })
}
{
  // A deeper nest that happens to end in an allowlisted name must not match: `matchesWanted`
  // compares the whole remainder, so `evil/bin/winws.exe` is not `bin/winws.exe`.
  const dest = tempDest()
  const result = extract(makeZip([
    { name: `${ZAPRET_ROOT}/evil/${ZAPRET_FILES[0]}`, data: Buffer.from('decoy') },
    ...ZAPRET_FILES.map(path => ({ name: `${ZAPRET_ROOT}/${path}`, data: Buffer.from(`the bytes of ${path}`) })),
    ...ZAPRET_NOTICES.map(path => ({ name: `${ZAPRET_ROOT}/${path}`, data: Buffer.from('notices') })),
  ]), dest)
  check('a deeper path ending in an allowlisted name does not impersonate it',
    result.ok === true && !existsSync(join(dest, 'evil')),
    JSON.stringify({ ok: result.ok, evil: existsSync(join(dest, 'evil')) }))
  rmSync(dest, { recursive: true, force: true })
}

/* ------------------------- extraction: partial installs --------------------- */
{
  const dest = tempDest()
  const dropped = ZAPRET_FILES[0]
  const result = extract(archive(entries => {
    const index = entries.findIndex(entry => entry.name === `${ZAPRET_ROOT}/${dropped}`)
    entries.splice(index, 1)
  }), dest)
  check('a missing required file is refused rather than partially succeeding',
    result.ok === false, JSON.stringify({ ok: result.ok, reason: result.reason }))
  check('and the refusal names the file that is absent', result.reason.includes(dropped), result.reason)
  check('and nothing was written, so a half-populated tree cannot be mistaken for an install',
    !existsSync(join(dest, 'bin')), String(existsSync(join(dest, 'bin'))))
  rmSync(dest, { recursive: true, force: true })
}
{
  // Flipped, not deleted. This case used to assert that an archive with no `LICENSE.txt` is
  // refused, and that was correct against the code as written and wrong against the artifact: the
  // published release carries no notice, so the requirement made the feature unusable while the
  // suite stayed green. The obligation is ours and the installer discharges it, so extraction must
  // accept an archive without one. Keeping the case and inverting it is what stops the assumption
  // coming back.
  const dest = tempDest()
  const result = extract(archive(), dest)
  check('an archive carrying no licence notice extracts successfully',
    result.ok === true, result.reason)
  check('and every binary the service needs is on disk',
    ZAPRET_FILES.every(path => existsSync(join(dest, path))),
    JSON.stringify(ZAPRET_FILES.filter(path => !existsSync(join(dest, path)))))
  check('and the notice obligation is not claimed as discharged by extraction',
    result.notices.length === 0, JSON.stringify(result.notices))
  rmSync(dest, { recursive: true, force: true })
}
{
  // If a future release does start shipping a notice, it is still off the allowlist: one source of
  // truth for the notices we ship, and it is ours. Asserted on the filesystem.
  const dest = tempDest()
  const result = extract(archive(null, { withNotice: true }), dest)
  check('an archive that does carry a notice still extracts', result.ok === true, result.reason)
  check('but the notice is not written, because the allowlist decides what lands on disk',
    ZAPRET_NOTICES.every(path => !existsSync(join(dest, path))),
    JSON.stringify(ZAPRET_NOTICES.map(path => ({ path, exists: existsSync(join(dest, path)) }))))
  rmSync(dest, { recursive: true, force: true })
}

/* --------------------------- extraction: integrity -------------------------- */
{
  const dest = tempDest()
  const result = extract(archive(entries => {
    entries[0].crcOverride = (crc32(entries[0].data) ^ 0xdeadbeef) >>> 0
  }), dest)
  check('an entry whose bytes do not match its CRC-32 is refused', result.ok === false, result.reason)
  check('and the reason says CRC rather than leaving the cause to be guessed',
    /CRC-32/u.test(result.reason), result.reason)
  rmSync(dest, { recursive: true, force: true })
}
{
  const dest = tempDest()
  const result = extract(archive(entries => {
    entries[0].sizeOverride = entries[0].data.length + 40
  }), dest)
  check('an entry that inflates to a different length than its directory claims is refused',
    result.ok === false, result.reason)
  rmSync(dest, { recursive: true, force: true })
}
{
  // Deflate is a supported method and must actually work, or the reader claims a branch it never
  // exercises. One entry compressed, the rest stored.
  const dest = tempDest()
  const result = extract(archive(entries => {
    entries[0].method = 8
    entries[0].data = Buffer.from('a'.repeat(4096))
  }), dest)
  check('a deflate-compressed entry extracts correctly', result.ok === true, result.reason)
  // Guarded for the same reason as the staging check: an unguarded `readFileSync` threw ENOENT
  // whenever extraction had correctly refused and written nothing, which killed the run before its
  // summary and made a probe look silent. `null` is then reported as its own distinct value, so
  // "the bytes differ" and "there is no file" cannot be confused with each other.
  const deflateTarget = join(dest, ZAPRET_FILES[0])
  const deflateBytes = existsSync(deflateTarget) ? readFileSync(deflateTarget) : null
  check('and its bytes survive the round trip',
    deflateBytes !== null && deflateBytes.equals(Buffer.from('a'.repeat(4096))),
    deflateBytes === null ? 'the file was never written' : String(deflateBytes.byteLength))
  rmSync(dest, { recursive: true, force: true })
}
{
  const dest = tempDest()
  const result = extract(archive(entries => {
    entries[0].method = 99
  }), dest)
  check('an unsupported compression method is refused by name rather than misread',
    result.ok === false && /method 99/u.test(result.reason), result.reason)
  rmSync(dest, { recursive: true, force: true })
}
{
  const result = extract(Buffer.from('this is not a zip file at all'), tempDest())
  check('a buffer that is not a zip is refused with a reason naming that',
    result.ok === false && /not a zip archive/u.test(result.reason), result.reason)
  check('a non-buffer is refused rather than thrown on',
    extract('nope', tempDest()).ok === false)
  check('and an empty destination is refused', extract(archive(), '').ok === false)
}

/* ---------------------------- download: the refusals ------------------------- */
{
  const result = await download({ version: '9.9.9', dest: tempDest(), fetchImpl: async () => ({ ok: true }) })
  check('an unpinned version is refused rather than downloaded without a digest to check',
    result.ok === false && /not the pinned/u.test(result.reason), result.reason)
  check('and the refusal names both the asked-for and the pinned version',
    result.reason.includes('9.9.9') && result.reason.includes('1.10.4'), result.reason)
}
{
  const result = await download({ dest: '', fetchImpl: async () => ({ ok: true }) })
  check('a missing destination is refused', result.ok === false, result.reason)
}
{
  const result = await download({
    dest: tempDest(),
    fetchImpl: async () => { throw new Error('socket hang up') },
  })
  check('a transport failure is reported as one, not thrown at the caller',
    result.ok === false && result.reason.includes('socket hang up'), result.reason)
}
{
  const result = await download({
    dest: tempDest(),
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }),
  })
  check('a refused download names the status', result.ok === false && result.reason.includes('404'), result.reason)
}
{
  // Truncated: the size check runs before the hash, so an interrupted transfer is reported as
  // truncation rather than as tampering. Those are different failures with different remedies.
  const result = await download({
    dest: tempDest(),
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => '10' },
      arrayBuffer: async () => new Uint8Array(10),
    }),
  })
  check('a truncated download is refused as truncated, naming both byte counts',
    result.ok === false && /10 bytes rather than the pinned 1518649/u.test(result.reason), result.reason)
}
{
  // Padded to exactly the pinned length so the size check passes and the digest check is the one
  // that fires. Both digests must be named, because "the hash was wrong" without the values gives
  // a user nothing to compare against what they were told to expect.
  // Padded to exactly the pinned length, computed from the real archive size rather than from a
  // guessed constant — the first draft of this test hardcoded 4000 and landed 2553 bytes short, so
  // it exercised the size refusal while claiming to exercise the digest one.
  const crafted = archive()
  const padded = Buffer.concat([crafted, Buffer.alloc(ZAPRET_BYTES - crafted.byteLength)])
  check('the padding arithmetic really produces the pinned length',
    padded.byteLength === ZAPRET_BYTES, `${padded.byteLength} vs ${ZAPRET_BYTES}`)
  const result = await download({
    dest: tempDest(),
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(padded.byteLength) },
      arrayBuffer: async () => padded,
    }),
  })
  check('a correct-length archive with the wrong digest is refused', result.ok === false, result.reason)
  check('and the refusal names the digest it found',
    result.ok === false && /^[0-9a-f]{64}$/u.test(String(/was ([0-9a-f]{64})/u.exec(result.reason)?.[1] ?? '')),
    result.reason.slice(0, 160))
  check('and it names the digest that was expected',
    result.ok === false && result.reason.includes(ZAPRET_SHA256.toLowerCase()), result.reason.slice(0, 160))
  check('and it says nothing was extracted',
    result.ok === false && /nothing was extracted/u.test(result.reason), result.reason.slice(0, 160))
}
{
  // An oversized response must be abandoned while it streams, not after it has been buffered.
  let sawProgress = false
  const chunks = []
  for (let index = 0; index < 8; index += 1) chunks.push(Buffer.alloc(8 * 1024 * 1024))
  const result = await download({
    dest: tempDest(),
    onProgress: () => { sawProgress = true },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(64 * 1024 * 1024) },
      body: (async function* stream() { for (const chunk of chunks) yield chunk })(),
    }),
  })
  check('progress is reported in bytes as they arrive', sawProgress, String(sawProgress))
  check('and a response larger than the cap is abandoned mid-stream',
    result.ok === false && /abandoned/u.test(result.reason), result.reason)
}
{
  // The loopback server, so the streaming path is exercised against a real http response rather
  // than only against a synthetic object.
  const payload = archive()
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(payload.byteLength) })
    response.end(payload)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const dest = tempDest()
  const seen = []
  const result = await download({
    dest,
    log: line => seen.push(String(line)),
    fetchImpl: (url, options) => fetch(`${origin}/${String(url).split('/').pop()}`, options),
    onProgress: progress => seen.push(`progress ${progress.received}/${progress.total}`),
  })
  // The digest cannot match a crafted archive, and neither can its length — so this case proves
  // the streaming path works end to end and is refused at the size check with the true byte count
  // named. The digest branch itself is covered by the padded case above, which is the only way to
  // reach it without a bypass. Claiming this one tested the digest would have been the same
  // mistake as a control that falls into the branch it was meant to avoid.
  check('a real streamed response arrives whole and is refused at the pinned size, naming the true length',
    result.ok === false && result.reason.includes(`${payload.byteLength} bytes`), result.reason.slice(0, 130))
  check('and the request went to the pinned URL',
    seen.some(line => line.includes(ZAPRET_URL)), JSON.stringify(seen.slice(0, 2)))
  check('and progress was reported against the declared content length',
    seen.some(line => line.startsWith(`progress ${payload.byteLength}/${payload.byteLength}`)),
    JSON.stringify(seen.filter(line => line.startsWith('progress'))))
  check('and nothing was extracted', !existsSync(join(dest, 'bin')), String(existsSync(join(dest, 'bin'))))
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
  rmSync(dest, { recursive: true, force: true })
}

/* --------------------------------- summary ---------------------------------- */
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('')
  for (const result of failed) console.log(`FAIL  ${result.label}${result.detail === undefined ? '' : `  — ${result.detail}`}`)
  // `exitCode` rather than `process.exit`: exiting while a loopback server's keep-alive sockets
  // are still closing trips a libuv assertion on Windows and reports 0xC0000409 instead of 1,
  // which swallows this summary and reads as an infrastructure fault rather than a red suite.
  process.exitCode = 1
} else {
  process.exitCode = 0
}
void exit
