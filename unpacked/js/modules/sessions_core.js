// --- accumulateSessionRunningTime.js ---
function accumulateSessionRunningTime(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (gen.genSessionStartMs == null) return;
    const elapsed = Date.now() - gen.genSessionStartMs;
    const s = state.sessions[sid];
    if (s) {
        s.runningTimeMs = (s.runningTimeMs || 0) + Math.max(0, elapsed);
    }
    gen.genSessionStartMs = null;
    if (sessionsPopoverOverlay && sessionsPopoverOverlay.style.display === 'block') {
        renderSessionPopoverList();
    }
}

// --- AST_EXPORTS_START ---
window.accumulateSessionRunningTime = accumulateSessionRunningTime;
// --- AST_EXPORTS_END ---

// --- clearAllSessions.js ---
async function clearAllSessions() {
    const ws = currentWsName();
    const wsKey = getWorkspaceSessionKey();
    const idxNow = await loadSessionIndexFromDB(wsKey);
    const sessionIds = Array.from(new Set([
        ...(idxNow && Array.isArray(idxNow.sessionIds) ? idxNow.sessionIds : []),
        ...Object.keys(state.sessions)
    ]));

    if (isAnySessionRunning()) {
        for (const s of Object.values(state.sessions)) {
            if (s._gen && s._gen.isRunning) {
                abortGeneration({ showResumeUI: false, sessionId: s.id });
            }
        }
    }

    sessionIds.forEach(id => deletedSessionIds.add(id));
    for (const id of sessionIds) {
        await deleteBaselineFromDB(ws, id);
        await deleteSessionRecordFromDB(wsKey, id);
    }

    try {
        const db = await getDB();
        await new Promise((res) => {
            const tx = db.transaction(STORE_SESSIONS, 'readwrite');
            tx.objectStore(STORE_SESSIONS).delete(sessionIndexKey(wsKey));
            tx.oncomplete = res;
            tx.onerror = res;
        });
    } catch(e) {}

    const newId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    state.sessions = {
        [newId]: {
            id: newId,
            title: 'Untitled Session',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            runningTimeMs: 0,
            messages: [],
            chatHTML: '',
            openTabs: ['chat'],
            activeTab: 'chat'
        }
    };
    state.sessionIds = [newId];
    state._lastSavedIndex = null;
    state.activeSessionId = newId;

    registry.originalFiles = {};
    registry.opsLog = {};
    registry.compressionHistory = [];
    state.modifiedFiles.clear();
    state.linesAdded = 0;
    state.linesRemoved = 0;
    state.messages = [];
    term.innerHTML = '';
    resetScrollState();
    clearSessionAttachments(newId, { purgeDB: true });

    await restoreActiveSessionContent();
    await persistCheckpoint();
    await saveActiveSession(true);

    renderChangesPanel();
    renderExplorerTree();
    updateStatusInfo();
    renderSessionPopoverList();
    hideSessionPopover();
    focusPrompt();
}

// --- AST_EXPORTS_START ---
window.clearAllSessions = clearAllSessions;
// --- AST_EXPORTS_END ---

// --- collectIdsFromMessage.js ---
function collectIdsFromMessage(sessionId, id) {
    const found = findMessageById(sessionId, id);
    const ids = new Set(found ? found.list.slice(found.index).map(m => m && m.id).filter(Boolean) : []);
    if (sessionId === state.activeSessionId) getPromptIdsFromDom(id).forEach(x => ids.add(x));
    return Array.from(ids);
}

// --- AST_EXPORTS_START ---
window.collectIdsFromMessage = collectIdsFromMessage;
// --- AST_EXPORTS_END ---

// --- createNewSession.js ---
async function createNewSession(title) {
    await saveActiveSession(true);
    snapshotSessionAttachments(state.activeSessionId);
    const id = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    const now = Date.now();
    state.sessions[id] = {
        id,
        title: title || 'Untitled Session',
        createdAt: now,
        updatedAt: now,
        runningTimeMs: 0,
        messages: [],
        chatHTML: '',
        openTabs: ['chat'],
        activeTab: 'chat',
        systemPrompt: null
    };

    if (!state.sessionIds) state.sessionIds = [];
    state.sessionIds.push(id);
    state.activeSessionId = id;
    await restoreActiveSessionContent();
    await saveActiveSession(true);
    renderSessionPopoverList();
    hideSessionPopover();
    focusPrompt();
}

