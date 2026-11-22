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
    at(node.start).opens.push({ start: node.start, end: node.end, id: node.id, text: prefixOf(node) })
    at(node.end).closes.push({ start: node.start, end: node.end, id: node.id, text: suffixOf(node) })
  }
  const offsets = [...buckets.keys()].sort((a, b) => a - b)
  let out = '', cursor = 0
  for (const offset of offsets) {
    out += source.slice(cursor, offset)
    const b = buckets.get(offset)
    b.closes.sort((a, b) => b.start - a.start || b.id.localeCompare(a.id))
    b.opens.sort((a, b) => b.end - a.end || a.id.localeCompare(b.id))
    out += b.closes.map((e) => e.text).join('') + b.opens.map((e) => e.text).join('')
    cursor = offset
  }
  return out + source.slice(cursor)
}

const sameFile = (a, b) => Boolean(a && b) && (a === b || a.toLowerCase() === b.toLowerCase())
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
    for (let p = h.resolve()?.parent; p && p.kind !== SyntaxKind.SourceFile; p = p.parent) {
      if (localScopes.has(p.kind)) return true
    }
    return false
  })
}

function getSourceFileCI(program, filePath, byLower) {
  return program.getSourceFile(filePath) ?? byLower.get(filePath.toLowerCase())
}

function isAmbientOrGlobal(checker, sym, program, byLower) {
  const resolved = resolveAlias(checker, sym)
  if (!resolved?.declarations.length) return true
  return resolved.declarations.every((h) => !getSourceFileCI(program, h.path, byLower)?.externalModuleIndicator)
}

function isDeclaredInFile(checker, sym, filePath) {
  const resolved = resolveAlias(checker, sym)
  return Boolean(resolved?.declarations.some((h) => sameFile(h.path, filePath)))
}

