// --- buildGraphFileRow.js ---
function buildGraphFileRow(filepath, entry, { onDiff } = {}) {
    const row = document.createElement('div');
    row.className = 'graph-file-row';
    const statusLabel = entry.kind === 'current' ? '' : (graphBadgeLabelMap[entry.kind] || 'Edit');
    row.innerHTML = `
        <span class="icon">description</span>
        <span class="graph-file-name" title="${escapeHTML(filepath)}">${escapeHTML(filepath)}</span>
        ${statusLabel ? `<span class="graph-file-status ${entry.kind}">${escapeHTML(statusLabel)}</span>` : ''}
        <button class="btn-graph-action history icon-btn" title="View this file's full history"><span class="icon" style="font-size:12px;">history</span></button>
    `;
    if (onDiff) {
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            onDiff(filepath, entry);
        });
    }
    const historyBtn = row.querySelector('.btn-graph-action.history');
    historyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.showCheckpointTimeline(filepath);
    });
    return row;
}

// --- AST_EXPORTS_START ---
window.buildGraphFileRow = buildGraphFileRow;
// --- AST_EXPORTS_END ---

// --- buildGraphRow.js ---
function buildGraphRow({ kind, isCurrent, message, manual, ts, fileCount, onExpand, onDiff, onRevert }) {
    const row = document.createElement('div');
    row.className = `graph-row${isCurrent ? ' current-row' : ''}`;

    row.innerHTML = `
        <div class="graph-rail"><div class="graph-node ${isCurrent ? 'current' : kind}"></div></div>
        <div class="graph-body">
            <div class="graph-msg-row">
                <span class="graph-msg ${manual ? 'manual' : ''}" title="${escapeHTML(message)}">${escapeHTML(message)}</span>
                <div class="graph-actions">
                    ${onDiff ? `<button class="btn-graph-action diff icon-btn" title="See what changed"><span class="icon" style="font-size:13px;">difference</span></button>` : ''}
                    ${onRevert ? `<button class="btn-graph-action revert icon-btn" title="Revert to here"><span class="icon" style="font-size:13px;">undo</span></button>` : ''}
                </div>
            </div>
        </div>
    `;

    if (onExpand) {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.btn-graph-action')) return;
            onExpand(row);
        });
    }
    const diffBtn = row.querySelector('.btn-graph-action.diff');
    if (diffBtn) diffBtn.addEventListener('click', (e) => { e.stopPropagation(); onDiff(); });
    const revertBtn = row.querySelector('.btn-graph-action.revert');
    if (revertBtn) revertBtn.addEventListener('click', (e) => { e.stopPropagation(); onRevert(); });

    return row;
}

// --- AST_EXPORTS_START ---
window.buildGraphRow = buildGraphRow;
// --- AST_EXPORTS_END ---

// --- getAllPromptGroups.js ---
function getAllPromptGroups() {
    const files = getAllTrackedFiles();
    const byPrompt = new Map();
    const order = [];

    for (const filepath of files) {
        const timeline = getFileTimeline(filepath);
        timeline.forEach(entry => {
            if (entry.kind === 'baseline') return;
            if (!entry.prompt || !entry.prompt.id) return;

            const key = entry.prompt.id;
            if (!byPrompt.has(key)) {
                byPrompt.set(key, { key, promptInfo: entry.prompt, ts: entry.prompt.ts || entry.ts || 0, touches: [] });
                order.push(key);
            }
            byPrompt.get(key).touches.push({ filepath, entry });
        });
    }

    return order.map(k => byPrompt.get(k)).sort((a, b) => a.ts - b.ts);
}

// --- AST_EXPORTS_START ---
window.getAllPromptGroups = getAllPromptGroups;
// --- AST_EXPORTS_END ---

// --- getAllTrackedFiles.js ---
function getAllTrackedFiles() {
    const set = new Set([
        ...Object.keys(registry.originalFiles),
        ...Object.keys(registry.opsLog),
        ...Array.from(state.modifiedFiles)
    ]);
    return Array.from(set);
}

