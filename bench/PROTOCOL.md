# Benchmark Pre-Registered Experimental Protocol

Harness version: `v2.5` (`HARNESS_VERSION` in `bench/run.mjs`; `node bench/run.mjs --self-test` fails when this line, the runner, or a file header disagree).

This protocol pre-registers the experimental design, primary endpoint, secondary endpoints, intention-to-treat handling, and statistical analysis plan for evaluating `execution-points` against plain Vitest across coding agents. It describes what the harness does at the version above. The three stored paid runs of 2026-11-23 and 2026-11-24 were graded by v2.2 and v2.3; section 7 lists what differs for them.

## 1. Research Questions

1. **Primary:** Across realistic TypeScript async concurrency bugs (stratified by testability), does making `execution-points-prototype` available with symmetric guidance increase the intention-to-treat `solved` rate compared to plain Vitest?
2. **Secondary (Stratum interaction — Stratum A reported separately):** How does the effect differ across:
   - **Stratum A (`closed-module`, 3 tasks — capability stratum: tool vs. no module seam):** `stale-cache`, `token-session`, `double-submit`. When global monkey-patching is forbidden, Control has no legal module seam to reorder FIFO-equal private I/O in `stale-cache` (finding F-01/F-02); Stratum A is therefore reported separately as a capability stratum, not pooled as an equal-capability test.
   - **Stratum B (`io-seam`, 5 tasks — equal-capability head-to-head):** `stale-cache-seam`, `single-flight`, `retry-storm`, `event-order`, `cross-module-transfer` (I/O lives in separate modules cleanly mockable with `vi.mock`).
   - **Stratum C (`real-async`, 2 tasks — equal-capability head-to-head):** `cancel-commit` (real disk I/O through `node:fs/promises`; the task source uses no `AbortController`, only the reference fix does) and `debounce-search` (real timers + async search API).
3. **Secondary (Regression-test robustness, E9):** Do regression tests written with `execution-points` achieve a lower **false-green rate** on behavior-preserving buggy refactors than standard Vitest tests, and how often does each kind of test stop testing (loud break, timeout, other error) instead of staying red?
4. **Secondary (Efficiency & Adoption):** What are the token usage, derived USD cost, wall-clock duration, cost per solved task, and organic adoption rate (in the non-mandated Treatment arm)?

## 2. Primary Endpoint (Pre-Registered)

Every trial receives a single binary primary outcome:

