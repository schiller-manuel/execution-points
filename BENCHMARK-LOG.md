# Benchmark Evolution Log (`execution-points`)

This log chronicles how we designed, stress-tested, broke, and rebuilt the A/B benchmark testing whether `execution-points` helps coding agents debug, deterministically reproduce, and fix hard asynchronous concurrency bugs. Every flaw we found—and how we closed it—is preserved here as primary source material for a future write-up.

---

## v0 — Initial Prototype Harness & 6-Trial Pilot (`b15b8ce`, 2026-11-23)

### Setup
- **Tasks (2):**
  1. `stale-cache` (`src/profile-store.ts`, 65 lines): read-vs-update cache poisoning + out-of-order concurrent updates.
  2. `token-session` (`src/session-manager.ts`, 56 lines): mid-flight logout session resurrection + logout/re-login token overwrite.
- **Structure:** Both tasks were closed single-file modules with 5 private async helpers (`await Promise.resolve()`), no DI seams, and prompts forbidding exporting helpers or adding test hooks.
- **Runner (`bench/run.mjs`):** Spawns GitHub Copilot CLI (`copilot -p`) inside temp directories with symlinked `node_modules`, comparing `control` (plain Vitest) vs. `treatment` (`execution-points` pre-configured + `EXECUTION_POINTS_GUIDE.md`).
- **Hidden graders:** `@tanstack/oracles` + `scheduleFrom(choices)` + `execution-points` (`select()` on the 5 helper names).

### What the v0 Smoke Runs Caught Immediately
1. **The `pnpm` v12 auto-prune trap:** During our first 2-trial smoke run, `pnpm test` inside a temp workspace silently pruned `vitest` from `node_modules` because the temp `package.json` omitted `devDependencies`. Switching to `npm test` / `npm run check` and declaring `devDependencies` fixed it.
2. **Our own reference fix had a concurrency bug:** On the first `--self-test`, our hidden `scheduleFrom` oracle caught a real bug in our own `stale-cache` reference fix (`validateName` was awaited *before* enrolling into the per-key update queue, allowing an out-of-order `validateName` to invert update ordering).
3. **30 AI credits was too tight:** Both smoke trials hit `--max-ai-credits 30` around turn 5–7. Even there, Treatment had already written 3 clean deterministic RED tests (10/10) while Control was still stuck at 0/10 trying to figure out how to pause private functions.

### 6-Trial Pilot Results (`stale-cache`, `medium` reasoning, 150-credit cap)

