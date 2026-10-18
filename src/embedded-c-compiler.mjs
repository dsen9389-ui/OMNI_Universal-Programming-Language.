import { fail } from "./diagnostics.mjs";
import { decodeLiteralString, hasInterpolation } from "./lexer.mjs";

const C_TYPES = new Set(["Int", "Number", "Float", "Text", "String", "Bool", "Unit"]);
const BUILTINS = new Set(["print", "serial_write", "gpio_write"]);

export function compileEmbeddedC(program, context, options = {}) {
    return new EmbeddedCompiler(program, context, options).compile();
}

class EmbeddedCompiler {
    constructor(program, context, options = {}) {
        this.program = program;
        this.context = context;
        this.allowCAbi = options.allowCAbi === true;
        this.scopes = [new Map()];
        this.functions = new Map();
        this.globals = new Map();
        this.nextName = 0;
        this.functionBodies = [];
        this.mainBody = [];
    }

    compile() {
        this.collectFunctions();
        this.collectGlobals();
        this.compileTopLevel();
        const prototypes = [...this.functions.values()].flatMap((fn) => fn.external
            ? [this.cAbiSignature(fn) + ";", this.invokeSignature(fn) + ";"]
            : [this.functionSignature(fn) + ";", this.invokeSignature(fn) + ";"]).join("\n");
        const definitions = this.functionBodies.join("\n\n");
        const invokers = [...this.functions.values()].map((fn) => this.compileInvoker(fn)).join("\n\n");
        const globals = [...this.globals.values()].map((symbol) => "static " + cType(symbol.type) + " " + symbol.cName + ";").join("\n");
        const main = [
            "OMNI_UNIT omni_main(void) {",
            indent(this.mainBody.filter(Boolean).join("\n")),
            "    return 0;",
            "}",
        ].join("\n");
        return {
            header: platformHeader(),
            source: [
                '#include "omni_platform.h"',
                "#include <float.h>",
                "",
                runtimeSource(this.context.sourceName),
                "",
                globals,
                "",
                prototypes,
                "",
                definitions,
                "",
                invokers,
                "",
                main,
                "",
            ].filter(Boolean).join("\n"),
            simulator: simulatorSource(),
        };
    }

    collectFunctions() {
        for (const declaration of this.program.declarations) {
            const external = declaration.kind === "ExternalFunctionDeclaration";
            if (!external && declaration.kind !== "FunctionDeclaration") continue;
            if (external && !this.allowCAbi) this.unsupported("C ABI declarations without the embedded-ffi-v1 profile", declaration.span);
            if (this.functions.has(declaration.name)) this.unsupported("duplicate functions after checking", declaration.span);
            if (declaration.parameters.some((parameter) => !parameter.typeAnnotation)) {
                this.unsupported("functions with unannotated parameters; add a simple type such as Int, Bool, or Text", declaration.span);
            }
            const parameters = declaration.parameters.map((parameter) => ({
                ...parameter,
                type: this.annotationType(parameter.typeAnnotation, parameter.span),
            }));
            const result = declaration.returnType
                ? this.annotationType(declaration.returnType, declaration.returnType.span)
                : external
                    ? "Unit"
                    : this.hasValueReturn(declaration.body)
                    ? this.unsupported("value-returning functions without an explicit return type", declaration.span)
                    : "Unit";
            if (external && (parameters.some((parameter) => !["Int", "Float", "Bool"].includes(parameter.type)) || !["Int", "Float", "Bool", "Unit"].includes(result))) {
                this.unsupported("C ABI declarations outside the supported Int, Float, Bool, and Unit scalar types", declaration.span);
            }
            this.functions.set(declaration.name, {
                name: declaration.name,
                cName: external ? declaration.name : "omni_fn_" + this.nextName++,
                invokeName: "omni_invoke_" + this.nextName++,
                declaration,
                parameters,
                result,
                external,
            });
        }
    }

