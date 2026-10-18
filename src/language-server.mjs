import { formatOmni } from "./formatter.mjs";
import { formatTerminalText, OmniDiagnostic } from "./diagnostics.mjs";
import { lex } from "./lexer.mjs";
import { checkProgram } from "./checker.mjs";
import { parseSource } from "./frontend.mjs";
import { loadModuleGraph } from "./modules.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { stdin, stdout, stderr } from "node:process";

const KEYWORDS = [
    "and", "as", "break", "continue", "else", "enum", "false", "fn", "for", "if", "in",
    "import", "let", "match", "none", "record", "return", "true", "var", "while",
];

const BUILTINS = new Map([
    ["print", "print(value: Any) -> Unit"],
    ["len", "len(value: List[Any] | Text) -> Int"],
    ["str", "str(value: Any) -> Text"],
    ["type_of", "type_of(value: Any) -> Text"],
    ["range", "range(start: Int, end: Int, step: Int) -> List[Int]"],
    ["push", "push(list: List[Any], value: Any) -> Unit"],
    ["pop", "pop(list: List[Any]) -> Any"],
    ["some", "some(value: Any) -> Option[Any]"],
    ["ok", "ok(value: Any) -> Result[Any, Any]"],
    ["err", "err(value: Any) -> Result[Any, Any]"],
    ["map", "map(list: List[Any], transform: Function) -> List[Any]"],
    ["filter", "filter(list: List[Any], predicate: Function) -> List[Any]"],
]);

