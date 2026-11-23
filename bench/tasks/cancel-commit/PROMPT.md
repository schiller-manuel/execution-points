# Bug Report: Cancelled or superseded jobs overwrite disk state on late commit

## Symptom
`src/job-runner.ts` persists job state via `node:fs/promises` and has two concurrency races:
1. **Cancel-vs-commit race:** If `cancelJob(jobId)` runs while `startJob(jobId, payload)` is mid-flight (staging or committing files), the late `startJob` still writes `status: 'completed'` to `${jobId}.json`, overwriting `'cancelled'`.
2. **Superseded-run overwrite:** If `startJob(jobId, 'second')` runs after `cancelJob(jobId)` (or concurrently with an earlier `startJob(jobId, 'first')`), the earlier run can corrupt the shared staging file or overwrite the newer run's committed state on disk.
3. Distinct `jobId`s must remain isolated.

## Your Task
1. Write **deterministic regression tests** in `src/job-runner.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
2. Fix the concurrency bugs in `src/job-runner.ts`.
3. Verify all tests and type checks pass.

## Constraints
- **Do not** change the exported `createJobRunner(dataDir)` signature or the `JobRunner` / `JobRecord` interfaces in `src/job-runner.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/job-runner.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `globalThis`, etc.) in tests.
- **Keep** persisting job state files (`${jobId}.json`) to `dataDir` via `node:fs/promises`.
