// --- applyConfigToUI.js ---
function applyConfigToUI() {
    const themeSelect = document.getElementById('settings-ui-theme');
    if (themeSelect) {
        themeSelect.value = AppConfig.get('ui-theme', 'dark');
        if (!themeSelect._hasConfigListener) {
            themeSelect._hasConfigListener = true;
            themeSelect.addEventListener('change', () => {
                AppConfig.set('ui-theme', themeSelect.value);
                if (window.applyTheme) window.applyTheme();
            });
        }
    }

    const thinkingInput = document.getElementById('settings-thinking-timeout');
    if (thinkingInput) {
        thinkingInput.value = AppConfig.get('thinking-timeout', '-1');
        if (!thinkingInput._hasConfigListener) {
            thinkingInput._hasConfigListener = true;
            thinkingInput.addEventListener('change', () => {
                AppConfig.set('thinking-timeout', thinkingInput.value);
            });
        }
    }

    const toolTimeoutInput = document.getElementById('settings-tool-timeout');
    if (toolTimeoutInput) {
        toolTimeoutInput.value = AppConfig.get('tool-timeout', '120');
        if (!toolTimeoutInput._hasConfigListener) {
            toolTimeoutInput._hasConfigListener = true;
            toolTimeoutInput.addEventListener('change', () => {
                AppConfig.set('tool-timeout', toolTimeoutInput.value);
            });
        }
    }

    setDuoSwitch(document.getElementById('settings-keep-skipped-thinking'), AppConfig.get('keep-skipped-thinking') === "true");
    setDuoSwitch(document.getElementById('settings-glow-enabled'), AppConfig.get('glow-enabled', 'true') !== 'false');
    setDuoSwitch(document.getElementById('settings-editor-word-wrap'), AppConfig.get('editor-word-wrap') === 'true');
    setDuoSwitch(document.getElementById('settings-show-code-preview'), AppConfig.get('show-code-preview', 'true') !== 'false');
    setDuoSwitch(document.getElementById('settings-split-view'), AppConfig.get('split-view-enabled') === 'true');

    const ce = document.getElementById('settings-compress-enabled');
    const ct = document.getElementById('settings-compress-threshold');
    const cp = document.getElementById('settings-compress-preserve');
    setDuoSwitch(ce, AppConfig.get('compress-enabled', 'true') !== 'false');
    setDuoSwitch(document.getElementById('settings-webdav-sync-agent'), AppConfig.get('webdav-sync-agent') === 'true');
    if (ct) {
        ct.value = AppConfig.get('compress-threshold', '75');
        if (!ct._hasConfigListener) {
            ct._hasConfigListener = true;
            ct.addEventListener('change', () => {
                AppConfig.set('compress-threshold', ct.value);
            });
        }
    }
    if (cp) {
        cp.value = AppConfig.get('compress-preserve', '6');
        if (!cp._hasConfigListener) {
            cp._hasConfigListener = true;
            cp.addEventListener('change', () => {
                AppConfig.set('compress-preserve', cp.value);
            });
        }
    }

    if (!window._settingsSwitchesBound && window.initDuoSwitch) {
        window._settingsSwitchesBound = true;
        window.initDuoSwitch('settings-keep-skipped-thinking', (isOn) => {
            AppConfig.set('keep-skipped-thinking', isOn ? 'true' : 'false');
        });
        window.initDuoSwitch('settings-webdav-sync-agent', (isOn) => {
            AppConfig.set('webdav-sync-agent', isOn ? 'true' : 'false');
        });
        window.initDuoSwitch('settings-glow-enabled', (isOn) => {
            AppConfig.set('glow-enabled', isOn ? 'true' : 'false');
            if (window.updateGenGlow) window.updateGenGlow();
        });
        window.initDuoSwitch('settings-compress-enabled', (isOn) => {
            AppConfig.set('compress-enabled', isOn ? 'true' : 'false');
        });
        window.initDuoSwitch('settings-editor-word-wrap', (isOn) => {
            AppConfig.set('editor-word-wrap', isOn ? 'true' : 'false');
            if (window.monacoEditor) {
                window.monacoEditor.updateOptions({ wordWrap: isOn ? 'on' : 'off' });
            }
            if (window.monacoDiffEditor) {
                window.monacoDiffEditor.getModifiedEditor().updateOptions({ wordWrap: isOn ? 'on' : 'off' });
                window.monacoDiffEditor.getOriginalEditor().updateOptions({ wordWrap: isOn ? 'on' : 'off' });
            }
        });
        window.initDuoSwitch('settings-show-code-preview', (isOn) => {
            AppConfig.set('show-code-preview', isOn ? 'true' : 'false');
            if (isOn) {
                document.body.classList.remove('hide-code-preview');
            } else {
                document.body.classList.add('hide-code-preview');
            }
        });
        window.initDuoSwitch('settings-split-view', (isOn) => {
            AppConfig.set('split-view-enabled', isOn ? 'true' : 'false');
            if (window.applySplitView) window.applySplitView();
        });
    }

    const clearDataBtn = document.getElementById('btn-clear-data');
    if (clearDataBtn && !clearDataBtn._hasConfigListener) {
        clearDataBtn._hasConfigListener = true;
        clearDataBtn.addEventListener('click', () => {
            if (typeof window.openClearDataModal === 'function') {
                window.openClearDataModal();
            }
        });
    }

    if (AppConfig.get('show-code-preview', 'true') === 'false') {
        document.body.classList.add('hide-code-preview');
    } else {
        document.body.classList.remove('hide-code-preview');
    }

    if (window.monacoEditor) {
        window.monacoEditor.updateOptions({ wordWrap: AppConfig.get('editor-word-wrap') === 'true' ? 'on' : 'off' });
    }
    if (window.monacoDiffEditor) {
        window.monacoDiffEditor.getModifiedEditor().updateOptions({ wordWrap: AppConfig.get('editor-word-wrap') === 'true' ? 'on' : 'off' });
        window.monacoDiffEditor.getOriginalEditor().updateOptions({ wordWrap: AppConfig.get('editor-word-wrap') === 'true' ? 'on' : 'off' });
    }

    if (typeof updateAgentFilesSwitch === 'function') updateAgentFilesSwitch();
    if (window.applySplitView) window.applySplitView();
    if (typeof renderAccentSwatches === 'function') renderAccentSwatches();
    if (window.applyTheme) window.applyTheme();
    if (typeof refreshCustomModes === 'function') refreshCustomModes();
}

