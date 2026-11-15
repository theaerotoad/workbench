// speech_to_text - tool definition for OpenAI-compatible Whisper endpoints (/v1/audio/transcriptions).
const TOOL_META = {
    "name": "speech_to_text",
    "description": "Transcribes an audio file to text using an OpenAI-compatible Whisper endpoint (/v1/audio/transcriptions). Supports common audio formats (mp3, wav, flac, m4a, ogg).",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Workspace-relative path to the audio file (e.g. 'public/audio/sample.mp3')."
            },
            "language": {
                "type": "string",
                "description": "Optional ISO-639-1 language code (e.g., 'en', 'fr', 'es') to improve accuracy."
            },
            "prompt": {
                "type": "string",
                "description": "Optional context or previous words to guide the transcription style or spelling."
            },
            "response_format": {
                "type": "string",
                "description": "Output format: 'json', 'text', 'srt', 'verbose_json', or 'vtt'. Defaults to 'json'."
            },
            "temperature": {
                "type": "number",
                "description": "Sampling temperature between 0 and 1. Defaults to 0."
            },
            "model": {
                "type": "string",
                "description": "Optional model ID/alias (e.g., 'whisper-1', 'whisper-large-v3'). Overrides the configured setting."
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
    "permission": "ask",
    "toolBox": 1,
    "expanded": true,
    "settings": [
        {
            "key": "audioModel",
            "label": "Audio Model",
            "type": "model",
            "default": "",
            "description": "Pick the transcription model from your models.json (Ion resolves the server URL, model name, and key automatically)."
        },
        {
            "key": "timeoutMs",
            "label": "Request Timeout (ms)",
            "type": "number",
            "default": 300000,
            "min": 10000,
            "max": 900000,
            "description": "Timeout in milliseconds for transcription (default: 300s / 5min)."
        }
    ]
};

// --- Helpers & Utilities -----------------------------------------------------

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c]));
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
                    ${badge('Transcription Failed', 'var(--red)')}
                </div>
            </div>
            <div class="tool-ui-error-msg">
                <span class="icon" style="font-size:12px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

function renderWaitingCard({ fp, model, elapsedSec }) {
    const timeText = elapsedSec ? `${elapsedSec}s` : 'starting...';
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">graphic_eq</span>
                    ${pathHtml(fp)}
                    ${badge(model || 'transcribing', 'var(--primary)')}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--dim); font-size:10px; margin-right:6px;">${timeText}</span>
                </div>
            </div>
            <div style="height:110px; border-radius:6px; border:1px dashed var(--border); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; margin:4px 0; background:var(--bg-input);">
                <span class="icon" style="font-size:24px; color:var(--primary);">graphic_eq</span>
                <span style="font-size:11px; color:var(--dim);">Waiting for audio transcription...</span>
            </div>
        </div>`;
}

function renderFinalCard({ fp, transcript, elapsedSec, model }) {
    const timeBadge = elapsedSec ? `${elapsedSec.toFixed(1)}s` : '';
    // Display up to 500 chars in the UI to prevent massive cards for long podcasts
    const truncated = transcript.length > 500 ? transcript.slice(0, 500) + '...' : transcript;

    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--green); flex-shrink:0;">description</span>
                    ${pathHtml(fp)}
                    ${badge('Transcribed', 'var(--green)')}
                </div>
                <div class="tool-ui-header-stats">
                    ${model ? `<span style="color:var(--dim); font-size:10px; margin-right:6px;">${esc(model)}</span>` : ''}
                    ${timeBadge ? `<span style="color:var(--dim); font-size:10px;">${timeBadge}</span>` : ''}
                </div>
            </div>
            <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--fg); background:var(--bg-input); padding:10px; border-radius:6px; border:1px solid var(--border); margin:4px 0; max-height:220px; overflow-y:auto; white-space:pre-wrap; line-height:1.4;">${esc(truncated)}</div>
        </div>`;
}

