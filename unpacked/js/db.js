function getDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 5);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
            if (!db.objectStoreNames.contains(STORE_BASELINES)) db.createObjectStore(STORE_BASELINES);
            if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
            if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveWorkspaceCacheToDB(wsName, metadataMap) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_CACHE, 'readwrite');
        const serialized = {};
        for (const [k, v] of Object.entries(metadataMap)) {
            serialized[k] = { kind: v.kind, size: v.size, isBinary: v.isBinary };
        }
        tx.objectStore(STORE_CACHE).put(serialized, wsName);
        return new Promise(res => tx.oncomplete = res);
    } catch(e) {}
}

async function loadBaselineFromDB(wsName, sessionId) {
    try {
        const db = await getDB();
        const key = baselineKey(wsName, sessionId);
        return new Promise((res) => {
            const tx = db.transaction(STORE_BASELINES, 'readonly');
            const req = tx.objectStore(STORE_BASELINES).get(key);
            req.onsuccess = () => res(req.result);
            req.onerror = () => res(null);
        });
    } catch(e) { return null; }
}

async function saveBaselineToDB(wsName, sessionId, originalFiles, modifiedFilesSet, opsLog, compressionHistory) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_BASELINES, 'readwrite');
        const key = baselineKey(wsName, sessionId);
        tx.objectStore(STORE_BASELINES).put({
            wsName,
            sessionId,
            originalFiles,
            modifiedFiles: Array.from(modifiedFilesSet),
            opsLog: opsLog || {},
            compressionHistory: compressionHistory || []
        }, key);
        return new Promise(res => tx.oncomplete = res);
    } catch(e) {}
}

async function deleteBaselineFromDB(wsName, sessionId) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_BASELINES, 'readwrite');
        tx.objectStore(STORE_BASELINES).delete(baselineKey(wsName, sessionId));
        return new Promise(res => tx.oncomplete = res);
    } catch(e) {}
}

async function sessionRecordExistsInDB(wsKey, sessionId) {
    try {
        const db = await getDB();
        return await new Promise((res) => {
            const tx = db.transaction(STORE_SESSIONS, 'readonly');
            const req = tx.objectStore(STORE_SESSIONS).getKey(sessionRecordKey(wsKey, sessionId));
            req.onsuccess = () => res(req.result !== undefined);
            req.onerror = () => res(true); // unknown -> don't drop the session
        });
    } catch (e) { return true; }
}

function sessionRecordKey(wsKey, sessionId) {
    return `${wsKey}::session::${sessionId}`;
}

function sessionIndexKey(wsKey) {
    return `${wsKey}::index`;
}

async function loadSessionIndexFromDB(wsKey) {
    try {
        const db = await getDB();
        return new Promise((res) => {
            const tx = db.transaction(STORE_SESSIONS, 'readonly');
            const req = tx.objectStore(STORE_SESSIONS).get(sessionIndexKey(wsKey));
            req.onsuccess = () => res(req.result || null);
            req.onerror = () => res(null);
        });
    } catch(e) { return null; }
}

async function saveSessionIndexToDB(wsKey, index) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        tx.objectStore(STORE_SESSIONS).put(index, sessionIndexKey(wsKey));
        return new Promise(res => tx.oncomplete = res);
    } catch(e) {}
}

async function loadSessionRecordFromDB(wsKey, sessionId) {
    try {
        const db = await getDB();
        return new Promise((res) => {
            const tx = db.transaction(STORE_SESSIONS, 'readonly');
            const req = tx.objectStore(STORE_SESSIONS).get(sessionRecordKey(wsKey, sessionId));
            req.onsuccess = () => res(req.result || null);
            req.onerror = () => res(null);
        });
    } catch(e) { return null; }
}

async function patchSessionRecordInDB(wsKey, sessionId, patch) {
    if (!sessionId || deletedSessionIds.has(sessionId)) return null;
    try {
        const db = await getDB();
        const key = sessionRecordKey(wsKey, sessionId);
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_SESSIONS, 'readwrite');
            const store = tx.objectStore(STORE_SESSIONS);
            const getReq = store.get(key);
            getReq.onsuccess = () => {
                const existing = getReq.result || {};
                const merged = { ...existing, ...patch };
                store.put(merged, key);
                tx.oncomplete = () => resolve(merged);
            };
            getReq.onerror = () => resolve(null);
        });
    } catch(e) { return null; }
}

async function deleteSessionRecordFromDB(wsKey, sessionId) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_SESSIONS, 'readwrite');
        tx.objectStore(STORE_SESSIONS).delete(sessionRecordKey(wsKey, sessionId));
        return new Promise(res => tx.oncomplete = res);
    } catch(e) {}
}

// --- AST_EXPORTS_START ---
window.getDB = getDB;
window.saveWorkspaceCacheToDB = saveWorkspaceCacheToDB;
window.loadBaselineFromDB = loadBaselineFromDB;
window.saveBaselineToDB = saveBaselineToDB;
window.deleteBaselineFromDB = deleteBaselineFromDB;
window.sessionRecordExistsInDB = sessionRecordExistsInDB;
window.sessionRecordKey = sessionRecordKey;
window.sessionIndexKey = sessionIndexKey;
window.loadSessionIndexFromDB = loadSessionIndexFromDB;
window.saveSessionIndexToDB = saveSessionIndexToDB;
window.loadSessionRecordFromDB = loadSessionRecordFromDB;
window.patchSessionRecordInDB = patchSessionRecordInDB;
window.deleteSessionRecordFromDB = deleteSessionRecordFromDB;
// --- AST_EXPORTS_END ---
