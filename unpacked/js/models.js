function seedDefaultModels() {
    // Flat array of providers (url/key + models). A model's `name` is its API id; `vision: true` enables image input and vision-only tools.
    return [
        {
            provider: "Llama.cpp (local:8888)",
            url: "http://127.0.0.1:8888/v1",
            key: "",
            models: [
                { name: "llama", context_window: DEFAULT_CONTEXT_WINDOW }
            ]
        },
        {
            provider: "LM Studio (local:1234)",
            url: "http://127.0.0.1:1234/v1",
            key: "",
            models: [
                { name: "local-model", context_window: DEFAULT_CONTEXT_WINDOW }
            ]
        },
    ];
}

// Pretty-prints providers with one compact line per model.
function modelsFileContent() {
    const indentProvider = '  ';
    const indentModel = '    ';
    const indentModelBody = '      ';

    const compactModel = (m) => '{' + Object.keys(m).map(k => `${JSON.stringify(k)}: ${JSON.stringify(m[k])}`).join(', ') + '}';

    const providerLines = MODEL_PROVIDERS.map(p => {
        const modelLines = (p.models || []).map(m => indentModelBody + compactModel(m)).join(',\n');
        const otherKeys = Object.keys(p).filter(k => k !== 'models');
        const headerLines = otherKeys.map(k => `${indentModel}${JSON.stringify(k)}: ${JSON.stringify(p[k])}`).join(',\n');
        return `${indentProvider}{\n${headerLines},\n${indentModel}"models": [\n${modelLines}\n${indentModel}]\n${indentProvider}}`;
    }).join(',\n');

    return `[\n${providerLines}\n]\n`;
}

function registerModelsVirtualFile() {
    const text = modelsFileContent();
    registry.files[MODELS_FILE] = text;
    registry.meta[CUSTOM_TOOLS_DIR] = { kind: 'directory' };
    registry.meta[MODELS_FILE] = { kind: 'file', size: text.length, isBinary: false, virtual: true };
}

function newModelUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Assigns a UUID to every model that lacks a valid, unique one. Returns true if anything changed.
function ensureModelUuids() {
    if (!Array.isArray(MODEL_PROVIDERS)) return false;
    const seen = new Set();
    let changed = false;
    MODEL_PROVIDERS.forEach(p => (p.models || []).forEach(m => {
        let id = (typeof m.uuid === 'string' && MODEL_UUID_RE.test(m.uuid)) ? m.uuid.toLowerCase() : '';
        if (!id || seen.has(id)) id = newModelUuid();
        if (m.uuid !== id) { m.uuid = id; changed = true; }
        seen.add(id);
    }));
    return changed;
}

function reloadModelsFromStorage() {
    let raw = null;
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) raw = localStorage.getItem(`models_${wsKey}`);
    }
    if (!raw) raw = localStorage.getItem('models_json');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (isValidProvidersShape(parsed)) {
                MODEL_PROVIDERS = parsed;
                window.MODEL_PROVIDERS = parsed;
                ensureModelUuids();
            }
        } catch (e) {}
    }
    registerModelsVirtualFile();
    renderModelDropdown();
}

function saveModels() {
    ensureModelUuids();
    localStorage.setItem('models_json', JSON.stringify(MODEL_PROVIDERS));
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) localStorage.setItem(`models_${wsKey}`, JSON.stringify(MODEL_PROVIDERS));
    }
    registerModelsVirtualFile();
    writeAgentFileToDisk(MODELS_FILE, modelsFileContent());
}

// Accepts only an array of { provider, url, models: [{name, ...}] }; anything else falls back to defaults.
function isValidProvidersShape(data) {
    return Array.isArray(data) && data.every(p =>
        p && typeof p === 'object' &&
        typeof p.provider === 'string' &&
        Array.isArray(p.models) &&
        p.models.every(m => m && typeof m === 'object' && typeof m.name === 'string')
    );
}

// Vision is opt-in: only `true` (or "true"/"1"/"yes" strings from hand-edited JSON) enables it.
function normalizeVisionFlag(v) {
    if (v === true) return true;
    if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
    return false;
}

