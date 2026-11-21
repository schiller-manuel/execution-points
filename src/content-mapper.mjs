#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { API } from 'typescript/sync'
import { generateRegistryModule } from './contracts.mjs'
import { buildPlan, resolveTestFiles } from './discovery.mjs'

const projects = new Map()
let sharedApi

function getApi(cwd) {
  if (!sharedApi) {
    sharedApi = new API({ cwd })
  }
  return sharedApi
}

function safeRead(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function findManifestFile(projectRoot, options) {
  if (options?.configFile) return path.resolve(projectRoot, options.configFile)
  const candidate = path.resolve(projectRoot, 'points.ep')
  return existsSync(candidate) ? candidate : undefined
}

function parseManifest(content, manifestFile) {
  const trimmed = (content ?? '').trim()
  if (!trimmed) return { config: { testFiles: [] }, diagnostics: [] }
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: { testFiles: [] },
        diagnostics: [
          {
            messageText: 'points.ep must contain a JSON object with a "testFiles" array.',
            start: 0,
            length: content.length,
            code: 90101,
          },
        ],
      }
    }
    return { config: parsed, diagnostics: [] }
  } catch (error) {
    return {
      config: { testFiles: [] },
      diagnostics: [
        {
          messageText: `Invalid JSON in ${path.basename(manifestFile)}: ${error.message}`,
          start: 0,
          length: Math.max(1, content.length),
          code: 90100,
        },
      ],
    }
  }
}

function scanProjectState(projectRoot, configFileName, options) {
  const manifestFile = findManifestFile(projectRoot, options)
  const manifestText = manifestFile ? safeRead(manifestFile) : undefined
  const { config } = parseManifest(manifestText ?? '', manifestFile ?? 'points.ep')

  const testFiles = resolveTestFiles(projectRoot, config.testFiles ?? [])
  const watched = new Set()
  const hash = createHash('sha256')
  hash.update(configFileName ?? '')
  hash.update('\0')
  hash.update(manifestText ?? '')

  // Hash tsconfig (if present) and all test files + referenced targets
  if (configFileName && existsSync(configFileName)) {
    watched.add(configFileName)
    hash.update('\0tsconfig:')
    hash.update(safeRead(configFileName) ?? '')
  }

  const plan = buildPlan({
    root: projectRoot,
    tsconfig: config.tsconfig ?? (configFileName ? path.relative(projectRoot, configFileName) : 'tsconfig.json'),
    testFiles: config.testFiles ?? [],
    tolerant: true,
  })

  for (const file of testFiles) {
    watched.add(file)
    hash.update('\0test:')
    hash.update(file)
    hash.update('\0')
    hash.update(safeRead(file) ?? '')
  }

  for (const target of plan.targets) {
    watched.add(target.file)
    hash.update('\0target:')
    hash.update(target.file)
    hash.update('\0')
    hash.update(target.source ?? '')
  }

  // Also watch target files mentioned in errors (e.g., broken selector inside a valid target)
  for (const err of plan.errors) {
    if (err.file) {
      const targetPath = path.resolve(projectRoot, err.file)
      if (existsSync(targetPath)) {
        watched.add(targetPath)
        hash.update('\0errtarget:')
        hash.update(targetPath)
        hash.update('\0')
        hash.update(safeRead(targetPath) ?? '')
      }
    }
  }

  // Never include the transformed .ep file itself in watchedFiles (TS watches it directly)
  if (manifestFile) watched.delete(manifestFile)

  return {
    configIdentity: hash.digest('hex'),
    watchedFiles: [...watched].sort(),
  }
}

const handlers = {
  initialize(params) {
    return {
      protocolVersion: params?.protocolVersion,
      positionEncoding: 'utf-16',
      diagnosticSource: 'execution-points',
    }
  },

  openProject(params) {
    const configFileName = params?.configFileName || ''
    const projectRoot = configFileName ? path.dirname(configFileName) : process.cwd()
    const state = {
      configFileName,
      projectRoot,
      options: params?.options ?? {},
      compilerOptions: params?.compilerOptions ?? {},
    }
    projects.set(params.projectHandle, state)
    const { configIdentity, watchedFiles } = scanProjectState(projectRoot, configFileName, state.options)
    return { configIdentity, watchedFiles }
  },

  transform(params) {
    const project = projects.get(params.projectHandle)
    const fileName = params.fileName
    const content = params.content ?? ''
    const root = project?.projectRoot ?? path.dirname(fileName)
    const { config, diagnostics } = parseManifest(content, fileName)

    if (diagnostics.length > 0) {
      return {
        extension: '.ts',
        text: "import type {} from 'execution-points-prototype';\n",
        diagnostics,
        mappings: [],
      }
    }

    const plan = buildPlan({
      root,
      tsconfig: config.tsconfig ?? (project?.configFileName ? path.relative(root, project.configFileName) : 'tsconfig.json'),
      testFiles: config.testFiles ?? [],
      tolerant: true,
    })

    const { text } = generateRegistryModule(plan, {
      fromFile: fileName,
      api: getApi(root),
    })

    return {
      extension: '.ts',
      text,
      diagnostics: [],
      mappings: [],
    }
  },

  closeProject(params) {
    projects.delete(params?.projectHandle)
    return {}
  },
}

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  process.stdout.write(Buffer.concat([header, body]))
}

let buffer = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const headerText = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length:\s*(\d+)/i.exec(headerText)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const contentLength = Number(match[1])
    const messageEnd = headerEnd + 4 + contentLength
    if (buffer.length < messageEnd) return

    const raw = buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
    buffer = buffer.subarray(messageEnd)

    let message
    try {
      message = JSON.parse(raw)
    } catch {
      continue
    }

    if (message.id === undefined) continue

    const handler = handlers[message.method]
    if (!handler) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown method: ${message.method}` },
      })
      continue
    }

    try {
      const result = handler(message.params) ?? {}
      send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: String(error?.stack ?? error?.message ?? error) },
      })
    }
  }
})

process.stdin.on('end', () => {
  sharedApi?.close()
  process.exit(0)
})
