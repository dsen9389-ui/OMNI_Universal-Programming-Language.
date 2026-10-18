import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildEmbedded } from "../src/build.mjs";
import { parseSource } from "../src/frontend.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");
const examplePath = resolve(projectRoot, "examples", "c-interop.om");
const cSourcePath = resolve(projectRoot, "examples", "c-interop.c");

async function tempDirectory() {
    return mkdtemp(resolve(tmpdir(), "omni-ffi-v1-"));
}

async function removeTempDirectory(directory) {
    const root = resolve(tmpdir());
    const target = resolve(directory);
    assert.ok(target.startsWith(root + sep), "temporary C ABI artifacts stay inside the OS temp directory");
    await rm(target, { recursive: true, force: true });
}

test("embedded-ffi-v1 links a C source and runs Int, Float, Bool, and Unit calls", async () => {
    const outputDirectory = await tempDirectory();
    try {
        const built = spawnSync(process.execPath, [
            cliPath,
            "build",
            examplePath,
            "--profile",
            "embedded-ffi-v1",
            "--c-source",
            cSourcePath,
            "--out-dir",
            outputDirectory,
        ], { cwd: projectRoot, encoding: "utf8" });
        assert.equal(built.status, 0, built.stderr);
        assert.match(built.stdout, /profile embedded-ffi-v1/u);

        const metadata = JSON.parse(await readFile(resolve(outputDirectory, "omni-build.json"), "utf8"));
        assert.equal(metadata.profile, "embedded-ffi-v1");
        assert.equal(metadata.cAbi, "c-int32-float64-bool-v1");
        assert.deepEqual(metadata.capabilities, ["output", "serial", "gpio", "c-abi"]);
        assert.equal(metadata.nativeSources.length, 1);
        assert.equal(metadata.nativeSources[0].name, "c-interop.c");
        assert.match(metadata.nativeSources[0].sha256, /^[0-9a-f]{64}$/u);
        assert.equal(typeof metadata.compilerVersion, "string");

        const output = execFileSync(resolve(outputDirectory, "omni-firmware-sim.exe"), [], { encoding: "utf8" });
        assert.equal(output.replace(/\r\n/gu, "\n"), [
            "OMNI calling a C sensor",
            "[C] pin 13 measured 3.3 volts, ready=true",
            "[sim] GPIO 13 = high",
            "C ABI call succeeded",
            "",
        ].join("\n"));
    } finally {
        await removeTempDirectory(outputDirectory);
    }
});

test("C ABI Int arguments outside int32 range fail before entering C code", async () => {
    const outputDirectory = await tempDirectory();
    try {
        const source = (await readFile(examplePath, "utf8")).replace("calibrated_pin(10, 3)", "calibrated_pin(2147483648, 3)");
        const context = { sourceName: examplePath, sourceText: source };
        const program = parseSource(source, examplePath);
        const artifact = await buildEmbedded(program, context, outputDirectory, {
            profile: "embedded-ffi-v1",
            cSources: [cSourcePath],
        });
        assert.throws(
            () => execFileSync(artifact.executable, [], { encoding: "utf8" }),
            (error) => error.status === 1 && /error\[E1021\]: C ABI Int arguments must be whole numbers in the signed 32-bit range/u.test(String(error.stderr)),
        );
    } finally {
        await removeTempDirectory(outputDirectory);
    }
});

test("C ABI Float results retain OMNI's finite-number contract", async () => {
    const outputDirectory = await tempDirectory();
    try {
        const source = [
            "extern fn read_voltage() -> Float",
            "let voltage = read_voltage()",
            'print("this line must not run")',
        ].join("\n");
        const sourceName = "native-float.om";
        const cSourcePath = resolve(outputDirectory, "native-float.c");
        await writeFile(cSourcePath, [
            "double read_voltage(void) {",
            "    volatile double zero = 0.0;",
            "    return 1.0 / zero;",
            "}",
            "",
        ].join("\n"), "utf8");
        const artifact = await buildEmbedded(parseSource(source, sourceName), { sourceName, sourceText: source }, outputDirectory, {
            profile: "embedded-ffi-v1",
            cSources: [cSourcePath],
        });
        assert.throws(
            () => execFileSync(artifact.executable, [], { encoding: "utf8" }),
            (error) => error.status === 1 && /error\[E1024\]: numeric operation produced a non-finite result/u.test(String(error.stderr)),
        );
    } finally {
        await removeTempDirectory(outputDirectory);
    }
});
