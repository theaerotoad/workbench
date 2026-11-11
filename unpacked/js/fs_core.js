import { state, registry } from './state_manager.js';

export function vfsChanged(n) {
    const r = vfsRoot(n);
    if (!r._ws) return;
    r._dirty = true;
    clearTimeout(r._t);
    r._t = setTimeout(() => vfsFlush(r), 500);
}

export function vfsCheckName(name) {
    if (!name || name === '.' || name === '..' || /[\/\\]/.test(name)) throw new TypeError('Invalid entry name: ' + name);
}

export function vfsErr(name, msg) { return new DOMException(msg, name); }

export function vfsFlushIfDirty() {
    if (window.rootHandle && window.rootHandle.isVirtual && window.rootHandle._n._dirty) vfsFlush(window.rootHandle);
}

export async function vfsFlush(h) {
    const r = h instanceof window.VFSNode ? h : h._n;
    if (!r._ws) return;
    clearTimeout(r._t);
    r._dirty = false;
    const entries = [];
    const walk = (node, p) => {
        for (const [k, c] of node.children) {
            const path = p ? p + '/' + k : k;
            if (c.kind === 'file') entries.push({ path, kind: 'file', blob: c.blob });
            else { entries.push({ path, kind: 'directory' }); walk(c, path); }
        }
    };
    walk(r, '');
    try {
        const db = await window.getDB();
        const tx = db.transaction(window.STORE_HANDLES, 'readwrite');
        tx.objectStore(window.STORE_HANDLES).put({ vid: r._ws.vid, name: r.name, entries, updated: Date.now() }, 'vws_' + r._ws.vid);
        await new Promise(res => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
    } catch (e) {}
}

export function vfsPutDir(root, path) {
    let d = root;
    for (const p of path.split('/').filter(Boolean)) {
        let c = d.children.get(p);
        if (!c || c.kind !== 'directory') { c = new window.VFSNode('directory', p, d); d.children.set(p, c); }
        d = c;
    }
    return d;
}

export function vfsPutFile(root, path, blob) {
    const parts = path.split('/').filter(Boolean), fname = parts.pop();
    const d = vfsPutDir(root, parts.join('/'));
    let f = d.children.get(fname);
    if (!f || f.kind !== 'file') { f = new window.VFSNode('file', fname, d); d.children.set(fname, f); }
    f.blob = blob; f.mtime = Date.now();
}

export async function vfsReadBlob(path) {
    if (window.rootHandle) { try { return await (await getHandleByPath(path)).getFile(); } catch (e) {} }
    if (registry.files[path] !== undefined) return new Blob([registry.files[path]]);
    return null;
}

export function vfsRoot(n) { while (n.parent) n = n.parent; return n; }

export function vfsWrap(n) { return n._h || (n._h = n.kind === 'file' ? new window.VFSFileHandle(n) : new window.VFSDirHandle(n)); }

export async function rawRename(oldPath, newPath) {
    window.wsMutationEpoch++;
    const newName = newPath.split('/').filter(Boolean).pop();
    if (!newName) return { error: `ERROR: Invalid new file name.` };

    const oldParts = oldPath.split('/').filter(Boolean);
    const oldDirParts = oldParts.slice(0, -1);
    const resolvedNewPath = [...oldDirParts, newName].join('/');

    if (oldPath === resolvedNewPath) {
        return {}; 
    }

    try {
        const oldMeta = registry.meta[oldPath];
        if (!oldMeta) return { error: `ERROR: ${oldPath} not found` };

        const oldContent = await window.readFileContent(oldPath);
        if (oldContent === undefined) return { error: `ERROR: Content for ${oldPath} not found.` };

        let nativeMoveSuccess = false;
        let fileHandle = oldMeta.handle;

        if (window.rootHandle) {
            const oldHandle = await getHandleByPath(oldPath);
            if (oldHandle && typeof oldHandle.move === 'function') {
                try {
                    const dirPath = oldDirParts.join('/');
                    const parentDirHandle = dirPath === ''
                        ? window.rootHandle
                        : await getDirectoryHandleByPath(dirPath, false);

                    if (parentDirHandle) {
                        await oldHandle.move(parentDirHandle, newName);
                        fileHandle = oldHandle;
                        nativeMoveSuccess = true;
                    }
                } catch (e) {
                    console.warn(`Native move() rejected by browser, falling back: ${e.message}`);
                }
            }
        }

        if (nativeMoveSuccess) {
            delete registry.meta[oldPath];
            delete registry.files[oldPath];
            registry.meta[resolvedNewPath] = {
                kind: 'file',
                size: oldMeta.size || 0,
                isBinary: false,
                handle: fileHandle
            };
            registry.files[resolvedNewPath] = oldContent;
        } else {
            if (oldMeta && oldMeta.encoding) registry.meta[resolvedNewPath] = { kind: 'file', encoding: oldMeta.encoding };
            await window.rawWrite(resolvedNewPath, oldContent);
            await window.rawDelete(oldPath);
        }

        window.wsMutationEpoch++;
        return { ok: true, resolvedNewPath };
    } catch(e) {
        return { error: `ERROR: ${e.message}` };
    }
}

export async function writeAgentFileToDisk(filePath, content) {
    if (!window.rootHandle) return;
    if (window.rootHandle.isWebDAV && window.AppConfig.get('webdav-sync-agent') !== 'true') return;
    try {
        await fs.ensureParentDirs(filePath, { track: false });
        await window.rawWrite(filePath, content);
    } catch(e) {
        console.warn('Failed to sync agent file to disk:', filePath, e);
    }
}

export async function writeDisk(filePath, content, opts) {
    const isFromLLMTool = !!(opts && opts.fromLLMTool);
    const sessionId = (opts && opts.sessionId) || state.activeSessionId;
    const isLive = sessionId === state.activeSessionId;

    if (isFromLLMTool && isSecurityProtectedPath(filePath)) {
        window.print(`<span class="red">[blocked] ${window.escapeHTML(filePath)} is a protected path and can't be written by a tool call.</span>`, "", sessionId);
        return { output: `ERROR: ${filePath} is a protected path and cannot be written by a tool call.` };
    }

    const LLM_BLOCKED_FILES = [window.MODELS_FILE, window.CONFIG_FILE];
    if (isFromLLMTool && (LLM_BLOCKED_FILES.includes(filePath) || window.isPromptFileMode(filePath))) {
        window.print(`<span class="red">[blocked] ${window.escapeHTML(filePath)} is user-owned and can't be written by a tool call.</span>`, "", sessionId);
        return { output: `ERROR: ${filePath} is read-only to tools. This is an app/settings file the model cannot change.` };
    }

    if (window.isAttachmentPath(filePath)) {
        if (isFromLLMTool) {
            window.print(`<span class="red">[blocked] ${window.escapeHTML(filePath)} is a read-only session attachment and can't be written by a tool call.</span>`, "", sessionId);
            return { output: `ERROR: ${filePath} is a read-only session attachment. Attachments cannot be created, edited, or deleted by tools.` };
        }
        window.print(`<span class="red">[blocked] Session attachments are read-only and cannot be modified.</span>`, "", sessionId);
        return;
    }

    if (window.isToolFilePath(filePath) && isFromLLMTool) {
        const toolName = filePath.slice((window.TOOLS_DIR + '/').length, -3);
        const existingTool = window.toolRegistry[toolName];
        if (existingTool && existingTool.locked) {
            window.print(`<span class="red">[blocked] "${window.escapeHTML(toolName)}" is locked and can't be modified by a tool call. Unlock it in Settings -> Tools first.</span>`, "", sessionId);
            return { output: `ERROR: Tool "${toolName}" is locked. Ask the user to unlock it in Settings -> Tools before you can modify it.` };
        }
    }

    if (window.isAgentPath(filePath) && !window.isVirtualAgentFile(filePath) && !filePath.startsWith('.agent/background.')) {
        window.print(`<span class="red">[blocked] Creation of files/folders inside .agent is not allowed.</span>`, "", sessionId);
        return;
    }

    if (isFromLLMTool && window.isAgentPath(filePath) && !window.isToolFilePath(filePath)) {
        const perm = await window.checkPermission('.agent', `Edit ${filePath}`, sessionId);
        if (!perm.allowed) {
            window.print(`<span class="red">[permission denied] ${window.escapeHTML(filePath)}</span>`, "", sessionId);
            return;
        }
    }

    if (window.isToolFilePath(filePath)) {
        registry.files[filePath] = content;
        registry.meta[filePath] = { kind: 'file', size: content.length, isBinary: false, virtual: true };
        const toolName = filePath.slice((window.TOOLS_DIR + '/').length, -3);
        window.persistToolFile(toolName, content);
        window.unmarkToolDeleted(toolName);
        window.rebuildToolRegistryFromFiles();
        window.renderToolsList();
        window.renderExplorerTree();
        const parsedTool = window.toolRegistry[toolName];
        if (parsedTool && parsedTool.error) {
            window.print(`<span class="yellow">[tools] Saved ${window.escapeHTML(filePath)}, but: ${window.escapeHTML(parsedTool.error)}</span>`);
        }
        return { handled: true };
    }

    if (filePath === window.MODELS_FILE) {
        let parsed;
        try {
            parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) {
                throw new Error('must be a JSON array of providers');
            }
            const requiredProviderFields = ['provider', 'url', 'models'];
            const requiredModelFields = ['name'];
            const providerIds = new Set();
            parsed.forEach((p, pi) => {
                const missing = requiredProviderFields.filter(f => !p[f]);
                if (missing.length > 0) {
                    throw new Error(`Provider at index ${pi} is missing required field(s): ${missing.join(', ')}`);
                }
                if (!Array.isArray(p.models) || p.models.length === 0) {
                    throw new Error(`Provider "${p.provider}" must have a non-empty "models" array`);
                }
                const pid = p.id || p.provider;
                if (providerIds.has(pid)) {
                    throw new Error(`Duplicate provider id/name: ${pid}`);
                }
                providerIds.add(pid);
                const modelIds = new Set();
                p.models.forEach((m, mi) => {
                    const missingM = requiredModelFields.filter(f => !m[f]);
                    if (missingM.length > 0) {
                        throw new Error(`Model at index ${mi} in provider "${p.provider}" is missing required field(s): ${missingM.join(', ')}`);
                    }
                    const mid = m.id || m.name;
                    if (modelIds.has(mid)) {
                        throw new Error(`Duplicate model "${mid}" within provider "${p.provider}"`);
                    }
                    modelIds.add(mid);
                });
            });
            window.MODEL_PROVIDERS = parsed;
        } catch(e) {
            window.print(`<span class="red">[models] Invalid JSON, not saved: ${window.escapeHTML(e.message)}</span>`);
            return { output: `ERROR: ${window.MODELS_FILE} must be an array of providers, each with {provider, url, models: [{name, context_window, vision}]}. ${e.message}` };
        }
        window.saveModels();
        window.registerModelsVirtualFile();
        window.renderModelDropdown();
        window.renderExplorerTree();
        return { handled: true };
    }

    if (filePath === window.CONFIG_FILE) {
        let parsed;
        try {
            const topLevelKeyRegex = /[{,]\s*"([^"]+)"\s*:/g;
            const keyMatches = [...content.matchAll(topLevelKeyRegex)];
            const keys = keyMatches.map(m => m[1]);
            const seen = new Set();
            const duplicates = keys.filter(k => seen.size === seen.add(k).size);
            if (duplicates.length > 0) {
                throw new Error(`Duplicate key(s): ${[...new Set(duplicates)].join(', ')}`);
            }
            parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be a JSON object');
        } catch(e) {
            window.print(`<span class="red">[config] Invalid JSON, not saved: ${window.escapeHTML(e.message)}</span>`);
            return { output: `ERROR: ${window.CONFIG_FILE} must be a JSON object. ${e.message}` };
        }
        window.AppConfig.replaceAll(parsed);
        window.registerConfigVirtualFile();
        window.applyConfigToUI();
        window.updateGenGlow();
        return { handled: true };
    }

    if (window.isPromptFileMode(filePath)) {
        const mode = window.PROMPT_FILE_MODES[filePath];
        const res = window.applyPromptFile(mode, content);
        window.registerPromptsVirtualFile();
        window.renderExplorerTree();
        if (res.error) {
            window.print(`<span class="yellow">[prompts] ${window.escapeHTML(res.error)}</span>`);
        }
        return { handled: true };
    }

    if (isFromLLMTool) {
        await fs.write(filePath, content, { sessionId, mode: 'tool' });
    } else {
        await fs.write(filePath, content, { sessionId, mode: 'editor' });
    }

    window.clearFileDirty(filePath);

    if (!isLive) return;

    const m = window.monacoModels.get(filePath);
    if (m && m.getValue() !== content) {
        window.withDirtyTrackingSuppressed(() => m.setValue(content));
    }

    if (state.activeTab === `filediff:${filePath}`) {
        window.renderFileDiffView(filePath);
    }

    if (state.activeTab === filePath && state.editorViewMode === 'preview') {
        window.updateHtmlPreview();
    }

    if (state.openTabs.includes(`render:${filePath}`)) {
        window.updateMarkdownPreview(filePath, content);
    }
}

