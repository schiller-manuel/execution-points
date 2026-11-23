import { beforeEach, expect, test } from 'vitest'
import { getActiveToken, login, logout, resetSessions } from './session-manager'

beforeEach(() => {
  resetSessions()
})

test('returns null when user is not logged in', async () => {
  expect(await getActiveToken('u1')).toBeNull()
})

test('issues and caches a token for a logged-in user', async () => {
  login('u1')
  const first = await getActiveToken('u1')
  expect(first).toBe('tok-u1-1')
  const second = await getActiveToken('u1')
  expect(second).toBe('tok-u1-1')
})

test('revokes token after logout', async () => {
  login('u1')
  expect(await getActiveToken('u1')).toBe('tok-u1-1')
  await logout('u1')
  expect(await getActiveToken('u1')).toBeNull()
})
