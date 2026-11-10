// --- buildToolRow.js ---
function buildToolRow(tool) {
    const wrap = document.createElement('div');
    wrap.className = 'ct-item-wrap';

    const row = document.createElement('div');
    row.className = 'ct-item-row';

    let badge = '';
    if (tool.error) {
        badge = `<span class="ct-item-badge broken" title="${escapeHTML(tool.error)}">broken</span>`;
    } else if (tool.require_vision) {
        const visionOk = currentModelHasVision();
        badge = `<span class="ct-item-badge vision${visionOk ? '' : ' inactive'}" title="${visionOk ? 'Requires a vision-capable model (the selected model supports vision)' : 'Requires a vision-capable model - unavailable while the selected model has no vision'}"><span class="icon">${visionOk ? 'visibility' : 'visibility_off'}</span></span>`;
    }

    const modesLabel = (tool.modes || []).map(m => MODE_LABELS[m] || m).join(', ') || 'no modes';
    const titleAttr = tool.error ? tool.error : `${tool.description || ''}\nModes: ${modesLabel}`;
    const hasSettings = Array.isArray(tool.settings) && tool.settings.length > 0;
    const nameClass = `ct-item-name${isToolNameFaint(tool) ? ' faint' : ''}`;

    row.innerHTML = `
        <button class="ct-icon-btn lock-btn ${tool.locked ? 'locked' : ''}" data-lock-tool="${escapeHTML(tool.name)}" title="${tool.locked ? 'Locked - the model cannot modify this tool file. Click to unlock.' : 'Unlocked - the model can modify this tool file. Click to lock.'}">
            <span class="icon" style="font-size:15px;">${tool.locked ? 'lock' : 'lock_open'}</span>
        </button>
        <span class="${nameClass}" title="${escapeHTML(titleAttr)}" data-open-tool="${escapeHTML(tool.name)}"${hasSettings ? ' style="cursor:pointer;"' : ''}>${escapeHTML(tool.name)}${badge}</span>
        <div class="ct-item-actions">
            ${hasSettings
                ? `<button class="ct-icon-btn settings-toggle" data-toggle-tool-settings="${escapeHTML(tool.name)}" title="Tool settings"><span class="icon" style="font-size:15px;">build</span></button>`
                : ''
            }
            ${isRestorableAgentFile(toolFilePath(tool.fileName || tool.name))
                ? (isToolModified(tool.name)
                    ? `<button class="ct-icon-btn" data-reset-tool="${escapeHTML(tool.name)}" title="Restore to built-in default"><span class="icon" style="font-size:15px;">restart_alt</span></button>`
                    : `<button class="ct-icon-btn" aria-hidden="true" style="visibility:hidden;" tabindex="-1"><span class="icon" style="font-size:15px;">restart_alt</span></button>`)
                : `<button class="ct-icon-btn danger" data-delete-tool="${escapeHTML(tool.name)}" title="Delete this tool"><span class="icon" style="font-size:15px;">delete</span></button>`
            }
            <div class="tri-switch" data-tool="${escapeHTML(tool.name)}">
                <button class="tri-btn never ${tool.permission === 'never' ? 'active never' : ''}" data-val="never">never</button>
                <button class="tri-btn ask ${tool.permission === 'ask' ? 'active ask' : ''}" data-val="ask">ask</button>
                <button class="tri-btn always ${tool.permission === 'always' ? 'active always' : ''}" data-val="always">always</button>
            </div>
        </div>
    `;

    row.querySelector('[data-open-tool]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hasSettings) return;
        const panel = wrap.querySelector('.ct-tool-settings-panel');
        const toggleBtn = row.querySelector('[data-toggle-tool-settings]');
        if (panel) {
            const open = panel.style.display !== 'none';
            if (open) {
                collapseToolPanel(wrap);
            } else {
                toolsListEl.querySelectorAll('.ct-item-wrap').forEach(w => {
                    if (w !== wrap) collapseToolPanel(w);
                });
                panel.style.display = 'flex';
                wrap.classList.add('expanded');
                if (toggleBtn) toggleBtn.classList.add('active');
            }
        }
    });

    row.querySelector('[data-lock-tool]').addEventListener('click', (e) => {
        e.stopPropagation();
        setToolLocked(tool.name, !tool.locked);
        renderToolsList();
    });

    row.querySelectorAll('.tri-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const val = btn.getAttribute('data-val');
            setToolPermission(tool.name, val);
            row.querySelectorAll('.tri-btn').forEach(b => {
                const bVal = b.getAttribute('data-val');
                b.className = `tri-btn ${bVal} ${bVal === val ? 'active ' + bVal : ''}`;
            });
        });
    });

    const resetBtn = row.querySelector('[data-reset-tool]');
    if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            restoreAgentFile(toolFilePath(tool.fileName || tool.name));
        });
    }

    const deleteBtn = row.querySelector('[data-delete-tool]');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (tool.locked) {
                showToast(`"${tool.name}" is locked. Unlock it first to delete.`, 'error');
                return;
            }
            await deleteToolFile(tool.name);
            renderExplorerTree();
            renderToolsList();
        });
    }

    wrap.appendChild(row);

    if (hasSettings) {
        const panel = document.createElement('div');
        panel.className = 'ct-tool-settings-panel';
        panel.style.display = 'none';
        tool.settings.forEach(def => panel.appendChild(buildToolSettingRow(tool, def)));
        wrap.appendChild(panel);

        row.querySelector('[data-toggle-tool-settings]').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.currentTarget;
            const open = panel.style.display !== 'none';
            if (open) {
                collapseToolPanel(wrap);
            } else {
                toolsListEl.querySelectorAll('.ct-item-wrap').forEach(w => {
                    if (w !== wrap) collapseToolPanel(w);
                });
                panel.style.display = 'flex';
                wrap.classList.add('expanded');
                btn.classList.add('active');
            }
        });
    }

    return wrap;
}

