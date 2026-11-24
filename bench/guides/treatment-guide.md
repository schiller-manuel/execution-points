# Testing Guide: Deterministic Async Testing in Vitest

This workspace uses **Vitest**, **TypeScript**, and has **`execution-points-prototype`** installed and configured (`vitest.config.mjs`, `tsconfig.json`, `points.ep`). You may use standard Vitest (`vi.mock`, `vi.useFakeTimers`) or `execution-points-prototype`.

## Core Pattern: Deadlock-Free Deferred Barriers
Never use `setTimeout` sleeps or probabilistic retry loops. Use a deferred barrier to pause an in-flight async operation, **start the overlapping operation without awaiting it**, settle event-loop turns with a small `settle()` helper, then release the barrier and await both operations. (Do **not** `await` an overlapping same-key operation while holding a barrier: a valid fix that serializes same-key operations will deadlock!)

```ts
function createBarrier() {
  let entered!: () => void
  const hit = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { entered, hit, release, gate }
}

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}
```

## Controlling Interleavings with `execution-points-prototype`
`select(file, visitor)` targets any selectable expression in a configured target file (`inFunction`, `kind`, `callee` / `operator`, `nth`) without editing production code. `point.withReplacement(handler, action)` scopes interception to `action` and its `AsyncLocalStorage` descendants:

```ts
import { select } from 'execution-points-prototype'

const point = select('src/example.ts', (node) => {
  // Prefer minimal selectors: add `inFunction` or `nth` only if `callee` appears more than once
  if (node.kind === 'CallExpression' && node.callee === 'helper') {
    return node.capture('id') // optional readonly local captures
  }
})

const b = createBarrier()
const opA = point.withReplacement(async ({ original }) => {
  b.entered(); await b.gate; return original()
}, () => myFn('u1'))
await b.hit
const opB = updateFn('u1', 'next') // start WITHOUT awaiting while barrier is held
await settle()
b.release()
await Promise.all([opA, opB])
```

## Rules & Limits
- **Do not monkey-patch JavaScript or Node.js globals** (`Promise`, `MessageChannel`, `MessagePort`, `Map`, `EventTarget`, `globalThis`, `Object.defineProperty`, `Reflect.defineProperty`, `vi.stubGlobal`). Runtime guards and AST audits fail the run on any global patch.
- **Do not add test-only hooks or extra exports** to production source files.
- **Note on `select()`:** Selectors match exactly 1 expression; keep them minimal (omit `inFunction` when `callee` is already unique in the file, and never bind `inFunction` to a helper you newly introduced). Renaming a callee or adding a second call site causes a loud selection/compile error (`matched 0` / `matched 2`) rather than a silent pass.
- **Timeouts:** Automated grading runs regression tests with a 1,500 ms timeout on mutants/refactors and 5,000 ms on your own fix; avoid waiting on barriers that never fire.

## Validation Commands
- `npm test` — runs Vitest (with in-memory instrumentation)
- `npm run check` — runs TypeScript type checking (`tsc --noEmit --runExternalCode`, checking both TypeScript types and `select()` virtual contracts)
