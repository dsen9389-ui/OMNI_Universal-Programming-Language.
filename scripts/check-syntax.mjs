import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatTerminalOutput } from "../src/diagnostics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectories = ["bin", "conformance", "scripts", "src", "test"];

async function collectJavaScript(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...await collectJavaScript(path));
        else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
    }
    return files;
}

const files = (await Promise.all(sourceDirectories.map((directory) => collectJavaScript(resolve(projectRoot, directory)))))
    .flat()
    .sort((left, right) => left.localeCompare(right));
let failures = 0;
for (const file of files) {
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
    if (checked.status === 0) continue;
    failures += 1;
    process.stderr.write(formatTerminalOutput(checked.stderr || checked.stdout || "JavaScript syntax check failed") + "\n");
}

if (failures > 0) {
    process.stderr.write("OMNI syntax check: " + failures + " of " + files.length + " files failed\n");
    process.exitCode = 1;
} else {
    process.stdout.write("OMNI syntax check: " + files.length + " JavaScript files passed\n");
}
