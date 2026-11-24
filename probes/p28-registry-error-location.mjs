// Probe (end to end, real tsc): when an error sits inside the generated registry, where does tsc report it?
// The registry of the real generator has no errors, so this probe breaks a COPY of the generator inside a
// throwaway consumer project: every node of src/b.ts gets the type `NoSuchType`.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { consumer } from './e2e.mjs'

const c = consumer({
  'src/a.ts': `export function a(n: number) { return n + 1 }\n`,
  'src/b.ts': `export function b(n: number) { return n * 2 }\n`,
  'points.ep': `{\n  "tsconfig": "tsconfig.json",\n  "targets": [\n    "src/a.ts",\n    "src/b.ts"\n  ]\n}\n`,
})
const copy = join(c.root, 'node_modules/execution-points-prototype/src/contracts.mjs')
const source = readFileSync(copy, 'utf8')
const marker = 'emitted.result = emitter.emit(types[i], expression)'
if (!source.includes(marker)) throw new Error(`The generator no longer contains: ${marker}`)

let run = c.tsc()
console.log(`## the generator as it is\ntsc exit=${run.status}\n${run.out.trim() || '(no output)'}\n`)
writeFileSync(copy, source.replace(marker, `emitted.result = entry.relativeFile.endsWith('b.ts') ? 'NoSuchType' : emitter.emit(types[i], expression)`))
run = c.tsc()
console.log(`## a copy that writes NoSuchType for every node of src/b.ts\ntsc exit=${run.status}\n${run.out.trim()}`)
console.log(`\npoints.ep, line 5: ${readFileSync(join(c.root, 'points.ep'), 'utf8').split('\n')[4]}`)