// --- AST_EXPORTS_START ---
window.buildToolRow = buildToolRow;
// --- AST_EXPORTS_END ---

// --- buildToolSettingRow.js ---
// Renders one input row for a tool-declared setting.
function buildToolSettingRow(tool, def) {
    const row = document.createElement('div');
    row.className = 'ct-tool-setting-row' + (def.type === 'boolean' ? ' inline' : '');
    const value = getToolSettingValue(tool.name, def.key);

    let controlHTML;
    if (def.type === 'boolean') {
        controlHTML = `<div class="tri-switch duo-switch" data-setting-bool="${escapeHTML(def.key)}">
            <button class="tri-btn off ${!value ? 'active off' : ''}" data-val="off">off</button>
            <button class="tri-btn on ${value ? 'active on' : ''}" data-val="on">on</button>
        </div>`;
    } else if (def.type === 'select') {
        controlHTML = `<select data-setting-input="${escapeHTML(def.key)}">
            ${def.options.map(o => `<option value="${escapeHTML(o)}" ${o === value ? 'selected' : ''}>${escapeHTML(o)}</option>`).join('')}
        </select>`;
    } else if (def.type === 'model') {
        // Same look as the prompt's model picker; opens the shared dropdown (see openToolModelPicker).
        controlHTML = `<button type="button" class="ct-model-btn" data-setting-model="${escapeHTML(def.key)}"><span class="msb-name"></span><span class="msb-provider"></span><span class="icon msb-caret">expand_more</span></button>`;
    } else if (def.type === 'number') {
        const minAttr = def.min !== undefined ? ` min="${def.min}"` : '';
        const maxAttr = def.max !== undefined ? ` max="${def.max}"` : '';
        controlHTML = `<input type="number" data-setting-input="${escapeHTML(def.key)}" value="${escapeHTML(String(value))}"${minAttr}${maxAttr}>`;
    } else {
        controlHTML = `<input type="text" data-setting-input="${escapeHTML(def.key)}" value="${escapeHTML(String(value))}">`;
    }

    row.innerHTML = `
        <div class="ct-tool-setting-label" title="${escapeHTML(def.description || '')}">
            <span class="name">${escapeHTML(def.label)}</span>
            ${def.description ? `<span class="desc">${escapeHTML(def.description)}</span>` : ''}
        </div>
        ${controlHTML}
    `;

    const modelBtn = row.querySelector('[data-setting-model]');
    if (modelBtn) {
        let cur = String(value || '');
        setToolModelBtnLabel(modelBtn, cur);
        modelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_toolModelPicker.visible && _toolModelPicker.anchor === modelBtn) { closeToolModelPicker(); return; }
            openToolModelPicker(modelBtn, cur, (id) => {
                cur = id;
                setToolSettingValue(tool.name, def.key, id);
                setToolModelBtnLabel(modelBtn, id);
            });
        });
    }
    const boolSwitch = row.querySelector('[data-setting-bool]');
    if (boolSwitch) {
        boolSwitch.querySelectorAll('.tri-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOn = btn.getAttribute('data-val') === 'on';
                setToolSettingValue(tool.name, def.key, isOn);
                setDuoSwitch(boolSwitch, isOn);
            });
        });
    }
    const input = row.querySelector('[data-setting-input]');
    if (input) {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', (e) => {
            setToolSettingValue(tool.name, def.key, e.target.value);
        });
    }

    return row;
}

// --- AST_EXPORTS_START ---
window.buildToolSettingRow = buildToolSettingRow;
// --- AST_EXPORTS_END ---

// --- closeNewToolModal.js ---
function closeNewToolModal() {
    newToolModalOverlay.style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.closeNewToolModal = closeNewToolModal;
// --- AST_EXPORTS_END ---

// --- coerceToolSettingValue.js ---
// Coerces a stored/raw value to match a setting's declared type, falling back to its default.
function coerceToolSettingValue(settingDef, value) {
    if (!settingDef) return value;
    if (settingDef.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) return settingDef.default;
        let v = n;
        if (settingDef.min !== undefined) v = Math.max(settingDef.min, v);
        if (settingDef.max !== undefined) v = Math.min(settingDef.max, v);
        return v;
    }
    if (settingDef.type === 'boolean') return !!value;
    if (settingDef.type === 'select') return settingDef.options.includes(value) ? value : settingDef.default;
    return (typeof value === 'string') ? value : settingDef.default;
}

