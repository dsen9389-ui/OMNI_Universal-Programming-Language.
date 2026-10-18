import { fail } from "./diagnostics.mjs";
import { hasUnsupportedInterpolation, interpolationNames } from "./lexer.mjs";

const allowedTypeNames = new Set(["Any", "Number", "Int", "Float", "Text", "String", "Bool", "Unit", "List", "Option", "Result"]);

export function validatePortableProgram(program, context, engineName) {
    for (const declaration of program.declarations) validateStatement(declaration, context, engineName);
}

function unsupported(context, engineName, feature, span) {
    fail(
        "E3002",
        "the " + engineName + " engine does not support " + feature + " yet; use --engine interpreter for this program",
        span,
        context.sourceName,
        context.sourceText,
    );
}

function validateType(reference, context, engineName) {
    if (!allowedTypeNames.has(reference.path?.[0]) || reference.path.length !== 1) {
        unsupported(context, engineName, "type '" + reference.display + "'", reference.span);
    }
    const expectedArguments = reference.path[0] === "List" ? [0, 1]
        : reference.path[0] === "Option" ? [1, 1]
            : reference.path[0] === "Result" ? [2, 2]
                : [0, 0];
    if (reference.arguments.length < expectedArguments[0] || reference.arguments.length > expectedArguments[1]) {
        unsupported(context, engineName, "type arguments on '" + reference.display + "'", reference.span);
    }
    for (const argument of reference.arguments) validateType(argument, context, engineName);
}

function validateStatement(statement, context, engineName) {
    switch (statement.kind) {
        case "BindingDeclaration":
            if (statement.typeAnnotation) validateType(statement.typeAnnotation, context, engineName);
            validateExpression(statement.initializer, context, engineName);
            return;
        case "FunctionDeclaration":
            for (const parameter of statement.parameters) {
                if (parameter.typeAnnotation) validateType(parameter.typeAnnotation, context, engineName);
            }
            if (statement.returnType) validateType(statement.returnType, context, engineName);
            validateStatement(statement.body, context, engineName);
            return;
        case "BlockStatement":
            for (const declaration of statement.declarations) validateStatement(declaration, context, engineName);
            return;
        case "ExpressionStatement":
            validateExpression(statement.expression, context, engineName);
            return;
        case "IfStatement":
            validateExpression(statement.condition, context, engineName);
            validateStatement(statement.thenBranch, context, engineName);
            if (statement.elseBranch) validateStatement(statement.elseBranch, context, engineName);
            return;
        case "WhileStatement":
            validateExpression(statement.condition, context, engineName);
            validateStatement(statement.body, context, engineName);
            return;
        case "ForStatement":
            validateExpression(statement.iterable, context, engineName);
            validateStatement(statement.body, context, engineName);
            return;
        case "ReturnStatement":
            validateExpression(statement.value, context, engineName);
            return;
        case "BreakStatement":
        case "ContinueStatement":
            return;
        case "ImportDeclaration":
            unsupported(context, engineName, "module imports", statement.span);
            return;
        case "RecordDeclaration":
        case "EnumDeclaration":
            unsupported(context, engineName, "user-defined data types", statement.span);
            return;
        case "MatchStatement":
            unsupported(context, engineName, "pattern matching", statement.span);
            return;
        default:
            unsupported(context, engineName, "this statement form", statement.span);
    }
}

function validateExpression(expression, context, engineName) {
    switch (expression.kind) {
        case "LiteralExpression":
            if (expression.literalType === "text" && hasUnsupportedInterpolation(expression.value)) {
                fail("E1018", "string interpolation currently accepts a variable name such as {name}", expression.span, context.sourceName, context.sourceText);
            }
            return;
        case "IdentifierExpression":
            return;
        case "ListExpression":
            for (const element of expression.elements) validateExpression(element, context, engineName);
            return;
        case "UnaryExpression":
            validateExpression(expression.operand, context, engineName);
            return;
        case "BinaryExpression":
            validateExpression(expression.left, context, engineName);
            validateExpression(expression.right, context, engineName);
            return;
        case "AssignmentExpression":
            if (expression.target.kind === "MemberExpression") {
                unsupported(context, engineName, "record field assignment", expression.target.span);
            }
            validateExpression(expression.target, context, engineName);
            validateExpression(expression.value, context, engineName);
            return;
        case "CallExpression":
            if (expression.arguments.some((argument) => argument.kind === "NamedArgument")) {
                unsupported(context, engineName, "named arguments", expression.span);
            }
            validateExpression(expression.callee, context, engineName);
            for (const argument of expression.arguments) validateExpression(argument, context, engineName);
            return;
        case "IndexExpression":
            validateExpression(expression.object, context, engineName);
            validateExpression(expression.index, context, engineName);
            return;
        case "MemberExpression":
            unsupported(context, engineName, "member access", expression.span);
            return;
        default:
            unsupported(context, engineName, "this expression form", expression.span);
    }
}

