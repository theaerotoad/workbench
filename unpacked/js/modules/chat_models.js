// --- closeModelSelect.js ---
function closeModelSelect() {
    _modelSelectState.visible = false;
    modelSelectBtn.classList.remove('open');
    modelSelectDropdown.style.display = 'none';
    modelSelectOverlay.style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.closeModelSelect = closeModelSelect;
// --- AST_EXPORTS_END ---

// --- closeModelsModal.js ---
function closeModelsModal() {
    modelsModalOverlay.style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.closeModelsModal = closeModelsModal;
// --- AST_EXPORTS_END ---

// --- commitModelsChange.js ---
// Persists MODEL_PROVIDERS and refreshes the dropdown and explorer.
function commitModelsChange() {
    saveModels();
    renderModelDropdown();
    renderExplorerTree();
}

// --- AST_EXPORTS_START ---
window.commitModelsChange = commitModelsChange;
// --- AST_EXPORTS_END ---

// --- fetchModelsForPicker.js ---
async function fetchModelsForPicker() {
    const { modelInfo } = _modelPickerState;

    let apiUrl = modelInfo ? modelInfo.url : '';
    let apiKey = modelInfo ? modelInfo.key : '';

    if (!apiUrl) {
        _modelPickerState.loading = false;
        _modelPickerState.error = 'No API URL configured for this model';
        renderModelPickerList();
        return;
    }

    if (!apiUrl.endsWith('/models') && !apiUrl.endsWith('/v1/models')) {
        apiUrl = apiUrl.replace(/\/$/, '') + '/models';
    }

    try {
        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        
        const targetUrl = apiUrl;
        const reqUrl = _modelPickerState.modelInfo?.useProxy ? '/proxy' : targetUrl;
        if (_modelPickerState.modelInfo?.useProxy) headers['x-proxy-target'] = targetUrl;
        
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(reqUrl, { headers, signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const list = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
        _modelPickerState.apiModels = list.map(m => ({
            id: m.id || m.name || '',
            name: m.name || m.id || ''
        }));
        _modelPickerState.loading = false;
        _modelPickerState.error = null;
    } catch (e) {
        _modelPickerState.loading = false;
        _modelPickerState.error = `Failed to fetch: ${e.message}`;
    }
    renderModelPickerList();
}

// --- AST_EXPORTS_START ---
window.fetchModelsForPicker = fetchModelsForPicker;
// --- AST_EXPORTS_END ---

// --- findModelInfoForLine.js ---
// Finds url/key for the model under the cursor via its parent provider; handles compact and multi-line models.
function findModelInfoForLine(filepath, targetLine) {
    if (!filepath || !filepath.endsWith('models.json')) return null;
    if (!monacoEditor) return null;

    const model = monacoEditor.getModel();
    if (!model) return null;

    const lineCount = model.getLineCount();
    const lineText = (n) => model.getLineContent(n);

    // Stack of object frames open strictly BEFORE targetLine.
    const stack = [];
    for (let line = 1; line < targetLine; line++) {
        const noStrings = lineText(line).replace(/"[^"]*"/g, '""');
        for (const ch of noStrings) {
            if (ch === '{') stack.push({ startLine: line });
            else if (ch === '}') stack.pop();
        }
    }

    const targetNoStrings = lineText(targetLine).replace(/"[^"]*"/g, '""');
    let localDepth = 0;
    let sawSelfContained = false;
    for (const ch of targetNoStrings) {
        if (ch === '{') {
            localDepth++;
        } else if (ch === '}') {
            localDepth--;
            if (localDepth === 0) sawSelfContained = true;
        }
    }
    const opensUnclosed = localDepth > 0;

    const readObjectContent = (frame) => {
        let depth = 0;
        let endLine = frame.startLine;
        for (let line = frame.startLine; line <= lineCount; line++) {
            const noStrings = lineText(line).replace(/"[^"]*"/g, '""');
            for (const ch of noStrings) {
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { endLine = line; break; } }
            }
            if (depth === 0 && endLine === line) break;
        }
        let content = '';
        for (let line = frame.startLine; line <= endLine; line++) content += lineText(line) + '\n';
        return content;
    };

    let modelContent, providerFrame;

    if (opensUnclosed) {
        // A model object starts here and continues onto later lines.
        const modelFrame = { startLine: targetLine };
        providerFrame = stack.length ? stack[stack.length - 1] : modelFrame;
        modelContent = readObjectContent(modelFrame);
    } else if (sawSelfContained) {
        // A complete {..} on this line (compact model); the enclosing object is the provider.
        if (!stack.length) return null;
        providerFrame = stack[stack.length - 1];
        modelContent = lineText(targetLine);
    } else {
        // No braces on this line: we're inside an already-open object.
        if (!stack.length) return null;
        const modelFrame = stack[stack.length - 1];
        providerFrame = stack.length >= 2 ? stack[stack.length - 2] : modelFrame;
        modelContent = readObjectContent(modelFrame);
    }

    const providerContent = readObjectContent(providerFrame);
    const nameMatch = modelContent.match(/"name"\s*:\s*"([^"]+)"/);
    const urlMatch = providerContent.match(/"url"\s*:\s*"([^"]+)"/);
    const keyMatch = providerContent.match(/"key"\s*:\s*"([^"]*)"/);
    const proxyMatch = providerContent.match(/"useProxy"\s*:\s*(true|false)/);

    return {
        label: nameMatch ? nameMatch[1] : null,
        url: urlMatch ? urlMatch[1] : null,
        key: keyMatch ? keyMatch[1] : '',
        useProxy: proxyMatch ? proxyMatch[1] === 'true' : false
    };
}

