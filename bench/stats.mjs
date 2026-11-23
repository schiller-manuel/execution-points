/**
 * Statistical helpers for benchmark v2 analysis (P1.5, P2.3–P2.5):
 * - Exact Wilson 95% confidence intervals for binomial proportions.
 * - Stratified Cochran–Mantel–Haenszel (CMH) test across (task x model x reasoning) blocks.
 * - Matched-pair risk difference with deterministic bootstrap 95% CI.
 */

export function wilsonCI(successes, total, z = 1.959963984540054) {
  if (!total || total <= 0) return { rate: null, low: null, high: null }
  const p = successes / total
  const z2 = z * z
  const denom = 1 + z2 / total
  const center = (p + z2 / (2 * total)) / denom
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom
  return {
    rate: Number(p.toFixed(4)),
    low: Number(Math.max(0, center - margin).toFixed(4)),
    high: Number(Math.min(1, center + margin).toFixed(4)),
  }
}

export function formatCI(ci) {
  if (!ci || ci.rate === null) return 'n/a'
  return `${(ci.rate * 100).toFixed(1)}% [${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`
}

// Standard normal two-sided p-value from |z| using Abramowitz & Stegun erf approximation
function erf(x) {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-ax * ax)
  return sign * y
}

function twoSidedNormalP(z) {
  return Math.max(0, Math.min(1, 1 - erf(Math.abs(z) / Math.SQRT2)))
}

/**
 * Stratified Cochran–Mantel–Haenszel (CMH) test comparing Treatment vs Control
 * on a binary outcome `getOutcome(row)`, stratified by `taskId|model|reasoning`.
 */
export function stratifiedCMH(rows, getOutcome = (r) => Boolean(r.solved)) {
  const strata = new Map()
  for (const r of rows) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    const key = `${r.taskId}|${r.model}|${r.reasoning}`
    const s = strata.get(key) ?? { a: 0, b: 0, c: 0, d: 0 }
    const ok = getOutcome(r)
    if (r.arm === 'treatment') {
      if (ok) s.a++
      else s.b++
    } else {
      if (ok) s.c++
      else s.d++
    }
    strata.set(key, s)
  }

  let num = 0
  let varSum = 0
  let orNum = 0
  let orDen = 0
  let activeStrata = 0

  for (const { a, b, c, d } of strata.values()) {
    const n1 = a + b
    const n2 = c + d
    const m1 = a + c
    const m0 = b + d
    const n = n1 + n2
    if (n1 === 0 || n2 === 0 || n <= 1) continue
    activeStrata++
    const eA = (n1 * m1) / n
    const vA = (n1 * n2 * m1 * m0) / (n * n * (n - 1))
    num += a - eA
    varSum += vA
    orNum += (a * d) / n
    orDen += (b * c) / n
  }

  if (activeStrata === 0 || varSum === 0) {
    return {
      strataCount: activeStrata,
      chi2: 0,
      z: 0,
      pValue: 1,
      commonOddsRatio: null,
      note: activeStrata === 0 ? 'No matched strata with both arms' : 'Zero variance across strata (identical outcomes)',
    }
  }

  // Continuity-corrected CMH statistic
  const cc = Math.max(0, Math.abs(num) - 0.5)
  const chi2 = (cc * cc) / varSum
  const z = (num >= 0 ? 1 : -1) * Math.sqrt(chi2)
  const pValue = twoSidedNormalP(z)
  const commonOddsRatio =
    orDen > 0 ? Number((orNum / orDen).toFixed(4)) : orNum > 0 ? Infinity : null

  return {
    strataCount: activeStrata,
    chi2: Number(chi2.toFixed(4)),
    z: Number(z.toFixed(4)),
    pValue: Number(pValue.toFixed(6)),
    commonOddsRatio,
  }
}

/**
 * Deterministic bootstrap 95% CI on matched-block Treatment - Control risk difference.
 */
export function matchedRiskDifferenceCI(rows, getOutcome = (r) => Boolean(r.solved), iters = 2000) {
  const blocks = new Map()
  for (const r of rows) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    const key = `${r.taskId}|${r.model}|${r.reasoning}`
    const b = blocks.get(key) ?? { tOk: 0, tN: 0, cOk: 0, cN: 0 }
    if (r.arm === 'treatment') {
      b.tN++
      if (getOutcome(r)) b.tOk++
    } else {
      b.cN++
      if (getOutcome(r)) b.cOk++
    }
    blocks.set(key, b)
  }

  const diffs = []
  for (const b of blocks.values()) {
    if (b.tN > 0 && b.cN > 0) {
      diffs.push(b.tOk / b.tN - b.cOk / b.cN)
    }
  }
  if (diffs.length === 0) return { diff: null, low: null, high: null, blocks: 0 }

  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length
  if (diffs.length === 1) {
    return { diff: Number(mean.toFixed(4)), low: Number(mean.toFixed(4)), high: Number(mean.toFixed(4)), blocks: 1 }
  }

  let seed = 1337
  const rand = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return seed / 4294967296
  }

  const samples = []
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < diffs.length; j++) {
      sum += diffs[Math.floor(rand() * diffs.length)]
    }
    samples.push(sum / diffs.length)
  }
  samples.sort((a, b) => a - b)

  return {
    diff: Number(mean.toFixed(4)),
    low: Number(samples[Math.floor(iters * 0.025)].toFixed(4)),
    high: Number(samples[Math.floor(iters * 0.975)].toFixed(4)),
    blocks: diffs.length,
  }
}
