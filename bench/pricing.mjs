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
      servedModel: requestedModel,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      aiCredits: 0,
      premiumRequests: 0,
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
    servedModel: usageJson.currentModel ?? modelIds[0] ?? requestedModel,
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
