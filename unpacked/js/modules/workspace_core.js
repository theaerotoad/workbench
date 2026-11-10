// --- addToRecentFolders.js ---
async function addToRecentFolders(handle) {
    const folders = getRecentFolders();
    let entry;
    let existingIdx;
    if (handle.isWebDAV) {
        entry = {
            name: handle.name,
            type: 'webdav',
            url: handle.url,
            webdavPath: handle.path,
            auth: handle.auth,
            lastAccessed: Date.now()
        };
        existingIdx = folders.findIndex(f => f.type === 'webdav' && f.url === handle.url && (f.webdavPath || '') === (handle.path || ''));
    } else {
        entry = { name: handle.name, lastAccessed: Date.now() };
        existingIdx = folders.findIndex(f => f.name === handle.name && !f.virtual && f.type !== 'webdav');
    }
    if (existingIdx !== -1) folders.splice(existingIdx, 1);
    folders.unshift(entry);
    saveRecentFolders(folders);
    if (!handle.isWebDAV && !handle.isVirtual) {
        await saveRecentHandleToDB(handle.name, handle);
    }
    renderRecentFoldersList();
}

// --- AST_EXPORTS_START ---
window.addToRecentFolders = addToRecentFolders;
// --- AST_EXPORTS_END ---

// --- closeWorkspace.js ---
function closeWorkspace() {
    if (!rootHandle) return;

    if (isAnySessionRunning()) {
        for (const s of Object.values(state.sessions)) {
            if (s._gen && s._gen.isRunning) {
                abortGeneration({ showResumeUI: false, sessionId: s.id });
            }
        }
    }

    if (typeof closeWebDAVEvents === 'function') closeWebDAVEvents();
    if (rootHandle.isVirtual) vfsFlush(rootHandle);
    if (rootHandle.isWebDAV && typeof AppConfig !== 'undefined' && AppConfig.get('webdav-sync-agent') !== 'true') {
        const wsKey = wsStorageName(rootHandle);
        try {
            if (AppConfig._data) localStorage.setItem(`app_config_${wsKey}`, JSON.stringify(AppConfig._data));
            if (typeof MODEL_PROVIDERS !== 'undefined') localStorage.setItem(`models_${wsKey}`, JSON.stringify(MODEL_PROVIDERS));
            if (typeof MODE_PROMPTS !== 'undefined') localStorage.setItem(`mode_prompts_${wsKey}`, JSON.stringify(MODE_PROMPTS));
            if (typeof getWorkspaceToolsConfig === 'function') {
                const cfg = getWorkspaceToolsConfig();
                if (cfg) localStorage.setItem(`tools_config_${wsKey}`, JSON.stringify(cfg));
            }
        } catch(e) {}
    }
    rootHandle = null;
    updateWorkspaceTitle();
    updateSessionPillLabel();   // -> "workbench - Workspaces"

    // Drop the session that belonged to the workspace we just left: the next
    // workspace creates its own set, and nothing from this one can leak back.
    state.sessions = {};
    state.sessionIds = null;
    state.sessionMeta = null;
    state.activeSessionId = 'sess_' + Math.random().toString(36).substring(2, 9);

    // Auto-collapse the sidebar when leaving a workspace; restore it on the next open.
    if (!window.innerWidth <= 768) setSidebarCollapsed(true);

    registry.files = {};
    registry.originalFiles = {};
    registry.meta = {};
    registry.opsLog = {};
    registry.compressionHistory = [];
    state.skills = {};
    state.modifiedFiles.clear();
    state.linesAdded = 0;
    state.linesRemoved = 0;
    state.messages = [];
    term.innerHTML = '';
    resetScrollState();

    if (typeof resetToolRegistry === 'function') {
        resetToolRegistry();
    } else {
        registerToolsVirtualFiles();
    }
    registerModelsVirtualFile();
    registerConfigVirtualFile();
    registerPromptsVirtualFile();
    if (typeof registerToolsVirtualFile === 'function') {
        registerToolsVirtualFile();
    }
    if (typeof renderToolsList === 'function') {
        renderToolsList();
    }
    if (typeof refreshPermBanner === 'function') {
        refreshPermBanner();
    }

    if (btnExitWorkspace) btnExitWorkspace.style.display = 'none';
    if (btnSessionToggle) btnSessionToggle.style.display = 'none';
    const wsBtnClose = document.getElementById('btn-workspace-display');
    if (wsBtnClose) wsBtnClose.style.display = 'none';
    const wsSepClose = document.getElementById('header-ws-sep');
    if (wsSepClose) wsSepClose.style.display = 'none';
    const sessionSepClose = document.getElementById('header-session-sep');
    if (sessionSepClose) sessionSepClose.style.display = 'none';
    const brandBtnClose = document.getElementById('btn-header-brand');
    if (brandBtnClose) {
        brandBtnClose.title = 'workbench';
        brandBtnClose.classList.remove('can-exit');
    }

    const noFolderOverlay = document.getElementById('no-folder-overlay');
    if (noFolderOverlay) noFolderOverlay.classList.remove('hidden');
    renderRecentFoldersList();

    renderExplorerTree();
    renderChangesPanel();
    updateStatusInfo();
    state.checkpointModalFile = null;
    state.checkpointModalMode = 'all';
    graphBreadcrumb.classList.remove('visible');
    graphPanelLabel.style.display = '';
    renderAllPromptGroups();
}

// --- AST_EXPORTS_START ---
window.closeWorkspace = closeWorkspace;
// --- AST_EXPORTS_END ---

// --- closeWorkspaceNoConfirm.js ---
async function closeWorkspaceNoConfirm() {
    const dirtyTabs = state.openTabs.filter(tabId => isFileDirty(tabId));
    for (const tabId of dirtyTabs) {
        closeTabNoConfirm(tabId);
    }
    closeWorkspace();
}

// --- AST_EXPORTS_START ---
window.closeWorkspaceNoConfirm = closeWorkspaceNoConfirm;
// --- AST_EXPORTS_END ---

// --- currentWsName.js ---
function currentWsName() {
    return rootHandle ? wsStorageName(rootHandle) : '_default_ws_';
}

// --- AST_EXPORTS_START ---
window.currentWsName = currentWsName;
// --- AST_EXPORTS_END ---

// --- deleteAgentFileFromDisk.js ---
async function deleteAgentFileFromDisk(filePath) {
    if (!rootHandle) return;
    if (rootHandle.isWebDAV && AppConfig.get('webdav-sync-agent') !== 'true') return;
    try {
        await rawDelete(filePath);
    } catch(e) {}
}

