import { Console } from 'node:console'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { analyzeEditor } from './editor-service.mjs'

// Keep stdout exclusively for the JSONL protocol, including while loading a
// user's executable points configuration. VS Code displays stderr in Output.
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Execution Points requires Node.js 24 or newer. Set executionPoints.nodePath to that Node executable.')
  process.exit(1)
}

const workspaceRoot = resolve(process.argv[2] ?? process.cwd())
let config
let startupError
try {
  const loaded = await import(pathToFileURL(resolve(workspaceRoot, 'points.config.mjs')).href)
  if (!loaded.default || typeof loaded.default !== 'object' || Array.isArray(loaded.default)) {
    throw new Error('points.config.mjs must default-export a configuration object.')
  }
  config = { ...loaded.default, root: resolve(workspaceRoot, loaded.default.root ?? '.') }
} catch (error) {
  startupError = error
}

function readOverrides(entries = []) {
  if (!Array.isArray(entries)) throw new Error('Editor overrides must be [absoluteFileName, sourceText] pairs.')
  const result = new Map()
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'string') || !isAbsolute(entry[0])) {
      throw new Error('Editor overrides must be [absoluteFileName, sourceText] pairs.')
    }
    const file = resolve(entry[0])
    const inside = relative(config.root, file)
    if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) {
      throw new Error(`Editor buffer is outside the configured project root: ${file}`)
    }
    result.set(file, entry[1])
  }
  return result
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
    if (typeof request.id !== 'number' && typeof request.id !== 'string') throw new Error('Editor requests need an id.')
    if (startupError) throw startupError
    if (!['analyze', 'hover', 'completion'].includes(request.method)) throw new Error(`Unknown editor method: ${request.method}`)
    const overrides = readOverrides(request.overrides)
    let query
    if (request.method !== 'analyze') {
      if (typeof request.fileName !== 'string' || !isAbsolute(request.fileName) || !Number.isSafeInteger(request.position) || request.position < 0) {
        throw new Error('Hover and completion requests require an absolute fileName and a nonnegative position.')
      }
      const fileName = resolve(request.fileName)
      const source = overrides.get(fileName) ?? readFileSync(fileName, 'utf8')
      if (request.position > source.length) throw new Error('Editor position is outside the current document.')
      query = { kind: request.method, fileName, position: request.position }
    }
    const result = analyzeEditor(config, { overrides, query })
    send({ id: request.id, result })
  } catch (error) {
    send({ id: request?.id ?? null, error: error.message ?? String(error) })
  }
}