```text
solved = ¬infraFailure
       ∧ oraclePass
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
- **Outcome of one run of the agent's tests (`bench/classify.mjs`).** A failed test is classified by the type of the error it threw, never by text inside the message. The type is the error's `name` as Vitest holds it. The harness reads it through a reporter of its own (`bench/failure-reporter.mjs`), together with the `name` of every `cause` behind the error, and not from what Vitest prints (D-19):
  - `true_red`: at least one test failed on an `AssertionError` (Vitest/chai `expect`, `node:assert`). This includes a failed `expect(p).rejects`, `expect(p).resolves` and `expect.poll`.
  - `timeout`: no assertion failed and a test or hook timed out.
  - `loud_break`: neither of the above, and the library raised an error (all its messages start with `[execution-points]`; its check after each test that a replacement ran is one of them), the module graph did not load (import, transform, or syntax error), the runtime guard refused something, or no test ran.
  - `error`: only other thrown errors, for example `TypeError: x is not a function`, an `ENOENT` that escaped the code under test, or an unhandled error outside any test (Vitest then exits non-zero although every test passed).
  - `passed`: every test passed, at least one ran, and Vitest exited 0.
- **Two gradings are not decided.** They were put to the maintainer on 2026-11-24. Until they are decided, each is graded as it was, by one rule in `UNDECIDED_GRADINGS` (`bench/classify.mjs`), and `--self-test` states that grading with cases of its own:
  - An error of the library that has an `AssertionError` among its causes is a `loud_break`. An assertion that fails inside `order.run(...)` of `interleavings` arrives this way, as an `InterleavingFailure`; the same assertion after `order.run(...)` is `true_red`.
  - A failed expectation that Vitest throws as a plain `Error` is an `error`: `expect.assertions(n)`, `expect.hasAssertions()`, and a snapshot that does not match.

  For every variant that is not a pass, the row records the kind, the name and the causes of up to four errors (`errors`), so the effect of either decision can be counted from rows graded by v2.5.
- **Repeated runs (D-15).** Every variant the agent's tests are graded against runs `--grade-repeats` times (default 3). The runs must agree; if they do not, the variant's outcome is **`unstable`**. `unstable` is never a pass, never a reproduction, and is reported on its own.
- **`agentTestsPass`:** Agent's own test suite is `passed` in every repeated run under pristine `vitest.config.mjs` / `package.json` (5,000 ms test timeout).
- **`adequateReproduction` (P1.2, D-14 symmetric two-sided, D-15, D-16):** Inside a fresh pristine sandbox with explicit `--config` and runtime guards (1,500 ms test timeout), the agent's test suite must (1) be `true_red` in every run on the pristine buggy baseline AND on every single-bug mutant for that task, (2) be `passed` in every run on **at least one** independent calibrated valid fix in `VALID_FIX_VARIANTS` (`passesAtLeastOneValidFix`, defeating `E-06` fingerprint cheats without penalizing valid alternative designs such as `DS-queue-design`, `CC-serial-stage`, or `T6-late-delete`), and (3) be `passed` in every run on the agent's own fix. Each row also records `reproduction`: `adequate`, `inadequate`, or `unstable` (some of the observed runs satisfy these gates and others do not, so grading each variant once could have gone either way). Only `adequate` counts.
- **Real-filesystem tasks (D-09).** For `cancel-commit`, grading sandboxes run the path-based `node:fs/promises` functions through `bench/deterministic-io.setup.mjs`: each call takes effect on the real disk and settles after exactly one event-loop turn, in call order. Without this, a test that orders two operations with `settle()` gets a result that depends on how fast the disk is. Agents' own workspaces keep the real asynchronous functions.
- **`typecheckPass` / `contractTypecheckPass`:** Equal production-only `tsc --noEmit` across both arms, plus full workspace `tsc --noEmit` (Control) / `tsc --noEmit --runExternalCode` (Treatment). The Treatment check also compiles the library's generated registry, so it can reject a fix that Control accepts. `--self-test` step 9 typechecks every reference fix, valid fix, mutant, and refactor in both arms; a paid run must not start while that step is red.
- **`cleanProduction`:** Full-tree TypeScript 7.1 AST audit confirms zero extra exports (including `export namespace`/`enum`/destructuring), zero missing exports, zero unverified re-exports, zero parameter-count changes, zero production global hooks, and all required async I/O helpers remain async and called (also verified at runtime by minimum cold-yield counts in the hidden oracles).
- **`noGlobalMonkeyPatch` & `noRealSleeps`:** Enforced at BOTH runtime (non-configurable global/prototype-chain traps and real-sleep detectors in `bench/runtime-guard.setup.mjs`) and AST level across all agent-written test and support files, including `D-12` forbidding `node:async_hooks` / `node:worker_threads` runtime-internal interception in tests.

Both guides (`bench/guides/`) tell the agent that a reproduction must fail on an assertion and that grading repeats every check. The Treatment guide is the Control guide plus one section on the library; `--self-test` step 13 enforces that, and that neither guide names a module or function of a task.

## 3. Secondary Endpoints (Pre-Registered)

All of these are printed by `bench/analyze.mjs`.

1. Each component of `solved` reported individually per arm (`oraclePass`, `visibleTestsPass`, `agentTestsPass`, `redReproducesBug`, all mutants detected, `passesAtLeastOneValidFix`, `refFixPass`, `adequateReproduction`, `typecheckPass`, `contractTypecheckPass`, `cleanProduction`, `noGlobalMonkeyPatch`, `noRealSleeps`), plus `unstable` reproductions, `ungradable`, `infraFailure`, `aborted`, and `tamperedConfigs`. `tamperedConfigs` is reported and does not enter `solved`: grading never uses the agent's config files.
2. **Adoption & technique:** Organic use of `execution-points`, `module-mock`, `fake-timers`, `deferred-only`, or `global-patch`. A trial's tests use `execution-points` when they import `select` from the package, call it, and put a selected point to use by any operation the library has: `withReplacement`, `replace`, `returns`, `throws`, `resolves`, `rejects`, `pause`, or handing the point to `interleavings` (D-18). The technique is the one value `execution-points` whichever operation it is; `libraryOperations` records which, and the analyzer prints the number of trials per operation. `solved` is also printed split by whether the block's Treatment trial used the library, next to the intention-to-treat result. Adoption happens after randomization, so this split is descriptive.
3. **E9 Regression-test robustness**, over `adequateReproduction === true` rows, with the same counts for both arms, per arm and split by whether the Treatment trial used the library:
   - **Buggy refactors:** still red (`true_red`), **stopped testing** (loud break + timeout + other error + unstable, each also shown on its own), and **false green** (the test passed on still-buggy code).
   - **Valid fixes:** green, and **not green** for any reason (assertion, timeout, loud break, other error, unstable, each also shown on its own). The false-red rate is not-green over total. A missing interception point is a selector break in a library test and a timeout in a `vi.mock` test; both count.
4. **Telemetry & economics:** `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `aiCredits`, `estimatedUsd`, `usageMissing`, credits, USD and tokens per solved trial, wall-clock duration, and `firstRedBeforeFirstSourceEdit` (parsing all paths in `apply_patch`).

