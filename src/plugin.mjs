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

  function getPlan(context) {
    if (
      plan &&
      [...observedFiles].every(([file, expected]) => readSource(file) === expected)
    ) {
      return plan
    }
    plan = buildTargetPlan({ ...options, root })
    observedFiles = new Map(plan.files.map((entry) => [entry.file, entry.source]))
    if (context.addWatchFile) {
      for (const file of observedFiles.keys()) context.addWatchFile(file)
    }
    return plan
  }

  return {
    name: 'execution-points-prototype',
    enforce: 'pre',

    configResolved(config) {
      if (!options.root) root = resolve(config.root)
    },

    buildStart() {
      getPlan(this)
    },

    watchChange() {
      plan = undefined
    },

    transform(code, id) {
      const file = sourceFileName(id)
      if (!file) return null

      const currentPlan = getPlan(this)
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
        at(node.start).opens.push(`${invokeName}(${JSON.stringify(node.id)}, () => (`)
        at(node.end).closes.unshift(`), () => ({${captures}}))`)
      }

      for (const [offset, bucket] of insertions) {
        source.appendLeft(
          offset,
          bucket.closes.join('') + bucket.before.join('') + bucket.opens.join(''),
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
  } catch {
    return undefined
  }
}

function sourceFileName(id) {
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
