// --- _makeDiffDecoration.js ---
// [AST_MERGED]: ./js/monaco.js


function _makeDiffDecoration(startLine, endLine, kind) {
    const cls = kind === 'added' ? 'gutter-diff-added' : kind === 'deleted' ? 'gutter-diff-deleted' : 'gutter-diff-modified';
    const rulerColor = kind === 'added' ? '#98c379' : kind === 'deleted' ? '#e06c75' : '#61afef';
    return {
        range: new MONACO.Range(startLine, 1, endLine, 1),
        options: {
            isWholeLine: true,
            linesDecorationsClassName: `gutter-diff-marker ${cls}`,
            overviewRuler: {
                color: rulerColor,
                position: MONACO.editor.OverviewRulerLane.Left
            },
            minimap: {
                color: rulerColor,
                position: MONACO.editor.MinimapPosition.Gutter
            }
        }
    };
}

// --- AST_EXPORTS_START ---
window._makeDiffDecoration = _makeDiffDecoration;
// --- AST_EXPORTS_END ---

// --- baselineKey.js ---
function baselineKey(wsName, sessionId) {
    return `${wsName}::${sessionId}`;
}

// --- AST_EXPORTS_START ---
window.baselineKey = baselineKey;
// --- AST_EXPORTS_END ---

// --- computeLineDiffCounts.js ---
function computeLineDiffCounts(beforeText, afterText) {
    if (beforeText === afterText) return { added: 0, removed: 0 };
    // Raw bytes (or any non-text value) have no meaningful line diff; never let them break the stats pass.
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') return { added: 0, removed: 0 };
    if (isBinaryContent(beforeText) || isBinaryContent(afterText)) return { added: 0, removed: 0 };

    const normA = beforeText.replace(/\r\n/g, '\n');
    const normB = afterText.replace(/\r\n/g, '\n');
    const aFull = normA === '' ? [] : normA.split('\n');
    const bFull = normB === '' ? [] : normB.split('\n');

    // Trim identical leading/trailing lines first (like git hunks), which also shrinks the LCS region.
    const { a, b } = trimCommonLines(aFull, bFull);
    const n = a.length, m = b.length;
    if (n === 0 && m === 0) return { added: 0, removed: 0 };

    const LCS_LINE_CAP = 4000;
    if (n * m > LCS_LINE_CAP * LCS_LINE_CAP || n > LCS_LINE_CAP * 4 || m > LCS_LINE_CAP * 4) {
        // Large diff: greedy LCS under-counts with many duplicate lines, so use set overlap instead.
        const aSet = new Set(a);
        const bSet = new Set(b);
        let aMatched = 0;
        for (const line of a) if (bSet.has(line)) aMatched++;
        let bMatched = 0;
        for (const line of b) if (aSet.has(line)) bMatched++;
        const matched = Math.min(aMatched, bMatched);
        return { added: m - matched, removed: n - matched };
    }

    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = (a[i - 1] === b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const lcsLen = dp[n][m];
    return { added: m - lcsLen, removed: n - lcsLen };
}

// Detailed line diff reusing the same trim + LCS strategy as computeLineDiffCounts.
// Returns { added, removed, lineEndingsOnly, approximate, hunks } or null for non-text/binary input.
// When approximate is true (large diffs), hunks is null so callers show counts only.
function computeLineDiffHunks(beforeText, afterText) {
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') return null;
    if (beforeText === afterText) {
        return { added: 0, removed: 0, lineEndingsOnly: false, approximate: false, hunks: [] };
    }
    if (isBinaryContent(beforeText) || isBinaryContent(afterText)) return null;

    const normA = beforeText.replace(/\r\n?/g, '\n');
    const normB = afterText.replace(/\r\n?/g, '\n');
    if (normA === normB) {
        return { added: 0, removed: 0, lineEndingsOnly: true, approximate: false, hunks: [] };
    }

    const aFull = normA === '' ? [] : normA.split('\n');
    const bFull = normB === '' ? [] : normB.split('\n');
    const { a, b, start } = trimCommonLines(aFull, bFull);
    const n = a.length, m = b.length;
    if (n === 0 && m === 0) {
        return { added: 0, removed: 0, lineEndingsOnly: true, approximate: false, hunks: [] };
    }

    const LCS_LINE_CAP = 4000;
    if (n * m > LCS_LINE_CAP * LCS_LINE_CAP || n > LCS_LINE_CAP * 4 || m > LCS_LINE_CAP * 4) {
        const aSet = new Set(a);
        const bSet = new Set(b);
        let aMatched = 0;
        for (const line of a) if (bSet.has(line)) aMatched++;
        let bMatched = 0;
        for (const line of b) if (aSet.has(line)) bMatched++;
        const matched = Math.min(aMatched, bMatched);
        return {
            added: m - matched,
            removed: n - matched,
            lineEndingsOnly: false,
            approximate: true,
            hunks: null
        };
    }

    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = (a[i - 1] === b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const lcsLen = dp[n][m];

    const ops = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            ops.push({ type: 'eq' });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.push({ type: 'add', text: b[j - 1] });
            j--;
        } else {
            ops.push({ type: 'del', text: a[i - 1] });
            i--;
        }
    }
    ops.reverse();

    const hunks = [];
    let oldLine = start + 1;
    let newLine = start + 1;
    let cur = null;
    for (const op of ops) {
        if (op.type === 'eq') {
            if (cur) { hunks.push(cur); cur = null; }
            oldLine++;
            newLine++;
        } else {
            if (!cur) {
                cur = { oldStart: oldLine, newStart: newLine, oldLines: [], newLines: [] };
            }
            if (op.type === 'del') {
                cur.oldLines.push(op.text);
                oldLine++;
            } else {
                cur.newLines.push(op.text);
                newLine++;
            }
        }
    }
    if (cur) hunks.push(cur);

    return {
        added: m - lcsLen,
        removed: n - lcsLen,
        lineEndingsOnly: false,
        approximate: false,
        hunks
    };
}

