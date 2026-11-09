// --- _isInsideToolModelPicker.js ---
function _isInsideToolModelPicker(path) {
    return !!(_toolModelPicker.el && (path.includes(_toolModelPicker.el) || path.includes(_toolModelPicker.overlay)));
}

// --- AST_EXPORTS_START ---
window._isInsideToolModelPicker = _isInsideToolModelPicker;
// --- AST_EXPORTS_END ---

// --- _permSwitchBtn.js ---
function _permSwitchBtn(target) {
    const btn = target && target.closest ? target.closest('.tri-btn') : null;
    return (btn && btn.closest('.tri-switch[data-tool]') && toolsListEl.contains(btn)) ? btn : null;
}

// --- AST_EXPORTS_START ---
window._permSwitchBtn = _permSwitchBtn;
// --- AST_EXPORTS_END ---

// --- _tmpEnsure.js ---
function _tmpEnsure() {
    if (_toolModelPicker.el) return;
    const overlay = document.createElement('div');
    overlay.id = 'tool-model-overlay';
    const dd = document.createElement('div');
    dd.id = 'tool-model-dropdown';
    dd.innerHTML = `<div id="tool-model-search-wrap">
            <input type="text" id="tool-model-search" placeholder="Filter models..." autocomplete="off" />
            <button type="button" id="tool-model-config-btn" title="Edit .agent/models.json"><span class="icon">settings</span></button>
        </div>
        <div id="tool-model-list"></div>`;
    document.body.appendChild(overlay);
    document.body.appendChild(dd);
    const P = _toolModelPicker;
    P.overlay = overlay; P.el = dd;
    P.search = dd.querySelector('#tool-model-search');
    P.list = dd.querySelector('#tool-model-list');
    overlay.addEventListener('click', closeToolModelPicker);
    dd.querySelector('#tool-model-config-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeToolModelPicker();
        openModelsModal();
    });
    P.search.addEventListener('input', (e) => { P.filter = e.target.value; P.idx = 0; _tmpRender(); });
    P.search.addEventListener('keydown', (e) => {
        const entries = _tmpEntries();
        if (e.key === 'ArrowDown') { e.preventDefault(); P.idx = Math.min(P.idx + 1, entries.length - 1); _tmpRender(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); P.idx = Math.max(P.idx - 1, 0); _tmpRender(); }
        else if (e.key === 'Enter') { e.preventDefault(); const en = entries[P.idx]; if (en) _tmpPick(en); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToolModelPicker(); }
    });
}

// --- AST_EXPORTS_START ---
window._tmpEnsure = _tmpEnsure;
// --- AST_EXPORTS_END ---

// --- _tmpEntries.js ---
function _tmpEntries() {
    const f = (_toolModelPicker.filter || '').toLowerCase();
    return getAllModelEntries().filter(e => !f || (e.displayName || e.name).toLowerCase().includes(f) || e.providerName.toLowerCase().includes(f));
}

// --- AST_EXPORTS_START ---
window._tmpEntries = _tmpEntries;
// --- AST_EXPORTS_END ---

// --- _tmpPick.js ---
function _tmpPick(entry) {
    const P = _toolModelPicker;
    const id = entry.uuid;
    const cb = P.onPick;
    closeToolModelPicker();
    if (cb) cb(id, entry);
}

// --- AST_EXPORTS_START ---
window._tmpPick = _tmpPick;
// --- AST_EXPORTS_END ---

