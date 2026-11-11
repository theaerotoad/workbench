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
import { openSettingsModal, closeSettingsModal } from './modules/settings_modal.js';
import './modules/ui_dialogs.js';
import './modules/ui_layout.js';
import './modules/task_runner.js';
import './modules/chat_render.js';
import './modules/chat_tool_boxes.js';
import './modules/chat_terminal.js';
import './modules/chat_input.js';
import './modules/chat_models.js';

import '../js/models.js';
import '../js/worker.js';
import '../js/github.js';
import '../js/monaco.js';

window.skipCurrentThinking = function(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const gen = getGenState(state.activeSessionId);
    if (!gen.isThinkingNow || !gen.activeController) return;
    gen.skipThinkingRequested = true;
    gen.activeController.abort();
};

promptSymbol.addEventListener('click', (e) => {
    e.preventDefault();
    if (isSessionRunning(state.activeSessionId)) {
        const g = state.sessions[state.activeSessionId]?._gen;
        abortGeneration({ toast: g && g.compressionInFlight ? 'Compression cancelled' : 'Generation stopped' });
    } else {
        submitPrompt();
    }
});

modeTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        setMode(btn.getAttribute('data-mode'));
        focusPrompt();
    });
});

btnSessionToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isShown = sessionsPopoverOverlay.style.display === 'block';
    if (isShown) hideSessionPopover();
    else showSessionPopover();
});

btnCreateSession.addEventListener('click', (e) => {
    e.stopPropagation();
    createNewSession();
});

btnClearAllSessions.addEventListener('click', async (e) => {
    e.stopPropagation();
    const count = (state.sessionIds && state.sessionIds.length) || Object.keys(state.sessions).length;
    if (!await confirmDialog(`Clear all ${count} session${count === 1 ? '' : 's'}? This deletes all chat history and checkpoints and can't be undone.`, { confirmLabel: 'Clear all', danger: true })) return;
    clearAllSessions();
});

document.addEventListener('click', (e) => {
    if (!e.composedPath().includes(sessionsPopover) && e.target !== btnSessionToggle && !btnSessionToggle.contains(e.target)) {
        hideSessionPopover();
    }
});

(function () {
    const attachBtn = document.getElementById('prompt-attach');
    const attachMenu = document.getElementById('attach-menu');
    const attachInput = document.getElementById('prompt-attach-input');
    const attachDocInput = document.getElementById('prompt-attach-doc-input');
    if (!attachBtn || !attachMenu || !attachInput) return;
    const closeMenu = () => { attachMenu.style.display = 'none'; };
    attachBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachMenu.style.display = attachMenu.style.display === 'flex' ? 'none' : 'flex';
    });
    document.addEventListener('click', (e) => {
        if (attachMenu.contains(e.target)) return;
        if (e.target === attachBtn || attachBtn.contains(e.target)) return;
        closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });
    const processFiles = async (input) => {
        const files = Array.from(input.files);
        input.value = '';
        closeMenu();
        for (const f of files) {
            await handleAttachFile(f);
        }
    };
    attachInput.addEventListener('change', () => processFiles(attachInput));
    if (attachDocInput) attachDocInput.addEventListener('change', () => processFiles(attachDocInput));
    attachMenu.querySelectorAll('.attach-menu-item').forEach((item) => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const type = item.getAttribute('data-attach-type');
            if (type === 'image') {
                if (!currentModelHasVision()) {
                    showToast('The selected model does not support vision', 'error');
                    closeMenu();
                    return;
                }
                attachInput.click();
            } else {
                attachDocInput.click();
            }
            closeMenu();
        });
    });
})();

// Drag-and-drop files directly onto the bottom dock (status bar + prompt bar).
(function () {
    const dropTarget = document.getElementById('bottom-dock-area');
    if (!dropTarget) return;
    ['dragenter', 'dragover'].forEach(evt => {
        dropTarget.addEventListener(evt, (e) => {
            if (!e.dataTransfer) return;
            if (e.dataTransfer.items && Array.from(e.dataTransfer.items).some(it => it.kind === 'file')) {
                e.preventDefault(); e.stopPropagation();
                dropTarget.classList.add('dropzone-active');
            }
        });
    });
    ['dragleave', 'dragend'].forEach(evt => {
        dropTarget.addEventListener(evt, (e) => {
            e.preventDefault(); e.stopPropagation();
            dropTarget.classList.remove('dropzone-active');
        });
    });
    dropTarget.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation();
        dropTarget.classList.remove('dropzone-active');
        const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
        if (!files.length) return;
        for (const f of files) {
            await handleAttachFile(f);
        }
    });
})();

