/// <reference lib="esnext.disposable" />

export interface NodeDescriptor {
  readonly id: string
  readonly kind: 'CallExpression' | 'BinaryExpression' | 'ConditionalExpression'
  readonly inFunction: string | null
  readonly nth: number
  readonly callee?: string
  readonly operator?: string
  readonly result: unknown
  readonly locals: object
}

/**
 * Augmented virtually by the TypeScript 7.1 content mapper (points.ep).
 * Maps each configured target file path to the discriminated union of its
 * selectable expressions (with inferred result and narrowed local types).
 */
export interface ExecutionPointFileRegistry {}

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

type OnlyForPromises<Method extends string> =
  `${Method}() needs an expression whose value is a promise.`

/** `Yes` when the expression's value is a promise (or `any`), `No` otherwise. */
type IfPromise<Result, Yes, No> = 0 extends 1 & Result ? Yes : [Result] extends [PromiseLike<unknown>] ? Yes : No

/**
 * Reject async handlers (returning Promise) on synchronous void expressions while
 * preserving `any`, `undefined`, `Promise<void>`, and `return original()`.
 */
type HandlerResult<R> =
  0 extends 1 & R
    ? R
    : [R] extends [void]
      ? [void] extends [R]
        ? void | undefined
        : R
      : R

export interface Point<Result, Locals extends object> {
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
  replace(
    handler: (context: Context<Result, Locals>) => HandlerResult<Result>,
    options?: ReplacementOptions,
  ): Replacement

