/**
 * This oracle owns the promises a test relies on when it installs a
 * replacement: that a replacement which does not run as often as the test said
 * is reported, that `replace` applies in every async context until it is
 * restored, that `pause` holds an evaluation and says so, and that a capture
 * the expression cannot see is refused. It is checked on what `withReplacement`,
 * `replace`, `pause`, the shorthands, `point.calls`, and `verifyReplacements`
 * return and throw. It owns `src/runtime.ts`.
 *
 * ```ts
 * point.withReplacement(handler, action) // → throws when handler never ran inside a synchronous action
 * point.withReplacement(handler, asyncAction) // → the action's own promise; a count that is off makes verifyReplacements() throw
 * point.withReplacement(handler, action, { times: 2, on: [1, 3] }) // → handler runs for evaluations 1 and 3 and must run exactly twice
 * using r = point.replace(handler) // → applies in every async context; restoring throws when it never ran
 * const gate = point.pause(); gate.run(action); await gate.reached; gate.release() // → the evaluation waits, then continues with the original
 * point.capture('typo') // → the evaluation throws, naming what the expression can capture
 * ```
 *
 * Why does a test that replaces `db.get()` with a failure keep passing after a
 * refactor moves the read out of the code path? Because nothing ran the
 * replacement and nothing said so. And why does a test that waits for a paused
 * call hang for five seconds when the call never happens? Because nobody told
 * the waiter that the action had already finished.
 *
 * Four parts answer those questions: the **count** (how often a replacement's
 * handler ran, against `times`, with `on` choosing which evaluations it takes),
 * the **reckoning** (`verifyReplacements`, which checks everything whose action
 * was still running when it was installed), the **stack** of replacements that
 * apply everywhere, newest first, and the **gate** of a pause.
 *
 * For every scoped replacement and every number of evaluations inside its
 * action, the handler runs for exactly the evaluations `on` names (all of them
 * when `on` is absent), each run sees its evaluation's number as `call`, and
 * the run count must satisfy `times`: at least once when absent, exactly that
 * often when a number, anything when `'any'`. A synchronous action that
 * violates it makes `withReplacement` throw; an asynchronous action gets its
 * own promise back and the violation makes the next `verifyReplacements()`
 * throw (Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a
 * replacement that never runs must be loud; for an asynchronous action the
 * test fails at its end and the promise stays the action's own).
 *
 * For every sequence of `replace`, restore, and evaluation, an evaluation
 * outside any scope takes the newest replacement still installed for the
 * expression, in whatever async context it runs; inside a scoped replacement
 * for the same expression the scoped one wins; restoring a replacement that
 * never ran throws; and `verifyReplacements()` restores and checks whatever is
 * left (same decision: build `using r = point.replace(handler)`).
 *
 * For every pause, each evaluation that arrives before `release()` waits and
 * then continues with the original expression, later ones pass straight
 * through, `reached` resolves with the first arrival's locals, and it rejects
 * as soon as the action finishes without an arrival, with the action's own
 * error as the cause when it failed. A miss that no one awaited, and a pause
 * still holding when the test ends, make `verifyReplacements()` throw (same
 * decision: build the pause).
 *
 * For every shorthand, `returns`, `throws`, `resolves`, and `rejects` install
 * a replacement that applies everywhere and gives the evaluation exactly that
 * value, error, or promise (same decision: build the fault-injection
 * shorthands).
 *
 * For every `times` and `on` given to `withReplacement` or `replace`, installing
 * throws a `TypeError` unless `times` is absent, `'any'`, or a whole number of 0
 * or more, and `on` is absent, a whole number of 1 or more, or a list of such
 * numbers (same decision: an option that cannot mean anything must not be
 * accepted silently).
 *
 * For every value a visitor returns for a node, `select` takes the node only
 * when the value is that node or what its own `capture(...)` returned. Anything
 * else selects nothing, and when it was a truthy value, such as `true`, a copy
 * of the node, or another node's capture, the "matched 0" error says that the
 * visitor returned something that is not the node (`README.md`, "Select an
 * execution point in a test"; same decision: fix F8, where a visitor that
 * returned an object with an `id` was accepted and then selected nothing).
 *
 * For every list of capture names, an evaluation whose replacement asks for a
 * name that is not a local of the expression throws an error that names it and
 * lists the locals there are, and the next `verifyReplacements()` throws it
 * again; otherwise `locals` holds exactly the asked names (`README.md`,
 * "rejects unknown binding names"; same decision: fix F8).
 *
 * The models are small simulations of these rules over the history: a filter
 * over evaluation numbers, a stack, an event log. The drivers call the real
 * runtime with `invoke` standing in for instrumented code, and read results,
 * thrown errors, and the order of events.
 *
 * An error is observed by what it says about the expression and the count, not
 * by its full text. What `verifyReplacements` owes is global to the worker, so
 * every history first drains what an earlier one left.
 */
import { AsyncResource } from 'node:async_hooks'
import fc from 'fast-check'
import { afterEach } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { type Context, invoke, registerFile, select, verifyReplacements } from '../src/runtime.ts'

// The drivers leave replacements behind on purpose (asynchronous scopes, unused ones). The
// library's own check after each test is not what these laws are about, so it finds nothing.
afterEach(() => {
  try {
    verifyReplacements()
  } catch {
    // Reported by the laws that own it.
  }
})

const ORIGINAL = 1
const REPLACED = 100

type AnyPoint = {
  calls: number
  capture: (...keys: Array<string>) => AnyPoint
  withReplacement: <T>(handler: (context: AnyContext) => unknown, action: () => T, options?: object) => T
  replace: (handler: (context: AnyContext) => unknown, options?: object) => AnyReplacement
  returns: (value: unknown, options?: object) => AnyReplacement
  throws: (error: unknown, options?: object) => AnyReplacement
  resolves: (value: unknown, options?: object) => AnyReplacement
  rejects: (error: unknown, options?: object) => AnyReplacement
  pause: () => {
    run: <T>(action: () => T) => T
    reached: { then: <A, B>(onArrival: (arrival: { locals: Record<string, unknown> }) => A, onMiss: (error: unknown) => B) => Promise<A | B> }
    release: () => void
    calls: number
  }
}
type AnyReplacement = { calls: number; restore: () => void; [Symbol.dispose]: () => void }
/** What a handler is called with, whatever the expression and its captures. */
type AnyContext = Context<unknown, Record<string, unknown>>

let fixtures = 0

