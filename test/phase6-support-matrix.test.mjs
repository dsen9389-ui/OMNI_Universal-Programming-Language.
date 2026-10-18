import assert from "node:assert/strict";
import test from "node:test";
import { validateSupportMatrix } from "../src/support-matrix.mjs";

const matrix = {
    schemaVersion: 1,
    runtime: { supportedMajorVersions: [22, 24] },
    toolchainHosts: [
        { operatingSystem: "Linux", architecture: "x64", runner: "ubuntu-24.04" },
        { operatingSystem: "macOS", architecture: "arm64", runner: "macos-15" },
    ],
};

const requiredSteps = [
    "node scripts/install-zig.mjs",
    "npm run check:syntax",
    "npm run check:support-matrix",
    "npm test",
    "npm run test:conformance",
    "npm run fuzz",
    "node scripts/benchmark.mjs --samples 5 --warmups 1",
    "node bin/omni.mjs fmt examples/tooling-tests/tests/addition.test.om --check",
    "node bin/omni.mjs test examples/tooling-tests/tests --engine javascript",
];

function workflow(rows) {
    return [
        "strategy:",
        "  matrix:",
        "    include:",
        ...rows.flatMap(([runner, node]) => [
            "      - label: host",
            "        runner: " + runner,
            "        node: " + node,
        ]),
        ...requiredSteps,
        "",
    ].join("\n");
}

test("support matrix accepts the configured host and runtime rows", () => {
    assert.deepEqual(validateSupportMatrix(matrix, workflow([
        ["ubuntu-24.04", 22],
        ["ubuntu-24.04", 24],
        ["macos-15", 24],
    ])), []);
});

test("support matrix identifies missing, extra, and duplicate CI rows", () => {
    const errors = validateSupportMatrix(matrix, workflow([
        ["ubuntu-24.04", 24],
        ["macos-15", 24],
        ["unlisted-runner", 24],
    ]));
    assert.ok(errors.some((error) => error.includes("missing declared host/runtime row 'ubuntu-24.04@22'")));
    assert.ok(errors.some((error) => error.includes("undeclared host/runtime row 'unlisted-runner@24'")));

    const duplicates = validateSupportMatrix(matrix, workflow([
        ["ubuntu-24.04", 22],
        ["ubuntu-24.04", 22],
        ["ubuntu-24.04", 24],
        ["macos-15", 24],
    ]));
    assert.ok(duplicates.some((error) => error.includes("duplicate host/runtime rows")));
});
