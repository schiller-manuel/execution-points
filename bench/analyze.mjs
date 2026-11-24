#!/usr/bin/env node
/**
 * Intention-to-treat statistical analyzer for benchmark `results.jsonl` files
 * (harness v2.5; reads rows written by v2.2 and later).
 *
 * What it guarantees (ST-02..ST-07, E9-01, N-05..N-09, N-13, N-21, N-26..N-28, V-07):
 * - Every started row stays in the intention-to-treat denominator. A row that
 *   cannot be used by a paired statistic is named in a WARNING, never dropped
 *   silently. Blocks are paired on the REQUESTED model (`blockKey` in stats.mjs).
 * - Rows are deduplicated by (runId, trialId). Byte-identical duplicates are
 *   skipped. Duplicates that differ are a conflict: refused unless
 *   `--allow-mixed=duplicates`, in which case the LATER row wins and is named.
 * - Provenance must match field by field. Each exception is allowed by name:
 *   `--allow-mixed=gitCommit,graderChecksum`. There is no allow-everything
 *   switch. Besides the provenance fields the names are `dirty` (rows from a
 *   dirty tree), `missing` (graded rows that lack a provenance field),
 *   `duplicates`, and `regrade` (rows re-graded by different checkouts, or
 *   re-graded rows mixed with original ones).
 * - A harness-exception row is kept (solved = false) even when it lacks
 *   provenance fields, and the per-protocol sensitivity analysis runs without it.
 * - Primary analysis runs over equal-capability Strata B + C; Stratum A is
 *   reported separately.
 * - E9 robustness is computed over `adequateReproduction === true` rows, with
 *   one set of counts for both arms (`bench/classify.mjs`).
 *
 * Usage:
 *   node bench/analyze.mjs [--allow-mixed=<name>[,<name>...]] <results.jsonl> [more.jsonl...]
 */
import { readFileSync } from 'node:fs'
import { countRefactorResults, countValidFixResults } from './classify.mjs'
import { formatUsd } from './pricing.mjs'
import {
  blockKey,
  blocksForPower,
  exactMcNemarPower,
  formatCI,
  matchedRiskDifferenceCI,
  pairedCreditDiffCI,
  stratifiedCMH,
  unmatchedRows,
  wilsonCI,
} from './stats.mjs'

const PROVENANCE_FIELDS = [
  'gitCommit',
  'copilotVersion',
  'graderChecksum',
  'harnessSha256',
  'calibrationSha256',
  'lockfileSha256',
  'toolSha256',
  'tasksSha256',
  'vitestVersion',
  'typescriptVersion',
]
const PSEUDO_FIELDS = ['dirty', 'missing', 'duplicates', 'regrade']
const ALLOWABLE = [...PROVENANCE_FIELDS, ...PSEUDO_FIELDS]
const USAGE =
  'Usage: node bench/analyze.mjs [--allow-mixed=<name>[,<name>...]] <results.jsonl> [more.jsonl...]\n' +
  `       names: ${ALLOWABLE.join(', ')}`

const args = process.argv.slice(2)
const allowed = new Set()
const files = []
for (const a of args) {
  if (a === '--allow-mixed') {
    console.error(
      'ERROR: --allow-mixed needs the names of what may be mixed, for example --allow-mixed=gitCommit,graderChecksum.\n' +
        'Run without it to see which names this input needs.\n' +
        USAGE,
    )
    process.exit(1)
  } else if (a.startsWith('--allow-mixed=')) {
    for (const name of a.slice('--allow-mixed='.length).split(',').filter(Boolean)) {
      if (!ALLOWABLE.includes(name)) {
        console.error(`ERROR: unknown --allow-mixed name "${name}".\n${USAGE}`)
        process.exit(1)
      }
      allowed.add(name)
    }
  } else if (a.startsWith('--')) {
    console.error(`ERROR: unknown option ${a}.\n${USAGE}`)
    process.exit(1)
  } else {
    files.push(a)
  }
}

if (files.length === 0) {
  console.error(USAGE)
  process.exit(1)
}

const rawRows = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    rawRows.push({ file, line, row: JSON.parse(line) })
  }
}

