import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createYieldScheduler } from './yield-engine.mjs'
import { getAuditEntries } from './src/audit-log'
import { createAccount, getBalance, resetLedger, transfer } from './src/ledger'

describe('hidden oracle grader: cross-module-transfer (yield-engine)', () => {
  test('concurrent transfers out of the same account prevent overdrafts and conserve total funds', async () => {
    const modes: Array<'first' | 'last' | 'alt'> = ['first', 'last', 'alt']
    for (const stagger of [0, 1, 2]) {
      for (const mode of modes) {
        resetLedger()
        createAccount('a', 100)
        createAccount('b', 0)
        createAccount('c', 0)

        let succeeded = 0
        let rejected = 0
        const sched = createYieldScheduler()
        sched.spawn(
          0,
          async () => {
            try {
              await transfer('a', 'b', 80)
              succeeded++
            } catch {
              rejected++
            }
          },
          { atStep: 0 },
        )
        sched.spawn(
          1,
          async () => {
            try {
              await transfer('a', 'c', 80)
              succeeded++
            } catch {
              rejected++
            }
          },
          { atStep: stagger },
        )
        let step = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[step++ % ready.length]
        })

        const balA = await getBalance('a')
        const balB = await getBalance('b')
        const balC = await getBalance('c')
        expect(succeeded).toBe(1)
        expect(rejected).toBe(1)
        expect(balA).toBe(20)
        expect(balB + balC).toBe(80)
        expect(balA + balB + balC).toBe(100)
        expect(getAuditEntries().length).toBe(1)
      }
    }
  })

  test('opposite-direction concurrent transfers complete without deadlocking and conserve total funds', async () => {
    const strategies: Array<(ready: number[], step: number) => number> = [
      (r) => r[0],
      (r) => r[r.length - 1],
      (r, s) => r[s % r.length],
    ]
    for (const pick of strategies) {
      resetLedger()
      createAccount('a', 100)
      createAccount('b', 100)

      const sched = createYieldScheduler()
      sched.spawn(0, () => transfer('a', 'b', 30), { atStep: 0 })
      sched.spawn(1, () => transfer('b', 'a', 20), { atStep: 0 })
      let step = 0
      await sched.run((ready) => pick(ready, step++))

      expect(await getBalance('a')).toBe(90)
      expect(await getBalance('b')).toBe(110)
      expect(getAuditEntries().length).toBe(2)
    }
  })

  test('randomized schedules preserve conservation and non-negativity across 3 accounts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        async (picks) => {
          resetLedger()
          createAccount('a', 100)
          createAccount('b', 50)
          createAccount('c', 50)

          let okCount = 0
          const runTx = (from: string, to: string, amt: number) => async () => {
            try {
              await transfer(from, to, amt)
              okCount++
            } catch {
              // insufficient funds allowed
            }
          }

          const sched = createYieldScheduler()
          sched.spawn(0, runTx('a', 'b', 70), { atStep: 0 })
          sched.spawn(1, runTx('a', 'c', 60), { atStep: 0 })
          sched.spawn(2, runTx('b', 'a', 30), { atStep: 1 })
          sched.spawn(3, runTx('c', 'b', 20), { atStep: 0 })

          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          const balA = await getBalance('a')
          const balB = await getBalance('b')
          const balC = await getBalance('c')
          expect(balA).toBeGreaterThanOrEqual(0)
          expect(balB).toBeGreaterThanOrEqual(0)
          expect(balC).toBeGreaterThanOrEqual(0)
          expect(balA + balB + balC).toBe(200)
          expect(getAuditEntries().length).toBe(okCount)
        },
      ),
      { numRuns: 20, seed: 4242 },
    )
  })
})
