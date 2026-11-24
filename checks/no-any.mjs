// Fails when a name in the type-checked files silently has the type `any`.
//
// `strict` already rejects an implicit `any`: a parameter or variable TypeScript could not infer.
// It says nothing when the `any` comes from a declaration somewhere else, as in
//
//   const failure = await work().catch((error) => error)   // both `error` and `failure` are `any`
//
// because `Promise#catch` declares its reason as `any`. This check reports every variable,
// parameter and destructured name whose type is `any` without an annotation that says so, and
// every `any` value that an annotation or `as` covers up.
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API, ModuleKind, ModuleResolutionKind, TypeFlags } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { ScriptTarget, SyntaxKind } from 'typescript/ast'

import { generateFileRegistryModule } from '../src/contracts.mjs'
import { buildTargetPlan, loadManifest } from '../src/discovery.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walk(node, visit) {
  visit(node)
  node.forEachChild((child) => {
    walk(child, visit)
  })
}

/**
 * Every silent `any` in the project's own type-checked `.ts` files, as
 * `{ file, line, column, name, why }`. `overrides` maps a file to the text to check instead.
 */
export function findSilentAny(overrides = new Map()) {
  const api = new API({ cwd: root })
  let snapshot
  try {
    const plan = buildTargetPlan({ ...loadManifest(root), overrides, api })
    const registryFile = join(root, '__execution_points_registry.d.ts')
    const { text: registryText } = generateFileRegistryModule(plan, { fromFile: registryFile, api, overrides })
    const config = existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
    const files = new Map([[registryFile, registryText]])
    for (const entry of plan.files) files.set(entry.file, entry.source)
    for (const [file, source] of overrides) files.set(file, source)
    const configured = (config?.fileNames ?? []).filter((file) => !file.endsWith('.ep'))
    snapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...files]),
      createPrograms: [
        {
          rootFiles: [...new Set([...configured, ...files.keys()])],
          compilerOptions: {
            strict: true,
            target: ScriptTarget.ES2022,
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.Bundler,
            skipLibCheck: true,
            ...config?.options,
            noEmit: true,
          },
        },
      ],
    })
    const program = snapshot.operation.createdPrograms[0]
    const checker = program.getProject().checker
    const isAny = (type) => Boolean(type && type.flags & TypeFlags.Any && !type.isErrorType())

    const found = []
    const own = configured.filter(
      (file) => !file.endsWith('.d.ts') && resolve(file).startsWith(root + sep) && !file.includes('node_modules'),
    )
    for (const file of own.sort()) {
      const sourceFile = program.getSourceFile(file)
      if (!sourceFile) continue
      const text = files.get(file) ?? sourceFile.text
      // What to ask the checker about, and what to say when the answer is `any`.
      const questions = []
      walk(sourceFile, (node) => {
        const named =
          node.kind === SyntaxKind.VariableDeclaration ||
          node.kind === SyntaxKind.Parameter ||
          node.kind === SyntaxKind.BindingElement
        if (named && node.name?.kind === SyntaxKind.Identifier) {
          if (!node.type) {
            questions.push({ at: node.name, name: node.name.text, why: 'has the type `any`' })
          } else if (node.initializer && node.type.kind !== SyntaxKind.AnyKeyword) {
            questions.push({
              at: node.initializer,
              name: node.name.text,
              why: 'is annotated, but the value it is given has the type `any`, so the annotation is not checked',
            })
          }
        }
        if (
          (node.kind === SyntaxKind.AsExpression || node.kind === SyntaxKind.SatisfiesExpression) &&
          node.type.kind !== SyntaxKind.AnyKeyword
        ) {
          questions.push({ at: node.expression, name: undefined, why: 'this value has the type `any`, and `as` covers it up' })
        }
      })
      if (questions.length === 0) continue
      const types = checker.getTypeAtLocation(questions.map((question) => question.at))
      questions.forEach((question, index) => {
        if (!isAny(types[index])) return
        const start = question.at.getStart(sourceFile)
        const before = text.slice(0, start).split('\n')
        found.push({
          file: relative(root, file),
          line: before.length,
          column: before.at(-1).length + 1,
          name: question.name,
          why: question.why,
        })
      })
    }
    return found
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

export const describeSilentAny = ({ file, line, column, name, why }) =>
  `${file}(${line},${column}): error: ${name ? `'${name}' ${why}` : why}. Say what it is: annotate the source of the value, for example \`(error: unknown) =>\`, and narrow it.`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findSilentAny()
  for (const finding of found) console.error(describeSilentAny(finding))
  if (found.length) {
    console.error(`\n${found.length} silent \`any\` ${found.length === 1 ? 'type' : 'types'}.`)
    process.exit(1)
  }
  console.log('no silent `any` in the type-checked files')
}
