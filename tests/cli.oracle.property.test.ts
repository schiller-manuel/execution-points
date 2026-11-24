/**
 * This oracle owns the `execution-points list` command: what it prints for the target modules
 * of a project, and how it answers when it cannot list. It is checked on the lines that
 * `run(argv, { cwd, out, err })` writes and on the exit code it returns, and it owns
 * `src/cli.ts`.
 *
 * ```ts
 * run(['list', 'src/app.ts'], { cwd }) // → 0, one line per selectable expression of the file:
 * // src/app.ts:3:16  kind=CallExpression callee=send inFunction=checkout nth=0 id=src/app.ts#checkout:CallExpression:send:0  send(order.id)
 * run(['list'], { cwd }) // → 0, the same for every target that points.ep lists
 * run(['list', '--json'], { cwd }) // → 0, the same entries as one JSON array
 * run(['list', 'src/other.ts'], { cwd }) // → 1, "is not a target" on the error stream
 * ```
 *
 * A terminal has no completion list. What `list` prints is all an agent has to write
 * `select('src/app.ts', (node) => node.callee === 'send' && node)`, so a line that names an
 * expression the plugin does not register, or leaves one out, or points one line off, sends
 * the test's author to an expression that is not there. Where does `send(a)` stand when the
 * file starts with a byte-order mark and its lines end in `\r\n`?
 *
 * Two parts make the answer. The **listing** is what discovery indexes for a file, the same
 * index the plugin registers at runtime. The **place** of an expression is its line and
 * column as an editor counts them, both from 1, with a byte-order mark counting for nothing,
 * and its text is its source with every run of whitespace written as one space, cut to 72
 * characters.
 *
 * Law L1. For every project and every target file, `list` prints exactly the expressions the
 * plugin registers for that file, in the same order, each with its `id`, `kind`, `callee` or
 * `operator`, `inFunction`, and `nth`, the line and column where it starts, and its text;
 * without a file it does so for every existing target in the order of their paths, and
 * `--json` prints the same entries as a JSON array (Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-24: a command that lists what can be selected; for every target
 * file, the command prints exactly the expressions the plugin registers for that file, each
 * with the position and text of the expression in the source).
 *
 * Law L2. For every command line that cannot be listed, `run` prints nothing on the output
 * stream, says why on the error stream, and returns a code other than 0: 1 for a file that is
 * not a target, a file that does not exist, and a missing or broken manifest, 2 for a command
 * line it does not understand. `--help` prints the usage and returns 0, and loading the
 * module runs nothing unless it is the program Node was started with (the same decision: "a
 * file that is not a target, a missing file, and a missing manifest each produce a clear
 * message and a non-zero exit code").
 *
 * How the oracle knows. Each history is a small project: up to three files, each built from
 * functions and statements whose expressions come from templates. The model writes the files
 * line by line and so knows where every expression starts and what it is called; it does not
 * read them back. The driver runs the command on the project, parses each printed line into
 * its fields, and asks the plugin which ids it registers for the same files.
 *
 * Limits. The command reads the manifest of the directory it runs in. The excerpts are not
 * meant to be parsed: the model's files hold no text with two spaces in a row inside a field.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { executionPoints } from '../src/plugin.ts'

const CLI_FILE = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

// ---------------------------------------------------------------------------
// Law L1: The listing is what the plugin registers, with the place and text of each expression
// ---------------------------------------------------------------------------

// The expressions a statement can hold, outermost first, as offsets into the template's text.
const TEMPLATES = [
  { text: 'send(a)', found: [{ kind: 'CallExpression', callee: 'send', at: 0, length: 7 }] },
  { text: 'a + b', found: [{ kind: 'BinaryExpression', operator: '+', at: 0, length: 5 }] },
  { text: 'a ? b : c', found: [{ kind: 'ConditionalExpression', at: 0, length: 9 }] },
  { text: 'client.load(a)', found: [{ kind: 'CallExpression', callee: 'load', object: 'client', at: 0, length: 14 }] },
  {
    text: 'total(a * 2)',
    found: [
      { kind: 'CallExpression', callee: 'total', at: 0, length: 12 },
      { kind: 'BinaryExpression', operator: '*', at: 6, length: 5 },
    ],
  },
  { text: 'client?.find(a)', found: [{ kind: 'CallExpression', callee: 'find', object: 'client', at: 0, length: 15 }] },
  // Longer than an excerpt may be.
  {
    text: 'combine(firstArgument, secondArgument, thirdArgument, fourthArgument, fifthArgument)',
    found: [{ kind: 'CallExpression', callee: 'combine', at: 0, length: 84 }],
  },
  // Exactly as long as an excerpt may be.
  { text: `keep(${'x'.repeat(66)})`, found: [{ kind: 'CallExpression', callee: 'keep', at: 0, length: 72 }] },
] as const

const FUNCTION_NAMES = ['checkout', 'refund'] as const
const EXCERPT_LENGTH = 72

interface StatementSpec {
  template: number
  indent: number
  /** Whether the expression is written over several lines. */
  broken: boolean
}

