import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import MagicString from 'magic-string'
import { API, ElementFlags, NodeBuilderFlags, ObjectFlags, SymbolFlags, TypeFlags } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { SyntaxKind } from 'typescript/ast'

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

function walk(node, visit) {
  visit(node)
  node.forEachChild((child) => { walk(child, visit) })
}

/** Insert a prefix before and a suffix after every node. `nodes` are in source order, outer before inner. */
function projectNested(source, nodes, prefixOf, suffixOf) {
  const out = new MagicString(source)
  for (const node of nodes.toReversed()) out.appendLeft(node.end, suffixOf(node))
  for (const node of nodes) out.appendLeft(node.start, prefixOf(node))
  return out.toString()
}

const resolveAlias = (checker, sym) => (sym.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym)

function hasLocalDeclaration(sym) {
  return sym.declarations.some((h) => {
    for (let p = h.resolve().parent; p && p.kind !== SyntaxKind.SourceFile; p = p.parent) {
      if (localScopes.has(p.kind)) return true
    }
    return false
  })
}

const isPrivateDeclaration = (d) =>
  d.name?.kind === SyntaxKind.PrivateIdentifier ||
  Boolean(d.modifiers?.some((m) => m.kind === SyntaxKind.PrivateKeyword || m.kind === SyntaxKind.ProtectedKeyword))

const isPrivateMember = (prop) => prop.declarations.some((h) => isPrivateDeclaration(h.resolve()))

/** Enums, and classes with private or protected members, are assignable only from themselves. */
function isNominalUnexported(sym, type) {
  return Boolean(sym.flags & SymbolFlags.Enum) || (Boolean(sym.flags & SymbolFlags.Class) && type.getProperties().some(isPrivateMember))
}

/**
 * Export-anchored paths to the private types that a module's exported values
 * reach, shallowest first: `ReturnType<typeof import("./app").work>`.
 */
