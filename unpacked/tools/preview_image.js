// preview_image - tool definition.
const TOOL_META = {
    "name": "preview_image",
    "description": "View an image file (or a cropped region of it) as an actual image (png/jpg/jpeg/gif/bmp/webp/svg/ico). Pass filepath alone to see the whole image, or add x/y/width/height to zoom into a specific region — useful for reading small text or inspecting detail in a screenshot. Coordinates are normalized fractions in the range 0.0-1.0 relative to the image dimensions (0.0 is left/top, 1.0 is right/bottom).",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Path to an image in the open workspace."
            },
            "x": {
                "type": "number",
                "description": "Left edge of the crop region, normalized fraction 0.0-1.0 (0.0 is left, 1.0 is right). Omit to view the full image."
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
    "expanded": true,
    "require_vision": true
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

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = args.filepath;
    if (!fp) return { output: 'ERROR: filepath is required.' };

    const header = `${fp}`;
    await api.setHeaderMsg(header);

    // Only forward the crop fields the model actually provided.
    const cropArgs = {};
    ['x', 'y', 'width', 'height'].forEach(k => {
        if (args[k] !== undefined && args[k] !== null) cropArgs[k] = args[k];
    });

    // The host reads the file (with the usual path-safety checks) and does the canvas crop/scale,
    // since decoding and re-encoding images needs the DOM, which a tool worker doesn't have.
    let img;
    try {
        img = await api.readImage(fp, cropArgs);
    } catch (e) {
        return fail(api, fp, `Failed to preview ${fp}: ${e.message}`);
    }
    if (!img || img.error) return fail(api, fp, (img && img.error) || `Failed to preview ${fp}.`);

    const { dataUrl, width, height, sourceWidth, sourceHeight, crop } = img;

    // This text is what the model reads; the image itself is passed separately via `image`.
    const output = crop
        ? `Cropped region ${crop.x},${crop.y} ${crop.width}x${crop.height} of ${fp} (full image is ${sourceWidth}x${sourceHeight}), shown below at ${width}x${height}.`
        : `Full image ${fp} (${sourceWidth}x${sourceHeight}), shown below${(width !== sourceWidth || height !== sourceHeight) ? ` scaled to ${width}x${height}` : ''}.`;

    // --- Display ---------------------------------------------------------------

    const base = String(fp).split('/').pop().split('\\').pop() || 'image';
    const name = crop ? `${base} (region)` : base;
    // The chat's click handler opens `.tool-preview-image-thumb[data-attachment-id]` in an editor tab and
    // rebuilds the image from the <img> below, so the id only has to be unique.
    const attId = `prev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const displayHtml = `
        <div class="tool-ui-wrap">
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
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${crop ? 'Cropped region sent to the model' : 'Image sent to the model'}</span>
                </div>
                <span style="opacity:0.6;">source ${sourceWidth}×${sourceHeight}</span>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output, summary: header, image: dataUrl };
}