# Prior art: JVM, .NET, aspect-oriented systems, and fine-grained instrumentation

Research date: 2026-11-22. Evidence is from documentation, source inspection where stated, and primary papers; these tools were not executed. Comparison target: execution-points main `8c339ed2`, typed `select` and `fromFile`, inferred result/local contracts, expression thunk before receiver/argument evaluation, explicit replacement callback scopes.

## Ranked findings

1. **MixinExtras / Sponge Mixin:** strongest modern practical analogue for selecting an operation inside another method, capturing surrounding locals, wrapping or skipping the operation, and composing wrappers. Its operand evaluation boundary differs from ours.
2. **Javassist ExprEditor:** long-standing direct expression replacement API with access to surrounding locals and an original-operation primitive. Embedded replacement source strings rather than inferred callback contracts.
3. **Byteman + BMUnit:** closest established testing product to programmable breakpoints and fault injection with local state. Distinguish enclosing-method early return from replacing an inner expression.
4. **Bugdel + FGA/Enfasis:** strongest historical research ancestors for debugger-like points, local-variable access, AST paths, editor feedback, and fine-grained advice.
5. **C# / Roslyn Interceptors:** strongest compiler-native analogue for typechecked exact call-site replacement and generated-location identity, but only ordinary method invocations and no arbitrary caller-local capture.

Harmony, AspectJ, Pose, PROSE and DiSL are additional important references, each covering a different design dimension.

## 1. Sponge Mixin + MixinExtras (Java bytecode, especially game modding)

Official sources:

- https://github.com/LlamaLad7/MixinExtras/wiki/WrapOperation
- https://github.com/LlamaLad7/MixinExtras/wiki/Expressions
- https://github.com/LlamaLad7/MixinExtras/wiki/Local
- https://github.com/SpongePowered/Mixin/wiki/Advanced-Mixin-Usage---Callback-Injectors

`@WrapOperation(method=..., at=@At(...))` selects an instruction inside a target method; a Java handler receives its operands plus `Operation<ReturnType>`. Calling `original.call(...)` performs the wrapped operation; returning another value can bypass it. Supported operations include method calls, fields, construction, comparisons, array accesses, casts and instanceof, depending on injection point. Wrappers chain rather than fighting like outright redirects. The original operation passed to an outer wrapper can represent another wrapper, not necessarily the unmodified program.

`@Expression` selects Java-like patterns over bytecode; `@Definition` resolves names. This is not source-AST matching and copying arbitrary source is insufficient. The documented expression matcher does not cover all jump-containing expressions (`&&`, ternary, etc.). `@ModifyExpressionValue` changes a computed expression result; that is distinct from suppressing its evaluation.

`@Local` captures surrounding local values by type, ordinal, or LVT index. Ambiguous type selection is an error. Mutable reference variants (`LocalRef<T>`, `LocalIntRef`, etc.) also allow rebinding original locals. Our read-bindings-only policy intentionally chooses a narrower capability.

Operand boundary: the documented transformed shape passes receiver and arguments into the handler before it invokes `original()`. Thus the handler can suppress the selected operation, but ordinary argument side effects have already happened. This conclusion follows from the documented transformation; do not conflate it with our whole-expression thunk.

Safety/selection: Mixin injectors support `require` and development-time `expect` match counts, plus injector groups with min/max bounds. These are useful precedents for failing on lost or changed matches and offering deliberate alternatives. No built-in per-test AsyncLocalStorage-style isolation was established in these sources. It is generally installed instrumentation with application-controlled conditions.

Takeaways: operation wrappers, explicit continuation composition, capture disambiguation, cardinality checks, source-highlight tooling. Do not claim inferred source-wide TypeScript contracts exist here: handlers are manually declared and weaving validates compatibility.

## 2. Javassist ExprEditor (Java)

Sources:

- https://www.javassist.org/tutorial/tutorial2.html
- https://www.javassist.org/html/javassist/expr/MethodCall.html

`CtMethod.instrument(new ExprEditor(){ edit(MethodCall call) {...} })` enumerates expressions in a method body. `call.replace(sourceText)` replaces the selected caller-side invocation with compiled Java source. The expression object provides the containing method, callee, signature, source file and source line. `$proceed`, `$_`, `$0` and argument variables expose the original operation, result, receiver and arguments. Surrounding locals can be used in replacement source when the target class contains local-variable debug metadata (`-g`). `insertAt` also permits line-based injection and local access.

