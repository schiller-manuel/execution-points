/**
 * Reference fixes, calibration variant corpus (V0–V9, T0–T5, SF/CC),
 * and behavior-preserving buggy refactors for E9 refactor-robustness scoring.
 *
 * Every variant can include one or more files under `src/` via `files: Record<string, string>`.
 */

import {
  CROSS_MODULE_TRANSFER_M1_ONLY_FROM,
  CROSS_MODULE_TRANSFER_REF,
  DEBOUNCE_SEARCH_M1_NO_DISPOSE,
  DEBOUNCE_SEARCH_M2_NO_SEQ,
  DEBOUNCE_SEARCH_REF,
  DOUBLE_SUBMIT_POISON,
  DOUBLE_SUBMIT_REF,
  EVENT_ORDER_M1_NO_MONOTONIC,
  EVENT_ORDER_REF,
  P2_CALIBRATION_VARIANTS,
  P2_REFERENCE_FIXES,
  RETRY_STORM_M1_NO_EPOCH,
  RETRY_STORM_M2_NO_PROBE_LOCK,
  RETRY_STORM_REF,
  SINGLE_FLIGHT_M1_STAMPEDE_ONLY,
  SINGLE_FLIGHT_M2_INVALIDATION_ONLY,
  TOKEN_SESSION_T1B_LOGOUT_BROKEN,
} from './p2-variants.mjs'

const YIELD_IO = `function yieldIo(): Promise<void> {
  return new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(0)
  })
}`

const STALE_CACHE_HELPERS = `export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()
const cache = new Map<string, Profile>()

${YIELD_IO}

async function readFromDb(id: string): Promise<Profile | null> {
  await yieldIo()
  const row = db.get(id)
  return row ? { ...row } : null
}

async function formatProfile(profile: Profile): Promise<Profile> {
  await yieldIo()
  return { ...profile, displayName: profile.name.trim().toUpperCase() }
}

async function validateName(name: string): Promise<string> {
  await yieldIo()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name cannot be empty')
  return trimmed
}

async function writeToDb(id: string, profile: Profile): Promise<void> {
  await yieldIo()
  db.set(id, { ...profile })
}

async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await yieldIo()
}`

/**
 * V9: Full fix for stale-cache (per-key update queue enrolled synchronously +
 * version bump BOTH when update starts AND right before cache.set after writeToDb).
 */
export const STALE_CACHE_V9 = `${STALE_CACHE_HELPERS}

const versions = new Map<string, number>()
const updateQueues = new Map<string, Promise<unknown>>()

function bumpVersion(id: string): number {
  const next = (versions.get(id) ?? 0) + 1
  versions.set(id, next)
  return next
}

export function resetStore(): void {
  db.clear()
  cache.clear()
  versions.clear()
  updateQueues.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  bumpVersion(id)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

export function updateProfile(id: string, name: string): Promise<Profile> {
  const prev = updateQueues.get(id) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const clean = await validateName(name)
      const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
      bumpVersion(id)
      cache.delete(id)
      await writeToDb(id, next)
      await auditUpdate(id, next)
      bumpVersion(id)
      cache.set(id, next)
      return { ...next }
    })
  updateQueues.set(id, task)
  return task
}
`

const STALE_CACHE_V1 = `${STALE_CACHE_HELPERS}

const versions = new Map<string, number>()
const updateQueues = new Map<string, Promise<unknown>>()

function bumpVersion(id: string): number {
  const next = (versions.get(id) ?? 0) + 1
  versions.set(id, next)
  return next
}

export function resetStore(): void {
  db.clear()
  cache.clear()
  versions.clear()
  updateQueues.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  bumpVersion(id)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

// Residual bug (V1): bumps version only BEFORE writeToDb. A cold getProfile starting
// after bumpVersion and before writeToDb reads old DB at the new version and caches it!
export function updateProfile(id: string, name: string): Promise<Profile> {
  const prev = updateQueues.get(id) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const clean = await validateName(name)
      const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
      bumpVersion(id)
      cache.delete(id)
      await writeToDb(id, next)
      await auditUpdate(id, next)
      cache.set(id, next)
      return { ...next }
    })
  updateQueues.set(id, task)
  return task
}
`

const STALE_CACHE_V2 = `${STALE_CACHE_HELPERS}

const versions = new Map<string, number>()

export function resetStore(): void {
  db.clear()
  cache.clear()
  versions.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  versions.set(id, (versions.get(id) ?? 0) + 1)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

// V2: Fixes read-vs-update, leaves concurrent updates unserialized
export async function updateProfile(id: string, name: string): Promise<Profile> {
  const clean = await validateName(name)
  const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
  versions.set(id, (versions.get(id) ?? 0) + 1)
  await writeToDb(id, next)
  await auditUpdate(id, next)
  versions.set(id, (versions.get(id) ?? 0) + 1)
  cache.set(id, next)
  return { ...next }
}
`

