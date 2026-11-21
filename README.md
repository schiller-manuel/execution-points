# Execution points

A prototype for replacing an expression inside application code from a test. Select the expression with an existing AST query, request the surrounding locals you need, and provide the replacement in the test.

The application needs no testing markers or new exports for the selected operation. A Vite plugin instruments the selected expression in memory. The test and application run in the same Node worker.

**Status:** the runtime, Vitest integration, and native TypeScript 7.1 content mapper (`tsc --noEmit --runExternalCode` + VS Code TypeScript 7.1 LSP) all work with zero generated files on disk.

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
| `pnpm check` | Run regular `tsc --noEmit --runExternalCode` using the TypeScript 7.1 content mapper (`points.ep`). |
| `pnpm test` | Run the instrumented Vitest examples. |
| `pnpm verify` | Verify real `tsc --runExternalCode`, live `tsc --lsp --stdio` (hover, completions, diagnostics), negative type checks, and that no generated files are written. |

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

`points.ep` lists the test files to scan (explicit paths or glob patterns) and also anchors the TypeScript 7.1 content mapper:

```json
{
  "tsconfig": "tsconfig.json",
  "testFiles": ["examples/checkout.test.ts", "examples/expressions.test.ts"]
}
```

Register the content mapper in `tsconfig.json` and include `points.ep`:

```json
{
  "contentMappers": [
    {
      "package": "execution-points-prototype",
      "extensions": [".ep"]
    }
  ],
  "include": ["examples/**/*.ts", "points.ep"]
}
```

(Inside this repository itself, `tsconfig.json` uses `"package": "."` to point at the local package root. `.vscode/settings.json` enables `"js/ts.contentMappers.enabled": true` and uses the workspace TypeScript 7.1 SDK.)

`points.config.mjs` reads `points.ep` so Vitest and TypeScript share a single configuration. Add the Vite plugin before other plugins that rewrite the same source:

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

The plugin checks that the text it instruments matches the source used for discovery. It watches tests, application targets, `points.ep`, and `tsconfig.json`, and rebuilds the plan when they change. Its source maps retain the original source text.

## How the types work

TypeScript 7.1 introduces **content mappers** for non-`.ts` extensions (`tsconfig.json` `"contentMappers"`). Rather than rewriting `.ts` files or emitting generated `.d.ts` files to disk:

1. **Single `.ep` anchor (`points.ep`).** `tsconfig.json` registers `src/content-mapper.mjs` for `.ep` files with `"dynamicConfig": true` and `watchedFiles` covering all test and target `.ts` files.
2. **Discover points with ESQuery (`src/query.mjs` + `src/discovery.mjs`).** Literal `point({ file, query, capture })` calls are discovered and matched against target ASTs.
3. **Analyze with TypeScript 7.1 (`src/contracts.mjs`).** A warm `typescript/sync` snapshot analyzes target `.ts` files (excluding `.ep` and `contentMappers`, preventing recursion). Result types come from the unmodified target AST; narrowed local types come from an incremental `snapshot.update(...)` probe. All safe in-scope local bindings are discovered via `checker.getSymbolsInScope` for VS Code `capture` autocomplete.
4. **Emit virtual module augmentation.** `transform("points.ep")` returns a virtual `.ts` file augmenting `ExecutionPointRegistry` on `execution-points-prototype`. Export-reachable private types (such as `Quote` and `User` in `examples/checkout.ts`) preserve exact identity via export-anchored type expressions (`ReturnType<typeof import(...).checkout>["quote"]`); unreachable structural or nominal private types emit clean helper or branded interfaces.
5. **Native `tsc` and VS Code checking.** `point()` uses `const` type parameters (`File`, `Query`, `Capture`) to look up the contract from `ExecutionPointRegistry`, constrain `capture` to in-scope locals, surface discovery errors right on `point(...)`, and type `({ locals, original }) => ...` natively in both `tsc --noEmit --runExternalCode` and VS Code's TypeScript 7.1 language server.

No `.generated` directory, declaration registry on disk, or rewritten `.ts` file is saved. Runtime instrumentation stays a separate Vite transform.

## Supported subset and limits

This is an expression-replacement prototype with explicit boundaries:

- Targets are separate TypeScript application modules inside the configured root. Global scripts and targets in the declaring test file are rejected.
- Supported target kinds are ordinary calls, non-assignment binary expressions, conditional expressions, property reads, element reads, and parenthesized value expressions.
- Positions requiring a JavaScript reference are rejected. For example, select a whole method call instead of just its method property, so the receiver is preserved.
- Targets containing `await`, `yield`, `super`, optional chains, direct `eval`, or dynamic `import()` need additional transforms and are rejected. Selecting an ordinary promise-returning call inside an outer `await` is supported.
- Point declarations must use a named `point` import, a literal specification, literal selector/path strings, and literal capture names. Computed configuration, spreads, and manual type arguments are outside this prototype.
- A selector must match once. Overlapping targets are rejected. Multiple declarations targeting the same expression may request different capture lists.
- Captures expose selected binding values. They do not allow reassignment of the application's lexical bindings, evaluation of arbitrary strings in its scope, or debugger-style suspension.
- The checker supports exported/imported types, export-reachable private types, structural private interfaces, and unreachable private nominal types (via shared unique-symbol brands). It rejects function/block-local named types, unresolved local generic type parameters, generic function-valued captures, and `any` contracts encountered during type extraction. It does not silently substitute an unchecked contract.
- The runtime uses Node `AsyncLocalStorage`. Browser, remote-process, and cross-worker interception are not implemented.
- Content-mapper updates for edited `.ts` targets/queries refresh when watched files are saved (per TypeScript 7.1's `watchedFiles` protocol); editing `capture: [...]` updates immediately on keystrokes.

## Source layout

| File | Responsibility |
| --- | --- |
| `points.ep` | Execution-points manifest and TypeScript 7.1 content-mapper anchor. |
| `src/query.mjs` | ESQuery-based AST selector engine over TypeScript syntax trees. |
| `src/discovery.mjs` | Find literal points, execute selectors, validate targets, and build stable source-specific IDs. |
| `src/contracts.mjs` | Extract result types and narrowed in-scope locals via TypeScript 7.1 and emit virtual `ExecutionPointRegistry` augmentation. |
| `src/content-mapper.mjs` | TypeScript 7.1 STDIO JSON-RPC content mapper server (`initialize`, `openProject`, `transform`, `closeProject`). |
| `src/compiler.mjs` | Programmatic `checkPlan()` entry point using the same virtual registry augmentation. |
| `src/cli.mjs` | CLI inspection helper printing discovered execution-point contracts. |
| `src/plugin.mjs` | Instrument selected expressions and test declarations through Vite. |
| `src/runtime.mjs` | Dispatch replacements, slice per-point captures, and manage async-local scopes. |
| `src/runtime.d.ts` | Define `ExecutionPointRegistry`, `point()`, `Context`, and replacement types. |
| `examples/` | Runnable applications and Vitest examples. |
| `checks/verify.mjs` | End-to-end `tsc --runExternalCode`, live `tsc --lsp --stdio`, negative type checks, and no-write verification. |

The native compiler API is currently a beta dependency. See the [TypeScript 7.1 beta announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) for its API model.