    collectGlobals() {
        for (const declaration of this.program.declarations) {
            if (declaration.kind === "BindingDeclaration") {
                const type = declaration.typeAnnotation
                    ? this.annotationType(declaration.typeAnnotation, declaration.typeAnnotation.span)
                    : this.infer(declaration.initializer);
                this.globals.set(declaration.name, {
                    name: declaration.name,
                    cName: "omni_global_" + this.nextName++,
                    type,
                    mutable: declaration.mutable,
                    kind: "variable",
                    annotation: declaration.typeAnnotation,
                });
                this.scopes[0].set(declaration.name, this.globals.get(declaration.name));
            } else if (["FunctionDeclaration", "ExternalFunctionDeclaration"].includes(declaration.kind)) {
                this.scopes[0].set(declaration.name, { ...this.functions.get(declaration.name), kind: "function" });
            }
        }
        this.globalScope = new Map(this.scopes[0]);
    }

    compileTopLevel() {
        for (const declaration of this.program.declarations) {
            if (declaration.kind === "FunctionDeclaration") {
                this.functionBodies.push(this.compileFunction(this.functions.get(declaration.name)));
            } else if (declaration.kind === "ExternalFunctionDeclaration") {
                continue;
            } else if (declaration.kind === "BindingDeclaration") {
                const symbol = this.globals.get(declaration.name);
                const value = this.emitExpression(declaration.initializer, { allowCall: true });
                this.mainBody.push(symbol.cName + " = " + this.checkedAssignment(value, symbol.type, declaration.initializer.span, symbol.annotation) + ";");
            } else {
                this.mainBody.push(this.emitStatement(declaration, true));
            }
        }
    }

    compileFunction(fn) {
        this.scopes = [new Map(this.globalScope), new Map()];
        const parameterList = fn.parameters.map((parameter) => {
            const symbol = {
                name: parameter.name,
                cName: "omni_local_" + this.nextName++,
                type: parameter.type,
                mutable: false,
                kind: "variable",
                annotation: parameter.typeAnnotation,
            };
            parameter.cName = symbol.cName;
            this.scopes.at(-1).set(parameter.name, symbol);
            return cType(parameter.type) + " " + symbol.cName;
        }).join(", ");
        const previousFunction = this.currentFunction;
        this.currentFunction = fn;
        const body = this.emitBlockContents(fn.declaration.body);
        if (fn.result === "Unit") body.push("return 0;");
        const result = [
            this.functionSignature(fn) + " {",
            indent(body.join("\n")),
            "}",
        ].join("\n");
        this.currentFunction = previousFunction;
        this.scopes = [new Map(this.globalScope)];
        return result;
    }

    functionSignature(fn) {
        const parameters = fn.parameters.map((parameter, index) => {
            const symbol = parameter.cName ? parameter.cName : "omni_arg_" + index;
            return cType(parameter.type) + " " + symbol;
        }).join(", ") || "void";
        return cType(fn.result) + " " + fn.cName + "(" + parameters + ")";
    }

    cAbiSignature(fn) {
        const parameters = fn.parameters.map((parameter, index) => cAbiType(parameter.type) + " omni_abi_arg_" + index).join(", ") || "void";
        return "extern " + cAbiType(fn.result) + " " + fn.name + "(" + parameters + ")";
    }

    invokeSignature(fn) {
        const parameters = fn.parameters.map((parameter, index) => cType(parameter.type) + " omni_call_arg_" + index);
        parameters.push("uint32_t omni_call_line", "uint32_t omni_call_column");
        return cType(fn.result) + " " + fn.invokeName + "(" + parameters.join(", ") + ")";
    }

    compileInvoker(fn) {
        if (fn.external) return this.compileExternalInvoker(fn);
        const argumentsList = fn.parameters.map((_parameter, index) => "omni_call_arg_" + index).join(", ");
        const call = fn.cName + "(" + argumentsList + ")";
        return [
            this.invokeSignature(fn) + " {",
            "    omni_enter_call(omni_call_line, omni_call_column);",
            "    " + cType(fn.result) + " omni_call_result = " + call + ";",
            "    omni_leave_call();",
            "    return omni_call_result;",
            "}",
        ].join("\n");
    }

