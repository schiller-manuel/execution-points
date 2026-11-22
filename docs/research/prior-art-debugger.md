# Execution-points: debugger, instrumentation, fault-injection, and scheduling prior art

Research date: 2026-11-22. Primary sources only. Capabilities and limitations are distinguished from design recommendations.

## Executive assessment

The broad idea of externally selecting a location, running user logic when execution reaches it, inspecting state, and changing execution is established. Three particularly close precedents are **Pharo Reflectivity/MetaLinks**, **TASKING testIDEA test points**, and **DOTT.NG InterceptPoint**. The first supplies almost the same conceptual decomposition at AST granularity; the latter two explicitly use programmable breakpoints for tests. **Dyninst** supplies named program points, snippets, scoped local-variable lookup, call-site replacement, and original-function wrapping. **Frida/DynamoRIO** demonstrate mature replacement APIs with explicit original-call and cleanup concerns.

The combination that deserves emphasis in execution-points is narrower and more useful: externally selected TypeScript AST expressions; inferred expression-result and flow-sensitive captured-local types; normal test callbacks; same-worker execution; and an explicit activation lifetime. Do not imply that external selection, local access, replacing operations, or calling the original is individually new.

One unusually concrete distinction is **evaluation timing**. Current Pharo14 ordinary message-send instrumentation evaluates receiver and arguments before its before/instead hook. Dyninst explicitly documents that removing a call still evaluates arguments. Function-entry debugger and native hooks normally intercept after callers have evaluated arguments. The repository instead intercepts before the whole expression and makes the expression lazy through `original()`. This distinction is substantive, but should not become an absolute claim of uniqueness across the entire survey.

## Top five to read first

1. **Pharo Reflectivity/MetaLinks** — closest conceptual ancestor: AST node + execution-context reification + before/instead/after + runtime activation.
2. **TASKING testIDEA** — direct commercial prior art for location-based test points, local-variable intervention, scripted faults, and hit sequences.
3. **DOTT.NG** — direct pytest + GDB programmable-breakpoint mocking, including forced return and state changes.
4. **Dyninst** — closest low-level engineering vocabulary: points, snippets, local scope, call-site replacement, and original wrappers.
5. **Frida and DynamoRIO** — practical reference for replace/original, per-invocation state, invocation timing, concurrency, and cleanup.

GDB itself is also worth prominently naming: its manual literally demonstrates silently correcting a variable at a breakpoint so another bug can be tested.

## 1. Pharo Reflectivity / MetaLinks

**What exists.** A MetaLink attaches meta-behavior to an AST node. Its control mode is before, instead, or after. It requests only needed execution information, called reifications: receiver, arguments, selector, context, variable/value details, or `#operation`, an executable representation of the original operation. Links can be installed and removed dynamically, conditioned, or restricted to particular objects. Meta-execution levels address recursive interception. Reflectivity has been integrated into Pharo since 2008, according to the authors' 2020 retrospective.

**Why it matters.** This is almost the project's conceptual model, in a dynamic language with a live compiler. Object-centric breakpoints are built using these mechanisms. Dynamic typing means it does not provide the proposed TypeScript contract generation.

**Verified timing difference in current source.** `RFASTTranslator >> emitMessageNode:` visits the receiver and argument nodes, emits a preamble, then emits before/instead links. `RFOperationReification >> genForASTMessageNode` creates `RFMessageOperation` from captured receiver/arguments; that operation subclasses `MessageSend`. Thus **ordinary message-send MetaLinks do not suppress receiver/argument evaluation**. Do not generalize that result to every AST-node kind: inlined special messages have another path.

**Other current-source details.** `MetaLink` has conditional activation, disable/enable, one-shot and disabled options, and styling support. Its uninstall comment warns that method recompilation or AST-cache replacement can prevent reinstalling the same object; disable/enable preserves it. This is an important target-lifetime/HMR lesson. `RFTempRead` resolves variables in a context, establishing local-read capability independently of method arguments.

