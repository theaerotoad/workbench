// --- activateSidebarView.js ---
function activateSidebarView(navTab, viewEl) {
    [tabNavExplorer, tabNavChanges, tabNavSearch, tabNavSettings].forEach(t => t.classList.remove('active'));
    [viewExplorer, viewChanges, viewSearch, viewSettings].forEach(v => v.style.display = 'none');
    navTab.classList.add('active');
    viewEl.style.display = 'flex';
}

// --- AST_EXPORTS_START ---
window.activateSidebarView = activateSidebarView;
// --- AST_EXPORTS_END ---

// --- applyImgTransform.js ---
function applyImgTransform(animate) {
    editorImagePreview.style.transition = animate ? 'transform 0.1s ease' : 'none';
    editorImagePreview.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom})`;
    imgScaleLabel.textContent = Math.round(imgZoom * 100) + '%';
}

// --- AST_EXPORTS_START ---
window.applyImgTransform = applyImgTransform;
// --- AST_EXPORTS_END ---

// --- applyTheme.js ---
function applyTheme() {
    const hex = currentAccent();
    const root = document.documentElement;
    const theme = AppConfig.get('ui-theme', 'dark');
    root.style.colorScheme = theme;
    if (theme === 'light') {
        root.classList.add('theme-light');
    } else {
        root.classList.remove('theme-light');
    }
    root.style.setProperty('--primary', hex);
    root.style.setProperty('--primary-rgb', hexToRgbTriplet(hex));
    root.style.setProperty('--primary-2', shadeHex(hex, 0.82));
    defineMonacoThemes();
}

// --- AST_EXPORTS_START ---
window.applyTheme = applyTheme;
// --- AST_EXPORTS_END ---

// --- applyWindowMode.js ---
function applyWindowMode(mode) {}

// --- AST_EXPORTS_START ---
window.applyWindowMode = applyWindowMode;
// --- AST_EXPORTS_END ---

// --- applySplitView.js ---
function applySplitView() {
    const isSplit = AppConfig.get('split-view-enabled') === 'true';
    if (isSplit) {
        document.body.classList.add('split-view-active');
        if (state.activeTab === 'chat' && state.openTabs.length > 1) {
            const fileTabs = state.openTabs.filter(t => t !== 'chat');
            if (fileTabs.length > 0) {
                switchTab(fileTabs[fileTabs.length - 1]);
            }
        }
    } else {
        document.body.classList.remove('split-view-active');
    }
    requestAnimationFrame(() => {
        if (window.monacoEditor) window.monacoEditor.layout();
        if (window.monacoDiffEditor) window.monacoDiffEditor.layout();
    });
}

// --- AST_EXPORTS_START ---
window.applySplitView = applySplitView;
// --- AST_EXPORTS_END ---

// --- clearFileDirty.js ---
function clearFileDirty(filepath) {
    if (state.dirtyFiles.has(filepath)) {
        state.dirtyFiles.delete(filepath);
        renderTabs();
    }
    if (state.currentEditorPath === filepath) {
        state.isEditorDirty = false;
        btnTabSave.classList.remove('dirty');
    }
}

// --- AST_EXPORTS_START ---
window.clearFileDirty = clearFileDirty;
// --- AST_EXPORTS_END ---

// --- closeTab.js ---
async function closeTab(tabId) {
    if (isFileDirty(tabId)) {
        const choice = await confirmSaveDiscard(`Do you want to save changes you made to ${tabId}?`);
        if (choice === 'cancel') return;
        if (choice === 'save') {
            const model = monacoModels.get(tabId);
            if (model) {
                try {
                    await writeDisk(tabId, model.getValue());
                } catch(err) {
                    showToast(`Save error: ${err.message}`, 'error');
                    return;
                }
            }
        }
        clearFileDirty(tabId);
    }
    state.openTabs = state.openTabs.filter(t => t !== tabId);
    if (state.activeTab === tabId) {
        switchTab(state.openTabs[state.openTabs.length - 1] || 'chat');
    } else {
        renderTabs();
        persistTabState();
    }
}

// --- AST_EXPORTS_START ---
window.closeTab = closeTab;
// --- AST_EXPORTS_END ---

// --- closeTabNoConfirm.js ---
function closeTabNoConfirm(tabId) {
    if (!state.openTabs.includes(tabId)) return;
    state.openTabs = state.openTabs.filter(t => t !== tabId);
    if (state.activeTab === tabId) {
        const prevTab = state.openTabs[state.openTabs.length - 1] || 'chat';
        switchTab(prevTab);
    } else {
        persistTabState();
    }
    if (tabId !== 'chat' && !tabId.startsWith('attachment:')) {
        const model = monacoModels.get(tabId);
        if (model) model.dispose();
        monacoModels.delete(tabId);
    }
}

// --- AST_EXPORTS_START ---
window.closeTabNoConfirm = closeTabNoConfirm;
// --- AST_EXPORTS_END ---

// --- currentAccent.js ---
function currentAccent() {
    const hex = normalizeHex(AppConfig.get('accent-color', DEFAULT_ACCENT));
    return hex || DEFAULT_ACCENT;
}

// --- AST_EXPORTS_START ---
window.currentAccent = currentAccent;
// --- AST_EXPORTS_END ---

// --- getDuoSwitch.js ---
function getDuoSwitch(el) {
    if (!el) return false;
    const onBtn = el.querySelector('[data-val="on"]');
    return !!(onBtn && onBtn.classList.contains('active'));
}

// --- AST_EXPORTS_START ---
window.getDuoSwitch = getDuoSwitch;
// --- AST_EXPORTS_END ---

// --- getOrCreateModel.js ---
// [AST_MERGED]: ./js/monaco.js


function getOrCreateModel(filepath, content) {
    const uri = MONACO.Uri.parse(`inmemory://agent2/${encodeURIComponent(filepath)}`);
    let model = monacoModels.get(filepath) || (MONACO.editor ? MONACO.editor.getModel(uri) : null);
    
    if (model) {
        if (content !== undefined && model.getValue() !== content && !isFileDirty(filepath)) {
            withDirtyTrackingSuppressed(() => model.setValue(content));
        }
    } else {
        model = MONACO.editor.createModel(content || '', langOf(filepath), uri);
    }
    monacoModels.set(filepath, model);
    return model;
}

