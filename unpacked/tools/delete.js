// delete - tool definition.
const TOOL_META = {
    "name": "delete",
    "description": "Delete a file from the workspace, or delete a directory when recursive: true is passed. Deletions are recorded in session checkpoints so they can be reverted. Refuses directories unless recursive: true is explicitly set.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Workspace-relative path of the file or directory to delete"
            },
            "recursive": {
                "type": "boolean",
                "description": "Set to true to delete a directory and all of its contents (default: false)"
            }
        },
        "required": [
            "filepath"
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

function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function errorHtml(fp, msg) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    ${badge('Delete Failed', 'var(--red)')}
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
    const rawFp = String(args.filepath || '').trim().replace(/\\/g, '/');
    const normFp = rawFp.replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
    const recursive = args.recursive === true;
    const displayPath = normFp || rawFp;

    const header = recursive ? `${displayPath} (recursive)` : displayPath;
    await api.setHeaderMsg(header);

    if (!normFp) {
        const msg = 'Invalid filepath.';
        await api.showUI(errorHtml(displayPath || '(empty)', msg));
        return { output: `ERROR: ${msg}`, summary: header };
    }

    // Gather lightweight pre-delete info for the result card/summary.
    let fileStat = null;
    let dirFiles = [];
    let isDir = false;
    try {
        fileStat = await api.statFile(normFp);
        if (!fileStat && recursive) {
            const allFiles = await api.listFiles();
            const prefix = normFp + '/';
            if (Array.isArray(allFiles)) {
                dirFiles = allFiles.filter(f => f.startsWith(prefix));
            }
            isDir = true;
        }
    } catch (_) {}

    try {
        const err = await api.deleteFile(normFp, { recursive });
        if (err) {
            const msg = String(err).replace(/^ERROR:\s*/, '');
            await api.showUI(errorHtml(normFp, msg));
            return { output: `ERROR: ${msg}`, summary: header };
        }
    } catch (e) {
        await api.showUI(errorHtml(normFp, e.message));
        return { output: `ERROR: ${e.message}`, summary: header };
    }

    const row = (path) => `
        <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--red) 12%, transparent); color:var(--red);">
            <div style="width:20px; text-align:center; user-select:none; font-weight:700; opacity:0.8; flex-shrink:0;">-</div>
            <div class="tool-ui-line-content" style="color:inherit;">${esc(path)}</div>
        </div>`;

    const MAX_PREVIEW_ROWS = 20;
    let rowsHtml = '';
    if (isDir && dirFiles.length > 0) {
        rowsHtml = dirFiles.slice(0, MAX_PREVIEW_ROWS).map(row).join('');
        if (dirFiles.length > MAX_PREVIEW_ROWS) {
            rowsHtml += `<div class="tool-ui-more">… and ${dirFiles.length - MAX_PREVIEW_ROWS} more file${dirFiles.length - MAX_PREVIEW_ROWS === 1 ? '' : 's'}</div>`;
        }
    } else {
        rowsHtml = row(isDir ? `${normFp}/` : normFp);
    }

    const sizeStr = fileStat && typeof fileStat.size === 'number' ? formatBytes(fileStat.size) : '';
    const statsHtml = isDir
        ? `${badge(`${dirFiles.length} file${dirFiles.length === 1 ? '' : 's'}`, 'var(--dim)')}${badge('DELETED', 'var(--red)')}`
        : `${sizeStr ? badge(sizeStr, 'var(--dim)') : ''}${badge('DELETED', 'var(--red)')}`;

    const footerText = isDir
        ? `Directory deleted (${dirFiles.length} file${dirFiles.length === 1 ? '' : 's'})`
        : 'File deleted';

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">${isDir ? 'folder_delete' : 'delete'}</span>
                    ${pathHtml(isDir ? `${normFp}/` : normFp)}
                </div>
                <div class="tool-ui-header-stats">
                    ${statsHtml}
                </div>
            </div>
            <div class="tool-ui-box">
                ${rowsHtml}
            </div>
            <div style="display:flex; align-items:center; gap:4px; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                <span>${esc(footerText)}</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);

    const output = isDir
        ? `Deleted directory ${normFp} (${dirFiles.length} file${dirFiles.length === 1 ? '' : 's'})`
        : `Deleted ${normFp}`;
    return { output, summary: header };
}