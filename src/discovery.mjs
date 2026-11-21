import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import esquery from 'esquery'
import { API } from 'typescript/sync'
import { NodeFlags, SyntaxKind } from 'typescript/ast'

const packageName = 'execution-points-prototype'
const expressionKinds = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ParenthesizedExpression,
])
const literalKinds = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
])
const reservedWords = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
])

const kindNames = new Map()
for (const [key, value] of Object.entries(SyntaxKind)) {
  if (typeof value === 'number' && !kindNames.has(value)) kindNames.set(value, key)
}

export function loadManifest(root = process.cwd(), file = 'points.ep') {
  const manifestPath = resolve(root, file)
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { root: resolve(root), manifestPath, ...raw }
}

export function resolveTestFiles(root, configuredFiles = []) {
  const resolved = new Set()
  for (const entry of configuredFiles) {
    if (/[*?[\]{}]/.test(entry)) {
      for (const match of globSync(entry, { cwd: root })) resolved.add(resolve(root, match))
    } else {
      resolved.add(resolve(root, entry))
    }
  }
  return [...resolved].sort()
}

function lineCol(source, offset) {
  const before = source.slice(0, offset)
  const lines = before.split('\n')
  return { line: lines.length, col: lines[lines.length - 1].length + 1 }
}

function fail(file, source, node, tree, message) {
  const { line, col } = lineCol(source, node.getStart(tree))
  throw new Error(`${file}:${line}:${col}: ${message}`)
}

function nodeProp(node, key, sourceFile) {
  if (node == null || typeof node !== 'object') return undefined
  if (node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier) {
    if (key === 'escapedText' || key === 'name' || key === 'text') return node.text
  }
  if (key === 'kindName') return kindNames.get(node.kind) ?? ''
  if (key === 'value' && literalKinds.has(node.kind)) {
    if (node.kind === SyntaxKind.TrueKeyword) return true
    if (node.kind === SyntaxKind.FalseKeyword) return false
    if (node.kind === SyntaxKind.NullKeyword) return null
    if (node.kind === SyntaxKind.NumericLiteral) return Number(node.text)
    if (node.kind === SyntaxKind.RegularExpressionLiteral) return new RegExp(node.text)
    return node.text
  }
  if (key in node && node[key] !== undefined) return node[key]
  if (key === 'text' && node.pos >= 0) return node.getText(sourceFile)
  return undefined
}

function getPath(node, pathExpr, sourceFile) {
  let current = node
  for (const key of pathExpr.split('.')) {
    if (current == null) return undefined
    current = typeof current === 'object' && 'kind' in current
      ? nodeProp(current, key, sourceFile)
      : current[key]
  }
  return current
}

function matchAttr(node, sel, sourceFile) {
  const actual = getPath(node, sel.name, sourceFile)
  if (actual === undefined) return false
  if (sel.operator == null) return actual != null
  if (!sel.value) return false
  const { type, value } = sel.value
  const eq = type === 'regexp'
    ? typeof actual === 'string' && value.test(actual)
    : type === 'type'
      ? value === typeof actual
      : `${value}` === `${actual}`
  switch (sel.operator) {
    case '=': return eq
    case '!=': return !eq
    case '<': return actual < value
    case '<=': return actual <= value
    case '>': return actual > value
    case '>=': return actual >= value
    default: return false
  }
}

function siblingsOf(ancestors) {
  const parent = ancestors[0]
  if (!parent) return []
  const out = []
  parent.forEachChild((c) => { out.push(c) })
  return out
}

