// --- addFilesToWorkspace.js ---
async function addFilesToWorkspace(list, baseDir = '') {
    if (!rootHandle) return;
    let skipped = 0;
    let items = list.map(it => ({ ...it, path: (baseDir ? baseDir + '/' : '') + it.path.replace(/^\/+/, '') })).filter(it => {
        const ok = it.path && !isAgentPath(it.path) && it.path.split('/')[0] !== '.agent' && !isSecurityProtectedPath(it.path);
        if (!ok) skipped++;
        return ok;
    });
    const existing = items.filter(it => !it.dir && registry.meta[it.path] && registry.meta[it.path].kind === 'file');
    if (existing.length) {
        const replace = await confirmDialog(`${existing.length} file${existing.length === 1 ? '' : 's'} already exist${existing.length === 1 ? 's' : ''} (${existing[0].path}${existing.length > 1 ? ', …' : ''}). Replace ${existing.length === 1 ? 'it' : 'them'}?`, { confirmLabel: 'Replace' });
        if (!replace) items = items.filter(it => !existing.includes(it));
    }
    let added = 0;
    for (const it of items) {
        try {
            if (it.dir) { await getDirectoryHandleByPath(it.path, true); state.expandedFolders.add(it.path); continue; }
            const parts = it.path.split('/'), name = parts.pop();
            let dir = rootHandle, acc = '';
            for (const p of parts) { dir = await dir.getDirectoryHandle(p, { create: true }); acc = acc ? acc + '/' + p : p; state.expandedFolders.add(acc); }
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(it.file); await w.close();
            delete registry.files[it.path];
            // Register the file in the live registry immediately. Relying on the
            // syncWorkspace() call below means a freshly dropped file is invisible
            // to tools (find/grep/read) until the next sync pass actually runs -
            // and the explicit refresh here can be coalesced away by the re-entrancy
            // guard while the background tick's traversal is still in flight.
            registry.meta[it.path] = { kind: 'file', size: it.file.size, isBinary: false, handle: fh };
            registry.files[it.path] = await readFileContent(it.path);
            const model = (typeof monacoModels !== 'undefined') && monacoModels.get(it.path);
            if (model && !isFileDirty(it.path)) {
                withDirtyTrackingSuppressed(() => model.setValue(registry.files[it.path]));
            }
            added++;
        } catch (e) { showToast(`Could not add ${it.path}: ${e.message}`, 'error'); }
    }
    await syncWorkspace(true);
    renderExplorerTree(); renderChangesPanel(); updateStatusInfo();
    if (skipped) showToast(`${skipped} file${skipped === 1 ? '' : 's'} skipped (protected path)`, 'error');
}

// --- AST_EXPORTS_START ---
window.addFilesToWorkspace = addFilesToWorkspace;
// --- AST_EXPORTS_END ---

// --- buildZip.js ---
function buildZip(entries) {   // entries: [{ path, data: Uint8Array | null (directory) }]
    const enc = new TextEncoder(), chunks = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const e of entries) {
        const isDir = e.data == null;
        const name = enc.encode(isDir ? e.path.replace(/\/?$/, '/') : e.path);
        const data = e.data || new Uint8Array(0);
        const crc = isDir ? 0 : crc32(data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
        chunks.push(new Uint8Array(lh.buffer), name, data);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
        ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
        ch.setUint32(38, isDir ? 0x10 : 0, true); ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + data.length;
    }
    let csize = 0; central.forEach(c => csize += c.length);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// --- AST_EXPORTS_START ---
window.buildZip = buildZip;
// --- AST_EXPORTS_END ---

// --- readZip.js ---
// A lightweight pure-JS ZIP parser. Uses the native DecompressionStream API for DEFLATE.
async function readZip(blob) {
    const buffer = await blob.arrayBuffer();
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    // Find End of Central Directory (EOCD)
    let eocdOffset = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65536 - 22); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) throw new Error("Not a valid ZIP file");
    
    const cdOffset = dv.getUint32(eocdOffset + 16, true);
    const cdCount = dv.getUint16(eocdOffset + 10, true);
    
    const entries = [];
    let ptr = cdOffset;
    for (let i = 0; i < cdCount; i++) {
        if (dv.getUint32(ptr, true) !== 0x02014b50) break;
        const compMethod = dv.getUint16(ptr + 10, true);
        const compSize = dv.getUint32(ptr + 20, true);
        const nameLen = dv.getUint16(ptr + 28, true);
        const extraLen = dv.getUint16(ptr + 30, true);
        const commentLen = dv.getUint16(ptr + 32, true);
        const localHeaderOffset = dv.getUint32(ptr + 42, true);
        
        const nameBytes = u8.subarray(ptr + 46, ptr + 46 + nameLen);
        const name = new TextDecoder().decode(nameBytes);
        
        ptr += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue; // Skip directories
        
        const lhNameLen = dv.getUint16(localHeaderOffset + 26, true);
        const lhExtraLen = dv.getUint16(localHeaderOffset + 28, true);
        const dataOffset = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
        const compData = u8.subarray(dataOffset, dataOffset + compSize);
        
        if (compMethod === 0) { // Store
            entries.push({ path: name, data: new Uint8Array(compData) });
        } else if (compMethod === 8) { // Deflate
            if (typeof DecompressionStream !== 'undefined') {
                try {
                    const ds = new DecompressionStream('deflate-raw');
                    const writer = ds.writable.getWriter();
                    writer.write(compData);
                    writer.close();
                    
                    const reader = ds.readable.getReader();
                    const chunks = [];
                    let total = 0;
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        total += value.length;
                    }
                    const out = new Uint8Array(total);
                    let pos = 0;
                    for (const c of chunks) { out.set(c, pos); pos += c.length; }
                    entries.push({ path: name, data: out });
                } catch (e) {
                    console.warn(`readZip: failed to decompress ${name}`, e);
                }
            } else {
                console.warn(`readZip: DecompressionStream not supported, skipping ${name}`);
            }
        }
    }
    return entries;
}