    compileExternalInvoker(fn) {
        const args = fn.parameters.map((parameter, index) => {
            const argument = "omni_call_arg_" + index;
            return parameter.type === "Int"
                ? "omni_ffi_int32(" + argument + ", omni_call_line, omni_call_column)"
                : argument;
        });
        const call = fn.name + "(" + args.join(", ") + ")";
        const lines = [
            this.invokeSignature(fn) + " {",
            "    omni_enter_call(omni_call_line, omni_call_column);",
        ];
        if (fn.result === "Unit") {
            lines.push("    " + call + ";", "    omni_leave_call();", "    return 0;");
        } else {
            lines.push("    " + cAbiType(fn.result) + " omni_abi_result = " + call + ";");
            lines.push("    omni_leave_call();");
            const result = fn.result === "Int"
                ? "(double)omni_abi_result"
                : fn.result === "Float"
                    ? "omni_checked_number(omni_abi_result, omni_call_line, omni_call_column)"
                    : "omni_abi_result";
            lines.push("    return " + result + ";");
        }
        lines.push("}");
        return lines.join("\n");
    }

    emitStatement(statement, topLevel = false) {
        switch (statement.kind) {
            case "BindingDeclaration": {
                const value = this.emitExpression(statement.initializer, { allowCall: true });
                const type = statement.typeAnnotation
                    ? this.annotationType(statement.typeAnnotation, statement.typeAnnotation.span)
                    : this.infer(statement.initializer);
                const symbol = {
                    name: statement.name,
                    cName: "omni_local_" + this.nextName++,
                    type,
                    mutable: statement.mutable,
                    kind: "variable",
                    annotation: statement.typeAnnotation,
                };
                const initialization = cType(type) + " " + symbol.cName + " = " + this.checkedAssignment(value, type, statement.initializer.span, symbol.annotation) + ";";
                this.scopes.at(-1).set(statement.name, symbol);
                return initialization;
            }
            case "FunctionDeclaration":
                this.unsupported("nested functions and closures", statement.span);
                break;
            case "ExternalFunctionDeclaration":
                this.unsupported("C ABI declarations outside the top level", statement.span);
                break;
            case "BlockStatement":
                return this.emitBlock(statement);
            case "ExpressionStatement": {
                const expression = this.emitExpression(statement.expression, { allowCall: statement.expression.kind === "CallExpression" });
                return "(void)(" + expression + ");";
            }
            case "IfStatement": {
                this.requireType(this.infer(statement.condition), "Bool", statement.condition.span);
                const whenTrue = this.emitStatement(statement.thenBranch);
                const whenFalse = statement.elseBranch ? " else " + this.emitStatement(statement.elseBranch) : "";
                return "if (" + this.emitExpression(statement.condition) + ") " + whenTrue + whenFalse;
            }
            case "WhileStatement": {
                this.requireType(this.infer(statement.condition), "Bool", statement.condition.span);
                return "while (" + this.emitExpression(statement.condition) + ") " + this.emitStatement(statement.body);
            }
            case "ReturnStatement": {
                const valueType = this.infer(statement.value);
                if (!this.currentFunction) this.unsupported("return outside a function", statement.span);
                this.requireAssignable(valueType, this.currentFunction.result, statement.value.span);
                const value = this.emitExpression(statement.value, { allowCall: statement.value.kind === "CallExpression" });
                return "return " + this.checkedAssignment(value, this.currentFunction.result, statement.value.span, this.currentFunction.declaration.returnType) + ";";
            }
            case "BreakStatement": return "break;";
            case "ContinueStatement": return "continue;";
            case "ForStatement": this.unsupported("for loops; use a while loop with an explicit counter", statement.span); break;
            case "MatchStatement": this.unsupported("pattern matching", statement.span); break;
            case "RecordDeclaration":
            case "EnumDeclaration": this.unsupported("records and enums", statement.span); break;
            case "ImportDeclaration": this.unsupported("module imports", statement.span); break;
            default: this.unsupported("this statement form", statement.span);
        }
    }

