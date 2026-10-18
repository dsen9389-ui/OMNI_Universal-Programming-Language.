import { fail } from "./diagnostics.mjs";
import { hasUnsupportedInterpolation, interpolationNames } from "./lexer.mjs";

const anyType = { kind: "Any" };
const unitType = { kind: "Unit" };
const boolType = { kind: "Bool" };
const textType = { kind: "Text" };
const numberType = { kind: "Number" };
const intType = { kind: "Int" };
const floatType = { kind: "Float" };
const reservedTypeNames = new Set(["Any", "Number", "Int", "Float", "Text", "String", "Bool", "List", "Option", "Result", "Unit"]);
const cKeywords = new Set([
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum",
    "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return",
    "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void",
    "volatile", "while", "_Alignas", "_Alignof", "_Atomic", "_Bool", "_Complex", "_Generic", "_Imaginary",
    "_Noreturn", "_Static_assert", "_Thread_local", "main",
]);

class TypeChecker {
    constructor(context, options = {}) {
        this.context = context;
        this.imports = options.imports ?? new Map();
        this.scopes = [{ values: new Map(), types: new Map() }];
        this.moduleScope = { values: new Map(), types: new Map() };
        this.scopes.push(this.moduleScope);
        this.currentFunction = null;
        this.installBuiltins();
    }

    installBuiltins() {
        const builtins = this.scopes[0].values;
        for (const name of ["print", "len", "str", "type_of", "range", "push", "pop", "some", "ok", "err", "map", "filter", "serial_write", "gpio_write"]) {
            builtins.set(name, { kind: "builtin", name, mutable: false });
        }
    }

    check(program) {
        for (const declaration of program.declarations) this.checkDeclaration(declaration, true);
        return {
            values: new Map([...this.moduleScope.values].map(([name, binding]) => [name, binding.kind === "value" ? binding.type : binding])),
            types: new Map(this.moduleScope.types),
        };
    }

    checkDeclaration(declaration, topLevel = false) {
        switch (declaration.kind) {
            case "RecordDeclaration":
                return this.checkRecordDeclaration(declaration, topLevel);
            case "EnumDeclaration":
                return this.checkEnumDeclaration(declaration, topLevel);
            case "ImportDeclaration":
                return this.checkImport(declaration, topLevel);
            case "FunctionDeclaration":
                return this.checkFunction(declaration);
            case "ExternalFunctionDeclaration":
                return this.checkExternalFunction(declaration, topLevel);
            case "BindingDeclaration":
                return this.checkBinding(declaration);
            default:
                return this.checkStatement(declaration);
        }
    }

    checkRecordDeclaration(declaration, topLevel) {
        if (!topLevel) this.error("E2002", "record declarations are only allowed at the top level", declaration.span);
        if (reservedTypeNames.has(declaration.name)) this.error("E2002", "type name '" + declaration.name + "' is reserved", declaration.span);
        this.assertNameAvailable(declaration.name, declaration.span);
        const record = { kind: "record", name: declaration.name, fields: new Map() };
        this.currentScope().types.set(declaration.name, record);
        this.currentScope().values.set(declaration.name, { kind: "record-constructor", record, mutable: false });
        for (const field of declaration.fields) {
            if (record.fields.has(field.name)) this.error("E2002", "record field '" + field.name + "' is declared more than once", field.span);
            record.fields.set(field.name, this.resolveType(field.typeAnnotation));
        }
    }

    checkEnumDeclaration(declaration, topLevel) {
        if (!topLevel) this.error("E2002", "enum declarations are only allowed at the top level", declaration.span);
        if (reservedTypeNames.has(declaration.name)) this.error("E2002", "type name '" + declaration.name + "' is reserved", declaration.span);
        this.assertNameAvailable(declaration.name, declaration.span);
        const enumeration = { kind: "enum", name: declaration.name, variants: new Map() };
        this.currentScope().types.set(declaration.name, enumeration);
        this.currentScope().values.set(declaration.name, { kind: "enum-constructor", enumeration, mutable: false });
        for (const variant of declaration.variants) {
            if (enumeration.variants.has(variant.name)) this.error("E2002", "enum variant '" + variant.name + "' is declared more than once", variant.span);
            enumeration.variants.set(variant.name, variant.fields.map((type) => this.resolveType(type)));
        }
        if (enumeration.variants.size === 0) this.error("E2002", "an enum must declare at least one variant", declaration.span);
    }

    checkImport(declaration, topLevel) {
        if (!topLevel) this.error("E2002", "imports are only allowed at the top level", declaration.span);
        const module = this.imports.get(declaration.path);
        if (!module) this.error("E2050", "module '" + declaration.path + "' was not loaded", declaration.pathSpan);
        this.defineValue(declaration.alias, { kind: "module", module, mutable: false }, declaration.span);
    }

