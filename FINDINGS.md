# Findings

Full review of the library, the oracle suites, and the benchmark, started at `b26e2c1` on 2026-11-24. This file is kept current; the changelog at the bottom says what changed and when.

Every finding names the probe that shows it. Probes are small scripts in `probes/` that call the unchanged production code. Run any of them from the repository root, for example `node probes/p08-e2e-node-builtin-types.mjs`. They build their throwaway projects under the OS temp directory and write nothing into the repository.

The review started read-only. Since the decisions below, the findings have been fixed and the feature ideas built, oracle first. Each finding's heading says whether it is fixed; the text under it keeps what the review found, because the probes and the laws were written against that. The laws belong to the maintainers: what is not confirmed yet is listed under "Still open".

## Short version

Where things stand on 2026-11-25:

- **Every finding from F1 to F18 is fixed or decided; F19 is new and open (below).** F18 is fixed on your decision: an expression that several ways lead to is one selection, and its point captures every local that any way captured (`p33`).
- **A node no longer says where it is written.** On your decision `line` and `text` are gone from what a visitor is handed, on expressions and on containers; `object` stays. `execution-points list` prints the line and the text as before, to find an expression by.
- **The gap check finds nothing.** All 2,117 small changes it tries in the six source files are noticed by a law, and no function is without an owner (commit `eca441d`, 16 oracle files, seed 42). At the start it noticed 1,214 of 1,472.
- **Zero gaps was not the end.** The gap check cannot change a type declaration and does not invent a wrong design. So I wrote 19 plausible wrong implementations and 38 wrong type declarations by hand. Three of the 19 and four of the 38 passed every oracle: a captured number that follows the application's variable, a captured object that is a copy, a captured local that can be assigned, a single point accepted where a list belongs. Each is held by a law now, and so is the one that was left, F18: 31 of 31 wrong implementations and 44 of 44 wrong declarations are rejected. The same work found that the compile error for `pause()` on an expression that is no promise never printed its reason; it does now.
- **The API changed shape on your decisions:** TypeScript sources built with `tsdown`, replacements that must run, `pause`, `replace` with `using`, `interleavings` as a generator of orders, selection through a Babel-style visitor object whose nodes carry what the code calls things, `execution-points list`.
- **Listing a module as a target costs nothing until a test replaces something in it** (F6: 1.0x, from 30 to 120 times slower).
- **The benchmark harness can measure the new API since v2.5.** v2.4 recognized use of the library only by `withReplacement`, and graded three of Vitest's assertion forms as plain errors. Both are fixed, each with a self-test case that fails on v2.4; see "The harness on the new library".
- **The full benchmark run on the current library is done** (1,050 trials, harness v2.6, 2026-11-24 to 25, at your request in the benchmark thread; the three earlier runs are retired). Where plain Vitest can reach the bug, the library changes nothing that this run can measure: of 245 blocks, 216 are solved without it, 221 with it offered, 220 with it required. Where plain Vitest cannot, it is 64, 87 and 91 of 105, and that whole difference is one task, `stale-cache` (8, 34 and 35 of 35). I recounted every figure quoted in this file from the stored rows (`p34`).
- **F19, new, from that run: a test written with the library names the helper its expression calls, and breaks when that name moves.** All 1,019 selections that agents wrote compare `callee`. Renaming the helper stopped 112 of the 195 library tests that met such a refactor (`matched 0`), and a valid fix that calls the helper at two places was rejected by 71 of 137 (`matched 2`). Every break is loud; no library test ever passed on buggy code. A selector through the public function and the constant survives the rename and no agent wrote one; nothing survives the second call site today.

### Where the review started (`b26e2c1`)

- **The library had one defect that had to be fixed before anything else.** A single expression or local in any target file whose type comes from a Node built-in module (`fs.Stats`, `http.Server`, ...) or is a member of the project's own enum made `tsc` fail for the whole project (F1). 22 of 38 everyday Node calls triggered it, and so did an optional enum parameter. The benchmark tasks happen to avoid both.
- **Two more type-generation defects** left the editor with stale types (F2) and made expressions unselectable when the project declares global types outside the targets (F3).
- **The oracles were green but held less than that suggests.** The gap check missed 248 of 1,472 small code changes (17%), all in `contracts.mjs` and `content-mapper.mjs`. It noticed every small change in `runtime.mjs`, `discovery.mjs`, and `plugin.mjs`, yet seven deliberately wrong versions of the runtime, discovery, plugin, and type contract passed every oracle file. No law compiled the generated registry, which is why F1 went unseen.
- **Listing a module as a target made it run 30 to 120 times slower** even when no test replaced anything (F6).
- **A second type-generation defect hit the benchmark directly.** A type that cannot be written as a helper left its name behind with no definition (F16). `AbortController` is one, so the benchmark's own reference fix for `cancel-commit` failed the treatment-only typecheck.
- **The benchmark measures regression-test quality, not bug fixing.** Across all 138 stored trials the hidden grader passed 68 of 69 in each arm. Every difference in `solved` comes from one component, `adequateReproduction`, and on `cancel-commit`, the only equal-capability task with signal, that component changed between identical re-gradings.

## Decisions

Made on 2026-11-24 by Manuel Schiller:

- `select` replaced the earlier query-string API. `AGENTS.md` is corrected.
- F6: performance must be optimal, indistinguishable from uninstrumented code. Done; see F6.
- `original()` evaluates the expression on every call. `AGENTS.md` and the README no longer call it provisional.
- All eight potential laws are accepted, every finding is to be fixed, and every feature idea is to be built with oracle coverage. Status is tracked in "Work in progress" below.
- F7: a replacement that never runs must be loud. All four API options are built; for an asynchronous action the returned promise stays the action's own and the test fails at its end through a Vitest hook. Done; see F7.
- An implicit `any` is an error: `strict` is on, and the type check is being widened to the oracle test files (F17). There is no separate check for an `any` that a library declaration hands over; `checks/no-any.mjs`, which I had added for that, is removed again at your request.
- The library moves to TypeScript sources built with `tsdown`, and argument checks that the compiler already makes are dropped from the runtime. Done for the runtime (`src/runtime.ts`, `src/vitest.ts`, build into `dist/`); the other four modules follow when the two delegated branches, which edit them, are merged. The rule applied: what the compiler rejects is not checked again at run time; what depends on run-time state stays. Removed: the `typeof` checks on `visitor`, `handler`, `action`, and on the points and action of `interleavings`. Kept: everything about selections, capture names, schedules and replacements that never ran, and the value check on `times` and `on`, because the compiler accepts any number there.
- The four laws the type-generation work had added or reworded are approved as worded, and so are the details of `interleavings` (`order.run`, `schedule`, `released`, the `schedule` and `choose` options, which misuse throws).
- Selection gets a second form, built on Babel's visitor pattern: an object keyed by node type, with `Function` and `Class` (Babel's alias keys) as nodes you `traverse` into. The callback form `select(file, (n) => …)` stays, with `inFunction` as it is. `inClass` is not added: traversal says "inside". Evidence that the compiler can follow traversal and cannot follow a parent chain: `p30`.
- Schedule exploration is a primitive to compose, not a function that takes the checks: `interleavings(points)` is a generator of orders, and the caller runs the scenario and checks it in the loop body. Rebuilt that way; the first form with `run`, `check`, `setup` and `limit` options is gone.
- "keep object, drop line and text from the selectors." Done (`eca441d`). I took "the selectors" to include the containers, so `Function`, `Class` and `VariableDeclarator` nodes lost their `line` too; say so if you meant expressions only. Discovery still records line and text, because `execution-points list` prints them.
- F18, "yes fix this". Built as the option I had recommended: the captures of all ways are merged, on the runtime's side and on the compiler's. Done (`eca441d`, `d279bda`); see F18.
- Benchmark, decided by you in the benchmark thread and reported to me by it. A failed assertion inside `order.run(...)` counts as a reproduction (D-20). `expect.assertions`, `expect.hasAssertions` and a snapshot mismatch count as failed assertions (D-21). The three stored runs are retired as evidence ("drop all store previous runs, they are not relevant anymore"). A third arm, `required`, tells the agent to write the regression tests with the library (D-23). And the run itself: "run the full run with all models etc when you are done setting this up. i want the full results."
- Benchmark, 2026-11-25: when the fifth replicate stopped on a full disk during grading, you chose to run it again. The registered rule (`D-24`) says a stopped replicate ends the series and the rows are analyzed as written; the benchmark thread did not name that rule when it put the options to you. Both analyses are in `BENCHMARK-LOG.md`, and neither primary test rejects in either.

Still open:

0. Laws the discovery and plugin work reworded or added under the direction you gave, with wording that is the delegate's. Confirm or strike: discovery D1 (a call is also selectable as the callee of `new` and as a template tag; a file with no import or export indexes nothing) and D3 (captures are exactly the locals initialized on every reach; `var` is treated like `let`); plugin P1 to P3 (global scripts return `null`; the header goes behind leading directives; a target is read only by the transform that instruments it), P5 (instrumented code does what the module does as written), P6 (without `targets` the plugin follows `points.ep`; a manifest the schema does not describe stops the build), P7 (the `config()` hook adds the setup module); and the two laws of the `list` command (it prints exactly what the plugin registers; exit codes 1 and 2).
1. One name inside the selector form that your decisions did not fix: `VariableDeclarator` as a third kind of node to traverse into (for "the call that initializes `total`"). It is built as a proposal and listed in the laws' limits. `object` is decided (kept), and so are `line` and `text` (dropped).
2. New benchmark tasks: which, and in which stratum.
3. The benchmark sequence at the end of this file. Overtaken on 2026-11-24: you asked the benchmark thread for a full run on the current library, which follows a sequence of its own.
4. Your global pnpm broke during this work (see "Incidents" below); say whether I should repair it.
5. The wording of the laws written or changed today under your direction that every feature gets oracle coverage. Their rules are the README's and your decisions; the sentences are mine. The five of `tests/types-point.oracle.property.test.ts` (values, waiting, options, results, argument kinds) and `runtime-captured-values`. And the three changed for the two decisions of the evening: `plugin-registers-places-and-containers` (a registration has exactly `id`, `kind`, `inFunction`, `nth`, `callee` or `operator`, and `object`; a container exactly `type`, `name` and what is inside it), `runtime-visitor-object` and `types-visitor-object` (no `line`, no `text`; the captures of all ways; each captured local read once).
6. One clause in `types-visitor-object` that you did not ask for: the compile error for reading a local that no way captured shows the locals the point does have (`Readonly<{ each: string; }>`). My change for F18 had made the compiler print a type's name there instead, and no oracle noticed, so I made the snippet ask for it. Strike it if a message is not something you want a law about.
7. F19: what to do about tests that are tied to a helper's name. Three things are possible and none is built: say in the README and the guide to select through the public function and what the value is bound to; a point that stands for several expressions, so that a second call site is no ambiguity; and `interleavings` as the recipe for two operations that race, where the guide teaches `pause`. The second is an API change and yours to decide.
8. Harness defects the run showed, reported by the benchmark thread and not fixed: a crash during grading leaves trials that cannot be re-graded; nothing checks free disk space or load before a run; the agent CLI's version is read once per run; `bench/analyze.mjs` hangs in its power section when the discordant blocks split near evenly; `bench/export-report.mjs` renders two arms; `toolSha256` hashes `src/` and `package.json`, not what a workspace receives. The guide and instruction changes for the offered arm are also still to come from that thread.

## Work in progress

