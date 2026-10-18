import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fail } from "./diagnostics.mjs";
import { availableEngines, hasEngine } from "./engines.mjs";
import { defaultBuildProfile, getProfile } from "./profiles.mjs";

export const DEFAULT_PROJECT_CONFIG = Object.freeze({
    engines: Object.freeze({ development: "interpreter", release: "javascript" }),
    target: "host",
    buildTarget: null,
    runProfile: null,
    buildProfile: null,
});

export async function loadProjectConfig(entryPath) {
    let directory = dirname(resolve(entryPath));
    while (true) {
        const configPath = resolve(directory, "omni.toml");
        let source;
        try {
            source = await readFile(configPath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") {
                const parent = dirname(directory);
                if (parent === directory) return { ...DEFAULT_PROJECT_CONFIG, configPath: null, source: null };
                directory = parent;
                continue;
            }
            configError(configPath, "could not read project configuration", "", 1, 1);
        }
        const parsed = parseProjectConfig(source, configPath);
        for (const mode of ["development", "release"]) {
            const engine = parsed.engines[mode];
            if (!hasEngine(engine)) {
                const available = availableEngines().map(({ name }) => name).join(", ");
                configError(configPath, "engine '" + engine + "' for " + mode + " mode is not available; use one of: " + available, source, parsed.engineLines[mode], 1);
            }
        }
        if (parsed.target !== "host") {
            configError(configPath, "target '" + parsed.target + "' is not available in this phase; supported targets: host", source, parsed.targetLine, 1, "E3003");
        }
        if (parsed.buildTarget !== null && !["web", "embedded"].includes(parsed.buildTarget)) {
            configError(configPath, "build target '" + parsed.buildTarget + "' is not available; supported build targets: web, embedded", source, parsed.buildTargetLine, 1, "E3003");
        }
        if (parsed.runProfile) {
            const profile = getProfile(parsed.runProfile);
            if (profile.kind !== "run") configError(configPath, "profile '" + profile.id + "' is a build profile and cannot be used in [run]", source, parsed.profileLines.run, 1, "E3003");
            if (parsed.target !== profile.target) configError(configPath, "profile '" + profile.id + "' requires target '" + profile.target + "'", source, parsed.profileLines.run, 1, "E3003");
            for (const mode of ["development", "release"]) {
                if (!profile.engines.includes(parsed.engines[mode])) {
                    configError(configPath, "profile '" + profile.id + "' does not support engine '" + parsed.engines[mode] + "' for " + mode + " mode", source, parsed.engineLines[mode], 1, "E3003");
                }
            }
        }
        if (parsed.buildProfile) {
            const profile = getProfile(parsed.buildProfile);
            if (profile.kind !== "build") configError(configPath, "profile '" + profile.id + "' is a run profile and cannot be used in [build]", source, parsed.profileLines.build, 1, "E3003");
            if (parsed.buildTarget && parsed.buildTarget !== profile.target) {
                configError(configPath, "profile '" + profile.id + "' requires build target '" + profile.target + "'", source, parsed.profileLines.build, 1, "E3003");
            }
        }
        return {
            engines: parsed.engines,
            target: parsed.target,
            buildTarget: parsed.buildTarget,
            runProfile: parsed.runProfile,
            buildProfile: parsed.buildProfile,
            configPath,
            source,
        };
    }
}