// --- AST_EXPORTS_START ---
window.computeLineDiffCounts = computeLineDiffCounts;
window.computeLineDiffHunks = computeLineDiffHunks;
// --- AST_EXPORTS_END ---

// --- ensureSessionBaseline.js ---
function ensureSessionBaseline(id) {
    const s = state.sessions[id];
    if (!s) return null;
    if (!s._baseline) {
        s._baseline = { originalFiles: {}, opsLog: {}, compressionHistory: [] };
    }
    if (!s._modifiedFiles) {
        s._modifiedFiles = new Set(Array.isArray(s.modifiedFiles) ? s.modifiedFiles : []);
    }
    if (!Array.isArray(s.messages)) s.messages = [];
    return s;
}

// --- AST_EXPORTS_START ---
window.ensureSessionBaseline = ensureSessionBaseline;
// --- AST_EXPORTS_END ---

// --- executeRevertPlan.js ---
function _normalizeRevertEol(s) {
    return typeof s === 'string' ? s.replace(/\r\n?/g, '\n') : s;
}

function _pathDepth(p) {
    return String(p || '').split('/').filter(Boolean).length;
}

function _orderRevertActions(actions) {
    const orderRank = { rename: 0, mkdir: 1, restore: 2, delete: 3, 'delete-dir': 4 };
    return actions.slice().sort((a, b) => {
        const ra = orderRank[a.kind] ?? 9;
        const rb = orderRank[b.kind] ?? 9;
        if (ra !== rb) return ra - rb;
        if (a.kind === 'mkdir') {
            const dd = _pathDepth(a.filepath) - _pathDepth(b.filepath);
            return dd !== 0 ? dd : a.filepath.localeCompare(b.filepath);
        }
        if (a.kind === 'delete-dir') {
            const dd = _pathDepth(b.filepath) - _pathDepth(a.filepath);
            return dd !== 0 ? dd : b.filepath.localeCompare(a.filepath);
        }
        return (a.filepath || '').localeCompare(b.filepath || '');
    });
}

function _lastRecordedStateForPath(fp) {
    const ops = (registry.opsLog && registry.opsLog[fp]) || [];
    for (let i = ops.length - 1; i >= 0; i--) {
        const op = ops[i];
        if (!op) continue;
        if (op.kind === 'delete') {
            return op.isDir ? { kind: 'dir' } : { kind: 'deleted' };
        }
        if (op.kind === 'create' || op.kind === 'write' || op.kind === 'edit') {
            return { kind: 'content', content: op.content };
        }
        if (op.kind === 'mkdir') {
            return { kind: 'dir' };
        }
    }
    if (fp in registry.originalFiles) {
        const orig = registry.originalFiles[fp];
        if (orig === null) return { kind: 'deleted' };
        if (orig !== undefined) return { kind: 'content', content: orig };
    }
    return { kind: 'unknown' };
}

