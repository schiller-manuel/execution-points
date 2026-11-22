import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { API } from 'typescript/sync'
import { NodeFlags, SyntaxKind } from 'typescript/ast'

const isAssignmentOp = (k) => k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment
const indexableKinds = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.ConditionalExpression,
])

export function loadManifest(root = process.cwd(), file = 'points.ep') {
  const manifestPath = resolve(root, file)
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { root: resolve(root), manifestPath, ...raw }
}

export function resolveTargetFiles(root, configuredTargets = []) {
  const resolved = new Set()
  for (const entry of configuredTargets) {
    if (/[*?[\]{}]/.test(entry)) {
      for (const match of globSync(entry, { cwd: root })) resolved.add(resolve(root, match))
    } else {
      resolved.add(resolve(root, entry))
    }
  }
  return [...resolved].sort()
}

function isSelectableExpression(node) {
  if (!indexableKinds.has(node.kind)) return false
  if (node.kind === SyntaxKind.BinaryExpression && isAssignmentOp(node.operatorToken.kind)) return false

  let cur = node
  while (
    cur.parent &&
    [
      SyntaxKind.ParenthesizedExpression,
      SyntaxKind.AsExpression,
      SyntaxKind.TypeAssertionExpression,
      SyntaxKind.NonNullExpression,
      SyntaxKind.SatisfiesExpression,
    ].includes(cur.parent.kind)
  ) {
    cur = cur.parent
  }
  const p = cur.parent
  if (
    p &&
    (((p.kind === SyntaxKind.CallExpression || p.kind === SyntaxKind.NewExpression) && p.expression === cur) ||
      (p.kind === SyntaxKind.TaggedTemplateExpression && p.tag === cur) ||
      (p.kind === SyntaxKind.BinaryExpression && p.left === cur && isAssignmentOp(p.operatorToken.kind)) ||
      p.kind === SyntaxKind.DeleteExpression ||
      p.kind === SyntaxKind.PostfixUnaryExpression ||
      (p.kind === SyntaxKind.PrefixUnaryExpression &&
        [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(p.operator)))
  ) {
    return false
  }

  let unsupported = false
  const check = (part) => {
    if (unsupported) return
    if (
      [SyntaxKind.AwaitExpression, SyntaxKind.YieldExpression, SyntaxKind.SuperKeyword].includes(part.kind) ||
      part.questionDotToken ||
      (part.flags & NodeFlags.OptionalChain)
    ) {
      unsupported = true
      return
    }
    if (
      part.kind === SyntaxKind.CallExpression &&
      (part.expression.kind === SyntaxKind.ImportKeyword ||
        (part.expression.kind === SyntaxKind.Identifier && part.expression.text === 'eval'))
    ) {
      unsupported = true
      return
    }
    part.forEachChild(check)
  }
  check(node)
  return !unsupported
}

function enclosingFunctionName(node) {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return node.name?.text ?? '(anonymous)'
    case SyntaxKind.Constructor:
      return 'constructor'
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction: {
      if (node.name?.text) return node.name.text
      const parent = node.parent
      if (parent?.kind === SyntaxKind.VariableDeclaration && parent.name?.kind === SyntaxKind.Identifier) {
        return parent.name.text
      }
      if (parent?.kind === SyntaxKind.PropertyAssignment && parent.name?.text) {
        return parent.name.text
      }
      return '(anonymous)'
    }
    default:
      return undefined
  }
}

function callCalleeName(node) {
  const expr = node.expression
  if (expr.kind === SyntaxKind.Identifier) return expr.text
  if (expr.kind === SyntaxKind.PropertyAccessExpression) return expr.name.text
  if (expr.kind === SyntaxKind.ElementAccessExpression && expr.argumentExpression?.kind === SyntaxKind.StringLiteral) {
    return expr.argumentExpression.text
  }
  return '(anonymous)'
}

function collectBindingEntries(nameNode, endPos, out) {
  if (!nameNode) return
  if (nameNode.kind === SyntaxKind.Identifier) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nameNode.text)) {
      out.push({ name: nameNode.text, readyAt: endPos })
    }
    return
  }
  if (nameNode.elements) {
    for (const el of nameNode.elements) collectBindingEntries(el.name, endPos, out)
  }
}

