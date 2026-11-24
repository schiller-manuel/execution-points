// Probe (what-if, production untouched): how much of the idle overhead measured in p10 comes from
// the per-call registry lookup and AsyncLocalStorage read, and what would a guard in the emitted
// code cost instead? Variants are throwaway copies of src/runtime.mjs in this scratch directory.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, instrument } from './lib.mjs'

const source = `export function sum(n) {
  let s = 0
  for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
  return s
}
export function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
`
const p = instrument({ 'src/hot.ts': source })
const dir = join(p.root, 'variants'); mkdirSync(dir)
const original = readFileSync(`${REPO}/src/runtime.mjs`, 'utf8')
const emitted = p.code('src/hot.ts')

const variants = {
  'current runtime': original,
  // A: resolve the shared registry once per module instead of on every invoke().
  'A: registry cached in module scope': original
    .replace("const active = getRegistry().storage.getStore()?.get(id)", "const active = REG.storage.getStore()?.get(id)")
    .replace('export function registerFile', 'const REG = getRegistry()\nexport function registerFile'),
  // B: A + skip the AsyncLocalStorage read for points no test has ever replaced in this worker.
  'B: A + "never replaced" fast path': original
    .replace("const active = getRegistry().storage.getStore()?.get(id)", "if (!REG.armed.has(id)) return originalThunk()\n  const active = REG.storage.getStore()?.get(id)")
    .replace('export function registerFile', 'const REG = getRegistry(); REG.armed ??= new Set()\nexport function registerFile')
    .replace('replacements.set(selected.id, {', 'REG.armed.add(selected.id)\n      replacements.set(selected.id, {'),
}
const time = (fn) => { for (let i = 0; i < 3; i++) fn(); const r = []; for (let i = 0; i < 7; i++) { const t = performance.now(); fn(); r.push(performance.now() - t) } return r.sort((a, b) => a - b)[3] }

const plainFile = join(dir, 'plain.ts'); writeFileSync(plainFile, source)
const plain = await import(pathToFileURL(plainFile).href)
const base = { sum: time(() => plain.sum(2e6)), fib: time(() => plain.fib(27)) }
console.log(`plain (not a target)                         sum ${base.sum.toFixed(1)} ms | fib ${base.fib.toFixed(1)} ms`)

let i = 0
for (const [label, runtimeSource] of Object.entries(variants)) {
  const rt = join(dir, `runtime-${++i}.mjs`)
  writeFileSync(rt, runtimeSource.replace("'execution-points-prototype.runtime.v2'", `'probe.runtime.${i}'`))
  const file = join(dir, `hot-${i}.ts`)
  writeFileSync(file, emitted.replace('"execution-points-prototype/runtime"', JSON.stringify(pathToFileURL(rt).href)))
  const mod = await import(pathToFileURL(file).href)
  const s = time(() => mod.sum(2e6)), f = time(() => mod.fib(27))
  console.log(`${label.padEnd(44)} sum ${s.toFixed(1)} ms (${(s / base.sum).toFixed(0)}x) | fib ${f.toFixed(1)} ms (${(f / base.fib).toFixed(0)}x)`)
}

// C: a guard emitted around each point: `flag ? invoke(...) : (expr)`, hand-written for these two functions.
const guarded = `const G = { on: false }
const inv = (id, f) => f()
export function sum(n) {
  let s = 0
  for (let i = 0; G.on ? inv(1, () => (i < n)) : (i < n); i++) {
    s = G.on ? inv(2, () => (s + (i % 3 === 0 ? i : 1))) : (s + (G.on ? inv(3, () => (i % 3 === 0 ? i : 1)) : ((G.on ? inv(4, () => (i % 3 === 0)) : ((G.on ? inv(5, () => (i % 3)) : (i % 3)) === 0)) ? i : 1)))
  }
  return s
}
export function fib(n) { return G.on ? inv(6, () => (n < 2 ? n : fib(n - 1) + fib(n - 2))) : ((G.on ? inv(7, () => (n < 2)) : (n < 2)) ? n : (G.on ? inv(8, () => (fib(n - 1) + fib(n - 2))) : ((G.on ? inv(9, () => fib(n - 1)) : fib(G.on ? inv(10, () => (n - 1)) : (n - 1))) + (G.on ? inv(11, () => fib(n - 2)) : fib(G.on ? inv(12, () => (n - 2)) : (n - 2)))))) }
`
const gFile = join(dir, 'guarded.ts'); writeFileSync(gFile, guarded)
const g = await import(pathToFileURL(gFile).href)
const s = time(() => g.sum(2e6)), f = time(() => g.fib(27))
console.log(`${'C: guard emitted at each point (hand-written)'.padEnd(44)} sum ${s.toFixed(1)} ms (${(s / base.sum).toFixed(1)}x) | fib ${f.toFixed(1)} ms (${(f / base.fib).toFixed(1)}x)`)
