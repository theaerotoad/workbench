// changes - tool definition.
const TOOL_META = {
    "name": "changes",
    "description": "Inspect files modified in the current session (by the agent or user), with per-file line counts and optional unified diffs against session baselines.",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Optional workspace-relative file path or directory prefix to filter changes."
            },
            "diff": {
                "type": "boolean",
                "description": "When true, include bounded unified diffs against the session baseline. Defaults to false."
            },
            "context": {
                "type": "integer",
                "description": "Number of unchanged context lines around each diff hunk when diff is true. Defaults to 3."
            }
        },
        "required": []
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "always",
    "toolBox": 1,
    "settings": [
        {
            "key": "maxDiffLines",
            "label": "Max Diff Lines",
            "type": "number",
            "default": 400,
            "min": 20,
            "max": 5000,
            "description": "Maximum total unified diff lines sent to the model when diff is true."
        },
        {
            "key": "previewFiles",
            "label": "Preview Files",
            "type": "number",
            "default": 30,
            "min": 0,
            "max": 500,
            "description": "Maximum number of changed files shown in the chat card."
        },
        {
            "key": "previewDiffLines",
            "label": "Preview Diff Lines",
            "type": "number",
            "default": 80,
            "min": 0,
            "max": 500,
            "description": "Maximum number of diff lines previewed in the chat card when diff is true."
        }
    ]
};

// --- Pure diff & formatting helpers ------------------------------------------

const MYERS_MAX_D = 1500;

function normalizePathFilter(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
}

function splitLines(text) {
    if (text === null || text === undefined || text === '') return [];
    return String(text).replace(/\r\n/g, '\n').split('\n');
}

function backtrackMyers(trace, a, b, offsetA, offsetB) {
    const edits = [];
    let x = a.length;
    let y = b.length;

    for (let d = trace.length - 1; d > 0; d--) {
        const k = x - y;
        let prevK;
        if (k === -d || (k !== d && (trace[d - 1][k - 1] < trace[d - 1][k + 1]))) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        const prevX = trace[d - 1][prevK];
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
            edits.unshift({ type: 'keep', lineA: offsetA + x, lineB: offsetB + y, text: a[x - 1] });
            x--;
            y--;
        }

        if (x === prevX) {
            edits.unshift({ type: 'add', lineB: offsetB + y, text: b[y - 1] });
            y--;
        } else if (y === prevY) {
            edits.unshift({ type: 'delete', lineA: offsetA + x, text: a[x - 1] });
            x--;
        }
    }

    while (x > 0 && y > 0) {
        edits.unshift({ type: 'keep', lineA: offsetA + x, lineB: offsetB + y, text: a[x - 1] });
        x--;
        y--;
    }
    return edits;
}

function computeEdits(a, b, offsetA, offsetB) {
    const N = a.length;
    const M = b.length;
    if (N === 0 && M === 0) return [];
    if (N === 0) {
        return b.map((text, idx) => ({ type: 'add', lineB: offsetB + idx + 1, text }));
    }
    if (M === 0) {
        return a.map((text, idx) => ({ type: 'delete', lineA: offsetA + idx + 1, text }));
    }

    const MAX = Math.min(N + M, MYERS_MAX_D);
    const v = { 1: 0 };
    const trace = [];

    for (let d = 0; d <= MAX; d++) {
        trace.push(Object.assign({}, v));
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && (v[k - 1] < v[k + 1]))) {
                x = v[k + 1];
            } else {
                x = v[k - 1] + 1;
            }
            let y = x - k;
            while (x < N && y < M && a[x] === b[y]) {
                x++;
                y++;
            }
            v[k] = x;
            if (x >= N && y >= M) {
                return backtrackMyers(trace, a, b, offsetA, offsetB);
            }
        }
    }

    // Fallback for very large diffs: emit middle slice as a single replacement block.
    const fallback = [];
    for (let i = 0; i < N; i++) {
        fallback.push({ type: 'delete', lineA: offsetA + i + 1, text: a[i] });
    }
    for (let j = 0; j < M; j++) {
        fallback.push({ type: 'add', lineB: offsetB + j + 1, text: b[j] });
    }
    return fallback;
}

