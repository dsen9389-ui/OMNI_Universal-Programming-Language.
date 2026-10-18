#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { formatDiagnostic, formatTerminalText, OmniDiagnostic } from "../src/diagnostics.mjs";
import { checkProgram } from "../src/checker.mjs";
import { availableEngines, createEngine, hasEngine } from "../src/engines.mjs";
import { createSemanticProgram } from "../src/ir.mjs";
import { loadProjectConfig, resolveBuildSelection, resolveExecutionSelection } from "../src/config.mjs";
import { parseSource } from "../src/frontend.mjs";
import { createModuleValue, createGlobalEnvironment, Interpreter, stringify } from "../src/interpreter.mjs";
import { loadModuleGraph } from "../src/modules.mjs";
import { buildEmbedded, buildWeb } from "../src/build.mjs";
import { validateTargetEffects } from "../src/targets.mjs";
import { serveWebDirectory } from "../src/web-server.mjs";
import { availableProfiles, validateProfileProgram } from "../src/profiles.mjs";
import { formatOmni } from "../src/formatter.mjs";
import { runTestSuite } from "../src/test-runner.mjs";
import { runLanguageServer } from "../src/language-server.mjs";
import { debugProgram } from "../src/debugger.mjs";

const VERSION = "0.0.1-bootstrap";
const HELP = [
    "OMNI " + VERSION,
    "",
    "Usage:",
    "  omni run <file.om> [--mode development|release] [--engine interpreter|bytecode|javascript] [--profile core-v1] [--target host]",
    "  omni check <file.om>   Check syntax and types without executing",
    "  omni fmt <file.om> [--check]  Format one OMNI source file",
    "  omni test [directory] [--engine name] [--update]  Run output-snapshot tests",
    "  omni lsp              Start the OMNI editor language server over stdio",
    "  omni debug <file.om>  Run the reference interpreter with source stepping",
    "  omni build <file.om> [--profile web-v1|embedded-v1|embedded-ffi-v1] [--target web|embedded] [--c-source file.c] [--out-dir directory] [--verify-reproducible]",
    "  omni serve <directory> [--port number]  Preview a web build on localhost",
    "  omni profiles          List the versioned, supported profiles",
    "  omni repl              Start the one-line interactive interpreter",
    "  omni help              Show this help",
    "  omni version           Show the version",
    "",
    "If the first argument is a .om file, it is treated as omni run <file.om>.",
    "",
    "Examples:",
    "  node ./bin/omni.mjs run ./examples/hello.om",
    "  node ./bin/omni.mjs run ./examples/hello.om --engine interpreter",
    "  node ./bin/omni.mjs run ./examples/hello.om --mode release",
    "  node ./bin/omni.mjs run ./examples/hello.om --engine bytecode --target host",
    "  node ./bin/omni.mjs check ./examples/fibonacci.om",
    "  node ./bin/omni.mjs fmt ./examples/hello.om --check",
    "  node ./bin/omni.mjs build ./examples/web-app.om --target web",
    "  node ./bin/omni.mjs build ./examples/c-interop.om --profile embedded-ffi-v1 --c-source ./examples/c-interop.c",
    "  node ./bin/omni.mjs serve ./build/web",
    "  node ./bin/omni.mjs build ./examples/embedded-led.om --target embedded",
    "",
].join("\n");

