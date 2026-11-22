# Execution points: prior art and design implications

Research date: 2026-11-22. Repository baseline: [8c339ed2f7fb2d0e1e370ed16117369f90b9c17d](https://github.com/schiller-manuel/execution-points/tree/8c339ed2f7fb2d0e1e370ed16117369f90b9c17d).

## Assessment

The broad idea has substantial prior art, including actual tools that use programmable breakpoints to mock behavior during tests. External selection, arbitrary instrumentation, access to surrounding locals, replacement values, and original-operation access all have precedents. The most revealing comparisons come from live Smalltalk systems, Java game modding, dynamic-language instrumentation, embedded testing, and language/runtime research—not only mocking libraries.

The project still has a compelling combination: ordinary TypeScript tests select internal source expressions, discover their available locals and result types through the compiler, and activate replacements in an explicit execution context. Whole-expression laziness is a significant semantic choice: a replacement can prevent receiver and argument evaluation, whereas many operation wrappers receive operands that have already been evaluated. The survey did not establish another tool with this exact combination of TypeScript authoring, native compiler/editor contracts, capture inference, evaluation boundary, and test-scoped activation. That is a bounded research conclusion, not a proof of novelty.

The most useful conceptual ancestor is **Pharo Reflectivity**. The most practical operation-wrapping comparison is **MixinExtras**. **Ptera** is a particularly close testing-oriented local-state intervention tool. **Truffle/Insight** provides a strong pre-node instrumentation architecture. **DOTT.NG and testIDEA** directly answer the original programmable-breakpoint testing idea. **ABAP test seams** show that test-specific replacement of a code region with access to its locals can be a language feature.

## What changed in the repository

This comparison uses the new implementation rather than the earlier string-query design:

- `points.ep` enumerates target modules; the TypeScript 7.1 content mapper creates a virtual `ExecutionPointFileRegistry`.
- `select(file, visitor)` exposes a discriminated union of selectable nodes, supporting normal control-flow narrowing. `fromFile(file, navigate)` provides typed fluent navigation.
- Result and capture contracts come from the application. Test files remain ordinary TypeScript, with no test scanning or generated declaration files on disk.
- Selection includes ordinary calls, non-assignment binary expressions, and conditional expressions. Unsupported constructs are deliberately excluded.
- Replacement happens before the entire selected expression. `original()` evaluates that expression on demand and currently reevaluates it on every call.
- Captures are readonly binding snapshots; referenced objects retain normal mutation behavior.
- `withReplacement(handler, action)` uses AsyncLocalStorage to separate activation contexts, with a global active-count fast path.

The repository includes checks for the native compiler and LSP. I inspected that implementation and its checks; this research did not rerun the complete compiler/editor test suite. Static types reject selection problems that can be inferred from the callback's type. The visitor resolver enforces exactly one runtime match; the navigator resolves a specified/default occurrence. Types cannot prove the behavior of every arbitrary predicate callback.

Sources: [README](../../README.md), [runtime](../../src/runtime.mjs), [public types](../../src/runtime.d.ts), [discovery](../../src/discovery.mjs), [contracts](../../src/contracts.mjs), [Vite transform](../../src/plugin.mjs), [verification](../../checks/verify.mjs).

## How the survey compares systems

“Can mock a function” is too coarse. Each system needs answers to six different questions:

1. **Selection:** a definition, one caller-side operation, an arbitrary AST expression, a bytecode instruction, or a debugger location?
2. **Boundary:** before the complete expression, after operands but before the operation, at function entry, or after a result exists?
3. **Context:** arguments only, arbitrary lexical locals, raw frame state, or compiler-inferred capture types?
4. **Control:** observe, mutate state, replace a value, skip a region, return from the enclosing function, or invoke an original/next operation?
5. **Activation:** globally installed, conditionally enabled, thread/process/task owned, or limited to a logical asynchronous execution context?
6. **Authoring:** source markers, compiler transformations, debug information, custom language syntax, generated code, or normal typed callbacks?

The detailed catalogs cover more than sixty named projects, mechanisms, and research systems. Related entries are grouped rather than inflated into a claim of sixty equivalent competitors:

- [JVM, .NET, AOP, and fine-grained instrumentation](prior-art-managed.md)
- [Dynamic languages and JavaScript/Julia instrumentation](prior-art-dynamic.md)
- [Debuggers, native instrumentation, fault injection, scheduling](prior-art-debugger.md)
- [Language integration, typed selection, effects, and scope](prior-art-language-and-scope.md)

## Closest comparisons

| System | Closest overlap | Important difference | Main lesson |
| --- | --- | --- | --- |
| Pharo Reflectivity / MetaLinks | AST-node attachment; before/instead/after; selected context; executable operation | Dynamic Smalltalk; ordinary message operands are already evaluated | Separate node selection, context extraction, and execution control |
| MixinExtras / Mixin | Selected inner operation; local capture; operation wrapping and chaining | Bytecode patterns; manually declared handler signatures; operands already evaluated | Specify continuation composition and match cardinality |
| GraalVM Truffle / Insight | Filtered AST events; available locals; pre-node intervention and replacement | Requires an instrumentable guest language/runtime; no equivalent TypeScript callback contract | Treat timing and control capability as explicit runtime properties |
| Ptera | External selectors; private locals; scoped observation and overriding | Primarily variable-value intervention after the producing expression | Good testing ergonomics do not imply identical evaluation semantics |
| Aran | Imperative AST pointcut callback; rewrite-generated JavaScript advice | Generic dynamic-analysis contexts, not application-specific inferred types | Reuse ordinary programming constructs for selection |
| Javassist ExprEditor | External expression visitor; replacement snippets; locals; `$proceed` | Embedded Java source and debug metadata; opcode boundary | Expression replacement and local capture are established capabilities |
| Byteman / BMUnit | Location rules, conditions, locals, faults, test installation/cleanup | Early return exits enclosing method; post-call replacement is after execution | Distinguish operation substitution, state changes, and enclosing control flow |
| DOTT.NG / testIDEA | Test-driven programmable breakpoints, state intervention, forced outputs | Remote debugger, symbols, setup requirements, executable-line constraints | The original breakpoint-testing idea already has direct implementations |
| ABAP Unit test seams | Test supplies replacement statements with seam-scope variables | Requires authored named regions | Explain the product as externally selected, typed test seams |
| Cassette / IRTools | Contextual execution and recursively applied compiler transformations | Callable/IR abstraction; lexical captures not automatically exposed | Keep transformation context distinct from global monkey-patching |
| C# interceptors | Compiler-validated replacement of exact invocation locations | Call signatures, not arbitrary expressions or caller locals; static redirection | Fingerprint locations and use precise compiler diagnostics |

### Pharo Reflectivity: the architectural ancestor

A MetaLink attaches behavior to an AST node. It specifies when to run and which pieces of execution context to expose, including an executable representation of the operation. Dynamic installation, conditions, object-specific activation, and meta-execution levels address adaptation and recursive advice. The authors' retrospective documents a substantial history of tools built on it, including debugging.

Its similarity is deeper than the word “breakpoint”: it separates the location, requested context, and alternative behavior. That is also a good architecture for execution-points. A later observation API need not redefine selection or capture.

One distinction was checked against current Pharo14 source. `emitMessageNode:` visits the receiver and arguments before emitting before/instead links; `RFOperationReification` constructs the message operation from those computed values. This ordinary-message path therefore cannot suppress operand side effects. Inlined special messages have another path, so this finding must not be generalized to every Pharo node kind.

Sources: [Reflectivity retrospective](https://archive.marcusdenker.de/publications/Cost20a-Programming-Reflectivity.pdf), [object-centric breakpoint example](https://thepharo.dev/2020/04/06/implementing-an-object-centric-breakpoint-with-reflectivity/), [translator](https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/RFASTTranslator.class.st), [operation reification](https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/RFOperationReification.class.st).

### MixinExtras: the practical operation wrapper

MixinExtras combines operation selection, local capture, and an original-operation object. Its expression patterns select operations in compiled bytecode; they are not a promise to accept arbitrary Java source or query a source AST. `@WrapOperation` allows bypassing or invoking a selected operation. `@Local` can capture nearby locals, with disambiguation; mutable reference forms can also rebind them. Execution-points deliberately offers the narrower readonly-binding contract.

The crucial composition detail is that `original.call(...)` may invoke another wrapper. “Original” can mean the next layer rather than the untouched program. Mixin's required/expected injection counts also distinguish a robust selector from one that silently stops matching after a refactor.

Sources: [WrapOperation](https://github.com/LlamaLad7/MixinExtras/wiki/WrapOperation), [Expressions](https://github.com/LlamaLad7/MixinExtras/wiki/Expressions), [Local](https://github.com/LlamaLad7/MixinExtras/wiki/Local), [injector validation](https://github.com/SpongePowered/Mixin/wiki/Advanced-Mixin-Usage---Callback-Injectors).

### Ptera, Aran, and Truffle: three different close matches

Ptera selects functions and variables externally and supports probes that override a selected value. Its active overlay uses Python context-local storage. It is a useful reference for conditional test scenarios and useful failure when nothing matches. Its transform places the interaction around a computed value: replacing a local assignment value does not prevent the right-hand side from executing.

Aran is especially relevant to the repository's new imperative visitor. Its expression pointcut receives a node, parent, and root and can return metadata that reaches runtime advice. Around-call advice can replace or perform a call, but receives computed operands. This is a strong precedent for the selection API, separate from application-specific TypeScript contract generation.

Truffle instrumentation supplies entry events before an instrumented AST node executes. An unwind can return a replacement value or request reentry; scope APIs expose available guest-language variables. Insight presents related capabilities through scripts. This is a stronger pre-node comparison than a function-entry breakpoint. It requires support from the language implementation and is not a backend that can simply be switched on in ordinary Node/V8. Reentry and early-return control also differ from a reusable lexical expression thunk.

Sources: [Ptera testing](https://ptera.readthedocs.io/en/latest/testing.html), [Ptera transform](https://github.com/breuleux/ptera/blob/master/ptera/transform.py), [Ptera overlay](https://github.com/breuleux/ptera/blob/master/ptera/overlay.py), [Aran expression pointcut](https://lachrist.github.io/aran/typedoc/types/weave_flexible_aspect.ExpressionPointcut.html), [Aran introduction](https://lachrist.github.io/aran/start.html), [Truffle EventContext](https://www.graalvm.org/truffle/javadoc/com/oracle/truffle/api/instrumentation/EventContext.html), [Truffle NodeLibrary](https://www.graalvm.org/truffle/javadoc/com/oracle/truffle/api/interop/NodeLibrary.html), [Insight manual](https://www.graalvm.org/latest/tools/graalvm-insight/manual/).

## The most consequential semantic distinction: what has already run?

Consider the selected expression:

```ts
getClient().send(order.id, attempt++)
```

Four superficially similar hooks have different powers:

| Boundary | What already happened when the handler runs? | What replacement can prevent |
| --- | --- | --- |
| Before complete expression | None of the selected expression | Receiver computation, property lookup, arguments, and call |
| Immediately before invocation | Receiver/property/argument evaluation | Calling the selected function |
| Function entry | Caller operand evaluation and dispatch | Executing the function body |
| After expression | All expression evaluation | Nothing already executed; only its delivered result changes |

The prototype chooses the first row. Ordinary AspectJ call advice, Mixin operation wrappers, and several bytecode/native call hooks are closer to the second or third. Ptera value overrides and post-expression callbacks belong to the last row for the value-producing expression. Truffle offers stronger entry control, depending on the instrumented node. No broad uniqueness claim is needed: a clear guarantee is valuable on its own.

This distinction determines what to test. Getter calls, side-effecting arguments, thrown operands, short-circuit behavior, receiver identity, nested selected expressions, and repeated `original()` should all have explicit expected traces. A call-through test returning the correct final number is insufficient to establish preserved evaluation order.

The same distinction explains why simply exposing `args` on every replacement would change the design: obtaining argument values generally evaluates the arguments. Selected lexical captures avoid that commitment. A future post-operand operation hook should have its own timing contract.

## Broader landscape

### Aspect-oriented and typed language research

AspectJ supplies established vocabulary: join points, pointcuts, advice, lexical scope, dynamic control-flow scope, and `proceed`. It does not expose arbitrary caller locals or arbitrary source expressions as standard join points. Bugdel's 2005 debugging work adds source-line advice, locals/private fields, and editor feedback. PROSE experimented with debugger-based dynamic advice before moving toward JIT/bytecode mechanisms. Fine-Grained Aspects and Énfasis explored AST paths, local-aware advice, and assertions. AspectScript brought first-class JavaScript pointcuts and scoped deployment; AspectML researched statically typed polymorphic pointcuts and inferred advice.

Typed interception, AST selection, and local-aware advice therefore each have historical precedents. The practical question is how well they fit normal TypeScript projects today. Primary sources and individual qualifications are in the [managed catalog](prior-art-managed.md) and [language catalog](prior-art-language-and-scope.md).

### Mature managed-runtime mocking and patching

Harmony's IL matcher can replace one call inside another method. Byte Buddy's member substitution reaches calls, constructors, and fields. Microsoft Fakes, Pose, Prig, JMockit, PowerMock, JustMock, and Typemock all demonstrate variants of replacing behavior without introducing an application interface first.

The caution is scope. Microsoft Fakes' disposable shim context does not create thread-local isolation; Mockito's static mocks are thread-local; neither fact establishes Node-style async-context semantics. Harmony `__state` and Byte Buddy `Advice.Local` create instrumentation state, not access to arbitrary existing application locals. Friendly names can hide materially different capabilities. See the [managed catalog](prior-art-managed.md).

### Dynamic languages and contextual execution

Cassette and IRTools offer contextual compiler transformations; SimpleMock packages contextual call interception for tests. Other Julia tools use call-site markers, definition markers, or method-table replacement. Jalangi2 permits skip/result changes, while NodeProf's documented frontend explicitly does not support Jalangi-style replacement results despite the power of its underlying Truffle runtime.

Python tracing, monitoring, writable frame locals, and frame-evaluator hooks supply different powers. Ruby TracePoint/Binding and Lua debug hooks expose events and local state. Lisp conditions/restarts, Emacs advice, Racket interposition, PHP uopz/AspectMock, Erlang Meck, and Clojure dynamic rebinding cover additional forms of alternate execution. None should be equated with arbitrary typed expression replacement solely because it can observe a line or patch a function. See the [dynamic catalog](prior-art-dynamic.md).

### Native instrumentation, failpoints, and systematic testing

Dyninst, Frida, DynamoRIO, Pin, and Pyda operate at native function or instruction boundaries. They provide serious prior art for points, inserted snippets, per-invocation state, original-call handling, and removal. Native registers or debug locals are not automatically source-level typed capture contracts.

libfiu, PingCAP failpoints, Rust fail-rs, and kernel failure injection show named fault sites, activation filters, hit schedules, and failure policies. Many require authored markers; some global lifetime models serialize tests. Filibuster distinguishes source sites from dynamic distributed occurrences. CHESS, Coyote, loom, and Java PathFinder explore scheduling; merely allowing a callback at a point does not provide systematic schedule exploration. Mutation systems such as Stryker share selective transformation and runtime switching, while asking whether tests detect generated changes. These are adjacent capabilities, not a single interchangeable product class. See the [debugger catalog](prior-art-debugger.md) and [language catalog](prior-art-language-and-scope.md).

### Effects, dependencies, and context-oriented programming

Effect handlers and dependency environments supply alternative semantics through declared operations. Koka and OCaml make resumption policy explicit; a captured continuation is not the same thing as reevaluating one lexical expression. Effect-TS, ZIO, and Eio provide useful controlled test services, but applications must use those seams.

Mox's process ownership/allowances, Swift Dependencies' task-local lifetimes, and ContextJS's asynchronous layer activation are especially valuable for the current runtime. They show that ownership, propagation, escaped work, and teardown must be designed independently. A callback-shaped API is not enough to establish isolation. See the [language catalog](prior-art-language-and-scope.md).

## Recommendations for this prototype

### 1. Keep the source-transform architecture and the typed APIs

The researched alternatives support the present architecture. Source transformation can preserve the lexical closure while selecting whole expressions before their children execute. The compiler can provide the application-specific contract that debugger strings and generic runtime hooks lack. Keep the current visitor and fluent navigator as two ways to produce the same selection object; do not build a new textual query language just to resemble older pointcut systems.

Separate discovery/selection, contract extraction, instrumentation, and activation. That keeps the core independent of Vitest and allows another runner adapter without redefining the semantics. A debugger backend could remain an exploration for remote/native targets, with a different capability declaration.

### 2. Make continuation semantics explicit

Resolve whether `original()` means base expression, next wrapper, or a once-only operation. These are different contracts. Today it is a reusable thunk for the base selected expression; nested child expressions can still encounter their own active replacements. It is not a continuation of the rest of the containing function.

For an initial testing API, I would favor at-most-once call-through, allowing zero calls for replacement, and make repeated evaluation an explicit later operation. This is a recommendation, not an implemented change. If retaining the current repeated-call policy, document its full side effects and test it. Do not silently memoize as a “fix”: memoization changes exception behavior, promise identity, and intentional retries.

Also specify recursive entry from replacement logic and composition when multiple layers select the same node. Current nested scopes override the same point rather than composing a wrapper chain; make that deliberate.

### 3. Separate static cardinality from runtime hit assertions

Exactly one AST match does not imply execution. A point can be selected correctly and never reached; loops can hit it repeatedly. Add useful failure for a replacement expected to run but not used. Distinguish static occurrence selection (`nth`) from dynamic invocation selection (`onHit`, or another clearly named API). Verify hit expectations when the chosen activation lifetime ends.

Mixin injection counts, Ptera empty-probe errors, Byteman counters, testIDEA hit sequences, and Filibuster execution indexing each address a different part of this problem. Do not overload one integer to mean all of them.

### 4. Resolve asynchronous scope lifetime before expanding features

The current runtime has a concrete consistency issue. Its README says async descendants retain the creation context after the action returns. The global `activeCount` bypass means a descendant instead sees the original when no scope is active. If an unrelated scope is active, the old context becomes effective again.

The checked-in [reproduction](scope-lifetime-repro.mjs) uses the actual runtime and produces:

```json
{
  "noOtherScope": "original",
  "otherScopeActive": "A"
}
```

Both cases schedule work inside scope A, let A's action finish, and release that work later. The second runs the release while scope B is active. The descendant retains A's ALS store; B merely raises the global active count. Another scope's presence should not decide whether A still applies.

Two coherent policies are possible. Under action lifetime, close an explicit per-scope token when the returned action/promise settles; descendants then consistently lose the replacement. Under transitive async-context lifetime, descendants keep it, and the optimization must respect those contexts. I recommend action lifetime for an initial test API because completion and expectation verification are easier to explain, but the existing README currently promises the other model. This decision needs to be explicit. No runtime fix was made in this research branch.

### 5. Treat target identity and diagnostics as product features

Show the matched source span, enclosing declaration, expression text, capture types, and match count. Discovery already fingerprints the relative file, complete source text, and node range into its ID. Build explicit revision validation and stale-handle diagnostics on that foundation. From source inspection, cached `select` handles retain an old ID after a file is re-registered, while navigator handles resolve against the new metadata and can select a different occurrence by `nth`. Those behaviors need an intentional invalidation/reselection policy; they are not a claim that every runner's HMR reproduces the problem. A source range is a locator, not durable semantic identity.

The current syntactic callee name is useful but does not establish symbol identity: unrelated receivers can expose the same method spelling. Defer complex semantic selectors until needed, but make the distinction visible. Prefer a loud re-selection error over a plausible replacement at the wrong site.

### 6. Test type fidelity, not just pleasant completions

The native registry approach is a real authoring improvement. Keep adversarial checks for generic instantiation, overloads, unions, literal results, promise results, narrowing, and inaccessible types. A freshly generated unique-symbol brand is not automatically the original private nominal identity. Publicly reachable aliases and generated structural/helper types need separate correctness criteria. This is a testing recommendation, not a reproduced type failure.

Consider a result that is inferred as one literal: requiring exactly that literal is consistent with expression-type replacement but may prevent the scenario a user wants to test. Any widening should be deliberate and visible rather than a general escape hatch that erases the contract.

### 7. Add scenarios before adding a universal execution engine

Observation, hit assertions, conditional replacement, and scripted values/faults naturally build on the current selection and capture model. They are more immediate testing value than rebinding lexical variables, arbitrary statement control flow, remote debugging, or systematic concurrency exploration.

Module initialization deserves explicit treatment: a scope installed after import cannot affect an expression that already ran. A future import-under-scope API must deal with registration and module caching, rather than pretending top-level selection alone solves activation timing. Performance should likewise be measured in uninstrumented, instrumented-inactive, unrelated-active, and matching-active cases. A bypass for handler lookup is not zero transform overhead.

## Suggested reading order

1. Reflectivity retrospective and the AST-link examples: closest architectural model.
2. MixinExtras WrapOperation and Local: concrete operation/capture/continuation API.
3. Ptera testing and transform source: test ergonomics and precise value timing.
4. Truffle EventContext and Insight manual: cross-language pre-node control.
5. Aran expression pointcuts: direct precedent for imperative AST selection.
6. ABAP test seams and DOTT.NG: direct test-use precedents in very different environments.
7. Mox, Swift dependency lifetimes, and asynchronous ContextJS: ownership and completion.
8. Roslyn interceptors and Clang/Spoon: target identity, diagnostics, and typed selection.

## Evidence and limits

The survey uses primary documentation, papers, and selected implementation source. Historical systems are included as prior art, not endorsements of current compatibility or maintenance. Tool capabilities are attributed at their documented boundary: engine support does not prove frontend support, observing a value does not imply replacing it, and teardown does not imply concurrent isolation.

The complete third-party toolset was not installed or benchmarked. The asynchronous lifetime inconsistency was reproduced directly against the inspected execution-points runtime. The research branch adds documentation and the reproduction only. It neither changes implementation semantics nor establishes that no matching project exists elsewhere.