## 4. Intention-to-Treat, Exclusions, and Stopping Rule

- **Intention-to-treat (ITT):** Every started trial (including `SIGINT`/`SIGTERM`-aborted trials) is appended to `results.jsonl` and included in the primary denominator. Timeouts, credit-cap stops, agent crashes, missing files, and protocol violations count as `solved = false` and are **never dropped**.
- **Infrastructure exclusions (`ungradable`):** Trials that throw a harness/grader exception are flagged `ungradable: true`, stay in the ITT denominator as unsolved, and are left out of a secondary per-protocol sensitivity analysis printed next to the ITT primary result. Such a row carries the same provenance fields as a graded row; the analyzer also accepts older exception rows that lack them and says so.
- **Pairing:** Blocks are keyed on `runId × taskId × requested model × reasoning × promptStyle × trialIndex`. The requested model is used because the served model name is an outcome of the run and is null on aborted rows. The analyzer prints a WARNING for every row whose block lacks the other arm and for every row served by a different model than requested.
- **Provenance & non-pooling:** Every row records `runId`, `gitCommit`, `gitDirty`, `copilotVersion`, `graderChecksum`, `harnessSha256`, `calibrationSha256`, `lockfileSha256`, `toolSha256`, `tasksSha256`, `vitestVersion`, and `typescriptVersion`. `bench/analyze.mjs` refuses to pool rows that differ in any of them, rows from a dirty tree, graded rows that lack a field, and rows graded by different checkouts. Each exception has to be allowed by name: `--allow-mixed=gitCommit,graderChecksum` (other names: `dirty`, `missing`, `duplicates`, `regrade`). There is no switch that allows everything.
- **Duplicates:** Rows are deduplicated by `(runId, trialId)`. Byte-identical duplicates are skipped with a count. Duplicates that differ are a conflict and are refused; with `--allow-mixed=duplicates` the later row wins and every such row is named.
- **Re-grading (`--regrade <runDir> [--only <trialIds>] [--out <dir>]`):** A re-graded row keeps the original trial's provenance in the fields above and records the re-grading checkout under `regradedWith`. A re-grading is a re-analysis: it never replaces the stored `results.jsonl` as the record of a run. It runs the stored tests with the library of the re-grading checkout. When `regradedWith.toolSha256` differs from the row's `toolSha256`, a changed verdict can come from the library and not from the harness: since 2026-11-24 a replacement that never runs fails the test, and a stored test may hold one that is not meant to run.
- **Blocking & randomization:** Within each `(task, model, reasoning, trialIndex)` block, the order in which the arms start is randomized via a seeded PRNG (`--seed`). This only has an effect at `--concurrency 1`. At the default `--concurrency 2` both arms of a block start together, which is how all three stored runs ran.
- **Two-phase execution & Phase-1 cleanup:** By default (`--phase-split`), Phase 1 snapshots each workspace immediately upon completion and deletes `workspaceDir` before grading; Phase 2 grades serially in fresh sandboxes off the agents' CPUs.
- **Budget:** Before anything starts the harness prints the projected credit need (observed mean credits per trial for each `model:reasoning` in the stored runs, times 1.2, plus the preflight; `--credits-per-trial` overrides the estimate and is required for a model with no observation). A matrix whose projection exceeds `--max-total-credits` (default 300) is refused before the preflight. The cap is still checked at block boundaries as a backstop, writing `not_started` rows for whole blocks.
- **Temp directories of concurrent bench processes:** Everything a run, a re-grade, or a self-test creates lives under one temp root that records the owning process. `--sweep-stale` removes only roots whose owning process no longer exists; it leaves roots of running processes and directories without an owner record alone. Toolchain preparation refuses a `node_modules` that is a symbolic link, because stripping its copies would delete packages from the checkout the link points to.
- **The library a Treatment workspace gets:** the package as it ships (`package.json`, what its `files` lists, with `dist/` built from the sources of the checkout) and a link in `node_modules/.bin` for each command in its `bin`, as an install creates it, so the command the guide prints (`npx execution-points list <file>`) resolves without a network. The build goes into the toolchain's temp root. No bench process writes the checkout's `dist/`, which a type check or a gap check may be reading; `--self-test` step 1 checks that it is left as it was.
- **Stopping rule:** Choose the exact matrix (`--run --tasks ... --models ... --max-total-credits ...`) before launching a paid run and run it to completion; never stop early based on intermediate p-values.

