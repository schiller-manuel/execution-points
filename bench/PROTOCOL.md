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
- **`adequateReproduction` (P1.2, D-14 symmetric two-sided):** Inside a fresh pristine sandbox with explicit `--config` and runtime guards, the agent's test suite must (1) fail with a genuine `AssertionError` (`true_red` — not an import error, selection error, runtime guard violation, or timeout) on the pristine buggy baseline AND on every single-bug mutant for that task, (2) pass (`true_green`) on **at least one** independent calibrated valid fix in `VALID_FIX_VARIANTS` (`passesAtLeastOneValidFix`, defeating `E-06` fingerprint cheats without penalizing valid alternative designs such as `DS-queue-design`, `CC-serial-stage`, or `T6-late-delete`), and (3) pass on the agent's own fix.
- **`typecheckPass` / `contractTypecheckPass`:** Equal production-only `tsc --noEmit` across both arms, plus full workspace `tsc --noEmit` (Control) / `tsc --noEmit --runExternalCode` (Treatment).
- **`cleanProduction`:** Full-tree TypeScript 7.1 AST audit confirms zero extra exports (including `export namespace`/`enum`/destructuring), zero missing exports, zero unverified re-exports, zero parameter-count changes, zero production global hooks, and all required async I/O helpers remain async and called (also verified at runtime by minimum cold-yield counts in the hidden oracles).
- **`noGlobalMonkeyPatch` & `noRealSleeps`:** Enforced at BOTH runtime (non-configurable global/prototype-chain traps and real-sleep detectors in `bench/runtime-guard.setup.mjs`) and AST level across all agent-written test and support files, including `D-12` forbidding `node:async_hooks` / `node:worker_threads` runtime-internal interception in tests.

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

- **Sample size guidance (`N-29`):** Exact two-sided McNemar power at α = 0.05 depends on empirical discordance (share of matched blocks where exactly one arm solves). At 10% reproduction-only discordance (observed in the 29-block medium-reasoning pilot), 80% power requires ~78 blocks if Treatment wins 100% of discordant pairs, ~125 blocks at 90/10, and ~231 blocks at 80/20; the minimum one-sided result for p < 0.05 is 6/0 (`p = 0.031`). Allocate matrix budget where discordance occurs (Strata A and C, plus cheaper models / `low` reasoning where `io-seam` is not at 100% ceiling).
- **Primary analysis (equal-capability Strata B + C ONLY):** Stratified Cochran–Mantel–Haenszel (CMH) test and exact two-sided McNemar binomial p-value (`bench/analyze.mjs`), paired by `runId × taskId × actualModel × reasoning × promptStyle × trialIndex`, plus uncorrected Newcombe Method 10 paired-difference 95% CI (for small N, exact McNemar decides and Newcombe is descriptive). Stratum A (`closed-module`) is reported separately as a capability stratum and is **not** pooled into the primary test.
- **Secondary analysis:** Separate CMH / McNemar and approximate Wilson 95% CIs per stratum and per `promptStyle`, full **gate-sensitivity table** (`official`, `noValidFixGate`, `anyValidFix`, `allValidFixes`, `oracleOnly`), E9 robustness restricted to `adequateReproduction === true` rows (per stratum), and **paired per-trial ITT billed `aiCredits` difference (`T − C`)** with bootstrap 95% CI as primary cost metric (`estimatedUsd` labeled as list-price estimate; cost per solved task shown only alongside gate sensitivity). Technique subgroups are descriptive uptake metrics, never causal arm comparisons.

## 6. Pre-Registered Maintainer Decisions (`D-01`–`D-14`, effective v2.3)

- **D-01:** Primary test runs over equal-capability Strata B + C only; Stratum A (`closed-module`) is reported separately.
- **D-02:** Every replicate block carries its own `runId + trialIndex` in `stratumKey`, keeping 1:1 pairing so exact two-sided McNemar remains defined with replicates.
- **D-03:** Warm-cache hits are judged by 0 I/O helper yields (`matchSite`), not 0 total `await`s; per-key serialization queues are valid.
- **D-04:** Real-time sleeps (`setTimeout` with nonzero delay outside active `vi.useFakeTimers()`) are forbidden; `setImmediate` `settle()` turns are allowed.
- **D-05:** In `double-submit`, both shared-failure (all concurrent joiners receive the failure, 0 charges until retry) and per-key queued retry (first fails, queued waiter retries and charges at most once with identical receipt across N ≥ 3 callers) are valid; documented in both prompts and enforced design-neutrally in the hidden oracle.
- **D-06:** Reading outside the workspace or accessing network/GitHub from tests is forbidden and blocked at OS level via hardened `--sandbox`.
- **D-07:** In Strata B + C, `execution-points` is optional (guided availability via `TESTING_GUIDE.md`); adoption is recorded as a descriptive secondary outcome.
- **D-08:** E9 robustness is computed over `adequateReproduction === true` rows only, per stratum.
- **D-09:** Real-fs tasks (`cancel-commit`) track leaf `fs.*` I/O separately (`activeLeafIo`) so leaf disk calls settle deterministically before every scheduler pick.
- **D-10 / D-14:** `adequateReproduction` requires passing **at least one** calibrated valid fix in `VALID_FIX_VARIANTS` (`passesAtLeastOneValidFix`), where every task has ≥ 2 design-diverse valid fixes (`G-4`). Full cross-design pass rates, semantic failures, timeouts, and selector breaks are reported side-by-side in E9 and the gate-sensitivity table.
- **D-11:** `--max-ai-credits` is omitted by default so the CLI does not inject live cost-meter hints into tool results; budget caps are enforced at block boundaries in the harness (`--max-total-credits`).
- **D-12 (effective v2.3, future runs only):** Intercepting Node runtime internals (`node:async_hooks`, `node:worker_threads`) in tests to step libuv handles is forbidden and blocked by `ast-audit.mjs`. Not applied retroactively to the stored `c70758a` 58-trial pilot.
- **D-13 (effective v2.3):** In `token-session`, concurrent `getActiveToken(userId)` calls within one active session must converge on one token; whether `logout` deletes at start or completion is implementation-defined (both `T3-ref` and `T6-late-delete` are in `VALID_FIX_VARIANTS`).
- **Provenance (`V-07`):** `bench/analyze.mjs` requires matching `gitCommit`, `copilotVersion`, relative-path `graderChecksum`, `harnessSha256`, `calibrationSha256`, `lockfileSha256`, `toolSha256`, `tasksSha256`, `vitestVersion`, and `typescriptVersion` unless `--allow-mixed` is explicitly passed. Host sleep detected during grading marks `hostSleepDetected=true`, `infraFailure=true`, `ungradable=true`.
