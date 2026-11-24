// Probe: what does listing a module as a target cost at runtime when NO replacement is active,
// and when a replacement for an unrelated point is active?
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { instrument, runtime } from './lib.mjs'

const source = `export function sum(n) {
  let s = 0
  for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
  return s
}
export function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
export function unrelated(a) { return helper(a) }
function helper(a) { return a }
`
const p = instrument({ 'src/hot.ts': source })
const plainFile = join(p.root, 'src/plain.ts')
writeFileSync(plainFile, source)
const plain = await import(pathToFileURL(plainFile).href)
const inst = await p.load('src/hot.ts')

const time = (fn) => {
  for (let i = 0; i < 3; i++) fn() // warm up
  const runs = []
  for (let i = 0; i < 7; i++) { const t = performance.now(); fn(); runs.push(performance.now() - t) }
  return runs.sort((a, b) => a - b)[3]
}
const point = runtime.select('src/hot.ts', (n) => n.callee === 'helper' && n)

for (const [label, plainFn, instFn] of [
  ['sum(2e6)  loop: < + % === ?:', () => plain.sum(2e6), () => inst.sum(2e6)],
  ['fib(27)   recursion', () => plain.fib(27), () => inst.fib(27)],
]) {
  const base = time(plainFn)
  const idle = time(instFn)
  const scoped = point.withReplacement(({ original }) => original(), () => time(instFn))
  console.log(`${label.padEnd(30)} plain ${base.toFixed(1)} ms | instrumented, no replacement active ${idle.toFixed(1)} ms (${(idle / base).toFixed(0)}x) | inside an unrelated withReplacement ${scoped.toFixed(1)} ms (${(scoped / base).toFixed(0)}x)`)
}
console.log(`\ninstrumented source size: ${source.length} -> ${p.code('src/hot.ts').length} chars (${(p.code('src/hot.ts').length / source.length).toFixed(1)}x)`)
