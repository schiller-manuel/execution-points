# Bug Report: Token refresh stampedes and stale tokens after invalidation

## User-Visible Symptom
Under concurrent requests in production, our auth service is experiencing two issues in `src/token-cache.ts`:
1. When multiple concurrent `getToken(tenantId)` requests arrive for the same tenant whose token is missing or invalidated, the upstream `fetchRefreshToken(tenantId)` endpoint gets hit multiple times instead of sharing a single in-flight refresh.
2. When `invalidateToken(tenantId)` is called while a refresh is already in flight, subsequent `getToken(tenantId)` calls sometimes return the stale pre-invalidation token instead of triggering a fresh refresh.
3. Additionally, if an in-flight refresh rejects, subsequent `getToken(tenantId)` calls must retry cleanly rather than remaining stuck on a failed refresh, and tenants must remain independent.

## Your Task
1. Investigate `src/token-cache.ts` and `src/auth-client.ts` to identify all concurrency bugs causing these symptoms.
2. Add **deterministic regression tests** to `src/token-cache.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/token-cache.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/token-cache.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/token-cache.ts` or `src/auth-client.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `fetchRefreshToken` in `src/auth-client.ts` asynchronous and keep warm-cache hits cached (`getRefreshCallCount` must not grow on cache hits).
