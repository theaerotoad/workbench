// --- countConversationMessages.js ---
function countConversationMessages(msgs) {
    if (!Array.isArray(msgs)) return 0;
    let count = 0;
    for (const m of msgs) {
        if (!m) continue;
        if (m.role === 'user' || m.role === 'assistant') count++;
    }
    return count;
}

// --- AST_EXPORTS_START ---
window.countConversationMessages = countConversationMessages;
// --- AST_EXPORTS_END ---

// --- ensureSessionLoaded.js ---
async function ensureSessionLoaded(sessionId) {
    if (state.sessions[sessionId] && state.sessions[sessionId]._loaded !== false) return state.sessions[sessionId];
    const wsKey = getWorkspaceSessionKey();
    const record = await loadSessionRecordFromDB(wsKey, sessionId);
    if (record) {
        state.sessions[sessionId] = record;
    }
    return state.sessions[sessionId];
}

// --- AST_EXPORTS_START ---
window.ensureSessionLoaded = ensureSessionLoaded;
// --- AST_EXPORTS_END ---

// --- generateSessionTitleViaLLM.js ---
async function generateSessionTitleViaLLM(prompt) {
    if (!prompt || typeof prompt !== 'string') return 'Untitled Session';

    // Extract actual user query if prompt contains prepended context references
    let cleanPrompt = prompt;
    const userPromptMatch = cleanPrompt.match(/(?:^|\n)User Prompt:\s*([\s\S]*)$/i);
    if (userPromptMatch && userPromptMatch[1].trim()) {
        const extracted = userPromptMatch[1].trim();
        if (extracted !== '(Referenced files/code above)' && extracted !== '(Referenced items)') {
            cleanPrompt = extracted;
        }
    }

    cleanPrompt = cleanPrompt
        .replace(/^Context References:\s*(?:\[[^\]]+\]\s*)*/i, '')
        .replace(/^\[(?:Image attached|File|Attachment)[^\]]*\]\s*/gi, '')
        .replace(/\/(plan|ask|code|execute-plan|continue|new|session|clear|restore|help)\b/gi, '')
        .trim();

    if (!cleanPrompt || cleanPrompt === '(Referenced files/code above)' || cleanPrompt === '(Referenced items)') {
        const imgMatch = prompt.match(/\[Image attached:\s*([^\s\]]+)/i);
        const fileMatch = prompt.match(/(?:File|Pasted text attached):\s*([^\s\n\(\)]+)/i);
        if (imgMatch) {
            const fname = imgMatch[1].split('/').pop().split('\\').pop().replace(/\.\.\.$/, '');
            cleanPrompt = `Image: ${fname}`;
        } else if (fileMatch) {
            const fname = fileMatch[1].split('/').pop().split('\\').pop().replace(/\.\.\.$/, '');
            cleanPrompt = `File: ${fname}`;
        } else {
            cleanPrompt = 'Untitled Session';
        }
    }

    const effectivePrompt = cleanPrompt || 'Untitled Session';
    if (effectivePrompt === 'Untitled Session') return effectivePrompt;

    const { url: apiUrl, model, key: apiKey, useProxy } = getCurrentModelInfo();
    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const titleTemplate = (MODE_PROMPTS && MODE_PROMPTS.title) || seedDefaultModePrompts().title;
    const injectPrompt = /\{\{\s*userPrompt\s*\}\}/.test(titleTemplate);
    const systemContent = injectPrompt ? renderPromptTemplate(titleTemplate, { userPrompt: effectivePrompt }) : titleTemplate;
    const userContent = injectPrompt ? effectivePrompt : `Generate a short descriptive title for this coding task:\n${effectivePrompt}`;
    try {
        const targetUrl = `${apiUrl}/chat/completions`;
        const reqUrl = useProxy ? '/proxy' : targetUrl;
        if (useProxy) headers["x-proxy-target"] = targetUrl;
        
        const resp = await fetch(reqUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemContent },
                    { role: "user", content: userContent }
                ],
                temperature: 0.3,
                max_tokens: 128
            })
        });
        if (!resp.ok) {
            const errJson = await resp.json().catch(() => ({}));
            throw new Error(errJson.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const generated = (data.choices?.[0]?.message?.content || '').trim();
        if (generated) {
            return generated;
        }
    } catch (e) { }
    return effectivePrompt.length > 120 ? effectivePrompt.slice(0, 117) + '...' : effectivePrompt;
}

