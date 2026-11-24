# Execution points

A prototype for replacing expressions inside application code from a test with full native TypeScript inference—without editing application code or writing generated `.d.ts` files to disk.

A TypeScript 7.1 content mapper (`points.ep`) indexes the configured target modules into a virtual `ExecutionPointFileRegistry`. Tests select expressions imperatively using a **narrowing visitor (`select`)**, and a Vite plugin instruments only the target modules in memory.

**Status:** the runtime, Vitest integration, the `select` visitor API, and native TypeScript 7.1 content mapper (`tsc --noEmit --runExternalCode` + VS Code TypeScript 7.1 LSP) all work with zero generated files on disk.

## Run it

Requires Node.js 24 or later and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm verify
```

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build the TypeScript sources into `dist/` with `tsdown`: JavaScript and declarations. Tests run against `src/`; a project that installs the package gets `dist/`. TypeScript starts the content mapper from `dist/`, so `pnpm check`, `pnpm test` and `pnpm verify` build first. |
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

- `node` is a discriminated union of every selectable expression in `'examples/checkout.ts'` (`kind`, `callee`, `operator`, `object`, `inFunction`, `nth`, `id`). `callee` and `operator` are mutually exclusive (`operator?: undefined` on calls, `callee?: undefined` on binary expressions), so `node.callee === 'send' && node` narrows cleanly without checking `node.kind`.
- Returning 0 nodes or 2+ nodes (ambiguous match) is rejected at compile time (multi-match errors list the matched node IDs under `__matched`).
- **Keep selectors minimal:** omit `inFunction` (and `nth`) whenever `callee` or `operator` is already unique in the file. Filtering on `inFunction` only when disambiguating multiple sites prevents a test from breaking (`matched 0`) when a call moves into an extracted private helper.
- `.capture(...)` autocompletes every in-scope local at that expression and rejects unknown binding names at compile time. At runtime, a name the expression cannot see makes the evaluation throw an error that lists the locals there are. Calling `.capture()` with no arguments types `locals` as `{}`.
- The visitor selects a node by returning that node, or `node.capture(...)`. Returning anything else, such as the boolean from `node.callee === 'send'` alone, selects nothing, and the "matched 0" error says so.

### Say where the expression stands

When the same call is written in several places, say which one by where it stands. The visitor can be an object keyed by node type, as in Babel: a handler is called for every node of its type, and `traverse` looks inside a function, a class, or a declaration.

```ts
// cache.set(id, name) is written in getProfile and in updateProfile
const cachingAfterUpdate = select('examples/profile.ts', {
  Function: (fn) =>
    fn.name === 'updateProfile' &&
    fn.traverse({
      CallExpression: (call) => call.callee === 'set' && call.object === 'cache' && call,
    }),
})

