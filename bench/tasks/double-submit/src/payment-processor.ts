export interface PaymentReceipt {
  idempotencyKey: string
  amountCents: number
  chargeId: string
}

const receipts = new Map<string, PaymentReceipt>()
const gatewayCharges: Array<{ idempotencyKey: string; amountCents: number; chargeId: string }> = []
const nextFailures = new Map<string, string[]>()
let chargeSeq = 0

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

async function validatePayment(amountCents: number): Promise<void> {
  await yieldIo()
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('Payment amount must be a positive integer')
  }
}

async function reserveFunds(_idempotencyKey: string, _amountCents: number): Promise<void> {
  await yieldIo()
}

async function chargeGateway(idempotencyKey: string, amountCents: number): Promise<string> {
  await yieldIo()
  const queue = nextFailures.get(idempotencyKey)
  if (queue && queue.length > 0) {
    throw new Error(queue.shift()!)
  }
  chargeSeq += 1
  const chargeId = `chg-${chargeSeq}`
  gatewayCharges.push({ idempotencyKey, amountCents, chargeId })
  return chargeId
}

export function resetPayments(): void {
  receipts.clear()
  gatewayCharges.length = 0
  nextFailures.clear()
  chargeSeq = 0
}

export function failNextCharge(idempotencyKey: string, message = 'Gateway timeout'): void {
  const queue = nextFailures.get(idempotencyKey) ?? []
  queue.push(message)
  nextFailures.set(idempotencyKey, queue)
}

export function getGatewayChargeCount(idempotencyKey: string): number {
  return gatewayCharges.filter((c) => c.idempotencyKey === idempotencyKey).length
}

export async function submitPayment(
  idempotencyKey: string,
  amountCents: number,
): Promise<PaymentReceipt> {
  const existing = receipts.get(idempotencyKey)
  if (existing) return { ...existing }
  await validatePayment(amountCents)
  await reserveFunds(idempotencyKey, amountCents)
  const chargeId = await chargeGateway(idempotencyKey, amountCents)
  const receipt: PaymentReceipt = { idempotencyKey, amountCents, chargeId }
  receipts.set(idempotencyKey, receipt)
  return { ...receipt }
}