// --- AST_EXPORTS_START ---
window.deleteAgentFileFromDisk = deleteAgentFileFromDisk;
// --- AST_EXPORTS_END ---

// --- ensureWorkspaceFresh.js ---
// Full refresh for tools that need the whole file list: waits out an in-progress editor save, then
// runs a sync that is guaranteed to start after this call (never reuses a scan that began earlier).
async function ensureWorkspaceFresh() {
    if (!rootHandle) return;
    for (let i = 0; state.isSaving && i < 40; i++) await new Promise(r => setTimeout(r, 50));
    await syncWorkspace(true);
}

// --- AST_EXPORTS_START ---
window.ensureWorkspaceFresh = ensureWorkspaceFresh;
// --- AST_EXPORTS_END ---

// --- fastTraverseDirectory.js ---
async function fastTraverseDirectory(handle, path = "", targetMap) {
    const subdirs = [];
    for await (const entry of handle.values()) {
        const fullPath = path ? `${path}/${entry.name}` : entry.name;
        if (shouldSkipScanEntry(entry.name, fullPath)) continue;
        if (entry.kind === 'file') {
            let size = 0;
            let isBinary = isBinaryByExtension(entry.name);   // hint only; resolveIsBinary() confirms from content on first use

            targetMap[fullPath] = {
                kind: 'file',
                size,
                isBinary,
                handle: entry
            };

            if (entry.name === '.gitignore') {
                try {
                    const file = await entry.getFile();
                    const text = await file.text();
                    registerGitignoreRules(fullPath, text);
                } catch(e) {}
            }
        } else if (entry.kind === 'directory') {
            targetMap[fullPath] = {
                kind: 'directory',
                size: 0,
                isBinary: false,
                handle: entry
            };
            subdirs.push({ handle: entry, fullPath });
        }
    }
    if (subdirs.length > 0) {
        const BATCH_SIZE = 4;
        for (let i = 0; i < subdirs.length; i += BATCH_SIZE) {
            const batch = subdirs.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(d => fastTraverseDirectory(d.handle, d.fullPath, targetMap)));
        }
    }
}

// --- AST_EXPORTS_START ---
window.fastTraverseDirectory = fastTraverseDirectory;
// --- AST_EXPORTS_END ---

// --- getRecentFolders.js ---
function getRecentFolders() {
    try {
        const stored = localStorage.getItem('recent_folders_json');
        return stored ? JSON.parse(stored) : [];
    } catch(e) { return []; }
}

// --- AST_EXPORTS_START ---
window.getRecentFolders = getRecentFolders;
// --- AST_EXPORTS_END ---

// --- getWorkspaceSessionKey.js ---
function getWorkspaceSessionKey() {
    const ws = rootHandle ? wsStorageName(rootHandle) : '_default_ws_';
    return `codeagent_sessions_${ws}`;
}

// --- AST_EXPORTS_START ---
window.getWorkspaceSessionKey = getWorkspaceSessionKey;
// --- AST_EXPORTS_END ---

// --- isNoFolderOverlayHidden.js ---
function isNoFolderOverlayHidden() {
    const overlay = document.getElementById('no-folder-overlay');
    return !overlay || overlay.classList.contains('hidden');
}

// --- AST_EXPORTS_START ---
window.isNoFolderOverlayHidden = isNoFolderOverlayHidden;
// --- AST_EXPORTS_END ---

// --- loadRecentHandleFromDB.js ---
async function loadRecentHandleFromDB(name) {
    try {
        const db = await getDB();
        return new Promise((res) => {
            const tx = db.transaction(STORE_HANDLES, 'readonly');
            const req = tx.objectStore(STORE_HANDLES).get('recent_' + name);
            req.onsuccess = () => res(req.result);
            req.onerror = () => res(null);
        });
    } catch(e) { return null; }
}

// --- AST_EXPORTS_START ---
window.loadRecentHandleFromDB = loadRecentHandleFromDB;
// --- AST_EXPORTS_END ---

// --- markNoFsApi.js ---
function markNoFsApi() {   // called when the picker turns out to be unusable at runtime
    HAS_FS_API = false;
    document.documentElement.classList.add('no-fsa');
    const rb = document.getElementById('no-folder-btn'); if (rb) rb.hidden = true;
    renderRecentFoldersList();
}

// --- AST_EXPORTS_START ---
window.markNoFsApi = markNoFsApi;
// --- AST_EXPORTS_END ---

// --- markRecentFolderAccessed.js ---
function markRecentFolderAccessed(folderName, matchObj = null) {
    const folders = getRecentFolders();
    const folder = matchObj && matchObj.type === 'webdav'
        ? folders.find(f => f.type === 'webdav' && f.name === folderName && (f.url || '') === (matchObj.url || '') && (f.webdavPath || '') === (matchObj.webdavPath || ''))
        : folders.find(f => f.name === folderName);
    if (folder) {
        folder.lastAccessed = Date.now();
        saveRecentFolders(folders);
    }
}

// --- AST_EXPORTS_START ---
window.markRecentFolderAccessed = markRecentFolderAccessed;
// --- AST_EXPORTS_END ---

// --- mergeWorkspaceMeta.js ---
// Merges a fresh disk scan into registry.meta instead of replacing it, so per-file state
// (resolved isBinary, encoding, size) survives and entries added mid-scan are not lost.
// Returns true when the set of paths or their kinds changed.
function mergeWorkspaceMeta(scanned, allowRemoval) {
    let structChanged = false;
    for (const p of Object.keys(scanned)) {
        const fresh = scanned[p];
        const cur = registry.meta[p];
        if (!cur || cur.kind !== fresh.kind || cur.virtual) {
            registry.meta[p] = fresh;
            structChanged = true;
        } else {
            cur.handle = fresh.handle;   // refresh the handle, keep everything we have learned about the file
        }
    }
    if (allowRemoval) {
        for (const p of Object.keys(registry.meta)) {
            if (scanned[p]) continue;
            const cur = registry.meta[p];
            if (cur && (cur.virtual || cur.attachment)) continue;   // owned by the register*VirtualFile() calls
            delete registry.meta[p];
            structChanged = true;
        }
    }
    return structChanged;
}

// --- AST_EXPORTS_START ---
window.mergeWorkspaceMeta = mergeWorkspaceMeta;
// --- AST_EXPORTS_END ---

