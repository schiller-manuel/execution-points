# Bug Report: Concurrent submitPayment calls double-charge the payment gateway

## Symptom
`src/payment-processor.ts` has a check-then-act idempotency race:
1. When two or more concurrent `submitPayment(idempotencyKey, amountCents)` calls arrive for the same key before the first charge finishes, all of them miss `receipts.get(idempotencyKey)` and invoke `chargeGateway(...)` independently, resulting in duplicate charges.
2. If an in-flight payment fails (gateway error or invalid amount), subsequent calls for that `idempotencyKey` must be able to retry cleanly without remaining stuck on a failed promise.
3. Distinct `idempotencyKey`s must remain independent, and completed keys must serve cached receipts.

## Your Task
1. Write **deterministic regression tests** in `src/payment-processor.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/payment-processor.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/payment-processor.ts`.
- **Do not** export private helpers or add test-only hooks/parameters/callbacks to `src/payment-processor.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `validatePayment`, `reserveFunds`, and `chargeGateway` asynchronous.
