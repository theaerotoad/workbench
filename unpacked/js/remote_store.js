const RemoteStore = {
    enabled: false,
    caps: null
};

function wbSyncDebug(...a) {
    try {
        if (localStorage.getItem('wb_debug_sync') === '1') {
            console.debug('[wb-sync]', ...a);
        }
    } catch (e) {}
}

const _origLsSet = Storage.prototype.setItem;
const _origLsRemove = Storage.prototype.removeItem;
let _applyingLs = false;

function _rawLsSet(key, val) {
    const prev = _applyingLs;
    _applyingLs = true;
    try {
        _origLsSet.call(window.localStorage, key, val);
    } finally {
        _applyingLs = prev;
    }
}

function _rawLsRemove(key) {
    const prev = _applyingLs;
    _applyingLs = true;
    try {
        _origLsRemove.call(window.localStorage, key);
    } finally {
        _applyingLs = prev;
    }
}

// Intercept whitelisted localStorage mutations for settings sync (§9.2).
// Harmless when sync is disabled because remoteMarkDirty/remoteMarkDeleted are no-ops.
if (!Storage.prototype._wbSyncWrapped) {
    Storage.prototype._wbSyncWrapped = true;
    Storage.prototype.setItem = function (k, v) {
        _origLsSet.call(this, k, v);
        if (this === window.localStorage && !_applyingLs && isSyncedLsKey(k)) {
            remoteMarkDirty('settings', k);
        }
    };
    Storage.prototype.removeItem = function (k) {
        _origLsRemove.call(this, k);
        if (this === window.localStorage && !_applyingLs && isSyncedLsKey(k)) {
            remoteMarkDeleted('settings', k);
        }
    };
}

let _resolveRemoteReady = null;
let _remoteReadyResolved = false;
const remoteReady = new Promise((resolve) => {
    _resolveRemoteReady = resolve;
});

function _finishRemoteReady(val) {
    if (_remoteReadyResolved) return;
    _remoteReadyResolved = true;
    if (_resolveRemoteReady) _resolveRemoteReady(val);
}

// --- ID & Hashing Helpers (safe on plain-HTTP LAN origins without crypto.subtle) ---

function makeSyncId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        try { return window.crypto.randomUUID(); } catch (e) {}
    }
    const b = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(b);
    } else {
        for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hash53(str, seed = 0) {
    const s = String(str);
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function isSyncedLsKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (key === 'recent_folders_json' || key.startsWith('sync_')) return false;
    if (SYNC_LS_KEYS.exact.includes(key)) return true;
    return SYNC_LS_KEYS.prefixes.some((p) => key.startsWith(p));
}

// --- Raw IndexedDB Helpers (never trigger sync dirty marks) ---

async function idbGetRaw(storeName, key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbPutRaw(storeName, key, value) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

async function idbDeleteRaw(storeName, key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

async function idbKeysRaw(storeName) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function idbClearRaw(storeName) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

// --- Transport Encoding / Decoding ---

const _B64_CHUNK_SIZE = 32768;

function _bytesToBase64(u8) {
    const parts = [];
    for (let i = 0; i < u8.length; i += _B64_CHUNK_SIZE) {
        const chunk = u8.subarray(i, Math.min(i + _B64_CHUNK_SIZE, u8.length));
        parts.push(String.fromCharCode.apply(null, chunk));
    }
    return btoa(parts.join(''));
}

function _base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

async function encodeForTransport(value) {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (typeof File !== 'undefined' && value instanceof File) {
        const buf = await value.arrayBuffer();
        return {
            __wb_bytes__: _bytesToBase64(new Uint8Array(buf)),
            kind: 'file',
            mime: value.type || '',
            name: value.name,
            lastModified: value.lastModified
        };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const buf = await value.arrayBuffer();
        return {
            __wb_bytes__: _bytesToBase64(new Uint8Array(buf)),
            kind: 'blob',
            mime: value.type || ''
        };
    }
    if (value instanceof ArrayBuffer) {
        return {
            __wb_bytes__: _bytesToBase64(new Uint8Array(value)),
            kind: 'ab'
        };
    }
    if (ArrayBuffer.isView(value)) {
        const u8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return {
            __wb_bytes__: _bytesToBase64(u8),
            kind: 'u8'
        };
    }
    if (value instanceof Set) {
        const items = [];
        for (const item of value) {
            items.push(await encodeForTransport(item));
        }
        return { __wb_set__: items };
    }
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
            out[i] = await encodeForTransport(value[i]);
        }
        return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) {
            out[k] = await encodeForTransport(v);
        }
    }
    return out;
}

function decodeFromTransport(value) {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(decodeFromTransport);
    }
    if (typeof value.__wb_bytes__ === 'string') {
        const u8 = _base64ToBytes(value.__wb_bytes__);
        if (value.kind === 'file') {
            try {
                return new File([u8], value.name || 'file', {
                    type: value.mime || '',
                    lastModified: typeof value.lastModified === 'number' ? value.lastModified : Date.now()
                });
            } catch (e) {
                return new Blob([u8], { type: value.mime || '' });
            }
        }
        if (value.kind === 'blob') {
            return new Blob([u8], { type: value.mime || '' });
        }
        if (value.kind === 'ab') {
            return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        }
        return u8;
    }
    if (Array.isArray(value.__wb_set__)) {
        return new Set(value.__wb_set__.map(decodeFromTransport));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = decodeFromTransport(v);
    }
    return out;
}

// --- Secret Stripping & Preservation ---

function stripModelsArraySecrets(providers) {
    if (!Array.isArray(providers)) return providers;
    return providers.map((p) => {
        if (!p || typeof p !== 'object') return p;
        return { ...p, key: '' };
    });
}

function preserveModelsArraySecrets(incoming, existing) {
    if (!Array.isArray(incoming) || !Array.isArray(existing)) return incoming;
    return incoming.map((p) => {
        if (!p || typeof p !== 'object' || p.key) return p;
        const match = existing.find((e) =>
            e && typeof e === 'object' && e.key &&
            e.provider === p.provider && (e.url || '') === (p.url || '')
        );
        return match ? { ...p, key: match.key } : p;
    });
}

function stripCatalogEntrySecrets(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.auth && typeof entry.auth === 'object' && entry.auth.pass) {
        return { ...entry, auth: { ...entry.auth, pass: '' } };
    }
    return { ...entry };
}

function preserveCatalogEntrySecrets(incoming, existing) {
    if (!incoming || typeof incoming !== 'object' || !existing || typeof existing !== 'object') return incoming;
    if (incoming.auth && typeof incoming.auth === 'object' && !incoming.auth.pass && existing.auth && existing.auth.pass) {
        return { ...incoming, auth: { ...incoming.auth, pass: existing.auth.pass } };
    }
    return incoming;
}

const _SECRET_TOOL_SETTING_RE = /(?:^|[_-])(?:api[_-]?key|secret(?:[_-]?key)?|password|passwd|access[_-]?token|auth[_-]?token|bearer[_-]?token|private[_-]?key)(?:$|[_-])|(?:apiKey|secretKey|accessToken|authToken|bearerToken|privateKey|password)/i;

function _stripToolSettingsMapSecrets(settingsMap) {
    if (!settingsMap || typeof settingsMap !== 'object' || Array.isArray(settingsMap)) return settingsMap;
    const out = {};
    for (const [toolName, toolVals] of Object.entries(settingsMap)) {
        if (toolVals && typeof toolVals === 'object' && !Array.isArray(toolVals)) {
            const copy = { ...toolVals };
            for (const [sk, sv] of Object.entries(copy)) {
                if (_SECRET_TOOL_SETTING_RE.test(sk) && typeof sv === 'string' && sv) {
                    copy[sk] = '';
                }
            }
            out[toolName] = copy;
        } else {
            out[toolName] = toolVals;
        }
    }
    return out;
}

function _preserveToolSettingsMapSecrets(incomingMap, existingMap) {
    if (!incomingMap || typeof incomingMap !== 'object' || Array.isArray(incomingMap)) return incomingMap;
    if (!existingMap || typeof existingMap !== 'object' || Array.isArray(existingMap)) return incomingMap;
    const out = {};
    for (const [toolName, toolVals] of Object.entries(incomingMap)) {
        const extVals = existingMap[toolName];
        if (toolVals && typeof toolVals === 'object' && !Array.isArray(toolVals) &&
            extVals && typeof extVals === 'object' && !Array.isArray(extVals)) {
            const copy = { ...toolVals };
            for (const [sk, ev] of Object.entries(extVals)) {
                if (_SECRET_TOOL_SETTING_RE.test(sk) && typeof ev === 'string' && ev && !copy[sk]) {
                    copy[sk] = ev;
                }
            }
            out[toolName] = copy;
        } else {
            out[toolName] = toolVals;
        }
    }
    return out;
}

function stripSettingsSecrets(key, rawValue) {
    if (key === 'models_json' || key.startsWith('models_')) {
        if (typeof rawValue === 'string') {
            try {
                const parsed = JSON.parse(rawValue);
                if (Array.isArray(parsed)) {
                    return JSON.stringify(stripModelsArraySecrets(parsed));
                }
            } catch (e) {}
        } else if (Array.isArray(rawValue)) {
            return stripModelsArraySecrets(rawValue);
        }
    } else if (key === 'tool_settings_state' || key.startsWith('tool_settings_state_')) {
        if (typeof rawValue === 'string') {
            try {
                const parsed = JSON.parse(rawValue);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return JSON.stringify(_stripToolSettingsMapSecrets(parsed));
                }
            } catch (e) {}
        } else if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
            return _stripToolSettingsMapSecrets(rawValue);
        }
    } else if (key.startsWith('tools_config_')) {
        if (typeof rawValue === 'string') {
            try {
                const parsed = JSON.parse(rawValue);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.settings) {
                    return JSON.stringify({ ...parsed, settings: _stripToolSettingsMapSecrets(parsed.settings) });
                }
            } catch (e) {}
        } else if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && rawValue.settings) {
            return { ...rawValue, settings: _stripToolSettingsMapSecrets(rawValue.settings) };
        }
    }
    return rawValue;
}

function preserveSettingsSecrets(key, incomingRaw, existingRaw) {
    if (!existingRaw) return incomingRaw;
    if (key === 'models_json' || key.startsWith('models_')) {
        try {
            const inc = typeof incomingRaw === 'string' ? JSON.parse(incomingRaw) : incomingRaw;
            const ext = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
            if (Array.isArray(inc) && Array.isArray(ext)) {
                const merged = preserveModelsArraySecrets(inc, ext);
                return typeof incomingRaw === 'string' ? JSON.stringify(merged) : merged;
            }
        } catch (e) {}
    } else if (key === 'tool_settings_state' || key.startsWith('tool_settings_state_')) {
        try {
            const inc = typeof incomingRaw === 'string' ? JSON.parse(incomingRaw) : incomingRaw;
            const ext = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
            if (inc && typeof inc === 'object' && !Array.isArray(inc) &&
                ext && typeof ext === 'object' && !Array.isArray(ext)) {
                const merged = _preserveToolSettingsMapSecrets(inc, ext);
                return typeof incomingRaw === 'string' ? JSON.stringify(merged) : merged;
            }
        } catch (e) {}
    } else if (key.startsWith('tools_config_')) {
        try {
            const inc = typeof incomingRaw === 'string' ? JSON.parse(incomingRaw) : incomingRaw;
            const ext = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
            if (inc && typeof inc === 'object' && !Array.isArray(inc) && inc.settings &&
                ext && typeof ext === 'object' && !Array.isArray(ext) && ext.settings) {
                const merged = { ...inc, settings: _preserveToolSettingsMapSecrets(inc.settings, ext.settings) };
                return typeof incomingRaw === 'string' ? JSON.stringify(merged) : merged;
            }
        } catch (e) {}
    }
    return incomingRaw;
}

// --- Phase 0 Local Backup / Restore ---

async function exportBackupData({ includeSecrets = false } = {}) {
    const sessions = {};
    for (const k of await idbKeysRaw(STORE_SESSIONS)) {
        const val = await idbGetRaw(STORE_SESSIONS, k);
        if (val !== undefined) sessions[String(k)] = val;
    }

    const baselines = {};
    for (const k of await idbKeysRaw(STORE_BASELINES)) {
        const val = await idbGetRaw(STORE_BASELINES, k);
        if (val !== undefined) baselines[String(k)] = val;
    }

    const vws = {};
    for (const k of await idbKeysRaw(STORE_HANDLES)) {
        const ks = String(k);
        if (!ks.startsWith('vws_')) continue;
        const val = await idbGetRaw(STORE_HANDLES, k);
        if (val !== undefined) vws[ks] = val;
    }

    const settings = {};
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!isSyncedLsKey(k)) continue;
        const raw = localStorage.getItem(k);
        if (raw === null) continue;
        settings[k] = includeSecrets ? raw : stripSettingsSecrets(k, raw);
    }

    let catalog = [];
    try {
        const rawCat = localStorage.getItem('recent_folders_json');
        const parsedCat = rawCat ? JSON.parse(rawCat) : [];
        if (Array.isArray(parsedCat)) {
            catalog = includeSecrets ? parsedCat : parsedCat.map(stripCatalogEntrySecrets);
        }
    } catch (e) {
        catalog = [];
    }

    const payload = {
        format: 'workbench-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        stores: {
            sessions,
            baselines,
            vws,
            settings,
            catalog
        }
    };

    return await encodeForTransport(payload);
}

