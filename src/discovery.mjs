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
let defaultApi
const getDefaultApi = () => (defaultApi ??= new API())

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
  return (
    indexableKinds.has(node.kind) &&
    !(node.kind === SyntaxKind.BinaryExpression && isAssignmentOp(node.operatorToken.kind)) &&
    !(
      p &&
      (((p.kind === SyntaxKind.CallExpression || p.kind === SyntaxKind.NewExpression) && p.expression === cur) ||
        p.kind === SyntaxKind.TaggedTemplateExpression ||
        (p.kind === SyntaxKind.BinaryExpression && p.left === cur && isAssignmentOp(p.operatorToken.kind)) ||
        p.kind === SyntaxKind.DeleteExpression ||
        p.kind === SyntaxKind.PostfixUnaryExpression ||
        (p.kind === SyntaxKind.PrefixUnaryExpression &&
          [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(p.operator)))
    ) &&
    !hasUnsupportedSyntax(node)
  )
}

function hasUnsupportedSyntax(part) {
  if (
    [SyntaxKind.AwaitExpression, SyntaxKind.YieldExpression, SyntaxKind.SuperKeyword].includes(part.kind) ||
    part.questionDotToken ||
    (part.flags & NodeFlags.OptionalChain) ||
    (part.kind === SyntaxKind.CallExpression &&
      (part.expression.kind === SyntaxKind.ImportKeyword ||
        (part.expression.kind === SyntaxKind.Identifier && part.expression.text === 'eval')))
  ) {
    return true
  }
  return Boolean(part.forEachChild(hasUnsupportedSyntax))
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
      if (node.name) return node.name.text
      const { parent } = node
      if (parent.kind === SyntaxKind.VariableDeclaration && parent.name.kind === SyntaxKind.Identifier) {
        return parent.name.text
      }
      if (parent.kind === SyntaxKind.PropertyAssignment) {
        return parent.name.text ?? '(anonymous)'
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
  if (expr.kind === SyntaxKind.ElementAccessExpression && expr.argumentExpression.kind === SyntaxKind.StringLiteral) {
    return expr.argumentExpression.text
  }
  return '(anonymous)'
}

function collectBindingEntries(nameNode, endPos, out) {
  if (!nameNode) return
  if (nameNode.kind === SyntaxKind.Identifier) {
    out.push({ name: nameNode.text, readyAt: endPos })
    return
  }
  for (const el of nameNode.elements) collectBindingEntries(el.name, endPos, out)
}

function scopeBindingsOf(node) {
  if (node.kind === SyntaxKind.SourceFile) return []
  const entries = []
  if (node.parameters) {
    for (const p of node.parameters) collectBindingEntries(p.name, p.end, entries)
  }
  if (node.variableDeclaration) {
    collectBindingEntries(node.variableDeclaration.name, node.variableDeclaration.end, entries)
  }
  if (
    (node.kind === SyntaxKind.ForInStatement || node.kind === SyntaxKind.ForOfStatement) &&
    node.initializer.kind === SyntaxKind.VariableDeclarationList
  ) {
    for (const decl of node.initializer.declarations) {
      collectBindingEntries(decl.name, node.expression.end, entries)
    }
    return entries
  }
  const statements =
    node.statements ?? (node.kind === SyntaxKind.ForStatement && node.initializer ? [node.initializer] : [])
  for (const stmt of statements) {
    if (stmt.kind === SyntaxKind.FunctionDeclaration) {
      entries.push({ name: stmt.name.text, readyAt: -1 })
    } else if (stmt.kind === SyntaxKind.ClassDeclaration) {
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
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const lease = api.createSourceFile(file, bomOffset ? source.slice(1) : source)
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
          else names.delete(entry.name)
        }
      }
      return [...names].sort()
    }

    const visit = (node) => {
      const fnName = enclosingFunctionName(node)
      if (fnName !== undefined) fnStack.push(fnName)
      localScopeStack.push(scopeBindingsOf(node))

      if (isSelectableExpression(node)) {
        const treeStart = node.getStart(tree)
        const start = treeStart + bomOffset
        const end = node.end + bomOffset
        const inFunction =
          fnStack.findLast((name) => name !== '(anonymous)') ?? (fnStack.length ? '(anonymous)' : null)
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
              ? {
                  operator: source.slice(
                    node.operatorToken.getStart(tree) + bomOffset,
                    node.operatorToken.end + bomOffset,
                  ),
                }
              : {}
        const namePart = extra.callee ?? extra.operator ?? '?'
        const scopePrefix = `${relativeFile}#${inFunction ?? '<top>'}:${kind}:${namePart}`
        const nth = nthCounters.get(scopePrefix) ?? 0
        nthCounters.set(scopePrefix, nth + 1)
        const id = `${scopePrefix}:${nth}`

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
          captures: activeLocalsAt(treeStart),
        })
      }

      node.forEachChild(visit)

      localScopeStack.pop()
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
  const api = options.api ?? getDefaultApi()

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
}