// --- AST_EXPORTS_START ---
window.generateSessionTitleViaLLM = generateSessionTitleViaLLM;
// --- AST_EXPORTS_END ---

// --- hideSessionPopover.js ---
function hideSessionPopover() {
    _sessRenameId = null;
    sessionsPopoverOverlay.style.display = 'none';
    btnSessionToggle.classList.remove('active');
    if (sessionRunTickInterval) {
        clearInterval(sessionRunTickInterval);
        sessionRunTickInterval = null;
    }
    if (sessionsPopover && sessionsPopover.contains(document.activeElement)) {
        document.activeElement.blur();
        if (typeof focusPrompt === 'function') focusPrompt();
    }
}

// --- AST_EXPORTS_START ---
window.hideSessionPopover = hideSessionPopover;
// --- AST_EXPORTS_END ---

// --- loadAllSessions.js ---
async function loadAllSessions() {
    await selectInitialSession();
    await restoreActiveSessionContent();
    renderSessionPopoverList();
}

// --- AST_EXPORTS_START ---
window.loadAllSessions = loadAllSessions;
// --- AST_EXPORTS_END ---

// --- maybeUpdateSessionTitleFromPrompt.js ---
async function maybeUpdateSessionTitleFromPrompt(prompt, sessionId) {
    const sid = sessionId || state.activeSessionId;
    const s = state.sessions[sid];
    if (!s) return;
    const isStuckWithFallback = s.title && (s.title.startsWith('Context References:') || s.title === 'Generating title...' || s.title === 'Untitled Session');
    if (s._titleGenerated && !isStuckWithFallback) return;
    s.title = "Generating title...";
    if (sid === state.activeSessionId) updateSessionPillLabel();
    const title = await generateSessionTitleViaLLM(prompt);
    if (!state.sessions[sid]) return;
    if (state.sessions[sid].title !== 'Generating title...') return; // user renamed while generating
    if (title && title !== 'Untitled Session') {
        state.sessions[sid]._titleGenerated = true;
        state.sessions[sid].title = title;
        if (sid === state.activeSessionId) updateSessionPillLabel();
        const wsKey = getWorkspaceSessionKey();
        await patchSessionRecordInDB(wsKey, sid, {
            title,
            _titleGenerated: true,
            updatedAt: Date.now()
        });
        if (!state.sessionMeta) state.sessionMeta = {};
        if (state.sessionMeta[sid]) state.sessionMeta[sid].title = title;
        await saveSession(sid);
    }
}

// --- AST_EXPORTS_START ---
window.maybeUpdateSessionTitleFromPrompt = maybeUpdateSessionTitleFromPrompt;
// --- AST_EXPORTS_END ---

// --- reconcileLiveGenUI.js ---
function reconcileLiveGenUI(outgoingId, incomingId) {
    const outgoingGen = outgoingId ? getGenState(outgoingId) : null;
    if (outgoingGen && outgoingGen.isRunning) {
        if (outgoingGen.spinEl && outgoingGen.spinEl.parentNode) {
            outgoingGen.spinEl.parentNode.removeChild(outgoingGen.spinEl);
        }
        if (outgoingGen.spinInterval) {
            clearInterval(outgoingGen.spinInterval);
            outgoingGen.spinInterval = null;
        }
        outgoingGen.spinEl = null;
        if (outgoingGen.retryStatusEl) {
            outgoingGen.retryStatusEl.remove();
            outgoingGen.retryStatusEl = null;
        }
        if (outgoingGen.pendingToolDiv) {
            outgoingGen.pendingToolDiv.remove();
            outgoingGen.pendingToolDiv = null;
        }
    }

    const incomingGen = getGenState(incomingId);
    if (incomingGen.isRunning) {
        startSpinner(incomingGen._lastSpinnerText || 'Generating response...', incomingId, true);
    }
    updateGenGlow();
    updatePromptSendButton();
}

// --- AST_EXPORTS_START ---
window.reconcileLiveGenUI = reconcileLiveGenUI;
// --- AST_EXPORTS_END ---

