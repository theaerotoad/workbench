// speech_to_text - tool definition for Whisper / OpenAI-compatible transcription via JSON base64 payload.
const TOOL_META = {
    name: "speech_to_text",
    description: "Transcribes an audio file (mp3, wav, m4a, ogg, flac, webm) in the workspace to text using a Whisper-compatible endpoint. The transcript can be returned directly (stdout), saved to a workspace file, or both. Use 'response_format' to pick the output format (text, json, srt, vtt, verbose_json) and 'output_mode' to choose where it goes. If output_filepath is omitted, the filename is derived from the audio file, using the format's natural extension.",
    parameters: {
        type: "object",
        properties: {
            filepath: { 
                type: "string", 
                description: "Workspace-relative path to the audio file to transcribe." 
            },
            output_filepath: {
                type: "string",
                description: "Optional path to save the transcript to. If omitted, the filename is derived from the audio file. Extension should match the chosen response_format (.txt, .json, .srt, .vtt)."
            },
            output_mode: {
                type: "string",
                description: "Where to send the transcript: 'stdout' (return to model context only), 'file' (write to workspace file only), or 'both'. Defaults to 'stdout'."
            },
            language: { 
                type: "string", 
                description: "ISO-639-1 language code (e.g., 'en', 'es') to improve accuracy. Omit for auto-detection." 
            },
            response_format: {
                type: "string",
                description: "Output format: 'json', 'text', 'srt', 'vtt', or 'verbose_json'. Defaults to 'text'."
            },
            prompt: { 
                type: "string", 
                description: "Optional prompt to guide the model on style, punctuation, or technical terms." 
            },
            temperature: { 
                type: "number", 
                description: "Sampling temperature (0-1). Default 0." 
            },
            model: { 
                type: "string", 
                description: "Optional model ID override." 
            }
        },
        required: ["filepath"]
    },
    modes: ["plan", "ask", "code"],
    permission: "ask",
    toolBox: 1,
    expanded: true,
    settings: [
        {
            key: "audioModel",
            label: "Transcription Model",
            type: "model",
            default: "",
            description: "The Whisper model to use for transcription."
        },
        {
            key: "timeoutMs",
            label: "Request Timeout (ms)",
            type: "number",
            default: 120000,
            min: 10000,
            max: 3600000,
            description: "Timeout for the transcription request. Note: Ion host may cap this at 120s."
        }
    ]
};

// --- Constants & Helpers -------------------------------------------------

const EXT_MIME = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.mpg': 'audio/mpeg',
    '.mpeg': 'audio/mpeg',
    '.mpga': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
    '.mp4': 'video/mp4'
};

function bytesToBase64(u8) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
}

function humanSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
                    ${pathHtml(fp)}
                    ${badge('Transcription Failed', 'var(--red)')}
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; padding:8px; color:var(--red); font-size:12px;">
                <span class="icon" style="font-size:14px;">error</span>
                <span>${esc(msg)}</span>
            </div>
        </div>`;
}

function renderWaitingCard({ fp, format, language, size, model, elapsedSec }) {
    const timeText = elapsedSec ? `${elapsedSec}s` : 'starting...';
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    ${pathHtml(fp)}
                    ${badge(model || 'transcribing', 'var(--primary)')}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--dim); font-size:10px; margin-right:6px;">${timeText}</span>
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0;">${size}</span>
                </div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; margin:8px 0; padding:20px; border-radius:6px; border:1px dashed var(--border); background:var(--bg-input);">
                <span class="icon" style="font-size:24px; color:var(--primary);">mic</span>
                <span style="font-size:11px; color:var(--dim);">Processing audio via Whisper...</span>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span class="icon" style="font-size:11px;">settings</span>
                    <span>Format: ${esc(format)}</span>
                    ${language ? `<span>Lang: ${esc(language)}</span>` : ''}
                </div>
            </div>
        </div>`;
}