/** A file of its own, with one expression, and a clean slate for `verifyReplacements`. */
function fixture() {
  try {
    verifyReplacements()
  } catch {
    // An earlier history's leftovers are not this history's business.
  }
  fixtures += 1
  const file = `api-${fixtures}.ts`
  const id = `${file}#work:CallExpression:send:0`
  registerFile(file, [{ id, kind: 'CallExpression', inFunction: 'work', callee: 'send', nth: 0 }], [1])
  const point = select(file as never, ((n: { callee?: string }) =>
    n.callee === 'send' ? n : undefined) as never) as unknown as AnyPoint
  return { id, point }
}

/** What an error says: which expression, how often its replacement ran, and what was expected. */
function said(error: unknown, id: string) {
  const message = error instanceof Error ? error.message : String(error)
  const amount = (text: string | undefined) =>
    text === undefined ? null : text === 'at least once' ? text : text === 'once' ? 1 : Number.parseInt(text, 10)
  return {
    namesTheExpression: message.includes(`"${id}"`),
    ran: amount(/ran (once|\d+ times)/.exec(message)?.[1]),
    expected: amount(/expected (at least once|once|\d+ times)/.exec(message)?.[1]),
    explainsNeverRan: message.includes('Nothing evaluated this expression'),
  }
}

/** What a replacement that ran `ran` times is told when `times` asked for something else. */
function complaint(ran: number, times: 'default' | number) {
  return {
    namesTheExpression: true,
    ran,
    expected: times === 'default' ? 'at least once' : times,
    explainsNeverRan: ran === 0,
  }
}

/** What `verifyReplacements` reports: nothing, or each problem as `describe` reads it. */
function reckoning<T>(describe: (error: unknown) => T) {
  try {
    verifyReplacements()
    return { problems: 'nothing' as const, listsEachProblem: null }
  } catch (error) {
    if (!(error instanceof AggregateError)) return { problems: [describe(error)], listsEachProblem: null }
    return {
      problems: error.errors.map(describe),
      listsEachProblem: error.errors.every((problem: Error) => error.message.includes(problem.message)),
    }
  }
}

/** What an unexpected error is, for a trace: its kind, and whether the library said it. */
const whose = (error: unknown) => ({
  name: (error as Error).name,
  saidByTheLibrary: String((error as Error).message).startsWith('[execution-points]'),
})

/** Waits for a promise over a bounded number of microtask turns, so a promise that never settles is an observation. */
async function settled<T>(promise: PromiseLike<T>) {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  let value: unknown
  promise.then(
    (result) => {
      state = 'fulfilled'
      value = result
    },
    (error: unknown) => {
      state = 'rejected'
      value = error
    },
  )
  for (let turn = 0; turn < 200 && state === 'pending'; turn += 1) await Promise.resolve()
  return { state: state as 'pending' | 'fulfilled' | 'rejected', value }
}

// ---------------------------------------------------------------------------
// Law A1: A replacement must run as often as the test said
// ---------------------------------------------------------------------------

const TIMES = ['default', 'any', 0, 1, 2] as const
const TURNS = { every: undefined, first: [1], second: [2], 'first-and-third': [1, 3] } as const

interface CountHistory {
  action: 'sync' | 'async'
  times: (typeof TIMES)[number]
  on: keyof typeof TURNS
  evaluations: number
}

const enumeratedCountHistories: ReadonlyArray<CountHistory> = (['sync', 'async'] as const).flatMap((action) =>
  TIMES.flatMap((times) =>
    (Object.keys(TURNS) as Array<keyof typeof TURNS>).flatMap((on) =>
      [0, 1, 2, 3].map((evaluations) => ({ action, times, on, evaluations })),
    ),
  ),
)

// The handler takes the evaluations `on` names; `times` judges how many that were.
function countModel(history: CountHistory) {
  const turns: ReadonlyArray<number> | undefined = TURNS[history.on]
  const calls = Array.from({ length: history.evaluations }, (_, index) => index + 1)
  const taken = calls.filter((call) => !turns || turns.includes(call))
  const satisfied =
    history.times === 'any' || (history.times === 'default' ? taken.length > 0 : taken.length === history.times)
  const told = history.times === 'any' ? undefined : complaint(taken.length, history.times)
  return {
    // A run returns REPLACED plus the `call` it was given; the others evaluate the original.
    results: calls.map((call) => (taken.includes(call) ? REPLACED + call : ORIGINAL)),
    originalEvaluations: calls.length - taken.length,
    pointCalls: taken.length,
    atReturn: history.action === 'async' ? 'the-actions-own-promise' : satisfied ? 'the-actions-result' : told,
    atReckoning: {
      problems: history.action === 'async' && !satisfied ? [told] : 'nothing',
      listsEachProblem: null,
    },
    // The reckoning starts the count for the next test at zero.
    pointCallsAfterReckoning: 0,
  }
}