// ── Duplicates: identical rows are skipped, differing rows are a conflict ────
const byKey = new Map()
let exactDuplicates = 0
const conflicts = []
for (const entry of rawRows) {
  const runKey = entry.row.runId ?? entry.file
  const dedupKey = `${runKey}::${entry.row.trialId}`
  const prev = byKey.get(dedupKey)
  if (!prev) {
    byKey.set(dedupKey, entry)
  } else if (prev.line === entry.line) {
    exactDuplicates++
  } else {
    conflicts.push({ dedupKey, trialId: entry.row.trialId, kept: entry.file, replaced: prev.file })
    byKey.set(dedupKey, entry) // only reached output when `duplicates` is allowed: the later row wins
  }
}
const rows = [...byKey.values()].map((e) => e.row)

// ── Provenance, field by field ───────────────────────────────────────────────
const provenanceSets = Object.fromEntries(PROVENANCE_FIELDS.map((k) => [k, new Set()]))
const gradingIdentities = new Set()
let dirtyRows = 0
const missingProvRows = []
const harnessErrorMissing = []
for (const row of rows) {
  if (row.gitDirty === true) dirtyRows++
  if (row.notStarted || row.aborted) continue
  const missing = []
  for (const f of PROVENANCE_FIELDS) {
    if (row[f] === undefined || row[f] === null) missing.push(f)
    else provenanceSets[f].add(String(row[f]))
  }
  if (missing.length > 0) {
    if (row.harnessError) harnessErrorMissing.push({ trialId: row.trialId, missing })
    else missingProvRows.push({ trialId: row.trialId, missing })
  }
  const rg = row.regradedWith
  gradingIdentities.add(
    rg
      ? `regraded by git=${rg.gitCommit}${rg.gitDirty ? '-dirty' : ''} harness=${rg.harnessSha256} calibration=${rg.calibrationSha256} grader=${String(rg.graderChecksum).slice(0, 16)} repeats=${rg.gradeRepeats}`
      : 'original grading',
  )
}

const problems = []
for (const f of PROVENANCE_FIELDS) {
  if (provenanceSets[f].size > 1) {
    problems.push({ name: f, detail: `${f} has ${provenanceSets[f].size} values: ${[...provenanceSets[f]].map((v) => v.slice(0, 16)).join(', ')}` })
  }
}
if (dirtyRows > 0) problems.push({ name: 'dirty', detail: `${dirtyRows} row(s) come from a dirty working tree` })
if (missingProvRows.length > 0) {
  problems.push({
    name: 'missing',
    detail: `${missingProvRows.length} graded row(s) lack provenance fields (first: ${missingProvRows[0].trialId} lacks ${missingProvRows[0].missing.join(',')})`,
  })
}
if (conflicts.length > 0) {
  problems.push({
    name: 'duplicates',
    detail: `${conflicts.length} (runId, trialId) key(s) appear with DIFFERENT contents (first: ${conflicts[0].trialId}); allowing it keeps the later row`,
  })
}
if (gradingIdentities.size > 1) {
  problems.push({ name: 'regrade', detail: `rows were graded by ${gradingIdentities.size} different gradings: ${[...gradingIdentities].join(' | ')}` })
}

const refused = problems.filter((p) => !allowed.has(p.name))
if (refused.length > 0) {
  console.error('ERROR: refusing to pool these rows:')
  for (const p of refused) console.error(`  - ${p.name}: ${p.detail}`)
  console.error(`To pool anyway, name each one: --allow-mixed=${problems.map((p) => p.name).join(',')}`)
  process.exit(2)
}
for (const p of problems) console.warn(`WARNING: mixed input allowed by name (${p.name}): ${p.detail}`)
for (const name of allowed) {
  if (!problems.some((p) => p.name === name)) console.warn(`NOTE: --allow-mixed=${name} was not needed for this input.`)
}
for (const c of conflicts) {
  console.warn(`WARNING: conflicting duplicate ${c.trialId}: kept the row from ${c.kept}, dropped the one from ${c.replaced}.`)
}
if (exactDuplicates > 0) {
  console.warn(`WARNING: skipped ${exactDuplicates} byte-identical duplicate (runId, trialId) row(s).`)
}
for (const h of harnessErrorMissing) {
  console.warn(
    `WARNING: harness-exception row ${h.trialId} lacks provenance fields (${h.missing.join(',')}); kept in the ITT denominator as unsolved and left out of the sensitivity analysis.`,
  )
}
if ([...gradingIdentities].some((g) => g !== 'original grading')) {
  console.warn(`NOTE: these rows are a RE-GRADING of stored trials (${[...gradingIdentities].join(' | ')}). They are a re-analysis, not the record of the run.`)
}

