const _inFlightReads = new Map();

async function readFileContent(filepath, opts = {}) {
    if (filepath === MODELS_FILE) {
        return modelsFileContent();
    }
    if (filepath === CONFIG_FILE) {
        return JSON.stringify(AppConfig.all(), null, 2) + '\n';
    }
    if (isPromptFileMode(filepath)) {
        return modePromptFileContent(filepath);
    }
    if (isToolFilePath(filepath)) {
        return registry.files[filepath] !== undefined ? registry.files[filepath] : "";
    }
    if (isAttachmentPath(filepath)) {
        return registry.files[filepath] !== undefined ? registry.files[filepath] : "";
    }
    const fromDisk = !!(opts && opts.fromDisk === true);
    if (!fromDisk && isFileDirty(filepath) && typeof monacoModels !== 'undefined' && monacoModels.has(filepath)) {
        return monacoModels.get(filepath).getValue();
    }
    const root = rootHandle;
    if (!root) return registry.files[filepath] !== undefined ? registry.files[filepath] : "";

    const force = fromDisk || !!(opts && opts.force === true);
    const throwOnError = !!(opts && opts.throwOnError === true);
    if (!force && registry.files[filepath] !== undefined) {
        return registry.files[filepath];
    }

    const existing = _inFlightReads.get(filepath);
    if (!force && existing && existing.root === root) {
        return existing.p;
    }

    const p = (async () => {
        try {
            const handle = await getHandleByPath(filepath, false, root);
            if (!handle) {
                if (throwOnError) throw new Error(`File not found: ${filepath}`);
                return "";
            }
            const file = await handle.getFile();
            let text;
            const sniffed = await readFileTextSniffed(file);
            if (sniffed.binary) {
                text = await file.text();   // unchanged legacy behaviour; callers check isBinary first
            } else {
                text = sniffed.text;
            }
            if (rootHandle === root && !fromDisk) {
                const meta = registry.meta[filepath];
                if (meta) {
                    meta.isBinary = !!sniffed.binary;
                    if (!sniffed.binary) {
                        meta.encoding = sniffed.encoding;
                    }
                    meta.size = file.size;
                    if (file.lastModified) {
                        const fileMtimeSec = file.lastModified / 1000;
                        // On WebDAV, keep high-res mtime from fetchFastTree when HTTP Last-Modified
                        // matches the same second, preventing the next scan from evicting registry.files.
                        if (!root.isWebDAV || meta.mtime === undefined || Math.abs(meta.mtime - fileMtimeSec) >= 1.5) {
                            meta.mtime = fileMtimeSec;
                        }
                        meta._syncedMtime = meta.mtime;
                        meta._syncedSize = file.size;
                    }
                    if (window.sniffCache) {
                        const metaSig = (typeof meta.size === 'number' && meta.mtime !== undefined)
                            ? `m:${meta.size}:${meta.mtime}`
                            : null;
                        window.sniffCache.set(filepath, {
                            sig: `${file.size}:${file.lastModified}`,
                            metaSig,
                            binary: sniffed.binary,
                            encoding: sniffed.encoding
                        });
                    }
                }
                registry.files[filepath] = text;
            }
            return text;
        } catch(e) {
            if (throwOnError) throw e;
            return "";
        } finally {
            const cur = _inFlightReads.get(filepath);
            if (cur && (cur.p === p || cur.raw === p)) _inFlightReads.delete(filepath);
        }
    })();

    if (!fromDisk) {
        // Keep shared in-flight reads non-rejecting for callers that expect "" on error.
        const sharedP = throwOnError ? p.catch(() => "") : p;
        _inFlightReads.set(filepath, { root, p: sharedP, raw: p });
    }
    return p;
}

async function readFileContentForTool(filepath) {
    if (isSecurityProtectedPath(filepath)) {
        return { error: `ERROR: ${filepath} is a protected path and cannot be read by a tool call.` };
    }
    if (isSensitiveUserFile(filepath)) {
        return { error: `ERROR: ${filepath} is a private user settings file and cannot be read by a tool call.` };
    }
    if (shouldHideFromTools(filepath)) {
        return { error: `ERROR: ${filepath} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.` };
    }
    if (isAgentPath(filepath) && !isToolFilePath(filepath) && !isVirtualAgentFile(filepath)) {
        return { error: `ERROR: ${filepath} is inside .agent and cannot be read by a tool call.` };
    }
    if (!isVirtualAgentFile(filepath)) {
        const meta = registry.meta[filepath];
        if (meta && meta.kind === 'directory') {
            return { error: `ERROR: ${filepath} is a directory and cannot be read as a file.` };
        }
        const inMemoryOnly = !rootHandle && registry.files[filepath] !== undefined;
        const inMemoryPlan = filepath === PLAN_FILE && registry.files[PLAN_FILE] !== undefined;
        if (!meta && !inMemoryOnly && !inMemoryPlan && !(await fileExistsOnDisk(filepath))) {
            return { error: `ERROR: ${filepath} not found` };
        }
    }
    return { content: await readFileContent(filepath) };
}

