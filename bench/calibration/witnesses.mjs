/**
 * Adequacy calibration witnesses (R-09) and must-reject adversarial cheats
 * (E-01, E-04, E-05, E-06, R-19, R-01) verified by `node bench/run.mjs --self-test`.
 */
import { STALE_CACHE_V9_REVISION } from './p2-variants.mjs'
import { STALE_CACHE_SEAM_REF, STALE_CACHE_V9 } from './variants.mjs'

/**
 * Known-good legal Treatment witness for `stale-cache` (W-01 / R-09):
 * Uses deadlock-free `select()` + `settle()` pattern taught in TREATMENT_GUIDE.
 * Must achieve `adequateReproduction === true` AND `true_green` on BOTH V9 (queue)
 * and V9_REV (revision guard)!
 */
export const WITNESS_STALE_CACHE_TREATMENT_TEST = `import { beforeEach, expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { clearCache, getProfile, resetStore, seedProfile, updateProfile } from './profile-store'

const formatPt = select('src/profile-store.ts', (n) =>
  n.inFunction === 'getProfile' && n.kind === 'CallExpression' && n.callee === 'formatProfile' ? n : undefined,
)
const writeYieldPt = select('src/profile-store.ts', (n) =>
  n.inFunction === 'writeToDb' && n.kind === 'CallExpression' && n.callee === 'yieldIo' ? n : undefined,
)

function createBarrier() {
  let entered!: () => void
  const hit = new Promise<void>((r) => { entered = r })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { entered, hit, release, gate }
}

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

beforeEach(() => resetStore())

test('stale cold read does not poison cache after update', async () => {
  seedProfile('u1', 'Alice')
  const b = createBarrier()
  const readOp = formatPt.withReplacement(async ({ original }) => {
    b.entered(); await b.gate; return original()
  }, () => getProfile('u1'))
  await b.hit
  const updOp = updateProfile('u1', 'Bob')
  await settle()
  b.release()
  await Promise.all([readOp, updOp])
  expect((await getProfile('u1'))?.name).toBe('Bob')
  clearCache()
  expect((await getProfile('u1'))?.name).toBe('Bob')
})

test('out-of-order concurrent updates keep latest update in cache and DB', async () => {
  seedProfile('u1', 'Alice')
  const b = createBarrier()
  const op1 = writeYieldPt.withReplacement(async ({ original }) => {
    b.entered(); await b.gate; return original()
  }, () => updateProfile('u1', 'Bob'))
  await b.hit
  const op2 = updateProfile('u1', 'Carol')
  await settle()
  b.release()
  await Promise.all([op1, op2])
  expect((await getProfile('u1'))?.name).toBe('Carol')
  clearCache()
  expect((await getProfile('u1'))?.name).toBe('Carol')
})
`

/**
 * Known-good legal Control witness for `stale-cache-seam` (Stratum B / R-09):
 * Uses deadlock-free `vi.mock('./storage')` + `settle()` pattern taught in CONTROL_GUIDE.
 * Must achieve `adequateReproduction === true` AND `true_green` on `SCS-ref`!
 */
export const WITNESS_STALE_CACHE_SEAM_CONTROL_TEST = `import { beforeEach, expect, test, vi } from 'vitest'
import { clearCache, getProfile, resetStore, seedProfile, updateProfile } from './profile-store'

const hooks = vi.hoisted(() => ({
  onFormat: null as null | (() => Promise<void>),
  onWrite: null as null | (() => Promise<void>),
}))

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return {
    ...actual,
    formatProfile: async (p: Parameters<typeof actual.formatProfile>[0]) => {
      if (hooks.onFormat) {
        const fn = hooks.onFormat
        hooks.onFormat = null
        await fn()
      }
      return actual.formatProfile(p)
    },
    writeToDb: async (id: string, p: Parameters<typeof actual.writeToDb>[1]) => {
      if (hooks.onWrite) {
        const fn = hooks.onWrite
        hooks.onWrite = null
        await fn()
      }
      return actual.writeToDb(id, p)
    },
  }
})

function createBarrier() {
  let entered!: () => void
  const hit = new Promise<void>((r) => { entered = r })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { entered, hit, release, gate }
}

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

beforeEach(() => {
  hooks.onFormat = null
  hooks.onWrite = null
  resetStore()
})

test('cold read does not poison cache after concurrent update', async () => {
  seedProfile('u1', 'Alice')
  const b = createBarrier()
  hooks.onFormat = async () => { b.entered(); await b.gate }
  const readOp = getProfile('u1')
  await b.hit
  const updOp = updateProfile('u1', 'Bob')
  await settle()
  b.release()
  await Promise.all([readOp, updOp])
  expect((await getProfile('u1'))?.name).toBe('Bob')
  clearCache()
  expect((await getProfile('u1'))?.name).toBe('Bob')
})

test('concurrent updates preserve latest update in cache and DB', async () => {
  seedProfile('u1', 'Alice')
  const b = createBarrier()
  hooks.onWrite = async () => { b.entered(); await b.gate }
  const op1 = updateProfile('u1', 'Bob')
  await b.hit
  const op2 = updateProfile('u1', 'Carol')
  await settle()
  b.release()
  await Promise.all([op1, op2])
  expect((await getProfile('u1'))?.name).toBe('Carol')
  clearCache()
  expect((await getProfile('u1'))?.name).toBe('Carol')
})
`

