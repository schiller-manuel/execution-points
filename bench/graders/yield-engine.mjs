/**
 * Grader-owned deterministic async interleaving engine (harness v2.5; the engine itself
 * is unchanged since v2.2 — eager2 + leaf I/O).
 *
 * Fixes N-11, N-14, N-15, N-16, N-17, N-19, N-20:
 * - Eager operand evaluation (N-14): evaluates `thunk()` immediately on `await`,
 *   matching JavaScript semantics; only continuation resumption is scheduled.
 * - Rejection parking (N-17): parks resumption on BOTH fulfillment and rejection.
 * - Staged-start settlement (N-15): newly launched staged operations settle their
 *   synchronous prefix to their first park before the next scheduling pick.
 * - Leaf I/O tracking (N-19): waits for leaf I/O (`fs.*`, `yieldIo()`) before
 *   every pick so real-fs oracle verdicts are deterministic across machine load.
 * - Site-filtered `countYields` (N-11): counts only I/O helper yields on warm
 *   paths so valid per-key serialization queues pass cleanly.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const engineKey = Symbol.for('execution-points.bench.yield-engine.v2')
const state =
  globalThis[engineKey] ??
  Object.defineProperty(globalThis, engineKey, {
    value: {
      storage: new AsyncLocalStorage(),
    },
  })[engineKey]

const nextTickTurn = () => new Promise((resolve) => setImmediate(resolve))

export function createYieldScheduler(choices = [], { maxSteps = 500 } = {}) {
  const parked = []
  const startedOps = []
  const stagedStarts = []
  const historyLog = []
  let activeIo = 0
  let activeLeafIo = 0
  let wakeWaiters = []
  let leafZeroWaiters = []
  let stepIndex = 0
  let totalYields = 0
  let done = false

  function notifyWake() {
    if (wakeWaiters.length === 0) return
    const waiters = wakeWaiters
    wakeWaiters = []
    for (const w of waiters) w()
  }

  function notifyLeafZero() {
    if (activeLeafIo > 0 || leafZeroWaiters.length === 0) return
    const waiters = leafZeroWaiters
    leafZeroWaiters = []
    for (const w of waiters) w()
  }

  function waitForActivity(timeoutMs = 2000) {
    if (parked.length > 0 || activeIo === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(finish, timeoutMs)
      wakeWaiters.push(finish)
    })
  }

  function waitForLeafIoZero(timeoutMs = 2000) {
    if (activeLeafIo === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(finish, timeoutMs)
      leafZeroWaiters.push(finish)
    })
  }

  function launchOp(queueId, fn) {
    const entry = { queueId, settled: false, value: undefined, error: undefined }
    const ctx = { scheduler, queueId, ioDepth: 0 }
    const promise = state.storage.run(ctx, () => Promise.resolve().then(fn))
    entry.promise = promise.then(
      (v) => {
        entry.settled = true
        entry.value = v
        return v
      },
      (err) => {
        entry.settled = true
        entry.error = err
        throw err
      },
    )
    entry.promise.catch(() => {})
    startedOps.push(entry)
    return entry
  }

  function flushStagedStarts() {
    let launched = 0
    for (let i = stagedStarts.length - 1; i >= 0; i--) {
      if (stagedStarts[i].atStep <= stepIndex) {
        const [item] = stagedStarts.splice(i, 1)
        item.resolveEntry(launchOp(item.queueId, item.fn))
        launched += 1
      }
    }
    return launched
  }

  async function settleRunnable() {
    await nextTickTurn()
    if (activeLeafIo > 0) {
      await waitForLeafIoZero(2000)
    }
    await nextTickTurn()
    if (activeLeafIo > 0) {
      await waitForLeafIoZero(2000)
      await nextTickTurn()
    }
    if (parked.length === 0 && activeIo > 0) {
      await waitForActivity(2000)
      await nextTickTurn()
      await nextTickTurn()
    }
  }

  const scheduler = {
    park(queueId, label, suspendedDepth = 0) {
      totalYields += 1
      if (done) return Promise.resolve()
      if (suspendedDepth > 0) {
        activeIo = Math.max(0, activeIo - suspendedDepth)
      }
      return new Promise((resolve) => {
        parked.push({
          queueId,
          label,
          resolve: () => {
            if (suspendedDepth > 0) {
              activeIo += suspendedDepth
            }
            resolve()
          },
        })
        notifyWake()
      })
    },

    enterIo(isLeaf = false) {
      activeIo += 1
      if (isLeaf) activeLeafIo += 1
    },

    leaveIo(isLeaf = false) {
      activeIo = Math.max(0, activeIo - 1)
      if (isLeaf) {
        activeLeafIo = Math.max(0, activeLeafIo - 1)
        if (activeLeafIo === 0) notifyLeafZero()
      }
      if (activeIo === 0) notifyWake()
    },

    async waitTimer(ms) {
      scheduler.enterIo(true)
      try {
        await new Promise((resolve) => setTimeout(resolve, ms))
      } finally {
        scheduler.leaveIo(true)
      }
    },

    spawn(queueId, fn, { atStep = 0 } = {}) {
      if (atStep <= stepIndex) {
        const entry = launchOp(queueId, fn)
        return entry.promise
      }
      let resolveEntry
      const entryPromise = new Promise((res) => {
        resolveEntry = res
      })
      stagedStarts.push({ atStep, queueId, fn, resolveEntry })
      const out = entryPromise.then((e) => e.promise)
      out.catch(() => {})
      return out
    },

    async run(picker) {
      flushStagedStarts()
      await settleRunnable()

      while (true) {
        if (flushStagedStarts() > 0) {
          await settleRunnable()
          continue
        }
        const unsettled = startedOps.filter((o) => !o.settled)
        if (unsettled.length === 0 && stagedStarts.length === 0) break

        if (parked.length === 0) {
          if (stagedStarts.length > 0 && unsettled.length === 0) {
            stepIndex = Math.min(...stagedStarts.map((s) => s.atStep))
            flushStagedStarts()
            await settleRunnable()
            continue
          }
          for (let i = 0; i < 20 && parked.length === 0 && startedOps.some((o) => !o.settled); i++) {
            await nextTickTurn()
          }
          if (parked.length === 0 && startedOps.some((o) => !o.settled)) {
            done = true
            throw new Error(
              `Deadlock detected at step ${stepIndex}: ${startedOps.filter((o) => !o.settled).map((o) => o.queueId).join(', ')} remained unsettled with no parked yields.`,
            )
          }
          continue
        }

        if (stepIndex >= maxSteps) {
          done = true
          throw new Error(`Exceeded maxSteps (${maxSteps}) without completing operations.`)
        }

        const queues = [...new Set(parked.map((p) => p.queueId))].sort((a, b) =>
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b)),
        )
        let targetQueue
        if (typeof picker === 'function') {
          targetQueue = picker(queues, stepIndex)
          if (!queues.includes(targetQueue)) targetQueue = queues[0]
        } else {
          const rawChoice = choices[stepIndex]
          targetQueue = rawChoice === undefined ? queues[0] : queues[rawChoice % queues.length]
        }
        const idx = parked.findIndex((p) => p.queueId === targetQueue)
        const [item] = parked.splice(idx, 1)

        historyLog.push(`${stepIndex}:${item.queueId}:${item.label}`)
        stepIndex += 1
        item.resolve()
        await settleRunnable()
      }

      done = true
      const firstErr = startedOps.find((o) => o.error !== undefined)
      if (firstErr) throw firstErr.error
      return {
        steps: stepIndex,
        totalYields,
        historyLog,
      }
    },

    async runToCompletion() {
      return scheduler.run()
    },

    getTotalYields() {
      return totalYields
    },
  }

  return scheduler
}

export async function countYields(fn, { matchSite } = {}) {
  let count = 0
  const sites = []
  const counter = {
    park(_q, label) {
      const site = label.replace(/^after:/, '')
      sites.push(site)
      if (
        !matchSite ||
        (matchSite instanceof RegExp ? matchSite.test(site) : matchSite(site))
      ) {
        count += 1
      }
      return Promise.resolve()
    },
    enterIo() {},
    leaveIo() {},
  }
  const value = await state.storage.run({ scheduler: counter, queueId: 'count', ioDepth: 0 }, fn)
  return { value, count, result: value, yields: count, sites }
}

export async function __benchYield(site, thunk, isLeaf = false) {
  const ctx = state.storage.getStore()
  if (!ctx) return await thunk()

  ctx.ioDepth = (ctx.ioDepth ?? 0) + 1
  ctx.scheduler.enterIo(isLeaf)
  let value
  let error
  let failed = false
  try {
    value = await thunk()
  } catch (err) {
    failed = true
    error = err
  } finally {
    ctx.ioDepth -= 1
    ctx.scheduler.leaveIo(isLeaf)
  }
  await ctx.scheduler.park(ctx.queueId, `after:${site}`, ctx.ioDepth ?? 0)
  if (failed) throw error
  return value
}
