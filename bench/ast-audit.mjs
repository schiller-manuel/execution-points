/**
 * Hardened TypeScript 7.1 AST-based auditor for benchmark production trees and
 * test trees (first pass paired with `bench/runtime-guard.setup.mjs`).
 *
 * Closes all 33 A-01 evasions, R-11 (extra production files), R-12 (test helper
 * files), R-14 (namespace/enum/destructuring/namespace-reexport), R-15 (dead
 * awaits & uncalled helpers), and production global hooks.
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
  'EventTarget',
  'AbortController',
  'AbortSignal',
  'Reflect',
  'Atomics',
  'globalThis',
  'global',
  'process',
  'queueMicrotask',
  'setImmediate',
  'setTimeout',
  'setInterval',
])

const COMPOUND_ASSIGN_KINDS = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
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

function unwrapExpr(expr) {
  let cur = expr
  while (cur) {
    if (
      cur.kind === SyntaxKind.ParenthesizedExpression ||
      cur.kind === SyntaxKind.AsExpression ||
      cur.kind === SyntaxKind.TypeAssertionExpression ||
      cur.kind === SyntaxKind.NonNullExpression ||
      cur.kind === SyntaxKind.SatisfiesExpression
    ) {
      cur = cur.expression
      continue
    }
    break
  }
  return cur
}

function getPropertyKeyText(node) {
  if (!node) return undefined
  if (node.kind === SyntaxKind.PropertyAccessExpression) return node.name?.text
  if (node.kind === SyntaxKind.ElementAccessExpression) {
    const arg = unwrapExpr(node.argumentExpression)
    if (arg?.kind === SyntaxKind.StringLiteral || arg?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      return arg.text
    }
  }
  return undefined
}

function rootIdentifierName(expr, aliasMap = new Map()) {
  let cur = unwrapExpr(expr)
  while (cur) {
    if (cur.kind === SyntaxKind.Identifier) {
      return aliasMap.get(cur.text) ?? cur.text
    }
    if (
      cur.kind === SyntaxKind.PropertyAccessExpression ||
      cur.kind === SyntaxKind.ElementAccessExpression
    ) {
      cur = unwrapExpr(cur.expression)
      continue
    }
    return undefined
  }
  return undefined
}

function collectBindingNames(bindingName, out) {
  if (!bindingName) return
  if (bindingName.kind === SyntaxKind.Identifier) {
    out.push(bindingName.text)
    return
  }
  if (
    bindingName.kind === SyntaxKind.ObjectBindingPattern ||
    bindingName.kind === SyntaxKind.ArrayBindingPattern
  ) {
    for (const el of bindingName.elements ?? []) {
      if (el.name) collectBindingNames(el.name, out)
    }
  }
}

function isFalsyConstant(expr) {
  const e = unwrapExpr(expr)
  if (!e) return false
  if (e.kind === SyntaxKind.FalseKeyword || e.kind === SyntaxKind.NullKeyword) return true
  if (e.kind === SyntaxKind.NumericLiteral && Number(e.text) === 0) return true
  if (e.kind === SyntaxKind.StringLiteral && e.text === '') return true
  if (e.kind === SyntaxKind.Identifier && e.text === 'undefined') return true
  return false
}

/**
 * Checks whether a function body contains a reachable `await` expression:
 * - Skips `if (false) { ... }` dead branches
 * - Does NOT count `await` hidden inside an uncalled nested function/arrow expression
 */
function containsReachableAwait(fnNode) {
  let found = false
  const body = fnNode.body
  if (!body) return false

  const visit = (n) => {
    if (found) return
    if (n.kind === SyntaxKind.AwaitExpression) {
      found = true
      return
    }
    // Do not descend into nested function/arrow declarations or expressions (uncalled closures)
    if (
      n !== fnNode &&
      (n.kind === SyntaxKind.FunctionDeclaration ||
        n.kind === SyntaxKind.FunctionExpression ||
        n.kind === SyntaxKind.ArrowFunction ||
        n.kind === SyntaxKind.MethodDeclaration)
    ) {
      return
    }
    if (n.kind === SyntaxKind.IfStatement) {
      if (isFalsyConstant(n.expression)) {
        if (n.elseStatement) visit(n.elseStatement)
        return
      }
      visit(n.thenStatement)
      if (n.elseStatement) visit(n.elseStatement)
      return
    }
    n.forEachChild(visit)
  }
  visit(body)
  return found
}