input.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageItem = Array.from(items).find(it => it.type && it.type.startsWith('image/'));
    if (imageItem) {
        e.preventDefault();
        if (!currentModelHasVision()) {
            showToast('Cannot paste image: the selected model does not support vision', 'error');
            return;
        }
        const file = imageItem.getAsFile();
        if (!file) return;
        try {
            const dataUrl = await toPngDataUrl(file);
            pastedImageCounter++;
            const ext = (file.type.split('/')[1] || 'png').split('+')[0];
            attachReference({
                type: 'image',
                name: file.name && file.name !== 'image.png' ? file.name : `pasted-image-${pastedImageCounter}.${ext}`,
                dataUrl,
                mimeType: 'image/png'
            });
        } catch (err) {
            showToast(`Could not read pasted image: ${err.message}`, 'error');
        }
        return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const lineCount = text.split('\n').length;
    if (lineCount > PASTE_LINE_THRESHOLD) {
        e.preventDefault();
        pastedTextCounter++;
        attachReference({
            type: 'paste',
            name: `pasted-text-${pastedTextCounter}.txt`,
            content: text,
            lineCount
        });
    }
});

term.addEventListener('scroll', () => {
    const prevTop = _lastTermScrollTop;
    _lastTermScrollTop = term.scrollTop;
    if (programmaticScroll) return;
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 20;
    if (atBottom || !hasScrollableOverflow()) {
        state.userScrolledUp = false;
        if (jumpBtn) jumpBtn.style.display = 'none';
    } else if (term.scrollTop < prevTop - 1) {
        state.userScrolledUp = true;
        ensureJumpBtn().style.display = 'flex';
    } else if (!state.userScrolledUp) {
        scheduleSettleScroll();
    }
});

new MutationObserver((records) => {
    if (state.userScrolledUp) return;
    for (const r of records) {
        const n = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (n && n.closest && n.closest('[data-live-spinner], .running-tool-spinner')) continue;
        scheduleSettleScroll();
        return;
    }
}).observe(term, { childList: true, subtree: true, characterData: true });

term.addEventListener('load', () => smartScroll(), true);
term.addEventListener('wheel', (e) => {
    if (e.deltaY < 0 && hasScrollableOverflow()) {
        state.userScrolledUp = true;
        ensureJumpBtn().style.display = 'flex';
    }
}, { passive: true });

railObserver.observe(term, { childList: true });
term.addEventListener('scroll', updatePromptRail);

if (term) {
    _railWrapCount = term.querySelectorAll('.chat-prompt-wrap').length;
    rebuildPromptRailTicks();
    updatePromptRail();
}

document.getElementById('prompt-bar').addEventListener('click', (e) => {
    if (e.target === input) return;
    if (e.target.closest('button, input, textarea, select, a, .attach-menu, .mode-tab-btn, #model-select-btn')) return;
    input.focus();
});

document.getElementById('statusbar').addEventListener('click', () => { input.focus(); });

term.addEventListener('click', (e) => {
    const attachedImg = e.target.closest('.chat-attachment-image[data-attachment-id], .tool-preview-image-thumb[data-attachment-id]');
    if (attachedImg) {
        window.openAttachmentTab(attachedImg.getAttribute('data-attachment-id'));
        return;
    }
    const attachedPaste = e.target.closest('.prompt-chip.attachment-paste[data-attachment-id]');
    if (attachedPaste) {
        window.openAttachmentTab(attachedPaste.getAttribute('data-attachment-id'));
        return;
    }
    const skipBtn = e.target.closest('.btn-skip-thinking');
    if (skipBtn) {
        window.skipCurrentThinking(e);
        return;
    }
    const reconnectBtn = e.target.closest('.btn-force-reconnect');
    if (reconnectBtn) {
        e.preventDefault();
        e.stopPropagation();
        const g = getGenState(state.activeSessionId);
        if (g.forceReconnect) g.forceReconnect();
        return;
    }
    const copyBtn = e.target.closest('.btn-copy-code');
    if (copyBtn) {
        const codeBlock = copyBtn.closest('.code-box').querySelector('pre code');
        if (codeBlock) {
            navigator.clipboard.writeText(codeBlock.innerText);
            const icon = copyBtn.querySelector('.icon');
            icon.innerText = 'check';
            icon.style.color = 'var(--green)';
            setTimeout(() => {
                icon.innerText = 'content_copy';
                icon.style.color = '';
            }, 2000);
        }
        return;
    }
    const thoughtHdr = e.target.closest('.thought-header');
    if (thoughtHdr) {
        const thoughtBox = thoughtHdr.closest('.thought-box');
        if (thoughtBox) {
            thoughtBox.classList.toggle('collapsed');
            persistChatHTML(state.activeSessionId);
        }
        return;
    }
    const toolHdr = e.target.closest('.tool-box-header');
    if (toolHdr) {
        const toolBox = toolHdr.closest('.tool-box');
        if (toolBox) {
            toolBox.classList.toggle('collapsed');
            persistChatHTML(state.activeSessionId);
        }
        e.stopPropagation();
        return;
    }
    const toolGroupHdr = e.target.closest('.tool-group-header');
    if (toolGroupHdr) {
        const toolGroup = toolGroupHdr.closest('.tool-group');
        if (toolGroup) {
            toolGroup.classList.toggle('collapsed');
            persistChatHTML(state.activeSessionId);
        }
        return;
    }
    const isTextSelected = window.getSelection().toString().length > 0;
    const isInteractive = e.target.closest('button, input, textarea, details, summary, a, .plan-action-card, .thought-box, .tool-box');
    if (!isTextSelected && !isInteractive) {
        focusPrompt();
    }
});

