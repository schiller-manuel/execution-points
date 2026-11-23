import { afterEach, describe, expect, test, vi } from 'vitest'
import { createYieldScheduler } from './yield-engine.mjs'
import { resetSearchApi } from './src/search-api'
import { createSearchController } from './src/search-controller'

afterEach(() => {
  vi.useRealTimers()
})

describe('hidden oracle grader: debounce-search (yield-engine + timers)', () => {
  test('cancels pending debounce timer on dispose()', async () => {
    vi.useFakeTimers()
    resetSearchApi()
    const ctrl = createSearchController(50)
    ctrl.onInput('hello')
    await vi.advanceTimersByTimeAsync(20)
    ctrl.dispose()
    await vi.advanceTimersByTimeAsync(100)
    await ctrl.flush()

    const snap = ctrl.getSnapshot()
    expect(snap.disposed).toBe(true)
    expect(snap.query).toBe('')
    expect(snap.results).toEqual([])
  })

  test('older in-flight search resolving late never overwrites newer query results', async () => {
    const strategies: Array<(ready: number[], step: number) => number> = [
      (r) => r[0],
      (r) => r[r.length - 1],
      (r, s) => r[s % r.length],
      // Advance search 1 partway, let search 2 finish completely, then resume search 1
      (r, s) => (s < 2 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 3 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
    ]

    for (const pick of strategies) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      resetSearchApi()
      const ctrl = createSearchController(10)
      const sched = createYieldScheduler()

      sched.spawn(
        0,
        async () => {
          ctrl.onInput('first')
          vi.advanceTimersByTime(10)
          await ctrl.flush()
        },
        { atStep: 0 },
      )
      sched.spawn(
        1,
        async () => {
          ctrl.onInput('second')
          vi.advanceTimersByTime(10)
          await ctrl.flush()
        },
        { atStep: 1 },
      )

      let step = 0
      await sched.run((ready) => pick(ready, step++))
      vi.useRealTimers()

      const snap = ctrl.getSnapshot()
      expect(snap.query).toBe('second')
      expect(snap.results[0]).toMatch(/^second:result-/)
    }
  })

  test('in-flight search completing after dispose() never mutates snapshot', async () => {
    for (const disposeStep of [1, 2, 3]) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      resetSearchApi()
      const ctrl = createSearchController(10)
      const sched = createYieldScheduler()

      sched.spawn(
        0,
        async () => {
          ctrl.onInput('in-flight')
          vi.advanceTimersByTime(10)
          await ctrl.flush()
        },
        { atStep: 0 },
      )
      sched.spawn(
        1,
        async () => {
          ctrl.dispose()
        },
        { atStep: disposeStep },
      )

      await sched.run((ready) => ready[ready.length - 1])
      vi.useRealTimers()
      const snap = ctrl.getSnapshot()
      expect(snap.disposed).toBe(true)
      expect(snap.query).toBe('')
      expect(snap.results).toEqual([])
    }
  })
})
