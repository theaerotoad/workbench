// read - tool definition.
const TOOL_META = {
    "name": "read",
    "description": "Read lines or full contents of a file. Supports a single start_line/end_line range or multiple ranges in one call via ranges: [[start, end], ...]. Overlapping or touching ranges are merged. If the requested lines exceed the configured limit, output is truncated at the limit, with a notice at the top listing the ranges not returned.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string"
            },
            "start_line": {
                "type": "integer"
            },
            "end_line": {
                "type": "integer"
            },
            "ranges": {
                "type": "array",
                "description": "Optional list of inclusive 1-based [start_line, end_line] ranges to read in one call (e.g. [[1, 30], [120, 160]]).",
                "items": {
                    "type": "array",
                    "items": {
                        "type": "integer"
                    }
                }
            }
        },
        "required": [
            "filepath"
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
            "key": "maxLines",
            "label": "Max Read Lines",
            "type": "number",
            "default": 500,
            "min": 1,
            "max": 100000,
            "description": "Largest number of lines returned in one read; longer requests are truncated with a notice."
        },
        {
            "key": "previewLines",
            "label": "Preview Lines",
            "type": "number",
            "default": 12,
            "min": 0,
            "max": 200,
            "description": "How many lines of the result are shown in the chat box (the model always receives the full result)."
        }
    ]
};

// --- Pure Range & Truncation Helpers -----------------------------------------

function countLines(txt) {
    if (!txt) return 0;
    const n = txt.split('\n').length;
    return txt.endsWith('\n') ? n - 1 : n;
}

function normalizeAndMergeRanges(args, totalLines) {
    const notes = [];
    if (args.ranges !== undefined && args.ranges !== null) {
        if (!Array.isArray(args.ranges) || args.ranges.length === 0) {
            return { error: 'ranges must be a non-empty array of [start_line, end_line] pairs.' };
        }
        const parsed = [];
        for (let i = 0; i < args.ranges.length; i++) {
            const r = args.ranges[i];
            if (!Array.isArray(r) || r.length < 1 || r.length > 2) {
                return { error: `Invalid range at index ${i}: expected [start_line, end_line].` };
            }
            const rawStart = Number(r[0]);
            const rawEnd = r.length === 2 && r[1] != null ? Number(r[1]) : rawStart;
            if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart < 1 || rawEnd < 1) {
                return { error: `Invalid range [${r.join(', ')}] at index ${i}: line numbers must be positive integers.` };
            }
            if (rawEnd < rawStart) {
                return { error: `Invalid range [${rawStart}, ${rawEnd}] at index ${i}: end_line must be >= start_line.` };
            }
            if (rawStart > totalLines) {
                notes.push(`range [${rawStart}, ${rawEnd}] starts past end of file (${totalLines} lines); skipped`);
                continue;
            }
            if (rawEnd > totalLines) {
                notes.push(`end_line ${rawEnd} exceeds file length (${totalLines} lines); returned through ${totalLines}`);
            }
            parsed.push([Math.max(1, rawStart), Math.min(totalLines, rawEnd)]);
        }

        if (parsed.length === 0) {
            return { merged: [], outOfBounds: true, notes };
        }

        parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [parsed[0]];
        for (let i = 1; i < parsed.length; i++) {
            const prev = merged[merged.length - 1];
            const cur = parsed[i];
            if (cur[0] <= prev[1] + 1) {
                prev[1] = Math.max(prev[1], cur[1]);
            } else {
                merged.push(cur);
            }
        }
        return { merged, outOfBounds: false, notes };
    }

    const s = Math.max(1, args.start_line || 1);
    const rawEnd = args.end_line || totalLines;
    const e = Math.min(totalLines, rawEnd);
    if (s > e) {
        return { merged: [], outOfBounds: s > totalLines, notes };
    }
    if (rawEnd > totalLines) {
        notes.push(`end_line ${rawEnd} exceeds file length (${totalLines} lines); returned through ${totalLines}`);
    }
    return { merged: [[s, e]], outOfBounds: false, notes };
}

// Output-size budget for numbered content. Kept below cleanupText's 100000-char total cap
// (which cuts mid-line with a notice at the END) so read always stops on a line boundary
// and reports it at the top. Per-line cost mirrors cleanupText's 2000-char line clip.
const MAX_CONTENT_CHARS = 90000;
const CLEANUP_MAX_LINE_CHARS = 2000;
const LINE_CLIP_SUFFIX_CHARS = 48;