// --- _tmpRender.js ---
function _tmpRender() {
    const P = _toolModelPicker;
    const entries = _tmpEntries();
    if (!entries.length) {
        P.list.innerHTML = `<div class="msd-empty">No models found${P.filter ? ' for filter' : ''}</div>`;
        return;
    }
    P.idx = Math.min(P.idx, entries.length - 1);
    const curEntry = findModelEntryById(P.current);
    P.list.innerHTML = entries.map((e, i) => {
        const isCurrent = !!curEntry && curEntry.uuid === e.uuid;
        const classes = ['msd-item'];
        if (i === P.idx) classes.push('highlighted');
        if (isCurrent) classes.push('current');
        return `<div class="${classes.join(' ')}" data-idx="${i}" title="${escapeHTML(e.name)} — ${escapeHTML(e.providerName)}">
            <span class="msd-item-name">${escapeHTML(e.displayName || e.name)}${isCurrent ? ' ✓' : ''}${e.vision ? ' <span class="icon msd-vision-icon" title="Supports vision (image input)">visibility</span>' : ''}</span>
            <span class="msd-item-provider">${escapeHTML(e.providerName)}</span>
        </div>`;
    }).join('');
    P.list.querySelectorAll('.msd-item').forEach(el => {
        el.addEventListener('click', () => {
            const en = entries[Number(el.getAttribute('data-idx'))];
            if (en) _tmpPick(en);
        });
    });
}

// --- AST_EXPORTS_START ---
window._tmpRender = _tmpRender;
// --- AST_EXPORTS_END ---

// --- applyGroupPermission.js ---
function applyGroupPermission(panel, val) {
    const switches = Array.from(panel.querySelectorAll('.tri-switch[data-tool]'));
    switches.forEach(sw => {
        setToolPermission(sw.getAttribute('data-tool'), val);
        sw.querySelectorAll('.tri-btn').forEach(b => {
            const bVal = b.getAttribute('data-val');
            b.className = `tri-btn ${bVal} ${bVal === val ? 'active ' + bVal : ''}`;
        });
    });
}

// --- AST_EXPORTS_START ---
window.applyGroupPermission = applyGroupPermission;
// --- AST_EXPORTS_END ---

// --- checkPermission.js ---
async function checkPermission(toolName, actionDesc, sessionId) {
    const tool = toolRegistry[toolName];
    let level = tool ? (tool.permission || 'ask') : 'ask';
    if (typeof window.getWorkspaceToolsConfig === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        if (cfg && cfg.permissions && cfg.permissions[toolName]) {
            level = cfg.permissions[toolName];
        }
    }
    if (level === 'never') {
        return { allowed: false, error: `Tool '${toolName}' is disabled in permissions (never).` };
    }
    if (level === 'always') {
        return { allowed: true };
    }
    const sid = sessionId || state.activeSessionId;
    const result = await new Promise(resolve => {
        permQueue.push({ sessionId: sid, toolName, actionDesc, resolve });
        refreshPermBanner();
    });
    const approved = result.approved;
    return { allowed: approved, error: approved ? null : (result.reason ? `Permission denied by user. Reason: ${result.reason}` : "Permission denied by user.") };
}

// --- AST_EXPORTS_START ---
window.checkPermission = checkPermission;
// --- AST_EXPORTS_END ---

// --- closePerm.js ---
function closePerm(val, reason = '') {
    const req = permQueue.shift();
    permBanner.style.display = 'none';
    updateGenGlow();
    if (req && req.resolve) req.resolve({ approved: val, reason });
    currentPendingTool = null;
    permRejectReason.value = '';
    focusPrompt();
    refreshPermBanner();
}

// --- AST_EXPORTS_START ---
window.closePerm = closePerm;
// --- AST_EXPORTS_END ---

