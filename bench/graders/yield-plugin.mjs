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

export function benchYieldPlugin({ root }) {
  const realRoot = realpathSync(root)
  const srcRoot = path.resolve(realRoot, 'src') + path.sep
  const engineModulePath = path.resolve(realRoot, 'yield-engine.mjs')
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
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return null
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
          at(a.start).opens.push({
            end: a.end,
            text: `${helperName}(${JSON.stringify(`${rel}:${a.start}`)}, async () => (`,
          })
          at(a.end).closes.push({
            start: a.start,
            text: `))`,
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
