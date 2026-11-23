import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { countYields, createYieldScheduler } from './yield-engine.mjs'
import {
  getActiveToken,
  login,
  logout,
  resetSessions,
} from './src/session-manager'

describe('hidden oracle grader: token-session (yield-engine)', () => {
  test('preserves baseline behavior, async I/O yields, and caches active tokens', async () => {
    resetSessions()
    expect(await getActiveToken('alice')).toBeNull()

    login('alice')
    const ioSite = /#(requestNewToken|verifyTokenPolicy|prepareRevocation|notifyAuthServer|flushAuditLog|yieldIo):/
    const { result: tok1, yields: coldYields } = await countYields(() => getActiveToken('alice'), {
      matchSite: ioSite,
    })
    expect(tok1).toBeTruthy()
    expect(coldYields).toBeGreaterThanOrEqual(2)

    const { result: tok2, yields } = await countYields(() => getActiveToken('alice'), {
      matchSite: ioSite,
    })
    expect(tok2).toBe(tok1)
    expect(yields).toBe(0)

    const { yields: logoutYields } = await countYields(() => logout('alice'), {
      matchSite: ioSite,
    })
    expect(logoutYields).toBeGreaterThanOrEqual(3)
    expect(await getActiveToken('alice')).toBeNull()
  })

  test('concurrent getActiveToken + logout never resurrects logged-out session', async () => {
    const priorities: Array<'first' | 'last' | 'alt'> = ['first', 'last', 'alt']
    for (const logoutStep of [0, 1, 2, 3]) {
      for (const mode of priorities) {
        resetSessions()
        login('alice')
        const sched = createYieldScheduler()
        sched.spawn(0, () => getActiveToken('alice'), { atStep: 0 })
        sched.spawn(1, () => logout('alice'), { atStep: logoutStep })
        let step = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[step++ % ready.length]
        })
        expect(await getActiveToken('alice')).toBeNull()
      }
    }
  })

  test('old in-flight token fetch never overwrites a new session after logout + re-login', async () => {
    const strategies: Array<(ready: number[], step: number) => number> = [
      (r) => r[0],
      (r) => r[r.length - 1],
      (r, s) => r[s % r.length],
      // Advance old fetch partway, let logout+relogin+new fetch complete, then resume old fetch
      (r, s) => (s < 1 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 2 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
      (r, s) => (s < 3 && r.includes(0) ? 0 : r.includes(1) ? 1 : r[0]),
    ]

    for (const reloginStep of [0, 1, 2]) {
      for (const pick of strategies) {
        resetSessions()
        login('alice')
        let oldToken: string | null = null
        let newToken: string | null = null
        const sched = createYieldScheduler()
        sched.spawn(
          0,
          async () => {
            oldToken = await getActiveToken('alice')
          },
          { atStep: 0 },
        )
        sched.spawn(
          1,
          async () => {
            await logout('alice')
            login('alice')
            newToken = await getActiveToken('alice')
          },
          { atStep: reloginStep },
        )
        let step = 0
        await sched.run((ready) => pick(ready, step++))

        const finalToken = await getActiveToken('alice')
        expect(newToken).toBeTruthy()
        expect(finalToken).toBe(newToken)
        if (oldToken !== null) {
          expect(finalToken).not.toBe(oldToken)
        }
      }
    }
  })

  test('multi-user isolation: logging out bob never invalidates or denies alice (catches T5)', async () => {
    const priorities: Array<'first' | 'last' | 'alt'> = ['first', 'last', 'alt']
    for (const bobStep of [0, 1, 2]) {
      for (const mode of priorities) {
        resetSessions()
        login('alice')
        login('bob')
        let aliceTok: string | null = null
        const sched = createYieldScheduler()
        sched.spawn(
          0,
          async () => {
            aliceTok = await getActiveToken('alice')
          },
          { atStep: 0 },
        )
        sched.spawn(
          1,
          async () => {
            await logout('bob')
          },
          { atStep: bobStep },
        )
        let step = 0
        await sched.run((ready) => {
          if (mode === 'first') return ready[0]
          if (mode === 'last') return ready[ready.length - 1]
          return ready[step++ % ready.length]
        })

        expect(aliceTok).toBeTruthy()
        expect(await getActiveToken('alice')).toBe(aliceTok)
        expect(await getActiveToken('bob')).toBeNull()
      }
    }
  })

  test('randomized schedules across multi-user login/logout/fetch interleavings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 40, maxLength: 80 }),
        fc.integer({ min: 0, max: 2 }),
        async (picks, delay) => {
          resetSessions()
          login('alice')
          login('bob')
          let aliceOld: string | null = null
          let aliceNew: string | null = null
          let bobTok: string | null = null

          const sched = createYieldScheduler()
          sched.spawn(
            0,
            async () => {
              aliceOld = await getActiveToken('alice')
            },
            { atStep: 0 },
          )
          sched.spawn(
            1,
            async () => {
              await logout('alice')
              login('alice')
              aliceNew = await getActiveToken('alice')
            },
            { atStep: delay },
          )
          sched.spawn(
            2,
            async () => {
              bobTok = await getActiveToken('bob')
            },
            { atStep: 0 },
          )

          let idx = 0
          await sched.run((ready) => ready[picks[idx++ % picks.length] % ready.length])

          expect(aliceNew).toBeTruthy()
          expect(await getActiveToken('alice')).toBe(aliceNew)
          if (aliceOld !== null) {
            expect(await getActiveToken('alice')).not.toBe(aliceOld)
          }
          expect(bobTok).toBeTruthy()
          expect(await getActiveToken('bob')).toBe(bobTok)
        },
      ),
      { numRuns: 30, seed: 4242 },
    )
  })
})