This is direct prior art for external expression selection + local capture + original-operation access without editing application source. Selection/rewriting is a toolkit task, not an already polished scoped testing API. Replacement snippets are strings compiled by Javassist, with its supported Java subset and compilation errors, rather than normal editor-inferred callbacks.

The method-invocation opcode is replaced; receiver/arguments are inputs to that opcode. Therefore skipping `$proceed` does not retroactively skip operand evaluation (inference from the bytecode/API boundary). No independent automatic test scope or async isolation was established.

## 3. Byteman + BMUnit (Java testing/fault injection)

Sources:

- https://downloads.jboss.org/byteman/4.0.28.1/byteman-programmers-guide.html
- https://developer.jboss.org/docs/DOC-52953 (BMUnit tutorial)
- https://developer.jboss.org/docs/DOC-17315 (fault injection tutorial)
- https://byteman.jboss.org/index.html

Rules specify a class/method/location, bindings, condition and actions. Locations include entry, exit, line, local/field read/write, invoke, allocation, monitor operations and throws. Debug metadata allows symbolic surrounding-local access; assignment can update actual application bindings. Rules are checked for type compatibility. Helpers provide counters and rendezvous for deterministic fault/concurrency scenarios.

Critical semantic distinction: `RETURN` returns from the **enclosing trigger method**. It is not an inner expression replacement continuation. `AFTER INVOKE` can replace the already-computed call result by assigning `$!`; the call has happened. `AT INVOKE` exposes the recipient/arguments already on the operand stack through `$@`, so that point is after operand evaluation.

BMUnit integrates rules with JUnit/TestNG. `@BMRule` and scripts are installed before a test and unloaded after it. That is lifecycle scoping, not evidence of independent simultaneous contexts inside one JVM. The docs show conditions based on invocation counters, including failing a particular numbered call.

Takeaways: distinguish static match cardinality from dynamic hit count; conditions, fault schedules, timing control, rule validation, automatic cleanup. Treat Byteman as a major product predecessor, not merely a debugger or mocking library.

## 4. Harmony (C#/.NET IL patching)

Sources:

- https://harmony.pardeike.net/v2/articles/patching-transpiler.html
- https://harmony.pardeike.net/v2/articles/patching-transpiler-matcher.html
- https://harmony.pardeike.net/v2/articles/patching-injections.html
- https://harmony.pardeike.net/v2/articles/execution.html

Prefix methods can inspect/edit original method arguments, supply a result and skip the method. Postfix/finalizer phases handle subsequent behavior. Those high-level patches operate on method boundaries, not arbitrary source expressions. `__state` is patch-created state shared between prefix/postfix, **not access to arbitrary original locals**; `___field` accesses original fields.

Transpilers operate during replacement-method generation, transforming IL instructions; inserted code then executes on each hit. `CodeMatcher` is a cursor with instruction predicates, insertion/removal/replacement and failure checks. The official example explicitly replaces a particular `Kill()` call inside `Apply()` because patching `Kill()` globally would affect unwanted callers. This is strong call-site-specific prior art. Arbitrary local loads are possible at IL level, but users must manage slots/stack/type correctness; there is no source-inferred capture schema.

Harmony chains patches with precedence. A false-returning prefix skips the original and certain other prefixes; it does not simply erase all downstream phases. Installation/uninstallation is not equivalent to callback-context isolation. Borrow match failure diagnostics and composition rules, while avoiding IL-level fragility in user code.

## 5. C# / Roslyn Interceptors

Sources:

- https://github.com/dotnet/roslyn/blob/main/docs/features/interceptors.md
- https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/source-generator-errors

Source generators inspect invocation syntax and call `SemanticModel.GetInterceptableLocation`. They emit a replacement method marked with `InterceptsLocation`; the compiler redirects that precise call. The documented encoding includes a content checksum, syntax position and display filename, allowing compiler validation of location identity. Signature matching includes receiver, result, argument types/ref kinds, generic arity and constraints, with documented nullability rules. Duplicate interception is diagnosed.

