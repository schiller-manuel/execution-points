// Probe: `interleavings` on a cache with a race between a read and an update. Prints how many
// orders the search ran, the error for the order that loses the update, and what a replay of
// that order's `schedule` does. Real plugin transform, real runtime.
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

const scenario = {
  setup: app.reset,
  run: () => Promise.all([app.getProfile('u1'), app.updateProfile('u1', 'Bob')]),
  check: () => {
    if (app.cachedName('u1') !== 'Bob') throw new Error(`the cache holds ${app.cachedName('u1')}`)
  },
}

console.log('## two updates, one point: every order holds')
show(
  'report',
  await interleavings({
    points: [writing],
    setup: app.reset,
    run: () => Promise.all([app.updateProfile('u1', 'Bob'), app.updateProfile('u1', 'Bob')]),
    check: scenario.check,
  }),
)

console.log('\n## a read and an update, points at normalize and writeStore')
const failure = await interleavings({ ...scenario, points: [normalizing, writing] }).then(
  (report) => report,
  (error) => error,
)
console.log(failure.message)
show('schedule', failure.schedule)
show('cause', failure.cause?.message)

console.log('\n## replaying that schedule')
show(
  'replay',
  await interleavings({ ...scenario, points: [normalizing, writing], schedule: failure.schedule }).then(
    () => 'passed',
    (error) => `failed again: ${error.cause?.message}`,
  ),
)

console.log('\n## three points: how many orders the same scenario has')
show(
  'report',
  await interleavings({ ...scenario, points: [reading, normalizing, writing], check: () => {} }),
)

console.log('\n## a sample of 4 orders picked by the caller')
const picked = []
show(
  'report',
  await interleavings({
    ...scenario,
    points: [reading, normalizing, writing],
    check: () => {},
    limit: 4,
    choose: (step, count, run) => {
      const pick = (run * 7 + step * 3) % count
      picked.push(`${run}:${step}->${pick}/${count}`)
      return pick
    },
  }),
)
show('choices', picked.join(' '))

console.log('\n## a point no run reaches')
show(
  'error',
  await interleavings({
    points: [writing],
    setup: app.reset,
    run: () => app.getProfile('u1'),
  }).then(
    () => 'returned',
    (error) => error.message,
  ),
)

console.log('\n## a run that waits on a timer')
show(
  'error',
  await interleavings({
    points: [writing],
    setup: app.reset,
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await app.updateProfile('u1', 'Bob')
    },
  }).then(
    () => 'returned',
    (error) => `${error.message}\n  cause: ${error.cause?.message}`,
  ),
)