    emitBlock(block) {
        const lines = this.emitBlockContents(block);
        return "{\n" + indent(lines.join("\n")) + "\n}";
    }

    emitBlockContents(block) {
        this.scopes.push(new Map());
        const lines = [];
        for (const declaration of block.declarations) lines.push(this.emitStatement(declaration));
        this.scopes.pop();
        return lines;
    }

    emitExpression(expression, { allowCall = false } = {}) {
        switch (expression.kind) {
            case "LiteralExpression":
                if (expression.literalType === "number") return cNumber(expression.value);
                if (expression.literalType === "bool") return expression.value ? "true" : "false";
                if (expression.literalType === "unit") return "0";
                if (expression.literalType === "text") {
                    if (hasInterpolation(expression.value)) this.unsupported("string interpolation on the embedded target; use serial_write with a complete text value", expression.span);
                    return "omni_text_from_bytes(" + cString(decodeLiteralString(expression.value)) + ", " + Buffer.byteLength(decodeLiteralString(expression.value), "utf8") + "u)";
                }
                break;
            case "IdentifierExpression": {
                const symbol = this.resolve(expression.name, expression.span);
                if (symbol.kind !== "variable") this.unsupported("using a function as a value", expression.span);
                return symbol.cName;
            }
            case "UnaryExpression": {
                const operandType = this.infer(expression.operand);
                if (expression.operator === "!") {
                    this.requireType(operandType, "Bool", expression.operand.span);
                    return "(!" + this.emitExpression(expression.operand) + ")";
                }
                this.requireNumeric(operandType, expression.operand.span);
                return "omni_checked_number(-(" + this.emitExpression(expression.operand) + "), " + loc(expression.span) + ")";
            }
            case "BinaryExpression": return this.emitBinary(expression);
            case "AssignmentExpression": {
                if (expression.target.kind !== "IdentifierExpression") this.unsupported("assigning to list elements or record fields", expression.target.span);
                const symbol = this.resolve(expression.target.name, expression.target.span);
                if (symbol.kind !== "variable") this.unsupported("assigning to a function", expression.target.span);
                const value = this.emitExpression(expression.value, { allowCall: expression.value.kind === "CallExpression" });
                return "(" + symbol.cName + " = " + this.checkedAssignment(value, symbol.type, expression.value.span, symbol.annotation) + ")";
            }
            case "CallExpression":
                if (!allowCall) this.unsupported("a function call inside another expression; keep calls as their own statement or returned value", expression.span);
                return this.emitCall(expression);
            case "ListExpression": this.unsupported("lists and heap allocation on the embedded target", expression.span); break;
            case "IndexExpression": this.unsupported("list and text indexing", expression.span); break;
            case "MemberExpression": this.unsupported("member access", expression.span); break;
            default: this.unsupported("this expression form", expression.span);
        }
    }

