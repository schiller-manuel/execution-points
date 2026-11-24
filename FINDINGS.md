# Findings

Full review of the library, the oracle suites, and the benchmark, started at `b26e2c1` on 2026-11-24. This file is kept current; the changelog at the bottom says what changed and when.

Every finding names the probe that shows it. Probes are small scripts in `probes/` that call the unchanged production code. Run any of them from the repository root, for example `node probes/p08-e2e-node-builtin-types.mjs`. They build their throwaway projects under the OS temp directory and write nothing into the repository.

Nothing in `src/`, `tests/`, or `bench/` was changed by this review. The laws belong to the maintainers, so every proposed law below is a potential law until approved.

## Short version

- **The library has one defect that should be fixed before anything else.** A single expression or local in any target file whose type comes from a Node built-in module (`fs.Stats`, `http.Server`, ...) or is a member of the project's own enum makes `tsc` fail for the whole project (F1). 22 of 38 everyday Node calls trigger it, and so does an optional enum parameter. The benchmark tasks happen to avoid both.
- **Two more type-generation defects** leave the editor with stale types (F2) and make expressions unselectable when the project declares global types outside the targets (F3).
- **The oracles are green but hold less than that suggests.** The gap check misses 248 of 1,472 small code changes (17%), all in `contracts.mjs` and `content-mapper.mjs`. It notices every small change in `runtime.mjs`, `discovery.mjs`, and `plugin.mjs`, yet seven deliberately wrong versions of the runtime, discovery, plugin, and type contract pass every oracle file. No law compiles the generated registry, which is why F1 went unseen.
- **Listing a module as a target made it run 30 to 120 times slower** even when no test replaced anything (F6). Fixed: untouched code now runs at 1.0x, and so do the other functions of a file in which a test replaces something.
- **A second type-generation defect hits the benchmark directly.** A type that cannot be written as a helper leaves its name behind with no definition (F16). `AbortController` is one, so the benchmark's own reference fix for `cancel-commit` fails the treatment-only typecheck.
- **Do not rerun the whole benchmark now.** The runtime, plugin, and discovery code are byte-identical to the last paid run; only the types and twelve lines of the treatment guide changed. A full rerun would cost about 2,700 credits and, by the protocol's own power calculation, could not reach significance. The section "Should the benchmark be rerun" gives the sequence I recommend instead.
- **The benchmark measures regression-test quality, not bug fixing.** Across all 138 stored trials the hidden grader passed 68 of 69 in each arm. Every difference in `solved` comes from one component, `adequateReproduction`, and on `cancel-commit`, the only equal-capability task with signal, that component changes between identical re-gradings.

## Decisions

Made on 2026-11-24 by Manuel Schiller:

- `select` replaced the earlier query-string API. `AGENTS.md` is corrected.
- F6: performance must be optimal, indistinguishable from uninstrumented code. Done; see F6.
- `original()` evaluates the expression on every call. `AGENTS.md` and the README no longer call it provisional.
- All eight potential laws are accepted, every finding is to be fixed, and every feature idea is to be built with oracle coverage. Status is tracked in "Work in progress" below.
- F7: a replacement that never runs must be loud. All four API options are built; for an asynchronous action the returned promise stays the action's own and the test fails at its end through a Vitest hook. Done; see F7.
- An implicit `any` is an error: `strict` is on, and the type check is being widened to the oracle test files (F17). There is no separate check for an `any` that a library declaration hands over; `checks/no-any.mjs`, which I had added for that, is removed again at your request.
- The library moves to TypeScript sources built with `tsdown`, and argument checks that the compiler already makes are dropped from the runtime. Done for the runtime (`src/runtime.ts`, `src/vitest.ts`, build into `dist/`); the other four modules follow when the two delegated branches, which edit them, are merged. The rule applied: what the compiler rejects is not checked again at run time; what depends on run-time state stays. Removed: the `typeof` checks on `visitor`, `handler`, `action`, and on the points and action of `interleavings`. Kept: everything about selections, capture names, schedules and replacements that never ran, and the value check on `times` and `on`, because the compiler accepts any number there.
- Schedule exploration is a primitive to compose, not a function that takes the checks: `interleavings(points)` is a generator of orders, and the caller runs the scenario and checks it in the loop body. Rebuilt that way; the first form with `run`, `check`, `setup` and `limit` options is gone.

