import { enrichOrderStatus, readOrder, resetOrderRepo, saveOrder, type OrderRecord } from './order-repo'

export type { OrderRecord }

export interface OrderEvent {
  orderId: string
  seq: number
  status: string
}

export function resetProjector(): void {
  resetOrderRepo()
}

export async function getOrder(orderId: string): Promise<OrderRecord | null> {
  return readOrder(orderId)
}

export async function applyOrderEvent(event: OrderEvent): Promise<OrderRecord> {
  const current = await readOrder(event.orderId)
  if (current && event.seq <= current.seq) {
    return current
  }
  const normalized = await enrichOrderStatus(event.status)
  const next: OrderRecord = {
    orderId: event.orderId,
    seq: event.seq,
    status: normalized,
  }
  await saveOrder(next)
  return { ...next }
}
