# Working on execution-points

This is an early prototype of a generic testing tool. Keep experiments small
and runnable, and continue discussing unresolved API choices with the user.

## Agreed direction

- Select an expression externally using an existing AST query language.
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

Repeated `original()` behavior remains provisional. The current implementation
evaluates the expression on every call; whether to limit it is undecided.

## Validation

Run from the repository root:

```sh
pnpm check
pnpm test
pnpm verify
```

The virtual compiler check is separate from Vitest. Passing runtime tests alone
does not establish that replacement callbacks are type-correct. Do not claim
editor integration exists until an editor adapter is implemented and verified.

## Git workflow

The user requested frequent commits and pushes to
`schiller-manuel/execution-points`. Commit coherent milestones and push them to
`origin` when access is available. Report authentication or permission failures
accurately; a local commit is not a successful push. Preserve the repository's
private visibility.