export function resolveExecutionSelection(config, options, sourceName, sourceText) {
    const mode = options.mode ?? "development";
    const profileId = options.profile ?? config.runProfile ?? "core-v1";
    const profile = getProfile(profileId);
    if (!profile) {
        fail("E3006", "profile '" + profileId + "' is not available; use core-v1, web-v1, embedded-v1, or embedded-ffi-v1", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    if (profile.kind !== "run") {
        fail("E3003", "profile '" + profileId + "' is a build profile; choose the host profile 'core-v1' for omni run", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    const engine = options.engineSpecified ? options.engine : config.engines[mode];
    const target = options.target ?? config.target;
    if (!hasEngine(engine)) {
        const available = availableEngines().map(({ name }) => name).join(", ");
        fail("E3001", "engine '" + engine + "' is not available; use one of: " + available, { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    if (target !== "host") {
        fail("E3003", "target '" + target + "' is not available in this phase; supported targets: host", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    if (!profile.engines.includes(engine)) {
        fail("E3003", "profile '" + profileId + "' does not support engine '" + engine + "'; supported engines: " + profile.engines.join(", "), { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    return { mode, engine, target, profile: profileId };
}

export function resolveBuildSelection(config, options, sourceName, sourceText) {
    const profileId = options.profile ?? config.buildProfile;
    const selectedProfile = profileId ? getProfile(profileId) : null;
    if (profileId && !selectedProfile) {
        fail("E3006", "profile '" + profileId + "' is not available; use core-v1, web-v1, embedded-v1, or embedded-ffi-v1", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    const configuredTarget = options.profileSpecified || options.profile !== undefined
        ? selectedProfile?.target
        : config.buildTarget;
    const target = options.target ?? configuredTarget ?? selectedProfile?.target ?? null;
    if (!target) {
        fail("E3003", "build target is required; choose --target web or --target embedded, or set [build] target in omni.toml", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    const selected = selectedProfile ?? getProfile(defaultBuildProfile(target));
    if (!selected || selected.kind !== "build") {
        fail("E3003", "profile '" + (profileId ?? selected?.id ?? "") + "' cannot build a target; choose web-v1, embedded-v1, or embedded-ffi-v1", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    if (target !== selected.target) {
        fail("E3003", "profile '" + selected.id + "' requires the '" + selected.target + "' target, not '" + target + "'", { line: 1, column: 1, length: 1 }, sourceName, sourceText);
    }
    return { target, profile: selected.id, backend: selected.backend, cAbi: selected.cAbi };
}

export function resolveBuildTarget(config, options, sourceName, sourceText) {
    return resolveBuildSelection(config, options, sourceName, sourceText).target;
}

export function parseProjectConfig(source, sourceName = "omni.toml") {
    const engines = { ...DEFAULT_PROJECT_CONFIG.engines };
    let target = DEFAULT_PROJECT_CONFIG.target;
    let buildTarget = DEFAULT_PROJECT_CONFIG.buildTarget;
    let runProfile = DEFAULT_PROJECT_CONFIG.runProfile;
    let buildProfile = DEFAULT_PROJECT_CONFIG.buildProfile;
    const engineLines = { development: 1, release: 1 };
    let targetLine = 1;
    let buildTargetLine = 1;
    const profileLines = { run: 1, build: 1 };
    let section = "";
    const seenSections = new Set();
    const seen = new Set();
    const lines = source.split(/\r\n|\r|\n/u);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const uncommented = stripComment(line);
        const content = uncommented.trim();
        if (!content) continue;
        const lineNumber = index + 1;
        const baseColumn = uncommented.length - uncommented.trimStart().length + 1;
        const sectionMatch = /^\[([A-Za-z_][A-Za-z0-9_-]*)\]$/u.exec(content);
        if (sectionMatch) {
            section = sectionMatch[1];
            if (!["run", "build"].includes(section)) configError(sourceName, "only the [run] and [build] sections are supported", source, lineNumber, baseColumn);
            if (seenSections.has(section)) configError(sourceName, "the [" + section + "] section is declared more than once", source, lineNumber, baseColumn);
            seenSections.add(section);
            continue;
        }
        const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u.exec(content);
        if (!assignment) configError(sourceName, "expected a key = \"value\" setting", source, lineNumber, baseColumn);
        const [, key, rawValue] = assignment;
        if (!section) configError(sourceName, "settings must be inside the [run] or [build] section", source, lineNumber, baseColumn);
        const allowedKeys = section === "run" ? ["development", "release", "target", "profile"] : ["target", "profile"];
        if (!allowedKeys.includes(key)) {
            configError(sourceName, "unknown [" + section + "] setting '" + key + "'", source, lineNumber, baseColumn);
        }
        const settingKey = section + ":" + key;
        if (seen.has(settingKey)) configError(sourceName, "setting '" + key + "' is declared more than once", source, lineNumber, baseColumn);
        seen.add(settingKey);
        const equalsIndex = content.indexOf("=");
        const afterEquals = content.slice(equalsIndex + 1);
        const valueColumn = baseColumn + equalsIndex + 1 + (afterEquals.length - afterEquals.trimStart().length);
        let value;
        try {
            value = JSON.parse(rawValue);
        } catch {
            configError(sourceName, "setting '" + key + "' must be a quoted string", source, lineNumber, valueColumn);
        }
        if (typeof value !== "string" || !value) configError(sourceName, "setting '" + key + "' must be a non-empty quoted string", source, lineNumber, valueColumn);
        if (section === "build") {
            if (key === "target") {
                buildTarget = value;
                buildTargetLine = lineNumber;
            } else {
                buildProfile = value;
                profileLines.build = lineNumber;
            }
        } else if (key === "profile") {
            runProfile = value;
            profileLines.run = lineNumber;
        } else if (key === "target") {
            target = value;
            targetLine = lineNumber;
        } else {
            engines[key] = value;
            engineLines[key] = lineNumber;
        }
    }

    for (const [sectionName, id] of [["run", runProfile], ["build", buildProfile]]) {
        if (id !== null && !getProfile(id)) {
            configError(sourceName, "profile '" + id + "' is not available; use core-v1, web-v1, embedded-v1, or embedded-ffi-v1", source, profileLines[sectionName], 1, "E3006");
        }
    }

    return { engines, target, buildTarget, runProfile, buildProfile, engineLines, targetLine, buildTargetLine, profileLines };
}

function stripComment(line) {
    let inString = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (inString && escaped) {
            escaped = false;
        } else if (inString && character === "\\") {
            escaped = true;
        } else if (character === '"') {
            inString = !inString;
        } else if (character === "#" && !inString) {
            return line.slice(0, index);
        }
    }
    return line;
}

function configError(sourceName, message, source, line, column, code = "E3001") {
    const start = lineStart(source, line) + column - 1;
    fail(code, message, { start, end: start + 1, line, column, length: 1 }, sourceName, source);
}

function lineStart(source, lineNumber) {
    let line = 1;
    for (let index = 0; index < source.length; index += 1) {
        if (line === lineNumber) return index;
        if (source[index] === "\r" || source[index] === "\n") {
            if (source[index] === "\r" && source[index + 1] === "\n") index += 1;
            line += 1;
        }
    }
    return source.length;
}
