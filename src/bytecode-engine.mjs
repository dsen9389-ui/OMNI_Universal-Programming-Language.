import { ExportBinding } from "./interpreter.mjs";
import { unwrapSemanticProgram } from "./ir.mjs";
import { compileBytecode } from "./bytecode.mjs";
import { PortableRuntime } from "./portable-runtime.mjs";

class VmEnvironment {
    constructor(parent, runtime) {
        this.parent = parent;
        this.runtime = runtime;
        this.bindings = new Map();
    }

    define(name, value, mutable, annotation, span) {
        if (this.bindings.has(name)) {
            this.runtime.error("E1002", "the name '" + name + "' is already declared in this scope", span);
        }
        if (annotation) this.runtime.assertType(value, annotation, name, span);
        const binding = { name, value, mutable, annotation, span };
        this.bindings.set(name, binding);
        return binding;
    }

    find(name) {
        if (this.bindings.has(name)) return this.bindings.get(name);
        return this.parent?.find(name) ?? null;
    }

    get(name, span) {
        const binding = this.find(name);
        if (!binding) this.runtime.error("E1001", "unknown name '" + name + "'", span);
        return binding.value;
    }

    prepareAssignment(name, span) {
        const binding = this.find(name);
        if (!binding) this.runtime.error("E1001", "unknown name '" + name + "'", span);
        if (!binding.mutable) {
            this.runtime.error("E1003", "cannot assign to immutable binding '" + name + "'; declare it with var to allow changes", span);
        }
        return binding;
    }

    assign(binding, value, span) {
        if (binding.annotation) this.runtime.assertType(value, binding.annotation, binding.name, span);
        binding.value = value;
        return value;
    }

    exportBindings() {
        return new Map([...this.bindings].map(([name, binding]) => [name, new ExportBinding(binding)]));
    }
}

export class BytecodeEngine {
    constructor({ output } = {}) {
        this.output = output;
        this.bindings = new Map();
        this.values = new Map();
        this.runtime = null;
    }

    prepare(input, context = null) {
        const semantic = unwrapSemanticProgram(input, context);
        const program = compileBytecode(semantic.program, semantic.context);
        return { kind: "BytecodeExecutionPlan", semantic, program };
    }

    run(input, context = null) {
        const plan = input?.kind === "BytecodeExecutionPlan" ? input : this.prepare(input, context);
        const semantic = plan.semantic;
        const program = plan.program;
        const runtime = new PortableRuntime(semantic.context, this.output);
        this.runtime = runtime;
        const builtins = new VmEnvironment(null, runtime);
        for (const [name, value] of Object.entries(runtime.builtins)) builtins.define(name, value, false, null, null);
        const environment = new VmEnvironment(builtins, runtime);
        const result = this.executeChunk(program, 0, environment, runtime);
        this.bindings = environment.exportBindings();
        this.values = new Map([...this.bindings].map(([name, binding]) => [name, binding.binding.value]));
        return result;
    }

