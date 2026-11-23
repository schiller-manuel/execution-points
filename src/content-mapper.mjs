#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { API } from 'typescript/sync'
import { generateFileRegistryModule } from './contracts.mjs'
import { buildTargetPlan, resolveTargetFiles } from './discovery.mjs'

const projects = new Map()
const snapshotCaches = new Map()
let sharedApi
const getApi = () => (sharedApi ??= new API())
const safeRead = (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } }

function getSnapshotCache(projectRoot) {
  let cache = snapshotCaches.get(projectRoot)
  if (!cache) {
    cache = {}
    snapshotCaches.set(projectRoot, cache)
  }
  return cache
}

export function parseManifest(content, manifestFile) {
  const trimmed = (content ?? '').trim()
  if (!trimmed) return { config: {}, diagnostics: [] }
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        diagnostics: [{ messageText: 'points.ep must contain a JSON object with a "targets" array.', start: 0, length: content.length, code: 90101 }],
      }
    }
    return { config: parsed, diagnostics: [] }
  } catch (error) {
    return {
      diagnostics: [{ messageText: `Invalid JSON in ${path.basename(manifestFile)}: ${error.message}`, start: 0, length: content.length, code: 90100 }],
    }
  }
}

export function scanProject(projectRoot, configFileName, options) {
  const manifestFile = options?.configFile
    ? path.resolve(projectRoot, options.configFile)
    : path.resolve(projectRoot, 'points.ep')
  const manifestText = safeRead(manifestFile) ?? ''
  const { config = {} } = parseManifest(manifestText, manifestFile)

  const watched = new Set()
  const hash = createHash('sha256')
  hash.update(`${configFileName}\0${manifestText}`)
  if (configFileName && existsSync(configFileName)) {
    watched.add(configFileName)
    hash.update(`\0tsconfig:${safeRead(configFileName)}`)
  }
  for (const file of resolveTargetFiles(projectRoot, config.targets ?? [])) {
    watched.add(file)
    hash.update(`\0target:${file}\0${safeRead(file) ?? ''}`)
  }
  watched.delete(manifestFile)

  return { configIdentity: hash.digest('hex'), watchedFiles: [...watched].sort() }
}

export function initialize(params) {
  return {
    protocolVersion: params.protocolVersion,
    positionEncoding: 'utf-16',
    diagnosticSource: 'execution-points',
  }
}

export function openProject(params) {
  const configFileName = params.configFileName || ''
  const projectRoot = configFileName ? path.dirname(configFileName) : process.cwd()
  const scanned = scanProject(projectRoot, configFileName, params.options)
  projects.set(params.projectHandle, { configFileName, projectRoot })
  return scanned
}

export function transform(params) {
  const project = projects.get(params.projectHandle)
  const fileName = params.fileName
  const content = params.content ?? ''
  const root = project?.projectRoot ?? path.dirname(fileName)
  const { config, diagnostics } = parseManifest(content, fileName)
  if (diagnostics.length > 0) {
    return { extension: '.ts', text: "import type {} from 'execution-points-prototype';\n", diagnostics, mappings: [] }
  }

  const plan = buildTargetPlan({
    root,
    tsconfig: config.tsconfig ?? (project?.configFileName ? path.relative(root, project.configFileName) : 'tsconfig.json'),
    targets: config.targets ?? [],
    api: getApi(),
  })

  const { text } = generateFileRegistryModule(plan, {
    fromFile: fileName,
    api: getApi(),
    cache: getSnapshotCache(root),
  })
  return { extension: '.ts', text, diagnostics: [], mappings: [] }
}

export function closeProject(params) {
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

const stdioState = { buffer: Buffer.alloc(0) }
process.stdin.on('data', (chunk) => {
  handleInputChunk(stdioState, chunk)
})
process.stdin.on('end', () => {
  for (const cache of snapshotCaches.values()) cache.snapshot?.dispose()
  sharedApi?.close()
})