// --- AST_EXPORTS_START ---
window.getAllTrackedFiles = getAllTrackedFiles;
// --- AST_EXPORTS_END ---

// --- graphKindForTouches.js ---
function graphKindForTouches(touches) {
    // Pick a representative node color when a single "commit" (prompt) touched
    // several files with different kinds of ops.
    const kinds = new Set(touches.map(t => t.entry.kind));
    if (kinds.size === 1) return [...kinds][0];
    if (kinds.has('delete') && kinds.size === 1) return 'delete';
    return 'mixed';
}

// --- AST_EXPORTS_START ---
window.graphKindForTouches = graphKindForTouches;
// --- AST_EXPORTS_END ---

// --- promptGroupKey.js ---
function promptGroupKey(entry) {
    if (entry.kind === 'baseline') return '__baseline';
    const p = entry.prompt;
    if (p && p.id) return `prompt_${p.id}`;
    return `__solo_${entry.index}`;
}

// --- AST_EXPORTS_START ---
window.promptGroupKey = promptGroupKey;
// --- AST_EXPORTS_END ---

// --- refreshChangesGraph.js ---
// Both sections of the Changes panel (Modified Files on top, Graph below)
// are always visible now — no tabs to switch between. This just (re)renders
// whichever graph mode is current: the repo-wide commit graph, or a
// drilled-into single file's history.
function refreshChangesGraph() {
    if (state.checkpointModalMode === 'file' && state.checkpointModalFile) {
        renderCheckpointTimeline(state.checkpointModalFile);
    } else {
        renderAllPromptGroups();
    }
}

// --- AST_EXPORTS_START ---
window.refreshChangesGraph = refreshChangesGraph;
// --- AST_EXPORTS_END ---

// --- renderAllPromptGroups.js ---
// ---- "all" mode: one dot per prompt across the whole workspace ----
function renderAllPromptGroups() {
    checkpointTimelineList.innerHTML = '';
    const groups = getAllPromptGroups().slice().reverse();

    if (groups.length === 0) {
        checkpointTimelineList.innerHTML = `<div class="tree-node dim" style="padding: 8px 12px;">(no prompts)</div>`;
        return;
    }

    groups.forEach(group => {
        const blame = formatPromptBlame(group.promptInfo);
        // Collapse to one row per file, but remember the *first* and *last*
        // timeline index this prompt touched on that file, so opening it
        // shows only what this prompt changed — not the file's whole history.
        const seenFiles = new Map();
        group.touches.forEach(t => {
            const existing = seenFiles.get(t.filepath);
            if (existing) {
                existing.lastEntry = t.entry;
                existing.lastIndex = t.entry.index;
            } else {
                seenFiles.set(t.filepath, { firstEntry: t.entry, lastEntry: t.entry, firstIndex: t.entry.index, lastIndex: t.entry.index });
            }
        });
        const fileEntries = Array.from(seenFiles.entries());
        const kind = graphKindForTouches(group.touches);

        const row = buildGraphRow({
            kind,
            isCurrent: false,
            message: blame.text,
            manual: blame.manual,
            ts: group.ts,
            fileCount: fileEntries.length,
            onExpand: (r) => toggleGraphExpand(r, (panel) => {
                fileEntries.forEach(([filepath, touch]) => {
                    panel.appendChild(buildGraphFileRow(filepath, touch.lastEntry, {
                        onDiff: () => window.openCheckpointDiff(filepath, touch.firstIndex - 1, touch.lastIndex),
                    }));
                });
            }),
            onRevert: () => window.revertToBeforePrompt(group.key, blame.text),
        });
        checkpointTimelineList.appendChild(row);
    });
}

// --- AST_EXPORTS_START ---
window.renderAllPromptGroups = renderAllPromptGroups;
// --- AST_EXPORTS_END ---