// --- AST_EXPORTS_START ---
window.readZip = readZip;
// --- AST_EXPORTS_END ---

// --- collectDropped.js ---
// ---- Dropped / picked files ----
// Must be called synchronously from the drop handler (DataTransfer is invalidated after the first await).
async function collectDropped(dt) {
    // Chromium invalidates the DataTransfer as soon as the drop handler returns,
    // so EVERYTHING that touches it must happen synchronously, before any await.
    const out = [];
    const jobs = [];
    const items = Array.from(dt.items || []);
    const looseFiles = Array.from(dt.files || []);

    items.forEach(it => {
        if (it.kind !== 'file') return;
        let handle = null, entry = null, file = null;
        // Modern API (Chromium 86+, recent Firefox): FileSystemHandle for files AND folders.
        try { handle = it.getAsFileSystemHandle ? it.getAsFileSystemHandle() : null; } catch (e) {}
        // Legacy API: FileSystemEntry (File or Directory). Widely supported.
        try { entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; } catch (e) {}
        // Plain File fallback: only ever a file, never a folder.
        try { file = it.getAsFile ? it.getAsFile() : null; } catch (e) {}
        jobs.push({ handle, entry, file });
    });
    if (!jobs.length) looseFiles.forEach(f => jobs.push({ handle: null, entry: null, file: f }));

    const readEntries = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));

    // Legacy FileSystemEntry walker.
    const walkEntry = async (en, prefix) => {
        if (en.isFile) {
            const f = await new Promise((res, rej) => en.file(res, rej));
            out.push({ path: prefix + en.name, file: f });
        } else if (en.isDirectory) {
            // Register the directory itself, so empty folders and the folder
            // structure show up in the preview, not just the files inside it.
            out.push({ path: prefix + en.name, dir: true });
            const r = en.createReader();
            let all = [];
            for (;;) { const b = await readEntries(r); if (!b.length) break; all = all.concat(b); }
            for (const c of all) await walkEntry(c, prefix + en.name + '/');
        }
    };

    // Modern FileSystemHandle walker.
    const walkHandle = async (h, prefix) => {
        if (h.kind === 'file') {
            const f = await h.getFile();
            out.push({ path: prefix + h.name, file: f });
        } else if (h.kind === 'directory') {
            out.push({ path: prefix + h.name, dir: true });
            for await (const child of h.values()) {
                await walkHandle(child, prefix + h.name + '/');
            }
        }
    };

    for (const j of jobs) {
        try {
            let done = false;
            if (j.handle) {
                const h = await j.handle;
                if (h) { await walkHandle(h, ''); done = true; }
            }
            if (!done && j.entry) {
                await walkEntry(j.entry, '');
                done = true;
            }
            if (!done && j.file) {
                out.push({ path: j.file.name, file: j.file });
            }
        } catch (e) {
            // Fall back to the plain File if the entry/handle APIs failed for any reason.
            if (j.file && typeof j.file.size === 'number') {
                out.push({ path: j.file.name, file: j.file });
            } else {
                console.warn('Could not read dropped item', e);
            }
        }
    }
    return out;
}

// --- AST_EXPORTS_START ---
window.collectDropped = collectDropped;
// --- AST_EXPORTS_END ---

