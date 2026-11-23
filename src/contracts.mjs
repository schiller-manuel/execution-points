import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  API,
  ElementFlags,
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
  SymbolFlags.TypeParameter |
  SymbolFlags.UniqueESSymbol

function walk(node, visit) {
  visit(node)
  node.forEachChild((child) => { walk(child, visit) })
}

function projectNested(source, nodes, prefixOf, suffixOf) {
  const buckets = new Map()
  const at = (offset) => {
    let b = buckets.get(offset)
    if (!b) { b = { opens: [], closes: [] }; buckets.set(offset, b) }
    return b
  }
  for (const node of nodes) {
    at(node.start).opens.push({ start: node.start, end: node.end, text: prefixOf(node) })
    at(node.end).closes.push({ start: node.start, end: node.end, text: suffixOf(node) })
  }
  const offsets = [...buckets.keys()].sort((a, b) => a - b)
  let out = '', cursor = 0
  for (const offset of offsets) {
    out += source.slice(cursor, offset)
    const b = buckets.get(offset)
    b.closes.sort((a, b) => b.start - a.start)
    b.opens.sort((a, b) => b.end - a.end)
    out += b.closes.map((e) => e.text).join('') + b.opens.map((e) => e.text).join('')
    cursor = offset
  }
  return out + source.slice(cursor)
}

const resolveAlias = (checker, sym) => (!sym ? undefined : sym.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym)

function typeImportSpecifier(fromFile, targetFile) {
  let rel = path.relative(path.dirname(fromFile), targetFile).replaceAll(path.sep, '/')
  rel = rel.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.tsx?$/, '.js')
  return rel.startsWith('.') ? rel : `./${rel}`
}

function symbolIdentity(checker, sym) {
  const resolved = resolveAlias(checker, sym)
  return resolved ? resolved.declarations.map((d) => `${d.path}:${d.index}`).sort().join('|') : ''
}

function hasLocalDeclaration(sym) {
  return sym.declarations.some((h) => {
    for (let p = h.resolve().parent; p && p.kind !== SyntaxKind.SourceFile; p = p.parent) {
      if (localScopes.has(p.kind)) return true
    }
    return false
  })
}

function getSourceFileCached(program, filePath, sfCache) {
  if (!sfCache.has(filePath)) sfCache.set(filePath, program.getSourceFile(filePath))
  return sfCache.get(filePath)
}

function isAmbientOrGlobal(checker, sym, program, sfCache) {
  const resolved = resolveAlias(checker, sym)
  return !resolved?.declarations.length || resolved.declarations.every((h) => !getSourceFileCached(program, h.path, sfCache)?.externalModuleIndicator)
}

function qualifyAmbientName(sym) {
  const parts = [sym.name]
  for (const h of sym.declarations) {
    for (let p = h.resolve().parent; p; p = p.parent) {
      if (p.kind === SyntaxKind.ModuleDeclaration && p.name.kind === SyntaxKind.Identifier && p.name.text !== 'global') {
        parts.unshift(p.name.text)
      }
    }
    break
  }
  return parts.join('.')
}

function isDeclaredInFile(checker, sym, filePath) {
  const resolved = resolveAlias(checker, sym)
  return Boolean(resolved?.declarations.some((h) => h.path.toLowerCase() === filePath.toLowerCase()))
}

function isNominalUnexported(checker, sym) {
  const resolved = resolveAlias(checker, sym)
  if (!resolved) return false
  if (resolved.flags & (SymbolFlags.Enum | SymbolFlags.ConstEnum | SymbolFlags.RegularEnum)) return true
  if (resolved.flags & SymbolFlags.Class) {
    return resolved.declarations.some((h) =>
      h.resolve()?.members?.some((m) =>
        m.name?.kind === SyntaxKind.PrivateIdentifier ||
        m.modifiers?.some((mod) => mod.kind === SyntaxKind.PrivateKeyword || mod.kind === SyntaxKind.ProtectedKeyword),
      ),
    )
  }
  return false
}