// Flattens providers into model entries, keyed by (providerName, modelName).
function getAllModelEntries() {
    const out = [];
    if (!Array.isArray(MODEL_PROVIDERS)) return out;
    MODEL_PROVIDERS.forEach(p => {
        (p.models || []).forEach(m => {
            const rawName = m.name || '';
            const uuid = (typeof m.uuid === 'string' ? m.uuid.toLowerCase() : '');
            out.push({
                id: uuid || `${p.provider || ''}::${rawName}`,
                uuid: uuid,
                providerName: p.provider || 'Unknown provider',
                name: rawName,
                displayName: shortenModelName(rawName),
                url: p.url || '',
                key: p.key || '',
                contextWindow: Number(m.context_window) > 0 ? Number(m.context_window) : DEFAULT_CONTEXT_WINDOW,
                vision: normalizeVisionFlag(m.vision),
                useProxy: !!p.useProxy
            });
        });
    });
    return out;
}

const _modelsEndpointCache = (typeof window._modelsEndpointCache !== 'undefined') ? window._modelsEndpointCache : (window._modelsEndpointCache = {});

function findModelEntry(providerName, modelName) {
    return getAllModelEntries().find(e => e.providerName === providerName && e.name === modelName) || null;
}

// Flexible matcher that handles exact match, case-insensitivity, displayName, shortened model
// filename, or partial provider name (e.g. host:port matching).
function findModelEntryFlexible(providerName, modelName) {
    if (!providerName && !modelName) return null;
    const all = getAllModelEntries();
    if (!all.length) return null;

    const pNorm = (providerName || '').trim().toLowerCase();
    const mNorm = (modelName || '').trim().toLowerCase();

    // 1. Exact match
    let match = all.find(e => e.providerName === providerName && e.name === modelName);
    if (match) return match;

    // 2. Case-insensitive match on both
    if (pNorm && mNorm) {
        match = all.find(e => e.providerName.toLowerCase() === pNorm && e.name.toLowerCase() === mNorm);
        if (match) return match;
    }

    // 3. Match provider and displayName or shortened model name
    if (pNorm && mNorm) {
        match = all.find(e => {
            const pMatch = e.providerName.toLowerCase() === pNorm;
            const dNorm = (e.displayName || '').toLowerCase();
            const sNorm = shortenModelName(e.name).toLowerCase();
            return pMatch && (dNorm === mNorm || sNorm === mNorm);
        });
        if (match) return match;
    }

    // 4. Loose provider match (substring / URL) with model match
    if (pNorm && mNorm) {
        match = all.find(e => {
            const pMatch = e.providerName.toLowerCase().includes(pNorm) || pNorm.includes(e.providerName.toLowerCase()) || (e.url && pNorm.includes(e.url.toLowerCase()));
            const mMatch = e.name.toLowerCase() === mNorm || (e.displayName || '').toLowerCase() === mNorm || shortenModelName(e.name).toLowerCase() === mNorm;
            return pMatch && mMatch;
        });
        if (match) return match;
    }

    // 5. UUID or id match
    if (mNorm) {
        match = findModelEntryById(modelName);
        if (match) return match;
    }

    // 6. Model name match across any provider
    if (mNorm) {
        match = all.find(e => e.name.toLowerCase() === mNorm || (e.displayName || '').toLowerCase() === mNorm || shortenModelName(e.name).toLowerCase() === mNorm);
        if (match) return match;
    }

    // 7. Provider match fallback (first model of matching provider)
    if (pNorm) {
        match = all.find(e => e.providerName.toLowerCase() === pNorm || e.providerName.toLowerCase().includes(pNorm) || pNorm.includes(e.providerName.toLowerCase()));
        if (match) return match;
    }

    return null;
}

