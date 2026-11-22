import { AsyncLocalStorage } from 'node:async_hooks'

// Vite can load this module through more than one module graph. All copies in
// the same Node worker must share the same async-local store and file index.
function getRegistry() {
  return (globalThis[Symbol.for('execution-points-prototype.runtime.v2')] ??= {
    storage: new AsyncLocalStorage(),
    files: new Map(),
  })
}

export function registerFile(file, nodes) {
  getRegistry().files.set(file, nodes)
}

function getFileNodes(file) {
  const nodes = getRegistry().files.get(file)
  if (!nodes) {
    throw new Error(
      `[execution-points] Target file "${file}" was not instrumented or has not been imported yet. ` +
        'Ensure it is listed in points.ep under "targets" and imported before running the action.',
    )
  }
  return nodes
}

function createPointHandle(resolveSelection, captureNames) {
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

      const { storage } = getRegistry()
      const selected = resolveSelection()
      const replacements = new Map(storage.getStore() ?? [])
      replacements.set(selected.id, {
        handler,
        captureNames: captureNames ?? selected.captureNames,
      })

      return storage.run(replacements, action)
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
 * Imperative narrowing visitor.
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
  if (getRegistry().files.has(file)) resolveNow()
  return createPointHandle(resolveNow)
}

/**
 * Called by instrumented target code before evaluating a selectable expression.
 * Fast-paths straight to originalThunk() when no replacement is active.
 */
export function invoke(id, originalThunk, captureThunk) {
  const active = getRegistry().storage.getStore()?.get(id)
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