/** Find shortest export-anchored type paths for exported and export-reachable private types. */
function buildExportIndex(checker, program, sf, fromFile, sfCache) {
  const bySymbolId = new Map()
  const modSym = checker.getSymbolOfSourceFile(sf.fileName)
  if (!modSym) return bySymbolId

  const importPrefix = `import(${JSON.stringify(typeImportSpecifier(fromFile, sf.fileName))})`
  const record = (sym, expr) => {
    const id = symbolIdentity(checker, sym)
    if (id && (!bySymbolId.has(id) || expr.length < bySymbolId.get(id).length)) bySymbolId.set(id, expr)
  }

  const queue = []
  const visited = new Set()
  const enqueue = (type, expr, depth) => {
    if (!type || depth > 4) return
    const key = `${type.id}:${depth}`
    if (!visited.has(key)) { visited.add(key); queue.push({ type, expr, depth }) }
  }

  for (const exp of checker.getExportsOfModule(modSym)) {
    const target = resolveAlias(checker, exp)
    if (!target) continue
    if (target.flags & namedTypeFlags) record(target, `${importPrefix}.${exp.name}`)
    if (target.flags & SymbolFlags.Value) enqueue(checker.getTypeOfSymbol(target), `typeof ${importPrefix}.${exp.name}`, 0)
  }

  while (queue.length) {
    const { type, expr, depth } = queue.shift()
    if (!type || type.isErrorType() || (type.flags & TypeFlags.Any)) continue
    const alias = type.getAliasSymbol()
    const sym = type.getSymbol()
    if (alias && !(type.getAliasTypeArguments()?.length) && isDeclaredInFile(checker, alias, sf.fileName) && !hasLocalDeclaration(alias)) {
      record(alias, expr)
    }
    if (
      sym &&
      ((sym.flags & namedTypeFlags) || (type.flags & TypeFlags.UniqueESSymbol)) &&
      isDeclaredInFile(checker, sym, sf.fileName) &&
      !hasLocalDeclaration(sym)
    ) {
      if (!type.isTypeReference() || !(checker.getTypeArguments(type)?.length)) record(sym, expr)
    }
    if (depth >= 4) continue

    if (type.flags & TypeFlags.Union) {
      const members = type.getTypes() ?? []
      const nonNull = members.filter((m) => !(m.flags & (TypeFlags.Null | TypeFlags.Undefined)))
      if (nonNull.length === 1 && nonNull.length < members.length) enqueue(nonNull[0], `NonNullable<${expr}>`, depth + 1)
      continue
    }
    if (sym?.name === 'Promise' && type.isTypeReference()) {
      const args = checker.getTypeArguments(type)
      if (args?.length === 1) enqueue(args[0], `Awaited<${expr}>`, depth + 1)
      continue
    }
    if (checker.isArrayLikeType(type) && type.isTypeReference()) {
      const args = checker.getTypeArguments(type)
      if (args?.length === 1) enqueue(args[0], `(${expr})[number]`, depth + 1)
      continue
    }
    const callSigs = type.getCallSignatures()
    if (callSigs.length === 1 && !callSigs[0].getTypeParameters().length) {
      const sig = callSigs[0]
      enqueue(sig.getReturnType(), `ReturnType<${expr}>`, depth + 1)
      sig.getParameters().forEach((_, i) => enqueue(checker.getParameterType(sig, i), `Parameters<${expr}>[${i}]`, depth + 1))
    }
    if (type.isObjectType() && !isAmbientOrGlobal(checker, sym, program, sfCache)) {
      const props = type.getProperties()
      if (props.length <= 24) {
        for (const prop of props) {
          if (prop.name && !prop.name.startsWith('__')) {
            enqueue(checker.getTypeOfSymbolAtLocation(prop, sf), `(${expr})[${JSON.stringify(prop.name)}]`, depth + 1)
          }
        }
      }
    }
  }
  return bySymbolId
}

