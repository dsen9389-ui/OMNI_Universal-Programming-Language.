import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Readable } from "node:stream";
import { createLanguageServer, runLanguageServer } from "../src/language-server.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "bin", "omni.mjs");
const source = [
    "fn greet(name: Text) -> Text {",
    'return "Hi " + name',
    "}",
    'let message: Text = greet("OMNI")',
    "print(message)",
    "",
].join("\n");

async function withFile(contents, action) {
    const directory = await mkdtemp(resolve(tmpdir(), "omni-lsp-"));
    const path = resolve(directory, "main.om");
    try {
        await writeFile(path, contents, "utf8");
        await action(path, pathToFileURL(path).href);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function frame(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]);
}

function parseFrames(output) {
    const messages = [];
    let buffer = Buffer.from(output);
    while (buffer.length > 0) {
        const boundary = buffer.indexOf("\r\n\r\n");
        assert.notEqual(boundary, -1, "every language-server output has an LSP header");
        const header = buffer.subarray(0, boundary).toString("ascii");
        const length = Number(/^Content-Length:\s*(\d+)\s*$/imu.exec(header)?.[1]);
        assert.ok(Number.isInteger(length), "every language-server frame declares its body size");
        assert.ok(buffer.length >= boundary + 4 + length, "language-server frame body is complete");
        messages.push(JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString("utf8")));
        buffer = buffer.subarray(boundary + 4 + length);
    }
    return messages;
}

function positionOf(text, needle, occurrence = 0) {
    let offset = -1;
    let from = 0;
    for (let index = 0; index <= occurrence; index += 1) {
        offset = text.indexOf(needle, from);
        assert.notEqual(offset, -1);
        from = offset + needle.length;
    }
    const before = text.slice(0, offset);
    const lines = before.split("\n");
    return { line: lines.length - 1, character: lines.at(-1).length };
}

test("language server reports source-located OMNI diagnostics", async () => {
    await withFile("let count: Int = true\n", async (_path, uri) => {
        const messages = [];
        const server = createLanguageServer((message) => messages.push(message));
        await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri, languageId: "omni", version: 1, text: "let count: Int = true\n" },
        } });

        const capabilities = messages.find((message) => message.id === 1).result.capabilities;
        assert.equal(capabilities.hoverProvider, true);
        assert.equal(capabilities.definitionProvider, true);
        assert.equal(capabilities.documentFormattingProvider, true);
        const publication = messages.find((message) => message.method === "textDocument/publishDiagnostics");
        assert.equal(publication.params.uri, uri);
        assert.equal(publication.params.diagnostics[0].code, "E2003");
        assert.equal(publication.params.diagnostics[0].source, "omni");
        assert.ok(publication.params.diagnostics[0].range.start.line === 0);
    });
});

test("language server supplies completion, hover, definition, and formatting", async () => {
    await withFile(source, async (_path, uri) => {
        const messages = [];
        const server = createLanguageServer((message) => messages.push(message));
        await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri, languageId: "omni", version: 1, text: source },
        } });

        const usage = positionOf(source, "greet", 1);
        await server.handle({ jsonrpc: "2.0", id: 2, method: "textDocument/completion", params: {
            textDocument: { uri }, position: usage,
        } });
        await server.handle({ jsonrpc: "2.0", id: 3, method: "textDocument/hover", params: {
            textDocument: { uri }, position: usage,
        } });
        await server.handle({ jsonrpc: "2.0", id: 4, method: "textDocument/definition", params: {
            textDocument: { uri }, position: usage,
        } });
        await server.handle({ jsonrpc: "2.0", id: 5, method: "textDocument/formatting", params: {
            textDocument: { uri }, options: { tabSize: 4, insertSpaces: true },
        } });

        const completion = messages.find((message) => message.id === 2).result;
        assert.ok(completion.some((item) => item.label === "greet"));
        assert.match(messages.find((message) => message.id === 3).result.contents.value, /fn greet\(name: Text\) -> Text/u);
        const definition = messages.find((message) => message.id === 4).result;
        assert.equal(definition.uri, uri);
        assert.deepEqual(definition.range.start, { line: 0, character: 3 });
        const edits = messages.find((message) => message.id === 5).result;
        assert.equal(edits.length, 1);
        assert.match(edits[0].newText, /\n    return/u);
    });
});

