import { beforeEach, expect, test } from 'vitest'
import { failNextRefresh, getRefreshCallCount } from './auth-client'
import { getToken, invalidateToken, resetTokenCache } from './token-cache'

beforeEach(() => {
  resetTokenCache()
})

test('fetches and caches token for a tenant', async () => {
  const t1 = await getToken('acme')
  const t2 = await getToken('acme')
  expect(t1).toBe(t2)
  expect(getRefreshCallCount('acme')).toBe(1)
})

test('refetches after invalidateToken', async () => {
  const t1 = await getToken('acme')
  invalidateToken('acme')
  const t2 = await getToken('acme')
  expect(t2).not.toBe(t1)
  expect(getRefreshCallCount('acme')).toBe(2)
})

test('retries cleanly after a failed refresh', async () => {
  failNextRefresh('acme', 'upstream 503')
  await expect(getToken('acme')).rejects.toThrow('upstream 503')
  const recovered = await getToken('acme')
  expect(recovered).toMatch(/^tok-acme-/)
  expect(getRefreshCallCount('acme')).toBe(2)
})
