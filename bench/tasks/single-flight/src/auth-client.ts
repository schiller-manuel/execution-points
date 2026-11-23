const callCounts = new Map<string, number>()
const nextFailures = new Map<string, string[]>()
let tokenSeq = 0

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

export function resetAuthClient(): void {
  callCounts.clear()
  nextFailures.clear()
  tokenSeq = 0
}

export function getRefreshCallCount(tenantId: string): number {
  return callCounts.get(tenantId) ?? 0
}

export function failNextRefresh(tenantId: string, message = 'Auth service unavailable'): void {
  const queue = nextFailures.get(tenantId) ?? []
  queue.push(message)
  nextFailures.set(tenantId, queue)
}

export async function fetchRefreshToken(tenantId: string): Promise<string> {
  callCounts.set(tenantId, (callCounts.get(tenantId) ?? 0) + 1)
  await yieldIo()
  const queue = nextFailures.get(tenantId)
  if (queue && queue.length > 0) {
    const message = queue.shift()!
    throw new Error(message)
  }
  await yieldIo()
  tokenSeq += 1
  return `tok-${tenantId}-${tokenSeq}`
}
