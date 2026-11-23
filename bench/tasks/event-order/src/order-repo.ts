export interface OrderRecord {
  orderId: string
  seq: number
  status: string
}

const orders = new Map<string, OrderRecord>()

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

export function resetOrderRepo(): void {
  orders.clear()
}

export async function readOrder(orderId: string): Promise<OrderRecord | null> {
  await yieldIo()
  const row = orders.get(orderId)
  return row ? { ...row } : null
}

export async function enrichOrderStatus(status: string): Promise<string> {
  await yieldIo()
  return status.trim().toLowerCase()
}

export async function saveOrder(record: OrderRecord): Promise<void> {
  await yieldIo()
  orders.set(record.orderId, { ...record })
}
