const balances = new Map<string, number>()

function yieldIo(): Promise<void> {
  return new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(0)
  })
}

export function resetAccounts(): void {
  balances.clear()
}

export function seedAccount(accountId: string, balance: number): void {
  balances.set(accountId, balance)
}

export async function readBalance(accountId: string): Promise<number> {
  await yieldIo()
  return balances.get(accountId) ?? 0
}

export async function writeBalance(accountId: string, balance: number): Promise<void> {
  await yieldIo()
  balances.set(accountId, balance)
}
