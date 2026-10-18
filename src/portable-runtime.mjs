import { fail } from "./diagnostics.mjs";
import { ExportBinding, OptionValue, ResultValue, interpolateText, stringify } from "./interpreter.mjs";

const MAX_FUNCTION_CALL_DEPTH = 256;
const MAX_EXPRESSION_NESTING = 128;

export class PortableRuntime {
    constructor(context, output = (text) => process.stdout.write(text)) {
        this.context = context;
        this.output = output;
        this.callDepth = 0;
        this.expressionDepth = 0;
        this.listElementContracts = new WeakMap();
        this.builtins = this.createBuiltins();
    }

    error(code, message, span) {
        fail(code, message, span, this.context.sourceName, this.context.sourceText);
    }

    createFunction(name, parameters, returnType, bodySpan, implementation) {
        return { kind: "function", name, parameters, returnType, bodySpan, implementation };
    }

    native(name, minimumArguments, maximumArguments, implementation) {
        return { kind: "native", name, minimumArguments, maximumArguments, implementation };
    }

    createBuiltins() {
        const values = Object.create(null);
        values.print = this.native("print", 0, Infinity, (args) => {
            this.output(args.map((value) => stringify(value)).join(" ") + "\n");
            return null;
        });
        values.serial_write = this.native("serial_write", 1, 1, (_args, call) => {
            this.error("E3004", "serial_write requires the embedded target", call.span);
        });
        values.gpio_write = this.native("gpio_write", 2, 2, (_args, call) => {
            this.error("E3004", "gpio_write requires the embedded target", call.span);
        });
        values.len = this.native("len", 1, 1, (args, call) => {
            if (typeof args[0] === "string") return Array.from(args[0]).length;
            if (Array.isArray(args[0])) return args[0].length;
            this.error("E1010", "len expects text or a list", call.span);
        });
        values.str = this.native("str", 1, 1, (args) => stringify(args[0]));
        values.type_of = this.native("type_of", 1, 1, (args) => this.typeOf(args[0]));
        values.range = this.native("range", 1, 3, (args, call) => {
            const start = args.length === 1 ? 0 : args[0];
            const stop = args.length === 1 ? args[0] : args[1];
            const step = args.length === 3 ? args[2] : 1;
            if (![start, stop, step].every(Number.isSafeInteger)) {
                this.error("E1011", "range arguments must be safe whole numbers", call.span);
            }
            if (step === 0) this.error("E1011", "range step cannot be zero", call.span);
            const result = [];
            for (let value = start; step > 0 ? value < stop : value > stop; value += step) {
                if (result.length >= 1_000_000) this.error("E1011", "range is limited to one million values", call.span);
                result.push(value);
            }
            return result;
        });
        values.push = this.native("push", 2, 2, (args, call) => {
            if (!Array.isArray(args[0])) this.error("E1012", "push expects a list as its first argument", call.span);
            const contract = this.listElementContracts.get(args[0]);
            if (contract) this.assertType(args[1], contract.annotation, "list element", call.span);
            args[0].push(args[1]);
            return args[0].length;
        });
        values.pop = this.native("pop", 1, 1, (args, call) => {
            if (!Array.isArray(args[0])) this.error("E1012", "pop expects a list", call.span);
            if (args[0].length === 0) this.error("E1012", "cannot pop an empty list", call.span);
            return args[0].pop();
        });
        values.map = this.native("map", 2, 2, (args, call) => {
            if (!Array.isArray(args[0])) this.error("E1012", "map expects a list as its first argument", call.span);
            return [...args[0]].map((value) => this.invoke(args[1], [value], call.span, call.span));
        });
        values.filter = this.native("filter", 2, 2, (args, call) => {
            if (!Array.isArray(args[0])) this.error("E1012", "filter expects a list as its first argument", call.span);
            const result = [];
            for (const value of [...args[0]]) {
                const keep = this.invoke(args[1], [value], call.span, call.span);
                this.requireBoolean(keep, call.span);
                if (keep) result.push(value);
            }
            return result;
        });
        values.some = this.native("some", 1, 1, (args) => new OptionValue(args[0]));
        values.ok = this.native("ok", 1, 1, (args) => new ResultValue("ok", args[0]));
        values.err = this.native("err", 1, 1, (args) => new ResultValue("err", args[0]));
        return values;
    }