## 5. Power & Analysis Plan

- **Sample size guidance (`N-29`):** Exact two-sided McNemar power at α = 0.05 depends on the discordance (share of matched blocks where exactly one arm solves) and on how the discordant blocks split. Computed by `exactMcNemarPower` / `blocksForPower` in `bench/stats.mjs`:

  | Assumed truth | Blocks for 80% power | Power at the blocks actually run |
  | --- | --- | --- |
  | Best case: 10% discordant, Treatment wins 100% of them | 78 | 0.055 at 28 |
  | 10% discordant, split 90/10 | 125 | |
  | 10% discordant, split 80/20 | 231 | |
  | Observed in the last stored matrix: 5 of 28 primary blocks discordant, split 3:2 | 1,144 | 0.016 at 28 |
  | Observed over all stored primary blocks: 6 of 49 discordant, split 4:2 | 610 | 0.046 at 49 |

  The first three rows assume a discordance and a direction that the stored runs did not show; they are a best case, not a plan. The last two rows assume the true discordance and split equal the observed ones, which are estimates from five and six discordant pairs, so they are an order of magnitude. The minimum one-sided result for p < 0.05 is 6/0 (`p = 0.031`). `bench/analyze.mjs` prints the observed-discordance figures for its input. Allocate matrix budget where discordance occurs.
