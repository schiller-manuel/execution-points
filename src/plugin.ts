import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type IndexedFile, type IndexedNode, indexTargetFile, loadManifest, resolveTargetFiles } from './discovery.ts'

const runtimeModule = 'execution-points-prototype/runtime'
const setupModule = 'execution-points-prototype/vitest'

export interface ExecutionPointsOptions {
  /** The project root. Defaults to Vite's root. */
  readonly root?: string
  /** The target modules: paths and glob patterns. Defaults to the ones points.ep in the root lists. */
  readonly targets?: readonly string[]
  /** The manifest the targets were read from, when the caller read it: it is watched. */
  readonly manifestPath?: string
}

/** What the plugin needs from the context Vite calls a hook with. */
interface HookContext {
  addWatchFile?(file: string): void
}

/** A version 3 source map from the instrumented code back to the module as written. */
export interface InstrumentedSourceMap {
  readonly version: 3
  readonly sources: string[]
  readonly sourcesContent: string[]
  readonly names: string[]
  readonly mappings: string
}

export interface Instrumented {
  readonly code: string
  readonly map: InstrumentedSourceMap
}

/** The plugin's hooks. Structurally a Vite `Plugin`; declared here so that this module needs none of Vite's types. */
export interface ExecutionPointsPlugin {
  readonly name: string
  readonly enforce: 'pre'
  config(): { test: { setupFiles: string[] } }
  configResolved(config: { readonly root: string }): void
  buildStart(this: HookContext): void
  watchChange(): void
  transform(this: HookContext, code: string, id: string): Instrumented | null
}

interface Names {
  readonly invoke: string
  readonly register: string
  readonly file: string
}

/** A selectable expression or a function body, with what lies directly inside it. */
interface Item {
  readonly node?: IndexedNode
  readonly body?: IndexedFile['bodies'][number]
  readonly start: number
  readonly end: number
  readonly children: Item[]
}

/**
 * Instruments the target modules; test files need no transformation. The targets are
 * `options.targets`, or else the ones that points.ep in the root lists.
 */
export function executionPoints(options: ExecutionPointsOptions = {}): ExecutionPointsPlugin {
  let root = resolve(options.root ?? process.cwd())
  // The target files, until a watched file changes, and each target as it was last instrumented.
  let targets: Set<string> | undefined
  const indexed = new Map<string, IndexedFile>()

  function resolveTargets(context: HookContext): Set<string> {
    // Explicit targets win. Without them, points.ep in the root is the one list of targets.
    const { targets: listed, manifestPath } = options.targets ? options : loadManifest(root)
    targets = new Set(resolveTargetFiles(root, listed))
    for (const file of targets) context.addWatchFile?.(file)
    if (manifestPath) context.addWatchFile?.(manifestPath)
    return targets
  }

  return {
    name: 'execution-points-prototype',
    enforce: 'pre',

    config() {
      // After each test, the library's setup module checks what the test's replacements still owe.
      return { test: { setupFiles: [setupModule] } }
    },

    configResolved(config) {
      if (!options.root) root = resolve(config.root)
    },

    buildStart() {
      resolveTargets(this)
    },

    watchChange() {
      targets = undefined
    },

    transform(code, id) {
      // Most modules are no targets: for them nothing is read, however many targets there are.
      const file = sourceFileName(id)
      if (!file || !(targets ?? resolveTargets(this)).has(file)) return null

      let entry = indexed.get(file)
      if (entry?.source !== code) {
        // The code is new to the plugin: the file was edited, or an earlier plugin changed the code.
        const source = readSource(file)
        if (source === undefined) return null
        entry = indexTargetFile(file, source, root)
        indexed.set(file, entry)
      }
      if (entry.nodes.length === 0) return null

      if (entry.source !== code) {
        throw new Error(
          `[execution-points] Source changed before instrumentation for ${file}. ` +
            'Put executionPoints before other source-transforming plugins.',
        )
      }

      const names: Names = {
        invoke: uniqueName(code, '__epInvoke'),
        register: uniqueName(code, '__epRegister'),
        file: uniqueName(code, '__epFile'),
      }
      const metadata = entry.nodes.map(({ id: nodeId, kind, inFunction, callee, operator, nth }) => ({
        id: nodeId,
        kind,
        inFunction,
        ...(callee !== undefined ? { callee } : {}),
        ...(operator !== undefined ? { operator } : {}),
        nth,
      }))
      const homes = entry.nodes.map((node) => node.home)
      const header =
        `import { invoke as ${names.invoke}, registerFile as ${names.register} } from ${JSON.stringify(runtimeModule)};\n` +
        `const ${names.file} = ${names.register}(${JSON.stringify(entry.relativeFile)}, ${JSON.stringify(metadata)}, ${JSON.stringify(homes)});\n`

      return instrument(code, file, entry, header, names)
    },
  }
}

/**
 * Emits every home twice over: its original statements, which run until a test installs a
 * replacement for one of its expressions, and its wrapped expressions, which run afterwards.
 * An ordinary function decides once per call, so its original body runs untouched; code
 * outside such a body decides at each outermost selectable expression.
 */