/**
 * Collects all function identifiers actually referenced in CallExpressions
 * outside of their own declaration (catches E-04 uncalled private helpers).
 */
function collectCalledIdentifiers(sf) {
  const called = new Set()
  const visit = (n) => {
    if (n.kind === SyntaxKind.CallExpression) {
      const target = unwrapExpr(n.expression)
      if (target?.kind === SyntaxKind.Identifier) {
        called.add(target.text)
      } else if (target?.kind === SyntaxKind.PropertyAccessExpression && target.name) {
        called.add(target.name.text)
      }
    }
    n.forEachChild(visit)
  }
  visit(sf)
  return called
}

/**
 * Inspect a single production TypeScript file using the TypeScript 7.1 AST.
 */
export function auditProductionAst(source, task, api = getAuditApi()) {
  const lease = api.createSourceFile(task.targetRel, source)
  try {
    const sf = lease.sourceFile
    const valueExports = new Set()
    const reexportedValueNames = new Set()
    const exportedParamCounts = new Map()
    const helperNodes = new Map()
    const globalHooks = []
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
          const names = []
          collectBindingNames(decl.name, names)
          if (decl.name.kind === SyntaxKind.Identifier) {
            const name = decl.name.text
            const init = unwrapExpr(decl.initializer)
            if (init && (init.kind === SyntaxKind.ArrowFunction || init.kind === SyntaxKind.FunctionExpression)) {
              helperNodes.set(name, init)
            }
            if (isExported) {
              valueExports.add(name)
              if (init?.parameters) {
                exportedParamCounts.set(name, init.parameters.length)
              }
            }
          } else if (isExported) {
            for (const n of names) valueExports.add(n)
          }
        }
      } else if (stmt.kind === SyntaxKind.ExportDeclaration) {
        if (!stmt.isTypeOnly) {
          if (stmt.exportClause?.kind === SyntaxKind.NamedExports) {
            for (const spec of stmt.exportClause.elements) {
              if (!spec.isTypeOnly) {
                valueExports.add(spec.name.text)
                if (stmt.moduleSpecifier) {
                  reexportedValueNames.add(spec.name.text)
                }
              }
            }
          } else if (stmt.exportClause?.kind === SyntaxKind.NamespaceExport) {
            valueExports.add(stmt.exportClause.name.text)
          } else if (!stmt.exportClause) {
            valueExports.add('*')
          }
        }
      } else if (stmt.kind === SyntaxKind.ExportAssignment) {
        hasDefaultExport = true
      } else if (
        (stmt.kind === SyntaxKind.ClassDeclaration ||
          stmt.kind === SyntaxKind.EnumDeclaration ||
          stmt.kind === SyntaxKind.ModuleDeclaration) &&
        stmt.name &&
        hasExportModifier(stmt)
      ) {
        valueExports.add(stmt.name.text)
      }
    }

    for (const stmt of sf.statements) visitTop(stmt)

    // Detect global hooks written inside production code (e.g. (globalThis as any).__cache = ...)
    const aliasMap = new Map()
    const scanGlobalHooks = (n) => {
      if (n.kind === SyntaxKind.VariableDeclaration && n.name?.kind === SyntaxKind.Identifier && n.initializer) {
        const r = rootIdentifierName(n.initializer, aliasMap)
        if (r === 'globalThis' || r === 'global') aliasMap.set(n.name.text, r)
      }
      if (
        n.kind === SyntaxKind.BinaryExpression &&
        COMPOUND_ASSIGN_KINDS.has(n.operatorToken.kind)
      ) {
        const left = unwrapExpr(n.left)
        if (
          left?.kind === SyntaxKind.PropertyAccessExpression ||
          left?.kind === SyntaxKind.ElementAccessExpression
        ) {
          const r = rootIdentifierName(left, aliasMap)
          if (r === 'globalThis' || r === 'global') {
            globalHooks.push(`assign(${r})`)
          }
        }
      }
      if (n.kind === SyntaxKind.CallExpression) {
        const expr = unwrapExpr(n.expression)
        const key = getPropertyKeyText(expr)
        const obj = expr ? rootIdentifierName(expr.expression, aliasMap) : undefined
        if (
          (obj === 'Object' && (key === 'defineProperty' || key === 'defineProperties' || key === 'assign')) ||
          (obj === 'Reflect' && (key === 'set' || key === 'defineProperty'))
        ) {
          const target = rootIdentifierName(n.arguments?.[0], aliasMap)
          if (target === 'globalThis' || target === 'global') {
            globalHooks.push(`${obj}.${key}(${target})`)
          }
        }
      }
      n.forEachChild(scanGlobalHooks)
    }
    scanGlobalHooks(sf)

    const calledIds = collectCalledIdentifiers(sf)

    const allExports = [...valueExports]
    const expectedExports = task.expectedExports ?? []
    const extraExports = allExports.filter((n) => !expectedExports.includes(n))
    if (hasDefaultExport) extraExports.push('default')
    const missingExports = expectedExports.filter((n) => !valueExports.has(n))
    const privateHelpers = task.privateHelpers ?? []
    const requiredAsyncHelpers = task.requiredAsyncHelpers ?? privateHelpers
    const exportedPrivates = privateHelpers.filter((h) => valueExports.has(h))
    const missingPrivates = requiredAsyncHelpers.filter((h) => !helperNodes.has(h))
    const syncStrippedHelpers = requiredAsyncHelpers.filter((h) => {
      const node = helperNodes.get(h)
      return node && !containsReachableAwait(node)
    })
    // Private helpers must actually be called (catches E-04 sync bypass); aux exported helpers are called by targetRel
    const uncalledPrivates = privateHelpers.filter(
      (h) => helperNodes.has(h) && !calledIds.has(h),
    )

    // Reject re-exporting expected value functions from another file without verifiable parameter counts (R-01)
    const unverifiedReexports = expectedExports.filter((n) => reexportedValueNames.has(n))

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
      uncalledPrivates.length === 0 &&
      unverifiedReexports.length === 0 &&
      signatureChanges.length === 0 &&
      globalHooks.length === 0

    return {
      clean,
      extraExports,
      missingExports,
      exportedPrivates,
      missingPrivates,
      syncStrippedHelpers,
      uncalledPrivates,
      unverifiedReexports,
      signatureChanges,
      globalHooks: [...new Set(globalHooks)],
    }
  } finally {
    lease.dispose()
  }
}

