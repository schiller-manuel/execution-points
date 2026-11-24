/**
 * This oracle owns `interleavings`, which runs a scenario once for every order
 * in which its operations can pass the selected expressions. It is checked on
 * the orders the scenario actually ran in, on what `check` was given, and on
 * what `interleavings` returns and throws. It owns
 * `src/runtime.mjs#interleavings` and `src/runtime.mjs#InterleavingFailure`.
 *
 * ```ts
 * await interleavings({ points: [read, write], run: () => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')]), check })
 * // → runs the two operations once per order in which their evaluations of `read` and `write` can be released,
 * //   and calls check after each; returns { schedules, complete }
 * // → throws when check fails, with the failing order and a `schedule` that replays it
 * await interleavings({ ...same, schedule }) // → runs exactly that order
 * await interleavings({ ...same, choose: (step, count, run) => pick, limit: 20 }) // → 20 orders, each the one `choose` picks
 * ```
 *
 * Two operations that each evaluate a selected expression twice can interleave
 * in six ways, and a test written by hand tries one or two of them. Which one
 * loses the update?
 *
 * Three parts make the search: the **hold** (every evaluation of a selected
 * expression inside `run` waits until it is released), the **quiet point** (the
 * moment when every operation has finished or is held, which is when the next
 * release is chosen), and the **walk** over the choices (every order by
 * default, the caller's own picks with `choose`, one given order with
 * `schedule`).
 *
 * For every set of operations, each a sequence of evaluations of selected
 * expressions, `interleavings` runs the scenario once for each order that keeps
 * every operation's own sequence, and for no other order; it calls `check` once
 * per run with what `run` resolved to; and it returns the number of orders and
 * `complete: true`. With `limit` below that number it stops there with
 * `complete: false`. With `choose` it runs `limit` orders, each the one that
 * `choose(step, count, run)` picks among the evaluations held at that step, in
 * the order they arrived. With `schedule` it runs exactly that order, and
 * refuses a schedule that does not fit the run. When
 * `check` throws or `run` rejects, it stops and throws an `InterleavingFailure`
 * whose `schedule` replays the failing order and whose message lists the order
 * and says what failed: the error's message, or the thrown value itself when
 * the scenario threw something that is not an error. A test tells this error
 * from any other with `instanceof`, which is also what gives `schedule` a
 * type. `setup` runs before every run. A run that neither finishes nor
 * reaches a selected expression fails the same way; when that happens before
 * any evaluation was released, the message says so instead of listing an
 * empty order. A selected expression that no run reached makes it throw
 * (Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24: build schedule exploration on top of `select()`: pick the
 * points, get every ordering or a sample; a replacement that never runs must
 * be loud).
 *
 * The model lists the orders itself, by merging the operations' sequences in
 * every way, and knows nothing of how the walk backtracks. The driver records
 * the order of each run from inside the original expressions, which only run
 * when they are released.
 *
 * The operations here are driven by microtasks only. Work that waits on a real
 * timer or on disk is released when it arrives, which the quiet point cannot
 * order.
 */
import { afterEach } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { InterleavingFailure, interleavings, invoke, registerFile, select, verifyReplacements } from '../src/runtime.mjs'

// The library's own check after each test is not what this law is about, so it finds nothing.
afterEach(() => {
  try {
    verifyReplacements()
  } catch {
    // Reported by the laws that own it.
  }
})

// How many selected evaluations each operation makes, one after the other.
const SHAPES: ReadonlyArray<ReadonlyArray<number>> = [[1], [2], [1, 1], [2, 1], [2, 2], [1, 1, 1], [0, 1], [3, 1]]
const MODES = [
  'every-order',
  'limited',
  'chosen',
  'failing-check',
  'failing-run',
  'replayed',
  'unreached-point',
  'schedule-out-of-range',
  'schedule-too-long',
  'schedule-too-short',
  'never-finishes',
  'malformed-arguments',
] as const

interface InterleavingHistory {
  shape: number
  mode: (typeof MODES)[number]
}

const enumeratedInterleavingHistories: ReadonlyArray<InterleavingHistory> = SHAPES.flatMap((_, shape) =>
  MODES.map((mode) => ({ shape, mode })),
)

/**
 * The order one run takes when `choose(step, count)` picks among the held evaluations. They are
 * held in the order they arrived: first each operation's first evaluation, in the order the
 * operations started, and behind them the next evaluation of whichever operation was let go.
 */
