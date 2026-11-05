// --- abortGeneration.js ---
// discard: true = the run's output is being thrown away (inline edit, /clear). Invalidates the run so its
// in-flight tool calls drop their boxes silently instead of rendering an "Aborted" error into the chat.
function abortGeneration({ toast = null, showResumeUI = true, sessionId, discard = false } = {}) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (discard) gen.runSeq = (gen.runSeq || 0) + 1;
    const wasRunning = !!(gen.activeController || gen.isRunning);
    const wasCompressing = !!gen.compressionInFlight;

    cancelPendingUIForSession(sid);
    abortToolRunsForSession(sid);

    const queuedForThisSession = permQueue.find(r => r.sessionId === sid);
    if (queuedForThisSession && sid === state.activeSessionId && permBanner.style.display === 'flex') {
        closePerm(false, 'Cancelled - generation stopped');
    } else if (queuedForThisSession) {
        permQueue = permQueue.filter(r => r !== queuedForThisSession);
        queuedForThisSession.resolve({ approved: false, reason: 'Cancelled - generation stopped' });
    }

    gen.retryCancelled = true;
    if (gen.retryTimeout) {
        clearTimeout(gen.retryTimeout);
        gen.retryTimeout = null;
    }
    clearRetryStatus(sid);

    if (gen.activeController) {
        gen.activeController.abort();
        gen.activeController = null;
    }

    stopSpinner(sid);
    gen.isRunning = false;
    gen.compressionInFlight = false;
    if (sid === state.activeSessionId) { updatePromptSendButton(); updateGenGlow(); }

    if (gen.thinkingTimerInterval) {
        clearInterval(gen.thinkingTimerInterval);
        gen.thinkingTimerInterval = null;
    }
    if (sid === state.activeSessionId) removeAllSkipThinkingButtons();

    if (gen.pendingToolDiv) {
        gen.pendingToolDiv.remove();
        gen.pendingToolDiv = null;
    }

    if (showResumeUI && wasRunning && !wasCompressing) {
        gen.genFinishReason = 'abort';
        if (!gen.genEndTime) gen.genEndTime = performance.now();
        renderGenStats(sid);
        // Persist the stats row (stop reason, token speed, Continue button) into
        // the session's chatHTML so it survives a page reload.
        if (sid === state.activeSessionId) {
            gen.hasNewContent = true;
            saveSession(sid);
        }
    }

    if (toast) showToast(toast, 'info');
    if (sid === state.activeSessionId) focusPrompt();

    // On manual stop, restore a queued prompt to the input instead of auto-sending it.
    const queued = state.queuedPrompts[sid];
    if (queued) {
        delete state.queuedPrompts[sid];
        if (sid === state.activeSessionId) {
            input.value = queued.val;
            state.attachedReferences = queued.attachedReferences || [];
            renderAttachmentChips();
            resizePrompt();
            renderQueuedPromptBanner();
        }
    }
}

// --- AST_EXPORTS_START ---
window.abortGeneration = abortGeneration;
// --- AST_EXPORTS_END ---

// --- attachReference.js ---
function attachReference(refObj) {
    if (refObj.type === 'image' || refObj.type === 'paste') {
        attachmentIdCounter++;
        refObj.attachmentId = `att_${Date.now().toString(36)}_${attachmentIdCounter}`;
        state.attachmentStore[refObj.attachmentId] = refObj;
    }
    state.attachedReferences.push(refObj);
    renderAttachmentChips();
    focusPrompt();
}

// --- AST_EXPORTS_START ---
window.attachReference = attachReference;
// --- AST_EXPORTS_END ---

// --- beginInlineEdit.js ---
function beginInlineEdit(msgId) {
    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrap || wrap.classList.contains('editing')) return;
    const rawPrompt = wrap.getAttribute('data-raw');
    if (rawPrompt === null) return;

    const decodedPrompt = rawPrompt;
    const promptRow = wrap.querySelector('.chat-prompt-row');
    const actionsRow = wrap.querySelector('.prompt-actions');
    if (!promptRow || !actionsRow) return;

    wrap.classList.add('editing');
    wrap.dataset.originalRowHtml = promptRow.innerHTML;
    wrap.dataset.originalActionsHtml = actionsRow.innerHTML;

    state.preEditAttachedReferences = state.attachedReferences;
    const attachmentsRaw = wrap.getAttribute('data-attachments');
    let restoredAttachments = [];
    if (attachmentsRaw) {
        try {
            restoredAttachments = JSON.parse(attachmentsRaw) || [];
        } catch (e) {
            restoredAttachments = [];
        }
    }
    state.attachedReferences = restoredAttachments;
    for (const ref of restoredAttachments) {
        if (ref && (ref.type === 'image' || ref.type === 'paste')) {
            if (!state.attachmentStore[ref.attachmentId]) {
                state.attachmentStore[ref.attachmentId] = ref;
            }
        }
    }
    renderAttachmentChips();

    promptRow.innerHTML = '';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.setAttribute('data-value', decodedPrompt);

    const textarea = document.createElement('textarea');
    textarea.className = 'inline-edit-textarea';
    textarea.value = decodedPrompt;
    textarea.rows = 1;
    textarea.cols = 1;

    textarea.addEventListener('input', () => {
        bubble.setAttribute('data-value', textarea.value);
    });
    bubble.appendChild(textarea);
    promptRow.appendChild(bubble);

    actionsRow.innerHTML = `
        <button class="btn-prompt-action cancel icon-btn" title="Cancel edit"><span class="icon" style="font-size:13px;">close</span></button>
        <button class="btn-prompt-action save icon-btn" title="Save and regenerate"><span class="icon" style="font-size:13px;">check</span></button>
    `;
    actionsRow.style.opacity = '1';

    actionsRow.querySelector('.save').addEventListener('click', () => showEditConfirmModal(msgId));
    actionsRow.querySelector('.cancel').addEventListener('click', () => cancelInlineEdit(msgId));
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            showEditConfirmModal(msgId);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancelInlineEdit(msgId);
        }
    });

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// --- AST_EXPORTS_START ---
window.beginInlineEdit = beginInlineEdit;
// --- AST_EXPORTS_END ---

