const RemoteStore = {
    enabled: false,
    caps: null
};

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
            localStorage.setItem(k, finalVal);
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

        localStorage.setItem('recent_folders_json', JSON.stringify(mergedCatalog));
        stats.catalog = mergedCatalog.length;
    }

    return stats;
}

// --- Sync Lifecycle (Phase 0: storage persistence only; server sync added in Phase 2) ---

async function remoteInit() {
    try {
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().catch(() => {});
        }
    } catch (e) {}
    RemoteStore.enabled = false;
    RemoteStore.caps = null;
    _finishRemoteReady(false);
}

function remoteMarkDirty(store, key) {
    if (!RemoteStore.enabled) return;
}

function remoteMarkDeleted(store, key) {
    if (!RemoteStore.enabled) return;
}

async function remoteFlushNow() {
    if (!RemoteStore.enabled) return;
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
window.remoteFlushNow = remoteFlushNow;
// --- AST_EXPORTS_END ---