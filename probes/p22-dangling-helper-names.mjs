// Probe: when a type cannot be emitted as a helper interface (too many members, a generic method),
// what does the registry say for the SECOND expression or local that has the same type?
import { api, nodeLines, registry, typecheck } from './types.mjs'

const cases = {
  'AbortController local seen by two expressions': `export function start(run: (s: AbortSignal) => void) {\n  const controller = new AbortController()\n  run(controller.signal)\n  return String(controller.signal.aborted)\n}\n`,
  'private interface with 25 members, returned twice': `interface Wide { ${Array.from({ length: 25 }, (_, i) => `p${i}: number`).join('; ')} }\nfunction make(): Wide { return {} as Wide }\nexport function a() { return make().p0 }\nexport function b() { return make().p1 }\n`,
  'control: private interface with 3 members, returned twice': `interface Small { p0: number; p1: number; p2: number }\nfunction make(): Small { return {} as Small }\nexport function a() { return make().p0 }\nexport function b() { return make().p1 }\n`,
}
for (const [label, source] of Object.entries(cases)) {
  const reg = registry({ 'src/app.ts': source }, ['src/app.ts'])
  const errors = typecheck(reg).filter((e) => e.startsWith('__registry'))
  const helperRefs = [...new Set(reg.text.match(/__EP_\w+/g) ?? [])]
  const defined = helperRefs.filter((h) => new RegExp(`interface ${h} `).test(reg.text))
  console.log(`\n## ${label}`)
  for (const n of nodeLines(reg.text)) console.log(`   ${n.id}  ${n.unportable ? `UNSELECTABLE ${n.unportable}` : `result ${n.result}; locals ${n.locals}`}`)
  console.log(`   helper names referenced: ${helperRefs.join(', ') || '(none)'} | defined: ${defined.join(', ') || '(none)'}`)
  console.log(`   registry errors: ${errors.length ? errors.map((e) => e.replace('__registry.ts: ', '')).slice(0, 2).join(' | ') : 'none'}`)
}
api.close(); process.exit(0)
