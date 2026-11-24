// Probe: runtime semantics a test author could trip over (captures in the temporal dead zone,
// calling original() late or twice, async handler on a sync point from untyped code).
import { instrument, runtime } from './lib.mjs'

const p = instrument({
  'src/app.ts': `export function early() {
  const r = peek()          // runs before "limit" is initialized
  const limit = 5
  function peek() { return compute(1) }
  return r + limit
}
function compute(n) { return n * 2 }

let counter = 0
export function next() { return bump() }
function bump() { return ++counter }
export function ordered(log) { return first(log) + second(log) }
function first(log) { log.push('first'); return 1 }
function second(log) { log.push('second'); return 2 }
`,
})
const app = await p.load('src/app.ts')
const ids = (callee) => runtime.select('src/app.ts', (n) => n.callee === callee && n)

// 1. A local that discovery offers for capture but that is still uninitialized when the point runs.
const descriptor = []
runtime.select('src/app.ts', (n) => { if (n.callee === 'compute') descriptor.push(n.id); return n.callee === 'compute' && n })
try {
  const out = ids('compute').capture('limit').withReplacement(({ locals }) => locals.limit, () => app.early())
  console.log(`capture('limit') at compute(1): handler saw ${out}`)
} catch (error) {
  console.log(`capture('limit') at compute(1) -> ${error.constructor.name}: ${error.message}   (without the capture, early() returns ${app.early()})`)
}

// 2. original() twice, and original() after the scope has ended.
let kept
const twice = ids('bump').withReplacement(({ original }) => { kept = original; return original() + original() }, () => app.next())
console.log(`original() + original() -> ${twice} (two evaluations: 1 + 2)`)
console.log(`original() called after withReplacement returned -> ${kept()} (still evaluates the expression)`)

// 3. Evaluation order when a later sibling is replaced: is the earlier sibling still evaluated first?
const log = []
const sum = ids('second').withReplacement(() => { log.push('handler'); return 20 }, () => app.ordered(log))
console.log(`first(log) + second(log) with second replaced -> ${sum}, order: ${log.join(' > ')}`)

// 4. Async handler on a synchronous point (the type system rejects this only for void results).
const leaked = ids('bump').withReplacement(async () => 7, () => app.next())
console.log(`async handler on a sync number point -> application received ${Object.prototype.toString.call(leaked)}`)
