// speech_to_text - tool definition for OpenAI-compatible Whisper endpoints (/v1/audio/transcriptions).
// MOCK VERSION for diagnosing SyntaxErrors.
const TOOL_META = {
    "name": "speech_to_text",
    "description": "Transcribes an audio file to text using an OpenAI-compatible Whisper endpoint. Supports common audio formats (mp3, wav, flac, m4a, ogg).",
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
                "description": "Optional model ID/alias (e.g., 'whisper-1'). Overrides the configured setting."
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
            <div class="tool-ui-error-msg" style="font-family:var(--font-mono); white-space:pre-wrap;">
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
    const truncated = transcript.length > 800 ? transcript.slice(0, 800) + '... (truncated for UI)' : transcript;

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

    // 1. Diagnostics wrapper initialization
    let diagnostics = [];
    const logDiag = (msg) => diagnostics.push(`[${new Date().toISOString()}] ${msg}`);
    logDiag(`Started speech_to_text for ${fp}`);

    // 2. Resolve Settings & Model
    const getSetting = async (k, d) => {
        if (typeof api?.getSetting !== 'function') return d;
        const v = await api.getSetting(k);
        return (v === undefined || v === null || v === '') ? d : v;
    };

    const modelId = String(await getSetting('audioModel', '')).trim();
    if (!modelId) {
        return fail(api, fp, "No Audio Model selected. Pick your model in Settings > Tools > speech_to_text > Audio Model.");
    }

    let modelName = String(args.model || '').trim();
    logDiag(`Resolved model ID: ${modelId}, Name: ${modelName || 'default'}`);

    // 3. Read Audio Bytes
    await updateStatus(`Reading audio file: ${fp}...`);
    logDiag(`Attempting to read file bytes...`);
    const audioBytes = await api.readFileBytes(fp);
    
    if (typeof audioBytes === 'string') {
        logDiag(`Failed to read file. Return value was a string: ${audioBytes}`);
        return fail(api, fp, audioBytes);
    }
    if (!audioBytes || audioBytes.length === 0) {
        logDiag(`Read empty byte array for file.`);
        return fail(api, fp, "The audio file is empty or could not be read.");
    }
    logDiag(`Successfully read ${audioBytes.length} bytes.`);

    // 4. MOCK API CALL
    const filename = fp.split('/').pop() || 'audio.mp3';
    logDiag(`ENTERING MOCK MODE. Bypassing multipart construction and network request.`);

    // Show initial live UI card
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderWaitingCard({ fp, model: modelName, elapsedSec: 0 }), { live: true });
        } catch (_) {}
    }

    await updateStatus(`[MOCK] Transcribing with ${modelName || 'selected model'}...`);

    const startTime = Date.now();
    
    // Simulate a 3-second delay
    for (let i = 1; i <= 3; i++) {
        await new Promise(r => setTimeout(r, 1000));
        logDiag(`Mock progress: ${i}s elapsed`);
        if (typeof api?.showUI === 'function') {
            try {
                await api.showUI(renderWaitingCard({ fp, model: modelName, elapsedSec: i }), { live: true });
            } catch (_) {}
        }
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    logDiag(`Mock processing completed in ${elapsedSec}s.`);

    // 5. Mock Validate Response
    const mockTranscript = "This is a mocked transcription. If you see this, the file parsed and executed successfully without hitting a SyntaxError during initialization. The issue likely resides in how the host handles string evaluation for network logic or multipart construction.";
    
    logDiag(`Mock transcript generated successfully.`);
    await updateStatus(`Transcribed ${filename} (${elapsedSec.toFixed(1)}s)`);

    // 6. Render Final UI
    if (typeof api?.showUI === 'function') {
        try {
            await api.showUI(renderFinalCard({
                fp,
                transcript: mockTranscript,
                elapsedSec,
                model: modelName
            }));
        } catch (_) {}
    }

    // 7. Return to LLM Context
    return {
        output: `Transcription of ${fp} (${modelName}):\n\n${mockTranscript}\n\nDiagnostics:\n${diagnostics.join('\n')}`,
        summary: `Transcribed ${fp} (MOCKED)`
    };
}