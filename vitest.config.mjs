import { defineConfig } from 'vitest/config'
import { executionPoints } from './src/plugin.mjs'

export default defineConfig({
  // The plugin reads the targets from points.ep, the file TypeScript reads them from.
  plugins: [executionPoints()],
  test: {
    include: ['examples/**/*.test.ts', 'tests/**/*oracle*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
