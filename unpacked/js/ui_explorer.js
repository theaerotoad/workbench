import '../js/constants.js';
import '../js/state_manager.js';
import '../js/dom.js';
import * as FS from '../js/fs_core.js';
import './modules/fs_utils.js';
import './modules/sessions_core.js';
import './modules/sessions_storage.js';
import './modules/checkpoints_core.js';
import './modules/checkpoints_ui.js';
import './modules/tools_registry.js';
import './modules/tools_permissions.js';
import './modules/tools_ui.js';
import './modules/workspace_core.js';
import './modules/workspace_explorer.js';
import './modules/workspace_transfer.js';
import './modules/prompt_modes.js';
import './modules/prompt_compression.js';
import './modules/ui_dialogs.js';
import './modules/ui_layout.js';
import './modules/task_runner.js';
import './modules/chat_render.js';
import './modules/chat_tool_boxes.js';
import './modules/chat_terminal.js';
import './modules/chat_input.js';
import './modules/chat_models.js';

import '../js/fs.js';
import '../js/webdav.js';
import '../js/vfs.js';
btnSidebarCollapse.addEventListener('click', () => setSidebarCollapsed(!sidebarEl.classList.contains('collapsed')));

sidebarEl.addEventListener('click', (e) => {
    if (!sidebarEl.classList.contains('collapsed')) return;
    if (window.innerWidth <= 768) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target === btnSidebarCollapse || btnSidebarCollapse.contains(target)) return;
    if (target.closest('.sidebar-nav-tab')) return; // handled by its own toggle handler
    const actionable = target.closest('button, input, [id="file-tree"], .sidebar-header-actions, .tree-node');
    if (actionable) setSidebarCollapsed(false);
}, true);

resizerEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (sidebarEl.classList.contains('collapsed')) setSidebarCollapsed(false);
    resizing = true;
    resizerEl.setPointerCapture(e.pointerId);
    resizerEl.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = sidebarEl.getBoundingClientRect().width;
    const onMove = (ev) => {
        if (!resizing) return;
        applySidebarWidth(startW + (ev.clientX - startX));
    };
    const onUp = () => {
        resizing = false;
        resizerEl.classList.remove('dragging');
        document.body.classList.remove('resizing');
        resizerEl.releasePointerCapture(e.pointerId);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        AppConfig.set('sidebar-width', String(clampSidebarWidth(parseInt(sidebarEl.style.width, 10) || 314)));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
});

// Re-clamp if the window shrinks below the current sidebar width.
window.addEventListener('resize', () => {
    if (sidebarEl.classList.contains('collapsed') || window.innerWidth <= 768) return;
    const w = clampSidebarWidth(parseInt(sidebarEl.style.width, 10) || 314);
    if (w !== parseInt(sidebarEl.style.width, 10)) applySidebarWidth(w);
});

tabNavExplorer.addEventListener('click', () => toggleNavTab(tabNavExplorer, viewExplorer));
tabNavChanges.addEventListener('click', () => toggleNavTab(tabNavChanges, viewChanges));
tabNavSettings.addEventListener('click', () => toggleNavTab(tabNavSettings, viewSettings));

searchInput.addEventListener('input', () => {
    updateSearchClearButton();
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(runWorkspaceSearch, 250);
});

searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    updateSearchClearButton();
    clearTimeout(searchDebounceTimer);
    runWorkspaceSearch();
    searchInput.focus();
});

tabNavSearch.addEventListener('click', () => {
    toggleNavTab(tabNavSearch, viewSearch);
    if (!sidebarEl.classList.contains('collapsed')) {
        searchInput.focus();
        searchInput.select();
    }
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchDebounceTimer);
        runWorkspaceSearch();
    }
});