function matchesSelector(node, sel, ancestors, sf) {
  if (!sel) return true
  switch (sel.type) {
    case 'wildcard': return true
    case 'identifier': return (kindNames.get(node.kind) ?? '').toLowerCase() === sel.value.toLowerCase()
    case 'attribute': return matchAttr(node, sel, sf)
    case 'compound': return sel.selectors.every((s) => matchesSelector(node, s, ancestors, sf))
    case 'matches': return sel.selectors.some((s) => matchesSelector(node, s, ancestors, sf))
    case 'not': return !sel.selectors.some((s) => matchesSelector(node, s, ancestors, sf))
    case 'descendant':
      if (!matchesSelector(node, sel.right, ancestors, sf)) return false
      return ancestors.some((anc, i) => matchesSelector(anc, sel.left, ancestors.slice(i + 1), sf))
    case 'child':
      return ancestors.length > 0 &&
        matchesSelector(node, sel.right, ancestors, sf) &&
        matchesSelector(ancestors[0], sel.left, ancestors.slice(1), sf)
    case 'field': {
      const target = ancestors[0] ? getPath(ancestors[0], sel.name, sf) : undefined
      return Array.isArray(target) ? target.includes(node) : target === node
    }
    case 'has': {
      let found = false
      const walk = (child, anc) => {
        if (found) return
        if (sel.selectors.some((s) => matchesSelector(child, s, anc, sf))) { found = true; return }
        anc.unshift(child)
        child.forEachChild((n) => walk(n, anc))
        anc.shift()
      }
      node.forEachChild((c) => walk(c, [node, ...ancestors]))
      return found
    }
    case 'adjacent':
    case 'sibling': {
      if (!matchesSelector(node, sel.right, ancestors, sf)) return false
      const sibs = siblingsOf(ancestors)
      const idx = sibs.indexOf(node)
      if (sel.type === 'adjacent') return idx > 0 && matchesSelector(sibs[idx - 1], sel.left, ancestors, sf)
      return sibs.slice(0, idx).some((s) => matchesSelector(s, sel.left, ancestors, sf))
    }
    case 'nth-child':
      return siblingsOf(ancestors).indexOf(node) === sel.index.value - 1
    case 'nth-last-child': {
      const sibs = siblingsOf(ancestors)
      const idx = sibs.indexOf(node)
      return idx !== -1 && sibs.length - idx === sel.index.value
    }
    default:
      return false
  }
}

export function queryAst(sourceFile, selectorText) {
  const parsed = esquery.parse(selectorText)
  const results = []
  const ancestors = []
  const visit = (node) => {
    if (matchesSelector(node, parsed, ancestors, sourceFile)) results.push(node)
    ancestors.unshift(node)
    node.forEachChild(visit)
    ancestors.shift()
  }
  visit(sourceFile)
  return results
}

function collectBindingNames(nameNode, out) {
  if (!nameNode) return
  if (nameNode.kind === SyntaxKind.Identifier) { out.add(nameNode.text); return }
  if (nameNode.elements) for (const el of nameNode.elements) collectBindingNames(el.name, out)
}

function directScopeDecls(node) {
  const names = new Set()
  if (node.parameters) for (const p of node.parameters) collectBindingNames(p.name, names)
  if (node.variableDeclaration) collectBindingNames(node.variableDeclaration.name, names)
  const statements = node.statements ?? (node.kind === SyntaxKind.ForStatement || node.kind === SyntaxKind.ForInStatement || node.kind === SyntaxKind.ForOfStatement ? [node.initializer] : [])
  for (const stmt of statements) {
    if (!stmt) continue
    if ((stmt.kind === SyntaxKind.FunctionDeclaration || stmt.kind === SyntaxKind.ClassDeclaration) && stmt.name) {
      names.add(stmt.name.text)
    } else if (stmt.kind === SyntaxKind.VariableStatement) {
      for (const decl of stmt.declarationList.declarations) collectBindingNames(decl.name, names)
    } else if (stmt.kind === SyntaxKind.VariableDeclarationList) {
      for (const decl of stmt.declarations) collectBindingNames(decl.name, names)
    }
  }
  return names
}

const isStringLiteral = (n) => n && (n.kind === SyntaxKind.StringLiteral || n.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
const isAssignmentOp = (k) => k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment

function readSpec(node, tree, file, source) {
  if (node.kind !== SyntaxKind.ObjectLiteralExpression) fail(file, source, node, tree, 'point() requires a literal object.')
  const values = new Map()
  for (const p of node.properties) {
    if (p.kind !== SyntaxKind.PropertyAssignment) fail(file, source, p, tree, 'Point properties must be literal property assignments.')
    const name = p.name.kind === SyntaxKind.Identifier || p.name.kind === SyntaxKind.StringLiteral ? p.name.text : undefined
    if (!['file', 'query', 'capture'].includes(name) || values.has(name)) {
      fail(file, source, p, tree, `Unsupported or duplicated point property: ${name ?? p.name.getText(tree)}`)
    }
    values.set(name, p.initializer)
  }
  const spec = {}
  for (const name of ['file', 'query']) {
    const val = values.get(name)
    if (!isStringLiteral(val)) fail(file, source, node, tree, `point.${name} must be a string literal.`)
    spec[name] = val.text
  }
  const captures = values.get('capture')
  if (captures && captures.kind !== SyntaxKind.ArrayLiteralExpression) {
    fail(file, source, captures, tree, 'capture must be an array of literal binding names.')
  }
  spec.capture = (captures?.elements ?? []).map((val) => {
    if (!isStringLiteral(val)) fail(file, source, val, tree, 'Captured binding names must be string literals.')
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(val.text) || reservedWords.has(val.text)) {
      fail(file, source, val, tree, `Capture requires an identifier name, received ${JSON.stringify(val.text)}.`)
    }
    return val.text
  })
  if (new Set(spec.capture).size !== spec.capture.length) fail(file, source, captures, tree, 'Capture names must be unique.')
  return spec
}

