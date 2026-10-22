# OMNI Core Specification 1.0.0-rc.1

- **Release type:** specification pre-release.
- **Tag:** [`omni-core-v1.0.0-rc.1`](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./releases/tag/omni-core-v1.0.0-rc.1)
- **Published:** 2026-10-22 from commit `2c631c6051f3e105f4f713ab1437cb3a8631e682`.
- **Status:** public review candidate. The core is not frozen, and this is not an OMNI toolchain or framework release.

## Purpose

This candidate proposes the first stable OMNI core language specification after maintainer review. It covers the canonical syntax and implemented behavior in [`core-v0.md`](../spec/core-v0.md) and the four current versioned profile contracts in [`profiles.md`](../profiles.md) and [`profiles.json`](../../conformance/profiles.json). It does not claim completion of OMNI's production toolchain or the Phase 8 domain frameworks.

## Review scope

- Confirm the core syntax and semantics are a suitable stable foundation for the planned frameworks.
- Confirm the four current profile contracts and the rule that an incompatible tuple gets a new versioned profile identifier.
- Confirm the documented support limits and the migration note below.

The freeze excludes the features listed in `core-v0.md` as not yet specified, including general-purpose generics, async, exceptions, memory ownership, broad cross-version profile migration policy, broader web and embedded support, and a production native machine-code engine.

## Verification

- Hosted CI run [39715305781](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./actions/runs/39715305781) passed all seven declared host/runtime rows for the published commit.
- The maintained gates include regression tests, language conformance, deterministic fuzzing, formatting, the OMNI test example, syntax checks, and repeatable web and embedded builds.
- Security review and remediation evidence is in [`security.md`](../security.md).
- Full freeze readiness and open maintainer questions are in the [review packet](../spec/core-1.0-freeze-review.md).

## Supported scope and limits

- The host matrix covers Linux x64 on Node.js 22 and 24, Linux arm64, macOS x64 and arm64, and Windows x64 and arm64 on Node.js 24.
- The interpreter implements the full specified core. The bytecode and JavaScript engines and the web target support documented subsets; unsupported constructs fail with source-located errors.
- The web target emits a browser JavaScript application; browser-version support is not declared.
- The embedded target builds freestanding C and runs in the simulator. Physical boards and board support packages are not declared.
- Native C ABI code is trusted and unsandboxed.
- Package installation and production domain frameworks remain future work.

## Migration note

OMNI has no released 0.x compatibility baseline, and the npm package is private. Check pre-release programs against the candidate core specification and update code that relies on unspecified behavior; no source or binary migration guarantee is provided.

## Candidate status

This document records the published prerelease. Gather and resolve compatibility-affecting feedback, including the maintainer review questions in the freeze packet, before declaring the core specification stable.