interface FileSpec {
  /** A global script has no export, so nothing in it can be selected. */
  isModule: boolean
  /** Statements of the module itself, then of each function. */
  top: ReadonlyArray<StatementSpec>
  functions: ReadonlyArray<{ name: number; statements: ReadonlyArray<StatementSpec> }>
}

interface ListHistory {
  files: ReadonlyArray<FileSpec>
  bom: boolean
  crlf: boolean
  /** Whether points.ep lists each file, or all of them by one glob. */
  listedBy: 'paths' | 'glob'
  /** Whether the manifest also lists a file that does not exist. */
  listsMissingFile: boolean
  /** Which file the command is asked for: none means every target. */
  ask: number | 'all'
  json: boolean
}

const statementArbitrary = fc.record({
  template: fc.nat({ max: TEMPLATES.length - 1 }),
  indent: fc.nat({ max: 4 }),
  broken: fc.boolean(),
})
const fileArbitrary: fc.Arbitrary<FileSpec> = fc.record({
  isModule: fc.boolean(),
  top: fc.array(statementArbitrary, { maxLength: 2 }),
  functions: fc.array(
    fc.record({ name: fc.nat({ max: FUNCTION_NAMES.length - 1 }), statements: fc.array(statementArbitrary, { maxLength: 3 }) }),
    { maxLength: 3 },
  ),
})
const listArbitrary: fc.Arbitrary<ListHistory> = fc.record({
  files: fc.array(fileArbitrary, { minLength: 1, maxLength: 3 }),
  bom: fc.boolean(),
  crlf: fc.boolean(),
  listedBy: fc.constantFrom('paths', 'glob'),
  listsMissingFile: fc.boolean(),
  ask: fc.oneof(fc.constant('all' as const), fc.nat({ max: 2 })),
  json: fc.boolean(),
})

interface Entry {
  file: string
  line: number
  column: number
  id: string
  kind: string
  callee?: string
  operator?: string
  object?: string
  inFunction: string | null
  nth: number
  /** What the expression stands inside, outermost first. The one-line listing leaves the lines out. */
  inside: Array<{ type: string; name: string; line?: number }>
  text: string
}

const fileName = (index: number) => `src/part${index}.ts`

/**
 * Writes one file line by line. The place of each expression is known from the writing: the
 * line it is written on, and the characters before it on that line.
 */
