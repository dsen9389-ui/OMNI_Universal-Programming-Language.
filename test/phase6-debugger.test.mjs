import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

test("omni debug steps through OMNI statements, stops at breakpoints, and inspects values", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "omni-debug-"));
    const programPath = resolve(directory, "main.om");
    try {
        await writeFile(programPath, [
            "var count: Int = 1",
            "count = count + 1",
            "print(count)",
            "",
        ].join("\n"), "utf8");
        const result = spawnSync(process.execPath, [cliPath, "debug", programPath], {
            cwd: projectRoot,
            encoding: "utf8",
            input: "step\nlocals\nbreak 3\ncontinue\nprint count\ncontinue\n",
            timeout: 10_000,
            windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /Paused at .*main\.om:1:1/u);
        assert.match(result.stdout, /Paused at .*main\.om:2:1/u);
        assert.match(result.stdout, /count = 1/u);
        assert.match(result.stdout, /Breakpoint set at .*main\.om:3/u);
        assert.match(result.stdout, /Paused at .*main\.om:3:1/u);
        assert.match(result.stdout, /count = 2/u);
        assert.match(result.stdout, /omni-debug> 2\nProgram completed\./u);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("omni debug reports invalid programs before entering the debugger", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "omni-debug-"));
    const programPath = resolve(directory, "invalid.om");
    try {
        await writeFile(programPath, "let value: Int = true\n", "utf8");
        const result = spawnSync(process.execPath, [cliPath, "debug", programPath], {
            cwd: projectRoot,
            encoding: "utf8",
            input: "",
            timeout: 10_000,
            windowsHide: true,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /error\[E2003\]/u);
        assert.doesNotMatch(result.stderr, /stack trace|at .*\.mjs/u);
        assert.equal(result.stdout, "");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