    checkFunction(declaration) {
        this.assertNameAvailable(declaration.name, declaration.span);
        const parameters = declaration.parameters.map((parameter) => parameter.typeAnnotation
            ? this.resolveType(parameter.typeAnnotation)
            : anyType);
        const declaredReturnType = declaration.returnType ? this.resolveType(declaration.returnType) : null;
        const functionType = { kind: "function", parameters, result: declaredReturnType ?? anyType };
        const binding = { kind: "value", type: functionType, mutable: false, span: declaration.span };
        this.currentScope().values.set(declaration.name, binding);

        const previousFunction = this.currentFunction;
        this.currentFunction = { expected: declaredReturnType, returns: [] };
        this.pushScope();
        const parameterNames = new Set();
        for (let index = 0; index < declaration.parameters.length; index += 1) {
            const parameter = declaration.parameters[index];
            if (parameterNames.has(parameter.name)) this.error("E2002", "parameter '" + parameter.name + "' is declared more than once", parameter.span);
            parameterNames.add(parameter.name);
            this.defineValue(parameter.name, { kind: "value", type: parameters[index], mutable: false, span: parameter.span }, parameter.span);
        }
        this.checkBlock(declaration.body);
        const returns = this.currentFunction.returns;
        const definitelyReturns = blockDefinitelyReturns(declaration.body);
        this.popScope();
        this.currentFunction = previousFunction;

        if (declaredReturnType) {
            if (!definitelyReturns && !isAssignable(unitType, declaredReturnType)) {
                this.error("E2003", "function '" + declaration.name + "' can finish without returning " + displayType(declaredReturnType), declaration.body.span);
            }
            functionType.result = declaredReturnType;
        } else {
            const values = [...returns];
            if (!definitelyReturns) values.push(unitType);
            functionType.result = values.length === 0 ? unitType : this.joinReturnTypes(values, declaration);
        }
        binding.type = functionType;
    }

