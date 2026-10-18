import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkProgram } from "../src/checker.mjs";
import { parseProjectConfig } from "../src/config.mjs";
import { OmniDiagnostic } from "../src/diagnostics.mjs";
import { createEngine } from "../src/engines.mjs";
import { createSemanticProgram } from "../src/ir.mjs";
import { parseSource } from "../src/frontend.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");
const engineNames = ["interpreter", "bytecode", "javascript"];
const portableExamples = [
    "hello.om",
    "fibonacci.om",
    "collections.om",
    "evaluation-order.om",
    "closures.om",
    "control-flow.om",
    "expression-depth.om",
    "phase3-portable.om",
];

function runSource(engineName, source, sourceName = "<engine-test>") {
    const context = { sourceName, sourceText: source };
    const program = parseSource(source, sourceName);
    const typeInterface = checkProgram(program, context);
    const semanticProgram = createSemanticProgram(program, context, typeInterface);
    const output = [];
    const engine = createEngine(engineName, { output: (text) => output.push(text) });
    try {
        return { value: engine.run(semanticProgram), output: output.join(""), error: null };
    } catch (error) {
        return { value: undefined, output: output.join(""), error };
    }
}

function cli(args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
    });
}

for (const fileName of portableExamples) {
    test("Phase 3 engines agree on " + fileName, () => {
        const filePath = resolve(projectRoot, "examples", fileName);
        const source = readFileSync(filePath, "utf8");
        const outcomes = engineNames.map((engineName) => runSource(engineName, source, filePath));
        for (const outcome of outcomes) assert.equal(outcome.error, null, outcome.error?.message);
        assert.equal(outcomes[1].output, outcomes[0].output);
        assert.equal(outcomes[2].output, outcomes[0].output);
        assert.deepEqual(outcomes[1].value, outcomes[0].value);
        assert.deepEqual(outcomes[2].value, outcomes[0].value);
    });
}

test("runtime type failures have matching codes, locations, and messages", () => {
    const source = [
        "var values: List[Int] = [1]",
        "let dynamic: Any = \"not an integer\"",
        "push(values, dynamic)",
    ].join("\n");
    const outcomes = engineNames.map((engineName) => runSource(engineName, source));
    for (const outcome of outcomes) assert.ok(outcome.error instanceof OmniDiagnostic);
    const first = outcomes[0].error;
    for (const outcome of outcomes.slice(1)) {
        assert.equal(outcome.error.code, first.code);
        assert.equal(outcome.error.message, first.message);
        assert.equal(JSON.stringify(outcome.error.span), JSON.stringify(first.span));
    }
    assert.equal(first.code, "E1021");
});

test("all engines keep nested typed-list contracts after values pass through Any", () => {
    const source = [
        "var rows: List[List[Int]] = [[1]]",
        "let dynamic: Any = \"not an integer\"",
        "push(rows[0], dynamic)",
    ].join("\n");
    const outcomes = engineNames.map((engineName) => runSource(engineName, source));
    for (const outcome of outcomes) assert.ok(outcome.error instanceof OmniDiagnostic);
    assert.deepEqual(outcomes.map(({ error }) => [error.code, error.message]), [
        ["E1021", "'list element' must have type Int, received Text"],
        ["E1021", "'list element' must have type Int, received Text"],
        ["E1021", "'list element' must have type Int, received Text"],
    ]);
});

test("portable engines preserve Unicode indexing and specified recursion limits", () => {
    const unicode = [
        "let text = \"A🌍\"",
        "print(len(text), text[1])",
    ].join("\n");
    const unicodeOutcomes = engineNames.map((engineName) => runSource(engineName, unicode));
    for (const outcome of unicodeOutcomes) assert.equal(outcome.error, null, outcome.error?.message);
    assert.deepEqual(unicodeOutcomes.map(({ output }) => output), ["2 🌍\n", "2 🌍\n", "2 🌍\n"]);

    const recursion = "fn dive(n) { if n == 0 { return 0 } return dive(n - 1) }\ndive(256)";
    const recursionOutcomes = engineNames.map((engineName) => runSource(engineName, recursion));
    for (const outcome of recursionOutcomes) assert.ok(outcome.error instanceof OmniDiagnostic);
    assert.deepEqual(recursionOutcomes.map(({ error }) => error.code), ["E1017", "E1017", "E1017"]);

    const deeplyNested = Array(500).fill("1").join(" + ");
    const expressionOutcomes = engineNames.map((engineName) => {
        try {
            return runSource(engineName, deeplyNested);
        } catch (error) {
            return { error, output: "" };
        }
    });
    for (const outcome of expressionOutcomes) assert.ok(outcome.error instanceof OmniDiagnostic);
    assert.deepEqual(expressionOutcomes.map(({ error }) => error.code), ["E1026", "E1026", "E1026"]);
});

