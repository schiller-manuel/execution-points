// Type-level probe helper: generate the real virtual registry for a throwaway project and
// typecheck it (plus an optional test snippet) with TypeScript 7.1, the way tsc would see it.
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { API } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { REPO, buildLibrary, contracts, discovery, project } from './lib.mjs'

export const api = new API()
export const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    noEmit: true, skipLibCheck: true, types: ['node'],
  },
})

/** `packages` names the repository's own dependencies that the throwaway project imports. */
export function registry(files, targets, { packages = [] } = {}) {
  const root = project({ 'tsconfig.json': TSCONFIG, ...files })
  // The project lives under the OS temp directory, where no package is installed.
  if (packages.length) mkdirSync(join(root, 'node_modules'))
  for (const name of packages) symlinkSync(realpathSync(join(REPO, 'node_modules', name)), join(root, 'node_modules', name))
  const plan = discovery.buildTargetPlan({ root, targets, api })
  const fromFile = join(root, 'points.ep')
  const { text } = contracts.generateFileRegistryModule(plan, { fromFile, api })
  return { root, plan, text, targets }
}

/** Typecheck targets + generated registry + optional snippet; returns error diagnostics. */
export function typecheck({ root, text, targets }, snippet) {
  const files = new Map([
    [join(root, 'node_modules/execution-points-prototype/package.json'), JSON.stringify({
      name: 'execution-points-prototype', type: 'module',
      exports: { '.': { types: './dist/runtime.d.mts', default: './dist/runtime.mjs' } },
    })],
    [join(root, 'node_modules/execution-points-prototype/dist/runtime.d.mts'), readFileSync(join(buildLibrary(), 'runtime.d.mts'), 'utf8')],
    [join(root, '__registry.ts'), text],
  ])
  const rootFiles = [...targets.map((t) => join(root, t)), join(root, '__registry.ts')]
  if (snippet) {
    files.set(join(root, 'snippet.test.ts'), snippet)
    rootFiles.push(join(root, 'snippet.test.ts'))
  }
  const { options } = api.parseConfigFile(join(root, 'tsconfig.json'))
  const snapshot = api.createSnapshot({
    fileSystem: createFileSystemLayer([...files]),
    createPrograms: [{ rootFiles, compilerOptions: options }],
  })
  try {
    const prog = snapshot.operation.createdPrograms[0]
    return [...prog.getSemanticDiagnostics(), ...prog.getSyntacticDiagnostics()]
      .filter((d) => d.category === 1)
      .map((d) => `${(d.fileName ?? '').replace(root + '/', '')}: TS${d.code}: ${[d.text ?? '', ...(d.messageChain ?? []).map((c) => c.text)].join(' ').slice(0, 220)}`)
  } finally {
    snapshot.dispose()
  }
}

/** The registry's expressions (one `type __EPNode… = { … }` line each), trimmed to the interesting fields. */
export function nodeLines(text) {
  return text.split('\n').filter((l) => l.startsWith('type __EPNode')).map((l) => {
    const id = /readonly id: ("[^"]*")/.exec(l)?.[1]
    const result = /readonly result: (.*); readonly locals: /.exec(l)?.[1]
    const locals = /readonly locals: (\{.*\}) \};?$/.exec(l)?.[1]
    const unportable = /readonly __unportable: ("(?:[^"\\]|\\.)*")/.exec(l)?.[1]
    return { id, result, locals, unportable }
  })
}
