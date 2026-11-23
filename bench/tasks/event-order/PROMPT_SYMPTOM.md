# Bug Report: Order status occasionally regresses when webhooks arrive concurrently

## User-Visible Symptom
When webhook events for the same `orderId` arrive concurrently or out of order (for example, `seq: 1` `'created'` and `seq: 2` `'shipped'`), the stored order in `src/order-projector.ts` occasionally regresses to the older sequence number (`seq: 1`, `'created'`) instead of staying at the highest sequence number (`seq: 2`, `'shipped'`).

Expected behavior:
- Monotonic sequence invariant: for any set of concurrent or out-of-order `applyOrderEvent` calls on the same `orderId`, the persisted order (`getOrder(orderId)`) must always end at the event with the **highest `seq`**.
- Duplicate or lower-`seq` events arriving while a higher-`seq` event is in flight must never overwrite the higher-`seq` state.
- Distinct `orderId`s must remain independent.

## Your Task
1. Investigate `src/order-projector.ts` and `src/order-repo.ts` to identify all concurrency bugs.
2. Add **deterministic regression tests** to `src/order-projector.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/order-projector.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/order-projector.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/order-projector.ts` or `src/order-repo.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `readOrder`, `enrichOrderStatus`, and `saveOrder` in `src/order-repo.ts` asynchronous.
