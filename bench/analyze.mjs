#!/usr/bin/env node
/**
 * Intention-to-treat statistical analyzer for v2 benchmark `results.jsonl` files.
 *
 * Usage:
 *   node bench/analyze.mjs bench/results/<run>/results.jsonl [more.jsonl...]
 */
import { readFileSync } from 'node:fs'
import { formatUsd } from './pricing.mjs'
import { formatCI, matchedRiskDifferenceCI, stratifiedCMH, wilsonCI } from './stats.mjs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('Usage: node bench/analyze.mjs <results.jsonl> [more.jsonl...]')
  process.exit(1)
}

const rows = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    rows.push(JSON.parse(line))
  }
}

function summarizeGroup(items) {
  const n = items.length
  const solved = items.filter((r) => r.solved).length
  const oracle = items.filter((r) => r.oraclePass).length
  const red = items.filter((r) => r.redReproducesBug).length
  const adequateRed = items.filter((r) => r.adequateReproduction ?? r.redReproducesBug).length
  const monkeyPatch = items.filter((r) => !r.noGlobalMonkeyPatch).length
  const adoptedEp = items.filter((r) => r.usesExecutionPoints).length

  let fgNum = 0
  let fgDen = 0
  let frNum = 0
  let frDen = 0
  let loudValid = 0
  let loudBuggy = 0
  let totalTokens = 0
  let totalUsd = 0
  let totalMs = 0

  for (const r of items) {
    if (r.refactorRobustness) {
      fgNum += r.refactorRobustness.falseGreenCount ?? 0
      fgDen += r.refactorRobustness.total ?? 0
      loudBuggy += r.refactorRobustness.loudBreakCount ?? 0
    }
    if (r.validFixRobustness) {
      frNum += r.validFixRobustness.falseRedAssertionCount ?? 0
      frDen += r.validFixRobustness.total ?? 0
      loudValid += r.validFixRobustness.loudBreakCount ?? 0
    }
    totalTokens += r.usage?.totalTokens ?? 0
    if (typeof r.usage?.estimatedUsd === 'number') totalUsd += r.usage.estimatedUsd
    totalMs += r.durationMs ?? 0
  }

  return {
    n,
    solved,
    solvedCI: wilsonCI(solved, n),
    oracleCI: wilsonCI(oracle, n),
    redCI: wilsonCI(red, n),
    adequateRedCI: wilsonCI(adequateRed, n),
    monkeyPatch,
    adoptedEp,
    falseGreenCI: wilsonCI(fgNum, fgDen),
    falseRedCI: wilsonCI(frNum, frDen),
    loudBuggy,
    loudValid,
    totalTokens,
    avgTokens: n ? Math.round(totalTokens / n) : 0,
    tokensPerSolved: solved > 0 ? Math.round(totalTokens / solved) : null,
    totalUsd,
    avgUsd: n ? totalUsd / n : 0,
    usdPerSolved: solved > 0 ? totalUsd / solved : null,
    avgSec: n ? totalMs / n / 1000 : 0,
    secPerSolved: solved > 0 ? totalMs / solved / 1000 : null,
  }
}

console.log(`Loaded ${rows.length} intention-to-treat trials from ${files.length} file(s).\n`)

console.log('=== Overall Per-Arm Summary (95% Wilson CIs) ===')
for (const arm of ['control', 'treatment']) {
  const subset = rows.filter((r) => r.arm === arm)
  if (subset.length === 0) continue
  const s = summarizeGroup(subset)
  console.log(`\n${arm.toUpperCase()} (n=${s.n}):`)
  console.log(`  Primary solved:     ${s.solved}/${s.n} — ${formatCI(s.solvedCI)}`)
  console.log(`  Oracle pass:        ${formatCI(s.oracleCI)}`)
  console.log(`  Baseline RED:       ${formatCI(s.redCI)} | Adequate RED (mutants): ${formatCI(s.adequateRedCI)}`)
  console.log(`  Global monkeypatch: ${s.monkeyPatch}/${s.n} | EP adoption: ${s.adoptedEp}/${s.n}`)
  console.log(`  E9 False-green:     ${formatCI(s.falseGreenCI)} (loud breaks on buggy refactors: ${s.loudBuggy})`)
  console.log(`  E9 False-red:       ${formatCI(s.falseRedCI)} (loud breaks on valid alts: ${s.loudValid})`)
  console.log(
    `  Tokens & Cost:      ${s.totalTokens.toLocaleString()} total (${s.avgTokens.toLocaleString()}/trial, ${s.tokensPerSolved?.toLocaleString() ?? 'n/a'}/solved) | ${formatUsd(s.totalUsd)} total (${formatUsd(s.avgUsd)}/trial, ${formatUsd(s.usdPerSolved)}/solved) | ${s.avgSec.toFixed(1)}s/trial`,
  )
}

console.log('\n=== Stratified Effect Analysis (Treatment vs Control) ===')
const cmhSolved = stratifiedCMH(rows, (r) => Boolean(r.solved))
const rdSolved = matchedRiskDifferenceCI(rows, (r) => Boolean(r.solved))
console.log(
  `Primary solved CMH (strata=${cmhSolved.strataCount}): z=${cmhSolved.z}, p=${cmhSolved.pValue}, common OR=${cmhSolved.commonOddsRatio ?? 'n/a'}`,
)
if (rdSolved.diff !== null) {
  console.log(
    `Matched-block risk diff (blocks=${rdSolved.blocks}): ${(rdSolved.diff * 100).toFixed(1)}pp [${(rdSolved.low * 100).toFixed(1)}pp, ${(rdSolved.high * 100).toFixed(1)}pp]`,
  )
}

console.log('\n=== Per-Stratum Breakdown ===')
const strata = [...new Set(rows.map((r) => r.stratum ?? 'unknown'))]
for (const stratum of strata) {
  console.log(`\nStratum: ${stratum}`)
  const sRows = rows.filter((r) => (r.stratum ?? 'unknown') === stratum)
  for (const arm of ['control', 'treatment']) {
    const sub = sRows.filter((r) => r.arm === arm)
    if (sub.length === 0) continue
    const s = summarizeGroup(sub)
    console.log(
      `  ${arm.padEnd(9)} n=${String(s.n).padEnd(3)} solved=${formatCI(s.solvedCI)} | oracle=${formatCI(s.oracleCI)} | fg=${formatCI(s.falseGreenCI)} | cost=${formatUsd(s.avgUsd)}/trial (${formatUsd(s.usdPerSolved)}/solved)`,
    )
  }
  const cmh = stratifiedCMH(sRows, (r) => Boolean(r.solved))
  console.log(`  CMH p=${cmh.pValue}, common OR=${cmh.commonOddsRatio ?? 'n/a'} (strata=${cmh.strataCount})`)
}
