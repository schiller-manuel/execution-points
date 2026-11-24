/**
 * This oracle owns the second form of `select`: a visitor object keyed by node type, whose
 * handlers work their way inward with `traverse`, as a Babel visitor does. It is checked on
 * which expression the returned point replaces, on which nodes each handler was called for,
 * and on what `select` throws. It owns `src/runtime.ts#select`.
 *
 * ```ts
 * select('src/cart.ts', {
 *   Class: (cls) => cls.name === 'Cart' && cls.traverse({
 *     Function: (fn) => fn.name === 'checkout' && fn.traverse({
 *       CallExpression: (call) => call.callee === 'get' && call.object === 'cache' && call,
 *     }),
 *   }),
 * })
 * // → the point for cache.get(...) in Cart's checkout
 * // → throws when the handlers return no expression, or more than one
 * ```
 *
 * The callback form sees every expression of a file at once and has to tell two `get` calls
 * apart by `inFunction` and `nth`. This form says where an expression stands the way the code
 * does: in this class, in this function. Does a call inside a callback count as inside the
 * method around it? If two functions on the way both lead to the same call, is that one match
 * or two?
 *
 * Three parts are checked: the **scope** a handler is called over (every node of its type in
 * the file at the top; every node of its type inside the container for `traverse`, however
 * deep), the **result** a handler passes outward (the node, `node.capture(...)`, or what
 * `traverse` returned), and the **count** (exactly one expression, counted once however many
 * ways lead to it).
 *
 * For every file registered with expressions and containers, and every visitor object,
 * `select` calls the handler under a node type's key once for each node of that type in scope:
 * the whole file for the visitor passed to `select`, everything inside the container, however
 * deep, for a visitor passed to its `traverse`. It resolves to the single expression that a
 * handler returns, directly, as `node.capture(...)`, or through any depth of `traverse`; an
 * expression reached through several containers counts once; no expression, or two or more,
 * make it throw as the callback form does; and a handler that returns a container, or anything
 * else that is not a selection, selects nothing, which the error points out (Decision by
 * Manuel Schiller (GitHub schiller-manuel), 2026-11-24: "Nested traversal, keep callback too":
 * a visitor object keyed by node type, `Function` and `Class` as Babel's alias keys,
 * `traverse(visitor)` to say "inside").
 *
 * The model walks the tree the file was registered from. It knows nothing of handlers or of
 * how results travel outward: it asks which expressions lie inside the containers a query
 * names.
 */
import { afterEach } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { invoke, registerFile, select, verifyReplacements } from '../src/runtime.ts'

// The library's own check after each test is not what this law is about, so it finds nothing.
afterEach(() => {
  try {
    verifyReplacements()
  } catch {
    // Reported by the laws that own it.
  }
})

type ContainerType = 'Function' | 'Class' | 'VariableDeclarator'
type Kind = 'CallExpression' | 'BinaryExpression' | 'ConditionalExpression'

interface Leaf {
  readonly leaf: string
  readonly kind: Kind
  readonly callee?: string
  readonly operator?: string
  readonly object?: string
}
interface Branch {
  readonly type: ContainerType
  readonly name: string
  readonly children: ReadonlyArray<Leaf | Branch>
}

const callOf = (leaf: string, callee: string, object?: string): Leaf => ({
  leaf,
  kind: 'CallExpression',
  callee,
  ...(object === undefined ? {} : { object }),
})
const branch = (type: ContainerType, name: string, ...children: Array<Leaf | Branch>): Branch => ({ type, name, children })

/** One file: two classes with a method of the same name, a callback, a constant, and code at the top. */
const TREE: ReadonlyArray<Leaf | Branch> = [
  callOf('top', 'start'),
  branch(
    'Class',
    'Cart',
    branch(
      'Function',
      'checkout',
      callOf('cart-cache', 'get', 'cache'),
      callOf('cart-db', 'get', 'db'),
      branch('VariableDeclarator', 'total', callOf('cart-total', 'fetchTotal')),
    ),
    branch('Function', 'refund', callOf('cart-refund', 'get', 'cache')),
  ),
  branch(
    'Class',
    'Order',
    branch('Function', 'checkout', callOf('order-save', 'save', 'db'), branch('Function', '', callOf('order-callback', 'get', 'cache'))),
  ),
  branch('Function', 'helper', callOf('helper-get', 'get'), { leaf: 'helper-sum', kind: 'BinaryExpression', operator: '+' }, {
    leaf: 'helper-choice',
    kind: 'ConditionalExpression',
  }),
]