// --- closeToolModelPicker.js ---
function closeToolModelPicker() {
    const P = _toolModelPicker;
    if (!P.el) return;
    P.visible = false;
    if (P.anchor) P.anchor.classList.remove('open');
    P.anchor = null;
    P.el.style.display = 'none';
    P.overlay.style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.closeToolModelPicker = closeToolModelPicker;
// --- AST_EXPORTS_END ---

// --- loadToolLockState.js ---
function loadToolLockState() {
    if (typeof window.getWorkspaceToolsConfig === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        if (cfg && cfg.locks && typeof cfg.locks === 'object') {
            return { ...cfg.locks };
        }
    }
    try {
        const wsKey = typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null;
        const lsKey = wsKey ? `tool_lock_state_${wsKey}` : 'tool_lock_state';
        const stored = JSON.parse(localStorage.getItem(lsKey) || (wsKey ? 'null' : (localStorage.getItem('tool_lock_state') || '{}')));
        return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    } catch(e) { return {}; }
}

// --- AST_EXPORTS_START ---
window.loadToolLockState = loadToolLockState;
// --- AST_EXPORTS_END ---

// --- loadToolPermState.js ---
function loadToolPermState() {
    if (typeof window.getWorkspaceToolsConfig === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        if (cfg && cfg.permissions && typeof cfg.permissions === 'object') {
            return { ...cfg.permissions };
        }
    }
    try {
        const wsKey = typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null;
        const lsKey = wsKey ? `tool_perm_state_${wsKey}` : 'tool_perm_state';
        const stored = JSON.parse(localStorage.getItem(lsKey) || (wsKey ? 'null' : (localStorage.getItem('tool_perm_state') || '{}')));
        return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    } catch(e) { return {}; }
}

// --- AST_EXPORTS_START ---
window.loadToolPermState = loadToolPermState;
// --- AST_EXPORTS_END ---

// --- openToolModelPicker.js ---
function openToolModelPicker(anchor, currentId, onPick) {
    _tmpEnsure();
    const P = _toolModelPicker;
    if (P.visible) closeToolModelPicker();
    P.visible = true; P.anchor = anchor; P.current = currentId || ''; P.onPick = onPick; P.filter = '';
    const entries = getAllModelEntries();
    const curEntry = findModelEntryById(P.current);
    const ci = curEntry ? entries.findIndex(e => e.uuid === curEntry.uuid) : -1;
    P.idx = ci >= 0 ? ci : 0;
    anchor.classList.add('open');
    P.overlay.style.display = 'block';
    P.el.style.display = 'flex';
    P.search.value = '';
    _tmpRender();
    // Position under the button (or above if there is more room there), kept inside the viewport.
    const r = anchor.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 16);
    P.el.style.width = w + 'px';
    P.el.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    const below = window.innerHeight - r.bottom, above = r.top;
    if (below >= 260 || below >= above) {
        P.el.style.top = (r.bottom + 6) + 'px'; P.el.style.bottom = 'auto';
        P.el.style.maxHeight = Math.max(160, Math.min(360, below - 14)) + 'px';
    } else {
        P.el.style.bottom = (window.innerHeight - r.top + 6) + 'px'; P.el.style.top = 'auto';
        P.el.style.maxHeight = Math.max(160, Math.min(360, above - 14)) + 'px';
    }
    setTimeout(() => P.search.focus(), 0);
}

// --- AST_EXPORTS_START ---
window.openToolModelPicker = openToolModelPicker;
// --- AST_EXPORTS_END ---

// --- refreshGroupPermPreview.js ---
function refreshGroupPermPreview() {
    toolsListEl.querySelectorAll('.tri-btn.group-preview').forEach(b => b.classList.remove('group-preview'));
    if (!_permCtrlDown || !_permHoverBtn || !_permHoverBtn.isConnected) return;
    const panel = _permHoverBtn.closest('.tool-section-panel');
    if (!panel) return;
    const val = _permHoverBtn.getAttribute('data-val');
    panel.querySelectorAll('.tri-switch[data-tool] .tri-btn[data-val="' + val + '"]').forEach(b => b.classList.add('group-preview'));
}

// --- AST_EXPORTS_START ---
window.refreshGroupPermPreview = refreshGroupPermPreview;
// --- AST_EXPORTS_END ---

// --- refreshPermBanner.js ---
function refreshPermBanner() {
    const next = permQueue.find(r => r.sessionId === state.activeSessionId);
    if (!next) {
        permBanner.style.display = 'none';
        currentPendingTool = null;
        updateGenGlow();
        return;
    }
    currentPendingTool = next.toolName;
    permMsg.innerText = `Action requires approval: ${next.actionDesc}`;
    permBanner.style.display = 'flex';
    updateGenGlow();
}

