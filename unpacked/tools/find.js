// find - tool definition.
const TOOL_META = {
    "name": "find",
    "description": "Find files by filename/path pattern or extension (e.g. *.html, demo.rs, src/*.py). Patterns with a '/' match that folder at any depth unless they start with '/', which anchors to the workspace root. Shows file sizes and line counts for text files.",
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Glob or substring. '*.py' matches file names anywhere; 'src/*.py' matches that folder at any depth; '/src/*.py' anchors to the workspace root; no wildcard = case-insensitive substring of the path."
            },
            "path": {
                "type": "string",
                "description": "Optional workspace-relative directory prefix to restrict the search (e.g. src/utils)."
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
        },
        {
            "key": "maxStat",
            "label": "Max Stat Entries",
            "type": "number",
            "default": 200,
            "min": 0,
            "max": 5000,
            "description": "Maximum number of matched files to stat and count lines for; extra matches list the path only."
        },
        {
            "key": "lineCountMaxBytes",
            "label": "Line Count Size Cap (bytes)",
            "type": "number",
            "default": 2097152,
            "min": 0,
            "max": 52428800,
            "description": "Maximum text file size in bytes for counting lines (default 2 MB)."
        }
    ]
};

// --- Pure helpers ------------------------------------------------------------

const READ_LIMIT_DEFAULT = 500;

function countLines(txt) {
    if (!txt) return 0;
    const n = txt.split('\n').length;
    return txt.endsWith('\n') ? n - 1 : n;
}

function normalizePathPrefix(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
}

function globToRegex(glob, pathScoped) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += pathScoped ? '[^/]*' : '.*';
            }
        } else if (ch === '?') {
            re += pathScoped ? '[^/]' : '.';
        } else {
            re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    re += '$';
    return new RegExp(re, 'i');
}

function compileFindPattern(rawPattern) {
    const normalized = String(rawPattern || '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    const anchored = normalized.startsWith('/');
    const clean = normalized.replace(/^\/+/, '');
    if (!clean || clean === '*' || clean === '**' || clean === '**/*') {
        return () => true;
    }
    const hasWildcard = /[*?]/.test(clean);
    const hasSlash = clean.includes('/');
    if (hasWildcard) {
        // Unanchored slash patterns match that folder at any depth ('**/' becomes '(?:.*/)?').
        // A leading '/' anchors the pattern to the workspace root (or to path= when given).
        const source = hasSlash && !anchored && !clean.startsWith('**/') ? '**/' + clean : clean;
        const re = globToRegex(source, hasSlash);
        return (fp, relPath) => {
            if (hasSlash) return anchored ? re.test(relPath) : (re.test(relPath) || re.test(fp));
            const base = fp.split('/').pop() || fp;
            return re.test(base);
        };
    }
    const needle = clean.toLowerCase();
    return (fp, relPath) => relPath.toLowerCase().includes(needle) || fp.toLowerCase().includes(needle);
}

function formatSize(bytes) {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) {
        const num = kb >= 100 ? Math.round(kb) : parseFloat(kb.toFixed(1));
        return `${num} KB`;
    }
    const mb = kb / 1024;
    if (mb < 1024) {
        const num = mb >= 100 ? Math.round(mb) : parseFloat(mb.toFixed(1));
        return `${num} MB`;
    }
    const gb = mb / 1024;
    return `${parseFloat(gb.toFixed(1))} GB`;
}

function formatMetaSummary(entry, readLimit = READ_LIMIT_DEFAULT, lineCountMaxBytes = null) {
    if (!entry.statted) return '';
    const sizeStr = formatSize(entry.size);
    if (entry.isBinary) {
        return sizeStr ? `binary, ${sizeStr}` : 'binary';
    }
    if (entry.lineCount !== null) {
        const lineStr = `${entry.lineCount.toLocaleString('en-US')} line${entry.lineCount === 1 ? '' : 's'}`;
        const parts = sizeStr ? `${lineStr}, ${sizeStr}` : lineStr;
        if (entry.lineCount > readLimit) {
            return `${parts} — read returns ≤${readLimit} lines per call`;
        }
        return parts;
    }
    if (entry.lineCountSkipped) {
        const capStr = lineCountMaxBytes != null ? formatSize(lineCountMaxBytes) : 'size cap';
        return sizeStr ? `${sizeStr}, line count skipped (>${capStr})` : `line count skipped (>${capStr})`;
    }
    return sizeStr;
}

function formatFindLine(entry, readLimit, lineCountMaxBytes) {
    const meta = formatMetaSummary(entry, readLimit, lineCountMaxBytes);
    return meta ? `${entry.fp}  (${meta})` : entry.fp;
}

function isErrorResult(txt) {
    return typeof txt !== 'string' || (txt.length < 500 && /^ERROR: [^\n]*$/.test(txt));
}

// --- UI helpers (display only, never sent to the model) ----------------------

