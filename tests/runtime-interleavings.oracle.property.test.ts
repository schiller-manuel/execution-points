/**
 * This oracle owns `interleavings`, which hands out, one at a time, every order
 * in which a scenario's operations can pass the selected expressions. It is
 * checked on the orders the scenario actually ran in, on what each order's
 * `run` resolves to and reports, and on what is thrown and where. It owns
 * `src/runtime.mjs#interleavings` and `src/runtime.mjs#InterleavingFailure`.
 *
 * ```ts
 * for (const order of interleavings([read, write])) {
 *   reset()
 *   await order.run(() => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')]))
 *   expect(cachedName('u1')).toBe('Bob')       // the caller's own check, once per order
 * }
 * // order.run(action) → what the action resolves to; rejects with an InterleavingFailure when the action fails
 * // order.released    → the evaluations that were let through, in order
 * // order.schedule    → the choices that give this order again:
 * for (const order of interleavings([read, write], { schedule })) … // exactly that one order
 * for (const order of interleavings([read, write], { choose })) …   // the orders `choose(step, count, run)` picks
 * ```
 *
 * Two operations that each evaluate a selected expression twice can interleave
 * in six ways, and a test written by hand tries one or two of them. Which one
 * loses the update?
 *
 * Three parts make the search: the **hold** (every evaluation of a selected
 * expression inside `order.run` waits until it is released), the **quiet
 * point** (the moment when every operation has finished or is held, which is
 * when the next release is chosen), and the **walk** over the choices (every
 * order by default, the caller's own picks with `choose`, one given order with
 * `schedule`). The caller owns the loop: what runs, what is checked, and when
 * to stop.
 *
 * For every set of operations, each a sequence of evaluations of selected
 * expressions, iterating `interleavings(points)` and running the scenario with
 * `order.run` in each step runs it once for each order that keeps every
 * operation's own sequence, for no other order, and then ends. `order.run`
 * resolves to what the action resolves to. Afterwards `order.released` lists
 * the evaluations in the order they were let through, and `order.schedule`
 * holds the choices that give that order again through `{ schedule }`, which
 * yields exactly that one order and refuses a schedule that does not fit the
 * run. With `choose`, every order is the one that `choose(step, count, run)`
 * picks among the evaluations held at that step, in the order they arrived,
 * for as long as the caller keeps asking. Leaving the loop early is allowed.
 * When the action throws or rejects, `order.run` rejects with an
 * `InterleavingFailure` whose `schedule` replays the failing order and whose
 * message lists that order and says what failed: the error's message, or the
 * thrown value itself when it is not an error. The caller may catch it and
 * take the next order. An error thrown outside `order.run` reaches the caller
 * unchanged. A run that neither finishes nor reaches a selected expression
 * fails the same way; when nothing was released, the message says so instead
 * of listing an empty order. Taking the next order before the current one has
 * run to its end, running an order twice, and a selected expression that no
 * run reached when the orders run out, each throw (Decisions by Manuel
 * Schiller (GitHub schiller-manuel), 2026-11-24: build schedule exploration
 * on top of `select()`: pick the points, get every ordering or a sample; make
 * it a primitive that can be composed, like a generator or callbacks that can
 * be iterated and awaited, so that the user performs their own checks instead
 * of supplying them; a replacement that never runs must be loud).
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
  'stopped-early',
  'chosen',
  'failing-inside',
  'failing-at-once',
  'failing-outside',
  'continuing-after-failure',
  'replayed',
  'unreached-point',
  'schedule-out-of-range',
  'schedule-too-long',
  'schedule-too-short',
  'never-finishes',
  'malformed-arguments',
  'misused',
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

/** An argument of the wrong kind is refused by the library itself, in its own words; so is a misuse. */
const OUR_TYPE_ERROR = { name: 'TypeError', saidByTheLibrary: true }
const OUR_ERROR = { name: 'Error', saidByTheLibrary: true }
const whose = (error: unknown) => ({
  name: (error as Error).name,
  saidByTheLibrary: String((error as Error).message).startsWith('[execution-points]'),
})

