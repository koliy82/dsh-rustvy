/**
 * Mixed-alphabet corruption scanner for every file this package ships or documents.
 *
 * Why this exists as a gate check rather than a reviewer's habit. Corruption of
 * this class hit the project three times: a CJK character inside Russian prose in
 * `docs/`, a CJK character inside a Russian comment, and — on a single day — two
 * words whose halves were in different alphabets, `garant` beside `ровано` and
 * `ано` beside `nimous`. The first two are visible to a CJK scan. The third class
 * is not: a Latin/Cyrillic word reads as a word to the person who typed it, so it
 * survives review, and it survived an editor that rendered it as clean text. Three
 * instances is enough to stop treating it as a discipline problem and make it a
 * check that runs without anybody remembering.
 *
 * Two rules, because the two corruption classes are different.
 *
 * A token is a run of `[A-Za-z\u0400-\u04FF]`. If one token holds letters from both
 * alphabets the word is corrupted. This cannot false-positive on legitimate code:
 * an identifier like `uptimeEndpoint` is pure Latin, a Russian string is pure
 * Cyrillic, and hyphens, underscores and quotes all break the run, so
 * `best-effort`, `http_502` and «кавычки» are three clean tokens. What it catches is
 * exactly the case nobody can see: one word, two alphabets.
 *
 * The second rule asks which *scripts* a file may contain, and the answer is a
 * function of the file's declared language rather than one global allowlist. A
 * blanket exemption for `locale/` was considered and rejected: it would have
 * removed coverage from `ru.json`, the most plausible place in the package for a
 * glued token or a stray ideograph. Naming the language instead turns the exemption
 * into an assertion, and buys a case a single global list can never see — Cyrillic
 * smuggled into `en.json`. An unrecognised locale is a failure rather than a skip,
 * because a silently skipped new language is the same shape as a check that never
 * ran, which is how four escaping assertions in a dashboard survived without ever
 * executing once.
 *
 * The script-independent half of the allowed set — ASCII, whitespace, and the ten
 * typographic codepoints Russian prose uses — is the inventory this project's
 * documents were scanned with by hand all week, so the automated rule and the
 * manual habit cannot drift apart.
 *
 * Nothing here throws into a caller: an unreadable file is reported as a finding
 * rather than an exception, so the gate prints what it could not read instead of
 * dying before its summary.
 *
 * @module dsh-rustvy/charset-check
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** One word: a run of Latin and/or Cyrillic letters, with nothing between them. */
const TOKEN = /[A-Za-z\u0400-\u04FF]+/gu
const HAS_LATIN = /[A-Za-z]/u
const HAS_CYRILLIC = /[\u0400-\u04FF]/u

/**
 * Inclusive codepoint ranges every text file may hold, whatever its language:
 * the whitespace a text file needs, printable ASCII, and the ten typographic
 * characters this project's Russian prose actually uses — section sign,
 * guillemets, middle dot, multiplication sign, en and em dash, ellipsis, arrow,
 * minus, and the three comparison signs.
 *
 * Deliberately absent: curly quotes, non-breaking space, and every combining mark.
 * None of them appears in this repository, and each is a way to make two visually
 * identical files differ, so their absence is worth keeping enforced.
 */
const COMMON = [
  [0x09, 0x0A], [0x0D, 0x0D],
  [0x20, 0x7E],
  [0xA7, 0xA7], [0xAB, 0xAB], [0xB7, 0xB7], [0xBB, 0xBB], [0xD7, 0xD7],
  [0x2013, 0x2014], [0x2026, 0x2026], [0x2192, 0x2192], [0x2212, 0x2212],
  [0x2248, 0x2248], [0x2264, 0x2265],
]

/** Cyrillic, including the supplement block `ё` and friends live in. */
const CYRILLIC = [[0x400, 0x4FF], [0x500, 0x52F]]

/**
 * Chinese. Kana and hangul are deliberately *not* here, so a Japanese or Korean
 * character inside the Chinese locale is still a failure — the file declares one
 * language, and a second one arriving in it is corruption whatever it is.
 */
const CJK = [
  [0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF],
  [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF01, 0xFF5E], [0xFFE0, 0xFFE6],
]

/**
 * The language profiles, by the scripts each one may carry beyond {@link COMMON}.
 * @readonly
 */
export const PROFILES = Object.freeze({
  /** Latin only: the English locale. Cyrillic here is a finding. */
  latin: Object.freeze({ name: 'latin', scripts: [] }),
  /** Latin and Cyrillic: source, the Russian README, and the Russian locale. */
  latinCyrillic: Object.freeze({ name: 'latin+cyrillic', scripts: CYRILLIC }),
  /** Latin and Chinese: the Chinese locale. Cyrillic here is a finding. */
  latinCjk: Object.freeze({ name: 'latin+cjk', scripts: CJK }),
})

/**
 * The primary language subtag of a locale file name: `zh-CN.json` is `zh`.
 * @param baseName - the file's base name.
 * @returns the subtag, or `undefined` when the name is not a locale file.
 */