This is particularly relevant to execution-points' compiler-integrated type/schema direction. However, documented support is ordinary member-method calls, not constructors, properties, operators, local functions or delegate usages. The callback receives the call's arguments/receiver, not arbitrary surrounding locals. It is compilation-time replacement, not dynamic test-scoped behavior. Normal call argument evaluation remains (inference from substitution model). Dynamic activation would need an additional runtime dispatcher.

Takeaways: checksum-based target identity, precise compiler errors, matching signatures, generic substitution, and IDE visibility. Avoid claiming current feature stabilization/version status beyond what the source says; the feature document contains historical commentary.

## 6. AspectJ (Java)

Sources:

- https://eclipse.dev/aspectj/doc/latest/progguide/language.html
- https://eclipse.dev/aspectj/doc/released/progguide/starting-aspectj.html
- https://eclipse.dev/aspectj/doc/latest/faq/faq.html

Pointcuts select join points; before/after/around advice executes there. `call` selects caller-side invocation sites, while `execution` selects executing method bodies; lexical `within`/`withincode` and dynamic `cflow` scope matches. Around advice may return a substitute or invoke `proceed()`; precedence determines which next advice runs. Context exposes receiver, target and arguments.

The official FAQ explicitly rejects arbitrary source-line expressions as join points. Arbitrary caller-local bindings are not exposed by the standard model. The guide states method-call before advice runs after arguments are evaluated. Do not say 'this is just AspectJ' without these distinctions. No authored application annotations are inherently required; compile/load-time weaving applies aspects separately.

Takeaways: vocabulary (join point, pointcut, advice), lexical versus dynamic scope, and explicit continuation precedence. Aspects have a long history of use for development/testing, so general external behavior injection is not new.

## 7. Bugdel (Usui and Chiba, APSEC 2005)

Primary paper: https://static.csg.ci.i.u-tokyo.ac.jp/papers/06/usui-asian-workshop.pdf .

An Eclipse aspect-oriented debugging environment with GUI-selected points/advice. It adds source-line and all-lines-of-method points and permits advice to read surrounding locals/private fields. The paper describes warnings when a referenced variable is absent, visual markers at matching locations, and reflective file/line/variable metadata. Debug advice is woven into class files. It demonstrates breakpoint emulation through injected advice that displays state and waits for user continuation, without requiring normal JVM debug mode.

This predates the current idea's 'programmable breakpoint with locals' formulation very directly. The paper focuses on debugging/tracing, not typed unit-test callback scopes, async isolation or a general lazy expression replacement contract. Do not attribute a fully general `original()` substitution API without further evidence.

Borrow editor-selected points, previews of matches, local-name diagnostics, and the clear distinction between production encapsulation policy and test/debug instrumentation needs.

## 8. PROSE (ETH dynamic AOP, 2001–2008)

Primary project page: https://prose.ethz.ch/ .

The earliest implementation used the JVM debugger interface to turn join points into stop points, then ran advice externally with stack-frame and argument context. Later versions moved to native JIT hooks and then dynamic bytecode instrumentation/method replacement. Replacements are ordinary Java classes and can compose, reorder, be withdrawn, or call replaced implementations. Eclipse tools show where adaptations apply.

This is a particularly direct historical answer to the user's initial debugger-mechanism idea. It also documents the same architectural move from debugger callbacks toward instrumentation for practical execution. PROSE is adaptation infrastructure rather than a modern test-runner product; the documented new-version granularity is method replacement. Do not infer arbitrary current expression-local support from the early debugger implementation.

## 9. Fine-Grained Aspects / Enfasis (2008/2010)

Primary sources:

- Juarez-Martinez and Olmedo-Aguirre, *A Join Point Model for Fine-Grained Aspects*, ECC 2008: https://www.wseas.us/e-library/conferences/2008/malta/ecc/ecc17.pdf .
- *Run-Time Assertion Checking with Enfasis*, 2010: https://www.scielo.org.mx/scielo.php?pid=S1405-55462010000100004&script=sci_arttext (full page timed out, abstract retrieved).

