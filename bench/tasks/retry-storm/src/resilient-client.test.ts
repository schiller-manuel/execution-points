import { beforeEach, expect, test } from 'vitest'
import { getUpstreamCallCount, resetUpstream, setUpstreamFailures } from './upstream'
import { createResilientClient } from './resilient-client'

beforeEach(() => {
  resetUpstream()
})

test('opens circuit after failureThreshold consecutive failures and recovers via half-open probe', async () => {
  setUpstreamFailures(2)
  const client = createResilientClient(2)

  await expect(client.request('a')).rejects.toThrow('Upstream 503')
  expect(client.getState()).toBe('CLOSED')
  await expect(client.request('b')).rejects.toThrow('Upstream 503')
  expect(client.getState()).toBe('OPEN')

  await expect(client.request('c')).rejects.toThrow('OPEN')
  expect(getUpstreamCallCount()).toBe(2)

  client.forceHalfOpen()
  expect(client.getState()).toBe('HALF_OPEN')
  expect(await client.request('probe')).toBe('ok:probe')
  expect(client.getState()).toBe('CLOSED')
})
