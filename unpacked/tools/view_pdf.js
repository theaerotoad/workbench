// view_pdf - tool definition.
const TOOL_META = {
    "name": "view_pdf",
    "description": "Inspect a PDF file in the workspace by extracting per-page text, metadata, table of contents (outline), and/or rendered page images. Omit `pages` on your first call to get document metadata, page count, table of contents (if present), and the first few pages. Use `mode=\"text\"` (default, fast, works on all models) for reading/searching prose and tables; use `mode=\"image\"` or `mode=\"both\"` (vision models only; gracefully falls back to text on non-vision models) for diagrams, schematics, figures, or scanned pages with no embedded text. For dense schematics or small labels on a single page, pass normalized crop coordinates `x`, `y`, `width`, `height` (0.0-1.0) in image/both mode.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Workspace-relative path to the PDF file."
            },
            "pages": {
                "type": "string",
                "description": "Optional 1-based page selection, e.g. \"3\", \"1-5\", or \"1,3,7-9\". Omit to get metadata, outline, and the first few pages."
            },
            "mode": {
                "type": "string",
                "enum": ["text", "image", "both"],
                "description": "Output mode: \"text\" (default), \"image\" (rendered pages for vision models), or \"both\"."
            },
            "password": {
                "type": "string",
                "description": "Optional password for encrypted PDF files."
            },
            "x": {
                "type": "number",
                "description": "Optional left edge of normalized crop region (0.0-1.0). Single-page image/both mode only."
            },
            "y": {
                "type": "number",
                "description": "Optional top edge of normalized crop region (0.0-1.0). Single-page image/both mode only."
            },
            "width": {
                "type": "number",
                "description": "Optional width of normalized crop region (0.0-1.0). Single-page image/both mode only."
            },
            "height": {
                "type": "number",
                "description": "Optional height of normalized crop region (0.0-1.0). Single-page image/both mode only."
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
    "expanded": false,
    "require_vision": false,
    "settings": [
        {
            "key": "defaultPages",
            "label": "Default Overview Pages",
            "type": "number",
            "default": 3,
            "min": 1,
            "max": 20,
            "description": "Number of initial pages returned when `pages` is omitted."
        },
        {
            "key": "maxPages",
            "label": "Max Text Pages Per Call",
            "type": "number",
            "default": 15,
            "min": 1,
            "max": 100,
            "description": "Maximum number of pages extracted in text mode per call."
        },
        {
            "key": "maxChars",
            "label": "Max Text Characters",
            "type": "number",
            "default": 40000,
            "min": 2000,
            "max": 85000,
            "description": "Character budget for extracted text per call (kept below the 100K tool output ceiling)."
        },
        {
            "key": "maxImages",
            "label": "Max Rendered Pages Per Call",
            "type": "number",
            "default": 6,
            "min": 1,
            "max": 32,
            "description": "Maximum number of pages rendered as images in a single call."
        },
        {
            "key": "maxMegapixels",
            "label": "Max Megapixels Per Page Image",
            "type": "number",
            "default": 2.5,
            "min": 0.25,
            "max": 10,
            "description": "Per-page pixel budget in megapixels (applied alongside the 1568px long-side cap)."
        },
        {
            "key": "previewLines",
            "label": "Preview Lines",
            "type": "number",
            "default": 12,
            "min": 0,
            "max": 200,
            "description": "Maximum extracted text lines shown in the chat card (the model receives the full result)."
        }
    ]
};

// --- Pure helpers ------------------------------------------------------------

function clampNum(v, lo, hi, dflt) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = dflt;
    return Math.min(hi, Math.max(lo, n));
}

