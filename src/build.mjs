import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileEmbeddedC } from "./embedded-c-compiler.mjs";
import { compileJavaScript } from "./portable-compiler.mjs";
import { fail } from "./diagnostics.mjs";
import { getProfile } from "./profiles.mjs";
import { ensureSafeDirectory, safeInstallFile, safeReadFile, safeWriteFile } from "./safe-filesystem.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const webRuntimeFiles = ["diagnostics.mjs", "lexer.mjs", "ir.mjs", "interpreter.mjs", "portable-runtime.mjs"];

export async function buildWeb(program, context, outDirectory, options = {}) {
    const compiled = compileJavaScript(program, context);
    const profileId = options.profile ?? "web-v1";
    const profile = getProfile(profileId);
    const outputDirectory = await ensureSafeDirectory(outDirectory);
    for (const file of webRuntimeFiles) {
        const runtimeSource = await readFile(join(projectRoot, "src", file));
        await safeWriteFile(outputDirectory, join("omni-runtime", file), runtimeSource);
    }

    const sourceName = basename(context.sourceName);
    await safeWriteFile(outputDirectory, "index.html", webPage(sourceName));
    await safeWriteFile(outputDirectory, "app.mjs", webModule(compiled, context));
    const artifacts = await hashArtifacts(outputDirectory, [
        "index.html",
        "app.mjs",
        ...webRuntimeFiles.map((file) => "omni-runtime/" + file),
    ]);
    await safeWriteFile(outputDirectory, "omni-build.json", JSON.stringify({
        manifestVersion: 1,
        toolchain: "OMNI 0.0.1-bootstrap",
        target: "web",
        profile: profileId,
        engine: "javascript",
        source: sourceName,
        capabilities: profile?.capabilities ?? [],
        entry: "index.html",
        artifacts,
    }, null, 2) + "\n");
    return { target: "web", outputDirectory, artifacts: ["index.html", "app.mjs", "omni-runtime/"] };
}

export async function buildEmbedded(program, context, outDirectory, options = {}) {
    const cSources = options.cSources ?? [];
    const profileId = options.profile ?? "embedded-v1";
    const profile = getProfile(profileId);
    const generated = compileEmbeddedC(program, context, { allowCAbi: profile?.cAbi !== null && profile?.cAbi !== undefined });
    const nativeSources = [];
    for (const sourcePath of cSources) {
        try {
            const source = await readFile(sourcePath);
            nativeSources.push({
                name: basename(sourcePath),
                sha256: createHash("sha256").update(source).digest("hex"),
            });
        } catch {
            fail("E3005", "could not read C source file '" + sourcePath + "'", { line: 1, column: 1, length: 1 }, context.sourceName, context.sourceText);
        }
    }
    outDirectory = await ensureSafeDirectory(outDirectory);
    const headerPath = join(outDirectory, "omni_platform.h");
    const firmwarePath = join(outDirectory, "firmware.c");
    const simulatorPath = join(outDirectory, "omni_platform_sim.c");
    const binaryPath = join(outDirectory, process.platform === "win32" ? "omni-firmware-sim.exe" : "omni-firmware-sim");
    await Promise.all([
        safeWriteFile(outDirectory, "omni_platform.h", generated.header),
        safeWriteFile(outDirectory, "firmware.c", generated.source),
        safeWriteFile(outDirectory, "omni_platform_sim.c", generated.simulator),
    ]);

    const usesAppleClang = process.platform === "darwin";
    const compiler = usesAppleClang
        ? await findAppleClangExecutable(context)
        : await findZigExecutable();
    const compilerName = usesAppleClang ? "Apple Clang" : "Zig's C compiler (zig cc)";
    const version = spawnSync(compiler, usesAppleClang ? ["--version"] : ["version"], { encoding: "utf8", windowsHide: true });
    if (version.error || version.status !== 0) {
        fail(
            "E3005",
            usesAppleClang
                ? "the embedded target on macOS needs Apple's Clang from Xcode Command Line Tools (xcrun clang); install the tools with xcode-select --install and retry"
                : "the embedded target needs Zig's C compiler (zig cc); install Zig from https://ziglang.org/download/ and retry",
            { line: 1, column: 1, length: 1 },
            context.sourceName,
            context.sourceText,
        );
    }
    const temporaryDirectory = await mkdtemp(join(outDirectory, ".omni-embedded-"));
    const temporaryBinaryPath = join(temporaryDirectory, process.platform === "win32" ? "simulator.exe" : "simulator");
    const compiled = spawnSync(compiler, [
        ...(usesAppleClang ? [] : ["cc"]),
        "-std=c11", "-O2", "-ffile-prefix-map=" + outDirectory + "=.", "-I", outDirectory,
        firmwarePath, simulatorPath, ...cSources, "-o", temporaryBinaryPath,
    ], { encoding: "utf8", windowsHide: true });
    if (compiled.error || compiled.status !== 0) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        const details = [compiled.stderr, compiled.stdout].filter(Boolean).join("\n").trim();
        fail(
            "E3005",
            compilerName + " could not build the embedded simulator" + (details ? ":\n" + details : ""),
            { line: 1, column: 1, length: 1 },
            context.sourceName,
            context.sourceText,
        );
    }
    if (process.platform === "win32") {
        try {
            await normalizeWindowsExecutable(temporaryBinaryPath);
        } catch {
            await rm(temporaryDirectory, { recursive: true, force: true });
            fail("E3005", "could not normalize Windows executable metadata for a repeatable build", { line: 1, column: 1, length: 1 }, context.sourceName, context.sourceText);
        }
    }
    const binaryName = binaryPath.split(/[\\/]/u).at(-1);
    try {
        await safeInstallFile(outDirectory, temporaryBinaryPath, binaryName);
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
    const artifacts = await hashArtifacts(outDirectory, ["firmware.c", "omni_platform.h", "omni_platform_sim.c", binaryName]);
    await safeWriteFile(outDirectory, "omni-build.json", JSON.stringify({
        manifestVersion: 1,
        toolchain: "OMNI 0.0.1-bootstrap",
        target: "embedded",
        profile: profileId,
        backend: "freestanding-c",
        cAbi: profile?.cAbi ?? null,
        compiler: usesAppleClang ? "Apple Clang (Xcode Command Line Tools)" : "zig cc",
        compilerVersion: [version.stdout, version.stderr].filter(Boolean).join("\n").trim().split(/\r?\n/u)[0],
        runtime: "included simulator adapter",
        source: basename(context.sourceName),
        nativeSources,
        capabilities: profile?.capabilities ?? [],
        firmware: "firmware.c",
        simulator: binaryName,
        artifacts,
    }, null, 2) + "\n");
    return {
        target: "embedded",
        outputDirectory: outDirectory,
        artifacts: ["firmware.c", "omni_platform.h", "omni_platform_sim.c", binaryName],
        executable: binaryPath,
    };
}

