/**
 * This oracle owns `execution-points-prototype`'s Vite instrumentation plugin
 * (`executionPoints`), checked on the return values of `configResolved`,
 * `buildStart`, `watchChange`, and `transform(code, id)` and on the runtime
 * execution of instrumented code. It owns `src/plugin.mjs`.
 *
 * ```ts
 * await plugin.transform(code, '/abs/path/mod.ts') // → { code: instrumentedCode, map: SourceMap } for configured target modules
 * await plugin.transform(code, '/abs/path/mod.ts?raw') // → null for asset/worker queries, virtual modules, or non-target files
 * await plugin.transform(modifiedByPriorPlugin, '/abs/path/mod.ts') // → throws Error when code differs from indexed source
 * entry(n) // → runs its original statements, with no runtime call, until a replacement is installed for one of its own expressions
 * ```
 *
 * Why must a file starting with `\uFEFF#!/usr/bin/env node\n` keep the shebang
 * on line 1 before the injected `import { invoke, registerFile }` statement and
 * preserve exact expression offsets after the BOM?
 *
 * Three parts drive the Vite plugin: the **module filter** (`sourceFileName`
 * skipping `\0` virtual modules, `?raw`/`?url`/`?worker`/`?sharedworker`
 * queries, non-absolute IDs, and files with zero selectable expressions while
 * normalizing `file://` and `/@fs/` prefixes), the **expression instrumenter**
 * (`importOffset`, `uniqueName`, and `instrument` inserting collision-free
 * runtime imports after any BOM or `#!` shebang, wrapping nested expressions
 * outer-first on open and inner-first on close, and keeping the original
 * statements beside them for files no test has touched), and the **plan
 * watcher** (`getPlan` rebuilding the target plan when a watched file changes
 * or `watchChange` fires).
 *
 * For every Vite module `id` and `code`, `transform(code, id)` returns `null`
 * for virtual modules (`\0*`), asset/worker queries (`?raw`, `?url`, `?worker`,
 * `?sharedworker`), non-absolute IDs, non-target files, and target files with
 * zero selectable expressions; resolves `file://`, `/@fs/`, and query-suffixed
 * target IDs; and throws an `Error` when `code` does not match the indexed
 * target source (`README.md:174`, `src/plugin.mjs:72-91, 138-145`; Decision by
 * Manuel Schiller (GitHub schiller-manuel), 2026-11-23).
 *
 * For every target module with selectable expressions (including nested
 * expressions sharing `start` or `end` offsets, files starting with `\uFEFF`
 * and/or `#!`, and files declaring `__epInvoke`, `__epRegister`, or `__epFile`),
 * `transform(code, id)` inserts a collision-free `import` and `registerFile`
 * header after any BOM/shebang, wraps each expression outer-first on open and
 * inner-first on close with lazy capture thunks, and returns runnable code that
 * evaluates and replaces each expression accurately alongside a source map
 * (`README.md:72-86`, `src/plugin.mjs:93-134`; Decision by Manuel Schiller
 * (GitHub schiller-manuel), 2026-11-23).
 *
 * For every target module, `tsconfig.json`, and `points.ep` on disk,
 * `executionPoints` adopts `config.root` when `options.root` is omitted,
 * registers existing watched files via `addWatchFile`, and rebuilds the target
 * plan when a watched file's content changes on disk or `watchChange()` is
 * called (`src/plugin.mjs:16-70`; Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-23).
 *
 * For every target module, a function body evaluates its original statements
 * and never calls the runtime until a replacement is installed for one of its
 * own expressions: a call of an ordinary function reads its flag once, however
 * many expressions it evaluates, and code outside such a body (a generator or
 * constructor body, an expression-bodied arrow, a parameter default, a field
 * initializer, the module's top level) reads its flag once per outermost
 * selectable expression. A replacement installed for one function leaves every
 * other function of the file on its original statements. A replacement applies
 * to exactly the evaluations inside its scope, including those of a generator
 * that was started earlier and resumes inside the scope, and excluding those of
 * an async call that began outside it (`README.md:75`, `README.md:99-101`;
 * Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: performance
 * must be optimal, indistinguishable from uninstrumented code).
 *
 * The model predicts whether `transform` returns `null`, throws, or produces
 * instrumented code whose header placement, identifier names, registered
 * metadata, and runtime interception results match the target expressions. The
 * driver runs `executionPoints` hooks against temporary project directories and
 * executes the instrumented JavaScript against `src/runtime.mjs`. For the cost
 * law it hands the instrumented code a counting `invoke` and file flags whose
 * reads are counted, and it follows every copy of an expression in the
 * emitted code back through the source map.
 *
 * The plugin instruments only files listed in the target plan; TypeScript type
 * stripping is handled by Vite's downstream transform pipeline.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { executionPoints } from '../src/plugin.mjs'
import { invoke, registerFile, select } from '../src/runtime.mjs'

// ---------------------------------------------------------------------------
// Law P1: Module ID filtering, URL/prefix resolution, and source-sync guard
// ---------------------------------------------------------------------------

const FILTER_CASES = [
  'virtual-module',
  'query-raw',
  'query-url',
  'query-worker',
  'query-sharedworker',
  'relative-id',
  'unlisted-file',
  'empty-nodes-target',
  'file-url-target',
  'vite-fs-prefix-target',
  'allowed-query-target',
  'modified-source-mismatch',
] as const

type FilterCase = (typeof FILTER_CASES)[number]

interface FilterHistory {
  filterCase: FilterCase
}

const enumeratedFilterHistories: ReadonlyArray<FilterHistory> = FILTER_CASES.map((filterCase) => ({
  filterCase,
}))

function filterModel(history: FilterHistory) {
  switch (history.filterCase) {
    case 'virtual-module':
    case 'query-raw':
    case 'query-url':
    case 'query-worker':
    case 'query-sharedworker':
    case 'relative-id':
    case 'unlisted-file':
    case 'empty-nodes-target':
      return { outcome: 'null' }
    case 'file-url-target':
    case 'vite-fs-prefix-target':
    case 'allowed-query-target':
      return {
        outcome: 'transformed',
        pluginName: 'execution-points-prototype',
        pluginEnforce: 'pre',
        hasInvokeAndRegister: true,
        mapSourceMatches: true,
        mapIncludesContent: true,
        isHiresMap: true,
        // A version 3 source map with no symbol names.
        mapVersion: 3,
        mapNames: [],
      }
    case 'modified-source-mismatch':
      return { outcome: 'error', mentionsSourceChanged: true }
  }
}

oracleProperty({
  id: 'plugin-module-filtering-and-sync',
  owns: ['src/plugin.mjs#executionPoints', 'src/plugin.mjs#sourceFileName'],
  law: {
    statement:
      'For every Vite module id and code, transform(code, id) returns null for virtual modules (\\0*), asset/worker queries (?raw, ?url, ?worker, ?sharedworker), non-absolute IDs, non-target files, and target files with zero selectable expressions; resolves file://, /@fs/, and non-asset query IDs; and throws an Error when code differs from the indexed target source.',
    authority:
      'README.md:174 ("Instrument configured target modules and register node metadata through Vite (test files are untouched)") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law P1.',
    limits:
      'Only absolute paths, file:// URLs, and /@fs/ paths identify local target files.',
  },
  histories: {
    enumerated: enumeratedFilterHistories,
    states: [
      'skipped-non-target-or-asset',
      'transformed-resolved-id',
      'rejected-dirty-source',
    ],
  },
  label: (h) => h.filterCase,
  model: (history) => filterModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p1-'))
    try {
      const targetFile = join(tempDir, 'target.js')
      const emptyFile = join(tempDir, 'empty.js')
      const targetSrc = 'export function work(a) { return send(a); }\n'
      const emptySrc = 'export const x = 1;\n'
      writeFileSync(targetFile, targetSrc)
      writeFileSync(emptyFile, emptySrc)

      const plugin = executionPoints({
        root: tempDir,
        targets: ['target.js', 'empty.js'],
      })
      const watchedInFilter: Array<string> = []
      const filterCtx = {
        addWatchFile(f: string) {
          watchedInFilter.push(f)
        },
      }
      if (history.filterCase !== 'relative-id') {
        await plugin.buildStart.call(filterCtx)
      }

      let id: string
      let code = targetSrc
      switch (history.filterCase) {
        case 'virtual-module':
          observe('reach', 'skipped-non-target-or-asset')
          id = `\0${targetFile}`
          break
        case 'query-raw':
          observe('reach', 'skipped-non-target-or-asset')
          id = `${targetFile}?raw`
          break
        case 'query-url':
          observe('reach', 'skipped-non-target-or-asset')
          id = `${targetFile}?import&url`
          break
        case 'query-worker':
          observe('reach', 'skipped-non-target-or-asset')
          id = `${targetFile}?worker=1`
          break
        case 'query-sharedworker':
          observe('reach', 'skipped-non-target-or-asset')
          id = `${targetFile}?sharedworker`
          break
        case 'relative-id':
          observe('reach', 'skipped-non-target-or-asset')
          id = 'target.js'
          break
        case 'unlisted-file':
          observe('reach', 'skipped-non-target-or-asset')
          id = join(tempDir, 'other.js')
          break
        case 'empty-nodes-target':
          observe('reach', 'skipped-non-target-or-asset')
          id = emptyFile
          code = emptySrc
          break
        case 'file-url-target':
          observe('reach', 'transformed-resolved-id')
          id = pathToFileURL(targetFile).href
          break
        case 'vite-fs-prefix-target':
          observe('reach', 'transformed-resolved-id')
          id = `/@fs/${targetFile.replace(/^\/+/, '')}`
          break
        case 'allowed-query-target':
          observe('reach', 'transformed-resolved-id')
          id = `${targetFile}?v=123`
          break
        case 'modified-source-mismatch':
          observe('reach', 'rejected-dirty-source')
          id = targetFile
          code = `${targetSrc}// mutated by prior plugin\n`
          break
      }

      try {
        const res = await plugin.transform.call(filterCtx, code, id)
        if (res === null) {
          observe(
            'filter',
            history.filterCase === 'relative-id' && watchedInFilter.length > 0
              ? { outcome: 'unexpected-plan-build-on-relative-id' }
              : { outcome: 'null' },
          )
        } else {
          observe('filter', {
            outcome: 'transformed',
            pluginName: plugin.name,
            pluginEnforce: plugin.enforce,
            hasInvokeAndRegister:
              res.code.includes('__epInvoke') && res.code.includes('__epRegister'),
            mapSourceMatches: res.map?.sources?.[0] === targetFile,
            mapIncludesContent: res.map?.sourcesContent?.[0] === targetSrc,
            isHiresMap: (res.map?.mappings?.split(',').length ?? 0) > 15,
            mapVersion: res.map?.version,
            mapNames: res.map?.names,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        observe('filter', {
          outcome: 'error',
          mentionsSourceChanged: msg.includes('Source changed before instrumentation'),
        })
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'filter')
    if (!entry) return differs('filter', 'module-filtering-and-sync', undefined, expected) ?? pass
    return differs('filter', 'module-filtering-and-sync', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'wrong-filter-outcome',
      law: 'module-filtering-and-sync',
      history: { enumerated: 'file-url-target' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'filter' ? { ...o, value: { outcome: 'null' } } : o)),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law P2: Expression instrumentation, BOM/shebang headers, and collision safety
// ---------------------------------------------------------------------------

const PREFIX_KINDS = ['none', 'bom-only', 'shebang-only', 'bom-and-shebang'] as const
type PrefixKind = (typeof PREFIX_KINDS)[number]

interface InstrumentHistory {
  prefix: PrefixKind
  collideHelperNames: boolean
}

const enumeratedInstrumentHistories: ReadonlyArray<InstrumentHistory> = PREFIX_KINDS.flatMap(
  (prefix) => [
    { prefix, collideHelperNames: false },
    { prefix, collideHelperNames: true },
  ],
)

function instrumentModel(history: InstrumentHistory) {
  return {
    headerStartsCorrectly: true,
    invokeAlias: history.collideHelperNames ? '__epInvoke_1' : '__epInvoke',
    registerAlias: history.collideHelperNames ? '__epRegister_1' : '__epRegister',
    fileStateAlias: history.collideHelperNames ? '__epFile_1' : '__epFile',
    unreplacedResult: 27, // getClient().send(10 + addFee(3)) + secondSend(1) = 26 + 1
    outerReplacedResult: 100, // 99 + 1
    secondSendReplacedResult: 76, // 26 + 50 (with captured b = 1)
    innerClientReplacedResult: 40, // 39 + 1
    innerAddReplacedResult: 41, // 40 + 1
    capturedBaseAndFee: [10, 3],
    capturedArrowB: 1,
    // Every copy of an expression in the emitted code maps back to where the expression is written.
    copiesMappedElsewhere: { 'addFee(fee)': 0, 'base > 0': 0, 'pick(1)': 0 },
    // The instrumenter's own code belongs to no line of the original.
    ownCodeMappedToSource: 0,
  }
}

/** For each marker: how many of its copies in the emitted code the source map sends elsewhere. */
function copiesMappedElsewhere(
  generated: string,
  map: unknown,
  original: string,
  markers: ReadonlyArray<string>,
) {
  const position = (text: string, index: number) => {
    const before = text.slice(0, index)
    return { line: before.split('\n').length - 1, column: index - (before.lastIndexOf('\n') + 1) }
  }
  const sourceMap = new SourceMap(JSON.parse(JSON.stringify(map)))
  const misses: Record<string, number> = {}
  for (const marker of markers) {
    const written = position(original, original.indexOf(marker))
    let copies = 0
    let elsewhere = 0
    for (let at = generated.indexOf(marker); at !== -1; at = generated.indexOf(marker, at + 1)) {
      const here = position(generated, at)
      const entry = sourceMap.findEntry(here.line, here.column) as {
        originalLine?: number
        originalColumn?: number
      }
      copies += 1
      if (entry.originalLine !== written.line || entry.originalColumn !== written.column) elsewhere += 1
    }
    misses[marker] = copies === 0 ? -1 : elsewhere
  }
  return misses
}

