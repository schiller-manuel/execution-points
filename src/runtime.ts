// `preserve` carries these into the published declarations: `Replacement` is disposable, and
// `interleavings()` returns an iterator that has `take`.
/// <reference lib="esnext.disposable" preserve="true" />
/// <reference lib="esnext.iterator" preserve="true" />
import { AsyncLocalStorage } from 'node:async_hooks'

// ---------------------------------------------------------------------------------------------
// What a test sees
// ---------------------------------------------------------------------------------------------

export interface NodeDescriptor {
  readonly id: string
  readonly kind: 'CallExpression' | 'BinaryExpression' | 'ConditionalExpression'
  readonly inFunction: string | null
  readonly nth: number
  readonly callee?: string
  readonly operator?: string
  /** For a call made on an object, that object as written: `cache` in `cache.get(key)`. */
  readonly object?: string
  /** The line the expression starts on, counted from 1. */
  readonly line: number
  /** The expression as `execution-points list` prints it: on one line, cut to 72 characters. */
  readonly text: string
  readonly result: unknown
  readonly locals: object
}

/** A function, a class, or a variable declarator with selectable expressions inside it. */
export interface ContainerDescriptor {
  readonly type: 'Function' | 'Class' | 'VariableDeclarator'
  /** The name it is declared under. A function or class assigned to a constant has the constant's name; an anonymous one has `''`. */
  readonly name: string
  /** The line it starts on, counted from 1. */
  readonly line: number
  /** What lies inside it, however deep. It exists in the types alone and types the visitor of `traverse`. */
  readonly __inside: unknown
}

/**
 * Augmented virtually by the TypeScript 7.1 content mapper (points.ep).
 * Maps each configured target file path to the discriminated union of its
 * selectable expressions (with inferred result and narrowed local types).
 */
export interface ExecutionPointFileRegistry {}

/**
 * Augmented by the content mapper like `ExecutionPointFileRegistry`. Maps each target file to
 * the union of its containers: the functions, classes and variable declarators that have a
 * selectable expression inside them.
 */
export interface ExecutionPointContainerRegistry {}

export interface Context<Result, Locals extends object> {
  /** Captured binding values. Referenced objects retain their normal mutability. */
  readonly locals: Readonly<Locals>
  /** Evaluate the original expression. Each call evaluates it again. */
  readonly original: () => Result
  /** Which evaluation of the expression this is for the running replacement: 1 for the first. */
  readonly call: number
}

export interface ReplacementOptions {
  /**
   * How often the handler must run. Absent: at least once. A number: exactly that often
   * (`0` means the expression must not be reached). `'any'`: no requirement.
   */
  readonly times?: number | 'any'
  /**
   * The evaluations the handler takes, counted from 1. The others evaluate the original
   * expression. Absent: all of them.
   */
  readonly on?: number | readonly number[]
}

/** A replacement that applies in every async context of the worker until it is restored. */
export interface Replacement {
  /** How often its handler has run. */
  readonly calls: number
  /** Removes the replacement. Throws when it did not run as often as `times` asked. */
  restore(): void
  /** `using replacement = point.replace(handler)` restores it at the end of the block. */
  [Symbol.dispose](): void
}

/** An evaluation that reached a paused expression. */
export interface Arrival<Locals extends object> {
  readonly locals: Readonly<Locals>
}

export interface Pause<Locals extends object> {
  /** Runs `action` with the expression paused, and returns what the action returns. */
  run<T>(action: () => T): T
  /**
   * Resolves with the first evaluation that arrives. Rejects as soon as the action finishes
   * without one, so a test that awaits it never waits for a timeout.
   */
  readonly reached: PromiseLike<Arrival<Locals>>
  /** Lets every waiting evaluation continue with the original expression; later ones pass through. */
  release(): void
  /** How many evaluations have arrived. */
  readonly calls: number
}

type OnlyForPromises<Method extends string> = `${Method}() needs an expression whose value is a promise.`

/** `Yes` when the expression's value is a promise (or `any`), `No` otherwise. */
type IfPromise<Result, Yes, No> = 0 extends 1 & Result ? Yes : [Result] extends [PromiseLike<unknown>] ? Yes : No

/**
 * Reject async handlers (returning Promise) on synchronous void expressions while
 * preserving `any`, `undefined`, `Promise<void>`, and `return original()`.
 */
type HandlerResult<R> = 0 extends 1 & R ? R : [R] extends [void] ? ([void] extends [R] ? void | undefined : R) : R

/** Only `select()` makes a point: nothing else has this property, and it exists in the types alone. */
declare const selectedBy: unique symbol

export interface Point<Result, Locals extends object> {
  readonly [selectedBy]: 'select'