test("compiler engines retain Option and Result values and annotations", () => {
    const source = [
        "let optional: Text? = some(\"ready\")",
        "let outcome: Result[Int, Text] = err(\"offline\")",
        "print(optional, outcome, type_of(optional), type_of(outcome))",
    ].join("\n");
    const outcomes = engineNames.map((engineName) => runSource(engineName, source));
    for (const outcome of outcomes) assert.equal(outcome.error, null, outcome.error?.message);
    assert.equal(outcomes[1].output, outcomes[0].output);
    assert.equal(outcomes[2].output, outcomes[0].output);
});

test("omni.toml accepts engine modes and rejects unknown settings at their source line", () => {
    const parsed = parseProjectConfig('[run]\ndevelopment = "bytecode"\nrelease = "javascript"\ntarget = "host"\n', "<config>");
    assert.deepEqual(parsed.engines, { development: "bytecode", release: "javascript" });
    assert.equal(parsed.target, "host");
    assert.throws(
        () => parseProjectConfig('[run]\nunknown = "value"\n', "<config>"),
        (error) => error instanceof OmniDiagnostic && error.code === "E3001" && error.span.line === 2,
    );
});

test("project config reports unavailable engines and targets at their setting", () => {
    const invalidEngine = cli(["run", resolve(projectRoot, "conformance", "config-errors", "invalid-engine", "main.om")]);
    assert.equal(invalidEngine.status, 1);
    assert.equal(invalidEngine.stdout, "");
    assert.match(invalidEngine.stderr, /omni\.toml:3:1: error\[E3001\]: engine 'native' for release mode is not available/u);

    const invalidTarget = cli(["run", resolve(projectRoot, "conformance", "config-errors", "invalid-target", "main.om")]);
    assert.equal(invalidTarget.status, 1);
    assert.equal(invalidTarget.stdout, "");
    assert.match(invalidTarget.stderr, /omni\.toml:4:1: error\[E3003\]: target 'embedded' is not available/u);
});

test("mode configuration and CLI engine/target overrides select working engines", () => {
    const example = resolve(projectRoot, "examples", "phase3-portable.om");
    const release = cli(["run", example, "--mode", "release"]);
    const bytecode = cli(["run", example, "--engine", "bytecode", "--target", "host"]);
    const directOverride = cli(["run", example, "--mode", "release", "--engine", "interpreter"]);
    const expected = [
        "counter = 41 42",
        "doubled values = [2, 4, 6, 8]",
        "total above four = 14",
        "function = <fn double>",
        "loop closures = 3 5",
        "",
    ].join("\n");
    for (const result of [release, bytecode, directOverride]) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, expected);
    }
});

test("omni.toml can select the bytecode VM for development", () => {
    const source = resolve(projectRoot, "conformance", "config-modes", "main.om");
    const result = cli(["run", source, "--mode", "development"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "42\n");
});

test("all engines agree on the value of a final expression", () => {
    const outcomes = engineNames.map((engineName) => runSource(engineName, "let answer = 6 * 7\nanswer + 1"));
    for (const outcome of outcomes) assert.equal(outcome.error, null, outcome.error?.message);
    assert.deepEqual(outcomes.map(({ value }) => value), [43, 43, 43]);
});

test("release configuration and target overrides report unsupported choices clearly", () => {
    const phase2Program = resolve(projectRoot, "examples", "phase2.om");
    const unsupportedEngine = cli(["run", phase2Program, "--mode", "release"]);
    assert.equal(unsupportedEngine.status, 1);
    assert.match(unsupportedEngine.stderr, /error\[E3002\]: the javascript engine does not support user-defined data types/u);
    assert.doesNotMatch(unsupportedEngine.stderr, /\bat .*\.mjs:/u);

    const unsupportedTarget = cli(["run", resolve(projectRoot, "examples", "hello.om"), "--target", "web"]);
    assert.equal(unsupportedTarget.status, 1);
    assert.match(unsupportedTarget.stderr, /error\[E3003\]: target 'web' is not available in this phase/u);
});

test("engine compilation rejects unsupported modules before any module executes", () => {
    const entry = resolve(projectRoot, "conformance", "engines", "import-effect-main.om");
    const result = cli(["run", entry, "--engine", "javascript"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /error\[E3002\]: the javascript engine does not support module imports/u);
});

test("engine compilation rejects unsupported constructs before their earlier effects", () => {
    const file = resolve(projectRoot, "conformance", "engines", "unsupported-after-effect.om");
    const result = cli(["run", file, "--engine", "bytecode"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /error\[E3002\]: the bytecode engine does not support user-defined data types/u);
});
