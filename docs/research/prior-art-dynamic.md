# Dynamic-language prior art for execution-points

Research date: 2026-11-22. Comparison baseline is the inspected execution-points main commit `8c339ed2f7fb2d0e1e370ed16117369f90b9c17d`: externally selected expressions; typed imperative AST selector and fluent selector backed by target-file schema; flow-sensitive capture types; whole-expression replacement before receiver/argument evaluation; selected local bindings; `original()`; AsyncLocalStorage-scoped callback activation. The types check inferable selection ambiguity. The runtime visitor resolver enforces exactly one match; the navigator resolves a specified/default occurrence. This comparison uses the current imperative APIs.

## Main conclusion

The closest dynamic-language precedents are **Ptera** for externally probing/replacing private locals with context-local activation, **Aran** for imperative AST expression pointcuts plus JavaScript rewriting, **AspectScript** for first-class JavaScript pointcuts and scoped around advice, and **Cassette** for executing an existing computation under alternate semantics. Jalangi and IRTools supply further implementation precedents. The distinctive candidate is the *combination* of application-derived TypeScript selection/capture types, precise source-location matching, before-whole-expression semantics, and practical test lifetimes; this research does not establish that combination as globally novel.

The key semantic distinction throughout is **which effects have happened before the replacement handler runs**. Ptera's assignment override runs after the RHS. Standard call advice in Aran/Jalangi/AspectScript/Cassette runs after operand evaluation. execution-points' selected whole-expression thunk runs before those operands. These are materially different behaviors, even when all are described as interception.

## 1. Ptera — Python; closest existing user-facing tool

Ptera instruments existing functions to expose internal variable values through selectors such as `g(b) > f > a`, including dynamic call ancestry and values from multiple scopes. It explicitly supports testing, conditional breakpoints, invariant checking, and value overrides. `probing("f > hidden", overridable=True)` can override a focused local assignment. The probing pipeline can filter before applying the override, and `fail_if_empty()` prevents an assertion passing merely because its target never executed. This makes it a direct predecessor of externally installed test points, rather than just a generic tracing framework.

Two source-level details matter. First, `ptera/overlay.py` stores the active handler collection in `ContextVar`, sets an extended collection at entry, and resets its token at exit. It therefore has real context-local handler activation, not only a global monkeypatch that is later undone. Second, `visit_Assign` in `ptera/transform.py` rewrites the assignment so its RHS is an argument to the interaction function. The RHS has already run before the override. Return-value overrides similarly receive an already computed result. Ptera cannot therefore be presented as equivalent to skipping a whole expression and its side effects. Its selectors are function/variable/call-path based, and it does not supply application-derived static TypeScript capture contracts.

**Borrow:** observations and replacements built on the same point mechanism; hit validation; composable conditions; explicit context-local state; useful diagnostics when selectors never fire.

Primary sources:

- https://ptera.readthedocs.io/en/latest/intro.html — selectors and cross-scope context .
- https://ptera.readthedocs.io/en/latest/guide.html — overrides, their restrictions, conditional breakpoints .
- https://ptera.readthedocs.io/en/latest/testing.html — testing patterns and `fail_if_empty()` .
- https://github.com/breuleux/ptera/blob/master/ptera/overlay.py — `HandlerCollection.current = ContextVar(...)`, context-manager reset; fetched via GitHub connector.
- https://github.com/breuleux/ptera/blob/master/ptera/transform.py — `visit_Assign`, `visit_Return`; fetched via GitHub connector.

## 2. Aran — JavaScript; imperative AST pointcuts already exist

Aran is a source transformation toolkit for JavaScript dynamic analyses. Its flexible weaving API defines `ExpressionPointcut` as a function receiving the expression node, its parent, and the root program, returning optional JSON metadata. This is strong prior art for the proposed imperative AST selector shape: it is not necessary to invent a textual query language, and a predicate over nodes is not itself new. Aran separates parsing/transpilation, selection/weaving, and re-emission. Source-location tags can be passed into the runtime advice.

