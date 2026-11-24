/**
 * Test-free companion of the oracle files. It builds a throwaway TypeScript
 * project on disk, lets production generate the registry for it, and then
 * asks TypeScript what that registry says by compiling it as `.ts` at the
 * place where the content mapper's output is compiled: beside `points.ep`.
 *
 * Nothing in this file predicts a result. Every value it returns is
 * TypeScript's own answer about the compiled registry or about the unchanged
 * target, so the models in the oracle files can state their rule without
 * reading production's text.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type API, SymbolFlags, TypeFlags } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { SyntaxKind } from 'typescript/ast'
import { generateFileRegistryModule } from '../src/contracts.mjs'
import { buildTargetPlan } from '../src/discovery.mjs'

export const repoRoot = process.cwd()

// The declarations a project that installs the package compiles against: build before running.
const runtimeTypes = readFileSync(join(repoRoot, 'dist/runtime.d.mts'), 'utf8')
const libraryPackage = JSON.stringify({
  name: 'execution-points-prototype',
  type: 'module',
  exports: { '.': { types: './dist/runtime.d.mts', default: './dist/runtime.mjs' } },
})

/**
 * Write a project to a fresh directory. `types` stays empty unless a history
 * asks for `node`, so a project that needs no Node types does not load them.
 */
export function createProject(
  files: Readonly<Record<string, string>>,
  compilerOptions: Readonly<Record<string, unknown>> = {},
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ep-oracle-')))
  const tsconfig = JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      skipLibCheck: true,
      types: [],
      typeRoots: [join(repoRoot, 'node_modules/@types')],
      ...compilerOptions,
    },
    include: ['src/**/*.ts', 'test/**/*.ts', 'points.ep'],
  })
  for (const [relative, text] of Object.entries({ 'tsconfig.json': tsconfig, ...files })) {
    mkdirSync(dirname(join(root, relative)), { recursive: true })
    writeFileSync(join(root, relative), text)
  }
  return root
}

export function removeProject(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** How the type the registry declares relates to the type TypeScript gives the original. */
export type Fit = 'same' | 'equivalent' | 'modifiers differ' | 'not assignable'

/** A descriptor field that the registry declares as `name?: undefined`. */
export const ABSENT = '(optional, undefined)'

export interface NodeReading {
  /** The literal types of the descriptor fields, as TypeScript resolves them. */
  descriptor: Record<string, string | number | null>
  /** The reason the registry gives for an expression it cannot type, or null. */
  unportable: string | null
  /** Null when the registry marks the expression unportable. */
  result: Fit | null
  /**
   * For an unportable expression: whether its declared result is a type that
   * no value a test can write has. It is not `any`, `unknown`, or `never`,
   * and neither the expression's own type, nor `{}`, nor `string` is
   * assignable to it. Null when the expression is typed.
   */
  opaque: boolean | null
  /** The string-keyed members of the declared result type; null when unportable. */
  resultMembers: Array<string> | null
  /** Whether a value of the expression's own type would pass for the declared result. */
  acceptsOriginal: boolean
  locals: Record<string, Fit>
  /** The locals of the plan that the expression itself refers to. */
  mentioned: Array<string>
  /** Locals the registry leaves out, with the reason it records for each. */
  unportableLocals: Record<string, string>
}

export interface RegistryReading {
  /** Errors TypeScript reports inside the compiled registry itself. */
  registryErrors: Array<string>
  /** Errors in the project's own files: a history with any is not a legal project. */
  projectErrors: Array<string>
  /** The file keys of `ExecutionPointFileRegistry`. */
  files: Array<string>
  /** How many copies of private types the registry declares: its `__EP_*` interfaces. */
  copies: number
  /** How many constants the registry declares to compute symbol keys from. */
  keyConstants: number
  /** One reading for each node the registry declares, by node id. */
  nodes: Record<string, NodeReading>
}

interface PlanNode {
  id: string
  kind: string
  start: number
  end: number
  captures: ReadonlyArray<string>
}
interface PlanFile {
  file: string
  relativeFile: string
  source: string
  nodes: ReadonlyArray<PlanNode>
}
export interface Plan {
  root: string
  files: ReadonlyArray<PlanFile>
}

type Checker = any
type Type = any
type Node = any

const typeOfProperty = (checker: Checker, type: Type, name: string): Type | undefined => {
  const property = checker.getPropertyOfType(type, name)
  return property && checker.getTypeOfSymbol(property)
}

/** The literal a descriptor field holds, `null` for the `null` type, ABSENT for `name?: undefined`. */
function literalOf(checker: Checker, type: Type, name: string): string | number | null {
  const property = checker.getPropertyOfType(type, name)
  if (!property) return 'missing'
  const value = checker.getTypeOfSymbol(property)
  if (property.flags & SymbolFlags.Optional && value.flags & TypeFlags.Undefined) return ABSENT
  if (value.flags & TypeFlags.Null) return null
  if (value.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) return value.value
  return `type ${checker.typeToString(value)}`
}

/**
 * The modifiers assignability does not see: `readonly` and `?` on members,
 * `readonly` on index signatures, and `?` and `...` on parameters. An
 * interface or class declared outside the project keeps its own, and the
 * registry can only name it, so the walk stops there.
 */
function modifiersOf(checker: Checker, type: Type, rootKey: string, depth = 0): string {
  if (depth > 3 || !type.isObjectType()) return ''
  const symbol = type.getSymbol()
  if (
    symbol &&
    symbol.flags & (SymbolFlags.Interface | SymbolFlags.Class) &&
    symbol.declarations.some((declaration: { path: string }) => !declaration.path.toLowerCase().startsWith(rootKey))
  ) {
    return ''
  }
  const members = type.getProperties().map(
    (property: any) =>
      `${property.name}${checker.isReadonlySymbol(property) ? '!' : ''}${property.flags & SymbolFlags.Optional ? '?' : ''}` +
      `(${modifiersOf(checker, checker.getTypeOfSymbol(property), rootKey, depth + 1)})`,
  )
  const indexes = type
    .getIndexInfos()
    .map((info: any) => `[${checker.typeToString(info.keyType)}]${info.isReadonly ? '!' : ''}`)
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()].map(
    (signature: any) =>
      `(${signature
        .getParameters()
        .map((parameter: any) => {
          const declaration = parameter.valueDeclaration?.resolve()
          return declaration?.dotDotDotToken ? '...' : declaration?.questionToken ? '?' : '.'
        })
        .join('')})`,
  )
  return [...members.sort(), ...indexes.sort(), ...signatures].join(';')
}