// --- AST_EXPORTS_START ---
window.getOrCreateModel = getOrCreateModel;
// --- AST_EXPORTS_END ---

// --- hexToRgbTriplet.js ---
function hexToRgbTriplet(hex) {
    const h = (hex || '').replace('#', '');
    if (h.length !== 6) return '255, 122, 80';
    return parseInt(h.slice(0,2),16) + ', ' + parseInt(h.slice(2,4),16) + ', ' + parseInt(h.slice(4,6),16);
}

// --- AST_EXPORTS_START ---
window.hexToRgbTriplet = hexToRgbTriplet;
// --- AST_EXPORTS_END ---

// --- hideEditorSaveError.js ---
function hideEditorSaveError() {
    const errorEl = document.getElementById('editor-save-error');
    if (errorEl) {
        errorEl.style.display = 'none';
    }
}

// --- AST_EXPORTS_START ---
window.hideEditorSaveError = hideEditorSaveError;
// --- AST_EXPORTS_END ---

// --- imgOffsetFromCentre.js ---
// Offset of a client point from the image's untransformed centre, the space setImgZoom works in.
function imgOffsetFromCentre(clientX, clientY) {
    const r = editorImagePreview.getBoundingClientRect();
    // getBoundingClientRect reflects the current transform; its centre = untransformed centre + pan.
    const cxScreen = r.left + r.width / 2;
    const cyScreen = r.top + r.height / 2;
    return { x: clientX - (cxScreen - imgPanX), y: clientY - (cyScreen - imgPanY) };
}

// --- AST_EXPORTS_START ---
window.imgOffsetFromCentre = imgOffsetFromCentre;
// --- AST_EXPORTS_END ---

// --- imgZoomBy.js ---
function imgZoomBy(delta, cx = 0, cy = 0) {
    setImgZoom(imgZoom + (delta > 0 ? IMG_ZOOM_STEP_PCT / 100 : -IMG_ZOOM_STEP_PCT / 100), true, cx, cy);
}

// --- AST_EXPORTS_START ---
window.imgZoomBy = imgZoomBy;
// --- AST_EXPORTS_END ---

// --- initDuoSwitch.js ---
function initDuoSwitch(id, onChange) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', e => {
        const btn = e.target.closest('[data-val]');
        if (!btn) return;
        const isOn = btn.dataset.val === 'on';
        if (getDuoSwitch(el) === isOn) return;
        setDuoSwitch(el, isOn);
        onChange(isOn);
    });
}

// --- AST_EXPORTS_START ---
window.initDuoSwitch = initDuoSwitch;
// --- AST_EXPORTS_END ---

// --- isFileDirty.js ---
function isFileDirty(filepath) {
    return state.dirtyFiles.has(filepath);
}

// --- AST_EXPORTS_START ---
window.isFileDirty = isFileDirty;
// --- AST_EXPORTS_END ---

// --- markFileDirty.js ---
function markFileDirty(filepath) {
    if (!state.dirtyFiles.has(filepath)) {
        state.dirtyFiles.add(filepath);
        renderTabs();
    }
    if (state.currentEditorPath === filepath) {
        state.isEditorDirty = true;
        btnTabSave.classList.add('dirty');
        hideEditorSaveError();
    }
}

// --- AST_EXPORTS_START ---
window.markFileDirty = markFileDirty;
// --- AST_EXPORTS_END ---

// --- normalizeHex.js ---
function normalizeHex(v) {
    if (typeof v !== 'string') return null;
    let s = v.trim();
    if (s[0] === '#') s = s.slice(1);
    if (/^[0-9a-f]{3}$/i.test(s)) {
        s = s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
    }
    if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
    return null;
}

// --- AST_EXPORTS_START ---
window.normalizeHex = normalizeHex;
// --- AST_EXPORTS_END ---

// --- openAttachmentTab.js ---
async function openAttachmentTab(attachmentId) {
    const tabId = `attachment:${attachmentId}`;
    if (!state.openTabs.includes(tabId)) state.openTabs.push(tabId);
    await switchTab(tabId);
}

// --- AST_EXPORTS_START ---
window.openAttachmentTab = openAttachmentTab;
// --- AST_EXPORTS_END ---

// --- openFileTab.js ---
async function openFileTab(filepath, opts = {}) {
    if (!state.openTabs.includes(filepath)) {
        state.openTabs.push(filepath);
    }
    await switchTab(filepath, opts);
}

// --- AST_EXPORTS_START ---
window.openFileTab = openFileTab;
// --- AST_EXPORTS_END ---

// --- persistTabState.js ---
// Persist only the open-tab layout. saveSession() bails out when there is no new chat
// content, so tab opens/closes/switches were never written and closed tabs came back.
function persistTabState() {
    const id = state.activeSessionId;
    if (!id || deletedSessionIds.has(id) || !state.sessions[id]) return Promise.resolve(null);
    state.sessions[id].openTabs = state.openTabs.slice();
    state.sessions[id].activeTab = state.activeTab;
    return patchSessionRecordInDB(getWorkspaceSessionKey(), id, {
        openTabs: state.sessions[id].openTabs,
        activeTab: state.sessions[id].activeTab
    });
}

// --- AST_EXPORTS_START ---
window.persistTabState = persistTabState;
// --- AST_EXPORTS_END ---

// --- renderAccentSwatches.js ---
function renderAccentSwatches() {
    const wrap = document.getElementById('settings-accent-swatches');
    if (!wrap) return;
    if (accentSwatchesBuilt) {
        // Never rebuild the DOM while the native color picker may be open —
        // rebuilding destroys/recreates the input mid-interaction and closes it.
        updateAccentActiveState();
        return;
    }
    const cur = currentAccent().toLowerCase();
    ACCENT_PRESETS.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'accent-swatch' + (p.hex.toLowerCase() === cur ? ' active' : '');
        btn.style.setProperty('--sw', p.hex);
        btn.title = p.name;
        btn.setAttribute('data-hex', p.hex);
        btn.addEventListener('click', () => setAccent(p.hex));
        wrap.appendChild(btn);
    });
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'accent-custom' + (ACCENT_PRESETS.every(p => p.hex.toLowerCase() !== cur) ? ' active' : '');
    custom.value = currentAccent();
    custom.title = 'Custom color';
    custom.addEventListener('input', () => setAccent(custom.value));
    wrap.appendChild(custom);
    accentSwatchesBuilt = true;
}