// Resolves a model UUID to its entry. Also accepts the legacy 'Provider::model' id or raw model name so tool settings
// saved before UUIDs existed keep working.
function findModelEntryById(id) {
    const s = String(id || '').trim();
    if (!s) return null;
    const all = getAllModelEntries();
    const byUuid = all.find(e => e.uuid && e.uuid === s.toLowerCase());
    if (byUuid) return byUuid;
    const byId = all.find(e => e.id && e.id.toLowerCase() === s.toLowerCase());
    if (byId) return byId;
    const byName = all.find(e => e.name && e.name.toLowerCase() === s.toLowerCase());
    if (byName) return byName;
    const i = s.indexOf('::');
    if (i === -1) return null;
    return all.find(e => e.providerName === s.slice(0, i) && e.name === s.slice(i + 2)) || null;
}

function getSelectedModelKey() {
    let stored = null;
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) stored = localStorage.getItem(`selected_model_${wsKey}`);
    }
    if (!stored) {
        stored = localStorage.getItem('selected_model');
    }
    const entries = getAllModelEntries();
    if (stored) {
        const sepIdx = stored.indexOf('::');
        if (sepIdx !== -1) {
            const providerName = stored.slice(0, sepIdx);
            const modelName = stored.slice(sepIdx + 2);
            const found = findModelEntryFlexible(providerName, modelName);
            if (found) return { providerName: found.providerName, modelName: found.name };
        }
    }
    return entries.length ? { providerName: entries[0].providerName, modelName: entries[0].name } : null;
}

function setSelectedModel(providerName, modelName) {
    const entry = findModelEntryFlexible(providerName, modelName);
    if (!entry) return;
    const val = `${entry.providerName}::${entry.name}`;
    localStorage.setItem('selected_model', val);
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) localStorage.setItem(`selected_model_${wsKey}`, val);
    }
    if (typeof state !== 'undefined' && state && state.activeSessionId && state.sessions && state.sessions[state.activeSessionId]) {
        state.sessions[state.activeSessionId].selectedModel = { providerName: entry.providerName, modelName: entry.name };
    }
    renderModelDropdown();
}

function renderModelDropdown() {
    const nameEl = document.getElementById('msb-name');
    const providerEl = document.getElementById('msb-provider');
    if (!nameEl || !providerEl) return;
    const sel = getSelectedModelKey();
    const entry = sel && findModelEntryFlexible(sel.providerName, sel.modelName);
    nameEl.textContent = entry ? (entry.displayName || shortenModelName(entry.name)) : 'No model';
    providerEl.textContent = entry ? entry.providerName : '';

    const btn = document.getElementById('model-select-btn');
    if (btn && entry) {
        btn.setAttribute('data-provider-name', entry.providerName);
        btn.setAttribute('data-model-name', entry.name);
        btn.title = `${entry.name} (${entry.providerName}) — ${entry.url || 'No URL'}`;
    }

    if (typeof _modelSelectState !== 'undefined' && _modelSelectState.visible) renderModelSelectList();
    applyVisionCapabilityToUI();
    renderEffortDropdown();
}

// --- Reasoning effort (thinking level) ---
const REASONING_EFFORTS = ['Default', 'Off', 'Minimal', 'Low', 'Medium', 'High', 'Max'];

// Per-workspace persisted thinking level. Same keying as the model selection:
// a plain `reasoning_effort` fallback plus `reasoning_effort_<wsKey>` for WebDAV workspaces.
function getReasoningEffort() {
    let stored = null;
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) stored = localStorage.getItem(`reasoning_effort_${wsKey}`);
    }
    if (!stored) stored = localStorage.getItem('reasoning_effort');
    if (REASONING_EFFORTS.includes(stored)) return stored;
    // Also accept discovered levels (e.g. "xhigh") if the active model's capability
    // list includes them, matching case-insensitively. (Uses the primitive lookup,
    // NOT getCurrentModelInfo — which itself calls getReasoningEffort.)
    let activeModel = null;
    try {
        const sel = getSelectedModelKey();
        activeModel = sel ? findModelEntryFlexible(sel.providerName, sel.modelName) : null;
    } catch (_) {}
    const supported = activeModel ? getSupportedEfforts(activeModel.providerName, activeModel.name) : null;
    const norm = typeof stored === 'string' ? stored.trim().toLowerCase() : '';
    if (supported && supported.includes(norm)) {
        return norm.charAt(0).toUpperCase() + norm.slice(1);
    }
    return 'Default';
}