  /**
   * Replaces the expression inside `action` and the asynchronous work it starts. The handler
   * must run at least once, unless `options.times` says otherwise: a synchronous action that
   * falls short makes this call throw, an asynchronous one makes the test fail when it ends.
   */
  withReplacement<T>(
    handler: (context: Context<Result, Locals>) => HandlerResult<Result>,
    action: () => T,
    options?: ReplacementOptions,
  ): T

  /**
   * Replaces the expression in every async context of the worker until the returned
   * replacement is restored, or the test ends. Use it when the code runs in a context the
   * test did not start, such as a server that is already listening.
   */
  replace(handler: (context: Context<Result, Locals>) => HandlerResult<Result>, options?: ReplacementOptions): Replacement

  /** `replace` with a handler that returns `value`. */
  returns(value: HandlerResult<Result>, options?: ReplacementOptions): Replacement
  /** `replace` with a handler that throws `error`. */
  throws(error: unknown, options?: ReplacementOptions): Replacement
  /** `replace` with a handler that returns a promise fulfilled with `value`. */
  resolves: IfPromise<Result, (value: Awaited<Result>, options?: ReplacementOptions) => Replacement, OnlyForPromises<'resolves'>>
  /** `replace` with a handler that returns a promise rejected with `error`. */
  rejects: IfPromise<Result, (error: unknown, options?: ReplacementOptions) => Replacement, OnlyForPromises<'rejects'>>

  /**
   * Holds evaluations of the expression inside `pause.run(action)` until `pause.release()`.
   * Only an expression whose value is a promise can wait.
   */
  pause: IfPromise<Result, () => Pause<Locals>, OnlyForPromises<'pause'>>

  /** How often a replacement for this expression has run since the current test began. */
  readonly calls: number
}

export interface SelectablePoint<N extends NodeDescriptor, Captured extends object = {}> extends Point<N['result'], Captured> {
  /** Explicitly capture one or more in-scope local bindings at this expression. */
  capture<K extends keyof N['locals'] & string = never>(
    ...keys: readonly K[]
  ): SelectablePoint<N, { readonly [P in K]: N['locals'][P] }>
}

export interface CapturedSelection<N extends NodeDescriptor, Keys extends readonly string[]> {
  readonly __node: N
  readonly __capture: Keys
}

type VisitorNode<N extends NodeDescriptor> = N extends NodeDescriptor
  ? Omit<N, 'result' | 'locals' | '__unportable'> & {
      readonly __node: N
      capture<K extends keyof N['locals'] & string = never>(...keys: readonly K[]): CapturedSelection<N, readonly K[]>
    }
  : never

type RegistryIsEmpty = keyof ExecutionPointFileRegistry extends never ? true : false

type ExecutionPointsNotLoaded =
  'ExecutionPointFileRegistry is empty. Ensure points.ep is included in tsconfig.json with contentMappers enabled, run tsc with --runExternalCode (or in VS Code choose "TypeScript: Select TypeScript Version -> Use Workspace Version" with TypeScript 7.1), and verify the package is inside the open workspace (TS18124).'

type RegisteredTargetFile = RegistryIsEmpty extends true ? ExecutionPointsNotLoaded : keyof ExecutionPointFileRegistry & string

type FileNodes<File extends string> = File extends keyof ExecutionPointFileRegistry
  ? Extract<ExecutionPointFileRegistry[File], NodeDescriptor>
  : never

type FileContainers<File extends string> = File extends keyof ExecutionPointContainerRegistry
  ? Extract<ExecutionPointContainerRegistry[File], ContainerDescriptor>
  : never

type InsideOf<Container> = Container extends { readonly __inside: infer Inside } ? Inside : never

/** A container as a handler receives it: look inside it with `traverse`. */
export interface Traversable {
  /**
   * Calls the handlers of `visitor` for everything inside this container, however deep, and
   * returns what they selected. Return that from your own handler.
   */
  traverse<R extends VisitorReturn>(visitor: Visitor<InsideOf<this>, R>): R
}

type ContainerNode<Inside, Type extends ContainerDescriptor['type']> = Extract<Inside, { readonly type: Type }> & Traversable

type ExpressionNode<Inside, Kind extends NodeDescriptor['kind']> = VisitorNode<Extract<Inside, { readonly kind: Kind } & NodeDescriptor>>

/**
 * A visitor keyed by node type, as in Babel: each handler is called for every node of its type
 * in scope, and returns the expression it selects (the node, or `node.capture(...)`), what
 * `node.traverse(...)` returned for a container, or nothing. `Function` covers every kind of
 * function and `Class` every kind of class.
 */