function buildUnifiedDiff(filepath, beforeText, afterText, contextSize) {
    const isAdded = beforeText === null || beforeText === undefined;
    const isDeleted = afterText === null || afterText === undefined;
    const headerA = isAdded ? '--- /dev/null' : `--- a/${filepath}`;
    const headerB = isDeleted ? '+++ /dev/null' : `+++ b/${filepath}`;

    const linesA = isAdded ? [] : splitLines(beforeText);
    const linesB = isDeleted ? [] : splitLines(afterText);

    let startA = 0;
    let startB = 0;
    while (startA < linesA.length && startB < linesB.length && linesA[startA] === linesB[startB]) {
        startA++;
        startB++;
    }

    let endA = linesA.length - 1;
    let endB = linesB.length - 1;
    while (endA >= startA && endB >= startB && linesA[endA] === linesB[endB]) {
        endA--;
        endB--;
    }

    const fullEdits = [];
    for (let i = 0; i < startA; i++) {
        fullEdits.push({ type: 'keep', lineA: i + 1, lineB: i + 1, text: linesA[i] });
    }

    const middleA = linesA.slice(startA, endA + 1);
    const middleB = linesB.slice(startB, endB + 1);
    fullEdits.push(...computeEdits(middleA, middleB, startA, startB));

    for (let i = endA + 1; i < linesA.length; i++) {
        const lineBIdx = endB + 1 + (i - (endA + 1));
        fullEdits.push({ type: 'keep', lineA: i + 1, lineB: lineBIdx + 1, text: linesA[i] });
    }

    const changeIndices = [];
    for (let i = 0; i < fullEdits.length; i++) {
        if (fullEdits[i].type === 'add' || fullEdits[i].type === 'delete') {
            changeIndices.push(i);
        }
    }

    if (changeIndices.length === 0) {
        return [headerA, headerB, '(no text differences)'];
    }

    const hunks = [];
    let currentHunk = [changeIndices[0]];
    for (let i = 1; i < changeIndices.length; i++) {
        if (changeIndices[i] - changeIndices[i - 1] <= contextSize * 2) {
            currentHunk.push(changeIndices[i]);
        } else {
            hunks.push(currentHunk);
            currentHunk = [changeIndices[i]];
        }
    }
    hunks.push(currentHunk);

    const out = [headerA, headerB];
    for (const hunk of hunks) {
        const startIdx = Math.max(0, hunk[0] - contextSize);
        const endIdx = Math.min(fullEdits.length - 1, hunk[hunk.length - 1] + contextSize);
        const slice = fullEdits.slice(startIdx, endIdx + 1);

        let aCount = 0;
        let bCount = 0;
        let aStart = null;
        let bStart = null;

        for (const item of slice) {
            if (item.type === 'keep') {
                if (aStart === null) aStart = item.lineA;
                if (bStart === null) bStart = item.lineB;
                aCount++;
                bCount++;
            } else if (item.type === 'delete') {
                if (aStart === null) aStart = item.lineA;
                aCount++;
            } else if (item.type === 'add') {
                if (bStart === null) bStart = item.lineB;
                bCount++;
            }
        }

        const hdrA = aCount === 0 ? '0,0' : `${aStart || 1},${aCount}`;
        const hdrB = bCount === 0 ? '0,0' : `${bStart || 1},${bCount}`;
        out.push(`@@ -${hdrA} +${hdrB} @@`);

        for (const item of slice) {
            if (item.type === 'keep') out.push(` ${item.text}`);
            else if (item.type === 'delete') out.push(`-${item.text}`);
            else if (item.type === 'add') out.push(`+${item.text}`);
        }
    }

    return out;
}

function formatLineStats(item) {
    if (item.isBinary) return 'binary';
    if (item.status === 'added') return `+${item.added} line${item.added === 1 ? '' : 's'}`;
    if (item.status === 'deleted') return `-${item.removed} line${item.removed === 1 ? '' : 's'}`;
    return `+${item.added} / -${item.removed} lines`;
}

function formatChangeSummaryLine(item, padWidth) {
    const statusCol = item.status.padEnd(8, ' ');
    const stats = `(${formatLineStats(item)})`;
    const tags = [];
    if (item.dirty) tags.push('unsaved');
    if (Array.isArray(item.sources) && item.sources.length) {
        tags.push(...item.sources);
    }
    const tagStr = tags.length ? `  [${tags.join(', ')}]` : '';
    return `  ${statusCol}  ${item.path.padEnd(padWidth, ' ')}  ${stats}${tagStr}`;
}