    checkExternalFunction(declaration, topLevel) {
        if (!topLevel) this.error("E2002", "C ABI declarations are only allowed at the top level", declaration.span);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(declaration.name) || cKeywords.has(declaration.name) || declaration.name.startsWith("omni_")) {
            this.error("E2002", "C function names must be portable identifiers and cannot be C keywords, 'main', or start with 'omni_'", declaration.span);
        }
        this.assertNameAvailable(declaration.name, declaration.span);
        const parameters = [];
        const parameterNames = new Set();
        for (const parameter of declaration.parameters) {
            if (parameterNames.has(parameter.name)) this.error("E2002", "parameter '" + parameter.name + "' is declared more than once", parameter.span);
            parameterNames.add(parameter.name);
            const type = this.resolveType(parameter.typeAnnotation);
            if (!["Int", "Float", "Bool"].includes(displayType(type))) {
                this.error("E2003", "C ABI parameters support only Int, Float, and Bool; " + displayType(type) + " is not supported", parameter.span);
            }
            parameters.push(type);
        }
        const result = declaration.returnType ? this.resolveType(declaration.returnType) : unitType;
        if (!["Unit", "Int", "Float", "Bool"].includes(displayType(result))) {
            this.error("E2003", "C ABI results support only Unit, Int, Float, and Bool; " + displayType(result) + " is not supported", declaration.returnType?.span ?? declaration.span);
        }
        this.currentScope().values.set(declaration.name, {
            kind: "value",
            type: { kind: "function", parameters, result, external: true },
            mutable: false,
            span: declaration.span,
        });
    }

    joinReturnTypes(types, declaration) {
        let result = types[0];
        for (const type of types.slice(1)) {
            if (isAssignable(type, result)) continue;
            if (isAssignable(result, type)) result = type;
            else this.error("E2003", "function '" + declaration.name + "' returns incompatible types " + displayType(result) + " and " + displayType(type) + "; add a return annotation", declaration.span);
        }
        return result;
    }

    checkBinding(declaration) {
        const initialType = this.checkExpression(declaration.initializer);
        const type = declaration.typeAnnotation ? this.resolveType(declaration.typeAnnotation) : initialType;
        if (!isAssignable(initialType, type)) {
            this.typeMismatch(initialType, type, declaration.initializer.span);
        }
        this.defineValue(declaration.name, { kind: "value", type, mutable: declaration.mutable, span: declaration.span }, declaration.span);
    }

    checkStatement(statement) {
        switch (statement.kind) {
            case "BlockStatement":
                this.checkBlock(statement);
                return;
            case "ExpressionStatement":
                this.checkExpression(statement.expression);
                return;
            case "IfStatement":
                this.requireBool(this.checkExpression(statement.condition), statement.condition.span);
                this.checkStatement(statement.thenBranch);
                if (statement.elseBranch) this.checkStatement(statement.elseBranch);
                return;
            case "WhileStatement":
                this.requireBool(this.checkExpression(statement.condition), statement.condition.span);
                this.checkBlock(statement.body);
                return;
            case "ForStatement": {
                const iterable = this.checkExpression(statement.iterable);
                let itemType;
                if (iterable.kind === "List") itemType = iterable.element;
                else if (iterable.kind === "Text") itemType = textType;
                else if (iterable.kind === "Any") itemType = anyType;
                else this.error("E2003", "for can iterate over a List or Text, not " + displayType(iterable), statement.iterable.span);
                this.pushScope();
                this.defineValue(statement.name, { kind: "value", type: itemType, mutable: false, span: statement.span }, statement.span);
                this.checkBlock(statement.body);
                this.popScope();
                return;
            }
            case "ReturnStatement": {
                if (!this.currentFunction) this.error("E2003", "return can only be used inside a function", statement.span);
                const result = this.checkExpression(statement.value);
                if (this.currentFunction.expected && !isAssignable(result, this.currentFunction.expected)) {
                    this.typeMismatch(result, this.currentFunction.expected, statement.value.span);
                }
                this.currentFunction.returns.push(result);
                return;
            }
            case "MatchStatement":
                this.checkMatch(statement);
                return;
            case "BreakStatement":
            case "ContinueStatement":
                return;
            default:
                this.error("E2003", "unsupported statement for static checking", statement.span);
        }
    }

    checkBlock(block) {
        this.pushScope();
        for (const declaration of block.declarations) this.checkDeclaration(declaration, false);
        this.popScope();
    }

    checkExpression(expression) {
        switch (expression.kind) {
            case "LiteralExpression":
                if (expression.literalType === "number") return Number.isSafeInteger(expression.value) ? intType : floatType;
                if (expression.literalType === "text") {
                    if (hasUnsupportedInterpolation(expression.value)) {
                        this.error("E1018", "string interpolation currently accepts a variable name such as {name}", expression.span);
                    }
                    for (const name of interpolationNames(expression.value)) {
                        if (!this.findValue(name)) this.error("E2001", "unknown name '" + name + "' in string interpolation", expression.span);
                    }
                    return textType;
                }
                if (expression.literalType === "bool") return boolType;
                return unitType;
            case "IdentifierExpression": {
                const binding = this.findValue(expression.name);
                if (!binding) this.error("E2001", "unknown name '" + expression.name + "'", expression.span);
                return binding.kind === "value" ? binding.type : binding;
            }
            case "ListExpression": {
                if (expression.elements.length === 0) return { kind: "List", element: anyType, emptyLiteral: true };
                const elementTypes = expression.elements.map((element) => this.checkExpression(element));
                return { kind: "List", element: joinTypes(elementTypes) };
            }
            case "UnaryExpression": {
                const operand = this.checkExpression(expression.operand);
                if (expression.operator === "!") {
                    this.requireBool(operand, expression.operand.span);
                    return boolType;
                }
                this.requireNumber(operand, expression.operand.span);
                return operand.kind === "Int" ? intType : operand.kind === "Float" ? floatType : numberType;
            }
            case "BinaryExpression":
                return this.checkBinary(expression);
            case "AssignmentExpression":
                return this.checkAssignment(expression);
            case "CallExpression":
                return this.checkCall(expression);
            case "IndexExpression":
                return this.checkIndex(expression);
            case "MemberExpression":
                return this.checkMember(expression);
            default:
                this.error("E2003", "unsupported expression for static checking", expression.span);
        }
    }

    checkBinary(expression) {
        const left = this.checkExpression(expression.left);
        if (expression.operator === "and" || expression.operator === "or") {
            this.requireBool(left, expression.left.span);
            this.requireBool(this.checkExpression(expression.right), expression.right.span);
            return boolType;
        }
        const right = this.checkExpression(expression.right);
        if (expression.operator === "==" || expression.operator === "!=") return boolType;
        if (["<", "<=", ">", ">="].includes(expression.operator)) {
            const numeric = isNumeric(left) && isNumeric(right);
            const textual = left.kind === "Text" && right.kind === "Text";
            if ((!numeric && !textual) && left.kind !== "Any" && right.kind !== "Any") {
                this.error("E2003", "ordered comparison needs two numbers or two Text values", expression.span);
            }
            return boolType;
        }
        if (expression.operator === "+" && left.kind === "Text" && right.kind === "Text") return textType;
        if (expression.operator === "+" && (left.kind === "Text" || right.kind === "Text") && left.kind !== "Any" && right.kind !== "Any") {
            this.error("E2003", "+ combines two numbers or two Text values", expression.span);
        }
        this.requireNumber(left, expression.left.span);
        this.requireNumber(right, expression.right.span);
        if (left.kind === "Any" || right.kind === "Any") return anyType;
        if (expression.operator === "/") return floatType;
        if (left.kind === "Int" && right.kind === "Int") return intType;
        if (left.kind === "Float" || right.kind === "Float") return floatType;
        return numberType;
    }

    checkAssignment(expression) {
        const target = expression.target;
        if (target.kind === "IdentifierExpression") {
            const binding = this.findValue(target.name);
            if (!binding) this.error("E2001", "unknown name '" + target.name + "'", target.span);
            if (!binding.mutable) this.error("E2003", "cannot assign to immutable binding '" + target.name + "'", target.span);
            const value = this.checkExpression(expression.value);
            if (!isAssignable(value, binding.type ?? anyType)) this.typeMismatch(value, binding.type, expression.value.span);
            return binding.type ?? anyType;
        }
        if (target.kind === "IndexExpression") {
            const object = this.checkExpression(target.object);
            const index = this.checkExpression(target.index);
            this.requireInt(index, target.index.span);
            if (object.kind === "Text") this.error("E2003", "Text cannot be changed by index", target.span);
            if (object.kind !== "List" && object.kind !== "Any") this.error("E2003", "indexed assignment needs a List", target.span);
            const expected = object.kind === "List" ? object.element : anyType;
            const value = this.checkExpression(expression.value);
            if (!isAssignable(value, expected)) this.typeMismatch(value, expected, expression.value.span);
            return expected;
        }
        if (target.kind === "MemberExpression") {
            const field = this.resolveMember(target, true);
            const value = this.checkExpression(expression.value);
            if (!isAssignable(value, field.type)) this.typeMismatch(value, field.type, expression.value.span);
            return field.type;
        }
        this.error("E2003", "invalid assignment target", target.span);
    }

    checkIndex(expression) {
        const object = this.checkExpression(expression.object);
        this.requireInt(this.checkExpression(expression.index), expression.index.span);
        if (object.kind === "List") return object.element;
        if (object.kind === "Text") return textType;
        if (object.kind === "Any") return anyType;
        this.error("E2003", "only a List or Text value can be indexed", expression.object.span);
    }

    checkMember(expression) {
        return this.resolveMember(expression, false).type;
    }

    resolveMember(expression, forAssignment) {
        const object = this.checkExpression(expression.object);
        if (object.kind === "Any") return { type: anyType };
        if (object.kind === "record") {
            const type = object.fields.get(expression.name);
            if (!type) this.error("E2005", "record '" + object.name + "' has no field '" + expression.name + "'", expression.span);
            return { type };
        }
        if (object.kind === "module") {
            if (forAssignment) this.error("E2005", "module members are read-only", expression.span);
            if (!object.module.values.has(expression.name) && !object.module.types.has(expression.name)) {
                this.error("E2005", "module '" + object.name + "' has no exported name '" + expression.name + "'", expression.span);
            }
            if (object.module.types.has(expression.name) && !object.module.values.has(expression.name)) {
                return { type: { kind: "enum-constructor", enumeration: object.module.types.get(expression.name) } };
            }
            return { type: object.module.values.get(expression.name) };
        }
        if (object.kind === "enum-constructor") {
            const fields = object.enumeration.variants.get(expression.name);
            if (!fields) this.error("E2005", "enum '" + object.enumeration.name + "' has no variant '" + expression.name + "'", expression.span);
            return { type: { kind: "enum-variant-constructor", enumeration: object.enumeration, name: expression.name, fields } };
        }
        if (object.kind === "enum") this.error("E2005", "enum values can only be inspected with match", expression.span);
        this.error("E2005", "value of type " + displayType(object) + " has no member '" + expression.name + "'", expression.span);
    }

    checkCall(expression) {
        const callee = this.checkExpression(expression.callee);
        const named = expression.arguments.some((argument) => argument.kind === "NamedArgument");
        if (callee.kind === "record-constructor") return this.checkRecordCall(expression, callee.record);
        if (callee.kind === "enum-variant-constructor") return this.checkEnumVariantCall(expression, callee, named);
        if (named) this.error("E2004", "named arguments are only used to construct records", expression.span);
        const argumentsList = expression.arguments.map((argument) => this.checkExpression(argument));
        if (callee.kind === "builtin") return this.checkBuiltinCall(callee.name, argumentsList, expression);
        if (callee.kind === "function") {
            if (argumentsList.length !== callee.parameters.length) this.error("E2004", "function expects " + callee.parameters.length + " argument(s), received " + argumentsList.length, expression.span);
            for (let index = 0; index < argumentsList.length; index += 1) {
                if (!isAssignable(argumentsList[index], callee.parameters[index])) {
                    this.typeMismatch(argumentsList[index], callee.parameters[index], expression.arguments[index].span);
                }
            }
            return callee.result;
        }
        if (callee.kind === "Any") return anyType;
        this.error("E2004", "value of type " + displayType(callee) + " cannot be called", expression.callee.span);
    }

    checkRecordCall(expression, record) {
        if (expression.arguments.some((argument) => argument.kind !== "NamedArgument")) {
            this.error("E2006", "record fields must be supplied by name", expression.span);
        }
        const supplied = new Map();
        for (const argument of expression.arguments) {
            if (supplied.has(argument.name)) this.error("E2006", "record field '" + argument.name + "' is supplied more than once", argument.span);
            const expected = record.fields.get(argument.name);
            if (!expected) this.error("E2006", "record '" + record.name + "' has no field '" + argument.name + "'", argument.span);
            const actual = this.checkExpression(argument.value);
            if (!isAssignable(actual, expected)) this.typeMismatch(actual, expected, argument.value.span);
            supplied.set(argument.name, argument.span);
        }
        for (const name of record.fields.keys()) {
            if (!supplied.has(name)) this.error("E2006", "record '" + record.name + "' needs a value for field '" + name + "'", expression.span);
        }
        return record;
    }

    checkEnumVariantCall(expression, variant, named) {
        if (named) this.error("E2004", "enum variant payloads use positional values", expression.span);
        if (expression.arguments.length !== variant.fields.length) {
            this.error("E2004", "variant '" + variant.enumeration.name + "." + variant.name + "' expects " + variant.fields.length + " value(s)", expression.span);
        }
        for (let index = 0; index < expression.arguments.length; index += 1) {
            const actual = this.checkExpression(expression.arguments[index]);
            if (!isAssignable(actual, variant.fields[index])) this.typeMismatch(actual, variant.fields[index], expression.arguments[index].span);
        }
        return variant.enumeration;
    }

    checkBuiltinCall(name, args, expression) {
        const arity = (minimum, maximum = minimum) => {
            if (args.length < minimum || args.length > maximum) {
                const expected = minimum === maximum ? String(minimum) : minimum + " to " + maximum;
                this.error("E2004", "'" + name + "' expects " + expected + " argument(s), received " + args.length, expression.span);
            }
        };
        switch (name) {
            case "print": arity(0, Infinity); return unitType;
            case "serial_write":
                arity(1);
                if (!["Text", "Any"].includes(args[0].kind)) this.error("E2003", "serial_write expects Text", expression.arguments[0].span);
                return unitType;
            case "gpio_write":
                arity(2);
                this.requireInt(args[0], expression.arguments[0].span);
                this.requireBool(args[1], expression.arguments[1].span);
                return unitType;
            case "str": arity(1); return textType;
            case "type_of": arity(1); return textType;
            case "len":
                arity(1);
                if (!["Text", "List", "Any"].includes(args[0].kind)) this.error("E2003", "len expects Text or List", expression.span);
                return intType;
            case "range":
                arity(1, 3);
                for (let index = 0; index < args.length; index += 1) this.requireInt(args[index], expression.arguments[index].span);
                return { kind: "List", element: intType };
            case "push":
                arity(2);
                if (args[0].kind === "Any") return intType;
                if (args[0].kind !== "List") this.error("E2003", "push expects a List as its first argument", expression.arguments[0].span);
                if (!isAssignable(args[1], args[0].element)) this.typeMismatch(args[1], args[0].element, expression.arguments[1].span);
                return intType;
            case "pop":
                arity(1);
                if (args[0].kind === "Any") return anyType;
                if (args[0].kind !== "List") this.error("E2003", "pop expects a List", expression.arguments[0].span);
                return args[0].element;
            case "some": arity(1); return { kind: "Option", element: args[0] };
            case "ok": arity(1); return { kind: "Result", success: args[0], error: anyType };
            case "err": arity(1); return { kind: "Result", success: anyType, error: args[0] };
            case "map": {
                arity(2);
                if (args[0].kind !== "List" && args[0].kind !== "Any") this.error("E2003", "map expects a List as its first argument", expression.arguments[0].span);
                const callback = args[1];
                if (callback.kind !== "function" && callback.kind !== "Any") this.error("E2003", "map expects a function as its second argument", expression.arguments[1].span);
                if (callback.kind === "function") {
                    if (callback.parameters.length !== 1) this.error("E2004", "map callback must accept one value", expression.arguments[1].span);
                    if (args[0].kind === "List" && !isAssignable(args[0].element, callback.parameters[0])) this.typeMismatch(args[0].element, callback.parameters[0], expression.arguments[1].span);
                    return { kind: "List", element: callback.result };
                }
                return { kind: "List", element: anyType };
            }
            case "filter": {
                arity(2);
                if (args[0].kind !== "List" && args[0].kind !== "Any") this.error("E2003", "filter expects a List as its first argument", expression.arguments[0].span);
                const callback = args[1];
                if (callback.kind !== "function" && callback.kind !== "Any") this.error("E2003", "filter expects a function as its second argument", expression.arguments[1].span);
                if (callback.kind === "function") {
                    if (callback.parameters.length !== 1) this.error("E2004", "filter callback must accept one value", expression.arguments[1].span);
                    if (args[0].kind === "List" && !isAssignable(args[0].element, callback.parameters[0])) this.typeMismatch(args[0].element, callback.parameters[0], expression.arguments[1].span);
                    this.requireBool(callback.result, expression.arguments[1].span);
                }
                return args[0].kind === "List" ? args[0] : { kind: "List", element: anyType };
            }
            default: this.error("E2004", "unknown built-in function '" + name + "'", expression.span);
        }
    }

    checkMatch(statement) {
        const valueType = this.checkExpression(statement.value);
        const covered = new Set();
        const seenPatterns = new Set();
        let catchAll = false;
        for (const matchCase of statement.cases) {
            if (catchAll || isExhaustive(valueType, covered)) {
                this.error("E2007", "this match case can never run after all values are covered", matchCase.pattern.span);
            }
            const info = this.checkPattern(matchCase.pattern, valueType);
            if (info.key && seenPatterns.has(info.key)) this.error("E2007", "this match case duplicates an earlier case", matchCase.pattern.span);
            if (info.key) seenPatterns.add(info.key);
            if (info.coverage) covered.add(info.coverage);
            catchAll ||= info.catchAll;
            this.pushScope();
            for (const [name, type] of info.bindings) this.defineValue(name, { kind: "value", type, mutable: false, span: matchCase.pattern.span }, matchCase.pattern.span);
            this.checkBlock(matchCase.body);
            this.popScope();
        }
        if (!catchAll && !isExhaustive(valueType, covered)) {
            this.error("E2008", "match does not cover every " + displayType(valueType) + " value; add the missing case or a final '_' case", statement.span);
        }
    }

    checkPattern(pattern, valueType) {
        if (pattern.kind === "WildcardPattern") return { key: "_", catchAll: true, bindings: new Map() };
        if (pattern.kind === "BindingPattern") return { key: "_", catchAll: true, bindings: new Map([[pattern.name, valueType]]) };
        if (pattern.kind === "BoolPattern") {
            if (valueType.kind !== "Bool" && valueType.kind !== "Any") this.typeMismatch(boolType, valueType, pattern.span);
            return { key: "bool:" + pattern.value, coverage: "bool:" + pattern.value, bindings: new Map() };
        }
        if (pattern.kind === "NumberPattern") {
            this.requireNumber(valueType, pattern.span);
            return { key: "number:" + pattern.value, bindings: new Map() };
        }
        if (pattern.kind === "TextPattern") {
            if (valueType.kind !== "Text" && valueType.kind !== "Any") this.typeMismatch(textType, valueType, pattern.span);
            return { key: "text:" + pattern.value, bindings: new Map() };
        }
        if (pattern.kind === "NonePattern") {
            if (valueType.kind !== "Unit" && valueType.kind !== "Option" && valueType.kind !== "Any") this.typeMismatch({ kind: "Option", element: anyType }, valueType, pattern.span);
            return { key: "none", coverage: "none", bindings: new Map() };
        }
        if (pattern.kind === "EnumVariantPattern") return this.checkEnumPattern(pattern.path, [], pattern.span, valueType);
        if (pattern.kind === "ConstructorPattern") {
            const name = pattern.path.at(-1);
            if (pattern.path.length === 1 && ["some", "ok", "err"].includes(name)) {
                return this.checkBuiltinPattern(name, pattern, valueType);
            }
            return this.checkEnumPattern(pattern.path, pattern.fields, pattern.span, valueType);
        }
        this.error("E2007", "unsupported match pattern", pattern.span);
    }

    checkBuiltinPattern(name, pattern, valueType) {
        const bindings = new Map();
        let payload;
        let coverage;
        if (name === "some") {
            if (valueType.kind !== "Option" && valueType.kind !== "Any") this.typeMismatch({ kind: "Option", element: anyType }, valueType, pattern.span);
            if (pattern.fields.length !== 1) this.error("E2007", "some pattern needs one payload pattern", pattern.span);
            payload = valueType.kind === "Option" ? valueType.element : anyType;
            coverage = "some";
        } else {
            if (valueType.kind !== "Result" && valueType.kind !== "Any") this.typeMismatch({ kind: "Result", success: anyType, error: anyType }, valueType, pattern.span);
            if (pattern.fields.length !== 1) this.error("E2007", name + " pattern needs one payload pattern", pattern.span);
            payload = valueType.kind === "Result" ? (name === "ok" ? valueType.success : valueType.error) : anyType;
            coverage = name;
        }
        const child = this.checkPattern(pattern.fields[0], payload);
        for (const [key, type] of child.bindings) bindings.set(key, type);
        const fullyCoversVariant = child.catchAll;
        return { key: name + "(" + patternKey(pattern.fields[0]) + ")", coverage: fullyCoversVariant ? coverage : null, bindings };
    }

    checkEnumPattern(path, fields, span, valueType) {
        if (path.length < 2) this.error("E2007", "enum patterns use a qualified variant name", span);
        const enumeration = this.resolveNamedType(path.slice(0, -1), span);
        if (enumeration.kind !== "enum") this.error("E2007", "'" + path.slice(0, -1).join(".") + "' is not an enum", span);
        if (valueType.kind !== "Any" && (valueType.kind !== "enum" || valueType !== enumeration)) this.typeMismatch(enumeration, valueType, span);
        const variantName = path.at(-1);
        const payloadTypes = enumeration.variants.get(variantName);
        if (!payloadTypes) this.error("E2007", "enum '" + enumeration.name + "' has no variant '" + variantName + "'", span);
        if (payloadTypes.length !== fields.length) this.error("E2007", "variant '" + enumeration.name + "." + variantName + "' expects " + payloadTypes.length + " pattern value(s)", span);
        const bindings = new Map();
        const childInfos = [];
        for (let index = 0; index < fields.length; index += 1) {
            const child = this.checkPattern(fields[index], payloadTypes[index]);
            childInfos.push(child);
            for (const [name, type] of child.bindings) bindings.set(name, type);
        }
        const coverage = "variant:" + enumeration.name + "." + variantName;
        const coversVariant = childInfos.every((child) => child.catchAll);
        return {
            key: coverage + "(" + fields.map(patternKey).join(",") + ")",
            coverage: coversVariant ? coverage : null,
            bindings,
        };
    }

    resolveNamedType(path, span) {
        if (path.length === 1) {
            const type = this.findType(path[0]);
            if (!type) this.error("E2001", "unknown type '" + path[0] + "'", span);
            return type;
        }
        const moduleBinding = this.findValue(path[0]);
        if (!moduleBinding || moduleBinding.kind !== "module") this.error("E2001", "unknown module '" + path[0] + "' in type name", span);
        const type = moduleBinding.module.types.get(path.slice(1).join("."));
        if (!type) this.error("E2001", "module '" + path[0] + "' has no type '" + path.slice(1).join(".") + "'", span);
        return type;
    }

    resolveType(reference) {
        if (typeof reference === "string") {
            const name = reference.endsWith("?") ? reference.slice(0, -1) : reference;
            const base = this.resolveTypeName([name], [], null);
            return reference.endsWith("?") ? { kind: "Option", element: base } : base;
        }
        const base = this.resolveTypeName(reference.path, reference.arguments, reference.span);
        return reference.optional ? { kind: "Option", element: base } : base;
    }

    resolveTypeName(path, argumentsList, span) {
        if (path.length > 1) return this.resolveNamedType(path, span);
        const name = path[0];
        const args = argumentsList.map((argument) => this.resolveType(argument));
        if (name === "String") {
            if (args.length) this.error("E2001", "Text does not take type arguments", span);
            return textType;
        }
        if (["Any", "Number", "Int", "Float", "Text", "Bool", "Unit"].includes(name)) {
            if (args.length) this.error("E2001", name + " does not take type arguments", span);
            return ({ Any: anyType, Number: numberType, Int: intType, Float: floatType, Text: textType, Bool: boolType, Unit: unitType })[name];
        }
        if (name === "List") {
            if (args.length > 1) this.error("E2001", "List takes one type argument", span);
            return { kind: "List", element: args[0] ?? anyType };
        }
        if (name === "Option") {
            if (args.length !== 1) this.error("E2001", "Option takes one type argument", span);
            return { kind: "Option", element: args[0] };
        }
        if (name === "Result") {
            if (args.length !== 2) this.error("E2001", "Result takes two type arguments", span);
            return { kind: "Result", success: args[0], error: args[1] };
        }
        const type = this.findType(name);
        if (!type) this.error("E2001", "unknown type '" + name + "'", span);
        if (args.length) this.error("E2001", "user-defined type '" + name + "' does not take type arguments", span);
        return type;
    }

    requireBool(type, span) {
        if (type.kind !== "Bool" && type.kind !== "Any") this.typeMismatch(type, boolType, span);
    }

    requireNumber(type, span) {
        if (!isNumeric(type) && type.kind !== "Any") this.error("E2003", "expected a number, found " + displayType(type), span);
    }

    requireInt(type, span) {
        if (type.kind !== "Int" && type.kind !== "Number" && type.kind !== "Any") this.error("E2003", "expected an integer, found " + displayType(type), span);
    }

    typeMismatch(actual, expected, span) {
        this.error("E2003", "expected " + displayType(expected) + ", found " + displayType(actual), span);
    }

    assertNameAvailable(name, span) {
        if (this.currentScope().values.has(name) || this.currentScope().types.has(name)) {
            this.error("E2002", "the name '" + name + "' is already declared in this scope", span);
        }
    }

    defineValue(name, binding, span) {
        this.assertNameAvailable(name, span);
        this.currentScope().values.set(name, binding);
    }

    findValue(name) {
        for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
            const binding = this.scopes[index].values.get(name);
            if (binding) return binding;
        }
        return null;
    }

    findType(name) {
        for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
            const type = this.scopes[index].types.get(name);
            if (type) return type;
        }
        return null;
    }

    currentScope() {
        return this.scopes.at(-1);
    }

    pushScope() {
        this.scopes.push({ values: new Map(), types: new Map() });
    }

    popScope() {
        this.scopes.pop();
    }

    error(code, message, span) {
        fail(code, message, span, this.context.sourceName, this.context.sourceText);
    }
}

