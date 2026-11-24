// Probe: what can a selector actually tell apart? Prints the descriptors a visitor sees.
import { indexSource } from './lib.mjs'

const cases = {
  'two classes with a same-named method': `
export class UserCache { private m = new Map<string, string>(); async get(id: string) { return this.m.get(id) ?? load(id) } }
export class OrderCache { private m = new Map<string, string>(); async get(id: string) { return this.m.get(id) ?? load(id) } }
declare function load(id: string): string`,
  'same method name on two receivers': `
export async function sync(id: string, cache: any, db: any) { const a = await cache.get(id); const b = await db.get(id); return a === b }`,
  'class field arrow / default export / object method': `
export class Svc { handle = async (id: string) => fetchUser(id); static make = () => build() }
export default async function (id: string) { return fetchOrder(id) }
export const api = { load: (id: string) => fetchItem(id), ['dyn' + 1]: () => fetchDyn() }
declare function fetchUser(id: string): unknown; declare function fetchOrder(id: string): unknown
declare function fetchItem(id: string): unknown; declare function fetchDyn(): unknown; declare function build(): unknown`,
  'calls whose callee is wrapped: non-null, parentheses, bracket access': `
export class Svc { handler?: (n: number) => number; client: any
  run(key: string) { return [this.handler!(1), (this.client.send)(2), this.client[key](3), this.client['fixed'](4)] } }`,
  'nested binary chain a + b + c': `export function f(a: number, b: number, c: number) { return a + b + c }`,
  'ternaries have no name at all': `export function f(a: boolean, b: boolean) { const x = a ? 1 : 2; const y = b ? 3 : 4; return x + y }`,
  'callbacks collapse into the nearest named function': `
export function run(xs: number[]) { return xs.map((x) => double(x)).filter((x) => keep(x)) }
declare function double(x: number): number; declare function keep(x: number): boolean`,
}
for (const [label, source] of Object.entries(cases)) {
  console.log(`\n## ${label}`)
  for (const n of indexSource(source).nodes) {
    const text = source.slice(n.start, n.end).replace(/\s+/g, ' ')
    console.log(`  inFunction=${JSON.stringify(n.inFunction)} kind=${n.kind.replace('Expression', '')} ${n.callee !== undefined ? `callee=${JSON.stringify(n.callee)}` : n.operator !== undefined ? `operator=${JSON.stringify(n.operator)}` : '(no name)'} nth=${n.nth}   <- ${text.slice(0, 48)}`)
  }
}