FGA defines AST path expressions into method bodies, statements and expressions, including local reads/writes and positional filters. Advice can access context locals. The implementation extends Javassist and correlates source structure with bytecode and local-variable/line tables; around advice wraps selected load/store instructions. The paper explicitly motivates white-box testing and fine-grained genericity.

Important qualification: its formal model uses labels marking source positions (which can be hidden in comments), and the implementation depends on source/bytecode correspondence and metadata. Do not present it as exactly the same marker-free API. Enfasis later applies the idea to runtime assertions over locals and claims non-invasive source instrumentation. The modern contribution in execution-points could be typed, ergonomic discovery and integration, not the invention of AST-selected local-aware advice.

## 10. DiSL (AOSD 2012)

Primary paper: https://d3s.mff.cuni.cz/legacy/publications/download/Marek-aosd12.pdf .
Project description: https://research.spec.org/tools/overview/disl/ .

DiSL provides an extensible join-point model where custom bytecode regions are selected by markers, scopes and static-analysis guards. Java snippets are inlined at instrumentation sites with access to static/dynamic context and synthetic local variables for communication. It was designed to improve the expressiveness and efficiency of instrumentation over general AspectJ.

It is dynamic-analysis infrastructure, not directly a mock replacement API. The paper lists absence of around advice as a limitation; do not equate arbitrary instrumentation placement with arbitrary control-flow substitution. Borrow the separation of selection, context extraction and execution snippets, plus the ability to extend supported operation kinds without exposing raw bytecode to everyone.

## 11. Byte Buddy (Java)

Sources:

- https://javadoc.io/static/net.bytebuddy/byte-buddy-dep/1.18.11-jdk5/net/bytebuddy/asm/MemberSubstitution.html .
- https://javadoc.io/static/net.bytebuddy/byte-buddy/1.18.0/net/bytebuddy/asm/Advice.Local.html (search retrieved official javadoc, subsequent direct fetch failed).
- https://github.com/raphw/byte-buddy/issues/1745 (maintainer discussion).

`MemberSubstitution` matches and replaces field accesses, method invocations and constructor calls inside method bodies. It supports strict versus relaxed type resolution, replacement chains and failing on no match. `Advice` handles method entry/exit and can skip a body via `skipOn`.

Critical false friend: `@Advice.Local` creates **new instrumentation-local variables** shared between entry/exit advice. It is not a mechanism to capture arbitrary locals already inside the application method. Lower-level bytecode transformations can do more, but the familiar annotation alone does not satisfy our capture requirement. This is infrastructure behind instrumentation-based tooling, with runtime/weave-time validation rather than source-indexed callback inference.

## 12. Pose (C#/.NET)

Primary repository: https://github.com/tonerdo/pose .

`Shim.Replace(...).With(...)` describes a method replacement; `PoseContext.Isolate(action, shims...)` is explicit callback scoping. The project uses managed Reflection.Emit to rewrite execution in memory, including static/nonvirtual methods, without authored application edits or a native profiler. Replacement delegates must match method argument/result types.

This is an excellent API precedent for `withReplacement(handler, action)`, but selects methods rather than a particular arbitrary expression with caller locals. Do not assume async/concurrent scope guarantees from the callback shape. The README documents significant debugging differences: breakpoints in isolated original execution do not work, and unhandled exceptions are wrapped. Borrow scope ergonomics and treat stack traces/source maps as part of correctness.

## 13. Microsoft Fakes / Shims (.NET)

Primary documentation: https://learn.microsoft.com/en-us/visualstudio/test/using-shims-to-isolate-your-application-from-other-assemblies-for-unit-testing?tabs=csharp&view=vs-2022 .

Generated shim APIs redirect calls to methods to test delegates. `using (ShimsContext.Create())` manages cleanup; `ExecuteWithoutShims` supports call-through. This supplies precedent for generated type-safe testing APIs and testing unmodifiable dependencies, but not expression selection or surrounding-local capture.

The concurrency warning is explicit: shim types affect all threads within the AppDomain and have no thread affinity, so shim-based tests cannot run concurrently (the runtime does not enforce this). This is strong evidence that cleanup scope and execution-context isolation are separate features. execution-points' ALS isolation is a meaningful design distinction if maintained across all entry points.

## 14. Prig (.NET Framework)

Primary repository: https://github.com/urasandesu/Prig .

