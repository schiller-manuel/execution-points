// Probe (end to end): a selector that needs `nth` keeps compiling and keeps "matching exactly 1"
// after a refactor adds an earlier same-named call, but now points at a different expression.
import { consumer, tail } from './e2e.mjs'

const before = `export async function sync(id: string, cache: Store, db: Store) {
  const cached = await cache.get(id)
  const stored = await db.get(id)
  return cached === stored
}
export interface Store { get(id: string): Promise<string> }
`
// Behavior-preserving refactor: warm the cache entry first. No call was renamed or removed.
const after = before.replace(`  const cached = await cache.get(id)\n`, `  await cache.get('warmup')\n  const cached = await cache.get(id)\n`)

const test = `import { expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { sync, type Store } from '../src/app'

// "the db read": second get() call in sync()
const dbRead = select('src/app.ts', (n) => n.callee === 'get' && n.nth === 1 && n)

test('reports a mismatch when the db returns something else', async () => {
  const store = (value: string): Store => ({ get: async () => value })
  const result = await dbRead.withReplacement(async () => 'from-test', () => sync('u1', store('same'), store('same')))
  expect(result).toBe(false)
})
`
for (const [label, src] of [['before the refactor', before], ['after the refactor ', after]]) {
  const c = consumer({ 'src/app.ts': src, 'test/app.test.ts': test })
  const t = c.tsc()
  const v = c.vitest()
  console.log(`${label}: tsc exit=${t.status}${t.status ? ` (${tail(t.out, 2)})` : ''} | vitest exit=${v.status} | ${/Tests\s+.*/.exec(v.out)?.[0]?.trim() ?? tail(v.out, 3)}`)
  if (v.status) console.log(`   ${v.out.split('\n').filter((l) => /AssertionError|expected|matched/.test(l)).slice(0, 2).join(' | ')}`)
}

// Which expression does the unchanged selector resolve to in each version?
const { indexSource } = await import('./lib.mjs')
for (const [label, src] of [['before', before], ['after ', after]]) {
  const hit = indexSource(src).nodes.find((n) => n.callee === 'get' && n.nth === 1)
  console.log(`selector resolves to (${label}): ${src.slice(hit.start, hit.end)}   [${hit.id}]`)
}
