import { beforeEach, expect, test } from 'vitest'
import { applyOrderEvent, getOrder, resetProjector } from './order-projector'

beforeEach(() => {
  resetProjector()
})

test('applies sequential order events and ignores lower/duplicate sequences', async () => {
  await applyOrderEvent({ orderId: 'o1', seq: 1, status: 'Created' })
  await applyOrderEvent({ orderId: 'o1', seq: 2, status: 'Paid' })
  await applyOrderEvent({ orderId: 'o1', seq: 1, status: 'Created' })

  expect(await getOrder('o1')).toEqual({ orderId: 'o1', seq: 2, status: 'paid' })
})