// the call that initializes `raw`
const readingForRaw = select('examples/profile.ts', {
  VariableDeclarator: (declared) => declared.name === 'raw' && declared.traverse({ CallExpression: (call) => call }),
})
```

| Key | The handler is called for | Properties to compare |
| --- | --- | --- |
| `CallExpression` | every selectable call in scope | `callee`, `object` (what the call is made on, as written: `cache` in `cache.get(key)`), `nth` |
| `BinaryExpression` | every selectable binary operation | `operator`, `nth` |
| `ConditionalExpression` | every selectable ternary | `nth` |
| `Function` | every function, method, accessor, constructor and arrow function with a selectable expression inside it | `name` |
| `Class` | every class with one inside it | `name` |
| `VariableDeclarator` | every `const`, `let` or `var` name whose initializer has one inside it | `name` |

- In scope means: the whole file for the visitor given to `select`, and everything inside the container, however deep, for the visitor given to its `traverse`. A call inside a callback inside a method is inside the method and inside the class.
- A handler for an expression returns the node (or `node.capture(...)`) to select it. A handler for a container returns `container.traverse(visitor)`. Anything else selects nothing.
- `Function` and `Class` are Babel's alias keys: one key for every kind of function, one for every kind of class. A function or class assigned to a constant has the constant's name, as `fn.name` has in JavaScript; an anonymous one has `''`.
- A node says what the code calls things, and not where it is written: it has no line and no source text, so a test does not break when a line is added above the expression or its arguments are reformatted. `npx execution-points list` prints both for every expression, to find it by. When nothing else tells two expressions apart, `nth` does: it counts the expressions that have the same `kind`, the same `callee` or `operator` and the same `inFunction`, in the order they are written, from 0.
- The compiler follows every step. A handler is typed with exactly the nodes in its scope, so `fn.name === 'chekout'` is a compile error when no such function is inside, and the selected point has the type of the one expression that is left. Selecting none, or more than one, is a compile error when the point is used, as with the callback form.
- An expression that several ways lead to is still one expression. A call inside a callback inside `checkout` is reached through `checkout` and through the callback, so a `Function` handler without a name check finds it twice, and it counts once. If the handler captures on each way, the point has every local that any way captured: `fn.name === 'checkout' ? call.capture('key') : call.capture('each')` gives a handler both `locals.key` and `locals.each`.

Only properties that sit directly on the node can be compared, in both forms. A Babel `path` would let you write `path.node.callee.object.name` or `path.findParent(...)`, but TypeScript does not narrow a value through a nested property or a callback, so the compiler would no longer know which expression was selected (`node probes/p30-what-the-compiler-can-follow.mjs`). `traverse` is the step it does follow.

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
| Replacement never runs | The test fails. See "A replacement must run". |

The handler receives `{ locals, original, call }`. `call` is the number of the evaluation it is handling, counted from 1 for each replacement.

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

### A replacement must run

A replacement that never runs has tested nothing, so it fails the test. By default the handler must run at least once:

```ts
// Throws: the action takes a path that never evaluates the selected expression.
quotePoint.withReplacement(() => ({ total: 1, currency: 'EUR' }), () => 'no checkout here')
// Error: [execution-points] The replacement for "examples/checkout.ts#checkout:CallExpression:send:0"
// ran 0 times; expected at least once. ...
```

The third argument says otherwise when you mean otherwise:

| Option | Meaning |
| --- | --- |
| `{ times: 2 }` | The handler must run exactly twice. |
| `{ times: 0 }` | The expression must not be reached. This fails even if the application catches what the handler throws. |
| `{ times: 'any' }` | No requirement. |
| `{ on: 2 }`, `{ on: [1, 3] }` | The handler takes only these evaluations, counted from 1; the others evaluate the original expression. |

When the action is synchronous, `withReplacement` throws as it returns. When the action returns a promise, `withReplacement` returns that same promise untouched and the test fails when it ends, through a Vitest hook that the setup module `execution-points-prototype/vitest` registers (list it in `test.setupFiles`). With another test runner, call `verifyReplacements()` from `execution-points-prototype` after each test.

`point.calls` is how often a replacement for the expression has run since the current test began.

### Pause an asynchronous call

To hold one operation in the middle while another runs, pause the expression it is about to await. This needs an expression whose value is a promise. On any other expression `pause`, `resolves` and `rejects` cannot be called, and the compile error gives that reason.

```ts
const pause = remotePoint.pause()
const slow = pause.run(() => remoteTotal('abc')) // starts, and waits at fetchTotal(id)

const { locals } = await pause.reached           // the call has arrived
expect(await remoteTotal('quick')).toBe(50)      // other work runs to completion meanwhile

pause.release()                                  // the waiting call continues with the original expression
expect(await slow).toBe(30)
```

`pause.reached` rejects as soon as the action finishes without reaching the expression, so a test that awaits it fails at once with a message that names the expression, instead of running into a timeout. Every evaluation that arrives before `release()` waits; later ones pass straight through. A pause that is still holding when the test ends fails the test.

### Replace everywhere

`withReplacement` covers the action and the asynchronous work it starts. Code that runs in a context the test did not start is outside it: a request handler of a server that was already listening, a polling loop, a batcher that another caller opened. For those, `replace` applies in every async context of the worker until it is restored:

```ts
test('the handler reports a pricing outage', async () => {
  using outage = quotePoint.replace(() => { throw new Error('pricing service is down') })
  expect((await fetch(`${baseUrl}/checkout`)).status).toBe(503)
}) // restored here; fails if the handler never ran
```

Without `using`, the replacement is restored and checked when the test ends. Tests that run concurrently in one worker see each other's `replace`, so those keep to `withReplacement`.

Shorthands for the common handlers install such a replacement and take the same options:

```ts
quotePoint.returns({ total: 5, currency: 'USD' })
quotePoint.throws(new Error('pricing service is down'))
remotePoint.resolves(7)                             // for an expression whose value is a promise
remotePoint.rejects(new Error('timeout'), { on: 2 }) // only the second evaluation fails
```

### Run every order

A test that pauses one operation at one place tries one order. `interleavings` hands you all of them, one at a time. You give it the expressions where operations can be made to wait; the loop is yours:

```ts
import { interleavings, select } from 'execution-points-prototype'

const normalizing = select('examples/profile.ts', (n) => n.callee === 'normalize' && n)
const writing = select('examples/profile.ts', (n) => n.callee === 'writeStore' && n)