// --- AST_EXPORTS_START ---
window.findModelInfoForLine = findModelInfoForLine;
// --- AST_EXPORTS_END ---

// --- getModelEntriesFiltered.js ---
function getModelEntriesFiltered() {
    const filter = (_modelSelectState.filter || '').toLowerCase();
    return getAllModelEntries()
        .filter(e => !filter || (e.displayName || e.name).toLowerCase().includes(filter) || e.providerName.toLowerCase().includes(filter));
}

// --- AST_EXPORTS_START ---
window.getModelEntriesFiltered = getModelEntriesFiltered;
// --- AST_EXPORTS_END ---

// --- getModelValueEndPosition.js ---
function getModelValueEndPosition(lineContent) {
    const quotedRegex = /("name"\s*:\s*"[^"]*)"/;
    let match = quotedRegex.exec(lineContent);
    if (match) {
        return match.index + match[0].length + 1;
    }

    const unquotedRegex = /("name"\s*:\s*)([^\s,}\]]+)/;
    match = unquotedRegex.exec(lineContent);
    if (match) {
        const valueStart = match.index + match[1].length;
        return valueStart + match[2].length + 1;
    }

    return null;
}

// --- AST_EXPORTS_START ---
window.getModelValueEndPosition = getModelValueEndPosition;
// --- AST_EXPORTS_END ---

// --- getModelValueFromLine.js ---
function getModelValueFromLine(lineContent) {
    const quotedRegex = /"name"\s*:\s*"([^"]*)"/;
    let match = quotedRegex.exec(lineContent);
    if (match) return match[1];

    const unquotedRegex = /"name"\s*:\s*([^\s,}\]]+)/;
    match = unquotedRegex.exec(lineContent);
    if (match) return match[1];

    return '';
}

// --- AST_EXPORTS_START ---
window.getModelValueFromLine = getModelValueFromLine;
// --- AST_EXPORTS_END ---

// --- hideModelPicker.js ---
function hideModelPicker() {
    _modelPickerState.visible = false;
    modelPickerDropdown.style.display = 'none';
    modelPickerOverlay.style.display = 'none';
    modelPickerSearch.value = '';
}

