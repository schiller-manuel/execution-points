// Probe (design comparison, production untouched): what each way of emitting instrumented code
// costs while no replacement is installed, hand-written for two small functions. `inv` stands in
// for the runtime's invoke with nothing to do, so these are lower bounds for the wrapped forms.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { project } from './lib.mjs'

const source = `export function sum(n) {
  let s = 0
  for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
  return s
}
export function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
`
const dir = join(project({}), 'variants'); mkdirSync(dir)
// Median of 7 timings of 10 runs each.
const time = (fn) => { const once = () => { const t = performance.now(); for (let i = 0; i < 10; i++) fn(); return (performance.now() - t) / 10 }; for (let i = 0; i < 3; i++) once(); return Array.from({ length: 7 }, once).sort((a, b) => a - b)[3] }

const plainFile = join(dir, 'plain.ts'); writeFileSync(plainFile, source)
const plain = await import(pathToFileURL(plainFile).href)
const base = { sum: time(() => plain.sum(2e6)), fib: time(() => plain.fib(27)) }
console.log(`plain (not a target)                         sum ${base.sum.toFixed(2)} ms | fib ${base.fib.toFixed(2)} ms`)

// `S.a` and `F[k]` stand for "a replacement was installed for an expression of this code".
const inv = `const S = { a: false }\nconst inv = (id, f) => f()\n`
const designs = {
  // The shape emitted before the fast path existed: every expression always goes through a call.
  'every expression wrapped, always': `const inv = (id, f) => f()\n` + `export function sum(n) {
  let s = 0
  for (let i = 0; inv(1, () => (i < n)); i++) { s = inv(2, () => (s + inv(3, () => (inv(4, () => (inv(5, () => (i % 3)) === 0)) ? i : 1)))) }
  return s
}
export function fib(n) { return inv(6, () => (inv(7, () => (n < 2)) ? n : inv(8, () => (inv(9, () => fib(inv(10, () => (n - 1)))) + inv(11, () => fib(inv(12, () => (n - 2)))))))) }
`,
  // D0: one flag check at each outermost selectable expression of a statement.
  'D0: flag check per outermost expression': inv + `export function sum(n) {
  let s = 0
  for (let i = 0; S.a ? inv(1, () => (i < n)) : (i < n); i++) {
    s = S.a ? inv(2, () => (s + inv(3, () => (inv(4, () => (inv(5, () => (i % 3)) === 0)) ? i : 1)))) : (s + (i % 3 === 0 ? i : 1))
  }
  return s
}
export function fib(n) { return S.a ? inv(6, () => (inv(7, () => (n < 2)) ? n : inv(8, () => (inv(9, () => fib(inv(10, () => (n - 1)))) + inv(11, () => fib(inv(12, () => (n - 2)))))))) : (n < 2 ? n : fib(n - 1) + fib(n - 2)) }
`,
  // D1: one flag check per function call; the original body runs untouched.
  'D1: flag check per function call': inv + `export function sum(n) {
  if (!S.a) {
    let s = 0
    for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
    return s
  } else {
    let s = 0
    for (let i = 0; inv(1, () => (i < n)); i++) { s = inv(2, () => (s + inv(3, () => (inv(4, () => (inv(5, () => (i % 3)) === 0)) ? i : 1)))) }
    return s
  }
}
export function fib(n) {
  if (!S.a) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
  else { return inv(6, () => (inv(7, () => (n < 2)) ? n : inv(8, () => (inv(9, () => fib(inv(10, () => (n - 1)))) + inv(11, () => fib(inv(12, () => (n - 2)))))))) }
}
`,
}
// D1 with the flag in a typed array (what the plugin emits), and with the wrapped clone moved
// into an arrow so that the function itself stays small enough to inline.
const typed = `const F = new Uint8Array(3)\nconst inv = (id, f) => f()\n`
designs['D1 as emitted: Uint8Array flag, clone inline'] = typed + `export function sum(n) {
  if (!F[1]) {
    let s = 0
    for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
    return s
  } else {
    let s = 0
    for (let i = 0; inv(1, () => (i < n)); i++) { s = inv(2, () => (s + inv(3, () => (inv(4, () => (inv(5, () => (i % 3)) === 0)) ? i : 1)))) }
    return s
  }
}
export function fib(n) {
  if (!F[2]) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
  else { return inv(6, () => (inv(7, () => (n < 2)) ? n : inv(8, () => (inv(9, () => fib(inv(10, () => (n - 1)))) + inv(11, () => fib(inv(12, () => (n - 2)))))))) }
}
`
designs['D1b: Uint8Array flag, clone in an arrow'] = typed + `export function sum(n) {
  if (F[1]) return (() => {
    let s = 0
    for (let i = 0; inv(1, () => (i < n)); i++) { s = inv(2, () => (s + inv(3, () => (inv(4, () => (inv(5, () => (i % 3)) === 0)) ? i : 1)))) }
    return s
  })()
  let s = 0
  for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
  return s
}
export function fib(n) {
  if (F[2]) return (() => { return inv(6, () => (inv(7, () => (n < 2)) ? n : inv(8, () => (inv(9, () => fib(inv(10, () => (n - 1)))) + inv(11, () => fib(inv(12, () => (n - 2)))))))) })()
  return n < 2 ? n : fib(n - 1) + fib(n - 2)
}
`
const mk = (prelude, flag1, flag2) => prelude + `const inv = (id, f) => f()\n` + `export function sum(n) {
  if (!${flag1}) {
    let s = 0
    for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
    return s
  } else {
    let s = 0
    for (let i = 0; inv(1, () => (i < n)); i++) { s = inv(2, () => (s + inv(3, () => (inv(4, () => (inv(5, () => (i % 3)) === 0)) ? i : 1)))) }
    return s
  }
}
export function fib(n) {
  if (!${flag2}) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
  else { return inv(6, () => (inv(7, () => (n < 2)) ? n : inv(8, () => (inv(9, () => fib(inv(10, () => (n - 1)))) + inv(11, () => fib(inv(12, () => (n - 2)))))))) }
}
`
designs['D1: one object per function, read through the list'] = mk(`const F = [{ on: false }, { on: false }, { on: false }]\n`, 'F[1].on', 'F[2].on')
designs['D1: one object per function, held in its own const'] = mk(`const F = [{ on: false }, { on: false }, { on: false }]\nconst F1 = F[1], F2 = F[2]\n`, 'F1.on', 'F2.on')
designs['D1: plain array of numbers'] = mk(`const F = [0, 0, 0]\n`, 'F[1]', 'F[2]')
// What the plugin really emits: flags from a call, ids as strings, a capture thunk per expression.
const real = (flags, fibBody) => `const make = (n) => ${flags}\nconst F = make(3)\nconst inv = (id, f, c) => f()\n` + `export function sum(n) {
  if (!F[1]) {
    let s = 0
    for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }
    return s
  } else { return 0 }
}
export function fib(n) ${fibBody}
`
const wrappedFib = `inv("src/hot.ts#fib:ConditionalExpression:?:0", () => (inv("src/hot.ts#fib:BinaryExpression:<:0", () => (n < 2), () => ({["n"]: () => (n)})) ? n : inv("src/hot.ts#fib:BinaryExpression:+:0", () => (inv("src/hot.ts#fib:CallExpression:fib:0", () => (fib(inv("src/hot.ts#fib:BinaryExpression:-:0", () => (n - 1), () => ({["n"]: () => (n)})))), () => ({["n"]: () => (n)})) + inv("src/hot.ts#fib:CallExpression:fib:1", () => (fib(inv("src/hot.ts#fib:BinaryExpression:-:1", () => (n - 2), () => ({["n"]: () => (n)})))), () => ({["n"]: () => (n)}))), () => ({["n"]: () => (n)}))), () => ({["n"]: () => (n)}))`
designs['as emitted: packed flags from a call, full-size clone inline'] = real('Array.from({ length: n }, () => 0)', `{if(!F[2]){ return n < 2 ? n : fib(n - 1) + fib(n - 2) }else{ return ${wrappedFib} }}`)
designs['same, literal flags'] = real('[0, 0, 0]', `{if(!F[2]){ return n < 2 ? n : fib(n - 1) + fib(n - 2) }else{ return ${wrappedFib} }}`)
designs['same, full-size clone in an arrow'] = real('Array.from({ length: n }, () => 0)', `{if(F[2])return(()=>{ return ${wrappedFib} })(); return n < 2 ? n : fib(n - 1) + fib(n - 2) }`)
// Flag objects made by a call (as the runtime would make them), each held in its own const.
const fibWith = (flag) => `{if(!${flag}){ return n < 2 ? n : fib(n - 1) + fib(n - 2) }else{ return ${wrappedFib} }}`
const sumStub = (flag) => `export function sum(n) {\n  if (!${flag}) {\n    let s = 0\n    for (let i = 0; i < n; i++) { s = s + (i % 3 === 0 ? i : 1) }\n    return s\n  } else { return 0 }\n}\n`
designs['flag objects from a call, own const, never changed anywhere'] =
  `const make = (n) => Array.from({ length: n }, () => ({ on: false }))\nconst F = make(3)\nconst F1 = F[1], F2 = F[2]\nconst inv = (id, f, c) => f()\n` + sumStub('F1.on') + `export function fib(n) ${fibWith('F2.on')}\n`
designs['same, after another flag of the same shape was set'] =
  `const make = (n) => Array.from({ length: n }, () => ({ on: false }))\nconst F = make(3)\nconst F1 = F[1], F2 = F[2]\nF[0].on = true\nconst inv = (id, f, c) => f()\n` + sumStub('F1.on') + `export function fib(n) ${fibWith('F2.on')}\n`
designs['module-level let per function'] =
  `let F1 = false, F2 = false\nexport const arm = [() => { F1 = true }, () => { F2 = true }]\nconst inv = (id, f, c) => f()\n` + sumStub('F1') + `export function fib(n) ${fibWith('F2')}\n`
let design = 0
for (const [label, text] of Object.entries(designs)) {
  const file = join(dir, `design-${(design += 1)}.ts`); writeFileSync(file, text)
  const g = await import(pathToFileURL(file).href)
  const s = time(() => g.sum(2e6)), f = time(() => g.fib(27))
  console.log(`${label.padEnd(48)} sum ${s.toFixed(2)} ms (${(s / base.sum).toFixed(1)}x) | fib ${f.toFixed(2)} ms (${(f / base.fib).toFixed(1)}x)`)
}
