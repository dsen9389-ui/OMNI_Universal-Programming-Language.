import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

async function temporarySuite() {
    const directory = await mkdtemp(resolve(projectRoot, ".phase6-test-runner-"));
    const tests = resolve(directory, "tests");
    await mkdir(tests);
    return { directory, tests };
}

async function cleanup(directory) {
    const root = resolve(projectRoot);
    const target = resolve(directory);
    assert.ok(target.startsWith(root + sep), "test-runner fixtures stay inside the workspace");
    await rm(target, { recursive: true, force: true });
}

function run(args) {
    return spawnSync(process.execPath, [cliPath, "test", ...args], { cwd: projectRoot, encoding: "utf8" });
}

test("omni test discovers output snapshots and can select an engine", async () => {
    const suite = await temporarySuite();
    try {
        await writeFile(resolve(suite.tests, "addition.test.om"), [
            "fn add(left: Int, right: Int) -> Int {",
            "    return left + right",
            "}",
            'print("2 + 3 =", add(2, 3))',
            "",
        ].join("\n"), "utf8");
        await writeFile(resolve(suite.tests, "addition.expected.txt"), "2 + 3 = 5\n", "utf8");
        await writeFile(resolve(suite.tests, "helper.om"), "print(\"not a test\")\n", "utf8");

        const result = run([suite.tests, "--engine", "bytecode"]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS  addition\.test\.om/u);
        assert.match(result.stdout, /OMNI test: 1 passed, 0 failed/u);
    } finally {
        await cleanup(suite.directory);
    }
});

test("omni test reports the first snapshot difference and a missing snapshot", async () => {
    const suite = await temporarySuite();
    try {
        const sourcePath = resolve(suite.tests, "value.test.om");
        await writeFile(sourcePath, 'print("actual")\n', "utf8");
        await writeFile(resolve(suite.tests, "value.expected.txt"), "expected\n", "utf8");
        const mismatch = run([suite.tests]);
        assert.equal(mismatch.status, 1);
        assert.match(mismatch.stderr, /output differs at line 1/u);
        assert.match(mismatch.stderr, /expected: expected/u);
        assert.match(mismatch.stderr, /received: actual/u);

        await rm(resolve(suite.tests, "value.expected.txt"));
        const missing = run([suite.tests]);
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /missing .*value\.expected\.txt/u);
    } finally {
        await cleanup(suite.directory);
    }
});

test("omni test escapes program control characters in failure output", async () => {
    const suite = await temporarySuite();
    try {
        await writeFile(resolve(suite.tests, "controls.test.om"), 'print("\u001b[31munsafe\u001b[0m")\n');
        await writeFile(resolve(suite.tests, "controls.expected.txt"), "safe\n");
        const result = run([suite.tests]);
        assert.equal(result.status, 1, result.stderr);
        assert.doesNotMatch(result.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
        assert.match(result.stderr, /\\u\{1b\}/u);
    } finally {
        await cleanup(suite.directory);
    }
});

test("omni test --update writes a snapshot only when explicitly requested", async () => {
    const suite = await temporarySuite();
    try {
        await writeFile(resolve(suite.tests, "hello.test.om"), 'print("hello")\n', "utf8");
        const updated = run([suite.tests, "--update"]);
        assert.equal(updated.status, 0, updated.stderr);
        assert.match(updated.stdout, /1 snapshots updated/u);
        assert.equal(await readFile(resolve(suite.tests, "hello.expected.txt"), "utf8"), "hello\n");
        const verified = run([suite.tests]);
        assert.equal(verified.status, 0, verified.stderr);
        assert.match(verified.stdout, /1 passed, 0 failed/u);
    } finally {
        await cleanup(suite.directory);
    }
});

test("omni test --update refuses snapshot symlinks that point outside the suite", async (t) => {
    const suite = await temporarySuite();
    const outsidePath = resolve(suite.directory, "outside.txt");
    const sourcePath = resolve(suite.tests, "unsafe.test.om");
    const snapshotPath = resolve(suite.tests, "unsafe.expected.txt");
    try {
        await writeFile(sourcePath, 'print("new snapshot")\n', "utf8");
        await writeFile(outsidePath, "preserve this file\n", "utf8");
        try {
            await symlink(outsidePath, snapshotPath, "file");
        } catch (error) {
            if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
                t.skip("this Windows account cannot create symbolic links");
                return;
            }
            throw error;
        }

        const result = run([suite.tests, "--update"]);
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(outsidePath, "utf8"), "preserve this file\n");
        assert.match(result.stderr, /symbolic link/u);
    } finally {
        await cleanup(suite.directory);
    }
});

test("omni test reports an empty suite clearly", async () => {
    const suite = await temporarySuite();
    try {
        const result = run([suite.tests]);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /no \*\.test\.om files found/u);
    } finally {
        await cleanup(suite.directory);
    }
});