async function main(args) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (![22, 24].includes(nodeMajor)) {
        process.stderr.write("OMNI supports the Node.js 22 and 24 LTS lines; found " + process.versions.node + ".\n");
        return 2;
    }

    let command = args[0] ?? "help";
    let rest = args.slice(1);
    if (["--help", "-h"].includes(command)) command = "help";
    if (["--version", "-v"].includes(command)) command = "version";
    if (command.endsWith(".om")) {
        rest = [command, ...rest];
        command = "run";
    }

    if (command === "help") {
        stdout.write(HELP);
        return 0;
    }
    if (command === "version") {
        stdout.write("OMNI " + VERSION + "\n");
        return 0;
    }
    if (command === "profiles") {
        if (rest.length > 0) return usageError("profiles does not take arguments");
        for (const profile of availableProfiles()) {
            stdout.write(profile.id + "\t" + profile.kind + " " + profile.target + "\t" + profile.summary + "\n");
        }
        return 0;
    }
    if (command === "repl") {
        if (rest.length > 0) return usageError("repl does not take a file path");
        return runRepl();
    }
    if (command === "lsp") {
        if (rest.length > 0) return usageError("lsp does not take arguments");
        await runLanguageServer();
        return 0;
    }
    if (command === "debug") {
        if (rest.length !== 1 || !rest[0].toLowerCase().endsWith(".om")) return usageError("debug expects exactly one .om file path");
        try {
            await debugProgram(resolve(rest[0]));
            return 0;
        } catch (error) {
            if (error instanceof OmniDiagnostic) return reportError(error);
            process.stderr.write("OMNI could not debug the program: " + formatTerminalText(error.message) + "\n");
            return 2;
        }
    }
    if (command === "serve") {
        const serveOptions = readServeOptions(rest);
        if (serveOptions.error) return usageError(serveOptions.error);
        try {
            const server = await serveWebDirectory(serveOptions.directory, serveOptions.port);
            stdout.write("OMNI web app available at http://127.0.0.1:" + serveOptions.port + "/\nPress Ctrl+C to stop.\n");
            await new Promise((resolveClosed) => server.once("close", resolveClosed));
            return 0;
        } catch (error) {
            process.stderr.write("OMNI could not start the web preview: " + formatTerminalText(error.message) + "\n");
            return 2;
        }
    }
    if (command === "fmt") {
        const formatOptions = readFormatOptions(rest);
        if (formatOptions.error) return usageError(formatOptions.error);
        if (formatOptions.positionals.length !== 1) return usageError("fmt expects exactly one .om file path");
        const filePath = resolve(formatOptions.positionals[0]);
        if (!filePath.toLowerCase().endsWith(".om")) return usageError("fmt only accepts an .om source file");
        try {
            const source = await readFile(filePath, "utf8");
            const formatted = formatOmni(source, filePath);
            if (formatted === source) {
                stdout.write("OMNI format OK: " + formatTerminalText(filePath) + "\n");
                return 0;
            }
            if (formatOptions.check) {
                stdout.write("OMNI formatting needed: " + formatTerminalText(filePath) + "\n");
                return 1;
            }
            const temporaryPath = filePath + ".omni-format-" + process.pid;
            try {
                await writeFile(temporaryPath, formatted, { encoding: "utf8", flag: "wx" });
                await rename(temporaryPath, filePath);
            } catch (error) {
                try { await unlink(temporaryPath); } catch { /* No temporary file remains. */ }
                throw error;
            }
            stdout.write("OMNI formatted: " + formatTerminalText(filePath) + "\n");
            return 0;
        } catch (error) {
            if (error instanceof OmniDiagnostic) return reportError(error);
            process.stderr.write("OMNI could not format '" + formatTerminalText(filePath) + "': " + formatTerminalText(error.message) + "\n");
            return 2;
        }
    }
    if (command === "test") {
        const testOptions = readTestOptions(rest);
        if (testOptions.error) return usageError(testOptions.error);
        const testDirectory = resolve(testOptions.directory ?? "tests");
        try {
            const suite = await runTestSuite(testDirectory, testOptions);
            if (suite.results.length === 0) {
                process.stderr.write("OMNI test: no *.test.om files found in '" + formatTerminalText(testDirectory) + "'\n");
                return 2;
            }
            for (const result of suite.results) {
                if (result.status === "passed") stdout.write("PASS  " + formatTerminalText(result.name) + "\n");
                else if (result.status === "updated") stdout.write("UPDATED  " + formatTerminalText(result.name) + "\n");
                else {
                    process.stderr.write("FAIL  " + formatTerminalText(result.name) + ": " + formatTerminalText(result.message) + "\n");
                    if (result.stderr) process.stderr.write(formatTerminalText(result.stderr));
                }
            }
            stdout.write("OMNI test: " + suite.passed + " passed, " + suite.failed + " failed");
            if (testOptions.update) stdout.write(", " + suite.updated + " snapshots updated");
            stdout.write("\n");
            return suite.failed === 0 ? 0 : 1;
        } catch (error) {
            process.stderr.write("OMNI could not run tests in '" + formatTerminalText(testDirectory) + "': " + formatTerminalText(error.message) + "\n");
            return 2;
        }
    }
    if (command !== "run" && command !== "check" && command !== "build") {
        return usageError("unknown command '" + command + "'");
    }

    const parsedOptions = command === "build" ? readBuildOptions(rest) : readRunOptions(rest);
    if (parsedOptions.error) return usageError(parsedOptions.error);
    rest = parsedOptions.positionals;
    if (command === "check" && (parsedOptions.engineSpecified || parsedOptions.modeSpecified || parsedOptions.targetSpecified || parsedOptions.profileSpecified)) {
        return usageError("--mode, --engine, --target, and --profile apply to run or build; check only parses source");
    }
    if (command === "run" && parsedOptions.engineSpecified && !hasEngine(parsedOptions.engine)) {
        const names = availableEngines().map((engine) => engine.name).join(", ");
        return usageError("engine '" + parsedOptions.engine + "' is not available in this phase; available engines: " + names);
    }
    if (command === "run" && !["development", "release"].includes(parsedOptions.mode)) {
        return usageError("mode must be 'development' or 'release'");
    }
    if (rest.length !== 1) {
        return usageError(command + " expects exactly one .om file path");
    }

    const filePath = resolve(rest[0]);
    try {
        const config = await loadProjectConfig(filePath);
        const selection = command === "run"
            ? resolveExecutionSelection(config, parsedOptions, "<command line>", undefined)
            : null;
        const graph = await loadModuleGraph(filePath);
        for (const module of graph.modules) {
            const imports = new Map([...module.imports].map(([path, dependency]) => [path, dependency.interface]));
            module.interface = checkProgram(module.program, module.context, { imports });
        }
        if (command === "check") {
            stdout.write("OMNI check OK: " + formatTerminalText(filePath) + "\n");
            return 0;
        }
        if (command === "build") {
            const selection = resolveBuildSelection(config, parsedOptions, graph.entry.context.sourceName, graph.entry.context.sourceText);
            const target = selection.target;
            for (const module of graph.modules) validateTargetEffects(module.program, module.context, target);
            const cSources = parsedOptions.cSources.map((source) => resolve(source));
            validateProfileProgram(graph.entry.program, graph.entry.context, selection.profile, { cSources });
            const outDirectory = parsedOptions.outDir
                ? resolve(parsedOptions.outDir)
                : resolve(dirname(filePath), "build", target);
            const artifact = target === "web"
                ? await buildWeb(graph.entry.program, graph.entry.context, outDirectory, { profile: selection.profile })
                : await buildEmbedded(graph.entry.program, graph.entry.context, outDirectory, { cSources, profile: selection.profile });
            if (parsedOptions.verifyReproducible) {
                const verificationRoot = await mkdtemp(join(outDirectory, ".omni-repro-"));
                try {
                    const verificationDirectory = join(verificationRoot, "build");
                    if (target === "web") await buildWeb(graph.entry.program, graph.entry.context, verificationDirectory, { profile: selection.profile });
                    else await buildEmbedded(graph.entry.program, graph.entry.context, verificationDirectory, { cSources, profile: selection.profile });
                    const primary = JSON.parse(await readFile(join(outDirectory, "omni-build.json"), "utf8"));
                    const verification = JSON.parse(await readFile(join(verificationDirectory, "omni-build.json"), "utf8"));
                    if (JSON.stringify(primary) !== JSON.stringify(verification)) {
                        throw new Error("artifact manifests differ between two clean builds");
                    }
                    stdout.write("Repeatable build verified: artifact hashes matched across two clean builds.\n");
                } finally {
                    await rm(verificationRoot, { recursive: true, force: true });
                }
            }
            stdout.write("OMNI build OK (" + target + ", profile " + selection.profile + "): " + formatTerminalText(artifact.outputDirectory) + "\n");
            stdout.write("Created: " + formatTerminalText(artifact.artifacts.join(", ")) + "\n");
            return 0;
        }
        for (const module of graph.modules) validateTargetEffects(module.program, module.context, selection.target);
        for (const module of graph.modules) validateProfileProgram(module.program, module.context, selection.profile);
        if (selection.engine !== "interpreter") {
            for (const module of graph.modules) {
                const engine = createEngine(selection.engine);
                const semanticProgram = createSemanticProgram(module.program, module.context, module.interface);
                module.executionEngine = engine;
                module.executionPlan = engine.prepare(semanticProgram);
            }
        }
        for (const module of graph.modules) {
            const moduleImports = new Map([...module.importsByAlias].map(([alias, dependency]) => [
                alias,
                createModuleValue(dependency.path, dependency.runtimeExports),
            ]));
            const executionContext = { ...module.context, moduleImports };
            const engine = module.executionEngine ?? createEngine(selection.engine);
            const semanticProgram = createSemanticProgram(module.program, executionContext, module.interface);
            engine.run(module.executionPlan ?? semanticProgram);
            module.runtimeExports = engine.exportBindings();
        }
        return 0;
    } catch (error) {
        if (!(error instanceof OmniDiagnostic) && error.message.startsWith("could not read source file:")) {
            process.stderr.write("OMNI " + formatTerminalText(error.message) + "\n");
            return 2;
        }
        return reportError(error);
    }
}