function isNumeric(type) {
    return ["Int", "Float", "Number"].includes(type.kind);
}

function isAssignable(actual, expected) {
    if (!actual || !expected) return false;
    if (actual.kind === "Any" || expected.kind === "Any") return true;
    if (actual.kind === "Unit" && expected.kind === "Option") return true;
    if (expected.kind === "Number" && isNumeric(actual)) return true;
    if (expected.kind === "Float" && isNumeric(actual)) return true;
    if (actual.kind !== expected.kind) return false;
    if (["record", "enum"].includes(actual.kind)) return actual === expected;
    if (actual.kind === "List") return actual.emptyLiteral === true || expected.element.kind === "Any" || isSameType(actual.element, expected.element);
    if (actual.kind === "Option") return isAssignable(actual.element, expected.element);
    if (actual.kind === "Result") return isAssignable(actual.success, expected.success) && isAssignable(actual.error, expected.error);
    if (actual.kind === "module") return actual.module === expected.module;
    return true;
}

function isSameType(left, right) {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === "record" || left.kind === "enum") return left === right;
    if (left.kind === "List" || left.kind === "Option") return isSameType(left.element, right.element);
    if (left.kind === "Result") return isSameType(left.success, right.success) && isSameType(left.error, right.error);
    return true;
}