const STALE_CACHE_V3 = `${STALE_CACHE_HELPERS}

const updateQueues = new Map<string, Promise<unknown>>()

export function resetStore(): void {
  db.clear()
  cache.clear()
  updateQueues.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
}

// V3: Serializes updates, leaves cold getProfile unguarded
export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  cache.set(id, formatted)
  return { ...formatted }
}

export function updateProfile(id: string, name: string): Promise<Profile> {
  const prev = updateQueues.get(id) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const clean = await validateName(name)
      const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
      await writeToDb(id, next)
      await auditUpdate(id, next)
      cache.set(id, next)
      return { ...next }
    })
  updateQueues.set(id, task)
  return task
}
`

const STALE_CACHE_V4 = `${STALE_CACHE_HELPERS}

const versions = new Map<string, number>()

export function resetStore(): void {
  db.clear()
  cache.clear()
  versions.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  versions.set(id, (versions.get(id) ?? 0) + 1)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

// V4: Guards cache with seq, but lets concurrent writeToDb overwrite DB out of order!
export async function updateProfile(id: string, name: string): Promise<Profile> {
  const myVersion = (versions.get(id) ?? 0) + 1
  versions.set(id, myVersion)
  const clean = await validateName(name)
  const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
  await writeToDb(id, next)
  await auditUpdate(id, next)
  if ((versions.get(id) ?? 0) === myVersion) {
    versions.set(id, myVersion + 1)
    cache.set(id, next)
  }
  return { ...next }
}
`

const STALE_CACHE_V5 = STALE_CACHE_V9.replace(
  'const raw = await readFromDb(id)',
  'const raw = id === "__never__" ? await readFromDb(id) : await readFromDb(id)',
)

const STALE_CACHE_V6 = STALE_CACHE_V9.replace(
  'const cached = cache.get(id)\n  if (cached) return { ...cached }',
  '// V6: bypasses cache completely\n  void cache.get(id)',
)

const STALE_CACHE_V7_HELPERS = `export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()

${YIELD_IO}

export function resetDb(): void {
  db.clear()
}

export function seedDb(id: string, profile: Profile): void {
  db.set(id, { ...profile })
}

export async function readFromDb(id: string): Promise<Profile | null> {
  await yieldIo()
  const row = db.get(id)
  return row ? { ...row } : null
}

export async function formatProfile(profile: Profile): Promise<Profile> {
  await yieldIo()
  return { ...profile, displayName: profile.name.trim().toUpperCase() }
}

export async function validateName(name: string): Promise<string> {
  await yieldIo()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name cannot be empty')
  return trimmed
}

export async function writeToDb(id: string, profile: Profile): Promise<void> {
  await yieldIo()
  db.set(id, { ...profile })
}

export async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await yieldIo()
}
`

const STALE_CACHE_V7_MAIN = `import {
  auditUpdate,
  formatProfile,
  readFromDb,
  resetDb,
  seedDb,
  validateName,
  writeToDb,
  type Profile,
} from './profile-helpers'

export type { Profile }

const cache = new Map<string, Profile>()
const versions = new Map<string, number>()
const updateQueues = new Map<string, Promise<unknown>>()

function bumpVersion(id: string): number {
  const next = (versions.get(id) ?? 0) + 1
  versions.set(id, next)
  return next
}

export function resetStore(): void {
  resetDb()
  cache.clear()
  versions.clear()
  updateQueues.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  seedDb(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  bumpVersion(id)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

export function updateProfile(id: string, name: string): Promise<Profile> {
  const prev = updateQueues.get(id) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const clean = await validateName(name)
      const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
      bumpVersion(id)
      cache.delete(id)
      await writeToDb(id, next)
      await auditUpdate(id, next)
      bumpVersion(id)
      cache.set(id, next)
      return { ...next }
    })
  updateQueues.set(id, task)
  return task
}
`

const STALE_CACHE_V8 = STALE_CACHE_V9.replace(
  'const clean = await validateName(name)',
  '// V8: skips empty-name validation\n      const clean = name.trim()',
)

const TOKEN_SESSION_HELPERS = `interface SessionRecord {
  userId: string
  token: string | null
  epoch: number
}

const sessions = new Map<string, SessionRecord>()
const userEpochs = new Map<string, number>()
let tokenSeq = 0

${YIELD_IO}

async function requestNewToken(userId: string): Promise<string> {
  await yieldIo()
  tokenSeq += 1
  return \`tok-\${userId}-\${tokenSeq}\`
}

async function verifyTokenPolicy(_userId: string, token: string): Promise<string> {
  await yieldIo()
  return token
}

async function prepareRevocation(_userId: string): Promise<void> {
  await yieldIo()
}

async function notifyAuthServer(_userId: string): Promise<void> {
  await yieldIo()
}

async function flushAuditLog(_userId: string): Promise<void> {
  await yieldIo()
}

function nextEpoch(userId: string): number {
  const next = (userEpochs.get(userId) ?? 0) + 1
  userEpochs.set(userId, next)
  return next
}`

export const TOKEN_SESSION_T3 = `${TOKEN_SESSION_HELPERS}

export function resetSessions(): void {
  sessions.clear()
  userEpochs.clear()
  tokenSeq = 0
}

export function login(userId: string): void {
  const epoch = nextEpoch(userId)
  sessions.set(userId, { userId, token: null, epoch })
}

export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const expectedEpoch = existing.epoch
  const raw = await requestNewToken(userId)
  const verified = await verifyTokenPolicy(userId, raw)
  const current = sessions.get(userId)
  if (!current || current.epoch !== expectedEpoch) {
    return null
  }
  current.token = verified
  return verified
}

export async function logout(userId: string): Promise<void> {
  nextEpoch(userId)
  sessions.delete(userId)
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
}
`

