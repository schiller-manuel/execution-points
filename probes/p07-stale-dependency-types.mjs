// Probe: when a target imports a NON-target module and that module changes, do the mapper's
// change detection (configIdentity / watchedFiles) and its warm snapshot cache notice?
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { api, TSCONFIG } from './types.mjs'
import { REPO, contracts, discovery, project } from './lib.mjs'

const { scanProject } = await import(`${REPO}/src/content-mapper.ts`)
const dep = (type, value) => `export function loadLimit(): ${type} { return ${value} }\n`
const root = project({
  'tsconfig.json': TSCONFIG,
  'points.ep': JSON.stringify({ targets: ['src/app.ts'] }),
  'src/limits.ts': dep('number', '5'),
  'src/app.ts': `import { loadLimit } from './limits'\nexport function allowed(n: number) {\n  const limit = loadLimit()\n  return n < limit\n}\n`,
})
const resultOf = (text) => /"src\/app\.ts#allowed:CallExpression:loadLimit:0".*?readonly result: (.*?); readonly locals/.exec(text)?.[1]
const localsOf = (text) => /"src\/app\.ts#allowed:BinaryExpression:<:0".*?readonly locals: (\{.*?\}) \}/.exec(text)?.[1]

const cache = {}
const run = () => {
  const plan = discovery.buildTargetPlan({ root, targets: ['src/app.ts'], api })
  return contracts.generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api, cache }).text
}
const scan = () => scanProject(root, join(root, 'tsconfig.json'), undefined)

const before = { text: run(), scan: scan() }
writeFileSync(join(root, 'src/limits.ts'), dep('string', '"5"')) // the dependency's return type changes
const after = { text: run(), scan: scan() }
// Now also touch the TARGET file (adds a comment), which does trigger the mapper again.
const appFile = join(root, 'src/app.ts')
writeFileSync(appFile, readFileSync(appFile, 'utf8') + '// touched\n')
const afterTargetEdit = { text: run(), scan: scan() }
const fresh = contracts.generateFileRegistryModule(discovery.buildTargetPlan({ root, targets: ['src/app.ts'], api }), { fromFile: join(root, 'points.ep'), api }).text

console.log(`watched files: ${before.scan.watchedFiles.map((f) => f.replace(root + '/', '')).join(', ')}`)
console.log(`configIdentity changed after editing src/limits.ts: ${before.scan.configIdentity !== after.scan.configIdentity}`)
console.log(`loadLimit() result type   before: ${resultOf(before.text)} | warm cache after edit: ${resultOf(after.text)} | cold run after edit: ${resultOf(fresh)}`)
console.log(`locals at "n < limit"     before: ${localsOf(before.text)} | warm cache after edit: ${localsOf(after.text)} | cold run after edit: ${localsOf(fresh)}`)
console.log(`after ALSO editing the target (mapper re-runs, warm cache): configIdentity changed=${after.scan.configIdentity !== afterTargetEdit.scan.configIdentity}, loadLimit() result type: ${resultOf(afterTargetEdit.text)}`)
api.close()
process.exit(0)