// --- AST_EXPORTS_START ---
window.coerceToolSettingValue = coerceToolSettingValue;
// --- AST_EXPORTS_END ---

// --- collapseToolPanel.js ---
function collapseToolPanel(wrap) {
    const panel = wrap.querySelector('.ct-tool-settings-panel');
    const toggleBtn = wrap.querySelector('[data-toggle-tool-settings]');
    if (panel && panel.style.display !== 'none') {
        panel.style.display = 'none';
        wrap.classList.remove('expanded');
        if (toggleBtn) toggleBtn.classList.remove('active');
    }
}

// --- AST_EXPORTS_START ---
window.collapseToolPanel = collapseToolPanel;
// --- AST_EXPORTS_END ---

// --- getToolSettingValue.js ---
function getToolSettingValue(toolName, key) {
    if (typeof window.getWorkspaceToolsConfig === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        if (cfg && cfg.settings && cfg.settings[toolName] && cfg.settings[toolName][key] !== undefined) {
            return cfg.settings[toolName][key];
        }
        const def = (toolRegistry[toolName]?.settings || []).find(s => s.key === key);
        if (def && def.type === 'model' && cfg && cfg.models && cfg.models[toolName] !== undefined) {
            return cfg.models[toolName];
        }
    }
    const tool = toolRegistry[toolName];
    if (!tool) return undefined;
    if (tool.settingsValues && tool.settingsValues[key] !== undefined) return tool.settingsValues[key];
    const def = (tool.settings || []).find(s => s.key === key);
    return def ? def.default : undefined;
}

// --- AST_EXPORTS_START ---
window.getToolSettingValue = getToolSettingValue;
// --- AST_EXPORTS_END ---

// --- handleNewToolFile.js ---
async function handleNewToolFile(file) {
    newToolShowError('');
    if (!file) return;
    if (!/\.js$/i.test(file.name)) {
        newToolShowError('Please drop a .js file.');
        return;
    }
    let text;
    try {
        text = await file.text();
    } catch (e) {
        newToolShowError('Could not read that file.');
        return;
    }
    newToolDroppedSource = text;
    newToolFilePickedName.textContent = file.name;
    newToolFilePicked.style.display = 'block';
    // Show the file's description below its name, similar to the GitHub browse list.
    const meta = parseToolMeta(text);
    const desc = meta && (meta.description || '').trim();
    newToolFilePickedDesc.className = 'newtool-file-picked-desc' + (desc ? '' : ' dim-placeholder');
    newToolFilePickedDesc.textContent = desc || (meta ? 'No description provided.' : 'No TOOL_META found in this file.');
    // A local file takes priority over any GitHub selection.
    newToolBrowseSelected = null;
    renderGithubToolsList();
    newToolUpdateCreateLabel();

    // Auto-fill the name field unless the user has already typed a custom name.
    if (!newToolNameInput.value.trim() || newToolNameAutoFilled) {
        newToolNameInput.value = deriveToolNameFromFile(file.name, text);
        newToolNameAutoFilled = true;
    }
}

// --- AST_EXPORTS_START ---
window.handleNewToolFile = handleNewToolFile;
// --- AST_EXPORTS_END ---

// --- loadToolSettingsState.js ---
// Per-tool settings from TOOL_META.settings, stored as { [toolName]: { [key]: value } }.
function loadToolSettingsState() {
    if (typeof window.getWorkspaceToolsConfig === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        if (cfg && cfg.settings && typeof cfg.settings === 'object') {
            return { ...cfg.settings };
        }
    }
    try {
        const wsKey = typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null;
        const lsKey = wsKey ? `tool_settings_state_${wsKey}` : 'tool_settings_state';
        const stored = JSON.parse(localStorage.getItem(lsKey) || (wsKey ? 'null' : (localStorage.getItem('tool_settings_state') || '{}')));
        return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    } catch(e) { return {}; }
}

// --- AST_EXPORTS_START ---
window.loadToolSettingsState = loadToolSettingsState;
// --- AST_EXPORTS_END ---

// --- newToolBrowseSetStatus.js ---
// when the listing was last fetched (ms)

        function newToolBrowseSetStatus(html) {
            newToolBrowseList.innerHTML = `<div id="newtool-browse-status">${html}</div>`;
        }

// --- AST_EXPORTS_START ---
window.newToolBrowseSetStatus = newToolBrowseSetStatus;
// --- AST_EXPORTS_END ---

// --- newToolClearFile.js ---
function newToolClearFile() {
    newToolDroppedSource = null;
    newToolFileInput.value = '';
    newToolFilePicked.style.display = 'none';
    newToolFilePickedName.textContent = '';
    newToolFilePickedDesc.textContent = '';
    newToolShowError('');
    newToolUpdateCreateLabel();
}