| Arm | Model | RED (10×) | Global Patch? | Hidden Oracle | Design Clean | Turns | Wall (s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `control` | `gpt-6.2-astra` | 10/10 | **YES** (`Promise.resolve`) | PASS | YES | 7 | 53.9 |
| `control` | `claude-opus-5.5` | 10/10 | **YES** (`Promise.resolve`) | PASS | YES | 10 | 77.3 |
| `control` | `gemini-4-neon` | 10/10 | **YES** (`Promise.resolve`) | PASS | YES | 7 | 230.8 |
| `treatment` | `gpt-6.2-astra` | 10/10 | **no** | PASS | YES | 11 | 68.1 |
| `treatment` | `claude-opus-5.5` | 10/10 | **no** | PASS | YES | 10 | 94.7 |
| `treatment` | `gemini-4-neon` | 10/10 | **no** | PASS | YES | 8 | 150.0 |

### Accidental Backdoor Discovery
Inspecting the 6 generated test files revealed why 3/3 Control trials passed `RED (10×)`:
- Our toy fixtures simulated async I/O with `await Promise.resolve()`.
- Every single Control model (`gpt-6.2-astra`, `claude-opus-5.5`, `gemini-4-neon`) exploited that by monkey-patching **`vi.spyOn(Promise, 'resolve')`**—an accidental global backdoor that does not exist in real production code (filesystems, SQLite/Postgres drivers, sockets, `MessageChannel`, timers).
- Meanwhile, `gpt-6.2-astra` in the Treatment arm used `select()` not only to pause `validateName`, but also to intercept `cache.get` and verify the private backing store directly without exporting `db`.

---

## v1 — Independent Critical Review (`Benchmark critical review` session, 2026-11-23)

Before trusting or scaling v0, we spawned an independent `claude-opus-5.5` (`max` reasoning) reviewer to audit `bench/` with runnable probes (`E1`–`E10`, 17 hand-built fix variants run 30× each). Its verdict was blunt: **v0 could not produce scientifically valid A/B evidence**, for four independent reasons:

1. **Construct validity & fixture bias (`E1`):** Scanning all microtask start offsets ($k = 0..40$) showed plain Vitest could reach only 1 of the 4 bugs without patching globals. Because closed-module `await Promise.resolve()` was the *only* fixture stratum, the 3/3 Control global-spy split was forced by the fixture design rather than measuring `execution-points`.
2. **Prompt leakage & asymmetric guidance:** Both `PROMPT.md` files explicitly narrated the exact racing interleavings (measuring implementation rather than debugging/diagnosis). Treatment was mandated to use `select()` + `withReplacement()` and got a 50-line guide; Control got one sentence.
3. **Grader false positives AND false negatives (`E2`–`E5`, `E10`):**
   - **False positives (30/30 PASS on broken fixes):**
     - `V4` (cache guarded, DB unguarded — left DB stale in 280/560 interleavings): passed because the grader never inspected the backing store.
     - `T5` (module-wide epoch across all users — denied tokens to unrelated logged-in users): passed because the grader only tested one user.
     - `V8` (swallowed empty-name validation error): passed because pristine visible tests were never re-run.
     - `V6` (deleted caching completely): passed because cache effectiveness wasn't asserted.
     - **Residual bug in our own reference fix `V1` (`E4`):** `V1` bumped `versions` *before* `await writeToDb`, leaving a window where a staggered cold read could start after the bump, read old `'Alice'` from DB, and cache `'Alice'` after `updateProfile` finished. Adding a second version bump after `writeToDb` (`V9`) closes it, yet the v0 grader gave `V1` and `V9` the same 30/30 because all operations started at $t = 0$ and effects ran eagerly at call time (`scheduler.schedule(original())`).
   - **False negatives (30/30 FAIL on valid fixes):**
     - `V5`, `T4` (valid fixes with a second call site of a helper): failed with `select()` `"matched 2"`.
     - `V7` (valid fix moving the per-key queue to `src/keyed-queue.ts`): failed because only `targetRel` was copied into the grader.
     - `T2a`, `T2b` (valid token-session fixes that return `null` early if the session changed before `verifyTokenPolicy`): failed an unstated `usedAllRequiredHelpers` grader rule.
     - **Treatment bias:** Treatment agents naturally avoid these rejected shapes because their own `select()` tests break on them too—biasing `oraclePass` toward Treatment!
   - **Dead constructed histories (`E3`):** 3 of 5 constructed schedules didn't even fail on the buggy code (`poison-cache-after-update`, `resurrect-after-logout`, `stale-fetch-overwrites-relogin`).
4. **Isolation, crash safety & audit flaws (`E6`–`E8`):**
   - Symlinking `REPO_ROOT/node_modules/*` leaked `REPO_ROOT` (making `bench/graders/` and `REFERENCE_FIXES` readable) and exposed a writable shared `node_modules` used by the grader binaries.
   - `gradeDeterministicRed` counted import errors, `"matched 0"` selection errors, and timeouts as RED (`E6`).
   - Regex audits (`usesSleep`, `usesGlobalPatch`, `auditProductionDiff`) had both false positives (flagging `// no setTimeout()` comments and fake timers) and false negatives (missing `export { readFromDb }`, `Promise.prototype.then = ...`, `Object.defineProperty`, `vi.stubGlobal`, `node:timers/promises`).
   - CLI ran with user `~/.copilot` state, auto-update enabled, no `--usage-output-file` token/cost capture, and a single missing file crashed the entire run before writing `results.json`.

### Key Discovery: Refactor Robustness (`E9`)
The reviewer probed regression-test durability under 4 behavior-preserving refactors of the buggy code (`+1 await`, `setImmediate` I/O, renamed helper, second helper call site):
- **`select()`-based Treatment tests:** **0/4 false greens** (still caught the bug on 2, failed loudly with `"matched 0"` / `"matched 2"` on the other 2).
- **Both Control `Promise.resolve` spy variants:** **2/4 false greens** (silently passed on still-buggy code!).

This is a concrete, high-value engineering property that v0 never measured.

---

## v2 — Redesigned Benchmark Architecture (P0 + P1 + P2 Complete, 2026-11-23)

We rebuilt `bench/` to address every **P0, P1, and P2** finding from the critical review (`bench-critical-review.md`) plus full token/cost tracking and anti-monkey-patching enforcement:

1. **Tool-independent lazy-yield grader engine (`bench/graders/yield-engine.mjs`, `bench/graders/yield-plugin.mjs`):**
   - Replaces `execution-points` inside the grader with a standalone TypeScript 7.1 AST + `MagicString` Vite transform that rewrites every `await expr` across **all** non-test files under `src/` to `await __benchYield(siteId, async () => (expr))`.
   - **Lazy effects + staggered starts + cross-queue mutex awareness:** Operands execute only when released by the scheduler, operations can spawn at staggered steps (exposing `V1`'s residual stale-cache race while passing `V9`), and `settleRunnable()` waits on real I/O (`MessageChannel`, `node:fs/promises`, timers) only when no queue is parked—preventing false deadlocks on cross-queue locks/queues.
   - **Full contract coverage:** Checks backing store AND cache (`V4`), verifies warm-cache reads do 0 async yields (`V6`), runs multi-key / multi-user histories (`T5`), runs pristine visible tests (`V8`), copies all of `src/` (`V7`), allows early-abort fixes (`T2a`/`T2b`), and handles duplicate call sites (`V5`/`T4`).
   - **43-variant calibration corpus in `--self-test` (`bench/calibration/variants.mjs`, `bench/calibration/p2-variants.mjs`):** Verifies 43/43 exact expected verdicts across all 10 tasks (`V0`–`V9`, `T0`–`T5`, `T1b`, `SCS`, `SF`, `CC`, `DS`, `DB`, `RS`, `EO`, `CM`) before any paid run.
2. **Eliminating the `Promise.resolve` backdoor + 10 tasks across 3 testability strata (P2.1):**
   - Replaced `await Promise.resolve()` with `MessageChannel` macrotask ticks in closed modules, separate mockable I/O modules in seam tasks, and real `node:fs/promises` + `AbortController` + `setTimeout` timers in real-async tasks.
   - **Stratum A (`closed-module`, 3 tasks):** `stale-cache`, `token-session`, `double-submit`.
   - **Stratum B (`io-seam`, 5 tasks):** `stale-cache-seam`, `single-flight`, `retry-storm`, `event-order`, `cross-module-transfer`.
   - **Stratum C (`real-async`, 2 tasks):** `cancel-commit` (`node:fs/promises` + `AbortController`), `debounce-search` (real timers + async search).
3. **Fair, neutral prompts & symmetric guidance (`bench/guides/`):**
   - **Symptom-only default** (`--prompt-style symptom|described`) so diagnosis is genuinely measured.
   - **Explicit ban on global monkey-patching** in both arms, verified by TypeScript 7.1 AST inspection (`bench/ast-audit.mjs`), NOT regexes.
   - **Voluntary adoption:** Neither arm mandates `execution-points`; both receive equal-length `TESTING_GUIDE.md` files (with honest tradeoffs), and organic adoption is recorded as a secondary outcome.
   - **Equal production `tsc --noEmit`** across both arms, with Treatment's virtual `.ep` contract check (`tsc --noEmit --runExternalCode` with `"contentMappers": [{ "package": "execution-points-prototype", "extensions": [".ep"] }]`) verified separately.
4. **Adequate RED (P1.2) + Full E9 Refactor-Robustness (P1.3):**
   - Vitest JSON reporter separates genuine `AssertionError` failures (`true_red`) from import/selection errors (`loud_break`) and Vitest timeouts (`timeout` — NEVER counted as `true_red`!).
   - Copies all agent-created test & helper files into the evaluation sandbox and requires genuine `true_red` assertion failures on BOTH the buggy baseline AND every single-bug mutant (`SINGLE_BUG_MUTANTS`) for `adequateReproduction`.
   - Measures BOTH **false-green rate** (against behavior-preserving buggy refactors) AND **false-red assertion rate** (against valid alternative fixes `VALID_FIX_VARIANTS`), keeping loud selection/compile breaks separate from silent failures.
5. **Hermetic isolation, two-phase execution, token/USD telemetry & statistical analysis (`bench/toolchain.mjs`, `bench/pricing.mjs`, `bench/stats.mjs`, `bench/analyze.mjs`, `bench/PROTOCOL.md`):**
   - Outside-repo APFS CoW (`cp -cR`) stripped toolchains with zero symlinks into `REPO_ROOT`, plus SHA-256 grader checksum verification before every grade.
   - Fresh `COPILOT_HOME` per trial, `COPILOT_AUTO_UPDATE=false`, `--no-auto-update`, `--dynamic-retrieval skills=off`, `--usage-output-file <path>`, detached process-group SIGTERM → SIGKILL cleanup, blocked randomized arm ordering, and crash-safe append-only `results.jsonl`.
   - **Two-phase execution (`--phase-split`, default `true`):** Phase 1 runs all Copilot CLI trials; Phase 2 grades serially off the agents' CPUs.
   - Pre-registered protocol (`bench/PROTOCOL.md`) and intention-to-treat analyzer (`bench/analyze.mjs`) with Wilson 95% CIs, stratified Cochran–Mantel–Haenszel (CMH) test, matched-block bootstrap risk difference, and tokens/USD per solved task.

### Discoveries Caught During v2 Self-Test & Live Smoke Runs

1. **macOS `/var` → `/private/var` symlink in Vite plugin:** `os.tmpdir()` returns `/var/folders/...` while Vite passes `/private/var/folders/...` to `transform(code, id)`. Our 25-variant calibration corpus caught immediately that `benchYieldPlugin` wasn't firing until both `root` and `id` were normalized with `realpathSync()`.
2. **Real `execution-points` bug uncovered by Stratum C (`debounce-search`) — and fixed oracle-first:** When `src/search-controller.ts` called `setTimeout(...)`, `src/contracts.mjs` emitted bare `Timeout` instead of `NodeJS.Timeout` in virtual `points.ep` declarations (`TS2304: Cannot find name 'Timeout'`), because `resolveExternal()` returned `resolved.name` without walking enclosing ambient `ModuleDeclaration` namespaces (`NodeJS`). Added `qualifyAmbientName(sym)` in `src/contracts.mjs` with two RED-first oracle histories in `tests/contracts.oracle.property.test.ts` (0 gaps in `qualifyAmbientName` via `oracle-gaps`), and re-enabled `src/search-controller.ts` in `debounce-search`.
3. **The `node:timers/promises` Control workaround & why `timeout != true_red` matters:**
   - In our first v2 4-trial live smoke run (`stale-cache` + `stale-cache-seam`, `gpt-6.2-astra:medium`, `symptom` prompt), global monkey-patching was banned and `await Promise.resolve()` was gone—so how did Control respond on closed-module `stale-cache`?
   - `gpt-6.2-astra` in Control **rewrote production `yieldIo()`** from `MessageChannel` to `import { scheduler } from 'node:timers/promises'` and mocked `node:timers/promises` with `vi.mock()`!
   - On the unmodified buggy baseline (`V0`)—which uses `MessageChannel` and never calls `scheduler.yield()`—that Control test **hung waiting for `barrier.hit` until Vitest's 5s timeout**!
   - In our first smoke run, our classifier mistakenly treated Vitest's `TestTimeoutError` as `true_red` (giving Control a bogus `solved=PASS`). Fixing `P1.1` to classify `TestTimeoutError` as `'timeout'` (never `'true_red'`) immediately exposed the cheat in a principled way: a regression test that only triggers because you injected a new dependency seam into production does **not** reproduce the bug on the unpatched code!
   - That same smoke run also caught two harness bugs: Treatment `tsconfig.json` was missing `"contentMappers"` (fixed and verified by `--self-test` step 3) and `auxAsyncChecks` passed `privateHelpers` instead of `requiredAsyncHelpers` for intentionally exported seam modules like `src/storage.ts` (fixed in `bench/ast-audit.mjs`).

---

## Run History

### 2026-11-23 — v2 Calibration Self-Test (`node bench/run.mjs --self-test`)
- **Toolchain isolation:** PASS (`grader sha256`, zero symlinks into `REPO_ROOT`, `@tanstack` & `fast-check` absent from trial workspaces).
- **AST auditor + aux seam check:** PASS (9/9 test-audit cases + `src/storage.ts` aux check).
- **Treatment virtual contract check (`select()` + `tsc --noEmit --runExternalCode`):** PASS.
- **Timeout != `true_red` check:** PASS.
- **Baseline workspaces (10 tasks × 2 arms):** 20/20 PASS.
- **Grader calibration corpus:** **43/43 PASS** (0 false positives, 0 false negatives across `V0`–`V9`, `T0`–`T5`, `T1b`, `SCS`, `SF`, `CC`, `DS`, `DB`, `RS`, `EO`, `CM`).
- **Reference fix AST audits:** 10/10 PASS.

### 2026-11-23 — v2-p2 Live Smoke Verification (`stale-cache`, `gpt-6.2-astra:medium`, `symptom`, `--phase-split`)
*Run ID: `v2-2026-11-23T11-51-39-236Z` (Copilot CLI 1.0.114, seed 42)*

| Arm | Solved | Oracle | Adq RED (Baseline + V2/V3) | No Global Patch | E9 FG / FR | Technique | Tokens | Est. USD | Wall (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `control` | **FAIL** | PASS | **NO** (`timeout` on V0/V2/V3) | YES | 0/3 / 0/3 | `module-mock` (`node:timers/promises` rewrite) | 150,942 | `$0.1296` | 83.0 |
| `treatment` | **PASS** | PASS | **YES** (3/3 genuine assertions) | YES | 0/3 / 0/3 | `execution-points` (`select()` + `withReplacement()`) | 211,659 | `$0.1514` | 60.3 |

*Takeaway:* With all P0 + P1 + P2 safeguards active, Treatment organically adopted `execution-points`, passed virtual contract checking (`tsc --noEmit --runExternalCode`), reproduced both bugs on untouched baseline and single-bug mutants with zero false greens, and finished 23s faster than Control—while Control's production-seam rewrite was caught by `timeout != true_red`. Note: this 2-trial run predated `d84f5b4` (`--testTimeout=1500`) and did not constitute an effect estimate.

---

## v2.1 — Adversarial Re-Review & Hardening (`c4c9e6f`, 2026-11-23)

After `d84f5b4`, we had the independent reviewer (`Benchmark critical review`, `claude-opus-5.5` `max`) probe v2 end-to-end (`bench-v2-re-review.md`). While the new `yield-engine` hidden oracles graded **60/60** variants accurately (including all 17 independently written v0 variants), adversarial probing exposed grading, isolation, and operational holes. In `c4c9e6f` we closed all 6 v2 cheats (`R-19`, `R-01`, `E-01`, `E-04`, `E-05`, `E-06`), 31/33 `A-01` AST evasions, `G-01`, `I-03` `.bin` shims, `OPS-01`, exact McNemar, and deduplication.

---

## v2.2 — Live Re-Review Blockers & OS Sandbox Hardening (2026-11-23)

A second probe-backed re-review of `c4c9e6f` (`bench-v2.1-re-review.md`) confirmed all 6 v2 cheats were blocked by their intended gates and `--self-test` passed 88/88, but live paid probes uncovered **critical blockers** that would have invalidated a pilot or matrix run:

1. **macOS `/var` vs `/private/var` write denial (`N-00`, P0):** `--allow-tool write(/var/folders/.../src/**)` didn't match Copilot CLI's resolved `/private/var/folders/...`, silently blocking all file edits in both arms on macOS. **Fixed:** `realpathSync()` on every temp/workspace path + mandatory live write/sandbox preflight before Trial 1 + `writeDenials` tracking.
2. **Oracle style-dependent false reds (`N-11`, `N-14`, `N-15`, `N-16`, `N-17`, P0):**
   - `yield-engine.mjs` previously deferred synchronous prefixes of awaited calls (`before:` park), rejecting valid `return await` fixes. Applied `eager2` (evaluate operand immediately, park resumption on both fulfillment and rejection, settle newly launched staged operations before next pick) + updated `debounce-search`/`retry-storm` schedules.
   - Four graders previously asserted `yields === 0` across ALL `await`s on warm hits, rejecting valid per-key serialization queues (which decided the v2.1 workaround pilot). `yield-plugin.mjs` now tags each site with `"relPath#fnName:offset"` and warm-cache checks count ONLY I/O helper yields (`matchSite`). Added `V9sw`, `V9ra`, `SCS2`, `SCS3`, `SF3` to calibration.
3. **OS-level sandboxing for `npm test` (`N-30`, P1):** CLI `--allow-tool` flags did not constrain arbitrary Node code executed inside `npm test` (which could read hidden graders, sibling workspaces, `$HOME`, or fetch via `gh api`). **Fixed:** pass `--sandbox` explicitly and configure hardened per-trial sandbox settings via `copilot config` (read-only node install, `sandbox.auth.gh/git=false`, `network.allowOutbound=false`, `blockedHosts=*`, `allowBypass=false`), write default results outside the repository (`~/.ep-bench-results/`), strip `.pnpm-workspace-state-v1.json` from the grader toolchain too, and hash the whole grader toolchain.
4. **Remaining anti-cheat & AST holes (`N-22`, `N-23`, `N-24`, `N-25`, `N-12`, P1/P2):**
   - `runtime-guard.setup.mjs` now walks and locks every link of protected prototype chains (including `NodeEventTarget.prototype`), wraps `Object.setPrototypeOf`/`Reflect.setPrototypeOf`/`__proto__`, protects `Error.stackTraceLimit`, and writes per-worker reports into `BENCH_GUARD_REPORT_DIR` (merged in the harness; fail-closed if missing).
   - Generated `vitest.config.mjs` pins exact `include: [task.testRel]` and `reporters: ['default']` (`N-31`), and `tsconfig.json` includes `.tsx`/`.mts`/`.cts`.
   - `ast-audit.mjs` resolves `Object.getPrototypeOf` chains, catches `setTimeout.call`/`(0, setTimeout)`/`expect.poll`/non-literal conditional `useFakeTimers`, models `beforeEach`/`afterEach` fake-timer hooks (`N-25`), and classifies `vi.spyOn(namespaceImport, ...)` as `module-mock` (`N-12`).
5. **`cancel-commit` overlapping starts & deterministic real-fs (`N-18`, `N-19`, `N-20`, P1):** Added overlapping `startJob` schedules catching `CC-M1`, added leaf-I/O tracking (`activeLeafIo` for `fs.*`/`yieldIo()`) so leaf disk I/O finishes deterministically before every scheduler pick, switched hidden oracle execution to Vitest JSON reporter, and required `--self-test` to verify the hidden oracle rejects every `SINGLE_BUG_MUTANT`.
6. **Telemetry, primary analysis, E9, and budget meter (`N-04`–`N-09`, `N-13`, `N-21`, `N-26`–`N-29`, `N-32`):**
   - Keyed `deniedToolCalls`, `writeDenials`, and `firstSourceEditAt` on `tool.execution_complete` (`success === true` / `error.code === 'denied'`); added `infraFailure` + consecutive-infra abort.
   - Restricted primary CMH / exact McNemar / uncorrected Newcombe paired RD to equal-capability Strata B + C (Stratum A reported separately), paired blocks by `trialIndex`, checked `--max-total-credits` at block boundaries (writing `not_started` rows), restricted E9 to `adequateReproduction === true` rows, made billed `aiCredits` the primary cost metric, omitted `--max-ai-credits` by default so CLI tool results don't inject live cost meters (`N-32`), and enforced full provenance-hash matching (including `calibrationSha256`, `lockfileSha256`, versions, and clean tree).

### 2026-11-23 — v2.2 Self-Test Verification (`node bench/run.mjs --self-test`)
- All 110 individual checks across sections 1–10 printed `PASS` (49/49 calibration variants, 16/16 single-bug mutants rejected by hidden oracle, 8/8 constructed cheats rejected, 3/3 legal witnesses passed).
- **Bug caught later in audit (`G-8`):** `const cheats` was scoped inside the `try` block, so after printing all 110 PASS lines the final log line threw `ReferenceError: cheats is not defined` and exited 1. Also note 5 uncommon sleep spellings still slipped both AST and runtime guard (none used in live runs). Fixed in v2.3.

### 2026-11-23 — v2.2 Multi-Model Pilot (22 Started Trials + 2 `not_started`, `afdd5a5`)
*Run ID: `576a8346-1e65-4f19-9fea-bc0b2e67b236` · Output: `/Users/caligano/.ep-bench-results/v2-2026-11-23T17-51-32-082Z` · Copilot CLI 1.0.114 · Hardened `--sandbox` · `--phase-split` · `--prompt-style symptom` · `--seed 42` · `--max-total-credits 1000`*

- **Live preflight (`N-00` + `N-30`):** PASS (`srcWritten=true`, `rootBlocked=true`, `17.8` credits).
- **Health:** Zero edit-tool write denials, zero global monkey-patching, zero out-of-workspace reads across all 22 started trials (`B12` cleanly marked `not_started` at block boundary after `1051.2/1000` credits). One `ungradable` row (`cancel-commit | control | gemini`) was traced via `pmset -g log` to macOS Clamshell Sleep on battery; re-graded cleanly at `c70758a`, it is `ungradable=false` and remains `solved=false` (missed `CC-M1`). Note `claude-opus-5.5` also hit refused shell-write attempts (tracked as `shellWriteDenials` starting in v2.3).
- **Hidden oracle pass rate:** 22/22 (100%).

### 2026-11-23 — v2.2 Remaining 6 Tasks & Full 10-Task Pooled Pilot (58 Started Trials / 29 Matched Blocks, `afdd5a5` + `c70758a`)
*Batch 2 Run ID: `2edc0402-1b2c-4a92-91f7-298c5a83382e` · Output: `/Users/caligano/.ep-bench-results/v2-2026-11-23T18-59-46-092Z` · 36 trials / 18 blocks (`retry-storm`, `event-order`, `cross-module-transfer`, `debounce-search`, `token-session`, `double-submit`) · `1,230.3` credits · Seed 43. Batch 1 ran at `afdd5a5` and Batch 2 at `c70758a` (the only diff between those commits is `BENCHMARK-LOG.md`); all 7 code/task/calibration hashes match.*

- **Batch 2 health:** Preflight PASS (`17.8` credits), `0/36` infra failures, `0/36` edit-tool write denials (`20` shell-write attempts by `claude-opus-5.5` were refused by shell policy), `0/36` global monkey-patching, `34/36` hidden oracle passes (both oracle failures were `claude-opus-5.5` Control & Treatment on `double-submit`, hitting the unstated `D-05` concurrent-joiner-failure law).

#### Pooled 10-Task Stored Results (58 Started Trials / 29 Matched Blocks, official `c70758a` rule)
*Per protocol discipline (`G-10`), the stored `c70758a` grading remains the primary record for this pool; no post-hoc `D-05` or `D-12` re-scoring is used for significance.*

| Stratum | Blocks | Control `solved` | Treatment `solved` | Guided EP Uptake (Trt) | E9 FG (adq) | Paired ITT Credits `T − C` |
| --- | --- | --- | --- | --- | --- | --- |
| **Stratum B (`io-seam`, 5 tasks)** | 15 | 15/15 (100.0%) | 15/15 (100.0%) | 10/15 (66.7%) | 0/30 vs. 0/30 | ceiling (0 discordant) |
| **Stratum C (`real-async`, 2 tasks)** | 6 | 4/6 (66.7%) | 5/6 (83.3%) | 2/6 (33.3%) | 0/8 vs. 0/10 | 1/0 discordant (`cancel-commit / gemini`) |
| **Primary (Strata B + C equal-capability)** | **21** | **19/21 (90.5%)** | **20/21 (95.2%)** | **12/21 (57.1%)** | **0/38 vs. 0/40** | **`+1.8 cr [-2.5, +6.0]`** · exact McNemar `p = 1.0`, Newcombe RD `+4.8pp [-9.3, +21.7]` |
| **Stratum A (`closed-module`, 3 tasks, separate)** | **8** | **3/8 (37.5%)** | **7/8 (87.5%)** | **8/8 (100.0%)** | **1/7 (14.3%) vs. 0/19 (0.0%)** | **`-8.8 cr [-28.0, +10.4]`** · exact McNemar `p = 0.125` (descriptive Newcombe `+50.0pp [+10.4, +73.0]`) |
| **All 29 matched blocks (pooled)** | **29** | **22/29 (75.9%)** | **27/29 (93.1%)** | **20/29 (69.0%)** | **1/45 vs. 0/59** | **`-1.2 cr [-6.8, +4.5]`** (`T` cheaper in 18/29 blocks) · official `5/0` (`p = 0.0625`) |

#### Gate Sensitivity & Honest Summary (from v2.2 Independent Audit)
The official `c70758a` gate checked every test against a **single** hardcoded reference fix (`refFixPass`), which penalized Control tests that pinned stricter semantics than our outlier `token-session` reference (`G-6`) and deadlocked both `claude-opus-5.5` `cancel-commit` tests on a renamed temp file (`G-1`), while ignoring Treatment selector breaks on non-reference valid fixes (`G-7`). Under alternative gates across the same 29 blocks:
- **Official (`c70758a` single-reference gate):** Control `22/29` vs. Treatment `27/29`, discordant `5/0`, exact McNemar `p = 0.0625`.
- **No reference gate (`RED + mutants + own fix + oracle`):** Control `25/29` vs. Treatment `28/29`, discordant **`3/0`**, exact McNemar `p = 0.25`.
- **All calibrated valid fixes (`strict E9`):** Control `22/29` vs. Treatment `23/29`, discordant **`2/1`**, exact McNemar `p = 1.0`.
- **Hidden oracle only (fix quality):** `28/29` in both arms (`p = 1.0`).
- **Summary supported by these 58 trials:** Both arms fixed the bug in 28/29 blocks by the stored hidden oracle at essentially identical per-trial cost (`T − C = -1.2 cr [-6.8, +4.5]`). On reproduction alone (baseline RED + every single-bug mutant), Control missed a seeded bug in 3 pairs where Treatment did not (`stale-cache/claude`, `token-session/gemini`, `cancel-commit/gemini`) and never the reverse (`3/0`, `p = 0.25`). No superiority claim is statistically significant yet; `io-seam` hit a 100% ceiling at `medium` reasoning, motivating harder strata and cheaper/lower-reasoning models (`gpt-6.2-sol`, `claude-haiku-5.5`) next.

---

## v2.3 — Pre-Matrix Audit Fixes (`G-1`, `G-2`, `G-4`–`G-11`, `D-05`/`D-12`–`D-14`, `V-01`–`V-07`, 2026-11-24)

Following the independent v2.2 audit (`bench-v2.2-audit.md`) and its addendum on `263a864`, we closed every remaining pre-matrix defect before launching the cheaper-model / varying-reasoning matrix:

1. **Strengthened `double-submit` oracle (`G-11`, `D-05`):** Upgraded failed-in-flight test to `N = 3` concurrent callers with failure injection in the `fast-check` property, asserting `charges <= 1` and identical receipts across all succeeding callers without choosing a design. Added `DS-BYPASS` (`expectPass: false`) to calibration and documented `D-05` in both prompts.
2. **Symmetric `D-14` adequacy gate + ≥2 design-diverse valid fixes per task (`G-1`, `G-4`, `G-6`, `G-7`, `N-10`, `D-13`):**
   - `adequateReproduction` now requires `passesAtLeastOneValidFix` (at least one calibrated valid fix in `VALID_FIX_VARIANTS`), defeating `E-06` fingerprint cheats without single-reference bias.
   - Aligned `TOKEN_SESSION_T3` and `T2b` with `D-13` (single token per active session), documented `D-13` in prompts, and added `T6-late-delete`.
   - Added design-diverse second valid fixes for all 5 previously single-fix tasks (`CC-serial-stage` keeping `j1.stage.tmp` for `G-1`, `DB-abort-design`, `RS-token-design`, `EO-watermark-design`, `CM-serial-design`), all verified in `--self-test`.
3. **Anti-cheat (`D-12` for future runs only):** `ast-audit.mjs` now blocks importing `node:async_hooks` / `node:worker_threads` in test files (effective v2.3 onward; never applied retroactively to the stored `c70758a` pilot).
4. **Operations, sleep detection & `--regrade` (`G-2`, `G-8`, `N-01`–`N-02`, `V-01`–`V-07`):**
   - Hoisted `cheatCount` outside `try` in `runSelfTest()` so `--self-test` exits `0` (`G-8`).
   - Added `createSleepMonitor()` inside `gradeTrialPhase` (flags `hostSleepDetected=true`, `infraFailure=true`, `ungradable=true` if wall-clock jumps >10s vs. monotonic time during grading), upgraded `caffeinate` to `-i -m -s` (while noting AC power + lid open is still required against battery clamshell sleep), moved all grading sandboxes under `runTmpRoot`, and added `node bench/run.mjs --regrade <runDir>`.
   - Normalized relative paths in `graderChecksum` (`V-07`), added `gitCommit`/`copilotVersion`/`graderChecksum` to `PROVENANCE_FIELDS`, added `runId` to `stratumKey` (`N-27`), added `shellWriteDenials` (`V-06`), excluded denied shell calls from `firstFailingTestIndex` (`V-03`), kept `include: [task.testRel]` strictly in grading sandboxes (`V-02`), and added paired ITT credit CIs (`G-9`) + a full gate-sensitivity table directly to `bench/analyze.mjs`.
   - Pre-registered `D-01`–`D-14` explicitly in `bench/PROTOCOL.md`.

### 2026-11-24 — v2.3 Self-Test Verification (`da61474`)
- `node bench/run.mjs --self-test` exited **`0`** (`G-8` fixed): **57/57** calibration variants (including `DSB` `DS-BYPASS` rejected and `CC3`/`T6`/`DS3`/`DB4`/`RS4`/`EO3`/`CM3` accepted), **16/16** single-bug mutants rejected by hidden oracle, **8/8** cheats rejected, **3/3** legal witnesses passed, **37/37** AST checks (including `D-12`). Relative-path `graderChecksum` verified deterministic (`63dd059ab3b1704f`).

### 2026-11-24 — v2.3 Cheaper-Model × Varying-Reasoning Matrix (80 Started Trials / 40 Matched Blocks, `da61474`)
*Run ID: `41f0877c-aafd-4ee1-ac5c-b0dfbec6d4da` · Output: `/Users/caligano/.ep-bench-results/v2-2026-11-24T09-15-06-057Z` (`report.html` generated) · Models: `gpt-6.2-sol:low`, `gpt-6.2-sol:medium`, `claude-haiku-5.5:low`, `claude-haiku-5.5:medium` · All 10 tasks · `--prompt-style symptom` · `--phase-split` · `--seed 101` · Built-in `caffeinate -i -m -s` on AC power.*

- **Run health:** `80/80` started, `0` `not_started`, `0` `infraFailure`, `0` `hostSleepDetected`, `0` `ungradable`, `0` global monkey-patching, `80/80` hidden oracle passes (`40/40` Control, `40/40` Treatment). Total billed cost across all 80 trials: **`377.8` credits** (`~$3.78`, plus `4.4` cr preflight).

#### Results by Stratum (`bench/analyze.mjs`)

| Stratum | Blocks | Control `solved` | Treatment `solved` | Guided EP Uptake (Trt) | E9 FG (adq) | Paired ITT Credits `T − C` |
| --- | --- | --- | --- | --- | --- | --- |
| **Stratum B (`io-seam`, 5 tasks)** | 20 | 19/20 (95.0%) | 18/20 (90.0%) | 9/20 (45.0%) | 0/40 vs. 0/36 | `-0.06 cr` · `1/2` discordant (`p = 1.0`) |
| **Stratum C (`real-async`, 2 tasks)** | 8 | 4/8 (50.0%) | 6/8 (75.0%) | 2/8 (25.0%) | 0/8 vs. 0/12 | `-0.65 cr` · `2/0` discordant (`p = 0.5`) |
| **Primary (Strata B + C equal-capability)** | **28** | **23/28 (82.1%)** | **24/28 (85.7%)** | **11/28 (39.3%)** | **0/48 vs. 0/48** | **`-0.23 cr [-0.70, +0.18]`** · `3/2` discordant, exact McNemar `p = 1.0`, Newcombe RD `+3.6pp [-13.1, +20.4]` |
| **Stratum A (`closed-module`, 3 tasks, separate)** | **12** | **8/12 (66.7%)** | **11/12 (91.7%)** | **12/12 (100.0%)** | **0/17 vs. 0/27** | **`+0.52 cr [-0.11, +1.30]`** · `3/0` discordant, exact McNemar `p = 0.25`, descriptive Newcombe `+25.0pp [-0.7, +50.4]` |
| **All 40 matched blocks (pooled)** | **40** | **31/40 (77.5%)** | **35/40 (87.5%)** | **23/40 (57.5%)** | **0/65 vs. 0/75** | **`+0.00 cr [-0.38, +0.38]`** · official `6/2` (`p = 0.289`), `noValidFixGate` `5/2` (`p = 0.453`), `allValidFixes` `4/3` (`p = 1.0`) |

#### Per Model × Reasoning Breakdown

| Model : Reasoning | All (10 blocks) | Strata B + C (7 blocks) | Stratum A (3 blocks) | Guided EP Uptake | Total Credits (C vs. T) |
| --- | --- | --- | --- | --- | --- |
| `gpt-6.2-sol:low` | C `8/10` vs. T `9/10` | C `6/7` vs. T `6/7` | C `2/3` vs. T `3/3` | 4/10 | `61.4` vs. `62.1` |
| `gpt-6.2-sol:medium` | C `8/10` vs. T `10/10` | C `6/7` vs. T `7/7` | C `2/3` vs. T `3/3` | 4/10 | `103.2` vs. `99.2` |
| `claude-haiku-5.5:low` | C `7/10` vs. T `7/10` | C `5/7` vs. T `5/7` | C `2/3` vs. T `2/3` | 7/10 | `9.8` vs. `11.1` |
| `claude-haiku-5.5:medium` | C `8/10` vs. T `9/10` | C `6/7` vs. T `6/7` | C `2/3` vs. T `3/3` | 8/10 | `14.7` vs. `16.5` |

#### Key Qualitative Findings (All 8 Discordant Pairs Inspected Line-by-Line)
1. **Why both Control-only wins (`C-only`, `2/40`) happened:** Both occurred in `claude-haiku-5.5` (`stale-cache-seam:low`, `event-order:medium`). Haiku extracted a new private helper (`applyUpdate`, `applyUnlocked`) in its fix and wrote `select(..., n => n.inFunction === 'applyUpdate' ...)`—which then failed with `matched 0` (`loud_break`) on the unmodified baseline and on every independent valid fix! This is a real, concrete failure mode of AST-selected execution points when smaller models couple `inFunction` selectors to newly refactored helper names instead of existing expressions.
2. **Why `D-14` (`passesAtLeastOneValidFix`) proved indispensable:** On `stale-cache | control | gpt-6.2-sol:medium`, Control rewrote production `yieldIo()` to `node:timers/promises.setImmediate`, mocked it, and wrapped `barrier.hit` in `expect(reached).toBe(true)` so the test threw an `AssertionError` (`true_red`) on the unmodified `MessageChannel` baseline instead of timing out! It fooled `noValidFixGate` (`true_red` on baseline + `2/2` mutants), and was caught cleanly by `passesAtLeastOneValidFix === false` (`0/5` independent valid fixes).
3. **Where Treatment won (`6` T-only vs. `2` C-only):** `stale-cache` (`3/4` vs. `0/4` Control — every Control agent failed), `cancel-commit` (`2/4` vs. `0/4` Control — Control missed `CC-M1`), and `single-flight` (`4/4` vs. `3/4` Control). Across all 40 blocks, paired per-trial credits were dead even (`T − C = +0.00 cr [-0.38, +0.38]`).

---

## v2.4 — Harness and Reporting Fixes from the Full Review (2026-11-24)

The full review recorded in `FINDINGS.md` ("Benchmark") found defects in how the harness grades and reports. The maintainer decided on 2026-11-24 to fix them. This section records what changed. **No paid run was made and no credits were spent**: everything below comes from the three stored runs, which were only read, and from `--self-test` and `--regrade`, which cost nothing.

The stored `results.jsonl` files remain the record of the three runs. Where this section re-grades stored trials with the new harness, that is a re-analysis and is labeled so. The pre-registered decisions are `D-15`–`D-17` and the extension of `D-09` in `bench/PROTOCOL.md`.

### What changed

1. **Grading is repeated, and disagreement has its own outcome.** Every variant an agent's tests are graded against (baseline, single-bug mutants, buggy refactors, valid fixes, the agent's own fix) runs `--grade-repeats` times, default 3. The runs must agree; otherwise the variant is `unstable`, which no gate accepts. Each row records the runs, `unstableVariants`, and `reproduction` (`adequate`, `inadequate`, or `unstable`: some observed runs satisfy the gates and others do not). The analyzer prints the unstable counts per arm and a sensitivity line that counts them as adequate.
2. **Why `cancel-commit` flipped, and the fix.** The verdict on the `CC-M1-shared-stage-file` mutant changed between identical gradings because of the tests, not the mutant. The tests hold one run at a barrier, start the second run, wait `settle()` (20 `setImmediate` turns), and release. Twenty event-loop turns do not order real disk I/O: the second run gets through none, some, or all of its `node:fs/promises` calls depending on how busy the machine is, and the mutant only misbehaves when the superseded run touches the shared staging file between the newer run's write and read. Measured on the unchanged v2.3 sandbox, 20 runs of each stored trial's test file against `CC-M1`:

   | Stored trial (`cancel-commit`) | Outcomes in 20 runs, real disk I/O (v2.3) | Runs with deterministic I/O (v2.4) |
   | --- | --- | --- |
   | pilot, control, `claude-opus-5.5` | 9 passed, 11 failed (9 of them only on an escaped `ENOENT`) | `error` in every run |
   | pilot, control, `gemini-4-neon` | 15 passed, 5 failed on an assertion | `passed` in every run |
   | pilot, control, `gpt-6.2-astra` | 20 failed, all on an escaped `ENOENT`, none on an assertion | `error` in every run |
   | pilot, treatment, `claude-opus-5.5` | 18 failed on an assertion, 2 passed | `true_red` in every run |
   | pilot, treatment, `gemini-4-neon` | first batch: 13 passed, 7 `ENOENT`; second batch under load: 20 `ENOENT` | `error` in every run |
   | pilot, treatment, `gpt-6.2-astra` | 20 failed on an assertion | `true_red` in every run |
   | matrix, 6 trials | 20 passed each | `passed` in every run |
   | matrix, 2 trials (treatment `gpt-6.2-sol:medium`, `claude-haiku-5.5:medium`) | 20 failed on an assertion each | `true_red` in every run |

   Four of the 14 trials gave more than one outcome, and the share moved with machine load. Grading sandboxes of real-filesystem tasks now load `bench/deterministic-io.setup.mjs`: each path-based `node:fs/promises` call takes effect on the real disk and settles after exactly one event-loop turn, in call order. That is the treatment the hidden oracle's engine already gives its own schedules (`D-09`, `activeLeafIo`), and it makes a disk call cost what a `MessageChannel` tick costs in the other nine tasks. Agents' workspaces keep the real asynchronous functions; both guides now say that `settle()` does not wait for real I/O. `--self-test` step 7 runs a `settle()`-ordered probe 10 times each way: one outcome with deterministic I/O every time, and with real I/O, over four self-test runs on this machine, 10 errors; 8 errors and 2 passes; 9 and 1; 2 and 8.
3. **Only an assertion failure is a reproduction.** `bench/PROTOCOL.md` section 2 said "genuine `AssertionError`" while the classifier counted every failure outside two text patterns as `true_red`. A failed test is now classified by the type of the error it threw (`bench/classify.mjs`): `AssertionError` is `true_red`; a timeout is `timeout`; a library error (every message of the library starts with `[execution-points]`; the old pattern looked for `ExecutionPoint` and matched none of them), a load error, or a guard refusal is `loud_break`; anything else is the new outcome `error`. A run whose tests all pass while Vitest exits non-zero (an unhandled rejection) is `error`, not `passed`. Text inside an assertion message is never matched, so an assertion mentioning `matched 2` or `is not a function` is an assertion, and `TypeError: x is not a function` is neither a reproduction nor a selector break. Of the 20 message cases in `--self-test` step 4, the v2.3 rule got 9 wrong. Both guides tell the agent that a reproduction must fail on an assertion.
4. **The same root cause is counted the same way in both arms.** A missing interception point is a selector break in a library test and a timeout in a `vi.mock` test; only the timeout entered the false-red rate. Now every valid fix a test does not pass is "not green", whatever the reason, and every buggy refactor on which the test neither failed on an assertion nor passed has "stopped testing". The components are printed next to both.
5. **The analyzer prints what the protocol promises.** Per arm and split by whether the treatment trial used the library: refactors still red, stopped testing (loud break, timeout, other error, unstable), false greens; valid fixes green and not green by reason. `solved` by adoption next to the intention-to-treat result. Every component of `solved`, `tamperedConfigs`, technique, `firstRedBeforeFirstSourceEdit`, credits, list-price USD and tokens per solved trial, and the power of the primary test at the observed discordance.
6. **Pairing and provenance.** Blocks are keyed on the requested model; a row without a partner and a row served by another model than requested each get a WARNING. A harness-exception row carries full provenance, and an older one without it no longer makes the analyzer exit before the sensitivity analysis. Duplicates that differ are refused instead of being called exact. `--allow-mixed` takes the names of what may be mixed (`--allow-mixed=gitCommit,graderChecksum`); the bare flag is an error. `--regrade` keeps the original trial's provenance and records the re-grading checkout under `regradedWith`; `--only` and `--out` re-grade selected trials without writing into the stored run directory.
7. **`--self-test` typechecks every calibration variant in both arms**, not only the baselines (step 9, 65 distinct variants, 130 `tsc` runs). `RS-token-design` failed `tsc` in both arms (`TS2454`) and is fixed.
8. **Guides.** The deferred-barrier section, the `vi.mock` recipe, and the fake-timers note are identical in both guides, with placeholder names that appear in no task. The treatment guide adds the library section after them. `--self-test` step 13 enforces this. `bench/EXECUTION_POINTS_GUIDE.md`, which nothing referenced, is removed. The contract snippet and the witness use the minimal selector style; the snippet keeps one verbose selector.
9. **Statistics.** The paired interval is now Newcombe's Method 10 (continuity-corrected correlation estimate). What v2.3 printed under that name was the uncorrected-correlation variant (Method 8), which returns `[0, 0]` when every pair is concordant and half of them are solved. The analyzer prints both. `bench/PROTOCOL.md` section 5 now gives the power at the observed discordance next to the best case.
10. **Budget.** The harness prints the projected credit need before anything starts and refuses a matrix whose projection exceeds `--max-total-credits`. A rerun of the last matrix (377.8 credits) projects to 471.2 credits with the 20% margin and the preflight, and is refused at the default cap of 300 instead of being cut off partway.
11. **Protocol.** `bench/PROTOCOL.md` describes the harness at v2.4, carries the version the self-test checks, and has a section on what differs for the stored runs.
12. **Bench processes no longer delete each other's files.** `--sweep-stale` removed every `ep-*` directory in the temp directory, including the sandboxes of bench processes that were still running. Every temp root now records the process that owns it, and the sweep removes a root only when that process is gone; roots of live processes and directories without an owner record are left alone. Toolchain preparation refuses a `node_modules` that is a symbolic link: stripping its copies deleted packages from the checkout the link pointed to.

### 2026-11-24 — v2.4 Self-Test Verification (`cb94a6b`)

`node bench/run.mjs --self-test` ran to its end (386 s on a quiet machine, 950 s with other work running) and **exited 1 with 4 failures, all in step 9 and all in the treatment arm only**:

| Variant | Kind | Treatment `tsc --noEmit --runExternalCode` |
| --- | --- | --- |
| `cancel-commit` `CC-ref` (the reference fix) | reference fix, valid fix | `TS2552: Cannot find name '__EP_AbortController_1'` |
| `cancel-commit` `CC-M1-shared-stage-file` | single-bug mutant | `TS2552: Cannot find name '__EP_AbortController_1'` |
| `debounce-search` `DB-abort-design` | valid fix | `TS2552: Cannot find name '__EP_AbortController_1'` |
| `cancel-commit` `R1-extra-stat` | buggy refactor | `TS2304: Cannot find name 'Stats'` |

All four typecheck in the control arm. The cause is in the library's generated registry (`FINDINGS.md` F16 for `AbortController`, F1 for `fs.Stats`), which is being fixed separately; the harness check stays in and stays red until then. *(Corrected 2026-11-24: this is the state at `cb94a6b` and no longer holds. The fixes for F1 and F16 were merged at `24dc30e` the same afternoon. Since then all 65 variants typecheck in both arms, 27 of 27 reference and valid fixes, and the self-test passes; see "The Library's New API in the Guide and the Toolchain" below.)* Until it is green, a treatment agent whose correct fix uses `AbortController` or `fs.stat` in a target file fails `contractTypecheckPass` where a control agent with the same fix passes. 61 of 65 variants typecheck in both arms; of the 27 reference and valid fixes, 25.

Everything else passed: toolchain isolation; 37 AST cases; both selector styles through `tsc` and Vitest; 26 classification cases plus 11 through real Vitest runs in both arms; repeated-run and verdict cases; 8 of 8 cheats rejected; 5 of 5 legal witnesses, including a new plain-Vitest `cancel-commit` witness in both arms that is adequate with every run agreeing and green on both valid fixes; the deterministic I/O probe; 20 of 20 baselines; 57 of 57 calibration variants; 16 of 16 mutants rejected by the hidden oracle; 10 of 10 reference-fix AST audits; guide parity; version strings; the stale-directory sweep; credit projection.

### Re-analysis: the stored `cancel-commit` trials under v2.4 (not the record of the runs)

Re-graded at `5408a2f` (the same grading code as `cb94a6b`) with 3 runs per variant, into a scratch directory.

- The three pilot treatment trials were each re-graded six times (18 runs per variant). Every run of every variant agreed, and the verdict was the same all six times: `gpt-6.2-astra` adequate, `claude-opus-5.5` adequate, `gemini-4-neon` inadequate.
- All 14 stored `cancel-commit` trials, re-graded twice: no unstable variant, identical results both times. 4 adequate (all treatment: pilot `gpt-6.2-astra` and `claude-opus-5.5`, matrix `gpt-6.2-sol:medium` and `claude-haiku-5.5:medium`), 10 inadequate.
- Against the stored verdicts, the 8 matrix trials are unchanged. Three pilot trials differ. Control `gpt-6.2-astra` and treatment `gemini-4-neon` are stored as solved; their tests fail on `CC-M1` only through an `ENOENT` from the superseded run that escapes the test, which is not an assertion and which the hidden oracle allows a superseded run to do. Treatment `claude-opus-5.5` is stored as unsolved because the pilot's single-reference gate timed out on it (`G-1`); it passes the second valid fix added in v2.3 and detects `CC-M1` on an assertion in every run.

### Corrections to Earlier Entries

Recomputed from the stored `results.jsonl` files with `bench/analyze.mjs`. The entries above are left as written; these are the corrections.

1. **E9 false-green denominators, v2.3 matrix table.** The table gives `0/40 vs. 0/36` (Stratum B), `0/48 vs. 0/48` (primary), `0/17 vs. 0/27` (Stratum A), and `0/65 vs. 0/75` (all). The stored data give `0/38 vs. 0/36`, `0/46 vs. 0/48`, `0/20 vs. 0/29`, and `0/66 vs. 0/77`. Stratum C (`0/8 vs. 0/12`) is right. No false green changes.
2. **E9 false-green denominators, pooled pilot table.** Stratum A is `1/7 vs. 0/21`, not `0/19`; all blocks are `1/45 vs. 0/61`, not `0/59`. Strata B, C and primary are right.
3. **Pilot credit intervals.** The pooled pilot table gives `+1.8 cr [-2.5, +6.0]` (primary), `-8.8 cr [-28.0, +10.4]` (Stratum A), and `-1.2 cr [-6.8, +4.5]` (all). The analyzer's bootstrap gives `+1.75 cr [-2.03, +5.68]`, `-8.80 cr [-25.77, +2.38]`, and `-1.16 cr [-6.93, +3.61]`. The point estimates agree; the intervals in the table are not the analyzer's. The matrix table's credit intervals are right.
4. **The host-sleep row was not re-graded in the stored data.** The v2.2 pilot entry says the `cancel-commit | control | gemini` row was "re-graded cleanly at `c70758a`" and "is `ungradable=false`". The stored `results.jsonl` still has that row with `ungradable: true` at `afdd5a5`, and the run directory contains no re-graded file. The pooled analysis therefore still prints "excluding 1 infra/ungradable rows". It is unsolved either way.
5. **False greens were the only E9 number reported.** They are 0 or near 0 for everyone. The same rows show how often a test stopped testing on a still-buggy refactor (adequate rows only): in the matrix, control 0 of 66, treatment trials that used the library 9 of 47 (19%, all loud selector breaks), treatment trials on plain Vitest 0 of 30. In the pooled pilot, control 0 of 45, treatment 8 of 61. A loud break is the designed behavior and is better than a false green; it is still a test that no longer tests.
6. **The interval labeled "Newcombe Method 10" was the uncorrected-correlation variant (Method 8).** With Method 10 the matrix primary interval is `+3.6pp [-14.4, +21.6]` instead of `[-13.1, +20.4]`, Stratum A `+25.0pp [-6.6, +52.7]` instead of `[-0.7, +50.4]`; the pooled pilot primary is `+4.8pp [-12.3, +23.3]` instead of `[-9.3, +21.7]`, and Stratum A `+50.0pp [+2.9, +75.9]` instead of `[+10.4, +73.0]`. No conclusion changes: the exact McNemar test decides at these sizes.
7. **`cancel-commit` does not use `AbortController`.** The v2 entry describes Stratum C as "`node:fs/promises` + `AbortController`". Only the reference fix uses `AbortController`; the task source does not.
8. **Randomized arm order had no effect in the stored runs.** All three ran at `--concurrency 2`, where both arms of a block start together.
9. **The guides were not symmetric at the time of the matrix.** The control guide's `vi.mock` example used the real identifiers of `stale-cache-seam`, and the treatment guide had no `vi.mock` recipe and no fake-timers note.
10. **Four documents this log cites are not in the repository:** `bench-critical-review.md`, `bench-v2-re-review.md`, `bench-v2.1-re-review.md`, and `bench-v2.2-audit.md`. The finding IDs used throughout this log (`E-..`, `R-..`, `N-..`, `G-..`, `V-..`) refer to them and cannot be looked up here.

The `solved` counts in the tables above reproduce exactly from the stored data: pooled pilot 22/29 against 27/29 (primary 19/21 against 20/21, Stratum A 3/8 against 7/8), matrix 31/40 against 35/40 (primary 23/28 against 24/28, Stratum A 8/12 against 11/12), with the same discordant pairs and exact McNemar p-values.

---

## The Library's New API in the Guide and the Toolchain (2026-11-24, `66ccb34` to `393f6cd`, still v2.4)

This entry was written afterwards, from the commits. Between the merge of v2.4 (`327dd29`) and `393f6cd` the library changed, and three commits changed `bench/` with it. The harness version stayed `v2.4` and nothing was logged at the time. **No paid run was made in between.**

1. **What the library does differently.** A replacement that never runs fails the test; for an asynchronous action the check runs after the test, through a setup module that the Vite plugin adds (`38411c2`, `ff8c90e`). New on a point: `pause()`, `replace()` with the shorthands `returns`, `throws`, `resolves` and `rejects`, and `calls`. New in the package: `interleavings`, selection through a visitor object, and the command `execution-points list`. The two type-generation defects that failed the treatment typecheck (`FINDINGS.md` F1 and F16) are fixed (`24dc30e`).
2. **What a treatment workspace gets.** The library's sources became TypeScript, built by `tsdown` into `dist/`. Toolchain preparation runs that build and installs `package.json`, `points.schema.json` and `dist/` (`66ccb34`, `a717b83`); up to then it copied `src/`. The build wrote the checkout's own `dist/`; v2.5 changes that.
3. **The treatment guide's library section was rewritten** (`393f6cd`). It teaches `pause()` in place of a hand-written barrier inside `withReplacement`, says that a replacement or a pause that never runs fails the test and names `{ times: 'any' }`, names `npx execution-points list <file>`, the visitor-object form, and `interleavings`. The section grew from 411 to 576 words. The control guide did not change, and the sections the two guides share are still identical (self-test step 13).
4. **The `stale-cache` treatment witness uses `pause()`** (`393f6cd`).
5. **Two classification cases changed** (`393f6cd`): a library message that no longer exists was dropped and two that it now has were added.

For the record of runs this means: the three stored runs measured the library and the guide of their own commits. A run from `393f6cd` on measures a different treatment. `gitCommit`, `toolSha256` and `tasksSha256` (which covers the guides) differ, so `bench/analyze.mjs` refuses to pool the two.

**Self-test at `393f6cd`:** passed, 139 check lines and 0 failures (140 lines of output contain `PASS`, counting the final one), 699 s with other work running. Step 9: all 65 variants typecheck in both arms, 27 of 27 reference and valid fixes. This replaces the four failures recorded for `cb94a6b` above.

What this state of the harness got wrong is the next section.

---

## v2.5 — Library Use by Operation, Error Types from a Reporter, the Guide's Command, `dist/` (2026-11-24)

A re-evaluation of the harness against the library's new API found four defects. The first, the third and the fourth come from the changes of the section above; the second is a defect of v2.4 itself that a re-grade of the stored matrix exposed. **No paid run was made and no credits were spent.** The stored `results.jsonl` files are unchanged; every re-grade below wrote into a scratch directory and is a re-analysis. The pre-registered decisions are `D-18` and `D-19` in `bench/PROTOCOL.md`.

### What changed

1. **A test uses the library by any operation of a point (`D-18`).** The auditor counted a test as using the library only when it called `withReplacement`. A test written as the guide now teaches calls `pause()`, so it was reported as plain Vitest; the harness's own `stale-cache` witness came out as `usesExecutionPoints=false, technique=deferred-only`. The split by adoption and the robustness table by adoption would have put nearly every library test of a new run on the wrong side. Now a test uses the library when it imports `select` from the package, calls it, and puts a selected point to use: `withReplacement`, `replace`, `returns`, `throws`, `resolves`, `rejects`, `pause`, or handing it to `interleavings`. The technique stays the one value `execution-points`; the row records the operations in `libraryOperations`, and `bench/analyze.mjs` prints the number of trials per operation. The list is read off `Point` in the library's declarations: the self-test compares it with the declarations a treatment workspace gets and fails when the library has a member the auditor does not know. The audit is syntactic; `D-18` lists what it follows and what it does not.
2. **The type of an error is read from Vitest's own record of it (`D-19`).** v2.4 implemented "only an `AssertionError` is a reproduction" by reading the first line of the stack that Vitest prints. For a failed `expect(p).rejects`, `expect(p).resolves`, `expect(p).rejects.toThrow(message)` and `expect.poll` that line says `Error:`, although the error is an `AssertionError`. v2.4 graded those reproductions as `error`, in both arms. The harness now reads each error's `name`, and the `name` of every `cause` behind it, through a Vitest reporter of its own (`bench/failure-reporter.mjs`), and grades by that. A run whose failure report is missing, or names other failures than Vitest's JSON report, is not graded from text: the trial becomes `ungradable`. For every variant that is not a pass the row records the kind, name and causes of up to four errors.
3. **`npx execution-points list <file>` resolves in a treatment workspace.** The guide tells the agent to run it. The harness installed the package by copying files and made no link in `node_modules/.bin`, so `npx` asked the npm registry for a package called `execution-points`, which is not this library's name. The toolchain now installs the package as its `package.json` ships it and links each command of its `bin`, as an install does.
4. **No bench process and no probe writes the checkout's `dist/`.** Since `66ccb34` toolchain preparation ran `tsdown` in the checkout, which empties `dist/` and writes it again, every time a self-test, a re-grade or a run started; `probes/e2e.mjs` did the same. A type check or a gap check in the same checkout reads `dist/` at that moment. Both now build into their own temp directory (`tsdown --out-dir`); the output is the same.

### Two gradings that are not decided

They were put to the maintainer on 2026-11-24 and v2.5 does not change them. Each is one rule in `UNDECIDED_GRADINGS` (`bench/classify.mjs`), stated by self-test cases of its own:

- An error of the library that has an `AssertionError` among its causes is a loud break. An assertion that fails inside `order.run(...)` of `interleavings` arrives this way; the library's README recommends that placement. The same assertion after `order.run(...)` is a reproduction.
- `expect.assertions(n)`, `expect.hasAssertions()` and a snapshot that does not match throw a plain `Error` and are graded `error`.

Neither occurs in the stored matrix: in the v2.5 re-grade below no trial has a library error caused by an `AssertionError`, and none has an expectation thrown as a plain `Error`. The stored tests could not use `interleavings`, which did not exist.

### Self-test verification (`e02f774`)

`node bench/run.mjs --self-test` ran to its end in 605 s, with a re-grade running beside it, and passed: **156 check lines passed, 0 failed.** That is 17 more than at `393f6cd`: the checkout's `dist/` (step 1), library use with the comparison against the shipped declarations (step 2), the guide's command (step 3), and 14 more cases through real Vitest runs (step 4, 25 instead of 11). The final line of the self-test now gives this count.

- Step 1: `dist/` of the checkout is 14 files, before and after.
- Step 2: 18 library-use cases. The operations the auditor knows are the members of `Point` in the declarations a treatment workspace gets.
- Step 3: `npx execution-points list src/profile-store.ts` in a treatment workspace, npm offline, printed 31 selectable expressions.
- Step 4: 33 single-error cases and 9 run cases; the v2.4 rule gets 4 of the 33 wrong and the v2.3 rule 14. 25 cases through real Vitest runs in both arms, among them a failed `expect(p).rejects`, `expect(p).resolves`, `expect(p).rejects.toThrow(message)` and `expect.poll` (all `true_red`), a replacement that never ran and a pause that was never reached (both `loud_break`, from the library's check after the test), and an assertion that fails while a pause is held (`true_red`).
- Unchanged and passing: 8 of 8 cheats rejected, 5 of 5 legal witnesses, the deterministic I/O probe, 20 of 20 baselines, 65 of 65 variants typechecked in both arms, 57 of 57 calibration variants, 16 of 16 mutants rejected by the hidden oracle, 10 of 10 reference-fix audits, guide parity, version strings, the stale-directory sweep, credit projection.

Each new case was also run against the v2.4 implementation, unpacked from `71f3fdc` into a scratch directory, by handing the case that implementation's auditor, toolchain, classifier and runner:

| Case | v2.4 implementation (`71f3fdc`) | v2.5 |
| --- | --- | --- |
| Library use, 18 cases | 0 pass. 12 get the use itself wrong: `point.pause()`, `interleavings`, `replace` and the shorthands all give `usesExecutionPoints=false`, and the witness gives `technique=deferred-only`. The other 6 record no operation | 18 pass |
| `dist/` of the checkout | fails: absent before, 14 files after; in a tree that already had one, 14 of 14 files written again | pass |
| The guide's command, npm offline | fails: exit 1, `npm error code ENOTCACHED`, `request to https://registry.npmjs.org/execution-points failed` | pass |
| Single errors, 33 cases | 29 pass. The 4 failures are a failed `.rejects`, `.resolves`, `.rejects.toThrow(message)` and `expect.poll`, each classified `error` | 33 pass |
| The same through Vitest, 25 cases | 11 pass. 4 fail on the outcome (`error` where `true_red` is right); 10 because the result records no error name or cause | 25 pass |

### Re-analysis: the stored matrix under v2.4 and under v2.5 (not the record of the run)

All 80 trials of `v2-2026-11-24T09-15-06-057Z`, re-graded into a scratch directory with 3 runs per variant: once at `393f6cd` (v2.4) and once at `e02f774` (v2.5). Both re-grades ran the stored tests with the library of the re-grading checkout, not with the library of the run.

| Solved (control, treatment) | Stored | Re-graded, v2.4 | Re-graded, v2.5 |
| --- | --- | --- | --- |
| `retry-storm` | 4/4, 4/4 | 2/4, 3/4 | 4/4, 4/4 |
| `double-submit` | 4/4, 4/4 | 0/4, 0/4 | 1/4, 2/4 |
| `stale-cache` | 0/4, 3/4 | 0/4, 2/4 | 0/4, 2/4 |
| The other seven tasks | 23/28, 24/28 | 23/28, 24/28 | 23/28, 24/28 |
| All ten tasks | 31/40, 35/40 | 25/40, 29/40 | 28/40, 32/40 |

- **No variant was unstable** in either re-grade.
- **v2.4 against v2.5: six verdicts, all back from unsolved to solved.** Three `retry-storm` trials (two control, one treatment) and three `double-submit` trials (one control, two treatment). In each a single-bug mutant is detected by a failed `expect(p).rejects` or `expect(p).resolves`, which v2.4 read as `error` (item 2). Between the two checkouts the library differs only in `src/content-mapper.ts` and its entry file, so this difference is the harness.
- **v2.5 against the stored verdicts: six differ, all from solved to unsolved.**
  - Five `double-submit` trials (three control, two treatment), all on the mutant `DS-M1-rejection-poison`: the test awaits a call that rejects with `Gateway 502`, and no assertion fails. That is `D-16` as decided. A test that wrote `await expect(p).resolves…` instead of `expect(await p)…` counts. The stored tests were written before both guides stated the rule.
  - One `stale-cache` treatment trial (`gpt-6.2-sol:medium`): on the agent's own fix and on every valid fix its test now fails with "The replacement … ran 0 times". The test holds a replacement that is meant never to run, a tripwire that throws if a warm read reaches storage. With the library of the run that was silent. This verdict changes because of the library of the re-grading checkout, not because of the harness.
- **`bench/analyze.mjs` on the v2.5 rows:** 28/40 against 32/40, 6 treatment-only and 2 control-only pairs, exact McNemar p = 0.289; the stored run has the same numbers of discordant pairs. Strata B + C: 23/28 against 24/28 with 3 and 2, as stored. Stratum A: 5/12 against 8/12 with 3 and 0; stored 8/12 against 11/12.

### What v2.5 does not change, and what it corrects in this log

- The re-analysis of the 14 stored `cancel-commit` trials under v2.4 above stands: its three `error` outcomes are `ENOENT` rejections that escaped the test, not assertions misread from the stack.
- `usesExecutionPoints` of the stored rows is unchanged by `D-18`: the v2.5 re-grade finds the library in the same 23 of 40 treatment trials, all through `withReplacement`.
- A re-grade of stored trials from `38411c2` on is not like for like, whatever the harness version: the stored tests were written for a library in which a replacement that never ran was silent. In the matrix that changed one verdict (above).

---

## v2.6 — The Grading Decisions, the Agent's Permission to Run the Guide's Command, a Third Arm (2026-11-24)

The maintainer decided the open questions of the v2.5 section on 2026-11-24, retired the three stored runs, and asked for a pilot of the current library. Preparing it turned up one more defect: the agent of the Treatment arm was not allowed to run the command its guide names. The pre-registered decisions are `D-20` to `D-23` in `bench/PROTOCOL.md`; its section 7 is now "Retired Runs". The library is the one of `eca441d` (a selector no longer has `line` or `text`; an expression that several ways lead to is one selection).

### What changed

1. **An error of the library that a failed expectation caused is a reproduction (`D-20`).** A check that fails inside `order.run(...)` of `interleavings`, which is where the library's README puts it, reaches Vitest as an `InterleavingFailure` with the `AssertionError` as its cause. v2.5 graded that as a loud break, so the same check counted after `order.run(...)` and not inside it, and only a Treatment test could be hit. The cause that decides is the first one behind the error that is not the library's own. An error of the library with another cause stays a loud break.
2. **`expect.assertions(n)`, `expect.hasAssertions()` and a snapshot that does not match are failed expectations (`D-21`).** Vitest throws them as a plain `Error`; v2.5 graded them `error`. They have no type of their own, so they are recognized by the message Vitest 5.1.1 gives them, on an error named `Error`. The self-test runs all three through Vitest.
3. **The three stored runs are retired.** They measured a library and a guide that no longer exist, under grading rules that have been replaced. Nothing is answered from them any more, they are not pooled and not re-graded, and the question whether the assertion-only rule applies to them is closed with that. Everything above this section about them stays as the history of what was reported. The power table of the protocol no longer quotes them; the figures to plan with come from the pilot.
4. **The agent of the Treatment arm may run the library's command (`D-22`).** The Treatment guide tells the agent to run `npx execution-points list <file>`. v2.5 made that command resolve in a Treatment workspace and tested it in a shell. The agent does not run in a shell of its own choosing: the harness hands the agent CLI a list of allowed commands, and both arms carried a deny rule for every `npx` command. Seen live with the rules of v2.5: the agent's call is refused with "Permission denied because no interactive user response was available". Now the Treatment arm has an allow rule for `npx execution-points` and no deny rule for `npx`; everything else is the same in both arms (`npm test`, `npm run <script>`, nothing else). A second live preflight, in a Treatment workspace, checks before any trial that the agent can run the guide's command and is refused `npx vitest --version`. Each row records `libraryCommandCalls` and `libraryCommandCallsDenied`, and the analyzer prints how many trials ran a command. A shell command that is the library's own is no longer listed under `suspiciousPaths`.
5. **A third arm, `required` (`D-23`).** The maintainer asked how to get agents to use the library more. In the Treatment arm the agent is only offered it and chooses; trials that do not use it dilute the arm, and comparing the tests of those that do with the rest compares self-selected groups. The `required` arm has the Treatment workspace and guide, and one more sentence of instructions: write the regression tests with the library. It is assigned at random like the other two, in the same blocks. `solved` is defined as elsewhere; whether the agent did as told is reported, not gated. `bench/analyze.mjs --compare=control:required` (or `treatment:required`) compares two arms and names the rows of the third. With three arms a run needs `--concurrency 3` to start the arms of a block together.

`UNDECIDED_GRADINGS` is gone from `bench/classify.mjs`; the two rules are `isFailedExpectation` and `causeOfLibraryError` there. The credit projection counts two preflights when both arms run.


### Self-test verification (library at `d279bda`)

`node bench/run.mjs --self-test` on the tree of this commit ran 540 s and passed: **159 check lines passed, 0 failed.** Three more than v2.5: one more case through a real Vitest run (26), the agent's permission for the guide's command, and the third arm.

- Step 3: the shell rules let the Treatment agent run `npx execution-points list <file>`, the Control agent not, and neither another package through `npx`; the rules of v2.5 fail this case. A `required` workspace has the files of a Treatment workspace, and Control and Treatment get the same instructions.
- Step 4: 40 single-error cases and 9 run cases. Of the 11 cases of `D-20` and `D-21` the v2.5 rule gets 7 wrong. Through Vitest: `expect.assertions(n)`, `expect.hasAssertions()` and a snapshot mismatch are `true_red`; an assertion inside `order.run(...)` is `true_red`, recorded as `InterleavingFailure` caused by `AssertionError`; a `TypeError` inside `order.run(...)` stays a `loud_break`.
- Unchanged and passing: 18 library-use cases, 8 of 8 cheats rejected, 5 of 5 legal witnesses, 20 of 20 baselines, 65 of 65 variants typechecked in both arms, 57 of 57 calibration variants, 16 of 16 mutants rejected by the hidden oracle, guide parity, version strings.

What the self-test cannot check is whether the agent CLI honours the shell rules. That was checked live with `claude-haiku-5.5` before this commit (0.8 credits): with the rules of v2.6 the agent ran the guide's command and was refused `npx vitest --version`; with the rules of v2.5 it was refused both. Every paid run repeats that check in its second preflight.

### The run registered for v2.6 (`D-24`)

The maintainer asked for the full run with all models in place of a pilot. Registered before it started, in `D-24` of the protocol:

- Ten tasks × seven model settings × three arms, five replicate runs of 70 blocks and 210 trials each (seeds 301 to 305, `--trials 1 --concurrency 3`), analyzed together: 350 blocks, 1,050 trials, 245 blocks in Strata B + C.
- Two primary tests on `solved` in Strata B + C: Control against Treatment and Control against `required`, exact McNemar, Holm for two tests.
- Projected credits per replicate: 4,059.9 for the trials, 4,907.5 with the 20% margin and two preflights; cap per replicate 5,500.
- The number of replicates is fixed. An outside stop (usage limit, sleep, crash) ends the series, and what was started is analyzed as written.
- Known beforehand: the Treatment guide was written against these tasks, and the blocks repeat ten tasks.
