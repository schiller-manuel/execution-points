export interface Spec {
  readonly file: string
  readonly query: string
  readonly capture?: readonly string[]
}

export interface Contract {
  readonly result: unknown
  readonly locals: object
}

export interface PointError<Message extends string = string> {
  readonly __error: Message
}

/**
 * Augmented virtually by the TypeScript 7.1 content mapper (points.ep).
 * Maps target file path -> AST query -> contract (result + all in-scope locals) or PointError.
 */
export interface ExecutionPointRegistry {}

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

type RegistryEntry<File extends string, Query extends string> =
  File extends keyof ExecutionPointRegistry
    ? Query extends keyof ExecutionPointRegistry[File]
      ? ExecutionPointRegistry[File][Query]
      : never
    : never

type RegisteredFile =
  keyof ExecutionPointRegistry extends never
    ? string
    : (keyof ExecutionPointRegistry & string) | (string & {})

type RegisteredQuery<File extends string> =
  File extends keyof ExecutionPointRegistry
    ? (keyof ExecutionPointRegistry[File] & string) | (string & {})
    : string

type AvailableCapture<File extends string, Query extends string> =
  [RegistryEntry<File, Query>] extends [never]
    ? string
    : RegistryEntry<File, Query> extends PointError
      ? string
      : RegistryEntry<File, Query> extends Contract
        ? keyof RegistryEntry<File, Query>['locals'] & string
        : string

type UnregisteredSpecError<File extends string> = {
  readonly __executionPointError: `Execution point for "${File}" is not registered. Run TypeScript 7.1 with --runExternalCode (or enable js/ts.contentMappers.enabled in VS Code) and ensure this test file is included in points.ep.`
}

type SpecCheck<File extends string, Query extends string> =
  [RegistryEntry<File, Query>] extends [never]
    ? UnregisteredSpecError<File>
    : RegistryEntry<File, Query> extends PointError<infer Message>
      ? { readonly __executionPointError: Message }
      : {}

type ResolveContract<
  File extends string,
  Query extends string,
  Capture extends readonly string[],
> =
  [RegistryEntry<File, Query>] extends [never]
    ? { readonly result: never; readonly locals: Record<string, never> }
    : RegistryEntry<File, Query> extends Contract
      ? {
          readonly result: RegistryEntry<File, Query>['result']
          readonly locals: {
            readonly [K in Capture[number] & keyof RegistryEntry<File, Query>['locals']]:
              RegistryEntry<File, Query>['locals'][K]
          }
        }
      : { readonly result: never; readonly locals: Record<string, never> }

/**
 * Declare a typed execution point. Contracts are inferred natively via
 * TypeScript 7.1 content mappers (points.ep) into ExecutionPointRegistry.
 */
export declare function point<
  const File extends RegisteredFile,
  const Query extends RegisteredQuery<NoInfer<File>>,
  const Capture extends readonly AvailableCapture<NoInfer<File>, NoInfer<Query>>[] = readonly [],
>(
  spec: {
    readonly file: File
    readonly query: Query
    readonly capture?: Capture
  } & SpecCheck<NoInfer<File>, NoInfer<Query>>,
): Point<ResolveContract<File, Query, Capture>>

/** Internal transform entry point; application code does not call this. */
export declare function invoke<Result, Locals extends object>(
  id: string,
  originalThunk: () => Result,
  captureThunk: () => Locals,
): Result