// --- AST_EXPORTS_START ---
window.renderAccentSwatches = renderAccentSwatches;
// --- AST_EXPORTS_END ---

// --- renderTabs.js ---
function renderTabs() {
    tabsListContainer.innerHTML = '';
    state.openTabs.forEach(tabId => {
        const tab = document.createElement('div');
        tab.setAttribute('data-tab-id', tabId);
        const isFileDiff = tabId.startsWith('filediff:');
        const isAttachment = tabId.startsWith('attachment:');
        const isPlan = tabId === PLAN_FILE;
        tab.className = `editor-tab ${isFileDiff ? 'diff-tab' : ''} ${isPlan ? 'plan-tab' : ''} ${state.activeTab === tabId ? 'active' : ''}`;

        if (tabId === 'chat') {
            tab.innerHTML = `<span class="icon" style="font-size: 13px;">chat</span><span>chat</span>`;
            tab.addEventListener('click', () => switchTab('chat'));
        } else if (isFileDiff) {
            const rest = tabId.replace('filediff:', '');
            const parts = rest.split('::');
            const fp = parts[0];
            const isCheckpointDiff = parts.length === 3;
            const fname = fp.split('/').pop();
            tab.innerHTML = `<span class="icon" style="font-size: 13px; color: var(--primary);">${isCheckpointDiff ? 'schedule' : 'difference'}</span><span>${isCheckpointDiff ? 'history' : 'changes'}: ${escapeHTML(fname)}</span>`;
            tab.title = isCheckpointDiff ? `Checkpoint diff for ${fp}` : `Changes diff for ${fp}`;

            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close icon';
            closeBtn.innerText = 'close';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTab(tabId);
            });
            tab.appendChild(closeBtn);
            tab.addEventListener('click', () => switchTab(tabId));
        } else if (tabId.startsWith('render:')) {
            const filepath = tabId.replace('render:', '');
            const fname = filepath.split('/').pop();
            tab.innerHTML = `<span class="icon" style="font-size: 13px; color: var(--info);">preview</span><span>Render: ${escapeHTML(fname)}</span>`;
            tab.title = `Rendered Markdown: ${filepath}`;

            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close icon';
            closeBtn.innerText = 'close';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTab(tabId);
            });
            tab.appendChild(closeBtn);
            tab.addEventListener('click', () => switchTab(tabId));
        } else if (isAttachment) {
            const attId = tabId.replace('attachment:', '');
            let att = state.attachmentStore[attId];
            if (!att) {
                const imgEl = document.querySelector(`[data-attachment-id="${attId}"] img`);
                if (imgEl) {
                    att = { name: imgEl.alt || 'Attachment', dataUrl: imgEl.src, type: 'image', attachmentId: attId };
                    state.attachmentStore[attId] = att;
                }
            }
            const icon = att?.type === 'image' ? 'image' : 'description';
            const color = att?.type === 'image' ? 'var(--green)' : 'var(--yellow)';
            tab.innerHTML = `<span class="icon" style="font-size: 13px; color: ${color};">${icon}</span><span>${escapeHTML(att?.name || 'attachment')}</span>`;
            tab.title = att?.name || 'Pasted attachment';

            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close icon';
            closeBtn.innerText = 'close';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTab(tabId);
            });
            tab.appendChild(closeBtn);
            tab.addEventListener('click', () => switchTab(tabId));
        } else {
            const vInfo = getFileVisualInfo(tabId);
            const isDirty = isFileDirty(tabId);
            tab.innerHTML = `<span class="icon" style="font-size: 13px; color: ${vInfo.color};">${vInfo.icon}</span><span>${escapeHTML(tabId.split('/').pop())}</span>`;
            tab.title = isDirty ? `${tabId} (unsaved changes)` : tabId;

            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close icon';
            closeBtn.innerText = 'close';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTab(tabId);
            });

            if (isDirty) {
                const dot = document.createElement('span');
                dot.className = 'tab-dirty-dot';
                dot.title = 'Unsaved changes';
                tab.appendChild(dot);
                closeBtn.classList.add('has-dirty-dot');
            }

            tab.appendChild(closeBtn);
            tab.addEventListener('click', () => switchTab(tabId));
        }
        tabsListContainer.appendChild(tab);
    });

}

// --- AST_EXPORTS_START ---
window.renderTabs = renderTabs;
// --- AST_EXPORTS_END ---

// --- resetImgView.js ---
function resetImgView(animate) {
    imgZoom = 1; imgPanX = 0; imgPanY = 0;
    applyImgTransform(animate);
}

// --- AST_EXPORTS_START ---
window.resetImgView = resetImgView;
// --- AST_EXPORTS_END ---

// --- resolveGlowColor.js ---
function resolveGlowColor(status) {
    const v = GLOW_STATUS_COLORS[status];
    if (v.startsWith('var(')) {
        return getComputedStyle(document.documentElement).getPropertyValue('--primary-rgb').trim() || '86, 182, 194';
    }
    return v;
}

// --- AST_EXPORTS_START ---
window.resolveGlowColor = resolveGlowColor;
// --- AST_EXPORTS_END ---

