/**
 * Expression shapes for the oracles that ask which expressions a test can select and whether
 * selecting one changes what the code does. A shape is four choices: what an expression holds
 * (`content`), which expression holds it (`subject`), what the subject is wrapped in
 * (`wrapper`), and what the surrounding code does with the result (`position`).
 *
 * This file registers no tests. It holds the grammar, the source text of each shape, and the
 * rule the README states, written over the grammar's own tree, so that the discovery oracle
 * and the plugin oracle judge the same shapes.
 */
import fc from 'fast-check'

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export type Expr =
  | { t: 'id'; name: string }
  | { t: 'call'; callee: Expr; args: ReadonlyArray<Expr>; optional?: boolean }
  | { t: 'member'; object: Expr; name: string; optional?: boolean }
  | { t: 'element'; object: Expr; index: Expr }
  | { t: 'wrap'; how: 'paren' | 'as' | 'satisfies' | 'angle' | 'nonNull'; x: Expr }
  | { t: 'binary'; op: string; left: Expr; right: Expr }
  | { t: 'cond'; test: Expr; yes: Expr; no: Expr }
  | { t: 'unary'; how: 'await' | 'yield' | 'not' | 'delete' | 'spread'; x: Expr }
  | { t: 'update'; op: '++' | '--'; prefix: boolean; x: Expr }
  | { t: 'new'; callee: Expr; args: ReadonlyArray<Expr> }
  | { t: 'tag'; tag: Expr }
  | { t: 'list'; how: 'array' | 'template'; x: Expr }
  // Code that runs in a function of its own: `key` is evaluated by the enclosing function, `body` is not.
  | { t: 'fn'; how: FnKind; key?: Expr; body?: Expr }
  | { t: 'super' }
  | { t: 'keyword'; name: 'import' | 'eval' }

type FnKind =
  | 'arrow'
  | 'async-arrow'
  | 'function'
  | 'generator'
  | 'object-method'
  | 'class-method'
  | 'class-field'
  | 'class-static-block'
  | 'object-key'
  | 'class-key'
  | 'class-decorator'

const id = (name: string): Expr => ({ t: 'id', name })
const call = (callee: Expr, args: ReadonlyArray<Expr>, optional = false): Expr => ({
  t: 'call',
  callee,
  args,
  optional,
})
const member = (object: Expr, name: string, optional = false): Expr => ({ t: 'member', object, name, optional })
const paren = (x: Expr): Expr => ({ t: 'wrap', how: 'paren', x })
const binary = (op: string, left: Expr, right: Expr): Expr => ({ t: 'binary', op, left, right })
const fn = (how: FnKind, body?: Expr, key?: Expr): Expr => ({ t: 'fn', how, body, key })

/** Whether the text of `e` can stand where the grammar needs a primary expression. */
const isPrimary = (e: Expr): boolean =>
  e.t === 'id' ||
  e.t === 'call' ||
  e.t === 'member' ||
  e.t === 'element' ||
  e.t === 'super' ||
  (e.t === 'wrap' && (e.how === 'paren' || e.how === 'nonNull')) ||
  e.t === 'list'
const primary = (e: Expr): Expr => (isPrimary(e) ? e : paren(e))

// ---------------------------------------------------------------------------
// The four choices
// ---------------------------------------------------------------------------

export const CONTENTS = [
  'plain',
  'call',
  'own-await',
  'await-in-async-arrow',
  'await-in-object-method',
  'await-in-class-method',
  'await-in-class-key',
  'await-in-object-key',
  'await-in-class-decorator',
  'own-yield',
  'yield-in-generator',
  'super-call',
  'super-call-in-arrow',
  'super-method',
  'super-method-in-arrow',
  'own-eval',
  'eval-in-arrow',
  'own-import',
  'import-in-arrow',
  'import-in-class-field',
  'import-in-static-block',
  'optional-read',
  'optional-call',
  'optional-call-on-nothing',
  'chain-prefix',
  'chain-prefix-on-nothing',
  'chain-with-own-question',
  'chain-through-non-null',
  'chain-in-parens',
  'curried',
] as const
export type Content = (typeof CONTENTS)[number]