Still open:

1. New selector fields for F4 (`receiver`, `inClass`, `assignedTo`, `text`, `line`): the API is yours to approve before it is built.
2. New benchmark tasks: which, and in which stratum.
3. The benchmark sequence at the end of this file: approve, or change.
4. Your global pnpm broke during this work (see "Incidents" below); say whether I should repair it.
5. Four laws the type-generation work added or reworded without your named approval. Confirm or strike: `contracts-one-copy-per-private-type` (one helper per private type, two brands for two nominal types); `contracts-cost-of-names` (three relations between counts of TypeScript requests, standing in for a work bound); the mapper's watch set is the tsconfig, the targets, and every project file the analysis read; a reason for an unselectable expression must name its subject.
6. The details of `interleavings` that your decision did not fix: each order is an object with `run(action)`, `schedule` and `released` (instead of a bare callback); the options `schedule` (one order again) and `choose` (pick every order, endless); taking the next order before the current one ran, and running an order twice, throw. They are built and listed as proposals in the oracle's limits.

## Work in progress

| Item | State |
| --- | --- |
| F6 fast path | done |
| `original()` settled, `AGENTS.md` corrected for `select` | done |
| F7 loud replacements: strict by default with `times` and `on`, built-in pause, `point.replace()` with `using`, `point.calls`, `call` in the context; F8 capture-name checks; shorthands `returns`, `throws`, `resolves`, `rejects`; F5 covered by `replace` | done |
| Type-level laws for the new API (`pause` only on promises, option and value types) | queued behind the type-generation merge, which rewrites the type oracle's compile step |
| Treatment guide and benchmark witnesses using the new API | queued behind the harness merge |
| F1, F2, F3, F10, F15, F16, registry half of F9; potential laws 1, 2 and 4; registry source mappings; an opaque result for unwritable expressions | merged; gaps in `contracts` and `content-mapper` went from 248 to 4, all four an endless loop in the mapper's frame reader |
| Benchmark harness fixes from the audit (harness v2.4) | merged; `--self-test` passes 138 checks and fails 4, all the treatment typecheck of fixes that use `AbortController` or `fs.Stats` (F16, F1) |
| F14 dead-zone captures, F11 skip rule, F12 plugin re-reads, plugin half of F9, `executionPoints()` reading `points.ep`, manifest schema, the `list` command | queued behind the fast path, which edits the same files |
| Schedule exploration: `interleavings(points)` as a generator of orders, with `schedule`, `choose`, and the `InterleavingFailure` error | done |
| Type-check the oracle test files (F17) | done for the four runtime oracle files, which are now in `include`; 52 errors remain in the other five, queued behind the merges, which edit those files |
| Move to TypeScript built with `tsdown`; drop run-time argument checks the compiler makes | done for the runtime; `discovery`, `plugin`, `contracts` and `content-mapper` are queued behind the merges |
| Selector fields (F4), `new` and `await` as selectable kinds, pass-through for unportable types | queued behind the merges |

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

