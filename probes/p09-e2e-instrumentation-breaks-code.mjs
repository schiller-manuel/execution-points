// Probe (end to end, real Vitest + real plugin): target modules that run fine uninstrumented.
// Does merely listing them in points.ep change or break their behavior? No select() is used.
import { consumer, tail } from './e2e.mjs'

const targets = {
  'enum with computed-looking initializers': {
    src: `export enum Flag { Read = 1 << 0, Write = 1 << 1, Admin }\nexport const admin = Flag.Admin\n`,
    test: `import { admin, Flag } from '../src/app'\ntest('enum', () => { expect([Flag.Read, Flag.Write, admin]).toEqual([1, 2, 3]) })`,
  },
  'const enum': {
    src: `export const enum Size { Small = 1 + 1, Large = Small * 2 }\nexport const large = Size.Large\n`,
    test: `import { large } from '../src/app'\ntest('const enum', () => { expect(large).toBe(4) })`,
  },
  'string enum referencing another member': {
    src: `export enum Route { Base = '/api', Users = Base + '/users' }\nexport const users = Route.Users\n`,
    test: `import { users } from '../src/app'\ntest('string enum', () => { expect(users).toBe('/api/users') })`,
  },
  'file with a UTF-8 BOM': {
    src: `﻿export function total(a: number, b: number) { return a + b }\n`,
    test: `import { total } from '../src/app'\ntest('bom', () => { expect(total(2, 3)).toBe(5) })`,
  },
  '"use strict" directive + sloppy-only check': {
    src: `'use strict'\nexport function isStrict(this: unknown) { return (function (this: unknown) { return this === undefined })() }\n`,
    test: `import { isStrict } from '../src/app'\ntest('strict', () => { expect(isStrict()).toBe(true) })`,
  },
  'decorator-free class with field initializers and static block': {
    src: `function seed() { return 2 }\nexport class Counter {\n  static base = seed() * 10\n  static { Counter.base = Counter.base + 1 }\n  value = Counter.base + seed()\n  next() { return this.value > 0 ? this.value + 1 : 0 }\n}\n`,
    test: `import { Counter } from '../src/app'\ntest('class', () => { expect(new Counter().next()).toBe(24) })`,
  },
  'parameter defaults, arguments and new.target': {
    src: `function pick(a: number) { return a }\nexport function f(a = pick(1), b = a + 1) { return arguments.length + a + b }\nexport function G(this: any) { return new.target ? pick(1) + 1 : pick(0) }\n`,
    test: `import { f, G } from '../src/app'\ntest('params', () => { expect(f()).toBe(3); expect(f(5)).toBe(12); expect(new (G as any)()).toBeTypeOf('object') })`,
  },
}

for (const [label, { src, test }] of Object.entries(targets)) {
  const header = `import { expect, test } from 'vitest'\n`
  const plain = consumer({ 'src/app.ts': src, 'test/app.test.ts': header + test }, { targets: [] }).vitest()
  const inst = consumer({ 'src/app.ts': src, 'test/app.test.ts': header + test }).vitest()
  const verdict = (r) => (r.status === 0 ? 'passes' : 'FAILS')
  console.log(`${label.padEnd(62)} | not a target: ${verdict(plain)} | listed as target: ${verdict(inst)}`)
  if (inst.status !== 0 && plain.status === 0) {
    const reason = inst.out.split('\n').filter((l) => /Error|error|✗|×|FAIL/.test(l)).slice(0, 4).join('\n      ')
    console.log(`      ${reason}`)
  }
}