// --- AST_EXPORTS_START ---
window.createNewSession = createNewSession;
// --- AST_EXPORTS_END ---

// --- deleteSession.js ---
async function deleteSession(sessionId, e) {
    if (e) e.stopPropagation();
    if (isSessionRunning(sessionId)) {
        abortGeneration({ showResumeUI: false, sessionId });
    }
    const keys = (state.sessionIds && state.sessionIds.length) ? state.sessionIds : Object.keys(state.sessions);
    if (keys.length <= 1) {
        state.messages = [];
        term.innerHTML = '';
        resetScrollState();
        state.linesAdded = 0;
        state.linesRemoved = 0;
        state.sessions[sessionId]._titleGenerated = false;
        state.sessions[sessionId].title = 'Untitled Session';
        state.sessions[sessionId].runningTimeMs = 0;

        registry.originalFiles = {};
        registry.opsLog = {};
        registry.compressionHistory = [];
        state.modifiedFiles.clear();
        clearSessionAttachments();
        await persistCheckpoint();

        renderChangesPanel();
        renderExplorerTree();
        updateStatusInfo();
        state.checkpointModalFile = null;
        state.checkpointModalMode = 'all';
        graphBreadcrumb.classList.remove('visible');
        graphPanelLabel.style.display = '';
        renderAllPromptGroups();
        await saveActiveSession(true);
        renderSessionPopoverList();
        hideSessionPopover();
        focusPrompt();
        updateWelcomeVisibility();
        return;
    }

    deletedSessionIds.add(sessionId);
    await deleteBaselineFromDB(currentWsName(), sessionId);
    await deleteSessionRecordFromDB(getWorkspaceSessionKey(), sessionId);
    if (state.activeSessionId === sessionId) {
        clearSessionAttachments(sessionId, { purgeDB: false });
    } else if (state.sessions[sessionId]) {
        delete state.sessions[sessionId]._attachments;
    }
    delete state.sessions[sessionId];
    if (state.sessionMeta) delete state.sessionMeta[sessionId];
    state.sessionIds = (state.sessionIds || []).filter(id => id !== sessionId);
    if (state.activeSessionId === sessionId) {
        // Pick the first remaining session that actually has a record; drop any
        // that don't instead of making a ghost the active session.
        let nextId = null;
        while (state.sessionIds.length) {
            const candidate = state.sessionIds[0];
            await ensureSessionLoaded(candidate);
            if (state.sessions[candidate]) { nextId = candidate; break; }
            state.sessionIds.shift();
            if (state.sessionMeta) delete state.sessionMeta[candidate];
        }
        if (!nextId) {
            nextId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
            const now = Date.now();
            state.sessions[nextId] = { id: nextId, title: 'Untitled Session', createdAt: now, updatedAt: now, runningTimeMs: 0, messages: [], chatHTML: '', openTabs: ['chat'], activeTab: 'chat', systemPrompt: null };
            state.sessionIds = [nextId];
        }
        state.activeSessionId = nextId;
        await restoreActiveSessionContent();
    }

    // force: otherwise saveSession bails when there is no new content and the
    // session index in the DB keeps the deleted id (it reappears on refresh).
    await saveActiveSession(true);
    renderSessionPopoverList();
}

// --- AST_EXPORTS_START ---
window.deleteSession = deleteSession;
// --- AST_EXPORTS_END ---

// --- findMessageById.js ---
// Finds a message by id within a session (defaults to the active session).
// Returns { index, message, list } or null if not found.
function findMessageById(sessionId, id) {
    if (!id) return null;
    const ctx = sessionCtx(sessionId || state.activeSessionId);
    const list = ctx.messages || [];
    const index = list.findIndex(m => m && m.id === id);
    if (index === -1) return null;
    return { index, message: list[index], list };
}

// --- AST_EXPORTS_START ---
window.findMessageById = findMessageById;
// --- AST_EXPORTS_END ---

// --- genMessageId.js ---
// ---- Unified message identity ----------------------------------------
// Every entry in a session's `messages` array carries a stable, unique `id`
// (assigned once, at creation, and persisted as part of the message object
// itself). All lookup / edit / delete / revert code should go through the
// helpers below instead of matching on prompt text or array position.
function genMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback UUIDv4 for environments without crypto.randomUUID.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// --- AST_EXPORTS_START ---
window.genMessageId = genMessageId;
// --- AST_EXPORTS_END ---

// --- getGenState.js ---
function getGenState(sessionId) {
    const s = state.sessions[sessionId];
    if (!s) return makeGenState();
    if (!s._gen) s._gen = makeGenState();
    return s._gen;
}