async function downloadBackup({ includeSecrets = false } = {}) {
    const encoded = await exportBackupData({ includeSecrets });
    const json = JSON.stringify(encoded, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `workbench-backup-${stamp}.json`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
}

async function importBackupData(rawBackup) {
    if (!rawBackup || typeof rawBackup !== 'object') {
        throw new Error('Invalid backup file: expected a JSON object.');
    }
    if (rawBackup.format !== 'workbench-backup' || rawBackup.version !== 1) {
        throw new Error('Unsupported backup format or version.');
    }
    if (!rawBackup.stores || typeof rawBackup.stores !== 'object') {
        throw new Error('Invalid backup file: missing stores payload.');
    }

    const decoded = decodeFromTransport(rawBackup);
    const stores = decoded.stores;
    const stats = { sessions: 0, baselines: 0, vws: 0, settings: 0, catalog: 0 };

    if (stores.sessions && typeof stores.sessions === 'object') {
        for (const [k, v] of Object.entries(stores.sessions)) {
            await idbPutRaw(STORE_SESSIONS, k, v);
            stats.sessions++;
        }
    }

    if (stores.baselines && typeof stores.baselines === 'object') {
        for (const [k, v] of Object.entries(stores.baselines)) {
            await idbPutRaw(STORE_BASELINES, k, v);
            stats.baselines++;
        }
    }

    if (stores.vws && typeof stores.vws === 'object') {
        for (const [k, v] of Object.entries(stores.vws)) {
            if (!k.startsWith('vws_')) continue;
            await idbPutRaw(STORE_HANDLES, k, v);
            stats.vws++;
        }
    }

    if (stores.settings && typeof stores.settings === 'object') {
        for (const [k, v] of Object.entries(stores.settings)) {
            if (!isSyncedLsKey(k)) continue;
            const existingRaw = localStorage.getItem(k);
            const strVal = typeof v === 'string' ? v : JSON.stringify(v);
            const finalVal = preserveSettingsSecrets(k, strVal, existingRaw);
            _rawLsSet(k, finalVal);
            stats.settings++;
        }
    }

    if (Array.isArray(stores.catalog)) {
        let existingCatalog = [];
        try {
            const rawExisting = localStorage.getItem('recent_folders_json');
            const parsedExisting = rawExisting ? JSON.parse(rawExisting) : [];
            if (Array.isArray(parsedExisting)) existingCatalog = parsedExisting;
        } catch (e) {}

        const mergedCatalog = stores.catalog.map((entry) => {
            if (!entry || typeof entry !== 'object') return entry;
            const match = existingCatalog.find((ex) => {
                if (!ex || typeof ex !== 'object') return false;
                if (entry.id && ex.id && entry.id === ex.id) return true;
                if (entry.type === 'webdav' && ex.type === 'webdav') {
                    return ex.url === entry.url && (ex.webdavPath || '/') === (entry.webdavPath || '/');
                }
                return false;
            });
            return match ? preserveCatalogEntrySecrets(entry, match) : entry;
        });

        _rawLsSet('recent_folders_json', JSON.stringify(mergedCatalog));
        stats.catalog = mergedCatalog.length;
    }

    return stats;
}

// =========================================================================
// Phase 2+: Server KV Sync Engine (Outbox, Uploader, Hydration, Conflicts)
// =========================================================================

const _DEBOUNCE_MS = 1500;
const _MAX_WAIT_MS = 5000;
const _GZIP_MIN_BYTES = 8192;
const _UPLOAD_CONCURRENCY = 3;
const _HYDRATE_CONCURRENCY = 4;
const _REFRESH_THROTTLE_MS = 10000;

let _clientId = null;
let _flushInFlight = null;
let _flushRequested = false;
let _lastFlushHadTransientError = false;
let _flushDebounceTimer = null;
let _flushMaxTimer = null;
let _retryTimer = null;
let _firstDirtyAt = 0;
let _backoffMs = 0;
let _pendingReloadSessions = false;
let _lastRefreshAt = 0;
let _listenersBound = false;
const _toastedTooLargeKeys = new Set();
const _metaLocks = new Map();
const _markInFlight = new Set();
let _catalogSnapshot = new Map(); // id -> JSON string

function _syncMetaKey(store, key) {
    return `${store}|${key}`;
}

function _encodeKeyForPath(key) {
    return String(key).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function _kvUrl(store, key) {
    return `/api/v1/kv/${encodeURIComponent(store)}/${_encodeKeyForPath(key)}`;
}

function _kvListUrl(store, prefix) {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return `/api/v1/kv/${encodeURIComponent(store)}${q}`;
}

function _parseRevFromResponse(resp, jsonBody) {
    const hdr = resp && resp.headers ? resp.headers.get('X-Rev') : null;
    if (hdr !== null && hdr !== '') {
        const n = parseInt(hdr, 10);
        if (Number.isFinite(n)) return n;
    }
    if (jsonBody && typeof jsonBody.rev === 'number') return jsonBody.rev;
    return null;
}

function _withSyncMeta(store, key, fn) {
    const mk = _syncMetaKey(store, key);
    const prev = _metaLocks.get(mk) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const existing = await idbGetRaw(STORE_SYNC, mk);
        const cur = existing || { store, key, baseRev: 0, pending: null, dirtyGen: 0, lastHash: null };
        const next = await fn(cur);
        if (next !== undefined) {
            await idbPutRaw(STORE_SYNC, mk, next);
        }
        return next;
    });
    const tracked = run.finally(() => {
        if (_metaLocks.get(mk) === tracked) _metaLocks.delete(mk);
    });
    _metaLocks.set(mk, tracked);
    return tracked;
}

async function _runPool(items, limit, worker) {
    if (!items.length) return;
    let idx = 0;
    const workers = [];
    const n = Math.min(limit, items.length);
    for (let w = 0; w < n; w++) {
        workers.push((async () => {
            while (idx < items.length) {
                const i = idx++;
                await worker(items[i], i);
            }
        })());
    }
    await Promise.all(workers);
}

async function _gzipString(str) {
    const bytes = new TextEncoder().encode(str);
    if (bytes.byteLength <= _GZIP_MIN_BYTES || typeof CompressionStream === 'undefined') {
        return { body: bytes, gzipped: false };
    }
    try {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const buf = await new Response(cs.readable).arrayBuffer();
        return { body: new Uint8Array(buf), gzipped: true };
    } catch (e) {
        return { body: bytes, gzipped: false };
    }
}

// --- Catalog Snapshot & Identity Helpers ---

function _normWebdavPath(p) {
    const s = p || '/';
    return (s.startsWith('/') ? s : '/' + s).replace(/\/+$/, '') + '/';
}

function _catalogEntriesSameWorkspace(a, b) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (a.virtual || b.virtual) {
        return !!(a.virtual && b.virtual && a.vid && a.vid === b.vid);
    }
    if (a.type === 'webdav' || b.type === 'webdav') {
        if (a.type !== 'webdav' || b.type !== 'webdav') return false;
        if (_normWebdavPath(a.webdavPath) !== _normWebdavPath(b.webdavPath)) return false;
        if (a.sameOrigin && b.sameOrigin) return true;
        return (a.url || '') === (b.url || '');
    }
    return a.name === b.name;
}

