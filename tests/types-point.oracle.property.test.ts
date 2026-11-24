/**
 * This oracle owns what the compiler knows about a selected point: what each of its methods
 * takes and gives back, and which of them an expression offers at all. It is checked on the
 * diagnostics TypeScript 7.1 reports for test snippets compiled against the library's published
 * declarations and the registry generated for one target module. It owns `dist/runtime.d.mts`
 * (build before running it).
 *
 * ```ts
 * const sum = select('src/target.ts', (n) => n.operator === '+' && n)        // a + b, a number
 * const remote = select('src/target.ts', (n) => n.object === 'db' && n)      // db.get(key), a Promise<number>
 *
 * sum.returns('three')            // → does not compile: the expression gives a number
 * remote.resolves(7)              // → compiles; sum.resolves(7) does not, and the error says pause/resolves/rejects need a promise
 * sum.returns(1, { times: 'twice' }) // → does not compile: `times` is a number or 'any'
 * const text: string = sum.withReplacement(() => 1, () => 'done') // → compiles: the result is the action's
 * sum.withReplacement(1, () => 0) // → does not compile: nothing checks it at run time
 * ```
 *
 * The runtime does not look at the kind of an argument, so for every call below the compiler's
 * answer is the only answer there is. Where is that easy to lose? `sum.pause` exists when the
 * tests run; only its type says that a number cannot wait. Written as a string type that carried
 * the reason, calling it gave "Type 'String' has no call signatures": rejected, and the reason
 * never printed. So a rejected call is also checked for saying why.
 *
 * Three things decide every answer: the expression (what its evaluation can give, and whether
 * that is a promise), the value handed in, and the place it is handed to.
 *
 * For every selected expression and every value handed to it as the result of a
 * `withReplacement` or `replace` handler or to `returns`, the call compiles exactly when the
 * expression can evaluate to that value; `resolves` takes what the expression's promise is
 * fulfilled with, and `throws` takes anything (README, "The replacement's result must match the
 * selected expression's inferred type", and its list of shorthands).
 *
 * For every selected expression, `pause()`, `resolves`, `rejects` and handing the point to
 * `interleavings` compile exactly when the expression's value is a promise, and otherwise the
 * error says that the method needs an expression whose value is a promise; `interleavings` takes
 * nothing that `select` did not return (README: "This needs an expression whose value is a
 * promise", "Each selected expression must be one whose value is a promise, as for `pause`").
 *
 * For every method that takes options, an options object compiles exactly when each key is one
 * the README documents for that method with a value of the documented kind: `times` a number or
 * `'any'` and `on` a number or a list of numbers for a replacement, `schedule` a list of numbers
 * and `choose` a function that gives a number for `interleavings`.
 *
 * For every way of running an action (`withReplacement`, `pause().run`, `order.run`) the result
 * has the type of what the action returns, as a promise of what it resolves to for `order.run`;
 * and every other part that comes back has the type the README gives it: counts are numbers, a
 * schedule is a list of numbers, the released ids a list of strings, an arrival's locals are the
 * captured ones, a replacement can be restored and disposed, a pause released.
 *
 * For every place that takes a function, a visitor, or a list of points, a value of another kind
 * does not compile (Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: what the
 * compiler rejects is not checked again at run time; no `typeof` checks on arguments).
 *
 * Each law's histories are a full product of a few named choices, the snippet is written from
 * the choices, and the model answers from the choices alone: a set of what an expression gives,
 * a table of documented kinds. All snippets of the file are compiled once, each as its own
 * module; a snippet's diagnostics are the ones reported in its file.
 *
 * Limits: five expressions (a number, a string, a number or `undefined`, two promises) and five
 * values of types none of which is assignable to another, so "can evaluate to" is membership and
 * says nothing of subtypes, `any`, or `void` (the type oracle's law T4 has `void`). A rejected
 * call is checked for its reason only where the README words one. The gap check generates no
 * mutant of a declaration, so each law's evidence is its calibrations and the wrong declarations
 * of `checks/wrong-declarations.mjs`.
 */
import { API } from 'typescript/sync'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { createProject, generateAndCompile, removeProject, repoRoot } from './registry-harness'

const TARGET_REL = 'src/target.ts'
const TARGET_SOURCE = `
declare const db: { get(key: string): Promise<number> }
declare const names: { find(key: string): Promise<string> }
declare const cache: { get(key: string): number | undefined }

export async function load(key: string) {
  const hit = cache.get(key)
  const row = await db.get(key)
  const name = await names.find(key)
  return { name, row, hit }
}

export function total(a: number, b: number) {
  return a + b
}

export function label(a: number) {
  return String(a)
}
`