function createTypeEmitter(api, checker, program, fromFile, shared) {
  const sfCache = new Map()
  const exportIndices = new Map()

  const getExportIndex = (filePath) => {
    const key = filePath.toLowerCase()
    let idx = exportIndices.get(key)
    if (!idx) {
      const sf = getSourceFileCached(program, filePath, sfCache)
      idx = sf ? buildExportIndex(checker, program, sf, fromFile, sfCache) : new Map()
      exportIndices.set(key, idx)
    }
    return idx
  }

  const resolveExternal = (sym) => {
    const resolved = resolveAlias(checker, sym)
    if (!resolved) return undefined
    if (isAmbientOrGlobal(checker, resolved, program, sfCache)) return qualifyAmbientName(resolved)
    const id = symbolIdentity(checker, resolved)
    for (const h of resolved.declarations) {
      const found = getExportIndex(h.path).get(id)
      if (found) return found
    }
    return undefined
  }

  const isPrivateMember = (prop) =>
    prop.name?.startsWith('#') ||
    prop.declarations?.some((h) => {
      const d = h.resolve()
      return d && (d.name?.kind === SyntaxKind.PrivateIdentifier || d.modifiers?.some((m) => m.kind === SyntaxKind.PrivateKeyword || m.kind === SyntaxKind.ProtectedKeyword))
    })

  const isReadonlyProp = (prop) =>
    prop.declarations?.some((h) => {
      const d = h.resolve()
      if (!d) return false
      if (d.kind === SyntaxKind.GetAccessor) return !prop.declarations.some((o) => o.resolve()?.kind === SyntaxKind.SetAccessor)
      return Boolean((d.modifierFlagsCache ?? 0) & ModifierFlags.Readonly || d.modifiers?.some((m) => m.kind === SyntaxKind.ReadonlyKeyword))
    })

  function emitSig(sig, loc, seen, isNew = false) {
    if (sig.getTypeParameters().length) throw new Error('Generic function-valued captures are not supported.')
    const sigParams = sig.getParameters()
    const params = sigParams.map((p, i) => {
      const decls = p.declarations?.map((h) => h.resolve()).filter(Boolean) ?? []
      const isRest = Boolean(sig.hasRestParameter && i === sigParams.length - 1) || decls.some((d) => Boolean(d.dotDotDotToken))
      const isOpt = Boolean(p.flags & SymbolFlags.Optional) || decls.some((d) => Boolean(d.questionToken || d.initializer))
      const opt = isOpt && !isRest ? '?' : ''
      const rest = isRest ? '...' : ''
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.name) ? p.name : `arg${i}`
      const rawType = isRest ? checker.getTypeOfSymbolAtLocation(p, loc) : checker.getParameterType(sig, i)
      const paramType =
        isOpt && !isRest && (rawType.flags & TypeFlags.Union)
          ? (() => {
              const nonUndef = (rawType.getTypes() ?? []).filter((m) => !(m.flags & TypeFlags.Undefined))
              return nonUndef.length === 1 ? nonUndef[0] : rawType
            })()
          : rawType
      return `${rest}${name}${opt}: ${emit(paramType, loc, new Set(seen))}`
    })
    return `${isNew ? 'new ' : ''}(${params.join(', ')}) => ${emit(sig.getReturnType(), loc, new Set(seen))}`
  }

  function emitMembers(type, loc, seen) {
    const props = type.getProperties().filter((p) => !isPrivateMember(p))
    if (props.length > 24) throw new Error('Object type has too many properties to inline in a virtual contract.')
    const out = []
    for (const sig of type.getCallSignatures()) {
      const s = emitSig(sig, loc, seen), i = s.lastIndexOf(' => ')
      out.push(`${s.slice(0, i)}: ${s.slice(i + 4)};`)
    }
    for (const sig of type.getConstructSignatures()) {
      const s = emitSig(sig, loc, seen, true), i = s.lastIndexOf(' => ')
      out.push(`${s.slice(0, i)}: ${s.slice(i + 4)};`)
    }
    for (const info of type.getIndexInfos()) {
      out.push(`${info.isReadonly ? 'readonly ' : ''}[key: ${emit(info.keyType, loc, new Set(seen))}]: ${emit(info.valueType, loc, new Set(seen))};`)
    }
    for (const prop of props) {
      const ro = isReadonlyProp(prop) ? 'readonly ' : ''
      const isOpt = Boolean(prop.flags & SymbolFlags.Optional)
      const opt = isOpt ? '?' : ''
      const rawPropType = checker.getTypeOfSymbolAtLocation(prop, loc)
      const propType =
        isOpt && (rawPropType.flags & TypeFlags.Union)
          ? (() => {
              const nonUndef = (rawPropType.getTypes() ?? []).filter((m) => !(m.flags & TypeFlags.Undefined))
              return nonUndef.length === 1 ? nonUndef[0] : rawPropType
            })()
          : rawPropType
      out.push(`${ro}${JSON.stringify(prop.name)}${opt}: ${emit(propType, loc, new Set(seen))};`)
    }
    return out
  }

  function emitHelper(id, baseName, type, loc, nominal = false) {
    const existing = shared.bySymbolId.get(id)
    if (existing) return existing
    const idx = ++shared.counter
    const safe = (baseName || 'Type').replace(/[^A-Za-z0-9_]/g, '_')
    const name = `__EP_${safe}_${idx}`
    shared.bySymbolId.set(id, name)
    const members = type.isObjectType() ? emitMembers(type, loc, new Set([type.id])) : []
    if (nominal) {
      const brand = `__ep_brand_${safe}_${idx}`
      shared.defs.push(`declare const ${brand}: unique symbol;\ninterface ${name} {\n  readonly [${brand}]: never;\n  ${members.join('\n  ')}\n}`)
    } else {
      shared.defs.push(`interface ${name} {\n  ${members.join('\n  ')}\n}`)
    }
    return name
  }

  function emit(type, loc, seen = new Set()) {
    if (!type || type.isErrorType()) throw new Error('TypeScript could not determine this type.')
    if (type.isTypeParameter()) throw new Error(`The type parameter ${checker.typeToString(type)} is local to a generic scope.`)

    if (type.flags & TypeFlags.Boolean) return 'boolean'
    if (type.isIntrinsicType?.()) return type.intrinsicName
    if (!(type.flags & TypeFlags.EnumLiteral)) {
      if (type.isStringLiteralType?.() || type.isNumberLiteralType?.() || type.isBooleanLiteralType?.()) {
        return JSON.stringify(type.value)
      }
      if (type.isBigIntLiteralType?.()) return `${type.value}n`
    }

    if (type.flags & TypeFlags.UniqueESSymbol) {
      const sym = type.getSymbol()
      if (sym && hasLocalDeclaration(sym)) throw new Error(`The unique symbol ${sym.name} is declared inside a function or block.`)
      const ext = sym ? resolveExternal(sym) : undefined
      return ext ? (ext.startsWith('typeof ') ? ext : `typeof ${ext}`) : emitHelper(symbolIdentity(checker, sym) || `sym_${type.id}`, sym?.name, type, loc, true)
    }
    if ((type.flags & TypeFlags.Union) && !(type.flags & TypeFlags.EnumLiteral && type.getSymbol())) {
      return `(${(type.getTypes() ?? []).map((m) => emit(m, loc, new Set(seen))).join(' | ')})`
    }
    if (type.flags & TypeFlags.Intersection) return `(${(type.getTypes() ?? []).map((m) => emit(m, loc, new Set(seen))).join(' & ')})`

    const alias = type.getAliasSymbol()
    if (alias) {
      if (hasLocalDeclaration(alias)) throw new Error(`The type ${alias.name} is declared inside a function or block and cannot be exposed safely.`)
      const aliasArgs = type.getAliasTypeArguments() ?? []
      const ext = resolveExternal(alias)
      if (ext) return aliasArgs.length ? `${ext}<${aliasArgs.map((a) => emit(a, loc, new Set(seen))).join(', ')}>` : ext
      if (!aliasArgs.length) {
        return emitHelper(symbolIdentity(checker, alias), alias.name, type, loc, isNominalUnexported(checker, alias))
      }
    }

    if (type.isTupleType?.() || (type.objectFlags & ObjectFlags.Tuple)) {
      const target = type.isTupleType?.() ? type.getTarget() : type
      const elemFlags = target.elementFlags ?? []
      const args = checker.getTypeArguments(type) ?? []
      const elems = args.map((a, i) => {
        const flag = elemFlags[i] ?? 0
        if (flag & ElementFlags.Rest) return `...${emit(a, loc, new Set(seen))}[]`
        if (flag & ElementFlags.Variadic) return `...${emit(a, loc, new Set(seen))}`
        if (flag & ElementFlags.Optional) {
          const nonUndef = (a.flags & TypeFlags.Union)
            ? (a.getTypes() ?? []).filter((m) => !(m.flags & TypeFlags.Undefined))
            : [a]
          const inner = nonUndef.length === 1 ? emit(nonUndef[0], loc, new Set(seen)) : emit(a, loc, new Set(seen))
          return `${inner}?`
        }
        return emit(a, loc, new Set(seen))
      })
      return `${target.readonly ? 'readonly ' : ''}[${elems.join(', ')}]`
    }

    const sym = type.getSymbol()
    if (sym && (sym.flags & namedTypeFlags)) {
      if (hasLocalDeclaration(sym)) throw new Error(`The type ${sym.name} is declared inside a function or block and cannot be exposed safely.`)
      const typeArgs = type.isTypeReference() ? (checker.getTypeArguments(type) ?? []) : []
      const ext = resolveExternal(sym)
      if (ext) return typeArgs.length ? `${ext}<${typeArgs.map((a) => emit(a, loc, new Set(seen))).join(', ')}>` : ext
      if (isNominalUnexported(checker, sym)) return emitHelper(symbolIdentity(checker, sym), sym.name, type, loc, true)
      if (!typeArgs.length) return emitHelper(symbolIdentity(checker, sym), sym.name, type, loc, false)
    }

    if (type.isObjectType()) {
      if (seen.has(type.id)) return emitHelper(`rec_${type.id}`, 'Anon', type, loc, false)
      seen.add(type.id)
      const callSigs = type.getCallSignatures()
      const props = type.getProperties().filter((p) => !isPrivateMember(p))
      if (callSigs.length === 1 && !type.getConstructSignatures().length && !props.length && !type.getIndexInfos().length) {
        return `(${emitSig(callSigs[0], loc, seen)})`
      }
      const members = emitMembers(type, loc, seen)
      return members.length ? `{ ${members.join(' ')} }` : '{}'
    }

    const node = checker.typeToTypeNode(type, undefined, NodeBuilderFlags.NoTruncation)
    if (!node) throw new Error('TypeScript could not represent this type in a virtual contract.')
    return api.printer.printNode(node)
  }

  return { emit }
}

