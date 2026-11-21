import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  API,
  ModuleKind,
  ModuleResolutionKind,
  NodeBuilderFlags,
  ObjectFlags,
  SymbolFlags,
  TypeFlags,
} from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { ModifierFlags, ScriptTarget, SyntaxKind } from 'typescript/ast'

const markerName = (id) => `__execution_point_${id}`
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

const namedTypeFlags =
  SymbolFlags.TypeAlias |
  SymbolFlags.Interface |
  SymbolFlags.Class |
  SymbolFlags.Enum |
  SymbolFlags.TypeParameter

function walk(node, visit) {
  visit(node)
  node.forEachChild((child) => {
    walk(child, visit)
  })
}

function project(source, edits = []) {
  const ordered = [...edits].sort((a, b) => a.pos - b.pos || (a.order ?? 0) - (b.order ?? 0))
  let text = ''
  let cursor = 0
  const inserted = []
  for (const edit of ordered) {
    text += source.slice(cursor, edit.pos)
    inserted.push({ ...edit, virtualStart: text.length, virtualEnd: text.length + edit.text.length })
    text += edit.text
    cursor = edit.pos
  }
  text += source.slice(cursor)
  return { text, inserted }
}

function typeImportSpecifier(fromFile, targetFile) {
  let rel = path.relative(path.dirname(fromFile), targetFile).replaceAll(path.sep, '/')
  rel = rel.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.tsx?$/, '.js')
  return rel.startsWith('.') ? rel : `./${rel}`
}

function resolveAlias(checker, symbol) {
  if (!symbol) return undefined
  return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

function symbolIdentity(checker, symbol) {
  const resolved = resolveAlias(checker, symbol)
  if (!resolved) return ''
  return resolved.declarations
    .map((declaration) => `${declaration.path}:${declaration.index}`)
    .sort()
    .join('|')
}

function hasLocalDeclaration(symbol) {
  return symbol.declarations.some((handle) => {
    const declaration = handle.resolve()
    for (let parent = declaration?.parent; parent && parent.kind !== SyntaxKind.SourceFile; parent = parent.parent) {
      if (localScopes.has(parent.kind)) return true
    }
    return false
  })
}

function getSourceFileCaseInsensitive(program, filePath) {
  const direct = program.getSourceFile(filePath)
  if (direct) return direct
  const lower = filePath.toLowerCase()
  for (const sf of program.getSourceFiles?.() ?? []) {
    if (sf.fileName.toLowerCase() === lower) return sf
  }
  return undefined
}

function isAmbientOrGlobalSymbol(checker, symbol, program) {
  const resolved = resolveAlias(checker, symbol)
  if (!resolved || !resolved.declarations.length) return true
  return resolved.declarations.every((handle) => {
    const sf = getSourceFileCaseInsensitive(program, handle.path)
    return !sf || !sf.externalModuleIndicator
  })
}

function sameFile(a, b) {
  if (!a || !b) return false
  return a === b || a.toLowerCase() === b.toLowerCase()
}

function isDeclaredInFile(checker, symbol, filePath) {
  const resolved = resolveAlias(checker, symbol)
  if (!resolved) return false
  return resolved.declarations.some((handle) => sameFile(handle.path, filePath))
}

function isSafeAutoLocal(checker, symbol, sourceFile, targetStart) {
  if (!symbol || !symbol.name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol.name)) return false
  if (symbol.name.startsWith('__execution_point_')) return false
  if (symbol.flags & (SymbolFlags.Alias | SymbolFlags.TypeParameter | SymbolFlags.Module)) return false
  if (!isDeclaredInFile(checker, symbol, sourceFile.fileName)) return false
  if (!hasLocalDeclaration(symbol)) return false
  // Ensure every declaration in this file is either hoisted (function/parameter)
  // or appears strictly before the target expression to avoid TDZ errors.
  return symbol.declarations.every((handle) => {
    const decl = handle.resolve()
    if (!decl) return false
    if (decl.kind === SyntaxKind.Parameter || decl.kind === SyntaxKind.FunctionDeclaration) return true
    return decl.end <= targetStart
  })
}