// --- AST_EXPORTS_START ---
window.newToolClearFile = newToolClearFile;
// --- AST_EXPORTS_END ---

// --- newToolShowError.js ---
// [AST_MERGED]: ./js/github.js


function newToolShowError(msg) {
    if (!msg) {
        newToolErrorEl.style.display = 'none';
        newToolErrorEl.textContent = '';
        return;
    }
    newToolErrorEl.textContent = msg;
    newToolErrorEl.style.display = 'block';
}

// --- AST_EXPORTS_START ---
window.newToolShowError = newToolShowError;
// --- AST_EXPORTS_END ---

// --- newToolUpdateCreateLabel.js ---
function newToolUpdateCreateLabel() {
    // Create is for the Blank pane; Browse installs per row and imports use the Install button.
    const createBtn = document.getElementById('newtool-create');
    if (createBtn) createBtn.style.display = newToolActivePane === 'blank' ? '' : 'none';
    const installBtn = document.getElementById('newtool-install');
    if (installBtn) installBtn.style.display = newToolDroppedSource ? '' : 'none';
}

// --- AST_EXPORTS_START ---
window.newToolUpdateCreateLabel = newToolUpdateCreateLabel;
// --- AST_EXPORTS_END ---

// --- normalizeToolSetting.js ---
// Validates/normalizes a TOOL_META.settings entry. Returns null if the entry is unusable
// (missing key, bad type, select with no options) so it can be dropped rather than crash a tool.
function normalizeToolSetting(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key) return null;
    const type = TOOL_SETTING_TYPES.includes(raw.type) ? raw.type : 'text';
    const entry = {
        key: raw.key,
        label: typeof raw.label === 'string' && raw.label ? raw.label : raw.key,
        type,
        description: typeof raw.description === 'string' ? raw.description : ''
    };
    if (type === 'number') {
        entry.default = Number.isFinite(Number(raw.default)) ? Number(raw.default) : 0;
        if (raw.min !== undefined && Number.isFinite(Number(raw.min))) entry.min = Number(raw.min);
        if (raw.max !== undefined && Number.isFinite(Number(raw.max))) entry.max = Number(raw.max);
    } else if (type === 'boolean') {
        entry.default = !!raw.default;
    } else if (type === 'select') {
        entry.options = Array.isArray(raw.options) ? raw.options.filter(o => typeof o === 'string' && o) : [];
        if (!entry.options.length) return null;
        entry.default = entry.options.includes(raw.default) ? raw.default : entry.options[0];
    } else {
        entry.default = typeof raw.default === 'string' ? raw.default : (raw.default !== undefined ? String(raw.default) : '');
    }
    return entry;
}

// --- AST_EXPORTS_START ---
window.normalizeToolSetting = normalizeToolSetting;
// --- AST_EXPORTS_END ---

// --- normalizeToolSettingsList.js ---
function normalizeToolSettingsList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const r of raw) {
        const s = normalizeToolSetting(r);
        if (s && !seen.has(s.key)) { seen.add(s.key); out.push(s); }
    }
    return out;
}

// --- AST_EXPORTS_START ---
window.normalizeToolSettingsList = normalizeToolSettingsList;
// --- AST_EXPORTS_END ---

