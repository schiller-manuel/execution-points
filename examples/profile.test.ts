import { assert, expect, test } from 'vitest'
import { InterleavingFailure, interleavings, select } from 'execution-points-prototype'
import { cachedName, getProfile, reset, updateProfile } from './profile'

// The two places where the operations can be made to wait for each other.
const normalizing = select('examples/profile.ts', (n) => n.callee === 'normalize' && n)
const writing = select('examples/profile.ts', (n) => n.callee === 'writeStore' && n)

const readWhileUpdating = () => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')])

test('runs a read and an update in every order and finds the one that caches a stale name', async () => {
  const stale: Array<readonly number[]> = []
  let orders = 0
  for (const order of interleavings([normalizing, writing])) {
    reset()
    await order.run(readWhileUpdating)
    orders += 1
    // The loop body is the test's own: here it collects every order that ends wrong.
    if (cachedName('u1') !== 'Bob') stale.push(order.schedule)
  }
  expect(orders).toBe(2)
  expect(stale).toEqual([[0, 0]])
})

test('gets one order again from its schedule', async () => {
  for (const order of interleavings([normalizing, writing], { schedule: [0, 0] })) {
    reset()
    await order.run(readWhileUpdating)
    // The update's write went first, then the read cached the name it had fetched before.
    expect(order.released).toEqual([
      'examples/profile.ts#updateProfile:CallExpression:writeStore:0',
      'examples/profile.ts#getProfile:CallExpression:normalize:0',
    ])
    expect(cachedName('u1')).toBe('Alice')
  }
})

test('a check inside run is reported with the order it failed in', async () => {
  const everyOrder = async () => {
    for (const order of interleavings([normalizing, writing])) {
      await order.run(async () => {
        reset()
        await readWhileUpdating()
        expect(cachedName('u1')).toBe('Bob')
      })
    }
  }
  // A rejection can be any value, so TypeScript gives it no type; `instanceof` supplies one.
  const failure = await everyOrder().catch((error: unknown) => error)
  assert(failure instanceof InterleavingFailure, 'some order must leave the old name in the cache')
  expect(failure.schedule).toEqual([0, 0])
  expect(failure.message).toMatch(/1\. .*writeStore.*\n\s+2\. .*normalize/)
  expect(failure.message).toContain("It failed with: expected 'Alice' to be 'Bob'")
})

test('every order of two updates holds', async () => {
  let orders = 0
  for (const order of interleavings([writing])) {
    reset()
    await order.run(() => Promise.all([updateProfile('u1', 'Bob'), updateProfile('u1', 'Bob')]))
    expect(cachedName('u1')).toBe('Bob')
    orders += 1
  }
  expect(orders).toBe(2)
})

test('takes a sample of the orders', async () => {
  // Any rule can pick the orders; this one lets the last waiting evaluation go first.
  const lastFirst = (_step: number, count: number) => count - 1
  for (const order of interleavings([normalizing, writing], { choose: lastFirst }).take(3)) {
    reset()
    await order.run(readWhileUpdating)
    expect(order.schedule).toEqual([1, 0])
    expect(cachedName('u1')).toBe('Bob')
  }
})