// --- renderChangesPanel.js ---
function renderChangesPanel() {
    const list = Array.from(state.modifiedFiles).sort();
    changesCountEl.innerText = list.length;
    if (list.length > 0) changesCountEl.classList.add('has-changes');
    else changesCountEl.classList.remove('has-changes');
    changesList.innerHTML = '';

    if (list.length === 0) {
        changesList.innerHTML = `<div class="tree-node dim" style="padding: 8px 12px;">(no changes)</div>`;
        return;
    }

    list.forEach(fp => {
        const isNew = registry.originalFiles[fp] === undefined;
        const row = document.createElement('div');
        row.className = 'change-item';
        row.innerHTML = `
            <span class="change-tag ${isNew ? 'a' : 'm'}">${isNew ? 'A' : 'M'}</span>
            <span class="change-item-name" title="${escapeHTML(fp)}">${escapeHTML(fp)}</span>
            <div class="change-actions">
                <button class="btn-change-action icon-btn" title="View Diff">
                    <span class="icon" style="font-size:13px; color:var(--primary);">difference</span>
                </button>
                <button class="btn-change-action show-timeline icon-btn" title="View history in Prompts (revert/discard from here)">
                    <span class="icon" style="font-size:13px; color:var(--magenta, violet);">commit</span>
                </button>
            </div>
        `;

        row.addEventListener('click', () => window.openFileDiff(fp));
        row.querySelector('.btn-change-action').addEventListener('click', (e) => {
            e.stopPropagation();
            window.openFileDiff(fp);
        });
        row.querySelector('.btn-change-action.show-timeline').addEventListener('click', (e) => {
            e.stopPropagation();
            window.showCheckpointTimeline(fp);
        });

        changesList.appendChild(row);
    });
}

// --- AST_EXPORTS_START ---
window.renderChangesPanel = renderChangesPanel;
// --- AST_EXPORTS_END ---

// --- renderCheckpointTimeline.js ---
// ---- "file" mode: one dot per checkpoint on a single file ----
function renderCheckpointTimeline(filepath) {
    const timeline = getFileTimeline(filepath);
    checkpointTimelineList.innerHTML = '';

    const groups = [];
    for (const entry of timeline) {
        const key = promptGroupKey(entry);
        const last = groups[groups.length - 1];
        if (entry.kind !== 'baseline' && entry.kind !== 'current' && last && last.key === key) {
            last.entries.push(entry);
        } else {
            groups.push({ key, entries: [entry] });
        }
    }

    const reversedGroups = [...groups].reverse();
    if (reversedGroups.length === 0) {
        checkpointTimelineList.innerHTML = `<div class="tree-node dim" style="padding: 8px 12px;">No history yet.</div>`;
        return;
    }

    reversedGroups.forEach(group => {
        const newestInGroup = group.entries[group.entries.length - 1];
        const oldestInGroup = group.entries[0];
        const isCurrent = newestInGroup.kind === 'current';
        const isBaseline = group.entries.length === 1 && newestInGroup.kind === 'baseline';
        const blame = isCurrent ? { text: 'Current state', manual: true } : formatPromptBlame(newestInGroup.prompt);
        const kind = isBaseline ? 'baseline' : (isCurrent ? 'current' : graphKindForTouches(group.entries.map(entry => ({ entry }))));
        const promptId = newestInGroup.prompt && newestInGroup.prompt.id;
        const editCount = group.entries.length;
        const hasPrev = oldestInGroup.index > 0;

        const row = buildGraphRow({
            kind,
            isCurrent,
            message: isBaseline ? 'Original content' : blame.text,
            manual: blame.manual,
            ts: newestInGroup.ts,
            fileCount: (isCurrent || isBaseline) ? null : editCount,
            onExpand: (editCount > 1 && !isCurrent && !isBaseline) ? (r) => toggleGraphExpand(r, (panel) => {
                [...group.entries].reverse().forEach(entry => {
                    const label = graphBadgeLabelMap[entry.kind] || 'Edit';
                    const sub = document.createElement('div');
                    sub.className = 'graph-file-row';
                    sub.innerHTML = `<span class="icon">history</span><span class="graph-file-name">${escapeHTML(label)}</span><span class="graph-ts">${entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''}</span>`;
                    if (entry.index > 0) {
                        sub.style.cursor = 'pointer';
                        sub.addEventListener('click', (e) => { e.stopPropagation(); window.openCheckpointDiff(filepath, entry.index - 1, entry.index); });
                    }
                    panel.appendChild(sub);
                });
            }) : null,
            onDiff: (hasPrev && !isCurrent) ? () => window.openCheckpointDiff(filepath, oldestInGroup.index - 1, newestInGroup.index) : null,
            onRevert: (!isCurrent && ['baseline', 'checkpoint', 'delete', 'rename-out'].includes(newestInGroup.kind))
                ? () => (promptId ? window.revertToBeforePrompt(promptId, blame.text) : window.revertFileToCheckpoint(filepath, newestInGroup.index))
                : null,
        });
        checkpointTimelineList.appendChild(row);
    });
}

