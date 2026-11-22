# Language integration, typed selection, and scope prior art

Research date: 2026-11-22. This catalog complements the [managed](prior-art-managed.md), [dynamic-language](prior-art-dynamic.md), and [debugger/instrumentation](prior-art-debugger.md) catalogs. The baseline is execution-points commit `8c339ed2f7fb2d0e1e370ed16117369f90b9c17d`. These are documented precedents and design comparisons; the surveyed tools were not all installed or executed.

## 1. GraalVM Truffle instrumentation

Truffle provides a particularly close cross-language mechanism. An instrument attaches to filtered, instrumentable guest-language AST nodes. `onEnter` runs before the node executes; an instrument can throw an unwind object and return a replacement value from `onUnwind`. Reentry is another explicit outcome. This is stronger evidence for pre-node intervention than function-entry hooks, which usually receive already evaluated arguments.

`NodeLibrary.getScope(node, frame, nodeEnter)` exposes variables visible at the selected location, including enclosing scopes. The entry/exit flag matters because a node may introduce bindings. The returned scope is valid only while guest execution is suspended. Language implementations must expose instrumentation and scope information: this is not an automatic capability of every runtime or arbitrary native Node.js program.

This supplies an architecture precedent for separating source selection, runtime context, and execution control. It does not provide execution-points' particular inferred TypeScript test contract or ALS lifetime policy. Its early-return/reentry API is also not the same abstraction as an unrestricted reusable `original()` thunk.

