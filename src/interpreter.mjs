import { fail } from "./diagnostics.mjs";
import {
    ESCAPED_CLOSE_BRACE,
    ESCAPED_LITERAL_MARKER,
    ESCAPED_MARKER,
    ESCAPED_OPEN_BRACE,
} from "./lexer.mjs";
import { unwrapSemanticProgram } from "./ir.mjs";

const KNOWN_TYPE_ANNOTATIONS = new Set(["Any", "Number", "Int", "Float", "Text", "String", "Bool", "List", "Option", "Result", "Unit"]);
const MAX_EXPRESSION_NESTING = 128;
const MAX_FUNCTION_CALL_DEPTH = 256;
const listElementContracts = new WeakMap();

class Environment {
    constructor(parent = null) {
        this.parent = parent;
        this.bindings = new Map();
    }

    define(name, value, mutable, typeAnnotation, span, context) {
        this.assertCanDefine(name, span, context);
        if (typeAnnotation) assertType(value, typeAnnotation, name, span, context, this);
        this.bindings.set(name, { value, mutable, typeAnnotation, span });
        return value;
    }

    assertCanDefine(name, span, context) {
        if (this.bindings.has(name)) {
            runtimeError(context, "E1002", "the name '" + name + "' is already declared in this scope", span);
        }
    }

    get(name, span, context) {
        const binding = this.find(name);
        if (!binding) runtimeError(context, "E1001", "unknown name '" + name + "'", span);
        return binding.value;
    }

    prepareAssignment(name, span, context) {
        const binding = this.find(name);
        if (!binding) runtimeError(context, "E1001", "unknown name '" + name + "'", span);
        if (!binding.mutable) {
            runtimeError(context, "E1003", "cannot assign to immutable binding '" + name + "'; declare it with var to allow changes", span);
        }
        return binding;
    }

    assignPrepared(name, binding, value, span, context) {
        if (binding.typeAnnotation) assertType(value, binding.typeAnnotation, name, span, context, this);
        binding.value = value;
        return value;
    }

    find(name) {
        if (this.bindings.has(name)) return this.bindings.get(name);
        return this.parent?.find(name) ?? null;
    }

    exportValues() {
        return new Map([...this.bindings].map(([name, binding]) => [name, binding.value]));
    }

    exportBindings() {
        return new Map([...this.bindings].map(([name, binding]) => [name, new ExportBinding(binding)]));
    }

    visibleValues() {
        const values = this.parent && !this.parent.isBuiltins ? this.parent.visibleValues() : new Map();
        for (const [name, binding] of this.bindings) values.set(name, binding.value);
        return values;
    }
}

class ReturnSignal {
    constructor(value, span) {
        this.value = value;
        this.span = span;
    }
}

class BreakSignal {}
class ContinueSignal {}

class OmniFunction {
    constructor(declaration, closure) {
        this.kind = "function";
        this.name = declaration.name;
        this.declaration = declaration;
        this.closure = closure;
    }
}

class NativeFunction {
    constructor(name, minimumArguments, maximumArguments, implementation) {
        this.kind = "native";
        this.name = name;
        this.minimumArguments = minimumArguments;
        this.maximumArguments = maximumArguments;
        this.implementation = implementation;
    }
}

class RecordTypeConstructor {
    constructor(declaration, environment) {
        this.name = declaration.name;
        this.declaration = declaration;
        this.environment = environment;
        this.fields = new Map(declaration.fields.map((field) => [field.name, field]));
    }
}

class EnumTypeConstructor {
    constructor(declaration, environment) {
        this.name = declaration.name;
        this.declaration = declaration;
        this.environment = environment;
        this.variants = new Map(declaration.variants.map((variant) => [variant.name, variant]));
        this.singletons = new Map();
    }
}

class EnumVariantConstructor {
    constructor(type, variant) {
        this.type = type;
        this.variant = variant;
        this.name = type.name + "." + variant.name;
        this.minimumArguments = variant.fields.length;
        this.maximumArguments = variant.fields.length;
    }
}

class RecordValue {
    constructor(type, fields) {
        this.type = type;
        this.fields = fields;
    }
}

class EnumValue {
    constructor(type, variant, fields = []) {
        this.type = type;
        this.variant = variant;
        this.fields = fields;
    }
}

export class OptionValue {
    constructor(value) {
        this.value = value;
    }
}

export class ResultValue {
    constructor(kind, value) {
        this.kind = kind;
        this.value = value;
    }
}

class ModuleValue {
    constructor(name, exports) {
        this.name = name;
        this.exports = exports;
    }
}

export class ExportBinding {
    constructor(binding) {
        this.binding = binding;
    }
}

export function createModuleValue(name, exports) {
    return new ModuleValue(name, exports);
}

