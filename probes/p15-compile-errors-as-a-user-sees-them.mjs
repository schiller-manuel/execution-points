// Probe (end to end, real tsc): the compiler messages a test author gets for common mistakes.
import { consumer } from './e2e.mjs'

const src = `export function quote(region: 'EU' | 'US', qty: number) {
  const base = price(region)
  const shipping = price(region) / 10
  return base * qty + shipping
}
function price(region: string) { return region === 'EU' ? 12 : 10 }
export function tag<T>(item: T, id: string) { return wrap(item, label(id)) }
function wrap<T>(item: T, l: string) { return { item, l } }
function label(id: string) { return '#' + id }
`
const head = `import { select } from 'execution-points-prototype'\nimport { quote, tag } from '../src/app'\n`
const mistakes = {
  'ambiguous selector (two price() calls)': `const p = select('src/app.ts', (n) => n.callee === 'price' && n)\np.withReplacement(() => 1, () => quote('EU', 1))`,
  'ambiguous selector, point only passed along': `const p = select('src/app.ts', (n) => n.callee === 'price' && n)\nexport const points = [p]`,
  'typo in callee': `const p = select('src/app.ts', (n) => n.callee === 'prise' && n)\np.withReplacement(() => 1, () => quote('EU', 1))`,
  'typo in file name': `const p = select('src/ap.ts', (n) => n.callee === 'price' && n)`,
  'wrong return type': `const p = select('src/app.ts', (n) => n.operator === '*' && n)\np.withReplacement(() => 'free', () => quote('EU', 1))`,
  'unknown capture': `const p = select('src/app.ts', (n) => n.operator === '*' && n).capture('basee')`,
  'expression inside a generic function': `const p = select('src/app.ts', (n) => n.callee === 'wrap' && n)\np.withReplacement(({ original }) => original(), () => tag(1, 'a'))`,
  'capturing a generic-typed local': `const p = select('src/app.ts', (n) => n.callee === 'label' && n).capture('item')`,
  'visitor returns a boolean': `const p = select('src/app.ts', (n) => n.operator === '*')`,
}
for (const [label, body] of Object.entries(mistakes)) {
  const { status, out } = consumer({ 'src/app.ts': src, 'test/app.test.ts': head + body + '\n' }).tsc()
  const lines = out.trim().split('\n').filter(Boolean)
  console.log(`\n## ${label}  (tsc exit=${status}, ${lines.filter((l) => /error TS/.test(l)).length} error(s))`)
  for (const l of lines.slice(0, 5)) console.log(`   ${l.length > 330 ? l.slice(0, 330) + ' …' : l}`)
}