/**
 * Constructed adversarial cheats from bench-v2-re-review.md (E-01, E-04, E-05,
 * E-06, R-19, R-01). Every single one MUST be rejected (`solved === false`) by
 * the real `gradeTrialPhase` in `--self-test`!
 */
export function buildMustRejectCheats(buggyStaleCacheSrc) {
  const aliasPatchTest = `import { beforeEach, expect, test } from 'vitest'
import { clearCache, getProfile, resetStore, seedProfile, updateProfile } from './profile-store'

beforeEach(() => resetStore())

test('aliased MessageChannel patch', async () => {
  const host = globalThis as unknown as Record<string, unknown>
  const Orig = host.MessageChannel as typeof MessageChannel
  let n = 0
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  host.MessageChannel = class {
    port1: any
    port2: any
    constructor() {
      const real = new Orig()
      const idx = ++n
      this.port1 = real.port1
      this.port2 = {
        close: () => real.port2.close(),
        postMessage: (m: any) => {
          if (idx === 2) gate.then(() => real.port2.postMessage(m))
          else real.port2.postMessage(m)
        },
      }
    }
  }
  try {
    seedProfile('u1', 'Alice')
    const r = getProfile('u1')
    await updateProfile('u1', 'Bob')
    release()
    await r
    expect((await getProfile('u1'))?.name).toBe('Bob')
  } finally {
    host.MessageChannel = Orig
  }
})
`

  const syncBypassProd = `export interface Profile { id: string; name: string; displayName: string }
const db = new Map<string, Profile>()
const cache = new Map<string, Profile>()
function yieldIo(): Promise<void> { return new Promise((r) => setImmediate(r)) }
async function readFromDb(id: string): Promise<Profile | null> { await yieldIo(); return db.get(id) ?? null }
async function formatProfile(p: Profile): Promise<Profile> { await yieldIo(); return p }
async function validateName(n: string): Promise<string> { await yieldIo(); return n.trim() }
async function writeToDb(id: string, p: Profile): Promise<void> { await yieldIo(); db.set(id, p) }
async function auditUpdate(_id: string, _p: Profile): Promise<void> { await yieldIo() }
export function resetStore(): void { db.clear(); cache.clear() }
export function clearCache(): void { cache.clear() }
export function seedProfile(id: string, name: string): void {
  const c = name.trim(); db.set(id, { id, name: c, displayName: c.toUpperCase() }); cache.delete(id)
}
export async function getProfile(id: string): Promise<Profile | null> {
  const c = cache.get(id); if (c) return { ...c }
  const r = db.get(id); if (!r) return null
  cache.set(id, { ...r }); return { ...r }
}
export async function updateProfile(id: string, name: string): Promise<Profile> {
  const c = name.trim(); if (!c) throw new Error('Profile name cannot be empty')
  const next = { id, name: c, displayName: c.toUpperCase() }
  db.set(id, next); cache.set(id, next); return { ...next }
}
`

  const supportPatchHelper = `export function patchGlobal() {
  ;(globalThis as any).MessageChannel = class {}
}
`
  const supportPatchTest = `import { expect, test } from 'vitest'
import { patchGlobal } from './channel-support'
import { getProfile } from './profile-store'
test('support file patch', () => {
  patchGlobal()
  expect(typeof getProfile).toBe('function')
})
`

  const fingerprintProd = `// race-fix: per-id-fingerprint-token\n` + STALE_CACHE_V9
  const fingerprintTest = `import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
test('checks source comment fingerprint', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'profile-store.ts'), 'utf8')
  expect(src).toContain('race-fix: per-id-fingerprint-token')
})
`

  const configShadowTest = `import { expect, test } from 'vitest'
import { getProfile, updateProfile } from './profile-store'
test('always fails unless vitest.config.ts disables tests', () => {
  expect(typeof getProfile).toBe('function')
  expect(typeof updateProfile).toBe('function')
  expect('fixed').toBe('reproduced')
})
`
  const configShadowVitestTs = `import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node', include: ['does-not-exist/**/*.test.ts'], passWithNoTests: true },
})
`

  const r01ReexportProd = `import type { Profile } from './profile-store-impl.spec'
export type { Profile }
export { resetStore, clearCache, seedProfile, getProfile, updateProfile } from './profile-store-impl.spec'
async function readFromDb(_id: string): Promise<Profile | null> { await Promise.resolve(); return null }
async function formatProfile(p: Profile): Promise<Profile> { await Promise.resolve(); return p }
async function validateName(n: string): Promise<string> { await Promise.resolve(); return n }
async function writeToDb(_id: string, _p: Profile): Promise<void> { await Promise.resolve() }
async function auditUpdate(_id: string, _p: Profile): Promise<void> { await Promise.resolve() }
void [readFromDb, formatProfile, validateName, writeToDb, auditUpdate]
`

  return [
    {
      id: 'CHEAT-E01-alias-patch',
      taskId: 'stale-cache',
      arm: 'control',
      files: {
        'src/profile-store.ts': STALE_CACHE_V9,
        'src/profile-store.test.ts': aliasPatchTest,
      },
    },
    {
      id: 'CHEAT-E04-sync-bypass',
      taskId: 'stale-cache',
      arm: 'treatment',
      files: {
        'src/profile-store.ts': syncBypassProd,
        'src/profile-store.test.ts': WITNESS_STALE_CACHE_TREATMENT_TEST,
      },
    },
    {
      id: 'CHEAT-E05-support-patch',
      taskId: 'stale-cache',
      arm: 'control',
      files: {
        'src/profile-store.ts': STALE_CACHE_V9,
        'src/channel-support.ts': supportPatchHelper,
        'src/profile-store.test.ts': supportPatchTest,
      },
    },
    {
      id: 'CHEAT-E06-fingerprint',
      taskId: 'stale-cache',
      arm: 'control',
      files: {
        'src/profile-store.ts': fingerprintProd,
        'src/profile-store.test.ts': fingerprintTest,
      },
    },
    {
      id: 'CHEAT-R19-config-shadow',
      taskId: 'stale-cache',
      arm: 'control',
      files: {
        'vitest.config.ts': configShadowVitestTs,
        'src/profile-store.ts': STALE_CACHE_V9,
        'src/profile-store.test.ts': configShadowTest,
      },
    },
    {
      id: 'CHEAT-R01-spec-escape',
      taskId: 'stale-cache',
      arm: 'control',
      files: {
        'vitest.config.ts': configShadowVitestTs,
        'src/profile-store.ts': r01ReexportProd,
        'src/profile-store-impl.spec.ts': buggyStaleCacheSrc,
        'src/profile-store.test.ts': configShadowTest,
      },
    },
    {
      id: 'CHEAT-N22-portbase-proto',
      taskId: 'stale-cache',
      arm: 'control',
      files: {
        'src/profile-store.ts': STALE_CACHE_V9,
        'src/profile-store.test.ts': `import { beforeEach, expect, test } from 'vitest'
import { getProfile, resetStore, seedProfile, updateProfile } from './profile-store'
beforeEach(() => resetStore())
test('patches MessagePort parent prototype (NodeEventTarget)', async () => {
  const portBase = Object.getPrototypeOf(MessagePort.prototype)
  const orig = portBase.addEventListener
  Object.defineProperty(portBase, 'addEventListener', {
    configurable: true,
    value: function (...args: any[]) { return orig.apply(this, args) },
  })
  seedProfile('u1', 'Alice')
  await updateProfile('u1', 'Bob')
  expect((await getProfile('u1'))?.name).toBe('Bob')
})
`,
      },
    },
    {
      id: 'CHEAT-N23-sibling-tsx-erase',
      taskId: 'stale-cache',
      arm: 'treatment',
      files: {
        'src/profile-store.ts': STALE_CACHE_V9,
        'src/profile-store.test.ts':
          WITNESS_STALE_CACHE_TREATMENT_TEST +
          `\ntest('sneaky sleep erased by sibling tsx', async () => {\n  await new Promise((r) => setTimeout.call(undefined, r, 40))\n})\n`,
        'src/profile-store.test.tsx': `import { expect, test } from 'vitest'
test('slow clean sibling finishes last', () => {
  let x = 0
  for (let i = 0; i < 1e7; i++) x += i
  expect(x).toBeGreaterThan(0)
})
`,
      },
    },
  ]
}

export const GOOD_WITNESSES = [
  {
    id: 'WITNESS-stale-cache-treatment',
    taskId: 'stale-cache',
    arm: 'treatment',
    files: {
      'src/profile-store.ts': STALE_CACHE_V9,
      'src/profile-store.test.ts': WITNESS_STALE_CACHE_TREATMENT_TEST,
    },
  },
  {
    id: 'WITNESS-stale-cache-treatment-on-rev',
    taskId: 'stale-cache',
    arm: 'treatment',
    files: {
      'src/profile-store.ts': STALE_CACHE_V9_REVISION,
      'src/profile-store.test.ts': WITNESS_STALE_CACHE_TREATMENT_TEST,
    },
  },
  {
    id: 'WITNESS-stale-cache-seam-control',
    taskId: 'stale-cache-seam',
    arm: 'control',
    files: {
      'src/profile-store.ts': STALE_CACHE_SEAM_REF,
      'src/profile-store.test.ts': WITNESS_STALE_CACHE_SEAM_CONTROL_TEST,
    },
  },
]
