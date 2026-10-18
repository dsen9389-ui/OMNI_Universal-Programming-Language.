import { Interpreter } from "./interpreter.mjs";
import { BytecodeEngine } from "./bytecode-engine.mjs";
import { JavaScriptEngine } from "./javascript-engine.mjs";

const engines = new Map();

function registerEngine(engine) {
    if (engines.has(engine.name)) {
        throw new Error("duplicate OMNI engine registration: " + engine.name);
    }
    engines.set(engine.name, engine);
}

registerEngine({
    name: "interpreter",
    description: "Tree-walking reference interpreter",
    create(options = {}) {
        return new Interpreter(options);
    },
    run(program, context, options = {}) {
        return this.create(options).run(program, context);
    },
});

registerEngine({
    name: "bytecode",
    description: "Stack bytecode virtual machine for the portable core subset",
    create(options = {}) {
        return new BytecodeEngine(options);
    },
    run(program, context, options = {}) {
        return this.create(options).run(program, context);
    },
});

registerEngine({
    name: "javascript",
    description: "Compiler to JavaScript, executed by Node.js",
    create(options = {}) {
        return new JavaScriptEngine(options);
    },
    run(program, context, options = {}) {
        return this.create(options).run(program, context);
    },
});

export function availableEngines() {
    return [...engines.values()].map(({ name, description }) => ({ name, description }));
}

export function hasEngine(name) {
    return engines.has(name);
}

export function runWithEngine(name, program, context, options = {}) {
    const engine = engines.get(name);
    if (!engine) {
        throw new Error("execution engine '" + name + "' is not registered");
    }
    return engine.run(program, context, options);
}

export function createEngine(name, options = {}) {
    const engine = engines.get(name);
    if (!engine || typeof engine.create !== "function") {
        throw new Error("execution engine '" + name + "' cannot create a module instance");
    }
    return engine.create(options);
}
