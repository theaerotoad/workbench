const RemoteStore = {
    enabled: false,
    caps: null
};

const _origLsSet = Storage.prototype.setItem;
const _origLsRemove = Storage.prototype.removeItem;

function _rawLsSet(key, val) {
    _origLsSet.call(window.localStorage, key, val);
}

function _rawLsRemove(key) {
    _origLsRemove.call(window.localStorage, key);
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
    }
    return rawValue;
}

function preserveSettingsSecrets(key, incomingRaw, existingRaw) {
    if (key === 'models_json' || key.startsWith('models_')) {
        try {
            const inc = typeof incomingRaw === 'string' ? JSON.parse(incomingRaw) : incomingRaw;
            const ext = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
            if (Array.isArray(inc) && Array.isArray(ext)) {
                const merged = preserveModelsArraySecrets(inc, ext);
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

// --- Store Readers & Raw Writers (§7.6) ---

async function _readLocalForUpload(store, key) {
    if (store === 'sessions') {
        return await idbGetRaw(STORE_SESSIONS, key);
    }
    if (store === 'baselines') {
        return await idbGetRaw(STORE_BASELINES, key);
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
        await idbPutRaw(STORE_BASELINES, key, decoded);
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
        if (existing && !RemoteStore.caps?.syncSecrets) {
            entry = preserveCatalogEntrySecrets(entry, existing);
        }
        const deduped = list.filter((f) => f && f.id !== entry.id && !_catalogEntriesSameWorkspace(f, entry));
        deduped.push(entry);
        _writeCatalogRaw(deduped);
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
        const srv = await _fetchServerItem('sessions', key);
        const actualRev = srv.rev != null ? srv.rev : serverRev;
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

    // 8.2 / 8.3 baselines, catalog (and future settings): server wins
    const srv = await _fetchServerItem(store, key);
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
        _withSyncMeta(store, key, (cur) => ({
            ...cur,
            store,
            key,
            pending: 'put',
            dirtyGen: (cur.dirtyGen || 0) + 1
        })).then(() => _scheduleFlush()).catch(() => {});
    } catch (e) {}
}

function remoteMarkDeleted(store, key) {
    if (!RemoteStore.enabled || !store || !key) return;
    try {
        _withSyncMeta(store, key, (cur) => ({
            ...cur,
            store,
            key,
            pending: 'delete',
            dirtyGen: (cur.dirtyGen || 0) + 1
        })).then(() => _scheduleFlush()).catch(() => {});
    } catch (e) {}
}

async function _uploadOneEntry(meta) {
    const { store, key } = meta;
    const gen = meta.dirtyGen || 0;
    const baseRev = meta.baseRev || 0;
    let op = meta.pending;
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
            if (meta.lastHash !== null && meta.lastHash === valueHash) {
                await _withSyncMeta(store, key, (cur) => {
                    if ((cur.dirtyGen || 0) === gen) {
                        return { ...cur, pending: null };
                    }
                    return cur;
                });
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
        return { transientError: true };
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
                try {
                    const keys = await idbKeysRaw(STORE_SYNC);
                    for (const mk of keys) {
                        const meta = await idbGetRaw(STORE_SYNC, mk);
                        if (meta && meta.pending !== null) {
                            morePending = true;
                            break;
                        }
                    }
                } catch (e) {}
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

async function remoteFlushNow() {
    if (!RemoteStore.enabled) return;
    await _runFlush();
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
        if (srv.status === 404) return { changed: false };
        const serverRev = srv.rev || 0;
        if (serverRev === meta.baseRev) return { changed: false };

        if (meta.pending !== null && serverRev !== meta.baseRev) {
            await handleConflict(store, key, serverRev);
            return { changed: true };
        }
        if (srv.status === 410) {
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

    _rawLsSet('sync_seeded', '1');
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
    }

    // 5. First-time seed of pre-existing browser data
    if (!localStorage.getItem('sync_seeded')) {
        await _seedLocalData();
    } else {
        _rebuildCatalogSnapshot(_readCatalogRaw());
    }

    // 6. Hydrate catalog before startup renders recent workspaces
    await remoteHydrate('catalog', '');

    // 7. Enable sync, start uploader, register lifecycle listeners
    RemoteStore.enabled = true;
    _rebuildCatalogSnapshot(_readCatalogRaw());

    if (!_listenersBound) {
        _listenersBound = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                remoteFlushNow();
            } else if (document.visibilityState === 'visible') {
                remoteRefreshCurrentWorkspace();
            }
        });
        window.addEventListener('pagehide', () => {
            remoteFlushNow();
        });
    }

    _finishRemoteReady(true);

    // Kick off initial upload pass for any seeded or pending entries (non-blocking)
    _scheduleFlush();
}

// --- AST_EXPORTS_START ---
window.RemoteStore = RemoteStore;
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
// --- AST_EXPORTS_END ---