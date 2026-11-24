/**
 * Modules written from a tree, for the oracles that ask where an expression stands. The writer
 * knows what is inside what because it put it there, and where each line is because it wrote
 * the lines. It never parses.
 *
 * Two readers use it. The listing (`indexTargetFile`, `execution-points list`) owes each
 * expression's place: `owed`. A visitor is handed no place, only what the code calls things and
 * what lies inside what: `handed`.
 */
/** A call, optionally on an object and optionally written over several lines. */
export interface Call {
  readonly t: 'call'
  readonly name: string
  /** What the call is made on: a plain text such as `cache`, or another call. */
  readonly on?: string | Call
  /** Written as `on['name']()` instead of `on.name()`. */
  readonly bracket?: boolean
  readonly args?: ReadonlyArray<Call>
  /** One argument per line. */
  readonly spread?: boolean
  /** A string argument that makes the call longer than a line of the listing. */
  readonly padding?: string
}
/** `marker + n`: a selectable expression that is not a call. */
export interface Sum {
  readonly t: 'sum'
  readonly n: number
}
export interface Fn {
  readonly t: 'fn'
  readonly form: 'declaration' | 'arrow' | 'function-expression' | 'method' | 'getter' | 'constructor' | 'callback'
  /** For a callback, the name of the call it is passed to. */
  readonly name: string
  readonly body: ReadonlyArray<Stmt>
}
export interface Cls {
  readonly t: 'class'
  readonly form: 'declaration' | 'expression'
  readonly name: string
  readonly members: ReadonlyArray<Fn | Field>
}
/** A class field initialized by a call. */
export interface Field {
  readonly t: 'field'
  readonly name: string
  readonly init: Call
}
export interface Decl {
  readonly t: 'decl'
  readonly name: string
  readonly init: Call | Sum
}
export type Stmt = Call | Sum | Fn | Cls | Decl

export interface ContainerHistory {
  readonly name: string
  readonly states: ReadonlyArray<string>
  readonly body: ReadonlyArray<Stmt>
  readonly bom?: boolean
  readonly crlf?: boolean
}

export interface OwedNode {
  kind: string
  line: number
  text: string
  callee?: string
  operator?: string
  object?: string
}
export interface OwedContainer {
  type: string
  name: string
  line: number
  /** The expressions inside, each as its line and its callee or operator. */
  nodes: Array<string>
  /** The containers inside, each as its type, name and line. */
  containers: Array<string>
}

export const call = (name: string, extra: Omit<Call, 't' | 'name'> = {}): Call => ({ t: 'call', name, ...extra })
export const fn = (form: Fn['form'], name: string, ...body: Array<Stmt>): Fn => ({ t: 'fn', form, name, body })
export const cls = (form: Cls['form'], name: string, ...members: Array<Fn | Field>): Cls => ({ t: 'class', form, name, members })
export const decl = (name: string, init: Call | Sum): Decl => ({ t: 'decl', name, init })

export const LISTING_WIDTH = 72

/**
 * Writes the module line by line and notes, as it goes, where everything is and what is inside
 * what. The text of an expression on one line is its lines, each without its indentation,
 * joined by single spaces.
 */
