// Probe: which ways of saying "this expression" let TypeScript know which expression was meant?
//
// `select()` learns the selected expression from the TYPE of what the visitor returns. That is
// what gives the handler the expression's result type and makes "matched 0" and "matched 2"
// compile errors. So a selector vocabulary is only as good as what the compiler can follow.
//
// For a synthetic file of N call expressions this compiles one selection per style and reports
// whether the compiler ended up with exactly the intended expression, and how long the check of
// 40 selections takes.
import { join } from 'node:path'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { API, ModuleKind, ModuleResolutionKind } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { ScriptTarget } from 'typescript/ast'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ep-probe-follow-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

// One member per expression. `flat` is today's shape; `nested` is the shape of a Babel or ESTree
// node (`node.callee.object.name`) with its enclosing function and class as a parent chain.
function registry(count) {
  const flat = []
  const nested = []
  const named = []
  const inside = new Map()
  for (let i = 0; i < count; i += 1) {
    named.push(
      `type Call${i} = { readonly id: 'e${i}'; readonly type: 'CallExpression'; readonly callee: '${i % 2 ? 'cache' : 'db'}.call${i}'; readonly line: ${i + 1}; readonly result: Promise<${i}> }`,
    )
    inside.set(`fn${i % 25}`, [...(inside.get(`fn${i % 25}`) ?? []), `Call${i}`])
    const fn = `fn${i % 25}`
    const cls = `Class${i % 5}`
    const receiver = i % 2 ? 'cache' : 'db'
    flat.push(
      `  | { readonly id: 'e${i}'; readonly kind: 'CallExpression'; readonly callee: '${receiver}.call${i}'; readonly inFunction: '${cls}.${fn}'; readonly line: ${i + 1}; readonly result: Promise<${i}> }`,
    )
    nested.push(
      `  | { readonly id: 'e${i}'; readonly line: ${i + 1}; readonly result: Promise<${i}>;` +
        ` readonly node: { readonly type: 'CallExpression'; readonly callee: { readonly type: 'MemberExpression'; readonly object: { readonly type: 'Identifier'; readonly name: '${receiver}' }; readonly property: { readonly type: 'Identifier'; readonly name: 'call${i}' } } };` +
        ` readonly parent: { readonly type: 'ClassMethod'; readonly key: { readonly name: '${fn}' }; readonly parent: { readonly type: 'ClassDeclaration'; readonly id: { readonly name: '${cls}' } } };` +
        ` findParent(test: (ancestor: { readonly type: string; readonly name: string }) => boolean): { readonly type: string; readonly name: string } | null }`,
    )
  }
  const functions = [...inside].map(
    ([name, calls]) => `  | (Traversable & { readonly type: 'ClassMethod'; readonly name: '${name}'; readonly __inside: ${calls.join(' | ')} })`,
  )
  return `
${named.join('\n')}
/** What a node contains is known to the types, so a visitor for its inside can be typed from it. */
type InsideOf<Node> = Node extends { readonly __inside: infer Inside } ? Inside : never
type VisitorInside<Node, R> = { CallExpression?(node: InsideOf<Node>): R }
interface Traversable {
  traverse<R>(visitor: VisitorInside<this, R>): R
}
export type Functions =
${functions.join('\n')}
/** Babel's own way to say "inside": visit the function, then traverse into it. */
export declare function pickTree<R>(visitor: {
  Function?(node: Functions): R
  CallExpression?(node: ${named.map((_, i) => `Call${i}`).join(' | ')}): R
}): Exclude<R, Falsy>
export type Flat =
${flat.join('\n')}
export type Nested =
${nested.join('\n')}

type Falsy = false | undefined | null
/** What select() does today: the selected expression is the type of what the visitor returns. */
export declare function pick<R>(visitor: (node: Flat) => R): Exclude<R, Falsy>
export declare function pickNested<R>(visitor: (path: Nested) => R): Exclude<R, Falsy>

/** A node with a type guard, the way @babel/traverse types \`path.isIdentifier(opts)\`. */
export type Guarded = Flat & { is<const P extends object>(opts: P): this is P }
export declare function pickGuarded<R>(visitor: (path: Guarded) => R): Exclude<R, Falsy>

/** A visitor object keyed by node type, as in Babel and ESLint. */
export declare function pickByKind<R>(visitor: { CallExpression(node: Extract<Flat, { kind: 'CallExpression' }>): R }): Exclude<R, Falsy>

/** A pattern the node has to contain, as in Jest's toMatchObject. */
export declare function pickPattern<const P extends object>(pattern: P): Extract<Nested, P>
`
}