function chosenOrder(lengths: ReadonlyArray<number>, choose: (step: number, count: number) => number) {
  const held = lengths.flatMap((length, operation) => (length > 0 ? [{ operation, turn: 0 }] : []))
  const order: Array<string> = []
  while (held.length > 0) {
    const [next] = held.splice(choose(order.length, held.length), 1)
    order.push(`${'ABC'[next!.operation]}${next!.turn}`)
    if (next!.turn + 1 < lengths[next!.operation]!) held.push({ operation: next!.operation, turn: next!.turn + 1 })
  }
  return order.join(' ')
}

// The chooser the driver hands in: it depends on the run and on the step.
const scripted = (step: number, count: number, run: number) => (run + step) % count

/** Every way to merge the operations' sequences that keeps each one's own order. */
function mergedOrders(lengths: ReadonlyArray<number>): Array<string> {
  const orders: Array<string> = []
  const walk = (taken: ReadonlyArray<number>, soFar: ReadonlyArray<string>) => {
    if (taken.every((count, operation) => count === lengths[operation])) {
      orders.push(soFar.join(' '))
      return
    }
    taken.forEach((count, operation) => {
      if (count < lengths[operation]!) {
        walk(
          taken.map((other, index) => (index === operation ? other + 1 : other)),
          [...soFar, `${'ABC'[operation]}${count}`],
        )
      }
    })
  }
  walk(
    lengths.map(() => 0),
    [],
  )
  return orders.sort()
}

/** An argument of the wrong kind is refused by the library itself, in its own words. */
const OUR_TYPE_ERROR = { name: 'TypeError', saidByTheLibrary: true }
const whose = (error: unknown) => ({
  name: (error as Error).name,
  saidByTheLibrary: String((error as Error).message).startsWith('[execution-points]'),
})

const LIMIT = 2
const SAMPLE = 5

// What a failing scenario throws. JavaScript lets it be any value, not only an error.
const FAILURES: ReadonlyArray<unknown> = [new Error('the scenario failed'), 'a bare string', undefined, null]
const failureOf = (history: InterleavingHistory) => FAILURES[history.shape % FAILURES.length]

function interleavingModel(history: InterleavingHistory) {
  const lengths = SHAPES[history.shape]!
  const all = mergedOrders(lengths)
  // The order a failing check objects to: the last one in the sorted list.
  const bad = all.at(-1)!
  const base = { checkedOnce: true, checkSawTheRunsResult: true, setUpBeforeEveryRun: true }
  switch (history.mode) {
    case 'every-order':
      // A replacement that surrounds the whole search still applies inside every run.
      return { ...base, outcome: { schedules: all.length, complete: true }, orders: all, surroundingScopeApplies: true }
    case 'limited':
      return {
        ...base,
        outcome: { schedules: Math.min(LIMIT, all.length), complete: all.length <= LIMIT },
        ordersAreDistinctAndPossible: true,
        ordersRun: Math.min(LIMIT, all.length),
      }
    case 'chosen':
      return {
        ...base,
        outcome: { schedules: SAMPLE, complete: false },
        orders: Array.from({ length: SAMPLE }, (_, run) => chosenOrder(lengths, (step, count) => scripted(step, count, run))),
      }
    case 'schedule-out-of-range':
    case 'schedule-too-long':
    case 'schedule-too-short':
      // A schedule that does not fit the run is refused, naming the step that has no valid choice;
      // a run with no choice to make fits only the empty schedule.
      return {
        outcome:
          history.mode === 'schedule-too-short' && all[0] === ''
            ? { schedules: 1, complete: true }
            : {
                ...OUR_TYPE_ERROR,
                step:
                  history.mode === 'schedule-out-of-range'
                    ? 1
                    : history.mode === 'schedule-too-short'
                      ? all[0]!.split(' ').length
                      : null,
              },
      }
    case 'failing-check':
    case 'failing-run': {
      const failure = failureOf(history)
      const outcome = {
        threw: 'the-failure-is-the-cause',
        isAnInterleavingFailure: true,
        namesTheOrder: true,
        namesTheSchedule: true,
        // The last line says what failed: an error's message, or the thrown value itself.
        saidWhy: failure instanceof Error ? failure.message : String(failure),
      }
      return { outcome, stoppedAtTheBadOrder: true, replayOf: { outcome, orders: [bad] } }
    }
    case 'replayed':
      // Replaying the choices of any complete run gives that run's order again.
      return { ...base, everyOrderReplays: true }
    case 'unreached-point':
      return { outcome: { threw: 'names-the-unreached-expression' }, ordersRun: all.length }
    case 'never-finishes':
      // Nothing was released, so there is no order to list and none to replay.
      return {
        outcome: {
          threw: 'says-the-run-neither-finished-nor-arrived',
          isAnInterleavingFailure: true,
          schedule: [],
          saysNothingWasReleased: true,
          listsAnOrder: false,
        },
      }
    case 'malformed-arguments':
      return { pointsNotAList: OUR_TYPE_ERROR, pointNotSelected: OUR_TYPE_ERROR, runNotAFunction: OUR_TYPE_ERROR }
  }
}

