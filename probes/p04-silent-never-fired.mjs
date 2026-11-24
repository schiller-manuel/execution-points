// Probe: does anything tell a test that its replacement never ran?
import { instrument, runtime } from './lib.mjs'

const p = instrument({
  'src/app.ts': `export function price(vip, base) {\n  if (vip) return discount(base)\n  return base\n}\nfunction discount(n) { return n - 1 }\n`,
})
const { price } = await p.load('src/app.ts')
const point = runtime.select('src/app.ts', (n) => n.callee === 'discount' && n)

// 1. The action never reaches the selected expression.
let fired = 0
const result = point.withReplacement(() => { fired++; return 0 }, () => price(false, 10))
console.log(`action that never reaches the point -> result=${result}, handler fired ${fired} times, no error, nothing to assert on`)
console.log(`point handle exposes: ${JSON.stringify(Object.keys(point))}`)
