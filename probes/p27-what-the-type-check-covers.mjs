// Probe: what `pnpm check` looks at, and what `strict` lets through.
//   1. The oracle test files are outside tsconfig's `include`. Type-checked with the same options,
//      how many errors do they have, and of which kind?
//   2. A value from a rejection handler is `any` under `strict`. Does `tsc` object? Does
//      `checks/no-any.mjs`?
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { API } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { REPO, contracts, discovery, show } from './lib.mjs'

function diagnose(extraRoots, overrides = new Map()) {
  const api = new API({ cwd: REPO })
  let snapshot
  try {
    const plan = discovery.buildTargetPlan({ ...discovery.loadManifest(REPO), overrides, api })
    const registryFile = join(REPO, '__execution_points_registry.d.ts')
    const { text } = contracts.generateFileRegistryModule(plan, { fromFile: registryFile, api, overrides })
    const config = api.parseConfigFile(plan.tsconfig)
    const files = new Map([[registryFile, text], ...plan.files.map((entry) => [entry.file, entry.source]), ...overrides])
    snapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...files]),
      createPrograms: [
        {
          rootFiles: [...new Set([...config.fileNames.filter((f) => !f.endsWith('.ep')), ...files.keys(), ...extraRoots])],
          compilerOptions: { ...config.options, noEmit: true },
        },
      ],
    })
    const program = snapshot.operation.createdPrograms[0]
    return { options: config.options, errors: program.getSemanticDiagnostics().filter((d) => d.category === 1) }
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

console.log('## 1. tsconfig.json')
const tsconfig = JSON.parse(readFileSync(join(REPO, 'tsconfig.json'), 'utf8'))
show('strict', tsconfig.compilerOptions.strict)
show('include', tsconfig.include)

console.log('\n## 2. the oracle test files, type-checked with the same options')
const tests = readdirSync(join(REPO, 'tests'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(REPO, 'tests', name))
const { errors } = diagnose(tests)
const inTests = errors.filter((d) => d.fileName?.includes('/tests/'))
show('errors outside tests/', errors.length - inTests.length)
show('errors in tests/', inTests.length)
const byCode = new Map()
for (const d of inTests) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1)
for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
  const sample = inTests.find((d) => d.code === code)
  console.log(`  TS${code} x${count}  e.g. ${String(sample.text).slice(0, 110)}`)
}
show('declaration files next to src/*.mjs', readdirSync(join(REPO, 'src')).filter((name) => /\.d\.m?ts$/.test(name)))
show('src/runtime.d.mts exists (what `import "../src/runtime.mjs"` resolves to)', existsSync(join(REPO, 'src/runtime.d.mts')))

console.log('\n## 3. an `any` that `strict` lets through')
const example = join(REPO, 'examples/profile.test.ts')
const source = readFileSync(example, 'utf8')
const line = source.split('\n').find((text) => text.includes('.catch((error: unknown) => error)'))
if (!line) throw new Error('the example no longer has the line this probe rewrites')
const silent = source.replace(line, line.replace('(error: unknown) => error', '(error) => error')).replace(
  /\n\s*assert\(failure instanceof InterleavingFailure[^\n]*\n/,
  '\n',
)
show('rewritten line', line.replace('(error: unknown) => error', '(error) => error').trim())
show('tsc errors in the example', diagnose([], new Map([[example, silent]])).errors.filter((d) => d.fileName === example).length)
const { findSilentAny, describeSilentAny } = await import(join(REPO, 'checks/no-any.mjs'))
for (const finding of findSilentAny(new Map([[example, silent]]))) console.log('  ' + describeSilentAny(finding).split('. Say')[0])
show('checks/no-any.mjs on the example as committed', findSilentAny().length + ' found')
