let activeWorkspaceToolsConfig = null;

function getWorkspaceToolsKey() {
    if (window.rootHandle && typeof window.wsStorageName === 'function') {
        return window.wsStorageName(window.rootHandle);
    }
    return null;
}

function getWorkspaceToolsConfig() {
    if (!activeWorkspaceToolsConfig) {
        const wsKey = getWorkspaceToolsKey();
        if (wsKey) {
            activeWorkspaceToolsConfig = loadWorkspaceToolsState(wsKey);
        } else {
            activeWorkspaceToolsConfig = typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {};
        }
    }
    return activeWorkspaceToolsConfig;
}

function setWorkspaceToolsConfig(cfg) {
    activeWorkspaceToolsConfig = (cfg && typeof cfg === 'object')
        ? cfg
        : (typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {});
    if (typeof window.registerToolsVirtualFile === 'function') {
        window.registerToolsVirtualFile();
    }
}

function loadWorkspaceToolsState(wsKey) {
    const key = wsKey || getWorkspaceToolsKey();
    const lsKey = key ? `tools_config_${key}` : 'tools_config_default';
    try {
        const raw = localStorage.getItem(lsKey);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        }
    } catch (e) {}
    return typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {};
}

function saveWorkspaceToolsState(wsKey, config) {
    const key = wsKey || getWorkspaceToolsKey();
    const cfg = config || getWorkspaceToolsConfig();
    const lsKey = key ? `tools_config_${key}` : 'tools_config_default';
    try {
        localStorage.setItem(lsKey, JSON.stringify(cfg));
    } catch (e) {}
    if (typeof window.writeAgentFileToDisk === 'function') {
        const isWebDav = window.rootHandle && window.rootHandle.isWebDAV;
        const syncDisabled = isWebDav && window.AppConfig && window.AppConfig.get('webdav-sync-agent') !== 'true';
        if (!syncDisabled) {
            window.writeAgentFileToDisk(TOOLS_FILE, JSON.stringify(cfg, null, 2) + '\n');
        }
    }
    if (typeof window.registerToolsVirtualFile === 'function') {
        window.registerToolsVirtualFile();
    }
}

function resetToolRegistry() {
    const seeded = seedBuiltinToolSources();
    if (window.registry && window.registry.files && window.registry.meta) {
        Object.keys(window.registry.files).forEach(fp => {
            if (fp.startsWith(TOOLS_DIR + '/') && fp.endsWith('.js')) {
                const fileName = fp.slice((TOOLS_DIR + '/').length, -3);
                if (!BUILTIN_TOOL_NAMES.includes(fileName)) {
                    delete window.registry.files[fp];
                    delete window.registry.meta[fp];
                }
            }
        });
        BUILTIN_TOOL_NAMES.forEach(name => {
            const fp = toolFilePath(name);
            window.registry.files[fp] = seeded[name] || '';
            window.registry.meta[fp] = { kind: 'file', size: (window.registry.files[fp] || '').length, isBinary: false, virtual: true };
        });
    }
    activeWorkspaceToolsConfig = typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {};
    if (typeof window.registerToolsVirtualFile === 'function') {
        window.registerToolsVirtualFile();
    }
    rebuildToolRegistryFromFiles();
}

