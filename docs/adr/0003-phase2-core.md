# ADR 0003: Phase 2 static core and data types

## Status

Accepted for the Phase 2 implementation.

## Context

Phase 1 provides a small dynamic interpreter. Phase 2 adds compile-time checking and useful data modeling, but the language must remain direct to read and must keep one syntax across future engines and targets. The implementation must continue to use the existing dependency-free JavaScript front end and interpreter.

## Decisions

- Add static name and type checking between parsing and execution. `omni check` checks the complete project without running it; `omni run` checks it before interpreting it. Runtime checks remain as a safety net.
- Infer local binding types from their initial values and infer function return types from their bodies. Unannotated function parameters remain `Any`, preserving the low-ceremony Phase 1 path. Annotations opt a function into precise argument and result checking. User-defined generic functions are deferred.
- Add `record` declarations with typed fields. Construct records with named arguments, such as `Person(name: "Ada", age: 36)`, and read or update fields with familiar dot access.
- Add `enum` declarations with named variants and optional positional payloads. Use qualified names such as `LoadState.Ready("done")` so variant names cannot collide across enums.
- Use `Option[T]` and `Result[T, E]` as the standard optional and fallible values. Preserve `T?` as short syntax for `Option[T]`; use `none` and the small constructors `some`, `ok`, and `err`.
- Add statement-form `match` with one block per case. The checker verifies enum, option, result, boolean, and unit exhaustiveness. `_` provides a clear catch-all for open value types.
- Add `import "./path.om" as name`. Imports resolve relative to the importing file, modules expose their top-level declarations through the alias, and cyclic imports are rejected. There is no package registry or global search path in this phase.
- Add `map` and `filter` for list processing. They use ordinary functions, visit a shallow snapshot in order, and return new lists.
- Keep record, enum, module, and standard-library semantics in the single interpreter and core specification. No engine, target, profile, or configuration option is introduced in this phase.

## Rationale

Named record arguments keep construction understandable when a type has several fields. Qualified enum variants make the owning type visible at the use site. Block-based match cases follow existing control-flow syntax and keep multi-step case behavior easy to scan. `Option` and `Result` make missing values and expected failures explicit without adding exceptions or a second error-propagation syntax. Relative imports work for real multi-file programs while keeping module lookup predictable and avoiding package-management complexity. `Any` for unannotated parameters preserves simple scripts; explicit signatures provide compile-time guarantees when needed.

## Consequences

The parser, checker, interpreter, CLI project loader, specification, examples, and conformance cases must agree on these rules. The type checker reports unsupported or invalid programs before side effects occur. Runtime validation remains in place for embedding APIs and defensive safety. Phase 2 does not add general generics, async, exceptions, package management, native code generation, profiles, or target-specific syntax.