input.addEventListener('input', () => {
    if (input.value === '') state.promptDirty = false;
    resizePrompt();
    checkAutocomplete();
});

modelSelectBtn.addEventListener('click', () => {
    if (_modelSelectState.visible) closeModelSelect(); else openModelSelect();
});
modelSelectOverlay.addEventListener('click', closeModelSelect);
modelSelectConfigBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeModelSelect();
    openModelsModal();
});

mmAddProviderBtn.addEventListener('click', () => {
    MODEL_PROVIDERS.push(mmNewProvider());
    _mmSelectedIdx = MODEL_PROVIDERS.length - 1;
    modelsModalEl.classList.add('mm-detail-open');
    commitModelsChange();
    renderModelsModal('.mm-detail-title-input');
});
modelsModalClose.addEventListener('click', closeModelsModal);
modelsModalOverlay.addEventListener('click', (e) => {
    if (e.target === modelsModalOverlay) closeModelsModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modelsModalOverlay.style.display === 'flex' && !(_modelPickerState && _modelPickerState.visible)) closeModelsModal();
});

modelSelectSearch.addEventListener('input', (e) => {
    _modelSelectState.filter = e.target.value;
    _modelSelectState.selectedIdx = 0;
    renderModelSelectList();
});

modelSelectSearch.addEventListener('keydown', (e) => {
    const entries = getModelEntriesFiltered();
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _modelSelectState.selectedIdx = Math.min(_modelSelectState.selectedIdx + 1, entries.length - 1);
        renderModelSelectList();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _modelSelectState.selectedIdx = Math.max(_modelSelectState.selectedIdx - 1, 0);
        renderModelSelectList();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const entry = entries[_modelSelectState.selectedIdx];
        if (entry) {
            setSelectedModel(entry.providerName, entry.name);
            closeModelSelect();
        }
    } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModelSelect();
    }
});

modelPickerClose.addEventListener('click', hideModelPicker);
modelPickerOverlay.addEventListener('click', hideModelPicker);
modelPickerSearch.addEventListener('input', (e) => {
    _modelPickerState.filter = e.target.value;
    _modelPickerState.selectedIdx = 0;
    renderModelPickerList();
});
modelPickerSearch.addEventListener('keydown', (e) => {
    const { apiModels, filter, selectedIdx } = _modelPickerState;
    const q = filter.toLowerCase();
    const filtered = apiModels.filter(m => ((m.id || m.name || '').toLowerCase()).includes(q));
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _modelPickerState.selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
        renderModelPickerList();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _modelPickerState.selectedIdx = Math.max(selectedIdx - 1, 0);
        renderModelPickerList();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIdx]) {
            selectModelFromPicker(filtered[selectedIdx]);
        }
    } else if (e.key === 'Escape') {
        e.stopPropagation();
        hideModelPicker();
    }
});

if (btnSettingsToggle) {
    btnSettingsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSessionPopover();
        openSettingsModal('security');
    });
}

if (btnSidebarToggleMobile) {
    btnSidebarToggleMobile.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileSidebar();
    });
}
if (btnSidebarCloseMobile) {
    btnSidebarCloseMobile.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileSidebar(false);
    });
}
if (btnSidebarCloseMobile2) {
    btnSidebarCloseMobile2.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileSidebar(false);
    });
}
if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
        toggleMobileSidebar(false);
    });
}
document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && sidebarEl.classList.contains('mobile-open')) {
        const clickedInSidebar = e.composedPath().includes(sidebarEl);
        const clickedToggle = e.target === btnSidebarToggleMobile || btnSidebarToggleMobile?.contains(e.target);
        if (!clickedInSidebar && !clickedToggle) {
            toggleMobileSidebar(false);
        }
    }
});
window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
        toggleMobileSidebar(false);
    }
});

