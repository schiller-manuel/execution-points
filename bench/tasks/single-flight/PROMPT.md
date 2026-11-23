# Bug Report: Token refresh stampede and stale in-flight refresh after invalidation

## Symptom
`src/token-cache.ts` has two concurrency bugs:
1. **Refresh stampede:** When two or more concurrent `getToken(tenantId)` calls run for the same tenant without a cached token, each call invokes `fetchRefreshToken(tenantId)` independently instead of deduplicating into a single in-flight request (`getRefreshCallCount(tenantId)` should be `1`, and all concurrent callers receive the same token).
2. **Stale in-flight refresh after invalidation:** If `invalidateToken(tenantId)` is called while a `fetchRefreshToken(tenantId)` call is in flight, the in-flight refresh finishes afterward and writes its stale token into `tokenCache` so later `getToken(tenantId)` calls receive the invalidated token instead of fetching a fresh one.
3. Failed in-flight refreshes must not poison the cache for subsequent `getToken(tenantId)` calls, and distinct tenants must remain isolated.

## Your Task
1. Write **deterministic regression tests** in `src/token-cache.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/token-cache.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/token-cache.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/token-cache.ts` or `src/auth-client.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `fetchRefreshToken` in `src/auth-client.ts` asynchronous and keep warm-cache hits cached.
