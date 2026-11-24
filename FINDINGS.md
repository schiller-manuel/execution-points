# Findings

Full review of the library, the oracle suites, and the benchmark, started at `b26e2c1` on 2026-11-24. This file is kept current; the changelog at the bottom says what changed and when.

Every finding names the probe that shows it. Probes are small scripts in `probes/` that call the unchanged production code. Run any of them from the repository root, for example `node probes/p08-e2e-node-builtin-types.mjs`. They build their throwaway projects under the OS temp directory and write nothing into the repository.

Nothing in `src/`, `tests/`, or `bench/` was changed by this review. The laws belong to the maintainers, so every proposed law below is a potential law until approved.

## Short version

- **The library has one defect that should be fixed before anything else.** A single expression in any target file whose type comes from a Node built-in module (`fs.Stats`, `http.Server`, `ChildProcess`, ...) makes `tsc` fail for the whole project (F1). 22 of 38 everyday Node calls trigger it. The benchmark tasks happen to avoid it.
- **Two more type-generation defects** leave the editor with stale types (F2) and make expressions unselectable when the project declares global types outside the targets (F3).
- **The oracles are strong where the runtime lives and thin where these defects live.** The gap check kills every code change in `runtime.mjs`, `discovery.mjs`, and `plugin.mjs`, and misses 248 of 1,472 (17%), all in `contracts.mjs` and `content-mapper.mjs`.
- **Listing a module as a target makes it run 30 to 120 times slower** even when no test replaces anything (F6). Resolving the registry once per module instead of once per call recovers about two thirds of that.
- **Do not rerun the whole benchmark now.** The runtime, plugin, and discovery code are byte-identical to the last paid run; only the types and twelve lines of the treatment guide changed. A full rerun would cost about 2,700 credits and, by the protocol's own power calculation, could not reach significance. The section "Should the benchmark be rerun" gives the sequence I recommend instead.
- **The benchmark measures regression-test quality, not bug fixing.** Across all 138 stored trials the hidden grader passed 68 of 69 in each arm. Every difference in `solved` comes from one component, `adequateReproduction`.

## Decisions needed

1. F1, F2, F3, F8, F9, F10: is each a bug, or intended? Each one becomes a law and a failing history first, then a fix.
2. F4: should the promise that selector breaks are loud cover `nth`, or should `nth` be documented as the one selector that can retarget silently?
3. F5 and F7: should a replacement that never runs fail the test by default, and should there be a scope that is not tied to the async context?
4. F6: is there a performance budget for instrumented code with no replacement active? If so it can become a `work` bound in the runtime oracle.
5. The benchmark sequence at the end of this file: approve, or change.

---

## Library findings

Ordered by how much a user would be hurt.

### F1. Types from Node built-in modules break `tsc` for the whole project

**Kind:** possible bug.

**The class:** the generated registry writes ambient types by bare name. That is right for true globals (`Map`, `URL`, `NodeJS.Timeout`) and wrong for every type declared inside a `declare module "..."` block, which is how `@types/node` declares nearly everything. Any selectable expression, or any local in scope of one, with such a type puts an unresolvable name into the registry. The project then fails to typecheck, including tests that never select that expression.

```ts
// src/files.ts, listed in points.ep, never selected by any test
import { statSync } from 'node:fs'
export function size(p: string) { return statSync(p).size }
```

```text
$ tsc --noEmit --runExternalCode
points.ep(9,227): error TS2304: Cannot find name 'Stats'.
  This location is in virtual code produced by the content mapper ... and has no corresponding location in the original file.
```

Expected: exit 0, as for the same project without `src/files.ts`. Observed: exit 2. Vitest still passes, so only the typecheck tells you.

A second form of the same class is a wrong binding instead of a missing one: `vm.createContext()` is emitted as `Context`, which inside the registry's `declare module 'execution-points-prototype'` block resolves to the library's own `Context<Result, Locals>`.

**Why I think it's wrong:** `README.md:7` says the content mapper works with `tsc --noEmit --runExternalCode`. `BENCHMARK-LOG.md:107` records the same failure for `Timeout` and the decision to fix it by qualifying the name (`NodeJS.Timeout`); `qualifyAmbientName` (`src/contracts.mjs:96`) only walks namespaces with identifier names, so `declare module "fs"` is skipped.

