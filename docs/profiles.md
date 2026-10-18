# OMNI versioned profiles

A profile is one named, versioned set of engine, target, runtime, safety, standard-library, and capability choices. Choose one profile for a run or build; OMNI does not ask users to combine independent mode switches. Profile definitions are stable contracts. An incompatible contract needs a new profile version.

Run `node .\\bin\\omni.mjs profiles` to list the profiles available in this release.

| Profile | Operation and target | Execution/backend | Runtime | Safety contract | Standard library and capabilities |
| --- | --- | --- | --- | --- | --- |
| `core-v1` | Run on `host` | `interpreter`, `bytecode`, or `javascript` | Node.js | Static type checks and runtime contracts | Core library; `output` |
| `web-v1` | Build for `web` | JavaScript compiler | Browser | Static type checks and runtime contracts | Core and page output; `output` |
| `embedded-v1` | Build for `embedded` | Freestanding C; host simulator uses Zig on Linux/Windows and Apple Clang on macOS | Freestanding | Scalar type checks and checked arithmetic | Core and embedded I/O; `output`, `serial`, `gpio` |
| `embedded-ffi-v1` | Build for `embedded` | Freestanding C; host simulator uses Zig on Linux/Windows and Apple Clang on macOS | Freestanding | Checked scalar core with an explicit unsafe C boundary | Core, embedded I/O, and C ABI v1; `output`, `serial`, `gpio`, `c-abi` |

The current project configuration selects a profile separately for running and building:

    [run]
    profile = "core-v1"
    development = "interpreter"
    release = "javascript"
    target = "host"

    [build]
    profile = "web-v1"
    target = "web"

The two sections describe different commands; a web project can still use the host profile for checks and development runs. `--profile` overrides the profile for one command. If a build profile is selected without a target, the profile supplies its target. An explicit conflicting target is rejected with a source-located diagnostic. If no build profile is configured, `--target web` selects `web-v1` and `--target embedded` selects `embedded-v1`.

The machine-readable supported and rejected combinations are recorded in [the profile conformance matrix](../conformance/profiles.json). Tests compare that matrix with the runtime registry and check selection through the CLI and project configuration.

## C ABI v1

Native calls require the explicit `embedded-ffi-v1` profile. Declare a C function in OMNI with `extern fn`; the OMNI name must match a portable C symbol and may not be a C keyword, `main`, or use the reserved `omni_` prefix. All parameter types and any result type must be explicit. The supported mapping is deliberately small:

| OMNI type | C type | Boundary behavior |
| --- | --- | --- |
| `Int` | `int32_t` | Checked for a whole value in the signed 32-bit range at each call. |
| `Float` | `double` | Passed directly. |
| `Bool` | `bool` | Passed directly. |
| `Unit` result (omit `->`) | `void` | Call has no result. |

Text, pointers, records, callbacks, and binary-library discovery are not part of C ABI v1. Native C code is trusted and can violate memory or platform safety; OMNI does not sandbox it. Provide one or more C source files when building, and implement the declared symbols there:

    node .\\bin\\omni.mjs check .\\examples\\c-interop.om
    node .\\bin\\omni.mjs build .\\examples\\c-interop.om --profile embedded-ffi-v1 --c-source .\\examples\\c-interop.c
    .\\examples\\build\\embedded\\omni-firmware-sim.exe

The same checked `.om` declaration can be inspected with `omni check`, but native calls cannot run on the interpreter, bytecode VM, JavaScript engine, or web profile. Those combinations fail before program effects. `examples/c-interop.om` and `examples/c-interop.c` are the maintained, runnable demonstration.

## Domain libraries

The versioned source modules in `stdlib/v1/` are ordinary OMNI modules with no new syntax or package manager. Examples under `examples/domains/` import each module and run on `core-v1`:

- `scripting.om` models explicit dry-run and retry choices.
- `web.om` builds and checks simple response values; it does not provide a network server.
- `games.om` contains deterministic turn and score rules; it does not add graphics or randomness.
- `apps.om` contains UI-independent screen-state decisions.
- `data.om` provides typed list totals and counts.

These are small maintained standard-library slices, not claims that OMNI already ships full web, game-engine, UI, or data-platform frameworks. New library APIs stay in source modules until their stability, target support, and lifecycle are specified. Package registries and third-party dependency installation remain deferred; see [the dependency review](dependencies.md).