Prig generates indirection stubs from configuration and replaces targeted .NET APIs for tests. `IndirectionsContext` limits replacement lifetime. It is a predecessor for generated typed interception contracts and explicit restoration, not for arbitrary source-expression and lexical-local selection. Evaluate as historical design precedent, not a recommendation to adopt an unverified current platform.

## 15. JMockit (Java)

Primary tutorial: https://jmockit.github.io/tutorial/Faking.html .

`MockUp<T>` with `@Mock` methods temporarily replaces selected methods/constructors. `Invocation` exposes target instance, arguments, member and hit count; `proceed()` executes the original implementation. Fakes may have test, class or test-run lifetime. This is normal testing prior art for no-refactor fakes, call-through and hit-sensitive behavior. It is method-boundary interception, so caller-local state and expression-operand suppression are outside this API. The tutorial explicitly connects `proceed()` to around advice.

## 16. PowerMock and Mockito inline/static mocking (Java)

Sources:

- https://github.com/powermock/powermock
- https://github.com/powermock/powermock/wiki/mockito
- https://www.javadoc.io/static/org.mockito/mockito-core/5.16.0/org.mockito/org/mockito/MockedStatic.html

PowerMock uses a custom classloader/bytecode manipulation for static/final/private methods, constructors and static initialization. Constructor interception prepares the **calling class**, showing why callee replacement and call-site instrumentation differ. It still offers method/constructor expectation APIs rather than an arbitrary source-node/local schema.

Mockito's `MockedStatic` is `AutoCloseable` and explicitly **thread-local**; sharing it across threads is unsafe. This is a useful intermediate scope model between global shims and async-context propagation. Ordinary mocks/inline methods should be included as adjacent art, not advertised as direct equivalents.

## 17. Telerik JustMock and Typemock Isolator (.NET)

Primary sources:

- https://www.telerik.com/products/justmock/documentation/advanced-usage/advanced-usage
- https://www.telerik.com/products/justmock/documentation/advanced-usage/mocking-non-public-members-and-types
- https://www.typemock.com/basic-mocking-and-faking-with-isolator/
- https://docs.typemock.com/docs/BookIsolator/HtmlDocs/fakinginstanceconstructors.htm

Established commercial isolation tools already mock concrete/static/private/nonvirtual behavior without dependency injection. JustMock's advanced mode uses the .NET profiling API; its basic mode uses conventional mockable seams. Typemock supplies fake instances/static methods, original-call policies and constructor suppression. These invalidate any claim that 'mocking code you did not design for mocks' is new. Their documented high-level APIs remain member-based; no arbitrary expression/local-capture equivalent was found in these sources.

## 18. AspectC++ and selector-evolution research

AspectC++ official quick reference: https://www.aspectc.org/doc/ac-quickref.pdf .
Language reference: https://www.aspectc.org/doc/ac-lang-survey.pdf .

AspectC++ offers typed join-point context, argument/result/receiver access, and `tjp->proceed()` for around advice. This shows that typed external advice is not specific to Java or dynamically typed languages. The quick reference explicitly recommends at most one `proceed()` call; that is a useful contrast for deciding repeat-call semantics. It does not establish arbitrary surrounding lexical capture.

Fragility research primary institutional page: https://researchportal.vub.be/en/publications/tackling-pointcut-fragility-with-dynamic-annotations/ .

Pointcut evolution has a long-standing failure mode: structural program changes can cause unintended captures or misses. Annotation-based approaches trade application changes for more stable semantic anchors; dynamic annotations were proposed for runtime-dependent knowledge. Our zero-authored-marker goal chooses a different tradeoff, so typed match cardinality, previews, fingerprints and meaningful diagnostics should be explicit product features rather than claiming AST selection makes refactors safe.

## Cross-cutting conclusions for execution-points

