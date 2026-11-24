# Bug Report: Logged-out sessions resurrect under concurrent token fetch and logout

## Symptom
In production, users who log out while a token fetch is in flight sometimes remain authenticated:
1. If `getActiveToken(userId)` is mid-flight when `logout(userId)` completes, `getActiveToken` can finish afterward and write the token back into `sessions`, causing future `getActiveToken(userId)` calls to return a live token instead of `null`. (Whether `logout` invalidates the session at start or upon completion is implementation-defined, provided no stale token survives after `logout` completes.)
2. If the user logs out and immediately calls `login(userId)` again while an old session's `getActiveToken(userId)` is still in flight, the old session's token can overwrite the new session's token.
3. Concurrent `getActiveToken(userId)` calls within the same active session must converge on a single token for that session.

## Your Task
1. Write a **deterministic regression test** in `src/session-manager.test.ts` that reproduces the bug reliably (must fail 100% of the time on the unpatched code, with **no `setTimeout` sleeps or probabilistic timing loops**).
2. Fix the concurrency bugs in `src/session-manager.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/session-manager.ts`.
- **Do not** export private helpers or add test-only hooks/parameters/callbacks to `src/session-manager.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** the existing simulated async I/O helpers (`requestNewToken`, `verifyTokenPolicy`, `prepareRevocation`, `notifyAuthServer`, `flushAuditLog`) asynchronous.
- **Keep** session state isolated per user (actions on one user must never disrupt another logged-in user).