Sources: [EventContext](https://www.graalvm.org/truffle/javadoc/com/oracle/truffle/api/instrumentation/EventContext.html), [ExecutionEventListener](https://www.graalvm.org/truffle/javadoc/com/oracle/truffle/api/instrumentation/ExecutionEventListener.html), [NodeLibrary](https://www.graalvm.org/truffle/javadoc/com/oracle/truffle/api/interop/NodeLibrary.html), [instrumentation tutorial](https://www.graalvm.org/latest/graalvm-as-a-platform/implement-instrument/).

## 2. GraalVM Insight

Insight exposes instrumentation through scripts, including JavaScript. Its `enter` and `return` handlers receive a context and a frame; filters select roots, statements, expressions, source paths, and locations. Scripts can read or modify available locals. The manual demonstrates `ctx.returnNow(...)` in an entry handler to bypass a function body, and in a return handler to change a computed result.

This is a concrete, usable relative of programmable breakpoints, not just a compiler API. Distinguish root interception from an expression event: bypassing a function body does not undo the caller's operand evaluation. The documented examples do not establish the same reusable original-expression continuation or static lexical capture inference as execution-points.

Source: [Insight manual](https://www.graalvm.org/latest/tools/graalvm-insight/manual/).

## 3. ABAP Unit test seams

ABAP has dedicated `TEST-SEAM ... END-TEST-SEAM` and `TEST-INJECTION ... END-TEST-INJECTION` language constructs. Application code declares a named statement region. A test supplies alternative statements, and the original region executes when no injection is active. SAP explicitly documents access to variables in the seam's scope and activation through the end of the test method; setup can install shared injections.

This is direct language-level prior art for replacing a piece of implementation from a test while retaining its local context. Its main tradeoff is visible authored seams. Documentation also constrains nesting and compilation-unit placement. It is not an externally selected arbitrary-expression API, and the cited documentation does not establish a generic original-region continuation.

For execution-points, a useful product description is externally selected test seams with inferred contracts. The phrase describes a benefit without claiming that test-specific code-region substitution is new.

Sources: [SAP dependency-management guide](https://help.sap.com/docs/abap-cloud/abap-development-tools-user-guide/managing-other-dependencies-with-abap-unit), [TEST-SEAM](https://help.sap.com/docs/abap-cloud/abap-keyword/test-seam), [TEST-INJECTION, versioned documentation](https://help.sap.com/doc/abapdocu_752_index_htm/7.52/en-US/abaptest-injection.htm), [SAP sample catalog](https://github.com/SAP-samples/abap-cheat-sheets/blob/main/14_ABAP_Unit_Tests.md).

## 4. AspectML and typed advice

AspectML research combines polymorphic, first-class pointcuts with statically checked advice and a type-inference algorithm extending Hindley-Milner inference. Its translation uses typed control-flow labels and checks relationships between pointcuts and their join points.

This rules out a broad claim that type-safe pointcuts or inferred advice are new. The relevant distinction is integrating such capabilities into ordinary TypeScript and its existing editor/compiler, with contracts derived from selected application expressions. The language's type theory is useful when considering unions of possible targets, generic operations, and which substitutions are valid. It does not establish the exact source-file-indexed API or lexical-capture serialization used here.

Source: [Dantas, Walker, Washburn, Weirich, AspectML](https://www.cs.princeton.edu/~dpw/papers/aspect-toplas.pdf).

## 5. Context-oriented programming and asynchronous layer activation

Context-oriented programming organizes alternative behavior into dynamically activated layers. ContextJS applies this in JavaScript with explicit layer scopes and `proceed` through layered methods. Its unit of adaptation is generally a method or object behavior, rather than an arbitrary expression with caller locals.

The authors' Zone-based Layer Activation work addresses a particularly relevant problem: a synchronous dynamic scope breaks when asynchronous work suspends and resumes. Layers can disappear from intended descendants or leak into unrelated execution. Their implementation extends ContextJS with an activation context covering logically connected asynchronous operations. ADEjs research explores related activation across different asynchronous mechanisms.

This is direct prior art for treating asynchronous activation as a language/runtime semantic issue. A scope-shaped API alone does not solve it. Decide whether pending descendants inherit a replacement after the action returns, whether an escaped callback carries the context, and which events end ownership.

Sources: [ContextJS and layer composition, author's dissertation](https://lively-kernel.org/publications/media/Lincke_2014_EvolvingToolsInCollaborativeSelfSupportingDevelopmentEnvironment_PRINT.pdf), [Zone-based Layer Activation, author demo](https://onsetsu.github.io/area51/experiments/github-access.html), [author's project description](https://lively-kernel.org/lively4/onsetsu/projects.html), [ADEjs paper](https://www.pleger.cl/cv-pleger/papers/fukudaAl-COP2022.pdf).

## 6. Elixir Mox

Mox attaches expectations to an owning process. Private mode allows concurrent tests using the same mock definitions; explicit allowances authorize other processes to consume an owner's expectations. Its documentation distinguishes this from global mode and discusses waiting for asynchronous expectations before verifying them.

This is a strong precedent for ownership, propagation, and completion. It mocks declared behaviours rather than arbitrary hidden operations, so it is not a replacement for expression instrumentation. Borrow the explicit answer to who owns a replacement, which descendants may use it, and when hit expectations are verified.

Source: [Mox documentation](https://mox.hexdocs.pm/Mox.html).

## 7. Swift Dependencies and task locals

Swift Dependencies uses task-local values and `withDependencies` scopes to supply alternative dependencies. The lifecycle documentation carefully explains that child tasks can inherit overrides beyond the enclosing closure, while arbitrary escaping callbacks do not necessarily carry them. Dependency wrappers may capture context for later use.

This is highly relevant to the runtime contract, even though the application must access dependencies through the library's mechanism. It shows why callback lifetime, task inheritance, and later object use need distinct rules. ALS is one implementation ingredient; it does not choose the product's ownership semantics.

Source: [Swift Dependencies lifetime documentation](https://github.com/pointfreeco/swift-dependencies/blob/main/Sources/Dependencies/Documentation.docc/Articles/Lifetimes.md).

## 8. Algebraic effects: Koka and OCaml

Algebraic effects let a computation request an operation whose meaning is supplied by a dynamically enclosing handler. A handler can supply a result, fail, or use a continuation according to the language's rules. This resembles running code under alternative semantics, but generally requires code to perform modeled effects rather than letting an external test choose an arbitrary hidden expression.

Koka distinguishes general control operations from tail-resumptive operations, making continuation capability explicit. OCaml's effect continuations are one-shot and a repeated resumption raises an error. These are useful references for the unresolved repeat-call behavior of `original()`.

The analogy has a limit: a captured continuation represents the remainder of a computation, while execution-points' thunk reevaluates a selected expression in its lexical closure. They should not be described as the same mechanism.

Sources: [Koka manual](https://koka-lang.github.io/koka/doc/manual.html), [OCaml 5.2 reference manual, effect handlers](https://ocaml.org/manual/5.2/ocaml-5.2-refman.pdf).

## 9. Effect libraries and test environments

Effect-TS, Scala ZIO, and OCaml Eio supply controllable test services/resources such as clocks, random sources, I/O, and mocks. They demonstrate the value of a test execution environment and deterministic alternatives that compose with application code. Their key precondition is that the relevant effects pass through modeled services/resources.

These are adjacent product alternatives, not equivalent external selectors. A generic execution-point tool could reach code that did not use the effect system, but would also bypass the explicit dependencies that make effectful programs easier to reason about. Prefer an existing declared service seam when it already expresses the scenario; use internal expression intervention where it adds needed reach.

Sources: [Effect TestClock](https://effect.website/docs/v4/testing/testclock), [ZIO test services](https://zio.dev/reference/test/services/), [Eio mock resources](https://ocaml.org/p/eio/1.5/doc/eio.mock/Eio_mock/index.html).

## 10. Clang AST matchers and Transformer

Clang provides a typed matcher vocabulary over C/C++ syntax and semantic types. Matchers can select a binary operator, particular operands, calls, declarations, and enclosing structures, then bind matching nodes. Transformer combines matching with source edits and diagnostics.

These are selection/transformation building blocks, not a scoped mocking tool. They nevertheless offer concrete API precedents for fluent navigation, predicates, source-range previews, and distinguishing syntactic identity from semantic identity. The compiler also exposes cases where similar source syntax denotes different operations, such as built-in versus overloaded operators.

Sources: [AST matcher tutorial](https://clang.llvm.org/docs/LibASTMatchersTutorial.html), [Transformer tutorial](https://clang.llvm.org/docs/ClangTransformerTutorial.html).

## 11. Spoon and Scala quoted reflection

Spoon's Java metamodel supports typed navigation, filtering predicates, chained queries, and processing of expressions. Scala 3 quoted reflection exposes typed trees, symbols, source positions, traversers, and transforms inside macro/compiler integration.

They reinforce that an imperative visitor and fluent navigation are established ways to select code. The stronger authoring opportunity in execution-points is that the available function names, operation names, local names, and result types come from the actual target files and participate in the test's normal typechecking. Selection still needs runtime validation where a general callback's behavior cannot be proved statically.

Sources: [Spoon navigation/query](https://spoon.gforge.inria.fr/filter.html), [Scala 3 reflection](https://docs.scala-lang.org/scala3/reference/metaprogramming/reflection.html).

## 12. Mutation testing and Stryker

Mutation testing changes selected operators or expressions and checks whether tests detect the changes. Stryker's mutation switching generates alternative branches controlled by an active-mutant setting. Its static-mutant documentation explains why code executed during module initialization behaves differently from code reached after a test activates an alternative.

This is close implementation prior art for selecting code, instrumenting once, and changing behavior during tests. The purpose differs: mutation testing assesses test sensitivity through generated perturbations; execution-points lets a test author choose scenario-specific behavior and inspect locals. The initialization problem is still directly applicable: a replacement cannot affect an expression already evaluated during import.

Source: [Stryker static mutants and mutation switching](https://stryker-mutator.io/docs/mutation-testing-elements/static-mutants/).

## 13. Filibuster and distributed execution indexing

Filibuster performs systematic fault injection at service boundaries. Distributed execution indexing identifies dynamic RPC occurrences across executions, including loops, indirection, and concurrent scheduling. It distinguishes a source call site from the particular request occurrence that should fail.

This is useful for a future scenario API. A static `nth` selector identifies one syntax occurrence; a dynamic hit index identifies one execution of that occurrence. They need separate names and semantics. Source hashes alone do not identify a request, iteration, or causally related execution.

Sources: [Distributed Execution Indexing](https://arxiv.org/abs/2209.08740), [Service-Level Fault Injection Testing](https://christophermeiklejohn.com/publications/filibuster-socc-2021.pdf).

## 14. Lua debugging hooks

Lua's debugger API offers call, return, line, and instruction-count hooks. `debug.getlocal` and `debug.setlocal` inspect and change live locals by stack level and variable index. This is an additional language-level precedent for programmable execution events and local access.

The callback's return is not a generic substitute for an arbitrary expression, and the API does not automatically provide a typed test contract. Hook events, writable state, and control-flow replacement are separate powers.

Sources: [Lua reference manual](https://lua.org/manual/5.3/manual.html), [authors' explanation of local-variable access](https://www.lua.org/pil/23.1.1.html).

---

[Return to the research synthesis](prior-art.md).
