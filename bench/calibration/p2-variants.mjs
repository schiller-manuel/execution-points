/**
 * Reference fixes, calibration variants, single-bug mutants (P1.2), and
 * valid-fix robustness variants (P1.3) for tasks 6–10 plus additional single-bug
 * mutants for tasks 1–5.
 */

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

// ── Task 6: double-submit ───────────────────────────────────────────────────
const DOUBLE_SUBMIT_BASE_HELPERS = `export interface PaymentReceipt {
  idempotencyKey: string
  amountCents: number
  chargeId: string
}

const receipts = new Map<string, PaymentReceipt>()
const inflight = new Map<string, Promise<PaymentReceipt>>()
const gatewayCharges: Array<{ idempotencyKey: string; amountCents: number; chargeId: string }> = []
const nextFailures = new Map<string, string[]>()
let chargeSeq = 0

${YIELD_IO}

async function validatePayment(amountCents: number): Promise<void> {
  await yieldIo()
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('Payment amount must be a positive integer')
  }
}

async function reserveFunds(_idempotencyKey: string, _amountCents: number): Promise<void> {
  await yieldIo()
}

async function chargeGateway(idempotencyKey: string, amountCents: number): Promise<string> {
  await yieldIo()
  const queue = nextFailures.get(idempotencyKey)
  if (queue && queue.length > 0) {
    throw new Error(queue.shift()!)
  }
  chargeSeq += 1
  const chargeId = \`chg-\${chargeSeq}\`
  gatewayCharges.push({ idempotencyKey, amountCents, chargeId })
  return chargeId
}

export function resetPayments(): void {
  receipts.clear()
  inflight.clear()
  gatewayCharges.length = 0
  nextFailures.clear()
  chargeSeq = 0
}

export function failNextCharge(idempotencyKey: string, message = 'Gateway timeout'): void {
  const queue = nextFailures.get(idempotencyKey) ?? []
  queue.push(message)
  nextFailures.set(idempotencyKey, queue)
}

export function getGatewayChargeCount(idempotencyKey: string): number {
  return gatewayCharges.filter((c) => c.idempotencyKey === idempotencyKey).length
}`

export const DOUBLE_SUBMIT_REF = `${DOUBLE_SUBMIT_BASE_HELPERS}

export function submitPayment(
  idempotencyKey: string,
  amountCents: number,
): Promise<PaymentReceipt> {
  const existing = receipts.get(idempotencyKey)
  if (existing) return Promise.resolve({ ...existing })
  const active = inflight.get(idempotencyKey)
  if (active) return active.then((r) => ({ ...r }))

  const promise = (async () => {
    await validatePayment(amountCents)
    await reserveFunds(idempotencyKey, amountCents)
    const chargeId = await chargeGateway(idempotencyKey, amountCents)
    const receipt: PaymentReceipt = { idempotencyKey, amountCents, chargeId }
    receipts.set(idempotencyKey, receipt)
    return { ...receipt }
  })()

  inflight.set(idempotencyKey, promise)
  promise
    .finally(() => {
      if (inflight.get(idempotencyKey) === promise) {
        inflight.delete(idempotencyKey)
      }
    })
    .catch(() => {})

  return promise
}
`

// D-05 design-diverse valid fix: per-key serialized queue (matches claude-opus-5.5 pilot design)
export const DOUBLE_SUBMIT_QUEUE_REF = `${DOUBLE_SUBMIT_BASE_HELPERS}

const queues = new Map<string, Promise<unknown>>()

export function submitPayment(
  idempotencyKey: string,
  amountCents: number,
): Promise<PaymentReceipt> {
  const existing = receipts.get(idempotencyKey)
  if (existing) return Promise.resolve({ ...existing })
  const prev = queues.get(idempotencyKey) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const cached = receipts.get(idempotencyKey)
      if (cached) return { ...cached }
      await validatePayment(amountCents)
      await reserveFunds(idempotencyKey, amountCents)
      const chargeId = await chargeGateway(idempotencyKey, amountCents)
      const receipt: PaymentReceipt = { idempotencyKey, amountCents, chargeId }
      receipts.set(idempotencyKey, receipt)
      return { ...receipt }
    })
  queues.set(idempotencyKey, task)
  return task
}
`