function readFormatOptions(args) {
    const result = { check: false, positionals: [], error: null };
    for (const argument of args) {
        if (argument === "--check") result.check = true;
        else if (argument.startsWith("-")) {
            result.error = "unknown option '" + argument + "'";
            return result;
        } else result.positionals.push(argument);
    }
    return result;
}

function readTestOptions(args) {
    const result = { directory: null, engine: null, update: false, error: null };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--update") result.update = true;
        else if (argument === "--engine") {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = "--engine needs a value";
                return result;
            }
            result.engine = next;
            index += 1;
        } else if (argument.startsWith("--engine=")) {
            result.engine = argument.slice("--engine=".length);
            if (!result.engine) result.error = "--engine needs a value";
        } else if (argument.startsWith("-")) {
            result.error = "unknown option '" + argument + "'";
            return result;
        } else if (result.directory === null) result.directory = argument;
        else {
            result.error = "test expects at most one directory path";
            return result;
        }
    }
    return result;
}

function readBuildOptions(args) {
    const result = {
        target: null,
        targetSpecified: false,
        profile: null,
        profileSpecified: false,
        outDir: null,
        outDirSpecified: false,
        cSources: [],
        verifyReproducible: false,
        positionals: [],
        error: null,
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--verify-reproducible") {
            result.verifyReproducible = true;
            continue;
        }
        if (["--target", "--profile", "--out-dir", "--c-source"].includes(argument)) {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = argument + " needs a value";
                return result;
            }
            if (argument === "--target") {
                result.target = next;
                result.targetSpecified = true;
            } else if (argument === "--profile") {
                result.profile = next;
                result.profileSpecified = true;
            } else if (argument === "--c-source") {
                result.cSources.push(next);
            } else {
                result.outDir = next;
                result.outDirSpecified = true;
            }
            index += 1;
        } else if (argument.startsWith("--target=")) {
            result.target = argument.slice("--target=".length);
            result.targetSpecified = true;
            if (!result.target) result.error = "--target needs a value";
        } else if (argument.startsWith("--profile=")) {
            result.profile = argument.slice("--profile=".length);
            result.profileSpecified = true;
            if (!result.profile) result.error = "--profile needs a value";
        } else if (argument.startsWith("--c-source=")) {
            const cSource = argument.slice("--c-source=".length);
            if (!cSource) result.error = "--c-source needs a value";
            else result.cSources.push(cSource);
        } else if (argument.startsWith("--out-dir=")) {
            result.outDir = argument.slice("--out-dir=".length);
            result.outDirSpecified = true;
            if (!result.outDir) result.error = "--out-dir needs a value";
        } else if (argument.startsWith("-")) {
            result.error = "unknown option '" + argument + "'";
            return result;
        } else {
            result.positionals.push(argument);
        }
    }
    return result;
}

