// read - tool definition.
const TOOL_META = {
    "name": "read",
    "description": "Read lines or full contents of a file. Supports a single start_line/end_line range or multiple ranges in one call via ranges: [[start, end], ...]. Overlapping or touching ranges are merged. If the total requested lines exceed the configured limit, content is evenly sampled instead of truncated.",
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
            "description": "Largest number of lines returned in one read; larger ranges are evenly sampled."
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

// --- Pure Range & Sampling Helpers -------------------------------------------

function normalizeAndMergeRanges(args, totalLines) {
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
            if (rawStart > totalLines) continue;
            parsed.push([Math.max(1, rawStart), Math.min(totalLines, rawEnd)]);
        }

        if (parsed.length === 0) {
            return { merged: [], outOfBounds: true };
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
        return { merged, outOfBounds: false };
    }

    const s = Math.max(1, args.start_line || 1);
    const e = Math.min(totalLines, args.end_line || totalLines);
    if (s > e) {
        return { merged: [], outOfBounds: s > totalLines };
    }
    return { merged: [[s, e]], outOfBounds: false };
}

function allocateBudgets(lengths, budget) {
    const total = lengths.reduce((a, b) => a + b, 0);
    if (total <= budget) return lengths.slice();

    const n = lengths.length;
    if (budget <= 0) return lengths.map(() => 0);
    if (budget < n) {
        const out = lengths.map(() => 0);
        for (let i = 0; i < budget; i++) out[i] = 1;
        return out;
    }

    const exact = lengths.map(len => (len / total) * budget);
    const alloc = exact.map((val, i) => Math.min(lengths[i], Math.max(1, Math.floor(val))));
    let used = alloc.reduce((a, b) => a + b, 0);

    while (used > budget) {
        let bestIdx = -1;
        for (let i = 0; i < n; i++) {
            if (alloc[i] > 1 && (bestIdx === -1 || alloc[i] > alloc[bestIdx])) bestIdx = i;
        }
        if (bestIdx === -1) break;
        alloc[bestIdx]--;
        used--;
    }

    if (used < budget) {
        const order = lengths
            .map((len, i) => ({ i, rem: exact[i] - Math.floor(exact[i]) }))
            .sort((a, b) => b.rem - a.rem);
        let guard = 0;
        while (used < budget && guard < budget * 2) {
            let progressed = false;
            for (const item of order) {
                if (used >= budget) break;
                if (alloc[item.i] < lengths[item.i]) {
                    alloc[item.i]++;
                    used++;
                    progressed = true;
                }
            }
            if (!progressed) break;
            guard++;
        }
    }

    return alloc;
}

function collectSectionRows(lines, mergedRanges, maxLines) {
    const lengths = mergedRanges.map(([s, e]) => Math.max(0, e - s + 1));
    const totalRequested = lengths.reduce((a, b) => a + b, 0);
    const sampled = totalRequested > maxLines;
    const budgets = sampled ? allocateBudgets(lengths, maxLines) : lengths;

    const sections = [];
    for (let idx = 0; idx < mergedRanges.length; idx++) {
        const [s, e] = mergedRanges[idx];
        const count = lengths[idx];
        const budget = budgets[idx];
        if (budget <= 0 || count <= 0) continue;

        let rows = [];
        if (count <= budget) {
            rows = lines.slice(s - 1, e).map((l, i) => ({ n: s + i, text: l }));
        } else if (budget === 1) {
            rows.push({ n: s, text: lines[s - 1] });
        } else {
            const rangeLines = lines.slice(s - 1, e);
            const step = (rangeLines.length - 1) / (budget - 1);
            for (let i = 0; i < budget; i++) {
                const pick = Math.round(i * step);
                rows.push({ n: s + pick, text: rangeLines[pick] });
            }
        }
        sections.push({ start: s, end: e, rows });
    }

    return { sections, totalRequested, sampled };
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

    if (await api.isBinary(fp)) return fail(api, fp, `${fp} is a binary file and cannot be read as text.`);

    const txt = await api.readFile(fp);
    if (txt === undefined) return fail(api, fp, `${fp} not found`);
    // The host reports blocked/protected paths by returning a one-line "ERROR: ..." string instead of content.
    if (typeof txt === 'string' && txt.length < 500 && /^ERROR: [^\n]*$/.test(txt)) {
        return fail(api, fp, txt.replace(/^ERROR:\s*/, ''));
    }

    const lines = txt.split('\n');
    const totalLines = lines.length;
    let maxLines = Number(await api.getSetting('maxLines'));
    if (!Number.isFinite(maxLines) || maxLines < 1) maxLines = 500;

    const rangeInfo = normalizeAndMergeRanges(args, totalLines);
    if (rangeInfo.error) return fail(api, fp, rangeInfo.error);

    const { merged, outOfBounds } = rangeInfo;
    const rangeLabel = formatRangesLabel(merged);
    const header = `${fp} (${rangeLabel})`;
    await api.setHeaderMsg(header);

    const { sections, totalRequested, sampled } = collectSectionRows(lines, merged, maxLines);
    const totalReturnedRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);

    let output;
    if (sections.length === 0) {
        output = outOfBounds
            ? `(requested range exceeds file length of ${totalLines} lines)`
            : '(no lines in range)';
    } else {
        output = sections
            .map(sec => sec.rows.map(r => `${r.n} | ${r.text}`).join('\n'))
            .join('\n…\n');
        if (sampled) {
            output += `\n\n..\n[WARNING: Compact read used because the requested ${totalRequested} lines exceed the Read Lines limit of ${maxLines}. Content above is sampled across the requested range${merged.length > 1 ? 's' : ''}. For non-compact/full content, request ${maxLines} lines or fewer.]`;
        }
    }

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
        ? `<div class="tool-ui-empty">${esc(outOfBounds ? `(range exceeds ${totalLines} lines)` : '(no lines in range)')}</div>`
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
                    ${sampled ? badge('sampled', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span>${totalReturnedRows} line${totalReturnedRows === 1 ? '' : 's'}</span>
                </div>
            </div>
            ${body}
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${sampled ? 'Sampled read' : 'Read'} ${esc(rangeLabel)}</span>
                </div>
                <span style="opacity:0.6;">${totalLines} total lines</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output: api.cleanupText(output), summary: header };
}