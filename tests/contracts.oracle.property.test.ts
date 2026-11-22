/**
 * This oracle owns `execution-points-prototype`'s virtual TypeScript contract
 * generator (`generateFileRegistryModule`), checked on the emitted
 * `ExecutionPointFileRegistry` declaration text and file list. It owns
 * `src/contracts.mjs`.
 *
 * ```ts
 * generateFileRegistryModule(plan, { api, cache })
 * // → virtual .ts module augmenting ExecutionPointFileRegistry with each target file's nodes:
 * //   result: exact return type (primitives, literals, any, readonly/optional/rest tuples, index signatures, export paths, or __EP_* helpers)
 * //   locals: exact control-flow-narrowed local types (across if guards, type predicates, and asserts calls)
 * ```
 *
 * Why does wrapping `assertUser(user)` in `(void { ... }, (assertUser(user)))`
 * during the Phase 2 probe lose `asserts u is User` narrowing for every
 * expression after it, and why does `[string, ...number[]]` turn into
 * `[string, number]` when `TupleType.elementFlags` is ignored?
 *
 * Three parts drive contract generation: the **type emitter** (`createTypeEmitter`
 * formatting intrinsic, literal, `any`, tuple, index-signature, function,
 * export-anchored, and nominal/structural `__EP_*` helper types), the **narrowed
 * local probe** (`projectNested` injecting capture probes into an incremental
 * snapshot while keeping `ExpressionStatement` assertion calls intact so
 * TypeScript's control-flow narrowing holds), and the **incremental snapshot
 * cache** (reusing and updating warm `typescript/sync` program snapshots across
 * edits).
 *
 * For every selectable expression and in-scope local binding whose type is a
 * primitive, literal, `any`, union, intersection, function signature, tuple
 * (`readonly`, optional `?`, and `...rest` elements), or object with properties
 * and index signatures (`[key: string]: V`), `generateFileRegistryModule` emits
 * valid TypeScript type syntax preserving those modifiers (`README.md:172`;
 * Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: emit `any`,
 * tuple element flags, and index-signature `valueType`).
 *
 * For every selectable expression preceded by an `if` guard, type predicate
 * (`u is T`), or assertion call (`asserts u is T`), `generateFileRegistryModule`
 * emits the control-flow-narrowed type of each captured local at that
 * expression (`README.md:40, 171`; Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-22: preserve `asserts` narrowing in Phase 2 probes).
 *
 * For every exported or export-reachable private type (via `NonNullable`,
 * `Awaited`, `ReturnType`, `Parameters`, array elements, or object properties),
 * `generateFileRegistryModule` emits an `import("./...")`-anchored type path;
 * for unreachable module-scope types it emits structural `__EP_*` interfaces
 * (or `unique symbol`-branded interfaces for nominal enums and classes with
 * private/protected members), while omitting types declared inside a local
 * function or block (`README.md:172`).
 *
 * For every `plan` and `cache`, `generateFileRegistryModule` skips non-module
 * global scripts, returns an empty `ExecutionPointFileRegistry` when no target
 * files are present, and updates `cache.snapshot` incrementally when target
 * sources change (`README.md:171`).
 *
 * The model predicts the exact emitted result and local type strings, helper
 * interface declarations, and file keys for each target construct. The driver
 * runs `buildTargetPlan` and `generateFileRegistryModule` against a shared
 * TypeScript 7.1 `API` instance and records the parsed registry entries.
 *
 * Types declared locally inside a function body or referencing unresolved local
 * type parameters cannot be named at module scope and are omitted.
 */
import { join } from 'node:path'
import fc from 'fast-check'
import { API } from 'typescript/sync'
import { afterAll } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { generateFileRegistryModule } from '../src/contracts.mjs'
import { buildTargetPlan } from '../src/discovery.mjs'

const root = process.cwd()
const sharedApi = new API({ cwd: root })
afterAll(() => {
  sharedApi.close()
})

function emitSingleFile(relPath: string, source: string, cache?: Record<string, unknown>) {
  const absFile = join(root, relPath)
  const overrides = new Map([[absFile, source]])
  const plan = buildTargetPlan({
    root,
    targets: [relPath],
    overrides,
    api: sharedApi,
  })
  return generateFileRegistryModule(plan, {
    fromFile: join(root, 'points.ep'),
    api: sharedApi,
    cache,
    overrides,
  })
}