toolsListEl.addEventListener('mouseover', (e) => {
    _permCtrlDown = e.ctrlKey || e.metaKey;
    const btn = _permSwitchBtn(e.target);
    if (btn !== _permHoverBtn) _permHoverBtn = btn;
    refreshGroupPermPreview();
});
toolsListEl.addEventListener('mouseleave', () => {
    _permHoverBtn = null;
    refreshGroupPermPreview();
});
toolsListEl.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const btn = _permSwitchBtn(e.target);
    if (!btn) return;
    const panel = btn.closest('.tool-section-panel');
    if (!panel) return;
    e.stopPropagation();
    e.preventDefault();
    applyGroupPermission(panel, btn.getAttribute('data-val'));
    _permHoverBtn = btn;
    _permCtrlDown = true;
    refreshGroupPermPreview();
}, true);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') { _permCtrlDown = true; refreshGroupPermPreview(); }
});
document.addEventListener('keyup', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') { _permCtrlDown = e.ctrlKey || e.metaKey; refreshGroupPermPreview(); }
});
window.addEventListener('blur', () => { _permCtrlDown = false; refreshGroupPermPreview(); });

document.getElementById('btn-perm-allow').addEventListener('click', () => closePerm(true));
document.getElementById('btn-perm-deny').addEventListener('click', () => closePerm(false, permRejectReason.value.trim()));
permRejectReason.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closePerm(false, permRejectReason.value.trim());
    e.stopPropagation();
});
document.getElementById('btn-perm-always').addEventListener('click', () => {
    if (currentPendingTool && toolRegistry[currentPendingTool]) {
        setToolPermission(currentPendingTool, 'always');
        renderToolsList();
    }
    closePerm(true);
});

