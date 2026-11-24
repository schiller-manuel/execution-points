/**
 * Transparent per-1M-token USD pricing table and usage extractor for Copilot CLI
 * `--usage-output-file` JSON payloads.
 *
 * Raw token counts and `totalNanoAiu` (AI credits) are always persisted in
 * `results.jsonl`, so USD estimates can be recomputed at any time if rates change.
 */

// Rates in USD per 1,000,000 tokens (approximate public list pricing; edit as needed).
export const MODEL_PRICING_PER_M = {
  'gemini-4-neon': { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15.0 },
  'gemini-4-argon': { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15.0 },
  'gemini-4-hydrogen': { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10.0 },
  'gpt-6.2-astra': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.0, output: 15.0 },
  'gpt-6.2-sol': { input: 2.0, cacheRead: 0.2, cacheWrite: 2.0, output: 12.0 },
  'gpt-6.1-sol': { input: 2.0, cacheRead: 0.2, cacheWrite: 2.0, output: 10.0 },
  'gpt-6-astra': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.0, output: 15.0 },
  'claude-opus-5.5': { input: 15.0, cacheRead: 1.5, cacheWrite: 18.75, output: 75.0 },
  'claude-sonnet-5.5': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  'claude-haiku-5.5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
}

/**
 * Billed AI credits per trial, observed in the three stored paid runs of
 * 2026-11-23 and 2026-11-24 (138 started trials). `mean` and `max` are per
 * trial for that `model:reasoning`; `n` is how many trials they come from.
 * Used only to project the cost of a matrix before it starts.
 */
export const OBSERVED_CREDITS_PER_TRIAL = {
  'gpt-6.2-astra:medium': { mean: 30.72, max: 50.42, n: 20 },
  'claude-opus-5.5:medium': { mean: 44.29, max: 112.84, n: 20 },
  'gemini-4-neon:medium': { mean: 41.43, max: 64.95, n: 18 },
  'gpt-6.2-sol:low': { mean: 6.17, max: 8.39, n: 20 },
  'gpt-6.2-sol:medium': { mean: 10.12, max: 16.8, n: 20 },
  'claude-haiku-5.5:low': { mean: 1.04, max: 1.81, n: 20 },
  'claude-haiku-5.5:medium': { mean: 1.56, max: 3.27, n: 20 },
}

/** Credits the mandatory live preflight used in the stored runs (17.8, 17.8, 4.4). */
export const OBSERVED_PREFLIGHT_CREDITS = 17.8

/** The projection is the sum of per-trial means times this margin. */
export const PROJECTION_MARGIN = 1.2

/**
 * Projects the billed credits of a planned matrix.
 *
 * `jobs` is a list of `{ model, reasoning }`, one per trial. The estimate per
 * trial is `creditsPerTrial` when given, else the observed mean for that
 * `model:reasoning`. A combination with no observation and no override is
 * listed in `unknown` and makes `projected` null: the caller must not guess.
 */
export function projectCredits(jobs, { creditsPerTrial = null, includePreflight = true } = {}) {
  const perCell = {}
  const unknown = new Set()
  let sum = 0
  for (const job of jobs) {
    const key = `${job.model}:${job.reasoning}`
    const estimate = creditsPerTrial ?? OBSERVED_CREDITS_PER_TRIAL[key]?.mean ?? null
    if (estimate === null) {
      unknown.add(key)
      continue
    }
    const cell = (perCell[key] ??= { trials: 0, perTrial: estimate, credits: 0 })
    cell.trials++
    cell.credits += estimate
    sum += estimate
  }
  const preflight = includePreflight ? OBSERVED_PREFLIGHT_CREDITS : 0
  const complete = unknown.size === 0
  return {
    perCell,
    unknown: [...unknown],
    trialsMean: complete ? Number(sum.toFixed(1)) : null,
    preflight,
    margin: PROJECTION_MARGIN,
    projected: complete ? Number((sum * PROJECTION_MARGIN + preflight).toFixed(1)) : null,
    source: creditsPerTrial !== null ? '--credits-per-trial' : 'observed means of the stored runs',
  }
}

