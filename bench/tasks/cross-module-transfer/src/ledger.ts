import { readBalance, resetAccounts, seedAccount, writeBalance } from './account-store'
import { recordTransfer, resetAuditLog } from './audit-log'

export function resetLedger(): void {
  resetAccounts()
  resetAuditLog()
}

export function createAccount(accountId: string, initialBalance: number): void {
  seedAccount(accountId, initialBalance)
}

export async function getBalance(accountId: string): Promise<number> {
  return readBalance(accountId)
}

export async function transfer(fromId: string, toId: string, amount: number): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Transfer amount must be a positive integer')
  }
  if (fromId === toId) {
    throw new Error('Cannot transfer to the same account')
  }

  const fromBal = await readBalance(fromId)
  if (fromBal < amount) {
    throw new Error('Insufficient funds')
  }
  const toBal = await readBalance(toId)

  await writeBalance(fromId, fromBal - amount)
  await writeBalance(toId, toBal + amount)
  await recordTransfer({ fromId, toId, amount })
}
