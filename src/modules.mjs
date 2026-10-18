import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fail } from "./diagnostics.mjs";
import { parseSource } from "./frontend.mjs";
import { decodeLiteralString, hasInterpolation } from "./lexer.mjs";

export async function loadModuleGraph(entryPath, options = {}) {
    const modules = [];
    const byPath = new Map();
    const active = [];
    const sourceOverrides = new Map();
    for (const [path, source] of options.sourceOverrides ?? []) {
        let absolutePath = resolve(path);
        try { absolutePath = await realpath(absolutePath); } catch { /* Keep the resolved path for unsaved files. */ }
        sourceOverrides.set(pathIdentity(absolutePath), source);
    }

    async function visit(filePath, from = null, importDeclaration = null) {
        let canonicalPath;
        try {
            canonicalPath = await realpath(filePath);
        } catch {
            if (from && importDeclaration) {
                moduleError(from, "E2050", "could not read imported module '" + importDeclaration.path + "'", importDeclaration.pathSpan);
            }
            throw new Error("could not read source file: " + filePath);
        }

        if (from && importDeclaration && extname(canonicalPath) !== ".om") {
            moduleError(from, "E2050", "imported module target must end in '.om'", importDeclaration.pathSpan);
        }

        const identity = pathIdentity(canonicalPath);
        const cycleAt = active.findIndex((item) => item.identity === identity);
        if (cycleAt !== -1) {
            const chain = [...active.slice(cycleAt).map((item) => item.path), canonicalPath].join(" -> ");
            moduleError(from, "E2051", "cyclic imports are not allowed (" + chain + ")", importDeclaration?.pathSpan);
        }
        if (byPath.has(identity)) return byPath.get(identity);

        let source = sourceOverrides.get(identity);
        try {
            if (source === undefined) source = await readFile(canonicalPath, "utf8");
        } catch {
            if (from && importDeclaration) {
                moduleError(from, "E2050", "could not read imported module '" + importDeclaration.path + "'", importDeclaration.pathSpan);
            }
            throw new Error("could not read source file: " + canonicalPath);
        }

        const module = {
            path: canonicalPath,
            source,
            context: { sourceName: canonicalPath, sourceText: source },
            program: parseSource(source, canonicalPath),
            imports: new Map(),
            importsByAlias: new Map(),
            interface: null,
        };
        byPath.set(identity, module);
        active.push({ identity, path: canonicalPath });

        for (const declaration of module.program.declarations) {
            if (declaration.kind !== "ImportDeclaration") continue;
            if (hasInterpolation(declaration.path)) {
                moduleError(module, "E2050", "module paths cannot contain string interpolation", declaration.pathSpan);
            }
            const importedPath = decodeLiteralString(declaration.path);
            declaration.path = importedPath;
            if (isAbsolute(importedPath) || !(importedPath.startsWith("./") || importedPath.startsWith("../"))) {
                moduleError(module, "E2050", "imports must use a relative path beginning with './' or '../'", declaration.pathSpan);
            }
            if (extname(importedPath) !== ".om") {
                moduleError(module, "E2050", "imported module paths must end in '.om'", declaration.pathSpan);
            }
            const dependencyPath = resolve(dirname(canonicalPath), importedPath);
            const dependency = await visit(dependencyPath, module, declaration);
            module.imports.set(importedPath, dependency);
            module.importsByAlias.set(declaration.alias, dependency);
        }

        active.pop();
        modules.push(module);
        return module;
    }

    const entry = await visit(resolve(entryPath));
    return { entry, modules, byPath };
}

function pathIdentity(path) {
    return process.platform === "win32" ? path.toLowerCase() : path;
}

function moduleError(module, code, message, span) {
    fail(code, message, span, module?.context.sourceName, module?.context.sourceText);
}