// --- pickFolderWithMemory.js ---
async function pickFolderWithMemory() {
    if (!HAS_FS_API) throw new Error('showDirectoryPicker is not supported in this browser');
    const options = { mode: 'readwrite', id: 'code_agent_workspace' };
    if (rootHandle) options.startIn = rootHandle;
    return await window.showDirectoryPicker(options);
}

// --- AST_EXPORTS_START ---
window.pickFolderWithMemory = pickFolderWithMemory;
// --- AST_EXPORTS_END ---

// --- refreshPathMeta.js ---
// Cheap per-path refresh straight from disk: used by tools so a single read/edit/exists never works from stale metadata.
async function refreshPathMeta(fp) {
    if (!rootHandle || typeof fp !== 'string' || !fp) return;
    const cur = registry.meta[fp];
    if (cur && (cur.virtual || cur.attachment)) return;
    if ((isAgentPath(fp) && !isSkillPath(fp)) || isToolFilePath(fp) || isAttachmentPath(fp) || fp === MODELS_FILE || fp === CONFIG_FILE || fp === TOOLS_FILE || isPromptFileMode(fp)) return;
    if (fp === PLAN_FILE || !isScanVisiblePath(fp)) return;   // the plan file can live only in memory

    const parts = fp.split('/').filter(Boolean);
    let kind = null, handle = null;
    try {
        handle = await getHandleByPath(fp);
        kind = 'file';
    } catch (e) {
        if (e && e.name === 'TypeMismatchError') {
            try { handle = await getDirectoryHandleByPath(fp, false); kind = 'directory'; } catch (e2) {}
        }
    }

    if (!kind) {
        // Gone from disk: drop it (and anything beneath it) from the registry.
        if (cur) {
            for (const k of Object.keys(registry.meta)) {
                if (k === fp || k.startsWith(fp + '/')) {
                    if (registry.meta[k] && (registry.meta[k].virtual || registry.meta[k].attachment)) continue;
                    delete registry.meta[k];
                }
            }
            renderExplorerTree();
        }
        return;
    }

    let added = false;
    // Make sure every ancestor folder is known so the explorer can show the file.
    let dirPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
        dirPath = dirPath ? `${dirPath}/${parts[i]}` : parts[i];
        if (!registry.meta[dirPath]) {
            let dh = null;
            try { dh = await getDirectoryHandleByPath(dirPath, false); } catch (e) {}
            registry.meta[dirPath] = { kind: 'directory', size: 0, isBinary: false, handle: dh };
            added = true;
        }
    }
    if (!cur || cur.kind !== kind) {
        registry.meta[fp] = kind === 'file'
            ? { kind: 'file', size: 0, isBinary: isBinaryByExtension(parts[parts.length - 1]), handle }
            : { kind: 'directory', size: 0, isBinary: false, handle };
        added = true;
    } else {
        cur.handle = handle;
    }
    if (added) renderExplorerTree();
    if (isSkillPath(fp) && typeof window.scanWorkspaceSkills === 'function') {
        window.scanWorkspaceSkills().catch(() => {});
    }
}

// --- AST_EXPORTS_START ---
window.refreshPathMeta = refreshPathMeta;
// --- AST_EXPORTS_END ---

// --- removeFromRecentFolders.js ---
function removeFromRecentFolders(folderName) {
    const folders = getRecentFolders().filter(f => f.name !== folderName);
    saveRecentFolders(folders);
    renderRecentFoldersList();
}

// --- AST_EXPORTS_START ---
window.removeFromRecentFolders = removeFromRecentFolders;
// --- AST_EXPORTS_END ---

