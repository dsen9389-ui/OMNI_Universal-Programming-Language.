import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const renameFallbackCodes = new Set(["EPERM", "EACCES", "ENOTSUP"]);

export async function ensureSafeDirectory(directory) {
    const absolute = await resolveSystemAlias(resolve(directory));
    const { root } = parse(absolute);
    const parts = absolute.slice(root.length).split(sep).filter(Boolean);
    let current = root;

    for (const part of parts) {
        current = join(current, part);
        let info;
        try {
            info = await lstat(current);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            try {
                await mkdir(current);
            } catch (createError) {
                if (createError.code !== "EEXIST") throw createError;
            }
            info = await lstat(current);
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error("output path contains a symbolic link or non-directory: " + current);
        }
    }

    return absolute;
}

export async function ensureSafeSubdirectory(root, relativeDirectory) {
    const safeRoot = await ensureSafeDirectory(root);
    const target = resolveInside(safeRoot, relativeDirectory);
    return ensureSafeDirectory(target);
}

export async function safeWriteFile(root, relativePath, data, encoding = "utf8") {
    const safeRoot = await ensureSafeDirectory(root);
    const target = resolveInside(safeRoot, relativePath);
    const parent = await ensureSafeDirectory(dirname(target));
    const destination = join(parent, target.slice(parent.length + 1).split(/[\\/]/u).at(-1));
    await assertRegularOrMissing(destination);

    const temporary = join(parent, ".omni-write-" + randomUUID() + ".tmp");
    const handle = await open(temporary, "wx");
    try {
        if (typeof data === "string") await handle.writeFile(data, encoding);
        else await handle.writeFile(data);
        await handle.close();
        await assertRegularOrMissing(destination);
        try {
            await rename(temporary, destination);
        } catch (error) {
            if (!renameFallbackCodes.has(error.code)) throw error;
            await writeAfterRenameDenied(destination, await readFile(temporary));
            await unlink(temporary);
        }
    } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
    }
    return destination;
}

export async function safeReadFile(root, relativePath, options) {
    const safeRoot = await ensureSafeDirectory(root);
    const target = resolveInside(safeRoot, relativePath);
    await ensureSafeDirectory(dirname(target));
    const info = await lstat(target);
    assertRegularFile(info, target);
    return readFile(target, options);
}

export async function safeInstallFile(root, sourcePath, relativeDestination) {
    const safeRoot = await ensureSafeDirectory(root);
    const source = resolve(sourcePath);
    assertWithin(safeRoot, source);
    await ensureSafeDirectory(dirname(source));
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
        throw new Error("temporary build output is not a regular file: " + source);
    }

    const destination = resolveInside(safeRoot, relativeDestination);
    const parent = await ensureSafeDirectory(dirname(destination));
    await assertRegularOrMissing(destination);
    const finalPath = join(parent, destination.slice(parent.length + 1).split(/[\\/]/u).at(-1));
    try {
        await rename(source, finalPath);
    } catch (error) {
        if (!renameFallbackCodes.has(error.code)) throw error;
        await safeWriteFile(safeRoot, relative(safeRoot, finalPath), await readFile(source));
        await unlink(source);
    }
    return finalPath;
}

function resolveInside(root, relativePath) {
    if (typeof relativePath !== "string" || isAbsolute(relativePath)) {
        throw new Error("output artifact path must be relative to the output directory");
    }
    const target = resolve(root, relativePath);
    assertWithin(root, target);
    return target;
}

function assertWithin(root, target) {
    const pathFromRoot = relative(root, target);
    if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(".." + sep) || isAbsolute(pathFromRoot)) {
        throw new Error("output artifact path escapes the output directory: " + target);
    }
}

async function assertRegularOrMissing(path) {
    try {
        const info = await lstat(path);
        assertRegularFile(info, path);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

function assertRegularFile(info, path) {
    if (info.isSymbolicLink()) throw new Error("output artifact is a symbolic link: " + path);
    if (!info.isFile()) throw new Error("output artifact is not a regular file: " + path);
}

async function resolveSystemAlias(absolute) {
    if (process.platform !== "darwin") return absolute;

    // macOS exposes temporary and variable data through these system symlink aliases.
    // Resolve only the exact OS-managed aliases, then keep rejecting other symlinks.
    for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
        if (!absolute.startsWith(alias + sep)) continue;
        try {
            if (await realpath(alias) === canonical) return canonical + absolute.slice(alias.length);
        } catch {
            // Keep the original path; the normal safe-directory walk reports any problem.
        }
    }
    return absolute;
}

async function writeAfterRenameDenied(destination, data) {
    await assertRegularOrMissing(destination);
    try {
        await unlink(destination);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    // Exclusive creation refuses a symlink or any file raced into this path.
    const handle = await open(destination, "wx");
    try {
        await handle.writeFile(data);
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => {});
        await unlink(destination).catch(() => {});
        throw error;
    }
    await handle.close();
}