- **Primary analysis (equal-capability Strata B + C ONLY):** Stratified Cochran–Mantel–Haenszel (CMH) test and exact two-sided McNemar binomial p-value (`bench/analyze.mjs`), over the blocks defined in section 4, plus a Newcombe (1998) paired-difference 95% CI. The interval is Newcombe's Method 10: Wilson score limits without continuity correction, combined with a continuity-corrected estimate of the correlation between arms (the formula is in `matchedRiskDifferenceCI`). For small N, exact McNemar decides and the interval is descriptive. Stratum A (`closed-module`) is reported separately as a capability stratum and is **not** pooled into the primary test.
- **Secondary analysis:** Separate CMH / McNemar and approximate Wilson 95% CIs per stratum and per `promptStyle`, full **gate-sensitivity table** (`official`, `noValidFixGate`, `anyValidFix`, `allValidFixes`, `oracleOnly`), a sensitivity line that counts `unstable` reproductions as adequate (an upper bound), E9 robustness restricted to `adequateReproduction === true` rows, and **paired per-trial ITT billed `aiCredits` difference (`T − C`)** with bootstrap 95% CI as primary cost metric (`estimatedUsd` labeled as list-price estimate; cost per solved task shown only alongside gate sensitivity). Technique and adoption subgroups are descriptive uptake metrics, never causal arm comparisons.

## 6. Pre-Registered Maintainer Decisions (`D-01`–`D-17`)

`D-01`–`D-14` are effective from v2.3. `D-15`–`D-17` and the extension of `D-09` are effective from v2.4 and follow the maintainer's decision of 2026-11-24 to fix the benchmark findings in `FINDINGS.md`. They apply to future runs.