// --- AST_EXPORTS_START ---
window.getGenState = getGenState;
// --- AST_EXPORTS_END ---

// --- getPromptIdsFromDom.js ---
// Single shared entry point for "cut the conversation at message `id`":
// used by both edit and delete. Collects the ids of the target message and
// everything after it (for file-change blame/revert), trims the session's
// message list to just before the target, and cleans up the DOM/state that
// mirrors it. Returns { removedIds, cutIndex } or null if the id wasn't found.
//
// opts:
//   - removeDom (default true): remove the target's .log-entry and every
//     sibling after it from the terminal output.
//   - revert (default false): after trimming, call window.revertToBeforePrompt
//     for the collected ids so file changes made by those turns are undone.
//   - revertLabel: label passed through to the revert confirmation/toast.
// Ids of the user turns at/after `id`, read from the DOM. Used as a fallback
// when the message is no longer in the messages array (e.g. after context
// compression summarized it away) but is still visible in the chat.
function getPromptIdsFromDom(id) {
    const wraps = Array.from(document.querySelectorAll('.chat-prompt-wrap[data-msg-id]'));
    const start = wraps.findIndex(w => w.getAttribute('data-msg-id') === id);
    if (start === -1) return [];
    return wraps.slice(start).map(w => w.getAttribute('data-msg-id')).filter(Boolean);
}

// --- AST_EXPORTS_START ---
window.getPromptIdsFromDom = getPromptIdsFromDom;
// --- AST_EXPORTS_END ---

// --- getSessionRunningMs.js ---
function getSessionRunningMs(s) {
    if (!s) return 0;
    let ms = s.runningTimeMs || 0;
    const gen = s._gen || (s.id && state.sessions[s.id] && state.sessions[s.id]._gen);
    if (gen && gen.genSessionStartMs != null) {
        ms += Math.max(0, Date.now() - gen.genSessionStartMs);
    }
    return ms;
}

// --- AST_EXPORTS_START ---
window.getSessionRunningMs = getSessionRunningMs;
// --- AST_EXPORTS_END ---

// --- isAnySessionRunning.js ---
function isAnySessionRunning() {
    return Object.values(state.sessions).some(s => s._gen && s._gen.isRunning);
}

// --- AST_EXPORTS_START ---
window.isAnySessionRunning = isAnySessionRunning;
// --- AST_EXPORTS_END ---

// --- isSessionRunning.js ---
function isSessionRunning(sessionId) {
    const s = state.sessions[sessionId];
    if (!s || !s._gen) return false;
    return !!(s._gen.isRunning || s._gen.compressionInFlight);
}

// --- AST_EXPORTS_START ---
window.isSessionRunning = isSessionRunning;
// --- AST_EXPORTS_END ---

// --- makeGenState.js ---
function makeGenState() {
    return {
        activeController: null,
        isRunning: false,
        isThinkingNow: false,
        skipThinkingRequested: false,
        thinkingTimerInterval: null,
        pendingToolDiv: null,
        currentAssistantDiv: null,
        genStartTime: null,
        genFirstTokenTime: null,
        genEndTime: null,
        genTokenCount: 0,
        actualGenTokenCount: null,
        genFinishReason: null,
        genTks: null,
        genServerTks: null,
        retryAttempt: 0,
        retryTimeout: null,
        retryCancelled: false,
        retryStatusActive: false,
        currentPromptContext: null,
        genSessionStartMs: null,
        hasNewContent: false,
        spinEl: null,
        spinInterval: null,
        postCompressTokenOverride: null
    };
}

// --- AST_EXPORTS_START ---
window.makeGenState = makeGenState;
// --- AST_EXPORTS_END ---

