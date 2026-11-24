import { defineConfig } from 'vitest/config'
import { executionPoints } from './src/plugin.mjs'

// Tests, and the code the plugin instruments, run against the sources, not against `dist`.
const source = (name) => new URL(`./src/${name}`, import.meta.url).pathname

export default defineConfig({
  // The plugin reads the targets from points.ep, the file TypeScript reads them from, and adds
  // the setup module that fails a test whose replacement did not run.
  plugins: [executionPoints()],
  resolve: {
    alias: [
      { find: /^execution-points-prototype(\/runtime)?$/, replacement: source('runtime.ts') },
      { find: /^execution-points-prototype\/vitest$/, replacement: source('vitest.ts') },
    ],
  },
  test: {
    include: ['examples/**/*.test.ts', 'tests/**/*oracle*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