    emitBinary(expression) {
        const leftType = this.infer(expression.left);
        const rightType = this.infer(expression.right);
        const operator = expression.operator;
        if (operator !== "and" && operator !== "or" && (hasSideEffect(expression.left) || hasSideEffect(expression.right))) {
            this.unsupported("assignments inside arithmetic or comparison expressions; assign the value on its own line first", expression.span);
        }
        const left = this.emitExpression(expression.left);
        const right = this.emitExpression(expression.right);
        if (operator === "and" || operator === "or") {
            this.requireType(leftType, "Bool", expression.left.span);
            this.requireType(rightType, "Bool", expression.right.span);
            return "(" + left + (operator === "and" ? " && " : " || ") + right + ")";
        }
        if (operator === "==" || operator === "!=") {
            if (leftType === "Text" && rightType === "Text") {
                const equal = "omni_text_equal(" + left + ", " + right + ")";
                return operator === "==" ? equal : "(!" + equal + ")";
            }
            if (leftType === "Bool" && rightType === "Bool") return "(" + left + (operator === "==" ? " == " : " != ") + right + ")";
            this.requireNumeric(leftType, expression.left.span);
            this.requireNumeric(rightType, expression.right.span);
            return "(" + left + (operator === "==" ? " == " : " != ") + right + ")";
        }
        if (["<", "<=", ">", ">="].includes(operator)) {
            this.requireNumeric(leftType, expression.left.span);
            this.requireNumeric(rightType, expression.right.span);
            return "(" + left + " " + operator + " " + right + ")";
        }
        if (operator === "+" && (leftType === "Text" || rightType === "Text")) {
            this.unsupported("dynamic text concatenation on the embedded target", expression.span);
        }
        this.requireNumeric(leftType, expression.left.span);
        this.requireNumeric(rightType, expression.right.span);
        if (operator === "%") this.unsupported("remainder arithmetic in the freestanding target", expression.span);
        const operation = operator === "/"
            ? "omni_divide(" + left + ", " + right + ", " + loc(expression.span) + ")"
            : "(" + left + " " + operator + " " + right + ")";
        return "omni_checked_number(" + operation + ", " + loc(expression.span) + ")";
    }

    emitCall(expression) {
        if (expression.callee.kind !== "IdentifierExpression") this.unsupported("indirect function calls", expression.callee.span);
        const name = expression.callee.name;
        const resolved = this.find(name);
        const args = expression.arguments;
        if (!resolved && BUILTINS.has(name)) {
            if (args.some((argument) => argument.kind === "NamedArgument")) this.unsupported("named arguments", expression.span);
            const argValues = args.map((argument) => argument.kind === "NamedArgument" ? argument.value : argument);
            if (argValues.some(hasSideEffect)) this.unsupported("side-effecting function arguments; place each action on its own line", expression.span);
            if (name === "serial_write") {
                this.requireArity(name, argValues, 1, expression.span);
                this.requireType(this.infer(argValues[0]), "Text", argValues[0].span);
                const text = this.emitExpression(argValues[0]);
                return "omni_write(" + text + ")";
            }
            if (name === "gpio_write") {
                this.requireArity(name, argValues, 2, expression.span);
                this.requireType(this.infer(argValues[0]), "Int", argValues[0].span);
                this.requireType(this.infer(argValues[1]), "Bool", argValues[1].span);
                return "omni_set_gpio(" + this.emitExpression(argValues[0]) + ", " + this.emitExpression(argValues[1]) + ", " + loc(expression.span) + ")";
            }
            if (name === "print") {
                const parts = [];
                for (const argument of argValues) {
                    const type = this.infer(argument);
                    if (parts.length) parts.push("omni_print_space()");
                    if (type === "Text") parts.push("omni_print_text(" + this.emitExpression(argument) + ")");
                    else if (type === "Bool") parts.push("omni_print_bool(" + this.emitExpression(argument) + ")");
                    else this.unsupported("printing numeric or dynamic values on the embedded target; serial_write accepts text", argument.span);
                }
                parts.push("omni_print_end()");
                return "(" + parts.join(", ") + ")";
            }
        }
        if (!resolved || resolved.kind !== "function") this.unsupported("calls through variables or unresolved functions", expression.callee.span);
        if (args.length !== resolved.parameters.length) this.unsupported("function calls with an unexpected argument count", expression.span);
        if (args.some((argument) => argument.kind === "NamedArgument")) this.unsupported("named arguments outside record construction", expression.span);
        if (args.some(hasSideEffect)) this.unsupported("side-effecting function arguments; place each action on its own line", expression.span);
        for (let index = 0; index < args.length; index += 1) {
            const argument = args[index].kind === "NamedArgument" ? args[index].value : args[index];
            this.requireAssignable(this.infer(argument), resolved.parameters[index].type, argument.span);
        }
        const compiledArguments = args.map((argument, index) => {
            const parameter = resolved.parameters[index];
            return this.checkedAssignment(this.emitExpression(argument), parameter.type, argument.span, parameter.typeAnnotation);
        });
        return resolved.invokeName + "(" + compiledArguments.concat([(expression.span.line ?? 1) + "u", (expression.span.column ?? 1) + "u"]).join(", ") + ")";
    }

