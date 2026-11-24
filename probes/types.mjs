// Type-level probe helper: generate the real virtual registry for a throwaway project and
// typecheck it (plus an optional test snippet) with TypeScript 7.1, the way tsc would see it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { API } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { REPO, contracts, discovery, project } from './lib.mjs'

export const api = new API()
export const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    noEmit: true, skipLibCheck: true, types: ['node'],
  },
})

export function registry(files, targets) {
  const root = project({ 'tsconfig.json': TSCONFIG, ...files })
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
      exports: { '.': { types: './src/runtime.d.ts', default: './src/runtime.mjs' } },
    })],
    [join(root, 'node_modules/execution-points-prototype/src/runtime.d.ts'), readFileSync(`${REPO}/src/runtime.d.ts`, 'utf8')],
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

/** Registry lines for one file key, trimmed to the interesting fields. */
export function nodeLines(text) {
  return text.split('\n').filter((l) => l.trim().startsWith('| {')).map((l) => {
    const id = /readonly id: ("[^"]*")/.exec(l)?.[1]
    const result = /readonly result: (.*); readonly locals: /.exec(l)?.[1]
    const locals = /readonly locals: (\{.*\}) \}/.exec(l)?.[1]
    const unportable = /readonly __unportable: ("(?:[^"\\]|\\.)*")/.exec(l)?.[1]
    return { id, result, locals, unportable }
  })
}
