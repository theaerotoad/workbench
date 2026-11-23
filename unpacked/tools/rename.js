// rename - tool definition.
const TOOL_META = {
    "name": "rename",
    "description": "Rename a file or move it to a different directory. Pass a bare filename for new_name to rename in place, or a workspace-relative path containing '/' (e.g. 'src/utils/foo.js', or './foo.js' to move to workspace root) to move across folders; missing parent directories are created automatically.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "The current workspace-relative file path to rename or move"
            },
            "new_name": {
                "type": "string",
                "description": "New filename (keeps current directory) or workspace-relative destination path containing '/' (moves file and creates missing parent folders; use './name' to move to workspace root)"
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

function resolveTarget(fp, newName) {
    const normFp = String(fp || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const rawNew = String(newName || '').trim().replace(/\\/g, '/');
    const oldDir = normFp.includes('/') ? normFp.slice(0, normFp.lastIndexOf('/')) : '';
    const newPath = rawNew.includes('/')
        ? rawNew.replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
        : (oldDir ? `${oldDir}/${rawNew}` : rawNew);
    const newDir = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '';
    return {
        normFp,
        newPath,
        isMove: oldDir !== newDir,
        unchanged: normFp === newPath
    };
}

function errorHtml(fp, target, msg, isMove) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    <span class="icon" style="font-size:12px; color:var(--dim); flex-shrink:0;">arrow_forward</span>
                    ${isMove ? pathHtml(target) : `<span class="tool-ui-path" style="color:var(--dim);">${esc(target)}</span>`}
                    ${badge(isMove ? 'Move Failed' : 'Rename Failed', 'var(--red)')}
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
    const { normFp, newPath, isMove, unchanged } = resolveTarget(fp, newName);

    const displayTarget = isMove ? (newPath || newName) : newName;
    const header = `${normFp || fp} → ${displayTarget}`;
    await api.setHeaderMsg(header);

    try {
        const err = await api.renameFile(fp, newName);
        if (err) {
            const msg = String(err).replace(/^ERROR:\s*/, '');
            await api.showUI(errorHtml(normFp || fp, displayTarget, msg, isMove));
            return { output: `ERROR: ${msg}`, summary: header };
        }
    } catch (e) {
        await api.showUI(errorHtml(normFp || fp, displayTarget, e.message, isMove));
        return { output: `ERROR: ${e.message}`, summary: header };
    }

    const row = (sign, colorVar, path) => `
        <div class="tool-ui-line-row" style="background:color-mix(in srgb, ${colorVar} 12%, transparent); color:${colorVar};">
            <div style="width:20px; text-align:center; user-select:none; font-weight:700; opacity:0.8; flex-shrink:0;">${sign}</div>
            <div class="tool-ui-line-content" style="color:inherit;">${esc(path)}</div>
        </div>`;

    const actionIcon = isMove ? 'drive_file_move' : 'drive_file_rename_outline';
    const badgeLabel = unchanged ? 'UNCHANGED' : (isMove ? 'MOVED' : 'RENAMED');
    const badgeColor = unchanged ? 'var(--dim)' : 'var(--green)';
    const footerText = unchanged
        ? 'Source and target paths are identical'
        : (isMove ? 'File moved' : 'File renamed');
    const targetHeaderHtml = isMove
        ? pathHtml(newPath)
        : `<div class="tool-ui-path" style="color:var(--fg); font-weight:600;">${esc(newName)}</div>`;

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">${actionIcon}</span>
                    ${pathHtml(normFp)}
                    <span class="icon" style="font-size:12px; color:var(--dim); flex-shrink:0;">arrow_forward</span>
                    ${targetHeaderHtml}
                </div>
                <div class="tool-ui-header-stats">
                    ${badge(badgeLabel, badgeColor)}
                </div>
            </div>
            <div class="tool-ui-box">
                ${row('-', 'var(--red)', normFp)}
                ${row('+', 'var(--green)', newPath)}
            </div>
            <div style="display:flex; align-items:center; gap:4px; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <span class="icon" style="font-size:12px; color:${badgeColor};">check_circle</span>
                <span>${esc(footerText)}</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    const output = unchanged
        ? `No change: ${normFp} is already at ${newPath}`
        : `${isMove ? 'Moved' : 'Renamed'} ${normFp} to ${newPath}`;
    return { output, summary: header };
}