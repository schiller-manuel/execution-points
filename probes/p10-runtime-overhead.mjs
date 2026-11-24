// Probe: what does listing a module as a target cost at runtime: untouched, while a replacement
// is active elsewhere in the same file, and while one is active for the function's own expression?
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

// Median of 7 timings; each timing runs `fn` `repeat` times so that fast cases are measurable.
const time = (fn, repeat = 1) => {
  const once = () => { const t = performance.now(); for (let i = 0; i < repeat; i++) fn(); return (performance.now() - t) / repeat }
  for (let i = 0; i < 3; i++) once() // warm up
  return Array.from({ length: 7 }, once).sort((a, b) => a - b)[3]
}
const elsewhere = runtime.select('src/hot.ts', (n) => n.callee === 'helper' && n)
const own = {
  sum: runtime.select('src/hot.ts', (n) => n.inFunction === 'sum' && n.operator === '%' && n),
  fib: runtime.select('src/hot.ts', (n) => n.inFunction === 'fib' && n.operator === '<' && n),
}
const cases = [
  ['sum(2e6)  loop: < + % === ?:', () => plain.sum(2e6), () => inst.sum(2e6), own.sum],
  ['fib(27)   recursion', () => plain.fib(27), () => inst.fib(27), own.fib],
]
// A replacement changes a function's flag for the rest of the process, so each column is
// measured for both functions before the next kind of replacement is installed.
const base = cases.map(([, plainFn]) => time(plainFn, 20))
const untouched = cases.map(([, , instFn]) => time(instFn, 20))
const otherFunction = cases.map(([, , instFn]) => elsewhere.withReplacement(({ original }) => original(), () => time(instFn, 20)))
const ownExpression = cases.map(([, , instFn, point]) => point.withReplacement(({ original }) => original(), () => time(instFn)))
cases.forEach(([label], i) => {
  const x = (ms) => `${ms.toFixed(1)} ms (${(ms / base[i]).toFixed(ms / base[i] < 10 ? 1 : 0)}x)`
  console.log(`${label.padEnd(30)} plain ${base[i].toFixed(1)} ms | listed as a target, untouched ${x(untouched[i])} | a replacement is active in another function of the file ${x(otherFunction[i])} | a replacement is active for one of its own expressions ${x(ownExpression[i])}`)
})
console.log(`\ninstrumented source size: ${source.length} -> ${p.code('src/hot.ts').length} chars (${(p.code('src/hot.ts').length / source.length).toFixed(1)}x)`)
