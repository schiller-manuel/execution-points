# Benchmark v2 Pre-Registered Experimental Protocol

This protocol pre-registers the experimental design, primary endpoint, secondary endpoints, intention-to-treat handling, and statistical analysis plan for evaluating `execution-points` against plain Vitest across coding agents.

## 1. Research Questions

1. **Primary:** Across realistic TypeScript async concurrency bugs (stratified by testability), does making `execution-points-prototype` available with symmetric guidance increase the intention-to-treat `solved` rate compared to plain Vitest?
2. **Secondary (Stratum interaction):** How does the effect differ across:
   - **Stratum A (`closed-module`, 3 tasks):** `stale-cache`, `token-session`, `double-submit` (no DI/module seam; global monkey-patching forbidden).
   - **Stratum B (`io-seam`, 5 tasks):** `stale-cache-seam`, `single-flight`, `retry-storm`, `event-order`, `cross-module-transfer` (I/O lives in separate modules cleanly mockable with `vi.mock`).
   - **Stratum C (`real-async`, 2 tasks):** `cancel-commit` (`node:fs/promises` + `AbortController`), `debounce-search` (real timers + async search API).
3. **Secondary (Regression-test robustness, E9):** Do regression tests written with `execution-points` achieve a lower **false-green rate** on behavior-preserving buggy refactors than standard Vitest tests, while breaking loudly rather than silently passing?
4. **Secondary (Efficiency & Adoption):** What are the token usage, derived USD cost, wall-clock duration, cost per solved task, and organic adoption rate (in the non-mandated Treatment arm)?

## 2. Primary Endpoint (Pre-Registered)

Every trial receives a single binary primary outcome:

```text
solved = oraclePass
       ∧ visibleTestsPass
       ∧ agentTestsPass
       ∧ adequateReproduction
       ∧ typecheckPass
       ∧ contractTypecheckPass   (true trivially in Control)
       ∧ cleanProduction
       ∧ noGlobalMonkeyPatch
       ∧ noRealSleeps
```

Where:
- **`oraclePass`:** Independent `yield-engine` hidden concurrency grader passes across the agent's entire `src/` tree (lazy effects, staggered starts, multi-key/multi-user, DB + cache + warm-cache yields).
- **`visibleTestsPass`:** Pristine starter visible tests pass against the agent's patched `src/`.
- **`agentTestsPass`:** Agent's own test suite passes under pristine `vitest.config.mjs` / `package.json`.
- **`adequateReproduction` (P1.2):** Under pristine configs, the agent's test suite fails with a genuine `AssertionError` (`true_red` — NOT an import error, selection error, or timeout!) on BOTH the pristine buggy baseline AND every single-bug mutant for that task, and passes on the agent's fix.
- **`typecheckPass` / `contractTypecheckPass`:** `tsc --noEmit` on production code passes (both arms), and `tsc --noEmit --runExternalCode` passes on the full workspace (verifying Treatment's virtual `.ep` contracts).
- **`cleanProduction`:** TypeScript 7.1 AST audit confirms zero extra exports, zero missing exports, zero parameter-count changes, and all required async I/O helpers remain async.
- **`noGlobalMonkeyPatch` & `noRealSleeps`:** TypeScript 7.1 AST audit confirms zero global/prototype patching (`Promise`, `Map`, `MessageChannel`, `globalThis`, `vi.stubGlobal`, `Object.defineProperty`, `Reflect.set`) and zero real-time sleeps (`setTimeout` outside `vi.useFakeTimers()`).

## 3. Secondary Endpoints (Pre-Registered)

1. Each component of `solved` reported individually (`oraclePass`, `redReproducesBug`, `adequateReproduction`, `cleanProduction`, `noGlobalMonkeyPatch`).
2. **Adoption & technique:** Organic use of `execution-points` (`select()`), `module-mock`, `fake-timers`, `deferred-only`, or `global-patch`.
3. **E9 Regression-test robustness:**
   - **False-green rate:** share of behavior-preserving buggy refactors where the agent's test silently passes.
   - **False-red assertion rate:** share of valid alternative fixes (`V5`, `V7`, `V9`, `T2a`, `T2b`, `T3`, `T4`, etc.) where the agent's test fails with an assertion error (separated from loud selection/compile breaks).
4. **Telemetry & economics:** `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `aiCredits`, `estimatedUsd`, `usdPerSolved`, `tokensPerSolved`, wall-clock duration, and `firstRedBeforeFirstSourceEdit`.

## 4. Intention-to-Treat, Exclusions, and Stopping Rule

- **Intention-to-treat (ITT):** Every started trial is appended to `results.jsonl` and included in the denominator. Timeouts, credit-cap stops, agent crashes, missing files, and protocol violations count as `solved = false` and are **never dropped**.
- **Infrastructure exclusions:** A trial may be marked `ungradable` ONLY for verified harness/grader infrastructure failure (e.g., toolchain checksum mismatch or grader transform crash), never for agent compile/runtime/deadlock failures.
- **Blocking & randomization:** Within each `(task, model, reasoning, trialIndex)` block, Control vs. Treatment execution order is randomized via a seeded PRNG (`--seed`).
- **Two-phase execution:** By default (`--phase-split`), all Copilot CLI trials execute in Phase 1 and all grading/mutant/refactor suites execute serially in Phase 2 so grading CPU load never confounds agent latency or timeouts.
- **Stopping rule:** Choose the exact matrix (`tasks × models × trials`) before launching a paid run and run it to completion; never stop early based on intermediate p-values.

## 5. Power & Analysis Plan

- **Sample size guidance:** Detecting a 50% → 80% lift at α = 0.05, 80% power requires ~39 matched trials per arm before clustering; detecting 50% → 70% requires ~93 per arm. Prioritize spanning all **10 tasks** before repeating cells.
- **Primary analysis:** Stratified Cochran–Mantel–Haenszel (CMH) test (`bench/analyze.mjs`) stratified by `task × model × reasoning`, plus matched-block risk difference with bootstrap 95% CI, and per-arm / per-stratum Wilson 95% confidence intervals.
- **Secondary analysis:** Separate CMH and Wilson CIs per stratum (`closed-module`, `io-seam`, `real-async`) and per prompt variant (`symptom` vs `described`).