// ----------------------------------------------------------------------------------------------
// The choices the histories are made of.

/** A type of the small world the snippets live in. None is assignable to another. */
type Kind = 'number' | 'string' | 'undefined' | 'promise of number' | 'promise of string'

/** How a value of each kind is written, and how a binding of that kind is annotated. */
const VALUE: Readonly<Record<Kind, string>> = {
  number: '1',
  string: `'one'`,
  undefined: 'undefined',
  'promise of number': 'Promise.resolve(1)',
  'promise of string': `Promise.resolve('one')`,
}
const ANNOTATION: Readonly<Record<Kind, string>> = {
  number: 'number',
  string: 'string',
  undefined: 'undefined',
  'promise of number': 'Promise<number>',
  'promise of string': 'Promise<string>',
}
const KINDS = Object.keys(VALUE) as ReadonlyArray<Kind>

/** The expressions of the target module: how a test selects each, and what its evaluation can give. */
const EXPRESSIONS = {
  'the sum': { selector: `(n) => n.operator === '+' && n`, gives: ['number'] },
  'the text': { selector: `(n) => n.callee === 'String' && n`, gives: ['string'] },
  'the cache read': { selector: `(n) => n.callee === 'get' && n.object === 'cache' && n`, gives: ['number', 'undefined'] },
  'the awaited number': { selector: `(n) => n.callee === 'get' && n.object === 'db' && n`, gives: ['promise of number'] },
  'the awaited text': { selector: `(n) => n.callee === 'find' && n`, gives: ['promise of string'] },
} as const satisfies Record<string, { readonly selector: string; readonly gives: ReadonlyArray<Kind> }>
type Expression = keyof typeof EXPRESSIONS
const EXPRESSION_NAMES = Object.keys(EXPRESSIONS) as ReadonlyArray<Expression>

/** What a promise of this kind is fulfilled with; `undefined` when the kind is no promise. */
const fulfilledWith = (kind: Kind): Kind | undefined =>
  kind === 'promise of number' ? 'number' : kind === 'promise of string' ? 'string' : undefined

/** What the expression's promise is fulfilled with; `undefined` when its value is not a promise. */
const awaited = (expression: Expression): Kind | undefined => {
  const gives: ReadonlyArray<Kind> = EXPRESSIONS[expression].gives
  return gives.length === 1 ? fulfilledWith(gives[0]!) : undefined
}

const header = `import { select, interleavings, type InterleavingFailure } from 'execution-points-prototype'\nvoid interleavings\n`
const selected = (expression: Expression, capture = '') =>
  `select(${JSON.stringify(TARGET_REL)}, ${EXPRESSIONS[expression].selector})${capture}`

// ----------------------------------------------------------------------------------------------
// One compile for the file: every snippet is its own module of one project.

const snippets = new Map<string, string>()
/** Registers the snippet of a history, and gives the history back. */
function withSnippet<History extends { readonly name: string }>(history: History, code: string): History {
  if (snippets.has(history.name)) throw new Error(`Two histories are named ${history.name}`)
  snippets.set(history.name, `${header}${code}\n`)
  return history
}
const fileOf = (name: string) => `test/${[...snippets.keys()].indexOf(name)}.test.ts`

type Diagnostics = ReadonlyArray<{ readonly code: number; readonly text: string }>
let compiled: { readonly errors: Readonly<Record<string, Diagnostics>>; readonly registryErrors: ReadonlyArray<string> } | undefined

/** The diagnostics the compiler reports in the snippet of this history. */
function compile(name: string): { readonly diagnostics: Diagnostics; readonly registryErrors: ReadonlyArray<string> } {
  if (!compiled) {
    const api = new API({ cwd: repoRoot })
    const root = createProject({ [TARGET_REL]: TARGET_SOURCE })
    try {
      const extraFiles = Object.fromEntries([...snippets.entries()].map(([each, code]) => [fileOf(each), code]))
      const { reading, extraErrors } = generateAndCompile(api, root, [TARGET_REL], { extraFiles })
      compiled = { errors: extraErrors, registryErrors: [...reading.registryErrors, ...reading.projectErrors] }
    } finally {
      removeProject(root)
      api.close()
    }
  }
  return { diagnostics: compiled.errors[fileOf(name)]!, registryErrors: compiled.registryErrors }
}

const NEEDS_A_PROMISE = 'needs an expression whose value is a promise'

