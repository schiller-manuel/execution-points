/**
 * This oracle owns what `execution-points-prototype` lets a test select and capture in a
 * target module: which expressions are indexed, how each one is addressed, and which local
 * names can be captured at it. It is checked on the output of `indexTargetFile`,
 * `resolveTargetFiles`, `loadManifest`, and `buildTargetPlan`, and it owns `src/discovery.ts`.
 *
 * ```ts
 * indexTargetFile(file, 'export async function f(o) { return retry(async () => { await load(o?.id) }) }', root, api)
 * // → retry(...) is indexed: the `await` belongs to the callback, not to `f`
 * // → load(o?.id) is not: it awaits nothing, but `await load(o?.id)` cannot move into a function of its own
 * indexTargetFile(file, 'export function f(o) { return o?.find(1).name(2) }', root, api)
 * // → o?.find(1).name(2) is indexed, o?.find(1) is not: the chain goes on behind it
 * indexTargetFile(file, 'export function f(k) { const a = 1; switch (k) { case 0: return send(k); default: let a = 2 } }', root, api)
 * // → send(k) has captures ['k']: the switch declares an `a` of its own, uninitialized in case 0
 * indexTargetFile(file, 'function f() { return send(1) }', root, api)
 * // → nodes: [] for a file with no import or export
 * ```
 *
 * Why can `limit` be captured at `compute(1)` in `late`, and not in `early`?
 *
 * ```ts
 * function late() { const limit = 5; return peek(); function peek() { return compute(1) } }
 * function early() { const r = peek(); const limit = 5; return r; function peek() { return compute(1) } }
 * ```
 *
 * Three parts decide the answer. The **wrap** is what the plugin does to a selected
 * expression: it moves it into an arrow function, so an expression is selectable exactly when
 * that move changes nothing. The **address** names an indexed expression by its file, its
 * nearest named function, its kind, its callee or operator, and a count. The **reach of a
 * name** is the set of moments at which code can run while the name is declared but not yet
 * initialized: a function declaration exists from the start of its block, so it runs as early
 * as the first use of its name, and a `case` can be entered without passing the declarations
 * of the cases before it.
 *
 * Law D1. For every TypeScript module, `indexTargetFile` indexes every call, every binary
 * operation that does not assign, and every ternary, except where the wrap would change what
 * the code does: where JavaScript needs a place and not a value (the target of an assignment,
 * the operand of `delete`, `++`, or `--`, also through parentheses and type assertions); a
 * binary operation or ternary that is called, constructed, or used as a template tag; an
 * expression that itself, outside the functions it contains, awaits, yields, calls
 * `super(...)`, evaluates code with a direct `eval`, or imports; and an expression behind
 * which an optional chain goes on without a `?.` of its own. A file with no import or export
 * is a global script and indexes nothing (`README.md`, "Supported subset and limits"; Decision
 * by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: an expression is skipped only when
 * wrapping it in an arrow function would change what it does, and a call in callee position is
 * selectable because a call result carries no receiver). A wrong answer in one direction hides
 * code from tests; in the other, a module that is merely listed as a target stops compiling or
 * throws where it returned `undefined`.
 *
 * Law D2. For every indexed expression, `inFunction` is the nearest named enclosing function
 * (`'(anonymous)'` when only unnamed functions enclose it, `null` at the top level), `nth`
 * counts from 0 within `(inFunction, kind, callee | operator)`, and `id` is
 * `${relativeFile}#${inFunction ?? '<top>'}:${kind}:${callee ?? operator ?? '?'}:${nth}`
 * (`README.md`, "Select an execution point in a test"; Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-22: nearest named enclosing function and structural node IDs).
 *
 * Law D3. For every indexed expression, `captures` lists, sorted, exactly the local names
 * that are initialized every time the code reaches the expression, in every order in which
 * the code can be called; reading each of them where the instrumented code reaches the
 * expression succeeds (Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: for
 * every capture offered at a point, reading it when the instrumented code reaches that point
 * succeeds; `README.md`: "`.capture(...)` autocompletes every in-scope local at that
 * expression"). When it breaks, a test that captures an offered name gets a `ReferenceError`
 * thrown inside the application call.
 *
 * Law D4. For every manifest and target list, `loadManifest`, `resolveTargetFiles`, and
 * `buildTargetPlan` resolve explicit paths and globs relative to `root` in sorted order, use
 * in-memory `overrides` when given, skip missing files, and index each resolved file
 * (`README.md`, "Configuration").
 *
 * How the oracle knows. For D1 the model is the rule itself, written over a grammar of
 * expression shapes (`tests/expression-shapes-oracle.ts`): what an expression holds, which
 * expression holds it, what it is wrapped in, and what the surrounding code does with it. The
 * plugin oracle runs the same shapes to show that every selectable one behaves as written.
 * For D3 the model is JavaScript: each generated function (`tests/scope-shapes-oracle.ts`)
 * is also written with a way to read every name at every point, and is run once for each
 * combination of `switch` clauses, with every use of a function's name being a call. The
 * driver indexes the function, instruments it with the plugin, and runs it with every offered
 * capture read at every indexed expression. D2 and D4 compare descriptors and plans of small
 * generated modules with a model of the address and of path resolution.
 *
 * Limits. Module-level bindings are never captures. A `var` is offered like a `let` written
 * in its place, the names of one destructuring pattern become available together, and the
 * name of a class is not offered inside that class: each offers less than JavaScript could
 * read, never more. Code that calls a function through a direct `eval` or a `with` block is
 * outside D3. D1 judges one expression inside one function per history; it does not vary
 * `moduleDetection`, which the syntactic rule for global scripts does not consult.
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
} from '../src/discovery.ts'
import { executionPoints } from '../src/plugin.ts'
import {
  CONTENTS,
  POSITIONS,
  SUBJECTS,
  WRAPPERS,
  judge,
  moduleOf,
  planShape,
  selectableIn,
  subjectVerdict,
  type Shape,
} from './expression-shapes-oracle'
import {
  askJavaScript,
  planScopeShape,
  runScopeProgram,
  scopeShapeArbitrary,
  type ScopeOp,
  type ScopeOpKind,
  type ScopeShape,
} from './scope-shapes-oracle'

const sharedApi = new API({ cwd: process.cwd() })
afterAll(() => {
  sharedApi.close()
})

// ---------------------------------------------------------------------------
// Law D1: Selectable expression filtering
// ---------------------------------------------------------------------------

// A shape, and what makes the file that holds it a module.
interface SelectableHistory extends Shape {
  moduleBy: 'export' | 'import' | 'nothing'
}

const selectableArbitrary: fc.Arbitrary<SelectableHistory> = fc.record({
  position: fc.constantFrom(...POSITIONS),
  wrapper: fc.constantFrom(...WRAPPERS),
  subject: fc.constantFrom(...SUBJECTS),
  content: fc.constantFrom(...CONTENTS),
  moduleBy: fc.constantFrom('export', 'import', 'nothing'),
})

/** The module that holds the shape, and where the shape's expression starts in it. */
function shapeModule(history: SelectableHistory) {
  const plan = planShape(history)
  const { source, at } = moduleOf(plan, true)
  if (history.moduleBy === 'export') return { plan, source, at }
  const head = history.moduleBy === 'import' ? `import './dep'\n` : ''
  return { plan, source: head + source.replace('export class', 'class'), at: at - 'export '.length + head.length }
}