window.addEventListener('DOMContentLoaded', async () => {
    const appInit = document.getElementById('app-initializer');
    const windowEl = document.getElementById('window');
    const noFolderOverlay = document.getElementById('no-folder-overlay');
    try {
        const storedModels = localStorage.getItem('models_json');
        const parsedStored = storedModels ? JSON.parse(storedModels) : null;
        MODEL_PROVIDERS = isValidProvidersShape(parsedStored) ? parsedStored : seedDefaultModels();
        if (!storedModels || !isValidProvidersShape(parsedStored)) {
            localStorage.setItem('models_json', JSON.stringify(MODEL_PROVIDERS));
        }
    } catch(e) {
        MODEL_PROVIDERS = seedDefaultModels();
        localStorage.setItem('models_json', JSON.stringify(MODEL_PROVIDERS));
    }
    if (ensureModelUuids()) localStorage.setItem('models_json', JSON.stringify(MODEL_PROVIDERS));
    renderModelDropdown();
    registerModelsVirtualFile();
    try {
        const storedPrompts = localStorage.getItem('mode_prompts_json');
        const parsed = storedPrompts ? JSON.parse(storedPrompts) : null;
        const defaults = seedDefaultModePrompts();
        if (parsed && typeof parsed === 'object') {
            MODE_PROMPTS = { ...defaults };
            for (const k of Object.keys(parsed)) {
                MODE_PROMPTS[k] = parsed[k];
                if (!PROMPT_MODE_ORDER.includes(k)) {
                    PROMPT_MODE_ORDER.push(k);
                    const promptFile = `${PROMPTS_DIR}/${k}.md`;
                    MODE_PROMPT_FILES[k] = promptFile;
                    PROMPT_FILE_MODES[promptFile] = k;
                }
            }
        } else {
            MODE_PROMPTS = defaults;
        }
        if (!storedPrompts) localStorage.setItem('mode_prompts_json', JSON.stringify(MODE_PROMPTS));
    } catch(e) {
        MODE_PROMPTS = seedDefaultModePrompts();
    }
    registerPromptsVirtualFile();
    AppConfig.load();
    applyConfigToUI();
    // Restore persisted sidebar width (only when not collapsed and not mobile).
    if (!sidebarEl.classList.contains('collapsed') && window.innerWidth > 768) {
        applySidebarWidth(Number(AppConfig.get('sidebar-width', 314)) || 314);
    }
    registerToolsVirtualFiles();
    registerConfigVirtualFile();
    renderToolsList();
    renderExplorerTree();
    const hist = localStorage.getItem('prompt-history');
    if (hist) { try { state.promptHistory = JSON.parse(hist); } catch(e) {} }
    document.getElementById('settings-ui-theme').addEventListener('change', e => {
        AppConfig.set('ui-theme', e.target.value);
        applyTheme();
    });
    document.getElementById('settings-thinking-timeout').addEventListener('input', e => AppConfig.set('thinking-timeout', e.target.value));
    document.getElementById('settings-tool-timeout').addEventListener('input', e => AppConfig.set('tool-timeout', e.target.value));
    initDuoSwitch('settings-keep-skipped-thinking', isOn => AppConfig.set('keep-skipped-thinking', isOn ? "true" : "false"));
    initDuoSwitch('settings-glow-enabled', isOn => {
        AppConfig.set('glow-enabled', isOn ? "true" : "false");
        updateGenGlow();
    });
    document.getElementById('shield-agent-switch').addEventListener('click', e => {
        const btn = e.target.closest('[data-agent-val]');
        if (!btn) return;
        const val = btn.dataset.agentVal;
        AppConfig.set('hide-agent-files', val === 'hide' ? 'true' : 'false');
        updateAgentFilesSwitch();
    });
    const btnWindowToggle = document.getElementById('btn-window-toggle');
    if (btnWindowToggle) {
        btnWindowToggle.addEventListener('click', () => {
            const currentMode = AppConfig.get('window-mode', 'floating') === 'maximized' ? 'maximized' : 'floating';
            const nextMode = currentMode === 'maximized' ? 'floating' : 'maximized';
            AppConfig.set('window-mode', nextMode);
            applyWindowMode(nextMode);
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 160);
        });
    }
    const _ctEl = document.getElementById('settings-compress-threshold');
    const _cpEl = document.getElementById('settings-compress-preserve');
    initDuoSwitch('settings-compress-enabled', isOn => AppConfig.set('compress-enabled', isOn ? 'true' : 'false'));
    initDuoSwitch('settings-webdav-sync-agent', isOn => {
        AppConfig.set('webdav-sync-agent', isOn ? 'true' : 'false');
        if (isOn && rootHandle && rootHandle.isWebDAV) syncAgentFilesWithWorkspace();
    });
    if (_ctEl) _ctEl.addEventListener('input', e => AppConfig.set('compress-threshold', e.target.value));
    if (_cpEl) _cpEl.addEventListener('input', e => AppConfig.set('compress-preserve', e.target.value));
    document.getElementById('btn-clear-data').addEventListener('click', () => {
        openClearDataModal();
    });
    const cdOverlay = document.getElementById('cleardata-modal-overlay');
    const cdCheckboxes = {
        checkpoints: document.getElementById('cleardata-opt-checkpoints'),
        sessions: document.getElementById('cleardata-opt-sessions'),
        models: document.getElementById('cleardata-opt-models'),
        customTools: document.getElementById('cleardata-opt-custom-tools'),
        settings: document.getElementById('cleardata-opt-settings')
    };
    document.getElementById('cleardata-modal-close').addEventListener('click', closeClearDataModal);
    document.getElementById('cleardata-cancel').addEventListener('click', closeClearDataModal);
    cdOverlay.addEventListener('click', (e) => {
        if (e.target === cdOverlay) closeClearDataModal();
    });
    document.getElementById('cleardata-select-all').addEventListener('click', () => {
        Object.values(cdCheckboxes).forEach(cb => { cb.checked = true; });
    });
    document.getElementById('cleardata-select-none').addEventListener('click', () => {
        Object.values(cdCheckboxes).forEach(cb => { cb.checked = false; });
    });
    document.getElementById('cleardata-confirm').addEventListener('click', async () => {
        const opts = {
            checkpoints: cdCheckboxes.checkpoints.checked,
            sessions: cdCheckboxes.sessions.checked,
            models: cdCheckboxes.models.checked,
            customTools: cdCheckboxes.customTools.checked,
            settings: cdCheckboxes.settings.checked
        };
        if (!opts.checkpoints && !opts.sessions && !opts.models && !opts.customTools && !opts.settings) {
            closeClearDataModal();
            return;
        }
        closeClearDataModal();
        await clearSelectedData(opts);
        setTimeout(() => location.reload(), 900);
    });
    renderRecentFoldersList();
    renderExplorerTree();
    await loadAllSessions();
    await initMonaco();
    if (monacoEditor && state.currentEditorPath && state.activeTab === state.currentEditorPath) {
        try { await switchTab(state.activeTab); } catch(e) {}
    }
    if (!rootHandle) {
        if (noFolderOverlay) noFolderOverlay.classList.remove('hidden');
        if (btnExitWorkspace) btnExitWorkspace.style.display = 'none';
        if (btnSessionToggle) btnSessionToggle.style.display = 'none';
    } else {
        if (noFolderOverlay) noFolderOverlay.classList.add('hidden');
        if (btnExitWorkspace) btnExitWorkspace.style.display = 'flex';
        if (btnSessionToggle) btnSessionToggle.style.display = 'flex';
    }
    let startupMode = 'code';
    try {
        const storedMode = localStorage.getItem('last_mode');
        if (storedMode && MODE_CONFIG[storedMode]) startupMode = storedMode;
    } catch(e) {}
    setMode(startupMode);
    renderTabs();
    resizePrompt();
    focusPrompt();
    windowEl.classList.remove('initializing');
    if (appInit) appInit.classList.add('hidden');
    setTimeout(() => { if (appInit) appInit.style.display = 'none'; }, 350);
    forceScrollToBottomOnLoad();
});

