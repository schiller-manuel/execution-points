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
 * select('src/cart.ts', {
 *   Function: (fn) => fn.traverse({
 *     CallExpression: (call) => call.callee === 'get' && (fn.name === 'checkout' ? call.capture('key') : call.capture('each')),
 *   }),
 * })
 * // → one point, whose handler reads locals.key and locals.each, when both functions lead to the one call
 * ```
 *
 * The callback form sees every expression of a file at once and has to tell two `get` calls
 * apart by `inFunction` and `nth`. This form says where an expression stands the way the code
 * does: in this class, in this function. Does a call inside a callback count as inside the
 * method around it? If two functions on the way both lead to the same call, is that one match
 * or two? And when the handler captures `key` on one way and `each` on the other, which of the
 * two does the point's handler get?
 *
 * Four parts are checked: the **scope** a handler is called over (every node of its type in
 * the file at the top; every node of its type inside the container for `traverse`, however
 * deep), the **result** a handler passes outward (the node, `node.capture(...)`, or what
 * `traverse` returned), the **count** (exactly one expression, counted once however many
 * ways lead to it), and the **captures** (everything that any of those ways captured).
 *
 * For every file registered with expressions and containers, and every visitor object,
 * `select` calls the handler under a node type's key once for each node of that type in scope:
 * the whole file for the visitor passed to `select`, everything inside the container, however
 * deep, for a visitor passed to its `traverse`. It resolves to the single expression that a
 * handler returns, directly, as `node.capture(...)`, or through any depth of `traverse`; an
 * expression reached on several ways counts once, and its point captures every local that a
 * handler captured on any of them, each read once when the expression is reached; no expression, or two or more, make it throw as the
 * callback form does; and a handler that returns a container, or anything else that is not a
 * selection, selects nothing, which the error points out (Decisions by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-24: "Nested traversal, keep callback too": a visitor object keyed
 * by node type, `Function` and `Class` as Babel's alias keys, `traverse(visitor)` to say
 * "inside"; and an expression selected on several ways with a different capture on each is one
 * selection that captures all of them).
 *
 * The model walks the tree the file was registered from. It knows nothing of handlers or of
 * how results travel outward: it asks which expressions lie inside the containers a query
 * names, and which names the query captures on the ways that lead to them.
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
  /** The expressions the innermost handlers ask for, one handler per kind. `id` names one expression by its leaf. */
  readonly wanted: ReadonlyArray<{ readonly kind: Kind; readonly callee?: string; readonly object?: string; readonly id?: string }>
  /** What the innermost handler returns for an expression it wants. */
  readonly returns?: 'the-node' | 'a-capture' | 'true' | 'another-object'
  /**
   * What the innermost handler captures of an expression it wants, by the way that led to it:
   * the name of the container it was reached through, or `THE_FILE`. On a way that is not
   * listed it returns the node itself.
   */
  readonly capturedThrough?: Readonly<Record<string, ReadonlyArray<string>>>
  /** The visitor passed to `select` has the innermost handlers too, so every expression is also reached without a step. */
  readonly atTheTopToo?: boolean
  /** The handler of the last step returns the container itself instead of traversing into it. */
  readonly returnsTheContainer?: boolean
  /** The handler of the last step returns a capture of an expression that another handler was called for. */
  readonly returnsACaptureOfAnotherNode?: boolean
}

/** The way to an expression that leads through no container. */
const THE_FILE = '(the file)'

/** What the application's locals hold when the expression is reached. */
const HELD: Readonly<Record<string, string>> = { kept: 'value', key: 'the key', each: 'one item', list: 'the list' }

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
    name: 'by-id',
    states: ['selected', 'by-id'],
    steps: [],
    wanted: [{ kind: 'CallExpression', id: 'cart-refund' }],
  },
  {
    name: 'captured-through-traversal',
    states: ['selected', 'one-step', 'captured'],
    steps: [{ type: 'Function', name: 'refund' }],
    wanted: [{ kind: 'CallExpression' }],
    returns: 'a-capture',
  },
  {
    // Both `checkout` and the callback inside it lead to the callback's call, and the handler captures on each way.
    name: 'two-ways-capture-the-same',
    states: ['selected', 'two-steps', 'several-ways-to-one-expression', 'captures-agree'],
    steps: [{ type: 'Class', name: 'Order' }, { type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
    capturedThrough: { checkout: ['key'], '': ['key'] },
  },
  {
    name: 'two-ways-capture-differently',
    states: ['selected', 'two-steps', 'several-ways-to-one-expression', 'captures-differ'],
    steps: [{ type: 'Class', name: 'Order' }, { type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
    capturedThrough: { checkout: ['key'], '': ['each'] },
  },
  {
    name: 'two-ways-capture-overlapping',
    states: ['selected', 'two-steps', 'several-ways-to-one-expression', 'captures-differ', 'captures-overlap'],
    steps: [{ type: 'Class', name: 'Order' }, { type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
    capturedThrough: { checkout: ['key', 'list'], '': ['list', 'each'] },
  },
  {
    name: 'captured-on-the-first-way-only',
    states: ['selected', 'two-steps', 'several-ways-to-one-expression', 'captures-differ', 'a-way-without-a-capture'],
    steps: [{ type: 'Class', name: 'Order' }, { type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
    capturedThrough: { checkout: ['key'] },
  },
  {
    name: 'captured-on-the-second-way-only',
    states: ['selected', 'two-steps', 'several-ways-to-one-expression', 'captures-differ', 'a-way-without-a-capture'],
    steps: [{ type: 'Class', name: 'Order' }, { type: 'Function' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
    capturedThrough: { '': ['each'] },
  },
  {
    // The handler at the top reaches the call directly, and the one inside `refund` reaches it again.
    name: 'reached-directly-and-through-a-function',
    states: ['selected', 'one-step', 'several-ways-to-one-expression', 'captures-differ', 'a-way-without-a-step'],
    steps: [{ type: 'Function', name: 'refund' }],
    wanted: [{ kind: 'CallExpression', id: 'cart-refund' }],
    capturedThrough: { [THE_FILE]: ['key'], refund: ['list'] },
    atTheTopToo: true,
  },
  {
    // Captures are merged for one expression. Two expressions stay two, whatever they capture.
    name: 'two-expressions-captured-alike',
    states: ['too-many', 'two-steps', 'captured'],
    steps: [{ type: 'Class', name: 'Cart' }, { type: 'Function', name: 'checkout' }],
    wanted: [{ kind: 'CallExpression', callee: 'get' }],
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
  readonly leaves: Array<Leaf & { readonly inside: ReadonlyArray<number> }>
  readonly branches: Array<{ readonly type: ContainerType; readonly name: string; readonly inside: ReadonlyArray<number> }>
}

/** The tree with, for every leaf and branch, the branches around it (as indexes, outermost first). */
function place(tree: ReadonlyArray<Leaf | Branch>): Placed {
  const placed: Placed = { leaves: [], branches: [] }
  const walk = (items: ReadonlyArray<Leaf | Branch>, around: ReadonlyArray<number>) => {
    for (const item of items) {
      if ('leaf' in item) {
        placed.leaves.push({ ...item, inside: around })
      } else {
        const index = placed.branches.length
        placed.branches.push({ type: item.type, name: item.name, inside: around })
        walk(item.children, [...around, index])
      }
    }
  }
  walk(tree, [])
  return placed
}

const PLACED = place(TREE)

const wants = (wanted: VisitorHistory['wanted'][number], leaf: Placed['leaves'][number]) =>
  leaf.kind === wanted.kind &&
  (wanted.callee === undefined || leaf.callee === wanted.callee) &&
  (wanted.object === undefined || leaf.object === wanted.object) &&
  (wanted.id === undefined || leaf.leaf === wanted.id)

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
  // The ways that lead to the innermost handlers: each chain of containers, and the file itself when the top has them too.
  const ways: Array<ReadonlyArray<number>> = history.atTheTopToo ? [[], ...chains] : chains
  // Each selected expression, with every name captured on a way that led to it.
  const selected = new Map<string, Set<string>>()
  const expressionsSeen: Array<string> = []
  // The innermost handlers are not reached when the last step returns its container.
  if (!history.returnsTheContainer && !history.returnsACaptureOfAnotherNode) {
    for (const way of ways) {
      const through = way.length === 0 ? THE_FILE : PLACED.branches[way.at(-1)!]!.name
      const captured = history.returns === 'a-capture' ? ['kept'] : (history.capturedThrough?.[through] ?? [])
      for (const leaf of PLACED.leaves) {
        const inScope = way.length === 0 || leaf.inside.includes(way.at(-1)!)
        if (!inScope || !history.wanted.some((wanted) => wanted.kind === leaf.kind)) continue
        expressionsSeen.push(leaf.leaf)
        if (!history.wanted.some((wanted) => wants(wanted, leaf))) continue
        const names = selected.get(leaf.leaf) ?? new Set()
        selected.set(leaf.leaf, names)
        for (const name of captured) names.add(name)
      }
    }
  }
  const isSelection = history.returns === undefined || history.returns === 'the-node' || history.returns === 'a-capture'
  const matched = isSelection ? [...selected.keys()].sort() : []
  const returnedSomethingElse =
    history.returnsTheContainer || history.returnsACaptureOfAnotherNode ? chains.length > 0 : !isSelection && selected.size > 0
  return {
    containersCalledFor: calledFor,
    expressionsCalledFor: expressionsSeen.sort(),
    outcome:
      matched.length === 1
        ? {
            replaces: matched,
            locals: Object.fromEntries([...selected.get(matched[0]!)!].sort().map((name) => [name, HELD[name]!])),
            // README, "Capture local bindings": "Captures are read once for each intercepted execution".
            reads: Object.fromEntries([...selected.get(matched[0]!)!].sort().map((name) => [name, 1])),
          }
        : { refused: `matched ${matched.length}`, pointsOutWhatWasReturned: returnedSomethingElse },
  }
}

let visitorRuns = 0

interface VisitedExpression {
  readonly id: string
  readonly kind: Kind
  readonly callee?: string
  readonly object?: string
  capture(...names: Array<string>): unknown
}
interface VisitedContainer {
  readonly type: ContainerType
  readonly name: string
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
      'For every file registered with expressions and containers, and every visitor object, select calls the handler under a node type\'s key once for each node of that type in scope (the whole file for the visitor passed to select; everything inside the container, however deep, for a visitor passed to its traverse) and resolves to the single expression that a handler returns, directly, as node.capture(...), or through any depth of traverse; an expression reached on several ways counts once, and its point captures every local that a handler captured on any of them, each read once when the expression is reached; no expression, or two or more, make it throw as the callback form does; and a handler that returns a container, or anything else that is not a selection, selects nothing, which the error points out.',
    authority:
      'Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24. On the selector API: "Nested traversal, keep callback too": a visitor object keyed by node type, with `Function` and `Class` as Babel\'s alias keys and `traverse(visitor)` to say "inside"; the callback form stays. On captures: an expression selected on several ways with a different capture on each is one selection that captures all of them. README, "Capture local bindings": "Captures are read once for each intercepted execution".',
    limits:
      'One registered file of ten expressions in two classes, four named functions, a callback and a constant; twenty-six visitors of up to three steps, with at most two ways to one expression. A handler compares direct properties only (name, callee, object, id). The file is registered by hand, so which properties a node has when the plugin registers it is the law of plugin-registers-places-and-containers. That a variable declarator is a third kind of container is a proposal.',
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
      'by-id',
      'captured',
      'captures-agree',
      'captures-differ',
      'captures-overlap',
      'a-way-without-a-capture',
      'a-way-without-a-step',
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
      }))
      // What the plugin registers: each container with the indexes of everything inside it.
      const containers = PLACED.branches.map((container, index) => ({
        type: container.type,
        name: container.name,
        nodes: PLACED.leaves.flatMap((leaf, leafIndex) => (leaf.inside.includes(index) ? [leafIndex] : [])),
        containers: PLACED.branches.flatMap((inner, innerIndex) => (inner.inside.includes(index) ? [innerIndex] : [])),
      }))
      ;(registerFile as unknown as (file: string, nodes: unknown, homes: unknown, containers: unknown) => unknown)(file, nodes, [], containers)

      const containersCalledFor: Array<Array<string>> = history.steps.map(() => [])
      const expressionsCalledFor: Array<string> = []
      // The handlers for the expressions, as they stand at the end of the way `through`.
      const innermost = (through: string) => {
        const handlers: Record<string, (node: VisitedExpression) => unknown> = {}
        for (const kind of new Set(history.wanted.map((wanted) => wanted.kind))) {
          handlers[kind] = (node) => {
            expressionsCalledFor.push(node.id.slice(file.length + 1))
            const wanted = history.wanted.some(
              (asked) =>
                asked.kind === node.kind &&
                (asked.callee === undefined || node.callee === asked.callee) &&
                (asked.object === undefined || node.object === asked.object) &&
                (asked.id === undefined || node.id === idOf(asked.id)),
            )
            if (!wanted) return undefined
            if (history.returns === 'a-capture') return node.capture('kept')
            if (history.returns === 'true') return true
            if (history.returns === 'another-object') return { id: 'something else' }
            const captured = history.capturedThrough?.[through]
            return captured ? node.capture(...captured) : node
          }
        }
        return handlers
      }
      // An expression that a handler at the top was called for, kept for a handler that has no business with it.
      let seenAtTheTop: VisitedExpression | undefined
      const visitorAt = (depth: number, through: string): object => {
        const step = history.steps[depth]
        if (!step) return innermost(through)
        return {
          ...(history.atTheTopToo && depth === 0 ? innermost(THE_FILE) : {}),
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
            return container.traverse(visitorAt(depth + 1, container.name))
          },
        }
      }

      let outcome: unknown
      try {
        const point = (select as unknown as (file: string, visitor: object) => SelectedPoint)(file, visitorAt(0, THE_FILE))
        let locals: object = {}
        // How often the application's locals were read, by name.
        const reads: Record<string, number> = {}
        const bindings = () =>
          Object.fromEntries(
            Object.entries(HELD).map(([name, value]) => [
              name,
              () => {
                reads[name] = (reads[name] ?? 0) + 1
                return value
              },
            ]),
          )
        const replaces = PLACED.leaves
          .filter(
            (leaf) =>
              point.withReplacement(
                (context) => {
                  locals = Object.fromEntries(Object.entries(context.locals).sort())
                  return 'replaced'
                },
                () => invoke(idOf(leaf.leaf), () => 'original', bindings),
                { times: 'any' },
              ) === 'replaced',
          )
          .map((leaf) => leaf.leaf)
        outcome = { replaces, locals, reads: Object.fromEntries(Object.entries(reads).sort()) }
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
      name: 'only-the-first-way-captures',
      law: 'visitor',
      history: { enumerated: 'two-ways-capture-differently' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'visitor'
            ? { ...o, value: { ...(o.value as object), outcome: { replaces: ['order-callback'], locals: { key: HELD.key! }, reads: { key: 1 } } } }
            : o,
        ),
    },
    {
      name: 'different-captures-make-two-selections',
      law: 'visitor',
      history: { enumerated: 'two-ways-capture-overlapping' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'visitor'
            ? { ...o, value: { ...(o.value as object), outcome: { refused: 'matched 2', pointsOutWhatWasReturned: false } } }
            : o,
        ),
    },
    {
      name: 'a-local-captured-on-two-ways-is-read-twice',
      law: 'visitor',
      history: { enumerated: 'two-ways-capture-overlapping' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'visitor') return o
          const value = o.value as { outcome: { reads: Record<string, number> } }
          return { ...o, value: { ...value, outcome: { ...value.outcome, reads: { ...value.outcome.reads, list: 2 } } } }
        }),
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
