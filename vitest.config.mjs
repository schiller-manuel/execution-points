import { defineConfig } from 'vitest/config'
import { executionPoints } from './src/plugin.mjs'
import { loadManifest } from './src/discovery.mjs'

const points = loadManifest(import.meta.dirname)

export default defineConfig({
  plugins: [executionPoints(points)],
  test: {
    include: ['examples/**/*.test.ts', 'tests/**/*oracle*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
