# OMNI contributor notes

- Treat docs/spec/core-v0.md as the source of truth for implemented language behavior.
- Keep OMNI straightforward for people to write and understand in every phase. Human readability is an acceptance condition, not optional polish.
- Prefer familiar, consistent constructs and a small number of predictable ways to express common work. Defer features whose ordinary use requires a difficult mental model or unnecessary ceremony.
- Keep the source syntax canonical across future profiles. Profiles may select semantics, capabilities, libraries, and backends; they must not create syntax dialects.
- Preserve the phase gates in docs/roadmap.md. Do not add speculative backends, domain frameworks, package registries, or configuration axes to the initial interpreter.
- The bootstrap implementation is dependency-free JavaScript running on Node.js. Keep lexer, parser, interpreter, diagnostics, and CLI responsibilities separate.
- New syntax needs a specification update and a runnable .om example that demonstrates clear, readable use. Significant new semantics and APIs also need examples and a short rationale for their complexity.
- Diagnostics should identify the source location and give a direct explanation. Never expose internal stack traces for normal language errors.
- Do not report Phase 1 complete until its roadmap exit condition has been verified; tell the user when it is met.
- Do not copy third-party implementation code into this repository. Any future dependency needs a recorded license review.
