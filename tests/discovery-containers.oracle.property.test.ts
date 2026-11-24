/**
 * This oracle owns what `indexTargetFile` records about where an expression stands: every
 * selectable expression's line, its text on one line and the object a member call is made on,
 * and every function, class and variable declarator that contains a selectable expression,
 * with what lies inside it. It is checked on the output of `indexTargetFile`, and it owns
 * `src/discovery.ts#indexTargetFile`.
 *
 * ```ts
 * indexTargetFile(file, source, root)
 * // source:                                     nodes:                          containers:
 * //   export class Cart {                         { callee: 'get', object:        { type: 'Class', name: 'Cart', line: 1,
 * //     checkout() {                                'cache', line: 3,                nodes: [0], containers: [1, 2] }
 * //       const hit = cache.get(key)               text: 'cache.get(key)' }       { type: 'Function', name: 'checkout', line: 2,
 * //     }                                                                           nodes: [0], containers: [2] }
 * //   }                                                                           { type: 'VariableDeclarator', name: 'hit', line: 3, nodes: [0] }
 * ```
 *
 * A test selects an expression through a visitor that works its way inward, as a Babel visitor
 * does: visit the function, then traverse into it. For that, the index has to say which
 * expressions stand inside which function, class, or declaration. Which name does an arrow
 * function assigned to a constant have? Is a call inside a callback inside a method inside the
 * method? Inside the class?
 *
 * Two parts are checked: the **places** (a line and a text for each expression, as an editor
 * and `execution-points list` show them) and the **containment** (each container's name, line,
 * and everything inside it at any depth). The places are for the listing alone: a visitor is
 * handed the containment and the object, and no line and no text.
 *
 * For every module, `indexTargetFile` gives each selectable expression the line it starts on,
 * counted from 1, its source text with every run of whitespace as one space and cut to 72
 * characters, and, for a call made on an object, that object's text; and it lists every
 * function, class and variable declarator that contains at least one selectable expression,
 * with the name it is declared under (a function or class assigned to a constant has the
 * constant's name; an anonymous one has the empty name), the line it starts on, and exactly
 * the selectable expressions and the other containers that lie inside it, however deep
 * (Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a command that lists
 * what can be selected, each expression with its position and text in the source; the
 * receiver of a call as `object`; say "inside" by Babel-style nested traversal instead of
 * `inFunction` and `inClass`).
 *
 * The model works on a tree it builds the module from: it knows what stands inside what because
 * it put it there, and where each line is because it wrote the lines. It never parses.
 */
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { indexTargetFile } from '../src/discovery.ts'
import { CONTAINER_HISTORIES, type OwedContainer, type OwedNode, byPlace, owed, writeModule } from './module-writer'

oracleProperty({
  id: 'discovery-places-and-containers',
  owns: ['src/discovery.ts#indexTargetFile'],
  law: {
    statement:
      'For every module, indexTargetFile gives each selectable expression the line it starts on, counted from 1, its source text with every run of whitespace as one space and cut to 72 characters, and, for a call made on an object, that object\'s text; and it lists every function, class and variable declarator that contains at least one selectable expression, with the name it is declared under (a function or class assigned to a constant has the constant\'s name, an anonymous one the empty name), the line it starts on, and exactly the selectable expressions and the other containers that lie inside it, however deep.',
    authority:
      'Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: a command that lists what can be selected, each expression with the position and text it has in the source; the receiver of a member call as `object`; say "inside" by Babel-style nested traversal (a visitor object keyed by node type, `Function` and `Class`, `traverse`) instead of `inFunction` and `inClass`. Since the decision of the same day to drop `line` and `text` from the selectors, the line and the text serve the listing alone.',
    limits:
      'Twenty-two modules written from a tree of calls, sums, functions in seven forms, classes in two, fields and constants, with and without a byte-order mark and Windows line ends. That a variable declarator is a third container is a proposal.',
  },
  histories: {
    enumerated: CONTAINER_HISTORIES,
    states: [
      'no-container',
      'not-a-call',
      'function-container',
      'class-container',
      'declarator-container',
      'anonymous-container',
      'named-by-its-constant',
      'container-in-container',
      'name-used-twice',
      'empty-container',
      'field-initializer',
      'call-on-object',
      'call-in-call',
      'several-lines',
      'text-cut',
      'byte-order-mark',
      'windows-line-ends',
    ],
  },
  label: (history) => history.name,
  model: (history) => owed(history),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    try {
      const { source } = writeModule(history)
      const indexed = indexTargetFile('/app/places.ts', source, '/app')
      const keyOfNode = (index: number) => {
        const node = indexed.nodes[index]!
        return `${node.line}:${node.callee ?? node.operator}`
      }
      const keyOfContainer = (index: number) => {
        const container = indexed.containers[index]!
        return `${container.type} ${container.name} @${container.line}`
      }
      observe('places', {
        nodes: indexed.nodes
          .map((node) => ({
            kind: node.kind,
            line: node.line,
            text: node.text,
            ...(node.callee !== undefined ? { callee: node.callee } : {}),
            ...(node.operator !== undefined ? { operator: node.operator } : {}),
            ...(node.object !== undefined ? { object: node.object } : {}),
          }))
          .sort(byPlace),
        containers: indexed.containers
          .map((container) => ({
            type: container.type,
            name: container.name,
            line: container.line,
            nodes: container.nodes.map(keyOfNode).sort(),
            containers: container.containers.map(keyOfContainer).sort(),
          }))
          .sort(byPlace),
      })
    } catch (error) {
      observe('places', { threw: error instanceof Error ? error.message : String(error) })
    }
  },
  check: (_history, observations, expected) =>
    differs('places', 'places', observations.find((o) => o.checkpoint === 'places')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'a-call-in-a-callback-is-not-inside-the-method',
      law: 'places',
      history: { enumerated: 'everything-nested' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'places') return o
          const value = o.value as { containers: Array<OwedContainer> }
          return {
            ...o,
            value: {
              ...value,
              containers: value.containers.map((container) =>
                container.name === 'run' ? { ...container, nodes: container.nodes.slice(0, 1) } : container,
              ),
            },
          }
        }),
    },
    {
      name: 'a-line-is-counted-from-zero',
      law: 'places',
      history: { enumerated: 'function-declaration' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'places') return o
          const value = o.value as { nodes: Array<OwedNode> }
          return { ...o, value: { ...value, nodes: value.nodes.map((node) => ({ ...node, line: node.line - 1 })) } }
        }),
    },
  ],
})
