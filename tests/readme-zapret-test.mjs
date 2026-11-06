// Documentation test for the packet-level bypass section of both READMEs.
//
// It exists for two reasons. First, a removal probe on README prose is otherwise impossible —
// nothing in the suite read these files, so a sentence could be deleted and every test would stay
// green. Second, the drift it guards against is real and has a shape of its own: the English
// README has carried every section the Russian one has, and a feature that registers a kernel
// driver while missing from one language is exactly the drift that makes a reader distrust the
// other half of the document.
//
// Every claim checked here is load-bearing rather than decorative: each is something a user acts
// on, a number that was deliberately not softened, or a limit that was deliberately not hidden.
//
// Offline and fast: it reads two files and compares. No network, no mounting, no fixtures.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const ruRaw = readFileSync(join(root, 'README.md'), 'utf8')
const enRaw = readFileSync(join(root, 'README.en.md'), 'utf8')
// Prose is line-wrapped, and a wrapped phrase is absent from the file as a substring while being
// present in the document — the failure mode that has produced false negatives twice in this
// project. Collapsing whitespace runs is what makes "contains" mean what it says. The same is
// done to the needles, so a claim written across a line break still matches.
const flat = text => text.replace(/\s+/gu, ' ')
const ru = flat(ruRaw)
const en = flat(enRaw)

const results = []
/**
 * Record one assertion.
 *
 * @param label - what is being claimed.
 * @param ok - whether it held.
 * @param detail - shown beside the label when it did not.
 */