// --- saveDiffModifiedFile.js ---
async function saveDiffModifiedFile() {
    if (state.isSaving || !state.currentDiffFilepath || !monacoDiffEditor) return;
    state.isSaving = true;
    try {
        const modEditor = monacoDiffEditor.getModifiedEditor();
        const content = modEditor.getValue();
        const isToolsConfig = state.currentDiffFilepath === (typeof TOOLS_FILE !== 'undefined' ? TOOLS_FILE : window.TOOLS_FILE) || state.currentDiffFilepath === '.agent/tools.json';

        if (isToolsConfig) {
            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch (jsonErr) {
                showToast(`Invalid JSON in tools.json: ${jsonErr.message}`, 'error');
                return;
            }
            if (typeof setWorkspaceToolsConfig === 'function') {
                setWorkspaceToolsConfig(parsed);
            }
            const wsKey = typeof getWorkspaceToolsKey === 'function' ? getWorkspaceToolsKey() : null;
            if (typeof saveWorkspaceToolsState === 'function') {
                saveWorkspaceToolsState(wsKey, parsed);
            }
            if (typeof rebuildToolRegistryFromFiles === 'function') {
                rebuildToolRegistryFromFiles();
            }
            if (typeof renderToolsList === 'function') {
                renderToolsList();
            }
            if (typeof refreshPermBanner === 'function') {
                refreshPermBanner();
            }
        }

        await writeDisk(state.currentDiffFilepath, content);

        if (typeof isToolFilePath === 'function' && isToolFilePath(state.currentDiffFilepath)) {
            if (typeof rebuildToolRegistryFromFiles === 'function') {
                rebuildToolRegistryFromFiles();
            }
            if (typeof renderToolsList === 'function') {
                renderToolsList();
            }
        }
    } catch(e) {
        showToast(`Diff save error: ${e.message}`, 'error');
    } finally {
        state.isSaving = false;
    }
}

// --- AST_EXPORTS_START ---
window.saveDiffModifiedFile = saveDiffModifiedFile;
// --- AST_EXPORTS_END ---

// --- saveEditorFile.js ---
async function saveEditorFile() {
    if (state.isSaving || !state.currentEditorPath || !monacoEditor) return;
    state.isSaving = true;
    btnTabSave.style.opacity = '0.6';
    hideEditorSaveError();

    try {
        const content = monacoEditor.getValue();
        const isToolsConfig = state.currentEditorPath === (typeof TOOLS_FILE !== 'undefined' ? TOOLS_FILE : window.TOOLS_FILE) || state.currentEditorPath === '.agent/tools.json';

        if (isToolsConfig) {
            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch (jsonErr) {
                showEditorSaveError(`Invalid JSON in tools.json: ${jsonErr.message}`);
                return;
            }
            if (typeof setWorkspaceToolsConfig === 'function') {
                setWorkspaceToolsConfig(parsed);
            }
            const wsKey = typeof getWorkspaceToolsKey === 'function' ? getWorkspaceToolsKey() : null;
            if (typeof saveWorkspaceToolsState === 'function') {
                saveWorkspaceToolsState(wsKey, parsed);
            }
            if (typeof rebuildToolRegistryFromFiles === 'function') {
                rebuildToolRegistryFromFiles();
            }
            if (typeof renderToolsList === 'function') {
                renderToolsList();
            }
            if (typeof refreshPermBanner === 'function') {
                refreshPermBanner();
            }
        }

        const res = await writeDisk(state.currentEditorPath, content);
        const saveFailed = res && res.output && res.output.startsWith('ERROR:');

        if (saveFailed) {
            showEditorSaveError(res.output);
            return;
        }

        if (typeof isToolFilePath === 'function' && isToolFilePath(state.currentEditorPath)) {
            if (typeof rebuildToolRegistryFromFiles === 'function') {
                rebuildToolRegistryFromFiles();
            }
            if (typeof renderToolsList === 'function') {
                renderToolsList();
            }
        }

        clearFileDirty(state.currentEditorPath);

        if (state.editorViewMode === 'preview') {
            updateHtmlPreview();
        }

        const saveIcon = btnTabSave.querySelector('.icon');
        if (saveIcon) {
            saveIcon.innerText = 'check';
            saveIcon.style.color = 'var(--green)';
            setTimeout(() => {
                saveIcon.innerText = 'save';
                saveIcon.style.color = '';
            }, 1200);
        }

    } catch(err) {
        showToast(`Save error: ${err.message}. Your changes are preserved.`, 'error');
    } finally {
        state.isSaving = false;
        btnTabSave.style.opacity = '1';
    }
}

// --- AST_EXPORTS_START ---
window.saveEditorFile = saveEditorFile;
// --- AST_EXPORTS_END ---

// --- saveFileAs.js ---
// Save As (Ctrl+Shift+S): writes the current editor contents (including unsaved edits) to a new
// workspace path and opens it in a new tab. The original file and its tab are left untouched.
async function saveFileAs() {
    if (state.isSavingAs || state.isSaving) return;

    let srcPath = null, content = null, isDiff = false;
    if (state.activeTab && state.activeTab.startsWith('filediff:') && state.currentDiffFilepath && monacoDiffEditor) {
        srcPath = state.currentDiffFilepath;
        content = monacoDiffEditor.getModifiedEditor().getValue();
        isDiff = true;
    } else if (state.activeTab && state.activeTab === state.currentEditorPath && monacoEditor) {
        // Only a real text tab: the editor's current model must belong to this path
        // (binary/image tabs keep a stale model from the previously opened file).
        const model = monacoModels.get(state.currentEditorPath);
        if (model && monacoEditor.getModel() === model) {
            srcPath = state.currentEditorPath;
            content = model.getValue();
        }
    }
    if (srcPath === null) return;

    state.isSavingAs = true;
    try {
        let target = null;
        let initial = srcPath;
        while (true) {
            const raw = await promptDialog('Save As\n\nPath relative to the workspace root:', initial, {
                confirmLabel: 'Save',
                validate: (v) => normalizeSaveAsPath(v).error || null,
            });
            if (raw === null) return; // cancelled
            target = normalizeSaveAsPath(raw).path;

            if (target === srcPath) {
                // Same path: behaves like a normal save.
                state.isSavingAs = false;
                await (isDiff ? saveDiffModifiedFile() : saveEditorFile());
                return;
            }

            const exists = (await fileExistsOnDisk(target)) || registry.files[target] !== undefined;
            if (exists) {
                const note = isFileDirty(target) ? ' Its open tab has unsaved changes that will be lost.' : '';
                const ok = await confirmDialog(`"${target}" already exists. Replace it?${note}`, { confirmLabel: 'Replace', danger: true });
                if (!ok) { initial = raw; continue; } // back to the path prompt
            }
            break;
        }

        const parent = target.split('/').slice(0, -1).join('/');
        if (parent && !(await workspaceDirExists(parent))) {
            const r = await fs.mkdir(parent, { mode: 'ui' });
            if (r && r.error) { showToast(r.error, 'error'); return; }
        }

        const res = await writeDisk(target, content);
        if ((res && res.output && res.output.startsWith('ERROR:')) || registry.files[target] !== content) {
            showToast(`Could not save as ${target}`, 'error');
            return;
        }

        await openFileTab(target);
        await syncWorkspace(false);
    } catch (err) {
        showToast(`Save As failed: ${err.message}`, 'error');
    } finally {
        state.isSavingAs = false;
    }
}

