# ADR 0004: Phase 3 semantic program and execution engines

## Status

Accepted for Phase 3.

## Decision

Use the checked parser tree as OMNI's versioned high-level semantic representation. Wrap it with its source context and checker-produced module interface in `SemanticProgram` version 1. The interpreter, bytecode compiler, and JavaScript compiler receive that same representation through the engine interface.

Add a stack bytecode VM and a source-to-source JavaScript compiler. The JavaScript engine compiles supported OMNI programs to JavaScript and runs the result on Node.js. Both new engines implement the portable core subset documented in `core-v0.md`; unsupported constructs fail before execution with a source-located diagnostic. The reference interpreter continues to support the full implemented core.

Read development and release engine choices plus the host target from the nearest `omni.toml`. Development defaults to the interpreter; release defaults to the JavaScript compiler. `--mode`, `--engine`, and `--target` override those selections, with only the host target available in Phase 3.

## Rationale

The parsed tree already contains explicit expressions, statements, declarations, and source spans. Reusing it as HIR avoids a second syntax model and keeps the source language canonical. Versioning the engine input makes the contract visible and allows later backends to share a stable boundary.

Node.js is already the dependency-free bootstrap runtime, so generated JavaScript provides a compiler-backed path without adding an external toolchain or package. The bytecode VM exercises a distinct execution model. The first common engine subset covers ordinary application code—functions, closures, control flow, arithmetic, text, and lists—while explicit capability errors keep the full interpreter usable for the larger Phase 2 core.

The Phase 3 conformance suite compares return values and output from all three engines for portable programs. It also checks config selection, CLI overrides, and unsupported-target/construct diagnostics.

## Consequences

- Language syntax remains identical across engines.
- New engines do not yet execute records, enums, modules, or `match`; those constructs continue to run in the reference interpreter.
- Web, embedded, native machine-code generation, and profile-specific syntax remain out of scope for this phase.
- No third-party dependencies are introduced, so no new license review is needed.