// --- AST_EXPORTS_START ---
window.hideModelPicker = hideModelPicker;
// --- AST_EXPORTS_END ---

// --- hideModelPickerWidget.js ---
function hideModelPickerWidget() {
    if (_modelPickerWidget && monacoEditor) {
        monacoEditor.removeContentWidget(_modelPickerWidget);
        _modelPickerWidget = null;
    }
}

// --- AST_EXPORTS_START ---
window.hideModelPickerWidget = hideModelPickerWidget;
// --- AST_EXPORTS_END ---

// --- mmNewProvider.js ---
function mmNewProvider() {
    return { provider: 'New Provider', url: '', key: '', useProxy: false, models: [{ name: '', context_window: DEFAULT_CONTEXT_WINDOW, vision: false }] };
}

// --- AST_EXPORTS_START ---
window.mmNewProvider = mmNewProvider;
// --- AST_EXPORTS_END ---

// --- openModelSelect.js ---
function openModelSelect() {
    _modelSelectState.visible = true;
    _modelSelectState.filter = '';
    const entries = getAllModelEntries();
    const sel = getSelectedModelKey();
    const currentIdx = sel ? entries.findIndex(e => e.providerName === sel.providerName && e.name === sel.modelName) : -1;
    _modelSelectState.selectedIdx = currentIdx >= 0 ? currentIdx : 0;
    modelSelectBtn.classList.add('open');
    modelSelectDropdown.style.display = 'flex';
    modelSelectOverlay.style.display = 'block';
    modelSelectSearch.value = '';
    renderModelSelectList();
    setTimeout(() => modelSelectSearch.focus(), 0);
}

// --- AST_EXPORTS_START ---
window.openModelSelect = openModelSelect;
// --- AST_EXPORTS_END ---

// --- openModelsModal.js ---
function openModelsModal() {
    _mmSelectedIdx = 0;
    modelsModalEl.classList.remove('mm-detail-open'); // mobile: start on the provider list
    renderModelsModal();
    modelsModalOverlay.style.display = 'flex';
}

// --- AST_EXPORTS_START ---
window.openModelsModal = openModelsModal;
// --- AST_EXPORTS_END ---

// --- renderModelPickerList.js ---
function renderModelPickerList() {
    const { apiModels, loading, error, filter, selectedIdx } = _modelPickerState;

    if (loading) {
        modelPickerList.innerHTML = `<div id="model-picker-loading"><span class="icon">progress_activity</span>Fetching models...</div>`;
        return;
    }
    if (error) {
        modelPickerList.innerHTML = `<div id="model-picker-error">${escapeHTML(error)}</div>`;
        return;
    }

    const q = filter.toLowerCase();
    const filtered = apiModels.filter(m => {
        const name = (m.id || m.name || '').toLowerCase();
        const created = m.created ? new Date(m.created * 1000).getFullYear().toString() : '';
        return name.includes(q) || created.includes(q);
    });

    if (filtered.length === 0) {
        modelPickerList.innerHTML = `<div class="model-picker-empty">No models found${filter ? ' for filter' : ''}</div>`;
        return;
    }

    _modelPickerState.selectedIdx = Math.min(selectedIdx, filtered.length - 1);

    modelPickerList.innerHTML = filtered.map((m, i) => {
        const name = m.id || m.name || 'unknown';
        const created = m.created ? new Date(m.created * 1000).getFullYear() : '';
        const meta = created ? `created ${created}` : '';
        return `<div class="model-picker-item${i === _modelPickerState.selectedIdx ? ' selected' : ''}" data-idx="${i}">
            <span class="model-picker-item-name">${escapeHTML(name)}</span>
            ${meta ? `<span class="model-picker-item-meta">${meta}</span>` : ''}
        </div>`;
    }).join('');

    modelPickerList.querySelectorAll('.model-picker-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            selectModelFromPicker(filtered[idx]);
        });
    });
}

// --- AST_EXPORTS_START ---
window.renderModelPickerList = renderModelPickerList;
// --- AST_EXPORTS_END ---

