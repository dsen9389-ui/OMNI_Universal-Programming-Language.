# OMNI roadmap

OMNI's committed goal is one language and toolchain that can serve scripting, web, games, applications, data/AI, systems, and embedded development through a shared core, configurable execution engines, and domain profiles. This roadmap is the delivery path; completing Phase 1 does not complete the project.

## Completion criteria

OMNI is not complete while it only interprets programs. A production-ready release must meet all of these project-level requirements:

1. One canonical source syntax and a written, versioned language specification.
2. A maintained interpreter and at least one compiler-backed engine that execute the same core semantics.
3. Engine selection from both a project configuration file and the CLI, with clear errors for unsupported engine/target combinations.
4. A conformance suite that checks each engine against the specification and compares observable behavior across engines for portable programs.
5. Profiles and capability checks that make web and embedded support honest: portable core APIs work across targets, while unavailable platform effects are rejected or handled through explicit target-specific APIs.
6. Working, documented examples for the supported domains, including web and embedded targets, and repeatable builds for the supported platform matrix.
7. Diagnostics and developer tooling suitable for regular use, plus release, dependency-license, and compatibility policies.
8. Real, supported domain frameworks and flagship projects across the advertised areas. Small helper modules and isolated demos do not satisfy this requirement.

The word universal describes the intended breadth of the toolchain, not a promise that every library or every program runs unchanged on every target. Portability is defined by the specified core and capability contracts.

## Phase 0 — Decisions and specification

**Exit condition:** canonical syntax, initial semantics, architecture, non-goals, and phased completion criteria are recorded.

**Status:** the initial core direction, syntax ADR, implementation ADR, and non-goals are recorded.

## Phase 1 — Core language and maintained interpreter

**Goal:** deliver the first usable language engine and establish the semantic foundation for every later engine.

Deliverables:

- Source-spanned lexer, recursive-descent statement parser, and precedence-based expression parser.
- Tree-walking interpreter with lexical scopes and closures.
- Variables, functions, control flow, arithmetic, booleans, lists, and basic runtime annotations.
- Source-located diagnostics and one CLI with run, check, repl, help, and version.
- Normative core specification and runnable examples.
- Runnable examples that demonstrate the core with clear, human-readable programs.
- A lightweight, dependency-free smoke/regression suite for the CLI, examples, diagnostics, and key interpreter edge cases. This does not replace the language conformance suite planned for Phase 2.
- An engine interface used by the CLI; the interpreter is the first registered engine.

**Exit condition:** documented programs execute through the CLI; syntax and runtime errors are understandable; representative programs are straightforward for people to read, write, and explain; the interpreter's behavior is specified well enough to serve as the reference engine.

**Status: complete.** The interpreter, CLI, normative core specification, six readable runnable examples, and dependency-free smoke suite meet the Phase 1 exit condition. Verification passed: `node --test` (25 checks), `node --check` for every JavaScript module, and `omni check` plus `omni run` for every example. Phase 2 work remains governed by its own gate below.

## Phase 2 — Static semantics and language completeness

Deliverables:

- Name resolution and useful compile-time diagnostics.
- Static type checking and inference for the supported core.
- User-defined record and enum types, option/result values, and exhaustive pattern matching.
- Module and import semantics.
- Expanded standard library contracts and runnable examples.
- Normative grammar, semantic rules, diagnostic format, and the first maintained conformance suite.

**Exit condition:** the core language reference and conformance suite agree; errors in statically invalid programs are caught before execution.

**Status: complete.** The normative reference, checker, interpreter, CLI, examples, and maintained conformance suite agree for the Phase 2 core. Statically invalid entry files and imported modules are rejected before program effects run. Verification passed: `node --test` (44 checks), `node conformance/run.mjs` (16 conformance cases), `node --check` for every JavaScript module, and `omni check` plus `omni run` for every runnable example, including multi-file projects.

## Phase 3 — Configurable execution engines

Deliverables:

- Shared HIR/MIR or an equivalently well-defined common semantic representation.
- Bytecode VM and one compiler-backed engine, selected through the engine interface.
- omni.toml project configuration for development and release execution choices.
- CLI overrides for engine and target selection.
- Cross-engine differential conformance runs for programs supported by multiple engines.

**Exit condition:** users can run the same portable program through the interpreter and compiler-backed engine, select each through project configuration or CLI, and get equivalent specified behavior.

