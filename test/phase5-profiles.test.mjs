import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_PROJECT_CONFIG, parseProjectConfig, resolveBuildSelection, resolveExecutionSelection } from "../src/config.mjs";
import { OmniDiagnostic } from "../src/diagnostics.mjs";
import { availableProfiles, validateProfileProgram } from "../src/profiles.mjs";
import { parseSource } from "../src/frontend.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

function cli(args) {
    return spawnSync(process.execPath, [cliPath, ...args], { cwd: projectRoot, encoding: "utf8" });
}

function profileContract(profile) {
    return {
        id: profile.id,
        version: profile.version,
        kind: profile.kind,
        target: profile.target,
        engines: [...profile.engines],
        backend: profile.backend,
        runtime: profile.runtime,
        safety: profile.safety,
        standardLibrary: profile.standardLibrary,
        capabilities: [...profile.capabilities],
        cAbi: profile.cAbi,
    };
}

test("profile registry matches the versioned conformance matrix", () => {
    const matrix = JSON.parse(readFileSync(resolve(projectRoot, "conformance", "profiles.json"), "utf8"));
    assert.equal(matrix.schemaVersion, 1);
    assert.deepEqual(availableProfiles().map(profileContract), matrix.profiles);
});

test("every supported profile and engine combination resolves as documented", () => {
    const matrix = JSON.parse(readFileSync(resolve(projectRoot, "conformance", "profiles.json"), "utf8"));
    for (const profile of matrix.profiles) {
        if (profile.kind === "run") {
            for (const engine of profile.engines) {
                const selection = resolveExecutionSelection(
                    { ...DEFAULT_PROJECT_CONFIG, runProfile: profile.id },
                    { engine, engineSpecified: true },
                    "<profile-matrix>",
                    "",
                );
                assert.deepEqual(selection, { mode: "development", engine, target: profile.target, profile: profile.id });
            }
            continue;
        }
        const selection = resolveBuildSelection(
            DEFAULT_PROJECT_CONFIG,
            { profile: profile.id, profileSpecified: true },
            "<profile-matrix>",
            "",
        );
        assert.deepEqual(selection, {
            target: profile.target,
            profile: profile.id,
            backend: profile.backend,
            cAbi: profile.cAbi,
        });
    }
});

test("unsupported profile combinations fail at a source location", () => {
    assert.throws(
        () => resolveExecutionSelection(DEFAULT_PROJECT_CONFIG, { profile: "web-v1" }, "selection.om", ""),
        (error) => error instanceof OmniDiagnostic && error.code === "E3003" && error.span.line === 1,
    );
    assert.throws(
        () => resolveBuildSelection(DEFAULT_PROJECT_CONFIG, { profile: "web-v1", profileSpecified: true, target: "embedded" }, "selection.om", ""),
        (error) => error instanceof OmniDiagnostic && error.code === "E3003" && error.span.line === 1,
    );
    assert.throws(
        () => resolveExecutionSelection(DEFAULT_PROJECT_CONFIG, { engine: "unknown", engineSpecified: true }, "selection.om", ""),
        (error) => error instanceof OmniDiagnostic && error.code === "E3001" && error.span.line === 1,
    );
});

test("every rejected combination in the profile matrix has an executable check", () => {
    const matrix = JSON.parse(readFileSync(resolve(projectRoot, "conformance", "profiles.json"), "utf8"));
    for (const row of matrix.unsupported) {
        let action;
        let expectedCode = "E3003";
        if (row.effect === "c-abi") {
            const source = "extern fn read_value() -> Int";
            action = () => validateProfileProgram(parseSource(source, "matrix.om"), { sourceName: "matrix.om", sourceText: source }, row.profile);
            expectedCode = "E3002";
        } else if (row.command === "run" && row.engine) {
            action = () => resolveExecutionSelection(DEFAULT_PROJECT_CONFIG, { profile: row.profile, engine: row.engine, engineSpecified: true }, "matrix.om", "");
            expectedCode = "E3001";
        } else if (row.command === "run") {
            action = () => resolveExecutionSelection(DEFAULT_PROJECT_CONFIG, { profile: row.profile }, "matrix.om", "");
        } else {
            action = () => resolveBuildSelection(DEFAULT_PROJECT_CONFIG, { profile: row.profile, profileSpecified: true, target: row.target }, "matrix.om", "");
        }
        assert.throws(action, (error) => error instanceof OmniDiagnostic && error.code === expectedCode, row.reason);
    }
});

