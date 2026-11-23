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

  test('failed in-flight payment does not poison subsequent retry', async () => {
    resetPayments()
    failNextCharge('k1', 'Gateway 502')
    const errs: string[] = []
    const sched = createYieldScheduler()
    sched.spawn(
      0,
      async () => {
        try {
          await submitPayment('k1', 500)
        } catch (err) {
          errs.push((err as Error).message)
        }
      },
      { atStep: 0 },
    )
    sched.spawn(
      1,
      async () => {
        try {
          await submitPayment('k1', 500)
        } catch (err) {
          errs.push((err as Error).message)
        }
      },
      { atStep: 0 },
    )
    await sched.run((ready) => ready[0])

    expect(errs.length).toBe(2)
    expect(getGatewayChargeCount('k1')).toBe(0)

    const retry = await submitPayment('k1', 500)
    expect(retry.amountCents).toBe(500)
    expect(getGatewayChargeCount('k1')).toBe(1)
  })

  test('randomized schedules with multi-key isolation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        async (picks) => {
          resetPayments()
          let a1!: PaymentReceipt
          let a2!: PaymentReceipt
          let b1!: PaymentReceipt
          const sched = createYieldScheduler()
          sched.spawn(0, async () => { a1 = await submitPayment('k-a', 100) }, { atStep: 0 })
          sched.spawn(1, async () => { a2 = await submitPayment('k-a', 100) }, { atStep: 1 })
          sched.spawn(2, async () => { b1 = await submitPayment('k-b', 200) }, { atStep: 0 })
          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          expect(getGatewayChargeCount('k-a')).toBe(1)
          expect(getGatewayChargeCount('k-b')).toBe(1)
          expect(a1).toEqual(a2)
          expect(b1.idempotencyKey).toBe('k-b')
          expect(b1.chargeId).not.toBe(a1.chargeId)
        },
      ),
      { numRuns: 20, seed: 4242 },
    )
  })
})