/** What the driver records for a snippet: whether it compiled, and whether a rejection gave the README's reason. */
interface Answer {
  readonly compiles: boolean
  readonly saysItNeedsAPromise: boolean
  readonly registryErrors: ReadonlyArray<string>
}

function observeSnippet(history: { readonly name: string }, observe: (checkpoint: string, value: unknown) => void): void {
  try {
    const { diagnostics, registryErrors } = compile(history.name)
    observe('snippet', {
      compiles: diagnostics.length === 0,
      saysItNeedsAPromise: diagnostics.some((each) => each.text.includes(NEEDS_A_PROMISE)),
      registryErrors: [...registryErrors],
    } satisfies Answer)
  } catch (error) {
    observe('snippet', { threw: error instanceof Error ? error.message : String(error) })
  }
}

const answer = (compiles: boolean, saysItNeedsAPromise = false): Answer => ({ compiles, saysItNeedsAPromise, registryErrors: [] })
const snippetOf = (observations: ReadonlyArray<{ readonly checkpoint: string; readonly value: unknown }>) =>
  observations.find((each) => each.checkpoint === 'snippet')?.value
const corruptTo =
  (wrong: Answer) =>
  <Observation extends { readonly checkpoint: string }>(trace: ReadonlyArray<Observation>): Array<Observation> =>
    trace.map((each) => (each.checkpoint === 'snippet' ? { ...each, value: wrong } : each))

// ----------------------------------------------------------------------------------------------
// Law: a value handed to a point is one its expression can evaluate to.

const VALUE_PLACES = ['withReplacement handler', 'replace handler', 'returns', 'resolves', 'throws'] as const
type ValuePlace = (typeof VALUE_PLACES)[number]

interface ValueHistory {
  readonly name: string
  readonly expression: Expression
  readonly place: ValuePlace
  readonly value: Kind
}

const writeValue = ({ expression, place, value }: ValueHistory): string => {
  const point = `const point = ${selected(expression)}\n`
  if (place === 'withReplacement handler') return `${point}point.withReplacement(() => ${VALUE[value]}, () => 0)`
  if (place === 'replace handler') return `${point}point.replace(() => ${VALUE[value]})`
  if (place === 'returns') return `${point}point.returns(${VALUE[value]})`
  if (place === 'resolves') return `${point}point.resolves(${VALUE[value]})`
  return `${point}point.throws(${VALUE[value]})`
}

const VALUE_HISTORIES: ReadonlyArray<ValueHistory> = EXPRESSION_NAMES.flatMap((expression) =>
  VALUE_PLACES.flatMap((place) =>
    KINDS.map((value) => {
      const history: ValueHistory = { name: `${place} of ${expression} given ${value}`, expression, place, value }
      return withSnippet(history, writeValue(history))
    }),
  ),
)

/** README: the replacement's result must match the selected expression's type; `resolves` fulfils its promise; `throws` takes any error. */
const valueCompiles = ({ expression, place, value }: ValueHistory): boolean => {
  if (place === 'throws') return true
  if (place === 'resolves') return awaited(expression) === value
  return (EXPRESSIONS[expression].gives as ReadonlyArray<Kind>).includes(value)
}

const valueStates = (history: ValueHistory): Array<string> => [
  valueCompiles(history) ? 'compiles' : 'rejected',
  awaited(history.expression) ? 'promise-expression' : 'plain-expression',
  EXPRESSIONS[history.expression].gives.length > 1 ? 'expression-of-two-kinds' : 'expression-of-one-kind',
  `place:${history.place}`,
]