window.editPrompt = function(msgId) {
    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrap || wrap.classList.contains('editing')) return;
    const rawPrompt = wrap.getAttribute('data-raw');
    if (rawPrompt === null) return;
    beginInlineEdit(msgId);
};

window.copyAssistantMsg = function(btn) {
    const wrap = btn.closest('.log-entry');
    if (!wrap) return;
    const raw = wrap.getAttribute('data-raw-msg');
    if (raw === null) return;
    navigator.clipboard.writeText(raw).then(() => {
        const icon = btn.querySelector('.icon');
        if (icon) {
            icon.innerText = 'check';
            icon.style.color = 'var(--green)';
            setTimeout(() => {
                icon.innerText = 'content_copy';
                icon.style.color = '';
            }, 1500);
        }
    });
};

window.copyPrompt = function(msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    const rawPrompt = el.getAttribute('data-raw');
    if (rawPrompt === null) return;
    navigator.clipboard.writeText(rawPrompt).then(() => {
        const btn = el.querySelector('.btn-prompt-action.copy .icon');
        if (btn) {
            btn.innerText = 'check';
            btn.style.color = 'var(--green)';
            setTimeout(() => {
                btn.innerText = 'content_copy';
                btn.style.color = '';
            }, 1500);
        }
    });
};

window.deletePrompt = function(msgId) {
    const hasEdits = messageHasFileEdits(collectIdsFromMessage(state.activeSessionId, msgId));
    if (msgDeleteRevertBtn) msgDeleteRevertBtn.style.display = hasEdits ? '' : 'none';
    _pendingDeleteMsgId = msgId;
    msgDeleteModalOverlay.classList.add('visible');
};

msgDeleteOnlyBtn.addEventListener('click', () => {
    if (_pendingDeleteMsgId) commitMsgDelete(_pendingDeleteMsgId, false);
});
msgDeleteRevertBtn.addEventListener('click', async () => {
    if (_pendingDeleteMsgId) {
        msgDeleteRevertBtn.disabled = true;
        try {
            await commitMsgDelete(_pendingDeleteMsgId, true);
        } finally {
            msgDeleteRevertBtn.disabled = false;
        }
    }
});
msgDeleteCancelBtn.addEventListener('click', hideMsgDeleteModal);
msgDeleteModalCloseBtn.addEventListener('click', hideMsgDeleteModal);
msgDeleteModalOverlay.addEventListener('click', (e) => {
    if (e.target === msgDeleteModalOverlay) hideMsgDeleteModal();
});
msgEditOnlyBtn.addEventListener('click', () => commitEditFromModal(false));
msgEditRevertBtn.addEventListener('click', () => commitEditFromModal(true));
msgEditCancelBtn.addEventListener('click', hideMsgEditModal);
msgEditModalCloseBtn.addEventListener('click', hideMsgEditModal);
msgEditModalOverlay.addEventListener('click', (e) => {
    if (e.target === msgEditModalOverlay) hideMsgEditModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.getElementById('yesno-modal-overlay').style.display === 'flex') return;
        if (acPopup.style.display === 'block') {
            acPopup.style.display = 'none';
            return;
        }
        if (sessionsPopoverOverlay.style.display === 'block') {
            hideSessionPopover();
            return;
        }
        if (_toolModelPicker.visible) {
            closeToolModelPicker();
            return;
        }
        const settingsOverlay = document.getElementById('settings-modal-overlay');
        if (settingsOverlay && settingsOverlay.style.display === 'flex') {
            closeSettingsModal();
            return;
        }
        if (contextMenu.style.display === 'block') {
            contextMenu.style.display = 'none';
            return;
        }
        if (viewChanges.style.display !== 'none' && state.checkpointModalMode === 'file' && state.checkpointModalFile) {
            window.showAllCheckpoints();
            return;
        }
        if (permBanner.style.display === 'flex') {
            abortGeneration({ toast: 'Generation stopped (Esc)' });
            return;
        }
        if (isSessionRunning(state.activeSessionId)) {
            const gen = getGenState(state.activeSessionId);
            abortGeneration({ toast: gen.compressionInFlight ? 'Compression cancelled (Esc)' : 'Generation stopped (Esc)' });
            return;
        }
        const editingWrap = document.querySelector('.chat-prompt-wrap.editing');
        if (editingWrap) {
            cancelInlineEdit(editingWrap.getAttribute('data-msg-id'));
            focusPrompt();
            return;
        }
    }
});

window.continueTask = async () => {
    removeContinueButtons();
    await runTask("Continue execution with the next required steps until completion.");
};

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') vfsFlushIfDirty(); });
window.addEventListener('pagehide', vfsFlushIfDirty);
window.addEventListener('beforeunload', (e) => {
    const busy = Object.values(state.sessions).some(s => s._gen && (s._gen.isRunning || s._gen.compressionInFlight));
    if (!busy) return;
    e.preventDefault();
    e.returnValue = '';
});

