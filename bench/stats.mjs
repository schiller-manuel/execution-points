/**
 * Statistical helpers for benchmark analysis (harness v2.5; P1.5, P2.3–P2.5, ST-01..ST-07):
 * - Approximate Wilson 95% confidence intervals for binomial proportions.
 * - Stratified Cochran–Mantel–Haenszel (CMH) test across matched blocks
 *   `(runId x taskId x requested model x reasoning x promptStyle x trialIndex)`.
 *   Blocks are keyed on the REQUESTED model (`blockKey`): the served model name
 *   is an outcome of the run and is null on aborted rows, so keying on it lets a
 *   row lose its pair without notice. `unmatchedRows` lists every row whose
 *   block lacks the other arm.
 * - Exact two-sided McNemar binomial test for 1-per-arm matched strata, and its
 *   exact power (`exactMcNemarPower`, `blocksForPower`).
 * - Newcombe (1998) paired-difference 95% CI, Method 10 (`matchedRiskDifferenceCI`).
 *   See that function for the formula, for what it returns on degenerate tables,
 *   and for how it differs from the interval v2.3 printed under the same name.
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

function logGamma(z) {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  z -= 1
  let x = c[0]
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

function logBinomProb(k, n, p = 0.5) {
  if (p <= 0) return k === 0 ? 0 : -Infinity
  if (p >= 1) return k === n ? 0 : -Infinity
  const logComb = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
  return logComb + k * Math.log(p) + (n - k) * Math.log(1 - p)
}

export function exactMcNemarP(treatOnly, ctrlOnly) {
  const n = treatOnly + ctrlOnly
  if (n === 0) return 1
  const k = Math.min(treatOnly, ctrlOnly)
  let tail = 0
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logBinomProb(i, n, 0.5))
  }
  return Number(Math.min(1, 2 * tail).toFixed(6))
}

/**
 * The matched block a row belongs to. Keyed on the requested model, never the
 * served one (`actualModel`), so both arms of a block always share a key.
 */
export function blockKey(r) {
  const model = r.model || r.usage?.requestedModel || 'unknown'
  const prompt = r.promptStyle || 'unknown'
  // N-27: Include runId + trialIndex so re-runs never merge into 2x2 blocks and exact McNemar stays defined
  const run = r.runId || 'run'
  const trial = r.trialIndex ?? 1
  return `${run}|${r.taskId}|${model}|${r.reasoning}|${prompt}|t${trial}`
}
const stratumKey = blockKey

/**
 * Every row that no paired statistic can use: its block has no row of the
 * other arm, or more than one row of its own arm.
 */
export function unmatchedRows(rows) {
  const blocks = new Map()
  for (const r of rows) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    const key = blockKey(r)
    const b = blocks.get(key) ?? { control: [], treatment: [] }
    b[r.arm].push(r)
    blocks.set(key, b)
  }
  const out = []
  for (const [key, b] of blocks) {
    if (b.control.length === 1 && b.treatment.length === 1) continue
    const reason =
      b.control.length === 0
        ? 'no control row in its block'
        : b.treatment.length === 0
          ? 'no treatment row in its block'
          : `block has ${b.control.length} control and ${b.treatment.length} treatment rows`
    for (const r of [...b.control, ...b.treatment]) out.push({ row: r, key, reason })
  }
  return out
}

/**
 * Exact power of the two-sided exact McNemar test with `blocks` matched pairs,
 * when a pair is discordant with probability `pDiscordant` and a discordant
 * pair favors treatment with probability `pTreatmentWins`.
 */
export function exactMcNemarPower(blocks, pDiscordant, pTreatmentWins, alpha = 0.05) {
  let power = 0
  for (let d = 1; d <= blocks; d++) {
    const pD = Math.exp(logBinomProb(d, blocks, pDiscordant))
    if (pD < 1e-15) continue
    let reject = 0
    for (let x = 0; x <= d; x++) {
      if (exactMcNemarP(x, d - x) < alpha) reject += Math.exp(logBinomProb(x, d, pTreatmentWins))
    }
    power += pD * reject
  }
  return power
}

