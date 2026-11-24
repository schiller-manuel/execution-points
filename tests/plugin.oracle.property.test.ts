/**
 * This oracle owns `execution-points-prototype`'s Vite plugin (`executionPoints`): which
 * modules it instruments, what the instrumented code does, and what the plugin costs. It is
 * checked on what the hooks `config`, `configResolved`, `buildStart`, `watchChange`, and
 * `transform(code, id)` return, on the instrumented code as it runs, and on the files the
 * plugin reads. It owns `src/plugin.ts`.
 *
 * ```ts
 * executionPoints() // → instruments the targets that points.ep in the Vite root lists
 * plugin.transform(code, '/abs/mod.ts') // → { code, map } for a target module, when code is the file's own
 * plugin.transform(code, '/abs/other.ts') // → null, and no file is read, however many targets there are
 * plugin.transform(`'use client'\nexport ...`, '/abs/mod.ts') // → code that still begins with 'use client'
 * entry(n) // → runs its original statements, with no runtime call, until one of its own expressions is replaced
 * o?.find(1).name(2) // → instrumented, it still yields undefined when o is missing
 * ```
 *
 * Why does a module that is merely listed as a target have to behave, and cost, exactly as
 * before? Because most of a target file is never selected by any test: the plugin wraps every
 * selectable expression of it, and each wrap is a chance to drop a receiver, to cut an
 * optional chain in two, to turn `'use client'` into a plain string, or to pay for a call that
 * replaces nothing.
 *
 * Four parts drive the plugin. The **module filter** decides from the id and the target set
 * whether a module is instrumented at all. The **header** is the import and the registration
 * that the instrumented code needs, placed behind what must stay first in a file. The **two
 * bodies** are each function's original statements and its wrapped expressions, of which a
 * call picks one by its flag. The **target set** is the list of files the plugin instruments,
 * resolved at the start and again after a watched file changed.
 *
 * Law P1. For every module id and code, `transform` returns `null` for virtual modules,
 * asset and worker queries, ids that are no absolute path, files that are no target, targets
 * that are global scripts, and targets with nothing to select; it resolves `file://`, `/@fs/`,
 * and other queries; and it throws when the code is not the target file's own (`README.md`,
 * "Supported subset and limits"; Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-23, and 2026-11-24 for global scripts).
 *
 * Law P2. For every target module with selectable expressions, `transform` puts a header with
 * collision-free names behind any byte-order mark, shebang line, and leading directives, which
 * stay the first statements, wraps each expression outer-first with lazy capture thunks, and
 * returns code that runs, with a source map (`README.md`, "When replacement happens";
 * Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23, and 2026-11-24: leading
 * directives stay first).
 *
 * Law P3. For every project and every sequence of edits and transforms, the plugin adopts
 * `config.root` when it is given no root, registers every target file for watching whenever
 * it resolves the target set, and instruments a target as the file is on disk now. The
 * plugin reads a target file only in the `transform` call that instruments it, and only when
 * the code it is handed is not the code it instrumented last; no other call reads a file or
 * scans a directory, whatever the number of targets, except that the target set is resolved
 * once at `buildStart` and once after `watchChange()` (Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-23, and 2026-11-24: the work per `transform` call must not grow
 * with the number of targets).
 *
 * Law P4. For every target module, a function body evaluates its original statements and
 * never calls the runtime until a replacement is installed for one of its own expressions: a
 * call of an ordinary function reads its flag once, however many expressions it evaluates,
 * and code outside such a body (a generator or constructor body, an expression-bodied arrow,
 * a parameter default, a field initializer, the module's top level) reads its flag once per
 * outermost selectable expression. A replacement installed for one function leaves every
 * other function of the file on its original statements, and a replacement applies to exactly
 * the evaluations inside its scope (`README.md`, "What instrumentation costs" and "Replacement
 * scope"; Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: performance must
 * be optimal, indistinguishable from uninstrumented code).
 *
 * Law P5. For every target module, the instrumented code does what the module does as
 * written, call for call, with the same receivers, arguments, order, results, and errors,
 * while its flags are off and while they are on and nothing is replaced. Replacing one
 * registered expression by a value does what the module does with that value written in the
 * expression's place, and the registered expressions are the selectable ones (`README.md`,
 * "When replacement happens"; Decision by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24: every newly selectable shape behaves the same instrumented and uninstrumented,
 * replaced and unreplaced).
 *
 * Law P6. For every project, `executionPoints()` without `targets` instruments exactly the
 * targets that `points.ep` in the Vite root lists, reads the manifest once each time it
 * resolves the target set, and watches it; explicit `targets` win and leave the manifest
 * unread; a manifest that is missing, is not JSON, or is not what `points.schema.json`
 * describes stops the build with an error that names the file (Decision by Manuel Schiller
 * (GitHub schiller-manuel), 2026-11-24: one source of truth for targets).
 *
 * Law P7. For every user config, the `config()` hook contributes the library's Vitest setup
 * module, `execution-points-prototype/vitest`, so that Vite's merge keeps the user's setup
 * files, adds the library's once, and changes nothing else (Decision by Manuel Schiller
 * (GitHub schiller-manuel), 2026-11-24: a replacement that never runs must be loud, without
 * configuration).
 *
 * How the oracle knows. P1, P2, P6, and P7 run every combination of a few small dimensions
 * against a model that computes the answer from them. P3 generates sequences of edits and
 * transforms; its model is told from the outside (what is on disk, what the plugin was handed
 * last), and its driver counts the calls of `node:fs` that the plugin makes for paths inside
 * the project. P4 hands the instrumented code a counting `invoke` and flags whose reads are
 * counted, and follows every copy of an expression back through the source map. P5 runs the
 * expression shapes of `tests/expression-shapes-oracle.ts` in a world where every call logs
 * its receiver and arguments: the reference is the same source run uninstrumented, and run
 * with one expression overwritten by a value.
 *
 * Limits. The plugin instruments only files of the target set; removing TypeScript's types is
 * left to Vite. Code that reads its own source text sees the instrumented text. P7 judges
 * what the hook contributes, not that Vitest loads the setup module.
 */
