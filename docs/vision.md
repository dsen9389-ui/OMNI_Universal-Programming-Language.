# OMNI vision

OMNI aims to be one programming language that can grow from scripting into native, web, application, game, data, systems, and embedded work. Its universality comes from a small shared language and reusable ecosystem foundations, not from putting every domain feature into the core.

The central architectural goal is semantic consistency: the same source language should be able to feed an interpreter and later compiler backends. Profiles can select a target, runtime policy, and available capabilities while leaving the syntax and formatter unchanged.

The project will earn that ambition in phases. The first deliverable is a usable interpreter with clear diagnostics. Native compilation, memory strategies, effect checking, interop, domain libraries, and editor tooling come only after the core language has real programs and a stable specification.

## Principles

1. Keep OMNI simple for humans to write and understand in every phase. Prefer familiar, consistent constructs, low ceremony, and behavior that is straightforward to explain and review.
2. Define behavior before adding syntax.
3. Reuse mature infrastructure when it fits and its license is acceptable.
4. Keep one canonical syntax across profiles.
5. Make errors understandable and source-located.
6. Build a complete, runnable slice at each phase gate.
7. Mark unsupported capabilities plainly; do not imply a backend or guarantee exists before it does.

## Human simplicity gate

This requirement applies to the language core, libraries, profiles, configuration, and developer tools throughout the roadmap. Evaluate proposals from the point of view of someone reading or writing an ordinary OMNI program, not only from the point of view of the implementation.

- Keep common programs direct and readable. Prefer a small number of predictable constructs over overlapping syntax, hidden behavior, or special cases.
- Make advanced capabilities opt-in when they would otherwise make the everyday language harder to learn or reason about.
- Before a feature advances, provide a runnable example showing its ordinary use and explain its behavior in plain language. If the example is hard to read or explain, simplify or defer the feature.
- Keep profiles and engines on the same source syntax and preserve the same specified meaning for portable programs.