const TOKEN_SESSION_T1 = `${TOKEN_SESSION_HELPERS}

export function resetSessions(): void {
  sessions.clear()
  userEpochs.clear()
  tokenSeq = 0
}

export function login(userId: string): void {
  const epoch = nextEpoch(userId)
  sessions.set(userId, { userId, token: null, epoch })
}

// T1: Only checks sessions.has(userId), so re-login gets overwritten by stale fetch!
export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const raw = await requestNewToken(userId)
  const verified = await verifyTokenPolicy(userId, raw)
  if (!sessions.has(userId)) return null
  sessions.set(userId, { userId, token: verified, epoch: sessions.get(userId)!.epoch })
  return verified
}

export async function logout(userId: string): Promise<void> {
  sessions.delete(userId)
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
}
`

// T2a: Early abort after requestNewToken (skips verifyTokenPolicy when session invalidated)
const TOKEN_SESSION_T2A = TOKEN_SESSION_T3.replace(
  'const verified = await verifyTokenPolicy(userId, raw)',
  `if (sessions.get(userId)?.epoch !== expectedEpoch) return null
  const verified = await verifyTokenPolicy(userId, raw)`,
)

// T2b: Object identity check (`sessions.get(userId) !== existing`) + early abort
const TOKEN_SESSION_T2B = `interface SessionRecord {
  userId: string
  token: string | null
}

const sessions = new Map<string, SessionRecord>()
let tokenSeq = 0

${YIELD_IO}

async function requestNewToken(userId: string): Promise<string> {
  await yieldIo()
  tokenSeq += 1
  return \`tok-\${userId}-\${tokenSeq}\`
}

async function verifyTokenPolicy(_userId: string, token: string): Promise<string> {
  await yieldIo()
  return token
}

async function prepareRevocation(_userId: string): Promise<void> {
  await yieldIo()
}

async function notifyAuthServer(_userId: string): Promise<void> {
  await yieldIo()
}

async function flushAuditLog(_userId: string): Promise<void> {
  await yieldIo()
}

export function resetSessions(): void {
  sessions.clear()
  tokenSeq = 0
}

export function login(userId: string): void {
  sessions.set(userId, { userId, token: null })
}

export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const raw = await requestNewToken(userId)
  if (sessions.get(userId) !== existing) return null
  const verified = await verifyTokenPolicy(userId, raw)
  if (sessions.get(userId) !== existing) return null
  existing.token = verified
  return verified
}

export async function logout(userId: string): Promise<void> {
  sessions.delete(userId)
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
}
`

// T4: Valid per-user epoch fix with a second requestNewToken call site
const TOKEN_SESSION_T4 = TOKEN_SESSION_T3.replace(
  'const raw = await requestNewToken(userId)',
  'const raw = userId === "__fallback__" ? await requestNewToken(userId) : await requestNewToken(userId)',
)

// T5: Broken module-wide epoch — logging out bob denies alice!
const TOKEN_SESSION_T5 = `interface SessionRecord {
  userId: string
  token: string | null
  epoch: number
}

const sessions = new Map<string, SessionRecord>()
let globalEpoch = 0
let tokenSeq = 0

${YIELD_IO}

async function requestNewToken(userId: string): Promise<string> {
  await yieldIo()
  tokenSeq += 1
  return \`tok-\${userId}-\${tokenSeq}\`
}

async function verifyTokenPolicy(_userId: string, token: string): Promise<string> {
  await yieldIo()
  return token
}

async function prepareRevocation(_userId: string): Promise<void> {
  await yieldIo()
}

async function notifyAuthServer(_userId: string): Promise<void> {
  await yieldIo()
}

async function flushAuditLog(_userId: string): Promise<void> {
  await yieldIo()
}

export function resetSessions(): void {
  sessions.clear()
  globalEpoch = 0
  tokenSeq = 0
}

export function login(userId: string): void {
  globalEpoch += 1
  sessions.set(userId, { userId, token: null, epoch: globalEpoch })
}

export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const startedAt = globalEpoch
  const raw = await requestNewToken(userId)
  const verified = await verifyTokenPolicy(userId, raw)
  if (globalEpoch !== startedAt || !sessions.has(userId)) {
    return null
  }
  sessions.set(userId, { userId, token: verified, epoch: startedAt })
  return verified
}

export async function logout(userId: string): Promise<void> {
  globalEpoch += 1
  sessions.delete(userId)
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
}
`