// --- cancelInlineEdit.js ---
function cancelInlineEdit(msgId) {
    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrap || !wrap.classList.contains('editing')) return;
    const promptRow = wrap.querySelector('.chat-prompt-row');
    const actionsRow = wrap.querySelector('.prompt-actions');
    if (promptRow && wrap.dataset.originalRowHtml !== undefined) promptRow.innerHTML = wrap.dataset.originalRowHtml;
    if (actionsRow && wrap.dataset.originalActionsHtml !== undefined) actionsRow.innerHTML = wrap.dataset.originalActionsHtml;
    actionsRow.style.opacity = '';
    wrap.classList.remove('editing');
    delete wrap.dataset.originalRowHtml;
    delete wrap.dataset.originalActionsHtml;

    state.attachedReferences = state.preEditAttachedReferences || [];
    state.preEditAttachedReferences = null;
    renderAttachmentChips();
}

// --- AST_EXPORTS_START ---
window.cancelInlineEdit = cancelInlineEdit;
// --- AST_EXPORTS_END ---

// --- cancelPendingUIForSession.js ---
function cancelPendingUIForSession(sid) {
    const mine = pendingUIQueue.filter(r => r.sessionId === sid);
    mine.forEach(r => { try { r.finish(null, true); } catch (_) {} });
}

// --- AST_EXPORTS_START ---
window.cancelPendingUIForSession = cancelPendingUIForSession;
// --- AST_EXPORTS_END ---

// --- checkAutocomplete.js ---
function checkAutocomplete() {
    const cursor = input.selectionStart;
    const val = input.value;
    const textBefore = val.slice(0, cursor);

    if (textBefore.startsWith('/')) {
        const query = textBefore.toLowerCase();
        acMatches = SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(query)).map(c => ({
            type: 'command',
            value: c.cmd,
            title: c.cmd,
            desc: c.desc
        }));

        if (typeof window.getSkillsAutocompleteMatches === 'function') {
            const skillMatches = window.getSkillsAutocompleteMatches(query);
            acMatches = [...acMatches, ...skillMatches];
        }

        if (acMatches.length > 0) {
            acSelectedIdx = 0;
            renderAutocomplete();
            acPopup.style.display = 'block';
            return;
        }
    }

    const atMatch = textBefore.match(/@([^\s]*)$/);
    if (atMatch && Object.keys(registry.meta).length > 0) {
        const query = atMatch[1].toLowerCase();
        const matchedFiles = Object.keys(registry.meta).filter(f => registry.meta[f]?.kind === 'file' && f.toLowerCase().includes(query) && !shouldHideFromTools(f)).slice(0, 8);
        if (matchedFiles.length > 0) {
            acMatches = matchedFiles.map(f => ({
                type: 'file',
                value: f,
                title: '@' + f,
                desc: 'attach file reference'
            }));
            acSelectedIdx = 0;
            renderAutocomplete();
            acPopup.style.display = 'block';
            return;
        }
    }

    acPopup.style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.checkAutocomplete = checkAutocomplete;
// --- AST_EXPORTS_END ---

// --- clearSessionAttachments.js ---
// Removes every materialized attachment file from the virtual filesystem
// (and any saved snapshot for the given/current session, in memory and -
// unless the session record itself is being deleted separately - in
// IndexedDB). Used when a session is actually being wiped (/clear, collapsing
// the last remaining session, deleting the active session) - as opposed to
// switching away, where attachments should be preserved and swapped back in
// later (see snapshotSessionAttachments/restoreSessionAttachments).
function clearSessionAttachments(sessionId, opts = {}) {
    let removedAny = false;
    Object.keys(registry.meta).forEach(fp => {
        if (isAttachmentPath(fp) && fp !== ATTACHMENTS_DIR) {
            delete registry.meta[fp];
            delete registry.files[fp];
            removedAny = true;
        }
    });
    delete registry.meta[ATTACHMENTS_DIR];
    const sid = sessionId || state.activeSessionId;
    if (state.sessions[sid]) {
        delete state.sessions[sid]._attachments;
        delete state.sessions[sid].attachments;
    }
    if (opts.purgeDB !== false) {
        patchSessionRecordInDB(getWorkspaceSessionKey(), sid, { attachments: null }).catch(() => {});
    }
    if (removedAny) renderExplorerTree();
}

// --- AST_EXPORTS_START ---
window.clearSessionAttachments = clearSessionAttachments;
// --- AST_EXPORTS_END ---

