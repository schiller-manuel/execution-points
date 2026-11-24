// Probe (end to end, real tsc): what the compiler says about each thing a test can do with a
// selected point. The runtime checks none of this again, so the compiler's answer is the only one.
import { consumer } from './e2e.mjs'

const src = `declare const db: { get(key: string): Promise<number> }
declare const cache: { get(key: string): number | undefined }
export async function load(key: string) {
  const hit = cache.get(key)
  const row = await db.get(key)
  return hit ?? row
}
export function total(a: number, b: number) {
  return a + b
}
`
const head = `import { select, interleavings, InterleavingFailure } from 'execution-points-prototype'
const remote = select('src/app.ts', (n) => n.callee === 'get' && n.object === 'db' && n)
const local = select('src/app.ts', (n) => n.callee === 'get' && n.object === 'cache' && n)
const sum = select('src/app.ts', (n) => n.operator === '+' && n)
void remote, local, sum, interleavings, InterleavingFailure
`
const cases = {
  // Waiting needs a promise.
  'pause on a promise': `const gate = remote.pause()\nconst n: number = gate.run(() => 1)\ngate.release()\nconst c: number = gate.calls\nvoid n, c`,
  'pause on a number': `sum.pause()`,
  'pause on number | undefined': `local.pause()`,
  'resolves on a promise': `remote.resolves(7)`,
  'resolves on a number': `sum.resolves(7)`,
  'rejects on a number': `sum.rejects(new Error('x'))`,
  'interleavings of a promise point': `for (const order of interleavings([remote])) void order`,
  'interleavings of a number point': `for (const order of interleavings([sum])) void order`,
  'interleavings of something that only looks like a point': `for (const order of interleavings([{ pause: () => remote.pause() }])) void order`,
  // Values are typed by the expression.
  'returns the expression\'s type': `sum.returns(3)\nremote.returns(Promise.resolve(3))\nlocal.returns(undefined)`,
  'returns another type': `sum.returns('three')`,
  'returns a number where a promise is expected': `remote.returns(3)`,
  'resolves with another type': `remote.resolves('seven')`,
  'throws takes anything': `sum.throws(new Error('x'))\nsum.throws('text')`,
  'call is a number': `sum.withReplacement(({ call, original }) => { const c: number = call; void c; return original() }, () => 0)`,
  'call is not a string': `sum.withReplacement(({ call, original }) => { const c: string = call; void c; return original() }, () => 0)`,
  'the arrival has the captured locals': `const gate = select('src/app.ts', (n) => n.callee === 'get' && n.object === 'db' && n.capture('key')).pause()\ngate.run(async () => { const key: string = (await gate.reached).locals.key; void key })`,
  'the arrival has no other locals': `const gate = remote.pause()\ngate.run(async () => { void (await gate.reached).locals.key })`,
  // Options.
  'times and on as documented': `sum.returns(1, { times: 2 })\nsum.returns(1, { times: 0 })\nsum.returns(1, { times: 'any' })\nsum.returns(1, { on: 2 })\nsum.returns(1, { on: [1, 3] })\nsum.withReplacement(() => 1, () => 0, { times: 2, on: [1] })`,
  'times as a word': `sum.returns(1, { times: 'twice' })`,
  'on as a word': `sum.returns(1, { on: 'first' })`,
  'an option that does not exist': `sum.returns(1, { time: 2 })`,
  // Results.
  'withReplacement returns what the action returns': `const s: string = sum.withReplacement(() => 1, () => 'done')\nvoid s`,
  'withReplacement does not return something else': `const n: number = sum.withReplacement(() => 1, () => 'done')\nvoid n`,
  'order.run resolves to what the action resolves to': `for (const order of interleavings([remote])) { const s: string = await order.run(async () => 'done'); const plan: readonly number[] = order.schedule; const ids: readonly string[] = order.released; void s, plan, ids }`,
  'order.run does not resolve to something else': `for (const order of interleavings([remote])) { const n: number = await order.run(async () => 'done'); void n }`,
  'a replacement can be restored, counted and disposed': `const r = sum.returns(1)\nconst c: number = r.calls\nr.restore()\n{ using again = sum.replace(() => 2); void again }\nvoid c`,
  'a failure carries its schedule': `declare const failure: InterleavingFailure\nconst plan: readonly number[] = failure.schedule\nconst why: unknown = failure.cause\nvoid plan, why`,
  'a schedule and a chooser': `interleavings([remote], { schedule: [0, 1] })\ninterleavings([remote], { choose: (step, count, run) => (step + run) % count })`,
  'a schedule that is no list of numbers': `interleavings([remote], { schedule: '01' })`,
  // Arguments of the wrong kind: the runtime no longer looks.
  'a visitor that is a string': `select('src/app.ts', 'total')`,
  'a handler that is a value': `sum.withReplacement(1, () => 0)`,
  'an action that is a value': `sum.withReplacement(() => 1, 0)`,
  'replace with a value': `sum.replace(1)`,
  'pause.run with a value': `remote.pause().run(1)`,
  'points that are no list': `interleavings(remote)`,
  'order.run with a value': `for (const order of interleavings([remote])) await order.run(1)`,
}
let rejected = 0
for (const [label, body] of Object.entries(cases)) {
  const { status, out } = consumer({ 'src/app.ts': src, 'test/app.test.ts': head + body + '\n' }).tsc()
  const lines = out.trim().split('\n').filter(Boolean)
  const errors = lines.filter((l) => /error TS/.test(l))
  if (errors.length) rejected += 1
  console.log(`\n## ${label}  (tsc exit=${status}, ${errors.length} error(s))`)
  for (const l of lines.slice(0, 4)) console.log(`   ${l.length > 300 ? l.slice(0, 300) + ' …' : l}`)
}
console.log(`\n${Object.keys(cases).length} cases, ${rejected} rejected by the compiler`)
