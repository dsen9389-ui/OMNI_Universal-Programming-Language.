export function validateSupportMatrix(matrix, workflow) {
    const errors = [];
    if (matrix?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
    if (!Array.isArray(matrix?.runtime?.supportedMajorVersions)) errors.push("runtime.supportedMajorVersions must be an array");
    if (!Array.isArray(matrix?.toolchainHosts) || matrix.toolchainHosts.length === 0) {
        errors.push("toolchainHosts must contain at least one host");
        return errors;
    }

    const hosts = matrix.toolchainHosts;
    const supportedMajors = new Set((matrix.runtime.supportedMajorVersions ?? []).map(String));
    if (!supportedMajors.has("24")) errors.push("CI policy requires Node.js 24 on every declared host");
    const runners = new Set();
    for (const host of hosts) {
        if (!host.operatingSystem || !host.architecture || !host.runner) errors.push("each host needs an operating system, architecture, and runner");
        if (runners.has(host.runner)) errors.push("runner '" + host.runner + "' is listed more than once");
        runners.add(host.runner);
    }

    const rows = workflowRows(workflow);
    const actual = new Set(rows.map((row) => row.runner + "@" + row.node));
    const expected = new Set();
    if (supportedMajors.has("24")) for (const host of hosts) expected.add(host.runner + "@24");
    if (supportedMajors.has("22")) {
        const linuxX64 = hosts.find((host) => host.operatingSystem === "Linux" && host.architecture === "x64");
        if (!linuxX64) errors.push("Node.js 22 CI requires a declared Linux x64 host");
        else expected.add(linuxX64.runner + "@22");
    }
    for (const row of expected) if (!actual.has(row)) errors.push("CI is missing declared host/runtime row '" + row + "'");
    for (const row of actual) if (!expected.has(row)) errors.push("CI contains an undeclared host/runtime row '" + row + "'");
    if (rows.length !== actual.size) errors.push("CI contains duplicate host/runtime rows");

    const requiredWorkflowSteps = [
        "node scripts/install-zig.mjs",
        "npm run check:syntax",
        "npm run check:support-matrix",
        "npm test",
        "npm run test:conformance",
        "npm run fuzz",
        "node scripts/benchmark.mjs --samples 5 --warmups 1",
        "node bin/omni.mjs fmt examples/tooling-tests/tests/addition.test.om --check",
        "node bin/omni.mjs test examples/tooling-tests/tests --engine javascript",
    ];
    for (const step of requiredWorkflowSteps) {
        if (!workflow.includes(step)) errors.push("CI is missing required step '" + step + "'");
    }
    return errors;
}

function workflowRows(workflow) {
    const lines = workflow.split(/\r?\n/u);
    const includeIndex = lines.findIndex((line) => /^\s*include:\s*$/u.test(line));
    if (includeIndex < 0) return [];
    const includeIndent = lines[includeIndex].match(/^\s*/u)[0].length;
    const rows = [];
    let current = null;
    for (const line of lines.slice(includeIndex + 1)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const indent = line.match(/^\s*/u)[0].length;
        if (indent <= includeIndent) break;
        if (indent === includeIndent + 2 && /^-\s+label:/u.test(line.trim())) {
            if (current) rows.push(current);
            current = { runner: null, node: null };
            continue;
        }
        if (!current || indent !== includeIndent + 4) continue;
        const runner = /^runner:\s*([^\s#]+)\s*$/u.exec(line.trim());
        const node = /^node:\s*(\d+)\s*$/u.exec(line.trim());
        if (runner) current.runner = runner[1];
        if (node) current.node = node[1];
    }
    if (current) rows.push(current);
    return rows.filter((row) => row.runner && row.node);
}
