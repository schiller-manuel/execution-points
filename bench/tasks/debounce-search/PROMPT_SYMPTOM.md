# Bug Report: Search box displays stale results or updates after unmount

## User-Visible Symptom
Users typing into the search box report two glitches from `src/search-controller.ts`:
1. After typing one query, waiting past the debounce delay, and typing a newer query while the first search request is still in flight, the older query's results sometimes overwrite the newer query's results in `getSnapshot()`.
2. After `dispose()` is called while a debounce timer or in-flight search request is still pending, the controller still updates `getSnapshot()` with results after disposal.

Expected behavior:
- Only the most recently initiated search query may update `getSnapshot()` (an older in-flight search resolving late must never overwrite a newer query's results).
- Once `dispose()` is called, any pending debounce timer must be cancelled and no subsequent in-flight search completion may mutate `getSnapshot()`.

## Your Task
1. Investigate `src/search-controller.ts` and `src/search-api.ts` to identify all concurrency/timer bugs.
2. Add **deterministic regression tests** to `src/search-controller.test.ts` that fail reliably on the unpatched code (fake timers via `vi.useFakeTimers()` are allowed; real wall-clock `setTimeout` sleeps are not).
3. Fix the bugs in `src/search-controller.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported `createSearchController(debounceMs)` signature or `SearchController` / `SearchSnapshot` interfaces.
- **Do not** add test-only hooks/parameters/callbacks to `src/search-controller.ts` or `src/search-api.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `MessageChannel`, `globalThis`, etc.) in tests.
- **Keep** `fetchSearchResults` in `src/search-api.ts` asynchronous.