**Status: complete.** The checked semantic program feeds the reference interpreter, stack bytecode VM, and JavaScript compiler. `omni.toml` selects development and release engines; CLI engine and host-target overrides work. The differential suite compares seven portable examples, return values, output, runtime diagnostics, Unicode behavior, list contracts, and recursion limits. Verification passed: `node --test` (63 checks), `node conformance/run.mjs` (35 conformance checks), `node --check` for all 21 JavaScript modules, and `omni check` plus `omni run` for all 12 examples. The VM and JavaScript compiler currently reject records, enums, module imports, and `match` with source-located guidance; the interpreter remains the full-core reference. Phase 4 work remains governed by its own gate below.

## Phase 4 — Web and embedded portability

Deliverables:

- Web output/runtime support and an embedded or freestanding output/runtime path.
- A specified capability/effect model tied to targets and profiles.
- Portable core APIs plus explicit target-specific APIs where hardware or host facilities differ.
- A web application example and an embedded firmware example that build with documented commands.

**Exit condition:** the target matrix states exactly what works; unsupported effects fail with source-located guidance; both web and embedded demonstrations build and run in their target environments.

**Status: complete.** The web build runs in a browser and renders the example's OMNI output on the page. The embedded example compiles to freestanding C and runs in the included simulator, showing serial output and GPIO changes. The target matrix documents each backend's supported subset; unsupported platform effects and embedded constructs receive source-located E3004 and E3002 diagnostics. Zig is recorded as an external MIT-licensed build tool in [the dependency review](dependencies.md); its implementation is not vendored. Verification passed: `node --test` (70 checks), `node conformance/run.mjs` (35 conformance checks), `node --check` for all source modules, `omni check` for all 12 top-level examples, and `omni run` for all 11 host-compatible examples. The embedded example was built and run in its simulator environment.

## Phase 5 — Profiles, libraries, and interoperability

Deliverables:

- Versioned profiles for the supported execution, runtime, safety, and standard-library choices.
- C ABI interoperability and a reviewed dependency/license policy.
- Package and dependency workflow only after package lifecycle and integrity requirements are specified.
- Domain libraries for scripting, web, games, apps, and data as separate supported deliverables.

**Exit condition:** profile combinations are validated, documented, and covered by the conformance matrix; each advertised domain has a maintained example.

**Status: complete.** The versioned profile registry and [machine-readable conformance matrix](../conformance/profiles.json) agree; supported and rejected combinations are exercised through selection and CLI/configuration checks. The scripting, web, games, apps, and data libraries each have a maintained runnable example. The `embedded-ffi-v1` profile links trusted user C sources through the checked scalar C ABI, and its build manifest records compiler version, source hashes, and the profile's capabilities. Package installation remains deferred with lifecycle, integrity, trust, offline, and reproducibility requirements documented in [the dependency policy](dependencies.md). Verification passed: `node --test` (88 checks, including the Zig-backed simulator and C ABI integration), `node conformance/run.mjs` (50 cases), and `node --check` for all 29 JavaScript modules. Phase 6 work remains governed by its own gate below.

## Phase 6 — Production tooling and platform support

Deliverables:

- Formatter, test runner, language server, debugger integration, and repeatable release builds.
- Supported OS/architecture matrix and CI for the declared matrix.
- Performance, security, dependency, compatibility, and migration policies.
- A project workflow that makes day-to-day source changes, tests, and release builds repeatable.

**Exit condition:** users can build and maintain a real project with documented tooling and supported releases.

**Status: complete.** `omni fmt` provides token-preserving source formatting and a read-only check mode. `omni test` runs output-snapshot projects through OMNI's regular CLI, checker, and selectable host engines. `omni lsp` provides source diagnostics, completion, hover, same-file navigation, and formatting over standard JSON-RPC. `omni debug` provides interpreter stepping, breakpoints, and visible-value inspection. Build manifests contain SHA-256 artifact hashes, and `--verify-reproducible` compares two builds on the current host. `npm run check:support-matrix` verifies that the documented host/runtime rows match the configured workflow. The operational policies are recorded in [the policy guide](policies.md). Local Windows x64 verification passed with Node 24 and Zig 0.17: `npm test` (108 checks), `npm run test:conformance` (50 cases), `npm run check:syntax` (43 files), and `npm run check:support-matrix`, plus repeatable web and embedded builds. Hosted platform evidence is tracked in [the support matrix](support-matrix.md); Phase 7 work remains governed by its own gate below.