function fitOf(checker: Checker, declared: Type, original: Type, rootKey: string): Fit {
  if (declared.id === original.id) return 'same'
  const isAny = (type: Type) => Boolean(type.flags & TypeFlags.Any)
  if (
    isAny(declared) !== isAny(original) ||
    !checker.isTypeAssignableTo(declared, original) ||
    !checker.isTypeAssignableTo(original, declared)
  ) {
    return 'not assignable'
  }
  return modifiersOf(checker, declared, rootKey) === modifiersOf(checker, original, rootKey)
    ? 'equivalent'
    : 'modifiers differ'
}

/**
 * The type TypeScript gives a local at an expression, read from the first
 * reference to the binding inside the expression: that reference carries the
 * control-flow-narrowed type. A local the expression does not mention has no
 * reference to ask, so its declared type stands in, which is its type there
 * only when nothing narrowed it before the expression.
 */
function localTypeAt(checker: Checker, expression: Node, name: string): { type: Type; mentioned: boolean } | undefined {
  const binding = checker.resolveName(name, SymbolFlags.Value, expression)
  if (!binding) return undefined
  let reference: Node | undefined
  const visit = (node: Node) => {
    if (reference) return
    if (
      node.kind === SyntaxKind.Identifier &&
      node.text === name &&
      checker.getSymbolAtLocation(node)?.id === binding.id
    ) {
      reference = node
      return
    }
    node.forEachChild(visit)
  }
  visit(expression)
  return reference
    ? { type: checker.getTypeAtLocation(reference), mentioned: true }
    : { type: checker.getTypeOfSymbolAtLocation(binding, expression), mentioned: false }
}

export interface ReadOptions {
  /** More files for the compiled program, such as a test that uses the registry. */
  extraFiles?: Readonly<Record<string, string>>
  /** Leave the registry out, to read the project as it is before the mapper ran. */
  withoutRegistry?: boolean
  /** The project's configuration file, when it is not `tsconfig.json`. */
  tsconfig?: string
  /**
   * Pairs of slots to relate. A slot is a node id for its result, or
   * `id|name` for one of its locals. Each pair asks whether the type the
   * registry declares for the first is assignable to the second's.
   */
  relations?: ReadonlyArray<readonly [from: string, to: string]>
}

