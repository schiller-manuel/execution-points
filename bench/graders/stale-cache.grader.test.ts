import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { countYields, createYieldScheduler } from './yield-engine.mjs'
import {
  clearCache,
  getProfile,
  resetStore,
  seedProfile,
  updateProfile,
} from './src/profile-store'

async function assertConsistentProfile(id: string, expectedName: string) {
  const expected = {
    id,
    name: expectedName,
    displayName: expectedName.toUpperCase(),
  }
  const warm = await getProfile(id)
  expect(warm).toEqual(expected)
  clearCache()
  const fromDb = await getProfile(id)
  expect(fromDb).toEqual(expected)
}

describe('hidden oracle grader: stale-cache (yield-engine)', () => {
  test('preserves baseline behavior, validation, and warm-cache hits', async () => {
    resetStore()
    expect(await getProfile('missing')).toBeNull()

    seedProfile('u1', 'Alice')
    const first = await getProfile('u1')
    expect(first).toEqual({ id: 'u1', name: 'Alice', displayName: 'ALICE' })

    // Warm-cache read must NOT bypass the cache (0 async yields)
    const { result: warm, yields } = await countYields(() => getProfile('u1'))
    expect(warm).toEqual({ id: 'u1', name: 'Alice', displayName: 'ALICE' })
    expect(yields).toBe(0)

    // Empty/whitespace names must reject without corrupting cache or DB
    await expect(updateProfile('u1', '   ')).rejects.toThrow()
    await assertConsistentProfile('u1', 'Alice')
  })

  test('exhaustive staggered cold-read vs update interleavings (catches V0 and V1 residual race)', async () => {
    const priorities: Array<'first' | 'last' | 'alt'> = ['first', 'last', 'alt']

    // Pattern A: getProfile starts first, updateProfile starts at staggered step
    for (const atStep of [0, 1, 2]) {
      for (const mode of priorities) {
        resetStore()
        seedProfile('u1', 'Alice')
        const sched = createYieldScheduler()
        sched.spawn(0, () => getProfile('u1'), { atStep: 0 })
        sched.spawn(1, () => updateProfile('u1', 'Bob'), { atStep })
        let toggle = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[toggle++ % ready.length]
        })
        await assertConsistentProfile('u1', 'Bob')
      }
    }

    // Pattern B: updateProfile starts first, cold getProfile starts mid-update and parks
    // while updateProfile finishes (exposes V1's residual single-bump stale-cache race!)
    for (const startReadAt of [1, 2, 3, 4, 5, 6]) {
      for (const readSteps of [1, 2, 3, 4, 5]) {
        resetStore()
        seedProfile('u1', 'Alice')
        const sched = createYieldScheduler()
        sched.spawn(0, () => updateProfile('u1', 'Bob'), { atStep: 0 })
        sched.spawn(1, () => getProfile('u1'), { atStep: startReadAt })
        let readTaken = 0
        await sched.run((ready) => {
          // Once getProfile has spawned, give it `readSteps` steps so it reads old DB
          // and parks before cache.set; then let updateProfile finish completely before
          // releasing getProfile's final cache.set!
          if (ready.includes(1) && readTaken < readSteps) {
            readTaken++
            return 1
          }
          if (ready.includes(0)) return 0
          return ready[0]
        })
        await assertConsistentProfile('u1', 'Bob')
      }
    }
  })

  test('exhaustive concurrent updates ordering (last-initiated wins in BOTH cache and DB)', async () => {
    const strategies: Array<(ready: number[], step: number) => number> = [
      (r) => r[0],
      (r) => r[r.length - 1],
      (r, s) => r[s % r.length],
      // Advance op1 partway, let op2 finish completely, then resume op1
      (r, s) => (s < 2 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 3 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 4 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 5 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
    ]

    for (const pick of strategies) {
      resetStore()
      seedProfile('u1', 'Alice')
      const sched = createYieldScheduler()
      sched.spawn(0, () => updateProfile('u1', 'Bob'), { atStep: 0 })
      sched.spawn(1, () => updateProfile('u1', 'Carol'), { atStep: 0 })
      let step = 0
      await sched.run((ready) => pick(ready, step++))
      await assertConsistentProfile('u1', 'Carol')
    }

    // 3 concurrent updates + overlapping cold read
    resetStore()
    seedProfile('u1', 'Alice')
    const sched = createYieldScheduler()
    sched.spawn(0, () => updateProfile('u1', 'Bob'), { atStep: 0 })
    sched.spawn(1, () => updateProfile('u1', 'Carol'), { atStep: 0 })
    sched.spawn(2, () => updateProfile('u1', 'Dave'), { atStep: 0 })
    sched.spawn(3, () => getProfile('u1'), { atStep: 1 })
    await sched.run((ready) => ready[ready.length - 1])
    await assertConsistentProfile('u1', 'Dave')
  })

  test('randomized schedules across multi-key mixed reads and updates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        async (picks, readDelay, u2Delay) => {
          resetStore()
          seedProfile('u1', 'Alice')
          seedProfile('u2', 'Zoe')

          const sched = createYieldScheduler()
          sched.spawn(0, () => updateProfile('u1', 'Bob'), { atStep: 0 })
          sched.spawn(1, () => updateProfile('u1', 'Carol'), { atStep: 0 })
          sched.spawn(2, () => getProfile('u1'), { atStep: readDelay })
          sched.spawn(3, () => updateProfile('u2', 'Yara'), { atStep: u2Delay })
          sched.spawn(4, () => getProfile('u2'), { atStep: 0 })

          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          await assertConsistentProfile('u1', 'Carol')
          await assertConsistentProfile('u2', 'Yara')
        },
      ),
      { numRuns: 30, seed: 4242 },
    )
  })
})
