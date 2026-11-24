# Issues met while working with `@tanstack/oracles`

A running log. Each entry says what I was doing, what happened, and what would have made it smooth. Version in use: the `pkg.pr.new` build at commit `6d05f05`.

## 2026-11-24

### A mutant that breaks module load is a `setup-error` no ordinary oracle can clear

**Doing:** closing gaps in `src/runtime.mjs` after moving the shared registry to a module-level constant.

**What happened:** the mutant `Symbol.for('…') → undefined` makes `globalThis[undefined] ??= …` throw while the module loads. The gap check reported `setup-error` with the directive "Run an owner test that loads this module and asserts on its exports, so a failed load rejects the mutant." Every oracle file imports the runtime statically, so under this mutant the whole file fails before any driver runs, and a dynamic `import()` inside a driver returns the already failed module. The only way I found was a separate oracle file that never imports production statically and loads it inside the driver (`tests/runtime-copies.oracle.property.test.ts`).

**Would have helped:** the directive saying that the owner test must not import the module statically, or the framework treating "every owner file fails to load under this mutant" as a kill.

**It came back.** Adding a Vitest setup file that imports the runtime statically (`src/vitest.mjs`, listed in `setupFiles`) brought the same `setup-error` back for the same mutant, because the setup file now failed to load before any oracle file ran. The setup file had to import the runtime lazily inside its hook. So this mutant shapes production code twice: once in where the registry lives, once in how the setup module imports.

### `extra-work` was reported for a change that alters behavior

**Doing:** the same gap run, on `if (!states.has(file)) states.set(file, …)`.

**What happened:** the mutant `!states.has(file) → true` was classified `extra-work`. It does not only do more work: it hands a fresh state object to a second registration of the same file, so the first registration's flags and the second's diverge. No history registered a file twice, so no observation differed. The label sent me looking for a work bound, when the missing piece was a history.

**Would have helped:** a note in the directive that `extra-work` means "same observations in every history tried", which can also mean the histories never reach the difference.

### An awaited promise that never settles is reported as `timeout`, like a synchronous loop

**Doing:** closing gaps in the new pause API.

**What happened:** ten mutants remove a `resolve` or `reject` call, so a driver that awaits the promise hangs. They show as `timeout` gaps. The design skill describes `timeout` only for a mutant that loops forever synchronously and calls that a CLI limitation to report and leave. These are not that: the driver has to bound its own waits (I count microtask turns) so that "still pending" becomes an observation.

**Would have helped:** the gap line or the skill distinguishing a synchronous hang from a driver that waited on something that never came, with the instruction to bound the wait.

**It came back in another shape.** In the generator form of `interleavings`, a mutant makes the walk hand out the same order forever. Nothing hangs and no promise stays pending: the driver's own `for … of` loop simply never ends, one awaited run after another, and the gap is again labeled `timeout`. The driver now takes its orders through a wrapper that throws after more orders than the scenario can have. So a driver must bound every loop over what production hands out, not only every wait.

### The gap check cannot run red-first for a law about a function that does not exist yet

**Doing:** recording the red state of new API laws on the unchanged runtime.

**What happened:** the oracle file names `src/runtime.mjs#verifyReplacements` in `owns`. On the unchanged code the gap check refuses to start: "owns entry … names no function in src/runtime.mjs". So for a new exported function there is no red run through the gap check; the red state is "the export is missing".

**Would have helped:** running the baseline and reporting the missing function as a failing owner, instead of refusing.

### Production state that outlives a history breaks calibrations and determinism runs

**Doing:** adding plugin Law P4, whose driver instruments a file and reads its flags.

**What happened:** the runtime keeps per-file state for the life of the worker. The framework runs a history's driver more than once (the plain run, the determinism run, each calibration's clean run). The second run of the same history found the file's flag already set by the first, so the clean run failed and all calibrations with it. Each run now uses a file name of its own.

**Would have helped:** a sentence in the design skill's driver section: a driver is run several times per history in one worker, so anything production keeps globally must be keyed per run.

### No way to run only the baseline of every oracle file

**Doing:** checking hand-made wrong versions of production, and the red state before a change, against all oracle files.

**What happened:** `--only <id>` restricts the baseline to the owners of that one mutant, so other oracle files do not run. I used `--sample 1` over all sources, which runs every file's baseline plus one mutant.

**Would have helped:** a `--baseline-only` flag.

### The replay command the gap check prints runs Vitest alone

**Doing:** reading why a law failed.

**What happened:** the repository's rule (from the setup skill's `AGENTS.md` block) is to run oracles only through the gap check, never Vitest alone. The gap check's own failure output prints `replay: vitest run … -t '…'`, and the log does not contain the expected and received values, so following the printed replay is the only way to see them.

**Would have helped:** the expected-versus-received diff in the gap check's log, or the rule naming the printed replay as the allowed exception.

### Type declaration files get no mutation evidence

**Doing:** reviewing what holds `src/runtime.d.ts`.

**What happened:** the types oracle lists `src/runtime.d.ts` in `owns`, but the gap check mutates only the sources passed in `--source`, and a `.d.ts` has nothing it can mutate. Three hand-made wrong versions of the type contract passed all oracle files (see `FINDINGS.md`, "What the gap check does not show").

