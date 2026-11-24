import { defineConfig } from 'tsdown'

// One output file per source file, so that every entry point of the package shares one copy of
// the runtime: instrumented code imports it as `execution-points-prototype/runtime`, tests as
// `execution-points-prototype`.
export default defineConfig({
  entry: ['src/runtime.ts', 'src/vitest.ts', 'src/plugin.ts', 'src/content-mapper.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  unbundle: true,
  // The library has a config of its own: the one at the root also type-checks the examples,
  // through the content mapper this package provides.
  tsconfig: 'tsconfig.build.json',
  dts: true,
})