oracleProperty({
  id: 'types-point-values',
  owns: ['dist/runtime.d.mts'],
  law: {
    statement:
      'For every selected expression and every value handed to it as the result of a withReplacement or replace handler or to returns, the call compiles exactly when the expression can evaluate to that value; resolves takes what the expression\'s promise is fulfilled with, and throws takes anything.',
    authority:
      'README, "The replacement\'s result must match the selected expression\'s inferred type. A Promise<number> expression requires a Promise<number> replacement", and the shorthands listed under "Replace it everywhere": returns, throws, resolves "for an expression whose value is a promise".',
    limits:
      'Five expressions (number, string, number | undefined, Promise<number>, Promise<string>) times five places times five values. No kind is assignable to another, so nothing is said of subtypes, any, or void.',
  },
  histories: {
    enumerated: VALUE_HISTORIES.map((history) => ({ ...history, states: valueStates(history) })),
    states: [
      'compiles',
      'rejected',
      'promise-expression',
      'plain-expression',
      'expression-of-two-kinds',
      'expression-of-one-kind',
      ...VALUE_PLACES.map((place) => `place:${place}`),
    ],
  },
  label: (history) => history.name,
  model: (history) => answer(valueCompiles(history)),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    observeSnippet(history, observe)
  },
  check: (_history, observations, expected) => {
    const seen = snippetOf(observations)
    // What a rejection says is the next law's: here only whether the call compiles.
    const comparable = seen && typeof seen === 'object' && 'compiles' in seen ? { ...seen, saysItNeedsAPromise: false } : seen
    return differs('snippet', 'snippet', comparable, expected) ?? pass
  },
  calibrations: [
    {
      name: 'a-string-for-a-number-compiles',
      law: 'snippet',
      history: { enumerated: 'returns of the sum given string' },
      corrupt: corruptTo(answer(true)),
    },
    {
      name: 'the-expressions-own-value-is-refused',
      law: 'snippet',
      history: { enumerated: 'withReplacement handler of the cache read given undefined' },
      corrupt: corruptTo(answer(false)),
    },
  ],
})

// ----------------------------------------------------------------------------------------------
// Law: waiting needs a promise, and a refusal says so.

const WAITING = ['pause', 'resolves', 'rejects', 'interleavings'] as const
type Waiting = (typeof WAITING)[number]

interface WaitingHistory {
  readonly name: string
  readonly expression: Expression
  readonly method: Waiting
  /** Whether what is handed over is the point `select` returned, or an object with a `pause` of its own. */
  readonly selected: boolean
}

const writeWaiting = ({ expression, method, selected: isSelected }: WaitingHistory): string => {
  const point = `const point = ${selected(expression)}\n`
  if (!isSelected) return `${point}for (const order of interleavings([{ pause: () => point.pause() }])) void order`
  if (method === 'pause') return `${point}point.pause()`
  if (method === 'resolves') return `${point}point.resolves(${VALUE[awaited(expression) ?? 'number']})`
  if (method === 'rejects') return `${point}point.rejects(new Error('refused'))`
  return `${point}for (const order of interleavings([point])) void order`
}

const WAITING_HISTORIES: ReadonlyArray<WaitingHistory> = [
  ...EXPRESSION_NAMES.flatMap((expression) =>
    WAITING.map((method): WaitingHistory => ({ name: `${method} on ${expression}`, expression, method, selected: true })),
  ),
  // Only an expression that can pause can be dressed up as a point at all.
  ...EXPRESSION_NAMES.filter((expression) => awaited(expression)).map(
    (expression): WaitingHistory => ({ name: `interleavings of a look-alike of ${expression}`, expression, method: 'interleavings', selected: false }),
  ),
].map((history) => withSnippet(history, writeWaiting(history)))

const waitingStates = (history: WaitingHistory): Array<string> => [
  awaited(history.expression) ? 'promise-expression' : 'plain-expression',
  history.selected ? 'selected-point' : 'look-alike',
  `method:${history.method}`,
]

oracleProperty({
  id: 'types-point-waiting',
  owns: ['dist/runtime.d.mts'],
  law: {
    statement:
      'For every selected expression, pause(), resolves, rejects and handing the point to interleavings compile exactly when the expression\'s value is a promise, and otherwise the error says that the method needs an expression whose value is a promise; interleavings takes nothing that select did not return.',
    authority:
      'README: "To hold one operation in the middle while another runs, pause the expression it is about to await. This needs an expression whose value is a promise"; resolves is listed "for an expression whose value is a promise"; "Each selected expression must be one whose value is a promise, as for pause".',
    limits:
      'Five expressions times four methods, and an object with a pause method of its own in place of a point. An expression typed any is not among them.',
  },
  histories: {
    enumerated: WAITING_HISTORIES.map((history) => ({ ...history, states: waitingStates(history) })),
    states: ['promise-expression', 'plain-expression', 'selected-point', 'look-alike', ...WAITING.map((method) => `method:${method}`)],
  },
  label: (history) => history.name,
  model: (history) => {
    const isPromise = awaited(history.expression) !== undefined
    return answer(history.selected && isPromise, history.selected && !isPromise)
  },
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    observeSnippet(history, observe)
  },
  check: (_history, observations, expected) => differs('snippet', 'snippet', snippetOf(observations), expected) ?? pass,
  calibrations: [
    {
      name: 'a-number-can-pause',
      law: 'snippet',
      history: { enumerated: 'pause on the sum' },
      corrupt: corruptTo(answer(true)),
    },
    {
      name: 'a-refusal-without-its-reason',
      law: 'snippet',
      history: { enumerated: 'pause on the sum' },
      corrupt: corruptTo(answer(false, false)),
    },
    {
      name: 'a-look-alike-is-taken',
      law: 'snippet',
      history: { enumerated: 'interleavings of a look-alike of the awaited number' },
      corrupt: corruptTo(answer(true)),
    },
  ],
})

