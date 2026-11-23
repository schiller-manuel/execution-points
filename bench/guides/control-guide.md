# Testing Guide: Deterministic Async Testing in Vitest

This workspace uses **Vitest** and **TypeScript**. Follow these patterns when writing deterministic regression tests for async concurrency bugs.

## Core Pattern: Deferred-Promise Barriers
Never use `setTimeout` sleeps or probabilistic retry loops. Instead, use a deferred barrier to pause an in-flight async operation at a known boundary, run an overlapping operation to completion, and then release the barrier:

```ts
function createBarrier() {
  let entered!: () => void
  const hit = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { entered, hit, release, gate }
}
```

## Controlling Interleavings Cleanly
- **Module-boundary mocking (`vi.mock`):** When async I/O lives in an imported module (e.g. `./storage`, `./auth-client`, or `node:fs/promises`), mock that module with `vi.mock(..., async (importOriginal) => ...)` and wrap the target I/O call with a barrier while delegating to the real implementation.
- **Fake timers (`vi.useFakeTimers`):** When timing depends on timers, advance virtual time explicitly with `vi.advanceTimersByTimeAsync(...)`.
- **Start offsets & concurrency:** Combine `Promise.all` / sequential `await`s with controlled barriers so the test fails reliably on the buggy code and passes reliably on the fix.

## Rules & Limits
- **Do not monkey-patch JavaScript or Node.js globals** (`Promise.resolve`, `Promise.prototype`, `Map.prototype`, `globalThis`, `Object.defineProperty` on built-ins, `vi.stubGlobal`, `Reflect.set`). Global spies break silently under harmless refactors and are disallowed.
- **Do not add test-only hooks or extra exports** to production source files.
- **Keep module mocks aligned with real implementations** — if an internal refactor moves or renames an imported helper, verify your mock still intercepts the intended call.

## Validation Commands
- `npm test` — runs Vitest
- `npm run check` — runs TypeScript type checking (`tsc --noEmit`)
