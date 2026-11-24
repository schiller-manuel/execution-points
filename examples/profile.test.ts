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

// A visitor object says where an expression stands, the way a Babel visitor does: visit the
// function, then traverse into it. `cache.set(id, name)` is written twice in the module.
const cachingAfterUpdate = select('examples/profile.ts', {
  Function: (fn) =>
    fn.name === 'updateProfile' &&
    fn.traverse({
      CallExpression: (call) => call.callee === 'set' && call.object === 'cache' && call,
    }),
})
// The call that initializes a constant: visit the declarator, traverse into it.
const readingForRaw = select('examples/profile.ts', {
  VariableDeclarator: (declared) => declared.name === 'raw' && declared.traverse({ CallExpression: (call) => call }),
})

test('selects the cache write of the update, not the one of the read', async () => {
  reset()
  let written: unknown
  await cachingAfterUpdate.withReplacement(
    ({ original }) => {
      written = 'intercepted'
      return original()
    },
    () => updateProfile('u1', 'Bob'),
  )
  expect(written).toBe('intercepted')
  // The read's own cache write is another expression: it runs untouched.
  reset()
  await cachingAfterUpdate.withReplacement(() => expect.unreachable('the read must not reach the update\'s write'), () => getProfile('u1'), {
    times: 0,
  })
  expect(cachedName('u1')).toBe('Alice')
})

test('selects the call that initializes a constant', async () => {
  reset()
  const name = await readingForRaw.withReplacement(async () => '  Carol  ', () => getProfile('u1'))
  expect(name).toBe('Carol')
})
