import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createYieldScheduler } from './yield-engine.mjs'
import { applyOrderEvent, getOrder, resetProjector } from './src/order-projector'

describe('hidden oracle grader: event-order (yield-engine)', () => {
  test('concurrent out-of-order events always settle at the highest sequence number', async () => {
    const strategies: Array<(ready: number[], step: number) => number> = [
      (r) => r[0],
      (r) => r[r.length - 1],
      (r, s) => r[s % r.length],
      (r, s) => (s < 2 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 3 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 4 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
    ]

    for (const stagger of [0, 1, 2]) {
      for (const pick of strategies) {
        resetProjector()
        const sched = createYieldScheduler()
        sched.spawn(0, () => applyOrderEvent({ orderId: 'o1', seq: 1, status: 'Created' }), { atStep: 0 })
        sched.spawn(1, () => applyOrderEvent({ orderId: 'o1', seq: 2, status: 'Shipped' }), { atStep: stagger })
        let step = 0
        await sched.run((ready) => pick(ready, step++))

        expect(await getOrder('o1')).toEqual({ orderId: 'o1', seq: 2, status: 'shipped' })
      }
    }
  })

  test('randomized schedules across multi-order out-of-order and duplicate webhooks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        fc.integer({ min: 0, max: 3 }),
        async (picks, delay) => {
          resetProjector()
          const sched = createYieldScheduler()
          sched.spawn(0, () => applyOrderEvent({ orderId: 'o1', seq: 1, status: 'Created' }), { atStep: 0 })
          sched.spawn(1, () => applyOrderEvent({ orderId: 'o1', seq: 3, status: 'Delivered' }), { atStep: 0 })
          sched.spawn(2, () => applyOrderEvent({ orderId: 'o1', seq: 2, status: 'Shipped' }), { atStep: delay })
          sched.spawn(3, () => applyOrderEvent({ orderId: 'o2', seq: 5, status: 'Paid' }), { atStep: 0 })
          sched.spawn(4, () => applyOrderEvent({ orderId: 'o2', seq: 2, status: 'Created' }), { atStep: 1 })

          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          expect(await getOrder('o1')).toEqual({ orderId: 'o1', seq: 3, status: 'delivered' })
          expect(await getOrder('o2')).toEqual({ orderId: 'o2', seq: 5, status: 'paid' })
        },
      ),
      { numRuns: 25, seed: 4242 },
    )
  })
})