**Half fixed 2026-11-24.** The registry now includes a file that starts with a byte order mark (`p06`: both sides see 1 node). The other half, a global script that the plugin instruments differently, is in the discovery branch.

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
| An ambiguous selection is reported only when a method is called on the result. `export const points = [select(...)]` with two matches compiles. | `p15-compile-errors-as-a-user-sees-them.mjs` |
| A local with an unportable type disappears from `capture`'s accepted names with no reason: `'"item"' is not assignable to parameter of type '"id"'`. | same probe |
| The unportable message says the expression "cannot be selected directly". There is no indirect way. | same probe |
| Registry errors have no source mapping (`mappings: []`), so F1 is reported at `points.ep(9,227)`. | `src/content-mapper.mjs:103` |
| The README's Vitest config imports `./src/discovery.mjs` (`README.md:147`), which the package does not export. A consumer has to repeat the targets in `vitest.config.mjs`, as the benchmark does (`bench/run.mjs:586`), and the two lists can drift. `executionPoints()` with no arguments instruments nothing. | `package.json` exports |
| `src/content-mapper.mjs:153-159` attaches `stdin` listeners at import time, so the oracle that imports it gets them too. | file |
| The plugin inserts its import before a leading directive such as `'use client'` (`importOffset` skips only a BOM and a shebang, `src/plugin.mjs:132-139`), so the string is no longer a directive. Whether any framework in a test run depends on it is not verified. | file |
| Fixed with harness v2.4: `checks/verify.mjs:318` said `fromFile()`; `bench/EXECUTION_POINTS_GUIDE.md` was referenced by nothing, showed the old verbose selector, and awaited the overlapping operation while holding the barrier. The message is corrected and the file is removed. | `grep` |

### F14. Discovery offers captures that are not initialized when the point runs

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

Fixed for the four runtime oracle files: they are in `include` and compile. `tests/loose-select.ts` gives `select` the types a hand-registered file can have, because the registry only knows the targets in `points.ep`. Open: the other five oracle files (52 errors). They become straightforward once the sources are TypeScript, since the missing declarations are most of what is wrong.

**An `any` that a declaration hands over is not implicit.** `Promise#then` and `Promise#catch` declare the rejection reason as `any`, so in

```ts
const failure = await everyOrder().catch((error) => error)
```

both `error` and `failure` are `any`, `tsc` reports nothing, and every property read from `failure` is unchecked. The first version of `examples/profile.test.ts` hid this behind an annotation (`const failure: InterleavingFailure = …`), which the compiler accepts without checking. No compiler option reports this. The lint rule that does (`no-unsafe-assignment`) is not available for TypeScript 7.1 yet.

What is done about it: an order's `run` rejects with an exported class, `InterleavingFailure`, so a test writes `(error: unknown) => error` and narrows with `instanceof`, and the example does. I had also added a script that failed on such an `any`; it was removed at the maintainer's request, so nothing reports this shape automatically until the lint rule supports this compiler.

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

Ordered by how much evidence there is that users need them. Built so far: 1, 2, 6, 7 and 9 (in the runtime, each with its own laws); 3, 5, 10 and 11 are in the delegated branches; 4 and 8 are open.

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

Everything here is recomputed from the three stored `results.jsonl` files or rerun at zero credits. An independent audit of the harness produced several of the points; each one below was rechecked before it went in, and the ones I did not recheck are listed separately.

