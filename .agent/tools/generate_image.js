// generate_image - tool definition for llama-swap / stable-diffusion.cpp via SDAPI (/sdapi/v1/*).
const TOOL_META = {
    "name": "generate_image",
    "description": "Generates an image from a text prompt using stable-diffusion.cpp hosted behind llama-swap (SDAPI /sdapi/v1/txt2img). Supports customizable aspect ratios ('1:1', '16:9', '9:16', '4:3', '3:2', '21:9', etc.), sizes, negative prompts, and random seeds. Streams progressive previews via /sdapi/v1/progress and saves the final generated image directly to a workspace file.",
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Detailed prompt describing the image to generate (subject, lighting, composition, artistic style)."
            },
            "filepath": {
                "type": "string",
                "description": "Workspace-relative destination file path (e.g. 'public/hero.png', 'assets/card.png', 'images/banner.jpg')."
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
            "negative_prompt": {
                "type": "string",
                "description": "Optional negative prompt specifying elements or artifacts to avoid."
            },
            "seed": {
                "type": "integer",
                "description": "Random seed for reproducibility (-1 for random). Defaults to -1."
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
            "description": "Select the llama-swap / stable-diffusion.cpp provider configured in your models.json."
        },
        {
            "key": "modelName",
            "label": "Model Name (llama-swap)",
            "type": "text",
            "default": "",
            "description": "Optional model ID or alias configured in llama-swap config.yaml (e.g., 'sdxl', 'flux'). If blank, uses the model's display name from models.json."
        },
        {
            "key": "previewMode",
            "label": "Preview Mode",
            "type": "select",
            "options": ["proj", "tae", "vae", "none"],
            "default": "proj",
            "description": "Preview rendering method in stable-diffusion.cpp ('proj' is fast latent projection, 'tae' uses Tiny AutoEncoder, 'vae' decodes full VAE)."
        },
        {
            "key": "defaultSteps",
            "label": "Default Steps",
            "type": "number",
            "default": 20,
            "min": 1,
            "max": 150,
            "description": "Sampling step count."
        },
        {
            "key": "cfgScale",
            "label": "CFG / Guidance Scale",
            "type": "number",
            "default": 7.0,
            "min": 0,
            "max": 30,
            "description": "Classifier-free guidance scale."
        },
        {
            "key": "samplerName",
            "label": "Sampler Name",
            "type": "text",
            "default": "",
            "description": "Optional sampler name (e.g., 'Euler a', 'Euler', 'DPM++ 2M'). Omit to use server default."
        },
        {
            "key": "scheduler",
            "label": "Scheduler",
            "type": "text",
            "default": "",
            "description": "Optional scheduler name (e.g., 'normal', 'karras', 'discrete'). Omit to use server default."
        },
        {
            "key": "timeoutMs",
            "label": "Request Timeout (ms)",
            "type": "number",
            "default": 180000,
            "min": 10000,
            "max": 600000,
            "description": "Timeout for generation in milliseconds (default: 180s)."
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
    // 1. Explicit width and height provided
    if (typeof args.width === 'number' && typeof args.height === 'number' && args.width > 0 && args.height > 0) {
        return {
            width: roundToMultiple(args.width),
            height: roundToMultiple(args.height)
        };
    }

    // 2. Explicit "WIDTHxHEIGHT" in size string
    if (typeof args.size === 'string') {
        const sizeMatch = args.size.trim().match(/^(\d+)\s*[xX×*]\s*(\d+)$/);
        if (sizeMatch) {
            return {
                width: roundToMultiple(parseInt(sizeMatch[1], 10)),
                height: roundToMultiple(parseInt(sizeMatch[2], 10))
            };
        }
    }

    // 3. Determine base scale
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

    // 4. Look up known aspect ratio preset
    const ratioStr = String(args.aspect_ratio || '1:1').trim();
    const table = ASPECT_RATIO_PRESETS[base] || ASPECT_RATIO_PRESETS[1024];
    if (table && table[ratioStr]) {
        return { width: table[ratioStr][0], height: table[ratioStr][1] };
    }

    // 5. Dynamic aspect ratio calculation
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

    // Default 1:1 fallback
    return { width: base, height: base };
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

function renderLiveCard({ fp, prompt, width, height, pct, step, totalSteps, previewB64 }) {
    const statusText = totalSteps > 0
        ? `Sampling step ${step} / ${totalSteps} (${pct}%)`
        : `Generating (${pct}%)...`;

    const previewSrc = previewB64
        ? (previewB64.startsWith('data:') ? previewB64 : `data:image/jpeg;base64,${previewB64}`)
        : null;

    const previewBlock = previewSrc
        ? `<img src="${previewSrc}" alt="Preview" style="max-width:280px; max-height:200px; border-radius:6px; border:1px solid var(--border); display:block; margin:4px 0;" />`
        : `<div style="height:140px; width:220px; border-radius:6px; border:1px dashed var(--border); display:flex; align-items:center; justify-content:center; color:var(--dim); font-size:11px; margin:4px 0; background:var(--bg-input);">
             <span>Awaiting preview frame...</span>
           </div>`;

    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">autorenew</span>
                    ${pathHtml(fp)}
                    ${badge(`${pct}%`, 'var(--primary)')}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0;">${width}×${height}</span>
                </div>
            </div>
            <div style="padding:2px 0;">
                ${previewBlock}
            </div>
            <div style="background:var(--bg-input); border-radius:3px; height:4px; overflow:hidden; margin:6px 0 4px 0;">
                <div style="background:var(--primary); height:100%; width:${pct}%; transition:width 0.2s ease;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <span>${esc(statusText)}</span>
                <span style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:0.8;">${esc(prompt)}</span>
            </div>
        </div>`;
}

function renderFinalCard({ fp, prompt, width, height, dataUrl, elapsedSec }) {
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

function base64ToUint8Array(b64) {
    const clean = b64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
    const binary = atob(clean);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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
        return fail(api, fp, "No Image Model configured. Select your model provider in Settings > Tools > generate_image > Image Model.");
    }
    if (typeof api?.callModel !== 'function') {
        return fail(api, fp, "Host environment does not support model gateway calls (api.callModel is missing).");
    }

    // Resolve model name for llama-swap routing
    let resolvedModelName = String(await getSetting('modelName', '')).trim();
    if (!resolvedModelName && typeof api?.listModels === 'function') {
        try {
            const models = await api.listModels();
            const matched = models.find(m => m.id === modelId);
            if (matched && matched.name) {
                resolvedModelName = matched.name;
            }
        } catch (_) {}
    }

    const previewMode = String(await getSetting('previewMode', 'proj')).trim();
    const defaultSteps = Number(await getSetting('defaultSteps', 20));
    const cfgScale = Number(await getSetting('cfgScale', 7.0));
    const samplerName = String(await getSetting('samplerName', '')).trim();
    const scheduler = String(await getSetting('scheduler', '')).trim();
    const timeoutSetting = Number(await getSetting('timeoutMs', 180000));
    const TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting : 180000;

    const { width, height } = resolveDimensions(args);
    const steps = Number.isFinite(defaultSteps) && defaultSteps > 0 ? defaultSteps : 20;
    const seed = typeof args.seed === 'number' ? args.seed : -1;

    // 2. Prepare SDAPI Request Body
    // Embed sd_cpp_extra_args to inform stable-diffusion.cpp about preview mode
    let effectivePrompt = promptText;
    if (previewMode && previewMode !== 'none') {
        effectivePrompt += ` <sd_cpp_extra_args>{"preview":"${previewMode}"}</sd_cpp_extra_args>`;
    }

    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = {
        prompt: effectivePrompt,
        negative_prompt: String(args.negative_prompt || ''),
        width,
        height,
        steps,
        cfg_scale: Number.isFinite(cfgScale) ? cfgScale : 7.0,
        seed,
        batch_size: 1,
        id_task: taskId
    };

    if (samplerName) payload.sampler_name = samplerName;
    if (scheduler) payload.scheduler = scheduler;
    if (resolvedModelName) payload.model = resolvedModelName;

    await updateStatus(`Generating image with llama-swap (${width}×${height})...`);

    // 3. Initiate synchronous txt2img generation in the background
    let isFinished = false;
    let genResult = null;
    let genError = null;
    const startTime = Date.now();

    const genPromise = api.callModel(modelId, {
        method: 'POST',
        path: '/sdapi/v1/txt2img',
        body: JSON.stringify(payload),
        timeoutMs: TIMEOUT_MS
    }).then(r => {
        genResult = r;
    }).catch(e => {
        genError = e;
    }).finally(() => {
        isFinished = true;
    });

    // 4. Poll /sdapi/v1/progress concurrently for preview frames and step progress
    const modelQuery = resolvedModelName ? `&model=${encodeURIComponent(resolvedModelName)}` : '';
    let lastPreviewB64 = null;
    let pollCount = 0;

    while (!isFinished) {
        await new Promise(r => setTimeout(r, 350));
        if (isFinished) break;
        pollCount++;

        // First attempt with matching id_task; fallback to default if not matched
        let pollPath = `/sdapi/v1/progress?id_task=${encodeURIComponent(taskId)}${modelQuery}`;
        if (pollCount > 3 && !lastPreviewB64) {
            pollPath = `/sdapi/v1/progress?id_task=sdapi${modelQuery}`;
        }

        let pollRes;
        try {
            pollRes = await api.callModel(modelId, {
                method: 'GET',
                path: pollPath,
                timeoutMs: 6000
            });
        } catch (_) {
            continue;
        }

        if (!pollRes || !pollRes.ok || isFinished) continue;

        let progData;
        try {
            progData = JSON.parse(pollRes.text);
        } catch (_) {
            continue;
        }

        if (!progData || isFinished) continue;

        if (progData.current_image) {
            lastPreviewB64 = progData.current_image;
        }

        const step = progData.state?.sampling_step || 0;
        const totalSteps = progData.state?.sampling_steps || steps;
        const frac = typeof progData.progress === 'number' && progData.progress > 0
            ? progData.progress
            : (totalSteps > 0 ? step / totalSteps : 0);
        const pct = Math.min(100, Math.max(0, Math.round(frac * 100)));

        await updateStatus(`Sampling step ${step}/${totalSteps} (${pct}%)...`);

        if (typeof api?.showUI === 'function') {
            try {
                await api.showUI(renderLiveCard({
                    fp,
                    prompt: promptText,
                    width,
                    height,
                    pct,
                    step,
                    totalSteps,
                    previewB64: lastPreviewB64
                }), { live: true });
            } catch (_) {}
        }
    }

    // Await promise completion resolution
    await genPromise;

    // 5. Check Generation Result
    if (genError) {
        return fail(api, fp, `Generation failed: ${genError.message || genError}`);
    }
    if (!genResult) {
        return fail(api, fp, `Generation request timed out after ${TIMEOUT_MS / 1000} seconds.`);
    }

    if (!genResult.ok) {
        let detail = genResult.text || '';
        try {
            const parsed = JSON.parse(genResult.text);
            detail = parsed.error?.message || parsed.error || parsed.detail || genResult.text;
        } catch (_) {}

        if (genResult.status === 503) {
            return fail(api, fp, `Server returned 503 (Model not loaded or busy). Detail: ${detail}`);
        }
        return fail(api, fp, `llama-swap rejected request (HTTP ${genResult.status}): ${detail}`);
    }

    let responseData;
    try {
        responseData = JSON.parse(genResult.text);
    } catch (_) {
        return fail(api, fp, `Server returned invalid JSON: ${String(genResult.text).slice(0, 200)}`);
    }

    const images = responseData?.images;
    if (!Array.isArray(images) || images.length === 0 || !images[0]) {
        return fail(api, fp, `No image found in /sdapi/v1/txt2img response.`);
    }

    // 6. Save image to workspace
    const rawImageB64 = images[0];
    const imageBytes = base64ToUint8Array(rawImageB64);
    const writeError = await api.writeFile(fp, imageBytes);
    if (writeError) {
        return fail(api, fp, `Failed to save image to ${fp}: ${writeError}`);
    }

    const dataUrl = rawImageB64.startsWith('data:') ? rawImageB64 : `data:image/png;base64,${rawImageB64}`;
    const elapsedSec = (Date.now() - startTime) / 1000;

    await updateStatus(`Generated: ${fp}`);

    // 7. Render Final Static Card
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderFinalCard({
                fp,
                prompt: promptText,
                width,
                height,
                dataUrl,
                elapsedSec
            }));
        } catch (_) {}
    }

    return {
        output: `Successfully generated image and saved to "${fp}" (${width}×${height}). Prompt: "${promptText}".`,
        summary: `${fp} (${width}×${height})`,
        image: dataUrl
    };
}