**Why it matters:** most server code touches `fs`, `http`, `child_process`, `crypto`, or `stream`. One call anywhere in a target is enough. In the benchmark this can only hurt the treatment arm, because `contractTypecheckPass` runs only there; `cancel-commit` imports `node:fs/promises`, so a fix that calls `stat()` or `open()` would fail the treatment trial for a reason the agent cannot see. It has not happened in the 69 stored treatment trials.

**Why the tests miss it:** the contracts oracle reaches ambient types in two histories, both for namespaces (`ambient-and-global-namespaces: 2` in the run output). None uses a type from an ambient module. `resolveExternal` and `isAmbientOrGlobal` also have open gaps.

**How often:** 22 of 38 common Node built-in calls (58%), every one whose result type is declared in an ambient module. Probes: `p18-node-builtin-grid.mjs`, `p08-e2e-node-builtin-types.mjs`, `p05-library-types-in-registry.mjs`.

**Direction:** emit `import("node:fs").Stats` when the declaration sits in a string-named ambient module, and keep bare names only for declarations with no module parent.

### F2. The editor keeps stale types when a non-target file changes

**Kind:** possible bug.

**The class:** the mapper watches only the target files and `tsconfig.json`, and its warm snapshot never re-reads anything else. When a target imports a module that is not itself a target and that module changes, the registry keeps the old types for results and locals. Editing the target afterwards re-runs the mapper and still returns the old types. Only a new mapper process (a TS server restart, or a fresh `tsc`) sees the change.

```text
watched files: src/app.ts, tsconfig.json
configIdentity changed after editing src/limits.ts: false
loadLimit() result type   before: number | warm cache after edit: number | cold run after edit: string
after ALSO editing the target (mapper re-runs, warm cache): ... loadLimit() result type: number
```

**Why I think it's wrong:** `README.md:167` says the snapshot "updates incrementally via `snapshot.update(...)` on file saves" and that result types come from the unmodified target AST. The update only passes changed targets (`src/contracts.mjs:445-459`), and `scanProject` hashes only targets (`src/content-mapper.mjs:56-59`).

**Why it matters:** in an editor a handler keeps typechecking against a return type that no longer exists, and the error appears only in CI. One-shot `tsc` is correct.

**Why the tests miss it:** the incremental-cache law edits target files only (`warm-cache-reused-and-updated`). `checks/verify.mjs` drives the live LSP without changing a dependency.

**How often:** every edit to a non-target file that a target imports. Probe: `p07-stale-dependency-types.mjs`.

**Direction:** watch the transitive imports of the targets (the program already knows them), and include their content in `configIdentity` and in the snapshot update.

### F3. Types the project declares outside the targets are invisible to the generator

**Kind:** possible bug.

**The class:** the analysis program is built from the target files alone (`src/contracts.mjs:440`), not from the project's `include`. A global interface in a `globals.d.ts`, or a `declare global` block in another module, does not exist in that program. Any expression whose type needs it is marked unportable and cannot be selected, with a reason that points away from the cause.

```text
## global interface in src/globals.d.ts   (the project itself compiles: true)
   "src/app.ts#f:CallExpression:origin:0"  UNSELECTABLE "TypeScript could not determine this type."
```

**Why I think it's wrong:** the project compiles, so TypeScript can determine the type. The registry is meant to carry the types the real program has (`README.md:167`).

**Why it matters:** `env.d.ts`, framework globals, and `declare global` augmentations are ordinary in applications. The user sees "has an unportable type" on a plain interface.

**How often:** 2 of the 3 shapes I tried; the control (same global declared inside the target) works. Probe: `p19-project-ambient-types.mjs`.

**Direction:** add the project's own root files (from the parsed tsconfig) to the analysis program.

### F4. A selector that uses `nth` can move to a different expression without any error

**Kind:** inconsistency between the documented promise and the behavior.

**The class:** `nth` counts expressions with the same function, kind, and name in source order. A refactor that adds an earlier one shifts the numbering. The selector still matches exactly one expression, `tsc` passes when the types agree, and the test now replaces something else.

```ts
// test: "the db read is the second get() in sync()"
const dbRead = select('src/app.ts', (n) => n.callee === 'get' && n.nth === 1 && n)
```

```text
before the refactor: tsc exit=0 | vitest exit=0 | Tests  1 passed (1)
after the refactor : tsc exit=0 | vitest exit=0 | Tests  1 passed (1)
selector resolves to (before): db.get(id)
selector resolves to (after ): cache.get(id)
```

