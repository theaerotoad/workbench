// read - tool definition.
const TOOL_META = {
    "name": "read",
    "description": "Read lines or full contents of a file. If the requested range is larger than the configured line limit, the content is evenly sampled across the range instead of truncated.",
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
    const s = Math.max(1, args.start_line || 1);
    const maxLines = await api.getSetting('maxLines');
    const requestedEnd = Math.min(totalLines, args.end_line || totalLines);
    const requestedLineCount = Math.max(0, requestedEnd - s + 1);

    const range = `lines ${s}-${requestedEnd}`;
    const header = `${fp} (${range})`;
    await api.setHeaderMsg(header);

    // Collect the rows that are returned to the model: [{ n, text }]
    let rows = [];
    let sampled = false;
    if (requestedLineCount <= maxLines) {
        rows = lines.slice(s - 1, requestedEnd).map((l, i) => ({ n: s + i, text: l }));
    } else {
        sampled = true;
        const rangeLines = lines.slice(s - 1, requestedEnd);
        if (maxLines <= 1) {
            rows.push({ n: s, text: rangeLines[0] });
        } else {
            const step = (rangeLines.length - 1) / (maxLines - 1);
            for (let i = 0; i < maxLines; i++) {
                const index = Math.round(i * step);
                rows.push({ n: s + index, text: rangeLines[index] });
            }
        }
    }

    let output = rows.map(r => `${r.n} | ${r.text}`).join('\n');
    if (sampled) {
        output += `\n\n..\n[WARNING: Compact read used because the requested ${requestedLineCount} lines exceed the Read Lines limit of ${maxLines}. Content above is sampled across the requested range. For non-compact/full content, request a range of ${maxLines} lines or fewer.]`;
    }

    // --- Display ---------------------------------------------------------------

    let previewLines = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLines) || previewLines < 0) previewLines = 12;
    const shown = rows.slice(0, previewLines);
    const hidden = rows.length - shown.length;

    const rowsHtml = shown.map(r => {
        let t = String(r.text).replace(/\r$/, '');
        if (t.length > 300) t = t.slice(0, 300) + '…';
        return `
            <div class="tool-ui-line-row">
                <div class="tool-ui-line-no">${r.n}</div>
                <div class="tool-ui-line-content">${esc(t)}</div>
            </div>`;
    }).join('');

    const moreHtml = hidden > 0
        ? `<div class="tool-ui-more">… ${hidden} more line${hidden === 1 ? '' : 's'} (full result was sent to the model)</div>`
        : '';
    const emptyHtml = rows.length === 0
        ? `<div class="tool-ui-empty">(no lines in range)</div>`
        : '';
    const body = (rowsHtml || emptyHtml)
        ? `<div class="tool-ui-box">${rowsHtml}${emptyHtml}${moreHtml}</div>`
        : '';

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">description</span>
                    ${pathHtml(fp)}
                    ${badge(`L${s}–L${requestedEnd}`, 'var(--primary)')}
                    ${sampled ? badge('sampled', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span>${rows.length} line${rows.length === 1 ? '' : 's'}</span>
                </div>
            </div>
            ${body}
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${sampled ? 'Sampled read' : 'Read'} ${range}</span>
                </div>
                <span style="opacity:0.6;">${totalLines} total lines</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output: api.cleanupText(output), summary: header };
}