import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createJobRunner, type JobRunner } from './job-runner'

let dir: string
let runner: JobRunner

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-runner-test-'))
  runner = createJobRunner(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

test('runs a job to completion and persists result to disk', async () => {
  const result = await runner.startJob('j1', 'hello')
  expect(result).toEqual({
    jobId: 'j1',
    status: 'completed',
    payload: 'hello',
    result: 'processed:HELLO',
  })
  expect(await runner.getJobState('j1')).toEqual(result)
})

test('cancels a job and persists cancelled state', async () => {
  const cancelled = await runner.cancelJob('j1')
  expect(cancelled).toEqual({ jobId: 'j1', status: 'cancelled' })
  expect(await runner.getJobState('j1')).toEqual({ jobId: 'j1', status: 'cancelled' })
})

test('returns null for unknown job', async () => {
  expect(await runner.getJobState('unknown')).toBeNull()
})