export function createGlobalEnvironment(output = (text) => process.stdout.write(text)) {
    const builtins = new Environment();
    builtins.isBuiltins = true;
    const context = { sourceName: "<built-in>", sourceText: "" };

    builtins.define("print", new NativeFunction("print", 0, Infinity, (args) => {
        output(args.map((value) => stringify(value)).join(" ") + "\n");
        return null;
    }), false, null, null, context);

    builtins.define("serial_write", new NativeFunction("serial_write", 1, 1, (_args, call) => {
        runtimeError(call.context, "E3004", "serial_write requires the embedded target", call.span);
    }), false, null, null, context);
    builtins.define("gpio_write", new NativeFunction("gpio_write", 2, 2, (_args, call) => {
        runtimeError(call.context, "E3004", "gpio_write requires the embedded target", call.span);
    }), false, null, null, context);

    builtins.define("len", new NativeFunction("len", 1, 1, (args, call) => {
        if (typeof args[0] === "string") return Array.from(args[0]).length;
        if (Array.isArray(args[0])) return args[0].length;
        runtimeError(call.context, "E1010", "len expects text or a list", call.span);
    }), false, null, null, context);

    builtins.define("str", new NativeFunction("str", 1, 1, (args) => stringify(args[0])), false, null, null, context);

    builtins.define("type_of", new NativeFunction("type_of", 1, 1, (args) => typeOf(args[0])), false, null, null, context);

    builtins.define("range", new NativeFunction("range", 1, 3, (args, call) => {
        const start = args.length === 1 ? 0 : args[0];
        const stop = args.length === 1 ? args[0] : args[1];
        const step = args.length === 3 ? args[2] : 1;
        if (![start, stop, step].every(Number.isSafeInteger)) {
            runtimeError(call.context, "E1011", "range arguments must be safe whole numbers", call.span);
        }
        if (step === 0) runtimeError(call.context, "E1011", "range step cannot be zero", call.span);

        const result = [];
        const shouldContinue = step > 0 ? (value) => value < stop : (value) => value > stop;
        for (let value = start; shouldContinue(value); value += step) {
            if (result.length >= 1_000_000) {
                runtimeError(call.context, "E1011", "range is limited to one million values", call.span);
            }
            result.push(value);
        }
        return result;
    }), false, null, null, context);

    builtins.define("push", new NativeFunction("push", 2, 2, (args, call) => {
        if (!Array.isArray(args[0])) runtimeError(call.context, "E1012", "push expects a list as its first argument", call.span);
        const contract = listElementContracts.get(args[0]);
        if (contract) assertType(args[1], contract.annotation, "list element", call.span, call.context, contract.environment);
        args[0].push(args[1]);
        return args[0].length;
    }), false, null, null, context);

    builtins.define("pop", new NativeFunction("pop", 1, 1, (args, call) => {
        if (!Array.isArray(args[0])) runtimeError(call.context, "E1012", "pop expects a list", call.span);
        if (args[0].length === 0) runtimeError(call.context, "E1012", "cannot pop an empty list", call.span);
        return args[0].pop();
    }), false, null, null, context);

    builtins.define("some", new NativeFunction("some", 1, 1, (args) => new OptionValue(args[0])), false, null, null, context);
    builtins.define("ok", new NativeFunction("ok", 1, 1, (args) => new ResultValue("ok", args[0])), false, null, null, context);
    builtins.define("err", new NativeFunction("err", 1, 1, (args) => new ResultValue("err", args[0])), false, null, null, context);

    builtins.define("map", new NativeFunction("map", 2, 2, (args, call) => {
        if (!Array.isArray(args[0])) runtimeError(call.context, "E1012", "map expects a list as its first argument", call.span);
        return [...args[0]].map((value) => call.invoke(args[1], [value]));
    }), false, null, null, context);

    builtins.define("filter", new NativeFunction("filter", 2, 2, (args, call) => {
        if (!Array.isArray(args[0])) runtimeError(call.context, "E1012", "filter expects a list as its first argument", call.span);
        const result = [];
        for (const value of [...args[0]]) {
            const keep = call.invoke(args[1], [value]);
            requireBoolean(keep, call.span, call.context);
            if (keep) result.push(value);
        }
        return result;
    }), false, null, null, context);

    return new Environment(builtins);
}

export class Interpreter {
    constructor({ environment = null, output, onStatement = null } = {}) {
        this.environment = environment ?? createGlobalEnvironment(output);
        this.onStatement = onStatement;
        this.callDepth = 0;
        this.expressionDepth = 0;
    }

    run(input, context = null) {
        const semantic = unwrapSemanticProgram(input, context);
        let result = null;
        for (const declaration of semantic.program.declarations) {
            result = this.execute(declaration, this.environment, semantic.context);
        }
        return result;
    }

    exportValues() {
        return this.environment.exportValues();
    }

    exportBindings() {
        return this.environment.exportBindings();
    }

