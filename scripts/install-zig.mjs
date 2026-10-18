import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatTerminalText } from "../src/diagnostics.mjs";

const version = process.env.OMNI_ZIG_VERSION ?? "0.17.0";
const architecture = { x64: "x86_64", arm64: "aarch64" }[process.arch];
const operatingSystem = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];

async function main() {
    if (!architecture || !operatingSystem) throw new Error("Zig bootstrap does not support this host architecture");
    const indexResponse = await fetch("https://ziglang.org/download/index.json");
    if (!indexResponse.ok) throw new Error("Zig download index returned HTTP " + indexResponse.status);
    const index = await indexResponse.json();
    const release = index[version];
    if (!release) throw new Error("Zig release " + version + " is missing from the official download index");
    const asset = release[architecture + "-" + operatingSystem];
    if (!asset?.tarball || !asset?.shasum) throw new Error("the official Zig release has no binary for this host");

    const response = await fetch(asset.tarball);
    if (!response.ok) throw new Error("Zig download returned HTTP " + response.status);
    const archive = Buffer.from(await response.arrayBuffer());
    const actualHash = createHash("sha256").update(archive).digest("hex");
    if (actualHash !== asset.shasum) throw new Error("downloaded Zig archive does not match its published SHA-256 checksum");

    const temporaryRoot = process.env.RUNNER_TEMP ?? tmpdir();
    const extractionDirectory = await mkdtemp(join(temporaryRoot, "omni-zig-" + version + "-"));
    const archivePath = join(extractionDirectory, "zig-" + version + (operatingSystem === "windows" ? ".zip" : ".tar.xz"));
    await writeFile(archivePath, archive);
    if (operatingSystem === "windows") {
        const extracted = spawnSync("pwsh", [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "Expand-Archive -LiteralPath $env:OMNI_ZIG_ARCHIVE -DestinationPath $env:OMNI_ZIG_DESTINATION -Force",
        ], {
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, OMNI_ZIG_ARCHIVE: archivePath, OMNI_ZIG_DESTINATION: extractionDirectory },
        });
        if (extracted.error || extracted.status !== 0) throw new Error(extracted.stderr || "could not expand the Zig archive");
    } else {
        const extracted = spawnSync("tar", ["-xf", archivePath, "-C", extractionDirectory], { encoding: "utf8" });
        if (extracted.error || extracted.status !== 0) throw new Error(extracted.stderr || "could not expand the Zig archive");
    }

    const extractedDirectory = (await readdir(extractionDirectory, { withFileTypes: true }))
        .find((entry) => entry.isDirectory() && entry.name.startsWith("zig-" + architecture + "-" + operatingSystem + "-" + version));
    if (!extractedDirectory) throw new Error("the verified Zig archive did not contain its expected folder");
    const zigDirectory = join(extractionDirectory, extractedDirectory.name);
    const zigPath = join(zigDirectory, operatingSystem === "windows" ? "zig.exe" : "zig");
    if (operatingSystem !== "windows") await chmod(zigPath, 0o755);

    if (process.env.GITHUB_PATH) await writeFile(process.env.GITHUB_PATH, zigDirectory + "\n", { encoding: "utf8", flag: "a" });
    process.stdout.write("Installed checksum-verified Zig " + formatTerminalText(version) + " for " + architecture + "-" + operatingSystem + "\n");
}

main().catch((error) => {
    process.stderr.write("OMNI could not install the pinned Zig compiler: " + formatTerminalText(error.message) + "\n");
    process.exitCode = 1;
});