(function initTriSwitchThumbs() {
    const pending = new Set();
    let raf = 0;
    const LEVELS = ['never', 'ask', 'always', 'off', 'on'];
    function syncThumb(sw) {
        if (!sw.isConnected) return;
        let thumb = sw._triThumb;
        if (!thumb || thumb.parentNode !== sw) {
            thumb = document.createElement('span');
            thumb.className = 'tri-thumb no-anim';
            thumb.setAttribute('aria-hidden', 'true');
            sw.insertBefore(thumb, sw.firstChild);
            sw._triThumb = thumb;
            sw.classList.add('has-thumb');
            if (sizeObserver) sizeObserver.observe(sw);
        }
        const btn = sw.querySelector('.tri-btn.active');
        const br = btn && btn.getBoundingClientRect();
        if (!btn || !br.width) {
            thumb.classList.add('no-anim');
            thumb.style.opacity = '0';
            return;
        }
        const sr = sw.getBoundingClientRect();
        const x = br.left - sr.left - sw.clientLeft;
        const y = br.top - sr.top - sw.clientTop;
        const wasFirst = thumb.classList.contains('no-anim');
        thumb.style.width = br.width + 'px';
        thumb.style.height = br.height + 'px';
        thumb.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        thumb.style.opacity = '1';
        thumb.dataset.level = LEVELS.find(l => btn.classList.contains(l)) || '';
        if (wasFirst) {
            void thumb.offsetWidth;
            thumb.classList.remove('no-anim');
        }
    }
    function queue(sw) {
        pending.add(sw);
        if (!raf) raf = requestAnimationFrame(() => {
            raf = 0;
            const list = Array.from(pending);
            pending.clear();
            list.forEach(syncThumb);
        });
    }
    const sizeObserver = ('ResizeObserver' in window)
        ? new ResizeObserver(entries => entries.forEach(en => queue(en.target)))
        : null;
    new MutationObserver(muts => {
        for (const m of muts) {
            if (m.type === 'attributes') {
                const t = m.target;
                if (!t.classList || !t.classList.contains('tri-btn')) continue;
                const sw = t.closest('.tri-switch');
                if (sw) queue(sw);
            } else {
                if (m.target.closest && m.target.closest('#chat')) continue;
                m.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.matches('.tri-switch')) queue(n);
                    n.querySelectorAll('.tri-switch').forEach(queue);
                });
            }
        }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    document.querySelectorAll('.tri-switch').forEach(queue);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
        document.querySelectorAll('.tri-switch').forEach(queue);
    });
})();

(function makeToolApiFresh() {
    ['readFile', 'writeFile', 'readImage', 'readFileBytes', 'renameFile', 'fileExists', 'isBinary'].forEach(name => {
        const orig = TOOL_API_METHODS[name];
        TOOL_API_METHODS[name] = async (toolName, args, ...rest) => {
            const a = args || [];
            await refreshPathMeta(a[0]);
            return orig(toolName, a, ...rest);
        };
    });
    const origList = TOOL_API_METHODS.listFiles;
    TOOL_API_METHODS.listFiles = async (...a) => {
        await ensureWorkspaceFresh();
        return origList(...a);
    };
})();

input.addEventListener('keydown', async (e) => {
    if (acPopup.style.display === 'block') {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            acSelectedIdx = (acSelectedIdx + 1) % acMatches.length;
            renderAutocomplete();
            return;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            acSelectedIdx = (acSelectedIdx - 1 + acMatches.length) % acMatches.length;
            renderAutocomplete();
            return;
        } else if (e.key === 'Tab') {
            e.preventDefault();
            if (acMatches[acSelectedIdx]) selectAutocompleteItem(acMatches[acSelectedIdx]);
            return;
        }
    }
    if (!state.promptDirty && !input.value.includes('\n')) {
        if (e.key === 'ArrowUp') {
            if (state.promptHistory.length) {
                state.historyIdx = Math.min(state.historyIdx + 1, state.promptHistory.length - 1);
                input.value = state.promptHistory[state.historyIdx];
                resizePrompt();
            }
        } else if (e.key === 'ArrowDown') {
            if (state.historyIdx > 0) {
                state.historyIdx--;
                input.value = state.promptHistory[state.historyIdx];
                resizePrompt();
            } else {
                state.historyIdx = -1; input.value = "";
                resizePrompt();
            }
        }
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
        state.promptDirty = true;
    }
    if (e.key === 'Enter') {
        if (acPopup.style.display === 'block' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const chosen = acMatches[acSelectedIdx];
            if (chosen) {
                selectAutocompleteItem(chosen);
            } else {
                acPopup.style.display = 'none';
            }
            return;
        }
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (acPopup.style.display === 'block') {
                const chosen = acMatches[acSelectedIdx];
                acPopup.style.display = 'none';
                if (chosen) {
                    if (chosen.type === 'file') {
                        selectAutocompleteItem(chosen);
                        return;
                    } else {
                        input.value = chosen.value;
                    }
                }
            }
            await submitPrompt();
        }
    }
});