window.executePlan = async () => {
    const planText = await readFileContent(PLAN_FILE);
    if (!planText || !planText.trim()) {
        showToast(`No ${PLAN_FILE} found. Switch to Plan mode and create a plan first.`, 'error');
        return;
    }
    setMode('code');
    const promptText = `Execute the approved implementation plan from ${PLAN_FILE}:\n\n${planText}\n\nExecute all steps and finish implementation.`;
    await runTask(promptText);
};
document.addEventListener('click', () => {
    contextMenu.style.display = 'none';
});

fileTreeEl.addEventListener('contextmenu', (e) => {
    // Anywhere in the tree that is not a node (empty space) acts as the workspace root.
    if (!e.target.closest('.tree-node')) {
        showContextMenu(e, null);
    }
});

contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (item.classList.contains('disabled')) return;
        contextMenu.style.display = 'none';
        const action = item.getAttribute('data-action');
        const node = state.selectedContextItem;
        if (!node && action !== 'new-file' && action !== 'new-folder' && action !== 'upload-files') return;   // empty space = workspace root
        if (!contextItemApplies(item.getAttribute('data-scope'), node)) return;
        const targetDir = node ? (node.kind === 'directory' ? node.path : node.path.split('/').slice(0, -1).join('/')) : "";
        if (action === 'new-file') {
            const name = (await promptDialog('New file name:', 'new_file.txt', { confirmLabel: 'Create', validate: (v) => validateEntryName(v) }))?.trim();
            if (!name) return;
            const fullPath = targetDir ? `${targetDir}/${name}` : name;
            if (isAgentPath(fullPath)) {
                showToast('Cannot create files inside .agent', 'error');
                return;
            }
            await writeDisk(fullPath, "");
            await openFileTab(fullPath);
            await syncWorkspace(false);
        } else if (action === 'new-folder') {
            const name = (await promptDialog('New folder name:', 'new_folder', { confirmLabel: 'Create', validate: (v) => validateEntryName(v) }))?.trim();
            if (!name) return;
            const fullPath = targetDir ? `${targetDir}/${name}` : name;
            if (isAgentPath(fullPath)) {
                showToast('Cannot create folders inside .agent', 'error');
                return;
            }
            await fs.mkdir(fullPath, { mode: 'ui' });
            state.expandedFolders.add(fullPath);
            await syncWorkspace(false);
        } else if (action === 'download') {
            downloadPath(node.path);
        } else if (action === 'download-zip') {
            downloadZip(node.path);
        } else if (action === 'upload-files') {
            wsUploadTargetDir = targetDir;
            document.getElementById('ws-upload-input').click();
        } else if (action === 'open-tab') {
            if (node.kind !== 'directory') openFileTab(node.path);
        } else if (action === 'view-diff') {
            window.openFileDiff(node.path);
        } else if (action === 'attach-prompt') {
            // Right-clicking inside a multi-selection attaches every selected file (folders are skipped).
            const inMulti = explorerSelection.size > 1 && explorerSelection.has(node.path);
            const filePaths = inMulti
                ? visibleExplorerPaths().filter(pth => explorerSelection.has(pth) && registry.meta[pth] && registry.meta[pth].kind !== 'directory')
                : [node.path];
            const already = new Set(state.attachedReferences.filter(r => r.type === 'file').map(r => r.filepath));
            const toAttach = filePaths.filter(pth => !already.has(pth) || !inMulti);
            toAttach.forEach(pth => attachReference({ type: 'file', filepath: pth }));
        } else if (action === 'set-background') {
            if (node && node.kind !== 'directory' && typeof window.setWorkspaceImageAsBackground === 'function') {
                await window.setWorkspaceImageAsBackground(node.path);
            }
        } else if (action === 'rename') {
            const newName = (await promptDialog(`Rename "${node.name}" to:`, node.name, { confirmLabel: 'Rename', validate: (v) => validateEntryName(v, { allowSlash: false }) }))?.trim();
            if (!newName || newName === node.name) return;
            const oldPath = node.path;
            const parent = oldPath.split('/').slice(0, -1).join('/');
            const newPath = parent ? `${parent}/${newName}` : newName;
            try {
                const res = await fs.rename(oldPath, newPath, { mode: 'ui' });
                if (res && res.error) {
                    showToast(res.error, 'error');
                    return;
                }
                if (state.openTabs.includes(oldPath)) {
                    state.openTabs[state.openTabs.indexOf(oldPath)] = newPath;
                    if (state.activeTab === oldPath) state.activeTab = newPath;
                }
                await syncWorkspace(false);
            } catch(err) {
                showToast(`Rename failed: ${err.message}`, 'error');
            }
        } else if (action === 'delete') {
            const picked = (explorerSelection.size > 1 && explorerSelection.has(node.path))
                ? Array.from(explorerSelection).filter(pth => registry.meta[pth]).map(pth => ({ name: pth.split('/').pop(), path: pth, kind: registry.meta[pth].kind || 'file' }))
                : [node];
            await deleteExplorerNodes(picked);
        } else if (action === 'restore-default') {
            if (!await confirmDialog(`Restore ${node.name} to its built-in default? Your current content will be lost.`, { confirmLabel: 'Restore', danger: true })) return;
            const res = restoreAgentFile(node.path);
            if (res.error) {
                showToast(res.error, 'error');
            }
        }
    });
});