// Disk-only write. Does not touch opsLog or modifiedFiles.
async function rawWrite(path, content) {
    if (window.isWorkspaceReadOnly?.()) throw new Error('Workspace is read-only');
    wsMutationEpoch++;
    const isBlob = typeof Blob !== 'undefined' && content instanceof Blob;
    const isBinaryPayload = isBlob || content instanceof ArrayBuffer || ArrayBuffer.isView(content);
    const binaryByteLength = isBlob
        ? content.size
        : (content instanceof ArrayBuffer ? content.byteLength : (ArrayBuffer.isView(content) ? content.byteLength : 0));

    if (!rootHandle) {
        if (isBinaryPayload) {
            registry.files[path] = isBlob ? content : new Blob([content]);
            registry.meta[path] = { kind: 'file', isBinary: true, size: binaryByteLength };
        } else {
            registry.files[path] = content;
            registry.meta[path] = { kind: 'file', isBinary: false };
        }
        wsMutationEpoch++;
        return;
    }

    let enc = null;
    let payload;
    if (isBinaryPayload) {
        payload = isBlob
            ? content
            : (content instanceof ArrayBuffer
                ? new Uint8Array(content)
                : new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
    } else {
        // Keep the file's existing encoding (UTF-16, BOM, Windows-1252) instead of silently converting to UTF-8.
        enc = registry.meta[path]?.encoding;
        if (!enc) {
            try { enc = (await sniffWorkspaceFile(path)).encoding; } catch (e) { enc = null; }   // new file -> utf-8
        }
        payload = encodeForDisk(content, enc, path);   // may throw before the file is touched
    }

    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let parentHandle = rootHandle;
    for (const p of parts) {
        parentHandle = await parentHandle.getDirectoryHandle(p, { create: true });
    }
    const fh = await parentHandle.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(payload);
    await w.close();

    // Merge into the existing entry so size/isBinary/handle are not thrown away by a write.
    const prevMeta = registry.meta[path];
    const nextMeta = (prevMeta && prevMeta.kind === 'file') ? prevMeta : { kind: 'file' };
    nextMeta.handle = fh;
    if (isBinaryPayload) {
        // Keep binary payloads out of registry.files so text-only code never treats them as strings.
        delete registry.files[path];
        nextMeta.isBinary = true;
        nextMeta.size = binaryByteLength;
        delete nextMeta.encoding;
    } else {
        registry.files[path] = content;
        nextMeta.isBinary = false;
        if (enc && enc !== 'utf-8') nextMeta.encoding = enc; else delete nextMeta.encoding;
    }
    registry.meta[path] = nextMeta;
    if (window.sniffCache) window.sniffCache.delete(path);
    wsMutationEpoch++;
}

// Disk-only delete. Does not touch opsLog or modifiedFiles.
async function rawDelete(path) {
    if (window.isWorkspaceReadOnly?.()) throw new Error('Workspace is read-only');
    wsMutationEpoch++;
    const prefix = path + '/';
    if (!rootHandle) {
        for (const k of Object.keys(registry.meta)) {
            if (k === path || k.startsWith(prefix)) { delete registry.meta[k]; delete registry.files[k]; }
        }
        delete registry.meta[path];
        delete registry.files[path];
        wsMutationEpoch++;
        return;
    }
    const parts = path.split('/').filter(Boolean);
    const targetName = parts.pop();
    let parentHandle = rootHandle;
    for (const p of parts) {
        parentHandle = await parentHandle.getDirectoryHandle(p);
    }
    await parentHandle.removeEntry(targetName, { recursive: true });
    // Folders: drop everything beneath the path too, not just the folder entry.
    for (const k of Object.keys(registry.meta)) {
        if (k === path || k.startsWith(prefix)) { delete registry.meta[k]; delete registry.files[k]; }
    }
    delete registry.meta[path];
    delete registry.files[path];
    wsMutationEpoch++;
}

async function rawMkdir(path) {
    if (window.isWorkspaceReadOnly?.()) throw new Error('Workspace is read-only');
    wsMutationEpoch++;
    await getDirectoryHandleByPath(path, true);
    registry.meta[path] = { kind: 'directory' };
    wsMutationEpoch++;
}

// Kept as a public wrapper for the few remaining direct callers (tool delete
// path, context menu) so they don't all have to change in this diff.
async function deleteFileOrDirectory(path) {
    if (isVirtualAgentFile(path) || path === CUSTOM_TOOLS_DIR || path === PROMPTS_DIR) {
        showToast(`${path} is a virtual settings file/folder and can't be deleted`, 'error');
        return;
    }
    if (isSecurityProtectedPath(path)) {
        showToast(`${path} is a protected path and can't be deleted`, 'error');
        return;
    }
    await fs.del(path, { mode: 'ui' });
}

// --- AST_EXPORTS_START ---
window.readFileContent = readFileContent;
window.readFileContentForTool = readFileContentForTool;
window.rawWrite = rawWrite;
window.rawDelete = rawDelete;
window.rawMkdir = rawMkdir;
window.deleteFileOrDirectory = deleteFileOrDirectory;
// --- AST_EXPORTS_END ---
