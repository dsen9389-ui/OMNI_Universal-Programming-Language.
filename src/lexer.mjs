import { fail } from "./diagnostics.mjs";

export const ESCAPED_MARKER = "\uE000";
export const ESCAPED_LITERAL_MARKER = ESCAPED_MARKER + "\u0000";
export const ESCAPED_OPEN_BRACE = ESCAPED_MARKER + "\u0001";
export const ESCAPED_CLOSE_BRACE = ESCAPED_MARKER + "\u0002";

const identifierStart = (character) => character === "_" || /^\p{ID_Start}$/u.test(character);
const identifierContinue = (character) => character === "_" || /^\p{ID_Continue}$/u.test(character);
const isDigit = (character) => character !== "" && character >= "0" && character <= "9";
const isSpace = (character) => character === " " || character === "\t" || character === "\r" || character === "\n";

export class Lexer {
    constructor(source, sourceName) {
        this.source = source;
        this.sourceName = sourceName;
        this.index = source.startsWith("\uFEFF") ? 1 : 0;
        this.line = 1;
        this.column = 1;
        this.tokens = [];
    }

    lex() {
        while (!this.atEnd()) {
            this.skipTrivia();
            if (this.atEnd()) break;

            const start = this.position();
            const character = this.peek();
            if (identifierStart(character)) {
                this.scanIdentifier(start);
            } else if (isDigit(character)) {
                this.scanNumber(start);
            } else if (character === '"') {
                this.scanString(start);
            } else {
                this.scanSymbol(start);
            }
        }

        const position = this.position();
        this.tokens.push({
            kind: "eof",
            value: "",
            span: this.makeSpan(position),
        });
        return this.tokens;
    }

    skipTrivia() {
        while (!this.atEnd()) {
            if (isSpace(this.peek())) {
                this.advance();
            } else if (this.peek() === "#") {
                while (!this.atEnd() && this.peek() !== "\n" && this.peek() !== "\r") this.advance();
            } else {
                break;
            }
        }
    }

    scanIdentifier(start) {
        let value = this.advance();
        while (!this.atEnd() && identifierContinue(this.peek())) value += this.advance();
        this.emit("identifier", value, start);
    }

    scanNumber(start) {
        while (isDigit(this.peek()) || this.peek() === "_") this.advance();

        let hasFraction = false;
        if (this.peek() === "." && isDigit(this.peekNext())) {
            hasFraction = true;
            this.advance();
            while (isDigit(this.peek()) || this.peek() === "_") this.advance();
        }

        let hasExponent = false;
        if (this.peek() === "e" || this.peek() === "E") {
            hasExponent = true;
            this.advance();
            if (this.peek() === "+" || this.peek() === "-") this.advance();
            if (!isDigit(this.peek())) {
                fail("E0002", "expected a digit after the exponent marker", this.makeSpan(start), this.sourceName, this.source);
            }
            while (isDigit(this.peek()) || this.peek() === "_") this.advance();
        }

        const text = this.source.slice(start.offset, this.index);
        if (!/^\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/u.test(text)) {
            fail("E0002", "underscores must appear between digits in a number", this.makeSpan(start), this.sourceName, this.source);
        }
        const value = Number(text.replaceAll("_", ""));
        if (!Number.isFinite(value)) {
            fail("E0002", "number is outside the supported finite range", this.makeSpan(start), this.sourceName, this.source);
        }
        if (!hasFraction && !hasExponent && !Number.isSafeInteger(value)) {
            fail("E0002", "integer literal is outside the exact integer range; use a Float value instead", this.makeSpan(start), this.sourceName, this.source);
        }
        this.emit("number", value, start);
    }

    scanString(start) {
        this.advance();
        let value = "";
        while (!this.atEnd() && this.peek() !== '"') {
            if (this.peek() === "\n" || this.peek() === "\r") {
                fail("E0003", "string literals cannot contain a raw newline", this.makeSpan(start), this.sourceName, this.source);
            }
            if (this.peek() !== "\\") {
                const character = this.advance();
                value += character === ESCAPED_MARKER ? ESCAPED_LITERAL_MARKER : character;
                continue;
            }

            this.advance();
            if (this.atEnd()) {
                fail("E0003", "string ends after an incomplete escape", this.makeSpan(start), this.sourceName, this.source);
            }
            const escape = this.advance();
            const escapes = {
                "\\": "\\",
                '"': '"',
                n: "\n",
                r: "\r",
                t: "\t",
                "{": ESCAPED_OPEN_BRACE,
                "}": ESCAPED_CLOSE_BRACE,
            };
            if (!Object.hasOwn(escapes, escape)) {
                fail("E0003", "unsupported string escape \\" + escape, this.makeSpan(start), this.sourceName, this.source);
            }
            value += escapes[escape];
        }

        if (this.atEnd()) {
            fail("E0003", "unterminated string literal", this.makeSpan(start), this.sourceName, this.source);
        }
        this.advance();
        this.emit("string", value, start);
    }