    execute(statement, environment, context) {
        if (this.onStatement && [
            "BindingDeclaration", "ExpressionStatement", "IfStatement", "WhileStatement",
            "ForStatement", "MatchStatement", "ReturnStatement", "BreakStatement", "ContinueStatement",
        ].includes(statement.kind)) {
            this.onStatement({
                statement,
                context,
                values: environment.visibleValues(),
            });
        }
        switch (statement.kind) {
            case "RecordDeclaration": {
                if (KNOWN_TYPE_ANNOTATIONS.has(statement.name)) runtimeError(context, "E2002", "type name '" + statement.name + "' is reserved", statement.span);
                environment.assertCanDefine(statement.name, statement.span, context);
                const names = new Set();
                for (const field of statement.fields) {
                    if (names.has(field.name)) runtimeError(context, "E1002", "record field '" + field.name + "' is declared more than once", field.span);
                    names.add(field.name);
                }
                const recordType = new RecordTypeConstructor(statement, environment);
                environment.define(statement.name, recordType, false, null, statement.span, context);
                for (const field of statement.fields) validateTypeAnnotation(field.typeAnnotation, field.span, context, environment);
                return null;
            }
            case "EnumDeclaration": {
                if (KNOWN_TYPE_ANNOTATIONS.has(statement.name)) runtimeError(context, "E2002", "type name '" + statement.name + "' is reserved", statement.span);
                environment.assertCanDefine(statement.name, statement.span, context);
                const names = new Set();
                for (const variant of statement.variants) {
                    if (names.has(variant.name)) runtimeError(context, "E1002", "enum variant '" + variant.name + "' is declared more than once", variant.span);
                    names.add(variant.name);
                }
                if (names.size === 0) runtimeError(context, "E1020", "an enum must declare at least one variant", statement.span);
                const enumType = new EnumTypeConstructor(statement, environment);
                environment.define(statement.name, enumType, false, null, statement.span, context);
                for (const variant of statement.variants) {
                    for (const type of variant.fields) validateTypeAnnotation(type, variant.span, context, environment);
                }
                return null;
            }
            case "ImportDeclaration": {
                const module = context.moduleImports?.get(statement.alias);
                if (!module) runtimeError(context, "E2050", "module '" + statement.path + "' was not loaded", statement.pathSpan);
                environment.define(statement.alias, module, false, null, statement.span, context);
                return null;
            }
            case "FunctionDeclaration": {
                environment.assertCanDefine(statement.name, statement.span, context);
                const parameterNames = new Set();
                for (const parameter of statement.parameters) {
                    if (parameterNames.has(parameter.name)) {
                        runtimeError(context, "E1002", "the parameter '" + parameter.name + "' is declared more than once", parameter.span);
                    }
                    parameterNames.add(parameter.name);
                    if (parameter.typeAnnotation) validateTypeAnnotation(parameter.typeAnnotation, parameter.span, context, environment);
                }
                if (statement.returnType) validateTypeAnnotation(statement.returnType, statement.span, context, environment);
                const value = new OmniFunction(statement, environment);
                environment.define(statement.name, value, false, null, statement.span, context);
                return null;
            }
            case "BindingDeclaration": {
                environment.assertCanDefine(statement.name, statement.span, context);
                if (statement.typeAnnotation) validateTypeAnnotation(statement.typeAnnotation, statement.span, context, environment);
                const value = this.evaluate(statement.initializer, environment, context);
                environment.define(statement.name, value, statement.mutable, statement.typeAnnotation, statement.span, context);
                return value;
            }
            case "BlockStatement": {
                const blockEnvironment = new Environment(environment);
                for (const declaration of statement.declarations) this.execute(declaration, blockEnvironment, context);
                return null;
            }
            case "ExpressionStatement":
                return this.evaluate(statement.expression, environment, context);
            case "IfStatement": {
                const condition = this.evaluate(statement.condition, environment, context);
                requireBoolean(condition, statement.condition.span, context);
                if (condition) this.execute(statement.thenBranch, environment, context);
                else if (statement.elseBranch) this.execute(statement.elseBranch, environment, context);
                return null;
            }
            case "WhileStatement":
                return this.executeWhile(statement, environment, context);
            case "ForStatement":
                return this.executeFor(statement, environment, context);
            case "MatchStatement":
                return this.executeMatch(statement, environment, context);
            case "ReturnStatement":
                throw new ReturnSignal(this.evaluate(statement.value, environment, context), statement.span);
            case "BreakStatement":
                throw new BreakSignal();
            case "ContinueStatement":
                throw new ContinueSignal();
            default:
                runtimeError(context, "E1099", "unsupported statement in this interpreter edition", statement.span);
        }
    }

    executeWhile(statement, environment, context) {
        while (true) {
            const condition = this.evaluate(statement.condition, environment, context);
            requireBoolean(condition, statement.condition.span, context);
            if (!condition) return null;
            try {
                this.execute(statement.body, environment, context);
            } catch (signal) {
                if (signal instanceof BreakSignal) return null;
                if (!(signal instanceof ContinueSignal)) throw signal;
            }
        }
    }

    executeFor(statement, environment, context) {
        const iterable = this.evaluate(statement.iterable, environment, context);
        const values = Array.isArray(iterable) ? [...iterable] : typeof iterable === "string" ? Array.from(iterable) : null;
        if (!values) {
            runtimeError(context, "E1013", "for loops can iterate over a list or text", statement.iterable.span);
        }

        for (const value of values) {
            const iterationEnvironment = new Environment(environment);
            iterationEnvironment.define(statement.name, value, false, null, statement.span, context);
            try {
                this.execute(statement.body, iterationEnvironment, context);
            } catch (signal) {
                if (signal instanceof BreakSignal) return null;
                if (!(signal instanceof ContinueSignal)) throw signal;
            }
        }
        return null;
    }

    executeMatch(statement, environment, context) {
        const value = this.evaluate(statement.value, environment, context);
        for (const matchCase of statement.cases) {
            const bindings = new Map();
            if (!this.matchPattern(matchCase.pattern, value, bindings, environment, context)) continue;
            const caseEnvironment = new Environment(environment);
            for (const [name, boundValue] of bindings) {
                caseEnvironment.define(name, boundValue, false, null, matchCase.pattern.span, context);
            }
            this.execute(matchCase.body, caseEnvironment, context);
            return null;
        }
        return null;
    }