// --- AST_EXPORTS_START ---
window.renderCheckpointTimeline = renderCheckpointTimeline;
// --- AST_EXPORTS_END ---

// --- renderFileDiffView.js ---
async function renderFileDiffView(filepath, checkpointRange) {
    if (!monacoDiffEditor) return;

    state.currentDiffFilepath = filepath;
    state.currentDiffCheckpointRange = checkpointRange || null;
    btnDiffSave.style.display = 'inline-flex';
    btnDiffDiscard.style.display = 'inline-flex';

    let origContent, modContent, titleSuffix;

    if (checkpointRange) {
        if (registry.files[filepath] === undefined) {
            await readFileContent(filepath);
        }
        const timeline = getFileTimeline(filepath);
        const fromEntry = timeline[checkpointRange.from];
        const toEntry = timeline[checkpointRange.to];
        origContent = fromEntry ? (fromEntry.content || '') : '';
        modContent = toEntry ? (toEntry.content || '') : '';
        const fromLabel = fromEntry?.kind === 'baseline' ? 'Baseline' : fromEntry?.ts ? new Date(fromEntry.ts).toLocaleString() : '?';
        const toLabel = toEntry?.kind === 'current' ? 'Current' : toEntry?.ts ? new Date(toEntry.ts).toLocaleString() : '?';
        titleSuffix = `(${fromLabel} → ${toLabel})`;
        btnDiffSave.style.display = 'none';
        btnDiffDiscard.style.display = 'none';
    } else {
        origContent = registry.originalFiles[filepath] || '';
        modContent = (await readFileContent(filepath)) || '';
        titleSuffix = '(vs Baseline)';
    }

    diffTitle.innerText = `Changes Diff: ${filepath} ${titleSuffix}`;

    const origModel = MONACO.editor.createModel(origContent, langOf(filepath));
    const modModel = MONACO.editor.createModel(modContent, langOf(filepath));

    monacoDiffEditor.setModel({ original: origModel, modified: modModel });
    monacoDiffEditor.updateOptions({ readOnly: !!checkpointRange });
    const beforeLines = origContent ? origContent.split('\n').length : 0;
    const afterLines = modContent ? modContent.split('\n').length : 0;
    diffStats.innerHTML = checkpointRange
        ? `<span class="dim">${beforeLines} lines → ${afterLines} lines</span>`
        : `<span class="dim">${beforeLines} baseline lines → ${afterLines} modified lines</span>`;

    setTimeout(() => monacoDiffEditor.layout(), 10);
}

// --- AST_EXPORTS_START ---
window.renderFileDiffView = renderFileDiffView;
// --- AST_EXPORTS_END ---

// --- toggleGraphExpand.js ---
function toggleGraphExpand(row, filesBuilder) {
    const already = row.nextElementSibling && row.nextElementSibling.classList.contains('graph-files');
    // Collapse any other open panel so only one commit is expanded at a time.
    checkpointTimelineList.querySelectorAll('.graph-files').forEach(el => el.remove());
    checkpointTimelineList.querySelectorAll('.graph-row.expanded').forEach(el => el.classList.remove('expanded'));
    if (already) return;
    row.classList.add('expanded');
    const panel = document.createElement('div');
    panel.className = 'graph-files';
    filesBuilder(panel);
    row.after(panel);
}

// --- AST_EXPORTS_START ---
window.toggleGraphExpand = toggleGraphExpand;
// --- AST_EXPORTS_END ---
