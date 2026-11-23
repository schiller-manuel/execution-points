# Bug Report: Logged-out users occasionally remain authenticated or receive revoked tokens

## User-Visible Symptom
Under concurrent authentication traffic, users who log out sometimes remain authenticated on subsequent `getActiveToken(userId)` calls—or, after logging out and logging back in, end up with a revoked token from their previous session instead of their new session's token.

Expected behavior:
- After `logout(userId)` completes (with no subsequent `login(userId)`), `getActiveToken(userId)` must return `null`.
- After `logout(userId)` followed by `login(userId)`, an earlier session's in-flight `getActiveToken(userId)` must never overwrite the new session's token.
- Concurrent `login` / `logout` calls for one user (`'bob'`) must never invalidate or deny tokens to another logged-in user (`'alice'`).

## Your Task
1. Investigate `src/session-manager.ts` to identify all concurrency bugs causing this symptom.
2. Add **deterministic regression tests** to `src/session-manager.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/session-manager.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/session-manager.ts`.
- **Do not** export private helpers or add test-only hooks/parameters/callbacks to production code.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** the existing simulated async I/O helpers (`requestNewToken`, `verifyTokenPolicy`, `prepareRevocation`, `notifyAuthServer`, `flushAuditLog`) asynchronous.