// --- AST_EXPORTS_START ---
window.applyConfigToUI = applyConfigToUI;
// --- AST_EXPORTS_END ---

// --- clearIDBStore.js ---
async function clearIDBStore(storeName) {
    try {
        const db = await getDB();
        await new Promise((resolve) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch (e) {}
}

// --- AST_EXPORTS_START ---
window.clearIDBStore = clearIDBStore;
// --- AST_EXPORTS_END ---

// --- clearLocalStorageKeys.js ---
function clearLocalStorageKeys(keys) {
    keys.forEach(k => {
        try { localStorage.removeItem(k); } catch (e) {}
    });
}

// --- AST_EXPORTS_START ---
window.clearLocalStorageKeys = clearLocalStorageKeys;
// --- AST_EXPORTS_END ---

// --- clearSelectedData.js ---
// opts: { checkpoints: bool, sessions: bool, models: bool, customTools: bool, settings: bool }
async function clearSelectedData(opts) {
    if (opts.checkpoints) {
        await clearIDBStore(STORE_BASELINES);
    }
    if (opts.sessions) {
        await clearIDBStore(STORE_SESSIONS);
    }
    if (opts.models) {
        clearLocalStorageKeys(CLEARDATA_LS_KEYS.models);
    }
    if (opts.customTools) {
        clearLocalStorageKeys(CLEARDATA_LS_KEYS.customTools);
        try {
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (
                    k.startsWith('tools_config_') ||
                    k.startsWith('tool_files_') ||
                    k.startsWith('tool_lock_state_') ||
                    k.startsWith('tool_perm_state_') ||
                    k.startsWith('tool_settings_state_')
                )) {
                    toRemove.push(k);
                }
            }
            toRemove.forEach(k => localStorage.removeItem(k));
        } catch(e) {}
        if (typeof resetToolRegistry === 'function') {
            resetToolRegistry();
        }
        if (typeof saveWorkspaceToolsState === 'function' && typeof toolsDefaults === 'function') {
            const wsKey = typeof getWorkspaceToolsKey === 'function' ? getWorkspaceToolsKey() : null;
            saveWorkspaceToolsState(wsKey, toolsDefaults());
        }
        if (typeof renderToolsList === 'function') {
            renderToolsList();
        }
        if (typeof refreshPermBanner === 'function') {
            refreshPermBanner();
        }
    }
    if (opts.settings) {
        clearLocalStorageKeys(CLEARDATA_LS_KEYS.settings);
        await clearIDBStore(STORE_CACHE);
        await clearIDBStore(STORE_HANDLES);
        AppConfig.reset();
        applyConfigToUI();
    }
}