export const SUBJECTS = [
  'call',
  'method',
  'optional-method',
  'optional-method-on-nothing',
  'optional-call',
  'super-method',
  'curried',
  'add',
  'logical-and',
  'nullish',
  'comma',
  'conditional',
  'assign',
  'compound-assign',
] as const
export type Subject = (typeof SUBJECTS)[number]

export const WRAPPERS = ['none', 'paren', 'as', 'satisfies', 'angle', 'non-null'] as const
export type Wrapper = (typeof WRAPPERS)[number]

export const POSITIONS = [
  'value',
  'argument',
  'spread-argument',
  'operand',
  'not',
  'array',
  'template',
  'arrow-body',
  'awaited',
  'yielded',
  'member',
  'member-call',
  'optional-member-call',
  'element',
  'callee',
  'optional-callee',
  'new-callee',
  'tag',
  'assign-target',
  'compound-target',
  'delete',
  'postfix',
  'prefix',
] as const
export type Position = (typeof POSITIONS)[number]

export interface Shape {
  position: Position
  wrapper: Wrapper
  subject: Subject
  content: Content
}

export const shapeArbitrary: fc.Arbitrary<Shape> = fc.record({
  position: fc.constantFrom(...POSITIONS),
  wrapper: fc.constantFrom(...WRAPPERS),
  subject: fc.constantFrom(...SUBJECTS),
  content: fc.constantFrom(...CONTENTS),
})

/**
 * Whether a shape can be run and compared. Left out: syntax that only TypeScript has or that
 * JavaScript refuses to compile, an import of nothing, and the one shape that turns a function
 * of the fixture into text, because the text of a function is its instrumented source.
 */
export const isRunnable = (shape: Shape): boolean =>
  ['none', 'paren'].includes(shape.wrapper) &&
  !['chain-through-non-null', 'await-in-class-decorator', 'own-import'].includes(shape.content) &&
  !['assign-target', 'compound-target', 'postfix', 'prefix'].includes(shape.position) &&
  !(
    shape.content === 'super-method-in-arrow' &&
    (['add', 'compound-assign'].includes(shape.subject) ||
      (['logical-and', 'nullish', 'comma', 'conditional', 'assign'].includes(shape.subject) &&
        ['operand', 'template'].includes(shape.position)))
  )

const awaited = (x: Expr): Expr => ({ t: 'unary', how: 'await', x })
const superMethod = (arg: Expr): Expr => call(member({ t: 'super' }, 'm'), [arg])

function contentOf(content: Content): Expr {
  const x = id('x')
  const viaNothing = (root: string) => call(member(id(root), 'm', true), [x])
  switch (content) {
    case 'plain':
      return x
    case 'call':
      return call(id('g'), [x])
    case 'own-await':
      return awaited(id('p'))
    case 'await-in-async-arrow':
      return fn('async-arrow', awaited(id('p')))
    case 'await-in-object-method':
      return fn('object-method', awaited(id('p')))
    case 'await-in-class-method':
      return fn('class-method', awaited(id('p')))
    case 'await-in-class-key':
      return fn('class-key', undefined, awaited(id('p')))
    case 'await-in-object-key':
      return fn('object-key', undefined, awaited(id('p')))
    case 'await-in-class-decorator':
      return fn('class-decorator', undefined, awaited(id('p')))
    case 'own-yield':
      return { t: 'unary', how: 'yield', x }
    case 'yield-in-generator':
      return fn('generator', { t: 'unary', how: 'yield', x })
    case 'super-call':
      return call({ t: 'super' }, [x])
    case 'super-call-in-arrow':
      return fn('arrow', call({ t: 'super' }, [x]))
    case 'super-method':
      return superMethod(x)
    case 'super-method-in-arrow':
      return fn('arrow', superMethod(x))
    case 'own-eval':
      return call({ t: 'keyword', name: 'eval' }, [x])
    case 'eval-in-arrow':
      return fn('arrow', call({ t: 'keyword', name: 'eval' }, [x]))
    case 'own-import':
      return call({ t: 'keyword', name: 'import' }, [x])
    case 'import-in-arrow':
      return fn('arrow', call({ t: 'keyword', name: 'import' }, [x]))
    case 'import-in-class-field':
      return fn('class-field', call({ t: 'keyword', name: 'import' }, [x]))
    case 'import-in-static-block':
      return fn('class-static-block', call({ t: 'keyword', name: 'import' }, [x]))
    case 'optional-read':
      return member(id('o'), 'p', true)
    case 'optional-call':
      return viaNothing('o')
    case 'optional-call-on-nothing':
      return viaNothing('z')
    case 'chain-prefix':
      return call(member(viaNothing('o'), 'k'), [id('y')])
    case 'chain-prefix-on-nothing':
      return call(member(viaNothing('z'), 'k'), [id('y')])
    case 'chain-with-own-question':
      return call(member(viaNothing('z'), 'k', true), [id('y')])
    case 'chain-through-non-null':
      return call(member({ t: 'wrap', how: 'nonNull', x: viaNothing('o') }, 'k'), [id('y')])
    case 'chain-in-parens':
      return call(member(paren(viaNothing('o')), 'k'), [id('y')])
    case 'curried':
      return call(call(id('mk'), [x]), [id('y')])
  }
}

