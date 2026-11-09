// generate_image - tool definition for stable-diffusion.cpp / llama-swap via OpenAI API (/v1/images/generations).
const TOOL_META = {
    "name": "generate_image",
    "description": "Generates an image from a text prompt using an OpenAI-compatible endpoint (/v1/images/generations) and saves it to a workspace file. Supports customizable aspect ratios ('1:1', '16:9', '9:16', '4:3', '3:2', '21:9'), sizes, negative prompts, and random seeds.",
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Detailed text description of the image to generate (subject, lighting, composition, artistic style)."
            },
            "filepath": {
                "type": "string",
                "description": "Workspace-relative destination file path (e.g. 'public/hero.png', 'assets/banner.png', 'images/sample.png')."
            },
            "aspect_ratio": {
                "type": "string",
                "description": "Desired aspect ratio: '1:1' (square), '16:9' (landscape), '9:16' (portrait/story), '4:3' (standard landscape), '3:4' (standard portrait), '3:2' (classic photo), '2:3' (vertical photo), '21:9' (ultrawide). Ignored if explicit width and height are provided."
            },
            "size": {
                "type": "string",
                "description": "Resolution preset: 'small' (512px base), 'medium' (768px base), 'large' (1024px base, default), or explicit 'WIDTHxHEIGHT' (e.g. '1024x768')."
            },
            "width": {
                "type": "integer",
                "description": "Explicit width in pixels (rounded to nearest multiple of 16). Overrides aspect_ratio when provided with height."
            },
            "height": {
                "type": "integer",
                "description": "Explicit height in pixels (rounded to nearest multiple of 16). Overrides aspect_ratio when provided with width."
            },
            "steps": {
                "type": "integer",
                "description": "Number of sampling steps. Defaults to configured setting or 20."
            },
            "cfg_scale": {
                "type": "number",
                "description": "Text guidance scale (CFG). Defaults to configured setting or 7.0."
            },
            "negative_prompt": {
                "type": "string",
                "description": "Optional negative prompt specifying elements or artifacts to exclude."
            },
            "seed": {
                "type": "integer",
                "description": "Random seed for reproducibility (-1 for random). Defaults to -1."
            },
            "model": {
                "type": "string",
                "description": "Optional model ID / alias configured in llama-swap (e.g., 'krea2', 'sdxl', 'flux'). Overrides the model's configured name."
            }
        },
        "required": [
            "prompt",
            "filepath"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "ask",
    "toolBox": 1,
    "expanded": true,
    "settings": [
        {
            "key": "imageModel",
            "label": "Image Model",
            "type": "model",
            "default": "",
            "description": "Pick the image model from your models.json providers (Ion resolves the server URL, model name, and key automatically)."
        },
        {
            "key": "defaultSteps",
            "label": "Default Steps",
            "type": "number",
            "default": 20,
            "min": 1,
            "max": 150,
            "description": "Default sampling steps."
        },
        {
            "key": "cfgScale",
            "label": "Default CFG Scale",
            "type": "number",
            "default": 7.0,
            "min": 0,
            "max": 30,
            "description": "Default text guidance scale (cfg_scale)."
        },
        {
            "key": "timeoutMs",
            "label": "Request Timeout (ms)",
            "type": "number",
            "default": 300000,
            "min": 10000,
            "max": 900000,
            "description": "Timeout in milliseconds for model swapping and generation (default: 300s / 5min)."
        }
    ]
};

// --- Dimension & Aspect Ratio Resolution -------------------------------------

const ASPECT_RATIO_PRESETS = {
    1024: {
        "1:1": [1024, 1024],
        "16:9": [1344, 768],
        "9:16": [768, 1344],
        "4:3": [1152, 864],
        "3:4": [864, 1152],
        "3:2": [1216, 832],
        "2:3": [832, 1216],
        "21:9": [1536, 640],
        "9:21": [640, 1536]
    },
    768: {
        "1:1": [768, 768],
        "16:9": [1024, 576],
        "9:16": [576, 1024],
        "4:3": [896, 672],
        "3:4": [672, 896],
        "3:2": [960, 640],
        "2:3": [640, 960],
        "21:9": [1152, 480],
        "9:21": [480, 1152]
    },
    512: {
        "1:1": [512, 512],
        "16:9": [688, 384],
        "9:16": [384, 688],
        "4:3": [576, 432],
        "3:4": [432, 576],
        "3:2": [624, 416],
        "2:3": [416, 624],
        "21:9": [768, 320],
        "9:21": [320, 768]
    }
};

function roundToMultiple(val, multiple = 16, min = 64, max = 2048) {
    const rounded = Math.round(val / multiple) * multiple;
    return Math.max(min, Math.min(max, rounded));
}