**Why I think it's wrong:** `bench/guides/treatment-guide.md:46` promises that "renaming a callee or adding a second call site causes a loud selection/compile error ... rather than a silent pass", and `README.md:58` recommends `nth` as the way to disambiguate. The promise holds only while `nth` is not used.

**Why it matters:** loud failure on refactor is the property the benchmark log calls the tool's "concrete, high-value engineering property" (`BENCHMARK-LOG.md:66-71`). `nth` is needed more often than it looks, because the descriptor cannot tell these apart:

| Situation | What the visitor sees |
| --- | --- |
| `UserCache.get` and `OrderCache.get` in one file | identical descriptors; only `nth` differs |
| `cache.get(id)` and `db.get(id)` in one function | `callee: 'get'` twice; only `nth` differs |
| class field arrows, `export default function` | `inFunction: '(anonymous)'` |
| any two ternaries in one function | no name at all; only `nth` differs |
| `a + b + c` | the outer `+` is `nth: 0`, the inner `a + b` is `nth: 1` |

6 of the 43 stored treatment tests that used the library used `nth`. Probes: `p14-nth-shifts-silently.mjs`, `p12-selector-vocabulary.mjs`.

**Direction:** give selectors stable things to hold on to (see "Feature ideas": receiver, class, assigned binding, source text), and say plainly in the README and guide that `nth` is positional.

### F5. Which call a replacement applies to depends on who started the worker

**Kind:** design question.

**The class:** `withReplacement` scopes by async context. Work that application code hands to a shared drain loop runs in the context of whoever started the loop, not of whoever enqueued the work.

```text
## drain-loop queue
  A (scoped) enqueued first   -> A got "REPLACED-BY-A", B (unscoped) got "REPLACED-BY-A"
  B (unscoped) enqueued first -> A got "saved:a",       B (unscoped) got "saved:b"
## promise-chain queue
  A (scoped) enqueued first   -> A got "REPLACED-BY-A", B (unscoped) got "saved:b"
  B (unscoped) enqueued first -> A got "REPLACED-BY-A", B (unscoped) got "saved:b"
```

With the drain loop, A's replacement either leaks onto B's work or never runs for A's own work. The two queues behave the same to their callers.

**Two readings:** (a) this is the documented meaning of async-context scoping (`README.md:99-101`) and needs a warning plus a way to notice (F7). (b) Tests need a second scope that is not tied to the async context, for code with shared workers, batchers, and pools.

**Why it matters:** queues are the usual fix for the concurrency bugs this tool is aimed at, and several of the benchmark's calibrated valid fixes are queue designs. A test written against a promise-chain fix can hang or pass vacuously against a drain-loop fix. Probe: `p13-scope-vs-shared-worker.mjs`.

### F6. An instrumented module runs 30 to 120 times slower with no replacement active

**Kind:** untested behavior. No law bounds the work.

```text
sum(2e6)  loop: < + % === ?:   plain 1.5 ms | instrumented, no replacement active 166.9 ms (112x) | inside an unrelated withReplacement 218.7 ms (147x)
fib(27)   recursion            plain 1.4 ms | instrumented, no replacement active  48.9 ms (35x)  | inside an unrelated withReplacement  56.4 ms (40x)
```

Every call, binary operation, and ternary in a target becomes `invoke(id, () => (expr), () => ({captures}))`: two closures and, in `invoke`, a `Symbol.for` plus `globalThis` lookup before the `AsyncLocalStorage` read (`src/runtime.mjs:5-10`, `:102-104`). The comment at `src/runtime.mjs:100` calls this a fast path.

What-if measurements on throwaway copies of the runtime (production untouched):

| Variant | `sum` | `fib` |
| --- | --- | --- |
| current | 123x | 30x |
| registry resolved once per module instead of per call | 33x | 12x |
| a flag check emitted around each point, original expression in the else branch | 9.6x | 1.1x |

**Why it matters:** targets are listed by glob, so a whole `src/` tree pays this in every test, including tests that never use the library. Suites with compute-heavy paths slow down by an order of magnitude or more. The first variant is a one-line change.

**A caution on the numbers:** ratios were 61x to 191x in an earlier run on a loaded machine. Rerun on your hardware before quoting them. Probes: `p10-runtime-overhead.mjs`, `p17-overhead-what-if.mjs`.

### F7. A replacement that never runs is silent

**Kind:** design question.