// ----------------------------------------------------------------------------------------------
// Law: options are the documented ones.

const OPTION_METHODS = ['withReplacement', 'replace', 'returns', 'throws', 'resolves', 'rejects', 'interleavings'] as const
type OptionMethod = (typeof OPTION_METHODS)[number]
const OPTION_KEYS = ['times', 'on', 'schedule', 'choose', 'time'] as const
type OptionKey = (typeof OPTION_KEYS)[number]

/** The values an option is tried with, by the kind the README's tables speak of. */
const OPTION_VALUES = {
  'a number': '2',
  zero: '0',
  "the word 'any'": `'any'`,
  'another word': `'twice'`,
  'a list of numbers': '[1, 3]',
  'a list of words': `['first']`,
  'a boolean': 'true',
  'a function that gives a number': '(step: number, count: number, run: number) => (step + run) % count',
  'a function that gives a word': `() => 'first'`,
} as const
type OptionValue = keyof typeof OPTION_VALUES
const OPTION_VALUE_NAMES = Object.keys(OPTION_VALUES) as ReadonlyArray<OptionValue>

interface OptionHistory {
  readonly name: string
  readonly method: OptionMethod
  readonly key: OptionKey
  readonly value: OptionValue
}

const writeOption = ({ method, key, value }: OptionHistory): string => {
  const options = `{ ${key}: ${OPTION_VALUES[value]} }`
  const sum = `const point = ${selected('the sum')}\n`
  const remote = `const point = ${selected('the awaited number')}\n`
  if (method === 'withReplacement') return `${sum}point.withReplacement(() => 1, () => 0, ${options})`
  if (method === 'replace') return `${sum}point.replace(() => 1, ${options})`
  if (method === 'returns') return `${sum}point.returns(1, ${options})`
  if (method === 'throws') return `${sum}point.throws(new Error('refused'), ${options})`
  if (method === 'resolves') return `${remote}point.resolves(1, ${options})`
  if (method === 'rejects') return `${remote}point.rejects(new Error('refused'), ${options})`
  return `${remote}for (const order of interleavings([point], ${options})) void order`
}

const OPTION_HISTORIES: ReadonlyArray<OptionHistory> = OPTION_METHODS.flatMap((method) =>
  OPTION_KEYS.flatMap((key) =>
    OPTION_VALUE_NAMES.map((value) => {
      const history: OptionHistory = { name: `${method} with ${key} as ${value}`, method, key, value }
      return withSnippet(history, writeOption(history))
    }),
  ),
)

/** README, "How often it must run" and "Run every order": which values each documented option takes. */
const DOCUMENTED_OPTIONS: Readonly<Partial<Record<OptionKey, { readonly of: 'a replacement' | 'interleavings'; readonly takes: ReadonlyArray<OptionValue> }>>> = {
  times: { of: 'a replacement', takes: ['a number', 'zero', "the word 'any'"] },
  on: { of: 'a replacement', takes: ['a number', 'zero', 'a list of numbers'] },
  schedule: { of: 'interleavings', takes: ['a list of numbers'] },
  choose: { of: 'interleavings', takes: ['a function that gives a number'] },
}

const optionCompiles = ({ method, key, value }: OptionHistory): boolean => {
  const documented = DOCUMENTED_OPTIONS[key]
  return documented !== undefined && documented.of === (method === 'interleavings' ? 'interleavings' : 'a replacement') && documented.takes.includes(value)
}