export interface CompiledRegistry {
  reading: RegistryReading
  /** Errors in each extra file, by its relative name. */
  extraErrors: Record<string, Array<{ code: number; text: string }>>
  /** One answer per requested relation; false when a slot does not exist. */
  relations: Array<boolean>
}

/**
 * Compile `registryText` as `points.ep.ts` in `root`, together with the
 * project's own files and the library's real declarations, and read it.
 */
export function compileRegistry(
  api: API,
  root: string,
  registryText: string,
  plan: Plan,
  options: ReadOptions = {},
): CompiledRegistry {
  const registryFile = join(root, 'points.ep.ts')
  const witnessFile = join(root, '__registry_witness.ts')
  const extra = Object.entries(options.extraFiles ?? {}).map(([relative, text]) => [join(root, relative), text] as const)
  const config = api.parseConfigFile(join(root, options.tsconfig ?? 'tsconfig.json'))
  const virtual: Array<readonly [string, string]> = [
    [join(root, 'node_modules/execution-points-prototype/package.json'), libraryPackage],
    [join(root, 'node_modules/execution-points-prototype/dist/runtime.d.mts'), runtimeTypes],
    [
      witnessFile,
      "import type { ExecutionPointFileRegistry } from 'execution-points-prototype'\n" +
        'export declare const registry: ExecutionPointFileRegistry\nexport declare const anObject: {}\nexport declare const aString: string\n',
    ],
    ...extra,
  ]
  if (!options.withoutRegistry) virtual.push([registryFile, registryText])
  const rootFiles = [
    ...new Set([
      ...config.fileNames.filter((file: string) => !file.endsWith('.ep')),
      ...plan.files.map((entry) => entry.file),
      ...virtual.slice(2).map(([file]) => file),
    ]),
  ]
  const snapshot = api.createSnapshot({
    fileSystem: createFileSystemLayer(virtual),
    createPrograms: [{ rootFiles, compilerOptions: config.options }],
  })
  try {
    const program = snapshot.operation.createdPrograms[0]!
    const checker: Checker = program.getProject().checker
    const rootKey = root.toLowerCase()
    const relativeName = (file: string | undefined) => (file ?? '').slice(root.length + 1)

    const registryErrors: Array<string> = []
    const projectErrors: Array<string> = []
    const extraErrors: Record<string, Array<{ code: number; text: string }>> = {}
    for (const [file] of extra) extraErrors[relativeName(file)] = []
    for (const diagnostic of [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]) {
      if (diagnostic.category !== 1) continue
      const text = [diagnostic.text ?? '', ...(diagnostic.messageChain ?? []).map((chain: any) => chain.text)].join(' ')
      const name = relativeName(diagnostic.fileName)
      if (name === 'points.ep.ts') registryErrors.push(`TS${diagnostic.code}: ${text}`)
      else if (name in extraErrors) extraErrors[name]!.push({ code: diagnostic.code, text })
      else projectErrors.push(`${name}: TS${diagnostic.code}: ${text}`)
    }

    const witnesses = new Map<string, Type>()
    const findWitnesses = (node: Node) => {
      if (node.kind === SyntaxKind.VariableDeclaration) witnesses.set(node.name.text, checker.getTypeAtLocation(node.name))
      node.forEachChild(findWitnesses)
    }
    findWitnesses(program.getSourceFile(witnessFile))
    const registryType = witnesses.get('registry')
    const writable = [witnesses.get('anObject'), witnesses.get('aString')]
    const files: Array<string> = registryType.getProperties().map((property: any) => property.name)

    const nodes: Record<string, NodeReading> = {}
    const declaredAt = new Map<string, Type>()
    for (const entry of plan.files) {
      const declared = typeOfProperty(checker, registryType, entry.relativeFile)
      if (!declared) continue
      const members: Array<Type> = declared.flags & TypeFlags.Union ? declared.getTypes() : [declared]
      const byId = new Map(members.map((member) => [typeOfProperty(checker, member, 'id')?.value as string, member]))

      // TypeScript drops a byte-order mark before it parses, so its positions
      // start one code unit after the positions in the file on disk.
      const mark = entry.source.charCodeAt(0) === 0xfeff ? 1 : 0
      const expressions = new Map<string, Node>()
      const sourceFile = program.getSourceFile(entry.file)
      const collect = (node: Node) => {
        expressions.set(`${SyntaxKind[node.kind]}:${node.getStart(sourceFile) + mark}:${node.end + mark}`, node)
        node.forEachChild(collect)
      }
      collect(sourceFile)

      for (const node of entry.nodes) {
        const member = byId.get(node.id)
        if (!member) continue
        const expression = expressions.get(`${node.kind}:${node.start}:${node.end}`)
        const descriptor: NodeReading['descriptor'] = {}
        for (const field of ['kind', 'inFunction', 'nth', 'callee', 'operator']) {
          descriptor[field] = literalOf(checker, member, field)
        }
        const reason = typeOfProperty(checker, member, '__unportable')
        const originals = new Map(node.captures.map((name) => [name, localTypeAt(checker, expression, name)]))
        const locals: Record<string, Fit> = {}
        for (const property of typeOfProperty(checker, member, 'locals')!.getProperties()) {
          const original = originals.get(property.name)
          const local = checker.getTypeOfSymbol(property)
          declaredAt.set(`${node.id}|${property.name}`, local)
          locals[property.name] = original ? fitOf(checker, local, original.type, rootKey) : 'not assignable'
        }
        const unportableLocals: Record<string, string> = {}
        for (const property of typeOfProperty(checker, member, '__unportableLocals')?.getProperties() ?? []) {
          const reasonOfLocal = checker.getTypeOfSymbol(property)
          unportableLocals[property.name] = reasonOfLocal.flags & TypeFlags.StringLiteral ? String(reasonOfLocal.value) : ''
        }
        const result = typeOfProperty(checker, member, 'result')!
        const original = checker.getTypeAtLocation(expression)
        declaredAt.set(node.id, result)
        nodes[node.id] = {
          descriptor,
          unportable: reason ? String(reason.value) : null,
          result: reason ? null : fitOf(checker, result, original, rootKey),
          opaque: reason
            ? !(result.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Never)) &&
              // An expression TypeScript has no type for is `any`, which passes for everything.
              [original, ...writable].every((source) => Boolean(source.flags & TypeFlags.Any) || !checker.isTypeAssignableTo(source, result))
            : null,
          acceptsOriginal: checker.isTypeAssignableTo(original, result),
          resultMembers: reason
            ? null
            : result
                .getProperties()
                .filter((property: any) => !String(property.escapedName).startsWith('__@'))
                .map((property: any) => property.name)
                .sort(),
          locals,
          mentioned: node.captures.filter((name) => originals.get(name)?.mentioned),
          unportableLocals,
        }
      }
    }
    const relations = (options.relations ?? []).map(([from, to]) => {
      const source = declaredAt.get(from)
      const target = declaredAt.get(to)
      return Boolean(source && target && checker.isTypeAssignableTo(source, target))
    })
    let copies = 0
    let keyConstants = 0
    for (const statement of program.getSourceFile(registryFile)?.statements ?? []) {
      if (statement.kind === SyntaxKind.InterfaceDeclaration && statement.name.text.startsWith('__EP_')) copies += 1
      if (statement.kind === SyntaxKind.VariableStatement && statement.declarationList.declarations[0].name.text.startsWith('__ep_key_')) {
        keyConstants += 1
      }
    }
    return { reading: { registryErrors, projectErrors, files: files.sort(), copies, keyConstants, nodes }, extraErrors, relations }
  } finally {
    snapshot.dispose()
  }
}

export interface ProjectRegistry extends CompiledRegistry {
  plan: Plan
  text: string
}

/** Plan the targets, generate the registry with production, and compile it. */
export function generateAndCompile(
  api: API,
  root: string,
  targets: ReadonlyArray<string>,
  options: ReadOptions & { cache?: Record<string, unknown> } = {},
): ProjectRegistry {
  const plan = buildTargetPlan({ root, targets, api }) as Plan
  const { text } = generateFileRegistryModule(plan, {
    fromFile: join(root, 'points.ep'),
    api,
    cache: options.cache,
  })
  return { plan, text, ...compileRegistry(api, root, text, plan, options) }
}

