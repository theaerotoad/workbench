// --- workspace_changes.js ---
// Tracks workspace file snapshots between LLM turns so user edits made in the
// editor or externally on disk are summarized to the model on the next message.

const SNAPSHOT_STAT_CAP = 5000;
const SNAPSHOT_BATCH_SIZE = 32;
const SNAPSHOT_MAX_TEXT_BYTES = 1024 * 1024;            // 1 MB per-file cap for line diffs
const SNAPSHOT_MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024; // 16 MB total text-ref budget per snapshot

function _getRootHandle() {
    if (typeof rootHandle !== 'undefined' && rootHandle) return rootHandle;
    return window.rootHandle || null;
}

function _isChangeNotifyEnabled() {
    const raw = window.AppConfig?.get('notify-workspace-changes', 'true');
    return String(raw ?? 'true') !== 'false';
}

function _getChangeNotifyMax() {
    const raw = window.AppConfig?.get('notify-workspace-changes-max', '25');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
}

function _fastHashString(str) {
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

function _countLines(text) {
    if (typeof window.lineCount === 'function') return window.lineCount(text);
    return text === '' ? 0 : text.split('\n').length;
}

// Uses the same visibility rules as TOOL_API_METHODS.listFiles, excluding transient
// prompt attachments (.agent/attachments/*) which are created when sending a message.
function _listSnapshotPaths() {
    const metaMap = window.registry?.meta;
    if (!metaMap) return [];
    const isProtected = window.isSecurityProtectedPath;
    const isSensitive = window.isSensitiveUserFile;
    const shouldHide = window.shouldHideFromTools;
    const isAgent = window.isAgentPath;
    const isToolFile = window.isToolFilePath;
    const isVirtualAgent = window.isVirtualAgentFile;
    const isSkill = window.isSkillPath;
    const isAttachment = window.isAttachmentPath;

    return Object.keys(metaMap).filter(f => {
        const m = metaMap[f];
        if (!m || m.kind !== 'file' || m.attachment) return false;
        if (isAttachment && isAttachment(f)) return false;
        if (isProtected && isProtected(f)) return false;
        if (isSensitive && isSensitive(f)) return false;
        if (shouldHide && shouldHide(f)) return false;
        if (isAgent && isAgent(f) &&
            !(isToolFile && isToolFile(f)) &&
            !(isVirtualAgent && isVirtualAgent(f)) &&
            !(isSkill && isSkill(f))) {
            return false;
        }
        return true;
    }).sort();
}

async function takeWorkspaceSnapshot(opts = {}) {
    const ts = Date.now();
    const root = _getRootHandle();
    const wsKey = typeof window.currentWsName === 'function' ? window.currentWsName() : '';
    const statCap = Number.isFinite(opts.statCap) && opts.statCap > 0 ? opts.statCap : SNAPSHOT_STAT_CAP;
    const paths = _listSnapshotPaths();
    const isWebDAV = !!(root && root.isWebDAV);
    const degraded = !isWebDAV && !!root && paths.length > statCap;

    const files = Object.create(null);
    const toStat = [];
    let totalTextBytes = 0;

    const metaMap = window.registry?.meta || {};
    const cachedFiles = window.registry?.files || {};
    const models = window.monacoModels;
    const checkDirty = typeof window.isFileDirty === 'function' ? window.isFileDirty : null;
    const checkBinContent = typeof window.isBinaryContent === 'function' ? window.isBinaryContent : null;
    const binExtRe = window.BINARY_EXT_DEFINITE;

    for (const fp of paths) {
        const meta = metaMap[fp];
        if (!meta) continue;

        const dirty = !!(checkDirty && checkDirty(fp) && models && models.has(fp));
        let rawText = null;
        if (dirty) {
            rawText = models.get(fp).getValue();
        } else if (typeof cachedFiles[fp] === 'string') {
            rawText = cachedFiles[fp];
        }

        let isBinary = dirty ? false : !!(meta.isBinary || (binExtRe && binExtRe.test(fp)));
        if (rawText !== null && !isBinary && checkBinContent && checkBinContent(rawText)) {
            isBinary = true;
        }

        let hash = null;
        let lines = null;
        let text = null;
        if (rawText !== null && !isBinary) {
            hash = _fastHashString(rawText);
            lines = _countLines(rawText);
            if (rawText.length <= SNAPSHOT_MAX_TEXT_BYTES && totalTextBytes + rawText.length <= SNAPSHOT_MAX_TOTAL_TEXT_BYTES) {
                text = rawText;
                totalTextBytes += rawText.length;
            }
        }

        const entry = {
            size: null,
            mtime: null,
            hash,
            lines,
            text,
            dirty,
            isBinary
        };

        if (meta.virtual || !root) {
            entry.size = rawText !== null ? rawText.length : (typeof meta.size === 'number' ? meta.size : 0);
            entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
        } else if (isWebDAV) {
            entry.size = typeof meta.size === 'number' ? meta.size : null;
            entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
        } else if (degraded) {
            entry.size = typeof meta.size === 'number' && meta.size > 0 ? meta.size : null;
            entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
        } else {
            toStat.push({ fp, meta, entry, hasInMemText: rawText !== null });
        }

        files[fp] = entry;
    }

    if (toStat.length > 0) {
        for (let i = 0; i < toStat.length; i += SNAPSHOT_BATCH_SIZE) {
            if (_getRootHandle() !== root) break;
            const batch = toStat.slice(i, i + SNAPSHOT_BATCH_SIZE);
            await Promise.all(batch.map(async ({ fp, meta, entry, hasInMemText }) => {
                try {
                    const handle = meta.handle || (typeof window.getHandleByPath === 'function'
                        ? await window.getHandleByPath(fp, false, root)
                        : null);
                    if (!handle || typeof handle.getFile !== 'function') {
                        entry.size = typeof meta.size === 'number' ? meta.size : null;
                        entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
                        return;
                    }
                    const file = await handle.getFile();
                    const size = typeof file.size === 'number' ? file.size : null;
                    const mtime = file.lastModified ? file.lastModified / 1000 : null;
                    entry.size = size;
                    entry.mtime = mtime;
                    if (size !== null) meta.size = size;
                    if (mtime !== null) meta.mtime = mtime;
                } catch (err) {
                    if (err && err.name === 'NotFoundError') {
                        if (fp === window.PLAN_FILE && hasInMemText) {
                            entry.size = entry.text !== null ? entry.text.length : null;
                            entry.mtime = null;
                        } else {
                            delete files[fp];
                        }
                    } else {
                        entry.size = typeof meta.size === 'number' ? meta.size : null;
                        entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
                    }
                }
            }));
        }
    }

    return {
        ts,
        wsKey,
        degraded,
        fileCount: Object.keys(files).length,
        files
    };
}

function _classifyModificationSource(fp, prevTs, sessionId) {
    const sid = sessionId || window.state?.activeSessionId;
    const ctx = typeof window.sessionCtx === 'function' ? window.sessionCtx(sid) : null;
    const curOpsLog = ctx?.baseline?.opsLog || window.registry?.opsLog || {};

    let latestEditorOp = null;
    const curOps = curOpsLog[fp];
    if (Array.isArray(curOps)) {
        for (let i = curOps.length - 1; i >= 0; i--) {
            const op = curOps[i];
            if (!op || typeof op.ts !== 'number' || op.ts <= prevTs) continue;
            if (op.mode === 'editor') {
                latestEditorOp = op;
                break;
            }
        }
    }
    if (latestEditorOp) {
        return {
            source: 'saved in editor',
            opContent: typeof latestEditorOp.content === 'string' ? latestEditorOp.content : null
        };
    }

    // Check other loaded sessions' opsLogs for editor saves or cross-session tool writes.
    let latestOtherOp = null;
    const sessions = window.state?.sessions || {};
    for (const [otherId, s] of Object.entries(sessions)) {
        if (otherId === sid) continue;
        const otherOps = s?._baseline?.opsLog?.[fp];
        if (!Array.isArray(otherOps)) continue;
        for (let i = otherOps.length - 1; i >= 0; i--) {
            const op = otherOps[i];
            if (!op || typeof op.ts !== 'number' || op.ts <= prevTs) continue;
            if (!latestOtherOp || op.ts > latestOtherOp.ts) {
                latestOtherOp = op;
            }
            break;
        }
    }
    if (latestOtherOp) {
        const source = latestOtherOp.mode === 'editor' ? 'saved in editor' : 'by another session';
        return {
            source,
            opContent: typeof latestOtherOp.content === 'string' ? latestOtherOp.content : null
        };
    }

    return { source: 'on disk', opContent: null };
}

function _computeDeltaIfCached(beforeText, afterText) {
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') return null;
    if (beforeText === afterText) return null;
    if (beforeText.length > SNAPSHOT_MAX_TEXT_BYTES || afterText.length > SNAPSHOT_MAX_TEXT_BYTES) return null;
    if (typeof window.computeLineDiffCounts !== 'function') return null;
    const d = window.computeLineDiffCounts(beforeText, afterText);
    if (!d || (d.added === 0 && d.removed === 0)) return null;
    return d;
}

function diffWorkspaceSnapshot(prev, next, sessionId) {
    const empty = { modified: [], unsaved: [], added: [], deleted: [], total: 0 };
    if (!prev || !next || !prev.files || !next.files) return empty;
    if (prev.wsKey && next.wsKey && prev.wsKey !== next.wsKey) return empty;

    const modified = [];
    const unsaved = [];
    const added = [];
    const deleted = [];

    for (const fp of Object.keys(prev.files)) {
        if (!next.files[fp]) {
            deleted.push({ path: fp });
        }
    }

    for (const fp of Object.keys(next.files)) {
        const cur = next.files[fp];
        const old = prev.files[fp];

        if (!old) {
            if (cur.dirty) {
                unsaved.push({ path: fp, delta: null, lines: cur.lines });
            } else {
                added.push({ path: fp, lines: cur.lines, isBinary: cur.isBinary });
            }
            continue;
        }

        if (cur.dirty) {
            // Report when a buffer becomes dirty or its unsaved content changes since the last snapshot.
            if (!old.dirty || (cur.hash !== null && old.hash !== null && cur.hash !== old.hash)) {
                const delta = _computeDeltaIfCached(old.text, cur.text);
                unsaved.push({ path: fp, delta, lines: cur.lines });
            }
            continue;
        }

        const mtimeChanged = old.mtime !== null && cur.mtime !== null && old.mtime !== cur.mtime;
        const sizeChanged = old.size !== null && cur.size !== null && old.size !== cur.size;
        const diskChanged = mtimeChanged || sizeChanged;
        const hashChanged = old.hash !== null && cur.hash !== null && old.hash !== cur.hash;

        // If the buffer was dirty on the previous turn and the user simply saved the
        // exact same text, tools already saw this version — skip reporting a duplicate change.
        if (old.dirty && !cur.dirty && old.hash !== null && cur.hash !== null && old.hash === cur.hash) {
            continue;
        }

        if (!hashChanged && !diskChanged) {
            // In degraded mode (>5,000 local files without stat), fall back to checking opsLog.
            if (prev.degraded || next.degraded) {
                const modInfo = _classifyModificationSource(fp, prev.ts, sessionId);
                if (modInfo.source !== 'on disk') {
                    const afterText = cur.text ?? modInfo.opContent;
                    if (old.text === null || afterText === null || old.text !== afterText) {
                        modified.push({
                            path: fp,
                            source: modInfo.source,
                            delta: _computeDeltaIfCached(old.text, afterText)
                        });
                    }
                }
            }
            continue;
        }

        const modInfo = _classifyModificationSource(fp, prev.ts, sessionId);

        // Local-folder scans do not invalidate registry.files when a file changes outside
        // Workbench. If disk mtime/size changed while registry.files still matches the old
        // hash, drop the stale cache entry so subsequent tool reads fetch fresh disk content.
        if (diskChanged && !hashChanged && old.hash !== null && cur.hash !== null && old.hash === cur.hash) {
            if (modInfo.source === 'saved in editor') {
                // No-op save in editor (identical bytes).
                continue;
            }
            if (window.registry?.files && fp in window.registry.files) {
                delete window.registry.files[fp];
            }
            cur.text = null;
            cur.hash = null;
            modified.push({ path: fp, source: modInfo.source, delta: null });
            continue;
        }

        const afterText = cur.text ?? modInfo.opContent;
        if (old.text !== null && afterText !== null && old.text === afterText) {
            continue;
        }

        modified.push({
            path: fp,
            source: modInfo.source,
            delta: _computeDeltaIfCached(old.text, afterText)
        });
    }

    const byPath = (a, b) => a.path.localeCompare(b.path);
    modified.sort(byPath);
    unsaved.sort(byPath);
    added.sort(byPath);
    deleted.sort(byPath);

    const total = modified.length + unsaved.length + added.length + deleted.length;
    return { modified, unsaved, added, deleted, total };
}

function formatWorkspaceChangeNotice(diff, max) {
    if (!diff || !diff.total) return '';

    const limit = Number.isFinite(Number(max)) && Number(max) > 0
        ? Math.floor(Number(max))
        : _getChangeNotifyMax();

    const ordered = [
        ...diff.modified.map(item => ({ kind: 'modified', ...item })),
        ...diff.unsaved.map(item => ({ kind: 'unsaved', ...item })),
        ...diff.added.map(item => ({ kind: 'added', ...item })),
        ...diff.deleted.map(item => ({ kind: 'deleted', ...item }))
    ];

    if (ordered.length === 0) return '';

    const shown = ordered.slice(0, limit);
    const remaining = ordered.length - shown.length;
    const padWidth = Math.min(48, shown.reduce((m, item) => Math.max(m, item.path.length), 0));

    const lines = ['[Workspace changes since your last turn — not made by you:'];
    for (const item of shown) {
        const kindCol = item.kind.padEnd(8, ' ');
        let detail = '';

        if (item.kind === 'modified') {
            if (item.delta) {
                detail = `(+${item.delta.added} / −${item.delta.removed} lines)  ${item.source}`;
            } else {
                detail = `(${item.source})`;
            }
        } else if (item.kind === 'unsaved') {
            if (item.delta) {
                detail = `(+${item.delta.added} / −${item.delta.removed} lines)  open in editor with unsaved edits — tools see the unsaved version`;
            } else {
                detail = '(open in editor with unsaved edits — tools see the unsaved version)';
            }
        } else if (item.kind === 'added') {
            if (typeof item.lines === 'number') {
                detail = `(${item.lines} ${item.lines === 1 ? 'line' : 'lines'})`;
            } else if (item.isBinary) {
                detail = '(binary)';
            }
        }

        if (detail) {
            lines.push(`  ${kindCol}  ${item.path.padEnd(padWidth, ' ')}  ${detail}`);
        } else {
            lines.push(`  ${kindCol}  ${item.path}`);
        }
    }

    if (remaining > 0) {
        lines.push(`  … and ${remaining} more (use find to inspect)]`);
    } else {
        lines[lines.length - 1] += ']';
    }

    return lines.join('\n');
}

async function buildWorkspaceChangeNoticeForTurn(sessionId) {
    if (!_isChangeNotifyEnabled() || !_getRootHandle()) return '';
    if (typeof window.getGenState !== 'function') return '';

    const sid = sessionId || window.state?.activeSessionId;
    const runCtx = typeof window.sessionCtx === 'function' ? window.sessionCtx(sid) : null;
    // First turn of a session (or immediately after /clear): nothing to compare against.
    if (!runCtx || !Array.isArray(runCtx.messages) || runCtx.messages.length === 0) return '';

    const runGen = window.getGenState(sid);
    if (runGen._pendingSnapshotPromise) {
        try { await runGen._pendingSnapshotPromise; } catch (_) {}
    }

    const prev = runGen.lastWorkspaceSnapshot;
    if (!prev) return '';

    if (typeof window.ensureWorkspaceFresh === 'function') {
        await window.ensureWorkspaceFresh();
    }
    const next = await takeWorkspaceSnapshot();
    const diff = diffWorkspaceSnapshot(prev, next, sid);
    if (!diff.total) return '';

    return formatWorkspaceChangeNotice(diff, _getChangeNotifyMax());
}

function captureWorkspaceSnapshotForSession(sessionId) {
    if (!_isChangeNotifyEnabled() || !_getRootHandle()) return Promise.resolve(null);
    if (typeof window.getGenState !== 'function') return Promise.resolve(null);

    const sid = sessionId || window.state?.activeSessionId;
    const runGen = window.getGenState(sid);
    const expectedWsKey = typeof window.currentWsName === 'function' ? window.currentWsName() : '';

    const p = (async () => {
        try {
            if (typeof window.ensureWorkspaceFresh === 'function') {
                await window.ensureWorkspaceFresh();
            }
            const snap = await takeWorkspaceSnapshot();
            const curWsKey = typeof window.currentWsName === 'function' ? window.currentWsName() : '';
            if (snap && (!expectedWsKey || curWsKey === expectedWsKey)) {
                runGen.lastWorkspaceSnapshot = snap;
            }
            return snap;
        } catch (e) {
            console.warn('Workspace snapshot capture failed:', e);
            return null;
        } finally {
            if (runGen._pendingSnapshotPromise === p) {
                runGen._pendingSnapshotPromise = null;
            }
        }
    })();

    runGen._pendingSnapshotPromise = p;
    return p;
}

// --- AST_EXPORTS_START ---
window.takeWorkspaceSnapshot = takeWorkspaceSnapshot;
window.diffWorkspaceSnapshot = diffWorkspaceSnapshot;
window.formatWorkspaceChangeNotice = formatWorkspaceChangeNotice;
window.buildWorkspaceChangeNoticeForTurn = buildWorkspaceChangeNoticeForTurn;
window.captureWorkspaceSnapshotForSession = captureWorkspaceSnapshotForSession;
// --- AST_EXPORTS_END ---