// --- AST_EXPORTS_START ---
window.saveFileAs = saveFileAs;
// --- AST_EXPORTS_END ---

// --- setAccent.js ---
function setAccent(hex) {
    const norm = normalizeHex(hex);
    if (!norm) return;
    AppConfig.set('accent-color', norm);
    updateAccentActiveState();
    applyTheme();
}

// --- AST_EXPORTS_START ---
window.setAccent = setAccent;
// --- AST_EXPORTS_END ---

// --- setDuoSwitch.js ---
function setDuoSwitch(el, isOn) {
    if (!el) return;
    el.querySelectorAll('[data-val]').forEach(btn => {
        const val = btn.dataset.val;
        const active = (val === 'on') === !!isOn;
        btn.className = `tri-btn ${val} ${active ? 'active ' + val : ''}`;
    });
}

// --- AST_EXPORTS_START ---
window.setDuoSwitch = setDuoSwitch;
// --- AST_EXPORTS_END ---

// --- setEditorSubView.js ---
function setEditorSubView(mode, opts = {}) {
    state.editorViewMode = mode;
    if (mode === 'preview') {
        btnViewPreview.classList.add('active');
        btnViewEdit.classList.remove('active');
        monacoContainer.style.display = 'none';
        htmlPreviewFrame.style.display = 'block';
        requestAnimationFrame(() => updateHtmlPreview());
    } else {
        btnViewEdit.classList.add('active');
        btnViewPreview.classList.remove('active');
        htmlPreviewFrame.style.display = 'none';
        monacoContainer.style.display = 'block';
        if (window.monacoEditor) {
            requestAnimationFrame(() => {
                window.monacoEditor.layout();
                if (opts.focus !== false) window.monacoEditor.focus();
            });
        }
    }
}

// --- AST_EXPORTS_START ---
window.setEditorSubView = setEditorSubView;
// --- AST_EXPORTS_END ---

// --- setFaviconBoltColor.js ---
const WORKBENCH_SVG_STATIC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">
  <polygon points="100,30 160,65 160,135 100,170 40,135 40,65" fill="none" stroke="#334155" stroke-width="8" stroke-linejoin="round" />
  <path d="M68 82 L84 120 L100 94 L116 120 L132 82" fill="none" stroke="#38BDF8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

const WORKBENCH_SVG_ANIMATED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">
  <defs>
    <style>
      .hex-edge {
        stroke: #38BDF8;
        stroke-width: 8;
        stroke-linecap: round;
        opacity: 0;
        animation: pulseEdge 6s infinite ease-in-out;
      }
      .edge-1 { animation-delay: 0s; }
      .edge-2 { animation-delay: 1s; }
      .edge-3 { animation-delay: 2s; }
      .edge-4 { animation-delay: 3s; }
      .edge-5 { animation-delay: 4s; }
      .edge-6 { animation-delay: 5s; }

      @keyframes pulseEdge {
        0% {
          opacity: 0;
          filter: drop-shadow(0 0 0px transparent);
        }
        3% {
          opacity: 1;
          filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.7));
        }
        14% {
          opacity: 1;
          filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.7));
        }
        20% {
          opacity: 0;
          filter: drop-shadow(0 0 0px transparent);
        }
        100% {
          opacity: 0;
        }
      }
    </style>
  </defs>
  <polygon points="100,30 160,65 160,135 100,170 40,135 40,65" fill="none" stroke="#334155" stroke-width="8" stroke-linejoin="round" />
  <line x1="100" y1="30" x2="160" y2="65" class="hex-edge edge-1" />
  <line x1="160" y1="65" x2="160" y2="135" class="hex-edge edge-2" />
  <line x1="160" y1="135" x2="100" y2="170" class="hex-edge edge-3" />
  <line x1="100" y1="170" x2="40" y2="135" class="hex-edge edge-4" />
  <line x1="40" y1="135" x2="40" y2="65" class="hex-edge edge-5" />
  <line x1="40" y1="65" x2="100" y2="30" class="hex-edge edge-6" />
  <path d="M68 82 L84 120 L100 94 L116 120 L132 82" fill="none" stroke="#38BDF8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

let isBrandLogoActive = null;

function setBrandLogoActive(active) {
    const isAct = !!active;
    if (isBrandLogoActive === isAct) return;
    isBrandLogoActive = isAct;

    const badge = document.getElementById('header-brand-icon') || document.querySelector('.header-crumb-badge');
    if (badge) {
        badge.innerHTML = isAct ? WORKBENCH_SVG_ANIMATED : WORKBENCH_SVG_STATIC;
    }

    const favicon = document.getElementById('ion-favicon');
    if (favicon) {
        favicon.href = 'data:image/svg+xml,' + encodeURIComponent(isAct ? WORKBENCH_SVG_ANIMATED : WORKBENCH_SVG_STATIC);
    }
}

function setFaviconBoltColor(rgbTriple) {
    setBrandLogoActive(!!rgbTriple && rgbTriple !== '88, 88, 88' && rgbTriple !== '56, 189, 248');
}

// --- AST_EXPORTS_START ---
window.setBrandLogoActive = setBrandLogoActive;
window.setFaviconBoltColor = setFaviconBoltColor;
// --- AST_EXPORTS_END ---

// --- setImgZoom.js ---
// Zooms to `z`; with (cx, cy) offsets from the image centre, that point stays fixed (zoom toward cursor).
function setImgZoom(z, animate, cx = 0, cy = 0) {
    const next = Math.max(IMG_ZOOM_MIN, Math.min(IMG_ZOOM_MAX, z));
    const ratio = next / imgZoom;
    imgPanX = cx - (cx - imgPanX) * ratio;
    imgPanY = cy - (cy - imgPanY) * ratio;
    imgZoom = next;
    applyImgTransform(animate);
}