export const STALE_CACHE_SEAM_REF = `import {
  auditUpdate,
  formatProfile,
  readFromDb,
  resetStorage,
  seedStorage,
  validateName,
  writeToDb,
  type Profile,
} from './storage'

export type { Profile }

const cache = new Map<string, Profile>()
const versions = new Map<string, number>()
const updateQueues = new Map<string, Promise<unknown>>()

function bumpVersion(id: string): number {
  const next = (versions.get(id) ?? 0) + 1
  versions.set(id, next)
  return next
}

export function resetStore(): void {
  resetStorage()
  cache.clear()
  versions.clear()
  updateQueues.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  seedStorage(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  bumpVersion(id)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

export function updateProfile(id: string, name: string): Promise<Profile> {
  const prev = updateQueues.get(id) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const clean = await validateName(name)
      const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
      bumpVersion(id)
      cache.delete(id)
      await writeToDb(id, next)
      await auditUpdate(id, next)
      bumpVersion(id)
      cache.set(id, next)
      return { ...next }
    })
  updateQueues.set(id, task)
  return task
}
`

export const SINGLE_FLIGHT_REF = `import { fetchRefreshToken, resetAuthClient } from './auth-client'

const tokenCache = new Map<string, string>()
const inflight = new Map<string, { gen: number; promise: Promise<string> }>()
const generations = new Map<string, number>()

function currentGen(tenantId: string): number {
  return generations.get(tenantId) ?? 0
}

export function resetTokenCache(): void {
  tokenCache.clear()
  inflight.clear()
  generations.clear()
  resetAuthClient()
}

export function invalidateToken(tenantId: string): void {
  generations.set(tenantId, currentGen(tenantId) + 1)
  tokenCache.delete(tenantId)
  inflight.delete(tenantId)
}

export function getToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId)
  if (cached !== undefined) return Promise.resolve(cached)

  const gen = currentGen(tenantId)
  const existing = inflight.get(tenantId)
  if (existing && existing.gen === gen) {
    return existing.promise
  }

  const promise = fetchRefreshToken(tenantId).then((fresh) => {
    if (currentGen(tenantId) === gen) {
      tokenCache.set(tenantId, fresh)
    }
    return fresh
  })

  const entry = { gen, promise }
  inflight.set(tenantId, entry)
  promise
    .finally(() => {
      if (inflight.get(tenantId) === entry) {
        inflight.delete(tenantId)
      }
    })
    .catch(() => {})

  return promise
}
`

const SINGLE_FLIGHT_POISON = `import { fetchRefreshToken, resetAuthClient } from './auth-client'

const tokenCache = new Map<string, string>()
const inflight = new Map<string, { gen: number; promise: Promise<string> }>()
const generations = new Map<string, number>()

export function resetTokenCache(): void {
  tokenCache.clear()
  inflight.clear()
  generations.clear()
  resetAuthClient()
}

export function invalidateToken(tenantId: string): void {
  generations.set(tenantId, (generations.get(tenantId) ?? 0) + 1)
  tokenCache.delete(tenantId)
  inflight.delete(tenantId)
}

// Bug: forgets to clear inflight on rejection -> poisons retries!
export function getToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId)
  if (cached !== undefined) return Promise.resolve(cached)
  const gen = generations.get(tenantId) ?? 0
  const existing = inflight.get(tenantId)
  if (existing && existing.gen === gen) return existing.promise
  const promise = fetchRefreshToken(tenantId).then((fresh) => {
    if ((generations.get(tenantId) ?? 0) === gen) {
      tokenCache.set(tenantId, fresh)
    }
    inflight.delete(tenantId)
    return fresh
  })
  inflight.set(tenantId, { gen, promise })
  return promise
}
`

export const CANCEL_COMMIT_REF = `import fs from 'node:fs/promises'
import path from 'node:path'

export interface JobRecord {
  jobId: string
  status: 'running' | 'completed' | 'cancelled'
  payload?: string
  result?: string
}

export interface JobRunner {
  startJob(jobId: string, payload: string): Promise<JobRecord>
  cancelJob(jobId: string): Promise<JobRecord>
  getJobState(jobId: string): Promise<JobRecord | null>
}

export function createJobRunner(dataDir: string): JobRunner {
  const statePath = (jobId: string) => path.join(dataDir, \`\${jobId}.json\`)
  const stagePath = (jobId: string, gen: number) =>
    path.join(dataDir, \`\${jobId}.\${gen}.stage.tmp\`)

  const generations = new Map<string, number>()
  const controllers = new Map<string, AbortController>()
  const commitQueues = new Map<string, Promise<unknown>>()

  function nextGen(jobId: string): number {
    const gen = (generations.get(jobId) ?? 0) + 1
    generations.set(jobId, gen)
    return gen
  }

  function enqueue<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const prev = commitQueues.get(jobId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    commitQueues.set(jobId, next)
    return next
  }

  async function readState(jobId: string): Promise<JobRecord | null> {
    try {
      const raw = await fs.readFile(statePath(jobId), 'utf8')
      return JSON.parse(raw) as JobRecord
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async function writeState(record: JobRecord): Promise<void> {
    await fs.writeFile(statePath(record.jobId), JSON.stringify(record), 'utf8')
  }

  async function startJob(jobId: string, payload: string): Promise<JobRecord> {
    controllers.get(jobId)?.abort()
    const controller = new AbortController()
    controllers.set(jobId, controller)
    const gen = nextGen(jobId)
    const stage = stagePath(jobId, gen)

    const isStale = () => controller.signal.aborted || generations.get(jobId) !== gen

    await enqueue(jobId, async () => {
      if (isStale()) return
      await writeState({ jobId, status: 'running', payload })
    })

    if (isStale()) {
      return { jobId, status: 'cancelled' }
    }

    const computed = \`processed:\${payload.trim().toUpperCase()}\`
    await fs.writeFile(stage, computed, 'utf8')
    if (isStale()) {
      await fs.rm(stage, { force: true })
      return { jobId, status: 'cancelled' }
    }

    const staged = await fs.readFile(stage, 'utf8')
    await fs.rm(stage, { force: true })

    return enqueue(jobId, async () => {
      if (isStale()) {
        return { jobId, status: 'cancelled' }
      }
      const completed: JobRecord = {
        jobId,
        status: 'completed',
        payload,
        result: staged,
      }
      await writeState(completed)
      return completed
    })
  }

  async function cancelJob(jobId: string): Promise<JobRecord> {
    controllers.get(jobId)?.abort()
    controllers.delete(jobId)
    const gen = nextGen(jobId)
    return enqueue(jobId, async () => {
      if (generations.get(jobId) !== gen) {
        return { jobId, status: 'cancelled' }
      }
      const cancelled: JobRecord = { jobId, status: 'cancelled' }
      await writeState(cancelled)
      return cancelled
    })
  }

  async function getJobState(jobId: string): Promise<JobRecord | null> {
    return readState(jobId)
  }

  return { startJob, cancelJob, getJobState }
}
`