let defaultApi
const getDefaultApi = () => (defaultApi ??= new API())

/**
 * Analyze all target files in a plan using a warm TypeScript 7.1 snapshot cache
 * (excluding .ep files and contentMappers to avoid recursion) and generate the
 * virtual `declare module 'execution-points-prototype'` ExecutionPointFileRegistry.
 */
export function generateFileRegistryModule(plan, { fromFile, api: externalApi, cache, compilerOptions: hostOptions, overrides = new Map() } = {}) {
  const registryRoot = fromFile ?? path.join(plan.root, 'points.ep')
  const api = externalApi ?? getDefaultApi()
  const byFile = new Map()

  if (!plan.files.length) {
    return { text: renderFileModule([], byFile), files: [] }
  }

  let ownBaseSnapshot
  let probeSnapshot
  try {
    const config = plan.tsconfig && existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
    const compilerOptions = {
      strict: true,
      ...config?.options,
      ...hostOptions,
    }

    const originals = new Map()
    for (const entry of plan.files) originals.set(entry.file, entry.source)
    for (const [f, s] of overrides) if (!f.endsWith('.ep')) originals.set(f, s)

    const rootFiles = [...originals.keys()].sort()
    const configKey = JSON.stringify({ rootFiles, compilerOptions })

    let baseSnapshot
    let baseProgram
    if (cache && cache.snapshot && cache.configKey === configKey) {
      const changed = []
      for (const [f, src] of originals) {
        if (cache.sources.get(f) !== src) changed.push([f, src])
      }
      if (changed.length > 0) {
        const next = cache.snapshot.update({
          fileSystem: createFileSystemLayer(changed),
          ensurePrograms: [cache.programId],
        })
        cache.snapshot.dispose()
        cache.snapshot = next
        for (const [f, src] of changed) cache.sources.set(f, src)
      }
      baseSnapshot = cache.snapshot
      baseProgram = baseSnapshot.getProgram(cache.programId)
    } else {
      cache?.snapshot?.dispose()
      baseSnapshot = api.createSnapshot({
        fileSystem: createFileSystemLayer([...originals]),
        createPrograms: [{ rootFiles, compilerOptions }],
      })
      baseProgram = baseSnapshot.operation.createdPrograms[0]
      if (cache) {
        cache.snapshot = baseSnapshot
        cache.programId = baseProgram.id
        cache.configKey = configKey
        cache.sources = new Map(originals)
      } else {
        ownBaseSnapshot = baseSnapshot
      }
    }

    const baseChecker = baseProgram.getProject().checker
    const shared = { defs: [], bySymbolId: new Map(), counter: 0 }
    const emitter = createTypeEmitter(api, baseChecker, baseProgram, registryRoot, shared)

    const nodeMeta = new Map()
    const nodesByFile = new Map()

    for (const entry of plan.files) {
      const sf = baseProgram.getSourceFile(entry.file)
      if (!sf?.externalModuleIndicator) continue

      const spanMap = new Map()
      for (const node of entry.nodes) spanMap.set(`${SyntaxKind[node.kind]}:${node.start}:${node.end}`, node)
      const astById = new Map()
      walk(sf, (astNode) => {
        const match = spanMap.get(`${astNode.kind}:${astNode.getStart(sf)}:${astNode.end}`)
        if (match && !astById.has(match.id)) astById.set(match.id, astNode)
      })

      const activeNodes = []
      const exprs = []
      for (const node of entry.nodes) {
        const expr = astById.get(node.id)
        if (expr) exprs.push({ node, expr })
      }
      const exprTypes = exprs.length ? baseChecker.getTypeAtLocation(exprs.map((e) => e.expr)) : []

      for (let i = 0; i < exprs.length; i++) {
        const { node, expr } = exprs[i]
        let resultTypeText
        try {
          resultTypeText = emitter.emit(exprTypes[i], expr)
        } catch {
          // Skip unportable expressions (e.g. unresolved local generic) instead of failing the file.
          continue
        }
        const validLocals = node.captures.filter((name) => Boolean(baseChecker.resolveName(name, SymbolFlags.Value, expr)))
        const isStatementExpr =
          expr.parent?.kind === SyntaxKind.ExpressionStatement &&
          [
            SyntaxKind.Block,
            SyntaxKind.SourceFile,
            SyntaxKind.CaseClause,
            SyntaxKind.DefaultClause,
          ].includes(expr.parent.parent?.kind)
        nodeMeta.set(node.id, { node, resultTypeText, probeNames: validLocals, isStatementExpr })
        activeNodes.push(node)
      }
      if (activeNodes.length) nodesByFile.set(entry.file, activeNodes)
    }

    // Phase 2: Nested incremental probe snapshot for exact narrowed local types
    const probeFiles = new Map()
    for (const [file, activeNodes] of nodesByFile) {
      const projected = projectNested(
        originals.get(file),
        activeNodes,
        (node) => {
          const { probeNames, isStatementExpr } = nodeMeta.get(node.id)
          const captures = probeNames.map((n) => `${JSON.stringify(n)}: ${n}`).join(', ')
          const markerObj = `{ ${JSON.stringify(markerName(node.id))}: 0${captures ? `, ${captures}` : ''} }`
          return isStatementExpr ? `void ${markerObj}; ` : `(void ${markerObj}, (`
        },
        (node) => (nodeMeta.get(node.id).isStatementExpr ? '' : '))'),
      )
      probeFiles.set(file, projected)
    }

    if (probeFiles.size > 0) {
      probeSnapshot = baseSnapshot.update({
        fileSystem: createFileSystemLayer([...probeFiles]),
        ensurePrograms: [baseProgram.id],
      })
      const probeProgram = probeSnapshot.getProgram(baseProgram.id)
      const probeChecker = probeProgram.getProject().checker
      const probeEmitter = createTypeEmitter(api, probeChecker, probeProgram, registryRoot, shared)

      for (const [file, activeNodes] of nodesByFile) {
        const sf = probeProgram.getSourceFile(file)
        const probeObjs = new Map()
        walk(sf, (astNode) => {
          if (astNode.kind === SyntaxKind.ObjectLiteralExpression) {
            const first = astNode.properties[0]?.name?.text
            if (first?.startsWith('__execution_point_')) probeObjs.set(first, astNode)
          }
        })

        const initProps = []
        for (const node of activeNodes) {
          const captureObj = probeObjs.get(markerName(node.id))
          if (captureObj) {
            for (const prop of captureObj.properties.slice(1)) {
              initProps.push({ nodeId: node.id, name: prop.name.text, initializer: prop.initializer })
            }
          }
        }
        const initTypes = initProps.length
          ? probeChecker.getTypeAtLocation(initProps.map((p) => p.initializer))
          : []
        const localsByNodeId = new Map()
        for (let i = 0; i < initProps.length; i++) {
          const { nodeId, name, initializer } = initProps[i]
          try {
            let map = localsByNodeId.get(nodeId)
            if (!map) {
              map = {}
              localsByNodeId.set(nodeId, map)
            }
            map[name] = probeEmitter.emit(initTypes[i], initializer)
          } catch {
            // Silently omit unportable locals for this node
          }
        }

        const emittedNodes = activeNodes.map((node) => ({
          ...node,
          result: nodeMeta.get(node.id).resultTypeText,
          locals: localsByNodeId.get(node.id) ?? {},
        }))
        const relFile = activeNodes[0].relativeFile
        byFile.set(relFile, emittedNodes)
      }
    }

    return { text: renderFileModule(shared.defs, byFile), files: [...byFile.keys()] }
  } finally {
    probeSnapshot?.dispose()
    ownBaseSnapshot?.dispose()
  }
}

