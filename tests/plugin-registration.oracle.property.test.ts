/**
 * This oracle owns what an instrumented module tells the runtime about itself, which is what a
 * visitor is handed when the test runs: each selectable expression as the code calls it, and
 * each function, class and variable declarator with what lies inside it. It is checked on the
 * arguments of the registration call in the code that the plugin's `transform` returns, and it
 * owns `src/plugin.ts#executionPoints`.
 *
 * ```ts
 * executionPoints({ root, targets }).transform(code, file).code
 * // → … registerFile("cart.ts",
 * //       [{ id, kind: "CallExpression", inFunction: "checkout", callee: "get", object: "cache", nth: 0 }],
 * //       [1],
 * //       [{ type: "Class", name: "Cart", nodes: [0], containers: [1] },
 * //        { type: "Function", name: "checkout", nodes: [0], containers: [] }]) …
 * // → no `line` and no `text` on an expression, no `line` on a container
 * ```
 *
 * A visitor that says "the call to `get` on `cache`, inside `checkout`, inside `Cart`" is
 * answered when the test runs, from what the module registered. If the module registers less
 * than the type registry promised, the test compiles and then matches nothing. If it registers
 * more, a visitor written without types can select by a property that the compiler does not
 * know: the line an expression is on would work when the test runs and be an error in `tsc`.
 *
 * For every target module, the code the plugin returns registers each selectable expression
 * with exactly its `id`, `kind`, `inFunction` and `nth`, its `callee` or `operator`, and the
 * `object` a member call is made on, and registers every function, class and variable
 * declarator that contains a selectable expression with exactly its `type`, its `name`, and the
 * expressions and containers inside it (Decisions by Manuel Schiller (GitHub schiller-manuel),
 * 2026-11-24: say "inside" by Babel-style nested traversal; the files and nodes that the type
 * registry lists are the ones registered when the code runs; keep `object`, drop `line` and
 * `text` from the selectors).
 *
 * The model is the one that writes the module: it knows what stands where because it wrote it.
 * A registration says nothing of where an expression is written, so the model and the driver
 * name an expression by what it reads as, and a container by its type, its name and the
 * expressions inside it.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { executionPoints } from '../src/plugin.ts'
import { CONTAINER_HISTORIES, type HandedContainer, handed, keyOfHandedContainer, keyOfHandedNode, sortHanded, writeModule } from './module-writer'

interface RegisteredNode {
  readonly kind: string
  readonly callee?: string
  readonly operator?: string
  readonly object?: string
}
interface RegisteredContainer {
  readonly type: string
  readonly name: string
  readonly nodes: ReadonlyArray<number>
  readonly containers: ReadonlyArray<number>
}

oracleProperty({
  id: 'plugin-registers-places-and-containers',
  owns: ['src/plugin.ts#executionPoints'],
  law: {
    statement:
      'For every target module, the code the plugin returns registers each selectable expression with exactly its id, kind, inFunction and nth, its callee or operator, and the object a member call is made on, and registers every function, class and variable declarator that contains a selectable expression with exactly its type, its name, and the expressions and containers that lie inside it.',
    authority:
      'Decisions by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: say "inside" by Babel-style nested traversal; the files and nodes of the type registry equal the ones registered when the code runs; keep `object`, drop `line` and `text` from the selectors.',
    limits:
      'The twenty-two modules of the discovery oracle for places and containers, each instrumented from a file on disk. Only the registration call is read; that the instrumented code behaves as written is the law of plugin-expression-instrumentation. The values of id, inFunction and nth are the law of the discovery oracle: here they are checked for being there. A registration has no place in it, so two expressions of one module are told apart by kind, callee or operator, and object, which every one of these modules allows.',
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
      'byte-order-mark',
      'windows-line-ends',
    ],
    // How an expression is laid out in the source decides nothing a visitor is handed.
    measured: ['several-lines', 'text-cut'],
  },
  label: (history) => history.name,
  model: (history) => handed(history),
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
      const keyOfContainer = (index: number) => {
        const container = containers[index]!
        return keyOfHandedContainer(container.type, container.name, container.nodes.map((node) => nodes[node]!))
      }
      observe('registered', {
        nodes: sortHanded(
          nodes.map((node) => ({
            kind: node.kind,
            ...(node.callee !== undefined ? { callee: node.callee } : {}),
            ...(node.operator !== undefined ? { operator: node.operator } : {}),
            ...(node.object !== undefined ? { object: node.object } : {}),
            fields: Object.keys(node).sort(),
          })),
        ),
        containers: sortHanded(
          containers.map((container) => ({
            type: container.type,
            name: container.name,
            fields: Object.keys(container).sort(),
            nodes: container.nodes.map((node) => keyOfHandedNode(nodes[node]!)).sort(),
            containers: container.containers.map(keyOfContainer).sort(),
          })),
        ),
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
        trace.map((o) => (o.checkpoint === 'registered' ? { ...o, value: { ...(o.value as object), containers: [] as Array<HandedContainer> } } : o)),
    },
    {
      name: 'an-expression-is-registered-with-its-line',
      law: 'registered',
      history: { enumerated: 'call-on-an-object' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'registered') return o
          const value = o.value as { nodes: Array<{ fields: Array<string> }> }
          return { ...o, value: { ...value, nodes: value.nodes.map((node) => ({ ...node, fields: [...node.fields, 'line'].sort() })) } }
        }),
    },
    {
      name: 'a-container-holds-the-method-of-another-class',
      law: 'registered',
      history: { enumerated: 'same-name-in-two-classes' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'registered') return o
          const value = o.value as { containers: Array<HandedContainer> }
          const [cart, order] = ['Cart', 'Order'].map((name) => value.containers.find((container) => container.type === 'Class' && container.name === name)!)
          return {
            ...o,
            value: {
              ...value,
              containers: value.containers.map((container) =>
                container === cart ? { ...container, containers: order!.containers } : container === order ? { ...container, containers: cart!.containers } : container,
              ),
            },
          }
        }),
    },
  ],
})
