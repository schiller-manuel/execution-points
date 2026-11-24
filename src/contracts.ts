import { existsSync, readFileSync } from 'node:fs'
import MagicString from 'magic-string'
import {
  type API,
  type Checker,
  ElementFlags,
  NodeBuilderFlags,
  ObjectFlags,
  type ObjectType,
  type Program,
  type Signature,
  type Snapshot,
  type Symbol as TypeSymbol,
  SymbolFlags,
  type Type,
  TypeFlags,
  type UnionOrIntersectionType,
} from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { type Node, type SourceFile, SyntaxKind } from 'typescript/ast'
import type { IndexedFile, IndexedNode, TargetPlan } from './discovery.ts'

/**
 * A syntax node as this module reads it. It asks nodes of several kinds for the same few
 * fields, and a node of a kind that lacks one answers `undefined`.
 */
interface Syntax extends Node {
  readonly parent: Syntax
  forEachChild<T>(visitor: (node: Syntax) => T): T | undefined
  readonly name?: Syntax
  readonly text?: string
  readonly expression?: Syntax
  readonly initializer?: Syntax
  readonly questionToken?: Syntax
  readonly modifiers?: readonly Syntax[]
  readonly properties?: readonly Syntax[]
}

/** What the registries of one manifest share: the declarations made so far, and what is known about each module's exports. */
interface Shared {
  /** The registry's own declarations, in the order they were made, each under the identity it was made for. */
  readonly log: Array<{ readonly id: string; readonly text: string }>
  /** The name a copy was declared under, by identity; or the reason it could not be declared. */
  readonly helpers: Map<string, string | Error>
  /** For each module, the export-anchored path to each private type its exports reach. */
  readonly exportPaths: Map<string, Map<string, string>>
  counter: number
}

/** The TypeScript program of the last call, kept and brought up to date between calls. */
export interface RegistryCache {
  key?: string
  snapshot?: Snapshot
  programId?: Program['id']
  sources?: Map<string, string>
  inputs?: Map<string, string | undefined>
}

/** The registry module for a manifest. */
export interface GeneratedRegistry {
  readonly text: string
  /** Where each file's nodes are in `text`. */
  readonly spans: Array<{ readonly file: string; readonly start: number; readonly end: number }>
  /** The files of the project that the result was read from. */
  readonly inputs: string[]
}

/** A node of the plan with what the registry says about it. */
interface EmittedNode extends IndexedNode {
  result: string
  unportableReason?: string
  readonly locals: Record<string, string>
  readonly unportableLocals: Record<string, string>
  isStatement: boolean
}

const localScopes = new Set([
  SyntaxKind.Block,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
])
/** Symbols whose declaration gives a type a name of its own. */
const declaredFlags =
  SymbolFlags.Interface |
  SymbolFlags.Class |
  SymbolFlags.Enum |
  SymbolFlags.EnumMember |
  SymbolFlags.TypeAlias |
  SymbolFlags.Module
const writeFlags = NodeBuilderFlags.NoTruncation | NodeBuilderFlags.WriteArrayAsGenericType
/** The leading name of a printed type: `typeof`, an `import("...")`, and a dotted path. */
const leadingName = /^(?:typeof )?(?:import\("(?:[^"\\]|\\.)*"\))?[\p{ID_Continue}$.]*/u

function walk(node: Syntax, visit: (node: Syntax) => void): void {
  visit(node)
  node.forEachChild((child) => { walk(child, visit) })
}

/** Insert a prefix before and a suffix after every node. `nodes` are in source order, outer before inner. */
function projectNested<Item extends { readonly start: number; readonly end: number }>(
  source: string,
  nodes: readonly Item[],
  prefixOf: (node: Item) => string,
  suffixOf: (node: Item) => string,
): string {
  const out = new MagicString(source)
  for (const node of nodes.toReversed()) out.appendLeft(node.end, suffixOf(node))
  for (const node of nodes) out.appendLeft(node.start, prefixOf(node))
  return out.toString()
}

