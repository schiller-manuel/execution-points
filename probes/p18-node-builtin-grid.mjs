// Probe: over a grid of everyday Node built-in calls, how often does one such call in a target
// file make the generated registry fail to typecheck?
import { api, nodeLines, registry, typecheck } from './types.mjs'

const grid = [
  ["node:fs", "statSync('x')"], ["node:fs", "readFileSync('x')"], ["node:fs", "readFileSync('x', 'utf8')"],
  ["node:fs", "createReadStream('x')"], ["node:fs", "readdirSync('x', { withFileTypes: true })"], ["node:fs", "watch('x')"],
  ["node:fs/promises", "open('x')"], ["node:fs/promises", "stat('x')"], ["node:fs/promises", "readFile('x', 'utf8')"],
  ["node:path", "parse('x')"], ["node:path", "join('a', 'b')"],
  ["node:url", "pathToFileURL('x')"], ["node:url", "parse('x')"],
  ["node:os", "cpus()"], ["node:os", "networkInterfaces()"],
  ["node:child_process", "spawn('ls')"], ["node:child_process", "execSync('ls')"],
  ["node:crypto", "createHash('sha256')"], ["node:crypto", "randomUUID()"], ["node:crypto", "createHmac('sha256', 'k')"],
  ["node:http", "createServer()"], ["node:http", "request('http://x')"],
  ["node:net", "connect(80)"], ["node:zlib", "createGzip()"],
  ["node:stream", "Readable.from([1])"], ["node:events", "once(process, 'exit')"],
  ["node:readline", "createInterface({ input: process.stdin })"],
  ["node:worker_threads", "receiveMessageOnPort(null as any)"],
  ["node:perf_hooks", "performance.now()"], ["node:perf_hooks", "performance.mark('x')"],
  ["node:timers/promises", "setTimeout(1)"], ["node:util", "inspect({})"], ["node:util", "parseArgs()"],
  ["node:dns/promises", "lookup('x')"], ["node:querystring", "parse('a=1')"],
  ["node:async_hooks", "executionAsyncResource()"], ["node:vm", "createContext()"], ["node:buffer", "Buffer.from('x')"],
]
let broken = 0
const rows = []
for (const [mod, call] of grid) {
  const name = call.split(/[.(]/)[0]
  const source = `import { ${name} } from '${mod}'\nexport function f() { return ${call} }\n`
  const reg = registry({ 'src/app.ts': source }, ['src/app.ts'])
  const targetErrors = typecheck(reg).filter((e) => e.startsWith('src/app.ts'))
  if (targetErrors.length) { rows.push(`  (skipped, my sample does not compile: ${mod} ${call})`); continue }
  const errors = typecheck(reg).filter((e) => e.startsWith('__registry.ts'))
  const outer = nodeLines(reg.text).at(0)
  if (errors.length) broken++
  rows.push(`  ${errors.length ? 'BROKEN' : 'ok    '} ${mod.padEnd(22)} ${call.padEnd(44)} -> ${String(outer?.unportable ? 'unportable' : outer?.result).slice(0, 60)}${errors.length ? `   [${errors[0].replace('__registry.ts: ', '').slice(0, 50)}]` : ''}`)
}
console.log(rows.join('\n'))
const counted = rows.filter((r) => !r.includes('skipped')).length
console.log(`\n${broken} of ${counted} Node built-in calls break the generated registry (${((100 * broken) / counted).toFixed(0)}%)`)
api.close(); process.exit(0)
