// Probe: does anything tell a test that its replacement never ran?
import { instrument, runtime } from './lib.mjs'

const p = instrument({
  'src/app.ts': `export function price(vip, base) {\n  if (vip) return discount(base)\n  return base\n}\nfunction discount(n) { return n - 1 }\nexport async function priceLater(vip, base) { await null; return price(vip, base) }\n`,
})
const { price, priceLater } = await p.load('src/app.ts')
const point = runtime.select('src/app.ts', (n) => n.callee === 'discount' && n)
const attempt = (label, run) => {
  try {
    console.log(`${label} -> returned ${JSON.stringify(run())}`)
  } catch (error) {
    console.log(`${label} -> threw: ${error.message}`)
  }
}

// 1. A synchronous action that never reaches the selected expression.
attempt('synchronous action, expression never reached', () => point.withReplacement(() => 0, () => price(false, 10)))
attempt("same, with { times: 'any' }", () => point.withReplacement(() => 0, () => price(false, 10), { times: 'any' }))
attempt('same, asserting it is not reached with { times: 0 }', () => point.withReplacement(() => 0, () => price(false, 10), { times: 0 }))
attempt('{ times: 0 } when it IS reached', () => point.withReplacement(() => 0, () => price(true, 10), { times: 0 }))

// 2. An asynchronous action: the promise is the action's own; the check happens when the test ends.
const pending = point.withReplacement(() => 0, () => priceLater(false, 10))
console.log(`asynchronous action, expression never reached -> resolved with ${await pending}`)
attempt('...and the check a test runner makes after the test', () => runtime.verifyReplacements())

// 3. A replacement that applies everywhere and is never used.
const unused = point.returns(0)
attempt('point.returns(0), never used, restored', () => unused.restore())
console.log(`point handle exposes: ${JSON.stringify(Object.keys(point))}, calls so far: ${point.calls}`)