async function reconcileWorkspaceTools(diskToolsDirHandle = null) {
    const wsKey = getWorkspaceToolsKey();
    let manifest = null;

    if (window.rootHandle && typeof window.readFileContent === 'function') {
        try {
            const content = await window.readFileContent(TOOLS_FILE);
            if (content && typeof content === 'string') {
                manifest = JSON.parse(content);
            }
        } catch (e) {}
    }

    if (!manifest && wsKey) {
        const raw = localStorage.getItem(`tools_config_${wsKey}`);
        if (raw) {
            try { manifest = JSON.parse(raw); } catch (e) {}
        }
    }

    const defaults = typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {};

    if (manifest && typeof manifest === 'object') {
        manifest = {
            version: manifest.version || 1,
            permissions: { ...defaults.permissions, ...(manifest.permissions || {}) },
            locks: { ...defaults.locks, ...(manifest.locks || {}) },
            models: { ...(manifest.models || {}) },
            settings: { ...(manifest.settings || {}) },
            customTools: Array.isArray(manifest.customTools) ? manifest.customTools : []
        };

        const knownFiles = new Set(manifest.customTools.map(t => t.file || toolFilePath(t.name)));
        if (diskToolsDirHandle && typeof diskToolsDirHandle.entries === 'function') {
            try {
                for await (const [name, handle] of diskToolsDirHandle.entries()) {
                    if (handle.kind === 'file' && name.endsWith('.js')) {
                        const toolName = name.slice(0, -3);
                        if (BUILTIN_TOOL_NAMES.includes(toolName)) continue;
                        const fp = `${TOOLS_DIR}/${name}`;
                        if (!knownFiles.has(fp)) {
                            manifest.customTools.push({ name: toolName, file: fp, enabled: true });
                            if (!manifest.permissions[toolName]) manifest.permissions[toolName] = 'ask';
                            if (manifest.locks[toolName] === undefined) manifest.locks[toolName] = false;
                            knownFiles.add(fp);
                        }
                    }
                }
            } catch (e) {}
        }
        setWorkspaceToolsConfig(manifest);
        saveWorkspaceToolsState(wsKey, manifest);
        return manifest;
    }

    const foundCustom = [];
    if (diskToolsDirHandle && typeof diskToolsDirHandle.entries === 'function') {
        try {
            for await (const [name, handle] of diskToolsDirHandle.entries()) {
                if (handle.kind === 'file' && name.endsWith('.js')) {
                    const toolName = name.slice(0, -3);
                    if (BUILTIN_TOOL_NAMES.includes(toolName)) continue;
                    foundCustom.push({ name: toolName, file: `${TOOLS_DIR}/${name}`, enabled: true });
                }
            }
        } catch (e) {}
    }

    if (foundCustom.length > 0) {
        manifest = {
            ...defaults,
            customTools: foundCustom
        };
        foundCustom.forEach(t => {
            if (!manifest.permissions[t.name]) manifest.permissions[t.name] = 'ask';
            if (manifest.locks[t.name] === undefined) manifest.locks[t.name] = false;
        });
        setWorkspaceToolsConfig(manifest);
        saveWorkspaceToolsState(wsKey, manifest);
        return manifest;
    }

    const cleanDefaults = typeof window.toolsDefaults === 'function' ? window.toolsDefaults() : {};
    setWorkspaceToolsConfig(cleanDefaults);
    saveWorkspaceToolsState(wsKey, cleanDefaults);
    return cleanDefaults;
}

window.getWorkspaceToolsKey = getWorkspaceToolsKey;
window.getWorkspaceToolsConfig = getWorkspaceToolsConfig;
window.setWorkspaceToolsConfig = setWorkspaceToolsConfig;
window.loadWorkspaceToolsState = loadWorkspaceToolsState;
window.saveWorkspaceToolsState = saveWorkspaceToolsState;
window.resetToolRegistry = resetToolRegistry;
window.reconcileWorkspaceTools = reconcileWorkspaceTools;

// --- buildToolFileSource.js ---
function buildToolFileSource(meta, handlerBody) {
    const metaObj = {
        name: meta.name,
        description: meta.description || '',
        parameters: meta.parameters || { type: "object", properties: {} },
        modes: Array.isArray(meta.modes) ? meta.modes : ['plan', 'ask', 'code'],
        permission: ['never', 'ask', 'always'].includes(meta.permission) ? meta.permission : 'ask',
        toolBox: Number(meta.toolBox) === 0 ? 0 : 1,
        settings: Array.isArray(meta.settings) ? meta.settings : undefined,
        interactive: meta.interactive ? true : undefined,
        require_vision: meta.require_vision ? true : undefined
    };
    if (metaObj.settings === undefined) delete metaObj.settings;
    if (metaObj.interactive === undefined) delete metaObj.interactive;
    if (metaObj.require_vision === undefined) delete metaObj.require_vision;
    const metaJson = JSON.stringify(metaObj, null, 4).replace(/\n/g, '\n');
    return `// ${meta.name} - tool definition.
const TOOL_META = ${metaJson};

async function handler(args, api) {
${handlerBody.replace(/\n$/, '')}
}
`;
}

// --- AST_EXPORTS_START ---
window.buildToolFileSource = buildToolFileSource;
// --- AST_EXPORTS_END ---

