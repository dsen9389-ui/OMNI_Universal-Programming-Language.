import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTerminalText } from "../src/diagnostics.mjs";
import { validateSupportMatrix } from "../src/support-matrix.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(projectRoot, "docs", "support-matrix.json");
const workflowPath = resolve(projectRoot, ".github", "workflows", "ci.yml");
const [matrixText, workflow] = await Promise.all([
    readFile(matrixPath, "utf8"),
    readFile(workflowPath, "utf8"),
]);

let matrix;
try {
    matrix = JSON.parse(matrixText);
} catch (error) {
    process.stderr.write("OMNI support matrix check: invalid JSON: " + formatTerminalText(error.message) + "\n");
    process.exitCode = 1;
}

if (matrix) {
    const errors = validateSupportMatrix(matrix, workflow);
    if (errors.length > 0) {
        for (const error of errors) process.stderr.write("OMNI support matrix check: " + formatTerminalText(error) + "\n");
        process.exitCode = 1;
    } else {
        const hosts = matrix.toolchainHosts.length;
        const rows = (workflow.match(/^[ \t]+- label:/gmu) ?? []).length;
        process.stdout.write("OMNI support matrix check: " + rows + " CI rows cover " + hosts + " declared hosts\n");
    }
}