function _readCatalogRaw() {
    try {
        const raw = localStorage.getItem('recent_folders_json');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function _writeCatalogRaw(list) {
    _rawLsSet('recent_folders_json', JSON.stringify(list));
    _rebuildCatalogSnapshot(list);
}

function _rebuildCatalogSnapshot(list) {
    const next = new Map();
    for (const entry of (Array.isArray(list) ? list : [])) {
        if (entry && entry.id) {
            next.set(entry.id, JSON.stringify(entry));
        }
    }
    _catalogSnapshot = next;
}

function _computeLegacyStorageKeyForCatalogEntry(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.storageKey) return entry.storageKey;
    if (entry.virtual && entry.vid) return 'virtual_' + entry.vid;
    if (entry.type === 'webdav') {
        if (typeof window.WebDAVDirHandle === 'function') {
            try {
                const tmp = new window.WebDAVDirHandle(entry.url || '', entry.webdavPath || '/', entry.auth || null, entry.name);
                return tmp.wsKey;
            } catch (e) {}
        }
        const cleanName = (entry.name || 'webdav').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
        const dirPath = _normWebdavPath(entry.webdavPath);
        const raw = `${(entry.url || '').replace(/\/$/, '').toLowerCase()}|${dirPath}|${entry.auth?.user || ''}|${entry.name || ''}`;
        let h1 = 0xdeadbeef ^ 0, h2 = 0x41c64e6d ^ 0;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
        return `webdav_${cleanName}_${hash}`;
    }
    return entry.name || '';
}

function remoteSyncCatalogDiff(folders) {
    if (!RemoteStore.enabled) {
        _rebuildCatalogSnapshot(folders);
        return;
    }
    const prev = _catalogSnapshot;
    const next = new Map();
    for (const entry of (Array.isArray(folders) ? folders : [])) {
        if (!entry || !entry.id) continue;
        const ser = JSON.stringify(entry);
        next.set(entry.id, ser);
        if (!prev.has(entry.id) || prev.get(entry.id) !== ser) {
            remoteMarkDirty('catalog', entry.id);
        }
    }
    for (const oldId of prev.keys()) {
        if (!next.has(oldId)) {
            remoteMarkDeleted('catalog', oldId);
        }
    }
    _catalogSnapshot = next;
}

// --- Binary Backup Sync Cap for Baselines ---

const _SYNC_MAX_BINARY_BACKUP_FILE_BYTES = 1 * 1024 * 1024;    // 1 MB per binary backup when syncing to server
const _SYNC_MAX_BINARY_BACKUP_RECORD_BYTES = 4 * 1024 * 1024;  // 4 MB total binary backups per synced baseline record

function _isBinaryBackupObj(val) {
    return !!(val && typeof val === 'object' && val.__wb_binary__ === true);
}

function _sanitizeBaselineForRemoteSync(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    let remaining = _SYNC_MAX_BINARY_BACKUP_RECORD_BYTES;
    let changed = false;

    const sanitizeVal = (val) => {
        if (!_isBinaryBackupObj(val) || val.omitted || typeof val.b64 !== 'string') return val;
        const size = typeof val.size === 'number' ? val.size : Math.floor(val.b64.length * 0.75);
        if (size > _SYNC_MAX_BINARY_BACKUP_FILE_BYTES || size > remaining) {
            changed = true;
            return { __wb_binary__: true, omitted: true, size, reason: 'sync-limit' };
        }
        remaining -= size;
        return val;
    };

    let origOut = rec.originalFiles;
    if (rec.originalFiles && typeof rec.originalFiles === 'object') {
        let origChanged = false;
        const nextOrig = {};
        for (const [k, v] of Object.entries(rec.originalFiles)) {
            const sv = sanitizeVal(v);
            if (sv !== v) origChanged = true;
            nextOrig[k] = sv;
        }
        if (origChanged) origOut = nextOrig;
    }

    let opsOut = rec.opsLog;
    if (rec.opsLog && typeof rec.opsLog === 'object') {
        let opsChanged = false;
        const nextOps = {};
        for (const [fp, list] of Object.entries(rec.opsLog)) {
            if (!Array.isArray(list)) {
                nextOps[fp] = list;
                continue;
            }
            let listChanged = false;
            const nextList = list.map((op) => {
                if (!op || typeof op !== 'object') return op;
                const sc = sanitizeVal(op.content);
                const sp = sanitizeVal(op.previousContent);
                if (sc !== op.content || sp !== op.previousContent) {
                    listChanged = true;
                    return { ...op, content: sc, previousContent: sp };
                }
                return op;
            });
            if (listChanged) opsChanged = true;
            nextOps[fp] = listChanged ? nextList : list;
        }
        if (opsChanged) opsOut = nextOps;
    }

    if (!changed) return rec;
    return { ...rec, originalFiles: origOut, opsLog: opsOut };
}

function _preserveLocalBinaryBackups(incoming, existing) {
    if (!incoming || typeof incoming !== 'object' || !existing || typeof existing !== 'object') return incoming;
    let changed = false;

    const restoreVal = (incVal, extVal) => {
        if (_isBinaryBackupObj(incVal) && incVal.omitted && incVal.reason === 'sync-limit' &&
            _isBinaryBackupObj(extVal) && !extVal.omitted &&
            (incVal.size == null || extVal.size == null || incVal.size === extVal.size)) {
            changed = true;
            return extVal;
        }
        return incVal;
    };

    let origOut = incoming.originalFiles;
    if (incoming.originalFiles && typeof incoming.originalFiles === 'object' &&
        existing.originalFiles && typeof existing.originalFiles === 'object') {
        let origChanged = false;
        const nextOrig = {};
        for (const [k, v] of Object.entries(incoming.originalFiles)) {
            const rv = restoreVal(v, existing.originalFiles[k]);
            if (rv !== v) origChanged = true;
            nextOrig[k] = rv;
        }
        if (origChanged) origOut = nextOrig;
    }

    let opsOut = incoming.opsLog;
    if (incoming.opsLog && typeof incoming.opsLog === 'object' &&
        existing.opsLog && typeof existing.opsLog === 'object') {
        let opsChanged = false;
        const nextOps = {};
        for (const [fp, list] of Object.entries(incoming.opsLog)) {
            const extList = existing.opsLog[fp];
            if (!Array.isArray(list) || !Array.isArray(extList)) {
                nextOps[fp] = list;
                continue;
            }
            let listChanged = false;
            const nextList = list.map((op) => {
                if (!op || typeof op !== 'object') return op;
                const match = extList.find((eo) => eo && eo.kind === op.kind && eo.ts === op.ts);
                if (!match) return op;
                const rc = restoreVal(op.content, match.content);
                const rp = restoreVal(op.previousContent, match.previousContent);
                if (rc !== op.content || rp !== op.previousContent) {
                    listChanged = true;
                    return { ...op, content: rc, previousContent: rp };
                }
                return op;
            });
            if (listChanged) opsChanged = true;
            nextOps[fp] = listChanged ? nextList : list;
        }
        if (opsChanged) opsOut = nextOps;
    }

    if (!changed) return incoming;
    return { ...incoming, originalFiles: origOut, opsLog: opsOut };
}

// --- Store Readers & Raw Writers (§7.6) ---

async function _readLocalForUpload(store, key) {
    if (store === 'sessions') {
        return await idbGetRaw(STORE_SESSIONS, key);
    }
    if (store === 'baselines') {
        const rec = await idbGetRaw(STORE_BASELINES, key);
        return _sanitizeBaselineForRemoteSync(rec);
    }
    if (store === 'catalog') {
        const list = _readCatalogRaw();
        const entry = list.find((f) => f && f.id === key);
        if (!entry) return undefined;
        let out = RemoteStore.caps?.syncSecrets ? { ...entry } : stripCatalogEntrySecrets(entry);
        if (out.sameOrigin && out.type === 'webdav') {
            out = { ...out, url: '' };
        }
        return out;
    }
    if (store === 'settings') {
        if (!isSyncedLsKey(key)) return undefined;
        const raw = localStorage.getItem(key);
        if (raw === null) return undefined;
        let val = raw;
        try { val = JSON.parse(raw); } catch (e) {}
        return RemoteStore.caps?.syncSecrets ? val : stripSettingsSecrets(key, val);
    }
    if (store === 'vws') {
        return await idbGetRaw(STORE_HANDLES, key);
    }
    return undefined;
}

async function _deleteLocalRaw(store, key) {
    if (store === 'sessions') {
        await idbDeleteRaw(STORE_SESSIONS, key);
        return;
    }
    if (store === 'baselines') {
        await idbDeleteRaw(STORE_BASELINES, key);
        return;
    }
    if (store === 'catalog') {
        const list = _readCatalogRaw();
        const filtered = list.filter((f) => f && f.id !== key);
        if (filtered.length !== list.length) {
            _writeCatalogRaw(filtered);
        }
        return;
    }
    if (store === 'settings') {
        if (isSyncedLsKey(key)) {
            _rawLsRemove(key);
        }
        return;
    }
    if (store === 'vws') {
        await idbDeleteRaw(STORE_HANDLES, key);
        return;
    }
}

async function _applyLocalRaw(store, key, decoded, serverItemsMap) {
    if (store === 'sessions') {
        if (key.endsWith('::index')) {
            const wsKey = key.slice(0, -'::index'.length);
            const localIdx = await idbGetRaw(STORE_SESSIONS, key);
            if (localIdx && typeof localIdx === 'object') {
                const { merged, differsFromServer } = await _mergeSessionIndex(decoded, localIdx, wsKey, serverItemsMap);
                await idbPutRaw(STORE_SESSIONS, key, merged);
                return { needsReupload: differsFromServer };
            }
            await idbPutRaw(STORE_SESSIONS, key, decoded);
            return { needsReupload: false };
        }
        await idbPutRaw(STORE_SESSIONS, key, decoded);
        return { needsReupload: false };
    }
    if (store === 'baselines') {
        const existing = await idbGetRaw(STORE_BASELINES, key);
        const merged = _preserveLocalBinaryBackups(decoded, existing);
        await idbPutRaw(STORE_BASELINES, key, merged);
        return { needsReupload: false };
    }
    if (store === 'catalog') {
        if (!decoded || typeof decoded !== 'object') return { needsReupload: false };
        const list = _readCatalogRaw();
        let entry = { ...decoded, id: decoded.id || key };
        if (entry.sameOrigin && entry.type === 'webdav') {
            entry.url = window.location.origin;
        }
        const existing = list.find((f) => f && f.id === entry.id)
            || list.find((f) => _catalogEntriesSameWorkspace(f, entry));
        if (existing) {
            entry = preserveCatalogEntrySecrets(entry, existing);
        }
        const deduped = list.filter((f) => f && f.id !== entry.id && !_catalogEntriesSameWorkspace(f, entry));
        deduped.push(entry);
        _writeCatalogRaw(deduped);
        return { needsReupload: false };
    }
    if (store === 'settings') {
        if (!isSyncedLsKey(key)) return { needsReupload: false };
        const existingRaw = localStorage.getItem(key);
        const incomingStr = typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
        const finalStr = preserveSettingsSecrets(key, incomingStr, existingRaw);
        _rawLsSet(key, finalStr);
        return { needsReupload: false };
    }
    if (store === 'vws') {
        await idbPutRaw(STORE_HANDLES, key, decoded);
        return { needsReupload: false };
    }
    return { needsReupload: false };
}

// --- Session Index Deterministic Merge (§8.4) ---

async function _fetchServerListingMap(store, prefix) {
    try {
        const resp = await fetch(_kvListUrl(store, prefix), { cache: 'no-store' });
        if (!resp.ok) return null;
        const data = await resp.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        const map = new Map();
        for (const it of items) map.set(it.key, it);
        return map;
    } catch (e) {
        return null;
    }
}

async function _mergeSessionIndex(serverIdx, localIdx, wsKey, serverItemsMap) {
    const sIds = Array.isArray(serverIdx?.sessionIds) ? serverIdx.sessionIds : [];
    const lIds = Array.isArray(localIdx?.sessionIds) ? localIdx.sessionIds : [];
    const sMeta = (serverIdx && serverIdx.meta && typeof serverIdx.meta === 'object') ? serverIdx.meta : {};
    const lMeta = (localIdx && localIdx.meta && typeof localIdx.meta === 'object') ? localIdx.meta : {};

    let listingMap = serverItemsMap;
    if (!listingMap) {
        listingMap = await _fetchServerListingMap('sessions', `${wsKey}::session::`);
    }

    const prefix = `${wsKey}::session::`;
    const localSessionIds = new Set();
    try {
        const allKeys = await idbKeysRaw(STORE_SESSIONS);
        for (const k of allKeys) {
            const ks = String(k);
            if (ks.startsWith(prefix)) localSessionIds.add(ks.slice(prefix.length));
        }
    } catch (e) {}

    const mergedIds = [];
    const seen = new Set();
    const consider = (id) => {
        if (typeof id !== 'string' || !id || seen.has(id)) return;
        seen.add(id);
        const recKey = `${wsKey}::session::${id}`;
        const srvItem = listingMap ? listingMap.get(recKey) : undefined;
        if (srvItem && srvItem.deleted) return;
        const existsLocally = localSessionIds.has(id);
        const existsOnServer = !!(srvItem && !srvItem.deleted);
        if (listingMap && !existsLocally && !existsOnServer) return;
        mergedIds.push(id);
    };

    sIds.forEach(consider);
    lIds.forEach(consider);

    const mergedMeta = {};
    for (const id of mergedIds) {
        const sm = sMeta[id];
        const lm = lMeta[id];
        if (sm && lm) {
            mergedMeta[id] = ((lm.updatedAt || 0) > (sm.updatedAt || 0)) ? { ...lm } : { ...sm };
        } else if (sm) {
            mergedMeta[id] = { ...sm };
        } else if (lm) {
            mergedMeta[id] = { ...lm };
        }
    }

    let activeSessionId = null;
    if (localIdx?.activeSessionId && mergedIds.includes(localIdx.activeSessionId)) {
        activeSessionId = localIdx.activeSessionId;
    } else if (serverIdx?.activeSessionId && mergedIds.includes(serverIdx.activeSessionId)) {
        activeSessionId = serverIdx.activeSessionId;
    } else {
        activeSessionId = mergedIds[0] || null;
    }

    const merged = {
        sessionIds: mergedIds,
        activeSessionId,
        meta: mergedMeta
    };

    const serverComparable = JSON.stringify({ sessionIds: sIds, meta: sMeta });
    const mergedComparable = JSON.stringify({ sessionIds: mergedIds, meta: mergedMeta });
    return {
        merged,
        differsFromServer: serverComparable !== mergedComparable
    };
}

// --- Conflict Resolution (§8) ---

async function _fetchServerItem(store, key) {
    const resp = await fetch(_kvUrl(store, key), { cache: 'no-store' });
    if (resp.status === 404) {
        return { status: 404, rev: 0, value: null, rawText: null };
    }
    if (resp.status === 410) {
        let j = null;
        try { j = await resp.json(); } catch (e) {}
        return { status: 410, rev: _parseRevFromResponse(resp, j) || 0, value: null, rawText: null };
    }
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }
    const rawText = await resp.text();
    const rev = _parseRevFromResponse(resp, null);
    const parsed = JSON.parse(rawText);
    return { status: 200, rev, value: decodeFromTransport(parsed), rawText };
}