A test whose action never reaches the selected expression passes with nothing to assert on. The point exposes only `capture` and `withReplacement`.

```text
action that never reaches the point -> result=10, handler fired 0 times, no error, nothing to assert on
```

This is how a test stops testing anything after a refactor moves the call out of the path, and it is the only way to notice F5. Probe: `p04-silent-never-fired.mjs`.

### F8. The runtime accepts capture names that are not locals

**Kind:** possible bug.

**The class:** `invoke` reads `getters[key]` from a plain object (`src/runtime.mjs:106-111`). A name that is not a local resolves through `Object.prototype`.

```text
capture("nope")           -> locals value: undefined
capture("toString")       -> locals value: [object Undefined] (string)
capture("constructor")    -> locals value: {} (object)
capture("hasOwnProperty") -> threw TypeError: Cannot convert undefined or null to object
```

The `TypeError` is thrown from inside the application call.

**Why I think it's wrong:** `README.md:59` says `.capture(...)` "rejects unknown binding names immediately". That is true in the type checker only. Vitest does not typecheck, so a typo runs and yields `undefined`.

**How often:** all 6 names I tried that are not locals were accepted or threw a `TypeError`; none was rejected. 5 of them resolve through `Object.prototype`. Probe: `p03-capture-names-runtime.mjs`. The same probe shows a visitor that returns `true` gets "matched 0", which is correct but does not say what to return.

**Direction:** check names against the point's known captures when the replacement is installed and throw an error that lists the available names.

### F9. The type checker and the runtime disagree about which files exist

**Kind:** inconsistency.

```text
ordinary module                    | types: file present with 1 node(s) | runtime: 1 node(s) instrumented
file with a UTF-8 BOM              | types: file ABSENT  with 0 node(s) | runtime: 1 node(s) instrumented
global script (no import/export)   | types: file ABSENT  with 0 node(s) | runtime: 1 node(s) instrumented
CRLF line endings                  | types: file present with 1 node(s) | runtime: 1 node(s) instrumented
```

For a file with a byte-order mark, `select('src/app.ts', ...)` is a compile error although it works at runtime. For a global script, `README.md:173` says "Global scripts are skipped". The registry does skip them, and the contracts oracle holds that (Law C4, `global-script-ignored`), but the plugin instruments them and adds an `import` to a file that had none. The plugin oracle covers BOM files for instrumentation only. No law compares the set of files the registry lists with the set the plugin registers. Probe: `p06-compile-runtime-parity.mjs`.

### F10. `points.ep` is not validated

**Kind:** possible bug.

```text
missing target path                               -> no diagnostic, file silently absent
{"target": ["src/app.ts"]}                        -> diagnostics=0, watched targets=(none)
{"targets": "src/app.ts"}                         -> diagnostics=0, watched targets=/, <project root>, a, c, p, r, s, t
{"targets": ["src/app.ts"], "tsconfg": "x.json"}  -> diagnostics=0
{"targets": [42]}                                 -> threw TypeError out of openProject
```

A string in place of the array is iterated character by character, which makes the compiler watch `/` and the project root. The existing diagnostic already states the rule ("must contain a JSON object with a "targets" array", `src/content-mapper.mjs:31`); only the object half is checked. A typo leaves the registry empty, and the user is told to check their TypeScript version. 4 of 4 malformed manifests and the missing path produce no diagnostic. Probe: `p06-compile-runtime-parity.mjs`.

### F11. The documented skip rule hides more code than it needs to

**Kind:** improvement to a documented limit (`README.md:175`).

`hasUnsupportedSyntax` (`src/discovery.mjs:65-77`) rejects an expression when `await`, `yield`, `super`, or `?.` appears anywhere inside it, including inside a nested callback or an argument. Wrapping is only unsafe when the `await` or `yield` belongs to the same function, or when the expression is a prefix of an optional chain that continues outside it.

```text
call whose callback awaits            NOT offered: Promise.all(xs.map(async (x) => { await helper(x) }))  |  xs.map(...)
retry(async () => { await ... })      NOT offered: retry(async () => { await helper(1) })
call with an optional-chain argument  NOT offered: helper(s?.userId)
a ?? b?.c                             NOT offered: a ?? b?.c
```

How much real code this hides:

| Code | Candidate expressions | Hidden | Cause |
| --- | --- | --- | --- |
| `bench/tasks/*/src` | 249 | 1 (0.4%) | callback with `await` |
| this repository's `src/*.mjs` | 957 | 69 (7.2%) | all `?.` |
| `bench/*.mjs` | 3,200 | 185 (5.8%) | 179 `?.`, 6 `await` |

Three related limits, each a maintainer decision or a documented limit today:

- **Generic code.** Every expression whose type mentions a type parameter is unselectable (`fn()` inside `retry<T>`, `this.load(k)` inside `Cache<K, V>`). Retries, caches, and queues are where a concurrency tool is most wanted. By a text search, 110 of the 135 handlers in stored treatment tests end in `original()`: they pause and continue. That use needs no portable type.
- **`new X()`** is not selectable, and neither are property reads or the `await` itself.
- **Curried calls.** In `make(a)(b)` the inner `make(a)` is excluded as a callee, though a call result carries no `this`.

Probes: `p01-selectable-coverage.mjs`, `p02-skip-rule-on-bench-sources.mjs`, `p05-library-types-in-registry.mjs`.

### F12. The Vite plugin re-reads every target for every module it sees

**Kind:** untested behavior.

`getPlan` compares every target file with the disk on each `transform` call, before it knows whether the module is a target (`src/plugin.mjs:15-21`, `:50`).

```text
  1 target files: 1000 non-target transform() calls took   11 ms (0.01 ms each)
 50 target files: 1000 non-target transform() calls took  401 ms (0.40 ms each)
200 target files: 1000 non-target transform() calls took 1640 ms (1.64 ms each)
```

At 200 targets and 5,000 modules that is about 8 seconds per cold run on a quiet machine with a warm file cache, and it was 17 times worse under load. Checking only the file being transformed removes the factor. Probe: `p11-scaling.mjs`.

### F13. Smaller findings

| Finding | Evidence |
| --- | --- |
| A captured local can be in its temporal dead zone. `capture('limit')` throws `ReferenceError` inside the application where the uninstrumented code returns 7. Discovery offers every binding declared earlier in the source, not every binding initialized at that point. | `p16-capture-and-original-semantics.mjs` |
| An ambiguous selection is reported only when a method is called on the result. `export const points = [select(...)]` with two matches compiles. | `p15-compile-errors-as-a-user-sees-them.mjs` |
| A local with an unportable type disappears from `capture`'s accepted names with no reason: `'"item"' is not assignable to parameter of type '"id"'`. | same probe |
| The unportable message says the expression "cannot be selected directly". There is no indirect way. | same probe |
| Registry errors have no source mapping (`mappings: []`), so F1 is reported at `points.ep(9,227)`. | `src/content-mapper.mjs:103` |
| The README's Vitest config imports `./src/discovery.mjs` (`README.md:147`), which the package does not export. A consumer has to repeat the targets in `vitest.config.mjs`, as the benchmark does (`bench/run.mjs:586`), and the two lists can drift. `executionPoints()` with no arguments instruments nothing. | `package.json` exports |
| `src/content-mapper.mjs:153-159` attaches `stdin` listeners at import time, so the oracle that imports it gets them too. | file |
| `checks/verify.mjs:318` still says `fromFile()`; `bench/EXECUTION_POINTS_GUIDE.md` is referenced by nothing, shows the old verbose selector, and awaits the overlapping operation while holding the barrier, which the current guide forbids. | `grep` |

### What held

- All baseline checks pass at `b26e2c1`: `pnpm check`, `pnpm test` (353 tests), `pnpm verify` (16 checks), `node bench/run.mjs --self-test` (57 variants, 16 mutants, 8 cheats).
- Listing a module as a target did not change its behavior in any of the seven shapes I expected to break: numeric, `const`, and string enums, a BOM file, a `'use strict'` file, class field initializers with a static block, and parameter defaults with `arguments` and `new.target` (`p09-e2e-instrumentation-breaks-code.mjs`).
- Evaluation order is preserved around a replaced sibling, `original()` evaluates on each call as documented, and it still works after the scope ends (`p16`).
- Types from true globals and from third-party packages resolve (`fetch`, `Map<string, Date>`, `URL`, `NodeJS.Timeout`, `magic-string`, `vite`) (`p05`).
- Typecheck cost does not blow up with file size: 1,600 selectable expressions in one file and 40 `select()` calls typecheck in 0.6 s (`p20-typecheck-cost-vs-file-size.mjs`). Regenerating the registry for 160 target files takes about 0.2 s (`p11`).
- Wrong return types, unknown captures, file-name typos, and callee typos all produce a clear compiler error at the right place (`p15`).