const startedRows = rows.filter((r) => !r.notStarted)
const notStartedCount = rows.length - startedRows.length
const equalSeamRows = startedRows.filter((r) => r.stratum !== 'closed-module')
const closedModRows = startedRows.filter((r) => r.stratum === 'closed-module')

// ── Pairing: every row a paired statistic cannot use is named ───────────────
const unmatched = unmatchedRows(startedRows)
for (const u of unmatched) {
  console.warn(`WARNING: unmatched row ${u.row.trialId} (${u.reason}); it counts in per-arm totals and in no paired statistic.`)
}
for (const r of startedRows) {
  if (r.actualModel && r.model && r.actualModel !== r.model) {
    console.warn(`WARNING: ${r.trialId} requested model ${r.model} but was served ${r.actualModel}; it is paired on the requested model.`)
  }
}

console.log(
  `Loaded ${startedRows.length} started ITT trials (+ ${notStartedCount} not_started) from ${files.length} file(s).\n`,
)

const sign = (x) => `${x >= 0 ? '+' : ''}${x}`
const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : 'n/a')
const frac = (num, den) => `${num}/${den}`

function printNewcombe(prefix, rd) {
  if (rd.diff === null) return
  const m10 = `${(rd.diff * 100).toFixed(1)}pp [${(rd.low * 100).toFixed(1)}pp, ${(rd.high * 100).toFixed(1)}pp]`
  const m8 = `[${(rd.uncorrectedPhi.low * 100).toFixed(1)}pp, ${(rd.uncorrectedPhi.high * 100).toFixed(1)}pp]`
  console.log(`${prefix}: ${m10} (Method 10; with uncorrected phi, as printed up to v2.3: ${m8})`)
}

function printCredits(prefix, cred, tail = 'blocks') {
  if (cred.blocks === 0) return
  const ciStr = cred.low !== null ? ` [${sign(cred.low)}, ${sign(cred.high)}]` : ''
  console.log(`${prefix}: ${sign(cred.meanDiff)} cr${ciStr} (Treatment cheaper in ${cred.treatCheaper}/${cred.blocks}${tail ? ` ${tail}` : ''})`)
}

/** Matched blocks of `rowsIn`, with both rows, keyed on the requested model. */
function matchedBlocks(rowsIn) {
  const blocks = new Map()
  for (const r of rowsIn) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    const b = blocks.get(blockKey(r)) ?? {}
    b[r.arm] = b[r.arm] === undefined ? r : null // null: more than one row of this arm
    blocks.set(blockKey(r), b)
  }
  return [...blocks.values()].filter((b) => b.control && b.treatment)
}

/**
 * `solved` by whether the block's TREATMENT trial used the library, next to
 * the intention-to-treat result. Adoption happens after randomization, so the
 * split is descriptive and never a causal arm comparison (PROTOCOL section 5).
 */
function printAdoptionSplit(label, rowsIn) {
  const blocks = matchedBlocks(rowsIn)
  if (blocks.length === 0) return
  const line = (name, bs) => {
    const c = bs.filter((b) => b.control.solved).length
    const t = bs.filter((b) => b.treatment.solved).length
    const tOnly = bs.filter((b) => b.treatment.solved && !b.control.solved).length
    const cOnly = bs.filter((b) => !b.treatment.solved && b.control.solved).length
    console.log(
      `  ${name.padEnd(46)} blocks=${String(bs.length).padEnd(3)} C=${frac(c, bs.length).padEnd(6)} T=${frac(t, bs.length).padEnd(6)} | disc(T/C)=${tOnly}/${cOnly}`,
    )
  }
  console.log(`Solved by adoption (${label}; split is descriptive, adoption is not randomized):`)
  line('intention-to-treat (all matched blocks)', blocks)
  line('treatment trial used the library', blocks.filter((b) => b.treatment.usesExecutionPoints))
  line('treatment trial used plain Vitest', blocks.filter((b) => !b.treatment.usesExecutionPoints))
}