// --- sessionPopoverState.js ---
let _sessPopoverEntries = [];       // ids currently listed (filtered + sorted)
let _sessPopoverSelectedId = null;  // keyboard / hover highlight
let _sessRenameId = null;           // id of the row being renamed inline, if any
let _sessPopoverBound = false;

function formatSessionStamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dayDiff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
    if (dayDiff === 0) return `Today ${time}`;
    if (dayDiff === 1) return `Yesterday ${time}`;
    if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
    const opts = d.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' };
    return `${d.toLocaleDateString([], opts)}, ${time}`;
}

// --- AST_EXPORTS_START ---
window.formatSessionStamp = formatSessionStamp;
// --- AST_EXPORTS_END ---

// --- renderSessionPopoverList.js ---
function renderSessionPopoverList(opts = {}) {
    const ids = ((state.sessionIds && state.sessionIds.length) ? state.sessionIds : Object.keys(state.sessions))
        .filter(id => typeof id === 'string' && id);
    const metaFor = (id) => {
        if (state.sessions[id]) {
            const s = state.sessions[id];
            return {
                id: s.id,
                title: s.title,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                runningTimeMs: s.runningTimeMs || 0,
                msgCount: countConversationMessages(s.messages)
            };
        }
        return (state.sessionMeta && state.sessionMeta[id]) || { id, title: 'Untitled Session', createdAt: 0, runningTimeMs: 0, msgCount: 0 };
    };
    const metas = new Map(ids.map(id => [id, metaFor(id)]));
    const recency = (m) => m.updatedAt || m.createdAt || 0;

    const sorted = ids.slice().sort((a, b) => {
        if (a === state.activeSessionId) return -1;
        if (b === state.activeSessionId) return 1;
        const d = recency(metas.get(b)) - recency(metas.get(a));
        if (d) return d;
        return (metas.get(b).createdAt || 0) - (metas.get(a).createdAt || 0);
    });

    // Filter by the search box, if any. Always keep the row currently being
    // renamed so the inline input doesn't disappear mid-edit.
    const searchEl = document.getElementById('session-switcher-search');
    const query = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();
    let keys = sorted;
    if (query) {
        keys = sorted.filter(k => {
            const m = metas.get(k);
            const hay = `${sanitizeSessionTitle(m.title || '')} ${m.id} ${formatSessionStamp(recency(m))}`.toLowerCase();
            return hay.includes(query);
        });
        if (_sessRenameId && sorted.includes(_sessRenameId) && !keys.includes(_sessRenameId)) keys.push(_sessRenameId);
    }
    _sessPopoverEntries = keys;
    if (!keys.includes(_sessPopoverSelectedId)) _sessPopoverSelectedId = keys[0] || null;

    // Reconcile rows in place instead of wiping and rebuilding:
    // reusing existing <div>s avoids re-creating DOM nodes on every tick,
    // which is what made the popover flash on each update.
    const existingRows = new Map();
    for (const el of Array.from(sessionsList.children)) {
        const id = el.dataset.sessionId;
        if (id) existingRows.set(id, el);
    }

    const seen = new Set();
    keys.forEach(k => {
        seen.add(k);
        const s = metas.get(k);
        const isActive = k === state.activeSessionId;
        const msgCount = s.msgCount || 0;
        const stamp = formatSessionStamp(recency(s));
        const displayTitle = s.title ? sanitizeSessionTitle(s.title) : s.id;
        const runMs = getSessionRunningMs(s);
        const isGeneratingNow = isSessionRunning(s.id);
        const runStr = `${isGeneratingNow ? '▸ ' : ''}${formatDuration(runMs)}`;

        let row = existingRows.get(k);
        if (!row) {
            row = document.createElement('div');
            row.dataset.sessionId = k;
            row.className = 'session-item-row';
            const info = document.createElement('div');
            info.className = 'session-item-info';
            const actions = document.createElement('div');
            actions.className = 'session-item-actions';
            const renBtn = document.createElement('button');
            renBtn.className = 'btn-rename-session icon-btn';
            renBtn.title = 'Rename session';
            renBtn.innerHTML = '<span class="icon" style="font-size:14px;">edit</span>';
            renBtn.addEventListener('click', (e) => { e.stopPropagation(); beginSessionRename(k, row); });
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-del-session icon-btn';
            delBtn.innerHTML = '<span class="icon" style="font-size:14px;">delete</span>';
            delBtn.addEventListener('click', (e) => deleteSession(k, e));
            actions.appendChild(renBtn);
            actions.appendChild(delBtn);
            row.appendChild(info);
            row.appendChild(actions);
            row.addEventListener('click', () => switchSession(k));
            row.addEventListener('mousemove', () => {
                if (_sessPopoverSelectedId !== k) {
                    _sessPopoverSelectedId = k;
                    for (const el of sessionsList.children) {
                        if (el.classList && el.classList.contains('session-item-row')) {
                            el.classList.toggle('highlighted', el.dataset.sessionId === k);
                        }
                    }
                }
            });
            existingRows.set(k, row);
        }

        // Only toggle the active class when it actually changes, so the
        // CSS transition fires at most once per state change.
        const wantClass = `session-item-row ${isActive ? 'active' : ''} ${isGeneratingNow ? 'running' : ''}`.replace(/\s+/g, ' ').trim();
        const curClass = row.className.replace(/\bhighlighted\b/g, '').replace(/\s+/g, ' ').trim();
        if (curClass !== wantClass) row.className = wantClass;
        row.classList.toggle('highlighted', k === _sessPopoverSelectedId);

        // Update the title, run meta and id rows independently and only when their HTML changes.
        // The title node must persist across the 1s run-time tick, otherwise its shimmer animation restarts every second.
        const info = row.querySelector('.session-item-info');
        if (!info.children.length) {
            for (let i = 0; i < 3; i++) {
                const d = document.createElement('div');
                d.className = i === 0 ? 'session-item-title' : 'session-item-meta-row';
                info.appendChild(d);
            }
        }
        const parts = [
            `${escapeHTML(displayTitle)}${isActive ? '<span class="green" style="font-size:11px; margin-left:4px;">●</span>' : ''}`,
            `<span class="meta-field">${msgCount} msgs</span><span class="meta-field">· run ${runStr}</span>`,
            `<span class="meta-field meta-date">${escapeHTML(stamp)}</span><span class="meta-id">· ${escapeHTML(s.id)}</span>`
        ];
        parts.forEach((html, i) => {
            if (i === 0 && k === _sessRenameId) return; // keep the inline rename input intact
            const el = info.children[i];
            if (el._html !== html) { el.innerHTML = html; el._html = html; }
        });
        const rowTitle = `Created ${new Date(s.createdAt || Date.now()).toLocaleString()} · Last active ${new Date(recency(s) || Date.now()).toLocaleString()}`;
        if (row.title !== rowTitle) row.title = rowTitle;
        const delBtn = row.querySelector('.btn-del-session');
        if (delBtn) delBtn.title = ids.length > 1 ? 'Delete session' : 'Clear session';
    });

    // Drop rows for sessions that no longer exist (includes filtered-out rows).
    for (const [id, el] of Array.from(existingRows)) {
        if (!seen.has(id)) {
            el.remove();
            existingRows.delete(id);
        }
    }

    // Empty state
    const emptyEl = sessionsList.querySelector('.session-list-empty');
    if (keys.length === 0) {
        if (!emptyEl) {
            const d = document.createElement('div');
            d.className = 'session-list-empty';
            d.textContent = query ? 'No sessions match your filter' : 'No sessions';
            sessionsList.appendChild(d);
        } else {
            const text = query ? 'No sessions match your filter' : 'No sessions';
            if (emptyEl.textContent !== text) emptyEl.textContent = text;
        }
    } else if (emptyEl) {
        emptyEl.remove();
    }

    // Order rows to match keys (only move the ones out of place)
    keys.forEach((k, i) => {
        const row = existingRows.get(k);
        if (row && sessionsList.children[i] !== row) sessionsList.insertBefore(row, sessionsList.children[i] || null);
    });

    if (opts.scrollToSelected) {
        const sel = _sessPopoverSelectedId ? existingRows.get(_sessPopoverSelectedId) : null;
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
}

// --- AST_EXPORTS_START ---
window.renderSessionPopoverList = renderSessionPopoverList;
// --- AST_EXPORTS_END ---

// --- renameSession.js ---
async function renameSession(sessionId, rawTitle) {
    if (window.isWorkspaceReadOnly?.()) { showToast('Workspace is read-only', 'error'); return false; }
    const title = sanitizeSessionTitle(rawTitle);
    if (!title || !sessionId) return false;
    const now = Date.now();
    const s = state.sessions[sessionId];
    if (s) { s.title = title; s._titleGenerated = true; s.updatedAt = now; }
    if (!state.sessionMeta) state.sessionMeta = {};
    const prev = state.sessionMeta[sessionId] || { id: sessionId, createdAt: (s && s.createdAt) || now, runningTimeMs: 0, msgCount: 0 };
    state.sessionMeta[sessionId] = { ...prev, title, updatedAt: now };
    const wsKey = getWorkspaceSessionKey();
    await patchSessionRecordInDB(wsKey, sessionId, { title, _titleGenerated: true, updatedAt: now });
    const nextIndex = { sessionIds: (state.sessionIds || []).slice(), activeSessionId: state.activeSessionId, meta: { ...state.sessionMeta } };
    await saveSessionIndexToDB(wsKey, nextIndex);
    state._lastSavedIndex = nextIndex;
    state._lastSavedWsKey = wsKey;
    if (sessionId === state.activeSessionId) updateSessionPillLabel();
    return true;
}

// --- AST_EXPORTS_START ---
window.renameSession = renameSession;
// --- AST_EXPORTS_END ---

// --- beginSessionRename.js ---
function beginSessionRename(sessionId, row) {
    if (window.isWorkspaceReadOnly?.()) return;
    const titleEl = row && row.querySelector('.session-item-title');
    if (!titleEl) return;
    if (titleEl.querySelector('.session-title-input')) {
        titleEl.querySelector('.session-title-input').focus();
        return;
    }
    const orig = sanitizeSessionTitle((state.sessions[sessionId] && state.sessions[sessionId].title) || (state.sessionMeta && state.sessionMeta[sessionId] && state.sessionMeta[sessionId].title) || '') || '';
    _sessRenameId = sessionId;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-title-input';
    input.value = orig;
    input.maxLength = 140;
    input.spellcheck = false;
    input.autocomplete = 'off';

    let done = false;
    const finish = async (save) => {
        if (done) return;
        done = true;
        const val = input.value;
        _sessRenameId = null;
        titleEl._html = null;
        if (save && sanitizeSessionTitle(val) && sanitizeSessionTitle(val) !== orig) {
            await renameSession(sessionId, val);
        }
        renderSessionPopoverList();
        if (sessionsPopoverOverlay && sessionsPopoverOverlay.style.display === 'block') {
            const se = document.getElementById('session-switcher-search');
            if (se) se.focus();
        }
    };

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(false));

    titleEl.innerHTML = '';
    titleEl._html = null;
    titleEl.appendChild(input);
    input.focus();
    input.select();
}