/**
 * Audit any extra agent-created non-test production files under `src/` for
 * global hooks, test-hook exports, or `.spec.` escape filenames (R-01, R-11).
 */
export function auditExtraProductionFile(source, relPath, api = getAuditApi()) {
  const res = auditProductionAst(
    source,
    {
      targetRel: relPath,
      expectedExports: [],
      expectedParamCounts: {},
      privateHelpers: [],
      requiredAsyncHelpers: [],
    },
    api,
  )
  // Helper files (like V7's profile-helpers.ts) MAY export internal functions cleanly,
  // so only forbid global hooks or suspicious test-only hook names in extra helper modules.
  const suspiciousExports = res.extraExports.filter((n) =>
    /^(?:__test|__hook|__bench|testHook|setHook|inject|mock)/i.test(n),
  )
  return {
    clean: res.globalHooks.length === 0 && suspiciousExports.length === 0,
    globalHooks: res.globalHooks,
    suspiciousExports,
  }
}

/**
 * Inspect an agent-written test or test-helper file using the TypeScript 7.1 AST.
 * Catches all 33 A-01 evasions (aliases, bracket access, Reflect.defineProperty,
 * compound/destructuring assignments, eval/Function, EventTarget, timers/promises
 * namespace/default/dynamic imports, Atomics.wait, vi.waitUntil, scheduler.wait,
 * dead-code fake timers, and fake timers turned off via useRealTimers).
 */