export async function readFileTextSniffed(file) {
    const head = new Uint8Array(await file.slice(0, window.SNIFF_BYTES).arrayBuffer());
    const s = sniffBytes(head, file.size > head.length);
    if (s.binary) return { binary: true, text: null, encoding: null };
    const label = window.encodingLabel(s.encoding);
    const text = label === 'utf-8'
        ? await file.text()
        : new TextDecoder(label).decode(await file.arrayBuffer());
    return { binary: false, text, encoding: s.encoding };
}

export async function readImageBlobUrl(filepath) {
    if (!filepath) return null;
    if (typeof registry.files[filepath] === 'string' && registry.files[filepath].startsWith('data:')) {
        return registry.files[filepath];
    }
    try {
        let blob = null;
        if (window.rootHandle) {
            try {
                const handle = await getHandleByPath(filepath);
                if (handle && typeof handle.getFile === 'function') {
                    const file = await handle.getFile();
                    const mime = file.type || (window.guessImageMimeType ? window.guessImageMimeType(filepath) : '') || 'image/png';
                    blob = file.slice(0, file.size, mime);
                }
            } catch (e) {}
        }
        if (!blob && registry.files[filepath] !== undefined) {
            const val = registry.files[filepath];
            if (val instanceof Blob) {
                blob = val;
            } else if (typeof val === 'string' && val.startsWith('data:')) {
                return val;
            } else {
                const mime = (window.guessImageMimeType ? window.guessImageMimeType(filepath) : '') || 'image/png';
                blob = new Blob([val], { type: mime });
            }
        }
        if (blob) {
            return URL.createObjectURL(blob);
        }
    } catch (e) {
        console.warn('readImageBlobUrl error for', filepath, e);
    }
    return null;
}