// --- messageHasFileEdits.js ---
// True only if the given messages left a real net change on disk. A logged op alone isn't enough:
// no-op writes/edits (identical content) and write-then-restore sequences are logged but change nothing.
function messageHasFileEdits(ids) {
    const idSet = new Set(ids);
    if (!idSet.size) return false;
    const contentKinds = new Set(['create', 'write', 'edit']);
    for (const fp of getAllTrackedFiles()) {
        const ops = (registry.opsLog && registry.opsLog[fp]) || [];
        const first = ops.findIndex((o) => o && o.prompt && idSet.has(o.prompt.id));
        if (first === -1) continue;

        // Renames and directory creation are always real changes.
        if (ops.some((o) => o && o.prompt && idSet.has(o.prompt.id) &&
            (o.kind === 'rename-in' || o.kind === 'rename-out' || o.kind === 'mkdir'))) return true;

        // State of the file just before the first affected op (null = did not exist).
        let before;
        for (let i = first - 1; i >= 0 && before === undefined; i--) {
            const o = ops[i];
            if (!o) continue;
            if (o.kind === 'delete') before = null;
            else if (contentKinds.has(o.kind)) before = o.content;
        }
        if (before === undefined) {
            const orig = registry.originalFiles[fp];
            if (orig !== undefined) before = orig;
            else {
                const fo = ops[first];
                before = fo.previousContent !== undefined ? fo.previousContent : null;
            }
        }

        // State after the last op (messages after the cut are removed too, so this is the end state).
        let after;
        for (let i = ops.length - 1; i >= 0 && after === undefined; i--) {
            const o = ops[i];
            if (!o) continue;
            if (o.kind === 'delete') after = null;
            else if (contentKinds.has(o.kind)) after = o.content;
        }
        if (after === undefined) after = before;

        if (before !== after) return true;
    }
    return false;
}

// --- AST_EXPORTS_START ---
window.messageHasFileEdits = messageHasFileEdits;
// --- AST_EXPORTS_END ---

// --- selectInitialSession.js ---
async function selectInitialSession() {
    const wsKey = getWorkspaceSessionKey();
    const index = await loadSessionIndexFromDB(wsKey);
    const rawIds = (index && Array.isArray(index.sessionIds)) ? index.sessionIds : [];
    // Drop junk ids (undefined/null/non-strings, duplicates) and ids whose record
    // no longer exists in the DB (left behind by an earlier delete).
    const sessionIds = [];
    for (const id of rawIds) {
        if (typeof id !== 'string' || !id || sessionIds.includes(id)) continue;
        if (!(await sessionRecordExistsInDB(wsKey, id))) continue;
        sessionIds.push(id);
    }
    const prunedIndex = sessionIds.length !== rawIds.length;

    if (sessionIds.length > 0) {
        const activeId = (index.activeSessionId && sessionIds.includes(index.activeSessionId))
            ? index.activeSessionId
            : sessionIds[0];
        let activeRecord = await loadSessionRecordFromDB(wsKey, activeId);
        if (!activeRecord) {
            activeRecord = { id: activeId, title: 'Untitled Session', createdAt: Date.now(), updatedAt: Date.now(), runningTimeMs: 0, messages: [], chatHTML: '' };
        }
        state.sessions = { [activeId]: activeRecord };
        state.sessionIds = sessionIds;
        state.sessionMeta = (index && index.meta) ? { ...index.meta } : {};
        state.sessionMeta[activeId] = {
            id: activeRecord.id,
            title: activeRecord.title,
            createdAt: activeRecord.createdAt,
            updatedAt: activeRecord.updatedAt,
            runningTimeMs: activeRecord.runningTimeMs || 0,
            msgCount: countConversationMessages(activeRecord.messages)
        };
        state.activeSessionId = activeId;
        for (const k of Object.keys(state.sessionMeta)) {
            if (!sessionIds.includes(k)) delete state.sessionMeta[k];
        }
        state._lastSavedIndex = { sessionIds: sessionIds.slice(), activeSessionId: activeId, meta: { ...state.sessionMeta } };
        if (prunedIndex) await saveSessionIndexToDB(wsKey, state._lastSavedIndex);
    } else {
        const defaultId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        state.sessions = {
            [defaultId]: {
                id: defaultId,
                title: 'Untitled Session',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                runningTimeMs: 0,
                messages: [],
                chatHTML: ''
            }
        };
        state.sessionIds = [defaultId];
        state.sessionMeta = {
            [defaultId]: {
                id: defaultId,
                title: 'Untitled Session',
                createdAt: state.sessions[defaultId].createdAt,
                updatedAt: state.sessions[defaultId].updatedAt,
                runningTimeMs: 0,
                msgCount: 0
            }
        };
        state.activeSessionId = defaultId;
        const idx = { sessionIds: [defaultId], activeSessionId: defaultId, meta: { ...state.sessionMeta } };
        await saveSessionIndexToDB(wsKey, idx);
        state._lastSavedIndex = idx;
    }
}

// --- AST_EXPORTS_START ---
window.selectInitialSession = selectInitialSession;
// --- AST_EXPORTS_END ---