// --- AST_EXPORTS_START ---
window.clearSelectedData = clearSelectedData;
// --- AST_EXPORTS_END ---

// --- closeClearDataModal.js ---
function closeClearDataModal() {
    document.getElementById('cleardata-modal-overlay').style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.closeClearDataModal = closeClearDataModal;
// --- AST_EXPORTS_END ---

// --- configFileText.js ---
function configFileText(data) {
    return JSON.stringify(data !== undefined ? data : AppConfig.all(), null, 2) + '\n';
}

// --- AST_EXPORTS_START ---
window.configFileText = configFileText;
// --- AST_EXPORTS_END ---

// --- confirmDialog.js ---
function confirmDialog(message, opts = {}) {
    const { confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = opts;
    return new Promise((resolve) => {
        const overlay = document.getElementById('yesno-modal-overlay');
        const msgEl = document.getElementById('yesno-modal-message');
        const okBtn = document.getElementById('yesno-modal-save');
        const extraBtn = document.getElementById('yesno-modal-discard');
        const cancelBtn = document.getElementById('yesno-modal-cancel');
        const prev = { ok: okBtn.textContent, cancel: cancelBtn.textContent, extra: extraBtn.style.display };
        msgEl.innerText = message;
        okBtn.textContent = confirmLabel;
        cancelBtn.textContent = cancelLabel;
        extraBtn.style.display = 'none';
        overlay.style.display = 'flex';
        const finish = (val) => {
            overlay.style.display = 'none';
            okBtn.textContent = prev.ok;
            cancelBtn.textContent = prev.cancel;
            extraBtn.style.display = prev.extra;
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
            resolve(val);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onOverlay = (e) => { if (e.target === overlay) finish(false); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
            else if (e.key === 'Enter' && !danger) { e.preventDefault(); finish(true); }
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);
        // Destructive prompts default focus to Cancel so a stray Enter can't confirm.
        (danger ? cancelBtn : okBtn).focus();
    });
}

// --- AST_EXPORTS_START ---
window.confirmDialog = confirmDialog;
// --- AST_EXPORTS_END ---

// --- confirmSaveDiscard.js ---
function confirmSaveDiscard(message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('yesno-modal-overlay');
        const msgEl = document.getElementById('yesno-modal-message');
        const saveBtn = document.getElementById('yesno-modal-save');
        const discardBtn = document.getElementById('yesno-modal-discard');
        const cancelBtn = document.getElementById('yesno-modal-cancel');
        msgEl.innerText = message;
        overlay.style.display = 'flex';
        const finish = (val) => {
            overlay.style.display = 'none';
            saveBtn.removeEventListener('click', onSave);
            discardBtn.removeEventListener('click', onDiscard);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
            resolve(val);
        };
        const onSave = () => finish('save');
        const onDiscard = () => finish('discard');
        const onCancel = () => finish('cancel');
        const onOverlay = (e) => { if (e.target === overlay) finish('cancel'); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finish('cancel'); }
            else if (e.key === 'Enter') { e.preventDefault(); finish('save'); }
        };
        saveBtn.addEventListener('click', onSave);
        discardBtn.addEventListener('click', onDiscard);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);
        saveBtn.focus();
    });
}

// --- AST_EXPORTS_START ---
window.confirmSaveDiscard = confirmSaveDiscard;
// --- AST_EXPORTS_END ---

// --- escapeHTML.js ---
function escapeHTML(str) {
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag]));
}

// --- AST_EXPORTS_START ---
window.escapeHTML = escapeHTML;
// --- AST_EXPORTS_END ---