export const DOUBLE_SUBMIT_POISON = `${DOUBLE_SUBMIT_BASE_HELPERS}

// Mutant DS1: deduplicates but forgets to clean up inflight on rejection -> poisons retries
export function submitPayment(
  idempotencyKey: string,
  amountCents: number,
): Promise<PaymentReceipt> {
  const existing = receipts.get(idempotencyKey)
  if (existing) return Promise.resolve({ ...existing })
  const active = inflight.get(idempotencyKey)
  if (active) return active.then((r) => ({ ...r }))

  const promise = (async () => {
    await validatePayment(amountCents)
    await reserveFunds(idempotencyKey, amountCents)
    const chargeId = await chargeGateway(idempotencyKey, amountCents)
    const receipt: PaymentReceipt = { idempotencyKey, amountCents, chargeId }
    receipts.set(idempotencyKey, receipt)
    inflight.delete(idempotencyKey)
    return { ...receipt }
  })()

  inflight.set(idempotencyKey, promise)
  return promise
}
`

// ── Task 7: debounce-search ─────────────────────────────────────────────────
export const DEBOUNCE_SEARCH_REF = `import { fetchSearchResults } from './search-api'

export interface SearchSnapshot {
  query: string
  results: string[]
  disposed: boolean
}

export interface SearchController {
  onInput(query: string): void
  flush(): Promise<void>
  dispose(): void
  getSnapshot(): SearchSnapshot
}

export function createSearchController(debounceMs = 20): SearchController {
  let latestQuery = ''
  let latestResults: string[] = []
  let disposed = false
  let requestSeq = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<Promise<void>>()

  function runSearch(query: string, seq: number): Promise<void> {
    const task = (async () => {
      const results = await fetchSearchResults(query)
      if (disposed || seq !== requestSeq) return
      latestQuery = query
      latestResults = results
    })()
    pending.add(task)
    task.finally(() => pending.delete(task)).catch(() => {})
    return task
  }

  function onInput(query: string): void {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    const seq = ++requestSeq
    timer = setTimeout(() => {
      timer = null
      if (disposed || seq !== requestSeq) return
      void runSearch(query, seq)
    }, debounceMs)
  }

  async function flush(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending])
    }
  }

  function dispose(): void {
    disposed = true
    requestSeq += 1
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function getSnapshot(): SearchSnapshot {
    return {
      query: latestQuery,
      results: [...latestResults],
      disposed,
    }
  }

  return { onInput, flush, dispose, getSnapshot }
}
`

export const DEBOUNCE_SEARCH_M1_NO_DISPOSE = DEBOUNCE_SEARCH_REF.replace(
  'if (disposed || seq !== requestSeq) return',
  'if (seq !== requestSeq) return',
).replace(
  `  function dispose(): void {
    disposed = true
    requestSeq += 1
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }`,
  `  function dispose(): void {
    disposed = true
  }`,
)

export const DEBOUNCE_SEARCH_M2_NO_SEQ = DEBOUNCE_SEARCH_REF.replace(
  'if (disposed || seq !== requestSeq) return',
  'if (disposed) return',
)

// ── Task 8: retry-storm ─────────────────────────────────────────────────────
export const RETRY_STORM_REF = `import { callUpstream } from './upstream'

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface ResilientClient {
  request(payload: string): Promise<string>
  getState(): BreakerState
  forceHalfOpen(): void
}

export function createResilientClient(failureThreshold = 2): ResilientClient {
  let state: BreakerState = 'CLOSED'
  let consecutiveFailures = 0
  let epoch = 0
  let probeInFlight = false

  function forceHalfOpen(): void {
    if (state === 'OPEN') {
      state = 'HALF_OPEN'
      probeInFlight = false
      epoch += 1
    }
  }

  async function request(payload: string): Promise<string> {
    if (state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN')
    }
    const isProbe = state === 'HALF_OPEN'
    if (isProbe) {
      if (probeInFlight) {
        throw new Error('Circuit breaker HALF_OPEN probe already in flight')
      }
      probeInFlight = true
    }

    const reqEpoch = epoch
    try {
      const result = await callUpstream(payload)
      if (reqEpoch === epoch) {
        consecutiveFailures = 0
        if (state === 'HALF_OPEN') {
          state = 'CLOSED'
          epoch += 1
        }
      }
      return result
    } catch (err) {
      if (reqEpoch === epoch) {
        consecutiveFailures += 1
        if (isProbe || consecutiveFailures >= failureThreshold) {
          state = 'OPEN'
          epoch += 1
        }
      }
      throw err
    } finally {
      if (isProbe) {
        probeInFlight = false
      }
    }
  }

  return {
    request,
    getState: () => state,
    forceHalfOpen,
  }
}
`