// Clicking empty space in the explorer clears the selection (row clicks stop propagation, so only blank area gets here).
fileTreeEl.addEventListener('click', (e) => {
    if (e.target.closest('.tree-node')) return;
    explorerSelection.clear();
    explorerAnchor = null;
    explorerSelectionCleared = true;
    updateExplorerSelection();
    fileTreeEl.focus({ preventScroll: true });
});

// Explorer keyboard: with the explorer focused, Del (Cmd+Backspace on macOS) removes the selected items.
fileTreeEl.tabIndex = 0;
fileTreeEl.addEventListener('keydown', async (e) => {
    const isDel = e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey);
    if (!isDel || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.target !== fileTreeEl) return;   // ignore keys from inline inputs inside the tree
    const nodes = getExplorerSelectedPaths().map(p => ({ name: p.split('/').pop(), path: p, kind: registry.meta[p].kind || 'file' }));
    if (!nodes.length) return;
    e.preventDefault();
    e.stopPropagation();
    await deleteExplorerNodes(nodes);
});

btnNewFile.addEventListener('click', async () => {
    const name = (await promptDialog('New file name:', 'new_file.txt', { confirmLabel: 'Create', validate: (v) => validateEntryName(v) }))?.trim();
    if (!name) return;
    if (isAgentPath(name)) {
        showToast('Cannot create files inside .agent', 'error');
        return;
    }
    await writeDisk(name, "");
    await openFileTab(name);
    await syncWorkspace(false);
});

btnNewFolder.addEventListener('click', async () => {
    const name = (await promptDialog('New folder name:', 'new_folder', { confirmLabel: 'Create', validate: (v) => validateEntryName(v) }))?.trim();
    if (!name) return;
    if (isAgentPath(name)) {
        showToast('Cannot create folders inside .agent', 'error');
        return;
    }
    await fs.mkdir(name, { mode: 'ui' });
    state.expandedFolders.add(name);
    await syncWorkspace(false);
});

btnCollapseAll.addEventListener('click', () => {
    state.expandedFolders.clear();
    renderExplorerTree();
});

btnReloadTree.addEventListener('click', async () => await syncWorkspace(false));

let _lastAutoSync = Date.now();

setInterval(() => {
    // Throttle background polling for remote (WebDAV) workspaces to avoid network spam.
    // Local/Virtual workspaces get 3s polling, WebDAV gets 30s.
    if (!rootHandle) return;
    if (document.hidden) return;
    // When WebDAV SSE stream is connected, server pushes changes in real-time: skip interval polling
    if (window._webdavEventSource && window._webdavEventSource.readyState === 1) {
        return;
    }
    const isRemote = rootHandle && rootHandle.isWebDAV;
    const intervalMs = isRemote ? 30000 : 3000;
    if (Date.now() - _lastAutoSync >= intervalMs) {
        _lastAutoSync = Date.now();
        syncWorkspace(true);
    }
}, 1000);

