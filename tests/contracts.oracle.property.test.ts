/**
 * This oracle owns the types that `generateFileRegistryModule` writes into the
 * virtual `ExecutionPointFileRegistry`, checked on what TypeScript says about
 * that registry once it is compiled as `.ts` beside `points.ep`. It owns
 * `src/contracts.ts`.
 *
 * ```ts
 * generateFileRegistryModule(plan, { fromFile, api, cache })
 * // → `text` that compiles beside the targets with no diagnostics of its own
 * // → each node's `result` and `locals` mutually assignable with TypeScript's type for the original expression
 * // → a type the project can name is that very type; a private one is a copy, branded when it is nominal
 * // → one node for every expression of the plan; one whose type cannot be written has `__unportable` and an opaque `result`
 * // → the same `text` from a warm `cache` as from none, after any edits to the project's files
 * ```
 *
 * `statSync(p)` has the type `Stats`. Written into the registry as `Stats`,
 * the name means nothing there and `tsc` fails for the whole project;
 * written as `Context` for `vm.createContext()`, it compiles and means the
 * library's own `Context<Result, Locals>`. What does a type's name have to
 * be so that it means, in the registry, what it means in the target?
 *
 * Four parts decide the answer. The **name** is what TypeScript itself writes
 * for a type from the registry's place (`import("node:fs").Stats`,
 * `NodeJS.Timeout`, `import("./src/status").Status.Ok`), kept only when it
 * resolves there to the same declaration. The **copy** stands in for a type no
 * name reaches: an export-anchored path such as `ReturnType<typeof
 * import("./src/app").work>` when one exists, otherwise a structural `__EP_*`
 * helper, which carries a `unique symbol` brand when the type is nominal. The
 * **probe** reads each local's control-flow-narrowed type at the expression.
 * The **warm program** is the cached TypeScript program a later call reuses.
 *
 * For every target whose expressions and locals have types the project can
 * name, the registry compiled as `.ts` beside the target has no diagnostics of
 * its own, and each node's `result` and `locals` are mutually assignable with
 * the type TypeScript gives the original expression (Decision by Manuel
 * Schiller (GitHub schiller-manuel), 2026-11-24). The same holds for every
 * primitive, literal, `any`, union, intersection, function, tuple, and object
 * type, with its `readonly`, `?`, and `...` modifiers kept (`README.md:172`;
 * Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22), and for
 * every local narrowed by an `if` guard, a type predicate, or an `asserts`
 * call before the expression (`README.md:40`).
 *
 * For every type the project can name (exported, export-reachable, global, or
 * declared by an ambient module or a package) the registry declares that very
 * type; for every other module-scope type it declares a structural copy, and
 * a branded copy when the type is an enum or a class with private members
 * (`README.md:172`; Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24: a name must mean in the registry what it means in the target).
 *
 * For every plan, the registry lists exactly the module files with selectable
 * expressions and one node per expression, with the descriptor fields of the
 * plan. An expression whose type cannot be written keeps its node, its
 * locals, and the reason in `__unportable`, and its `result` is an opaque
 * type of its own that only `original()` can produce; a local whose type
 * cannot be written is named with the reason (Decision by Manuel Schiller
 * (GitHub schiller-manuel), 2026-11-24). For every sequence of edits to targets and to the files they
 * import, the registry from a warm cache equals the registry from none
 * (Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24).
 *
 * The models never read the registry's text. `tests/registry-harness.ts`
 * compiles it and returns TypeScript's verdicts: the diagnostics inside the
 * registry, and for each node whether its declared type is the same type as
 * the original expression's, mutually assignable with it, or neither. The
 * expected verdict comes from how the history's source declares the type.
 *
 * Assignability does not see `readonly` or `?` on members, so the harness
 * compares those separately, for types the project declares and three levels
 * deep. A local's original type is read from a reference inside the
 * expression; a local the expression does not mention has its declared type.
 * A file created where an import did not resolve is seen at the next edit of
 * a file the warm program already holds.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { API, type Snapshot } from 'typescript/sync'
import { afterAll } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { type RegistryCache, generateFileRegistryModule } from '../src/contracts.ts'
import { type TargetPlan, buildTargetPlan } from '../src/discovery.ts'
import {
  ABSENT,
  type Fit,
  type RegistryReading,
  compileRegistry,
  createProject,
  generateAndCompile,
  removeProject,
  repoRoot,
} from './registry-harness'

const api = new API({ cwd: repoRoot })
afterAll(() => {
  api.close()
})

type Observation = { checkpoint: string; value: unknown }

/** A project on disk and the targets its manifest would list. */
interface ProjectHistory {
  name: string
  states: ReadonlyArray<string>
  files: Readonly<Record<string, string>>
  targets?: ReadonlyArray<string>
  compilerOptions?: Readonly<Record<string, unknown>>
}

/** What the plan says about one expression: an input of the generator. */
interface PlannedNode {
  id: string
  kind: string
  inFunction: string | null
  nth: number
  callee: string | null
  operator: string | null
  captures: Array<string>
}

const plannedNodes = (plan: TargetPlan): Array<PlannedNode> =>
  plan.files.flatMap((entry) =>
    entry.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      inFunction: node.inFunction,
      nth: node.nth,
      callee: node.callee ?? null,
      operator: node.operator ?? null,
      captures: [...node.captures],
    })),
  )

const planOf = (trace: ReadonlyArray<Observation>) =>
  (trace.find((entry) => entry.checkpoint === 'plan')?.value ?? []) as Array<PlannedNode>

/** 'fits' when TypeScript finds the two types the same or mutually assignable with equal modifiers. */
const fitsOf = (fit: Fit | null) => (fit === 'same' || fit === 'equivalent' ? 'fits' : fit)

/**
 * Run one project through production and the compiler. The plan is recorded
 * first: it is the generator's input, and the models read it from the trace.
 */
function driveProject(
  history: ProjectHistory,
  observe: (checkpoint: string, value: unknown) => void,
  view: (reading: RegistryReading, relations: Array<boolean>) => unknown,
  relations: ReadonlyArray<readonly [from: string, to: string]> = [],
) {
  for (const state of history.states) observe('reach', state)
  const root = createProject(history.files, history.compilerOptions)
  try {
    const compiled = generateAndCompile(api, root, history.targets ?? ['src/app.ts'], { relations })
    observe('plan', plannedNodes(compiled.plan))
    observe('registry', view(compiled.reading, compiled.relations))
  } catch (error) {
    observe('crash', error instanceof Error ? error.message : String(error))
  } finally {
    removeProject(root)
  }
}

/**
 * Fixtures share a project where they can. Each fixture is written as a
 * project of its own, with the target `src/app.ts`; fixtures with the same
 * compiler options become the modules of one project, each file under its
 * fixture's name. One TypeScript program then serves them all, and the
 * registry holds several files, as a real one does.
 */
function combine<Fixture extends ProjectHistory>(
  fixtures: ReadonlyArray<Fixture>,
): Array<ProjectHistory & { fixtures: Readonly<Record<string, Fixture>> }> {
  const groups = new Map<string, ProjectHistory & { fixtures: Record<string, Fixture> }>()
  for (const fixture of fixtures) {
    const options = fixture.compilerOptions ?? {}
    const name =
      Object.entries(options)
        .map(([option, value]) => `${option}=${[value].flat().join('+')}`)
        .join(',') || 'default-options'
    const group =
      groups.get(name) ??
      ({ name, states: [], files: {}, targets: [], compilerOptions: options, fixtures: {} } as ProjectHistory & {
        fixtures: Record<string, Fixture>
      })
    groups.set(name, group)
    const targets = fixture.targets ?? ['src/app.ts']
    const files = group.files as Record<string, string>
    for (const [file, text] of Object.entries(fixture.files)) {
      if (targets.includes(file)) {
        const renamed = `src/${fixture.name}${file.slice(file.lastIndexOf('.'))}`
        files[renamed] = text
        ;(group.targets as Array<string>).push(renamed)
        group.fixtures[renamed] = fixture
      } else {
        files[file.startsWith('src/') ? `src/${fixture.name}.${file.slice(4)}` : file] = text
      }
    }
    group.states = [...new Set([...group.states, ...fixture.states])]
  }
  return [...groups.values()]
}

/** The first node of one fixture's module in a registry view. */
const nodeOf = (nodes: Record<string, unknown>, fixture: string, containing = '') =>
  Object.keys(nodes).find((id) => id.startsWith(`src/${fixture}.`) && id.includes(containing))!

const judge =
  (law: string) =>
  <History>(_history: History, observations: ReadonlyArray<Observation>, expected: unknown) => {
    const crash = observations.find((entry) => entry.checkpoint === 'crash')
    if (crash) return differs('crash', law, crash.value, 'no crash') ?? pass
    return differs('registry', law, observations.find((entry) => entry.checkpoint === 'registry')?.value, expected) ?? pass
  }

/** Changes the registry that was observed. `Value` is the part of that observation the change reads. */
const corruptRegistry =
  <Value = Record<string, unknown>>(change: (value: Value) => unknown) =>
  (trace: ReadonlyArray<Observation>) =>
    trace.map((entry) =>
      entry.checkpoint === 'registry' ? { ...entry, value: change(structuredClone(entry.value) as Value) } : entry,
    )

// ---------------------------------------------------------------------------
// The fit of every node: the view and the model that Law 1 and the two older
// type laws share. Each node must be typed, its result and every local the
// plan offers must fit, and the registry must compile.
// ---------------------------------------------------------------------------

const fitView = (reading: RegistryReading) => ({
  registryErrors: reading.registryErrors,
  projectErrors: reading.projectErrors,
  nodes: Object.fromEntries(
    Object.entries(reading.nodes).map(([id, node]) => [
      id,
      {
        unportable: node.unportable,
        result: fitsOf(node.result),
        locals: Object.fromEntries(Object.entries(node.locals).map(([name, fit]) => [name, fitsOf(fit)])),
        unportableLocals: node.unportableLocals,
      },
    ]),
  ),
})

type FitView = ReturnType<typeof fitView>

const fitModel = <History>(_history: History, trace: ReadonlyArray<Observation>) => ({
  registryErrors: [],
  projectErrors: [],
  nodes: Object.fromEntries(
    planOf(trace).map((node) => [
      node.id,
      {
        unportable: null,
        result: 'fits',
        locals: Object.fromEntries(node.captures.map((name) => [name, 'fits'])),
        unportableLocals: {},
      },
    ]),
  ),
})

// ---------------------------------------------------------------------------
// Law 1: a registry that compiles, with every node typed as its expression
// ---------------------------------------------------------------------------

/** Everyday Node calls whose result type an ambient `declare module` block declares. */
const NODE_CALLS: ReadonlyArray<readonly [module: string, call: string]> = [
  ['node:fs', "statSync('x')"],
  ['node:fs', "readFileSync('x')"],
  ['node:fs', "readFileSync('x', 'utf8')"],
  ['node:fs', "createReadStream('x')"],
  ['node:fs', "readdirSync('x', { withFileTypes: true })"],
  ['node:fs', "watch('x')"],
  ['node:fs/promises', "open('x')"],
  ['node:fs/promises', "stat('x')"],
  ['node:fs/promises', "readFile('x', 'utf8')"],
  ['node:path', "parse('x')"],
  ['node:path', "join('a', 'b')"],
  ['node:url', "pathToFileURL('x')"],
  ['node:url', "parse('x')"],
  ['node:os', 'cpus()'],
  ['node:os', 'networkInterfaces()'],
  ['node:child_process', "spawn('ls')"],
  ['node:child_process', "execSync('ls')"],
  ['node:crypto', "createHash('sha256')"],
  ['node:crypto', 'randomUUID()'],
  ['node:crypto', "createHmac('sha256', 'k')"],
  ['node:http', 'createServer()'],
  ['node:http', "request('http://x')"],
  ['node:net', 'connect(80)'],
  ['node:zlib', 'createGzip()'],
  ['node:stream', 'Readable.from([1])'],
  ['node:events', "once(process, 'exit')"],
  ['node:readline', 'createInterface({ input: process.stdin })'],
  ['node:worker_threads', 'receiveMessageOnPort(null as any)'],
  ['node:perf_hooks', 'performance.now()'],
  ['node:perf_hooks', "performance.mark('x')"],
  ['node:timers/promises', 'setTimeout(1)'],
  ['node:util', 'inspect({})'],
  ['node:util', 'parseArgs()'],
  ['node:dns/promises', "lookup('x')"],
  ['node:querystring', "parse('a=1')"],
  ['node:async_hooks', 'executionAsyncResource()'],
  ['node:vm', 'createContext()'],
  ['node:buffer', "Buffer.from('x')"],
]