// --- AST_EXPORTS_START ---
window.beginSessionRename = beginSessionRename;
// --- AST_EXPORTS_END ---

// --- sessionPopoverKeyboard.js ---
function moveSessionSelection(delta) {
    const n = _sessPopoverEntries.length;
    if (!n) return;
    let i = _sessPopoverEntries.indexOf(_sessPopoverSelectedId);
    i = i < 0 ? 0 : (i + delta + n) % n;
    _sessPopoverSelectedId = _sessPopoverEntries[i];
    renderSessionPopoverList({ scrollToSelected: true });
}

function _ensureSessionPopoverBound() {
    if (_sessPopoverBound) return;
    _sessPopoverBound = true;
    const searchEl = document.getElementById('session-switcher-search');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            _sessPopoverSelectedId = null;
            renderSessionPopoverList({ scrollToSelected: true });
        });
    }
    sessionsPopover.addEventListener('keydown', (e) => {
        if (e.target && e.target.tagName === 'INPUT' && e.target !== searchEl) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSessionSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSessionSelection(-1); return; }
        if (e.key === 'Enter') {
            if (e.target && e.target.closest && e.target.closest('button')) return;
            e.preventDefault();
            if (_sessPopoverSelectedId) switchSession(_sessPopoverSelectedId);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideSessionPopover();
        }
    });
}

