import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkProgram } from "../src/checker.mjs";
import { formatDiagnostic } from "../src/diagnostics.mjs";
import { parseSource } from "../src/frontend.mjs";
import { loadModuleGraph } from "../src/modules.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function checkSource(source, sourceName = "<checker>") {
    const program = parseSource(source, sourceName);
    return checkProgram(program, { sourceName, sourceText: source });
}

test("statically checks every runnable example in the root examples folder", () => {
    for (const fileName of readdirSync(resolve(projectRoot, "examples")).filter((name) => name.endsWith(".om"))) {
        const sourceName = resolve(projectRoot, "examples", fileName);
        const sourceText = readFileSync(sourceName, "utf8");
        checkProgram(parseSource(sourceText, sourceName), { sourceName, sourceText });
    }
});

test("imports through symlinks require the canonical target to be an OMNI file", async (t) => {
    const directory = await mkdtemp(resolve(projectRoot, ".phase7-import-boundary-"));
    const entryPath = resolve(directory, "main.om");
    const aliasPath = resolve(directory, "alias.om");
    const secretPath = resolve(directory, "private.txt");
    const helperPath = resolve(directory, "helper.om");
    try {
        await writeFile(entryPath, 'import "./alias.om" as helper\nprint(helper.value)\n', "utf8");
        await writeFile(secretPath, "EXTERNAL_SECRET @\n", "utf8");
        await writeFile(helperPath, "let value: Int = 42\n", "utf8");
        try {
            await symlink(secretPath, aliasPath, "file");
        } catch (error) {
            if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
                t.skip("this Windows account cannot create symbolic links");
                return;
            }
            throw error;
        }

        await assert.rejects(loadModuleGraph(entryPath), (error) => {
            assert.equal(error.code, "E2050");
            assert.match(formatDiagnostic(error), /target must end in '\.om'/u);
            assert.doesNotMatch(formatDiagnostic(error), /EXTERNAL_SECRET/u);
            return true;
        });

        await rm(aliasPath);
        await symlink(helperPath, aliasPath, "file");
        const graph = await loadModuleGraph(entryPath);
        assert.equal(graph.modules.length, 2);
        assert.equal(graph.entry.imports.get("./alias.om").context.sourceText, "let value: Int = 42\n");
    } finally {
        const workspace = resolve(projectRoot);
        assert.ok(directory.startsWith(workspace), "import boundary fixtures stay inside the workspace");
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports unknown names and incompatible annotated values before execution", () => {
    assert.throws(() => checkSource("print(missing)", "<unknown>"), (error) => {
        assert.equal(error.code, "E2001");
        assert.equal(error.span.line, 1);
        assert.match(error.message, /unknown name 'missing'/u);
        return true;
    });

    assert.throws(() => checkSource("let count: Int = 1.5", "<type-mismatch>"), (error) => {
        assert.equal(error.code, "E2003");
        assert.match(error.message, /expected Int, found Float/u);
        return true;
    });
});

test("infers local and non-recursive function return types", () => {
    const interfaceTypes = checkSource("fn answer() { return 42 }\nlet value = answer()");
    assert.equal(interfaceTypes.values.get("answer").result.kind, "Int");
    assert.equal(interfaceTypes.values.get("value").kind, "Int");
});
