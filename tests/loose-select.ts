/**
 * `select` for a file that exists only inside a test.
 *
 * `select` is typed by the registry that the content mapper generates for the targets listed in
 * `points.ep`: the file must be one of them, and the visitor sees that file's own nodes. A driver
 * that registers a file by hand has no entry there. This is the same function with the types a
 * hand-registered file can have: any file name, a node with the descriptor's fields, and a point
 * whose handler says what it expects.
 */
import { select as registrySelect } from '../src/runtime.ts'

export interface LooseNode {
  readonly id: string
  readonly kind: string
  readonly inFunction: string | null
  readonly nth: number
  readonly callee?: string
  readonly operator?: string
  capture(...names: Array<string>): LooseNode
}

export interface LooseContext {
  readonly locals: Readonly<Record<string, unknown>>
  readonly call: number
  original<Result = unknown>(): Result
}

export interface LooseOptions {
  readonly times?: number | 'any'
  readonly on?: number | ReadonlyArray<number>
}

export interface LoosePoint {
  capture(...names: Array<string>): LoosePoint
  withReplacement<Result>(handler: (context: LooseContext) => unknown, action: () => Result, options?: LooseOptions): Result
}

export const select = registrySelect as unknown as (file: string, visitor: (node: LooseNode) => unknown) => LoosePoint
