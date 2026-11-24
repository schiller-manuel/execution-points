/**
 * This oracle owns what the compiler knows when an expression is selected through a visitor
 * object: which expression it is, and so what its handler may return and which locals it can
 * capture. It is checked on the diagnostics TypeScript 7.1 reports for test snippets compiled
 * against the library's published declarations and the registry generated for one target
 * module. It owns `dist/runtime.d.mts` (build before running it) and
 * `src/contracts.ts#renderFileModule`.
 *
 * ```ts
 * const point = select('src/target.ts', {
 *   Class: (cls) => cls.name === 'Cart' && cls.traverse({
 *     Function: (fn) => fn.name === 'checkout' && fn.traverse({
 *       CallExpression: (call) => call.callee === 'get' && call.object === 'db' && call,
 *     }),
 *   }),
 * })
 * point.withReplacement(async ({ original }) => (await original()) + 1, action) // compiles: db.get(key) is a Promise<number>
 * // fn.name === 'chekout'          → TS2367: no function of that name is inside Cart
 * // a handler that returns `fn`    → does not compile: a container is no selection
 * // call.line, call.text, fn.line  → TS2339: a node does not say where it is written
 * // call.capture('key') on one way to a call, call.capture('each') on another
 * //                                → compiles, and locals has both key and each
 * ```
 *
 * A visitor that walks inward is only worth having if the compiler follows it: the handler of
 * the selected expression is typed by that expression, and a name that is not there is an error
 * before the test runs. Does the compiler still know the expression after two steps of
 * `traverse`? Does a call that two functions lead to count as one, and which locals does its
 * handler have when each way captured another?
 *
 * For every visitor object over the registry of a target module, a handler is given exactly the
 * nodes of its type that lie in scope (the file, or the inside of the container traversed), so
 * comparing a `name`, `callee` or `object` with a value that no such node has is a compile
 * error; a node carries what the code calls things and not where it is written, so reading
 * `line` or `text` of an expression, or `line` of a container, is a compile error; the selected
 * point has the type of the one expression the handlers return, through any depth of
 * `traverse`; an expression reached on several ways is one expression, whose locals are those
 * that a handler captured on any of the ways; no expression, or more than one, is a compile
 * error when the point is used; a handler that returns a container, and a key that is no node
 * type, do not compile; and the callback form sees the same properties (Decisions by Manuel
 * Schiller (GitHub schiller-manuel), 2026-11-24: "Nested traversal, keep callback too"; keep
 * `object`, drop `line` and `text` from the selectors; an expression selected on several ways
 * with a different capture on each is one selection that captures all of them. `probes/p30` is
 * the measurement that the compiler follows `traverse` and does not follow a parent chain).
 *
 * The model is a table of what each snippet must do. The snippets differ in one thing each from
 * the first, which compiles.
 */
import { API } from 'typescript/sync'
import { afterAll } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { createProject, generateAndCompile, removeProject, repoRoot } from './registry-harness'

const sharedApi = new API({ cwd: repoRoot })
afterAll(() => {
  sharedApi.close()
})

const TARGET_REL = 'src/target.ts'
const TARGET_SOURCE = `
declare const cache: { get(key: string): number | undefined }
declare const db: { get(key: string): Promise<number> }

export class Cart {
  async checkout(key: string) {
    const hit = cache.get(key)
    const row = await db.get(key)
    return hit ?? row
  }
  refund(key: string) {
    return cache.get(key)
  }
}

export class Order {
  checkout(key: string) {
    return [key].map((each) => cache.get(each))
  }
}

export function helper(a: number, b: number) {
  return a + b
}
`

const file = JSON.stringify(TARGET_REL)
const header = `import { select } from 'execution-points-prototype'\n`
/** The call `db.get(key)` in Cart's checkout, reached in two steps. */
const dbGetInCheckout = (functionName = 'checkout', last = `call.callee === 'get' && call.object === 'db' && call`) => `select(${file}, {
  Class: (cls) => cls.name === 'Cart' && cls.traverse({
    Function: (fn) => fn.name === '${functionName}' && fn.traverse({
      CallExpression: (call) => ${last},
    }),
  }),
})`

interface VisitorCase {
  readonly name: string
  readonly states: ReadonlyArray<string>
  readonly code: string
  /** What the diagnostics must say when the snippet must not compile. */
  readonly rejectedWith?: (allText: string, codes: ReadonlyArray<number>) => boolean
}