---

## Oracle suites

Gap check at `b26e2c1`, seed 42: 1,472 changes tried, 1,214 noticed, **248 gaps**, 10 changes in functions no oracle owns. All six oracle files pass on the unchanged code.

| Owned file | Gaps |
| --- | --- |
| `src/runtime.mjs` | 0 |
| `src/discovery.mjs` | 0 |
| `src/plugin.mjs` | 0 |
| `src/contracts.mjs` | 216 |
| `src/content-mapper.mjs` | 32 |

Gaps by function: `buildExportIndex` 49, `emit` 44, `generateFileRegistryModule` 31, `isNominalUnexported` 22, `transform` 12, `projectNested` 10, `emitSig` 10, `handleInputChunk` 9, `emitHelper` 8, `renderFileModule` 8, then 16 functions with 6 or fewer.

The picture is consistent: the three files with no gaps produced no correctness finding from my probes (F6 and F12 are about work, which no law bounds yet), and the two files with gaps produced F1, F2, F3, F9, and F10. `AGENTS.md` says green is not done, so these 248 are open work under the existing laws. The largest groups to close first are the ones next to the confirmed defects: how external and ambient names are resolved (`buildExportIndex`, `resolveExternal`, `isAmbientOrGlobal`), and what the mapper does across a sequence of edits (`generateFileRegistryModule`, `transform`, `getSnapshotCache`).

Potential laws that the findings suggest, each needing approval:

1. For every target whose expressions or locals have a type that the project can name, the generated registry typechecks in that project with zero diagnostics. Authority: `README.md:7`. Would have caught F1.
2. For every sequence of edits to targets and to the files they import, the registry the warm mapper returns equals the registry a cold mapper returns. Authority: `README.md:167`. Would have caught F2.
3. For every target file, the set of files and node ids in the registry equals the set the plugin registers at runtime. Authority: the existing parity decision of 2026-11-24, widened from nodes to files. Would have caught F9.
4. For every manifest, either the registry reflects exactly the listed targets that exist, or a diagnostic names what is wrong. Authority: `src/content-mapper.mjs:31`. Would have caught F10.
5. For every capture name passed at runtime, the name is a capture the point offers, or installing the replacement throws. Authority: `README.md:59`. Would have caught F8.

A separate review of the six oracle files is in progress; its results will be added here.

---

## Feature ideas

Ordered by how much evidence there is that users need them.

1. **A built-in pause.** By a text search of the stored trials, all 43 treatment tests that used the library wrote their own barrier, and 110 of 135 handlers end in `original()`: they wait and continue. Something like `const gate = point.pause(); const a = gate.run(() => op()); await gate.reached; ...; gate.release()` removes 15 lines from every test and from the guide, and removes the deadlock the guide has to warn about.
2. **Reach counts and a strict mode.** `point.calls`, or `withReplacement` failing when the handler never ran unless told otherwise. Closes F7 and makes F5 visible.
3. **`npx execution-points list <file>`.** Print every selectable expression with its descriptor, line, and source text. A human gets this from editor completion; an agent in a terminal has to guess, and the two treatment losses in the last run were wrong guesses about `inFunction`.
4. **Stable selector fields.** `receiver` (`cache` versus `db`), `inClass`, `assignedTo` (the binding a call initializes), `text`, and `line`. Each removes a reason to use `nth` (F4).
5. **Pass-through for unportable types.** Give an unportable expression an opaque result type that only `original()` can produce. The expression can then be paused or observed, which is the main use, and generic code stops being off limits (F11).
6. **An unscoped replacement** with a disposer, `using r = point.replace(handler)`, for code with shared workers (F5) and for the common test that runs one scenario at a time.
7. **Fault-injection shorthands:** `point.throws(error)`, `point.returns(value)`, and a hit index in the context so a test can fail the second execution only.
8. **`new X()` and `await` as selectable kinds.** `new Date()` and `new WebSocket()` are common seams. Selecting an `await` gives a pause after the promise settles, which is what the benchmark's own grader engine does by rewriting every `await` (`bench/graders/yield-plugin.mjs`).
9. **Schedule exploration.** The grader engine enumerates interleavings over yield points. Offering that on top of `select()` (pick the points, get every ordering, or a seeded sample) would turn a hand-written two-operation race test into a search. This is the largest idea here and the one closest to the tool's purpose.
10. **Source mappings for the registry**, so registry errors point at the target expression and go-to-definition on a selected node lands there.
11. **One source of truth for targets:** let `executionPoints()` read `points.ep` by default, and publish a JSON schema for the manifest (F10, F13).

