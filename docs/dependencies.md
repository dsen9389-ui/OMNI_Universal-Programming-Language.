# External tool and license review

This page records tools used to build OMNI and the license checks completed for them. OMNI does not copy external compiler implementation code into this repository.

| Tool | Use | Version exercised | License review | Distribution |
| --- | --- | --- | --- | --- |
| Node.js | Runs the dependency-free JavaScript bootstrap, CLI, and tests. | 24.20.0 on Windows | The repository uses built-in APIs only and does not redistribute Node.js. | Installed separately; not bundled by this repository. |
| Zig | `zig cc` compiles the embedded simulator executable on Linux and Windows. | 0.17.0 on Linux and Windows | Upstream `LICENSE` reviewed; MIT (Expat). Recheck the exact release license before pinning or redistributing a Zig toolchain. | External build tool; neither the Zig compiler nor its source is vendored. |
| Apple Clang (Xcode Command Line Tools) | Compiles the host simulator adapter on macOS, preserving a content-derived Mach-O UUID for repeatable builds. | macOS 15 CI image; exact Clang version is recorded in the build manifest. | Apple Clang is obtained from the system Xcode Command Line Tools; OMNI does not copy, bundle, or redistribute it. Follow Apple's Xcode and Command Line Tools license terms. | System developer tool; no compiler binary or implementation is vendored. |
| `actions/checkout` | Checks out source in the Linux and macOS CI jobs. | v7.0.1, pinned to `3d3c42e5aac5ba805825da76410c181273ba90b1` | Upstream `LICENSE` reviewed; MIT. | GitHub-hosted CI action; implementation is not copied into OMNI. |
| Git CLI | Fetches the public source ref into the Windows runner's temporary directory, avoiding invalid repository-derived workspace paths. | Runner-provided Git on Windows 2025 and Windows 11 ARM | Upstream [`COPYING`](https://github.com/git/git/blob/master/COPYING) reviewed; GPL-2.0. | Already installed on hosted runners; OMNI does not bundle or redistribute Git. |
| `actions/setup-node` | Selects Node.js 22 or 24 in the CI workflow. | v7.1.0, pinned to `949feb2413d6458794dcd2491c4babbbce0c15c1` | Upstream `LICENSE` reviewed; MIT. | GitHub-hosted CI action; implementation is not copied into OMNI. |

Zig's upstream license: <https://github.com/ziglang/zig/blob/master/LICENSE>.

## Runtime support policy

OMNI supports Node.js 22 and 24, both maintained LTS release lines when this policy was updated on 2026-10-18. The CLI and package metadata reject other major versions rather than claiming support for end-of-life or current-only lines. Recheck the [upstream release schedule](https://nodejs.org/en/about/previous-releases) during each Phase 6 compatibility review and change the supported range only with a CI-tested update.

The embedded firmware C output depends on the small OMNI platform-hook header and the platform functions described in the core specification. The simulator adapter is OMNI source. Zig builds the host simulator on Linux and Windows; Apple Clang from Xcode Command Line Tools builds it on macOS. This record does not claim that a physical board SDK or a board-specific runtime has been reviewed.

Before introducing a runtime or build dependency, record its purpose, version or range, upstream license, and whether any code or binaries are redistributed. Review transitive licenses and compatibility before adding a package manager or distributing a bundled toolchain.

## Package workflow status

OMNI currently supports explicit relative `.om` imports only; it has no package registry or automatic dependency installation. A package workflow remains deferred until the project defines the package manifest format, version resolution and lockfile rules, content hashes, registry/source trust model, offline behavior, and reproducible acquisition requirements. The current domain modules are checked-in OMNI source under `stdlib/v1/`, so users can inspect and version them with the project.