/** The reproduction verdict of a row from any harness version. */
function reproductionOf(r) {
  if (r.reproduction) return r.reproduction
  return r.adequateReproduction ? 'adequate' : 'inadequate'
}

// N-08: Primary Stratified Analysis is strictly over equal-capability Strata B + C!
console.log('=== PRIMARY Stratified Analysis — Equal-Capability Strata B + C ONLY (ITT) ===')
const cmhPrimary = stratifiedCMH(equalSeamRows, (r) => Boolean(r.solved))
const rdPrimary = matchedRiskDifferenceCI(equalSeamRows, (r) => Boolean(r.solved))
const credPrimary = pairedCreditDiffCI(equalSeamRows)
console.log(
  `Primary CMH (B+C, strata=${cmhPrimary.strataCount}): z=${cmhPrimary.z}, p=${cmhPrimary.pValue}, exactMcNemarP=${cmhPrimary.exactMcNemarP ?? 'n/a'}, commonOR=${cmhPrimary.commonOddsRatio ?? 'n/a'}`,
)
printNewcombe(`Newcombe paired RD (B+C, blocks=${rdPrimary.blocks})`, rdPrimary)
printCredits(`Paired ITT credits T-C (B+C, blocks=${credPrimary.blocks})`, credPrimary)

const nonInfraPrimary = equalSeamRows.filter((r) => !r.infraFailure && !r.harnessError && !r.ungradable)
if (nonInfraPrimary.length !== equalSeamRows.length) {
  const cmhSens = stratifiedCMH(nonInfraPrimary, (r) => Boolean(r.solved))
  console.log(
    `Sensitivity (B+C excluding ${equalSeamRows.length - nonInfraPrimary.length} infra/ungradable rows): strata=${cmhSens.strataCount}, p=${cmhSens.pValue}, exactMcNemarP=${cmhSens.exactMcNemarP ?? 'n/a'}`,
  )
}
const unstablePrimary = equalSeamRows.filter((r) => reproductionOf(r) === 'unstable')
if (unstablePrimary.length > 0) {
  // Upper bound only: what `solved` would be if every unstable reproduction had counted.
  const solvedIfStable = (r) =>
    Boolean(r.solved) ||
    (reproductionOf(r) === 'unstable' &&
      !r.infraFailure &&
      Boolean(r.oraclePass) &&
      Boolean(r.visibleTestsPass) &&
      Boolean(r.typecheckPass) &&
      Boolean(r.contractTypecheckPass) &&
      Boolean(r.cleanProduction) &&
      r.noGlobalMonkeyPatch !== false &&
      r.noRealSleeps !== false)
  const cmhU = stratifiedCMH(equalSeamRows, solvedIfStable)
  const disc = cmhU.discordantPairs ? `${cmhU.discordantPairs.treatmentOnly}/${cmhU.discordantPairs.controlOnly}` : 'n/a'
  console.log(
    `Sensitivity (B+C if the ${unstablePrimary.length} unstable reproduction(s) had counted as adequate): C=${equalSeamRows.filter((r) => r.arm === 'control' && solvedIfStable(r)).length} T=${equalSeamRows.filter((r) => r.arm === 'treatment' && solvedIfStable(r)).length} disc(T/C)=${disc} exactMcNemarP=${cmhU.exactMcNemarP ?? 'n/a'}`,
  )
}
printAdoptionSplit('Strata B + C', equalSeamRows)

if (closedModRows.length > 0) {
  console.log('\n=== SEPARATE Capability Result — Stratum A (closed-module: tool vs no module seam) ===')
  const cmhA = stratifiedCMH(closedModRows, (r) => Boolean(r.solved))
  const rdA = matchedRiskDifferenceCI(closedModRows, (r) => Boolean(r.solved))
  const credA = pairedCreditDiffCI(closedModRows)
  console.log(
    `Stratum A CMH (strata=${cmhA.strataCount}): z=${cmhA.z}, p=${cmhA.pValue}, exactMcNemarP=${cmhA.exactMcNemarP ?? 'n/a'}, commonOR=${cmhA.commonOddsRatio ?? 'n/a'}`,
  )
  printNewcombe(`Stratum A Newcombe RD (blocks=${rdA.blocks}, descriptive — use exact McNemar for small N)`, rdA)
  printCredits(`Stratum A paired ITT credits T-C (blocks=${credA.blocks})`, credA)
  printAdoptionSplit('Stratum A', closedModRows)
}