/** How many of the instrumenter's own flag reads the source map attributes to the original file. */
function ownCodeMappedToSource(generated: string, map: unknown, flagRead: string) {
  const sourceMap = new SourceMap(JSON.parse(JSON.stringify(map)))
  let mapped = 0
  for (let at = generated.indexOf(flagRead); at !== -1; at = generated.indexOf(flagRead, at + 1)) {
    const before = generated.slice(0, at)
    const entry = sourceMap.findEntry(before.split('\n').length - 1, at - (before.lastIndexOf('\n') + 1)) as {
      originalSource?: string
    }
    if (entry.originalSource !== undefined) mapped += 1
  }
  return mapped
}

oracleProperty({
  id: 'plugin-expression-instrumentation-and-collision-safety',
  owns: [
    'src/plugin.mjs#executionPoints',
    'src/plugin.mjs#uniqueName',
    'src/plugin.mjs#importOffset',
  ],
  law: {
    statement:
      'For every target module with selectable expressions (including nested expressions sharing start or end offsets, files starting with UTF-8 BOM \\uFEFF and/or #! shebang, and files declaring __epInvoke, __epRegister, or __epFile), transform(code, id) inserts a collision-free import and registerFile header after any BOM/shebang, wraps each expression outer-first on open and inner-first on close with lazy capture thunks, and produces runnable instrumented code.',
    authority:
      'README.md:72-86 ("The hook runs before the whole selected expression is evaluated"), src/plugin.mjs:93-155, and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law P2.',
    limits:
      'Shebang lines must appear at the start of the file (immediately or after a UTF-8 BOM); histories are bounded-exhaustive over a composite nested-expression fixture across BOM, shebang, and helper-collision variants.',
  },
  histories: {
    enumerated: enumeratedInstrumentHistories,
    states: [
      'instrumented-standard-module',
      'instrumented-with-bom-or-shebang',
      'instrumented-with-identifier-collision',
    ],
  },
  label: (h) => `${h.prefix}:${h.collideHelperNames ? 'collide' : 'clean'}`,
  model: (history) => instrumentModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p2-'))
    try {
      if (history.prefix === 'none') observe('reach', 'instrumented-standard-module')
      else observe('reach', 'instrumented-with-bom-or-shebang')
      if (history.collideHelperNames) observe('reach', 'instrumented-with-identifier-collision')

      const prefixText =
        history.prefix === 'none'
          ? ''
          : history.prefix === 'bom-only'
            ? '\uFEFF'
            : history.prefix === 'shebang-only'
              ? '#!/usr/bin/env node\n'
              : '\uFEFF#!/usr/bin/env node\n'

      const collisionDecls = history.collideHelperNames
        ? 'const __epInvoke = "user";\nconst __epRegister = "user";\nconst __epFile = "user";\n'
        : ''

      const relFile = `inst-${history.prefix}-${history.collideHelperNames ? 'c' : 'n'}.js`
      const targetFile = join(tempDir, relFile)
      // Nested expressions:
      // 1. `getClient().send(base + addFee(fee))` — `getClient()` and `getClient().send(...)` share `start`
      // 2. `base > 0 ? (b) => getClient().send(b) : (a) => a` — the outer ConditionalExpression (captures: ['base', 'fee'])
      //    and the inner CallExpression `getClient().send(b)` (captures: ['b', 'base', 'fee'], nth: 1) share the exact same `end` offset!
      const src =
        `${prefixText}${collisionDecls}` +
        `function getClient() { return { send: (v) => v * 2 }; }\n` +
        `function addFee(f) { return f; }\n` +
        `export function compute(base) {\n` +
        `  const fee = 3;\n` +
        `  const first = getClient().send(base + addFee(fee));\n` +
        `  const pick = base > 0 ? (b) => getClient().send(b) : (a) => a;\n` +
        `  return first + pick(1) - 1;\n` +
        `}\n`

      writeFileSync(targetFile, src)
      const plugin = executionPoints({ root: tempDir, targets: [relFile] })
      await plugin.buildStart.call({})

      const res = await plugin.transform.call({}, src, targetFile)
      if (!res) {
        observe('instrument', { unexpectedNull: true })
        return
      }

      const expectedPrefix = `${prefixText}import { invoke as `
      const headerStartsCorrectly = res.code.startsWith(expectedPrefix)
      const aliasMatch = /import \{ invoke as (\w+), registerFile as (\w+) \}/.exec(res.code)
      const invokeAlias = aliasMatch ? aliasMatch[1]! : 'missing'
      // The name under which the instrumented code keeps the flags that registerFile returns.
      const fileStateAlias = /\nconst (\w+) = \w+\(".*?", \[/.exec(res.code)?.[1] ?? 'missing'
      const registerAlias = aliasMatch ? aliasMatch[2]! : 'missing'

      // Execute the instrumented module body in memory against real `invoke` and `registerFile`
      const executableBody = res.code
        .replace(/^\uFEFF/, '')
        .replace(/^#![^\n]*\n/, '')
        .replace(/import \{ invoke as \w+, registerFile as \w+ \} from "execution-points-prototype\/runtime";\n/, '')
        .replace(/export function compute/, 'function compute') +
        '\nreturn compute;'

      const factory = new Function(invokeAlias, registerAlias, executableBody)
      const computeFn = factory(invoke, registerFile) as (base: number) => number

      const unreplacedResult = computeFn(10)

      const sendPoint0 = select(relFile, (n) =>
        n.inFunction === 'compute' && n.kind === 'CallExpression' && n.callee === 'send' && n.nth === 0
          ? n.capture('base', 'fee')
          : undefined,
      )
      const sendPoint1 = select(relFile, (n) =>
        n.inFunction === 'compute' && n.kind === 'CallExpression' && n.callee === 'send' && n.nth === 1
          ? n.capture('b')
          : undefined,
      )
      const getClientPoint0 = select(relFile, (n) =>
        n.inFunction === 'compute' &&
        n.kind === 'CallExpression' &&
        n.callee === 'getClient' &&
        n.nth === 0
          ? n
          : undefined,
      )
      const sumPoint = select(relFile, (n) =>
        n.inFunction === 'compute' && n.kind === 'BinaryExpression' && n.operator === '+' && n.nth === 0
          ? n
          : undefined,
      )

      let capturedBaseAndFee: Array<number> = []
      const outerReplacedResult = sendPoint0.withReplacement(
        ({ locals }) => {
          const l = locals as { base: number; fee: number }
          capturedBaseAndFee = [l.base, l.fee]
          return 99
        },
        () => computeFn(10),
      )

      let capturedArrowB = -1
      const secondSendReplacedResult = sendPoint1.withReplacement(
        ({ locals }) => {
          capturedArrowB = (locals as { b: number }).b
          return 51
        },
        () => computeFn(10),
      )

      const innerClientReplacedResult = getClientPoint0.withReplacement(
        () => ({ send: (v: number) => v * 3 }),
        () => computeFn(10),
      )

      const innerAddReplacedResult = sumPoint.withReplacement(
        () => 20,
        () => computeFn(10),
      )

      observe('instrument', {
        headerStartsCorrectly,
        invokeAlias,
        registerAlias,
        fileStateAlias,
        unreplacedResult,
        outerReplacedResult,
        secondSendReplacedResult,
        innerClientReplacedResult,
        innerAddReplacedResult,
        capturedBaseAndFee,
        capturedArrowB,
        // Innermost expressions stay in one piece in every copy the instrumenter emits.
        copiesMappedElsewhere: copiesMappedElsewhere(res.code, res.map, src, [
          'addFee(fee)',
          'base > 0',
          'pick(1)',
        ]),
        ownCodeMappedToSource: ownCodeMappedToSource(res.code, res.map, `${fileStateAlias}$`),
      })
    } catch (err) {
      observe('instrument', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'instrument')
    if (!entry)
      return (
        differs('instrument', 'expression-instrumentation-and-collision-safety', undefined, expected) ??
        pass
      )
    return (
      differs(
        'instrument',
        'expression-instrumentation-and-collision-safety',
        entry.value,
        expected,
      ) ?? pass
    )
  },
  calibrations: [
    {
      name: 'wrong-instrumented-result',
      law: 'expression-instrumentation-and-collision-safety',
      history: { enumerated: 'none:clean' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'instrument'
            ? { ...o, value: { ...(o.value as object), outerReplacedResult: -1 } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law P4: A file that no test has touched runs its original statements
// ---------------------------------------------------------------------------

// Where the one `tick(...)` call of the fixture lives.
// - `body`: an `ordinary` body runs within one call of a function, so the call decides once; a
//   `deferred` position is evaluated by a call, a construction, or a resumption that can happen
//   any time later, so each outermost expression decides.
// - `repeats`: whether one call evaluates `tick` once per loop turn or exactly once.
// - `inner`: the call sits in a function or class that an ordinary outer call creates; each
//   use of that inner position decides for itself.
// - `earlier`: work that starts before the first replacement and is used `inside` a scope later
//   (a suspended generator, a returned callback or class), or an async call that began `outside`.
const HOST_TRAITS = {
  function: { body: 'ordinary', repeats: true, inner: false, earlier: 'none' },
  'arrow-block': { body: 'ordinary', repeats: true, inner: false, earlier: 'none' },
  method: { body: 'ordinary', repeats: true, inner: false, earlier: 'none' },
  getter: { body: 'ordinary', repeats: true, inner: false, earlier: 'none' },
  'async-function': { body: 'ordinary', repeats: true, inner: false, earlier: 'outside' },
  generator: { body: 'deferred', repeats: true, inner: false, earlier: 'inside' },
  constructor: { body: 'deferred', repeats: true, inner: false, earlier: 'none' },
  'arrow-expression': { body: 'deferred', repeats: false, inner: false, earlier: 'none' },
  field: { body: 'deferred', repeats: false, inner: false, earlier: 'none' },
  default: { body: 'deferred', repeats: false, inner: false, earlier: 'none' },
  'returned-arrow': { body: 'ordinary', repeats: true, inner: true, earlier: 'inside' },
  'returned-function': { body: 'ordinary', repeats: true, inner: true, earlier: 'inside' },
  'returned-class-field': { body: 'ordinary', repeats: false, inner: true, earlier: 'inside' },
  'block-callback': { body: 'ordinary', repeats: false, inner: true, earlier: 'none' },
} as const
type Host = keyof typeof HOST_TRAITS
const HOSTS = Object.keys(HOST_TRAITS) as ReadonlyArray<Host>

interface UnusedFileHistory {
  host: Host
  /** The argument of the call: the number of loop turns, or the value passed to `tick`. */
  count: number
}

const enumeratedUnusedFileHistories: ReadonlyArray<UnusedFileHistory> = HOSTS.flatMap((host) =>
  [0, 1, 2, 3].map((count) => ({ host, count })),
)

const REPLACED = 100
const EARLIER_ARGUMENT = 5
const OTHER_ARGUMENT = 9

// A file's state outlives a history, so every run of the driver instruments a file of its own.
let unusedFileRuns = 0

/**
 * A replacement applies to exactly the evaluations inside its scope. Until one is installed for
 * one of its own expressions, code costs one flag read per ordinary call (or per outermost
 * expression elsewhere) and no runtime call, whatever was installed for other functions of the
 * file. The loop evaluates `i !== n` once more than it evaluates `tick(i)`.
 */
function unusedFileModel(history: UnusedFileHistory) {
  const { body, repeats, inner, earlier } = HOST_TRAITS[history.host]
  const n = history.count
  const ticks = repeats ? n : 1
  // The loop adds up tick(0) .. tick(n - 1); the single positions evaluate tick(n).
  const original = repeats ? Array.from({ length: n }, (_, i) => i).reduce((sum, i) => sum + i, 0) : n
  const outerReads = body === 'ordinary' ? 1 : repeats ? 2 * n + 1 : 1
  return {
    // Three top-level call statements, two of them after a line that lacks its semicolon.
    atLoad: { runtimeCalls: 0, stateReads: 3, statementsAfterUnterminatedLines: [true, true] },
    directiveStaysFirst: true,
    whileUnused: {
      result: original,
      runtimeCalls: 0,
      stateReads: inner ? outerReads + ticks : outerReads,
    },
    insideScope: ticks * REPLACED,
    outsideScopeAfterwards: original,
    // `first(v)` evaluates one call of its own and shares no expression with the replaced one.
    otherFunctionAfterwards: { result: OTHER_ARGUMENT, runtimeCalls: 0, stateReads: 1 },
    startedEarlier: earlier === 'inside' ? REPLACED : earlier === 'outside' ? 0 + 1 : null,
    copiesMappedElsewhere: { 'noop(0)': 0, 'noop(2)': 0 },
  }
}

function unusedFileSource(host: Host) {
  const turns = (bound: string, each: string) => `for (let i = 0; i !== ${bound}; i += 1) { ${each} }`
  const sum = (bound: string, pause = '') => `let s = 0; ${turns(bound, `${pause}s += tick(i)`)} return s`
  const hosted: Record<Host, string> = {
    function: `function entry(n) { ${sum('n')} }\nreturn { entry`,
    'arrow-block': `const entry = (n) => { ${sum('n')} }\nreturn { entry`,
    method: `const host = { entry(n) { ${sum('n')} } }\nreturn { host`,
    getter: `const host = { n: 0, get entry() { ${sum('this.n')} } }\nreturn { host`,
    'async-function': `async function entry(n, gate) { ${sum('n', 'await gate; ')} }\nreturn { entry`,
    generator: `function* entry(n) { ${turns('n', 'yield tick(i)')} }\nreturn { entry`,
    constructor: `class Host { constructor(n) { let s = 0; ${turns('n', 's += tick(i)')} this.sum = s } }\nreturn { Host`,
    'arrow-expression': `const entry = (n) => tick(n)\nreturn { entry`,
    field: `let arg = 0\nfunction setArg(n) { arg = n }\nclass Host { value = tick(arg) }\nreturn { Host, setArg`,
    default: `function entry(n, v = tick(n)) { return v }\nreturn { entry`,
    'returned-arrow': `function make(n) { const each = (i) => tick(i); let s = 0; ${turns('n', 's += each(i)')} return { s, each } }\nreturn { make`,
    'returned-function': `function make(n) { function each(i) { return tick(i) } let s = 0; ${turns('n', 's += each(i)')} return { s, each } }\nreturn { make`,
    'returned-class-field': `function make(n) { class Box { value = tick(n) } noop(n); return { s: new Box().value, Box } }\nreturn { make`,
    'block-callback': `function make(n) { let s = 0; [n].forEach((i) => { s += tick(i) }); return { s } }\nreturn { make`,
  }
  return (
    `function tick(i) { return i }\n` +
    `function noop(v) { return v }\n` +
    `function nothing() {}\n` +
    `function strict() { 'use strict'; return noop(this === undefined) }\n` +
    // A call statement right behind a function body, and two behind lines that lack a semicolon.
    `function first(v) { return noop(v) }noop(1)\n` +
    `const kept = noop\n` +
    `noop(0)\n` +
    `const keptToo = noop\n` +
    `noop(2).valueOf\n` +
    `${hosted[host]}, noop, kept, keptToo, strict, nothing, first }\n`
  )
}

oracleProperty({
  id: 'plugin-unused-file-runs-original-statements',
  owns: ['src/plugin.mjs#executionPoints', 'src/discovery.mjs#indexTargetFile'],
  law: {
    statement:
      'For every target module, a function body evaluates its original statements and never calls the runtime until a replacement is installed for one of its own expressions: a call of an ordinary function reads its flag once however many expressions it evaluates, and code outside such a body reads its flag once per outermost selectable expression; a replacement installed for one function leaves every other function of the file on its original statements, and a replacement applies to exactly the evaluations inside its scope.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: performance must be optimal, indistinguishable from uninstrumented code. README.md:75 ("No replacement is active | Evaluate the original expression normally. Do not read captures.") and README.md:99-101 (async-context scoping).',
    limits:
      'One replaced call per fixture, hosted in fourteen positions and evaluated zero to three times per call; the cost is counted before any replacement exists for the file and, for one other function, after the replacement was installed. The fixtures run as sloppy-mode function code, which is how the directive case is observed.',
  },
  histories: {
    enumerated: enumeratedUnusedFileHistories,
    states: [
      'ordinary-body-decides-once',
      'deferred-position-decides-per-expression',
      'inner-position-decides-for-itself',
      'used-inside-scope-after-starting-earlier',
      'continues-outside-scope-after-starting-earlier',
    ],
  },
  label: (h) => `${h.host}:${h.count}`,
  model: (history) => unusedFileModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p4-'))
    const traits = HOST_TRAITS[history.host]
    try {
      observe(
        'reach',
        traits.body === 'ordinary' ? 'ordinary-body-decides-once' : 'deferred-position-decides-per-expression',
      )
      if (traits.inner) observe('reach', 'inner-position-decides-for-itself')
      if (traits.earlier === 'inside') observe('reach', 'used-inside-scope-after-starting-earlier')
      if (traits.earlier === 'outside') observe('reach', 'continues-outside-scope-after-starting-earlier')

      const relFile = `unused-${history.host}-${history.count}-${(unusedFileRuns += 1)}.js`
      const targetFile = join(tempDir, relFile)
      const src = unusedFileSource(history.host)
      writeFileSync(targetFile, src)
      const plugin = executionPoints({ root: tempDir, targets: [relFile] })
      await plugin.buildStart.call({})
      const res = await plugin.transform.call({}, src, targetFile)
      if (!res) {
        observe('unused', { unexpectedNull: true })
        return
      }
      const aliases = /import \{ invoke as (\w+), registerFile as (\w+) \}/.exec(res.code)!
      const body = res.code.replace(
        /import \{ invoke as \w+, registerFile as \w+ \} from "execution-points-prototype\/runtime";\n/,
        '',
      )

      let runtimeCalls = 0
      let stateReads = 0
      const countingInvoke = (id: string, original: () => unknown, captures: () => object) => {
        runtimeCalls += 1
        return invoke(id, original, captures as never)
      }
      const countingRegister = (file: string, nodes: never, homes: never) =>
        (registerFile(file, nodes, homes) as ReadonlyArray<{ on: boolean }>).map(
          (flag) =>
            new Proxy(flag, {
              get(target, key) {
                if (key === 'on') stateReads += 1
                return Reflect.get(target, key)
              },
            }),
        )
      type Handles = {
        entry: (n: number, gate?: Promise<void>) => any
        make: (n: number) => { s: number; each: (i: number) => number; Box: new () => { value: number } }
        host: { n: number; entry: any }
        Host: new (n?: number) => { sum: number; value: number }
        setArg: (n: number) => void
        noop: unknown
        kept: unknown
        keptToo: unknown
        strict: () => boolean
        first: (v: number) => number
      }
      const h = new Function(aliases[1]!, aliases[2]!, body)(countingInvoke, countingRegister) as Handles
      const atLoad = {
        runtimeCalls,
        stateReads,
        statementsAfterUnterminatedLines: [h.kept === h.noop, h.keptToo === h.noop],
      }
      const { strict } = h
      const directiveStaysFirst = strict()

      // One call of the hosted code with the history's argument.
      const call = async (n: number): Promise<number> => {
        if (traits.inner) return h.make(n).s
        switch (history.host) {
          case 'method':
            return h.host.entry(n)
          case 'getter':
            h.host.n = n
            return h.host.entry
          case 'generator':
            return [...h.entry(n)].reduce((sum: number, value: number) => sum + value, 0)
          case 'constructor':
            return new h.Host(n).sum
          case 'field':
            h.setArg(n)
            return new h.Host().value
          default:
            return h.entry(n)
        }
      }

      runtimeCalls = 0
      stateReads = 0
      const result = await call(history.count)
      const whileUnused = { result, runtimeCalls, stateReads }

      // Work that starts before the first replacement: a suspended generator, a returned callback
      // or class, and an async call waiting at its first `await`.
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const earlyGenerator = history.host === 'generator' ? h.entry(2) : undefined
      earlyGenerator?.next()
      const earlyMade = traits.inner && traits.earlier === 'inside' ? h.make(EARLIER_ARGUMENT) : undefined
      const earlyAsync = traits.earlier === 'outside' ? h.entry(2, gate) : undefined

      const point = select(relFile, (n) => (n.callee === 'tick' ? n : undefined))
      const insideScope = await point.withReplacement(
        () => REPLACED,
        () => call(history.count),
      )
      const outsideScopeAfterwards = await call(history.count)
      runtimeCalls = 0
      stateReads = 0
      const otherFunctionAfterwards = { result: h.first(OTHER_ARGUMENT), runtimeCalls, stateReads }
      const useEarlier = () => {
        if (earlyGenerator) return earlyGenerator.next().value
        if (earlyMade) return earlyMade.each ? earlyMade.each(EARLIER_ARGUMENT) : new earlyMade.Box().value
        release()
        return earlyAsync ?? null
      }
      const startedEarlier = await point.withReplacement(() => REPLACED, useEarlier)

      observe('unused', {
        atLoad,
        directiveStaysFirst,
        whileUnused,
        insideScope,
        outsideScopeAfterwards,
        otherFunctionAfterwards,
        startedEarlier,
        copiesMappedElsewhere: copiesMappedElsewhere(res.code, res.map, src, ['noop(0)', 'noop(2)']),
      })
    } catch (err) {
      observe('unused', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) =>
    differs(
      'unused',
      'unused-file-runs-original-statements',
      observations.find((o) => o.checkpoint === 'unused')?.value,
      expected,
    ) ?? pass,
  calibrations: [
    {
      name: 'ordinary-call-reads-state-per-expression',
      law: 'unused-file-runs-original-statements',
      history: { enumerated: 'function:3' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'unused'
            ? { ...o, value: { ...(o.value as object), whileUnused: { result: 3, runtimeCalls: 0, stateReads: 7 } } }
            : o,
        ),
    },
    {
      name: 'unused-file-calls-runtime',
      law: 'unused-file-runs-original-statements',
      history: { enumerated: 'arrow-expression:1' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'unused'
            ? { ...o, value: { ...(o.value as object), whileUnused: { result: 1, runtimeCalls: 1, stateReads: 1 } } }
            : o,
        ),
    },
    {
      name: 'early-generator-keeps-original-statements',
      law: 'unused-file-runs-original-statements',
      history: { enumerated: 'generator:2' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'unused' ? { ...o, value: { ...(o.value as object), startedEarlier: 1 } } : o,
        ),
    },
    {
      name: 'replacement-slows-an-unrelated-function',
      law: 'unused-file-runs-original-statements',
      history: { enumerated: 'method:1' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'unused'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  otherFunctionAfterwards: { result: OTHER_ARGUMENT, runtimeCalls: 1, stateReads: 1 },
                },
              }
            : o,
        ),
    },
    {
      name: 'returned-callback-keeps-original-statements',
      law: 'unused-file-runs-original-statements',
      history: { enumerated: 'returned-arrow:2' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'unused'
            ? { ...o, value: { ...(o.value as object), startedEarlier: EARLIER_ARGUMENT } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law P3: Config root adoption, file watching, and plan rebuild on source changes
// ---------------------------------------------------------------------------

const WATCH_SCENARIOS = [
  'adopt-config-root-and-watch-files',
  'preserve-explicit-options-root',
  'rebuild-on-target-file-edit',
  'rebuild-on-watch-change-hook',
] as const

type WatchScenario = (typeof WATCH_SCENARIOS)[number]

interface WatchHistory {
  scenario: WatchScenario
}

const enumeratedWatchHistories: ReadonlyArray<WatchHistory> = WATCH_SCENARIOS.map((scenario) => ({
  scenario,
}))

function watchModel(_history: WatchHistory) {
  return {
    watchedAtBuildStart: true,
    reusedPlanWatchCount: 1,
    rebuiltWatchCount: 2,
    initialHasFirst: true,
    updatedHasSecond: true,
  }
}

oracleProperty({
  id: 'plugin-watch-and-rebuild',
  owns: ['src/plugin.mjs#executionPoints', 'src/plugin.mjs#readSource'],
  law: {
    statement:
      'For every target module on disk, executionPoints adopts config.root when options.root is omitted, registers watched target files via addWatchFile, and rebuilds the target plan when a watched target file changes on disk or watchChange() is called.',
    authority:
      'src/plugin.mjs:16-70 and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law P3.',
    limits:
      'Missing target files on disk return undefined from readSource.',
  },
  histories: {
    enumerated: enumeratedWatchHistories,
    states: [
      'watched-files-registered',
      'rebuilt-after-disk-change',
      'rebuilt-after-watch-hook',
    ],
  },
  label: (h) => h.scenario,
  model: (history) => watchModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p3-'))
    try {
      const targetFile = join(tempDir, 'watched.js')
      const src1 = 'export function work() { return firstCall(1); }\n'
      const src2 = 'export function work() { return secondCall(1); }\n'
      writeFileSync(targetFile, src1)

      const overrides = new Map<string, string>()
      const plugin =
        history.scenario === 'preserve-explicit-options-root'
          ? executionPoints({ root: tempDir, targets: ['watched.js'] })
          : history.scenario === 'rebuild-on-watch-change-hook'
            ? executionPoints({ targets: ['watched.js'], overrides })
            : executionPoints({ targets: ['watched.js'] })

      plugin.configResolved({
        root: history.scenario === 'preserve-explicit-options-root' ? '/ignored-root' : tempDir,
      })

      let watchCalls = 0
      const watched = new Set<string>()
      const ctx = {
        addWatchFile(f: string) {
          watchCalls += 1
          watched.add(f)
        },
      }

      await plugin.buildStart.call(ctx)
      const watchedAtBuildStart = watched.has(targetFile) && watchCalls === 1

      // First transform when unchanged should reuse the plan cached by buildStart (watchCalls stays 1)
      const firstTransform = await plugin.transform.call(ctx, src1, targetFile)
      const reusedPlanWatchCount = watchCalls

      if (history.scenario === 'rebuild-on-watch-change-hook') {
        observe('reach', 'rebuilt-after-watch-hook')
        // Keep disk file unchanged (so sourcesChanged() is false!) and update via in-memory overrides + watchChange()
        overrides.set(targetFile, src2)
        plugin.watchChange()
      } else if (history.scenario === 'rebuild-on-target-file-edit') {
        observe('reach', 'rebuilt-after-disk-change')
        writeFileSync(targetFile, src2)
      } else {
        observe('reach', 'watched-files-registered')
        writeFileSync(targetFile, src2)
      }

      const secondTransform = await plugin.transform.call(ctx, src2, targetFile)
      const rebuiltWatchCount = watchCalls

      observe('watch', {
        watchedAtBuildStart,
        reusedPlanWatchCount,
        rebuiltWatchCount,
        initialHasFirst: Boolean(firstTransform?.code.includes('"firstCall"')),
        updatedHasSecond: Boolean(secondTransform?.code.includes('"secondCall"')),
      })
    } catch (err) {
      observe('watch', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'watch')
    if (!entry) return differs('watch', 'watch-and-rebuild', undefined, expected) ?? pass
    return differs('watch', 'watch-and-rebuild', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'stale-plan-after-edit',
      law: 'watch-and-rebuild',
      history: { enumerated: 'rebuild-on-target-file-edit' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'watch'
            ? { ...o, value: { ...(o.value as object), updatedHasSecond: false } }
            : o,
        ),
    },
  ],
})