// --- AST_EXPORTS_START ---
window.setImgZoom = setImgZoom;
// --- AST_EXPORTS_END ---

// --- shadeHex.js ---
function shadeHex(hex, factor) {
    const h = (hex || '').replace('#', '');
    if (h.length !== 6) return '#e0653f';
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const pad = (n) => clamp(n).toString(16).padStart(2, '0');
    return '#' + pad(parseInt(h.slice(0,2),16)*factor) + pad(parseInt(h.slice(2,4),16)*factor) + pad(parseInt(h.slice(4,6),16)*factor);
}

// --- AST_EXPORTS_START ---
window.shadeHex = shadeHex;
// --- AST_EXPORTS_END ---

// --- showEditorSaveError.js ---
function showEditorSaveError(message) {
    const errorEl = document.getElementById('editor-save-error');
    const textEl = document.getElementById('editor-save-error-text');
    if (errorEl && textEl) {
        textEl.textContent = message;
        errorEl.style.display = 'flex';
    }
}

// --- AST_EXPORTS_START ---
window.showEditorSaveError = showEditorSaveError;
// --- AST_EXPORTS_END ---

// --- showImgZoomBar.js ---
function showImgZoomBar(show) {
    imageZoomBar.style.display = show ? 'flex' : 'none';
    if (show) resetImgView(false);
}

// --- AST_EXPORTS_START ---
window.showImgZoomBar = showImgZoomBar;
// --- AST_EXPORTS_END ---

// --- switchTab.js ---
async function switchTab(tabId, opts = {}) {
    const isSplit = document.body.classList.contains('split-view-active');
    let focusChat = false;
    if (isSplit && tabId === 'chat') {
        focusChat = true;
        const fileTabs = state.openTabs.filter(t => t !== 'chat');
        if (fileTabs.length > 0) {
            tabId = fileTabs[fileTabs.length - 1];
        }
    }
    
    state.activeTab = tabId;
    // Any tab switch that did not come from an explorer click re-syncs the explorer highlight to the active tab.
    if (!opts.keepFocus) { explorerSelection.clear(); explorerAnchor = null; explorerSelectionCleared = false; }
    renderTabs();
    updateExplorerSelection();
    persistTabState();

    if (tabId === 'chat') {
        editorView.style.display = 'none';
        diffView.style.display = 'none';
        chatView.style.display = 'flex';
        editorModeToggle.style.display = 'none';
        btnTabSave.style.display = 'none';
        focusPrompt();
    } else if (tabId.startsWith('filediff:')) {
        chatView.style.display = 'none';
        editorView.style.display = 'none';
        diffView.style.display = 'flex';
        editorModeToggle.style.display = 'none';
        btnTabSave.style.display = 'none';
        const rest = tabId.replace('filediff:', '');
        const parts = rest.split('::');
        const fp = parts[0];
        const checkpointRange = (parts.length === 3) ? { from: parseInt(parts[1], 10), to: parseInt(parts[2], 10) } : null;
        renderFileDiffView(fp, checkpointRange);
    } else if (tabId.startsWith('attachment:')) {
        chatView.style.display = 'none';
        diffView.style.display = 'none';
        editorView.style.display = 'flex';
        state.currentEditorPath = null;
        editorModeToggle.style.display = 'none';
        btnTabSave.style.display = 'none';

        let att = state.attachmentStore[tabId.replace('attachment:', '')];
        monacoContainer.style.display = 'none';
        htmlPreviewFrame.style.display = 'none';
        attachmentTextPreview.style.display = 'none';

        if (!att) {
            // Rebuild attachment from a still-rendered <img> in chat (e.g. after page reload).
            const imgEl = document.querySelector(`[data-attachment-id="${tabId.replace('attachment:', '')}"] img`);
            if (imgEl) {
                att = {
                    name: imgEl.alt || 'Attachment',
                    dataUrl: imgEl.src,
                    type: 'image',
                    attachmentId: tabId.replace('attachment:', '')
                };
                state.attachmentStore[att.attachmentId] = att;
            }
        }

        if (!att) {
            editorBinaryNotice.style.display = 'flex';
            editorImagePreview.style.display = 'none';
            showImgZoomBar(false);
            editorBinaryMsg.innerText = 'This attachment is no longer available.';
        } else if (att.type === 'image') {
            editorBinaryNotice.style.display = 'flex';
            editorImagePreview.src = att.dataUrl;
            editorImagePreview.style.display = 'block';
            showImgZoomBar(true);
            editorBinaryMsg.innerText = att.name;
        } else {
            editorBinaryNotice.style.display = 'none';
            editorImagePreview.style.display = 'none';
            showImgZoomBar(false);
            attachmentTextPreview.style.display = 'block';
            attachmentTextPreview.textContent = att.content;
        }
    } else if (tabId.startsWith('render:')) {
        chatView.style.display = 'none';
        diffView.style.display = 'none';
        editorView.style.display = 'flex';
        state.currentEditorPath = null;
        editorModeToggle.style.display = 'none';
        btnTabSave.style.display = 'none';

        monacoContainer.style.display = 'none';
        htmlPreviewFrame.style.display = 'none';
        editorBinaryNotice.style.display = 'none';
        attachmentTextPreview.style.display = 'none';

        const mdContainer = document.getElementById('markdown-preview-container');
        if (mdContainer) {
            mdContainer.style.display = 'block';
            const filepath = tabId.replace('render:', '');
            await updateMarkdownPreview(filepath);
        }
    } else {
        chatView.style.display = 'none';
        diffView.style.display = 'none';
        editorView.style.display = 'flex';
        state.currentEditorPath = tabId;
        hideEditorSaveError();
        attachmentTextPreview.style.display = 'none';
        const mdContainer = document.getElementById('markdown-preview-container');
        if (mdContainer) mdContainer.style.display = 'none';

        const isImage = /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i.test(tabId);
        const meta = registry.meta[tabId];
        const isBinaryFile = await resolveIsBinary(tabId);

        if (isBinaryFile && !isImage) {
            monacoContainer.style.display = 'none';
            htmlPreviewFrame.style.display = 'none';
            editorBinaryNotice.style.display = 'flex';
            editorImagePreview.style.display = 'none';
            showImgZoomBar(false);
            editorBinaryMsg.innerText = `Binary file (${formatFileSize(meta.size || 0)}) - cannot be displayed in text editor.`;
            editorModeToggle.style.display = 'none';
            btnTabSave.style.display = 'none';
            return;
        }

        if (isImage && meta?.virtual) {
            // Virtual images store a data URL in registry.files; there is no disk handle.
            const dataUrl = await readImageDataUrl(tabId);
            if (dataUrl) {
                monacoContainer.style.display = 'none';
                htmlPreviewFrame.style.display = 'none';
                editorBinaryNotice.style.display = 'flex';
                editorImagePreview.src = dataUrl;
                editorImagePreview.style.display = 'block';
                showImgZoomBar(true);
                editorBinaryMsg.innerText = `${tabId.split('/').pop()} (${formatFileSize(meta.size || 0)})`;
                editorModeToggle.style.display = 'none';
                btnTabSave.style.display = 'none';
                return;
            }
        }

        if (isImage && rootHandle) {
            try {
                const handle = await getHandleByPath(tabId);
                const file = await handle.getFile();
                const url = URL.createObjectURL(file);
                monacoContainer.style.display = 'none';
                htmlPreviewFrame.style.display = 'none';
                editorBinaryNotice.style.display = 'flex';
                editorImagePreview.src = url;
                editorImagePreview.style.display = 'block';
                showImgZoomBar(true);
                editorBinaryMsg.innerText = `${tabId.split('/').pop()} (${formatFileSize(file.size)})`;
                editorModeToggle.style.display = 'none';
                btnTabSave.style.display = 'none';
                return;
            } catch(e) {}
        }

        editorBinaryNotice.style.display = 'none';

        const content = await readFileContent(tabId);
        if (monacoEditor) {
            const model = getOrCreateModel(tabId, content);
            withDirtyTrackingSuppressed(() => monacoEditor.setModel(model));
            state.isEditorDirty = isFileDirty(tabId);
            btnTabSave.classList.toggle('dirty', state.isEditorDirty);
            clearGutterDiffMarkers();
            scheduleGutterDiffUpdate();
        }

        const isHtml = tabId.endsWith('.html') || tabId.endsWith('.htm');
        editorModeToggle.style.display = isHtml ? 'flex' : 'none';
        btnTabSave.style.display = isHtml ? 'flex' : 'none';

        if (isHtml && state.editorViewMode === 'preview') {
            setEditorSubView('preview');
        } else {
            // keepFocus: opened from the explorer, so focus stays in the explorer instead of jumping into the editor.
            setEditorSubView('edit', { focus: !opts.keepFocus });
        }

        if (focusChat && window.focusPrompt) {
            window.focusPrompt();
        }
    }
}