function subjectOf(subject: Subject, content: Expr): Expr {
  const y = id('y')
  switch (subject) {
    case 'call':
      return call(id('f'), [content])
    case 'method':
      return call(member(id('o'), 'm'), [content])
    case 'optional-method':
      return call(member(id('o'), 'm', true), [content])
    case 'optional-method-on-nothing':
      return call(member(id('z'), 'm', true), [content])
    case 'optional-call':
      return call(id('f'), [content], true)
    case 'super-method':
      return superMethod(content)
    case 'curried':
      return call(call(id('mk'), [content]), [y])
    case 'add':
      return binary('+', primary(content), y)
    case 'logical-and':
      return binary('&&', y, primary(content))
    case 'nullish':
      return binary('??', id('z'), primary(content))
    case 'comma':
      return paren(binary(',', y, content))
    case 'conditional':
      return { t: 'cond', test: y, yes: primary(content), no: id('x') }
    case 'assign':
      return binary('=', id('v'), content)
    case 'compound-assign':
      // `^=` is the last assignment operator TypeScript numbers, `=` the first.
      return binary('^=', id('v'), primary(content))
  }
}

function wrapperOf(wrapper: Wrapper, subject: Expr): Expr {
  switch (wrapper) {
    case 'none':
      return subject
    case 'paren':
      return paren(subject)
    // `as` and `satisfies` bind tighter than `??`, `&&`, a ternary, and an assignment.
    case 'as':
      return paren({ t: 'wrap', how: 'as', x: primary(subject) })
    case 'satisfies':
      return paren({ t: 'wrap', how: 'satisfies', x: primary(subject) })
    case 'angle':
      return paren({ t: 'wrap', how: 'angle', x: primary(subject) })
    case 'non-null':
      return { t: 'wrap', how: 'nonNull', x: primary(subject) }
  }
}

/** Whether `e` is a link of an optional chain: it has a `?.` of its own, or continues one. */
const inChain = (e: Expr): boolean =>
  (e.t === 'wrap' && e.how === 'nonNull' && inChain(e.x)) ||
  ((e.t === 'call' || e.t === 'member') && (Boolean(e.optional) || inChain(e.t === 'call' ? e.callee : e.object)))