// --- renderRecentFoldersList.js ---
function renderRecentFoldersList() {
    if (!recentFoldersList) return;
    const folders = getRecentFolders().filter(f => f.virtual || f.type === 'webdav' || HAS_FS_API);
    folders.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (folders.length === 0) {
        recentFoldersSection.style.display = 'none';
        return;
    }
    recentFoldersSection.style.display = 'block';
    recentFoldersList.innerHTML = folders.map(folder => {
        const isWebDAV = folder.type === 'webdav';
        const editBtn = folder.virtual
            ? `<button class="recent-folder-edit icon-btn" data-edit-vid="${escapeHTML(folder.vid)}" data-edit-name="${escapeHTML(folder.name)}" title="Rename virtual workspace"><span class="icon" style="font-size:14px;">edit</span></button>`
            : (isWebDAV
                ? `<button class="recent-folder-edit icon-btn" data-edit-webdav="${escapeHTML(folder.name)}" data-webdav-url="${escapeHTML(folder.url || '')}" data-webdav-path="${escapeHTML(folder.webdavPath || '')}" title="Edit WebDAV setup"><span class="icon" style="font-size:14px;">edit</span></button>`
                : '');
        const iconStr = folder.virtual ? 'cloud_queue' : (isWebDAV ? 'dns' : 'folder');
        const dataAttrs = folder.virtual 
            ? `data-vid="${escapeHTML(folder.vid)}"` 
            : (isWebDAV 
                ? `data-webdav="true" data-webdav-url="${escapeHTML(folder.url || '')}" data-webdav-path="${escapeHTML(folder.webdavPath || '')}"` 
                : '');
        return `
        <div class="recent-folder-item" data-folder-name="${escapeHTML(folder.name)}" ${dataAttrs} title="${escapeHTML(folder.name)}">
            <span class="icon folder-icon ${folder.virtual || isWebDAV ? 'filled' : ''}">${iconStr}</span>
            <div class="recent-folder-info">
                <div class="recent-folder-name">${escapeHTML(folder.name)}</div>
            </div>
            ${editBtn}
            <button class="recent-folder-remove icon-btn" data-remove-name="${escapeHTML(folder.name)}" ${folder.virtual ? `data-remove-vid="${escapeHTML(folder.vid)}"` : ''} ${isWebDAV ? `data-remove-webdav="true" data-remove-url="${escapeHTML(folder.url || '')}" data-remove-path="${escapeHTML(folder.webdavPath || '')}"` : ''} title="${folder.virtual ? 'Delete virtual workspace' : 'Remove from list'}">
                <span class="icon" style="font-size:14px;">close</span>
            </button>
        </div>
    `; }).join('');

    recentFoldersList.querySelectorAll('.recent-folder-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            if (isNoFolderOverlayHidden()) return;
            if (e.target.closest('.recent-folder-remove')) return;
            if (e.target.closest('.recent-folder-edit')) return;

            const folderName = item.dataset.folderName;
            if (rootHandle) await closeWorkspaceNoConfirm();
            if (item.dataset.vid) { await openVirtualWorkspaceById(item.dataset.vid); return; }
            if (item.dataset.webdav) {
                const folders = getRecentFolders();
                const reqUrl = item.dataset.webdavUrl || '';
                const reqPath = item.dataset.webdavPath || '';
                const f = folders.find(x => x.type === 'webdav' && x.name === folderName && (x.url || '') === reqUrl && (x.webdavPath || '') === reqPath)
                    || folders.find(x => x.type === 'webdav' && (x.url || '') === reqUrl && (x.webdavPath || '') === reqPath)
                    || folders.find(x => x.name === folderName && x.type === 'webdav');
                if (f) {
                    try {
                        const handle = new WebDAVDirHandle(f.url, f.webdavPath || '/', f.auth, f.name);
                        await handle._checkExists('');
                        await setWorkspace(handle);
                        markRecentFolderAccessed(folderName, f);
                    } catch(e) {
                        showToast('Failed to connect to WebDAV workspace: ' + e.message, 'error');
                    }
                }
                return;
            }

            try {
                const handle = await loadRecentHandleFromDB(folderName);
                if (handle) {
                    const perm = await handle.requestPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        markRecentFolderAccessed(folderName);
                        await setWorkspace(handle);
                        return;
                    }
                }
            } catch (err) { /* fall through to picker */ }

            // Handle gone or permission denied -> let user repick
            try {
                const newHandle = await pickFolderWithMemory();
                await setWorkspace(newHandle);
                await addToRecentFolders(newHandle);
            } catch (e2) { /* user cancelled */ }
        });
    });

    recentFoldersList.querySelectorAll('.recent-folder-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isNoFolderOverlayHidden()) return;
            if (btn.dataset.removeVid) { removeVirtualWorkspace(btn.dataset.removeVid, btn.dataset.removeName); return; }
            if (btn.dataset.removeWebdav) {
                const folders = getRecentFolders().filter(f => !(f.type === 'webdav' && f.name === btn.dataset.removeName && (f.url || '') === (btn.dataset.removeUrl || '') && (f.webdavPath || '') === (btn.dataset.removePath || '')));
                saveRecentFolders(folders);
                renderRecentFoldersList();
                return;
            }
            removeFromRecentFolders(btn.dataset.removeName);
        });
    });

    recentFoldersList.querySelectorAll('.recent-folder-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isNoFolderOverlayHidden()) return;
            if (btn.dataset.editWebdav) {
                const folders = getRecentFolders();
                const f = folders.find(x => x.type === 'webdav' && x.name === btn.dataset.editWebdav && (x.url || '') === (btn.dataset.webdavUrl || '') && (x.webdavPath || '') === (btn.dataset.webdavPath || ''))
                    || folders.find(x => x.type === 'webdav' && x.name === btn.dataset.editWebdav);
                if (f && typeof window.openWebDAVConfig === 'function') {
                    window.openWebDAVConfig(f);
                }
                return;
            }
            if (!btn.dataset.editVid) return;   // only virtual workspaces are editable
            const vid = btn.dataset.editVid;
            const origName = btn.dataset.editName;
            const nameEl = btn.closest('.recent-folder-item')?.querySelector('.recent-folder-name');
            if (!nameEl) return;

            // Guard: if already editing, focus the existing input and return.
            if (nameEl.querySelector('input.recent-folder-name-input')) {
                nameEl.querySelector('input.recent-folder-name-input').focus();
                return;
            }

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'recent-folder-name-input';
            input.value = origName;
            input.maxLength = 60;
            input.spellcheck = false;
            input.autocomplete = 'off';
            input.setAttribute('data-editing-vid', vid);

            function commit() {
                const newName = input.value.replace(/[\/\\]/g, '-').trim();
                if (!newName) { showToast('Name cannot be empty', 'error'); return; }
                if (newName === origName) { renderRecentFoldersList(); return; }

                // Update recent-folders entry in localStorage (by vid, not name).
                const folders = getRecentFolders();
                const f = folders.find(x => x.vid === vid);
                if (f) { f.name = newName; saveRecentFolders(folders); }

                // If the workspace is currently open, rename the live VFS root and
                // persist to IndexedDB via the debounced flush.
                if (rootHandle && rootHandle.isVirtual && rootHandle._n && rootHandle._n._ws && rootHandle._n._ws.vid === vid) {
                    rootHandle._n.name = newName;
                    vfsChanged(rootHandle._n);
                    updateWorkspaceTitle();
                    updateSessionPillLabel();
                }
                renderRecentFoldersList();
            }

            function cancel() {
                nameEl.textContent = '';
                renderRecentFoldersList();
            }

            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', () => {
                // Only commit if this input is still the active editor for this row
                // (i.e. renderRecentFoldersList() hasn't rebuilt the list yet).
                if (nameEl.querySelector('input.recent-folder-name-input') === input) commit();
            });

            nameEl.textContent = '';
            nameEl.appendChild(input);
            input.focus();
            input.select();
        });
    });
}

// --- AST_EXPORTS_START ---
window.renderRecentFoldersList = renderRecentFoldersList;
// --- AST_EXPORTS_END ---