**Sources.**

- Author paper: https://archive.marcusdenker.de/publications/Cost20a-Programming-Reflectivity.pdf.
- Author breakpoint article: https://thepharo.dev/2020/04/06/implementing-an-object-centric-breakpoint-with-reflectivity/.
- Current source, fetched successfully through GitHub connector: https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/RFASTTranslator.class.st
- https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/RFOperationReification.class.st
- https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/RFMessageOperation.class.st
- https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/MetaLink.class.st
- https://github.com/pharo-project/pharo/blob/Pharo14/src/Reflectivity/RFTempRead.class.st

**Historical caveat.** The 2020 paper reports limitations in hot stack-frame updates and thread-safe installation. Do not present these as verified current Pharo14 limitations. Its comments about Truffle's inability to replace nodes are also historical, not safe current claims.

## 2. TASKING testIDEA test points and stubs

Test points are breakpoints at chosen executable lines. They can verify, assign, or log variables and call a script function. Per-hit sequences can advance through different test actions. Stubs provide function-level output-parameter and return-value injection.

The selector design is striking: documentation recommends a stable source comment marker when edits are allowed, or a unique string within a line range when they are not. It acknowledges that compiler optimization may remove lines or variables. Hardware breakpoint budgets can constrain installations.

This directly establishes breakpoint-driven testing with local-state intervention. Its selection, debugger target, script integration, and ABI-level stubs differ from a typed TypeScript expression replacement. Borrow precise hit assertions, per-hit behavior, explicit missing-target errors, and clearly documented compiler limitations.

Sources:

- https://www.tasking.com/documentation/testidea/help/concepts/testSpec/testPoints.html.
- https://www.tasking.com/documentation/testidea/help/concepts/testSpec/stubs.html.
- https://www.tasking.com/documentation/testidea/help/tasks/writingScriptFunctions.html.

## 3. DOTT.NG: pytest plus GDB target interception

DOTT.NG runs Python tests on a host and drives embedded targets through GDB MI and SWD/JTAG. A subclass of `InterceptPoint` implements `reached()`. Inside it, `self.eval(...)` can inspect/change target state and `self.ret(...)` forces a return. Documentation demonstrates replacing C function results and changing data through an argument pointer. Function symbols, including static functions, can be targeted.

Important qualifications: setup links DOTT helper code, adds a `DOTT_test_hook()` call in `main`, and supplies debug symbols. Documentation recommends `DOTT_LABEL` markers for arbitrary in-function points. Therefore do not describe the entire system as requiring no application changes. Callback operations are restricted to the intercept point's own interface; ordinary `dott().target` operations cannot be called from the callback. A normal halt breakpoint can disrupt a debugger-initiated function call in a way an InterceptPoint avoids.

This is a direct prototype of the user's initial breakpoint-as-test-hook idea, but uses string expressions and remote debug state rather than inferred callback types.

Sources:

- https://tw-ghub.github.io/dott-ng_docu/index.html.
- https://tw-ghub.github.io/dott-ng_docu/ComponentTesting.html.
- https://tw-ghub.github.io/dott-ng_docu/DeveloperGuide.html.

## 4. GDB and LLDB programmable breakpoints

GDB breakpoint command lists can silently assign local state and continue. The manual explicitly motivates this by correcting one bug so testing can proceed to another. `return expression` forces the selected frame to return; `jump` changes the execution address but does not repair the stack/register state that arbitrary control-flow surgery might require.

**API trap:** GDB's `gdb.Breakpoint.stop()` Python method is a stop-decision callback. Documentation forbids changing inferior execution state/frame context/breakpoints there. Do not give a naive mutating `stop()` example; command lists or a suitable debugger controller are the appropriate mechanism.

LLDB breakpoint Python callbacks receive `SBFrame`, location and optional structured parameters. Returning false resumes. Its expression and thread-return facilities allow state evaluation and forced return. Both debuggers depend on debug information and actual executable locations; neither gives a ready-made lazy source-expression continuation or test-callback type inference.