async function handleConflict(store, key, serverRev, serverItemsMap = null) {
    // 8.4 Session index: deterministic merge
    if (store === 'sessions' && key.endsWith('::index')) {
        const wsKey = key.slice(0, -'::index'.length);
        const srv = await _fetchServerItem('sessions', key);
        const actualRev = srv.rev != null ? srv.rev : serverRev;
        const serverIdx = srv.status === 200 ? srv.value : { sessionIds: [], activeSessionId: null, meta: {} };
        const localIdx = await idbGetRaw(STORE_SESSIONS, key);
        const { merged } = await _mergeSessionIndex(serverIdx, localIdx, wsKey, serverItemsMap);
        await idbPutRaw(STORE_SESSIONS, key, merged);
        await _withSyncMeta('sessions', key, (cur) => ({
            ...cur,
            baseRev: actualRev,
            pending: 'put',
            dirtyGen: (cur.dirtyGen || 0) + 1,
            lastHash: null
        }));
        _scheduleFlush();
        return;
    }

    // 8.1 Session record: fork local version as "(conflict copy)"
    if (store === 'sessions' && key.includes('::session::')) {
        const splitIdx = key.indexOf('::session::');
        const wsKey = key.slice(0, splitIdx);
        const id = key.slice(splitIdx + '::session::'.length);
        const ws = wsKey.startsWith('codeagent_sessions_') ? wsKey.slice('codeagent_sessions_'.length) : wsKey;

        const isCurrentWs = !!(
            window.rootHandle &&
            typeof window.getWorkspaceSessionKey === 'function' &&
            window.getWorkspaceSessionKey() === wsKey
        );
        if (isCurrentWs && typeof window.isSessionRunning === 'function' && window.isSessionRunning(id)) {
            // Defer until generation ends; leave pending
            return;
        }

        const localRec = await idbGetRaw(STORE_SESSIONS, key);
        const srv = await _fetchServerItem('sessions', key);
        const actualRev = srv.rev != null ? srv.rev : serverRev;

        if (srv.status === 200 && srv.rawText !== null && localRec !== undefined) {
            try {
                const localHash = hash53(JSON.stringify(await encodeForTransport(localRec)));
                const srvHash = hash53(srv.rawText);
                if (localHash === srvHash) {
                    await _withSyncMeta('sessions', key, (cur) => ({
                        ...cur,
                        baseRev: actualRev,
                        pending: null,
                        lastHash: srvHash
                    }));
                    return;
                }
            } catch (e) {}
        }

        let forkedTitle = null;

        if (localRec && typeof localRec === 'object') {
            const newId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
            const baseTitle = localRec.title || 'Untitled Session';
            forkedTitle = baseTitle.endsWith(' (conflict copy)') ? baseTitle : `${baseTitle} (conflict copy)`;
            const now = Date.now();
            const forkedRec = {
                ...localRec,
                id: newId,
                title: forkedTitle,
                updatedAt: now
            };
            const newRecKey = `${wsKey}::session::${newId}`;
            await idbPutRaw(STORE_SESSIONS, newRecKey, forkedRec);
            remoteMarkDirty('sessions', newRecKey);

            // Copy local baseline to forked session if present
            const origBaseKey = `${ws}::${id}`;
            const localBaseline = await idbGetRaw(STORE_BASELINES, origBaseKey);
            if (localBaseline && typeof localBaseline === 'object') {
                const newBaseKey = `${ws}::${newId}`;
                await idbPutRaw(STORE_BASELINES, newBaseKey, { ...localBaseline, sessionId: newId });
                remoteMarkDirty('baselines', newBaseKey);
            }

            // Add forked session to local index (raw write + mark index dirty)
            const idxKey = `${wsKey}::index`;
            const idx = (await idbGetRaw(STORE_SESSIONS, idxKey)) || {
                sessionIds: [],
                activeSessionId: id,
                meta: {}
            };
            const ids = Array.isArray(idx.sessionIds) ? idx.sessionIds.slice() : [];
            if (!ids.includes(newId)) ids.push(newId);
            const meta = (idx.meta && typeof idx.meta === 'object') ? { ...idx.meta } : {};
            const msgCount = typeof window.countConversationMessages === 'function'
                ? window.countConversationMessages(forkedRec.messages)
                : (Array.isArray(forkedRec.messages) ? forkedRec.messages.length : 0);
            meta[newId] = {
                id: newId,
                title: forkedTitle,
                createdAt: forkedRec.createdAt || now,
                updatedAt: now,
                runningTimeMs: forkedRec.runningTimeMs || 0,
                msgCount
            };
            await idbPutRaw(STORE_SESSIONS, idxKey, { ...idx, sessionIds: ids, meta });
            remoteMarkDirty('sessions', idxKey);
        }

        // Apply server version of the original session key
        if (srv.status === 200) {
            await idbPutRaw(STORE_SESSIONS, key, srv.value);
            await _withSyncMeta('sessions', key, (cur) => ({
                ...cur,
                baseRev: actualRev,
                pending: null,
                lastHash: srv.rawText ? hash53(srv.rawText) : null
            }));
        } else {
            // 410 tombstone or 404: delete original locally
            await idbDeleteRaw(STORE_SESSIONS, key);
            await _withSyncMeta('sessions', key, (cur) => ({
                ...cur,
                baseRev: actualRev,
                pending: null,
                lastHash: null
            }));
            // Also prune tombstoned original id from local index if present
            const idxKey = `${wsKey}::index`;
            const idx = await idbGetRaw(STORE_SESSIONS, idxKey);
            if (idx && Array.isArray(idx.sessionIds) && idx.sessionIds.includes(id)) {
                const nextIds = idx.sessionIds.filter((x) => x !== id);
                const nextMeta = { ...(idx.meta || {}) };
                delete nextMeta[id];
                const nextActive = idx.activeSessionId === id ? (nextIds[0] || null) : idx.activeSessionId;
                await idbPutRaw(STORE_SESSIONS, idxKey, { ...idx, sessionIds: nextIds, activeSessionId: nextActive, meta: nextMeta });
            }
        }

        // Server also wins for original session's baseline
        const origBaseKey = `${ws}::${id}`;
        try {
            const srvBase = await _fetchServerItem('baselines', origBaseKey);
            if (srvBase.status === 200) {
                await idbPutRaw(STORE_BASELINES, origBaseKey, srvBase.value);
                await _withSyncMeta('baselines', origBaseKey, (cur) => ({
                    ...cur,
                    baseRev: srvBase.rev || 0,
                    pending: null,
                    lastHash: srvBase.rawText ? hash53(srvBase.rawText) : null
                }));
            } else if (srvBase.status === 410) {
                await idbDeleteRaw(STORE_BASELINES, origBaseKey);
                await _withSyncMeta('baselines', origBaseKey, (cur) => ({
                    ...cur,
                    baseRev: srvBase.rev || 0,
                    pending: null,
                    lastHash: null
                }));
            }
        } catch (e) {}

        if (forkedTitle && typeof window.showToast === 'function') {
            window.showToast(
                `This conversation was changed on another device. Your version was kept as "${forkedTitle}".`,
                'info',
                5000
            );
        }

        if (isCurrentWs) {
            await remoteReloadSessions();
        }
        return;
    }

    let prefetchedSrv = null;
    let vwsForkInfo = null;

    // 8.3 vws: keep local snapshot as "(conflict copy)", then apply server version
    if (store === 'vws') {
        const localSnap = await idbGetRaw(STORE_HANDLES, key);
        prefetchedSrv = await _fetchServerItem('vws', key);
        const actualVwsRev = prefetchedSrv.rev != null ? prefetchedSrv.rev : serverRev;

        if (prefetchedSrv.status === 200 && prefetchedSrv.rawText !== null && localSnap !== undefined) {
            try {
                const localHash = hash53(JSON.stringify(await encodeForTransport(localSnap)));
                const srvHash = hash53(prefetchedSrv.rawText);
                if (localHash === srvHash) {
                    wbSyncDebug('handleConflict:vws-identical-adopt', { key, rev: actualVwsRev });
                    await _withSyncMeta('vws', key, (cur) => ({
                        ...cur,
                        baseRev: actualVwsRev,
                        pending: null,
                        lastHash: srvHash
                    }));
                    return;
                }
            } catch (e) {}
        }

        if (localSnap && typeof localSnap === 'object') {
            const newVid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const baseName = localSnap.name || 'Virtual Workspace';
            const copyName = baseName.endsWith(' (conflict copy)') ? baseName : `${baseName} (conflict copy)`;
            const copyKey = 'vws_' + newVid;
            const copyToken = makeSyncId();
            const copySnap = {
                ...localSnap,
                vid: newVid,
                name: copyName,
                updated: Date.now(),
                token: copyToken
            };
            await idbPutRaw(STORE_HANDLES, copyKey, copySnap);
            remoteMarkDirty('vws', copyKey);
            vwsForkInfo = { newVid, copyName, copyToken };

            if (typeof window.getRecentFolders === 'function' && typeof window.saveRecentFolders === 'function') {
                const folders = window.getRecentFolders();
                folders.unshift({
                    name: copyName,
                    virtual: true,
                    vid: newVid,
                    storageKey: 'virtual_' + newVid,
                    lastAccessed: Date.now()
                });
                window.saveRecentFolders(folders);
                if (typeof window.renderRecentFoldersList === 'function') window.renderRecentFoldersList();
            }

            if (typeof window.showToast === 'function') {
                window.showToast(
                    `Virtual workspace "${baseName}" was changed on another device. Your version was kept as "${copyName}".`,
                    'info',
                    5000
                );
            }
        }
    }

    // 8.2 / 8.3 baselines, catalog, settings, vws: server wins
    const srv = prefetchedSrv || await _fetchServerItem(store, key);
    const actualRev = srv.rev != null ? srv.rev : serverRev;
    if (srv.status === 200) {
        await _applyLocalRaw(store, key, srv.value, serverItemsMap);
        await _withSyncMeta(store, key, (cur) => ({
            ...cur,
            baseRev: actualRev,
            pending: null,
            lastHash: srv.rawText ? hash53(srv.rawText) : null
        }));
    } else if (srv.status === 410 || srv.status === 404) {
        await _deleteLocalRaw(store, key);
        await _withSyncMeta(store, key, (cur) => ({
            ...cur,
            baseRev: actualRev,
            pending: null,
            lastHash: null
        }));
    }

    if (store === 'vws') {
        const liveWs = (window.rootHandle && window.rootHandle.isVirtual && window.rootHandle._n && window.rootHandle._n._ws) || null;
        if (liveWs && key === 'vws_' + liveWs.vid) {
            if (_lease.mode !== 'readonly') {
                if (vwsForkInfo) {
                    liveWs.forkVid = vwsForkInfo.newVid;
                    liveWs.forkBase = vwsForkInfo.copyToken;
                    liveWs.forkName = vwsForkInfo.copyName;
                }
                liveWs.stale = true;
            }
            wbSyncDebug('handleConflict:vws-schedule-reopen', { key, mode: _lease.mode, forkedTo: vwsForkInfo?.newVid || null });
            scheduleStaleWorkspaceReopen();
        }
    }
}

// --- Outbox & Uploader (§7.4) ---

function _scheduleFlush() {
    if (!RemoteStore.enabled) return;
    if (_flushDebounceTimer) clearTimeout(_flushDebounceTimer);
    _flushDebounceTimer = setTimeout(() => {
        _flushDebounceTimer = null;
        _runFlush();
    }, _DEBOUNCE_MS);
    if (!_firstDirtyAt) {
        _firstDirtyAt = Date.now();
        if (_flushMaxTimer) clearTimeout(_flushMaxTimer);
        _flushMaxTimer = setTimeout(() => {
            _flushMaxTimer = null;
            _runFlush();
        }, _MAX_WAIT_MS);
    }
}

function remoteMarkDirty(store, key) {
    if (!RemoteStore.enabled || !store || !key) return;
    try {
        const p = _withSyncMeta(store, key, (cur) => ({
            ...cur,
            store,
            key,
            pending: 'put',
            dirtyGen: (cur.dirtyGen || 0) + 1
        }));
        _markInFlight.add(p);
        p.finally(() => _markInFlight.delete(p))
            .then(() => _scheduleFlush())
            .catch(() => {});
    } catch (e) {}
}

function remoteMarkDeleted(store, key) {
    if (!RemoteStore.enabled || !store || !key) return;
    try {
        const p = _withSyncMeta(store, key, (cur) => ({
            ...cur,
            store,
            key,
            pending: 'delete',
            dirtyGen: (cur.dirtyGen || 0) + 1
        }));
        _markInFlight.add(p);
        p.finally(() => _markInFlight.delete(p))
            .then(() => _scheduleFlush())
            .catch(() => {});
    } catch (e) {}
}

async function _uploadOneEntry(meta) {
    const { store, key } = meta;
    const freshMeta = await idbGetRaw(STORE_SYNC, _syncMetaKey(store, key));
    if (!freshMeta || freshMeta.pending === null) {
        if (store === 'vws') wbSyncDebug('upload:skip-clean', { key });
        return { transientError: false };
    }
    const gen = freshMeta.dirtyGen || 0;
    const baseRev = freshMeta.baseRev || 0;
    let op = freshMeta.pending;
    let valueHash = null;
    let rawText = null;

    if (op === 'put') {
        const val = await _readLocalForUpload(store, key);
        if (val === undefined) {
            op = 'delete';
        } else {
            const encoded = await encodeForTransport(val);
            rawText = JSON.stringify(encoded);
            valueHash = hash53(rawText);
            if (freshMeta.lastHash !== null && freshMeta.lastHash === valueHash) {
                await _withSyncMeta(store, key, (cur) => {
                    if ((cur.dirtyGen || 0) === gen) {
                        return { ...cur, pending: null };
                    }
                    return cur;
                });
                if (store === 'vws') wbSyncDebug('upload:skip-hash-match', { key, baseRev });
                return { transientError: false };
            }
        }
    }

    const headers = {
        'X-Base-Rev': String(baseRev),
        'X-Client-Id': _clientId || ''
    };

    let resp;
    try {
        if (op === 'put') {
            const { body, gzipped } = await _gzipString(rawText);
            headers['Content-Type'] = 'application/json';
            if (gzipped) headers['Content-Encoding'] = 'gzip';
            resp = await fetch(_kvUrl(store, key), {
                method: 'PUT',
                headers,
                body,
                cache: 'no-store'
            });
        } else {
            resp = await fetch(_kvUrl(store, key), {
                method: 'DELETE',
                headers,
                cache: 'no-store'
            });
        }
    } catch (netErr) {
        if (store === 'vws') wbSyncDebug('upload:net-error', { key, baseRev });
        return { transientError: true };
    }

    if (store === 'vws') {
        wbSyncDebug('upload:vws', { key, op, baseRev, status: resp.status });
    }

    if (resp.status === 200 || (op === 'delete' && resp.status === 404)) {
        let j = null;
        try { j = await resp.json(); } catch (e) {}
        const newRev = _parseRevFromResponse(resp, j);
        await _withSyncMeta(store, key, (cur) => {
            const next = {
                ...cur,
                baseRev: newRev !== null ? newRev : (cur.baseRev || 0),
                lastHash: op === 'put' ? valueHash : null,
                tooLarge: false
            };
            if ((cur.dirtyGen || 0) === gen) {
                next.pending = null;
            }
            return next;
        });
        return { transientError: false };
    }

    if (resp.status === 412) {
        let j = null;
        try { j = await resp.json(); } catch (e) {}
        const serverRev = _parseRevFromResponse(resp, j) || 0;
        if (op === 'put' && valueHash !== null) {
            try {
                const srv = await _fetchServerItem(store, key);
                if (srv.status === 200 && srv.rawText !== null && hash53(srv.rawText) === valueHash) {
                    const adoptedRev = srv.rev !== null ? srv.rev : serverRev;
                    if (store === 'vws') wbSyncDebug('upload:412-identical-adopt', { key, baseRev, adoptedRev });
                    await _withSyncMeta(store, key, (cur) => {
                        const next = {
                            ...cur,
                            baseRev: adoptedRev,
                            lastHash: valueHash,
                            tooLarge: false
                        };
                        if ((cur.dirtyGen || 0) === gen) {
                            next.pending = null;
                        }
                        return next;
                    });
                    return { transientError: false };
                }
            } catch (checkErr) {}
        }
        try {
            await handleConflict(store, key, serverRev);
        } catch (conflictErr) {
            console.error('[remote_store] conflict handling failed:', conflictErr);
            return { transientError: true };
        }
        return { transientError: false };
    }

    if (resp.status === 413) {
        await _withSyncMeta(store, key, (cur) => ({
            ...cur,
            pending: null,
            tooLarge: true
        }));
        const mk = _syncMetaKey(store, key);
        if (!_toastedTooLargeKeys.has(mk)) {
            _toastedTooLargeKeys.add(mk);
            if (typeof window.showToast === 'function') {
                const msg = store === 'vws'
                    ? 'Virtual workspace too large to sync'
                    : 'Conversation too large to sync';
                window.showToast(msg, 'error', 4000);
            }
        }
        return { transientError: false };
    }

    if (resp.status >= 500) {
        return { transientError: true };
    }

    // Unexpected 4xx (e.g. 400): drop pending to avoid infinite retry loop
    console.warn(`[remote_store] upload ${op} ${store}/${key} returned HTTP ${resp.status}`);
    await _withSyncMeta(store, key, (cur) => ((cur.dirtyGen || 0) === gen ? { ...cur, pending: null } : cur));
    return { transientError: false };
}

