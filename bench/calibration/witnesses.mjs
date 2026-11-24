/**
 * Adequacy calibration witnesses (R-09) and must-reject adversarial cheats
 * (E-01, E-04, E-05, E-06, R-19, R-01) verified by `node bench/run.mjs --self-test`.
 */
import { CANCEL_COMMIT_SERIAL_REF, STALE_CACHE_V9_REVISION } from './p2-variants.mjs'
import { CANCEL_COMMIT_REF, STALE_CACHE_SEAM_REF, STALE_CACHE_V9 } from './variants.mjs'

/**
 * Known-good legal Treatment witness for `stale-cache` (W-01 / R-09):
 * Uses deadlock-free `select()` + `settle()` pattern taught in TREATMENT_GUIDE.
 * Must achieve `adequateReproduction === true` AND `true_green` on BOTH V9 (queue)
 * and V9_REV (revision guard)!
 *
 * Selectors are in the minimal style the guide teaches: `callee` alone where it
 * is unique in the file, plus `inFunction` only where it is not (`yieldIo` is
 * called by every helper). The verbose style (`kind`, ternary, `undefined`) is
 * exercised by the contract check in `--self-test` step 3.
 */
export const WITNESS_STALE_CACHE_TREATMENT_TEST = `import { beforeEach, expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { clearCache, getProfile, resetStore, seedProfile, updateProfile } from './profile-store'

const formatPt = select('src/profile-store.ts', (n) => n.callee === 'formatProfile' && n)
const writeYieldPt = select(
  'src/profile-store.ts',
  (n) => n.callee === 'yieldIo' && n.inFunction === 'writeToDb' && n,
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
 * Shared prelude of the `cancel-commit` test files below: a `vi.mock` of
 * `node:fs/promises` that can hold the first matching `writeFile`/`readFile`
 * call at a barrier, plus the guide's `createBarrier()` and `settle()`.
 */
const CANCEL_COMMIT_TEST_PRELUDE = `import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createJobRunner, type JobRunner } from './job-runner'

type Barrier = { entered: () => void; hit: Promise<void>; release: () => void; gate: Promise<void> }
type Pause = { op: string; suffix: string; barrier: Barrier }

