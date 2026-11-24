// Probe (end to end, real Vitest + real plugin): shapes where "run the original statements until
// a replacement is installed for the file" could change behavior. Each test states the behavior
// the README promises: a replacement applies exactly to evaluations inside its scope.
import { consumer, tail } from './e2e.mjs'

const src = `
export const log: string[] = []
function note(label: string) { log.push(label); return label }

// statement that ends without a semicolon, followed by a call statement
export function asi() {
  const a = note
  note('asi')
  return a
}

export function plain(x: number) { return twice(x) + 1 }
function twice(x: number) { return x * 2 }

export const arrow = (x: number) => twice(x)
export function withDefault(x = twice(5)) { return x }

export class Base { constructor(public seed: number) {} }
export class Counter extends Base {
  step = twice(1)
  static made = twice(0)
  constructor(private extra: number) { super(twice(extra)); note('ctor') }
  get value() { return twice(this.seed) }
  set value(v: number) { this.seed = twice(v) }
  bump(by = twice(1)) { return this.seed + by + this.extra }
  static { Counter.made = twice(3) }
}

export function* steps() { yield twice(1); yield twice(2) }
export async function slow(wait: Promise<void>) { const a = twice(1); await wait; return a + twice(1) }
export function makeCallback() { return (x: number) => twice(x) }
export function nested(xs: number[]) { return xs.map((x) => [x].map((y) => twice(y))[0]) }
export function recursive(n: number): number { return n <= 0 ? 0 : twice(1) + recursive(n - 1) }
export function usesArguments(a: number, b: number) { return arguments.length + twice(a) + b }
export const obj = { method(x: number) { return twice(x) }, get prop() { return twice(4) } }
export function labeled(xs: number[]) { let s = 0; outer: for (const x of xs) { if (x < 0) continue outer; s += twice(x) } return s }
export function tryFinally(x: number) { try { return twice(x) } finally { note('finally') } }
export function overloaded(x: number): number
export function overloaded(x: string): string
export function overloaded(x: any) { return typeof x === 'number' ? twice(x) : x }
export default function (x: number) { return twice(x) }
`
const test = `import { beforeEach, expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import anon, * as app from '../src/app'

// every twice(...) call in the file, by nth within its function
const twiceIn = (fn: string | null, nth = 0) => select('src/app.ts', (n: any) => n.callee === 'twice' && n.inFunction === fn && n.nth === nth && n) as any
const ten = () => 10
beforeEach(() => { app.log.length = 0 })

test('1 before any replacement, everything behaves as written', async () => {
  expect(app.asi()).toBeTypeOf('function'); expect(app.log).toEqual(['asi'])
  expect(app.plain(2)).toBe(5); expect(app.arrow(3)).toBe(6); expect(app.withDefault()).toBe(10)
  const c = new app.Counter(2); expect([c.seed, c.step, c.value, c.bump(), app.Counter.made]).toEqual([4, 2, 8, 8, 6])
  c.value = 3; expect(c.seed).toBe(6)
  expect([...app.steps()]).toEqual([2, 4])
  expect(await app.slow(Promise.resolve())).toBe(4)
  expect(app.nested([1, 2])).toEqual([2, 4]); expect(app.recursive(3)).toBe(6); expect(app.usesArguments(1, 2)).toBe(6)
  expect([app.obj.method(2), app.obj.prop]).toEqual([4, 8]); expect(app.labeled([1, -1, 2])).toBe(6)
  expect(app.tryFinally(2)).toBe(4); expect(app.log).toContain('finally')
  expect([app.overloaded(2), app.overloaded('s')]).toEqual([4, 's']); expect(anon(2)).toBe(4)
})

// These start BEFORE the first replacement is installed anywhere in this file.
const earlyGenerator = app.steps()
const earlyCallback = app.makeCallback()
let releaseEarly!: () => void
const earlyAsync = app.slow(new Promise<void>((r) => { releaseEarly = r }))

test('2 a generator started earlier is replaced when it resumes inside a scope', () => {
  expect(twiceIn('steps', 0).withReplacement(ten, () => earlyGenerator.next().value)).toBe(10)
  expect(earlyGenerator.next().value).toBe(4)
})
test('3 a callback created earlier is replaced when called inside a scope, and only there', () => {
  expect(twiceIn('makeCallback').withReplacement(ten, () => earlyCallback(1))).toBe(10)
  expect(earlyCallback(1)).toBe(2)
})
test('4 an async call that began outside any scope is not replaced when it continues', async () => {
  // The replacement must not run: the call began before the scope did. `times: 0` says so.
  const result = twiceIn('slow', 1).withReplacement(ten, () => { releaseEarly(); return earlyAsync }, { times: 0 })
  expect(await result).toBe(4)
})
test('5 an async call that begins inside a scope is replaced after its await', async () => {
  expect(await twiceIn('slow', 1).withReplacement(ten, () => app.slow(Promise.resolve()))).toBe(12)
})
test('6 each position is replaceable inside a scope and untouched outside it', () => {
  expect(twiceIn('plain').withReplacement(ten, () => app.plain(2))).toBe(11); expect(app.plain(2)).toBe(5)
  expect(twiceIn('arrow').withReplacement(ten, () => app.arrow(3))).toBe(10); expect(app.arrow(3)).toBe(6)
  expect(twiceIn('withDefault').withReplacement(ten, () => app.withDefault())).toBe(10); expect(app.withDefault()).toBe(10)
  expect(twiceIn('constructor').withReplacement(ten, () => new app.Counter(2).seed)).toBe(10)
  expect(twiceIn('value', 0).withReplacement(ten, () => new app.Counter(2).value)).toBe(10)
  expect(twiceIn('bump').withReplacement(ten, () => new app.Counter(2).bump())).toBe(4 + 10 + 2)
  expect(twiceIn('nested').withReplacement(ten, () => app.nested([1, 2]))).toEqual([10, 10])
  expect(twiceIn('recursive').withReplacement(ten, () => app.recursive(3))).toBe(30)
  expect(twiceIn('usesArguments').withReplacement(ten, () => app.usesArguments(1, 2))).toBe(14)
  expect(twiceIn('method').withReplacement(ten, () => app.obj.method(2))).toBe(10)
  expect(twiceIn('prop').withReplacement(ten, () => app.obj.prop)).toBe(10)
  expect(twiceIn('labeled').withReplacement(ten, () => app.labeled([1, -1, 2]))).toBe(20)
  expect(twiceIn('tryFinally').withReplacement(ten, () => app.tryFinally(2))).toBe(10)
  expect(twiceIn('overloaded').withReplacement(ten, () => app.overloaded(2))).toBe(10)
  expect(new app.Counter(2).bump()).toBe(8); expect(app.recursive(3)).toBe(6); expect(app.asi()).toBeTypeOf('function')
})
test('7 a field initializer and a default-exported function are replaceable', () => {
  const init = select('src/app.ts', (n: any) => n.callee === 'twice' && n.inFunction === null && n.nth === 0 && n) as any
  expect(init.withReplacement(ten, () => new app.Counter(2).step)).toBe(10)
  const anonPoint = select('src/app.ts', (n: any) => n.callee === 'twice' && n.inFunction === '(anonymous)' && n) as any
  expect(anonPoint.withReplacement(ten, () => anon(2))).toBe(10); expect(anon(2)).toBe(4)
})
`
const c = consumer({ 'src/app.ts': src, 'test/app.test.ts': test })
const v = c.vitest()
console.log(`vitest exit=${v.status}`)
console.log(v.out.split('\n').filter((l) => /✓|✗|×|Tests |FAIL|Error|expected|rror:/.test(l)).slice(0, 30).join('\n'))