const isInsideLocalScope = (node: Syntax): boolean =>
  Boolean(node.parent) && (localScopes.has(node.parent.kind) || isInsideLocalScope(node.parent))

/** The syntax node a declaration handle stands for. */
const declarationOf = (handle: TypeSymbol['declarations'][number]): Syntax => handle.resolve() as unknown as Syntax

/** Declared inside a function or block: no name outside that scope reaches it. */
const hasLocalDeclaration = (sym: TypeSymbol): boolean => sym.declarations.some((h) => isInsideLocalScope(declarationOf(h)))

const isPrivateDeclaration = (d: Syntax): boolean =>
  d.name!.kind === SyntaxKind.PrivateIdentifier ||
  Boolean(d.modifiers?.some((m) => m.kind === SyntaxKind.PrivateKeyword || m.kind === SyntaxKind.ProtectedKeyword))

const isPrivateMember = (prop: TypeSymbol): boolean => prop.declarations.some((h) => isPrivateDeclaration(declarationOf(h)))

/** Enums, and classes with private or protected members, are assignable only from themselves. */
function isNominalUnexported(sym: TypeSymbol, type: Type): boolean {
  return Boolean(sym.flags & SymbolFlags.Enum) || (Boolean(sym.flags & SymbolFlags.Class) && type.getProperties().some(isPrivateMember))
}

/**
 * Export-anchored paths to the private types that a module's exported values
 * reach, shallowest first: `ReturnType<typeof import("./app").work>`.
 */
function buildExportIndex(
  checker: Checker,
  moduleSymbol: TypeSymbol,
  moduleRef: string,
  identify: (sym: TypeSymbol) => string,
): Map<string, string> {
  const file = moduleSymbol.declarations[0]!.path
  const declaredHere = (sym: TypeSymbol): boolean => sym.declarations.some((h) => h.path === file)
  const paths = new Map<string, string>()
  const queue: Array<{ readonly type: Type; readonly expr: string; readonly depth: number }> = []
  const seen = new Set<number>()
  const enqueue = (type: Type, expr: string, depth: number): void => {
    if (depth <= 4 && !seen.has(type.id)) { seen.add(type.id); queue.push({ type, expr, depth }) }
  }

  // An export that is only a type has no value type, and the walk finds nothing in it.
  for (const exported of checker.getExportsOfModule(moduleSymbol)) enqueue(checker.getTypeOfSymbol(exported), `${moduleRef}.${exported.name}`, 0)

  for (const { type, expr, depth } of queue) {
    const alias = type.getAliasSymbol()
    const sym = type.getSymbol()
    const args = type.isTypeReference() ? checker.getTypeArguments(type) : []
    // Each type is visited once, at its shallowest, so each name gets one path.
    if (alias && !type.getAliasTypeArguments().length && declaredHere(alias)) paths.set(identify(alias), expr)
    if (sym && (sym.flags & declaredFlags || type.flags & TypeFlags.UniqueESSymbol) && declaredHere(sym) && !args.length) paths.set(identify(sym), expr)

    if (type.flags & TypeFlags.Union) {
      const defined = (type as UnionOrIntersectionType).getTypes().filter((m) => !(m.flags & (TypeFlags.Null | TypeFlags.Undefined)))
      if (defined.length === 1) enqueue(defined[0]!, `NonNullable<${expr}>`, depth + 1)
      continue
    }
    if (args.length === 1 && sym?.name === 'Promise') {
      enqueue(args[0]!, `Awaited<${expr}>`, depth + 1)
      continue
    }
    if (args.length === 1 && checker.isArrayLikeType(type)) {
      enqueue(args[0]!, `(${expr})[number]`, depth + 1)
      continue
    }
    const signatures = type.getCallSignatures()
    if (signatures.length === 1 && !signatures[0]!.getTypeParameters().length) {
      const signature = signatures[0]!
      enqueue(signature.getReturnType(), `ReturnType<${expr}>`, depth + 1)
      signature.getParameters().forEach((_, i) => enqueue(checker.getParameterType(signature, i), `Parameters<${expr}>[${i}]`, depth + 1))
    }
    if (type.isObjectType() && sym && declaredHere(sym)) {
      const props = type.getProperties()
      if (props.length <= 24) {
        for (const prop of props) {
          if (!String(prop.escapedName).startsWith('__@')) {
            enqueue(checker.getTypeOfSymbol(prop), `(${expr})[${JSON.stringify(prop.name)}]`, depth + 1)
          }
        }
      }
    }
  }
  return paths
}

