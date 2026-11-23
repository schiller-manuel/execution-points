/**
 * Grader-owned deterministic async interleaving engine.
 *
 * Completely independent of `execution-points-prototype` (no tool-under-test
 * bias): works with `bench/graders/yield-plugin.mjs`, which wraps every `await`
 * operand in every non-test file under `src/` with `__benchYield(site, async () => (expr))`.
 *
 * Supports:
 * - Lazy effects: `thunk()` is not called until the scheduler releases the parked task.
 * - Staggered starts: operations can be launched after `k` scheduler steps so
 *   reads can start inside an in-flight update window (catching V1's residual race).
 * - Multi-step real async I/O (MessageChannel, fs/promises, timers): tracks
 *   in-flight thunks so the scheduler waits for real I/O before declaring deadlock.
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

export function createYieldScheduler(choices = [], { maxSteps = 400 } = {}) {
  const parked = []
  const startedOps = []
  const stagedStarts = []
  const historyLog = []
  let activeIo = 0
  let wakeWaiters = []
  let stepIndex = 0
  let totalYields = 0
  let done = false

  function notifyWake() {
    if (wakeWaiters.length === 0) return
    const waiters = wakeWaiters
    wakeWaiters = []
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
    // Prevent unhandled rejection warnings while scheduler is stepping
    entry.promise.catch(() => {})
    startedOps.push(entry)
    return entry
  }

  function flushStagedStarts() {
    for (let i = stagedStarts.length - 1; i >= 0; i--) {
      if (stagedStarts[i].atStep <= stepIndex) {
        const [item] = stagedStarts.splice(i, 1)
        item.resolveEntry(launchOp(item.queueId, item.fn))
      }
    }
  }

  async function settleRunnable() {
    // Let microtasks and fast continuations reach their next park/settlement.
    // Only wait on activeIo when NO queue is parked (so a cross-queue lock/mutex
    // where queue B awaits a promise owned by parked queue A can never deadlock!).
    await nextTickTurn()
    await nextTickTurn()
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

    enterIo() {
      activeIo += 1
    },

    leaveIo() {
      activeIo = Math.max(0, activeIo - 1)
      if (activeIo === 0) notifyWake()
    },

    /** Wait on a real timer while keeping activeIo > 0 so deadlock detection waits for it. */
    async waitTimer(ms) {
      scheduler.enterIo()
      try {
        await new Promise((resolve) => setTimeout(resolve, ms))
      } finally {
        scheduler.leaveIo()
      }
    },

    /** Launch an operation immediately (step 0) or staggered at `atStep`. */
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
      return entryPromise.then((e) => e.promise)
    },

    async run(picker) {
      flushStagedStarts()
      await settleRunnable()

      while (true) {
        flushStagedStarts()
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
          typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
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

/**
 * Count how many `__benchYield` suspension points an operation hits without
 * changing its interleaving (used to verify warm-cache hits perform 0 async DB reads).
 */
export async function countYields(fn) {
  let count = 0
  const counter = {
    park() {
      count += 1
      return Promise.resolve()
    },
    enterIo() {},
    leaveIo() {},
  }
  const value = await state.storage.run({ scheduler: counter, queueId: 'count' }, fn)
  return { value, count, result: value, yields: count }
}

/**
 * Injected by `yield-plugin.mjs` around every `await expr` in non-test `src/` files.
 */
export async function __benchYield(site, thunk) {
  const ctx = state.storage.getStore()
  if (!ctx) return await thunk()

  await ctx.scheduler.park(ctx.queueId, `before:${site}`, ctx.ioDepth ?? 0)
  ctx.ioDepth = (ctx.ioDepth ?? 0) + 1
  ctx.scheduler.enterIo()
  let value
  try {
    value = await thunk()
  } finally {
    ctx.ioDepth -= 1
    ctx.scheduler.leaveIo()
  }
  await ctx.scheduler.park(ctx.queueId, `after:${site}`, ctx.ioDepth ?? 0)
  return value
}
