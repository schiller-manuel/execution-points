#!/usr/bin/env node
/**
 * Intention-to-treat statistical analyzer for v2.2 benchmark `results.jsonl` files.
 *
 * Closes ST-02..ST-07, E9-01, N-05, N-06, N-07, N-08, N-09, N-13, N-21, N-26..N-28:
 * - Deduplicates by (runId, trialId) and compares ALL provenance hashes + versions
 *   (refusing dirty, missing, or mismatched provenance unless `--allow-mixed` is passed).
 * - Primary analysis runs strictly over equal-capability Strata B + C (`io-seam` + `real-async`);
 *   Stratum A (`closed-module`) is reported separately as a capability stratum.
 * - E9 metrics are computed ONLY over `adequateReproduction === true` rows, reported per stratum & task.
 * - Billed `aiCredits` is the primary cost metric (`estimatedUsd` labeled as list-price estimate).
 * - Counts `notStarted`, `aborted`, `infraFailure`, `ungradable`, and `usageMissing` explicitly.
 *
 * Usage:
 *   node bench/analyze.mjs [--allow-mixed] <results.jsonl> [more.jsonl...]
 */
import { readFileSync } from 'node:fs'
import { formatUsd } from './pricing.mjs'
import { formatCI, matchedRiskDifferenceCI, stratifiedCMH, wilsonCI } from './stats.mjs'

const args = process.argv.slice(2)
const allowMixed = args.includes('--allow-mixed')
const files = args.filter((a) => !a.startsWith('--'))

if (files.length === 0) {
  console.error('Usage: node bench/analyze.mjs [--allow-mixed] <results.jsonl> [more.jsonl...]')
  process.exit(1)
}

const rawRows = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    rawRows.push({ file, row: JSON.parse(line) })
  }
}

const PROVENANCE_FIELDS = [
  'harnessSha256',
  'calibrationSha256',
  'lockfileSha256',
  'toolSha256',
  'tasksSha256',
  'vitestVersion',
  'typescriptVersion',
]

const seenKeys = new Set()
const rows = []
let duplicateSkipped = 0
const provenanceSets = Object.fromEntries(PROVENANCE_FIELDS.map((k) => [k, new Set()]))
let dirtyRows = 0
let missingProvRows = 0

for (const { file, row } of rawRows) {
  const runKey = row.runId ?? file
  const dedupKey = `${runKey}::${row.trialId}`
  if (seenKeys.has(dedupKey)) {
    duplicateSkipped++
    continue
  }
  seenKeys.add(dedupKey)

  if (row.gitDirty === true) dirtyRows++
  let missingAny = false
  for (const f of PROVENANCE_FIELDS) {
    if (row[f] === undefined || row[f] === null) missingAny = true
    else provenanceSets[f].add(String(row[f]))
  }
  if (missingAny) missingProvRows++
  rows.push(row)
}

// N-07: Enforce full provenance matching, clean tree, and non-missing hashes unless --allow-mixed
const mismatchedFields = PROVENANCE_FIELDS.filter((f) => provenanceSets[f].size > 1)
if (mismatchedFields.length > 0 || dirtyRows > 0 || missingProvRows > 0) {
  const parts = []
  if (mismatchedFields.length > 0) parts.push(`mismatched=[${mismatchedFields.join(',')}]`)
  if (dirtyRows > 0) parts.push(`dirtyRows=${dirtyRows}`)
  if (missingProvRows > 0) parts.push(`missingProvenanceRows=${missingProvRows}`)
  const msg = `Provenance check failed (${parts.join(', ')}).`
  if (!allowMixed) {
    console.error(`ERROR: ${msg} Pass --allow-mixed to pool anyway.`)
    process.exit(2)
  }
  console.warn(`WARNING: ${msg}`)
}

if (duplicateSkipped > 0) {
  console.warn(`WARNING: Skipped ${duplicateSkipped} exact duplicate (runId, trialId) row(s).`)
}

