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
}

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
  withReplacement<T>(
    handler: (context: Context<Result, Locals>) => HandlerResult<Result>,
    action: () => T,
  ): T
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
