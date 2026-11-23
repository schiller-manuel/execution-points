/**
 * TypeScript 7.1 AST-based auditor for benchmark production diffs and test files.
 * Replaces fragile regex checks (E8) with structural AST inspection.
 */
import { API } from 'typescript/sync'
import { SyntaxKind } from 'typescript/ast'

const GLOBAL_TARGETS = new Set([
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Object',
  'Array',
  'Function',
  'Date',
  'MessageChannel',
  'MessagePort',
  'AbortController',
  'AbortSignal',
  'globalThis',
  'global',
  'process',
  'queueMicrotask',
  'setImmediate',
  'setTimeout',
  'setInterval',
])

let sharedAuditApi
const getAuditApi = () => (sharedAuditApi ??= new API())

export function closeAuditApi() {
  sharedAuditApi?.close()
  sharedAuditApi = undefined
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((m) => m.kind === SyntaxKind.ExportKeyword))
}

function hasDefaultModifier(node) {
  return Boolean(node.modifiers?.some((m) => m.kind === SyntaxKind.DefaultKeyword))
}

function rootIdentifierName(expr) {
  let cur = expr
  while (cur) {
    if (cur.kind === SyntaxKind.Identifier) return cur.text
    if (cur.kind === SyntaxKind.PropertyAccessExpression || cur.kind === SyntaxKind.ElementAccessExpression) {
      cur = cur.expression
      continue
    }
    if (cur.kind === SyntaxKind.ParenthesizedExpression || cur.kind === SyntaxKind.AsExpression) {
      cur = cur.expression
      continue
    }
    return undefined
  }
  return undefined
}

function containsAwait(node) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (n.kind === SyntaxKind.AwaitExpression) {
      found = true
      return
    }
    n.forEachChild(visit)
  }
  visit(node)
  return found
}

/**
 * Inspect a production TypeScript file using the TypeScript 7.1 AST.
 * Catches `export function`, `export const/let/var`, `export { ... }`, `export default`,
 * extra exported parameters (test hooks), and verifies private helper existence + async awaits.
 */
export function auditProductionAst(source, task, api = getAuditApi()) {
  const lease = api.createSourceFile(task.targetRel, source)
  try {
    const sf = lease.sourceFile
    const valueExports = new Set()
    const exportedParamCounts = new Map()
    const helperNodes = new Map()
    let hasDefaultExport = false

    const visitTop = (stmt) => {
      if (stmt.kind === SyntaxKind.FunctionDeclaration && stmt.name) {
        const name = stmt.name.text
        helperNodes.set(name, stmt)
        if (hasExportModifier(stmt)) {
          if (hasDefaultModifier(stmt)) hasDefaultExport = true
          else {
            valueExports.add(name)
            exportedParamCounts.set(name, stmt.parameters?.length ?? 0)
          }
        }
      } else if (stmt.kind === SyntaxKind.VariableStatement) {
        const isExported = hasExportModifier(stmt)
        for (const decl of stmt.declarationList.declarations) {
          if (decl.name.kind === SyntaxKind.Identifier) {
            const name = decl.name.text
            if (decl.initializer && (decl.initializer.kind === SyntaxKind.ArrowFunction || decl.initializer.kind === SyntaxKind.FunctionExpression)) {
              helperNodes.set(name, decl.initializer)
            }
            if (isExported) {
              valueExports.add(name)
              if (decl.initializer?.parameters) {
                exportedParamCounts.set(name, decl.initializer.parameters.length)
              }
            }
          }
        }
      } else if (stmt.kind === SyntaxKind.ExportDeclaration) {
        if (stmt.exportClause?.kind === SyntaxKind.NamedExports && !stmt.isTypeOnly) {
          for (const spec of stmt.exportClause.elements) {
            if (!spec.isTypeOnly) valueExports.add(spec.name.text)
          }
        } else if (!stmt.exportClause && !stmt.isTypeOnly) {
          valueExports.add('*')
        }
      } else if (stmt.kind === SyntaxKind.ExportAssignment) {
        hasDefaultExport = true
      } else if (stmt.kind === SyntaxKind.ClassDeclaration && stmt.name && hasExportModifier(stmt)) {
        valueExports.add(stmt.name.text)
      }
    }

    for (const stmt of sf.statements) visitTop(stmt)

    const allExports = [...valueExports]
    const extraExports = allExports.filter((n) => !task.expectedExports.includes(n))
    if (hasDefaultExport) extraExports.push('default')
    const missingExports = task.expectedExports.filter((n) => !valueExports.has(n))
    const privateHelpers = task.privateHelpers ?? []
    const requiredAsyncHelpers = task.requiredAsyncHelpers ?? privateHelpers
    const exportedPrivates = privateHelpers.filter((h) => valueExports.has(h))
    const missingPrivates = requiredAsyncHelpers.filter((h) => !helperNodes.has(h))
    const syncStrippedHelpers = requiredAsyncHelpers.filter((h) => {
      const node = helperNodes.get(h)
      return node && !containsAwait(node)
    })

    const signatureChanges = []
    for (const [fnName, expectedCount] of Object.entries(task.expectedParamCounts ?? {})) {
      if (exportedParamCounts.has(fnName) && exportedParamCounts.get(fnName) !== expectedCount) {
        signatureChanges.push({
          name: fnName,
          expectedParams: expectedCount,
          actualParams: exportedParamCounts.get(fnName),
        })
      }
    }

    const clean =
      extraExports.length === 0 &&
      missingExports.length === 0 &&
      exportedPrivates.length === 0 &&
      missingPrivates.length === 0 &&
      syncStrippedHelpers.length === 0 &&
      signatureChanges.length === 0

    return {
      clean,
      extraExports,
      missingExports,
      exportedPrivates,
      missingPrivates,
      syncStrippedHelpers,
      signatureChanges,
    }
  } finally {
    lease.dispose()
  }
}

