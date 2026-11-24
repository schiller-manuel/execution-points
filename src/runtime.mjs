import { AsyncLocalStorage } from 'node:async_hooks'

// Vite can load this module through more than one module graph. All copies in
// the same Node worker must share the same async-local store and file index.
const registry = (globalThis[Symbol.for('execution-points-prototype.runtime.v2')] ??= {
  storage: new AsyncLocalStorage(),
  files: new Map(),
  states: new Map(),
  flagCount: 0,
})

/**
 * Returns the file's flags, one per home (a function body, or a position that is evaluated
 * later, as the plugin numbers them in `homes`). Instrumented code reads its home's flag
 * before it runs: until a test installs a replacement for an expression of that home, the
 * flag is off and the original statements run. Every registration of the file is told about
 * every replacement, earlier or later, so no copy of the code can miss one.
 */
export function registerFile(file, nodes, homes = []) {
  registry.files.set(file, nodes)
  const state = registry.states.get(file) ?? { replaced: new Set(), layouts: new Map() }
  registry.states.set(file, state)

  const homeOf = new Map(nodes.map((node, index) => [node.id, homes[index] ?? 0]))
  const key = JSON.stringify([...homeOf])
  if (!state.layouts.has(key)) {
    // Each flag is an object with a shape of its own. V8 then treats an unset flag as a constant,
    // so reading it costs nothing, until that very flag is set.
    const flags = Array.from({ length: Math.max(...homeOf.values(), 0) + 1 }, () => {
      const name = `flag ${(registry.flagCount += 1)}`
      return { [name]: name, on: false }
    })
    for (const id of state.replaced) flags[homeOf.get(id)].on = true
    state.layouts.set(key, { flags, homeOf })
  }
  return state.layouts.get(key).flags
}

/** From here on, calls into the home of `id` take the wrapped expressions. */
function markReplaced(file, id) {
  const state = registry.states.get(file)
  state.replaced.add(id)
  for (const { flags, homeOf } of state.layouts.values()) flags[homeOf.get(id)].on = true
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

function createPointHandle(file, resolveSelection, captureNames) {
  return Object.freeze({
    capture(...keys) {
      return createPointHandle(file, resolveSelection, keys)
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
        captureNames: captureNames ?? selected.captureNames,
      })

      markReplaced(file, selected.id)
      return registry.storage.run(replacements, action)
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
  if (registry.files.has(file)) resolveNow()
  return createPointHandle(file, resolveNow)
}

/**
 * Called by instrumented target code before evaluating a selectable expression, once a
 * replacement has been installed for an expression of its home.
 */
export function invoke(id, originalThunk, captureThunk) {
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