// --- commitEditFromModal.js ---
function commitEditFromModal(revert) {
    const msgId = _pendingEditMsgId;
    if (!msgId) return;

    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrap || !wrap.classList.contains('editing')) {
        _pendingEditMsgId = null;
        _pendingEditText = null;
        return;
    }

    const newText = _pendingEditText;
    const doRevert = revert;

    // Clear pending state
    _pendingEditMsgId = null;
    _pendingEditText = null;
    _pendingEditRevert = false;
    _pendingEditRevertIds = [];
    msgEditModalOverlay.classList.remove('visible');

    // Unconditional: a waiting show_options card / tool worker must never outlive the edit.
    abortGeneration({ showResumeUI: false, discard: true });

    const editSid = state.activeSessionId;
    const rawForRevert = wrap.getAttribute('data-raw') || '';

    // Single shared entry point: trims this message + everything after it
    // from state/session/DOM, and (if requested) reverts the file changes
    // those messages made.
    const result = truncateFromMessage(editSid, msgId, {
        revert: doRevert,
        revertLabel: rawForRevert
    });

    if (result && result.cutIndex === 0) {
        state.sessions[editSid]._titleGenerated = false;
        state.sessions[editSid].title = 'Untitled Session';
        updateSessionPillLabel();
    }

    state.preEditAttachedReferences = null;

    if (doRevert && result && result.removedIds.length) {
        window.revertToBeforePrompt(result.removedIds, rawForRevert, { skipConfirm: true });
    }

    input.value = newText;
    resizePrompt();
    submitPrompt();
}

// --- AST_EXPORTS_START ---
window.commitEditFromModal = commitEditFromModal;
// --- AST_EXPORTS_END ---

// --- commitMsgDelete.js ---
async function commitMsgDelete(msgId, revert) {
    hideMsgDeleteModal();

    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    const raw = wrap ? wrap.getAttribute('data-raw') : '';

    // Single shared entry point: trims this message + everything after it
    // from state/session/DOM, and (if requested) reverts the file changes
    // those messages made.
    const result = truncateFromMessage(state.activeSessionId, msgId, {
        revert,
        revertLabel: raw
    });

    if (revert && result && result.removedIds.length) {
        await window.revertToBeforePrompt(result.removedIds, raw, { skipConfirm: true });
    }

    updateTokenStatus(state.lastTokenUsage);
    state.sessions[state.activeSessionId].chatHTML = serializeTermHTML();
    updateWelcomeVisibility();
}

// --- AST_EXPORTS_START ---
window.commitMsgDelete = commitMsgDelete;
// --- AST_EXPORTS_END ---

// --- handleAttachFile.js ---
async function handleAttachFile(file) {
    const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] || '').toLowerCase();
    const isImage = file.type && file.type.startsWith('image/');
    try {
        if (isImage) {
            if (!currentModelHasVision()) {
                showToast(`Cannot attach ${file.name || 'image'}: the selected model does not support vision`, 'error');
                return;
            }
            const dataUrl = await toPngDataUrl(file);
            pastedImageCounter++;
            attachReference({
                type: 'image',
                name: file.name || `attached-image-${pastedImageCounter}.${ext || 'png'}`,
                dataUrl,
                mimeType: 'image/png'
            });
        } else {
            // No extension whitelist: decide from the file's bytes, so any text file
            // (.c, .sql, Dockerfile, extensionless, unknown formats) can be attached.
            const sniffed = await readFileTextSniffed(file);
            if (sniffed.binary) {
                showToast(`Cannot attach ${file.name || 'file'}: it looks like a binary file, not text`, 'error');
                return;
            }
            const text = sniffed.text;

            pastedTextCounter++;
            attachReference({
                type: 'paste',
                name: file.name || `attached-text-${pastedTextCounter}.txt`,
                content: text,
                lineCount: text.split('\n').length
            });
        }
    } catch (err) {
        showToast(`Could not read file: ${err.message}`, 'error');
    }
}

// --- AST_EXPORTS_START ---
window.handleAttachFile = handleAttachFile;
// --- AST_EXPORTS_END ---

// --- hideMsgDeleteModal.js ---
function hideMsgDeleteModal() {
    msgDeleteModalOverlay.classList.remove('visible');
    _pendingDeleteMsgId = null;
}

// --- AST_EXPORTS_START ---
window.hideMsgDeleteModal = hideMsgDeleteModal;
// --- AST_EXPORTS_END ---

// --- hideMsgEditModal.js ---
function hideMsgEditModal() {
    msgEditModalOverlay.classList.remove('visible');
    _pendingEditMsgId = null;
    _pendingEditText = null;
    _pendingEditRevert = false;
    _pendingEditRevertIds = [];
}

// --- AST_EXPORTS_START ---
window.hideMsgEditModal = hideMsgEditModal;
// --- AST_EXPORTS_END ---

// --- materializeAttachment.js ---
function materializeAttachment(ref) {
    if (ref.materializedPath && registry.meta[ref.materializedPath] !== undefined) {
        return ref.materializedPath;
    }

    const rawName = (ref.name || 'attachment').split('/').pop().split('\\').pop();
    let base = rawName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
    let candidate = `${ATTACHMENTS_DIR}/${base}`;
    let n = 1;
    while (registry.meta[candidate] !== undefined) {
        const dotIdx = base.lastIndexOf('.');
        const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
        const ext = dotIdx > 0 ? base.slice(dotIdx) : '';
        candidate = `${ATTACHMENTS_DIR}/${stem}_${n}${ext}`;
        n++;
    }

    const content = ref.type === 'image' ? ref.dataUrl : (ref.content || '');
    registry.files[candidate] = content;
    registry.meta[ATTACHMENTS_DIR] = { kind: 'directory' };
    registry.meta[candidate] = {
        kind: 'file',
        size: ref.type === 'image' ? dataUrlByteSize(content) : content.length,
        isBinary: ref.type === 'image',
        virtual: true,
        readOnly: true,
        attachment: true
    };

    ref.materializedPath = candidate;
    renderExplorerTree();
    return candidate;
}

// --- AST_EXPORTS_START ---
window.materializeAttachment = materializeAttachment;
// --- AST_EXPORTS_END ---