export async function readImageDataUrl(filepath) {
    if (!window.isImageFilePath(filepath)) return null;

    if (typeof registry.files[filepath] === 'string' && registry.files[filepath].startsWith('data:')) {
        return registry.files[filepath];
    }

    let handle = registry.meta[filepath]?.handle || null;
    if (!handle && window.rootHandle) {
        try { handle = await getHandleByPath(filepath); } catch (e) { handle = null; }
    }
    if (!handle && registry.files[filepath] instanceof Blob) {
        const blob = registry.files[filepath];
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.readAsDataURL(blob);
        });
    }
    if (!handle) return null;

    try {
        const file = await handle.getFile();
        const mime = file.type || (window.guessImageMimeType ? window.guessImageMimeType(filepath) : '') || 'image/png';
        const blob = file.slice(0, file.size, mime);
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return null;
    }
}

export function sniffBytes(u8, partial) {
    const n = u8.length;
    if (n === 0) return { binary: false, encoding: 'utf-8' };
    const starts = (sig) => n >= sig.length && sig.every((b, i) => u8[i] === b);

    const controlRatio = (text) => {
        let bad = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if ((c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 27) || c === 0xFFFD) bad++;
        }
        return text.length ? bad / text.length : 0;
    };

    if (starts([0xEF, 0xBB, 0xBF])) return { binary: false, encoding: 'utf-8-bom' };
    if (starts([0xFF, 0xFE, 0x00, 0x00]) || starts([0x00, 0x00, 0xFE, 0xFF])) return { binary: true, encoding: null };
    const utf16 = starts([0xFF, 0xFE]) ? 'utf-16le' : (starts([0xFE, 0xFF]) ? 'utf-16be' : null);
    if (utf16) {
        const text = new TextDecoder(utf16).decode(u8.subarray(0, n - (n % 2)));
        return controlRatio(text) > 0.05 ? { binary: true, encoding: null } : { binary: false, encoding: utf16 };
    }

    for (const sig of window.BINARY_MAGIC) if (starts(sig)) return { binary: true, encoding: null };

    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const b = u8[i];
        if (b === 0) return { binary: true, encoding: null }; 
        if ((b < 0x20 && b !== 9 && b !== 10 && b !== 12 && b !== 13 && b !== 27) || b === 0x7F) suspicious++;
    }
    if (suspicious / n > 0.05) return { binary: true, encoding: null };

    try {
        new TextDecoder('utf-8', { fatal: true }).decode(u8, { stream: !!partial });
        return { binary: false, encoding: 'utf-8' };
    } catch (e) {
        return { binary: false, encoding: 'windows-1252' };
    }
}

