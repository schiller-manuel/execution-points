#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { API } from 'typescript/sync'
import type { Node } from 'typescript/ast'
import { type GeneratedRegistry, type RegistryCache, generateFileRegistryModule } from './contracts.ts'
import { type TargetPlan, buildTargetPlan, resolveTargetFiles } from './discovery.ts'

/** A diagnostic of the mapper's own, at a range of the manifest's text. */
export interface ManifestDiagnostic {
  readonly messageText: string
  readonly start: number
  readonly length: number
  readonly code: number
}

/** One entry of `targets` that is a string: the files it resolves to, and where it stands in the manifest. */
export interface ManifestTarget {
  readonly entry: string
  readonly files: string[]
  readonly start: number
  readonly length: number
}

export interface ParsedManifest {
  readonly targets: ManifestTarget[]
  readonly diagnostics: ManifestDiagnostic[]
  tsconfig?: string
  /** The content is not a JSON object at all. */
  fatal?: boolean
}

/** A span of the registry mapped onto a span of the manifest: generated start and length, original start and length, kind, features. */
export type Mapping = [number, number, number, number, number, number]

interface Project {
  readonly configFileName: string
  readonly projectRoot: string
  readonly cache: RegistryCache
}

/** The fields of TypeScript's JSON syntax tree that the manifest reader follows. */
interface JsonSyntax extends Node {
  readonly text: string
  readonly name: JsonSyntax
  readonly initializer: JsonSyntax
  readonly expression: JsonSyntax
  readonly properties: readonly JsonSyntax[]
  readonly elements: readonly JsonSyntax[]
  readonly statements: readonly JsonSyntax[]
}

const projects = new Map<unknown, Project>()
let sharedApi: API | undefined
const getApi = (): API => (sharedApi ??= new API())
const safeRead = (file: string): string | undefined => { try { return readFileSync(file, 'utf8') } catch { return undefined } }

const SHAPE = 'points.ep must contain a JSON object with a "targets" array.'
// Span map: a segment of kind "atom" maps a block as a whole; the feature mask says which editor
// requests follow the mapping. Diagnostics always do.
const SPAN_ATOM = 1
const FEATURE_DEFINITION = 8

/**
 * Read a manifest. `targets` holds one entry for each listed target that is a
 * string: the files it resolves to and where it stands in `content`.
 * `diagnostics` names everything that is wrong, at the text that is wrong.
 * `fatal` is set when the content is not a JSON object at all.
 */
export function parseManifest(content: string | undefined, manifestFile: string, root: string): ParsedManifest {
  const text = content ?? ''
  const body = text.trim()
  const manifest: ParsedManifest = { targets: [], diagnostics: [] }
  const report = (code: number, messageText: string, start = 0, length = text.length): void => {
    manifest.diagnostics.push({ messageText, start, length, code })
  }
  if (!body) return manifest

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    report(90100, `Invalid JSON in ${path.basename(manifestFile)}: ${(error as Error).message}`)
  }
  if (parsed === undefined || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (parsed !== undefined) report(90101, SHAPE)
    manifest.fatal = true
    return manifest
  }
  const held = parsed as { readonly targets?: unknown; readonly tsconfig?: unknown; readonly $schema?: unknown }

  // TypeScript's JSON syntax tree says where each key and each element stands.
  const lease = getApi().createSourceFile(`${manifestFile}.json`, body)
  try {
    const lead = text.indexOf(body)
    const at = (node: JsonSyntax): [number, number] => {
      const start = node.getStart(lease.sourceFile)
      return [lead + start, node.end - start]
    }
    const tree = lease.sourceFile as unknown as JsonSyntax
    const properties = new Map(tree.statements[0]!.expression.properties.map((property) => [property.name.text, property]))
    for (const [key, property] of properties) {
      if (key !== 'targets' && key !== 'tsconfig' && key !== '$schema') {
        report(90102, `Unknown key ${JSON.stringify(key)}. The keys of a manifest are "targets", "tsconfig" and "$schema".`, ...at(property.name))
      }
    }

    const schema = properties.get('$schema')
    if (schema && typeof held.$schema !== 'string') {
      report(90106, '"$schema" must be the location of points.schema.json, in a string.', ...at(schema.initializer))
    }

    const tsconfig = properties.get('tsconfig')
    if (tsconfig && typeof held.tsconfig !== 'string') {
      report(90103, '"tsconfig" must be the path of a tsconfig file.', ...at(tsconfig.initializer))
    } else if (tsconfig && !existsSync(path.resolve(root, held.tsconfig as string))) {
      report(90103, `The tsconfig file ${JSON.stringify(held.tsconfig)} does not exist.`, ...at(tsconfig.initializer))
    } else {
      manifest.tsconfig = held.tsconfig as string | undefined
    }

    const targets = properties.get('targets')
    const listed = held.targets
    if (!Array.isArray(listed)) {
      report(90101, SHAPE, ...(targets ? at(targets.initializer) : []))
      return manifest
    }
    targets!.initializer.elements.forEach((element, index) => {
      const entry: unknown = listed[index]
      const [start, length] = at(element)
      if (typeof entry !== 'string') {
        report(90104, `A target must be a path or a glob in a string, not ${JSON.stringify(entry)}.`, start, length)
        return
      }
      const files = resolveTargetFiles(root, [entry])
      if (!files.some((file) => existsSync(file))) report(90105, `Target ${JSON.stringify(entry)} matches no file.`, start, length)
      manifest.targets.push({ entry, files, start, length })
    })
  } finally {
    lease.dispose()
  }
  return manifest
}