async function hashArtifacts(outputDirectory, names) {
    const artifacts = [];
    for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
        const bytes = await safeReadFile(outputDirectory, name);
        artifacts.push({ path: name.replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return artifacts;
}

async function normalizeWindowsExecutable(path) {
    const image = await readFile(path);
    const peOffset = image.readUInt32LE(0x3c);
    if (image.toString("ascii", 0, 2) !== "MZ" || image.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
        throw new Error("embedded simulator output is not a PE executable");
    }
    const sectionCount = image.readUInt16LE(peOffset + 6);
    const optionalSize = image.readUInt16LE(peOffset + 20);
    const optionalOffset = peOffset + 24;
    const magic = image.readUInt16LE(optionalOffset);
    const directoryOffset = magic === 0x20b ? optionalOffset + 112 : magic === 0x10b ? optionalOffset + 96 : null;
    if (directoryOffset === null) throw new Error("unsupported Windows executable format");

    image.writeUInt32LE(0, peOffset + 8);
    image.writeUInt32LE(0, optionalOffset + 64);
    const debugDirectory = directoryOffset + 6 * 8;
    const debugRva = image.readUInt32LE(debugDirectory);
    const debugSize = image.readUInt32LE(debugDirectory + 4);
    const sectionsOffset = optionalOffset + optionalSize;
    const rvaToOffset = (rva) => {
        for (let index = 0; index < sectionCount; index += 1) {
            const section = sectionsOffset + index * 40;
            const virtualSize = image.readUInt32LE(section + 8);
            const virtualAddress = image.readUInt32LE(section + 12);
            const rawSize = image.readUInt32LE(section + 16);
            const rawOffset = image.readUInt32LE(section + 20);
            const span = Math.max(virtualSize, rawSize);
            if (rva >= virtualAddress && rva < virtualAddress + span) return rawOffset + rva - virtualAddress;
        }
        throw new Error("could not locate Windows debug data");
    };

    if (debugRva !== 0 && debugSize > 0) {
        const debugOffset = rvaToOffset(debugRva);
        for (let offset = debugOffset; offset + 28 <= debugOffset + debugSize; offset += 28) {
            image.writeUInt32LE(0, offset + 4);
            const type = image.readUInt32LE(offset + 12);
            const size = image.readUInt32LE(offset + 16);
            const dataOffset = image.readUInt32LE(offset + 24);
            if (type === 2 && size >= 24 && image.toString("ascii", dataOffset, dataOffset + 4) === "RSDS") {
                image.fill(0, dataOffset + 4, dataOffset + 20);
            }
        }
    }
    image.writeUInt32LE(0, debugDirectory);
    image.writeUInt32LE(0, debugDirectory + 4);
    await writeFile(path, image);
}

async function findZigExecutable() {
    const candidates = [];
    if (process.env.OMNI_ZIG) candidates.push(resolve(process.env.OMNI_ZIG));
    if (process.platform === "win32") {
        const userLocalAppData = process.env.LOCALAPPDATA && !process.env.LOCALAPPDATA.includes("\\Packages\\sandbox.")
            ? process.env.LOCALAPPDATA
            : process.env.USERPROFILE
                ? join(process.env.USERPROFILE, "AppData", "Local")
                : null;
        if (userLocalAppData) candidates.push(join(userLocalAppData, "Microsoft", "WinGet", "Links", "zig.exe"));
        const packages = userLocalAppData ? join(userLocalAppData, "Microsoft", "WinGet", "Packages") : null;
        try {
            for (const packageName of packages ? await readdir(packages) : []) {
                if (!packageName.toLowerCase().startsWith("zig.zig_")) continue;
                const packageDirectory = join(packages, packageName);
                for (const versionDirectory of await readdir(packageDirectory)) {
                    if (versionDirectory.toLowerCase().startsWith("zig-")) {
                        candidates.push(join(packageDirectory, versionDirectory, "zig.exe"));
                    }
                }
            }
        } catch {
            // Fall through to PATH if the standard user package directory is absent.
        }
    }
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the next known installation location.
        }
    }
    return "zig";
}