export async function sniffWorkspaceFile(fp) {
    const handle = registry.meta[fp]?.handle || await getHandleByPath(fp);
    if (!handle) throw new Error('no handle');
    const file = await handle.getFile();
    const sig = `${file.size}:${file.lastModified}`;
    const hit = window.sniffCache.get(fp);
    if (hit && hit.sig === sig) return hit;
    const head = new Uint8Array(await file.slice(0, window.SNIFF_BYTES).arrayBuffer());
    const s = sniffBytes(head, file.size > head.length);
    const res = { sig, binary: s.binary, encoding: s.encoding };
    window.sniffCache.set(fp, res);
    return res;
}

export function isBinaryByExtension(name) {
    return window.BINARY_EXT_DEFINITE.test(name) || window.BINARY_EXT_AMBIGUOUS.test(name);
}

export function isBinaryContent(s) {
    if (!s) return false;
    if (typeof s !== 'string') return true;
    const sampleLen = Math.min(s.length, 4096);
    const sample = s.slice(0, sampleLen);
    const nullCount = (sample.match(/\u0000/g) || []).length;
    const nonPrintableCount = (sample.match(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g) || []).length;
    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    return sampleLen > 0 && (
        nullCount > 0 ||
        (nonPrintableCount / sampleLen) > 0.05 ||
        (replacementCount / sampleLen) > 0.02
    );
}

