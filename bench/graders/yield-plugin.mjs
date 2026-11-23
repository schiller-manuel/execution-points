/**
 * Grader-only Vite plugin that rewrites every `await expr` in every non-test
 * `.ts`/`.js` file under `<root>/src/` into:
 *   `await __benchYield("relPath:offset", async () => (expr))`
 *
 * Uses TypeScript 7.1's AST (`typescript/sync`) and `magic-string`, with zero
 * dependency on `execution-points-prototype`.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import MagicString from 'magic-string'
import { API } from 'typescript/sync'
import { SyntaxKind } from 'typescript/ast'

function containsSuperOrYield(node) {
  let found = false
  const walk = (n) => {
    if (found) return
    if (n.kind === SyntaxKind.SuperKeyword || n.kind === SyntaxKind.YieldExpression) {
      found = true
      return
    }
    n.forEachChild(walk)
  }
  walk(node)
  return found
}

function enclosingFunctionName(node) {
  let cur = node.parent
  while (cur) {
    if (
      (cur.kind === SyntaxKind.FunctionDeclaration ||
        cur.kind === SyntaxKind.FunctionExpression ||
        cur.kind === SyntaxKind.MethodDeclaration) &&
      cur.name?.text
    ) {
      return cur.name.text
    }
    if (
      cur.kind === SyntaxKind.VariableDeclaration &&
      cur.name?.kind === SyntaxKind.Identifier &&
      cur.initializer &&
      (cur.initializer.kind === SyntaxKind.ArrowFunction ||
        cur.initializer.kind === SyntaxKind.FunctionExpression)
    ) {
      return cur.name.text
    }
    cur = cur.parent
  }
  return '<top>'
}

const LEAF_FS_METHODS = new Set([
  'readFile',
  'writeFile',
  'rm',
  'unlink',
  'stat',
  'lstat',
  'mkdir',
  'readdir',
  'rename',
  'open',
  'access',
])

function isLeafIoExpression(expr) {
  if (!expr) return false
  if (expr.kind === SyntaxKind.CallExpression) {
    const callee = expr.expression
    if (callee?.kind === SyntaxKind.Identifier && callee.text === 'yieldIo') {
      return true
    }
    if (
      callee?.kind === SyntaxKind.PropertyAccessExpression &&
      callee.name?.text &&
      LEAF_FS_METHODS.has(callee.name.text)
    ) {
      return true
    }
  }
  return false
}

export function benchYieldPlugin({ root, skipFiles = [] }) {
  const realRoot = realpathSync(root)
  const srcRoot = path.resolve(realRoot, 'src') + path.sep
  const engineModulePath = path.resolve(realRoot, 'yield-engine.mjs')
  // Transform by role, NEVER by filename (*.spec.ts under src/ MUST be transformed - fixes R-01!)
  const skipSet = new Set(
    [
      path.resolve(realRoot, '__grader__.test.ts'),
      path.resolve(realRoot, '__visible__.test.ts'),
      ...skipFiles.map((f) => {
        try {
          return realpathSync(f)
        } catch {
          return path.resolve(f)
        }
      }),
    ],
  )
  let api

  return {
    name: 'bench-grader-yield-transform',
    enforce: 'pre',

    buildStart() {
      api = new API({ cwd: realRoot })
    },

    closeBundle() {
      api?.close()
      api = undefined
    },

    transform(code, id) {
      if (id.startsWith('\0')) return null
      const rawFile = id.split('?', 1)[0]
      let file = rawFile
      try {
        file = realpathSync(rawFile)
      } catch {
        file = path.resolve(rawFile)
      }
      if (!file.startsWith(srcRoot)) return null
      if (skipSet.has(file)) return null
      if (!/\.[cm]?[jt]sx?$/.test(file)) return null

      if (!api) api = new API({ cwd: realRoot })
      const lease = api.createSourceFile(file, code)
      try {
        const sf = lease.sourceFile
        const awaits = []
        const walk = (node) => {
          if (node.kind === SyntaxKind.AwaitExpression && !containsSuperOrYield(node.expression)) {
            awaits.push({
              start: node.expression.getStart(sf),
              end: node.expression.end,
              fnName: enclosingFunctionName(node),
              isLeaf: isLeafIoExpression(node.expression),
            })
          }
          node.forEachChild(walk)
        }
        walk(sf)
        if (awaits.length === 0) return null

        const rel = path.relative(realRoot, file).replaceAll('\\', '/')
        const ms = new MagicString(code)
        const helperName = '__benchYield'
        ms.prepend(`import { __benchYield as ${helperName} } from ${JSON.stringify(engineModulePath)};\n`)

        // Sort opens outer-first (larger end first), closes inner-first (larger start first)
        const buckets = new Map()
        const at = (pos) => {
          let b = buckets.get(pos)
          if (!b) {
            b = { opens: [], closes: [] }
            buckets.set(pos, b)
          }
          return b
        }
        for (const a of awaits) {
          const site = `${rel}#${a.fnName}:${a.start}`
          at(a.start).opens.push({
            end: a.end,
            text: `${helperName}(${JSON.stringify(site)}, async () => (`,
          })
          at(a.end).closes.push({
            start: a.start,
            text: a.isLeaf ? `), true)` : `))`,
          })
        }
        for (const [offset, b] of buckets) {
          b.opens.sort((x, y) => y.end - x.end)
          b.closes.sort((x, y) => y.start - x.start)
          ms.appendLeft(
            offset,
            b.closes.map((x) => x.text).join('') + b.opens.map((x) => x.text).join(''),
          )
        }

        return {
          code: ms.toString(),
          map: ms.generateMap({ source: file, includeContent: true, hires: true }),
        }
      } finally {
        lease.dispose()
      }
    },
  }
}
