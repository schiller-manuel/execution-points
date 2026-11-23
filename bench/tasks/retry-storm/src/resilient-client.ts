import { callUpstream } from './upstream'

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface ResilientClient {
  request(payload: string): Promise<string>
  getState(): BreakerState
  forceHalfOpen(): void
}

export function createResilientClient(failureThreshold = 2): ResilientClient {
  let state: BreakerState = 'CLOSED'
  let consecutiveFailures = 0

  function forceHalfOpen(): void {
    if (state === 'OPEN') {
      state = 'HALF_OPEN'
    }
  }

  async function request(payload: string): Promise<string> {
    if (state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN')
    }

    try {
      const result = await callUpstream(payload)
      consecutiveFailures = 0
      state = 'CLOSED'
      return result
    } catch (err) {
      consecutiveFailures += 1
      if (state === 'HALF_OPEN' || consecutiveFailures >= failureThreshold) {
        state = 'OPEN'
      }
      throw err
    }
  }

  return {
    request,
    getState: () => state,
    forceHalfOpen,
  }
}