export async function resolveIsBinary(fp) {
    const meta = registry.meta[fp];
    if (!meta || meta.kind !== 'file') return false;
    if (meta.virtual || !window.rootHandle) return !!meta.isBinary;
    if (window.BINARY_EXT_DEFINITE.test(fp)) return true;
    try {
        const r = await sniffWorkspaceFile(fp);
        meta.isBinary = r.binary;
        if (r.encoding) meta.encoding = r.encoding; else delete meta.encoding;
        return r.binary;
    } catch (e) {
        return !!meta.isBinary;
    }
}

export function encodeForDisk(content, enc, path) {
    if (!enc || enc === 'utf-8' || typeof content !== 'string') return content;
    if (enc === 'utf-8-bom') return new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), content]);
    if (enc === 'utf-16le' || enc === 'utf-16be') {
        const le = enc === 'utf-16le';
        const buf = new Uint8Array(2 + content.length * 2);
        buf[0] = le ? 0xFF : 0xFE; buf[1] = le ? 0xFE : 0xFF;
        for (let i = 0; i < content.length; i++) {
            const c = content.charCodeAt(i);
            buf[2 + i * 2] = le ? (c & 0xFF) : (c >> 8);
            buf[3 + i * 2] = le ? (c >> 8) : (c & 0xFF);
        }
        return buf;
    }
    if (enc === 'windows-1252') {
        if (!window._cp1252Rev) {
            const d = new TextDecoder('windows-1252');
            window._cp1252Rev = new Map();
            for (let b = 0; b < 256; b++) window._cp1252Rev.set(d.decode(new Uint8Array([b])), b);
        }
        const out = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) {
            const b = window._cp1252Rev.get(content[i]);
            if (b === undefined) {
                const err = new Error(`Cannot write ${path}: the file is encoded as windows-1252 and the new content contains a character it cannot represent ("${content[i]}"). Replace it (for example with plain ASCII).`);
                err.encodingError = true;
                throw err;
            }
            out[i] = b;
        }
        return out;
    }
    return content;
}