function readServeOptions(args) {
    const result = { directory: null, port: 4173, error: null };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--port") {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = "--port needs a value";
                return result;
            }
            result.port = Number(next);
            index += 1;
        } else if (argument.startsWith("--port=")) {
            result.port = Number(argument.slice("--port=".length));
        } else if (argument.startsWith("-")) {
            result.error = "unknown option '" + argument + "'";
            return result;
        } else if (result.directory === null) {
            result.directory = argument;
        } else {
            result.error = "serve expects one directory path";
            return result;
        }
    }
    if (!result.directory) result.error = "serve expects a directory path";
    else if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) result.error = "port must be a whole number from 1 to 65535";
    return result;
}

function readRunOptions(args) {
    const result = {
        engine: null,
        engineSpecified: false,
        profile: null,
        profileSpecified: false,
        mode: "development",
        modeSpecified: false,
        target: null,
        targetSpecified: false,
        positionals: [],
        error: null,
    };

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--engine") {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = "--engine needs a value";
                return result;
            }
            result.engine = next;
            result.engineSpecified = true;
            index += 1;
        } else if (argument.startsWith("--engine=")) {
            result.engine = argument.slice("--engine=".length);
            if (!result.engine) {
                result.error = "--engine needs a value";
                return result;
            }
            result.engineSpecified = true;
        } else if (argument === "--profile") {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = "--profile needs a value";
                return result;
            }
            result.profile = next;
            result.profileSpecified = true;
            index += 1;
        } else if (argument.startsWith("--profile=")) {
            result.profile = argument.slice("--profile=".length);
            if (!result.profile) {
                result.error = "--profile needs a value";
                return result;
            }
            result.profileSpecified = true;
        } else if (argument === "--mode") {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = argument + " needs a value";
                return result;
            }
            result.mode = next;
            result.modeSpecified = true;
            index += 1;
        } else if (argument.startsWith("--mode=")) {
            result.mode = argument.slice("--mode=".length);
            if (!result.mode) {
                result.error = "--mode needs a value";
                return result;
            }
            result.modeSpecified = true;
        } else if (argument === "--target") {
            const next = args[index + 1];
            if (!next || next.startsWith("--")) {
                result.error = "--target needs a value";
                return result;
            }
            result.target = next;
            result.targetSpecified = true;
            index += 1;
        } else if (argument.startsWith("--target=")) {
            result.target = argument.slice("--target=".length);
            if (!result.target) {
                result.error = "--target needs a value";
                return result;
            }
            result.targetSpecified = true;
        } else if (argument.startsWith("-")) {
            result.error = "unknown option '" + argument + "'";
            return result;
        } else {
            result.positionals.push(argument);
        }
    }
    return result;
}

