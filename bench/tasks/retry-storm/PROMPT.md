# Bug Report: Half-open probe storm and stale-failure breaker re-trip

## Symptom
`src/resilient-client.ts` has two concurrency bugs:
1. **Half-open probe storm:** When `state === 'HALF_OPEN'`, multiple concurrent `request()` calls all pass the `state === 'OPEN'` guard and invoke `callUpstream()` concurrently instead of allowing only a single in-flight probe and immediately rejecting extra callers without calling `callUpstream()`.
2. **Stale failure re-trip:** If an older request from before the breaker tripped and recovered via `forceHalfOpen()` fails late (after the breaker has already returned to `CLOSED`), its `catch` block increments `consecutiveFailures` or trips the healthy breaker back to `OPEN`.

## Your Task
1. Write **deterministic regression tests** in `src/resilient-client.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/resilient-client.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported `createResilientClient(failureThreshold)` signature or `ResilientClient` / `BreakerState` types.
- **Do not** add test-only hooks/parameters/callbacks to `src/resilient-client.ts` or `src/upstream.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `callUpstream` in `src/upstream.ts` asynchronous.