/** The rule applies to modules; a global script indexes nothing. */
function selectableModel(history: SelectableHistory) {
  return {
    nodes: history.moduleBy === 'nothing' ? [] : selectableIn(planShape(history)),
    activeLeasesAfter: 0,
  }
}

const NESTED_FUNCTION_CONTENTS: ReadonlyArray<string> = [
  'await-in-async-arrow',
  'await-in-object-method',
  'await-in-class-method',
  'yield-in-generator',
  'super-call-in-arrow',
  'eval-in-arrow',
  'import-in-arrow',
  'import-in-class-field',
  'import-in-static-block',
]
const CALLED_POSITIONS: ReadonlyArray<string> = ['callee', 'optional-callee', 'new-callee', 'tag']

/** What the shape shows of the rule: each is a predicate over the history alone. */
function selectableStates(history: SelectableHistory): Array<string> {
  const plan = planShape(history)
  const verdicts = new Set(judge(plan).map((candidate) => candidate.verdict))
  const subject = subjectVerdict(plan)
  const states: Array<string> = []
  if (history.moduleBy === 'nothing') return ['global-script-indexes-nothing']
  if (history.moduleBy === 'import') states.push('module-by-import')
  if (verdicts.has('selectable')) states.push('indexed-selectable-expr')
  if (verdicts.has('assigns')) states.push('skipped-assignment-expr')
  if (verdicts.has('needs-a-place')) states.push('skipped-reference-target')
  if (verdicts.has('tied-to-its-function')) states.push('skipped-unsupported-inner')
  if (verdicts.has('chain-goes-on')) states.push('skipped-chain-prefix')
  if (subject !== 'selectable') return states
  if (NESTED_FUNCTION_CONTENTS.includes(plan.shape.content)) states.push('nested-function-does-not-tie')
  if (plan.shape.subject.startsWith('optional-')) states.push('optional-chain-selected')
  if (plan.shape.subject === 'super-method') states.push('super-method-selected')
  if (CALLED_POSITIONS.includes(plan.shape.position)) states.push('call-selected-where-it-is-called')
  return states
}