// --- AST_EXPORTS_START ---
window.moveSessionSelection = moveSessionSelection;
// --- AST_EXPORTS_END ---

// --- restoreActiveSessionContent.js ---
async function restoreActiveSessionContent() {
    const current = state.sessions[state.activeSessionId];
    if (!current) {
        state.messages = [];
        state.linesAdded = 0;
        state.linesRemoved = 0;
        state.lastTokenUsage = null;
        updateTokenStatus(null);
        term.innerHTML = '';
        updateSessionPillLabel();
        renderChangesPanel();
        renderExplorerTree();
        updateStatusInfo();
        updateWelcomeVisibility();
        return;
    }

    state.messages = current.messages || [];
    state.linesAdded = current.linesAdded || 0;
    state.linesRemoved = current.linesRemoved || 0;
    state.lastTokenUsage = current.lastTokenUsage || null;
    updateTokenStatus(state.lastTokenUsage);

    const gen = getGenState(state.activeSessionId);
    gen.hasNewContent = false;
    if (typeof current.postCompressTokenOverride === 'number') {
        gen.postCompressTokenOverride = current.postCompressTokenOverride;
    }

    await loadCheckpointForSession(state.activeSessionId);
    restoreSessionAttachments(state.activeSessionId);

    if (current.chatHTML) {
        term.innerHTML = current.chatHTML;
        stripTransientLiveUI(term);
        removeAllSkipThinkingButtons();
        rehydrateToolErrorTooltips();
        if (typeof rehydrateMarkdownImages === 'function') {
            rehydrateMarkdownImages(term);
        }
    } else {
        term.innerHTML = '';
    }
    forceScrollToBottomOnLoad();
    updateSessionPillLabel();
    renderChangesPanel();
    renderExplorerTree();
    updateStatusInfo();
    updateWelcomeVisibility();
    if (typeof scheduleChatImageResolution === 'function') {
        scheduleChatImageResolution();
        setTimeout(() => {
            if (typeof rehydrateMarkdownImages === 'function') {
                rehydrateMarkdownImages(term);
            }
        }, 350);
    }

    // New session = new op log, so any file drilled into in the Graph belongs
    // to the previous session. Reset to the repo-wide view and refresh it,
    // otherwise the Graph keeps showing the old session's (stale) history.
    state.checkpointModalFile = null;
    state.checkpointModalMode = 'all';
    graphBreadcrumb.classList.remove('visible');
    graphBreadcrumbFile.innerText = '';
    graphPanelLabel.style.display = '';
    renderAllPromptGroups();

    const savedTabs = Array.isArray(current.openTabs) && current.openTabs.length ? current.openTabs : ['chat'];
    const migratedViewModes = {
        ...(current.tabViewModes && typeof current.tabViewModes === 'object' ? current.tabViewModes : {})
    };
    const normalizedTabs = [];
    for (const rawTab of savedTabs) {
        if (typeof rawTab !== 'string' || !rawTab) continue;
        if (rawTab.startsWith('render:')) {
            const fp = rawTab.slice('render:'.length);
            if (fp) {
                migratedViewModes[fp] = 'render';
                if (!normalizedTabs.includes(fp)) normalizedTabs.push(fp);
            }
        } else if (!normalizedTabs.includes(rawTab)) {
            normalizedTabs.push(rawTab);
        }
    }
    if (!normalizedTabs.length) normalizedTabs.push('chat');
    state.openTabs = normalizedTabs;
    state.tabViewModes = migratedViewModes;
    try {
        await switchTab('chat');
    } catch(e) {
        state.openTabs = ['chat'];
        state.tabViewModes = {};
        await switchTab('chat');
    }
}