function parseFirstNodeFromRegistry(text: string, callee: string) {
  const line = text
    .split('\n')
    .find((l) => l.includes(`readonly callee: ${JSON.stringify(callee)};`))
  if (!line) return null
  const resultMatch = /readonly result: (.*?); readonly locals: \{\s*(.*?)\s*\}\s*\};?$/.exec(line)
  if (!resultMatch) return null
  return {
    result: resultMatch[1]!.trim(),
    localsRaw: resultMatch[2]!.trim(),
  }
}

// ---------------------------------------------------------------------------
// Law C1: Primitive, literal, any, tuple, and index-signature type emission
// ---------------------------------------------------------------------------

const TYPE_CONSTRUCTS = [
  'primitives-and-literals',
  'any-return-and-local',
  'readonly-tuple',
  'optional-tuple',
  'rest-tuple',
  'string-index-signature',
  'readonly-number-index-signature',
  'callable-and-constructable-object',
  'union-and-intersection',
] as const

type TypeConstruct = (typeof TYPE_CONSTRUCTS)[number]

interface TypeConstructHistory {
  construct: TypeConstruct
}

const enumeratedTypeConstructHistories: ReadonlyArray<TypeConstructHistory> =
  TYPE_CONSTRUCTS.map((construct) => ({ construct }))

function typeConstructModel(history: TypeConstructHistory) {
  switch (history.construct) {
    case 'primitives-and-literals':
      return {
        found: true,
        result: '"ok"',
        localsRaw: 'readonly "b": true; readonly "n": number; readonly "s": string;',
      }
    case 'any-return-and-local':
      return {
        found: true,
        result: 'any',
        localsRaw: 'readonly "raw": any;',
      }
    case 'readonly-tuple':
      return {
        found: true,
        result: 'readonly [string, number]',
        localsRaw: 'readonly "tup": readonly [string, number];',
      }
    case 'optional-tuple':
      return {
        found: true,
        result: '[string, number?]',
        localsRaw: 'readonly "tup": [string, number?];',
      }
    case 'rest-tuple':
      return {
        found: true,
        result: '[string, ...number[]]',
        localsRaw: 'readonly "tup": [string, ...number[]];',
      }
    case 'string-index-signature':
      return {
        found: true,
        result: '{ [key: string]: boolean; }',
        localsRaw: 'readonly "dict": { [key: string]: boolean; };',
      }
    case 'readonly-number-index-signature':
      return {
        found: true,
        result: '{ readonly [key: number]: string; }',
        localsRaw: 'readonly "dict": { readonly [key: number]: string; };',
      }
    case 'callable-and-constructable-object':
      return {
        found: true,
        result: '((x: number, y?: string, ...rest: Array<boolean>) => string)',
        localsRaw: 'readonly "ctor": { new (a: string): { "id": string; }; readonly "tag"?: string; };',
      }
    case 'union-and-intersection':
      return {
        found: true,
        result: '(string | number)',
        localsRaw: 'readonly "both": (__EP_A_1 & __EP_B_2);',
      }
  }
}