// --- crc32.js ---
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// --- AST_EXPORTS_START ---
window.crc32 = crc32;
// --- AST_EXPORTS_END ---

// --- createVirtualWorkspace.js ---
async function createVirtualWorkspace(name, list) {
    const vid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const root = new VFSNode('directory', name, null);
    root._ws = { vid };
    for (const it of list) { if (it.dir) vfsPutDir(root, it.path); else vfsPutFile(root, it.path, it.file); }
    await vfsFlush(root);
    return vfsWrap(root);
}

// --- AST_EXPORTS_START ---
window.createVirtualWorkspace = createVirtualWorkspace;
// --- AST_EXPORTS_END ---

// --- downloadPath.js ---
async function downloadPath(path) {
    const meta = registry.meta[path];
    if (!meta) return;
    if (meta.kind === 'directory') return downloadZip(path);
    const blob = await vfsReadBlob(path);
    if (!blob) { showToast('Could not read ' + path, 'error'); return; }
    triggerDownload(blob, path.split('/').pop());
}

// --- AST_EXPORTS_START ---
window.downloadPath = downloadPath;
// --- AST_EXPORTS_END ---

// --- downloadZip.js ---
async function downloadZip(prefix = '') {
    if (!rootHandle) return;
    const base = prefix ? prefix + '/' : '';
    const paths = Object.keys(registry.meta).filter(p => (!prefix || p.startsWith(base)) && isDownloadablePath(p)).sort();
    const entries = []; let files = 0;
    for (const p of paths) {
        const rel = prefix ? p.slice(base.length) : p;
        if (!rel) continue;
        if (registry.meta[p].kind === 'directory') { entries.push({ path: rel, data: null }); continue; }
        const b = await vfsReadBlob(p);
        if (!b) continue;
        entries.push({ path: rel, data: new Uint8Array(await b.arrayBuffer()) }); files++;
    }
    if (!entries.length) return;
    triggerDownload(buildZip(entries), (prefix ? prefix.split('/').pop() : (rootHandle.name || 'workspace')) + '.zip');
}

// --- AST_EXPORTS_START ---
window.downloadZip = downloadZip;
// --- AST_EXPORTS_END ---

// --- isDownloadablePath.js ---
// ---- Download helpers (single file + store-only .zip writer, no dependencies) ----
function isDownloadablePath(p) { return !isAgentPath(p) && !isVirtualAgentFile(p) && p.split('/')[0] !== '.agent'; }

// --- AST_EXPORTS_START ---
window.isDownloadablePath = isDownloadablePath;
// --- AST_EXPORTS_END ---

// --- openVirtualWorkspaceById.js ---
async function openVirtualWorkspaceById(vid) {
    try {
        const db = await getDB();
        const snap = await new Promise((res) => {
            const req = db.transaction(STORE_HANDLES, 'readonly').objectStore(STORE_HANDLES).get('vws_' + vid);
            req.onsuccess = () => res(req.result); req.onerror = () => res(null);
        });
        if (!snap) {
            showToast('Virtual workspace data not found', 'error'); return;
        }
        const root = new VFSNode('directory', snap.name, null);
        root._ws = { vid };
        for (const e of snap.entries) { if (e.kind === 'directory') vfsPutDir(root, e.path); else vfsPutFile(root, e.path, e.blob); }
        const folders = getRecentFolders(), f = folders.find(x => x.vid === vid);
        if (f) { f.lastAccessed = Date.now(); saveRecentFolders(folders); }
        await setWorkspace(vfsWrap(root));
    } catch (e) { showToast('Could not open virtual workspace: ' + e.message, 'error'); }
}

// --- AST_EXPORTS_START ---
window.openVirtualWorkspaceById = openVirtualWorkspaceById;
// --- AST_EXPORTS_END ---

// --- removeVirtualWorkspace.js ---
async function removeVirtualWorkspace(vid, name) {
    if (!await confirmDialog(`Delete virtual workspace "${name}"? Its files will be permanently removed.`, { confirmLabel: 'Delete', danger: true })) return;
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_HANDLES, 'readwrite');
        tx.objectStore(STORE_HANDLES).delete('vws_' + vid);
        await new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
    } catch (e) {}
    saveRecentFolders(getRecentFolders().filter(f => f.vid !== vid));
    renderRecentFoldersList();
}

// --- AST_EXPORTS_START ---
window.removeVirtualWorkspace = removeVirtualWorkspace;
// --- AST_EXPORTS_END ---

// --- triggerDownload.js ---
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// --- AST_EXPORTS_START ---
window.triggerDownload = triggerDownload;
// --- AST_EXPORTS_END ---
