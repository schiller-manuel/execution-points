#!/usr/bin/env node
/**
 * Intention-to-treat statistical analyzer for v2 benchmark `results.jsonl` files
 * (closes ST-02, ST-03, ST-04, ST-05, ST-07, E9-01).
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

// ST-02: Deduplicate by (runId, trialId) and detect provenance mismatches
const seenKeys = new Set()
const seenTrialIds = new Map()
const rows = []
let duplicateSkipped = 0
let crossRunTrialIdCollisions = 0

const harnessHashes = new Set()
const toolHashes = new Set()

for (const { file, row } of rawRows) {
  const runKey = row.runId ?? file
  const dedupKey = `${runKey}::${row.trialId}`
  if (seenKeys.has(dedupKey)) {
    duplicateSkipped++
    continue
  }
  seenKeys.add(dedupKey)

  if (seenTrialIds.has(row.trialId) && seenTrialIds.get(row.trialId) !== runKey) {
    crossRunTrialIdCollisions++
  } else {
    seenTrialIds.set(row.trialId, runKey)
  }

  if (row.harnessSha256) harnessHashes.add(row.harnessSha256)
  if (row.toolSha256) toolHashes.add(row.toolSha256)
  rows.push(row)
}

if (harnessHashes.size > 1 || toolHashes.size > 1) {
  const msg = `Provenance mismatch across pooled files (harnessSha256=${[...harnessHashes].join(',')}, toolSha256=${[...toolHashes].join(',')}).`
  if (!allowMixed) {
    console.error(`ERROR: ${msg} Pass --allow-mixed to pool anyway.`)
    process.exit(2)
  }
  console.warn(`WARNING: ${msg}`)
}

if (duplicateSkipped > 0) {
  console.warn(`WARNING: Skipped ${duplicateSkipped} exact duplicate (runId, trialId) row(s).`)
}
if (crossRunTrialIdCollisions > 0) {
  console.warn(
    `NOTE: ${crossRunTrialIdCollisions} trialId(s) appear across distinct runs (kept separate via runId; verify these are independent replicates).`,
  )
}

function summarizeGroup(items) {
  const n = items.length
  const solved = items.filter((r) => r.solved).length
  const oracle = items.filter((r) => r.oraclePass).length
  const red = items.filter((r) => r.redReproducesBug).length
  const adequateRed = items.filter((r) => r.adequateReproduction ?? r.redReproducesBug).length
  const monkeyPatch = items.filter((r) => !r.noGlobalMonkeyPatch).length
  const adoptedEp = items.filter((r) => r.usesExecutionPoints).length
  const harnessErrors = items.filter((r) => Boolean(r.harnessError || r.ungradable)).length
  const aborted = items.filter((r) => Boolean(r.aborted)).length
  const usageMissing = items.filter((r) => Boolean(r.usage?.usageMissing)).length

  let fgNum = 0
  let fgDen = 0
  let loudBuggy = 0

  let vfPass = 0
  let vfTotal = 0
  let vfAssertFail = 0
  let vfTimeout = 0
  let vfSelectorCompile = 0

  let totalTokens = 0
  let totalUsd = 0
  let usdKnownTrials = 0
  let totalMs = 0

  for (const r of items) {
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
      vfSelectorCompile +=
        r.validFixRobustness.selectorOrCompileBreakCount ?? r.validFixRobustness.loudBreakCount ?? 0
    }
    if (!r.usage?.usageMissing) {
      totalTokens += r.usage?.totalTokens ?? 0
      if (typeof r.usage?.estimatedUsd === 'number') {
        totalUsd += r.usage.estimatedUsd
        usdKnownTrials++
      }
    }
    totalMs += r.durationMs ?? 0
  }

  const vfFalseRed = vfAssertFail + vfTimeout

  return {
    n,
    solved,
    solvedCI: wilsonCI(solved, n),
    oracleCI: wilsonCI(oracle, n),
    redCI: wilsonCI(red, n),
    adequateRedCI: wilsonCI(adequateRed, n),
    monkeyPatch,
    adoptedEp,
    harnessErrors,
    aborted,
    usageMissing,
    falseGreenCI: wilsonCI(fgNum, fgDen),
    loudBuggy,
    validFixPassCI: wilsonCI(vfPass, vfTotal),
    validFixFalseRedCI: wilsonCI(vfFalseRed, vfTotal),
    vfPass,
    vfTotal,
    vfAssertFail,
    vfTimeout,
    vfSelectorCompile,
    totalTokens,
    avgTokens: usdKnownTrials ? Math.round(totalTokens / usdKnownTrials) : null,
    tokensPerSolved: solved > 0 && usdKnownTrials > 0 ? Math.round(totalTokens / solved) : null,
    totalUsd: usdKnownTrials > 0 ? totalUsd : null,
    avgUsd: usdKnownTrials > 0 ? totalUsd / usdKnownTrials : null,
    usdPerSolved: solved > 0 && usdKnownTrials > 0 ? totalUsd / solved : null,
    avgSec: n ? totalMs / n / 1000 : 0,
  }
}

console.log(`Loaded ${rows.length} intention-to-treat trials from ${files.length} file(s).\n`)

console.log('=== Overall Per-Arm Summary (approximate 95% Wilson CIs — descriptive) ===')
for (const arm of ['control', 'treatment']) {
  const subset = rows.filter((r) => r.arm === arm)
  if (subset.length === 0) continue
  const s = summarizeGroup(subset)
  console.log(
    `\n${arm.toUpperCase()} (n=${s.n}, ungradable/err=${s.harnessErrors}, aborted=${s.aborted}, usageMissing=${s.usageMissing}):`,
  )
  console.log(`  Primary solved:        ${s.solved}/${s.n} — ${formatCI(s.solvedCI)}`)
  console.log(`  Oracle pass:           ${formatCI(s.oracleCI)}`)
  console.log(`  Baseline RED:          ${formatCI(s.redCI)} | Adequate RED: ${formatCI(s.adequateRedCI)}`)
  console.log(`  Global monkeypatch:    ${s.monkeyPatch}/${s.n} | EP adoption: ${s.adoptedEp}/${s.n}`)
  console.log(`  E9 Buggy false-green:  ${formatCI(s.falseGreenCI)} (loud breaks: ${s.loudBuggy})`)
  console.log(
    `  E9 Valid-fix pass:     ${s.vfPass}/${s.vfTotal} (${formatCI(s.validFixPassCI)}) | false-red (assert+timeout)=${formatCI(s.validFixFalseRedCI)} [assert=${s.vfAssertFail}, timeout=${s.vfTimeout}, selector/compile=${s.vfSelectorCompile}]`,
  )
  console.log(
    `  Tokens & Cost:         ${s.totalTokens.toLocaleString()} total (${s.avgTokens?.toLocaleString() ?? 'n/a'}/trial, ${s.tokensPerSolved?.toLocaleString() ?? 'n/a'}/solved) | ${formatUsd(s.totalUsd)} total (${formatUsd(s.avgUsd)}/trial, ${formatUsd(s.usdPerSolved)}/solved) | ${s.avgSec.toFixed(1)}s/trial`,
  )
}

console.log('\n=== Primary Stratified Analysis (ITT) ===')
const cmhSolved = stratifiedCMH(rows, (r) => Boolean(r.solved))
const rdSolved = matchedRiskDifferenceCI(rows, (r) => Boolean(r.solved))
console.log(
  `CMH (strata=${cmhSolved.strataCount}): z=${cmhSolved.z}, p=${cmhSolved.pValue}, exactMcNemarP=${cmhSolved.exactMcNemarP ?? 'n/a'}, commonOR=${cmhSolved.commonOddsRatio ?? 'n/a'}`,
)
if (rdSolved.diff !== null) {
  console.log(
    `Newcombe paired RD (blocks=${rdSolved.blocks}): ${(rdSolved.diff * 100).toFixed(1)}pp [${(rdSolved.low * 100).toFixed(1)}pp, ${(rdSolved.high * 100).toFixed(1)}pp]`,
  )
}

const nonErrRows = rows.filter((r) => !r.harnessError && !r.ungradable)
if (nonErrRows.length !== rows.length) {
  const cmhSens = stratifiedCMH(nonErrRows, (r) => Boolean(r.solved))
  console.log(
    `Sensitivity (excluding ${rows.length - nonErrRows.length} harness-error/ungradable rows): strata=${cmhSens.strataCount}, p=${cmhSens.pValue}, exactMcNemarP=${cmhSens.exactMcNemarP ?? 'n/a'}`,
  )
}

console.log('\n=== Per-Stratum Breakdown (Stratum A closed-module reported separately from equal-seam B+C) ===')
for (const stratum of [...new Set(rows.map((r) => r.stratum ?? 'unknown'))]) {
  const label = stratum === 'closed-module' ? `${stratum} [capability: tool vs no seam]` : stratum
  console.log(`\nStratum: ${label}`)
  const sRows = rows.filter((r) => (r.stratum ?? 'unknown') === stratum)
  for (const arm of ['control', 'treatment']) {
    const sub = sRows.filter((r) => r.arm === arm)
    if (sub.length === 0) continue
    const s = summarizeGroup(sub)
    console.log(
      `  ${arm.padEnd(9)} n=${String(s.n).padEnd(3)} solved=${formatCI(s.solvedCI)} | validFixPass=${s.vfPass}/${s.vfTotal} | fg=${formatCI(s.falseGreenCI)} | cost=${formatUsd(s.avgUsd)}/trial`,
    )
  }
  const cmh = stratifiedCMH(sRows, (r) => Boolean(r.solved))
  console.log(
    `  CMH p=${cmh.pValue}, exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'}, commonOR=${cmh.commonOddsRatio ?? 'n/a'} (strata=${cmh.strataCount})`,
  )
}

const promptStyles = [...new Set(rows.map((r) => r.promptStyle ?? 'unknown'))]
console.log('\n=== Per-Prompt-Style Breakdown ===')
for (const ps of promptStyles) {
  const pRows = rows.filter((r) => (r.promptStyle ?? 'unknown') === ps)
  const cmh = stratifiedCMH(pRows, (r) => Boolean(r.solved))
  const cSolved = pRows.filter((r) => r.arm === 'control' && r.solved).length
  const cN = pRows.filter((r) => r.arm === 'control').length
  const tSolved = pRows.filter((r) => r.arm === 'treatment' && r.solved).length
  const tN = pRows.filter((r) => r.arm === 'treatment').length
  console.log(
    `  prompt=${ps.padEnd(10)} control=${cSolved}/${cN} treatment=${tSolved}/${tN} | CMH p=${cmh.pValue} exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'} (strata=${cmh.strataCount})`,
  )
}