**Would have helped:** a warning when an owned file yields zero mutants, and a documented way to supply authored mutants for declaration files.

### `differs` tells `-0` from `0`

**Doing:** writing a model that sums `n * (n - 1) / 2`.

**What happened:** for `n = 0` the model produced `-0` and production `0`, and the law failed with a diff that printed both as `0`. Correct by `Object.is`, but the printed diff did not show why.

**Would have helped:** printing `-0` as `-0` in the diff.

### A mutant that only waits longer needs a work bound, and nothing says what "work" counts

**Doing:** closing gaps in `interleavings`, whose quiet-point loop waits for two still turns of the event loop.

**What happened:** mutants that make the loop wait three turns instead of two give the same observations in every history. They were reported as `extra-work`, and the summary named a ratio for each. Setting `work: { ratio: 1 }` on the property closed them. Before trying it I could not tell from the skill whether a wait on `setImmediate` is work the framework measures or a timer it leaves out, so I had also started designing a turn counter of my own in the driver.

**Would have helped:** a sentence in the skill on what the work bound measures (calls, event-loop turns, time) and that awaited turns count.

### `owns` cannot name a class, only its members

**Doing:** adding the error class `InterleavingFailure` to the runtime and to the interleavings oracle's `owns`.

**What happened:** `src/runtime.mjs#InterleavingFailure` is refused: "owns entry … names no function in src/runtime.mjs". The skill documents `#Class.method` but not what to write for a class whose only member is its constructor. `src/runtime.mjs#InterleavingFailure.constructor` is accepted. A statement after the class (`InterleavingFailure.prototype.name = '…'`) belongs to no unit an entry can name, so I moved the assignment into the constructor: again the tool shaped production code.

**Would have helped:** accepting a class name as "all of its members", or naming `#Class.constructor` in the skill and in the refusal.

### `owns` has no way to name types

**Doing:** moving the runtime from `runtime.mjs` plus a hand-written `runtime.d.ts` to one `runtime.ts`.

**What happened:** the type oracle owned `src/runtime.d.ts`, a file with nothing to mutate. With the types inside `runtime.ts`, there is nothing it can name: an entry is a file, a function, or module-level data, and a type is none of them. Owning the file would run the type oracle's 31 compile-heavy tests against every one of about 900 runtime mutants, none of which it can notice. I let it own the built declarations instead (`dist/runtime.d.mts`), which is at least exactly what it compiles its fixtures against, and which makes the gap check refuse to start when the build has not run.

**Would have helped:** an `owns` entry for a type or an interface (no mutants, but stated coverage), or a documented way to say "this oracle is evidence for declarations only".

### A variable initialized for the type checker's sake is a gap

**Doing:** the same conversion.

**What happened:** `let heldAtEnd` became `let heldAtEnd = false` to give it a type. The value is always assigned before it is read, so the mutant `false → true` survived as `not-observed`. Correct of the tool, and a useful catch: the fix was `let heldAtEnd: boolean | undefined`, not a history. Noted here because the directive for `not-observed` points at the oracle, and the cheaper answer was that production had gained dead code.

### Reported by the type-generation work (a delegated session, same day)

These are another session's notes, taken over as written and not rechecked by me.

- The gap check prints only the first failing test of a file, with no observed or owed value. Seeing the values took the printed replay command plus a custom Vitest reporter that reads `error.actual` and `error.expected`.
- A failing generated property shows only the shrunk counterexample, which had failed for a different reason than the constructed history it was shrunk from.
- The `work` bound does not judge tests that hold I/O open, so mutants that delete a cache came back `not-observed` instead of `extra-work`.
- Owners are judged per file, and every history runs about three times (test, determinism, calibration). A full run over two source files took 17 minutes for 837 mutants on a loaded machine.
- A gap line for an optional chain shows only `` ` ?. ` → ` . ` `` and a line number. Which `?.` of the line it is has to be read from `position` in `results.jsonl`.
- The class `not-judged` appeared twice with no entry in the legend.
- A synchronous endless loop is reported as a `timeout` gap; four such gaps remain in the mapper's frame reader.
- A run leaves `.oracle-gaps-<pid>/` in the package directory while it runs.

### Reported by the discovery and plugin work (a delegated session, same day)

Another session's notes, taken over as written and not rechecked by me.

- One failing test per oracle file is reported, as "the observed value differs from the owed value", with no diff and no list of the other failures. Seeing the diff needs the printed replay, which is a plain Vitest command.
- The gap check refuses when `owns` names a file that does not exist yet, so a new module cannot show red.
- A mutant that only does more work was classed `not-observed` with a directive pointing at an unrelated oracle file; an `extra-work` directive asked for a `work` ratio in an oracle file that session was not allowed to edit. It removed both shortcuts from production instead.
- A model cannot await. For a law that compares instrumented code with the same code uninstrumented, the driver records the reference runs and the model reads them from the trace.

### The run's temporary directory gets committed by `git add -A`

**Doing:** committing documentation while a gap check was running.

**What happened:** the gap check keeps `.oracle-gaps-<pid>/` in the package directory for the length of the run. It is not in any ignore file the package ships, so `git add -A` staged its eleven files, and I committed and pushed them to a branch before I saw it.

**Would have helped:** the run directory under the OS temp directory, or the setup skill adding `.oracle-gaps-*/` to `.gitignore`.