// --- renderModelSelectList.js ---
function renderModelSelectList() {
    const entries = getModelEntriesFiltered();
    if (!entries.length) {
        modelSelectList.innerHTML = `<div class="msd-empty">No models found${_modelSelectState.filter ? ' for filter' : ''}</div>`;
        return;
    }
    const sel = getSelectedModelKey();
    _modelSelectState.selectedIdx = Math.min(_modelSelectState.selectedIdx, entries.length - 1);
    modelSelectList.innerHTML = entries.map((e, i) => {
        const isCurrent = sel && e.providerName === sel.providerName && e.name === sel.modelName;
        const isHighlighted = i === _modelSelectState.selectedIdx;
        const classes = ['msd-item'];
        if (isHighlighted) classes.push('highlighted');
        if (isCurrent) classes.push('current');
        const displayName = e.displayName || e.name;
        return `<div class="${classes.join(' ')}" data-idx="${i}" data-provider-name="${escapeHTML(e.providerName)}" data-model-name="${escapeHTML(e.name)}" title="${escapeHTML(e.name)} — ${escapeHTML(e.providerName)}">
            <span class="msd-item-name">${escapeHTML(displayName)}${isCurrent ? ' ✓' : ''}${e.vision ? ' <span class="icon msd-vision-icon" title="Supports vision (image input)">visibility</span>' : ''}</span>
            <span class="msd-item-provider">${escapeHTML(e.providerName)}</span>
        </div>`;
    }).join('');
    modelSelectList.querySelectorAll('.msd-item').forEach(el => {
        el.addEventListener('click', () => {
            const providerName = el.getAttribute('data-provider-name');
            const modelName = el.getAttribute('data-model-name');
            setSelectedModel(providerName, modelName);
            closeModelSelect();
        });
    });
}

// --- AST_EXPORTS_START ---
window.renderModelSelectList = renderModelSelectList;
// --- AST_EXPORTS_END ---