// --- reapDeadPendingUI.js ---
// A waiting card whose tool run is gone (aborted, timed out, crashed, finished) can never be answered: drop it.
function reapDeadPendingUI() {
    const live = new Set(toolWorkerPending.values());
    pendingUIQueue.filter(r => !r.entry || !live.has(r.entry))
        .forEach(r => { try { r.finish(null, true); } catch (_) {} });
}

// --- AST_EXPORTS_START ---
window.reapDeadPendingUI = reapDeadPendingUI;
// --- AST_EXPORTS_END ---

// --- registerAttachmentsVirtualFiles.js ---
function registerAttachmentsVirtualFiles() {
    const paths = Object.keys(registry.files).filter(isAttachmentPath);
    if (!paths.length) return;
    registry.meta[ATTACHMENTS_DIR] = { kind: 'directory' };
    paths.forEach(fp => {
        const content = registry.files[fp] || '';
        const isImg = isImageFilePath(fp);
        registry.meta[fp] = {
            kind: 'file',
            size: isImg ? dataUrlByteSize(content) : content.length,
            isBinary: isImg,
            virtual: true,
            readOnly: true,
            attachment: true
        };
    });
}

// --- AST_EXPORTS_START ---
window.registerAttachmentsVirtualFiles = registerAttachmentsVirtualFiles;
// --- AST_EXPORTS_END ---

// --- remountPendingUIForSession.js ---
function remountPendingUIForSession(sid) {
    pendingUIQueue.filter(r => r.sessionId === sid).forEach(r => { try { r.mount(); } catch (_) {} });
}

// --- AST_EXPORTS_START ---
window.remountPendingUIForSession = remountPendingUIForSession;
// --- AST_EXPORTS_END ---

// --- removeAllSkipThinkingButtons.js ---
function removeAllSkipThinkingButtons() {
    getGenState(state.activeSessionId).isThinkingNow = false;
    document.querySelectorAll('.btn-skip-thinking').forEach(b => b.remove());
}

// --- AST_EXPORTS_START ---
window.removeAllSkipThinkingButtons = removeAllSkipThinkingButtons;
// --- AST_EXPORTS_END ---

// --- removeContinueButtons.js ---
function removeContinueButtons() {
    const buttons = Array.from(document.querySelectorAll('.gen-continue-btn'));
    if (buttons.length > 1) {
        buttons.slice(0, -1).forEach(b => b.remove());
    }
}

// --- AST_EXPORTS_START ---
window.removeContinueButtons = removeContinueButtons;
// --- AST_EXPORTS_END ---

// --- removeReference.js ---
function removeReference(idx) {
    state.attachedReferences.splice(idx, 1);
    renderAttachmentChips();
    focusPrompt();
}

// --- AST_EXPORTS_START ---
window.removeReference = removeReference;
// --- AST_EXPORTS_END ---

// --- renderAttachmentChips.js ---
function renderAttachmentChips() {
    promptAttachments.innerHTML = '';
    state.attachedReferences.forEach((ref, idx) => {
        const chip = document.createElement('div');
        chip.className = 'prompt-chip';
        if (ref.type === 'snippet') {
            const lineCount = ref.endLine - ref.startLine + 1;
            chip.innerHTML = `
                <span class="icon" style="font-size:12px; color:var(--primary);">code</span>
                <span>@${escapeHTML(ref.filepath)}:${ref.startLine}-${ref.endLine} (${lineCount} lines)</span>
                <span class="prompt-chip-remove icon">close</span>
            `;
        } else if (ref.type === 'image') {
            chip.classList.add('attachment-image');
            chip.title = 'Click to preview in a tab';
            chip.innerHTML = `
                <img class="prompt-chip-thumb" src="${ref.dataUrl}" alt="${escapeHTML(ref.name)}">
                <span>${escapeHTML(ref.name)}</span>
                <span class="prompt-chip-remove icon">close</span>
            `;
            chip.addEventListener('click', (e) => {
                if (e.target.closest('.prompt-chip-remove')) return;
                window.openAttachmentTab(ref.attachmentId);
            });
        } else if (ref.type === 'paste') {
            chip.classList.add('attachment-paste');
            chip.title = 'Click to preview in a tab';
            chip.innerHTML = `
                <span class="icon" style="font-size:12px; color:var(--yellow);">description</span>
                <span>${escapeHTML(ref.name)} (${ref.lineCount} lines)</span>
                <span class="prompt-chip-remove icon">close</span>
            `;
            chip.addEventListener('click', (e) => {
                if (e.target.closest('.prompt-chip-remove')) return;
                window.openAttachmentTab(ref.attachmentId);
            });
        } else {
            chip.innerHTML = `
                <span class="icon" style="font-size:12px; color:var(--primary);">description</span>
                <span>@${escapeHTML(ref.filepath)}</span>
                <span class="prompt-chip-remove icon">close</span>
            `;
        }
        chip.querySelector('.prompt-chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeReference(idx);
        });
        promptAttachments.appendChild(chip);
    });
}

// --- AST_EXPORTS_START ---
window.renderAttachmentChips = renderAttachmentChips;
// --- AST_EXPORTS_END ---

// --- renderAutocomplete.js ---
function renderAutocomplete() {
    acPopup.innerHTML = '';
    acMatches.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = `ac-item ${idx === acSelectedIdx ? 'selected' : ''}`;
        row.innerHTML = `
            <span class="ac-item-title">${escapeHTML(item.title)}</span>
            <span class="ac-item-desc">${escapeHTML(item.desc)}</span>
        `;
        row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectAutocompleteItem(item);
        });
        acPopup.appendChild(row);
    });
}

