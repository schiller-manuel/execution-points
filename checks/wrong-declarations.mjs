// Wrong type declarations, written by hand: the gap check changes JavaScript and never a
// declaration, so nothing else asks whether the type oracles would notice a `returns` that takes
// anything or a `times` that takes any word.
//
//   pnpm build && node checks/wrong-declarations.mjs            every wrong declaration
//   pnpm build && node checks/wrong-declarations.mjs 'times|on' those whose description matches
//
// Each one is applied to the built `dist/runtime.d.mts`, the gap check's baseline is run with the
// three type oracles (and the listing's oracle, which owns the one source file a run has to
// name), and the file is put back. A wrong declaration that every oracle file accepts is a gap in
// the oracles: the script lists it and exits with 1. While it runs, `dist/` is not what the
// sources say, and a `vitest.point.config.mjs` stands in the repository root; both are restored
// at the end, also when it is interrupted by an error.
//
// The wrong implementations of the runtime, discovery and the plugin are in
// `checks/wrong-versions/`, in the gap check's own format:
//
//   pnpm exec oracle-gaps --package . --source src/runtime.ts,src/discovery.ts,src/plugin.ts,src/contracts.ts \
//     --seed 42 --mutants checks/wrong-versions --only authored:live-getters,authored:frozen-clones,…
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
/** Run only the wrong declarations whose description matches this, when given. */
const wanted = process.argv[2] ? new RegExp(process.argv[2]) : /./
const declarations = join(repo, 'dist/runtime.d.mts')
const config = join(repo, 'vitest.point.config.mjs')
const original = readFileSync(declarations, 'utf8')

/** The locals a point has from the captures made in its visitor, as the build writes the type. */
const CAPTURED_LOCALS = `type ExtractCapturedLocals<R> = ExtractNode<R> extends (infer N extends NodeDescriptor) ? { [K in CapturedNames<CleanReturn<R>> & keyof N['locals']]: N['locals'][K]; } : never;`

