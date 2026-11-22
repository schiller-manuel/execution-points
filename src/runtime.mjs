import { AsyncLocalStorage } from 'node:async_hooks'

// Vite can load this module through more than one module graph. All copies in
// the same Node worker must share the same async-local store and file index.
const registryKey = Symbol.for('execution-points-prototype.runtime.v2')
const registry = globalThis[registryKey] ?? createRegistry()

function createRegistry() {
  const value = {
    storage: new AsyncLocalStorage(),
    files: new Map(),
    activeCount: 0,
  }
  Object.defineProperty(globalThis, registryKey, { value })
  return value
}

export function registerFile(file, nodes) {
  registry.files.set(file, nodes)
}

function getFileNodes(file) {
  const nodes = registry.files.get(file)
  if (!nodes) {
    throw new Error(
      `[execution-points] Target file "${file}" was not instrumented or has not been imported yet. ` +
        'Ensure it is listed in points.ep under "targets" and imported before running the action.',
    )
  }
  return nodes
}

function createPointHandle(resolveSelection, captureNames = []) {
  return Object.freeze({
    capture(...keys) {
      return createPointHandle(resolveSelection, keys)
    },

    withReplacement(handler, action) {
      if (typeof handler !== 'function' || typeof action !== 'function') {
        throw new TypeError(
          '[execution-points] withReplacement requires a replacement function and an action function.',
        )
      }

      const selected = resolveSelection()
      const replacements = new Map(registry.storage.getStore() ?? [])
      replacements.set(selected.id, {
        handler,
        captureNames: captureNames.length ? captureNames : selected.captureNames,
      })

      registry.activeCount += 1
      let done = false
      const release = () => {
        if (!done) {
          done = true
          registry.activeCount -= 1
        }
      }

      // Preserve synchronous returns, thrown errors, and Promise identity.
      let result
      try {
        result = registry.storage.run(replacements, action)
      } catch (error) {
        release()
        throw error
      }

      if (result && typeof result.then === 'function') {
        result.then(release, release)
        return result
      }
      release()
      return result
    },
  })
}

function makeVisitorNode(descriptor) {
  return Object.freeze({
    ...descriptor,
    capture(...keys) {
      return Object.freeze({ __epSelected: true, id: descriptor.id, captureNames: keys })
    },
  })
}

/**
 * Option A — Imperative narrowing visitor.
 */
export function select(file, visitor) {
  if (typeof visitor !== 'function') {
    throw new TypeError('[execution-points] select(file, visitor) requires a visitor function.')
  }

  let cached
  const resolveNow = () => {
    if (cached) return cached
    const nodes = getFileNodes(file)
    const matches = []
    for (const descriptor of nodes) {
      const result = visitor(makeVisitorNode(descriptor))
      if (!result) continue
      if (result.__epSelected) {
        matches.push({ id: result.id, captureNames: result.captureNames })
      } else if (typeof result.id === 'string') {
        matches.push({ id: result.id, captureNames: [] })
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `[execution-points] Visitor for "${file}" must match exactly 1 expression; matched ${matches.length}.`,
      )
    }
    cached = matches[0]
    return cached
  }

  // Eagerly resolve when the target module is already loaded so invalid visitors fail fast.
  if (registry.files.has(file)) resolveNow()
  return createPointHandle(resolveNow)
}

function createScopeNavigator(file, filterFn) {
  const pick = (kind, predicate, nth = 0) => {
    const resolveNow = () => {
      const nodes = getFileNodes(file).filter(filterFn).filter((n) => n.kind === kind && predicate(n))
      const match = nodes.find((n) => n.nth === nth) ?? nodes[nth]
      if (!match) {
        throw new Error(`[execution-points] No matching ${kind} (nth=${nth}) found in "${file}".`)
      }
      return { id: match.id, captureNames: [] }
    }
    if (registry.files.has(file)) resolveNow()
    return createPointHandle(resolveNow)
  }

  return Object.freeze({
    call(callee, nth = 0) {
      return pick('CallExpression', (n) => n.callee === callee, nth)
    },
    binary(operator, nth = 0) {
      return pick('BinaryExpression', (n) => n.operator === operator, nth)
    },
    conditional(nth = 0) {
      return pick('ConditionalExpression', () => true, nth)
    },
  })
}

/**
 * Option B — Typed fluent navigator.
 */
export function fromFile(file, navigate) {
  if (typeof navigate !== 'function') {
    throw new TypeError('[execution-points] fromFile(file, navigate) requires a navigator callback.')
  }
  const rootScope = createScopeNavigator(file, () => true)
  const nav = Object.freeze({
    ...rootScope,
    fn(name) {
      return createScopeNavigator(file, (n) => n.inFunction === name)
    },
    topLevel() {
      return createScopeNavigator(file, (n) => n.inFunction === null)
    },
  })
  return navigate(nav)
}

/**
 * Called by instrumented target code before evaluating a selectable expression.
 * Fast-paths straight to originalThunk() when no replacement is active.
 */
export function invoke(id, originalThunk, captureThunk) {
  if (registry.activeCount === 0) return originalThunk()
  const active = registry.storage.getStore()?.get(id)
  if (!active) return originalThunk()

  const getters = captureThunk()
  const locals = Object.create(null)
  for (const key of active.captureNames) {
    const getter = getters[key]
    locals[key] = typeof getter === 'function' ? getter() : getter
  }
  Object.freeze(locals)
  const context = Object.freeze({ locals, original: originalThunk })
  return active.handler(context)
}