export function createLanguageServer(send) {
    const documents = new Map();
    const documentDependencies = new Map();
    let shutdownRequested = false;
    let exited = false;

    async function handle(message) {
        const { id, method, params = {} } = message ?? {};
        if (method === "initialize") {
            respond(id, {
                capabilities: {
                    textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
                    completionProvider: { resolveProvider: false, triggerCharacters: ["."] },
                    definitionProvider: true,
                    documentFormattingProvider: true,
                    hoverProvider: true,
                },
                serverInfo: { name: "omni-language-server", version: "0.0.1-bootstrap" },
            });
            return;
        }
        if (method === "initialized") return;
        if (method === "shutdown") {
            shutdownRequested = true;
            respond(id, null);
            return;
        }
        if (method === "exit") {
            exited = true;
            return;
        }
        if (method === "textDocument/didOpen") {
            const item = params.textDocument;
            if (!isFileUri(item?.uri) || typeof item.text !== "string") return;
            documents.set(item.uri, { uri: item.uri, text: item.text, version: item.version ?? 0 });
            await refreshAffectedDiagnostics(item.uri);
            return;
        }
        if (method === "textDocument/didChange") {
            const item = params.textDocument;
            const document = documents.get(item?.uri);
            if (!document) return;
            for (const change of params.contentChanges ?? []) {
                if (!change.range) document.text = change.text;
                else document.text = applyChange(document.text, change);
            }
            document.version = item.version ?? document.version;
            await refreshAffectedDiagnostics(item.uri);
            return;
        }
        if (method === "textDocument/didSave") {
            if (documents.has(params.textDocument?.uri)) await refreshAffectedDiagnostics(params.textDocument.uri);
            return;
        }
        if (method === "textDocument/didClose") {
            const uri = params.textDocument?.uri;
            const affected = [...documentDependencies]
                .filter(([, dependencies]) => dependencies.has(uri))
                .map(([root]) => root);
            documents.delete(uri);
            documentDependencies.delete(uri);
            notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
            for (const root of affected) if (documents.has(root)) await publishWorkspaceDiagnostics(root);
            return;
        }
        if (method === "textDocument/completion") {
            const document = documents.get(params.textDocument?.uri);
            respond(id, document ? complete(document.text, params.position) : []);
            return;
        }
        if (method === "textDocument/hover") {
            const document = documents.get(params.textDocument?.uri);
            respond(id, document ? hover(document.text, params.position) : null);
            return;
        }
        if (method === "textDocument/definition") {
            const document = documents.get(params.textDocument?.uri);
            respond(id, document ? definition(document, params.position) : null);
            return;
        }
        if (method === "textDocument/formatting") {
            const document = documents.get(params.textDocument?.uri);
            if (!document) {
                respond(id, []);
                return;
            }
            try {
                const formatted = formatOmni(document.text, document.uri);
                respond(id, formatted === document.text ? [] : [{
                    range: { start: { line: 0, character: 0 }, end: offsetToPosition(document.text, document.text.length) },
                    newText: formatted,
                }]);
            } catch {
                respond(id, []);
            }
            return;
        }
        if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
        if (shutdownRequested && method !== "exit") return;
    }

    function respond(id, result) {
        if (id !== undefined) send({ jsonrpc: "2.0", id, result });
    }

    function notify(method, params) {
        send({ jsonrpc: "2.0", method, params });
    }

    async function publishWorkspaceDiagnostics(changedUri) {
        const current = documents.get(changedUri);
        if (!current) return;
        const entryPath = uriToPath(changedUri);
        const overrides = new Map();
        documentDependencies.set(changedUri, new Set([changedUri]));
        for (const document of documents.values()) {
            if (isFileUri(document.uri)) overrides.set(uriToPath(document.uri), document.text);
        }
        const byUri = new Map();
        try {
            const graph = await loadModuleGraph(entryPath, { sourceOverrides: overrides });
            documentDependencies.set(changedUri, new Set(graph.modules.map((module) => documentUriForPath(module.path, documents))));
            for (const module of graph.modules) {
                const uri = documentUriForPath(module.path, documents);
                byUri.set(uri, []);
                if ([...module.imports.values()].some((dependency) => dependency.interface === null)) continue;
                try {
                    const imports = new Map([...module.imports].map(([path, dependency]) => [path, dependency.interface]));
                    module.interface = checkProgram(module.program, module.context, { imports });
                } catch (error) {
                    if (!(error instanceof OmniDiagnostic)) throw error;
                    byUri.set(diagnosticUri(error, uri, documents), [toLspDiagnostic(error, sourceFor(error, module.source))]);
                }
            }
        } catch (error) {
            if (!(error instanceof OmniDiagnostic)) {
                stderr.write("OMNI language server: " + formatTerminalText(error.message) + "\n");
                byUri.set(changedUri, []);
            } else {
                const uri = diagnosticUri(error, changedUri, documents);
                byUri.set(uri, [toLspDiagnostic(error, sourceFor(error, current.text))]);
            }
        }
        if (!byUri.has(changedUri)) byUri.set(changedUri, []);
        for (const [uri, diagnostics] of byUri) notify("textDocument/publishDiagnostics", { uri, diagnostics });
    }

    async function refreshAffectedDiagnostics(uri) {
        const roots = new Set([uri]);
        for (const [root, dependencies] of documentDependencies) {
            if (dependencies.has(uri)) roots.add(root);
        }
        for (const root of roots) if (documents.has(root)) await publishWorkspaceDiagnostics(root);
    }

    return {
        handle,
        documents,
        get exited() { return exited; },
    };
}

export async function runLanguageServer(input = stdin, output = stdout) {
    const maximumHeaderBytes = 8 * 1024;
    const maximumBodyBytes = 16 * 1024 * 1024;
    const send = (message) => {
        const body = Buffer.from(JSON.stringify(message), "utf8");
        output.write("Content-Length: " + body.length + "\r\n\r\n");
        output.write(body);
    };
    const server = createLanguageServer(send);
    let buffer = Buffer.alloc(0);
    for await (const chunk of input) {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming]);
        while (true) {
            const boundary = buffer.indexOf("\r\n\r\n");
            if (boundary < 0) {
                if (buffer.length > maximumHeaderBytes) {
                    stderr.write("OMNI language server: header exceeds the 8 KiB limit\n");
                    return;
                }
                break;
            }
            if (boundary > maximumHeaderBytes) {
                stderr.write("OMNI language server: header exceeds the 8 KiB limit\n");
                return;
            }
            const headers = buffer.subarray(0, boundary).toString("ascii");
            const lengthMatch = /^Content-Length:\s*(\d+)\s*$/imu.exec(headers);
            if (!lengthMatch) {
                stderr.write("OMNI language server: expected a Content-Length header\n");
                return;
            }
            const length = Number(lengthMatch[1]);
            if (!Number.isSafeInteger(length) || length > maximumBodyBytes) {
                stderr.write("OMNI language server: message exceeds the 16 MiB limit\n");
                return;
            }
            const bodyStart = boundary + 4;
            if (buffer.length < bodyStart + length) break;
            const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
            buffer = buffer.subarray(bodyStart + length);
            try {
                await server.handle(JSON.parse(body));
            } catch (error) {
                stderr.write("OMNI language server: " + formatTerminalText(error.message) + "\n");
            }
            if (server.exited) return;
        }
    }
}

