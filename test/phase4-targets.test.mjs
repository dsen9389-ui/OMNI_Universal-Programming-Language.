import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { buildEmbedded, buildWeb } from "../src/build.mjs";
import { parseProjectConfig } from "../src/config.mjs";
import { OmniDiagnostic } from "../src/diagnostics.mjs";
import { compileEmbeddedC } from "../src/embedded-c-compiler.mjs";
import { parseSource } from "../src/frontend.mjs";
import { validateTargetEffects } from "../src/targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function context(source, sourceName = "<phase4>") {
    return { sourceName, sourceText: source };
}

function safeTempDirectory() {
    return mkdtemp(resolve(tmpdir(), "omni-phase4-"));
}

async function removeTempDirectory(directory) {
    const root = resolve(tmpdir());
    const target = resolve(directory);
    assert.ok(target.startsWith(root + sep), "temporary output stays within the operating system temp directory");
    await rm(target, { recursive: true, force: true });
}

test("target-specific effects are checked before execution with source locations", () => {
    const source = 'print("before hardware access")\ngpio_write(13, true)';
    const program = parseSource(source, "effects.om");
    assert.throws(
        () => validateTargetEffects(program, context(source, "effects.om"), "web"),
        (error) => error instanceof OmniDiagnostic && error.code === "E3004" && error.span.line === 2,
    );
    assert.doesNotThrow(() => validateTargetEffects(program, context(source, "effects.om"), "embedded"));
    assert.throws(
        () => validateTargetEffects(parseSource('serial_write("ready")', "serial.om"), context('serial_write("ready")', "serial.om"), "host"),
        (error) => error instanceof OmniDiagnostic && error.code === "E3004" && error.span.line === 1,
    );
});

test("target effect checking respects a user function that shadows a hardware API name", () => {
    const source = [
        "fn gpio_write(pin: Int, high: Bool) {",
        '    print("local function")',
        "}",
        "gpio_write(1, true)",
    ].join("\n");
    const program = parseSource(source, "shadow.om");
    assert.doesNotThrow(() => validateTargetEffects(program, context(source, "shadow.om"), "host"));
});

test("omni.toml accepts a build target separately from the host run target", () => {
    const parsed = parseProjectConfig('[run]\ndevelopment = "interpreter"\nrelease = "javascript"\ntarget = "host"\n[build]\ntarget = "embedded"\n', "<config>");
    assert.equal(parsed.target, "host");
    assert.equal(parsed.buildTarget, "embedded");
});

test("web build runs its compiled OMNI program in a browser-style runtime", async () => {
    const sourcePath = resolve(projectRoot, "examples", "web-app.om");
    const programText = await readFile(sourcePath, "utf8");
    const program = parseSource(programText, sourcePath);
    const outputDirectory = await safeTempDirectory();
    const previousDocument = globalThis.document;
    const values = {
        "omni-output": { textContent: "" },
        "omni-status": { textContent: "", dataset: {} },
    };
    try {
        const result = await buildWeb(program, context(programText, sourcePath), outputDirectory);
        assert.equal(result.target, "web");
        globalThis.document = { getElementById: (name) => values[name] };
        await import(pathToFileURL(resolve(outputDirectory, "app.mjs")).href + "?run=" + Date.now());
        assert.equal(values["omni-output"].textContent, "Hello, web!\nThis output is rendered on the page.\n");
        assert.equal(values["omni-status"].textContent, "OMNI program finished.");
        assert.equal(values["omni-status"].dataset.error, "false");
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        await removeTempDirectory(outputDirectory);
    }
});

test("embedded freestanding C build runs in the included simulator", async () => {
    const sourcePath = resolve(projectRoot, "examples", "embedded-led.om");
    const source = await readFile(sourcePath, "utf8");
    const program = parseSource(source, sourcePath);
    const outputDirectory = await safeTempDirectory();
    try {
        const result = await buildEmbedded(program, context(source, sourcePath), outputDirectory);
        const output = execFileSync(result.executable, [], { encoding: "utf8" }).replace(/\r\n/g, "\n");
        assert.equal(output, [
            "OMNI embedded demo starting",
            "[sim] GPIO 13 = high",
            "Status LED on",
            "[sim] GPIO 13 = low",
            "Status LED off",
            "[sim] GPIO 13 = high",
            "Status LED on",
            "[sim] GPIO 13 = low",
            "Status LED off",
            "Two blink cycles complete",
            "",
        ].join("\n"));
    } finally {
        await removeTempDirectory(outputDirectory);
    }
});

test("embedded compiler reports unsupported dynamic text at its source location", () => {
    const source = 'let message: Text = "hello {name}"';
    const program = parseSource(source, "dynamic-text.om");
    assert.throws(
        () => compileEmbeddedC(program, context(source, "dynamic-text.om")),
        (error) => error instanceof OmniDiagnostic && error.code === "E3002" && error.span.line === 1,
    );
});

test("embedded compiler rejects order-dependent assignments inside binary expressions", () => {
    const source = [
        "let counter: Int = 0",
        "let total = counter + (counter = 1)",
    ].join("\n");
    assert.throws(
        () => compileEmbeddedC(parseSource(source, "order.om"), context(source, "order.om")),
        (error) => error instanceof OmniDiagnostic && error.code === "E3002" && error.span.line === 2 && /assign the value on its own line/u.test(error.message),
    );
});