// --- AST_EXPORTS_START ---
window.renderAutocomplete = renderAutocomplete;
// --- AST_EXPORTS_END ---

// --- restoreSessionAttachments.js ---
// Restores a session's previously-snapshotted attachments (if any) into the
// live registry, so tools/explorer see the same attachment files the session
// had when it was last active. Prefers the in-memory snapshot (fast, same
// page load); falls back to whatever was persisted to IndexedDB (survives a
// reload) when there is no in-memory snapshot yet.
function restoreSessionAttachments(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const session = state.sessions[sid];
    const saved = session && (session._attachments || session.attachments);
    if (!saved || !saved.files) return;
    registry.meta[ATTACHMENTS_DIR] = { kind: 'directory' };
    Object.keys(saved.files).forEach(fp => {
        registry.files[fp] = saved.files[fp];
        registry.meta[fp] = saved.meta[fp];
    });
    if (session) session._attachments = saved;
}

// --- AST_EXPORTS_START ---
window.restoreSessionAttachments = restoreSessionAttachments;
// --- AST_EXPORTS_END ---

// --- sanitizeMessages.js ---
function sanitizeMessages(msgs) {
    const clean = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m) continue;

        if (clean.length > 0) {
            const prev = clean[clean.length - 1];
            if (prev.role === 'assistant' && m.role === 'assistant') {
                prev.content = (prev.content ? prev.content + "\n" : "") + (m.content || "");
                if (m.tool_calls) {
                    prev.tool_calls = prev.tool_calls ? [...prev.tool_calls, ...m.tool_calls] : m.tool_calls;
                }
                continue;
            }
        }

        let safeM = { ...m };


        if (safeM.tool_calls) {
            safeM.tool_calls = safeM.tool_calls.map(tc => {
                let safeArgs = tc.function.arguments;
                try {
                    JSON.parse(safeArgs);
                } catch(e) {
                    safeArgs = "{}";
                }
                return {
                    ...tc,
                    function: { ...tc.function, arguments: safeArgs }
                };
            });
        }

        clean.push(safeM);
    }
    while (clean.length > 0 && clean[clean.length - 1].role === 'assistant') {
        clean.pop();
    }
    return clean;
}

// --- AST_EXPORTS_START ---
window.sanitizeMessages = sanitizeMessages;
// --- AST_EXPORTS_END ---

// --- selectAutocompleteItem.js ---
function selectAutocompleteItem(item) {
    if (item.type === 'command' || item.type === 'skill') {
        input.value = item.value.endsWith(' ') ? item.value : item.value + ' ';
        acPopup.style.display = 'none';
        resizePrompt();
        input.focus();
    } else if (item.type === 'file') {
        const cursor = input.selectionStart;
        const textBefore = input.value.slice(0, cursor);
        const textAfter = input.value.slice(cursor);
        const atIndex = textBefore.lastIndexOf('@');

        input.value = textBefore.slice(0, atIndex) + textAfter;
        input.selectionStart = input.selectionEnd = atIndex;

        acPopup.style.display = 'none';
        resizePrompt();
        attachReference({ type: 'file', filepath: item.value });
    }
}

// --- AST_EXPORTS_START ---
window.selectAutocompleteItem = selectAutocompleteItem;
// --- AST_EXPORTS_END ---

// --- serializeLiveAttachments.js ---
// Serializes the currently-live .agent/attachments/* entries into a plain
// object suitable for IndexedDB storage (and for the in-memory session-switch
// snapshot, which uses the same shape).
function serializeLiveAttachments() {
    const files = {};
    const meta = {};
    let any = false;
    Object.keys(registry.meta).forEach(fp => {
        if (isAttachmentPath(fp) && fp !== ATTACHMENTS_DIR) {
            meta[fp] = registry.meta[fp];
            files[fp] = registry.files[fp];
            any = true;
        }
    });
    return any ? { files, meta } : null;
}

// --- AST_EXPORTS_START ---
window.serializeLiveAttachments = serializeLiveAttachments;
// --- AST_EXPORTS_END ---

// --- showEditConfirmModal.js ---
function showEditConfirmModal(msgId) {
    const wrap = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrap || !wrap.classList.contains('editing')) return;
    const textarea = wrap.querySelector('.inline-edit-textarea');
    if (!textarea) return;
    const newText = textarea.value.trim();
    if (!newText) return;

    // Every message from this one onward will be trimmed; check whether any
    // of them left file changes behind, so we know whether to offer "revert".
    const candidateIds = collectIdsFromMessage(state.activeSessionId, msgId);
    const hasEdits = messageHasFileEdits(candidateIds);

    _pendingEditMsgId = msgId;
    _pendingEditRevert = false;
    _pendingEditRevertIds = hasEdits ? candidateIds : [];
    _pendingEditText = newText;

    if (hasEdits) {
        msgEditModalOverlay.classList.add('visible');
    } else {
        // No file changes to revert — commit the edit directly.
        commitEditFromModal(false);
    }
}

// --- AST_EXPORTS_START ---
window.showEditConfirmModal = showEditConfirmModal;
// --- AST_EXPORTS_END ---

// --- snapshotSessionAttachments.js ---
// Moves the currently-live .agent/attachments/* entries out of the registry
// and stores them on the (outgoing) session record, so they can be swapped
// back in immediately if the user returns to this session later in the same
// page load. Persistence across a reload is handled separately by saveSession
// writing the same shape into IndexedDB (see the `attachments` field there).
function snapshotSessionAttachments(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const session = state.sessions[sid];
    const saved = serializeLiveAttachments();
    Object.keys(registry.meta).forEach(fp => {
        if (isAttachmentPath(fp)) delete registry.meta[fp];
    });
    Object.keys(registry.files).forEach(fp => {
        if (isAttachmentPath(fp)) delete registry.files[fp];
    });
    if (session) {
        if (saved) session._attachments = saved;
        else delete session._attachments;
    }
}