// --- renderModelsModal.js ---
// Renders both panes; focusField optionally names an input to focus afterward.
function renderModelsModal(focusField) {
    const hasProviders = Array.isArray(MODEL_PROVIDERS) && MODEL_PROVIDERS.length > 0;
    if (hasProviders) {
        _mmSelectedIdx = Math.max(0, Math.min(_mmSelectedIdx, MODEL_PROVIDERS.length - 1));
    }

    // Left pane: the provider list, always in the same place.
    mmProviderListEl.innerHTML = !hasProviders
        ? `<div class="mm-empty" style="padding:18px 8px;">No providers yet</div>`
        : MODEL_PROVIDERS.map((p, pi) => {
            const modelCount = (p.models || []).length;
            return `
            <div class="mm-provider-item${pi === _mmSelectedIdx ? ' active' : ''}" data-pi="${pi}">
                <span class="mm-provider-item-name">${escapeHTML(p.provider || 'Unnamed provider')}</span>
                <span class="mm-provider-item-count">${modelCount}</span>
            </div>`;
        }).join('');

    mmProviderListEl.querySelectorAll('.mm-provider-item').forEach(item => {
        item.addEventListener('click', () => {
            _mmSelectedIdx = Number(item.getAttribute('data-pi'));
            modelsModalEl.classList.add('mm-detail-open'); // mobile: drill into detail
            renderModelsModal();
        });
    });

    // Right pane: details for the selected provider only.
    if (!hasProviders) {
        mmDetailEl.innerHTML = `<div class="mm-empty-detail">No providers configured yet.<br>Use "Add Provider" to create one.</div>`;
        return;
    }

    const p = MODEL_PROVIDERS[_mmSelectedIdx];
    const modelRows = (p.models || []).map((m, mi) => `
        <div class="mm-model-row" data-mi="${mi}">
            <div class="mm-model-name-wrap">
                <input type="text" class="mm-model-name" data-field="name" placeholder="model-id" value="${escapeHTML(m.name || '')}" />
                <button type="button" class="mm-model-search-btn" title="Browse models from API">
                    <span class="icon">search</span>
                </button>
            </div>
            <input type="text" class="mm-model-ctx" data-field="context_window" placeholder="context window" value="${m.context_window != null ? escapeHTML(String(m.context_window)) : ''}" />
            <button type="button" class="mm-model-vision-btn${normalizeVisionFlag(m.vision) ? ' on' : ''}" aria-pressed="${normalizeVisionFlag(m.vision)}" title="${normalizeVisionFlag(m.vision) ? 'Vision enabled: this model can receive images. Click to disable.' : 'Vision disabled: image attachments and vision-only tools are unavailable. Click to enable.'}">
                <span class="icon">${normalizeVisionFlag(m.vision) ? 'visibility' : 'visibility_off'}</span><span>Vision</span>
            </button>
            <button type="button" class="mm-model-remove-btn" title="Remove model">
                <span class="icon">close</span>
            </button>
        </div>`).join('');

    mmDetailEl.innerHTML = `
        <div class="mm-detail-head">
            <button type="button" class="mm-back-btn" title="Back to providers"><span class="icon">arrow_back</span></button>
            <input type="text" class="mm-detail-title-input" data-field="provider" placeholder="Provider name" value="${escapeHTML(p.provider || '')}" />
            <button type="button" class="mm-remove-provider-btn"><span class="icon">delete</span><span>Remove</span></button>
        </div>
        <div class="mm-row">
            <label>URL</label>
            <input type="text" data-field="url" placeholder="https://api.example.com/v1" value="${escapeHTML(p.url || '')}" />
        </div>
        <div class="mm-row">
            <label>API Key</label>
            <div class="mm-key-wrap">
                <input type="password" data-field="key" placeholder="(optional)" value="${escapeHTML(p.key || '')}" />
                <button type="button" class="mm-key-toggle" title="Show/hide key">
                    <span class="icon">visibility</span>
                </button>
            </div>
        </div>
        <div class="mm-row" style="flex-direction:row; align-items:center; gap:8px; margin-top: 4px;">
            <input type="checkbox" data-field="useProxy" ${p.useProxy ? 'checked' : ''} id="mm-proxy-chk" style="width:auto; margin:0;" />
            <label for="mm-proxy-chk" style="margin:0; cursor:pointer;" title="Route API requests through the local Python server to bypass CORS">Use Local Proxy</label>
        </div>
        <div class="mm-models-label">Models</div>
        ${(p.models || []).length ? `<div class="mm-models-cols"><span class="c-name">Model id</span><span class="c-ctx">Context</span><span class="c-vision">Vision</span><span class="c-rm"></span></div>` : ''}
        ${modelRows || '<div class="mm-empty" style="padding:8px 0;">No models yet</div>'}
        <button type="button" class="mm-add-model-btn"><span class="icon">add</span><span>Add Model</span></button>
    `;

    wireModelsDetailEvents();
    const mmBackBtn = mmDetailEl.querySelector('.mm-back-btn');
    if (mmBackBtn) mmBackBtn.addEventListener('click', () => modelsModalEl.classList.remove('mm-detail-open'));

    if (focusField) {
        const target = mmDetailEl.querySelector(focusField);
        if (target) { target.focus(); if (target.select) target.select(); }
    }
}

// --- AST_EXPORTS_START ---
window.renderModelsModal = renderModelsModal;
// --- AST_EXPORTS_END ---

