// Probe: do the compile-time registry and the runtime registration agree on which files and
// nodes exist? Compares generateFileRegistryModule (types) with the plugin transform (runtime).
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { api, nodeLines, registry } from './types.mjs'
import { REPO, executionPoints } from './lib.mjs'

function runtimeIds(root, rel) {
  const plugin = executionPoints({ root, targets: [rel] })
  const ctx = { addWatchFile() {} }
  plugin.buildStart.call(ctx)
  const file = join(root, rel)
  const res = plugin.transform.call(ctx, readFileSync(file, 'utf8'), file)
  if (!res) return null
  // registerFile(file, nodes, homes): the nodes are the second argument.
  const m = /__epRegister\w*\((".*?"), (\[.*?\]), \[[\d,]*\]\);\n/s.exec(res.code)
  return JSON.parse(m[2]).map((n) => n.id)
}

const cases = {
  'ordinary module': `export function f(a: number) { return a + 1 }\n`,
  'file with a UTF-8 BOM': `﻿export function f(a: number) { return a + 1 }\n`,
  'global script (no import/export)': `function f(a: number) { return a + 1 }\n`,
  'CRLF line endings': `export function f(a: number) {\r\n  return a + 1\r\n}\r\n`,
}
for (const [label, source] of Object.entries(cases)) {
  const reg = registry({ 'src/app.ts': source }, ['src/app.ts'])
  const typeIds = nodeLines(reg.text).map((n) => JSON.parse(n.id))
  const rt = runtimeIds(reg.root, 'src/app.ts')
  const inRegistry = reg.text.includes('"src/app.ts"')
  console.log(`${label.padEnd(34)} | types: file ${inRegistry ? 'present' : 'ABSENT '} with ${typeIds.length} node(s) | runtime: ${rt ? `${rt.length} node(s) instrumented` : 'not instrumented'}`)
}

// A target path that does not exist, and malformed manifests: what does the mapper say, and where?
const { parseManifest, scanProject } = await import(`${REPO}/src/content-mapper.mjs`)
const reg = registry({ 'src/app.ts': cases['ordinary module'] }, ['src/app.ts', 'src/typo-does-not-exist.ts'])
console.log(`\nmissing target path -> registry keys: ${[...reg.text.matchAll(/^    (".*"): \w+;$/gm)].map((m) => m[1]).join(', ')}`)
for (const manifest of [
  '{"targets": ["src/app.ts", "src/typo-does-not-exist.ts"]}',
  '{"target": ["src/app.ts"]}',
  '{"targets": "src/app.ts"}',
  '{"targets": ["src/app.ts"], "tsconfg": "x.json"}',
  '{"targets": [42]}',
]) {
  let outcome
  try {
    const { diagnostics } = parseManifest(manifest, join(reg.root, 'points.ep'), reg.root)
    writeFileSync(join(reg.root, 'points.ep'), manifest)
    const scan = scanProject(reg.root, join(reg.root, 'tsconfig.json'), undefined)
    const said = diagnostics.map((d) => `at ${JSON.stringify(manifest.slice(d.start, d.start + d.length))}: ${d.messageText}`)
    outcome = `watched: ${scan.watchedFiles.map((f) => f.replace(reg.root + '/', '')).join(', ')}\n${said.map((line) => `     ${line}`).join('\n') || '     (no diagnostic)'}`
  } catch (error) {
    outcome = `threw ${error.constructor.name}: ${error.message}`
  }
  console.log(`manifest ${manifest}\n  -> ${outcome}`)
}
api.close()
process.exit(0)