// G-7 / D-14: Always display gate-sensitivity table across all started rows
console.log('\n=== Gate-Sensitivity Summary (All Started Matched Blocks) ===')
const credAll = pairedCreditDiffCI(startedRows)
printCredits(`Paired ITT credits T-C (all ${credAll.blocks} blocks)`, credAll, '')
const baseGatesOk = (r) =>
  !r.infraFailure &&
  Boolean(r.oraclePass) &&
  Boolean(r.visibleTestsPass) &&
  Boolean(r.agentTestsPass) &&
  Boolean(r.typecheckPass) &&
  Boolean(r.contractTypecheckPass) &&
  Boolean(r.cleanProduction) &&
  r.noGlobalMonkeyPatch !== false &&
  r.noRealSleeps !== false &&
  Boolean(r.redReproducesBug) &&
  Boolean(r.singleBugMutants?.allDetected)

const gateDefs = [
  ['official (stored solved)', (r) => Boolean(r.solved)],
  ['noValidFixGate (RED+mutants+own)', (r) => baseGatesOk(r)],
  ['anyValidFix (D-14 symmetric)', (r) => baseGatesOk(r) && (r.validFixRobustness?.trueGreenCount ?? 0) >= 1],
  [
    'allValidFixes (strict E9)',
    (r) =>
      baseGatesOk(r) &&
      (r.validFixRobustness?.total ?? 0) > 0 &&
      r.validFixRobustness.trueGreenCount === r.validFixRobustness.total,
  ],
  ['oracleOnly (fix quality only)', (r) => Boolean(r.oraclePass)],
]
for (const [label, fn] of gateDefs) {
  const c = startedRows.filter((r) => r.arm === 'control' && fn(r)).length
  const cN = startedRows.filter((r) => r.arm === 'control').length
  const t = startedRows.filter((r) => r.arm === 'treatment' && fn(r)).length
  const tN = startedRows.filter((r) => r.arm === 'treatment').length
  const cmh = stratifiedCMH(startedRows, fn)
  const disc = cmh.discordantPairs
    ? `${cmh.discordantPairs.treatmentOnly}/${cmh.discordantPairs.controlOnly}`
    : 'n/a'
  console.log(
    `  ${label.padEnd(34)} C=${c}/${cN} T=${t}/${tN} | disc(T/C)=${disc.padEnd(5)} exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'}`,
  )
}
printAdoptionSplit('all strata, official gate', startedRows)

/** E9 counts over the adequate rows of a group; identical rules for both arms. */
function robustness(items) {
  const eligible = items.filter((r) => r.adequateReproduction)
  const refactor = countRefactorResults(eligible.flatMap((r) => r.refactorRobustness?.results ?? []))
  const valid = countValidFixResults(eligible.flatMap((r) => r.validFixRobustness?.results ?? []))
  return { eligible: eligible.length, refactor, valid }
}

