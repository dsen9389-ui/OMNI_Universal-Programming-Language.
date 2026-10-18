import { lex } from "./lexer.mjs";
import { parse } from "./parser.mjs";

const closingTokens = new Set(["}"]);
const binaryOperators = new Set([
    "=", "->", "=>", "or", "and", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%",
]);
const unaryPredecessors = new Set([
    "(", "[", "{", ",", ":", "=", "->", "=>", "or", "and", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%",
]);
const spacedParenthesisKeywords = new Set(["if", "while", "for", "match", "return"]);

/**
 * Normalize OMNI whitespace while preserving the token stream and every comment.
 * Invalid source is rejected before any formatted text is returned.
 */
export function formatOmni(source, sourceName = "<input>") {
    const hasBom = source.startsWith("\uFEFF");
    const tokens = lex(source, sourceName);
    parse(tokens, source, sourceName);

    const sourceLines = source.split(/\r\n|\r|\n/u);
    const tokensByLine = new Map();
    for (const token of tokens) {
        if (token.kind === "eof") continue;
        const lineTokens = tokensByLine.get(token.span.line) ?? [];
        lineTokens.push(token);
        tokensByLine.set(token.span.line, lineTokens);
    }

    const formattedLines = [];
    let blockDepth = 0;
    for (let index = 0; index < sourceLines.length; index += 1) {
        const lineNumber = index + 1;
        const tokensOnLine = tokensByLine.get(lineNumber) ?? [];
        const comment = findComment(sourceLines[index]);
        if (tokensOnLine.length === 0) {
            formattedLines.push(comment === null ? "" : indent(blockDepth) + comment);
            continue;
        }

        let lineDepth = blockDepth;
        for (const token of tokensOnLine) {
            if (!closingTokens.has(token.value)) break;
            lineDepth = Math.max(0, lineDepth - 1);
        }
        let rendered = indent(lineDepth) + renderTokens(tokensOnLine, source);
        if (comment !== null) rendered += "  " + comment;
        formattedLines.push(rendered);

        for (const token of tokensOnLine) {
            if (token.value === "{") blockDepth += 1;
            else if (closingTokens.has(token.value)) blockDepth = Math.max(0, blockDepth - 1);
        }
    }

    while (formattedLines.length > 0 && formattedLines.at(-1) === "") formattedLines.pop();
    return (hasBom ? "\uFEFF" : "") + formattedLines.join("\n") + "\n";
}

function renderTokens(tokens, source) {
    let result = "";
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const previous = tokens[index - 1] ?? null;
        if (previous && needsSpace(previous, token, index, tokens)) result += " ";
        result += source.slice(token.span.start, token.span.end);
    }
    return result;
}

function needsSpace(previous, current, index, tokens) {
    const before = previous.value;
    const value = current.value;

    if ([")", "]", ",", ":", ".", "?"].includes(value)) return false;
    if (value === "(") return spacedParenthesisKeywords.has(before) || binaryOperators.has(before) || before === "," || before === ":";
    if (value === "[") return spacedParenthesisKeywords.has(before) || binaryOperators.has(before) || before === "in" || before === "," || before === ":";
    if (value === "{") return true;
    if (value === "}") return before !== "{";
    if (["(", "[", "."].includes(before)) return false;
    if (before === "{") return true;
    if (before === "!" || (before === "-" && isUnary(index, tokens))) return false;
    if (value === "!" || (value === "-" && isUnary(index, tokens))) return !["(", "[", "."].includes(before);
    if (binaryOperators.has(value) || binaryOperators.has(before)) return true;
    if (before === "," || before === ":") return true;
    return true;
}

function isUnary(index, tokens) {
    const previous = tokens[index - 1];
    return !previous || unaryPredecessors.has(previous.value);
}

function findComment(line) {
    let inString = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
        } else if (character === '"') {
            inString = true;
        } else if (character === "#") {
            return line.slice(index).trimEnd();
        }
    }
    return null;
}

function indent(depth) {
    return "    ".repeat(depth);
}