// --- AST_EXPORTS_START ---
window.snapshotSessionAttachments = snapshotSessionAttachments;
// --- AST_EXPORTS_END ---

// --- stripImagesFromMessages.js ---
// Returns a copy of msgs with image parts replaced by text placeholders for text-only models; stored history is untouched.
function stripImagesFromMessages(msgs) {
    // Rewrite the "image provided above" note so it doesn't claim an image that was stripped.
    const staleClaim = /(\[Image attached: [^\]]*?\.) The full image is provided directly above as visual input;[^\]]*\]/g;
    const rewrite = (text) => typeof text === 'string'
        ? text.replace(staleClaim, '$1 The selected model cannot view images, so the image was NOT sent to it; do not describe or guess its contents.]')
        : text;
    return msgs.map(m => {
        if (!m) return m;
        if (typeof m.content === 'string') {
            const r = rewrite(m.content);
            return r === m.content ? m : { ...m, content: r };
        }
        if (!Array.isArray(m.content)) return m;
        if (!m.content.some(part => part && part.type === 'image_url')) return m;
        const parts = m.content.map(part => (part && part.type === 'image_url')
            ? { type: 'text', text: '[image omitted: the selected model does not support vision]' }
            : (part && part.type === 'text' ? { ...part, text: rewrite(part.text) } : part));
        // Collapse to a plain string when only text remains: the most widely compatible shape.
        const text = parts.map(part => (part && part.type === 'text') ? part.text : '').filter(Boolean).join('\n');
        return { ...m, content: text };
    });
}

// --- AST_EXPORTS_START ---
window.stripImagesFromMessages = stripImagesFromMessages;
// --- AST_EXPORTS_END ---

