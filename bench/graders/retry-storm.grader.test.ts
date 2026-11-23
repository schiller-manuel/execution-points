import { describe, expect, test } from 'vitest'
import { createYieldScheduler } from './yield-engine.mjs'
import { getUpstreamCallCount, resetUpstream, setUpstreamFailures } from './src/upstream'
import { createResilientClient } from './src/resilient-client'

describe('hidden oracle grader: retry-storm (yield-engine)', () => {
  test('allows at most 1 in-flight probe in HALF_OPEN and rejects extra concurrent callers', async () => {
    for (const mode of ['first', 'last', 'alt'] as const) {
      resetUpstream()
      setUpstreamFailures(2)
      const client = createResilientClient(2)
      await expect(client.request('f1')).rejects.toThrow()
      await expect(client.request('f2')).rejects.toThrow()
      expect(client.getState()).toBe('OPEN')
      const beforeProbeCalls = getUpstreamCallCount()

      client.forceHalfOpen()
      expect(client.getState()).toBe('HALF_OPEN')

      const successes: string[] = []
      const failures: string[] = []
      const sched = createYieldScheduler()
      for (let i = 0; i < 3; i++) {
        sched.spawn(
          i,
          async () => {
            try {
              successes.push(await client.request(`p${i}`))
            } catch (err) {
              failures.push((err as Error).message)
            }
          },
          { atStep: 0 },
        )
      }
      let step = 0
      await sched.run((ready) => {
        if (mode === 'first') return ready[0]
        if (mode === 'last') return ready[ready.length - 1]
        return ready[step++ % ready.length]
      })

      expect(getUpstreamCallCount() - beforeProbeCalls).toBe(1)
      expect(successes.length).toBe(1)
      expect(failures.length).toBe(2)
      expect(client.getState()).toBe('CLOSED')
    }
  })

  test('failed HALF_OPEN probe re-opens circuit and releases probe lock for next half-open attempt', async () => {
    resetUpstream()
    setUpstreamFailures(3)
    const client = createResilientClient(2)
    await expect(client.request('f1')).rejects.toThrow()
    await expect(client.request('f2')).rejects.toThrow()
    client.forceHalfOpen()

    await expect(client.request('bad-probe')).rejects.toThrow('Upstream 503')
    expect(client.getState()).toBe('OPEN')

    client.forceHalfOpen()
    expect(await client.request('good-probe')).toBe('ok:good-probe')
    expect(client.getState()).toBe('CLOSED')
  })

  test('stale failure from an earlier breaker epoch never re-trips a recovered CLOSED breaker', async () => {
    // At failStep=1, queue 0 has entered callUpstream (consuming failure #1) and is parked
    // inside yieldIo() while queue 1 trips the breaker (failures #2 & #3) and recovers it!
    resetUpstream()
    setUpstreamFailures(3)
    const client = createResilientClient(2)

    const sched = createYieldScheduler()
    sched.spawn(
      0,
      async () => {
        try {
          await client.request('stale-fail')
        } catch {
          // expected upstream failure
        }
      },
      { atStep: 0 },
    )
    sched.spawn(
      1,
      async () => {
        await expect(client.request('trip1')).rejects.toThrow()
        await expect(client.request('trip2')).rejects.toThrow()
        expect(client.getState()).toBe('OPEN')
        client.forceHalfOpen()
        expect(await client.request('recover')).toBe('ok:recover')
        expect(client.getState()).toBe('CLOSED')
      },
      { atStep: 1 },
    )

    let q0Steps = 0
    await sched.run((ready) => {
      if (q0Steps < 1 && ready.includes(0)) {
        q0Steps++
        return 0
      }
      if (ready.includes(1)) return 1
      return ready[0]
    })

    // Breaker MUST remain healthy CLOSED even after stale failure from epoch 0 finishes!
    expect(client.getState()).toBe('CLOSED')
    // One fresh failure (with threshold=2) must STILL keep it CLOSED (not immediately OPEN due to stale count!)
    setUpstreamFailures(1)
    await expect(client.request('single-new-fail')).rejects.toThrow()
    expect(client.getState()).toBe('CLOSED')
  })
})
