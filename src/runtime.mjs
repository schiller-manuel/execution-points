import { AsyncLocalStorage } from 'node:async_hooks'

// Vite can load this module through more than one module graph. All copies in
// the same Node worker must dispatch through the same async-local registry.
const registryKey = Symbol.for('execution-points-prototype.runtime.v1')
const registry = globalThis[registryKey] ?? createRegistry()

function createRegistry() {
  const value = Object.freeze({ storage: new AsyncLocalStorage() })
  Object.defineProperty(globalThis, registryKey, { value })
  return value
}

/**
 * Declare an execution point. The Vite plugin supplies the second argument;
 * authored tests only pass the target specification.
 */
export function point(spec, internalId) {
  if (typeof internalId !== 'string' || internalId.length === 0) {
    const location = spec && typeof spec.file === 'string' ? ` for ${spec.file}` : ''
    throw new Error(
      `[execution-points] This point${location} was not transformed. ` +
        'Add executionPoints({ root, tsconfig, testFiles }) from ' +
        '"execution-points-prototype/vite" to your Vitest plugins, and include ' +
        'this test file in testFiles.',
    )
  }

  const captureNames = Array.isArray(spec?.capture) ? [...spec.capture] : []

  return Object.freeze({
    withReplacement(handler, action) {
      if (typeof handler !== 'function' || typeof action !== 'function') {
        throw new TypeError(
          '[execution-points] withReplacement requires a replacement function and an action function.',
        )
      }

      const replacements = new Map(registry.storage.getStore() ?? [])
      replacements.set(internalId, { handler, captureNames })

      // Do not make this function async: synchronous returns, thrown errors,
      // and the identity of an action's Promise must pass through unchanged.
      return registry.storage.run(replacements, action)
    },
  })
}

/**
 * Called by instrumented application code before evaluating the selected
 * expression. Neither the original expression nor captures are evaluated
 * eagerly at the generated call site.
 */
export function invoke(id, originalThunk, captureThunk) {
  const active = registry.storage.getStore()?.get(id)
  if (!active) return originalThunk()

  // This freezes only the null-prototype capture container. Values retain
  // their original identity; objects referenced by captures remain mutable.
  const getters = captureThunk()
  const locals = Object.create(null)
  for (const key of active.captureNames) {
    const entry = getters[key]
    locals[key] = typeof entry === 'function' ? entry() : entry
  }
  Object.freeze(locals)
  const context = Object.freeze({ locals, original: originalThunk })

  // original() is deliberately not memoized in this prototype. Every call
  // evaluates the original expression again; recursive calls behave normally.
  return active.handler(context)
}