// --- submitPrompt.js ---
async function submitPrompt() {
        // Commands run instantly, even mid-generation; only real prompts get queued.
        if (isSessionRunning(state.activeSessionId) && !isSlashCommand(input.value)) {
            const val = input.value.trim();
            const hasAttachments = state.attachedReferences.length > 0;
            if (!val && !hasAttachments) {
                showToast('Task already running in this session — press Esc to cancel', 'info');
                return;
            }
            queuePrompt(state.activeSessionId, val, state.attachedReferences);
            input.value = "";
            resizePrompt();
            state.attachedReferences = [];
            renderAttachmentChips();
            return;
        }

        const val = input.value.trim();
        const hasAttachments = state.attachedReferences.length > 0;

        if (!val && !hasAttachments) return;

        input.value = "";
        resizePrompt();

        // Ensure the terminal view is scrolled to the bottom before any action
        state.userScrolledUp = false;
        term.scrollTop = term.scrollHeight;

        if (val) {
            state.promptHistory.unshift(val);
            try {
                localStorage.setItem('prompt-history', JSON.stringify(state.promptHistory.slice(0, 50)));
            } catch (e) {
                console.warn('Failed to save prompt history:', e);
            }
            state.historyIdx = -1;
            state.promptDirty = false;
        }

        let activeSkillPrefix = "";
        let promptTextForLLM = val;

        if (val.startsWith('/')) {
            const parts = val.split(' ');
            const cmd = parts[0].toLowerCase();

            if (cmd.startsWith('/skill:') || cmd === '/skill') {
                const skillName = cmd.startsWith('/skill:')
                    ? cmd.slice(7).trim().toLowerCase()
                    : (parts[1] || '').trim().toLowerCase();
                const restOfPrompt = cmd.startsWith('/skill:')
                    ? val.slice(parts[0].length).trim()
                    : parts.slice(2).join(' ').trim();

                const skill = typeof window.getSkillByName === 'function'
                    ? window.getSkillByName(skillName)
                    : window.state?.skills?.[skillName];

                if (!skill) {
                    const available = Object.keys(window.state?.skills || {});
                    const availMsg = available.length ? ` Available skills: ${available.join(', ')}` : ' No skills found in .agent/skills/.';
                    showToast(`Skill "${skillName || ''}" not found.${availMsg}`, 'error');
                    focusPrompt();
                    return;
                }

                if (!restOfPrompt && state.attachedReferences.length === 0) {
                    print(`<div><span class="icon" style="color:var(--green); font-size:15px; vertical-align:middle; margin-right:4px;">auto_awesome</span><b>Skill:</b> <code class="cyan">${escapeHTML(skill.name)}</code><div class="dim" style="font-size:12px; margin-top:2px;">${escapeHTML(skill.description)}</div><div style="font-size:11.5px; margin-top:4px; opacity:0.8;">Ready. Ask your question using <code>/skill:${escapeHTML(skill.name)} &lt;request&gt;</code>.</div></div>`, "log-entry");
                    input.value = `/skill:${skill.name} `;
                    resizePrompt();
                    focusPrompt();
                    return;
                }

                activeSkillPrefix = `[Active Skill: ${skill.name}]\n<skill_instructions>\n${skill.body}\n</skill_instructions>\n\n`;
                promptTextForLLM = restOfPrompt || val;
            }

            const matchingCommand = SLASH_COMMANDS.find(c => c.cmd === cmd);

            if (matchingCommand && MODE_CONFIG[cmd.slice(1)]) {
                const newMode = cmd.slice(1);
                setMode(newMode);
                showToast(`Switched to ${MODE_CONFIG[newMode].name} mode`, 'info');
                focusPrompt();
                return;
            }

            if (cmd === '/execute-plan') {
                if (isSessionRunning(state.activeSessionId)) {
                    showToast('Cannot execute plan while generating — press Esc to stop first', 'error');
                    focusPrompt();
                    return;
                }
                await window.executePlan();
                focusPrompt();
                return;
            }

            if (cmd === '/continue') {
                if (isSessionRunning(state.activeSessionId)) {
                    showToast('Already generating — press Esc to stop first', 'error');
                    focusPrompt();
                    return;
                }
                await window.continueTask();
                focusPrompt();
                return;
            }

            if (cmd === '/restore') {
                await window.restoreAllModifiedFiles();
                focusPrompt();
                return;
            }

            if (cmd === '/compact') {
                if (isSessionRunning(state.activeSessionId)) {
                    showToast('Cannot compact while generating', 'error');
                    focusPrompt();
                    return;
                }
                await compressContext(state.activeSessionId, { silent: false, manual: true });
                focusPrompt();
                return;
            }

            if (cmd === '/clear') {
                // A queued prompt belongs to the chat being wiped: drop it instead of letting abort restore it to the input.
                delete state.queuedPrompts[state.activeSessionId];
                renderQueuedPromptBanner();
                // Unconditional: cancels pending UI cards, the tool worker and permission prompts,
                // and invalidates the run so late tool results can't repaint the cleared chat.
                abortGeneration({ showResumeUI: false, discard: true });
                state.messages = [];
                state.modifiedFiles.clear();
                state.linesAdded = 0;
                state.linesRemoved = 0;
                state.lastTokenUsage = null;
                getGenState(state.activeSessionId).postCompressTokenOverride = null;
                updateTokenStatus(null);
                term.innerHTML = '';
                resetScrollState();
                state.sessions[state.activeSessionId]._titleGenerated = false;
                state.sessions[state.activeSessionId].title = 'Untitled Session';
                updateSessionPillLabel();

                registry.originalFiles = {};
                registry.opsLog = {};
                registry.compressionHistory = [];
                clearSessionAttachments();

                renderChangesPanel();
                updateStatusInfo();
                state.checkpointModalFile = null;
                state.checkpointModalMode = 'all';
                graphBreadcrumb.classList.remove('visible');
                graphPanelLabel.style.display = '';
                renderAllPromptGroups();
                await persistCheckpoint();
                await saveActiveSession(true);
                focusPrompt();
                updateWelcomeVisibility();
                return;
            }

            if (cmd === '/new') {
                createNewSession();
                focusPrompt();
                return;
            }

            if (cmd === '/session') {
                showSessionPopover();
                focusPrompt();
                return;
            }

            if (cmd === '/help') {
                print(`<div><span class="magenta bold">Code Agent Commands:</span><br>
- <span class="yellow">/plan</span> — Switch to Plan mode (creates ${PLAN_FILE})<br>
- <span class="cyan">/ask</span> — Switch to Ask mode (read-only queries)<br>
- <span class="magenta">/code</span> — Switch to Code mode (full code edits)<br>
- <span class="green">/execute-plan</span> — Execute ${PLAN_FILE} in Code mode<br>
- <span class="cyan">/continue</span> — Resume autonomous execution if paused<br>
- <span class="cyan">/compact</span> — Compress conversation history to free up context<br>
- <span class="cyan">/new</span> — Create a fresh session<br>
- <span class="cyan">/session</span> — Open top session menu<br>
- <span class="cyan">/clear</span> — Reset session (clears messages, chat, modified files)<br>
- <span class="cyan">/restore</span> — Discard all modified files to original baseline<br>

- <span class="cyan">/skill:&lt;name&gt;</span> — Invoke skill from .agent/skills/&lt;name&gt;/SKILL.md<br>

- <span class="cyan">Ctrl+S</span> / <span class="cyan">Ctrl+Shift+S</span> — Save / Save As (editor)<br>
- <span class="cyan">@&lt;file&gt;</span> — Reference file context in prompt<br>
- <span class="yellow">ESC</span> — Cancel current generation</div>`, "dim");
                focusPrompt();
                return;
            }
        }

        let fullPromptForLLM = "";
        let chatAttachmentsHTML = "";

        if (state.attachedReferences.length > 0) {
            fullPromptForLLM += "Context References:\n";
            for (const ref of state.attachedReferences) {
                if (ref.type === 'snippet') {
                    fullPromptForLLM += `File: ${ref.filepath} (lines ${ref.startLine}-${ref.endLine}):\n\`\`\`\n${ref.code}\n\`\`\`\n\n`;
                    const lineCount = ref.endLine - ref.startLine + 1;
                    chatAttachmentsHTML += `
                        <div class="prompt-chip">
                            <span class="icon" style="font-size:12px; color:var(--primary);">code</span>
                            <span>@${escapeHTML(ref.filepath)}:${ref.startLine}-${ref.endLine} (${lineCount} lines)</span>
                        </div>
                    `;
                } else if (ref.type === 'image') {
                    const attPath = materializeAttachment(ref);
                    if (currentModelHasVision()) {
                        fullPromptForLLM += `[Image attached: ${attPath}. The full image is provided directly above as visual input; use the preview_image tool with x/y/width/height on this path to zoom into a specific region if needed.]\n\n`;
                    } else {
                        fullPromptForLLM += `[Image attached: ${attPath}. The selected model cannot view images, so the image was NOT sent to it; do not describe or guess its contents.]\n\n`;
                    }
                    chatAttachmentsHTML += `
                        <div class="chat-attachment-image" title="Click to preview: ${escapeHTML(ref.name)}" data-attachment-id="${ref.attachmentId}">
                            <img src="${ref.dataUrl}" alt="${escapeHTML(ref.name)}">
                        </div>
                    `;
                } else if (ref.type === 'paste') {
                    const attPath = materializeAttachment(ref);
                    fullPromptForLLM += `Pasted text attached: ${attPath} (${ref.lineCount} lines). Use the read tool to fetch its content if needed.\n\n`;
                    chatAttachmentsHTML += `
                        <div class="prompt-chip attachment-paste" title="Click to preview" data-attachment-id="${ref.attachmentId}">
                            <span class="icon" style="font-size:12px; color:var(--yellow);">description</span>
                            <span>${escapeHTML(ref.name)} (${ref.lineCount} lines)</span>
                        </div>
                    `;
                } else {
                    fullPromptForLLM += `File reference: ${ref.filepath} (use the read tool to fetch its content if needed)\n\n`;
                    chatAttachmentsHTML += `
                        <div class="prompt-chip">
                            <span class="icon" style="font-size:12px; color:var(--primary);">description</span>
                            <span>@${escapeHTML(ref.filepath)}</span>
                        </div>
                    `;
                }
            }
            fullPromptForLLM += `User Prompt:\n${activeSkillPrefix}${promptTextForLLM || "(Referenced files/code above)"}`;
        } else {
            fullPromptForLLM = activeSkillPrefix + (promptTextForLLM || val);
        }

        const attachedImageUrls = currentModelHasVision()
            ? state.attachedReferences.filter(ref => ref.type === 'image').map(ref => ref.dataUrl)
            : [];

        const modeCfg = MODE_CONFIG[state.mode];
        const modeBadgeHTML = `
            <span class="mode-chat-chip ${state.mode}">
                <span class="icon" style="font-size:12px;">${modeCfg.icon}</span>
                <span>${state.mode}</span>
            </span>
        `;

        // One id identifies this user turn everywhere: the DOM node, the
        // `messages` array entry, and any file-change blame it produces.
        const msgId = genMessageId();
        const rawPrompt = escapeHTML(val || "(Referenced items)");
        const attachmentsSnapshot = escapeHTML(JSON.stringify(state.attachedReferences));
        print(`<div class="chat-attachments">${chatAttachmentsHTML}</div><div class="chat-prompt-wrap" data-msg-id="${msgId}" data-raw="${rawPrompt}" data-attachments="${attachmentsSnapshot}"><div class="mode-divider">${modeBadgeHTML}</div><div class="chat-prompt-row"><div class="chat-bubble"><div class="md-content" style="display:inline-block; vertical-align:top;">${normalizeBlockHTML(formatMarkdownSnippet(val || "(Referenced items)"))}</div></div></div><div class="prompt-actions"><button class="btn-prompt-action edit" title="Edit and regenerate" onclick="window.editPrompt('${msgId}')"><span class="icon" style="font-size:13px;">edit</span></button><button class="btn-prompt-action copy" title="Copy prompt" onclick="window.copyPrompt('${msgId}')"><span class="icon" style="font-size:13px;">content_copy</span></button><button class="btn-prompt-action del" title="Delete message" onclick="window.deletePrompt('${msgId}')"><span class="icon" style="font-size:13px;">delete</span></button></div></div>`);

        state.attachedReferences = [];
        renderAttachmentChips();

        if (!rootHandle && Object.keys(registry.meta).length === 0) {
            print("Tip: Open a workspace folder to enable file editing and context indexing.", "yellow");
        }

        removeContinueButtons();

        const runSessionId = state.activeSessionId;
        await runTask(fullPromptForLLM, msgId, attachedImageUrls, runSessionId);
        if (runSessionId === state.activeSessionId) focusPrompt();
}