| Item | State |
| --- | --- |
| F6 fast path | done |
| `original()` settled, `AGENTS.md` corrected for `select` | done |
| F7 loud replacements: strict by default with `times` and `on`, built-in pause, `point.replace()` with `using`, `point.calls`, `call` in the context; F8 capture-name checks; shorthands `returns`, `throws`, `resolves`, `rejects`; F5 covered by `replace` | done |
| Type-level laws for the new API (`pause` only on promises, option and value types, results, argument kinds) | done: `tests/types-point.oracle.property.test.ts`, five laws over 741 snippets written from rules; 37 of 37 hand-made wrong declarations rejected |
| What a captured local holds, and that it cannot be assigned (potential laws 7 and 8) | done: `runtime-captured-values`, and five more histories in the type oracle's capture law |
| Treatment guide and benchmark witnesses using the new API | done: the guide's library section teaches `pause`, the strict default, `list`, the visitor form and `interleavings`; the witness uses `pause`; the self-test passes |
| An expression whose type cannot be written can be selected and passed through | done; open: such an expression cannot be paused, because the registry cannot say that its value is a promise |
| `new X()` and `await` as selectable kinds (feature idea 8) | not built. `new` is like a call. `await` cannot be wrapped the way the others are, so it needs a design first |
| F1, F2, F3, F10, F15, F16, registry half of F9; potential laws 1, 2 and 4; registry source mappings; an opaque result for unwritable expressions | merged; gaps in `contracts` and `content-mapper` went from 248 to 4, all four an endless loop in the mapper's frame reader |
| Benchmark harness fixes from the audit (harness v2.4) | merged; since the type-generation merge `--self-test` passes every check |
| Benchmark harness v2.5: library use recognized by any operation, `npx execution-points list` in a treatment workspace, a classifier that reads the error's real name, no bench process writing `dist/` | merged (`9a8e0a9`); `--self-test` on the merged tree: 156 check lines pass, 0 fail |
| F14 dead-zone captures, F11 skip rule, F12 plugin re-reads, plugin half of F9, `executionPoints()` reading `points.ep`, manifest schema, the `list` command, the plugin adding the Vitest setup module | merged |
| Selection by a visitor object with nested traversal (F4), plus the receiver of a member call (`object`); `list` shows `object=` and `inside=` | done through discovery, plugin, runtime, registry and CLI, with five new oracles; no gap left in it. `line` and `text` were selector properties too and were removed again on your decision (`eca441d`) |
| F18: one expression reached on several ways with different captures | done: one selection that captures what any way captured, in the runtime and in the types (`eca441d`, `d279bda`) |
| Benchmark harness v2.6 (grading decisions D-20 and D-21; the agent CLI refused the guide's `npx execution-points list`, D-22; a third arm that requires the library, D-23) and the full run on the current library (D-24) | done and merged (`007fd78`); `--self-test` on the merged tree, run by me: `Self-test PASSED: 159 check lines passed, 0 failed`. The run's figures are recounted from the stored rows by `p34` |
| Every file under `tests/` type-checks under `strict`, without `any` (F17) | done |
| Schedule exploration: `interleavings(points)` as a generator of orders, with `schedule`, `choose`, and the `InterleavingFailure` error | done |
| Move to TypeScript built with `tsdown`; drop run-time argument checks the compiler makes | done: every module in `src/` is TypeScript, the package ships `dist/`, and the benchmark self-test passes on it |

---

## Library findings

Ordered by how much a user would be hurt.

### F1. The registry names types that do not resolve, and `tsc` fails for the whole project (fixed)

**Fixed 2026-11-24.** The registry now writes a type the way it resolves from the registry's own position: `import("fs").Stats`, `import("./src/app").Status.Ok`. `p18` now prints 0 of 38 (it was 22 of 38). The red run also showed four more forms of the same class, fixed with it: a member of a private enum, `T[K]` and `keyof T` written raw, `Uppercase` without its argument, and `typeof Class` written as the instance type. The contracts oracle went red first (38 of 106 tests) and compiles the generated registry as `.ts` now, which is what was missing.

**Kind:** possible bug. For Node built-ins the behavior is what an adopted law prescribes, so the law is part of the finding.

**The class:** the generated registry writes some types by a name that means nothing where the registry is compiled. Any selectable expression, or any local in scope of one, with such a type breaks the typecheck of the whole project, including tests that never select that expression. Three forms:

| Type of the expression or local | Emitted | Result |
| --- | --- | --- |
| declared inside a `declare module "..."` block, which is how `@types/node` declares nearly everything | `Stats` | `TS2304: Cannot find name 'Stats'` |
| a member of the project's own exported enum, or a union of members such as an optional enum parameter | `Status.Ok`, `(undefined \| Status.Ok \| Status.Err)` | `TS2503: Cannot find namespace 'Status'` |
| a bare name that the library also exports (`vm.createContext()` returns `Context`) | `Context` | binds to the library's own `Context<Result, Locals>` |

Bare names are right only for true globals (`Map`, `URL`, `NodeJS.Timeout`).

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

Expected: exit 0, as for the same project without `src/files.ts`. Observed: exit 2. Vitest still passes, so only the typecheck tells you. The enum form needs no dependency at all:

```ts
// src/status.ts, listed in points.ep
export enum Status { Ok, Err }
export function describe(status?: Status) { return String(status ?? Status.Ok) }
```

```text
points.ep(9,303): error TS2503: Cannot find namespace 'Status'.
```

**Why I think it's wrong:** `README.md:7` says the content mapper works with `tsc --noEmit --runExternalCode`. `BENCHMARK-LOG.md:107` records the same failure for `Timeout` and the decision to fix it by qualifying the name (`NodeJS.Timeout`); `qualifyAmbientName` (`src/contracts.mjs:96`) only walks namespaces with identifier names, so `declare module "fs"` is skipped. That skip is written into Law C3 of the contracts oracle, which says ambient types get their qualified name "ignoring declare global and string-literal module wrappers" (`tests/contracts.oracle.property.test.ts:669`). The law states the algorithm instead of the promise a user relies on, which is that the registry compiles.

**Why it matters:** most server code touches `fs`, `http`, `child_process`, `crypto`, or `stream`. One call anywhere in a target is enough. In the benchmark this can only hurt the treatment arm, because `contractTypecheckPass` runs only there; `cancel-commit` imports `node:fs/promises`, so a fix that calls `stat()` or `open()` would fail the treatment trial for a reason the agent cannot see. It has not happened in the 69 stored treatment trials.

**Why the tests miss it:** nothing compiles the registry. The contracts oracle compares the emitted text with expected strings. The types oracle does compile, but it adds the registry as a `.d.ts` file with `skipLibCheck` on and keeps only the diagnostics of the test snippet (`tests/types.oracle.property.test.ts:114`, `:148`, `:157`), so an error inside the registry cannot surface.

**How often:** 22 of 38 common Node built-in calls (58%), every one whose result type is declared in an ambient module; and both enum shapes I tried. Probes: `p18-node-builtin-grid.mjs`, `p08-e2e-node-builtin-types.mjs` (real `tsc`, both forms), `p21-registry-type-fidelity.mjs`, `p05-library-types-in-registry.mjs`.

**Direction:** emit `import("node:fs").Stats` when the declaration sits in a string-named ambient module, anchor enum members to their enum's import path, and keep bare names only for declarations with no module parent. The law to hold it is potential law 1 below.

### F2. The editor keeps stale types when a non-target file changes (fixed)

**Fixed 2026-11-24.** The mapper watches the tsconfig, the targets, and every project file the analysis read, and its identity changes when one of them does. `p07`: the warm result after editing an imported file is now `string`, the same as a cold run.

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

### F3. Types the project declares outside the targets are invisible to the generator (fixed)

**Fixed 2026-11-24.** The analysis program holds the tsconfig's own files. `p19`: a global declared in another file now gives `result: ("EU" | "US")` instead of an unselectable expression.

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

### F4. A selector that uses `nth` can move to a different expression without any error (fixed)

**Fixed 2026-11-24**, by the decision "Nested traversal, keep callback too". A selector can now say where an expression stands instead of counting: `select(file, { Function: (fn) => fn.name === 'checkout' && fn.traverse({ CallExpression: (call) => call.callee === 'get' && call.object === 'cache' && call }) })`. A call made on an object also carries that object, as `object`. `nth` is still there and still positional; nothing needs it any more to tell `cache.get` from `db.get`, or one function's call from another's. For some hours every expression carried `line` and `text` as well. You had them dropped: a node says what the code calls things and not where it is written, and a selector by line breaks when a line is added above. Where two expressions differ in nothing a node carries, `nth` is what tells them apart, and `execution-points list` shows which is which. The compiler follows each `traverse` (`p30`), so a name that is not inside is a compile error. Four new oracles hold it: what discovery records, what the plugin registers, what the runtime selects, and what the compiler knows.

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
| `this.handler!(1)`, `(client.send)(2)`, `client[key](3)` | `callee: '(anonymous)'` |
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

**Resolved 2026-11-24, both ways.** `withReplacement` keeps its meaning, and a replacement that never ran now fails the test (F7), so a scope that missed its work is noticed. `point.replace(handler)` is the second scope: it applies in every async context of the worker until it is restored. The probe shows the server and the polling loop covered by it.

**Who is affected:** any test whose work runs in an async context that began before the scope. Unit-style tests that call a function directly are not.

| Application shape | A replacement around the test's call |
| --- | --- |
| HTTP server started in `beforeAll`, test calls it with `fetch` | does not apply |
| polling loop (`setInterval`) started at startup | does not apply |
| batcher where another caller opened the batch | does not apply |
| drain-loop queue started by another caller | does not apply, or leaks onto the other caller |
| event listener with a synchronous `emit` | applies |
| mutex with a waiter list | applies |
| callback registered earlier, called inside the scope | applies |
| HTTP server started inside the scope | applies |

The first row is the ordinary integration test. In the benchmark it never showed: every calibrated valid fix that queues work uses a promise chain. Probes: `p13-scope-vs-shared-worker.mjs`, `p23-who-is-outside-the-scope.mjs`.

### F6. An instrumented module ran 30 to 120 times slower with no replacement active (fixed)

**Kind:** was untested behavior with no law bounding the work. Fixed on 2026-11-24 under the decision that performance must be optimal, indistinguishable from uninstrumented code.

**Before.** Every call, binary operation, and ternary in a target became `invoke(id, () => (expr), () => ({captures}))`: two closures and a registry lookup per evaluation, whether or not any test used the file.

```text
sum(2e6)  loop: < + % === ?:   plain 1.5 ms | instrumented, no replacement active 166.9 ms (112x)
fib(27)   recursion            plain 1.4 ms | instrumented, no replacement active  48.9 ms (35x)
```

**After.** Each function body is emitted twice, as written and wrapped, and decides once per call which to run by reading a flag of its own. The flag turns on when a test installs a replacement for one of that function's own expressions, so other functions of the same file stay on their original statements.

```text
sum(2e6)  loop: < + % === ?:   plain 1.3 ms | listed as a target, untouched 1.3 ms (1.0x) | a replacement is active in another function of the file 1.3 ms (1.0x)
fib(27)   recursion            plain 1.2 ms | listed as a target, untouched 1.2 ms (1.0x) | a replacement is active in another function of the file 1.2 ms (0.9x)
```

Runs of the recursion case vary between 0.9x and 1.2x. A function whose own expression is being replaced pays for the replacement itself, which is the point of installing one.

**Why one decision per call is sound.** A call's async context is fixed when the call begins. If no replacement exists for the function's expressions at that moment, none can apply to that call later, across `await` too. Code that can be resumed or evaluated in another context (a generator or constructor body, an expression-bodied arrow, a parameter default, a field initializer, the module's top level) decides at each outermost selectable expression instead.

**What made the last factor of 1.5.** Measured on hand-written variants (`probes/p17-overhead-what-if.mjs`): a flag read from a typed array, from a list, or from a module-level `let` costs the recursion case 1.3x to 1.8x. Only a read that V8 can treat as a constant is free. So each function's flag is an object with a shape of its own, held in a constant of its own; setting one flag then leaves the others constant.

**The laws that hold it.** Plugin Law P4 (`tests/plugin.oracle.property.test.ts`): no runtime call and exactly one flag read per ordinary call until a replacement is installed for one of the function's own expressions, over fourteen code positions, including work that starts before the first replacement and continues after it. Runtime Law 5: a flag is on exactly when a replacement was ever installed for an expression of its home, in every registration of the file. A new oracle, `tests/runtime-copies.oracle.property.test.ts`: every copy of the runtime loaded in one worker is the same runtime. The plugin's source map is now checked too: every copy of an expression maps back to where it is written.

**Evidence.** On the unchanged code the new laws failed in three oracle files (plugin 70 of 96 tests, runtime 12 of 113, runtime copies 28 of 30). With the change all seven oracle files pass, and the gap check over `runtime.mjs`, `discovery.mjs`, and `plugin.mjs` reports 626 changes tried, 626 noticed, 0 gaps. `pnpm check`, `pnpm verify`, and the bench self-test pass. `probes/p24-fast-path-semantics.mjs` runs the same 7 behavior tests through real Vitest on the old and the new code with the same result.

**What it costs.** The emitted code is about twice the size of the wrapped form alone. The plugin no longer uses `magic-string`; it writes its own source map so that both copies of each expression map back to the original.

Probes: `p10-runtime-overhead.mjs`, `p17-overhead-what-if.mjs`, `p24-fast-path-semantics.mjs`.

### F7. A replacement that never runs is silent

**Kind:** design question.

A test whose action never reaches the selected expression passes with nothing to assert on. The point exposes only `capture` and `withReplacement`.

```text
action that never reaches the point -> result=10, handler fired 0 times, no error, nothing to assert on
```

This is how a test stops testing anything after a refactor moves the call out of the path, and it is the only way to notice F5. Probe: `p04-silent-never-fired.mjs`.

**Fixed 2026-11-24 under the decision that it must be loud.** All four options were built:

1. **Strict by default.** `withReplacement(handler, action, options?)` fails when the handler never ran. `{ times: 0 }` asserts the expression is not reached and fails even when the application swallows what the handler throws; `{ times: 2 }` means exactly twice; `{ times: 'any' }` is the old behavior; `{ on: 2 }` or `{ on: [1, 3] }` picks the evaluations the handler takes, and the handler sees which one it is on as `call`. A synchronous action throws as it returns. An asynchronous action gets its own promise back and the test fails when it ends, through the Vitest setup module `execution-points-prototype/vitest`; `verifyReplacements()` is the same check for other runners.
2. **A built-in pause.** `const pause = point.pause(); const a = pause.run(() => op()); await pause.reached; ...; pause.release()`. `reached` rejects as soon as the action finishes without reaching the expression, with the action's own error as the cause when it failed. A pause still holding at the end of the test fails it.
3. **`using r = point.replace(handler)`.** Applies in every async context of the worker until restored; restoring checks the count. Without `using` it is restored and checked when the test ends. It is also the scope F5 lacked.
4. **`point.calls`**, and `r.calls` on a replacement, for explicit assertions.

Shorthands on top of 3: `point.returns(value)`, `point.throws(error)`, and for expressions whose value is a promise `point.resolves(value)` and `point.rejects(error)`.

```text
synchronous action, expression never reached -> threw: [execution-points] The replacement for "src/app.ts#price:CallExpression:discount:0" ran 0 times; expected at least once. ...
same, asserting it is not reached with { times: 0 } -> returned 10
{ times: 0 } when it IS reached -> threw: ... ran once; expected 0 times. ...
asynchronous action, expression never reached -> resolved with 10
...and the check a test runner makes after the test -> threw: ... ran 0 times; expected at least once. ...
```

End to end through real Vitest (`p25-e2e-loud-at-test-end.mjs`): a test whose every assertion passes, around an asynchronous action that never reaches the replaced expression, is reported as failed with that message, and the other test in the file passes.

**The laws that hold it** (`tests/runtime-api.oracle.property.test.ts`, seven laws): the count against `times` and `on` over 160 combinations, synchronous and asynchronous; `replace` as a stack that applies in any async context, restored in any order; the pause as an event log over 48 histories, with waits bounded so that a promise that never settles is observed; the shorthands; refused capture names; refused options; and what a visitor may return. The gap check over `runtime.mjs`, `discovery.mjs`, and `plugin.mjs` reports 809 changes tried, 809 noticed.

**What changes for existing tests.** A scope whose handler never runs used to pass and now fails. The examples needed no change; four call sites in the oracle drivers that install a replacement on purpose without running it now say `{ times: 'any' }`.

Probes: `p04-silent-never-fired.mjs`, `p25-e2e-loud-at-test-end.mjs`.

### F8. The runtime accepted capture names that are not locals (fixed)

**Kind:** was a possible bug. Fixed on 2026-11-24: an evaluation whose replacement asks for a name the expression cannot see throws `"nope" is not a local that "<id>" can capture. It can capture: base, fee.`, and the after-test check reports it again in case the application swallowed it. A name is looked up among the expression's own locals only, so `toString` and the like are refused too. A visitor that returns something other than the node now gets a "matched 0" error that says so. Laws A5 and A7 in `tests/runtime-api.oracle.property.test.ts`. The text below is the finding as first written.

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

**Fixed 2026-11-24.** The registry now includes a file that starts with a byte order mark (`p06`: both sides see 1 node), and the plugin no longer instruments a file with no import or export, which the registry never listed (`p06`: "not instrumented").

**Kind:** inconsistency.

```text
ordinary module                    | types: file present with 1 node(s) | runtime: 1 node(s) instrumented
file with a UTF-8 BOM              | types: file ABSENT  with 0 node(s) | runtime: 1 node(s) instrumented
global script (no import/export)   | types: file ABSENT  with 0 node(s) | runtime: 1 node(s) instrumented
CRLF line endings                  | types: file present with 1 node(s) | runtime: 1 node(s) instrumented
```

For a file with a byte-order mark, `select('src/app.ts', ...)` is a compile error although it works at runtime. For a global script, `README.md:173` says "Global scripts are skipped". The registry does skip them, and the contracts oracle holds that (Law C4, `global-script-ignored`), but the plugin instruments them and adds an `import` to a file that had none. The plugin oracle covers BOM files for instrumentation only. No law compares the set of files the registry lists with the set the plugin registers. Probe: `p06-compile-runtime-parity.mjs`.

### F10. `points.ep` is not validated (fixed)

**Fixed 2026-11-24.** A manifest with an unknown key, a `targets` that is not a list, a target that is not a string, or a target that matches no file gets a diagnostic at that entry (`p06`). One consequence for the benchmark: a manifest that lists a missing file now fails the treatment typecheck.

**Kind:** possible bug.

```text
missing target path                               -> no diagnostic, file silently absent
{"target": ["src/app.ts"]}                        -> diagnostics=0, watched targets=(none)
{"targets": "src/app.ts"}                         -> diagnostics=0, watched targets=/, <project root>, a, c, p, r, s, t
{"targets": ["src/app.ts"], "tsconfg": "x.json"}  -> diagnostics=0
{"targets": [42]}                                 -> threw TypeError out of openProject
```

A string in place of the array is iterated character by character, which makes the compiler watch `/` and the project root. The existing diagnostic already states the rule ("must contain a JSON object with a "targets" array", `src/content-mapper.mjs:31`); only the object half is checked. A typo leaves the registry empty, and the user is told to check their TypeScript version. 4 of 4 malformed manifests and the missing path produce no diagnostic. Probe: `p06-compile-runtime-parity.mjs`.

### F11. The documented skip rule hides more code than it needs to (fixed)

**Fixed 2026-11-24.** An expression is skipped only when wrapping it would change what the code does, not whenever it contains an `await`, `yield` or optional chain somewhere inside. `p01`: 3 of 14 shapes still offer nothing (it was 9). `p02`, share of candidate expressions hidden: 5 of 3,200 in `bench/*.mjs` (it was 185), 1 in `src/` (it was 71), 0 in the benchmark tasks. A new law runs every newly selectable shape instrumented and uninstrumented, replaced and unreplaced, and compares what the code does.

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

### F12. The Vite plugin re-reads every target for every module it sees (fixed)

**Fixed 2026-11-24.** The plugin reads a target only in the transform call that instruments it. `p11`: 1,000 transforms of non-target modules with 200 targets take 1 ms (it was 3,955 ms).

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
| An ambiguous selection is reported only when a method is called on the result. `export const points = [select(...)]` with two matches compiles. | `p15-compile-errors-as-a-user-sees-them.mjs` |
| A local with an unportable type disappears from `capture`'s accepted names with no reason: `'"item"' is not assignable to parameter of type '"id"'`. | same probe |
| The unportable message says the expression "cannot be selected directly". There is no indirect way. | same probe |
| Registry errors have no source mapping (`mappings: []`), so F1 is reported at `points.ep(9,227)`. | `src/content-mapper.mjs:103` |
| The README's Vitest config imports `./src/discovery.mjs` (`README.md:147`), which the package does not export. A consumer has to repeat the targets in `vitest.config.mjs`, as the benchmark does (`bench/run.mjs:586`), and the two lists can drift. `executionPoints()` with no arguments instruments nothing. | `package.json` exports |
| `src/content-mapper.mjs:153-159` attaches `stdin` listeners at import time, so the oracle that imports it gets them too. | file |
| The plugin inserts its import before a leading directive such as `'use client'` (`importOffset` skips only a BOM and a shebang, `src/plugin.mjs:132-139`), so the string is no longer a directive. Whether any framework in a test run depends on it is not verified. | file |
| The message for an ambiguous selection advised narrowing "by callee/operator, inFunction, kind, or nth", which recommends the positional `nth` (F4) and names neither `object` nor `traverse`. Fixed 2026-11-24: it now says that `__matched` lists the matches, and names the properties and `traverse()`. | `src/runtime.ts`, `SelectFromNodes` |
| Fixed with harness v2.4: `checks/verify.mjs:318` said `fromFile()`; `bench/EXECUTION_POINTS_GUIDE.md` was referenced by nothing, showed the old verbose selector, and awaited the overlapping operation while holding the barrier. The message is corrected and the file is removed. | `grep` |

State of the rows above on 2026-11-24 (`p15` rerun). Fixed: registry errors carry a source mapping (`p28`); the README's config and `executionPoints()` with no arguments (the plugin reads `points.ep`); the `stdin` listeners (`serve(input, output)`, started only by `src/content-mapper-main.ts`); the directive order (plugin Law P2); the last two rows. Gone: the "cannot be selected directly" message, because such an expression can be selected now. Still as described: an ambiguous selection that is only passed along compiles, and a local that cannot be captured is missing from the accepted names without a reason in the message (the reason is in the registry, `p29`).

### F14. Discovery offers captures that are not initialized when the point runs (fixed)

**Fixed 2026-11-24.** A capture is offered only when the local is initialized on every way of reaching the expression. `p16`: no `ReferenceError`; the two shapes that failed now offer only the names they can read.

**Kind:** possible bug.

**The class:** discovery offers every binding declared earlier in the source. Two shapes make such a binding unreadable at the moment the expression runs: a hoisted function called before a later `const`, and a `switch` in which a later `case` declares the same name as an outer binding.

```ts
export function route(k) {
  const a = 'outer'
  switch (k) {
    case 0: return send(k)      // capture('a') is offered here
    default: let a = 1; return a
  }
}
```

```text
capture('a') at send(k) inside switch -> ReferenceError: Cannot access 'a' before initialization   (without the capture, route(0) returns 0)
capture('limit') at compute(1)        -> ReferenceError: Cannot access 'limit' before initialization   (without the capture, early() returns 7)
```

The error is thrown inside the application call, and the registry gives the capture a type.

**Why I think it's wrong:** Law D3 of the discovery oracle says captures are bindings "initialized before start and is not shadowed by an uninitialized declaration of the same name in an inner enclosing scope" (`tests/discovery.oracle.property.test.ts:742`). The `switch` shape is exactly that. The law is checked on eight fixed source templates, none with a `switch`, and none executes the code.

**How often:** both shapes tried. Probe: `p16-capture-and-original-semantics.mjs`.

### F15. Two shapes where the registry's type is not the expression's type (fixed)

**Fixed 2026-11-24.** `p21`: 0 of 4 shapes are wrong (it was 4 of 4).

**Kind:** possible bug.

| Original type | Emitted | Effect |
| --- | --- | --- |
| `{ [Symbol.iterator](): Iterator<number>; size: number }` | `{ "__@iterator@2814...": ...; "size": number }` | a handler returning `new Set<number>()`, which the original type accepts, is rejected with TS2741 |
| a private alias of an array, `type Items = Item[]`, not reachable from an export | `never` with "Object type has too many properties to inline" | the call cannot be selected; the same code with `Item[]` written out works |

`README.md:61` says the replacement's result must match the selected expression's inferred type. Both shapes tried are wrong; the control passes. Probe: `p21-registry-type-fidelity.mjs`.

### F16. A type that cannot be written as a helper leaves its name behind (fixed)

**Fixed 2026-11-24.** A helper that cannot be written takes its name and its inner declarations back. `p22`: `controller: AbortController`, no dangling names. This is the defect behind the four failures of the benchmark self-test.

**Kind:** possible bug.

**The class:** `emitHelper` records a helper's name before it has built the helper's body (`src/contracts.mjs:307-322`). When building the body fails (more than 24 members, a generic method), the first expression that needs the type is marked unportable, and every later expression or local with the same type gets the recorded name, for which no interface was emitted.

```text
## AbortController local seen by two expressions
   helper names referenced: ..., __EP_AbortSignal_2, __EP_AbortController_1 | defined: __EP_EventListenerOptions_5, __EP_EventTarget_4, __EP_Event_3
   registry errors: TS2304: Cannot find name '__EP_AbortSignal_2'. | TS2552: Cannot find name '__EP_AbortController_1'.
## private interface with 25 members, returned twice
   "src/app.ts#a:CallExpression:make:0"  UNSELECTABLE "Object type has too many properties to inline in a virtual contract."
   "src/app.ts#b:CallExpression:make:0"  result __EP_Wide_1
   registry errors: TS2304: Cannot find name '__EP_Wide_1'.
```

**Why it matters:** `AbortController` and `AbortSignal` are how async code is cancelled, so this is common in exactly the code the tool is for. As with F1, the whole project fails `tsc`. The benchmark's reference fix for `cancel-commit` uses `AbortController`; an independent audit graded that fix under both arm labels and it was solved as control and unsolved as treatment, on `contractTypecheckPass` alone. No stored trial hit it.

**How often:** both shapes tried; the control with a 3-member interface is fine. Probe: `p22-dangling-helper-names.mjs`. Potential law 1 would catch it.

### F17. The oracle test files were not type-checked, and `strict` does not stop every `any`

Probe: `p27`.

`tsconfig.json` has `"strict": true`, so an implicit `any` is already an error in the files it includes.

**The oracle test files were outside `include`.** `include` listed `examples/**/*.ts`, `src/runtime.d.ts` and `points.ep`. Nothing type-checked `tests/`. Checked with the same options, the nine oracle files had 62 errors: 36 parameters or bindings that are implicitly `any`; 12 imports of `../src/*.mjs` with no declaration file (`src/runtime.d.ts` is not what `import '../src/runtime.mjs'` resolves to, and the other four modules have none), so everything the oracles imported from production was `any`; 9 history options that do not match the `@tanstack/oracles` types; 5 others.

Fixed for the four runtime oracle files: they are in `include` and compile. `tests/loose-select.ts` gives `select` the types a hand-registered file can have, because the registry only knows the targets in `points.ep`. Since then every file under `tests/` is in `include` and compiles under `strict` without an `any`; the sources being TypeScript removed most of the errors, as expected.

**An `any` that a declaration hands over is not implicit.** `Promise#then` and `Promise#catch` declare the rejection reason as `any`, so in

```ts
const failure = await everyOrder().catch((error) => error)
```

both `error` and `failure` are `any`, `tsc` reports nothing, and every property read from `failure` is unchecked. The first version of `examples/profile.test.ts` hid this behind an annotation (`const failure: InterleavingFailure = …`), which the compiler accepts without checking. No compiler option reports this. The lint rule that does (`no-unsafe-assignment`) is not available for TypeScript 7.1 yet.

What is done about it: an order's `run` rejects with an exported class, `InterleavingFailure`, so a test writes `(error: unknown) => error` and narrows with `instanceof`, and the example does. I had also added a script that failed on such an `any`; it was removed at the maintainer's request, so nothing reports this shape automatically until the lint rule supports this compiler.

### F18. One expression selected twice with different captures compiled, and failed when the test ran (fixed)

Probe: `p33`.

**Fixed 2026-11-24** on your decision, as the first of the options below: an expression that several ways lead to is one selection, and its point captures every local that a handler captured on any of the ways. The runtime merges the captures and reads each captured local once; the compiler gives `locals` the captures of every way, also when one way returns the node itself.

**Kind:** design question. The compiler and the runtime disagreed.

**The class:** an expression that several containers lead to is one expression; that was decided with the visitor form, and both sides agreed when every way selected it alike. When the handlers captured differently on each way, they disagreed:

```ts
// prefix + each lies in outer() and in the callback inside it
const point = select('src/app.ts', {
  Function: (fn) => fn.traverse({
    BinaryExpression: (sum) => (fn.name === 'outer' ? sum.capture('prefix') : sum.capture('each')),
  }),
})
```

Before, `tsc` and Vitest for four ways of writing it (`p33` on `8501d09`):

| Case | Compiler | Test run |
| --- | --- | --- |
| the same capture on both ways | no error | passes |
| a different capture on each way | no error, `locals` has both | `must match exactly 1 expression; matched 2` |
| the node on one way, a capture on the other | `Property 'each' does not exist on type 'Readonly<{}>'` | `matched 2` |
| captures that overlap | no error | `matched 2` |

The third row was not in the first report of F18: the compiler was wrong there too, in the other direction. Now all four compile and pass, and reading a local that no way captured is a compile error that lists the locals there are.

**How it was found:** a hand-written wrong version of the runtime that keeps one selection per expression whatever it captures passed every oracle. No law spoke about this case, so no history had it.

**The options were:**

1. The runtime merges the captures of one expression. This is what the types already promised for two captures, and it needs no new error.
2. The compiler refuses it, with a message of its own, and the runtime's message says "selected with different captures".
3. Only the runtime's message changes.

**Oracle first.** Seven new histories in `runtime-visitor-object` (the same, different and overlapping captures on two ways; a capture on the first way only and on the second only; one way through a function and one without a step; two expressions captured alike, which stay two) and three in `types-visitor-object`. On the unchanged code the runtime oracle failed for five of its seven (7 of 33 tests, with the calibrations bound to them), and the type oracle for the capture on one way only; all pass now.

**What the compiler cannot know.** It types `locals` from everything the handlers can return. A capture on a way that the code never takes when the test runs is in the type and not in the handler's `locals`. That is stated as a limit of the type law.

**A defect of my own on the way.** The first version of the type printed its own name in the error for a local that was not captured (`Readonly<ExtractCapturedLocals<CapturedSelection<…> | …>>`), where the error had listed the locals before. Every oracle passed. The snippet for that case now asks for the locals in the message; it failed on that version and passes (`d279bda`).

### F19. A test written with the library is tied to the name of the helper its expression calls

Probe: `p34` (reads the stored rows of the registered run and one task's source; runs no agent and costs nothing).

**Kind:** design limit, measured on the 491 trials of the registered run whose final test uses the library. 422 of them are adequate reproductions, and those are the ones the harness checks against refactors and valid fixes.

**The class.** A selector says which expression it means by what the node carries, and what agents compare is the name of the called function: all 1,019 selections in the 488 library test files compare `callee` (160 also traverse into a function, 53 compare `object`, 45 `nth`, 20 `inFunction`). That name belongs to a private helper. Three changes that leave the behavior under test alone then break the test:

| Change to the code under test | Library tests that broke, of those that met it | What the test run says |
| --- | --- | --- |
| The helper is renamed (a refactor, bug still in) | 112 of 195 (57%) | `must match exactly 1 expression; matched 0` |
| A valid fix calls the helper at two places | 71 of 137 (52%) | `must match exactly 1 expression; matched 2` |
| A valid fix makes the two operations wait for each other | 21 of 112 (19%) | `Test timed out in 1500ms` |

Over everything the tests were checked against, a library test stopped testing 114 of 981 buggy refactors (11.6%) and rejected 93 of 1,298 valid fixes (7.2%); a plain Vitest test of the control arm 4 of 603 and 12 of 723. These refactors and fixes were written into the benchmark to probe exactly this, so the shares say what happens when such a change comes, not how often it comes.

**What holds.** Every one of the breaks on a refactor is loud. No library test passed on buggy code (control: 4 false greens). That is the decision "a replacement that never runs must be loud" doing its work: the test does not go quietly green, it says that its expression is gone.

**What it costs.** Counting a trial as solved only if its test accepts every valid fix, the arms are level over all ten tasks (268, 263 and 259 of 350 for control, offered and required), and on `token-session` the library arms fall from 33 and 35 of 35 to 13 and 14, with control at 34.

**Why, case by case** (`p34`, on the source of `token-session`):

```text
## How many expressions each selector matches in token-session (1 is a selection)
                                             by callee   through the function and the constant
as the task ships it                         1           1
the helper renamed (refactor R2)             0           1
the helper called at two places (fix T4)     2           2
```

- **The rename** breaks only a selector that names the helper. `Function: getActiveToken` → `VariableDeclarator: raw` → the call names the public function and the constant, and still finds its one expression. That selector exists since the visitor form. No agent wrote it: the README and the guide both advise the shortest selector, which is the callee.
- **The second call site** breaks both. The test means "the token request", the fix has two of them, and a point is exactly one expression, by law and in the types. Nothing a test can write today survives it.
- **The timeout** is the pause recipe, not the selector. The test holds one operation at the expression and awaits the other; a fix that makes the other wait for the first never lets that await finish. `interleavings` runs both and tries the orders the code allows, so a fix that allows fewer orders is no deadlock. It was used in 1 of those 491 trials; `pause` in 471.

**Directions, none built** (see "Still open", 7):

1. Guidance: select through the public function and what the value is bound to; treat a private helper's name as the thing most likely to change. This is a README and guide change.
2. A point over several expressions (every call to this helper inside that function), so that a second call site is still one selection. It changes what `select` promises, so it is your decision; feature idea 12.
3. Teach `interleavings` for two operations that race, and `pause` for holding one operation while the test does something that does not wait for it.

### What held

- All baseline checks pass at `b26e2c1`: `pnpm check`, `pnpm test` (353 tests), `pnpm verify` (16 checks), `node bench/run.mjs --self-test` (57 variants, 16 mutants, 8 cheats).
- Listing a module as a target did not change its behavior in any of the seven shapes I expected to break: numeric, `const`, and string enums, a BOM file, a `'use strict'` file, class field initializers with a static block, and parameter defaults with `arguments` and `new.target` (`p09-e2e-instrumentation-breaks-code.mjs`).
- Evaluation order is preserved around a replaced sibling, `original()` evaluates on each call as documented, and it still works after the scope ends (`p16`).
- Types from true globals and from third-party packages resolve (`fetch`, `Map<string, Date>`, `URL`, `NodeJS.Timeout`, `magic-string`, `vite`) (`p05`).
- Typecheck cost does not blow up with file size: 1,600 selectable expressions in one file and 40 `select()` calls typecheck in 0.6 s (`p20-typecheck-cost-vs-file-size.mjs`). Regenerating the registry for 160 target files takes about 0.2 s (`p11`).
- Wrong return types, unknown captures, file-name typos, and callee typos all produce a clear compiler error at the right place (`p15`).

---

## Oracle suites

### What the gap check shows

**Now (2026-11-24, seed 42, all six sources): 2,117 small changes tried, 2,117 noticed, 0 gaps, no code without an owner.** Measured three times: at commit `71f3fdc` with 15 oracle files (`oracle-gaps: summary 6e96cb2faa3a: 2114 mutants, 2114 killed, 0 gaps, 0 unowned`), at `9210720` with 16 (`summary 66248e0b8943`, the same counts), and at `eca441d`, after `line` and `text` were dropped and the captures merged (`oracle-gaps: summary 89bbf64280a5: 2117 mutants, 2117 killed, 0 gaps, 0 unowned`). `d279bda` came after the third run and changes one type declaration and one check of a type oracle, neither of which the gap check mutates. The last gaps before it were four endless loops in the mapper's frame reader, ten unowned changes in its standard-input block, and three in the listing's quoting. The frame reader was rewritten to walk a finite list of header ends, so a wrong length can no longer make it spin; the standard-input block became `serve(input, output)`, which an oracle drives; the process entry is two lines in `src/content-mapper-main.ts`.

The sixteenth oracle file and one more law came between the two runs (see the next section). The only production change with them is in type declarations, which the gap check does not mutate, so the second run says that nothing was lost, not that the new laws are strong; the hand-written wrong versions say that.

### Beyond the gap check: wrong versions written by hand (2026-11-24)

The gap check makes small syntactic changes to JavaScript. It does not touch a type declaration, and it does not invent a wrong design. Both were done by hand, each wrong version run through the gap check's own baseline or as an authored mutant.

**19 wrong implementations** of the runtime, discovery and the plugin, among them the code-level ones of the first review's seven (`checks/wrong-versions/semantic.json`, in the gap check's authored-mutant format; run with `--mutants checks/wrong-versions`):

| | First run | After the work below |
| --- | --- | --- |
| Rejected by a law | 16 | 18 |
| Passed every oracle | 3 | 1 (F18; rejected since, see the second round below) |

The three that passed:

- **A captured number that follows the application's variable.** `locals.attempt` read the binding whenever the handler asked, instead of holding the value at interception. The README promises a snapshot; the capture law read each local once and at once, where the two look the same. This is the first review's wrong version 1, and it was still passing.
- **A captured object that is a frozen copy.** The README promises the application's own object. The capture law only ever captured numbers. The first review's wrong version 2, still passing.
- **One selection per expression whatever it captures.** No law said what this case owes. It became F18, which is decided and fixed since.

The first two are held now by a law of their own, `runtime-captured-values` (the approved potential law 7): the application reassigns its binding while the handler runs, the handler writes into a captured object, and the law compares what `locals` holds before and after, whether the object is the application's own, and when each binding was read.

**38 wrong type declarations** (a `returns` that takes anything, a `times` that takes any word, an `order.run` that resolves to `any`, and so on), applied to the built `dist/runtime.d.mts`:

| | First run | After the work below |
| --- | --- | --- |
| Rejected by a type oracle | 34 of 38 | 37 of 37 |

The four that passed: three ways of making a captured local assignable (the first review's wrong version 6, held until now only by `checks/verify.mjs`), and `interleavings` taking a single point where it takes a list. The capture law of the type oracle says "readonly locals" and had no history that assigns; it has five now. The argument-kinds law hands every place a selected point as well. Two layers each made `locals` read-only, so dropping either one changed nothing: the inner one is removed, and the outer one is checked.

The type-level promises of the API built this month (what `returns`, `resolves`, the options, `pause().run`, `order.run` take and give; which expressions can wait) had no law before today. `tests/types-point.oracle.property.test.ts` has five, over 741 snippets that are written from rules (every expression times every place times every value) instead of listed by hand, and each answer is computed from the rule, not stored.

**A defect this found** (red first: 14 histories failed on the unchanged declarations). `sum.pause()` on an expression that is no promise is a compile error, as it should be, but the error was `This expression is not callable. Type 'String' has no call signatures.` The declarations carried the reason, "pause() needs an expression whose value is a promise", as a string type, and the compiler does not print the text of a string type it cannot call. It prints an unnamed object type in full, so the reason is now a property of one: `Type '{ readonly __unavailable: "pause() needs an expression whose value is a promise."; }' has no call signatures.` The same holds for `resolves`, `rejects`, and a point handed to `interleavings`.

**What became of the first review's seven wrong versions:** 1 and the copy half of 2 were still passing and are rejected now; the re-wrapped promise of 2, and 3 (three wrapper kinds, one mutant each) are rejected; 4 cannot be rebuilt as it was, because the plugin writes its source map itself now, and a stand-in (every token mapped to column 0) is rejected; 5 is rejected by 19 snippets where one stood before; 6 was still passing and is rejected now; 7 is rejected.

**A second round, for the two decisions of the evening** (no `line`, no `text`; one expression captures what any way captured). Twelve more wrong implementations and seven more wrong declarations, written before or right after the change:

- Eight put something back that a law now says is absent. Five implementations: the plugin registering an expression's line and text, or a container's line; the registry writer declaring an expression's line, its text, or a container's line. Three declarations: an expression handed with a line or with its text, a container handed with a line. The gap check cannot make these: it alters and removes code and never adds a property.
- Seven more implementations get the selection wrong: the captures of the last way only, a name captured on two ways read twice, different captures counted as two selections again, captures merged across two expressions, `capture()` on the point adding to a capture in the visitor or losing against it, and a returned value that is no selection counted as a match.
- Four more declarations get the captures wrong: a capture that counts only when every way captures, a point with every local of its expression, no capture reaching the point, and the error message that names a type.

All were rejected on the first run, and the one that had been passing, F18, is rejected now: **31 of 31 wrong implementations, 44 of 44 wrong declarations.** The limit stated below holds for these too: I wrote them and the laws.

**Limits of this.** I wrote these wrong versions, and I wrote most of the oracles: the tool's own documentation says such mutants tend to be the ones the oracle already kills. Seven of the first 57 were not, which says the next person's seven are still out there; that none of the second round's 19 passed says less than it seems, because I wrote the laws and the wrong versions within the same hour. The declaration changes run beside the tool, which cannot patch a file that a test reads as text: `node checks/wrong-declarations.mjs` applies each to the built `dist/runtime.d.mts`, runs the gap check's baseline with the type oracles, and puts the file back.

The table and the paragraphs below describe the state the review started from.

Gap check at `b26e2c1`, seed 42: 1,472 changes tried, 1,214 noticed, **248 gaps**, 10 changes in functions no oracle owns. All six oracle files pass on the unchanged code.

| Owned file | Gaps |
| --- | --- |
| `src/runtime.mjs` | 0 of 87 |
| `src/discovery.mjs` | 0 of 257 |
| `src/plugin.mjs` | 0 of 121 |
| `src/contracts.mjs` | 216 of 821 |
| `src/content-mapper.mjs` | 32 of 186 |
| `src/runtime.d.ts` | not checked: it is not in the gap check's source list in `AGENTS.md` |

What the 248 leave unguarded, by group:

| Group | Gaps | Behavior no law notices |
| --- | --- | --- |
| `buildExportIndex` and its helpers | 70 | which `import("...")` path a private type gets: the depth and property limits, the shortest-path choice, the `NonNullable` / `Awaited` / `[number]` / `ReturnType` / `Parameters` steps |
| `emit`, `emitSig`, `emitMembers`, `emitHelper`, `isReadonlyProp`, `isPrivateMember` | 75 | the emitted type text: enum literals, recursive types, variadic tuples, rest and optional parameters, helper interface bodies |
| `isNominalUnexported` | 22 | the brand on private enums and classes |
| `generateFileRegistryModule` | 31 | cache key and bookkeeping, snapshot disposal, the global-script skip, nodes with no AST match |
| `projectNested`, `renderFileModule` | 18 | order and closing of nested probe insertions, file and locals order, closing braces |
| `transform`, `handleInputChunk`, `getSnapshotCache`, `openProject`, `scanProject` | 32 | that the project root and tsconfig are used, that the warm cache is used at all, the `diagnostics` field |

Three of these are worth reading as written in the log: deleting the registry's closing braces survives all three owning oracles (`contracts.mjs:M819`), replacing every helper interface body with `undefined` survives (`M427`, `M429`), and all six changes to `getSnapshotCache` survive.

### What the gap check does not show

Zero gaps means every small syntactic change is noticed. It does not mean the promises in the README are held. I put seven deliberately wrong versions into scratch copies of the repository and ran each through the gap check. Every one reported `baseline all N oracle files pass`:

| Wrong version | Promise it breaks | Oracles | Caught by anything else |
| --- | --- | --- | --- |
| captured locals become live getters (`src/runtime.mjs:110`) | primitive captures are snapshots (`README.md:95`) | pass | no: the 11 example tests pass too |
| captured objects are frozen clones and the async result is re-wrapped (`src/runtime.mjs:48`, `:110`) | objects stay shared and mutable (`README.md:88-92`); the same promise is returned (`README.md:99`) | pass | one example test |
| the wrapper climb drops `x!`, `<T>x`, and `x satisfies T` (`src/discovery.mjs:40-42`) | reference-only positions are skipped (`README.md:175`) | pass | no |
| the source map is generated from the untransformed code (`src/plugin.mjs:103`) | stack traces and coverage point at the right line | pass | no |
| a handler may return anything for a non-void expression (`HandlerResult` in `src/runtime.d.ts`) | the result must match (`README.md:61`) | all six pass | `checks/verify.mjs` |
| `locals` is writable in the handler type | readonly locals (`README.md:82`) | all six pass | `checks/verify.mjs` |
| `point.capture(...)` always types `locals` as `{}` | captured locals are typed (`README.md:59`) | all six pass | `pnpm check` on the examples |

The first four are one-to-four-line edits found by an independent review of the oracle files; I reran all seven myself. So the type contract's main promises are held by `checks/verify.mjs` and the examples, not by the type oracle, and the snapshot promise is held by nothing.

### Why

- **Most laws are tables of examples.** The review counted 17 of the 22 laws as a fixed list of scenario labels mapped to literal expected answers, with only runtime Laws 1 to 3 and discovery D2 (and partly D4) computing the answer from generated inputs. In the contracts oracle the expected strings are production's own output format, so a correct refactor of the formatting would fail and a wrong type with the same text passes.
- **The calibrations corrupt a field the check already compares.** They show the comparison is deep. They cannot show a missing observation, which is what all seven wrong versions exploit.
- **Nothing compiles the registry** (see F1), and the type oracle's negative cases pass on any diagnostic at all, not on the expected code and position.

### Laws and their authority

| Inconsistency | Where |
| --- | --- |
| Fixed 2026-11-24: `AGENTS.md` said to select "using an existing AST query language" while runtime Law 4 records the decision that "`select` is the sole selection API". The query-string API was the earlier design; `AGENTS.md` now says so. | `AGENTS.md`; `tests/runtime.oracle.property.test.ts:59-61` |
| `AGENTS.md` and `README.md:105` call repeated `original()` provisional and undecided. Runtime Law 2 enforces the exact evaluation count. | `tests/runtime.oracle.property.test.ts`, Law 2 model |
| Law C3 prescribes the bare-name behavior behind F1. | `tests/contracts.oracle.property.test.ts:669` |
| Laws cite README line numbers that have moved. For example the contracts oracle cites `README.md:170-171` for sentences now at `:173` and `:167`. The review counted ten such citations. | `tests/contracts.oracle.property.test.ts:909` |

Reported by the review and not rechecked by me: several "reach" labels count the wrong scenario (for example `global-script-ignored` is entered by a fixture with no selectable expression, so it passes whether or not scripts are skipped); six laws cite production code as their authority; the plugin oracle's prose names two things (`sourcesChanged`, `watchFiles`) that do not exist in `src/plugin.mjs`. The same review found discovery offsets correct with non-ASCII text.

### Potential laws

Each needs approval. The first five come from the library findings, the rest from the wrong versions above.

1. For every target whose expressions and locals have types the project can name, the generated registry compiled as `.ts` beside the target has no diagnostics of its own, and each node's `result` and `locals` are mutually assignable with the type TypeScript gives the original expression. Authority: `README.md:7`, `:61`. Would have caught F1 and F15. It replaces the text comparison in C1 and C3.
2. For every sequence of edits to targets and to the files they import, the registry the warm mapper returns equals the registry a cold mapper returns. Authority: `README.md:167`. Would have caught F2.
3. For every target file, the files and node ids in the registry equal the ones the plugin registers at runtime. Authority: the parity decision of 2026-11-24, widened from nodes to files. Would have caught F9.
4. For every manifest, either the registry reflects exactly the listed targets that exist, or a diagnostic names what is wrong. Authority: `src/content-mapper.mjs:31`. Would have caught F10.
5. For every capture name passed at runtime, the name is a capture the point offers, or installing the replacement throws. Authority: `README.md:59`. Would have caught F8.
6. For every capture the registry offers at a point, reading it when the instrumented code reaches that point succeeds. The model is JavaScript's own scoping; the driver has to execute the code. Authority: Law D3's own sentence. Would have caught F14.
7. For every captured primitive, the value in `locals` is the value at interception and does not change when the application's binding changes; for every captured object, `locals` holds the application's own object. Authority: `README.md:88-95`.
8. For every pair of expression type and handler return type, the handler is accepted exactly when TypeScript would assign the return type to the expression type; `locals` rejects assignment; `capture` on a point types exactly the named locals. Authority: `README.md:59-61`, `:82`. Adding `src/runtime.d.ts` to the gap check's sources would give mutation evidence for it.

---

## Feature ideas

Ordered by how much evidence there is that users need them. Built: 1, 2, 3, 6, 7, 9, 10 and 11, each with its own laws. 4 is built as selection through a visitor object plus `object` on a call; `inClass` and `assignedTo` became traversal into a `Class` and a `VariableDeclarator`, and `text` and `line` were built and then dropped (your decisions). 5 is built for selecting and passing through; pausing such an expression is open. 8 is open: `new` is like a call, `await` needs a design first.

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
12. **A point over several expressions** (from F19). `select` insists on exactly one expression. A valid fix that calls the selected helper at a second place made 71 of 137 library tests fail with "matched 2", although every one of them meant both calls. A form that takes all matches (as a Babel visitor visits every node of its type) would replace or pause each of them with one handler; the handler's result type would have to fit them all. Not built: it changes the law that a point is one expression.

---

## Benchmark

**Retired on 2026-11-24.** You decided in the benchmark thread that the three stored runs are no longer evidence ("drop all store previous runs, they are not relevant anymore"). This section stays as the record of what the review found in them and of how the harness was repaired. None of its numbers describes the current library. The files in `~/.ep-bench-results/` were not deleted.

### The full run on the current library (harness v2.6, 2026-11-24 22:38 to 2026-11-25 19:10)

Run by the benchmark thread at your request, from commit `e010b4c` (the library of `d279bda`). Its own record, with every deviation, is the last section of `BENCHMARK-LOG.md`; harness v2.6 and that record are merged (`007fd78`). I ran none of it. What I did: recount the figures below from the 1,050 stored rows with a script of my own (`p34`), which agrees with the thread's report in every figure, and run the self-test on the merged tree (`Self-test PASSED: 159 check lines passed, 0 failed`).

**Design, as registered (`D-24`).** Ten tasks × seven model settings × three arms (control; treatment, where the library is offered; `required`, where the agent is told to use it), five replicates, 350 blocks and 1,050 trials. Two primary tests on `solved` in the seven tasks where plain Vitest has a seam (Strata B + C, 245 blocks): control against treatment and control against `required`, exact McNemar, Holm for two tests.

| Blocks solved | Control | Treatment (offered) | `required` |
| --- | --- | --- | --- |
| **Primary: the seven tasks plain Vitest can reach (245)** | 216 | 221 (13 only treatment, 8 only control, p = 0.38) | 220 (14 / 10, p = 0.54) |
| The three closed-module tasks (105) | 64 | 87 (27 / 4, p = 0.00003) | 91 (30 / 3, p = 0.000001) |
| of them `stale-cache` (35) | 8 | 34 | 35 |
| of them `token-session` and `double-submit` (70) | 56 | 53 | 56 |
| All ten tasks (350) | 280 | 308 | 311 |
| All ten, and the test accepts every valid fix | 268 | 263 (p = 0.61) | 259 (p = 0.34) |

- **Neither primary test rejects.** Control already solves 88% where it has a seam, and 9 to 10% of the blocks were discordant. The benchmark thread computes that 80% power at this split would need 1,700 to 3,000 blocks.
- **The closed-module result is one task.** `stale-cache` carries all of it; on the other two the arms are level.
- **Telling the agent to use the library changes nothing against offering it:** 221 against 220, 87 against 91 (p = 0.22), 308 against 311.
- **Use when only offered:** 143 of 350 trials, 104 of 105 on the closed-module tasks and 39 of 245 on the others. `required`: 348 of 350. `pause` is the operation in 141 and 330 trials, `withReplacement` in 29 and 148, `interleavings` in 0 and 1. The agent ran `npx execution-points …` in 103 and 240 trials; 13 calls were refused, each chained with a command that is not allowed.
- **What the library tests are like** is F19: never a false green, and tied to the helper's name.
- **Cost.** 19,697 credits for the five complete replicates, 4,020 for the interrupted first attempt of the fifth, about 60 for preflights and the smoke run (the thread's figures).

**What did not go as registered** (the thread's account; the log has the detail):

1. Replicate 5 stopped at 13:37 on a full disk during grading (134 trials graded, 2 ungradable, 74 not graded) and was run again on your choice, where `D-24` says a stopped replicate ends the series. As registered (replicates 1 to 4 and the 136 graded rows of the interrupted fifth, 220 blocks) the primary tests read 199 against 197 (p = 0.81) and 199 against 199 (p = 1.0). Both analyses say the same.
2. Replicate 4 was graded under load from other sessions and graded again from its stored output: identical in all 210 trials.
3. `copilot --version` printed three versions over the run while every session's own start event reports `1.0.114`; pooling needed `--allow-mixed=copilotVersion,regrade`.

**Limits.** Ten tasks and seven model settings. The treatment guide was written against these tasks. The number of replicates, the model settings and the two primary tests were chosen by the benchmark thread and not reviewed by you before the run. The refactors and fixes that F19 counts were written to probe selector coupling.

**Not verified by me:** anything about how the run was carried out (the live preflights, the credit figures, the re-grade of replicate 4, the analysis as registered). I read rows; I did not rerun `bench/analyze.mjs`, which the thread reports as hanging in its power section for two of the comparisons.

### The three earlier runs (retired)

Everything below is recomputed from the three stored `results.jsonl` files or rerun at zero credits. An independent audit of the harness produced several of the points; each one below was rechecked before it went in, and the ones I did not recheck are listed separately.

**State on 2026-11-24.** Harness v2.5 is merged, and its self-test passed on the library as it was at `8501d09`: `Self-test PASSED: 156 check lines passed, 0 failed`, run by me on the merged tree. I have not rerun it since `line` and `text` were dropped (`d279bda`); the benchmark thread runs the self-test of v2.6 on that library before its run. Nothing was rerun for credits; the stored results were only read. `node bench/analyze.mjs` on the stored matrix prints the numbers of this section (31/40 against 35/40; 66/66, 38/47 with 9 loud breaks, 30/30).

### The harness on the new library

A re-evaluation of v2.4 (at `393f6cd`) by the harness work on 2026-11-24, at zero credits, with the stored results only read, and then harness v2.5, which fixes four of the six points. I checked points 1 and 4 in the v2.4 code, read the v2.5 diff, and ran its self-test on the merged tree. The case counts and the re-grades are reported as measured by the harness work and not rerun by me.

**What held in v2.4.** Its self-test passed every check; the four typecheck failures of the earlier state went with F1 and F16. The guide's new forms (`pause`, the visitor object, `interleavings`, `{ times: 'any' }`) typecheck in a treatment project, and reproductions written with them are graded `true_red`. The new loud failures (a replacement that ran 0 times, a pause that is never reached) are graded as loud breaks. The barrier recipe of the stored runs still works.

**What was wrong in v2.4, and what v2.5 did.**

| # | Defect | Effect | State |
| --- | --- | --- | --- |
| 1 | Use of the library is recognized only by a call of `withReplacement` (`usesExecutionPoints` in `bench/ast-audit.mjs`). A test that uses `pause()` is filed as `deferred-only`. | The adoption split and the robustness table would count almost every test written with the new API as plain Vitest. | Fixed in v2.5: a test uses the library when it imports and calls `select` and puts the point to use by any of its eight operations (`withReplacement`, `replace`, `returns`, `throws`, `resolves`, `rejects`, `pause`, or handing it to `interleavings`). Each row records which. Decision D-18 in `PROTOCOL.md`. 18 calibration cases; the v2.4 audit passes none. |
| 2 | `npx execution-points list` does not resolve in a treatment workspace. The harness copies the package without a link in `.bin`, so `npx` asks the registry for a package of that name. | The treatment guide tells the agent to run that command, and it fails. | Fixed in v2.5: the toolchain installs the package as it ships and links each `bin` command. The self-test runs the command the guide prints, offline. |
| 3 | An assertion that fails inside `order.run(...)` arrives as an `InterleavingFailure` with the `AssertionError` as its `cause`, and is graded as a loud break. The README shows that shape. | A reproduction written the documented way is not counted. | Your decision ("Still open", 6). v2.5 records the cause chain and keeps today's grading; the rule is one line. |
| 4 | The v2.4 classifier reads the error's type from the first line of the stack. Vitest writes `Error:` there for a failed `expect(p).rejects`, `expect(p).resolves` and `expect.poll`, although the object is an `AssertionError`. | Those reproductions are graded `error`. 85 of the 138 stored trials use `.rejects` or `.resolves`. | Fixed in v2.5: a reporter of the harness's own writes each error's name and cause chain, and the classifier grades by that; a run whose report is missing or disagrees with Vitest's is `ungradable`. Decision D-19. 33 single errors and 25 real Vitest runs as cases; v2.4 passes 29 and 11. |
| 5 | Every bench process, and `probes/e2e.mjs`, rebuilds `dist/` in the checkout when it starts, and the build empties the directory first. | A self-test started during a gap check or `tsc` in the same checkout can break that run. | Fixed in v2.5: the build goes into a temporary directory, and the self-test compares `dist/` before and after. Every probe does the same now. |
| 6 | A re-grade runs old tests on the new runtime, where a replacement that never runs fails the test. | Re-graded numbers are not like for like with the stored ones. | Inherent: a re-grade is a re-analysis |

Points 4 and 5 came from this session: 4 with the assertion-only rule of v2.4, 5 with the move to a built `dist/`.

**The stored matrix re-graded on the new library.** All 80 trials, three runs per variant, none unstable. Under v2.4 twelve verdicts change, all from solved to unsolved:

| Cause | Control | Treatment |
| --- | --- | --- |
| Classifier defect (point 4) | 3 | 3 |
| Assertion-only rule: an awaited call rejects | 3 | 2 |
| New runtime: a replacement must run | 0 | 1 |

| Solved (control, treatment) | Stored | Re-graded with v2.4 | Re-graded with v2.5 |
| --- | --- | --- | --- |
| `retry-storm` | 4/4, 4/4 | 2/4, 3/4 | 4/4, 4/4 |
| `double-submit` | 4/4, 4/4 | 0/4, 0/4 | 1/4, 2/4 |
| `stale-cache` | 0/4, 3/4 | 0/4, 2/4 | 0/4, 2/4 |
| The other seven tasks | 23/28, 24/28 | 23/28, 24/28 | 23/28, 24/28 |
| All ten tasks | 31/40, 35/40 | 25/40, 29/40 | 28/40, 32/40 |

The last column was first derived from the failure text and then measured with v2.5: the same numbers. The arms differ by four trials in every column. Against the stored verdicts v2.5 changes six, all to unsolved: five under the assertion-only rule and one from the new runtime. Neither of the two undecided gradings occurs in any of the 80 trials. Library use is the same 23 of 40 treatment trials as stored, all through `withReplacement`. The analyzer on the v2.5 rows gives 6 treatment-only and 2 control-only pairs (p = 0.289); strata B and C stay 23/28 against 24/28, and stratum A becomes 5/12 against 8/12. All five flips under the rule are one mutant of `double-submit`: the tests wrote `expect(await p)` where `await expect(p).resolves` would have counted, and they were written before the guide stated the rule. This is a re-analysis, not a new record.

**What it means for the experiment.**

- The treatment is a different intervention now. The stored runs describe the old API, and the analyzer refuses to pool them with a new run.
- The library section of the treatment guide grew from 411 to 576 words with the stored failures in view. The control guide did not change. A rerun on the same ten tasks measures that too.
- A pause that is never reached now fails at once instead of timing out, so of the robustness counts only the combined "stopped testing" stays comparable.
- `interleavings` cannot order disk or timers. The README says so and the guide does not, and two tasks are real-async.

**Not verified by v2.5.** The 58 pilot trials are not re-graded. Each re-grade ran once. Recognizing `pause` and `interleavings` as library use is verified on calibration cases only, because no stored test uses them. The provenance hash (`toolSha256`) covers `src/` and `package.json`, not the built files a workspace receives. The guide's command is tested offline only, and everything ran on macOS.

### What the stored data shows

Three paid runs, 138 started trials, 69 matched blocks.

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

1. **The endpoint is one gate.** In the last run `solved` equals `adequateReproduction` in 80 of 80 rows. The hidden grader passed 68 of 69 trials in each arm over all runs, and 22 of the 23 unsolved trials failed `adequateReproduction`. The benchmark measures whether the agent's regression test is adequate under the harness's gates. Nothing here was hard to fix, even for `claude-haiku-5.5` at low reasoning.
2. **In the equal-capability strata the difference is not the library.** In the last run's 28 primary blocks, treatment trials that used the library produced 1 treatment-only and 2 control-only pairs out of 11; treatment trials that used plain Vitest produced 2 and 0 out of 17. Two of the three treatment-only pairs are `vi.mock` tests on both sides. The +3.6 point difference is run-to-run variation between agents doing the same thing.
3. **The Stratum A result is one task.** All three Stratum A discordant pairs of the last run are `stale-cache` (0/4 against 3/4). `token-session` and `double-submit` are 4/4 against 4/4, solved by control without any interception. The pilot's `token-session` gap (4/7 against 7/7 pooled) came from the single-reference gate that the log already calls biased. `stale-cache` is built so that plain Vitest has no legal way in; reporting it as a capability demonstration is fair, pooling it into "31/40 against 35/40" is not.
4. **`cancel-commit` was graded by a coin in part.** The harness ran each variant once. I re-graded three stored trials six times each on a quiet machine: two of them flipped between adequate and inadequate (5 of 6 and 4 of 6 adequate), always on the `CC-M1-shared-stage-file` mutant. One of those is stored as unsolved. The audit's larger rerun found 6 of 14 `cancel-commit` trials unstable and 0 of 72 trials on the other nine tasks. `cancel-commit` carries the only discordant pair of the pilot's primary strata.

   Fixed in v2.4. The cause was real disk I/O: the tests hold one run at a barrier and wait a fixed number of event-loop turns, which does not order file operations. Grading now runs every variant three times and requires agreement, and grades `cancel-commit` with disk calls that settle one turn after they are made, in call order. Reported by the harness work and not rerun by me: all 14 stored `cancel-commit` trials re-graded twice give the same verdicts, 4 adequate and 10 inadequate; the 8 from the matrix equal the stored ones, and 3 from the pilot differ. Two stored pilot verdicts rested on an `ENOENT` that escaped from the superseded run, which is not a reproduction.
5. **Library-based tests break on refactors far more often than the log says.** The log reports false greens, which are 0 for everyone. The data behind it, last run, adequate rows only:

| Regression tests | Buggy refactors still red | Loud break instead | Valid fixes green |
| --- | --- | --- | --- |
| control | 66/66 | 0 | 75/78 |
| treatment, used the library | 38/47 | 9 (19%) | 54/61 |
| treatment, plain Vitest | 30/30 | 0 | 33/33 |

A loud break is the designed behavior, and it is better than a false green. It is still a test that stopped testing, and it happened on one refactor in five. Up to v2.3 `bench/analyze.mjs` computed the count and never printed it; it now prints this table per arm and by adoption.

### Threats to validity

| Threat | Detail | Could favor | State after v2.4 |
| --- | --- | --- | --- |
| A treatment-only gate rejects valid fixes | `contractTypecheckPass` fails for a fix that uses `AbortController` (F16) or `fs.stat` (F1), whether or not the test uses the library. The benchmark's own `cancel-commit` reference fix fails it. The audit found 5 of 65 calibrated variants failing treatment `tsc`. `--self-test` typechecks baselines only, so it passes. No stored trial hit it. | control | Fixed: F1 and F16 are merged, and the self-test typechecks every variant in both arms (65 of 65). |
| The control guide's example is one of the tasks | `control-guide.md:22-41` uses `'./storage'`, `readFromDb`, `getProfile`, and `updateProfile('u1', 'Bob')`, which are the real names in `stale-cache-seam`. The treatment guide uses placeholders. Control solved that task 7/7, treatment 6/7. | control | Fixed: both arms get the same guide with placeholder names, and the self-test rejects a guide that names a task. |
| The treatment guide replaces the `vi.mock` recipe instead of adding to it | The treatment guide has no `vi.mock` example and no fake-timers note. The contrast is "library recipe instead of module-mock recipe". In the io-seam stratum 19 of 35 treatment agents used the library where `vi.mock` is the natural tool. | either | Fixed: the treatment guide is the control guide plus one library section; a parity check enforces it. |
| The treatment guide was tuned on the last run's failures | The selector note was added in `72d8bc8`, after the results commit, and targets exactly the two control-only pairs. The control guide has not changed. A rerun on the same tasks measures the tuning. | treatment | Open again: the library section was rewritten for the new API with the stored failures in view (411 to 576 words); the control guide is unchanged since v2.4. |
| The task sources avoid everything the library cannot do | 17 files, no generics, no optional chaining, no classes. 0.4% of candidate expressions are hidden by the skip rule against 6 to 7% in this repository's own code (F11). | treatment | Open: needs new tasks. |
| Any error counts as reproducing the bug | `classify` treats every failure that matches neither the timeout nor the loud-break pattern as `true_red` (`bench/run.mjs:834-849`). There is no check for `AssertionError`, although `PROTOCOL.md` section 2 says "genuine `AssertionError`". The loud-break pattern looks for `ExecutionPoint`, which matches none of the runtime's `[execution-points]` messages, so "was not instrumented" counts as a reproduction. | neither systematically | Fixed: only an `AssertionError` is a reproduction; the library's own errors are a loud break; anything else is `error`. |
| The same root cause is scored differently per arm | A missing interception point is a selector break for a library test and a timeout for a `vi.mock` test. Only the timeout enters the false-red rate. | treatment, in reporting | Fixed: one set of counts for both arms. |
| Power | The protocol's arithmetic is right (78, 125, 231 blocks) but uses a best case. Under that best case the last run's 28 primary blocks had power 0.055. At the discordance and direction actually observed, 80% power needs 1,144 blocks (last run) or 610 (pooled). | neither | Unchanged; it is arithmetic. |
| Pairing and provenance | Pairs are keyed on the served model name, so a row whose served name differs, or an aborted row with none, silently loses its pair (`bench/stats.mjs:77-84`). `--regrade` stamps old trials with the current checkout's provenance, so re-graded old trials would pool with a new run. | neither | Fixed: pairs are keyed on the requested model, every unmatched row is warned about, and a re-grade keeps the original provenance. |

Reported by the audit and not rechecked by me, with what v2.4 did about each: a harness-exception row lacked provenance fields and made `analyze.mjs` exit instead of running the promised sensitivity analysis (it now warns and runs it); 12 of 69 treatment trials tried to open a README or `dist` for the library, which the workspace does not ship (open); the Newcombe interval collapsed to `[0, 0]` for all-concordant data (the analyzer now prints Method 10 with the old interval beside it; the method numbers were written from memory, the formula is in the code); several E9 denominators and pilot credit intervals in `BENCHMARK-LOG.md` differed from what `analyze.mjs` prints (corrected in the log); the log said the host-sleep row was re-graded but the stored file still has it ungradable (the log now says so); the default `--max-total-credits` of 300 would have stopped a rerun of the last matrix early (a dry run now prints the projected need and says the matrix would be refused: 471.2 credits for that matrix).

### Should the benchmark be rerun

**Overtaken on 2026-11-24:** you asked for a full run on the current library, and it is done (see the top of this section). What follows is what I recommended before that. Of the five reasons, the second and the fifth no longer hold: the grading rules are decided, and the API questions that were open are answered. The first, third and fourth are unchanged, and the run's result should be read with them.

Not as a whole, and not yet.

**What changed since the last run.** When this review started, almost nothing (`git diff da61474 b26e2c1 --stat`: the type generator, twelve lines of the treatment guide, tests, docs). Now, everything an agent touches: how an expression is selected, replacements that must run, `pause`, `interleavings`, the guide's library section, and a runtime that fails a test whose replacement never ran.

**Why a full rerun is the wrong next step:**

1. It cannot answer the primary question. See the power row above.
2. Three grading rules are undecided. *Decided since: see "Decisions".*
3. The treatment guide was rewritten with the stored failures in view, and the same ten tasks would measure that.
4. The tasks avoid what the old library could not do (generics, optional chains, Node types). It can do those now, and nothing in the task set would show it.
5. The API is not frozen: the names under "Still open" may still change.

**What I would do instead, in order:**

1. Library: fix F1 and F16, land F6, decide F7. Then freeze the library at a tagged commit. *Every finding is fixed. The freeze waits for your answers under "Still open".*
2. Harness: grade every variant several times and require agreement; typecheck every reference and valid fix in a treatment workspace during `--self-test`; require `AssertionError` for a reproduction; print still-red, loud-break, and timeout counts per arm; pair on the requested model and warn on every unmatched row. *Done in v2.4, and for the new API in v2.5.*
3. Guides: give both arms both recipes with placeholder names, and freeze them. *Both arms share one guide, and the treatment guide's library section and the witness are rewritten for the new API. Still to do: freeze, once you have accepted the API.*
4. Tasks: replace the ceiling tasks with ones that have headroom on the fix itself and look like ordinary code (generics, `?.`, Node types, several hundred lines, more than one module). Keep `stale-cache` as a labeled capability demonstration outside the pooled numbers. Make reproduction quality its own pre-registered endpoint.
5. Then run one pre-registered matrix with at least three trials per cell, sized from the power table, and print the split by adoption next to the intention-to-treat result.

A small exploratory run before step 4 (`claude-haiku-5.5`, the four tasks where treatment lost or adopted heavily, `--trials 3`, about 60 credits) would show whether the selector-coupling failure is gone. It answers nothing else.

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
| `p10-runtime-overhead.mjs`, `p17-overhead-what-if.mjs` | F6, including the two candidate designs |
| `p11-scaling.mjs` | F12, registry generation time |
| `p12-selector-vocabulary.mjs`, `p14-nth-shifts-silently.mjs` | F4 |
| `p13-scope-vs-shared-worker.mjs` | F5 |
| `p15-compile-errors-as-a-user-sees-them.mjs` | F13, what held for compiler messages |
| `p16-capture-and-original-semantics.mjs` | F14, what held for `original()` |
| `p18-node-builtin-grid.mjs` | F1: 22 of 38 |
| `p19-project-ambient-types.mjs` | F3 |
| `p20-typecheck-cost-vs-file-size.mjs` | what held: typecheck cost |
| `p21-registry-type-fidelity.mjs` | F1 (enum members), F15 |
| `p22-dangling-helper-names.mjs` | F16 |
| `p23-who-is-outside-the-scope.mjs` | F5: which application shapes a scope covers |
| `p24-fast-path-semantics.mjs` | F6: a replacement applies exactly to the evaluations in its scope, across function kinds |
| `p25-e2e-loud-at-test-end.mjs` | F7: a replacement that never ran fails the test through the Vitest hook |
| `p26-interleavings.mjs` | schedule exploration: each order and what it left behind, a failure from a check inside `run`, a replay from a schedule, a sample, an unreached expression, a run that waits on a timer, an order that was not run |
| `p27-what-the-type-check-covers.mjs` | F17 |
| `p28-registry-error-location.mjs` | an error inside the registry is reported at the manifest entry that lists the file |
| `p29-unportable-local-reason.mjs` | a local that cannot be captured carries its reason in the registry |
| `p30-what-the-compiler-can-follow.mjs` | F4: which ways of naming an expression leave the compiler knowing which one was meant, and what each costs to type-check |
| `p31-mapper-input-ends.mjs` | what the content mapper has to do when its input ends: a closed TypeScript API refuses every later request, closing twice is harmless |
| `p32-what-the-compiler-says-about-a-point.mjs` | what the compiler says about each thing a test can do with a selected point: 37 calls, 24 of them rejected, and the message each gets |
| `p33-one-expression-two-captures.mjs` | F18: one expression reached on two ways with the same capture, different ones, overlapping ones, and a capture on one way only; what `tsc` and the test run make of each, and what the compiler says about a local that no way captured |
| `p34-what-breaks-a-library-test.mjs` | F19, and the recount of the registered benchmark run: blocks solved per arm, library use, why library tests stopped testing or rejected valid fixes, what the selectors compare. Reads `~/.ep-bench-results/full-v2.6-2026-11-24`; without it, only the selector comparison on `token-session` runs |

`probes/lib.mjs`, `probes/types.mjs`, and `probes/e2e.mjs` are shared helpers. `e2e.mjs` builds a real consumer project with the package copied into its `node_modules`, the way `bench/toolchain.mjs` does, and runs the real `tsc` and Vitest on it. A probe that needs what the package ships builds it from the sources into its own temporary directory (`buildLibrary` in `lib.mjs`), so no probe needs `pnpm build` first and none writes the checkout's `dist/`. Each probe removes its temporary directory when it ends; until 2026-11-25 none did, and one sweep of all probes left 237 directories (86 MB) in the OS temp directory.

All 33 probes were rerun on 2026-11-24 after the merge of harness v2.5, and again after the selector change (`d279bda`): all 33 exit 0. Four things had stopped working along the way, each through an earlier change of mine, and are repaired. The helper through which nine probes read the registry's expressions (`nodeLines` in `types.mjs`) expected the layout the registry had before the selector work, so it found none, and `p21` failed outright. `p10` installed a replacement that is not meant to run, which the strict default refuses. `p24` had a comment with backticks inside a template string. `p05` lost its two third-party packages when the throwaway projects moved to the OS temp directory.

## Changelog

- 2026-11-24: first version at `b26e2c1`. Library findings F1 to F13, gap check, feature ideas, benchmark assessment from the stored results. Harness audit and oracle-file review still running.
- 2026-11-24: added the oracle-file review. Each claim taken from it was rerun before it went in. F1 widened to the project's own enums (confirmed through real `tsc`) and tied to Law C3. New F14 (captures in the dead zone, moved out of F13 and extended with the `switch` shape) and F15 (registry type differs from the expression's type). "Oracle suites" rewritten: seven wrong versions that pass every oracle file, why, law and authority inconsistencies, eight potential laws. Harness audit still running.
- 2026-11-24: added the harness audit, each point rechecked (grading instability on `cancel-commit` re-graded by me, power recomputed, robustness counts recomputed). New F16 (dangling helper names; `AbortController`). Recorded three decisions: `AGENTS.md` corrected for `select`, performance must be optimal (F6, two designs measured, the per-call one chosen), a replacement that never runs must be loud (F7, four API options). F5 now lists which application shapes a scope covers. Benchmark section rewritten around the audit.
- 2026-11-24: F6 fixed (per-function fast path; plugin Law P4, runtime Law 5, new runtime-copies oracle, source-map check; 0 gaps in runtime, discovery, plugin). `original()` settled as "evaluates on every call". Decisions recorded: accept all laws, fix all findings, build all feature ideas with oracle coverage.
- 2026-11-24: F7 and F8 fixed and F5 resolved in the runtime (strict replacements with `times` and `on`, `pause`, `replace` with `using`, `calls`, shorthands, capture-name and visitor-return checks; seven new laws; 0 gaps over runtime, discovery, plugin). README and examples describe the new API. `ORACLES.md` started for issues met with `@tanstack/oracles`. Two incidents recorded.
- 2026-11-24: schedule exploration built (`interleavings`, feature idea 9): every order, `limit`, `schedule`, `choose`; it throws `InterleavingFailure` with the order, the replay schedule and what failed. New oracle `runtime-interleavings`, example `examples/profile.test.ts`, README section, probe `p26`. New F17: an `any` that `strict` lets through and the untyped oracle test files; `checks/no-any.mjs` added to `pnpm check`.
- 2026-11-24: `interleavings` rebuilt as a primitive after the maintainer's decision: a generator of orders (`order.run(action)`, `order.schedule`, `order.released`) with the caller's own loop and checks. Oracle, example, README section and probe `p26` rewritten for it. A negative or fractional schedule entry is now refused; the first form took `-1` as "the last waiting evaluation". Benchmark harness v2.4 merged.
- 2026-11-24: the four runtime oracle files are type-checked (`include` widened, `tests/loose-select.ts`, `src/runtime.d.mts`). `checks/no-any.mjs` removed again at the maintainer's request. Decision recorded: TypeScript sources built with `tsdown`.
- 2026-11-24: the runtime is TypeScript (`src/runtime.ts` holds the implementation and the types that were in `runtime.d.ts`), built with `tsdown` into `dist/`. Three laws changed on the maintainer's decision: runtime Law 4, the replace-everywhere and pause laws of the new API, and `interleavings` no longer promise a `TypeError` for an argument of the wrong kind. The type oracle now compiles against the built declarations.
- 2026-11-24: type-generation fixes merged (F1, F2, F3, F10, F15, F16, half of F9). I reran `p06`, `p07`, `p18`, `p19`, `p21` and `p22` on the merged code; each shows the fixed behavior quoted in its finding.
- 2026-11-24: discovery, plugin and CLI work merged (F9, F11, F12, F14; `execution-points list`; `points.schema.json`; the plugin reads `points.ep` and adds the Vitest setup module). One interaction between the two delegated branches fixed oracle first: the content mapper refused the manifest's new `$schema` key. Selection by a Babel-style visitor object decided (`p30`).
- 2026-11-24: every module in `src/` is TypeScript and built with `tsdown` (full gap check: 1,950 of 1,965 mutants killed, 10 unowned, the 4 known mapper timeouts, and one gap that was a property added for a type's sake, removed). Every file under `tests/` type-checks under `strict` without `any`. F4 fixed: selection through a visitor object with `traverse`, plus `line`, `text` and `object`; `execution-points list` shows `object=` and `inside=`.
- 2026-11-24: gap check on the finished selector work: 2,100 of 2,117 noticed; the four mapper timeouts remain, three gaps in the listing closed afterwards. An expression whose type cannot be written can be selected and passed through. The benchmark's treatment guide and witness use the new API; the self-test passes.
- 2026-11-24: the last gaps closed. The mapper's frame reader walks a finite list of header ends instead of looping until done (four timeouts became four kills), `serve(input, output)` replaces the standard-input block (ten unowned mutants became owned and killed), and a new oracle generates streams of frames cut at arbitrary places.
- 2026-11-24: the full gap check over all six sources is clean (2,114 of 2,114, nothing unowned). Wrong versions written by hand then found what it cannot see: 3 of 19 implementations and 4 of 38 type declarations passed every oracle. New oracle file `types-point` (five laws for what a point's methods take and give back), new law `runtime-captured-values`, five more histories in the type oracle's capture law; `checks/wrong-declarations.mjs` and `checks/wrong-versions/` keep the hand-written wrong versions rerunnable. One defect fixed oracle first: the compile error for `pause()` on an expression that is no promise now says why. New F18 (one expression, two captures). The benchmark harness was re-evaluated on the new library: six defects, v2.5 in work. The short version at the top now says where things stand. The full gap check was run again on that commit (`9210720`): 2,114 of 2,114, nothing unowned.
- 2026-11-24: benchmark harness v2.5 merged (`9a8e0a9`): library use by any operation on a point (D-18), error types from a reporter of the harness's own (D-19), the guide's `list` command in a treatment workspace, no bench process or probe writing the checkout's `dist/`. Its self-test passes on the merged tree (156 check lines). The stored matrix re-graded with it gives 28/40 against 32/40, the numbers first derived. All 33 probes rerun; the ones that had stopped working are repaired.
- 2026-11-24: two decisions built, oracle first (`eca441d`, `d279bda`). `line` and `text` are dropped from what a visitor is handed, on expressions and on containers; `object` stays; `execution-points list` prints both as before. F18 is fixed: an expression that several ways lead to is one selection that captures what any way captured, in the runtime and in the types. Three oracle files changed and failed on the unchanged code (25 of 27, 7 of 33 and 8 of 31 tests). Full gap check afterwards: 2,117 of 2,117, nothing unowned. 31 of 31 hand-written wrong implementations and 44 of 44 wrong declarations are rejected. The benchmark section is marked as retired on your decision in the benchmark thread, where harness v2.6 and a full run on the current library are in work.
- 2026-11-25: the full benchmark run on the current library ended (run by the benchmark thread; 1,050 trials, harness v2.6). Harness v2.6 and the run's record are merged (`007fd78`); self-test on the merged tree: `Self-test PASSED: 159 check lines passed, 0 failed`. Neither primary test rejects (216, 221, 220 of 245); the closed-module difference is `stale-cache` alone. New F19 from the stored rows: library tests are tied to the name of the helper they select by. New probe `p34` recounts the run and shows it. Probes now remove their temporary directories.

## Incidents

**The disk ran full during the benchmark run (2026-11-25, 13:37).** The grading of the fifth replicate failed with `ENOSPC`; the data volume had 3 to 5 GB free of 228 GB. This repository's share of the disk was about 2.7 GB in all. My own leftovers were 237 temporary probe directories and one backup, about 0.2 GB, which I deleted; the probes clean up after themselves since `cf32084`. The rest of the space belongs to other projects on the machine, which I did not touch.

**The pnpm store on this machine was emptied (cause unknown).** At about 14:55 on 2026-11-24 `~/Library/pnpm/store` became empty and the pnpm shim at `~/Library/pnpm/bin/pnpm` stopped working, because the pnpm it starts was a link into that store. The repository and the delegated checkouts are unaffected (their `node_modules` hold their own files). At that minute a gap check of mine and a delegate's re-grading loop of the benchmark were running; neither the commands I could read nor the harness code touches `~/Library/pnpm`. The harness delegate's own account of that quarter of an hour: no `pnpm` command, one `rm` inside its scratch directory, and benchmark processes that delete only temp directories they created. The type-generation delegate's account: it ran `pnpm verify`, which ended at 14:55:07, the second that `~/Library/pnpm` was last modified; the store directory changed at 14:55:35, while only `node probes/…` was running there; its next `pnpm` call at 14:56:56 already failed. So the closest thing to a cause is pnpm's own launcher during an ordinary `pnpm verify`. `node_modules` here was created by pnpm 12.21.0, and the shim may have been switching versions; that is a guess, not a finding. The disk was 93% full. `/opt/homebrew/bin/pnpm` still works. Until this is repaired, the validation commands run through Node directly: `node node_modules/typescript/bin/tsc --noEmit --runExternalCode`, `node checks/verify.mjs`, and `node node_modules/@tanstack/oracles/oracle-gaps/index.mjs --package . --source … --seed 42`.

**The benchmark harness deleted packages through a symlinked `node_modules` (caused by me, repaired).** I ran `bench/run.mjs --self-test` in a scratch copy of the repository whose `node_modules` was a symlink to the real one. Toolchain preparation copies `node_modules` and strips packages from the copy; the copy of a symlink is a symlink, so it removed `@tanstack/oracles` and `fast-check` from the real `node_modules` and wrote a stray `execution-points-prototype` into it. `pnpm install --frozen-lockfile` restored it and the baseline was verified afterwards. Nothing tracked by git was touched. Since v2.4 the harness refuses a symlinked `node_modules`.

**`--sweep-stale` deleted the temp directories of running benchmark processes (fixed in v2.4).** `sweepStaleTempDirs()` in `bench/toolchain.mjs` removed every `ep-*` directory in the OS temp directory, including those of a bench process that was still running. It is opt-in, and I was wrong to write that it runs at startup. Every temp root now records its owner, and the sweep removes a root only when that process is gone.