function scopeBindingsOf(node) {
  const entries = []
  if (node.parameters) {
    for (const p of node.parameters) collectBindingEntries(p.name, -1, entries)
  }
  if (node.variableDeclaration) {
    collectBindingEntries(node.variableDeclaration.name, -1, entries)
  }
  const statements =
    node.statements ??
    ([SyntaxKind.ForStatement, SyntaxKind.ForInStatement, SyntaxKind.ForOfStatement].includes(node.kind)
      ? [node.initializer]
      : [])
  for (const stmt of statements) {
    if (!stmt) continue
    if (stmt.kind === SyntaxKind.FunctionDeclaration && stmt.name) {
      entries.push({ name: stmt.name.text, readyAt: -1 })
    } else if (stmt.kind === SyntaxKind.ClassDeclaration && stmt.name) {
      entries.push({ name: stmt.name.text, readyAt: stmt.end })
    } else if (stmt.kind === SyntaxKind.VariableStatement) {
      for (const decl of stmt.declarationList.declarations) collectBindingEntries(decl.name, decl.end, entries)
    } else if (stmt.kind === SyntaxKind.VariableDeclarationList) {
      for (const decl of stmt.declarations) collectBindingEntries(decl.name, decl.end, entries)
    }
  }
  return entries
}

/** Index all selectable expressions in a single target module using TypeScript 7.1's AST. */
export function indexTargetFile(file, source, root, api) {
  const lease = api.createSourceFile(file, source)
  try {
    const tree = lease.sourceFile
    const relativeFile = relative(root, file).replaceAll('\\', '/')
    const fnStack = []
    const localScopeStack = []
    const nthCounters = new Map()
    const nodes = []

    const activeLocalsAt = (pos) => {
      const names = new Set()
      for (const frame of localScopeStack) {
        for (const entry of frame) {
          if (entry.readyAt <= pos) names.add(entry.name)
        }
      }
      return [...names].sort()
    }

    const visit = (node) => {
      const fnName = enclosingFunctionName(node)
      if (fnName !== undefined) fnStack.push(fnName)

      const isLocalScope = node.kind !== SyntaxKind.SourceFile
      const frame = isLocalScope ? scopeBindingsOf(node) : []
      if (frame.length) localScopeStack.push(frame)

      if (isSelectableExpression(node)) {
        const start = node.getStart(tree)
        const end = node.end
        const inFunction = fnStack.length ? fnStack[fnStack.length - 1] : null
        const kind =
          node.kind === SyntaxKind.CallExpression
            ? 'CallExpression'
            : node.kind === SyntaxKind.BinaryExpression
              ? 'BinaryExpression'
              : 'ConditionalExpression'
        const extra =
          kind === 'CallExpression'
            ? { callee: callCalleeName(node) }
            : kind === 'BinaryExpression'
              ? { operator: source.slice(node.operatorToken.getStart(tree), node.operatorToken.end) }
              : {}
        const counterKey = `${inFunction ?? ''}\0${kind}\0${extra.callee ?? extra.operator ?? ''}`
        const nth = nthCounters.get(counterKey) ?? 0
        nthCounters.set(counterKey, nth + 1)

        const id = createHash('sha256')
          .update(`${relativeFile}\0${source}\0${start}:${end}`)
          .digest('hex')
          .slice(0, 12)

        nodes.push({
          id,
          file,
          relativeFile,
          kind,
          inFunction,
          ...extra,
          nth,
          start,
          end,
          captures: activeLocalsAt(start),
        })
      }

      node.forEachChild(visit)

      if (frame.length) localScopeStack.pop()
      if (fnName !== undefined) fnStack.pop()
    }

    visit(tree)
    return { file, relativeFile, source, nodes }
  } finally {
    lease.dispose()
  }
}

/** Index all target modules configured in points.ep. */
export function buildTargetPlan(options) {
  const root = resolve(options.root ?? process.cwd())
  const overrides = options.overrides ?? new Map()
  const read = (file) => (overrides.has(file) ? overrides.get(file) : readFileSync(file, 'utf8'))
  const ownApi = !options.api
  const api = options.api ?? new API({ cwd: root })

  try {
    const files = []
    for (const file of resolveTargetFiles(root, options.targets ?? [])) {
      if (!overrides.has(file) && !existsSync(file)) continue
      files.push(indexTargetFile(file, read(file), root, api))
    }
    return {
      root,
      tsconfig: resolve(root, options.tsconfig ?? 'tsconfig.json'),
      files,
    }
  } finally {
    if (ownApi) api.close()
  }
}