test("language server resolves a shadowed name to its nearest declaration", async () => {
    const text = [
        "let value: Int = 1",
        "fn inspect(value: Int) -> Int {",
        "    return value",
        "}",
        "print(inspect(2))",
        "",
    ].join("\n");
    await withFile(text, async (_path, uri) => {
        const messages = [];
        const server = createLanguageServer((message) => messages.push(message));
        await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri, languageId: "omni", version: 1, text },
        } });
        await server.handle({ jsonrpc: "2.0", id: 2, method: "textDocument/definition", params: {
            textDocument: { uri }, position: positionOf(text, "value", 2),
        } });
        const definition = messages.find((message) => message.id === 2).result;
        assert.deepEqual(definition.range.start, { line: 1, character: 11 });
    });
});

test("language server checks unsaved imported modules and refreshes open importers", async () => {
    await withFile('import "./util.om" as util\nprint(util.value)\n', async (mainPath, mainUri) => {
        const utilPath = resolve(dirname(mainPath), "util.om");
        const utilUri = pathToFileURL(utilPath).href;
        await writeFile(utilPath, "let value: Int = 42\n", "utf8");
        const messages = [];
        const server = createLanguageServer((message) => messages.push(message));
        await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri: mainUri, languageId: "omni", version: 1, text: 'import "./util.om" as util\nprint(util.value)\n' },
        } });
        await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri: utilUri, languageId: "omni", version: 1, text: "let value: Int = 42\n" },
        } });
        await server.handle({ jsonrpc: "2.0", method: "textDocument/didChange", params: {
            textDocument: { uri: utilUri, version: 2 },
            contentChanges: [{ text: "let value: Int = true\n" }],
        } });

        const latest = [...messages].reverse().find((message) => message.method === "textDocument/publishDiagnostics" && message.params.uri === utilUri);
        assert.equal(latest.params.diagnostics[0].code, "E2003");
        assert.equal(server.documents.get(utilUri).version, 2);
    });
});

test("omni lsp uses Content-Length framing and keeps stdout protocol-only", async () => {
    await withFile(source, async (_path, uri) => {
        const messages = [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
            { jsonrpc: "2.0", method: "textDocument/didOpen", params: {
                textDocument: { uri, languageId: "omni", version: 1, text: source },
            } },
            { jsonrpc: "2.0", id: 2, method: "shutdown", params: null },
            { jsonrpc: "2.0", method: "exit", params: null },
        ];
        const input = Buffer.concat(messages.map(frame));
        const result = spawnSync(process.execPath, [cliPath, "lsp"], {
            cwd: projectRoot,
            encoding: "buffer",
            input,
            timeout: 10_000,
            windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr?.toString("utf8"));
        assert.equal(result.stderr.toString("utf8"), "");
        const output = parseFrames(result.stdout);
        assert.ok(output.some((message) => message.id === 1 && message.result.serverInfo.name === "omni-language-server"));
        assert.ok(output.some((message) => message.method === "textDocument/publishDiagnostics"));
        assert.ok(output.some((message) => message.id === 2 && message.result === null));
    });
});

test("language server accepts split frames and rejects an oversized incomplete header", async () => {
    const requests = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "shutdown", params: null },
        { jsonrpc: "2.0", method: "exit", params: null },
    ];
    const input = Buffer.concat(requests.map(frame));
    const output = [];
    await runLanguageServer(Readable.from([
        input.subarray(0, 3),
        input.subarray(3, 17),
        input.subarray(17),
    ]), { write: (chunk) => output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) });
    const replies = parseFrames(Buffer.concat(output));
    assert.ok(replies.some((message) => message.id === 1 && message.result.serverInfo.name === "omni-language-server"));
    assert.ok(replies.some((message) => message.id === 2 && message.result === null));

    const oversizedHeader = Buffer.alloc(8 * 1024 + 1, 65);
    const rejected = spawnSync(process.execPath, [cliPath, "lsp"], {
        cwd: projectRoot,
        encoding: "buffer",
        input: oversizedHeader,
        timeout: 10_000,
        windowsHide: true,
    });
    assert.equal(rejected.status, 0);
    assert.equal(rejected.stdout.length, 0);
    assert.match(rejected.stderr.toString("utf8"), /header exceeds the 8 KiB limit/u);
});
