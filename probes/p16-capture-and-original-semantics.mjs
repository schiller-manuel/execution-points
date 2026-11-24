// Probe: runtime semantics a test author could trip over (captures in the temporal dead zone,
// calling original() late or twice, async handler on a sync point from untyped code).
import { discovery, instrument, runtime } from './lib.mjs'

const source = `export function early() {
  const r = peek()          // runs before "limit" is initialized
  const limit = 5
  function peek() { return compute(1) }
  return r + limit
}
function compute(n) { return n * 2 }

export function route(k) {
  const a = 'outer'
  switch (k) {
    case 0: return send(k)   // the "let a" of case 1 is in the same switch scope, uninitialized here
    case 1: { }
    default: let a = 1; return a
  }
}
function send(k) { return k }

let counter = 0
export function next() { return bump() }
function bump() { return ++counter }
export function ordered(log) { return first(log) + second(log) }
function first(log) { log.push('first'); return 1 }
function second(log) { log.push('second'); return 2 }
`
const p = instrument({ 'src/app.ts': source })
const app = await p.load('src/app.ts')
const ids = (callee) => runtime.select('src/app.ts', (n) => n.callee === callee && n)

// 1. Captures in the temporal dead zone (F14, fixed). `limit` is declared before `peek` is, but
//    `peek` is called first; in `route`, a later case declares an `a` of its own. Discovery offers
//    neither, and every capture it does offer can be read when the point runs.
const offered = new Map(
  discovery.indexTargetFile(`${p.root}/src/app.ts`, source, p.root).nodes.map((n) => [n.callee, n.captures]),
)
for (const [callee, run] of [['compute', () => app.early()], ['send', () => app.route(0)]]) {
  const names = offered.get(callee)
  try {
    let seen
    const result = ids(callee).capture(...names).withReplacement(({ locals, original }) => { seen = Object.keys(locals); return original() }, run)
    console.log(`${callee}(...): captures offered ${JSON.stringify(names)} -> read inside the call: ${JSON.stringify(seen)}, and the function still returns ${JSON.stringify(result)}`)
  } catch (error) {
    console.log(`${callee}(...): captures offered ${JSON.stringify(names)} -> ${error.constructor.name}: ${error.message}`)
  }
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
