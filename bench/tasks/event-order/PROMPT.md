# Bug Report: Concurrent out-of-order webhook events regress persisted order state

## Symptom
`src/order-projector.ts` performs an unguarded async read-enrich-save cycle:
1. When two concurrent `applyOrderEvent` calls for the same `orderId` (`seq: 1` and `seq: 2`) both call `readOrder(orderId)` before either saves, both pass the `event.seq <= current.seq` check; if `seq: 1` finishes `enrichOrderStatus`/`saveOrder` after `seq: 2`, it overwrites `seq: 2` with `seq: 1`.
2. Even if `seq: 2` starts and saves while `seq: 1` is suspended mid-flight, `seq: 1` resuming afterward must NOT overwrite `seq: 2`.
3. Distinct `orderId`s must remain independent.

## Your Task
1. Write **deterministic regression tests** in `src/order-projector.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/order-projector.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/order-projector.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/order-projector.ts` or `src/order-repo.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `readOrder`, `enrichOrderStatus`, and `saveOrder` in `src/order-repo.ts` asynchronous.