function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parsePagesSpec(raw, numPages) {
    const str = String(raw || '').trim();
    if (!str) return { pages: [], notes: [] };

    const tokens = str.split(',');
    const pages = [];
    const seen = new Set();
    const notes = [];

    for (const rawTok of tokens) {
        const tok = rawTok.trim();
        if (!tok) {
            return { error: `Invalid pages specification "${raw}": empty segment near comma.` };
        }
        const rangeMatch = tok.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (start < 1 || end < 1) {
                return { error: `Invalid page range "${tok}": page numbers are 1-based positive integers.` };
            }
            if (end < start) {
                return { error: `Invalid page range "${tok}": end page must be >= start page.` };
            }
            if (start > numPages) {
                notes.push(`range ${start}-${end} exceeds document length (${numPages} pages); skipped`);
                continue;
            }
            const clampedEnd = Math.min(end, numPages);
            if (end > numPages) {
                notes.push(`page ${end} exceeds document length (${numPages} pages); clamped to ${numPages}`);
            }
            for (let p = start; p <= clampedEnd; p++) {
                if (!seen.has(p)) {
                    seen.add(p);
                    pages.push(p);
                }
            }
            continue;
        }
        if (/^\d+$/.test(tok)) {
            const p = parseInt(tok, 10);
            if (p < 1) {
                return { error: `Invalid page "${tok}": page numbers are 1-based positive integers.` };
            }
            if (p > numPages) {
                notes.push(`page ${p} exceeds document length (${numPages} pages); skipped`);
                continue;
            }
            if (!seen.has(p)) {
                seen.add(p);
                pages.push(p);
            }
            continue;
        }
        return { error: `Invalid pages token "${tok}". Expected a page number or range like "3", "1-5", or "1,3,7-9".` };
    }

    return { pages, outOfBounds: pages.length === 0, notes };
}

function formatPageList(nums) {
    if (!nums || !nums.length) return '';
    const sorted = [...nums].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        if (cur === prev) continue;
        if (cur === prev + 1) {
            prev = cur;
        } else {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
            start = prev = cur;
        }
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    return ranges.join(',');
}

// --- UI helpers (display only, never sent to the model) ----------------------

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c]));
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

function errorHtml(fp, msg) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    ${badge('PDF Failed', 'var(--red)')}
                </div>
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