const LIMIT = 2
const SAMPLE = 5

// Operation A evaluates one selected expression and the others evaluate a second one, so the
// list of released evaluations says more than how many there were.
const expressionOf = (evaluation: string) => (evaluation.startsWith('A') ? 'step' : 'other')
const releasedIn = (order: string) => order.split(' ').filter(Boolean).map(expressionOf).join(' ')

// What a failing scenario throws. JavaScript lets it be any value, not only an error.
const FAILURES: ReadonlyArray<unknown> = [new Error('the scenario failed'), 'a bare string', undefined, null]
const failureOf = (history: InterleavingHistory) => FAILURES[history.shape % FAILURES.length]

function interleavingModel(history: InterleavingHistory) {
  const lengths = SHAPES[history.shape]!
  const all = mergedOrders(lengths)
  // The order a failing scenario objects to: the last one in the sorted list.
  const bad = all.at(-1)!
  const evaluations = lengths.reduce((sum, length) => sum + length, 0)
  const failure = failureOf(history)
  // The last line of a failure says what failed: an error's message, or the thrown value itself.
  const saidWhy = failure instanceof Error ? failure.message : String(failure)
  const failedInOrder = {
    threw: 'the-failure-is-the-cause',
    isAnInterleavingFailure: true,
    namesTheOrder: true,
    namesTheSchedule: true,
    saidWhy,
  }
  // Nothing was released, so there is no order to list and none to replay.
  const failedBeforeAnyRelease = { isAnInterleavingFailure: true, schedule: [], saysNothingWasReleased: true, listsAnOrder: false }
  switch (history.mode) {
    case 'every-order':
      return {
        ended: 'the-orders-ran-out',
        orders: all,
        released: Object.fromEntries(all.map((order) => [order, releasedIn(order)])),
        oneChoicePerRelease: true,
        resolvedToTheActionsResult: true,
        // A replacement that surrounds the whole loop still applies inside every run.
        surroundingScopeApplies: true,
      }
    case 'stopped-early':
      return {
        ended: all.length >= LIMIT ? 'left-early' : 'the-orders-ran-out',
        ordersRun: Math.min(LIMIT, all.length),
        ordersAreDistinctAndPossible: true,
        resolvedToTheActionsResult: true,
        nothingMoreAfterLeaving: true,
      }
    case 'chosen':
      return {
        ended: 'left-early',
        orders: Array.from({ length: SAMPLE }, (_, run) => chosenOrder(lengths, (step, count) => scripted(step, count, run))),
        resolvedToTheActionsResult: true,
      }
    case 'failing-inside':
      return {
        outcome: failedInOrder,
        stoppedAtTheBadOrder: true,
        replayOf: { outcome: failedInOrder, orders: [bad] },
      }
    case 'failing-at-once':
      return { outcome: { threw: 'the-failure-is-the-cause', ...failedBeforeAnyRelease, saidWhy } }
    case 'failing-outside':
      // The caller's own check threw after the run: the library adds nothing and takes nothing away.
      return {
        outcome: 'the-callers-own-error-unchanged',
        stoppedAtTheBadOrder: true,
        replayOf: { yielded: 1, orders: [bad] },
        resolvedToTheActionsResult: true,
      }
    case 'continuing-after-failure':
      return { ended: 'the-orders-ran-out', orders: all, failures: [failedInOrder] }
    case 'replayed':
      // The schedule of any order gives that order again, and only that one.
      return { everyOrderReplays: true, resolvedToTheActionsResult: true }
    case 'unreached-point':
      return { outcome: { threw: 'names-the-unreached-expression' }, ordersRun: all.length }
    case 'schedule-out-of-range': {
      const refusedAtTheFirstStep = { ...OUR_TYPE_ERROR, step: 1 }
      return {
        tooHigh: refusedAtTheFirstStep,
        negative: refusedAtTheFirstStep,
        fractional: refusedAtTheFirstStep,
        chosenTooHigh: refusedAtTheFirstStep,
      }
    }
    case 'schedule-too-long':
      return { outcome: { ...OUR_TYPE_ERROR, step: null } }
    case 'schedule-too-short':
      // The first step without a choice is the last evaluation's.
      return { outcome: { ...OUR_TYPE_ERROR, step: evaluations } }
    case 'never-finishes':
      return { outcome: { threw: 'says-the-run-neither-finished-nor-arrived', ...failedBeforeAnyRelease } }
    case 'malformed-arguments':
      return { pointsNotAList: OUR_TYPE_ERROR, pointNotSelected: OUR_TYPE_ERROR, actionNotAFunction: OUR_TYPE_ERROR }
    case 'misused':
      return {
        nextWithoutRunning: OUR_ERROR,
        nextWhileRunning: OUR_ERROR,
        theRunStillFinished: true,
        runTwice: OUR_ERROR,
        theActionRanOnce: true,
      }
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

/** Lets a walk that never runs out of orders show up as an error instead of a hang. */
function* atMost<Item>(sequence: Iterable<Item>, most: number): Generator<Item, void, undefined> {
  let taken = 0
  for (const item of sequence) {
    taken += 1
    if (taken > most) throw new Error('the orders never ran out')
    yield item
  }
}

interface Order {
  run<Result>(action: () => Result | Promise<Result>): Promise<Result>
  readonly schedule: ReadonlyArray<number>
  readonly released: ReadonlyArray<string>
}

oracleProperty({
  id: 'runtime-interleavings',
  owns: ['src/runtime.mjs#interleavings', 'src/runtime.mjs#InterleavingFailure.constructor', 'src/runtime.mjs#createPointHandle'],
  // A search waits for the event loop between choices; waiting longer than it must is a defect too.
  work: { ratio: 1 },
  law: {
    statement:
      'For every set of operations, each a sequence of evaluations of selected expressions, iterating interleavings(points) and running the scenario with order.run in each step runs it once for each order that keeps every operation\'s own sequence, for no other order, and then ends; order.run resolves to what the action resolves to, and afterwards order.released lists the evaluations in the order they were let through and order.schedule holds the choices that give that order again through { schedule }, which yields exactly that one order and refuses a schedule that does not fit the run; with `choose` every order is the one that choose(step, count, run) picks among the evaluations held at that step in the order they arrived, for as long as the caller keeps asking; leaving the loop early is allowed; when the action throws or rejects, order.run rejects with an InterleavingFailure whose `schedule` replays the failing order and whose message lists that order and says what failed, whether the action threw an error or any other value, and the caller may catch it and take the next order; an error thrown outside order.run reaches the caller unchanged; a run that neither finishes nor reaches a selected expression fails the same way, and says that nothing was released when that is so; and taking the next order before the current one has run to its end, running an order twice, and a selected expression that no run reached when the orders run out, each throw.',
    authority:
      'Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build schedule exploration on top of select() (pick the points, get every ordering, or a sample), with oracle coverage; make it a primitive that can be composed, like a generator or callbacks that can be iterated and awaited, so that the user performs their own checks instead of supplying them; a replacement that never runs must be loud.',
    limits:
      'Up to three operations with up to three evaluations each, driven by microtasks only; two selected expressions that operations evaluate plus, in one mode, a third that nothing evaluates; a failing scenario throws an error, a string, undefined or null, and does so after its operations finished or before it started any. The decision fixed the shape (an iterable of orders, the caller\'s own checks). The names `run`, `schedule` and `released`, the `schedule` and `choose` options, and which misuse throws are proposals that await the maintainer\'s word.',
  },
  histories: {
    enumerated: enumeratedInterleavingHistories,
    states: [
      'several-orders',
      'single-order',
      'stopped-at-a-failure',
      'continued-past-a-failure',
      'left-early',
      'expression-never-reached',
      'schedule-refused',
      'run-stuck',
      'order-misused',
    ],
  },
  label: (h) => `[${SHAPES[h.shape]!.join(',')}] ${h.mode}`,
  model: (history) => interleavingModel(history),
  driver: async (history, observe) => {
    const lengths = SHAPES[history.shape]!
    const all = mergedOrders(lengths)
    const bad = all.at(-1)!
    const failure = failureOf(history)
    observe('reach', all.length > 1 ? 'several-orders' : 'single-order')
    if (['failing-inside', 'failing-at-once', 'failing-outside'].includes(history.mode)) observe('reach', 'stopped-at-a-failure')
    if (history.mode === 'continuing-after-failure') observe('reach', 'continued-past-a-failure')
    if (history.mode === 'stopped-early' || history.mode === 'chosen') observe('reach', 'left-early')
    if (history.mode === 'unreached-point') observe('reach', 'expression-never-reached')
    if (history.mode.startsWith('schedule-')) observe('reach', 'schedule-refused')
    if (history.mode === 'never-finishes') observe('reach', 'run-stuck')
    if (history.mode === 'misused') observe('reach', 'order-misused')
    try {
      interleavingRuns += 1
      const file = `interleavings-${interleavingRuns}.ts`
      const callees = ['step', 'other', 'idle']
      const ids = callees.map((callee) => `${file}#work:CallExpression:${callee}:0`)
      registerFile(
        file,
        ids.map((id, index) => ({ id, kind: 'CallExpression' as const, inFunction: 'work', callee: callees[index]!, nth: 0 })),
        [1, 1, 1],
      )
      const [step, other, idle] = callees.map(
        (callee) => select(file as never, ((n: { callee?: string }) => (n.callee === callee ? n : undefined)) as never) as never,
      )
      const idOf = (evaluation: string) => ids[callees.indexOf(expressionOf(evaluation))]!
      const expressionWith = (id: string) => callees[ids.indexOf(id)] ?? id
      // Only the expressions that some operation evaluates: one that nothing reaches is a mode of its own.
      const points = [...(lengths[0]! > 0 ? [step] : []), ...(lengths.slice(1).some((length) => length > 0) ? [other] : [])]
      // The arguments are checked as the orders are asked for, before the bound takes the first one.
      const orderings = (options?: object, among: ReadonlyArray<unknown> = points) =>
        atMost(
          (interleavings as unknown as (points: unknown, options?: object) => Generator<Order, void, undefined>)(among, options),
          Math.max(all.length, SAMPLE) + 1,
        )

      // Each run records the order in which its evaluations were let through.
      const orders: Array<string> = []
      let current: Array<string> = []
      const operation = async (name: string, evaluations: number) => {
        for (let turn = 0; turn < evaluations; turn += 1) {
          await (invoke(
            idOf(name),
            () => {
              current.push(`${name}${turn}`)
              return Promise.resolve()
            },
            () => ({}),
          ) as Promise<void>)
        }
        return name
      }
      let surroundingScopeApplies = true
      const scenario = async () => {
        current = []
        // The third expression is not among the points of this search, so nothing holds it.
        if (history.mode === 'every-order' && invoke(ids[2]!, () => 'original', () => ({})) !== 'surrounding') {
          surroundingScopeApplies = false
        }
        if (history.mode === 'never-finishes') await new Promise(() => {})
        const names = await Promise.all(lengths.map((evaluations, index) => operation('ABC'[index]!, evaluations)))
        const order = current.join(' ')
        orders.push(order)
        if ((history.mode === 'failing-inside' || history.mode === 'continuing-after-failure') && order === bad) throw failure
        return { names, order }
      }
      let resolvedToTheActionsResult = true
      const runIn = async (order: Order) => {
        const result = await within(order.run(scenario))
        if (result.order !== orders.at(-1) || result.names.join('') !== 'ABC'.slice(0, lengths.length)) {
          resolvedToTheActionsResult = false
        }
        return result
      }
      const everyOrder = async (options?: object, among?: ReadonlyArray<unknown>) => {
        for (const order of orderings(options, among)) await runIn(order)
        return 'the-orders-ran-out'
      }
      const caught = (error: unknown) => ({ caught: error })
      const whatFailed = (error: Error) => /\nIt failed with: (.*)$/s.exec(error.message)?.[1] ?? null
      const isOurs = (error: Error) => error instanceof InterleavingFailure && error.name === 'InterleavingFailure'
      const describe = (result: string | { caught: unknown }) => {
        if (typeof result === 'string') return result
        const error = result.caught
        if (!(error instanceof Error)) return { threw: `not an error: ${String(error)}` }
        return {
          threw: 'cause' in error && error.cause === failure ? 'the-failure-is-the-cause' : `something-else: ${error.message}`,
          isAnInterleavingFailure: isOurs(error),
          namesTheOrder: bad.split(' ').every((evaluation, position) => error.message.includes(`${position + 1}. ${idOf(evaluation)}`)),
          namesTheSchedule: error.message.includes(`{ schedule: ${JSON.stringify((error as { schedule?: unknown }).schedule)} }`),
          saidWhy: whatFailed(error),
        }
      }
      const describeUnreleased = (error: unknown, threw: string) =>
        error instanceof Error
          ? {
              threw,
              isAnInterleavingFailure: isOurs(error),
              schedule: (error as { schedule?: unknown }).schedule,
              saysNothingWasReleased: error.message.startsWith(
                '[execution-points] The scenario failed before any selected expression was released.\nIt failed with: ',
              ),
              listsAnOrder: /in this order|Replay it/.test(error.message),
            }
          : { threw: `not an error: ${String(error)}` }
      const atTheCall = (make: () => unknown) => {
        try {
          make()
          return 'accepted'
        } catch (error) {
          return whose(error)
        }
      }
      const ending = (error: unknown) => ({ threw: error instanceof Error ? error.message : String(error) })
      const possible = (list: ReadonlyArray<string>) => list.every((order) => all.includes(order))

      if (history.mode === 'every-order') {
        const released: Record<string, string> = {}
        let oneChoicePerRelease = true
        const ended = await (idle as unknown as { withReplacement: Function }).withReplacement(
          () => 'surrounding',
          async () => {
            try {
              for (const order of orderings()) {
                const result = await runIn(order)
                released[result.order] = order.released.map(expressionWith).join(' ')
                if (order.schedule.length !== order.released.length) oneChoicePerRelease = false
              }
              return 'the-orders-ran-out'
            } catch (error) {
              return ending(error)
            }
          },
          { times: 'any' },
        )
        observe('interleavings', {
          ended,
          orders: [...orders].sort(),
          released,
          oneChoicePerRelease,
          resolvedToTheActionsResult,
          surroundingScopeApplies,
        })
      } else if (history.mode === 'stopped-early' || history.mode === 'chosen') {
        const stopAt = history.mode === 'chosen' ? SAMPLE : LIMIT
        const sequence = orderings(history.mode === 'chosen' ? { choose: scripted } : undefined)
        let ended: unknown = 'the-orders-ran-out'
        try {
          for (const order of sequence) {
            await runIn(order)
            if (orders.length === stopAt) {
              ended = 'left-early'
              break
            }
          }
        } catch (error) {
          ended = ending(error)
        }
        observe(
          'interleavings',
          history.mode === 'chosen'
            ? { ended, orders: [...orders], resolvedToTheActionsResult }
            : {
                ended,
                ordersRun: orders.length,
                ordersAreDistinctAndPossible: possible(orders) && new Set(orders).size === orders.length,
                resolvedToTheActionsResult,
                nothingMoreAfterLeaving: sequence.next().done === true,
              },
        )
      } else if (history.mode === 'failing-inside') {
        const failed = await everyOrder().catch(caught)
        const stoppedAtTheBadOrder = orders.at(-1) === bad && orders.filter((order) => order === bad).length === 1
        orders.length = 0
        const replayed =
          typeof failed === 'object' && failed.caught instanceof InterleavingFailure
            ? await everyOrder({ schedule: (failed.caught as unknown as { schedule: unknown }).schedule }).catch(caught)
            : 'not replayed'
        observe('interleavings', {
          outcome: describe(failed),
          stoppedAtTheBadOrder,
          replayOf: { outcome: describe(replayed), orders: [...orders] },
        })
      } else if (history.mode === 'failing-at-once') {
        const order = orderings().next().value as Order
        const failed = await within(
          order.run(() => {
            throw failure
          }),
        ).then(
          () => 'resolved',
          (error: unknown) => error,
        )
        observe('interleavings', {
          outcome:
            failed instanceof Error
              ? {
                  ...describeUnreleased(failed, 'cause' in failed && failed.cause === failure ? 'the-failure-is-the-cause' : failed.message),
                  saidWhy: whatFailed(failed),
                }
              : failed,
        })
      } else if (history.mode === 'failing-outside') {
        let scheduleOfTheBadOrder: ReadonlyArray<number> | undefined
        const failed = await (async () => {
          for (const order of orderings()) {
            const result = await runIn(order)
            // The caller's own check, after the run.
            if (result.order === bad) {
              scheduleOfTheBadOrder = order.schedule
              throw failure
            }
          }
          return 'the-orders-ran-out'
        })().catch(caught)
        const stoppedAtTheBadOrder = orders.at(-1) === bad && orders.filter((order) => order === bad).length === 1
        orders.length = 0
        let yielded = 0
        if (scheduleOfTheBadOrder) {
          for (const order of orderings({ schedule: scheduleOfTheBadOrder })) {
            yielded += 1
            await runIn(order)
          }
        }
        observe('interleavings', {
          outcome:
            typeof failed === 'object' && Object.is(failed.caught, failure) ? 'the-callers-own-error-unchanged' : describe(failed),
          stoppedAtTheBadOrder,
          replayOf: { yielded, orders: [...orders] },
          resolvedToTheActionsResult,
        })
      } else if (history.mode === 'continuing-after-failure') {
        const failures: Array<{ caught: unknown }> = []
        let ended: unknown
        try {
          for (const order of orderings()) await within(order.run(scenario)).catch((error: unknown) => failures.push(caught(error)))
          ended = 'the-orders-ran-out'
        } catch (error) {
          ended = ending(error)
        }
        observe('interleavings', { ended, orders: [...orders].sort(), failures: failures.map(describe) })
      } else if (history.mode === 'replayed') {
        const seen: Array<{ order: string; schedule: ReadonlyArray<number> }> = []
        for (const order of orderings()) seen.push({ order: (await runIn(order)).order, schedule: order.schedule })
        let everyOrderReplays = seen.length === all.length
        for (const { order, schedule } of seen) {
          orders.length = 0
          let yielded = 0
          for (const again of orderings({ schedule })) {
            yielded += 1
            await runIn(again)
            if (JSON.stringify(again.schedule) !== JSON.stringify(schedule)) everyOrderReplays = false
          }
          if (yielded !== 1 || orders.length !== 1 || orders[0] !== order) everyOrderReplays = false
        }
        observe('interleavings', { everyOrderReplays, resolvedToTheActionsResult })
      } else if (history.mode === 'unreached-point') {
        const failed = await everyOrder(undefined, [...points, idle]).catch((error: unknown) => error)
        observe('interleavings', {
          outcome:
            failed instanceof Error
              ? {
                  threw:
                    failed.message.includes(`"${ids[2]}"`) && !failed.message.includes(`"${ids[0]}"`) && !failed.message.includes(`"${ids[1]}"`)
                      ? 'names-the-unreached-expression'
                      : failed.message,
                }
              : failed,
          ordersRun: orders.length,
        })
      } else if (history.mode.startsWith('schedule-')) {
        const refusal = (options: object) =>
          within((orderings(options).next().value as Order).run(scenario)).then(
            () => 'accepted',
            (error: Error) => ({ ...whose(error), step: Number(/for step (\d+)/.exec(error.message)?.[1] ?? Number.NaN) || null }),
          )
        // The first order's own choices are all 0: one per evaluation.
        const fitting = all[0]!.split(' ').map(() => 0)
        // How many evaluations are held at the first step: one per operation that makes any.
        const heldFirst = lengths.filter((length) => length > 0).length
        if (history.mode === 'schedule-out-of-range') {
          observe('interleavings', {
            tooHigh: await refusal({ schedule: [heldFirst] }),
            negative: await refusal({ schedule: [-1] }),
            fractional: await refusal({ schedule: [0.5] }),
            chosenTooHigh: await refusal({ choose: (_step: number, count: number) => count }),
          })
        } else {
          observe('interleavings', {
            outcome: await refusal({ schedule: history.mode === 'schedule-too-long' ? [...fitting, 0] : fitting.slice(0, -1) }),
          })
        }
      } else if (history.mode === 'never-finishes') {
        const failed = await within((orderings().next().value as Order).run(scenario)).then(
          () => 'resolved',
          (error: unknown) => error,
        )
        observe('interleavings', {
          outcome:
            failed instanceof Error
              ? describeUnreleased(
                  failed,
                  String((failed.cause as Error | undefined)?.message).includes('neither finished nor reached')
                    ? 'says-the-run-neither-finished-nor-arrived'
                    : failed.message,
                )
              : failed,
        })
      } else if (history.mode === 'malformed-arguments') {
        observe('interleavings', {
          // Refused when the orders are asked for, not when the first one is taken.
          pointsNotAList: atTheCall(() => orderings(undefined, step as never)),
          pointNotSelected: atTheCall(() => orderings(undefined, [step, { pause() {} }])),
          actionNotAFunction: await (orderings().next().value as Order).run('scenario' as never).then(() => 'accepted', whose),
        })
      } else {
        const unrun = orderings()
        unrun.next()
        const nextWithoutRunning = atTheCall(() => unrun.next())
        const sequence = orderings()
        const order = sequence.next().value as Order
        const running = within(order.run(scenario))
        const nextWhileRunning = atTheCall(() => sequence.next())
        const theRunStillFinished = await running.then(
          (result) => result.order === orders.at(-1),
          () => false,
        )
        const ranBefore = orders.length
        const runTwice = await order.run(scenario).then(() => 'accepted', whose)
        observe('interleavings', {
          nextWithoutRunning,
          nextWhileRunning,
          theRunStillFinished,
          runTwice,
          theActionRanOnce: ranBefore === 1 && orders.length === 1,
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
            ? { ...o, value: { ...(o.value as object), orders: ['A0 A1 B0', 'B0 A0 A1'] } }
            : o,
        ),
    },
    {
      name: 'a-failing-order-is-not-reported',
      law: 'interleavings',
      history: { enumerated: '[1,1] failing-inside' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'interleavings'
            ? { ...o, value: { ...(o.value as object), outcome: 'the-orders-ran-out' } }
            : o,
        ),
    },
    {
      name: 'a-checks-own-error-is-rewritten',
      law: 'interleavings',
      history: { enumerated: '[1,1] failing-outside' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'interleavings'
            ? { ...o, value: { ...(o.value as object), outcome: { threw: 'the-failure-is-the-cause' } } }
            : o,
        ),
    },
  ],
})