let interleavingRuns = 0

/** Waits for a search over a bounded number of event-loop turns, so one that never ends is an observation. */
async function within<T>(search: Promise<T>): Promise<T> {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  let value: unknown
  search.then(
    (result) => {
      state = 'fulfilled'
      value = result
    },
    (error) => {
      state = 'rejected'
      value = error
    },
  )
  for (let turn = 0; turn < 600 && state === 'pending'; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  if ((state as string) === 'fulfilled') return value as T
  throw (state as string) === 'rejected' ? value : new Error('the search never finished')
}

oracleProperty({
  id: 'runtime-interleavings',
  owns: ['src/runtime.mjs#interleavings', 'src/runtime.mjs#InterleavingFailure.constructor', 'src/runtime.mjs#createPointHandle'],
  // A search waits for the event loop between choices; waiting longer than it must is a defect too.
  work: { ratio: 1 },
  law: {
    statement:
      'For every set of operations, each a sequence of evaluations of selected expressions, interleavings runs the scenario once for each order that keeps every operation\'s own sequence and for no other order, calls check once per run with what run resolved to, and returns the number of orders and complete: true; with `limit` below that number it stops there with complete: false; with `choose` it runs `limit` orders, each the one that choose(step, count, run) picks among the evaluations held at that step in the order they arrived; with `schedule` it runs exactly that order and refuses a schedule that does not fit the run; when check throws or run rejects it stops and throws an InterleavingFailure whose `schedule` replays the failing order and whose message lists that order and says what failed, whether the scenario threw an error or any other value; a run that neither finishes nor reaches a selected expression fails the same way, and says that nothing was released when that is so; and a selected expression that no run reached makes it throw.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build schedule exploration on top of select() (pick the points, get every ordering, or a sample), with oracle coverage; a replacement that never runs must be loud.',
    limits:
      'Up to three operations with up to three evaluations each, driven by microtasks only; one expression shared by all operations plus, in one mode, a second expression nothing evaluates; a failing scenario throws an error, a string, undefined or null.',
  },
  histories: {
    enumerated: enumeratedInterleavingHistories,
    states: [
      'several-orders',
      'single-order',
      'stopped-at-a-failure',
      'expression-never-reached',
      'schedule-refused',
      'run-stuck',
    ],
  },
  label: (h) => `[${SHAPES[h.shape]!.join(',')}] ${h.mode}`,
  model: (history) => interleavingModel(history),
  driver: async (history, observe) => {
    const lengths = SHAPES[history.shape]!
    const all = mergedOrders(lengths)
    const bad = all.at(-1)!
    observe('reach', all.length > 1 ? 'several-orders' : 'single-order')
    if (history.mode === 'failing-check' || history.mode === 'failing-run') observe('reach', 'stopped-at-a-failure')
    if (history.mode === 'unreached-point') observe('reach', 'expression-never-reached')
    if (history.mode === 'schedule-out-of-range' || history.mode === 'schedule-too-long') observe('reach', 'schedule-refused')
    if (history.mode === 'never-finishes') observe('reach', 'run-stuck')
    try {
      interleavingRuns += 1
      const file = `interleavings-${interleavingRuns}.ts`
      const ids = [`${file}#work:CallExpression:step:0`, `${file}#work:CallExpression:idle:0`]
      registerFile(
        file,
        ids.map((id, index) => ({
          id,
          kind: 'CallExpression' as const,
          inFunction: 'work',
          callee: index === 0 ? 'step' : 'idle',
          nth: 0,
        })),
        [1, 1],
      )
      const point = (callee: string) =>
        select(file as never, ((n: { callee?: string }) => (n.callee === callee ? n : undefined)) as never) as never
      const step = point('step')
      const idle = point('idle')

      // Each run records the order in which its evaluations were let through.
      const orders: Array<string> = []
      let current: Array<string> = []
      const failure = failureOf(history)
      const operation = async (name: string, evaluations: number) => {
        for (let turn = 0; turn < evaluations; turn += 1) {
          await (invoke(
            ids[0]!,
            () => {
              current.push(`${name}${turn}`)
              return Promise.resolve()
            },
            () => ({}),
          ) as Promise<void>)
        }
        return name
      }
      let setUps = 0
      let runsStarted = 0
      let setUpBeforeEveryRun = true
      const setup = () => {
        setUps += 1
      }
      let surroundingScopeApplies = true
      const run = async () => {
        runsStarted += 1
        if (setUps !== runsStarted) setUpBeforeEveryRun = false
        current = []
        // The second expression is not among the points of this search, so nothing holds it.
        if (history.mode === 'every-order' && invoke(ids[1]!, () => 'original', () => ({})) !== 'surrounding') {
          surroundingScopeApplies = false
        }
        if (history.mode === 'never-finishes') await new Promise(() => {})
        const names = await Promise.all(lengths.map((evaluations, index) => operation('ABC'[index]!, evaluations)))
        const order = current.join(' ')
        orders.push(order)
        if (history.mode === 'failing-run' && order === bad) throw failure
        return { names, order }
      }
      let checks = 0
      let checkSawTheRunsResult = true
      const check = (result: { names: Array<string>; order: string }) => {
        checks += 1
        if (result.order !== orders.at(-1) || result.names.join('') !== 'ABC'.slice(0, lengths.length)) {
          checkSawTheRunsResult = false
        }
        if (history.mode === 'failing-check' && result.order === bad) throw failure
      }
      const explore = async (options: object) => {
        try {
          const report = (await within(
            interleavings({ points: [step], run, check, setup, ...options } as never) as Promise<unknown>,
          )) as {
            schedules: number
            complete: boolean
          }
          return { schedules: report.schedules, complete: report.complete }
        } catch (error) {
          return error as Error & { schedule?: ReadonlyArray<number> }
        }
      }
      const describe = (error: Error & { schedule?: ReadonlyArray<number> }) => ({
        threw: 'cause' in error && error.cause === failure ? 'the-failure-is-the-cause' : `something-else: ${error.message}`,
        isAnInterleavingFailure: error instanceof InterleavingFailure && error.name === 'InterleavingFailure',
        namesTheOrder: bad.split(' ').every((_, position) => error.message.includes(`${position + 1}. ${ids[0]}`)),
        namesTheSchedule: error.message.includes(`{ schedule: ${JSON.stringify(error.schedule)} }`),
        saidWhy: /\nIt failed with: (.*)$/s.exec(error.message)?.[1] ?? null,
      })
      const possible = (list: ReadonlyArray<string>) => list.every((order) => all.includes(order))

      if (history.mode === 'every-order') {
        const outcome = await (idle as { withReplacement: Function }).withReplacement(
          () => 'surrounding',
          () => explore({}),
          { times: 'any' },
        )
        observe('interleavings', {
          checkedOnce: checks === orders.length,
          checkSawTheRunsResult,
          setUpBeforeEveryRun,
          outcome: outcome instanceof Error ? { threw: outcome.message } : outcome,
          orders: [...orders].sort(),
          surroundingScopeApplies,
        })
      } else if (history.mode === 'never-finishes') {
        const outcome = await explore({})
        observe('interleavings', {
          outcome:
            outcome instanceof Error
              ? {
                  threw: String((outcome.cause as Error | undefined)?.message).includes('neither finished nor reached')
                    ? 'says-the-run-neither-finished-nor-arrived'
                    : outcome.message,
                  isAnInterleavingFailure: outcome instanceof InterleavingFailure && outcome.name === 'InterleavingFailure',
                  schedule: outcome.schedule,
                  saysNothingWasReleased: outcome.message.startsWith(
                    '[execution-points] The scenario failed before any selected expression was released.\nIt failed with: ',
                  ),
                  listsAnOrder: /in this order|Replay it/.test(outcome.message),
                }
              : outcome,
        })
      } else if (history.mode === 'malformed-arguments') {
        const refused = (options: object) =>
          (interleavings(options as never) as Promise<unknown>).then(
            () => 'accepted',
            (error) => whose(error),
          )
        observe('interleavings', {
          pointsNotAList: await refused({ points: step, run }),
          pointNotSelected: await refused({ points: [step, { pause() {} }], run }),
          runNotAFunction: await refused({ points: [step], run: 'run' }),
        })
      } else if (history.mode === 'limited') {
        const outcome = await explore({ limit: LIMIT })
        observe('interleavings', {
          checkedOnce: checks === orders.length,
          checkSawTheRunsResult,
          setUpBeforeEveryRun,
          outcome: outcome instanceof Error ? { threw: outcome.message } : outcome,
          ordersAreDistinctAndPossible: possible(orders) && new Set(orders).size === orders.length,
          ordersRun: orders.length,
        })
      } else if (history.mode === 'chosen') {
        const outcome = await explore({ choose: scripted, limit: SAMPLE })
        observe('interleavings', {
          checkedOnce: checks === orders.length,
          checkSawTheRunsResult,
          setUpBeforeEveryRun,
          outcome: outcome instanceof Error ? { threw: outcome.message } : outcome,
          orders: [...orders],
        })
      } else if (history.mode.startsWith('schedule-')) {
        // The first order's own choices are all 0: one per evaluation.
        const fitting = all[0] === '' ? [] : all[0]!.split(' ').map(() => 0)
        const schedule =
          history.mode === 'schedule-out-of-range'
            ? [lengths.length]
            : history.mode === 'schedule-too-long'
              ? [...fitting, 0]
              : fitting.slice(0, -1)
        const outcome = await explore({ schedule })
        observe('interleavings', {
          outcome:
            outcome instanceof Error
              ? { ...whose(outcome), step: Number(/for step (\d+)/.exec(outcome.message)?.[1] ?? Number.NaN) || null }
              : outcome,
        })
      } else if (history.mode === 'failing-check' || history.mode === 'failing-run') {
        const failed = await explore({})
        const stoppedAtTheBadOrder = orders.at(-1) === bad && orders.filter((order) => order === bad).length === 1
        orders.length = 0
        const replayed = failed instanceof Error ? await explore({ schedule: failed.schedule }) : failed
        observe('interleavings', {
          outcome: failed instanceof Error ? describe(failed) : failed,
          stoppedAtTheBadOrder,
          replayOf: { outcome: replayed instanceof Error ? describe(replayed) : replayed, orders: [...orders] },
        })
      } else if (history.mode === 'replayed') {
        // Collect the choices of every order by letting check fail once per order, then replay each.
        const schedules: Array<{ order: string; schedule: ReadonlyArray<number> }> = []
        for (const target of all) {
          const failed = await within(
            interleavings({
              points: [step],
              run,
              setup,
              check: (result: { order: string }) => {
                if (result.order === target) throw failure
              },
            } as never) as Promise<unknown>,
          ).then(
            () => undefined,
            (error: Error & { schedule: ReadonlyArray<number> }) => error,
          )
          if (failed) schedules.push({ order: target, schedule: failed.schedule })
        }
        let everyOrderReplays = schedules.length === all.length
        checks = 0
        orders.length = 0
        for (const { order, schedule } of schedules) {
          const outcome = await explore({ schedule })
          if (outcome instanceof Error || outcome.schedules !== 1 || !outcome.complete || orders.at(-1) !== order) {
            everyOrderReplays = false
          }
        }
        observe('interleavings', {
          checkedOnce: checks === orders.length,
          checkSawTheRunsResult,
          setUpBeforeEveryRun,
          everyOrderReplays,
        })
      } else {
        const failed = await within(interleavings({ points: [step, idle], run, check } as never) as Promise<unknown>).then(
          () => 'returned',
          (error: Error) => error,
        )
        observe('interleavings', {
          outcome:
            failed instanceof Error
              ? { threw: failed.message.includes(`"${ids[1]}"`) && !failed.message.includes(`"${ids[0]}"`) ? 'names-the-unreached-expression' : failed.message }
              : failed,
          ordersRun: orders.length,
        })
      }
    } catch (err) {
      observe('interleavings', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs(
      'interleavings',
      'interleavings',
      observations.find((o) => o.checkpoint === 'interleavings')?.value,
      expected,
    ) ?? pass,
  calibrations: [
    {
      name: 'an-order-is-never-tried',
      law: 'interleavings',
      history: { enumerated: '[2,1] every-order' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'interleavings'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  outcome: { schedules: 2, complete: true },
                  orders: ['A0 A1 B0', 'B0 A0 A1'],
                },
              }
            : o,
        ),
    },
    {
      name: 'a-failing-order-is-not-reported',
      law: 'interleavings',
      history: { enumerated: '[1,1] failing-check' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'interleavings'
            ? { ...o, value: { ...(o.value as object), outcome: { schedules: 2, complete: true } } }
            : o,
        ),
    },
  ],
})
