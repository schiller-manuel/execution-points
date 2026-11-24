// Probe (end to end, real tsc and Vitest): one expression that two containers lead to, selected
// with a different capture on each way. What does the compiler make of it, and what the runtime?
// This was F18: until 2026-11-24 the compiler accepted the second case and the runtime refused it
// as two matches, and in the third the compiler gave the point no local at all. Now one expression
// is one selection that captures what any way captured, on both sides.
import { consumer, tail } from './e2e.mjs'

const src = `export function outer(list: string[], prefix: string) {
  return list.map((each) => prefix + each)
}
`
const head = `import { expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { outer } from '../src/app'
`
const cases = {
  // prefix + each lies in outer and in the callback inside it; the handler captures the same on both ways.
  'the same capture on both ways': `const point = select('src/app.ts', {
  Function: (fn) => fn.traverse({ BinaryExpression: (sum) => sum.capture('prefix') }),
})
test('runs', () => {
  expect(point.withReplacement(({ locals, original }) => locals.prefix + '|' + original(), () => outer(['a'], 'x'))).toEqual(['x|xa'])
})`,
  'a different capture on each way': `const point = select('src/app.ts', {
  Function: (fn) => fn.traverse({ BinaryExpression: (sum) => (fn.name === 'outer' ? sum.capture('prefix') : sum.capture('each')) }),
})
test('runs', () => {
  expect(point.withReplacement(({ locals, original }) => locals.prefix + '|' + locals.each + '|' + original(), () => outer(['a'], 'x'))).toEqual(['x|a|xa'])
})`,
  'the node on one way, a capture on the other': `const point = select('src/app.ts', {
  Function: (fn) => fn.traverse({ BinaryExpression: (sum) => (fn.name === 'outer' ? sum : sum.capture('each')) }),
})
test('runs', () => {
  expect(point.withReplacement(({ locals, original }) => locals.each + '|' + original(), () => outer(['a'], 'x'))).toEqual(['a|xa'])
})`,
  'captures that overlap': `const point = select('src/app.ts', {
  Function: (fn) => fn.traverse({ BinaryExpression: (sum) => (fn.name === 'outer' ? sum.capture('list', 'prefix') : sum.capture('prefix', 'each')) }),
})
test('runs', () => {
  expect(point.withReplacement(({ locals, original }) => [Object.keys(locals).sort().join(), locals.list.length, locals.prefix, locals.each, original()].join('|'), () => outer(['a'], 'x'))).toEqual(['each,list,prefix|1|x|a|xa'])
})`,
  'a local that no way captured': `const point = select('src/app.ts', {
  Function: (fn) => fn.traverse({ BinaryExpression: (sum) => (fn.name === 'outer' ? sum.capture('prefix') : sum.capture('each')) }),
})
test('runs', () => {
  expect(point.withReplacement(({ locals, original }) => locals.list + '|' + original(), () => outer(['a'], 'x'))).toEqual(['undefined|xa'])
})`,
}
for (const [label, body] of Object.entries(cases)) {
  const project = consumer({ 'src/app.ts': src, 'test/app.test.ts': head + body + '\n' })
  const compiled = project.tsc()
  const ran = project.vitest()
  console.log(`\n## ${label}`)
  console.log(`   tsc exit=${compiled.status}${compiled.out.trim() ? `\n   ${compiled.out.trim().split('\n').slice(0, 3).join('\n   ').slice(0, 600)}` : ': no error'}`)
  const why = ran.out.split('\n').filter((line) => /\[execution-points\]|AssertionError|✓|passed|failed/.test(line)).slice(0, 4)
  console.log(`   vitest exit=${ran.status}\n   ${(why.length ? why : tail(ran.out, 4).split('\n')).join('\n   ').slice(0, 700)}`)
}