oracleProperty({
  id: 'types-point-options',
  owns: ['dist/runtime.d.mts'],
  law: {
    statement:
      'For every method that takes options, an options object compiles exactly when its key is one the README documents for that method with a value of the documented kind: times a number or \'any\' and on a number or a list of numbers for a replacement, schedule a list of numbers and choose a function that gives a number for interleavings.',
    authority:
      'README, the table under the strict default ({ times: 2 }, { times: 0 }, { times: \'any\' }, { on: 2 }, { on: [1, 3] }) and "Run every order" (interleavings(points, { schedule }) and { choose }).',
    limits:
      'Seven methods times five keys (one of them a misspelling) times nine values, one key per options object. Whether a number is a count the run can satisfy is checked when the test runs, and is the runtime oracle\'s.',
  },
  histories: {
    enumerated: OPTION_HISTORIES.map((history) => ({
      ...history,
      states: [optionCompiles(history) ? 'compiles' : 'rejected', `method:${history.method}`, `key:${history.key}`],
    })),
    states: ['compiles', 'rejected', ...OPTION_METHODS.map((method) => `method:${method}`), ...OPTION_KEYS.map((key) => `key:${key}`)],
  },
  label: (history) => history.name,
  model: (history) => answer(optionCompiles(history)),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    observeSnippet(history, observe)
  },
  check: (_history, observations, expected) => differs('snippet', 'snippet', snippetOf(observations), expected) ?? pass,
  calibrations: [
    {
      name: 'times-takes-any-word',
      law: 'snippet',
      history: { enumerated: 'returns with times as another word' },
      corrupt: corruptTo(answer(true)),
    },
    {
      name: 'a-documented-option-is-refused',
      law: 'snippet',
      history: { enumerated: 'withReplacement with on as a list of numbers' },
      corrupt: corruptTo(answer(false)),
    },
  ],
})

// ----------------------------------------------------------------------------------------------
// Law: what comes back.

/** What a part that comes back is, in the README's words; a binding of each can be annotated. */
const PART_ANNOTATION = {
  ...ANNOTATION,
  'a list of numbers': 'readonly number[]',
  'a list of strings': 'readonly string[]',
  'something to call': '() => void',
  'something to dispose': 'Disposable',
} as const
type PartKind = keyof typeof PART_ANNOTATION
const PART_KINDS = Object.keys(PART_ANNOTATION) as ReadonlyArray<PartKind>

const RUNNERS = ['withReplacement', 'pause().run', 'order.run'] as const
type Runner = (typeof RUNNERS)[number]
/** What an action is tried with: `undefined` is left out, since an action that gives nothing has nothing to type. */
const ACTION_KINDS = KINDS.filter((kind) => kind !== 'undefined')

/** A part with a fixed type: how a snippet reads it into a binding annotated `as`. */
const PARTS = {
  'the count of a replacement': { is: 'number', read: (as: string) => `const got: ${as} = ${selected('the sum')}.returns(1).calls\nvoid got` },
  'the count of a point': { is: 'number', read: (as: string) => `const got: ${as} = ${selected('the sum')}.calls\nvoid got` },
  'the count of a pause': { is: 'number', read: (as: string) => `const got: ${as} = ${selected('the awaited number')}.pause().calls\nvoid got` },
  'the number of the evaluation': {
    is: 'number',
    read: (as: string) => `${selected('the sum')}.withReplacement(({ call, original }) => {\n  const got: ${as} = call\n  void got\n  return original()\n}, () => 0)`,
  },
  'the schedule of an order': {
    is: 'a list of numbers',
    read: (as: string) => `for (const order of interleavings([${selected('the awaited number')}])) {\n  const got: ${as} = order.schedule\n  void got\n}`,
  },
  'the released ids of an order': {
    is: 'a list of strings',
    read: (as: string) => `for (const order of interleavings([${selected('the awaited number')}])) {\n  const got: ${as} = order.released\n  void got\n}`,
  },
  'the schedule of a failure': { is: 'a list of numbers', read: (as: string) => `declare const failure: InterleavingFailure\nconst got: ${as} = failure.schedule\nvoid got` },
  'a captured local of an arrival': {
    is: 'string',
    read: (as: string) =>
      `const gate = ${selected('the awaited number', `.capture('key')`)}.pause()\nvoid gate.run(async () => {\n  const got: ${as} = (await gate.reached).locals.key\n  void got\n})`,
  },
  'the restore of a replacement': { is: 'something to call', read: (as: string) => `const got: ${as} = ${selected('the sum')}.returns(1).restore\nvoid got` },
  'the release of a pause': { is: 'something to call', read: (as: string) => `const got: ${as} = ${selected('the awaited number')}.pause().release\nvoid got` },
  'a replacement': { is: 'something to dispose', read: (as: string) => `const got: ${as} = ${selected('the sum')}.replace(() => 1)\nvoid got` },
} as const satisfies Record<string, { readonly is: PartKind; readonly read: (as: string) => string }>
type Part = keyof typeof PARTS
const PART_NAMES = Object.keys(PARTS) as ReadonlyArray<Part>