    infer(expression) {
        switch (expression.kind) {
            case "LiteralExpression":
                if (expression.literalType === "number") return Number.isSafeInteger(expression.value) ? "Int" : "Float";
                if (expression.literalType === "text") return "Text";
                if (expression.literalType === "bool") return "Bool";
                if (expression.literalType === "unit") return "Unit";
                break;
            case "IdentifierExpression": {
                const symbol = this.resolve(expression.name, expression.span);
                return symbol.kind === "function" ? "Function" : symbol.type;
            }
            case "UnaryExpression": return expression.operator === "!" ? "Bool" : this.infer(expression.operand);
            case "BinaryExpression": {
                if (["==", "!=", "<", "<=", ">", ">=", "and", "or"].includes(expression.operator)) return "Bool";
                const left = this.infer(expression.left);
                const right = this.infer(expression.right);
                if (expression.operator === "+" && left === "Text" && right === "Text") return "Text";
                if (expression.operator === "/") return "Float";
                if ([left, right].includes("Float")) return "Float";
                if ([left, right].includes("Number")) return "Number";
                return "Int";
            }
            case "AssignmentExpression":
                if (expression.target.kind !== "IdentifierExpression") this.unsupported("non-variable assignments", expression.target.span);
                return this.resolve(expression.target.name, expression.target.span).type;
            case "CallExpression": {
                if (expression.callee.kind !== "IdentifierExpression") return "Any";
                const name = expression.callee.name;
                const symbol = this.find(name);
                if (symbol?.kind === "function") return symbol.result;
                if (name === "print" || name === "serial_write" || name === "gpio_write") return "Unit";
                return "Any";
            }
            case "ListExpression":
            case "IndexExpression":
            case "MemberExpression": return "Any";
            default: return "Any";
        }
    }

    annotationType(annotation, span) {
        const name = annotation.path?.length === 1 ? annotation.path[0] : null;
        if (!name || !C_TYPES.has(name) || annotation.arguments?.length || annotation.optional) {
            this.unsupported("type annotation '" + (annotation.display ?? name ?? "unknown") + "' on the embedded target", span);
        }
        return name === "String" ? "Text" : name;
    }

    checkedAssignment(expression, type, span, annotation = null) {
        if (annotation && type === "Int") return "omni_check_int(" + expression + ", " + loc(span) + ")";
        if (annotation && ["Number", "Float"].includes(type)) return "omni_checked_number(" + expression + ", " + loc(span) + ")";
        return expression;
    }

    requireType(actual, expected, span) {
        if (actual !== expected) this.unsupported("a value of type " + actual + " where " + expected + " is required", span);
    }

    requireNumeric(type, span) {
        if (!["Int", "Float", "Number"].includes(type)) this.unsupported("non-numeric operations on " + type, span);
    }

    requireAssignable(actual, expected, span) {
        if (actual === expected || expected === "Number" && ["Int", "Float", "Number"].includes(actual) || expected === "Float" && ["Int", "Float", "Number"].includes(actual)) return;
        this.unsupported("a " + actual + " value where " + expected + " is required", span);
    }

    requireArity(name, args, count, span) {
        if (args.length !== count) this.unsupported(name + " calls with an unexpected argument count", span);
    }

    resolve(name, span) {
        for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
            const symbol = this.scopes[index].get(name);
            if (symbol) return symbol;
        }
        if (BUILTINS.has(name)) return { kind: "builtin", type: "Function" };
        this.unsupported("unknown C target name '" + name + "'", span);
    }

    find(name) {
        for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
            const symbol = this.scopes[index].get(name);
            if (symbol) return symbol;
        }
        return null;
    }

    unsupported(feature, span) {
        fail(
            "E3002",
            "embedded freestanding C output does not support " + feature + " yet; the interpreter remains available for host programs",
            span,
            this.context.sourceName,
            this.context.sourceText,
        );
    }

    hasValueReturn(block) {
        return hasValueReturn(block);
    }
}

