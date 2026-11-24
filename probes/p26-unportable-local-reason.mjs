// Probe: a local whose type cannot be written outside its declaration is left out of the names that
// capture() accepts. Does the registry say why, and what does the compiler tell the test author?
import { api, nodeLines, registry, typecheck } from './types.mjs'

const source = `function label(id: string) { return '#' + id }
function wrap<T>(item: T, l: string) { return { item, l } }
export function tag<T>(item: T, id: string) {
  interface Local { n: number }
  const scoped: Local = { n: 1 }
  return wrap(item, label(id + scoped.n))
}
`
const reg = registry({ 'src/app.ts': source }, ['src/app.ts'])
const line = reg.text.split('\n').find((l) => l.includes(':label:'))
console.log(`node label(...) in the registry:`)
console.log(`   locals: ${nodeLines(reg.text).find((n) => /:label:/.test(n.id)).locals}`)
console.log(`   __unportableLocals: ${/readonly __unportableLocals: (\{.*?\}); readonly result/.exec(line)?.[1] ?? '(none)'}`)
for (const name of ['item', 'scoped', 'id']) {
  const errors = typecheck(reg, `import { select } from 'execution-points-prototype'\nexport const p = select('src/app.ts', (n) => n.callee === 'label' && n).capture('${name}')\n`)
  console.log(`capture('${name}') -> ${errors.filter((e) => e.startsWith('snippet')).map((e) => e.replace('snippet.test.ts: ', '')).join(' | ') || 'accepted'}`)
}
console.log(`registry errors: ${typecheck(reg).filter((e) => e.startsWith('__registry')).length}`)
api.close(); process.exit(0)