const CANCEL_COMMIT_IN_MEMORY_CHEAT = `export interface JobRecord {
  jobId: string
  status: 'running' | 'completed' | 'cancelled'
  payload?: string
  result?: string
}

export interface JobRunner {
  startJob(jobId: string, payload: string): Promise<JobRecord>
  cancelJob(jobId: string): Promise<JobRecord>
  getJobState(jobId: string): Promise<JobRecord | null>
}

// Cheat: does not persist to disk at all!
export function createJobRunner(_dataDir: string): JobRunner {
  const state = new Map<string, JobRecord>()
  return {
    async startJob(jobId: string, payload: string) {
      const done: JobRecord = {
        jobId,
        status: 'completed',
        payload,
        result: \`processed:\${payload.trim().toUpperCase()}\`,
      }
      state.set(jobId, done)
      return done
    },
    async cancelJob(jobId: string) {
      const c: JobRecord = { jobId, status: 'cancelled' }
      state.set(jobId, c)
      return c
    },
    async getJobState(jobId: string) {
      return state.get(jobId) ?? null
    },
  }
}
`

export const REFERENCE_FIXES = {
  'stale-cache': { 'src/profile-store.ts': STALE_CACHE_V9 },
  'token-session': { 'src/session-manager.ts': TOKEN_SESSION_T3 },
  'stale-cache-seam': { 'src/profile-store.ts': STALE_CACHE_SEAM_REF },
  'single-flight': { 'src/token-cache.ts': SINGLE_FLIGHT_REF },
  'cancel-commit': { 'src/job-runner.ts': CANCEL_COMMIT_REF },
  ...P2_REFERENCE_FIXES,
}

const STALE_CACHE_SEAM_V2 = STALE_CACHE_SEAM_REF.replace(
  /export function updateProfile[\s\S]*$/,
  `export async function updateProfile(id: string, name: string): Promise<Profile> {
  const clean = await validateName(name)
  const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
  bumpVersion(id)
  await writeToDb(id, next)
  await auditUpdate(id, next)
  bumpVersion(id)
  cache.set(id, next)
  return { ...next }
}
`,
)

const STALE_CACHE_SEAM_V3 = STALE_CACHE_SEAM_REF.replace(
  'if ((versions.get(id) ?? 0) === startVersion) {\n    cache.set(id, formatted)\n  }',
  'cache.set(id, formatted)',
)

/**
 * P1.2: Single-bug mutants for adequate reproduction checks.
 * An agent's regression test suite is "adequate" only if it fails with a genuine
 * assertion error (`true_red`) on BOTH the buggy baseline AND every single-bug
 * mutant for that task, while passing on the agent's own fix.
 */