// --- AST_EXPORTS_START ---
window.restoreActiveSessionContent = restoreActiveSessionContent;
// --- AST_EXPORTS_END ---

// --- sanitizeSessionTitle.js ---
function sanitizeSessionTitle(title) {
    if (!title || typeof title !== 'string') return '';
    return title
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/\\([`*_{}[\]()#+.!<>"/])/g, '$1')
        .replace(/^[`"'*]+|[`"'*]+$/g, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 140);
}

// --- AST_EXPORTS_START ---
window.sanitizeSessionTitle = sanitizeSessionTitle;
// --- AST_EXPORTS_END ---

// --- saveActiveSession.js ---
async function saveActiveSession(force) {
    return saveSession(state.activeSessionId, force);
}

// --- AST_EXPORTS_START ---
window.saveActiveSession = saveActiveSession;
// --- AST_EXPORTS_END ---

// --- saveSession.js ---
async function saveSession(sessionId, force) {
    const id = sessionId || state.activeSessionId;
    const wsKey = getWorkspaceSessionKey();
    const ctx = sessionCtx(id);
    if (ctx.deleted) return;

    if (!id || deletedSessionIds.has(id) || !state.sessions[id]) return;

    const gen = getGenState(id);

    if (!gen.hasNewContent && !force) return;
    gen.hasNewContent = false;

    const isLive = id === state.activeSessionId;

    if (state.sessions[id]) {
        state.sessions[id].messages = ctx.messages;
        if (isLive) {
            state.sessions[id].chatHTML = serializeTermHTML();
            state.sessions[id].openTabs = state.openTabs;
            state.sessions[id].activeTab = state.activeTab;
            state.sessions[id].tabViewModes = { ...(state.tabViewModes || {}) };
        }
        state.sessions[id].updatedAt = Date.now();
        state.sessions[id].modifiedFiles = Array.from(ctx.modifiedFiles);
        if (isLive) {
            state.sessions[id].linesAdded = state.linesAdded;
            state.sessions[id].linesRemoved = state.linesRemoved;
            state.sessions[id].lastTokenUsage = state.lastTokenUsage || null;
        }
        delete state.sessions[id]._loaded;
        await persistCheckpoint(id);
        // The session may have been deleted while we awaited.
        if (!state.sessions[id] || deletedSessionIds.has(id)) return;

        const patch = {
            id: state.sessions[id].id,
            createdAt: state.sessions[id].createdAt,
            messages: state.sessions[id].messages,
            updatedAt: state.sessions[id].updatedAt,
            modifiedFiles: state.sessions[id].modifiedFiles,
            runningTimeMs: state.sessions[id].runningTimeMs || 0
        };
        if (isLive) {
            const att = serializeLiveAttachments();
            if (att) patch.attachments = att;   // never clobber a persisted snapshot with null; explicit deletion is handled by clearSessionAttachments
        }
        if (gen.postCompressTokenOverride != null) {
            patch.postCompressTokenOverride = gen.postCompressTokenOverride;
        }
        if (!state.sessions[id]._titleGenerated) {
            patch.title = state.sessions[id].title;
        }
        if (isLive) {
            patch.chatHTML = state.sessions[id].chatHTML;
            patch.openTabs = state.sessions[id].openTabs;
            patch.activeTab = state.sessions[id].activeTab;
            patch.tabViewModes = state.sessions[id].tabViewModes;
            patch.linesAdded = state.sessions[id].linesAdded;
            patch.linesRemoved = state.sessions[id].linesRemoved;
            patch.lastTokenUsage = state.sessions[id].lastTokenUsage;
            patch.systemPrompt = state.sessions[id].systemPrompt;
            patch.systemPromptMode = state.sessions[id].systemPromptMode;
        }
        const merged = await patchSessionRecordInDB(wsKey, id, patch);
        if (!state.sessions[id] || deletedSessionIds.has(id)) return;
        if (merged) {
            if (typeof merged.title === 'string') state.sessions[id].title = merged.title;
            if (merged._titleGenerated) state.sessions[id]._titleGenerated = true;
        }
    }

    if (!state.sessionIds) state.sessionIds = [id];
    if (!state.sessionIds.includes(id)) state.sessionIds.push(id);
    if (!state.sessionMeta) state.sessionMeta = {};
    if (state.sessions[id]) {
        const s = state.sessions[id];
        state.sessionMeta[id] = {
            id: s.id,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            runningTimeMs: s.runningTimeMs || 0,
            msgCount: countConversationMessages(s.messages)
        };
    }

    const prevIndex = (state._lastSavedWsKey === wsKey) ? state._lastSavedIndex : null;
    const nextIndex = {
        sessionIds: state.sessionIds.slice(),
        activeSessionId: state.activeSessionId,
        meta: { ...state.sessionMeta }
    };
    const indexChanged = !prevIndex
        || prevIndex.activeSessionId !== nextIndex.activeSessionId
        || prevIndex.sessionIds.length !== nextIndex.sessionIds.length
        || prevIndex.sessionIds.some((sid, i) => sid !== nextIndex.sessionIds[i])
        || JSON.stringify(prevIndex.meta?.[id]) !== JSON.stringify(nextIndex.meta[id]);
    if (indexChanged) {
        await saveSessionIndexToDB(wsKey, nextIndex);
        state._lastSavedIndex = nextIndex;
        state._lastSavedWsKey = wsKey;
    }

    if (isLive) updateSessionPillLabel();
}

// --- AST_EXPORTS_START ---
window.saveSession = saveSession;
// --- AST_EXPORTS_END ---

// --- showSessionPopover.js ---
function showSessionPopover() {
    _ensureSessionPopoverBound();
    if (typeof hideWorkspacePopover === 'function') hideWorkspacePopover();
    const se = document.getElementById('session-switcher-search');
    if (se) se.value = '';
    _sessPopoverSelectedId = null;
    _sessRenameId = null;
    renderSessionPopoverList({ scrollToSelected: true });
    sessionsPopoverOverlay.style.display = 'block';
    if (btnSessionToggle) btnSessionToggle.classList.add('active');
    if (btnSessionToggle && sessionsPopover) {
        const rect = btnSessionToggle.getBoundingClientRect();
        const popoverWidth = sessionsPopover.offsetWidth || 420;
        let left = rect.left + (rect.width / 2) - (popoverWidth / 2);
        left = Math.max(10, Math.min(left, window.innerWidth - popoverWidth - 10));
        sessionsPopover.style.top = (rect.bottom + 8) + 'px';
        sessionsPopover.style.left = left + 'px';
        sessionsPopover.style.transform = 'none';
    }
    if (sessionRunTickInterval) clearInterval(sessionRunTickInterval);
    sessionRunTickInterval = setInterval(() => {
        if (isAnySessionRunning()) {
            renderSessionPopoverList();
        }
    }, 1000);
    if (se) requestAnimationFrame(() => se.focus());
}

// --- AST_EXPORTS_START ---
window.showSessionPopover = showSessionPopover;
// --- AST_EXPORTS_END ---

// --- updateSessionPillLabel.js ---
function updateSessionPillLabel() {
    const el = document.getElementById('session-btn-name');

    // No workspace open: the picker screen is up, so there is no session to
    // name. Show the app-level "Workspaces" title instead of a session id.
    if (!rootHandle) {
        if (el) el.innerText = '';
        document.title = 'workbench';
        return;
    }

    const s = state.sessions[state.activeSessionId];
    let display = (s && s.title) ? sanitizeSessionTitle(s.title) : '';

    // Automatically heal existing sessions saved with the raw context references prefix
    if (display.startsWith('Context References:')) {
        const userMatch = display.match(/(?:^|\n)User Prompt:\s*([\s\S]*)$/i);
        if (userMatch && userMatch[1].trim() && !userMatch[1].includes('(Referenced')) {
            display = userMatch[1].trim();
        } else {
            const imgMatch = display.match(/\[Image attached:\s*([^\s\]]+)/i);
            const fileMatch = display.match(/(?:File|Pasted text attached):\s*([^\s\n\(\)]+)/i);
            if (imgMatch) {
                const fname = imgMatch[1].split('/').pop().split('\\').pop().replace(/\.\.\.$/, '');
                display = `Image: ${fname}`;
            } else if (fileMatch) {
                const fname = fileMatch[1].split('/').pop().split('\\').pop().replace(/\.\.\.$/, '');
                display = `File: ${fname}`;
            } else {
                const cleaned = display.replace(/^Context References:\s*(?:\[[^\]]+\]\s*)*/i, '').trim();
                display = cleaned || 'Untitled Session';
            }
        }
        if (s) s.title = display;
    }

    if (!display) display = 'Untitled Session';
    if (el) {
        el.innerText = display;
        el.title = display;
    }
    const btn = document.getElementById('btn-session-toggle');
    if (btn) btn.title = `${display} (Click to view or switch sessions)`;
    document.title = `workbench - ${display}`;
}

// --- AST_EXPORTS_START ---
window.updateSessionPillLabel = updateSessionPillLabel;
// --- AST_EXPORTS_END ---
