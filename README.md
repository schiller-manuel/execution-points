# Execution points

A prototype for replacing an expression inside application code from a test. Select the expression with an existing AST query, request the surrounding locals you need, and provide the replacement in the test.

The application needs no testing markers or new exports for the selected operation. A Vite plugin instruments the selected expression in memory. The test and application run in the same Node worker.

**Status:** the runtime, Vitest integration, and virtual TypeScript checker work. Automatic editor integration is not implemented. Run `pnpm check` for the inferred callback types and diagnostics described below.

## Run it

Requires Node.js 24 or later and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm verify
```

| Command | Purpose |
| --- | --- |
| `pnpm check` | Infer each point's contract and typecheck the tests using in-memory source projections. |
| `pnpm test` | Run the instrumented Vitest examples. This command does not run the custom typechecker. |
| `pnpm verify` | Check valid and invalid callbacks, capture restrictions, diagnostic positions, and that compilation writes no generated files. |

The examples cover a private method call, arithmetic, and a call returning a promise. They also exercise call-through, nested replacement scopes, concurrent async scopes, object mutation, and cleanup after an exception.

## Declare a point in a test

The package is currently named `execution-points-prototype`.

```ts
import { point } from 'execution-points-prototype'
import { checkout } from './checkout'

const quotePoint = point({
  file: 'examples/checkout.ts',
  query: 'FunctionDeclaration[name.escapedText="checkout"] CallExpression[expression.name.escapedText="send"]',
  capture: ['region', 'user', 'attempt'],
})

const result = quotePoint.withReplacement(
  ({ locals }) => {
    // These are values from the application at the selected expression.
    // The checker knows user is non-null after checkout's earlier guard.
    return {
      total: locals.user.isTestAccount ? 0 : 7,
      currency: locals.region === 'EU' ? 'EUR' : 'USD',
    }
  },
  () => checkout({
    id: 'order-1',
    region: 'EU',
    user: { id: 'user-1', name: 'Ada', isTestAccount: true },
  }),
)
```

`file` is relative to the configured project root. `query` uses [TSQuery](https://github.com/phenomnomnomnominal/tsquery), which applies CSS-style selectors to the TypeScript AST. Names such as `CallExpression` and fields such as `expression.name.escapedText` come from that AST. The query must match exactly one supported expression.

`capture` is optional and contains identifier names. The tool resolves each name in the selected expression's lexical scope, including shadowing. A missing binding or a binding that cannot be read at that position is an error.

The replacement's result must match the selected expression's inferred type. A `Promise<number>` expression requires a `Promise<number>` replacement; a synchronous `Quote` expression requires a `Quote` replacement. The checker does not automatically unwrap promises.

## When replacement happens

The hook runs **before the whole selected expression is evaluated**. For the example expression:

```ts
getClient().send(order.id, attempt++)
```

an active replacement runs before `getClient()`, the method lookup, or either argument. Returning a replacement value skips all of those operations, including `attempt++`.

| Situation | Behavior |
| --- | --- |
| No replacement is active | Evaluate the original expression normally. Do not read captures. |
| Replacement returns a value | Use that value as the expression result. |
| Replacement throws | Throw at the selected expression. |
| Replacement calls `original()` | Evaluate the original expression, preserving its receiver and evaluation order. |

### Captured bindings

Captures are read once for each intercepted execution. The `locals` container is shallowly frozen and its properties are readonly in the callback type.

```ts
quotePoint.withReplacement(({ locals, original }) => {
  // Reassignment is rejected by the checker:
  // locals.user = anotherUser

  // Existing objects are shared with the application and remain mutable:
  locals.user.name = 'Changed by the test'
  return original()
}, () => checkout(input))
```

Primitive captures are snapshots of the binding's value at interception. They do not become live getters. For example, `locals.attempt` stays at its captured value even if `original()` later increments the application's `attempt`.

### Replacement scope

`point.withReplacement(handler, action)` activates the handler for `action` and the asynchronous work started within its Node async context. It returns the action's return value directly, including the same promise when the action is asynchronous.

Nested scopes can override the same point and restore the outer handler afterward. Concurrent async scopes have separate replacement maps. Returning or throwing restores the surrounding synchronous context; async descendants retain the context in which they were created. This is async-context scoping, not cancellation of unfinished work.

**Agreed scope API:** replacements are activated through the explicit `withReplacement(handler, action)` callback scope.

**Provisional call-through behavior:** `original()` is not memoized or limited to one invocation. Calling it twice evaluates the original expression twice, including its side effects. Whether to offer a once-only continuation or a separate repeat API remains a design decision.

## Configuration

`points.config.mjs` lists the test files to scan. These are explicit paths, not globs.

```js
export default {
  root: import.meta.dirname,
  tsconfig: 'tsconfig.json',
  testFiles: ['examples/checkout.test.ts', 'examples/expressions.test.ts'],
}
```

Add the plugin to the Vitest configuration before other plugins that rewrite the same source:

```js
import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'
import points from './points.config.mjs'

