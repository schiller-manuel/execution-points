import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import MagicString from 'magic-string'
import { buildPlan } from './discovery.mjs'

const runtimeModule = 'execution-points-prototype/runtime'

/** Instrument only the tests and expressions discovered from explicit points. */
export function executionPoints(options = {}) {
  let root = resolve(options.root ?? process.cwd())
  let plan
  let observedFiles = new Map()
  let dirty = true
  let pendingPlan

  function watchFiles(context, nextPlan) {
    if (!context?.addWatchFile) return
    for (const file of planFileNames(nextPlan)) context.addWatchFile(file)
    if (nextPlan.tsconfig) context.addWatchFile(resolve(root, nextPlan.tsconfig))
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
      const nextPlan = buildPlan({ ...options, root })
      const nextObservedFiles = new Map()
      for (const test of nextPlan.tests) {
        nextObservedFiles.set(resolve(root, test.file), test.source)
      }
      for (const target of nextPlan.targets) {
        nextObservedFiles.set(resolve(root, target.file), target.source)
      }
      if (nextPlan.tsconfig) {
        const configFile = resolve(root, nextPlan.tsconfig)
        nextObservedFiles.set(configFile, readSource(configFile))
      }
      plan = nextPlan
      observedFiles = nextObservedFiles
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

  function planFileNames(value) {
    return new Set([
      ...value.tests.map((test) => resolve(root, test.file)),
      ...value.targets.map((target) => resolve(root, target.file)),
    ])
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

    async handleHotUpdate(context) {
      const previousFiles = plan ? planFileNames(plan) : new Set()
      const nextPlan = await getPlan(undefined, true)
      const files = new Set([...previousFiles, ...planFileNames(nextPlan)])
      const modules = new Set(context.modules)

      // A changed test selector can require new instrumentation in an unchanged
      // application file, so invalidate both sides of the previous/new plan.
      for (const file of files) {
        for (const module of context.server.moduleGraph.getModulesByFile(file) ?? []) {
          context.server.moduleGraph.invalidateModule(module)
          modules.add(module)
        }
      }
      return [...modules]
    },

    async transform(code, id) {
      const file = sourceFileName(id)
      if (!file) return null

      const currentPlan = await getPlan(this)
      const tests = currentPlan.tests.filter((test) => resolve(root, test.file) === file)
      const targets = currentPlan.targets.filter((target) => resolve(root, target.file) === file)
      if (tests.length === 0 && targets.length === 0) return null

      for (const entry of [...tests, ...targets]) {
        if (entry.source !== code) {
          throw new Error(
            `[execution-points] Source changed before instrumentation for ${file}. ` +
              'The plugin requires the original source text at its recorded AST positions. ' +
              'Put executionPoints before other source-transforming plugins and retry after saving the file.',
          )
        }
      }

      const source = new MagicString(code)
      const insertions = new Map()
      const at = (offset) => {
        if (!Number.isInteger(offset) || offset < 0 || offset > code.length) {
          throw new Error(`[execution-points] Invalid transform position ${offset} in ${file}.`)
        }
        let entry = insertions.get(offset)
        if (!entry) {
          entry = { before: [], opens: [], closes: [] }
          insertions.set(offset, entry)
        }
        return entry
      }

      for (const test of tests) {
        for (const point of test.points) {
          at(point.runtimeInsert).before.push(`, ${JSON.stringify(point.targetId)}`)
        }
      }

      if (targets.length > 0) {
        const invokeName = uniqueName(code, '__epInvoke')
        at(importOffset(code)).before.unshift(
          `import { invoke as ${invokeName} } from ${JSON.stringify(runtimeModule)};\n`,
        )
        for (const target of targets) {
          if (target.start >= target.end) {
            throw new Error(`[execution-points] Invalid expression span for ${target.id} in ${file}.`)
          }
          const captures = target.captures
            .map((name) => `[${JSON.stringify(name)}]: ${name}`)
            .join(', ')
          at(target.start).opens.push({
            ...target,
            text: `${invokeName}(${JSON.stringify(target.id)}, () => (`,
          })
          at(target.end).closes.push({
            ...target,
            text: `), () => ({${captures}}))`,
          })
        }
      }

      for (const [offset, entry] of insertions) {
        // Prefixes go outer-to-inner; suffixes go inner-to-outer. Inserting at
        // boundaries keeps the original expression tokens and source map intact.
        entry.opens.sort((a, b) => b.end - a.end || a.id.localeCompare(b.id))
        entry.closes.sort((a, b) => b.start - a.start || b.id.localeCompare(a.id))
        source.appendLeft(
          offset,
          entry.closes.map((item) => item.text).join('') +
            entry.before.join('') +
            entry.opens.map((item) => item.text).join(''),
        )
      }

      if (insertions.size === 0) return null
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
