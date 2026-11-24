// End-to-end probe helper: build a real consumer project (the package copied into its
// node_modules exactly like bench/toolchain.mjs does) and run the real `tsc` and `vitest` on it.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { REPO, WORK, buildLibrary } from './lib.mjs'

export { REPO }

export function consumer(files, { targets = ['src/**/*.ts'] } = {}) {
  const root = realpathSync(mkdtempSync(join(WORK, 'e2e-')))
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const entry of readdirSync(join(REPO, 'node_modules'))) {
    if (entry === '.bin' || entry.startsWith('.')) continue
    symlinkSync(join(REPO, 'node_modules', entry), join(nm, entry))
  }
  const pkg = join(nm, 'execution-points-prototype')
  mkdirSync(pkg)
  cpSync(join(REPO, 'package.json'), join(pkg, 'package.json'))
  cpSync(join(REPO, 'points.schema.json'), join(pkg, 'points.schema.json'))
  cpSync(buildLibrary(), join(pkg, 'dist'), { recursive: true })

  const base = {
    'package.json': JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    'points.ep': JSON.stringify({ tsconfig: 'tsconfig.json', targets }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        noEmit: true, skipLibCheck: true, types: ['node'],
      },
      contentMappers: [{ package: 'execution-points-prototype', extensions: ['.ep'] }],
      include: ['src/**/*.ts', 'test/**/*.ts', 'points.ep'],
    }),
    'vitest.config.mjs': `import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'
import { readFileSync } from 'node:fs'
const points = JSON.parse(readFileSync(new URL('./points.ep', import.meta.url), 'utf8'))
export default defineConfig({
  plugins: [executionPoints({ ...points, root: import.meta.dirname })],
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
`,
  }
  for (const [rel, src] of Object.entries({ ...base, ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), src)
  }
  const run = (bin, args) => {
    const r = spawnSync(process.execPath, [join(REPO, 'node_modules', bin), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}`.replaceAll(root + '/', '') }
  }
  return {
    root,
    tsc: () => run('typescript/bin/tsc', ['--noEmit', '--runExternalCode', '--pretty', 'false']),
    vitest: () => run('vitest/vitest.mjs', ['run', '--reporter=default']),
  }
}

export const tail = (text, n = 14) => text.trim().split('\n').slice(-n).join('\n')