/**
 * Writes a type as text for the registry file. A name is emitted only when it
 * means, where the registry is compiled, the type it means in the target:
 * `anchor` is a source file at the registry's place in the same program, and
 * every name is either TypeScript's own way to reach the type from there or
 * one the registry declares itself.
 */
function createTypeEmitter(api: API, checker: Checker, anchor: SourceFile, shared: Shared): { emit(type: Type, loc: Node): string } {
  // Type ids belong to one program, and the registry is read from two.
  const scope = ++shared.counter
  const known = new Map<string, { readonly name?: string; readonly identity?: string }>()

  /** A private type's identity in every program of the project: a probe file shifts positions, not names. */
  const identify = (sym: TypeSymbol): string => `${sym.declarations[0]!.path}:${checker.getFullyQualifiedName(sym)}`

  const write = (type: Type): string => {
    const node = checker.typeToTypeNode(type, anchor, writeFlags)
    return node ? leadingName.exec(api.printer.printNode(node))![0] : ''
  }

  /** Whether a name with no `import(...)` in it resolves, from the registry file, to what it should. */
  const resolvesFromRegistry = (name: string, sym: TypeSymbol, type: Type): boolean => {
    const [head, ...rest] = name.replace(/^typeof /, '').split('.') as [string, ...string[]]
    if (name.startsWith('typeof ')) {
      let found = checker.resolveName(head, SymbolFlags.Value, anchor)
      let valueType = found && checker.getTypeOfSymbol(found)
      for (const part of rest) {
        found = valueType && checker.getPropertyOfType(valueType, part)
        valueType = found && checker.getTypeOfSymbol(found)
      }
      return valueType?.id === type.id
    }
    let found = checker.resolveName(head, rest.length ? SymbolFlags.Namespace : SymbolFlags.Type, anchor)
    for (const part of rest) found = found && checker.getMemberInModuleExports(found, part)
    return found?.id === sym.id
  }

  /** The export-anchored path to a private type, from the module that declares it. */
  const exportPath = (sym: TypeSymbol, identity: string): string | undefined => {
    const file = sym.declarations[0]!.path
    if (!shared.exportPaths.has(file)) {
      const moduleSymbol = checker.getSymbolOfSourceFile(file)
      const moduleRef = moduleSymbol && write(checker.getTypeOfSymbol(moduleSymbol))
      shared.exportPaths.set(file, moduleRef ? buildExportIndex(checker, moduleSymbol!, moduleRef, identify) : new Map())
    }
    return shared.exportPaths.get(file)!.get(identity)
  }

  /**
   * How the registry refers to the type `sym` declares, worked out once per
   * symbol: TypeScript's own name when the registry can use it, else an
   * export-anchored path, else nothing but the identity a copy is filed under.
   */
  const describe = (sym: TypeSymbol, type: Type, valueSide: boolean): { readonly name?: string; readonly identity?: string } => {
    const key = `${sym.id}:${valueSide}`
    if (!known.has(key)) {
      const subject = type.flags & TypeFlags.UniqueESSymbol ? type : valueSide ? checker.getTypeOfSymbol(sym) : checker.getDeclaredTypeOfSymbol(sym)
      const name = write(subject)
      if (name && (name.includes('import(') || resolvesFromRegistry(name, sym, subject))) {
        known.set(key, { name })
      } else {
        const identity = identify(sym)
        known.set(key, { identity, name: valueSide ? undefined : exportPath(sym, identity) })
      }
    }
    return known.get(key)!
  }

  const list = (types: readonly Type[], loc: Node, seen: Set<number>): string[] => types.map((item) => emit(item, loc, new Set(seen)))

  // A generic signature fails where its type parameter is written.
  function emitSig(sig: Signature, loc: Node, seen: Set<number>, prefix: string, arrow: string): string {
    const parameters = sig.getParameters()
    const params = parameters.map((p, i) => {
      const declaration = declarationOf(p.valueDeclaration!)
      if (sig.hasRestParameter && i === parameters.length - 1) return `...${p.name}: ${emit(checker.getTypeOfSymbol(p), loc, new Set(seen))}`
      const optional = declaration.questionToken || declaration.initializer ? '?' : ''
      return `${p.name}${optional}: ${emit(checker.getParameterType(sig, i), loc, new Set(seen))}`
    })
    return `${prefix}(${params.join(', ')})${arrow}${emit(sig.getReturnType(), loc, new Set(seen))}`
  }

  /** A member's key. A symbol key needs a constant of that symbol's type to compute it from. */
  function keyOf(prop: TypeSymbol, loc: Node): string {
    if (!String(prop.escapedName).startsWith('__@')) return JSON.stringify(prop.name)
    const computed = prop.declarations.map((h) => declarationOf(h).name!).find((name) => name.kind === SyntaxKind.ComputedPropertyName)
    if (!computed) throw new Error(`No declaration names the symbol that keys the member ${checker.symbolToString(prop)}.`)
    const keyType = checker.getTypeAtLocation(computed.expression!)
    const key = reference(keyType.getSymbol()!, keyType, false, [], loc, new Set())
    if (!key) throw new Error(`The symbol that keys the member ${checker.symbolToString(prop)} is not exported.`)
    const id = `key:${key}`
    if (!shared.helpers.has(id)) {
      const constant = `__ep_key_${++shared.counter}`
      shared.helpers.set(id, `[${constant}]`)
      shared.log.push({ id, text: `declare const ${constant}: ${key};` })
    }
    return shared.helpers.get(id) as string
  }

  function emitMembers(type: Type, loc: Node, seen: Set<number>): string[] {
    const props = type.getProperties().filter((p) => !isPrivateMember(p))
    if (props.length > 24) throw new Error('Object type has too many properties to inline in a virtual contract.')
    return [
      ...type.getCallSignatures().map((sig) => `${emitSig(sig, loc, seen, '', ': ')};`),
      ...type.getConstructSignatures().map((sig) => `${emitSig(sig, loc, seen, 'new ', ': ')};`),
      ...type.getIndexInfos().map(
        (info) => `${info.isReadonly ? 'readonly ' : ''}[key: ${emit(info.keyType, loc, new Set(seen))}]: ${emit(info.valueType, loc, new Set(seen))};`,
      ),
      ...props.map(
        (prop) =>
          `${checker.isReadonlySymbol(prop) ? 'readonly ' : ''}${keyOf(prop, loc)}${prop.flags & SymbolFlags.Optional ? '?' : ''}: ` +
          `${emit(checker.getNonMissingTypeOfSymbol(prop), loc, new Set(seen))};`,
      ),
    ]
  }

  /**
   * Declare a copy of a type no name reaches, once per type. The name is
   * reserved while the body is built, so a type may refer to itself; when the
   * body cannot be built, the name and everything declared for it are taken
   * back, and later uses fail the same way instead of naming nothing.
   */
  function emitHelper(id: string, baseName: string, type: Type, loc: Node, nominal: boolean): string {
    const declared = shared.helpers.get(id)
    if (declared instanceof Error) throw declared
    if (declared) return declared
    const mark = shared.log.length
    const index = ++shared.counter
    const name = `__EP_${baseName}_${index}`
    shared.helpers.set(id, name)
    try {
      const members = type.isObjectType() ? emitMembers(type, loc, new Set([type.id])) : []
      const brand = `__ep_brand_${index}`
      shared.log.push({
        id,
        text: nominal
          ? `declare const ${brand}: unique symbol;\ninterface ${name} {\n  readonly [${brand}]: never;\n  ${members.join('\n  ')}\n}`
          : `interface ${name} {\n  ${members.join('\n  ')}\n}`,
      })
      return name
    } catch (error) {
      for (const undone of shared.log.splice(mark)) shared.helpers.delete(undone.id)
      shared.helpers.set(id, error as Error)
      throw error
    }
  }

  /** A name or an export-anchored path for the type `sym` declares, with its type arguments. */
  function reference(sym: TypeSymbol, type: Type, valueSide: boolean, args: readonly Type[], loc: Node, seen: Set<number>): string | undefined {
    const { name } = describe(sym, type, valueSide)
    return name && (args.length ? `${name}<${list(args, loc, seen).join(', ')}>` : name)
  }

  function emit(type: Type, loc: Node, seen = new Set<number>()): string {
    if (type.isErrorType()) throw new Error('TypeScript could not determine this type.')
    if (type.isIntrinsicType()) return type.intrinsicName
    if (!(type.flags & TypeFlags.EnumLiteral)) {
      if (type.isStringLiteralType() || type.isNumberLiteralType() || type.isBooleanLiteralType()) return JSON.stringify(type.value)
      if (type.isBigIntLiteralType()) return `${type.value}n`
    }
    if (type.isTemplateLiteralType()) {
      const spans = list(type.getTypes(), loc, seen)
      return `\`${type.texts.map((text, i) => `${i ? `\${${spans[i - 1]}}` : ''}${text.replace(/[`\\]|\$\{/g, '\\$&')}`).join('')}\``
    }
    if (type.isStringMappingType()) return `${type.getSymbol()!.name}<${emit(type.getTarget(), loc, seen)}>`
    if (type.flags & TypeFlags.Union && !(type.flags & TypeFlags.EnumLiteral)) {
      return `(${list((type as UnionOrIntersectionType).getTypes(), loc, seen).join(' | ')})`
    }
    if (type.flags & TypeFlags.Intersection) return `(${list((type as UnionOrIntersectionType).getTypes(), loc, seen).join(' & ')})`

    if (type.isTupleType()) {
      const target = type.getTarget()
      const elements = checker.getTypeArguments(type).map((element, i) => {
        const flag = target.elementFlags[i]!
        if (flag & ElementFlags.Rest) return `...${emit(element, loc, new Set(seen))}[]`
        if (!(flag & ElementFlags.Optional)) return emit(element, loc, new Set(seen))
        // An optional element reads as `T | undefined`; written back, the `?` stands for the `undefined`.
        const defined = element.flags & TypeFlags.Union ? (element as UnionOrIntersectionType).getTypes().filter((m) => !(m.flags & TypeFlags.Undefined)) : []
        return `${emit(defined.length === 1 ? defined[0]! : element, loc, new Set(seen))}?`
      })
      return `${target.readonly ? 'readonly ' : ''}[${elements.join(', ')}]`
    }

    const own = type.getSymbol()
    const declared = own && (own.flags & declaredFlags || type.flags & TypeFlags.UniqueESSymbol) ? own : undefined
    const sym = declared ?? type.getAliasSymbol()
    if (sym) {
      if (hasLocalDeclaration(sym)) throw new Error(`The type ${sym.name} is declared inside a function or block and cannot be exposed safely.`)
      // The static side of a class, an enum object, or a namespace: `typeof X`, never the instance type.
      const valueSide = Boolean(declared && (type as ObjectType).objectFlags & ObjectFlags.Anonymous)
      const args = !declared ? type.getAliasTypeArguments() : type.isTypeReference() ? checker.getTypeArguments(type) : []
      const named = reference(sym, type, valueSide, args, loc, seen)
      if (named) return named
      if (sym.flags & SymbolFlags.EnumMember) throw new Error(`The enum member ${checker.typeToString(type)} belongs to an enum that is not exported.`)
      if (!valueSide) {
        // One copy for each instantiation of a private type.
        const nominal = Boolean(declared) && (Boolean(type.flags & TypeFlags.UniqueESSymbol) || isNominalUnexported(sym, type))
        const { identity } = describe(sym, type, valueSide)
        return emitHelper(args.length ? `${identity}<${list(args, loc, seen).join(', ')}>` : identity!, sym.name, type, loc, nominal)
      }
    }

    if (type.isObjectType()) {
      if (seen.has(type.id)) return emitHelper(`rec:${scope}:${type.id}`, 'Anon', type, loc, false)
      seen.add(type.id)
      return `{ ${emitMembers(type, loc, seen).join(' ')} }`
    }
    // A type parameter, or a type computed from one, means something only inside its generic scope.
    throw new Error(`The type ${checker.typeToString(type)} cannot be written outside its declaration.`)
  }

  return { emit }
}

const readFile = (file: string): string | undefined => { try { return readFileSync(file, 'utf8') } catch { return undefined } }
/** TypeScript drops a byte-order mark when it reads a file, so text handed to it must not carry one. */
const withoutMark = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/**
 * The TypeScript program the registry is read from: the project's own files
 * (from its tsconfig), the targets, and an empty module at the registry's
 * place. With a `cache`, the program of the last call is kept and brought up
 * to date with the disk.
 */
function openAnalysis(
  plan: TargetPlan,
  registryFile: string,
  api: API,
  cache: RegistryCache | undefined,
): { snapshot: Snapshot; program: Program; anchorFile: string; inputs: string[] } {
  const anchorFile = `${registryFile}.ts`
  const config = existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
  const compilerOptions = config?.options ?? {}
  // The targets are handed over as the plan read them, so that its positions hold.
  const supplied = new Map<string, string>([[anchorFile, 'export {}\n'], ...plan.files.map((entry): [string, string] => [entry.file, withoutMark(entry.source)])])
  const rootFiles = [...new Set([...supplied.keys(), ...(config?.fileNames ?? [])])].sort()
  const key = JSON.stringify({ rootFiles, compilerOptions })

  let snapshot: Snapshot
  let programId: Program['id']
  if (cache?.key === key) {
    const changed = [...supplied].filter(([file, text]) => cache.sources!.get(file) !== text)
    if (changed.length || [...cache.inputs!].some(([file, text]) => readFile(file) !== text)) {
      const next = cache.snapshot!.update({
        fileSystem: createFileSystemLayer(changed),
        fileNotifications: { invalidateAll: true },
        ensurePrograms: [cache.programId!],
      })
      cache.snapshot!.dispose()
      cache.snapshot = next
    }
    snapshot = cache.snapshot!
    programId = cache.programId!
  } else {
    cache?.snapshot?.dispose()
    const created = api.createSnapshot({ fileSystem: createFileSystemLayer([...supplied]), createPrograms: [{ rootFiles, compilerOptions }] })
    snapshot = created
    programId = created.operation.createdPrograms[0].id
  }
  const program = snapshot.getProgram(programId)!
  // Every file of the project that the program read from disk can change the registry.
  const inputs = program.getSourceFileNames().filter((file) => !file.includes('/node_modules/') && file !== anchorFile)
  if (cache) Object.assign(cache, { key, snapshot, programId, sources: supplied, inputs: new Map(inputs.map((file) => [file, readFile(file)])) })
  return { snapshot, program, anchorFile, inputs }
}

/**
 * Analyze all target files in a plan and generate the virtual
 * `declare module 'execution-points-prototype'` ExecutionPointFileRegistry
 * for the manifest `fromFile`. Returns its `text`, where each file's nodes are
 * in the text (`spans`), and the files the result was read from (`inputs`).
 */
export function generateFileRegistryModule(
  plan: TargetPlan,
  { fromFile, api, cache }: { readonly fromFile: string; readonly api: API; readonly cache?: RegistryCache },
): GeneratedRegistry {
  if (!plan.files.length) return { ...renderFileModule([], []), inputs: [] }

  const { snapshot, program, anchorFile, inputs } = openAnalysis(plan, fromFile, api, cache)
  try {
    const checker = program.getProject().checker
    const shared: Shared = { log: [], helpers: new Map(), exportPaths: new Map(), counter: 0 }
    const emitter = createTypeEmitter(api, checker, program.getSourceFile(anchorFile)!, shared)

    // Phase 1: result types, read from the unchanged targets.
    const files: Array<{ readonly entry: IndexedFile; readonly nodes: EmittedNode[]; readonly probed: EmittedNode[] }> = []
    for (const entry of plan.files) {
      // A global script, or a file TypeScript does not load at all, has no place in the registry.
      const sf = program.getSourceFile(entry.file)
      if (!sf?.externalModuleIndicator || !entry.nodes.length) continue

      // The plan counts a byte-order mark; the program's text does not have it.
      const mark = entry.source.length - withoutMark(entry.source).length
      const bySpan = new Map<string, Syntax>()
      walk(sf as unknown as Syntax, (astNode) => { bySpan.set(`${SyntaxKind[astNode.kind]}:${astNode.getStart(sf) + mark}:${astNode.end + mark}`, astNode) })
      const expressions = entry.nodes.map((node) => bySpan.get(`${node.kind}:${node.start}:${node.end}`)!)
      const types = checker.getTypeAtLocation(expressions)

      const nodes = entry.nodes.map((node, i) => {
        const expression = expressions[i]!
        // The result and whether it is a statement are filled in below.
        const emitted = { ...node, locals: {}, unportableLocals: {} } as EmittedNode
        try {
          emitted.result = emitter.emit(types[i]!, expression)
        } catch (error) {
          // The expression stays in the registry, so that compile-time match counts equal the runtime's.
          // Its type cannot be written, so it gets one of its own that only original() produces.
          emitted.unportableReason = (error as Error).message
          emitted.result = `__EPOpaque<${JSON.stringify(node.id)}>`
        }
        // An assertion call narrows only as a statement of its own, so its probe must not wrap it.
        emitted.isStatement =
          expression.parent.kind === SyntaxKind.ExpressionStatement &&
          [SyntaxKind.Block, SyntaxKind.SourceFile, SyntaxKind.CaseClause, SyntaxKind.DefaultClause].includes(expression.parent.parent.kind)
        return emitted
      })
      files.push({ entry, nodes, probed: nodes.filter((node) => node.captures.length) })
    }

    // Phase 2: the narrowed type of each local, read from a copy of the target
    // that mentions every local right before the expression.
    const probes = files.map(({ entry, probed }): [string, string] => [
      entry.file,
      withoutMark(
        projectNested(
          entry.source,
          probed,
          (node) => {
            const mentions = `{ __execution_point_probe__: 0, ${node.captures.map((name) => `${JSON.stringify(name)}: ${name}`).join(', ')} }`
            return node.isStatement ? `void ${mentions}; ` : `(void ${mentions}, (`
          },
          (node) => (node.isStatement ? '' : '))'),
        ),
      ),
    ])
    const probeSnapshot = snapshot.update({ fileSystem: createFileSystemLayer(probes), ensurePrograms: [program.id] })
    try {
      const probeProgram = probeSnapshot.getProgram(program.id)!
      const probeChecker = probeProgram.getProject().checker
      const probeEmitter = createTypeEmitter(api, probeChecker, probeProgram.getSourceFile(anchorFile)!, shared)

      for (const { entry, probed } of files) {
        // The probes of a file appear in the order of its nodes.
        const mentions: Array<readonly Syntax[]> = []
        walk(probeProgram.getSourceFile(entry.file) as unknown as Syntax, (astNode) => {
          if (astNode.kind === SyntaxKind.ObjectLiteralExpression && astNode.properties![0]?.name?.text === '__execution_point_probe__') {
            mentions.push(astNode.properties!.slice(1))
          }
        })
        const types = probeChecker.getTypeAtLocation(mentions.flat().map((property) => property.initializer!))
        let next = 0
        probed.forEach((node, i) => {
          for (const property of mentions[i]!) {
            try {
              node.locals[property.name!.text!] = probeEmitter.emit(types[next]!, property.initializer!)
            } catch (error) {
              node.unportableLocals[property.name!.text!] = (error as Error).message
            }
            next += 1
          }
        })
      }
    } finally {
      probeSnapshot.dispose()
    }

    return { ...renderFileModule(shared.log.map((entry) => entry.text), files.map(({ entry, nodes }): [IndexedFile, EmittedNode[]] => [entry, nodes])), inputs }
  } finally {
    if (!cache) snapshot.dispose()
  }
}

const typeLiteral = (entries: ReadonlyArray<readonly [string, string]>): string =>
  `{ ${entries.map(([name, type]) => `readonly ${JSON.stringify(name)}: ${type};`).join(' ')} }`

function renderNode(node: EmittedNode): string {
  const fields = [
    `readonly id: ${JSON.stringify(node.id)};`,
    `readonly kind: ${JSON.stringify(node.kind)};`,
    `readonly inFunction: ${JSON.stringify(node.inFunction)};`,
    node.callee === undefined ? 'readonly callee?: undefined;' : `readonly callee: ${JSON.stringify(node.callee)};`,
    node.operator === undefined ? 'readonly operator?: undefined;' : `readonly operator: ${JSON.stringify(node.operator)};`,
    `readonly nth: ${node.nth};`,
  ]
  if (node.unportableReason) fields.push(`readonly __unportable: ${JSON.stringify(node.unportableReason)};`)
  fields.push(
    `readonly __unportableLocals: ${typeLiteral(Object.entries(node.unportableLocals).map(([name, reason]): [string, string] => [name, JSON.stringify(reason)]))};`,
    `readonly result: ${node.result};`,
    `readonly locals: ${typeLiteral(Object.entries(node.locals))}`,
  )
  return `  | { ${fields.join(' ')} }`
}

/**
 * The registry module. Each file's nodes are a type alias declared outside the
 * `declare module` block, where a global name cannot bind to one of the
 * library's own exports. `__EPOpaque<Id>` is the result type of an expression
 * whose own type cannot be written: a different type for every node id.
 */
function renderFileModule(
  declarations: readonly string[],
  files: ReadonlyArray<readonly [IndexedFile, readonly EmittedNode[]]>,
): Pick<GeneratedRegistry, 'text' | 'spans'> {
  let text =
    '// Virtual execution-points file schema (generated in memory by TypeScript 7.1 content mapper).\n' +
    "import type {} from 'execution-points-prototype';\n\n" +
    'declare const __ep_opaque: unique symbol;\n' +
    '/** Stands for a type that cannot be written outside its declaration. Only original() gives a value of it. */\n' +
    'interface __EPOpaque<Id extends string> {\n  readonly [__ep_opaque]: Id;\n}\n\n' +
    declarations.map((declaration) => `${declaration}\n\n`).join('')
  const spans = files.map(([entry, nodes], i) => {
    const start = text.length
    text += `type __EPFile${i} =\n${nodes.map(renderNode).join('\n')};\n`
    return { file: entry.file, start, end: text.length }
  })
  text +=
    "\ndeclare module 'execution-points-prototype' {\n  interface ExecutionPointFileRegistry {\n" +
    files.map(([entry], i) => `    ${JSON.stringify(entry.relativeFile)}: __EPFile${i};\n`).join('') +
    '  }\n}\n'
  return { text, spans }
}