---

## Benchmark

### What the stored data shows

Three paid runs, 138 started trials, 69 matched blocks. Numbers below are recomputed from the three `results.jsonl` files.

| Task | Stratum | Control solved | Treatment solved | Treatment used the library | Hidden grader passed (C / T) |
| --- | --- | --- | --- | --- | --- |
| `stale-cache` | A closed-module | 1/6 | 5/6 | 6/6 | 6/6, 6/6 |
| `token-session` | A closed-module | 4/7 | 7/7 | 7/7 | 7/7, 7/7 |
| `double-submit` | A closed-module | 6/7 | 6/7 | 7/7 | 6/7, 6/7 |
| `cancel-commit` | C real-async | 1/7 | 4/7 | 2/7 | 7/7, 7/7 |
| `debounce-search` | C real-async | 7/7 | 7/7 | 2/7 | 7/7, 7/7 |
| `stale-cache-seam` | B io-seam | 7/7 | 6/7 | 3/7 | 7/7, 7/7 |
| `single-flight` | B io-seam | 6/7 | 7/7 | 2/7 | 7/7, 7/7 |
| `retry-storm` | B io-seam | 7/7 | 7/7 | 4/7 | 7/7, 7/7 |
| `event-order` | B io-seam | 7/7 | 6/7 | 4/7 | 7/7, 7/7 |
| `cross-module-transfer` | B io-seam | 7/7 | 7/7 | 6/7 | 7/7, 7/7 |

What this supports:

1. **Fix quality is at ceiling in both arms.** The hidden grader passed 68 of 69 trials in each arm, and 80 of 80 in the cheaper-model run. 22 of the 23 unsolved trials failed `adequateReproduction`; the other one failed the hidden grader. The benchmark therefore measures whether the agent's regression test is adequate under the harness's gates. It says nothing about whether the tool helps agents find or fix bugs, because nothing here was hard to fix, even for `claude-haiku-5.5` at low reasoning.
2. **Six of ten tasks carry no information.** `debounce-search`, `retry-storm`, and `cross-module-transfer` are 7/7 in both arms, and three more differ by one trial. All the signal is in `stale-cache`, `token-session`, and `cancel-commit`.
3. **The effect that exists is the capability one.** In Stratum A, where plain Vitest has no legal seam, treatment solved 18 of 20 and control 11 of 20. The protocol rightly keeps this out of the primary test. In the equal-capability strata the two runs gave 1/0 and 3/2 discordant pairs.
4. **`cancel-commit` is weak evidence for the tool.** Treatment won 4 to 1, but only 2 of the 7 treatment agents used the library there. Both of those solved it; so did 2 of the 5 who did not, so half of treatment's wins came without it.

### Threats to validity

| Threat | Detail | Could favor |
| --- | --- | --- |
| The treatment guide replaces the `vi.mock` recipe instead of adding to it | `control-guide.md:22-43` has a worked `vi.mock` example and a fake-timers note. `treatment-guide.md` has neither; it names `vi.mock` once in the first paragraph. The contrast is "library recipe instead of module-mock recipe", not "library available". In the io-seam stratum 19 of 35 treatment agents used the library where `vi.mock` is the natural tool. | either |
| The task sources avoid everything the library cannot do | No generics, no optional chaining, one task with Node built-ins, about 60 lines per file. 0.4% of candidate expressions are hidden by the skip rule against 6 to 7% in this repository's own code (F11). F1 and F3 cannot occur in these tasks. | treatment |
| `contractTypecheckPass` can only fail in treatment | 0 failures so far. With F1 it fails for a fix that touches `fs.stat` or similar. | control |
| Selector coupling was fixed by changing the guide after seeing the losses | Both control-only wins in the last run were `inFunction` bound to a new helper; `72d8bc8` then told agents not to do that. A rerun measures the tuned guide. That is legitimate product iteration, but the next run is a new experiment, not a replication. | treatment |
| Power | The protocol computes 78 to 231 blocks for 80% power at the observed discordance (`bench/PROTOCOL.md:60`). The primary strata had 21 and 28 blocks. | neither |