// --- AST_EXPORTS_START ---
window.refreshPermBanner = refreshPermBanner;
// --- AST_EXPORTS_END ---

// --- saveToolLockState.js ---
function saveToolLockState(state) {
    const wsKey = typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null;
    const lsKey = wsKey ? `tool_lock_state_${wsKey}` : 'tool_lock_state';
    try { localStorage.setItem(lsKey, JSON.stringify(state)); } catch(e) {}
    if (!wsKey) {
        try { localStorage.setItem('tool_lock_state', JSON.stringify(state)); } catch(e) {}
    }
    if (typeof window.getWorkspaceToolsConfig === 'function' && typeof window.saveWorkspaceToolsState === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        cfg.locks = { ...(cfg.locks || {}), ...(state || {}) };
        window.saveWorkspaceToolsState(wsKey, cfg);
    }
}

// --- AST_EXPORTS_START ---
window.saveToolLockState = saveToolLockState;
// --- AST_EXPORTS_END ---

// --- saveToolPermState.js ---
function saveToolPermState(state) {
    const wsKey = typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null;
    const lsKey = wsKey ? `tool_perm_state_${wsKey}` : 'tool_perm_state';
    try { localStorage.setItem(lsKey, JSON.stringify(state)); } catch(e) {}
    if (!wsKey) {
        try { localStorage.setItem('tool_perm_state', JSON.stringify(state)); } catch(e) {}
    }
    if (typeof window.getWorkspaceToolsConfig === 'function' && typeof window.saveWorkspaceToolsState === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        cfg.permissions = { ...(cfg.permissions || {}), ...(state || {}) };
        window.saveWorkspaceToolsState(wsKey, cfg);
    }
}

// --- AST_EXPORTS_START ---
window.saveToolPermState = saveToolPermState;
// --- AST_EXPORTS_END ---

// --- setToolLocked.js ---
function setToolLocked(name, locked) {
    const tool = toolRegistry[name];
    if (!tool) return;
    tool.locked = locked;
    const lockState = loadToolLockState();
    lockState[name] = locked;
    saveToolLockState(lockState);
}

// --- AST_EXPORTS_START ---
window.setToolLocked = setToolLocked;
// --- AST_EXPORTS_END ---

// --- setToolModelBtnLabel.js ---
// Button label: model name + provider, like the prompt bar's picker.
function setToolModelBtnLabel(btn, id) {
    const nameEl = btn.querySelector('.msb-name'), provEl = btn.querySelector('.msb-provider');
    const str = String(id || '');
    const entry = findModelEntryById(str);
    if (entry) {
        nameEl.textContent = entry.displayName || entry.name;
        provEl.textContent = entry.providerName;
        btn.title = `${entry.name} — ${entry.providerName}`;
    } else if (str) {
        nameEl.textContent = 'Missing model';
        provEl.textContent = '(not in models.json)';
        btn.title = 'The selected model no longer exists in models.json. Pick another one.';
    } else {
        nameEl.textContent = 'Select model';
        provEl.textContent = '';
        btn.title = 'Pick a model from .agent/models.json';
    }
}

// --- AST_EXPORTS_START ---
window.setToolModelBtnLabel = setToolModelBtnLabel;
// --- AST_EXPORTS_END ---

// --- setToolPermission.js ---
function setToolPermission(name, val) {
    const tool = toolRegistry[name];
    if (!tool) return;
    tool.permission = val;
    const permState = loadToolPermState();
    permState[name] = val;
    saveToolPermState(permState);
    // Keep the name in the tools list in sync right away (rows aren't re-rendered on a permission change).
    if (typeof toolsListEl !== 'undefined' && toolsListEl) {
        const nameEl = toolsListEl.querySelector('.ct-item-name[data-open-tool="' + CSS.escape(name) + '"]');
        if (nameEl) nameEl.classList.toggle('faint', isToolNameFaint(tool));
    }
}

// --- AST_EXPORTS_START ---
window.setToolPermission = setToolPermission;
// --- AST_EXPORTS_END ---