// --- runSyncWorkspace.js ---
async function runSyncWorkspace(silent = true) {
    if (!rootHandle || state.isSaving) return;

    try {
        const perm = await rootHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
            return;
        }
    } catch(e) {
        return;
    }

    try {
        // Scan, and rescan if a write/delete/rename landed on disk while we were walking the tree.
        let newMeta, epoch, tries = 0;
        do {
            epoch = wsMutationEpoch;
            gitignoreCache.clear();

            let fastData = null;
            if (rootHandle.isWebDAV && typeof rootHandle.fetchFastTree === 'function') {
                fastData = await rootHandle.fetchFastTree();
            }

            if (fastData && Array.isArray(fastData.entries)) {
                newMeta = {};
                // Register .gitignore files and cache inlined .agent text files
                for (const entry of fastData.entries) {
                    if (entry.content !== undefined) {
                        if (entry.path === '.gitignore' || entry.path.endsWith('/.gitignore')) {
                            if (typeof registerGitignoreRules === 'function') {
                                registerGitignoreRules(entry.path, entry.content);
                            }
                        }
                        if (entry.path.startsWith('.agent/') || entry.path.startsWith('.agent\\')) {
                            registry.files[entry.path] = entry.content;
                        }
                    }
                }

                const FileCtor = window.WebDAVFileHandle || (typeof WebDAVFileHandle !== 'undefined' ? WebDAVFileHandle : null);
                const DirCtor = window.WebDAVDirHandle || (typeof WebDAVDirHandle !== 'undefined' ? WebDAVDirHandle : null);

                for (const entry of fastData.entries) {
                    const name = entry.path.split('/').pop();
                    if (typeof shouldSkipScanEntry === 'function' && shouldSkipScanEntry(name, entry.path)) {
                        continue;
                    }
                    if (entry.kind === 'file') {
                        const fileWebdavPath = rootHandle.path + entry.path;
                        const fileHandle = FileCtor ? new FileCtor(rootHandle.url, fileWebdavPath, rootHandle.auth, name) : null;
                        newMeta[entry.path] = {
                            kind: 'file',
                            size: entry.size || 0,
                            mtime: entry.mtime,
                            isBinary: typeof isBinaryByExtension === 'function' ? isBinaryByExtension(name) : false,
                            handle: fileHandle
                        };
                    } else if (entry.kind === 'directory') {
                        const dirWebdavPath = rootHandle.path + entry.path + '/';
                        const dirHandle = DirCtor ? new DirCtor(rootHandle.url, dirWebdavPath, rootHandle.auth, name) : null;
                        newMeta[entry.path] = {
                            kind: 'directory',
                            size: 0,
                            isBinary: false,
                            handle: dirHandle
                        };
                    }
                }
            } else {
                await prescanGitignoreFiles(rootHandle, "");
                newMeta = {};
                await fastTraverseDirectory(rootHandle, "", newMeta);
            }
        } while (epoch !== wsMutationEpoch && ++tries < 3);
        // If it still raced, only add/update this round; removals wait for the next clean scan.
        const allowRemoval = epoch === wsMutationEpoch;

        if (registry.files[PLAN_FILE] && !newMeta[PLAN_FILE]) {
            newMeta[PLAN_FILE] = { kind: 'file', size: registry.files[PLAN_FILE].length, isBinary: false };
        }

        const structChanged = mergeWorkspaceMeta(newMeta, allowRemoval);

        registerToolsVirtualFiles();
        registerModelsVirtualFile();
        registerConfigVirtualFile();
        registerPromptsVirtualFile();
        registerAttachmentsVirtualFiles();

        if (typeof window.scanWorkspaceSkills === 'function') {
            await window.scanWorkspaceSkills();
        }

        if (structChanged || !silent) {
            renderExplorerTree();
            renderChangesPanel();
            updateStatusInfo();
        }

        await saveWorkspaceCacheToDB(wsStorageName(rootHandle), registry.meta);

        if (state.activeTab && state.activeTab !== 'chat' && !state.activeTab.startsWith('filediff:')) {
            const fp = state.activeTab;
            const meta = registry.meta[fp];
            if (meta && meta.kind === 'file' && !meta.isBinary) {
                // Avoid redundant re-reading if size and mtime have not changed
                const contentAlreadyLoaded = registry.files[fp] !== undefined;
                const mtimeUnchanged = meta.mtime !== undefined && meta._syncedMtime === meta.mtime;
                const sizeUnchanged = meta.size !== undefined && meta._syncedSize === meta.size;
                if (!contentAlreadyLoaded || !mtimeUnchanged || !sizeUnchanged) {
                    const freshContent = await readFileContent(fp);
                    meta._syncedMtime = meta.mtime;
                    meta._syncedSize = meta.size;
                    if (monacoEditor && !isFileDirty(fp)) {
                        const model = monacoModels.get(fp);
                        if (model && model.getValue() !== freshContent) {
                            withDirtyTrackingSuppressed(() => model.setValue(freshContent));
                            registry.files[fp] = freshContent;
                        }
                    }
                }
            }
        }

    } catch(e) {
    }
}

// --- AST_EXPORTS_START ---
window.runSyncWorkspace = runSyncWorkspace;
// --- AST_EXPORTS_END ---

// --- saveRecentFolders.js ---
function saveRecentFolders(folders) {
    let realCount = 0;   // virtual & webdav workspaces are never evicted
    const keep = folders.filter(f => f.virtual || f.type === 'webdav' || (realCount++ < MAX_RECENT_FOLDERS));
    localStorage.setItem('recent_folders_json', JSON.stringify(keep));
}

// --- AST_EXPORTS_START ---
window.saveRecentFolders = saveRecentFolders;
// --- AST_EXPORTS_END ---

// --- saveRecentHandleToDB.js ---
async function saveRecentHandleToDB(name, handle) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_HANDLES, 'readwrite');
        tx.objectStore(STORE_HANDLES).put(handle, 'recent_' + name);
        return new Promise(res => tx.oncomplete = res);
    } catch(e) {}
}

// --- AST_EXPORTS_START ---
window.saveRecentHandleToDB = saveRecentHandleToDB;
// --- AST_EXPORTS_END ---

