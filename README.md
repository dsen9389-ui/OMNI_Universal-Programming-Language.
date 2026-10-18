# OMNI

OMNI is a new programming language project built around one readable core language and configurable execution engines. Its reference interpreter defines the implemented behavior; the bytecode VM and JavaScript compiler add alternate ways to run the shared portable subset.

## Run a program

The current tool uses a supported Node.js LTS release (22 or 24) and has no external package dependencies. The repository's `omni.toml` selects `core-v1`, using the interpreter for development and the JavaScript compiler for release.

    node .\bin\omni.mjs run .\examples\hello.om

Check syntax and types without executing:

    node .\bin\omni.mjs check .\examples\hello.om

Start the one-line REPL:

    node .\bin\omni.mjs repl

On PowerShell, the local wrapper is also available:

    .\omni.ps1 run .\examples\hello.om

Choose a configured engine mode or override the engine directly:

    node .\bin\omni.mjs run .\examples\phase3-portable.om --mode release
    node .\bin\omni.mjs run .\examples\phase3-portable.om --engine bytecode --target host

## Examples and checks

Runnable examples cover functions and recursion, lexical closures, collections, evaluation order, loop control, records, enums, option and result values, matching, list helpers, and modules. `phase3-portable.om` demonstrates the common subset that runs on all three engines. Run the regression suite with:

    node --test

Run the maintained language, engine, and profile conformance suites with:

    node .\conformance\run.mjs

Check the documented host/runtime matrix against the CI workflow with:

    npm run check:support-matrix

Format one source file, or check formatting without writing it:

    node .\bin\omni.mjs fmt .\examples\hello.om
    node .\bin\omni.mjs fmt .\examples\hello.om --check

Run `.test.om` output-snapshot tests in a folder:

    node .\bin\omni.mjs test .\examples\tooling-tests\tests --engine bytecode

Start the editor language server (configure the editor to run this command for `.om` files):

    node .\bin\omni.mjs lsp

The server provides OMNI diagnostics, completion, hover, same-file go-to-definition, and formatting. See [the tooling guide](docs/tooling.md) for its current editor support.

Run a program under the source debugger with `node .\bin\omni.mjs debug .\examples\fibonacci.om`. It supports source stepping, line breakpoints, local-value inspection, and source display in the reference interpreter.

## Current language slice

The interpreter supports immutable and mutable bindings, functions and lexical closures, static name/type checks, inferred local and function return types, runtime-checked annotations, arithmetic and comparison, strict booleans, lists, records, enums, option and result values, exhaustive matching, relative modules, indexing, conditionals, loops, map/filter, comments, and simple {name} string interpolation.

See [the core specification](docs/spec/core-v0.md) for exact behavior, [the roadmap](docs/roadmap.md) for the phase gates, and [the conformance guide](conformance/README.md) for its maintained behavior checks.

## Web and embedded targets

The Phase 4 target builds use the same OMNI source syntax:

    node .\bin\omni.mjs build .\examples\web-app.om --target web
    node .\bin\omni.mjs serve .\examples\build\web

The web build creates a static browser app. `print` writes into its page output panel.

The embedded build emits freestanding C and a local simulator executable. Zig with `zig cc` must be installed for this target:

    node .\bin\omni.mjs build .\examples\embedded-led.om --target embedded
    .\examples\build\embedded\omni-firmware-sim.exe

The embedded APIs are `serial_write(text)` and `gpio_write(pin, high)`. The simulator demonstrates serial output and GPIO changes; it does not claim that a physical board has been tested. See the execution and target matrix in [the core specification](docs/spec/core-v0.md) for the exact backend subset, capabilities, and unsupported forms.

Set a default build target with `[build] target = "web"` or `[build] target = "embedded"` in `omni.toml`; `--target` overrides it.

## Versioned profiles and C interoperability

Profiles are named, versioned combinations of engine or backend, runtime, safety contract, standard library, target, and capabilities. Run `node .\bin\omni.mjs profiles` to list them. Set run and build profiles separately in `omni.toml`, or select one for a command:

    node .\bin\omni.mjs run .\examples\hello.om --profile core-v1
    node .\bin\omni.mjs build .\examples\web-app.om --profile web-v1
    node .\bin\omni.mjs build .\examples\c-interop.om --profile embedded-ffi-v1 --c-source .\examples\c-interop.c

`embedded-ffi-v1` is the explicit native trust boundary. Its C ABI supports checked `Int`/`int32_t`, `Float`/`double`, `Bool`/`bool`, and `Unit`/`void` calls. Native C runs without a sandbox. See [the profile guide](docs/profiles.md), the [C ABI example](examples/c-interop.om), and its [C implementation](examples/c-interop.c).

Pure, versioned OMNI modules in `stdlib/v1/` provide small helpers for scripting, web-response values, game rules, app state, and data processing. Their runnable examples are in [examples/domains](examples/domains). They are not full frameworks: the complete web, game, desktop/mobile, data/AI, systems/embedded, scripting, and sandboxed-plugin frameworks are still required later work. A package registry also remains future work.

## Project status

Phases 1 through 6 are complete for the current workspace. Phase 6 adds `omni fmt`, the snapshot test runner, the initial `omni lsp` editor integration, the interpreter source debugger, repeatable builds for the current web and simulator targets, and a check that keeps the documented host matrix in sync with CI. Local Windows x64 checks passed with Node 24 and Zig 0.17. The seven-row CI matrix is configured but has not yet run on hosted CI because this checkout has no Git remote; see the [support matrix](docs/support-matrix.md). OMNI source code is the language; embedded builds currently use C as a target backend, and C ABI calls are an explicit interoperability feature. The current utility modules are not the requested full frameworks; they remain required later work. Performance, security, compatibility, migration, dependency, and release policies are recorded in [the operational policies](docs/policies.md). The project name OMNI is the selected working name; trademark and package-name clearance remain a separate future task. External build tools and license checks are recorded in [the dependency review](docs/dependencies.md).