/**
 * The registry for a manifest, with the files in the order of the entries
 * that list them, and each file's nodes mapped to its entry: an error inside
 * the registry is then reported at the target that caused it, and
 * go-to-definition on a node's field lands there. The protocol maps a virtual
 * file only onto its own `.ep` text, so the entry is as near to the target
 * expression as a mapping can point.
 */
function analyze(
  root: string,
  tsconfigHint: string | undefined,
  manifestFile: string,
  content: string,
  cache: RegistryCache | undefined,
): { manifest: ParsedManifest; plan: TargetPlan; registry: GeneratedRegistry; mappings: Mapping[] } {
  const manifest = parseManifest(content, manifestFile, root)
  const order = new Map<string, number>()
  manifest.targets.forEach(({ files }, index) => {
    for (const file of files) if (!order.has(file)) order.set(file, index)
  })
  const plan = buildTargetPlan({
    root,
    tsconfig: manifest.tsconfig ?? (tsconfigHint || 'tsconfig.json'),
    targets: manifest.targets.map(({ entry }) => entry),
    api: getApi(),
  })
  plan.files.sort((a, b) => order.get(a.file)! - order.get(b.file)!)
  const registry = generateFileRegistryModule(plan, { fromFile: manifestFile, api: getApi(), cache })

  const mappings: Mapping[] = []
  for (const span of registry.spans) {
    const target = manifest.targets[order.get(span.file)!]!
    const last = mappings.at(-1)
    if (last?.[2] === target.start) last[1] = span.end - last[0]
    else mappings.push([span.start, span.end - span.start, target.start, target.length, SPAN_ATOM, FEATURE_DEFINITION])
  }
  return { manifest, plan, registry, mappings }
}

/**
 * What a project's transform depends on: the tsconfig, every listed target
 * (so that a missing one is seen when it appears), and every file of the
 * project that the analysis read.
 */
export function scanProject(
  projectRoot: string,
  configFileName: string,
  options: { readonly configFile?: string } | undefined,
  cache: RegistryCache | undefined,
): { configIdentity: string; watchedFiles: string[] } {
  const manifestFile = path.resolve(projectRoot, options?.configFile ?? 'points.ep')
  const manifestText = safeRead(manifestFile) ?? ''
  const { manifest, plan, registry } = analyze(projectRoot, configFileName, manifestFile, manifestText, cache)

  const watched = new Set([...manifest.targets.flatMap(({ files }) => files), ...registry.inputs])
  for (const file of [configFileName, plan.tsconfig]) if (file && existsSync(file)) watched.add(file)
  watched.delete(manifestFile)

  const watchedFiles = [...watched].sort()
  const hash = createHash('sha256').update(`${configFileName}\0${manifestText}`)
  for (const file of watchedFiles) hash.update(`\0${file}\0${safeRead(file) ?? ''}`)
  return { configIdentity: hash.digest('hex'), watchedFiles }
}

