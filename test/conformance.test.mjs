import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OmniDiagnostic } from "../src/diagnostics.mjs";
import { parseSource } from "../src/frontend.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

function cli(args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
    });
}

test("Phase 2 record, enum, Option, Result, match, map, and filter program conforms", () => {
    const output = execFileSync(process.execPath, [cliPath, "run", resolve(projectRoot, "examples", "phase2.om")], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(output, [
        "Write the example in progress done = true",
        "option = present",
        "error = offline",
        "large values = [6, 8]",
        "",
    ].join("\n"));
});

test("left-associative operators retain the specified evaluation order", () => {
    const output = execFileSync(process.execPath, [cliPath, "run", resolve(projectRoot, "conformance", "modules", "operator-associativity.om")], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(output, "12\n4\n8\n");
});

test("expression-tree depth rejects an extreme operator chain with E1026", () => {
    const source = Array(10_000).fill("1").join(" + ");
    assert.throws(() => parseSource(source, "conformance/long-chain.om"), (error) => {
        assert.ok(error instanceof OmniDiagnostic);
        assert.equal(error.code, "E1026");
        assert.equal(error.span.line, 1);
        return true;
    });
});

test("an empty list can take its element type from an annotation", () => {
    const output = execFileSync(process.execPath, [cliPath, "run", resolve(projectRoot, "conformance", "modules", "empty-typed-list.om")], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(output, "7\n");
});

test("relative module imports expose checked types, values, and enum variants", () => {
    const output = execFileSync(process.execPath, [cliPath, "run", resolve(projectRoot, "examples", "modules", "main.om")], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(output, "sum = 42\nmodule loaded\ncounter = 0\ncounter = 1\nsame module = 1\n");
});

test("self-recursive enum declarations can be checked and executed", () => {
    const output = execFileSync(process.execPath, [cliPath, "run", resolve(projectRoot, "examples", "recursive-data.om")], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.equal(output, "tree total = 9\n");
});

test("a type error in an imported module prevents entry-module side effects", () => {
    const result = cli(["run", resolve(projectRoot, "conformance", "modules", "invalid-main.om")]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /error\[E2003\]: expected Int, found Text/u);
    assert.match(result.stderr, /invalid-type\.om:1:19/u);
});

test("the checker requires complete payload coverage for an Option constructor", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "match-option-partial.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E2008\]: match does not cover every Option\[Int\] value/u);
});

test("the checker rejects a match case after finite coverage", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "match-bool-unreachable.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E2007\]: this match case can never run after all values are covered/u);
});

test("cyclic imports have a source-located diagnostic", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "cycle-a.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cycle-b\.om:1:8: error\[E2051\]: cyclic imports are not allowed/u);
    assert.doesNotMatch(result.stderr, /stack| at /u);
});

test("unsupported interpolation is rejected before execution", () => {
    const result = cli(["run", resolve(projectRoot, "conformance", "modules", "interpolation.om")]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /error\[E1018\]: string interpolation currently accepts a variable name such as \{name\}/u);
});

test("an imported file that does not exist receives a source-located error", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "missing-import.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing-import\.om:1:8: error\[E2050\]: could not read imported module/u);
});

test("module paths cannot interpolate source values", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "interpolated-import.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E2050\]: module paths cannot contain string interpolation/u);
});

test("record field assignments are checked against the declared field type", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "invalid-record-field.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E2003\]: expected Int, found Text/u);
});

test("built-in type names cannot be reused for user-defined types", () => {
    const result = cli(["check", resolve(projectRoot, "conformance", "modules", "reserved-type.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E2002\]: type name 'Int' is reserved/u);
});

test("runtime list contracts protect annotated lists passed through Any to push", () => {
    const result = cli(["run", resolve(projectRoot, "conformance", "modules", "typed-list-any.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E1021\]: 'list element' must have type Int, received Text/u);
});

test("runtime list contracts protect annotated lists passed through Any to indexed assignment", () => {
    const result = cli(["run", resolve(projectRoot, "conformance", "modules", "typed-list-index.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E1021\]: 'list element' must have type Int, received Text/u);
});

test("runtime list contracts extend through nested annotated lists", () => {
    const result = cli(["run", resolve(projectRoot, "conformance", "modules", "typed-nested-list-any.om")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error\[E1021\]: 'list element' must have type Int, received Text/u);
});