An independent audit of the harness, graders, and statistics is in progress; its results will be added here.

### Should the benchmark be rerun

Not as a whole, and not yet.

**What actually changed since the last run** (`git diff da61474 b26e2c1 --stat`): `src/contracts.mjs`, `src/runtime.d.ts`, twelve lines of `bench/guides/treatment-guide.md`, tests, and docs. `src/runtime.mjs`, `src/plugin.mjs`, and `src/discovery.mjs` are unchanged. An agent's test behaves at runtime exactly as before. The changes can affect two things: how many turns an agent spends getting a selector past the type checker, and whether small models couple selectors to helpers they invent. The second one cost treatment 2 of 40 blocks.

**Why a full rerun is the wrong next step:**

1. It cannot answer the primary question. At about 12% discordance in the equal-capability strata, the same 69 blocks would produce about six discordant pairs, and significance needs all six on one side.
2. Whatever it produced could not be pooled with the earlier runs. The harness refuses mismatched `toolSha256`, correctly.
3. The library should change again first. F1 is a type-generation bug that sits in the treatment arm's grading path. Fixing F1 to F3 changes `src/contracts.mjs`, which would orphan a run made today in the same way.
4. The design problems above (ceiling tasks, the guide contrast, task realism) would be carried into another 2,700 credits of data.

**What I would do instead, in order:**

1. Fix F1, and decide F2, F3, and the guide question. Then freeze the library and guides at a tagged commit.
2. Run a small check of the one thing the recent changes target: `claude-haiku-5.5` at low and medium on the tasks where treatment lost or adopted the library heavily (`stale-cache-seam`, `event-order`, `stale-cache`, `cross-module-transfer`), three replicates each (`--trials 3`). That is 48 trials and roughly 60 credits at the haiku rates observed. Label it exploratory. It tells you whether the selector-coupling failure is gone.
3. Design v3 before spending on frontier models. Replace the six ceiling tasks with tasks that have headroom on the fix itself and that look like ordinary code (generics, `?.`, Node types, several hundred lines, more than one module). Make the treatment guide the control guide plus the library section. Pre-register reproduction quality as its own endpoint, since that is what the data moves. Put replicates where discordance is.
4. Then run one pre-registered matrix sized from the power table, across the model set you care about.

If you want a number sooner than that, step 2 alone is cheap and honest. Rerunning all five models on all ten tasks today would mostly reproduce the ceiling.

---

## Probe index

| Probe | Shows |
| --- | --- |
| `p01-selectable-coverage.mjs` | F11: which expression shapes are offered |
| `p02-skip-rule-on-bench-sources.mjs` | F11: share of real code hidden |
| `p03-capture-names-runtime.mjs` | F8 |
| `p04-silent-never-fired.mjs` | F7 |
| `p05-library-types-in-registry.mjs` | F1, F11 (generics), what held for globals and packages |
| `p06-compile-runtime-parity.mjs` | F9, F10 |
| `p07-stale-dependency-types.mjs` | F2 |
| `p08-e2e-node-builtin-types.mjs` | F1 through real `tsc` and Vitest |
| `p09-e2e-instrumentation-breaks-code.mjs` | what held: instrumentation preserves behavior |
| `p10-runtime-overhead.mjs`, `p17-overhead-what-if.mjs` | F6 |
| `p11-scaling.mjs` | F12, registry generation time |
| `p12-selector-vocabulary.mjs`, `p14-nth-shifts-silently.mjs` | F4 |
| `p13-scope-vs-shared-worker.mjs` | F5 |
| `p15-compile-errors-as-a-user-sees-them.mjs` | F13, what held for compiler messages |
| `p16-capture-and-original-semantics.mjs` | F13 (dead zone), what held for `original()` |
| `p18-node-builtin-grid.mjs` | F1: 22 of 38 |
| `p19-project-ambient-types.mjs` | F3 |
| `p20-typecheck-cost-vs-file-size.mjs` | what held: typecheck cost |

`probes/lib.mjs`, `probes/types.mjs`, and `probes/e2e.mjs` are shared helpers. `e2e.mjs` builds a real consumer project with the package copied into its `node_modules`, the way `bench/toolchain.mjs` does, and runs the real `tsc` and Vitest on it.

## Changelog

- 2026-11-24: first version at `b26e2c1`. Library findings F1 to F13, gap check, feature ideas, benchmark assessment from the stored results. Harness audit and oracle-file review still running.