function positionOf(position: Position, w: Expr): Expr {
  const y = id('y')
  // JavaScript has no tagged template or `new` on an optional chain; parentheses end the chain.
  const whole = inChain(w) ? paren(w) : primary(w)
  switch (position) {
    case 'value':
      return w
    case 'argument':
      return call(id('g'), [w])
    case 'spread-argument':
      return call(id('g'), [{ t: 'unary', how: 'spread', x: w }])
    case 'operand':
      return binary('+', primary(w), y)
    case 'not':
      return { t: 'unary', how: 'not', x: primary(w) }
    case 'array':
      return { t: 'list', how: 'array', x: w }
    case 'template':
      return { t: 'list', how: 'template', x: w }
    case 'arrow-body':
      return fn('arrow', w)
    case 'awaited':
      return awaited(primary(w))
    case 'yielded':
      return { t: 'unary', how: 'yield', x: w }
    case 'member':
      return member(primary(w), 'p')
    case 'member-call':
      return call(member(primary(w), 'k'), [y])
    case 'optional-member-call':
      return call(member(primary(w), 'k', true), [y])
    case 'element':
      return { t: 'element', object: primary(w), index: y }
    case 'callee':
      return call(primary(w), [y])
    case 'optional-callee':
      return call(primary(w), [y], true)
    case 'new-callee':
      return { t: 'new', callee: paren(w), args: [y] }
    case 'tag':
      return { t: 'tag', tag: whole }
    case 'assign-target':
      return binary('=', primary(w), y)
    case 'compound-target':
      return binary('||=', primary(w), y)
    case 'delete':
      return { t: 'unary', how: 'delete', x: primary(w) }
    case 'postfix':
      return { t: 'update', op: '++', prefix: false, x: primary(w) }
    case 'prefix':
      return { t: 'update', op: '--', prefix: true, x: primary(w) }
  }
}

// ---------------------------------------------------------------------------
// What an expression does itself, as opposed to the functions it contains
// ---------------------------------------------------------------------------

export type Tie = 'await' | 'yield' | 'super-call' | 'eval' | 'import'

function children(e: Expr): ReadonlyArray<Expr> {
  switch (e.t) {
    case 'id':
    case 'super':
    case 'keyword':
      return []
    case 'call':
    case 'new':
      return [e.callee, ...e.args]
    case 'member':
      return [e.object]
    case 'element':
      return [e.object, e.index]
    case 'wrap':
    case 'unary':
    case 'update':
    case 'list':
      return [e.x]
    case 'tag':
      return [e.tag]
    case 'binary':
      return [e.left, e.right]
    case 'cond':
      return [e.test, e.yes, e.no]
    case 'fn':
      return [e.key, e.body].filter((part): part is Expr => part !== undefined)
  }
}

/** The things in `e` that tie it to the function it is written in. A nested function ties only through its key. */
export function ties(e: Expr): ReadonlySet<Tie> {
  const found = new Set<Tie>()
  if (e.t === 'unary' && (e.how === 'await' || e.how === 'yield')) found.add(e.how)
  if (e.t === 'call' && e.callee.t === 'super') found.add('super-call')
  if (e.t === 'call' && e.callee.t === 'keyword') found.add(e.callee.name)
  const own = e.t === 'fn' ? (e.key ? [e.key] : []) : children(e)
  for (const child of own) for (const tie of ties(child)) found.add(tie)
  return found
}

// ---------------------------------------------------------------------------
// Building a shape that parses
// ---------------------------------------------------------------------------

export type Host = 'method' | 'async-method' | 'async-generator' | 'constructor'

export interface ShapePlan {
  shape: Shape
  tree: Expr
  /** The expression the shape is about: the subject, without its wrapper. */
  subject: Expr
  host: Host
  /** The expression alone. */
  text: string
  /** Where each node of the tree stands in `text`. */
  spans: ReadonlyMap<Expr, readonly [number, number]>
}

const callsSuper = (e: Expr): boolean => (e.t === 'call' && e.callee.t === 'super') || children(e).some(callsSuper)

/**
 * A derived constructor is the only place for `super(...)`, and it can neither await nor yield;
 * an arrow function can do neither as well. Where the choices collide, the position gives way.
 */
export function planShape(shape: Shape): ShapePlan {
  const content = contentOf(shape.content)
  const subject = subjectOf(shape.subject, content)
  const inner = wrapperOf(shape.wrapper, subject)
  const tied = ties(inner)
  const position: Position =
    (callsSuper(inner) && (shape.position === 'awaited' || shape.position === 'yielded')) ||
    ((tied.has('await') || tied.has('yield')) && shape.position === 'arrow-body')
      ? 'value'
      : shape.position
  const tree = positionOf(position, inner)
  const all = ties(tree)
  const host: Host = callsSuper(tree)
    ? 'constructor'
    : all.has('yield')
      ? 'async-generator'
      : all.has('await')
        ? 'async-method'
        : 'method'
  const spans = new Map<Expr, readonly [number, number]>()
  const text = render(tree, spans, 0)
  // The comma operation is written in parentheses of its own.
  return { shape: { ...shape, position }, tree, subject: subject.t === 'wrap' ? subject.x : subject, host, text, spans }
}

