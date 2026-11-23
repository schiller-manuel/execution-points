/**
 * Hidden concurrency grader for the `stale-cache` benchmark task.
 *
 * Uses `execution-points-prototype` + `@tanstack/oracles` (`scheduleFrom`) to
 * intercept every internal async I/O helper in `src/profile-store.ts` and
 * systematically explore promise interleavings without deadlocking valid
 * lock-based or epoch-based fixes.
 */
import fc from 'fast-check'
import { differs, oracleProperty, pass, scheduleFrom } from '@tanstack/oracles'
import { select } from 'execution-points-prototype'
import { getProfile, resetStore, seedProfile, updateProfile } from './src/profile-store'

const readPoint = select('src/profile-store.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'readFromDb' ? n : undefined,
)
const formatPoint = select('src/profile-store.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'formatProfile' ? n : undefined,
)
const validatePoint = select('src/profile-store.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'validateName' ? n : undefined,
)
const writePoint = select('src/profile-store.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'writeToDb' ? n : undefined,
)
const auditPoint = select('src/profile-store.ts', (n) =>
  n.kind === 'CallExpression' && n.callee === 'auditUpdate' ? n : undefined,
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
  return readPoint.withReplacement(wrap('readFromDb') as never, () =>
    formatPoint.withReplacement(wrap('formatProfile') as never, () =>
      validatePoint.withReplacement(wrap('validateName') as never, () =>
        writePoint.withReplacement(wrap('writeToDb') as never, () =>
          auditPoint.withReplacement(wrap('auditUpdate') as never, action),
        ),
      ),
    ),
  )
}

interface StaleCacheHistory {
  scenario: 'read-vs-update' | 'concurrent-two-updates' | 'read-vs-two-updates'
  choices: Array<number>
}

const staleCacheArbitrary: fc.Arbitrary<StaleCacheHistory> = fc.record({
  scenario: fc.constantFrom('read-vs-update', 'concurrent-two-updates', 'read-vs-two-updates'),
  choices: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 4, maxLength: 16 }),
})

oracleProperty({
  id: 'grader-stale-cache-concurrency',
  law: {
    statement:
      'For every interleaving of cold-cache getProfile(id) and overlapping updateProfile(id, name) calls, all simulated async I/O helpers run and subsequent getProfile(id) returns the latest update.',
    authority: 'bench/tasks/stale-cache/PROMPT.md',
    limits: 'Single-key concurrency schedules over readFromDb, formatProfile, validateName, writeToDb, and auditUpdate.',
  },
  histories: {
    arbitrary: staleCacheArbitrary,
    runs: 40,
    fixedSeeds: [42],
    states: ['read-vs-update', 'concurrent-two-updates', 'read-vs-two-updates'],
    constructed: [
      {
        name: 'poison-cache-after-update',
        enters: ['read-vs-update'],
        // Choice 0 releases readFromDb on q-read; then choices 1,1,1 release all 3 steps of q-update before q-read's formatProfile!
        build: () => ({ scenario: 'read-vs-update', choices: [0, 1, 1, 1, 0, 0] }),
      },
      {
        name: 'out-of-order-updates',
        enters: ['concurrent-two-updates'],
        // Let u2 (queue 1) complete writeToDb + auditUpdate before u1 (queue 0) finishes auditUpdate
        build: () => ({ scenario: 'concurrent-two-updates', choices: [0, 0, 1, 1, 1, 0, 0] }),
      },
      {
        name: 'read-and-two-updates',
        enters: ['read-vs-two-updates'],
        build: () => ({ scenario: 'read-vs-two-updates', choices: [0, 2, 2, 2, 1, 1, 1, 0, 0] }),
      },
    ],
  },
  model: (history) => ({
    finalName: history.scenario === 'read-vs-update' ? 'Bob' : 'Carol',
    finalDisplayName: history.scenario === 'read-vs-update' ? 'BOB' : 'CAROL',
    usedAllRequiredHelpers: true,
    noErrors: true,
  }),
  driver: async (history, observe) => {
    resetStore()
    seedProfile('u1', 'Alice')
    const scheduler = scheduleFrom(history.choices)
    const called = new Set<string>()
    observe('reach', history.scenario)

    try {
      const pending: Array<Promise<unknown>> = []
      if (history.scenario === 'read-vs-update') {
        pending.push(withScheduledIo(scheduler, 'q-read', called, () => getProfile('u1')))
        pending.push(withScheduledIo(scheduler, 'q-u1', called, () => updateProfile('u1', 'Bob')))
      } else if (history.scenario === 'concurrent-two-updates') {
        pending.push(withScheduledIo(scheduler, 'q-u1', called, () => updateProfile('u1', 'Bob')))
        pending.push(withScheduledIo(scheduler, 'q-u2', called, () => updateProfile('u1', 'Carol')))
      } else {
        pending.push(withScheduledIo(scheduler, 'q-read', called, () => getProfile('u1')))
        pending.push(withScheduledIo(scheduler, 'q-u1', called, () => updateProfile('u1', 'Bob')))
        pending.push(withScheduledIo(scheduler, 'q-u2', called, () => updateProfile('u1', 'Carol')))
      }

      await scheduler.waitIdle()
      await Promise.all(pending)

      const after = await getProfile('u1')
      const required =
        history.scenario === 'concurrent-two-updates'
          ? ['validateName', 'writeToDb', 'auditUpdate']
          : ['readFromDb', 'formatProfile', 'validateName', 'writeToDb', 'auditUpdate']

      observe('outcome', {
        finalName: after?.name ?? null,
        finalDisplayName: after?.displayName ?? null,
        usedAllRequiredHelpers: required.every((h) => called.has(h)),
        noErrors: true,
      })
    } catch (err) {
      observe('outcome', {
        finalName: null,
        finalDisplayName: null,
        usedAllRequiredHelpers: false,
        noErrors: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'outcome')
    if (!entry) return differs('outcome', 'stale-cache-concurrency', undefined, expected) ?? pass
    return differs('outcome', 'stale-cache-concurrency', entry.value, expected) ?? pass
  },
})