function validateExpression(node, tree, file, source) {
  if (!expressionKinds.has(node.kind)) fail(file, source, node, tree, `Unsupported target kind ${kindNames.get(node.kind)}; select a value expression.`)
  if (node.kind === SyntaxKind.BinaryExpression && isAssignmentOp(node.operatorToken.kind)) {
    fail(file, source, node, tree, 'Assignment expressions are not supported.')
  }
  let cur = node
  while (cur.parent && [
    SyntaxKind.ParenthesizedExpression, SyntaxKind.AsExpression, SyntaxKind.TypeAssertionExpression,
    SyntaxKind.NonNullExpression, SyntaxKind.SatisfiesExpression,
  ].includes(cur.parent.kind)) cur = cur.parent
  const p = cur.parent
  if (p && (
    ((p.kind === SyntaxKind.CallExpression || p.kind === SyntaxKind.NewExpression) && p.expression === cur) ||
    (p.kind === SyntaxKind.TaggedTemplateExpression && p.tag === cur) ||
    (p.kind === SyntaxKind.BinaryExpression && p.left === cur && isAssignmentOp(p.operatorToken.kind)) ||
    p.kind === SyntaxKind.DeleteExpression || p.kind === SyntaxKind.PostfixUnaryExpression ||
    (p.kind === SyntaxKind.PrefixUnaryExpression && [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(p.operator))
  )) {
    fail(file, source, node, tree, 'This position requires a reference, not just a value. Select the whole call or a value-producing expression.')
  }
  const visit = (part) => {
    if ([SyntaxKind.AwaitExpression, SyntaxKind.YieldExpression, SyntaxKind.SuperKeyword].includes(part.kind) ||
        part.questionDotToken || (part.flags & NodeFlags.OptionalChain)) {
      fail(file, source, part, tree, 'await/yield/super/optional-chain expressions are not supported yet. Select the inner ordinary expression where possible.')
    }
    if (part.kind === SyntaxKind.CallExpression && (
      part.expression.kind === SyntaxKind.ImportKeyword ||
      (part.expression.kind === SyntaxKind.Identifier && part.expression.text === 'eval')
    )) {
      fail(file, source, part, tree, 'Dynamic import and direct eval are not supported targets.')
    }
    part.forEachChild(visit)
  }
  visit(node)
}

/** Discover literal point declarations using TypeScript 7.1's AST. */
export function buildPlan(options) {
  const root = resolve(options.root ?? process.cwd())
  const overrides = options.overrides ?? new Map()
  const tolerant = Boolean(options.tolerant)
  const read = (file) => (overrides.has(file) ? overrides.get(file) : readFileSync(file, 'utf8'))
  const ownApi = !options.api
  const api = options.api ?? new API({ cwd: root })
  const retained = []
  const parse = (file, source) => {
    const lease = api.createSourceFile(file, source)
    retained.push(lease)
    return lease.sourceFile
  }

  try {
    const parsedTargets = new Map()
    const targetByPosition = new Map()
    const tests = []
    const errors = []

    for (const file of resolveTestFiles(root, options.testFiles ?? [])) {
      if (!overrides.has(file) && !existsSync(file)) {
        if (tolerant) { errors.push({ file: relative(root, file), message: `Test file not found: ${relative(root, file)}` }); continue }
        throw new Error(`Configured test file not found: ${file}`)
      }
      const source = read(file)
      const tree = parse(file, source)
      const importedNames = new Set()
      for (const stmt of tree.statements) {
        if (stmt.kind !== SyntaxKind.ImportDeclaration || stmt.moduleSpecifier.text !== packageName) continue
        const nb = stmt.importClause?.namedBindings
        if (nb?.kind === SyntaxKind.NamedImports) {
          for (const el of nb.elements) {
            if ((el.propertyName ?? el.name).text === 'point') importedNames.add(el.name.text)
          }
        }
      }

      const points = []
      const scopeStack = []
      const isShadowed = (name) => scopeStack.some((set) => set.has(name))

      const visit = (node) => {
        if (
          node.kind === SyntaxKind.CallExpression &&
          node.expression.kind === SyntaxKind.Identifier &&
          importedNames.has(node.expression.text) &&
          !isShadowed(node.expression.text)
        ) {
          let spec
          try {
            if (node.arguments.length !== 1 || node.typeArguments?.length) {
              fail(file, source, node, tree, 'Use point({ file, query, capture }) with one literal argument and no manual type arguments.')
            }
            spec = readSpec(node.arguments[0], tree, file, source)
            if (isAbsolute(spec.file)) fail(file, source, node, tree, 'Target paths must be project-relative.')
            const targetFile = resolve(root, spec.file)
            const relTarget = relative(root, targetFile)
            if (relTarget.startsWith('..') || isAbsolute(relTarget)) fail(file, source, node, tree, 'Targets must be inside the project root.')
            if (targetFile === file) fail(file, source, node, tree, 'Target a separate application module.')
            if (!overrides.has(targetFile) && !existsSync(targetFile)) fail(file, source, node, tree, `Target file does not exist: ${spec.file}`)

            let targetEntry = parsedTargets.get(targetFile)
            if (!targetEntry) {
              const targetSource = read(targetFile)
              targetEntry = { source: targetSource, tree: parse(targetFile, targetSource) }
              parsedTargets.set(targetFile, targetEntry)
            }
            let matches
            try { matches = queryAst(targetEntry.tree, spec.query) }
            catch (err) { fail(file, source, node, tree, `Invalid AST selector: ${err.message}`) }
            if (matches.length !== 1) fail(file, source, node, tree, `AST selector must match exactly one expression; matched ${matches.length} in ${spec.file}.`)
            const selected = matches[0]
            validateExpression(selected, targetEntry.tree, targetFile, targetEntry.source)

            const start = selected.getStart(targetEntry.tree)
            const end = selected.end
            const position = `${targetFile}:${start}:${end}`
            let target = targetByPosition.get(position)
            if (!target) {
              const id = createHash('sha256')
                .update(`${relTarget}\0${targetEntry.source}\0${start}:${end}`)
                .digest('hex')
                .slice(0, 12)
              target = {
                id,
                file: targetFile,
                relativeFile: spec.file,
                source: targetEntry.source,
                start,
                end,
                captures: [...spec.capture],
                queries: new Set([spec.query]),
              }
              targetByPosition.set(position, target)
            } else {
              for (const cap of spec.capture) if (!target.captures.includes(cap)) target.captures.push(cap)
              target.queries.add(spec.query)
            }
            points.push({ targetId: target.id, spec, runtimeInsert: node.arguments[0].end })
          } catch (error) {
            if (!tolerant) throw error
            errors.push({ file: spec?.file, query: spec?.query, testFile: file, message: error.message.replace(/^.*?:\d+:\d+:\s*/, '') })
          }
        }
        const localDecls = node.kind === SyntaxKind.SourceFile ? null : directScopeDecls(node)
        if (localDecls?.size) scopeStack.push(localDecls)
        node.forEachChild(visit)
        if (localDecls?.size) scopeStack.pop()
      }
      visit(tree)
      tests.push({ file, source, points })
    }

    const targets = [...targetByPosition.values()].map((t) => ({ ...t, queries: [...t.queries] }))
    const overlapping = new Set()
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i], b = targets[j]
        if (a.file === b.file && a.start < b.end && b.start < a.end) {
          const message = `Overlapping target expressions in ${a.relativeFile} are not supported yet.`
          if (!tolerant) throw new Error(message)
          overlapping.add(a.id)
          overlapping.add(b.id)
          for (const t of [a, b]) for (const q of t.queries) errors.push({ file: t.relativeFile, query: q, message })
        }
      }
    }
    const validTargets = overlapping.size ? targets.filter((t) => !overlapping.has(t.id)) : targets
    if (!tolerant && !validTargets.length) {
      throw new Error('No point() declarations found. Import point from execution-points-prototype and use literal selectors.')
    }
    return { root, tsconfig: resolve(root, options.tsconfig ?? 'tsconfig.json'), tests, targets: validTargets, errors }
  } finally {
    for (const lease of retained) lease.dispose()
    if (ownApi) api.close()
  }
}