    invoke(callee, args, span, calleeSpan) {
        if (!callee || (callee.kind !== "function" && callee.kind !== "native")) {
            this.error("E1015", "this value cannot be called", calleeSpan);
        }
        if (callee.kind === "native") {
            if (args.length < callee.minimumArguments || args.length > callee.maximumArguments) {
                const expected = callee.minimumArguments === callee.maximumArguments
                    ? String(callee.minimumArguments)
                    : callee.maximumArguments === Infinity
                        ? "at least " + callee.minimumArguments
                        : callee.minimumArguments + " to " + callee.maximumArguments;
                this.error("E1016", "'" + callee.name + "' received " + args.length + " argument(s), but expects " + expected, span);
            }
            return callee.implementation(args, { span, runtime: this });
        }
        if (args.length !== callee.parameters.length) {
            this.error("E1016", "'" + callee.name + "' received " + args.length + " argument(s), but expects " + callee.parameters.length, span);
        }
        if (this.callDepth >= MAX_FUNCTION_CALL_DEPTH) {
            this.error("E1017", "function call depth exceeds the limit of " + MAX_FUNCTION_CALL_DEPTH, span);
        }
        for (let index = 0; index < args.length; index += 1) {
            const parameter = callee.parameters[index];
            if (parameter.typeAnnotation) this.assertType(args[index], parameter.typeAnnotation, parameter.name, parameter.span);
        }
        const outerExpressionDepth = this.expressionDepth;
        this.expressionDepth = 0;
        this.callDepth += 1;
        try {
            const result = callee.implementation(args);
            if (callee.returnType) this.assertType(result, callee.returnType, "return value", callee.bodySpan ?? span);
            return result === undefined ? null : result;
        } finally {
            this.callDepth -= 1;
            this.expressionDepth = outerExpressionDepth;
        }
    }

    expression(span, evaluate) {
        this.enterExpression(span);
        try {
            return evaluate();
        } finally {
            this.leaveExpression();
        }
    }

    enterExpression(span) {
        this.expressionDepth += 1;
        if (this.expressionDepth > MAX_EXPRESSION_NESTING) {
            this.expressionDepth -= 1;
            this.error("E1026", "expression nesting exceeds the limit of " + MAX_EXPRESSION_NESTING, span);
        }
    }

    leaveExpression(value = undefined) {
        this.expressionDepth -= 1;
        return value;
    }

    requireBoolean(value, span) {
        if (typeof value !== "boolean") this.error("E1022", "condition must be Bool; OMNI does not convert values by truthiness", span);
        return value;
    }

    requireNumber(value, span) {
        if (typeof value !== "number" || !Number.isFinite(value)) this.error("E1023", "arithmetic requires a finite number", span);
        return value;
    }

    checkedNumber(value, span) {
        if (!Number.isFinite(value)) this.error("E1024", "numeric operation produced a non-finite result", span);
        return value;
    }

    unary(operator, value, operandSpan, span) {
        if (operator === "!") return !this.requireBoolean(value, operandSpan);
        this.requireNumber(value, operandSpan);
        return this.checkedNumber(-value, span);
    }

    binary(operator, left, right, leftSpan, rightSpan, span) {
        if (operator === "==" || operator === "!=") {
            const equal = left === right;
            return operator === "==" ? equal : !equal;
        }
        if (["<", "<=", ">", ">="].includes(operator)) {
            if (typeof left !== typeof right || !["number", "string"].includes(typeof left)) {
                this.error("E1014", "comparison needs two numbers or two text values", span);
            }
            if (operator === "<") return left < right;
            if (operator === "<=") return left <= right;
            if (operator === ">") return left > right;
            return left >= right;
        }
        if (operator === "+" && typeof left === "string" && typeof right === "string") return left + right;
        this.requireNumber(left, leftSpan);
        this.requireNumber(right, rightSpan);
        if (operator === "+") return this.checkedNumber(left + right, span);
        if (operator === "-") return this.checkedNumber(left - right, span);
        if (operator === "*") return this.checkedNumber(left * right, span);
        if (operator === "/") return this.checkedNumber(left / right, span);
        return this.checkedNumber(left % right, span);
    }

    logical(operator, leftThunk, rightThunk, leftSpan, rightSpan) {
        const left = this.requireBoolean(leftThunk(), leftSpan);
        if (operator === "and" && !left) return false;
        if (operator === "or" && left) return true;
        return this.requireBoolean(rightThunk(), rightSpan);
    }

    assignBinding(mutable, getValue, setValue, valueThunk, name, annotation, span) {
        getValue();
        if (!mutable) {
            this.error("E1003", "cannot assign to immutable binding '" + name + "'; declare it with var to allow changes", span);
        }
        const value = valueThunk();
        if (annotation) this.assertType(value, annotation, name, span);
        setValue(value);
        return value;
    }