/** Smallest number of matched blocks at which `exactMcNemarPower` reaches `target`. */
export function blocksForPower(pDiscordant, pTreatmentWins, target = 0.8, alpha = 0.05, maxBlocks = 20000) {
  if (!(pDiscordant > 0) || pTreatmentWins === 0.5) return null
  let lo = 1
  let hi = 1
  while (hi <= maxBlocks && exactMcNemarPower(hi, pDiscordant, pTreatmentWins, alpha) < target) hi *= 2
  if (hi > maxBlocks) return null
  // Power is not monotone in the number of blocks (the exact test is discrete), so scan
  // upward from the last power-of-two below the first hit instead of bisecting.
  lo = Math.max(1, hi / 2)
  for (let n = lo; n <= hi; n++) {
    if (exactMcNemarPower(n, pDiscordant, pTreatmentWins, alpha) >= target) return n
  }
  return hi
}

export function stratifiedCMH(rows, getOutcome = (r) => Boolean(r.solved)) {
  const strata = new Map()
  for (const r of rows) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    const key = stratumKey(r)
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
  let singlePairTreatOnly = 0
  let singlePairCtrlOnly = 0
  let allSinglePairs = true

  for (const { a, b, c, d } of strata.values()) {
    const n1 = a + b
    const n2 = c + d
    const m1 = a + c
    const m0 = b + d
    const n = n1 + n2
    if (n1 === 0 || n2 === 0 || n <= 1) continue
    activeStrata++
    if (n1 === 1 && n2 === 1) {
      if (a === 1 && c === 0) singlePairTreatOnly++
      else if (a === 0 && c === 1) singlePairCtrlOnly++
    } else {
      allSinglePairs = false
    }
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
      exactMcNemarP: activeStrata > 0 && allSinglePairs ? 1 : null,
      commonOddsRatio: null,
      note: activeStrata === 0 ? 'No matched strata with both arms' : 'Zero variance across strata',
    }
  }

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
    exactMcNemarP: allSinglePairs ? exactMcNemarP(singlePairTreatOnly, singlePairCtrlOnly) : null,
    discordantPairs: allSinglePairs
      ? { treatmentOnly: singlePairTreatOnly, controlOnly: singlePairCtrlOnly }
      : null,
    commonOddsRatio,
  }
}

/**
 * Paired risk difference (treatment − control) with a Newcombe (1998) 95% CI.
 *
 * With the paired table a = both solved, b = treatment only, c = control only,
 * d = neither, and Wilson score limits (l1, u1) for p1 = (a+b)/n and (l2, u2)
 * for p2 = (a+c)/n, the interval is
 *
 *   lower = (p1 − p2) − sqrt((p1−l1)² − 2·φ·(p1−l1)(u2−p2) + (u2−p2)²)
 *   upper = (p1 − p2) + sqrt((u1−p1)² − 2·φ·(u1−p1)(p2−l2) + (p2−l2)²)
 *
 * where φ estimates the correlation between the two arms.
 *
 * - Method 10 (returned as `low`/`high`, `method: 'newcombe-10'`) uses Wilson
 *   limits without continuity correction and a continuity-corrected φ: with
 *   A = (a+b)(c+d)(a+c)(b+d), φ = 0 if A = 0; φ = max(ad − bc − n/2, 0)/√A if
 *   ad > bc; φ = (ad − bc)/√A otherwise.
 * - Method 8 (returned as `uncorrectedPhi`) is the same interval with
 *   φ = (ad − bc)/√A throughout. This is what v2.3 computed and printed as
 *   "Newcombe Method 10". Its φ reaches 1 when every pair is concordant and both
 *   outcomes occur, and the interval then shrinks to |(p−l) − (u−p)| on each
 *   side, which is [0, 0] when half the pairs are solved. Method 10's
 *   correction exists to prevent that.
 *
 * Neither method returns a zero-width interval for a table with a single
 * outcome cell (φ = 0 there). For small n the exact McNemar test decides and
 * this interval is descriptive.
 */