// [what is wrong, the law that owes a rejection, the text to replace (it must occur once), its replacement]
const mutants = [
  // values
  ['returns takes anything', 'values', `returns(value: HandlerResult<Result>, options`, `returns(value: unknown, options`],
  ['resolves takes anything', 'values', `(value: Awaited<Result>, options?: ReplacementOptions) => Replacement`, `(value: unknown, options?: ReplacementOptions) => Replacement`],
  ['resolves takes the promise itself', 'values', `(value: Awaited<Result>, options?: ReplacementOptions) => Replacement`, `(value: Result, options?: ReplacementOptions) => Replacement`],
  ['throws takes only an Error', 'values', `throws(error: unknown, options`, `throws(error: Error, options`],
  ['a replace handler may return anything', 'values', `replace(handler: (context: Context<Result, Locals>) => HandlerResult<Result>, options`, `replace(handler: (context: Context<Result, Locals>) => unknown, options`],
  ['a withReplacement handler may return anything', 'values', `withReplacement<T>(handler: (context: Context<Result, Locals>) => HandlerResult<Result>, action`, `withReplacement<T>(handler: (context: Context<Result, Locals>) => unknown, action`],
  // waiting
  ['every expression can wait', 'waiting', `[Result] extends [PromiseLike<unknown>] ? Yes : No`, `[Result] extends [PromiseLike<unknown>] ? Yes : Yes`],
  ['no expression can wait', 'waiting', `[Result] extends [PromiseLike<unknown>] ? Yes : No`, `[Result] extends [PromiseLike<unknown>] ? No : No`],
  ['the refusal gives another reason', 'waiting', 'needs an expression whose value is a promise.`', 'is not available here.`'],
  ['the refusal is a bare string again', 'waiting', `{\n    readonly __unavailable: OnlyForPromises<'pause'>;\n  }`, `OnlyForPromises<'pause'>`],
  ['interleavings takes any object that can pause', 'waiting', `export interface Waitable {\n  readonly [selectedBy]: 'select';`, `export interface Waitable {`],
  ['interleavings takes a point that cannot pause', 'waiting', `pause(): Pause<object>;`, `pause: unknown;`],
  // options
  ['times takes any word', 'options', `readonly times?: number | 'any';`, `readonly times?: number | string;`],
  ['times takes no word', 'options', `readonly times?: number | 'any';`, `readonly times?: number;`],
  ['on takes any list', 'options', `readonly on?: number | readonly number[];`, `readonly on?: number | readonly unknown[];`],
  ['on takes only a list', 'options', `readonly on?: number | readonly number[];`, `readonly on?: readonly number[];`],
  ['a replacement takes any option', 'options', `export interface ReplacementOptions {`, `export interface ReplacementOptions {\n  readonly [key: string]: unknown;`],
  ['schedule takes any list', 'options', `readonly schedule?: readonly number[];`, `readonly schedule?: readonly unknown[];`],
  ['choose may give anything', 'options', `readonly choose?: (step: number, count: number, run: number) => number;`, `readonly choose?: (step: number, count: number, run: number) => unknown;`],
  // results
  ['withReplacement gives anything back', 'results', `action: () => T, options?: ReplacementOptions): T;`, `action: () => T, options?: ReplacementOptions): any;`],
  ['pause().run gives anything back', 'results', `run<T>(action: () => T): T;`, `run<T>(action: () => T): any;`],
  ['order.run resolves to anything', 'results', `PromiseLike<Result>): Promise<Result>;`, `PromiseLike<Result>): Promise<any>;`],
  ['order.run gives the value itself', 'results', `PromiseLike<Result>): Promise<Result>;`, `PromiseLike<Result>): Result;`],
  ['the released ids are numbers', 'results', `readonly released: readonly string[];`, `readonly released: readonly number[];`],
  ['the number of the evaluation is a string', 'results', `readonly call: number;`, `readonly call: string;`],
  ['a replacement cannot be disposed', 'results', `  /** \`using replacement = point.replace(handler)\` restores it at the end of the block. */\n  [Symbol.dispose](): void;\n`, ``],
  ['an arrival has any local', 'results', `export interface Arrival<Locals extends object> {\n  readonly locals: Readonly<Locals>;`, `export interface Arrival<Locals extends object> {\n  readonly locals: any;`],
  ['the count of a point is a string', 'results', `  readonly calls: number;\n}\nexport interface SelectablePoint`, `  readonly calls: string;\n}\nexport interface SelectablePoint`],
  // argument kinds
  ['pause().run takes a value', 'argument-kinds', `run<T>(action: () => T): T;`, `run<T>(action: T): T;`],
  ['replace takes anything as its handler', 'argument-kinds', `replace(handler: (context: Context<Result, Locals>) => HandlerResult<Result>, options`, `replace(handler: unknown, options`],
  ['interleavings takes one point', 'argument-kinds', `declare function interleavings(points: readonly Waitable[],`, `declare function interleavings(points: readonly Waitable[] | Waitable,`],
  ['interleavings takes any object', 'argument-kinds', `declare function interleavings(points: readonly Waitable[],`, `declare function interleavings(points: object,`],
  ['order.run takes a value', 'argument-kinds', `run<Result>(action: () => Result | PromiseLike<Result>): Promise<Result>;`, `run<Result>(action: Result | PromiseLike<Result>): Promise<Result>;`],
  // what a visitor is handed, and what a point captures when several ways lead to its expression
  ['a capture counts only when every way captures', 'visitor', CAPTURED_LOCALS, `type ExtractCapturedLocals<R> = CleanReturn<R> extends CapturedSelection<infer N, infer Keys> ? { [K in Keys[number] & keyof N['locals']]: N['locals'][K]; } : {};`],
  ['a point has every local of its expression, captured or not', 'visitor', CAPTURED_LOCALS, `type ExtractCapturedLocals<R> = ExtractNode<R>['locals'];`],
  ['no capture made in a visitor reaches the point', 'visitor', CAPTURED_LOCALS, `type ExtractCapturedLocals<R> = {};`],
  ['the error for a local that is not captured names a type and not the locals', 'visitor', CAPTURED_LOCALS, `type ExtractCapturedLocals<R> = { [K in CapturedNames<CleanReturn<R>> & keyof ExtractNode<R>['locals']]: ExtractNode<R>['locals'][K]; };`],
  ['an expression is handed with a line', 'visitor', `'__unportable' | '__unportableLocals'> & {\n  readonly __node: N;`, `'__unportable' | '__unportableLocals'> & {\n  readonly line: number;\n  readonly __node: N;`],
  ['an expression is handed with its text', 'visitor', `'__unportable' | '__unportableLocals'> & {\n  readonly __node: N;`, `'__unportable' | '__unportableLocals'> & {\n  readonly text: string;\n  readonly __node: N;`],
  ['a container is handed with a line', 'visitor', `{\n  readonly type: Type;\n}> & Traversable;`, `{\n  readonly type: Type;\n}> & Traversable & { readonly line: number };`],
  // the type-level wrong versions of the first review (FINDINGS.md, "What the gap check does not show")
  ['capture always types locals as {}', 'older law', `SelectablePoint<N, { [P in K]: N['locals'][P]; }>;`, `SelectablePoint<N, {}>;`],
  ['a context loses Readonly<> around its locals', 'older law', `readonly locals: Readonly<Locals>;\n  /** Evaluate`, `readonly locals: Locals;\n  /** Evaluate`],
  ['an arrival loses Readonly<> around its locals', 'older law', `export interface Arrival<Locals extends object> {\n  readonly locals: Readonly<Locals>;`, `export interface Arrival<Locals extends object> {\n  readonly locals: Locals;`],
  ['a handler on a void expression may be async', 'older law', `type HandlerResult<R> = 0 extends 1 & R ? R : [R] extends [void] ? ([void] extends [R] ? void | undefined : R) : R;`, `type HandlerResult<R> = R;`],
]

