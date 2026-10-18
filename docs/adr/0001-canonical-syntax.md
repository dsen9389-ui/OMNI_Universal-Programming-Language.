# ADR-0001: One canonical syntax

**Status:** Accepted

## Decision

OMNI uses braces for blocks, no required semicolons, # line comments, and one canonical syntax across profiles.

## Context

The attached plans differ on indentation-based blocks versus braces. Both insist that profiles must not create different surface dialects. The second plan gives the stronger tooling rationale for braces: predictable parsing, macros, and code generation. A single syntax is more important than matching either language's visual style.

## Consequences

- The first implementation uses explicit { ... } blocks.
- Newlines are whitespace; statements are separated by their grammar rather than indentation.
- Semicolons are not part of the initial grammar.
- Profile configuration may affect runtime and capabilities, never parsing rules.
- The syntax can be reconsidered before a stability commitment if real usage shows a clear problem.