The runtime supports `apply@around` and `construct@around` advice, plus lexical read/write, block, await, and other hooks. The call advice receives the callee, receiver, and argument array and can use `Reflect.apply` for call-through. These values are already evaluated, so that API intercepts the invocation rather than the entire unevaluated source call. Block frame hooks can expose variable mappings, but the public types describe generic runtime values, not flow-sensitive TypeScript types extracted from the user's selected source expression. It is an instrumentation substrate rather than a ready test library with capture autocomplete, cardinality validation, and asynchronous per-test handler isolation.

**Borrow:** a clean distinction between compile-time selection and runtime advice; serializable point metadata; reliable source identity; explicit operation kinds. **Do not claim:** execution-points invented imperative AST pointcuts or JavaScript around advice.

Primary sources:

- https://lachrist.github.io/aran/typedoc/types/weave_flexible_aspect.ExpressionPointcut.html — precise selector signature .
- https://lachrist.github.io/aran/start.html — instrumentation and `apply@around` example .
- https://lachrist.github.io/aran/api.html — transformation stages .
- https://lachrist.github.io/aran/typedoc/types/weave_standard_aspect.AspectTyping.html — runtime hooks .
- https://lachrist.github.io/aran/typedoc/types/weave_flexible_aspect.AspectTyping.html — flexible runtime typings .
- https://lachrist.github.io/aran/typedoc/types/weave_flexible_aspect.Frame.html — frame mapping .

## 3. AspectScript — JavaScript; historical scoped advice and deployment

The 2010 AspectScript work is unusually close conceptually. Aspects, pointcuts, and advice are ordinary JavaScript values/functions; pointcuts have fluent combinators and can depend on event history. Source rewriting creates implicit call, execution, property-access, assignment, and other join points without requiring an explicit marker at each application operation. Around advice can omit, repeat, or delay `proceed()`, and multiple applicable advices form a chain. `deploy(aspect, thunk)` limits deployment to the thunk's dynamic extent.

Its scoping strategies distinguish propagation down the call stack, capture by newly created functions/objects, and an activation filter. This directly informs questions about spawned tasks, escaped callbacks, and dynamically bounded tests. The paper also treats reentrancy as a first-class semantic problem: executing pointcuts/advice must not accidentally trigger an infinite chain of their own instrumentation. However, the described dynamic deployment mutates a global aspect environment around the thunk; it should not be credited with modern AsyncLocalStorage concurrency guarantees. The call transformation passes the computed receiver/function/arguments to its reifier, so its call advice does not skip argument evaluation. It offers dynamic context exposure, not the target-program-derived type schema in execution-points.

**Borrow:** separate point selection from deployment policy; articulate propagation, ordering, and reentrancy; preserve `proceed()`/`original()` semantics explicitly. This is substantial prior art for the high-level idea, not merely a decorator library.

Primary sources:

- https://pleger.github.io/papers/toledoAl-aosd2010.pdf — Toledo, Leger, Tanter, *AspectScript: Expressive Aspects for the Web*, AOSD 2010 . §§3.3, 3.4, 4.1: deployment, reentrancy, rewrites; p7 call reification shows operands already evaluated.
- https://pleiad.cl/aspectscript/ — first-class aspects, scoped deployment .
- https://pleiad.dcc.uchile.cl/aspectscript/tutorial — online/offline rewriting .
- https://pleiad.dcc.uchile.cl/aspectscript/demo — retaining a join point and later calling `proceed()` .
- https://users.dcc.uchile.cl/~etanter/courses/cc71p/2008/papers/DYN/tanter-aosd2008.pdf — *Expressive Scoping of Dynamically-Deployed Aspects*, the underlying scope design .

## 4. Cassette — Julia; contextual execution of existing code

Cassette lets a computation run under an explicit context that changes how operations dispatch, without rewriting the application by hand. Its contextual dispatch recursively routes calls through `overdub`, with `prehook` and `posthook` for observation. An overloaded `overdub` can substitute behavior; `recurse` runs the original body under contextual transformation, while `fallback` handles operations that cannot be recursively transformed. Contexts can carry state and distinguish behavior by function/type. This is strong precedent for scoped alternate execution semantics, including call-through and nested transformation.