// --- AST_EXPORTS_START ---
window.submitPrompt = submitPrompt;
// --- AST_EXPORTS_END ---

// --- saveCodeArtifact.js ---
async function saveCodeArtifact(btn) {
    const codeBox = btn.closest('.code-box');
    if (!codeBox) return;
    const codeEl = codeBox.querySelector('pre code');
    if (!codeEl) return;
    
    const langBadge = codeBox.querySelector('.tool-badge');
    let ext = 'txt';
    if (langBadge && langBadge.textContent && langBadge.textContent !== 'code') {
        ext = langBadge.textContent.trim().split(' ')[0];
    }
    
    const text = codeEl.textContent;
    const filename = await window.promptDialog("Enter filename to save snippet:", `snippet.${ext}`);
    if (!filename) return;
    
    const res = await window.fs.write(filename, text);
    if (res.error) {
        window.showToast(res.error, 'error');
    } else {
        window.showToast(`Saved ${filename}`, 'success');
    }
}

// --- AST_EXPORTS_START ---
window.saveCodeArtifact = saveCodeArtifact;
// --- AST_EXPORTS_END ---

// --- extractMessageArtifact.js ---
async function extractMessageArtifact(btn) {
    const wrap = btn.closest('[data-raw-msg]');
    if (!wrap) return;
    const rawMsg = wrap.getAttribute('data-raw-msg');
    
    const instructions = await window.promptDialog("How should this be saved? (e.g. 'Save as a markdown doc in docs folder')");
    if (!instructions) return;
    
    const prompt = `Extract the core artifact from the following text, discard conversational fluff, and use your write tool to fulfill this user request: ${instructions}\n\n<source_text>\n${rawMsg}\n</source_text>`;
    
    const input = document.getElementById('cmd');
    if (input) {
        input.value = prompt;
        window.submitPrompt();
    }
}

// --- AST_EXPORTS_START ---
window.extractMessageArtifact = extractMessageArtifact;
// --- AST_EXPORTS_END ---