function complete(source, position) {
    const word = wordAt(source, position);
    const prefix = word?.text ?? "";
    const program = tryParse(source);
    const symbols = new Map();
    for (const keyword of KEYWORDS) symbols.set(keyword, { label: keyword, kind: 14 });
    for (const [name, detail] of BUILTINS) symbols.set(name, { label: name, kind: 3, detail });
    if (program) visit(program, (node) => {
        if (!node.name || !node.nameSpan) return;
        const declaration = declarationDetail(node);
        symbols.set(node.name, { label: node.name, kind: declaration.kind, detail: declaration.detail });
    });
    return [...symbols.values()]
        .filter((item) => item.label.startsWith(prefix))
        .sort((left, right) => left.label.localeCompare(right.label));
}

function hover(source, position) {
    const word = wordAt(source, position);
    if (!word) return null;
    if (BUILTINS.has(word.text)) return { contents: { kind: "markdown", value: "```omni\n" + BUILTINS.get(word.text) + "\n```" } };
    const program = tryParse(source);
    if (!program) return null;
    let found = null;
    visit(program, (node) => {
        if (node.name === word.text && node.nameSpan && node.nameSpan.start <= word.start) {
            if (!found || node.nameSpan.start > found.nameSpan.start) found = node;
        }
    });
    if (!found) return null;
    const detail = declarationDetail(found).detail;
    return { contents: { kind: "markdown", value: "```omni\n" + detail + "\n```" } };
}

function definition(document, position) {
    const word = wordAt(document.text, position);
    if (!word) return null;
    const program = tryParse(document.text);
    if (!program) return null;
    const candidates = [];
    visit(program, (node) => {
        if (node.name === word.text && node.nameSpan) candidates.push(node);
    });
    const preceding = candidates.filter((node) => node.nameSpan.start <= word.start).sort((left, right) => right.nameSpan.start - left.nameSpan.start);
    const found = preceding[0] ?? candidates.sort((left, right) => left.nameSpan.start - right.nameSpan.start)[0];
    if (!found) return null;
    return {
        uri: document.uri,
        range: { start: offsetToPosition(document.text, found.nameSpan.start), end: offsetToPosition(document.text, found.nameSpan.end) },
    };
}

function declarationDetail(node) {
    if (node.kind === "FunctionDeclaration" || node.kind === "ExternalFunctionDeclaration") {
        const parameters = node.parameters.map((parameter) => parameter.name + (parameter.typeAnnotation ? ": " + parameter.typeAnnotation.display : ""));
        return {
            kind: 3,
            detail: "fn " + node.name + "(" + parameters.join(", ") + ")" + (node.returnType ? " -> " + node.returnType.display : ""),
        };
    }
    if (node.kind === "RecordDeclaration") return { kind: 7, detail: "record " + node.name };
    if (node.kind === "EnumDeclaration") return { kind: 7, detail: "enum " + node.name };
    if (node.kind === "BindingDeclaration") {
        const type = node.typeAnnotation?.display ?? inferredType(node.initializer);
        return { kind: 6, detail: (node.mutable ? "var " : "let ") + node.name + (type ? ": " + type : "") };
    }
    if (node.kind === "ImportDeclaration") return { kind: 9, detail: "module " + node.name };
    if (node.typeAnnotation) return { kind: 6, detail: node.name + ": " + node.typeAnnotation.display };
    if (node.kind === "BindingPattern") return { kind: 6, detail: "binding " + node.name };
    return { kind: 6, detail: node.name };
}

function inferredType(expression) {
    if (expression?.kind !== "LiteralExpression") return null;
    if (expression.literalType === "number") return Number.isInteger(expression.value) ? "Int" : "Float";
    if (expression.literalType === "text") return "Text";
    if (expression.literalType === "bool") return "Bool";
    return "Unit";
}