/**
 * Inspect an agent-written test file using the TypeScript 7.1 AST.
 * Accurately detects global monkey-patching, real-time sleeps, and classifies
 * the test technique without comment/string false positives.
 */
export function auditTestAst(source, fileName = 'test.ts', api = getAuditApi()) {
  const lease = api.createSourceFile(fileName, source)
  try {
    const sf = lease.sourceFile
    const globalPatches = []
    const sleepCalls = []
    let usesExecutionPoints = false
    let usesModuleMock = false
    let usesFakeTimers = false
    let usesDeferredPromise = false
    const timerPromiseImports = new Set()

    const visit = (node) => {
      // Track imports
      if (node.kind === SyntaxKind.ImportDeclaration && node.moduleSpecifier?.kind === SyntaxKind.StringLiteral) {
        const mod = node.moduleSpecifier.text
        if (mod === 'execution-points-prototype') usesExecutionPoints = true
        if (mod === 'node:timers/promises' || mod === 'timers/promises') {
          const named = node.importClause?.namedBindings
          if (named?.kind === SyntaxKind.NamedImports) {
            for (const el of named.elements) {
              const orig = el.propertyName?.text ?? el.name.text
              if (orig === 'setTimeout' || orig === 'setInterval') {
                timerPromiseImports.add(el.name.text)
              }
            }
          }
        }
      }

      // Detect `new Promise(...)` deferred patterns
      if (
        node.kind === SyntaxKind.NewExpression &&
        node.expression?.kind === SyntaxKind.Identifier &&
        node.expression.text === 'Promise'
      ) {
        usesDeferredPromise = true
      }

      // Detect calls: vi.spyOn, vi.stubGlobal, vi.mock, vi.useFakeTimers, Object.defineProperty, Reflect.set, sleeps
      if (node.kind === SyntaxKind.CallExpression) {
        const expr = node.expression
        const args = node.arguments ?? []

        if (expr.kind === SyntaxKind.PropertyAccessExpression) {
          const objName = rootIdentifierName(expr.expression)
          const propName = expr.name.text

          if (objName === 'vi' && propName === 'mock') usesModuleMock = true
          if (objName === 'vi' && propName === 'useFakeTimers') usesFakeTimers = true

          if (objName === 'vi' && propName === 'stubGlobal') {
            globalPatches.push(`vi.stubGlobal(${args[0]?.text ?? '?'})`)
          }
          if (objName === 'vi' && propName === 'spyOn' && args.length >= 1) {
            const targetRoot = rootIdentifierName(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`vi.spyOn(${targetRoot})`)
            }
          }
          if (objName === 'Object' && (propName === 'defineProperty' || propName === 'defineProperties' || propName === 'assign') && args.length >= 1) {
            const targetRoot = rootIdentifierName(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`Object.${propName}(${targetRoot})`)
            }
          }
          if (objName === 'Reflect' && propName === 'set' && args.length >= 1) {
            const targetRoot = rootIdentifierName(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`Reflect.set(${targetRoot})`)
            }
          }
          if (objName === 'vi' && propName === 'waitFor') {
            sleepCalls.push('vi.waitFor')
          }
        }

        if (expr.kind === SyntaxKind.Identifier) {
          if (expr.text === 'setTimeout' || expr.text === 'setInterval' || timerPromiseImports.has(expr.text)) {
            sleepCalls.push(expr.text)
          }
        }
      }

      // Detect direct assignment to global properties or prototypes (e.g. Promise.prototype.then = ..., globalThis.Promise = ...)
      if (
        node.kind === SyntaxKind.BinaryExpression &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        (node.left.kind === SyntaxKind.PropertyAccessExpression ||
          node.left.kind === SyntaxKind.ElementAccessExpression)
      ) {
        const targetRoot = rootIdentifierName(node.left)
        if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
          globalPatches.push(`assign(${targetRoot})`)
        }
      }

      node.forEachChild(visit)
    }

    visit(sf)

    // Real sleeps exclude setTimeout/setInterval when vi.useFakeTimers() is used in the same file
    const realSleeps = usesFakeTimers
      ? sleepCalls.filter((s) => s !== 'setTimeout' && s !== 'setInterval')
      : sleepCalls

    let technique = 'none'
    if (usesExecutionPoints) technique = 'execution-points'
    else if (globalPatches.length > 0) technique = 'global-patch'
    else if (usesModuleMock) technique = 'module-mock'
    else if (usesFakeTimers) technique = 'fake-timers'
    else if (realSleeps.length > 0) technique = 'sleep'
    else if (usesDeferredPromise) technique = 'deferred-only'

    return {
      usesExecutionPoints,
      usesModuleMock,
      usesFakeTimers,
      usesGlobalPatch: globalPatches.length > 0,
      globalPatches: [...new Set(globalPatches)],
      usesRealSleep: realSleeps.length > 0,
      realSleeps: [...new Set(realSleeps)],
      technique,
    }
  } finally {
    lease.dispose()
  }
}