function writeFile(history: ListHistory, index: number): { source: string; entries: Array<Entry> } {
  const spec = history.files[index]!
  const file = fileName(index)
  const newline = history.crlf ? '\r\n' : '\n'
  const lines: Array<string> = []
  const entries: Array<Entry> = []
  const counts = new Map<string, number>()
  let variable = 0

  const statement = (around: { name: string; line: number } | null, { template, indent, broken }: StatementSpec, exported = false) => {
    const inFunction = around?.name ?? null
    const { text, found } = TEMPLATES[template]!
    const constant = `v${(variable += 1)}`
    const lead = `${' '.repeat(indent)}${exported ? 'export ' : ''}const ${constant} = `
    // Broken over lines, the expression's text has a line break and an indent after each `(` and `,`.
    const written = broken ? text.replace(/([(,]) ?/g, `$1${newline}${' '.repeat(indent + 2)}`) : text
    const startLine = lines.length + 1
    for (const node of found) {
      // Where the node starts in the written text: its offset in the template, moved by the breaks before it.
      const before = broken ? text.slice(0, node.at).replace(/([(,]) ?/g, `$1${newline}${' '.repeat(indent + 2)}`) : text.slice(0, node.at)
      const beforeLines = before.split(newline)
      const name = 'callee' in node ? node.callee : 'operator' in node ? node.operator : '?'
      const prefix = `${file}#${inFunction ?? '<top>'}:${node.kind}:${name}`
      const nth = counts.get(prefix) ?? 0
      counts.set(prefix, nth + 1)
      const whole = (broken
        ? text.slice(node.at, node.at + node.length).replace(/([(,]) ?/g, `$1${newline}${' '.repeat(indent + 2)}`)
        : text.slice(node.at, node.at + node.length)
      ).replace(/\s+/g, ' ')
      entries.push({
        file,
        line: startLine + beforeLines.length - 1,
        column: (beforeLines.length === 1 ? lead.length : 0) + beforeLines.at(-1)!.length + 1,
        id: `${prefix}:${nth}`,
        kind: node.kind,
        ...('callee' in node ? { callee: node.callee } : {}),
        ...('operator' in node ? { operator: node.operator } : {}),
        ...('object' in node ? { object: node.object } : {}),
        inFunction,
        nth,
        // Every statement declares a constant, so every expression is inside that declarator, and inside its function.
        inside: [
          ...(around ? [{ type: 'Function', name: around.name, ...(history.json ? { line: around.line } : {}) }] : []),
          { type: 'VariableDeclarator', name: constant, ...(history.json ? { line: startLine } : {}) },
        ],
        text: whole.length > EXCERPT_LENGTH ? `${whole.slice(0, EXCERPT_LENGTH - 1)}…` : whole,
      })
    }
    lines.push(...`${lead}${written};`.split(newline))
  }

  // What makes the file a module is an export: of its first statement, which is then the first
  // line, or of a line of its own.
  if (!spec.top.length) lines.push(spec.isModule ? 'export const part = true' : 'const part = true')
  spec.top.forEach((each, index) => statement(null, each, spec.isModule && index === 0))
  for (const fn of spec.functions) {
    const name = FUNCTION_NAMES[fn.name]!
    lines.push(`function ${name}(a, b, c) {`)
    const around = { name, line: lines.length }
    fn.statements.forEach((each) => statement(around, each))
    lines.push('}')
  }
  return {
    source: `${history.bom ? '﻿' : ''}${lines.join(newline)}${newline}`,
    // Nothing in a global script can be selected.
    entries: spec.isModule ? entries : [],
  }
}

/** The file the command is asked for, if it is one of the project's. */
const askedFile = (history: ListHistory) =>
  history.ask === 'all' ? undefined : fileName(history.ask % history.files.length)

function listModel(history: ListHistory) {
  const asked = askedFile(history)
  const entries = history.files
    .map((_, index) => index)
    .filter((index) => asked === undefined || fileName(index) === asked)
    .flatMap((index) => writeFile(history, index).entries)
  return {
    exit: 0,
    entries,
    // What is listed is what the plugin registers for the same files.
    registered: entries.map((entry) => entry.id),
    saysNothingToSelect: entries.length === 0,
    // Without a directory, the command lists the project it is started in.
    listsTheCurrentDirectoryByDefault: true,
  }
}

/** Reads one printed line back into its fields. */
function parseLine(line: string): Entry | { unreadable: string } {
  const [place, fields, ...text] = line.split('  ')
  const position = /^(.*):(\d+):(\d+)$/.exec(place ?? '')
  if (!position || fields === undefined) return { unreadable: line }
  // A value with a space in it is written in JSON quotes.
  const named = Object.fromEntries(
    [...fields.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g)].map(([, name, value]) => [name!, value!.startsWith('"') ? (JSON.parse(value!) as string) : value!]),
  )
  return {
    file: position[1]!,
    line: Number(position[2]),
    column: Number(position[3]),
    id: named.id!,
    kind: named.kind!,
    ...(named.callee === undefined ? {} : { callee: named.callee }),
    ...(named.operator === undefined ? {} : { operator: named.operator }),
    ...(named.object === undefined ? {} : { object: named.object }),
    inFunction: named.inFunction === 'null' ? null : named.inFunction!,
    nth: Number(named.nth),
    // `inside=Function:checkout>VariableDeclarator:v1`, or `inside=` at the top of the file.
    inside: (named.inside ?? '')
      .split('>')
      .filter(Boolean)
      .map((step) => ({ type: step.slice(0, step.indexOf(':')), name: step.slice(step.indexOf(':') + 1) })),
    text: text.join('  '),
  }
}

/** Builds the project of a history on disk. */
function writeProject(history: ListHistory, dir: string) {
  mkdirSync(join(dir, 'src'))
  history.files.forEach((_, index) => writeFileSync(join(dir, fileName(index)), writeFile(history, index).source))
  const targets = history.listedBy === 'glob' ? ['src/*.ts'] : history.files.map((_, index) => fileName(index)).reverse()
  writeFileSync(join(dir, 'points.ep'), JSON.stringify({ targets: history.listsMissingFile ? [...targets, 'src/gone.ts'] : targets }))
}

const oneFile = (statements: Array<StatementSpec>, isModule = true): FileSpec => ({
  isModule,
  top: [],
  functions: [{ name: 0, statements }],
})
const plain = (template: number): StatementSpec => ({ template, indent: 2, broken: false })

oracleProperty({
  id: 'cli-lists-what-the-plugin-registers',
  owns: ['src/cli.ts'],
  law: {
    statement:
      'For every project and every target file, `execution-points list` prints exactly the expressions the plugin registers for that file, in the same order, each on one line with its id, kind, callee or operator, inFunction, and nth, the line and column where it starts (both from 1, a byte-order mark counting for nothing), and its text with every run of whitespace as one space, cut to 72 characters; without a file it lists every existing target in the order of their paths; --json prints the same entries as a JSON array; and it returns 0.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a command that lists what can be selected; for every target file, the command prints exactly the expressions the plugin registers for that file, each with the position and text of the expression in the source.',
    limits:
      'Projects of one to three files built from eight expression templates, with LF or CRLF line ends, with or without a byte-order mark, listed by path or by one glob.',
  },
  histories: {
    arbitrary: listArbitrary,
    runs: 60,
    fixedSeeds: [42],
    states: [
      'lists-one-file',
      'lists-every-target',
      'lists-as-json',
      'expression-behind-a-mark-and-crlf',
      'expression-over-several-lines',
      'excerpt-cut',
      'excerpt-as-long-as-allowed',
      'global-script-lists-nothing',
      'missing-target-left-out',
    ],
    constructed: [
      {
        name: 'one-file-of-three',
        enters: ['lists-one-file'],
        build: (base): ListHistory => ({
          ...base,
          files: [oneFile([plain(0)]), oneFile([plain(1), plain(4)]), oneFile([plain(2)])],
          ask: 1,
          json: false,
        }),
      },
      {
        name: 'every-target',
        enters: ['lists-every-target'],
        build: (base): ListHistory => ({
          ...base,
          files: [oneFile([plain(3)]), { isModule: true, top: [plain(0)], functions: [{ name: 1, statements: [plain(0), plain(0)] }] }],
          ask: 'all',
          json: false,
        }),
      },
      {
        name: 'as-json',
        enters: ['lists-as-json'],
        build: (base): ListHistory => ({ ...base, files: [oneFile([plain(4), plain(5)])], ask: 'all', json: true }),
      },
      {
        name: 'behind-a-mark-and-crlf',
        enters: ['expression-behind-a-mark-and-crlf'],
        build: (base): ListHistory => ({
          ...base,
          files: [{ isModule: true, top: [{ template: 0, indent: 0, broken: false }], functions: [{ name: 0, statements: [plain(1)] }] }],
          bom: true,
          crlf: true,
          ask: 0,
        }),
      },
      {
        name: 'over-several-lines',
        enters: ['expression-over-several-lines'],
        build: (base): ListHistory => ({
          ...base,
          files: [oneFile([{ template: 4, indent: 3, broken: true }, plain(0)])],
          crlf: false,
          ask: 0,
        }),
      },
      {
        name: 'over-several-lines-with-crlf',
        enters: ['expression-over-several-lines', 'expression-behind-a-mark-and-crlf'],
        build: (base): ListHistory => ({
          ...base,
          files: [oneFile([{ template: 4, indent: 1, broken: true }])],
          bom: true,
          crlf: true,
          ask: 0,
        }),
      },
      {
        name: 'long-expression',
        enters: ['excerpt-cut'],
        build: (base): ListHistory => ({ ...base, files: [oneFile([plain(6), { template: 6, indent: 0, broken: true }])], ask: 0 }),
      },
      {
        name: 'expression-of-72-characters',
        enters: ['excerpt-as-long-as-allowed'],
        build: (base): ListHistory => ({ ...base, files: [oneFile([plain(7)])], ask: 0 }),
      },
      {
        name: 'global-script',
        enters: ['global-script-lists-nothing'],
        build: (base): ListHistory => ({ ...base, files: [oneFile([plain(0)], false)], ask: 0 }),
      },
      {
        name: 'manifest-lists-a-missing-file',
        enters: ['missing-target-left-out', 'lists-every-target'],
        build: (base): ListHistory => ({ ...base, files: [oneFile([plain(0)])], listedBy: 'paths', listsMissingFile: true, ask: 'all' }),
      },
    ],
  },
  model: (history) => listModel(history),
  driver: async (history, observe) => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-cli-l1-'))
    try {
      const asked = askedFile(history)
      observe('reach', asked === undefined ? 'lists-every-target' : 'lists-one-file')
      if (history.json) observe('reach', 'lists-as-json')
      if (history.bom && history.crlf) observe('reach', 'expression-behind-a-mark-and-crlf')
      const listed = history.files.filter((_, index) => asked === undefined || fileName(index) === asked)
      const statements = listed.flatMap((file) => (file.isModule ? [...file.top, ...file.functions.flatMap((fn) => fn.statements)] : []))
      if (statements.some((each) => each.broken && TEMPLATES[each.template]!.text.includes('('))) observe('reach', 'expression-over-several-lines')
      if (statements.some((each) => each.template === 6)) observe('reach', 'excerpt-cut')
      if (statements.some((each) => each.template === 7)) observe('reach', 'excerpt-as-long-as-allowed')
      if (listed.some((file) => !file.isModule)) observe('reach', 'global-script-lists-nothing')
      if (history.listsMissingFile && history.listedBy === 'paths' && asked === undefined) observe('reach', 'missing-target-left-out')

      writeProject(history, dir)
      const out: Array<string> = []
      const err: Array<string> = []
      const { run } = await import('../src/cli.ts')
      const exit = run(['list', ...(asked === undefined ? [] : [asked]), ...(history.json ? ['--json'] : [])], {
        cwd: dir,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      })
      const entries = history.json ? (JSON.parse(out.join('\n')) as Array<Entry>) : out.map(parseLine)

      // What the plugin registers for the same files, in the order of their paths.
      const plugin = executionPoints({ root: dir })
      await plugin.buildStart.call({ addWatchFile() {} })
      const registered: Array<string> = []
      for (const index of history.files.map((_, each) => each)) {
        if (asked !== undefined && fileName(index) !== asked) continue
        const result = await plugin.transform.call({}, writeFile(history, index).source, join(dir, fileName(index)))
        // The registration is one statement on one line, and every argument of it is JSON: the file, its nodes, and more.
        const written = /= \w+\((".*)\);\n/.exec(result?.code ?? '')?.[1]
        const nodes = written === undefined ? [] : ((JSON.parse(`[${written}]`) as [string, Array<{ id: string }>])[1])
        registered.push(...nodes.map((node) => node.id))
      }
      // The same command line with no directory given, and with the current one given.
      const here = (io: { cwd?: string }) => {
        const lines: Array<string> = []
        const code = run(['list', '--json'], { ...io, out: (line) => lines.push(line), err: (line) => lines.push(line) })
        return JSON.stringify([code, lines])
      }
      observe('list', {
        exit,
        entries,
        registered,
        saysNothingToSelect: err.some((line) => /nothing to select/i.test(line)),
        listsTheCurrentDirectoryByDefault: here({}) === here({ cwd: process.cwd() }) && here({}).startsWith('[0,'),
      })
    } catch (err) {
      observe('list', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) =>
    differs('list', 'lists-what-the-plugin-registers', observations.find((o) => o.checkpoint === 'list')?.value, expected) ??
    pass,
  calibrations: [
    {
      name: 'one-line-off',
      law: 'lists-what-the-plugin-registers',
      history: { constructed: 'behind-a-mark-and-crlf' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'list') return o
          const value = o.value as { entries: Array<Entry> }
          return { ...o, value: { ...value, entries: value.entries.map((entry) => ({ ...entry, column: entry.column + 1 })) } }
        }),
    },
    {
      name: 'lists-more-than-the-plugin-registers',
      law: 'lists-what-the-plugin-registers',
      history: { constructed: 'global-script' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'list') return o
          return {
            ...o,
            value: {
              ...(o.value as object),
              entries: [{ file: 'src/part0.ts', line: 3, column: 14, id: 'src/part0.ts#checkout:CallExpression:send:0', kind: 'CallExpression', callee: 'send', inFunction: 'checkout', nth: 0, text: 'send(a)' }],
              saysNothingToSelect: false,
            },
          }
        }),
    },
    {
      name: 'excerpt-not-cut',
      law: 'lists-what-the-plugin-registers',
      history: { constructed: 'long-expression' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'list') return o
          const value = o.value as { entries: Array<Entry> }
          return { ...o, value: { ...value, entries: value.entries.map((entry) => ({ ...entry, text: TEMPLATES[6].text })) } }
        }),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law L2: What cannot be listed is refused with a reason and a code
// ---------------------------------------------------------------------------

const REFUSALS = {
  'file-is-no-target': {
    argv: ['list', 'src/other.ts'],
    exit: 1,
    says: 'src/other.ts is not a target: add it to "targets" in points.ep',
  },
  'file-does-not-exist': { argv: ['list', 'src/nowhere.ts'], exit: 1, says: 'src/nowhere.ts does not exist' },
  'listed-file-does-not-exist': { argv: ['list', 'src/gone.ts'], exit: 1, says: 'src/gone.ts does not exist' },
  'no-manifest': { argv: ['list'], exit: 1, says: 'points.ep' },
  'broken-manifest': { argv: ['list', 'src/app.ts'], exit: 1, says: 'points.ep' },
  'unknown-command': { argv: ['show'], exit: 2, says: 'Usage: execution-points list' },
  'no-command': { argv: [], exit: 2, says: 'Usage: execution-points list' },
  'unknown-flag': { argv: ['list', '--yaml'], exit: 2, says: 'Usage: execution-points list' },
  'two-files': { argv: ['list', 'src/app.ts', 'src/other.ts'], exit: 2, says: 'Usage: execution-points list' },
} as const
type Refusal = keyof typeof REFUSALS

// How the module is loaded: asked for help, or started as a program, or only imported.
const LOADS = ['help', 'help-short', 'started-as-the-program', 'started-through-a-link', 'imported'] as const
type Load = (typeof LOADS)[number]

type RefusalHistory = { refusal: Refusal } | { load: Load }

const enumeratedRefusalHistories: ReadonlyArray<RefusalHistory> = [
  ...(Object.keys(REFUSALS) as Array<Refusal>).map((refusal) => ({ refusal })),
  ...LOADS.map((load) => ({ load })),
]

/** Nothing on the output stream but the usage, when it was asked for. */
function refusalModel(history: RefusalHistory) {
  if ('refusal' in history) {
    const { exit, says } = REFUSALS[history.refusal]
    return { exit, out: [], says }
  }
  switch (history.load) {
    case 'help':
    case 'help-short':
      return { exit: 0, out: ['Usage: execution-points list'], says: '' }
    // The program is started with a command it does not understand, so that its answer shows.
    case 'started-as-the-program':
    case 'started-through-a-link':
      return { exit: 2, out: [], says: 'Usage: execution-points list' }
    case 'imported':
      return { exit: 'none', out: [], says: '' }
  }
}

let loads = 0

oracleProperty({
  id: 'cli-refuses-with-a-reason',
  owns: ['src/cli.ts'],
  law: {
    statement:
      'For every command line that cannot be listed, run prints nothing on the output stream, says why on the error stream, and returns 1 for a file that is not a target, a file that does not exist, and a missing or broken manifest, and 2 for a command line it does not understand; --help prints the usage and returns 0; and loading the module runs the command line only when the module is the program Node was started with, directly or through a link.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a file that is not a target, a missing file, and a missing manifest each produce a clear message and a non-zero exit code; the command is `npx execution-points list <file>`.',
    limits:
      'Nine command lines that are refused, two that ask for help, and three ways of loading the module. The program is started inside the test process: its file is loaded anew while process.argv names it.',
  },
  histories: {
    enumerated: enumeratedRefusalHistories,
    states: ['refused-for-the-project', 'refused-for-the-command-line', 'helped', 'ran-as-the-program', 'only-imported'],
  },
  label: (h) => ('refusal' in h ? h.refusal : h.load),
  model: (history) => refusalModel(history),
  driver: async (history, observe) => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-cli-l2-'))
    const out: Array<string> = []
    const err: Array<string> = []
    const firstLines = () => ({
      out: out.map((line) => line.split('\n')[0]!.slice(0, 'Usage: execution-points list'.length)),
    })
    try {
      if ('refusal' in history) {
        const { argv, exit, says } = REFUSALS[history.refusal]
        observe('reach', exit === 1 ? 'refused-for-the-project' : 'refused-for-the-command-line')
        mkdirSync(join(dir, 'src'))
        writeFileSync(join(dir, 'src/app.ts'), 'export function f(a) { return send(a) }\n')
        writeFileSync(join(dir, 'src/other.ts'), 'export function g(a) { return send(a) }\n')
        if (history.refusal === 'broken-manifest') writeFileSync(join(dir, 'points.ep'), JSON.stringify({ targets: 'src/app.ts' }))
        else if (history.refusal !== 'no-manifest') {
          writeFileSync(join(dir, 'points.ep'), JSON.stringify({ targets: ['src/app.ts', 'src/gone.ts'] }))
        }
        const { run } = await import('../src/cli.ts')
        const code = run([...argv], { cwd: dir, out: (line) => out.push(line), err: (line) => err.push(line) })
        observe('refusal', { exit: code, ...firstLines(), says: err.join('\n').includes(says) ? says : err.join('\n') })
        return
      }

      const { run } = await import('../src/cli.ts')
      if (history.load === 'help' || history.load === 'help-short') {
        observe('reach', 'helped')
        const code = run([history.load === 'help' ? '--help' : '-h'], { cwd: dir, out: (line) => out.push(line), err: (line) => err.push(line) })
        observe('refusal', { exit: code, ...firstLines(), says: err.join('\n') })
        return
      }

      // Loads the module anew, as Node would with these arguments, and tells what it did.
      observe('reach', history.load === 'imported' ? 'only-imported' : 'ran-as-the-program')
      const link = join(dir, 'execution-points')
      symlinkSync(CLI_FILE, link)
      const started = {
        'started-as-the-program': CLI_FILE,
        'started-through-a-link': link,
        imported: join(realpathSync(dir), 'some-other-program.mjs'),
      }[history.load]
      writeFileSync(join(dir, 'some-other-program.mjs'), '')
      const saved = { argv: process.argv, exitCode: process.exitCode, log: console.log, error: console.error }
      process.argv = [process.argv[0]!, started, 'show']
      process.exitCode = undefined
      console.log = (line: string) => out.push(line)
      console.error = (line: string) => err.push(line)
      let exit: number | string
      try {
        await import(/* @vite-ignore */ `../src/cli.ts?loaded=${(loads += 1)}`)
        exit = process.exitCode ?? 'none'
      } finally {
        Object.assign(console, { log: saved.log, error: saved.error })
        process.argv = saved.argv
        process.exitCode = saved.exitCode
      }
      const says = 'Usage: execution-points list'
      observe('refusal', { exit, ...firstLines(), says: err.join('\n').includes(says) ? says : err.join('\n') })
    } catch (error) {
      observe('refusal', { threw: error instanceof Error ? error.message : String(error) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) =>
    differs('refusal', 'refuses-with-a-reason', observations.find((o) => o.checkpoint === 'refusal')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'refusal-with-code-zero',
      law: 'refuses-with-a-reason',
      history: { enumerated: 'file-is-no-target' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'refusal' ? { ...o, value: { ...(o.value as object), exit: 0 } } : o)),
    },
    {
      name: 'import-runs-the-command-line',
      law: 'refuses-with-a-reason',
      history: { enumerated: 'imported' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'refusal' ? { ...o, value: { exit: 2, out: [], says: 'Usage: execution-points list' } } : o,
        ),
    },
  ],
})
