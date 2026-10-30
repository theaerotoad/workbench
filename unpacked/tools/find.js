// find - tool definition.
const TOOL_META = {
    "name": "find",
    "description": "Find files by filename pattern/extension (e.g. *.html, demo.rs, *.pas).",
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string"
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
            "key": "previewLines",
            "label": "Preview Files",
            "type": "number",
            "default": 30,
            "min": 0,
            "max": 500,
            "description": "How many file paths are shown in the chat box (the model always receives the full list)."
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

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const pat = args.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(pat, 'i');
    const allFiles = await api.listFiles();
    const matches = allFiles.filter(f => re.test(f));

    const summary = `"${args.pattern}": ${matches.length} file(s)`;
    const output = matches.length ? matches.join('\n') : "(no files matched)";

    // --- Display ---------------------------------------------------------------

    let previewLimit = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLimit) || previewLimit < 0) previewLimit = 30;
    const shown = matches.slice(0, previewLimit);
    const hidden = matches.length - shown.length;

    let rowsHtml = shown.map(fp => `
        <div class="tool-ui-line-row" style="align-items:center; padding:0 8px; gap:6px;">
            <span class="icon" style="font-size:12px; color:var(--dim); flex-shrink:0;">draft</span>
            <div class="tool-ui-path">${pathHtml(fp)}</div>
        </div>`).join('');
    if (hidden > 0) {
        rowsHtml += `<div class="tool-ui-more">… ${hidden} more file${hidden === 1 ? '' : 's'} (full list was sent to the model)</div>`;
    }
    if (!matches.length) {
        rowsHtml = `<div class="tool-ui-empty">(no files matched)</div>`;
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">find_in_page</span>
                    <div class="tool-ui-path" style="color:var(--fg); font-weight:600;">${esc(args.pattern)}</div>
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:${matches.length ? 'var(--green)' : 'var(--dim)'}; font-weight:600;">${matches.length} file${matches.length === 1 ? '' : 's'}</span>
                </div>
            </div>
            <div class="tool-ui-box">${rowsHtml}</div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>Matched against ${allFiles.length} file${allFiles.length === 1 ? '' : 's'}</span>
                </div>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output, summary };
}