// --- formatDuration.js ---
function formatDuration(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m ${remSec}s`;
}

// --- AST_EXPORTS_START ---
window.formatDuration = formatDuration;
// --- AST_EXPORTS_END ---

// --- openClearDataModal.js ---
function openClearDataModal() {
    document.getElementById('cleardata-modal-overlay').style.display = 'flex';
}

// --- AST_EXPORTS_START ---
window.openClearDataModal = openClearDataModal;
// --- AST_EXPORTS_END ---

// --- promptDialog.js ---
// Non-blocking text prompt built on the same modal. Resolves to the entered string, or null if cancelled.
// `validate(value)` may return an error message; the dialog stays open and shows it until the value is valid.
function promptDialog(message, defaultValue = '', opts = {}) {
    const { confirmLabel = 'OK', cancelLabel = 'Cancel', validate = null } = opts;
    return new Promise((resolve) => {
        const overlay = document.getElementById('yesno-modal-overlay');
        const msgEl = document.getElementById('yesno-modal-message');
        const inputEl = document.getElementById('yesno-modal-input');
        const errEl = document.getElementById('yesno-modal-error');
        const okBtn = document.getElementById('yesno-modal-save');
        const extraBtn = document.getElementById('yesno-modal-discard');
        const cancelBtn = document.getElementById('yesno-modal-cancel');
        const prev = { ok: okBtn.textContent, cancel: cancelBtn.textContent, extra: extraBtn.style.display };
        msgEl.innerText = message;
        inputEl.value = defaultValue;
        inputEl.style.display = 'block';
        errEl.style.display = 'none';
        okBtn.textContent = confirmLabel;
        cancelBtn.textContent = cancelLabel;
        extraBtn.style.display = 'none';
        overlay.style.display = 'flex';
        const finish = (val) => {
            overlay.style.display = 'none';
            inputEl.style.display = 'none';
            errEl.style.display = 'none';
            okBtn.textContent = prev.ok;
            cancelBtn.textContent = prev.cancel;
            extraBtn.style.display = prev.extra;
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            inputEl.removeEventListener('input', onInput);
            document.removeEventListener('keydown', onKey);
            resolve(val);
        };
        const onOk = () => {
            const v = inputEl.value;
            const err = validate ? validate(v) : null;
            if (err) { errEl.textContent = err; errEl.style.display = 'block'; inputEl.focus(); return; }
            finish(v);
        };
        const onCancel = () => finish(null);
        const onOverlay = (e) => { if (e.target === overlay) finish(null); };
        const onInput = () => { errEl.style.display = 'none'; };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
            else if (e.key === 'Enter' && !e.isComposing && document.activeElement !== cancelBtn) { e.preventDefault(); onOk(); }
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
        inputEl.addEventListener('input', onInput);
        document.addEventListener('keydown', onKey);
        // Pre-select just the base name (not the folder or extension) so typing replaces it.
        inputEl.focus();
        const slash = defaultValue.lastIndexOf('/') + 1;
        const dot = defaultValue.lastIndexOf('.');
        inputEl.setSelectionRange(slash, dot > slash ? dot : defaultValue.length);
    });
}

// --- AST_EXPORTS_START ---
window.promptDialog = promptDialog;
// --- AST_EXPORTS_END ---

// --- registerConfigVirtualFile.js ---
function registerConfigVirtualFile() {
    const text = configFileText();
    registry.files[CONFIG_FILE] = text;
    registry.meta[CUSTOM_TOOLS_DIR] = { kind: 'directory' };
    registry.meta[CONFIG_FILE] = { kind: 'file', size: text.length, isBinary: false, virtual: true };
}

// --- AST_EXPORTS_START ---
window.registerConfigVirtualFile = registerConfigVirtualFile;
// --- AST_EXPORTS_END ---

// --- toolsFileText.js ---
function toolsFileText(data) {
    let cfg = data;
    if (cfg === undefined) {
        cfg = typeof window.getWorkspaceToolsConfig === 'function'
            ? window.getWorkspaceToolsConfig()
            : (typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {});
    }
    return JSON.stringify(cfg, null, 2) + '\n';
}

// --- AST_EXPORTS_START ---
window.toolsFileText = toolsFileText;
// --- AST_EXPORTS_END ---

// --- registerToolsVirtualFile.js ---
function registerToolsVirtualFile() {
    if (!window.registry || !window.registry.files || !window.registry.meta) return;
    const text = toolsFileText();
    registry.files[TOOLS_FILE] = text;
    registry.meta[CUSTOM_TOOLS_DIR] = { kind: 'directory' };
    registry.meta[TOOLS_FILE] = { kind: 'file', size: text.length, isBinary: false, virtual: true };
}

// --- AST_EXPORTS_START ---
window.registerToolsVirtualFile = registerToolsVirtualFile;
// --- AST_EXPORTS_END ---

// --- showToast.js ---
function showToast(message, kind = 'info', durationMs = 2600) {
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.innerHTML = `<span class="icon">${TOAST_ICONS[kind] || TOAST_ICONS.info}</span><span>${escapeHTML(message)}</span>`;
    toastContainer.appendChild(el);

    requestAnimationFrame(() => el.classList.add('toast-visible'));

    setTimeout(() => {
        el.classList.remove('toast-visible');
        setTimeout(() => el.remove(), 220);
    }, durationMs);
}

// --- AST_EXPORTS_START ---
window.showToast = showToast;
// --- AST_EXPORTS_END ---