function renderFinalCard({ fp, outFp, format, language, duration, elapsedSec, charCount, wordCount, preview }) {
    return `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    ${pathHtml(fp)}
                    ${badge('Completed', 'var(--green)')}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--dim); font-size:10px; margin-right:6px;">${elapsedSec.toFixed(1)}s</span>
                    ${duration ? `<span style="color:var(--dim); font-size:10px; flex-shrink:0;">Audio: ${duration}s</span>` : ''}
                </div>
            </div>
            <div style="padding:8px; background:var(--bg-input); border-radius:6px; margin:8px 0; font-family:var(--font-mono); font-size:11px; color:var(--fg); max-height:150px; overflow:hidden; position:relative; line-height:1.4; border:1px solid var(--border);">
                ${esc(preview)}
                ${preview.length < 500 ? '' : '<div style="position:absolute; bottom:0; left:0; right:0; height:20px; background:linear-gradient(transparent, var(--bg-input)); font-size:10px; color:var(--dim); text-align:center;">...truncated...</div>'}
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px; max-width:80%;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>${charCount} chars / ${wordCount} words</span>
                    ${language ? `<span>[${esc(language)}]</span>` : ''}
                    ${outFp ? `<span>→ ${esc(outFp)}</span>` : ''}
                </div>
                <span style="opacity:0.6;">${esc(format)}</span>
            </div>
        </div>`;
}