// --- setWorkspace.js ---
async function setWorkspace(handle) {
    if (rootHandle && rootHandle !== handle) {
        await closeWorkspaceNoConfirm();
    }
    if (typeof resetToolRegistry === 'function') {
        resetToolRegistry();
    }
    rootHandle = handle;
    updateWorkspaceTitle();

    if (btnExitWorkspace) btnExitWorkspace.style.display = 'inline-flex';
    if (btnSessionToggle) btnSessionToggle.style.display = 'inline-flex';
    const wsBtnSet = document.getElementById('btn-workspace-display');
    if (wsBtnSet) wsBtnSet.style.display = 'inline-flex';
    const wsSepSet = document.getElementById('header-ws-sep');
    if (wsSepSet) wsSepSet.style.display = '';
    const sessionSepSet = document.getElementById('header-session-sep');
    if (sessionSepSet) sessionSepSet.style.display = '';
    const brandBtnSet = document.getElementById('btn-header-brand');
    if (brandBtnSet) {
        brandBtnSet.title = 'workbench (click to close workspace)';
        brandBtnSet.classList.add('can-exit');
    }

    registry.files = {};
    registry.originalFiles = {};
    registry.opsLog = {};
    registry.compressionHistory = [];
    state.modifiedFiles.clear();
    state.linesAdded = 0;
    state.linesRemoved = 0;

    // Run syncWorkspace first to retrieve the fast tree and inline .agent configurations
    await syncWorkspace(true);

    await syncAgentFilesWithWorkspace();

    applyConfigToUI();
    registerConfigVirtualFile();
    if (typeof registerToolsVirtualFile === 'function') {
        registerToolsVirtualFile();
    }
    if (typeof renderToolsList === 'function') {
        renderToolsList();
    }
    if (typeof refreshPermBanner === 'function') {
        refreshPermBanner();
    }

    await selectInitialSession();
    await syncWorkspace(true);
    await restoreActiveSessionContent();
    renderSessionPopoverList();

    const noFolderOverlay = document.getElementById('no-folder-overlay');
    if (noFolderOverlay) noFolderOverlay.classList.add('hidden');

    // Open a workspace with the sidebar expanded. If it is currently collapsed
    // (e.g. freshly loaded, or left collapsed after closing a previous workspace),
    // expand it and restore its saved width.
    if (sidebarEl.classList.contains('collapsed') && window.innerWidth > 768) {
        setSidebarCollapsed(false);
        if (savedSidebarWidth) applySidebarWidth(savedSidebarWidth);
    }

    updateStatusInfo();
    renderExplorerTree();
    renderChangesPanel();
    if (typeof setupWebDAVEvents === 'function') setupWebDAVEvents(handle);
    focusPrompt();
}

// --- AST_EXPORTS_START ---
window.setWorkspace = setWorkspace;
// --- AST_EXPORTS_END ---

