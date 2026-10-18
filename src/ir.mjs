/**
 * OMNI's phase 3 engines share the checked parser tree as their semantic IR.
 * The parser node schema is the HIR: operators, lexical constructs, and source
 * spans are explicit, while trivia and token details have already been removed.
 */
export const SEMANTIC_IR_VERSION = 1;

export function createSemanticProgram(program, context, typeInterface = null) {
    if (!program || program.kind !== "Program" || !Array.isArray(program.declarations)) {
        throw new TypeError("expected a parsed OMNI Program");
    }
    if (!context || typeof context.sourceName !== "string" || typeof context.sourceText !== "string") {
        throw new TypeError("a semantic program needs its source context");
    }
    return Object.freeze({
        kind: "SemanticProgram",
        version: SEMANTIC_IR_VERSION,
        program,
        context,
        typeInterface,
    });
}

export function unwrapSemanticProgram(input, context = null) {
    if (input?.kind === "SemanticProgram") {
        if (input.version !== SEMANTIC_IR_VERSION) {
            throw new TypeError("unsupported OMNI semantic IR version " + input.version);
        }
        return input;
    }
    if (!context) throw new TypeError("an OMNI semantic program needs a source context");
    return createSemanticProgram(input, context);
}