/** One exported function per call, each import renamed so that no two collide. */
const nodeCallsSource = NODE_CALLS.map(([module, call], index) => {
  const imported = call.split(/[.(]/)[0]!
  const local = `${imported}_${index}`
  return `import { ${imported} as ${local} } from '${module}'\nexport function call${index}() { return ${call.replace(imported, local)} }\n`
}).join('')

const FIT_FIXTURES: ReadonlyArray<ProjectHistory> = [
  {
    // F1: `Stats`, `Server`, `Context`, ... are declared inside `declare module "..."`.
    name: 'node-builtin-module-types',
    states: ['type-from-ambient-module'],
    compilerOptions: { types: ['node'] },
    files: { 'src/app.ts': nodeCallsSource },
  },
  {
    // F1: members of the project's own exported enums, alone and in a union with `undefined`.
    name: 'exported-enum-members',
    states: ['enum-member-type'],
    files: {
      'src/app.ts': `
export enum Status { Ok, Err }
export enum Level { Low = 'low', High = 'high' }
function pick(): Status.Ok { return Status.Ok }
function label(s: Status, l: Level) { return String(s) + l }
export function run(maybe?: Status, level: Level = Level.Low, one: Level.High = Level.High) {
  const picked = pick()
  return label(maybe ?? picked, level) + one
}
`,
    },
  },
  {
    // F1 and F3: globals a project declares in its own .d.ts, named like the library's exports.
    name: 'project-globals-named-like-library-exports',
    states: ['global-declared-outside-targets', 'name-shared-with-library-export'],
    files: {
      'src/globals.d.ts': `
interface Context { ctx: true }
interface Point { x: number }
declare namespace NodeDescriptor { interface Inner { y: 1 } }
`,
      'src/app.ts': `
function make(): Context { return { ctx: true } }
function at(p: Point, d: NodeDescriptor.Inner) { return p.x + d.y }
export function run(p: Point, d: NodeDescriptor.Inner) {
  const c = make()
  return at(p, d) + (c.ctx ? 1 : 0)
}
`,
    },
  },
  {
    // F3: a `declare global` block in another module, and an augmentation of a Node module.
    name: 'project-ambient-declarations',
    states: ['global-declared-outside-targets'],
    compilerOptions: { types: ['node'] },
    files: {
      'src/globals.d.ts': `interface Shape { x: number; y: number }\n`,
      'src/env.ts': `export {}\ndeclare global { interface AppEnv { region: 'EU' | 'US' } var appEnv: AppEnv }\n`,
      'src/augment.d.ts': `import 'node:http'\ndeclare module 'node:http' { interface IncomingMessage { userId: string } }\n`,
      'src/app.ts': `
import type { IncomingMessage } from 'node:http'
function origin(): Shape { return { x: 0, y: 0 } }
function read(e: AppEnv) { return e.region }
function pick(id: string) { return id.toUpperCase() }
export function work(req: IncomingMessage) {
  const o = origin()
  return read(appEnv) + pick(req.userId) + String(o.x)
}
`,
    },
  },
  {
    // F16: a global that @types/node declares through `declare global` inside a module file.
    name: 'abort-controller-in-two-expressions',
    states: ['global-declared-in-module-file', 'type-used-twice'],
    compilerOptions: { types: ['node'] },
    files: {
      'src/app.ts': `
export function start(run: (s: AbortSignal) => void) {
  const controller = new AbortController()
  run(controller.signal)
  return String(controller.signal.aborted)
}
function ok(r: Promise<Response>) { return r }
export function get(u: string) {
  const r = fetch(u)
  return ok(r)
}
`,
    },
  },
  {
    // F15: members keyed by a well-known symbol and by the project's own exported symbol.
    name: 'symbol-keyed-members',
    states: ['symbol-keyed-member'],
    files: {
      'src/app.ts': `
export const tag: unique symbol = Symbol()
const hidden: unique symbol = Symbol()
export const keys = { hidden } as const
function bag(): { [Symbol.iterator](): Iterator<number>; readonly [tag]: string; [hidden]?: boolean; size: number } {
  return null as never
}
function own(k: typeof tag) { return k }
export function run() {
  const b = bag()
  return own(tag) === tag ? b.size : 0
}
`,
    },
  },
  {
    // F15: private aliases of an array, a tuple, and a generic library type.
    name: 'private-aliases-of-library-types',
    states: ['alias-of-library-type'],
    files: {
      'src/app.ts': `
interface Item { id: string }
type Items = Item[]
type Pair = readonly [Item, number?]
type Lookup = Map<string, Item>
function load(): Items { return [] }
function pair(): Pair { return [{ id: 'a' }] }
function index(items: Items): Lookup { return new Map() }
export function run() {
  const items = load()
  const p = pair()
  return index(items).size + p.length
}
`,
    },
  },
  {
    // The static side of a class and the object of an enum are not their instance types.
    name: 'class-and-enum-objects',
    states: ['typeof-class-or-enum'],
    files: {
      'src/app.ts': `
export class Service { static create() { return new Service() } run() { return 1 } }
export enum Mode { A, B }
function ctor(): typeof Service { return Service }
function modes(): typeof Mode { return Mode }
function use(c: typeof Service, m: typeof Mode) { return c.create().run() + m.A }
export function run() {
  const C = ctor()
  const m = modes()
  return use(C, m)
}
`,
    },
  },
  {
    // A package's exported class, its default export, and a type only its exports reach.
    name: 'package-types',
    states: ['type-from-package'],
    files: {
      'node_modules/fake-lib/package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/fake-lib/index.d.ts': `
export declare class Client { private secret; id: string; connect(): Session }
export interface Session { token: string }
declare class Hidden { private h: number; v: string }
export declare function hidden(): Hidden
export default Client
`,
      'src/app.ts': `
import Lib, { Client, hidden } from 'fake-lib'
function open(c: Client) { return c.connect() }
function again(c: Lib) { return c }
export function run() {
  const c = new Client()
  const h = hidden()
  return open(again(c)).token + h.v
}
`,
    },
  },
  {
    // F9: TypeScript drops the byte-order mark, so its positions start one code unit later.
    name: 'target-with-byte-order-mark',
    states: ['byte-order-mark'],
    files: { 'src/app.ts': `﻿export function f(a: number, b: string) { return b + String(a + 1) }\n` },
  },
  {
    // Under exactOptionalPropertyTypes, `number?` and `(number | undefined)?` are different types.
    name: 'exact-optional-members',
    states: ['exact-optional'],
    compilerOptions: { exactOptionalPropertyTypes: true },
    files: {
      'src/app.ts': `
function target(): [string, number?] { return ['a'] }
export function work(opts: { a?: string; b?: string | undefined; c?: string | number }, tup: [string, number?]) {
  return target()
}
`,
    },
  },
  {
    // Template literal and intrinsic string types have no declaration to name.
    name: 'template-and-string-mapping-types',
    states: ['template-literal-type'],
    files: {
      'src/app.ts': `
function tagOf(id: \`id-\${number}\`): \`tag:\${string}\` { return \`tag:\${id}\` }
export function up(s: string, id: \`id-\${number}\`) {
  const u = s.toUpperCase() as Uppercase<string>
  const t = \`a\\\`\${u}\` as const
  return tagOf(id) + t + u
}
`,
    },
  },
  {
    // A private class with public members only is copied; its static side is `typeof`, not the instance.
    name: 'private-class-and-its-static-side',
    states: ['typeof-class-or-enum'],
    files: {
      'src/app.ts': `
class Plain { id = 'p'; static make() { return new Plain() } greet() { return this.id } }
function ctor(): typeof Plain { return Plain }
function inst(): Plain { return new Plain() }
export function run() {
  const C = ctor()
  const p = inst()
  return C.make().greet() + p.id
}
`,
    },
  },
  {
    // Two instantiations of one private generic type are two types.
    name: 'private-generic-types',
    states: ['private-generic-type'],
    files: {
      'src/app.ts': `
interface Box<T> { value: T; next?: Box<T> }
function text(): Box<string> { return { value: 'a' } }
function count(): Box<number> { return { value: 1 } }
function join(a: Box<string>, b: Box<number>) { return a.value + String(b.value) }
export function run() {
  const a = text()
  const b = count()
  return join(a, b)
}
`,
    },
  },
]

oracleProperty({
  id: 'contracts-registry-compiles-and-fits',
  owns: ['src/contracts.ts#generateFileRegistryModule'],
  law: {
    statement:
      'For every target whose expressions and locals have types the project can name, the generated registry compiled as .ts beside the target has no diagnostics of its own, and each node’s result and locals are mutually assignable with the type TypeScript gives the original expression.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: the generated registry compiled as .ts beside the target has no diagnostics of its own, and each node’s result and locals are mutually assignable with the type TypeScript gives the original expression. README.md:7 and README.md:61 state the same promise.',
    limits:
      'The histories are fourteen fixtures in three projects, one for each set of compiler options, each with every node checked: 38 Node built-in calls, enum members, project globals, ambient declarations, symbol keys, private aliases, class and enum objects, a private class with its static side, private generic types, a package, a byte-order mark, exact optional members, and template types. A local the expression does not mention is compared with its declared type.',
  },
  histories: {
    enumerated: combine(FIT_FIXTURES),
    states: [
      'type-from-ambient-module',
      'enum-member-type',
      'global-declared-outside-targets',
      'name-shared-with-library-export',
      'global-declared-in-module-file',
      'type-used-twice',
      'symbol-keyed-member',
      'alias-of-library-type',
      'typeof-class-or-enum',
      'private-generic-type',
      'type-from-package',
      'byte-order-mark',
      'exact-optional',
      'template-literal-type',
    ],
  },
  label: (history) => history.name,
  model: fitModel,
  driver: (history, observe) => driveProject(history, observe, fitView),
  check: judge('registry compiles and fits'),
  calibrations: [
    {
      name: 'a-name-that-does-not-resolve',
      law: 'registry compiles and fits',
      history: { enumerated: 'exactOptionalPropertyTypes=true' },
      corrupt: corruptRegistry((value) => ({ ...value, registryErrors: ["TS2304: Cannot find name 'Stats'."] })),
    },
    {
      name: 'a-result-of-another-type',
      law: 'registry compiles and fits',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: FitView) => {
        value.nodes[nodeOf(value.nodes, 'exported-enum-members')].result = 'not assignable'
        return value
      }),
    },
    {
      name: 'a-file-missing-from-the-registry',
      law: 'registry compiles and fits',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: FitView) => {
        for (const id of Object.keys(value.nodes)) if (id.startsWith('src/target-with-byte-order-mark.')) delete value.nodes[id]
        return value
      }),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C1: primitive, literal, any, tuple, function, and object types keep
// their shape and their modifiers
// ---------------------------------------------------------------------------

const CONSTRUCT_FIXTURES: ReadonlyArray<ProjectHistory> = [
  {
    name: 'primitives-and-literals',
    states: ['scalar-types'],
    files: {
      'src/app.ts': `
function target(): "ok" { return "ok" }
function big(): 42n { return 42n }
export function work(n: number, s: string, tpl: \`id-\${number}\`, sym: symbol, nothing: null, u: undefined) {
  const b = true
  return target() + String(big())
}`,
    },
  },
  {
    name: 'any-result-and-local',
    states: ['any-type'],
    files: {
      'src/app.ts': `
function target(x: any): any { return x }
function strict(): { value: string; items: string[] } { return { value: '', items: [] } }
export function work(raw: any, known: unknown) {
  const s = strict()
  return target(raw)
}`,
    },
  },
  {
    name: 'tuples',
    states: ['tuple-modifiers'],
    files: {
      'src/app.ts': `
function ro(): readonly [string, number] { return ["a", 1] }
function opt(): [string, number?] { return ["a"] }
function rest(): [string, ...number[]] { return ["a", 1, 2] }
function mid(): [first: string, ...boolean[], last: number] { return ["a", 1] }
function both(): readonly [string, (number | undefined)?, ...string[]] { return ["a"] }
export function work(a: readonly [string, number], b: [string, number?], c: [string, ...number[]], d: [string, string | undefined]) {
  return [ro(), opt(), rest(), mid(), both()].length
}`,
    },
  },
  {
    name: 'index-signatures',
    states: ['index-signatures'],
    files: {
      'src/app.ts': `
function dict(): { [key: string]: boolean } { return { a: true } }
function list(): { readonly [key: number]: string } { return { 0: "x" } }
function mixed(): { [key: string]: number | string; id: string; readonly [key: number]: string } { return { id: 'a' } }
export function work(a: { [key: string]: boolean }, b: { readonly [key: number]: string }) {
  return [dict(), list(), mixed()].length
}`,
    },
  },
  {
    name: 'functions-and-callable-objects',
    states: ['callable-types'],
    files: {
      'src/app.ts': `
function fn(): (x: number, y?: string, ...rest: boolean[]) => string { return () => "ok" }
function callable(): { (x: number): string; readonly id: number; get ro(): boolean; get rw(): number; set rw(v: number) } {
  return Object.assign((x: number) => String(x), { id: 1, ro: true, rw: 2 })
}
function overloaded(): { (x: number): string; (x: string): number; new (a: string): { id: string } } { return null as never }
export function work(
  ctor: { new (a: string): { id: string }; readonly tag?: string },
  cb: (first: string, second?: number) => void,
  destructured: ({ a }: { a: number }) => number,
) {
  return [fn(), callable(), overloaded()].length
}`,
    },
  },
  {
    name: 'objects-with-optional-and-readonly-members',
    states: ['member-modifiers'],
    files: {
      'src/app.ts': `
function shape(): { readonly id: string; name?: string; nested: { readonly deep?: number; open: boolean }; "quoted-key": 1 } {
  return { id: 'a', nested: { open: true }, 'quoted-key': 1 }
}
export function work(o: { a?: string | number; readonly b: boolean }) {
  return shape()
}`,
    },
  },
  {
    name: 'unions-and-intersections',
    states: ['composite-types'],
    files: {
      'src/app.ts': `
type A = { a: string }
type B = { b: number }
type Tree = { value: number; children: Tree[] }
function target(): string | number | null { return 1 }
function tree(): Tree { return { value: 1, children: [] } }
function chain(): { next: { next: { value: 1 } } } { return null as never }
export function work(both: A & B, either: A | B, flags: boolean | undefined) {
  return [target(), tree(), chain()].length
}`,
    },
  },
  {
    // A type that refers to itself without a name of its own: the result of a function that returns itself.
    name: 'recursive-anonymous-type',
    states: ['composite-types'],
    files: {
      'src/app.ts': `
function chain() { return { next: chain, value: 1 } }
export function work() { return chain().value }`,
    },
  },
  {
    // Object literals in the target must not pass for the probe's own.
    name: 'object-literals-beside-the-expressions',
    states: ['member-modifiers'],
    files: {
      'src/app.ts': `
function target(o: object) { return Object.keys(o).length }
export function work(opts: { a: number }) {
  const empty = {}
  const merged = { ...opts }
  const plain = { __execution_point_probe: 1 }
  return target(empty) + target(merged) + target({}) + target({ ...opts }) + plain.__execution_point_probe
}`,
    },
  },
]

oracleProperty({
  id: 'contracts-primitive-and-collection-types',
  owns: ['src/contracts.ts#createTypeEmitter'],
  law: {
    statement:
      'For every selectable expression and in-scope local binding whose type is a primitive, literal, any, union, intersection, function signature, tuple (including readonly, optional ?, and ...rest elements), or object with properties and index signatures ([key: K]: V), generateFileRegistryModule emits valid TypeScript type syntax preserving those modifiers.',
    authority:
      'README.md:172 ("emit virtual ExecutionPointFileRegistry") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: emit any, tuple elementFlags, and IndexInfo.valueType. Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: the comparison is mutual assignability with the type TypeScript gives the original expression, in place of the emitted text.',
    limits:
      'Local generic type parameters without concrete instantiations and inline objects with more than 24 properties are not emitted; histories are bounded-exhaustive over nine modules of type constructs in one project. The readonly and ? modifiers are compared three levels deep.',
  },
  histories: {
    enumerated: combine(CONSTRUCT_FIXTURES),
    states: [
      'scalar-types',
      'any-type',
      'tuple-modifiers',
      'index-signatures',
      'callable-types',
      'member-modifiers',
      'composite-types',
    ],
  },
  label: (history) => history.name,
  model: fitModel,
  driver: (history, observe) => driveProject(history, observe, fitView),
  check: judge('primitive-and-collection-types'),
  calibrations: [
    {
      name: 'a-tuple-that-lost-readonly',
      law: 'primitive-and-collection-types',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: FitView) => {
        value.nodes[nodeOf(value.nodes, 'tuples', ':ro:')].result = 'not assignable'
        return value
      }),
    },
    {
      name: 'a-member-that-lost-readonly',
      law: 'primitive-and-collection-types',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: FitView) => {
        value.nodes[nodeOf(value.nodes, 'objects-with-optional-and-readonly-members')].result = 'modifiers differ'
        return value
      }),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C2: control-flow narrowing across if guards, type predicates, and asserts
// ---------------------------------------------------------------------------

const narrowingProject = (name: string, state: string, body: string): ProjectHistory => ({
  name,
  states: [state],
  files: {
    'src/app.ts': `
export interface User { id: string }
function isUser(u: User | null): u is User { return u !== null }
function assertUser(u: User | null): asserts u is User { if (!u) throw new Error('missing') }
function outerWrap(s: string) { return s }
function send(id: string) { return id }
function getClient() { return { send } }
export function work(user: User | null, kind: 'a' | 'b' | 'c') {${body}
}
`,
  },
})

const NARROWING_FIXTURES: ReadonlyArray<ProjectHistory> = [
  narrowingProject(
    'truthiness-throw-guard',
    'narrowed-by-throw-guard',
    `
  if (!user) throw new Error('missing')
  return send(user.id)`,
  ),
  narrowingProject(
    'type-predicate-if',
    'narrowed-by-type-predicate',
    `
  if (isUser(user)) {
    return send(user.id)
  }
  return ''`,
  ),
  narrowingProject(
    'assertion-function-call',
    'narrowed-by-asserts-call',
    `
  assertUser(user)
  return send(user.id)`,
  ),
  narrowingProject(
    'nested-call-narrowing',
    'narrowed-in-nested-call',
    `
  assertUser(user)
  return getClient().send("prefix:" + outerWrap(user.id))`,
  ),
  narrowingProject(
    'assertion-in-switch-clause',
    'narrowed-in-case-clause',
    `
  switch (kind) {
    case 'a':
      assertUser(user)
      return send(user.id + kind)
    default:
      return send(kind)
  }`,
  ),
  narrowingProject(
    'narrowed-inside-the-expression',
    'narrowed-by-enclosing-conditional',
    `
  return user ? send(user.id) : send(kind === 'a' ? kind : 'other')`,
  ),
  // The probe wraps an expression in parentheses of its own; left open, they would take in what follows.
  narrowingProject(
    'inside-an-object-literal-and-an-array',
    'narrowed-inside-a-literal',
    `
  const o = { a: send(kind), b: kind === 'a' ? send(kind) : send(kind) }
  return [send(o.a), kind === 'b' ? send(kind) : send(kind)].join(o.b)`,
  ),
  narrowingProject(
    'inside-a-template-and-nested-calls',
    'narrowed-inside-a-literal',
    `
  return \`\${send(kind)}-\${kind === 'a' ? send(send(kind)) : send(kind)}\` + send(kind === 'b' ? kind + '1' : kind === 'c' ? kind : 'x')`,
  ),
]

oracleProperty({
  id: 'contracts-control-flow-narrowing',
  owns: ['src/contracts.ts#projectNested', 'src/contracts.ts#generateFileRegistryModule'],
  law: {
    statement:
      'For every selectable expression preceded by an if guard, type predicate (u is T), or assertion call (asserts u is T), generateFileRegistryModule emits the control-flow-narrowed type of each captured local at that expression.',
    authority:
      'README.md:40 ("locals.user is narrowed to non-null User"), README.md:171 ("narrowed local types come from a nested incremental probe"), and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: preserve asserts narrowing in Phase 2 probes.',
    limits:
      'Assertion calls must be direct ExpressionStatements in their enclosing block, case clause, or file. The narrowed type is the one TypeScript gives the first reference to the local inside the expression.',
  },
  histories: {
    enumerated: combine(NARROWING_FIXTURES),
    states: [
      'narrowed-by-throw-guard',
      'narrowed-by-type-predicate',
      'narrowed-by-asserts-call',
      'narrowed-in-nested-call',
      'narrowed-in-case-clause',
      'narrowed-by-enclosing-conditional',
      'narrowed-inside-a-literal',
    ],
  },
  label: (history) => history.name,
  // A reference inside the expression is where TypeScript itself states the
  // narrowed type, so the comparison covers the locals each expression
  // mentions. Which ones those are is a fact of the source, recorded as input.
  model: (history, trace) => {
    const mentions = (trace.find((entry) => entry.checkpoint === 'mentions')?.value ?? {}) as Record<string, Array<string>>
    const model = fitModel(history, trace)
    for (const [id, node] of Object.entries(model.nodes)) {
      node.locals = Object.fromEntries((mentions[id] ?? []).map((name) => [name, 'fits']))
    }
    return model
  },
  driver: (history, observe) =>
    driveProject(history, observe, (reading) => {
      observe('mentions', Object.fromEntries(Object.entries(reading.nodes).map(([id, node]) => [id, node.mentioned])))
      const view = fitView(reading)
      for (const [id, node] of Object.entries(view.nodes)) {
        node.locals = Object.fromEntries(
          Object.entries(node.locals).filter(([name]) => reading.nodes[id]!.mentioned.includes(name)),
        )
      }
      return view
    }),
  check: judge('control-flow-narrowing'),
  calibrations: [
    {
      name: 'un-narrowed-nullable-user',
      law: 'control-flow-narrowing',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: FitView) => {
        value.nodes[nodeOf(value.nodes, 'truthiness-throw-guard', ':send:')].locals.user = 'not assignable'
        return value
      }),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C3: a type the project can name is that very type; a private one is a
// copy, branded when it is nominal
// ---------------------------------------------------------------------------

/**
 * How the source declares the type of `target()`: whether a name or an
 * export-anchored path reaches it from outside, and whether it is nominal.
 */
interface IdentityHistory extends ProjectHistory {
  nameable: boolean
  nominal: boolean
  /** The public members of a nominal private type, which its copy keeps. */
  publicMembers?: ReadonlyArray<string>
}

const identity = (
  name: string,
  state: string,
  nameable: boolean,
  nominal: boolean,
  source: string,
  more: Partial<IdentityHistory> = {},
): IdentityHistory => ({
  name,
  states: [state],
  nameable,
  nominal,
  files: { [more.targets?.[0] ?? 'src/app.ts']: source, ...more.files },
  ...(more.targets ? { targets: more.targets } : {}),
  ...(more.compilerOptions ? { compilerOptions: more.compilerOptions } : {}),
  ...(more.publicMembers ? { publicMembers: more.publicMembers } : {}),
})

const QUOTE_MODULE = `
export interface Quote { total: number }
function target(): Quote { return { total: 1 } }
export function work() { return target() }`

const IDENTITY_FIXTURES: ReadonlyArray<IdentityHistory> = [
  identity('exported-interface', 'named-by-export', true, false, QUOTE_MODULE),
  identity('exported-interface-in-mts', 'named-by-export', true, false, QUOTE_MODULE, { targets: ['src/app.mts'] }),
  identity('exported-interface-in-cts', 'named-by-export', true, false, QUOTE_MODULE, {
    targets: ['src/app.cts'],
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
  }),
  identity(
    'exported-class-with-private-members',
    'named-by-export',
    true,
    true,
    `
export class Vault { #hash = 1; private secret = 1; id = "v" }
function target(): Vault { return new Vault() }
export function work() { return target() }`,
  ),
  identity(
    'exported-namespace-member',
    'named-by-export',
    true,
    false,
    `
export namespace Billing { export namespace Inner { export interface Line { amount: number } } }
function target(): Billing.Inner.Line { return { amount: 1 } }
export function work() { return target() }`,
  ),
  identity(
    'exported-unique-symbol',
    'named-by-export',
    true,
    true,
    `
export const pubSym: unique symbol = Symbol()
function target(): typeof pubSym { return pubSym }
export function work() { return target() }`,
  ),
  identity(
    'reachable-through-nullable-parameter',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface PrivateUser { id: string }
function target(): PrivateUser { return { id: "1" } }
export function work(u: PrivateUser | null): string { return target().id }`,
  ),
  identity(
    'reachable-through-second-parameter',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface First { a: string }
interface Second { b: string }
function target(): Second { return { b: "1" } }
export function work(first: First, second: Second | undefined): string { return target().b + first.a }`,
  ),
  identity(
    'reachable-through-promise-result',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface PrivateResult { ok: boolean }
function target(): PrivateResult { return { ok: true } }
export async function work(): Promise<PrivateResult> { return target() }`,
  ),
  identity(
    'reachable-through-array-element-and-property',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(): Array<{ item: Leaf }> { return [{ item: target() }] }`,
  ),
  identity(
    'reachable-through-exported-value-and-renamed-export',
    'named-by-export-anchored-path',
    true,
    true,
    `
class Engine { private rpm = 0; start() { return this.rpm } }
function target(): Engine { return new Engine() }
function build(): Engine { return target() }
export { build as make }
export function work() { return 1 }`,
  ),
  identity(
    'reachable-private-enum-and-alias',
    'named-by-export-anchored-path',
    true,
    true,
    `
enum Phase { Idle, Busy }
type Settings = { phase: Phase }
function target(): Settings { return { phase: Phase.Idle } }
export const current: Settings = target()
export function work() { return 1 }`,
  ),
  identity(
    'reachable-at-the-fourth-step',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface DeepLeaf { count: number }
function target(): DeepLeaf { return { count: 1 } }
export function work(): { l1: { l2: { l3: DeepLeaf } } } { return { l1: { l2: { l3: target() } } } }`,
  ),
  identity(
    'global-and-namespaced-ambient-types',
    'named-globally',
    true,
    false,
    `
function target(t: ReturnType<typeof setTimeout>, m: Map<string, Date>, h: Outer.Inner.Handle, d: DotA.DotB.DotType): [ReturnType<typeof setTimeout>, Map<string, Date>, Outer.Inner.Handle, DotA.DotB.DotType] { return [t, m, h, d] }
export function work(m: Map<string, Date>, h: Outer.Inner.Handle, d: DotA.DotB.DotType) {
  const t = setTimeout(() => {}, 10)
  return target(t, m, h, d)
}`,
    {
      compilerOptions: { types: ['node'] },
      files: {
        'src/ambient.d.ts': `
declare namespace Outer {
  namespace Inner {
    interface Handle { id: number }
    interface Handle { tag?: string }
  }
}
declare namespace DotA.DotB {
  interface DotType { x: string }
}
`,
      },
    },
  ),
  identity(
    'global-declared-by-a-module-file',
    'named-globally',
    true,
    false,
    `
function target(c: AbortController): AbortController { return c }
export function work(c: AbortController) { return target(c) }`,
    { compilerOptions: { types: ['node'] } },
  ),
  identity(
    'private-type-that-shadows-a-global',
    'copied-structurally',
    false,
    false,
    `
interface Map { own: string }
function target(): Map { return { own: 'a' } }
export function work() { return target().own }`,
  ),
  identity(
    'private-interface',
    'copied-structurally',
    false,
    false,
    `
interface InternalBox { count: number; readonly label?: string; self?: InternalBox }
function target(): InternalBox { return { count: 1 } }
export function work() { const b = target(); return b.count }`,
  ),
  identity(
    'private-type-beyond-the-fourth-step',
    'copied-structurally',
    false,
    false,
    `
interface DeepLeaf { count: number }
function target(): DeepLeaf { return { count: 1 } }
export function work(): { l1: { l2: { l3: { l4: DeepLeaf } } } } {
  return { l1: { l2: { l3: { l4: target() } } } }
}`,
  ),
  identity(
    'private-type-behind-a-generic-function',
    'copied-structurally',
    false,
    false,
    `
interface Hidden { h: string }
function target(): Hidden { return { h: 'a' } }
export function work<T>(x: T): Hidden { return target() }`,
  ),
  identity(
    'private-type-behind-overloads',
    'copied-structurally',
    false,
    false,
    `
interface Hidden { h: string }
function target(): Hidden { return { h: 'a' } }
export function over(x: string): Hidden
export function over(x: number): Hidden
export function over(x: unknown): Hidden { return target() }
export function work() { return 1 }`,
  ),
  identity(
    'exported-generic-alias-of-private-type',
    'copied-structurally',
    false,
    false,
    `
export type Box<T> = { value: T }
interface InternalItem { label: string }
function target(): Box<InternalItem> { return { value: { label: "a" } } }
export function work() {
  const dup: InternalItem = { label: "b" }
  return target().value.label
}`,
  ),
  identity(
    'private-class-with-private-members',
    'copied-with-brand',
    false,
    true,
    `
class SecretVault { #hash = 1; private secret = 1; protected prot = 2; public id = "v"; open() { return this.id } }
function target(): SecretVault { return new SecretVault() }
export function work() { const v = target(); return v.id }`,
    { publicMembers: ['id', 'open'] },
  ),
  identity(
    'private-enum',
    'copied-with-brand',
    false,
    true,
    `
enum PrivateStatus { Ok, Err }
function target(): PrivateStatus { return Math.random() > 0.5 ? PrivateStatus.Ok : PrivateStatus.Err }
export function work() { return String(target()) }`,
    { publicMembers: [] },
  ),
  identity(
    'private-unique-symbol',
    'copied-with-brand',
    false,
    true,
    `
const privSym: unique symbol = Symbol()
function target(): typeof privSym { return privSym }
export function work() { return String(target()) }`,
    { publicMembers: [] },
  ),
  identity(
    'reachable-through-one-element-tuple',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(): [Leaf] { return [target()] }`,
  ),
  identity(
    'reachable-through-parameter-array-promise-and-nullable',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(all: Array<Promise<Leaf | null>>) { return all.length + target().code }`,
  ),
  identity(
    'private-type-one-step-too-deep-through-a-parameter',
    'copied-structurally',
    false,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(all: Array<Promise<{ leaf: Leaf } | null>>) { return all.length + target().code }`,
  ),
  identity(
    'private-type-behind-a-library-collection',
    'copied-structurally',
    false,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(): Map<string, Leaf> { return new Map([['a', target()]]) }`,
  ),
  identity(
    'reachable-through-object-with-24-properties',
    'named-by-export-anchored-path',
    true,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(): { ${Array.from({ length: 23 }, (_, index) => `p${index}: number`).join('; ')}; leaf: Leaf } { return null as never }
export function use() { return target().code }`,
  ),
  identity(
    'private-type-behind-object-with-25-properties',
    'copied-structurally',
    false,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(): { ${Array.from({ length: 23 }, (_, index) => `p${index}: number`).join('; ')}; p23: number; leaf: Leaf } { return null as never }
export function use() { return target().code }`,
  ),
  identity(
    'private-type-behind-a-symbol-keyed-member',
    'copied-structurally',
    false,
    false,
    `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export const holder = { [Symbol.iterator]: (): Leaf => target() }
export function work() { return 1 }`,
  ),
  identity(
    'private-class-with-public-members-only',
    'copied-structurally',
    false,
    false,
    `
class Plain { id = "p"; greet() { return this.id } }
function target(): Plain { return new Plain() }
export function work() { return target().greet() }`,
  ),
  identity(
    'static-side-of-a-reachable-private-class',
    'copied-structurally',
    false,
    false,
    `
class Engine { rpm = 0; static make() { return new Engine() } }
function target(): typeof Engine { return Engine }
export function build(): Engine { return target().make() }
export function work() { return 1 }`,
  ),
]

/** The result of every `target()` call, as TypeScript relates it to the original. */
const identityView = (reading: RegistryReading) => ({
  registryErrors: reading.registryErrors,
  projectErrors: reading.projectErrors,
  targets: Object.fromEntries(
    Object.entries(reading.nodes)
      .filter(([id]) => id.includes(':target:'))
      .map(([id, node]) => [
        id,
        { unportable: node.unportable, result: node.result, members: node.resultMembers, acceptsOriginal: node.acceptsOriginal },
      ]),
  ),
})

type IdentityView = ReturnType<typeof identityView>

oracleProperty({
  id: 'contracts-export-paths-and-helpers',
  owns: [
    'src/contracts.ts#createTypeEmitter',
    'src/contracts.ts#buildExportIndex',
    'src/contracts.ts#isNominalUnexported',
    'src/contracts.ts#hasLocalDeclaration',
  ],
  law: {
    statement:
      'For every type the project can name (exported, export-reachable, global, or declared by an ambient module or a package), generateFileRegistryModule declares that very type; for every other module-scope type it declares a structural copy, and a unique-symbol-branded copy when the type is an enum, a unique symbol, or a class with private members.',
    authority:
      'README.md:172 ("Export-reachable private types (Quote, User, Order) preserve exact identity via export-anchored paths; unreachable private types emit structural or unique-symbol-branded helpers.") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: any emitted name must mean, where the registry is compiled, the same type it means in the target; this replaces the rule that ambient types get their bare qualified name whatever wraps their declaration.',
    limits:
      'An export-anchored path is searched four steps deep through non-generic, single-signature functions, promise results, array elements, nullable unions, and objects the module declares with up to 24 properties. Sameness is the identity of the type in one TypeScript program; a branded copy is checked for not being assignable in either direction and for keeping exactly the public members.',
  },
  histories: {
    enumerated: combine(IDENTITY_FIXTURES),
    states: ['named-by-export', 'named-by-export-anchored-path', 'named-globally', 'copied-structurally', 'copied-with-brand'],
  },
  label: (history) => history.name,
  // A name denotes the declaration itself, so TypeScript finds the same type.
  // A structural copy is another type that is mutually assignable. A brand
  // makes the copy assignable in neither direction, so that nothing but
  // original() and the locals produce it, and the copy lists the members a
  // handler may read.
  model: (history, trace) => ({
    registryErrors: [],
    projectErrors: [],
    targets: Object.fromEntries(
      planOf(trace)
        .filter((node) => node.callee === 'target')
        .map((node) => {
          const fixture = history.fixtures[node.id.slice(0, node.id.indexOf('#'))]!
          return [
            node.id,
            {
              unportable: null,
              result: fixture.nameable ? 'same' : fixture.nominal ? 'not assignable' : 'equivalent',
              members: !fixture.nameable && fixture.nominal ? [...fixture.publicMembers!].sort() : null,
              // A brand is what keeps a look-alike, even the original value, from passing for the copy.
              acceptsOriginal: fixture.nameable || !fixture.nominal,
            },
          ]
        }),
    ),
  }),
  driver: (history, observe) =>
    driveProject(history, observe, (reading) => {
      const view = identityView(reading)
      for (const [id, target] of Object.entries(view.targets)) {
        const fixture = history.fixtures[id.slice(0, id.indexOf('#'))]!
        if (fixture.nameable || !fixture.nominal) target.members = null
      }
      return view
    }),
  check: judge('export-paths-and-helpers'),
  calibrations: [
    {
      name: 'a-copy-where-the-type-has-a-name',
      law: 'export-paths-and-helpers',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: IdentityView) => {
        value.targets[nodeOf(value.targets, 'exported-interface')].result = 'equivalent'
        return value
      }),
    },
    {
      name: 'a-nominal-copy-without-its-brand',
      law: 'export-paths-and-helpers',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: IdentityView) => {
        value.targets[nodeOf(value.targets, 'private-enum')].acceptsOriginal = true
        return value
      }),
    },
    {
      name: 'a-copy-that-leaks-a-private-member',
      law: 'export-paths-and-helpers',
      history: { enumerated: 'default-options' },
      corrupt: corruptRegistry((value: IdentityView) => {
        value.targets[nodeOf(value.targets, 'private-class-with-private-members')].members = ['id', 'open', 'secret']
        return value
      }),
    },
  ],
})

// ---------------------------------------------------------------------------
// One copy per private type: every use of a private type, in a result or in a
// local, refers to the same helper
// ---------------------------------------------------------------------------

interface SharedCopyHistory extends ProjectHistory {
  /** Pairs of node slots whose declared types the source gives the same private type. */
  same: ReadonlyArray<readonly [from: string, to: string]>
  /** Pairs the source gives two different nominal private types of equal shape. */
  distinct: ReadonlyArray<readonly [from: string, to: string]>
  /** How many private types of the source can be copied. */
  copies: number
  /** How many different symbols key a member of those types. */
  symbolKeys: number
}

const SHARED_COPY_HISTORIES: ReadonlyArray<SharedCopyHistory> = [
  {
    name: 'private-class-as-result-and-as-local',
    states: ['one-copy-for-result-and-local', 'two-brands-for-two-types'],
    files: {
      'src/app.ts': `
class Vault { private secret = 1; id = "v" }
class Safe { private secret = 1; id = "v" }
class Cell<T> { private sealed = true; constructor(public value: T) {} }
enum Phase { Idle, Busy }
function makeVault(): Vault { return new Vault() }
function makeSafe(): Safe { return new Safe() }
function phase(): Phase { return Phase.Idle }
function cellOfText(): Cell<string> { return new Cell('a') }
function cellOfCount(): Cell<number> { return new Cell(1) }
function use(v: Vault, s: Safe, p: Phase, c: Cell<string>) { return v.id + s.id + String(p) + c.value }
export function work() {
  const v = makeVault()
  const s = makeSafe()
  const p = phase()
  const c = cellOfText()
  return use(v, s, p, c) + String(cellOfCount().value)
}
`,
    },
    same: [
      ['src/app.ts#work:CallExpression:makeVault:0', 'src/app.ts#work:CallExpression:use:0|v'],
      ['src/app.ts#work:CallExpression:use:0|v', 'src/app.ts#work:CallExpression:makeVault:0'],
      ['src/app.ts#work:CallExpression:phase:0', 'src/app.ts#work:CallExpression:use:0|p'],
      ['src/app.ts#work:CallExpression:cellOfText:0', 'src/app.ts#work:CallExpression:use:0|c'],
    ],
    distinct: [
      ['src/app.ts#work:CallExpression:makeVault:0', 'src/app.ts#work:CallExpression:makeSafe:0'],
      ['src/app.ts#work:CallExpression:use:0|s', 'src/app.ts#work:CallExpression:use:0|v'],
      // Two instantiations of one private generic class are two types.
      ['src/app.ts#work:CallExpression:cellOfText:0', 'src/app.ts#work:CallExpression:cellOfCount:0'],
      ['src/app.ts#work:CallExpression:cellOfCount:0', 'src/app.ts#work:CallExpression:use:0|c'],
    ],
    // Vault, Safe, Phase, Cell<string>, and Cell<number>.
    copies: 5,
    symbolKeys: 0,
  },
  {
    // F16: a type that cannot be copied must not leave its helper's name behind,
    // nor the names of what was declared for it before it failed.
    name: 'wide-private-interface-used-twice',
    states: ['type-that-cannot-be-copied', 'copy-declared-then-taken-back'],
    files: {
      'src/app.ts': `
interface Wide { ${Array.from({ length: 25 }, (_, index) => `p${index}: number`).join('; ')} }
interface Holder { wide: Wide; name: string }
interface Loop { back: Loop; wide: Wide }
interface Inner { v: number }
interface Outer { inner: Inner; wide: Wide }
interface Sequence { [Symbol.iterator](): Iterator<boolean> }
interface Keyed { sequence: Sequence; wide: Wide }
interface Numbers { [Symbol.iterator](): Iterator<number>; n: number }
interface Words { [Symbol.iterator](): Iterator<string> }
function make(): Wide { return {} as Wide }
function hold(): Holder { return {} as Holder }
function loop(): Loop { return {} as Loop }
function outer(): Outer { return {} as Outer }
function inner(): Inner { return { v: 1 } }
function keyed(): Keyed { return {} as Keyed }
function numbers(): Numbers { return {} as Numbers }
function words(): Words { return {} as Words }
export function a() { return make().p0 }
export function b() { const w = make(); return hold().name + loop().wide.p1 + w.p2 }
export function c() { return hold().name + loop().wide.p1 }
export function d() {
  const o = outer()
  const k = keyed()
  return inner().v + numbers().n + [...words()].length + [...numbers()].length + o.inner.v + k.wide.p0
}
`,
    },
    same: [],
    distinct: [],
    // Inner, Numbers, and Words; Wide and everything that holds a Wide cannot be copied,
    // and Sequence is only ever declared for Keyed, which is taken back with its key constant.
    copies: 3,
    symbolKeys: 1,
  },
  {
    // The same names are worked out once, however often a type is used.
    name: 'types-used-many-times',
    states: ['type-used-many-times'],
    files: {
      'src/app.ts': `
interface Item { id: string; next?: Item }
interface Bag { [Symbol.iterator](): Iterator<Item>; first: Item; last: Item }
interface Leaf { v: number }
type Row = [${Array.from({ length: 40 }, () => 'Item, Date, Map<string, Item>, Bag, Leaf').join(', ')}]
interface Tree { left: Tree; right: Tree; up: Tree; down: Tree; leaf: Leaf }
function row(): Row { return null as never }
export function tree(): Tree { return null as never }
export function work(r: Row) {
  const again = row()
  return again.length + r.length
}
`,
    },
    same: [['src/app.ts#work:CallExpression:row:0', 'src/app.ts#work:CallExpression:row:0|r']],
    distinct: [],
    // Item and Bag; Tree and Leaf are reached through the exported tree().
    copies: 2,
    symbolKeys: 1,
  },
]

oracleProperty({
  id: 'contracts-one-copy-per-private-type',
  owns: ['src/contracts.ts#createTypeEmitter', 'src/contracts.ts#generateFileRegistryModule'],
  law: {
    statement:
      'For every private module-scope type, every result and local of that type refers to one copy, declared once, so a value of the type read from a local or returned by original() is accepted wherever the type is expected; two different nominal private types get two brands; and a type that cannot be copied leaves no name behind.',
    authority:
      'README.md:172 ("unreachable private types emit structural or unique-symbol-branded helpers") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: the registry compiled as .ts beside the target has no diagnostics of its own. Approved as worded by Manuel Schiller (GitHub schiller-manuel), 2026-11-24.',
    limits:
      'Checked on a private class used as a result and as a local, two private classes of equal shape, a private enum, interfaces that cannot be copied because one has more than 24 properties, and a tuple that uses five types forty times each. The copies are counted as the __EP_* interfaces the registry declares.',
  },
  histories: {
    enumerated: SHARED_COPY_HISTORIES,
    states: [
      'one-copy-for-result-and-local',
      'two-brands-for-two-types',
      'type-that-cannot-be-copied',
      'copy-declared-then-taken-back',
      'type-used-many-times',
    ],
  },
  label: (history) => history.name,
  // The source uses one type for both slots of a `same` pair, so TypeScript
  // must find them assignable; a `distinct` pair names two nominal types.
  model: (history) => ({
    registryErrors: [],
    projectErrors: [],
    same: history.same.map(() => true),
    distinct: history.distinct.map(() => false),
    copies: history.copies,
    keyConstants: history.symbolKeys,
  }),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    const root = createProject(history.files)
    try {
      const { reading, relations } = generateAndCompile(api, root, ['src/app.ts'], {
        relations: [...history.same, ...history.distinct],
      })
      observe('registry', {
        registryErrors: reading.registryErrors,
        projectErrors: reading.projectErrors,
        same: relations.slice(0, history.same.length),
        distinct: relations.slice(history.same.length),
        copies: reading.copies,
        keyConstants: reading.keyConstants,
      })
    } catch (error) {
      observe('crash', error instanceof Error ? error.message : String(error))
    } finally {
      removeProject(root)
    }
  },
  check: judge('one-copy-per-private-type'),
  calibrations: [
    {
      name: 'a-second-brand-for-the-same-class',
      law: 'one-copy-per-private-type',
      history: { enumerated: 'private-class-as-result-and-as-local' },
      corrupt: corruptRegistry((value: { same: Array<boolean> }) => ({ ...value, same: value.same.map(() => false) })),
    },
    {
      name: 'a-copy-for-every-use',
      law: 'one-copy-per-private-type',
      history: { enumerated: 'types-used-many-times' },
      corrupt: corruptRegistry((value) => ({ ...value, copies: 80 })),
    },
    {
      name: 'a-helper-name-without-a-definition',
      law: 'one-copy-per-private-type',
      history: { enumerated: 'wide-private-interface-used-twice' },
      corrupt: corruptRegistry((value) => ({ ...value, registryErrors: ["TS2304: Cannot find name '__EP_Wide_1'."] })),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C5: the registry lists the plan's files and nodes, and keeps what it
// cannot type
// ---------------------------------------------------------------------------

/**
 * A project, the files of its plan that are modules with expressions, and
 * the places where its source uses a type that cannot be written outside
 * its declaration: a type parameter, a type declared inside a function, or
 * an object too wide to copy.
 */
interface ParityHistory extends ProjectHistory {
  listed: ReadonlyArray<string>
  /** Functions whose every expression has such a type. */
  unwritableResultsIn: ReadonlyArray<string>
  /** Functions whose every call returns such a type. */
  unwritableCallees?: ReadonlyArray<string>
  /** Locals of such a type, by the function that declares them. */
  unwritableLocals: Readonly<Record<string, ReadonlyArray<string>>>
  /** Pairs of expressions of such a type: the result of one must not pass for the other's. */
  distinctResults?: ReadonlyArray<readonly [from: string, to: string]>
  /** What the reason for such an expression has to name, by its function or its callee. */
  reasonsName?: Readonly<Record<string, string>>
  /** What the reason for such a local has to name, by the local. */
  localReasonsName?: Readonly<Record<string, string>>
  /** The project has errors of its own, as a project has while it is being edited. */
  brokenProject?: boolean
}

/** Whether a reason names what the history says it has to; a reason nothing is said about passes. */
const says = (reason: string | null, expected: string | undefined) => expected === undefined || Boolean(reason?.includes(expected))

const PARITY_HISTORIES: ReadonlyArray<ParityHistory> = [
  {
    name: 'call-binary-and-conditional-descriptors',
    states: ['call-node', 'binary-node', 'conditional-node', 'top-level-node'],
    listed: ['src/app.ts'],
    unwritableResultsIn: [],
    unwritableLocals: {},
    files: {
      'src/app.ts': `
function send(x: number) { return x }
export const top = send(1)
export function work(a: number, b: number, ok: boolean) {
  const sum = a + b
  const again = send(sum) + send(a)
  return ok ? again : obj["quoted name"](b)
}
const obj = { "quoted name": (n: number) => n, arrow: () => send(2) }
export class Box { get value() { return send(3) } method() { return (() => send(4))() } }
`,
    },
  },
  {
    name: 'several-files-in-one-plan',
    states: ['several-files', 'global-script-skipped', 'file-without-expressions', 'unloadable-file-skipped'],
    targets: ['src/b.ts', 'src/a.ts', 'src/script.ts', 'src/empty.ts', 'src/notes.txt'],
    listed: ['src/a.ts', 'src/b.ts'],
    unwritableResultsIn: [],
    unwritableLocals: {},
    files: {
      'src/a.ts': `export function a(n: number) { return n + 1 }\n`,
      'src/b.ts': `export function b(n: number) { return n * 2 }\n`,
      'src/script.ts': `function script(n: number) { return n + 1 }\n`,
      'src/empty.ts': `export const value = 1\n`,
      // TypeScript source in a file that TypeScript does not load.
      'src/notes.txt': `export function note(n: number) { return n + 1 }\n`,
    },
  },
  {
    name: 'expressions-typed-by-a-type-parameter',
    states: ['unportable-result', 'unportable-local'],
    listed: ['src/app.ts'],
    unwritableResultsIn: ['genericCaller', 'pick'],
    unwritableLocals: { genericCaller: ['x'], pick: ['k', 'o'], keys: ['k', 'kk', 'o'], withGenericLocal: ['pass'] },
    reasonsName: { genericCaller: 'U', pick: 'T[K]' },
    localReasonsName: { x: 'U', k: 'K', kk: 'keyof T', o: 'T', pass: 'T' },
    distinctResults: [
      ['src/app.ts#genericCaller:CallExpression:identity:0', 'src/app.ts#pick:ConditionalExpression:?:0'],
      ['src/app.ts#pick:ConditionalExpression:?:0', 'src/app.ts#genericCaller:CallExpression:identity:0'],
    ],
    files: {
      'src/app.ts': `
function identity<T>(v: T): T { return v }
export function genericCaller<U>(x: U) { return identity(x) }
export function concreteCaller() { return identity(1) }
export function pick<T, K extends keyof T>(o: T, k: K, flag: boolean) { return flag ? o[k] : o[k] }
export function keys<T, K extends keyof T>(o: T, k: K, flag: boolean) {
  const kk: keyof T = k
  return flag ? 1 : 2
}
export function withGenericLocal(n: number) {
  const pass = <T>(x: T) => x
  return n + 1
}
`,
    },
  },
  {
    name: 'file-with-only-unportable-expressions',
    states: ['unportable-only-file'],
    listed: ['src/app.ts'],
    unwritableResultsIn: ['genericOnly'],
    unwritableLocals: { genericOnly: ['x'] },
    reasonsName: { genericOnly: 'U' },
    files: {
      'src/app.ts': `
function identity<T>(v: T): T { return v }
export function genericOnly<U>(x: U) { return identity(x) }
`,
    },
  },
  {
    name: 'types-declared-inside-a-function',
    states: ['local-type-omitted'],
    listed: ['src/app.ts'],
    unwritableResultsIn: ['localResult'],
    // `Symbol()` here has the type of the local unique symbol it initializes.
    unwritableCallees: ['Symbol'],
    unwritableLocals: { work: ['localAliasObj', 'localObj', 'localSym', 'localEnum'], localResult: ['Inner', 'make'] },
    reasonsName: { localResult: 'Inner', Symbol: 'localSym' },
    localReasonsName: { localObj: 'LocalOnly', localAliasObj: 'LocalAlias', localSym: 'localSym', make: 'Inner', Inner: 'Inner' },
    files: {
      'src/app.ts': `
function target(): number { return 42 }
export function work(n: number) {
  interface LocalOnly { x: number }
  type LocalAlias = { y: number }
  enum LocalEnum { A }
  const localSym: unique symbol = Symbol()
  const localObj: LocalOnly = { x: 1 }
  const localAliasObj: LocalAlias = { y: 2 }
  const localEnum: LocalEnum = LocalEnum.A
  return target() + n
}
export function localResult() {
  class Inner { v = 1 }
  const make = () => new Inner()
  return make()
}
`,
    },
  },
  {
    // 25 properties cannot be copied; 24 can. No export reaches either type.
    name: 'object-too-wide-to-copy',
    states: ['unportable-result', 'unportable-local'],
    listed: ['src/app.ts'],
    unwritableResultsIn: [],
    unwritableCallees: ['make', 'wideResult'],
    unwritableLocals: { wideLocal: ['w'] },
    reasonsName: { make: 'too many properties', wideResult: 'too many properties' },
    localReasonsName: { w: 'too many properties' },
    files: {
      'src/app.ts': `
interface Wide { ${Array.from({ length: 25 }, (_, index) => `p${index}: number`).join('; ')} }
interface Fits { ${Array.from({ length: 24 }, (_, index) => `p${index}: number`).join('; ')} }
function make(): Wide { return {} as Wide }
function fits(): Fits { return {} as Fits }
function wideResult() { return make() }
function wideLocal(w: Wide, f: Fits) { return fits().p0 + f.p1 + w.p2 }
export function entry() { return String(wideResult()) + String(wideLocal({} as Wide, {} as Fits)) }
`,
    },
  },
  {
    // A member of a private enum has no name; neither has a member keyed by a private symbol,
    // nor one whose symbol key no declaration writes out.
    name: 'private-enum-member-and-unnamed-symbol-keys',
    states: ['unportable-result', 'private-enum-member', 'unnamed-symbol-key'],
    listed: ['src/app.ts'],
    unwritableResultsIn: [],
    unwritableCallees: ['member', 'keyed', 'mapped'],
    unwritableLocals: {},
    reasonsName: { member: 'P.A', keyed: 'member [secret] is not exported', mapped: 'keys the member [shown]' },
    files: {
      'src/app.ts': `
enum P { A, B }
declare const secret: unique symbol
export declare const shown: unique symbol
function member(): P.A { return P.A }
function keyed(): { [secret]: number } { return { [secret]: 1 } }
function mapped(): { [K in typeof shown]: string } { return { [shown]: 'a' } }
export function work() { return String(member()) + String(keyed()[secret]) + mapped()[shown] }
`,
    },
  },
  {
    // While a project is being edited it has errors, and TypeScript has no type for what depends on them.
    name: 'expression-typed-by-a-missing-import',
    states: ['unportable-result', 'unportable-local', 'project-with-errors'],
    listed: ['src/app.ts'],
    brokenProject: true,
    unwritableResultsIn: ['unknownCall'],
    unwritableLocals: { work: ['g'] },
    reasonsName: { unknownCall: 'could not determine' },
    localReasonsName: { g: 'could not determine' },
    files: {
      'src/app.ts': `
import { gone } from './missing'
function ok(n: number) { return n + 1 }
export function work(n: number) {
  const g = gone
  return ok(n)
}
export function unknownCall() { return gone() }
`,
    },
  },
]

/** The part of the registry this law observes that its calibrations change. */
type ParityView = {
  files: Array<string>
  nodes: Record<string, { result: string; reasonsNameTheirSubject: boolean; unportableLocals: Array<string> }>
}

oracleProperty({
  id: 'contracts-disjoint-fields-and-unportable-parity',
  owns: ['src/contracts.ts#renderFileModule', 'src/contracts.ts#generateFileRegistryModule'],
  law: {
    statement:
      'For every selectable expression indexed in a target module, generateFileRegistryModule emits disjoint optional-undefined callee/operator properties by kind, and emits an expression whose type cannot be written with __unportable, its locals, and an opaque result type of its own that only original() can produce, so compile-time node count equals runtime node count.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: disjoint callee/operator discriminators and compile/runtime parity for unportable expressions. README.md:173 ("Global scripts are skipped."). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a local whose type cannot be written carries the reason. Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: an expression whose type cannot be written stays selectable with an opaque result type that only original() can produce; this replaces result: never. That a reason names its subject: approved by Manuel Schiller (GitHub schiller-manuel), 2026-11-24.',
    limits:
      'Applies to CallExpression, BinaryExpression, and ConditionalExpression nodes indexed by discovery.ts. The reason is checked for being present and for naming the type or the cause that the history states, not word for word. Opaque means: not any, unknown, or never, and not assignable from the expression’s own type, from {}, or from string; whether select() accepts such a node is the type layer’s law.',
  },
  histories: {
    enumerated: PARITY_HISTORIES,
    states: [
      'call-node',
      'binary-node',
      'conditional-node',
      'top-level-node',
      'several-files',
      'global-script-skipped',
      'file-without-expressions',
      'unportable-result',
      'unportable-local',
      'unportable-only-file',
      'local-type-omitted',
      'unloadable-file-skipped',
      'private-enum-member',
      'unnamed-symbol-key',
      'project-with-errors',
    ],
  },
  label: (history) => history.name,
  // The registry repeats each node of the plan: the field a kind has holds
  // the plan's literal, the field it lacks is `?: undefined`. A node whose
  // type cannot be written stays, with its locals and an opaque result; a
  // local that cannot be written is left out of `locals` and named with a
  // reason.
  model: (history, trace) => ({
    registryErrors: [],
    projectCompiles: !history.brokenProject,
    files: [...history.listed].sort(),
    oneResultPassesForAnother: (history.distinctResults ?? []).map(() => false),
    nodes: Object.fromEntries(
      planOf(trace)
        .filter((node) => history.listed.some((file) => node.id.startsWith(`${file}#`)))
        .map((node) => {
          const unwritable =
            history.unwritableResultsIn.includes(node.inFunction ?? '') ||
            Boolean(history.unwritableCallees?.includes(node.callee ?? ''))
          const hidden = history.unwritableLocals[node.inFunction ?? ''] ?? []
          return [
            node.id,
            {
              descriptor: {
                kind: node.kind,
                inFunction: node.inFunction,
                nth: node.nth,
                callee: node.callee ?? ABSENT,
                operator: node.operator ?? ABSENT,
              },
              unportable: unwritable,
              reasonsNameTheirSubject: true,
              result: unwritable ? 'opaque' : 'fits',
              fitsOfLocals: true,
              locals: node.captures.filter((name) => !hidden.includes(name)).sort(),
              unportableLocals: node.captures.filter((name) => hidden.includes(name)).sort(),
            },
          ]
        }),
    ),
  }),
  driver: (history, observe) =>
    driveProject(
      history,
      observe,
      (reading, relations) => ({
      registryErrors: reading.registryErrors,
      projectCompiles: reading.projectErrors.length === 0,
      files: reading.files,
      oneResultPassesForAnother: relations,
      nodes: Object.fromEntries(
        Object.entries(reading.nodes).map(([id, node]) => [
          id,
          {
            descriptor: node.descriptor,
            unportable: node.unportable !== null && node.unportable.length > 0,
            reasonsNameTheirSubject:
              says(
                node.unportable,
                node.unportable === null
                  ? undefined
                  : (history.reasonsName?.[String(node.descriptor.inFunction)] ?? history.reasonsName?.[String(node.descriptor.callee)]),
              ) && Object.entries(node.unportableLocals).every(([name, reason]) => says(reason, history.localReasonsName?.[name])),
            result: node.opaque === null ? fitsOf(node.result) : node.opaque ? 'opaque' : 'a type a test can write',
            // As for narrowing: a local is compared where the expression itself refers to it.
            fitsOfLocals: Object.entries(node.locals).every(([name, fit]) => !node.mentioned.includes(name) || fitsOf(fit) === 'fits'),
            locals: Object.keys(node.locals).sort(),
            unportableLocals: Object.entries(node.unportableLocals)
              .filter(([, reason]) => reason.length > 0)
              .map(([name]) => name)
              .sort(),
          },
        ]),
      ),
      }),
      history.distinctResults,
    ),
  check: judge('disjoint-fields-and-unportable-parity'),
  calibrations: [
    {
      name: 'missing-unportable-node',
      law: 'disjoint-fields-and-unportable-parity',
      history: { enumerated: 'expressions-typed-by-a-type-parameter' },
      corrupt: corruptRegistry((value: ParityView) => {
        const generic = Object.keys(value.nodes).find((id) => id.includes('#genericCaller:'))!
        delete value.nodes[generic]
        return value
      }),
    },
    {
      name: 'an-unwritable-result-typed-never',
      law: 'disjoint-fields-and-unportable-parity',
      history: { enumerated: 'file-with-only-unportable-expressions' },
      corrupt: corruptRegistry((value: ParityView) => {
        for (const node of Object.values(value.nodes)) node.result = 'a type a test can write'
        return value
      }),
    },
    {
      name: 'a-reason-that-names-nothing',
      law: 'disjoint-fields-and-unportable-parity',
      history: { enumerated: 'expressions-typed-by-a-type-parameter' },
      corrupt: corruptRegistry((value: ParityView) => {
        value.nodes[Object.keys(value.nodes).find((id) => id.includes('#pick:'))!].reasonsNameTheirSubject = false
        return value
      }),
    },
    {
      name: 'a-local-dropped-without-a-reason',
      law: 'disjoint-fields-and-unportable-parity',
      history: { enumerated: 'types-declared-inside-a-function' },
      corrupt: corruptRegistry((value: ParityView) => {
        for (const node of Object.values(value.nodes)) node.unportableLocals = []
        return value
      }),
    },
    {
      name: 'a-global-script-in-the-registry',
      law: 'disjoint-fields-and-unportable-parity',
      history: { enumerated: 'several-files-in-one-plan' },
      corrupt: corruptRegistry((value: ParityView) => ({ ...value, files: [...value.files, 'src/script.ts'].sort() })),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C4: empty plans and a warm program that is reused while nothing changes
// ---------------------------------------------------------------------------

const CACHE_SCENARIOS = [
  'empty-plan',
  'a-plan-ahead-of-the-disk',
  'unchanged-sources-reuse-the-warm-program',
  'the-only-imported-file-changes',
  'a-target-outside-the-tsconfig-joins-the-plan',
] as const
type CacheScenario = (typeof CACHE_SCENARIOS)[number]

interface TrackedSnapshot {
  isDisposed: () => boolean
  dispose: () => void
}

/**
 * Run `run` and count the TypeScript snapshots that the oracle's API created
 * during it, the ones an update returns included, that are still open.
 */
function countingOpenSnapshots<T>(run: () => T): { value: T; open: number } {
  const created: Array<TrackedSnapshot> = []
  const track = (snapshot: Snapshot): Snapshot => {
    created.push(snapshot)
    const update = snapshot.update
    Object.defineProperty(snapshot, 'update', { configurable: true, value: (...args: Parameters<typeof update>) => track(update.apply(snapshot, args)) })
    return snapshot
  }
  // The wrapper passes on whatever it is called with. `createSnapshot` has that type through its overload without parameters.
  const create: (...args: Array<unknown>) => Snapshot = api.createSnapshot
  Object.defineProperty(api, 'createSnapshot', { configurable: true, value: (...args: Array<unknown>) => track(create.apply(api, args)) })
  try {
    const value = run()
    return { value, open: created.filter((snapshot) => !snapshot.isDisposed()).length }
  } finally {
    Object.defineProperty(api, 'createSnapshot', { configurable: true, value: create })
  }
}

const IMPORTING_TARGET = `import { loadLimit } from './limits'\nexport function work(n: number) { return n < loadLimit() }\n`

oracleProperty({
  id: 'contracts-incremental-snapshot-cache',
  owns: ['src/contracts.ts#renderFileModule', 'src/contracts.ts#generateFileRegistryModule'],
  law: {
    statement:
      'For every target plan and snapshot cache, generateFileRegistryModule returns an empty ExecutionPointFileRegistry when plan.files is empty or contains only global scripts, reuses cache.snapshot when sources are unchanged, and updates cache.snapshot incrementally when target sources change.',
    authority:
      'README.md:173 ("Targets are TypeScript modules configured in points.ep. Global scripts are skipped.") and README.md:167 ("updates incrementally via snapshot.update(...) on file saves."). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: the warm registry equals the cold one after every edit.',
    limits:
      'Cache reuse requires matching rootFiles and compilerOptions. Global scripts are covered by the parity law, and sequences of edits by the warm-equals-cold law. A snapshot counts as released when TypeScript reports it disposed.',
  },
  histories: {
    enumerated: CACHE_SCENARIOS.map((scenario) => ({ scenario })),
    states: ['empty-plan-rendered', 'plan-ahead-of-disk', 'warm-program-reused', 'only-import-edited', 'plan-outgrew-the-tsconfig'],
  },
  label: (history) => history.scenario,
  // A call without a cache leaves no snapshot open. A call with one leaves
  // exactly the warm program, which stays the same object until something
  // changed, and is released when it is replaced.
  model: (history: { scenario: CacheScenario }) => {
    switch (history.scenario) {
      case 'empty-plan':
        return { registryErrors: [], registryFiles: [], snapshotsLeftOpen: 0 }
      case 'a-plan-ahead-of-the-disk':
        return { registryErrors: [], fits: true, calls: ['later'] }
      case 'unchanged-sources-reuse-the-warm-program':
        return {
          reusedWhileUnchanged: true,
          sameTextWhileUnchanged: true,
          replacedAfterEdit: true,
          replacedProgramReleased: true,
          snapshotsLeftOpenByWarmRuns: 1,
          snapshotsLeftOpenByAColdRun: 0,
        }
      case 'the-only-imported-file-changes':
        return { warmEqualsCold: true }
      case 'a-target-outside-the-tsconfig-joins-the-plan':
        return { warmEqualsCold: true, files: ['other/extra.ts', 'src/app.ts'], registryErrors: [], previousProgramReleased: true }
    }
  },
  driver: (history, observe) => {
    const root = createProject({
      'src/app.ts': IMPORTING_TARGET,
      'src/limits.ts': `export function loadLimit(): number { return 5 }\n`,
      'other/extra.ts': `export function extra(n: number) { return n * 2 }\n`,
    })
    const cache: RegistryCache = {}
    const generate = (targets: ReadonlyArray<string>, warm: boolean) => {
      const plan = buildTargetPlan({ root, targets, api })
      const { text } = generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api, ...(warm ? { cache } : {}) })
      return { plan, text }
    }
    try {
      if (history.scenario === 'empty-plan') {
        observe('reach', 'empty-plan-rendered')
        const plan = { root, tsconfig: join(root, 'tsconfig.json'), files: [] }
        const { value, open } = countingOpenSnapshots(() => generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api }))
        const { reading } = compileRegistry(api, root, value.text, plan)
        observe('registry', { registryErrors: reading.registryErrors, registryFiles: reading.files, snapshotsLeftOpen: open })
        return
      }
      if (history.scenario === 'a-plan-ahead-of-the-disk') {
        // The plan holds each target as it was read for it; the registry is of that text, whatever the disk holds by then.
        observe('reach', 'plan-ahead-of-disk')
        const ahead = `function later(): string { return 'x' }\nexport function work(n: number) { return later() }\n`
        const file = join(root, 'src/app.ts')
        const plan = buildTargetPlan({ root, targets: ['src/app.ts'], overrides: new Map([[file, ahead]]), api })
        const { text } = generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api })
        writeFileSync(file, ahead)
        const { reading } = compileRegistry(api, root, text, plan)
        observe('registry', {
          registryErrors: reading.registryErrors,
          fits: Object.values(reading.nodes).every((node) => fitsOf(node.result) === 'fits'),
          calls: Object.values(reading.nodes).map((node) => node.descriptor.callee),
        })
        return
      }
      if (history.scenario === 'unchanged-sources-reuse-the-warm-program') {
        observe('reach', 'warm-program-reused')
        const warmRuns = countingOpenSnapshots(() => {
          const first = generate(['src/app.ts'], true).text
          const warm = cache.snapshot!
          const second = generate(['src/app.ts'], true).text
          const reusedWhileUnchanged = cache.snapshot === warm
          writeFileSync(join(root, 'src/app.ts'), `${IMPORTING_TARGET}export const more = 1\n`)
          generate(['src/app.ts'], true)
          return {
            reusedWhileUnchanged,
            sameTextWhileUnchanged: first === second,
            replacedAfterEdit: cache.snapshot !== warm,
            replacedProgramReleased: warm.isDisposed(),
          }
        })
        const coldRun = countingOpenSnapshots(() => generate(['src/app.ts'], false))
        observe('registry', { ...warmRuns.value, snapshotsLeftOpenByWarmRuns: warmRuns.open, snapshotsLeftOpenByAColdRun: coldRun.open })
        return
      }
      if (history.scenario === 'the-only-imported-file-changes') {
        observe('reach', 'only-import-edited')
        generate(['src/app.ts'], true)
        writeFileSync(join(root, 'src/limits.ts'), `export function loadLimit(): string { return '5' }\n`)
        observe('registry', { warmEqualsCold: generate(['src/app.ts'], true).text === generate(['src/app.ts'], false).text })
        return
      }
      observe('reach', 'plan-outgrew-the-tsconfig')
      generate(['src/app.ts'], true)
      const previous = cache.snapshot!
      const warm = generate(['src/app.ts', 'other/extra.ts'], true)
      const { reading } = compileRegistry(api, root, warm.text, warm.plan)
      observe('registry', {
        warmEqualsCold: warm.text === generate(['src/app.ts', 'other/extra.ts'], false).text,
        files: reading.files,
        registryErrors: reading.registryErrors,
        previousProgramReleased: previous.isDisposed(),
      })
    } catch (error) {
      observe('crash', error instanceof Error ? error.message : String(error))
    } finally {
      cache.snapshot?.dispose()
      removeProject(root)
    }
  },
  check: judge('incremental-snapshot-cache'),
  calibrations: [
    {
      name: 'a-new-program-for-unchanged-sources',
      law: 'incremental-snapshot-cache',
      history: { enumerated: 'unchanged-sources-reuse-the-warm-program' },
      corrupt: corruptRegistry((value) => ({ ...value, reusedWhileUnchanged: false })),
    },
    {
      name: 'a-snapshot-nobody-released',
      law: 'incremental-snapshot-cache',
      history: { enumerated: 'unchanged-sources-reuse-the-warm-program' },
      corrupt: corruptRegistry((value) => ({ ...value, snapshotsLeftOpenByAColdRun: 2 })),
    },
    {
      name: 'old-types-after-the-only-import-changed',
      law: 'incremental-snapshot-cache',
      history: { enumerated: 'the-only-imported-file-changes' },
      corrupt: corruptRegistry((value) => ({ ...value, warmEqualsCold: false })),
    },
  ],
})

