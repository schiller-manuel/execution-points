import { beforeEach, expect, test } from 'vitest'
import {
  failNextCharge,
  getGatewayChargeCount,
  resetPayments,
  submitPayment,
} from './payment-processor'

beforeEach(() => {
  resetPayments()
})

test('charges once and returns cached receipt for sequential retries', async () => {
  const r1 = await submitPayment('ord-1', 500)
  const r2 = await submitPayment('ord-1', 500)
  expect(r1).toEqual(r2)
  expect(getGatewayChargeCount('ord-1')).toBe(1)
})

test('rejects invalid amounts without charging gateway', async () => {
  await expect(submitPayment('ord-bad', 0)).rejects.toThrow('positive integer')
  expect(getGatewayChargeCount('ord-bad')).toBe(0)
})

test('retries cleanly after a gateway failure', async () => {
  failNextCharge('ord-2', 'Gateway 502')
  await expect(submitPayment('ord-2', 900)).rejects.toThrow('Gateway 502')
  const ok = await submitPayment('ord-2', 900)
  expect(ok.amountCents).toBe(900)
  expect(getGatewayChargeCount('ord-2')).toBe(1)
})