const btnAboutToggle = document.getElementById('btn-about-toggle');
if (btnAboutToggle) {
    btnAboutToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSessionPopover();
        openSettingsModal('about');
    });
}

const btnThemeToggle = document.getElementById('btn-theme-toggle');
if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const curTheme = AppConfig.get('ui-theme', 'dark');
        const nextTheme = curTheme === 'light' ? 'dark' : 'light';
        AppConfig.set('ui-theme', nextTheme);
        applyTheme();
        const themeSelect = document.getElementById('settings-ui-theme');
        if (themeSelect) themeSelect.value = nextTheme;
    });
}

const btnSidebarSettings = document.getElementById('btn-sidebar-settings');
if (btnSidebarSettings) {
    btnSidebarSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSessionPopover();
        openSettingsModal('workspace');
    });
}

newToolBrowseSearch.addEventListener('input', () => renderGithubToolsList());
newToolBrowseRefresh.addEventListener('click', () => loadGithubToolsList(true));
newToolUpdateAllBtn.addEventListener('click', updateAllGithubTools);

newToolSourceTabs.forEach(tab => {
    tab.addEventListener('click', () => setNewToolPane(tab.dataset.pane));
});

newToolDropzone.addEventListener('click', () => newToolFileInput.click());
newToolDropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newToolFileInput.click(); }
});
newToolFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleNewToolFile(file);
});
['dragenter', 'dragover'].forEach(evt => {
    newToolDropzone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        newToolDropzone.classList.add('dragover');
    });
});
['dragleave', 'dragend'].forEach(evt => {
    newToolDropzone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        newToolDropzone.classList.remove('dragover');
    });
});
newToolDropzone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    newToolDropzone.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
        handleNewToolFile(file);
        return;
    }
});
document.querySelector('#newtool-file-picked .newtool-file-clear').addEventListener('click', () => {
    newToolClearFile();
});
document.getElementById('newtool-install').addEventListener('click', async () => {
    if (!newToolDroppedSource) return;
    const name = newToolNameInput.value.trim();
    if (!name) {
        newToolShowError('Please enter a tool name.');
        newToolNameInput.focus();
        return;
    }
    const result = createToolFile(name, newToolDroppedSource);
    if (!result.ok) {
        newToolShowError(result.error);
        return;
    }
    closeNewToolModal();
    renderExplorerTree();
    renderToolsList();
});
newToolNameInput.addEventListener('input', () => {
    newToolNameAutoFilled = false;
    newToolShowError('');
});
newToolCreateBtn.addEventListener('click', () => {
    const source = newToolSourceEditor.value;
    if (!source.trim()) {
        newToolShowError('Please write the tool source code.');
        newToolSourceEditor.focus();
        return;
    }
    const name = deriveToolNameFromFile(null, source);
    if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        newToolShowError('Could not infer a tool name from the source. Add a valid "name" to TOOL_META.');
        newToolSourceEditor.focus();
        return;
    }
    const result = createToolFile(name, source);
    if (!result.ok) {
        newToolShowError(result.error);
        return;
    }
    closeNewToolModal();
    renderExplorerTree();
    renderToolsList();
});
newToolSourceEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        newToolCreateBtn.click();
    }
});
newToolInstallBtn.addEventListener('click', async () => {
    if (!newToolDroppedSource) return;
    const name = newToolNameInput.value.trim();
    if (!name) {
        newToolShowError('Please enter a tool name.');
        newToolNameInput.focus();
        return;
    }
    const result = createToolFile(name, newToolDroppedSource);
    if (!result.ok) {
        newToolShowError(result.error);
        return;
    }
    closeNewToolModal();
    renderExplorerTree();
    renderToolsList();
});
newToolNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && newToolDroppedSource) { e.preventDefault(); newToolInstallBtn.click(); }
});
const ntCloseBtn = document.getElementById('newtool-modal-close');
if (ntCloseBtn) ntCloseBtn.addEventListener('click', closeNewToolModal);
const ntCancelBtn = document.getElementById('newtool-cancel');
if (ntCancelBtn) ntCancelBtn.addEventListener('click', closeNewToolModal);
if (typeof newToolModalOverlay !== 'undefined' && newToolModalOverlay) {
    newToolModalOverlay.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeNewToolModal();
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && typeof newToolModalOverlay !== 'undefined' && newToolModalOverlay && newToolModalOverlay.style.display === 'flex') {
        closeNewToolModal();
    }
});