export class JavaScriptCompiler {
    constructor(program, context) {
        this.program = program;
        this.context = context;
        this.scopes = [new Map()];
        this.nextName = 0;
        this.topLevel = [];
    }

    compile() {
        const statements = this.program.declarations.map((statement) => this.emitStatement(statement, true)).join("\n");
        const exports = this.topLevel.map(({ name, javascriptName }) =>
            "[" + JSON.stringify(name) + ", __omni.exportBinding(() => " + javascriptName + ")]",
        ).join(", ");
        return [
            "(() => {",
            '"use strict";',
            "let __omni_last = null;",
            statements,
            "return { value: __omni_last, exports: [" + exports + "] };",
            "})()",
        ].join("\n");
    }

    emitStatement(statement, topLevel = false) {
        switch (statement.kind) {
            case "BindingDeclaration": {
                const initializer = this.emitExpression(statement.initializer);
                const binding = this.define(statement.name, statement.mutable, statement.typeAnnotation, topLevel);
                const declarationKind = statement.mutable ? "let" : "const";
                const value = statement.typeAnnotation
                    ? "__omni.assertType(" + initializer + ", " + JSON.stringify(statement.typeAnnotation) + ", " + JSON.stringify(statement.name) + ", " + JSON.stringify(statement.span) + ")"
                    : initializer;
                return declarationKind + " " + binding.javascriptName + " = " + value + ";" +
                    (topLevel ? "\n__omni_last = " + binding.javascriptName + ";" : "");
            }
            case "FunctionDeclaration": {
                const binding = this.define(statement.name, false, null, topLevel);
                const priorScopes = this.scopes;
                this.scopes = [...priorScopes, new Map()];
                const parameterDefinitions = statement.parameters.map((parameter) =>
                    this.define(parameter.name, false, parameter.typeAnnotation, false),
                );
                const body = this.emitStatement(statement.body, false);
                this.scopes = priorScopes;
                const parameters = statement.parameters.map((parameter) => ({
                    name: parameter.name,
                    typeAnnotation: parameter.typeAnnotation,
                    span: parameter.span,
                }));
                const lines = [
                    "const " + binding.javascriptName + " = __omni.createFunction(" +
                        JSON.stringify(statement.name) + ", " + JSON.stringify(parameters) + ", " +
                        JSON.stringify(statement.returnType) + ", " + JSON.stringify(statement.body.span) + ", (__omni_args) => {",
                ];
                for (let index = 0; index < parameterDefinitions.length; index += 1) {
                    lines.push("const " + parameterDefinitions[index].javascriptName + " = __omni_args[" + index + "];");
                }
                lines.push(body);
                lines.push("return null;");
                lines.push("});");
                if (topLevel) lines.push("__omni_last = null;");
                return lines.join("\n");
            }
            case "BlockStatement": {
                const code = this.emitBlock(statement);
                return topLevel ? code + "\n__omni_last = null;" : code;
            }
            case "ExpressionStatement": {
                const line = this.emitExpression(statement.expression) + ";";
                return topLevel ? "__omni_last = " + line : line;
            }
            case "IfStatement": {
                const condition = "__omni.requireBoolean(" + this.emitExpression(statement.condition) + ", " + JSON.stringify(statement.condition.span) + ")";
                let code = "if (" + condition + ") " + this.emitStatement(statement.thenBranch, false);
                if (statement.elseBranch) code += " else " + this.emitStatement(statement.elseBranch, false);
                if (topLevel) code += "\n__omni_last = null;";
                return code;
            }
            case "WhileStatement": {
                const condition = "__omni.requireBoolean(" + this.emitExpression(statement.condition) + ", " + JSON.stringify(statement.condition.span) + ")";
                const code = "while (" + condition + ") " + this.emitStatement(statement.body, false);
                return topLevel ? code + "\n__omni_last = null;" : code;
            }
            case "ForStatement": {
                const iterable = this.emitExpression(statement.iterable);
                this.scopes.push(new Map());
                const loopBinding = this.define(statement.name, false, null, false);
                const body = this.emitStatement(statement.body, false);
                this.scopes.pop();
                const code = "for (const __omni_item of __omni.iterate(" + iterable + ", " + JSON.stringify(statement.iterable.span) + ")) {\n" +
                    "const " + loopBinding.javascriptName + " = __omni_item;\n" + body + "\n}";
                return topLevel ? code + "\n__omni_last = null;" : code;
            }
            case "ReturnStatement":
                return "return " + this.emitExpression(statement.value) + ";";
            case "BreakStatement": return "break;";
            case "ContinueStatement": return "continue;";
            default: throw new Error("validated JavaScript statement was not emitted: " + statement.kind);
        }
    }

    emitBlock(block) {
        this.scopes.push(new Map());
        const body = block.declarations.map((statement) => this.emitStatement(statement, false)).join("\n");
        this.scopes.pop();
        return "{\n" + body + "\n}";
    }

