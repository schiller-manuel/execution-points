import { beforeEach, expect, test } from 'vitest'
import { clearCache, getProfile, resetStore, seedProfile, updateProfile } from './profile-store'

beforeEach(() => {
  resetStore()
})

test('loads seeded profile and caches it', async () => {
  seedProfile('u1', 'Alice')
  const first = await getProfile('u1')
  expect(first).toEqual({ id: 'u1', name: 'Alice', displayName: 'ALICE' })
  const second = await getProfile('u1')
  expect(second).toEqual({ id: 'u1', name: 'Alice', displayName: 'ALICE' })
})

test('returns null for missing profile', async () => {
  expect(await getProfile('missing')).toBeNull()
})

test('updates profile and persists across cache clears', async () => {
  seedProfile('u1', 'Alice')
  await getProfile('u1')
  const updated = await updateProfile('u1', 'Bob')
  expect(updated).toEqual({ id: 'u1', name: 'Bob', displayName: 'BOB' })
  expect(await getProfile('u1')).toEqual({ id: 'u1', name: 'Bob', displayName: 'BOB' })
  clearCache()
  expect(await getProfile('u1')).toEqual({ id: 'u1', name: 'Bob', displayName: 'BOB' })
})

test('rejects empty names', async () => {
  await expect(updateProfile('u1', '   ')).rejects.toThrow('Profile name cannot be empty')
})
