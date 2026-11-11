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
            displayName: entry.displayName || shortenModelName(entry.name)
        }
        : {
            url: '',
            model: '',
            key: '',
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            vision: false,
            useProxy: false,
            providerName: '',
            displayName: 'No model'
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
window.saveModels = saveModels;
window.isValidProvidersShape = isValidProvidersShape;
window.normalizeVisionFlag = normalizeVisionFlag;
window.getAllModelEntries = getAllModelEntries;
window.findModelEntry = findModelEntry;
window.findModelEntryById = findModelEntryById;
window.getSelectedModelKey = getSelectedModelKey;
window.setSelectedModel = setSelectedModel;
window.renderModelDropdown = renderModelDropdown;
window.getCurrentModelInfo = getCurrentModelInfo;
window.currentModelHasVision = currentModelHasVision;
window.applyVisionCapabilityToUI = applyVisionCapabilityToUI;
window.shortenModelName = shortenModelName;
window.fetchActiveModelName = fetchActiveModelName;
window.findModelEntryFlexible = findModelEntryFlexible;
window.ensureModelAndUISynced = ensureModelAndUISynced;
window.verifyActiveModelEndpoint = verifyActiveModelEndpoint;
// --- AST_EXPORTS_END ---