// --- openNewToolModal.js ---
function openNewToolModal() {
    newToolNameInput.value = '';
    newToolNameAutoFilled = false;
    newToolSourceEditor.value = newToolDefaultSource;
    newToolClearFile();
    newToolBrowseSelected = null;
    newToolBrowseSearch.value = '';
    newToolShowError('');
    newToolUpdateCreateLabel();
    setNewToolPane('browse');
    newToolModalOverlay.style.display = 'flex';
    const locInput = document.getElementById('newtool-browse-location');
    if (locInput) {
        const savedLoc = localStorage.getItem('tools_browse_location');
        locInput.value = savedLoc !== null ? savedLoc : (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
    }
    if (!newToolBrowseFiles) {
        loadGithubToolsList();
    } else {
        renderGithubToolsList();
    }
}

// --- AST_EXPORTS_START ---
window.openNewToolModal = openNewToolModal;
// --- AST_EXPORTS_END ---

// --- renderToolsList.js ---
function renderToolsList() {
    toolsListEl.innerHTML = '';

    const builtinTools = getAllTools().filter(t => t.builtin).sort((a, b) => a.name.localeCompare(b.name));
    if (builtinTools.length) {
        const builtinPanel = document.createElement('div');
        builtinPanel.className = 'tool-section-panel';

        const builtinLabel = document.createElement('div');
        builtinLabel.className = 'tool-section-label';
        builtinLabel.title = 'Hold Ctrl over a permission to preview it for the whole group, Ctrl+click to apply it to all';
        builtinLabel.innerHTML = `Built-in <span class="count">${builtinTools.length}</span>`;
        builtinPanel.appendChild(builtinLabel);

        builtinTools.forEach(tool => builtinPanel.appendChild(buildToolRow(tool)));
        toolsListEl.appendChild(builtinPanel);
    }

    const customTools = getAllTools().filter(t => !t.builtin).sort((a, b) => a.name.localeCompare(b.name));
    const customPanel = document.createElement('div');
    customPanel.className = 'tool-section-panel';

    const customLabelRow = document.createElement('div');
    customLabelRow.className = 'tool-section-label-row';

    const customLabel = document.createElement('div');
    customLabel.className = 'tool-section-label';
    customLabel.title = 'Hold Ctrl over a permission to preview it for the whole group, Ctrl+click to apply it to all';
    customLabel.innerHTML = `Custom <span class="count">${customTools.length}</span>`;
    customLabelRow.appendChild(customLabel);

    const addBtn = document.createElement('button');
    addBtn.className = 'ct-icon-btn';
    addBtn.id = 'btn-new-tool-inline';
    addBtn.title = 'New Tool';
    addBtn.innerHTML = '<span class="icon" style="font-size:15px;">add</span>';
    addBtn.addEventListener('click', () => {
        openNewToolModal();
    });
    customLabelRow.appendChild(addBtn);

    customPanel.appendChild(customLabelRow);

    if (customTools.length === 0) {
        const customNote = document.createElement('div');
        customNote.className = 'ct-empty-note';
        customNote.style.marginLeft = '8px';
        customNote.style.marginBottom = '6px';
        customNote.innerText = 'Hmm feels empty here,\nClick on "+" to add custom tools';
        customPanel.appendChild(customNote);
    } else {
        customTools.forEach(tool => customPanel.appendChild(buildToolRow(tool)));
    }
    toolsListEl.appendChild(customPanel);

    if (!builtinTools.length && !customTools.length) {
        const note = document.createElement('div');
        note.className = 'ct-empty-note';
        note.innerText = 'No tools found.';
        toolsListEl.appendChild(note);
    }
}

// --- AST_EXPORTS_START ---
window.renderToolsList = renderToolsList;
// --- AST_EXPORTS_END ---

// --- saveToolSettingsState.js ---
function saveToolSettingsState(state) {
    const wsKey = typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null;
    const lsKey = wsKey ? `tool_settings_state_${wsKey}` : 'tool_settings_state';
    try { localStorage.setItem(lsKey, JSON.stringify(state)); } catch(e) {}
    if (!wsKey) {
        try { localStorage.setItem('tool_settings_state', JSON.stringify(state)); } catch(e) {}
    }
    if (typeof window.getWorkspaceToolsConfig === 'function' && typeof window.saveWorkspaceToolsState === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        cfg.settings = { ...(cfg.settings || {}), ...(state || {}) };
        window.saveWorkspaceToolsState(wsKey, cfg);
    }
}

// --- AST_EXPORTS_START ---
window.saveToolSettingsState = saveToolSettingsState;
// --- AST_EXPORTS_END ---

// --- setNewToolPane.js ---
function setNewToolPane(pane) {
    if (pane === 'mcp') {
        closeNewToolModal();
        if (typeof openSettingsModal === 'function') {
            openSettingsModal('mcp');
        }
        return;
    }
    newToolActivePane = pane;
    newToolSourceTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.pane === pane));
    newToolPanes.forEach(p => p.classList.toggle('active', p.dataset.pane === pane));
    newToolShowError('');
    newToolUpdateCreateLabel();
    if (pane === 'blank') {
        setTimeout(() => {
            newToolSourceEditor.focus();
            newToolSourceEditor.setSelectionRange(0, 0);
            newToolSourceEditor.scrollTop = 0;
        }, 0);
    }
}

// --- AST_EXPORTS_START ---
window.setNewToolPane = setNewToolPane;
// --- AST_EXPORTS_END ---

// --- setToolSettingValue.js ---
function setToolSettingValue(toolName, key, val) {
    const tool = toolRegistry[toolName];
    if (!tool) return;
    const def = (tool.settings || []).find(s => s.key === key);
    const coerced = coerceToolSettingValue(def, val);
    if (!tool.settingsValues) tool.settingsValues = {};
    tool.settingsValues[key] = coerced;
    const state = loadToolSettingsState();
    if (!state[toolName]) state[toolName] = {};
    state[toolName][key] = coerced;
    saveToolSettingsState(state);

    if (def && def.type === 'model' && typeof window.getWorkspaceToolsConfig === 'function' && typeof window.saveWorkspaceToolsState === 'function') {
        const cfg = window.getWorkspaceToolsConfig();
        if (!cfg.models) cfg.models = {};
        cfg.models[toolName] = coerced;
        window.saveWorkspaceToolsState(typeof window.getWorkspaceToolsKey === 'function' ? window.getWorkspaceToolsKey() : null, cfg);
    }
}

// --- AST_EXPORTS_START ---
window.setToolSettingValue = setToolSettingValue;
// --- AST_EXPORTS_END ---

// --- MCP UI Handlers ---
let mcpFetchedTools = [];

