# OMNI operational policies

These policies define how OMNI makes and supports production claims. The current bootstrap release is pre-1.0. Hosted CI evidence covers every declared toolchain host; embedded execution is verified in the simulator, and no physical board support is declared.

## Performance

- Do not publish a speed or memory claim without a named workload, OMNI version, engine/profile, runtime version, operating system, architecture, and measurement method.
- Compare performance only on the same machine and toolchain. Record warm-up and repeated samples; report the median and spread rather than the fastest sample.
- Treat a repeatable median regression of 10% or more on a maintained workload as a release investigation item. Confirm that the workload and environment did not change before attributing it to OMNI.
- Correctness, conformance, and bounded resource behavior take priority over speed. No optimization may change specified behavior or remove source-located failure handling.
- `npm run benchmark` records compile and execution medians plus spread for the same loop workload across the interpreter, bytecode VM, and JavaScript compiler. Reports include a workload hash and machine fingerprint; compare only matching environments. The CI workflow records small samples for each configured host, while the 10% same-machine regression threshold remains an investigation trigger rather than a cross-host speed claim.
- `npm run fuzz` runs a deterministic parser/checker corpus, including long operator chains and nested syntax. It never executes generated programs. Keep minimized failures in the maintained corpus and rerun the exact seed before closing a fix.

## Security and trust boundaries

- Running OMNI source executes with the operating-system permissions of the OMNI process. The interpreter, web build, and snapshot test runner are not sandboxes.
- The embedded C ABI executes linked native code without isolation. The `unsafe` profile is an explicit trust boundary; callers must review and trust each native source.
- Do not describe the simulator or platform hooks as hardware isolation. A future plugin sandbox needs a documented capability model and isolation evidence before it can be called secure.
- Module imports must follow the specified relative `.om` rules. There is no automatic package download or package registry in the current toolchain.
- Keep normal source errors source-located and free of internal JavaScript stack traces. Do not interpolate OMNI source into shell commands; pass arguments as separate process arguments.
- Review a dependency's upstream and transitive licenses, update path, platform support, and integrity controls before adding it. See [the dependency review](dependencies.md).
- Security findings must be reproduced against a maintained version, assessed for affected profiles and targets, fixed or documented with a mitigation, and included in regression coverage before a patched release is described as verified.

## Dependency policy

The bootstrap toolchain uses Node.js built-in modules only. External build tools are versioned and reviewed in [the dependency record](dependencies.md). Do not copy third-party compiler implementation code into OMNI. Package installation remains deferred until lockfiles, source trust, content integrity, offline behavior, and reproducible acquisition are specified.

## Compatibility

- `docs/spec/core-v0.md` is the source of truth for currently implemented language behavior. The shared source syntax stays canonical across profiles.
- Versioned profiles may choose capabilities, libraries, execution engines, and backends. They must not redefine syntax or silently alter the core semantics.
- The current project is pre-1.0 and provides no general source or binary compatibility guarantee. A checked profile/conformance matrix describes tested behavior for each release candidate.
- A breaking change to specified behavior needs a specification update, a rationale, migration guidance, and conformance fixtures. Do not call unsupported engine/target combinations compatible.
- Runtime support is limited to the Node.js lines documented in [the dependency policy](dependencies.md) and exercised by the CI matrix. An unrun hosted matrix is configured support, not verified support.

## Migration

- Every change that requires users to edit source, configuration, generated files, or build commands needs a migration note with a before/after example.
- When a safe, deterministic conversion can be implemented, provide a tool mode that previews changes before writing them. Do not make migration tools destructive by default.
- Keep old and new documented behavior distinct during any transition. Include fixtures for accepted old input, migrated output, and rejected ambiguous input.
- Update the core spec, profile registry, examples, tooling docs, and conformance matrix together when a change affects more than one of those contracts.

## Release and platform claims

- A build manifest records its target, profile, compiler where relevant, and SHA-256 hashes of generated artifacts. `--verify-reproducible` compares two clean builds on the current host. Embedded C builds remap the generated source root to a stable relative path. The macOS host simulator uses Apple Clang so Mach-O images keep a content-derived UUID; Windows simulator builds clear volatile PE timestamps and remove the debug-directory reference because no matching PDB is distributed.
- A release candidate must pass the regression suite, language conformance suite, syntax checks, maintained examples, and repeatable-build checks on every platform claimed as verified.
- Report a platform as configured until its CI job has actually passed. Report physical embedded board support only after builds and runtime behavior are checked on that board.
- Record dependency licenses and external compiler versions before creating a distributable release. Do not call the current simulator executable a device firmware release.