- The broad idea is established. A defensible differentiation is the combination of ordinary TypeScript test callbacks, source-selected inner expressions, inferred narrowed capture types, stock native compiler/editor integration, and async-context scoped execution.
- Keep three boundaries explicit: before whole expression; before an instruction after operands; after result. Many superficially identical wrappers only implement the latter two.
- Keep static match count separate from runtime hit count. Mixin checks selection cardinality; Byteman/JMockit support hit counters. Both matter.
- Document whether `original()` means raw original operation, next wrapper, or reentry through the interceptor. MixinExtras/AspectJ explicitly compose continuations; JMockit explicitly avoids recursive fakes through `proceed()`.
- Restoration is not concurrency isolation. Compare global Microsoft shims, thread-local Mockito mocks, lexical Pose scopes and ALS propagation separately.
- Runtime instrumenters commonly validate handler types at weave time. The target-file type registry can offer earlier feedback, but nominal/private identity claims still require adversarial compiler checks; generated brands alone are not proof of identity equivalence.
- Source maps, debugger breakpoints and exception stack fidelity are user-visible semantics. Pose documents failures here; Bugdel emphasizes visual match markers.
- No audited source in this branch established the complete modern TypeScript package already exists. That is a bounded literature-search result, not a universal novelty assertion.

## Evidence classification and broad mocker comparison

Evidence labels: **D** = read official documentation, official project README/design document, or official API reference; **P** = read primary author paper; **A** = primary author/institution abstract or search-indexed extract only; **I** = clearly stated inference from the documented API/transformation. **No implementation was executed or patched. No claim here rests on a direct audit of implementation source files**; a GitHub design document or wiki remains documentation, not inspected source.

| Family | Evidence checked | Arbitrary surrounding application locals? | Boundary and useful distinction |
|---|---|---|---|
| MixinExtras | D: operation, expression, local and injector documentation | Yes, typed/ordinal/index local capture; mutable references also supported | Operation operands have already evaluated (**I** from documented transformation); wrappers compose |
| Javassist | D: tutorial and MethodCall API | Yes, when suitable debug metadata exists | Embedded source replacement at bytecode expression; operand timing is **I** |
| Byteman/BMUnit | D: programmers guide and testing tutorials | Yes, including binding assignment | `RETURN` exits enclosing method; after-call result substitution does not suppress the call |
| Bugdel / FGA | P: full papers | Yes, subject to point availability / debug metadata | Very direct fine-grained, local-aware historical ancestors; FGA marker qualification remains |
| PROSE | D: authors' project/history page | Early debugger implementation accesses stack-frame context | Do not infer today's exact expression-local API from that history |
| Énfasis | A: primary publication abstract, full fetch failed | Abstract reports runtime assertions involving local variables | Supporting lead; fewer verified API details than FGA |
| DiSL | P: paper; D: project description | Dynamic stack/local context and instrumentation variables | No around advice listed; instrumentation alone is not replacement |
| C# Interceptors | D: Roslyn feature design and compiler diagnostics | No arbitrary caller-local capture in described API | Compiler validates precise invocation replacement and signature compatibility |
| Harmony | D: official patch/transpiler/CodeMatcher docs | Possible through IL transformations; no inferred lexical schema | Prefix `__state` is newly introduced patch state, not original locals |
| Byte Buddy | D: official API docs and maintainer discussion | Not through `@Advice.Local`; that declares new instrumentation locals | `MemberSubstitution` is closer to selected inner operations than method advice |
| JMockit | D: official faking tutorial | No, only method instance/arguments/member metadata | Method/constructor fakes, original call and dynamic invocation counts |
| PowerMock | D: official README and Mockito wiki | No high-level arbitrary-local API established | Classloader/bytecode member and constructor interception; constructor callers require preparation |
| Mockito static/inline family | D: official `MockedStatic` API | No high-level arbitrary-local API established | Verified static-mock scope is thread-local and must be closed; do not extrapolate every inline feature from that document |
| Microsoft Fakes | D: Microsoft shims guide | No arbitrary caller-local capture in documented API | Generated delegates; global to AppDomain despite disposable lifetime scope |
| Pose | D: official README | No arbitrary caller-local capture in documented API | Explicit callback scope; async/concurrency guarantees not verified |
| Prig | D: official README | No arbitrary caller-local capture established | Generated typed indirection APIs with disposable lifetime context |
| JustMock / Typemock | D/A: official product/advanced API documentation and indexed official extracts | No arbitrary expression-local equivalent established | No-refactor member interception is mature prior art; not evidence for source-expression selection |

---

[Return to the research synthesis](prior-art.md).
