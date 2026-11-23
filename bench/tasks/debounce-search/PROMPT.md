# Bug Report: Out-of-order search responses and post-dispose state updates

## Symptom
`src/search-controller.ts` has two async/timer bugs:
1. **Stale response overwrite:** If search request 1 (`'alpha'`) is still in flight when a newer debounced search request 2 (`'alpha-beta'`) runs and completes first, request 1 resolving afterward overwrites `latestQuery` and `latestResults` with stale `'alpha'` data.
2. **Post-dispose leak:** `dispose()` sets `disposed = true` without cancelling the pending debounce `timer` or preventing in-flight `fetchSearchResults` completions from mutating `latestQuery`/`latestResults`.

## Your Task
1. Write **deterministic regression tests** in `src/search-controller.test.ts` that fail reliably on the unpatched code (fake timers via `vi.useFakeTimers()` are allowed; real wall-clock sleeps are not).
2. Fix the bugs in `src/search-controller.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported `createSearchController(debounceMs)` signature or `SearchController` / `SearchSnapshot` interfaces.
- **Do not** add test-only hooks/parameters/callbacks to `src/search-controller.ts` or `src/search-api.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `fetchSearchResults` in `src/search-api.ts` asynchronous.