async function fail(api, fp, msg) {
    const clean = String(msg).replace(/^ERROR:\s*/, '');
    await api.showUI(errorHtml(fp, clean));
    return { output: `ERROR: ${clean}` };
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = String(args.filepath || '').trim();
    if (!fp) return fail(api, '', 'filepath is required.');

    const requestedMode = args.mode === undefined || args.mode === null || args.mode === ''
        ? 'text'
        : String(args.mode).trim().toLowerCase();
    if (!['text', 'image', 'both'].includes(requestedMode)) {
        return fail(api, fp, `Invalid mode "${args.mode}". Must be "text", "image", or "both".`);
    }

    const password = typeof args.password === 'string' && args.password.length > 0 ? args.password : undefined;
    const hasCropInput = ['x', 'y', 'width', 'height'].some(k => args[k] !== undefined && args[k] !== null);
    let cropObj = null;
    if (hasCropInput) {
        cropObj = {};
        for (const k of ['x', 'y', 'width', 'height']) {
            if (args[k] === undefined || args[k] === null) continue;
            const v = Number(args[k]);
            if (!Number.isFinite(v) || v < 0 || v > 1) {
                return fail(api, fp, `Crop parameter "${k}" must be a number between 0.0 and 1.0.`);
            }
            if ((k === 'width' || k === 'height') && v <= 0) {
                return fail(api, fp, `Crop parameter "${k}" must be greater than 0.`);
            }
            cropObj[k] = v;
        }
    }

    const defaultPages = Math.floor(clampNum(await api.getSetting('defaultPages'), 1, 20, 3));
    const maxPages = Math.floor(clampNum(await api.getSetting('maxPages'), 1, 100, 15));
    const maxChars = Math.floor(clampNum(await api.getSetting('maxChars'), 2000, 85000, 40000));
    const maxImages = Math.floor(clampNum(await api.getSetting('maxImages'), 1, 32, 6));
    const maxMegapixels = clampNum(await api.getSetting('maxMegapixels'), 0.25, 10, 2.5);
    const previewLines = Math.floor(clampNum(await api.getSetting('previewLines'), 0, 200, 12));

    const topNotices = [];
    let effectiveMode = requestedMode;
    if ((requestedMode === 'image' || requestedMode === 'both') && !api.hasVision) {
        effectiveMode = 'text';
        topNotices.push('[note: active model does not support vision; fell back to mode="text".]');
        if (cropObj) {
            cropObj = null;
            topNotices.push('[note: crop parameters ignored because vision is unavailable.]');
        }
    } else if (cropObj && effectiveMode === 'text') {
        return fail(api, fp, 'Crop coordinates (x, y, width, height) are only supported in mode="image" or mode="both".');
    }

    await api.setHeaderMsg(`Reading PDF info: ${fp}`);
    const info = await api.pdfInfo(fp, { password });
    if (!info || info.error) {
        return fail(api, fp, (info && info.error) || 'Failed to load PDF.');
    }

    const numPages = info.numPages || 0;
    if (numPages === 0) {
        await api.showUI(`<div class="tool-ui-wrap"><div class="tool-ui-empty">${esc(fp)} has 0 pages.</div></div>`);
        return { output: `PDF: ${fp} (0 pages)`, summary: `${fp} (0 pages)` };
    }

    const isOverview = args.pages === undefined || args.pages === null || String(args.pages).trim() === '';
    let requestedPages = [];
    if (isOverview) {
        const count = Math.min(defaultPages, numPages);
        for (let p = 1; p <= count; p++) requestedPages.push(p);
    } else {
        const parsed = parsePagesSpec(args.pages, numPages);
        if (parsed.error) return fail(api, fp, parsed.error);
        for (const n of parsed.notes) topNotices.push(`[note: ${n}]`);
        if (parsed.outOfBounds) {
            return fail(api, fp, `No requested pages exist in ${fp} (document has ${numPages} page${numPages === 1 ? '' : 's'}).`);
        }
        requestedPages = parsed.pages;
    }

    const wantText = effectiveMode === 'text' || effectiveMode === 'both';
    const wantImage = effectiveMode === 'image' || effectiveMode === 'both';

    if (cropObj && wantImage && requestedPages.length > 1) {
        return fail(api, fp, 'Crop coordinates can only be used when rendering a single page (e.g. pages="3").');
    }

    const textTargetPages = wantText ? requestedPages.slice(0, maxPages) : [];
    const overflowTextPages = wantText ? requestedPages.slice(maxPages) : [];
    const imageTargetPages = wantImage ? requestedPages.slice(0, maxImages) : [];
    const overflowImagePages = wantImage ? requestedPages.slice(maxImages) : [];

    // 1. Extract text if needed
    let textRes = null;
    if (wantText && textTargetPages.length) {
        const label = formatPageList(textTargetPages);
        await api.setHeaderMsg(`Extracting text: ${fp} (p. ${label})`);
        textRes = await api.pdfText(fp, { pages: textTargetPages, password, maxChars });
        if (!textRes || textRes.error) {
            return fail(api, fp, (textRes && textRes.error) || 'Failed to extract PDF text.');
        }
    }

    // 2. Render page images if needed
    const renderedResults = [];
    if (wantImage && imageTargetPages.length) {
        for (let i = 0; i < imageTargetPages.length; i++) {
            const p = imageTargetPages[i];
            await api.setHeaderMsg(
                imageTargetPages.length === 1
                    ? `Rendering ${fp} (p. ${p}/${numPages})`
                    : `Rendering ${fp} (p. ${p}, ${i + 1}/${imageTargetPages.length})`
            );
            let res;
            try {
                res = await api.pdfRenderPage(fp, p, { password, maxMegapixels, crop: cropObj });
            } catch (e) {
                res = { error: e.message || String(e) };
            }
            if (!res || res.error) {
                res = { page: p, error: (res && res.error) || `Failed to render page ${p}` };
            }
            renderedResults.push(res);
        }
    }

    // 3. Truncation & continuation notices (placed at top so the model sees them immediately)
    let truncated = false;
    if (wantText && textRes) {
        const returnedSet = new Set((textRes.pages || []).map(p => p.page));
        const missingFromTarget = textTargetPages.filter(p => !returnedSet.has(p));
        const allMissingText = [...missingFromTarget, ...overflowTextPages];
        if (allMissingText.length > 0 || textRes.truncatedByChars) {
            truncated = true;
            const nextSpec = formatPageList(allMissingText.slice(0, maxPages));
            const reason = textRes.truncatedByChars
                ? `character budget of ${maxChars} reached`
                : `maxPages limit of ${maxPages} reached`;
            const cont = nextSpec
                ? ` Continue with view_pdf(filepath="${fp}", pages="${nextSpec}", mode="${effectiveMode}").`
                : '';
            topNotices.push(`[TRUNCATED: text extraction stopped (${reason}).${allMissingText.length ? ` Pages not shown: ${formatPageList(allMissingText)}.` : ''}${cont}]`);
        }
    }

    if (wantImage && overflowImagePages.length > 0) {
        truncated = true;
        const nextSpec = formatPageList(overflowImagePages.slice(0, maxImages));
        topNotices.push(`[TRUNCATED: maxImages limit of ${maxImages} reached; rendered pages ${formatPageList(imageTargetPages)} only. Remaining pages: ${formatPageList(overflowImagePages)}. Continue with view_pdf(filepath="${fp}", pages="${nextSpec}", mode="image").]`);
    }

    if (isOverview && numPages > requestedPages.length && !truncated) {
        const nextStart = requestedPages.length + 1;
        const nextEnd = Math.min(numPages, nextStart + (wantImage && !wantText ? maxImages : maxPages) - 1);
        topNotices.push(`[note: overview returned first ${requestedPages.length} of ${numPages} pages. Request more with view_pdf(filepath="${fp}", pages="${nextStart}${nextEnd > nextStart ? `-${nextEnd}` : ''}", mode="${effectiveMode}").]`);
    }

    // 4. Assemble model output text
    const outSections = [];
    if (topNotices.length) outSections.push(topNotices.join('\n'));

    const sizeStr = formatBytes(info.fileSize);
    const metaLines = [`PDF: ${fp} (${numPages} page${numPages === 1 ? '' : 's'}${sizeStr ? `, ${sizeStr}` : ''})`];
    if (info.title) metaLines.push(`Title: ${info.title}`);
    if (info.author) metaLines.push(`Author: ${info.author}`);
    if (info.subject) metaLines.push(`Subject: ${info.subject}`);
    outSections.push(metaLines.join('\n'));

    if (isOverview && Array.isArray(info.outline) && info.outline.length > 0) {
        const tocLines = ['Table of Contents:'];
        for (const item of info.outline) {
            const indent = '  '.repeat(Math.min(item.level || 0, 4));
            const pg = item.page ? ` (p. ${item.page})` : '';
            tocLines.push(`${indent}- ${item.title}${pg}`);
        }
        if (info.outlineTruncated) {
            tocLines.push('  (outline truncated)');
        }
        outSections.push(tocLines.join('\n'));
    }

    const lowTextPages = [];
    if (wantText && textRes && Array.isArray(textRes.pages)) {
        const pageBlocks = [];
        for (const p of textRes.pages) {
            if (p.lowText) {
                lowTextPages.push(p.page);
                const hint = `[Page ${p.page}: little/no extractable text — likely a scanned page or diagram; call view_pdf(filepath="${fp}", pages="${p.page}", mode="image") to inspect visually.]`;
                pageBlocks.push(p.text
                    ? `--- Page ${p.page} / ${numPages} ---\n${hint}\n${p.text}`
                    : `--- Page ${p.page} / ${numPages} ---\n${hint}`);
            } else {
                pageBlocks.push(`--- Page ${p.page} / ${numPages} ---\n${p.text}`);
            }
        }
        if (pageBlocks.length) outSections.push(pageBlocks.join('\n\n'));
    }

    const baseName = fp.split('/').pop() || fp;
    const images = [];
    if (wantImage && renderedResults.length) {
        const imgLines = [];
        let attachIdx = 0;
        for (const r of renderedResults) {
            if (r.error) {
                imgLines.push(`ERROR rendering page ${r.page}: ${String(r.error).replace(/^ERROR:\s*/, '')}`);
                continue;
            }
            attachIdx++;
            const label = r.crop
                ? `page ${r.page} of ${baseName} (cropped region)`
                : `page ${r.page} of ${baseName}`;
            images.push({ url: r.dataUrl, label });
            imgLines.push(r.crop
                ? `- Image ${attachIdx}: ${label} (${r.width}x${r.height}, crop ${r.crop.x},${r.crop.y} of ${r.sourceWidth}x${r.sourceHeight})`
                : `- Image ${attachIdx}: ${label} (${r.width}x${r.height})`);
        }
        if (imgLines.length) {
            outSections.push(`Rendered page images attached in order:\n${imgLines.join('\n')}`);
        }
    }

    const output = api.cleanupText(outSections.join('\n\n'), { preserveTrailingWhitespace: true });

    // 5. Build display UI card (never sent to the model)
    const shownPagesSpec = formatPageList(
        wantText && textRes && textRes.pages.length
            ? textRes.pages.map(p => p.page)
            : imageTargetPages
    );
    const summary = `${fp} (p. ${shownPagesSpec} of ${numPages}${effectiveMode !== 'text' ? `, ${effectiveMode}` : ''})`;

    let textPreviewHtml = '';
    if (wantText && textRes && textRes.pages.length && previewLines > 0) {
        let shown = 0;
        let totalPreviewable = 0;
        let rows = '';
        for (const p of textRes.pages) {
            const pLines = p.text ? p.text.split('\n') : (p.lowText ? ['[scanned / no extractable text]'] : ['(empty page)']);
            totalPreviewable += pLines.length;
            if (shown >= previewLines) continue;
            rows += `
                <div class="tool-ui-row">
                    <span style="color:var(--primary); font-weight:600; font-size:11px;">Page ${p.page}</span>
                    <span style="color:var(--dim); font-size:10px; margin-left:auto;">${p.lowText ? 'low text (likely scan)' : `${p.charCount} chars`}</span>
                </div>`;
            for (const line of pLines) {
                if (shown >= previewLines) break;
                shown++;
                const clipped = line.length > 260 ? line.slice(0, 260) + '…' : line;
                rows += `
                    <div class="tool-ui-line-row">
                        <div class="tool-ui-line-no">${p.page}</div>
                        <div class="tool-ui-line-content">${esc(clipped)}</div>
                    </div>`;
            }
        }
        const hidden = Math.max(0, totalPreviewable - shown);
        const more = hidden > 0
            ? `<div class="tool-ui-more">… ${hidden} more line${hidden === 1 ? '' : 's'} (full result sent to the model)</div>`
            : '';
        textPreviewHtml = `<div class="tool-ui-box">${rows}${more}</div>`;
    }

    let thumbsHtml = '';
    if (wantImage && renderedResults.length) {
        const cards = [];
        for (const r of renderedResults) {
            if (r.error) {
                cards.push(`
                    <div class="tool-ui-error-msg" style="margin:4px 0;">
                        <span class="icon" style="font-size:12px;">error</span>
                        <span>Page ${r.page}: ${esc(String(r.error).replace(/^ERROR:\s*/, ''))}</span>
                    </div>`);
                continue;
            }
            const label = r.crop ? `${baseName} p.${r.page} (region)` : `${baseName} p.${r.page}`;
            const attId = `pdf_${Date.now().toString(36)}_${r.page}_${Math.random().toString(36).slice(2, 6)}`;
            cards.push(`
                <div style="display:flex; flex-direction:column; gap:3px; align-items:flex-start;">
                    <div style="font-size:10.5px; color:var(--dim);">Page ${r.page} · ${r.width}×${r.height}${r.crop ? ' · cropped' : ''}</div>
                    <div class="tool-preview-image-thumb" data-attachment-id="${attId}" title="Click to open in a tab: ${esc(label)}">
                        <img src="${r.dataUrl}" alt="${esc(label)}" style="max-width:240px; max-height:200px; border-radius:6px; border:1px solid var(--border); display:block; background:#fff;">
                    </div>
                </div>`);
        }
        thumbsHtml = `<div style="display:flex; flex-wrap:wrap; gap:10px; padding:6px 2px;">${cards.join('\n')}</div>`;
    }

    const modeColor = effectiveMode === 'text' ? 'var(--primary)' : (effectiveMode === 'image' ? 'var(--green)' : 'var(--yellow)');
    const footerParts = [];
    if (wantText && textRes) footerParts.push(`${textRes.pages.length} page${textRes.pages.length === 1 ? '' : 's'} text`);
    if (images.length) footerParts.push(`${images.length} image${images.length === 1 ? '' : 's'} sent`);
    if (lowTextPages.length) footerParts.push(`${lowTextPages.length} low-text page${lowTextPages.length === 1 ? '' : 's'}`);

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">picture_as_pdf</span>
                    ${pathHtml(fp)}
                    ${badge(`p. ${shownPagesSpec}`, 'var(--primary)')}
                    ${badge(effectiveMode, modeColor)}
                    ${cropObj ? badge('cropped', 'var(--yellow)') : ''}
                    ${truncated ? badge('truncated', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span>${numPages} page${numPages === 1 ? '' : 's'}${sizeStr ? ` · ${esc(sizeStr)}` : ''}</span>
                </div>
            </div>
            ${thumbsHtml}
            ${textPreviewHtml}
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${esc(footerParts.join(' · ') || 'PDF inspected')}</span>
                </div>
                ${info.outline && info.outline.length ? `<span style="opacity:0.7;">${info.outline.length} TOC entries</span>` : ''}
            </div>
        </div>`;

    await api.showUI(displayHtml);

    const ret = { output, summary };
    if (images.length) {
        ret.images = images;
        if (images.length === 1) ret.image = images[0].url;
    }
    return ret;
}