oracleProperty({
  id: 'runtime-replacement-count',
  owns: ['src/runtime.ts#createPointHandle', 'src/runtime.ts#invoke', 'src/runtime.ts#verifyReplacements'],
  law: {
    statement:
      'For every scoped replacement and every number of evaluations inside its action, the handler runs for exactly the evaluations `on` names (all of them when absent), each run sees its evaluation number as `call`, and the run count must satisfy `times` (at least once when absent, exactly that often when a number, anything when "any"): a synchronous action that violates it makes withReplacement throw, and an asynchronous action gets its own promise back while the violation makes the next verifyReplacements() throw.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a replacement that never runs must be loud; build strict-by-default with `times`, a hit index in the context, and `point.calls`; for an asynchronous action the test fails at its end through a hook and the promise stays the action\'s own (README.md, "the same promise").',
    limits: 'Zero to three evaluations per action, five settings of `times`, four of `on`; the asynchronous action yields once before it evaluates.',
  },
  histories: {
    enumerated: enumeratedCountHistories,
    states: [
      'never-ran-by-default',
      'ran-too-often',
      'ran-too-seldom',
      'forbidden-and-ran',
      'evaluation-left-to-the-original',
      'asynchronous-violation',
    ],
  },
  label: (h) => `${h.action} times:${h.times} on:${h.on} evaluations:${h.evaluations}`,
  model: (history) => countModel(history),
  driver: async (history, observe) => {
    const expected = countModel(history)
    const ran = expected.pointCalls
    if (history.times === 'default' && ran === 0) observe('reach', 'never-ran-by-default')
    if (typeof history.times === 'number' && history.times > 0 && ran > history.times) observe('reach', 'ran-too-often')
    if (typeof history.times === 'number' && ran < history.times) observe('reach', 'ran-too-seldom')
    if (history.times === 0 && ran > 0) observe('reach', 'forbidden-and-ran')
    if (ran < history.evaluations) observe('reach', 'evaluation-left-to-the-original')
    if (history.action === 'async' && expected.atReckoning.problems !== 'nothing') observe('reach', 'asynchronous-violation')
    try {
      const { id, point } = fixture()
      const turns: ReadonlyArray<number> | undefined = TURNS[history.on]
      const options = {
        ...(history.times === 'default' ? {} : { times: history.times }),
        // One evaluation number may be given bare, several as a list.
        ...(turns ? { on: turns.length === 1 ? turns[0] : turns } : {}),
      }
      let originalEvaluations = 0
      const results: Array<unknown> = []
      const evaluateAll = () => {
        for (let i = 0; i < history.evaluations; i += 1) {
          results.push(
            invoke(
              id,
              () => {
                originalEvaluations += 1
                return ORIGINAL
              },
              () => ({}),
            ),
          )
        }
        return 'done'
      }
      const handler = ({ call }: { call: number }) => REPLACED + call

      let atReturn: unknown
      if (history.action === 'sync') {
        try {
          atReturn = point.withReplacement(handler, evaluateAll, options) === 'done' ? 'the-actions-result' : 'another-value'
        } catch (error) {
          atReturn = said(error, id)
        }
      } else {
        let made: Promise<string> | undefined
        const returned = point.withReplacement(
          handler,
          () => (made = Promise.resolve().then(evaluateAll)),
          options,
        )
        atReturn = returned === made ? 'the-actions-own-promise' : 'another-promise'
        if ((await settled(returned)).state !== 'fulfilled') atReturn = 'a-promise-that-does-not-fulfill'
      }
      const pointCalls = point.calls
      const atReckoning = reckoning((error) => said(error, id))
      observe('count', {
        results,
        originalEvaluations,
        pointCalls,
        atReturn,
        atReckoning,
        pointCallsAfterReckoning: point.calls,
      })
    } catch (err) {
      observe('count', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('count', 'replacement-count', observations.find((o) => o.checkpoint === 'count')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'a-replacement-that-never-ran-returns-quietly',
      law: 'replacement-count',
      history: { enumerated: 'sync times:default on:every evaluations:0' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'count' ? { ...o, value: { ...(o.value as object), atReturn: 'the-actions-result' } } : o,
        ),
    },
    {
      name: 'an-asynchronous-violation-is-never-reported',
      law: 'replacement-count',
      history: { enumerated: 'async times:1 on:every evaluations:2' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'count'
            ? { ...o, value: { ...(o.value as object), atReckoning: { problems: 'nothing', listsEachProblem: null } } }
            : o,
        ),
    },
    {
      name: 'the-handler-takes-an-evaluation-it-was-not-given',
      law: 'replacement-count',
      history: { enumerated: 'sync times:any on:second evaluations:2' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'count'
            ? { ...o, value: { ...(o.value as object), results: [REPLACED + 1, REPLACED + 2] } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law A2: `replace` applies everywhere until it is restored
// ---------------------------------------------------------------------------

type EverywhereStep =
  | 'install'
  | 'restore-newest'
  | 'dispose-newest'
  | 'restore-oldest'
  | 'evaluate'
  | 'evaluate-elsewhere'
  | 'evaluate-in-scope'

interface EverywhereHistory {
  steps: ReadonlyArray<EverywhereStep>
}

const everywhereArbitrary: fc.Arbitrary<EverywhereHistory> = fc.record({
  steps: fc.array(
    fc.constantFrom(
      'install',
      'restore-newest',
      'dispose-newest',
      'restore-oldest',
      'evaluate',
      'evaluate-elsewhere',
      'evaluate-in-scope',
    ),
    { maxLength: 8 },
  ),
})

const SCOPED = 500

// The stack of replacements still installed: an evaluation outside a scope takes the newest.
function everywhereModel(history: EverywhereHistory) {
  const installed: Array<{ value: number; runs: number }> = []
  const all: Array<{ value: number; runs: number }> = []
  const restore = (replacement: { value: number; runs: number } | undefined) => {
    if (!replacement) return 'nothing-installed'
    installed.splice(installed.indexOf(replacement), 1)
    return replacement.runs > 0 ? 'restored' : complaint(0, 'default')
  }
  const steps = history.steps.map((step) => {
    if (step === 'install') {
      const replacement = { value: REPLACED + all.length, runs: 0 }
      installed.push(replacement)
      all.push(replacement)
      return 'installed'
    }
    if (step === 'restore-newest' || step === 'dispose-newest') return restore(installed.at(-1))
    if (step === 'restore-oldest') return restore(installed[0])
    if (step === 'evaluate-in-scope') return SCOPED
    const newest = installed.at(-1)
    if (!newest) return ORIGINAL
    newest.runs += 1
    return newest.value
  })
  // Whatever is still installed is restored and checked at the reckoning.
  const unused = installed.filter((replacement) => replacement.runs === 0).map(() => complaint(0, 'default'))
  return {
    steps,
    atReckoning: {
      problems: unused.length > 0 ? unused : 'nothing',
      listsEachProblem: unused.length > 1 ? true : null,
    },
    callsOfEach: all.map((replacement) => replacement.runs),
    afterReckoning: ORIGINAL,
    // Restoring twice, or after the reckoning, does nothing.
    restoredAgain: all.map(() => 'ignored'),
  }
}

oracleProperty({
  id: 'runtime-replace-everywhere',
  owns: ['src/runtime.ts#createPointHandle', 'src/runtime.ts#invoke', 'src/runtime.ts#verifyReplacements'],
  law: {
    statement:
      'For every sequence of replace, restore, and evaluation, an evaluation outside any scope takes the newest replacement still installed for the expression, in whatever async context it runs; inside a scoped replacement for the same expression the scoped one wins; restoring a replacement that never ran throws; and verifyReplacements() restores and checks whatever is left.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build `using r = point.replace(handler)`, active for the whole worker until the block ends and verified on dispose; it is also the scope a test against a running server needs.',
    limits: 'Up to eight steps over one expression; "elsewhere" is an async context created before the first replacement. Arguments of the wrong kind are for the compiler to reject (decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: the sources are TypeScript, and what the compiler rejects is not checked again at run time); the runtime promises nothing for them.',
  },
  histories: {
    arbitrary: everywhereArbitrary,
    runs: 120,
    fixedSeeds: [42],
    states: [
      'restored-out-of-order',
      'restored-in-order',
      'restored-without-running',
      'left-installed-at-reckoning',
      'evaluated-in-another-context',
      'scoped-over-everywhere',
    ],
    constructed: [
      {
        name: 'oldest-restored-first',
        enters: ['restored-out-of-order'],
        build: (): EverywhereHistory => ({ steps: ['install', 'install', 'evaluate', 'restore-oldest', 'evaluate', 'restore-newest'] }),
      },
      {
        name: 'newest-restored-first',
        enters: ['restored-in-order'],
        build: (): EverywhereHistory => ({ steps: ['install', 'install', 'restore-newest', 'evaluate', 'restore-oldest', 'evaluate'] }),
      },
      {
        name: 'two-left-unused',
        enters: ['left-installed-at-reckoning'],
        build: (): EverywhereHistory => ({ steps: ['install', 'install'] }),
      },
      {
        name: 'never-used',
        enters: ['restored-without-running', 'left-installed-at-reckoning'],
        build: (): EverywhereHistory => ({ steps: ['install', 'dispose-newest', 'install'] }),
      },
      {
        name: 'server-style-context',
        enters: ['evaluated-in-another-context'],
        build: (): EverywhereHistory => ({ steps: ['install', 'evaluate-elsewhere', 'restore-newest', 'evaluate-elsewhere'] }),
      },
      {
        name: 'scope-inside-everywhere',
        enters: ['scoped-over-everywhere'],
        build: (): EverywhereHistory => ({ steps: ['install', 'evaluate-in-scope', 'evaluate', 'restore-newest'] }),
      },
    ],
  },
  model: (history) => everywhereModel(history),
  driver: (history, observe) => {
    const expected = everywhereModel(history)
    const { steps } = history
    if (steps.some((step, index) => step === 'restore-oldest' && steps.slice(0, index).filter((s) => s === 'install').length > 1)) {
      observe('reach', 'restored-out-of-order')
    }
    if (steps.some((step, index) => step === 'restore-newest' && steps.slice(0, index).filter((s) => s === 'install').length > 1)) {
      observe('reach', 'restored-in-order')
    }
    if (expected.steps.some((step) => typeof step === 'object')) observe('reach', 'restored-without-running')
    if (expected.atReckoning.problems !== 'nothing') observe('reach', 'left-installed-at-reckoning')
    if (steps.includes('evaluate-elsewhere') && steps.includes('install')) observe('reach', 'evaluated-in-another-context')
    if (steps.includes('evaluate-in-scope') && steps.indexOf('install') !== -1) observe('reach', 'scoped-over-everywhere')
    try {
      const { id, point } = fixture()
      const elsewhere = new AsyncResource('execution-points-oracle')
      const evaluate = () => invoke(id, () => ORIGINAL, () => ({}))
      const installed: Array<AnyReplacement> = []
      const all: Array<AnyReplacement> = []
      const restore = (replacement: AnyReplacement | undefined, how: 'restore' | 'dispose') => {
        if (!replacement) return 'nothing-installed'
        installed.splice(installed.indexOf(replacement), 1)
        try {
          if (how === 'dispose') replacement[Symbol.dispose]()
          else replacement.restore()
          return 'restored'
        } catch (error) {
          return said(error, id)
        }
      }
      const observed = steps.map((step) => {
        if (step === 'install') {
          const value = REPLACED + all.length
          const replacement = point.replace(() => value)
          installed.push(replacement)
          all.push(replacement)
          return 'installed'
        }
        if (step === 'restore-newest') return restore(installed.at(-1), 'restore')
        if (step === 'dispose-newest') return restore(installed.at(-1), 'dispose')
        if (step === 'restore-oldest') return restore(installed[0], 'restore')
        if (step === 'evaluate-in-scope') return point.withReplacement(() => SCOPED, evaluate)
        if (step === 'evaluate-elsewhere') return elsewhere.runInAsyncScope(evaluate)
        return evaluate()
      })
      const callsOfEach = all.map((replacement) => replacement.calls)
      const atReckoning = reckoning((error) => said(error, id))
      const afterReckoning = evaluate()
      const restoredAgain = all.map((replacement) => {
        try {
          replacement.restore()
          return 'ignored'
        } catch (error) {
          return said(error, id)
        }
      })
      observe('everywhere', {
        steps: observed,
        atReckoning,
        callsOfEach,
        afterReckoning,
        restoredAgain,
      })
    } catch (err) {
      observe('everywhere', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('everywhere', 'replace-everywhere', observations.find((o) => o.checkpoint === 'everywhere')?.value, expected) ??
    pass,
  calibrations: [
    {
      name: 'a-replacement-stays-in-the-context-that-installed-it',
      law: 'replace-everywhere',
      history: { constructed: 'server-style-context' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'everywhere'
            ? { ...o, value: { ...(o.value as object), steps: ['installed', ORIGINAL, complaint(0, 'default'), ORIGINAL] } }
            : o,
        ),
    },
    {
      name: 'restoring-the-oldest-drops-the-newest',
      law: 'replace-everywhere',
      history: { constructed: 'oldest-restored-first' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'everywhere'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  steps: ['installed', 'installed', REPLACED + 1, complaint(0, 'default'), ORIGINAL, 'nothing-installed'],
                },
              }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law A3: A pause holds an evaluation, and says when there is nothing to hold
// ---------------------------------------------------------------------------

interface PauseHistory {
  /** An async action awaits each evaluation before the next; a sync one starts them all at once. */
  action: 'async' | 'sync'
  /** How often the action evaluates the expression. */
  arrivals: number
  release: 'after-the-first-arrival' | 'before-the-action' | 'never'
  watch: 'awaits-reached' | 'ignores-reached'
  /** An action that fails does so without ever evaluating the expression. */
  ending: 'finishes' | 'fails'
}

const enumeratedPauseHistories: ReadonlyArray<PauseHistory> = (['async', 'sync'] as const).flatMap((action) =>
  [0, 1, 2].flatMap((arrivals) =>
    (['after-the-first-arrival', 'before-the-action', 'never'] as const).flatMap((release) =>
      (['awaits-reached', 'ignores-reached'] as const).flatMap((watch) =>
        (arrivals === 0 ? (['finishes', 'fails'] as const) : (['finishes'] as const)).map((ending) => ({
          action,
          arrivals,
          release,
          watch,
          ending,
        })),
      ),
    ),
  ),
)

// The log a test and its action write, in the order the rule forces.
function pauseModel(history: PauseHistory) {
  const { action, arrivals, release, watch, ending } = history
  const releasedFirst = release === 'before-the-action'
  // Every evaluation that arrives before the release waits. An async action has one in flight
  // at a time, so only its first can be held; a sync action starts all of them at once.
  const heldCount = releasedFirst ? 0 : action === 'async' ? Math.min(arrivals, 1) : arrivals
  const held = heldCount > 0
  const stuck = held && release === 'never'
  const log: Array<string> = []

  // What happens while run() is on the stack.
  if (action === 'async') {
    if (arrivals > 0) log.push('evaluate 0', ...(releasedFirst ? ['original'] : []))
    else log.push(ending === 'fails' ? 'failing' : 'finished')
  } else {
    for (let i = 0; i < arrivals; i += 1) log.push(`evaluate ${i}`, ...(releasedFirst ? ['original'] : []))
    log.push(ending === 'fails' ? 'failing' : 'returned')
  }

  if (held && watch === 'awaits-reached') log.push('reached')
  if (held && release === 'after-the-first-arrival') log.push('release')
  // What the held evaluations, and everything after them, do once they are let go.
  const rest = () => {
    for (let i = 0; i < heldCount; i += 1) log.push('original')
    if (action === 'async' && arrivals > 0) {
      log.push(`value ${ORIGINAL}`)
      for (let i = 1; i < arrivals; i += 1) log.push(`evaluate ${i}`, 'original', `value ${ORIGINAL}`)
      log.push('finished')
    }
    // A sync action hands back what its evaluations returned, or nothing when there were none.
    if (action === 'sync' && arrivals > 0) {
      log.push(`values [${Array.from({ length: arrivals }, () => ORIGINAL).join(',')}]`)
    }
  }
  if (!stuck) rest()
  const missed = arrivals === 0
  const miss = { finishedWithoutReaching: true, causeIsTheActionsError: ending === 'fails' }
  // The reckoning lets held evaluations go, so the action then runs to its end.
  const problems = stuck ? [{ stillPaused: true }] : missed && watch === 'ignores-reached' ? [miss] : ('nothing' as const)
  if (stuck) rest()
  return {
    log,
    reached: watch === 'ignores-reached' ? 'not-awaited' : missed ? miss : { locals: { key: 'k' } },
    theAction:
      ending === 'finishes' ? 'completed' : action === 'sync' ? 'threw-its-own-error' : 'rejected-with-its-own-error',
    calls: arrivals,
    atReckoning: { problems, listsEachProblem: null },
    unhandledRejections: 0,
  }
}

oracleProperty({
  id: 'runtime-pause',
  owns: ['src/runtime.ts#createPointHandle', 'src/runtime.ts#invoke', 'src/runtime.ts#verifyReplacements'],
  law: {
    statement:
      'For every pause, each evaluation that arrives before release() waits and then continues with the original expression, later ones pass straight through, `reached` resolves with the first arrival\'s locals, and it rejects as soon as the action finishes without an arrival, with the action\'s own error as the cause when it failed; a miss that no one awaited, and a pause still holding when the test ends, make verifyReplacements() throw.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build a built-in pause whose `reached` rejects as soon as the action finishes without reaching the point; a replacement that never runs must be loud.',
    limits:
      'An action that evaluates the expression zero to two times, awaiting each or starting all at once; the expression evaluates to a promise; waits are bounded by microtask turns, so a promise that never settles is observed as pending. Arguments of the wrong kind are for the compiler to reject (decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: the sources are TypeScript, and what the compiler rejects is not checked again at run time); the runtime promises nothing for them.',
  },
  histories: {
    enumerated: enumeratedPauseHistories,
    states: [
      'held-then-released',
      'several-held-at-once',
      'passed-after-release',
      'finished-without-arriving',
      'failed-without-arriving',
      'left-holding',
    ],
  },
  label: (h) => `${h.action} arrivals:${h.arrivals} release:${h.release} ${h.watch} ${h.ending}`,
  model: (history) => pauseModel(history),
  driver: async (history, observe) => {
    const { action, arrivals, release, watch, ending } = history
    const releasedFirst = release === 'before-the-action'
    const held = arrivals > 0 && !releasedFirst
    const stuck = held && release === 'never'
    if (held && release === 'after-the-first-arrival') observe('reach', 'held-then-released')
    if (held && action === 'sync' && arrivals > 1) observe('reach', 'several-held-at-once')
    if (arrivals > 0 && (releasedFirst || (action === 'async' && arrivals > 1 && !stuck))) {
      observe('reach', 'passed-after-release')
    }
    if (arrivals === 0 && ending === 'finishes') observe('reach', 'finished-without-arriving')
    if (ending === 'fails') observe('reach', 'failed-without-arriving')
    if (stuck) observe('reach', 'left-holding')

    let unhandledRejections = 0
    const onUnhandledRejection = () => {
      unhandledRejections += 1
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const { id, point } = fixture()
      const log: Array<string> = []
      const gate = point.capture('key').pause()
      const failure = new Error('the action failed')
      const evaluate = () =>
        invoke(
          id,
          () => {
            log.push('original')
            return Promise.resolve(ORIGINAL)
          },
          () => ({ key: () => 'k' }),
        ) as Promise<number>
      const end = () => {
        if (ending === 'fails') {
          log.push('failing')
          throw failure
        }
      }
      const asyncAction = async () => {
        for (let i = 0; i < arrivals; i += 1) {
          log.push(`evaluate ${i}`)
          log.push(`value ${await evaluate()}`)
        }
        end()
        log.push('finished')
      }
      const syncAction = () => {
        const pending: Array<Promise<number>> = []
        for (let i = 0; i < arrivals; i += 1) {
          log.push(`evaluate ${i}`)
          pending.push(evaluate())
        }
        end()
        log.push('returned')
        return pending.length > 0 ? pending : undefined
      }
      const describe = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('finished without reaching') && message.includes(`"${id}"`)) {
          return { finishedWithoutReaching: true, causeIsTheActionsError: (error as Error).cause === failure }
        }
        if (message.includes('still paused') && message.includes(`"${id}"`)) return { stillPaused: true }
        return { unexpected: message }
      }

      if (releasedFirst) gate.release()
      let running: Promise<void> | Array<Promise<number>> | undefined
      let theAction = 'completed'
      try {
        running = action === 'async' ? gate.run(asyncAction) : gate.run(syncAction)
      } catch (error) {
        theAction = error === failure ? 'threw-its-own-error' : 'threw-something-else'
      }

      // Chaining on `reached` directly is what a test's `await` does, and it must hand the outcome on.
      const awaitReached = async () => {
        const outcome = await settled(
          gate.reached.then(
            (arrival) => ({ locals: { ...arrival.locals } }),
            (error) => describe(error),
          ),
        )
        return outcome.state === 'fulfilled' ? outcome.value : 'reached-never-settles'
      }
      let reached: unknown = 'not-awaited'
      if (held) {
        if (watch === 'awaits-reached') {
          reached = await awaitReached()
          log.push('reached')
        }
        if (release === 'after-the-first-arrival') {
          log.push('release')
          gate.release()
        }
      }
      const finish = async () => {
        if (running instanceof Promise) {
          const outcome = await settled(running)
          if (outcome.state === 'rejected') {
            theAction = outcome.value === failure ? 'rejected-with-its-own-error' : 'rejected-with-something-else'
          }
          if (outcome.state === 'pending') theAction = 'never-finishes'
        } else if (running) {
          const outcome = await settled(Promise.all(running))
          log.push(outcome.state === 'fulfilled' ? `values [${(outcome.value as Array<number>).join(',')}]` : 'values never arrive')
        }
      }
      if (!stuck) await finish()
      if (!held && watch === 'awaits-reached') reached = await awaitReached()
      const atReckoning = reckoning(describe)
      if (stuck) await finish()

      // An unhandled rejection is announced after the microtasks of this turn.
      await new Promise((resolve) => setImmediate(resolve))
      observe('pause', {
        log,
        reached,
        theAction,
        calls: gate.calls,
        atReckoning,
        unhandledRejections,
      })
    } catch (err) {
      observe('pause', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  },
  check: (_history, observations, expected) =>
    differs('pause', 'pause', observations.find((o) => o.checkpoint === 'pause')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'a-paused-evaluation-runs-before-the-release',
      law: 'pause',
      history: { enumerated: 'async arrivals:1 release:after-the-first-arrival awaits-reached finishes' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'pause'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  log: ['evaluate 0', 'original', 'reached', 'release', `value ${ORIGINAL}`, 'finished'],
                },
              }
            : o,
        ),
    },
    {
      name: 'a-missed-pause-goes-unnoticed',
      law: 'pause',
      history: { enumerated: 'async arrivals:0 release:never ignores-reached finishes' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'pause'
            ? { ...o, value: { ...(o.value as object), atReckoning: { problems: 'nothing', listsEachProblem: null } } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law A6: Options that cannot mean anything are refused
// ---------------------------------------------------------------------------

const TIMES_CANDIDATES = [undefined, 'any', 0, 1, 3, -1, 1.5, 'many', null, Number.NaN] as const
const ON_CANDIDATES = [undefined, 1, 3, [1, 2], [], 0, -2, 1.5, [1, 0], 'first', null] as const

interface OptionsHistory {
  times: number
  on: number
  /** Which way of installing is given the options. */
  through: 'withReplacement' | 'replace'
}

const enumeratedOptionsHistories: ReadonlyArray<OptionsHistory> = (['withReplacement', 'replace'] as const).flatMap(
  (through) =>
    TIMES_CANDIDATES.flatMap((_, times) => ON_CANDIDATES.map((__, on) => ({ times, on, through }))),
)

// `times` is a count or 'any'; `on` is one evaluation number or a list of them, counted from 1.
function optionsModel(history: OptionsHistory) {
  const times: unknown = TIMES_CANDIDATES[history.times]
  const on: unknown = ON_CANDIDATES[history.on]
  const isCount = (value: unknown, least: number) => typeof value === 'number' && Number.isInteger(value) && value >= least
  const timesMeansSomething = times === undefined || times === 'any' || isCount(times, 0)
  const onMeansSomething =
    on === undefined || isCount(on, 1) || (Array.isArray(on) && on.every((turn: unknown) => isCount(turn, 1)))
  return { installing: timesMeansSomething && onMeansSomething ? 'accepted' : 'TypeError' }
}

oracleProperty({
  id: 'runtime-replacement-options',
  owns: ['src/runtime.ts#createPointHandle'],
  law: {
    statement:
      'For every `times` and `on` given to withReplacement or replace, installing throws a TypeError unless `times` is absent, "any", or a whole number of 0 or more, and `on` is absent, a whole number of 1 or more, or a list of such numbers.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build strict-by-default with `times` and a hit index; an option that cannot mean anything must not be accepted silently.',
    limits: 'Ten candidate values for `times` and eleven for `on`.',
  },
  histories: {
    enumerated: enumeratedOptionsHistories,
    states: ['both-meaningful', 'times-meaningless', 'on-meaningless'],
  },
  label: (h) => `${h.through} times#${h.times} on#${h.on}`,
  model: (history) => optionsModel(history),
  driver: (history, observe) => {
    const whenOnAbsent = optionsModel({ ...history, on: 0 }).installing
    const whenTimesAbsent = optionsModel({ ...history, times: 0 }).installing
    if (whenOnAbsent === 'accepted' && whenTimesAbsent === 'accepted') observe('reach', 'both-meaningful')
    if (whenOnAbsent === 'TypeError') observe('reach', 'times-meaningless')
    if (whenTimesAbsent === 'TypeError') observe('reach', 'on-meaningless')
    try {
      const { id, point } = fixture()
      const options = { times: TIMES_CANDIDATES[history.times], on: ON_CANDIDATES[history.on] }
      let installing = 'accepted'
      try {
        if (history.through === 'replace') point.replace(() => REPLACED, options)
        else point.withReplacement(() => REPLACED, () => invoke(id, () => ORIGINAL, () => ({})), options)
      } catch (error) {
        // An accepted replacement may still complain about how often it ran; that is another law.
        if (error instanceof TypeError) installing = 'TypeError'
      }
      observe('options', { installing })
    } catch (err) {
      observe('options', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('options', 'replacement-options', observations.find((o) => o.checkpoint === 'options')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'a-negative-count-is-accepted',
      law: 'replacement-options',
      history: { enumerated: 'withReplacement times#5 on#0' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'options' ? { ...o, value: { installing: 'accepted' } } : o)),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law A4: The shorthands give an evaluation exactly what they were given
// ---------------------------------------------------------------------------

const SHORTHANDS = ['returns', 'throws', 'resolves', 'rejects'] as const

interface ShorthandHistory {
  shorthand: (typeof SHORTHANDS)[number]
  context: 'here' | 'elsewhere'
  used: boolean
}

const enumeratedShorthandHistories: ReadonlyArray<ShorthandHistory> = SHORTHANDS.flatMap((shorthand) =>
  (['here', 'elsewhere'] as const).flatMap((context) => [true, false].map((used) => ({ shorthand, context, used }))),
)

// A value comes back as it is, an error is the very object that was given, and the two
// promise forms deliver the same through a promise.
function shorthandModel(history: ShorthandHistory) {
  const outcome = {
    returns: { returned: 'the-value' },
    throws: { threw: 'the-error' },
    resolves: { resolvedWith: 'the-value' },
    rejects: { rejectedWith: 'the-error' },
  }[history.shorthand]
  return {
    evaluation: history.used ? outcome : 'not-evaluated',
    atRestore: history.used ? 'restored' : complaint(0, 'default'),
    afterRestore: ORIGINAL,
  }
}

oracleProperty({
  id: 'runtime-shorthands',
  owns: ['src/runtime.ts#createPointHandle', 'src/runtime.ts#invoke'],
  law: {
    statement:
      'For every shorthand, returns, throws, resolves, and rejects install a replacement that applies in every async context and gives the evaluation exactly that value, that error, or a promise of it, until it is restored; restoring one that never ran throws.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build the fault-injection shorthands (`point.throws(error)`, `point.returns(value)`).',
    limits: 'One evaluation, in the installing context or in one created before it.',
  },
  histories: {
    enumerated: enumeratedShorthandHistories,
    states: ['value-delivered', 'error-delivered', 'never-evaluated'],
  },
  label: (h) => `${h.shorthand} ${h.context} ${h.used ? 'used' : 'unused'}`,
  model: (history) => shorthandModel(history),
  driver: async (history, observe) => {
    const { shorthand, context, used } = history
    if (used && (shorthand === 'returns' || shorthand === 'resolves')) observe('reach', 'value-delivered')
    if (used && (shorthand === 'throws' || shorthand === 'rejects')) observe('reach', 'error-delivered')
    if (!used) observe('reach', 'never-evaluated')
    try {
      const { id, point } = fixture()
      const elsewhere = new AsyncResource('execution-points-oracle')
      const value = { is: 'the value' }
      const error = new Error('the error')
      const given = shorthand === 'returns' || shorthand === 'resolves' ? value : error
      const replacement = point[shorthand](given)
      const evaluate = () => invoke(id, () => ORIGINAL, () => ({})) as unknown
      const name = (thing: unknown) => (thing === value ? 'the-value' : thing === error ? 'the-error' : 'something-else')
      let evaluation: unknown = 'not-evaluated'
      if (used) {
        try {
          const result = context === 'here' ? evaluate() : elsewhere.runInAsyncScope(evaluate)
          if (result instanceof Promise) {
            const end = await settled(result)
            evaluation =
              end.state === 'fulfilled'
                ? { resolvedWith: name(end.value) }
                : end.state === 'rejected'
                  ? { rejectedWith: name(end.value) }
                  : 'a-promise-that-never-settles'
          } else {
            evaluation = { returned: name(result) }
          }
        } catch (thrown) {
          evaluation = { threw: name(thrown) }
        }
      }
      let atRestore: unknown = 'restored'
      try {
        replacement.restore()
      } catch (restoreError) {
        atRestore = said(restoreError, id)
      }
      observe('shorthand', { evaluation, atRestore, afterRestore: evaluate() })
    } catch (err) {
      observe('shorthand', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('shorthand', 'shorthands', observations.find((o) => o.checkpoint === 'shorthand')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'throws-returns-the-error-instead-of-throwing-it',
      law: 'shorthands',
      history: { enumerated: 'throws here used' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'shorthand'
            ? { ...o, value: { ...(o.value as object), evaluation: { returned: 'the-error' } } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law A5: A capture the expression cannot see is refused
// ---------------------------------------------------------------------------

// Names a test might ask for: real locals, a typo, and names every object inherits.
const NAME_POOL = ['a', 'b', 'c', 'toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'] as const

interface CaptureHistory {
  /** The locals in scope at the expression, as the instrumented code offers them. */
  locals: ReadonlyArray<(typeof NAME_POOL)[number]>
  /** The names the replacement captures, in order. */
  asked: ReadonlyArray<(typeof NAME_POOL)[number]>
}

const captureArbitrary: fc.Arbitrary<CaptureHistory> = fc.record({
  locals: fc.uniqueArray(fc.constantFrom(...NAME_POOL), { maxLength: 4 }),
  asked: fc.array(fc.constantFrom(...NAME_POOL), { maxLength: 4 }),
})

// The first asked name that is not a local stops the evaluation; otherwise each asked name
// yields that local's value.
function captureModel(history: CaptureHistory) {
  const unknown = history.asked.find((name) => !history.locals.includes(name))
  if (unknown !== undefined) {
    const complaint = { refused: unknown, lists: [...history.locals] }
    return { evaluation: complaint, atReckoning: { problems: [complaint], listsEachProblem: null } }
  }
  return {
    evaluation: { locals: [...new Set(history.asked)].map((name) => [name, `value of ${name}`]) },
    atReckoning: { problems: 'nothing', listsEachProblem: null },
  }
}

oracleProperty({
  id: 'runtime-capture-names',
  owns: ['src/runtime.ts#invoke', 'src/runtime.ts#verifyReplacements'],
  law: {
    statement:
      'For every list of capture names, an evaluation whose replacement asks for a name that is not a local of the expression throws an error that names it and lists the locals there are, and the next verifyReplacements() throws it again; otherwise locals holds exactly the asked names.',
    authority:
      'README.md ("`.capture(...)` ... rejects unknown binding names immediately") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: fix F8 (the runtime accepted capture names that are not locals and read them from Object.prototype).',
    limits: 'Up to four locals and four asked names from a pool of eight, including names that every object inherits.',
  },
  histories: {
    arbitrary: captureArbitrary,
    runs: 150,
    fixedSeeds: [42],
    states: ['inherited-name-refused', 'typo-refused', 'inherited-name-is-a-real-local', 'all-names-known'],
    constructed: [
      {
        name: 'asks-for-toString',
        enters: ['inherited-name-refused'],
        build: (): CaptureHistory => ({ locals: ['a'], asked: ['a', 'toString'] }),
      },
      { name: 'asks-for-a-typo', enters: ['typo-refused'], build: (): CaptureHistory => ({ locals: ['a', 'b'], asked: ['c'] }) },
      {
        name: 'a-local-named-constructor',
        enters: ['inherited-name-is-a-real-local', 'all-names-known'],
        build: (): CaptureHistory => ({ locals: ['constructor', '__proto__'], asked: ['__proto__', 'constructor'] }),
      },
    ],
  },
  model: (history) => captureModel(history),
  driver: (history, observe) => {
    const inherited = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']
    const unknown = history.asked.find((name) => !history.locals.includes(name))
    if (unknown !== undefined && inherited.includes(unknown)) observe('reach', 'inherited-name-refused')
    if (unknown !== undefined && !inherited.includes(unknown)) observe('reach', 'typo-refused')
    if (unknown === undefined && history.asked.some((name) => inherited.includes(name))) {
      observe('reach', 'inherited-name-is-a-real-local')
    }
    if (unknown === undefined) observe('reach', 'all-names-known')
    try {
      const { id, point } = fixture()
      // The plugin emits an object literal with one computed key per local.
      const captures = () => {
        const thunks: Record<string, () => string> = {}
        for (const name of history.locals) {
          Object.defineProperty(thunks, name, { value: () => `value of ${name}`, enumerable: true })
        }
        return thunks
      }
      const describe = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const refused = /"(.+?)" is not a local/.exec(message)?.[1]
        const list = /It can capture: (.*)\.$/.exec(message)?.[1]
        return refused === undefined
          ? { unexpected: message }
          : { refused, lists: list === undefined || list === 'nothing' ? [] : list.split(', ') }
      }
      let evaluation: unknown
      try {
        evaluation = point.capture(...history.asked).withReplacement(
          ({ locals }: { locals: Record<string, unknown> }) => ({
            locals: Object.getOwnPropertyNames(locals).map((name) => [name, locals[name]]),
          }),
          () => invoke(id, () => ORIGINAL, captures),
        )
      } catch (error) {
        evaluation = describe(error)
      }
      observe('capture', { evaluation, atReckoning: reckoning(describe) })
    } catch (err) {
      observe('capture', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('capture', 'capture-names', observations.find((o) => o.checkpoint === 'capture')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'an-inherited-name-is-read-from-the-prototype',
      law: 'capture-names',
      history: { constructed: 'asks-for-toString' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'capture'
            ? {
                ...o,
                value: {
                  evaluation: { locals: [['a', 'value of a'], ['toString', '[object Undefined]']] },
                  atReckoning: { problems: 'nothing', listsEachProblem: null },
                },
              }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law A7: A visitor selects a node by returning that node
// ---------------------------------------------------------------------------

const VISITOR_RETURNS = [
  'the-node',
  'its-capture',
  'nothing',
  'false',
  'true',
  'a-copy-of-the-node',
  'an-object-with-its-id',
  'the-capture-of-another-node',
] as const

interface VisitorHistory {
  /** What the visitor returns for the one node the test means. */
  returns: (typeof VISITOR_RETURNS)[number]
}

// Only the node itself, or what its own capture() returned, selects it. A truthy value that is
// neither is a mistake the error points out.
function visitorModel(history: VisitorHistory) {
  if (history.returns === 'the-node' || history.returns === 'its-capture') {
    return { selecting: 'selected-the-node', pointsOutTheReturn: false }
  }
  return { selecting: 'matched-none', pointsOutTheReturn: history.returns !== 'nothing' && history.returns !== 'false' }
}

oracleProperty({
  id: 'runtime-visitor-return',
  owns: ['src/runtime.ts#select'],
  law: {
    statement:
      'For every value a visitor returns for a node, select takes the node only when the value is that node or what its own capture(...) returned; anything else selects nothing, and when it was a truthy value the "matched 0" error says that the visitor returned something that is not the node.',
    authority:
      'README.md ("Select an execution point in a test": the visitor returns the node or node.capture(...)) and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: fix F8.',
    limits: 'A file with two nodes; the visitor returns one of eight kinds of value for the first and nothing for the second.',
  },
  histories: {
    enumerated: VISITOR_RETURNS.map((returns) => ({ returns })),
    states: ['selected', 'skipped', 'mistaken-return-pointed-out'],
  },
  label: (h) => h.returns,
  model: (history) => visitorModel(history),
  driver: (history, observe) => {
    const expected = visitorModel(history)
    observe(
      'reach',
      expected.selecting === 'selected-the-node'
        ? 'selected'
        : expected.pointsOutTheReturn
          ? 'mistaken-return-pointed-out'
          : 'skipped',
    )
    try {
      fixtures += 1
      const file = `visitor-${fixtures}.ts`
      const ids = [`${file}#work:CallExpression:send:0`, `${file}#work:CallExpression:other:0`]
      registerFile(
        file,
        ids.map((id, index) => ({
          id,
          kind: 'CallExpression' as const,
          inFunction: 'work',
          callee: index === 0 ? 'send' : 'other',
          nth: 0,
        })),
      )
      let otherCapture: unknown
      const visitor = (node: { id: string; callee?: string; capture: (...keys: Array<string>) => unknown }) => {
        if (node.callee !== 'send') return undefined
        if (history.returns === 'the-node') return node
        if (history.returns === 'its-capture') return node.capture()
        if (history.returns === 'nothing') return undefined
        if (history.returns === 'false') return false
        if (history.returns === 'true') return true
        if (history.returns === 'a-copy-of-the-node') return { ...node }
        if (history.returns === 'an-object-with-its-id') return { id: node.id }
        return otherCapture
      }
      // A capture that belongs to the second node, which the visitor later returns for the first.
      select(file as never, ((node: { callee?: string; capture: () => unknown }) => {
        if (node.callee === 'other') otherCapture = node.capture()
        return node.callee === 'other' ? node : undefined
      }) as never)
      let selecting: unknown
      let pointsOutTheReturn = false
      try {
        const point = select(file as never, visitor as never) as unknown as AnyPoint
        selecting =
          point.withReplacement(() => REPLACED, () => invoke(ids[0]!, () => ORIGINAL, () => ({}))) === REPLACED
            ? 'selected-the-node'
            : 'selected-something-else'
      } catch (error) {
        const message = (error as Error).message
        selecting = /matched 0\./.test(message) ? 'matched-none' : whose(error)
        pointsOutTheReturn = message.includes('returned something that is not the node')
      }
      observe('visitor', { selecting, pointsOutTheReturn })
    } catch (err) {
      observe('visitor', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('visitor', 'visitor-return', observations.find((o) => o.checkpoint === 'visitor')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'an-object-with-the-id-selects-the-node',
      law: 'visitor-return',
      history: { enumerated: 'an-object-with-its-id' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'visitor' ? { ...o, value: { selecting: 'selected-the-node', pointsOutTheReturn: false } } : o,
        ),
    },
  ],
})