    matchPattern(pattern, value, bindings, environment, context) {
        switch (pattern.kind) {
            case "WildcardPattern": return true;
            case "BindingPattern":
                bindings.set(pattern.name, value);
                return true;
            case "NumberPattern": return typeof value === "number" && value === pattern.value;
            case "TextPattern": return typeof value === "string" && value === literalPatternText(pattern.value);
            case "BoolPattern": return typeof value === "boolean" && value === pattern.value;
            case "NonePattern": return value === null;
            case "EnumVariantPattern": {
                const variant = resolvePatternVariant(pattern.path, environment, pattern.span, context);
                return variant instanceof EnumValue && value instanceof EnumValue &&
                    value.type === variant.type && value.variant.name === variant.variant.name;
            }
            case "ConstructorPattern": {
                const name = pattern.path.at(-1);
                let payload = [];
                let matches = false;
                if (pattern.path.length === 1 && name === "some") {
                    matches = value instanceof OptionValue;
                    if (matches) payload = [value.value];
                } else if (pattern.path.length === 1 && (name === "ok" || name === "err")) {
                    matches = value instanceof ResultValue && value.kind === name;
                    if (matches) payload = [value.value];
                } else {
                    const variant = resolvePatternVariant(pattern.path, environment, pattern.span, context);
                    const variantType = variant instanceof EnumVariantConstructor ? variant.type : variant?.type;
                    const variantName = variant instanceof EnumVariantConstructor ? variant.variant.name : variant?.variant?.name;
                    matches = variantType instanceof EnumTypeConstructor && value instanceof EnumValue &&
                        value.type === variantType && value.variant.name === variantName;
                    if (matches) payload = value.fields;
                }
                if (!matches || pattern.fields.length !== payload.length) return false;
                for (let index = 0; index < pattern.fields.length; index += 1) {
                    if (!this.matchPattern(pattern.fields[index], payload[index], bindings, environment, context)) return false;
                }
                return true;
            }
            default: return false;
        }
    }

    evaluate(expression, environment, context) {
        this.expressionDepth += 1;
        try {
            if (this.expressionDepth > MAX_EXPRESSION_NESTING) {
                runtimeError(context, "E1026", "expression nesting exceeds the limit of " + MAX_EXPRESSION_NESTING, expression.span);
            }
            return this.evaluateExpression(expression, environment, context);
        } finally {
            this.expressionDepth -= 1;
        }
    }

    evaluateExpression(expression, environment, context) {
        switch (expression.kind) {
            case "LiteralExpression":
                return expression.literalType === "text"
                    ? interpolate(expression.value, environment, expression.span, context)
                    : expression.value;
            case "IdentifierExpression":
                return environment.get(expression.name, expression.span, context);
            case "ListExpression":
                return expression.elements.map((element) => this.evaluate(element, environment, context));
            case "UnaryExpression":
                return this.evaluateUnary(expression, environment, context);
            case "BinaryExpression":
                return this.evaluateBinary(expression, environment, context);
            case "AssignmentExpression":
                return this.evaluateAssignment(expression, environment, context);
            case "CallExpression":
                return this.evaluateCall(expression, environment, context);
            case "IndexExpression":
                return this.evaluateIndex(expression, environment, context);
            case "MemberExpression": {
                const object = this.evaluate(expression.object, environment, context);
                return getMemberValue(object, expression.name, expression.span, context);
            }
            default:
                runtimeError(context, "E1099", "unsupported expression in this interpreter edition", expression.span);
        }
    }

    evaluateUnary(expression, environment, context) {
        const value = this.evaluate(expression.operand, environment, context);
        if (expression.operator === "!") {
            requireBoolean(value, expression.operand.span, context);
            return !value;
        }
        if (expression.operator === "-") {
            requireNumber(value, expression.operand.span, context);
            return checkedNumber(-value, expression.span, context);
        }
        runtimeError(context, "E1099", "unsupported unary operator", expression.span);
    }

    evaluateBinary(expression, environment, context) {
        const left = this.evaluate(expression.left, environment, context);
        const operator = expression.operator;

        if (operator === "and") {
            requireBoolean(left, expression.left.span, context);
            if (!left) return false;
            const right = this.evaluate(expression.right, environment, context);
            requireBoolean(right, expression.right.span, context);
            return right;
        }
        if (operator === "or") {
            requireBoolean(left, expression.left.span, context);
            if (left) return true;
            const right = this.evaluate(expression.right, environment, context);
            requireBoolean(right, expression.right.span, context);
            return right;
        }

        const right = this.evaluate(expression.right, environment, context);
        if (operator === "==" || operator === "!=") {
            const equal = left === right;
            return operator === "==" ? equal : !equal;
        }

        if (["<", "<=", ">", ">="].includes(operator)) {
            if (typeof left !== typeof right || !["number", "string"].includes(typeof left)) {
                runtimeError(context, "E1014", "comparison needs two numbers or two text values", expression.span);
            }
            if (operator === "<") return left < right;
            if (operator === "<=") return left <= right;
            if (operator === ">") return left > right;
            return left >= right;
        }

        if (operator === "+" && typeof left === "string" && typeof right === "string") return left + right;
        requireNumber(left, expression.left.span, context);
        requireNumber(right, expression.right.span, context);
        if (operator === "+") return checkedNumber(left + right, expression.span, context);
        if (operator === "-") return checkedNumber(left - right, expression.span, context);
        if (operator === "*") return checkedNumber(left * right, expression.span, context);
        if (operator === "/") return checkedNumber(left / right, expression.span, context);
        if (operator === "%") return checkedNumber(left % right, expression.span, context);
        runtimeError(context, "E1099", "unsupported binary operator", expression.span);
    }