// --- sessionCtx.js ---
function sessionCtx(sessionId) {
    const isLive = sessionId === state.activeSessionId;
    if (isLive) {
        return {
            sessionId,
            isLive: true,
            messages: state.messages,
            modifiedFiles: state.modifiedFiles,
            baseline: registry,
        };
    }
    const s = ensureSessionBaseline(sessionId);
    if (!s) {
        return {
            sessionId,
            isLive: false,
            deleted: true,
            messages: [],
            modifiedFiles: new Set(),
            baseline: { originalFiles: {}, opsLog: {}, compressionHistory: [] },
        };
    }
    return {
        sessionId,
        isLive: false,
        messages: s.messages,
        modifiedFiles: s._modifiedFiles,
        baseline: s._baseline,
    };
}

// --- AST_EXPORTS_START ---
window.sessionCtx = sessionCtx;
// --- AST_EXPORTS_END ---

// --- switchSession.js ---
async function switchSession(sessionId) {
    if (!(state.sessionIds || []).includes(sessionId) || sessionId === state.activeSessionId) {
        hideSessionPopover();
        return;
    }
    const outgoingId = state.activeSessionId;
    await saveActiveSession(true);
    snapshotSessionAttachments(outgoingId);

    state.activeSessionId = sessionId;
    await ensureSessionLoaded(sessionId);
    if (!state.sessions[sessionId]) {
        // Ghost entry (no record behind it): roll back, prune it, and tell the user.
        state.activeSessionId = outgoingId;
        state.sessionIds = (state.sessionIds || []).filter(id => id !== sessionId);
        if (state.sessionMeta) delete state.sessionMeta[sessionId];
        await saveActiveSession(true);
        renderSessionPopoverList();
        return;
    }
    await restoreActiveSessionContent();
    renderSessionPopoverList();
    hideSessionPopover();
    reconcileLiveGenUI(outgoingId, sessionId);
    remountPendingUIForSession(sessionId);
    refreshPermBanner();
    focusPrompt();
}

// --- AST_EXPORTS_START ---
window.switchSession = switchSession;
// --- AST_EXPORTS_END ---

// --- truncateFromMessage.js ---
function truncateFromMessage(sessionId, id, opts = {}) {
    const sid = sessionId || state.activeSessionId;
    const found = findMessageById(sid, id);
    if (!found) {
        // Message was compressed out of the array: still cut the DOM and report DOM ids so revert works.
        const domIds = sid === state.activeSessionId ? getPromptIdsFromDom(id) : [];
        if (!domIds.length) return null;
        if (opts.removeDom !== false) {
            const wrap = document.querySelector(`[data-msg-id="${id}"]`);
            if (wrap) {
                let node = wrap.closest('.log-entry') || wrap;
                while (node) { const r = node; node = node.nextElementSibling; r.remove(); }
            }
        }
        saveSession(sid, true);
        return { removedIds: domIds, cutIndex: -1 };
    }
    const { index, list } = found;

    // Every message from this one onward is being dropped; collect their ids
    // so file-timeline blame entries (which are stamped with the same id,
    // see runTask/currentPromptContext below) can be reverted together.
    const removedIds = list.slice(index).map(m => m && m.id).filter(Boolean);

    list.length = index; // trim in place so any other refs to this array see the cut
    const s = state.sessions[sid];
    if (s) s.messages = list;
    if (sid === state.activeSessionId) state.messages = list;

    const gen = getGenState(sid);
    gen.hasNewContent = true;
    gen.postCompressTokenOverride = null;

    if (opts.removeDom !== false && sid === state.activeSessionId) {
        const wrap = document.querySelector(`[data-msg-id="${id}"]`);
        if (wrap) {
            let node = wrap.closest('.log-entry') || wrap;
            while (node) {
                const toRemove = node;
                node = node.nextElementSibling;
                toRemove.remove();
            }
        }
        // Resolve any pending choice card that lived in the removed DOM.
        pendingUIQueue.filter(r => r.sessionId === sid && r.el && !r.el.isConnected)
            .forEach(r => { try { r.finish(null, true); } catch (_) {} });
        document.querySelectorAll('.tool-ui-wait').forEach(n => {
            if (!pendingUIQueue.some(r => r.el === n)) n.remove();
        });
    }

    saveSession(sid);

    return { removedIds, cutIndex: index };
}

// --- AST_EXPORTS_START ---
window.truncateFromMessage = truncateFromMessage;
// --- AST_EXPORTS_END ---
