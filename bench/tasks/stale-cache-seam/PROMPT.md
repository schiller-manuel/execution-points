# Bug Report: Stale profile names persist after updates under concurrent load

## Symptom
In production, users occasionally continue seeing their **old** profile name on subsequent `getProfile(id)` calls even after `updateProfile(id, newName)` has succeeded:
1. When a cold-cache `getProfile(id)` overlaps with `updateProfile(id, newName)`, `getProfile(id)` can finish its async steps after `updateProfile` and poison the cache with the stale profile.
2. When two `updateProfile(id, ...)` calls are initiated in order (e.g., `'Bob'` followed by `'Carol'`) and their async steps complete out of order, the earlier-initiated update can overwrite the cache or backing store with stale data instead of the later-initiated update (`'Carol'`) winning.

## Your Task
1. Write **deterministic regression tests** in `src/profile-store.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/profile-store.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/profile-store.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/profile-store.ts` or `src/storage.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** the async I/O functions in `src/storage.ts` asynchronous, and keep warm-cache reads using the cache.