// --- selectModelFromPicker.js ---
function selectModelFromPicker(model) {
    if (!model) return;
    const modelId = model.id || model.name || '';
    if (!modelId) return;

    if (_modelPickerState.onSelect) {
        _modelPickerState.onSelect(modelId);
        hideModelPicker();
        return;
    }

    const editor = monacoEditor;
    if (!editor) {
        hideModelPicker();
        return;
    }

    const { targetLine } = _modelPickerState;

    const model_line = editor.getModel().getLineContent(targetLine);
    const escapedModelId = modelId.replace(/\\/g, '\\\\');

    const quotedRegex = /("name"\s*:\s*)"([^"]*)"/;
    const quotedMatch = quotedRegex.exec(model_line);

    if (quotedMatch) {
        const valueStart = quotedMatch.index + quotedMatch[1].length;
        const range = new MONACO.Range(
            targetLine,
            valueStart + 2,
            targetLine,
            valueStart + quotedMatch[2].length + 2
        );
        editor.executeEdits('model-picker', [{ range, text: escapedModelId }]);
    } else {
        const unquotedRegex = /("name"\s*:\s*)([^\s,}\]]+)/;
        const unquotedMatch = unquotedRegex.exec(model_line);
        if (unquotedMatch) {
            const valueStart = unquotedMatch.index + unquotedMatch[1].length;
            const range = new MONACO.Range(
                targetLine,
                valueStart + 1,
                targetLine,
                valueStart + unquotedMatch[2].length + 1
            );
            editor.executeEdits('model-picker', [{ range, text: `"${escapedModelId}"` }]);
        } else {
            hideModelPicker();
            return;
        }
    }

    hideModelPicker();
    editor.focus();
}

// --- AST_EXPORTS_START ---
window.selectModelFromPicker = selectModelFromPicker;
// --- AST_EXPORTS_END ---

// --- showModelPicker.js ---
function showModelPicker(targetLine, targetColumn, editorOffset, currentModelName, modelInfo, onSelect) {
    _modelPickerState = {
        visible: true,
        targetLine,
        targetColumn,
        editorOffset,
        modelName: currentModelName,
        modelInfo: modelInfo || { label: null, url: null, key: '' },
        apiModels: [],
        loading: true,
        error: null,
        filter: '',
        selectedIdx: 0,
        // When set, selection calls this instead of editing the Monaco buffer.
        onSelect: onSelect || null
    };

    const dropdownH = 420;
    const dropdownW = 380;
    let top = editorOffset.top + 10;
    let left = editorOffset.left - 100;

    if (top + dropdownH > window.innerHeight - 10) {
        top = editorOffset.top - dropdownH - 5;
    }
    if (left + dropdownW > window.innerWidth - 10) {
        left = window.innerWidth - dropdownW - 10;
    }
    if (left < 10) left = 10;

    modelPickerDropdown.style.top = `${top}px`;
    modelPickerDropdown.style.left = `${left}px`;
    modelPickerDropdown.style.display = 'flex';
    modelPickerOverlay.style.display = 'block';

    modelPickerSearch.value = '';
    renderModelPickerList();
    modelPickerSearch.focus();

    fetchModelsForPicker();
}

// --- AST_EXPORTS_START ---
window.showModelPicker = showModelPicker;
// --- AST_EXPORTS_END ---

