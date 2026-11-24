// Probe (end to end, real tsc + real content mapper): one target expression whose type comes from
// a Node built-in module. What does `tsc --noEmit --runExternalCode` report, and where?
import { consumer, tail } from './e2e.mjs'

const test = `import { expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { total } from '../src/app'

const sum = select('src/app.ts', (n) => n.operator === '+' && n).capture('a', 'b')
test('unrelated point in the same project', () => {
  expect(sum.withReplacement(({ locals }) => locals.a * locals.b, () => total(2, 3))).toBe(6)
})
`
const clean = consumer({
  'src/app.ts': `export function total(a: number, b: number) { return a + b }\n`,
  'test/app.test.ts': test,
})
const withFs = consumer({
  'src/app.ts': `export function total(a: number, b: number) { return a + b }\n`,
  'src/files.ts': `import { statSync } from 'node:fs'\nexport function size(p: string) { return statSync(p).size }\n`,
  'test/app.test.ts': test,
})

for (const [label, c] of [['project without node:fs', clean], ['same project + src/files.ts calling statSync()', withFs]]) {
  const t = c.tsc()
  const v = c.vitest()
  console.log(`## ${label}`)
  console.log(`tsc exit=${t.status}\n${tail(t.out, 6) || '(no output)'}`)
  console.log(`vitest exit=${v.status}: ${/Tests\s+.*/.exec(v.out)?.[0] ?? tail(v.out, 4)}\n`)
}