function render(e: Expr, spans: Map<Expr, readonly [number, number]>, at: number): string {
  let text = ''
  const sub = (child: Expr) => {
    const piece = render(child, spans, at + text.length)
    text += piece
  }
  const lit = (piece: string) => {
    text += piece
  }
  const list = (items: ReadonlyArray<Expr>) =>
    items.forEach((item, index) => {
      if (index) lit(', ')
      sub(item)
    })
  switch (e.t) {
    case 'id':
      lit(e.name)
      break
    case 'super':
      lit('super')
      break
    case 'keyword':
      lit(e.name)
      break
    case 'call':
      sub(e.callee)
      lit(e.optional ? '?.(' : '(')
      list(e.args)
      lit(')')
      break
    case 'new':
      lit('new ')
      sub(e.callee)
      lit('(')
      list(e.args)
      lit(')')
      break
    case 'member':
      sub(e.object)
      lit(`${e.optional ? '?.' : '.'}${e.name}`)
      break
    case 'element':
      sub(e.object)
      lit('[')
      sub(e.index)
      lit(']')
      break
    case 'wrap':
      if (e.how === 'paren') lit('(')
      if (e.how === 'angle') lit('<any>')
      sub(e.x)
      lit({ paren: ')', as: ' as any', satisfies: ' satisfies any', angle: '', nonNull: '!' }[e.how])
      break
    case 'binary':
      sub(e.left)
      lit(e.op === ',' ? ', ' : ` ${e.op} `)
      sub(e.right)
      break
    case 'cond':
      sub(e.test)
      lit(' ? ')
      sub(e.yes)
      lit(' : ')
      sub(e.no)
      break
    case 'unary':
      lit({ await: 'await ', yield: 'yield ', not: '!', delete: 'delete ', spread: '...' }[e.how])
      sub(e.x)
      break
    case 'update':
      if (e.prefix) lit(e.op)
      sub(e.x)
      if (!e.prefix) lit(e.op)
      break
    case 'tag':
      sub(e.tag)
      lit('`t`')
      break
    case 'list':
      lit(e.how === 'array' ? '[' : '`<${')
      sub(e.x)
      lit(e.how === 'array' ? ']' : '}>`')
      break
    case 'fn': {
      const [open, close] = {
        arrow: ['() => ', ''],
        'async-arrow': ['async () => ', ''],
        function: ['function () { return ', ' }'],
        generator: ['function* () { ', ' }'],
        'object-method': ['{ async m() { ', ' } }'],
        'class-method': ['class { async m() { ', ' } }'],
        'class-field': ['class { late = ', ' }'],
        'class-static-block': ['class { static { if (0) ', ' } }'],
        'object-key': ['{ [', ']: 1 }'],
        'class-key': ['class { [', ']() {} }'],
        'class-decorator': ['class { @(', ') m() {} }'],
      }[e.how] as [string, string]
      lit(open)
      sub((e.key ?? e.body)!)
      lit(close)
      break
    }
  }
  spans.set(e, [at, at + text.length])
  return text
}

/** The module that holds one expression, as TypeScript (`typed`) or as JavaScript that can run. */
export function moduleOf(plan: ShapePlan, typed: boolean, expression = plan.text): { source: string; at: number } {
  const any = typed ? ': any' : ''
  const head = {
    method: `work(v${any}) { return `,
    'async-method': `async work(v${any}) { return `,
    'async-generator': `async *work(v${any}) { return `,
    constructor: `constructor(v${any}) { out.value = `,
  }[plan.host]
  const before = `export class Host extends Base {\n  ${head}`
  return { source: `${before}${expression}\n  }\n}\n`, at: before.length }
}

// ---------------------------------------------------------------------------
// The rule the README states
// ---------------------------------------------------------------------------

export interface Selectable {
  kind: 'CallExpression' | 'BinaryExpression' | 'ConditionalExpression'
  callee?: string
  operator?: string
  start: number
  end: number
}

export type Verdict = 'selectable' | 'assigns' | 'needs-a-place' | 'chain-goes-on' | 'tied-to-its-function'

