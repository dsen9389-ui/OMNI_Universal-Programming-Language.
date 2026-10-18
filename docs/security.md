# OMNI security review record

OMNI is pre-1.0. This record tracks the security review and remediation evidence required before a stable release; it does not claim that running OMNI source is sandboxed.

## Repository review — 2026-10-18

- Review: Codex Security scan `fed88324-9b5f-41d5-80a7-3244a54fb0d6` reviewed 128 of 128 repository files and validated six findings: three medium and three low.
- Independent review: three read-only reviews were used in the discovery and remediation workflow. Follow-up reviews found and closed terminal-output paths in CLI commands and developer scripts. The final follow-up identified one remaining terminal-spoofing path in benchmark CPU metadata; it now uses the same terminal sanitizer.
- Findings and fixes:
  - Build generation and embedded executable installation now validate output paths, reject symlinked or non-regular destinations, and keep temporary compiler output under the selected output root.
  - macOS's `/var` and `/tmp` aliases are canonicalized only when they resolve to the expected `/private` system directories; other symlinked path components remain rejected.
  - Snapshot updates use the same safe output-writing checks and reject symlinked snapshot files.
  - Imported module targets must have the canonical `.om` extension, including when an import resolves through a symlink.
  - The language server bounds incomplete protocol headers to 8 KiB before accepting a body, whose existing limit is 16 MiB.
  - The parser rejects expression trees deeper than 128 with source-located `E1026` before recursive checking or compilation.
  - Terminal diagnostics, CLI messages, test results, and developer-script output escape control and bidirectional formatting characters.
- Regression coverage: release, test-runner, module, language-server, parser, diagnostic, CLI, benchmark, and subprocess-output tests cover these boundaries. Windows denied symlink creation for four local cases, so those cases were skipped locally; the configured Linux CI jobs must execute them before a cross-platform release claim.
- Local evidence: Windows x64 with Node 24 and checksum-verified Zig 0.17 passed `npm test` (122 checks: 118 passed, four symlink cases skipped), `node conformance/run.mjs` (53 passed), syntax validation (46 modules), support-matrix validation (seven rows across six hosts), deterministic fuzzing (1,200 token cases, five adversarial cases, and 256 pure expression cases across all three engines), web and embedded repeatable builds, and a 100-sample, 20-warmup same-machine benchmark comparison. Hosted CI has not run because this workspace has no Git repository or remote.

## Ongoing requirements

- Re-run the regression and conformance suites after each security-sensitive change.
- Re-run the deterministic parser/checker fuzzer with its recorded seed and retain minimized regressions.
- Review every dependency, including transitive licenses, source trust, integrity, update path, and platform support before adoption.
- Treat profiles, web output, the embedded simulator, and the snapshot runner as untrusted-code execution boundaries. They are not sandboxes.
- Record remaining findings and unsupported platforms plainly. Do not claim a release guarantee from configured CI rows or simulator-only evidence.
