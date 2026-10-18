# ADR 0005: Phase 4 web and embedded targets

## Status

Accepted for Phase 4.

## Decision

Keep one source syntax and add two build targets. The web target compiles the existing portable JavaScript subset into a browser app with a small copied runtime; the core `print` API writes into an accessible page output panel. The embedded target emits freestanding C against a tiny serial/GPIO platform interface and builds a local simulator adapter with Zig's C compiler.

Declare target capabilities centrally and infer effects from direct calls to built-ins. `print` requires `output`; `serial_write` requires `serial`; and `gpio_write` requires `gpio`. Host and web provide `output`; embedded provides all three capabilities. Reject unsupported effects with E3004 before any source program runs or target build is written.

Keep target-specific APIs small and visible: serial output and digital pin state are facilities that the language's portable output API cannot express. Their names and call syntax are the same in every source file; target selection determines whether they are available. Do not add effect annotations, profile combinations, or alternate syntax in this phase.

## Rationale

Reusing the JavaScript compiler and runtime makes the browser path consistent with the Phase 3 release engine. Static ES modules keep the output inspectable and avoid a web bundler dependency. The embedded C path reuses Zig's C compiler instead of adding compiler implementation code or requiring users to install a full vendor SDK just to build the simulator.

The embedded backend has stricter limits because general lists, closures, dynamic text construction, and module loading require memory and runtime contracts that Phase 4 has not defined. Its diagnostics name the unsupported construct at its source location; the full interpreter remains available for host programs. The simulator demonstrates the generated platform boundary without claiming support for an untested physical board.

## Consequences

- `omni build` supports `web` and `embedded`; build target selection can be set in `[build]` or overridden on the CLI.
- The web output is a static directory that can be previewed with OMNI's localhost-only `serve` command or hosted by another static server.
- The embedded C backend is freestanding at the generated firmware boundary and requires only the declared platform hooks. The included native simulator adapter uses host standard I/O.
- Target capability sets and each backend's exact language subset are specified in `docs/spec/core-v0.md`.
- No runtime package dependency is added. Zig is an external build tool; its compiler is not copied into the repository.