export const RETRY_STORM_M1_NO_EPOCH = RETRY_STORM_REF.replaceAll('if (reqEpoch === epoch)', 'if (true)')

export const RETRY_STORM_M2_NO_PROBE_LOCK = RETRY_STORM_REF.replace(
  `      if (probeInFlight) {
        throw new Error('Circuit breaker HALF_OPEN probe already in flight')
      }`,
  '',
)

// ── Task 9: event-order ─────────────────────────────────────────────────────
export const EVENT_ORDER_REF = `import { enrichOrderStatus, readOrder, resetOrderRepo, saveOrder, type OrderRecord } from './order-repo'

export type { OrderRecord }

export interface OrderEvent {
  orderId: string
  seq: number
  status: string
}

const queues = new Map<string, Promise<unknown>>()

export function resetProjector(): void {
  queues.clear()
  resetOrderRepo()
}

export async function getOrder(orderId: string): Promise<OrderRecord | null> {
  return readOrder(orderId)
}

export function applyOrderEvent(event: OrderEvent): Promise<OrderRecord> {
  const prev = queues.get(event.orderId) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      const current = await readOrder(event.orderId)
      if (current && event.seq <= current.seq) {
        return current
      }
      const normalized = await enrichOrderStatus(event.status)
      const latest = await readOrder(event.orderId)
      if (latest && event.seq <= latest.seq) {
        return latest
      }
      const next: OrderRecord = {
        orderId: event.orderId,
        seq: event.seq,
        status: normalized,
      }
      await saveOrder(next)
      return { ...next }
    })
  queues.set(event.orderId, task)
  return task
}
`

export const EVENT_ORDER_M1_NO_MONOTONIC = `import { enrichOrderStatus, readOrder, resetOrderRepo, saveOrder, type OrderRecord } from './order-repo'

export type { OrderRecord }

export interface OrderEvent {
  orderId: string
  seq: number
  status: string
}

const queues = new Map<string, Promise<unknown>>()

export function resetProjector(): void {
  queues.clear()
  resetOrderRepo()
}

export async function getOrder(orderId: string): Promise<OrderRecord | null> {
  return readOrder(orderId)
}

// Mutant EO1: serializes queue but drops seq <= current.seq check
export function applyOrderEvent(event: OrderEvent): Promise<OrderRecord> {
  const prev = queues.get(event.orderId) ?? Promise.resolve()
  const task = prev
    .catch(() => {})
    .then(async () => {
      await readOrder(event.orderId)
      const normalized = await enrichOrderStatus(event.status)
      const next: OrderRecord = { orderId: event.orderId, seq: event.seq, status: normalized }
      await saveOrder(next)
      return { ...next }
    })
  queues.set(event.orderId, task)
  return task
}
`

// ── Task 10: cross-module-transfer ──────────────────────────────────────────
export const CROSS_MODULE_TRANSFER_REF = `import { readBalance, resetAccounts, seedAccount, writeBalance } from './account-store'
import { recordTransfer, resetAuditLog } from './audit-log'

const accountLocks = new Map<string, Promise<void>>()

async function withAccountLocks<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(ids)].sort()
  const releases: Array<() => void> = []

  for (const id of sorted) {
    const prev = accountLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    accountLocks.set(id, prev.then(() => gate))
    await prev
    releases.push(release)
  }

  try {
    return await fn()
  } finally {
    for (const release of releases.reverse()) {
      release()
    }
  }
}

export function resetLedger(): void {
  accountLocks.clear()
  resetAccounts()
  resetAuditLog()
}

export function createAccount(accountId: string, initialBalance: number): void {
  seedAccount(accountId, initialBalance)
}

export async function getBalance(accountId: string): Promise<number> {
  return readBalance(accountId)
}

export async function transfer(fromId: string, toId: string, amount: number): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Transfer amount must be a positive integer')
  }
  if (fromId === toId) {
    throw new Error('Cannot transfer to the same account')
  }

  await withAccountLocks([fromId, toId], async () => {
    const fromBal = await readBalance(fromId)
    if (fromBal < amount) {
      throw new Error('Insufficient funds')
    }
    const toBal = await readBalance(toId)
    await writeBalance(fromId, fromBal - amount)
    await writeBalance(toId, toBal + amount)
    await recordTransfer({ fromId, toId, amount })
  })
}
`