// --- createToolFile.js ---
function createToolFile(name, sourceOverride) {
    if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return { ok: false, error: 'Tool name must be letters, numbers, or underscore, and cannot start with a number.' };
    if (toolRegistry[name]) return { ok: false, error: `A tool named "${name}" already exists.` };
    let source = sourceOverride;
    if (typeof source !== 'string' || !source.trim()) {
        source = buildToolFileSource({
            name,
            description: 'Describe what this tool does and when the model should use it.',
            parameters: { type: "object", properties: {}, required: [] },
            modes: ['plan', 'ask', 'code'],
            permission: 'ask'
        }, `
    return "Not implemented yet.";
`);
    } else {
        // If the provided source has no TOOL_META (e.g. a plain handler function,
        // possibly with helpers, pasted/dropped without the wrapper), wrap it so
        // it's a valid tool file rather than nesting it inside another handler.
        const meta = parseToolMeta(source);
        if (!meta || !meta.name) {
            const metaObj = {
                name,
                description: 'Describe what this tool does and when the model should use it.',
                parameters: { type: "object", properties: {}, required: [] },
                modes: ['plan', 'ask', 'code'],
                permission: 'ask',
                toolBox: 1
            };
            const metaJson = JSON.stringify(metaObj, null, 4);
            const hasHandler = /(?:^|\W)(?:async\s+)?function\s+handler\s*\(/.test(source);
            source = `// ${name} - tool definition.
const TOOL_META = ${metaJson};

${source.trim() || 'async function handler(args, api) {\n    return "Not implemented yet.";\n}'}
`;
            if (!hasHandler) {
                // No handler function found in the dropped file at all - append a stub
                // so the tool is at least valid; the rest of the file (helpers, etc.)
                // stays intact and callable from within it.
                source += `
async function handler(args, api) {
    return "Not implemented yet.";
}
`;
            }
        } else if (meta.name !== name) {
            // Keep the file name the user chose/confirmed authoritative.
            source = source.replace(/(TOOL_META\s*=\s*\{[\s\S]*?name\s*:\s*)(["'`])([\s\S]*?)\2/, `$1$2${name}$2`);
        }
    }
    const fp = toolFilePath(name);
    registry.files[fp] = source;
    registry.meta[fp] = { kind: 'file', size: source.length, isBinary: false, virtual: true };
    persistToolFile(name, source);
    unmarkToolDeleted(name);

    const cfg = getWorkspaceToolsConfig();
    if (!Array.isArray(cfg.customTools)) cfg.customTools = [];
    const existing = cfg.customTools.find(t => t.name === name);
    if (existing) {
        existing.enabled = true;
        existing.file = fp;
    } else {
        cfg.customTools.push({ name, file: fp, enabled: true });
    }
    if (!cfg.permissions) cfg.permissions = {};
    if (!cfg.permissions[name]) cfg.permissions[name] = 'ask';
    if (!cfg.locks) cfg.locks = {};
    if (cfg.locks[name] === undefined) cfg.locks[name] = false;
    saveWorkspaceToolsState(getWorkspaceToolsKey(), cfg);

    rebuildToolRegistryFromFiles();
    return { ok: true, path: fp };
    }

// --- AST_EXPORTS_START ---
window.createToolFile = createToolFile;
// --- AST_EXPORTS_END ---

// --- deleteToolFile.js ---
async function deleteToolFile(name, fileName) {
    // `name` is the registry key (TOOL_META.name); `fileName` is the on-disk file
    // name. Callers may pass either, so if the key doesn't match directly,
    // resolve the tool by its file name.
    const tool = toolRegistry[name] || Object.values(toolRegistry).find(t => t.fileName === name);
    if (!tool) return false;

    const toolName = tool.name;                  // key used in registry / lock / perm / persisted state
    const fileKey  = tool.fileName || toolName;  // key used for registry.files / disk path
    const fp       = toolFilePath(fileKey);

    delete registry.files[fp];
    delete registry.meta[fp];
    const lockState = loadToolLockState();
    delete lockState[toolName];
    saveToolLockState(lockState);
    const permState = loadToolPermState();
    delete permState[toolName];
    saveToolPermState(permState);
    forgetPersistedToolFile(toolName);
    forgetGithubTool(toolName);
    forgetGithubTool(tool.fileName || toolName);
    markToolDeleted(toolName);
    // fileKey can differ from toolName (e.g. TOOL_META.name mismatched the
    // on-disk file name) - clear both so the file can't resurrect via either key.
    if (fileKey !== toolName) {
        forgetPersistedToolFile(fileKey);
        markToolDeleted(fileKey);
    }

    const cfg = getWorkspaceToolsConfig();
    if (Array.isArray(cfg.customTools)) {
        cfg.customTools = cfg.customTools.filter(t => t.name !== toolName && t.name !== fileKey);
    }
    if (cfg.permissions) {
        delete cfg.permissions[toolName];
        delete cfg.permissions[fileKey];
    }
    if (cfg.locks) {
        delete cfg.locks[toolName];
        delete cfg.locks[fileKey];
    }
    if (cfg.models) {
        delete cfg.models[toolName];
        delete cfg.models[fileKey];
    }
    if (cfg.settings) {
        delete cfg.settings[toolName];
        delete cfg.settings[fileKey];
    }
    saveWorkspaceToolsState(getWorkspaceToolsKey(), cfg);

    // Tool files are normally virtual (localStorage-backed), but if a real
    // folder is open and this tool's file actually exists on disk (e.g. it
    // was picked up from an existing .agent/tools directory), remove it
    // there too so it doesn't linger and reappear on the next workspace sync.
    if (rootHandle) {
        try {
            const parts = fp.split('/').filter(Boolean);
            const targetName = parts.pop();
            let parentHandle = rootHandle;
            for (const p of parts) {
                parentHandle = await parentHandle.getDirectoryHandle(p);
            }
            await parentHandle.removeEntry(targetName);
        } catch (e) {
            // No matching file on disk (purely virtual tool) - nothing to do.
        }
    }
    rebuildToolRegistryFromFiles();
    return true;
}

// --- AST_EXPORTS_START ---
window.deleteToolFile = deleteToolFile;
// --- AST_EXPORTS_END ---

// --- deriveToolNameFromFile.js ---
// Derive a valid tool name from a file's TOOL_META.name (preferred) or its filename.
function deriveToolNameFromFile(fileName, source) {
    const meta = parseToolMeta(source || '');
    if (meta && meta.name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(meta.name)) return meta.name;
    let base = (fileName || '').replace(/\.js$/i, '');
    base = base.replace(/[^a-zA-Z0-9_]/g, '_');
    if (/^[0-9]/.test(base)) base = '_' + base;
    return base;
}

// --- AST_EXPORTS_START ---
window.deriveToolNameFromFile = deriveToolNameFromFile;
// --- AST_EXPORTS_END ---

// --- extractHandlerBody.js ---
// Returns tool file source with TOOL_META stripped, keeping handler + top-level helpers (what runs in the tool worker).
function extractHandlerBody(source) {
    const startMatch = source.match(/(?:const|let|var)\s+TOOL_META\s*=\s*/);
    if (!startMatch) return source;
    let i = startMatch.index + startMatch[0].length;
    if (source[i] !== '{') return source;
    let depth = 0, inStr = null, escaped = false;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (inStr) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === inStr) { inStr = null; }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { i++; break; }
        }
    }
    // Also swallow a trailing semicolon after the object literal, if present.
    if (source[i] === ';') i++;
    return source.slice(0, startMatch.index) + source.slice(i);
}

// --- AST_EXPORTS_START ---
window.extractHandlerBody = extractHandlerBody;
// --- AST_EXPORTS_END ---

// --- forgetPersistedToolFile.js ---
function forgetPersistedToolFile(name) {
    const filesMap = loadToolFilesState();
    delete filesMap[name];
    saveToolFilesState(filesMap);
    deleteAgentFileFromDisk(toolFilePath(name));
}

// --- AST_EXPORTS_START ---
window.forgetPersistedToolFile = forgetPersistedToolFile;
// --- AST_EXPORTS_END ---

// --- getAllTools.js ---
function getAllTools() {
    return Object.values(toolRegistry);
}

// --- AST_EXPORTS_START ---
window.getAllTools = getAllTools;
// --- AST_EXPORTS_END ---

// --- getBuiltinToolSource.js ---
// Every built-in tool is a complete, self-contained tool file (logic, result text and the chat display all live
// inside the tool); they are embedded as text/plain blocks so they stay readable and unescaped.
function getBuiltinToolSource(name) {
    const el = document.getElementById('builtin-tool-src-' + name);
    let text = el ? el.textContent : '';
    if (!text.trim() && el && el.getAttribute('src')) {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', el.getAttribute('src') + '?t=' + Date.now(), false); // synchronous fetch for dev mode
            xhr.send(null);
            if (xhr.status === 200 || xhr.status === 0) {
                text = xhr.responseText || '';
            }
        } catch (e) {
            console.warn('Sync XHR failed for tool:', name, e);
        }
    }
    return text.replace(/^\r?\n/, '').replace(/\r?\n/g, '\r\n');
}

// --- AST_EXPORTS_START ---
window.getBuiltinToolSource = getBuiltinToolSource;
// --- AST_EXPORTS_END ---

// --- getToolIOKind.js ---
function getToolIOKind(toolName) {
    if (TOOL_IO_WRITE.has(toolName)) return 'write';
    if (TOOL_IO_READ_ONLY.has(toolName)) return 'read';
    const tool = toolRegistry[toolName];
    const code = tool && typeof tool.code === 'string' ? tool.code : '';
    const writes = /api\.(writeFile|renameFile)\s*\(/.test(code);
    const reads = /api\.(readFile|listFiles|isBinary|fileExists)\s*\(/.test(code);
    if (writes && reads) return 'mixed';
    if (writes) return 'write';
    return 'read';
}

// --- AST_EXPORTS_START ---
window.getToolIOKind = getToolIOKind;
// --- AST_EXPORTS_END ---

// --- getToolSchema.js ---
function getToolSchema(name) {
    const tool = toolRegistry[name];
    if (!tool || tool.error) return null;
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

// --- AST_EXPORTS_START ---
window.getToolSchema = getToolSchema;
// --- AST_EXPORTS_END ---

// --- getToolsForMode.js ---
function getToolsForMode(mode, hasVision = currentModelHasVision()) {
    return getAllTools()
        .filter(t => !t.error && t.permission !== 'never' && (t.modes || []).includes(mode) && isToolAvailableForVision(t, hasVision))
        .map(t => ({
            type: "function",
            function: {
                name: t.name,
                description: t.name === 'write' && mode === 'plan'
                    ? `Write the step-by-step implementation plan strictly to ${PLAN_FILE}.`
                    : t.description,
                parameters: stripSchemaExtensions(t.parameters)
            }
        }));
}

// --- AST_EXPORTS_START ---
window.getToolsForMode = getToolsForMode;
// --- AST_EXPORTS_END ---

// --- isToolAvailableForVision.js ---
// A tool that declares `require_vision` in its TOOL_META is only usable when the selected model
// supports vision; `hasVision` defaults to the currently selected model.
function isToolAvailableForVision(tool, hasVision = currentModelHasVision()) {
    return !tool.require_vision || !!hasVision;
}

// --- AST_EXPORTS_START ---
window.isToolAvailableForVision = isToolAvailableForVision;
// --- AST_EXPORTS_END ---

// --- isToolModified.js ---
function isToolModified(name) {
    const fp = toolFilePath(name);
    const current = registry.files[fp];
    if (current === undefined) return false;
    const seeded = seedBuiltinToolSources();
    if (!Object.prototype.hasOwnProperty.call(seeded, name)) return true;
    return current !== seeded[name];
}

// --- AST_EXPORTS_START ---
window.isToolModified = isToolModified;
// --- AST_EXPORTS_END ---

// --- isToolNameFaint.js ---
// A tool's name is shown faint when it can't be used: permission is "never", or it needs vision
// and the selected model has none.
function isToolNameFaint(tool) {
    if (!tool || tool.error) return false;
    return tool.permission === 'never' || (!!tool.require_vision && !currentModelHasVision());
}

// --- AST_EXPORTS_START ---
window.isToolNameFaint = isToolNameFaint;
// --- AST_EXPORTS_END ---

// --- loadDeletedToolNames.js ---
function loadDeletedToolNames() {
    try {
        const stored = JSON.parse(localStorage.getItem('tool_deleted_names') || '[]');
        return Array.isArray(stored) ? stored : [];
    } catch(e) { return []; }
}

// --- AST_EXPORTS_START ---
window.loadDeletedToolNames = loadDeletedToolNames;
// --- AST_EXPORTS_END ---

// --- loadToolFilesState.js ---
function loadToolFilesState() {
    try {
        const wsKey = getWorkspaceToolsKey();
        const lsKey = wsKey ? `tool_files_${wsKey}` : 'tool_files_json';
        const stored = JSON.parse(localStorage.getItem(lsKey) || (wsKey ? 'null' : (localStorage.getItem('tool_files_json') || '{}')));
        return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    } catch(e) { return {}; }
}

// --- AST_EXPORTS_START ---
window.loadToolFilesState = loadToolFilesState;
// --- AST_EXPORTS_END ---

// --- markToolDeleted.js ---
function markToolDeleted(name) {
    const list = loadDeletedToolNames();
    if (!list.includes(name)) list.push(name);
    localStorage.setItem('tool_deleted_names', JSON.stringify(list));
}

// --- AST_EXPORTS_START ---
window.markToolDeleted = markToolDeleted;
// --- AST_EXPORTS_END ---

// --- parseToolMeta.js ---
function parseToolMeta(source) {
    const startMatch = source.match(/TOOL_META\s*=\s*/);
    if (!startMatch) return null;
    let i = startMatch.index + startMatch[0].length;
    if (source[i] !== '{') return null;
    let depth = 0, inStr = null, escaped = false;
    const start = i;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (inStr) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === inStr) { inStr = null; }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { i++; break; }
        }
    }
    const objSource = source.slice(start, i);
    try {
        const meta = new Function(`"use strict"; return (${objSource});`)();
        return (meta && typeof meta === 'object') ? meta : null;
    } catch(e) {
        return null;
    }
}

// --- AST_EXPORTS_START ---
window.parseToolMeta = parseToolMeta;
// --- AST_EXPORTS_END ---

// --- persistToolFile.js ---
function persistToolFile(name, source) {
    const filesMap = loadToolFilesState();
    filesMap[name] = source;
    saveToolFilesState(filesMap);
    writeAgentFileToDisk(toolFilePath(name), source);
}

// --- AST_EXPORTS_START ---
window.persistToolFile = persistToolFile;
// --- AST_EXPORTS_END ---

// --- rebuildToolRegistryFromFiles.js ---
function rebuildToolRegistryFromFiles() {
    const lockState = loadToolLockState();
    const permState = loadToolPermState();
    const settingsState = loadToolSettingsState();
    const next = {};
    Object.keys(registry.files).forEach(fp => {
        if (!fp.startsWith(TOOLS_DIR + '/') || !fp.endsWith('.js')) return;
        const fileName = fp.slice((TOOLS_DIR + '/').length, -3);
        const source = registry.files[fp] || '';
        const meta = parseToolMeta(source);
        const isBuiltin = BUILTIN_TOOL_NAMES.includes(fileName);
        if (!meta || !meta.name) {
            next[fileName] = toolMetaError(fileName, 'TOOL_META not found or invalid - this tool is disabled until fixed.');
            next[fileName].builtin = isBuiltin;
            next[fileName].locked = lockState[fileName] !== undefined ? lockState[fileName] : isBuiltin;
            return;
        }
        const defaultPermission = ['never', 'ask', 'always'].includes(meta.permission) ? meta.permission : 'ask';
        const settingsDefs = normalizeToolSettingsList(meta.settings);
        const storedValues = settingsState[meta.name] || {};
        const settingsValues = {};
        settingsDefs.forEach(def => {
            if (storedValues[def.key] !== undefined) {
                settingsValues[def.key] = coerceToolSettingValue(def, storedValues[def.key]);
            } else {
                settingsValues[def.key] = def.default;
            }
        });
        next[meta.name] = {
            name: meta.name,
            description: meta.description || '',
            parameters: meta.parameters || { type: "object", properties: {} },
            modes: Array.isArray(meta.modes) ? meta.modes : ['plan', 'ask', 'code'],
            permission: permState[meta.name] !== undefined ? permState[meta.name] : defaultPermission,
            toolBox: Number(meta.toolBox) === 0 ? 0 : 1,
            expanded: !!meta.expanded,
            interactive: !!meta.interactive,
            require_vision: !!meta.require_vision,
            settings: settingsDefs,
            settingsValues,
            code: extractHandlerBody(source),
            builtin: isBuiltin,
            locked: lockState[meta.name] !== undefined ? lockState[meta.name] : isBuiltin,
            fileName
        };
    });
    toolRegistry = next;
}

// --- AST_EXPORTS_START ---
window.rebuildToolRegistryFromFiles = rebuildToolRegistryFromFiles;
// --- AST_EXPORTS_END ---

// --- refreshAgentFileTab.js ---
function refreshAgentFileTab(path, content) {
    const model = monacoModels.get(path);
    if (!model) return;
    withDirtyTrackingSuppressed(() => model.setValue(content));
    clearFileDirty(path);
}

// --- AST_EXPORTS_START ---
window.refreshAgentFileTab = refreshAgentFileTab;
// --- AST_EXPORTS_END ---

// --- registerToolsVirtualFiles.js ---
function registerToolsVirtualFiles() {
    registry.meta[CUSTOM_TOOLS_DIR] = { kind: 'directory' };
    registry.meta[TOOLS_DIR] = { kind: 'directory' };
    if (typeof window.registerToolsVirtualFile === 'function') {
        window.registerToolsVirtualFile();
    }

    const persisted = loadToolFilesState();
    const seeded = seedBuiltinToolSources();

    Object.keys(persisted).forEach(name => {
        if (wasToolEverDeleted(name)) return;
        registry.files[toolFilePath(name)] = persisted[name];
    });

    let needsAsyncFetch = false;

    BUILTIN_TOOL_NAMES.forEach(name => {
        const fp = toolFilePath(name);
        if (registry.files[fp] === undefined && persisted[name] === undefined && !wasToolEverDeleted(name)) {
            // Unmodified builtin tools are kept only in memory (the in-agent source) and
            // deliberately NOT persisted to localStorage, so we can tell apart a builtin the
            // user actually modified from one that is still the latest shipped version.
            registry.files[fp] = seeded[name] || '';
            if (!registry.files[fp].trim()) {
                needsAsyncFetch = true;
            }
        }
    });

    Object.keys(registry.files).forEach(fp => {
        if (!fp.startsWith(TOOLS_DIR + '/') || !fp.endsWith('.js')) return;
        const text = registry.files[fp] || '';
        registry.meta[fp] = { kind: 'file', size: text.length, isBinary: false, virtual: true };
    });

    rebuildToolRegistryFromFiles();

    if (needsAsyncFetch) {
        // Fallback to async fetch if sync XHR failed (e.g. CORS on file:// or strict browser policy)
        Promise.all(BUILTIN_TOOL_NAMES.map(async (name) => {
            const el = document.getElementById('builtin-tool-src-' + name);
            if (el && el.getAttribute('src')) {
                try {
                    const res = await fetch(el.getAttribute('src') + '?t=' + Date.now());
                    if (res.ok) {
                        const text = await res.text();
                        const fp = toolFilePath(name);
                        registry.files[fp] = text.replace(/^\r?\n/, '').replace(/\r?\n/g, '\r\n');
                        registry.meta[fp].size = registry.files[fp].length;
                    }
                } catch (e) {
                    console.warn('Async fetch failed for', name, e);
                }
            }
        })).then(() => {
            rebuildToolRegistryFromFiles();
            if (typeof renderToolsList === 'function') renderToolsList();
        });
    }
}

// --- AST_EXPORTS_START ---
window.registerToolsVirtualFiles = registerToolsVirtualFiles;
// --- AST_EXPORTS_END ---

// --- resetToolToDefault.js ---
function resetToolToDefault(name) {
    const seeded = seedBuiltinToolSources();
    if (!seeded[name]) return false;
    const fp = toolFilePath(name);
    registry.files[fp] = seeded[name];
    registry.meta[fp] = { kind: 'file', size: seeded[name].length, isBinary: false, virtual: true };
    // Restoring to the built-in default means the tool is now exactly the shipped source.
    // Drop it from localStorage so it isn't mistaken for a user-modified tool and
    // falls back to the fresh in-agent source on next load.
    forgetPersistedToolFile(name);
    unmarkToolDeleted(name);
    rebuildToolRegistryFromFiles();
    return true;
}

// --- AST_EXPORTS_START ---
window.resetToolToDefault = resetToolToDefault;
// --- AST_EXPORTS_END ---

// --- restoreAgentFile.js ---
function restoreAgentFile(path) {
    const kind = agentFileKind(path);
    if (!kind) return { error: `${path} has no built-in default.` };

    if (kind === 'models') {
        MODEL_PROVIDERS = seedDefaultModels();
        saveModels();
        renderModelDropdown();
    } else if (kind === 'config') {
        AppConfig.reset();
        registerConfigVirtualFile();
        applyConfigToUI();
        updateGenGlow();
    } else if (kind === 'tools_config') {
        if (typeof window.setWorkspaceToolsConfig === 'function' && typeof window.toolsDefaults === 'function') {
            window.setWorkspaceToolsConfig(window.toolsDefaults());
        }
        if (typeof window.registerToolsVirtualFile === 'function') {
            window.registerToolsVirtualFile();
        }
        if (typeof renderToolsList === 'function') renderToolsList();
    } else if (kind === 'prompt') {
        MODE_PROMPTS[PROMPT_FILE_MODES[path]] = seedDefaultModePrompts()[PROMPT_FILE_MODES[path]];
        saveModePrompts();
    } else {
        const name = toolNameFromPath(path);
        if (!resetToolToDefault(name)) return { error: `"${name}" has no built-in default.` };
    }

    refreshAgentFileTab(path, registry.files[path]);
    renderExplorerTree();
    if (kind === 'tool' || kind === 'tools_config') renderToolsList();
    return {};
}

// --- AST_EXPORTS_START ---
window.restoreAgentFile = restoreAgentFile;
// --- AST_EXPORTS_END ---

// --- saveToolFilesState.js ---
function saveToolFilesState(filesMap) {
    const wsKey = getWorkspaceToolsKey();
    const lsKey = wsKey ? `tool_files_${wsKey}` : 'tool_files_json';
    localStorage.setItem(lsKey, JSON.stringify(filesMap));
    if (!wsKey) {
        localStorage.setItem('tool_files_json', JSON.stringify(filesMap));
    }
}

// --- AST_EXPORTS_START ---
window.saveToolFilesState = saveToolFilesState;
// --- AST_EXPORTS_END ---

// --- seedBuiltinToolSources.js ---
function seedBuiltinToolSources() {
    const seeded = {};
    BUILTIN_TOOL_NAMES.forEach(name => { seeded[name] = getBuiltinToolSource(name); });
    return seeded;
}

// --- AST_EXPORTS_START ---
window.seedBuiltinToolSources = seedBuiltinToolSources;
// --- AST_EXPORTS_END ---

// --- stripSchemaExtensions.js ---
// Host-only schema keywords (e.g. `allowEmpty`) are honored by validateToolArgs but never sent to the model API.
function stripSchemaExtensions(schema) {
    if (Array.isArray(schema)) return schema.map(stripSchemaExtensions);
    if (!schema || typeof schema !== 'object') return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'allowEmpty' && typeof v === 'boolean') continue;
        out[k] = stripSchemaExtensions(v);
    }
    return out;
}

