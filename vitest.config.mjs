import { defineConfig } from 'vitest/config'
import { executionPoints } from './src/plugin.mjs'
import { loadManifest } from './src/discovery.mjs'

const points = loadManifest(import.meta.dirname)
// Tests, and the code the plugin instruments, run against the sources, not against `dist`.
const source = (name) => new URL(`./src/${name}`, import.meta.url).pathname

export default defineConfig({
  plugins: [executionPoints(points)],
  resolve: {
    alias: [
      { find: /^execution-points-prototype(\/runtime)?$/, replacement: source('runtime.ts') },
      { find: /^execution-points-prototype\/vitest$/, replacement: source('vitest.ts') },
    ],
  },
  test: {
    // After each test, fail it when a replacement did not run as often as the test said.
    setupFiles: ['./src/vitest.ts'],
    include: ['examples/**/*.test.ts', 'tests/**/*oracle*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