export function initialize(params: { readonly protocolVersion?: unknown }): {
  protocolVersion: unknown
  positionEncoding: 'utf-16'
  diagnosticSource: 'execution-points'
} {
  return {
    protocolVersion: params.protocolVersion,
    positionEncoding: 'utf-16',
    diagnosticSource: 'execution-points',
  }
}

/** One warm TypeScript program per open project, kept until the project closes. */
export function openProject(params: {
  readonly projectHandle: unknown
  readonly configFileName?: string
  readonly options?: { readonly configFile?: string }
}): { configIdentity: string; watchedFiles: string[] } {
  const configFileName = params.configFileName || ''
  const projectRoot = configFileName ? path.dirname(configFileName) : process.cwd()
  const cache = projects.get(params.projectHandle)?.cache ?? {}
  const scanned = scanProject(projectRoot, configFileName, params.options, cache)
  projects.set(params.projectHandle, { configFileName, projectRoot, cache })
  return scanned
}

export function transform(params: { readonly projectHandle: unknown; readonly fileName: string; readonly content?: string }): {
  extension: '.ts'
  text: string
  diagnostics: ManifestDiagnostic[]
  mappings: Mapping[]
} {
  const project = projects.get(params.projectHandle)
  const root = project?.projectRoot ?? path.dirname(params.fileName)
  const { manifest, registry, mappings } = analyze(root, project?.configFileName, params.fileName, params.content ?? '', project?.cache)
  if (manifest.fatal) {
    return { extension: '.ts', text: "import type {} from 'execution-points-prototype';\n", diagnostics: manifest.diagnostics, mappings: [] }
  }
  return { extension: '.ts', text: registry.text, diagnostics: manifest.diagnostics, mappings }
}

export function closeProject(params: { readonly projectHandle: unknown }): {} {
  projects.get(params.projectHandle)?.cache.snapshot?.dispose()
  projects.delete(params.projectHandle)
  return {}
}

// Each handler says what it needs of its params; the frame reader hands over what the message holds.
const handlers: Record<string, ((params: never) => unknown) | undefined> = { initialize, openProject, transform, closeProject }

function formatFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export function handleInputChunk(state: { buffer: Buffer }, chunk: Buffer, write: (frame: Buffer) => void): void {
  state.buffer = Buffer.concat([state.buffer, chunk])
  for (;;) {
    const headerEnd = state.buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const match = /Content-Length:\s*(\d+)/i.exec(state.buffer.subarray(0, headerEnd).toString('ascii'))
    if (!match) {
      state.buffer = state.buffer.subarray(headerEnd + 4)
      continue
    }
    const messageEnd = headerEnd + 4 + Number(match[1])
    if (state.buffer.length < messageEnd) return
    const raw = state.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
    state.buffer = state.buffer.subarray(messageEnd)
    let message: { readonly id?: unknown; readonly method: string; readonly params?: unknown }
    try {
      message = JSON.parse(raw)
    } catch {
      continue
    }
    if (message.id === undefined) continue
    const handler = handlers[message.method]
    if (!handler) {
      write(formatFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } }))
      continue
    }
    try {
      write(formatFrame({ jsonrpc: '2.0', id: message.id, result: handler(message.params as never) }))
    } catch (err) {
      write(formatFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(err) } }))
    }
  }
}

// Serve standard input only when this file is the mapper process, not when it is imported.
if (import.meta.main) {
  const stdioState = { buffer: Buffer.alloc(0) }
  process.stdin.on('data', (chunk: Buffer) => {
    handleInputChunk(stdioState, chunk, (frame) => process.stdout.write(frame))
  })
  process.stdin.on('end', () => {
    sharedApi?.close()
  })
}