const shape = (
  position: Shape['position'],
  wrapper: Shape['wrapper'],
  subject: Shape['subject'],
  content: Shape['content'],
  moduleBy: SelectableHistory['moduleBy'] = 'export',
) => (): SelectableHistory => ({ position, wrapper, subject, content, moduleBy })

oracleProperty({
  id: 'discovery-selectable-expressions',
  owns: ['src/discovery.ts#isSelectableExpression', 'src/discovery.ts#indexTargetFile'],
  law: {
    statement:
      'For every TypeScript module, indexTargetFile indexes every call, every binary operation that does not assign, and every ternary, except where wrapping it in an arrow function would change what the code does: where JavaScript needs a place and not a value (assignment target, operand of delete, ++, or --); a binary operation or ternary that is called, constructed, or used as a template tag; an expression that itself, outside the functions it contains, awaits, yields, calls super(...), evaluates code with a direct eval, or imports; and an expression behind which an optional chain goes on without a ?. of its own. A file with no import or export is a global script and indexes nothing. indexTargetFile disposes its source-file lease.',
    authority:
      'README.md, "Supported subset and limits". Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: an expression is skipped only when wrapping it in an arrow function would change what it does (an await or yield that belongs to the same function, a super(...) call, a direct eval, a dynamic import(), a prefix of an optional chain that continues outside it); a call in callee position is selectable because a call result carries no receiver; the exclusions that protect assignment targets, delete, ++/--, and receivers stay.',
    limits:
      'One expression inside one class member per history, built from four choices (position, wrapper, subject, content). A binary operation or ternary that is called stays excluded although its result carries no receiver either. The rule for global scripts is syntactic and does not consult moduleDetection.',
  },
  histories: {
    arbitrary: selectableArbitrary,
    runs: 150,
    fixedSeeds: [42],
    states: [
      'indexed-selectable-expr',
      'skipped-assignment-expr',
      'skipped-reference-target',
      'skipped-unsupported-inner',
      'skipped-chain-prefix',
      'nested-function-does-not-tie',
      'optional-chain-selected',
      'super-method-selected',
      'call-selected-where-it-is-called',
      'global-script-indexes-nothing',
      'module-by-import',
    ],
    constructed: [
      { name: 'plain-call', enters: ['indexed-selectable-expr'], build: shape('value', 'none', 'call', 'plain') },
      { name: 'assignment', enters: ['skipped-assignment-expr'], build: shape('value', 'none', 'assign', 'call') },
      { name: 'last-assignment-operator', enters: ['skipped-assignment-expr'], build: shape('value', 'none', 'compound-assign', 'call') },
      {
        name: 'ternary-assigned-if-unset',
        enters: ['skipped-reference-target', 'skipped-assignment-expr'],
        build: shape('compound-target', 'none', 'conditional', 'plain'),
      },
      {
        name: 'ternary-assigned-to',
        enters: ['skipped-reference-target'],
        build: shape('assign-target', 'as', 'conditional', 'plain'),
      },
      { name: 'ternary-deleted', enters: ['skipped-reference-target'], build: shape('delete', 'paren', 'conditional', 'plain') },
      { name: 'sum-incremented', enters: ['skipped-reference-target'], build: shape('postfix', 'non-null', 'add', 'plain') },
      { name: 'sum-decremented', enters: ['skipped-reference-target'], build: shape('prefix', 'angle', 'add', 'plain') },
      { name: 'ternary-called', enters: ['skipped-reference-target'], build: shape('callee', 'satisfies', 'conditional', 'plain') },
      { name: 'sum-constructed', enters: ['skipped-reference-target'], build: shape('new-callee', 'none', 'add', 'plain') },
      { name: 'ternary-as-tag', enters: ['skipped-reference-target'], build: shape('tag', 'none', 'conditional', 'plain') },
      { name: 'own-await', enters: ['skipped-unsupported-inner'], build: shape('value', 'none', 'call', 'own-await') },
      { name: 'own-yield', enters: ['skipped-unsupported-inner'], build: shape('argument', 'none', 'add', 'own-yield') },
      { name: 'super-call', enters: ['skipped-unsupported-inner'], build: shape('value', 'none', 'conditional', 'super-call') },
      { name: 'direct-eval', enters: ['skipped-unsupported-inner'], build: shape('value', 'none', 'method', 'own-eval') },
      { name: 'own-import', enters: ['skipped-unsupported-inner'], build: shape('value', 'none', 'call', 'own-import') },
      { name: 'await-in-key', enters: ['skipped-unsupported-inner'], build: shape('value', 'none', 'call', 'await-in-class-key') },
      {
        name: 'await-in-decorator',
        enters: ['skipped-unsupported-inner'],
        build: shape('value', 'none', 'call', 'await-in-class-decorator'),
      },
      {
        name: 'callback-awaits',
        enters: ['nested-function-does-not-tie'],
        build: shape('value', 'none', 'call', 'await-in-async-arrow'),
      },
      {
        name: 'method-awaits',
        enters: ['nested-function-does-not-tie'],
        build: shape('value', 'none', 'call', 'await-in-class-method'),
      },
      {
        name: 'generator-callback-yields',
        enters: ['nested-function-does-not-tie'],
        build: shape('value', 'none', 'logical-and', 'yield-in-generator'),
      },
      { name: 'field-imports', enters: ['nested-function-does-not-tie'], build: shape('value', 'none', 'call', 'import-in-class-field') },
      {
        name: 'static-block-imports',
        enters: ['nested-function-does-not-tie'],
        build: shape('value', 'none', 'call', 'import-in-static-block'),
      },
      { name: 'callback-evaluates', enters: ['nested-function-does-not-tie'], build: shape('value', 'none', 'call', 'eval-in-arrow') },
      { name: 'whole-optional-chain', enters: ['optional-chain-selected'], build: shape('argument', 'none', 'optional-method', 'plain') },
      { name: 'optional-call', enters: ['optional-chain-selected'], build: shape('operand', 'none', 'optional-call', 'optional-read') },
      {
        name: 'chain-continued-with-question',
        enters: ['optional-chain-selected'],
        build: shape('optional-member-call', 'none', 'optional-method', 'plain'),
      },
      { name: 'chain-ended-by-parens', enters: ['optional-chain-selected'], build: shape('member-call', 'paren', 'optional-method', 'plain') },
      { name: 'chain-ended-by-non-null', enters: ['optional-chain-selected'], build: shape('argument', 'non-null', 'optional-method', 'plain') },
      { name: 'chain-prefix', enters: ['skipped-chain-prefix'], build: shape('member-call', 'none', 'optional-method', 'plain') },
      { name: 'chain-prefix-read', enters: ['skipped-chain-prefix'], build: shape('member', 'none', 'optional-method', 'plain') },
      { name: 'chain-prefix-element', enters: ['skipped-chain-prefix'], build: shape('element', 'none', 'optional-method', 'plain') },
      { name: 'chain-prefix-called', enters: ['skipped-chain-prefix'], build: shape('callee', 'none', 'optional-call', 'plain') },
      {
        name: 'chain-prefix-through-non-null',
        enters: ['skipped-chain-prefix'],
        build: shape('member-call', 'non-null', 'optional-method', 'plain'),
      },
      { name: 'chain-prefix-inside', enters: ['skipped-chain-prefix'], build: shape('value', 'none', 'call', 'chain-through-non-null') },
      { name: 'super-method', enters: ['super-method-selected'], build: shape('value', 'none', 'super-method', 'plain') },
      { name: 'curried-call', enters: ['call-selected-where-it-is-called'], build: shape('callee', 'none', 'call', 'plain') },
      {
        name: 'call-constructed',
        enters: ['call-selected-where-it-is-called'],
        build: shape('new-callee', 'none', 'call', 'plain'),
      },
      { name: 'call-as-tag', enters: ['call-selected-where-it-is-called'], build: shape('tag', 'as', 'method', 'plain') },
      {
        name: 'global-script',
        enters: ['global-script-indexes-nothing'],
        build: shape('value', 'none', 'call', 'call', 'nothing'),
      },
      { name: 'module-by-import', enters: ['module-by-import'], build: shape('value', 'none', 'call', 'call', 'import') },
    ],
  },
  model: (history) => selectableModel(history),
  driver: (history, observe) => {
    try {
      for (const state of selectableStates(history)) observe('reach', state)
      const { plan, source, at } = shapeModule(history)
      const indexed = indexTargetFile('/app/shape.ts', source, '/app', sharedApi)
      // The host adds no call, operation, or ternary of its own around the expression.
      const nodes = indexed.nodes.map((n) => ({
        kind: n.kind,
        ...(n.callee !== undefined ? { callee: n.callee } : {}),
        ...(n.operator !== undefined ? { operator: n.operator } : {}),
        start: n.start - at,
        end: n.end - at,
      }))
      const activeLeasesAfter = (
        sharedApi as unknown as { activeSourceFileLeases: Set<unknown> }
      ).activeSourceFileLeases.size
      observe('selectable', { nodes, activeLeasesAfter, text: plan.text })
    } catch (err) {
      observe('selectable', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'selectable')
    const text = planShape(history).text
    return differs('selectable', 'selectable-expressions', entry?.value, { ...expected, text }) ?? pass
  },
  calibrations: [
    {
      name: 'chain-prefix-indexed',
      law: 'selectable-expressions',
      history: { constructed: 'chain-prefix' },
      // The wrong answer of a rule that looks only at the expression itself: both calls.
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'selectable'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  nodes: [
                    { kind: 'CallExpression', callee: 'k', start: 0, end: 14 },
                    { kind: 'CallExpression', callee: 'm', start: 0, end: 9 },
                  ],
                },
              }
            : o,
        ),
    },
    {
      name: 'callback-with-await-hidden',
      law: 'selectable-expressions',
      history: { constructed: 'callback-awaits' },
      // The answer of the rule before 2026-11-24: an `await` anywhere inside hides the call.
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'selectable' ? { ...o, value: { ...(o.value as object), nodes: [] } } : o,
        ),
    },
    {
      name: 'global-script-indexed',
      law: 'selectable-expressions',
      history: { constructed: 'global-script' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'selectable'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  nodes: [
                    { kind: 'CallExpression', callee: 'f', start: 0, end: 7 },
                    { kind: 'CallExpression', callee: 'g', start: 2, end: 6 },
                  ],
                },
              }
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
    'src/discovery.ts#enclosingFunctionName',
    'src/discovery.ts#callCalleeName',
    'src/discovery.ts#indexTargetFile',
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
// Law D3: Captures are the locals that are initialized whenever the code reaches the point
// ---------------------------------------------------------------------------