async function findAppleClangExecutable(context) {
    const result = spawnSync("xcrun", ["--find", "clang"], { encoding: "utf8", windowsHide: true });
    const clangPath = result.stdout?.trim();
    if (result.error || result.status !== 0 || !clangPath) {
        const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
        fail(
            "E3005",
            "the embedded target on macOS needs Apple's Clang from Xcode Command Line Tools (xcrun clang); install the tools with xcode-select --install and retry" + (details ? ":\n" + details : ""),
            { line: 1, column: 1, length: 1 },
            context.sourceName,
            context.sourceText,
        );
    }
    return clangPath;
}

function webPage(sourceName) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>OMNI web app</title>
  <style>
    :root { font: 16px/1.5 system-ui, sans-serif; color-scheme: light dark; }
    body { max-width: 52rem; margin: 12vh auto; padding: 0 1.5rem; }
    .eyebrow { color: #4d8cff; font-size: .85rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: .4rem 0; font-size: clamp(2rem, 7vw, 4rem); }
    p { opacity: .72; }
    pre { min-height: 8rem; padding: 1rem 1.2rem; border: 1px solid #7776; border-radius: .8rem; background: #7771; white-space: pre-wrap; overflow-wrap: anywhere; }
    #omni-status[data-error="true"] { color: #e76868; }
  </style>
</head>
<body>
  <div class="eyebrow">Built with OMNI</div>
  <h1>One language. Many targets.</h1>
  <p>This browser app runs the same readable OMNI source used by the command-line tool.</p>
  <pre id="omni-output" aria-live="polite"></pre>
  <p id="omni-status" role="status">Starting ${escapeHtml(sourceName)}…</p>
  <script type="module" src="./app.mjs"></script>
</body>
</html>
`;
}

function webModule(compiled, context) {
    return `import { PortableRuntime } from "./omni-runtime/portable-runtime.mjs";
import { OmniDiagnostic, formatDiagnostic } from "./omni-runtime/diagnostics.mjs";

const context = ${JSON.stringify({ sourceName: basename(context.sourceName), sourceText: context.sourceText })};
const outputElement = document.getElementById("omni-output");
const statusElement = document.getElementById("omni-status");
const output = (text) => { outputElement.textContent += text; };

try {
    const __omni = new PortableRuntime(context, output);
    const execution = ${compiled};
    statusElement.textContent = "OMNI program finished.";
    statusElement.dataset.error = "false";
    void execution;
} catch (error) {
    if (error instanceof OmniDiagnostic) {
        statusElement.textContent = formatDiagnostic(error);
    } else {
        statusElement.textContent = "OMNI encountered an internal error: " + error.message;
    }
    statusElement.dataset.error = "true";
}
`;
}

function escapeHtml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