    executeChunk(program, chunkIndex, closure, runtime, args = []) {
        const chunk = program[chunkIndex];
        const environment = chunkIndex === 0 ? closure : new VmEnvironment(closure, runtime);
        if (chunkIndex !== 0) {
            for (let index = 0; index < chunk.parameters.length; index += 1) {
                environment.define(chunk.parameters[index].name, args[index], false, null, chunk.parameters[index].span);
            }
        }
        const frame = {
            chunk,
            stack: [],
            ip: 0,
            scopes: [environment],
            iterators: new Map(),
            result: null,
        };
        try {
            while (frame.ip < chunk.instructions.length) {
                const instruction = chunk.instructions[frame.ip++];
                const stack = frame.stack;
                const current = frame.scopes.at(-1);
                switch (instruction.op) {
                    case "CONST": stack.push(instruction.value); break;
                    case "LOAD": stack.push(current.get(instruction.name, instruction.span)); break;
                    case "DEFINE": {
                        const value = stack.pop();
                        current.define(instruction.name, value, instruction.mutable, instruction.annotation, instruction.span);
                        stack.push(value);
                        break;
                    }
                    case "DEFINE_FUNCTION": {
                        const declaration = instruction.declaration;
                        const closureEnvironment = current;
                        const callable = runtime.createFunction(
                            declaration.name,
                            declaration.parameters,
                            declaration.returnType,
                            declaration.body.span,
                            (values) => this.executeChunk(program, instruction.chunk, closureEnvironment, runtime, values),
                        );
                        current.define(declaration.name, callable, false, null, instruction.span);
                        break;
                    }
                    case "POP": stack.pop(); break;
                    case "DUP": stack.push(stack.at(-1)); break;
                    case "MAKE_LIST": {
                        const values = stack.splice(stack.length - instruction.count, instruction.count);
                        stack.push(values);
                        break;
                    }
                    case "UNARY": stack.push(runtime.unary(instruction.operator, stack.pop(), instruction.operandSpan, instruction.span)); break;
                    case "BINARY": {
                        const right = stack.pop();
                        const left = stack.pop();
                        stack.push(runtime.binary(instruction.operator, left, right, instruction.leftSpan, instruction.rightSpan, instruction.span));
                        break;
                    }
                    case "CHECK_BOOL": stack.push(runtime.requireBoolean(stack.pop(), instruction.span)); break;
                    case "GET_INDEX": {
                        const index = stack.pop();
                        const object = stack.pop();
                        stack.push(runtime.getIndex(object, index, instruction.span));
                        break;
                    }
                    case "PREPARE_ASSIGN": {
                        const binding = current.prepareAssignment(instruction.name, instruction.span);
                        stack.push({ kind: "binding-reference", binding });
                        break;
                    }
                    case "STORE_ASSIGN": {
                        const value = stack.pop();
                        const reference = stack.pop();
                        stack.push(current.assign(reference.binding, value, instruction.span));
                        break;
                    }
                    case "PREPARE_INDEX_ASSIGN": {
                        const index = stack.pop();
                        const object = stack.pop();
                        const key = runtime.validateIndex(object, index, instruction.span, true);
                        stack.push({ kind: "index-reference", object, index, key });
                        break;
                    }
                    case "STORE_INDEX": {
                        const value = stack.pop();
                        const reference = stack.pop();
                        runtime.validateIndex(reference.object, reference.index, instruction.span, true);
                        const contract = runtime.listElementContracts.get(reference.object);
                        if (contract) runtime.assertType(value, contract.annotation, "list element", instruction.span);
                        reference.object[reference.key] = value;
                        stack.push(value);
                        break;
                    }
                    case "CALL": {
                        const args = stack.splice(stack.length - instruction.count, instruction.count);
                        const callee = stack.pop();
                        stack.push(runtime.invoke(callee, args, instruction.span, instruction.calleeSpan));
                        break;
                    }
                    case "INTERPOLATE":
                        stack.push(runtime.interpolate(instruction.template, (name) => current.get(name, instruction.span), instruction.span));
                        break;
                    case "EXPR_ENTER": runtime.enterExpression(instruction.span); break;
                    case "EXPR_EXIT": runtime.leaveExpression(); break;
                    case "ENTER_SCOPE": {
                        const scope = new VmEnvironment(current, runtime);
                        frame.scopes.push(scope);
                        break;
                    }
                    case "EXIT_SCOPE":
                        if (frame.scopes.length <= 1) throw new Error("bytecode attempted to leave its function scope");
                        frame.scopes.pop();
                        break;
                    case "JUMP":
                        this.unwind(frame, instruction.scopeDepth);
                        frame.ip = instruction.target;
                        break;
                    case "UNWIND_JUMP":
                        this.unwind(frame, instruction.scopeDepth);
                        frame.ip = instruction.target;
                        break;
                    case "JUMP_IF_FALSE":
                        if (!stack.pop()) frame.ip = instruction.target;
                        break;
                    case "JUMP_IF_TRUE":
                        if (stack.pop()) frame.ip = instruction.target;
                        break;
                    case "ITER_START": {
                        const value = stack.pop();
                        frame.iterators.set(instruction.iterator, { values: runtime.iterate(value, instruction.span), index: 0 });
                        break;
                    }
                    case "ITER_NEXT": {
                        const iterator = frame.iterators.get(instruction.iterator);
                        if (!iterator) throw new Error("bytecode iterator was not initialized");
                        if (iterator.index >= iterator.values.length) {
                            frame.ip = instruction.target;
                        } else {
                            const iterationScope = new VmEnvironment(frame.scopes.at(-1), runtime);
                            iterationScope.define(instruction.name, iterator.values[iterator.index++], false, null, instruction.span);
                            frame.scopes.push(iterationScope);
                        }
                        break;
                    }
                    case "SET_RESULT": frame.result = stack.pop(); break;
                    case "RETURN": return stack.pop();
                    case "HALT": return frame.result;
                    default: throw new Error("unknown OMNI bytecode instruction: " + instruction.op);
                }
            }
            return frame.result;
        } catch (error) {
            if (chunkIndex === 0) runtime.expressionDepth = 0;
            throw error;
        }
    }

    unwind(frame, depth) {
        while (frame.scopes.length - 1 > depth) frame.scopes.pop();
    }

    exportBindings() {
        return new Map(this.bindings);
    }

    exportValues() {
        return new Map(this.values);
    }
}