// Mutant CM1: locks ONLY fromId (misses concurrent credit / opposite-direction lost update!)
export const CROSS_MODULE_TRANSFER_M1_ONLY_FROM = CROSS_MODULE_TRANSFER_REF.replace(
  'await withAccountLocks([fromId, toId], async () => {',
  'await withAccountLocks([fromId], async () => {',
)

// Additional single-bug mutant for token-session (T1b: fixes re-login overwrite only via epoch on login, forgets to bump/delete on logout!)
export const TOKEN_SESSION_T1B_LOGOUT_BROKEN = `interface SessionRecord {
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

export function resetSessions(): void {
  sessions.clear()
  userEpochs.clear()
  tokenSeq = 0
}

export function login(userId: string): void {
  const epoch = (userEpochs.get(userId) ?? 0) + 1
  userEpochs.set(userId, epoch)
  sessions.set(userId, { userId, token: null, epoch })
}

// Mutant T1b: guards against re-login overwrite (epoch check on login), but forgets to guard logout resurrection!
export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const expectedEpoch = existing.epoch
  const raw = await requestNewToken(userId)
  const verified = await verifyTokenPolicy(userId, raw)
  if ((userEpochs.get(userId) ?? 0) !== expectedEpoch) {
    return null
  }
  sessions.set(userId, { userId, token: verified, epoch: expectedEpoch })
  return verified
}

export async function logout(userId: string): Promise<void> {
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
  sessions.delete(userId)
}
`

// Additional single-bug mutants for single-flight and cancel-commit
export const SINGLE_FLIGHT_M1_STAMPEDE_ONLY = `import { fetchRefreshToken, resetAuthClient } from './auth-client'

const tokenCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

export function resetTokenCache(): void {
  tokenCache.clear()
  inflight.clear()
  resetAuthClient()
}

export function invalidateToken(tenantId: string): void {
  tokenCache.delete(tenantId)
}

// Mutant SF_M1: fixes stampede only, misses in-flight invalidation!
export function getToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId)
  if (cached !== undefined) return Promise.resolve(cached)
  const existing = inflight.get(tenantId)
  if (existing) return existing
  const promise = fetchRefreshToken(tenantId).then((fresh) => {
    tokenCache.set(tenantId, fresh)
    return fresh
  })
  inflight.set(tenantId, promise)
  promise.finally(() => { if (inflight.get(tenantId) === promise) inflight.delete(tenantId) }).catch(() => {})
  return promise
}
`

export const SINGLE_FLIGHT_M2_INVALIDATION_ONLY = `import { fetchRefreshToken, resetAuthClient } from './auth-client'

const tokenCache = new Map<string, string>()
const generations = new Map<string, number>()

export function resetTokenCache(): void {
  tokenCache.clear()
  generations.clear()
  resetAuthClient()
}

export function invalidateToken(tenantId: string): void {
  generations.set(tenantId, (generations.get(tenantId) ?? 0) + 1)
  tokenCache.delete(tenantId)
}

// Mutant SF_M2: fixes in-flight invalidation only, misses concurrent refresh stampede!
export async function getToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId)
  if (cached !== undefined) return cached
  const gen = generations.get(tenantId) ?? 0
  const fresh = await fetchRefreshToken(tenantId)
  if ((generations.get(tenantId) ?? 0) === gen) {
    tokenCache.set(tenantId, fresh)
  }
  return fresh
}
`

export const STALE_CACHE_V9_REVISION = `export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()
const cache = new Map<string, Profile>()
const dbRevisions = new Map<string, number>()
const latestWriteSeq = new Map<string, number>()
let seq = 0

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

async function writeToDb(id: string, profile: Profile, writeSeq: number): Promise<boolean> {
  await yieldIo()
  if ((latestWriteSeq.get(id) ?? 0) > writeSeq) {
    return false
  }
  latestWriteSeq.set(id, writeSeq)
  dbRevisions.set(id, ++seq)
  db.set(id, { ...profile })
  return true
}

async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await yieldIo()
}

export function resetStore(): void {
  db.clear()
  cache.clear()
  dbRevisions.clear()
  latestWriteSeq.clear()
  seq = 0
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  dbRevisions.set(id, ++seq)
  latestWriteSeq.set(id, seq)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startRev = dbRevisions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((dbRevisions.get(id) ?? 0) === startRev) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

export async function updateProfile(id: string, name: string): Promise<Profile> {
  const mySeq = ++seq
  const clean = await validateName(name)
  const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
  const wrote = await writeToDb(id, next, mySeq)
  await auditUpdate(id, next)
  if (wrote && (latestWriteSeq.get(id) ?? 0) === mySeq) {
    dbRevisions.set(id, ++seq)
    cache.set(id, next)
  }
  return { ...next }
}
`