import fs, { mkdirSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import fc from 'fast-check'
import { mergeConfig } from 'vite'
import { indexTargetFile } from '../src/discovery.ts'
import {
  CONTENTS,
  POSITIONS,
  SUBJECTS,
  WRAPPERS,
  isRunnable,
  judge,
  moduleOf,
  planShape,
  selectableIn,
  subjectVerdict,
  type Shape,
  type ShapePlan,
} from './expression-shapes-oracle'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { executionPoints } from '../src/plugin.ts'
import { invoke, registerFile, select, verifyReplacements } from '../src/runtime.ts'

// The drivers leave replacements behind on purpose (asynchronous scopes, unused ones). The
// library's own check after each test is not what these laws are about, so it finds nothing.
afterEach(() => {
  try {
    verifyReplacements()
  } catch {
    // Reported by the laws that own it.
  }
})

// ---------------------------------------------------------------------------
// Law P1: Module ID filtering, URL/prefix resolution, and source-sync guard
// ---------------------------------------------------------------------------

// How Vite names the module, and whether the name is a local file the plugin can look up.
const ID_FORMS = {
  path: true,
  'file-url': true,
  'vite-fs': true,
  'query-version': true,
  virtual: false,
  'query-raw': false,
  'query-url': false,
  'query-worker': false,
  'query-sharedworker': false,
  relative: false,
} as const
type IdForm = keyof typeof ID_FORMS

// What the file is: the first two can be instrumented.
const FILE_KINDS = {
  module: 'export function work(a) { return send(a); }\n',
  'module-by-import': `import './dep.js'\nfunction work(a) { return send(a); }\n`,
  'global-script': 'function work(a) { return send(a); }\n',
  'no-expressions': 'export const x = 1;\n',
  unlisted: 'export function work(a) { return send(a); }\n',
} as const
type FileKind = keyof typeof FILE_KINDS

interface FilterHistory {
  idForm: IdForm
  fileKind: FileKind
  /** Whether an earlier plugin changed the code before this one sees it. */
  changedBefore: boolean
}

const enumeratedFilterHistories: ReadonlyArray<FilterHistory> = (Object.keys(ID_FORMS) as Array<IdForm>).flatMap(
  (idForm) =>
    (Object.keys(FILE_KINDS) as Array<FileKind>).flatMap((fileKind) =>
      [false, true].map((changedBefore) => ({ idForm, fileKind, changedBefore })),
    ),
)

/**
 * A module is instrumented when its id names a local file that is a listed target, a module,
 * and holds something to select. Only then does it matter whether the code is still the
 * file's own.
 */
function filterModel(history: FilterHistory) {
  const instrumentable = history.fileKind === 'module' || history.fileKind === 'module-by-import'
  if (!ID_FORMS[history.idForm] || !instrumentable) return { outcome: 'null' }
  if (history.changedBefore) return { outcome: 'error', mentionsSourceChanged: true }
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
}

oracleProperty({
  id: 'plugin-module-filtering-and-sync',
  owns: ['src/plugin.ts#executionPoints', 'src/plugin.ts#sourceFileName'],
  law: {
    statement:
      'For every Vite module id and code, transform(code, id) returns null for virtual modules (\\0*), asset/worker queries (?raw, ?url, ?worker, ?sharedworker), non-absolute IDs, non-target files, target files that are global scripts (no import or export), and target files with zero selectable expressions; resolves file://, /@fs/, and non-asset query IDs; and throws an Error when code differs from the indexed target source.',
    authority:
      'README.md, "Supported subset and limits" ("Targets are TypeScript modules configured in points.ep. Global scripts are skipped.") and "Source layout" ("Instrument configured target modules ... (test files are untouched)"). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law P1; 2026-11-24: the runtime side agrees with the documented rule for global scripts and with the type registry, which skips them.',
    limits:
      'Only absolute paths, file:// URLs, and /@fs/ paths identify local target files. Every combination of ten id forms, five kinds of file, and code that is or is not the file\'s own.',
  },
  histories: {
    enumerated: enumeratedFilterHistories,
    states: [
      'skipped-non-target-or-asset',
      'skipped-global-script',
      'transformed-resolved-id',
      'rejected-dirty-source',
    ],
  },
  label: (h) => `${h.idForm}:${h.fileKind}:${h.changedBefore ? 'changed' : 'own'}`,
  model: (history) => filterModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p1-'))
    try {
      const expected = filterModel(history).outcome
      observe(
        'reach',
        expected === 'transformed'
          ? 'transformed-resolved-id'
          : expected === 'error'
            ? 'rejected-dirty-source'
            : history.fileKind === 'global-script' && ID_FORMS[history.idForm]
              ? 'skipped-global-script'
              : 'skipped-non-target-or-asset',
      )

      const targetFile = join(tempDir, 'target.js')
      const source = FILE_KINDS[history.fileKind]
      writeFileSync(targetFile, source)
      const plugin = executionPoints({
        root: tempDir,
        targets: history.fileKind === 'unlisted' ? ['another.js'] : ['target.js'],
      })
      const context = { addWatchFile() {} }
      await plugin.buildStart.call(context)

      const id = {
        path: targetFile,
        'file-url': pathToFileURL(targetFile).href,
        'vite-fs': `/@fs/${targetFile.replace(/^\/+/, '')}`,
        'query-version': `${targetFile}?v=123`,
        virtual: `\0${targetFile}`,
        'query-raw': `${targetFile}?raw`,
        'query-url': `${targetFile}?import&url`,
        'query-worker': `${targetFile}?worker=1`,
        'query-sharedworker': `${targetFile}?sharedworker`,
        relative: 'target.js',
      }[history.idForm]
      const code = history.changedBefore ? `${source}// changed by an earlier plugin\n` : source

      try {
        const res = await plugin.transform.call(context, code, id)
        if (res === null) {
          observe('filter', { outcome: 'null' })
        } else {
          observe('filter', {
            outcome: 'transformed',
            pluginName: plugin.name,
            pluginEnforce: plugin.enforce,
            hasInvokeAndRegister:
              res.code.includes('__epInvoke') && res.code.includes('__epRegister'),
            mapSourceMatches: res.map?.sources?.[0] === targetFile,
            mapIncludesContent: res.map?.sourcesContent?.[0] === source,
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
      history: { enumerated: 'file-url:module:own' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'filter' ? { ...o, value: { outcome: 'null' } } : o)),
    },
    {
      // What the plugin did before 2026-11-24: it instrumented a file with no import or export.
      name: 'global-script-instrumented',
      law: 'module-filtering-and-sync',
      history: { enumerated: 'path:global-script:own' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'filter' ? { ...o, value: filterModel({ idForm: 'path', fileKind: 'module', changedBefore: false }) } : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law P2: Expression instrumentation, BOM/shebang headers, and collision safety
// ---------------------------------------------------------------------------

// What stands before the first statement: a byte-order mark, a shebang line, and leading
// directives. `call-first` starts with a call, so the string behind it is no directive.
const DIRECTIVES = {
  none: { text: '', strict: false },
  one: { text: `"use strict"`, strict: true },
  two: { text: `'use client';\n// keeps the page interactive\n'use strict';`, strict: true },
  'call-first': { text: '', strict: false },
} as const
type DirectiveKind = keyof typeof DIRECTIVES

interface InstrumentHistory {
  bom: boolean
  shebang: boolean
  directives: DirectiveKind
  collideHelperNames: boolean
}

const enumeratedInstrumentHistories: ReadonlyArray<InstrumentHistory> = [false, true].flatMap((bom) =>
  [false, true].flatMap((shebang) =>
    (Object.keys(DIRECTIVES) as Array<DirectiveKind>).flatMap((directives) =>
      [false, true].map((collideHelperNames) => ({ bom, shebang, directives, collideHelperNames })),
    ),
  ),
)

/** The text that must stay at the very start of the file: the mark, the shebang line, the directives. */
const prologueOf = (history: InstrumentHistory) =>
  `${history.bom ? '\uFEFF' : ''}${history.shebang ? '#!/usr/bin/env node\n' : ''}${DIRECTIVES[history.directives].text}`

function instrumentModel(history: InstrumentHistory) {
  return {
    // The header follows the prologue: directly, or on a line of its own behind a directive.
    headerStartsCorrectly: true,
    // A directive that is still the first statement makes the code strict.
    runsStrict: DIRECTIVES[history.directives].strict,
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
    'src/plugin.ts#executionPoints',
    'src/plugin.ts#uniqueName',
    'src/plugin.ts#importOffset',
  ],
  law: {
    statement:
      'For every target module with selectable expressions (including nested expressions sharing start or end offsets, files starting with UTF-8 BOM \\uFEFF and/or #! shebang, files that begin with directives such as "use client", and files declaring __epInvoke, __epRegister, or __epFile), transform(code, id) inserts a collision-free import and registerFile header after any BOM/shebang and after the leading directives, which stay the first statements, wraps each expression outer-first on open and inner-first on close with lazy capture thunks, and produces runnable instrumented code.',
    authority:
      'README.md, "When replacement happens" ("The hook runs before the whole selected expression is evaluated"). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law P2; 2026-11-24: leading directives stay first.',
    limits:
      'Shebang lines must appear at the start of the file (immediately or after a UTF-8 BOM); histories are bounded-exhaustive over a composite nested-expression fixture across BOM, shebang, four prologues of directives, and helper-collision variants. A directive is observed by its effect, so the directive that is run is "use strict".',
  },
  histories: {
    enumerated: enumeratedInstrumentHistories,
    states: [
      'instrumented-standard-module',
      'instrumented-with-bom-or-shebang',
      'instrumented-with-identifier-collision',
      'instrumented-behind-directives',
      'string-behind-a-call-is-no-directive',
    ],
  },
  label: (h) =>
    `${h.bom ? 'bom+' : ''}${h.shebang ? 'shebang+' : ''}${h.directives}:${h.collideHelperNames ? 'collide' : 'clean'}`,
  model: (history) => instrumentModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p2-'))
    try {
      if (!history.bom && !history.shebang) observe('reach', 'instrumented-standard-module')
      else observe('reach', 'instrumented-with-bom-or-shebang')
      if (history.collideHelperNames) observe('reach', 'instrumented-with-identifier-collision')
      if (DIRECTIVES[history.directives].strict) observe('reach', 'instrumented-behind-directives')
      if (history.directives === 'call-first') observe('reach', 'string-behind-a-call-is-no-directive')

      const prologue = prologueOf(history)
      const collisionDecls = history.collideHelperNames
        ? 'const __epInvoke = "user";\nconst __epRegister = "user";\nconst __epFile = "user";\n'
        : ''

      const relFile = `inst-${history.bom ? 'b' : ''}${history.shebang ? 's' : ''}-${history.directives}-${history.collideHelperNames ? 'c' : 'n'}.js`
      const targetFile = join(tempDir, relFile)
      // Nested expressions:
      // 1. `getClient().send(base + addFee(fee))` — `getClient()` and `getClient().send(...)` share `start`
      // 2. `base > 0 ? (b) => getClient().send(b) : (a) => a` — the outer ConditionalExpression (captures: ['base', 'fee'])
      //    and the inner CallExpression `getClient().send(b)` (captures: ['b', 'base', 'fee'], nth: 1) share the exact same `end` offset!
      const src =
        `${prologue}${prologue ? '\n' : ''}` +
        // A call statement first: the string behind it is an expression, not a directive.
        (history.directives === 'call-first' ? `addFee(0);\n'use strict';\n` : '') +
        `${collisionDecls}` +
        `function isStrict() { return this === undefined; }\n` +
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

      const headerStartsCorrectly = res.code.startsWith(
        `${prologue}${DIRECTIVES[history.directives].text ? '\n' : ''}import { invoke as `,
      )
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
        '\nreturn { compute, isStrict };'

      const factory = new Function(invokeAlias, registerAlias, executableBody)
      const { compute: computeFn, isStrict } = factory(invoke, registerFile) as {
        compute: (base: number) => number
        isStrict: () => boolean
      }
      const runsStrict = isStrict()

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
        runsStrict,
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
      // What the plugin did before 2026-11-24: its header came first, so the string was no directive.
      name: 'header-before-the-directive',
      law: 'expression-instrumentation-and-collision-safety',
      history: { enumerated: 'one:clean' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'instrument'
            ? { ...o, value: { ...(o.value as object), headerStartsCorrectly: false, runsStrict: false } }
            : o,
        ),
    },
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
// Law P5: Instrumented code behaves as the module is written
// ---------------------------------------------------------------------------

const PLAIN_SHAPE: Shape = { position: 'value', wrapper: 'none', subject: 'call', content: 'plain' }

// A shape that JavaScript can run: no syntax that only TypeScript has.
const runnableShapeArbitrary: fc.Arbitrary<Shape> = fc.record({
  position: fc.constantFrom(...POSITIONS.filter((position) => isRunnable({ ...PLAIN_SHAPE, position }))),
  wrapper: fc.constantFrom(...WRAPPERS.filter((wrapper) => isRunnable({ ...PLAIN_SHAPE, wrapper }))),
  subject: fc.constantFrom(...SUBJECTS),
  content: fc.constantFrom(...CONTENTS.filter((content) => isRunnable({ ...PLAIN_SHAPE, content }))),
})

/** The one combination that turns a function of the fixture into text is run as a plain call instead. */
const runnable = (shape: Shape): Shape => (isRunnable(shape) ? shape : { ...shape, subject: 'call' })

interface Outcome {
  /** What the host returned, or the name of what it threw. */
  value: string
  /** Every call the code made, in order, with its receiver and its arguments. */
  log: Array<string>
  /** What a generator host yielded. */
  yields: Array<string>
}

/**
 * Runs one module of a shape in a world of its own and tells what happened. Every name the
 * shapes use is a value that can be called, constructed, used as a tag, and read from; each
 * call logs its receiver and arguments and returns a new such value, numbered in call order,
 * so a changed receiver, a skipped call, or a changed order all show.
 */
async function runShapeModule(
  source: string,
  host: ShapePlan['host'],
  hooks: (world: Record<string, unknown>) => Record<string, unknown> = () => ({}),
): Promise<Outcome | { compile: string }> {
  const log: Array<string> = []
  let made = 0
  const show = (value: unknown): string => {
    if (typeof value === 'function') return (value as { tag?: string }).tag ?? 'function'
    if (Array.isArray(value)) return `[${value.map(show).join(',')}]`
    if (value !== null && typeof value === 'object') {
      return typeof (value as { then?: unknown }).then === 'function' ? 'promise' : 'object'
    }
    return String(value)
  }
  const called = (name: string, receiver: unknown, args: Array<unknown>, constructed = false) => {
    // A function of the fixture that is handed over is called, the way `retry` or `map` would.
    const results = args
      .filter((arg) => typeof arg === 'function' && !(arg as { tag?: string }).tag)
      .map((arg) => {
        try {
          const result = (arg as () => unknown)()
          if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
            ;(result as Promise<unknown>).then(
              () => undefined,
              () => undefined,
            )
          }
          return show(result)
        } catch (error) {
          return (error as Error).name
        }
      })
    log.push(`${constructed ? 'new ' : ''}${name}(${args.map(show).join(',')}) on ${show(receiver)}${results.length ? ` ran ${results.join(',')}` : ''}`)
    return thing(`${name}#${(made += 1)}`)
  }
  const kind = Object.create(Function.prototype, {
    m: {
      value(this: unknown, ...args: Array<unknown>) {
        return called(`${show(this)}.m`, this, args)
      },
    },
    k: {
      value(this: unknown, ...args: Array<unknown>) {
        return called(`${show(this)}.k`, this, args)
      },
    },
    p: {
      get(this: { tag: string }) {
        return `${this.tag}.p`
      },
    },
    toString: {
      value(this: { tag: string }) {
        return this.tag
      },
    },
  })
  function thing(tag: string): unknown {
    const made = function (this: unknown, ...args: Array<unknown>) {
      return called(tag, this, args, new.target !== undefined)
    }
    Object.setPrototypeOf(made, kind)
    return Object.assign(made, { tag })
  }
  class Base {
    constructor(...args: Array<unknown>) {
      log.push(`Base(${args.map(show).join(',')})`)
    }
    m(...args: Array<unknown>) {
      return called('super.m', this instanceof Base ? 'host' : this, args)
    }
  }
  const world: Record<string, unknown> = {
    Base,
    out: {},
    f: thing('f'),
    g: thing('g'),
    mk: thing('mk'),
    o: thing('o'),
    z: undefined,
    p: Promise.resolve(thing('awaited')),
    x: thing('x'),
    y: thing('y'),
    SENTINEL: thing('sentinel'),
  }
  Object.assign(world, hooks(world))

  let Host: new (v: unknown) => { work: (v: unknown) => unknown }
  try {
    Host = new Function(...Object.keys(world), `'use strict';\n${source.replace('export class', 'class')}\nreturn Host`)(
      ...Object.values(world),
    )
  } catch (error) {
    return { compile: (error as Error).name }
  }
  const yields: Array<string> = []
  let value: string
  try {
    const v = thing('v')
    if (host === 'constructor') {
      new Host(v)
      value = show((world.out as { value?: unknown }).value)
    } else if (host === 'async-generator') {
      const iterator = new Host(v).work(v) as AsyncGenerator<unknown, unknown, unknown>
      let step = await iterator.next()
      while (!step.done) {
        yields.push(show(step.value))
        step = await iterator.next(thing('resumed'))
      }
      value = show(step.value)
    } else {
      value = show(await new Host(v).work(v))
    }
  } catch (error) {
    value = `threw ${(error as Error).name}`
  }
  return { value, log, yields }
}

const spanKey = (node: { start: number; end: number }) => `${node.start}:${node.end}`

/** What the shape shows of the law. */
function behaviorStates(shape: Shape): Array<string> {
  const plan = planShape(shape)
  const states = [plan.host === 'method' || plan.host === 'async-method' ? 'ordinary-body' : 'deferred-body']
  if (/-on-nothing$/.test(shape.subject) || /-on-nothing$|own-question/.test(shape.content)) states.push('chain-ends-on-nothing')
  if (judge(plan).some((candidate) => candidate.verdict === 'chain-goes-on')) states.push('chain-prefix-left-alone')
  if (subjectVerdict(plan) !== 'selectable') return states
  if (shape.subject.startsWith('optional-')) states.push('optional-chain-replaced')
  if (['callee', 'optional-callee', 'new-callee', 'tag'].includes(plan.shape.position)) states.push('call-replaced-where-it-is-called')
  if (shape.subject === 'super-method') states.push('super-method-replaced')
  if (/-in-/.test(shape.content) && !/-key$/.test(shape.content)) states.push('nested-function-inside-replaced')
  return states
}

const runnableShape =
  (position: Shape['position'], wrapper: Shape['wrapper'], subject: Shape['subject'], content: Shape['content']) =>
  (): Shape => ({ position, wrapper, subject, content })

oracleProperty({
  id: 'plugin-instrumented-code-behaves-as-written',
  owns: ['src/plugin.ts#executionPoints', 'src/discovery.ts#isSelectableExpression'],
  law: {
    statement:
      'For every target module, the instrumented code does what the module does as written, call for call, with the same receivers, arguments, order, results, and errors: while its flags are off, and while they are on and nothing is replaced. Replacing one registered expression by a value does what the module does with that value written in the expression\'s place, and the registered expressions are the selectable ones.',
    authority:
      'README.md, "When replacement happens" ("Returning a replacement value skips all of those operations", "No replacement is active: Evaluate the original expression normally", "preserving its receiver and evaluation order"). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: every newly selectable shape behaves the same instrumented and uninstrumented, replaced and unreplaced.',
    limits:
      'One expression inside one class member per history, in the shapes JavaScript can run (no type assertions, no assignment to a call or ternary, no import of nothing). A function that is turned into text shows its instrumented source, so the one shape that does so is run as a plain call. The reference is the same source run uninstrumented, and with the replaced expression overwritten by a value.',
  },
  histories: {
    arbitrary: runnableShapeArbitrary,
    runs: 120,
    fixedSeeds: [42],
    states: [
      'ordinary-body',
      'deferred-body',
      'chain-ends-on-nothing',
      'chain-prefix-left-alone',
      'optional-chain-replaced',
      'call-replaced-where-it-is-called',
      'super-method-replaced',
      'nested-function-inside-replaced',
    ],
    constructed: [
      { name: 'plain-call-in-a-method', enters: ['ordinary-body'], build: runnableShape('value', 'none', 'method', 'call') },
      { name: 'call-in-a-generator', enters: ['deferred-body'], build: runnableShape('yielded', 'none', 'method', 'call') },
      { name: 'call-in-a-constructor', enters: ['deferred-body'], build: runnableShape('argument', 'none', 'call', 'super-call') },
      {
        name: 'optional-chain-on-nothing',
        enters: ['chain-ends-on-nothing', 'optional-chain-replaced'],
        build: runnableShape('argument', 'none', 'optional-method-on-nothing', 'call'),
      },
      {
        name: 'chain-goes-on-behind-nothing',
        enters: ['chain-ends-on-nothing', 'chain-prefix-left-alone'],
        build: runnableShape('member-call', 'none', 'optional-method-on-nothing', 'plain'),
      },
      {
        name: 'chain-goes-on-inside-an-argument',
        enters: ['chain-ends-on-nothing', 'chain-prefix-left-alone'],
        build: runnableShape('value', 'none', 'call', 'chain-prefix-on-nothing'),
      },
      {
        name: 'chain-continued-with-its-own-question',
        enters: ['chain-ends-on-nothing', 'optional-chain-replaced'],
        build: runnableShape('optional-member-call', 'none', 'optional-method-on-nothing', 'plain'),
      },
      {
        name: 'optional-chain-in-parentheses',
        enters: ['optional-chain-replaced'],
        build: runnableShape('member-call', 'paren', 'optional-method', 'plain'),
      },
      { name: 'optional-call', enters: ['optional-chain-replaced'], build: runnableShape('operand', 'none', 'optional-call', 'optional-read') },
      { name: 'curried-call', enters: ['call-replaced-where-it-is-called'], build: runnableShape('callee', 'none', 'method', 'call') },
      { name: 'call-constructed', enters: ['call-replaced-where-it-is-called'], build: runnableShape('new-callee', 'none', 'call', 'plain') },
      { name: 'call-as-tag', enters: ['call-replaced-where-it-is-called'], build: runnableShape('tag', 'none', 'method', 'plain') },
      { name: 'call-called-if-present', enters: ['call-replaced-where-it-is-called'], build: runnableShape('optional-callee', 'none', 'curried', 'plain') },
      { name: 'super-method', enters: ['super-method-replaced'], build: runnableShape('value', 'none', 'super-method', 'call') },
      {
        name: 'callback-awaits',
        enters: ['nested-function-inside-replaced'],
        build: runnableShape('value', 'none', 'call', 'await-in-async-arrow'),
      },
      {
        name: 'callback-calls-super-method',
        enters: ['nested-function-inside-replaced'],
        build: runnableShape('value', 'none', 'method', 'super-method-in-arrow'),
      },
      {
        name: 'generator-callback',
        enters: ['nested-function-inside-replaced'],
        build: runnableShape('value', 'none', 'logical-and', 'yield-in-generator'),
      },
    ],
  },
  resolve: runnable,
  // The reference runs are the model: the same source, uninstrumented, as the driver recorded them.
  model: (shape, trace) => {
    const reference = trace.find((o) => o.checkpoint === 'reference')?.value as
      | { asWritten: unknown; replaced: Record<string, unknown> }
      | undefined
    const plan = planShape(shape)
    return {
      flagsOff: reference?.asWritten,
      flagsOn: reference?.asWritten,
      replaced: Object.fromEntries(selectableIn(plan).map((node) => [spanKey(node), reference?.replaced[spanKey(node)]])),
      registeredWhatIsIndexed: true,
    }
  },
  driver: async (shape, observe) => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-plugin-p5-'))
    try {
      for (const state of behaviorStates(shape)) observe('reach', state)
      const plan = planShape(shape)
      const { source, at } = moduleOf(plan, false)

      // The reference: the module as written, and once for each call, operation, and ternary
      // with a value written in its place.
      const replaced: Record<string, unknown> = {}
      for (const candidate of judge(plan)) {
        const text = `${plan.text.slice(0, candidate.start)}(SENTINEL)${plan.text.slice(candidate.end)}`
        replaced[spanKey(candidate)] = await runShapeModule(moduleOf(plan, false, text).source, plan.host)
      }
      observe('reference', { asWritten: await runShapeModule(source, plan.host), replaced })

      const file = join(dir, 'shape.js')
      writeFileSync(file, source)
      const plugin = executionPoints({ root: dir, targets: ['shape.js'] })
      await plugin.buildStart.call({ addWatchFile() {} })
      const instrumented = await plugin.transform.call({}, source, file)
      const indexed = indexTargetFile(file, source, dir)
      if (!instrumented) {
        // Nothing to select: the plugin leaves the module as it is.
        const asIs = await runShapeModule(source, plan.host)
        observe('instrumented', { flagsOff: asIs, flagsOn: asIs, replaced: {}, registeredWhatIsIndexed: indexed.nodes.length === 0 })
        return
      }
      const aliases = /import \{ invoke as (\w+), registerFile as (\w+) \}[^\n]*\n/.exec(instrumented.code)!
      const code = instrumented.code.replace(aliases[0], '')
      // The code runs against stand-ins for the runtime: flags that are all off or all on, and
      // an `invoke` that replaces one expression by the world's sentinel value.
      let registered: Array<string> = []
      const run = (on: boolean, replace?: string) =>
        runShapeModule(code, plan.host, (world) => ({
          [aliases[1]!]: (id: string, original: () => unknown) => (id === replace ? world.SENTINEL : original()),
          [aliases[2]!]: (_file: string, nodes: ReadonlyArray<{ id: string }>, homes: ReadonlyArray<number>) => {
            registered = nodes.map((node) => node.id)
            return Array.from({ length: Math.max(0, ...homes) + 1 }, () => ({ on }))
          },
        }))
      const flagsOff = await run(false)
      const flagsOn = await run(true)
      const replacedByPlugin: Record<string, unknown> = {}
      for (const node of indexed.nodes) {
        replacedByPlugin[spanKey({ start: node.start - at, end: node.end - at })] = await run(true, node.id)
      }
      observe('instrumented', {
        flagsOff,
        flagsOn,
        replaced: replacedByPlugin,
        registeredWhatIsIndexed: JSON.stringify(registered) === JSON.stringify(indexed.nodes.map((node) => node.id)),
      })
    } catch (err) {
      observe('instrumented', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  check: (_shape, observations, expected) =>
    differs(
      'instrumented',
      'instrumented-code-behaves-as-written',
      observations.find((o) => o.checkpoint === 'instrumented')?.value,
      expected,
    ) ?? pass,
  calibrations: [
    {
      // A chain that is cut in two: the second half is reached with nothing to read from.
      name: 'chain-no-longer-ends-on-nothing',
      law: 'instrumented-code-behaves-as-written',
      history: { constructed: 'chain-goes-on-behind-nothing' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'instrumented'
            ? { ...o, value: { ...(o.value as object), flagsOn: { value: 'threw TypeError', log: [], yields: [] } } }
            : o,
        ),
    },
    {
      name: 'receiver-lost',
      law: 'instrumented-code-behaves-as-written',
      history: { constructed: 'plain-call-in-a-method' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'instrumented') return o
          const value = o.value as { flagsOn: Outcome }
          return {
            ...o,
            value: { ...value, flagsOn: { ...value.flagsOn, log: value.flagsOn.log.map((line) => line.replace(' on o', ' on undefined')) } },
          }
        }),
    },
    {
      name: 'replacement-still-evaluates-the-expression',
      law: 'instrumented-code-behaves-as-written',
      history: { constructed: 'curried-call' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'instrumented') return o
          const value = o.value as { flagsOn: Outcome; replaced: Record<string, Outcome> }
          return { ...o, value: { ...value, replaced: Object.fromEntries(Object.keys(value.replaced).map((key) => [key, value.flagsOn])) } }
        }),
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
    // What makes the fixture a module; the driver takes it out again to run the code as a function.
    `export {}\n` +
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
  owns: ['src/plugin.ts#executionPoints', 'src/discovery.ts#indexTargetFile'],
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
      const body = res.code
        .replace(/import \{ invoke as \w+, registerFile as \w+ \} from "execution-points-prototype\/runtime";\n/, '')
        .replace('export {}\n', '')

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
      // Only some hosts have earlier work to use here, so this replacement need not run.
      const startedEarlier = await point.withReplacement(() => REPLACED, useEarlier, { times: 'any' })

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
// Law P3: Targets are re-indexed when they change, and a transform reads at most its own file
// ---------------------------------------------------------------------------

const WATCH_STEPS = [
  'transform-target',
  'transform-second-target',
  'transform-other-module',
  'transform-unresolvable',
  'transform-changed-by-plugin',
  'transform-added-file',
  'transform-missing-target',
  'edit-target',
  'add-file',
  'watch-change',
] as const
type WatchStep = (typeof WATCH_STEPS)[number]

interface WatchHistory {
  /** How many target files the project has. */
  targetCount: number
  /** How the targets are listed: each by its path, or all by one glob. */
  listedBy: 'paths' | 'glob'
  /** Whether the plugin is given its root, or takes it from Vite's resolved config. */
  rootFrom: 'option' | 'config'
  steps: ReadonlyArray<WatchStep>
}

const watchArbitrary: fc.Arbitrary<WatchHistory> = fc.record({
  targetCount: fc.constantFrom(1, 3, 12),
  listedBy: fc.constantFrom('paths', 'glob'),
  rootFrom: fc.constantFrom('option', 'config'),
  steps: fc.array(fc.constantFrom(...WATCH_STEPS), { maxLength: 9 }),
})

const targetSource = (index: number, version: number) =>
  `export function work${index}() { return version${version}(${index}); }\n`

/**
 * What each step owes, told from the outside. The plugin knows the targets as of its start or
 * of the first use after `watchChange()`. A transform of a target answers with the code of the
 * file as it is on disk; it reads that one file when the code it is handed is not the code it
 * instrumented last, and nothing otherwise. Every other transform reads nothing at all.
 */
function watchModel(history: WatchHistory) {
  const glob = history.listedBy === 'glob'
  const versions = Array.from({ length: history.targetCount }, () => 1)
  // The code of each file as the plugin last indexed it.
  const indexed = new Map<number | 'added', string>()
  let addedExists = false
  let known: { added: boolean } | undefined
  // By path, the project also lists a file that does not exist.
  const resolve = () => {
    known ??= { added: glob && addedExists }
    return { watched: history.targetCount + (glob ? 0 : 1) + (known.added ? 1 : 0), scans: glob ? 1 : 0 }
  }
  const idle = { outcome: 'none', reads: 0, scans: 0, watched: 0, otherDiskUse: 0 }

  const start = { ...idle, ...resolve() }
  const steps = history.steps.map((step) => {
    const transform = (file: number | 'added', onDisk: string, code = onDisk) => {
      const fresh = known ? { watched: 0, scans: 0 } : resolve()
      const isTarget = file === 'added' ? known!.added : file < history.targetCount
      if (!isTarget) return { ...idle, ...fresh, outcome: 'null' }
      const reads = indexed.get(file) === code ? 0 : 1
      indexed.set(file, onDisk)
      const version = /version(\d+)/.exec(code)![1]
      return { ...idle, ...fresh, reads, outcome: code === onDisk ? `instrumented version${version}` : 'source changed' }
    }
    switch (step) {
      case 'transform-target':
        return transform(0, targetSource(0, versions[0]!))
      case 'transform-second-target':
        return transform(1, targetSource(1, versions[1] ?? 1))
      case 'transform-other-module':
      case 'transform-unresolvable':
        return known || step === 'transform-unresolvable' ? { ...idle, outcome: 'null' } : { ...idle, ...resolve(), outcome: 'null' }
      case 'transform-changed-by-plugin':
        return transform(0, targetSource(0, versions[0]!), `${targetSource(0, versions[0]!)}// changed\n`)
      case 'transform-added-file':
        return addedExists ? transform('added', targetSource(99, 1)) : { ...idle, outcome: 'skipped' }
      case 'transform-missing-target': {
        // A listed file that cannot be read is no module to instrument; the plugin looks each time.
        const fresh = known ? { watched: 0, scans: 0 } : resolve()
        return { ...idle, ...fresh, reads: glob ? 0 : 1, outcome: 'null' }
      }
      case 'edit-target':
        versions[0]! += 1
        return idle
      case 'add-file':
        addedExists = true
        return idle
      case 'watch-change':
        known = undefined
        return idle
    }
  })
  return { start, steps }
}

/** Counts what production does with the disk while `action` runs, for paths inside `dir`. */
async function countingDiskUse<T>(dir: string, action: () => T | Promise<T>) {
  const counts = { reads: 0, scans: 0, otherDiskUse: 0 }
  const original: Record<string, unknown> = {}
  let scanning = 0
  const inside = (path: unknown) => typeof path === 'string' && path.startsWith(dir)
  const wrap = (name: string, count: (args: Array<unknown>) => void) => {
    original[name] = (fs as never)[name]
    ;(fs as unknown as Record<string, unknown>)[name] = (...args: Array<unknown>) => {
      count(args)
      return (original[name] as (...all: Array<unknown>) => unknown)(...args)
    }
  }
  wrap('readFileSync', ([path]) => {
    if (inside(path)) counts.reads += 1
  })
  for (const name of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'opendirSync', 'openSync', 'accessSync']) {
    wrap(name, ([path]) => {
      // What a scan of the directory does inside the built-in is the scan's own cost.
      if (inside(path) && !scanning) counts.otherDiskUse += 1
    })
  }
  original.globSync = fs.globSync
  ;(fs as unknown as Record<string, unknown>).globSync = (...args: Array<unknown>) => {
    counts.scans += 1
    scanning += 1
    try {
      return (original.globSync as (...all: Array<unknown>) => unknown)(...args)
    } finally {
      scanning -= 1
    }
  }
  syncBuiltinESMExports()
  try {
    return { result: await action(), counts }
  } finally {
    Object.assign(fs, original)
    syncBuiltinESMExports()
  }
}

const steps =
  (targetCount: number, listedBy: WatchHistory['listedBy'], ...sequence: Array<WatchStep>) =>
  (base: WatchHistory): WatchHistory => ({ ...base, targetCount, listedBy, steps: sequence })

oracleProperty({
  id: 'plugin-watch-and-rebuild',
  owns: ['src/plugin.ts#executionPoints', 'src/plugin.ts#readSource'],
  law: {
    statement:
      'For every project and every sequence of edits and transforms, executionPoints adopts config.root when options.root is omitted, registers every target file via addWatchFile whenever it resolves the targets (at buildStart, and on the first use after watchChange()), and instruments a target as the file is on disk now. The plugin reads a target file only in the transform call that instruments it, and only when the code it is handed is not the code it instrumented last; no other call reads a file or scans a directory, whatever the number of targets, except that the targets are resolved once at buildStart and once after watchChange().',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law P3 (an edited target is re-indexed); 2026-11-24: the work per transform call must not grow with the number of targets.',
    limits:
      'One, three, or twelve target files, listed by path or by one glob; a file that starts to match a glob counts as a target from the first use after watchChange(). Disk use is counted as calls of node:fs made for paths inside the project; what a directory scan does inside the built-in is not counted.',
  },
  histories: {
    arbitrary: watchArbitrary,
    runs: 40,
    fixedSeeds: [42],
    states: [
      'watched-files-registered',
      'rebuilt-after-disk-change',
      'rebuilt-after-watch-hook',
      'unchanged-target-read-once',
      'other-module-reads-nothing',
      'rejected-code-of-an-earlier-plugin',
      'many-targets',
    ],
    constructed: [
      {
        name: 'targets-watched-at-start',
        enters: ['watched-files-registered'],
        build: steps(3, 'paths', 'transform-target'),
      },
      {
        name: 'target-edited-on-disk',
        enters: ['rebuilt-after-disk-change'],
        build: steps(3, 'paths', 'transform-target', 'edit-target', 'transform-target'),
      },
      {
        name: 'file-added-under-a-glob',
        enters: ['rebuilt-after-watch-hook'],
        build: steps(1, 'glob', 'add-file', 'transform-added-file', 'watch-change', 'transform-added-file'),
      },
      {
        name: 'same-target-twice',
        enters: ['unchanged-target-read-once'],
        build: steps(3, 'glob', 'transform-target', 'transform-target', 'transform-second-target'),
      },
      {
        name: 'modules-that-are-no-targets',
        enters: ['other-module-reads-nothing', 'many-targets'],
        build: steps(12, 'glob', 'transform-other-module', 'transform-unresolvable', 'transform-other-module'),
      },
      {
        name: 'other-module-first-after-watch-change',
        enters: ['other-module-reads-nothing', 'rebuilt-after-watch-hook'],
        build: steps(12, 'paths', 'watch-change', 'transform-unresolvable', 'transform-other-module', 'transform-target'),
      },
      {
        name: 'listed-file-that-does-not-exist',
        enters: ['watched-files-registered'],
        build: steps(1, 'paths', 'transform-missing-target', 'transform-target', 'transform-missing-target'),
      },
      {
        name: 'code-changed-by-an-earlier-plugin',
        enters: ['rejected-code-of-an-earlier-plugin'],
        build: steps(1, 'paths', 'transform-changed-by-plugin', 'transform-target', 'transform-changed-by-plugin'),
      },
    ],
  },
  model: (history) => watchModel(history),
  driver: async (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-plugin-p3-'))
    try {
      if (history.steps.includes('transform-target')) observe('reach', 'watched-files-registered')
      const editAt = history.steps.indexOf('edit-target')
      if (editAt !== -1 && history.steps.indexOf('transform-target', editAt) !== -1) observe('reach', 'rebuilt-after-disk-change')
      if (history.steps.includes('watch-change')) observe('reach', 'rebuilt-after-watch-hook')
      const firstAt = history.steps.indexOf('transform-target')
      if (firstAt !== -1 && history.steps[firstAt + 1] === 'transform-target') observe('reach', 'unchanged-target-read-once')
      if (history.steps.includes('transform-other-module')) observe('reach', 'other-module-reads-nothing')
      if (history.steps.includes('transform-changed-by-plugin')) observe('reach', 'rejected-code-of-an-earlier-plugin')
      if (history.targetCount === 12) observe('reach', 'many-targets')

      mkdirSync(join(tempDir, 'src'))
      const fileOf = (index: number | 'added') => join(tempDir, 'src', `t${index === 'added' ? 99 : index}.js`)
      const versions = Array.from({ length: history.targetCount }, () => 1)
      versions.forEach((version, index) => writeFileSync(fileOf(index), targetSource(index, version)))

      const targets =
        history.listedBy === 'glob' ? ['src/*.js'] : [...versions.map((_, index) => `src/t${index}.js`), 'src/missing.js']
      const plugin =
        history.rootFrom === 'option' ? executionPoints({ root: tempDir, targets }) : executionPoints({ targets })
      plugin.configResolved({ root: history.rootFrom === 'option' ? '/ignored-root' : tempDir })

      const watched: Array<string> = []
      const context = {
        addWatchFile(file: string) {
          watched.push(file)
        },
      }
      // One step: what the plugin answered, what it watched, and what it did with the disk.
      const observed = async (action: () => unknown) => {
        watched.length = 0
        let outcome = 'none'
        const { counts } = await countingDiskUse(tempDir, async () => {
          try {
            const result = (await action()) as { code: string } | null | undefined
            if (result === null) outcome = 'null'
            else if (result) outcome = `instrumented ${/"(version\d+)"/.exec(result.code)?.[1] ?? 'nothing'}`
          } catch (error) {
            outcome = /Source changed before instrumentation/.test((error as Error).message)
              ? 'source changed'
              : `threw ${(error as Error).message}`
          }
        })
        const expectedFiles = new Set(
          versions.map((_, index) => fileOf(index)).concat(fileOf('added'), join(tempDir, 'src', 'missing.js')),
        )
        return {
          outcome,
          ...counts,
          watched: watched.every((file) => expectedFiles.has(file)) ? new Set(watched).size : -1,
        }
      }

      const start = await observed(() => plugin.buildStart.call(context))
      const results = []
      let addedExists = false
      for (const step of history.steps) {
        const transform = (file: string, code: string) => observed(() => plugin.transform.call(context, code, file))
        switch (step) {
          case 'transform-target':
            results.push(await transform(fileOf(0), targetSource(0, versions[0]!)))
            break
          case 'transform-second-target':
            results.push(await transform(fileOf(1), targetSource(1, versions[1] ?? 1)))
            break
          case 'transform-other-module':
            results.push(await transform(join(tempDir, 'lib', 'other.js'), 'export const other = send(1)\n'))
            break
          case 'transform-unresolvable':
            results.push(await transform('\0virtual:module', 'export const other = send(1)\n'))
            break
          case 'transform-changed-by-plugin':
            results.push(await transform(fileOf(0), `${targetSource(0, versions[0]!)}// changed\n`))
            break
          case 'transform-added-file':
            results.push(
              addedExists
                ? await transform(fileOf('added'), targetSource(99, 1))
                : { outcome: 'skipped', reads: 0, scans: 0, watched: 0, otherDiskUse: 0 },
            )
            break
          case 'transform-missing-target':
            results.push(await transform(join(tempDir, 'src', 'missing.js'), 'export const late = send(1)\n'))
            break
          case 'edit-target':
            versions[0]! += 1
            writeFileSync(fileOf(0), targetSource(0, versions[0]!))
            results.push(await observed(() => undefined))
            break
          case 'add-file':
            addedExists = true
            writeFileSync(fileOf('added'), targetSource(99, 1))
            results.push(await observed(() => undefined))
            break
          case 'watch-change':
            results.push(await observed(() => plugin.watchChange(fileOf(0), { event: 'update' })))
            break
        }
      }
      observe('watch', { start, steps: results })
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
      history: { constructed: 'target-edited-on-disk' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'watch') return o
          const value = o.value as { steps: Array<{ outcome: string }> }
          return { ...o, value: { ...value, steps: value.steps.map((step, index) => (index === 2 ? { ...step, outcome: 'instrumented version1' } : step)) } }
        }),
    },
    {
      // What the plugin did before 2026-11-24: every transform call read every target.
      name: 'other-module-reads-every-target',
      law: 'watch-and-rebuild',
      history: { constructed: 'modules-that-are-no-targets' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'watch') return o
          const value = o.value as { steps: Array<{ reads: number }> }
          return { ...o, value: { ...value, steps: value.steps.map((step) => ({ ...step, reads: 12 })) } }
        }),
    },
  ],
})
// ---------------------------------------------------------------------------
// Law P6: Without `targets`, the plugin reads them from points.ep in the Vite root
// ---------------------------------------------------------------------------

// What `points.ep` in the root holds; most of these are no manifests.
const MANIFESTS = {
  'lists-a': JSON.stringify({ targets: ['a.js'] }),
  'lists-a-with-schema': JSON.stringify({
    $schema: './node_modules/execution-points-prototype/points.schema.json',
    tsconfig: 'tsconfig.json',
    targets: ['a.js'],
  }),
  'lists-nothing': JSON.stringify({ targets: [] }),
  missing: undefined,
  'not-json': '{ "targets": [',
  'not-an-object': '["a.js"]',
  'a-text': '"a.js"',
  'no-targets': JSON.stringify({ tsconfig: 'tsconfig.json' }),
  'targets-is-a-path': JSON.stringify({ targets: 'a.js' }),
  'target-is-a-number': JSON.stringify({ targets: ['a.js', 42] }),
  'tsconfig-is-a-list': JSON.stringify({ targets: ['a.js'], tsconfig: ['tsconfig.json'] }),
  'schema-is-a-number': JSON.stringify({ targets: ['a.js'], $schema: 7 }),
  'unknown-key': JSON.stringify({ targets: ['a.js'], tsconfg: 'tsconfig.json' }),
  'key-of-every-object': JSON.stringify({ targets: ['a.js'], toString: 'tsconfig.json' }),
} as const
type ManifestKind = keyof typeof MANIFESTS

interface ManifestHistory {
  manifest: ManifestKind
  /** The `targets` the plugin is given, if any: they win over the manifest. */
  explicit: 'none' | 'lists-b' | 'empty'
  rootFrom: 'option' | 'config'
}

const enumeratedManifestHistories: ReadonlyArray<ManifestHistory> = (
  Object.keys(MANIFESTS) as Array<ManifestKind>
).flatMap((manifest) =>
  (['none', 'lists-b', 'empty'] as const).flatMap((explicit) =>
    (['option', 'config'] as const).map((rootFrom) => ({ manifest, explicit, rootFrom })),
  ),
)

// The schema the package ships is what says what a manifest is.
const manifestSchema = JSON.parse(readFileSync(new URL('../points.schema.json', import.meta.url), 'utf8')) as JsonSchema
interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: Array<string>
  additionalProperties?: boolean
  items?: JsonSchema
}
const JUDGED = ['$schema', '$id', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items']

/** Whether a JSON schema of the few keywords that points.schema.json uses accepts the value. */
function schemaAccepts(schema: JsonSchema, value: unknown): boolean {
  const unjudged = Object.keys(schema).find((keyword) => !JUDGED.includes(keyword))
  if (unjudged || !['object', 'array', 'string'].includes(schema.type!)) {
    throw new Error(`points.schema.json says "${unjudged ?? schema.type}", which this oracle cannot judge`)
  }
  if (schema.type === 'string') return typeof value === 'string'
  if (schema.type === 'array') return Array.isArray(value) && value.every((item) => !schema.items || schemaAccepts(schema.items, item))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const properties = schema.properties ?? {}
  return (
    (schema.required ?? []).every((key) => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) =>
      Object.hasOwn(properties, key) ? schemaAccepts(properties[key]!, item) : schema.additionalProperties !== false,
    )
  )
}

/** The targets a manifest lists, if the text is JSON that the schema accepts. */
function listedBy(manifest: ManifestKind): Array<string> | undefined {
  let value: unknown
  try {
    value = JSON.parse(MANIFESTS[manifest] ?? '')
  } catch {
    return undefined
  }
  return schemaAccepts(manifestSchema, value) ? (value as { targets: Array<string> }).targets : undefined
}

/**
 * Explicit targets decide alone, and the manifest is not read. Without them the manifest
 * decides; a manifest that cannot be read or is not one stops the build with its name. The
 * manifest is read when the targets are resolved, not by each transform, and it is watched.
 */
function manifestModel(history: ManifestHistory) {
  const quiet = { manifestReads: 0, watchesManifest: false }
  if (history.explicit !== 'none') {
    const targets = history.explicit === 'lists-b' ? ['b'] : []
    return { start: { outcome: 'ok', ...quiet }, instrumented: targets, transformReads: 0, afterWatchChange: quiet }
  }
  const listed = listedBy(history.manifest)
  if (!listed) return { start: { outcome: 'error names points.ep', ...quiet, manifestReads: 1 } }
  const reads = { manifestReads: 1, watchesManifest: true }
  return {
    start: { outcome: 'ok', ...reads },
    instrumented: listed.includes('a.js') ? ['a'] : [],
    transformReads: 0,
    afterWatchChange: reads,
  }
}

oracleProperty({
  id: 'plugin-targets-from-manifest',
  owns: ['src/plugin.ts#executionPoints', 'src/discovery.ts#loadManifest'],
  law: {
    statement:
      'For every project, executionPoints() without `targets` instruments exactly the targets that points.ep in the Vite root lists, reads the manifest once each time it resolves the targets, and watches it; explicit `targets` win and leave the manifest unread; a manifest that is missing, is not JSON, or is not what points.schema.json describes stops the build with an error that names the file.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: one source of truth for targets: executionPoints() reads points.ep by default, explicit options still win, and the manifest has a published JSON schema.',
    limits:
      'Two target modules, fourteen contents of points.ep, three forms of explicit targets, and both sources of the root. What a manifest is, the model takes from points.schema.json, read with the few schema keywords that file uses.',
  },
  histories: {
    enumerated: enumeratedManifestHistories,
    states: ['targets-from-manifest', 'explicit-targets-win', 'manifest-refused'],
  },
  label: (h) => `${h.manifest}:${h.explicit}:${h.rootFrom}`,
  model: (history) => manifestModel(history),
  driver: async (history, observe) => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-plugin-p6-'))
    try {
      const expected = manifestModel(history)
      observe(
        'reach',
        history.explicit !== 'none'
          ? 'explicit-targets-win'
          : expected.start.outcome === 'ok'
            ? 'targets-from-manifest'
            : 'manifest-refused',
      )
      const sources = { a: 'export function a() { return sendA(1) }\n', b: 'export function b() { return sendB(1) }\n' }
      writeFileSync(join(dir, 'a.js'), sources.a)
      writeFileSync(join(dir, 'b.js'), sources.b)
      const manifestFile = join(dir, 'points.ep')
      if (MANIFESTS[history.manifest] !== undefined) writeFileSync(manifestFile, MANIFESTS[history.manifest]!)

      const options = {
        ...(history.rootFrom === 'option' ? { root: dir } : {}),
        ...(history.explicit === 'none' ? {} : { targets: history.explicit === 'lists-b' ? ['b.js'] : [] }),
      }
      const plugin = executionPoints(options)
      plugin.configResolved({ root: history.rootFrom === 'option' ? '/ignored-root' : dir })

      const watched = new Set<string>()
      const context = {
        addWatchFile(file: string) {
          watched.add(file)
        },
      }
      // One use of the plugin: how often it read the manifest, and whether it watches it.
      const using = async (action: () => unknown) => {
        watched.clear()
        let reads = 0
        const readFileSync = fs.readFileSync
        ;(fs as unknown as Record<string, unknown>).readFileSync = (...args: Array<unknown>) => {
          if (args[0] === manifestFile) reads += 1
          return (readFileSync as (...all: Array<unknown>) => unknown)(...args)
        }
        syncBuiltinESMExports()
        let outcome = 'ok'
        try {
          await action()
        } catch (error) {
          outcome = (error as Error).message.includes(manifestFile) ? 'error names points.ep' : `error ${(error as Error).message}`
        } finally {
          fs.readFileSync = readFileSync
          syncBuiltinESMExports()
        }
        return { outcome, manifestReads: reads, watchesManifest: watched.has(manifestFile) }
      }

      const start = await using(() => plugin.buildStart.call(context))
      if (start.outcome !== 'ok') {
        observe('manifest', { start })
        return
      }
      const instrumented: Array<string> = []
      const transforms = await using(async () => {
        for (const name of ['a', 'b'] as const) {
          const result = await plugin.transform.call(context, sources[name], join(dir, `${name}.js`))
          if (result) instrumented.push(name)
        }
      })
      plugin.watchChange(manifestFile, { event: 'update' })
      const again = await using(() => plugin.transform.call(context, sources.a, join(dir, 'a.js')))
      observe('manifest', {
        start,
        instrumented,
        transformReads: transforms.manifestReads,
        afterWatchChange: { manifestReads: again.manifestReads, watchesManifest: again.watchesManifest },
      })
    } catch (err) {
      observe('manifest', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) =>
    differs('manifest', 'targets-from-manifest', observations.find((o) => o.checkpoint === 'manifest')?.value, expected) ??
    pass,
  calibrations: [
    {
      // What the plugin did before 2026-11-24: without `targets` it instrumented nothing.
      name: 'manifest-ignored',
      law: 'targets-from-manifest',
      history: { enumerated: 'lists-a:none:config' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'manifest'
            ? {
                ...o,
                value: {
                  start: { outcome: 'ok', manifestReads: 0, watchesManifest: false },
                  instrumented: [],
                  transformReads: 0,
                  afterWatchChange: { manifestReads: 0, watchesManifest: false },
                },
              }
            : o,
        ),
    },
    {
      name: 'manifest-overrides-explicit-targets',
      law: 'targets-from-manifest',
      history: { enumerated: 'lists-a:lists-b:option' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'manifest' ? { ...o, value: { ...(o.value as object), instrumented: ['a'] } } : o,
        ),
    },
    {
      name: 'broken-manifest-accepted',
      law: 'targets-from-manifest',
      history: { enumerated: 'targets-is-a-path:none:option' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'manifest'
            ? { ...o, value: { start: { outcome: 'ok', manifestReads: 1, watchesManifest: true }, instrumented: [], transformReads: 0, afterWatchChange: { manifestReads: 1, watchesManifest: true } } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law P7: The plugin adds the library's Vitest setup module by itself
// ---------------------------------------------------------------------------

const SETUP_MODULE = 'execution-points-prototype/vitest'

// What the user's own config says about setup files, and about anything else.
const USER_SETUPS = {
  none: undefined,
  one: './test/setup.ts',
  list: ['./test/setup.ts', 'another-package/setup'],
  empty: [],
} as const
type UserSetup = keyof typeof USER_SETUPS

interface SetupHistory {
  setup: UserSetup
  /** Whether the user's config has a `test` section, and other settings beside it. */
  shape: 'no-test-section' | 'test-section' | 'test-and-more'
  command: 'serve' | 'build'
}

const enumeratedSetupHistories: ReadonlyArray<SetupHistory> = (Object.keys(USER_SETUPS) as Array<UserSetup>).flatMap(
  (setup) =>
    (['no-test-section', 'test-section', 'test-and-more'] as const).flatMap((shape) =>
      (['serve', 'build'] as const).map((command) => ({ setup, shape, command })),
    ),
)

function userConfigOf(history: SetupHistory): Record<string, unknown> {
  const setupFiles = USER_SETUPS[history.setup]
  if (history.shape === 'no-test-section') return {}
  const test = { environment: 'node', ...(setupFiles === undefined ? {} : { setupFiles }) }
  return history.shape === 'test-section' ? { test } : { root: '/project', resolve: { alias: { '@': '/project/src' } }, test }
}

/** Vite merges lists by appending: the user's setup files stay, and the library's comes last. */
function setupModel(history: SetupHistory) {
  const user = userConfigOf(history)
  const own = (user.test as { setupFiles?: string | ReadonlyArray<string> } | undefined)?.setupFiles
  const { test, ...restOfConfig } = user
  const { setupFiles: _own, ...restOfTest } = (test ?? {}) as Record<string, unknown>
  return {
    setupFiles: [...(own === undefined ? [] : typeof own === 'string' ? [own] : own), SETUP_MODULE],
    restOfTest,
    restOfConfig,
    // The hook answers with its contribution; it does not rewrite the user's own object.
    userConfigUntouched: true,
  }
}

oracleProperty({
  id: 'plugin-adds-vitest-setup',
  owns: ['src/plugin.ts#executionPoints'],
  law: {
    statement:
      'For every user config, the plugin\'s config() hook contributes the library\'s Vitest setup module, execution-points-prototype/vitest, so that Vite\'s merge keeps every setup file of the user and adds the library\'s exactly once, and changes nothing else in the config.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a replacement that never runs must be loud; the plugin adds the library\'s Vitest setup module to the test setup by itself, so a consumer gets the after-test check without configuration.',
    limits:
      'The merge is Vite\'s own mergeConfig, applied to what the hook returns. That Vitest then resolves and runs the setup module is not judged here.',
  },
  histories: {
    enumerated: enumeratedSetupHistories,
    states: ['setup-added-to-none', 'setup-added-to-the-users-own'],
  },
  label: (h) => `${h.setup}:${h.shape}:${h.command}`,
  model: (history) => setupModel(history),
  driver: async (history, observe) => {
    try {
      const user = userConfigOf(history)
      const hasOwn = history.shape !== 'no-test-section' && (history.setup === 'one' || history.setup === 'list')
      observe('reach', hasOwn ? 'setup-added-to-the-users-own' : 'setup-added-to-none')
      const plugin = executionPoints({ targets: [] })
      const before = JSON.stringify(user)
      const contributed = await plugin.config(user, { command: history.command, mode: 'test' })
      const { test, ...restOfConfig } = mergeConfig(user, contributed ?? {}) as Record<string, unknown>
      const { setupFiles, ...restOfTest } = (test ?? {}) as Record<string, unknown>
      observe('setup', { setupFiles, restOfTest, restOfConfig, userConfigUntouched: JSON.stringify(user) === before })
    } catch (err) {
      observe('setup', { threw: err instanceof Error ? err.message : String(err) })
    }
  },
  check: (_history, observations, expected) =>
    differs('setup', 'adds-vitest-setup', observations.find((o) => o.checkpoint === 'setup')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'setup-module-missing',
      law: 'adds-vitest-setup',
      history: { enumerated: 'list:test-and-more:serve' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'setup'
            ? { ...o, value: { ...(o.value as object), setupFiles: ['./test/setup.ts', 'another-package/setup'] } }
            : o,
        ),
    },
    {
      name: 'users-setup-replaced',
      law: 'adds-vitest-setup',
      history: { enumerated: 'one:test-section:build' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'setup' ? { ...o, value: { ...(o.value as object), setupFiles: [SETUP_MODULE] } } : o,
        ),
    },
  ],
})
