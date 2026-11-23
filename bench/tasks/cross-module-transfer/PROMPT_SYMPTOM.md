# Bug Report: Concurrent transfers overdraft accounts, lose updates, or deadlock

## User-Visible Symptom
Under concurrent transfers across `src/ledger.ts`, `src/account-store.ts`, and `src/audit-log.ts`:
1. Two concurrent transfers out of the same account (e.g., `transfer('a', 'b', 80)` and `transfer('a', 'c', 80)` when `'a'` holds `100`) can both succeed—leaving `'a'` with an incorrect balance and violating total money conservation across accounts!
2. Concurrent transfers targeting overlapping accounts (including opposite directions `transfer('a', 'b', 30)` and `transfer('b', 'a', 20)`) can lose updates or deadlock if locked in inconsistent order.

Expected behavior:
- **No overdraft:** No account balance may ever go below `0`; if two concurrent transfers exceed the available balance, at most one succeeds and the other rejects with `'Insufficient funds'`.
- **Conservation of money:** The sum of all account balances after concurrent transfers settles must ALWAYS equal the initial sum, and `getAuditEntries()` must match only the succeeded transfers.
- **No deadlock:** Concurrent opposite-direction transfers (`a -> b` and `b -> a`) must both complete cleanly without deadlocking.

## Your Task
1. Investigate `src/ledger.ts`, `src/account-store.ts`, and `src/audit-log.ts` to identify all concurrency bugs.
2. Add **deterministic regression tests** to `src/ledger.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/ledger.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/ledger.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/ledger.ts`, `src/account-store.ts`, or `src/audit-log.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `readBalance`, `writeBalance`, and `recordTransfer` asynchronous.