type BackHistory =
  | { readonly name: string; readonly through: Runner; readonly actionGives: Kind; readonly usedAs: PartKind }
  | { readonly name: string; readonly part: Part; readonly usedAs: PartKind }

const writeBack = (history: BackHistory): string => {
  const as = PART_ANNOTATION[history.usedAs]
  if ('part' in history) return PARTS[history.part].read(as)
  const action = `() => ${VALUE[history.actionGives]}`
  if (history.through === 'withReplacement') return `const got: ${as} = ${selected('the sum')}.withReplacement(() => 1, ${action})\nvoid got`
  if (history.through === 'pause().run') return `const got: ${as} = ${selected('the awaited number')}.pause().run(${action})\nvoid got`
  return `for (const order of interleavings([${selected('the awaited number')}])) {\n  const got: ${as} = order.run(${action})\n  void got\n}`
}

const BACK_HISTORIES: ReadonlyArray<BackHistory> = [
  ...RUNNERS.flatMap((through) =>
    ACTION_KINDS.flatMap((actionGives) =>
      PART_KINDS.map((usedAs): BackHistory => ({ name: `${through} of an action that gives ${actionGives}, used as ${usedAs}`, through, actionGives, usedAs })),
    ),
  ),
  ...PART_NAMES.flatMap((part) => PART_KINDS.map((usedAs): BackHistory => ({ name: `${part}, used as ${usedAs}`, part, usedAs }))),
].map((history) => withSnippet(history, writeBack(history)))

/**
 * README: `withReplacement` "returns the action's return value directly, including the same
 * promise"; `pause.run` returns what the action returns; `order.run` "resolves to what it
 * resolves to". Every other part has the kind its table entry names.
 */
const comesBackAs = (history: BackHistory): PartKind => {
  if ('part' in history) return PARTS[history.part].is
  if (history.through !== 'order.run') return history.actionGives
  return (fulfilledWith(history.actionGives) ?? history.actionGives) === 'number' ? 'promise of number' : 'promise of string'
}

const backStates = (history: BackHistory): Array<string> => [
  comesBackAs(history) === history.usedAs ? 'compiles' : 'rejected',
  'part' in history ? `part:${history.part}` : `through:${history.through}`,
  ...('part' in history ? [] : [fulfilledWith(history.actionGives) ? 'action-gives-a-promise' : 'action-gives-a-value']),
]

oracleProperty({
  id: 'types-point-results',
  owns: ['dist/runtime.d.mts'],
  law: {
    statement:
      'For every way of running an action (withReplacement, pause().run, order.run) the result has the type of what the action returns, as a promise of what it resolves to for order.run; and every other part that comes back has the type the README gives it: counts are numbers, a schedule is a list of numbers, the released ids a list of strings, an arrival\'s locals are the captured ones, a replacement can be restored and disposed, a pause released.',
    authority:
      'README: withReplacement "returns the action\'s return value directly, including the same promise when the action is asynchronous"; "using replacement = point.replace(handler)"; point.calls, replacement.calls, pause.calls, the call of a context; order.schedule and order.released under "Run every order"; the InterleavingFailure with its schedule.',
    limits:
      'Three ways of running an action times four kinds of result times nine uses, and eleven named parts times nine uses. A use is an annotated binding; no two of the nine kinds are assignable to each other, so nothing is said of a wider annotation such as unknown.',
  },
  histories: {
    enumerated: BACK_HISTORIES.map((history) => ({ ...history, states: backStates(history) })),
    states: [
      'compiles',
      'rejected',
      'action-gives-a-promise',
      'action-gives-a-value',
      ...RUNNERS.map((through) => `through:${through}`),
      ...PART_NAMES.map((part) => `part:${part}`),
    ],
  },
  label: (history) => history.name,
  model: (history) => answer(comesBackAs(history) === history.usedAs),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    observeSnippet(history, observe)
  },
  check: (_history, observations, expected) => differs('snippet', 'snippet', snippetOf(observations), expected) ?? pass,
  calibrations: [
    {
      name: 'the-result-is-anything',
      law: 'snippet',
      history: { enumerated: 'withReplacement of an action that gives string, used as number' },
      corrupt: corruptTo(answer(true)),
    },
    {
      name: 'an-order-gives-the-value-itself',
      law: 'snippet',
      history: { enumerated: 'order.run of an action that gives number, used as promise of number' },
      corrupt: corruptTo(answer(false)),
    },
    {
      name: 'a-schedule-of-strings',
      law: 'snippet',
      history: { enumerated: 'the schedule of an order, used as a list of strings' },
      corrupt: corruptTo(answer(true)),
    },
  ],
})

