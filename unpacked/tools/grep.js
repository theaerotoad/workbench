// grep - tool definition.
const TOOL_META = {
    "name": "grep",
    "description": "Search for regex or text string across files with line numbers. Supports context lines, glob include filters, files-only summaries, and per-file match caps.",
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regex or plain text pattern to search for."
            },
            "path": {
                "type": "string",
                "description": "Optional subfolder or filename substring filter."
            },
            "include": {
                "type": "string",
                "description": "Optional glob filter for file paths (e.g. '*.py', 'src/**/*.ts', or comma-separated '*.js,*.ts')."
            },
            "case_sensitive": {
                "type": "boolean"
            },
            "context": {
                "type": "integer",
                "description": "Number of context lines to show before and after each match (default 0)."
            },
            "files_only": {
                "type": "boolean",
                "description": "If true, list only matching files with their hit counts."
            },
            "max_per_file": {
                "type": "integer",
                "description": "Optional maximum number of matches to return per file."
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

// --- Pure helpers ------------------------------------------------------------

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

function compileIncludeFilter(includeStr) {
    if (!includeStr || typeof includeStr !== 'string') return null;
    const parts = includeStr
        .split(',')
        .map(s => s.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, ''))
        .filter(Boolean);
    if (!parts.length) return null;
    const matchers = parts.map(part => {
        const hasSlash = part.includes('/');
        const re = globToRegex(part, hasSlash);
        return (fp) => {
            if (hasSlash) return re.test(fp);
            const base = fp.split('/').pop() || fp;
            return re.test(base);
        };
    });
    return (fp) => matchers.some(fn => fn(fp));
}

function buildContextHunks(totalLines, hitIndices, context) {
    if (!hitIndices.length) return [];
    const hunks = [];
    for (const idx of hitIndices) {
        const start = Math.max(0, idx - context);
        const end = Math.min(totalLines - 1, idx + context);
        const prev = hunks[hunks.length - 1];
        if (prev && start <= prev.end + 1) {
            prev.end = Math.max(prev.end, end);
            prev.hits.add(idx);
        } else {
            hunks.push({ start, end, hits: new Set([idx]) });
        }
    }
    return hunks;
}