const op = (kind: ScopeOpKind, n = 0, k = 0): ScopeOp => ({ op: kind, n, k })
const scopes =
  (...ops: Array<ScopeOp>) =>
  (base: ScopeShape): ScopeShape => ({ ...base, ops })

/**
 * JavaScript's answer, from running the truth program: the names every reach of a point could
 * read. No capture read in the instrumented program may fail.
 */
function capturesModel(history: ScopeShape) {
  const answers = askJavaScript(planScopeShape(history))
  return {
    captures: answers.map((answer) => (answer === 'never reached' ? answer : answer.readable)),
    failedReads: [],
  }
}

/** What the program shows of the law: predicates over the history and JavaScript's answer. */
function capturesStates(history: ScopeShape): Array<string> {
  const plan = planScopeShape(history)
  const answers = askJavaScript(plan)
  const some = (holds: (answer: Exclude<(typeof answers)[number], string>, index: number) => boolean) =>
    answers.some((answer, index) => answer !== 'never reached' && holds(answer, index))
  const states: Array<string> = []
  if (some((answer) => answer.uninitializedOnce.length > 0)) states.push('uninitialized-name-at-the-point')
  if (some((answer) => answer.dependsOnOrder.length > 0)) states.push('readable-in-some-orders-only')
  if (some((answer, index) => plan.points[index]!.inSwitch && answer.uninitializedOnce.length > 0))
    states.push('switch-clause-skips-a-declaration')
  if (some((answer, index) => plan.points[index]!.inFunction && answer.uninitializedOnce.length > 0))
    states.push('function-runs-before-a-declaration')
  if (some((answer, index) => plan.points[index]!.inFunction && answer.readable.length >= 2))
    states.push('function-reads-its-surroundings')
  if (some((_answer, index) => plan.points[index]!.classes.length > 0)) states.push('inside-a-class')
  for (const part of ['parameter-defaults', 'loop', 'destructure', 'catch']) if (plan.has.has(part)) states.push(part)
  if (history.moduleDeclaresName) states.push('module-declares-a-local-name')
  return states
}