// --- syncAgentFilesWithWorkspace.js ---
async function syncAgentFilesWithWorkspace() {
    if (!rootHandle) return;
    const wsKey = wsStorageName(rootHandle);

    if (rootHandle.isWebDAV && AppConfig.get('webdav-sync-agent') !== 'true') {
        try {
            const wsConfigKey = `app_config_${wsKey}`;
            const storedConfig = localStorage.getItem(wsConfigKey);
            if (storedConfig) {
                AppConfig._data = { ...CONFIG_DEFAULTS, ...JSON.parse(storedConfig) };
            } else {
                AppConfig._data = { ...CONFIG_DEFAULTS };
            }
            localStorage.setItem('app_config_json', JSON.stringify(AppConfig._data));

            const wsModelsKey = `models_${wsKey}`;
            const storedModels = localStorage.getItem(wsModelsKey);
            if (storedModels) {
                const p = JSON.parse(storedModels);
                if (isValidProvidersShape(p)) {
                    MODEL_PROVIDERS = p;
                    ensureModelUuids();
                    localStorage.setItem('models_json', JSON.stringify(MODEL_PROVIDERS));
                }
            }

            const wsPromptsKey = `mode_prompts_${wsKey}`;
            const storedPrompts = localStorage.getItem(wsPromptsKey);
            if (storedPrompts) {
                MODE_PROMPTS = JSON.parse(storedPrompts);
                localStorage.setItem('mode_prompts_json', JSON.stringify(MODE_PROMPTS));
            }

            const wsToolsKey = `tools_config_${wsKey}`;
            const storedTools = localStorage.getItem(wsToolsKey);
            let toolsCfg = null;
            if (storedTools) {
                try { toolsCfg = JSON.parse(storedTools); } catch(e) {}
            }
            if (!toolsCfg || typeof toolsCfg !== 'object') {
                toolsCfg = typeof toolsDefaults === 'function' ? toolsDefaults() : {};
            }
            if (typeof setWorkspaceToolsConfig === 'function') {
                setWorkspaceToolsConfig(toolsCfg);
            }
            const filesMap = typeof loadToolFilesState === 'function' ? loadToolFilesState() : {};
            if (Array.isArray(toolsCfg.customTools)) {
                for (const t of toolsCfg.customTools) {
                    if (t.enabled !== false && filesMap[t.name]) {
                        const fp = t.file || toolFilePath(t.name);
                        registry.files[fp] = filesMap[t.name];
                        registry.meta[fp] = { kind: 'file', size: filesMap[t.name].length, isBinary: false, virtual: true };
                    }
                }
            }
            if (typeof rebuildToolRegistryFromFiles === 'function') {
                rebuildToolRegistryFromFiles();
            }
            if (typeof registerToolsVirtualFiles === 'function') {
                registerToolsVirtualFiles();
            }
        } catch(e) {}
        return;
    }

    let hasAgentDir = false;
    try {
        await getDirectoryHandleByPath(CUSTOM_TOOLS_DIR, false);
        hasAgentDir = true;
    } catch (e) {}

    if (hasAgentDir) {
        const readDisk = async (path) => {
            if (registry.files[path] !== undefined) return registry.files[path];
            try {
                const h = await getHandleByPath(path);
                if (!h) return null;
                const f = await h.getFile();
                const text = await f.text();
                registry.files[path] = text;
                return text;
            } catch(e) { return null; }
        };

        const mText = await readDisk(MODELS_FILE);
        if (mText) {
            try { 
                const p = JSON.parse(mText);
                if (isValidProvidersShape(p)) {
                    MODEL_PROVIDERS = p; 
                    ensureModelUuids();
                    localStorage.setItem('models_json', JSON.stringify(MODEL_PROVIDERS));
                }
            } catch(e) {}
        } else {
            await writeAgentFileToDisk(MODELS_FILE, modelsFileContent());
        }

        const cText = await readDisk(CONFIG_FILE);
        if (cText) {
            try {
                const c = JSON.parse(cText);
                AppConfig._data = { ...CONFIG_DEFAULTS, ...c };
                localStorage.setItem('app_config_json', JSON.stringify(AppConfig._data));
            } catch(e) {}
        } else {
            await writeAgentFileToDisk(CONFIG_FILE, configFileText());
        }

        let loadedPrompts = new Set();
        const promptPaths = Object.keys(registry.meta).filter(k => k.startsWith(PROMPTS_DIR + '/') && k.endsWith('.md'));
        if (promptPaths.length > 0) {
            for (const pPath of promptPaths) {
                const pText = await readDisk(pPath);
                if (pText) {
                    const body = stripPromptFileHeader(pText);
                    const mode = pPath.slice((PROMPTS_DIR + '/').length, -3);
                    if (body) {
                        MODE_PROMPTS[mode] = body;
                        loadedPrompts.add(mode);
                        if (!PROMPT_MODE_ORDER.includes(mode)) {
                            PROMPT_MODE_ORDER.push(mode);
                            MODE_PROMPT_FILES[mode] = pPath;
                            PROMPT_FILE_MODES[pPath] = mode;
                        }
                    }
                }
            }
        } else {
            try {
                const pDir = await getDirectoryHandleByPath(PROMPTS_DIR, false);
                if (pDir) {
                    for await (const entry of pDir.values()) {
                        if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                            const text = await (await entry.getFile()).text();
                            const body = stripPromptFileHeader(text);
                            const mode = entry.name.slice(0, -3);
                            if (body) {
                                MODE_PROMPTS[mode] = body;
                                loadedPrompts.add(mode);
                                if (!PROMPT_MODE_ORDER.includes(mode)) {
                                    PROMPT_MODE_ORDER.push(mode);
                                    MODE_PROMPT_FILES[mode] = `${PROMPTS_DIR}/${entry.name}`;
                                    PROMPT_FILE_MODES[`${PROMPTS_DIR}/${entry.name}`] = mode;
                                }
                            }
                        }
                    }
                }
            } catch(e) {}
        }

        for (const mode of PROMPT_MODE_ORDER) {
            if (loadedPrompts.has(mode)) continue;
            const pText = await readDisk(MODE_PROMPT_FILES[mode]);
            if (pText) {
                const body = stripPromptFileHeader(pText);
                if (body) MODE_PROMPTS[mode] = body;
            } else {
                await writeAgentFileToDisk(MODE_PROMPT_FILES[mode], promptFileContent(mode));
            }
        }
        localStorage.setItem('mode_prompts_json', JSON.stringify(MODE_PROMPTS));

        let tDir = null;
        try {
            tDir = await getDirectoryHandleByPath(TOOLS_DIR, false);
        } catch(e) {}

        const toolsManifestText = await readDisk(TOOLS_FILE);
        let toolsConfig = null;
        if (toolsManifestText) {
            try {
                toolsConfig = JSON.parse(toolsManifestText);
            } catch(e) {}
        }

        if (toolsConfig && typeof toolsConfig === 'object') {
            if (typeof reconcileWorkspaceTools === 'function') {
                await reconcileWorkspaceTools(tDir);
            } else if (typeof setWorkspaceToolsConfig === 'function') {
                setWorkspaceToolsConfig(toolsConfig);
            }
        } else {
            if (typeof reconcileWorkspaceTools === 'function') {
                toolsConfig = await reconcileWorkspaceTools(tDir);
            } else if (typeof setWorkspaceToolsConfig === 'function') {
                toolsConfig = typeof toolsDefaults === 'function' ? toolsDefaults() : {};
                setWorkspaceToolsConfig(toolsConfig);
            }
            if (toolsConfig) {
                await writeAgentFileToDisk(TOOLS_FILE, JSON.stringify(toolsConfig, null, 2) + '\n');
            }
        }

        const activeCfg = typeof getWorkspaceToolsConfig === 'function' ? getWorkspaceToolsConfig() : null;
        if (activeCfg && Array.isArray(activeCfg.customTools)) {
            const filesMap = typeof loadToolFilesState === 'function' ? loadToolFilesState() : {};
            let filesMapChanged = false;
            for (const t of activeCfg.customTools) {
                const fp = t.file || toolFilePath(t.name);
                const diskContent = await readDisk(fp);
                if (diskContent !== null) {
                    registry.files[fp] = diskContent;
                    registry.meta[fp] = { kind: 'file', size: diskContent.length, isBinary: false, virtual: true };
                    filesMap[t.name] = diskContent;
                    filesMapChanged = true;
                } else if (filesMap[t.name]) {
                    registry.files[fp] = filesMap[t.name];
                    registry.meta[fp] = { kind: 'file', size: filesMap[t.name].length, isBinary: false, virtual: true };
                    await writeAgentFileToDisk(fp, filesMap[t.name]);
                }
            }
            if (filesMapChanged && typeof saveToolFilesState === 'function') {
                saveToolFilesState(filesMap);
            }
        }
        if (typeof rebuildToolRegistryFromFiles === 'function') {
            rebuildToolRegistryFromFiles();
        }
        if (typeof registerToolsVirtualFiles === 'function') {
            registerToolsVirtualFiles();
        }

    } else {
        await writeAgentFileToDisk(MODELS_FILE, modelsFileContent());
        await writeAgentFileToDisk(CONFIG_FILE, configFileText());

        for (const mode of PROMPT_MODE_ORDER) {
            await writeAgentFileToDisk(MODE_PROMPT_FILES[mode], promptFileContent(mode));
        }

        const cleanDefaults = typeof toolsDefaults === 'function' ? toolsDefaults() : {};
        if (typeof setWorkspaceToolsConfig === 'function') {
            setWorkspaceToolsConfig(cleanDefaults);
        }
        if (typeof saveWorkspaceToolsState === 'function') {
            saveWorkspaceToolsState(wsKey, cleanDefaults);
        }
        await writeAgentFileToDisk(TOOLS_FILE, JSON.stringify(cleanDefaults, null, 2) + '\n');

        if (typeof rebuildToolRegistryFromFiles === 'function') {
            rebuildToolRegistryFromFiles();
        }
        if (typeof registerToolsVirtualFiles === 'function') {
            registerToolsVirtualFiles();
        }
    }
}

// --- AST_EXPORTS_START ---
window.syncAgentFilesWithWorkspace = syncAgentFilesWithWorkspace;
// --- AST_EXPORTS_END ---

// --- syncWorkspace.js ---
// bumped by every raw write/delete/mkdir/rename; lets a scan detect that it raced a change

        function syncWorkspace(silent = true) {
            if (!rootHandle || state.isSaving) return Promise.resolve();
            // Chain instead of dropping: an explicit refresh must actually run, not be
            // swallowed by a background pass that is already in flight, or a write that
            // just landed on disk can stay invisible to tools for seconds.
            // A job that is queued but has not started yet will still scan after this call, so share it.
            if (syncQueuedJob) {
                if (!silent) syncQueuedJob.silent = false;
                return syncQueuedJob.promise;
            }
            const job = { silent };
            job.promise = syncWorkspaceChain
                .catch(() => {})
                .then(() => { syncQueuedJob = null; return runSyncWorkspace(job.silent); });
            syncQueuedJob = job;
            syncWorkspaceChain = job.promise;
            return job.promise;
        }

// --- AST_EXPORTS_START ---
window.syncWorkspace = syncWorkspace;
// --- AST_EXPORTS_END ---