// --- AST_EXPORTS_START ---
window.switchTab = switchTab;
// --- AST_EXPORTS_END ---

// --- toggleMobileSidebar.js ---
function toggleMobileSidebar(show) {
    if (show === undefined) {
        show = !sidebarEl.classList.contains('mobile-open');
    }
    if (show && window.innerWidth <= 768) sidebarEl.classList.remove('collapsed'); // desktop 'collapsed' hides #sidebar-content
    sidebarEl.classList.toggle('mobile-open', show);
    sidebarOverlay.classList.toggle('visible', show);
}

// --- AST_EXPORTS_START ---
window.toggleMobileSidebar = toggleMobileSidebar;
// --- AST_EXPORTS_END ---

// --- toggleNavTab.js ---
function toggleNavTab(navTab, viewEl) {
    settingsPopover.style.display = 'none';
    btnSettingsToggle.classList.remove('active');
    const isCollapsed = sidebarEl.classList.contains('collapsed');
    const isActive = navTab.classList.contains('active');
    if (isCollapsed || !isActive) {
        setSidebarCollapsed(false);
        activateSidebarView(navTab, viewEl);
    } else {
        setSidebarCollapsed(true);
    }
}

// --- AST_EXPORTS_START ---
window.toggleNavTab = toggleNavTab;
// --- AST_EXPORTS_END ---

// --- updateAccentActiveState.js ---
function updateAccentActiveState() {
    const wrap = document.getElementById('settings-accent-swatches');
    if (!wrap) return;
    const cur = currentAccent().toLowerCase();
    const customIsDefault = ACCENT_PRESETS.every(p => p.hex.toLowerCase() !== cur);
    wrap.querySelectorAll('.accent-swatch').forEach(btn => {
        btn.classList.toggle('active', (btn.getAttribute('data-hex') || '').toLowerCase() === cur);
    });
    const custom = wrap.querySelector('.accent-custom');
    if (custom) {
        if (custom.value !== cur) custom.value = cur;
        custom.classList.toggle('active', customIsDefault);
    }
}

// --- AST_EXPORTS_START ---
window.updateAccentActiveState = updateAccentActiveState;
// --- AST_EXPORTS_END ---

// --- updateAgentFilesSwitch.js ---
function updateAgentFilesSwitch() {
    const sw = document.getElementById('shield-agent-switch');
    if (!sw) return;
    const isHidden = AppConfig.get('hide-agent-files', 'true') === 'true';
    sw.querySelectorAll('[data-agent-val]').forEach(btn => {
        const val = btn.dataset.agentVal;
        const active = (val === 'hide' && isHidden) || (val === 'show' && !isHidden);
        btn.className = `tri-btn ${val === 'hide' ? 'never' : 'always'} ${active ? 'active ' + (val === 'hide' ? 'never' : 'always') : ''}`;
    });
}

// --- AST_EXPORTS_START ---
window.updateAgentFilesSwitch = updateAgentFilesSwitch;
// --- AST_EXPORTS_END ---

