import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { countYields, createYieldScheduler } from './yield-engine.mjs'
import {
  failNextCharge,
  getGatewayChargeCount,
  resetPayments,
  submitPayment,
  type PaymentReceipt,
} from './src/payment-processor'

describe('hidden oracle grader: double-submit (yield-engine)', () => {
  test('caches completed receipt (0 async yields on warm hit), preserves cold yields, and rejects invalid amounts', async () => {
    resetPayments()
    const ioSite = /#(validatePayment|reserveFunds|chargeGateway|yieldIo):/
    const { result: r1, yields: coldYields } = await countYields(() => submitPayment('k1', 500), {
      matchSite: ioSite,
    })
    expect(coldYields).toBeGreaterThanOrEqual(3)
    expect(getGatewayChargeCount('k1')).toBe(1)

    const { result: r2, yields } = await countYields(() => submitPayment('k1', 500), {
      matchSite: ioSite,
    })
    expect(r2).toEqual(r1)
    expect(yields).toBe(0)
    expect(getGatewayChargeCount('k1')).toBe(1)

    await expect(submitPayment('k-bad', -10)).rejects.toThrow()
    expect(getGatewayChargeCount('k-bad')).toBe(0)
  })

  test('deduplicates concurrent submitPayment calls for the same idempotencyKey', async () => {
    for (const stagger of [0, 1, 2]) {
      for (const mode of ['first', 'last', 'alt'] as const) {
        resetPayments()
        const out: PaymentReceipt[] = []
        const sched = createYieldScheduler()
        sched.spawn(0, async () => { out[0] = await submitPayment('k1', 750) }, { atStep: 0 })
        sched.spawn(1, async () => { out[1] = await submitPayment('k1', 750) }, { atStep: 0 })
        sched.spawn(2, async () => { out[2] = await submitPayment('k1', 750) }, { atStep: stagger })
        let step = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[step++ % ready.length]
        })

        expect(getGatewayChargeCount('k1')).toBe(1)
        expect(out[0]).toBeTruthy()
        expect(out[1]).toEqual(out[0])
        expect(out[2]).toEqual(out[0])
      }
    }
  })

  test('failed in-flight payment does not poison subsequent retry and never double-charges (N>=3, catches DS-BYPASS / G-11)', async () => {
    for (const mode of ['first', 'last', 'alt'] as const) {
      resetPayments()
      failNextCharge('k1', 'Gateway 502')
      const errs: string[] = []
      const successes: PaymentReceipt[] = []
      const sched = createYieldScheduler()
      for (let i = 0; i < 3; i++) {
        sched.spawn(
          i,
          async () => {
            try {
              successes.push(await submitPayment('k1', 500))
            } catch (err) {
              errs.push((err as Error).message)
            }
          },
          { atStep: 0 },
        )
      }
      let step = 0
      await sched.run((ready) => {
        if (mode === 'first') return ready[0]
        if (mode === 'last') return ready[ready.length - 1]
        return ready[step++ % ready.length]
      })

      // D-05 design-neutral law for N=3 concurrent callers with 1 injected gateway failure:
      // - At least 1 caller saw the injected failure; errors + successes === 3
      // - Gateway charged AT MOST ONCE during the wave (catches DS-BYPASS double-charge!)
      // - If any callers succeeded via queued retry, charge count is 1 and all share one receipt
      expect(errs.length + successes.length).toBe(3)
      expect(errs.length).toBeGreaterThanOrEqual(1)
      const countAfterWave = getGatewayChargeCount('k1')
      expect(countAfterWave).toBeLessThanOrEqual(1)
      if (successes.length > 0) {
        expect(countAfterWave).toBe(1)
        for (const r of successes) expect(r).toEqual(successes[0])
      } else {
        expect(countAfterWave).toBe(0)
      }

      // Subsequent call must never remain poisoned and total charges must be exactly 1
      const retry = await submitPayment('k1', 500)
      expect(retry.amountCents).toBe(500)
      if (successes.length > 0) expect(retry).toEqual(successes[0])
      expect(getGatewayChargeCount('k1')).toBe(1)
    }
  })

  test('randomized schedules with multi-key isolation and injected failures', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        fc.boolean(),
        async (picks, injectFail) => {
          resetPayments()
          if (injectFail) failNextCharge('k-a', 'Gateway 502')
          const aSuccesses: PaymentReceipt[] = []
          const aErrors: string[] = []
          let b1!: PaymentReceipt
          const sched = createYieldScheduler()
          for (let i = 0; i < 3; i++) {
            sched.spawn(
              i,
              async () => {
                try {
                  aSuccesses.push(await submitPayment('k-a', 100))
                } catch (err) {
                  aErrors.push((err as Error).message)
                }
              },
              { atStep: i === 2 ? 1 : 0 },
            )
          }
          sched.spawn(3, async () => { b1 = await submitPayment('k-b', 200) }, { atStep: 0 })
          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          expect(aSuccesses.length + aErrors.length).toBe(3)
          expect(getGatewayChargeCount('k-a')).toBeLessThanOrEqual(1)
          expect(getGatewayChargeCount('k-b')).toBe(1)
          if (aSuccesses.length > 0) {
            for (const r of aSuccesses) expect(r).toEqual(aSuccesses[0])
            expect(b1.chargeId).not.toBe(aSuccesses[0].chargeId)
          }
          const finalA = await submitPayment('k-a', 100)
          expect(getGatewayChargeCount('k-a')).toBe(1)
          if (aSuccesses.length > 0) expect(finalA).toEqual(aSuccesses[0])
          expect(b1.idempotencyKey).toBe('k-b')
          expect(b1.chargeId).not.toBe(finalA.chargeId)
        },
      ),
      { numRuns: 24, seed: 4242 },
    )
  })
})
