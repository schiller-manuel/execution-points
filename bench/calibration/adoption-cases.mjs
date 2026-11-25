/**
 * Calibration cases for "this test uses the library" (PROTOCOL D-18, harness v2.6).
 *
 * A test uses `execution-points-prototype` when it imports `select` from the
 * package, calls it, and puts a selected point to use. `operations` is what
 * the auditor must record as used; `uses: false` cases are tests that mention
 * the package, or method names it shares with other things, without using it.
 *
 * `--self-test` runs every case through `bench/ast-audit.mjs`. The names are
 * the treatment guide's placeholders; no case names a task.
 */
const IMPORTS = `import { expect, test } from 'vitest'
import { reserveItem, restockItem } from './inventory'
`
const POINT = `const point = select('src/inventory.ts', (node) => node.callee === 'loadItem' && node)
`
const SELECT = `import { select } from 'execution-points-prototype'
`

/** One test file each. */
export const ADOPTION_FILE_CASES = [
  {
    name: 'point.pause(), the recipe of the treatment guide',
    uses: true,
    operations: ['pause'],
    code: `${IMPORTS}${SELECT}${POINT}
test('reserve and restock', async () => {
  const pause = point.pause()
  const opA = pause.run(() => reserveItem('sku-1'))
  await pause.reached
  const opB = restockItem('sku-1', 5)
  pause.release()
  await Promise.all([opA, opB])
  expect(1).toBe(1)
})
`,
  },
  {
    name: 'interleavings([pointA, pointB])',
    uses: true,
    operations: ['interleavings'],
    code: `${IMPORTS}import { interleavings, select } from 'execution-points-prototype'
const pointA = select('src/inventory.ts', (node) => node.callee === 'loadItem' && node)
const pointB = select('src/inventory.ts', (node) => node.callee === 'saveItem' && node)
test('every order', async () => {
  for (const order of interleavings([pointA, pointB])) {
    await order.run(() => Promise.all([reserveItem('sku-1'), restockItem('sku-1', 5)]))
    expect(1).toBe(1)
  }
})
`,
  },
  {
    name: 'using r = point.replace(handler)',
    uses: true,
    operations: ['replace'],
    code: `${IMPORTS}${SELECT}${POINT}
test('replaced everywhere', async () => {
  using outage = point.replace(async ({ original }) => original())
  await reserveItem('sku-1')
  expect(outage.calls).toBe(1)
})
`,
  },
  {
    name: 'the shorthands: returns, throws, resolves, rejects',
    uses: true,
    operations: ['rejects', 'resolves', 'returns', 'throws'],
    code: `${IMPORTS}${SELECT}${POINT}
test('fault injection', async () => {
  point.rejects(new Error('down'), { on: 2 })
  point.resolves({ sku: 'sku-1', stock: 1 })
  point.returns(Promise.resolve({ sku: 'sku-1', stock: 1 }))
  point.throws(new Error('down'))
  await expect(reserveItem('sku-1')).rejects.toThrow('down')
})
`,
  },
  {
    name: 'point.withReplacement(handler, action), the recipe of the stored runs',
    uses: true,
    operations: ['withReplacement'],
    code: `${IMPORTS}${SELECT}${POINT}
test('replaced inside the action', async () => {
  await point.withReplacement(async ({ original }) => original(), () => reserveItem('sku-1'))
  expect(1).toBe(1)
})
`,
  },
  {
    name: 'two operations in one file',
    uses: true,
    operations: ['pause', 'withReplacement'],
    code: `${IMPORTS}${SELECT}${POINT}
test('a', async () => {
  await point.withReplacement(async ({ original }) => original(), () => reserveItem('sku-1'))
})
test('b', async () => {
  const pause = point.pause()
  const op = pause.run(() => reserveItem('sku-1'))
  await pause.reached
  pause.release()
  await op
})
`,
  },
  {
    name: 'an aliased import, and a point with captures',
    uses: true,
    operations: ['pause'],
    code: `${IMPORTS}import { select as pick } from 'execution-points-prototype'
const held = pick('src/inventory.ts', (node) => node.callee === 'loadItem' && node).capture('sku')
test('captures', async () => {
  const pause = held.pause()
  const op = pause.run(() => reserveItem('sku-1'))
  const { locals } = await pause.reached
  expect(locals.sku).toBe('sku-1')
  pause.release()
  await op
})
`,
  },
  {
    name: 'a namespace import: ep.select(...) and ep.interleavings(...)',
    uses: true,
    operations: ['interleavings'],
    code: `${IMPORTS}import * as ep from 'execution-points-prototype'
const point = ep.select('src/inventory.ts', (node) => node.callee === 'loadItem' && node)
test('every order', async () => {
  for (const order of ep.interleavings([point])) await order.run(() => reserveItem('sku-1'))
})
`,
  },
  {
    name: 'a helper function is handed the point',
    uses: true,
    operations: ['pause'],
    code: `${IMPORTS}${SELECT}${POINT}
async function holdWhile(at: typeof point, first: () => Promise<void>, second: () => Promise<void>) {
  const pause = at.pause()
  const a = pause.run(first)
  await pause.reached
  const b = second()
  pause.release()
  await Promise.all([a, b])
}
test('helper', async () => {
  await holdWhile(point, () => reserveItem('sku-1'), () => restockItem('sku-1', 5))
})
`,
  },
  {
    name: 'points kept in an object and used through a member',
    uses: true,
    operations: ['pause'],
    code: `${IMPORTS}${SELECT}
const points = {
  load: select('src/inventory.ts', (node) => node.callee === 'loadItem' && node),
  save: select('src/inventory.ts', (node) => node.callee === 'saveItem' && node),
}
test('member', async () => {
  const pause = points.save.pause()
  const op = pause.run(() => reserveItem('sku-1'))
  await pause.reached
  pause.release()
  await op
})
`,
  },
  {
    name: 'points kept in a list and used in a loop',
    uses: true,
    operations: ['replace'],
    code: `${IMPORTS}${SELECT}
const all = [
  select('src/inventory.ts', (node) => node.callee === 'loadItem' && node),
  select('src/inventory.ts', (node) => node.callee === 'saveItem' && node),
]
test('loop', async () => {
  for (const each of all) each.replace(async ({ original }) => original(), { times: 'any' })
  await reserveItem('sku-1')
})
`,
  },
  {
    name: 'a local function returns the point',
    uses: true,
    operations: ['pause'],
    code: `${IMPORTS}${SELECT}
const callTo = (callee: string) => select('src/inventory.ts', (node) => node.callee === callee && node)
test('factory', async () => {
  const pause = callTo('loadItem').pause()
  const op = pause.run(() => reserveItem('sku-1'))
  await pause.reached
  pause.release()
  await op
})
`,
  },
  {
    name: 'select is imported and called, and the point is never used',
    uses: false,
    operations: [],
    code: `${IMPORTS}${SELECT}${POINT}
test('plain', async () => {
  void point
  await reserveItem('sku-1')
  expect(1).toBe(1)
})
`,
  },
  {
    name: 'the same method names on other things: expect(p).rejects, text.replace(), stub.returns()',
    uses: false,
    operations: [],
    code: `${IMPORTS}${SELECT}${POINT}
test('plain', async () => {
  void point
  const stub = { returns: (value: number) => value, pause: () => undefined }
  stub.returns(1)
  stub.pause()
  expect('sku-1'.replace('sku', 'item')).toBe('item-1')
  await expect(reserveItem('missing')).rejects.toThrow()
  await expect(reserveItem('sku-1')).resolves.toBeUndefined()
})
`,
  },
  {
    name: 'the package is imported for a type only',
    uses: false,
    operations: [],
    code: `${IMPORTS}import type { Point } from 'execution-points-prototype'
export type Held = Point<unknown, object>
test('plain', async () => {
  await reserveItem('sku-1')
  expect(1).toBe(1)
})
`,
  },
]

/** A test tree of several files: `{ rel: source }`. */
export const ADOPTION_TREE_CASES = [
  {
    name: 'a helper file exports the point, the test file pauses it',
    uses: true,
    operations: ['pause'],
    files: {
      'src/points.ts': `${SELECT}export const loading = select('src/inventory.ts', (node) => node.callee === 'loadItem' && node)
`,
      'src/inventory.test.ts': `${IMPORTS}import { loading } from './points'
test('helper file', async () => {
  const pause = loading.pause()
  const op = pause.run(() => reserveItem('sku-1'))
  await pause.reached
  pause.release()
  await op
})
`,
    },
  },
  {
    name: 'a helper file selects a point, and no file uses it',
    uses: false,
    operations: [],
    files: {
      'src/points.ts': `${SELECT}export const loading = select('src/inventory.ts', (node) => node.callee === 'loadItem' && node)
`,
      'src/inventory.test.ts': `${IMPORTS}import { loading } from './points'
test('plain', async () => {
  void loading
  await reserveItem('sku-1')
})
`,
    },
  },
]
