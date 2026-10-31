#!/usr/bin/env node
/**
 * dsh-rustvy — run every test suite, discovered rather than enumerated.
 *
 * Discovery is the point. A list of suite names has to be maintained, and a list that
 * is not maintained fails in the direction that nobody notices: it still reports green,
 * because the missing suite is simply never run. That is how three suites totalling 95
 * assertions — including the four-combination matrix this release depends on and the
 * byte-identical DeepSeek check that makes the user's absolute requirement absolute —
 * came to exist on disk and never run under the documented release command. An ordinary
 * mistake in a list reddens and gets fixed; this one does not.
 *
 * Each file is its own process and its exit code is read immediately after its own run,
 * through `spawnSync`'s return value rather than through any ambient shell variable. A
 * loop that reads `$LASTEXITCODE` after a second command has run reports the second
 * command's status for the first file, which produced a false red in this project once
 * already.
 *
 * @module dsh-rustvy/run-tests
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TESTS = join(ROOT, 'tests')

/**
 * Every suite on disk, in a stable order.
 *
 * Sorted by name rather than left in directory order, so two runs of the same tree
 * report the same sequence and a diff between them means something.
 *
 * @returns the absolute paths of every `tests/*.mjs`.
 */
export function discoverSuites() {
  return readdirSync(TESTS)
    .filter(name => name.endsWith('.mjs'))
    .sort()
    .map(name => join(TESTS, name))
}

/**
 * Run one suite in its own process.
 *
 * @param file - the suite's absolute path.
 * @returns `{ file, status, signal, ms, output }`, where `status` is the exit code and
 *   is `null` when the process was killed by a signal instead of exiting.
 */
function runSuite(file) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    // Inherited rather than piped: a suite's own output is the evidence for its failure,
    // and a failure without its assertion lines is a number to go and reproduce.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    file,
    status: result.status,
    signal: result.signal ?? null,
    error: result.error,
    ms: Date.now() - startedAt,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/**
 * The tally a suite printed for itself, when it printed one.
 *
 * Read from the suite's own last line rather than counted here, so this runner cannot
 * disagree with the suite about what passed. Absent is reported as absent rather than
 * as zero.
 *
 * @param output - everything the suite wrote.
 * @returns the tally text, or `null`.
 */
function tallyOf(output) {
  const found = output.match(/^\d+\/\d+ passed$/mu)
  return found === null ? null : found[0]
}

const only = process.argv.slice(2).filter(arg => !arg.startsWith('-'))

/**
 * Run every discovered suite and exit non-zero if any failed.
 *
 * Guarded behind a direct-invocation check, and the guard is load-bearing rather than
 * tidiness: the structural gate imports `discoverSuites` from this module to derive its
 * floor from what is on disk. Without the guard that import would execute every suite in
 * a child process each, which is both slow and a contradiction of the gate's own
 * no-child-process design — the gate is meant to work offline and anywhere.
 */
function main() {
  const suites = only.length > 0
    ? discoverSuites().filter(file => only.some(name => relative(TESTS, file) === name || file.endsWith(name)))
    : discoverSuites()

  if (suites.length === 0) {
    console.error('no suites matched — discovery found nothing to run, which is itself a failure')
    process.exit(1)
  }

  console.log(`discovered ${suites.length} suite(s) in ${relative(ROOT, TESTS)}/\n`)

  const failures = []
  let totalMs = 0
  for (const file of suites) {
    const name = relative(ROOT, file)
    const run = runSuite(file)
    totalMs += run.ms
    const tally = tallyOf(run.output)
    if (run.status === 0) {
      console.log(`PASS  ${name.padEnd(42)} ${tally ?? ''} (${run.ms} ms)`)
      continue
    }
    // Named at the point of failure with its own output, because the whole defect this
    // script exists to prevent is a runner that reports an aggregate and hides which file
    // produced it.
    console.log(`FAIL  ${name.padEnd(42)} exit=${run.status ?? `signal ${run.signal}`} (${run.ms} ms)`)
    if (run.error !== undefined) console.log(`      spawn error: ${run.error.message}`)
    const lines = run.output.split('\n').filter(line => /^FAIL/u.test(line) || /^\s+failed:/u.test(line))
    for (const line of lines.slice(0, 12)) console.log(`      ${line.slice(0, 200)}`)
    if (lines.length === 0) {
      for (const line of run.output.split('\n').slice(-8)) console.log(`      ${line.slice(0, 200)}`)
    }
    failures.push({ name, status: run.status, signal: run.signal })
  }

  console.log(`\n${suites.length - failures.length}/${suites.length} suites passed in ${(totalMs / 1000).toFixed(1)} s`)
  if (failures.length > 0) {
    console.log('blocking publication — a red suite is not a warning:')
    for (const failure of failures) {
      console.log(`  ${failure.name} exit=${failure.status ?? `signal ${failure.signal}`}`)
    }
    process.exit(1)
  }
}

// Compared as URLs rather than as strings, so Windows separators and drive-letter case
// cannot make a direct invocation look like an import or the reverse.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
