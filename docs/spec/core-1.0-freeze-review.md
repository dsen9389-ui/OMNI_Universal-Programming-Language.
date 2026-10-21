# OMNI core 1.0 freeze review

**Status:** prepared for maintainer review; the specification is not frozen and no release candidate has been published.

## Proposed decision

Freeze the implemented language syntax and semantics in [`core-v0.md`](core-v0.md) as the first stable OMNI core specification. Keep that file as the source of truth. Freeze the four current profile contracts separately as described in [`profiles.md`](../profiles.md) and [`profiles.json`](../../conformance/profiles.json): an incompatible profile tuple requires a new versioned profile identifier. A broader compatibility model across profile versions is not specified yet. A core specification freeze would not claim that OMNI's full domain frameworks or production toolchain are complete; those remain Phase 8 work in the [roadmap](../roadmap.md).

The freeze would exclude features listed in `core-v0.md` under **Explicitly not specified yet**, including generics, type aliases, async, exceptions, memory ownership, configurable effect declarations, a general compatibility model across profile versions, broader web and embedded support, and a production native machine-code engine. Adding those later would require a versioned specification update and conformance coverage.

## Evidence for review

- Hosted run [39621297011](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./actions/runs/39621297011), based on commit `85bb38f`, passed all seven Linux, macOS, and Windows CI rows. Each row ran 122 regression checks and 53 conformance cases; hosted regression runs had no skipped tests, including symlink checks.
- The same hosted matrix completed deterministic fuzzing, benchmark sampling, formatting, the maintained OMNI test example, syntax validation, and repeatable release-build checks.
- The security review and remediation evidence is recorded in [`security.md`](../security.md). The scan reviewed 128 of 128 repository files; six validated findings were fixed and follow-up reviews closed the reported terminal-output paths.
- The deterministic fuzz seed and coverage are recorded in [`fuzzing.md`](../fuzzing.md). Windows x64 has a 20-sample benchmark baseline and a successful 100-sample same-machine comparison.

## Freeze gate status

| `stability.md` criterion | Evidence and status |
| --- | --- |
| Core specification, grammar, diagnostics, profiles, and conformance agree | Evidence is in `core-v0.md`, `profiles.md`, `profiles.json`, and the 53-case conformance suite. The exact freeze scope is ready for maintainer review. |
| Regression, conformance, fuzz, formatting, tooling, and release-build gates pass | [CI run 39625986073](https://github.com/dsen9389-ui/OMNI_Universal-Programming-Language./actions/runs/39625986073) passed all seven host/runtime rows. |
| Every advertised platform has hosted evidence; embedded scope is stated | All six declared host/architecture combinations are verified. Embedded support is simulator-only; no physical boards are declared. |
| Release security findings are fixed or mitigated with regression coverage | The 128-file security review and six remediated findings are recorded in `security.md`. |
| Compatibility, dependency, migration, performance, and support policies match the release configuration | Policies are published. The proposed initial migration note reflects that no 0.x tag or release exists. |
| Publish a release candidate, review the spec and migration notes, resolve feedback | **Pending maintainer review.** No candidate has been published and no freeze decision has been made. |

## Support and migration limits

- The host support matrix covers Linux x64 on Node.js 22 and 24, Linux arm64, macOS x64 and arm64, and Windows x64 and arm64 on Node.js 24.
- The web target builds a browser JavaScript application; browser-version support is not declared.
- The embedded target builds freestanding C and runs in the simulator; no physical boards or board support packages are declared.
- Native C ABI code executes with host permissions and must be reviewed and trusted. OMNI does not claim that it is sandboxed.
- Package installation and the production domain frameworks remain deferred.
- Pre-1.0 OMNI has no general source or binary compatibility guarantee. The proposed freeze makes no migration guarantee for programs that depend on unspecified behavior; supported core behavior must match the maintained conformance fixtures.
- GitHub currently has no published tags or releases, and the npm package is private. Proposed migration note: “OMNI has no released 0.x compatibility baseline. Check pre-release programs against the stable core specification and update any code that relied on unspecified behavior; no source or binary migration guarantee is provided.”

## Maintainer review required

Before publishing a core 1.0.0 release candidate, review these points:

1. Are the core syntax and semantics plus the four current versioned profile contracts a suitable stable foundation for Phase 8 frameworks? Is the current rule for incompatible profile tuples sufficient, with a broader cross-version compatibility model deferred?
2. Are the host, web, embedded, native-code, and package limits above accurate and clear enough to prevent unsupported production claims?
3. Do you distribute pre-release builds outside this repository to users who need a before/after migration guide? There are no published tags or releases, so the note above assumes there is no supported 0.x migration baseline.

After review, resolve any compatibility-affecting feedback, publish a core-specification release candidate, gather feedback, and only then mark the core specification stable. This review packet is not itself that release candidate.