window.addEventListener('focus', () => { 
    if (!rootHandle) return;
    if (Date.now() - _lastAutoSync >= 5000) {
        _lastAutoSync = Date.now();
        syncWorkspace(true); 
    }
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rootHandle) {
        if (Date.now() - _lastAutoSync >= 5000) {
            _lastAutoSync = Date.now();
            syncWorkspace(true);
        }
    }
});

window.confirmDialog = confirmDialog;
window.promptDialog = promptDialog;

['dragover', 'drop'].forEach(evt => window.addEventListener(evt, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files') && !e.defaultPrevented) e.preventDefault();
}));

(function wireExplorerFileDrop() {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.id = 'ws-upload-input'; input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
        const list = Array.from(input.files).map(f => ({ path: f.name, file: f }));
        input.value = '';
        await addFilesToWorkspace(list, wsUploadTargetDir);
        wsUploadTargetDir = '';
    });
    document.getElementById('btn-upload-files').addEventListener('click', () => { wsUploadTargetDir = ''; input.click(); });
    document.getElementById('btn-download-zip').addEventListener('click', () => downloadZip(''));
    const ioBtn = document.getElementById('btn-explorer-io'), ioMenu = document.getElementById('explorer-io-menu');
    const closeIo = () => { ioMenu.classList.remove('open'); ioBtn.classList.remove('active'); ioBtn.setAttribute('aria-expanded', 'false'); };
    ioBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ioMenu.classList.contains('open')) { closeIo(); return; }
        const r = ioBtn.getBoundingClientRect();
        ioMenu.classList.add('open');
        const w = ioMenu.offsetWidth;
        ioMenu.style.top = (r.bottom + 6) + 'px';
        ioMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        ioBtn.classList.add('active'); ioBtn.setAttribute('aria-expanded', 'true');
        if (typeof contextMenu !== 'undefined') contextMenu.style.display = 'none';
    });
    ioMenu.addEventListener('click', (e) => { e.stopPropagation(); if (e.target.closest('.context-menu-item')) closeIo(); });
    document.addEventListener('click', closeIo);
    window.addEventListener('resize', closeIo);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeIo(); });
    const zone = document.getElementById('sidebar-view-explorer');
    let hl = null;
    const hasFiles = e => !!e.dataTransfer && (Array.from(e.dataTransfer.types || []).includes('Files') ||
        Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file'));
    const clear = () => { zone.classList.remove('drop-active'); if (hl) { hl.classList.remove('drop-target'); hl = null; } };
    const targetFor = (e) => {
        const n = e.target.closest && e.target.closest('.tree-node[data-path]');
        if (!n) return { dir: '', el: null };
        const p = n.getAttribute('data-path'), m = registry.meta[p];
        return (m && m.kind === 'directory') ? { dir: p, el: n } : { dir: p.split('/').slice(0, -1).join('/'), el: null };
    };
    ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, (e) => {
        if (!hasFiles(e) || !rootHandle) return;
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
        const t = targetFor(e);
        if (hl && hl !== t.el) hl.classList.remove('drop-target');
        hl = t.el; if (hl) hl.classList.add('drop-target');
        zone.classList.toggle('drop-active', !t.el);
    }));
    // Chromium reports relatedTarget = null on dragleave, so decide from the pointer position instead.
    zone.addEventListener('dragleave', (e) => {
        const r = zone.getBoundingClientRect();
        if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) clear();
    });
    zone.addEventListener('drop', (e) => {
        if (!hasFiles(e) || !rootHandle) return;
        e.preventDefault(); e.stopPropagation();
        const t = targetFor(e);
        clear();
        const pending = collectDropped(e.dataTransfer);   // starts synchronously, captures entries now
        pending.then(list => {
            if (!list.length) { showToast('Nothing could be read from the drop', 'error'); return; }
            return addFilesToWorkspace(list, t.dir);
        }).catch(err => showToast('Drop failed: ' + (err && err.message || err), 'error'));
    });
})();