const VISITOR_CASES: ReadonlyArray<VisitorCase> = [
  {
    name: 'two-steps-select-one-call',
    states: ['compiles', 'two-steps', 'typed-by-the-expression'],
    code: `${header}
const point = ${dbGetInCheckout()}
point.withReplacement(async ({ original }) => (await original()) + 1, () => 0)`,
  },
  {
    name: 'handler-typed-by-the-selected-expression',
    states: ['rejected', 'two-steps', 'typed-by-the-expression'],
    // db.get(key) is a promise of a number: a string is no replacement for it.
    code: `${header}
const point = ${dbGetInCheckout()}
point.withReplacement(() => 'not a promise', () => 0)`,
    rejectedWith: (text) => text.includes('not assignable'),
  },
  {
    name: 'one-step-select-the-sum',
    states: ['compiles', 'one-step', 'typed-by-the-expression'],
    code: `${header}
const point = select(${file}, { Function: (fn) => fn.name === 'helper' && fn.traverse({ BinaryExpression: (sum) => sum }) })
const n: number = point.withReplacement(({ original }) => original() + 1, () => 0)
void n`,
  },
  {
    name: 'function-name-that-is-not-inside',
    states: ['rejected', 'two-steps', 'name-not-inside'],
    code: `${header}
const point = ${dbGetInCheckout('chekout')}
void point`,
    rejectedWith: (_text, codes) => codes.includes(2367),
  },
  {
    name: 'function-of-another-class',
    states: ['rejected', 'two-steps', 'name-not-inside'],
    // `helper` is a function of the file, but it is not inside Cart.
    code: `${header}
const point = ${dbGetInCheckout('helper')}
void point`,
    rejectedWith: (_text, codes) => codes.includes(2367),
  },
  {
    name: 'object-that-no-call-inside-has',
    states: ['rejected', 'two-steps', 'name-not-inside'],
    code: `${header}
const point = ${dbGetInCheckout('checkout', `call.object === 'store' && call`)}
void point`,
    rejectedWith: (_text, codes) => codes.includes(2367),
  },
  {
    name: 'two-calls-match',
    states: ['rejected', 'two-steps', 'too-many'],
    code: `${header}
const point = ${dbGetInCheckout('checkout', `call.callee === 'get' && call`)}
point.withReplacement(({ original }) => original(), () => 0)`,
    rejectedWith: (text) => text.includes('matched multiple') && text.includes('__matched'),
  },
  {
    name: 'kind-that-is-not-inside',
    states: ['rejected', 'one-step', 'none'],
    // Order has calls and no binary operation.
    code: `${header}
const point = select(${file}, { Class: (cls) => cls.name === 'Order' && cls.traverse({ BinaryExpression: (sum) => sum }) })
point.withReplacement(() => 0, () => 0)`,
    rejectedWith: (text) => text.includes('matched 0'),
  },
  {
    name: 'reached-through-two-functions',
    states: ['compiles', 'two-steps', 'several-ways-to-one-expression'],
    // Both Order's checkout and the callback inside it lead to cache.get(each).
    code: `${header}
const point = select(${file}, {
  Class: (cls) => cls.name === 'Order' && cls.traverse({
    Function: (fn) => fn.traverse({ CallExpression: (call) => call.callee === 'get' && call }),
  }),
})
point.withReplacement(({ original }) => original(), () => 0)`,
  },
  {
    name: 'constant-that-a-call-initializes',
    states: ['compiles', 'one-step', 'declarator-step', 'typed-by-the-expression'],
    code: `${header}
const point = select(${file}, { VariableDeclarator: (declared) => declared.name === 'row' && declared.traverse({ CallExpression: (call) => call }) })
point.withReplacement(async ({ original }) => (await original()) + 1, () => 0)`,
  },
  {
    name: 'capture-through-traversal',
    states: ['compiles', 'two-steps', 'captured'],
    code: `${header}
const point = select(${file}, {
  Class: (cls) => cls.name === 'Cart' && cls.traverse({
    Function: (fn) => fn.name === 'refund' && fn.traverse({ CallExpression: (call) => call.capture('key') }),
  }),
})
point.withReplacement(({ locals, original }) => {
  const key: string = locals.key
  void key
  return original()
}, () => 0)`,
  },
  {
    name: 'capture-of-a-name-that-is-not-a-local',
    states: ['rejected', 'two-steps', 'captured'],
    code: `${header}
const point = select(${file}, {
  Class: (cls) => cls.name === 'Cart' && cls.traverse({
    Function: (fn) => fn.name === 'refund' && fn.traverse({ CallExpression: (call) => call.capture('nope') }),
  }),
})
void point`,
    rejectedWith: (text) => text.includes('nope'),
  },
  {
    name: 'by-object-at-the-top',
    states: ['compiles', 'top-of-file', 'typed-by-the-expression'],
    // One call in the file is made on `db`.
    code: `${header}
const point = select(${file}, { CallExpression: (call) => call.object === 'db' && call })
point.withReplacement(async ({ original }) => (await original()) + 1, () => 0)`,
  },
  {
    name: 'object-that-no-call-in-the-file-has',
    states: ['rejected', 'top-of-file', 'name-not-inside'],
    code: `${header}
const point = select(${file}, { CallExpression: (call) => call.object === 'store' && call })
void point`,
    rejectedWith: (_text, codes) => codes.includes(2367),
  },
  {
    name: 'a-call-has-no-text',
    states: ['rejected', 'top-of-file', 'not-on-the-node'],
    code: `${header}
const point = select(${file}, { CallExpression: (call) => call.text === 'cache.get(each)' && call })
void point`,
    rejectedWith: (text, codes) => codes.includes(2339) && text.includes("'text'"),
  },
  {
    name: 'a-call-has-no-line',
    states: ['rejected', 'top-of-file', 'not-on-the-node'],
    code: `${header}
const point = select(${file}, { CallExpression: (call) => call.line === 18 && call })
void point`,
    rejectedWith: (text, codes) => codes.includes(2339) && text.includes("'line'"),
  },
  {
    name: 'a-function-has-no-line',
    states: ['rejected', 'one-step', 'not-on-the-node'],
    code: `${header}
const point = select(${file}, { Function: (fn) => fn.line === 22 && fn.traverse({ BinaryExpression: (sum) => sum }) })
void point`,
    rejectedWith: (text, codes) => codes.includes(2339) && text.includes("'line'"),
  },
  {
    name: 'two-ways-capture-differently',
    states: ['compiles', 'two-steps', 'several-ways-to-one-expression', 'captured', 'captures-differ'],
    // Order's checkout and the callback inside it both lead to cache.get(each); each way captures another local.
    code: `${header}
const point = select(${file}, {
  Class: (cls) => cls.name === 'Order' && cls.traverse({
    Function: (fn) => fn.traverse({
      CallExpression: (call) => call.callee === 'get' && (fn.name === 'checkout' ? call.capture('key') : call.capture('each')),
    }),
  }),
})
point.withReplacement(({ locals, original }) => {
  const key: string = locals.key
  const each: string = locals.each
  void [key, each]
  return original()
}, () => 0)`,
  },
  {
    name: 'captured-on-one-way-only',
    states: ['compiles', 'two-steps', 'several-ways-to-one-expression', 'captured', 'captures-differ', 'a-way-without-a-capture'],
    code: `${header}
const point = select(${file}, {
  Class: (cls) => cls.name === 'Order' && cls.traverse({
    Function: (fn) => fn.traverse({
      CallExpression: (call) => call.callee === 'get' && (fn.name === 'checkout' ? call : call.capture('each')),
    }),
  }),
})
point.withReplacement(({ locals, original }) => {
  const each: string = locals.each
  void each
  return original()
}, () => 0)`,
  },
  {
    name: 'a-local-that-no-way-captured',
    states: ['rejected', 'two-steps', 'several-ways-to-one-expression', 'captured', 'captures-differ', 'a-way-without-a-capture'],
    code: `${header}
const point = select(${file}, {
  Class: (cls) => cls.name === 'Order' && cls.traverse({
    Function: (fn) => fn.traverse({
      CallExpression: (call) => call.callee === 'get' && (fn.name === 'checkout' ? call : call.capture('each')),
    }),
  }),
})
point.withReplacement(({ locals, original }) => {
  void locals.key
  return original()
}, () => 0)`,
    rejectedWith: (text, codes) => codes.includes(2339) && text.includes("'key'"),
  },
  {
    name: 'handler-returns-the-container',
    states: ['rejected', 'one-step', 'not-a-selection'],
    code: `${header}
const point = select(${file}, { Function: (fn) => fn.name === 'helper' && fn })
void point`,
    rejectedWith: (text) => text.includes('not assignable'),
  },
  {
    name: 'key-that-is-no-node-type',
    states: ['rejected', 'top-of-file', 'not-a-selection'],
    code: `${header}
const point = select(${file}, { Method: (method: unknown) => method })
void point`,
    rejectedWith: (text) => text.includes('Method'),
  },
  {
    name: 'callback-form-sees-the-object',
    states: ['compiles', 'callback-form', 'typed-by-the-expression'],
    code: `${header}
const point = select(${file}, (n) => n.callee === 'get' && n.object === 'db' && n)
point.withReplacement(async ({ original }) => (await original()) + 1, () => 0)`,
  },
  {
    name: 'callback-form-has-no-line',
    states: ['rejected', 'callback-form', 'not-on-the-node'],
    code: `${header}
const point = select(${file}, (n) => n.line === 23 && n)
void point`,
    rejectedWith: (text, codes) => codes.includes(2339) && text.includes("'line'"),
  },
  {
    name: 'callback-form-has-no-text',
    states: ['rejected', 'callback-form', 'not-on-the-node'],
    code: `${header}
const point = select(${file}, (n) => n.text === 'a + b' && n)
void point`,
    rejectedWith: (text, codes) => codes.includes(2339) && text.includes("'text'"),
  },
]

