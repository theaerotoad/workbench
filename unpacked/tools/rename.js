// rename - tool definition.
const TOOL_META = {
    "name": "rename",
    "description": "Rename a file to a new filename.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "The current file path to rename"
            },
            "new_name": {
                "type": "string",
                "description": "The new filename"
            }
        },
        "required": [
            "filepath",
            "new_name"
        ]
    },
    "modes": [
        "code"
    ],
    "permission": "ask",
    "toolBox": 1
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

function errorHtml(fp, newName, msg) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    <span class="icon" style="font-size:12px; color:var(--dim); flex-shrink:0;">arrow_forward</span>
                    <span class="tool-ui-path" style="color:var(--dim);">${esc(newName)}</span>
                    ${badge('Rename Failed', 'var(--red)')}
                </div>
                <span style="color:var(--dim); font-size:10px;">no changes applied</span>
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = args.filepath;
    const newName = args.new_name;

    const header = `${fp} → ${newName}`;
    await api.setHeaderMsg(header);

    try {
        const err = await api.renameFile(fp, newName);
        if (err) {
            const msg = String(err).replace(/^ERROR:\s*/, '');
            await api.showUI(errorHtml(fp, newName, msg));
            return { output: `ERROR: ${msg}`, summary: header };
        }
    } catch (e) {
        await api.showUI(errorHtml(fp, newName, e.message));
        return { output: `ERROR: ${e.message}`, summary: header };
    }

    // The host keeps a renamed file in its original directory, so that is the path shown as the result.
    const dir = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/') + 1) : '';
    const newPath = newName.includes('/') ? newName : dir + newName;

    const row = (sign, colorVar, path) => `
        <div class="tool-ui-line-row" style="background:color-mix(in srgb, ${colorVar} 12%, transparent); color:${colorVar};">
            <div style="width:20px; text-align:center; user-select:none; font-weight:700; opacity:0.8; flex-shrink:0;">${sign}</div>
            <div class="tool-ui-line-content" style="color:inherit;">${esc(path)}</div>
        </div>`;

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">drive_file_rename_outline</span>
                    ${pathHtml(fp)}
                    <span class="icon" style="font-size:12px; color:var(--dim); flex-shrink:0;">arrow_forward</span>
                    <div class="tool-ui-path" style="color:var(--fg); font-weight:600;">${esc(newName)}</div>
                </div>
                <div class="tool-ui-header-stats">
                    ${badge('RENAMED', 'var(--green)')}
                </div>
            </div>
            <div class="tool-ui-box">
                ${row('-', 'var(--red)', fp)}
                ${row('+', 'var(--green)', newPath)}
            </div>
            <div style="display:flex; align-items:center; gap:4px; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                <span>File renamed</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output: `Renamed ${fp} to ${newName}`, summary: header };
}