// Probe: for common application shapes, does a replacement installed around the test's call
// reach the application code that does the work? "outside" means the work ran in an async
// context that the withReplacement scope does not cover.
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { instrument, runtime } from './lib.mjs'

const p = instrument({
  'src/app.ts': `export function compute(label) { return 'real:' + label }
export const handle = (label) => compute(label)
`,
})
const app = await p.load('src/app.ts')
const point = runtime.select('src/app.ts', (n) => n.callee === 'compute' && n)
const replaced = () => 'REPLACED'
const rows = []
const record = (shape, startedWhere, result) => rows.push([shape, startedWhere, String(result).startsWith('REPLACED') ? 'replacement applies' : 'NOT applied (ran real code)'])

// 1. HTTP server: the usual integration test starts the app once, then each test calls it.
const serve = () => new Promise((resolve) => { const s = createServer((req, res) => res.end(app.handle('http'))); s.listen(0, () => resolve(s)) })
const call = async (s) => (await fetch(`http://127.0.0.1:${s.address().port}/`)).text()
{
  const server = await serve() // started outside the scope, e.g. in beforeAll
  record('HTTP request handler', 'server started before the scope (beforeAll)', await point.withReplacement(replaced, () => call(server)))
  server.close()
  const inner = await point.withReplacement(replaced, async () => { const s = await serve(); const r = await call(s); s.close(); return r })
  record('HTTP request handler', 'server started inside the scope', inner)
}

// 2. Event listener registered at startup, event emitted by the test's call.
{
  const bus = new EventEmitter(); let last
  bus.on('job', (label) => { last = app.handle(label) })
  point.withReplacement(replaced, () => bus.emit('job', 'event'))
  record('EventEmitter listener (sync emit)', 'listener registered before the scope', last)
}

// 3. Interval / polling loop started at startup, work queued by the test's call.
{
  const pending = []; const done = []
  const timer = setInterval(() => { while (pending.length) done.push(app.handle(pending.shift())) }, 1)
  await point.withReplacement(replaced, async () => { pending.push('poll'); while (!done.length) await new Promise((r) => setTimeout(r, 2)) })
  clearInterval(timer)
  record('polling loop (setInterval)', 'loop started before the scope', done[0])
}

// 4. Batcher in the style of a data loader: first caller schedules the flush.
{
  let batch = null
  const load = (label) => new Promise((resolve) => {
    if (!batch) { batch = []; process.nextTick(() => { const b = batch; batch = null; for (const j of b) j.resolve(app.handle(j.label)) }) }
    batch.push({ label, resolve })
  })
  const first = load('batch-a')                                         // unscoped caller opens the batch
  const second = point.withReplacement(replaced, () => load('batch-b')) // scoped caller joins it
  record('batcher (flush scheduled by first caller)', 'scoped call joins an open batch', (await Promise.all([first, second]))[1])
}

// 5. Mutex with a waiter list: the waiter resumes its own async function.
{
  let locked = false; const waiters = []
  const withLock = async (fn) => { if (locked) await new Promise((r) => waiters.push(r)); locked = true; try { return await fn() } finally { locked = false; waiters.shift()?.() } }
  const first = withLock(async () => { await new Promise((r) => setTimeout(r, 5)); return app.handle('lock-a') })
  const second = point.withReplacement(replaced, () => withLock(async () => app.handle('lock-b')))
  record('mutex with waiter list', 'scoped call waits behind an unscoped one', (await Promise.all([first, second]))[1])
}

// 6. Callback stored at startup and invoked by the test's call.
{
  const registry = new Map(); registry.set('x', (label) => app.handle(label))
  record('callback registered before the scope, called inside it', 'handler table', point.withReplacement(replaced, () => registry.get('x')('table')))
}

for (const [shape, where, verdict] of rows) console.log(`${shape.padEnd(52)} | ${where.padEnd(44)} | ${verdict}`)

// The same three shapes that a scope does not cover, with a replacement that applies everywhere.
console.log('\nwith `using r = point.replace(handler)` instead of a scope:')
{
  const server = await serve()
  {
    using r = point.replace(replaced)
    console.log(`  HTTP request handler, server started earlier       -> ${await call(server)}`)
  }
  server.close()
}
{
  const pending = []; const done = []
  const timer = setInterval(() => { while (pending.length) done.push(app.handle(pending.shift())) }, 1)
  {
    using r = point.replace(replaced)
    pending.push('poll')
    while (!done.length) await new Promise((r2) => setTimeout(r2, 2))
  }
  clearInterval(timer)
  console.log(`  polling loop started earlier                        -> ${done[0]}`)
}
process.exit(0)