The contextual-pass documentation is particularly useful for execution-points: its print-slicing example explains why intercepting `println` alone does not move the computations producing its arguments. A deeper compiler pass can transform control flow and surrounding scope, and use dependency analysis to include argument construction. This is the same distinction between replacing an invocation and replacing the whole expression. Cassette operates on Julia IR with inference over transformed code, rather than generating a separate TypeScript schema/editor bridge. Ordinary overdub selection is mainly function/type based, not a typed source-AST selection of one occurrence with selected named caller locals.

**Borrow:** define whether `original()` resumes within the active context or bypasses it; make unsupported-operation boundaries explicit; treat before-expression and after-operands interception as different modes. The custom-pass example is excellent evidence for why timing belongs in the public contract.

Primary sources:

- https://julia.mit.edu/Cassette.jl/latest/contextualdispatch.html — overdub/hooks/recurse/fallback .
- https://julia.mit.edu/Cassette.jl/latest/contextualpass.html — compiler passes, control flow, argument-construction issue .
- https://julia.mit.edu/Cassette.jl/latest/relatedwork.html — connections to AOP, context-oriented programming, and historical compiler techniques .

## 5. Jalangi2 — JavaScript; operation replacement across a language

Jalangi2 instruments JavaScript for dynamic analyses, exposing callbacks for calls, reads/writes, property accesses, unary/binary operations, conditions, function exit, and more. `invokeFunPre` receives the function, base, and arguments, can substitute those values, and can skip the invocation. A subsequent callback can substitute its result. Similar pre/post facilities can suppress field operations or alter expression results. Instrumentation IDs and source maps tie dynamic events back to static locations. This is direct evidence that behavior-changing instrumentation is not limited to replacing module exports or named functions.

Its callback template also makes the boundary precise: call operands have already been evaluated by the time `invokeFunPre` runs. Instrumentation IDs identify operations, but do not provide the proposed compile-time target schema, capture autocomplete, narrowing, or test lifetime API. Its original project targets an earlier JavaScript language generation; it is useful design prior art rather than an assumed drop-in backend for a modern TS/Vitest project.

**Borrow:** enumerate operation semantics explicitly; give each static point a stable, inspectable source identity; separate pre-event, post-event, replacement, and control-flow capabilities instead of calling everything a breakpoint. Low-level callback breadth does not automatically imply ergonomic typed lexical capture.

Primary sources:

- https://github.com/Samsung/jalangi2/blob/master/src/js/runtime/analysisCallbackTemplate.js — authoritative signatures and skip/result semantics; fetched via GitHub connector.
- https://github.com/Samsung/jalangi2/blob/master/README.md — project scope .
- https://manu.sridharan.net/files/JalangiTutorial.pdf — author tutorial .

## 6. IRTools dynamos — Julia; dynamically scoped compiler transformations

IRTools exposes a manipulable Julia intermediate representation and dynamos that transform code as execution reaches it. The documentation describes a dynamo as akin to a dynamically scoped macro: a transformation applies recursively to called functions, beyond the lexical body of an ordinary macro. A dynamo receives argument types, obtains IR, rewrites operations, and recompiles. Its example transforms multiplication used inside a reduction into addition; `recurse!` propagates the transform. Stateful callable contexts can carry transformation/runtime state.

This gives a useful implementation family: run existing code through a context-specific compiler transform instead of mutating a globally shared function definition. It also illustrates a tradeoff. Working on IR makes operations and specialization convenient, but authored lexical names and source-level type narrowing are not automatically available in a usable capture API. It is a compiler toolkit, not a polished test runner or a cardinality-checked source selector.

**Borrow:** use compiler context as an explicit execution parameter; keep recursion and fallback policy visible; do not conflate IR-level power with reliable source-level capture semantics.

Primary sources:

- https://fluxml.ai/IRTools.jl/latest/dynamo/ — dynamo model, recursive transformation and examples .
- https://fluxml.ai/IRTools.jl/latest/ — IR manipulation overview .

## 7. Actual Julia mock tools — SimpleMock, Mocking, Pretend, Mock

**SimpleMock.jl** packages Cassette-style contextual interception as `mock(+) do ... end`, including checks such as `called_once_with`; it can observe/replace calls nested inside existing functions without a marker at every target. This is a closer *testing product* precedent than Cassette itself, but targets matching function operations, not one typed syntax occurrence and arbitrary caller locals. Its README records compatibility caveats; do not present it as a guaranteed current drop-in solution.

**Mocking.jl** uses application call-site `@mock` markers and test-side `@patch` plus `apply(patch) do ... end`. Its FAQ explicitly distinguishes ordinary calls in patches (original implementation) from `@mock` calls (intercept again). **Pretend.jl** uses `@mockable` definitions, callback-scoped patches, spies, and `Fallback()` for conditional call-through. A first-party 2025 **Mock.jl** announcement demonstrates `with_mocked(old => new) do ... end` and `@original` with no annotations, using method-table replacement; it acknowledges recursion/builtin limitations. These models distinguish call-site instrumentation, definition transformation, and global method replacement.

Sources:

- https://github.com/JuliaTesting/SimpleMock.jl/blob/master/README.md — primary source fetched via connector.
- https://github.com/JuliaTesting/Mocking.jl/blob/main/docs/src/index.md and https://github.com/JuliaTesting/Mocking.jl/blob/main/docs/src/faq.md — fetched via connector.
- https://github.com/tk3369/Pretend.jl/blob/master/README.md — fetched via connector.
- https://discourse.julialang.org/t/mock-jl-mocking-any-function-without-annotations/133918 — first-party author announcement, historical capability rather than verified current maintenance .

## 8. NodeProf — useful backend precedent, not equivalent replacement

NodeProf instruments GraalJS AST execution and offers Jalangi-style callbacks, source inclusion/exclusion, and expression/statement events. Crucially, its own `Difference.md` explicitly says Jalangi's callback-result replacement (`{result: ...}`) is not supported. Therefore an attractive general-purpose instrumentation backend cannot automatically be described as a mock implementation. Underlying Truffle supports additional control features, covered in the companion language-and-scope catalog; capabilities of the engine must not be attributed automatically to a particular frontend.

Sources: https://github.com/Haiyang-Sun/nodeprof.js/blob/master/README.md ; https://github.com/Haiyang-Sun/nodeprof.js/blob/master/Difference.md ; https://github.com/Haiyang-Sun/nodeprof.js/blob/master/Tutorial.md — fetched via GitHub connector. Primary paper record: https://research.vu.nl/en/publications/efficient-dynamic-analysis-for-nodejs/ .

## 9. aspectlib — Python around advice with explicit proceed/return

aspectlib can externally weave functions/classes/instances/builtins, with regex method selection and rollback/context-manager cleanup. Generator-based advice yields `Proceed` (optionally with new arguments) or `Return(value)`; it can skip or repeat the original. This gives direct precedent for a replacement handler with original access and automatic teardown. Its granularity is callable boundaries with already evaluated arguments; it does not supply arbitrary caller lexical captures or one AST occurrence. Restoration on exit should not be equated with proven asynchronous context isolation.

Source: https://python-aspectlib.readthedocs.io/en/latest/reference/aspectlib.html .

## 10. CPython tracing, monitoring, writable frames, and frame evaluators

`sys.settrace` and `sys.monitoring` provide programmable execution events, but a trace callback's return value is not a substitute for the application's return value. Observing a return event does not itself skip an expression. PEP 667 matters because `frame.f_locals` is now a write-through proxy in optimized scopes: the old blanket claim that Python cannot modify paused locals is incorrect. PEP 523 permits replacing CPython's frame evaluator through a C-level integration and explicitly discusses breakpoint injection via bytecode rewriting. That is powerful implementation infrastructure, not a ready typed test API. PEP 558 was withdrawn in favor of 667 and should not be cited as the accepted design.

