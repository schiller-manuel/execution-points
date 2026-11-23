# Bug Report: Unsynchronized cross-module transfers lose updates and allow overdrafts

## Symptom
`src/ledger.ts` reads and writes balances across `src/account-store.ts` and `src/audit-log.ts` without per-account synchronization:
1. **Overdraft & lost update:** Two concurrent `transfer('a', 'b', 80)` and `transfer('a', 'c', 80)` calls when `'a'` starts with `100` both read `100`, both pass `fromBal < amount`, and both write `20` (losing one debit and creating money out of thin air).
2. **Opposite-direction deadlock / lost update:** Concurrent `transfer('a', 'b', 30)` and `transfer('b', 'a', 20)` must serialize safely in canonical account-ID order so they neither lose updates nor deadlock, conserving total balances and recording only successful transfers in `audit-log.ts`.

## Your Task
1. Write **deterministic regression tests** in `src/ledger.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/ledger.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/ledger.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/ledger.ts`, `src/account-store.ts`, or `src/audit-log.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `readBalance`, `writeBalance`, and `recordTransfer` asynchronous.