Sources:

- https://sourceware.org/gdb/current/onlinedocs/gdb.html/Break-Commands.html.
- https://sourceware.org/gdb/current/onlinedocs/gdb.html/Breakpoints-In-Python.html.
- https://sourceware.org/gdb/current/onlinedocs/gdb.html/Returning.html.
- https://sourceware.org/gdb/current/onlinedocs/gdb.html/Jumping.html.
- https://lldb.llvm.org/use/tutorials/breakpoint-triggered-scripts.html.
- https://lldb.llvm.org/use/map.html.

## 5. Chrome DevTools Protocol and Node Inspector

`Debugger.evaluateOnCallFrame` evaluates in a paused frame. `setVariableValue` supports specified local/closure/catch scopes; object properties use ordinary object mutation. `setReturnValue` is experimental and works only at a return break position. These are debugger operations, not a general replace-next-expression primitive.

Node explicitly discourages same-thread debugger breakpoints: the code acting as debugger is paused along with the debuggee. A worker can connect to the main thread. This is strong evidence for keeping the current source-transform architecture for same-worker synchronous test handlers.

Current protocol source marks `setScriptSource` deprecated and says live edit is no longer supported. Avoid recommending old live-edit recipes as a current generic solution without checking the user's actual runtime version. The protocol source is a moving branch.

Sources:

- https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl.
- https://nodejs.org/api/inspector.html.

## 6. Dyninst

Dyninst's API models an application, program **points**, and inserted **snippets**. It supports entry/exit/call/instruction instrumentation, replacing a specific call, removing a call, wrapping a function while preserving an original symbol, and finding a variable in the source-language scope of a point. Local-name lookup requires debug symbols. Variable-expression handles can participate in snippets.

The manual explicitly states that `removeFunctionCall` still evaluates parameters. `replaceFunctionCall` requires compatible signatures and warns about interprocedural register allocation. This makes the difference between call-instruction interception and whole-expression interception concrete.

Read it for architecture vocabulary and precise guarantees, not as a TypeScript-ready implementation. The documented type objects come from binary debug information or supplied types, rather than compiler-generated test API contracts.

Sources:

- Primary manual, v8.1 historical: https://www.paradyn.org/release8.1/doc/DyninstAPI.pdf.
- Current project: https://github.com/dyninst/dyninst.
- Current manual exists in repository at `docs/v13.0.0_manuals/dyninstAPI.pdf`; directory listing verified through connector, PDF not read. Do not label old manual details newly verified v13 behavior.

## 7. Frida Interceptor and Stalker

`Interceptor.attach` gives entry arguments, exit return values, invocation state and register context. `Interceptor.replace` installs a native replacement; a `NativeFunction` targeting the original address can synchronously invoke the original without recursing through that replacement. `replaceFast` instead returns an original pointer; `revert` restores prior behavior. Native signatures are supplied explicitly.

`Stalker.follow` can transform per-thread native instruction streams, inserting callouts or changing emitted instructions. This reaches arbitrary instruction locations, but exposes native CPU/memory state, not inferred source-local bindings. Function-entry hooks occur after caller-side argument evaluation.

The practical parallels are replacement/original contracts, invocation-local state, installation lifetime, and explicit low-level boundaries. Its TypeScript API declarations type the toolkit; they do not automatically derive the target program's source expression types.

Source: https://frida.re/docs/javascript-api/.

## 8. DynamoRIO drwrap

`drwrap_wrap` has pre/post callbacks. Pre can read/set arguments and `drwrap_skip_call`; post can read/set the return value. `drwrap_replace_native` can target a specific call site rather than an entire function when `at_entry` is false. Replacements must obey the native calling convention.

Cleanup is explicitly complicated: after abnormal unwinds, post callbacks may receive no valid invocation context; some detection is heuristic unless a supported exception-handling option applies. An incorrect declared calling convention can appear to install successfully yet read unrelated register/stack slots.