// ----------------------------------------------------------------------------------------------
// Law: an argument of the wrong kind does not compile.

/** What can be handed to a place, by what it is. */
const GIVEN = {
  'a function': '() => undefined',
  'an object': '{}',
  'a list': '[]',
  'a number': '1',
  'a string': `'total'`,
  null: 'null',
  // One point where a list of points belongs is the mistake closest to hand.
  'a point': selected('the awaited number'),
} as const
type Given = keyof typeof GIVEN
const GIVEN_NAMES = Object.keys(GIVEN) as ReadonlyArray<Given>

/** Every place that takes a function, a visitor, or a list of points: what it takes, and a call with the place left open. */
const PLACES = {
  'the visitor of select': { takes: ['a function', 'an object'], write: (given: string) => `void select(${JSON.stringify(TARGET_REL)}, ${given})` },
  'the handler of withReplacement': { takes: ['a function'], write: (given: string) => `${selected('the cache read')}.withReplacement(${given}, () => 0)` },
  'the action of withReplacement': { takes: ['a function'], write: (given: string) => `${selected('the cache read')}.withReplacement(() => undefined, ${given})` },
  'the handler of replace': { takes: ['a function'], write: (given: string) => `${selected('the cache read')}.replace(${given})` },
  'the action of pause().run': { takes: ['a function'], write: (given: string) => `${selected('the awaited number')}.pause().run(${given})` },
  'the points of interleavings': { takes: ['a list'], write: (given: string) => `for (const order of interleavings(${given})) void order` },
  'the action of order.run': {
    takes: ['a function'],
    write: (given: string) => `for (const order of interleavings([${selected('the awaited number')}])) void order.run(${given})`,
  },
} as const satisfies Record<string, { readonly takes: ReadonlyArray<Given>; readonly write: (given: string) => string }>
type Place = keyof typeof PLACES
const PLACE_NAMES = Object.keys(PLACES) as ReadonlyArray<Place>

interface KindHistory {
  readonly name: string
  readonly place: Place
  readonly given: Given
}

const KIND_HISTORIES: ReadonlyArray<KindHistory> = PLACE_NAMES.flatMap((place) =>
  GIVEN_NAMES.map((given) => withSnippet({ name: `${given} as ${place}`, place, given } satisfies KindHistory, PLACES[place].write(GIVEN[given]))),
)

const kindCompiles = ({ place, given }: KindHistory): boolean => (PLACES[place].takes as ReadonlyArray<Given>).includes(given)

oracleProperty({
  id: 'types-point-argument-kinds',
  owns: ['dist/runtime.d.mts'],
  law: {
    statement:
      'For every place that takes a function, a visitor, or a list of points, a value of another kind does not compile, and a value of that kind does.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: what the compiler rejects is not checked again at run time; no typeof checks on arguments. AGENTS.md records it under "Agreed direction".',
    limits:
      'Seven places times seven kinds of value (a function, an object, a list, a number, a string, null, a selected point). The function given returns nothing and the list is empty, so this says which kind a place takes and not what the function or the list must hold; the other laws do.',
  },
  histories: {
    enumerated: KIND_HISTORIES.map((history) => ({
      ...history,
      states: [kindCompiles(history) ? 'compiles' : 'rejected', `place:${history.place}`, `given:${history.given}`],
    })),
    states: ['compiles', 'rejected', ...PLACE_NAMES.map((place) => `place:${place}`), ...GIVEN_NAMES.map((given) => `given:${given}`)],
  },
  label: (history) => history.name,
  model: (history) => answer(kindCompiles(history)),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    observeSnippet(history, observe)
  },
  check: (_history, observations, expected) => differs('snippet', 'snippet', snippetOf(observations), expected) ?? pass,
  calibrations: [
    {
      name: 'a-number-as-a-handler-compiles',
      law: 'snippet',
      history: { enumerated: 'a number as the handler of withReplacement' },
      corrupt: corruptTo(answer(true)),
    },
    {
      name: 'one-point-is-taken-for-a-list',
      law: 'snippet',
      history: { enumerated: 'a point as the points of interleavings' },
      corrupt: corruptTo(answer(true)),
    },
    {
      name: 'a-function-as-a-handler-is-refused',
      law: 'snippet',
      history: { enumerated: 'a function as the handler of replace' },
      corrupt: corruptTo(answer(false)),
    },
  ],
})