/** One step inward: the containers of this type, with this name when one is given. */
interface Step {
  readonly type: ContainerType
  readonly name?: string
}
interface VisitorHistory {
  readonly name: string
  readonly states: ReadonlyArray<string>
  readonly steps: ReadonlyArray<Step>
  /** The expressions the innermost handlers ask for, one handler per kind. */
  readonly wanted: ReadonlyArray<{ readonly kind: Kind; readonly callee?: string; readonly object?: string; readonly line?: string }>
  /** What the innermost handler returns for an expression it wants. */
  readonly returns?: 'the-node' | 'a-capture' | 'true' | 'another-object'
  /** The handler of the last step returns the container itself instead of traversing into it. */
  readonly returnsTheContainer?: boolean
  /** The handler of the last step returns a capture of an expression that another handler was called for. */
  readonly returnsACaptureOfAnotherNode?: boolean
}

const VISITOR_HISTORIES: ReadonlyArray<VisitorHistory> = [
  { name: 'unique-in-the-file', states: ['selected', 'top-of-file'], steps: [], wanted: [{ kind: 'CallExpression', callee: 'start' }] },
  { name: 'many-in-the-file', states: ['too-many', 'top-of-file'], steps: [], wanted: [{ kind: 'CallExpression', callee: 'get' }] },
  { name: 'none-in-the-file', states: ['none', 'top-of-file'], steps: [], wanted: [{ kind: 'CallExpression', callee: 'missing' }] },
  {
    name: 'two-kinds-in-one-visitor',
    states: ['too-many', 'several-handlers'],
    steps: [{ type: 'Function', name: 'helper' }],
    wanted: [{ kind: 'BinaryExpression' }, { kind: 'ConditionalExpression' }],
  },
  {
    name: 'one-kind-of-two-in-a-function',
    states: ['selected', 'one-step'],
    steps: [{ type: 'Function', name: 'helper' }],
    wanted: [{ kind: 'ConditionalExpression' }],
  },
  {
    name: 'function-name-in-two-classes',
    states: ['too-many', 'one-step', 'name-used-twice'],
    steps: [{ type: 'Function', name: 'checkout' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
  },
  {
    name: 'class-then-function',
    states: ['too-many', 'two-steps'],
    steps: [{ type: 'Class', name: 'Cart' }, { type: 'Function', name: 'checkout' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
  },
  {
    name: 'class-then-function-then-object',
    states: ['selected', 'two-steps'],
    steps: [{ type: 'Class', name: 'Cart' }, { type: 'Function', name: 'checkout' }],
    wanted: [{ kind: 'CallExpression', callee: 'get', object: 'db' }],
  },
  {
    name: 'reached-through-two-functions',
    states: ['selected', 'two-steps', 'several-ways-to-one-expression'],
    // Both `checkout` and the callback inside it lead to the callback's call.
    steps: [{ type: 'Class', name: 'Order' }, { type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
  },
  {
    name: 'every-function-of-the-file',
    states: ['selected', 'one-step', 'step-without-a-name'],
    steps: [{ type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'fetchTotal' }],
  },
  {
    name: 'constant-that-a-call-initializes',
    states: ['selected', 'one-step', 'declarator-step'],
    steps: [{ type: 'VariableDeclarator', name: 'total' }],
    wanted: [{ kind: 'CallExpression' }],
  },
  {
    name: 'three-steps',
    states: ['selected', 'three-steps', 'declarator-step'],
    steps: [{ type: 'Class', name: 'Cart' }, { type: 'Function', name: 'checkout' }, { type: 'VariableDeclarator' }],
    wanted: [{ kind: 'CallExpression' }],
  },
  {
    name: 'class-that-does-not-exist',
    states: ['none', 'one-step'],
    steps: [{ type: 'Class', name: 'Basket' }],
    wanted: [{ kind: 'CallExpression' }],
  },
  {
    name: 'kind-that-is-not-inside',
    states: ['none', 'one-step'],
    steps: [{ type: 'Class', name: 'Cart' }],
    wanted: [{ kind: 'BinaryExpression' }],
  },
  {
    name: 'by-line',
    states: ['selected', 'by-line'],
    steps: [],
    wanted: [{ kind: 'CallExpression', line: 'cart-refund' }],
  },
  {
    name: 'captured-through-traversal',
    states: ['selected', 'one-step', 'captured'],
    steps: [{ type: 'Function', name: 'refund' }],
    wanted: [{ kind: 'CallExpression' }],
    returns: 'a-capture',
  },
  {
    name: 'handler-returns-true',
    states: ['none', 'not-a-selection'],
    steps: [{ type: 'Function', name: 'refund' }],
    wanted: [{ kind: 'CallExpression' }],
    returns: 'true',
  },
  {
    name: 'handler-returns-another-object',
    states: ['none', 'not-a-selection'],
    steps: [],
    wanted: [{ kind: 'CallExpression', callee: 'start' }],
    returns: 'another-object',
  },
  {
    // What `capture` returns selects the node it was called on, in the handler that was called for that node.
    name: 'container-handler-returns-a-capture',
    states: ['none', 'not-a-selection'],
    steps: [{ type: 'Function', name: 'refund' }],
    wanted: [{ kind: 'CallExpression' }],
    returnsACaptureOfAnotherNode: true,
  },
  {
    name: 'handler-returns-the-container',
    states: ['none', 'not-a-selection'],
    steps: [{ type: 'Function', name: 'refund' }],
    wanted: [{ kind: 'CallExpression' }],
    returnsTheContainer: true,
  },
]

interface Placed {
  readonly leaves: Array<Leaf & { readonly line: number; readonly inside: ReadonlyArray<number> }>
  readonly branches: Array<{ readonly type: ContainerType; readonly name: string; readonly line: number; readonly inside: ReadonlyArray<number> }>
}

/** The tree with a line for everything and, for every leaf and branch, the branches around it (as indexes, outermost first). */
function place(tree: ReadonlyArray<Leaf | Branch>): Placed {
  const placed: Placed = { leaves: [], branches: [] }
  let line = 0
  const walk = (items: ReadonlyArray<Leaf | Branch>, around: ReadonlyArray<number>) => {
    for (const item of items) {
      line += 1
      if ('leaf' in item) {
        placed.leaves.push({ ...item, line, inside: around })
      } else {
        const index = placed.branches.length
        placed.branches.push({ type: item.type, name: item.name, line, inside: around })
        walk(item.children, [...around, index])
      }
    }
  }
  walk(tree, [])
  return placed
}

const PLACED = place(TREE)
const lineOfLeaf = (leaf: string) => PLACED.leaves.find((candidate) => candidate.leaf === leaf)!.line

const wants = (wanted: VisitorHistory['wanted'][number], leaf: Placed['leaves'][number]) =>
  leaf.kind === wanted.kind &&
  (wanted.callee === undefined || leaf.callee === wanted.callee) &&
  (wanted.object === undefined || leaf.object === wanted.object) &&
  (wanted.line === undefined || leaf.line === lineOfLeaf(wanted.line))

function visitorModel(history: VisitorHistory) {
  // The containers each step is taken in: every chain of containers, each inside the one before.
  let chains: Array<ReadonlyArray<number>> = [[]]
  // For each step, the names of the containers its handler is called for, once per traversal.
  const calledFor: Array<Array<string>> = []
  for (const step of history.steps) {
    const next: Array<ReadonlyArray<number>> = []
    const seen: Array<string> = []
    for (const chain of chains) {
      PLACED.branches.forEach((candidate, index) => {
        const inScope = chain.length === 0 || candidate.inside.includes(chain.at(-1)!)
        if (!inScope || candidate.type !== step.type) return
        seen.push(candidate.name)
        if (step.name === undefined || candidate.name === step.name) next.push([...chain, index])
      })
    }
    calledFor.push(seen.sort())
    chains = next
  }
  // The innermost handlers are not reached when the last step returns its container.
  const selected = new Set<string>()
  const expressionsSeen: Array<string> = []
  if (!history.returnsTheContainer && !history.returnsACaptureOfAnotherNode) {
    for (const chain of chains) {
      for (const leaf of PLACED.leaves) {
        const inScope = chain.length === 0 || leaf.inside.includes(chain.at(-1)!)
        if (!inScope || !history.wanted.some((wanted) => wanted.kind === leaf.kind)) continue
        expressionsSeen.push(leaf.leaf)
        if (history.wanted.some((wanted) => wants(wanted, leaf))) selected.add(leaf.leaf)
      }
    }
  }
  const isSelection = history.returns === undefined || history.returns === 'the-node' || history.returns === 'a-capture'
  const matched = isSelection ? [...selected].sort() : []
  const returnedSomethingElse =
    history.returnsTheContainer || history.returnsACaptureOfAnotherNode ? chains.length > 0 : !isSelection && selected.size > 0
  return {
    containersCalledFor: calledFor,
    expressionsCalledFor: expressionsSeen.sort(),
    outcome:
      matched.length === 1
        ? { replaces: matched, locals: history.returns === 'a-capture' ? { kept: 'value' } : {} }
        : { refused: `matched ${matched.length}`, pointsOutWhatWasReturned: returnedSomethingElse },
  }
}

let visitorRuns = 0

interface VisitedExpression {
  readonly kind: Kind
  readonly callee?: string
  readonly object?: string
  readonly line: number
  readonly text: string
  capture(...names: Array<string>): unknown
}
interface VisitedContainer {
  readonly type: ContainerType
  readonly name: string
  readonly line: number
  traverse(visitor: object): unknown
}
interface SelectedPoint {
  withReplacement<Result>(handler: (context: { readonly locals: object }) => unknown, action: () => Result, options: object): Result
}

oracleProperty({
  id: 'runtime-visitor-object',
  owns: ['src/runtime.ts#select', 'src/runtime.ts#registerFile'],
  law: {
    statement:
      'For every file registered with expressions and containers, and every visitor object, select calls the handler under a node type\'s key once for each node of that type in scope (the whole file for the visitor passed to select; everything inside the container, however deep, for a visitor passed to its traverse) and resolves to the single expression that a handler returns, directly, as node.capture(...), or through any depth of traverse; an expression reached through several containers counts once; no expression, or two or more, make it throw as the callback form does; and a handler that returns a container, or anything else that is not a selection, selects nothing, which the error points out.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24, on the selector API: "Nested traversal, keep callback too": a visitor object keyed by node type, with `Function` and `Class` as Babel\'s alias keys and `traverse(visitor)` to say "inside"; the callback form stays.',
    limits:
      'One registered file of ten expressions in two classes, four named functions, a callback and a constant; nineteen visitors of up to three steps. A handler compares direct properties only (name, callee, object, line). That a variable declarator is a third kind of container and that a call\'s receiver is called `object` are proposals that await the maintainer\'s word.',
  },
  histories: {
    enumerated: VISITOR_HISTORIES,
    states: [
      'selected',
      'none',
      'too-many',
      'top-of-file',
      'one-step',
      'two-steps',
      'three-steps',
      'declarator-step',
      'several-handlers',
      'name-used-twice',
      'several-ways-to-one-expression',
      'step-without-a-name',
      'by-line',
      'captured',
      'not-a-selection',
    ],
  },
  label: (history) => history.name,
  model: (history) => visitorModel(history),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    try {
      visitorRuns += 1
      const file = `visitor-${visitorRuns}.ts`
      const idOf = (leaf: string) => `${file}#${leaf}`
      const nodes = PLACED.leaves.map((leaf) => ({
        id: idOf(leaf.leaf),
        kind: leaf.kind,
        inFunction: null,
        ...(leaf.callee === undefined ? {} : { callee: leaf.callee }),
        ...(leaf.operator === undefined ? {} : { operator: leaf.operator }),
        ...(leaf.object === undefined ? {} : { object: leaf.object }),
        nth: 0,
        line: leaf.line,
        text: leaf.leaf,
      }))
      // What the plugin registers: each container with the indexes of everything inside it.
      const containers = PLACED.branches.map((container, index) => ({
        type: container.type,
        name: container.name,
        line: container.line,
        nodes: PLACED.leaves.flatMap((leaf, leafIndex) => (leaf.inside.includes(index) ? [leafIndex] : [])),
        containers: PLACED.branches.flatMap((inner, innerIndex) => (inner.inside.includes(index) ? [innerIndex] : [])),
      }))
      ;(registerFile as unknown as (file: string, nodes: unknown, homes: unknown, containers: unknown) => unknown)(file, nodes, [], containers)

      const containersCalledFor: Array<Array<string>> = history.steps.map(() => [])
      const expressionsCalledFor: Array<string> = []
      const innermost = () => {
        const handlers: Record<string, (node: VisitedExpression) => unknown> = {}
        for (const kind of new Set(history.wanted.map((wanted) => wanted.kind))) {
          handlers[kind] = (node) => {
            expressionsCalledFor.push(node.text)
            const wanted = history.wanted.some(
              (asked) =>
                asked.kind === node.kind &&
                (asked.callee === undefined || node.callee === asked.callee) &&
                (asked.object === undefined || node.object === asked.object) &&
                (asked.line === undefined || node.line === lineOfLeaf(asked.line)),
            )
            if (!wanted) return undefined
            if (history.returns === 'a-capture') return node.capture('kept')
            if (history.returns === 'true') return true
            if (history.returns === 'another-object') return { id: 'something else' }
            return node
          }
        }
        return handlers
      }
      // An expression that a handler at the top was called for, kept for a handler that has no business with it.
      let seenAtTheTop: VisitedExpression | undefined
      const visitorAt = (depth: number): object => {
        const step = history.steps[depth]
        if (!step) return innermost()
        return {
          ...(history.returnsACaptureOfAnotherNode && depth === 0
            ? {
                CallExpression: (node: VisitedExpression) => {
                  seenAtTheTop ??= node
                  return undefined
                },
              }
            : {}),
          [step.type]: (container: VisitedContainer) => {
            containersCalledFor[depth]!.push(container.name)
            if (step.name !== undefined && container.name !== step.name) return false
            if (history.returnsTheContainer && depth === history.steps.length - 1) return container
            if (history.returnsACaptureOfAnotherNode && depth === history.steps.length - 1) return seenAtTheTop!.capture('kept')
            return container.traverse(visitorAt(depth + 1))
          },
        }
      }

      let outcome: unknown
      try {
        const point = (select as unknown as (file: string, visitor: object) => SelectedPoint)(file, visitorAt(0))
        let locals: object = {}
        const replaces = PLACED.leaves
          .filter(
            (leaf) =>
              point.withReplacement(
                (context) => {
                  locals = { ...context.locals }
                  return 'replaced'
                },
                () => invoke(idOf(leaf.leaf), () => 'original', () => ({ kept: () => 'value' })),
                { times: 'any' },
              ) === 'replaced',
          )
          .map((leaf) => leaf.leaf)
        outcome = { replaces, locals }
      } catch (error) {
        const message = (error as Error).message
        outcome = {
          refused: /must match exactly 1 expression; (matched \d+)\./.exec(message)?.[1] ?? message,
          pointsOutWhatWasReturned: message.includes('returned something that is not the node'),
        }
      }
      observe('visitor', {
        containersCalledFor: containersCalledFor.map((names) => [...names].sort()),
        expressionsCalledFor: [...expressionsCalledFor].sort(),
        outcome,
      })
    } catch (error) {
      observe('visitor', { threw: error instanceof Error ? error.message : String(error) })
    }
  },
  check: (_history, observations, expected) =>
    differs('visitor', 'visitor', observations.find((o) => o.checkpoint === 'visitor')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'one-expression-counted-once-per-way',
      law: 'visitor',
      history: { enumerated: 'reached-through-two-functions' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'visitor'
            ? { ...o, value: { ...(o.value as object), outcome: { refused: 'matched 2', pointsOutWhatWasReturned: false } } }
            : o,
        ),
    },
    {
      name: 'a-handler-is-called-for-the-whole-file',
      law: 'visitor',
      history: { enumerated: 'class-then-function' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'visitor'
            ? {
                ...o,
                value: { ...(o.value as { containersCalledFor: Array<Array<string>> }), containersCalledFor: [['Cart', 'Order'], ['', 'checkout', 'checkout', 'helper', 'refund']] },
              }
            : o,
        ),
    },
  ],
})