// --- AST_EXPORTS_START ---
window.stripSchemaExtensions = stripSchemaExtensions;
// --- AST_EXPORTS_END ---

// --- toolFilePath.js ---
function toolFilePath(name) {
    return `${TOOLS_DIR}/${name}.js`;
}

// --- AST_EXPORTS_START ---
window.toolFilePath = toolFilePath;
// --- AST_EXPORTS_END ---

// --- toolIOIndicatorHTML.js ---
function toolIOIndicatorHTML(toolName, kind = null) {
    if (!kind) kind = getToolIOKind(toolName);
    const config = {
        read: { arrow: 'arrow_downward', label: 'read', title: 'Read-only: only pulls data in' },
        write: { arrow: 'arrow_upward', label: 'write', title: 'Write: changes files/state' },
        mixed: { arrow: 'swap_vert', label: 'read/write', title: 'Reads and writes' }
    }[kind];
    return `<span class="tool-io-indicator io-${kind}" title="${escapeHTML(config.title)}"><span class="icon">${config.arrow}</span></span>`;
}

// --- AST_EXPORTS_START ---
window.toolIOIndicatorHTML = toolIOIndicatorHTML;
// --- AST_EXPORTS_END ---

// --- toolMayUseModel.js ---
// A tool may use a model only if the user picked it in one of that tool's own 'model' settings.
function toolMayUseModel(toolName, entry) {
    const tool = toolRegistry[toolName];
    if (!tool || !entry) return false;
    return (tool.settings || []).some(def => {
        if (def.type !== 'model') return false;
        const e = findModelEntryById(getToolSettingValue(toolName, def.key));
        return !!e && e.uuid === entry.uuid;
    });
}