    typeOf(value) {
        if (value === null) return "Unit";
        if (typeof value === "boolean") return "Bool";
        if (typeof value === "number") return Number.isSafeInteger(value) ? "Int" : "Float";
        if (typeof value === "string") return "Text";
        if (Array.isArray(value)) return "List";
        if (value instanceof OptionValue) return "Option";
        if (value instanceof ResultValue) return "Result";
        if (value?.kind === "function" || value?.kind === "native") return "Function";
        return "Unknown";
    }

    assertType(value, annotation, bindingName, span) {
        const info = normalizeType(annotation);
        if (!this.matchesType(value, info, new Set())) {
            this.error("E1021", "'" + bindingName + "' must have type " + info.display + ", received " + this.typeOf(value), span);
        }
        if (info.name === "List" && info.arguments[0] && info.arguments[0].name !== "Any" && Array.isArray(value)) {
            this.listElementContracts.set(value, { annotation: info.arguments[0] });
            for (const item of value) this.assertType(item, info.arguments[0], "list element", span);
        }
        if (info.optional && value instanceof OptionValue) {
            this.assertType(value.value, { ...info, optional: false }, bindingName, span);
        } else if (info.name === "Option" && value instanceof OptionValue && info.arguments[0]) {
            this.assertType(value.value, info.arguments[0], bindingName, span);
        } else if (info.name === "Result" && value instanceof ResultValue) {
            const payloadType = info.arguments[value.kind === "ok" ? 0 : 1];
            if (payloadType) this.assertType(value.value, payloadType, bindingName, span);
        }
        return value;
    }

    matchesType(value, info, active) {
        if (info.optional) {
            if (value === null) return true;
            return value instanceof OptionValue && this.matchesType(value.value, { ...info, optional: false }, active);
        }
        switch (info.name) {
            case "Any": return true;
            case "Number":
            case "Float": return typeof value === "number" && Number.isFinite(value);
            case "Int": return typeof value === "number" && Number.isSafeInteger(value);
            case "Text":
            case "String": return typeof value === "string";
            case "Bool": return typeof value === "boolean";
            case "Unit": return value === null;
            case "List": {
                if (!Array.isArray(value)) return false;
                const element = info.arguments[0];
                if (!element || element.name === "Any" || active.has(value)) return true;
                active.add(value);
                const result = value.every((item) => this.matchesType(item, element, active));
                active.delete(value);
                return result;
            }
            case "Option":
                return value === null || value instanceof OptionValue && (!info.arguments[0] || this.matchesType(value.value, info.arguments[0], active));
            case "Result": {
                if (!(value instanceof ResultValue)) return false;
                const payloadType = info.arguments[value.kind === "ok" ? 0 : 1];
                return !payloadType || this.matchesType(value.value, payloadType, active);
            }
            default: return false;
        }
    }

    getIndex(object, index, span) {
        const key = this.validateIndex(object, index, span, false);
        return typeof object === "string" ? Array.from(object)[key] : object[key];
    }

    validateIndex(object, index, span, forAssignment) {
        if (!Array.isArray(object) && typeof object !== "string") this.error("E1025", "only lists and text can be indexed", span);
        const length = typeof object === "string" ? Array.from(object).length : object.length;
        if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
            this.error("E1025", "index must be a whole number inside the value's bounds", span);
        }
        if (forAssignment && typeof object === "string") this.error("E1025", "text is immutable and cannot be indexed for assignment", span);
        return index;
    }

    assignIndex(objectThunk, indexThunk, valueThunk, span) {
        const object = objectThunk();
        const index = indexThunk();
        const key = this.validateIndex(object, index, span, true);
        const value = valueThunk();
        this.validateIndex(object, index, span, true);
        const contract = this.listElementContracts.get(object);
        if (contract) this.assertType(value, contract.annotation, "list element", span);
        object[key] = value;
        return value;
    }

    iterate(value, span) {
        if (Array.isArray(value)) return [...value];
        if (typeof value === "string") return Array.from(value);
        this.error("E1013", "for loops can iterate over a list or text", span);
    }

    interpolate(template, getValue, span) {
        return interpolateText(template, getValue, span, this.context);
    }

    exportBinding(getValue) {
        return new ExportBinding(Object.defineProperty({}, "value", { get: getValue }));
    }
}

function normalizeType(annotation) {
    if (annotation?.name && Array.isArray(annotation.arguments)) return annotation;
    if (typeof annotation === "string") {
        const optional = annotation.endsWith("?");
        const name = optional ? annotation.slice(0, -1) : annotation;
        return { name, arguments: [], optional, display: annotation };
    }
    return {
        name: annotation.path.at(-1),
        arguments: (annotation.arguments ?? []).map(normalizeType),
        optional: annotation.optional,
        display: annotation.display,
    };
}
