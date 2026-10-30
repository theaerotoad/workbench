async function readFileContent(filepath) {
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
    if (isFileDirty(filepath) && typeof monacoModels !== 'undefined' && monacoModels.has(filepath)) {
        return monacoModels.get(filepath).getValue();
    }
    if (!rootHandle) return registry.files[filepath] !== undefined ? registry.files[filepath] : "";
    try {
        const handle = await getHandleByPath(filepath);
        if (!handle) return "";
        const file = await handle.getFile();
        let text;
        const sniffed = await readFileTextSniffed(file);
        if (sniffed.binary) {
            text = await file.text();   // unchanged legacy behaviour; callers check isBinary first
        } else {
            text = sniffed.text;
            if (registry.meta[filepath]) registry.meta[filepath].encoding = sniffed.encoding;
        }
        if (registry.files[filepath] === undefined) {
            registry.files[filepath] = text;
        }
        return text;
    } catch(e) {
        return "";
    }
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
    return { content: await readFileContent(filepath) };
}

// Disk-only write. Does not touch opsLog or modifiedFiles.
async function rawWrite(path, content) {
    wsMutationEpoch++;
    if (!rootHandle) {
        registry.files[path] = content;
        registry.meta[path] = { kind: 'file' };
        return;
    }
    // Keep the file's existing encoding (UTF-16, BOM, Windows-1252) instead of silently converting to UTF-8.
    let enc = registry.meta[path]?.encoding;
    if (!enc) {
        try { enc = (await sniffWorkspaceFile(path)).encoding; } catch (e) { enc = null; }   // new file -> utf-8
    }
    const payload = encodeForDisk(content, enc, path);   // may throw before the file is touched

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
    registry.files[path] = content;
    // Merge into the existing entry so size/isBinary/handle are not thrown away by a write.
    const prevMeta = registry.meta[path];
    const nextMeta = (prevMeta && prevMeta.kind === 'file') ? prevMeta : { kind: 'file' };
    nextMeta.handle = fh;
    nextMeta.isBinary = false;
    if (enc && enc !== 'utf-8') nextMeta.encoding = enc; else delete nextMeta.encoding;
    registry.meta[path] = nextMeta;
    wsMutationEpoch++;
}

// Disk-only delete. Does not touch opsLog or modifiedFiles.
async function rawDelete(path) {
    wsMutationEpoch++;
    if (!rootHandle) {
        delete registry.meta[path];
        delete registry.files[path];
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
    const prefix = path + '/';
    for (const k of Object.keys(registry.meta)) {
        if (k === path || k.startsWith(prefix)) { delete registry.meta[k]; delete registry.files[k]; }
    }
    delete registry.meta[path];
    delete registry.files[path];
    wsMutationEpoch++;
}

async function rawMkdir(path) {
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