// ---------------------------------------------------------------------------
// Cost: what is worked out once is asked of TypeScript once
// ---------------------------------------------------------------------------

/** An API of its own that counts its requests, so that no other history's requests are counted. */
const countingApi = new API({ cwd: repoRoot, collectTiming: true })
afterAll(() => {
  countingApi.close()
})

/** How many requests one registry of one module costs. */
function requestsFor(source: string): number {
  const root = createProject({ 'src/app.ts': source })
  try {
    const plan = buildTargetPlan({ root, targets: ['src/app.ts'], api: countingApi })
    const before = countingApi.getTimingInfo().totals.requestCount
    generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api: countingApi })
    return countingApi.getTimingInfo().totals.requestCount - before
  } finally {
    removeProject(root)
  }
}

const repeated = (count: number, text: string) => Array.from({ length: count }, () => text).join(', ')

const COST_SOURCES = {
  /** A row of `uses` elements; named types when `named`, primitives of the same number otherwise. */
  row: (uses: number, named: boolean) => `
interface Item { id: string }
interface Leaf { v: number }
type Row = [${repeated(uses, named ? 'Item, Date, Leaf' : 'string, number, boolean')}]
function row(): Row { return null as never }
export function leaf(): Leaf { return null as never }
export function work(r: Row) { const again = row(); return again.length + r.length }
`,
  /** A module with `exports` exported functions in which `privates` private types are looked up. */
  module: (exports: number, privates: number) => `
${Array.from({ length: privates }, (_, i) => `interface P${i} { v${i}: number }\nfunction make${i}(): P${i} { return null as never }`).join('\n')}
${Array.from({ length: exports }, (_, i) => `export function e${i}(n: number): string { return String(n) }`).join('\n')}
export function work() { return [${Array.from({ length: privates }, (_, i) => `make${i}()`).join(', ')}].length }
`,
  /** An export-reachable type with `members` members that refer to the type itself. */
  tree: (members: number) => `
interface Leaf { v: number }
interface Tree { ${Array.from({ length: members }, (_, i) => `r${i}: Tree`).join('; ')}; leaf: Leaf }
function leafOf(): Leaf { return null as never }
export function tree(): Tree { return null as never }
export function work() { return leafOf().v }
`,
}

