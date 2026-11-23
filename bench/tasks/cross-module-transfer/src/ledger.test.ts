import { beforeEach, expect, test } from 'vitest'
import { getAuditEntries } from './audit-log'
import { createAccount, getBalance, resetLedger, transfer } from './ledger'

beforeEach(() => {
  resetLedger()
})

test('transfers funds between accounts and records audit entry', async () => {
  createAccount('a', 100)
  createAccount('b', 50)
  await transfer('a', 'b', 40)

  expect(await getBalance('a')).toBe(60)
  expect(await getBalance('b')).toBe(90)
  expect(getAuditEntries()).toEqual([{ fromId: 'a', toId: 'b', amount: 40 }])
})

test('rejects overdrafts and invalid amounts', async () => {
  createAccount('a', 30)
  createAccount('b', 0)
  await expect(transfer('a', 'b', 50)).rejects.toThrow('Insufficient funds')
  await expect(transfer('a', 'b', 0)).rejects.toThrow('positive integer')
  expect(await getBalance('a')).toBe(30)
  expect(await getBalance('b')).toBe(0)
})