function buildExportIndex(checker, moduleSymbol, moduleRef, identify) {
  const file = moduleSymbol.declarations[0].path
  const declaredHere = (sym) => sym.declarations.some((h) => h.path === file)
  const paths = new Map()
  const queue = []
  const seen = new Set()
  const enqueue = (type, expr, depth) => {
    if (depth <= 4 && !seen.has(type.id)) { seen.add(type.id); queue.push({ type, expr, depth }) }
  }

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = resolveAlias(checker, exported)
    if (target.flags & SymbolFlags.Value) enqueue(checker.getTypeOfSymbol(target), `${moduleRef}.${exported.name}`, 0)
  }

  for (const { type, expr, depth } of queue) {
    const alias = type.getAliasSymbol()
    const sym = type.getSymbol()
    const args = type.isTypeReference() ? checker.getTypeArguments(type) : []
    const record = (named) => { const id = identify(named); if (!paths.has(id)) paths.set(id, expr) }
    if (alias && !type.getAliasTypeArguments().length && declaredHere(alias)) record(alias)
    if (sym && (sym.flags & declaredFlags || type.flags & TypeFlags.UniqueESSymbol) && declaredHere(sym) && !args.length) record(sym)

    if (type.flags & TypeFlags.Union) {
      const defined = type.getTypes().filter((m) => !(m.flags & (TypeFlags.Null | TypeFlags.Undefined)))
      if (defined.length === 1) enqueue(defined[0], `NonNullable<${expr}>`, depth + 1)
      continue
    }
    if (args.length === 1 && sym?.name === 'Promise') {
      enqueue(args[0], `Awaited<${expr}>`, depth + 1)
      continue
    }
    if (args.length === 1 && checker.isArrayLikeType(type)) {
      enqueue(args[0], `(${expr})[number]`, depth + 1)
      continue
    }
    const signatures = type.getCallSignatures()
    if (signatures.length === 1 && !signatures[0].getTypeParameters().length) {
      const [signature] = signatures
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
function createTypeEmitter(api, checker, anchor, shared) {
  const scope = ++shared.emitters
  const names = new Map()
  const identities = new Map()

  /** Stable across programs: a probe file shifts positions, not names. */
  const identify = (sym) => {
    if (!identities.has(sym.id)) identities.set(sym.id, `${sym.declarations[0].path}:${checker.getFullyQualifiedName(sym)}`)
    return identities.get(sym.id)
  }

  const write = (type) => {
    const node = checker.typeToTypeNode(type, anchor, writeFlags)
    return node ? leadingName.exec(api.printer.printNode(node))[0] : ''
  }

  /** Whether a name with no `import(...)` in it resolves, from the registry file, to what it should. */
  const resolvesFromRegistry = (name, sym, type) => {
    const [head, ...rest] = name.replace(/^typeof /, '').split('.')
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

  /** TypeScript's own name for the type that `sym` declares, when the registry can use it. */
  const nameOf = (sym, type, valueSide) => {
    const key = `${sym.id}:${valueSide}`
    if (!names.has(key)) {
      const subject = type.flags & TypeFlags.UniqueESSymbol ? type : valueSide ? checker.getTypeOfSymbol(sym) : checker.getDeclaredTypeOfSymbol(sym)
      const name = write(subject)
      names.set(key, name && (name.includes('import(') || resolvesFromRegistry(name, sym, subject)) ? name : undefined)
    }
    return names.get(key)
  }

  const exportPath = (sym) => {
    const id = identify(sym)
    for (const { path: file } of sym.declarations) {
      if (!shared.exportPaths.has(file)) {
        const moduleSymbol = checker.getSymbolOfSourceFile(file)
        const moduleRef = moduleSymbol && write(checker.getTypeOfSymbol(moduleSymbol))
        shared.exportPaths.set(file, moduleRef ? buildExportIndex(checker, moduleSymbol, moduleRef, identify) : new Map())
      }
      const found = shared.exportPaths.get(file).get(id)
      if (found) return found
    }
    return undefined
  }

  const list = (types, loc, seen) => types.map((item) => emit(item, loc, new Set(seen)))

  function emitSig(sig, loc, seen, prefix, arrow) {
    if (sig.getTypeParameters().length) throw new Error('Generic function-valued captures are not supported.')
    const parameters = sig.getParameters()
    const params = parameters.map((p, i) => {
      const declaration = p.valueDeclaration?.resolve()
      if (sig.hasRestParameter && i === parameters.length - 1) return `...${p.name}: ${emit(checker.getTypeOfSymbol(p), loc, new Set(seen))}`
      const optional = declaration?.questionToken || declaration?.initializer ? '?' : ''
      return `${p.name}${optional}: ${emit(checker.getParameterType(sig, i), loc, new Set(seen))}`
    })
    return `${prefix}(${params.join(', ')})${arrow}${emit(sig.getReturnType(), loc, new Set(seen))}`
  }

  /** A member's key. A symbol key needs a constant of that symbol's type to compute it from. */
  function keyOf(prop, loc) {
    if (!String(prop.escapedName).startsWith('__@')) return JSON.stringify(prop.name)
    const name = prop.declarations[0]?.resolve().name
    if (name?.kind !== SyntaxKind.ComputedPropertyName) throw new Error('A symbol-keyed member has no declaration that names its key.')
    const keyType = checker.getTypeAtLocation(name.expression)
    const key = reference(keyType.getSymbol(), keyType, false, [], loc, new Set())
    if (!key) throw new Error(`The symbol that keys the member ${checker.symbolToString(prop)} is not exported.`)
    const id = `key:${key}`
    if (!shared.helpers.has(id)) {
      const constant = `__ep_key_${++shared.counter}`
      shared.helpers.set(id, `[${constant}]`)
      shared.log.push({ id, text: `declare const ${constant}: ${key};` })
    }
    return shared.helpers.get(id)
  }

  function emitMembers(type, loc, seen) {
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
  function emitHelper(id, baseName, type, loc, nominal) {
    const known = shared.helpers.get(id)
    if (known instanceof Error) throw known
    if (known) return known
    const mark = shared.log.length
    const index = ++shared.counter
    const safe = baseName.replace(/[^A-Za-z0-9_]/g, '_')
    const name = `__EP_${safe}_${index}`
    const entry = { id, text: '' }
    shared.helpers.set(id, name)
    shared.log.push(entry)
    try {
      const members = type.isObjectType() ? emitMembers(type, loc, new Set([type.id])) : []
      const brand = `__ep_brand_${safe}_${index}`
      entry.text = nominal
        ? `declare const ${brand}: unique symbol;\ninterface ${name} {\n  readonly [${brand}]: never;\n  ${members.join('\n  ')}\n}`
        : `interface ${name} {\n  ${members.join('\n  ')}\n}`
      return name
    } catch (error) {
      for (const undone of shared.log.splice(mark)) shared.helpers.delete(undone.id)
      shared.helpers.set(id, error)
      throw error
    }
  }

  /** A name or an export-anchored path for the type `sym` declares, with its type arguments. */
  function reference(sym, type, valueSide, args, loc, seen) {
    const name = nameOf(sym, type, valueSide) ?? (valueSide || args.length ? undefined : exportPath(sym))
    return name && (args.length ? `${name}<${list(args, loc, seen).join(', ')}>` : name)
  }

  function emit(type, loc, seen = new Set()) {
    if (type.isErrorType()) throw new Error('TypeScript could not determine this type.')
    if (type.isTypeParameter()) throw new Error(`The type parameter ${checker.typeToString(type)} is local to a generic scope.`)
    if (type.isIntrinsicType()) return type.intrinsicName
    if (!(type.flags & TypeFlags.EnumLiteral)) {
      if (type.isStringLiteralType() || type.isNumberLiteralType() || type.isBooleanLiteralType()) return JSON.stringify(type.value)
      if (type.isBigIntLiteralType()) return `${type.value}n`
    }
    if (type.isTemplateLiteralType()) {
      const spans = list(type.getTypes(), loc, seen)
      return `\`${type.texts.map((text, i) => `${i ? `\${${spans[i - 1]}}` : ''}${text.replace(/[`\\]|\$\{/g, '\\$&')}`).join('')}\``
    }
    if (type.isStringMappingType()) return `${type.getSymbol().name}<${emit(type.getTarget(), loc, seen)}>`
    if (type.flags & TypeFlags.Union && !(type.flags & TypeFlags.EnumLiteral)) return `(${list(type.getTypes(), loc, seen).join(' | ')})`
    if (type.flags & TypeFlags.Intersection) return `(${list(type.getTypes(), loc, seen).join(' & ')})`

    if (type.isTupleType()) {
      const target = type.getTarget()
      const elements = checker.getTypeArguments(type).map((element, i) => {
        const flag = target.elementFlags[i]
        if (flag & ElementFlags.Rest) return `...${emit(element, loc, new Set(seen))}[]`
        if (!(flag & ElementFlags.Optional)) return emit(element, loc, new Set(seen))
        // An optional element reads as `T | undefined`; written back, the `?` stands for the `undefined`.
        const defined = element.flags & TypeFlags.Union ? element.getTypes().filter((m) => !(m.flags & TypeFlags.Undefined)) : []
        return `${emit(defined.length === 1 ? defined[0] : element, loc, new Set(seen))}?`
      })
      return `${target.readonly ? 'readonly ' : ''}[${elements.join(', ')}]`
    }

    const own = type.getSymbol()
    const declared = own && (own.flags & declaredFlags || type.flags & TypeFlags.UniqueESSymbol) ? own : undefined
    const sym = declared ?? type.getAliasSymbol()
    if (sym) {
      if (hasLocalDeclaration(sym)) throw new Error(`The type ${sym.name} is declared inside a function or block and cannot be exposed safely.`)
      // The static side of a class, an enum object, or a namespace: `typeof X`, never the instance type.
      const valueSide = Boolean(declared && type.objectFlags & ObjectFlags.Anonymous)
      const args = !declared ? type.getAliasTypeArguments() : type.isTypeReference() ? checker.getTypeArguments(type) : []
      const named = reference(sym, type, valueSide, args, loc, seen)
      if (named) return named
      if (sym.flags & SymbolFlags.EnumMember) throw new Error(`The enum member ${checker.symbolToString(sym)} belongs to an enum that is not exported.`)
      const nominal = Boolean(declared) && (Boolean(type.flags & TypeFlags.UniqueESSymbol) || isNominalUnexported(sym, type))
      if (!valueSide && (nominal || !args.length)) return emitHelper(identify(sym), sym.name, type, loc, nominal)
    }

    if (type.isObjectType()) {
      if (seen.has(type.id)) return emitHelper(`rec:${scope}:${type.id}`, 'Anon', type, loc, false)
      seen.add(type.id)
      return `{ ${emitMembers(type, loc, seen).join(' ')} }`
    }
    throw new Error(`The type ${checker.typeToString(type)} cannot be written outside its declaration.`)
  }

  return { emit }
}

/** The result type of an expression whose own type cannot be written: a different type for every node id. */
const OPAQUE =
  'declare const __ep_opaque: unique symbol;\n' +
  '/** Stands for a type that cannot be written outside its declaration. Only original() gives a value of it. */\n' +
  'interface __EPOpaque<Id extends string> {\n  readonly [__ep_opaque]: Id;\n}'

let defaultApi
const getDefaultApi = () => (defaultApi ??= new API())
const readFile = (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } }
/** TypeScript drops a byte-order mark when it reads a file, so text handed to it must not carry one. */
const withoutMark = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/**
 * The TypeScript program the registry is read from: the project's own files
 * (from its tsconfig, without content-mapped `.ep` files), the targets, and an
 * empty module at the registry's place. With a `cache`, the program of the
 * last call is kept and brought up to date with the disk.
 */
function openAnalysis(plan, registryFile, api, cache, overrides) {
  const anchorFile = `${registryFile}.ts`
  const config = existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
  const compilerOptions = { strict: true, ...config?.options }
  const supplied = new Map([[anchorFile, 'export {}\n']])
  for (const entry of plan.files) supplied.set(entry.file, withoutMark(entry.source))
  for (const [file, text] of overrides) if (!file.endsWith('.ep')) supplied.set(file, withoutMark(text))
  const rootFiles = [...new Set([...supplied.keys(), ...(config?.fileNames ?? []).filter((file) => !file.endsWith('.ep'))])].sort()
  const key = JSON.stringify({ rootFiles, compilerOptions })

  let snapshot
  let programId
  if (cache?.key === key) {
    const changed = [...supplied].filter(([file, text]) => cache.sources.get(file) !== text)
    if (changed.length || [...cache.inputs].some(([file, text]) => readFile(file) !== text)) {
      const next = cache.snapshot.update({
        fileSystem: createFileSystemLayer(changed),
        fileNotifications: { invalidateAll: true },
        ensurePrograms: [cache.programId],
      })
      cache.snapshot.dispose()
      cache.snapshot = next
    }
    snapshot = cache.snapshot
    programId = cache.programId
  } else {
    cache?.snapshot?.dispose()
    snapshot = api.createSnapshot({ fileSystem: createFileSystemLayer([...supplied]), createPrograms: [{ rootFiles, compilerOptions }] })
    programId = snapshot.operation.createdPrograms[0].id
  }
  const program = snapshot.getProgram(programId)
  // Every file of the project that the program read from disk can change the registry.
  const inputs = program.getSourceFileNames().filter((file) => !file.includes('/node_modules/') && file !== anchorFile)
  if (cache) {
    Object.assign(cache, {
      key,
      snapshot,
      programId,
      sources: supplied,
      inputs: new Map(inputs.filter((file) => !supplied.has(file)).map((file) => [file, readFile(file)])),
    })
  }
  return { snapshot, program, anchorFile, inputs }
}

/**
 * Analyze all target files in a plan and generate the virtual
 * `declare module 'execution-points-prototype'` ExecutionPointFileRegistry.
 * Returns its `text`, the registry keys in `files`, where each file's nodes
 * are in the text (`spans`), and the files the result was read from (`inputs`).
 */
export function generateFileRegistryModule(plan, { fromFile, api = getDefaultApi(), cache, overrides = new Map() } = {}) {
  if (!plan.files.length) return { ...renderFileModule([], []), files: [], inputs: [] }

  const { snapshot, program, anchorFile, inputs } = openAnalysis(plan, fromFile ?? path.join(plan.root, 'points.ep'), api, cache, overrides)
  let probeSnapshot
  try {
    const checker = program.getProject().checker
    const shared = { log: [], helpers: new Map(), exportPaths: new Map(), counter: 0, emitters: 0 }
    const emitter = createTypeEmitter(api, checker, program.getSourceFile(anchorFile), shared)

    // Phase 1: result types, read from the unchanged targets.
    const files = []
    for (const entry of plan.files) {
      // A global script, or a file TypeScript does not load at all, has no place in the registry.
      const sf = program.getSourceFile(entry.file)
      if (!sf?.externalModuleIndicator || !entry.nodes.length) continue

      // The plan counts a byte-order mark; the program's text does not have it.
      const mark = entry.source.length - withoutMark(entry.source).length
      const bySpan = new Map()
      walk(sf, (astNode) => { bySpan.set(`${SyntaxKind[astNode.kind]}:${astNode.getStart(sf) + mark}:${astNode.end + mark}`, astNode) })
      const expressions = entry.nodes.map((node) => bySpan.get(`${node.kind}:${node.start}:${node.end}`))
      const types = checker.getTypeAtLocation(expressions)

      const nodes = entry.nodes.map((node, i) => {
        const expression = expressions[i]
        const emitted = { ...node, unportableReason: null, locals: {}, unportableLocals: {} }
        try {
          emitted.result = emitter.emit(types[i], expression)
        } catch (error) {
          // The expression stays in the registry, so that compile-time match counts equal the runtime's.
          // Its type cannot be written, so it gets one of its own that only original() produces.
          emitted.unportableReason = error.message
          emitted.result = `__EPOpaque<${JSON.stringify(node.id)}>`
          shared.opaque = true
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
    const probes = files
      .filter(({ probed }) => probed.length)
      .map(({ entry, probed }) => [
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
    if (probes.length) {
      probeSnapshot = snapshot.update({ fileSystem: createFileSystemLayer(probes), ensurePrograms: [program.id] })
      const probeProgram = probeSnapshot.getProgram(program.id)
      const probeChecker = probeProgram.getProject().checker
      const probeEmitter = createTypeEmitter(api, probeChecker, probeProgram.getSourceFile(anchorFile), shared)

      for (const { entry, probed } of files) {
        if (!probed.length) continue
        // The probes of a file appear in the order of its nodes.
        const mentions = []
        walk(probeProgram.getSourceFile(entry.file), (astNode) => {
          if (astNode.kind === SyntaxKind.ObjectLiteralExpression && astNode.properties[0]?.name?.text === '__execution_point_probe__') {
            mentions.push(astNode.properties.slice(1))
          }
        })
        const types = probeChecker.getTypeAtLocation(mentions.flat().map((property) => property.initializer))
        let next = 0
        probed.forEach((node, i) => {
          for (const property of mentions[i]) {
            try {
              node.locals[property.name.text] = probeEmitter.emit(types[next], property.initializer)
            } catch (error) {
              node.unportableLocals[property.name.text] = error.message
            }
            next += 1
          }
        })
      }
    }

    const declarations = shared.log.map((entry) => entry.text)
    if (shared.opaque) declarations.unshift(OPAQUE)
    const rendered = renderFileModule(declarations, files.map(({ entry, nodes }) => [entry, nodes]))
    return { ...rendered, files: files.map(({ entry }) => entry.relativeFile), inputs }
  } finally {
    probeSnapshot?.dispose()
    if (!cache) snapshot.dispose()
  }
}

const typeLiteral = (entries) =>
  `{ ${Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => `readonly ${JSON.stringify(name)}: ${type};`).join(' ')} }`

function renderNode(node) {
  const fields = [
    `readonly id: ${JSON.stringify(node.id)};`,
    `readonly kind: ${JSON.stringify(node.kind)};`,
    `readonly inFunction: ${JSON.stringify(node.inFunction)};`,
    node.callee === undefined ? 'readonly callee?: undefined;' : `readonly callee: ${JSON.stringify(node.callee)};`,
    node.operator === undefined ? 'readonly operator?: undefined;' : `readonly operator: ${JSON.stringify(node.operator)};`,
    `readonly nth: ${node.nth};`,
  ]
  if (node.unportableReason) fields.push(`readonly __unportable: ${JSON.stringify(node.unportableReason)};`)
  if (Object.keys(node.unportableLocals).length) {
    fields.push(`readonly __unportableLocals: ${typeLiteral(Object.fromEntries(Object.entries(node.unportableLocals).map(([name, reason]) => [name, JSON.stringify(reason)])))};`)
  }
  fields.push(`readonly result: ${node.result};`, `readonly locals: ${typeLiteral(node.locals)}`)
  return `  | { ${fields.join(' ')} }`
}

/**
 * The registry module. Each file's nodes are a type alias declared outside the
 * `declare module` block, where a global name cannot bind to one of the
 * library's own exports.
 */
function renderFileModule(declarations, files) {
  let text =
    '// Virtual execution-points file schema (generated in memory by TypeScript 7.1 content mapper).\n' +
    "import type {} from 'execution-points-prototype';\n\n" +
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
