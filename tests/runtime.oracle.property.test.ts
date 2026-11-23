/**
 * This oracle owns `execution-points-prototype`'s runtime selection, local
 * capture, and async-context replacement scoping, checked at the return values
 * of `select`, `withReplacement`, and `invoke`, and at the `locals` and
 * `original` arguments passed to replacement handlers. It owns
 * `src/runtime.mjs`.
 *
 * ```ts
 * invoke('n0', () => 10, () => ({ a: () => 1 })) // → 10, without calling captureThunk, when no replacement for 'n0' is active
 * point.withReplacement(({ original }) => original() + 5, () => invoke('n0', () => 10, () => ({}))) // → 15 inside action and its async descendants
 * point.capture('a').withReplacement(({ locals }) => locals.a, () => invoke('n0', () => 10, () => ({ a: () => 7, b: () => 9 }))) // → 7 on a frozen null-prototype locals object, without reading 'b'
 * select('app.ts', (n) => (n.callee === 'send' ? n : undefined)) // → Point for the single matching node; throws when 0 or 2+ nodes match
 * ```
 *
 * Why does a background task started inside `point.withReplacement(handler, action)`
 * that calls `invoke()` two microtask turns after `action` returns still need
 * `handler`, and what happens when `select(file, n => n.capture('a')).capture()`
 * narrows the capture list to zero keys?
 *
 * Three parts drive the runtime: the **file index** (`registerFile` and
 * `select` resolving a visitor against a file's node descriptors), the
 * **replacement map** (each `withReplacement` scope copying the parent async
 * context's active bindings for a node id, restoring the parent scope on exit
 * or throw while async descendants retain the map in which they were created),
 * and the **capture snapshot** (reading only the active capture keys from
 * `captureThunk` onto a shallowly frozen, null-prototype `locals` object
 * inside a frozen `context` when `invoke` intercepts a replaced node).
 *
 * For every registered execution point `p` and every
 * `invoke(p.id, originalThunk, captureThunk)` call where no enclosing
 * synchronous or asynchronous `p.withReplacement(handler, action)` scope is
 * active in the current async context, `invoke` evaluates `originalThunk()`
 * once, returns its result, and does not call `captureThunk` ("No replacement
 * is active | Evaluate the original expression normally. Do not read
 * captures.", `README.md:78`).
 *
 * For every `p.withReplacement(handler, action)` call, `withReplacement`
 * returns `action()`'s return value (or rethrows its error without swallowing
 * unhandled promise rejections), and every `invoke(p.id, originalThunk, captureThunk)`
 * within `action` or any asynchronous descendant started in `action`'s async
 * context calls the innermost active `handler({ locals, original })` for
 * `p.id`, where each call to `original()` evaluates `originalThunk()` once
 * (`README.md:79-81`, `README.md:104-107`, `README.md:113`). When a ref-counted
 * counter gates `AsyncLocalStorage` and decrements as soon as `action` settles,
 * any async descendant that outlives `action` silently bypasses its replacement.
 *
 * For every intercepted execution of a point `p` whose latest `.capture(...keys)`
 * call specifies `keys`, `invoke` calls `captureThunk()` once, evaluates only
 * the getter for each key in `keys` (supporting both function getters and
 * direct values, including keys such as `__proto__` and `toString`), and passes
 * a frozen `context` whose `locals` is a shallowly frozen, null-prototype
 * object mapping `keys` to their captured values (`README.md:85`,
 * `README.md:174`, `src/runtime.d.ts:32-37`).
 *
 * For every file registration and `select(file, visitor)` call, `select`
 * resolves to the single node for which `visitor(node)` returns `node` or
 * `node.capture(...)`, throws a `TypeError` when `visitor`, `handler`, or
 * `action` is not a function, and throws an `Error` when `file` is unregistered
 * or `visitor` matches 0 or 2 or more nodes (`README.md:49`; Decision by
 * Manuel Schiller (GitHub schiller-manuel), 2026-11-22: `select` is the sole
 * selection API).
 *
 * The model predicts each observation directly from the history: whether a
 * node id is bound in the active scope or async descendant, which handler and
 * `original()` call count apply, which capture keys the latest `.capture(...)`
 * call selected, and how many descriptors in the file index match the visitor.
 * The histories vary nesting depth, sibling points, thrown handlers and
 * actions, microtask schedules where async descendants finish before or after
 * `action`, chained `.capture()` overrides, prototype-shadowing local names,
 * and visitor match counts. The driver calls `registerFile`, `select`, and
 * `invoke` and records return values, call counts, object freeze/prototype
 * invariants, and thrown errors.
 *
 * Target modules must be registered via `registerFile` before `withReplacement`
 * begins, and node IDs for a registered file path stay fixed within a single
 * history.
 */