// --- showModelPickerWidget.js ---
function showModelPickerWidget(line) {
    if (!monacoEditor || !MONACO) return;

    if (_modelPickerWidget) {
        monacoEditor.removeContentWidget(_modelPickerWidget);
        _modelPickerWidget = null;
    }

    const model = monacoEditor.getModel();
    if (!model) return;

    const lineContent = model.getLineContent(line);
    if (getModelValueEndPosition(lineContent) === null) return;

    const widgetLine = line;
    const widgetCol = model.getLineMaxColumn(widgetLine);
    const widgetLineContent = lineContent;

    _modelPickerWidget = {
        suppressMouseDown: true,
        getId: () => 'agent.modelPickerWidget',
        getDomNode: () => {
            const node = document.createElement('span');
            node.className = 'inline-model-picker-btn';
            node.innerHTML = '<span class="icon" style="font-size:10px;color:var(--primary);margin-right:2px;">search</span><span style="font-size:9px;color:var(--primary);font-weight:600;">Models</span>';
            node.title = 'Browse models from API';
            node.style.cursor = 'pointer';
            node.style.display = 'inline-flex';
            node.style.alignItems = 'center';
            node.style.justifyContent = 'center';
            node.style.padding = '0 5px';
            node.style.marginLeft = '8px';
            node.style.verticalAlign = 'middle';
            node.style.whiteSpace = 'nowrap';
            node.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const currentValue = getModelValueFromLine(widgetLineContent);
                const modelInfo = findModelInfoForLine(state.currentEditorPath, widgetLine);

                const editorDom = monacoEditor.getDomNode();
                if (!editorDom) return;
                const editorRect = editorDom.getBoundingClientRect();

                const visiblePos = monacoEditor.getScrolledVisiblePosition({
                    lineNumber: widgetLine,
                    column: widgetCol
                });

                if (visiblePos) {
                    showModelPicker(widgetLine, widgetCol, {
                        top: editorRect.top + visiblePos.top,
                        left: editorRect.left + visiblePos.left
                    }, currentValue, modelInfo);
                } else {
                    showModelPicker(widgetLine, widgetCol, {
                        top: editorRect.top + 100,
                        left: editorRect.left + 200
                    }, currentValue, modelInfo);
                }
            });
            return node;
        },
        getPosition: () => ({
            position: { lineNumber: widgetLine, column: widgetCol },
            preference: [MONACO.editor.ContentWidgetPositionPreference.EXACT]
        })
    };

    monacoEditor.addContentWidget(_modelPickerWidget);
}

// --- AST_EXPORTS_START ---
window.showModelPickerWidget = showModelPickerWidget;
// --- AST_EXPORTS_END ---