function isNominalUnexportedSymbol(checker, symbol) {
  const resolved = resolveAlias(checker, symbol)
  if (!resolved) return false
  if (resolved.flags & (SymbolFlags.Enum | SymbolFlags.ConstEnum | SymbolFlags.RegularEnum)) return true
  if (resolved.flags & SymbolFlags.Class) {
    for (const handle of resolved.declarations) {
      const decl = handle.resolve()
      if (!decl || !decl.members) continue
      for (const member of decl.members) {
        if (member.name?.kind === SyntaxKind.PrivateIdentifier) return true
        const mods = member.modifiers
        if (mods?.some((m) => m.kind === SyntaxKind.PrivateKeyword || m.kind === SyntaxKind.ProtectedKeyword)) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Walk exported values and types of a module to discover exact type expressions
 * (e.g. `import('./checkout.js').Foo` or `ReturnType<typeof import('./checkout.js').checkout>['quote']`)
 * that preserve identity for both exported and export-reachable private types.
 */
function buildExportIndex(checker, program, sourceFile, fromFile) {
  const bySymbolId = new Map()
  const modSym = checker.getSymbolOfSourceFile(sourceFile.fileName)
  if (!modSym) return bySymbolId

  const importSpec = typeImportSpecifier(fromFile, sourceFile.fileName)
  const importPrefix = `import(${JSON.stringify(importSpec)})`
  const exports = checker.getExportsOfModule(modSym)

  const record = (sym, expr) => {
    const id = symbolIdentity(checker, sym)
    if (!id) return
    const existing = bySymbolId.get(id)
    if (!existing || expr.length < existing.length) {
      bySymbolId.set(id, expr)
    }
  }

  const queue = []
  const visitedTypes = new Set()

  for (const exp of exports) {
    const target = resolveAlias(checker, exp)
    if (!target) continue
    if (target.flags & namedTypeFlags) {
      // Only direct non-generic or generic named exports (type arguments appended later)
      record(target, `${importPrefix}.${exp.name}`)
    }
    if (target.flags & SymbolFlags.Value) {
      const valType = checker.getTypeOfSymbol(target)
      queue.push({ type: valType, expr: `typeof ${importPrefix}.${exp.name}`, depth: 0 })
    }
  }

  const enqueue = (type, expr, depth) => {
    if (!type || depth > 4) return
    const key = `${type.id}:${depth}`
    if (visitedTypes.has(key)) return
    visitedTypes.add(key)
    queue.push({ type, expr, depth })
  }

  while (queue.length) {
    const { type, expr, depth } = queue.shift()
    if (!type || type.isErrorType() || (type.flags & TypeFlags.Any)) continue

    const alias = type.getAliasSymbol()
    const sym = type.getSymbol()
    if (alias && !(type.getAliasTypeArguments()?.length)) {
      if (isDeclaredInFile(checker, alias, sourceFile.fileName) && !hasLocalDeclaration(alias)) {
        record(alias, expr)
      }
    }
    if (sym && (sym.flags & namedTypeFlags) && !type.isTypeReference()) {
      if (isDeclaredInFile(checker, sym, sourceFile.fileName) && !hasLocalDeclaration(sym)) {
        record(sym, expr)
      }
    } else if (sym && (sym.flags & namedTypeFlags) && type.isTypeReference()) {
      const typeArgs = checker.getTypeArguments(type)
      if (!typeArgs?.length && isDeclaredInFile(checker, sym, sourceFile.fileName) && !hasLocalDeclaration(sym)) {
        record(sym, expr)
      }
    }

    if (depth >= 4) continue

    // Nullable union -> NonNullable<expr>
    if (type.flags & TypeFlags.Union) {
      const members = type.getTypes() ?? []
      const nonNull = members.filter((m) => !(m.flags & (TypeFlags.Null | TypeFlags.Undefined)))
      if (nonNull.length === 1 && nonNull.length < members.length) {
        enqueue(nonNull[0], `NonNullable<${expr}>`, depth + 1)
      }
      continue
    }

    // Promise<T> -> Awaited<expr>
    if (sym?.name === 'Promise' && type.isTypeReference()) {
      const args = checker.getTypeArguments(type)
      if (args?.length === 1) {
        enqueue(args[0], `Awaited<${expr}>`, depth + 1)
      }
      continue
    }

    // Array<T> / readonly T[] -> (expr)[number]
    if (checker.isArrayLikeType(type) && type.isTypeReference()) {
      const args = checker.getTypeArguments(type)
      if (args?.length === 1) {
        enqueue(args[0], `(${expr})[number]`, depth + 1)
      }
      continue
    }

    // Function / callable -> ReturnType & Parameters
    const callSigs = type.getCallSignatures()
    if (callSigs.length === 1 && !callSigs[0].getTypeParameters().length) {
      const sig = callSigs[0]
      enqueue(sig.getReturnType(), `ReturnType<${expr}>`, depth + 1)
      const params = sig.getParameters()
      for (let i = 0; i < params.length; i++) {
        const paramType = checker.getParameterType(sig, i)
        enqueue(paramType, `Parameters<${expr}>[${i}]`, depth + 1)
      }
    }

    // Object properties (non-builtin)
    if (type.isObjectType() && !isAmbientOrGlobalSymbol(checker, sym, program)) {
      const props = type.getProperties()
      if (props.length <= 24) {
        for (const prop of props) {
          if (!prop.name || prop.name.startsWith('__')) continue
          const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile)
          enqueue(propType, `(${expr})[${JSON.stringify(prop.name)}]`, depth + 1)
        }
      }
    }
  }

  return bySymbolId
}

/**
 * Emits TypeScript type strings valid inside a virtual module located at `fromFile`.
 */
function createTypeEmitter(api, checker, program, fromFile, sharedState = { defs: [], bySymbolId: new Map(), counter: 0 }) {
  const exportIndices = new Map()
  const sourceFileByLowerPath = new Map()
  for (const sf of program.getSourceFiles?.() ?? []) {
    sourceFileByLowerPath.set(sf.fileName.toLowerCase(), sf)
  }

  function findSourceFile(filePath) {
    return program.getSourceFile(filePath) ?? sourceFileByLowerPath.get(filePath.toLowerCase())
  }

  function getExportIndexForFile(filePath) {
    const key = filePath.toLowerCase()
    let index = exportIndices.get(key)
    if (!index) {
      const sf = findSourceFile(filePath)
      index = sf ? buildExportIndex(checker, program, sf, fromFile) : new Map()
      exportIndices.set(key, index)
    }
    return index
  }

  function resolveExternalSymbolRef(symbol) {
    const resolved = resolveAlias(checker, symbol)
    if (!resolved) return undefined
    if (isAmbientOrGlobalSymbol(checker, resolved, program)) {
      return resolved.name
    }
    for (const handle of resolved.declarations) {
      const idx = getExportIndexForFile(handle.path)
      const found = idx.get(symbolIdentity(checker, resolved))
      if (found) return found
    }
    return undefined
  }

  function checkAndEmit(type, location, seen = new Set()) {
    if (!type) throw new Error('TypeScript could not determine this type.')
    if (type.isErrorType()) throw new Error('TypeScript could not determine this type.')
    if (type.flags & TypeFlags.Any) throw new Error('This type is any; execution-points requires a concrete checked type.')
    if (type.isTypeParameter()) {
      throw new Error(`The type parameter ${checker.typeToString(type)} is local to a generic scope.`)
    }

    // Primitives & literals
    if (
      type.flags &
      (TypeFlags.String |
        TypeFlags.Number |
        TypeFlags.Boolean |
        TypeFlags.BigInt |
        TypeFlags.Void |
        TypeFlags.Undefined |
        TypeFlags.Null |
        TypeFlags.Never |
        TypeFlags.Unknown |
        TypeFlags.ESSymbol |
        TypeFlags.StringLiteral |
        TypeFlags.NumberLiteral |
        TypeFlags.BigIntLiteral |
        TypeFlags.BooleanLiteral)
    ) {
      const node = checker.typeToTypeNode(type, undefined, NodeBuilderFlags.NoTruncation)
      if (!node) throw new Error('TypeScript could not represent this primitive/literal type.')
      return api.printer.printNode(node)
    }

    // Unique symbol
    if (type.flags & TypeFlags.UniqueESSymbol) {
      const sym = type.getSymbol()
      if (sym && hasLocalDeclaration(sym)) {
        throw new Error(`The unique symbol ${sym.name} is declared inside a function or block.`)
      }
      const external = sym ? resolveExternalSymbolRef(sym) : undefined
      if (external) return `typeof ${external}`
      return emitNominalHelper(type, sym, location)
    }

    // Unions
    if (type.flags & TypeFlags.Union) {
      const members = type.getTypes() ?? []
      return `(${members.map((m) => checkAndEmit(m, location, new Set(seen))).join(' | ')})`
    }

    // Intersections
    if (type.flags & TypeFlags.Intersection) {
      const members = type.getTypes() ?? []
      return `(${members.map((m) => checkAndEmit(m, location, new Set(seen))).join(' & ')})`
    }

    // Named alias (e.g. `type Foo = ...`)
    const alias = type.getAliasSymbol()
    if (alias) {
      if (hasLocalDeclaration(alias)) {
        throw new Error(`The type ${alias.name} is declared inside a function or block and cannot be exposed safely.`)
      }
      const aliasArgs = type.getAliasTypeArguments() ?? []
      const external = resolveExternalSymbolRef(alias)
      if (external) {
        if (aliasArgs.length) {
          const args = aliasArgs.map((a) => checkAndEmit(a, location, new Set(seen))).join(', ')
          return `${external}<${args}>`
        }
        return external
      }
      if (!aliasArgs.length) {
        return emitNamedStructuralHelper(type, alias, location)
      }
    }

    // Tuples
    if (type.isTupleType?.() || (type.objectFlags & ObjectFlags.Tuple)) {
      const args = checker.getTypeArguments(type) ?? []
      const readonlyPrefix = type.getTargetType?.()?.readonly ? 'readonly ' : ''
      const elements = args.map((a) => checkAndEmit(a, location, new Set(seen))).join(', ')
      return `${readonlyPrefix}[${elements}]`
    }

    // Named Interface / Class / Enum / Built-in Generic (Promise, Array, Map, Date, etc.)
    const sym = type.getSymbol()
    if (sym && (sym.flags & namedTypeFlags)) {
      if (hasLocalDeclaration(sym)) {
        throw new Error(`The type ${sym.name} is declared inside a function or block and cannot be exposed safely.`)
      }
      const typeArgs = type.isTypeReference() ? (checker.getTypeArguments(type) ?? []) : []
      const external = resolveExternalSymbolRef(sym)
      if (external) {
        if (typeArgs.length) {
          const args = typeArgs.map((a) => checkAndEmit(a, location, new Set(seen))).join(', ')
          return `${external}<${args}>`
        }
        return external
      }
      // Unexported type in a project module not reachable from exports
      if (isNominalUnexportedSymbol(checker, sym)) {
        return emitNominalHelper(type, sym, location)
      }
      if (!typeArgs.length) {
        return emitNamedStructuralHelper(type, sym, location)
      }
    }

    // Anonymous object / function type
    if (type.isObjectType()) {
      if (seen.has(type.id)) {
        return emitAnonymousRecursiveHelper(type, location)
      }
      seen.add(type.id)
      return emitObjectBody(type, location, seen)
    }

    // Fallback: ask TS printer for anything remaining (template literals, etc.)
    const node = checker.typeToTypeNode(type, undefined, NodeBuilderFlags.NoTruncation)
    if (!node) throw new Error('TypeScript could not represent this type in a virtual contract.')
    return api.printer.printNode(node)
  }

  function isReadonlyProperty(prop) {
    if (!prop.declarations?.length) return false
    return prop.declarations.some((handle) => {
      const decl = handle.resolve()
      if (!decl) return false
      if (decl.kind === SyntaxKind.GetAccessor) {
        // Getter without setter is readonly
        return !prop.declarations.some((h) => h.resolve()?.kind === SyntaxKind.SetAccessor)
      }
      const modFlags = decl.modifierFlagsCache ?? 0
      if (modFlags & ModifierFlags.Readonly) return true
      return Boolean(decl.modifiers?.some((m) => m.kind === SyntaxKind.ReadonlyKeyword))
    })
  }

  function isPrivateOrProtectedMember(prop) {
    if (prop.name?.startsWith('#')) return true
    return prop.declarations?.some((handle) => {
      const decl = handle.resolve()
      if (!decl) return false
      if (decl.name?.kind === SyntaxKind.PrivateIdentifier) return true
      return Boolean(
        decl.modifiers?.some((m) => m.kind === SyntaxKind.PrivateKeyword || m.kind === SyntaxKind.ProtectedKeyword),
      )
    })
  }

  function emitSignature(sig, location, seen, isConstruct = false) {
    if (sig.getTypeParameters().length) {
      throw new Error('Generic function-valued captures are not supported by this prototype.')
    }
    const params = sig.getParameters().map((param, idx) => {
      const paramType = checker.getParameterType(sig, idx)
      const optional = Boolean(param.flags & SymbolFlags.Optional) ? '?' : ''
      const rest = param.declarations?.some((h) => Boolean(h.resolve()?.dotDotDotToken)) ? '...' : ''
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param.name) ? param.name : `arg${idx}`
      return `${rest}${name}${optional}: ${checkAndEmit(paramType, location, new Set(seen))}`
    })
    const ret = checkAndEmit(sig.getReturnType(), location, new Set(seen))
    return `${isConstruct ? 'new ' : ''}(${params.join(', ')}) => ${ret}`
  }

  function emitObjectMembers(type, location, seen) {
    const members = []
    for (const sig of type.getCallSignatures()) {
      const emitted = emitSignature(sig, location, seen, false)
      // Convert `(a: T) => R` to `(a: T): R;`
      const arrowIdx = emitted.lastIndexOf(' => ')
      members.push(`${emitted.slice(0, arrowIdx)}: ${emitted.slice(arrowIdx + 4)};`)
    }
    for (const sig of type.getConstructSignatures()) {
      const emitted = emitSignature(sig, location, seen, true)
      const arrowIdx = emitted.lastIndexOf(' => ')
      members.push(`${emitted.slice(0, arrowIdx)}: ${emitted.slice(arrowIdx + 4)};`)
    }
    for (const info of type.getIndexInfos()) {
      const keyType = checkAndEmit(info.keyType, location, new Set(seen))
      const valType = checkAndEmit(info.type, location, new Set(seen))
      const ro = info.isReadonly ? 'readonly ' : ''
      members.push(`${ro}[key: ${keyType}]: ${valType};`)
    }
    for (const prop of type.getProperties()) {
      if (isPrivateOrProtectedMember(prop)) continue
      const propType = checker.getTypeOfSymbolAtLocation(prop, location)
      const ro = isReadonlyProperty(prop) ? 'readonly ' : ''
      const opt = prop.flags & SymbolFlags.Optional ? '?' : ''
      members.push(`${ro}${JSON.stringify(prop.name)}${opt}: ${checkAndEmit(propType, location, new Set(seen))};`)
    }
    return members
  }

  function emitObjectBody(type, location, seen) {
    const callSigs = type.getCallSignatures()
    const constructSigs = type.getConstructSignatures()
    const props = type.getProperties().filter((p) => !isPrivateOrProtectedMember(p))
    const indexInfos = type.getIndexInfos()
    if (callSigs.length === 1 && !constructSigs.length && !props.length && !indexInfos.length) {
      return `(${emitSignature(callSigs[0], location, seen, false)})`
    }
    const members = emitObjectMembers(type, location, seen)
    return members.length ? `{ ${members.join(' ')} }` : '{}'
  }

  function emitNamedStructuralHelper(type, sym, location) {
    const id = symbolIdentity(checker, sym)
    const existing = sharedState.bySymbolId.get(id)
    if (existing) return existing
    const safeBase = (sym.name || 'Type').replace(/[^A-Za-z0-9_]/g, '_')
    const name = `__EP_${safeBase}_${++sharedState.counter}`
    sharedState.bySymbolId.set(id, name)
    const members = emitObjectMembers(type, location, new Set([type.id]))
    sharedState.defs.push(`interface ${name} {\n  ${members.join('\n  ')}\n}`)
    return name
  }

  function emitNominalHelper(type, sym, location) {
    const id = symbolIdentity(checker, sym) || `anon_${type.id}`
    const existing = sharedState.bySymbolId.get(id)
    if (existing) return existing
    const safeBase = (sym?.name || 'Nominal').replace(/[^A-Za-z0-9_]/g, '_')
    const idx = ++sharedState.counter
    const brandName = `__ep_brand_${safeBase}_${idx}`
    const name = `__EP_${safeBase}_${idx}`
    sharedState.bySymbolId.set(id, name)
    const members = type.isObjectType() ? emitObjectMembers(type, location, new Set([type.id])) : []
    sharedState.defs.push(
      `declare const ${brandName}: unique symbol;\ninterface ${name} {\n  readonly [${brandName}]: never;\n  ${members.join('\n  ')}\n}`,
    )
    return name
  }

  function emitAnonymousRecursiveHelper(type, location) {
    const key = `rec_${type.id}`
    const existing = sharedState.bySymbolId.get(key)
    if (existing) return existing
    const name = `__EP_Anon_${++sharedState.counter}`
    sharedState.bySymbolId.set(key, name)
    const members = emitObjectMembers(type, location, new Set([type.id]))
    sharedState.defs.push(`interface ${name} {\n  ${members.join('\n  ')}\n}`)
    return name
  }

  return {
    emit(type, location) {
      return checkAndEmit(type, location)
    },
    getHelperDeclarations() {
      return sharedState.defs
    },
  }
}

/**
 * Analyze all targets in a discovered plan using a TypeScript 7.1 API instance
 * (strictly excluding .ep files and contentMappers to guarantee zero recursion)
 * and generate the virtual `declare module 'execution-points-prototype'` text.
 */
export function generateRegistryModule(plan, { fromFile, api: externalApi, compilerOptions: hostOptions, overrides = new Map() } = {}) {
  const registryRoot = fromFile ?? path.join(plan.root, 'points.ep')
  const ownApi = !externalApi
  const api = externalApi ?? new API({ cwd: plan.root })
  let baseSnapshot
  let probeSnapshot

  // Map: relativeFile -> Map(query -> { result, locals } | { error })
  const byFile = new Map()
  const setEntry = (relFile, query, entry) => {
    if (!relFile || !query) return
    let queries = byFile.get(relFile)
    if (!queries) {
      queries = new Map()
      byFile.set(relFile, queries)
    }
    queries.set(query, entry)
  }

  // Record discovery errors first so bad selectors report right at point(...) in tests
  for (const err of plan.errors ?? []) {
    if (err.file && err.query) {
      setEntry(err.file, err.query, { error: err.message })
    }
  }

  if (!plan.targets.length) {
    if (ownApi) api.close()
    return {
      text: renderModule([], byFile),
      contracts: [],
    }
  }

  try {
    const config = plan.tsconfig && existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
    const compilerOptions = {
      strict: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      ...config?.options,
      ...hostOptions,
      noEmit: true,
      declaration: false,
      emitDeclarationOnly: false,
      incremental: false,
      composite: false,
    }

    const testFiles = new Set(plan.tests.map((test) => test.file))
    const originals = new Map()
    for (const target of plan.targets) originals.set(target.file, target.source)
    for (const [file, source] of overrides) {
      if (!testFiles.has(file) && !file.endsWith('.ep')) originals.set(file, source)
    }

    const rootFiles = [
      ...new Set([
        ...(config?.fileNames ?? []).filter((file) => !testFiles.has(file) && !file.endsWith('.ep')),
        ...originals.keys(),
      ]),
    ]

    // Phase 1: Unmodified target program -> exact result types + in-scope local discovery
    baseSnapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...originals]),
      createPrograms: [{ rootFiles, compilerOptions }],
    })
    const baseProgram = baseSnapshot.operation.createdPrograms[0]
    const baseChecker = baseProgram.getProject().checker
    const sharedHelperState = { defs: [], bySymbolId: new Map(), counter: 0 }
    const emitter = createTypeEmitter(api, baseChecker, baseProgram, registryRoot, sharedHelperState)

    const targetMeta = new Map()
    const targetsByFile = new Map()

    for (const target of plan.targets) {
      const sourceFile = baseProgram.getSourceFile(target.file)
      if (!sourceFile?.externalModuleIndicator) {
        const msg =
          "Targets must be in a TypeScript module with an import or export. Global scripts are not supported."
        for (const q of target.queries) setEntry(target.relativeFile, q, { error: msg })
        continue
      }
      let expression
      walk(sourceFile, (node) => {
        if (node.getStart(sourceFile) === target.start && node.end === target.end) expression = node
      })
      if (!expression) {
        const msg = 'The target expression could not be matched in the TypeScript program.'
        for (const q of target.queries) setEntry(target.relativeFile, q, { error: msg })
        continue
      }

      let resultTypeText
      try {
        resultTypeText = emitter.emit(baseChecker.getTypeAtLocation(expression), expression)
      } catch (error) {
        const msg = `Cannot expose this point's result type: ${error.message}`
        for (const q of target.queries) setEntry(target.relativeFile, q, { error: msg })
        continue
      }

      // Discover valid explicit captures + safe auto-locals in enclosing scopes for VS Code autocomplete
      const validExplicit = []
      for (const name of target.captures) {
        const sym = baseChecker.resolveName(name, SymbolFlags.Value, expression)
        if (sym) validExplicit.push(name)
      }

      const autoLocals = []
      const inScope = baseChecker.getSymbolsInScope(expression, SymbolFlags.Value) ?? []
      for (const sym of inScope) {
        if (validExplicit.includes(sym.name)) continue
        if (isSafeAutoLocal(baseChecker, sym, sourceFile, target.start)) {
          autoLocals.push(sym.name)
        }
      }

      const probeNames = [...new Set([...validExplicit, ...autoLocals])].sort()
      targetMeta.set(target.id, {
        target,
        resultTypeText,
        explicitSet: new Set(validExplicit),
        probeNames,
      })

      const list = targetsByFile.get(target.file) ?? []
      list.push(target)
      targetsByFile.set(target.file, list)
    }

    // Phase 2: Incremental probe snapshot -> exact control-flow-narrowed local types
    const probeFiles = new Map()
    for (const [file, targets] of targetsByFile) {
      const edits = []
      for (const target of targets) {
        const meta = targetMeta.get(target.id)
        if (!meta) continue
        const captures = meta.probeNames.map((name) => `${JSON.stringify(name)}: ${name}`).join(', ')
        const prefix = `(void { ${JSON.stringify(markerName(target.id))}: 0${captures ? `, ${captures}` : ''} }, (`
        edits.push({ pos: target.start, text: prefix, order: 1 })
        edits.push({ pos: target.end, text: '))', order: 0 })
      }
      probeFiles.set(file, project(originals.get(file), edits).text)
    }

    const contracts = []

    if (probeFiles.size > 0) {
      probeSnapshot = baseSnapshot.update({
        fileSystem: createFileSystemLayer([...probeFiles]),
        ensurePrograms: [baseProgram.id],
      })
      const probeProgram = probeSnapshot.getProgram(baseProgram.id)
      const probeChecker = probeProgram.getProject().checker
      const probeEmitter = createTypeEmitter(api, probeChecker, probeProgram, registryRoot, sharedHelperState)

      for (const [targetId, meta] of targetMeta) {
        const { target, resultTypeText, explicitSet } = meta
        const sourceFile = probeProgram.getSourceFile(target.file)
        let captureObject
        walk(sourceFile, (node) => {
          if (
            node.kind === SyntaxKind.ObjectLiteralExpression &&
            node.properties[0]?.name?.text === markerName(target.id)
          ) {
            captureObject = node
          }
        })
        if (!captureObject) {
          const msg = 'Could not analyze captured bindings at the target expression.'
          for (const q of target.queries) setEntry(target.relativeFile, q, { error: msg })
          continue
        }

        const locals = {}
        let explicitFailure
        for (const prop of captureObject.properties.slice(1)) {
          const name = prop.name.text
          try {
            const narrowedType = probeChecker.getTypeAtLocation(prop.initializer)
            locals[name] = probeEmitter.emit(narrowedType, prop.initializer)
          } catch (error) {
            if (explicitSet.has(name)) {
              explicitFailure = `Cannot expose captured binding "${name}": ${error.message}`
              break
            }
            // Auto-discovered non-requested locals with unportable types are silently omitted
          }
        }

        if (explicitFailure) {
          for (const q of target.queries) setEntry(target.relativeFile, q, { error: explicitFailure })
          continue
        }

        contracts.push({ id: targetId, file: target.relativeFile, result: resultTypeText, locals })
        for (const q of target.queries) {
          setEntry(target.relativeFile, q, { result: resultTypeText, locals })
        }
      }

      return {
        text: renderModule(sharedHelperState.defs, byFile),
        contracts,
      }
    }

    return {
      text: renderModule(sharedHelperState.defs, byFile),
      contracts,
    }
  } finally {
    probeSnapshot?.dispose()
    baseSnapshot?.dispose()
    if (ownApi) api.close()
  }
}

function renderModule(helperDefs, byFile) {
  const lines = [
    '// Virtual execution-points type registry (generated in memory by TypeScript 7.1 content mapper).',
    "import type {} from 'execution-points-prototype';",
    '',
  ]

  for (const def of helperDefs) {
    lines.push(def, '')
  }

  lines.push("declare module 'execution-points-prototype' {")
  lines.push('  interface ExecutionPointRegistry {')

  for (const [file, queries] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${JSON.stringify(file)}: {`)
    for (const [query, entry] of [...queries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (entry.error) {
        lines.push(`      ${JSON.stringify(query)}: { readonly __error: ${JSON.stringify(entry.error)} };`)
      } else {
        const localEntries = Object.entries(entry.locals)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, type]) => `readonly ${JSON.stringify(name)}: ${type};`)
          .join(' ')
        lines.push(
          `      ${JSON.stringify(query)}: { readonly result: ${entry.result}; readonly locals: { ${localEntries} } };`,
        )
      }
    }
    lines.push('    };')
  }

  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}
