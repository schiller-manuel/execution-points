// Probe: how much real code does the "contains await / ?. / yield / super" skip rule hide?
// Counts CallExpression / BinaryExpression / ConditionalExpression nodes in the benchmark task
// sources and the repo's own src/, and compares with what discovery indexes.
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { API } from 'typescript/sync'
import { NodeFlags, SyntaxKind } from 'typescript/ast'
import { REPO, discovery } from './lib.mjs'

const api = new API()
const isAssign = (k) => k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment
const kinds = new Set([SyntaxKind.CallExpression, SyntaxKind.BinaryExpression, SyntaxKind.ConditionalExpression])

function containsAt(node, pred, sameFunctionOnly) {
  let found = false
  const visit = (n, top) => {
    if (found) return
    if (pred(n)) { found = true; return }
    if (!top && sameFunctionOnly && [SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression, SyntaxKind.FunctionDeclaration, SyntaxKind.MethodDeclaration].includes(n.kind)) return
    n.forEachChild((c) => visit(c, false))
  }
  visit(node, true)
  return found
}

function census(files, root) {
  const total = { all: 0, indexed: 0, awaitNestedFnOnly: 0, awaitSameFn: 0, optChainInside: 0 }
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const indexed = new Set(discovery.indexTargetFile(file, source, root, api).nodes.map((n) => `${n.start}:${n.end}`))
    const lease = api.createSourceFile(file, source)
    const sf = lease.sourceFile
    const walk = (n) => {
      if (kinds.has(n.kind) && !(n.kind === SyntaxKind.BinaryExpression && isAssign(n.operatorToken.kind))) {
        total.all++
        if (indexed.has(`${n.getStart(sf)}:${n.end}`)) total.indexed++
        else {
          const isAwait = (x) => x.kind === SyntaxKind.AwaitExpression
          const anyAwait = containsAt(n, isAwait, false)
          const sameFnAwait = containsAt(n, isAwait, true)
          if (sameFnAwait) total.awaitSameFn++
          else if (anyAwait) total.awaitNestedFnOnly++
          else if (containsAt(n, (x) => Boolean(x.questionDotToken || (x.flags & NodeFlags.OptionalChain)), false)) total.optChainInside++
        }
      }
      n.forEachChild(walk)
    }
    walk(sf)
    lease.dispose()
  }
  return total
}

const groups = {
  'bench/tasks/*/src (non-test)': globSync('bench/tasks/*/src/*.ts', { cwd: REPO }).filter((f) => !f.endsWith('.test.ts')),
  'examples/*.ts (non-test)': globSync('examples/*.ts', { cwd: REPO }).filter((f) => !f.endsWith('.test.ts')),
  "the repo's own src/*.mjs": globSync('src/*.mjs', { cwd: REPO }),
  'bench/*.mjs harness code': globSync('bench/*.mjs', { cwd: REPO }),
}
for (const [label, rels] of Object.entries(groups)) {
  const t = census(rels.map((r) => join(REPO, r)), REPO)
  const hidden = t.all - t.indexed
  console.log(`${label}: ${rels.length} files`)
  console.log(`  candidate expressions: ${t.all}, indexed: ${t.indexed}, hidden: ${hidden} (${((100 * hidden) / t.all).toFixed(1)}%)`)
  console.log(`  hidden because await is only inside a nested callback: ${t.awaitNestedFnOnly}`)
  console.log(`  hidden because await is in the same function:          ${t.awaitSameFn}`)
  console.log(`  hidden because ?. appears somewhere inside:            ${t.optChainInside}`)
}
api.close()