// ---- "New Virtual Workspace" dialog ----
(function wireVirtualWorkspaceDialog() {
    const openBtn = document.getElementById('no-folder-virtual-btn');
    if (!openBtn) return;
    if (!HAS_FS_API) {
        // Browsers without showDirectoryPicker can't open real folders: offer virtual workspaces only.
        document.documentElement.classList.add('no-fsa');
        const realBtn = document.getElementById('no-folder-btn');
        if (realBtn) { realBtn.style.display = 'none'; realBtn.hidden = true; }
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px; color:var(--dim); max-width:260px; text-align:center; margin:-6px 0 14px;';
        note.textContent = 'This browser can\'t open folders from disk, so workspaces are virtual (kept in the browser). Use a Chromium-based browser for real folders.';
        openBtn.insertAdjacentElement('afterend', note);
    }
    let pending = new Map();   // path -> { path, file?, dir? }
    let backdrop = null;
    const hasFilesEv = e => !!e.dataTransfer && (Array.from(e.dataTransfer.types || []).includes('Files') ||
        Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file'));
    const fmt = (n) => (typeof formatFileSize === 'function' ? formatFileSize(n) : n + ' B');
    function render() {
        const list = backdrop.querySelector('#vws-list');
        const items = Array.from(pending.values()).sort((a, b) => a.path.localeCompare(b.path));
        list.innerHTML = items.map(it => `
            <div class="vws-row" data-path="${escapeHTML(it.path)}">
                <span class="icon" style="cursor:default; color:var(--dim);">${it.dir ? 'folder' : 'description'}</span>
                <span class="vws-path" title="${escapeHTML(it.path)}">${escapeHTML(it.path)}</span>
                <span class="vws-size">${it.dir ? '' : fmt(it.file.size)}</span>
                <span class="icon vws-remove" title="Remove">close</span>
            </div>`).join('');
        list.querySelectorAll('.vws-remove').forEach(b => b.addEventListener('click', () => {
            pending.delete(b.parentElement.getAttribute('data-path')); render();
        }));
        const files = items.filter(i => !i.dir);
        const total = files.reduce((s, i) => s + i.file.size, 0);
        backdrop.querySelector('#vws-summary').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${fmt(total)}` : 'No files yet (you can add them later)';
    }
    function add(list) { list.forEach(it => pending.set(it.path, it)); render(); }
    function close() { if (backdrop) { backdrop.remove(); backdrop = null; } pending = new Map(); }
    function open() {
        if (backdrop) return;
        backdrop = document.createElement('div');
        backdrop.className = 'vws-backdrop';
        backdrop.innerHTML = `
            <div class="vws-card" role="dialog" aria-label="New virtual workspace">
                <div class="vws-title"><span class="icon">cloud_queue</span><span>New Virtual Workspace</span></div>
                <input type="text" id="vws-name" value="Virtual Workspace" maxlength="60" spellcheck="false" autocomplete="off">
                <div class="vws-drop" id="vws-drop">
                    <span class="icon">upload_file</span>
                    <div>Drop files or folders here</div>
                    <div class="vws-links">
                        <button type="button" class="vws-link" id="vws-pick-files">Browse files</button>
                    </div>
                </div>
                <div id="vws-list"></div>
                <div class="vws-actions">
                    <span class="vws-summary" id="vws-summary"></span>
                    <button type="button" class="vws-btn" id="vws-cancel">Cancel</button>
                    <button type="button" class="vws-btn primary" id="vws-create">Create</button>
                </div>
                <input type="file" multiple id="vws-in-files" style="display:none">
            </div>`;
        document.body.appendChild(backdrop);
        const $ = (s) => backdrop.querySelector(s);
        const drop = $('#vws-drop');
        $('#vws-pick-files').addEventListener('click', () => $('#vws-in-files').click());
        $('#vws-in-files').addEventListener('change', (e) => { add(Array.from(e.target.files).map(f => ({ path: f.name, file: f }))); e.target.value = ''; });
        ['dragenter', 'dragover'].forEach(evt => backdrop.addEventListener(evt, (e) => {
            if (!hasFilesEv(e)) return;
            e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; drop.classList.add('over');
        }));
        backdrop.addEventListener('dragleave', (e) => {
            if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) drop.classList.remove('over');
        });
        backdrop.addEventListener('drop', (e) => {
            e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
            collectDropped(e.dataTransfer).then(list => {
                if (!list.length) { showToast('Nothing could be read from the drop', 'error'); return; }
                add(list);
            }).catch(err => showToast('Drop failed: ' + (err && err.message || err), 'error'));
        });
        $('#vws-cancel').addEventListener('click', close);
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.target.id === 'vws-name') $('#vws-create').click(); });
        function updateNameToUnique() {
            const el = $('#vws-name');
            const raw = el.value.replace(/[\/\\]/g, '-').trim();
            if (!raw) return;
            const existing = new Set(getRecentFolders().map(f => f.name));
            if (!existing.has(raw)) return;
            let n = 2;
            while (existing.has(raw + ' (' + n + ')')) n++;
            el.value = raw + ' (' + n + ')';
        }
        $('#vws-create').addEventListener('click', async () => {
            const name = $('#vws-name').value.replace(/[\/\\]/g, '-').trim();
            if (!name) { $('#vws-name').focus(); return; }
            const list = Array.from(pending.values());
            close();
            try {
                if (rootHandle && state.dirtyFiles && state.dirtyFiles.size > 0) {
                    const count = state.dirtyFiles.size;
                    const ok = await confirmDialog(
                        `You have unsaved changes in ${count} file${count === 1 ? '' : 's'}. Switch workspaces and discard unsaved changes?`,
                        { confirmLabel: 'Switch & Discard', danger: true }
                    );
                    if (!ok) return;
                }
                if (rootHandle) await closeWorkspaceNoConfirm();
                const handle = await createVirtualWorkspace(name, list);
                const folders = getRecentFolders().filter(f => f.vid !== handle.vid);
                folders.unshift({ name, virtual: true, vid: handle.vid, lastAccessed: Date.now() });
                saveRecentFolders(folders);
                await setWorkspace(handle);
                renderRecentFoldersList();
            } catch (err) { showToast('Could not create workspace: ' + err.message, 'error'); }
        });
        render();
        updateNameToUnique();
        const nameEl = $('#vws-name'); nameEl.focus(); nameEl.select();
    }
    window.openVirtualWorkspaceDialog = () => open();
    openBtn.addEventListener('click', () => { if (!isNoFolderOverlayHidden()) open(); });
})();

(function wireWebDAVDialog() {
    const webdavBtn = document.getElementById('no-folder-webdav-btn');
    if (!webdavBtn) return;
    const modal = document.getElementById('webdav-modal-overlay');
    const cancelBtn = document.getElementById('webdav-cancel');
    const saveBtn = document.getElementById('webdav-save');
    const connectBtn = document.getElementById('webdav-connect');
    const nameInput = document.getElementById('webdav-name');
    const urlInput = document.getElementById('webdav-url');
    const rootPathInput = document.getElementById('webdav-root-path');
    const userInput = document.getElementById('webdav-user');
    const passInput = document.getElementById('webdav-pass');
    function close() {
        modal.style.display = 'none';
        editingWebDAVFolder = null;
        if (nameInput) nameInput.value = '';
        urlInput.value = '';
        if (rootPathInput) rootPathInput.value = '';
        userInput.value = '';
        passInput.value = '';
        if (saveBtn) saveBtn.style.display = 'none';
    }
    let editingWebDAVFolder = null;
    function open(existingFolder = null) {
        editingWebDAVFolder = existingFolder;
        modal.style.display = 'flex';
        const modalTitle = modal.querySelector('.vws-title span:last-child');
        if (existingFolder) {
            if (modalTitle) modalTitle.textContent = 'Edit WebDAV Workspace';
            connectBtn.textContent = 'Save & Connect';
            if (saveBtn) saveBtn.style.display = 'inline-flex';
            if (nameInput) nameInput.value = existingFolder.name || '';
            urlInput.value = existingFolder.url || '';
            if (rootPathInput) rootPathInput.value = existingFolder.webdavPath || '';
            userInput.value = existingFolder.auth?.user || '';
            passInput.value = existingFolder.auth?.pass || '';
            (nameInput || urlInput).focus();
        } else {
            if (modalTitle) modalTitle.textContent = 'Connect WebDAV Workspace';
            connectBtn.textContent = 'Connect';
            if (saveBtn) saveBtn.style.display = 'none';
            urlInput.focus();
        }
    }
    window.openWebDAVConfig = (folder) => open(folder);
    webdavBtn.addEventListener('click', () => { if (!isNoFolderOverlayHidden()) open(); });
    cancelBtn.addEventListener('click', close);
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            let urlStr = urlInput.value.trim();
            if (!urlStr) { showToast('Server URL is required', 'error'); urlInput.focus(); return; }
            if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) urlStr = 'https://' + urlStr;
            let urlObj;
            try {
                urlObj = new URL(urlStr);
            } catch(e) {
                showToast('Invalid Server URL', 'error'); return;
            }
            const user = userInput.value.trim();
            const pass = passInput.value;
            const auth = user ? { user, pass } : null;
            const rootPathStr = (rootPathInput ? rootPathInput.value : '').trim();

            let normPath = urlObj.pathname && urlObj.pathname !== '/' ? urlObj.pathname.replace(/\/+$/, '') : '';
            if (rootPathStr) {
                const sub = rootPathStr.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                if (sub) normPath = normPath ? `${normPath}/${sub}/` : `/${sub}/`;
                else normPath = normPath ? `${normPath}/` : '/';
            } else {
                normPath = normPath ? `${normPath}/` : '/';
            }

            const customName = (nameInput ? nameInput.value : '').trim();
            const name = customName || (normPath !== '/' ? normPath.replace(/^\/+|\/+$/g, '').split('/').pop() : urlObj.hostname);

            let folders = getRecentFolders();
            const originalEditing = editingWebDAVFolder;
            if (originalEditing) {
                folders = folders.filter(f => !(f.type === 'webdav' && f.url === originalEditing.url && (f.webdavPath || '') === (originalEditing.webdavPath || '') && (originalEditing.name ? f.name === originalEditing.name : true)));
            } else {
                folders = folders.filter(f => !(f.type === 'webdav' && f.url === urlObj.origin && (f.webdavPath || '') === normPath));
            }
            folders.unshift({ name, type: 'webdav', url: urlObj.origin, webdavPath: normPath, auth, lastAccessed: Date.now() });
            saveRecentFolders(folders);

            if (rootHandle && rootHandle.isWebDAV && originalEditing && rootHandle.url === originalEditing.url && rootHandle.path === originalEditing.webdavPath) {
                if (rootHandle.url !== urlObj.origin || rootHandle.path !== normPath) {
                    if (typeof closeWorkspaceNoConfirm === 'function') {
                        closeWorkspaceNoConfirm();
                    }
                } else {
                    rootHandle.name = name;
                    rootHandle.path = normPath;
                if (auth) rootHandle.auth = auth;
                updateWorkspaceTitle();
                }
            }

            renderRecentFoldersList();
            showToast('WebDAV settings saved', 'success');
            close();
        });
    }
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') connectBtn.click();
    });
    connectBtn.addEventListener('click', async () => {
        let urlStr = urlInput.value.trim();
        if (!urlStr) { showToast('Server URL is required', 'error'); urlInput.focus(); return; }
        if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) urlStr = 'https://' + urlStr;
        let urlObj;
        try {
            urlObj = new URL(urlStr);
        } catch(e) {
            showToast('Invalid Server URL', 'error'); return;
        }
        const user = userInput.value.trim();
        const pass = passInput.value;
        const auth = user ? { user, pass } : null;
        const rootPathStr = (rootPathInput ? rootPathInput.value : '').trim();
        const customName = (nameInput ? nameInput.value : '').trim();
        const originalEditing = editingWebDAVFolder;
        try {
            connectBtn.textContent = 'Connecting...';
            connectBtn.disabled = true;
            const handle = await WebDAVDirHandle.openOrCreate(
                urlObj.origin,
                urlObj.pathname,
                rootPathStr,
                auth,
                customName,
                urlObj.hostname
            );
            if (rootHandle && state.dirtyFiles && state.dirtyFiles.size > 0) {
                const count = state.dirtyFiles.size;
                const ok = await confirmDialog(
                    `You have unsaved changes in ${count} file${count === 1 ? '' : 's'}. Switch workspaces and discard unsaved changes?`,
                    { confirmLabel: 'Switch & Discard', danger: true }
                );
                if (!ok) {
                    close();
                    return;
                }
            }
            if (rootHandle) await closeWorkspaceNoConfirm();
            let folders = getRecentFolders();
            if (originalEditing) {
                folders = folders.filter(f => !(f.type === 'webdav' && f.url === originalEditing.url && (f.webdavPath || '') === (originalEditing.webdavPath || '') && (originalEditing.name ? f.name === originalEditing.name : true)));
            } else {
                folders = folders.filter(f => !(f.type === 'webdav' && f.url === urlObj.origin && (f.webdavPath || '') === (handle.path || '')));
            }
            folders.unshift({ name: handle.name, type: 'webdav', url: urlObj.origin, webdavPath: handle.path, auth, lastAccessed: Date.now() });
            saveRecentFolders(folders);
            await setWorkspace(handle);
            renderRecentFoldersList();
            close();
        } catch(err) {
            showToast('WebDAV Connection Failed: ' + err.message, 'error');
        } finally {
            connectBtn.textContent = originalEditing ? 'Save & Connect' : 'Connect';
            connectBtn.disabled = false;
        }
    });
})();

async function openLocalFolderPicker() {
    if (rootHandle && state.dirtyFiles && state.dirtyFiles.size > 0) {
        const count = state.dirtyFiles.size;
        const ok = await confirmDialog(
            `You have unsaved changes in ${count} file${count === 1 ? '' : 's'}. Switch workspaces and discard unsaved changes?`,
            { confirmLabel: 'Switch & Discard', danger: true }
        );
        if (!ok) return;
    }
    try {
        const handle = await pickFolderWithMemory();
        if (rootHandle) await closeWorkspaceNoConfirm();
        await setWorkspace(handle);
        await addToRecentFolders(handle);
    } catch(e) {
        if (e && e.name !== 'AbortError') {   // AbortError = user cancelled
            markNoFsApi();
            showToast('This browser can\'t open folders from disk. Use a virtual workspace instead.', 'info', 4000);
        }
    }
}
window.openLocalFolderPicker = openLocalFolderPicker;

document.getElementById('no-folder-btn').addEventListener('click', async () => {
    if (isNoFolderOverlayHidden()) return;
    await openLocalFolderPicker();
});

if (btnExitWorkspace) {
    btnExitWorkspace.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (rootHandle) await closeWorkspaceNoConfirm();
    });
}