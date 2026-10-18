import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatOmni } from "../src/formatter.mjs";
import { lex } from "../src/lexer.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");

async function temporaryDirectory(prefix) {
    return mkdtemp(resolve(projectRoot, "." + prefix));
}

async function removeTemporaryDirectory(directory) {
    const root = resolve(projectRoot);
    const target = resolve(directory);
    assert.ok(target.startsWith(root + sep), "formatter temporary files stay inside the workspace");
    await rm(target, { recursive: true, force: true });
}

function tokenShape(source) {
    return lex(source).filter((token) => token.kind !== "eof").map(({ kind, value }) => ({ kind, value }));
}

async function omniFiles(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) found.push(...await omniFiles(path));
        else if (entry.isFile() && entry.name.endsWith(".om")) found.push(path);
    }
    return found.sort();
}

test("formatter normalizes spacing and indentation without changing source tokens or comments", () => {
    const source = [
        "# file comment",
        "fn twice(value:Int)->Int{ # function comment",
        "return -value*2",
        "}",
        "let items=[1,2]",
        "for item in items{print(item)}# loop comment",
        'let marker="the # stays inside this string"',
        "",
    ].join("\n");
    const formatted = formatOmni(source, "format.om");
    assert.equal(formatted, [
        "# file comment",
        "fn twice(value: Int) -> Int {  # function comment",
        "    return -value * 2",
        "}",
        "let items = [1, 2]",
        "for item in items { print(item) }  # loop comment",
        'let marker = "the # stays inside this string"',
        "",
    ].join("\n"));
    assert.deepEqual(tokenShape(formatted), tokenShape(source));
});

test("formatter is idempotent and preserves the token stream for every maintained example", async () => {
    const examples = await omniFiles(resolve(projectRoot, "examples"));
    assert.ok(examples.length >= 20);
    for (const path of examples) {
        const source = await readFile(path, "utf8");
        const formatted = formatOmni(source, path);
        assert.equal(formatOmni(formatted, path), formatted, path + " is idempotent");
        assert.deepEqual(tokenShape(formatted), tokenShape(source), path + " keeps its tokens");
    }
});

test("omni fmt --check reports formatting without changing the file", async () => {
    const directory = await temporaryDirectory("phase6-fmt-v1-");
    const sourcePath = resolve(directory, "sample.om");
    try {
        await writeFile(sourcePath, "let answer=42", "utf8");
        const checked = spawnSync(process.execPath, [cliPath, "fmt", "--check", sourcePath], { encoding: "utf8" });
        assert.equal(checked.status, 1);
        assert.match(checked.stdout, /OMNI formatting needed/u);
        assert.equal(await readFile(sourcePath, "utf8"), "let answer=42");

        const formatted = spawnSync(process.execPath, [cliPath, "fmt", sourcePath], { encoding: "utf8" });
        assert.equal(formatted.status, 0, formatted.stderr);
        assert.equal(await readFile(sourcePath, "utf8"), "let answer = 42\n");
        const checkedAgain = spawnSync(process.execPath, [cliPath, "fmt", sourcePath, "--check"], { encoding: "utf8" });
        assert.equal(checkedAgain.status, 0, checkedAgain.stderr);
    } finally {
        await removeTemporaryDirectory(directory);
    }
});

test("omni fmt reports syntax errors at their source location", async () => {
    const directory = await temporaryDirectory("phase6-fmt-invalid-");
    const sourcePath = resolve(directory, "invalid.om");
    try {
        await writeFile(sourcePath, "let answer =\n", "utf8");
        const result = spawnSync(process.execPath, [cliPath, "fmt", sourcePath], { encoding: "utf8" });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid\.om:\d+:\d+: error\[E0101\]/u);
        assert.doesNotMatch(result.stderr, /at Parser\./u);
        assert.equal(await readFile(sourcePath, "utf8"), "let answer =\n");
    } finally {
        await removeTemporaryDirectory(directory);
    }
});
