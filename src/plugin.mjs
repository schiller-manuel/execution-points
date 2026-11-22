import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import MagicString from 'magic-string'
import { buildTargetPlan } from './discovery.mjs'

const runtimeModule = 'execution-points-prototype/runtime'

/** Instrument target modules listed in points.ep; test files need no transformation. */
export function executionPoints(options = {}) {
  let root = resolve(options.root ?? process.cwd())
  let plan
  let observedFiles = new Map()
  let dirty = true
  let pendingPlan

  function watchFiles(context, nextPlan) {
    if (!context?.addWatchFile) return
    for (const file of nextPlan.files) context.addWatchFile(file.file)
    if (nextPlan.tsconfig) context.addWatchFile(resolve(root, nextPlan.tsconfig))
    const manifestFile = resolve(root, 'points.ep')
    if (readSource(manifestFile) !== undefined) context.addWatchFile(manifestFile)
  }

  function sourcesChanged() {
    for (const [file, expected] of observedFiles) {
      if (readSource(file) !== expected) return true
    }
    return false
  }

  async function getPlan(context, force = false) {
    if (force) dirty = true
    if (pendingPlan) return pendingPlan
    if (plan && !dirty && !sourcesChanged()) return plan

    pendingPlan = Promise.resolve().then(() => {
      const nextPlan = buildTargetPlan({ ...options, root })
      const nextObserved = new Map()
      for (const entry of nextPlan.files) nextObserved.set(entry.file, entry.source)
      if (nextPlan.tsconfig) {
        const configFile = resolve(root, nextPlan.tsconfig)
        nextObserved.set(configFile, readSource(configFile))
      }
      const manifestFile = resolve(root, 'points.ep')
      const manifestContent = readSource(manifestFile)
      if (manifestContent !== undefined) nextObserved.set(manifestFile, manifestContent)
      plan = nextPlan
      observedFiles = nextObserved
      dirty = false
      watchFiles(context, plan)
      return plan
    })

    try {
      return await pendingPlan
    } finally {
      pendingPlan = undefined
    }
  }

  return {
    name: 'execution-points-prototype',
    enforce: 'pre',

    configResolved(config) {
      if (!options.root) root = resolve(config.root)
    },

    async buildStart() {
      await getPlan(this)
    },

    watchChange() {
      dirty = true
    },

    async transform(code, id) {
      const file = sourceFileName(id)
      if (!file) return null

      const currentPlan = await getPlan(this)
      const entry = currentPlan.files.find((item) => item.file === file)
      if (!entry || entry.nodes.length === 0) return null

      if (entry.source !== code) {
        throw new Error(
          `[execution-points] Source changed before instrumentation for ${file}. ` +
            'Put executionPoints before other source-transforming plugins.',
        )
      }

      const source = new MagicString(code)
      const insertions = new Map()
      const at = (offset) => {
        let bucket = insertions.get(offset)
        if (!bucket) {
          bucket = { before: [], opens: [], closes: [] }
          insertions.set(offset, bucket)
        }
        return bucket
      }

      const invokeName = uniqueName(code, '__epInvoke')
      const registerName = uniqueName(code, '__epRegister')
      const metadata = entry.nodes.map(({ id: nodeId, kind, inFunction, callee, operator, nth }) => ({
        id: nodeId,
        kind,
        inFunction,
        ...(callee !== undefined ? { callee } : {}),
        ...(operator !== undefined ? { operator } : {}),
        nth,
      }))

      at(importOffset(code)).before.unshift(
        `import { invoke as ${invokeName}, registerFile as ${registerName} } from ${JSON.stringify(runtimeModule)};\n` +
          `${registerName}(${JSON.stringify(entry.relativeFile)}, ${JSON.stringify(metadata)});\n`,
      )

      for (const node of entry.nodes) {
        const captures = node.captures.map((name) => `[${JSON.stringify(name)}]: () => (${name})`).join(', ')
        at(node.start).opens.push({
          ...node,
          text: `${invokeName}(${JSON.stringify(node.id)}, () => (`,
        })
        at(node.end).closes.push({
          ...node,
          text: `), () => ({${captures}}))`,
        })
      }

      for (const [offset, bucket] of insertions) {
        bucket.opens.sort((a, b) => b.end - a.end || a.id.localeCompare(b.id))
        bucket.closes.sort((a, b) => b.start - a.start || b.id.localeCompare(a.id))
        source.appendLeft(
          offset,
          bucket.closes.map((item) => item.text).join('') +
            bucket.before.join('') +
            bucket.opens.map((item) => item.text).join(''),
        )
      }

      return {
        code: source.toString(),
        map: source.generateMap({ source: file, includeContent: true, hires: true }),
      }
    },
  }
}

function readSource(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

function sourceFileName(id) {
  if (id.startsWith('\0')) return undefined
  const [file, query] = id.split('?', 2)
  if (query && /(?:^|&)(?:raw|url|worker|sharedworker)(?:&|=|$)/.test(query)) return undefined
  if (file.startsWith('file:')) return resolve(fileURLToPath(file))
  if (file.startsWith('/@fs/')) return resolve(file.slice(4))
  return isAbsolute(file) ? resolve(file) : undefined
}

function uniqueName(source, base) {
  let candidate = base
  let suffix = 0
  while (source.includes(candidate)) candidate = `${base}_${++suffix}`
  return candidate
}

function importOffset(source) {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  if (source.startsWith('#!', offset)) {
    const lineEnd = source.indexOf('\n', offset)
    offset = lineEnd === -1 ? source.length : lineEnd + 1
  }
  return offset
}
