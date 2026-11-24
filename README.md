# Execution points

A prototype for replacing expressions inside application code from a test with full native TypeScript inference—without editing application code or writing generated `.d.ts` files to disk.

A TypeScript 7.1 content mapper (`points.ep`) indexes the configured target modules into a virtual `ExecutionPointFileRegistry`. Tests select expressions imperatively using a **narrowing visitor (`select`)**, and a Vite plugin instruments only the target modules in memory.

**Status:** the runtime, Vitest integration, the `select` visitor API, and native TypeScript 7.1 content mapper (`tsc --noEmit --runExternalCode` + VS Code TypeScript 7.1 LSP) all work with zero generated files on disk.

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

## Select an execution point in a test

The package is currently named `execution-points-prototype`.

```ts
import { select } from 'execution-points-prototype'
import { checkout } from './checkout'

// Minimal selector: callee is unique in the file, so no kind or inFunction check is needed
const quotePoint = select('examples/checkout.ts', (node) =>
  node.callee === 'send' && node,
).capture('region', 'user', 'attempt')

const result = quotePoint.withReplacement(
  ({ locals }) => {
    // Fully typed by TypeScript's own control-flow narrowing:
    // locals.user is narrowed to non-null User; return type must match Quote.
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

- `node` is a discriminated union of every selectable expression in `'examples/checkout.ts'` (`kind`, `inFunction`, `callee`, `operator`, `nth`, `id`). `callee` and `operator` are mutually exclusive (`operator?: undefined` on calls, `callee?: undefined` on binary expressions), so `node.callee === 'send' && node` narrows cleanly without checking `node.kind`.
- Returning 0 nodes or 2+ nodes (ambiguous match) is rejected at compile time (multi-match errors list the matched node IDs under `__matched`).
- **Keep selectors minimal:** omit `inFunction` (and `nth`) whenever `callee` or `operator` is already unique in the file. Filtering on `inFunction` only when disambiguating multiple sites prevents a test from breaking (`matched 0`) when a call moves into an extracted private helper.
- `.capture(...)` autocompletes every in-scope local at that expression and rejects unknown binding names immediately. Calling `.capture()` with no arguments types `locals` as `{}`.

The replacement's result must match the selected expression's inferred type. A `Promise<number>` expression requires a `Promise<number>` replacement; a synchronous `Quote` expression requires a `Quote` replacement; an `async` handler on a synchronous `void` expression is rejected at compile time. The checker does not automatically unwrap promises.

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

**Call-through:** `original()` evaluates the expression every time it is called. It is not memoized and not limited to one invocation, so calling it twice runs the original expression twice, side effects included.

## What instrumentation costs

Code in a target file runs its original statements until a test installs a replacement for one of its own expressions. Until then an ordinary function pays for one flag read per call, which V8 treats as a constant, and nothing per expression:

| | tight loop, 2 million turns | recursion, 832,000 calls |
| --- | --- | --- |
| listed as a target, untouched | 1.0x | 1.0x to 1.2x |
| a replacement is active in another function of the same file | 1.0x | 0.9x to 1.2x |

(`node probes/p10-runtime-overhead.mjs`, relative to the same code when it is not a target.)

Each function body is emitted twice: once as written, and once with every selectable expression wrapped so that a replacement can intercept it. A function decides which one to run when it is called. That is enough, because a call's async context is fixed when the call begins: if no replacement exists for the function's expressions at that moment, none can apply to that call later, not even after an `await`. Code that is evaluated outside an ordinary function body (a generator or constructor body, an expression-bodied arrow, a parameter default, a field initializer, the module's top level) decides at each outermost selectable expression instead, because it can be resumed or evaluated in another context.

Once a replacement is installed for an expression, the function that contains it runs its wrapped form for the rest of the worker. The emitted code is about twice the size of the wrapped form alone.

## Configuration

`points.ep` lists the target application modules to index (explicit paths or glob patterns) and anchors the TypeScript 7.1 content mapper. Test files do not need to be listed or transformed:

```json
{
  "tsconfig": "tsconfig.json",
  "targets": ["examples/checkout.ts", "examples/expressions.ts"]
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

(Inside this repository itself, `tsconfig.json` uses `"package": "."` to point at the local package root.)

### VS Code setup

Content mappers require **TypeScript 7.1** (`tsgo`), not VS Code's bundled TypeScript version. `.vscode/settings.json` in this repo already sets `"typescript.tsdk"`, `"js/ts.tsdk.path"`, `"js/ts.contentMappers.enabled": true`, and `"js/ts.experimental.useTsgo": true`, **but VS Code will still use its bundled TypeScript until you opt in**:

1. Open any `.ts` file in VS Code.
2. Run **TypeScript: Select TypeScript Version…** from the Command Palette and choose **Use Workspace Version** (`7.1.0-dev...`).
3. If you see `ExecutionPointFileRegistry is empty` in the editor, check the TypeScript version indicator in the status bar and run **TypeScript: Restart TS Server**.

`vitest.config.mjs` reads `points.ep` directly via `loadManifest()` so Vitest and TypeScript share a single configuration:

```js
import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'
import { loadManifest } from './src/discovery.mjs'

const points = loadManifest(import.meta.dirname)

export default defineConfig({
  plugins: [executionPoints(points)],
  test: {
    include: ['examples/**/*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
```

## How the types work

TypeScript 7.1 introduces **content mappers** for non-`.ts` extensions (`tsconfig.json` `"contentMappers"`). Rather than rewriting `.ts` files, scanning test files, or writing `.d.ts` files to disk:

1. **Single `.ep` anchor (`points.ep`).** `tsconfig.json` registers `src/content-mapper.mjs` for `.ep` files with `"dynamicConfig": true` and `watchedFiles` covering only the configured target modules.
2. **Index target ASTs with TypeScript 7.1 (`src/discovery.mjs`).** Walks each target module via `api.createSourceFile` to index selectable expressions (`CallExpression`, non-assignment `BinaryExpression`, `ConditionalExpression`) with enclosing function name, `callee`/`operator`, `nth`, and safe pre-expression local bindings.
3. **Analyze with warm incremental snapshots (`src/contracts.mjs`).** A persistent `typescript/sync` snapshot analyzes target `.ts` files (excluding `.ep` and `contentMappers`, preventing recursion) and updates incrementally via `snapshot.update(...)` on file saves. Result types come from the unmodified target AST; narrowed local types come from a nested incremental probe.
4. **Emit virtual file schema.** `transform("points.ep")` returns a virtual `.ts` file augmenting `ExecutionPointFileRegistry` with the discriminated union of each target file's nodes. Export-reachable private types (`Quote`, `User`, `Order`) preserve exact identity via export-anchored paths; unreachable private types emit structural or unique-symbol-branded helpers.
5. **Native `tsc` and VS Code checking.** `select()` (control-flow narrowing) derives its full types directly from `ExecutionPointFileRegistry`—so editing tests never triggers the content mapper and updates on every keystroke (~4 ms).

## Supported subset and limits

- Targets are TypeScript modules configured in `points.ep`. Global scripts are skipped.
- Indexed target kinds are ordinary `CallExpression`, non-assignment `BinaryExpression`, and `ConditionalExpression` nodes (including nested expressions).
- Reference-only positions and expressions containing `await`, `yield`, `super`, optional chains, dynamic `import()`, or direct `eval` are skipped.
- Captures expose explicitly selected binding values via lazy thunks; objects retain normal mutability while the `locals` container is shallowly frozen with a null prototype.
- The runtime uses Node `AsyncLocalStorage` to isolate concurrent and nested async replacement scopes.

## Source layout

| File | Responsibility |
| --- | --- |
| `points.ep` | Target manifest and TypeScript 7.1 content-mapper anchor. |
| `src/discovery.mjs` | Index selectable expressions, the function bodies they belong to, and safe local bindings over TypeScript 7.1 ASTs. |
| `src/contracts.mjs` | Extract result types and narrowed locals via warm incremental snapshots and emit virtual `ExecutionPointFileRegistry`. |
| `src/content-mapper.mjs` | TypeScript 7.1 STDIO JSON-RPC content mapper server. |
| `src/plugin.mjs` | Instrument configured target modules, keeping each function's original statements beside its wrapped form, and register node metadata through Vite (test files are untouched). |
| `src/runtime.mjs` | `select()`, `registerFile()` with the per-function flags that instrumented code reads, `invoke()`, and async-local scopes. |
| `src/runtime.d.ts` | `ExecutionPointFileRegistry`, narrowing visitor `select()`, and `Point` types. |
| `examples/` | Runnable applications and Vitest examples. |
| `checks/verify.mjs` | End-to-end `tsc --runExternalCode`, live `tsc --lsp --stdio` (hover, completions, diagnostics), negative type checks, and no-write verification. |

The native compiler API is currently a beta dependency. See the [TypeScript 7.1 beta announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) for its API model.