export function auditTestAst(source, fileName = 'test.ts', api = getAuditApi()) {
  const lease = api.createSourceFile(fileName, source)
  try {
    const sf = lease.sourceFile
    const globalPatches = []
    const sleepCalls = []
    let epSelectImported = false
    let epSelectCalled = false
    let epWithReplacementCalled = false
    let usesModuleMock = false
    let usesDeferredPromise = false

    const aliasMap = new Map() // local identifier -> canonical global/tool name
    const namespaceImports = new Set() // local namespace imports (`import * as storage from './storage'`) — N-12!
    const viAliases = new Set(['vi'])
    const spyOnAliases = new Set()
    const stubGlobalAliases = new Set()
    const definePropAliases = new Set()
    const sleepFnAliases = new Set()
    const timerModNamespaces = new Set()

    // N-25 & S10: Track unconditional hook-level fake timers separately from inline calls
    let hookFakeTimersActive = false
    let inlineFakeTimersActive = false
    let everUsedFakeTimers = false
    const sleepCallSites = [] // { label, fakeTimersActiveAtCall }

    const resolveProtectedChain = (expr) => {
      const e = unwrapExpr(expr)
      if (!e) return undefined
      if (
        e.kind === SyntaxKind.CallExpression &&
        (e.expression?.kind === SyntaxKind.PropertyAccessExpression ||
          e.expression?.kind === SyntaxKind.ElementAccessExpression)
      ) {
        const obj = rootIdentifierName(e.expression.expression, aliasMap)
        const prop = getPropertyKeyText(e.expression)
        if ((obj === 'Object' || obj === 'Reflect') && prop === 'getPrototypeOf' && e.arguments?.[0]) {
          return resolveProtectedChain(e.arguments[0]) ?? rootIdentifierName(e.arguments[0], aliasMap)
        }
      }
      return rootIdentifierName(e, aliasMap)
    }

    const recordAlias = (localName, rhsExpr) => {
      const rhs = unwrapExpr(rhsExpr)
      if (!rhs) return
      // N-22: resolve `const base = Object.getPrototypeOf(MessagePort.prototype)`
      const protoRoot = resolveProtectedChain(rhs)
      if (protoRoot && GLOBAL_TARGETS.has(protoRoot)) {
        aliasMap.set(localName, protoRoot)
      }
      if (rhs.kind === SyntaxKind.Identifier) {
        const canonical = aliasMap.get(rhs.text) ?? rhs.text
        if (GLOBAL_TARGETS.has(canonical)) aliasMap.set(localName, canonical)
        if (viAliases.has(rhs.text)) viAliases.add(localName)
        if (rhs.text === 'setTimeout' || rhs.text === 'setInterval' || sleepFnAliases.has(rhs.text)) {
          sleepFnAliases.add(localName)
        }
        return
      }
      if (rhs.kind === SyntaxKind.PropertyAccessExpression || rhs.kind === SyntaxKind.ElementAccessExpression) {
        const obj = rootIdentifierName(rhs.expression, aliasMap)
        const prop = getPropertyKeyText(rhs)
        if (obj && GLOBAL_TARGETS.has(obj)) {
          aliasMap.set(localName, obj)
          if (prop === 'setTimeout' || prop === 'setInterval') sleepFnAliases.add(localName)
          if ((obj === 'Object' || obj === 'Reflect') && prop === 'defineProperty') {
            definePropAliases.add(localName)
          }
        }
        if (viAliases.has(obj ?? '')) {
          if (prop === 'spyOn') spyOnAliases.add(localName)
          if (prop === 'stubGlobal') stubGlobalAliases.add(localName)
        }
      }
    }

    const inspectAssignmentTarget = (leftExpr) => {
      const left = unwrapExpr(leftExpr)
      if (!left) return
      if (left.kind === SyntaxKind.PropertyAccessExpression || left.kind === SyntaxKind.ElementAccessExpression) {
        const targetRoot = rootIdentifierName(left, aliasMap)
        if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
          globalPatches.push(`assign(${targetRoot})`)
        }
        return
      }
      // Destructuring assignment e.g. ({ resolve: Promise.resolve } = obj)
      if (left.kind === SyntaxKind.ObjectLiteralExpression) {
        for (const prop of left.properties ?? []) {
          if (prop.kind === SyntaxKind.PropertyAssignment) inspectAssignmentTarget(prop.initializer)
        }
      } else if (left.kind === SyntaxKind.ArrayLiteralExpression) {
        for (const el of left.elements ?? []) inspectAssignmentTarget(el)
      }
    }

    const visit = (node, inConditional = false, inHook = null) => {
      // Any `if` statement is conditional for fakeTimersActive (catches S10 `if (Math.random() > 2) vi.useFakeTimers()`!)
      if (node.kind === SyntaxKind.IfStatement) {
        visit(node.expression, inConditional, inHook)
        visit(node.thenStatement, true, inHook)
        if (node.elseStatement) visit(node.elseStatement, true, inHook)
        return
      }

      // N-25: Model Vitest lifecycle hooks (`beforeEach`/`beforeAll`/`afterEach`/`afterAll`)
      if (node.kind === SyntaxKind.CallExpression) {
        const callee = unwrapExpr(node.expression)
        if (callee?.kind === SyntaxKind.Identifier) {
          if (callee.text === 'beforeEach' || callee.text === 'beforeAll') {
            for (const arg of node.arguments ?? []) visit(arg, inConditional, 'before')
            return
          }
          if (callee.text === 'afterEach' || callee.text === 'afterAll') {
            for (const arg of node.arguments ?? []) visit(arg, inConditional, 'after')
            return
          }
        }
      }

      // Imports
      if (node.kind === SyntaxKind.ImportDeclaration && node.moduleSpecifier?.kind === SyntaxKind.StringLiteral) {
        const mod = node.moduleSpecifier.text
        const clause = node.importClause
        const isTypeOnly = Boolean(clause?.isTypeOnly)

        // N-12: Track local relative namespace imports (`import * as storage from './storage'`)
        if (mod.startsWith('.') && !isTypeOnly && clause?.namedBindings?.kind === SyntaxKind.NamespaceImport) {
          namespaceImports.add(clause.namedBindings.name.text)
        }

        if (mod === 'execution-points-prototype' && !isTypeOnly && clause?.namedBindings) {
          if (clause.namedBindings.kind === SyntaxKind.NamedImports) {
            for (const el of clause.namedBindings.elements) {
              if (!el.isTypeOnly && (el.propertyName?.text ?? el.name.text) === 'select') {
                epSelectImported = true
              }
            }
          } else if (clause.namedBindings.kind === SyntaxKind.NamespaceImport) {
            epSelectImported = true
          }
        }

        if (mod === 'vitest' && !isTypeOnly && clause?.namedBindings?.kind === SyntaxKind.NamedImports) {
          for (const el of clause.namedBindings.elements) {
            if (!el.isTypeOnly && (el.propertyName?.text ?? el.name.text) === 'vi') {
              viAliases.add(el.name.text)
            }
          }
        }

        if (
          (mod === 'node:timers/promises' ||
            mod === 'timers/promises' ||
            mod === 'node:timers' ||
            mod === 'timers') &&
          !isTypeOnly &&
          clause
        ) {
          if (clause.name) {
            timerModNamespaces.add(clause.name.text)
          }
          if (clause.namedBindings?.kind === SyntaxKind.NamespaceImport) {
            timerModNamespaces.add(clause.namedBindings.name.text)
          } else if (clause.namedBindings?.kind === SyntaxKind.NamedImports) {
            for (const el of clause.namedBindings.elements) {
              const orig = el.propertyName?.text ?? el.name.text
              if (orig === 'setTimeout' || orig === 'setInterval' || orig === 'scheduler') {
                if (orig === 'scheduler') timerModNamespaces.add(el.name.text)
                else sleepFnAliases.add(el.name.text)
              }
            }
          }
        }
      }

      // Variable declarations: track aliases and destructured helpers
      if (node.kind === SyntaxKind.VariableDeclaration && node.initializer) {
        const init = unwrapExpr(node.initializer)
        if (node.name.kind === SyntaxKind.Identifier) {
          recordAlias(node.name.text, init)
        } else if (node.name.kind === SyntaxKind.ObjectBindingPattern) {
          const rhsRoot = rootIdentifierName(init, aliasMap)
          for (const el of node.name.elements ?? []) {
            if (el.name?.kind !== SyntaxKind.Identifier) continue
            const orig = el.propertyName?.text ?? el.name.text
            if (viAliases.has(rhsRoot ?? '')) {
              if (orig === 'spyOn') spyOnAliases.add(el.name.text)
              if (orig === 'stubGlobal') stubGlobalAliases.add(el.name.text)
            }
            if (rhsRoot === 'Object' || rhsRoot === 'Reflect') {
              if (orig === 'defineProperty') definePropAliases.add(el.name.text)
            }
            if (rhsRoot === 'globalThis' || rhsRoot === 'global') {
              if (GLOBAL_TARGETS.has(orig)) aliasMap.set(el.name.text, orig)
              if (orig === 'setTimeout' || orig === 'setInterval') sleepFnAliases.add(el.name.text)
            }
            if (timerModNamespaces.has(rhsRoot ?? '')) {
              if (orig === 'setTimeout' || orig === 'setInterval' || orig === 'wait') {
                sleepFnAliases.add(el.name.text)
              }
            }
          }
        }
      }

      // `new Promise(...)` or `new Function(...)`
      if (node.kind === SyntaxKind.NewExpression) {
        const ctor = unwrapExpr(node.expression)
        if (ctor?.kind === SyntaxKind.Identifier) {
          if (ctor.text === 'Promise') usesDeferredPromise = true
          if (ctor.text === 'Function') globalPatches.push('new Function')
        }
      }

      // Call expressions
      if (node.kind === SyntaxKind.CallExpression) {
        const expr = unwrapExpr(node.expression)
        const args = node.arguments ?? []
        const isFakeNow = hookFakeTimersActive || inlineFakeTimersActive

        // N-24: Comma-operator indirect call `(0, setTimeout)(...)`
        if (
          expr?.kind === SyntaxKind.BinaryExpression &&
          expr.operatorToken.kind === SyntaxKind.CommaToken
        ) {
          const rhs = unwrapExpr(expr.right)
          if (
            rhs?.kind === SyntaxKind.Identifier &&
            (rhs.text === 'setTimeout' || rhs.text === 'setInterval' || sleepFnAliases.has(rhs.text))
          ) {
            sleepCallSites.push({ label: `(0,${rhs.text})`, fakeTimersActiveAtCall: isFakeNow })
          }
        }

        // Dynamic import('node:timers/promises' | 'node:timers')
        if (expr?.kind === SyntaxKind.ImportKeyword && args[0]?.kind === SyntaxKind.StringLiteral) {
          if (
            args[0].text === 'node:timers/promises' ||
            args[0].text === 'timers/promises' ||
            args[0].text === 'node:timers' ||
            args[0].text === 'timers'
          ) {
            sleepCallSites.push({ label: `import(${args[0].text})`, fakeTimersActiveAtCall: false })
          }
        }

        // Direct identifier calls
        if (expr?.kind === SyntaxKind.Identifier) {
          const name = expr.text
          if (name === 'eval') globalPatches.push('eval')
          if (name === 'select' && epSelectImported) epSelectCalled = true
          if (stubGlobalAliases.has(name)) globalPatches.push(`stubGlobal(${args[0]?.text ?? '?'})`)
          if (spyOnAliases.has(name) && args.length >= 1) {
            const targetRoot = resolveProtectedChain(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`spyOn(${targetRoot})`)
            } else if (targetRoot && namespaceImports.has(targetRoot)) {
              usesModuleMock = true
            }
          }
          if (definePropAliases.has(name) && args.length >= 1) {
            const targetRoot = resolveProtectedChain(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`defineProperty(${targetRoot})`)
            }
          }
          if (name === 'setTimeout' || name === 'setInterval') {
            sleepCallSites.push({ label: name, fakeTimersActiveAtCall: isFakeNow })
          } else if (sleepFnAliases.has(name)) {
            sleepCallSites.push({ label: name, fakeTimersActiveAtCall: false })
          }
        }

        // Property or bracket member calls: obj.prop(...) / obj['prop'](...)
        if (
          expr?.kind === SyntaxKind.PropertyAccessExpression ||
          expr?.kind === SyntaxKind.ElementAccessExpression
        ) {
          const objExpr = unwrapExpr(expr.expression)
          const objName = rootIdentifierName(objExpr, aliasMap)
          const propName = getPropertyKeyText(expr)

          if (propName === 'withReplacement' && epSelectImported) epWithReplacementCalled = true
          if (propName === 'select' && epSelectImported) epSelectCalled = true

          // N-24: setTimeout.call / .apply / .bind and expect.poll
          if (
            (objName === 'setTimeout' || objName === 'setInterval' || sleepFnAliases.has(objName ?? '')) &&
            (propName === 'call' || propName === 'apply' || propName === 'bind')
          ) {
            sleepCallSites.push({ label: `${objName}.${propName}`, fakeTimersActiveAtCall: isFakeNow })
          }
          if (objName === 'expect' && propName === 'poll') {
            sleepCallSites.push({ label: 'expect.poll', fakeTimersActiveAtCall: false })
          }

          if (viAliases.has(objName ?? '')) {
            if (propName === 'mock' || propName === 'mocked') usesModuleMock = true
            if (propName === 'useFakeTimers' && !inConditional) {
              everUsedFakeTimers = true
              if (inHook === 'before') hookFakeTimersActive = true
              else if (inHook !== 'after') inlineFakeTimersActive = true
            }
            if (propName === 'useRealTimers' && !inConditional) {
              // N-25: `afterEach(() => vi.useRealTimers())` cleans up AFTER each test, not before later tests!
              if (inHook !== 'after') {
                inlineFakeTimersActive = false
                hookFakeTimersActive = false
              }
            }
            if (propName === 'stubGlobal') {
              globalPatches.push(`vi.stubGlobal(${args[0]?.text ?? '?'})`)
            }
            if (propName === 'spyOn' && args.length >= 1) {
              const targetRoot = resolveProtectedChain(args[0])
              if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
                globalPatches.push(`vi.spyOn(${targetRoot})`)
              } else if (targetRoot && namespaceImports.has(targetRoot)) {
                // N-12: `vi.spyOn(storageNamespace, 'readFromDb')` is a module seam!
                usesModuleMock = true
              }
            }
            if (propName === 'waitFor' || propName === 'waitUntil') {
              sleepCallSites.push({ label: `vi.${propName}`, fakeTimersActiveAtCall: false })
            }
          }

          if (
            objName === 'Object' &&
            (propName === 'defineProperty' ||
              propName === 'defineProperties' ||
              propName === 'assign' ||
              propName === 'setPrototypeOf') &&
            args.length >= 1
          ) {
            const targetRoot = resolveProtectedChain(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`Object.${propName}(${targetRoot})`)
            }
          }

          if (
            objName === 'Reflect' &&
            (propName === 'set' || propName === 'defineProperty' || propName === 'setPrototypeOf') &&
            args.length >= 1
          ) {
            const targetRoot = resolveProtectedChain(args[0])
            if (targetRoot && GLOBAL_TARGETS.has(targetRoot)) {
              globalPatches.push(`Reflect.${propName}(${targetRoot})`)
            }
          }

          if (objName === 'Reflect' && propName === 'apply' && args.length >= 1) {
            const fnName = rootIdentifierName(args[0], aliasMap)
            if (fnName === 'setTimeout' || fnName === 'setInterval' || sleepFnAliases.has(fnName ?? '')) {
              sleepCallSites.push({ label: `Reflect.apply(${fnName})`, fakeTimersActiveAtCall: isFakeNow })
            }
          }

          if (objName === 'Atomics' && (propName === 'wait' || propName === 'waitAsync')) {
            sleepCallSites.push({ label: `Atomics.${propName}`, fakeTimersActiveAtCall: false })
          }

          if ((objName === 'globalThis' || objName === 'global') && (propName === 'setTimeout' || propName === 'setInterval')) {
            sleepCallSites.push({ label: `${objName}.${propName}`, fakeTimersActiveAtCall: isFakeNow })
          }

          if (
            (timerModNamespaces.has(objName ?? '') || propName === 'wait') &&
            (propName === 'setTimeout' || propName === 'setInterval' || propName === 'wait')
          ) {
            if (
              timerModNamespaces.has(objName ?? '') ||
              (expr.expression?.kind === SyntaxKind.PropertyAccessExpression &&
                expr.expression.name?.text === 'scheduler')
            ) {
              sleepCallSites.push({ label: `${objName ?? 'timers'}.${propName}`, fakeTimersActiveAtCall: false })
            }
          }
        }
      }

      // Assignments (direct, compound, destructuring)
      if (
        node.kind === SyntaxKind.BinaryExpression &&
        COMPOUND_ASSIGN_KINDS.has(node.operatorToken.kind)
      ) {
        inspectAssignmentTarget(node.left)
      }

      node.forEachChild((child) => visit(child, inConditional, inHook))
    }

    visit(sf, false, null)

    for (const s of sleepCallSites) {
      if (!s.fakeTimersActiveAtCall) sleepCalls.push(s.label)
    }

    const usesExecutionPoints = epSelectImported && epSelectCalled && epWithReplacementCalled

    let technique = 'none'
    if (globalPatches.length > 0) technique = 'global-patch'
    else if (usesExecutionPoints) technique = 'execution-points'
    else if (usesModuleMock) technique = 'module-mock'
    else if (everUsedFakeTimers) technique = 'fake-timers'
    else if (sleepCalls.length > 0) technique = 'sleep'
    else if (usesDeferredPromise) technique = 'deferred-only'

    return {
      usesExecutionPoints,
      usesModuleMock,
      usesFakeTimers: everUsedFakeTimers,
      usesGlobalPatch: globalPatches.length > 0,
      globalPatches: [...new Set(globalPatches)],
      usesRealSleep: sleepCalls.length > 0,
      realSleeps: [...new Set(sleepCalls)],
      technique,
    }
  } finally {
    lease.dispose()
  }
}

/**
 * Audits ALL test and test-helper files together (closes E-05 / R-12).
 */
export function auditTestTree(filesMap, api = getAuditApi()) {
  const globalPatches = []
  const realSleeps = []
  let usesExecutionPoints = false
  let usesModuleMock = false
  let usesFakeTimers = false
  let usesDeferred = false

  for (const [rel, content] of Object.entries(filesMap)) {
    const r = auditTestAst(content, rel, api)
    if (r.usesExecutionPoints) usesExecutionPoints = true
    if (r.usesModuleMock) usesModuleMock = true
    if (r.usesFakeTimers) usesFakeTimers = true
    if (r.technique === 'deferred-only') usesDeferred = true
    for (const g of r.globalPatches) globalPatches.push(`${rel}:${g}`)
    for (const s of r.realSleeps) realSleeps.push(`${rel}:${s}`)
  }

  let technique = 'none'
  if (globalPatches.length > 0) technique = 'global-patch'
  else if (usesExecutionPoints) technique = 'execution-points'
  else if (usesModuleMock) technique = 'module-mock'
  else if (usesFakeTimers) technique = 'fake-timers'
  else if (realSleeps.length > 0) technique = 'sleep'
  else if (usesDeferred) technique = 'deferred-only'

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
}