export async function getDirectoryHandleByPath(dirpath, create = false) {
    if (!window.rootHandle) return null;
    if (!dirpath || dirpath === '/') return window.rootHandle;
    const parts = dirpath.split('/').filter(Boolean);
    let curr = window.rootHandle;
    for (const part of parts) {
        curr = await curr.getDirectoryHandle(part, { create });
    }
    return curr;
}

export async function getHandleByPath(filepath, create = false) {
    if (!window.rootHandle) return null;
    const parts = filepath.split('/').filter(Boolean);
    let curr = window.rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        curr = await curr.getDirectoryHandle(parts[i], { create });
    }
    return await curr.getFileHandle(parts[parts.length - 1], { create });
}

export async function fileExistsOnDisk(filePath) {
    if (!window.rootHandle) return false;
    try {
        const handle = await getHandleByPath(filePath);
        return !!handle;
    } catch(e) {
        return false;
    }
}

export async function workspaceDirExists(dirPath) {
    if (!dirPath) return true;
    const meta = registry.meta[dirPath];
    if (meta && meta.kind === 'directory') return true;
    if (!window.rootHandle) return false;
    try { await getDirectoryHandleByPath(dirPath, false); return true; } catch (e) { return false; }
}

export function isHardProtectedPath(path) {
    if (!path) return false;
    const parts = path.split('/');
    const baseName = parts[parts.length - 1];

    for (const pattern of window.PROTECTED_PATTERNS) {
        if (pattern.endsWith('/')) {
            if (isUnderDirPattern(pattern, path)) return true;
            const dirPat = pattern.slice(0, -1);
            if (path === dirPat || path.endsWith('/' + dirPat)) return true;
        } else if (matchesPattern(pattern, path, baseName, false)) {
            return true;
        }
    }

    for (let i = 0; i < parts.length - 1; i++) {
        if (window.IMPLICIT_DIR_PATTERNS.has(parts[i])) return true;
    }
    return false;
}

export function isUnderDirPattern(pattern, fullPath) {
    if (!pattern.endsWith('/')) return false;
    const dirPat = pattern.slice(0, -1).replace(/^\//, '');
    const anchored = pattern.includes('/', 0) && pattern.indexOf('/') !== pattern.length - 1;
    const re = globToRegExp(dirPat);
    const parts = fullPath.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
        if (re.test(parts[i])) return true;
        const prefix = parts.slice(0, i + 1).join('/');
        if (dirPat.includes('/') && globToRegExp(dirPat).test(prefix)) return true;
    }
    return false;
}

export function matchesPattern(pattern, fullPath, baseName, isDir) {
    let pat = pattern.trim();
    if (!pat || pat.startsWith('#')) return false;

    let dirOnly = false;
    if (pat.endsWith('/')) {
        dirOnly = true;
        pat = pat.slice(0, -1);
    }
    if (dirOnly && !isDir) {
        return false;
    }

    const anchored = pat.includes('/');
    const candidate = anchored ? fullPath : baseName;
    const re = globToRegExp(pat.replace(/^\//, ''));
    return re.test(candidate);
}

export function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const translated = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + translated + '$', 'i');
}

export function dirnameOf(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
}

