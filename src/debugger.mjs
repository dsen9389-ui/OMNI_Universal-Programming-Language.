import { readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { checkProgram } from "./checker.mjs";
import { OmniDiagnostic } from "./diagnostics.mjs";
import { createSemanticProgram } from "./ir.mjs";
import { createModuleValue, createGlobalEnvironment, Interpreter, stringify } from "./interpreter.mjs";
import { loadModuleGraph } from "./modules.mjs";
import { validateProfileProgram } from "./profiles.mjs";
import { validateTargetEffects } from "./targets.mjs";

class DebuggerQuit extends Error {}

export async function debugProgram(entryPath, options = {}) {
    const graph = await loadModuleGraph(entryPath);
    for (const module of graph.modules) {
        const imports = new Map([...module.imports].map(([path, dependency]) => [path, dependency.interface]));
        module.interface = checkProgram(module.program, module.context, { imports });
        validateTargetEffects(module.program, module.context, "host");
        validateProfileProgram(module.program, module.context, "core-v1");
    }

    const breakpoints = new Map();
    let stopNext = true;
    let stopped = false;
    const inputFd = options.inputFd ?? 0;
    const output = options.output ?? ((text) => stdout.write(text));

    function onStatement({ statement, context, values }) {
        const pathKey = pathIdentity(context.sourceName);
        const lines = breakpoints.get(pathKey) ?? new Set();
        if (!stopNext && !lines.has(statement.span.line)) return;
        stopNext = false;
        stopped = true;
        output("\nPaused at " + context.sourceName + ":" + statement.span.line + ":" + statement.span.column + "\n");
        showSourceLine(context.sourceText, statement.span.line, statement.span.column, output);

        while (true) {
            output("omni-debug> ");
            const line = readLine(inputFd);
            if (line === null) throw new DebuggerQuit();
            const [command = "", ...parts] = line.trim().split(/\s+/u);
            const argument = parts.join(" ");
            if (["continue", "c"].includes(command)) return;
            if (["step", "s"].includes(command)) {
                stopNext = true;
                return;
            }
            if (["quit", "q"].includes(command)) throw new DebuggerQuit();
            if (["help", "h", "?"].includes(command)) {
                output("Commands: step, continue, break <line>, clear <line>, breakpoints, locals, print <name>, where, quit\n");
                continue;
            }
            if (["break", "b"].includes(command)) {
                const breakpoint = parseBreakpoint(argument, context.sourceName);
                if (!breakpoint) {
                    output("Use break <line> or break <file>:<line>.\n");
                    continue;
                }
                const key = pathIdentity(breakpoint.path);
                if (!breakpoints.has(key)) breakpoints.set(key, new Set());
                breakpoints.get(key).add(breakpoint.line);
                output("Breakpoint set at " + breakpoint.path + ":" + breakpoint.line + "\n");
                continue;
            }
            if (["clear", "cl"].includes(command)) {
                const lineNumber = Number(argument);
                if (!Number.isInteger(lineNumber) || lineNumber < 1) {
                    output("Use clear <line> for the current source file.\n");
                    continue;
                }
                lines.delete(lineNumber);
                output("Cleared breakpoint at " + context.sourceName + ":" + lineNumber + "\n");
                continue;
            }
            if (["breakpoints", "bs"].includes(command)) {
                const items = [...breakpoints].flatMap(([path, numbers]) => [...numbers].map((number) => path + ":" + number)).sort();
                output(items.length ? items.join("\n") + "\n" : "No breakpoints set.\n");
                continue;
            }
            if (["locals", "l"].includes(command)) {
                const items = [...values].sort(([left], [right]) => left.localeCompare(right));
                output(items.length ? items.map(([name, value]) => name + " = " + stringify(value)).join("\n") + "\n" : "No local values.\n");
                continue;
            }
            if (["print", "p"].includes(command)) {
                if (!values.has(argument)) output("Unknown visible value '" + argument + "'.\n");
                else output(argument + " = " + stringify(values.get(argument)) + "\n");
                continue;
            }
            if (["where", "w"].includes(command)) {
                showSourceLine(context.sourceText, statement.span.line, statement.span.column, output);
                continue;
            }
            if (command) output("Unknown debugger command. Enter 'help' to see commands.\n");
        }
    }

    try {
        for (const module of graph.modules) {
            const moduleImports = new Map([...module.importsByAlias].map(([alias, dependency]) => [
                alias,
                createModuleValue(basename(dependency.path), dependency.runtimeExports),
            ]));
            const context = { ...module.context, moduleImports };
            const interpreter = new Interpreter({
                environment: createGlobalEnvironment((text) => output(text)),
                onStatement,
            });
            const semanticProgram = createSemanticProgram(module.program, context, module.interface);
            interpreter.run(semanticProgram);
            module.runtimeExports = interpreter.exportBindings();
        }
    } catch (error) {
        if (!(error instanceof DebuggerQuit)) throw error;
        output("Debug session stopped.\n");
        return { stopped };
    }
    output("Program completed.\n");
    return { stopped };
}

function readLine(inputFd) {
    const bytes = [];
    const one = Buffer.allocUnsafe(1);
    while (true) {
        let count;
        try { count = readSync(inputFd, one, 0, 1, null); }
        catch { return null; }
        if (count === 0) return bytes.length ? Buffer.from(bytes).toString("utf8") : null;
        const byte = one[0];
        if (byte === 10) return Buffer.from(bytes).toString("utf8");
        if (byte !== 13) bytes.push(byte);
    }
}

function parseBreakpoint(argument, currentPath) {
    const text = argument.trim();
    const separator = text.lastIndexOf(":");
    const hasPath = separator > 0 && /^\d+$/u.test(text.slice(separator + 1));
    const path = hasPath ? resolve(dirname(currentPath), text.slice(0, separator)) : currentPath;
    const line = Number(hasPath ? text.slice(separator + 1) : text);
    if (!Number.isInteger(line) || line < 1) return null;
    return { path, line };
}

function showSourceLine(source, lineNumber, column, output) {
    const lines = source.split(/\r\n|\r|\n/u);
    const line = lines[lineNumber - 1] ?? "";
    output("  " + line + "\n");
    output("  " + " ".repeat(Math.max(0, column - 1)) + "^\n");
}

function pathIdentity(path) {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