function renderFileModule(helperDefs, byFile) {
  const lines = [
    '// Virtual execution-points file schema (generated in memory by TypeScript 7.1 content mapper).',
    "import type {} from 'execution-points-prototype';",
    '',
  ]
  for (const def of helperDefs) lines.push(def, '')
  lines.push("declare module 'execution-points-prototype' {", '  interface ExecutionPointFileRegistry {')
  for (const [file, nodes] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${JSON.stringify(file)}:`)
    for (const node of nodes) {
      const localEntries = Object.entries(node.locals)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, type]) => `readonly ${JSON.stringify(name)}: ${type};`)
        .join(' ')
      const extra =
        node.kind === 'CallExpression'
          ? ` readonly callee: ${JSON.stringify(node.callee)};`
          : node.kind === 'BinaryExpression'
            ? ` readonly operator: ${JSON.stringify(node.operator)};`
            : ''
      lines.push(
        `      | { readonly id: ${JSON.stringify(node.id)}; readonly kind: ${JSON.stringify(node.kind)}; readonly inFunction: ${JSON.stringify(node.inFunction)};${extra} readonly nth: ${node.nth}; readonly result: ${node.result}; readonly locals: { ${localEntries} } }`,
      )
    }
    if (!nodes.length) lines.push('      never')
    lines[lines.length - 1] += ';'
  }
  lines.push('  }', '}', '')
  return lines.join('\n')
}