    evaluateAssignment(expression, environment, context) {
        if (expression.target.kind === "IdentifierExpression") {
            const name = expression.target.name;
            const binding = environment.prepareAssignment(name, expression.target.span, context);
            const value = this.evaluate(expression.value, environment, context);
            return environment.assignPrepared(name, binding, value, expression.target.span, context);
        }

        if (expression.target.kind === "MemberExpression") {
            const object = this.evaluate(expression.target.object, environment, context);
            if (!(object instanceof RecordValue) || !object.fields.has(expression.target.name)) {
                runtimeError(context, "E2006", "only a declared record field can be updated", expression.target.span);
            }
            const field = object.type.fields.get(expression.target.name);
            const value = this.evaluate(expression.value, environment, context);
            assertType(value, field.typeAnnotation, expression.target.name, expression.target.span, context, object.type.environment);
            object.fields.set(expression.target.name, value);
            return value;
        }

        const object = this.evaluate(expression.target.object, environment, context);
        const index = this.evaluate(expression.target.index, environment, context);
        const key = validateIndex(object, index, expression.target.span, context, true);
        const value = this.evaluate(expression.value, environment, context);
        validateIndex(object, index, expression.target.span, context, true);
        const contract = listElementContracts.get(object);
        if (contract) assertType(value, contract.annotation, "list element", expression.target.span, context, contract.environment);
        object[key] = value;
        return value;
    }

    evaluateIndex(expression, environment, context) {
        const object = this.evaluate(expression.object, environment, context);
        const index = this.evaluate(expression.index, environment, context);
        const key = validateIndex(object, index, expression.span, context, false);
        return typeof object === "string" ? Array.from(object)[key] : object[key];
    }

    evaluateCall(expression, environment, context) {
        const callee = this.evaluate(expression.callee, environment, context);
        const args = expression.arguments.map((argument) => argument.kind === "NamedArgument"
            ? { name: argument.name, value: this.evaluate(argument.value, environment, context), span: argument.span }
            : { name: null, value: this.evaluate(argument, environment, context), span: argument.span });
        return this.invokeCallable(callee, args, context, expression.span, expression.callee.span, environment);
    }

    invokeCallable(callee, argumentEntries, context, span, calleeSpan, environment = null) {
        const args = argumentEntries.map((argument) => argument.value);
        const hasNamed = argumentEntries.some((argument) => argument.name !== null);

        if (callee instanceof RecordTypeConstructor) {
            if (argumentEntries.some((argument) => argument.name === null)) {
                runtimeError(context, "E2006", "record fields must be supplied by name", span);
            }
            const fields = new Map();
            for (const argument of argumentEntries) {
                if (fields.has(argument.name)) runtimeError(context, "E2006", "record field '" + argument.name + "' is supplied more than once", argument.span);
                const field = callee.fields.get(argument.name);
                if (!field) runtimeError(context, "E2006", "record '" + callee.name + "' has no field '" + argument.name + "'", argument.span);
                assertType(argument.value, field.typeAnnotation, argument.name, argument.span, context, callee.environment);
                fields.set(argument.name, argument.value);
            }
            for (const name of callee.fields.keys()) {
                if (!fields.has(name)) runtimeError(context, "E2006", "record '" + callee.name + "' needs a value for field '" + name + "'", span);
            }
            return new RecordValue(callee, new Map([...callee.fields.keys()].map((name) => [name, fields.get(name)])));
        }

        if (callee instanceof EnumVariantConstructor) {
            if (hasNamed) runtimeError(context, "E2004", "enum variant payloads use positional values", span);
            if (args.length !== callee.variant.fields.length) {
                runtimeError(context, "E1016", "'" + callee.name + "' expects " + callee.variant.fields.length + " value(s)", span);
            }
            for (let index = 0; index < args.length; index += 1) {
                assertType(args[index], callee.variant.fields[index], callee.variant.name, argumentEntries[index].span, context, callee.type.environment);
            }
            return new EnumValue(callee.type, callee.variant, args);
        }

        if (!(callee instanceof OmniFunction) && !(callee instanceof NativeFunction)) {
            runtimeError(context, "E1015", "this value cannot be called", calleeSpan);
        }
        if (hasNamed) runtimeError(context, "E1016", "named arguments are only used to construct records", span);

        if (callee instanceof NativeFunction) {
            if (args.length < callee.minimumArguments || args.length > callee.maximumArguments) {
                runtimeError(
                    context,
                    "E1016",
                    "'" + callee.name + "' received " + args.length + " argument(s), but expects " + arityDescription(callee),
                    span,
                );
            }
            return callee.implementation(args, {
                context,
                span,
                environment,
                invoke: (callback, values) => this.invokeCallable(
                    callback,
                    values.map((value) => ({ name: null, value, span })),
                    context,
                    span,
                    span,
                    environment,
                ),
            });
        }

        const declaration = callee.declaration;
        if (args.length !== declaration.parameters.length) {
            runtimeError(
                context,
                "E1016",
                "'" + callee.name + "' received " + args.length + " argument(s), but expects " + declaration.parameters.length,
                span,
            );
        }
        if (this.callDepth >= MAX_FUNCTION_CALL_DEPTH) {
            runtimeError(context, "E1017", "function call depth exceeds the limit of " + MAX_FUNCTION_CALL_DEPTH, span);
        }

        const callEnvironment = new Environment(callee.closure);
        for (let index = 0; index < args.length; index += 1) {
            const parameter = declaration.parameters[index];
            callEnvironment.define(parameter.name, args[index], false, parameter.typeAnnotation, parameter.span, context);
        }

        const outerExpressionDepth = this.expressionDepth;
        this.expressionDepth = 0;
        this.callDepth += 1;
        let result = null;
        try {
            try {
                this.execute(declaration.body, callEnvironment, context);
            } catch (signal) {
                if (signal instanceof ReturnSignal) result = signal.value;
                else throw signal;
            }
        } finally {
            this.callDepth -= 1;
            this.expressionDepth = outerExpressionDepth;
        }
        if (declaration.returnType) assertType(result, declaration.returnType, "return value", declaration.body.span, context, callEnvironment);
        return result;
    }
}