const control = vi.hoisted(() => ({ pauses: [] as Pause[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  type FsFunctions = Record<string, (...args: unknown[]) => Promise<unknown>>
  // The module's default export is the same object as its named exports.
  const real = ((actual as unknown as { default?: FsFunctions }).default ?? actual) as FsFunctions
  const wrap = (op: string) => async (...args: unknown[]) => {
    const file = String(args[0])
    const i = control.pauses.findIndex((p) => p.op === op && file.endsWith(p.suffix))
    if (i !== -1) {
      const [pause] = control.pauses.splice(i, 1)
      pause.barrier.entered()
      await pause.barrier.gate
    }
    return real[op](...args)
  }
  const patched = { ...real, writeFile: wrap('writeFile'), readFile: wrap('readFile') }
  return { ...actual, ...patched, default: patched }
})

function createBarrier(): Barrier {
  let entered!: () => void
  const hit = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { entered, hit, release, gate }
}

/** Holds the next call of \`op\` on a file ending in \`suffix\` until the barrier is released. */
function pauseNext(op: 'writeFile' | 'readFile', suffix: string): Barrier {
  const barrier = createBarrier()
  control.pauses.push({ op, suffix, barrier })
  return barrier
}

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

let dir: string
let runner: JobRunner

beforeEach(async () => {
  control.pauses.length = 0
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-runner-test-'))
  runner = createJobRunner(dir)
})

afterEach(async () => {
  control.pauses.length = 0
  await fs.rm(dir, { recursive: true, force: true })
})
`

/**
 * Known-good legal witness for `cancel-commit`, the real-filesystem task (v2.4).
 * Plain Vitest (`vi.mock('node:fs/promises')`), so it is legal in both arms.
 *
 * The second test is what the `CC-M1-shared-stage-file` mutant needs: the
 * superseded run must touch the staging file BETWEEN the newer run's write and
 * read. One barrier and `settle()` cannot place it there; it takes a barrier in
 * each run. The test asserts on the newer run only: the hidden oracle lets a
 * superseded run reject, so its `ENOENT` is not the bug.
 *
 * Must be `adequate` with every repeated run agreeing, and green on BOTH valid
 * fixes (`CC-ref` with per-generation stage files, `CC-serial-stage` with
 * per-job serialization, where the second run cannot start while the first is
 * held and the test must not wait for it).
 */
export const WITNESS_CANCEL_COMMIT_TEST = `${CANCEL_COMMIT_TEST_PRELUDE}
test('a job cancelled while it runs stays cancelled on disk', async () => {
  const stageWrite = pauseNext('writeFile', '.stage.tmp')
  const start = runner.startJob('j1', 'alpha')
  await stageWrite.hit
  const cancel = runner.cancelJob('j1') // start WITHOUT awaiting while the barrier is held
  await settle()
  stageWrite.release()
  const [, cancelled] = await Promise.allSettled([start, cancel])

  expect(cancelled.status).toBe('fulfilled')
  expect(await runner.getJobState('j1')).toEqual({ jobId: 'j1', status: 'cancelled' })
})

test('a superseded run does not delete or overwrite what the newer run staged', async () => {
  const olderStageWrite = pauseNext('writeFile', '.stage.tmp')
  const older = runner.startJob('j1', 'old')
  await olderStageWrite.hit

  const newerStageRead = pauseNext('readFile', '.stage.tmp')
  const newer = runner.startJob('j1', 'new')
  // The newer run either reaches its own barrier (it has staged its result) or is
  // queued behind the older one by a fix that serializes runs of one job.
  await Promise.race([newerStageRead.hit, settle()])

  olderStageWrite.release()
  await Promise.allSettled([older])
  newerStageRead.release()
  const [, newerResult] = await Promise.allSettled([older, newer])

  const expected = { jobId: 'j1', status: 'completed', payload: 'new', result: 'processed:NEW' }
  expect(newerResult.status).toBe('fulfilled')
  expect(await runner.getJobState('j1')).toEqual(expected)
})
`

/**
 * Stability probe for `cancel-commit` (v2.4), NOT a witness: the shape most
 * stored trials used. It holds the older run before its staging read, starts
 * the newer run, waits `settle()`, releases, and lets any rejection fail the
 * test. On the `CC-M1` mutant the result then depends on how many of the newer
 * run's disk calls finish within 20 event-loop turns: with real asynchronous
 * disk I/O it passes on some runs and fails with `ENOENT` on others. Under
 * `bench/deterministic-io.setup.mjs` every run must give the same outcome, and
 * that outcome is an error that escaped the code, never a reproduction.
 */
export const PROBE_CANCEL_COMMIT_SETTLE_TEST = `${CANCEL_COMMIT_TEST_PRELUDE}
test('superseded run does not corrupt the newer run (one barrier and settle)', async () => {
  const olderStageRead = pauseNext('readFile', '.stage.tmp')
  const older = runner.startJob('j1', 'old')
  await olderStageRead.hit
  const newer = runner.startJob('j1', 'new')
  await settle()
  olderStageRead.release()
  const [, newerResult] = await Promise.all([older, newer])

  expect(newerResult).toEqual({ jobId: 'j1', status: 'completed', payload: 'new', result: 'processed:NEW' })
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
  {
    id: 'WITNESS-cancel-commit-control',
    taskId: 'cancel-commit',
    arm: 'control',
    files: {
      'src/job-runner.ts': CANCEL_COMMIT_REF,
      'src/job-runner.test.ts': WITNESS_CANCEL_COMMIT_TEST,
    },
    // Real-filesystem task: both calibrated valid fixes must be green, not just one.
    requireAllValidFixes: true,
  },
  {
    // Same plain-Vitest test in the treatment arm, on the fix that does not use
    // `AbortController` (the reference fix fails the treatment-only typecheck today, F16).
    id: 'WITNESS-cancel-commit-treatment-plain-vitest',
    taskId: 'cancel-commit',
    arm: 'treatment',
    files: {
      'src/job-runner.ts': CANCEL_COMMIT_SERIAL_REF,
      'src/job-runner.test.ts': WITNESS_CANCEL_COMMIT_TEST,
    },
    requireAllValidFixes: true,
  },
]