function isErrorResult(txt) {
    return typeof txt !== 'string' || (txt.length < 500 && /^ERROR: [^\n]*$/.test(txt));
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

    const maxLines = Math.max(1, Number(await api.getSetting('maxMatches')) || 500);
    const contextLines = Number.isInteger(args.context) && args.context > 0 ? Math.min(args.context, 20) : 0;
    const filesOnly = args.files_only === true;
    const maxPerFile = Number.isInteger(args.max_per_file) && args.max_per_file > 0 ? args.max_per_file : Infinity;
    const pathFilter = args.path ? String(args.path).replace(/\\/g, '/') : '';
    const includeFilter = compileIncludeFilter(args.include);

    // Filter by path & include BEFORE checking binary to avoid sniffing irrelevant files.
    const allFiles = await api.listFiles();
    const candidates = allFiles.filter(fp => {
        if (pathFilter && !fp.includes(pathFilter)) return false;
        if (includeFilter && !includeFilter(fp)) return false;
        return true;
    });

    const scopeParts = [];
    if (pathFilter) scopeParts.push(pathFilter);
    if (args.include) scopeParts.push(args.include);
    const scope = scopeParts.length ? scopeParts.join(' · ') : 'all files';
    const header = `pattern "${args.pattern}" in ${scope}`;
    await api.setHeaderMsg(header);

    const matches = [];       // { fp, n, text } (used when !filesOnly && contextLines === 0)
    const fileGroups = [];    // { fp, count, capped, hunks: [{ start, end, hits, lines }] }
    const fileCounts = new Map();
    let totalMatches = 0;
    let truncated = false;
    let searched = 0;

    for (const fp of candidates) {
        if (await api.isBinary(fp)) continue;
        searched++;
        if (searched % 10 === 0) await api.setHeaderMsg(`${header} (${searched} files scanned)`);

        const txt = await api.readFile(fp);
        if (isErrorResult(txt)) continue;
        const lines = txt.split('\n');

        if (filesOnly) {
            let count = 0;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
                if (re.test(line)) count++;
            }
            if (count > 0) {
                if (fileGroups.length >= maxLines) {
                    truncated = true;
                    break;
                }
                fileGroups.push({ fp, count, capped: false, hunks: [] });
                fileCounts.set(fp, count);
                totalMatches += count;
            }
            continue;
        }

        const hitIndices = [];
        let capped = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
            if (re.test(line)) {
                if (totalMatches >= maxLines) {
                    truncated = true;
                    break;
                }
                if (hitIndices.length >= maxPerFile) {
                    capped = true;
                    break;
                }
                hitIndices.push(i);
                totalMatches++;
                matches.push({ fp, n: i + 1, text: line.trim() });
            }
        }

        if (hitIndices.length > 0) {
            fileCounts.set(fp, hitIndices.length);
            if (contextLines > 0) {
                const hunks = buildContextHunks(lines.length, hitIndices, contextLines).map(h => {
                    const hunkLines = [];
                    for (let idx = h.start; idx <= h.end; idx++) {
                        const raw = lines[idx].endsWith('\r') ? lines[idx].slice(0, -1) : lines[idx];
                        hunkLines.push({ n: idx + 1, text: raw, isMatch: h.hits.has(idx) });
                    }
                    return { lines: hunkLines };
                });
                fileGroups.push({ fp, count: hitIndices.length, capped, hunks });
            } else {
                fileGroups.push({ fp, count: hitIndices.length, capped, hunks: [] });
            }
        }

        if (truncated) break;
    }

    // --- Format output for model ----------------------------------------------

    let rawOutput;
    if (filesOnly) {
        rawOutput = fileGroups.length
            ? fileGroups.map(g => `${g.fp}  (${g.count} match${g.count === 1 ? '' : 'es'})`).join('\n')
            : "(no matches)";
    } else if (contextLines > 0) {
        if (!fileGroups.length) {
            rawOutput = "(no matches)";
        } else {
            const sections = fileGroups.map(g => {
                const headerLine = g.capped ? `${g.fp}  (capped at ${maxPerFile} matches)` : g.fp;
                const hunkStrs = g.hunks.map(h =>
                    h.lines.map(l => `${l.n}${l.isMatch ? ':' : '-'} ${l.text}`).join('\n')
                );
                return headerLine + '\n' + hunkStrs.join('\n--\n');
            });
            rawOutput = sections.join('\n\n');
        }
    } else {
        if (!matches.length) {
            rawOutput = "(no matches)";
        } else {
            const cappedFiles = fileGroups.filter(g => g.capped);
            rawOutput = matches.map(m => `${m.fp}:${m.n}: ${m.text}`).join('\n');
            if (cappedFiles.length > 0) {
                rawOutput += `\n\n[capped at ${maxPerFile} matches/file in ${cappedFiles.length} file${cappedFiles.length === 1 ? '' : 's'}: ${cappedFiles.map(g => g.fp).slice(0, 10).join(', ')}${cappedFiles.length > 10 ? '…' : ''}]`;
            }
        }
    }

    const truncNote = truncated
        ? (filesOnly
            ? `\n\n[truncated: showing first ${maxLines} matching files]`
            : `\n\n[truncated: showing ${maxLines} of many matches]`)
        : '';
    const output = api.cleanupText(rawOutput) + truncNote;
    const summary = filesOnly
        ? `Grep: ${fileGroups.length} file(s) (${totalMatches} matches)${truncated ? ` (truncated)` : ''}`
        : `Grep: ${totalMatches} match(es) in ${fileCounts.size} file(s)${truncated ? ` (truncated at ${maxLines})` : ''}`;

    // --- Display ---------------------------------------------------------------

    let previewLimit = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLimit) || previewLimit < 0) previewLimit = 30;

    let rowsHtml = '';
    if (filesOnly) {
        const shown = fileGroups.slice(0, previewLimit);
        const hidden = fileGroups.length - shown.length;
        rowsHtml = shown.map(g => `
            <div class="tool-ui-row">
                <div class="tool-ui-path">${pathHtml(g.fp)}</div>
                <span style="color:var(--dim); font-size:10px; flex-shrink:0; margin-left:8px;">${g.count} match${g.count === 1 ? '' : 'es'}</span>
            </div>`).join('');
        if (hidden > 0) {
            rowsHtml += `<div class="tool-ui-more">… ${hidden} more file${hidden === 1 ? '' : 's'} (full list was sent to the model)</div>`;
        }
        if (!fileGroups.length) {
            rowsHtml = `<div class="tool-ui-empty">(no matches)</div>`;
        }
    } else if (contextLines > 0) {
        let shownRows = 0;
        let totalRows = 0;
        for (const g of fileGroups) {
            for (const h of g.hunks) totalRows += h.lines.length;
        }
        for (const g of fileGroups) {
            if (shownRows >= previewLimit) break;
            rowsHtml += `
                <div class="tool-ui-row">
                    <div class="tool-ui-path">${pathHtml(g.fp)}</div>
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0; margin-left:8px;">${g.count}${g.capped ? '+' : ''}</span>
                </div>`;
            for (let hi = 0; hi < g.hunks.length && shownRows < previewLimit; hi++) {
                if (hi > 0) {
                    rowsHtml += `<div class="tool-ui-line-row" style="opacity:0.45;"><div class="tool-ui-line-no">…</div><div class="tool-ui-line-content">--</div></div>`;
                }
                for (const l of g.hunks[hi].lines) {
                    if (shownRows >= previewLimit) break;
                    shownRows++;
                    const style = l.isMatch ? '' : ' style="opacity:0.55;"';
                    const content = l.isMatch ? highlight(l.text, re) : esc(l.text.length > 200 ? l.text.slice(0, 200) + '…' : l.text);
                    rowsHtml += `
                        <div class="tool-ui-line-row"${style}>
                            <div class="tool-ui-line-no">${l.n}</div>
                            <div class="tool-ui-line-content">${content}</div>
                        </div>`;
                }
            }
        }
        const hidden = totalRows - shownRows;
        if (hidden > 0) {
            rowsHtml += `<div class="tool-ui-more">… ${hidden} more line${hidden === 1 ? '' : 's'} (full result was sent to the model)</div>`;
        }
        if (!fileGroups.length) {
            rowsHtml = `<div class="tool-ui-empty">(no matches)</div>`;
        }
    } else {
        const shown = matches.slice(0, previewLimit);
        const hidden = matches.length - shown.length;
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
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">search</span>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); font-weight:600;">${esc(args.pattern)}</div>
                    ${badge(scope, 'var(--primary)')}
                    ${args.case_sensitive ? badge('Aa', 'var(--dim)') : ''}
                    ${contextLines > 0 ? badge(`-C ${contextLines}`, 'var(--dim)') : ''}
                    ${filesOnly ? badge('files only', 'var(--dim)') : ''}
                    ${truncated ? badge('truncated', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:${totalMatches ? 'var(--green)' : 'var(--dim)'}; font-weight:600;">${totalMatches} match${totalMatches === 1 ? '' : 'es'}</span>
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