export function stringify(value, activeLists = new Set()) {
    const output = [];
    const pending = [{ kind: "value", value }];

    while (pending.length > 0) {
        const item = pending.pop();
        if (item.kind === "text") {
            output.push(item.value);
            continue;
        }
        if (item.kind === "leave-list") {
            activeLists.delete(item.value);
            continue;
        }

        const current = item.value;
        if (current === null) output.push("none");
        else if (typeof current === "boolean") output.push(current ? "true" : "false");
        else if (typeof current === "number") output.push(Object.is(current, -0) ? "0" : String(current));
        else if (typeof current === "string") output.push(current);
        else if (Array.isArray(current)) {
            if (activeLists.has(current)) {
                output.push("[...]");
                continue;
            }
            activeLists.add(current);
            output.push("[");
            pending.push({ kind: "leave-list", value: current });
            pending.push({ kind: "text", value: "]" });
            for (let index = current.length - 1; index >= 0; index -= 1) {
                pending.push({ kind: "value", value: current[index] });
                if (index > 0) pending.push({ kind: "text", value: ", " });
            }
        } else if (current instanceof RecordValue) {
            if (activeLists.has(current)) {
                output.push("<cycle>");
                continue;
            }
            activeLists.add(current);
            output.push(current.type.name + "(");
            pending.push({ kind: "leave-list", value: current });
            pending.push({ kind: "text", value: ")" });
            const fields = [...current.fields];
            for (let index = fields.length - 1; index >= 0; index -= 1) {
                const [name, fieldValue] = fields[index];
                pending.push({ kind: "value", value: fieldValue });
                pending.push({ kind: "text", value: name + ": " });
                if (index > 0) pending.push({ kind: "text", value: ", " });
            }
        } else if (current instanceof EnumValue) {
            if (activeLists.has(current)) {
                output.push("<cycle>");
                continue;
            }
            const prefix = current.type.name + "." + current.variant.name;
            if (current.fields.length === 0) {
                output.push(prefix);
                continue;
            }
            activeLists.add(current);
            output.push(prefix + "(");
            pending.push({ kind: "leave-list", value: current });
            pending.push({ kind: "text", value: ")" });
            for (let index = current.fields.length - 1; index >= 0; index -= 1) {
                pending.push({ kind: "value", value: current.fields[index] });
                if (index > 0) pending.push({ kind: "text", value: ", " });
            }
        } else if (current instanceof OptionValue || current instanceof ResultValue) {
            if (activeLists.has(current)) {
                output.push("<cycle>");
                continue;
            }
            activeLists.add(current);
            const constructor = current instanceof OptionValue ? "some" : current.kind;
            output.push(constructor + "(");
            pending.push({ kind: "leave-list", value: current });
            pending.push({ kind: "text", value: ")" });
            pending.push({ kind: "value", value: current.value });
        } else if (current instanceof ModuleValue) {
            output.push("<module " + current.name + ">");
        } else if (current instanceof RecordTypeConstructor) {
            output.push("<record " + current.name + ">");
        } else if (current instanceof EnumTypeConstructor) {
            output.push("<enum " + current.name + ">");
        } else if (current instanceof EnumVariantConstructor) {
            output.push("<enum variant " + current.name + ">");
        } else if (current instanceof OmniFunction || current instanceof NativeFunction) {
            output.push("<fn " + current.name + ">");
        } else if (current?.kind === "function" || current?.kind === "native") {
            output.push("<fn " + current.name + ">");
        } else output.push("<value>");
    }

    return output.join("");
}

