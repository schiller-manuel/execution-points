/**
 * Hidden concurrency grader for the `token-session` benchmark task.
 *
 * Uses `execution-points-prototype` + `@tanstack/oracles` (`scheduleFrom`) to
 * interleave `requestNewToken`, `verifyTokenPolicy`, `prepareRevocation`,
 * `notifyAuthServer`, and `flushAuditLog` across concurrent `getActiveToken`,
 * `logout`, and `login` operations.
 */
import fc from 'fast-check'
import { differs, oracleProperty, pass, scheduleFrom } from '@tanstack/oracles'
import { select } from 'execution-points-prototype'
import { getActiveToken, login, logout, resetSessions } from './src/session-manager'

const requestPoint = select('src/session-manager.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'requestNewToken' ? n : undefined,
)
const verifyPoint = select('src/session-manager.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'verifyTokenPolicy' ? n : undefined,
)
const preparePoint = select('src/session-manager.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'prepareRevocation' ? n : undefined,
)
const notifyPoint = select('src/session-manager.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'notifyAuthServer' ? n : undefined,
)
const flushPoint = select('src/session-manager.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'flushAuditLog' ? n : undefined,
)

function withScheduledIo<T>(
  scheduler: ReturnType<typeof scheduleFrom>,
  queueName: string,
  called: Set<string>,
  action: () => Promise<T>,
): Promise<T> {
  const wrap = (name: string) => ({ original }: { original: () => Promise<unknown> }) => {
    called.add(name)
    return scheduler.schedule(original(), `${queueName} ${name}`, queueName)
  }
  return requestPoint.withReplacement(wrap('requestNewToken') as never, () =>
    verifyPoint.withReplacement(wrap('verifyTokenPolicy') as never, () =>
      preparePoint.withReplacement(wrap('prepareRevocation') as never, () =>
        notifyPoint.withReplacement(wrap('notifyAuthServer') as never, () =>
          flushPoint.withReplacement(wrap('flushAuditLog') as never, action),
        ),
      ),
    ),
  )
}

interface TokenSessionHistory {
  scenario: 'fetch-vs-logout' | 'fetch-vs-logout-and-relogin'
  choices: Array<number>
}

const tokenSessionArbitrary: fc.Arbitrary<TokenSessionHistory> = fc.record({
  scenario: fc.constantFrom('fetch-vs-logout', 'fetch-vs-logout-and-relogin'),
  choices: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 5, maxLength: 16 }),
})

oracleProperty({
  id: 'grader-token-session-concurrency',
  law: {
    statement:
      'For every interleaving of getActiveToken(userId), logout(userId), and subsequent login(userId), all simulated async I/O helpers run, logout prevents session resurrection, and a stale fetch from a prior session never overwrites a re-logged-in session token.',
    authority: 'bench/tasks/token-session/PROMPT.md',
    limits: 'Single-user schedules over requestNewToken, verifyTokenPolicy, prepareRevocation, notifyAuthServer, and flushAuditLog.',
  },
  histories: {
    arbitrary: tokenSessionArbitrary,
    runs: 40,
    fixedSeeds: [42],
    states: ['fetch-vs-logout', 'fetch-vs-logout-and-relogin'],
    constructed: [
      {
        name: 'resurrect-after-logout',
        enters: ['fetch-vs-logout'],
        // Release requestNewToken (q-tok1), then all 3 logout steps (q-logout), then verifyTokenPolicy (q-tok1)
        build: () => ({ scenario: 'fetch-vs-logout', choices: [0, 1, 1, 1, 0, 0] }),
      },
      {
        name: 'stale-fetch-overwrites-relogin',
        enters: ['fetch-vs-logout-and-relogin'],
        // Release requestNewToken (q-tok1), then complete logout -> login -> tok2, then release verifyTokenPolicy (q-tok1)
        build: () => ({ scenario: 'fetch-vs-logout-and-relogin', choices: [0, 1, 1, 1, 1, 1, 0, 0] }),
      },
    ],
  },
  model: (history) => ({
    validFinalState: true,
    usedAllRequiredHelpers: true,
    noErrors: true,
    scenario: history.scenario,
  }),
  driver: async (history, observe) => {
    resetSessions()
    login('u1')
    const scheduler = scheduleFrom(history.choices)
    const called = new Set<string>()
    observe('reach', history.scenario)

    try {
      const required = [
        'requestNewToken',
        'verifyTokenPolicy',
        'prepareRevocation',
        'notifyAuthServer',
        'flushAuditLog',
      ]

      if (history.scenario === 'fetch-vs-logout') {
        const tokP = withScheduledIo(scheduler, 'q-tok1', called, () => getActiveToken('u1'))
        const outP = withScheduledIo(scheduler, 'q-logout', called, () => logout('u1'))
        await scheduler.waitIdle()
        await Promise.all([tokP, outP])

        const after = await getActiveToken('u1')
        observe('outcome', {
          validFinalState: after === null,
          usedAllRequiredHelpers: required.every((h) => called.has(h)),
          noErrors: true,
          scenario: history.scenario,
        })
        return
      }

      // fetch-vs-logout-and-relogin:
      // Queue q-tok1 runs first session's getActiveToken.
      // Queue q-session2 chains logout -> login -> getActiveToken so re-login always runs strictly after logout!
      const tok1P = withScheduledIo(scheduler, 'q-tok1', called, () => getActiveToken('u1'))
      const reloginFlowP = (async () => {
        await withScheduledIo(scheduler, 'q-session2', called, () => logout('u1'))
        login('u1')
        return await withScheduledIo(scheduler, 'q-session2', called, () => getActiveToken('u1'))
      })()

      await scheduler.waitIdle()
      const [tok1, tok2] = await Promise.all([tok1P, reloginFlowP])
      const after = await getActiveToken('u1')

      // After logout -> login -> tok2, the active token must be tok2 (non-null),
      // and must NOT have been overwritten by tok1 (if tok1 returned a different old token).
      const validFinalState =
        typeof tok2 === 'string' &&
        tok2.length > 0 &&
        after === tok2 &&
        (tok1 === null || tok1 !== tok2)

      observe('outcome', {
        validFinalState,
        usedAllRequiredHelpers: required.every((h) => called.has(h)),
        noErrors: true,
        scenario: history.scenario,
      })
    } catch (err) {
      observe('outcome', {
        validFinalState: false,
        usedAllRequiredHelpers: false,
        noErrors: false,
        scenario: history.scenario,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'outcome')
    if (!entry) return differs('outcome', 'token-session-concurrency', undefined, expected) ?? pass
    return differs('outcome', 'token-session-concurrency', entry.value, expected) ?? pass
  },
})