export const P2_REFERENCE_FIXES = {
  'double-submit': { 'src/payment-processor.ts': DOUBLE_SUBMIT_REF },
  'debounce-search': { 'src/search-controller.ts': DEBOUNCE_SEARCH_REF },
  'retry-storm': { 'src/resilient-client.ts': RETRY_STORM_REF },
  'event-order': { 'src/order-projector.ts': EVENT_ORDER_REF },
  'cross-module-transfer': { 'src/ledger.ts': CROSS_MODULE_TRANSFER_REF },
}

export const P2_CALIBRATION_VARIANTS = [
  // double-submit
  { id: 'DS0', task: 'double-submit', expectPass: false, label: 'buggy double-submit', useBaseline: true },
  { id: 'DS1', task: 'double-submit', expectPass: false, label: 'rejection poisons inflight map', files: { 'src/payment-processor.ts': DOUBLE_SUBMIT_POISON } },
  { id: 'DS2', task: 'double-submit', expectPass: true, label: 'reference double-submit fix (shared inflight)', files: { 'src/payment-processor.ts': DOUBLE_SUBMIT_REF } },
  { id: 'DS3', task: 'double-submit', expectPass: true, label: 'D-05 design-diverse per-key queue fix', files: { 'src/payment-processor.ts': DOUBLE_SUBMIT_QUEUE_REF } },

  // debounce-search
  { id: 'DB0', task: 'debounce-search', expectPass: false, label: 'buggy debounce-search', useBaseline: true },
  { id: 'DB1', task: 'debounce-search', expectPass: false, label: 'fixes stale order only, misses dispose', files: { 'src/search-controller.ts': DEBOUNCE_SEARCH_M1_NO_DISPOSE } },
  { id: 'DB2', task: 'debounce-search', expectPass: false, label: 'fixes dispose only, misses stale order', files: { 'src/search-controller.ts': DEBOUNCE_SEARCH_M2_NO_SEQ } },
  { id: 'DB3', task: 'debounce-search', expectPass: true, label: 'reference debounce-search fix', files: { 'src/search-controller.ts': DEBOUNCE_SEARCH_REF } },

  // retry-storm
  { id: 'RS0', task: 'retry-storm', expectPass: false, label: 'buggy retry-storm', useBaseline: true },
  { id: 'RS1', task: 'retry-storm', expectPass: false, label: 'fixes probe storm only, misses stale failure', files: { 'src/resilient-client.ts': RETRY_STORM_M1_NO_EPOCH } },
  { id: 'RS2', task: 'retry-storm', expectPass: false, label: 'fixes stale failure only, misses probe storm', files: { 'src/resilient-client.ts': RETRY_STORM_M2_NO_PROBE_LOCK } },
  { id: 'RS3', task: 'retry-storm', expectPass: true, label: 'reference retry-storm fix', files: { 'src/resilient-client.ts': RETRY_STORM_REF } },

  // event-order
  { id: 'EO0', task: 'event-order', expectPass: false, label: 'buggy event-order', useBaseline: true },
  { id: 'EO1', task: 'event-order', expectPass: false, label: 'serializes queue but drops monotonic seq check', files: { 'src/order-projector.ts': EVENT_ORDER_M1_NO_MONOTONIC } },
  { id: 'EO2', task: 'event-order', expectPass: true, label: 'reference event-order fix', files: { 'src/order-projector.ts': EVENT_ORDER_REF } },

  // cross-module-transfer
  { id: 'CM0', task: 'cross-module-transfer', expectPass: false, label: 'buggy cross-module-transfer', useBaseline: true },
  { id: 'CM1', task: 'cross-module-transfer', expectPass: false, label: 'locks only fromId (loses concurrent credit)', files: { 'src/ledger.ts': CROSS_MODULE_TRANSFER_M1_ONLY_FROM } },
  { id: 'CM2', task: 'cross-module-transfer', expectPass: true, label: 'reference cross-module-transfer fix', files: { 'src/ledger.ts': CROSS_MODULE_TRANSFER_REF } },

  // Also verify T1b fails token-session grader
  { id: 'T1b', task: 'token-session', expectPass: false, label: 'fixes re-login only, misses logout resurrection', files: { 'src/session-manager.ts': TOKEN_SESSION_T1B_LOGOUT_BROKEN } },
]