async function runRepl() {
    const terminal = stdin.isTTY && stdout.isTTY;
    const repl = createInterface({
        input: stdin,
        output: stdout,
        prompt: "omni> ",
        terminal,
    });
    const environment = createGlobalEnvironment();
    const interpreter = new Interpreter({ environment });
    if (!terminal) stdout.write("OMNI one-line REPL. Enter :quit to exit.\n");

    try {
        if (terminal) repl.prompt();
        for await (const line of repl) {
            const input = line.trim();
            if (input === ":quit" || input === ":q") break;
            if (input === ":help") {
                stdout.write("Enter one OMNI statement or expression per line. Commands: :help, :quit.\n");
            } else if (input.length > 0) {
                try {
                    const program = parseSource(line, "<repl>");
                    const context = { sourceName: "<repl>", sourceText: line };
                    checkProgram(program, context);
                    const result = interpreter.run(program, context);
                    if (program.declarations.length === 1 &&
                        program.declarations[0].kind === "ExpressionStatement" &&
                        result !== null) {
                        stdout.write("=> " + stringify(result) + "\n");
                    }
                } catch (error) {
                    reportError(error);
                }
            }
            if (terminal) repl.prompt();
        }
    } finally {
        repl.close();
    }
    return 0;
}

function usageError(message) {
    process.stderr.write("OMNI: " + formatTerminalText(message) + "\nRun omni help for usage.\n");
    return 2;
}

function reportError(error) {
    if (error instanceof OmniDiagnostic) {
        process.stderr.write(formatDiagnostic(error) + "\n");
    } else {
        process.stderr.write("OMNI encountered an internal error: " + formatTerminalText(error.message) + "\n");
    }
    return 1;
}

process.exitCode = await main(process.argv.slice(2));