function summarizeGroup(items) {
  const active = items.filter((r) => !r.notStarted)
  const n = active.length
  const count = (fn) => active.filter(fn).length
  const solved = count((r) => r.solved)
  const { eligible, refactor, valid } = robustness(active)

  let totalTokens = 0
  let totalCredits = 0
  let creditsKnownTrials = 0
  let totalListUsd = 0
  let usdKnownTrials = 0
  let totalMs = 0
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  for (const r of active) {
    if (!r.usage?.usageMissing) {
      totalTokens += r.usage?.totalTokens ?? 0
      for (const k of Object.keys(tokens)) tokens[k] += r.usage?.[k] ?? 0
      if (typeof r.usage?.aiCredits === 'number') {
        totalCredits += r.usage.aiCredits
        creditsKnownTrials++
      }
      if (typeof r.usage?.estimatedUsd === 'number') {
        totalListUsd += r.usage.estimatedUsd
        usdKnownTrials++
      }
    }
    totalMs += r.durationMs ?? 0
  }
  const techniques = {}
  for (const r of active) techniques[r.technique ?? 'unknown'] = (techniques[r.technique ?? 'unknown'] ?? 0) + 1
  // D-18: trials per operation of the library. A trial that uses two operations counts under
  // both. Rows written before v2.5 only knew `withReplacement`, so that is what they used.
  const libraryOperations = {}
  for (const r of active) {
    if (!r.usesExecutionPoints) continue
    for (const op of r.libraryOperations ?? ['withReplacement']) libraryOperations[op] = (libraryOperations[op] ?? 0) + 1
  }

  return {
    n,
    notStarted: items.length - n,
    solved,
    solvedCI: wilsonCI(solved, n),
    oracle: count((r) => r.oraclePass),
    visible: count((r) => r.visibleTestsPass),
    agentTests: count((r) => r.agentTestsPass),
    red: count((r) => r.redReproducesBug),
    refFix: count((r) => r.refFixPass),
    anyValidFix: count((r) => r.passesAtLeastOneValidFix ?? (r.validFixRobustness?.trueGreenCount ?? 0) >= 1),
    allMutants: count((r) => r.singleBugMutants?.allDetected),
    adequateRed: count((r) => r.adequateReproduction),
    adequateRedCI: wilsonCI(count((r) => r.adequateReproduction), n),
    unstable: count((r) => reproductionOf(r) === 'unstable'),
    typecheck: count((r) => r.typecheckPass),
    contractTypecheck: count((r) => r.contractTypecheckPass),
    cleanProduction: count((r) => r.cleanProduction),
    // N-09: Only count explicit `=== false` (null on aborted/not_started is NOT a violation!)
    monkeyPatch: count((r) => r.noGlobalMonkeyPatch === false),
    realSleeps: count((r) => r.noRealSleeps === false),
    tamperedConfigs: count((r) => r.tamperedConfigs === true),
    adoptedEp: count((r) => r.usesExecutionPoints),
    infraFailures: count((r) => Boolean(r.infraFailure)),
    ungradable: count((r) => Boolean(r.harnessError || r.ungradable)),
    aborted: count((r) => Boolean(r.aborted)),
    usageMissing: count((r) => Boolean(r.usage?.usageMissing)),
    firstRedBeforeEdit: count((r) => r.firstRedBeforeFirstSourceEdit === true),
    techniques,
    libraryOperations,
    e9Eligible: eligible,
    refactor,
    valid,
    falseGreenCI: wilsonCI(refactor.falseGreen, refactor.total),
    validFixPassCI: wilsonCI(valid.green, valid.total),
    totalTokens,
    tokens,
    totalCredits: creditsKnownTrials > 0 ? totalCredits : null,
    avgCredits: creditsKnownTrials > 0 ? totalCredits / creditsKnownTrials : null,
    creditsPerSolved: solved > 0 && creditsKnownTrials > 0 ? totalCredits / solved : null,
    totalListUsd: usdKnownTrials > 0 ? totalListUsd : null,
    usdPerSolved: solved > 0 && usdKnownTrials > 0 ? totalListUsd / solved : null,
    tokensPerSolved: solved > 0 && creditsKnownTrials > 0 ? Math.round(totalTokens / solved) : null,
    avgSec: n ? totalMs / n / 1000 : 0,
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
      `  ${arm.padEnd(9)} n=${String(s.n).padEnd(3)} solved=${s.solved}/${s.n} ${formatCI(s.solvedCI)} | infra=${s.infraFailures} ungrad=${s.ungradable} abort=${s.aborted} unstable=${s.unstable} | adqRED=${formatCI(s.adequateRedCI)} | ep=${s.adoptedEp}/${s.n}`,
    )
    console.log(
      `            E9 (eligible=${s.e9Eligible}): FG=${formatCI(s.falseGreenCI)} | VFPass=${s.valid.green}/${s.valid.total} (${formatCI(s.validFixPassCI)}) [assert=${s.valid.assertion}, to=${s.valid.timeout}, sel=${s.valid.selectorOrCompileBreak}, err=${s.valid.error}, unstable=${s.valid.unstable}] | ${credStr}`,
    )
  }
  const cmh = stratifiedCMH(sRows, (r) => Boolean(r.solved))
  console.log(
    `  CMH p=${cmh.pValue}, exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'}, commonOR=${cmh.commonOddsRatio ?? 'n/a'} (strata=${cmh.strataCount})`,
  )
}