async function fail(api, fp, msg) {
    const clean = String(msg).replace(/^ERROR:\s*/, '');
    if (typeof api?.showUI === 'function') {
        try { await api.showUI(errorHtml(fp, clean)); } catch (_) {}
    }
    return { output: `ERROR: ${clean}` };
}

/**
 * Builds a valid multipart/form-data payload as a Uint8Array suitable for binary transmission.
 */
function buildMultipartBody(fields, fileBytes, filename, mimeType) {
    const boundary = '----IonFormBoundary' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const encoder = new TextEncoder();
    const chunks = [];

    for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null && v !== '') {
            chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`));
        }
    }

    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    chunks.push(fileBytes);
    chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
        body.set(c, offset);
        offset += c.length;
    }

    return { body, boundary };
}

function inferMimeType(fp) {
    const ext = String(fp).split('.').pop().toLowerCase();
    const mimes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'flac': 'audio/flac',
        'm4a': 'audio/mp4',
        'ogg': 'audio/ogg',
        'webm': 'audio/webm',
        'mp4': 'video/mp4'
    };
    return mimes[ext] || 'application/octet-stream';
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const fp = args.filepath;
    if (!fp || !String(fp).trim()) {
        return { output: "ERROR: 'filepath' is required." };
    }

    const updateStatus = async (msg) => {
        if (typeof api?.setHeaderMsg === 'function') {
            await api.setHeaderMsg(msg);
        }
    };

    // 1. Resolve Settings & Model
    const getSetting = async (k, d) => {
        if (typeof api?.getSetting !== 'function') return d;
        const v = await api.getSetting(k);
        return (v === undefined || v === null || v === '') ? d : v;
    };

    const modelId = String(await getSetting('audioModel', '')).trim();
    if (!modelId) {
        return fail(api, fp, "No Audio Model selected. Pick your model in Settings > Tools > speech_to_text > Audio Model.");
    }
    if (typeof api?.callModel !== 'function') {
        return fail(api, fp, "This version of Ion does not support api.callModel. Update Ion.");
    }

    let modelName = String(args.model || '').trim();
    let matchedModel = null;
    if (typeof api?.listModels === 'function') {
        try {
            const models = await api.listModels();
            if (Array.isArray(models)) {
                matchedModel = models.find(m =>
                    (m.uuid && m.uuid.toLowerCase() === modelId.toLowerCase()) ||
                    (m.id && String(m.id).toLowerCase() === modelId.toLowerCase()) ||
                    (m.name && m.name.toLowerCase() === modelId.toLowerCase()) ||
                    (m.providerName && `${m.providerName}::${m.name}`.toLowerCase() === modelId.toLowerCase())
                ) || null;
                if (!modelName && matchedModel && matchedModel.name) {
                    modelName = matchedModel.name;
                }
            }
        } catch (_) {}
    }
    if (!modelName) {
        if (modelId.includes('::')) {
            modelName = modelId.split('::').pop().trim();
        } else if (!/^[0-9a-f-]{36}$/i.test(modelId)) {
            modelName = modelId;
        } else {
            modelName = 'whisper-1';
        }
    }

    const timeoutSetting = Number(await getSetting('timeoutMs', 300000));
    const TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting : 300000;

    // 2. Read Audio Bytes
    await updateStatus(`Reading audio file: ${fp}...`);
    const audioBytes = await api.readFileBytes(fp);
    if (typeof audioBytes === 'string') {
        // String return implies an error (e.g., "ERROR: File not found")
        return fail(api, fp, audioBytes);
    }
    if (!audioBytes || audioBytes.length === 0) {
        return fail(api, fp, "The audio file is empty or could not be read.");
    }

    // 3. Build multipart/form-data payload
    const mimeType = inferMimeType(fp);
    const filename = fp.split('/').pop() || 'audio.mp3';

    const fields = {
        model: modelName,
        language: args.language,
        prompt: args.prompt,
        response_format: args.response_format || 'json',
        temperature: typeof args.temperature === 'number' ? args.temperature : undefined
    };

    const { body, boundary } = buildMultipartBody(fields, audioBytes, filename, mimeType);

    // Show initial live card
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderWaitingCard({ fp, model: modelName, elapsedSec: 0 }), { live: true });
        } catch (_) {}
    }

    await updateStatus(`Transcribing with ${modelName || 'selected model'}...`);

    const startTime = Date.now();
    let isFinished = false;

    // Live timer
    const progressTimer = setInterval(() => {
        if (isFinished) return;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        updateStatus(`Transcribing ${filename} (${elapsed}s)...`);
        if (typeof api?.showUI === 'function') {
            try {
                api.showUI(renderWaitingCard({ fp, model: modelName, elapsedSec: elapsed }), { live: true });
            } catch (_) {}
        }
    }, 1000);

    // 4. Call model via API gateway
    const baseUrl = matchedModel?.url ? String(matchedModel.url).trim().replace(/\/+$/, '') : '';
    const hasV1InBase = baseUrl.endsWith('/v1');
    const primaryPath = hasV1InBase ? '/audio/transcriptions' : '/v1/audio/transcriptions';
    const fallbackPath = hasV1InBase ? '/v1/audio/transcriptions' : '/audio/transcriptions';

    let res;
    try {
        const fetchOpts = {
            path: primaryPath,
            body: body,
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            timeoutMs: TIMEOUT_MS
        };

        res = await api.callModel(modelId, fetchOpts);

        // Fallback for 404
        if (res && res.status === 404) {
            fetchOpts.path = fallbackPath;
            const retryRes = await api.callModel(modelId, fetchOpts);
            if (retryRes && (retryRes.ok || retryRes.status !== 404)) {
                res = retryRes;
            }
        }
    } catch (e) {
        isFinished = true;
        clearInterval(progressTimer);
        return fail(api, fp, `Model call threw exception: ${e.message}`);
    } finally {
        isFinished = true;
        clearInterval(progressTimer);
    }

    const elapsedSec = (Date.now() - startTime) / 1000;

    // 5. Validate and Parse Response
    if (!res || res.error) {
        const err = res && res.error;
        if (err === 'timeout') return fail(api, fp, `Transcription timed out after ${TIMEOUT_MS / 1000}s.`);
        if (err === 'unreachable') return fail(api, fp, "Could not reach the server. Ensure the transcription service is running.");
        return fail(api, fp, `Transcription failed: ${err || 'unknown error'}`);
    }

    if (!res.ok) {
        let detail = res.text || '';
        try {
            const errObj = JSON.parse(res.text);
            detail = errObj.error?.message || errObj.detail || errObj.error || res.text;
        } catch (_) {}
        return fail(api, fp, `Server returned HTTP ${res.status}: ${detail}`);
    }

    let transcript = '';
    try {
        // Attempt to parse JSON (Standard OpenAI format)
        const parsed = JSON.parse(res.text);
        transcript = parsed.text || parsed.task || JSON.stringify(parsed);
    } catch (e) {
        // If it's not JSON, it might be raw text, srt, or vtt requested by the user
        transcript = res.text;
    }

    if (!transcript || !String(transcript).trim()) {
        return fail(api, fp, "The server returned an empty transcription.");
    }

    await updateStatus(`Transcribed ${filename} (${elapsedSec.toFixed(1)}s)`);

    // 6. Render final card UI
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderFinalCard({
                fp,
                transcript,
                elapsedSec,
                model: modelName
            }));
        } catch (_) {}
    }

    // 7. Return payload to the language model
    return {
        output: `Transcription of ${fp} (${modelName}):\n\n${transcript}`,
        summary: `Transcribed ${fp} (${elapsedSec.toFixed(1)}s)`
    };
}