export function writeModule(history: ContainerHistory) {
  const lines: Array<string> = ['export const marker = 0']
  const nodes: Array<OwedNode> = []
  const containers: Array<OwedContainer> = []
  // The containers that are open while a line is written, innermost last.
  const open: Array<OwedContainer> = []
  // What lies inside each container, as the things themselves.
  const inside = new Map<OwedContainer, { nodes: Array<OwedNode>; containers: Array<OwedContainer> }>()
  const keyOfContainer = (c: OwedContainer) => `${c.type} ${c.name} @${c.line}`

  const enter = (type: string, name: string, line: number): OwedContainer => {
    const container: OwedContainer = { type, name, line, nodes: [], containers: [] }
    for (const outer of open) {
      outer.containers.push(keyOfContainer(container))
      inside.get(outer)!.containers.push(container)
    }
    inside.set(container, { nodes: [], containers: [] })
    containers.push(container)
    open.push(container)
    return container
  }
  const note = (node: OwedNode) => {
    nodes.push(node)
    for (const outer of open) {
      outer.nodes.push(`${node.line}:${node.callee ?? node.operator}`)
      inside.get(outer)!.nodes.push(node)
    }
  }
  const oneLine = (written: ReadonlyArray<string>) => {
    const text = written.map((line) => line.trim()).join(' ')
    return text.length > LISTING_WIDTH ? `${text.slice(0, LISTING_WIDTH - 1)}…` : text
  }

  /** The lines of an expression, without indentation of the first; notes the expressions in it. `at` is its first line. */
  const expression = (item: Call | Sum, at: number): Array<string> => {
    if (item.t === 'sum') {
      const text = `marker + ${item.n}`
      note({ kind: 'BinaryExpression', line: at, text, operator: '+' })
      return [text]
    }
    const target = typeof item.on === 'object' ? expression(item.on, at) : item.on === undefined ? [] : [item.on]
    const head = target.length ? `${target.join(' ')}${item.bracket ? `['${item.name}']` : `.${item.name}`}` : item.name
    const args = item.args ?? []
    let written: Array<string>
    if (item.spread) {
      written = [`${head}(`]
      for (const arg of args) {
        const inner = expression(arg, at + written.length)
        written.push(...inner.slice(0, -1), `${inner.at(-1)},`)
      }
      written.push(')')
    } else {
      const inner = args.map((arg) => expression(arg, at).join(' '))
      if (item.padding) inner.push(JSON.stringify(item.padding))
      written = [`${head}(${inner.join(', ')})`]
    }
    note({
      kind: 'CallExpression',
      line: at,
      text: oneLine(written),
      callee: item.name,
      ...(target.length ? { object: oneLine(target) } : {}),
    })
    return written
  }

  const statement = (item: Stmt | Field, indent: string): void => {
    const at = lines.length + 1
    const put = (written: ReadonlyArray<string>, before = '', after = '') => {
      written.forEach((line, index) =>
        lines.push(`${indent}${index ? '  ' : before}${line}${index === written.length - 1 ? after : ''}`),
      )
    }
    const block = (body: ReadonlyArray<Stmt | Field>) => {
      for (const inner of body) statement(inner, `${indent}  `)
    }
    if (item.t === 'call' || item.t === 'sum') {
      put(expression(item, at))
    } else if (item.t === 'decl') {
      enter('VariableDeclarator', item.name, at)
      put(expression(item.init, at), `const ${item.name} = `)
      open.pop()
    } else if (item.t === 'field') {
      put(expression(item.init, at), `${item.name} = `)
    } else if (item.t === 'class') {
      if (item.form === 'expression') enter('VariableDeclarator', item.name, at)
      enter('Class', item.name, at)
      lines.push(`${indent}${item.form === 'expression' ? `const ${item.name} = class` : `class ${item.name}`} {`)
      block(item.members)
      lines.push(`${indent}}`)
      open.pop()
      if (item.form === 'expression') open.pop()
    } else if (item.form === 'callback') {
      // The call that takes the callback is an expression of its own, and the callback has no name.
      const opened = lines.length
      const callLine = at
      lines.push(`${indent}${item.name}(() => {`)
      enter('Function', '', at)
      block(item.body)
      open.pop()
      lines.push(`${indent}})`)
      note({ kind: 'CallExpression', line: callLine, text: oneLine(lines.slice(opened)), callee: item.name })
    } else {
      const named = item.form === 'arrow' || item.form === 'function-expression'
      if (named) enter('VariableDeclarator', item.name, at)
      enter('Function', item.form === 'constructor' ? 'constructor' : item.name, at)
      const head = {
        declaration: `function ${item.name}() {`,
        arrow: `const ${item.name} = () => {`,
        'function-expression': `const ${item.name} = function () {`,
        method: `${item.name}() {`,
        getter: `get ${item.name}() {`,
        constructor: 'constructor() {',
      }[item.form]
      lines.push(`${indent}${head}`)
      block(item.body)
      lines.push(`${indent}}`)
      open.pop()
      if (named) open.pop()
    }
  }
  for (const item of history.body) statement(item, '')

  const source = (history.bom ? '﻿' : '') + lines.join(history.crlf ? '\r\n' : '\n') + (history.crlf ? '\r\n' : '\n')
  return { source, nodes, containers, inside }
}

export const byPlace = (a: { line: number; text?: string; type?: string }, b: { line: number; text?: string; type?: string }) =>
  a.line - b.line || `${a.type ?? ''}${a.text ?? ''}`.localeCompare(`${b.type ?? ''}${b.text ?? ''}`)

