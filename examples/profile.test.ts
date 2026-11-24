import { assert, expect, test } from 'vitest'
import { InterleavingFailure, interleavings, select } from 'execution-points-prototype'
import { cachedName, getProfile, reset, updateProfile } from './profile'

// The two places where the operations can be made to wait for each other.
const normalizing = select('examples/profile.ts', (n) => n.callee === 'normalize' && n)
const writing = select('examples/profile.ts', (n) => n.callee === 'writeStore' && n)

const readWhileUpdating = {
  points: [normalizing, writing],
  setup: reset,
  run: () => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')]),
  check: () => {
    expect(cachedName('u1')).toBe('Bob')
  },
}

test('searches every order of a read and an update, and finds the one that caches a stale name', async () => {
  // A rejection can be any value, so TypeScript gives it no type; `instanceof` supplies one.
  const failure = await interleavings(readWhileUpdating).catch((error: unknown) => error)
  assert(failure instanceof InterleavingFailure, 'some order must leave the old name in the cache')
  // The message lists the order; `schedule` replays exactly it.
  expect(failure.message).toContain('The scenario failed in this order')
  expect(failure.message).toMatch(/1\. .*writeStore.*\n\s+2\. .*normalize/)
  await expect(interleavings({ ...readWhileUpdating, schedule: failure.schedule })).rejects.toThrow(
    "It failed with: expected 'Alice' to be 'Bob'",
  )
})

test('reports how many orders it ran when every one of them holds', async () => {
  const report = await interleavings({
    points: [writing],
    setup: reset,
    run: () => Promise.all([updateProfile('u1', 'Bob'), updateProfile('u1', 'Bob')]),
    check: () => {
      expect(cachedName('u1')).toBe('Bob')
    },
  })
  expect(report).toEqual({ schedules: 2, complete: true })
})