export default defineConfig({
  plugins: [executionPoints(points)],
  test: {
    environment: 'node',
    include: points.testFiles,
    isolate: true,
  },
})
```

The CLI loads `points.config.mjs` from the current directory. Errors include the original source file, line, and column, and produce a nonzero exit code. Discovery errors, such as an ambiguous selector, also fail the command.

The plugin checks that the text it instruments matches the source used for discovery. It watches tests, application targets, and configuration, and rebuilds the plan when they change. Its source maps retain the original source text.

## How the types work

An AST selector identifies syntax; it does not itself teach TypeScript the selected expression's type. This prototype connects selection to the compiler with virtual source views:

1. **Discover with TypeScript 6 and TSQuery.** The `typescript` dependency is pinned to 6.0.3 for the TSQuery AST integration.
2. **Analyze with native TypeScript 7.1 beta.** The `typescript-native` dependency is an npm alias for `typescript@7.1.0-beta`. Its compiler API reads the project and in-memory overlays. Temporary identifier reads at each point obtain the captures' types after control-flow narrowing.
3. **Build a virtual contract.** The application compiler view gets a type-only alias containing the result type and readonly locals. Private module-level types remain in their original module, preserving their identity.
4. **Check the virtual test.** A hidden type argument connects its ordinary `point(...)` call to that contract. TypeScript contextually types the handler and checks its result. Diagnostic positions are translated back to the authored files.

No `.generated` directory, declaration registry, or rewritten application file is saved. Runtime instrumentation is a separate Vite transform; the compiler-only aliases never need to exist at runtime.

**Editor support is a separate unfinished piece.** Ordinary `tsc` and the editor's normal language service do not receive these virtual views. They may report fallback-type errors on the authored test. This repository does not yet install a language-server extension, TypeScript plugin, or content mapper. The current typecheck entry point is `pnpm check`.

## Supported subset and limits

This is an expression-replacement prototype with explicit boundaries:

- Targets are separate TypeScript application modules inside the configured root. Global scripts and targets in the declaring test file are rejected.
- Supported target kinds are ordinary calls, non-assignment binary expressions, conditional expressions, property reads, element reads, and parenthesized value expressions.
- Positions requiring a JavaScript reference are rejected. For example, select a whole method call instead of just its method property, so the receiver is preserved.
- Targets containing `await`, `yield`, `super`, optional chains, direct `eval`, or dynamic `import()` need additional transforms and are rejected. Selecting an ordinary promise-returning call inside an outer `await` is supported.
- Point declarations must use a named `point` import, a literal specification, literal selector/path strings, and literal capture names. Computed configuration, spreads, and manual type arguments are outside this prototype.
- A selector must match once. Overlapping targets are rejected. Repeated declarations for the same expression must use the same capture list.
- Captures expose selected binding values. They do not allow reassignment of the application's lexical bindings, evaluation of arbitrary strings in its scope, or debugger-style suspension.
- The checker supports accessible module-level types and structural local values. It rejects function/block-local named types when it cannot transport their identity safely, unresolved local generic type parameters, generic function-valued captures, and `any` contracts encountered during type extraction. It does not silently substitute an unchecked contract.
- The runtime uses Node `AsyncLocalStorage`. Browser, remote-process, and cross-worker interception are not implemented.
- No automatic editor integration, declaration-file generation, watch-mode typecheck command, selector migration, hit counters, or breakpoint UI is included.

The first next step is an editor adapter that supplies these same virtual views and source mappings to the language service. The existing discovery plan, `checkPlan()` projections, and diagnostic mapping provide a starting point; the integration still needs to be built.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/discovery.mjs` | Find literal points, execute selectors, validate targets, and build stable source-specific IDs. |
| `src/compiler.mjs` | Analyze captures and results, build virtual contracts, and check projected tests. |
| `src/cli.mjs` | Load configuration and print original-source compiler diagnostics. |
| `src/plugin.mjs` | Instrument selected expressions and test declarations through Vite. |
| `src/runtime.mjs` | Dispatch replacements and manage async-local scopes. |
| `src/runtime.d.ts` | Define the public point, context, and replacement types. |
| `examples/` | Runnable applications and Vitest examples. |
| `checks/verify.mjs` | Compiler rejection, source-position, and no-write checks. |

The native compiler API is currently a beta dependency. See the [TypeScript 7.1 beta announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) for its API model.