function summarizeGroup(items) {
  const active = items.filter((r) => !r.notStarted)
  const notStarted = items.length - active.length
  const n = active.length
  const solved = active.filter((r) => r.solved).length
  const oracle = active.filter((r) => r.oraclePass).length
  const red = active.filter((r) => r.redReproducesBug).length
  const adequateRed = active.filter((r) => r.adequateReproduction).length
  // N-09: Only count explicit `noGlobalMonkeyPatch === false` (null on aborted/not_started is NOT a patch!)
  const monkeyPatch = active.filter((r) => r.noGlobalMonkeyPatch === false).length
  const adoptedEp = active.filter((r) => r.usesExecutionPoints).length
  const infraFailures = active.filter((r) => Boolean(r.infraFailure)).length
  const ungradable = active.filter((r) => Boolean(r.harnessError || r.ungradable)).length
  const aborted = active.filter((r) => Boolean(r.aborted)).length
  const usageMissing = active.filter((r) => Boolean(r.usage?.usageMissing)).length

  // N-06: Compute E9 ONLY over rows with `adequateReproduction === true`!
  let fgNum = 0
  let fgDen = 0
  let loudBuggy = 0
  let vfPass = 0
  let vfTotal = 0
  let vfAssertFail = 0
  let vfTimeout = 0
  let vfSelectorCompile = 0
  let e9Eligible = 0

  let totalTokens = 0
  let totalCredits = 0
  let creditsKnownTrials = 0
  let totalListUsd = 0
  let totalMs = 0

  for (const r of active) {
    if (r.adequateReproduction) {
      e9Eligible++
      if (r.refactorRobustness) {
        fgNum += r.refactorRobustness.falseGreenCount ?? 0
        fgDen += r.refactorRobustness.total ?? 0
        loudBuggy += r.refactorRobustness.loudBreakCount ?? 0
      }
      if (r.validFixRobustness) {
        vfTotal += r.validFixRobustness.total ?? 0
        vfPass += r.validFixRobustness.trueGreenCount ?? 0
        vfAssertFail += r.validFixRobustness.falseRedAssertionCount ?? 0
        vfTimeout += r.validFixRobustness.timeoutCount ?? 0
        vfSelectorCompile += r.validFixRobustness.selectorOrCompileBreakCount ?? 0
      }
    }
    if (!r.usage?.usageMissing) {
      totalTokens += r.usage?.totalTokens ?? 0
      if (typeof r.usage?.aiCredits === 'number') {
        totalCredits += r.usage.aiCredits
        creditsKnownTrials++
      }
      if (typeof r.usage?.estimatedUsd === 'number') {
        totalListUsd += r.usage.estimatedUsd
      }
    }
    totalMs += r.durationMs ?? 0
  }

  return {
    n,
    notStarted,
    solved,
    solvedCI: wilsonCI(solved, n),
    oracleCI: wilsonCI(oracle, n),
    redCI: wilsonCI(red, n),
    adequateRedCI: wilsonCI(adequateRed, n),
    monkeyPatch,
    adoptedEp,
    infraFailures,
    ungradable,
    aborted,
    usageMissing,
    e9Eligible,
    falseGreenCI: wilsonCI(fgNum, fgDen),
    loudBuggy,
    validFixPassCI: wilsonCI(vfPass, vfTotal),
    validFixFalseRedCI: wilsonCI(vfAssertFail + vfTimeout, vfTotal),
    vfPass,
    vfTotal,
    vfAssertFail,
    vfTimeout,
    vfSelectorCompile,
    totalTokens,
    totalCredits: creditsKnownTrials > 0 ? totalCredits : null,
    avgCredits: creditsKnownTrials > 0 ? totalCredits / creditsKnownTrials : null,
    creditsPerSolved: solved > 0 && creditsKnownTrials > 0 ? totalCredits / solved : null,
    totalListUsd: creditsKnownTrials > 0 ? totalListUsd : null,
    avgSec: n ? totalMs / n / 1000 : 0,
  }
}

const startedRows = rows.filter((r) => !r.notStarted)
const notStartedCount = rows.length - startedRows.length
const equalSeamRows = startedRows.filter((r) => r.stratum !== 'closed-module')
const closedModRows = startedRows.filter((r) => r.stratum === 'closed-module')

console.log(
  `Loaded ${startedRows.length} started ITT trials (+ ${notStartedCount} not_started) from ${files.length} file(s).\n`,
)

// N-08: Primary Stratified Analysis is strictly over equal-capability Strata B + C!
console.log('=== PRIMARY Stratified Analysis — Equal-Capability Strata B + C ONLY (ITT) ===')
const cmhPrimary = stratifiedCMH(equalSeamRows, (r) => Boolean(r.solved))
const rdPrimary = matchedRiskDifferenceCI(equalSeamRows, (r) => Boolean(r.solved))
console.log(
  `Primary CMH (B+C, strata=${cmhPrimary.strataCount}): z=${cmhPrimary.z}, p=${cmhPrimary.pValue}, exactMcNemarP=${cmhPrimary.exactMcNemarP ?? 'n/a'}, commonOR=${cmhPrimary.commonOddsRatio ?? 'n/a'}`,
)
if (rdPrimary.diff !== null) {
  console.log(
    `Newcombe paired RD (B+C, blocks=${rdPrimary.blocks}): ${(rdPrimary.diff * 100).toFixed(1)}pp [${(rdPrimary.low * 100).toFixed(1)}pp, ${(rdPrimary.high * 100).toFixed(1)}pp]`,
  )
}