function visit(value, callback) {
    if (Array.isArray(value)) {
        for (const item of value) visit(item, callback);
        return;
    }
    if (!value || typeof value !== "object") return;
    callback(value);
    for (const [key, child] of Object.entries(value)) {
        if (key === "span" || key === "nameSpan" || key === "typeAnnotation") continue;
        visit(child, callback);
    }
}

function tryParse(source) {
    try {
        return parseSource(source, "<editor>");
    } catch {
        return null;
    }
}

function wordAt(source, position) {
    const offset = positionToOffset(source, position);
    try {
        const token = lex(source, "<editor>").find((candidate) => candidate.kind === "identifier" && offset >= candidate.span.start && offset <= candidate.span.end);
        if (token) return { text: token.value, start: token.span.start, end: token.span.end };
    } catch {
        // A partially typed source can still offer simple lexical completions.
    }
    const lineStart = lineOffset(source, Math.max(0, position?.line ?? 0));
    const before = source.slice(lineStart, offset);
    const match = /[\p{ID_Continue}_]*$/u.exec(before)?.[0] ?? "";
    return match ? { text: match, start: offset - match.length, end: offset } : null;
}

function toLspDiagnostic(error, source) {
    const start = Number.isInteger(error.span?.start)
        ? offsetToPosition(source, error.span.start)
        : { line: Math.max(0, (error.span?.line ?? 1) - 1), character: Math.max(0, (error.span?.column ?? 1) - 1) };
    const end = Number.isInteger(error.span?.end)
        ? offsetToPosition(source, error.span.end)
        : { line: start.line, character: start.character + Math.max(1, error.span?.length ?? 1) };
    return { range: { start, end }, severity: 1, code: error.code, source: "omni", message: error.message };
}

function sourceFor(error, fallback) {
    return typeof error.sourceText === "string" ? error.sourceText : fallback;
}

function diagnosticUri(error, fallback, documents) {
    if (typeof error.sourceName !== "string" || error.sourceName.startsWith("<")) return fallback;
    try { return documentUriForPath(error.sourceName, documents); } catch { return fallback; }
}

function documentUriForPath(path, documents) {
    const identity = pathIdentity(resolve(path));
    for (const uri of documents.keys()) {
        try {
            if (pathIdentity(resolve(uriToPath(uri))) === identity) return uri;
        } catch { /* Ignore non-file editor documents. */ }
    }
    return pathToFileURL(path).href;
}

function pathIdentity(path) {
    let absolute = resolve(path);
    try { absolute = realpathSync.native(absolute); } catch { /* Keep unresolved editor paths distinct. */ }
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function positionToOffset(source, position = {}) {
    const start = lineOffset(source, Math.max(0, position.line ?? 0));
    const lineEnd = nextLineOffset(source, start);
    return Math.max(start, Math.min(lineEnd, start + Math.max(0, position.character ?? 0)));
}

function offsetToPosition(source, offset) {
    const bounded = Math.max(0, Math.min(source.length, offset));
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < bounded;) {
        if (source[index] === "\r") {
            index += source[index + 1] === "\n" ? 2 : 1;
            if (index <= bounded) { line += 1; lineStart = index; }
        } else if (source[index] === "\n") {
            index += 1;
            if (index <= bounded) { line += 1; lineStart = index; }
        } else {
            index += 1;
        }
    }
    return { line, character: bounded - lineStart };
}

function lineOffset(source, line) {
    if (line === 0) return 0;
    let currentLine = 0;
    for (let index = 0; index < source.length;) {
        if (source[index] === "\r") {
            index += source[index + 1] === "\n" ? 2 : 1;
            currentLine += 1;
            if (currentLine === line) return index;
        } else if (source[index] === "\n") {
            index += 1;
            currentLine += 1;
            if (currentLine === line) return index;
        } else index += 1;
    }
    return source.length;
}

function nextLineOffset(source, start) {
    let index = start;
    while (index < source.length && source[index] !== "\r" && source[index] !== "\n") index += 1;
    return index;
}

function applyChange(source, change) {
    const start = positionToOffset(source, change.range.start);
    const end = positionToOffset(source, change.range.end);
    return source.slice(0, start) + change.text + source.slice(Math.max(start, end));
}

function isFileUri(uri) {
    try { return new URL(uri).protocol === "file:"; } catch { return false; }
}

function uriToPath(uri) {
    return fileURLToPath(new URL(uri));
}
