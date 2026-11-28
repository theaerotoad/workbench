// preview_image - tool definition.
const TOOL_META = {
    "name": "preview_image",
    "description": "View one or more image files as actual images (png/jpg/jpeg/gif/bmp/webp/svg/ico). Pass filepath alone to see the whole image, or add top-level x/y/width/height to zoom into a specific region — useful for reading small text or inspecting detail in a screenshot. Alternatively pass files: a list of { filepath, x?, y?, width?, height? } to view multiple images in one call, each with its own optional crop (crop fields then belong on each entry, not at the top level). Coordinates are normalized fractions in the range 0.0-1.0 relative to the image dimensions (0.0 is left/top, 1.0 is right/bottom). Number of images per call is capped by the maxImages setting; per-image output size is capped by maxMegapixels (applied after the standard 1568px long-side limit).",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Path to an image in the open workspace. Provide either filepath (single image) or files (multiple), not both."
            },
            "x": {
                "type": "number",
                "description": "Left edge of the crop region, normalized fraction 0.0-1.0 (0.0 is left, 1.0 is right). Omit to view the full image. For multi-image calls use the per-entry crop on files instead."
            },
            "y": {
                "type": "number",
                "description": "Top edge of the crop region, normalized fraction 0.0-1.0 (0.0 is top, 1.0 is bottom)."
            },
            "width": {
                "type": "number",
                "description": "Width of the crop region, normalized fraction 0.0-1.0 (1.0 spans the full width)."
            },
            "height": {
                "type": "number",
                "description": "Height of the crop region, normalized fraction 0.0-1.0 (1.0 spans the full height)."
            },
            "files": {
                "type": "array",
                "description": "Optional list of images to view in one call. Each entry is { filepath: string, x?, y?, width?, height? } (crop is per-image, normalized 0.0-1.0). When files is provided, omit top-level x/y/width/height and filepath. Subject to the maxImages and maxMegapixels settings.",
                "items": {
                    "type": "object",
                    "properties": {
                        "filepath": { "type": "string" },
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "width": { "type": "number" },
                        "height": { "type": "number" }
                    },
                    "required": ["filepath"]
                }
            }
        }
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "always",
    "toolBox": 1,
    "expanded": true,
    "require_vision": true,
    "settings": [
        {
            "key": "maxImages",
            "label": "Max Images Per Call",
            "type": "number",
            "default": 8,
            "min": 1,
            "max": 64,
            "description": "Maximum number of images returned in a single preview_image call."
        },
        {
            "key": "maxMegapixels",
            "label": "Max Megapixels Per Image",
            "type": "number",
            "default": 4,
            "min": 0.25,
            "max": 50,
            "description": "Additional per-image size budget in megapixels. The image is capped at the 1568px long-side limit first; this only shrinks it further when set below ~2.5MP."
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

function errorHtml(fp, msg) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-error-wrap">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    ${badge('Preview Failed', 'var(--red)')}
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

// Coerce a setting value to a finite number, falling back to dflt and clamping to [lo, hi].
function clampNum(v, lo, hi, dflt) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = dflt;
    return Math.min(hi, Math.max(lo, n));
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const maxImages = clampNum(await api.getSetting('maxImages'), 1, 64, 8);
    const maxMegapixels = clampNum(await api.getSetting('maxMegapixels'), 0.25, 50, 4);
    const hasTopCrop = ['x', 'y', 'width', 'height'].some(k => args[k] !== undefined && args[k] !== null);

    let targets = [];          // [{ filepath, x?, y?, width?, height? }]
    let truncatedNote = null;
    if (Array.isArray(args.files)) {
        if (hasTopCrop) return fail(api, (args.files[0] && args.files[0].filepath) || '', 'When using files, put x/y/width/height on each entry, not at top level.');
        for (const e of args.files) {
            if (e && typeof e.filepath === 'string') {
                const t = { filepath: e.filepath };
                ['x', 'y', 'width', 'height'].forEach(k => { if (e[k] !== undefined && e[k] !== null) t[k] = e[k]; });
                targets.push(t);
            }
        }
        if (!targets.length) return { output: 'ERROR: files must be a non-empty list of { filepath, ... } entries.' };
        if (targets.length > maxImages) {
            targets = targets.slice(0, maxImages);
            truncatedNote = `[note: maxImages limit of ${maxImages} reached; only the first ${maxImages} image(s) were sent.]`;
        }
    } else if (args.filepath) {
        const t = { filepath: args.filepath };
        ['x', 'y', 'width', 'height'].forEach(k => { if (args[k] !== undefined && args[k] !== null) t[k] = args[k]; });
        targets.push(t);
    } else {
        return { output: 'ERROR: Provide either filepath (single image) or files (multiple).' };
    }

    const header = targets.length === 1
        ? targets[0].filepath
        : `Previewing ${targets.length} image(s): ${targets.map(t => t.filepath).join(', ')}`;
    await api.setHeaderMsg(header);

    // The host reads each file (with the usual path-safety checks) and does the canvas crop/scale,
    // since decoding and re-encoding images needs the DOM, which a tool worker doesn't have.
    // One bad path must not abort the others — each failure is reported per-image.
    const results = [];   // { filepath, x?, ..., img? }
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const cropArgs = {};
        ['x', 'y', 'width', 'height'].forEach(k => { if (t[k] !== undefined && t[k] !== null) cropArgs[k] = t[k]; });
        let img;
        try {
            img = await api.readImage(t.filepath, cropArgs, { maxMegapixels });
        } catch (e) {
            img = { error: e.message };
        }
        if (!img || img.error) img = { error: (img && img.error) || 'Failed to read image' };
        results.push({ ...t, img });
        if (targets.length > 1) await api.setHeaderMsg(`Previewing ${i + 1}/${targets.length}: ${t.filepath}`);
    }

    // This text is what the model reads; the images themselves are passed separately via `images`.
    const lines = [];
    if (truncatedNote) lines.push(truncatedNote);
    const images = [];
    for (const r of results) {
        const { filepath: fp, img } = r;
        if (img.error) {
            lines.push(`ERROR: ${fp}: ${String(img.error).replace(/^ERROR:\s*/, '')}`);
            continue;
        }
        const { dataUrl, width, height, sourceWidth, sourceHeight, crop } = img;
        lines.push(crop
            ? `Cropped region ${crop.x},${crop.y} ${crop.width}x${crop.height} of ${fp} (full image is ${sourceWidth}x${sourceHeight}), shown below at ${width}x${height}.`
            : `Full image ${fp} (${sourceWidth}x${sourceHeight}), shown below${(width !== sourceWidth || height !== sourceHeight) ? ` scaled to ${width}x${height}` : ''}.`);
        const base = String(fp).split('/').pop().split('\\').pop() || 'image';
        images.push({ url: dataUrl, label: `${base}${crop ? ' (region)' : ''}` });
    }
    const output = lines.join('\n');

    // --- Display ---------------------------------------------------------------

    const blocks = [];
    for (const r of results) {
        const { filepath: fp, img } = r;
        if (img.error) {
            blocks.push(`
            <div class="tool-ui-error-wrap" style="margin:4px 0;">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                    ${pathHtml(fp)}
                    ${badge('Preview Failed', 'var(--red)')}
                </div>
                <div class="tool-ui-error-msg">
                    <span class="icon" style="font-size:12px;">error</span>
                    <span>${esc(String(img.error).replace(/^ERROR:\s*/, ''))}</span>
                </div>
            </div>`);
            continue;
        }
        const { dataUrl, width, height, sourceWidth, sourceHeight, crop } = img;
        const base = String(fp).split('/').pop().split('\\').pop() || 'image';
        const name = crop ? `${base} (region)` : base;
        // The chat's click handler opens `.tool-preview-image-thumb[data-attachment-id]` in an editor tab and
        // rebuilds the image from the <img> below, so the id only has to be unique.
        const attId = `prev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        blocks.push(`
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">image</span>
                    ${pathHtml(fp)}
                    ${crop
                        ? badge(`region ${crop.x},${crop.y} ${crop.width}×${crop.height}`, 'var(--yellow)')
                        : badge('full image', 'var(--primary)')}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0;">${width}×${height}</span>
                </div>
            </div>
            <div class="tool-preview-image-thumb" data-attachment-id="${attId}" title="Click to open in a tab: ${esc(name)}">
                <img src="${dataUrl}" alt="${esc(name)}" style="max-width:280px; max-height:200px; border-radius:6px; border:1px solid var(--border); margin:4px 0; display:block;">
            </div>`);
    }

    const footerBits = [];
    if (images.length) {
        footerBits.push(`
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${images.length === 1 ? 'Image sent to the model' : `${images.length} images sent to the model`}</span>
                </div>`);
    }
    if (truncatedNote) footerBits.push(`<span>${badge(`truncated to ${maxImages}`, 'var(--yellow)')}`);

    const displayHtml = `
        <div class="tool-ui-wrap">
            ${blocks.join('\n')}
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    ${footerBits.join('\n')}
                </div>
            </div>
        </div>`;

    await api.showUI(displayHtml);

    // All targets failed: plain error output, no image turn pushed.
    if (!images.length) {
        return { output, summary: header };
    }

    const ret = { output, summary: header, images, displayHtml };
    // Legacy single-image field so the old path stays exercised and single-image behavior is byte-identical.
    if (images.length === 1) ret.image = images[0].url;
    return ret;
}