function typeOf(value) {
    if (value === null) return "Unit";
    if (typeof value === "boolean") return "Bool";
    if (typeof value === "number") return Number.isSafeInteger(value) ? "Int" : "Float";
    if (typeof value === "string") return "Text";
    if (Array.isArray(value)) return "List";
    if (value instanceof OptionValue) return "Option";
    if (value instanceof ResultValue) return "Result";
    if (value instanceof RecordValue) return value.type.name;
    if (value instanceof EnumValue) return value.type.name;
    if (value instanceof ModuleValue) return "Module";
    if (value instanceof OmniFunction || value instanceof NativeFunction) return "Function";
    return "Unknown";
}

function getMemberValue(object, name, span, context) {
    if (object instanceof RecordValue) {
        if (!object.fields.has(name)) runtimeError(context, "E2005", "record '" + object.type.name + "' has no field '" + name + "'", span);
        return object.fields.get(name);
    }
    if (object instanceof ModuleValue) {
        if (!object.exports.has(name)) runtimeError(context, "E2005", "module '" + object.name + "' has no exported name '" + name + "'", span);
        const exported = object.exports.get(name);
        return exported instanceof ExportBinding ? exported.binding.value : exported;
    }
    if (object instanceof EnumTypeConstructor) {
        const variant = object.variants.get(name);
        if (!variant) runtimeError(context, "E2005", "enum '" + object.name + "' has no variant '" + name + "'", span);
        if (variant.fields.length === 0) {
            if (!object.singletons.has(name)) object.singletons.set(name, new EnumValue(object, variant));
            return object.singletons.get(name);
        }
        return new EnumVariantConstructor(object, variant);
    }
    runtimeError(context, "E2005", "this value has no member '" + name + "'", span);
}

function resolvePatternVariant(path, environment, span, context) {
    let value = environment.get(path[0], span, context);
    for (const name of path.slice(1)) value = getMemberValue(value, name, span, context);
    return value;
}

