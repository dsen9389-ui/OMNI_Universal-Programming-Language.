import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { formatTerminalText } from "../src/diagnostics.mjs";
import { checkProgram } from "../src/checker.mjs";
import { OmniDiagnostic } from "../src/diagnostics.mjs";
import { createEngine } from "../src/engines.mjs";
import { createSemanticProgram } from "../src/ir.mjs";
import { parseSource } from "../src/frontend.mjs";

async function main() {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const workloadPath = resolve(projectRoot, "benchmarks", "workloads", "engine-loop.om");
    const options = parseOptions(process.argv.slice(2));
    const source = await readFile(workloadPath, "utf8");
    const context = { sourceName: workloadPath, sourceText: source };
    const program = parseSource(source, workloadPath);
    const typeInterface = checkProgram(program, context);
    const semantic = createSemanticProgram(program, context, typeInterface);
    const engineNames = ["interpreter", "bytecode", "javascript"];
    const results = [];

    for (const name of engineNames) {
        const compileSamples = [];
        let plan = semantic;
        if (name !== "interpreter") {
            const compiler = createEngine(name, { output: () => {} });
            for (let index = 0; index < 3; index += 1) compiler.prepare(semantic);
            for (let index = 0; index < 9; index += 1) {
                const started = performance.now();
                plan = compiler.prepare(semantic);
                compileSamples.push(performance.now() - started);
            }
        }

        const execute = () => {
            const engine = createEngine(name, { output: () => {} });
            engine.run(plan);
        };
        for (let index = 0; index < options.warmups; index += 1) execute();
        const executionSamples = [];
        for (let index = 0; index < options.samples; index += 1) {
            const started = performance.now();
            execute();
            executionSamples.push(performance.now() - started);
        }
        results.push({
            engine: name,
            compileMedianMs: compileSamples.length ? round(median(compileSamples)) : null,
            executionMedianMs: round(median(executionSamples)),
            executionMadMs: round(median(executionSamples.map((value) => Math.abs(value - median(executionSamples))))),
        });
    }

    const report = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        workload: "engine-loop-v1",
        workloadSha256: createHash("sha256").update(source).digest("hex"),
        environment: {
            platform: process.platform,
            architecture: process.arch,
            node: process.versions.node,
            cpu: formatTerminalText(cpus()[0]?.model ?? "unknown"),
        },
        samples: options.samples,
        warmups: options.warmups,
        regressionThresholdPercent: 10,
        results,
    };

    if (options.comparePath) {
        let baseline;
        try {
            baseline = JSON.parse(await readFile(resolve(options.comparePath), "utf8"));
        } catch (error) {
            process.stderr.write("OMNI benchmark: could not read the comparison baseline: " + formatTerminalText(error.message) + "\n");
            process.exitCode = 2;
        }
        if (baseline !== undefined) {
            if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
                process.stderr.write("OMNI benchmark: comparison baseline must be a JSON object.\n");
                process.exitCode = 2;
            } else if (baseline.schemaVersion !== report.schemaVersion || baseline.workloadSha256 !== report.workloadSha256 ||
                JSON.stringify(baseline.environment) !== JSON.stringify(report.environment)) {
                process.stderr.write("OMNI benchmark: baseline must match workload, OS, architecture, Node version, and CPU.\n");
                process.exitCode = 2;
            } else {
                const baselineByEngine = new Map(baseline.results.map((result) => [result.engine, result]));
                for (const result of results) {
                    const previous = baselineByEngine.get(result.engine);
                    if (!previous || result.executionMedianMs > previous.executionMedianMs * (1 + report.regressionThresholdPercent / 100)) {
                        process.stderr.write("OMNI benchmark: " + result.engine + " execution median exceeds the 10% regression threshold.\n");
                        process.exitCode = 1;
                    }
                }
            }
        }
    }

    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error) => {
    process.stderr.write("OMNI benchmark: " + formatTerminalText(error.message) + "\n");
    process.exitCode = 2;
});

function parseOptions(args) {
    const options = { samples: 20, warmups: 4, comparePath: null };
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--samples") options.samples = positiveInteger(args[++index], "--samples");
        else if (args[index] === "--warmups") options.warmups = nonNegativeInteger(args[++index], "--warmups");
        else if (args[index] === "--compare") options.comparePath = args[++index];
        else throw new Error("unknown benchmark option '" + formatTerminalText(args[index]) + "'");
    }
    return options;
}

function positiveInteger(value, option) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(option + " needs a positive whole number");
    return parsed;
}

function nonNegativeInteger(value, option) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(option + " needs a non-negative whole number");
    return parsed;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value) {
    return Math.round(value * 100) / 100;
}
