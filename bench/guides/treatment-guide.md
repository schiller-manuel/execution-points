# Testing Guide: Deterministic Async Testing in Vitest

This workspace uses **Vitest**, **TypeScript**, and has **`execution-points-prototype`** installed and configured (`vitest.config.mjs`, `tsconfig.json`, `points.ep`). You may use standard Vitest (`vi.mock`, `vi.useFakeTimers`) or `execution-points-prototype`.

## Core Pattern: Deferred-Promise Barriers
Never use `setTimeout` sleeps or probabilistic retry loops. Use a deferred barrier to pause an in-flight async operation, run an overlapping operation to completion, and then release the barrier:

```ts
function createBarrier() {
  let entered!: () => void
  const hit = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { entered, hit, release, gate }
}
```

## Controlling Interleavings with `execution-points-prototype`
`select(file, visitor)` targets any selectable expression in a configured target file (`inFunction`, `kind`, `callee` / `operator`, `nth`) without editing production code. `point.withReplacement(handler, action)` scopes interception to `action` and its `AsyncLocalStorage` descendants:

```ts
import { select } from 'execution-points-prototype'

const point = select('src/example.ts', (node) => {
  if (node.inFunction === 'myFn' && node.kind === 'CallExpression' && node.callee === 'helper') {
    return node.capture('id') // optional readonly local captures
  }
})

const opA = point.withReplacement(async ({ original }) => {
  b.entered()
  await b.gate
  return original()
}, () => myFn('u1'))
```

## Rules & Limits
- **Do not monkey-patch JavaScript or Node.js globals** (`Promise.resolve`, `Promise.prototype`, `Map.prototype`, `globalThis`, `Object.defineProperty` on built-ins, `vi.stubGlobal`, `Reflect.set`).
- **Do not add test-only hooks or extra exports** to production source files.
- **Note on `select()`:** Selectors match exactly 1 expression; renaming a callee or adding a second call site causes a loud selection/compile error (`matched 0` / `matched 2`) rather than a silent pass.

## Validation Commands
- `npm test` — runs Vitest (with in-memory instrumentation)
- `npm run check` — runs TypeScript type checking (`tsc --noEmit --runExternalCode`, checking both TypeScript types and `select()` virtual contracts)