function isSafeAutoLocal(checker, sym, sf, targetStart) {
  if (!sym?.name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sym.name) || sym.name.startsWith('__execution_point_')) return false
  if (sym.flags & (SymbolFlags.Alias | SymbolFlags.TypeParameter | SymbolFlags.Module)) return false
  if (!isDeclaredInFile(checker, sym, sf.fileName) || !hasLocalDeclaration(sym)) return false
  return sym.declarations.every((h) => {
    const d = h.resolve()
    return d && (d.kind === SyntaxKind.Parameter || d.kind === SyntaxKind.FunctionDeclaration || d.end <= targetStart)
  })
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
function buildExportIndex(checker, program, sf, fromFile, byLower) {
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
    if (sym && (sym.flags & namedTypeFlags) && isDeclaredInFile(checker, sym, sf.fileName) && !hasLocalDeclaration(sym)) {
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
    if (type.isObjectType() && !isAmbientOrGlobal(checker, sym, program, byLower)) {
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
  const byLower = new Map()
  for (const sf of program.getSourceFiles?.() ?? []) byLower.set(sf.fileName.toLowerCase(), sf)
  const exportIndices = new Map()

  const getExportIndex = (filePath) => {
    const key = filePath.toLowerCase()
    let idx = exportIndices.get(key)
    if (!idx) {
      const sf = getSourceFileCI(program, filePath, byLower)
      idx = sf ? buildExportIndex(checker, program, sf, fromFile, byLower) : new Map()
      exportIndices.set(key, idx)
    }
    return idx
  }

  const resolveExternal = (sym) => {
    const resolved = resolveAlias(checker, sym)
    if (!resolved) return undefined
    if (isAmbientOrGlobal(checker, resolved, program, byLower)) return resolved.name
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
    const params = sig.getParameters().map((p, i) => {
      const opt = p.flags & SymbolFlags.Optional ? '?' : ''
      const rest = p.declarations?.some((h) => Boolean(h.resolve()?.dotDotDotToken)) ? '...' : ''
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.name) ? p.name : `arg${i}`
      return `${rest}${name}${opt}: ${emit(checker.getParameterType(sig, i), loc, new Set(seen))}`
    })
    return `${isNew ? 'new ' : ''}(${params.join(', ')}) => ${emit(sig.getReturnType(), loc, new Set(seen))}`
  }

  function emitMembers(type, loc, seen) {
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
      out.push(`${info.isReadonly ? 'readonly ' : ''}[key: ${emit(info.keyType, loc, new Set(seen))}]: ${emit(info.type, loc, new Set(seen))};`)
    }
    for (const prop of type.getProperties()) {
      if (isPrivateMember(prop)) continue
      const ro = isReadonlyProp(prop) ? 'readonly ' : ''
      const opt = prop.flags & SymbolFlags.Optional ? '?' : ''
      out.push(`${ro}${JSON.stringify(prop.name)}${opt}: ${emit(checker.getTypeOfSymbolAtLocation(prop, loc), loc, new Set(seen))};`)
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
    if (type.flags & TypeFlags.Any) throw new Error('This type is any; execution-points requires a concrete checked type.')
    if (type.isTypeParameter()) throw new Error(`The type parameter ${checker.typeToString(type)} is local to a generic scope.`)

    if (type.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt | TypeFlags.Void |
        TypeFlags.Undefined | TypeFlags.Null | TypeFlags.Never | TypeFlags.Unknown | TypeFlags.ESSymbol |
        TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BigIntLiteral | TypeFlags.BooleanLiteral)) {
      const node = checker.typeToTypeNode(type, undefined, NodeBuilderFlags.NoTruncation)
      if (!node) throw new Error('TypeScript could not represent this primitive/literal type.')
      return api.printer.printNode(node)
    }

    if (type.flags & TypeFlags.UniqueESSymbol) {
      const sym = type.getSymbol()
      if (sym && hasLocalDeclaration(sym)) throw new Error(`The unique symbol ${sym.name} is declared inside a function or block.`)
      const ext = sym ? resolveExternal(sym) : undefined
      return ext ? `typeof ${ext}` : emitHelper(symbolIdentity(checker, sym) || `sym_${type.id}`, sym?.name, type, loc, true)
    }
    if (type.flags & TypeFlags.Union) return `(${(type.getTypes() ?? []).map((m) => emit(m, loc, new Set(seen))).join(' | ')})`
    if (type.flags & TypeFlags.Intersection) return `(${(type.getTypes() ?? []).map((m) => emit(m, loc, new Set(seen))).join(' & ')})`

    const alias = type.getAliasSymbol()
    if (alias) {
      if (hasLocalDeclaration(alias)) throw new Error(`The type ${alias.name} is declared inside a function or block and cannot be exposed safely.`)
      const aliasArgs = type.getAliasTypeArguments() ?? []
      const ext = resolveExternal(alias)
      if (ext) return aliasArgs.length ? `${ext}<${aliasArgs.map((a) => emit(a, loc, new Set(seen))).join(', ')}>` : ext
      if (!aliasArgs.length) return emitHelper(symbolIdentity(checker, alias), alias.name, type, loc, false)
    }

    if (type.isTupleType?.() || (type.objectFlags & ObjectFlags.Tuple)) {
      const args = checker.getTypeArguments(type) ?? []
      return `${type.getTargetType?.()?.readonly ? 'readonly ' : ''}[${args.map((a) => emit(a, loc, new Set(seen))).join(', ')}]`
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

/**
 * Analyze all target files in a plan using a warm TypeScript 7.1 snapshot cache
 * (excluding .ep files and contentMappers to avoid recursion) and generate the
 * virtual `declare module 'execution-points-prototype'` ExecutionPointFileRegistry.
 */
export function generateFileRegistryModule(plan, { fromFile, api: externalApi, cache, compilerOptions: hostOptions, overrides = new Map() } = {}) {
  const registryRoot = fromFile ?? path.join(plan.root, 'points.ep')
  const ownApi = !externalApi
  const api = externalApi ?? new API({ cwd: plan.root })
  const byFile = new Map()

  if (!plan.files.length) {
    if (ownApi) api.close()
    return { text: renderFileModule([], byFile), files: [] }
  }

  let ownBaseSnapshot
  let probeSnapshot
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

    const originals = new Map()
    for (const entry of plan.files) originals.set(entry.file, entry.source)
    for (const [f, s] of overrides) if (!f.endsWith('.ep')) originals.set(f, s)

    const rootFiles = [
      ...new Set([
        ...(config?.fileNames ?? []).filter((f) => !f.endsWith('.ep') && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx')),
        ...originals.keys(),
      ]),
    ].sort()
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
      for (const node of entry.nodes) {
        const expr = astById.get(node.id)
        if (!expr) continue
        let resultTypeText
        try {
          resultTypeText = emitter.emit(baseChecker.getTypeAtLocation(expr), expr)
        } catch {
          // Skip unportable expressions (e.g. `any` or unresolved local generic) instead of failing the file.
          continue
        }
        const validLocals = node.captures.filter((name) => Boolean(baseChecker.resolveName(name, SymbolFlags.Value, expr)))
        nodeMeta.set(node.id, { node, resultTypeText, probeNames: validLocals })
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
          const names = nodeMeta.get(node.id).probeNames
          const captures = names.map((n) => `${JSON.stringify(n)}: ${n}`).join(', ')
          return `(void { ${JSON.stringify(markerName(node.id))}: 0${captures ? `, ${captures}` : ''} }, (`
        },
        () => '))',
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

        const emittedNodes = []
        for (const node of activeNodes) {
          const { resultTypeText } = nodeMeta.get(node.id)
          const captureObj = probeObjs.get(markerName(node.id))
          const locals = {}
          if (captureObj) {
            for (const prop of captureObj.properties.slice(1)) {
              try {
                locals[prop.name.text] = probeEmitter.emit(probeChecker.getTypeAtLocation(prop.initializer), prop.initializer)
              } catch {
                // Silently omit unportable locals for this node
              }
            }
          }
          emittedNodes.push({ ...node, result: resultTypeText, locals })
        }
        const relFile = activeNodes[0].relativeFile
        byFile.set(relFile, emittedNodes)
      }
    }

    return { text: renderFileModule(shared.defs, byFile), files: [...byFile.keys()] }
  } finally {
    probeSnapshot?.dispose()
    ownBaseSnapshot?.dispose()
    if (ownApi) api.close()
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