oracleProperty({
  id: 'contracts-primitive-and-collection-types',
  owns: [
    'src/contracts.mjs#createTypeEmitter',
    'src/contracts.mjs#generateFileRegistryModule',
  ],
  law: {
    statement:
      'For every selectable expression and in-scope local binding whose type is a primitive, literal, any, union, intersection, function signature, tuple (including readonly, optional ?, and ...rest elements), or object with properties and index signatures ([key: K]: V), generateFileRegistryModule emits valid TypeScript type syntax preserving those modifiers.',
    authority:
      'README.md:172 ("emit virtual ExecutionPointFileRegistry") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: emit any, tuple elementFlags, and IndexInfo.valueType.',
    limits:
      'Local generic type parameters without concrete instantiations are not emitted.',
  },
  histories: {
    enumerated: enumeratedTypeConstructHistories,
    states: [
      'emitted-any-type',
      'emitted-tuple-modifiers',
      'emitted-index-signatures',
      'emitted-callable-and-composites',
    ],
  },
  label: (h) => h.construct,
  model: (history) => typeConstructModel(history),
  driver: (history, observe) => {
    try {
      let src: string
      switch (history.construct) {
        case 'primitives-and-literals':
          observe('reach', 'emitted-callable-and-composites')
          src = `
function target(): "ok" { return "ok" }
export function work(n: number, s: string) {
  const b = true
  return target()
}`
          break
        case 'any-return-and-local':
          observe('reach', 'emitted-any-type')
          src = `
function target(x: any): any { return x }
export function work(raw: any) {
  return target(raw)
}`
          break
        case 'readonly-tuple':
          observe('reach', 'emitted-tuple-modifiers')
          src = `
function target(): readonly [string, number] { return ["a", 1] }
export function work() {
  const tup: readonly [string, number] = ["a", 1]
  return target()
}`
          break
        case 'optional-tuple':
          observe('reach', 'emitted-tuple-modifiers')
          src = `
function target(): [string, number?] { return ["a"] }
export function work() {
  const tup: [string, number?] = ["a"]
  return target()
}`
          break
        case 'rest-tuple':
          observe('reach', 'emitted-tuple-modifiers')
          src = `
function target(): [string, ...number[]] { return ["a", 1, 2] }
export function work() {
  const tup: [string, ...number[]] = ["a", 1, 2]
  return target()
}`
          break
        case 'string-index-signature':
          observe('reach', 'emitted-index-signatures')
          src = `
function target(): { [key: string]: boolean } { return { a: true } }
export function work() {
  const dict: { [key: string]: boolean } = { a: true }
  return target()
}`
          break
        case 'readonly-number-index-signature':
          observe('reach', 'emitted-index-signatures')
          src = `
function target(): { readonly [key: number]: string } { return { 0: "x" } }
export function work() {
  const dict: { readonly [key: number]: string } = { 0: "x" }
  return target()
}`
          break
        case 'callable-and-constructable-object':
          observe('reach', 'emitted-callable-and-composites')
          src = `
function target(): (x: number, y?: string, ...rest: boolean[]) => string {
  return () => "ok"
}
export function work(ctor: { new (a: string): { id: string }; readonly tag?: string }) {
  return target()
}`
          break
        case 'union-and-intersection':
          observe('reach', 'emitted-callable-and-composites')
          src = `
type A = { a: string }
type B = { b: number }
function target(): string | number { return 1 }
export function work(both: A & B) {
  return target()
}`
          break
      }

      const { text } = emitSingleFile('examples/c1-target.ts', src)
      const parsed = parseFirstNodeFromRegistry(text, 'target')
      if (!parsed) {
        observe('type-construct', { found: false, result: '', localsRaw: '' })
        return
      }
      observe('type-construct', {
        found: true,
        result: parsed.result,
        localsRaw: parsed.localsRaw,
      })
    } catch (err) {
      observe('type-construct', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'type-construct')
    if (!entry) return differs('type-construct', 'primitive-and-collection-types', undefined, expected) ?? pass
    return differs('type-construct', 'primitive-and-collection-types', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-emitted-type-construct',
      law: 'primitive-and-collection-types',
      history: { enumerated: 'primitives-and-literals' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'type-construct'
            ? { ...o, value: { ...(o.value as object), result: 'never' } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C2: Control-flow narrowing across if guards, type predicates, and asserts
// ---------------------------------------------------------------------------

const NARROWING_KINDS = [
  'truthiness-throw-guard',
  'type-predicate-if',
  'assertion-function-call',
  'nested-call-narrowing',
] as const

type NarrowingKind = (typeof NARROWING_KINDS)[number]

interface NarrowingHistory {
  kind: NarrowingKind
}

const enumeratedNarrowingHistories: ReadonlyArray<NarrowingHistory> = NARROWING_KINDS.map(
  (kind) => ({ kind }),
)

function narrowingModel(_history: NarrowingHistory) {
  return {
    sendUserType: 'import("./examples/c2-target.js").User',
    excludesNull: true,
  }
}

oracleProperty({
  id: 'contracts-control-flow-narrowing',
  owns: [
    'src/contracts.mjs#projectNested',
    'src/contracts.mjs#generateFileRegistryModule',
  ],
  law: {
    statement:
      'For every selectable expression preceded by an if guard, type predicate (u is T), or assertion call (asserts u is T), generateFileRegistryModule emits the control-flow-narrowed type of each captured local at that expression.',
    authority:
      'README.md:40 ("locals.user is narrowed to non-null User"), README.md:171 ("narrowed local types come from a nested incremental probe"), and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: preserve asserts narrowing in Phase 2 probes.',
    limits:
      'Assertion calls must be direct ExpressionStatements in their enclosing block or file.',
  },
  histories: {
    enumerated: enumeratedNarrowingHistories,
    states: [
      'narrowed-by-throw-guard',
      'narrowed-by-type-predicate',
      'narrowed-by-asserts-call',
      'narrowed-in-nested-call',
    ],
  },
  label: (h) => h.kind,
  model: (history) => narrowingModel(history),
  driver: (history, observe) => {
    try {
      let body: string
      switch (history.kind) {
        case 'truthiness-throw-guard':
          observe('reach', 'narrowed-by-throw-guard')
          body = `
  if (!user) throw new Error('missing')
  return send(user.id)`
          break
        case 'type-predicate-if':
          observe('reach', 'narrowed-by-type-predicate')
          body = `
  if (isUser(user)) {
    return send(user.id)
  }
  return ''`
          break
        case 'assertion-function-call':
          observe('reach', 'narrowed-by-asserts-call')
          body = `
  assertUser(user)
  return send(user.id)`
          break
        case 'nested-call-narrowing':
          observe('reach', 'narrowed-in-nested-call')
          body = `
  assertUser(user)
  return outerWrap(send(user.id))`
          break
      }

      const src = `
export interface User { id: string }
function isUser(u: User | null): u is User { return u !== null }
function assertUser(u: User | null): asserts u is User { if (!u) throw new Error('missing') }
function outerWrap(s: string) { return s }
function send(id: string) { return id }
export function work(user: User | null) {${body}
}
`
      const { text } = emitSingleFile('examples/c2-target.ts', src)
      const parsed = parseFirstNodeFromRegistry(text, 'send')
      const userMatch = /readonly "user": ([^;]+);/.exec(parsed?.localsRaw ?? '')
      const sendUserType = userMatch ? userMatch[1]!.trim() : 'missing'
      observe('narrowing', {
        sendUserType,
        excludesNull: !sendUserType.includes('null'),
      })
    } catch (err) {
      observe('narrowing', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'narrowing')
    if (!entry) return differs('narrowing', 'control-flow-narrowing', undefined, expected) ?? pass
    return differs('narrowing', 'control-flow-narrowing', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'un-narrowed-nullable-user',
      law: 'control-flow-narrowing',
      history: { enumerated: 'truthiness-throw-guard' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'narrowing'
            ? { ...o, value: { sendUserType: 'null | User', excludesNull: false } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C3: Export-anchored type paths, nominal brands, and structural helpers
// ---------------------------------------------------------------------------

const EXPORT_CASES = [
  'direct-exported-interface',
  'reachable-via-nonnullable-param',
  'reachable-via-awaited-return',
  'reachable-via-array-and-prop',
  'unreachable-structural-interface',
  'unreachable-nominal-class-and-enum',
  'local-block-type-omitted',
  'mts-import-specifier',
] as const

type ExportCase = (typeof EXPORT_CASES)[number]

interface ExportHistory {
  exportCase: ExportCase
}

const enumeratedExportHistories: ReadonlyArray<ExportHistory> = EXPORT_CASES.map((exportCase) => ({
  exportCase,
}))

function exportModel(history: ExportHistory) {
  switch (history.exportCase) {
    case 'direct-exported-interface':
      return {
        result: 'import("./examples/c3-target.js").Quote',
        hasBrand: false,
        hasHelperInterface: false,
      }
    case 'reachable-via-nonnullable-param':
      return {
        result: 'NonNullable<Parameters<typeof import("./examples/c3-target.js").work>[0]>',
        hasBrand: false,
        hasHelperInterface: false,
      }
    case 'reachable-via-awaited-return':
      return {
        result: 'Awaited<ReturnType<typeof import("./examples/c3-target.js").work>>',
        hasBrand: false,
        hasHelperInterface: false,
      }
    case 'reachable-via-array-and-prop':
      return {
        result: '((ReturnType<typeof import("./examples/c3-target.js").work>)[number])["item"]',
        hasBrand: false,
        hasHelperInterface: false,
      }
    case 'unreachable-structural-interface':
      return {
        result: '__EP_InternalBox_1',
        hasBrand: false,
        hasHelperInterface: true,
      }
    case 'unreachable-nominal-class-and-enum':
      return {
        result: '__EP_SecretVault_1',
        hasBrand: true,
        hasHelperInterface: true,
      }
    case 'local-block-type-omitted':
      return {
        result: 'number',
        hasBrand: false,
        hasHelperInterface: false,
      }
    case 'mts-import-specifier':
      return {
        result: 'import("./examples/c3-target.mjs").Quote',
        hasBrand: false,
        hasHelperInterface: false,
      }
  }
}

oracleProperty({
  id: 'contracts-export-paths-and-helpers',
  owns: [
    'src/contracts.mjs#buildExportIndex',
    'src/contracts.mjs#isNominalUnexported',
    'src/contracts.mjs#typeImportSpecifier',
    'src/contracts.mjs#hasLocalDeclaration',
    'src/contracts.mjs#generateFileRegistryModule',
  ],
  law: {
    statement:
      'For every exported or export-reachable private type, generateFileRegistryModule emits an import()-anchored type path; for unreachable module-scope types it emits structural __EP_* interfaces or unique-symbol-branded nominal interfaces, while omitting types declared inside a local function or block.',
    authority:
      'README.md:172 ("Export-reachable private types (Quote, User, Order) preserve exact identity via export-anchored paths; unreachable private types emit structural or unique-symbol-branded helpers.").',
    limits:
      'Export reachability BFS searches up to depth 4 and objects with up to 24 properties.',
  },
  histories: {
    enumerated: enumeratedExportHistories,
    states: [
      'direct-and-reachable-exports',
      'structural-and-nominal-helpers',
      'local-type-omitted',
    ],
  },
  label: (h) => h.exportCase,
  model: (history) => exportModel(history),
  driver: (history, observe) => {
    try {
      let relFile = 'examples/c3-target.ts'
      let src: string
      switch (history.exportCase) {
        case 'direct-exported-interface':
          observe('reach', 'direct-and-reachable-exports')
          src = `
export interface Quote { total: number }
function target(): Quote { return { total: 1 } }
export function work() { return target() }`
          break
        case 'reachable-via-nonnullable-param':
          observe('reach', 'direct-and-reachable-exports')
          src = `
interface PrivateUser { id: string }
function target(): PrivateUser { return { id: "1" } }
export function work(u: PrivateUser | null): string { return target().id }`
          break
        case 'reachable-via-awaited-return':
          observe('reach', 'direct-and-reachable-exports')
          src = `
interface PrivateResult { ok: boolean }
function target(): PrivateResult { return { ok: true } }
export async function work(): Promise<PrivateResult> { return target() }`
          break
        case 'reachable-via-array-and-prop':
          observe('reach', 'direct-and-reachable-exports')
          src = `
interface Leaf { code: number }
function target(): Leaf { return { code: 1 } }
export function work(): Array<{ item: Leaf }> { return [{ item: target() }] }`
          break
        case 'unreachable-structural-interface':
          observe('reach', 'structural-and-nominal-helpers')
          src = `
interface InternalBox { count: number }
function target(): InternalBox { return { count: 1 } }
export function work() { const b = target(); return b.count }`
          break
        case 'unreachable-nominal-class-and-enum':
          observe('reach', 'structural-and-nominal-helpers')
          src = `
class SecretVault { private secret = 1; public id = "v" }
function target(): SecretVault { return new SecretVault() }
export function work() { const v = target(); return v.id }`
          break
        case 'local-block-type-omitted':
          observe('reach', 'local-type-omitted')
          src = `
function target(): number { return 42 }
export function work() {
  interface LocalOnly { x: number }
  const localObj: LocalOnly = { x: 1 }
  return target()
}`
          break
        case 'mts-import-specifier':
          observe('reach', 'direct-and-reachable-exports')
          relFile = 'examples/c3-target.mts'
          src = `
export interface Quote { total: number }
function target(): Quote { return { total: 1 } }
export function work() { return target() }`
          break
      }

      const { text } = emitSingleFile(relFile, src)
      const parsed = parseFirstNodeFromRegistry(text, 'target')
      observe('export-path', {
        result: parsed?.result ?? 'missing',
        hasBrand: text.includes('unique symbol'),
        hasHelperInterface: text.includes('interface __EP_'),
      })
    } catch (err) {
      observe('export-path', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'export-path')
    if (!entry) return differs('export-path', 'export-paths-and-helpers', undefined, expected) ?? pass
    return differs('export-path', 'export-paths-and-helpers', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-export-path',
      law: 'export-paths-and-helpers',
      history: { enumerated: 'direct-exported-interface' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'export-path'
            ? { ...o, value: { ...(o.value as object), result: 'unknown' } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law C4: Empty plans, global scripts, and warm incremental snapshot caching
// ---------------------------------------------------------------------------

const CACHE_SCENARIOS = ['empty-plan', 'global-script-skipped', 'incremental-cache-update'] as const
type CacheScenario = (typeof CACHE_SCENARIOS)[number]

interface CacheHistory {
  scenario: CacheScenario
}

const enumeratedCacheHistories: ReadonlyArray<CacheHistory> = CACHE_SCENARIOS.map((scenario) => ({
  scenario,
}))

function cacheModel(history: CacheHistory) {
  switch (history.scenario) {
    case 'empty-plan':
      return {
        files: [],
        hasRegistryBlock: true,
      }
    case 'global-script-skipped':
      return {
        files: [],
        hasRegistryBlock: true,
      }
    case 'incremental-cache-update':
      return {
        firstResult: 'number',
        secondReusedSnapshot: true,
        thirdUpdatedResult: 'string',
      }
  }
}

oracleProperty({
  id: 'contracts-incremental-snapshot-cache',
  owns: [
    'src/contracts.mjs#renderFileModule',
    'src/contracts.mjs#generateFileRegistryModule',
  ],
  law: {
    statement:
      'For every target plan and snapshot cache, generateFileRegistryModule returns an empty ExecutionPointFileRegistry when plan.files is empty or contains only global scripts, reuses cache.snapshot when sources are unchanged, and updates cache.snapshot incrementally when target sources change.',
    authority:
      'README.md:170-171 ("Targets are TypeScript modules configured in points.ep. Global scripts are skipped." and "updates incrementally via snapshot.update(...) on file saves.").',
    limits:
      'Cache reuse requires matching rootFiles and compilerOptions.',
  },
  histories: {
    enumerated: enumeratedCacheHistories,
    states: [
      'empty-plan-rendered',
      'global-script-ignored',
      'warm-cache-reused-and-updated',
    ],
  },
  label: (h) => h.scenario,
  model: (history) => cacheModel(history),
  driver: (history, observe) => {
    try {
      if (history.scenario === 'empty-plan') {
        observe('reach', 'empty-plan-rendered')
        const res = generateFileRegistryModule(
          { root, tsconfig: join(root, 'tsconfig.json'), files: [] },
          { api: sharedApi },
        )
        observe('cache', {
          files: res.files,
          hasRegistryBlock: res.text.includes('interface ExecutionPointFileRegistry'),
        })
        return
      }

      if (history.scenario === 'global-script-skipped') {
        observe('reach', 'global-script-ignored')
        const res = emitSingleFile('examples/global-script.ts', 'function target() { return 1 }\n')
        observe('cache', {
          files: res.files,
          hasRegistryBlock: res.text.includes('interface ExecutionPointFileRegistry'),
        })
        return
      }

      observe('reach', 'warm-cache-reused-and-updated')
      const cache: {
        snapshot?: { dispose?: () => void }
        programId?: unknown
        configKey?: string
        sources?: Map<string, string>
      } = {}
      try {
        const first = emitSingleFile(
          'examples/c4-inc.ts',
          'function target(): number { return 1 }\nexport function work() { return target() }\n',
          cache,
        )
        const snapAfterFirst = cache.snapshot
        emitSingleFile(
          'examples/c4-inc.ts',
          'function target(): number { return 1 }\nexport function work() { return target() }\n',
          cache,
        )
        const secondReusedSnapshot = cache.snapshot === snapAfterFirst
        const third = emitSingleFile(
          'examples/c4-inc.ts',
          'function target(): string { return "updated" }\nexport function work() { return target() }\n',
          cache,
        )
        observe('cache', {
          firstResult: parseFirstNodeFromRegistry(first.text, 'target')?.result ?? 'missing',
          secondReusedSnapshot,
          thirdUpdatedResult: parseFirstNodeFromRegistry(third.text, 'target')?.result ?? 'missing',
        })
      } finally {
        cache.snapshot?.dispose?.()
      }
    } catch (err) {
      observe('cache', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'cache')
    if (!entry) return differs('cache', 'incremental-snapshot-cache', undefined, expected) ?? pass
    return differs('cache', 'incremental-snapshot-cache', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'stale-incremental-cache-result',
      law: 'incremental-snapshot-cache',
      history: { enumerated: 'incremental-cache-update' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'cache'
            ? { ...o, value: { ...(o.value as object), thirdUpdatedResult: 'number' } }
            : o,
        ),
    },
  ],
})