export interface Visitor<Inside, R> {
  CallExpression?(node: ExpressionNode<Inside, 'CallExpression'>): R
  BinaryExpression?(node: ExpressionNode<Inside, 'BinaryExpression'>): R
  ConditionalExpression?(node: ExpressionNode<Inside, 'ConditionalExpression'>): R
  Function?(node: ContainerNode<Inside, 'Function'>): R
  Class?(node: ContainerNode<Inside, 'Class'>): R
  VariableDeclarator?(node: ContainerNode<Inside, 'VariableDeclarator'>): R
}

type IsUnion<T, Copy = T> = [T] extends [never] ? false : T extends unknown ? ([Copy] extends [T] ? false : true) : never

type CleanReturn<R> = Exclude<R, undefined | void | null | false>

type ExtractNode<R> =
  CleanReturn<R> extends infer Item ? (Item extends { readonly __node: infer N extends NodeDescriptor } ? N : never) : never

type ExtractCapturedLocals<R> =
  CleanReturn<R> extends CapturedSelection<infer N, infer Keys>
    ? { readonly [K in Keys[number] & keyof N['locals']]: N['locals'][K] }
    : {}

type SelectFromNodes<N extends NodeDescriptor, Captured extends object> = [N] extends [never]
  ? {
      readonly __selectionError: 'Visitor matched 0 expressions. Return a matching node from the callback.'
    }
  : IsUnion<N> extends true
    ? {
        readonly __selectionError: 'Selector matched multiple expressions. Narrow further by callee/operator, inFunction, kind, or nth.'
        readonly __matched: N['id']
      }
    : N extends { readonly __unportable: infer Reason extends string }
      ? {
          readonly __selectionError: `Matched expression "${N['id']}" has an unportable type and cannot be selected directly: ${Reason}`
        }
      : SelectablePoint<N, Captured>

interface EmptyRegistryPoint extends Point<any, any> {
  capture(...keys: readonly string[]): EmptyRegistryPoint
}

type SelectedPoint<R> = RegistryIsEmpty extends true ? EmptyRegistryPoint : SelectFromNodes<ExtractNode<R>, ExtractCapturedLocals<R>>

type VisitorReturn =
  | { readonly __node: NodeDescriptor }
  | CapturedSelection<NodeDescriptor, readonly string[]>
  | undefined
  | void
  | false
  | null

/** A point whose expression evaluates to a promise, so an evaluation of it can be made to wait. */
export interface Waitable {
  readonly [selectedBy]: 'select'
  pause(): Pause<object>
}

export interface InterleavingOptions {
  /** Gives exactly one order: the `schedule` of an order that ran before, or of a failure. */
  readonly schedule?: readonly number[]
  /**
   * Picks every order itself instead of walking all of them: called with the step within the
   * run, the number of evaluations held at that step (in the order they arrived), and the run's
   * number, it returns the index of the one to release. The orders then never run out; stop
   * with `break` or `.take(n)`.
   */
  readonly choose?: (step: number, count: number, run: number) => number
}

/** One order in which a scenario's operations pass the selected expressions. */
export interface Interleaving {
  /**
   * Runs `action` once in this order and resolves to what it resolves to. Every evaluation of a
   * selected expression inside `action` is held; whenever all operations have finished or are
   * held, one is released. Rejects with an `InterleavingFailure` when `action` throws or rejects.
   */
  run<Result>(action: () => Result | PromiseLike<Result>): Promise<Result>
  /** The choices made so far. `interleavings(points, { schedule })` gives this order again. */
  readonly schedule: readonly number[]
  /** The ids of the evaluations released so far, in the order they were released. */
  readonly released: readonly string[]
}

/** What the plugin tells the runtime about one selectable expression. */
export type RegisteredNode = Omit<NodeDescriptor, 'result' | 'locals'>

/** What the plugin tells the runtime about one container: what is inside it, as indexes into the file's nodes and containers. */
export interface RegisteredContainer extends Omit<ContainerDescriptor, '__inside'> {
  readonly nodes: readonly number[]
  readonly containers: readonly number[]
}

// ---------------------------------------------------------------------------------------------
// What the runtime keeps
// ---------------------------------------------------------------------------------------------

/** The runtime does not know the types the registry gave a handler; it passes values through. */
interface AnyContext {
  readonly locals: Readonly<Record<string, unknown>>
  readonly original: () => unknown
  readonly call: number
}
type Handler = (context: AnyContext) => unknown

interface Installation {
  readonly id: string
  readonly handler: Handler
  readonly captureNames: readonly string[]
  readonly times: number | 'any' | undefined
  readonly turns: readonly number[] | undefined
  evaluations: number
  runs: number
  /** Takes a replacement that applies everywhere off its stack. */
  settle?: () => void
}

/** Something else a test owes when it ends: a pause that may still be holding. */
interface Debt {
  settle(): void
  verdict(): Error | undefined
}