## Phase 7 — Hardening and self-hosting

Deliverables:

- Fuzzing, security review, reproducible builds, performance regression tracking, and expanded conformance coverage.
- Optional self-hosted compiler after the external implementation is stable.
- Stability policy and a 1.0 specification freeze.

**Exit condition:** release guarantees are backed by conformance and platform evidence, not roadmap claims.

**Status: in progress.** Phase 7 has deterministic parser/checker fuzzing plus bounded cross-engine execution fuzzing (`npm run fuzz`), a repeatable three-engine benchmark with a same-machine 10% regression investigation threshold (`npm run benchmark -- --compare`), expanded cross-engine and adversarial conformance checks, and a security review/remediation record in [security.md](security.md). Local Windows x64 checks passed with Node 24 and checksum-verified Zig 0.17: `npm test` (122 checks: 118 passed, four symlink cases skipped), `node conformance/run.mjs` (53 passed), syntax validation (46 modules), support-matrix validation (seven CI rows covering six hosts), deterministic fuzzing (1,200 token cases, five adversarial cases, and 256 pure expressions run across all three engines), and repeatable web and embedded builds. A 20-sample benchmark baseline is recorded in [the benchmark baseline](../benchmarks/baselines/windows-x64-node24.json); a 100-sample, 20-warmup comparison passed on the same machine. Hosted run [39621297011](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./actions/runs/39621297011) passed all seven CI rows across Linux, macOS, Windows x64, and Windows arm64. Each row completed 122 regression checks, 53 conformance cases, deterministic fuzzing, formatting, and the maintained OMNI test example; hosted regression suites had no skipped tests, including symlink coverage. The Windows checkout uses the runner's temporary directory because the repository name ends in a period, and `.gitattributes` keeps `.om` source line endings at LF so formatter checks behave consistently. The stability and 1.0 freeze criteria are recorded in [stability.md](stability.md), with the [core 1.0 freeze review packet](spec/core-1.0-freeze-review.md) and [draft release notes](releases/omni-core-v1.0.0-rc.1.md) prepared. Self-hosting remains deferred until an independent implementation is stable enough to serve as a trustworthy bootstrap and cross-check. The final specification freeze depends on maintainer review and the published release-candidate feedback process.

## Phase 8 — Production domain frameworks

This phase is required for the user's full OMNI goal. It turns the Phase 5 utility slices into maintained, usable frameworks built on stable Phase 6 tooling and Phase 7 compatibility and security contracts. It is not complete when a framework is only a wrapper or a prototype.

Deliverables:

- CLI and scripting framework for real automation and command-line applications.
- Web framework spanning browser UI and server applications, with documented deployment targets.
- Game framework with a supported 2D runtime, input, graphics, audio, and a complete playable example; 3D capabilities are declared only when verified.
- Desktop and mobile application framework with UI, platform services, packaging, and accessibility contracts for each supported platform.
- Data and AI framework with production-usable data interchange and at least one documented inference path.
- Systems and embedded libraries with explicit memory, unsafe, hardware, and board-support contracts.
- Sandboxed plugin framework for host applications, with capability and isolation guarantees.
- A maintained flagship application, tutorial, and conformance coverage for each advertised domain; dependencies are reused only after license and platform review.

**Exit condition:** every advertised domain has at least one supported, documented framework that builds a useful end-to-end application with OMNI tools. Framework APIs, platform matrices, security boundaries, dependency licenses, and compatibility policies are tested and published. Unsupported platforms and features are stated plainly; no framework is called production-ready based only on a simulator or sample-only wrapper.

## Phase gates

Do not claim a later phase complete because its design is documented. Each gate requires working deliverables, runnable examples, and the verification named in that phase. Keep the scope of each implementation turn within one phase while preserving this full project goal.

The human simplicity gate applies to every phase: language syntax, semantics, libraries, profiles, configuration, and tools must remain straightforward for people to write and understand. Every phase must include readable examples for its new concepts. Prefer familiar, consistent constructs and explicit behavior; defer a feature if its ordinary use adds more mental overhead than practical value. Advanced capabilities should not make the common path harder to learn.