for (const order of interleavings([normalizing, writing])) {
  reset()
  await order.run(() => Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')]))
  expect(cachedName('u1')).toBe('Bob')
}
```

Inside `order.run(action)`, every evaluation of a selected expression waits. Whenever each operation has either finished or is waiting, one waiting evaluation is let through and continues with the original expression. Each order makes those choices differently, and the loop ends when every way has been tried. `order.run` resolves to what the action resolves to.

`interleavings` is an ordinary generator, so the rest is composition: `break` to stop, `.take(20)` to bound the number of orders, a counter to know how many there were, a list to collect every order that ends wrong instead of stopping at the first. Each order follows from what the one before it found, so await `order.run` before taking the next.

| On each order | |
| --- | --- |
| `order.run(action)` | Runs the action once in this order. |
| `order.released` | The ids of the evaluations that were let through, in order. |
| `order.schedule` | The choices that were made. `interleavings(points, { schedule })` gives exactly this order again, which is how an order that failed becomes a regression test. |

A check that follows `order.run` is your code, and its error reaches the test as it is. If you want the failure to name the order, put the check inside the action. When the action throws or rejects, `order.run` rejects with an `InterleavingFailure`:

```ts
await order.run(async () => {
  reset()
  await Promise.all([getProfile('u1'), updateProfile('u1', 'Bob')])
  expect(cachedName('u1')).toBe('Bob')
})
```

```
[execution-points] The scenario failed in this order:
  1. examples/profile.ts#updateProfile:CallExpression:writeStore:0
  2. examples/profile.ts#getProfile:CallExpression:normalize:0
Replay it with interleavings(points, { schedule: [0,0] }).
It failed with: expected 'Alice' to be 'Bob'
```

Its `cause` is what the action threw and its `schedule` is the list of choices. To read them from a caught value, narrow it with `instanceof`; a rejection can be any value, so TypeScript types it as `any` unless you say `unknown`:

```ts
const failure = await everyOrder().catch((error: unknown) => error)
assert(failure instanceof InterleavingFailure)
failure.schedule // readonly number[]
```

To pick the orders yourself, for example with a seeded random generator, pass `choose(step, count, run)`: it returns which of the `count` waiting evaluations goes next. The orders then never run out, so bound them:

```ts
for (const order of interleavings(points, { choose }).take(50)) { … }
```

Each selected expression must be one whose value is a promise, as for `pause`. An expression that no order evaluated makes the loop throw when the orders run out, like any replacement that never runs; so does taking the next order before the current one has run. The number of orders grows quickly: two operations that each pass two selected expressions have six orders, and three such operations have ninety.

Only work that is driven by promises can be ordered. An operation that waits on a real timer, on disk, or on the network is not waiting at a selected expression, so `order.run` either reports that the run "neither finished nor reached a selected expression" or lets the others go first. Fake the timers, or select the expression that starts the slow work. (`node probes/p26-interleavings.mjs` shows each of these cases.)

### Replacement scope

`point.withReplacement(handler, action)` activates the handler for `action` and the asynchronous work started within its Node async context. It returns the action's return value directly, including the same promise when the action is asynchronous.

Nested scopes can override the same point and restore the outer handler afterward. Concurrent async scopes have separate replacement maps. Returning or throwing restores the surrounding synchronous context; async descendants retain the context in which they were created. This is async-context scoping, not cancellation of unfinished work.

**Scope API:** `withReplacement(handler, action, options?)` is the callback scope; `replace(handler, options?)` and the shorthands apply everywhere until restored; `pause()` is a callback scope that holds the expression.

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

## List what a test can select

In an editor, `node.` inside a `select` visitor completes to what the file offers. In a terminal, ask the package:

```sh
npx execution-points list examples/checkout.ts
```

```text
examples/checkout.ts:39:17  kind=CallExpression callee=send object=getClient() inFunction=checkout nth=0 inside=Function:checkout>VariableDeclarator:quote id=examples/checkout.ts#checkout:CallExpression:send:0  getClient().send(order.id, attempt++)
examples/checkout.ts:39:17  kind=CallExpression callee=getClient inFunction=checkout nth=0 inside=Function:checkout>VariableDeclarator:quote id=examples/checkout.ts#checkout:CallExpression:getClient:0  getClient()
```

Each line is one selectable expression of the target: where it starts (`file:line:column`, both counted from 1), the fields a visitor reads under the names it reads them by, what the expression stands inside (`inside=`, outermost first: the containers a visitor object traverses into), and the expression's text on one line, cut to 72 characters. So `grep callee=send` finds the call, and `node.callee === 'send' && node` selects it. A value with a space in it is written in JSON quotes.

| Command | Prints |
| --- | --- |
| `npx execution-points list <file>` | The selectable expressions of one target file. |
| `npx execution-points list` | The same for every target that `points.ep` lists. |
| `npx execution-points list --json` | The same entries as one JSON array (`file`, `line`, `column`, `id`, `kind`, `callee` or `operator`, `object`, `inFunction`, `nth`, `inside`, `text`). |

The command lists exactly what the Vite plugin registers when the tests run. It reads `points.ep` in the directory it is started in. A file that is not a target, a file that does not exist, and a missing or broken manifest are answered with a reason on the error stream and exit code 1; a command line it does not understand, with the usage and exit code 2. Field values are printed as they are, so use `--json` when a name could hold a space.

## Configuration

`points.ep` lists the target application modules (explicit paths or glob patterns) and anchors the TypeScript 7.1 content mapper. It is the one list of targets: TypeScript, the Vite plugin, and `execution-points list` all read it. Test files do not need to be listed or transformed:

```json
{
  "$schema": "./node_modules/execution-points-prototype/points.schema.json",
  "tsconfig": "tsconfig.json",
  "targets": ["examples/checkout.ts", "examples/expressions.ts"]
}
```

| Key | Meaning |
| --- | --- |
| `targets` | Required. The target modules: paths and glob patterns, relative to the manifest. |
| `tsconfig` | The tsconfig that describes the targets. Defaults to `tsconfig.json` beside the manifest. |
| `$schema` | Where `points.schema.json` is, so that an editor checks and completes the manifest. |

The package ships the manifest's JSON schema as `points.schema.json`. A manifest with any other key, or with `targets` that is not a list of paths, is refused by name when the plugin or the `list` command reads it. (Inside this repository itself, `points.ep` refers to `./points.schema.json`.)

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

Add the plugin to `vitest.config.mjs`. Called without arguments, it reads the targets from `points.ep` in the Vite root, so Vitest and TypeScript share one list:

```js
import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'

export default defineConfig({
  plugins: [executionPoints()],
  test: {
    include: ['examples/**/*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
```

The plugin also adds the package's Vitest setup module, `execution-points-prototype/vitest`, to `test.setupFiles`, next to any setup files of your own: after each test it fails the test when a replacement did not run as often as the test said. `executionPoints({ targets: [...] })` lists the targets in the config instead; explicit targets win and the manifest is then not read. `executionPoints({ root })` names the directory that holds `points.ep` when it is not the Vite root.

### VS Code setup

Content mappers require **TypeScript 7.1** (`tsgo`), not VS Code's bundled TypeScript version. `.vscode/settings.json` in this repo already sets `"typescript.tsdk"`, `"js/ts.tsdk.path"`, `"js/ts.contentMappers.enabled": true`, and `"js/ts.experimental.useTsgo": true`, **but VS Code will still use its bundled TypeScript until you opt in**:

1. Open any `.ts` file in VS Code.
2. Run **TypeScript: Select TypeScript Version…** from the Command Palette and choose **Use Workspace Version** (`7.1.0-dev...`).
3. If you see `ExecutionPointFileRegistry is empty` in the editor, check the TypeScript version indicator in the status bar and run **TypeScript: Restart TS Server**.

To have VS Code check `points.ep` against its schema, treat the file as JSON: `"files.associations": { "*.ep": "json" }`.

## How the types work

TypeScript 7.1 introduces **content mappers** for non-`.ts` extensions (`tsconfig.json` `"contentMappers"`). Rather than rewriting `.ts` files, scanning test files, or writing `.d.ts` files to disk:

1. **Single `.ep` anchor (`points.ep`).** `tsconfig.json` registers the package's content mapper for `.ep` files with `"dynamicConfig": true`; TypeScript starts it from the built package (`dist/content-mapper-main.mjs`, which serves standard input with what `src/content-mapper.ts` exports). The mapper watches the tsconfig, the targets, and every project file the analysis read, so a change to a file that a target imports refreshes the types. A manifest that is wrong (an unknown key, a target that matches no file) gets a diagnostic at the entry that is wrong.
2. **Index target ASTs with TypeScript 7.1 (`src/discovery.ts`).** Walks each target module via `api.createSourceFile` to index selectable expressions (`CallExpression`, non-assignment `BinaryExpression`, `ConditionalExpression`) with enclosing function name, `callee`/`operator`, `nth`, and safe pre-expression local bindings.
3. **Analyze with warm incremental snapshots (`src/contracts.ts`).** A persistent `typescript/sync` snapshot analyzes target `.ts` files (excluding `.ep` and `contentMappers`, preventing recursion) and updates incrementally via `snapshot.update(...)` on file saves. Result types come from the unmodified target AST; narrowed local types come from a nested incremental probe.
4. **Emit virtual file schema.** `transform("points.ep")` returns a virtual `.ts` file augmenting `ExecutionPointFileRegistry` with the discriminated union of each target file's nodes. Every type is written the way it resolves from the registry: types of other modules as `import("fs").Stats`, export-reachable private types (`Quote`, `User`, `Order`) through the export that reaches them, unreachable private types as structural or unique-symbol-branded helpers. An error inside the registry is reported at the manifest entry that lists the file.
5. **Native `tsc` and VS Code checking.** `select()` (control-flow narrowing) derives its full types directly from `ExecutionPointFileRegistry`—so editing tests never triggers the content mapper and updates on every keystroke (~4 ms).

## Supported subset and limits

- Targets are TypeScript modules configured in `points.ep`. A file with no import or export is a global script: it is skipped by the type registry, by the Vite plugin, and by `execution-points list` alike.
- Selectable expressions are calls, binary operations that do not assign, and ternaries, including nested ones.
- An expression is skipped only where moving it into a function of its own, which is how it is intercepted, would change what the code does:
  - where JavaScript needs a place and not a value: the target of an assignment, the operand of `delete`, `++`, or `--`;
  - a binary operation or ternary that is itself called, constructed, or used as a template tag. A call is selectable there, as `make(a)` is in `make(a)(b)`: its result carries no receiver;
  - an expression that itself awaits, yields, calls `super(...)`, evaluates code with a direct `eval`, or imports with `import()`. What a function inside the expression does is its own business: `retry(async () => { await load() })` and `super.save(id)` are selectable;
  - a part of an optional chain that goes on behind it without a `?.` of its own, such as `o?.find(1)` in `o?.find(1).name(2)`. The chain as a whole, a chain inside an argument, and `o?.find(1)` in `o?.find(1)?.name(2)` are selectable.
- `new X()`, property reads, and an `await` itself are not selectable kinds.
- Captures are the local names that are initialized every time the code reaches the expression, in every order in which it can be called. A name that a later `case` of the same `switch` declares, and a name that is declared after the first use of the function declaration the expression is in, are not offered. Module-level bindings are never captures, a `var` is offered like a `let` written in its place, and the name of a class is not offered inside that class.
- Captures expose explicitly selected binding values via lazy thunks; objects retain normal mutability while the `locals` container is shallowly frozen with a null prototype.
- The plugin leaves what must come first in a file where it is: a byte-order mark, a shebang line, and leading directives such as `'use client'`.
- Code that reads its own source text (`fn.toString()`) sees the instrumented text.
- The runtime uses Node `AsyncLocalStorage` to isolate concurrent and nested async replacement scopes.

## Source layout

| File | Responsibility |
| --- | --- |
| `points.ep` | Target manifest and TypeScript 7.1 content-mapper anchor. |
| `src/discovery.ts` | Index selectable expressions, the function bodies they belong to, and safe local bindings over TypeScript 7.1 ASTs. |
| `src/contracts.ts` | Extract result types and narrowed locals via warm incremental snapshots and emit virtual `ExecutionPointFileRegistry`. |
| `src/content-mapper.ts` | The content mapper: reads the manifest, answers TypeScript 7.1's JSON-RPC requests, and `serve(input, output)` for a pair of streams. |
| `src/content-mapper-main.ts` | The mapper as the process TypeScript starts: it serves standard input and output. |
| `src/plugin.ts` | Instrument configured target modules, keeping each function's original statements beside its wrapped form, and register node metadata through Vite (test files are untouched). |
| `src/runtime.ts` | The runtime and its types: `ExecutionPointFileRegistry`, the narrowing visitor `select()`, `Point`, `Replacement`, `Pause`, `interleavings()`; and, for instrumented code, `registerFile()` with the per-function flags and `invoke()`. |
| `src/vitest.ts` | Vitest setup module: after each test, fail it when a replacement did not run as often as the test said. |
| `tsdown.config.ts`, `tsconfig.build.json` | The build: one output file per source file in `dist/`, with declarations. |
| `examples/` | Runnable applications and Vitest examples. |
| `checks/verify.mjs` | End-to-end `tsc --runExternalCode`, live `tsc --lsp --stdio` (hover, completions, diagnostics), negative type checks, and no-write verification. |
| `probes/` | Small scripts that call the unchanged code and print what it does; `FINDINGS.md` names the probe behind each finding. |

The native compiler API is currently a beta dependency. See the [TypeScript 7.1 beta announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) for its API model.