Sources:

- https://docs.python.org/3/library/sys.html — tracing .
- https://docs.python.org/3/library/sys.monitoring.html — monitoring .
- https://peps.python.org/pep-0667/ — writable locals .
- https://peps.python.org/pep-0523/ — frame evaluation .

## 11. Ruby TracePoint and Binding

Ruby provides programmable line/call/return events with access to a `Binding`, which retains the execution context and supports evaluating code and accessing/changing locals. TracePoint activation can be scoped to a block and narrowed to code, line, and thread. It also explicitly controls reentrancy. These are good precedents for programmable breakpoints with local context and narrow activation. The documented TracePoint API is not a general instruction to skip any selected expression or replace its result by returning from the callback; it must not be described as that. It also does not supply a source-program-derived static capture contract.

Sources: https://ruby-doc.org/core/TracePoint.html  and https://docs.ruby-lang.org/en/master/Binding.html .

## 12. Emacs Lisp advice and temporary function rebinding

Emacs `advice-add` around advice receives the original function and arguments and can wrap, skip, or repeat it. `cl-letf` can temporarily replace a symbol's function binding with automatic restoration. This is old, concrete precedent for scoped mocking and original access. It works at named function bindings/advised function boundaries, not arbitrary lexically captured values at one source expression; lexical variable names do not become ordinary symbol-value lookups. Useful lessons are predictable advice order, call-through multiplicity, and distinguishing dynamic lifetime from global symbol replacement.

Sources: https://www.gnu.org/s/emacs/manual/pdf/elisp.pdf ; https://www.gnu.org/software/emacs/manual/html_mono/cl.html ; https://www.gnu.org/software/emacs/manual/html_node/elisp/Lexical-Binding.html .

## 13. Common Lisp conditions and restarts

Conditions and restarts let dynamically scoped handlers choose a recovery or alternate value while the computation's recovery context still exists. Restarts can be inspected and invoked programmatically, including use-value/store-value patterns. This is conceptual precedent for programmable continuation/recovery and nested dynamic scope. The important boundary is that application code or a library establishes the restarts and signals conditions; it does not by itself allow an external test to select any unannotated AST expression. The algebraic-effect comparison belongs to this family without implying an equivalent test tool.

Sources: https://www.lispworks.com/documentation/HyperSpec/Body/m_rst_ca.htm ; https://www.lispworks.com/documentation/HyperSpec/Body/09_adb.htm ; https://www.lispworks.com/documentation/HyperSpec/Body/f_invo_1.htm ; https://www.lispworks.com/documentation/HyperSpec/Body/r_store_.htm .

## 14. Racket impersonators, chaperones, and application macros

Racket impersonators and chaperones interpose on procedure and data operations. Chaperones preserve stronger relationships to the original value; impersonators allow broader modification. Ordinary `impersonate-procedure` wrappers preprocess arguments and can postprocess results, but the wrapped procedure is still called: do not describe this API as unrestricted around advice that can omit the original. Separately, the expander's `#%app` hook and custom languages can rewrite applications. These are valuable language-design precedents, requiring wrapping/expansion control rather than exposing an external typed selector on arbitrary existing code.

Sources: https://docs.racket-lang.org/reference/chaperones.html ; https://docs.racket-lang.org/reference/application.html ; https://docs.racket-lang.org/reference/syntax-model.html .

## 15. Vitest, Jest, rewire, dependency mocking

Vitest's documentation explicitly states that ordinary mocking cannot affect direct same-file calls to another function in that file. Jest already provides `mockFn.withImplementation(fn, callback)` for temporary behavior inside synchronous/asynchronous callbacks. The callback API shape therefore is established, but callback restoration alone does not prove per-async-context isolation. rewire reaches otherwise private module bindings with `__get__`, `__set__`, and `__with__`, but explicitly cannot change variables inside functions. These are the useful comparisons: execution-points changes the reachable boundary from imports/module bindings to selected internal operations and their surrounding lexical state.

