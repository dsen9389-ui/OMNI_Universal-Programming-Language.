# Current non-goals

These are explicit exclusions for the first interpreter milestone:

- Native, JIT, WebAssembly, C, or JavaScript compilation.
- Static type inference, generic types, traits, enums, pattern matching, or user-defined record types.
- Async functions, threads, actors, GPU work, or concurrency guarantees.
- Garbage collection selection, ownership checking, arenas, manual allocation, or a memory-model profile system.
- Modules, imports, dependency resolution, package registry, build files, and project scaffolding.
- Filesystem and network APIs in the language standard library.
- LSP, debugger, formatter, test runner, and generated editor grammars.
- Full expression interpolation inside strings; the initial interpreter interpolates simple variable names.

These features remain possible later, but each needs a specification decision and a phase-appropriate acceptance gate.