// ── E9, same counts for both arms, split by adoption ─────────────────────────
function printRobustnessTable(title, rowsIn) {
  const groups = [
    ['control', rowsIn.filter((r) => r.arm === 'control')],
    ['treatment, all', rowsIn.filter((r) => r.arm === 'treatment')],
    ['treatment, used the library', rowsIn.filter((r) => r.arm === 'treatment' && r.usesExecutionPoints)],
    ['treatment, plain Vitest', rowsIn.filter((r) => r.arm === 'treatment' && !r.usesExecutionPoints)],
  ]
  console.log(`\n${title}`)
  console.log(
    '  Buggy refactors: "still red" failed on an assertion; "stopped testing" = loud break + timeout + other error + unstable; "FALSE GREEN" passed.',
  )
  console.log('  Valid fixes: "not green" is every reason a valid fix was rejected, counted the same way in both arms.')
  for (const [name, sub] of groups) {
    const { eligible, refactor: rf, valid: vf } = robustness(sub)
    console.log(`  ${name.padEnd(28)} adequate rows=${eligible}/${sub.length}`)
    console.log(
      `      buggy refactors: still red ${frac(rf.stillRed, rf.total)} (${pct(rf.stillRed, rf.total)}) | stopped testing ${rf.stoppedTesting} (${pct(rf.stoppedTesting, rf.total)}) = loud break ${rf.loudBreak} + timeout ${rf.timeout} + other error ${rf.error} + unstable ${rf.unstable + rf.other} | FALSE GREEN ${rf.falseGreen} (${formatCI(wilsonCI(rf.falseGreen, rf.total))})`,
    )
    console.log(
      `      valid fixes:     green ${frac(vf.green, vf.total)} (${pct(vf.green, vf.total)}) | not green ${vf.notGreen} (${formatCI(wilsonCI(vf.notGreen, vf.total))}) = assertion ${vf.assertion} + timeout ${vf.timeout} + loud break ${vf.selectorOrCompileBreak} + other error ${vf.error} + unstable ${vf.unstable + vf.other}`,
    )
  }
}
printRobustnessTable(
  '=== Regression-Test Robustness (E9) by Arm and Adoption — All Strata, adequate reproductions only (D-08) ===',
  startedRows,
)
printRobustnessTable('=== Regression-Test Robustness (E9) by Arm and Adoption — Strata B + C ===', equalSeamRows)
if (closedModRows.length > 0) {
  printRobustnessTable('=== Regression-Test Robustness (E9) by Arm and Adoption — Stratum A ===', closedModRows)
}

// ── PROTOCOL section 3: components, adoption & technique, telemetry ──────────
console.log('\n=== Secondary Endpoints by Arm (PROTOCOL section 3; all started rows) ===')
for (const arm of ['control', 'treatment']) {
  const sub = startedRows.filter((r) => r.arm === arm)
  if (sub.length === 0) continue
  const s = summarizeGroup(sub)
  const f = (x) => frac(x, s.n)
  console.log(`  ${arm}  (n=${s.n})`)
  console.log(
    `      components:  solved=${f(s.solved)} oraclePass=${f(s.oracle)} visibleTestsPass=${f(s.visible)} agentTestsPass=${f(s.agentTests)} redReproducesBug=${f(s.red)} allMutantsDetected=${f(s.allMutants)} anyValidFix=${f(s.anyValidFix)} refFixPass=${f(s.refFix)} adequateReproduction=${f(s.adequateRed)}`,
  )
  console.log(
    `                   typecheckPass=${f(s.typecheck)} contractTypecheckPass=${f(s.contractTypecheck)} cleanProduction=${f(s.cleanProduction)} globalMonkeyPatch=${f(s.monkeyPatch)} realSleeps=${f(s.realSleeps)} tamperedConfigs=${f(s.tamperedConfigs)}`,
  )
  console.log(
    `                   unstableReproduction=${f(s.unstable)} ungradable=${f(s.ungradable)} infraFailure=${f(s.infraFailures)} aborted=${f(s.aborted)} usageMissing=${f(s.usageMissing)}`,
  )
  const tech = Object.entries(s.techniques)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  console.log(`      technique:   ${tech} | usesExecutionPoints=${f(s.adoptedEp)}`)
  if (s.adoptedEp > 0) {
    const ops = Object.entries(s.libraryOperations)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`      library:     trials per operation (a trial can use several): ${ops}`)
  }
  console.log(`      process:     firstRedBeforeFirstSourceEdit=${f(s.firstRedBeforeEdit)} | wall-clock ${s.avgSec.toFixed(1)} s/trial`)
  const perSolved =
    s.solved > 0
      ? `${s.creditsPerSolved?.toFixed(2) ?? 'n/a'} cr/solved, ${s.usdPerSolved !== null ? formatUsd(s.usdPerSolved) : 'n/a'}/solved (list-price estimate), ${s.tokensPerSolved ?? 'n/a'} tokens/solved`
      : 'no solved trial'
  console.log(
    `      economics:   aiCredits=${s.totalCredits?.toFixed(1) ?? 'n/a'} (${s.avgCredits?.toFixed(2) ?? 'n/a'}/trial) estimatedUsd=${s.totalListUsd !== null ? formatUsd(s.totalListUsd) : 'n/a'} | ${perSolved}`,
  )
  console.log(
    `      tokens:      input=${s.tokens.inputTokens} output=${s.tokens.outputTokens} cacheRead=${s.tokens.cacheReadTokens} cacheWrite=${s.tokens.cacheWriteTokens} reasoning=${s.tokens.reasoningTokens}`,
  )
}
console.log('  Per-solved costs depend on the gate (see the gate-sensitivity table); the paired per-trial credit difference is the primary cost metric.')

