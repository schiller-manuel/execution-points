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

## Controlling Interleavings with `vi.mock`
When async I/O lives in an imported module (e.g. `./storage` or `./auth-client`), wrap the real module with `vi.mock(..., async (importOriginal) => ...)`:

```ts
import { vi } from 'vitest'
let hook: (() => Promise<void>) | null = null
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, readFromDb: async (id: string) => { await hook?.(); return actual.readFromDb(id) } }
})

const b = createBarrier()
hook = async () => { hook = null; b.entered(); await b.gate }
const opA = getProfile('u1')
await b.hit
const opB = updateProfile('u1', 'Bob') // start WITHOUT awaiting while barrier is held
await settle()
b.release()
await Promise.all([opA, opB])
```

- **Fake timers (`vi.useFakeTimers`):** When timing depends on timers, advance virtual time explicitly with `vi.advanceTimersByTimeAsync(...)`.

## Rules & Limits
- **Do not monkey-patch JavaScript or Node.js globals** (`Promise`, `MessageChannel`, `MessagePort`, `Map`, `EventTarget`, `globalThis`, `Object.defineProperty`, `Reflect.defineProperty`, `vi.stubGlobal`). Runtime guards and AST audits fail the run on any global patch.
- **Do not add test-only hooks or extra exports** to production source files.
- **Timeouts:** Automated grading runs regression tests with a 1,500 ms timeout on mutants/refactors and 5,000 ms on your own fix; avoid waiting on barriers that never fire.

## Validation Commands
- `npm test` — runs Vitest
- `npm run check` — runs TypeScript type checking (`tsc --noEmit`)
