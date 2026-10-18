import { fail } from "./diagnostics.mjs";

const profileDefinitions = [
    {
        id: "core-v1",
        version: 1,
        kind: "run",
        target: "host",
        engines: ["interpreter", "bytecode", "javascript"],
        backend: "selected-engine",
        runtime: "node",
        safety: "static-types-and-runtime-contracts",
        standardLibrary: "core-v1",
        capabilities: ["output"],
        cAbi: null,
        summary: "Host programs with the full interpreter or the portable compiler engines.",
    },
    {
        id: "web-v1",
        version: 1,
        kind: "build",
        target: "web",
        engines: [],
        backend: "javascript",
        runtime: "browser",
        safety: "static-types-and-runtime-contracts",
        standardLibrary: "core-plus-web-output-v1",
        capabilities: ["output"],
        cAbi: null,
        summary: "Browser applications compiled from the portable JavaScript subset.",
    },
    {
        id: "embedded-v1",
        version: 1,
        kind: "build",
        target: "embedded",
        engines: [],
        backend: "freestanding-c",
        runtime: "freestanding",
        safety: "static-scalar-checks-and-checked-arithmetic",
        standardLibrary: "core-plus-embedded-io-v1",
        capabilities: ["output", "serial", "gpio"],
        cAbi: null,
        summary: "Freestanding scalar programs with serial and GPIO platform hooks.",
    },
    {
        id: "embedded-ffi-v1",
        version: 1,
        kind: "build",
        target: "embedded",
        engines: [],
        backend: "freestanding-c",
        runtime: "freestanding",
        safety: "checked-scalar-core-with-explicit-unsafe-c-abi",
        standardLibrary: "core-plus-embedded-io-and-c-abi-v1",
        capabilities: ["output", "serial", "gpio", "c-abi"],
        cAbi: "c-int32-float64-bool-v1",
        summary: "The embedded profile with an explicit, scalar-only C ABI boundary.",
    },
];

const profiles = new Map(profileDefinitions.map((profile) => [
    profile.id,
    Object.freeze({
        ...profile,
        engines: Object.freeze([...profile.engines]),
        capabilities: Object.freeze([...profile.capabilities]),
    }),
]));

export function getProfile(id) {
    return profiles.get(id) ?? null;
}

export function availableProfiles() {
    return [...profiles.values()];
}

export function defaultBuildProfile(target) {
    if (target === "web") return "web-v1";
    if (target === "embedded") return "embedded-v1";
    return null;
}


export function validateProfileProgram(program, context, profileId, options = {}) {
    const profile = getProfile(profileId);
    const declarations = program.declarations.filter((declaration) => declaration.kind === "ExternalFunctionDeclaration");
    const cSources = options.cSources ?? [];
    if (declarations.length && !profile?.cAbi) {
        fail("E3002", "C ABI declarations require the 'embedded-ffi-v1' profile", declarations[0].span, context.sourceName, context.sourceText);
    }
    if (cSources.length && !declarations.length) {
        fail("E3002", "--c-source needs at least one extern fn declaration in the OMNI source", { line: 1, column: 1, length: 1 }, context.sourceName, context.sourceText);
    }
    if (declarations.length && cSources.length === 0) {
        fail("E3005", "this C ABI declaration needs a user C source file; pass --c-source file.c", declarations[0].span, context.sourceName, context.sourceText);
    }
}