const nonInfraPrimary = equalSeamRows.filter((r) => !r.infraFailure && !r.harnessError && !r.ungradable)
if (nonInfraPrimary.length !== equalSeamRows.length) {
  const cmhSens = stratifiedCMH(nonInfraPrimary, (r) => Boolean(r.solved))
  console.log(
    `Sensitivity (B+C excluding ${equalSeamRows.length - nonInfraPrimary.length} infra/ungradable rows): strata=${cmhSens.strataCount}, p=${cmhSens.pValue}, exactMcNemarP=${cmhSens.exactMcNemarP ?? 'n/a'}`,
  )
}

if (closedModRows.length > 0) {
  console.log('\n=== SEPARATE Capability Result — Stratum A (closed-module: tool vs no module seam) ===')
  const cmhA = stratifiedCMH(closedModRows, (r) => Boolean(r.solved))
  const rdA = matchedRiskDifferenceCI(closedModRows, (r) => Boolean(r.solved))
  console.log(
    `Stratum A CMH (strata=${cmhA.strataCount}): z=${cmhA.z}, p=${cmhA.pValue}, exactMcNemarP=${cmhA.exactMcNemarP ?? 'n/a'}, commonOR=${cmhA.commonOddsRatio ?? 'n/a'}`,
  )
  if (rdA.diff !== null) {
    console.log(
      `Stratum A Newcombe RD (blocks=${rdA.blocks}): ${(rdA.diff * 100).toFixed(1)}pp [${(rdA.low * 100).toFixed(1)}pp, ${(rdA.high * 100).toFixed(1)}pp]`,
    )
  }
}

console.log('\n=== Per-Stratum Breakdown (approximate 95% Wilson CIs — E9 over adequate reproductions only) ===')
for (const stratum of [...new Set(startedRows.map((r) => r.stratum ?? 'unknown'))]) {
  const label = stratum === 'closed-module' ? `${stratum} [capability stratum — separate from primary]` : stratum
  console.log(`\nStratum: ${label}`)
  const sRows = startedRows.filter((r) => (r.stratum ?? 'unknown') === stratum)
  for (const arm of ['control', 'treatment']) {
    const sub = sRows.filter((r) => r.arm === arm)
    if (sub.length === 0) continue
    const s = summarizeGroup(sub)
    const credStr =
      s.totalCredits === null
        ? 'n/a'
        : `${s.totalCredits.toFixed(1)} cr (${s.avgCredits?.toFixed(1)}/trial, ${s.creditsPerSolved?.toFixed(1) ?? 'n/a'}/solved; list-price est ${formatUsd(s.totalListUsd)})`
    console.log(
      `  ${arm.padEnd(9)} n=${String(s.n).padEnd(3)} solved=${s.solved}/${s.n} ${formatCI(s.solvedCI)} | infra=${s.infraFailures} ungrad=${s.ungradable} abort=${s.aborted} | adqRED=${formatCI(s.adequateRedCI)} | ep=${s.adoptedEp}/${s.n}`,
    )
    console.log(
      `            E9 (eligible=${s.e9Eligible}): FG=${formatCI(s.falseGreenCI)} | VFPass=${s.vfPass}/${s.vfTotal} (${formatCI(s.validFixPassCI)}) [assert=${s.vfAssertFail}, to=${s.vfTimeout}, sel=${s.vfSelectorCompile}] | ${credStr}`,
    )
  }
  const cmh = stratifiedCMH(sRows, (r) => Boolean(r.solved))
  console.log(
    `  CMH p=${cmh.pValue}, exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'}, commonOR=${cmh.commonOddsRatio ?? 'n/a'} (strata=${cmh.strataCount})`,
  )
}

console.log('\n=== Per-Prompt-Style Breakdown ===')
for (const ps of [...new Set(startedRows.map((r) => r.promptStyle ?? 'unknown'))]) {
  const pRows = startedRows.filter((r) => (r.promptStyle ?? 'unknown') === ps)
  const cmh = stratifiedCMH(pRows, (r) => Boolean(r.solved))
  const cSolved = pRows.filter((r) => r.arm === 'control' && r.solved).length
  const cN = pRows.filter((r) => r.arm === 'control').length
  const tSolved = pRows.filter((r) => r.arm === 'treatment' && r.solved).length
  const tN = pRows.filter((r) => r.arm === 'treatment').length
  console.log(
    `  prompt=${ps.padEnd(10)} control=${cSolved}/${cN} treatment=${tSolved}/${tN} | CMH p=${cmh.pValue} exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'} (strata=${cmh.strataCount})`,
  )
}