function esc(s) {
//    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const prefix = normalizePathPrefix(args.path);
    const matcher = compileFindPattern(args.pattern);
    const allFiles = await api.listFiles();

    const scopedFiles = prefix
        ? allFiles.filter(f => f === prefix || f.startsWith(prefix + '/'))
        : allFiles;

    const matches = scopedFiles.filter(f => {
        const rel = prefix && f.startsWith(prefix + '/') ? f.slice(prefix.length + 1) : f;
        return matcher(f, rel);
    });

    let maxStat = Number(await api.getSetting('maxStat'));
    if (!Number.isFinite(maxStat) || maxStat < 0) maxStat = 200;

    let lineCountMaxBytes = Number(await api.getSetting('lineCountMaxBytes'));
    if (!Number.isFinite(lineCountMaxBytes) || lineCountMaxBytes < 0) lineCountMaxBytes = 2097152;

    const scopeLabel = prefix ? `${args.pattern} in ${prefix}` : args.pattern;
    await api.setHeaderMsg(`Finding "${scopeLabel}" (${matches.length} matched)`);

    const canStat = typeof api.statFile === 'function';
    const entries = matches.map(fp => ({
        fp,
        statted: false,
        size: null,
        isBinary: false,
        lineCount: null,
        lineCountSkipped: false
    }));

    let readLimit = READ_LIMIT_DEFAULT;
    if (typeof api.getToolSetting === 'function') {
        try {
            const v = Number(await api.getToolSetting('read', 'maxLines'));
            if (Number.isFinite(v) && v >= 1) readLimit = v;
        } catch (e) { /* older host without getToolSetting: keep default */ }
    }

    const statCount = Math.min(entries.length, maxStat);
    const BATCH = 24;
    for (let i = 0; i < statCount; i += BATCH) {
        const slice = entries.slice(i, Math.min(i + BATCH, statCount));
        await Promise.all(slice.map(async (entry) => {
            const st = canStat ? await api.statFile(entry.fp) : null;
            if (!st) return;
            entry.statted = true;
            entry.size = typeof st.size === 'number' ? st.size : null;
            entry.isBinary = !!st.isBinary;
            if (!entry.isBinary && entry.size !== null && entry.size > lineCountMaxBytes) {
                entry.lineCountSkipped = true;
            }
            if (!entry.isBinary && entry.size !== null && entry.size <= lineCountMaxBytes) {
                const bin = await api.isBinary(entry.fp);
                if (bin) {
                    entry.isBinary = true;
                    return;
                }
                const txt = await api.readFile(entry.fp);
                if (!isErrorResult(txt)) {
                    entry.lineCount = countLines(txt);
                }
            }
        }));
    }

    const summary = prefix
        ? `"${args.pattern}" in ${prefix}: ${matches.length} file(s)`
        : `"${args.pattern}": ${matches.length} file(s)`;
    let output;
    if (entries.length) {
        output = entries.map(e => formatFindLine(e, readLimit, lineCountMaxBytes)).join('\n');
        if (entries.length > maxStat) {
            output = `[sizes/line counts shown for the first ${maxStat} of ${entries.length} files; narrow with path= or a more specific pattern]\n\n${output}`;
        }
    } else {
        const pat = String(args.pattern || '');
        output = pat.includes('/') || pat.includes('\\')
            ? `(no files matched; "dir/*.ext" matches that folder at any depth, a leading "/" anchors to the workspace root)`
            : `(no files matched "${pat}")`;
    }

    // --- Display ---------------------------------------------------------------

    let previewLimit = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLimit) || previewLimit < 0) previewLimit = 30;
    const shown = entries.slice(0, previewLimit);
    const hidden = entries.length - shown.length;

    let rowsHtml = shown.map(entry => {
        const meta = formatMetaSummary(entry, readLimit, lineCountMaxBytes);
        const exceedsReadLimit = entry.lineCount !== null && entry.lineCount > readLimit;
        return `
        <div class="tool-ui-line-row" style="align-items:center; justify-content:space-between; padding:0 8px; gap:8px;">
            <div style="display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden;">
                <span class="icon" style="font-size:12px; color:var(--dim); flex-shrink:0;">${entry.isBinary ? 'deployed_code' : 'draft'}</span>
                <div class="tool-ui-path">${pathHtml(entry.fp)}</div>
            </div>
            ${meta ? `<span style="color:${exceedsReadLimit ? 'var(--yellow)' : 'var(--dim)'}; font-size:10px; white-space:nowrap; flex-shrink:0;">${esc(meta)}</span>` : ''}
        </div>`;
    }).join('');
    if (hidden > 0) {
        rowsHtml += `<div class="tool-ui-more">… ${hidden} more file${hidden === 1 ? '' : 's'} (full list was sent to the model)</div>`;
    }
    if (!entries.length) {
        rowsHtml = `<div class="tool-ui-empty">(no files matched)</div>`;
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">find_in_page</span>
                    <div class="tool-ui-path" style="color:var(--fg); font-weight:600;">${esc(args.pattern)}</div>
                    ${prefix ? badge(prefix, 'var(--primary)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:${matches.length ? 'var(--green)' : 'var(--dim)'}; font-weight:600;">${matches.length} file${matches.length === 1 ? '' : 's'}</span>
                </div>
            </div>
            <div class="tool-ui-box">${rowsHtml}</div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>Matched against ${scopedFiles.length} file${scopedFiles.length === 1 ? '' : 's'}${entries.length > maxStat ? ` (stats for first ${maxStat})` : ''}</span>
                </div>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output, summary };
}
