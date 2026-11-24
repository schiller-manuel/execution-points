# Working on execution-points

This is an early prototype of a generic testing tool. Keep experiments small
and runnable, and continue discussing unresolved API choices with the user.

## Agreed direction

- Select an expression externally with `select(file, visitor)`. `select` is
  the only selection API; the earlier query-string API built on an AST query
  language was replaced by it. The visitor has two forms:
  - a callback that narrows the file's typed union of selectable expressions
    and returns the one it wants;
  - an object keyed by node type, as in Babel: `CallExpression`,
    `BinaryExpression`, `ConditionalExpression` for expressions, and `Function`
    and `Class` (Babel's alias keys) for what contains them. A handler returns
    the node it selects, or `node.traverse(visitor)` to look inside it. That is
    how "inside this function" is said; no `inClass` field is added.
- Build on established patterns (Babel's visitors, ESTree's names, what
  JavaScript itself calls things) instead of inventing vocabulary. A selector
  can only use properties that sit directly on the node, because TypeScript
  narrows through nothing else (`probes/p30-what-the-compiler-can-follow.mjs`);
  the compiler knowing which expression was selected is what types the
  handler.
- Leave authored application source unchanged; instrument it during tests.
- Run application code and replacement callbacks in the same Node test worker.
- Use ordinary TypeScript files and virtual compiler projections for types.
- Capture explicitly selected local bindings at the interception point.
- Make the captured bindings read-only, while preserving ordinary mutation of
  referenced objects.
- Intercept before the whole expression. Returning a replacement skips that
  expression's evaluation. `original()` evaluates it on demand.
- Activate replacements through an explicit callback scope using
  `point.withReplacement(handler, action)`.
- `original()` evaluates the expression on every call. It is not memoized and
  not limited to one invocation.
- Instrumented code must be indistinguishable in speed from uninstrumented
  code until a test installs a replacement for one of a function's own
  expressions. A function decides once per call whether to run its original
  statements.
- A replacement that never runs must be loud.
- The sources are TypeScript, built with `tsdown` into `dist/`. What the
  compiler rejects is not checked again at run time: no `typeof` checks on
  arguments. Checks that depend on run-time state stay (a selector that
  matches 0 or 2 expressions, a capture name the expression does not offer, a
  schedule that does not fit the run).
- Schedule exploration is a primitive to compose: `interleavings(points)` is a
  generator of orders, and the caller runs and checks each one itself.

## Validation

Run from the repository root:

```sh
pnpm build
pnpm check
pnpm test
pnpm verify
```

`pnpm build` writes `dist/`. Every module in `src/` is TypeScript; nothing
there is run by a consumer. Tests and the gap check run against `src/`, but
`tsc` starts the content mapper from `dist/`, and the type oracle compiles its
fixtures against the built declarations, so build before running any of them
(the package scripts do).

The virtual compiler check is separate from Vitest. Passing runtime tests alone
does not establish that replacement callbacks are type-correct. Do not claim
editor integration exists until an editor adapter is implemented and verified.

## Git workflow

The user requested frequent commits and pushes to
`schiller-manuel/execution-points`. Commit coherent milestones and push them to
`origin` when access is available. Report authentication or permission failures
accurately; a local commit is not a successful push. Preserve the repository's
private visibility.

<!-- BEGIN @tanstack/oracles (template 4) -->

## Oracle tests

This repository tests its design with `@tanstack/oracles`. An oracle
captures the code's design as laws and enforces them against an independent
model. Work oracle first, production second.

**Who owns what.** The laws belong to the people who maintain this
repository: what the code promises, the authority for each promise, and its
limits. Propose a law, but do not adopt or change one without their
approval. The production code that the oracles own is yours. Whenever you
change it, do a good job, not a minimal or lazy one: the fast, small,
elegant version, as an optimizing compiler for the oracle would write it.
Anything that keeps every oracle passing is allowed, so a big refactor is
fine when it makes the code better; the oracle is the review. Keep it in
proportion to the task: improve the code the work touches, and when you see
a larger win elsewhere, offer it instead of turning the task into a long
optimization project.

**How the work goes.**

- **Probe first.** Before you propose anything, call the real code with
  small scripts and show what they print. Every law and every finding comes
  with a probe that can be rerun.
- **Propose the laws, then build only the approved ones.** Each law is a
  "For every …" sentence with where its promise is written: the docs, a
  test, or a maintainer's decision. A question nobody has decided is fine:
  state it as a limit.
- **Red first, like TDD, but the oracle goes red.** A bug becomes a law and
  a history that fail on the unchanged code. Then fix production at once,
  and show the run going green.
- **Never weaken or quarantine an oracle:** no skip, no `test.fails`, no
  loosened expectation, no switch that turns a check off.
- **Build the strongest model the laws need.** Compare every observable
  result they speak about. The model states the rule a user relies on,
  never the code's algorithm, even when the docs describe that algorithm.
  Give each law a calibration: a wrong answer the check must reject.
- **Run the oracles only through the gap check, never Vitest alone.** It
  prints each test file's result first, then each gap as it is judged, and
  ends with one `oracle-gaps: done` line. A run
  can take minutes: start it in the background with output to a log at a
  path of its own (never a fixed path under `/tmp`), and read the new lines
  every few seconds, acting on a failure first. Stop a
  run only by the process ID you recorded, never by name.
- **Green is not done.** A gap is a change to the owned code that no law
  notices. There are no equivalent mutants: never call one equivalent.
  Widen the histories or the check until the oracle sees it, and keep going
  until a bug or a design question turns up.
- **Report classes of bugs:** the rule broken, and the measured share of
  generated inputs that break it. Never call one minor.

**Skills.**

- To explore an area of the code (or the whole repository), find where an
  oracle would help, or propose a new one, read
  `node_modules/@tanstack/oracles/skills/oracles-explore/SKILL.md` in full
  and follow it.
- Before you create or change an oracle, or change production code that an
  oracle owns, read `node_modules/@tanstack/oracles/skills/oracles-design/SKILL.md`
  in full and follow it.
- Before you review oracle work, read
  `node_modules/@tanstack/oracles/skills/oracles-review/SKILL.md` in full.
- Before you act on review findings, read
  `node_modules/@tanstack/oracles/skills/oracles-evaluate-review/SKILL.md` in
  full.
- Lint: not available here (typescript-eslint does not support TypeScript 7.1 yet; its TypeScript peer range ends before 7).
- Oracle files: `tests/**/*oracle*.test.ts`. Gap check: `pnpm build && pnpm exec oracle-gaps --package . --source src/runtime.ts,src/discovery.ts,src/plugin.ts,src/contracts.ts,src/content-mapper.ts,src/cli.ts --seed 42`.

<!-- END @tanstack/oracles -->