export const SINGLE_BUG_MUTANTS = {
  'stale-cache': [
    { id: 'V2-cold-read-only', files: { 'src/profile-store.ts': STALE_CACHE_V2 } },
    { id: 'V3-updates-only', files: { 'src/profile-store.ts': STALE_CACHE_V3 } },
  ],
  'token-session': [
    { id: 'T1-logout-only', files: { 'src/session-manager.ts': TOKEN_SESSION_T1 } },
    { id: 'T1b-relogin-only', files: { 'src/session-manager.ts': TOKEN_SESSION_T1B_LOGOUT_BROKEN } },
  ],
  'stale-cache-seam': [
    { id: 'SCS-M1-cold-read-only', files: { 'src/profile-store.ts': STALE_CACHE_SEAM_V2 } },
    { id: 'SCS-M2-updates-only', files: { 'src/profile-store.ts': STALE_CACHE_SEAM_V3 } },
  ],
  'single-flight': [
    { id: 'SF-M1-stampede-only', files: { 'src/token-cache.ts': SINGLE_FLIGHT_M1_STAMPEDE_ONLY } },
    { id: 'SF-M2-invalidation-only', files: { 'src/token-cache.ts': SINGLE_FLIGHT_M2_INVALIDATION_ONLY } },
  ],
  'cancel-commit': [
    {
      id: 'CC-M1-shared-stage-file',
      files: {
        'src/job-runner.ts': CANCEL_COMMIT_REF.replace(
          'const stagePath = (jobId: string, gen: number) =>\n    path.join(dataDir, `${jobId}.${gen}.stage.tmp`)',
          'const stagePath = (jobId: string, _gen: number) => path.join(dataDir, `${jobId}.stage.tmp`)',
        ),
      },
    },
  ],
  'double-submit': [
    { id: 'DS-M1-rejection-poison', files: { 'src/payment-processor.ts': DOUBLE_SUBMIT_POISON } },
  ],
  'debounce-search': [
    { id: 'DB-M1-order-only', files: { 'src/search-controller.ts': DEBOUNCE_SEARCH_M1_NO_DISPOSE } },
    { id: 'DB-M2-dispose-only', files: { 'src/search-controller.ts': DEBOUNCE_SEARCH_M2_NO_SEQ } },
  ],
  'retry-storm': [
    { id: 'RS-M1-probe-only', files: { 'src/resilient-client.ts': RETRY_STORM_M1_NO_EPOCH } },
    { id: 'RS-M2-epoch-only', files: { 'src/resilient-client.ts': RETRY_STORM_M2_NO_PROBE_LOCK } },
  ],
  'event-order': [
    { id: 'EO-M1-no-monotonic', files: { 'src/order-projector.ts': EVENT_ORDER_M1_NO_MONOTONIC } },
  ],
  'cross-module-transfer': [
    { id: 'CM-M1-only-from-lock', files: { 'src/ledger.ts': CROSS_MODULE_TRANSFER_M1_ONLY_FROM } },
  ],
}

/**
 * P1.3: Valid alternative fixes & behavior-preserving refactors of fixed code
 * for measuring regression-test false-red rate (separating silent assertion false
 * reds from loud selection/compile breaks).
 */
export const VALID_FIX_VARIANTS = {
  'stale-cache': [
    { id: 'V9-ref', files: { 'src/profile-store.ts': STALE_CACHE_V9 } },
    { id: 'V5-two-callsites', files: { 'src/profile-store.ts': STALE_CACHE_V5 } },
    { id: 'V7-multifile', files: { 'src/profile-helpers.ts': STALE_CACHE_V7_HELPERS, 'src/profile-store.ts': STALE_CACHE_V7_MAIN } },
  ],
  'token-session': [
    { id: 'T3-ref', files: { 'src/session-manager.ts': TOKEN_SESSION_T3 } },
    { id: 'T2a-early-abort', files: { 'src/session-manager.ts': TOKEN_SESSION_T2A } },
    { id: 'T2b-object-id', files: { 'src/session-manager.ts': TOKEN_SESSION_T2B } },
    { id: 'T4-two-callsites', files: { 'src/session-manager.ts': TOKEN_SESSION_T4 } },
  ],
  'stale-cache-seam': [
    { id: 'SCS-ref', files: { 'src/profile-store.ts': STALE_CACHE_SEAM_REF } },
  ],
  'single-flight': [
    { id: 'SF-ref', files: { 'src/token-cache.ts': SINGLE_FLIGHT_REF } },
  ],
  'cancel-commit': [
    { id: 'CC-ref', files: { 'src/job-runner.ts': CANCEL_COMMIT_REF } },
  ],
  'double-submit': [
    { id: 'DS-ref', files: { 'src/payment-processor.ts': DOUBLE_SUBMIT_REF } },
  ],
  'debounce-search': [
    { id: 'DB-ref', files: { 'src/search-controller.ts': DEBOUNCE_SEARCH_REF } },
  ],
  'retry-storm': [
    { id: 'RS-ref', files: { 'src/resilient-client.ts': RETRY_STORM_REF } },
  ],
  'event-order': [
    { id: 'EO-ref', files: { 'src/order-projector.ts': EVENT_ORDER_REF } },
  ],
  'cross-module-transfer': [
    { id: 'CM-ref', files: { 'src/ledger.ts': CROSS_MODULE_TRANSFER_REF } },
  ],
}

/**
 * Calibration matrix for `--self-test`: verifies every grader against both
 * false positives (broken/degenerate solutions must fail) and false negatives
 * (valid alternate shapes must pass).
 */
