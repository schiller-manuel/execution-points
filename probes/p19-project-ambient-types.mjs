// Probe: are types that the project declares outside the target files (a globals.d.ts, a
// `declare global` block, a module augmentation) visible when the registry is generated?
import { api, nodeLines, registry, typecheck } from './types.mjs'

const cases = {
  'global interface in src/globals.d.ts': {
    'src/globals.d.ts': `interface Shape { x: number; y: number }\n`,
    'src/app.ts': `export function origin(): Shape { return { x: 0, y: 0 } }\nexport function f() { return origin() }\n`,
  },
  '`declare global` in another module': {
    'src/env.ts': `export {}\ndeclare global { interface AppEnv { region: 'EU' | 'US' } var appEnv: AppEnv }\n`,
    'src/app.ts': `export function f() { return read(appEnv) }\nfunction read(e: AppEnv) { return e.region }\n`,
  },
  'module augmentation in another file': {
    'src/augment.d.ts': `import 'node:http'\ndeclare module 'node:http' { interface IncomingMessage { userId: string } }\n`,
    'src/app.ts': `import type { IncomingMessage } from 'node:http'\nexport function who(req: IncomingMessage) { return pick(req.userId) }\nfunction pick(id: string) { return id.toUpperCase() }\n`,
  },
  'control: same global declared inside the target': {
    'src/app.ts': `declare global { interface Shape2 { x: number } }\nexport function origin(): Shape2 { return { x: 0 } }\nexport function f() { return origin() }\n`,
  },
}
for (const [label, files] of Object.entries(cases)) {
  const reg = registry(files, ['src/app.ts'])
  const projectErrors = typecheck({ ...reg, targets: Object.keys(files) }).filter((e) => !e.startsWith('__registry'))
  console.log(`\n## ${label}   (the project itself compiles: ${projectErrors.length === 0})`)
  for (const n of nodeLines(reg.text)) {
    console.log(`   ${n.id}  ${n.unportable ? `UNSELECTABLE ${n.unportable}` : `result: ${n.result}; locals: ${n.locals}`}`)
  }
}
api.close(); process.exit(0)
