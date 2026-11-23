# Bug Report: Stale profile names persist after updates under concurrent traffic

## User-Visible Symptom
Under concurrent traffic on a user's profile, users sometimes continue seeing an **old** profile name on subsequent `getProfile(id)` calls—both from the in-memory cache and after `clearCache()`—even though `updateProfile(id, newName)` resolved successfully.

In particular:
- After `updateProfile(id, newName)` completes, every subsequent `getProfile(id)` must return `newName` (both warm cache and after `clearCache()`).
- If two `updateProfile(id, ...)` calls are initiated in order for the same `id` (e.g., `'Bob'` followed by `'Carol'`), the later-initiated update (`'Carol'`) must win in both cache and backing storage.
- Warm-cache reads must still use the cache (do not remove caching).
- Operations on unrelated user IDs must not interfere with each other.

## Your Task
1. Investigate `src/profile-store.ts` and `src/storage.ts` to identify all concurrency bugs causing this symptom.
2. Add **deterministic regression tests** to `src/profile-store.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/profile-store.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/profile-store.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/profile-store.ts` or `src/storage.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** the async I/O functions in `src/storage.ts` asynchronous.