    emitExpression(expression) {
        const span = JSON.stringify(expression.span);
        let value;
        switch (expression.kind) {
            case "LiteralExpression":
                if (expression.literalType === "text") {
                    const names = interpolationNames(expression.value);
                    const cases = names.map((name) => "case " + JSON.stringify(name) + ": return " + this.resolve(name).javascriptName + ";").join("\n");
                    value = "__omni.interpolate(" + JSON.stringify(expression.value) + ", (name) => { switch (name) { " + cases + " default: return __omni.error(\"E1001\", \"unknown name '\" + name + \"'\", " + span + "); } }, " + span + ")";
                } else {
                    value = JSON.stringify(expression.value);
                }
                break;
            case "IdentifierExpression": {
                const binding = this.find(expression.name);
                value = binding ? binding.javascriptName : "__omni.builtins[" + JSON.stringify(expression.name) + "]";
                break;
            }
            case "ListExpression":
                value = "[" + expression.elements.map((element) => this.emitExpression(element)).join(", ") + "]";
                break;
            case "UnaryExpression":
                value = "__omni.unary(" + JSON.stringify(expression.operator) + ", " + this.emitExpression(expression.operand) + ", " +
                    JSON.stringify(expression.operand.span) + ", " + span + ")";
                break;
            case "BinaryExpression":
                if (expression.operator === "and" || expression.operator === "or") {
                    value = "__omni.logical(" + JSON.stringify(expression.operator) + ", () => " + this.emitExpression(expression.left) +
                        ", () => " + this.emitExpression(expression.right) + ", " + JSON.stringify(expression.left.span) + ", " + JSON.stringify(expression.right.span) + ")";
                } else {
                    value = "__omni.binary(" + JSON.stringify(expression.operator) + ", " + this.emitExpression(expression.left) + ", " +
                        this.emitExpression(expression.right) + ", " + JSON.stringify(expression.left.span) + ", " + JSON.stringify(expression.right.span) + ", " + span + ")";
                }
                break;
            case "AssignmentExpression":
                if (expression.target.kind === "IdentifierExpression") {
                    const binding = this.find(expression.target.name);
                    if (!binding) {
                        value = "__omni.error(\"E1001\", \"unknown name '" + expression.target.name + "'\", " + JSON.stringify(expression.target.span) + ")";
                    } else {
                        value = "__omni.assignBinding(" + JSON.stringify(binding.mutable) + ", () => " + binding.javascriptName +
                            ", (value) => { " + binding.javascriptName + " = value; }, () => " + this.emitExpression(expression.value) +
                            ", " + JSON.stringify(expression.target.name) + ", " + JSON.stringify(binding.typeAnnotation) + ", " + JSON.stringify(expression.target.span) + ")";
                    }
                } else {
                    value = "__omni.assignIndex(() => " + this.emitExpression(expression.target.object) + ", () => " +
                        this.emitExpression(expression.target.index) + ", () => " + this.emitExpression(expression.value) + ", " + JSON.stringify(expression.target.span) + ")";
                }
                break;
            case "CallExpression":
                value = "__omni.invoke(" + this.emitExpression(expression.callee) + ", [" + expression.arguments.map((argument) => this.emitExpression(argument)).join(", ") +
                    "], " + span + ", " + JSON.stringify(expression.callee.span) + ")";
                break;
            case "IndexExpression":
                value = "__omni.getIndex(" + this.emitExpression(expression.object) + ", " + this.emitExpression(expression.index) + ", " + span + ")";
                break;
            default: throw new Error("validated JavaScript expression was not emitted: " + expression.kind);
        }
        return "(__omni.enterExpression(" + span + "), __omni.leaveExpression(" + value + "))";
    }

    define(name, mutable, typeAnnotation, topLevel) {
        if (this.scopes.at(-1).has(name)) throw new Error("duplicate declaration reached compiler after checking");
        const binding = { javascriptName: "__omni_v" + this.nextName++, mutable, typeAnnotation };
        this.scopes.at(-1).set(name, binding);
        if (topLevel) this.topLevel.push({ name, javascriptName: binding.javascriptName });
        return binding;
    }

    find(name) {
        for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
            const binding = this.scopes[index].get(name);
            if (binding) return binding;
        }
        return null;
    }

    resolve(name) {
        const binding = this.find(name);
        if (binding) return binding;
        if (Object.hasOwn(BUILTIN_NAMES, name)) return { javascriptName: "__omni.builtins[" + JSON.stringify(name) + "]" };
        return { javascriptName: "__omni.error(\"E1001\", \"unknown name '" + name + "'\", null)" };
    }
}

const BUILTIN_NAMES = Object.freeze({
    print: true, len: true, str: true, type_of: true, range: true,
    push: true, pop: true, map: true, filter: true, some: true, ok: true, err: true,
    serial_write: true, gpio_write: true,
});

export function compileJavaScript(program, context) {
    validatePortableProgram(program, context, "javascript");
    return new JavaScriptCompiler(program, context).compile();
}