export const fs = (() => {
    function currentPromptCtx(sessionId) {
        const gen = window.getGenState(sessionId || state.activeSessionId);
        return gen.currentPromptContext || null;
    }

    function ensureLog(filePath, sessionId) {
        const ctx = window.sessionCtx(sessionId || state.activeSessionId);
        const b = ctx.baseline;
        if (!b.opsLog) b.opsLog = {};
        if (!b.opsLog[filePath]) b.opsLog[filePath] = [];
        return b.opsLog[filePath];
    }

    async function record(op, sessionId) {
        const sid = sessionId || state.activeSessionId;
        const ctx = window.sessionCtx(sid);
        if (ctx.deleted) return;
        const b = ctx.baseline;

        op.ts = op.ts || Date.now();
        if (op.prompt === undefined) op.prompt = currentPromptCtx(sid);

        if (op.kind === 'rename') {
            const priorLog = ensureLog(op.from, sid);
            priorLog.push({ kind: 'rename-out', ts: op.ts, prompt: op.prompt, to: op.to, mode: op.mode });
            const renameIn = { kind: 'rename-in', ts: op.ts, prompt: op.prompt, from: op.from, mode: op.mode };
            const newLog = ensureLog(op.to, sid);

            if (op.from !== op.to) {
                b.opsLog[op.to] = [...priorLog, renameIn, ...newLog];
                delete b.opsLog[op.from];
            } else {
                newLog.push(renameIn);
            }

            const move = (dict) => {
                if (dict[op.from] !== undefined) { dict[op.to] = dict[op.from]; delete dict[op.from]; }
            };
            move(b.originalFiles);

            ctx.modifiedFiles.delete(op.from);
            ctx.modifiedFiles.add(op.to);

            if (b._lastKnownContent && b._lastKnownContent[op.from] !== undefined) {
                b._lastKnownContent[op.to] = b._lastKnownContent[op.from];
                delete b._lastKnownContent[op.from];
            }
        } else {
            const p = op.path;
            ensureLog(p, sid).push(op);

            if (op.kind === 'delete') {
                ctx.modifiedFiles.delete(p);
            } else if (op.kind === 'create') {
                if (b.originalFiles[p] === undefined) b.originalFiles[p] = null;
                ctx.modifiedFiles.add(p);
            } else if (op.kind === 'mkdir') {
            } else {
                if (b.originalFiles[p] === undefined) {
                    b.originalFiles[p] = op.previousContent !== undefined ? op.previousContent : null;
                }
                if (b.originalFiles[p] !== undefined && b.originalFiles[p] === op.content) {
                    ctx.modifiedFiles.delete(p);
                } else {
                    ctx.modifiedFiles.add(p);
                }
            }

            if (!b._lastKnownContent) b._lastKnownContent = {};
            if (op.kind === 'delete') delete b._lastKnownContent[p];
        }

        await window.recomputeLineStats(ctx, sid);
        await window.persistCheckpoint(sid);
        if (ctx.isLive) { window.renderChangesPanel(); window.renderExplorerTree(); window.updateStatusInfo(); window.refreshChangesGraph(); }
    }

    async function ensureParentDirs(path, opts = {}) {
        const sid = opts.sessionId || state.activeSessionId;
        const parts = path.split('/').filter(Boolean);
        if (parts.length <= 1) return [];

        const created = [];
        let built = '';

        for (let i = 0; i < parts.length - 1; i++) {
            built = built ? `${built}/${parts[i]}` : parts[i];

            if (registry.meta[built] !== undefined) continue;

            if (window.rootHandle) {
                await window.rawMkdir(built);
            }
            registry.meta[built] = { kind: 'directory' };
            created.push(built);
        }

        if (opts.track !== false) {
            for (const dir of created) {
                await record({ kind: 'mkdir', path: dir, mode: opts.mode || 'ui' }, sid);
            }
        }
        return created;
    }

    async function create(path, content, opts = {}) {
        const sid = opts.sessionId || state.activeSessionId;
        if (isSecurityProtectedPath(path)) return { error: `ERROR: ${path} is a protected path.` };
        await ensureParentDirs(path, opts);
        try { await window.rawWrite(path, content); }
        catch (e) { if (e && e.encodingError) return { error: `ERROR: ${e.message}` }; throw e; }
        if (opts.track !== false) {
            await record({ kind: 'create', path, content, mode: opts.mode || 'ui' }, sid);
        }
        return { ok: true };
    }

    async function write(path, content, opts = {}) {
        const sid = opts.sessionId || state.activeSessionId;
        if (isSecurityProtectedPath(path)) return { error: `ERROR: ${path} is a protected path.` };
        await ensureParentDirs(path, opts);
        const onDisk = await fileExistsOnDisk(path);
        const existed = onDisk || registry.files[path] !== undefined;
        
        let previousContent;
        if (existed) {
            previousContent = onDisk ? await window.readFileContent(path) : registry.files[path];
        }
        try { await window.rawWrite(path, content); }
        catch (e) { if (e && e.encodingError) return { error: `ERROR: ${e.message}` }; throw e; }
        if (opts.track !== false) {
            await record({ kind: existed ? 'write' : 'create', path, content, previousContent, mode: opts.mode || 'ui' }, sid);
        }
        return { ok: true };
    }

    async function edit(path, searchBlock, replaceBlock, opts = {}) {
        const original = await window.readFileContent(path);
        if (original === undefined || original === null) return { error: `ERROR: ${path} not found` };
        const { content, lineNumber } = window.applySearchReplace(original, searchBlock, replaceBlock || '');
        const res = await write(path, content, { ...opts, mode: opts.mode || 'tool' });
        return res.error ? res : { ok: true, lineNumber };
    }

    async function rename(from, to, opts = {}) {
        const sid = opts.sessionId || state.activeSessionId;
        if (isSecurityProtectedPath(from) || isSecurityProtectedPath(to)) {
            return { error: `ERROR: protected paths can't be renamed or moved.` };
        }
        if (window.isToolOrAgentPath(from)) return { error: `ERROR: ${from} is a virtual settings file and can't be renamed.` };
        if (window.isAgentPath(to)) return { error: `ERROR: Cannot rename files into .agent` };
        const res = await rawRename(from, to);
        if (res.error) return res;
        if (opts.track === false) return { ok: true, resolvedNewPath: res.resolvedNewPath || to };
        const actualTo = res.resolvedNewPath || to;
        await record({ kind: 'rename', from, to: actualTo, mode: opts.mode || 'ui' }, sid);
        return { ok: true, resolvedNewPath: actualTo };
    }

    async function del(path, opts = {}) {
        const sid = opts.sessionId || state.activeSessionId;
        if (window.isVirtualAgentFile(path) || path === window.CUSTOM_TOOLS_DIR || path === window.PROMPTS_DIR) {
            return { error: `ERROR: ${path} is a virtual settings file/folder and can't be deleted.` };
        }
        if (isSecurityProtectedPath(path)) return { error: `ERROR: ${path} is a protected path.` };
        await window.rawDelete(path);
        if (opts.track !== false) {
            await record({ kind: 'delete', path, mode: opts.mode || 'ui' }, sid);
        }
        return { ok: true };
    }

    async function mkdir(path, opts = {}) {
        const sid = opts.sessionId || state.activeSessionId;
        await window.rawMkdir(path);
        if (opts.track !== false) {
            await record({ kind: 'mkdir', path, mode: opts.mode || 'ui' }, sid);
        }
        return { ok: true };
    }

    return { create, write, edit, rename, del, mkdir, record, ensureParentDirs };
})();

// Attach all to window for legacy scripts
Object.entries({
    fs,
    vfsChanged, vfsCheckName, vfsErr, vfsFlushIfDirty, vfsFlush, vfsPutDir, vfsPutFile,
    vfsReadBlob, vfsRoot, vfsWrap, rawRename, writeAgentFileToDisk, writeDisk,
    readFileTextSniffed, readImageDataUrl, readImageBlobUrl, sniffBytes, sniffWorkspaceFile,
    isBinaryByExtension, isBinaryContent, resolveIsBinary, encodeForDisk,
    getDirectoryHandleByPath, getHandleByPath, fileExistsOnDisk, workspaceDirExists,
    isHardProtectedPath, isUnderDirPattern, matchesPattern, globToRegExp, dirnameOf
}).forEach(([k, v]) => window[k] = v);
