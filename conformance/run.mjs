#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTerminalOutput, formatTerminalText } from "../src/diagnostics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [
    "--test",
    resolve(projectRoot, "test", "conformance.test.mjs"),
    resolve(projectRoot, "test", "phase3-engines.test.mjs"),
    resolve(projectRoot, "test", "phase5-profiles.test.mjs"),
], {
    cwd: projectRoot,
    encoding: "utf8",
});
if (result.stdout) process.stdout.write(formatTerminalOutput(result.stdout));
if (result.stderr) process.stderr.write(formatTerminalOutput(result.stderr));
if (result.error) {
    process.stderr.write("Could not start the conformance suite: " + formatTerminalText(result.error.message) + "\n");
    process.exitCode = 1;
} else {
    process.exitCode = result.status ?? 1;
}