function hasValueReturn(statement) {
    if (statement.kind === "ReturnStatement") return true;
    if (statement.kind === "FunctionDeclaration") return false;
    if (statement.kind === "BlockStatement") return statement.declarations.some(hasValueReturn);
    if (statement.kind === "IfStatement") return hasValueReturn(statement.thenBranch) || Boolean(statement.elseBranch && hasValueReturn(statement.elseBranch));
    if (statement.kind === "WhileStatement" || statement.kind === "ForStatement") return hasValueReturn(statement.body);
    return false;
}

function hasSideEffect(expression) {
    if (expression.kind === "CallExpression" || expression.kind === "AssignmentExpression") return true;
    switch (expression.kind) {
        case "BinaryExpression": return hasSideEffect(expression.left) || hasSideEffect(expression.right);
        case "UnaryExpression": return hasSideEffect(expression.operand);
        case "ListExpression": return expression.elements.some(hasSideEffect);
        case "IndexExpression": return hasSideEffect(expression.object) || hasSideEffect(expression.index);
        case "MemberExpression": return hasSideEffect(expression.object);
        default: return false;
    }
}

function cType(type) {
    if (["Int", "Number", "Float"].includes(type)) return "double";
    if (type === "Bool") return "bool";
    if (type === "Text") return "OmniText";
    return "OMNI_UNIT";
}

function cAbiType(type) {
    if (type === "Int") return "int32_t";
    if (type === "Float") return "double";
    if (type === "Bool") return "bool";
    if (type === "Unit") return "void";
    throw new TypeError("unsupported OMNI C ABI type " + type);
}

function cNumber(value) {
    const text = String(value);
    return /[.eE]/u.test(text) ? text : text + ".0";
}

function cString(value) {
    const bytes = Buffer.from(value, "utf8");
    return '"' + [...bytes].map((byte) => "\\" + byte.toString(8).padStart(3, "0")).join("") + '"';
}

function loc(span) {
    return (span.line ?? 1) + "u, " + (span.column ?? 1) + "u";
}

function indent(source) {
    if (!source) return "    ";
    return source.split("\n").map((line) => line ? "    " + line : line).join("\n");
}

function platformHeader() {
    return [
        "#ifndef OMNI_PLATFORM_H",
        "#define OMNI_PLATFORM_H",
        "#include <stdbool.h>",
        "#include <stddef.h>",
        "#include <stdint.h>",
        "typedef uint8_t OMNI_UNIT;",
        "typedef struct { const uint8_t *data; size_t length; } OmniText;",
        "void omni_serial_write(const uint8_t *data, size_t length);",
        "void omni_gpio_write(uint32_t pin, bool high);",
        "void omni_runtime_error(const char *source, const char *code, const char *message, uint32_t line, uint32_t column);",
        "OMNI_UNIT omni_main(void);",
        "#endif",
        "",
    ].join("\n");
}

