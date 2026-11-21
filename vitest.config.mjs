import { defineConfig } from 'vitest/config'
import { executionPoints } from './src/plugin.mjs'
import points from './points.config.mjs'

export default defineConfig({
  plugins: [executionPoints(points)],
  test: {
    include: points.testFiles,
    environment: 'node',
    isolate: true,
  },
})