// ── Grading stability ───────────────────────────────────────────────────────
const repeatsSeen = [...new Set(startedRows.map((r) => r.gradeRepeats ?? 1))].sort((a, b) => a - b)
const withUnstableVariant = startedRows.filter((r) => (r.unstableVariants ?? []).length > 0)
console.log('\n=== Grading Stability (repeated runs of every variant must agree) ===')
console.log(`  Runs per variant in these rows: ${repeatsSeen.join(', ')}${repeatsSeen.includes(1) ? ' (1 = graded once; instability could not be observed)' : ''}`)
for (const arm of ['control', 'treatment']) {
  const sub = startedRows.filter((r) => r.arm === arm)
  if (sub.length === 0) continue
  const unstable = sub.filter((r) => reproductionOf(r) === 'unstable')
  console.log(
    `  ${arm.padEnd(9)} unstable reproduction=${unstable.length}/${sub.length} (never adequate) | rows with any unstable variant=${sub.filter((r) => (r.unstableVariants ?? []).length > 0).length}/${sub.length}`,
  )
}
for (const r of withUnstableVariant) {
  console.log(`    ${r.trialId}: reproduction=${reproductionOf(r)} unstable variants=[${r.unstableVariants.join(', ')}]`)
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

// ── Power at the observed discordance ───────────────────────────────────────
console.log('\n=== Power of the Primary Test at the Observed Discordance (Strata B + C) ===')
{
  const blocks = matchedBlocks(equalSeamRows)
  const tOnly = blocks.filter((b) => b.treatment.solved && !b.control.solved).length
  const cOnly = blocks.filter((b) => !b.treatment.solved && b.control.solved).length
  const disc = tOnly + cOnly
  if (blocks.length === 0 || disc === 0) {
    console.log(`  ${blocks.length} matched blocks, ${disc} discordant: nothing to estimate from.`)
  } else {
    const pDisc = disc / blocks.length
    const pT = tOnly / disc
    const power = exactMcNemarPower(blocks.length, pDisc, pT)
    const need = blocksForPower(pDisc, pT)
    console.log(
      `  Observed: ${blocks.length} matched blocks, ${disc} discordant (${pct(disc, blocks.length)}), split T-only/C-only = ${tOnly}/${cOnly}.`,
    )
    console.log(
      `  ASSUMING the true discordance and split equal the observed ones: power of the exact two-sided McNemar test at alpha=0.05 with ${blocks.length} blocks = ${power.toFixed(3)}; 80% power needs ${need === null ? 'more than 20,000 blocks (or the split is exactly even)' : `${need} blocks`}.`,
    )
    console.log('  Both inputs are estimates from a handful of discordant pairs, so treat the figure as an order of magnitude.')
  }
}
