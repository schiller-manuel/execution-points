import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createYieldScheduler } from './yield-engine.mjs'
import { createJobRunner, type JobRecord } from './src/job-runner'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cancel-commit-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function readDiskState(dir: string, jobId: string): Promise<JobRecord | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${jobId}.json`), 'utf8')
    return JSON.parse(raw) as JobRecord
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

describe('hidden oracle grader: cancel-commit (yield-engine + real fs)', () => {
  test('persists job state to real disk files', async () => {
    await withTempDir(async (dir) => {
      const runner = createJobRunner(dir)
      expect(await runner.getJobState('missing')).toBeNull()

      const done = await runner.startJob('j1', 'hello')
      expect(done).toEqual({
        jobId: 'j1',
        status: 'completed',
        payload: 'hello',
        result: 'processed:HELLO',
      })
      expect(await runner.getJobState('j1')).toEqual(done)
      // Verify genuine disk persistence (catches in-memory-only cheat)
      expect(await readDiskState(dir, 'j1')).toEqual(done)
    })
  })

  test('cancelJob while startJob is mid-flight never gets overwritten by late commit', async () => {
    const priorities: Array<'first' | 'last' | 'alt'> = ['first', 'last', 'alt']
    for (const cancelStep of [1, 2, 3, 4]) {
      for (const mode of priorities) {
        await withTempDir(async (dir) => {
          const runner = createJobRunner(dir)
          const sched = createYieldScheduler()
          sched.spawn(
            0,
            async () => {
              try {
                await runner.startJob('j1', 'alpha')
              } catch {
                // Rejecting a cancelled job is allowed
              }
            },
            { atStep: 0 },
          )
          sched.spawn(
            1,
            async () => {
              await runner.cancelJob('j1')
            },
            { atStep: cancelStep },
          )
          let step = 0
          await sched.run((ready) => {
            if (mode === 'first') return ready[0]
            if (mode === 'last') return ready[ready.length - 1]
            return ready[step++ % ready.length]
          })

          const state = await runner.getJobState('j1')
          const disk = await readDiskState(dir, 'j1')
          expect(state).toEqual({ jobId: 'j1', status: 'cancelled' })
          expect(disk).toEqual({ jobId: 'j1', status: 'cancelled' })
        })
      }
    }
  })

  test('superseded or cancelled-then-restarted job never overwrites newer run on disk', async () => {
    const strategies: Array<(ready: number[], step: number) => number> = [
      (r) => r[0],
      (r) => r[r.length - 1],
      (r, s) => r[s % r.length],
      // Advance run 1 partway, let cancel+run2 finish, then resume run 1
      (r, s) => (s < 2 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 3 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
    ]

    for (const restartStep of [1, 2, 3]) {
      for (const pick of strategies) {
        await withTempDir(async (dir) => {
          const runner = createJobRunner(dir)
          const sched = createYieldScheduler()
          sched.spawn(
            0,
            async () => {
              try {
                await runner.startJob('j1', 'old-data')
              } catch {
                // Rejecting a cancelled/superseded job is allowed
              }
            },
            { atStep: 0 },
          )
          sched.spawn(
            1,
            async () => {
              await runner.cancelJob('j1')
              await runner.startJob('j1', 'new-data')
            },
            { atStep: restartStep },
          )
          let step = 0
          await sched.run((ready) => pick(ready, step++))

          const expected: JobRecord = {
            jobId: 'j1',
            status: 'completed',
            payload: 'new-data',
            result: 'processed:NEW-DATA',
          }
          expect(await runner.getJobState('j1')).toEqual(expected)
          expect(await readDiskState(dir, 'j1')).toEqual(expected)
        })
      }
    }
  })

  test('overlapping startJob calls do not corrupt shared staging files or overwrite newer run (catches CC-M1, N-18)', async () => {
    // 3-phase switch: advance run 1 to staging, start run 2 and advance run 2 to its staging write,
    // then switch back to run 1 (which deletes a shared stage.tmp in CC-M1!) before resuming run 2!
    for (const startSecondAt of [0, 1, 2, 3, 4]) {
      for (const leadSecond of [1, 2, 3, 4, 5]) {
        await withTempDir(async (dir) => {
          const runner = createJobRunner(dir)
          const sched = createYieldScheduler()
          let secondErr: unknown = null

          sched.spawn(
            0,
            async () => {
              try {
                await runner.startJob('j1', 'first-run')
              } catch {
                // superseded first run may reject
              }
            },
            { atStep: 0 },
          )
          sched.spawn(
            1,
            async () => {
              try {
                await runner.startJob('j1', 'second-run')
              } catch (err) {
                secondErr = err
              }
            },
            { atStep: startSecondAt },
          )

          let q1Steps = 0
          await sched.run((ready) => {
            // Once queue 1 has spawned, give it `leadSecond` steps so it writes the staging file,
            // then switch back to queue 0 (exposing shared-stage deletion!) before finishing queue 1!
            if (ready.includes(1) && q1Steps < leadSecond) {
              q1Steps++
              return 1
            }
            if (ready.includes(0)) return 0
            return ready[0]
          })

          expect(secondErr).toBeNull()
          const expected: JobRecord = {
            jobId: 'j1',
            status: 'completed',
            payload: 'second-run',
            result: 'processed:SECOND-RUN',
          }
          expect(await runner.getJobState('j1')).toEqual(expected)
          expect(await readDiskState(dir, 'j1')).toEqual(expected)
        })
      }
    }
  })

  test('randomized schedules with multi-job isolation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        fc.integer({ min: 1, max: 3 }),
        async (picks, cancelStep) => {
          await withTempDir(async (dir) => {
            const runner = createJobRunner(dir)
            const sched = createYieldScheduler()
            sched.spawn(0, () => runner.startJob('j1', 'one'), { atStep: 0 })
            sched.spawn(
              1,
              async () => {
                try {
                  await runner.startJob('j2', 'two')
                } catch {
                  // allowed
                }
              },
              { atStep: 0 },
            )
            sched.spawn(2, () => runner.cancelJob('j2'), { atStep: cancelStep })

            let idx = 0
            await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

            expect(await readDiskState(dir, 'j1')).toEqual({
              jobId: 'j1',
              status: 'completed',
              payload: 'one',
              result: 'processed:ONE',
            })
            expect(await readDiskState(dir, 'j2')).toEqual({
              jobId: 'j2',
              status: 'cancelled',
            })
          })
        },
      ),
      { numRuns: 15, seed: 4242 },
    )
  })
})
