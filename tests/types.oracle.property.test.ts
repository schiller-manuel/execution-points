/**
 * This oracle owns `execution-points-prototype`'s TypeScript type-level
 * contracts in `src/runtime.d.ts` paired with `generateFileRegistryModule`,
 * checked on the semantic diagnostics produced by TypeScript 7.1 when checking
 * test snippets against the real `src/runtime.d.ts` and emitted registry. It
 * owns `src/runtime.d.ts`.
 *
 * ```ts
 * select('app.ts', (n) => n.callee === 'send' && n) // → compiles with exact Result without needing kind or inFunction
 * select('app.ts', (n) => n.callee === 'sendd' && n) // → compile error (TS2367 typo on literal callee union)
 * select('app.ts', (n) => n.callee === 'send' ? n.capture() : undefined) // → locals is {}, rejecting access to uncaptured keys
 * syncVoidPoint.withReplacement(async () => {}, () => run()) // → compile error (async handler rejected on sync void point)
 * ```
 *
 * Why does `if (node.callee === 'send') return node` falsely report "matched
 * multiple expressions" when `FileNodes` intersects with `NodeDescriptor`, and
 * why does `.capture()` with zero arguments type `locals` as capturing every
 * binding when the runtime captures none?
 *
 * Two type-level mechanisms govern compile-time safety: **disjoint node
 * narrowing** (`Extract<ExecutionPointFileRegistry[F], NodeDescriptor>` over
 * emitted `callee?: undefined` / `operator?: undefined` fields plus
 * `__unportable` markers so compile-time match counts equal runtime counts),
 * and **capture and handler soundness** (`= never` default on `.capture()`,
 * `HandlerResult<R>` rejecting `Promise` returns on sync `void` points, and
 * empty-registry `ExecutionPointsNotLoaded` diagnostics without `never`
 * cascades).
 *
 * For every target file with call, binary, conditional, and unportable generic
 * expressions, `select(file, visitor)` accepts minimal `n.callee === 'x' && n`
 * selectors without `kind`, rejects callee typos (TS2367), reports matched
 * node IDs (`__matched`) on ambiguous matches, preserves compile/runtime parity
 * for unportable generic nodes, and rejects direct selection of an unportable
 * node with an explicit `__selectionError` (Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-24).
 *
 * For every `select` call checked when `ExecutionPointFileRegistry` is empty,
 * TypeScript reports an explicit `ExecutionPointsNotLoaded` diagnostic on the
 * file argument and avoids cascading `Property '...' does not exist on type
 * 'never'` errors (Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24).
 *
 * For every `.capture(...keys)` call on a visitor node or selected point,
 * omitting `keys` types `locals` as `{}` (rejecting reads of uncaptured
 * bindings), passing valid keys narrows `locals` to those readonly bindings,
 * chaining `.capture(...)` replaces prior keys, and passing an unknown key is a
 * compile error (Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24).
 *
 * For every `.withReplacement(handler, action)` call, an `async` handler on a
 * synchronous `void` expression is a compile error, while synchronous `void`,
 * `return original()`, `any`-typed expressions, and `async` handlers on
 * `Promise<void>` expressions compile cleanly (Decision by Manuel Schiller
 * (GitHub schiller-manuel), 2026-11-24).
 *
 * The model predicts whether each constructed TypeScript snippet compiles
 * cleanly or produces the expected diagnostic code/substring. The driver builds
 * an in-memory TypeScript 7.1 program containing the real `src/runtime.d.ts`,
 * the generated `ExecutionPointFileRegistry` (or omits it for empty-registry
 * checks), and the snippet, then records semantic diagnostics.
 *
 * LSP completion ordering is verified separately in `checks/verify.mjs`; this
 * oracle checks semantic type-checking contracts across `src/runtime.d.ts`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { API, ModuleKind, ModuleResolutionKind } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { ScriptTarget } from 'typescript/ast'
import { afterAll } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { generateFileRegistryModule } from '../src/contracts.mjs'
import { buildTargetPlan } from '../src/discovery.mjs'

const root = process.cwd()
const sharedApi = new API({ cwd: root })
afterAll(() => {
  sharedApi.close()
})

const TARGET_REL = 'examples/type-oracle-target.ts'
const TARGET_SOURCE = `
function send(id: string): number { return id.length }
function logSync(msg: string): void { void msg }
async function logAsync(msg: string): Promise<void> { void msg }
function getAny(): any { return 1 }
function identity<T>(v: T): T { return v }

export function work(a: number, b: number, flag: boolean) {
  const sum = a + b
  const chosen = flag ? 'yes' : 'no'
  const len = send(chosen)
  logSync(chosen)
  const asyncP = logAsync(chosen)
  const raw = getAny()
  const concrete = identity(sum)
  return { sum, len, asyncP, raw, concrete }
}

export function genericWork<U>(val: U) {
  return identity(val)
}
`

function checkSnippet(snippet: string, { emptyRegistry = false } = {}) {
  const runtimeDts = readFileSync(join(root, 'src/runtime.d.ts'), 'utf8')
  const pkgJson = JSON.stringify({
    name: 'execution-points-prototype',
    type: 'module',
    exports: { '.': { types: './src/runtime.d.ts', default: './src/runtime.mjs' } },
  })
  const absTarget = join(root, TARGET_REL)
  const absTest = join(root, 'examples/type-oracle-snippet.test.ts')
  const absRegistry = join(root, '__type_oracle_registry.d.ts')

  const files = new Map<string, string>([
    [join(root, 'node_modules/execution-points-prototype/package.json'), pkgJson],
    [join(root, 'node_modules/execution-points-prototype/src/runtime.d.ts'), runtimeDts],
    [absTarget, TARGET_SOURCE],
    [absTest, snippet],
  ])

  const rootFiles = [absTarget, absTest]

  if (!emptyRegistry) {
    const overrides = new Map([[absTarget, TARGET_SOURCE]])
    const plan = buildTargetPlan({ root, targets: [TARGET_REL], overrides, api: sharedApi })
    const { text: registryText } = generateFileRegistryModule(plan, {
      fromFile: absRegistry,
      api: sharedApi,
      overrides,
    })
    files.set(absRegistry, registryText)
    rootFiles.push(absRegistry)
  }

  const snapshot = sharedApi.createSnapshot({
    fileSystem: createFileSystemLayer([...files]),
    createPrograms: [
      {
        rootFiles,
        compilerOptions: {
          strict: true,
          target: ScriptTarget.ES2022,
          module: ModuleKind.ESNext,
          moduleResolution: ModuleResolutionKind.Bundler,
          noEmit: true,
          skipLibCheck: true,
        },
      },
    ],
  })

  try {
    const prog = snapshot.operation.createdPrograms[0]
    const diags = [...prog.getSemanticDiagnostics(), ...prog.getSyntacticDiagnostics()]
      .filter((d) => d.category === 1 && d.fileName?.endsWith('type-oracle-snippet.test.ts'))
      .map((d) => ({
        code: d.code,
        text: [d.text ?? '', ...(d.messageChain ?? []).map((c) => c.text)].join(' '),
      }))
    return {
      ok: diags.length === 0,
      count: diags.length,
      codes: diags.map((d) => d.code),
      allText: diags.map((d) => `TS${d.code}: ${d.text}`).join('\n'),
    }
  } finally {
    snapshot.dispose()
  }
}

// ---------------------------------------------------------------------------
// Law T1: Minimal select() narrowing, typos, false|null returns, __matched, unportable parity
// ---------------------------------------------------------------------------

const T1_CASES = [
  'minimal-callee-with-and-shortcircuit',
  'minimal-operator-without-kind',
  'typo-callee-ts2367',
  'zero-match-selection-error',
  'multi-match-surfaces-matched-ids',
  'unportable-generic-counts-in-multi-match',
  'unportable-generic-direct-selection-error',
] as const

type T1Case = (typeof T1_CASES)[number]

function t1Model(c: T1Case) {
  switch (c) {
    case 'minimal-callee-with-and-shortcircuit':
    case 'minimal-operator-without-kind':
      return { ok: true, hasExpectedMarker: true }
    case 'typo-callee-ts2367':
      return { ok: false, hasExpectedMarker: true }
    case 'zero-match-selection-error':
      return { ok: false, hasExpectedMarker: true }
    case 'multi-match-surfaces-matched-ids':
      return { ok: false, hasExpectedMarker: true }
    case 'unportable-generic-counts-in-multi-match':
      return { ok: false, hasExpectedMarker: true }
    case 'unportable-generic-direct-selection-error':
      return { ok: false, hasExpectedMarker: true }
  }
}

oracleProperty({
  id: 'types-minimal-select-and-parity',
  owns: ['src/runtime.d.ts', 'src/contracts.mjs#renderFileModule'],
  law: {
    statement:
      'For every target module, select(file, visitor) accepts minimal callee/operator narrowing with && short-circuit returns without requiring kind, rejects callee typos with TS2367, lists __matched node IDs on multiple matches, and keeps unportable generic nodes in the compile-time match count while rejecting direct selection with an explicit error.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: disjoint callee/operator discriminators, false|null visitor returns, __matched IDs, and unportable-node parity.',
    limits: 'Checked via TypeScript 7.1 semantic diagnostics on examples/type-oracle-target.ts.',
  },
  histories: {
    enumerated: T1_CASES.map((c) => ({ c })),
    states: [
      'minimal-callee-accepted',
      'minimal-operator-accepted',
      'callee-typo-rejected',
      'zero-match-rejected',
      'multi-match-with-ids',
      'unportable-parity-multi-match',
      'unportable-direct-rejected',
    ],
  },
  label: (h) => h.c,
  model: (h) => t1Model(h.c),
  driver: (history, observe) => {
    const header = `import { select } from 'execution-points-prototype'\n`
    let code = ''
    let markerCheck: (allText: string, codes: number[]) => boolean = () => true

    switch (history.c) {
      case 'minimal-callee-with-and-shortcircuit':
        observe('reach', 'minimal-callee-accepted')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'send' && n)
const n: number = p.withReplacement(({ original }) => original() + 1, () => 0)
void n`
        break
      case 'minimal-operator-without-kind':
        observe('reach', 'minimal-operator-accepted')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.operator === '+' ? n : null)
const n: number = p.withReplacement(({ original }) => original() + 1, () => 0)
void n`
        break
      case 'typo-callee-ts2367':
        observe('reach', 'callee-typo-rejected')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'sendd' && n)
void p`
        markerCheck = (_txt, codes) => codes.includes(2367)
        break
      case 'zero-match-selection-error':
        observe('reach', 'zero-match-rejected')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, () => undefined)
p.withReplacement(() => 0, () => 0)`
        markerCheck = (txt) => txt.includes('matched 0')
        break
      case 'multi-match-surfaces-matched-ids':
        observe('reach', 'multi-match-with-ids')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.kind === 'CallExpression' && n)
p.withReplacement(() => 0, () => 0)`
        markerCheck = (txt) => txt.includes('__matched') && txt.includes('matched multiple')
        break
      case 'unportable-generic-counts-in-multi-match':
        observe('reach', 'unportable-parity-multi-match')
        code = `${header}
// identity() appears in both work() (portable) and genericWork<U>() (unportable) -> MUST be multi-match!
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'identity' && n)
p.withReplacement(({ original }) => original(), () => 0)`
        markerCheck = (txt) => txt.includes('matched multiple') && txt.includes('genericWork')
        break
      case 'unportable-generic-direct-selection-error':
        observe('reach', 'unportable-direct-rejected')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.inFunction === 'genericWork' && n.callee === 'identity' && n)
p.withReplacement(({ original }) => original(), () => 0)`
        markerCheck = (txt) => txt.includes('unportable') || txt.includes('__selectionError')
        break
    }

    const res = checkSnippet(code)
    observe('t1', {
      ok: res.ok,
      hasExpectedMarker: markerCheck(res.allText, res.codes),
    })
  },
  check: (_h, obs, expected) => {
    const e = obs.find((o) => o.checkpoint === 't1')
    if (!e) return differs('t1', 'minimal-select-and-parity', undefined, expected) ?? pass
    return differs('t1', 'minimal-select-and-parity', e.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'false-multi-match-on-minimal-callee',
      law: 'minimal-select-and-parity',
      history: { enumerated: 'minimal-callee-with-and-shortcircuit' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 't1' ? { ...o, value: { ok: false, hasExpectedMarker: true } } : o)),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law T2: Clear empty-registry diagnostic without `never` cascade
// ---------------------------------------------------------------------------

oracleProperty({
  id: 'types-empty-registry-diagnostic',
  owns: ['src/runtime.d.ts'],
  law: {
    statement:
      'For every select call checked when ExecutionPointFileRegistry is empty, TypeScript reports an explicit diagnostic explaining --runExternalCode and points.ep without cascading never-property errors.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: clear empty-registry diagnostic without never cascade.',
    limits: 'Simulated by omitting the generated registry augmentation from the snapshot.',
  },
  histories: {
    enumerated: [{ variant: 'visitor-with-capture' as const }, { variant: 'minimal-callee' as const }],
    states: ['empty-registry-visitor-with-capture', 'empty-registry-minimal-callee'],
  },
  label: (h) => `empty-registry-${h.variant}`,
  model: () => ({
    ok: false,
    mentionsRunExternalCode: true,
    hasNeverPropertyCascade: false,
    diagnosticCountAtMostOne: true,
  }),
  driver: (history, observe) => {
    observe('reach', `empty-registry-${history.variant}`)
    const code =
      history.variant === 'visitor-with-capture'
        ? `import { select } from 'execution-points-prototype'
const p = select('examples/type-oracle-target.ts', (n) => n.kind === 'CallExpression' && n.callee === 'send' && n.capture('chosen'))
p.withReplacement(({ locals, original }) => { void locals.chosen; return original() }, () => 0)`
        : `import { select } from 'execution-points-prototype'
const p = select('examples/type-oracle-target.ts', (n) => n.callee === 'send' && n).capture('chosen')
p.withReplacement(({ locals, original }) => { void locals.chosen; return original() }, () => 0)`
    const res = checkSnippet(code, { emptyRegistry: true })
    observe('t2', {
      ok: res.ok,
      mentionsRunExternalCode: res.allText.includes('--runExternalCode') && res.allText.includes('points.ep'),
      hasNeverPropertyCascade: res.allText.includes("does not exist on type 'never'"),
      diagnosticCountAtMostOne: res.count === 1,
    })
  },
  check: (_h, obs, expected) => {
    const e = obs.find((o) => o.checkpoint === 't2')
    if (!e) return differs('t2', 'empty-registry-diagnostic', undefined, expected) ?? pass
    return differs('t2', 'empty-registry-diagnostic', e.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'never-property-cascade',
      law: 'empty-registry-diagnostic',
      history: { enumerated: 'empty-registry-visitor-with-capture' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 't2'
            ? { ...o, value: { ok: false, mentionsRunExternalCode: false, hasNeverPropertyCascade: true, diagnosticCountAtMostOne: false } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law T3: .capture() soundness (= never default) and chained replacement
// ---------------------------------------------------------------------------

const T3_CASES = [
  'empty-capture-on-node-rejects-local-read',
  'empty-capture-on-point-resets-to-empty',
  'valid-capture-narrows-locals',
  'chained-capture-replaces-prior-keys',
  'unknown-capture-key-rejected',
] as const

type T3Case = (typeof T3_CASES)[number]

oracleProperty({
  id: 'types-capture-soundness',
  owns: ['src/runtime.d.ts'],
  law: {
    statement:
      'For every .capture(...keys) call on a visitor node or selected point, zero arguments types locals as {} (rejecting uncaptured local reads), valid keys expose typed readonly locals, chained .capture() replaces prior keys, and unknown keys fail compile time.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: fix 0-arg capture soundness with = never default.',
    limits: 'Checked on examples/type-oracle-target.ts send() call.',
  },
  histories: {
    enumerated: T3_CASES.map((c) => ({ c })),
    states: [
      'empty-node-capture-blocks-read',
      'empty-point-capture-blocks-read',
      'valid-capture-reads-ok',
      'chained-capture-replaces',
      'invalid-capture-rejected',
    ],
  },
  label: (h) => h.c,
  model: (h) => ({
    ok: h.c === 'valid-capture-narrows-locals',
  }),
  driver: (history, observe) => {
    const header = `import { select } from 'execution-points-prototype'\n`
    let code = ''
    switch (history.c) {
      case 'empty-capture-on-node-rejects-local-read':
        observe('reach', 'empty-node-capture-blocks-read')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'send' ? n.capture() : undefined)
p.withReplacement(({ locals, original }) => { const s: string = locals.chosen; void s; return original() }, () => 0)`
        break
      case 'empty-capture-on-point-resets-to-empty':
        observe('reach', 'empty-point-capture-blocks-read')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'send' ? n.capture('chosen') : undefined).capture()
p.withReplacement(({ locals, original }) => { const s: string = locals.chosen; void s; return original() }, () => 0)`
        break
      case 'valid-capture-narrows-locals':
        observe('reach', 'valid-capture-reads-ok')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'send' ? n.capture('chosen', 'sum') : undefined)
p.withReplacement(({ locals, original }) => { const s: 'yes' | 'no' = locals.chosen; const k: number = locals.sum; void [s, k]; return original() }, () => 0)`
        break
      case 'chained-capture-replaces-prior-keys':
        observe('reach', 'chained-capture-replaces')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'send' ? n.capture('chosen') : undefined).capture('sum')
// Reading 'chosen' after replacing capture with ('sum') MUST be rejected
p.withReplacement(({ locals, original }) => { void locals.chosen; return original() }, () => 0)`
        break
      case 'unknown-capture-key-rejected':
        observe('reach', 'invalid-capture-rejected')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'send' ? n.capture('doesNotExist') : undefined)
void p`
        break
    }
    const res = checkSnippet(code)
    observe('t3', { ok: res.ok })
  },
  check: (_h, obs, expected) => {
    const e = obs.find((o) => o.checkpoint === 't3')
    if (!e) return differs('t3', 'capture-soundness', undefined, expected) ?? pass
    return differs('t3', 'capture-soundness', e.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'unsound-empty-capture',
      law: 'capture-soundness',
      history: { enumerated: 'empty-capture-on-node-rejects-local-read' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 't3' ? { ...o, value: { ok: true } } : o)),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law T4: HandlerResult<R> rejects async handler on sync void point
// ---------------------------------------------------------------------------

const T4_CASES = [
  'async-on-sync-void-rejected',
  'sync-void-accepted',
  'return-original-on-sync-void-accepted',
  'async-on-promise-void-accepted',
  'any-result-accepts-async',
] as const

type T4Case = (typeof T4_CASES)[number]

oracleProperty({
  id: 'types-handler-result-safety',
  owns: ['src/runtime.d.ts'],
  law: {
    statement:
      'For every point.withReplacement(handler, action) call, an async handler returning a Promise is rejected on a synchronous void expression, while synchronous void, return original(), any results, and async handlers on Promise<void> expressions are accepted.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: HandlerResult<R> rejects detached async handlers on sync void points.',
    limits: 'Checked via TypeScript 7.1 semantic diagnostics.',
  },
  histories: {
    enumerated: T4_CASES.map((c) => ({ c })),
    states: [
      'async-sync-void-rejected',
      'sync-void-ok',
      'original-sync-void-ok',
      'async-promise-void-ok',
      'any-result-ok',
    ],
  },
  label: (h) => h.c,
  model: (h) => ({ ok: h.c !== 'async-on-sync-void-rejected' }),
  driver: (history, observe) => {
    const header = `import { select } from 'execution-points-prototype'\n`
    let code = ''
    switch (history.c) {
      case 'async-on-sync-void-rejected':
        observe('reach', 'async-sync-void-rejected')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'logSync' && n)
p.withReplacement(async () => {}, () => 0)`
        break
      case 'sync-void-accepted':
        observe('reach', 'sync-void-ok')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'logSync' && n)
p.withReplacement(() => {}, () => 0)`
        break
      case 'return-original-on-sync-void-accepted':
        observe('reach', 'original-sync-void-ok')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'logSync' && n)
p.withReplacement(({ original }) => original(), () => 0)`
        break
      case 'async-on-promise-void-accepted':
        observe('reach', 'async-promise-void-ok')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'logAsync' && n)
p.withReplacement(async () => {}, () => 0)`
        break
      case 'any-result-accepts-async':
        observe('reach', 'any-result-ok')
        code = `${header}
const p = select(${JSON.stringify(TARGET_REL)}, (n) => n.callee === 'getAny' && n)
p.withReplacement(async () => 123, () => 0)`
        break
    }
    const res = checkSnippet(code)
    observe('t4', { ok: res.ok })
  },
  check: (_h, obs, expected) => {
    const e = obs.find((o) => o.checkpoint === 't4')
    if (!e) return differs('t4', 'handler-result-safety', undefined, expected) ?? pass
    return differs('t4', 'handler-result-safety', e.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'detached-async-handler-accepted',
      law: 'handler-result-safety',
      history: { enumerated: 'async-on-sync-void-rejected' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 't4' ? { ...o, value: { ok: true } } : o)),
    },
  ],
})