/** Only a container with an expression inside is recorded: nothing can be selected in an empty one. */
export function owed(history: ContainerHistory) {
  const { nodes, containers } = writeModule(history)
  return {
    nodes: [...nodes].sort(byPlace),
    containers: containers
      .filter((container) => container.nodes.length > 0)
      .map((container) => ({
        ...container,
        nodes: [...container.nodes].sort(),
        // An empty container inside is not recorded either.
        containers: container.containers
          .filter((key) => containers.some((inner) => `${inner.type} ${inner.name} @${inner.line}` === key && inner.nodes.length > 0))
          .sort(),
      }))
      .sort(byPlace),
  }
}

/** An expression as a visitor reads it: what the code calls it, and nothing about where it is written. */
export interface HandedNode {
  kind: string
  callee?: string
  operator?: string
  object?: string
  /** Every property the node has. */
  fields: Array<string>
}
export interface HandedContainer {
  type: string
  name: string
  /** Every property the container has. */
  fields: Array<string>
  /** The expressions inside, each as `keyOfHandedNode` writes it. */
  nodes: Array<string>
  /** The containers inside, each as `keyOfHandedContainer` writes it. */
  containers: Array<string>
}

type Named = Pick<HandedNode, 'kind' | 'callee' | 'operator' | 'object'>

/** An expression without its place: its kind, its callee or operator, and the object it is called on. */
export const keyOfHandedNode = ({ kind, callee, operator, object }: Named): string =>
  `${kind} ${callee ?? operator ?? ''}${object === undefined ? '' : ` on ${object}`}`

/** A container without its place: its type, its name, and the expressions inside it, which tell two of one name apart. */
export const keyOfHandedContainer = (type: string, name: string, nodes: ReadonlyArray<Named>): string =>
  `${type} ${name} [${nodes.map(keyOfHandedNode).sort().join(', ')}]`

const byText = (a: object, b: object) => JSON.stringify(a).localeCompare(JSON.stringify(b))

/**
 * What a module owes a visitor when the test runs. An expression has an id, the function it is
 * in and its number there, its kind, its callee or operator, and the object a member call is
 * made on; a container has its type, its name, and what is inside it. Neither has a line or a
 * text.
 */
export function handed(history: ContainerHistory): { nodes: Array<HandedNode>; containers: Array<HandedContainer> } {
  const { nodes, containers, inside } = writeModule(history)
  const keys = nodes.map(keyOfHandedNode)
  const twice = keys.find((key, index) => keys.indexOf(key) !== index)
  if (twice !== undefined) throw new Error(`${history.name}: two expressions read as "${twice}", so nothing but their place tells them apart.`)
  const keyOf = (container: OwedContainer) => keyOfHandedContainer(container.type, container.name, inside.get(container)!.nodes)
  return {
    nodes: nodes
      .map(({ kind, callee, operator, object }) => ({
        kind,
        ...(callee !== undefined ? { callee } : {}),
        ...(operator !== undefined ? { operator } : {}),
        ...(object !== undefined ? { object } : {}),
        fields: ['id', 'inFunction', 'kind', 'nth', ...(callee !== undefined ? ['callee'] : []), ...(operator !== undefined ? ['operator'] : []), ...(object !== undefined ? ['object'] : [])].sort(),
      }))
      .sort(byText),
    // Only a container with an expression inside is registered, and an empty one inside it is not either.
    containers: containers
      .filter((container) => inside.get(container)!.nodes.length > 0)
      .map((container) => ({
        type: container.type,
        name: container.name,
        fields: ['containers', 'name', 'nodes', 'type'],
        nodes: inside.get(container)!.nodes.map(keyOfHandedNode).sort(),
        containers: inside
          .get(container)!
          .containers.filter((inner) => inside.get(inner)!.nodes.length > 0)
          .map(keyOf)
          .sort(),
      }))
      .sort(byText),
  }
}

export const sortHanded = <T extends object>(items: ReadonlyArray<T>): Array<T> => [...items].sort(byText)

