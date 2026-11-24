// Probe: which everyday expression shapes can a test select at all?
// For each shape: what a visitor is offered, and which call / binary / ternary / new / await
// expressions in the source are NOT offered.
import { API } from 'typescript/sync'
import { SyntaxKind } from 'typescript/ast'
import { indexSource } from './lib.mjs'

const api = new API()
const interesting = new Set([
  SyntaxKind.CallExpression, SyntaxKind.BinaryExpression, SyntaxKind.ConditionalExpression,
  SyntaxKind.NewExpression, SyntaxKind.AwaitExpression, SyntaxKind.PropertyAccessExpression,
])
const isAssign = (k) => k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment

const shapes = {
  'plain call': `export async function f(a: any) { return helper(a) }`,
  'awaited call (await is outside the call)': `export async function f(a: any) { return await helper(a) }`,
  'call whose callback awaits': `export async function f(xs: any[]) { return Promise.all(xs.map(async (x) => { await helper(x) })) }`,
  'retry(async () => { await ... })': `export async function f() { return retry(async () => { await helper(1) }) }`,
  'call with an optional-chain argument': `export function f(s: any) { return helper(s?.userId) }`,
  'a ?? b?.c': `export function f(a: any, b: any) { return a ?? b?.c }`,
  'ternary with ?. in one branch': `export function f(a: any, c: boolean) { return c ? a?.b : 0 }`,
  'optional call a?.b()': `export function f(a: any) { return a?.b() }`,
  'callback that uses super': `class A extends B { run(xs: any[]) { return xs.map((x) => super.handle(x)) } }\nexport {}`,
  'call with a generator callback': `export function f() { return collect(function* () { yield 1 }) }`,
  'new Foo()': `export function f() { return new Foo(1) }`,
  'curried call make(a)(b)': `export function f(a: any, b: any) { return make(a)(b) }`,
  'property read cfg.timeout': `export function f(cfg: any) { return cfg.timeout }`,
  'the await expression itself': `export async function f(p: Promise<number>) { const v = await p; return v }`,
}

let nothing = 0
for (const [label, source] of Object.entries(shapes)) {
  const { nodes } = indexSource(source)
  const offered = new Set(nodes.map((n) => `${n.start}:${n.end}`))
  const lease = api.createSourceFile('/shape.ts', source)
  const sf = lease.sourceFile
  const hidden = []
  const walk = (n) => {
    const key = `${n.getStart(sf)}:${n.end}`
    if (interesting.has(n.kind) && !(n.kind === SyntaxKind.BinaryExpression && isAssign(n.operatorToken.kind)) && !offered.has(key)) {
      const isCallee = n.parent?.kind === SyntaxKind.CallExpression && n.parent.expression === n
      if (!(n.kind === SyntaxKind.PropertyAccessExpression && isCallee)) hidden.push(source.slice(n.getStart(sf), n.end).replace(/\s+/g, ' ').slice(0, 44))
    }
    n.forEachChild(walk)
  }
  walk(sf)
  lease.dispose()
  if (!nodes.length) nothing++
  console.log(`${label}`)
  console.log(`    offered: ${nodes.map((n) => source.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 44)).join('  |  ') || '(nothing)'}`)
  if (hidden.length) console.log(`    NOT offered: ${hidden.join('  |  ')}`)
}
console.log(`\n${nothing} of ${Object.keys(shapes).length} shapes offer nothing at all to select`)
api.close()