async function fail(api, fp, msg) {
    const clean = String(msg).replace(/^ERROR:\s*/, '');
    if (typeof api?.showUI === 'function') {
        await api.showUI(errorHtml(fp, clean));
    }
    return { output: `ERROR: ${clean}` };
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

    const getSetting = async (k, d) => {
        if (typeof api?.getSetting !== 'function') return d;
        const v = await api.getSetting(k);
        return v !== undefined ? v : d;
    };

    // 1. Resolve Model
    const modelId = String(await getSetting('audioModel', '')).trim();
    if (!modelId) {
        return fail(api, fp, "No Transcription Model selected. Please set the 'Transcription Model' in Settings > Tools > speech_to_text.");
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
                    (m.providerName && `${m.providerName}::${m.name}`.toLowerCase() === modelId.toLowerCase())
                ) || null;
                if (!modelName && matchedModel && matchedModel.name) {
                    modelName = matchedModel.name;
                }
            }
        } catch (_) {}
    }
    if (!modelName) {
        modelName = modelId.split('::').pop().trim();
    }

    // 2. Resolve Settings & Params
    const timeoutSetting = Number(await getSetting('timeoutMs', 120000));
    const TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting : 120000;
    const responseFormat = String(args.response_format || 'text').trim();
    const outputMode = String(args.output_mode || 'stdout').trim();

    // 3. Read Audio File
    const bytes = await api.readFileBytes(fp);
    if (typeof bytes === 'string') {
        return fail(api, fp, bytes); // Passthrough "ERROR: ..."
    }
    const size = bytes.length;
    const sizeStr = humanSize(size);

    // 4. Prepare Payload for Multipart
    // We send the raw Uint8Array. The host's callModel(..., { multipart: true }) 
    // will wrap this in a Blob and send it as multipart/form-data.
    const payload = {
        file: bytes,
        response_format: responseFormat
    };
    if (args.language) payload.language = args.language;
    if (args.prompt) payload.prompt = args.prompt;
    if (typeof args.temperature === 'number') payload.temperature = args.temperature;

    // 6. Live UI Progress
    await updateStatus(`Transcribing ${fp} using ${modelName}...`);
    const startTime = Date.now();
    let isFinished = false;

    const progressTimer = setInterval(async () => {
        if (isFinished) return;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        updateStatus(`Transcribing ${fp} (${elapsed}s)...`);
        try {
            await api.showUI(renderWaitingCard({
                fp,
                format: responseFormat,
                language: args.language,
                size: sizeStr,
                model: modelName,
                elapsedSec: elapsed
            }), { live: true });
        } catch (_) {}
    }, 1000);

    // 7. Call Endpoint
    const primaryPath = '/v1/audio/transcriptions';
    const fallbackPath = '/audio/transcriptions';
    let res;
    try {
        res = await api.callModel(modelId, {
            path: primaryPath,
            body: payload,
            multipart: true,
            timeoutMs: TIMEOUT_MS
        });

        if (res && res.status === 404) {
            res = await api.callModel(modelId, {
                path: fallbackPath,
                body: payload,
                multipart: true,
                timeoutMs: TIMEOUT_MS
            });
        }
    } catch (e) {
        clearInterval(progressTimer);
        return fail(api, fp, `Model call threw exception: ${e.message}`);
    } finally {
        isFinished = true;
        clearInterval(progressTimer);
    }

    const elapsedSec = (Date.now() - startTime) / 1000;

    if (!res || res.error) {
        const err = res && res.error;
        if (err === 'timeout') return fail(api, fp, `Transcription timed out after ${TIMEOUT_MS / 1000}s.`);
        if (err === 'unreachable') return fail(api, fp, "Could not reach the server. Verify that your Whisper endpoint is running.");
        return fail(api, fp, `Model call failed: ${err || 'unknown error'}`);
    }

    if (!res.ok) {
        let detail = res.text || '';
        try {
            const errObj = JSON.parse(res.text);
            detail = errObj.error?.message || errObj.detail || errObj.error || res.text;
        } catch (_) {}
        
        if ((res.status === 400 || res.status === 415) && (detail.includes('multipart') || detail.includes('form-data'))) {
            detail += " (This endpoint may require multipart/form-data, which this tool sends as base64-JSON for compatibility).";
        }
        return fail(api, fp, `Server returned HTTP ${res.status}: ${detail}`);
    }

    // 8. Parse Transcript
    let transcript = '';
    let duration = null;
    let language = args.language;

    try {
        const j = JSON.parse(res.text);
        if (typeof j === 'object' && j !== null) {
            transcript = j.text ?? (Array.isArray(j.segments) ? j.segments.map(s => s.text).join('') : '');
            duration = j.duration;
            language = j.language || language;
        } else {
            transcript = String(j).trim();
        }
    } catch (_) {
        transcript = res.text.trim();
    }

    if (!transcript) {
        return fail(api, fp, `Server returned empty transcription. Body: ${res.text.slice(0, 200)}`);
    }

    // 9. Output Destination
    let savedFp = args.output_filepath;
    if (outputMode === 'file' || outputMode === 'both') {
        const FORMAT_EXT = { json: 'json', verbose_json: 'json', text: 'txt', srt: 'srt', vtt: 'vtt' };
        const ext = FORMAT_EXT[responseFormat] || 'txt';
        if (!savedFp) {
            const base = String(fp).split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '');
            const dir = String(fp).split('/').slice(0, -1).join('/');
            savedFp = dir ? `${dir}/${base}.${ext}` : `${base}.${ext}`;
        }
        const writeError = await api.writeFile(savedFp, transcript + '\n');
        if (writeError) {
            return fail(api, fp, `Failed to save transcript to ${savedFp}: ${writeError}`);
        }
    }

    // 10. Final UI
    const charCount = transcript.length;
    const wordCount = transcript.split(/\s+/).filter(Boolean).length;
    const preview = transcript.substring(0, 500);

    await updateStatus(`Transcription complete (${elapsedSec.toFixed(1)}s)`);
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderFinalCard({
                fp,
                outFp: savedFp,
                format: responseFormat,
                language,
                duration,
                elapsedSec,
                charCount,
                wordCount,
                preview
            }));
        } catch (_) {}
    }

    // 11. Return Value
    if (outputMode === 'file') {
        return {
            output: `Transcript saved to ${savedFp}. (${charCount} chars / ${wordCount} words)`,
            summary: `${fp} → ${savedFp} (${elapsedSec.toFixed(1)}s)`
        };
    }
    if (outputMode === 'both') {
        return {
            output: `Transcript saved to ${savedFp}. (${charCount} chars / ${wordCount} words)\n\n${transcript}`,
            summary: `${fp} → ${savedFp} (${elapsedSec.toFixed(1)}s)`
        };
    }
    return {
        output: transcript,
        summary: `${fp} → transcript (${elapsedSec.toFixed(1)}s)`
    };
}
