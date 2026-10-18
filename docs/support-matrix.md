# OMNI host and target support

The machine-readable host matrix is in [support-matrix.json](support-matrix.json). `npm run check:support-matrix` checks that its host/runtime rows match the CI workflow and that required verification steps are present. CI runs this consistency check, syntax checks, the full regression suite (including the language server, debugger, and reproducible web and embedded builds), conformance, formatting, and snapshot-runner checks on the declared host rows. It runs Node.js 22 and 24 on Linux x64 and Node.js 24 across the remaining host rows. Zig 0.17.0 is downloaded from the official index and its published SHA-256 checksum is verified before embedded simulator tests run.

| Host | Architecture | CI runner | Declared toolchain status |
| --- | --- | --- | --- |
| Linux | x64 | `ubuntu-24.04` | CI configured |
| Linux | arm64 | `ubuntu-24.04-arm` | CI configured |
| macOS | Intel x64 | `macos-15-intel` | CI configured |
| macOS | Apple silicon arm64 | `macos-15` | CI configured |
| Windows | x64 | `windows-2025` | CI configured |
| Windows | arm64 | `windows-11-arm` | CI configured |

The host matrix describes where OMNI's CLI and local checks run. It does not claim that every target artifact runs on every host. The web backend currently emits a browser JavaScript application; specific browser-version support is not declared. The embedded backend emits freestanding C and an executable simulator. Physical boards and board support packages remain unverified.

The workflow is configured in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). This workspace has no Git repository or remote, so the workflow has not yet run on hosted CI; its first green run on each row is required before describing that row as externally verified.
