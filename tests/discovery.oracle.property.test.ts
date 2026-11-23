/**
 * This oracle owns `execution-points-prototype`'s AST expression discovery,
 * structural node addressing, TDZ-safe local binding capture, and manifest
 * target resolution, checked on the output of `indexTargetFile`,
 * `resolveTargetFiles`, `loadManifest`, and `buildTargetPlan`. It owns
 * `src/discovery.mjs`.
 *
 * ```ts
 * indexTargetFile('/app/a.ts', 'export function checkout(x = init()) { return items.map(y => send(x + y)) }', '/app', api)
 * // → init() has inFunction: 'checkout', id: 'a.ts#checkout:CallExpression:init:0', captures: []
 * // → send(x + y) has inFunction: 'checkout', id: 'a.ts#checkout:CallExpression:send:0', captures: ['x', 'y']
 * // → x + y has inFunction: 'checkout', id: 'a.ts#checkout:BinaryExpression:+:0', captures: ['x', 'y']
 * ```
 *
 * Why must `send()` inside `{ const res = send(); const x = 'inner' }` omit an
 * outer `const x = 'outer'` from `captures`, and why must `getSource()` in
 * `for (const item of getSource())` omit `'item'`?
 *
 * Three parts govern discovery: the **selectable filter** (`isSelectableExpression`
 * accepting `CallExpression`, non-assignment `BinaryExpression`, and
 * `ConditionalExpression` nodes except in reference-only or unsupported AST
 * positions), the **structural address** (resolving the nearest named enclosing
 * function, callee or operator, 0-based `nth` counter, and composite
 * `relativeFile#inFunction:kind:name:nth` id), and the **lexical readiness map**
 * (walking scope frames from innermost to outermost so bindings in their
 * Temporal Dead Zone are neither captured directly nor leaked from shadowed
 * outer frames).
 *
 * For every TypeScript source module, `indexTargetFile` indexes every
 * `CallExpression`, non-assignment `BinaryExpression`, and `ConditionalExpression`
 * that is not in a reference-only target position (direct callee of a call or
 * `new`, tagged-template tag, left-hand side of assignment, or operand of
 * `delete`/`++`/`--`, including through parenthesized or type-assertion
 * wrappers) and does not contain `await`, `yield`, `super`, optional chaining
 * (`?.`), dynamic `import()`, or direct `eval` (`README.md:171-173`,
 * `src/discovery.mjs:30-81`).
 *
 * For every indexed expression in a target module, `indexTargetFile` assigns
 * `inFunction` to the nearest named enclosing function (or `'(anonymous)'` when
 * only unnamed functions enclose the expression, and `null` at module top
 * level), extracts `callee` or `operator`, assigns the 0-based `nth` index
 * within `(inFunction, kind, callee | operator)`, and formats `id` as
 * `${relativeFile}#${inFunction ?? '<top>'}:${kind}:${callee ?? operator ?? '?'}:${nth}`
 * (`README.md:48`; Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-22: nearest named enclosing function and structural node IDs).
 *
 * For every indexed expression at offset `start`, `node.captures` is the
 * sorted list of identifier bindings in enclosing non-module scopes whose
 * declaration is initialized at or before `start` (`p.end <= start` for
 * parameters, `node.expression.end <= start` for `for-of`/`for-in` bindings,
 * `decl.end <= start` for `let`/`const`/`class`, and hoisted within their
 * block for local `function` declarations) and is not shadowed by an
 * uninitialized binding of the same name in an inner enclosing scope
 * (`README.md:171`).
 *
 * For every target manifest and target list, `loadManifest`,
 * `resolveTargetFiles`, and `buildTargetPlan` resolve explicit paths and globs
 * relative to `root` in sorted order, use in-memory `overrides` when provided,
 * skip missing unoverridden files, and index each resolved file (`README.md:122`).
 *
 * The model computes expected node lists, structural IDs, and TDZ-safe capture
 * sets directly from the generated AST specification. The driver invokes
 * `indexTargetFile`, `resolveTargetFiles`, `loadManifest`, and `buildTargetPlan`
 * using a shared TypeScript 7.1 `API` instance and records the resulting
 * descriptors.
 *
 * Scope analysis covers syntactic lexical bindings within the target file;
 * module-scope globals and imported bindings are excluded from `captures`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { API } from 'typescript/sync'
import { afterAll } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import {
  buildTargetPlan,
  indexTargetFile,
  loadManifest,
  resolveTargetFiles,
} from '../src/discovery.mjs'

const sharedApi = new API({ cwd: process.cwd() })
afterAll(() => {
  sharedApi.close()
})

// ---------------------------------------------------------------------------
// Law D1: Selectable expression filtering
// ---------------------------------------------------------------------------

const SELECTABLE_CASES = [
  'simple-call',
  'binary-add',
  'binary-logical-and',
  'conditional-ternary',
  'chained-method-call',
  'rhs-of-assignment',
  'prefix-not-call',
  'assign-equals',
  'assign-plus-equals',
  'assign-logical-or',
  'assign-bitwise-xor',
  'direct-callee-call',
  'wrapped-direct-callee',
  'new-callee-target',
  'tagged-template-tag',
  'lhs-of-assignment',
  'delete-operand',
  'postfix-increment-operand',
  'prefix-decrement-operand',
  'contains-await',
  'contains-yield',
  'contains-super',
  'contains-optional-chain',
  'contains-optional-call',
  'contains-dynamic-import',
  'contains-direct-eval',
] as const

type SelectableCase = (typeof SELECTABLE_CASES)[number]

interface SelectableHistory {
  exprCase: SelectableCase
  wrapParens: boolean
  wrapAsAssertion: boolean
}

const selectableArbitrary: fc.Arbitrary<SelectableHistory> = fc.record({
  exprCase: fc.constantFrom(...SELECTABLE_CASES),
  wrapParens: fc.boolean(),
  wrapAsAssertion: fc.boolean(),
})

function buildExpressionSnippet(history: SelectableHistory): string {
  const wrapTarget = (inner: string) => {
    let cur = inner
    if (history.wrapAsAssertion) cur = `(${cur} as any)`
    if (history.wrapParens) cur = `(${cur})`
    return cur
  }

  switch (history.exprCase) {
    case 'simple-call':
      return 'send(a)'
    case 'binary-add':
      return 'a + b'
    case 'binary-logical-and':
      return 'a && b'
    case 'conditional-ternary':
      return 'cond ? a : b'
    case 'chained-method-call':
      return `${wrapTarget('getClient()')}.send(a)`
    case 'rhs-of-assignment':
      return `a = ${wrapTarget('send(b)')}`
    case 'prefix-not-call':
      return `!${wrapTarget('send(a)')}`
    case 'assign-equals':
      return 'a = b'
    case 'assign-plus-equals':
      return 'a += b'
    case 'assign-logical-or':
      return 'a ||= b'
    case 'assign-bitwise-xor':
      return 'a ^= b'
    case 'direct-callee-call':
      return 'getFn()(a)'
    case 'wrapped-direct-callee':
      return `${wrapTarget('getFn()')}(a)`
    case 'new-callee-target':
      return `new ${wrapTarget('(getCtor())')}()`
    case 'tagged-template-tag':
      return `${wrapTarget('getTag()')}\`hello\``
    case 'lhs-of-assignment':
      return `${wrapTarget('(cond ? obj.a : obj.b)')} = 1`
    case 'delete-operand':
      return `delete ${wrapTarget('(cond ? obj.a : obj.b)')}`
    case 'postfix-increment-operand':
      return `${wrapTarget('(cond ? obj.a : obj.b)')}++`
    case 'prefix-decrement-operand':
      return `--${wrapTarget('(cond ? obj.a : obj.b)')}`
    case 'contains-await':
      return 'send(await a)'
    case 'contains-yield':
      return 'send(yield a)'
    case 'contains-super':
      return 'super.send(a)'
    case 'contains-optional-chain':
      return 'client?.send(a)'
    case 'contains-optional-call':
      return 'send?.(a)'
    case 'contains-dynamic-import':
      return 'import("./other")'
    case 'contains-direct-eval':
      return 'eval("1 + 1")'
  }
}

function selectableModel(history: SelectableHistory) {
  let nodes: Array<{ kind: string; callee?: string; operator?: string }>
  switch (history.exprCase) {
    case 'simple-call':
    case 'rhs-of-assignment':
    case 'prefix-not-call':
      nodes = [{ kind: 'CallExpression', callee: 'send' }]
      break
    case 'binary-add':
      nodes = [{ kind: 'BinaryExpression', operator: '+' }]
      break
    case 'binary-logical-and':
      nodes = [{ kind: 'BinaryExpression', operator: '&&' }]
      break
    case 'conditional-ternary':
      nodes = [{ kind: 'ConditionalExpression' }]
      break
    case 'chained-method-call':
      nodes = [
        { kind: 'CallExpression', callee: 'send' },
        { kind: 'CallExpression', callee: 'getClient' },
      ]
      break
    case 'direct-callee-call':
    case 'wrapped-direct-callee':
      nodes = [{ kind: 'CallExpression', callee: '(anonymous)' }]
      break
    default:
      nodes = []
      break
  }
  return {
    nodes,
    activeLeasesAfter: 0,
  }
}

const enumeratedSelectableHistories: ReadonlyArray<SelectableHistory> = SELECTABLE_CASES.flatMap(
  (exprCase) => [
    { exprCase, wrapParens: false, wrapAsAssertion: false },
    { exprCase, wrapParens: true, wrapAsAssertion: true },
  ],
)

oracleProperty({
  id: 'discovery-selectable-expressions',
  owns: ['src/discovery.mjs#isSelectableExpression', 'src/discovery.mjs#indexTargetFile'],
  law: {
    statement:
      'For every TypeScript source module, indexTargetFile indexes every CallExpression, non-assignment BinaryExpression, and ConditionalExpression that is not in a reference-only target position and does not contain await, yield, super, optional chaining, dynamic import(), or direct eval, and disposes its source-file lease.',
    authority:
      'README.md:171-173 ("Indexed target kinds are ordinary CallExpression, non-assignment BinaryExpression, and ConditionalExpression nodes (including nested expressions). Reference-only positions and expressions containing await, yield, super, optional chains, dynamic import(), or direct eval are skipped.").',
    limits:
      'Only CallExpression, BinaryExpression, and ConditionalExpression kinds are selectable; histories are bounded-exhaustive over 25 representative expression templates with and without parenthesized and type-assertion wrappers.',
  },
  histories: {
    enumerated: enumeratedSelectableHistories,
    states: [
      'indexed-selectable-expr',
      'skipped-assignment-expr',
      'skipped-reference-target',
      'skipped-unsupported-inner',
    ],
  },
  label: (h) => `${h.exprCase}:${h.wrapParens ? 'wrapped' : 'bare'}`,
  model: (history) => selectableModel(history),
  driver: (history, observe) => {
    try {
      if (
        [
          'simple-call',
          'binary-add',
          'binary-logical-and',
          'conditional-ternary',
          'chained-method-call',
          'rhs-of-assignment',
          'prefix-not-call',
        ].includes(history.exprCase)
      ) {
        observe('reach', 'indexed-selectable-expr')
      } else if (
        ['assign-equals', 'assign-plus-equals', 'assign-logical-or', 'assign-bitwise-xor'].includes(
          history.exprCase,
        )
      ) {
        observe('reach', 'skipped-assignment-expr')
      } else if (
        [
          'direct-callee-call',
          'wrapped-direct-callee',
          'new-callee-target',
          'tagged-template-tag',
          'lhs-of-assignment',
          'delete-operand',
          'postfix-increment-operand',
          'prefix-decrement-operand',
        ].includes(history.exprCase)
      ) {
        observe('reach', 'skipped-reference-target')
      } else {
        observe('reach', 'skipped-unsupported-inner')
      }

      const expr = buildExpressionSnippet(history)
      const src =
        history.exprCase === 'contains-yield'
          ? `export function* gen(a: any, b: any, cond: boolean, obj: any, client: any) { return ${expr}; }`
          : history.exprCase === 'contains-super'
            ? `class B { send(x: any) { return x } }\nexport class C extends B { work(a: any) { return ${expr}; } }`
            : `export async function work(a: any, b: any, cond: boolean, obj: any, client: any) { return ${expr}; }`

      const indexed = indexTargetFile('/app/sel.ts', src, '/app', sharedApi)
      const nodes = indexed.nodes.map((n) => ({
        kind: n.kind,
        ...(n.callee !== undefined ? { callee: n.callee } : {}),
        ...(n.operator !== undefined ? { operator: n.operator } : {}),
      }))
      const activeLeasesAfter = (
        sharedApi as unknown as { activeSourceFileLeases: Set<unknown> }
      ).activeSourceFileLeases.size
      observe('selectable', { nodes, activeLeasesAfter })
    } catch (err) {
      observe('selectable', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'selectable')
    if (!entry) return differs('selectable', 'selectable-expressions', undefined, expected) ?? pass
    return differs('selectable', 'selectable-expressions', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-selectable-list',
      law: 'selectable-expressions',
      history: { enumerated: 'chained-method-call:bare' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'selectable'
            ? { ...o, value: { ...(o.value as object), nodes: [] } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law D2: Enclosing function resolution, callee/operator, nth, and structural ID
// ---------------------------------------------------------------------------

const CONTAINER_KINDS = [
  'top-level',
  'fn-decl',
  'default-export-anonymous-fn',
  'var-arrow',
  'destructured-var-arrow',
  'prop-arrow',
  'computed-prop-arrow',
  'named-fn-expr',
  'class-method',
  'class-getter',
  'class-setter',
  'class-constructor',
  'callback-inside-fn',
  'top-level-anonymous-iife',
] as const

type ContainerKind = (typeof CONTAINER_KINDS)[number]

const CALLEE_FORMS = ['identifier', 'property-access', 'string-element-access', 'computed-element'] as const
type CalleeForm = (typeof CALLEE_FORMS)[number]

interface MetadataHistory {
  container: ContainerKind
  calleeForm: CalleeForm
  repeatCall: boolean
  addCommentAndSiblingEdit: boolean
}

const metadataArbitrary: fc.Arbitrary<MetadataHistory> = fc.record({
  container: fc.constantFrom(...CONTAINER_KINDS),
  calleeForm: fc.constantFrom(...CALLEE_FORMS),
  repeatCall: fc.boolean(),
  addCommentAndSiblingEdit: fc.boolean(),
})

function expectedInFunction(container: ContainerKind): string | null {
  switch (container) {
    case 'top-level':
      return null
    case 'fn-decl':
    case 'callback-inside-fn':
      return 'checkout'
    case 'var-arrow':
      return 'arrowVar'
    case 'prop-arrow':
      return 'propFn'
    case 'named-fn-expr':
      return 'namedExpr'
    case 'class-method':
      return 'runMethod'
    case 'class-getter':
      return 'total'
    case 'class-setter':
      return 'total'
    case 'class-constructor':
      return 'constructor'
    case 'default-export-anonymous-fn':
    case 'destructured-var-arrow':
    case 'computed-prop-arrow':
    case 'top-level-anonymous-iife':
      return '(anonymous)'
  }
}

function expectedCallee(form: CalleeForm): string {
  return form === 'computed-element' ? '(anonymous)' : 'send'
}

function metadataModel(history: MetadataHistory) {
  const inFn = expectedInFunction(history.container)
  const callee = expectedCallee(history.calleeForm)
  const fnSegment = inFn ?? '<top>'
  const count = history.repeatCall ? 2 : 1
  const nodes = Array.from({ length: count }, (_, nth) => ({
    id: `meta.ts#${fnSegment}:CallExpression:${callee}:${nth}`,
    file: '/app/meta.ts',
    relativeFile: 'meta.ts',
    kind: 'CallExpression',
    inFunction: inFn,
    callee,
    nth,
    sliceMatchesCall: true,
    validSpan: true,
  }))
  return {
    file: '/app/meta.ts',
    relativeFile: 'meta.ts',
    sourceMatches: true,
    nodes,
    trailingTopLevelInFunction: null,
    idsUnchangedAfterCommentEdit: true,
  }
}

function buildMetadataSource(history: MetadataHistory, withExtraNoise: boolean): string {
  const callExpr =
    history.calleeForm === 'identifier'
      ? 'send(1)'
      : history.calleeForm === 'property-access'
        ? 'client.send(1)'
        : history.calleeForm === 'string-element-access'
          ? 'client["send"](1)'
          : 'handlers[0](1)'

  const bodyStmt = history.repeatCall ? `[${callExpr}, ${callExpr}]` : callExpr

  let core: string
  switch (history.container) {
    case 'top-level':
      core = `export const res = ${bodyStmt};`
      break
    case 'fn-decl':
      core = `export function checkout() { return ${bodyStmt}; }`
      break
    case 'default-export-anonymous-fn':
      core = `export default function () { return ${bodyStmt}; }`
      break
    case 'var-arrow':
      core = `export const arrowVar = () => ${bodyStmt};`
      break
    case 'destructured-var-arrow':
      core = `const { a } = (() => ${bodyStmt}) as any; export { a };`
      break
    case 'prop-arrow':
      core = `export const obj = { propFn: () => ${bodyStmt} };`
      break
    case 'computed-prop-arrow':
      core = `const k = 'dyn'; export const obj = { [k]: () => ${bodyStmt} };`
      break
    case 'named-fn-expr':
      core = `export const holder = function namedExpr() { return ${bodyStmt}; };`
      break
    case 'class-method':
      core = `export class Service { runMethod() { return ${bodyStmt}; } }`
      break
    case 'class-getter':
      core = `export class Service { get total() { return ${bodyStmt}; } }`
      break
    case 'class-setter':
      core = `export class Service { set total(v: any) { ${bodyStmt}; } }`
      break
    case 'class-constructor':
      core = `export class Service { constructor() { ${bodyStmt}; } }`
      break
    case 'callback-inside-fn':
      core = `export function checkout(items: any[]) { return items.forEach((item) => { ${bodyStmt}; }); }`
      break
    case 'top-level-anonymous-iife':
      core = `export const val = (() => { return ${bodyStmt}; })();`
      break
  }

  const withTrailingTop = `${core}\nexport const afterTop = afterTopCall(2);`
  if (!withExtraNoise) return withTrailingTop
  return `// Leading header comment\n\n${withTrailingTop}\n\n// Trailing comment\nexport type ExtraType = string;\n`
}

oracleProperty({
  id: 'discovery-node-metadata-and-id',
  owns: [
    'src/discovery.mjs#enclosingFunctionName',
    'src/discovery.mjs#callCalleeName',
    'src/discovery.mjs#indexTargetFile',
  ],
  law: {
    statement:
      'For every indexed expression in a target module, indexTargetFile attributes inFunction to the nearest named enclosing function (or "(anonymous)" when only unnamed functions enclose it, and null at top level), extracts callee or operator, assigns the 0-based nth counter per (inFunction, kind, callee | operator), and formats id as `${relativeFile}#${inFunction ?? "<top>"}:${kind}:${callee ?? operator ?? "?"}:${nth}`.',
    authority:
      'README.md:48 ("node is a discriminated union of every selectable expression in examples/checkout.ts (kind, inFunction, callee / operator, nth)") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: nearest named enclosing function and structural node IDs.',
    limits:
      'Computed element-access callees with non-string-literal arguments are named "(anonymous)".',
  },
  histories: {
    arbitrary: metadataArbitrary,
    runs: 60,
    fixedSeeds: [42],
    states: [
      'callback-attributed-to-named-fn',
      'top-level-expression',
      'string-element-callee',
      'repeated-nth-increment',
      'comment-edit-id-stability',
    ],
    constructed: [
      {
        name: 'callback-in-checkout',
        enters: ['callback-attributed-to-named-fn'],
        build: (base) => ({
          ...base,
          container: 'callback-inside-fn',
          calleeForm: 'property-access',
        }),
      },
      {
        name: 'top-level-call',
        enters: ['top-level-expression'],
        build: (base) => ({ ...base, container: 'top-level' }),
      },
      {
        name: 'bracket-string-callee',
        enters: ['string-element-callee'],
        build: (base) => ({ ...base, calleeForm: 'string-element-access' }),
      },
      {
        name: 'two-calls-nth',
        enters: ['repeated-nth-increment'],
        build: (base) => ({ ...base, repeatCall: true }),
      },
      {
        name: 'comment-edit-invariance',
        enters: ['comment-edit-id-stability'],
        build: (base) => ({ ...base, addCommentAndSiblingEdit: true }),
      },
    ],
  },
  model: (history) => metadataModel(history),
  driver: (history, observe) => {
    try {
      if (history.container === 'callback-inside-fn') {
        observe('reach', 'callback-attributed-to-named-fn')
      }
      if (history.container === 'top-level') {
        observe('reach', 'top-level-expression')
      }
      if (history.calleeForm === 'string-element-access') {
        observe('reach', 'string-element-callee')
      }
      if (history.repeatCall) {
        observe('reach', 'repeated-nth-increment')
      }
      if (history.addCommentAndSiblingEdit) {
        observe('reach', 'comment-edit-id-stability')
      }

      const baseSrc = buildMetadataSource(history, false)
      const indexed = indexTargetFile('/app/meta.ts', baseSrc, '/app', sharedApi)

      // Filter out wrapper calls (`forEach`, IIFE, `afterTopCall`) so we inspect the target send/handlers calls
      const targetCallee = expectedCallee(history.calleeForm)
      const isWrapperIife = (n: { callee?: string; inFunction: string | null }, src: string) =>
        (history.container === 'top-level-anonymous-iife' ||
          history.container === 'destructured-var-arrow') &&
        n.inFunction === null &&
        src.slice(n.start, n.end).startsWith('(() =>')

      const relevant = indexed.nodes.filter(
        (n) => n.callee === targetCallee && !isWrapperIife(n, baseSrc),
      )
      const trailingTop = indexed.nodes.find((n) => n.callee === 'afterTopCall')

      const nodes = relevant.map((n) => ({
        id: n.id,
        file: n.file,
        relativeFile: n.relativeFile,
        kind: n.kind,
        inFunction: n.inFunction,
        callee: n.callee,
        nth: n.nth,
        sliceMatchesCall: baseSrc.slice(n.start, n.end).includes('(1)'),
        validSpan: typeof n.start === 'number' && typeof n.end === 'number' && n.end > n.start,
      }))

      let idsUnchangedAfterCommentEdit = true
      if (history.addCommentAndSiblingEdit) {
        const editedSrc = buildMetadataSource(history, true)
        const editedIndexed = indexTargetFile('/app/meta.ts', editedSrc, '/app', sharedApi)
        const editedRelevant = editedIndexed.nodes.filter(
          (n) => n.callee === targetCallee && !isWrapperIife(n, editedSrc),
        )
        idsUnchangedAfterCommentEdit =
          JSON.stringify(relevant.map((n) => n.id)) ===
          JSON.stringify(editedRelevant.map((n) => n.id))
      }

      observe('metadata', {
        file: indexed.file,
        relativeFile: indexed.relativeFile,
        sourceMatches: indexed.source === baseSrc,
        nodes,
        trailingTopLevelInFunction: trailingTop ? trailingTop.inFunction : 'missing',
        idsUnchangedAfterCommentEdit,
      })
    } catch (err) {
      observe('metadata', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'metadata')
    if (!entry) return differs('metadata', 'node-metadata-and-id', undefined, expected) ?? pass
    return differs('metadata', 'node-metadata-and-id', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-in-function-or-id',
      law: 'node-metadata-and-id',
      history: { constructed: 'callback-in-checkout' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'metadata'
            ? { ...o, value: { ...(o.value as object), idsUnchangedAfterCommentEdit: false } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law D3: TDZ-safe local binding capture discovery
// ---------------------------------------------------------------------------

const TDZ_SCENARIOS = [
  'inner-shadow-let-const',
  'param-default-sequence',
  'for-of-header-vs-body',
  'for-in-header-vs-body',
  'for-classic-init-cond-body',
  'hoisted-fn-vs-class-decl',
  'destructured-object-and-array',
  'catch-clause-binding',
] as const

type TdzScenario = (typeof TDZ_SCENARIOS)[number]

interface TdzHistory {
  scenario: TdzScenario
  includeOuterBinding: boolean
}

const tdzArbitrary: fc.Arbitrary<TdzHistory> = fc.record({
  scenario: fc.constantFrom(...TDZ_SCENARIOS),
  includeOuterBinding: fc.boolean(),
})

function tdzModel(history: TdzHistory) {
  const outer = history.includeOuterBinding ? ['outerVal'] : []
  const sorted = (items: Array<string>) => [...new Set([...outer, ...items])].sort()

  switch (history.scenario) {
    case 'inner-shadow-let-const':
      return {
        beforeShadowDecl: sorted([]), // `x` is shadowed in inner block and in TDZ before `const x = 'inner'`!
        afterShadowDecl: sorted(['innerOnly', 'x']),
        afterBlockExit: sorted(['x']), // `innerOnly` was popped when inner block exited!
      }
    case 'param-default-sequence':
      return {
        atFirstParamDefault: sorted([]), // neither p0 nor p1 is ready inside p0 = call0()
        atSecondParamDefault: sorted(['p0']), // p0 is ready inside p1 = call1(), p1 is in TDZ
        inBody: sorted(['p0', 'p1']),
      }
    case 'for-of-header-vs-body':
    case 'for-in-header-vs-body':
      return {
        atLoopHeader: sorted([]), // loop variable `item` is in TDZ inside `getSource()`
        inLoopBody: sorted(['item']),
        inExistingVarLoopBody: sorted(['preExisting']),
      }
    case 'for-classic-init-cond-body':
      return {
        atInit: sorted([]),
        atCondition: sorted(['i']),
        inBody: sorted(['i']),
        inBareForBody: sorted([]),
      }
    case 'hoisted-fn-vs-class-decl':
      return {
        beforeClassAndFn: sorted(['hoistedFn']), // local function is hoisted; class is in TDZ
        afterClassAndFn: sorted(['LocalClass', 'hoistedFn']),
        inAnonDefaultClass: [],
      }
    case 'destructured-object-and-array':
      return {
        beforeDestructure: sorted([]),
        afterDestructure: sorted(['a', 'b', 'c']),
      }
    case 'catch-clause-binding':
      return {
        inTryBlock: sorted([]),
        inCatchBlock: sorted(['err']),
      }
  }
}

oracleProperty({
  id: 'discovery-tdz-safe-captures',
  owns: [
    'src/discovery.mjs#collectBindingEntries',
    'src/discovery.mjs#scopeBindingsOf',
    'src/discovery.mjs#indexTargetFile',
  ],
  law: {
    statement:
      'For every indexed expression at position start, node.captures is the sorted list of local identifier bindings in enclosing non-module scopes whose declaration is initialized before start and is not shadowed by an uninitialized declaration of the same name in an inner enclosing scope.',
    authority:
      'README.md:171 ("with enclosing function name, callee/operator, nth, and safe pre-expression local bindings") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-22: exclude TDZ bindings in shadowed blocks, parameter defaults, and loop headers.',
    limits:
      'Module top-level bindings are excluded from local captures by design.',
  },
  histories: {
    arbitrary: tdzArbitrary,
    runs: 50,
    fixedSeeds: [42],
    states: [
      'shadowed-inner-tdz-masked',
      'param-default-tdz-masked',
      'for-of-header-tdz-masked',
      'hoisted-fn-and-class-tdz',
      'destructured-and-catch-bindings',
      'catch-clause-binding-captured',
    ],
    constructed: [
      {
        name: 'shadowed-block-tdz',
        enters: ['shadowed-inner-tdz-masked'],
        build: (base) => ({
          ...base,
          scenario: 'inner-shadow-let-const',
          includeOuterBinding: true,
        }),
      },
      {
        name: 'param-defaults-tdz',
        enters: ['param-default-tdz-masked'],
        build: (base) => ({ ...base, scenario: 'param-default-sequence' }),
      },
      {
        name: 'for-of-header-tdz',
        enters: ['for-of-header-tdz-masked'],
        build: (base) => ({ ...base, scenario: 'for-of-header-vs-body' }),
      },
      {
        name: 'hoisted-fn-before-class',
        enters: ['hoisted-fn-and-class-tdz'],
        build: (base) => ({ ...base, scenario: 'hoisted-fn-vs-class-decl' }),
      },
      {
        name: 'destructured-bindings',
        enters: ['destructured-and-catch-bindings'],
        build: (base) => ({ ...base, scenario: 'destructured-object-and-array' }),
      },
      {
        name: 'catch-clause-capture',
        enters: ['catch-clause-binding-captured'],
        build: (base) => ({ ...base, scenario: 'catch-clause-binding' }),
      },
    ],
  },
  model: (history) => tdzModel(history),
  driver: (history, observe) => {
    try {
      const outerDecl = history.includeOuterBinding ? 'const outerVal = 0;\n  ' : ''
      const capturesOf = (indexed: ReturnType<typeof indexTargetFile>, callee: string) =>
        indexed.nodes.find((n) => n.callee === callee)?.captures ?? []

      if (history.scenario === 'inner-shadow-let-const') {
        observe('reach', 'shadowed-inner-tdz-masked')
        const src = `export function work() {
  ${outerDecl}const x = 'outer';
  {
    beforeShadow();
    const x = 'inner';
    const innerOnly = 1;
    afterShadow(x, innerOnly);
  }
  afterBlock(x);
}`
        const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
        observe('tdz', {
          beforeShadowDecl: capturesOf(indexed, 'beforeShadow'),
          afterShadowDecl: capturesOf(indexed, 'afterShadow'),
          afterBlockExit: capturesOf(indexed, 'afterBlock'),
        })
        return
      }

      if (history.scenario === 'param-default-sequence') {
        observe('reach', 'param-default-tdz-masked')
        const src = `export function outer() {
  ${outerDecl}function inner(p0 = call0(), p1 = call1()) {
    return bodyCall(p0, p1);
  }
  return inner;
}`
        const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
        observe('tdz', {
          atFirstParamDefault: capturesOf(indexed, 'call0').filter((n) => n !== 'inner'),
          atSecondParamDefault: capturesOf(indexed, 'call1').filter((n) => n !== 'inner'),
          inBody: capturesOf(indexed, 'bodyCall').filter((n) => n !== 'inner'),
        })
        return
      }

      if (history.scenario === 'for-of-header-vs-body' || history.scenario === 'for-in-header-vs-body') {
        observe('reach', 'for-of-header-tdz-masked')
        const kw = history.scenario === 'for-of-header-vs-body' ? 'of' : 'in'
        const src = `export function work() {
  ${outerDecl}for (const item ${kw} getSource()) {
    inBody(item);
  }
  let preExisting = '';
  for (preExisting ${kw} getSource2()) {
    inExistingBody(preExisting);
  }
}`
        const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
        observe('tdz', {
          atLoopHeader: capturesOf(indexed, 'getSource'),
          inLoopBody: capturesOf(indexed, 'inBody'),
          inExistingVarLoopBody: capturesOf(indexed, 'inExistingBody'),
        })
        return
      }

      if (history.scenario === 'for-classic-init-cond-body') {
        observe('reach', 'for-of-header-tdz-masked')
        const src = `export function work() {
  ${outerDecl}for (let i = initCall(); condCall(i); ) {
    bodyCall(i);
  }
  for (; bareCond(); ) {
    bareBody();
  }
}`
        const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
        observe('tdz', {
          atInit: capturesOf(indexed, 'initCall'),
          atCondition: capturesOf(indexed, 'condCall'),
          inBody: capturesOf(indexed, 'bodyCall'),
          inBareForBody: capturesOf(indexed, 'bareBody'),
        })
        return
      }

      if (history.scenario === 'hoisted-fn-vs-class-decl') {
        observe('reach', 'hoisted-fn-and-class-tdz')
        // Note: `class LocalClass {}afterBoth(...)` with 0 whitespace makes LocalClass.end === afterBoth.start!
        const src = `export function work() {
  ${outerDecl}beforeBoth();
  function hoistedFn() { return 1; }
  class LocalClass {}afterBoth(LocalClass, hoistedFn);
}
export default class {
  m() { return anonClassCall(); }
}`
        const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
        observe('tdz', {
          beforeClassAndFn: capturesOf(indexed, 'beforeBoth'),
          afterClassAndFn: capturesOf(indexed, 'afterBoth'),
          inAnonDefaultClass: capturesOf(indexed, 'anonClassCall'),
        })
        return
      }

      if (history.scenario === 'destructured-object-and-array') {
        observe('reach', 'destructured-and-catch-bindings')
        const src = `export function work() {
  ${outerDecl}const { a, nested: { b } } = makeObj();
  const [, c] = [1, 2];
  afterDestructure(a, b, c);
}`
        const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
        observe('tdz', {
          beforeDestructure: capturesOf(indexed, 'makeObj'),
          afterDestructure: capturesOf(indexed, 'afterDestructure'),
        })
        return
      }

      // catch-clause-binding
      observe('reach', 'catch-clause-binding-captured')
      const src = `export function work() {
  ${outerDecl}try {
    inTry();
  } catch (err) {
    inCatch(err);
  }
}`
      const indexed = indexTargetFile('/app/tdz.ts', src, '/app', sharedApi)
      observe('tdz', {
        inTryBlock: capturesOf(indexed, 'inTry'),
        inCatchBlock: capturesOf(indexed, 'inCatch'),
      })
    } catch (err) {
      observe('tdz', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'tdz')
    if (!entry) return differs('tdz', 'tdz-safe-captures', undefined, expected) ?? pass
    return differs('tdz', 'tdz-safe-captures', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'leaked-tdz-capture',
      law: 'tdz-safe-captures',
      history: { constructed: 'shadowed-block-tdz' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'tdz'
            ? { ...o, value: { ...(o.value as object), beforeShadowDecl: ['leaked'] } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law D4: Manifest loading, glob/path resolution, and buildTargetPlan
// ---------------------------------------------------------------------------

interface PlanHistory {
  useGlob: boolean
  useOverrideForVirtualFile: boolean
  includeMissingTarget: boolean
  customTsconfig: boolean
  useDefaultCwdManifest: boolean
}

const planArbitrary: fc.Arbitrary<PlanHistory> = fc.record({
  useGlob: fc.boolean(),
  useOverrideForVirtualFile: fc.boolean(),
  includeMissingTarget: fc.boolean(),
  customTsconfig: fc.boolean(),
  useDefaultCwdManifest: fc.boolean(),
})

function planModel(history: PlanHistory) {
  if (history.useDefaultCwdManifest) {
    return {
      mode: 'default-cwd',
      manifestRootMatchesCwd: true,
      manifestPathEndsWithEp: true,
      planRootMatchesCwd: true,
      planNodeIds: [
        'examples/expressions.ts#invoice:BinaryExpression:+:0',
        'examples/expressions.ts#fetchTotal:BinaryExpression:*:0',
        'examples/expressions.ts#remoteTotal:CallExpression:fetchTotal:0',
      ],
    }
  }
  const expectedFiles = ['src/a.ts', 'src/b.ts']
  const expectedNodeIds = [
    'src/a.ts#a:CallExpression:sendA:0',
    'src/b.ts#b:CallExpression:sendB:0',
  ]
  if (history.useOverrideForVirtualFile) {
    expectedFiles.push('src/virtual.ts')
    expectedNodeIds.push('src/virtual.ts#v:CallExpression:sendV:0')
  }
  expectedFiles.sort()
  expectedNodeIds.sort()
  return {
    mode: 'temp-root',
    manifestRootMatches: true,
    manifestPathMatches: true,
    manifestTargetsMatch: true,
    resolvedCount: expectedFiles.length + (history.includeMissingTarget && !history.useGlob ? 1 : 0),
    planRootMatches: true,
    planRelativeFiles: expectedFiles,
    planNodeIds: expectedNodeIds,
    tsconfigEndsWith: history.customTsconfig ? 'tsconfig.custom.json' : 'tsconfig.json',
  }
}

oracleProperty({
  id: 'discovery-target-plan-and-manifest',
  owns: [
    'src/discovery.mjs#loadManifest',
    'src/discovery.mjs#resolveTargetFiles',
    'src/discovery.mjs#buildTargetPlan',
  ],
  law: {
    statement:
      'For every manifest and target list of explicit paths and globs, loadManifest, resolveTargetFiles, and buildTargetPlan resolve matching files relative to root in sorted order, apply in-memory overrides, skip missing unoverridden files, and index each target module.',
    authority:
      'README.md:122 ("points.ep lists the target application modules to index (explicit paths or glob patterns)") and src/discovery.mjs:12-28, 204-224.',
    limits:
      'Unoverridden target paths that do not exist on disk are skipped by buildTargetPlan.',
  },
  histories: {
    arbitrary: planArbitrary,
    runs: 25,
    fixedSeeds: [42],
    states: [
      'glob-targets-resolved',
      'explicit-targets-with-override',
      'missing-target-skipped',
      'default-cwd-and-own-api',
    ],
    constructed: [
      {
        name: 'glob-discovery',
        enters: ['glob-targets-resolved'],
        build: (base) => ({
          ...base,
          useDefaultCwdManifest: false,
          useGlob: true,
          useOverrideForVirtualFile: false,
        }),
      },
      {
        name: 'override-virtual-file',
        enters: ['explicit-targets-with-override'],
        build: (base) => ({
          ...base,
          useDefaultCwdManifest: false,
          useGlob: false,
          useOverrideForVirtualFile: true,
          customTsconfig: true,
        }),
      },
      {
        name: 'missing-file-skipped',
        enters: ['missing-target-skipped'],
        build: (base) => ({
          ...base,
          useDefaultCwdManifest: false,
          useGlob: false,
          includeMissingTarget: true,
        }),
      },
      {
        name: 'default-cwd-plan',
        enters: ['default-cwd-and-own-api'],
        build: (base) => ({
          ...base,
          useDefaultCwdManifest: true,
        }),
      },
    ],
  },
  model: (history) => planModel(history),
  driver: (history, observe) => {
    if (history.useDefaultCwdManifest) {
      try {
        observe('reach', 'default-cwd-and-own-api')
        const loaded = loadManifest()
        const plan = buildTargetPlan({ targets: ['examples/expressions.ts'] })
        observe('plan', {
          mode: 'default-cwd',
          manifestRootMatchesCwd: loaded.root === process.cwd(),
          manifestPathEndsWithEp: loaded.manifestPath === join(process.cwd(), 'points.ep'),
          planRootMatchesCwd: plan.root === process.cwd(),
          planNodeIds: plan.files.flatMap((f) => f.nodes.map((n) => n.id)),
        })
      } catch (err) {
        observe('plan', { threw: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    const tempRoot = mkdtempSync(join(tmpdir(), 'ep-disc-oracle-'))
    try {
      const srcDir = join(tempRoot, 'src')
      rmSync(srcDir, { recursive: true, force: true })
      mkdirSyncCompat(srcDir)
      writeFileSync(join(srcDir, 'b.ts'), 'export function b() { return sendB(1); }\n')
      writeFileSync(join(srcDir, 'a.ts'), 'export function a() { return sendA(1); }\n')

      const targets: Array<string> = history.useGlob ? ['src/*.ts'] : ['src/b.ts', 'src/a.ts']
      if (!history.useGlob && history.includeMissingTarget) {
        targets.push('src/missing.ts')
      }
      if (history.useOverrideForVirtualFile) {
        targets.push('src/virtual.ts')
      }

      const tsconfigName = history.customTsconfig ? 'tsconfig.custom.json' : undefined
      writeFileSync(
        join(tempRoot, 'points.ep'),
        JSON.stringify({
          ...(tsconfigName ? { tsconfig: tsconfigName } : {}),
          targets,
        }),
      )

      if (history.useGlob) observe('reach', 'glob-targets-resolved')
      if (history.useOverrideForVirtualFile) observe('reach', 'explicit-targets-with-override')
      if (history.includeMissingTarget && !history.useGlob) observe('reach', 'missing-target-skipped')

      const loaded = loadManifest(tempRoot, 'points.ep')
      const resolved = resolveTargetFiles(tempRoot, loaded.targets)
      const overrides = new Map<string, string>()
      if (history.useOverrideForVirtualFile) {
        overrides.set(join(tempRoot, 'src/virtual.ts'), 'export function v() { return sendV(1); }\n')
      }

      const plan = buildTargetPlan({
        root: tempRoot,
        tsconfig: loaded.tsconfig,
        targets: loaded.targets,
        overrides,
        api: sharedApi,
      })

      observe('plan', {
        mode: 'temp-root',
        manifestRootMatches: loaded.root === tempRoot,
        manifestPathMatches: loaded.manifestPath === join(tempRoot, 'points.ep'),
        manifestTargetsMatch: JSON.stringify(loaded.targets) === JSON.stringify(targets),
        resolvedCount: resolved.length,
        planRootMatches: plan.root === tempRoot,
        planRelativeFiles: plan.files.map((f) => f.relativeFile),
        planNodeIds: plan.files.flatMap((f) => f.nodes.map((n) => n.id)).sort(),
        tsconfigEndsWith: plan.tsconfig.endsWith('tsconfig.custom.json')
          ? 'tsconfig.custom.json'
          : 'tsconfig.json',
      })
    } catch (err) {
      observe('plan', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'plan')
    if (!entry) return differs('plan', 'target-plan-and-manifest', undefined, expected) ?? pass
    return differs('plan', 'target-plan-and-manifest', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-plan-files',
      law: 'target-plan-and-manifest',
      history: { constructed: 'glob-discovery' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'plan'
            ? { ...o, value: { ...(o.value as object), planRelativeFiles: [] } }
            : o,
        ),
    },
  ],
})

function mkdirSyncCompat(dir: string) {
  const { mkdirSync } = requireNodeFs()
  mkdirSync(dir, { recursive: true })
}

let cachedFs: typeof import('node:fs') | undefined
function requireNodeFs() {
  return (cachedFs ??= { mkdirSync: (p: string, o: { recursive: boolean }) => {
    // Use writeFileSync parent creation via node:fs
    return importFsSync(p, o)
  } } as unknown as typeof import('node:fs'))
}
import { mkdirSync as importFsSync } from 'node:fs'
