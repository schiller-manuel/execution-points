# Bug Report: Stale profile names persist after updates under concurrent load

## Symptom
In production, users occasionally continue seeing their **old** profile name on every subsequent `getProfile(id)` call even after `updateProfile(id, newName)` has succeeded:
1. When a cold-cache `getProfile(id)` overlaps with `updateProfile(id, newName)`, `getProfile(id)` can finish its internal async steps after `updateProfile` and poison the cache with the stale profile.
2. When two `updateProfile(id, ...)` calls are initiated in order (e.g., `updateProfile(id, 'Bob')` followed by `updateProfile(id, 'Carol')`) and their internal async steps complete out of order, the earlier-initiated update can overwrite the cache (or backing store) with stale data instead of the later-initiated update (`'Carol'`) winning.

## Your Task
1. Write a **deterministic regression test** in `src/profile-store.test.ts` that reproduces the bug reliably (must fail 100% of the time on the unpatched code, with **no `setTimeout` sleeps or probabilistic timing loops**).
2. Fix the concurrency bugs in `src/profile-store.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, signatures, or return types in `src/profile-store.ts`.
- **Do not** export private helpers or add test-only hooks/parameters/callbacks to `src/profile-store.ts`.
- **Keep** the existing private simulated async I/O helper functions (`readFromDb`, `formatProfile`, `validateName`, `writeToDb`, `auditUpdate`) intact and still awaited in `getProfile` / `updateProfile` (do not delete the async steps).
