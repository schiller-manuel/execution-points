export interface Spec {
  readonly file: string
  readonly query: string
  readonly capture?: readonly string[]
}

export interface Contract {
  result: unknown
  locals: object
}

export interface Context<Result, Locals extends object> {
  /** Captured binding values. Referenced objects retain their normal mutability. */
  readonly locals: Readonly<Locals>
  /** Evaluate the original expression. Each call evaluates it again. */
  readonly original: () => Result
}

export interface Point<C extends Contract> {
  withReplacement<T>(
    handler: (context: Context<C['result'], C['locals']>) => C['result'],
    action: () => T,
  ): T
}

/**
 * The virtual compiler supplies the contract from the selected source
 * expression. Run the prototype's checker for contextual types in tests.
 */
export declare function point<
  C extends Contract = { result: never; locals: Record<string, never> },
>(spec: Spec): Point<C>

/** Internal transform entry point; application code does not call this. */
export declare function invoke<Result, Locals extends object>(
  id: string,
  originalThunk: () => Result,
  captureThunk: () => Locals,
): Result
