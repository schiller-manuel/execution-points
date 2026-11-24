// Probe (end to end, real Vitest): a replacement around an ASYNCHRONOUS action that never runs.
// The action's promise resolves normally; what does the test run report?
import { consumer } from './e2e.mjs'

const c = consumer({
  'src/app.ts': `export async function price(vip: boolean, base: number) { await null; return vip ? discount(base) : base }\nfunction discount(n: number) { return n - 1 }\n`,
  'test/app.test.ts': `import { expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { price } from '../src/app'

const discountPoint = select('src/app.ts', (n) => n.callee === 'discount' && n)

test('replaces the discount (but takes the path that never asks for one)', async () => {
  const result = await discountPoint.withReplacement(() => 0, () => price(false, 10))
  expect(result).toBe(10) // every assertion in the test passes
})

test('an unrelated test in the same file', () => { expect(1).toBe(1) })
`,
  // The repository's own config lists the setup module; the plugin will add it by itself.
  'vitest.config.mjs': `import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'
export default defineConfig({
  plugins: [executionPoints({ targets: ['src/**/*.ts'], root: import.meta.dirname })],
  test: { include: ['test/**/*.test.ts'], setupFiles: ['execution-points-prototype/vitest'] },
})
`,
})
const v = c.vitest()
console.log(`vitest exit=${v.status}`)
console.log(v.out.split('\n').filter((l) => /✓|×|Tests |execution-points\]/.test(l)).slice(0, 8).join('\n'))