function setReasoningEffort(value) {
    const valid = REASONING_EFFORTS.includes(value)
        || (typeof getEffortOptions === 'function' && getEffortOptions().options.some(o => o.value === value && o.available));
    if (!valid) value = 'Default';
    localStorage.setItem('reasoning_effort', value);
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) localStorage.setItem(`reasoning_effort_${wsKey}`, value);
    }
    renderEffortDropdown();
}

// Wire value for the request body: 'Default' sends nothing, otherwise the lowercase value ('' also means omit).
function getReasoningEffortWireValue() {
    const v = getReasoningEffort();
    return v === 'Default' ? '' : v.toLowerCase();
}

// Known per-model capability lists, learned from "supported levels: ..." errors.
// localStorage `reasoning_effort_caps`: { "Provider::model": ["low","medium","xhigh"] }
const EFFORT_RANKS = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

function getEffortCaps() {
    try {
        const raw = localStorage.getItem('reasoning_effort_caps');
        const obj = raw ? JSON.parse(raw) : {};
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
}

function getSupportedEfforts(providerName, modelName) {
    const list = getEffortCaps()[`${providerName || ''}::${modelName || ''}`];
    return Array.isArray(list) && list.length ? list : null;
}

function setSupportedEfforts(providerName, modelName, levels) {
    const caps = getEffortCaps();
    caps[`${providerName || ''}::${modelName || ''}`] = levels;
    localStorage.setItem('reasoning_effort_caps', JSON.stringify(caps));
}

function clearSupportedEfforts(providerName, modelName) {
    const caps = getEffortCaps();
    const key = `${providerName || ''}::${modelName || ''}`;
    if (key in caps) {
        delete caps[key];
        localStorage.setItem('reasoning_effort_caps', JSON.stringify(caps));
        return true;
    }
    return false;
}

// Dropdown options for the active model: the base list plus any discovered levels,
// each flagged available per the model's known capability list.
function getEffortOptions() {
    const info = (typeof getCurrentModelInfo === 'function') ? getCurrentModelInfo() : {};
    const supported = getSupportedEfforts(info.providerName, info.model);
    const options = REASONING_EFFORTS.map(v => ({
        value: v,
        available: !supported || v === 'Default' || supported.includes(v.toLowerCase())
    }));
    if (supported) {
        supported.forEach(s => {
            if (!REASONING_EFFORTS.some(v => v.toLowerCase() === s)) {
                options.push({ value: s.charAt(0).toUpperCase() + s.slice(1), available: true });
            }
        });
    }
    return { options, supported };
}

// Nearest supported level by rank distance, or null if no ranking is possible.
function closestSupportedEffort(value, supported) {
    const cur = String(value || '').toLowerCase();
    if (supported.includes(cur)) return cur;
    const rank = EFFORT_RANKS[cur];
    if (rank === undefined) return null;
    let best = null, bestDiff = Infinity;
    supported.forEach(s => {
        const r = EFFORT_RANKS[s];
        if (r === undefined) return;
        const diff = Math.abs(r - rank);
        if (diff < bestDiff) { best = s; bestDiff = diff; }
    });
    return best;
}

// Called from the chat runner when a model rejects the current reasoning_effort.
// Records the model's supported levels and reverts the selection to the closest
// supported level (or 'Default') so the automatic retry sends a valid value.
function handleReasoningEffortError(message, providerName, modelName) {
    const m = /supported levels:\s*([a-zA-Z][a-zA-Z]*(?:\s*,\s*[a-zA-Z][a-zA-Z]*)*)/.exec(String(message || ''));
    if (!m) return false;
    const supported = [...new Set(m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
    if (!supported.length) return false;
    setSupportedEfforts(providerName, modelName, supported);
    const current = getReasoningEffort();
    if (current !== 'Default' && !supported.includes(current.toLowerCase())) {
        const fallback = closestSupportedEffort(current, supported) || 'Default';
        setReasoningEffort(fallback);
        if (typeof showToast === 'function') {
            showToast(`Model ${shortenModelName(modelName) || modelName} supports: ${supported.join(', ')} — thinking level set to ${fallback}`, 'info');
        }
    }
    renderEffortDropdown();
    return true;
}

function renderEffortDropdown() {
    const nameEl = document.getElementById('esb-name');
    const iconEl = document.getElementById('esb-icon');
    const btn = document.getElementById('effort-select-btn');
    if (!nameEl) return;
    let value = getReasoningEffort();
    // If the active model is known not to support the current level, revert to the
    // closest supported one (or Default) so the button always reflects what will be sent.
    const info = (typeof getCurrentModelInfo === 'function') ? getCurrentModelInfo() : {};
    const supported = getSupportedEfforts(info.providerName, info.model);
    if (supported && value !== 'Default' && !supported.includes(value.toLowerCase())) {
        const fallback = closestSupportedEffort(value, supported) || 'Default';
        setReasoningEffort(fallback);
        return; // setReasoningEffort re-renders with the now-valid value
    }
    nameEl.textContent = value;
    // Wide screen: "Default" shows as text, other levels show the lightbulb icon
    // only. When the pane is compact (mobile-overrides.css / .prompt-narrow) the
    // CSS forces the icon with !important, overriding the inline display below.
    if (iconEl) iconEl.style.display = value === 'Default' ? 'none' : '';
    if (nameEl) nameEl.style.display = value === 'Default' ? '' : 'none';
    if (btn) {
        btn.title = value === 'Default'
            ? 'Thinking level: model default'
            : `Thinking level: ${value} (sent as reasoning_effort: ${value.toLowerCase()})`;
    }
    if (typeof _effortSelectState !== 'undefined' && _effortSelectState.visible) renderEffortSelectList();
}

function getCurrentModelInfo(sessionId) {
    const sid = sessionId || (typeof state !== 'undefined' && state ? state.activeSessionId : null);
    let sel = null;

    // 1. If the target session has an explicitly saved selectedModel, check it
    if (sid && typeof state !== 'undefined' && state.sessions && state.sessions[sid] && state.sessions[sid].selectedModel) {
        const sm = state.sessions[sid].selectedModel;
        sel = findModelEntryFlexible(sm.providerName, sm.modelName);
    }

    // 2. Cross-check against the active UI button labels to guarantee that prompt
    // execution matches what the user sees highlighted in the prompt bar
    if (!sel) {
        const btn = document.getElementById('model-select-btn');
        const nameEl = document.getElementById('msb-name');
        const providerEl = document.getElementById('msb-provider');
        const btnProv = btn ? btn.getAttribute('data-provider-name') : null;
        const btnMod = btn ? btn.getAttribute('data-model-name') : null;

        if (btnProv && btnMod) {
            sel = findModelEntryFlexible(btnProv, btnMod);
        }
        if (!sel && nameEl && providerEl) {
            const uiName = nameEl.textContent.trim();
            const uiProv = providerEl.textContent.trim();
            if (uiName && uiName !== 'No model') {
                sel = findModelEntryFlexible(uiProv, uiName);
            }
        }
    }

    // 3. Fallback to persisted selected_model key
    if (!sel) {
        const storedKey = getSelectedModelKey();
        sel = storedKey && findModelEntryFlexible(storedKey.providerName, storedKey.modelName);
    }

    const entry = sel || (getAllModelEntries().length ? getAllModelEntries()[0] : null);
    return entry
        ? {
            url: entry.url,
            model: entry.name,
            key: entry.key,
            contextWindow: entry.contextWindow,
            vision: entry.vision,
            useProxy: !!entry.useProxy,
            providerName: entry.providerName,
            displayName: entry.displayName || shortenModelName(entry.name),
            reasoningEffort: getReasoningEffort()
        }
        : {
            url: '',
            model: '',
            key: '',
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            vision: false,
            useProxy: false,
            providerName: '',
            displayName: 'No model',
            reasoningEffort: getReasoningEffort()
        };
}

// Bi-directional synchronizer that ensures session state, memory, localStorage, and
// the main UI button/dropdown display strictly refer to the exact same LLM model and endpoint.
function ensureModelAndUISynced(sessionId) {
    const sid = sessionId || (typeof state !== 'undefined' && state ? state.activeSessionId : null);
    const all = getAllModelEntries();
    if (!all.length) return null;

    let targetEntry = null;

    // A. Inspect UI button content first to give precedence to what is visibly highlighted
    const btn = document.getElementById('model-select-btn');
    const nameEl = document.getElementById('msb-name');
    const providerEl = document.getElementById('msb-provider');
    const btnProv = btn ? btn.getAttribute('data-provider-name') : null;
    const btnMod = btn ? btn.getAttribute('data-model-name') : null;

    if (btnProv && btnMod) {
        targetEntry = findModelEntryFlexible(btnProv, btnMod);
    }
    if (!targetEntry && nameEl && providerEl) {
        const uiName = nameEl.textContent.trim();
        const uiProv = providerEl.textContent.trim();
        if (uiName && uiName !== 'No model') {
            targetEntry = findModelEntryFlexible(uiProv, uiName);
        }
    }

    // B. Check session's explicitly saved selectedModel
    if (!targetEntry && sid && typeof state !== 'undefined' && state.sessions && state.sessions[sid] && state.sessions[sid].selectedModel) {
        const sm = state.sessions[sid].selectedModel;
        targetEntry = findModelEntryFlexible(sm.providerName, sm.modelName);
    }

    // C. Fallback to stored selection key or first entry
    if (!targetEntry) {
        const sel = getSelectedModelKey();
        targetEntry = (sel && findModelEntryFlexible(sel.providerName, sel.modelName)) || all[0];
    }

    // Re-align storage and session with canonical model metadata
    const val = `${targetEntry.providerName}::${targetEntry.name}`;
    localStorage.setItem('selected_model', val);
    if (typeof rootHandle !== 'undefined' && rootHandle && rootHandle.isWebDAV && typeof wsStorageName === 'function') {
        const wsKey = wsStorageName(rootHandle);
        if (wsKey) localStorage.setItem(`selected_model_${wsKey}`, val);
    }

    if (sid && typeof state !== 'undefined' && state.sessions && state.sessions[sid]) {
        state.sessions[sid].selectedModel = {
            providerName: targetEntry.providerName,
            modelName: targetEntry.name
        };
    }

    renderModelDropdown();
    verifyActiveModelEndpoint(targetEntry);
    return targetEntry;
}

// Non-blocking query to local endpoints (llama.cpp, LM Studio, etc.) verifying that
// the served endpoint is active and alive.
async function verifyActiveModelEndpoint(entry) {
    if (!entry || !entry.url) return;
    const isLocal = entry.url.includes('127.0.0.1') || entry.url.includes('localhost');
    if (!isLocal) return;
    try {
        fetchActiveModelName(entry.url, entry.key, entry.name, entry.useProxy).then(activeName => {
            if (activeName) {
                const btn = document.getElementById('model-select-btn');
                if (btn) {
                    btn.title = `${entry.name} (${entry.providerName}) — Active: ${activeName} (${entry.url})`;
                }
            }
        }).catch(() => {});
    } catch (_) {}
}

// True when the currently selected model is configured with vision (image input) support.
function currentModelHasVision() {
    return !!getCurrentModelInfo().vision;
}

// Keeps everything that depends on the selected model's vision capability in sync: the attach
// menu's "Images" entry, any image chips already staged in the prompt, and the tool list badges.
// Call after any change to the selected model or to models.json.
function applyVisionCapabilityToUI() {
    const hasVision = currentModelHasVision();

    const imageItem = document.querySelector('#attach-menu .attach-menu-item[data-attach-type="image"]');
    if (imageItem) imageItem.style.display = hasVision ? '' : 'none';

    if (!hasVision && Array.isArray(state.attachedReferences)) {
        const before = state.attachedReferences.length;
        state.attachedReferences = state.attachedReferences.filter(ref => ref.type !== 'image');
        const dropped = before - state.attachedReferences.length;
        if (dropped > 0) {
            renderAttachmentChips();
        }
    }

    // Only re-render the tool list once its container exists (it doesn't during early startup).
    if (document.getElementById('tools-list')) renderToolsList();
}

function shortenModelName(name) {
    if (!name) return name;
    const isPath = name.includes('/') || name.includes('\\');
    if (!isPath) return name;
    const base = name.split(/[\\/]/).pop() || name;
    return base.replace(/\.(gguf|bin|safetensors)$/i, '');
}

async function fetchActiveModelName(apiUrl, apiKey, fallbackModel, useProxy = false) {
    if (!apiUrl) return fallbackModel || '';
    const cacheKey = `${apiUrl}::${apiKey || ''}`;
    const cached = _modelsEndpointCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < 60000) {
        return cached.name || fallbackModel || '';
    }
    try {
        const headers = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        
        const targetUrl = `${apiUrl}/models`;
        const reqUrl = useProxy ? '/proxy' : targetUrl;
        if (useProxy) headers["x-proxy-target"] = targetUrl;
        
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const resp = await fetch(reqUrl, { headers, signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const list = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
        let name = fallbackModel || '';
        if (list.length) {
            const match = list.find(m => m.id === fallbackModel || m.name === fallbackModel);
            name = (match && (match.id || match.name)) || list[0].id || list[0].name || fallbackModel || '';
        }
        name = shortenModelName(name);
        _modelsEndpointCache[cacheKey] = { name, ts: Date.now() };
        return name;
    } catch (e) {
        _modelsEndpointCache[cacheKey] = { name: fallbackModel || '', ts: Date.now() };
        return fallbackModel || '';
    }
}

// --- AST_EXPORTS_START ---
window.seedDefaultModels = seedDefaultModels;
window.modelsFileContent = modelsFileContent;
window.registerModelsVirtualFile = registerModelsVirtualFile;
window.newModelUuid = newModelUuid;
window.ensureModelUuids = ensureModelUuids;
window.reloadModelsFromStorage = reloadModelsFromStorage;
window.saveModels = saveModels;
window.isValidProvidersShape = isValidProvidersShape;
window.normalizeVisionFlag = normalizeVisionFlag;
window.getAllModelEntries = getAllModelEntries;
window.findModelEntry = findModelEntry;
window.findModelEntryById = findModelEntryById;
window.getSelectedModelKey = getSelectedModelKey;
window.setSelectedModel = setSelectedModel;
window.renderModelDropdown = renderModelDropdown;
window.REASONING_EFFORTS = REASONING_EFFORTS;
window.getReasoningEffort = getReasoningEffort;
window.setReasoningEffort = setReasoningEffort;
window.getReasoningEffortWireValue = getReasoningEffortWireValue;
window.getSupportedEfforts = getSupportedEfforts;
window.setSupportedEfforts = setSupportedEfforts;
window.clearSupportedEfforts = clearSupportedEfforts;
window.getEffortOptions = getEffortOptions;
window.closestSupportedEffort = closestSupportedEffort;
window.handleReasoningEffortError = handleReasoningEffortError;
window.renderEffortDropdown = renderEffortDropdown;
window.getCurrentModelInfo = getCurrentModelInfo;
window.currentModelHasVision = currentModelHasVision;
window.applyVisionCapabilityToUI = applyVisionCapabilityToUI;
window.shortenModelName = shortenModelName;
window.fetchActiveModelName = fetchActiveModelName;
window.findModelEntryFlexible = findModelEntryFlexible;
window.ensureModelAndUISynced = ensureModelAndUISynced;
window.verifyActiveModelEndpoint = verifyActiveModelEndpoint;
// --- AST_EXPORTS_END ---