function rowCost(n, text) {
    const len = text.length > CLEANUP_MAX_LINE_CHARS ? CLEANUP_MAX_LINE_CHARS + LINE_CLIP_SUFFIX_CHARS : text.length;
    return String(n).length + 3 + len + 1; // "N | " + text + "\n"
}

// Fills ranges in order until maxLines (or the output-size budget) is reached. Never samples:
// every returned section is a contiguous run of lines. Anything not returned is listed in notShown.
function collectSectionRows(lines, mergedRanges, maxLines, maxChars = MAX_CONTENT_CHARS) {
    const totalRequested = mergedRanges.reduce((a, [s, e]) => a + Math.max(0, e - s + 1), 0);
    let remaining = maxLines;
    let charsUsed = 0;
    let limitReason = null; // 'lines' | 'chars'
    const sections = [];
    const notShown = [];

    for (const [s, e] of mergedRanges) {
        if (e < s) continue;
        if (limitReason) {
            notShown.push([s, e]);
            continue;
        }
        const rows = [];
        let n = s;
        for (; n <= e; n++) {
            if (remaining === 0) { limitReason = 'lines'; break; }
            const text = lines[n - 1];
            const cost = rowCost(n, text);
            // Always return at least one line overall, even if it alone exceeds the budget.
            if (charsUsed > 0 && charsUsed + cost > maxChars) { limitReason = 'chars'; break; }
            rows.push({ n, text });
            charsUsed += cost;
            remaining--;
        }
        const cut = n <= e ? [n, e] : null;
        if (rows.length) sections.push({ start: s, end: n - 1, rows, cut });
        if (cut) notShown.push(cut);
    }

    const totalReturned = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
    const truncated = notShown.length > 0;
    return { sections, totalRequested, totalReturned, truncated, notShown, limitReason: truncated ? limitReason : null };
}

// Splits ranges into chunks of at most maxLines lines each (for continuation hints).
function chunkRanges(ranges, maxLines) {
    const chunks = [];
    for (const [s, e] of ranges) {
        for (let a = s; a <= e; a += maxLines) {
            chunks.push([a, Math.min(e, a + maxLines - 1)]);
        }
    }
    return chunks;
}

function formatRangeList(ranges) {
    return ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(', ');
}

