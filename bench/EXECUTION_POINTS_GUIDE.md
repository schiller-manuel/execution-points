# Using `execution-points-prototype` in This Workspace

`execution-points-prototype` is already configured in `vitest.config.mjs`, `tsconfig.json`, and `points.ep`.
It lets tests intercept any internal expression (such as an awaited private helper call) inside a target file **without editing production code**.

## Selecting an internal expression
```ts
import { select } from 'execution-points-prototype'

const point = select('src/example.ts', (node) => {
  if (
    node.inFunction === 'myFn' &&
    node.kind === 'CallExpression' &&
    node.callee === 'privateAsyncHelper'
  ) {
    return node.capture('id') // optional: capture narrowed in-scope locals
  }
})
```
- `node` is a typed discriminated union of every selectable expression in the target file (`inFunction`, `kind`, `callee` / `operator`, `nth`).
- `node.capture(...)` exposes only the listed locals as a readonly `locals` object.

## Controlling async interleaving deterministically
`point.withReplacement(handler, action)` activates `handler` only inside `action` and its `AsyncLocalStorage` descendants—so concurrent calls can each have independent barriers or pass through normally:

```ts
let entered!: () => void
const hitPoint = new Promise<void>((r) => { entered = r })
let release!: () => void
const gate = new Promise<void>((r) => { release = r })

// Pause call A right before `privateAsyncHelper` runs:
const callA = point.withReplacement(
  async ({ locals, original }) => {
    entered()
    await gate
    return original()
  },
  () => myFn('u1'),
)

await hitPoint          // deterministically wait until call A reaches the point
await otherOp('u1')     // run overlapping operation to completion (unblocked!)
release()               // resume call A
await callA
```

## Validation commands
- `npm test` — runs Vitest with in-memory instrumentation
- `npm run check` — runs TypeScript 7.1 typechecking (`tsc --noEmit --runExternalCode`)