function languageOf(baseName) {
  const match = /^([A-Za-z]{2,8})(?:[-_.][A-Za-z0-9]{1,8})*\.json$/u.exec(String(baseName ?? ''))
  return match === null ? undefined : match[1].toLowerCase()
}

/**
 * Which profile a file is judged against, from its path.
 *
 * Decided by name rather than by content, because a file that already holds the
 * wrong alphabet cannot be trusted to say which alphabet it wanted.
 *
 * @param file - a path, relative or absolute.
 * @returns `{ profile, language?, unknownLanguage? }`. `profile` is one of
 *   {@link PROFILES}, or `undefined` when a locale file names a language this gate
 *   has no rule for — which the caller must treat as a failure, never as a skip.
 */
export function profileFor(file) {
  const baseName = String(file ?? '').split(sep).join('/').split('/').pop() ?? ''
  const isLocale = /(^|[\\/])locale[\\/][^\\/]+$/u.test(String(file ?? '').split(sep).join('/'))
  if (isLocale) {
    const language = languageOf(baseName)
    if (language === 'en') return { profile: PROFILES.latin, language }
    if (language === 'ru') return { profile: PROFILES.latinCyrillic, language }
    if (language === 'zh') return { profile: PROFILES.latinCjk, language }
    return { profile: undefined, language, unknownLanguage: language ?? baseName }
  }
  return { profile: PROFILES.latinCyrillic }
}

/**
 * Whether a path is a text file this scanner can read as characters.
 * @param file - a path.
 * @returns true for text extensions and for `LICENSE`.
 */
export function isTextFile(file) {
  const baseName = String(file ?? '').split(sep).join('/').split('/').pop() ?? ''
  if (baseName === 'LICENSE' || baseName === 'NOTICE') return true
  const dot = baseName.lastIndexOf('.')
  if (dot <= 0) return false
  const extension = baseName.slice(dot).toLowerCase()
  return ['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.ps1', '.svg', '.txt', '.html'].includes(extension)
}

/**
 * Whether one codepoint belongs in a file judged by this profile.
 * @param profile - one of {@link PROFILES}.
 * @param codepoint - the character to judge.
 * @returns true when the character is expected.
 */
function expected(profile, codepoint) {
  for (const [low, high] of COMMON) {
    if (codepoint >= low && codepoint <= high) return true
  }
  for (const [low, high] of profile?.scripts ?? []) {
    if (codepoint >= low && codepoint <= high) return true
  }
  return false
}

/**
 * Scan one string for both corruption classes.
 *
 * Lines are walked individually so a finding carries a line number, and the
 * carriage return a CRLF file leaves behind is expected rather than reported.
 *
 * @param text - the file contents.
 * @param options - `{ profile, file }`; `profile` defaults to Latin and Cyrillic,
 *   `file` names the source in each finding.
 * @returns an array of `{ file, line, kind, detail }`, empty when the text is clean.
 */
export function scanText(text, { profile = PROFILES.latinCyrillic, file = '<text>' } = {}) {
  const findings = []
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const at = index + 1
    TOKEN.lastIndex = 0
    let match = TOKEN.exec(line)
    while (match !== null) {
      const token = match[0]
      if (HAS_LATIN.test(token) && HAS_CYRILLIC.test(token)) {
        findings.push({ file, line: at, kind: 'mixed-alphabet', detail: token })
      }
      match = TOKEN.exec(line)
    }
    for (const char of line) {
      const codepoint = char.codePointAt(0)
      if (!expected(profile, codepoint)) {
        findings.push({
          file,
          line: at,
          kind: 'unexpected-character',
          detail: `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')} (profile ${profile.name})`,
        })
      }
    }
  }
  return findings
}

/**
 * Scan one file on disk, under the profile its own name declares.
 *
 * A locale file naming a language this gate has no rule for returns an
 * `unknown-locale-language` finding instead of being scanned under a guessed
 * profile, so the caller fails loudly rather than passing vacuously.
 *
 * @param path - an absolute or root-relative path.
 * @returns the findings, or one `unreadable` finding instead of an exception.
 */
export function scanFile(path) {
  const { profile, unknownLanguage } = profileFor(path)
  if (profile === undefined) {
    return [{
      file: String(path),
      line: 0,
      kind: 'unknown-locale-language',
      detail: `не знаю, что считать ожидаемым для этой локали: ${unknownLanguage}`,
    }]
  }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return [{ file: String(path), line: 0, kind: 'unreadable', detail: String(error?.message ?? error) }]
  }
  return scanText(text, { profile, file: String(path) })
}

/**
 * Expand one `package.json` `files` entry into the text files it ships.
 *
 * Directories are walked one level deep and filtered to text files, so a binary
 * asset is skipped rather than read as characters.
 *
 * @param root - the repository root.
 * @param entries - the `files` array.
 * @returns absolute paths of every text file that ships, sorted.
 */
export function shippedTextFiles(root, entries) {
  const found = []
  for (const entry of entries ?? []) {
    const full = resolve(root, entry)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full)) {
        const child = join(full, name)
        if (statSync(child).isFile() && isTextFile(child)) found.push(child)
      }
      continue
    }
    if (isTextFile(full)) found.push(full)
  }
  return [...new Set(found)].sort()
}

