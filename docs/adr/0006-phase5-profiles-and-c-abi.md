# ADR 0006: Versioned profiles and the first C ABI

Status: accepted for Phase 5.

## Decision

OMNI exposes a small set of immutable, named profiles. Each profile fixes its operation, target, engine/backend, runtime, safety contract, standard library, and capabilities. The initial profiles are `core-v1`, `web-v1`, `embedded-v1`, and `embedded-ffi-v1`. Run and build profiles are selected independently in their existing `[run]` and `[build]` config sections. A target can be inferred from a build profile, but conflicting choices fail before source effects.

Native interoperability begins with top-level `extern fn` declarations in the `embedded-ffi-v1` profile. C ABI v1 maps `Int` to checked `int32_t`, `Float` to `double`, `Bool` to C `bool`, and an omitted or `Unit` result to `void`. Users supply C source files explicitly to the embedded build. The C implementation is trusted and unsandboxed. No text pointers, callbacks, binary library discovery, or platform SDK integration is implied.

Small domain utility modules are versioned as ordinary OMNI source under `stdlib/v1/`. Their examples cover scripting, web response data, game rules, application state, and typed list processing. They add no syntax dialects, host services, framework claims, or runtime dependency.

## Rationale

Named profiles give users one readable choice and prevent unsupported combinations from appearing valid. Keeping the profile tuple fixed makes target/runtime/safety/library claims reviewable and gives conformance tests a finite matrix. A separate FFI profile makes the trust boundary visible at the command line and in build metadata. Fixed-width C integer mapping is common and permits explicit range checks instead of passing OMNI's binary64-backed Int representation through an ambiguous native ABI.

Pure source modules are reusable with the existing import system. They let OMNI demonstrate real domain logic while keeping package distribution, network servers, UI toolkits, graphics, and third-party dependencies out of the phase until their target and lifecycle contracts are ready.

## Consequences

- Profile IDs are compatibility contracts; incompatible tuples need new IDs.
- `core-v1` supports the current host engines; `web-v1` and `embedded-v1` are build-only; C calls require `embedded-ffi-v1`.
- The C source file set and its license remain the caller's responsibility. OMNI only reviews and records tools it distributes or requires for its maintained builds.
- Profiles and domain examples are covered by `conformance/profiles.json` and the profile matrix tests.
- Package registry and dependency workflows remain deferred until OMNI defines lockfile integrity, version selection, source trust, and reproducible acquisition requirements.