- **D-01:** Primary test runs over equal-capability Strata B + C only; Stratum A (`closed-module`) is reported separately.
- **D-02:** Every replicate block carries its own `runId + trialIndex` in its block key, keeping 1:1 pairing so exact two-sided McNemar remains defined with replicates.
- **D-03:** Warm-cache hits are judged by 0 I/O helper yields (`matchSite`), not 0 total `await`s; per-key serialization queues are valid.
- **D-04:** Real-time sleeps (`setTimeout` with nonzero delay outside active `vi.useFakeTimers()`) are forbidden; `setImmediate` `settle()` turns are allowed.
- **D-05:** In `double-submit`, both shared-failure (all concurrent joiners receive the failure, 0 charges until retry) and per-key queued retry (first fails, queued waiter retries and charges at most once with identical receipt across N ≥ 3 callers) are valid; documented in both prompts and enforced design-neutrally in the hidden oracle.
- **D-06:** Reading outside the workspace or accessing network/GitHub from tests is forbidden and blocked at OS level via hardened `--sandbox`.
- **D-07:** In Strata B + C, `execution-points` is optional (guided availability via `TESTING_GUIDE.md`); adoption is recorded as a descriptive secondary outcome.
- **D-08:** E9 robustness is computed over `adequateReproduction === true` rows only, per stratum.
- **D-09:** Real-fs tasks (`cancel-commit`) settle leaf disk I/O deterministically. In the hidden oracle, the engine tracks leaf `fs.*` I/O (`activeLeafIo`) so leaf disk calls finish before every scheduler pick. **From v2.4**, the sandboxes that run the agent's own tests do the same through `bench/deterministic-io.setup.mjs` (section 2). Not covered: `FileHandle`s, directory handles, streams, and the callback API of `node:fs`; a test that depends on those can still differ between runs and is then `unstable`.
- **D-10 / D-14:** `adequateReproduction` requires passing **at least one** calibrated valid fix in `VALID_FIX_VARIANTS` (`passesAtLeastOneValidFix`), where every task has ≥ 2 design-diverse valid fixes (`G-4`). Full cross-design pass rates and the reasons for not passing are reported side-by-side in E9 and the gate-sensitivity table.
- **D-11:** `--max-ai-credits` is omitted by default so the CLI does not inject live cost-meter hints into tool results; budget caps are enforced in the harness (`--max-total-credits`, section 4).
- **D-12 (effective v2.3, future runs only):** Intercepting Node runtime internals (`node:async_hooks`, `node:worker_threads`) in tests to step libuv handles is forbidden and blocked by `ast-audit.mjs`. Not applied retroactively to the stored `c70758a` 58-trial pilot.
- **D-13 (effective v2.3):** In `token-session`, concurrent `getActiveToken(userId)` calls within one active session must converge on one token; whether `logout` deletes at start or completion is implementation-defined (both `T3-ref` and `T6-late-delete` are in `VALID_FIX_VARIANTS`).
- **D-15 (effective v2.4):** Every graded variant runs `--grade-repeats` times (default 3) and the runs must agree. Disagreement is `unstable`, which no gate accepts and which is reported separately.
- **D-16 (effective v2.4):** Only an `AssertionError` is a reproduction (section 2). An error that escaped the code under test, a library error, and a timeout are different outcomes. Both guides state this.
- **D-17 (effective v2.4):** E9 counts are the same for both arms. On a valid fix every outcome other than green enters the false-red rate; on a buggy refactor loud breaks, timeouts, other errors and unstable results are reported together as "stopped testing" and individually.
- **D-18 (effective v2.5):** A trial's tests use the library when they import `select` from the package, call it, and put a selected point to use by `withReplacement`, `replace`, `returns`, `throws`, `resolves`, `rejects`, `pause`, or `interleavings`; the row records which in `libraryOperations` (section 3). Reason: up to v2.4 adoption meant `select()` plus `withReplacement()`. On 2026-11-24 the library gained the other operations and the Treatment guide's recipe became `pause()`, so a test written as the guide teaches was counted as plain Vitest; the harness's own witness came out as `deferred-only`. The split by adoption and every count "by technique" would have been wrong for a run with that guide. The list is read off `Point` in the library's declarations, and `--self-test` fails when the declarations a Treatment workspace gets name a member the auditor does not know. Limits: the audit is syntactic. It follows a point by name within the test files (a variable, a parameter of a local function, a list or object of points, an export that another test file imports) and not through a class field, a `Map`, or a function it cannot see; `withReplacement` is counted on any receiver. Rows written before v2.5 have no `libraryOperations`; under their definition every adopting trial used `withReplacement`.
- **D-19 (effective v2.5):** The type of an error (D-16) is its `name` as Vitest holds it, read through `bench/failure-reporter.mjs` with the names of its causes. Reason: v2.4 read the type from the first line of the stack that Vitest prints, and for a failed `expect(p).rejects`, `expect(p).resolves`, `expect(p).rejects.toThrow(message)` and `expect.poll` that line says `Error:` although the error is an `AssertionError`. v2.4 graded those reproductions as `error`, in both arms. A run whose failure report is missing or names other failures than Vitest's JSON report is not graded from text: the trial becomes `ungradable`.
- **Provenance (`V-07`):** see section 4. Host sleep detected during grading marks `hostSleepDetected=true`, `infraFailure=true`, `ungradable=true`.

## 7. The Stored Runs

The three stored runs (`~/.ep-bench-results/v2-2026-11-23T17-51-32-082Z`, `...T18-59-46-092Z`, `v2-2026-11-24T09-15-06-057Z`) remain the record of what was measured. For them:

- Each variant was graded once, so `unstable` could not be observed. On `cancel-commit` the stored verdict on the `CC-M1-shared-stage-file` mutant depended on disk timing.
- A failure that was neither a timeout nor matched by a text pattern counted as `true_red`, whatever its type.
- Their E9 false-red rate counted assertion failures and timeouts and left out selector breaks; `loudBreakCount` on refactors included timeouts. `bench/analyze.mjs` recomputes both from the per-variant results, which those rows carry.
- The Newcombe interval printed for them used the uncorrected correlation estimate (Newcombe's Method 8). The analyzer prints both intervals.

- Adoption meant `select()` plus `withReplacement()`, which is all the library had (D-18).
- They ran with the library as it was then. A re-grade runs their tests with the library of the re-grading checkout (section 4).

`bench/analyze.mjs` reads these rows unchanged and reproduces their `solved` counts. Re-grading them with the current harness is a re-analysis and is labeled as such wherever it is reported.