function _bytesEqual(a, b) {
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

async function _readDiskBytesForConflictCheck(fp) {
    if (window.rootHandle) {
        try {
            const handle = registry.meta[fp]?.handle || await getHandleByPath(fp, false);
            if (!handle || typeof handle.getFile !== 'function') return null;
            const file = await handle.getFile();
            return { bytes: new Uint8Array(await file.arrayBuffer()), size: file.size };
        } catch (_) {
            return null;
        }
    }
    const cached = registry.files[fp];
    if (cached instanceof Blob) {
        return { bytes: new Uint8Array(await cached.arrayBuffer()), size: cached.size };
    }
    if (ArrayBuffer.isView(cached)) {
        const u8 = new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength);
        return { bytes: u8, size: u8.byteLength };
    }
    if (cached instanceof ArrayBuffer) {
        const u8 = new Uint8Array(cached);
        return { bytes: u8, size: u8.byteLength };
    }
    return null;
}

// Inspects files targeted by a revert plan against fresh disk state and unsaved Monaco buffers
// to detect external edits that would otherwise be overwritten or deleted.
async function detectExternalRevertConflicts(actions) {
    const conflicts = [];
    const conflictPaths = new Set();
    const diskTextByPath = new Map();
    const checked = new Set();

    // Map rename target -> current on-disk path so paired rename+restore actions check the right file.
    const renamedFromByTarget = new Map();
    for (const a of actions) {
        if (a.kind === 'rename' && a.filepath && a.targetPath) {
            renamedFromByTarget.set(a.targetPath, a.filepath);
        }
    }

    const addConflict = (fp, reason, extraPaths = []) => {
        if (!conflictPaths.has(fp)) {
            conflicts.push({ filepath: fp, reason });
        }
        conflictPaths.add(fp);
        for (const ep of extraPaths) {
            if (ep) conflictPaths.add(ep);
        }
    };

    const checkFilePath = async (fp, actionKind, extraPaths = []) => {
        if (!fp || checked.has(fp)) return;
        checked.add(fp);

        if (typeof isFileDirty === 'function' && isFileDirty(fp)) {
            addConflict(fp, 'unsaved edits in editor', extraPaths);
            return;
        }

        const recorded = _lastRecordedStateForPath(fp);
        if (recorded.kind === 'unknown' || recorded.kind === 'dir') return;

        const exists = window.rootHandle
            ? await fileExistsOnDisk(fp)
            : (registry.files[fp] !== undefined || !!(registry.meta[fp] && registry.meta[fp].kind === 'file'));

        if (recorded.kind === 'deleted') {
            if (exists) {
                if (typeof readFileContent === 'function' && !registry.meta[fp]?.isBinary) {
                    try {
                        const dt = await readFileContent(fp, { fromDisk: true, throwOnError: true });
                        if (typeof dt === 'string') diskTextByPath.set(fp, dt);
                    } catch (_) {}
                }
                addConflict(fp, 'created externally on disk', extraPaths);
            }
            return;
        }

        if (!exists) {
            // If the revert wants to delete this file anyway and it's already gone, there's no conflict.
            if (actionKind === 'delete') return;
            addConflict(fp, 'deleted externally on disk', extraPaths);
            return;
        }

        const expected = recorded.content;
        if (typeof isBinaryBackupPayload === 'function' && isBinaryBackupPayload(expected)) {
            const disk = await _readDiskBytesForConflictCheck(fp);
            if (!disk) return;
            if (expected.omitted) {
                if (typeof expected.size === 'number' && disk.size !== expected.size) {
                    addConflict(fp, 'modified externally on disk', extraPaths);
                }
                return;
            }
            const expBytes = typeof decodeBinaryBackupPayload === 'function' ? decodeBinaryBackupPayload(expected) : null;
            if (expBytes && !_bytesEqual(disk.bytes, expBytes)) {
                addConflict(fp, 'modified externally on disk', extraPaths);
            }
            return;
        }

        if (typeof expected === 'string') {
            let diskText = null;
            try {
                diskText = await readFileContent(fp, { fromDisk: true, throwOnError: true });
            } catch (_) {
                return;
            }
            if (typeof diskText === 'string' && _normalizeRevertEol(diskText) !== _normalizeRevertEol(expected)) {
                diskTextByPath.set(fp, diskText);
                addConflict(fp, 'modified externally on disk', extraPaths);
            }
        }
    };

    for (const action of actions) {
        if (action.kind === 'mkdir' || action.kind === 'delete-dir') continue;
        if (action.kind === 'rename') {
            await checkFilePath(action.filepath, 'rename', [action.targetPath]);
            if (action.targetPath && action.targetPath !== action.filepath) {
                const targetExists = window.rootHandle
                    ? await fileExistsOnDisk(action.targetPath)
                    : !!(registry.meta[action.targetPath] && registry.meta[action.targetPath].kind === 'file');
                if (targetExists) {
                    addConflict(action.targetPath, 'exists externally at rename target', [action.filepath]);
                }
            }
        } else if (action.kind === 'restore') {
            const diskPath = renamedFromByTarget.get(action.filepath) || action.filepath;
            const extras = diskPath !== action.filepath ? [action.filepath] : [];
            await checkFilePath(diskPath, 'restore', extras);
        } else if (action.kind === 'delete' && !action.isDir) {
            await checkFilePath(action.filepath, 'delete');
        }
    }

    return { conflicts, conflictPaths, diskTextByPath };
}