function formatRangesLabel(mergedRanges) {
    if (!mergedRanges.length) return 'empty range';
    const parts = mergedRanges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`));
    return `lines ${parts.join(', ')}`;
}

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
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

async function fail(api, fp, msg) {
    await api.showUI(errorHtml(fp, 'Read Failed', msg));
    return { output: `ERROR: ${msg}` };
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = args.filepath;

    if (await api.isBinary(fp)) {
        if (/\.pdf$/i.test(fp)) {
            return fail(api, fp, `${fp} is a PDF file and cannot be read as plain text. Use view_pdf(filepath="${fp}") instead.`);
        }
        return fail(api, fp, `${fp} is a binary file and cannot be read as text.`);
    }

    const txt = await api.readFile(fp);
    if (txt === undefined) return fail(api, fp, `${fp} not found`);
    // The host reports blocked/protected paths by returning a one-line "ERROR: ..." string instead of content.
    if (typeof txt === 'string' && txt.length < 500 && /^ERROR: [^\n]*$/.test(txt)) {
        return fail(api, fp, txt.replace(/^ERROR:\s*/, ''));
    }

    // A trailing newline terminates the last line; it does not start a new empty one.
    const lines = txt.split('\n');
    if (txt.endsWith('\n')) lines.pop();
    const totalLines = countLines(txt);
    let maxLines = Number(await api.getSetting('maxLines'));
    if (!Number.isFinite(maxLines) || maxLines < 1) maxLines = 500;

    const rangeInfo = totalLines === 0
        ? { merged: [], outOfBounds: false, notes: [] }
        : normalizeAndMergeRanges(args, totalLines);
    if (rangeInfo.error) return fail(api, fp, rangeInfo.error);

    const { merged, outOfBounds, notes } = rangeInfo;
    const rangeLabel = formatRangesLabel(merged);
    const header = `${fp} (${rangeLabel})`;
    await api.setHeaderMsg(header);

    const { sections, totalRequested, totalReturned, truncated, notShown, limitReason } = collectSectionRows(lines, merged, maxLines);
    const totalReturnedRows = totalReturned;

    // Notices go at the top so they are seen before the content.
    const topNotices = notes.map(n => `[note: ${n}]`);
    if (truncated) {
        const chunks = chunkRanges(notShown, maxLines);
        const shownChunks = chunks.slice(0, 3).map(([a, b]) => `[${a},${b}]`).join(',');
        const more = chunks.length > 3 ? ',…' : '';
        const limitText = limitReason === 'chars'
            ? `output size limit of ~${Math.round(MAX_CONTENT_CHARS / 1000)}K characters reached because lines are long; line limit is ${maxLines}, so later chunks may also be cut by size`
            : `limit ${maxLines}`;
        topNotices.push(`[TRUNCATED: returned ${totalReturned} of ${totalRequested} requested lines (${limitText}). Not shown: lines ${formatRangeList(notShown)}. Continue with read(filepath="${fp}", ranges=[${shownChunks}${more}]).]`);
    }

    let output;
    if (totalLines === 0) {
        output = '(empty file)';
    } else if (sections.length === 0) {
        output = outOfBounds
            ? `(requested range starts past end of file; file has ${totalLines} lines)`
            : '(no lines in range)';
    } else {
        output = sections
            .map(sec => {
                let body = sec.rows.map(r => `${r.n} | ${r.text}`).join('\n');
                if (sec.cut) body += `\n[… lines ${sec.cut[0]}-${sec.cut[1]} not shown: ${limitReason === 'chars' ? 'output size limit' : 'read limit'} reached …]`;
                return body;
            })
            .join('\n…\n');
    }
    if (topNotices.length) output = `${topNotices.join('\n')}\n\n${output}`;

    // --- Display ---------------------------------------------------------------

    let previewLines = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLines) || previewLines < 0) previewLines = 12;

    let shownCount = 0;
    let rowsHtml = '';
    for (let si = 0; si < sections.length; si++) {
        if (shownCount >= previewLines) break;
        if (si > 0) {
            rowsHtml += `
                <div class="tool-ui-line-row" style="opacity:0.45;">
                    <div class="tool-ui-line-no">…</div>
                    <div class="tool-ui-line-content">…</div>
                </div>`;
        }
        for (const r of sections[si].rows) {
            if (shownCount >= previewLines) break;
            shownCount++;
            let t = String(r.text).replace(/\r$/, '');
            if (t.length > 300) t = t.slice(0, 300) + '…';
            rowsHtml += `
                <div class="tool-ui-line-row">
                    <div class="tool-ui-line-no">${r.n}</div>
                    <div class="tool-ui-line-content">${esc(t)}</div>
                </div>`;
        }
    }

    const hidden = totalReturnedRows - shownCount;
    const moreHtml = hidden > 0
        ? `<div class="tool-ui-more">… ${hidden} more line${hidden === 1 ? '' : 's'} (full result was sent to the model)</div>`
        : '';
    const emptyHtml = totalReturnedRows === 0
        ? `<div class="tool-ui-empty">${esc(totalLines === 0 ? '(empty file)' : (outOfBounds ? `(range starts past end; file has ${totalLines} lines)` : '(no lines in range)'))}</div>`
        : '';
    const body = (rowsHtml || emptyHtml)
        ? `<div class="tool-ui-box">${rowsHtml}${emptyHtml}${moreHtml}</div>`
        : '';

    const rangeBadge = merged.length === 0
        ? badge('empty', 'var(--dim)')
        : (merged.length === 1
            ? badge(`L${merged[0][0]}–L${merged[0][1]}`, 'var(--primary)')
            : badge(`${merged.length} ranges`, 'var(--primary)'));

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">description</span>
                    ${pathHtml(fp)}
                    ${rangeBadge}
                    ${truncated ? badge('truncated', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span>${totalReturnedRows} line${totalReturnedRows === 1 ? '' : 's'}</span>
                </div>
            </div>
            ${body}
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${truncated ? 'Partial read' : 'Read'} ${esc(rangeLabel)}</span>
                </div>
                <span style="opacity:0.6;">${totalLines} total lines</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output: api.cleanupText(output, { preserveTrailingWhitespace: true }), summary: header };
}