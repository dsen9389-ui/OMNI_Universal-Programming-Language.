# OMNI conformance suites

The Phase 2 suite records language behaviors that the reference checker, interpreter, and CLI must agree on. Its cases cover valid execution, static rejection before side effects, type and constructor checks, exhaustive matching, relative imports, module path validation, live exports, and import-cycle diagnostics.

Run the maintained suite from the project root:

    node .\conformance\run.mjs

The Phase 3 engine suite additionally runs each portable example through the reference interpreter, bytecode VM, and JavaScript compiler and compares the returned value and printed output. It checks mode-based engine selection, direct engine overrides, the supported host target, and source-located rejections for unsupported constructs and targets. The suite includes readable precedence and expression-depth examples, plus a left-associativity conformance case.

The Phase 5 profile suite compares the executable profile registry with `profiles.json`, resolves each supported engine/target/backend/runtime/safety/standard-library tuple, rejects unsupported combinations, and runs one maintained example for each domain library. The separate `embedded-ffi-v1` integration check in the full regression suite builds and runs the C-backed example; native C code requires Zig and is intentionally outside the dependency-free conformance command.

All dependency-free conformance suites use Node's built-in test runner and add no package dependencies. Each case is an executable source fixture or CLI project with an expected result or stable diagnostic code. Update the core specification and a readable `.om` example whenever a case changes the language contract. The Phase 7 deterministic fuzz and benchmark checks are separate CI steps; see [the hardening guide](../docs/fuzzing.md).