function instrument(code: string, file: string, entry: IndexedFile, header: string, names: Names): Instrumented {
  const out = createEmitter(code, file)
  // Each home keeps its flag in a constant of its own, which is what lets V8 read it for free.
  const flag = (home: number): string => `${names.file}$${home}`
  const ownedHomes = new Set(entry.nodes.map((node) => node.home))
  const flags = `const ${[...ownedHomes].map((home) => `${flag(home)} = ${names.file}[${home}]`).join(', ')};\n`

  // Selectable expressions and function bodies nest; `children` holds what lies directly inside.
  const root: Item = { start: 0, end: Infinity, children: [] }
  const open = [root]
  const items: Item[] = [
    ...entry.nodes.map((node) => ({ node, start: node.start, end: node.end, children: [] })),
    ...entry.bodies
      .filter((body) => ownedHomes.has(body.home))
      .map((body) => ({ body, start: body.start, end: body.end, children: [] })),
  ].sort((a, b) => a.start - b.start || b.end - a.end)
  for (const item of items) {
    open.length = open.findLastIndex((parent) => item.start < parent.end) + 1
    open.at(-1)!.children.push(item)
    open.push(item)
  }

  const between = (children: readonly Item[], from: number, to: number, each: (child: Item) => void): void => {
    let cursor = from
    for (const child of children) {
      out.source(cursor, child.start)
      each(child)
      cursor = child.end
    }
    out.source(cursor, to)
  }

  const wrapped = (item: Item): void => {
    const { node } = item
    if (node) out.text(`${names.invoke}(${JSON.stringify(node.id)}, () => (`)
    between(item.children, item.start, item.end, wrapped)
    if (node) {
      const captures = node.captures.map((name) => `[${JSON.stringify(name)}]: () => (${name})`).join(', ')
      out.text(`), () => ({${captures}}))`)
    }
  }

  // `home` names the code that has already decided to run its original statements.
  const original = (item: Item, home: number | undefined): void => {
    const { body } = item
    // An item that is not a function body is a selectable expression.
    const node = item.node!
    if (body) {
      out.text(`{if(!${flag(body.home)}.on){`)
      between(item.children, item.start + 1, item.end - 1, (child) => original(child, body.home))
      out.text('}else{')
      between(item.children, item.start + 1, item.end - 1, wrapped)
      out.text('}}')
    } else if (node.home === home) {
      between(item.children, item.start, item.end, (child) => original(child, home))
    } else {
      // A leading parenthesis would continue the previous line of a statement that ends without `;`.
      out.text(`${node.startsStatement ? '0,' : ''}(${flag(node.home)}.on?`)
      wrapped(item)
      out.text(':')
      between(item.children, item.start, item.end, (child) => original(child, node.home))
      out.text(')')
    }
  }

  // Leading directives stay the file's first statements, so the header goes on a line behind them.
  const headerAt = entry.directivesEnd || importOffset(code)
  out.source(0, headerAt)
  out.text((entry.directivesEnd ? '\n' : '') + header + flags)
  between(root.children, headerAt, code.length, (child) => original(child, undefined))
  return out.finish()
}

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let text = ''
  do {
    const digit = rest & 31
    rest >>>= 5
    text += base64[rest ? digit | 32 : digit]
  } while (rest)
  return text
}

/** Builds the output and a source map that sends each copied token back to where it was written. */
function createEmitter(code: string, file: string) {
  const lineOf = new Uint32Array(code.length)
  const columnOf = new Uint32Array(code.length)
  let line = 0
  let lineStart = 0
  code.split('').forEach((char, offset) => {
    lineOf[offset] = line
    columnOf[offset] = offset - lineStart
    if (char === '\n') {
      line++
      lineStart = offset + 1
    }
  })

  const lines: string[][] = [[]]
  let generated = ''
  let sinceSegment = 0
  let lastLine = 0
  let lastColumn = 0

  // A segment starts where the generated line stands; its fields are relative to the previous one.
  const segment = (fields: string): void => {
    lines.at(-1)!.push(vlq(sinceSegment) + fields)
    sinceSegment = 0
  }
  const advance = (text: string): void => {
    generated += text
    const rows = text.split('\n')
    for (const _ of rows.slice(1)) lines.push([])
    sinceSegment = rows.at(-1)!.length
  }

  return {
    /** Code of ours: it maps to nothing. */
    text(text: string): void {
      segment('')
      advance(text)
    },
    /** Code copied from the original, token by token. */
    source(from: number, to: number): void {
      for (const [token] of code.slice(from, to).matchAll(/[\w$]+|[^\w$\n]+|\n/g)) {
        segment(vlq(0) + vlq(lineOf[from]! - lastLine) + vlq(columnOf[from]! - lastColumn))
        lastLine = lineOf[from]!
        lastColumn = columnOf[from]!
        advance(token)
        from += token.length
      }
    },
    finish(): Instrumented {
      return {
        code: generated,
        map: {
          version: 3,
          sources: [file],
          sourcesContent: [code],
          names: [],
          mappings: lines.map((segments) => segments.join(',')).join(';'),
        },
      }
    },
  }
}

function readSource(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function sourceFileName(id: string): string | undefined {
  const [file, query] = id.split('?', 2) as [string, string | undefined]
  if (query && /(?:^|&)(?:raw|url|worker|sharedworker)(?:&|=|$)/.test(query)) return undefined
  if (file.startsWith('file:')) return resolve(fileURLToPath(file))
  if (file.startsWith('/@fs/')) return resolve(file.slice(4))
  return isAbsolute(file) ? resolve(file) : undefined
}

function uniqueName(source: string, base: string): string {
  let candidate = base
  let suffix = 0
  while (source.includes(candidate)) candidate = `${base}_${++suffix}`
  return candidate
}

function importOffset(source: string): number {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  if (source.startsWith('#!', offset)) {
    const lineEnd = source.indexOf('\n', offset)
    offset = lineEnd === -1 ? source.length : lineEnd + 1
  }
  return offset
}
