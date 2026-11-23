# Bug Report: Cancelled or superseded jobs still commit completed state to disk

## User-Visible Symptom
Under concurrent job execution in `src/job-runner.ts` (which persists job state files to disk via `node:fs/promises`):
- When `cancelJob(jobId)` is called while `startJob(jobId, payload)` is already running, the persisted state on disk (`getJobState(jobId)`) sometimes ends up as `status: 'completed'` instead of `status: 'cancelled'`.
- When a job is cancelled and restarted (or started again with a newer payload for the same `jobId`) while an earlier run is still in flight, the earlier run can overwrite the newer run's persisted state or corrupt its staging file on disk.
- Jobs with different `jobId`s must run independently without interfering with each other.

## Your Task
1. Investigate `src/job-runner.ts` to identify all concurrency bugs causing these symptoms.
2. Add **deterministic regression tests** to `src/job-runner.test.ts` that fail reliably on the unpatched code (no `setTimeout` sleeps or probabilistic retry loops).
3. Fix the bugs in `src/job-runner.ts` and verify tests and type checks pass.

## Constraints
- **Do not** change the exported `createJobRunner(dataDir)` signature or the `JobRunner` / `JobRecord` interfaces in `src/job-runner.ts`.
- **Do not** add test-only hooks/parameters/callbacks to `src/job-runner.ts`.
- **Do not** monkey-patch JS/Node globals (`Promise`, `Map`, `globalThis`, etc.) in tests.
- **Keep** persisting job state files (`${jobId}.json`) to `dataDir` via `node:fs/promises` (do not replace disk persistence with an in-memory-only map).
