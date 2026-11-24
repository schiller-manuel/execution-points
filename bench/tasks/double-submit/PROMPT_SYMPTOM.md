# Bug Report: Duplicate charges occur when users double-click checkout

## User-Visible Symptom
When a customer submits the same payment twice concurrently with the same `idempotencyKey`, the payment gateway is occasionally charged **twice** and callers receive different `chargeId`s instead of sharing a single charge.

Expected behavior:
- Concurrent `submitPayment(idempotencyKey, amountCents)` calls for the same `idempotencyKey` must charge the gateway **at most once** (`getGatewayChargeCount(key) === 1`) and return the same receipt.
- If a payment fails (gateway error or validation error), the key must NOT remain permanently stuck/poisoned: a subsequent retry with the same `idempotencyKey` must execute cleanly and succeed. Either sharing the failure across concurrent joiners (0 charges until a subsequent retry) or serializing queued callers so a subsequent waiter retries and charges at most once is acceptable.
- Payments for different `idempotencyKey`s must remain independent.
- Sequential repeated calls for an already-completed key must return the cached receipt without calling the gateway again.

## Your Task
1. Investigate `src/payment-processor.ts` to identify all concurrency bugs causing this symptom.
2. Add **deterministic regression tests** to `src/payment-processor.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/payment-processor.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported function names, parameter counts, or return types in `src/payment-processor.ts`.
- **Do not** export private helpers or add test-only hooks/parameters/callbacks to `src/payment-processor.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** the existing simulated async I/O helpers (`validatePayment`, `reserveFunds`, `chargeGateway`) asynchronous.
