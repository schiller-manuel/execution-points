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