function generateMcpBundleJs(tools, url, bundleName) {
    const enumNames = tools.map(t => t.name);
    const descLines = ["Provides multiplexed access to the following MCP capabilities:"];
    
    for (const t of tools) {
        descLines.push(`\n--- Tool: ${t.name} ---`);
        if (t.description) descLines.push(`Description: ${t.description}`);
        if (t.inputSchema) descLines.push(`Arguments Schema: ${JSON.stringify(t.inputSchema)}`);
    }
    const fullDesc = descLines.join('\n');
    
    return `// Auto-generated Ion tool bundle for MCP capabilities at ${url}
const TOOL_META = {
    name: ${JSON.stringify(bundleName)},
    description: ${JSON.stringify(fullDesc)},
    parameters: {
        type: "object",
        properties: {
            tool_name: {
                type: "string",
                enum: ${JSON.stringify(enumNames)},
                description: "The specific MCP tool to call."
            },
            tool_args: {
                type: "object",
                description: "An object containing the arguments required by the specified tool.",
                additionalProperties: true
            }
        },
        required: ["tool_name"]
    },
    modes: ["plan", "ask", "code"],
    permission: "ask",
    toolBox: 1
};

async function handler(args, api) {
    const updateStatus = (msg) => {
        if (typeof api?.setHeaderMsg === 'function') api.setHeaderMsg(msg);
    };
    
    const mcpUrl = ${JSON.stringify(url)};
    const toolName = args.tool_name;
    
    if (!toolName) {
        return "ERROR: tool_name is required.";
    }
    
    const toolArgs = args.tool_args || {};

    updateStatus("Connecting to " + toolName + " via MCP...");

    return new Promise((resolve) => {
        let es;
        try {
            es = new EventSource(mcpUrl);
        } catch (err) {
            return resolve("ERROR: Failed to instantiate EventSource: " + err.message);
        }

        let messageId = Date.now();
        let timeoutTimer = setTimeout(() => {
            if (es) es.close();
            resolve("ERROR: MCP request timed out after 60 seconds.");
        }, 60000);

        const cleanup = () => {
            clearTimeout(timeoutTimer);
            if (es) es.close();
        };

        es.onerror = () => {
            cleanup();
            resolve("ERROR: EventSource error. Could not connect or lost connection to MCP server at " + mcpUrl);
        };

        let targetUrl = "";

        es.addEventListener("endpoint", async (event) => {
            const postEndpoint = event.data;
            targetUrl = postEndpoint;
            if (targetUrl.startsWith('/')) {
                targetUrl = new URL(mcpUrl).origin + targetUrl;
            } else if (!targetUrl.startsWith('http')) {
                targetUrl = new URL(mcpUrl).origin + '/' + targetUrl;
            }

            const initPayload = {
                jsonrpc: "2.0",
                id: messageId,
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "ion-bundled-tool", version: "1.0.0" }
                }
            };

            try {
                const res = await api.httpPost(targetUrl, {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(initPayload),
                    timeoutMs: 10000
                });
                if (res.error || !res.ok) {
                    cleanup();
                    resolve("ERROR: Init HTTP POST failed: " + (res.error || res.status));
                }
            } catch (e) {
                cleanup();
                resolve("ERROR: Init POST exception: " + e.message);
            }
        });

        es.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.jsonrpc === "2.0" && data.id === messageId) {
                    if (data.error) {
                        cleanup();
                        return resolve("MCP Init Error: " + (data.error.message || JSON.stringify(data.error)));
                    }

                    await api.httpPost(targetUrl, {
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
                        timeoutMs: 10000
                    });

                    const callPayload = {
                        jsonrpc: "2.0",
                        id: messageId + 1,
                        method: "tools/call",
                        params: {
                            name: toolName,
                            arguments: toolArgs
                        }
                    };
                    
                    const res = await api.httpPost(targetUrl, {
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(callPayload),
                        timeoutMs: 50000
                    });
                    
                    if (res.error || !res.ok) {
                        cleanup();
                        resolve("ERROR: Call HTTP POST failed: " + (res.error || res.status));
                    }
                }
                else if (data.jsonrpc === "2.0" && data.id === (messageId + 1)) {
                    cleanup();
                    if (data.error) {
                        return resolve("MCP Server Error: " + (data.error.message || JSON.stringify(data.error)));
                    }
                    
                    const contentList = data.result?.content || [];
                    let hasError = data.result?.isError || false;
                    
                    let outputText = "";
                    let html = '<div style="padding: 10px; font-family: var(--font-mono); font-size: 12px; max-height: 400px; overflow-y: auto;">';
                    html += '<div style="color: var(--dim); margin-bottom: 8px; font-weight: 600;">Tool Executed: <span style="color: var(--fg);">' + toolName + '</span></div>';
                    
                    for (const item of contentList) {
                        if (item.type === "text") {
                            outputText += item.text + "\\n";
                            const escaped = item.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                            html += '<div style="white-space: pre-wrap; padding: 6px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; margin-bottom: 8px; color: ' + (hasError ? 'var(--red)' : 'var(--fg)') + ';">' + escaped + '</div>';
                        } else if (item.type === "image") {
                            outputText += "[Image Data returned]\\n";
                            html += '<div style="color: var(--dim); font-style: italic;">[Image response hidden]</div>';
                        } else if (item.type === "resource") {
                            outputText += "[Resource: " + item.resource?.uri + "]\\n" + (item.resource?.text || '') + "\\n";
                        }
                    }
                    html += '</div>';
                    
                    await api.showUI(html);
                    resolve({
                        output: outputText.trim() || "(Empty response from tool)",
                        summary: "MCP: " + toolName + (hasError ? ' (Error)' : ' (Success)')
                    });
                }
            } catch(e) {}
        };
    });
}
`;
}

