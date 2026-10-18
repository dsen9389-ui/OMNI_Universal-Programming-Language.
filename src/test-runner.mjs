import { spawnSync } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWriteFile } from "./safe-filesystem.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = resolve(projectRoot, "bin", "omni.mjs");
const skippedDirectories = new Set([".git", "build", "dist", "node_modules"]);
const testTimeoutMs = 10_000;

export async function runTestSuite(testDirectory, options = {}) {
    const root = await realpath(resolve(testDirectory));
    const files = (await findTests(root)).sort((left, right) => left.localeCompare(right));
    const results = [];
    for (const sourcePath of files) {
        results.push(await runOneTest(root, sourcePath, options));
    }
    return {
        directory: root,
        results,
        passed: results.filter((result) => result.status === "passed").length,
        failed: results.filter((result) => result.status === "failed").length,
        updated: results.filter((result) => result.status === "updated").length,
    };
}

async function findTests(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && !skippedDirectories.has(entry.name)) {
                files.push(...await findTests(resolve(directory, entry.name)));
            }
        } else if (entry.isFile() && entry.name.endsWith(".test.om")) {
            files.push(resolve(directory, entry.name));
        }
    }
    return files;
}

async function runOneTest(root, sourcePath, options) {
    const relativeName = relative(root, sourcePath).replaceAll("\\", "/");
    const expectedPath = sourcePath.slice(0, -".test.om".length) + ".expected.txt";
    const args = [cliPath, "run", sourcePath];
    if (options.engine) args.push("--engine", options.engine);
    const child = spawnSync(process.execPath, args, {
        cwd: dirname(sourcePath),
        encoding: "utf8",
        timeout: testTimeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });

    if (child.error) {
        const message = child.error.code === "ETIMEDOUT"
            ? "test exceeded the 10 second execution limit"
            : "could not start OMNI: " + child.error.message;
        return { name: relativeName, status: "failed", message, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
    }
    if (child.status !== 0) {
        return {
            name: relativeName,
            status: "failed",
            message: "program exited with status " + child.status,
            stdout: child.stdout,
            stderr: child.stderr,
        };
    }
    if (child.stderr) {
        return { name: relativeName, status: "failed", message: "program wrote unexpected error output", stdout: child.stdout, stderr: child.stderr };
    }

    const actual = normalizeNewlines(child.stdout);
    if (options.update) {
        await safeWriteFile(root, relative(root, expectedPath), actual);
        return { name: relativeName, status: "updated", stdout: actual, stderr: "" };
    }

    let expected;
    try {
        expected = normalizeNewlines(await readFile(expectedPath, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") {
            return { name: relativeName, status: "failed", message: "could not read expected output: " + error.message, stdout: actual, stderr: "" };
        }
        return { name: relativeName, status: "failed", message: "missing " + relative(root, expectedPath) + "; review the output and run with --update", stdout: actual, stderr: "" };
    }
    if (actual !== expected) {
        return {
            name: relativeName,
            status: "failed",
            message: firstDifference(expected, actual),
            stdout: actual,
            stderr: "",
        };
    }
    return { name: relativeName, status: "passed", stdout: actual, stderr: "" };
}

function firstDifference(expected, actual) {
    const expectedLines = expected.split("\n");
    const actualLines = actual.split("\n");
    const count = Math.max(expectedLines.length, actualLines.length);
    for (let index = 0; index < count; index += 1) {
        if (expectedLines[index] !== actualLines[index]) {
            return "output differs at line " + (index + 1) +
                "\n  expected: " + (expectedLines[index] ?? "<end of output>") +
                "\n  received: " + (actualLines[index] ?? "<end of output>");
        }
    }
    return "output differs";
}

function normalizeNewlines(value) {
    return value.replace(/\r\n|\r/gu, "\n");
}
