import { lex } from "./lexer.mjs";
import { parse } from "./parser.mjs";

export function parseSource(source, sourceName = "<input>") {
    const tokens = lex(source, sourceName);
    return parse(tokens, source, sourceName);
}
