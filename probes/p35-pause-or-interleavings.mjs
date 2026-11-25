// Probe (end to end, real tsc and Vitest): the same race tested twice, once by pausing one
// operation and awaiting the other, once with interleavings(). Both tests are run against the
// module with the bug and against a fix that makes operations on one id wait for each other.
// What does each test say about the bug, and what about the fix?
import { consumer } from './e2e.mjs'

const head = `// A cache in front of a slow store.
const store = new Map<string, string>()
const cache = new Map<string, string>()

async function readStore(id: string) {
  await Promise.resolve()
  return store.get(id) ?? 'unknown'
}
async function writeStore(id: string, name: string) {
  await Promise.resolve()
  store.set(id, name)
}
async function normalize(name: string) {
  await Promise.resolve()
  return name.trim()
}
async function read(id: string) {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const raw = await readStore(id)
  const name = await normalize(raw)
  cache.set(id, name)
  return name
}
async function update(id: string, name: string) {
  await writeStore(id, name)
  cache.set(id, name)
}
export function reset() {
  store.clear()
  cache.clear()
  store.set('u1', 'Alice')
}
export const cachedName = (id: string) => cache.get(id)
`
const modules = {
  // An update that finishes while a read is in flight is overwritten by the read's old name.
  'the module with the bug': `${head}
export const getProfile = read
export const updateProfile = update
`,
  // Operations on one id run one after the other.
  'a fix that makes the operations wait for each other': `${head}
const tails = new Map<string, Promise<unknown>>()
function inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
  const mine = (tails.get(id) ?? Promise.resolve()).then(work)
  tails.set(id, mine.catch(() => undefined))
  return mine
}
export const getProfile = (id: string) => inTurn(id, () => read(id))
export const updateProfile = (id: string, name: string) => inTurn(id, () => update(id, name))
`,
}

const test = `import { expect, test } from 'vitest'
import { interleavings, select } from 'execution-points-prototype'
import { cachedName, getProfile, reset, updateProfile } from '../src/profile'

const normalizing = select('src/profile.ts', (n) => n.callee === 'normalize' && n)
const writing = select('src/profile.ts', (n) => n.callee === 'writeStore' && n)

test('pause: hold the read, let the update finish, release', async () => {
  reset()
  const pause = normalizing.pause()
  const reading = pause.run(() => getProfile('u1'))
  await pause.reached
  await updateProfile('u1', 'Bob')
  pause.release()
  await reading
  expect(cachedName('u1')).toBe('Bob')
})

test('interleavings: run both in every order the code allows', async () => {
  let orders = 0
  for (const order of interleavings([normalizing, writing])) {
    reset()
    await order.run(() => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')]))
    orders += 1
    expect(cachedName('u1'), \`in order \${orders}, schedule \${JSON.stringify(order.schedule)}\`).toBe('Bob')
  }
  console.log('orders run: ' + orders)
})
`
const config = `import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'
export default defineConfig({
  plugins: [executionPoints({ targets: ['src/**/*.ts'], root: import.meta.dirname })],
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 1500, setupFiles: ['execution-points-prototype/vitest'] },
})
`
for (const [label, source] of Object.entries(modules)) {
  const project = consumer({ 'src/profile.ts': source, 'test/profile.test.ts': test, 'vitest.config.mjs': config })
  const compiled = project.tsc()
  const ran = project.vitest()
  console.log(`\n## ${label}`)
  console.log(`   tsc exit=${compiled.status}${compiled.out.trim() ? `\n   ${compiled.out.trim().split('\n').slice(0, 3).join('\n   ')}` : ''}`)
  const lines = ran.out
    .split('\n')
    .filter((line) => /^\s*(✓|×|✗|FAIL)|orders run|AssertionError|Test timed out|\[execution-points\]|Tests\s/.test(line))
    .map((line) => line.replace(/\s+\d+(\.\d+)?\s*ms$/, '').trim())
  console.log(`   vitest exit=${ran.status}\n   ${[...new Set(lines)].slice(0, 12).join('\n   ')}`)
}