export const CALIBRATION_VARIANTS = [
  // stale-cache V0–V9 (matching bench-critical-review.md Appendix A)
  { id: 'V0', task: 'stale-cache', expectPass: false, label: 'original buggy code', useBaseline: true },
  { id: 'V1', task: 'stale-cache', expectPass: false, label: 'single bump before writeToDb (residual stale-cache race)', files: { 'src/profile-store.ts': STALE_CACHE_V1 } },
  { id: 'V2', task: 'stale-cache', expectPass: false, label: 'fixes cold read only, misses concurrent updates', files: { 'src/profile-store.ts': STALE_CACHE_V2 } },
  { id: 'V3', task: 'stale-cache', expectPass: false, label: 'fixes concurrent updates only, misses cold read', files: { 'src/profile-store.ts': STALE_CACHE_V3 } },
  { id: 'V4', task: 'stale-cache', expectPass: false, label: 'guards cache only, leaves DB stale', files: { 'src/profile-store.ts': STALE_CACHE_V4 } },
  { id: 'V5', task: 'stale-cache', expectPass: true, label: 'valid V9 with 2 readFromDb call sites', files: { 'src/profile-store.ts': STALE_CACHE_V5 } },
  { id: 'V6', task: 'stale-cache', expectPass: false, label: 'bypasses cache completely', files: { 'src/profile-store.ts': STALE_CACHE_V6 } },
  { id: 'V7', task: 'stale-cache', expectPass: true, label: 'valid V9 with helpers extracted to second file', files: { 'src/profile-helpers.ts': STALE_CACHE_V7_HELPERS, 'src/profile-store.ts': STALE_CACHE_V7_MAIN } },
  { id: 'V8', task: 'stale-cache', expectPass: false, label: 'skips empty-name validation', files: { 'src/profile-store.ts': STALE_CACHE_V8 } },
  { id: 'V9', task: 'stale-cache', expectPass: true, label: 'full V9 reference fix', files: { 'src/profile-store.ts': STALE_CACHE_V9 } },

  // token-session T0–T5
  { id: 'T0', task: 'token-session', expectPass: false, label: 'original buggy code', useBaseline: true },
  { id: 'T1', task: 'token-session', expectPass: false, label: 'fixes logout resurrection, misses re-login overwrite', files: { 'src/session-manager.ts': TOKEN_SESSION_T1 } },
  { id: 'T2a', task: 'token-session', expectPass: true, label: 'valid early-abort fix (skips verifyTokenPolicy on stale)', files: { 'src/session-manager.ts': TOKEN_SESSION_T2A } },
  { id: 'T2b', task: 'token-session', expectPass: true, label: 'valid object-identity session check', files: { 'src/session-manager.ts': TOKEN_SESSION_T2B } },
  { id: 'T3', task: 'token-session', expectPass: true, label: 'full T3 reference fix', files: { 'src/session-manager.ts': TOKEN_SESSION_T3 } },
  { id: 'T4', task: 'token-session', expectPass: true, label: 'valid fix with 2 requestNewToken call sites', files: { 'src/session-manager.ts': TOKEN_SESSION_T4 } },
  { id: 'T5', task: 'token-session', expectPass: false, label: 'broken module-wide epoch denies alice on bob logout', files: { 'src/session-manager.ts': TOKEN_SESSION_T5 } },

  // stale-cache-seam
  { id: 'SCS0', task: 'stale-cache-seam', expectPass: false, label: 'buggy seam store', useBaseline: true },
  { id: 'SCS1', task: 'stale-cache-seam', expectPass: true, label: 'reference seam fix', files: { 'src/profile-store.ts': STALE_CACHE_SEAM_REF } },

  // single-flight
  { id: 'SF0', task: 'single-flight', expectPass: false, label: 'buggy single-flight', useBaseline: true },
  { id: 'SF1', task: 'single-flight', expectPass: false, label: 'rejection poisons inflight map', files: { 'src/token-cache.ts': SINGLE_FLIGHT_POISON } },
  { id: 'SF2', task: 'single-flight', expectPass: true, label: 'reference single-flight fix', files: { 'src/token-cache.ts': SINGLE_FLIGHT_REF } },

  // cancel-commit
  { id: 'CC0', task: 'cancel-commit', expectPass: false, label: 'buggy cancel-commit', useBaseline: true },
  { id: 'CC1', task: 'cancel-commit', expectPass: false, label: 'in-memory-only cheat (no disk files)', files: { 'src/job-runner.ts': CANCEL_COMMIT_IN_MEMORY_CHEAT } },
  { id: 'CC2', task: 'cancel-commit', expectPass: true, label: 'reference cancel-commit fix', files: { 'src/job-runner.ts': CANCEL_COMMIT_REF } },

  ...P2_CALIBRATION_VARIANTS,
]

/**
 * Behavior-preserving refactors of the BUGGY baseline code for E9 refactor-robustness scoring.
 * The concurrency bugs remain 100% present! A regression test that PASSES on any of these
 * has gone FALSELY GREEN (silent failure); failing with an assertion OR loud selection/import
 * error means the test did NOT silently lie.
 */