Lesson: distinguish a selected location from an invocation, specify exceptional completion, and make unsupported targets fail clearly. This is strong call-site interception prior art but does not imply lazy source-expression evaluation or typed lexical capture.

Source: https://dynamorio.org/group__drwrap.html.

## 9. Pyda

Pyda combines DynamoRIO with an in-process Python interpreter. `p.hook(address, callback)` installs a callback at an instruction address, and callbacks can inspect/change registers and memory or redirect execution. Its model avoids the debugger requirement that all threads be stopped while one thread handles a hook. The README explicitly warns that APIs are unstable.

This is an unusually relevant bridge: breakpoint-like programmatic intervention is possible without making a traditional stopped debugger the execution engine. It still requires instruction addresses and machine-state knowledge rather than AST selection and source-level type contracts.

Source: https://github.com/ndrewh/pyda.

## 10. Intel Pin

Pin dynamically instruments native programs through a translated code cache. Instrumentation callbacks select locations; generated analysis calls run on each execution. Instruction modification includes insertion and deletion, and routine APIs support replacement.

This is the mature split between **choosing/instrumenting a point** and **deciding what to do at each hit**. It can implement precise machine-level intervention without authored application edits. Native architecture, calling convention, optimized-code mapping and manually interpreted state remain the price.

Sources:

- https://software.intel.com/sites/landingpage/pintool/docs/99633/Pin/doc/html/index.html.
- https://software.intel.com/sites/landingpage/pintool/docs/98650/Pin/doc/html/group__INS__MODIFICATION.html.

## 11. libfiu (C)

libfiu separates a small application-side failure-point API from external/control-side activation. Named points can activate deterministically, probabilistically, or through an external decision callback. Stack-qualified activation is supported. POSIX wrappers use interposition to test certain library failures without application changes.

Its generic named points require authored instrumentation; the no-source-edit mode covers a known library boundary. Borrow the separation of point identity and activation policy, counted/probabilistic failures, and call-context predicates. Do not characterize it as arbitrary source-expression replacement.

Sources:

- https://blitiri.com.ar/p/libfiu/doc/guide.html.
- https://github.com/albertito/libfiu/blob/master/libfiu/libfiu.3.
- https://github.com/albertito/libfiu/blob/master/doc/posix.rst.

## 12. PingCAP failpoint (Go)

This library uses ordinary Go marker functions and an AST rewriter. A marker closure can reference surrounding variables; rewriting inlines it into an activated conditional. Special return/break/continue/goto markers overcome the control-flow limits of the original closure. `InjectCall` lets test-side code provide callback behavior through `EnableCall`, but an application-side marker is still necessary.

`InjectContext` and `WithHook` explicitly support context-dependent activation for parallel tests. Configuration also supports hit counts, probability, delay, panic and pause. This is close prior art for separating test logic from production logic while reusing the compiler to check ordinary source syntax; it does not supply externally inferred lexical contracts at an unannotated expression.

Source: https://github.com/pingcap/failpoint.

## 13. Rust fail-rs and FreeBSD failpoints

Rust `fail_point!` macros introduce named failure points, compiled through the `failpoints` feature. Runtime configuration provides panics, early returns, sleeping and conditional/probabilistic activation. `FailScenario` owns test setup/teardown. The project's 0.4 documentation explicitly explains that failpoints are global resources and that the scenario lock prevents parallel tests from interfering.

FreeBSD failpoint macros are a predecessor, with actions controlled through sysctl configuration. Both systems emphasize deliberately installed failure seams rather than externally selected operations.

The scope lesson is useful: cleanup alone does not give concurrent-test isolation; the storage/activation model matters. Do not imply Rust's lock-based model is equivalent to ALS context isolation.

Sources:

- https://github.com/tikv/fail-rs.
- Versioned historical API docs: https://tikv.github.io/doc/fail/index.html.
- https://man.freebsd.org/cgi/man.cgi?apropos=0&manpath=FreeBSD+10.0-RELEASE+and+Ports&query=fail&sektion=9.

## 14. Linux fault injection and error override

The kernel fault-injection framework provides probability, interval, count, task and stack filters. It also supports per-task nth-failure control. Function-error injection is deliberately restricted to functions marked `ALLOW_ERROR_INJECTION`, with constrained return categories and semantic requirements for safe early failure.

This is a useful counterexample to the claim that probes or eBPF automatically let a tester replace any operation. Location observation, permitted return override, and safe semantic substitution are distinct capabilities.

Source: https://docs.kernel.org/fault-injection/fault-injection.html.

## 15. Historical debugger-driven fault injection: FAUST and FAIL-FCI

FAUST (2003) used GDB, binary tools and scripts for portable fault injection in software without modifying its source. FAIL-FCI (2005) combined a fault-injection language with debugger-based intervention for distributed/cluster applications, targeting particular program locations without recompilation.

These establish a long history of scripted scenarios over external program locations. They focus on fault campaigns and distributed coordination rather than everyday typed unit-test replacement callbacks. Publication dates should come from the papers, not recent repository ingestion dates.

Sources:

- FAUST: https://iris.polito.it/retrieve/handle/11583/1416278/e384c42d-ed01-d4b2-e053-9f05fe0a1d67/2003-IOLTS-Faust.pdf.
- FAIL-FCI: https://www.lri.fr/~bibli/Rapports-internes/2005/RR1421.pdf.

## 16. LLVM LLFI and S2E

LLFI injects faults at LLVM IR locations and relates them to source locations. Its main use is configurable resilience testing, such as data corruption, rather than arbitrary author-written replacements.

S2E combines a virtual machine with selective symbolic execution and plugin-driven analysis. Its research includes systematic fault injection for error-recovery testing. This is adjacent as a way to turn controlled intervention into multiple explored executions, but it is a substantially different runtime and cost model.

Sources:

- https://github.com/DependableSystemsLab/LLFI.
- https://s2e.systems/docs/.

## 17. CHESS and Microsoft Coyote

CHESS pioneered systematic scheduling exploration of concurrent tests. Coyote rewrites .NET assemblies to replace supported concurrency operations with controlled versions, explores schedules and provides reproducible failing traces. Its explicit scheduling points offer additional control.

This is relevant if execution-points grows an API to pause at a point or coordinate tasks. A hook can create a useful deterministic rendezvous, but it does not automatically provide systematic scheduling or faithful replay. Those require owning the relevant concurrency and nondeterministic operations.

Sources:

- https://www.microsoft.com/en-us/research/publication/chess-a-systematic-testing-tool-for-concurrent-software/.
- https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-2007-149.pdf.
- https://microsoft.github.io/coyote/overview/how/.
- https://github.com/microsoft/coyote/blob/main/docs/concepts/tasks/overview.md.

## 18. loom (Rust)

loom runs a model closure while its replacement synchronization and thread primitives explore possible concurrent executions. Applications/tests must use the controlled primitives, often through conditional imports. It is not external interception of arbitrary code, and its supported memory-model behaviors have limits.

The lesson is to distinguish an activation scope from an execution model. A callback scope can isolate replacement configuration without making all child tasks observable, controlled, or joined.

Source: https://github.com/tokio-rs/loom.

## 19. Java Pathfinder listeners

JPF's listener API includes an event before bytecode execution and another after execution. Its own documentation explicitly says a before listener can skip or replace an instruction, providing non-invasive instrumentation. Listeners execute in the host VM, separately from the modeled target VM, and can interact with scheduling choices and search/backtracking.

This is closer to arbitrary execution intervention than many mocking frameworks. The price is running under a specialized model-checking VM and manipulating interpreter state. It is not a drop-in callback over a production JVM stack frame or a TypeScript expression.

Sources:

- https://github.com/javapathfinder/jpf-core/wiki/Listeners.
- https://github.com/javapathfinder/jpf-core/wiki/What-is-JPF.

## 20. rr record/replay

rr records an execution and replays it deterministically under debugger control, including reverse execution and stable address/state exploration. This is useful conceptual adjacency for repeatedly finding and inspecting points, but its primary purpose is reproducing an already recorded run rather than authoring scoped alternative behavior.

Avoid the absolute statement that rr cannot change state: debugger function calls use diversion sessions. The distinction should be purpose and execution contract, not a blanket capability denial.

Sources:

- https://rr-project.org/.
- Diversion-session discussion in project issue: https://github.com/rr-debugger/rr/issues/2829.

## Design lessons for execution-points

These are deductions from the comparisons, not claims that the prior systems implement the exact proposed semantics.

### A. Keep five decisions separate

1. **Selection:** which authored operation is designated? AST kind, function ancestry, semantic identity, match cardinality.
2. **Capture:** which local bindings or execution values are exposed? At what evaluation moment? By snapshot, getter, or reference?
3. **Intervention:** observe, replace result, throw, call original, delay, or choose among these.
4. **Activation:** which invocation, async context, receiver object, hit number, or predicate uses the intervention?
5. **Lifetime:** when is the activation invalidated and what happens to work already spawned?

Pharo exemplifies separating node attachment, reification, control and activation. testIDEA shows that selection resilience and per-hit scenarios deserve independent treatment. Go/Rust failpoints show that parallel isolation is a separate runtime property.

### B. Specify whole-expression laziness with a tiny conformance example

For `getReceiver().operation(makeArgument())`, replacing the selected call should explicitly say whether both helper calls are skipped. The present repository's before-expression rule says yes unless `original()` is called. Contrast this with documented Dyninst and verified Pharo message-send behavior. Use this example in README/API documentation; the phrase "before call" is insufficient.

Also settle whether multiple `original()` calls repeat receiver/argument evaluation and whether a saved `original()` may be invoked after the handler returns. These are distinct from the fact that a continuation exists.

### C. Scope ownership must be explicit, especially for escaped asynchronous work

A local reproduction against the baseline confirmed that the current global fast-path counter can make a pending descendant use original behavior after the callback action returns, even when ALS state was inherited. The contract should deliberately choose this lifetime, rather than let an optimization define it.

Recommended initial contract: activation remains valid until the scoped action's returned promise settles; callers must await relevant work; detached work falls back to original behavior after closure. Implement/check a per-scope active/closed token consistently, including when other scopes remain active, so unrelated activity cannot reactivate an escaped scope. If future requirements favor transitive-child lifetime, model that explicitly; ALS inheritance alone does not track task completion or ownership.

The report does not establish a prior tool with the same JS async-descendant semantics. Go context activation, Rust global locks, Pharo object/process conditions and native per-thread hooks are different answers to related isolation problems.

### D. Define recursion and composition

Frida explicitly distinguishes replacement from original dispatch; Pharo has execution levels. Specify whether a replacement calling application code can intercept the same point recursively; whether `original()` bypasses only the current replacement or all replacements; and which nested scope wins. With selected-expression transforms, source recursion and continuation invocation may naturally differ.

### E. Install once, activate cheaply, and provide diagnostics

Several mature systems distinguish code instrumentation from per-hit behavior. Keeping transformed points stable and context activation cheap aligns with that pattern. A development inspector should show selected source spans, capture names/types, match count and hit count. Tests should be able to assert the point was reached, rather than silently passing when a selector no longer matches.

### F. Keep unsupported semantics explicit

Debuggers, native instrumentation and model checkers all document restrictions. TypeScript should similarly reject unsupported expression forms or capture contexts clearly. Type inference is an authoring advantage; it cannot by itself guarantee evaluation-order preservation, control-flow validity, source-map correctness, runtime identity, or meaningful test fidelity.

---

[Return to the research synthesis](prior-art.md).