interface Flag {
  on: boolean
}

interface FileState {
  /** The ids of the expressions a test has installed a replacement for. */
  readonly replaced: Set<string>
  /** One set of flags per way the file's expressions were assigned to homes. */
  readonly layouts: Map<string, { readonly flags: Flag[]; readonly homeOf: Map<string, number> }>
}

interface Selection {
  readonly __epSelected?: true
  readonly id: string
  readonly captureNames: readonly string[]
}

interface Registry {
  readonly storage: AsyncLocalStorage<Map<string, Installation>>
  readonly files: Map<string, readonly RegisteredNode[]>
  readonly containers: Map<string, readonly RegisteredContainer[]>
  readonly states: Map<string, FileState>
  flagCount: number
  /** Replacements that apply in every async context: a stack per expression id. */
  readonly everywhere: Map<string, Installation[]>
  /** How often a replacement ran for each expression since the last verification. */
  readonly calls: Map<string, number>
  /** What is still to be checked when the test ends, and what already went wrong. */
  readonly owed: Set<Installation | Debt>
  readonly problems: Error[]
}

// Vite can load this module through more than one module graph. All copies in
// the same Node worker must share the same async-local store and file index.
const shared: unique symbol = Symbol.for('execution-points-prototype.runtime.v2')
const registry: Registry = ((globalThis as { [shared]?: Registry })[shared] ??= {
  storage: new AsyncLocalStorage(),
  files: new Map(),
  containers: new Map(),
  states: new Map(),
  flagCount: 0,
  everywhere: new Map(),
  calls: new Map(),
  owed: new Set(),
  problems: [],
})

/**
 * Returns the file's flags, one per home (a function body, or a position that is evaluated
 * later, as the plugin numbers them in `homes`). Instrumented code reads its home's flag
 * before it runs: until a test installs a replacement for an expression of that home, the
 * flag is off and the original statements run. Every registration of the file is told about
 * every replacement, earlier or later, so no copy of the code can miss one.
 */
export function registerFile(
  file: string,
  nodes: readonly RegisteredNode[],
  homes: readonly number[] = [],
  containers: readonly RegisteredContainer[] = [],
): ReadonlyArray<{ readonly on: boolean }> {
  registry.files.set(file, nodes)
  registry.containers.set(file, containers)
  const state = registry.states.get(file) ?? { replaced: new Set(), layouts: new Map() }
  registry.states.set(file, state)

  const homeOf = new Map(nodes.map((node, index) => [node.id, homes[index] ?? 0]))
  const key = JSON.stringify([...homeOf])
  let layout = state.layouts.get(key)
  if (!layout) {
    // Each flag is an object with a shape of its own. V8 then treats an unset flag as a constant,
    // so reading it costs nothing, until that very flag is set.
    const flags = Array.from({ length: Math.max(...homeOf.values(), 0) + 1 }, (): Flag => {
      const name = `flag ${(registry.flagCount += 1)}`
      return { [name]: name, on: false }
    })
    for (const id of state.replaced) flags[homeOf.get(id)!]!.on = true
    layout = { flags, homeOf }
    state.layouts.set(key, layout)
  }
  return layout.flags
}

/** From here on, calls into the home of `id` take the wrapped expressions. */
function markReplaced(file: string, id: string): void {
  const state = registry.states.get(file)!
  state.replaced.add(id)
  for (const { flags, homeOf } of state.layouts.values()) flags[homeOf.get(id)!]!.on = true
}

function getFileNodes(file: string): readonly RegisteredNode[] {
  const nodes = registry.files.get(file)
  if (!nodes) {
    throw new Error(
      `[execution-points] Target file "${file}" was not instrumented or has not been imported yet. ` +
        'Ensure it is listed in points.ep under "targets" and imported before running the action.',
    )
  }
  return nodes
}

const count = (n: number): string => (n === 1 ? 'once' : `${n} times`)

function createInstallation(
  id: string,
  handler: Handler,
  captureNames: readonly string[],
  { times, on }: ReplacementOptions = {},
): Installation {
  // The compiler accepts any number here, so these two are checked when the replacement is installed.
  if (times !== undefined && times !== 'any' && !(Number.isInteger(times) && times >= 0)) {
    throw new TypeError("[execution-points] `times` must be a whole number, 0 or more, or 'any'.")
  }
  const turns = on === undefined ? undefined : [on].flat()
  if (turns && !turns.every((turn) => Number.isInteger(turn) && turn >= 1)) {
    throw new TypeError('[execution-points] `on` must be a whole number, 1 or more, or a list of them.')
  }
  return { id, handler, captureNames, times, turns, evaluations: 0, runs: 0 }
}