export function formatUsd(usd) {
  if (typeof usd !== 'number' || Number.isNaN(usd)) return 'n/a'
  return `$${usd.toFixed(4)}`
}

export function estimateUsdForUsage(modelId, usage) {
  const rates = MODEL_PRICING_PER_M[modelId]
  if (!rates || !usage) return null
  const input = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const output = usage.outputTokens ?? 0
  // Note: Copilot CLI reports `inputTokens` inclusive of cached reads in some providers;
  // clamp uncached input at >= 0 so cost is never negative.
  const uncachedInput = Math.max(0, input - cacheRead - cacheWrite)
  const usd =
    (uncachedInput / 1_000_000) * rates.input +
    (cacheRead / 1_000_000) * rates.cacheRead +
    (cacheWrite / 1_000_000) * rates.cacheWrite +
    (output / 1_000_000) * rates.output
  return Number(usd.toFixed(6))
}

export function extractUsageMetrics(usageJson, requestedModel) {
  if (!usageJson || typeof usageJson !== 'object') {
    return {
      usageMissing: true,
      servedModel: null,
      requestedModel,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      aiCredits: null,
      premiumRequests: null,
      apiDurationMs: 0,
      estimatedUsd: null,
      perModelBreakdown: {},
    }
  }

  let modelCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let totalUsd = 0
  let allPriced = true
  const perModelBreakdown = {}

  const modelMetrics = usageJson.modelMetrics ?? {}
  const modelIds = Object.keys(modelMetrics)

  for (const modelId of modelIds) {
    const m = modelMetrics[modelId]
    const u = m?.usage ?? {}
    const calls = m?.requests?.count ?? 0
    const mIn = u.inputTokens ?? 0
    const mOut = u.outputTokens ?? 0
    const mCR = u.cacheReadTokens ?? 0
    const mCW = u.cacheWriteTokens ?? 0
    const mReas = u.reasoningTokens ?? 0
    const usd = estimateUsdForUsage(modelId, u)
    if (usd === null) allPriced = false
    else totalUsd += usd

    modelCalls += calls
    inputTokens += mIn
    outputTokens += mOut
    cacheReadTokens += mCR
    cacheWriteTokens += mCW
    reasoningTokens += mReas

    perModelBreakdown[modelId] = {
      modelCalls: calls,
      inputTokens: mIn,
      outputTokens: mOut,
      cacheReadTokens: mCR,
      cacheWriteTokens: mCW,
      reasoningTokens: mReas,
      aiCredits: typeof m?.totalNanoAiu === 'number' ? Number((m.totalNanoAiu / 1e9).toFixed(4)) : null,
      estimatedUsd: usd,
    }
  }

  // Fallback to top-level tokenDetails if modelMetrics is empty
  if (modelIds.length === 0 && usageJson.tokenDetails) {
    inputTokens = usageJson.tokenDetails.input?.tokenCount ?? 0
    outputTokens = usageJson.tokenDetails.output?.tokenCount ?? 0
    cacheReadTokens = usageJson.tokenDetails.cache_read?.tokenCount ?? 0
    cacheWriteTokens = usageJson.tokenDetails.cache_write?.tokenCount ?? 0
    const usd = estimateUsdForUsage(usageJson.currentModel ?? requestedModel, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    })
    if (usd !== null) totalUsd = usd
    else allPriced = false
  }

  const aiCredits =
    typeof usageJson.totalNanoAiu === 'number'
      ? Number((usageJson.totalNanoAiu / 1e9).toFixed(4))
      : 0

  return {
    usageMissing: false,
    servedModel: usageJson.currentModel ?? modelIds[0] ?? null,
    requestedModel,
    modelCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens,
    aiCredits,
    premiumRequests: usageJson.totalPremiumRequestCost ?? 0,
    apiDurationMs: usageJson.totalApiDurationMs ?? 0,
    estimatedUsd: modelIds.length > 0 || inputTokens > 0 ? (allPriced ? Number(totalUsd.toFixed(6)) : null) : 0,
    perModelBreakdown,
  }
}
