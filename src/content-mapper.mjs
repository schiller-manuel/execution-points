#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { API } from 'typescript/sync'
import { generateRegistryModule } from './contracts.mjs'
import { buildPlan, resolveTestFiles } from './discovery.mjs'

const projects = new Map()
const snapshotCaches = new Map() // keyed by projectRoot so close+reopen in TS 7.1 reuses the warm snapshot!
let sharedApi

const getApi = (cwd) => (sharedApi ??= new API({ cwd }))
const safeRead = (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } }

function getSnapshotCache(projectRoot) {
  let cache = snapshotCaches.get(projectRoot)
  if (!cache) {
    cache = { snapshot: undefined, programId: undefined, configKey: undefined, sources: new Map() }
    snapshotCaches.set(projectRoot, cache)
  }
  return cache
}

function parseManifest(content, manifestFile) {
  const trimmed = (content ?? '').trim()
  if (!trimmed) return { config: { testFiles: [] }, diagnostics: [] }
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: { testFiles: [] },
        diagnostics: [{ messageText: 'points.ep must contain a JSON object with a "testFiles" array.', start: 0, length: content.length, code: 90101 }],
      }
    }
    return { config: parsed, diagnostics: [] }
  } catch (error) {
    return {
      config: { testFiles: [] },
      diagnostics: [{ messageText: `Invalid JSON in ${path.basename(manifestFile)}: ${error.message}`, start: 0, length: Math.max(1, content.length), code: 90100 }],
    }
  }
}

function scanProject(projectRoot, configFileName, options) {
  const manifestFile = options?.configFile
    ? path.resolve(projectRoot, options.configFile)
    : path.resolve(projectRoot, 'points.ep')
  const manifestText = existsSync(manifestFile) ? safeRead(manifestFile) : undefined
  const { config } = parseManifest(manifestText ?? '', manifestFile)
  const tsconfig = config.tsconfig ?? (configFileName ? path.relative(projectRoot, configFileName) : 'tsconfig.json')
  const plan = buildPlan({ root: projectRoot, tsconfig, testFiles: config.testFiles ?? [], tolerant: true, api: getApi(projectRoot) })

  const watched = new Set()
  const hash = createHash('sha256')
  hash.update(`${configFileName ?? ''}\0${manifestText ?? ''}`)
  if (configFileName && existsSync(configFileName)) {
    watched.add(configFileName)
    hash.update(`\0tsconfig:${safeRead(configFileName) ?? ''}`)
  }
  for (const file of resolveTestFiles(projectRoot, config.testFiles ?? [])) {
    watched.add(file)
    hash.update(`\0test:${file}\0${safeRead(file) ?? ''}`)
  }
  for (const target of plan.targets) {
    watched.add(target.file)
    hash.update(`\0target:${target.file}\0${target.source ?? ''}`)
  }
  for (const err of plan.errors) {
    if (!err.file) continue
    const targetPath = path.resolve(projectRoot, err.file)
    if (existsSync(targetPath)) {
      watched.add(targetPath)
      hash.update(`\0errtarget:${targetPath}\0${safeRead(targetPath) ?? ''}`)
    }
  }
  if (existsSync(manifestFile)) watched.delete(manifestFile)

  return { plan, manifestText, configIdentity: hash.digest('hex'), watchedFiles: [...watched].sort() }
}

const handlers = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion,
    positionEncoding: 'utf-16',
    diagnosticSource: 'execution-points',
  }),

  openProject(params) {
    const configFileName = params?.configFileName || ''
    const projectRoot = configFileName ? path.dirname(configFileName) : process.cwd()
    const scanned = scanProject(projectRoot, configFileName, params?.options ?? {})
    projects.set(params.projectHandle, { configFileName, projectRoot, ...scanned })
    return { configIdentity: scanned.configIdentity, watchedFiles: scanned.watchedFiles }
  },

  transform(params) {
    const project = projects.get(params.projectHandle)
    const fileName = params.fileName
    const content = params.content ?? ''
    const root = project?.projectRoot ?? path.dirname(fileName)
    const { config, diagnostics } = parseManifest(content, fileName)
    if (diagnostics.length > 0) {
      return { extension: '.ts', text: "import type {} from 'execution-points-prototype';\n", diagnostics, mappings: [] }
    }

    // Reuse the plan already built in openProject when points.ep hasn't changed in memory
    const plan = project && project.manifestText === content
      ? project.plan
      : buildPlan({
          root,
          tsconfig: config.tsconfig ?? (project?.configFileName ? path.relative(root, project.configFileName) : 'tsconfig.json'),
          testFiles: config.testFiles ?? [],
          tolerant: true,
          api: getApi(root),
        })

    const { text } = generateRegistryModule(plan, {
      fromFile: fileName,
      api: getApi(root),
      cache: getSnapshotCache(root),
    })
    return { extension: '.ts', text, diagnostics: [], mappings: [] }
  },

  closeProject(params) {
    projects.delete(params?.projectHandle)
    return {}
  },
}

const send = (payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue }
    const messageEnd = headerEnd + 4 + Number(match[1])
    if (buffer.length < messageEnd) return
    const raw = buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
    buffer = buffer.subarray(messageEnd)
    let message
    try { message = JSON.parse(raw) } catch { continue }
    if (message.id === undefined) continue
    const handler = handlers[message.method]
    if (!handler) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } }); continue }
    try { send({ jsonrpc: '2.0', id: message.id, result: handler(message.params) ?? {} }) }
    catch (err) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(err?.stack ?? err?.message ?? err) } }) }
  }
})

process.stdin.on('end', () => {
  for (const cache of snapshotCaches.values()) cache.snapshot?.dispose()
  sharedApi?.close()
  process.exit(0)
})