async function _hasPendingEntries() {
    try {
        const keys = await idbKeysRaw(STORE_SYNC);
        for (const mk of keys) {
            const meta = await idbGetRaw(STORE_SYNC, mk);
            if (meta && meta.pending !== null) return true;
        }
    } catch (e) {}
    return false;
}

async function _runFlush() {
    if (!RemoteStore.enabled) return;
    if (_flushInFlight) {
        _flushRequested = true;
        return _flushInFlight;
    }

    if (_flushDebounceTimer) { clearTimeout(_flushDebounceTimer); _flushDebounceTimer = null; }
    if (_flushMaxTimer) { clearTimeout(_flushMaxTimer); _flushMaxTimer = null; }
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    _firstDirtyAt = 0;

    _flushInFlight = (async () => {
        let hadTransientError = false;
        try {
            const keys = await idbKeysRaw(STORE_SYNC);
            const pendingEntries = [];
            for (const mk of keys) {
                const meta = await idbGetRaw(STORE_SYNC, mk);
                if (meta && meta.pending !== null) {
                    pendingEntries.push(meta);
                }
            }

            // Upload non-index records before index records so server has records ready
            pendingEntries.sort((a, b) => {
                const aIdx = a.store === 'sessions' && a.key.endsWith('::index') ? 1 : 0;
                const bIdx = b.store === 'sessions' && b.key.endsWith('::index') ? 1 : 0;
                return aIdx - bIdx;
            });

            await _runPool(pendingEntries, _UPLOAD_CONCURRENCY, async (meta) => {
                const res = await _uploadOneEntry(meta);
                if (res.transientError) hadTransientError = true;
            });
        } catch (err) {
            console.error('[remote_store] flush error:', err);
            hadTransientError = true;
        } finally {
            _lastFlushHadTransientError = hadTransientError;
            _flushInFlight = null;
        }

        if (hadTransientError) {
            _backoffMs = _backoffMs ? Math.min(60000, _backoffMs * 2) : 2000;
            _retryTimer = setTimeout(() => {
                _retryTimer = null;
                _runFlush();
            }, _backoffMs);
        } else {
            _backoffMs = 0;
            // Check if any writes landed during flight or new conflicts queued work
            let morePending = _flushRequested;
            _flushRequested = false;
            if (!morePending) {
                morePending = await _hasPendingEntries();
            }
            if (morePending) {
                _scheduleFlush();
            }
        }

        if (_pendingReloadSessions && window.rootHandle &&
            (typeof window.isAnySessionRunning !== 'function' || !window.isAnySessionRunning())) {
            await remoteReloadSessions();
        }
    })();

    return _flushInFlight;
}

async function remoteFlushNow({ drain = false, deadlineMs = 4500 } = {}) {
    if (!RemoteStore.enabled) return { ok: true };
    const deadline = Date.now() + deadlineMs;
    do {
        if (_markInFlight.size > 0) {
            await Promise.allSettled([..._markInFlight]);
        }
        await _runFlush();
        if (_flushInFlight) await _flushInFlight;
        if (!drain) break;
    } while (await _hasPendingEntries() && !_lastFlushHadTransientError && Date.now() < deadline);
    const ok = !(await _hasPendingEntries()) && !_lastFlushHadTransientError;
    return { ok };
}

// --- Hydration (§7.5) ---

async function remoteHydrate(store, prefix = '') {
    if (!RemoteStore.caps || !RemoteStore.caps.persistence) {
        return { changedKeys: [] };
    }
    let items;
    try {
        const resp = await fetch(_kvListUrl(store, prefix), { cache: 'no-store' });
        if (!resp.ok) return { changedKeys: [] };
        const data = await resp.json();
        items = Array.isArray(data?.items) ? data.items : [];
    } catch (e) {
        console.warn(`[remote_store] hydrate list failed for ${store}:`, e);
        return { changedKeys: [] };
    }

    const serverItemsMap = new Map();
    for (const it of items) serverItemsMap.set(it.key, it);

    // Order non-index records before ::index so index merge sees freshly hydrated records
    const ordered = items.slice().sort((a, b) => {
        const aIdx = store === 'sessions' && a.key.endsWith('::index') ? 1 : 0;
        const bIdx = store === 'sessions' && b.key.endsWith('::index') ? 1 : 0;
        return aIdx - bIdx;
    });

    const work = [];
    let downloadCount = 0;
    for (const item of ordered) {
        const mk = _syncMetaKey(store, item.key);
        const meta = (await idbGetRaw(STORE_SYNC, mk)) || {
            store, key: item.key, baseRev: 0, pending: null, dirtyGen: 0, lastHash: null
        };
        if (item.rev === meta.baseRev) continue;
        work.push({ item, meta });
        if (!item.deleted && meta.pending === null) downloadCount++;
    }

    if (downloadCount > 10 && typeof window.showToast === 'function') {
        window.showToast(`Syncing ${downloadCount} items from server…`, 'info', 3000);
    }

    const changedKeys = [];
    const regularWork = [];
    const indexWork = [];
    for (const w of work) {
        if (store === 'sessions' && w.item.key.endsWith('::index')) indexWork.push(w);
        else regularWork.push(w);
    }

    const processOne = async ({ item, meta }) => {
        try {
            if (meta.pending !== null && item.rev !== meta.baseRev) {
                await handleConflict(store, item.key, item.rev, serverItemsMap);
                changedKeys.push(item.key);
                return;
            }
            if (item.deleted) {
                await _deleteLocalRaw(store, item.key);
                await _withSyncMeta(store, item.key, (cur) => ({
                    ...cur,
                    baseRev: item.rev,
                    pending: null,
                    lastHash: null
                }));
                changedKeys.push(item.key);
                return;
            }
            const srv = await _fetchServerItem(store, item.key);
            if (srv.status === 410) {
                await _deleteLocalRaw(store, item.key);
                await _withSyncMeta(store, item.key, (cur) => ({
                    ...cur,
                    baseRev: srv.rev || item.rev,
                    pending: null,
                    lastHash: null
                }));
                changedKeys.push(item.key);
                return;
            }
            if (srv.status === 200) {
                const actualRev = srv.rev !== null ? srv.rev : item.rev;
                const applyRes = await _applyLocalRaw(store, item.key, srv.value, serverItemsMap);
                const needsReupload = !!(applyRes && applyRes.needsReupload);
                await _withSyncMeta(store, item.key, (cur) => ({
                    ...cur,
                    baseRev: actualRev,
                    pending: needsReupload ? 'put' : null,
                    dirtyGen: needsReupload ? (cur.dirtyGen || 0) + 1 : (cur.dirtyGen || 0),
                    lastHash: needsReupload ? null : (srv.rawText ? hash53(srv.rawText) : null)
                }));
                if (needsReupload) _scheduleFlush();
                changedKeys.push(item.key);
            }
        } catch (err) {
            console.warn(`[remote_store] hydrate item failed (${store}/${item.key}):`, err);
        }
    };

    await _runPool(regularWork, _HYDRATE_CONCURRENCY, processOne);
    for (const iw of indexWork) {
        await processOne(iw);
    }

    return { changedKeys };
}

async function remoteHydrateKey(store, key) {
    if (!RemoteStore.caps || !RemoteStore.caps.persistence) {
        return { changed: false };
    }
    try {
        const mk = _syncMetaKey(store, key);
        const meta = (await idbGetRaw(STORE_SYNC, mk)) || {
            store, key, baseRev: 0, pending: null, dirtyGen: 0, lastHash: null
        };
        const srv = await _fetchServerItem(store, key);
        if (srv.status === 404) {
            if (store === 'vws') wbSyncDebug('hydrateKey:vws', { key, metaBaseRev: meta.baseRev, serverRev: 0, action: '404' });
            return { changed: false };
        }
        const serverRev = srv.rev || 0;
        if (serverRev === meta.baseRev) {
            if (store === 'vws') wbSyncDebug('hydrateKey:vws', { key, metaBaseRev: meta.baseRev, serverRev, action: 'unchanged' });
            return { changed: false };
        }

        if (meta.pending !== null && serverRev !== meta.baseRev) {
            if (store === 'vws') wbSyncDebug('hydrateKey:vws', { key, metaBaseRev: meta.baseRev, serverRev, action: 'conflict' });
            await handleConflict(store, key, serverRev);
            return { changed: true };
        }
        if (srv.status === 410) {
            if (store === 'vws') wbSyncDebug('hydrateKey:vws', { key, metaBaseRev: meta.baseRev, serverRev, action: 'delete-410' });
            await _deleteLocalRaw(store, key);
            await _withSyncMeta(store, key, (cur) => ({
                ...cur,
                baseRev: serverRev,
                pending: null,
                lastHash: null
            }));
            return { changed: true };
        }
        if (srv.status === 200) {
            if (store === 'vws') wbSyncDebug('hydrateKey:vws', { key, metaBaseRev: meta.baseRev, serverRev, action: 'apply-200' });
            await _applyLocalRaw(store, key, srv.value, null);
            await _withSyncMeta(store, key, (cur) => ({
                ...cur,
                baseRev: serverRev,
                pending: null,
                lastHash: srv.rawText ? hash53(srv.rawText) : null
            }));
            return { changed: true };
        }
    } catch (e) {
        console.warn(`[remote_store] remoteHydrateKey failed (${store}/${key}):`, e);
    }
    return { changed: false };
}

// --- Open Workspace Refresh & Reload (§8.5) ---

async function remoteReloadSessions() {
    if (!window.rootHandle || (typeof window.isAnySessionRunning === 'function' && window.isAnySessionRunning())) {
        _pendingReloadSessions = true;
        return;
    }
    _pendingReloadSessions = false;
    try {
        state.sessions = {};
        if (typeof window.selectInitialSession === 'function') {
            await window.selectInitialSession();
        }
        if (typeof window.restoreActiveSessionContent === 'function') {
            await window.restoreActiveSessionContent();
        }
        if (typeof window.renderSessionPopoverList === 'function') {
            window.renderSessionPopoverList();
        }
    } catch (err) {
        console.error('[remote_store] remoteReloadSessions failed:', err);
    }
}

async function remoteRefreshCurrentWorkspace() {
    if (!RemoteStore.enabled) return;
    const now = Date.now();
    if (now - _lastRefreshAt < _REFRESH_THROTTLE_MS) return;
    _lastRefreshAt = now;

    try {
        const catRes = await remoteHydrate('catalog', '');
        if (catRes.changedKeys.length > 0) {
            if (typeof window.isNoFolderOverlayHidden === 'function' && !window.isNoFolderOverlayHidden()) {
                if (typeof window.renderRecentFoldersList === 'function') window.renderRecentFoldersList();
            }
            const wsOverlay = document.getElementById('workspaces-popover-overlay');
            if (wsOverlay && wsOverlay.style.display === 'block' && typeof window.renderWorkspacePopoverList === 'function') {
                window.renderWorkspacePopoverList();
            }
        }

        const setRes = await remoteHydrate('settings', '');
        if (setRes.changedKeys.length > 0) {
            _applyHydratedSettingsToRuntime();
        }

        if (window.rootHandle && typeof window.getWorkspaceSessionKey === 'function' && typeof window.currentWsName === 'function') {
            const wsKey = window.getWorkspaceSessionKey();
            const ws = window.currentWsName();
            const sessRes = await remoteHydrate('sessions', wsKey + '::');
            const baseRes = await remoteHydrate('baselines', ws + '::');

            const activeId = window.state ? window.state.activeSessionId : null;
            const activeSessKey = activeId ? `${wsKey}::session::${activeId}` : null;
            const activeBaseKey = activeId ? `${ws}::${activeId}` : null;
            const indexKey = `${wsKey}::index`;

            const activeChanged =
                sessRes.changedKeys.includes(indexKey) ||
                (activeSessKey && sessRes.changedKeys.includes(activeSessKey)) ||
                (activeBaseKey && baseRes.changedKeys.includes(activeBaseKey));

            if (activeChanged) {
                await remoteReloadSessions();
            } else if (sessRes.changedKeys.length > 0) {
                // Drop cached inactive sessions that changed on server so switching loads fresh data
                const prefix = `${wsKey}::session::`;
                for (const ck of sessRes.changedKeys) {
                    if (ck.startsWith(prefix)) {
                        const sid = ck.slice(prefix.length);
                        if (window.state && window.state.sessions && sid !== activeId) {
                            delete window.state.sessions[sid];
                        }
                    }
                }
                if (typeof window.renderSessionPopoverList === 'function') {
                    window.renderSessionPopoverList();
                }
            }
        }
    } catch (err) {
        console.warn('[remote_store] refresh on focus failed:', err);
    }
}