function joinTypes(types) {
    let result = types[0] ?? anyType;
    for (const type of types.slice(1)) {
        if (isAssignable(type, result)) continue;
        if (isAssignable(result, type)) {
            result = type;
            continue;
        }
        if (isNumeric(type) && isNumeric(result)) result = numberType;
        else result = anyType;
    }
    return result;
}

function displayType(type) {
    if (!type) return "Any";
    switch (type.kind) {
        case "List": return "List[" + displayType(type.element) + "]";
        case "Option": return "Option[" + displayType(type.element) + "]";
        case "Result": return "Result[" + displayType(type.success) + ", " + displayType(type.error) + "]";
        case "record":
        case "enum": return type.name;
        case "function": return "Function";
        case "record-constructor": return "record constructor";
        case "enum-constructor": return "enum";
        case "enum-variant-constructor": return "enum variant constructor";
        case "module": return "Module";
        case "builtin": return "Function";
        default: return type.kind;
    }
}

function isExhaustive(type, covered) {
    if (type.kind === "Bool") return covered.has("bool:true") && covered.has("bool:false");
    if (type.kind === "Unit") return covered.has("none");
    if (type.kind === "Option") return covered.has("none") && covered.has("some");
    if (type.kind === "Result") return covered.has("ok") && covered.has("err");
    if (type.kind === "enum") return [...type.variants.keys()].every((name) => covered.has("variant:" + type.name + "." + name));
    return false;
}

