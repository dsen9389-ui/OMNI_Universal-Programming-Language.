# ADR-0002: Phase 1 implementation host and interpreter

**Status:** Accepted for Phase 1; later changes require a parity plan

## Decision

Implement the first front end and tree-walking interpreter in dependency-free JavaScript. The initial bootstrap used Node.js 20 or newer; the Phase 6 support policy moves the maintained toolchain to Node.js 22 and 24 LTS. Keep the interpreter as a real execution engine in the completed OMNI toolchain. Keep lexer, parser, interpreter, diagnostics, engine selection, and CLI responsibilities separate.

## Context

The master plans recommend Rust for the eventual compiler and reuse of mature compiler infrastructure. The current workspace has no existing codebase and the available environment has Node.js but no Rust compiler or Cargo on PATH. An interpreter is the first execution mode in both plans and gives the project a runnable language while the front end and semantics are being established.

The language is not intended to stop at interpretation. A compiler-backed mode must execute the same specified source language, and users must be able to select an execution engine for a project and from the command line. The interpreter remains important for scripts, REPL use, embedding, and as a semantic reference for later engines.

## Consequences

- Node.js is the Phase 1 implementation host, not a claim that compiler execution is unnecessary.
- The interpreter is a maintained engine, not a disposable demo.
- Future bytecode, JIT, native, and WebAssembly engines must consume the same language semantics and pass applicable cross-engine conformance checks.
- Replacing the compiler implementation host requires a separate decision and a migration plan that preserves the interpreter mode and behavior.
- There are no third-party runtime dependencies in Phase 1.
- Rust, Cranelift, LLVM/MLIR, Salsa, and other future dependencies require feasibility and license review before adoption.