oracleProperty({
  id: 'contracts-cost-of-names',
  owns: ['src/contracts.ts#createTypeEmitter', 'src/contracts.ts#buildExportIndex'],
  law: {
    statement:
      'For every type, the requests the generator makes to TypeScript for its name do not grow with how often the type is used; for every module, its exports are walked once however many private types are looked up in it; and for every export-reachable type, each member is read once.',
    authority:
      'FINDINGS.md, "What held": regenerating the registry for 160 target files takes about 0.2 s. The three caches change no result, so cost is their only promise, and @tanstack/oracles owes a cost law to a branch that exists only for speed (oracle-property.ts, `work`; maintainer decision of that package, 2026-11-12). These histories talk to a TypeScript server, which the built-in work bound does not judge, so the count of requests is observed instead. Approved as worded by Manuel Schiller (GitHub schiller-manuel), 2026-11-24.',
    limits:
      'Three relations between counts of requests, each over one module: a row of 15 or 60 elements, 1 or 21 exports with 1 or 3 private types, and a type with 2, 4, or 8 members that refer to itself. Time is not measured.',
  },
  histories: {
    enumerated: [{ relation: 'uses' as const }, { relation: 'module-walks' as const }, { relation: 'member-reads' as const }],
    states: ['type-used-often', 'several-private-types-in-one-module', 'self-referring-members'],
  },
  label: (history) => history.relation,
  // Each relation compares differences, so no count is predicted: only that a
  // cost which is paid once does not show up again in the difference.
  model: (history) => {
    switch (history.relation) {
      case 'uses':
        return { namedTypesCostTheSameAtEveryLength: true }
      case 'module-walks':
        return { moreExportsCostTheSameForMorePrivateTypes: true }
      case 'member-reads':
        return { twiceTheMembersCostTwiceTheReads: true }
    }
  },
  driver: (history, observe) => {
    try {
      if (history.relation === 'uses') {
        observe('reach', 'type-used-often')
        const few = requestsFor(COST_SOURCES.row(5, true)) - requestsFor(COST_SOURCES.row(5, false))
        const many = requestsFor(COST_SOURCES.row(20, true)) - requestsFor(COST_SOURCES.row(20, false))
        observe('registry', { namedTypesCostTheSameAtEveryLength: few === many })
      } else if (history.relation === 'module-walks') {
        observe('reach', 'several-private-types-in-one-module')
        const forOne = requestsFor(COST_SOURCES.module(21, 1)) - requestsFor(COST_SOURCES.module(1, 1))
        const forThree = requestsFor(COST_SOURCES.module(21, 3)) - requestsFor(COST_SOURCES.module(1, 3))
        observe('registry', { moreExportsCostTheSameForMorePrivateTypes: forOne === forThree })
      } else {
        observe('reach', 'self-referring-members')
        const [two, four, eight] = [2, 4, 8].map((members) => requestsFor(COST_SOURCES.tree(members))) as [number, number, number]
        observe('registry', { twiceTheMembersCostTwiceTheReads: eight - four === 2 * (four - two) })
      }
    } catch (error) {
      observe('crash', error instanceof Error ? error.message : String(error))
    }
  },
  check: judge('cost-of-names'),
  calibrations: [
    {
      name: 'a-name-asked-for-at-every-use',
      law: 'cost-of-names',
      history: { enumerated: 'uses' },
      corrupt: corruptRegistry(() => ({ namedTypesCostTheSameAtEveryLength: false })),
    },
    {
      name: 'a-walk-that-visits-a-type-again-and-again',
      law: 'cost-of-names',
      history: { enumerated: 'member-reads' },
      corrupt: corruptRegistry(() => ({ twiceTheMembersCostTwiceTheReads: false })),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law 2: a warm cache gives the registry a cold run gives
// ---------------------------------------------------------------------------

/**
 * The project: a target that imports `limits.ts`, which imports `deep.ts`,
 * and a global declaration file. None but the target is listed in the plan.
 * Each edit rewrites one file to one of its variants; variant 3 of the
 * target imports a file that the same edit creates.
 */
const EDITABLE = {
  target: {
    file: 'src/app.ts',
    variants: [
      `import { loadLimit } from './limits'\nexport function allowed(n: number, s: Shape) {\n  const limit = loadLimit()\n  return check(limit, s, n)\n}\nfunction check(...parts: unknown[]) { return parts }\n`,
      `import { loadLimit } from './limits'\nexport function allowed(n: number, s: Shape) {\n  const limit = [loadLimit()]\n  return check(limit, s.x, n)\n}\nfunction check(...parts: unknown[]) { return parts }\n`,
      `import { loadLimit } from './limits'\nexport function allowed(n: number, s: Shape) {\n  const shape = s\n  return check(loadLimit(), shape)\n}\nfunction check(...parts: unknown[]) { return parts }\n`,
      `import { loadLimit } from './limits'\nimport { extra } from './extra'\nexport function allowed(n: number, s: Shape) {\n  const limit = loadLimit()\n  return check(limit, s, extra())\n}\nfunction check(...parts: unknown[]) { return parts }\n`,
    ],
  },
  imported: {
    file: 'src/limits.ts',
    variants: [
      `import { deep } from './deep'\nexport function loadLimit() { return deep() }\n`,
      `import { deep } from './deep'\nexport function loadLimit() { return [deep()] }\n`,
      `import { deep } from './deep'\nexport function loadLimit() { return { value: deep() } }\n`,
    ],
  },
  transitive: {
    file: 'src/deep.ts',
    variants: [
      `export function deep(): number { return 5 }\n`,
      `export function deep(): string { return '5' }\n`,
      `export function deep(): Date { return new Date() }\n`,
    ],
  },
  ambient: {
    file: 'src/globals.d.ts',
    variants: [
      `interface Shape { x: number }\n`,
      `interface Shape { x: string }\n`,
      `interface Shape { x: boolean; y: number }\n`,
    ],
  },
} as const

type EditedFile = keyof typeof EDITABLE
interface Edit {
  file: EditedFile
  variant: number
}

const editArbitrary: fc.Arbitrary<Edit> = fc
  .tuple(fc.constantFrom<EditedFile>('target', 'imported', 'transitive', 'ambient'), fc.integer({ min: 0, max: 3 }))
  .map(
    ([file, variant]) => ({ file, variant: variant % EDITABLE[file].variants.length }),
    (edit) => [(edit as Edit).file, (edit as Edit).variant] as [EditedFile, number],
  )

const afterEdit = (edits: ReadonlyArray<Edit>, file: EditedFile, then: EditedFile) => {
  const first = edits.findIndex((edit) => edit.file === file && edit.variant !== 0)
  return first >= 0 && edits.slice(first + 1).some((edit) => edit.file === then)
}

oracleProperty({
  id: 'contracts-warm-registry-equals-cold',
  owns: ['src/contracts.ts#generateFileRegistryModule'],
  law: {
    statement:
      'For every sequence of edits to targets and to the files they import, the registry the warm mapper returns equals the registry a cold mapper returns.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: after every sequence of edits to targets and to the files they import, the warm mapper’s registry equals a cold mapper’s registry. README.md:167 promises that the snapshot updates on file saves.',
    limits:
      'Sequences of one to three edits over a target, a file it imports, a file that one imports, and a global declaration file, each with three or four variants. A file created where an import did not resolve is seen at the next edit of a file the warm program holds.',
  },
  histories: {
    arbitrary: fc.array(editArbitrary, { minLength: 1, maxLength: 3 }),
    runs: 6,
    fixedSeeds: [42],
    bases: 1,
    states: [
      'imported-file-edited',
      'transitively-imported-file-edited',
      'global-declaration-edited',
      'target-edited-after-an-imported-file',
      'file-created-and-imported',
    ],
    constructed: [
      {
        name: 'imported-file-then-target',
        enters: ['imported-file-edited', 'target-edited-after-an-imported-file'],
        build: (edits): Array<Edit> => [{ file: 'imported', variant: 1 }, { file: 'target', variant: 1 }, ...edits.slice(0, 1)],
      },
      {
        name: 'transitive-import-alone',
        enters: ['transitively-imported-file-edited'],
        build: (edits): Array<Edit> => [{ file: 'transitive', variant: 1 + (edits[0]!.variant % 2) }],
      },
      {
        name: 'global-declaration-alone',
        enters: ['global-declaration-edited'],
        build: (edits): Array<Edit> => [{ file: 'ambient', variant: 1 + (edits[0]!.variant % 2) }],
      },
      {
        name: 'target-imports-a-new-file',
        enters: ['file-created-and-imported'],
        build: (edits): Array<Edit> => [...edits.slice(0, 1), { file: 'target', variant: 3 }],
      },
    ],
  },
  reached: (edits) => [
    ...(edits.some((edit) => edit.file === 'imported' && edit.variant !== 0) ? ['imported-file-edited'] : []),
    ...(edits.some((edit) => edit.file === 'transitive' && edit.variant !== 0)
      ? ['transitively-imported-file-edited']
      : []),
    ...(edits.some((edit) => edit.file === 'ambient' && edit.variant !== 0) ? ['global-declaration-edited'] : []),
    ...(afterEdit(edits, 'imported', 'target') ? ['target-edited-after-an-imported-file'] : []),
    ...(edits.some((edit) => edit.file === 'target' && edit.variant === 3) ? ['file-created-and-imported'] : []),
  ],
  // After the last edit the project is an ordinary one, so the registry must
  // also fit it: the cold run is checked, not only repeated.
  model: (edits, trace) => ({ final: fitModel(edits, trace) }),
  driver: (edits, observe) => {
    const root = createProject(
      Object.fromEntries(Object.values(EDITABLE).map(({ file, variants }) => [file, variants[0]])),
    )
    const cache: RegistryCache = {}
    const generate = (warm: boolean) => {
      const plan = buildTargetPlan({ root, targets: ['src/app.ts'], api })
      const { text } = generateFileRegistryModule(plan, {
        fromFile: join(root, 'points.ep'),
        api,
        ...(warm ? { cache } : {}),
      })
      return { plan, text }
    }
    try {
      generate(true)
      let last = generate(true)
      for (const edit of edits) {
        if (edit.file === 'target' && edit.variant === 3) {
          writeFileSync(join(root, 'src/extra.ts'), `export function extra(): RegExp { return /x/ }\n`)
        }
        writeFileSync(join(root, EDITABLE[edit.file].file), EDITABLE[edit.file].variants[edit.variant]!)
        last = generate(true)
      }
      // Every prefix of a sequence is a sequence of its own, so one comparison at the end covers them all.
      observe('warm', last.text)
      observe('cold', generate(false).text)
      observe('plan', plannedNodes(last.plan))
      observe('final', fitView(compileRegistry(api, root, last.text, last.plan).reading))
    } catch (error) {
      observe('crash', error instanceof Error ? error.message : String(error))
    } finally {
      cache.snapshot?.dispose()
      removeProject(root)
    }
  },
  check: (_edits, observations, expected) => {
    const law = 'warm registry equals cold'
    const crash = observations.find((entry) => entry.checkpoint === 'crash')
    if (crash) return differs('crash', law, crash.value, 'no crash') ?? pass
    const read = (checkpoint: string) => observations.find((entry) => entry.checkpoint === checkpoint)?.value
    return (
      differs('warm', law, read('warm'), read('cold'), 'the warm registry differs from the cold one after the edits') ??
      differs('final', law, read('final'), expected.final) ??
      pass
    )
  },
  calibrations: [
    {
      name: 'a-warm-registry-that-kept-the-old-types',
      law: 'warm registry equals cold',
      history: { constructed: 'imported-file-then-target' },
      corrupt: (trace) =>
        trace.map((entry) => (entry.checkpoint === 'warm' ? { ...entry, value: `${String(entry.value)}// stale` } : entry)),
    },
  ],
})