**State on 2026-11-24, after the merge of harness v2.4.** The harness defects below are fixed; each row says so. Nothing was rerun for credits. The stored results were only read. I checked the merged harness two ways: `node bench/run.mjs --self-test` on the current runtime (138 checks pass; 4 fail, see the first threat), and `node bench/analyze.mjs` on the stored matrix, which prints the numbers of this section (31/40 against 35/40; 66/66, 38/47 with 9 loud breaks, 30/30).

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
| A treatment-only gate rejects valid fixes | `contractTypecheckPass` fails for a fix that uses `AbortController` (F16) or `fs.stat` (F1), whether or not the test uses the library. The benchmark's own `cancel-commit` reference fix fails it. The audit found 5 of 65 calibrated variants failing treatment `tsc`. `--self-test` typechecks baselines only, so it passes. No stored trial hit it. | control | Open until F16 and F1 are merged. The self-test now typechecks every variant in both arms and fails on exactly these 4. |
| The control guide's example is one of the tasks | `control-guide.md:22-41` uses `'./storage'`, `readFromDb`, `getProfile`, and `updateProfile('u1', 'Bob')`, which are the real names in `stale-cache-seam`. The treatment guide uses placeholders. Control solved that task 7/7, treatment 6/7. | control | Fixed: both arms get the same guide with placeholder names, and the self-test rejects a guide that names a task. |
| The treatment guide replaces the `vi.mock` recipe instead of adding to it | The treatment guide has no `vi.mock` example and no fake-timers note. The contrast is "library recipe instead of module-mock recipe". In the io-seam stratum 19 of 35 treatment agents used the library where `vi.mock` is the natural tool. | either | Fixed: the treatment guide is the control guide plus one library section; a parity check enforces it. |
| The treatment guide was tuned on the last run's failures | The selector note was added in `72d8bc8`, after the results commit, and targets exactly the two control-only pairs. The control guide has not changed. A rerun on the same tasks measures the tuning. | treatment | Changed: both guides are new, so a rerun compares new guides. The library section still has to be rewritten for the new API. |
| The task sources avoid everything the library cannot do | 17 files, no generics, no optional chaining, no classes. 0.4% of candidate expressions are hidden by the skip rule against 6 to 7% in this repository's own code (F11). | treatment | Open: needs new tasks. |
| Any error counts as reproducing the bug | `classify` treats every failure that matches neither the timeout nor the loud-break pattern as `true_red` (`bench/run.mjs:834-849`). There is no check for `AssertionError`, although `PROTOCOL.md` section 2 says "genuine `AssertionError`". The loud-break pattern looks for `ExecutionPoint`, which matches none of the runtime's `[execution-points]` messages, so "was not instrumented" counts as a reproduction. | neither systematically | Fixed: only an `AssertionError` is a reproduction; the library's own errors are a loud break; anything else is `error`. |
| The same root cause is scored differently per arm | A missing interception point is a selector break for a library test and a timeout for a `vi.mock` test. Only the timeout enters the false-red rate. | treatment, in reporting | Fixed: one set of counts for both arms. |
| Power | The protocol's arithmetic is right (78, 125, 231 blocks) but uses a best case. Under that best case the last run's 28 primary blocks had power 0.055. At the discordance and direction actually observed, 80% power needs 1,144 blocks (last run) or 610 (pooled). | neither | Unchanged; it is arithmetic. |
| Pairing and provenance | Pairs are keyed on the served model name, so a row whose served name differs, or an aborted row with none, silently loses its pair (`bench/stats.mjs:77-84`). `--regrade` stamps old trials with the current checkout's provenance, so re-graded old trials would pool with a new run. | neither | Fixed: pairs are keyed on the requested model, every unmatched row is warned about, and a re-grade keeps the original provenance. |

Reported by the audit and not rechecked by me, with what v2.4 did about each: a harness-exception row lacked provenance fields and made `analyze.mjs` exit instead of running the promised sensitivity analysis (it now warns and runs it); 12 of 69 treatment trials tried to open a README or `dist` for the library, which the workspace does not ship (open); the Newcombe interval collapsed to `[0, 0]` for all-concordant data (the analyzer now prints Method 10 with the old interval beside it; the method numbers were written from memory, the formula is in the code); several E9 denominators and pilot credit intervals in `BENCHMARK-LOG.md` differed from what `analyze.mjs` prints (corrected in the log); the log said the host-sleep row was re-graded but the stored file still has it ungradable (the log now says so); the default `--max-total-credits` of 300 would have stopped a rerun of the last matrix early (a dry run now prints the projected need and says the matrix would be refused: 471.2 credits for that matrix).

### Should the benchmark be rerun

Not as a whole, and not yet.

**What actually changed since the last run** (`git diff da61474 b26e2c1 --stat`): `src/contracts.mjs`, `src/runtime.d.ts`, twelve lines of `bench/guides/treatment-guide.md`, tests, and docs. At that commit an agent's test behaves at runtime exactly as before. The performance work in F6 will change the plugin and runtime next.

