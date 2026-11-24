/**
 * This oracle owns the promise that every copy of the runtime module loaded in
 * one worker is the same runtime: a file registered through one copy can be
 * selected through another, and a replacement installed through one applies
 * to instrumented code that calls a third. It is checked on what `select`,
 * `withReplacement`, and `invoke` of different copies return. It owns
 * `src/runtime.mjs`.
 *
 * ```ts
 * copyA.registerFile('app.ts', nodes)
 * copyB.select('app.ts', (n) => n.callee === 'send' && n) // → the point registered through copyA
 * point.withReplacement(() => 7, () => copyC.invoke(id, () => 1, () => ({}))) // → 7
 * copyC.invoke(id, () => 1, () => ({})) // → 1 outside the scope
 * ```
 *
 * Why would a test's replacement do nothing when the test file and the
 * application both import the runtime? Vite can load a module through more than
 * one module graph, for instance when a dependency is inlined for one importer
 * and externalized for another, and each graph evaluates its own copy. A
 * replacement map that lived in one copy's module scope would be invisible to
 * the instrumented code that imported the other.
 *
 * One part makes the copies one runtime: the **shared registry**, a single
 * object per worker that holds the async-local replacement store, the file
 * index, and each file's flags, and that every copy finds again when it loads.
 *
 * For every assignment of the three roles (registering, selecting, and
 * invoking) to copies of the runtime loaded in one worker, a file registered
 * through the first is found by the second, its flags are the same object in
 * every copy, and a replacement installed through the second applies to an
 * `invoke` of the third inside the scope and not outside it (`src/runtime.mjs`,
 * "All copies in the same Node worker must share the same async-local store
 * and file index"; Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24: accept all laws).
 *
 * The model needs no state: sharing means every role assignment behaves as if
 * there were one copy. The histories enumerate every assignment of three roles
 * to three copies. The driver loads each copy inside the history, so a runtime
 * that fails to load is an observation and not a broken test file.
 *
 * Copies are distinguished by a query string on the module specifier, which is
 * how one worker comes to hold two instances of a module under Vite.
 */
import { differs, oracleProperty, pass } from '@tanstack/oracles'

const COPIES = [0, 1, 2] as const

type Runtime = typeof import('../src/runtime.mjs')
// Each specifier is its own module to Vite, so each evaluates the runtime's source again.
const loaders: ReadonlyArray<() => Promise<Runtime>> = [
  () => import('../src/runtime.mjs?copy=0') as Promise<Runtime>,
  () => import('../src/runtime.mjs?copy=1') as Promise<Runtime>,
  () => import('../src/runtime.mjs?copy=2') as Promise<Runtime>,
]

interface CopiesHistory {
  registers: number
  selects: number
  invokes: number
}

const enumeratedCopiesHistories: ReadonlyArray<CopiesHistory> = COPIES.flatMap((registers) =>
  COPIES.flatMap((selects) => COPIES.map((invokes) => ({ registers, selects, invokes }))),
)

const ORIGINAL = 1
const REPLACED = 7

// Every assignment of roles behaves like a single copy.
function copiesModel(_history: CopiesHistory) {
  return { flagsAreShared: true, flagBefore: false, insideScope: REPLACED, outsideScope: ORIGINAL, flagAfter: true }
}

let copiesRuns = 0

oracleProperty({
  id: 'runtime-copies-share-one-registry',
  owns: ['src/runtime.mjs'],
  law: {
    statement:
      'For every assignment of the three roles (registering, selecting, and invoking) to copies of the runtime loaded in one worker, a file registered through the first is found by the second, its flags are the same object in every copy, and a replacement installed through the second applies to an invoke of the third inside the scope and not outside it.',
    authority:
      'src/runtime.mjs ("Vite can load this module through more than one module graph. All copies in the same Node worker must share the same async-local store and file index.") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: accept all laws.',
    limits: 'Three copies in one worker, distinguished by a query string on the module specifier.',
  },
  histories: {
    enumerated: enumeratedCopiesHistories,
    states: ['one-copy-plays-every-role', 'every-role-in-its-own-copy'],
  },
  label: (h) => `register:${h.registers} select:${h.selects} invoke:${h.invokes}`,
  model: (history) => copiesModel(history),
  driver: async (history, observe) => {
    const roles = new Set([history.registers, history.selects, history.invokes])
    if (roles.size === 1) observe('reach', 'one-copy-plays-every-role')
    if (roles.size === 3) observe('reach', 'every-role-in-its-own-copy')
    try {
      const load = (copy: number) => loaders[copy]!()
      const [registering, selecting, invoking] = await Promise.all([
        load(history.registers),
        load(history.selects),
        load(history.invokes),
      ])
      copiesRuns += 1
      const file = `copies-${copiesRuns}.ts`
      const id = `${file}#n0`
      const nodes = [{ id, kind: 'CallExpression' as const, inFunction: 'work', callee: 'send', nth: 0 }]
      const flags = registering.registerFile(file, nodes, [1])
      const others = await Promise.all(COPIES.map(load))
      const flagsAreShared = others.every((runtime) => runtime.registerFile(file, nodes, [1]) === flags)
      const flagBefore = flags[1]!.on
      const point = selecting.select(file as never, ((n: { callee?: string }) =>
        n.callee === 'send' ? n : undefined) as never) as unknown as {
        withReplacement: <T>(handler: () => number, action: () => T) => T
      }
      const call = () => invoking.invoke(id, () => ORIGINAL, () => ({}))
      const insideScope = point.withReplacement(() => REPLACED, call)
      observe('copies', {
        flagsAreShared,
        flagBefore,
        insideScope,
        outsideScope: call(),
        flagAfter: flags[1]!.on,
      })
    } catch (err) {
      observe('copies', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs(
      'copies',
      'copies-share-one-registry',
      observations.find((o) => o.checkpoint === 'copies')?.value,
      expected,
    ) ?? pass,
  calibrations: [
    {
      name: 'replacement-stays-in-the-copy-that-installed-it',
      law: 'copies-share-one-registry',
      history: { enumerated: 'register:0 select:1 invoke:2' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'copies' ? { ...o, value: { ...(o.value as object), insideScope: ORIGINAL } } : o,
        ),
    },
  ],
})
