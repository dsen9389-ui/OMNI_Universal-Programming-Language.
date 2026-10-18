import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

function build(examplePath, target, outputDirectory) {
    return spawnSync(process.execPath, [cliPath, "build", examplePath, "--target", target, "--out-dir", outputDirectory, "--verify-reproducible"], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: target === "embedded" ? 120_000 : 20_000,
        windowsHide: true,
    });
}

test("web release builds include verified SHA-256 artifacts and repeat exactly", async () => {
    const root = await mkdtemp(resolve(projectRoot, ".phase6-release-"));
    const firstDirectory = resolve(root, "first");
    const secondDirectory = resolve(root, "second");
    try {
        await mkdir(firstDirectory);
        await mkdir(secondDirectory);
        const examplePath = resolve(projectRoot, "examples", "web-app.om");
        const first = build(examplePath, "web", firstDirectory);
        assert.equal(first.status, 0, first.stderr);
        assert.match(first.stdout, /Repeatable build verified/u);
        const firstManifest = JSON.parse(await readFile(resolve(firstDirectory, "omni-build.json"), "utf8"));
        assert.equal(firstManifest.manifestVersion, 1);
        assert.equal(firstManifest.target, "web");
        assert.ok(firstManifest.artifacts.length > 0);
        assert.deepEqual(firstManifest.artifacts.map((item) => item.path), [...firstManifest.artifacts.map((item) => item.path)].sort());
        for (const artifact of firstManifest.artifacts) {
            const actual = createHash("sha256").update(await readFile(resolve(firstDirectory, artifact.path))).digest("hex");
            assert.equal(actual, artifact.sha256, "manifest hash matches " + artifact.path);
        }

        const rebuilt = build(examplePath, "web", firstDirectory);
        assert.equal(rebuilt.status, 0, rebuilt.stderr);
        const rebuiltManifest = JSON.parse(await readFile(resolve(firstDirectory, "omni-build.json"), "utf8"));
        assert.deepEqual(rebuiltManifest, firstManifest);

        const second = build(examplePath, "web", secondDirectory);
        assert.equal(second.status, 0, second.stderr);
        const secondManifest = JSON.parse(await readFile(resolve(secondDirectory, "omni-build.json"), "utf8"));
        assert.deepEqual(secondManifest, firstManifest);
    } finally {
        const workspace = resolve(projectRoot);
        const target = resolve(root);
        assert.ok(target.startsWith(workspace + sep), "release fixtures stay inside the workspace");
        await rm(target, { recursive: true, force: true });
    }
});

test("embedded release builds repeat exactly with the installed C compiler", async () => {
    const root = await mkdtemp(resolve(projectRoot, ".phase6-embedded-release-"));
    const outputDirectory = resolve(root, "embedded");
    try {
        await mkdir(outputDirectory);
        const examplePath = resolve(projectRoot, "examples", "embedded-led.om");
        const result = build(examplePath, "embedded", outputDirectory);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Repeatable build verified/u);
        const manifest = JSON.parse(await readFile(resolve(outputDirectory, "omni-build.json"), "utf8"));
        assert.equal(manifest.target, "embedded");
        assert.equal(manifest.backend, "freestanding-c");
        for (const artifact of manifest.artifacts) {
            const actual = createHash("sha256").update(await readFile(resolve(outputDirectory, artifact.path))).digest("hex");
            assert.equal(actual, artifact.sha256, "manifest hash matches " + artifact.path);
        }
    } finally {
        const workspace = resolve(projectRoot);
        const target = resolve(root);
        assert.ok(target.startsWith(workspace + sep), "embedded release fixtures stay inside the workspace");
        await rm(target, { recursive: true, force: true });
    }
});

test("benchmark usage errors escape terminal control characters", () => {
    const benchmarkPath = resolve(projectRoot, "scripts", "benchmark.mjs");
    const result = spawnSync(process.execPath, [benchmarkPath, "--\u001b[31m"], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    assert.match(result.stderr, /\\u\{1b\}/u);
});

test("web builds reject symlinked output roots, artifact files, and runtime directories", async (t) => {
    const root = await mkdtemp(resolve(projectRoot, ".phase7-build-boundary-"));
    const outputDirectory = resolve(root, "output");
    const outside = resolve(root, "outside");
    const sentinel = resolve(outside, "sentinel.txt");
    try {
        await mkdir(outputDirectory);
        await mkdir(outside);
        await writeFile(sentinel, "keep this file\n", "utf8");
        try {
            await symlink(sentinel, resolve(outputDirectory, "index.html"), "file");
        } catch (error) {
            if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
                t.skip("this Windows account cannot create symbolic links");
                return;
            }
            throw error;
        }

        const examplePath = resolve(projectRoot, "examples", "web-app.om");
        const artifactAttack = build(examplePath, "web", outputDirectory);
        assert.notEqual(artifactAttack.status, 0);
        assert.equal(await readFile(sentinel, "utf8"), "keep this file\n");

        await rm(resolve(outputDirectory, "index.html"), { force: true });
        try {
            await symlink(outside, resolve(outputDirectory, "omni-runtime"), "junction");
        } catch (error) {
            if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
                t.skip("this Windows account cannot create directory symbolic links");
                return;
            }
            throw error;
        }
        const directoryAttack = build(examplePath, "web", outputDirectory);
        assert.notEqual(directoryAttack.status, 0);
        assert.equal(await readFile(sentinel, "utf8"), "keep this file\n");

        const linkedRoot = resolve(root, "linked-output");
        await symlink(outside, linkedRoot, "junction");
        const rootAttack = build(examplePath, "web", linkedRoot);
        assert.notEqual(rootAttack.status, 0);
        assert.equal(await readFile(sentinel, "utf8"), "keep this file\n");
    } finally {
        const workspace = resolve(projectRoot);
        const target = resolve(root);
        assert.ok(target.startsWith(workspace + sep), "build boundary fixtures stay inside the workspace");
        await rm(target, { recursive: true, force: true });
    }
});

test("embedded builds do not let the compiler follow a symlinked executable destination", async (t) => {
    const root = await mkdtemp(resolve(projectRoot, ".phase7-embedded-boundary-"));
    const outputDirectory = resolve(root, "output");
    const outside = resolve(root, "outside");
    const binaryName = process.platform === "win32" ? "omni-firmware-sim.exe" : "omni-firmware-sim";
    const sentinel = resolve(outside, "sentinel.txt");
    try {
        await mkdir(outputDirectory);
        await mkdir(outside);
        await writeFile(sentinel, "keep this file\n", "utf8");
        try {
            await symlink(sentinel, resolve(outputDirectory, binaryName), "file");
        } catch (error) {
            if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
                t.skip("this Windows account cannot create symbolic links");
                return;
            }
            throw error;
        }

        const examplePath = resolve(projectRoot, "examples", "embedded-led.om");
        const result = build(examplePath, "embedded", outputDirectory);
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(sentinel, "utf8"), "keep this file\n");
    } finally {
        const workspace = resolve(projectRoot);
        const target = resolve(root);
        assert.ok(target.startsWith(workspace + sep), "embedded boundary fixtures stay inside the workspace");
        await rm(target, { recursive: true, force: true });
    }
});