oracleProperty({
  id: 'discovery-tdz-safe-captures',
  owns: [
    'src/discovery.ts#declarationsOf',
    'src/discovery.ts#declaredNames',
    'src/discovery.ts#reachOf',
    'src/discovery.ts#indexTargetFile',
  ],
  law: {
    statement:
      'For every indexed expression, node.captures lists, sorted, exactly the local names that are initialized every time the code reaches the expression, in every order in which the code can be called; reading each of them where the instrumented code reaches the expression succeeds.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: for every capture the registry offers at a point, reading it when the instrumented code reaches that point succeeds; the model is JavaScript\'s own scoping. README.md, "Select an execution point in a test": ".capture(...) autocompletes every in-scope local at that expression".',
    limits:
      'Module-level bindings are never captures. The name of a class is not offered inside that class. The generated functions declare names with let, const, class, function, parameters, loop heads, catch, and destructuring, and use a function only by calling it: var, the names inside one destructuring pattern, and calls made through eval or with are not generated.',
  },
  histories: {
    arbitrary: scopeShapeArbitrary,
    runs: 100,
    fixedSeeds: [42],
    states: [
      'uninitialized-name-at-the-point',
      'readable-in-some-orders-only',
      'switch-clause-skips-a-declaration',
      'function-runs-before-a-declaration',
      'function-reads-its-surroundings',
      'inside-a-class',
      'parameter-defaults',
      'loop',
      'destructure',
      'catch',
      'module-declares-a-local-name',
    ],
    constructed: [
      {
        // const a; switch { case 0: at(); break; default: let a; at() }
        name: 'later-case-declares-the-outer-name',
        enters: ['switch-clause-skips-a-declaration', 'uninitialized-name-at-the-point'],
        build: scopes(op('let'), op('switch'), op('point'), op('case'), op('let'), op('point')),
      },
      {
        name: 'later-case-declares-a-class',
        enters: ['switch-clause-skips-a-declaration'],
        build: scopes(op('let'), op('switch'), op('point'), op('case'), op('class', 0, 1), op('point')),
      },
      {
        // The second clause is entered directly, and by running on from the first.
        name: 'case-entered-two-ways',
        enters: ['readable-in-some-orders-only'],
        build: scopes(op('switch'), op('let'), op('point'), op('case', 0, 1), op('point'), op('case'), op('point')),
      },
      {
        // call b; let a; function b() { at() }
        name: 'function-called-before-a-later-const',
        enters: ['function-runs-before-a-declaration', 'uninitialized-name-at-the-point'],
        build: scopes(op('call', 1), op('let'), op('function', 1), op('point'), op('close'), op('point')),
      },
      {
        name: 'function-called-early-through-another',
        enters: ['function-runs-before-a-declaration'],
        build: scopes(
          op('call', 1),
          op('let'),
          op('function', 2),
          op('point'),
          op('close'),
          op('function', 1),
          op('call', 2),
          op('close'),
        ),
      },
      {
        // b and c call each other; b is called before `a` exists.
        name: 'functions-that-call-each-other',
        enters: ['function-runs-before-a-declaration'],
        build: scopes(
          op('call', 1),
          op('let'),
          op('function', 1),
          op('call', 2),
          op('close'),
          op('function', 2),
          op('call', 1),
          op('point'),
          op('close'),
        ),
      },
      {
        // The function's block lies in a case, behind the case's own declaration.
        name: 'function-in-a-block-inside-a-case',
        enters: ['function-reads-its-surroundings'],
        build: scopes(op('switch'), op('let'), op('block'), op('function', 1), op('point'), op('close'), op('close')),
      },
      {
        name: 'function-read-from-an-object-early',
        enters: ['function-runs-before-a-declaration'],
        build: scopes(op('call', 1, 1), op('let'), op('function', 1), op('point'), op('close')),
      },
      {
        // function b() { at() }; let a: b runs only where the scope ends, after a.
        name: 'function-called-only-after-a-later-const',
        enters: ['function-reads-its-surroundings'],
        build: scopes(op('function', 1), op('point'), op('close'), op('let'), op('point')),
      },
      {
        name: 'function-name-only-as-a-property',
        enters: ['function-reads-its-surroundings'],
        build: scopes(op('member', 1), op('member', 1, 1), op('let'), op('function', 1), op('point'), op('close')),
      },
      {
        // The inner `a` is a number: reading it is no use of the outer function `a`.
        name: 'use-of-a-shadowing-name',
        enters: ['function-reads-its-surroundings'],
        build: scopes(
          op('function'),
          op('point'),
          op('close'),
          op('block'),
          op('let'),
          op('call'),
          op('close'),
          op('let', 1),
        ),
      },
      {
        name: 'function-in-a-case-called-from-another',
        enters: ['function-runs-before-a-declaration', 'switch-clause-skips-a-declaration'],
        build: scopes(
          op('switch'),
          op('let'),
          op('function', 1),
          op('point'),
          op('close'),
          op('call', 1),
          op('case'),
          op('call', 1),
        ),
      },
      {
        // The function's own case is the last one: nothing else calls it.
        name: 'function-called-from-its-own-case',
        enters: ['function-reads-its-surroundings'],
        build: scopes(op('switch'), op('point'), op('case'), op('let'), op('function', 1), op('point'), op('close')),
      },
      {
        name: 'function-inside-a-function',
        enters: ['function-runs-before-a-declaration'],
        build: scopes(
          op('let'),
          op('function', 1),
          op('call', 2),
          op('let', 0),
          op('function', 2),
          op('point'),
          op('close'),
          op('close'),
        ),
      },
      {
        name: 'inner-block-declares-the-outer-name',
        enters: ['uninitialized-name-at-the-point'],
        build: scopes(op('let'), op('block'), op('point'), op('let'), op('let', 1), op('point'), op('close'), op('point')),
      },
      {
        name: 'name-initialized-by-the-point',
        enters: ['uninitialized-name-at-the-point'],
        build: scopes(op('let', 0, 1), op('point')),
      },
      {
        name: 'parameter-defaults',
        enters: ['parameter-defaults'],
        build: scopes(op('let', 1), op('function', 0, 2), op('point'), op('close'), op('arrow', 2, 1), op('point')),
      },
      {
        name: 'loop-heads',
        enters: ['loop'],
        build: scopes(
          op('let'),
          op('loop', 0, 0),
          op('point'),
          op('close'),
          op('loop', 1, 1),
          op('point'),
          op('close'),
          op('loop', 0, 2),
          op('point'),
          op('close'),
          op('loop', 0, 3),
          op('point'),
          op('close'),
          op('loop', 0, 4),
          op('point'),
        ),
      },
      {
        name: 'classes',
        enters: ['inside-a-class'],
        build: scopes(
          op('let'),
          op('point'),
          op('class', 1, 0),
          op('point'),
          op('close'),
          op('class', 2, 1),
          op('point'),
          op('close'),
          op('point'),
        ),
      },
      {
        name: 'class-heritage-and-field',
        enters: ['inside-a-class', 'uninitialized-name-at-the-point'],
        build: scopes(
          op('let'),
          op('block'),
          op('class', 0, 3),
          op('point'),
          op('close'),
          op('class', 1, 2),
          op('point'),
          op('close'),
        ),
      },
      {
        name: 'class-expression',
        enters: ['inside-a-class', 'uninitialized-name-at-the-point'],
        build: scopes(op('let'), op('class', 0, 4), op('point'), op('close'), op('point')),
      },
      {
        name: 'destructured-names',
        enters: ['destructure'],
        build: scopes(op('destructure'), op('point')),
      },
      {
        name: 'catch-binding',
        enters: ['catch'],
        build: scopes(op('point'), op('try'), op('point'), op('close'), op('point')),
      },
      {
        name: 'module-declares-the-name',
        enters: ['module-declares-a-local-name'],
        build: (base) => ({ moduleDeclaresName: true, ops: scopes(op('point'), op('let', 2), op('point'))(base).ops }),
      },
    ],
  },
  model: (history) => capturesModel(history),
  driver: async (history, observe) => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-disc-d3-'))
    try {
      for (const state of capturesStates(history)) observe('reach', state)
      const plan = planScopeShape(history)
      const file = join(dir, 'scopes.ts')
      writeFileSync(file, plan.target)

      const indexed = indexTargetFile(file, plan.target, dir, sharedApi)
      const captures: Array<Array<string> | 'not indexed'> = plan.points.map(() => 'not indexed')
      for (const node of indexed.nodes) {
        const point = /^at\((\d+),/.exec(plan.target.slice(node.start, node.end))
        if (point) captures[Number(point[1])] = node.captures
      }

      // The instrumented function, run with every flag on, so that every indexed expression
      // goes through `invoke`; `invoke` reads every capture the expression offers.
      const plugin = executionPoints({ root: dir, targets: ['scopes.ts'] })
      await plugin.buildStart.call({ addWatchFile() {} })
      const instrumented = await plugin.transform.call({}, plan.target, file)
      if (!instrumented) {
        // Nothing in the function can be selected, so nothing is read.
        observe('captures', { captures, failedReads: [] })
        return
      }
      const aliases = /import \{ invoke as (\w+), registerFile as (\w+) \}[^\n]*\n/.exec(instrumented.code)!
      const failedReads = new Set<string>()
      const invoke = (id: string, original: () => unknown, captureThunk: () => Record<string, () => unknown>) => {
        for (const [name, read] of Object.entries(captureThunk())) {
          try {
            read()
          } catch (error) {
            failedReads.add(`${name} at ${id}: ${(error as Error).message}`)
          }
        }
        return original()
      }
      const register = (_file: string, _nodes: unknown, homes: ReadonlyArray<number>) =>
        Array.from({ length: Math.max(0, ...homes) + 1 }, () => ({ on: true }))
      runScopeProgram(instrumented.code.replace(aliases[0], ''), plan.clauseCounts, (_point, value) => value, {
        [aliases[1]!]: invoke,
        [aliases[2]!]: register,
      })

      observe('captures', { captures, failedReads: [...failedReads].sort() })
    } catch (err) {
      observe('captures', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) =>
    differs('captures', 'tdz-safe-captures', observations.find((o) => o.checkpoint === 'captures')?.value, expected) ??
    pass,
  calibrations: [
    {
      // What discovery answered before 2026-11-24: the outer `a` at the point in the first case.
      name: 'outer-name-offered-under-a-later-case',
      law: 'tdz-safe-captures',
      history: { constructed: 'later-case-declares-the-outer-name' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'captures'
            ? { ...o, value: { ...(o.value as object), captures: [['a'], ['a']] } }
            : o,
        ),
    },
    {
      name: 'offered-capture-cannot-be-read',
      law: 'tdz-safe-captures',
      history: { constructed: 'function-called-before-a-later-const' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'captures'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  failedReads: ["a at scopes.ts#b:CallExpression:at:0: Cannot access 'a' before initialization"],
                },
              }
            : o,
        ),
    },
    {
      // A rule that offers nothing inside a hoisted function is safe, and hides `a` here.
      name: 'initialized-name-left-out',
      law: 'tdz-safe-captures',
      history: { constructed: 'function-called-only-after-a-later-const' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'captures'
            ? { ...o, value: { ...(o.value as object), captures: [['b'], ['a', 'b']] } }
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
    'src/discovery.ts#loadManifest',
    'src/discovery.ts#resolveTargetFiles',
    'src/discovery.ts#buildTargetPlan',
  ],
  law: {
    statement:
      'For every manifest and target list of explicit paths and globs, loadManifest, resolveTargetFiles, and buildTargetPlan resolve matching files relative to root in sorted order, apply in-memory overrides, skip missing unoverridden files, and index each target module.',
    authority:
      'README.md:122 ("points.ep lists the target application modules to index (explicit paths or glob patterns)") and src/discovery.ts:12-28, 204-224.',
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
