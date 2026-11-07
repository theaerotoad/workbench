// generate_image - tool definition for stable-diffusion.cpp native server API (/sdcpp/v1/*).
const TOOL_META = {
    "name": "generate_image",
    "description": "Generates an image from a text prompt using stable-diffusion.cpp and saves it to a workspace file. Supports customizable aspect ratios (e.g., '1:1', '16:9', '9:16', '4:3', '3:2', '21:9'), resolutions, negative prompts, and random seeds. Streams progressive preview frames during sampling and saves the finished image directly to the designated filepath.",
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Detailed text description of the image to generate. Be specific regarding subject, artistic style, composition, lighting, and details."
            },
            "filepath": {
                "type": "string",
                "description": "Workspace-relative destination file path (e.g. 'public/assets/hero.png', 'images/banner.jpg', 'assets/icon.webp')."
            },
            "aspect_ratio": {
                "type": "string",
                "description": "Desired aspect ratio: '1:1' (square), '16:9' (widescreen/landscape), '9:16' (portrait/story), '4:3' (standard landscape), '3:4' (standard portrait), '3:2' (classic photo), '2:3' (vertical photo), '21:9' (ultrawide). Ignored if exact width and height are provided."
            },
            "size": {
                "type": "string",
                "description": "Optional resolution preset: 'small' (512px base), 'medium' (768px base), 'large' (1024px base, default), or explicit 'WIDTHxHEIGHT' (e.g. '1024x768')."
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
                "description": "Optional negative prompt specifying unwanted elements, styles, or artifacts to exclude."
            },
            "seed": {
                "type": "integer",
                "description": "Random seed for generation reproducibility (-1 for random). Defaults to -1."
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
            "description": "Pick the stable-diffusion.cpp model provider configured in your models.json."
        },
        {
            "key": "previewMode",
            "label": "Preview Mode",
            "type": "select",
            "options": ["proj", "tae", "vae", "none"],
            "default": "proj",
            "description": "Preview rendering method during sampling ('proj' is fastest, 'tae' uses Tiny AutoEncoder weights, 'vae' decodes full VAE)."
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
            "label": "CFG / Guidance Scale",
            "type": "number",
            "default": 7.0,
            "min": 0,
            "max": 30,
            "description": "Text guidance scale (txt_cfg)."
        },
        {
            "key": "timeoutMs",
            "label": "Request Timeout (ms)",
            "type": "number",
            "default": 180000,
            "min": 10000,
            "max": 600000,
            "description": "Generation timeout in milliseconds (default: 180s)."
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

    // 5. Dynamic aspect ratio calculation (e.g. custom "16:10" or "5:4")
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

function renderLiveCard({ fp, prompt, width, height, status, step, totalSteps, previewB64 }) {
    const pct = totalSteps > 0 ? Math.min(100, Math.max(0, Math.round((step / totalSteps) * 100))) : 0;
    const isQueued = status === 'queued';
    const statusText = isQueued
        ? 'Queued on server...'
        : `Sampling step ${step || 0} / ${totalSteps || 0} (${pct}%)`;

    const previewBlock = previewB64
        ? `<img src="data:image/png;base64,${previewB64}" alt="Preview" style="max-width:280px; max-height:200px; border-radius:6px; border:1px solid var(--border); display:block; margin:4px 0;" />`
        : `<div style="height:140px; width:220px; border-radius:6px; border:1px dashed var(--border); display:flex; align-items:center; justify-content:center; color:var(--dim); font-size:11px; margin:4px 0; background:var(--bg-input);">
             <span>Awaiting initial frame...</span>
           </div>`;

    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">autorenew</span>
                    ${pathHtml(fp)}
                    ${badge(isQueued ? 'queued' : `${pct}%`, isQueued ? 'var(--yellow)' : 'var(--primary)')}
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
    const raw = b64.replace(/^data:image\/[a-z]+;base64,/, '');
    const binary = atob(raw);
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
        return fail(api, fp, "No Image Model configured. Select your stable-diffusion.cpp provider in Settings > Tools > generate_image > Image Model.");
    }
    if (typeof api?.callModel !== 'function') {
        return fail(api, fp, "Ion host environment does not support model gateway delegation (api.callModel is missing).");
    }

    const previewMode = String(await getSetting('previewMode', 'proj')).trim();
    const defaultSteps = Number(await getSetting('defaultSteps', 20));
    const cfgScale = Number(await getSetting('cfgScale', 7.0));
    const timeoutSetting = Number(await getSetting('timeoutMs', 180000));
    const TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting : 180000;

    // 2. Resolve Output Format & Dimensions
    const ext = fp.split('.').pop().toLowerCase();
    let outputFormat = 'png';
    let mimeType = 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') {
        outputFormat = 'jpeg';
        mimeType = 'image/jpeg';
    } else if (ext === 'webp') {
        outputFormat = 'webp';
        mimeType = 'image/webp';
    }

    const { width, height } = resolveDimensions(args);
    const seed = typeof args.seed === 'number' ? args.seed : -1;
    const steps = Number.isFinite(defaultSteps) && defaultSteps > 0 ? defaultSteps : 20;

    await updateStatus(`Submitting image request (${width}×${height})...`);

    // 3. Submit async job to stable-diffusion.cpp (/sdcpp/v1/img_gen)
    const requestPayload = {
        prompt: promptText,
        negative_prompt: String(args.negative_prompt || ''),
        width,
        height,
        seed,
        batch_count: 1,
        sample_params: {
            sample_steps: steps,
            guidance: {
                txt_cfg: Number.isFinite(cfgScale) ? cfgScale : 7.0
            }
        },
        preview: previewMode,
        preview_interval: 1,
        output_format: outputFormat,
        output_compression: 100
    };

    let submitRes;
    try {
        submitRes = await api.callModel(modelId, {
            method: 'POST',
            path: '/sdcpp/v1/img_gen',
            body: JSON.stringify(requestPayload),
            timeoutMs: 15000
        });
    } catch (e) {
        return fail(api, fp, `Connection to stable-diffusion.cpp failed: ${e.message}`);
    }

    if (!submitRes || submitRes.error) {
        const err = submitRes?.error || 'submission failed';
        return fail(api, fp, `Failed to submit generation job: ${err}`);
    }

    if (!submitRes.ok) {
        let errDetail = submitRes.text || '';
        try {
            const errObj = JSON.parse(submitRes.text);
            errDetail = errObj.error?.message || errObj.error || submitRes.text;
        } catch (_) {}
        if (submitRes.status === 503) {
            return fail(api, fp, `Server returned 503 (Model not loaded or currently busy). Details: ${errDetail}`);
        }
        return fail(api, fp, `Server rejected request (HTTP ${submitRes.status}): ${errDetail}`);
    }

    let jobData;
    try {
        jobData = JSON.parse(submitRes.text);
    } catch (_) {
        return fail(api, fp, `Unexpected non-JSON response from server: ${String(submitRes.text).slice(0, 200)}`);
    }

    const jobId = jobData?.id;
    if (!jobId) {
        return fail(api, fp, `Server did not return a valid job ID: ${JSON.stringify(jobData)}`);
    }

    // 4. Poll /sdcpp/v1/jobs/{id} and stream preview frames
    const startTime = Date.now();
    let lastPreviewB64 = null;
    let completedResult = null;
    let consecutiveErrors = 0;

    while (Date.now() - startTime < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 400));

        let pollRes;
        try {
            pollRes = await api.callModel(modelId, {
                method: 'GET',
                path: `/sdcpp/v1/jobs/${jobId}`,
                timeoutMs: 10000
            });
        } catch (_) {
            consecutiveErrors++;
            if (consecutiveErrors > 8) {
                return fail(api, fp, "Lost connection while polling server status.");
            }
            continue;
        }

        if (!pollRes || !pollRes.ok) {
            consecutiveErrors++;
            if (consecutiveErrors > 8) {
                return fail(api, fp, `Job polling failed with HTTP ${pollRes ? pollRes.status : 'error'}`);
            }
            continue;
        }
        consecutiveErrors = 0;

        let job;
        try {
            job = JSON.parse(pollRes.text);
        } catch (_) {
            continue;
        }

        const status = job.status;

        // Process preview frame if present
        if (job.preview && job.preview.b64_json) {
            lastPreviewB64 = job.preview.b64_json;
        }

        const currentStep = job.preview?.step || 0;
        const totalSteps = job.preview?.total_steps || steps;

        if (status === 'queued') {
            const queuePos = job.queue_position !== undefined ? ` (pos: ${job.queue_position})` : '';
            await updateStatus(`Generation queued${queuePos}...`);
            if (typeof api?.showUI === 'function') {
                try {
                    await api.showUI(renderLiveCard({
                        fp,
                        prompt: promptText,
                        width,
                        height,
                        status: 'queued',
                        step: 0,
                        totalSteps,
                        previewB64: null
                    }), { live: true });
                } catch (_) {}
            }
        } else if (status === 'generating') {
            const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
            await updateStatus(`Sampling ${currentStep}/${totalSteps} (${pct}%)...`);
            if (typeof api?.showUI === 'function') {
                try {
                    await api.showUI(renderLiveCard({
                        fp,
                        prompt: promptText,
                        width,
                        height,
                        status: 'generating',
                        step: currentStep,
                        totalSteps,
                        previewB64: lastPreviewB64
                    }), { live: true });
                } catch (_) {}
            }
        } else if (status === 'completed') {
            completedResult = job;
            break;
        } else if (status === 'failed') {
            const errCode = job.error?.code || 'generation_failed';
            const errMsg = job.error?.message || 'Server reported generation failure.';
            return fail(api, fp, `${errCode}: ${errMsg}`);
        } else if (status === 'cancelled') {
            return fail(api, fp, "Job was cancelled on the server.");
        }
    }

    if (!completedResult) {
        // Attempt server-side cancellation upon client timeout
        try {
            await api.callModel(modelId, {
                method: 'POST',
                path: `/sdcpp/v1/jobs/${jobId}/cancel`,
                timeoutMs: 4000
            });
        } catch (_) {}
        return fail(api, fp, `Generation timed out after ${TIMEOUT_MS / 1000} seconds.`);
    }

    // 5. Extract completed image and save to workspace
    const images = completedResult.result?.images || [];
    const mainImage = images[0];
    if (!mainImage || !mainImage.b64_json) {
        return fail(api, fp, "Completed job result did not contain valid image data.");
    }

    const imageBytes = base64ToUint8Array(mainImage.b64_json);
    const writeError = await api.writeFile(fp, imageBytes);
    if (writeError) {
        return fail(api, fp, `Failed to write image to ${fp}: ${writeError}`);
    }

    const dataUrl = `data:${mimeType};base64,${mainImage.b64_json}`;
    const elapsedSec = (completedResult.completed && completedResult.started)
        ? (completedResult.completed - completedResult.started) / 1000
        : (Date.now() - startTime) / 1000;

    await updateStatus(`Generated: ${fp}`);

    // 6. Final Static Card UI
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
        output: `Successfully generated image and saved to "${fp}" (${width}×${height}, ${outputFormat}). Prompt: "${promptText}".`,
        summary: `${fp} (${width}×${height})`,
        image: dataUrl
    };
}