// Probe: beyond Node built-ins, does the registry carry the SAME type the original expression has?
// For each target: the emitted result type, registry errors, and whether a handler that returns a
// value of the original type is accepted.
import { api, nodeLines, registry, typecheck } from './types.mjs'

const head = `import { select } from 'execution-points-prototype'\nimport * as app from './src/app'\n`
const cases = {
  'exported enum member': {
    src: `export enum Status { Ok, Err }\nfunction pick(): Status.Ok { return Status.Ok }\nexport function run() { return pick() }\n`,
    use: `select('src/app.ts', (n) => n.callee === 'pick' && n).withReplacement(() => app.Status.Ok, () => app.run())`,
  },
  'optional parameter of an exported enum type': {
    src: `export enum Status { Ok, Err }\nfunction label(s: Status) { return String(s) }\nexport function run(maybe?: Status) { return label(maybe ?? Status.Ok) }\n`,
    use: `select('src/app.ts', (n) => n.callee === 'label' && n).capture('maybe').withReplacement(({ locals }) => String(locals.maybe), () => app.run())`,
  },
  'object with a Symbol.iterator method': {
    src: `function bag(): { [Symbol.iterator](): Iterator<number>; size: number } { return new Set<number>() }\nexport function run() { return bag() }\n`,
    use: `select('src/app.ts', (n) => n.callee === 'bag' && n).withReplacement(() => new Set<number>(), () => app.run())`,
  },
  'private alias of an array type': {
    src: `interface Item { id: string }\ntype Items = Item[]\nfunction load(): Items { return [] }\nexport function run() { return load().length }\n`,
    use: `select('src/app.ts', (n) => n.callee === 'load' && n).withReplacement(() => [], () => app.run())`,
  },
  'control: plain array of a private interface': {
    src: `interface Item { id: string }\nfunction load(): Item[] { return [] }\nexport function run() { return load().length }\n`,
    use: `select('src/app.ts', (n) => n.callee === 'load' && n).withReplacement(() => [], () => app.run())`,
  },
}
let wrong = 0
for (const [label, { src, use }] of Object.entries(cases)) {
  const reg = registry({ 'src/app.ts': src }, ['src/app.ts'])
  const node = nodeLines(reg.text).find((n) => /:(pick|label|bag|load):/.test(n.id))
  const errors = typecheck(reg, head + use + '\n')
  const registryErrors = errors.filter((e) => e.startsWith('__registry'))
  const useErrors = errors.filter((e) => e.startsWith('snippet'))
  const ok = !registryErrors.length && !useErrors.length
  if (!ok) wrong++
  console.log(`\n## ${label}`)
  console.log(`   emitted: ${node.unportable ? `UNSELECTABLE ${node.unportable}` : `result ${node.result}; locals ${node.locals}`}`)
  console.log(`   registry errors: ${registryErrors.length ? registryErrors.map((e) => e.replace('__registry.ts: ', '')).slice(0, 2).join(' | ') : 'none'}`)
  console.log(`   handler returning a value of the original type: ${useErrors.length ? 'REJECTED ' + useErrors[0].replace('snippet.test.ts: ', '').slice(0, 170) : 'accepted'}`)
}
console.log(`\n${wrong} of ${Object.keys(cases).length - 1} non-control shapes are wrong (the control is expected to pass)`)
api.close(); process.exit(0)
