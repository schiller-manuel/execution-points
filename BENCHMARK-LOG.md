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

*Takeaway:* With all P0 + P1 + P2 safeguards active, Treatment organically adopted `execution-points`, passed virtual contract checking (`tsc --noEmit --runExternalCode`), reproduced both bugs on untouched baseline and single-bug mutants with zero false greens and zero false red assertions, and finished 23s faster than Control—while Control's production-seam rewrite was cleanly caught by `timeout != true_red`. Ready for larger multi-task, multi-model matrix runs across all 10 tasks and 3 strata.
