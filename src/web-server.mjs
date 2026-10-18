import { createServer } from "node:http";
import { realpath, stat, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const contentTypes = Object.freeze({
    ".html": "text/html; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".css": "text/css; charset=utf-8",
});

export async function serveWebDirectory(directory, port = 4173) {
    const root = await realpath(resolve(directory));
    if (!(await stat(root)).isDirectory()) throw new Error("web output path must be a directory");
    const server = createServer((request, response) => {
        void serveRequest(request, response, root);
    });
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolveListen();
        });
    });
    return server;
}

async function serveRequest(request, response, root) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" }).end();
        return;
    }
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
        response.writeHead(400, { "Content-Length": "0" }).end();
        return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
        response.writeHead(403, { "Content-Length": "0" }).end();
        return;
    }
    try {
        const filePath = await realpath(candidate);
        if (filePath !== root && !filePath.startsWith(root + sep)) {
            response.writeHead(403, { "Content-Length": "0" }).end();
            return;
        }
        if (!(await stat(filePath)).isFile()) {
            response.writeHead(404, { "Content-Length": "0" }).end();
            return;
        }
        const body = request.method === "HEAD" ? null : await readFile(filePath);
        const length = body?.byteLength ?? (await stat(filePath)).size;
        response.writeHead(200, {
            "Content-Type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
            "Content-Length": String(length),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
    } catch (error) {
        const status = error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 500;
        response.writeHead(status, { "Content-Length": "0" }).end();
    }
}