// --- updateGenGlow.js ---
function updateGenGlow() {
    const glowEl = document.getElementById('dock-glow');
    if (!glowEl) return;

    const activeGen = getGenState(state.activeSessionId);
    const enabled = AppConfig.get('glow-enabled', 'true') !== 'false';
    let status = null;
    if (activeGen.retryStatusActive) status = 'retrying';
    else if (permQueue.some(r => r.sessionId === state.activeSessionId)
          || pendingUIQueue.some(r => r.sessionId === state.activeSessionId)) status = 'asking';
    else if (activeGen.compressionInFlight || activeGen.isRunning) status = 'generating';

    glowEl.classList.toggle('on', enabled && !!status);
    if (status) glowEl.style.setProperty('--glow-rgb', GLOW_STATUS_COLORS[status]);
    else glowEl.style.removeProperty('--glow-rgb');

    const logoActive = !!status && (status === 'generating' || status === 'asking' || status === 'retrying');
    setBrandLogoActive(logoActive);

    const logoEl = document.getElementById('ion-logo');
    if (logoEl) {
        logoEl.classList.toggle('active', logoActive);
        if (logoActive && status) {
            logoEl.style.setProperty('--glow-rgb', GLOW_STATUS_COLORS[status]);
        }
    }
}

// --- AST_EXPORTS_START ---
window.updateGenGlow = updateGenGlow;
// --- AST_EXPORTS_END ---

// --- updateHtmlPreview.js ---
function updateHtmlPreview() {
    if (!state.currentEditorPath) return;
    const content = monacoEditor ? monacoEditor.getValue() : (registry.files[state.currentEditorPath] || '');
    htmlPreviewFrame.srcdoc = withStorageShim(content);
}

// --- AST_EXPORTS_START ---
window.updateHtmlPreview = updateHtmlPreview;
// --- AST_EXPORTS_END ---

// --- updateMarkdownPreview.js ---
async function updateMarkdownPreview(filepath, content) {
    const mdContainer = document.getElementById('markdown-preview-container');
    if (!mdContainer) return;
    
    let latestContent = content;
    if (latestContent === undefined) {
        latestContent = await window.readFileContent(filepath);
        if (latestContent === undefined || latestContent === null) {
            latestContent = '';
        }
    }
    
    const scrollPos = mdContainer.scrollTop;
    mdContainer.innerHTML = `<div class="md-content">${window.formatMarkdownSnippet(latestContent, filepath)}</div>`;
    mdContainer.scrollTop = scrollPos;
    if (window.resolveMarkdownImages) {
        await window.resolveMarkdownImages(mdContainer, filepath);
    }
}

// --- AST_EXPORTS_START ---
window.updateMarkdownPreview = updateMarkdownPreview;
// --- AST_EXPORTS_END ---

// --- withDirtyTrackingSuppressed.js ---
function withDirtyTrackingSuppressed(fn) {
    state.suppressDirtyTracking = true;
    try {
        fn();
    } finally {
        state.suppressDirtyTracking = false;
    }
}

// --- AST_EXPORTS_START ---
window.withDirtyTrackingSuppressed = withDirtyTrackingSuppressed;
// --- AST_EXPORTS_END ---

// --- withStorageShim.js ---
function withStorageShim(html) {
    const shim = `<script>
      (function(){
        try { localStorage.getItem('x'); return; } catch(e) {}
        var mem = Object.create(null);
        var fake = {
          getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem,k) ? mem[k] : null; },
          setItem: function(k,v){ mem[k] = String(v); },
          removeItem: function(k){ delete mem[k]; },
          clear: function(){ for (var k in mem) delete mem[k]; },
          key: function(i){ return Object.keys(mem)[i] || null; },
          get length(){ return Object.keys(mem).length; }
        };
        try {
          Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
          Object.defineProperty(window, 'sessionStorage', { value: fake, configurable: true });
        } catch(e) { /* fall through: some content may still read the real one and fail */ }
      })();
    <\/script>`;
    // Insert right after <head> if present, else prepend.
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + shim);
    return shim + html;
}

// --- AST_EXPORTS_START ---
window.withStorageShim = withStorageShim;
// --- AST_EXPORTS_END ---

// --- keyboardShortcuts.js ---
document.addEventListener('keydown', (e) => {
    // Ctrl+[ or Cmd+[ -> Toggle Sidebar
    if ((e.ctrlKey || e.metaKey) && (e.key === '[' || e.code === 'BracketLeft')) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && window.setSidebarCollapsed) {
            window.setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
        } else {
            const collapseBtn = document.getElementById('btn-sidebar-collapse');
            if (collapseBtn) collapseBtn.click();
        }
        e.preventDefault();
        e.stopPropagation();
    }
    
    // Ctrl+] or Cmd+] -> Toggle Widescreen Split View
    if ((e.ctrlKey || e.metaKey) && (e.key === ']' || e.code === 'BracketRight')) {
        const current = AppConfig.get('split-view-enabled') === 'true';
        AppConfig.set('split-view-enabled', current ? 'false' : 'true');
        const sw = document.getElementById('settings-split-view');
        if (sw) setDuoSwitch(sw, !current);
        if (window.applySplitView) window.applySplitView();
        e.preventDefault();
        e.stopPropagation();
    }
    
    // Ctrl+PageUp / Ctrl+PageDown -> Cycle Tabs
    if ((e.ctrlKey || e.metaKey) && (e.key === 'PageUp' || e.key === 'PageDown')) {
        const isSplit = document.body.classList.contains('split-view-active');
        let tabs = state.openTabs || [];
        
        // In split view, the chat tab is pinned left, so we only cycle file tabs on the right
        if (isSplit) {
            tabs = tabs.filter(t => t !== 'chat');
        }
        
        if (tabs.length > 1) {
            let currentIdx = tabs.indexOf(state.activeTab);
            
            // If somehow the active tab isn't in our valid list, pick a sensible starting point
            if (currentIdx === -1) currentIdx = 0;
            
            let nextIdx;
            if (e.key === 'PageDown') {
                nextIdx = (currentIdx + 1) % tabs.length;
            } else {
                nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
            }
            
            switchTab(tabs[nextIdx]);
        }
        
        // This successfully overrides the browser's default tab switching behavior
        e.preventDefault();
        e.stopPropagation();
    }
}, true); // Use capture phase to intercept the keys before the Monaco editor can