function buildDiffOutput(files, contextSize, maxDiffLines) {
    const allLines = [];
    let remaining = maxDiffLines;
    let truncatedFiles = 0;
    let truncatedMidFile = false;

    for (let i = 0; i < files.length; i++) {
        const item = files[i];
        if (remaining <= 0) {
            truncatedFiles = files.length - i;
            break;
        }

        let fileLines;
        if (item.contentOmitted === 'binary' || item.isBinary) {
            fileLines = [`--- ${item.path}`, `(binary file changed; diff omitted)`];
        } else if (item.contentOmitted === 'too_large') {
            fileLines = [`--- ${item.path}`, `(file exceeds diff size limit; inspect with read)`];
        } else {
            fileLines = buildUnifiedDiff(item.path, item.before, item.after, contextSize);
        }

        if (allLines.length > 0) allLines.push('');

        if (fileLines.length <= remaining) {
            allLines.push(...fileLines);
            remaining -= fileLines.length;
        } else {
            const sliceCount = Math.max(3, remaining);
            allLines.push(...fileLines.slice(0, sliceCount));
            const omittedInFile = fileLines.length - sliceCount;
            allLines.push(`… (${omittedInFile} more diff line${omittedInFile === 1 ? '' : 's'} omitted in ${item.path})`);
            truncatedMidFile = true;
            remaining = 0;
            if (i + 1 < files.length) {
                truncatedFiles = files.length - (i + 1);
            }
            break;
        }
    }

    if (truncatedFiles > 0) {
        allLines.push('');
        allLines.push(`… diff budget (${maxDiffLines} lines) reached; ${truncatedFiles} more file${truncatedFiles === 1 ? '' : 's'} omitted. Call changes(path: "<file>", diff: true) to inspect a specific file.`);
    } else if (truncatedMidFile) {
        allLines.push(`… diff budget (${maxDiffLines} lines) reached. Call changes(path: "<file>", diff: true) to inspect a specific file.`);
    }

    return allLines;
}

// --- UI helpers (display only, never sent to the model) ----------------------

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c]));
}

function pathHtml(fp) {
    const parts = String(fp || '').split('/');
    const name = parts.pop() || fp;
    const dir = parts.length ? parts.join('/') + '/' : '';
    return `<span class="tool-ui-path-dir">${esc(dir)}</span><span class="tool-ui-path-name">${esc(name)}</span>`;
}

function badge(text, colorVar) {
    return `<span class="tool-ui-badge" style="color:${colorVar}; background:color-mix(in srgb, ${colorVar} 15%, transparent);">${esc(text)}</span>`;
}

function statusColor(status) {
    if (status === 'added') return 'var(--green)';
    if (status === 'deleted') return 'var(--red)';
    return 'var(--yellow)';
}

