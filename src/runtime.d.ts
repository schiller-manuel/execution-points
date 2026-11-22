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

export interface Point<Result, Locals extends object> {
  withReplacement<T>(
    handler: (context: Context<Result, Locals>) => Result,
    action: () => T,
  ): T
}

export interface SelectablePoint<N extends NodeDescriptor, Captured extends object = {}>
  extends Point<N['result'], Captured> {
  /** Explicitly capture one or more in-scope local bindings at this expression. */
  capture<K extends keyof N['locals'] & string>(
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
  ? Omit<N, 'result' | 'locals'> & {
      readonly __node: N
      capture<K extends keyof N['locals'] & string>(
        ...keys: readonly K[]
      ): CapturedSelection<N, readonly K[]>
    }
  : never

type RegisteredTargetFile =
  keyof ExecutionPointFileRegistry extends never
    ? string
    : keyof ExecutionPointFileRegistry & string

type FileNodes<File extends string> =
  File extends keyof ExecutionPointFileRegistry
    ? ExecutionPointFileRegistry[File] & NodeDescriptor
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

type SelectedPoint<R> =
  [ExtractNode<R>] extends [never]
    ? {
        readonly __selectionError: 'Visitor matched 0 expressions. Return a matching node from the callback.'
      }
    : IsUnion<ExtractNode<R>> extends true
      ? {
          readonly __selectionError: 'Visitor matched multiple expressions. Narrow further by inFunction, kind, callee/operator, or nth.'
        }
      : SelectablePoint<ExtractNode<R>, ExtractCapturedLocals<R>>

type NthParam<Matching extends NodeDescriptor, Nth extends number> =
  IsUnion<Matching['nth']> extends true
    ? [nth: Nth]
    : [nth?: Nth]

export interface ScopeNavigator<Nodes extends NodeDescriptor> {
  call<
    const Callee extends Extract<Nodes, { kind: 'CallExpression' }>['callee'] & string,
    const Nth extends Extract<Nodes, { kind: 'CallExpression'; callee: Callee }>['nth'] = 0,
  >(
    callee: Callee,
    ...nth: NthParam<Extract<Nodes, { kind: 'CallExpression'; callee: Callee }>, Nth>
  ): SelectablePoint<Extract<Nodes, { kind: 'CallExpression'; callee: Callee; nth: Nth }>>

  binary<
    const Operator extends Extract<Nodes, { kind: 'BinaryExpression' }>['operator'] & string,
    const Nth extends Extract<Nodes, { kind: 'BinaryExpression'; operator: Operator }>['nth'] = 0,
  >(
    operator: Operator,
    ...nth: NthParam<Extract<Nodes, { kind: 'BinaryExpression'; operator: Operator }>, Nth>
  ): SelectablePoint<Extract<Nodes, { kind: 'BinaryExpression'; operator: Operator; nth: Nth }>>

  conditional<
    const Nth extends Extract<Nodes, { kind: 'ConditionalExpression' }>['nth'] = 0,
  >(
    ...nth: NthParam<Extract<Nodes, { kind: 'ConditionalExpression' }>, Nth>
  ): SelectablePoint<Extract<Nodes, { kind: 'ConditionalExpression'; nth: Nth }>>
}

export interface FileNavigator<Nodes extends NodeDescriptor> extends ScopeNavigator<Nodes> {
  fn<const Name extends Exclude<Nodes['inFunction'], null>>(
    name: Name,
  ): ScopeNavigator<Extract<Nodes, { inFunction: Name }>>

  topLevel(): ScopeNavigator<Extract<Nodes, { inFunction: null }>>
}

type VisitorReturn =
  | { readonly __node: NodeDescriptor }
  | CapturedSelection<NodeDescriptor, readonly string[]>
  | undefined
  | void

/**
 * Option A — Imperative narrowing visitor.
 * Select an expression in `file` using ordinary TypeScript control-flow narrowing
 * over the file's typed AST node union.
 */
export declare function select<
  const File extends RegisteredTargetFile,
  R extends VisitorReturn,
>(
  file: File,
  visitor: (node: VisitorNode<FileNodes<NoInfer<File>>>) => R,
): SelectedPoint<R>

/**
 * Option B — Typed fluent navigator.
 * Navigate a file's functions and expressions with full autocomplete at every step.
 */
export declare function fromFile<
  const File extends RegisteredTargetFile,
  ResultPoint extends Point<any, any>,
>(
  file: File,
  navigate: (file: FileNavigator<FileNodes<NoInfer<File>>>) => ResultPoint,
): ResultPoint

/** Internal transform entry points; application code does not call these. */
export declare function registerFile(
  file: string,
  nodes: readonly Omit<NodeDescriptor, 'result' | 'locals'>[],
): void

export declare function invoke<Result, Locals extends object>(
  id: string,
  originalThunk: () => Result,
  captureThunk: () => Record<keyof Locals, () => unknown>,
): Result
