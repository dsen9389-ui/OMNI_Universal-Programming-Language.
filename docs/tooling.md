# OMNI developer tools

This page documents the Phase 6 tools currently available in the bootstrap toolchain. Each tool uses the same parser, checker, project configuration, and execution engine as the regular CLI commands.

## Formatter

Format one `.om` file in place:

    node .\bin\omni.mjs fmt .\examples\hello.om

Check a file without changing it:

    node .\bin\omni.mjs fmt .\examples\hello.om --check

The formatter first parses the complete file. It normalizes spaces, indentation, trailing whitespace, and line endings while keeping the token sequence, comments, and existing line breaks. A parse error leaves the file untouched. `--check` exits with status 1 when formatting is needed.

## Snapshot test runner

Test files end in `.test.om`; expected output is stored beside each file with the same basename and `.expected.txt` suffix:

    examples/tooling-tests/tests/addition.test.om
    examples/tooling-tests/tests/addition.expected.txt

Run the suite with the configured development engine or select one explicitly:

    node .\bin\omni.mjs test .\examples\tooling-tests\tests
    node .\bin\omni.mjs test .\examples\tooling-tests\tests --engine bytecode

OMNI discovers test files recursively, executes them as regular programs, and compares printed output after normalizing Windows and Unix line endings. A nonzero program exit, timeout, unexpected error output, missing snapshot, or output difference fails the test. `--update` writes the current output to each `.expected.txt` file; review those changes before accepting them. Tests run with the same operating-system permissions as the OMNI process.

This first test runner provides integration and output regression checks. It does not yet provide isolated per-function assertions, coverage reports, or expected-error snapshots.

## Editor language server

Start the standard input/output language server:

    node .\bin\omni.mjs lsp

Configure an editor to launch that command from the OMNI project folder for `.om` files. The server implements the Language Server Protocol over `Content-Length` framed JSON-RPC. It publishes diagnostics from OMNI's parser and type checker and provides completion, hover, go-to-definition, and formatting. Unsaved buffers are checked in memory, including imported files that are open in the editor. The server does not print status text to standard output, so the protocol stream stays valid.

This initial editor integration provides same-file symbol navigation and basic declaration completion; it does not yet provide refactoring, semantic rename, debugger controls, or language-aware auto-imports.

## Source debugger

Run a checked program with the reference interpreter under the source debugger:

    node .\bin\omni.mjs debug .\examples\fibonacci.om

Execution pauses before its first executable statement. Enter `step` to advance one OMNI statement, `continue` to run to the next breakpoint, `break <line>` to set a breakpoint in the current source file, `break <file>:<line>` to target another file, `clear <line>` to remove one, `locals` to list visible values, `print <name>` to inspect one value, `where` to show the current source line, or `quit` to end the session. The debugger checks types before running and steps through source statements, including statements inside called functions and imported modules. It uses the reference interpreter; it does not attach to bytecode, JavaScript, or native processes.

## Repeatable release builds

Every web and embedded build writes an `omni-build.json` manifest containing the selected profile, toolchain details, native source hashes where relevant, and SHA-256 hashes for each generated artifact. Verify a build locally by compiling the target twice into separate clean output directories:

    node .\bin\omni.mjs build .\examples\web-app.om --target web --out-dir .\build\web --verify-reproducible
    node .\bin\omni.mjs build .\examples\embedded-led.om --target embedded --out-dir .\build\embedded --verify-reproducible

The command compares the complete manifests from the requested build and a second clean build. This verifies repeatability on the current machine and with the currently installed toolchain; it does not by itself establish bit-for-bit reproducibility across different operating systems or compiler versions. CI runs this check for both build targets on each configured host.

The embedded simulator uses Zig's C compiler on Linux and Windows, and Apple Clang from Xcode Command Line Tools on macOS. Apple Clang keeps a content-derived Mach-O UUID across clean builds. On Windows, the build clears volatile PE timestamps, the CodeView identifier, and the debug-directory reference before hashing. The simulator does not ship a PDB file, so its generated debug-directory reference would point to an unavailable file and would make otherwise identical builds differ.
