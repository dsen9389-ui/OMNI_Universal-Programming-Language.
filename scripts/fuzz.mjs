import { formatTerminalOutput, OmniDiagnostic } from "../src/diagnostics.mjs";
import { parseSource } from "../src/frontend.mjs";
import { checkProgram } from "../src/checker.mjs";
import { createEngine } from "../src/engines.mjs";
import { createSemanticProgram } from "../src/ir.mjs";

const seed = 0x4f4d4e49;
const cases = 1_200;
const executionCases = 256;
const vocabulary = [
    "fn", "let", "var", "return", "if", "else", "while", "for", "in", "break", "continue",
    "true", "false", "none", "and", "or", "record", "enum", "match", "import", "as",
    "Int", "Text", "Bool", "Any", "value", "number", "item", "main", "print", "len",
    "0", "1", "-1", "3.14", '"text"', '"unfinished', "(", ")", "{", "}", "[", "]",
    ":", ",", ".", "+", "-", "*", "/", "%", "=", "==", "!", "?", "=>", "->", "@", "#",
    "🌍", "\u202e", "\u001b",
];

let randomState = seed;
let parsed = 0;
let diagnostics = 0;

for (let index = 0; index < cases; index += 1) {
    const length = 8 + nextRandom() % 96;
    const source = Array.from({ length }, () => vocabulary[nextRandom() % vocabulary.length]).join(" ");
    checkWithoutExecution(source, "random case " + index);
}

for (const [name, source] of [
    ["long arithmetic chain", Array(10_000).fill("1").join(" + ")],
    ["long logical chain", Array(10_000).fill("true").join(" and ")],
    ["deep parentheses", "(".repeat(2_000) + "1" + ")".repeat(2_000)],
    ["deep unary chain", "!".repeat(2_000) + "true"],
    ["deep blocks", "if true {".repeat(2_000) + "print(1)" + "}".repeat(2_000)],
]) {
    checkWithoutExecution(source, name);
}

fuzzPortableExecutions(executionCases);

process.stdout.write("OMNI deterministic fuzz: " + cases + " generated cases and 5 adversarial cases; " +
    parsed + " parsed and checked, " + diagnostics + " source diagnostics; " + executionCases +
    " bounded pure expression cases executed across three engines (seed 0x" + seed.toString(16) + ").\n");

function checkWithoutExecution(source, label) {
    try {
        const program = parseSource(source, "<fuzz:" + label + ">");
        parsed += 1;
        checkProgram(program, { sourceName: "<fuzz:" + label + ">", sourceText: source });
    } catch (error) {
        if (!(error instanceof OmniDiagnostic)) {
            process.stderr.write(formatTerminalOutput("OMNI fuzz found an uncontrolled failure in " + label + ": " + error.stack) + "\n");
            process.exitCode = 1;
            process.exit();
        }
        diagnostics += 1;
    }
}

function nextRandom() {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
}

function fuzzPortableExecutions(count) {
    const engineNames = ["interpreter", "bytecode", "javascript"];
    for (let index = 0; index < count; index += 1) {
        const expression = nextRandom() % 2 === 0 ? generateIntegerExpression() : generateBooleanExpression();
        const label = "execution case " + index;
        const context = { sourceName: "<fuzz:" + label + ">", sourceText: expression.source };
        try {
            const program = parseSource(expression.source, context.sourceName);
            const typeInterface = checkProgram(program, context);
            const semantic = createSemanticProgram(program, context, typeInterface);
            for (const engineName of engineNames) {
                const output = [];
                const engine = createEngine(engineName, { output: (text) => output.push(text) });
                const actual = engine.run(semantic);
                if (!Object.is(actual, expression.value) || output.length !== 0) {
                    throw new Error(engineName + " disagreed with the generated expression result");
                }
            }
        } catch (error) {
            process.stderr.write(formatTerminalOutput("OMNI differential fuzz found an uncontrolled failure in " +
                label + ": " + error.stack) + "\n");
            process.exit(1);
        }
    }
}

function generateIntegerExpression(depth = 0) {
    if (depth >= 4 || nextRandom() % 4 === 0) {
        const value = (nextRandom() % 19) - 9;
        return { source: String(value), value };
    }

    switch (nextRandom() % 4) {
        case 0: {
            const operand = generateIntegerExpression(depth + 1);
            return { source: "- (" + operand.source + ")", value: -operand.value };
        }
        case 1:
        case 2:
        case 3: {
            const left = generateIntegerExpression(depth + 1);
            const right = generateIntegerExpression(depth + 1);
            const operators = ["+", "-", "*"];
            const operator = operators[nextRandom() % operators.length];
            const value = operator === "+" ? left.value + right.value :
                operator === "-" ? left.value - right.value : left.value * right.value;
            return { source: "(" + left.source + " " + operator + " " + right.source + ")", value };
        }
    }
}

function generateBooleanExpression(depth = 0) {
    if (depth >= 4) {
        const value = nextRandom() % 2 === 0;
        return { source: String(value), value };
    }

    switch (nextRandom() % 5) {
        case 0: {
            const value = nextRandom() % 2 === 0;
            return { source: String(value), value };
        }
        case 1: {
            const operand = generateBooleanExpression(depth + 1);
            return { source: "!(" + operand.source + ")", value: !operand.value };
        }
        case 2:
        case 3: {
            const left = generateBooleanExpression(depth + 1);
            const right = generateBooleanExpression(depth + 1);
            const operator = nextRandom() % 2 === 0 ? "and" : "or";
            return {
                source: "(" + left.source + " " + operator + " " + right.source + ")",
                value: operator === "and" ? left.value && right.value : left.value || right.value,
            };
        }
        case 4: {
            const left = generateIntegerExpression(depth + 1);
            const right = generateIntegerExpression(depth + 1);
            const operators = ["==", "!=", "<", "<=", ">", ">="];
            const operator = operators[nextRandom() % operators.length];
            const value = operator === "==" ? left.value === right.value :
                operator === "!=" ? left.value !== right.value :
                operator === "<" ? left.value < right.value :
                operator === "<=" ? left.value <= right.value :
                operator === ">" ? left.value > right.value : left.value >= right.value;
            return { source: "(" + left.source + " " + operator + " " + right.source + ")", value };
        }
    }
}