export const CONTAINER_HISTORIES: ReadonlyArray<ContainerHistory> = [
  { name: 'call-at-the-top', states: ['no-container'], body: [call('a')] },
  { name: 'sum-at-the-top', states: ['no-container', 'not-a-call'], body: [{ t: 'sum', n: 3 }] },
  { name: 'function-declaration', states: ['function-container'], body: [fn('declaration', 'work', call('a'), call('b'))] },
  { name: 'arrow-in-a-constant', states: ['function-container', 'declarator-container', 'named-by-its-constant'], body: [fn('arrow', 'work', call('a'))] },
  {
    name: 'function-expression-in-a-constant',
    states: ['function-container', 'declarator-container', 'named-by-its-constant'],
    body: [fn('function-expression', 'work', call('a'))],
  },
  { name: 'declarator-of-a-call', states: ['declarator-container'], body: [decl('total', call('fetchTotal'))] },
  { name: 'declarator-of-a-sum', states: ['declarator-container', 'not-a-call'], body: [decl('total', { t: 'sum', n: 1 })] },
  {
    name: 'method-in-a-class',
    states: ['function-container', 'class-container', 'container-in-container'],
    body: [cls('declaration', 'Cart', fn('method', 'checkout', call('a')), fn('method', 'refund', call('b')))],
  },
  {
    name: 'class-expression-in-a-constant',
    states: ['class-container', 'declarator-container', 'named-by-its-constant', 'container-in-container'],
    body: [cls('expression', 'Cart', fn('method', 'checkout', call('a')))],
  },
  {
    name: 'constructor-getter-and-field',
    states: ['function-container', 'class-container', 'field-initializer'],
    body: [
      cls(
        'declaration',
        'Cart',
        { t: 'field', name: 'seed', init: call('a') },
        fn('constructor', 'constructor', call('b')),
        fn('getter', 'total', call('c')),
      ),
    ],
  },
  {
    name: 'callback-without-a-name',
    states: ['function-container', 'anonymous-container', 'container-in-container', 'text-cut'],
    body: [fn('declaration', 'work', fn('callback', 'retry', call('a'), call('b')))],
  },
  {
    name: 'function-in-function',
    states: ['function-container', 'container-in-container'],
    body: [fn('declaration', 'outer', call('a'), fn('declaration', 'inner', call('b'), decl('kept', call('c'))), call('d'))],
  },
  {
    name: 'same-name-in-two-classes',
    states: ['function-container', 'class-container', 'name-used-twice'],
    body: [cls('declaration', 'Cart', fn('method', 'checkout', call('a'))), cls('declaration', 'Order', fn('method', 'checkout', call('b')))],
  },
  {
    name: 'containers-with-nothing-to-select',
    states: ['empty-container'],
    body: [fn('declaration', 'idle'), cls('declaration', 'Empty', fn('method', 'nothing')), fn('declaration', 'work', fn('declaration', 'idleInside'), call('a'))],
  },
  {
    name: 'call-on-an-object',
    states: ['call-on-object'],
    body: [call('get', { on: 'cache' }), call('save', { on: 'this.db' }), call('get', { on: 'store', bracket: true })],
  },
  {
    name: 'call-on-a-call',
    states: ['call-on-object', 'call-in-call'],
    body: [fn('declaration', 'work', call('send', { on: call('getClient') }))],
  },
  {
    name: 'call-in-arguments',
    states: ['call-in-call'],
    body: [decl('total', call('outer', { args: [call('first'), call('second', { args: [call('third')] })] }))],
  },
  {
    name: 'call-over-several-lines',
    states: ['several-lines', 'call-in-call'],
    body: [fn('declaration', 'work', call('outer', { spread: true, args: [call('first'), call('second')] }), call('after'))],
  },
  {
    name: 'call-longer-than-the-listing',
    states: ['text-cut'],
    body: [call('log', { padding: 'x'.repeat(90) }), call('log2', { padding: 'y'.repeat(LISTING_WIDTH - 'log2("")'.length) })],
  },
  {
    name: 'byte-order-mark',
    states: ['byte-order-mark', 'function-container'],
    bom: true,
    body: [fn('declaration', 'work', call('a'))],
  },
  {
    name: 'windows-line-ends',
    states: ['windows-line-ends', 'several-lines', 'function-container'],
    crlf: true,
    body: [fn('declaration', 'work', call('outer', { spread: true, args: [call('first')] })), decl('late', call('z'))],
  },
  {
    name: 'everything-nested',
    states: ['function-container', 'class-container', 'declarator-container', 'anonymous-container', 'container-in-container'],
    body: [
      call('top'),
      cls(
        'declaration',
        'Service',
        fn(
          'method',
          'run',
          decl('first', call('load', { on: 'this.store' })),
          fn('callback', 'each', fn('arrow', 'step', call('apply', { args: [call('read')] }))),
        ),
      ),
    ],
  },
]
