import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatDiagnostic, formatTerminalOutput, formatTerminalText } from "../src/diagnostics.mjs";
import { parseSource } from "../src/frontend.mjs";
import { Interpreter } from "../src/interpreter.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

function runSource(source, sourceName = "<smoke>") {
    const output = [];
    const context = { sourceName, sourceText: source };
    const interpreter = new Interpreter({ output: (text) => output.push(text) });
    interpreter.run(parseSource(source, sourceName), context);
    return { output: output.join(""), interpreter, context };
}

function captureFailure(action) {
    try {
        action();
    } catch (error) {
        return error;
    }
    assert.fail("expected OMNI to report an error");
}

const examples = [
    ["hello.om", "Hello, Ada!\n"],
    ["fibonacci.om", "0 => 0\n1 => 1\n2 => 1\n3 => 2\n4 => 3\n5 => 5\n6 => 8\n7 => 13\n8 => 21\n9 => 34\n"],
    ["collections.om", "sum = 28; count = 4\n"],
    ["evaluation-order.om", "target\nvalue\nstored: 7\n"],
    ["closures.om", "1\n2\n"],
    ["control-flow.om", "1\n3\n4\n5\nO\nM\nN\nI\n"],
    ["expression-depth.om", "subtotal = 18\n"],
];

for (const [fileName, expectedOutput] of examples) {
    test("runs the " + fileName + " example through the CLI", () => {
        const output = execFileSync(
            process.execPath,
            [cliPath, "run", resolve(projectRoot, "examples", fileName)],
            { cwd: projectRoot, encoding: "utf8" },
        );
        assert.equal(output, expectedOutput);
    });
}

test("treats LF, CRLF, and CR as line breaks in comments and locations", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
        const source = "# header" + newline + "let answer = 41" + newline + "print(answer + 1)";
        assert.equal(runSource(source).output, "42\n");
        const errorSource = "# header" + newline + "@";
        const error = captureFailure(() => parseSource(errorSource, "<line-ending>"));
        assert.equal(error.span.line, 2);
        assert.equal(error.span.column, 1);
    }
});

test("accepts a leading UTF-8 byte-order mark", () => {
    assert.equal(runSource("\uFEFFprint(42)").output, "42\n");
});