  /** `replace` with a handler that returns `value`. */
  returns(value: HandlerResult<Result>, options?: ReplacementOptions): Replacement
  /** `replace` with a handler that throws `error`. */
  throws(error: unknown, options?: ReplacementOptions): Replacement
  /** `replace` with a handler that returns a promise fulfilled with `value`. */
  resolves: IfPromise<
    Result,
    (value: Awaited<Result>, options?: ReplacementOptions) => Replacement,
    OnlyForPromises<'resolves'>
  >
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

export interface SelectablePoint<N extends NodeDescriptor, Captured extends object = {}>
  extends Point<N['result'], Captured> {
  /** Explicitly capture one or more in-scope local bindings at this expression. */
  capture<K extends keyof N['locals'] & string = never>(
    ...keys: readonly K[]
  ): SelectablePoint<
    N,
    { readonly [P in K]: N['locals'][P] }
  >
}

export interface CapturedSelection<
  N extends NodeDescriptor,
  Keys extends readonly string[],
> {
  readonly __node: N
  readonly __capture: Keys
}

type VisitorNode<N extends NodeDescriptor> = N extends NodeDescriptor
  ? Omit<N, 'result' | 'locals' | '__unportable'> & {
      readonly __node: N
      capture<K extends keyof N['locals'] & string = never>(
        ...keys: readonly K[]
      ): CapturedSelection<N, readonly K[]>
    }
  : never

type RegistryIsEmpty = keyof ExecutionPointFileRegistry extends never ? true : false

type ExecutionPointsNotLoaded =
  'ExecutionPointFileRegistry is empty. Ensure points.ep is included in tsconfig.json with contentMappers enabled, run tsc with --runExternalCode (or in VS Code choose "TypeScript: Select TypeScript Version -> Use Workspace Version" with TypeScript 7.1), and verify the package is inside the open workspace (TS18124).'

type RegisteredTargetFile =
  RegistryIsEmpty extends true
    ? ExecutionPointsNotLoaded
    : keyof ExecutionPointFileRegistry & string

type FileNodes<File extends string> =
  File extends keyof ExecutionPointFileRegistry
    ? Extract<ExecutionPointFileRegistry[File], NodeDescriptor>
    : never

type IsUnion<T, Copy = T> = [T] extends [never]
  ? false
  : T extends unknown
    ? [Copy] extends [T]
      ? false
      : true
    : never

type CleanReturn<R> = Exclude<R, undefined | void | null | false>

type ExtractNode<R> =
  CleanReturn<R> extends infer Item
    ? Item extends { readonly __node: infer N extends NodeDescriptor }
      ? N
      : never
    : never

type ExtractCapturedLocals<R> =
  CleanReturn<R> extends CapturedSelection<infer N, infer Keys>
    ? { readonly [K in Keys[number] & keyof N['locals']]: N['locals'][K] }
    : {}

type SelectFromNodes<N extends NodeDescriptor, Captured extends object> =
  [N] extends [never]
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

export interface InterleavingOptions<Result> {
  /** The expressions at which operations can be made to wait. Each must evaluate to a promise. */
  readonly points: readonly { pause(): Pause<any> }[]
  /** Starts the operations. It runs once per order, so it must start from the same state each time. */
  readonly run: () => Result | PromiseLike<Result>
  /** Judges one run. Throwing stops the search and reports the order that failed. */
  readonly check?: (result: Awaited<Result>) => void | PromiseLike<void>
  /** Runs before every run, to put the state back. */
  readonly setup?: () => void | PromiseLike<void>
  /** The most runs to make. Default 1000. */
  readonly limit?: number
  /** Replays one order: the `schedule` of an earlier failure. */
  readonly schedule?: readonly number[]
  /**
   * Picks the orders instead of walking all of them: called with the step within the run, the
   * number of evaluations held at that step (in the order they arrived), and the run's number,
   * it returns the index of the one to release. `limit` runs are made.
   */
  readonly choose?: (step: number, count: number, run: number) => number
}

export interface InterleavingReport {
  /** How many orders ran. */
  readonly schedules: number
  /** Whether that was every order. */
  readonly complete: boolean
}

/**
 * What `interleavings` throws when a run fails; `cause` is what the run or `check` threw.
 * Narrow a caught value with `instanceof InterleavingFailure` to read `schedule`.
 */
export declare class InterleavingFailure extends Error {
  private constructor()
  /** Pass it back as `schedule` to replay the failing order. */
  readonly schedule: readonly number[]
}

/**
 * Runs `run` once for every order in which its operations can pass the selected expressions,
 * and judges each run with `check`. Every evaluation of a selected expression inside `run` is
 * held; whenever all operations have finished or are held, one is released.
 */
export declare function interleavings<Result>(options: InterleavingOptions<Result>): Promise<InterleavingReport>

/**
 * Checks what the current test's replacements still owe (asynchronous actions, replacements
 * that were not restored, pauses) and throws what went wrong. The Vite plugin's Vitest setup
 * calls it after each test; call it yourself under another runner.
 */
export declare function verifyReplacements(): void

type SelectedPoint<R> =
  RegistryIsEmpty extends true
    ? EmptyRegistryPoint
    : SelectFromNodes<ExtractNode<R>, ExtractCapturedLocals<R>>

type VisitorReturn =
  | { readonly __node: NodeDescriptor }
  | CapturedSelection<NodeDescriptor, readonly string[]>
  | undefined
  | void
  | false
  | null

/**
 * Select an expression in `file` using ordinary TypeScript control-flow narrowing
 * over the file's typed AST node union.
 */
export declare function select<
  const File extends RegisteredTargetFile,
  R extends VisitorReturn,
>(
  file: File,
  visitor: (node: RegistryIsEmpty extends true ? any : VisitorNode<FileNodes<NoInfer<File>>>) => R,
): SelectedPoint<R>

/** Internal transform entry points; application code does not call these. */
export declare function registerFile(
  file: string,
  nodes: readonly Omit<NodeDescriptor, 'result' | 'locals'>[],
  homes?: readonly number[],
): ReadonlyArray<{ readonly on: boolean }>

export declare function invoke<Result, Locals extends object>(
  id: string,
  originalThunk: () => Result,
  captureThunk: () => Record<keyof Locals, () => unknown>,
): Result
