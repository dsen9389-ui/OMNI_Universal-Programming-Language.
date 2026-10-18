export class OmniDiagnostic extends Error {
    constructor(code, message, span, sourceName, sourceText, notes = []) {
        super(message);
        this.name = "OmniDiagnostic";
        this.code = code;
        this.span = span;
        this.sourceName = sourceName;
        this.sourceText = sourceText;
        this.notes = notes;
    }
}

export function fail(code, message, span, sourceName, sourceText, notes = []) {
    throw new OmniDiagnostic(code, message, span, sourceName, sourceText, notes);
}

export function formatDiagnostic(error) {
    const span = error.span ?? { line: 1, column: 1, length: 1 };
    const name = visibleText(error.sourceName || "<input>");
    const line = span.line ?? 1;
    const column = span.column ?? 1;
    const header = name + ":" + line + ":" + column + ": error[" + visibleText(error.code ?? "E0000") + "]: " + visibleText(error.message);
    const lines = [header];

    if (error.sourceText !== undefined) {
        const sourceLines = error.sourceText.split(/\r\n|\r|\n/u);
        const sourceLine = sourceLines[line - 1] ?? "";
        const excerpt = visibleText(sourceLine, true);
        const sourceSpan = Number.isInteger(span.start) && Number.isInteger(span.end)
            ? error.sourceText.slice(span.start, span.end)
            : "";
        const sourceLineSpan = sourceSpan.split(/\r\n|\r|\n/u, 1)[0];
        const markerLength = Math.max(1, visibleLength(sourceLineSpan) || span.length || 1);
        lines.push("  " + excerpt);
        const prefixLength = visibleLength(Array.from(sourceLine).slice(0, Math.max(0, column - 1)).join(""), true);
        lines.push("  " + " ".repeat(Math.max(0, prefixLength)) + "^".repeat(Math.max(1, Math.min(markerLength, 80))));
    }

    for (const note of error.notes ?? []) {
        lines.push("  note: " + visibleText(note));
    }
    return lines.join("\n");
}

function visibleLength(value, tabsAsSpaces = false) {
    return Array.from(visibleText(value, tabsAsSpaces)).length;
}

export function formatTerminalText(value) {
    return visibleText(value);
}

export function formatTerminalOutput(value) {
    return String(value).split(/\r\n|\r|\n/u).map((line) => visibleText(line)).join("\n");
}

function visibleText(value, tabsAsSpaces = false) {
    let result = "";
    for (const character of String(value)) {
        const codePoint = character.codePointAt(0);
        if (tabsAsSpaces && character === "\t") {
            result += " ";
        } else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ||
            (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069) ||
            codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f || codePoint === 0xfeff) {
            result += "\\u{" + codePoint.toString(16) + "}";
        } else {
            result += character;
        }
    }
    return result;
}
