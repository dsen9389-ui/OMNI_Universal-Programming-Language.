import { Script } from "node:vm";
import { unwrapSemanticProgram } from "./ir.mjs";
import { PortableRuntime } from "./portable-runtime.mjs";
import { compileJavaScript } from "./portable-compiler.mjs";

export class JavaScriptEngine {
    constructor({ output } = {}) {
        this.output = output;
        this.bindings = new Map();
        this.values = new Map();
    }

    prepare(input, context = null) {
        const semantic = unwrapSemanticProgram(input, context);
        const source = compileJavaScript(semantic.program, semantic.context);
        return { kind: "JavaScriptExecutionPlan", semantic, script: new Script(source, { filename: semantic.context.sourceName }) };
    }

    run(input, context = null) {
        const plan = input?.kind === "JavaScriptExecutionPlan" ? input : this.prepare(input, context);
        const semantic = plan.semantic;
        const runtime = new PortableRuntime(semantic.context, this.output);
        const result = plan.script.runInNewContext({ __omni: runtime });
        this.bindings = new Map(result.exports.map(([name, binding]) => [name, binding]));
        this.values = new Map([...this.bindings].map(([name, binding]) => [name, binding.binding.value]));
        return result.value;
    }

    exportBindings() {
        return new Map(this.bindings);
    }

    exportValues() {
        return new Map(this.values);
    }
}