function diffLineStyle(line) {
    if (line.startsWith('+++') || line.startsWith('---')) {
        return 'color:var(--fg); font-weight:600;';
    }
    if (line.startsWith('@@')) {
        return 'color:var(--primary);';
    }
    if (line.startsWith('+')) {
        return 'color:var(--green); background:color-mix(in srgb, var(--green) 10%, transparent);';
    }
    if (line.startsWith('-')) {
        return 'color:var(--red); background:color-mix(in srgb, var(--red) 10%, transparent);';
    }
    return 'color:var(--dim);';
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    if (typeof api.getSessionChanges !== 'function') {
        return 'ERROR: api.getSessionChanges is not available in this host version.';
    }

    const filterPath = normalizePathFilter(args.path);
    const wantDiff = !!args.diff;
    let contextSize = Number.isInteger(args.context) ? args.context : 3;
    if (contextSize < 0) contextSize = 0;
    if (contextSize > 20) contextSize = 20;

    let maxDiffLines = Number(await api.getSetting('maxDiffLines'));
    if (!Number.isFinite(maxDiffLines) || maxDiffLines < 20) maxDiffLines = 400;

    await api.setHeaderMsg(filterPath ? `Inspecting changes in ${filterPath}` : 'Inspecting session changes');

    const res = await api.getSessionChanges(filterPath || undefined, {
        includeContent: wantDiff
    });

    if (res && res.error) {
        const errHtml = `
            <div class="tool-ui-wrap">
                <div class="tool-ui-bar">
                    <div class="tool-ui-header-info">
                        <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">error</span>
                        <div class="tool-ui-path">${filterPath ? pathHtml(filterPath) : 'changes'}</div>
                    </div>
                </div>
                <div class="tool-ui-error-wrap">
                    <div class="tool-ui-error-msg">${esc(res.error)}</div>
                </div>
            </div>`;
        await api.showUI(errHtml);
        return { output: res.error, summary: `changes error` };
    }

    const files = Array.isArray(res?.files) ? res.files : [];
    const totalAdded = Number(res?.totalAdded) || 0;
    const totalRemoved = Number(res?.totalRemoved) || 0;
    const allModifiedCount = Number(res?.allModifiedCount) || 0;

    if (files.length === 0) {
        const emptyMsg = filterPath
            ? (allModifiedCount > 0
                ? `No session changes matching "${filterPath}" (${allModifiedCount} other file${allModifiedCount === 1 ? '' : 's'} modified in this session).`
                : `No session changes matching "${filterPath}".`)
            : 'No files have been modified in this session.';

        const emptyHtml = `
            <div class="tool-ui-wrap">
                <div class="tool-ui-bar">
                    <div class="tool-ui-header-info">
                        <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">difference</span>
                        <div class="tool-ui-path" style="color:var(--fg); font-weight:600;">Session changes</div>
                        ${filterPath ? badge(filterPath, 'var(--primary)') : ''}
                    </div>
                    <div class="tool-ui-header-stats">
                        <span style="color:var(--dim);">0 files</span>
                    </div>
                </div>
                <div class="tool-ui-box"><div class="tool-ui-empty">${esc(emptyMsg)}</div></div>
            </div>`;
        await api.showUI(emptyHtml);
        return { output: emptyMsg, summary: filterPath ? `${filterPath}: no changes` : 'no session changes' };
    }

    const padWidth = Math.min(48, files.reduce((m, item) => Math.max(m, item.path.length), 0));
    const headerScope = filterPath ? ` in ${filterPath}` : '';
    const outLines = [
        `Session changes${headerScope}: ${files.length} file${files.length === 1 ? '' : 's'} (+${totalAdded} / -${totalRemoved} lines)`,
        ...files.map(item => formatChangeSummaryLine(item, padWidth))
    ];

    let diffLines = [];
    if (wantDiff) {
        diffLines = buildDiffOutput(files, contextSize, maxDiffLines);
        if (diffLines.length > 0) {
            outLines.push('');
            outLines.push(...diffLines);
        }
    }

    const output = api.cleanupText(outLines.join('\n'));
    const summary = `${files.length} changed file${files.length === 1 ? '' : 's'} (+${totalAdded} / -${totalRemoved})${wantDiff ? ' [diff]' : ''}`;

    // --- Display ---------------------------------------------------------------

    let previewFiles = Number(await api.getSetting('previewFiles'));
    if (!Number.isFinite(previewFiles) || previewFiles < 0) previewFiles = 30;

    let previewDiffLines = Number(await api.getSetting('previewDiffLines'));
    if (!Number.isFinite(previewDiffLines) || previewDiffLines < 0) previewDiffLines = 80;

    const shownFiles = files.slice(0, previewFiles);
    const hiddenFiles = files.length - shownFiles.length;

    let rowsHtml = shownFiles.map(item => {
        const statsHtml = item.isBinary
            ? `<span style="color:var(--dim); font-size:10px;">binary</span>`
            : `<span style="font-size:10px; white-space:nowrap;">` +
              `<span style="color:var(--green);">+${item.added}</span>` +
              `<span style="color:var(--dim);"> / </span>` +
              `<span style="color:var(--red);">-${item.removed}</span>` +
              `</span>`;
        const dirtyTag = item.dirty ? badge('unsaved', 'var(--primary)') : '';
        return `
        <div class="tool-ui-line-row" style="align-items:center; justify-content:space-between; padding:0 8px; gap:8px;">
            <div style="display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden;">
                ${badge(item.status, statusColor(item.status))}
                <div class="tool-ui-path">${pathHtml(item.path)}</div>
                ${dirtyTag}
            </div>
            ${statsHtml}
        </div>`;
    }).join('');

    if (hiddenFiles > 0) {
        rowsHtml += `<div class="tool-ui-more">… ${hiddenFiles} more changed file${hiddenFiles === 1 ? '' : 's'} (full list sent to the model)</div>`;
    }

    let diffBoxHtml = '';
    if (wantDiff && diffLines.length > 0 && previewDiffLines > 0) {
        const shownDiff = diffLines.slice(0, previewDiffLines);
        const hiddenDiff = diffLines.length - shownDiff.length;
        const diffRows = shownDiff.map(line =>
            `<div style="padding:0 8px; white-space:pre; font-family:var(--font-mono); font-size:11px; line-height:1.45; ${diffLineStyle(line)}">${esc(line || ' ')}</div>`
        ).join('');
        const diffMore = hiddenDiff > 0
            ? `<div class="tool-ui-more">… ${hiddenDiff} more diff line${hiddenDiff === 1 ? '' : 's'}</div>`
            : '';
        diffBoxHtml = `<div class="tool-ui-box" style="margin-top:6px; overflow-x:auto;">${diffRows}${diffMore}</div>`;
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">difference</span>
                    <div class="tool-ui-path" style="color:var(--fg); font-weight:600;">Session changes</div>
                    ${filterPath ? badge(filterPath, 'var(--primary)') : ''}
                    ${wantDiff ? badge('diff', 'var(--blue)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--fg); font-weight:600;">${files.length} file${files.length === 1 ? '' : 's'}</span>
                    <span style="color:var(--green); font-weight:600;">+${totalAdded}</span>
                    <span style="color:var(--red); font-weight:600;">-${totalRemoved}</span>
                </div>
            </div>
            <div class="tool-ui-box">${rowsHtml}</div>
            ${diffBoxHtml}
        </div>`;

    await api.showUI(displayHtml);
    return { output, summary };
}