// --- Seed Pre-existing Browser Data (§7.3 step 5) ---

async function _seedLocalData() {
    // Normalize pre-existing catalog entries with id, sameOrigin, and frozen legacy storageKey
    const catalog = _readCatalogRaw();
    let catalogMutated = false;
    for (const entry of catalog) {
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.id) {
            entry.id = makeSyncId();
            catalogMutated = true;
        }
        if (entry.type === 'webdav' && entry.url === window.location.origin && !entry.sameOrigin) {
            entry.sameOrigin = true;
            catalogMutated = true;
        }
        if (!entry.storageKey) {
            const legacy = _computeLegacyStorageKeyForCatalogEntry(entry);
            if (legacy) {
                entry.storageKey = legacy;
                catalogMutated = true;
            }
        }
    }
    if (catalogMutated) {
        _writeCatalogRaw(catalog);
    } else {
        _rebuildCatalogSnapshot(catalog);
    }

    const markSeed = async (store, key) => {
        const mk = _syncMetaKey(store, key);
        const existing = await idbGetRaw(STORE_SYNC, mk);
        if (!existing) {
            await idbPutRaw(STORE_SYNC, mk, {
                store,
                key,
                baseRev: 0,
                pending: 'put',
                dirtyGen: 1,
                lastHash: null
            });
        }
    };

    for (const entry of catalog) {
        if (entry && entry.id) {
            await markSeed('catalog', entry.id);
        }
    }

    try {
        for (const k of await idbKeysRaw(STORE_SESSIONS)) {
            await markSeed('sessions', String(k));
        }
    } catch (e) {}

    try {
        for (const k of await idbKeysRaw(STORE_BASELINES)) {
            await markSeed('baselines', String(k));
        }
    } catch (e) {}

    await _seedSettingsData();
    await _seedVwsData();
    _rawLsSet('sync_seeded', '1');
}

async function _seedVwsData() {
    try {
        for (const k of await idbKeysRaw(STORE_HANDLES)) {
            const ks = String(k);
            if (!ks.startsWith('vws_')) continue;
            const mk = _syncMetaKey('vws', ks);
            const existing = await idbGetRaw(STORE_SYNC, mk);
            if (!existing) {
                await idbPutRaw(STORE_SYNC, mk, {
                    store: 'vws',
                    key: ks,
                    baseRev: 0,
                    pending: 'put',
                    dirtyGen: 1,
                    lastHash: null
                });
            }
        }
    } catch (e) {}
    _rawLsSet('sync_seeded_vws', '1');
}

async function _seedSettingsData() {
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!isSyncedLsKey(k)) continue;
            const mk = _syncMetaKey('settings', k);
            const existing = await idbGetRaw(STORE_SYNC, mk);
            if (!existing) {
                await idbPutRaw(STORE_SYNC, mk, {
                    store: 'settings',
                    key: k,
                    baseRev: 0,
                    pending: 'put',
                    dirtyGen: 1,
                    lastHash: null
                });
            }
        }
    } catch (e) {}
    _rawLsSet('sync_seeded_settings', '1');
}

// --- Initialization (§7.3) ---

async function remoteInit() {
    // 1. Request persistent browser storage even when server is unavailable
    try {
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().catch(() => {});
        }
    } catch (e) {}

    // 2. Discover server capabilities (3s timeout)
    let caps = null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
            const resp = await fetch('/api/v1/capabilities', {
                cache: 'no-store',
                signal: ctrl.signal
            });
            if (resp.ok) {
                caps = await resp.json();
            }
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        caps = null;
    }

    if (!caps || caps.persistence !== true) {
        RemoteStore.enabled = false;
        RemoteStore.caps = caps;
        _rebuildCatalogSnapshot(_readCatalogRaw());
        _finishRemoteReady(false);
        return;
    }

    RemoteStore.caps = caps;

    // 3. Stable per-browser diagnostic client ID
    _clientId = localStorage.getItem('sync_client_id');
    if (!_clientId) {
        _clientId = makeSyncId();
        _rawLsSet('sync_client_id', _clientId);
    }

    // 4. Detect fresh browser or different server
    if (localStorage.getItem('sync_server_id') !== caps.serverId) {
        try { await idbClearRaw(STORE_SYNC); } catch (e) {}
        _rawLsSet('sync_server_id', caps.serverId || '');
        _rawLsRemove('sync_seeded');
        _rawLsRemove('sync_seeded_settings');
        _rawLsRemove('sync_seeded_vws');
    }

    // 5. First-time seed of pre-existing browser data
    if (!localStorage.getItem('sync_seeded')) {
        await _seedLocalData();
    } else {
        if (!localStorage.getItem('sync_seeded_settings')) {
            await _seedSettingsData();
        }
        if (!localStorage.getItem('sync_seeded_vws')) {
            await _seedVwsData();
        }
        _rebuildCatalogSnapshot(_readCatalogRaw());
    }

    // 6. Hydrate catalog and settings before startup reads localStorage
    await remoteHydrate('catalog', '');
    await remoteHydrate('settings', '');

    // 7. Enable sync, start uploader, register lifecycle listeners
    RemoteStore.enabled = true;
    _rebuildCatalogSnapshot(_readCatalogRaw());

    if (!_listenersBound) {
        _listenersBound = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                remoteFlushNow();
            } else if (document.visibilityState === 'visible') {
                if (_lease.mode === 'writer') {
                    _sendLeaseHeartbeat();
                } else if (_lease.mode === 'readonly') {
                    _pollLeaseStatus(true);
                }
                remoteRefreshCurrentWorkspace();
            }
        });
        window.addEventListener('pagehide', () => {
            remoteReleaseWorkspaceLease({ beacon: true });
            remoteFlushNow();
        });
        window.addEventListener('pageshow', (ev) => {
            if (ev.persisted && window.rootHandle && typeof window.currentWsName === 'function') {
                if (window.rootHandle.isVirtual && window.rootHandle._n && window.rootHandle._n._ws) {
                    window.rootHandle._n._ws.stale = true;
                }
                remoteAcquireWorkspaceLease(window.currentWsName()).then(async () => {
                    const ro = isWorkspaceReadOnly();
                    if (!ro && window.rootHandle && window.rootHandle.isVirtual) {
                        try {
                            const ok = await remoteReopenWorkspace({ flushOld: false, keepView: true });
                            if (ok && typeof window.setWorkspaceReadOnly === 'function') {
                                window.setWorkspaceReadOnly(false);
                            }
                        } catch (e) {}
                    } else if (typeof window.setWorkspaceReadOnly === 'function') {
                        window.setWorkspaceReadOnly(ro);
                    }
                }).catch(() => {});
            }
        });
    }

    _finishRemoteReady(true);

    // Kick off initial upload pass for any seeded or pending entries (non-blocking)
    _scheduleFlush();
}

// =========================================================================
// Single-Active-Workspace Lease & Read-Only Handoff
// =========================================================================

function _detectClientLabel() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
    let browser = 'Browser';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Chrome\//i.test(ua) || /CriOS\//i.test(ua)) browser = 'Chrome';
    else if (/Safari\//i.test(ua)) browser = 'Safari';

    let os = '';
    if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/CrOS/i.test(ua)) os = 'ChromeOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    return os ? `${browser} on ${os}` : browser;
}

const _tabId = makeSyncId();
const _tabLabel = _detectClientLabel();
let _lease = {
    wsKey: null,
    mode: 'none',          // 'none' | 'writer' | 'readonly'
    epoch: 0,
    holder: null,          // serialized holder when readonly (or null = free)
    revoked: false,        // we held it and lost it
    takingOver: false,
    revoking: null,        // Promise while _handleLeaseRevoked runs (idempotency)
    heartbeatTimer: null,
    pollTimer: null,
    eventSource: null,
    lastBusySent: false
};

function isWorkspaceReadOnly() {
    return _lease.mode === 'readonly';
}

function getWorkspaceLeaseState() {
    return {
        wsKey: _lease.wsKey,
        mode: _lease.mode,
        epoch: _lease.epoch,
        holder: _lease.holder,
        revoked: _lease.revoked,
        takingOver: _lease.takingOver,
        revoking: !!_lease.revoking,
        tabId: _tabId,
        myClientId: _clientId
    };
}

function _computeBusy() {
    if (!window.state || !window.state.sessions || typeof window.isSessionRunning !== 'function') {
        return false;
    }
    return Object.keys(window.state.sessions).some((id) => window.isSessionRunning(id));
}

function _stopLeaseHeartbeat() {
    if (_lease.heartbeatTimer) {
        clearInterval(_lease.heartbeatTimer);
        _lease.heartbeatTimer = null;
    }
}

function _stopLeasePoll() {
    if (_lease.pollTimer) {
        clearInterval(_lease.pollTimer);
        _lease.pollTimer = null;
    }
}

function _closeLeaseStream() {
    if (_lease.eventSource) {
        try { _lease.eventSource.close(); } catch (e) {}
        _lease.eventSource = null;
    }
}

function _openLeaseStream(wsKey) {
    _closeLeaseStream();
    if (!RemoteStore.enabled || !RemoteStore.caps?.leases || !wsKey) return;
    if (typeof EventSource === 'undefined') return;
    try {
        const url = `/api/v1/leases/events?wsKey=${encodeURIComponent(wsKey)}&tabId=${encodeURIComponent(_tabId)}`;
        const es = new EventSource(url);
        _lease.eventSource = es;
        es.addEventListener('revoke', (ev) => {
            if (_lease.eventSource !== es || _lease.wsKey !== wsKey) return;
            let payload = {};
            try { payload = JSON.parse(ev.data || '{}'); } catch (e) {}
            _handleLeaseRevoked(payload);
        });
        es.onerror = () => {
            // Do not close on error; EventSource reconnects automatically.
        };
    } catch (e) {}
}

async function _sendLeaseHeartbeat() {
    if (!RemoteStore.enabled || !RemoteStore.caps?.leases) return;
    if (_lease.mode !== 'writer' || !_lease.wsKey || _lease.revoking) return;
    const wsKey = _lease.wsKey;
    const busy = _computeBusy();
    _lease.lastBusySent = busy;
    try {
        const resp = await fetch('/api/v1/leases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wsKey,
                tabId: _tabId,
                clientId: _clientId || '',
                label: _tabLabel,
                busy,
                force: false,
                abortBusy: false
            }),
            cache: 'no-store'
        });
        let data = null;
        try { data = await resp.json(); } catch (e) {}
        if (_lease.wsKey !== wsKey || _lease.mode !== 'writer' || _lease.revoking) return;
        if (resp.status === 200 && data && data.granted) {
            if (data.lease && typeof data.lease.epoch === 'number') {
                _lease.epoch = data.lease.epoch;
            }
            if (!_lease.eventSource) {
                _openLeaseStream(wsKey);
            }
        } else if (resp.status === 409) {
            _handleLeaseRevoked({
                handoffId: null,
                newLabel: data?.holder?.label || null,
                abortBusy: false
            });
        }
    } catch (e) {
        // Network error: remain writer, next heartbeat will retry.
    }
}

function _startLeaseHeartbeat() {
    _stopLeaseHeartbeat();
    const intervalMs = (RemoteStore.caps && RemoteStore.caps.leaseHeartbeatMs) || 10000;
    _lease.heartbeatTimer = setInterval(() => {
        _sendLeaseHeartbeat();
    }, intervalMs);
}

let _staleReopenPending = false;
let _staleReopenTimer = null;
let _readOnlyRefreshing = false;
let _lastReadOnlyRefreshAt = 0;

function _isAnyModalOpenForAutoRefresh() {
    if (typeof window.getOpenModalCount === 'function' && window.getOpenModalCount() > 0) {
        return true;
    }
    const yesno = document.getElementById('yesno-modal-overlay');
    if (yesno && yesno.style.display && yesno.style.display !== 'none') {
        return true;
    }
    return false;
}