/** A history names its snippet: a history is data, and what a snippet is rejected with is a function. */
const caseOf = (history: { readonly name: string }): VisitorCase => VISITOR_CASES.find((each) => each.name === history.name)!

oracleProperty({
  id: 'types-visitor-object',
  owns: ['dist/runtime.d.mts', 'src/contracts.ts#renderFileModule'],
  law: {
    statement:
      'For every visitor object over the registry of a target module, a handler is given exactly the nodes of its type that lie in scope (the file, or the inside of the container traversed), so comparing a name, callee or object with a value that no such node has is a compile error; a node carries what the code calls things and not where it is written, so reading line or text of an expression, or line of a container, is a compile error; the selected point has the type of the one expression the handlers return, through any depth of traverse; an expression reached on several ways is one expression, whose locals are those that a handler captured on any of the ways; no expression, or more than one, is a compile error when the point is used; a handler that returns a container, and a key that is no node type, do not compile; and the callback form sees the same properties.',
    authority:
      'Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24. On the selector API: "Nested traversal, keep callback too". On its properties: keep `object`, drop `line` and `text` from the selectors. On captures: an expression selected on several ways with a different capture on each is one selection that captures all of them. probes/p30-what-the-compiler-can-follow.mjs measures that the compiler follows traverse and does not follow a parent chain.',
    limits:
      'Twenty-five snippets against one target module of two classes, three methods, a callback, a function and two constants, checked through TypeScript 7.1 semantic diagnostics. A rejected snippet is checked for the diagnostic that says why, by code or by the text it must contain, not for its position. The compiler types the locals from what the handlers can return, so a capture on a way that the code never takes is in the type and not in the handler\'s locals when the test runs.',
  },
  histories: {
    enumerated: VISITOR_CASES.map(({ name, states }) => ({ name, states })),
    states: [
      'compiles',
      'rejected',
      'top-of-file',
      'one-step',
      'two-steps',
      'declarator-step',
      'callback-form',
      'typed-by-the-expression',
      'name-not-inside',
      'too-many',
      'none',
      'several-ways-to-one-expression',
      'captured',
      'captures-differ',
      'a-way-without-a-capture',
      'not-on-the-node',
      'not-a-selection',
    ],
  },
  label: (history) => history.name,
  model: (history) => ({ compiles: caseOf(history).rejectedWith === undefined, saysWhy: true, registryErrors: [] as Array<string> }),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    const { code, rejectedWith } = caseOf(history)
    const root = createProject({ [TARGET_REL]: TARGET_SOURCE })
    try {
      const { reading, extraErrors } = generateAndCompile(sharedApi, root, [TARGET_REL], {
        extraFiles: { 'test/snippet.test.ts': code },
      })
      const diagnostics = extraErrors['test/snippet.test.ts']!
      const allText = diagnostics.map((d) => `TS${d.code}: ${d.text}`).join('\n')
      observe('snippet', {
        compiles: diagnostics.length === 0,
        saysWhy: rejectedWith ? rejectedWith(allText, diagnostics.map((d) => d.code)) : true,
        registryErrors: [...reading.registryErrors, ...reading.projectErrors],
      })
    } catch (error) {
      observe('snippet', { threw: error instanceof Error ? error.message : String(error) })
    } finally {
      removeProject(root)
    }
  },
  check: (_history, observations, expected) =>
    differs('snippet', 'snippet', observations.find((o) => o.checkpoint === 'snippet')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'a-wrong-name-compiles',
      law: 'snippet',
      history: { enumerated: 'function-name-that-is-not-inside' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'snippet' ? { ...o, value: { compiles: true, saysWhy: true, registryErrors: [] } } : o)),
    },
    {
      name: 'a-node-says-which-line-it-is-on',
      law: 'snippet',
      history: { enumerated: 'callback-form-has-no-line' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'snippet' ? { ...o, value: { compiles: true, saysWhy: true, registryErrors: [] } } : o)),
    },
    {
      name: 'the-capture-of-one-way-is-lost',
      law: 'snippet',
      history: { enumerated: 'captured-on-one-way-only' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'snippet' ? { ...o, value: { compiles: false, saysWhy: true, registryErrors: [] } } : o)),
    },
    {
      name: 'the-selected-expression-is-not-known',
      law: 'snippet',
      history: { enumerated: 'two-steps-select-one-call' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'snippet' ? { ...o, value: { compiles: false, saysWhy: true, registryErrors: [] } } : o)),
    },
  ],
})