function runtimeSource(sourceName) {
    const source = cString(sourceName);
    return [
        "static OmniText omni_text_from_bytes(const char *data, size_t length) {",
        "    OmniText text = { (const uint8_t *)data, length };",
        "    return text;",
        "}",
        "static uint16_t omni_call_depth;",
        "static void omni_enter_call(uint32_t line, uint32_t column) {",
        "    if (omni_call_depth >= 256u) omni_runtime_error(" + source + ", \"E1017\", \"function call depth exceeds the limit of 256\", line, column);",
        "    omni_call_depth += 1u;",
        "}",
        "static void omni_leave_call(void) {",
        "    omni_call_depth -= 1u;",
        "}",
        "static double omni_checked_number(double value, uint32_t line, uint32_t column) {",
        "    if (!(value == value && value <= DBL_MAX && value >= -DBL_MAX)) omni_runtime_error(" + source + ", \"E1024\", \"numeric operation produced a non-finite result\", line, column);",
        "    return value;",
        "}",
        "static double omni_check_int(double value, uint32_t line, uint32_t column) {",
        "    if (!(value == value && value <= DBL_MAX && value >= -DBL_MAX) || value < -9007199254740991.0 || value > 9007199254740991.0 || value != (double)(int64_t)value) {",
        "        omni_runtime_error(" + source + ", \"E1021\", \"value must be a safe whole number\", line, column);",
        "    }",
        "    return value;",
        "}",
        "static int32_t omni_ffi_int32(double value, uint32_t line, uint32_t column) {",
        "    if (!(value == value && value <= DBL_MAX && value >= -DBL_MAX) || value < -2147483648.0 || value > 2147483647.0 || value != (double)(int32_t)value) {",
        "        omni_runtime_error(" + source + ", \"E1021\", \"C ABI Int arguments must be whole numbers in the signed 32-bit range\", line, column);",
        "    }",
        "    return (int32_t)value;",
        "}",
        "static double omni_divide(double left, double right, uint32_t line, uint32_t column) {",
        "    if (right == 0.0) omni_runtime_error(" + source + ", \"E1024\", \"numeric operation produced a non-finite result\", line, column);",
        "    return omni_checked_number(left / right, line, column);",
        "}",
        "static bool omni_text_equal(OmniText left, OmniText right) {",
        "    if (left.length != right.length) return false;",
        "    for (size_t index = 0; index < left.length; index += 1u) if (left.data[index] != right.data[index]) return false;",
        "    return true;",
        "}",
        "static OMNI_UNIT omni_write(OmniText text) {",
        "    omni_serial_write(text.data, text.length);",
        "    return 0;",
        "}",
        "static OMNI_UNIT omni_set_gpio(double pin, bool high, uint32_t line, uint32_t column) {",
        "    double checked = omni_check_int(pin, line, column);",
        "    if (checked < 0.0 || checked > 4294967295.0) omni_runtime_error(" + source + ", \"E3004\", \"pin number is outside the embedded target range\", line, column);",
        "    omni_gpio_write((uint32_t)checked, high);",
        "    return 0;",
        "}",
        "static OMNI_UNIT omni_print_text(OmniText text) {",
        "    omni_serial_write(text.data, text.length);",
        "    return 0;",
        "}",
        "static OMNI_UNIT omni_print_bool(bool value) {",
        "    const uint8_t *text = (const uint8_t *)(value ? \"true\" : \"false\");",
        "    omni_serial_write(text, value ? 4u : 5u);",
        "    return 0;",
        "}",
        "static OMNI_UNIT omni_print_end(void) {",
        "    const uint8_t newline = (uint8_t)'\\n';",
        "    omni_serial_write(&newline, 1u);",
        "    return 0;",
        "}",
        "static OMNI_UNIT omni_print_space(void) {",
        "    const uint8_t space = (uint8_t)' ';",
        "    omni_serial_write(&space, 1u);",
        "    return 0;",
        "}",
        "",
    ].join("\n");
}

function simulatorSource() {
    return [
        '#include "omni_platform.h"',
        "#include <stdio.h>",
        "#include <stdlib.h>",
        "void omni_serial_write(const uint8_t *data, size_t length) {",
        "    if (length) (void)fwrite(data, 1u, length, stdout);",
        "}",
        "void omni_gpio_write(uint32_t pin, bool high) {",
        "    (void)printf(\"[sim] GPIO %u = %s\\n\", pin, high ? \"high\" : \"low\");",
        "}",
        "void omni_runtime_error(const char *source, const char *code, const char *message, uint32_t line, uint32_t column) {",
        "    (void)fprintf(stderr, \"%s:%u:%u: error[%s]: %s\\n\", source, line, column, code, message);",
        "    exit(1);",
        "}",
        "int main(void) {",
        "    (void)omni_main();",
        "    return 0;",
        "}",
        "",
    ].join("\n");
}
