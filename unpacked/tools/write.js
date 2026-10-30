// write - tool definition.
const TOOL_META = {
    "name": "write",
    "description": "Create a new file, or fully overwrite an existing one. Use this for creating new files. For changes to an existing file, prefer the \"edit\" tool instead.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string"
            },
            "content": {
                "type": "string",
                "description": "Full file content. Use an empty string to create an empty file.",
                "allowEmpty": true
            }
        },
        "required": [
            "filepath",
            "content"
        ]
    },
    "modes": [
        "plan",
        "code"
    ],
    "permission": "ask",
    "toolBox": 1,
    "settings": [
        {
            "key": "previewLines",
            "label": "Preview Lines",
            "type": "number",
            "default": 12,
            "min": 0,
            "max": 200,
            "description": "How many lines of the written content are shown in the chat box."
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
    return `<div class="tool-ui-path"><span class="tool-ui-path-dir">${esc(dir)}</span><span class="tool-ui-path-name">${esc(name)}</span></div>`;
}

function badge(text, colorVar) {
    return `<span class="tool-ui-badge" style="color:${colorVar}; background:color-mix(in srgb, ${colorVar} 15%, transparent);">${esc(text)}</span>`;
}

function errorHtml(fp, label, msg) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    ${badge(label, 'var(--red)')}
                </div>
                <span style="color:var(--dim); font-size:10px;">no changes applied</span>
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

async function fail(api, fp, msg) {
    const clean = String(msg).replace(/^ERROR:\s*/, '');
    await api.showUI(errorHtml(fp, 'Write Failed', clean));
    return { output: `ERROR: ${clean}` };
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = args.filepath;

    if (api.mode === 'ask') return { output: "ERROR: Ask mode is strictly read-only. File modification is disabled. Switch to Code mode to apply changes." };
    if (api.mode === 'plan' && fp !== api.planFile) {
        return { output: `ERROR: Plan mode can ONLY write to "${api.planFile}". You cannot create or modify other files until the plan is approved.` };
    }

    const header = `${fp}`;
    await api.setHeaderMsg(header);

    try {
        const content = args.content == null ? '' : String(args.content);

        // Remember what was there so the card can say "created" vs "overwritten".
        const existed = await api.fileExists(fp);
        let oldLineCount = null;
        if (existed) {
            try {
                if (!(await api.isBinary(fp))) {
                    const old = await api.readFile(fp);
                    if (typeof old === 'string' && !/^ERROR: [^\n]*$/.test(old)) oldLineCount = old.split(/\r?\n/).length;
                }
            } catch (e) { /* preview only */ }
        }

        const err = await api.writeFile(fp, content);
        if (err) return fail(api, fp, err);

        // --- Display -----------------------------------------------------------

        const lines = content === '' ? [] : content.split(/\r?\n/);
        const bytes = new TextEncoder().encode(content).length;

        let previewLines = Number(await api.getSetting('previewLines'));
        if (!Number.isFinite(previewLines) || previewLines < 0) previewLines = 12;
        const shown = lines.slice(0, previewLines);
        const hidden = lines.length - shown.length;

        const rowsHtml = shown.map((l, i) => {
            const t = l.length > 300 ? l.slice(0, 300) + '…' : l;
            return `
                <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--green) 8%, transparent); color:var(--green);">
                    <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--green) 55%, transparent); border-right-color:color-mix(in srgb, var(--green) 20%, transparent);">${i + 1}</div>
                    <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--green) 80%, transparent); flex-shrink:0;">+</div>
                    <div class="tool-ui-line-content" style="color:inherit;">${esc(t)}</div>
                </div>`;
        }).join('');

        const moreHtml = hidden > 0
            ? `<div class="tool-ui-more" style="padding-left:62px;">… ${hidden} more line${hidden === 1 ? '' : 's'}</div>`
            : '';
        const emptyHtml = lines.length === 0
            ? `<div class="tool-ui-empty">(empty file)</div>`
            : '';
        const body = (rowsHtml || emptyHtml)
            ? `<div class="tool-ui-box">${rowsHtml}${emptyHtml}${moreHtml}</div>`
            : '';

        const statusText = existed
            ? `Overwrote file${oldLineCount !== null ? ` (was ${oldLineCount} line${oldLineCount === 1 ? '' : 's'})` : ''}`
            : 'Created new file';

        const displayHtml = `
            <div class="tool-ui-wrap">
                <div class="tool-ui-bar">
                    <div class="tool-ui-header-info">
                        <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">${existed ? 'edit_document' : 'note_add'}</span>
                        ${pathHtml(fp)}
                        ${existed
                            ? badge('OVERWRITTEN', 'var(--yellow)')
                            : badge('NEW', 'var(--green)')}
                    </div>
                    <div class="tool-ui-header-stats">
                        <span style="color:var(--green); font-weight:600;">+${lines.length}</span>
                        <span style="color:var(--dim);">${formatBytes(bytes)}</span>
                    </div>
                </div>
                ${body}
                <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                        <span>${statusText}</span>
                    </div>
                    <span style="opacity:0.6;">${lines.length} line${lines.length === 1 ? '' : 's'}</span>
                </div>
            </div>`;

        await api.showUI(displayHtml);
        return { output: `Written ${fp}`, summary: header };
    } catch (e) {
        return fail(api, fp, e.message);
    }
}