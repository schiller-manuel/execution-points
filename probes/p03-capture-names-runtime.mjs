// Probe: what does the runtime do with capture names that are not locals at the point?
import { instrument, runtime } from './lib.mjs'

const p = instrument({
  'src/app.ts': `export function invoice(base) {\n  const fee = 3\n  return base + fee\n}\n`,
})
const { invoice } = await p.load('src/app.ts')

const names = ['fee', 'nope', 'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']
for (const name of names) {
  const point = runtime.select('src/app.ts', (n) => n.operator === '+' && n).capture(name)
  let seen
  try {
    point.withReplacement(({ locals }) => { seen = locals[name]; return 0 }, () => invoice(10))
    console.log(`capture(${JSON.stringify(name)}) -> locals value: ${typeof seen === 'object' ? JSON.stringify(seen) : String(seen)} (${typeof seen})`)
  } catch (error) {
    console.log(`capture(${JSON.stringify(name)}) -> threw ${error.constructor.name}: ${error.message}`)
  }
}

// What the runner's check after the test reports for the last of them.
try {
  runtime.verifyReplacements()
  console.log('verifyReplacements() -> nothing to report')
} catch (error) {
  console.log(`verifyReplacements() -> ${error.constructor.name}: ${(error.errors ?? [error]).length} problem(s), first: ${(error.errors ?? [error])[0].message}`)
}

// Visitor mistakes a JS-only (or `any`-typed) caller can make:
for (const [label, visitor] of Object.entries({
  'returns true instead of the node': (n) => n.operator === '+',
  'returns a plain object with an id': () => ({ id: 'whatever' }),
})) {
  try {
    const point = runtime.select('src/app.ts', visitor)
    let fired = false
    const result = point.withReplacement(() => { fired = true; return 0 }, () => invoice(10), { times: 'any' })
    console.log(`visitor ${label} -> no error; handler fired=${fired}; invoice(10)=${result}`)
  } catch (error) {
    console.log(`visitor ${label} -> ${error.message}`)
  }
}
