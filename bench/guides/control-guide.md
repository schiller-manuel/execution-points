# Testing Guide: Deterministic Async Testing in Vitest

This workspace uses **Vitest** and **TypeScript**. Follow these patterns when writing deterministic regression tests for async concurrency bugs.

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

## Rules & Limits
- **Do not monkey-patch JavaScript or Node.js globals** (`Promise`, `MessageChannel`, `MessagePort`, `Map`, `EventTarget`, `globalThis`, `Object.defineProperty`, `Reflect.defineProperty`, `vi.stubGlobal`). Runtime guards and AST audits fail the run on any global patch.
- **Do not add test-only hooks or extra exports** to production source files.
- **A reproduction is a failed assertion.** Automated grading counts a test as reproducing the bug only when it fails on an `expect(...)` assertion. A thrown error, a rejection that escapes the test, or a timeout does not count. Assert on the outcome (for example with `Promise.allSettled`) instead of letting an operation's rejection fail the test.
- **Results must repeat.** Automated grading runs every check several times and requires the same result each time.
- **Timeouts:** Automated grading runs regression tests with a 1,500 ms timeout on mutants/refactors and 5,000 ms on your own fix; avoid waiting on barriers that never fire.

## Validation Commands
- `npm test` — runs Vitest
- `npm run check` — runs TypeScript type checking (`tsc --noEmit`)