function resolveDimensions(args) {
    if (typeof args.width === 'number' && typeof args.height === 'number' && args.width > 0 && args.height > 0) {
        return {
            width: roundToMultiple(args.width),
            height: roundToMultiple(args.height)
        };
    }

    if (typeof args.size === 'string') {
        const sizeMatch = args.size.trim().match(/^(\d+)\s*[xX×*]\s*(\d+)$/);
        if (sizeMatch) {
            return {
                width: roundToMultiple(parseInt(sizeMatch[1], 10)),
                height: roundToMultiple(parseInt(sizeMatch[2], 10))
            };
        }
    }

    let base = 1024;
    const sizeStr = String(args.size || '').toLowerCase().trim();
    if (sizeStr === 'small' || sizeStr === '512') {
        base = 512;
    } else if (sizeStr === 'medium' || sizeStr === '768') {
        base = 768;
    } else if (sizeStr === 'large' || sizeStr === '1024') {
        base = 1024;
    } else if (/^\d+$/.test(sizeStr)) {
        const num = parseInt(sizeStr, 10);
        if (num >= 64 && num <= 2048) base = num;
    }

    const ratioStr = String(args.aspect_ratio || '1:1').trim();
    const table = ASPECT_RATIO_PRESETS[base] || ASPECT_RATIO_PRESETS[1024];
    if (table && table[ratioStr]) {
        return { width: table[ratioStr][0], height: table[ratioStr][1] };
    }

    const customRatio = ratioStr.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    if (customRatio) {
        const rW = parseFloat(customRatio[1]);
        const rH = parseFloat(customRatio[2]);
        if (rW > 0 && rH > 0) {
            const ratio = rW / rH;
            const targetPixels = base * base;
            const w = Math.sqrt(targetPixels * ratio);
            const h = Math.sqrt(targetPixels / ratio);
            return {
                width: roundToMultiple(w),
                height: roundToMultiple(h)
            };
        }
    }

    return { width: base, height: base };
}

// --- Response Parser Helpers -------------------------------------------------

function cleanBase64(str) {
    if (!str) return '';
    let s = String(str).trim();
    const commaIdx = s.indexOf(',');
    if (commaIdx !== -1 && s.slice(0, commaIdx).includes('base64')) {
        s = s.slice(commaIdx + 1);
    }
    // Strip quotes and non-base64 whitespace/control characters
    return s.replace(/[^A-Za-z0-9+/=]/g, '');
}

/**
 * Robustly extracts the base64 image data from the OpenAI /v1/images/generations response.
 * Allows extraction of truncated strings so subsequent byte-checking can analyze the payload.
 */
function extractImageBase64(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;

    // 1. Direct JSON parse
    try {
        const data = JSON.parse(rawText);
        if (data && data.data && Array.isArray(data.data) && data.data.length > 0 && typeof data.data[0].b64_json === 'string') {
            return cleanBase64(data.data[0].b64_json);
        }
    } catch (_) {}

    // 2. Fallback: Manual string extraction for truncated/oversized responses
    const imgKeyIdx = rawText.indexOf('"b64_json"');
    if (imgKeyIdx !== -1) {
        const quoteStart = rawText.indexOf('"', imgKeyIdx + 10);
        if (quoteStart !== -1) {
            const quoteEnd = rawText.indexOf('"', quoteStart + 1);
            if (quoteEnd !== -1) {
                return cleanBase64(rawText.slice(quoteStart + 1, quoteEnd));
            } else {
                // Truncated JSON response - extract everything available so isImageComplete can analyze it
                return cleanBase64(rawText.slice(quoteStart + 1));
            }
        }
    }

    return null;
}

function base64ToUint8Array(b64) {
    const clean = cleanBase64(b64);
    const binary = atob(clean);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function isImageComplete(bytes) {
    if (!bytes || bytes.length < 16) return false;
    // PNG check: starts with PNG signature
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        const len = bytes.length;
        const iend = [0x49, 0x45, 0x4E, 0x44];
        // Search backwards for IEND (image generators often append metadata chunks after it)
        for (let i = len - 8; i >= Math.max(0, len - 102400); i--) {
            if (bytes[i] === iend[0] && bytes[i + 1] === iend[1] && bytes[i + 2] === iend[2] && bytes[i + 3] === iend[3]) {
                return true;
            }
        }
        return len > 102400; // Assume complete if >100KB to salvage gracefully truncated images
    }
    // JPEG check: starts with 0xFF 0xD8
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        if (bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9) return true;
        return bytes.length > 102400; // Allow JPEGs >100KB even if missing EOI marker
    }
    return bytes.length > 32;
}