// --- updateWorkspaceTitle.js ---
// ======================= Virtual workspaces =======================
// An in-memory filesystem that implements the same handle API as the File System Access API
// (getFileHandle / getDirectoryHandle / removeEntry / values / createWritable / move ...), so the
// rest of the app treats it exactly like a real folder. Nothing is written to the user's disk;
// a snapshot is kept in the browser's IndexedDB so the workspace survives a reload.
function updateWorkspaceTitle() {
    const row = document.getElementById('ws-popover-row'), nm = document.getElementById('ws-popover-name'), ic = document.getElementById('ws-popover-icon');
    if (!row || !nm) return;
    const name = rootHandle ? (rootHandle.displayName || rootHandle.name) : '';
    nm.textContent = name;
    if (ic) ic.textContent = rootHandle && rootHandle.isVirtual ? 'cloud_queue' : (rootHandle && rootHandle.isWebDAV ? 'dns' : 'folder');
    const sideIc = document.getElementById('sidebar-files-icon');
    if (sideIc) sideIc.textContent = rootHandle && rootHandle.isVirtual ? 'cloud_queue' : (rootHandle && rootHandle.isWebDAV ? 'dns' : 'folder');
    row.title = rootHandle ? (rootHandle.isVirtual ? 'Virtual workspace: ' : (rootHandle.isWebDAV ? 'WebDAV workspace: ' : 'Workspace: ')) + name : '';
    row.style.display = name ? 'inline-flex' : 'none';
    const sep = document.getElementById('ws-popover-sep');
    if (sep) sep.style.display = name ? '' : 'none';

    const wsBtn = document.getElementById('btn-workspace-display');
    const wsBtnName = document.getElementById('workspace-btn-name');
    const wsBtnIcon = document.getElementById('workspace-btn-icon');
    if (wsBtn) {
        if (rootHandle && name) {
            wsBtn.style.display = 'inline-flex';
            if (wsBtnName) wsBtnName.textContent = name;
            const iconName = rootHandle.isVirtual ? 'cloud_queue' : (rootHandle.isWebDAV ? 'dns' : 'folder');
            if (wsBtnIcon) wsBtnIcon.textContent = iconName;
            wsBtn.title = (rootHandle.isVirtual ? 'Virtual workspace: ' : (rootHandle.isWebDAV ? 'WebDAV workspace: ' : 'Workspace: ')) + name;
            if (!wsBtn._boundClick) {
                wsBtn._boundClick = true;
                wsBtn.addEventListener('click', () => {
                    if (typeof sessionsPopoverOverlay !== 'undefined' && sessionsPopoverOverlay.style.display === 'block') {
                        hideSessionPopover();
                    } else {
                        showSessionPopover();
                    }
                });
            }
        } else {
            wsBtn.style.display = 'none';
        }
    }

    const btnSession = document.getElementById('btn-session-toggle');
    if (btnSession) btnSession.style.display = (rootHandle && name) ? 'inline-flex' : 'none';

    const btnExit = document.getElementById('btn-exit-workspace');
    if (btnExit) btnExit.style.display = (rootHandle && name) ? 'inline-flex' : 'none';

    const wsSep = document.getElementById('header-ws-sep');
    if (wsSep) wsSep.style.display = (rootHandle && name) ? '' : 'none';

    const sessionSep = document.getElementById('header-session-sep');
    if (sessionSep) sessionSep.style.display = (rootHandle && name) ? '' : 'none';

    const brandBtn = document.getElementById('btn-header-brand');
    if (brandBtn) {
        brandBtn.title = (rootHandle && name) ? 'workbench (click to close workspace)' : 'workbench';
        brandBtn.classList.toggle('can-exit', !!(rootHandle && name));
    }
}

// --- AST_EXPORTS_START ---
window.updateWorkspaceTitle = updateWorkspaceTitle;
// --- AST_EXPORTS_END ---

let _webdavEventSource = null;
let _webdavSseDebounce = null;

function closeWebDAVEvents() {
    if (_webdavEventSource) {
        try { _webdavEventSource.close(); } catch(e) {}
        _webdavEventSource = null;
    }
    if (_webdavSseDebounce) {
        clearTimeout(_webdavSseDebounce);
        _webdavSseDebounce = null;
    }
    window._webdavEventSource = null;
}

function setupWebDAVEvents(handle) {
    closeWebDAVEvents();
    if (!handle || !handle.isWebDAV) return;

    try {
        let subpath = handle.path || '/';
        if (subpath.startsWith('/webdav/')) {
            subpath = subpath.slice('/webdav'.length);
        } else if (subpath === '/webdav') {
            subpath = '/';
        }
        subpath = subpath.replace(/^\/+|\/+$/g, '');

        const base = handle.url.startsWith('http://') || handle.url.startsWith('https://')
            ? handle.url
            : (typeof window !== 'undefined' && window.location ? new URL(handle.url, window.location.href).href : handle.url);
        const sseUrl = new URL('/api/webdav/events', base);
        if (subpath) {
            sseUrl.searchParams.set('path', subpath);
        }

        const es = new EventSource(sseUrl.href);
        _webdavEventSource = es;
        window._webdavEventSource = es;

        es.addEventListener('change', () => {
            clearTimeout(_webdavSseDebounce);
            _webdavSseDebounce = setTimeout(() => {
                if (rootHandle === handle && !state.isSaving) {
                    syncWorkspace(true);
                }
            }, 200);
        });

        es.onerror = () => {
            closeWebDAVEvents();
        };
    } catch(e) {}
}

window.setupWebDAVEvents = setupWebDAVEvents;
window.closeWebDAVEvents = closeWebDAVEvents;

// --- wsStorageName.js ---
function wsStorageName(h) { 
    if (h && h.isVirtual) return 'virtual_' + h.vid; 
    if (h && h.isWebDAV) {
        if (h.wsKey) return h.wsKey;
        const cleanName = (h.name || 'webdav').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
        const raw = `${(h.url || '').toLowerCase()}|${h.path || '/'}|${h.auth?.user || ''}|${h.name || ''}`;
        let h1 = 0xdeadbeef ^ 0, h2 = 0x41c64e6d ^ 0;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
        return `webdav_${cleanName}_${hash}`;
    }
    return h ? h.name : ''; 
}

// --- AST_EXPORTS_START ---
window.wsStorageName = wsStorageName;
// --- AST_EXPORTS_END ---