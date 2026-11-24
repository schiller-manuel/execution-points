# Testing Guide: Deterministic Async Testing in Vitest

This workspace uses **Vitest** and **TypeScript**, and has **`execution-points-prototype`** installed and configured (`vitest.config.mjs`, `tsconfig.json`, `points.ep`). You may use standard Vitest (`vi.mock`, `vi.useFakeTimers`), `execution-points-prototype`, or both. Follow these patterns when writing deterministic regression tests for async concurrency bugs.

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

`settle()` only waits for work that finishes within event-loop turns (promise chains, `MessageChannel`, `setImmediate`). It does **not** wait for real I/O such as disk access. To order real I/O, hold the second operation at a barrier of its own, or await an operation that must finish.

## Controlling Interleavings with `vi.mock`
When async I/O lives in an imported module, wrap the real module with `vi.mock(..., async (importOriginal) => ...)`. The names below (`./inventory-api`, `loadItem`, `reserveItem`, `restockItem`) are placeholders; use the modules and functions of the code you are testing.

```ts
import { vi } from 'vitest'
let hook: (() => Promise<void>) | null = null
vi.mock('./inventory-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inventory-api')>()
  return { ...actual, loadItem: async (sku: string) => { await hook?.(); return actual.loadItem(sku) } }
})

const b = createBarrier()
hook = async () => { hook = null; b.entered(); await b.gate }
const opA = reserveItem('sku-1')
await b.hit
const opB = restockItem('sku-1', 5) // start WITHOUT awaiting while barrier is held
await settle()
b.release()
await Promise.all([opA, opB])
```

- **Fake timers (`vi.useFakeTimers`):** When timing depends on timers, advance virtual time explicitly with `vi.advanceTimersByTimeAsync(...)`.

## Controlling Interleavings with `execution-points-prototype`
`select(file, visitor)` picks one expression in a configured target file without editing production code. `npx execution-points list <file>` prints every expression you can select, with the fields to select it by and what it stands inside. `point.pause()` holds an operation at that expression until you release it. `point.withReplacement(handler, action)` runs `handler` in place of the expression while `action` and the async work it starts are running; `original()` evaluates the real expression. The same placeholder names as above:

```ts
import { select } from 'execution-points-prototype'

// Select by what the expression is: here, the one call to `loadItem` in the file.
const point = select('src/inventory.ts', (node) => node.callee === 'loadItem' && node)
// Optional: `.capture('sku')` exposes the listed in-scope locals to a handler as readonly `locals`.

const pause = point.pause()
const opA = pause.run(() => reserveItem('sku-1')) // starts, and waits at loadItem(...)
await pause.reached // rejects at once if opA finishes without getting there
const opB = restockItem('sku-1', 5) // start WITHOUT awaiting while opA is held
await settle()
pause.release() // opA continues with the real loadItem(...)
await Promise.all([opA, opB])
```

- `pause()` needs an expression whose value is a promise: the call the code awaits. For any other expression, use `withReplacement` with a handler.
- A selector must match exactly 1 expression. Matching 0 or 2 or more is a loud error (`matched 0` / `matched 2`), at type-check time and at run time, never a silent pass.
- A replacement or a pause that never runs fails the test (`ran 0 times`). If a test installs one that is not meant to run on every path, say so: `withReplacement(handler, action, { times: 'any' })`.
- Select an expression of the code **as it was given to you**, and describe it by the expression itself (`callee`, `operator`). The test also has to run against the unfixed code and against other correct fixes, so a selector that depends on a function you add or rename while fixing matches nothing there.
- When the same call is written in several functions, say which one by where it stands, with a visitor object: `select('src/inventory.ts', { Function: (fn) => fn.name === 'reserveItem' && fn.traverse({ CallExpression: (call) => call.callee === 'loadItem' && call }) })`. `call.object` is what a call is made on (`cache` in `cache.get(key)`).
- To run two operations in every order instead of one: `for (const order of interleavings([pointA, pointB])) { /* reset state */ await order.run(() => Promise.all([opA(), opB()])); /* expect(...) */ }`, with `interleavings` imported from the same package. Each selected expression must evaluate to a promise.

## Rules & Limits
- **Do not monkey-patch JavaScript or Node.js globals** (`Promise`, `MessageChannel`, `MessagePort`, `Map`, `EventTarget`, `globalThis`, `Object.defineProperty`, `Reflect.defineProperty`, `vi.stubGlobal`). Runtime guards and AST audits fail the run on any global patch.
- **Do not add test-only hooks or extra exports** to production source files.
- **A reproduction is a failed assertion.** Automated grading counts a test as reproducing the bug only when it fails on an `expect(...)` assertion. A thrown error, a rejection that escapes the test, or a timeout does not count. Assert on the outcome (for example with `Promise.allSettled`) instead of letting an operation's rejection fail the test.
- **Results must repeat.** Automated grading runs every check several times and requires the same result each time.
- **Timeouts:** Automated grading runs regression tests with a 1,500 ms timeout on mutants/refactors and 5,000 ms on your own fix; avoid waiting on barriers that never fire.

## Validation Commands
- `npm test` — runs Vitest (with in-memory instrumentation of the configured target files)
- `npm run check` — runs TypeScript type checking (`tsc --noEmit --runExternalCode`, checking both TypeScript types and `select()` virtual contracts)