**Why a full rerun is the wrong next step:**

1. It cannot answer the primary question. See the power row above.
2. The one equal-capability task with signal is graded unstably.
3. A treatment-only gate currently rejects the reference fix of that same task.
4. It would compare a tuned treatment guide against an untouched control guide whose example is one of the tasks.
5. Whatever it produced could not be pooled with the earlier runs, and the library is about to change again (F1, F6, F16).

**What I would do instead, in order:**

1. Library: fix F1 and F16, land F6, decide F7. Then freeze the library at a tagged commit. *F6 and F7 are done; F1 and F16 are in a branch about to be merged; the API has grown since (pause, `replace`, `interleavings`), so the freeze comes after you have accepted it.*
2. Harness: grade every variant several times and require agreement; typecheck every reference and valid fix in a treatment workspace during `--self-test`; require `AssertionError` for a reproduction; print still-red, loud-break, and timeout counts per arm; pair on the requested model and warn on every unmatched row. *Done in v2.4.*
3. Guides: give both arms both recipes with placeholder names, and freeze them. *Both arms now share one guide. Still to do: rewrite the treatment guide's library section and the witnesses for the new API, then freeze.*
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

`probes/lib.mjs`, `probes/types.mjs`, and `probes/e2e.mjs` are shared helpers. `e2e.mjs` builds a real consumer project with the package copied into its `node_modules`, the way `bench/toolchain.mjs` does, and runs the real `tsc` and Vitest on it.

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

## Incidents

**The pnpm store on this machine was emptied (cause unknown).** At about 14:55 on 2026-11-24 `~/Library/pnpm/store` became empty and the pnpm shim at `~/Library/pnpm/bin/pnpm` stopped working, because the pnpm it starts was a link into that store. The repository and the delegated checkouts are unaffected (their `node_modules` hold their own files). At that minute a gap check of mine and a delegate's re-grading loop of the benchmark were running; neither the commands I could read nor the harness code touches `~/Library/pnpm`. The harness delegate's own account of that quarter of an hour: no `pnpm` command, one `rm` inside its scratch directory, and benchmark processes that delete only temp directories they created. The type-generation delegate's account: it ran `pnpm verify`, which ended at 14:55:07, the second that `~/Library/pnpm` was last modified; the store directory changed at 14:55:35, while only `node probes/…` was running there; its next `pnpm` call at 14:56:56 already failed. So the closest thing to a cause is pnpm's own launcher during an ordinary `pnpm verify`. `node_modules` here was created by pnpm 12.21.0, and the shim may have been switching versions; that is a guess, not a finding. The disk was 93% full. `/opt/homebrew/bin/pnpm` still works. Until this is repaired, the validation commands run through Node directly: `node node_modules/typescript/bin/tsc --noEmit --runExternalCode`, `node checks/verify.mjs`, and `node node_modules/@tanstack/oracles/oracle-gaps/index.mjs --package . --source … --seed 42`.

**The benchmark harness deleted packages through a symlinked `node_modules` (caused by me, repaired).** I ran `bench/run.mjs --self-test` in a scratch copy of the repository whose `node_modules` was a symlink to the real one. Toolchain preparation copies `node_modules` and strips packages from the copy; the copy of a symlink is a symlink, so it removed `@tanstack/oracles` and `fast-check` from the real `node_modules` and wrote a stray `execution-points-prototype` into it. `pnpm install --frozen-lockfile` restored it and the baseline was verified afterwards. Nothing tracked by git was touched. Since v2.4 the harness refuses a symlinked `node_modules`.

**`--sweep-stale` deleted the temp directories of running benchmark processes (fixed in v2.4).** `sweepStaleTempDirs()` in `bench/toolchain.mjs` removed every `ep-*` directory in the OS temp directory, including those of a bench process that was still running. It is opt-in, and I was wrong to write that it runs at startup. Every temp root now records its owner, and the sweep removes a root only when that process is gone.