function patternKey(pattern) {
    switch (pattern.kind) {
        case "WildcardPattern":
        case "BindingPattern": return "_";
        case "NumberPattern": return "number:" + pattern.value;
        case "TextPattern": return "text:" + JSON.stringify(pattern.value);
        case "BoolPattern": return "bool:" + pattern.value;
        case "NonePattern": return "none";
        case "EnumVariantPattern": return pattern.path.join(".") + "()";
        case "ConstructorPattern": return pattern.path.join(".") + "(" + pattern.fields.map(patternKey).join(",") + ")";
        default: return pattern.kind;
    }
}

function blockDefinitelyReturns(block) {
    for (const declaration of block.declarations) {
        if (statementDefinitelyReturns(declaration)) return true;
    }
    return false;
}

function statementDefinitelyReturns(statement) {
    if (statement.kind === "ReturnStatement") return true;
    if (statement.kind === "BlockStatement") return blockDefinitelyReturns(statement);
    if (statement.kind === "IfStatement" && statement.elseBranch) {
        return statementDefinitelyReturns(statement.thenBranch) && statementDefinitelyReturns(statement.elseBranch);
    }
    if (statement.kind === "MatchStatement") {
        return statement.cases.every((matchCase) => blockDefinitelyReturns(matchCase.body));
    }
    return false;
}

export function checkProgram(program, context, options = {}) {
    return new TypeChecker(context, options).check(program);
}