export interface Candidate extends Selectable {
  verdict: Verdict
}

const ASSIGNMENTS = new Set(['=', '||=', '^='])

/**
 * The rule, for every call, binary operation, and ternary of a shape, in source order. A test
 * can select one unless putting it into a function of its own would change what the code does:
 *
 * - `assigns`: a binary operation that assigns is not a value to replace;
 * - `needs-a-place`: it stands where JavaScript needs a place and not a value (the target of
 *   an assignment, the operand of `delete`, `++`, or `--`), or it is a binary operation or a
 *   ternary that is called, constructed, or used as a template tag. A call is selectable
 *   there: its result carries no receiver;
 * - `chain-goes-on`: an optional chain goes on behind it without a `?.` of its own, so the
 *   chain would no longer end where the expression yields nothing;
 * - `tied-to-its-function`: outside the functions it contains, it awaits, yields, calls
 *   `super(...)`, evaluates code with a direct `eval`, or imports.
 */
export function judge(plan: ShapePlan): Array<Candidate> {
  const parents = new Map<Expr, Expr>()
  const order: Array<Expr> = []
  const visit = (e: Expr) => {
    order.push(e)
    for (const child of children(e)) {
      parents.set(child, e)
      visit(child)
    }
  }
  visit(plan.tree)

  const through = (e: Expr, wrappers: ReadonlyArray<string>) => {
    let cur = e
    for (let p = parents.get(cur); p?.t === 'wrap' && wrappers.includes(p.how); p = parents.get(cur)) cur = p
    return { cur, parent: parents.get(cur) }
  }
  const needsAPlace = (e: Expr) => {
    const { cur, parent } = through(e, ['paren', 'as', 'satisfies', 'angle', 'nonNull'])
    if (!parent) return false
    if (parent.t === 'binary' && ASSIGNMENTS.has(parent.op) && parent.left === cur) return true
    if (parent.t === 'update' || (parent.t === 'unary' && parent.how === 'delete')) return true
    const called = ((parent.t === 'call' || parent.t === 'new') && parent.callee === cur) || parent.t === 'tag'
    return called && e.t !== 'call'
  }
  const chainGoesOn = (e: Expr) => {
    const { cur, parent } = through(e, ['nonNull'])
    if (!parent || !inChain(e)) return false
    const object =
      parent.t === 'call' ? parent.callee : parent.t === 'member' || parent.t === 'element' ? parent.object : undefined
    return object === cur && !(parent.t !== 'element' && (parent as Extract<Expr, { t: 'call' | 'member' }>).optional)
  }
  const calleeName = (callee: Expr) =>
    callee.t === 'id' || callee.t === 'member' || callee.t === 'keyword' ? callee.name : '(anonymous)'

  const found: Array<Candidate> = []
  for (const e of order) {
    if (e.t !== 'call' && e.t !== 'binary' && e.t !== 'cond') continue
    const [start, end] = plan.spans.get(e)!
    found.push({
      kind: e.t === 'call' ? 'CallExpression' : e.t === 'binary' ? 'BinaryExpression' : 'ConditionalExpression',
      ...(e.t === 'call' ? { callee: calleeName(e.callee) } : {}),
      ...(e.t === 'binary' ? { operator: e.op } : {}),
      start,
      end,
      verdict:
        e.t === 'binary' && ASSIGNMENTS.has(e.op)
          ? 'assigns'
          : needsAPlace(e)
            ? 'needs-a-place'
            : chainGoesOn(e)
              ? 'chain-goes-on'
              : ties(e).size
                ? 'tied-to-its-function'
                : 'selectable',
    })
  }
  return found
}

/** What the rule says about the subject of the shape. */
export function subjectVerdict(plan: ShapePlan): Verdict {
  const [start, end] = plan.spans.get(plan.subject)!
  return judge(plan).find((candidate) => candidate.start === start && candidate.end === end)!.verdict
}

/** The expressions of a shape that a test can select, as `indexTargetFile` describes them. */
export const selectableIn = (plan: ShapePlan): Array<Selectable> =>
  judge(plan).flatMap(({ verdict, ...node }) => (verdict === 'selectable' ? [node] : []))