writeFileSync(
  config,
  `import base from './vitest.config.mjs'\n\nexport default { ...base, test: { ...base.test, include: ['tests/types*.oracle.property.test.ts', 'tests/cli.oracle.property.test.ts'] } }\n`,
)
const rows = []
try {
  for (const [intent, law, find, replace] of [['(unchanged)', '-', '', ''], ...mutants.filter(([intent]) => wanted.test(intent))]) {
    const finds = [find].flat().filter(Boolean)
    const replaces = [replace].flat()
    const counts = finds.map((each) => original.split(each).length - 1)
    if (counts.some((count) => count !== 1)) {
      rows.push({ intent, law, verdict: `NOT RUN: the text to replace occurs ${counts.join(', ')} times` })
      console.log(JSON.stringify(rows.at(-1)))
      continue
    }
    writeFileSync(declarations, finds.reduce((text, each, index) => text.replace(each, replaces[index]), original))
    const run = spawnSync(
      process.execPath,
      ['node_modules/@tanstack/oracles/oracle-gaps/index.mjs', '--package', '.', '--config', 'vitest.point.config.mjs', '--source', 'src/cli.ts', '--seed', '42', '--sample', '1'],
      { cwd: repo, encoding: 'utf8' },
    )
    const out = `${run.stdout}\n${run.stderr}`
    // The run prints its baseline twice: once as it goes, once in the summary.
    const fails = [...new Set([...out.matchAll(/baseline fail tests\/([\w-]+)\.oracle[^\n]*: (\d+) of (\d+) tests failed\n\s*failing: ` ([^`]*) `/g)].map((m) => `${m[1]}: ${m[2]} of ${m[3]}, first "${m[4]}"`))]
    const allPass = /baseline all \d+ oracle files pass/.test(out)
    rows.push({
      intent,
      law,
      verdict: fails.length ? `rejected by ${fails.join('; ')}` : allPass ? 'ACCEPTED: every oracle file passes' : `NO RESULT (exit ${run.status}): ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`,
    })
    console.log(JSON.stringify(rows.at(-1)))
  }
} finally {
  writeFileSync(declarations, original)
  rmSync(config, { force: true })
}
const tried = rows.filter((row) => row.law !== '-')
const accepted = tried.filter((row) => row.verdict.startsWith('ACCEPTED'))
const notRun = tried.filter((row) => row.verdict.startsWith('NO'))
console.log(
  `\n${tried.length} wrong declarations: ${tried.filter((row) => row.verdict.startsWith('rejected')).length} rejected, ${accepted.length} accepted, ${notRun.length} without a result`,
)
// The declarations as built must pass, and nothing wrong may.
const unchanged = rows.find((row) => row.law === '-')
process.exitCode = accepted.length || notRun.length || !unchanged?.verdict.startsWith('ACCEPTED') ? 1 : 0
