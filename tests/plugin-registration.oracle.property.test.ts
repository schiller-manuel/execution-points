/**
 * This oracle owns what an instrumented module tells the runtime about itself: for each
 * selectable expression where it stands and what it reads as, and for each function, class and
 * variable declarator what lies inside it. It is checked on the arguments of the registration
 * call in the code that the plugin's `transform` returns, and it owns
 * `src/plugin.ts#executionPoints`.
 *
 * ```ts
 * executionPoints({ root, targets }).transform(code, file).code
 * // → … registerFile("cart.ts",
 * //       [{ id, kind: "CallExpression", inFunction: "checkout", callee: "get", object: "cache", nth: 0, line: 3, text: "cache.get(key)" }],
 * //       [1],
 * //       [{ type: "Class", name: "Cart", line: 1, nodes: [0], containers: [1] },
 * //        { type: "Function", name: "checkout", line: 2, nodes: [0], containers: [] }]) …
 * ```
 *
 * A visitor that says "the call to `get` on `cache`, inside `checkout`, inside `Cart`" is
 * answered when the test runs, from what the module registered. If the module registers less
 * than the type registry promised, the test compiles and then matches nothing.
 *
 * For every target module, the code the plugin returns registers each selectable expression
 * with the line it starts on, its text on one line, and the object a member call is made on,
 * and registers every function, class and variable declarator that contains a selectable
 * expression, with its name, its line, and exactly the expressions and containers inside it
 * (Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build the selector fields;
 * say "inside" by Babel-style nested traversal; and, of the same day, the files and nodes that
 * the type registry lists are the ones registered when the code runs).
 *
 * The model is the one that writes the module: it knows what stands where because it wrote it.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { executionPoints } from '../src/plugin.ts'
import { CONTAINER_HISTORIES, type OwedContainer, byPlace, owed, writeModule } from './module-writer'

interface RegisteredNode {
  readonly kind: string
  readonly line: number
  readonly text: string
  readonly callee?: string
  readonly operator?: string
  readonly object?: string
}
interface RegisteredContainer {
  readonly type: string
  readonly name: string
  readonly line: number
  readonly nodes: ReadonlyArray<number>
  readonly containers: ReadonlyArray<number>
}

oracleProperty({
  id: 'plugin-registers-places-and-containers',
  owns: ['src/plugin.ts#executionPoints'],
  law: {
    statement:
      'For every target module, the code the plugin returns registers each selectable expression with the line it starts on, its text on one line, and the object a member call is made on, and registers every function, class and variable declarator that contains a selectable expression, with its name, its line, and exactly the expressions and containers that lie inside it.',
    authority:
      'Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: build the selector fields `text`, `line`, the receiver of a member call and the binding a call initializes; say "inside" by Babel-style nested traversal; the files and nodes of the type registry equal the ones registered when the code runs.',
    limits:
      'The twenty-two modules of the discovery oracle for places and containers, each instrumented from a file on disk. Only the registration call is read; that the instrumented code behaves as written is the law of plugin-expression-instrumentation.',
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
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ep-registration-')))
    try {
      const { source } = writeModule(history)
      const file = join(dir, 'places.ts')
      writeFileSync(file, source)
      const plugin = executionPoints({ root: dir, targets: ['places.ts'] })
      plugin.buildStart.call({})
      const instrumented = plugin.transform.call({}, source, file)
      // The registration is one statement on one line, and every argument of it is JSON.
      const written = /= __epRegister\w*\((.*)\);\n/.exec(instrumented?.code ?? '')?.[1]
      if (written === undefined) {
        observe('registered', { registration: 'none' })
        return
      }
      const [, nodes, , containers = []] = JSON.parse(`[${written}]`) as [
        string,
        ReadonlyArray<RegisteredNode>,
        ReadonlyArray<number>,
        ReadonlyArray<RegisteredContainer>?,
      ]
      const keyOfNode = (index: number) => `${nodes[index]!.line}:${nodes[index]!.callee ?? nodes[index]!.operator}`
      const keyOfContainer = (index: number) => {
        const container = containers[index]!
        return `${container.type} ${container.name} @${container.line}`
      }
      observe('registered', {
        nodes: nodes
          .map((node) => ({
            kind: node.kind,
            line: node.line,
            text: node.text,
            ...(node.callee !== undefined ? { callee: node.callee } : {}),
            ...(node.operator !== undefined ? { operator: node.operator } : {}),
            ...(node.object !== undefined ? { object: node.object } : {}),
          }))
          .sort(byPlace),
        containers: containers
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
      observe('registered', { threw: error instanceof Error ? error.message : String(error) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) =>
    differs('registered', 'registered', observations.find((o) => o.checkpoint === 'registered')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'containers-are-not-registered',
      law: 'registered',
      history: { enumerated: 'method-in-a-class' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'registered' ? { ...o, value: { ...(o.value as object), containers: [] as Array<OwedContainer> } } : o)),
    },
  ],
})
