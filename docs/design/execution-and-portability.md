# Execution and portability contract

OMNI must support both interpretation and compiler-backed execution. These are execution choices for one language, not separate dialects.

## User-facing selection

The current host run profile uses this project configuration shape:

    [run]
    profile = "core-v1"
    development = "interpreter"
    release = "javascript"
    target = "host"

Build profiles are selected separately:

    [build]
    profile = "web-v1"
    target = "web"

The CLI can override it:

    omni run app.om --engine interpreter
    omni run app.om --engine javascript --profile core-v1
    omni build app.om --target web

`[run] profile` and `[build] profile` select named, versioned tuples independently. `--profile` overrides the current command's profile; a build profile can supply its target. An explicit incompatible target or engine fails instead of silently substituting another execution mode. `omni profiles` lists the supported tuples.

## Shared semantics

Every engine implements the same versioned language specification and uses the same core conformance cases. Programs in the portable core must have the same specified observable behavior across applicable engines. Differences in speed and output format are not semantic differences. Target-specific effects and explicitly implementation-defined behavior must be documented.

The tree-walking interpreter is a maintained engine. It remains useful for interactive work and scripts and provides a reference when compiler engines are added.

## Cross-domain model

Web and embedded targets have different capabilities. OMNI does not promise that a program using network sockets can run on a microcontroller. Phase 4 established target capabilities, and Phase 5 names compatible configurations as profiles:

- The canonical syntax and portable `print` API are the same on every target.
- Built-in target sets declare `output` for host and web, and `output`, `serial`, and `gpio` for embedded.
- Effects are inferred from direct built-in calls. The CLI rejects unavailable effects before source execution or build.
- `serial_write(text)` and `gpio_write(pin, high)` expose platform facilities that do not have portable core equivalents.
- `core-v1` runs the host engines; `web-v1` builds browser apps; `embedded-v1` builds freestanding scalar programs; `embedded-ffi-v1` opts into the documented unsafe C ABI boundary.
- A profile fixes its runtime, safety contract, standard library, capabilities, and supported engine/backend. The conformance matrix records both accepted and rejected combinations.
- Domain helpers are versioned source modules. They do not add target-specific syntax or silently import platform capabilities.

The cross-domain acceptance gate is concrete: documented web and embedded examples build through the same OMNI CLI; the browser demo runs in a browser, and generated freestanding C runs in the included embedded simulator. Each backend's language subset and target capabilities are stated in `docs/spec/core-v0.md`. The simulator is not physical board validation.

## Engine interface

Front ends produce one syntax/semantic representation and dispatch to a named engine or build backend. The versioned profile registry records each supported engine/backend, runtime, target, safety, standard-library, and capability tuple. Profile selection must never change parsing rules or source meaning.

Phase 1 exposes the interpreter through this interface. Phase 3 defines the common representation and adds compiler-backed execution.
