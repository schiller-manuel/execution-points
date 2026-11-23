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
 * (`importOffset`, `uniqueName`, and `MagicString` inserting collision-free
 * runtime imports after any BOM or `#!` shebang and wrapping nested expressions
 * outer-first on open and inner-first on close), and the **plan watcher**
 * (`getPlan`, `sourcesChanged`, and `watchFiles` rebuilding the target plan
 * when watched files or `watchChange` fire).
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
 * and/or `#!`, and files declaring `__epInvoke` or `__epRegister`),
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
 * The model predicts whether `transform` returns `null`, throws, or produces
 * instrumented code whose header placement, identifier names, registered
 * metadata, and runtime interception results match the target expressions. The
 * driver runs `executionPoints` hooks against temporary project directories and
 * executes the instrumented JavaScript against `src/runtime.mjs`.
 *
 * The plugin instruments only files listed in the target plan; TypeScript type
 * stripping is handled by Vite's downstream transform pipeline.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    unreplacedResult: 27, // getClient().send(10 + addFee(3)) + secondSend(1) = 26 + 1
    outerReplacedResult: 100, // 99 + 1
    secondSendReplacedResult: 76, // 26 + 50 (with captured b = 1)
    innerClientReplacedResult: 40, // 39 + 1
    innerAddReplacedResult: 41, // 40 + 1
    capturedBaseAndFee: [10, 3],
    capturedArrowB: 1,
  }
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
      'For every target module with selectable expressions (including nested expressions sharing start or end offsets, files starting with UTF-8 BOM \\uFEFF and/or #! shebang, and files declaring __epInvoke or __epRegister), transform(code, id) inserts a collision-free import and registerFile header after any BOM/shebang, wraps each expression outer-first on open and inner-first on close with lazy capture thunks, and produces runnable instrumented code.',
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
        ? 'const __epInvoke = "user";\nconst __epRegister = "user";\n'
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
        unreplacedResult,
        outerReplacedResult,
        secondSendReplacedResult,
        innerClientReplacedResult,
        innerAddReplacedResult,
        capturedBaseAndFee,
        capturedArrowB,
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