test("project configuration selects separate run and build profiles", () => {
    const parsed = parseProjectConfig([
        "[run]",
        'profile = "core-v1"',
        'development = "interpreter"',
        'release = "javascript"',
        'target = "host"',
        "[build]",
        'profile = "web-v1"',
        'target = "web"',
        "",
    ].join("\n"), "profiles.toml");
    assert.equal(parsed.runProfile, "core-v1");
    assert.equal(parsed.buildProfile, "web-v1");
    assert.throws(
        () => parseProjectConfig('[run]\nprofile = "future-profile"\n', "profiles.toml"),
        (error) => error instanceof OmniDiagnostic && error.code === "E3006" && error.span.line === 2,
    );
});

test("profile CLI lists the supported versioned presets", () => {
    const result = cli(["profiles"]);
    assert.equal(result.status, 0, result.stderr);
    for (const profile of availableProfiles()) assert.match(result.stdout, new RegExp("^" + profile.id + "\\t", "mu"));
});

test("web build manifest records its selected profile and capabilities", async () => {
    const outDirectory = await mkdtemp(resolve(tmpdir(), "omni-web-profile-v1-"));
    try {
        const example = resolve(projectRoot, "examples", "web-app.om");
        const result = cli(["build", example, "--profile", "web-v1", "--out-dir", outDirectory]);
        assert.equal(result.status, 0, result.stderr);
        const metadata = JSON.parse(await readFile(resolve(outDirectory, "omni-build.json"), "utf8"));
        assert.equal(metadata.profile, "web-v1");
        assert.deepEqual(metadata.capabilities, ["output"]);
    } finally {
        const tempRoot = resolve(tmpdir());
        assert.ok(resolve(outDirectory).startsWith(tempRoot + sep), "temporary web artifacts stay inside the OS temp directory");
        await rm(outDirectory, { recursive: true, force: true });
    }
});

test("invalid profile combinations in omni.toml are rejected before source effects", () => {
    const conflict = resolve(projectRoot, "conformance", "config-errors", "profile-conflict", "main.om");
    const conflictResult = cli(["build", conflict]);
    assert.equal(conflictResult.status, 1);
    assert.equal(conflictResult.stdout, "");
    assert.match(conflictResult.stderr, /omni\.toml:2:1: error\[E3003\]: profile 'web-v1' requires build target 'web'/u);

    const wrongCommand = resolve(projectRoot, "conformance", "config-errors", "build-profile-run", "main.om");
    const runResult = cli(["run", wrongCommand]);
    assert.equal(runResult.status, 1);
    assert.equal(runResult.stdout, "");
    assert.match(runResult.stderr, /omni\.toml:2:1: error\[E3003\]: profile 'web-v1' is a build profile/u);
});

test("native C declarations require the explicit unsafe profile and source file", () => {
    const source = "extern fn read_value() -> Int";
    const context = { sourceName: "ffi.om", sourceText: source };
    const program = parseSource(source, context.sourceName);
    assert.throws(
        () => validateProfileProgram(program, context, "embedded-v1"),
        (error) => error instanceof OmniDiagnostic && error.code === "E3002" && error.span.line === 1,
    );
    assert.throws(
        () => validateProfileProgram(program, context, "embedded-ffi-v1"),
        (error) => error instanceof OmniDiagnostic && error.code === "E3005" && error.span.line === 1,
    );
    assert.doesNotThrow(() => validateProfileProgram(program, context, "embedded-ffi-v1", { cSources: ["read-value.c"] }));
});

const domainExamples = [
    ["scripting", "Scripting can run = true\n"],
    ["web", "Web status = 200\nResponse body = Hello from an OMNI response model\nSuccessful response = true\n"],
    ["games", "Next player = 3\nScore reached goal = true\n"],
    ["apps", "Show loading = true\nShow empty state = true\n"],
    ["data", "Total = 38\nReadings above 10 = 2\n"],
];

for (const [name, expectedOutput] of domainExamples) {
    test("core-v1 domain library example runs: " + name, () => {
        const example = resolve(projectRoot, "examples", "domains", name + ".om");
        const result = cli(["run", example, "--profile", "core-v1"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.replace(/\r\n/gu, "\n"), expectedOutput);
    });
}

test("an external C ABI declaration is rejected before host program output", () => {
    const example = resolve(projectRoot, "conformance", "ffi", "host-ffi.om");
    const result = cli(["run", example]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /host-ffi\.om:1:1: error\[E3002\]: C ABI declarations require the 'embedded-ffi-v1' profile/u);
});