// --- UI Helpers --------------------------------------------------------------

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
                    ${badge('Generation Failed', 'var(--red)')}
                </div>
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

function renderWaitingCard({ fp, prompt, width, height, model, elapsedSec }) {
    const timeText = elapsedSec ? `${elapsedSec}s` : 'starting...';
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">hourglass_top</span>
                    ${pathHtml(fp)}
                    ${badge(model || 'generating', 'var(--primary)')}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--dim); font-size:10px; margin-right:6px;">${timeText}</span>
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0;">${width}×${height}</span>
                </div>
            </div>
            <div style="height:110px; border-radius:6px; border:1px dashed var(--border); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; margin:4px 0; background:var(--bg-input);">
                <span class="icon" style="font-size:24px; color:var(--primary);">autorenew</span>
                <span style="font-size:11px; color:var(--dim);">Waiting for model routing & generation...</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <span>OpenAI /v1/images/generations</span>
                <span style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:0.8;">${esc(prompt)}</span>
            </div>
        </div>`;
}

function renderFinalCard({ fp, prompt, width, height, dataUrl, elapsedSec, model }) {
    const base = String(fp).split('/').pop().split('\\').pop() || 'image';
    const attId = `prev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const timeBadge = elapsedSec ? `${elapsedSec.toFixed(1)}s` : '';

    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--green); flex-shrink:0;">image</span>
                    ${pathHtml(fp)}
                    ${badge('Saved', 'var(--green)')}
                </div>
                <div class="tool-ui-header-stats">
                    ${model ? `<span style="color:var(--dim); font-size:10px; margin-right:6px;">${esc(model)}</span>` : ''}
                    ${timeBadge ? `<span style="color:var(--dim); font-size:10px; margin-right:6px;">${timeBadge}</span>` : ''}
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0;">${width}×${height}</span>
                </div>
            </div>
            <div class="tool-preview-image-thumb" data-attachment-id="${attId}" title="Click to open in a tab: ${esc(base)}">
                <img src="${dataUrl}" alt="${esc(base)}" style="max-width:280px; max-height:200px; border-radius:6px; border:1px solid var(--border); margin:4px 0; display:block; cursor:pointer;">
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px; max-width:80%;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(prompt)}</span>
                </div>
                <span style="opacity:0.6;">${width}×${height}</span>
            </div>
        </div>`;
}

async function fail(api, fp, msg) {
    const clean = String(msg).replace(/^ERROR:\s*/, '');
    if (typeof api?.showUI === 'function') {
        try { await api.showUI(errorHtml(fp, clean)); } catch (_) {}
    }
    return { output: `ERROR: ${clean}` };
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = args.filepath;
    if (!fp || !String(fp).trim()) {
        return { output: "ERROR: 'filepath' is required." };
    }
    const promptText = String(args.prompt || '').trim();
    if (!promptText) {
        return { output: "ERROR: 'prompt' is required." };
    }

    const updateStatus = async (msg) => {
        if (typeof api?.setHeaderMsg === 'function') {
            await api.setHeaderMsg(msg);
        }
    };

    // 1. Resolve Settings
    const getSetting = async (k, d) => {
        if (typeof api?.getSetting !== 'function') return d;
        const v = await api.getSetting(k);
        return (v === undefined || v === null || v === '') ? d : v;
    };

    const modelId = String(await getSetting('imageModel', '')).trim();
    if (!modelId) {
        return fail(api, fp, "No Image Model selected. Pick your model in Settings > Tools > generate_image > Image Model.");
    }
    if (typeof api?.callModel !== 'function') {
        return fail(api, fp, "This version of Ion does not support api.callModel. Update Ion.");
    }

    // Resolve model name from models.json or argument
    let modelName = String(args.model || '').trim();
    if (!modelName && typeof api?.listModels === 'function') {
        try {
            const models = await api.listModels();
            const matched = models.find(m => m.id === modelId);
            if (matched && matched.name) {
                modelName = matched.name;
            }
        } catch (_) {}
    }

    const defaultSteps = Number(await getSetting('defaultSteps', 20));
    const cfgScale = Number(await getSetting('cfgScale', 7.0));
    const timeoutSetting = Number(await getSetting('timeoutMs', 300000));
    const TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting : 300000;

    const { width, height } = resolveDimensions(args);
    const steps = typeof args.steps === 'number' && args.steps > 0
        ? args.steps
        : (Number.isFinite(defaultSteps) && defaultSteps > 0 ? defaultSteps : 20);
    const cfg = typeof args.cfg_scale === 'number'
        ? args.cfg_scale
        : (Number.isFinite(cfgScale) ? cfgScale : 7.0);
    const seed = typeof args.seed === 'number' ? args.seed : -1;

    // 2. Build OpenAI-compatible payload with sd_cpp_extra_args for native features
    const extraArgs = {
        negative_prompt: String(args.negative_prompt || ''),
        seed: seed,
        sample_params: {
            sample_steps: steps,
            guidance: {
                txt_cfg: cfg
            }
        }
    };

    const payload = {
        prompt: promptText + ` <sd_cpp_extra_args>${JSON.stringify(extraArgs)}</sd_cpp_extra_args>`,
        n: 1,
        size: `${width}x${height}`,
        output_format: "jpeg",
        output_compression: 92
    };

    if (modelName) {
        payload.model = modelName;
    }

    await updateStatus(`Generating image with ${modelName || 'selected model'} (${width}×${height})...`);

    // Show initial live card
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderWaitingCard({
                fp,
                prompt: promptText,
                width,
                height,
                model: modelName,
                elapsedSec: 0
            }), { live: true });
        } catch (_) {}
    }

    const startTime = Date.now();
    let isFinished = false;

    // Live timer
    const progressTimer = setInterval(() => {
        if (isFinished) return;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        updateStatus(`Generating image with ${modelName || 'model'} (${elapsed}s)...`);
        if (typeof api?.showUI === 'function') {
            try {
                api.showUI(renderWaitingCard({
                    fp,
                    prompt: promptText,
                    width,
                    height,
                    model: modelName,
                    elapsedSec: elapsed
                }), { live: true });
            } catch (_) {}
        }
    }, 1000);

    // 3. Call endpoint via Ion's secure model gateway
    let res;
    try {
        res = await api.callModel(modelId, {
            path: '/v1/images/generations',
            body: JSON.stringify(payload),
            timeoutMs: TIMEOUT_MS
        });
    } catch (e) {
        isFinished = true;
        clearInterval(progressTimer);
        return fail(api, fp, `Model call threw exception: ${e.message}`);
    } finally {
        isFinished = true;
        clearInterval(progressTimer);
    }

    const elapsedSec = (Date.now() - startTime) / 1000;

    // 4. Validate response
    if (!res || res.error) {
        const err = res && res.error;
        if (err === 'timeout') return fail(api, fp, `Generation timed out after ${TIMEOUT_MS / 1000}s.`);
        if (err === 'unreachable') return fail(api, fp, "Could not reach the server. Verify that llama-swap is running.");
        return fail(api, fp, `Model call failed: ${err || 'unknown error'}`);
    }

    if (!res.ok) {
        let detail = res.text || '';
        try {
            const errObj = JSON.parse(res.text);
            detail = errObj.error?.message || errObj.detail || errObj.error || res.text;
        } catch (_) {}
        return fail(api, fp, `Server returned HTTP ${res.status}: ${detail}`);
    }

    // 5. Extract image base64 robustly
    const rawB64 = extractImageBase64(res.text);
    if (!rawB64) {
        return fail(api, fp, `Could not extract image from server response: ${String(res.text).slice(0, 200)}`);
    }

    // 6. Write image bytes to workspace file
    const imageBytes = base64ToUint8Array(rawB64);
    if (!isImageComplete(imageBytes)) {
        return fail(api, fp, `Image payload was truncated by the server/proxy (${(imageBytes.length / 1024).toFixed(1)} KB received, missing marker).`);
    }

    const writeError = await api.writeFile(fp, imageBytes);
    if (writeError) {
        return fail(api, fp, `Failed to save image to ${fp}: ${writeError}`);
    }

    const isJpeg = imageBytes[0] === 0xFF && imageBytes[1] === 0xD8;
    const dataUrl = `data:image/${isJpeg ? 'jpeg' : 'png'};base64,${rawB64}`;
    await updateStatus(`Saved ${fp} (${elapsedSec.toFixed(1)}s)`);

    // 7. Render final card for the user in the tool box UI
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderFinalCard({
                fp,
                prompt: promptText,
                width,
                height,
                dataUrl,
                elapsedSec,
                model: modelName
            }));
        } catch (_) {}
    }

    // Do not return `image: dataUrl` in the tool result object. Returning `image` causes
    // Ion's task runner to inject the entire 1.5MB+ dataUrl back into the calling LLM's conversation history
    // (marked as a preview_image call). If truncated or oversized, the vision API (e.g. Gemini) rejects
    // the request with "Failed to load image or audio file", poisoning the session into a permanent retry loop.
    return {
        output: `Successfully generated image with model "${modelName || 'default'}" and saved to "${fp}" (${width}×${height}) in ${elapsedSec.toFixed(2)}s. Prompt: "${promptText}".`,
        summary: `${fp} (${width}×${height}) - ${elapsedSec.toFixed(1)}s`
    };
}