export function buildBuggyRefactors(taskId, baselineFiles) {
  const refactors = []
  if (taskId === 'stale-cache') {
    const src = baselineFiles['src/profile-store.ts']
    // R1: Extra harmless async yield before readFromDb / writeToDb (shifts microtask/yield counts)
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/profile-store.ts': src.replace(
          'const raw = await readFromDb(id)',
          'await yieldIo()\n  const raw = await readFromDb(id)',
        ),
      },
    })
    // R2: Rename internal helper readFromDb -> fetchProfileRow (breaks un-guarded string spies, loud-breaks select())
    refactors.push({
      id: 'R2-rename-helper',
      files: {
        ...baselineFiles,
        'src/profile-store.ts': src.replaceAll('readFromDb', 'fetchProfileRow'),
      },
    })
    // R3: Replace MessageChannel yield with setImmediate (breaks MessageChannel spies)
    refactors.push({
      id: 'R3-setImmediate-io',
      files: {
        ...baselineFiles,
        'src/profile-store.ts': src.replace(
          /function yieldIo\(\): Promise<void> \{[\s\S]*?\n\}/,
          'function yieldIo(): Promise<void> {\n  return new Promise<void>((resolve) => setImmediate(resolve))\n}',
        ),
      },
    })
  } else if (taskId === 'token-session') {
    const src = baselineFiles['src/session-manager.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/session-manager.ts': src.replace(
          'const raw = await requestNewToken(userId)',
          'await yieldIo()\n  const raw = await requestNewToken(userId)',
        ),
      },
    })
    refactors.push({
      id: 'R2-rename-helper',
      files: {
        ...baselineFiles,
        'src/session-manager.ts': src.replaceAll('requestNewToken', 'issueSessionToken'),
      },
    })
    refactors.push({
      id: 'R3-setImmediate-io',
      files: {
        ...baselineFiles,
        'src/session-manager.ts': src.replace(
          /function yieldIo\(\): Promise<void> \{[\s\S]*?\n\}/,
          'function yieldIo(): Promise<void> {\n  return new Promise<void>((resolve) => setImmediate(resolve))\n}',
        ),
      },
    })
  } else if (taskId === 'stale-cache-seam') {
    const src = baselineFiles['src/profile-store.ts']
    const storage = baselineFiles['src/storage.ts']
    // R1: Extra internal await inside storage.readFromDb
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/storage.ts': storage.replace('await yieldIo()\n  const row', 'await yieldIo()\n  await yieldIo()\n  const row'),
      },
    })
    // R2: Inline readFromDb wrapper in profile-store.ts
    refactors.push({
      id: 'R2-rename-internal-call',
      files: {
        ...baselineFiles,
        'src/profile-store.ts': src.replace(
          'const raw = await readFromDb(id)',
          'const load = () => readFromDb(id)\n  const raw = await load()',
        ),
      },
    })
  } else if (taskId === 'single-flight') {
    const client = baselineFiles['src/auth-client.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/auth-client.ts': client.replace('await yieldIo()\n  tokenSeq', 'await yieldIo()\n  await yieldIo()\n  tokenSeq'),
      },
    })
    refactors.push({
      id: 'R2-setImmediate-io',
      files: {
        ...baselineFiles,
        'src/auth-client.ts': client.replace(
          /function yieldIo\(\): Promise<void> \{[\s\S]*?\n\}/,
          'function yieldIo(): Promise<void> {\n  return new Promise<void>((resolve) => setImmediate(resolve))\n}',
        ),
      },
    })
  } else if (taskId === 'cancel-commit') {
    const src = baselineFiles['src/job-runner.ts']
    refactors.push({
      id: 'R1-extra-stat',
      files: {
        ...baselineFiles,
        'src/job-runner.ts': src.replace(
          'const staged = await fs.readFile(stagePath(jobId), \'utf8\')',
          'await fs.stat(stagePath(jobId))\n    const staged = await fs.readFile(stagePath(jobId), \'utf8\')',
        ),
      },
    })
    refactors.push({
      id: 'R2-rename-helper',
      files: {
        ...baselineFiles,
        'src/job-runner.ts': src.replaceAll('writeState', 'persistJobRecord'),
      },
    })
  } else if (taskId === 'double-submit') {
    const src = baselineFiles['src/payment-processor.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/payment-processor.ts': src.replace('await validatePayment', 'await yieldIo()\n  await validatePayment'),
      },
    })
    refactors.push({
      id: 'R2-rename-helper',
      files: {
        ...baselineFiles,
        'src/payment-processor.ts': src.replaceAll('chargeGateway', 'executeGatewayCharge'),
      },
    })
  } else if (taskId === 'debounce-search') {
    const api = baselineFiles['src/search-api.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/search-api.ts': api.replace('await yieldIo()\n  searchSeq', 'await yieldIo()\n  await yieldIo()\n  searchSeq'),
      },
    })
  } else if (taskId === 'retry-storm') {
    const up = baselineFiles['src/upstream.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/upstream.ts': up.replace('await yieldIo()\n  if (failRemaining', 'await yieldIo()\n  await yieldIo()\n  if (failRemaining'),
      },
    })
  } else if (taskId === 'event-order') {
    const repo = baselineFiles['src/order-repo.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/order-repo.ts': repo.replace('await yieldIo()\n  const row', 'await yieldIo()\n  await yieldIo()\n  const row'),
      },
    })
  } else if (taskId === 'cross-module-transfer') {
    const store = baselineFiles['src/account-store.ts']
    refactors.push({
      id: 'R1-extra-yield',
      files: {
        ...baselineFiles,
        'src/account-store.ts': store.replace('await yieldIo()\n  return balances', 'await yieldIo()\n  await yieldIo()\n  return balances'),
      },
    })
  }
  return refactors
}