export function matchedRiskDifferenceCI(rows, getOutcome = (r) => Boolean(r.solved), z = 1.959963984540054) {
  const blocks = new Map()
  for (const r of rows) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    const key = stratumKey(r)
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

  let a = 0
  let b = 0
  let c = 0
  let d = 0
  let matchedBlocks = 0
  let diffSum = 0

  for (const blk of blocks.values()) {
    if (blk.tN === 0 || blk.cN === 0) continue
    matchedBlocks++
    const pT = blk.tOk / blk.tN
    const pC = blk.cOk / blk.cN
    diffSum += pT - pC
    a += pT * pC
    b += pT * (1 - pC)
    c += (1 - pT) * pC
    d += (1 - pT) * (1 - pC)
  }

  if (matchedBlocks === 0) {
    return { diff: null, low: null, high: null, blocks: 0, method: 'newcombe-10', uncorrectedPhi: null }
  }

  const diff = diffSum / matchedBlocks
  return {
    diff: Number(diff.toFixed(4)),
    ...newcombePairedLimits({ a, b, c, d }, diff, z, true),
    blocks: matchedBlocks,
    method: 'newcombe-10',
    uncorrectedPhi: newcombePairedLimits({ a, b, c, d }, diff, z, false),
  }
}

/** Newcombe's square-and-add limits around `diff` for one paired table (see above). */
export function newcombePairedLimits({ a, b, c, d }, diff, z = 1.959963984540054, correctPhi = true) {
  const N = a + b + c + d
  const p1 = (a + b) / N
  const p2 = (a + c) / N
  const ci1 = wilsonCI(a + b, N, z)
  const ci2 = wilsonCI(a + c, N, z)
  const l1 = ci1.low
  const u1 = ci1.high
  const l2 = ci2.low
  const u2 = ci2.high

  const denomPhi = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d))
  let phi = 0
  if (denomPhi > 0) {
    const num = a * d - b * c
    if (correctPhi && num > 0) phi = Math.max(num - N / 2, 0) / denomPhi
    else phi = num / denomPhi
  }

  const dl = Math.sqrt(
    Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2),
  )
  const du = Math.sqrt(
    Math.max(0, (p2 - l2) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (u1 - p1) ** 2),
  )

  return {
    low: Number(Math.max(-1, diff - dl).toFixed(4)),
    high: Number(Math.min(1, diff + du).toFixed(4)),
  }
}

/**
 * Paired ITT billed-credit difference (Treatment - Control) per matched block
 * with deterministic bootstrap 95% CI (closes G-9).
 */
export function pairedCreditDiffCI(rows, iters = 2000) {
  const blocks = new Map()
  for (const r of rows) {
    if (r.arm !== 'control' && r.arm !== 'treatment') continue
    if (r.notStarted || r.usage?.usageMissing || typeof r.usage?.aiCredits !== 'number') continue
    const key = stratumKey(r)
    const b = blocks.get(key) ?? {}
    b[r.arm] = r.usage.aiCredits
    blocks.set(key, b)
  }

  const diffs = []
  let treatCheaper = 0
  for (const b of blocks.values()) {
    if (typeof b.treatment === 'number' && typeof b.control === 'number') {
      const d = b.treatment - b.control
      diffs.push(d)
      if (d < 0) treatCheaper++
    }
  }
  if (diffs.length === 0) {
    return { blocks: 0, meanDiff: null, low: null, high: null, treatCheaper: 0 }
  }
  const meanDiff = diffs.reduce((s, x) => s + x, 0) / diffs.length
  if (diffs.length === 1) {
    return {
      blocks: 1,
      meanDiff: Number(meanDiff.toFixed(2)),
      low: null,
      high: null,
      treatCheaper,
    }
  }

  let seed = 1337
  const rand = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const samples = []
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rand() * diffs.length)]
    samples.push(sum / diffs.length)
  }
  samples.sort((a, b) => a - b)

  return {
    blocks: diffs.length,
    meanDiff: Number(meanDiff.toFixed(2)),
    low: Number(samples[Math.floor(iters * 0.025)].toFixed(2)),
    high: Number(samples[Math.floor(iters * 0.975)].toFixed(2)),
    treatCheaper,
  }
}
