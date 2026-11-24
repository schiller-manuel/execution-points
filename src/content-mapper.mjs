#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { API } from 'typescript/sync'
import { generateFileRegistryModule } from './contracts.mjs'
import { buildTargetPlan, resolveTargetFiles } from './discovery.mjs'

const projects = new Map()
let sharedApi
const getApi = () => (sharedApi ??= new API())
const safeRead = (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } }

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
export function parseManifest(content, manifestFile, root = path.dirname(manifestFile)) {
  const text = content ?? ''
  const body = text.trim()
  const manifest = { tsconfig: undefined, targets: [], diagnostics: [], fatal: false }
  const report = (code, messageText, start = 0, length = text.length) => {
    manifest.diagnostics.push({ messageText, start, length, code })
  }
  if (!body) return manifest

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    report(90100, `Invalid JSON in ${path.basename(manifestFile)}: ${error.message}`)
  }
  if (parsed === undefined || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (parsed !== undefined) report(90101, SHAPE)
    manifest.fatal = true
    return manifest
  }

  // TypeScript's JSON syntax tree says where each key and each element stands.
  const lease = getApi().createSourceFile(`${manifestFile}.json`, body)
  try {
    const lead = text.indexOf(body)
    const at = (node) => {
      const start = node.getStart(lease.sourceFile)
      return [lead + start, node.end - start]
    }
    const properties = new Map(lease.sourceFile.statements[0].expression.properties.map((property) => [property.name.text, property]))
    for (const [key, property] of properties) {
      if (key !== 'targets' && key !== 'tsconfig') {
        report(90102, `Unknown key ${JSON.stringify(key)} in ${path.basename(manifestFile)}. The keys are "targets" and "tsconfig".`, ...at(property.name))
      }
    }

    const tsconfig = properties.get('tsconfig')
    if (tsconfig && typeof parsed.tsconfig !== 'string') {
      report(90103, '"tsconfig" must be the path of a tsconfig file.', ...at(tsconfig.initializer))
    } else if (tsconfig && !existsSync(path.resolve(root, parsed.tsconfig))) {
      report(90103, `The tsconfig file ${JSON.stringify(parsed.tsconfig)} does not exist.`, ...at(tsconfig.initializer))
    } else {
      manifest.tsconfig = parsed.tsconfig
    }

    const targets = properties.get('targets')
    if (!Array.isArray(parsed.targets)) {
      report(90101, SHAPE, ...(targets ? at(targets.initializer) : []))
      return manifest
    }
    targets.initializer.elements.forEach((element, index) => {
      const entry = parsed.targets[index]
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
function analyze(root, tsconfigHint, manifestFile, content, cache) {
  const manifest = parseManifest(content, manifestFile, root)
  const order = new Map()
  manifest.targets.forEach(({ files }, index) => {
    for (const file of files) if (!order.has(file)) order.set(file, index)
  })
  const plan = buildTargetPlan({
    root,
    tsconfig: manifest.tsconfig ?? (tsconfigHint || 'tsconfig.json'),
    targets: manifest.targets.map(({ entry }) => entry),
    api: getApi(),
  })
  plan.files.sort((a, b) => order.get(a.file) - order.get(b.file))
  const registry = generateFileRegistryModule(plan, { fromFile: manifestFile, api: getApi(), cache })

  const mappings = []
  for (const span of registry.spans) {
    const target = manifest.targets[order.get(span.file)]
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
export function scanProject(projectRoot, configFileName, options, cache) {
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

export function initialize(params) {
  return {
    protocolVersion: params.protocolVersion,
    positionEncoding: 'utf-16',
    diagnosticSource: 'execution-points',
  }
}

/** One warm TypeScript program per open project, kept until the project closes. */
export function openProject(params) {
  const configFileName = params.configFileName || ''
  const projectRoot = configFileName ? path.dirname(configFileName) : process.cwd()
  const cache = projects.get(params.projectHandle)?.cache ?? {}
  const scanned = scanProject(projectRoot, configFileName, params.options, cache)
  projects.set(params.projectHandle, { configFileName, projectRoot, cache })
  return scanned
}

export function transform(params) {
  const project = projects.get(params.projectHandle)
  const root = project?.projectRoot ?? path.dirname(params.fileName)
  const { manifest, registry, mappings } = analyze(root, project?.configFileName, params.fileName, params.content ?? '', project?.cache)
  if (manifest.fatal) {
    return { extension: '.ts', text: "import type {} from 'execution-points-prototype';\n", diagnostics: manifest.diagnostics, mappings: [] }
  }
  return { extension: '.ts', text: registry.text, diagnostics: manifest.diagnostics, mappings }
}

export function closeProject(params) {
  projects.get(params.projectHandle)?.cache.snapshot?.dispose()
  projects.delete(params.projectHandle)
  return {}
}

const handlers = { initialize, openProject, transform, closeProject }

function formatFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export function handleInputChunk(state, chunk, write = (frame) => process.stdout.write(frame)) {
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
    let message
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
      write(formatFrame({ jsonrpc: '2.0', id: message.id, result: handler(message.params) }))
    } catch (err) {
      write(formatFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(err?.message ?? err) } }))
    }
  }
}

// Serve standard input only when this file is the mapper process, not when it is imported.
if (import.meta.main) {
  const stdioState = { buffer: Buffer.alloc(0) }
  process.stdin.on('data', (chunk) => {
    handleInputChunk(stdioState, chunk)
  })
  process.stdin.on('end', () => {
    sharedApi?.close()
  })
}
