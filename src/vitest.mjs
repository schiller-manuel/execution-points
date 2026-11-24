// Vitest setup module: after each test, check what its replacements still owe.
// With another runner, call `verifyReplacements()` from the runtime yourself.
import { afterEach } from 'vitest'

// The runtime is loaded when the first test ends, not when this file loads: a runtime that
// cannot load then fails the tests that use it instead of every test file's setup.
afterEach(async () => {
  const { verifyReplacements } = await import('./runtime.mjs')
  verifyReplacements()
})