function _tryRunStaleWorkspaceReopen() {
    if (!_staleReopenPending) return;
    if (_staleReopenTimer) {
        clearTimeout(_staleReopenTimer);
        _staleReopenTimer = null;
    }
    if (!window.rootHandle || !window.rootHandle.isVirtual) {
        _staleReopenPending = false;
        return;
    }
    if (_lease.takingOver || _lease.revoking || window.state?.workspaceReloading) {
        _staleReopenTimer = setTimeout(_tryRunStaleWorkspaceReopen, 2000);
        return;
    }
    if (_lease.mode === 'readonly') {
        const ws = window.rootHandle._n && window.rootHandle._n._ws;
        if (ws && ws.forkVid) {
            _staleReopenTimer = setTimeout(_tryRunStaleWorkspaceReopen, 2000);
            return;
        }
        if (_isAnyModalOpenForAutoRefresh()) {
            _staleReopenTimer = setTimeout(_tryRunStaleWorkspaceReopen, 2000);
            return;
        }
        _staleReopenPending = false;
        remoteRefreshReadOnlyWorkspace({ silent: true });
        return;
    }
    const busy = (typeof window.isAnySessionRunning === 'function' && window.isAnySessionRunning())
        || !!(window.state && window.state.isSaving);
    if (busy) {
        _staleReopenTimer = setTimeout(_tryRunStaleWorkspaceReopen, 2000);
        return;
    }
    _staleReopenPending = false;
    remoteReopenWorkspace({ flushOld: true, keepView: true }).catch(() => {});
}

function scheduleStaleWorkspaceReopen() {
    _staleReopenPending = true;
    if (_staleReopenTimer) clearTimeout(_staleReopenTimer);
    _staleReopenTimer = setTimeout(_tryRunStaleWorkspaceReopen, 250);
}

async function _pollLeaseStatus(force = false) {
    if (!RemoteStore.enabled || !RemoteStore.caps?.leases) return;
    if (_lease.mode !== 'readonly' || !_lease.wsKey) return;
    if (!force && document.visibilityState !== 'visible') return;
    const wsKey = _lease.wsKey;
    try {
        const resp = await fetch(`/api/v1/leases?wsKey=${encodeURIComponent(wsKey)}`, {
            cache: 'no-store'
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (_lease.wsKey !== wsKey || _lease.mode !== 'readonly') return;
        _lease.holder = data.holder || null;
        if (typeof window.updateWorkspaceLeaseBanner === 'function') {
            window.updateWorkspaceLeaseBanner();
        }
    } catch (e) {
        return;
    }

    if (
        _lease.wsKey === wsKey &&
        _lease.mode === 'readonly' &&
        !_lease.takingOver &&
        !_lease.revoking &&
        !_readOnlyRefreshing &&
        !window.state?.workspaceReloading &&
        window.rootHandle &&
        window.rootHandle.isVirtual &&
        window.rootHandle._n &&
        window.rootHandle._n._ws &&
        window.rootHandle._n._ws.vid
    ) {
        const vid = window.rootHandle._n._ws.vid;
        const curRev = window.rootHandle._n._ws.rev || 0;
        const vwsKey = 'vws_' + vid;
        try {
            const listResp = await fetch(_kvListUrl('vws', vwsKey), { cache: 'no-store' });
            if (listResp.ok) {
                const listData = await listResp.json();
                const items = Array.isArray(listData?.items) ? listData.items : [];
                const match = items.find((it) => it && it.key === vwsKey);
                if (
                    match &&
                    typeof match.rev === 'number' &&
                    match.rev > curRev &&
                    _lease.wsKey === wsKey &&
                    _lease.mode === 'readonly' &&
                    !_lease.takingOver &&
                    !_lease.revoking &&
                    !window.state?.workspaceReloading &&
                    !_isAnyModalOpenForAutoRefresh()
                ) {
                    wbSyncDebug('poll:vws-auto-refresh', { vid, curRev, serverRev: match.rev });
                    await remoteRefreshReadOnlyWorkspace({ silent: true });
                }
            }
        } catch (e) {}
    }
}

function _startLeasePoll() {
    _stopLeasePoll();
    const intervalMs = (RemoteStore.caps && RemoteStore.caps.leasePollMs) || 5000;
    _lease.pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
            _pollLeaseStatus(false);
        }
    }, intervalMs);
}

function remoteLeaseBusyMaybeChanged() {
    if (_staleReopenPending) {
        _tryRunStaleWorkspaceReopen();
    }
    if (!RemoteStore.enabled || !RemoteStore.caps?.leases) return;
    if (_lease.mode !== 'writer' || !_lease.wsKey || _lease.revoking) return;
    const busy = _computeBusy();
    if (busy !== _lease.lastBusySent) {
        _sendLeaseHeartbeat();
    }
}

async function remoteAcquireWorkspaceLease(wsKey) {
    _stopLeaseHeartbeat();
    _stopLeasePoll();
    _closeLeaseStream();
    _lease.revoking = null;
    _lease.takingOver = false;
    _lease.revoked = false;
    _lease.holder = null;
    _lease.epoch = 0;
    _lease.wsKey = wsKey || null;

    if (!wsKey || !RemoteStore.enabled || !RemoteStore.caps?.leases) {
        _lease.mode = wsKey ? 'writer' : 'none';
        return { mode: _lease.mode, granted: true };
    }

    const busy = _computeBusy();
    _lease.lastBusySent = busy;

    try {
        const resp = await fetch('/api/v1/leases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wsKey,
                tabId: _tabId,
                clientId: _clientId || '',
                label: _tabLabel,
                busy,
                force: false,
                abortBusy: false
            }),
            cache: 'no-store'
        });
        let data = null;
        try { data = await resp.json(); } catch (e) {}

        if (_lease.wsKey !== wsKey) {
            return { mode: _lease.mode, granted: _lease.mode === 'writer' };
        }

        if (resp.status === 200 && data && data.granted) {
            _lease.mode = 'writer';
            _lease.epoch = data.lease?.epoch || 1;
            _lease.holder = null;
            _openLeaseStream(wsKey);
            _startLeaseHeartbeat();
            return { mode: 'writer', granted: true, lease: data.lease };
        }

        if (resp.status === 409) {
            _lease.mode = 'readonly';
            _lease.holder = data?.holder || null;
            _startLeasePoll();
            if (typeof window.updateWorkspaceLeaseBanner === 'function') {
                window.updateWorkspaceLeaseBanner();
            }
            return { mode: 'readonly', granted: false, holder: _lease.holder };
        }

        // 5xx or unexpected status: fail open, still start heartbeat
        _lease.mode = 'writer';
        _startLeaseHeartbeat();
        return { mode: 'writer', granted: true, failOpen: true };
    } catch (e) {
        // Network error: fail open, still start heartbeat
        if (_lease.wsKey === wsKey) {
            _lease.mode = 'writer';
            _startLeaseHeartbeat();
        }
        return { mode: 'writer', granted: true, failOpen: true };
    }
}

function remoteReleaseWorkspaceLease({ beacon = false } = {}) {
    const wsKey = _lease.wsKey;
    const wasWriter = _lease.mode === 'writer' && !!wsKey;

    _stopLeaseHeartbeat();
    _stopLeasePoll();
    _closeLeaseStream();

    _lease.wsKey = null;
    _lease.mode = 'none';
    _lease.epoch = 0;
    _lease.holder = null;
    _lease.revoked = false;
    _lease.takingOver = false;
    _lease.revoking = null;
    _lease.lastBusySent = false;

    if (!beacon && typeof window.setWorkspaceReadOnly === 'function') {
        window.setWorkspaceReadOnly(false);
    }

    if (wasWriter && RemoteStore.enabled && RemoteStore.caps?.leases) {
        const payload = JSON.stringify({ wsKey, tabId: _tabId });
        if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            try {
                navigator.sendBeacon('/api/v1/leases/release', new Blob([payload], { type: 'application/json' }));
                return;
            } catch (e) {}
        }
        try {
            fetch('/api/v1/leases/release', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).catch(() => {});
        } catch (e) {}
    }
}

async function _handleLeaseRevoked({ handoffId = null, newLabel = null, abortBusy = false } = {}) {
    if (_lease.revoking) return _lease.revoking;
    if (_lease.mode !== 'writer' || !_lease.wsKey) return;

    const wsKey = _lease.wsKey;
    const run = (async () => {
        try {
            wbSyncDebug('revoke:start', { wsKey, handoffId, newLabel, abortBusy });

            // 1. Stop heartbeat; lock UI only while storage remains in 'writer' mode.
            _stopLeaseHeartbeat();
            if (typeof window.setWorkspaceReadOnly === 'function') {
                window.setWorkspaceReadOnly(true);
            }

            // 2. Abort any running generation and explicitly save partial turns.
            if (window.state && window.state.sessions && typeof window.isSessionRunning === 'function') {
                for (const id of Object.keys(window.state.sessions)) {
                    if (window.isSessionRunning(id)) {
                        wbSyncDebug('revoke:abort-running', { sessionId: id });
                        if (typeof window.abortGeneration === 'function') {
                            window.abortGeneration({ showResumeUI: false, sessionId: id });
                        }
                        if (typeof window.getGenState === 'function') {
                            window.getGenState(id).hasNewContent = true;
                        }
                        if (typeof window.saveSession === 'function') {
                            await window.saveSession(id, true);
                        }
                    }
                }
            }

            // 3. Persist active session state.
            if (
                window.state &&
                window.state.sessions &&
                window.state.sessions[window.state.activeSessionId] &&
                typeof window.saveActiveSession === 'function'
            ) {
                wbSyncDebug('revoke:save-session', { sessionId: window.state.activeSessionId });
                await window.saveActiveSession(true);
            }

            // 4. Flush virtual workspace snapshot if dirty or already flushing.
            if (window.rootHandle && window.rootHandle.isVirtual && window.rootHandle._n) {
                if (window.rootHandle._n._dirty && typeof window.vfsFlush === 'function') {
                    wbSyncDebug('revoke:vfs-flush', { vid: window.rootHandle._n._ws?.vid });
                    await window.vfsFlush(window.rootHandle);
                } else if (window.rootHandle._n._flushPromise) {
                    wbSyncDebug('revoke:vfs-await-inflight', { vid: window.rootHandle._n._ws?.vid });
                    await window.rootHandle._n._flushPromise.catch(() => {});
                }
            }

            // 4b. Snapshot WebDAV per-workspace settings if changed so the incoming tab receives them.
            if (
                window.rootHandle &&
                window.rootHandle.isWebDAV &&
                window.AppConfig &&
                window.AppConfig.get('webdav-sync-agent') !== 'true' &&
                typeof window.wsStorageName === 'function'
            ) {
                const webdavWsKey = window.wsStorageName(window.rootHandle);
                if (webdavWsKey) {
                    const putIfChanged = (k, val) => {
                        try {
                            const s = JSON.stringify(val);
                            if (localStorage.getItem(k) !== s) localStorage.setItem(k, s);
                        } catch (e) {}
                    };
                    if (window.AppConfig._data) putIfChanged(`app_config_${webdavWsKey}`, window.AppConfig._data);
                    if (typeof window.MODEL_PROVIDERS !== 'undefined') putIfChanged(`models_${webdavWsKey}`, window.MODEL_PROVIDERS);
                    if (typeof window.MODE_PROMPTS !== 'undefined') putIfChanged(`mode_prompts_${webdavWsKey}`, window.MODE_PROMPTS);
                    if (typeof window.getWorkspaceToolsConfig === 'function') {
                        const cfg = window.getWorkspaceToolsConfig();
                        if (cfg) putIfChanged(`tools_config_${webdavWsKey}`, cfg);
                    }
                }
            }

            // 5. Drain outbox to server within handoff deadline.
            const flushRes = (await remoteFlushNow({ drain: true, deadlineMs: 4500 })) || {};
            const clean = !!flushRes.ok;
            wbSyncDebug('revoke:drained', { wsKey, clean });

            // 6. Ack handoff BEFORE closing SSE stream so server receives clean status.
            if (handoffId) {
                try {
                    wbSyncDebug('revoke:ack', { wsKey, handoffId, clean });
                    await fetch('/api/v1/leases/ack', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ wsKey, tabId: _tabId, handoffId, clean }),
                        cache: 'no-store'
                    });
                } catch (e) {}
            }

            // 7. Switch storage to read-only, mark virtual tree stale, close SSE, start polling.
            if (window.rootHandle && window.rootHandle.isVirtual && window.rootHandle._n && window.rootHandle._n._ws) {
                window.rootHandle._n._ws.stale = true;
            }
            if (_lease.wsKey === wsKey) {
                _lease.mode = 'readonly';
                _lease.revoked = true;
                _lease.holder = { label: newLabel || 'another window', busy: false };
                _closeLeaseStream();
                _startLeasePoll();
            }
            wbSyncDebug('revoke:done', { wsKey });

            // 8. Warn if unsaved editor buffers remain.
            if (
                window.state &&
                window.state.dirtyFiles &&
                window.state.dirtyFiles.size > 0 &&
                typeof window.showToast === 'function'
            ) {
                const n = window.state.dirtyFiles.size;
                window.showToast(
                    `You have ${n} unsaved editor change${n === 1 ? '' : 's'}. They are kept here; Take Over to save them.`,
                    'info',
                    4000
                );
            }
        } finally {
            _lease.revoking = null;
            if (_lease.wsKey === wsKey && typeof window.updateWorkspaceLeaseBanner === 'function') {
                window.updateWorkspaceLeaseBanner();
            }
        }
    })();

    _lease.revoking = run;
    if (typeof window.updateWorkspaceLeaseBanner === 'function') {
        window.updateWorkspaceLeaseBanner();
    }
    return run;
}

