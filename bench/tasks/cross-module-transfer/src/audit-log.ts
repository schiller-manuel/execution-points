export interface AuditEntry {
  fromId: string
  toId: string
  amount: number
}

const entries: AuditEntry[] = []

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

export function resetAuditLog(): void {
  entries.length = 0
}

export function getAuditEntries(): AuditEntry[] {
  return entries.map((e) => ({ ...e }))
}

export async function recordTransfer(entry: AuditEntry): Promise<void> {
  await yieldIo()
  entries.push({ ...entry })
}
