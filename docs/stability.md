# OMNI stability and specification policy

OMNI remains pre-1.0 until the 1.0 specification freeze criteria below are met. The Phase 7 hardening and hosted platform evidence is recorded in the [roadmap](roadmap.md) and [support matrix](support-matrix.md). The current implementation reference is [`core-v0.md`](spec/core-v0.md); passing checks do not imply support for undeclared platforms or physical embedded boards.

## Before 1.0

- Core syntax and semantics may change when conformance evidence or implementation experience shows that the current rule is unclear, unsafe, or impractical.
- A behavior change must update the core specification, rationale, migration guidance, runnable examples, and conformance fixtures together.
- Release notes must identify source, configuration, runtime, and build changes that require user action.
- Profiles may select capabilities, libraries, engines, and backends. They cannot create alternate syntax or silently change core behavior.
- A platform is verified only after its declared CI row and relevant target-specific checks pass. A configured but unrun job is not platform evidence.

## 1.0 specification freeze

The proposed freeze scope and maintainer questions are in the [core 1.0 freeze review](spec/core-1.0-freeze-review.md). Draft release notes for [OMNI Core Specification 1.0.0-rc.1](releases/omni-core-v1.0.0-rc.1.md) are prepared but unpublished; no stable specification or release candidate exists yet.

Freeze the first stable core specification only when all of these are true:

1. The normative core specification, grammar, diagnostics, and profile contracts agree with maintained conformance fixtures.
2. The full regression, conformance, deterministic fuzz, formatting, language-server, test-runner, and release-build gates pass.
3. Every platform advertised as supported has passing hosted CI evidence; embedded claims identify whether they are simulator-only or tested on named hardware.
4. Security findings affecting the release are fixed or have a documented, reviewed mitigation and regression case.
5. Compatibility, dependency, migration, performance, and support policies are published and match the release configuration.
6. Maintainers publish a release candidate, gather review of the specification and migration notes, and resolve compatibility-affecting feedback before marking the specification stable.

After 1.0, changes to specified core behavior require an explicitly breaking language release and migration guidance. Additive syntax and semantics require a versioned specification update, examples, and conformance coverage. Patch releases fix defects without changing intended behavior. Profiles remain capability and implementation selections, not dialects.

The Phase 7 optional self-hosted compiler is deferred until an independent OMNI implementation is stable enough to serve as a trustworthy bootstrap and cross-check. Self-hosting is not a prerequisite for 1.0 and must not substitute for cross-engine conformance.