// --- wireModelsDetailEvents.js ---
function wireModelsDetailEvents() {
    const pi = _mmSelectedIdx;

    // Provider name (lives in the title input now)
    const titleInput = mmDetailEl.querySelector('.mm-detail-title-input');
    titleInput.addEventListener('change', () => {
        MODEL_PROVIDERS[pi].provider = titleInput.value;
        commitModelsChange();
        renderModelsModal(); // refresh the left-pane label too
    });

    // Other provider-level fields (url, key, useProxy)
    mmDetailEl.querySelectorAll('.mm-row input[data-field]').forEach(inp => {
        inp.addEventListener('change', () => {
            const field = inp.getAttribute('data-field');
            MODEL_PROVIDERS[pi][field] = inp.type === 'checkbox' ? inp.checked : inp.value;
            commitModelsChange();
        });
    });

    // Show/hide API key
    const keyToggle = mmDetailEl.querySelector('.mm-key-toggle');
    if (keyToggle) {
        keyToggle.addEventListener('click', () => {
            const input = keyToggle.previousElementSibling;
            const icon = keyToggle.querySelector('.icon');
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            icon.textContent = showing ? 'visibility' : 'visibility_off';
        });
    }

    // Model-level field edits (name, context_window)
    mmDetailEl.querySelectorAll('.mm-model-row input[data-field]').forEach(inp => {
        inp.addEventListener('change', () => {
            const row = inp.closest('.mm-model-row');
            const mi = Number(row.getAttribute('data-mi'));
            const field = inp.getAttribute('data-field');

            // Capture the old value BEFORE mutating, so we can re-key localStorage on rename.
            const oldValue = field === 'name' ? (MODEL_PROVIDERS[pi].models[mi].name || '') : null;

            if (field === 'context_window') {
                const n = parseInt(inp.value, 10);
                if (inp.value.trim() === '') delete MODEL_PROVIDERS[pi].models[mi].context_window;
                else MODEL_PROVIDERS[pi].models[mi].context_window = Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXT_WINDOW;
            } else {
                MODEL_PROVIDERS[pi].models[mi][field] = inp.value;
            }

            // Re-key localStorage when a model name changes and the selected model was that model.
            if (field === 'name' && oldValue && oldValue !== inp.value) {
                const stored = localStorage.getItem('selected_model');
                const oldKey = `${MODEL_PROVIDERS[pi].provider}::${oldValue}`;
                if (stored === oldKey) {
                    localStorage.setItem('selected_model', `${MODEL_PROVIDERS[pi].provider}::${inp.value}`);
                }
            }

            commitModelsChange();
            if (field === 'name') renderModelsModal(); // refresh model count badge on the left
        });
    });

    // Toggle vision capability for a model
    mmDetailEl.querySelectorAll('.mm-model-vision-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mi = Number(btn.closest('.mm-model-row').getAttribute('data-mi'));
            const model = MODEL_PROVIDERS[pi].models[mi];
            model.vision = !normalizeVisionFlag(model.vision);
            commitModelsChange();
            renderModelsModal();
        });
    });

    // Remove a single model
    mmDetailEl.querySelectorAll('.mm-model-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mi = Number(btn.closest('.mm-model-row').getAttribute('data-mi'));
            const removedName = (MODEL_PROVIDERS[pi].models[mi] && MODEL_PROVIDERS[pi].models[mi].name) || '';
            MODEL_PROVIDERS[pi].models.splice(mi, 1);
            if (removedName) {
                const stored = localStorage.getItem('selected_model');
                if (stored === `${MODEL_PROVIDERS[pi].provider}::${removedName}`) {
                    localStorage.removeItem('selected_model');
                }
            }
            commitModelsChange();
            renderModelsModal();
        });
    });

    // Browse models from the provider's API and fill the name field
    mmDetailEl.querySelectorAll('.mm-model-search-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const mi = Number(btn.closest('.mm-model-row').getAttribute('data-mi'));
            const provider = MODEL_PROVIDERS[pi];
            const currentName = (provider.models[mi] && provider.models[mi].name) || '';
            const modelInfo = { label: currentName, url: provider.url || '', key: provider.key || '', useProxy: !!provider.useProxy };

            const btnRect = btn.getBoundingClientRect();
            showModelPicker(null, null, { top: btnRect.bottom, left: btnRect.left }, currentName, modelInfo, (modelId) => {
                if (modelId !== currentName) {
                    const oldKey = `${provider.provider}::${currentName}`;
                    const stored = localStorage.getItem('selected_model');
                    if (stored === oldKey) {
                        localStorage.setItem('selected_model', `${provider.provider}::${modelId}`);
                    }
                }
                MODEL_PROVIDERS[pi].models[mi].name = modelId;
                commitModelsChange();
                renderModelsModal();
            });
        });
    });

    // Add a model to the selected provider
    const addModelBtn = mmDetailEl.querySelector('.mm-add-model-btn');
    if (addModelBtn) {
        addModelBtn.addEventListener('click', () => {
            MODEL_PROVIDERS[pi].models = MODEL_PROVIDERS[pi].models || [];
            const newIdx = MODEL_PROVIDERS[pi].models.length;
            MODEL_PROVIDERS[pi].models.push({ name: '', context_window: DEFAULT_CONTEXT_WINDOW, vision: false });
            commitModelsChange();
            renderModelsModal(`.mm-model-row[data-mi="${newIdx}"] .mm-model-name`);
        });
    }

    // Remove the whole provider
    const removeBtn = mmDetailEl.querySelector('.mm-remove-provider-btn');
    removeBtn.addEventListener('click', async () => {
        const name = MODEL_PROVIDERS[pi].provider || 'this provider';
        if (!await confirmDialog(`Remove "${name}" and all its models?`, { confirmLabel: 'Remove', danger: true })) return;
        MODEL_PROVIDERS.splice(pi, 1);
        modelsModalEl.classList.remove('mm-detail-open');
        if (_mmSelectedIdx >= MODEL_PROVIDERS.length) _mmSelectedIdx = MODEL_PROVIDERS.length - 1;
        commitModelsChange();
        renderModelsModal();
    });
}

// --- AST_EXPORTS_START ---
window.wireModelsDetailEvents = wireModelsDetailEvents;
// --- AST_EXPORTS_END ---
