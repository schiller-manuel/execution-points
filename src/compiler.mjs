import { existsSync } from 'node:fs'
import path from 'node:path'
import { API, ModuleKind, ModuleResolutionKind } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { ScriptTarget } from 'typescript/ast'
import { generateRegistryModule } from './contracts.mjs'

function normalize(diagnostic) {
  const start = Math.max(0, diagnostic.pos ?? diagnostic.start ?? 0)
  const end = Math.max(start, diagnostic.end ?? start)
  const chain = (diagnostic.messageChain ?? []).map((child) => child.text).filter(Boolean)
  return {
    fileName: diagnostic.fileName,
    start,
    end,
    code: diagnostic.code,
    text: [diagnostic.text ?? 'TypeScript reported an error.', ...chain].join('\n'),
  }
}

function diagnosticsOf(program) {
  return [
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getBindDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]
    .filter((diagnostic) => diagnostic.category === 1)
    .map(normalize)
}

function uniqueDiagnostics(diagnostics) {
  const seen = new Set()
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Typecheck a discovered plan using the exact same virtual ExecutionPointRegistry
 * module augmentation that the TypeScript 7.1 content mapper supplies to tsc and VS Code.
 * No generated files are written to disk.
 */
export function checkPlan(plan, { overrides = new Map() } = {}) {
  const originals = new Map()
  for (const target of plan.targets) originals.set(target.file, target.source)
  for (const test of plan.tests) originals.set(test.file, test.source)
  for (const [file, source] of overrides) originals.set(file, source)

  const api = new API({ cwd: plan.root })
  let finalSnapshot
  try {
    const virtualRegistryFile = path.join(plan.root, '__execution_points_registry.d.ts')
    const { text: registryText, contracts } = generateRegistryModule(plan, {
      fromFile: virtualRegistryFile,
      api,
      overrides,
    })

    const config = plan.tsconfig && existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
    const configDiagnostics = (config?.errors ?? [])
      .filter((diagnostic) => diagnostic.code !== 18068)
      .map(normalize)
    const compilerOptions = {
      strict: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      ...config?.options,
      noEmit: true,
      declaration: false,
      emitDeclarationOnly: false,
      incremental: false,
      composite: false,
    }

    const files = new Map(originals)
    files.set(virtualRegistryFile, registryText)

    const rootFiles = [
      ...new Set([
        ...(config?.fileNames ?? []).filter((file) => !file.endsWith('.ep')),
        ...originals.keys(),
        virtualRegistryFile,
      ]),
    ]

    finalSnapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...files]),
      createPrograms: [{ rootFiles, compilerOptions }],
    })

    const diagnostics = uniqueDiagnostics([
      ...configDiagnostics,
      ...diagnosticsOf(finalSnapshot.operation.createdPrograms[0]),
    ])

    return {
      ok: diagnostics.length === 0,
      diagnostics,
      contracts,
      registryText,
    }
  } finally {
    finalSnapshot?.dispose()
    api.close()
  }
}