function _applyHydratedSettingsToRuntime() {
    if (window.AppConfig && typeof window.AppConfig.reload === 'function') {
        window.AppConfig.reload();
    }
    if (typeof window.reloadModelsFromStorage === 'function') {
        window.reloadModelsFromStorage();
    }
    try {
        const wsKey = window.rootHandle && window.rootHandle.isWebDAV && typeof window.wsStorageName === 'function'
            ? window.wsStorageName(window.rootHandle)
            : null;
        const rawPrompts = (wsKey && localStorage.getItem(`mode_prompts_${wsKey}`)) || localStorage.getItem('mode_prompts_json');
        if (rawPrompts) {
            const parsedPrompts = JSON.parse(rawPrompts);
            if (parsedPrompts && typeof parsedPrompts === 'object' && !Array.isArray(parsedPrompts)) {
                if (window.MODE_PROMPTS && typeof window.MODE_PROMPTS === 'object') {
                    for (const k of Object.keys(window.MODE_PROMPTS)) delete window.MODE_PROMPTS[k];
                    Object.assign(window.MODE_PROMPTS, parsedPrompts);
                } else {
                    window.MODE_PROMPTS = parsedPrompts;
                }
            }
        }
    } catch (e) {}
    if (typeof window.applyConfigToUI === 'function') {
        window.applyConfigToUI();
    }
    if (typeof window.registerConfigVirtualFile === 'function') {
        window.registerConfigVirtualFile();
    }
    if (typeof window.renderModelDropdown === 'function') {
        window.renderModelDropdown();
    }
}

function _detachLiveVirtualTree(h = window.rootHandle) {
    if (!h || !h.isVirtual || !h._n) return null;
    const n = h._n;
    const vid = (n._ws && n._ws.vid) || n._detachedVid || null;
    clearTimeout(n._t);
    n._dirty = false;
    n._ws = null;
    n._detachedVid = vid;
    return vid;
}

async function remoteReopenWorkspace({ flushOld = false, keepView = true, vid: explicitVid = null } = {}) {
    const h = window.rootHandle;
    if (!h) return false;
    const isVirtual = !!h.isVirtual;
    const n = isVirtual ? h._n : null;
    const vid = explicitVid || (n && ((n._ws && n._ws.vid) || n._detachedVid)) || null;

    wbSyncDebug('reopen:start', { isVirtual, vid, flushOld, keepView, mode: _lease.mode });

    // Synchronous detach before any await when not flushing the old tree (R3)
    if (!flushOld && isVirtual) {
        _detachLiveVirtualTree(h);
    }

    if (window.state) window.state.workspaceReloading = true;
    try {
        if (flushOld && isVirtual && n) {
            if (n._dirty && typeof window.vfsFlush === 'function') {
                wbSyncDebug('reopen:flushOld', { vid });
                await window.vfsFlush(h);
            } else if (n._flushPromise) {
                await n._flushPromise.catch(() => {});
            }
            _detachLiveVirtualTree(h);
        }

        wbSyncDebug('reopen:hydrate-settings', { vid });
        if (RemoteStore.enabled) {
            await remoteHydrate('settings', '');
        }
        _applyHydratedSettingsToRuntime();

        if (isVirtual) {
            wbSyncDebug('reopen:load-snapshot', { vid });
            const snap = await window.loadVirtualSnapshot(vid);
            if (!snap) {
                wbSyncDebug('reopen:snapshot-missing', { vid });
                if (_lease.mode === 'writer') {
                    remoteReleaseWorkspaceLease();
                }
                if (typeof window.showToast === 'function') {
                    window.showToast('Virtual workspace data not found', 'error');
                }
                if (typeof window.closeWorkspace === 'function') {
                    window.closeWorkspace();
                }
                return false;
            }
            wbSyncDebug('reopen:setWorkspace', {
                vid,
                token: typeof window.vfsSnapToken === 'function' ? window.vfsSnapToken(snap) : null,
                rev: snap.__rev || 0
            });
            await window.setWorkspace(window.buildVirtualHandle(vid, snap), { reopen: true, keepView });
        } else {
            wbSyncDebug('reopen:setWorkspace', { nonVirtual: true });
            await window.setWorkspace(h, { reopen: true, keepView });
        }
        wbSyncDebug('reopen:done', { vid });
        return true;
    } catch (err) {
        wbSyncDebug('reopen:error', { vid, error: err?.message || String(err) });
        console.error('[remote_store] remoteReopenWorkspace failed:', err);
        if (_lease.mode === 'writer') {
            remoteReleaseWorkspaceLease();
        }
        if (typeof window.closeWorkspace === 'function') {
            try { window.closeWorkspace(); } catch (e) {}
        }
        if (typeof window.showToast === 'function') {
            window.showToast(
                'Could not reload the workspace. It was closed to protect your data; open it again.',
                'error',
                6000
            );
        }
        if (err && typeof err === 'object') err._reopenHandled = true;
        throw err;
    } finally {
        if (window.state) window.state.workspaceReloading = false;
    }
}

async function remoteRefreshReadOnlyWorkspace({ silent = false } = {}) {
    if (!window.rootHandle || _readOnlyRefreshing) return;
    if (silent && (Date.now() - _lastReadOnlyRefreshAt < 5000)) return;
    _readOnlyRefreshing = true;
    _lastReadOnlyRefreshAt = Date.now();
    try {
        const ok = await remoteReopenWorkspace({ flushOld: false, keepView: true });
        if (!ok) return;
        await _pollLeaseStatus(true);
        if (!silent && typeof window.showToast === 'function') {
            window.showToast('Workspace refreshed', 'info', 2000);
        }
    } catch (e) {
        // R4 close + toast already handled inside remoteReopenWorkspace
    } finally {
        _readOnlyRefreshing = false;
    }
}

async function remoteTakeOverWorkspace() {
    if (_lease.takingOver || _lease.mode !== 'readonly' || !_lease.wsKey) return;
    const wsKey = _lease.wsKey;

    const confirmBusy = async (holder) => {
        const lbl = (holder && holder.label) ? holder.label : 'Another window';
        if (typeof window.confirmDialog === 'function') {
            return await window.confirmDialog(
                `${lbl} is generating a response. Taking over stops it. Continue?`,
                { confirmLabel: 'Stop & Take Over', danger: true }
            );
        }
        return true;
    };

    let abortBusy = false;
    if (_lease.holder && _lease.holder.busy) {
        const ok = await confirmBusy(_lease.holder);
        if (!ok) return;
        abortBusy = true;
    }

    _lease.takingOver = true;
    if (typeof window.updateWorkspaceLeaseBanner === 'function') {
        window.updateWorkspaceLeaseBanner();
    }

    const postTakeover = async (withAbortBusy) => {
        const resp = await fetch('/api/v1/leases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wsKey,
                tabId: _tabId,
                clientId: _clientId || '',
                label: _tabLabel,
                busy: false,
                force: true,
                abortBusy: !!withAbortBusy
            }),
            cache: 'no-store'
        });
        let data = null;
        try { data = await resp.json(); } catch (e) {}
        return { status: resp.status, data };
    };

    try {
        let res = await postTakeover(abortBusy);
        if (res.status === 409 && res.data && res.data.busyConflict && !abortBusy) {
            _lease.holder = res.data.holder || _lease.holder;
            if (typeof window.updateWorkspaceLeaseBanner === 'function') {
                window.updateWorkspaceLeaseBanner();
            }
            const ok = await confirmBusy(_lease.holder);
            if (!ok) return;
            abortBusy = true;
            res = await postTakeover(true);
        }

        if (res.status === 409 && res.data && res.data.handoffInProgress) {
            if (typeof window.showToast === 'function') {
                window.showToast('Another window is taking over', 'info', 3000);
            }
            await _pollLeaseStatus(true);
            return;
        }

        if (res.status !== 200 || !res.data || !res.data.granted) {
            if (typeof window.showToast === 'function') {
                window.showToast('Could not take over workspace', 'error', 3000);
            }
            await _pollLeaseStatus(true);
            return;
        }

        wbSyncDebug('takeover:response', {
            wsKey,
            displacedTabId: res.data.displacedTabId || null,
            handedOffCleanly: !!res.data.handedOffCleanly,
            epoch: res.data.lease?.epoch
        });

        // R3: Detach old virtual tree synchronously BEFORE setting mode = 'writer' or any await
        const detachedVid = _detachLiveVirtualTree();

        _stopLeasePoll();
        _lease.mode = 'writer';
        _lease.revoked = false;
        _lease.holder = null;
        _lease.epoch = res.data.lease?.epoch || (_lease.epoch + 1);
        _lease.lastBusySent = _computeBusy();
        _openLeaseStream(wsKey);
        _startLeaseHeartbeat();

        const reopened = await remoteReopenWorkspace({ flushOld: false, keepView: true, vid: detachedVid });
        if (!reopened) return;

        if (typeof window.setWorkspaceReadOnly === 'function') {
            window.setWorkspaceReadOnly(false);
        }

        const cleanly = !res.data.displacedTabId || !!res.data.handedOffCleanly;
        if (typeof window.showToast === 'function') {
            if (cleanly) {
                window.showToast('Control transferred to this window', 'success', 2400);
            } else {
                window.showToast(
                    'Control transferred to this window. The other window did not confirm; any of its unsynced changes will appear as conflict copies.',
                    'info',
                    3500
                );
            }
        }
    } catch (err) {
        console.warn('[remote_store] takeover failed:', err);
        if (!err?._reopenHandled && typeof window.showToast === 'function') {
            window.showToast('Failed to take over workspace: ' + (err?.message || 'network error'), 'error', 4000);
        }
    } finally {
        _lease.takingOver = false;
        if (typeof window.updateWorkspaceLeaseBanner === 'function') {
            window.updateWorkspaceLeaseBanner();
        }
    }
}

// --- AST_EXPORTS_START ---
window.RemoteStore = RemoteStore;
window.wbSyncDebug = wbSyncDebug;
window.remoteReady = remoteReady;
window.makeSyncId = makeSyncId;
window.hash53 = hash53;
window.isSyncedLsKey = isSyncedLsKey;
window.idbGetRaw = idbGetRaw;
window.idbPutRaw = idbPutRaw;
window.idbDeleteRaw = idbDeleteRaw;
window.idbKeysRaw = idbKeysRaw;
window.idbClearRaw = idbClearRaw;
window.encodeForTransport = encodeForTransport;
window.decodeFromTransport = decodeFromTransport;
window.stripModelsArraySecrets = stripModelsArraySecrets;
window.preserveModelsArraySecrets = preserveModelsArraySecrets;
window.stripCatalogEntrySecrets = stripCatalogEntrySecrets;
window.preserveCatalogEntrySecrets = preserveCatalogEntrySecrets;
window.stripSettingsSecrets = stripSettingsSecrets;
window.preserveSettingsSecrets = preserveSettingsSecrets;
window.exportBackupData = exportBackupData;
window.downloadBackup = downloadBackup;
window.importBackupData = importBackupData;
window.remoteInit = remoteInit;
window.remoteMarkDirty = remoteMarkDirty;
window.remoteMarkDeleted = remoteMarkDeleted;
window.remoteHydrate = remoteHydrate;
window.remoteHydrateKey = remoteHydrateKey;
window.remoteFlushNow = remoteFlushNow;
window.remoteReloadSessions = remoteReloadSessions;
window.remoteRefreshCurrentWorkspace = remoteRefreshCurrentWorkspace;
window.remoteSyncCatalogDiff = remoteSyncCatalogDiff;
window.isWorkspaceReadOnly = isWorkspaceReadOnly;
window.getWorkspaceLeaseState = getWorkspaceLeaseState;
window.remoteAcquireWorkspaceLease = remoteAcquireWorkspaceLease;
window.remoteReleaseWorkspaceLease = remoteReleaseWorkspaceLease;
window.remoteTakeOverWorkspace = remoteTakeOverWorkspace;
window.remoteRefreshReadOnlyWorkspace = remoteRefreshReadOnlyWorkspace;
window.remoteReopenWorkspace = remoteReopenWorkspace;
window.scheduleStaleWorkspaceReopen = scheduleStaleWorkspaceReopen;
window.remoteLeaseBusyMaybeChanged = remoteLeaseBusyMaybeChanged;
// --- AST_EXPORTS_END ---