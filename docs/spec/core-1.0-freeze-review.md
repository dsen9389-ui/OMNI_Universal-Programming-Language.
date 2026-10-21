# OMNI core 1.0 freeze review

**Status:** prepared for maintainer review; the specification is not frozen and no release candidate has been published.

## Proposed decision

Freeze the implemented language contract in [`core-v0.md`](core-v0.md) as the first stable OMNI core specification. Keep that file as the source of truth. A core specification freeze would stabilize syntax and specified behavior; it would not claim that OMNI's full domain frameworks or production toolchain are complete. Those remain Phase 8 work in the [roadmap](../roadmap.md).

The freeze would exclude features listed in `core-v0.md` under **Explicitly not specified yet**, including generics, type aliases, async, exceptions, memory ownership, configurable effect declarations, and a production native machine-code engine. Adding those later would require a versioned specification update and conformance coverage.

## Evidence for review

- Hosted run [39621297011](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./actions/runs/39621297011), based on commit `85bb38f`, passed all seven Linux, macOS, and Windows CI rows. Each row ran 122 regression checks and 53 conformance cases; hosted regression runs had no skipped tests, including symlink checks.
- The same hosted matrix completed deterministic fuzzing, benchmark sampling, formatting, the maintained OMNI test example, syntax validation, and repeatable release-build checks.
- The security review and remediation evidence is recorded in [`security.md`](../security.md). The scan reviewed 128 of 128 repository files; six validated findings were fixed and follow-up reviews closed the reported terminal-output paths.
- The deterministic fuzz seed and coverage are recorded in [`fuzzing.md`](../fuzzing.md). Windows x64 has a 20-sample benchmark baseline and a successful 100-sample same-machine comparison.

## Support and migration limits

- The host support matrix covers Linux x64 on Node.js 22 and 24, Linux arm64, macOS x64 and arm64, and Windows x64 and arm64 on Node.js 24.
- The web target builds a browser JavaScript application; browser-version support is not declared.
- The embedded target builds freestanding C and runs in the simulator; no physical boards or board support packages are declared.
- Native C ABI code executes with host permissions and must be reviewed and trusted. OMNI does not claim that it is sandboxed.
- Package installation and the production domain frameworks remain deferred.
- Pre-1.0 OMNI has no general source or binary compatibility guarantee. This candidate proposes no migration guarantee for programs that depend on unspecified behavior; supported core behavior must match the maintained conformance fixtures.

## Maintainer review required

Before publishing a core 1.0.0 release candidate, review these points:

1. Is the implemented core, as specified in `core-v0.md`, a suitable stable foundation for Phase 8 frameworks while keeping advanced features explicitly out of scope?
2. Are the host, web, embedded, native-code, and package limits above accurate and clear enough to prevent unsupported production claims?
3. Does the pre-1.0 compatibility statement give current users enough migration guidance, or should a concrete before/after migration note be added before the candidate?

After review, resolve any compatibility-affecting feedback, publish a core-specification release candidate, gather feedback, and only then mark the core specification stable. This review packet is not itself that release candidate.
