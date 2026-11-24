// Probe: how do the Vite plugin and the content mapper scale with the number of target files?
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { api, TSCONFIG } from './types.mjs'
import { contracts, discovery, executionPoints, project } from './lib.mjs'

const moduleSource = (i) => `export interface Item${i} { id: string; qty: number; price: number }
function load${i}(id: string): Item${i} { return { id, qty: id.length, price: 2 } }
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
const makeProject = (count) => {
  const files = { 'tsconfig.json': TSCONFIG }
  for (let i = 0; i < count; i++) files[`src/m${i}.ts`] = moduleSource(i)
  return project(files)
}

console.log('## Vite plugin: cost of transform() calls for modules that are NOT targets')
for (const count of [1, 50, 200]) {
  const root = makeProject(count)
  const plugin = executionPoints({ root, targets: ['src/*.ts'] })
  const ctx = { addWatchFile() {} }
  plugin.buildStart.call(ctx)
  const t = performance.now()
  for (let i = 0; i < 1000; i++) plugin.transform.call(ctx, 'export const x = 1\n', join(root, `other/dep${i}.ts`))
  const ms = performance.now() - t
  console.log(`  ${String(count).padStart(3)} target files: 1000 non-target transform() calls took ${ms.toFixed(0)} ms (${(ms / 1000).toFixed(2)} ms each)`)
}

console.log('\n## Content mapper: time to regenerate the registry')
for (const count of [1, 10, 40, 160]) {
  const root = makeProject(count)
  const cache = {}
  const gen = () => {
    const plan = discovery.buildTargetPlan({ root, targets: ['src/*.ts'], api })
    const t = performance.now()
    const { text } = contracts.generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api, cache })
    return { ms: performance.now() - t, nodes: plan.files.reduce((n, f) => n + f.nodes.length, 0), chars: text.length }
  }
  const cold = gen()
  const file = join(root, 'src/m0.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace('* 1.2', '* 1.25')) // one-character edit in ONE target
  const warm = gen()
  const unchanged = gen()
  console.log(`  ${String(count).padStart(3)} target files (${cold.nodes} nodes, ${(cold.chars / 1024).toFixed(0)} KB registry): cold ${cold.ms.toFixed(0)} ms | after editing 1 file ${warm.ms.toFixed(0)} ms | nothing changed ${unchanged.ms.toFixed(0)} ms`)
}
api.close()
process.exit(0)
