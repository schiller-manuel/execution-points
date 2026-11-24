// Probe: withReplacement scopes by async context. When application code hands work to a shared
// worker (a drain loop, batcher, pool), whose replacement applies to whose work?
import { instrument, runtime } from './lib.mjs'

const source = `const queue = []
let draining = false
async function drain() {
  draining = true
  while (queue.length) {
    const job = queue.shift()
    job.resolve(await save(job.value))
  }
  draining = false
}
export function enqueue(value) {
  return new Promise((resolve) => {
    queue.push({ value, resolve })
    if (!draining) drain()
  })
}
async function save(value) { return 'saved:' + value }

// Same queue, but written as a promise chain instead of a drain loop.
let tail = Promise.resolve()
export function enqueueChained(value) {
  const run = tail.then(() => saveChained(value))
  tail = run.catch(() => {})
  return run
}
async function saveChained(value) { return 'saved:' + value }
`
const p = instrument({ 'src/queue.ts': source })
const { enqueue, enqueueChained } = await p.load('src/queue.ts')

for (const [label, fn, callee] of [['drain-loop queue', enqueue, 'save'], ['promise-chain queue', enqueueChained, 'saveChained']]) {
  const point = runtime.select('src/queue.ts', (n) => n.callee === callee && n)
  const replaced = () => Promise.resolve('REPLACED-BY-A')

  // 1. A runs inside a replacement scope, B does not. A is enqueued first.
  const a1 = point.withReplacement(replaced, () => fn('a'))
  const b1 = fn('b')
  const r1 = await Promise.all([a1, b1])
  // 2. Same two calls, B (no replacement) is enqueued first.
  const b2 = fn('b')
  const a2 = point.withReplacement(replaced, () => fn('a'))
  const r2 = await Promise.all([a2, b2])
  console.log(`## ${label}`)
  console.log(`  A (scoped) enqueued first  -> A got ${JSON.stringify(r1[0])}, B (unscoped) got ${JSON.stringify(r1[1])}`)
  console.log(`  B (unscoped) enqueued first -> A got ${JSON.stringify(r2[0])}, B (unscoped) got ${JSON.stringify(r2[1])}`)
}