document.addEventListener('DOMContentLoaded', () => {
    const locInput = document.getElementById('newtool-browse-location');
    const locResetBtn = document.getElementById('newtool-browse-location-reset');
    const browseRefreshBtn = document.getElementById('newtool-browse-refresh');
    const browseSearchInput = document.getElementById('newtool-browse-search');

    if (locInput) {
        locInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = locInput.value.trim() || (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
                localStorage.setItem('tools_browse_location', val);
                if (typeof loadGithubToolsList === 'function') loadGithubToolsList(true);
            }
        });
        locInput.addEventListener('change', () => {
            const val = locInput.value.trim() || (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
            localStorage.setItem('tools_browse_location', val);
        });
    }

    if (locResetBtn) {
        locResetBtn.addEventListener('click', () => {
            const def = (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
            if (locInput) locInput.value = def;
            localStorage.setItem('tools_browse_location', def);
            if (typeof loadGithubToolsList === 'function') loadGithubToolsList(true);
        });
    }

    if (browseRefreshBtn) {
        browseRefreshBtn.addEventListener('click', () => {
            if (locInput) {
                const val = locInput.value.trim() || (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
                localStorage.setItem('tools_browse_location', val);
            }
            if (typeof loadGithubToolsList === 'function') loadGithubToolsList(true);
        });
    }

    if (browseSearchInput) {
        browseSearchInput.addEventListener('input', () => {
            if (typeof renderGithubToolsList === 'function') renderGithubToolsList();
        });
    }

    const connectBtn = document.getElementById('mcp-server-connect') || document.getElementById('newtool-mcp-connect');
    const urlInput = document.getElementById('mcp-server-url') || document.getElementById('newtool-mcp-url');
    const statusEl = document.getElementById('mcp-server-status') || document.getElementById('newtool-mcp-status');
    const toolsContainer = document.getElementById('mcp-tools-container') || document.getElementById('newtool-mcp-tools-container');
    const toolsList = document.getElementById('mcp-tools-list') || document.getElementById('newtool-mcp-tools-list');
    const createBtn = document.getElementById('mcp-create-bundle') || document.getElementById('newtool-create-mcp');
    const bundleNameInput = document.getElementById('mcp-bundle-name') || document.getElementById('newtool-mcp-bundle-name');

    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            const url = (urlInput ? urlInput.value.trim() : '');
            if (!url) {
                if (statusEl) {
                    statusEl.textContent = 'Please enter a URL.';
                    statusEl.style.color = 'var(--red)';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = 'Connecting to MCP SSE endpoint...';
                statusEl.style.color = 'var(--dim)';
            }
            if (toolsContainer) toolsContainer.style.display = 'none';
            mcpFetchedTools = [];

            let es;
            try {
                es = new EventSource(url);
            } catch (err) {
                if (statusEl) {
                    statusEl.textContent = 'Failed to connect: ' + err.message;
                    statusEl.style.color = 'var(--red)';
                }
                return;
            }

            let timeout = setTimeout(() => {
                es.close();
                if (statusEl) {
                    statusEl.textContent = 'Timeout waiting for endpoint event. Is the server running?';
                    statusEl.style.color = 'var(--red)';
                }
            }, 10000);

            let messageId = 1;
            let targetUrl = "";

            es.onerror = () => {
                clearTimeout(timeout);
                es.close();
                if (statusEl) {
                    statusEl.textContent = 'EventSource error. Could not connect (check CORS or server status).';
                    statusEl.style.color = 'var(--red)';
                }
            };

            es.addEventListener("endpoint", async (event) => {
                clearTimeout(timeout);
                targetUrl = event.data;
                if (targetUrl.startsWith('/')) {
                    targetUrl = new URL(url).origin + targetUrl;
                } else if (!targetUrl.startsWith('http')) {
                    targetUrl = new URL(url).origin + '/' + targetUrl;
                }
                
                if (statusEl) statusEl.textContent = 'Discovered POST endpoint. Initializing...';

                try {
                    const initPayload = {
                        jsonrpc: "2.0",
                        id: messageId,
                        method: "initialize",
                        params: {
                            protocolVersion: "2024-11-05",
                            capabilities: {},
                            clientInfo: { name: "ion-bundled-tool", version: "1.0.0" }
                        }
                    };
                    const res = await fetch(targetUrl, {
                        method: 'POST',
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(initPayload)
                    });
                    if (!res.ok) throw new Error('Init HTTP POST failed: ' + res.status);
                } catch (e) {
                    es.close();
                    if (statusEl) {
                        statusEl.textContent = 'Init POST exception: ' + e.message;
                        statusEl.style.color = 'var(--red)';
                    }
                }
            });

            es.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.id === messageId) {
                        if (data.error) {
                            es.close();
                            if (statusEl) {
                                statusEl.textContent = "MCP Init Error: " + (data.error.message || "Unknown error");
                                statusEl.style.color = 'var(--red)';
                            }
                            return;
                        }
                        
                        if (statusEl) statusEl.textContent = 'Initialized. Fetching tools list...';
                        
                        await fetch(targetUrl, {
                            method: 'POST',
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
                        });
                        
                        const callPayload = {
                            jsonrpc: "2.0",
                            id: messageId + 1,
                            method: "tools/list",
                            params: {}
                        };
                        
                        await fetch(targetUrl, {
                            method: 'POST',
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(callPayload)
                        });
                    }
                    else if (data.id === messageId + 1) {
                        es.close();
                        if (data.error) {
                            if (statusEl) {
                                statusEl.textContent = "MCP Server Error: " + (data.error.message || "Unknown error");
                                statusEl.style.color = 'var(--red)';
                            }
                            return;
                        }
                        
                        mcpFetchedTools = data.result?.tools || [];
                        if (mcpFetchedTools.length === 0) {
                            if (statusEl) {
                                statusEl.textContent = "Connected, but no tools found on this server.";
                                statusEl.style.color = 'var(--yellow)';
                            }
                            return;
                        }
                        
                        if (statusEl) {
                            statusEl.textContent = `Found ${mcpFetchedTools.length} tools.`;
                            statusEl.style.color = 'var(--green)';
                        }
                        
                        if (toolsList) {
                            toolsList.innerHTML = '';
                            mcpFetchedTools.forEach((t, i) => {
                                const row = document.createElement('label');
                                row.className = 'mcp-tool-item';
                                row.style.display = 'flex';
                                row.style.alignItems = 'flex-start';
                                row.style.gap = '8px';
                                row.style.padding = '6px';
                                row.style.borderBottom = '1px solid var(--border)';
                                row.style.cursor = 'pointer';
                                
                                const cb = document.createElement('input');
                                cb.type = 'checkbox';
                                cb.value = i;
                                cb.checked = true;
                                cb.style.marginTop = '3px';
                                
                                const desc = document.createElement('div');
                                desc.style.display = 'flex';
                                desc.style.flexDirection = 'column';
                                
                                const name = document.createElement('div');
                                name.textContent = t.name;
                                name.style.fontWeight = '600';
                                name.style.fontSize = '12px';
                                name.style.color = 'var(--fg)';
                                
                                const text = document.createElement('div');
                                text.textContent = t.description || 'No description';
                                text.style.fontSize = '11px';
                                text.style.color = 'var(--dim)';
                                
                                desc.appendChild(name);
                                desc.appendChild(text);
                                row.appendChild(cb);
                                row.appendChild(desc);
                                
                                toolsList.appendChild(row);
                            });
                        }
                        
                        if (toolsContainer) toolsContainer.style.display = 'block';
                    }
                } catch(e) {}
            };
        });
    }

    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            if (!toolsList) return;
            const checkboxes = Array.from(toolsList.querySelectorAll('input[type="checkbox"]:checked'));
            if (checkboxes.length === 0) {
                if (statusEl) {
                    statusEl.textContent = "Please select at least one tool to bundle.";
                    statusEl.style.color = 'var(--red)';
                } else if (typeof newToolShowError === 'function') {
                    newToolShowError("Please select at least one tool to bundle.");
                }
                return;
            }
            
            const selectedTools = checkboxes.map(cb => mcpFetchedTools[parseInt(cb.value)]);
            const bundleName = (bundleNameInput ? bundleNameInput.value.trim() : '') || 'mcp_tools';
            const url = (urlInput ? urlInput.value.trim() : '');
            
            const jsSource = generateMcpBundleJs(selectedTools, url, bundleName);
            
            const res = createToolFile(bundleName, jsSource);
            if (!res.ok) {
                if (statusEl) {
                    statusEl.textContent = res.error;
                    statusEl.style.color = 'var(--red)';
                } else if (typeof newToolShowError === 'function') {
                    newToolShowError(res.error);
                }
            } else {
                if (statusEl) {
                    statusEl.textContent = `Created tool bundle "${bundleName}" successfully.`;
                    statusEl.style.color = 'var(--green)';
                }
                if (typeof showToast === 'function') {
                    showToast(`Created tool bundle "${bundleName}"`, 'success');
                }
                if (typeof renderToolsList === 'function') renderToolsList();
                if (typeof renderExplorerTree === 'function') renderExplorerTree();
            }
        });
    }
});