test("checks syntax and types through the CLI", () => {
    const output = execFileSync(
        process.execPath,
        [cliPath, "check", resolve(projectRoot, "examples", "closures.om")],
        { cwd: projectRoot, encoding: "utf8" },
    );
    assert.match(output, /OMNI check OK:/u);
    const unresolvedName = spawnSync(
        process.execPath,
        [cliPath, "check", resolve(projectRoot, "test", "fixtures", "unknown-name.om")],
        { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(unresolvedName.status, 1);
    assert.match(unresolvedName.stderr, /error\[E2001\]: unknown name 'missing'/u);
});

test("prints source-located CLI errors without an internal stack trace", () => {
    const fixture = resolve(projectRoot, "test", "fixtures", "unknown-name.om");
    const result = spawnSync(process.execPath, [cliPath, "run", fixture], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown-name\.om:1:7: error\[E2001\]: unknown name 'missing'/u);
    assert.doesNotMatch(result.stderr, /OmniDiagnostic|\bat .*\.mjs:/u);
});

test("runs a one-line expression in the REPL", () => {
    const result = spawnSync(process.execPath, [cliPath, "repl"], {
        cwd: projectRoot,
        encoding: "utf8",
        input: "1 + 2\n:quit\n",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /=> 3/u);
});

test("reports parser diagnostics through the CLI without a stack trace", () => {
    const fixture = resolve(projectRoot, "test", "fixtures", "invalid-syntax.om");
    const result = spawnSync(process.execPath, [cliPath, "check", fixture], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid-syntax\.om:1:5: error\[E0101\]/u);
    assert.doesNotMatch(result.stderr, /OmniDiagnostic|\bat .*\.mjs:/u);
});

test("reports help, version, and unavailable engines clearly", () => {
    const help = execFileSync(process.execPath, [cliPath, "help"], { cwd: projectRoot, encoding: "utf8" });
    const version = execFileSync(process.execPath, [cliPath, "version"], { cwd: projectRoot, encoding: "utf8" });
    assert.match(help, /Usage:/u);
    assert.equal(version, "OMNI 0.0.1-bootstrap\n");
    const selectedEngine = execFileSync(process.execPath, [
        cliPath,
        "run",
        resolve(projectRoot, "examples", "hello.om"),
        "--engine",
        "interpreter",
    ], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(selectedEngine, "Hello, Ada!\n");
    const unavailableEngine = spawnSync(process.execPath, [cliPath, "run", "examples/hello.om", "--engine", "native"], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(unavailableEngine.status, 2);
    assert.match(unavailableEngine.stderr, /engine 'native' is not available.*interpreter/u);
});

test("uses the documented expression precedence", () => {
    const source = "print(1 + 2 * 3)\nprint(true or false and false)\nprint(1 < 2 == true)";
    assert.equal(runSource(source).output, "7\ntrue\ntrue\n");
});

test("short-circuits logical operators", () => {
    const source = "fn mark() -> Bool { print(\"evaluated\")\n return true }\nprint(false and mark())\nprint(true or mark())";
    assert.equal(runSource(source).output, "false\ntrue\n");
});

test("checks runtime annotations and counts Unicode text by code point", () => {
    const source = "let missing: Text? = none\nlet letters = \"A🌍\"\nprint(type_of(missing), type_of(letters[1]), len(letters), letters[1])";
    assert.equal(runSource(source).output, "Unit Text 2 🌍\n");

    const invalidType = "let count: Int = 1.5";
    const error = captureFailure(() => runSource(invalidType));
    assert.equal(error.code, "E1021");
});

test("uses exclusive stepped ranges and snapshots lists during iteration", () => {
    const source = "for number in range(3, -1, -1) { print(number) }\nlet items = [1, 2]\nfor item in items { push(items, 9)\n print(item) }\nprint(len(items))";
    assert.equal(runSource(source).output, "3\n2\n1\n0\n1\n2\n4\n");
});

test("formats source excerpts for CR-only files and tab-indented errors", () => {
    const source = "print(1)\r\n\t@";
    const error = captureFailure(() => parseSource(source, "<diagnostic>"));
    const formatted = formatDiagnostic(error);
    assert.equal(error.span.line, 2);
    assert.equal(error.span.column, 2);
    assert.ok(formatted.includes("\n   @\n   ^"));
});

test("renders diagnostic source and metadata without terminal control characters", () => {
    const source = "\u001b[31m external secret \u0007\u202e @";
    const error = captureFailure(() => parseSource(source, "unsafe\u001b[2J.om"));
    error.notes.push("note with bell \u0007 and bidi \u202e");
    const formatted = formatDiagnostic(error);
    assert.doesNotMatch(formatted, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    assert.match(formatted, /\\u\{1b\}/u);
    assert.match(formatted, /\\u\{7\}/u);
    assert.match(formatted, /\\u\{202e\}/u);
    const plainError = formatTerminalText("unsafe\u001b[2J\u0007\u202e");
    assert.doesNotMatch(plainError, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    assert.match(plainError, /\\u\{1b\}/u);
    assert.match(plainError, /\\u\{202e\}/u);
    const logOutput = formatTerminalOutput("line one\nline two\u001b[2J");
    assert.equal(logOutput, "line one\nline two\\u{1b}[2J");
});

test("escapes terminal controls in command-line usage errors", () => {
    const result = spawnSync(process.execPath, [cliPath, "run", "-\u001b[31munknown"], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    assert.match(result.stderr, /\\u\{1b\}/u);
});

test("checks an assignment target before evaluating its value", () => {
    const source = "let fixed = 1\nfn rhs() -> Int { print(\"rhs ran\")\n return 2 }\nfixed = rhs()";
    const output = [];
    const context = { sourceName: "<immutable>", sourceText: source };
    const interpreter = new Interpreter({ output: (text) => output.push(text) });
    const error = captureFailure(() => interpreter.run(parseSource(source, context.sourceName), context));
    assert.equal(error.code, "E1003");
    assert.equal(output.join(""), "");
});

test("rejects duplicate declarations before evaluating their initializer", () => {
    const source = "let fixed = 1\nfn rhs() -> Int { print(\"rhs ran\")\n return 2 }\nlet fixed = rhs()";
    const output = [];
    const context = { sourceName: "<duplicate>", sourceText: source };
    const interpreter = new Interpreter({ output: (text) => output.push(text) });
    const error = captureFailure(() => interpreter.run(parseSource(source, context.sourceName), context));
    assert.equal(error.code, "E1002");
    assert.equal(output.join(""), "");
});

test("checks type names and duplicate parameters when declarations execute", () => {
    const unknownType = "fn unused(value: Missing) {}";
    const typeError = captureFailure(() => runSource(unknownType));
    assert.equal(typeError.code, "E1020");

    const duplicateParameter = "fn invalid(value, value) {}";
    const parameterError = captureFailure(() => runSource(duplicateParameter));
    assert.equal(parameterError.code, "E1002");
});

test("does not let indexed assignment grow a list after its value mutates it", () => {
    const source = "let values = [1]\nvalues[0] = pop(values)";
    const context = { sourceName: "<list-bounds>", sourceText: source };
    const interpreter = new Interpreter({ output: () => {} });
    const error = captureFailure(() => interpreter.run(parseSource(source, context.sourceName), context));
    assert.equal(error.code, "E1025");
    assert.equal(interpreter.environment.find("values").value.length, 0);
});

test("preserves private-use Unicode characters and escaped braces in strings", () => {
    const markerSource = "print(\"" + String.fromCodePoint(0xE000) + "|" + String.fromCodePoint(0xE001) + "\")";
    assert.equal(runSource(markerSource).output, String.fromCodePoint(0xE000) + "|" + String.fromCodePoint(0xE001) + "\n");
    assert.equal(runSource("print(\"\\{literal\\}\")").output, "{literal}\n");
});

test("formats deeply nested and cyclic lists without host recursion", () => {
    const depth = 5000;
    const source = "var value = []\nfor level in range(" + depth + ") { value = [value] }\nprint(value)";
    const output = runSource(source).output;
    assert.equal(output.length, depth * 2 + 3);
    assert.ok(output.startsWith("[["));
    assert.ok(output.endsWith("]]\n"));
    assert.equal(runSource("var values = []\npush(values, values)\nprint(values)").output, "[[...]]\n");
});

test("reports parser, expression, and function-depth limits as OMNI diagnostics", () => {
    const deeplyNested = "(".repeat(1000) + "1" + ")".repeat(1000);
    const parseError = captureFailure(() => parseSource(deeplyNested, "<parser-depth>"));
    assert.equal(parseError.code, "E0101");
    assert.match(parseError.message, /nesting exceeds the limit of 128/u);
    const deeplyNestedBlocks = "if true {".repeat(1000) + "print(1)" + "}".repeat(1000);
    assert.equal(captureFailure(() => parseSource(deeplyNestedBlocks, "<block-depth>")).code, "E0101");
    const deeplyNestedUnary = "-".repeat(1000) + "1";
    assert.equal(captureFailure(() => parseSource(deeplyNestedUnary, "<unary-depth>")).code, "E0101");

    const longExpression = Array(500).fill("1").join(" + ");
    const expressionError = captureFailure(() => runSource(longExpression));
    assert.equal(expressionError.code, "E1026");

    const recursion = "fn dive(n) { if n == 0 { return 0 } return dive(n - 1) }\ndive(";
    runSource(recursion + "255)");
    const callError = captureFailure(() => runSource(recursion + "256)"));
    assert.equal(callError.code, "E1017");
    assert.match(callError.message, /limit of 256/u);
});

test("bounds operator-chain AST depth before recursive checkers and engines", () => {
    const longExpression = Array(10_000).fill("1").join(" + ");
    const error = captureFailure(() => parseSource(longExpression, "long-chain.om"));
    assert.equal(error.code, "E1026");
    assert.match(error.message, /expression nesting exceeds the limit of 128/u);
    assert.equal(error.sourceName, "long-chain.om");
});
