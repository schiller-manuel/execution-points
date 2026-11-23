import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { countYields, createYieldScheduler } from './yield-engine.mjs'
import { failNextRefresh, getRefreshCallCount } from './src/auth-client'
import { getToken, invalidateToken, resetTokenCache } from './src/token-cache'

describe('hidden oracle grader: single-flight (yield-engine)', () => {
  test('preserves warm-cache hits and basic invalidation', async () => {
    resetTokenCache()
    const t1 = await getToken('acme')
    expect(t1).toMatch(/^tok-acme-/)
    expect(getRefreshCallCount('acme')).toBe(1)

    const { result: t2, yields } = await countYields(() => getToken('acme'))
    expect(t2).toBe(t1)
    expect(yields).toBe(0)
    expect(getRefreshCallCount('acme')).toBe(1)

    invalidateToken('acme')
    const t3 = await getToken('acme')
    expect(t3).not.toBe(t1)
    expect(getRefreshCallCount('acme')).toBe(2)
  })

  test('deduplicates concurrent refreshes for the same tenant (single-flight)', async () => {
    for (const stagger of [0, 1]) {
      for (const mode of ['first', 'last', 'alt'] as const) {
        resetTokenCache()
        const results: string[] = []
        const sched = createYieldScheduler()
        sched.spawn(
          0,
          async () => {
            results[0] = await getToken('acme')
          },
          { atStep: 0 },
        )
        sched.spawn(
          1,
          async () => {
            results[1] = await getToken('acme')
          },
          { atStep: 0 },
        )
        sched.spawn(
          2,
          async () => {
            results[2] = await getToken('acme')
          },
          { atStep: stagger },
        )
        let step = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[step++ % ready.length]
        })

        expect(results[0]).toBeTruthy()
        expect(results[1]).toBe(results[0])
        expect(results[2]).toBe(results[0])
        expect(getRefreshCallCount('acme')).toBe(1)
      }
    }
  })

  test('invalidateToken during in-flight refresh prevents stale cache population', async () => {
    for (const invStep of [1, 2]) {
      for (const mode of ['first', 'last', 'alt'] as const) {
        resetTokenCache()
        let firstTok = ''
        let secondTok = ''
        const sched = createYieldScheduler()
        sched.spawn(
          0,
          async () => {
            firstTok = await getToken('acme')
          },
          { atStep: 0 },
        )
        sched.spawn(
          1,
          async () => {
            invalidateToken('acme')
            secondTok = await getToken('acme')
          },
          { atStep: invStep },
        )
        let step = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[step++ % ready.length]
        })

        expect(firstTok).toBeTruthy()
        expect(secondTok).toBeTruthy()
        expect(secondTok).not.toBe(firstTok)
        expect(await getToken('acme')).toBe(secondTok)
        expect(getRefreshCallCount('acme')).toBe(2)
      }
    }

    // Invalidation with NO concurrent follower: subsequent call must still refetch
    resetTokenCache()
    let staleTok = ''
    const sched = createYieldScheduler()
    sched.spawn(
      0,
      async () => {
        staleTok = await getToken('acme')
      },
      { atStep: 0 },
    )
    sched.spawn(
      1,
      async () => {
        invalidateToken('acme')
      },
      { atStep: 1 },
    )
    await sched.run((ready) => ready[ready.length - 1])
    const afterTok = await getToken('acme')
    expect(afterTok).not.toBe(staleTok)
    expect(getRefreshCallCount('acme')).toBe(2)
  })

  test('rejected in-flight refresh does not poison subsequent retries', async () => {
    resetTokenCache()
    failNextRefresh('acme', 'upstream 503')

    const errors: string[] = []
    const sched = createYieldScheduler()
    sched.spawn(
      0,
      async () => {
        try {
          await getToken('acme')
        } catch (err) {
          errors.push((err as Error).message)
        }
      },
      { atStep: 0 },
    )
    sched.spawn(
      1,
      async () => {
        try {
          await getToken('acme')
        } catch (err) {
          errors.push((err as Error).message)
        }
      },
      { atStep: 0 },
    )
    await sched.run((ready) => ready[0])

    expect(errors).toEqual(['upstream 503', 'upstream 503'])
    expect(getRefreshCallCount('acme')).toBe(1)

    const recovered = await getToken('acme')
    expect(recovered).toMatch(/^tok-acme-/)
    expect(getRefreshCallCount('acme')).toBe(2)
  })

  test('randomized schedules with multi-tenant isolation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        fc.integer({ min: 1, max: 2 }),
        async (picks, invStep) => {
          resetTokenCache()
          let a1 = ''
          let a2 = ''
          let b1 = ''
          let b2 = ''
          const sched = createYieldScheduler()
          sched.spawn(0, async () => { a1 = await getToken('acme') }, { atStep: 0 })
          sched.spawn(1, async () => { a2 = await getToken('acme') }, { atStep: 0 })
          sched.spawn(2, async () => { b1 = await getToken('beta') }, { atStep: 0 })
          sched.spawn(
            3,
            async () => {
              invalidateToken('beta')
              b2 = await getToken('beta')
            },
            { atStep: invStep },
          )
          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          expect(a1).toBe(a2)
          expect(getRefreshCallCount('acme')).toBe(1)
          expect(b2).not.toBe(b1)
          expect(await getToken('beta')).toBe(b2)
          expect(await getToken('acme')).toBe(a1)
        },
      ),
      { numRuns: 25, seed: 4242 },
    )
  })
})
