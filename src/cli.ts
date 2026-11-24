#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type IndexedFile, type IndexedNode, indexTargetFile, loadManifest, resolveTargetFiles } from './discovery.ts'

const usage = `Usage: execution-points list [file] [--json]

Lists what a test can select in the target modules that points.ep names: one line for each
expression, with its place, the fields that select(file, visitor) hands to the visitor, the
functions, classes and declarations it stands inside (what a visitor traverses into), and its
text.

  file     list this target only; without it, every target
  --json   print the entries as one JSON array`

/** One expression as the command reports it. */
export interface ListedExpression {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly id: string
  readonly kind: IndexedNode['kind']
  readonly callee?: string
  readonly operator?: string
  readonly object?: string
  readonly inFunction: string | null
  readonly nth: number
  /** The functions, classes and variable declarators the expression stands inside, outermost first. */
  readonly inside: ReadonlyArray<{ readonly type: string; readonly name: string; readonly line: number }>
  readonly text: string
}

export interface RunOptions {
  readonly cwd?: string
  readonly out?: (line: string) => void
  readonly err?: (line: string) => void
}

/** One expression as the command reports it: where an editor shows it, what a visitor sees of it, and its text on one line. */
function entryOf(
  { source, relativeFile, nodes, containers }: IndexedFile,
  node: IndexedNode,
): ListedExpression {
  const { id, kind, callee, operator, object, inFunction, nth, line, text, start } = node
  const index = nodes.indexOf(node)
  // A byte-order mark is no character of the first line.
  const linesBefore = source.slice(source.charCodeAt(0) === 0xfeff ? 1 : 0, start).split(/\r\n|\r|\n/)
  return {
    file: relativeFile,
    line,
    column: linesBefore.at(-1)!.length + 1,
    id,
    kind,
    ...(callee !== undefined ? { callee } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(object !== undefined ? { object } : {}),
    inFunction,
    nth,
    inside: containers.filter((container) => container.nodes.includes(index)).map(({ type, name, line: at }) => ({ type, name, line: at })),
    text,
  }
}

/** The line for one entry: its place, its fields under the names a visitor reads, and its text. */
function lineOf({ file, line, column, id, text, inside, ...fields }: ListedExpression): string {
  // A value with a space in it is written in JSON quotes, so that the fields stay apart.
  const named = Object.entries({ ...fields, inside: inside.map(({ type, name }) => `${type}:${name}`).join('>') }).map(
    ([name, value]) => `${name}=${/\s/.test(String(value)) ? JSON.stringify(value) : value}`,
  )
  // The id is the longest field and the least read one, so it comes last.
  return `${file}:${line}:${column}  ${named.join(' ')} id=${id}  ${text}`
}

/** Runs one command line in the project at `cwd`, and returns its exit code. */
export function run(argv: readonly string[], { cwd = process.cwd(), out = console.log, err = console.error }: RunOptions = {}): number {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const [command, asked, ...more] = argv.filter((arg) => !arg.startsWith('-'))
  if (flags.includes('--help') || flags.includes('-h')) {
    out(usage)
    return 0
  }
  if (command !== 'list' || more.length || flags.some((flag) => flag !== '--json')) {
    err(usage)
    return 2
  }

  let files: string[]
  try {
    const manifest = loadManifest(cwd)
    const targets = resolveTargetFiles(cwd, manifest.targets)
    const file = asked === undefined ? undefined : resolve(cwd, asked)
    if (file && !existsSync(file)) throw new Error(`[execution-points] ${asked} does not exist.`)
    if (file && !targets.includes(file)) {
      throw new Error(
        `[execution-points] ${asked} is not a target: add it to "targets" in ${relative(cwd, manifest.manifestPath)} to select its expressions.`,
      )
    }
    // A target that the manifest lists and the disk lacks is left out, as the plugin leaves it out.
    files = file ? [file] : targets.filter((target) => existsSync(target))
  } catch (error) {
    err((error as Error).message)
    return 1
  }

  const entries = files.flatMap((file) => {
    const indexed = indexTargetFile(file, readFileSync(file, 'utf8'), cwd)
    return indexed.nodes.map((node) => entryOf(indexed, node))
  })
  if (flags.length) out(JSON.stringify(entries, null, 2))
  else for (const entry of entries) out(lineOf(entry))
  if (!entries.length) {
    err('[execution-points] Nothing to select: a call, a binary operation, or a ternary in a file with an import or export.')
  }
  return 0
}

// `npx execution-points` starts this file through a link.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2))
}