/** What a finished replacement got wrong: by default it must have run at least once. */
function shortfall({ id, times, runs }: Installation): Error | undefined {
  if (times === 'any' || (times === undefined ? runs > 0 : runs === times)) return undefined
  return new Error(
    `[execution-points] The replacement for "${id}" ran ${count(runs)}; expected ${times === undefined ? 'at least once' : count(times)}. ` +
      (runs === 0 ? 'Nothing evaluated this expression where the replacement applies. ' : '') +
      "Pass { times: 'any' } if that is intended.",
  )
}

/**
 * Checks everything the current test still owes and forgets it: replacements whose action is
 * asynchronous, replacements that apply everywhere and were not restored, and pauses. Throws
 * what went wrong. The Vitest setup module calls this after each test; call it yourself under
 * another runner.
 */
export function verifyReplacements(): void {
  const problems = registry.problems.splice(0)
  for (const owed of registry.owed) {
    owed.settle?.()
    const problem = 'verdict' in owed ? owed.verdict() : shortfall(owed)
    if (problem) problems.push(problem)
  }
  registry.owed.clear()
  registry.calls.clear()
  if (problems.length === 1) throw problems[0]
  if (problems.length) {
    throw new AggregateError(problems, problems.map((problem) => problem.message).join('\n'))
  }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function'

/** A point as the runtime builds it. `select` hands it out under the type the registry gives it. */
interface PointHandle {
  capture(...keys: string[]): PointHandle
  readonly calls: number
  withReplacement<T>(handler: Handler, action: () => T, options?: ReplacementOptions): T
  replace(handler: Handler, options?: ReplacementOptions): Replacement
  returns(value: unknown, options?: ReplacementOptions): Replacement
  throws(error: unknown, options?: ReplacementOptions): Replacement
  resolves(value: unknown, options?: ReplacementOptions): Replacement
  rejects(error: unknown, options?: ReplacementOptions): Replacement
  pause(): Pause<Record<string, unknown>>
}

// What `interleavings` needs from a point that its users do not.
const internals = new WeakMap<object, { begin(handler: Handler, options?: ReplacementOptions): Installation; id(): string }>()

function createPointHandle(file: string, resolveSelection: () => Selection, captureNames?: readonly string[]): PointHandle {
  const begin = (handler: Handler, options?: ReplacementOptions): Installation => {
    const selected = resolveSelection()
    const installation = createInstallation(selected.id, handler, captureNames ?? selected.captureNames, options)
    markReplaced(file, selected.id)
    return installation
  }

  // Applies inside `action` and the asynchronous work it starts.
  const scoped = <T>(installation: Installation, action: () => T): T => {
    const replacements = new Map(registry.storage.getStore() ?? [])
    replacements.set(installation.id, installation)
    return registry.storage.run(replacements, action)
  }

  // Applies in every async context until it is restored: the newest one for an expression wins.
  const replace = (handler: Handler, options?: ReplacementOptions): Replacement => {
    const installation = begin(handler, options)
    const stack = registry.everywhere.get(installation.id) ?? []
    registry.everywhere.set(installation.id, stack)
    stack.push(installation)
    const settle = (): void => {
      stack.splice(stack.indexOf(installation), 1)
    }
    installation.settle = settle
    registry.owed.add(installation)

    const restore = (): void => {
      if (!registry.owed.delete(installation)) return
      settle()
      const problem = shortfall(installation)
      if (problem) throw problem
    }
    return Object.freeze({
      get calls() {
        return installation.runs
      },
      restore,
      [Symbol.dispose]: restore,
    })
  }

  const handle: PointHandle = Object.freeze({
    capture(...keys: string[]) {
      return createPointHandle(file, resolveSelection, keys)
    },

    /** How often a replacement for this expression ran since the last verification. */
    get calls() {
      return registry.calls.get(resolveSelection().id) ?? 0
    },

    withReplacement<T>(handler: Handler, action: () => T, options?: ReplacementOptions): T {
      const installation = begin(handler, options)
      const result = scoped(installation, action)
      // The work of an asynchronous action is still running: it is checked when the test ends.
      if (isThenable(result)) {
        registry.owed.add(installation)
        return result
      }
      const problem = shortfall(installation)
      if (problem) throw problem
      return result
    },

    replace,
    returns: (value: unknown, options?: ReplacementOptions) => replace(() => value, options),
    throws: (error: unknown, options?: ReplacementOptions) =>
      replace(() => {
        throw error
      }, options),
    resolves: (value: unknown, options?: ReplacementOptions) => replace(() => Promise.resolve(value), options),
    rejects: (error: unknown, options?: ReplacementOptions) => replace(() => Promise.reject(error), options),

    /**
     * Holds every evaluation inside `run(action)` until `release()`, then lets it continue
     * with the original expression. `reached` settles with the first evaluation that arrives,
     * or rejects as soon as the action finishes without one.
     */
    pause() {
      let released = false
      let waiting = 0
      const { promise: freed, resolve: letGo } = Promise.withResolvers<void>()
      const { promise: outcome, resolve: arrive, reject: miss } = Promise.withResolvers<Arrival<Record<string, unknown>>>()
      outcome.catch(() => {})

      const installation = begin((context) => {
        arrive({ locals: context.locals })
        if (released) return context.original()
        waiting += 1
        return freed.then(() => context.original())
      })

      // A test that awaits `reached` learns of a miss there; otherwise it learns when it ends.
      let missed: Error | undefined
      let observed = false
      let heldAtEnd: boolean | undefined
      const reached: PromiseLike<Arrival<Record<string, unknown>>> = Object.freeze({
        then<Fulfilled, Rejected>(
          onFulfilled?: ((arrival: Arrival<Record<string, unknown>>) => Fulfilled | PromiseLike<Fulfilled>) | null,
          onRejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
        ) {
          observed = true
          return outcome.then(onFulfilled, onRejected)
        },
      })
      const release = (): void => {
        released = true
        letGo()
      }
      registry.owed.add({
        settle() {
          heldAtEnd = waiting > 0 && !released
          release()
        },
        verdict: () =>
          heldAtEnd
            ? new Error(
                `[execution-points] "${installation.id}" was still paused when the test ended. Call release() on the pause.`,
              )
            : observed
              ? undefined
              : missed,
      })

      return Object.freeze({
        run<T>(action: () => T): T {
          const finished = (cause?: unknown): void => {
            if (installation.runs > 0) return
            missed = new Error(
              `[execution-points] The action finished without reaching "${installation.id}", so nothing was paused.`,
              { cause },
            )
            miss(missed)
          }
          let result: T
          try {
            result = scoped(installation, action)
          } catch (error) {
            finished(error)
            throw error
          }
          if (isThenable(result)) result.then(() => finished(), finished)
          else finished()
          return result
        },
        reached,
        release,
        get calls() {
          return installation.runs
        },
      })
    },
  })
  internals.set(handle, { begin, id: () => resolveSelection().id })
  return handle
}

// Taken before a test can install fake timers.
const nextTurn = setImmediate

/** Waits until two turns of the event loop in a row change nothing that `snapshot` reports. */
async function quiet(snapshot: () => string): Promise<void> {
  let last = snapshot()
  for (let still = 0; still < 2; ) {
    await new Promise<void>((resolve) => nextTurn(resolve))
    const now = snapshot()
    still = now === last ? still + 1 : 0
    last = now
  }
}

/**
 * What an order's `run` rejects with when its action fails; `cause` is what the action threw.
 * Narrow a caught value with `instanceof InterleavingFailure` to read `schedule`.
 */
export class InterleavingFailure extends Error {
  /** `interleavings(points, { schedule })` gives the failing order again. */
  readonly schedule: readonly number[]

  constructor(message: string, cause: unknown, schedule: readonly number[]) {
    super(message, { cause })
    this.name = 'InterleavingFailure'
    this.schedule = schedule
  }
}

/**
 * The orders in which operations can pass the selected expressions, one at a time:
 *
 *     for (const order of interleavings([read, write])) {
 *       reset()
 *       await order.run(() => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')]))
 *       expect(cachedName('u1')).toBe('Bob')
 *     }
 *
 * Each order runs an action once: every evaluation of a selected expression inside it is held,
 * and whenever all operations have finished or are held, one is released. Each order follows
 * from what the one before it found, so await `order.run` before taking the next. `schedule`
 * gives one order again; `choose` picks every order itself, for as long as the caller asks.
 */
export function interleavings(
  points: readonly Waitable[],
  { schedule, choose }: InterleavingOptions = {},
): Generator<Interleaving, void, undefined> {
  const reached = new Set<string>()

  // One order. `pick(step, count)` says which of the `count` held evaluations goes next.
  const begin = (pick: (step: number, count: number) => number) => {
    const choices: number[] = []
    const counts: number[] = []
    const released: string[] = []
    let state: 'ready' | 'running' | 'done' = 'ready'
    const order: Interleaving = {
      get schedule() {
        return [...choices]
      },
      get released() {
        return [...released]
      },
      async run<Result>(action: () => Result | PromiseLike<Result>): Promise<Result> {
        if (state !== 'ready') {
          throw new Error('[execution-points] An order runs once. Take the next order from interleavings() to run the action again.')
        }
        state = 'running'
        const held: Array<{ readonly id: string; readonly go: () => void }> = []
        const replacements = new Map(registry.storage.getStore() ?? [])
        for (const point of points) {
          const installation = internals.get(point)!.begin((context) => {
            reached.add(installation.id)
            return new Promise<void>((go) => {
              held.push({ id: installation.id, go })
            }).then(() => context.original())
          })
          replacements.set(installation.id, installation)
        }

        let outcome: { readonly value: Result } | { readonly error: unknown } | undefined
        Promise.resolve()
          .then(() => registry.storage.run(replacements, action))
          .then(
            (value) => {
              outcome = { value }
            },
            (error: unknown) => {
              outcome = { error }
            },
          )
        for (;;) {
          await quiet(() => `${held.length} ${released.length}`)
          if (outcome) break
          if (held.length === 0) {
            outcome = {
              error: new Error(
                '[execution-points] The run neither finished nor reached a selected expression. It may be waiting on a timer or on I/O, which the search cannot order.',
              ),
            }
            break
          }
          const choice = pick(choices.length, held.length)
          if (!(Number.isInteger(choice) && choice >= 0 && choice < held.length)) {
            throw new TypeError(
              `[execution-points] There is no valid choice for step ${choices.length + 1}: ${held.length} evaluations were held, and the choice was ${choice}.`,
            )
          }
          counts.push(held.length)
          choices.push(choice)
          const [next] = held.splice(choice, 1)
          released.push(next!.id)
          next!.go()
        }
        state = 'done'
        if ('error' in outcome) {
          const failed = outcome.error
          throw new InterleavingFailure(
            (released.length
              ? `[execution-points] The scenario failed in this order:\n` +
                released.map((id, position) => `  ${position + 1}. ${id}`).join('\n') +
                `\nReplay it with interleavings(points, { schedule: ${JSON.stringify(choices)} }).`
              : '[execution-points] The scenario failed before any selected expression was released.') +
              `\nIt failed with: ${(failed as { message?: unknown } | null | undefined)?.message ?? failed}`,
            failed,
            [...choices],
          )
        }
        if (schedule && choices.length !== schedule.length) {
          throw new TypeError(`[execution-points] The schedule has ${schedule.length} choices, but the run made ${choices.length}.`)
        }
        return outcome.value
      },
    }
    return { order, choices, counts, ran: () => state === 'done' }
  }

  // Hands out one order and insists that it ran before the walk goes on.
  function* one(pick: (step: number, count: number) => number) {
    const taken = begin(pick)
    yield taken.order
    if (!taken.ran()) {
      throw new Error(
        '[execution-points] The order before this one has not run to its end. Await order.run(action) before taking the next order.',
      )
    }
    return taken
  }

  return (function* walk(): Generator<Interleaving, void, undefined> {
    if (schedule) {
      yield* one((step) => schedule[step]!)
    } else if (choose) {
      for (let run = 0; ; run += 1) yield* one((step, count) => choose(step, count, run))
    } else {
      // Depth first: repeat the choices up to the last one that has an untried alternative.
      for (let prefix: readonly number[] | undefined = []; prefix; ) {
        const { choices, counts } = yield* one((step) => prefix![step] ?? 0)
        const turn = choices.findLastIndex((choice, step) => choice + 1 < counts[step]!)
        prefix = turn === -1 ? undefined : [...choices.slice(0, turn), choices[turn]! + 1]
      }
    }
    const unreached = points.map((point) => internals.get(point)!.id()).filter((id) => !reached.has(id))
    if (unreached.length) {
      throw new Error(
        `[execution-points] No run reached ${unreached.map((id) => `"${id}"`).join(', ')}. Every selected expression must be evaluated by the scenario.`,
      )
    }
  })()
}

/** A node as the visitor of `select` receives it when the code runs. */
type VisitedNode = RegisteredNode & { capture(...keys: string[]): Selection }

function makeVisitorNode(descriptor: RegisteredNode): VisitedNode {
  return Object.freeze({
    ...descriptor,
    capture(...keys: string[]): Selection {
      return Object.freeze({ __epSelected: true, id: descriptor.id, captureNames: keys })
    },
  })
}

/** What a traversal found, on its way outward through the handlers that return it. */
interface Found {
  readonly __epFound: readonly Selection[]
}

/** A visitor object when the code runs: a handler per node type. */
type Handlers = Readonly<Record<string, ((node: never) => unknown) | undefined>>

/**
 * Select an expression in `file`. The visitor is a callback that narrows the file's typed union
 * of expressions and returns the one it wants, or an object keyed by node type whose handlers
 * work their way inward with `traverse`.
 */
export function select<const File extends RegisteredTargetFile, R extends VisitorReturn>(
  file: File,
  // One signature for both forms, so that a mistake is reported in plain words and not as "no overload matches".
  visitor:
    | ((node: RegistryIsEmpty extends true ? any : VisitorNode<FileNodes<NoInfer<File>>>) => R)
    | Visitor<FileNodes<NoInfer<File>> | FileContainers<NoInfer<File>>, R>,
): SelectedPoint<R>
export function select(file: string, visitor: ((node: never) => unknown) | object): unknown {
  let cached: Selection | undefined
  const resolveNow = (): Selection => {
    if (cached) return cached
    const nodes = getFileNodes(file)
    const containers = registry.containers.get(file)!
    let strays = 0

    // What a handler returned for `node`: a selection of it, what a traversal found, or nothing of use.
    const selectedBy = (result: unknown, node: VisitedNode | undefined): readonly Selection[] => {
      if (!result) return []
      if (result === node) return [{ id: node.id, captureNames: [] }]
      const captured = result as Selection
      if (captured.__epSelected && captured.id === node?.id) return [{ id: captured.id, captureNames: captured.captureNames }]
      const found = (result as Found).__epFound
      if (found) return found
      strays += 1
      return []
    }

    // Calls each handler for every node of its type among `inside`: expressions first, then containers.
    const visit = (handlers: Handlers, expressions: Iterable<number>, inner: Iterable<number>): Selection[] => {
      const selected: Selection[] = []
      for (const index of expressions) {
        const descriptor = nodes[index]!
        const handler = handlers[descriptor.kind] as ((node: VisitedNode) => unknown) | undefined
        if (!handler) continue
        const node = makeVisitorNode(descriptor)
        selected.push(...selectedBy(handler(node), node))
      }
      for (const index of inner) {
        const { nodes: itsNodes, containers: itsContainers, ...described } = containers[index]!
        const handler = handlers[described.type] as ((node: object) => unknown) | undefined
        if (!handler) continue
        const container = Object.freeze({
          ...described,
          traverse(visitor: Handlers): Found | undefined {
            const found = visit(visitor, itsNodes, itsContainers)
            return found.length ? Object.freeze({ __epFound: found }) : undefined
          },
        })
        selected.push(...selectedBy(handler(container), undefined))
      }
      return selected
    }

    const selected =
      typeof visitor === 'function'
        ? nodes.flatMap((descriptor) => {
            const node = makeVisitorNode(descriptor)
            // The registry types the node per file. When the code runs, every file's nodes have one shape.
            return selectedBy((visitor as (node: VisitedNode) => unknown)(node), node)
          })
        : visit(visitor as Handlers, nodes.keys(), containers.keys())
    // An expression that several containers lead to is still one expression.
    const matches = [...new Map(selected.map((selection) => [JSON.stringify([selection.id, selection.captureNames]), selection])).values()]
    if (matches.length !== 1) {
      throw new Error(
        `[execution-points] Visitor for "${file}" must match exactly 1 expression; matched ${matches.length}.` +
          (strays > 0
            ? ` For ${strays} of the file's nodes it returned something that is not the node: return the node it was given, node.capture(...), what node.traverse(...) returned, or nothing.`
            : ''),
      )
    }
    cached = matches[0]!
    return cached
  }

  // Eagerly resolve when the target module is already loaded so invalid visitors fail fast.
  if (registry.files.has(file)) resolveNow()
  return createPointHandle(file, resolveNow)
}

/**
 * Called by instrumented target code before evaluating a selectable expression, once a
 * replacement has been installed for an expression of its home. Application code does not
 * call this.
 */
export function invoke<Result>(id: string, originalThunk: () => Result, captureThunk: () => Readonly<Record<string, unknown>>): Result {
  const active = registry.storage.getStore()?.get(id) ?? registry.everywhere.get(id)?.at(-1)
  if (!active) return originalThunk()

  const call = (active.evaluations += 1)
  if (active.turns && !active.turns.includes(call)) return originalThunk()
  active.runs += 1
  registry.calls.set(id, (registry.calls.get(id) ?? 0) + 1)

  const getters = captureThunk()
  const locals = Object.create(null) as Record<string, unknown>
  for (const key of active.captureNames) {
    if (!Object.hasOwn(getters, key)) {
      const problem = new Error(
        `[execution-points] "${key}" is not a local that "${id}" can capture. ` +
          `It can capture: ${Object.keys(getters).join(', ') || 'nothing'}.`,
      )
      registry.problems.push(problem)
      throw problem
    }
    const getter = getters[key]
    locals[key] = typeof getter === 'function' ? (getter as () => unknown)() : getter
  }
  Object.freeze(locals)
  // The registry typed the handler against this expression, so its result is the expression's.
  return active.handler(Object.freeze({ locals, original: originalThunk, call })) as Result
}
