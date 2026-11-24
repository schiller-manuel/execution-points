// Probe (end to end, real tsc): how does the cost of typechecking select() calls grow with the
// number of selectable expressions in ONE target file (the size of that file's node union)?
import { consumer } from './e2e.mjs'

const targetSource = (functions) => {
  let out = ''
  for (let i = 0; i < functions; i++) {
    out += `function load${i}(id: string) { return { id, qty: id.length, price: 2 } }
export function total${i}(ids: string[], taxed: boolean) {
  let sum = 0
  for (const id of ids) {
    const item = load${i}(id)
    const line = item.qty * item.price
    sum = sum + (taxed ? line * 1.2 : line)
  }
  return sum > 100 ? Math.round(sum) : sum
}
`
  }
  return out
}
const testSource = (selects) => {
  let out = `import { select } from 'execution-points-prototype'\nimport { total0 } from '../src/app'\n`
  for (let i = 0; i < selects; i++) {
    out += `export const p${i} = select('src/app.ts', (n) => n.callee === 'load${i}' && n).capture('id')\n`
  }
  return out + `p0.withReplacement(({ locals }) => ({ id: locals.id, qty: 1, price: 1 }), () => total0(['a'], false))\n`
}

for (const [functions, selects] of [[5, 5], [50, 10], [200, 10], [200, 40]]) {
  const c = consumer({ 'src/app.ts': targetSource(functions), 'test/app.test.ts': selects ? testSource(selects) : 'export {}\n' })
  const t = performance.now()
  const r = c.tsc()
  const ms = performance.now() - t
  console.log(`${String(functions * 8).padStart(5)} selectable expressions in the file, ${String(selects).padStart(2)} select() calls in the test -> tsc exit=${r.status} in ${(ms / 1000).toFixed(1)} s${r.status ? `  ${r.out.trim().split('\n')[0].slice(0, 160)}` : ''}`)
}
