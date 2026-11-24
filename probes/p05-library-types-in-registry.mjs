// Probe: does the generated registry typecheck when a selectable expression's type comes from
// a Node built-in module, a third-party package, or a generic function?
import { api, nodeLines, registry, typecheck } from './types.mjs'

const cases = {
  'node:fs Stats': `import { statSync } from 'node:fs'\nexport function size(p: string) { return statSync(p).size }\n`,
  'node:events EventEmitter': `import { EventEmitter } from 'node:events'\nfunction make() { return new EventEmitter() }\nexport function bus() { return make() }\n`,
  'node:http Server': `import { createServer } from 'node:http'\nexport function start() { return createServer() }\n`,
  'node:child_process ChildProcess': `import { spawn } from 'node:child_process'\nexport function run() { return spawn('ls') }\n`,
  'node:crypto Hash': `import { createHash } from 'node:crypto'\nexport function h() { return createHash('sha256') }\n`,
  'global fetch Response': `export function get(u: string) { return fetch(u) }\n`,
  'global setTimeout': `export function later(f: () => void) { return setTimeout(f, 1) }\n`,
  'global Map/Date/URL': `function mk() { return new Map<string, Date>() }\nexport function m() { return mk() }\nexport function u(s: string) { return URL.parse(s) }\n`,
  'third-party class (magic-string)': `import MagicString from 'magic-string'\nfunction mk(s: string) { return new MagicString(s) }\nexport function wrap(s: string) { return mk(s) }\n`,
  'third-party interface (vite ResolvedConfig)': `import { resolveConfig } from 'vite'\nexport function cfg() { return resolveConfig({}, 'serve') }\n`,
  'generic function body': `export async function retry<T>(fn: () => Promise<T>, n: number): Promise<T> {\n  try { return await fn() } catch (e) { if (n > 0) return retry(fn, n - 1); throw e }\n}\n`,
  'generic class method': `export class Cache<K, V> {\n  private m = new Map<K, V>()\n  constructor(private load: (k: K) => Promise<V>) {}\n  async get(k: K) { return this.m.get(k) ?? (await this.load(k)) }\n  has(k: K) { return this.m.has(k) }\n}\n`,
}

for (const [label, source] of Object.entries(cases)) {
  const reg = registry({ 'src/app.ts': source }, ['src/app.ts'], { packages: ['magic-string', 'vite'] })
  const nodes = nodeLines(reg.text)
  const errors = typecheck(reg)
  console.log(`\n## ${label}`)
  for (const n of nodes) {
    console.log(`  ${n.id}  result: ${n.unportable ? `UNPORTABLE ${n.unportable}` : n.result}`)
  }
  console.log(errors.length ? `  REGISTRY ERRORS (${errors.length}):\n    ${errors.slice(0, 4).join('\n    ')}` : '  registry typechecks cleanly')
}
api.close()
