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

// --- AST_EXPORTS_START ---
window.computeLineDiffCounts = computeLineDiffCounts;
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
// Single entry point for all reverts. Actions: {kind:'restore',filepath,content} | {kind:'delete',filepath} | {kind:'rename',filepath,targetPath}.
// Options: forgetPromptIds drops ops by prompt id; clearOpsFor wipes a file's opsLog.
async function executeRevertPlan(actions, opts = {}) {
    const forgetIds = opts.forgetPromptIds ? new Set(opts.forgetPromptIds) : null;
    const clearFor = opts.clearOpsFor ? new Set(opts.clearOpsFor) : null;
    let applied = 0;

    for (const action of actions) {
        try {
            if (action.kind === 'rename') {
                const res = await fs.rename(action.filepath, action.targetPath, { track: false });
                if (res && res.error) {
                    showToast(`Revert error (${action.filepath}): ${res.error}`, 'error');
                    continue;
                }
                // rawRename skips tracking; carry the op log and baseline to the new path.
                if (registry.opsLog[action.filepath]) {
                    registry.opsLog[action.targetPath] = registry.opsLog[action.filepath];
                    delete registry.opsLog[action.filepath];
                }
                if (action.filepath in registry.originalFiles) {
                    registry.originalFiles[action.targetPath] = registry.originalFiles[action.filepath];
                    delete registry.originalFiles[action.filepath];
                }
                // Update open tabs and Monaco models to the new path.
                if (state.openTabs.includes(action.filepath)) {
                    state.openTabs[state.openTabs.indexOf(action.filepath)] = action.targetPath;
                }
                if (state.activeTab === action.filepath) state.activeTab = action.targetPath;
                if (state.currentEditorPath === action.filepath) state.currentEditorPath = action.targetPath;
                if (state.currentDiffFilepath === action.filepath) state.currentDiffFilepath = action.targetPath;
                if (state.checkpointModalFile === action.filepath) state.checkpointModalFile = action.targetPath;
                const model = monacoModels.get(action.filepath);
                if (model) {
                    monacoModels.delete(action.filepath);
                    monacoModels.set(action.targetPath, model);
                }
            } else if (action.kind === 'delete') {
                await fs.del(action.filepath, { track: false });
            } else if (action.kind === 'restore') {
                await fs.write(action.filepath, action.content, { track: false });
                if (state.currentEditorPath === action.filepath && monacoEditor) {
                    const model = monacoModels.get(action.filepath);
                    if (model) withDirtyTrackingSuppressed(() => model.setValue(action.content));
                }
            }
            applied++;
        } catch (e) {
            showToast(`Revert error (${action.filepath}): ${e.message}`, 'error');
        }
    }

    // A prompt is a commit: forgetting its id drops all its ops from every file.
    if (forgetIds) {
        for (const fp of Object.keys(registry.opsLog)) {
            const kept = (registry.opsLog[fp] || []).filter(op => !(op.prompt && forgetIds.has(op.prompt.id)));
            if (kept.length) registry.opsLog[fp] = kept;
            else delete registry.opsLog[fp];
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
    await recomputeLineStats(sessionCtx(state.activeSessionId), state.activeSessionId);
    await persistCheckpoint();
    renderChangesPanel();
    renderExplorerTree();
    updateStatusInfo();

    // Refresh any open diff view and the graph so neither shows stale data.
    if (state.currentDiffFilepath) renderFileDiffView(state.currentDiffFilepath);
    refreshChangesGraph();
    if (state.currentEditorPath && monacoEditor) scheduleGutterDiffUpdate();

    return applied;
}

// --- AST_EXPORTS_START ---
window.executeRevertPlan = executeRevertPlan;
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
        const hasBaseline = registry.originalFiles[fp] !== undefined && registry.originalFiles[fp] !== null;
        const fileExists = registry.files[fp] !== undefined;
        const ops = registry.opsLog[fp] || [];

        let modified = false;
        if (hasBaseline) {
            // Pre-existing file: modified if gone or its content differs from the baseline.
            if (!fileExists) modified = true;
            else if (registry.files[fp] !== registry.originalFiles[fp]) modified = true;
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
    return { a: a.slice(start, endA), b: b.slice(start, endB) };
}

// --- AST_EXPORTS_START ---
window.trimCommonLines = trimCommonLines;
// --- AST_EXPORTS_END ---
