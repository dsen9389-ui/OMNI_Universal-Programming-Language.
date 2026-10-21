# OMNI host and target support

The machine-readable host matrix is in [support-matrix.json](support-matrix.json). `npm run check:support-matrix` checks that its host/runtime rows match the CI workflow and that required verification steps are present. CI runs this consistency check, syntax checks, the full regression suite (including the language server, debugger, and reproducible web and embedded builds), conformance, formatting, and snapshot-runner checks on the declared host rows. It runs Node.js 22 and 24 on Linux x64 and Node.js 24 across the remaining host rows. The workflow checksum-verifies Zig 0.17.0; embedded simulator builds use Zig on Linux and Windows, and Apple Clang from Xcode Command Line Tools on macOS.

| Host | Architecture | CI runner | Declared toolchain status |
| --- | --- | --- | --- |
| Linux | x64 | `ubuntu-24.04` | Verified on Node.js 22 and 24 |
| Linux | arm64 | `ubuntu-24.04-arm` | Verified on Node.js 24 |
| macOS | Intel x64 | `macos-15-intel` | Verified on Node.js 24 |
| macOS | Apple silicon arm64 | `macos-15` | Verified on Node.js 24 |
| Windows | x64 | `windows-2025` | Verified on Node.js 24 |
| Windows | arm64 | `windows-11-arm` | Verified on Node.js 24 |

The host matrix describes where OMNI's CLI and local checks run. It does not claim that every target artifact runs on every host. The web backend currently emits a browser JavaScript application; specific browser-version support is not declared. The embedded backend emits freestanding C and an executable simulator; Zig compiles the simulator on Linux and Windows, and Apple Clang from Xcode Command Line Tools compiles it on macOS. Physical boards and board support packages remain unverified.

Hosted CI run [39621297011](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./actions/runs/39621297011) passed all seven rows: Linux x64 on Node.js 22 and 24, Linux arm64, both macOS architectures, Windows x64, and Windows arm64. Each row completed the 122-test regression suite, 53 conformance cases, deterministic fuzzing, benchmark sampling, formatting, and the maintained OMNI example; all regression suites ran symlink cases with no skips. Windows CI fetches the public source into the runner's temporary directory because Windows normalizes the trailing period in the repository-derived workspace. The `.gitattributes` rule keeps OMNI sources at LF on every host, matching the formatter's documented line-ending normalization.