import fc from 'fast-check'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { invoke, registerFile, select } from '../src/runtime.mjs'

// ---------------------------------------------------------------------------
// Law 1: Passthrough when no replacement for the target node is active
// ---------------------------------------------------------------------------

interface PassthroughHistory {
  mode: 'none' | 'sibling-active' | 'after-exit' | 'after-throw'
  originalValue: number
  replacementValue: number
}

const passthroughArbitrary: fc.Arbitrary<PassthroughHistory> = fc.record({
  mode: fc.constantFrom('none', 'sibling-active', 'after-exit', 'after-throw'),
  originalValue: fc.integer({ min: -50, max: 50 }),
  replacementValue: fc.integer({ min: 100, max: 200 }),
})

// Pure model for Law 1: outside an active replacement for the target node,
// originalThunk runs once and captureThunk never runs.
function passthroughModel(history: PassthroughHistory) {
  return {
    result: history.originalValue,
    originalCalls: 1,
    captureThunkCalls: 0,
  }
}

oracleProperty({
  id: 'runtime-passthrough',
  owns: ['src/runtime.mjs#invoke', 'src/runtime.mjs#withReplacement'],
  law: {
    statement:
      'For every registered execution point p and every invoke(p.id, originalThunk, captureThunk) call where no enclosing synchronous or asynchronous p.withReplacement(handler, action) scope is active, invoke evaluates originalThunk() once, returns its result, and does not call captureThunk.',
    authority:
      'README.md:78 ("No replacement is active | Evaluate the original expression normally. Do not read captures.") and README.md:107 ("Returning or throwing restores the surrounding synchronous context").',
    limits:
      'Target modules must be registered before withReplacement runs; active replacement behavior is covered by runtime-replacement-scope.',
  },
  histories: {
    arbitrary: passthroughArbitrary,
    runs: 60,
    fixedSeeds: [42],
    states: ['no-active-scope', 'sibling-point-active', 'after-scope-exit', 'after-scope-throw'],
    constructed: [
      {
        name: 'idle-invoke',
        enters: ['no-active-scope'],
        build: (base) => ({ ...base, mode: 'none' }),
      },
      {
        name: 'sibling-point-only',
        enters: ['sibling-point-active'],
        build: (base) => ({ ...base, mode: 'sibling-active' }),
      },
      {
        name: 'after-normal-exit',
        enters: ['after-scope-exit'],
        build: (base) => ({ ...base, mode: 'after-exit' }),
      },
      {
        name: 'after-thrown-exit',
        enters: ['after-scope-throw'],
        build: (base) => ({ ...base, mode: 'after-throw' }),
      },
    ],
  },
  model: (history) => passthroughModel(history),
  driver: (history, observe) => {
    try {
      const file = 'oracle-passthrough.ts'
      registerFile(file, [
        { id: 'pt-target', kind: 'CallExpression', inFunction: 'fn', callee: 'target', nth: 0 },
        { id: 'pt-sibling', kind: 'CallExpression', inFunction: 'fn', callee: 'sibling', nth: 0 },
      ])
      const targetPoint = select(file, (n) => (n.callee === 'target' ? n.capture('x') : undefined))
      const siblingPoint = select(file, (n) => (n.callee === 'sibling' ? n.capture('x') : undefined))

      let originalCalls = 0
      let captureThunkCalls = 0
      const callTarget = () =>
        invoke(
          'pt-target',
          () => {
            originalCalls += 1
            return history.originalValue
          },
          () => {
            captureThunkCalls += 1
            return { x: () => 1 }
          },
        )

      let result: number
      if (history.mode === 'none') {
        observe('reach', 'no-active-scope')
        result = callTarget()
      } else if (history.mode === 'sibling-active') {
        observe('reach', 'sibling-point-active')
        result = siblingPoint.withReplacement(
          () => history.replacementValue,
          () => callTarget(),
        )
      } else if (history.mode === 'after-exit') {
        observe('reach', 'after-scope-exit')
        targetPoint.withReplacement(
          () => history.replacementValue,
          () => history.replacementValue,
        )
        result = callTarget()
      } else {
        observe('reach', 'after-scope-throw')
        try {
          targetPoint.withReplacement(
            () => history.replacementValue,
            () => {
              throw new Error('abort-scope')
            },
          )
        } catch {
          // Expected scope exit via throw.
        }
        result = callTarget()
      }

      observe('passthrough', { result, originalCalls, captureThunkCalls })
    } catch (err) {
      observe('passthrough', {
        threw: err instanceof Error ? err.message : String(err),
      })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'passthrough')
    if (!entry) return differs('passthrough', 'passthrough', undefined, expected) ?? pass
    return differs('passthrough', 'passthrough', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-passthrough-result',
      law: 'passthrough',
      history: { constructed: 'idle-invoke' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'passthrough'
            ? { ...o, value: { ...(o.value as object), result: 9999 } }
            : o,
        ),
    },
    {
      name: 'eager-capture-thunk-on-passthrough',
      law: 'passthrough',
      history: { constructed: 'sibling-point-only' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'passthrough'
            ? { ...o, value: { ...(o.value as object), captureThunkCalls: 1 } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law 2: Scoped replacement, nesting, original() evaluation, and async context
// ---------------------------------------------------------------------------

interface ScopeHistory {
  scenario:
    | 'single'
    | 'nested-override'
    | 'nested-cross-point'
    | 'handler-throws'
    | 'async-descendant'
  originalValue: number
  outerAdd: number
  innerAdd: number
  originalCallsInHandler: number
  actionTicks: number
  childTicks: number
}

const scopeArbitrary: fc.Arbitrary<ScopeHistory> = fc.record({
  scenario: fc.constantFrom(
    'single',
    'nested-override',
    'nested-cross-point',
    'handler-throws',
    'async-descendant',
  ),
  originalValue: fc.integer({ min: 1, max: 30 }),
  outerAdd: fc.integer({ min: 1, max: 20 }),
  innerAdd: fc.integer({ min: 21, max: 50 }),
  originalCallsInHandler: fc.integer({ min: 0, max: 3 }),
  actionTicks: fc.integer({ min: 0, max: 3 }),
  childTicks: fc.integer({ min: 0, max: 4 }),
})

// Pure model for Law 2: computes the expected expression values and how many
// times originalThunk is evaluated from the active handler and its original() count.
function scopeModel(history: ScopeHistory) {
  const evalWithAdd = (add: number) =>
    history.originalCallsInHandler * history.originalValue + add

  if (history.scenario === 'single') {
    return {
      kind: 'values',
      values: [evalWithAdd(history.outerAdd)],
      totalOriginalCalls: history.originalCallsInHandler,
    }
  }
  if (history.scenario === 'nested-override') {
    return {
      kind: 'values',
      values: [
        evalWithAdd(history.outerAdd),
        evalWithAdd(history.innerAdd),
        evalWithAdd(history.outerAdd),
      ],
      totalOriginalCalls: history.originalCallsInHandler * 3,
    }
  }
  if (history.scenario === 'nested-cross-point') {
    return {
      kind: 'values',
      values: [
        evalWithAdd(history.outerAdd),
        evalWithAdd(history.innerAdd),
      ],
      totalOriginalCalls: history.originalCallsInHandler * 2,
    }
  }
  if (history.scenario === 'handler-throws') {
    return {
      kind: 'threw',
      message: 'handler-boom',
      afterThrowRestored: history.originalValue,
      totalOriginalCalls: 1,
    }
  }
  // async-descendant: whether childTicks <= actionTicks or childTicks > actionTicks,
  // the descendant was created in the replacement's async context and must see the outer handler.
  return {
    kind: 'values',
    values: [evalWithAdd(history.outerAdd)],
    totalOriginalCalls: history.originalCallsInHandler,
  }
}

oracleProperty({
  id: 'runtime-replacement-scope',
  owns: ['src/runtime.mjs#withReplacement', 'src/runtime.mjs#invoke'],
  law: {
    statement:
      'For every p.withReplacement(handler, action) call, withReplacement returns action()\'s result and every invoke(p.id, originalThunk, captureThunk) in action or in any asynchronous descendant created within action\'s async context calls the innermost active handler({ locals, original }), where each original() call evaluates originalThunk() once.',
    authority:
      'README.md:79-81 ("Replacement returns a value | Use that value as the expression result. Replacement throws | Throw at the selected expression. Replacement calls original() | Evaluate the original expression") and README.md:104-107 ("async descendants retain the context in which they were created").',
    limits:
      'original() evaluates originalThunk on every call without memoization (README.md:113); async descendants are tested across microtask (Promise.resolve) and macrotask (setImmediate) continuations.',
  },
  histories: {
    arbitrary: scopeArbitrary,
    runs: 60,
    fixedSeeds: [42],
    states: [
      'single-replacement',
      'nested-override-and-restore',
      'nested-cross-point-preserved',
      'handler-throws-and-restores',
      'async-descendant-outlives-action',
      'repeated-original-calls',
    ],
    constructed: [
      {
        name: 'single-scope',
        enters: ['single-replacement'],
        build: (base) => ({ ...base, scenario: 'single', originalCallsInHandler: 0 }),
      },
      {
        name: 'nested-scope-restore',
        enters: ['nested-override-and-restore'],
        build: (base) => ({ ...base, scenario: 'nested-override', originalCallsInHandler: 1 }),
      },
      {
        name: 'nested-cross-point-scope',
        enters: ['nested-cross-point-preserved'],
        build: (base) => ({ ...base, scenario: 'nested-cross-point', originalCallsInHandler: 1 }),
      },
      {
        name: 'handler-throw-cleanup',
        enters: ['handler-throws-and-restores'],
        build: (base) => ({ ...base, scenario: 'handler-throws' }),
      },
      {
        name: 'descendant-outlives-action',
        enters: ['async-descendant-outlives-action'],
        build: (base) => ({
          ...base,
          scenario: 'async-descendant',
          actionTicks: 0,
          childTicks: 2,
          originalCallsInHandler: 1,
        }),
      },
      {
        name: 'multiple-original-calls',
        enters: ['repeated-original-calls'],
        build: (base) => ({ ...base, scenario: 'single', originalCallsInHandler: 2 }),
      },
    ],
  },
  model: (history) => scopeModel(history),
  driver: async (history, observe) => {
    try {
      const file = 'oracle-scope.ts'
      registerFile(file, [
        { id: 'sc-node', kind: 'CallExpression', inFunction: 'work', callee: 'compute', nth: 0 },
        { id: 'sc-other', kind: 'CallExpression', inFunction: 'work', callee: 'other', nth: 0 },
      ])
      const point = select(file, (n) => (n.id === 'sc-node' ? n : undefined))
      const otherPoint = select(file, (n) => (n.id === 'sc-other' ? n : undefined))

      let totalOriginalCalls = 0
      const runInvoke = (id = 'sc-node') =>
        invoke(
          id,
          () => {
            totalOriginalCalls += 1
            return history.originalValue
          },
          () => ({}),
        )

      const makeHandler = (add: number) => ({ original }: { original: () => number }) => {
        let sum = 0
        for (let i = 0; i < history.originalCallsInHandler; i += 1) {
          sum += original()
        }
        return sum + add
      }

      if (history.originalCallsInHandler >= 2 && history.scenario !== 'handler-throws') {
        observe('reach', 'repeated-original-calls')
      }

      if (history.scenario === 'single') {
        observe('reach', 'single-replacement')
        const val = point.withReplacement(makeHandler(history.outerAdd), () => runInvoke())
        observe('scope-outcome', {
          kind: 'values',
          values: [val],
          totalOriginalCalls,
        })
        return
      }

      if (history.scenario === 'nested-override') {
        observe('reach', 'nested-override-and-restore')
        const values = point.withReplacement(makeHandler(history.outerAdd), () => [
          runInvoke(),
          point.withReplacement(makeHandler(history.innerAdd), () => runInvoke()),
          runInvoke(),
        ])
        observe('scope-outcome', {
          kind: 'values',
          values,
          totalOriginalCalls,
        })
        return
      }

      if (history.scenario === 'nested-cross-point') {
        observe('reach', 'nested-cross-point-preserved')
        const values = point.withReplacement(makeHandler(history.outerAdd), () =>
          otherPoint.withReplacement(makeHandler(history.innerAdd), () => [
            runInvoke('sc-node'),
            runInvoke('sc-other'),
          ]),
        )
        observe('scope-outcome', {
          kind: 'values',
          values,
          totalOriginalCalls,
        })
        return
      }

      if (history.scenario === 'handler-throws') {
        observe('reach', 'handler-throws-and-restores')
        let message = ''
        try {
          point.withReplacement(
            () => {
              throw new Error('handler-boom')
            },
            () => runInvoke(),
          )
        } catch (err) {
          message = err instanceof Error ? err.message : String(err)
        }
        const afterThrowRestored = runInvoke()
        observe('scope-outcome', {
          kind: 'threw',
          message,
          afterThrowRestored,
          totalOriginalCalls,
        })
        return
      }

      // async-descendant
      if (history.childTicks > history.actionTicks) {
        observe('reach', 'async-descendant-outlives-action')
      }
      const waitTicks = async (ticks: number) => {
        for (let i = 0; i < ticks; i += 1) {
          if (i % 2 === 1) {
            await new Promise<void>((resolve) => setImmediate(resolve))
          } else {
            await Promise.resolve()
          }
        }
      }
      let descendantPromise!: Promise<number>
      await point.withReplacement(makeHandler(history.outerAdd), async () => {
        descendantPromise = (async () => {
          await waitTicks(history.childTicks)
          return runInvoke()
        })()
        await waitTicks(history.actionTicks)
      })
      const descendantVal = await descendantPromise
      observe('scope-outcome', {
        kind: 'values',
        values: [descendantVal],
        totalOriginalCalls,
      })
    } catch (err) {
      observe('scope-outcome', {
        kind: 'unexpected-crash',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'scope-outcome')
    if (!entry) return differs('scope-outcome', 'replacement-scope', undefined, expected) ?? pass
    return differs('scope-outcome', 'replacement-scope', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'outer-not-restored-after-nested',
      law: 'replacement-scope',
      history: { constructed: 'nested-scope-restore' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'scope-outcome'
            ? { ...o, value: { ...(o.value as object), values: [0, 0, 999] } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law 3: Explicit local capture snapshot, lazy thunks, and frozen null-proto locals
// ---------------------------------------------------------------------------

const ALL_LOCAL_KEYS = ['a', 'b', 'c', '__proto__', 'toString'] as const
type LocalKey = (typeof ALL_LOCAL_KEYS)[number]

interface CaptureHistory {
  initialMask: [boolean, boolean, boolean, boolean, boolean]
  hasOverride: boolean
  overrideMask: [boolean, boolean, boolean, boolean, boolean]
  directValueForA: boolean
  values: [number, number, number, number, number]
}

const captureArbitrary: fc.Arbitrary<CaptureHistory> = fc.record({
  initialMask: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
  hasOverride: fc.boolean(),
  overrideMask: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
  directValueForA: fc.boolean(),
  values: fc.tuple(
    fc.integer({ min: -20, max: 20 }),
    fc.integer({ min: -20, max: 20 }),
    fc.integer({ min: -20, max: 20 }),
    fc.integer({ min: -20, max: 20 }),
    fc.integer({ min: -20, max: 20 }),
  ),
})

function maskToKeys(mask: readonly boolean[]): Array<LocalKey> {
  return ALL_LOCAL_KEYS.filter((_, idx) => mask[idx])
}

function captureModel(history: CaptureHistory) {
  const activeKeys = history.hasOverride
    ? maskToKeys(history.overrideMask)
    : maskToKeys(history.initialMask)

  const entries = activeKeys.map((key) => {
    const idx = ALL_LOCAL_KEYS.indexOf(key)
    return [key, history.values[idx]!] as const
  })
  const expectedGetters = activeKeys.filter((k) => !(k === 'a' && history.directValueForA))

  return {
    entries,
    evaluatedGetters: expectedGetters,
    captureThunkCalls: 1,
    nullProto: true,
    localsFrozen: true,
    contextFrozen: true,
    pointFrozen: true,
  }
}

oracleProperty({
  id: 'runtime-capture-snapshot',
  owns: ['src/runtime.mjs#select', 'src/runtime.mjs#invoke', 'src/runtime.mjs#createPointHandle'],
  law: {
    statement:
      'For every intercepted execution of a point p whose latest .capture(...keys) call specifies keys, invoke calls captureThunk() once, evaluates only the getter for each key in keys, and passes a frozen context whose locals is a shallowly frozen, null-prototype object mapping keys to their captured values.',
    authority:
      'README.md:85 ("Captures are read once for each intercepted execution. The locals container is shallowly frozen"), README.md:174 ("the locals container is shallowly frozen with a null prototype"), and src/runtime.d.ts:32-37.',
    limits:
      'Captured object references retain their normal mutability by design (README.md:93).',
  },
  histories: {
    arbitrary: captureArbitrary,
    runs: 60,
    fixedSeeds: [42],
    states: [
      'visitor-capture-subset',
      'chained-capture-override-nonempty',
      'chained-capture-reset-to-empty',
      'prototype-shadowing-keys',
      'non-function-capture-entry',
    ],
    constructed: [
      {
        name: 'visitor-subset-only',
        enters: ['visitor-capture-subset'],
        build: (base) => ({
          ...base,
          initialMask: [true, false, true, false, false],
          hasOverride: false,
        }),
      },
      {
        name: 'override-to-nonempty',
        enters: ['chained-capture-override-nonempty'],
        build: (base) => ({
          ...base,
          initialMask: [true, true, false, false, false],
          hasOverride: true,
          overrideMask: [false, true, true, false, false],
        }),
      },
      {
        name: 'override-to-empty',
        enters: ['chained-capture-reset-to-empty'],
        build: (base) => ({
          ...base,
          initialMask: [true, true, false, false, false],
          hasOverride: true,
          overrideMask: [false, false, false, false, false],
        }),
      },
      {
        name: 'proto-and-tostring-keys',
        enters: ['prototype-shadowing-keys'],
        build: (base) => ({
          ...base,
          initialMask: [false, false, false, true, true],
          hasOverride: false,
        }),
      },
      {
        name: 'direct-value-capture',
        enters: ['non-function-capture-entry'],
        build: (base) => ({
          ...base,
          initialMask: [true, true, false, false, false],
          hasOverride: false,
          directValueForA: true,
        }),
      },
    ],
  },
  model: (history) => captureModel(history),
  driver: (history, observe) => {
    try {
      const file = 'oracle-capture.ts'
      registerFile(file, [
        { id: 'cap-node', kind: 'CallExpression', inFunction: 'fn', callee: 'send', nth: 0 },
      ])
      const initialKeys = maskToKeys(history.initialMask)
      const overrideKeys = maskToKeys(history.overrideMask)

      const basePoint = select(file, (n) => n.capture(...initialKeys))
      const activePoint = history.hasOverride ? basePoint.capture(...overrideKeys) : basePoint

      if (!history.hasOverride && initialKeys.length > 0) {
        observe('reach', 'visitor-capture-subset')
      }
      if (history.hasOverride && overrideKeys.length > 0) {
        observe('reach', 'chained-capture-override-nonempty')
      }
      if (history.hasOverride && initialKeys.length > 0 && overrideKeys.length === 0) {
        observe('reach', 'chained-capture-reset-to-empty')
      }
      const effectiveKeys = history.hasOverride ? overrideKeys : initialKeys
      if (effectiveKeys.includes('__proto__') || effectiveKeys.includes('toString')) {
        observe('reach', 'prototype-shadowing-keys')
      }
      if (history.directValueForA && effectiveKeys.includes('a')) {
        observe('reach', 'non-function-capture-entry')
      }

      let captureThunkCalls = 0
      const evaluatedGetters: Array<string> = []

      activePoint.withReplacement(
        (ctx) => {
          const entries = Object.keys(ctx.locals).map((k) => [
            k,
            (ctx.locals as Record<string, number>)[k]!,
          ])
          observe('capture', {
            entries,
            evaluatedGetters: [...evaluatedGetters],
            captureThunkCalls,
            nullProto: Object.getPrototypeOf(ctx.locals) === null,
            localsFrozen: Object.isFrozen(ctx.locals),
            contextFrozen: Object.isFrozen(ctx),
            pointFrozen: Object.isFrozen(activePoint),
          })
          return 0
        },
        () =>
          invoke(
            'cap-node',
            () => 0,
            () => {
              captureThunkCalls += 1
              const map: Record<string, unknown> = Object.create(null)
              ALL_LOCAL_KEYS.forEach((key, idx) => {
                if (key === 'a' && history.directValueForA) {
                  map[key] = history.values[idx]!
                } else {
                  map[key] = () => {
                    evaluatedGetters.push(key)
                    return history.values[idx]!
                  }
                }
              })
              return map as Record<string, () => unknown>
            },
          ),
      )
    } catch (err) {
      observe('capture', {
        threw: err instanceof Error ? err.message : String(err),
      })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'capture')
    if (!entry) return differs('capture', 'capture-snapshot', undefined, expected) ?? pass
    return differs('capture', 'capture-snapshot', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-captured-entries',
      law: 'capture-snapshot',
      history: { constructed: 'visitor-subset-only' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'capture'
            ? { ...o, value: { ...(o.value as object), entries: [['bogus', 999]] } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law 4: Visitor selection validation, registration timing, and error contracts
// ---------------------------------------------------------------------------

interface SelectionHistory {
  kind:
    | 'match-one-node'
    | 'match-one-captured'
    | 'match-zero'
    | 'match-multiple'
    | 'register-after-select'
    | 'unregistered-file'
    | 'invalid-visitor-arg'
    | 'invalid-with-replacement-args'
    | 'ignore-non-node-return'
  targetIndex: number
}

const selectionArbitrary: fc.Arbitrary<SelectionHistory> = fc.record({
  kind: fc.constantFrom(
    'match-one-node',
    'match-one-captured',
    'match-zero',
    'match-multiple',
    'register-after-select',
    'unregistered-file',
    'invalid-visitor-arg',
    'invalid-with-replacement-args',
    'ignore-non-node-return',
  ),
  targetIndex: fc.integer({ min: 0, max: 2 }),
})

function selectionModel(history: SelectionHistory) {
  switch (history.kind) {
    case 'match-one-node':
    case 'match-one-captured':
    case 'register-after-select':
    case 'ignore-non-node-return':
      return {
        outcome: 'selected',
        interceptedNodeIndex: history.targetIndex,
        visitorNodeFrozen: true,
        visitorCallsPerNode: 1,
        sharedRegistryHasFile: true,
      }
    case 'match-zero':
      return {
        outcome: 'error',
        phase: 'select',
        errorName: 'Error',
        matchedCount: 0,
      }
    case 'match-multiple':
      return {
        outcome: 'error',
        phase: 'select',
        errorName: 'Error',
        matchedCount: 2,
      }
    case 'unregistered-file':
      return {
        outcome: 'error',
        phase: 'withReplacement',
        errorName: 'Error',
        unregistered: true,
      }
    case 'invalid-visitor-arg':
      return {
        outcome: 'error',
        phase: 'select',
        errorName: 'TypeError',
      }
    case 'invalid-with-replacement-args':
      return {
        outcome: 'error',
        phase: 'withReplacement',
        errorName: 'TypeError',
      }
  }
}

oracleProperty({
  id: 'runtime-visitor-selection',
  owns: [
    'src/runtime.mjs#registerFile',
    'src/runtime.mjs#select',
    'src/runtime.mjs#makeVisitorNode',
    'src/runtime.mjs#getFileNodes',
  ],
  law: {
    statement:
      'For every file registration and select(file, visitor) call, select resolves to the single node for which visitor(node) returns node or node.capture(...), throws a TypeError when visitor, handler, or action is not a function, and throws an Error when file is unregistered or visitor matches 0 or 2 or more nodes.',
    authority:
      'README.md:49 ("Returning 0 nodes or 2+ nodes (ambiguous match) is rejected") and src/runtime.mjs:24-30, 41-44, 88-114.',
    limits:
      'File registration must happen before withReplacement is called.',
  },
  histories: {
    arbitrary: selectionArbitrary,
    runs: 50,
    fixedSeeds: [42],
    states: [
      'selected-bare-node',
      'selected-captured-node',
      'selected-deferred-registration',
      'rejected-zero-matches',
      'rejected-multiple-matches',
      'rejected-unregistered-file',
      'rejected-invalid-callback',
      'rejected-invalid-with-replacement-args',
    ],
    constructed: [
      {
        name: 'bare-node-return',
        enters: ['selected-bare-node'],
        build: (base) => ({ ...base, kind: 'match-one-node' }),
      },
      {
        name: 'captured-node-return',
        enters: ['selected-captured-node'],
        build: (base) => ({ ...base, kind: 'match-one-captured' }),
      },
      {
        name: 'deferred-register-before-with-replacement',
        enters: ['selected-deferred-registration'],
        build: (base) => ({ ...base, kind: 'register-after-select' }),
      },
      {
        name: 'zero-match-visitor',
        enters: ['rejected-zero-matches'],
        build: (base) => ({ ...base, kind: 'match-zero' }),
      },
      {
        name: 'two-match-visitor',
        enters: ['rejected-multiple-matches'],
        build: (base) => ({ ...base, kind: 'match-multiple' }),
      },
      {
        name: 'missing-file-registration',
        enters: ['rejected-unregistered-file'],
        build: (base) => ({ ...base, kind: 'unregistered-file' }),
      },
      {
        name: 'non-function-visitor',
        enters: ['rejected-invalid-callback'],
        build: (base) => ({ ...base, kind: 'invalid-visitor-arg' }),
      },
      {
        name: 'non-function-with-replacement-handler',
        enters: ['rejected-invalid-with-replacement-args'],
        build: (base) => ({ ...base, kind: 'invalid-with-replacement-args' }),
      },
    ],
  },
  model: (history) => selectionModel(history),
  driver: (history, observe) => {
    const nodes = [
      { id: 'sel-0', kind: 'CallExpression' as const, inFunction: 'fn', callee: 'c0', nth: 0 },
      { id: 'sel-1', kind: 'CallExpression' as const, inFunction: 'fn', callee: 'c1', nth: 0 },
      { id: 'sel-2', kind: 'CallExpression' as const, inFunction: 'fn', callee: 'c2', nth: 0 },
    ]

    if (history.kind === 'invalid-visitor-arg') {
      observe('reach', 'rejected-invalid-callback')
      try {
        ;(select as unknown as (f: string, v: unknown) => unknown)('any.ts', null)
        observe('selection', { outcome: 'unexpected-pass' })
      } catch (err) {
        observe('selection', {
          outcome: 'error',
          phase: 'select',
          errorName: err instanceof Error ? err.name : 'unknown',
        })
      }
      return
    }

    if (history.kind === 'invalid-with-replacement-args') {
      observe('reach', 'rejected-invalid-with-replacement-args')
      const file = 'oracle-sel-invalid-args.ts'
      try {
        registerFile(file, nodes)
        const pt = select(file, (n) => (n.id === 'sel-0' ? n : undefined))
        ;(pt.withReplacement as unknown as (h: unknown, a: unknown) => unknown)('not-fn', () => 1)
        observe('selection', { outcome: 'unexpected-pass' })
      } catch (err) {
        observe('selection', {
          outcome: 'error',
          phase: 'withReplacement',
          errorName: err instanceof Error ? err.name : 'unknown',
        })
      }
      return
    }

    if (history.kind === 'unregistered-file') {
      observe('reach', 'rejected-unregistered-file')
      const pt = select('never-registered-oracle.ts', (n) => n)
      try {
        pt.withReplacement(
          () => 1,
          () => 1,
        )
        observe('selection', { outcome: 'unexpected-pass' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        observe('selection', {
          outcome: 'error',
          phase: 'withReplacement',
          errorName: err instanceof Error ? err.name : 'unknown',
          unregistered: msg.includes('was not instrumented or has not been imported yet'),
        })
      }
      return
    }

    const file =
      history.kind === 'register-after-select'
        ? `oracle-sel-deferred-${history.targetIndex}.ts`
        : 'oracle-sel-registered.ts'

    let visitorNodeFrozen = true
    let visitorTotalCalls = 0
    let phase: 'select' | 'withReplacement' = 'select'
    try {
      if (history.kind !== 'register-after-select') {
        registerFile(file, nodes)
      }

      const pt = select(file, (node) => {
        visitorTotalCalls += 1
        if (!Object.isFrozen(node)) visitorNodeFrozen = false
        if (history.kind === 'match-zero') return undefined
        if (history.kind === 'match-multiple') {
          return node.id === 'sel-0' || node.id === 'sel-1' ? node : undefined
        }
        if (history.kind === 'ignore-non-node-return') {
          if (node.id === `sel-${history.targetIndex}`) return node
          return {} as unknown as typeof node
        }
        if (node.id === `sel-${history.targetIndex}`) {
          return history.kind === 'match-one-captured' ? node.capture('x') : node
        }
        return undefined
      })

      phase = 'withReplacement'
      if (history.kind === 'register-after-select') {
        observe('reach', 'selected-deferred-registration')
        registerFile(file, nodes)
      } else if (history.kind === 'match-one-node' || history.kind === 'ignore-non-node-return') {
        observe('reach', 'selected-bare-node')
      } else if (history.kind === 'match-one-captured') {
        observe('reach', 'selected-captured-node')
      }

      let interceptedNodeIndex = -1
      // Run withReplacement twice to verify resolveNow caches the visitor selection
      for (let run = 0; run < 2; run += 1) {
        pt.withReplacement(
          () => 99,
          () => {
            nodes.forEach((n, idx) => {
              const v = invoke(n.id, () => 0, () => ({ x: () => 1 }))
              if (v === 99) interceptedNodeIndex = idx
            })
          },
        )
      }
      const sharedRegistry = (globalThis as Record<symbol, { files?: Map<string, unknown> }>)[
        Symbol.for('execution-points-prototype.runtime.v2')
      ]
      observe('selection', {
        outcome: 'selected',
        interceptedNodeIndex,
        visitorNodeFrozen,
        visitorCallsPerNode: visitorTotalCalls / nodes.length,
        sharedRegistryHasFile: sharedRegistry?.files?.get(file) === nodes,
      })
    } catch (err) {
      if (history.kind === 'match-zero') observe('reach', 'rejected-zero-matches')
      if (history.kind === 'match-multiple') observe('reach', 'rejected-multiple-matches')
      const msg = err instanceof Error ? err.message : ''
      const countMatch = /matched (\d+)\./.exec(msg)
      observe('selection', {
        outcome: 'error',
        phase,
        errorName: err instanceof Error ? err.name : 'unknown',
        matchedCount: countMatch ? Number(countMatch[1]) : -1,
      })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'selection')
    if (!entry) return differs('selection', 'visitor-selection', undefined, expected) ?? pass
    return differs('selection', 'visitor-selection', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-selected-node-index',
      law: 'visitor-selection',
      history: { constructed: 'bare-node-return' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'selection'
            ? { ...o, value: { ...(o.value as object), interceptedNodeIndex: 99 } }
            : o,
        ),
    },
  ],
})