function check(label, ok, detail) {
  results.push({ label, ok: ok === true })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${ok === true ? '' : `  — ${String(detail).slice(0, 160)}`}`)
}

/**
 * One claim, in both languages.
 *
 * @typedef {{ label: string, ru: string[], en: string[] }} Claim
 */

/** @type {Claim[]} */
const CLAIMS = [
  {
    label: 'the section exists in both languages, inside the TSPU section rather than as a new one',
    ru: ['### «Обход на уровне пакетов»: zapret'],
    en: ['### "Packet-level bypass": zapret'],
  },
  {
    label: 'why a socket cannot do this: the decoy packet would corrupt the real stream',
    ru: ['--dpi-desync=fake', 'подставной пакет', 'испортил бы его'],
    en: ['--dpi-desync=fake', 'decoy packet', 'would corrupt it'],
  },
  {
    label: 'and the sequence overlap, with the kernel named as the reason it is unreachable',
    ru: ['--dpi-desync-split-seqovl', 'номера последовательности присваивает ядро'],
    en: ['--dpi-desync-split-seqovl', 'sequence numbers are assigned by the kernel'],
  },
  {
    // Deliberately not softened: these two numbers are the reason the button exists, and a reader
    // who thinks fragmentation was nearly good enough will not understand why a driver is needed.
    label: 'the multisplit figures are stated unsoftened, against fake,fakedsplit',
    ru: ['семейству `multisplit`', '31,1 %', '78,6 %', 'fake,fakedsplit', 'худшее'],
    en: ['`multisplit` family', '31.1 %', '78.6 %', 'fake,fakedsplit', 'weakest'],
  },
  {
    label: 'the pinned release, its source, and that both size and sha256 are verified',
    ru: ['1.10.4', 'github.com/Flowseal/zapret-discord-youtube', 'sha256', 'длину в байтах'],
    en: ['1.10.4', 'github.com/Flowseal/zapret-discord-youtube', 'sha256', 'byte length'],
  },
  {
    label: 'exactly six files, by allowlist, named',
    ru: ['шесть файлов по списку разрешённых', 'winws.exe', 'WinDivert.dll', 'WinDivert64.sys', 'cygwin1.dll'],
    en: ['six files by allowlist', 'winws.exe', 'WinDivert.dll', 'WinDivert64.sys', 'cygwin1.dll'],
  },
  {
    // Backticked on purpose: a bare `dsh-rustvy-zapret` is also a substring of a corrupted
    // `dsh-rustvy-zapret-old`, so a probe that renamed the service left the check green. Asserting
    // the delimited form is what makes the needle able to distinguish the name from a near-miss.
    label: 'the service name, the hostlist, and the disk footprint',
    ru: ['`dsh-rustvy-zapret`', 'список хостов', '3,2 МБ'],
    en: ['`dsh-rustvy-zapret`', 'hostlist', '3.2 MB'],
  },
  {
    label: 'one UAC prompt, and the reason no kernel driver can avoid it',
    ru: ['манифест требует прав администратора', 'одного привилегированного вызова', 'ни один драйвер ядра'],
    en: ['manifest requiring administrator', 'one elevated call', 'no kernel driver can avoid this'],
  },
  {
    label: 'and why nothing after it needs elevation',
    ru: ['SID права управления в дескрипторе безопасности службы'],
    en: ['SID control rights in the service\'s security descriptor'],
  },
  {
    label: 'licence provenance: winws MIT, WinDivert LGPLv3-or-GPLv2 with GPLv2 elected',
    ru: ['MIT (bol-van, Flowseal)', 'LGPLv3-или-GPLv2', 'выбран вариант GPLv2', 'NOTICE-zapret.txt'],
    en: ['MIT (bol-van, Flowseal)', 'LGPLv3-or-GPLv2', 'GPLv2 is the elected option', 'NOTICE-zapret.txt'],
  },
  {
    label: 'the aggregation argument, and that the upstream archive ships no licence file',
    ru: ['отдельным процессом', 'соединении отдельных программ', 'лицензионного файла нет вовсе', '63'],
    en: ['separate process', 'aggregation of separate programs', 'no licence file at all', '63'],
  },
  {
    // The ruling that changed: a warning with an explicit override, not a refusal.
    label: 'a foreign zapret is a warning requiring confirmation, not a refusal',
    ru: ['предупреждение, а не утверждённый факт, и не отказ', 'явное подтверждение'],
    en: ['a warning, not an asserted fact, and not a refusal', 'explicit confirmation'],
  },
  {
    label: 'the overlap is at the capture layer, with the mechanism stated',
    ru: ['Совпадает уровень перехвата', 'возвращает его в стек', 'рядом с нашим разделённым'],
    en: ['capture layer is what overlaps', 'returns it to the stack', 'beside our split one'],
  },
  {
    // Asserted in tests/zapret-host-test.mjs against the real route answer, so the README must
    // not paraphrase it into something that claims knowledge it does not have.
    label: 'and it says plainly that this was not measured',
    ru: ['Измерено это не было', 'предположение о поведении WinDivert с двумя дескрипторами'],
    en: ['This was not measured', 'hypothesis about WinDivert\'s behaviour with two handles'],
  },
  {
    label: 'the user\'s own instruction: check rustvy is not in your lists first',
    ru: ['в списках вашей конфигурации zapret нет rustvy'],
    en: ['rustvy is not already in your zapret configuration\'s lists'],
  },
  {
    label: 'the limit: TCP 443 to the configured host only, and not a VPN',
    ru: ['только TCP 443 до имени провайдера из настроек', 'не VPN'],
    en: ['TCP 443 to the provider hostname from the settings', 'not a VPN'],
  },
  {
    label: 'removal takes the service and the files, and prompts again on purpose',
    ru: ['убирает и службу, и скачанные файлы', 'намеренно'],
    en: ['removes both the service and the files', 'deliberately'],
  },
  {
    // The gap belongs in the README and not only in the release notes: a reader is entitled to
    // know which half of this feature was run and which half was reasoned.
    label: 'the honest gap: the install path has never been executed anywhere',
    ru: ['ни разу не выполнялся ни на одной машине', 'выведена из устройства Windows, а не прогнана'],
    en: ['never been executed on any machine', 'reasoned from how Windows works, not run'],
  },
  {
    label: 'and what IS verified, so the gap is bounded rather than open-ended',
    ru: ['скачивание и распаковка на настоящем опубликованном артефакте', 'точными опубликованными размерами'],
    en: ['download and extraction against the real published artifact', 'exact published sizes'],
  },
]

for (const claim of CLAIMS) {
  const missingRu = claim.ru.filter(needle => !ru.includes(flat(needle)))
  const missingEn = claim.en.filter(needle => !en.includes(flat(needle)))
  check(`${claim.label} [ru]`, missingRu.length === 0, JSON.stringify(missingRu))
  check(`${claim.label} [en]`, missingEn.length === 0, JSON.stringify(missingEn))
}

// The overclaim that was removed from the page must not come back into either document. It stated
// an unmeasured mechanism as fact, which is the defect — not the wording around it.
check('the superseded handshake claim is absent from the Russian README',
  !ru.includes('сломать рукопожатия') && !ru.includes('ломают рукопожатия'), 'the overclaim came back')
check('and from the English one',
  !en.includes("break each other's handshakes") && !en.includes('ломают рукопожатия'), 'the overclaim came back')

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