function _fastHashSnapshotText(str) {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c64e6d ^ str.length;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

async function _syncSnapshotAfterRevert(revertedOps) {
    if (!revertedOps || revertedOps.length === 0) return;
    const gen = typeof getGenState === 'function' ? getGenState(state.activeSessionId) : null;
    const snap = gen && gen.lastWorkspaceSnapshot;
    if (!snap || !snap.files) return;

    for (const op of revertedOps) {
        if (op.kind === 'delete') {
            delete snap.files[op.filepath];
            continue;
        }
        if (op.kind === 'rename') {
            const moved = snap.files[op.filepath];
            delete snap.files[op.filepath];
            if (moved) snap.files[op.targetPath] = moved;
            continue;
        }
        if (op.kind === 'restore') {
            const fp = op.filepath;
            const meta = registry.meta[fp];
            let size = typeof meta?.size === 'number' ? meta.size : null;
            let mtime = meta?.mtime !== undefined ? meta.mtime : null;
            if (window.rootHandle && !window.rootHandle.isWebDAV) {
                try {
                    const h = meta?.handle || await getHandleByPath(fp, false);
                    if (h && typeof h.getFile === 'function') {
                        const f = await h.getFile();
                        if (typeof f.size === 'number') { size = f.size; if (meta) meta.size = size; }
                        if (f.lastModified) { mtime = f.lastModified / 1000; if (meta) meta.mtime = mtime; }
                    }
                } catch (_) {}
            }
            const isBin = !!(op.isBinary || meta?.isBinary);
            if (isBin) {
                snap.files[fp] = { size, mtime, hash: null, lines: null, text: null, dirty: false, isBinary: true };
            } else {
                const text = typeof op.text === 'string' ? op.text : (typeof registry.files[fp] === 'string' ? registry.files[fp] : null);
                snap.files[fp] = {
                    size: size !== null ? size : (text !== null ? text.length : null),
                    mtime,
                    hash: text !== null ? _fastHashSnapshotText(text) : null,
                    lines: text !== null ? lineCount(text) : null,
                    text: text !== null && text.length <= 1024 * 1024 ? text : null,
                    dirty: false,
                    isBinary: false
                };
            }
        }
    }
    snap.fileCount = Object.keys(snap.files).length;
}

// Single entry point for all reverts.
// Actions: {kind:'rename',filepath,targetPath} | {kind:'mkdir',filepath} | {kind:'restore',filepath,content}
//        | {kind:'delete',filepath} | {kind:'delete-dir',filepath}.
// Options: forgetPromptIds drops ops by prompt id; clearOpsFor wipes a file's opsLog;
//          skipPaths skips disk mutations for externally modified files while still updating opsLog.
async function executeRevertPlan(actions, opts = {}) {
    const forgetIds = opts.forgetPromptIds ? new Set(opts.forgetPromptIds) : null;
    const clearFor = opts.clearOpsFor ? new Set(opts.clearOpsFor) : null;
    const skipPaths = opts.skipPaths ? new Set(opts.skipPaths) : null;
    const externalDiskText = opts.externalDiskText instanceof Map ? opts.externalDiskText : null;
    const ordered = _orderRevertActions(actions);

    let applied = 0;
    const keptDirs = [];
    const omittedBinaries = [];
    const revertedOps = [];

    const migrateTrackedPath = (fromPath, toPath) => {
        if (registry.opsLog[fromPath]) {
            registry.opsLog[toPath] = registry.opsLog[fromPath];
            delete registry.opsLog[fromPath];
        }
        if (fromPath in registry.originalFiles) {
            registry.originalFiles[toPath] = registry.originalFiles[fromPath];
            delete registry.originalFiles[fromPath];
        }
        if (state.openTabs.includes(fromPath)) {
            state.openTabs[state.openTabs.indexOf(fromPath)] = toPath;
        }
        if (state.activeTab === fromPath) state.activeTab = toPath;
        if (state.currentEditorPath === fromPath) state.currentEditorPath = toPath;
        if (state.currentDiffFilepath === fromPath) state.currentDiffFilepath = toPath;
        if (state.checkpointModalFile === fromPath) state.checkpointModalFile = toPath;
        const model = monacoModels.get(fromPath);
        if (model) {
            monacoModels.delete(fromPath);
            monacoModels.set(toPath, model);
        }
        if (state.fileBase && state.fileBase.has(fromPath)) {
            state.fileBase.set(toPath, state.fileBase.get(fromPath));
            state.fileBase.delete(fromPath);
        }
    };

    for (const action of ordered) {
        if (skipPaths && (skipPaths.has(action.filepath) || (action.targetPath && skipPaths.has(action.targetPath)))) {
            continue;
        }
        try {
            if (action.kind === 'rename') {
                const exists = window.rootHandle
                    ? await fileExistsOnDisk(action.filepath)
                    : !!(registry.meta[action.filepath] && registry.meta[action.filepath].kind === 'file');
                if (exists) {
                    const res = await fs.rename(action.filepath, action.targetPath, { track: false, exactPath: true });
                    if (res && res.error) {
                        showToast(`Revert error (${action.filepath}): ${res.error}`, 'error');
                        continue;
                    }
                }
                migrateTrackedPath(action.filepath, action.targetPath);
                revertedOps.push({ kind: 'rename', filepath: action.filepath, targetPath: action.targetPath });
            } else if (action.kind === 'mkdir') {
                const parts = String(action.filepath || '').split('/').filter(Boolean);
                let built = '';
                for (const seg of parts) {
                    built = built ? `${built}/${seg}` : seg;
                    if (!(await workspaceDirExists(built))) {
                        await fs.mkdir(built, { track: false });
                    }
                }
            } else if (action.kind === 'restore') {
                if (typeof isBinaryBackupPayload === 'function' && isBinaryBackupPayload(action.content)) {
                    if (action.content.omitted) {
                        omittedBinaries.push({
                            filepath: action.filepath,
                            size: action.content.size,
                            reason: action.content.reason
                        });
                        continue;
                    }
                    const u8 = typeof decodeBinaryBackupPayload === 'function'
                        ? decodeBinaryBackupPayload(action.content)
                        : null;
                    if (!u8) {
                        omittedBinaries.push({ filepath: action.filepath, size: action.content.size, reason: 'decode-error' });
                        continue;
                    }
                    await fs.write(action.filepath, u8, { track: false });
                    if (typeof clearFileDirty === 'function') clearFileDirty(action.filepath);
                    revertedOps.push({ kind: 'restore', filepath: action.filepath, isBinary: true });
                } else if (typeof action.content === 'string') {
                    await fs.write(action.filepath, action.content, { track: false });
                    if (state.fileBase) state.fileBase.set(action.filepath, action.content);
                    if (typeof clearFileDirty === 'function') clearFileDirty(action.filepath);
                    const model = monacoModels.get(action.filepath);
                    if (model) {
                        if (typeof setModelFromDisk === 'function') {
                            setModelFromDisk(action.filepath, model, action.content);
                        } else {
                            withDirtyTrackingSuppressed(() => model.setValue(action.content));
                        }
                    }
                    revertedOps.push({ kind: 'restore', filepath: action.filepath, isBinary: false, text: action.content });
                } else {
                    continue;
                }
            } else if (action.kind === 'delete' && !action.isDir) {
                const exists = window.rootHandle
                    ? await fileExistsOnDisk(action.filepath)
                    : !!(registry.meta[action.filepath] || registry.files[action.filepath] !== undefined);
                if (exists) {
                    await fs.del(action.filepath, { track: false });
                } else {
                    delete registry.meta[action.filepath];
                    delete registry.files[action.filepath];
                }
                if (state.fileBase) state.fileBase.delete(action.filepath);
                if (typeof clearFileDirty === 'function') clearFileDirty(action.filepath);
                revertedOps.push({ kind: 'delete', filepath: action.filepath });
            } else if (action.kind === 'delete-dir' || (action.kind === 'delete' && action.isDir)) {
                const check = typeof checkDirectoryOnDisk === 'function'
                    ? await checkDirectoryOnDisk(action.filepath)
                    : { status: 'error' };
                if (check.status === 'missing') {
                    delete registry.meta[action.filepath];
                } else if (check.status === 'empty') {
                    await fs.del(action.filepath, { track: false, isDir: true });
                } else {
                    keptDirs.push(action.filepath);
                    continue;
                }
            }
            applied++;
        } catch (e) {
            showToast(`Revert error (${action.filepath}): ${e.message}`, 'error');
        }
    }

    // For skipped external-edit files, refresh registry.files with disk content so modifiedFiles stays accurate.
    if (skipPaths && externalDiskText) {
        for (const fp of skipPaths) {
            if (externalDiskText.has(fp) && !registry.meta[fp]?.isBinary) {
                registry.files[fp] = externalDiskText.get(fp);
            }
        }
    }

    // A prompt is a commit: forgetting its id drops all its ops from every file.
    if (forgetIds) {
        for (const fp of Object.keys(registry.opsLog)) {
            const kept = (registry.opsLog[fp] || []).filter(op => !(op.prompt && forgetIds.has(op.prompt.id)));
            if (kept.length) registry.opsLog[fp] = kept;
            else {
                delete registry.opsLog[fp];
                if (registry.originalFiles[fp] === null && !registry.meta[fp]) {
                    delete registry.originalFiles[fp];
                }
            }
        }
    }
    // Full log reset for a file (per-file discard / discard-all).
    if (clearFor) {
        for (const fp of clearFor) {
            delete registry.opsLog[fp];
            if (registry.originalFiles[fp] === null) delete registry.originalFiles[fp];
        }
    }

    recomputeAllModifiedFromOps();
    if (skipPaths) {
        for (const fp of skipPaths) {
            const exists = !!(registry.meta[fp] && registry.meta[fp].kind === 'file');
            if (exists) state.modifiedFiles.add(fp);
        }
    }
    await recomputeLineStats(sessionCtx(state.activeSessionId), state.activeSessionId);
    await persistCheckpoint();
    await _syncSnapshotAfterRevert(revertedOps);

    renderChangesPanel();
    renderExplorerTree();
    updateStatusInfo();

    // Refresh any open diff view and the graph so neither shows stale data.
    if (state.currentDiffFilepath) renderFileDiffView(state.currentDiffFilepath);
    refreshChangesGraph();
    if (state.currentEditorPath && monacoEditor) scheduleGutterDiffUpdate();

    if (!opts.silentNotices) {
        if (keptDirs.length > 0) {
            // Show the shallowest kept root folders when nested ancestors were kept for the same untracked files.
            const keptSorted = keptDirs.slice().sort((a, b) => _pathDepth(a) - _pathDepth(b) || a.localeCompare(b));
            const topKept = keptSorted.filter(d => !keptSorted.some(other => other !== d && d.startsWith(other + '/')));
            const shown = topKept.slice(0, 3).map(d => `${d}/`).join(', ');
            const more = topKept.length > 3 ? ` (+${topKept.length - 3} more)` : '';
            showToast(`Kept ${shown}${more} (contains untracked files)`, 'info', 4500);
        }
        if (omittedBinaries.length > 0) {
            const names = omittedBinaries.slice(0, 3).map(b => b.filepath).join(', ');
            const more = omittedBinaries.length > 3 ? ` (+${omittedBinaries.length - 3} more)` : '';
            showToast(`Couldn't restore ${names}${more} (over size limit)`, 'info', 5000);
        }
    }

    return applied;
}

// --- AST_EXPORTS_START ---
window.executeRevertPlan = executeRevertPlan;
window.detectExternalRevertConflicts = detectExternalRevertConflicts;
// --- AST_EXPORTS_END ---

// --- getFileTimeline.js ---
// Builds a checkpoint timeline (baseline, checkpoint, delete, current) from the op log; rename/mkdir markers are not content checkpoints.
function getFileTimeline(filepath) {
    const b = registry;
    const ops = (b.opsLog && b.opsLog[filepath]) || [];
    const timeline = [];

    if (b.originalFiles[filepath] !== undefined && b.originalFiles[filepath] !== null) {
        timeline.push({
            index: 0,
            kind: 'baseline',
            content: b.originalFiles[filepath],
            prompt: null,
            ts: null,
        });
    }
    for (const op of ops) {
        if (op.kind === 'rename-in' || op.kind === 'rename-out' || op.kind === 'mkdir') {
            timeline.push({ index: timeline.length, kind: op.kind, prompt: op.prompt, ts: op.ts, op });
            continue;
        }
        if (op.kind === 'delete') {
            timeline.push({
                index: timeline.length,
                kind: 'delete',
                content: '',
                prompt: op.prompt,
                ts: op.ts,
                op,
            });
            continue;
        }
        // create / write / edit
        timeline.push({
            index: timeline.length,
            kind: 'checkpoint',
            content: op.content,
            prompt: op.prompt,
            ts: op.ts,
            op,
        });
    }

    if (b.files[filepath] !== undefined) {
        timeline.push({
            index: timeline.length,
            kind: 'current',
            content: b.files[filepath],
            prompt: null,
            ts: null,
        });
    }
    return timeline;
}

// --- AST_EXPORTS_START ---
window.getFileTimeline = getFileTimeline;
// --- AST_EXPORTS_END ---

// --- lineCount.js ---
// Counts newline-terminated lines; '' counts as zero lines.
function lineCount(text) {
    return text === '' ? 0 : text.split('\n').length;
}

// --- AST_EXPORTS_START ---
window.lineCount = lineCount;
// --- AST_EXPORTS_END ---

// --- loadCheckpointForSession.js ---
async function loadCheckpointForSession(sessionId) {
    const existing = state.sessions[sessionId];
    if (existing && existing._baseline) {
        registry.originalFiles = existing._baseline.originalFiles;
        registry.opsLog = existing._baseline.opsLog || {};
        registry.compressionHistory = existing._baseline.compressionHistory || [];
        state.modifiedFiles = existing._modifiedFiles || new Set();
        return;
    }

    registry.originalFiles = {};
    registry.opsLog = {};
    registry.compressionHistory = [];
    state.modifiedFiles = new Set();

    const saved = await loadBaselineFromDB(currentWsName(), sessionId);
    if (saved) {
        registry.originalFiles = saved.originalFiles || {};
        registry.opsLog = saved.opsLog || {};
        registry.compressionHistory = saved.compressionHistory || [];
        (saved.modifiedFiles || []).forEach(f => state.modifiedFiles.add(f));
    } else {
        await saveBaselineToDB(currentWsName(), sessionId, registry.originalFiles, state.modifiedFiles, registry.opsLog, registry.compressionHistory);
    }

    if (existing) {
        existing._baseline = {
            originalFiles: registry.originalFiles,
            opsLog: registry.opsLog,
            compressionHistory: registry.compressionHistory
        };
        existing._modifiedFiles = state.modifiedFiles;
    }
}

// --- AST_EXPORTS_START ---
window.loadCheckpointForSession = loadCheckpointForSession;
// --- AST_EXPORTS_END ---

// --- persistCheckpoint.js ---
// [AST_MERGED]: ./js/db.js


async function persistCheckpoint(sessionId) {
    const id = sessionId || state.activeSessionId;
    const ctx = sessionCtx(id);
    if (ctx.deleted) return;
    await saveBaselineToDB(
        currentWsName(),
        id,
        ctx.baseline.originalFiles,
        ctx.modifiedFiles,
        ctx.baseline.opsLog,
        ctx.baseline.compressionHistory
    );
}

// --- AST_EXPORTS_START ---
window.persistCheckpoint = persistCheckpoint;
// --- AST_EXPORTS_END ---

// --- recomputeAllModifiedFromOps.js ---
// Rebuilds state.modifiedFiles from baselines and op logs after every revert batch.
function recomputeAllModifiedFromOps() {
    const all = new Set([
        ...Object.keys(registry.originalFiles),
        ...Object.keys(registry.opsLog),
    ]);
    state.modifiedFiles.clear();
    for (const fp of all) {
        const meta = registry.meta[fp];
        const ops = registry.opsLog[fp] || [];
        const baselineVal = registry.originalFiles[fp];
        const hasBaseline = baselineVal !== undefined && baselineVal !== null;
        const isDirOnly = (meta && meta.kind === 'directory') ||
            (!hasBaseline && ops.length > 0 && ops.every(o => o && (o.kind === 'mkdir' || o.isDir)));
        if (isDirOnly) continue;

        const isBin = !!(meta?.isBinary || (typeof isBinaryBackupPayload === 'function' && isBinaryBackupPayload(baselineVal)));
        const fileExists = isBin
            ? !!(meta && meta.kind === 'file')
            : (registry.files[fp] !== undefined || !!(meta && meta.kind === 'file'));

        let modified = false;
        if (hasBaseline) {
            if (!fileExists) {
                modified = true;
            } else if (isBin) {
                modified = ops.length > 0;
            } else if (registry.files[fp] !== undefined && registry.files[fp] !== baselineVal) {
                modified = true;
            }
        } else if (fileExists && ops.length > 0) {
            // No baseline (created this session) and still present.
            modified = true;
        }
        if (modified) state.modifiedFiles.add(fp);
    }
}

// --- AST_EXPORTS_START ---
window.recomputeAllModifiedFromOps = recomputeAllModifiedFromOps;
// --- AST_EXPORTS_END ---

// --- recomputeLineStats.js ---
// Recomputes +added/-removed from baseline vs current content, so it can't drift.
async function recomputeLineStats(ctx, sid) {
    let totalAdded = 0, totalRemoved = 0;

    for (const fp of ctx.modifiedFiles) {
        // Baseline is the pre-session content; a null sentinel means created this session.
        const baselineRaw = ctx.baseline.originalFiles[fp];
        if ((typeof isBinaryBackupPayload === 'function' && isBinaryBackupPayload(baselineRaw)) ||
            registry.meta[fp]?.isBinary) {
            continue;
        }
        const beforeText = (baselineRaw === undefined || baselineRaw === null) ? '' : baselineRaw;

        // Use live content for the active session, otherwise re-read from disk.
        let afterText;
        if (ctx.isLive && registry.files[fp] !== undefined) {
            afterText = registry.files[fp];
        } else if (!ctx.isLive) {
            afterText = await readFileContent(fp) || '';
        } else {
            afterText = '';
        }

        const { added, removed } = computeLineDiffCounts(beforeText, afterText);
        totalAdded += added;
        totalRemoved += removed;
    }

    if (state.sessions[sid]) {
        state.sessions[sid].linesAdded = totalAdded;
        state.sessions[sid].linesRemoved = totalRemoved;
    }
    if (ctx.isLive) {
        state.linesAdded = totalAdded;
        state.linesRemoved = totalRemoved;
    }
}

// --- AST_EXPORTS_START ---
window.recomputeLineStats = recomputeLineStats;
// --- AST_EXPORTS_END ---

// --- trimCommonLines.js ---
// Counts added/removed lines via LCS diff, with a set-overlap fallback for very large diffs.
function trimCommonLines(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { a: a.slice(start, endA), b: b.slice(start, endB), start };
}

// --- AST_EXPORTS_START ---
window.trimCommonLines = trimCommonLines;
// --- AST_EXPORTS_END ---
