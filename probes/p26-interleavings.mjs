// Probe: `interleavings` on a cache with a race between a read and an update. The caller owns
// the loop: it prints each order and what the cache held afterwards, the failure a check inside
// `order.run` produces, a replay from a schedule, a sample, and the loud cases. Real plugin
// transform, real runtime.
import { instrument, runtime, show } from './lib.mjs'

const rel = 'src/profile.ts'
const { load } = instrument({
  [rel]: `
const store = new Map<string, string>()
const cache = new Map<string, string>()
async function readStore(id: string) { await Promise.resolve(); return store.get(id) ?? 'unknown' }
async function writeStore(id: string, name: string) { await Promise.resolve(); store.set(id, name) }
async function normalize(name: string) { await Promise.resolve(); return name.trim() }
export async function getProfile(id: string) {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const raw = await readStore(id)
  const name = await normalize(raw)
  cache.set(id, name)
  return name
}
export async function updateProfile(id: string, name: string) {
  await writeStore(id, name)
  cache.set(id, name)
}
export function reset() { store.clear(); cache.clear(); store.set('u1', 'Alice') }
export const cachedName = (id: string) => cache.get(id)
`,
})
const app = await load(rel)
const { interleavings, select } = runtime

const normalizing = select(rel, (n) => n.callee === 'normalize' && n)
const writing = select(rel, (n) => n.callee === 'writeStore' && n)
const reading = select(rel, (n) => n.callee === 'readStore' && n)

const readWhileUpdating = () => Promise.all([app.getProfile('u1'), app.updateProfile('u1', 'Bob')])
const short = (id) => id.replace(/^.*CallExpression:/, '')

console.log('## two updates, one point: the caller counts the orders and checks each')
let orders = 0
for (const order of interleavings([writing])) {
  app.reset()
  await order.run(() => Promise.all([app.updateProfile('u1', 'Bob'), app.updateProfile('u1', 'Bob')]))
  orders += 1
  show(`order ${orders}`, `schedule ${JSON.stringify(order.schedule)}, cache holds ${app.cachedName('u1')}`)
}

console.log('\n## a read and an update, points at normalize and writeStore: the check is the caller\'s')
for (const order of interleavings([normalizing, writing])) {
  app.reset()
  await order.run(readWhileUpdating)
  show(
    `schedule ${JSON.stringify(order.schedule)}`,
    `released ${order.released.map(short).join(', ')}; cache holds ${app.cachedName('u1')}`,
  )
}

console.log('\n## the same, with the check inside run: the failure names the order')
const failure = await (async () => {
  for (const order of interleavings([normalizing, writing])) {
    await order.run(async () => {
      app.reset()
      await readWhileUpdating()
      if (app.cachedName('u1') !== 'Bob') throw new Error(`the cache holds ${app.cachedName('u1')}`)
    })
  }
})().catch((error) => error)
console.log(failure.message)
show('is an InterleavingFailure', failure instanceof runtime.InterleavingFailure)
show('schedule', failure.schedule)
show('cause', failure.cause?.message)

console.log('\n## that schedule gives the order again, and only it')
let replays = 0
for (const order of interleavings([normalizing, writing], { schedule: failure.schedule })) {
  app.reset()
  await order.run(readWhileUpdating)
  replays += 1
  show('replay', `released ${order.released.map(short).join(', ')}; cache holds ${app.cachedName('u1')}`)
}
show('orders yielded', replays)

console.log('\n## three points: how many orders the same scenario has')
orders = 0
for (const order of interleavings([reading, normalizing, writing])) {
  app.reset()
  await order.run(readWhileUpdating)
  orders += 1
}
show('orders', orders)

console.log('\n## a sample of 4 orders picked by the caller')
const picked = []
const choose = (step, count, run) => {
  const pick = (run * 7 + step * 3) % count
  picked.push(`${run}:${step}->${pick}/${count}`)
  return pick
}
for (const order of interleavings([reading, normalizing, writing], { choose }).take(4)) {
  app.reset()
  await order.run(readWhileUpdating)
}
show('choices', picked.join(' '))

console.log('\n## a point no run reaches: the loop throws when the orders run out')
show(
  'error',
  await (async () => {
    for (const order of interleavings([writing])) {
      app.reset()
      await order.run(() => app.getProfile('u1'))
    }
    return 'the loop ended quietly'
  })().catch((error) => error.message),
)

console.log('\n## a run that waits on a timer')
for (const order of interleavings([writing])) {
  app.reset()
  show(
    'error',
    await order
      .run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        await app.updateProfile('u1', 'Bob')
      })
      .then(
        () => 'resolved',
        (error) => `${error.message}`,
      ),
  )
  break
}

console.log('\n## taking the next order before the current one ran')
const sequence = interleavings([writing])
sequence.next()
try {
  sequence.next()
} catch (error) {
  show('error', error.message)
}