/**
 * The documentation files, which do not ship but are read by people.
 * @param root - the repository root.
 * @returns absolute paths of every `docs/*.md`, sorted.
 */
export function docFiles(root) {
  const dir = join(root, 'docs')
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => join(dir, name))
}

/**
 * One line describing a set of findings, for a gate's detail column.
 * @param findings - what {@link scanFile} returned.
 * @param root - the repository root, so paths print short.
 * @param limit - how many to name before summarising the rest.
 * @returns a printable summary, or an empty string when there are none.
 */
export function describe(findings, root, limit = 6) {
  const shown = findings.slice(0, limit).map(one => {
    const where = one.line > 0 ? `${root ? relative(root, one.file) : one.file}:${one.line}` : (root ? relative(root, one.file) : one.file)
    return `${where} ${one.kind} ${one.detail}`
  })
  const rest = findings.length - shown.length
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ')
}

/**
 * Prove the scanner can go red, on throwaway files outside the repository.
 *
 * A check that only ever passes is indistinguishable from a check that never ran,
 * which is how this project shipped a blocking bug on a fully green suite and how
 * four escaping assertions in a dashboard survived without executing once. So the
 * gate asserts both directions: each corruption class is caught, and clean input —
 * carrying the shapes most likely to look corrupted, like a camelCase identifier, a
 * status code, a hyphenated compound and Russian guillemets — is not.
 *
 * The corrupted samples are built by concatenation and `fromCodePoint` rather than
 * written as literals, so this module does not itself contain the corruption it
 * hunts.
 *
 * @returns one entry per case, each the findings from a throwaway file. The four
 *   corruption cases — a mixed token, an ideograph where none is allowed, Cyrillic
 *   inside `en.json`, and a locale language this gate has no rule for — must come
 *   back non-empty; the three clean ones must come back empty.
 */
export function selfTest() {
  let dir
  try {
    const base = process.env.TMP ?? process.env.TEMP ?? '/tmp'
    dir = mkdtempSync(join(resolve(base), 'charset-selftest-'))
  } catch (error) {
    // A directory we cannot create means the self-test cannot run, and saying so is
    // better than reporting six empty results that look like six passes.
    return { unavailable: String(error?.message ?? error) }
  }
  try {
    // The `locale` subdirectory is what makes `profileFor` read these names as
    // locales rather than as loose files, so it has to exist before anything is
    // written into it.
    const locale = join(dir, 'locale')
    const docs = join(dir, 'docs')
    mkdirSync(locale, { recursive: true })
    mkdirSync(docs, { recursive: true })
    const makeLocale = (name, body) => {
      const path = join(locale, name)
      writeFileSync(path, body, 'utf8')
      return path
    }

    const results = {}

    /* The three corruptions the gate must catch. */
    const mixed = join(docs, 'mixed.md')
    writeFileSync(mixed, `Отчёт ${'garant' + 'ировано'} уходит.\n`, 'utf8')
    results.mixedToken = scanFile(mixed)

    const ideograph = join(docs, 'ideograph.md')
    // U+6BCF is one of the ideographs that reached this repository twice. It is
    // written as a codepoint rather than typed so that this module passes its own
    // scan — a corruption scanner carrying the corruption it hunts would fail the
    // moment anybody widened the gate to cover `scripts/`.
    writeFileSync(ideograph, `Проверка ${String.fromCodePoint(0x6BCF)} минуту.\n`, 'utf8')
    results.ideographNotAllowed = scanFile(ideograph)

    results.cyrillicInEnglishLocale = scanFile(makeLocale('en.json', '{"meta":{"title":"Заголовок"}}\n'))

    // An unrecognised language must fail rather than be scanned under a guessed
    // profile: a silently skipped locale is a check that never ran. U+65E5 U+672C
    // U+8A9E spell "Japanese" in Japanese, as codepoints for the reason above.
    results.unknownLocaleLanguage = scanFile(makeLocale('ja.json',
      `{"meta":{"title":"${String.fromCodePoint(0x65E5, 0x672C, 0x8A9E)}"}}\n`))

    /* The three clean cases the gate must not flag. */
    const clean = join(docs, 'clean.md')
    writeFileSync(clean, 'Отчёт гарантированно уходит: uptimeEndpoint, 502 status code, http_502, «кавычки» — best-effort.\n', 'utf8')
    results.cleanDocument = scanFile(clean)

    results.chineseLocale = scanFile(makeLocale('zh.json',
      `{"meta":{"description":"${String.fromCodePoint(0x4E2D, 0x6587, 0x8BF4, 0x660E, 0xFF0C, 0x3002)}"}}\n`))

    results.russianLocale = scanFile(makeLocale('ru.json', '{"meta":{"title":"Заголовок — Rustvy"}}\n'))

    return results
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The directory is in the system temp area; failing to remove it is not worth
      // failing a publish gate over.
    }
  }
}
