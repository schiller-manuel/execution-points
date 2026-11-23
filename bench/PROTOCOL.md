# Benchmark v2 Pre-Registered Experimental Protocol

This protocol pre-registers the experimental design, primary endpoint, secondary endpoints, intention-to-treat handling, and statistical analysis plan for evaluating `execution-points` against plain Vitest across coding agents.

## 1. Research Questions

1. **Primary:** Across realistic TypeScript async concurrency bugs (stratified by testability), does making `execution-points-prototype` available with symmetric guidance increase the intention-to-treat `solved` rate compared to plain Vitest?
2. **Secondary (Stratum interaction — Stratum A reported separately):** How does the effect differ across:
   - **Stratum A (`closed-module`, 3 tasks — capability stratum: tool vs. no module seam):** `stale-cache`, `token-session`, `double-submit`. When global monkey-patching is forbidden, Control has no legal module seam to reorder FIFO-equal private I/O in `stale-cache` (finding F-01/F-02); Stratum A is therefore reported separately as a capability stratum, not pooled as an equal-capability test.
   - **Stratum B (`io-seam`, 5 tasks — equal-capability head-to-head):** `stale-cache-seam`, `single-flight`, `retry-storm`, `event-order`, `cross-module-transfer` (I/O lives in separate modules cleanly mockable with `vi.mock`).
   - **Stratum C (`real-async`, 2 tasks — equal-capability head-to-head):** `cancel-commit` (`node:fs/promises` + `AbortController`), `debounce-search` (real timers + async search API).
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
- **`adequateReproduction` (P1.2, two-sided):** Inside a fresh pristine sandbox with explicit `--config` and runtime guards, the agent's test suite must (1) fail with a genuine `AssertionError` (`true_red` — not an import error, selection error, runtime guard violation, or timeout) on the pristine buggy baseline AND on every single-bug mutant for that task, (2) pass (`true_green`) on the task's shipped reference fix (`refFixPass`), and (3) pass on the agent's own fix.
- **`typecheckPass` / `contractTypecheckPass`:** Equal production-only `tsc --noEmit` across both arms, plus full workspace `tsc --noEmit` (Control) / `tsc --noEmit --runExternalCode` (Treatment).
- **`cleanProduction`:** Full-tree TypeScript 7.1 AST audit confirms zero extra exports (including `export namespace`/`enum`/destructuring), zero missing exports, zero unverified re-exports, zero parameter-count changes, zero production global hooks, and all required async I/O helpers remain async and called (also verified at runtime by minimum cold-yield counts in the hidden oracles).
- **`noGlobalMonkeyPatch` & `noRealSleeps`:** Enforced at BOTH runtime (non-configurable global/prototype traps and real-sleep detectors in `bench/runtime-guard.setup.mjs`) and AST level across all agent-written test and support files.

## 3. Secondary Endpoints (Pre-Registered)

1. Each component of `solved` reported individually (`oraclePass`, `redReproducesBug`, `refFixPass`, `adequateReproduction`, `cleanProduction`, `noGlobalMonkeyPatch`, `tamperedConfigs`, `ungradable`, `aborted`).
2. **Adoption & technique:** Organic use of `execution-points` (`select()` + `withReplacement()`), `module-mock`, `fake-timers`, `deferred-only`, or `global-patch`.
3. **E9 Regression-test robustness:**
   - **Buggy false-green rate:** share of behavior-preserving buggy refactors where the agent's test silently passes.
   - **Valid-fix pass rate (headline):** `trueGreenCount / total` across design-diverse valid fixes (e.g., both queue-based `V9` and revision-guard `V9_REV`, plus `V5`/`V7`, `T2a`/`T2b`/`T3`/`T4`), with false-red counting BOTH assertion failures AND timeouts, reported alongside selector/compile breaks separately.
4. **Telemetry & economics:** `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `aiCredits`, `estimatedUsd`, `usageMissing`, `usdPerSolved`, `tokensPerSolved`, wall-clock duration, and `firstRedBeforeFirstSourceEdit` (parsing all paths in `apply_patch`).

## 4. Intention-to-Treat, Exclusions, and Stopping Rule

- **Intention-to-treat (ITT):** Every started trial (including `SIGINT`/`SIGTERM`-aborted trials) is appended to `results.jsonl` and included in the primary denominator. Timeouts, credit-cap stops, agent crashes, missing files, and protocol violations count as `solved = false` and are **never dropped**.
- **Infrastructure exclusions (`ungradable`):** Trials that throw a harness/grader exception are flagged `ungradable: true` and reported in a secondary per-protocol sensitivity analysis alongside the ITT primary result.
- **Provenance & non-pooling:** Every row records `runId`, `gitCommit`, `gitDirty`, `harnessSha256`, `toolSha256`, and `tasksSha256`. `bench/analyze.mjs` deduplicates by `(runId, trialId)` and refuses to pool rows with mismatched provenance unless `--allow-mixed` is passed explicitly.
- **Blocking & randomization:** Within each `(task, model, reasoning, trialIndex)` block, Control vs. Treatment execution order is randomized via a seeded PRNG (`--seed`).
- **Two-phase execution & Phase-1 cleanup:** By default (`--phase-split`), Phase 1 snapshots each workspace immediately upon completion and deletes `workspaceDir` before grading; Phase 2 grades serially in fresh sandboxes off the agents' CPUs.
- **Stopping rule:** Choose the exact matrix (`--run --tasks ... --models ... --max-total-credits ...`) before launching a paid run and run it to completion; never stop early based on intermediate p-values.

## 5. Power & Analysis Plan

- **Sample size guidance:** Unpaired 50% → 80% power is ~39 per arm (~41 matched McNemar pairs under independence), but paired CMH power depends on the empirical discordance rate and strata at floor/ceiling contribute zero discordant pairs. Run a 2-trial-per-cell pilot across the equal-capability strata (B + C) to measure empirical discordance before sizing the full matrix. Prioritize spanning all tasks before repeating cells.
- **Primary analysis:** Stratified Cochran–Mantel–Haenszel (CMH) test and exact two-sided McNemar binomial p-value (`bench/analyze.mjs`), stratified by `taskId × actualModel × reasoning × promptStyle`, plus Newcombe paired-difference 95% CI (which never collapses to zero width at small N), and descriptive approximate Wilson 95% CIs per arm.
- **Secondary analysis:** Separate CMH / McNemar and Wilson CIs per stratum (separating Stratum A `closed-module` from equal-capability Strata B + C) and per `promptStyle` (`symptom` vs `described`).