function literalPatternText(template) {
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

function interpolate(template, environment, span, context) {
    return interpolateText(template, (name) => environment.get(name, span, context), span, context);
}

export function interpolateText(template, getValue, span, context) {
    let result = "";
    for (let index = 0; index < template.length;) {
        const character = template[index];
        if (template.startsWith(ESCAPED_LITERAL_MARKER, index)) {
            result += ESCAPED_MARKER;
            index += ESCAPED_LITERAL_MARKER.length;
            continue;
        }
        if (template.startsWith(ESCAPED_OPEN_BRACE, index)) {
            result += "{";
            index += ESCAPED_OPEN_BRACE.length;
            continue;
        }
        if (template.startsWith(ESCAPED_CLOSE_BRACE, index)) {
            result += "}";
            index += ESCAPED_CLOSE_BRACE.length;
            continue;
        }
        if (character === "{" && template[index + 1] === "{") {
            result += "{";
            index += 2;
            continue;
        }
        if (character === "}" && template[index + 1] === "}") {
            result += "}";
            index += 2;
            continue;
        }
        if (character === "{") {
            const close = template.indexOf("}", index + 1);
            if (close >= 0) {
                const name = template.slice(index + 1, close);
                if (!/^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(name)) {
                    runtimeError(context, "E1018", "string interpolation currently accepts a variable name such as {name}", span);
                }
                result += stringify(getValue(name));
                index = close + 1;
                continue;
            }
        }
        result += character;
        index += 1;
    }
    return result;
}

function assertType(value, annotation, bindingName, span, context, environment = null) {
    const info = validateTypeAnnotation(annotation, span, context, environment);
    if (!matchesAnnotation(value, info, environment, new Set())) {
        runtimeError(context, "E1021", "'" + bindingName + "' must have type " + info.display + ", received " + typeOf(value), span);
    }
    registerRuntimeContracts(value, info, environment, context, span);
}

function registerRuntimeContracts(value, info, environment, context, span, seen = new Set()) {
    if (info.optional) {
        if (value instanceof OptionValue) registerRuntimeContracts(value.value, { ...info, optional: false }, environment, context, span, seen);
        return;
    }
    const argumentsList = info.arguments ?? [];
    if (info.name === "List" && Array.isArray(value) && argumentsList[0] && !isAnyTypeReference(argumentsList[0])) {
        if (seen.has(value)) return;
        seen.add(value);
        listElementContracts.set(value, { annotation: argumentsList[0], environment });
        const elementType = validateTypeAnnotation(argumentsList[0], span, context, environment);
        for (const item of value) registerRuntimeContracts(item, elementType, environment, context, span, seen);
    } else if (info.name === "Option" && value instanceof OptionValue && argumentsList[0]) {
        const payloadType = validateTypeAnnotation(argumentsList[0], span, context, environment);
        registerRuntimeContracts(value.value, payloadType, environment, context, span, seen);
    } else if (info.name === "Result" && value instanceof ResultValue) {
        const argument = value.kind === "ok" ? argumentsList[0] : argumentsList[1];
        if (argument) {
            const payloadType = validateTypeAnnotation(argument, span, context, environment);
            registerRuntimeContracts(value.value, payloadType, environment, context, span, seen);
        }
    }
}

function isAnyTypeReference(reference) {
    return !reference.optional && reference.path.length === 1 && reference.path[0] === "Any" && (reference.arguments?.length ?? 0) === 0;
}

function validateTypeAnnotation(annotation, span, context, environment = null) {
    const info = typeof annotation === "string"
        ? { path: [annotation.endsWith("?") ? annotation.slice(0, -1) : annotation], arguments: [], optional: annotation.endsWith("?"), display: annotation }
        : annotation;
    const name = info.path.at(-1);
    const argumentsList = info.arguments ?? [];

    if (info.path.length === 1 && KNOWN_TYPE_ANNOTATIONS.has(name)) {
        const expectedArguments = name === "List" ? [0, 1] : name === "Option" ? [1, 1] : name === "Result" ? [2, 2] : [0, 0];
        if (argumentsList.length < expectedArguments[0] || argumentsList.length > expectedArguments[1]) {
            runtimeError(context, "E1020", "type annotation '" + info.display + "' has the wrong number of type arguments", span);
        }
        for (const argument of argumentsList) validateTypeAnnotation(argument, span, context, environment);
        return { ...info, name, arguments: argumentsList, runtimeType: null };
    }

    const runtimeType = resolveRuntimeType(info.path, environment);
    if (!(runtimeType instanceof RecordTypeConstructor) && !(runtimeType instanceof EnumTypeConstructor)) {
        runtimeError(context, "E1020", "type annotation '" + info.display + "' is not available in this edition", span);
    }
    if (argumentsList.length > 0) runtimeError(context, "E1020", "user-defined type '" + info.display + "' does not take type arguments", span);
    return { ...info, name, arguments: argumentsList, runtimeType };
}

function resolveRuntimeType(path, environment) {
    if (!environment || path.length === 0) return null;
    let binding = environment.find(path[0]);
    let value = binding?.value;
    if (!value) return null;
    for (const name of path.slice(1)) {
        if (value instanceof ModuleValue) {
            value = value.exports.get(name);
            if (value instanceof ExportBinding) value = value.binding.value;
        }
        else return null;
        if (!value) return null;
    }
    return value;
}

function matchesAnnotation(value, info, environment, active) {
    if (info.optional) {
        if (value === null) return true;
        if (!(value instanceof OptionValue)) return false;
        return matchesAnnotation(value.value, { ...info, optional: false }, environment, active);
    }

    const name = info.path.at(-1);
    const args = info.arguments ?? [];
    if (name === "Any") return true;
    if (name === "Number" || name === "Float") return typeof value === "number" && Number.isFinite(value);
    if (name === "Int") return typeof value === "number" && Number.isSafeInteger(value);
    if (name === "Text" || name === "String") return typeof value === "string";
    if (name === "Bool") return typeof value === "boolean";
    if (name === "Unit") return value === null;
    if (name === "List") {
        if (!Array.isArray(value)) return false;
        if (!args[0] || args[0].path?.at(-1) === "Any") return true;
        if (active.has(value)) return true;
        active.add(value);
        const matches = value.every((item) => matchesAnnotation(item, args[0], environment, active));
        active.delete(value);
        return matches;
    }
    if (name === "Option") {
        if (value === null) return true;
        if (!(value instanceof OptionValue)) return false;
        return !args[0] || matchesAnnotation(value.value, args[0], environment, active);
    }
    if (name === "Result") {
        if (!(value instanceof ResultValue)) return false;
        const argument = value.kind === "ok" ? args[0] : args[1];
        return !argument || matchesAnnotation(value.value, argument, environment, active);
    }
    const runtimeType = info.runtimeType ?? resolveRuntimeType(info.path, environment);
    if (runtimeType instanceof RecordTypeConstructor) return value instanceof RecordValue && value.type === runtimeType;
    if (runtimeType instanceof EnumTypeConstructor) return value instanceof EnumValue && value.type === runtimeType;
    return false;
}

function requireBoolean(value, span, context) {
    if (typeof value !== "boolean") {
        runtimeError(context, "E1022", "condition must be Bool; OMNI does not convert values by truthiness", span);
    }
}

function requireNumber(value, span, context) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        runtimeError(context, "E1023", "arithmetic requires a finite number", span);
    }
}

function checkedNumber(value, span, context) {
    if (!Number.isFinite(value)) runtimeError(context, "E1024", "numeric operation produced a non-finite result", span);
    return value;
}

function validateIndex(object, index, span, context, forAssignment) {
    if (!Array.isArray(object) && typeof object !== "string") {
        runtimeError(context, "E1025", "only lists and text can be indexed", span);
    }
    const length = typeof object === "string" ? Array.from(object).length : object.length;
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
        runtimeError(context, "E1025", "index must be a whole number inside the value's bounds", span);
    }
    if (forAssignment && typeof object === "string") {
        runtimeError(context, "E1025", "text is immutable and cannot be indexed for assignment", span);
    }
    return index;
}

function arityDescription(fn) {
    if (fn.minimumArguments === fn.maximumArguments) return String(fn.minimumArguments);
    if (fn.maximumArguments === Infinity) return "at least " + fn.minimumArguments;
    return fn.minimumArguments + " to " + fn.maximumArguments;
}

function runtimeError(context, code, message, span) {
    fail(code, message, span, context.sourceName, context.sourceText);
}

export function runProgram(program, context, options = {}) {
    const interpreter = new Interpreter(options);
    interpreter.run(program, context);
    return interpreter.environment;
}
