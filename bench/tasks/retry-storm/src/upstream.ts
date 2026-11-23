let callCount = 0
let failRemaining = 0

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

export function resetUpstream(): void {
  callCount = 0
  failRemaining = 0
}

export function setUpstreamFailures(count: number): void {
  failRemaining = count
}

export function getUpstreamCallCount(): number {
  return callCount
}

export async function callUpstream(payload: string): Promise<string> {
  callCount += 1
  const shouldFail = failRemaining > 0
  if (shouldFail) failRemaining -= 1
  await yieldIo()
  if (shouldFail) {
    throw new Error('Upstream 503')
  }
  await yieldIo()
  return `ok:${payload}`
}