Sources: https://vitest.dev/guide/mocking/modules ; https://jestjs.io/docs/mock-function-api ; https://github.com/jhnns/rewire ; https://github.com/theKashey/rewiremock .

## 16. pytest monkeypatch and unittest.mock

pytest monkeypatch and Python's unittest.mock replace namespace attributes, dictionary/environment state, or dependency bindings with automatic restoration/context-manager scope. They are strong precedent for useful mock lifetimes and cleanup, but do not directly expose arbitrary optimized frame locals or one expression inside an unmodified function. They clarify why merely adding a context manager is not the new contribution.

Sources: https://docs.pytest.org/en/stable/how-to/monkeypatch.html ; https://docs.python.org/3/library/unittest.mock.html .

## 17. PHP uopz — engine-level callable replacement

PHP's uopz extension can set a function/method's return value or execute a replacement closure in place of the original. The closure may call the original function. This is a concrete runtime-level alternative to ordinary dependency injection, including builtins in documented examples. Its granularity remains callable definitions; it does not select one source occurrence or expose arbitrary caller locals. It requires the engine extension and explicit setup/teardown rather than supplying the proposed typed source schema.

Source: https://www.php.net/manual/en/function.uopz-set-return.php .

## 18. Erlang Meck — module replacement and observable call history

Meck mocks modules, permits function-level expectations and conditional pass-through to the original, tracks calls/returns/exceptions, and validates expected behavior. Its lifecycle is linked to the creating Erlang process for cleanup if that process crashes. This shows how expectations and crash-safe teardown can accompany replacement as one testing abstraction. Module replacement and process-linked cleanup are not arbitrary source-expression replacement or necessarily process-local visibility of mocked code; those must not be conflated.

Source: https://meck.hexdocs.pm/readme.html .

## Further leads checked, not necessary for main write-up

- **Clojure `with-redefs` / `binding`:** useful for the distinction between temporary root-Var replacement (other threads can observe it) and thread-local dynamic binding. Official API source: https://clojure.github.io/clojure/clojure.core-api.html#clojure.core/with-redefs .
- **Lua debug hooks and locals:** official manual https://www.lua.org/manual/5.4/manual.html#pdf-debug.sethook and #pdf-debug.setlocal . Event hooks plus local/upvalue access are debugger primitives, not a packaged typed interception tool. See also the language-and-scope catalog.
- **AspectML / AspectScheme:** AspectScript's related-work section gives strong historical leads for typed first-class pointcuts and lexical/dynamic deployment. See the companion language-and-scope catalog for AspectML.

## Cross-cutting recommendations derived from this branch

1. **Make boundary semantics the first comparison axis.** Operation replacement after operands, local assignment replacement after RHS, and whole-expression replacement before operands are different. Include a side-effecting-argument example when documenting execution-points.
2. **Keep compile-time selection separate from runtime conditions and activation scope.** Aran separates static AST pointcuts from runtime advice; AspectScript separates runtime pointcuts from deployment policy. A static selector should not silently become a dynamic trace selector.
3. **Do not equate cleanup with isolation.** Ptera's ContextVar is a closer analogue to ALS than globally patching then restoring a function. Escaped tasks, reentrancy, and nested original calls deserve explicit policies.
4. **Add observations and hit expectations.** Ptera and Meck demonstrate value beyond mocking: assert private invariants and fail if an intended point is never reached.
5. **Specify `original()` precisely.** Can it be called more than once? Does it preserve nested replacements? Does calling an already evaluated operation differ from rerunning an unevaluated expression? Cassette and AspectScript expose why this matters.
6. **Position the types carefully.** Several tools already have AST selectors, local access, runtime substitutions, or scoped activation. The promising distinction is authoring statically checked tests against the actual selected code's lexical/type environment, with practical source-change diagnostics. This is a defensible product direction, not a verified first-ever claim.

---

[Return to the research synthesis](prior-art.md).
