# Bug Report: Circuit breaker permits half-open probe storms and re-trips on stale failures

## User-Visible Symptom
Under concurrent load, our circuit breaker in `src/resilient-client.ts` exhibits two production failures:
1. When the circuit transitions from `OPEN` to `HALF_OPEN` (via `forceHalfOpen()`), multiple concurrent `request()` calls ALL enter `callUpstream()` simultaneously—causing a retry storm against a recovering upstream—instead of allowing **only one** in-flight probe (extra concurrent calls while the probe is in flight must be rejected with an error containing `'OPEN'` or `'probe'` without calling `callUpstream`).
2. When a request started *before* the circuit tripped and recovered fails late (after the breaker has already recovered back to `CLOSED` via a successful probe), that stale failure corrupts `consecutiveFailures` or falsely re-trips the healthy `CLOSED` breaker back to `OPEN`!

Expected behavior:
- In `HALF_OPEN`, at most **1** probe call to `callUpstream` may be in flight at a time; concurrent callers arriving while a probe is in flight must reject immediately without calling `callUpstream`.
- If the single probe succeeds, the breaker transitions to `CLOSED` and clears the probe lock; if it fails, the breaker transitions back to `OPEN` and clears the probe lock.
- A stale failure from an earlier breaker epoch (started before a trip/recovery cycle) must never re-open a newly recovered `CLOSED` breaker.

## Your Task
1. Investigate `src/resilient-client.ts` and `src/upstream.ts` to identify all concurrency bugs.
2. Add **deterministic regression tests** to `src/resilient-client.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/resilient-client.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported `createResilientClient(failureThreshold)` signature or `ResilientClient` / `BreakerState` types.
- **Do not** add test-only hooks/parameters/callbacks to `src/resilient-client.ts` or `src/upstream.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `callUpstream` in `src/upstream.ts` asynchronous.