const styles = {
  'direct property (today)': (i) =>
    `pick((n) => n.callee === 'db.call${i}' && n).id`,
  'direct properties, two of them': (i) =>
    `pick((n) => n.callee === 'db.call${i}' && n.inFunction === 'Class${i % 5}.fn${i % 25}' && n).id`,
  'visitor keyed by node type': (i) =>
    `pickByKind({ CallExpression: (n) => n.callee === 'db.call${i}' && n }).id`,
  'type guard with a match object (Babel: path.isX(opts))': (i) =>
    `pickGuarded((p) => p.is({ callee: 'db.call${i}' }) && p).id`,
  'pattern object over nested nodes (Jest: toMatchObject)': (i) =>
    `pickPattern({ node: { callee: { property: { name: 'call${i}' } } } }).id`,
  'nested property (Babel: path.node.callee.property.name)': (i) =>
    `pickNested((p) => p.node.callee.property.name === 'call${i}' && p).id`,
  'parent chain (Babel: path.parent...)': (i) =>
    `pickNested((p) => p.parent.key.name === 'fn${i % 25}' && p.node.callee.property.name === 'call${i}' && p).id`,
  'ancestor callback (Babel: path.findParent(cb))': (i) =>
    `pickNested((p) => p.findParent((a) => a.name === 'fn${i % 25}') && p).id`,
  'nested traversal (Babel: path.traverse(visitor))': (i) =>
    `pickTree({ Function: (fn) => fn.name === 'fn${i % 25}' && fn.traverse({ CallExpression: (call) => call.callee === 'db.call${i}' && call }) }).id`,
  'nested traversal, the function not narrowed first': (i) =>
    `pickTree({ Function: (fn) => fn.traverse({ CallExpression: (call) => call.callee === 'db.call${i}' && call }) }).id`,
}

const SELECTIONS = 40
function measure(count, style) {
  const api = new API({ cwd: root })
  let snapshot
  try {
    const lines = Array.from({ length: SELECTIONS }, (_, k) => {
      const i = ((k * 2) % count) - (((k * 2) % count) % 2) // an even index: a "db" call
      // Compiles only if the compiler knows exactly which expression this is.
      return `export const s${k}: 'e${i}' = ${styles[style](i)}`
    })
    const test = `import { pick, pickNested, pickGuarded, pickByKind, pickPattern, pickTree } from './registry'\n${lines.join('\n')}\n`
    const files = new Map([
      [join(root, 'registry.ts'), registry(count)],
      [join(root, 'test.ts'), test],
    ])
    const started = performance.now()
    snapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...files]),
      createPrograms: [
        {
          rootFiles: [...files.keys()],
          compilerOptions: {
            strict: true,
            target: ScriptTarget.ES2022,
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.Bundler,
            noEmit: true,
            skipLibCheck: true,
          },
        },
      ],
    })
    const program = snapshot.operation.createdPrograms[0]
    const errors = program
      .getSemanticDiagnostics()
      .filter((d) => d.category === 1 && d.fileName?.endsWith('test.ts'))
    if (process.env.SHOW_ERRORS && errors.length) console.log(`   first error: ${String(errors[0].text).slice(0, 300)}`)
    const elsewhere = program.getSemanticDiagnostics().filter((d) => d.category === 1 && !d.fileName?.endsWith('test.ts'))
    if (elsewhere.length) throw new Error(`the probe's own types do not compile: ${elsewhere[0].text}`)
    return { known: SELECTIONS - new Set(errors.map((d) => d.pos)).size, ms: Math.round(performance.now() - started) }
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

for (const count of [200, 1000]) {
  console.log(`\n## a file with ${count} selectable expressions, ${SELECTIONS} selections`)
  // The first program of a process pays for loading the standard library.
  measure(count, 'direct property (today)')
  for (const style of Object.keys(styles)) {
    const { known, ms } = measure(count, style)
    console.log(`${style.padEnd(58)} compiler knows the expression in ${String(known).padStart(2)} of ${SELECTIONS} | check ${String(ms).padStart(5)} ms`)
  }
}
