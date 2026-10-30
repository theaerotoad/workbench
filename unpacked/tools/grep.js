// grep - tool definition.
const TOOL_META = {
    "name": "grep",
    "description": "Search for regex or text string across files with line numbers.",
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string"
            },
            "path": {
                "type": "string",
                "description": "Optional subfolder or filename filter"
            },
            "case_sensitive": {
                "type": "boolean"
            }
        },
        "required": [
            "pattern"
        ]
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
            "key": "maxMatches",
            "label": "Max Matches",
            "type": "number",
            "default": 500,
            "min": 1,
            "max": 100000,
            "description": "Largest number of matching lines returned before results are truncated."
        },
        {
            "key": "previewLines",
            "label": "Preview Matches",
            "type": "number",
            "default": 30,
            "min": 0,
            "max": 500,
            "description": "How many matches are shown in the chat box (the model always receives the full result)."
        }
    ]
};

// --- UI helpers (display only, never sent to the model) ----------------------

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// Escapes text and wraps the first regex hit in a highlight span.
function highlight(text, re) {
    const t = text.length > 200 ? text.slice(0, 200) + '…' : text;
    const m = re.exec(t);
    if (!m || m[0] === '') return esc(t);
    const a = m.index, b = m.index + m[0].length;
    return esc(t.slice(0, a))
        + `<span class="tool-ui-highlight">${esc(t.slice(a, b))}</span>`
        + esc(t.slice(b));
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const flags = args.case_sensitive ? '' : 'i';
    let re;
    try {
        re = new RegExp(args.pattern, flags);
    } catch (e) {
        re = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }

    const maxLines = await api.getSetting('maxMatches');
    const allFiles = await api.listFiles();
    const binaryFlags = await Promise.all(allFiles.map(f => api.isBinary(f)));
    const filesToSearch = allFiles.filter((f, i) => !binaryFlags[i]);

    const scope = args.path || 'all files';
    const header = `pattern "${args.pattern}" in ${scope}`;
    await api.setHeaderMsg(header);

    const matches = []; // { fp, n, text }
    let searched = 0;

    for (const fp of filesToSearch) {
        if (args.path && !fp.includes(args.path)) continue;
        searched++;
        if (searched % 10 === 0) await api.setHeaderMsg(`${header} (${searched} files scanned)`);
        const txt = await api.readFile(fp);
        const lines = txt.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                if (matches.length >= maxLines) break;
                matches.push({ fp, n: i + 1, text: lines[i].trim() });
            }
        }
        if (matches.length >= maxLines) break;
    }

    const truncated = matches.length >= maxLines;
    const summary = `Grep: ${matches.length} match(es)${truncated ? ` (truncated at ${maxLines})` : ''}`;
    const output = api.cleanupText(matches.length ? matches.map(m => `${m.fp}:${m.n}: ${m.text}`).join('\n') : "(no matches)")
        + (truncated ? `\n\n[truncated: showing ${maxLines} of many matches]` : '');

    // --- Display ---------------------------------------------------------------

    const fileCounts = new Map();
    matches.forEach(m => fileCounts.set(m.fp, (fileCounts.get(m.fp) || 0) + 1));

    let previewLimit = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLimit) || previewLimit < 0) previewLimit = 30;
    const shown = matches.slice(0, previewLimit);
    const hidden = matches.length - shown.length;

    let rowsHtml = '';
    let lastFile = null;
    shown.forEach(m => {
        if (m.fp !== lastFile) {
            lastFile = m.fp;
            rowsHtml += `
                <div class="tool-ui-row">
                    <div class="tool-ui-path">${pathHtml(m.fp)}</div>
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0; margin-left:8px;">${fileCounts.get(m.fp)}</span>
                </div>`;
        }
        rowsHtml += `
            <div class="tool-ui-line-row">
                <div class="tool-ui-line-no">${m.n}</div>
                <div class="tool-ui-line-content">${highlight(m.text, re)}</div>
            </div>`;
    });
    if (hidden > 0) {
        rowsHtml += `<div class="tool-ui-more">… ${hidden} more match${hidden === 1 ? '' : 'es'} (full result was sent to the model)</div>`;
    }
    if (!matches.length) {
        rowsHtml = `<div class="tool-ui-empty">(no matches)</div>`;
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">search</span>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); font-weight:600;">${esc(args.pattern)}</div>
                    ${badge(scope, 'var(--primary)')}
                    ${args.case_sensitive ? badge('Aa', 'var(--dim)') : ''}
                    ${truncated ? badge('truncated', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:${matches.length ? 'var(--green)' : 'var(--dim)'}; font-weight:600;">${matches.length} match${matches.length === 1 ? '' : 'es'}</span>
                    <span>${fileCounts.size} file${fileCounts.size === 1 ? '' : 's'}</span>
                </div>
            </div>
            <div class="tool-ui-box">${rowsHtml}</div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>Searched ${searched} file${searched === 1 ? '' : 's'}</span>
                </div>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output, summary };
}