// --- AST_EXPORTS_START ---
window.toolMayUseModel = toolMayUseModel;
// --- AST_EXPORTS_END ---

// --- toolMetaError.js ---
function toolMetaError(name, msg) {
    return { name, description: '', parameters: { type: "object", properties: {} }, modes: [], permission: 'never', toolBox: 1, code: '', locked: true, builtin: false, error: msg, settings: [], settingsValues: {}, require_vision: false };
}

// --- AST_EXPORTS_START ---
window.toolMetaError = toolMetaError;
// --- AST_EXPORTS_END ---

// --- toolNameFromPath.js ---
function toolNameFromPath(path) {
    return path.slice((TOOLS_DIR + '/').length, -3);
}

// --- AST_EXPORTS_START ---
window.toolNameFromPath = toolNameFromPath;
// --- AST_EXPORTS_END ---

// --- unmarkToolDeleted.js ---
function unmarkToolDeleted(name) {
    const list = loadDeletedToolNames().filter(n => n !== name);
    localStorage.setItem('tool_deleted_names', JSON.stringify(list));
}

// --- AST_EXPORTS_START ---
window.unmarkToolDeleted = unmarkToolDeleted;
// --- AST_EXPORTS_END ---

// --- validateToolArgs.js ---
function validateToolArgs(name, args, rawArgsStr, parseError) {
    const errors = [];

    if (parseError) {
        errors.push(`Arguments were not valid JSON: ${parseError.message}`);
        return { valid: false, errors };
    }

    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        errors.push(`Arguments must be a JSON object, got ${Array.isArray(args) ? 'array' : typeof args}.`);
        return { valid: false, errors };
    }

    const schema = getToolSchema(name);
    if (!schema) {
        errors.push(`Unknown tool "${name}". No schema is registered for it.`);
        return { valid: false, errors };
    }

    const props = schema.parameters?.properties || {};
    const required = schema.parameters?.required || [];

    for (const key of required) {
        const val = args[key];
        const allowEmpty = props[key]?.allowEmpty === true;
        const missing = val === undefined || val === null || (typeof val === 'string' && val.trim() === '' && !allowEmpty);
        if (missing) {
            errors.push(`Missing required parameter "${key}" (${props[key]?.description || props[key]?.type || 'expected'}).`);
        }
    }

    for (const [key, val] of Object.entries(args)) {
        if (val === undefined || val === null) continue;
        const propSchema = props[key];
        if (!propSchema) continue;
        const expected = propSchema.type;
        if (!expected) continue;

        let actualOk = true;
        if (expected === 'string') actualOk = typeof val === 'string';
        else if (expected === 'integer') actualOk = typeof val === 'number' && Number.isInteger(val);
        else if (expected === 'number') actualOk = typeof val === 'number';
        else if (expected === 'boolean') actualOk = typeof val === 'boolean';
        else if (expected === 'array') actualOk = Array.isArray(val);
        else if (expected === 'object') actualOk = typeof val === 'object' && !Array.isArray(val);

        if (!actualOk) {
            errors.push(`Parameter "${key}" should be of type ${expected}, got ${Array.isArray(val) ? 'array' : typeof val}.`);
        }
    }

    return { valid: errors.length === 0, errors };
}

// --- AST_EXPORTS_START ---
window.validateToolArgs = validateToolArgs;
// --- AST_EXPORTS_END ---

// --- wasToolEverDeleted.js ---
function wasToolEverDeleted(name) {
    return loadDeletedToolNames().includes(name);
}

// --- AST_EXPORTS_START ---
window.wasToolEverDeleted = wasToolEverDeleted;
// --- AST_EXPORTS_END ---