    scanSymbol(start) {
        const first = this.advance();
        const twoCharacter = first + this.peek();
        if (["==", "!=", "<=", ">=", "=>"].includes(twoCharacter)) {
            this.advance();
            this.emit("symbol", twoCharacter, start);
            return;
        }

        if (first === "-" && this.peek() === ">") {
            this.advance();
            this.emit("symbol", "->", start);
            return;
        }

        if ("(){}[],:.+-*/%=!<>?".includes(first)) {
            this.emit("symbol", first, start);
            return;
        }

        fail("E0001", "unexpected character " + JSON.stringify(first), this.makeSpan(start), this.sourceName, this.source);
    }

    emit(kind, value, start) {
        this.tokens.push({ kind, value, span: this.makeSpan(start) });
    }

    position() {
        return { offset: this.index, line: this.line, column: this.column };
    }

    makeSpan(start) {
        return {
            start: start.offset,
            end: this.index,
            line: start.line,
            column: start.column,
            length: Math.max(1, this.index - start.offset),
        };
    }

    peek() {
        if (this.atEnd()) return "";
        return String.fromCodePoint(this.source.codePointAt(this.index));
    }

    peekNext() {
        if (this.atEnd()) return "";
        const current = this.peek();
        const nextIndex = this.index + current.length;
        if (nextIndex >= this.source.length) return "";
        return String.fromCodePoint(this.source.codePointAt(nextIndex));
    }

    advance() {
        const character = this.peek();
        if (character === "\r") {
            this.index += 1;
            if (this.source[this.index] === "\n") this.index += 1;
            this.line += 1;
            this.column = 1;
            return "\n";
        }
        this.index += character.length;
        if (character === "\n") {
            this.line += 1;
            this.column = 1;
        } else {
            this.column += 1;
        }
        return character;
    }

    atEnd() {
        return this.index >= this.source.length;
    }
}

export function lex(source, sourceName = "<input>") {
    return new Lexer(source, sourceName).lex();
}

export function interpolationNames(template) {
    return inspectInterpolations(template).names;
}

export function hasInterpolation(template) {
    return inspectInterpolations(template).hasInterpolation;
}

export function hasUnsupportedInterpolation(template) {
    return inspectInterpolations(template).unsupported;
}

function inspectInterpolations(template) {
    const names = [];
    let hasInterpolation = false;
    let unsupported = false;
    for (let index = 0; index < template.length;) {
        if (template.startsWith(ESCAPED_LITERAL_MARKER, index)) {
            index += ESCAPED_LITERAL_MARKER.length;
            continue;
        }
        if (template.startsWith(ESCAPED_OPEN_BRACE, index)) {
            index += ESCAPED_OPEN_BRACE.length;
            continue;
        }
        if (template.startsWith(ESCAPED_CLOSE_BRACE, index)) {
            index += ESCAPED_CLOSE_BRACE.length;
            continue;
        }
        if (template[index] === "{" && template[index + 1] === "{") {
            index += 2;
            continue;
        }
        if (template[index] === "}" && template[index + 1] === "}") {
            index += 2;
            continue;
        }
        if (template[index] === "{") {
            const close = template.indexOf("}", index + 1);
            if (close >= 0) {
                const name = template.slice(index + 1, close);
                hasInterpolation = true;
                if (/^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(name)) names.push(name);
                else unsupported = true;
                index = close + 1;
                continue;
            }
        }
        index += 1;
    }
    return { names, hasInterpolation, unsupported };
}

export function decodeLiteralString(template) {
    let result = "";
    for (let index = 0; index < template.length;) {
        if (template.startsWith(ESCAPED_LITERAL_MARKER, index)) {
            result += ESCAPED_MARKER;
            index += ESCAPED_LITERAL_MARKER.length;
        } else if (template.startsWith(ESCAPED_OPEN_BRACE, index)) {
            result += "{";
            index += ESCAPED_OPEN_BRACE.length;
        } else if (template.startsWith(ESCAPED_CLOSE_BRACE, index)) {
            result += "}";
            index += ESCAPED_CLOSE_BRACE.length;
        } else if (template.startsWith("{{", index)) {
            result += "{";
            index += 2;
        } else if (template.startsWith("}}", index)) {
            result += "}";
            index += 2;
        } else {
            result += template[index];
            index += 1;
        }
    }
    return result;
}
