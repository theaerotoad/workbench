const TOOL_WORKER_SOURCE = `
"use strict";

let __reqId = 0;
const __pending = new Map();
function callApi(runId, method, args) {
    const id = ++__reqId;
    return new Promise((resolve, reject) => {
        __pending.set(id, { resolve, reject });
        self.postMessage({ type: 'api', id, runId, method, args });
    });
}
self.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'api-result') {
        const p = __pending.get(msg.id);
        if (!p) return;
        __pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.value);
    } else if (msg.type === 'run') {
        runTool(msg.runId, msg.toolMeta, msg.args);
    }
});

function cleanupText(text) {
    if (text === undefined) return '';
    let s = String(text);

    const sampleLen = Math.min(s.length, 4096);
    const sample = s.slice(0, sampleLen);
    const nullCount = (sample.match(/\\u0000/g) || []).length;
    const nonPrintableCount = (sample.match(/[^\\x09\\x0A\\x0D\\x20-\\x7E\\u00A0-\\uFFFF]/g) || []).length;
    const replacementCount = (sample.match(/\\uFFFD/g) || []).length;
    const looksBinary = sampleLen > 0 && (
        nullCount > 0 ||
        (nonPrintableCount / sampleLen) > 0.05 ||
        (replacementCount / sampleLen) > 0.02
    );
    if (looksBinary) {
        return '[binary content omitted: this file does not appear to be text]';
    }

    const MAX_LINE_CHARS = 2000;
    const MAX_TOTAL_CHARS = 100000;
    s = s.split('\\n').map(line => {
        if (line.length > MAX_LINE_CHARS) {
            return line.slice(0, MAX_LINE_CHARS) + \` […line truncated, \${line.length - MAX_LINE_CHARS} more chars]\`;
        }
        return line;
    }).join('\\n');
    if (s.length > MAX_TOTAL_CHARS) {
        s = s.slice(0, MAX_TOTAL_CHARS) + \`\\n\\n[…output truncated: \${s.length - MAX_TOTAL_CHARS} more characters omitted]\`;
    }

    return s.replace(/\\s+$/gm, '').replace(/\\n{3,}/g, '\\n\\n').trim();
}

async function runTool(runId, toolMeta, args) {
    // Per-run: the worker is shared by parallel tool calls, so this must not be module-level.
    let lastDisplayHtml = null;
    const api = {
        mode: toolMeta.mode,
        planFile: toolMeta.planFile,
        readFile: (fp) => callApi(runId, 'readFile', [fp]),
        readFileBytes: (fp) => callApi(runId, 'readFileBytes', [fp]),
        // Reads an image (path-safety checked) and returns it cropped/scaled: { dataUrl, width, height, sourceWidth, sourceHeight, crop } or { error }.
        readImage: (fp, crop) => callApi(runId, 'readImage', [fp, crop || {}]),
        writeFile: (fp, content) => callApi(runId, 'writeFile', [fp, content]),
        renameFile: (oldPath, newPath) => callApi(runId, 'renameFile', [oldPath, newPath]),
        listFiles: () => callApi(runId, 'listFiles', []),
        fileExists: (fp) => callApi(runId, 'fileExists', [fp]),
        isBinary: (fp) => callApi(runId, 'isBinary', [fp]),
        isSensitiveFile: (fp) => callApi(runId, 'isSensitiveFile', [fp]),
        cleanupText: (text) => cleanupText(text),
        getSetting: (key) => callApi(runId, 'getSetting', [key]),
        validateDisplayHtml: (html, opts) => callApi(runId, 'validateDisplayHtml', [html, opts || {}]),
        showUI: (html, opts) => {
            if (!(opts && opts.live)) lastDisplayHtml = String(html); // live frames are transient; last display call wins
            return callApi(runId, 'showUI', [String(html), opts || {}]);
        },
        // Live-updates the tool box header while the tool is still running.
        // Pass null/empty to clear back to the host's default. Never sent to the model.
        setHeaderMsg: (msg) => callApi(runId, 'setHeaderMsg', [msg == null ? '' : String(msg)]),
        // POST via the main page (the sandboxed tool frame has an opaque origin and cannot reach
        // loopback/LAN). Returns { ok, status, text } or { error }.
        httpPost: (url, opts) => callApi(runId, 'httpPost', [String(url), opts || {}]),
        // Lists models as [{ id: <uuid>, provider, name }]. No URL, key or connection details.
        listModels: () => callApi(runId, 'listModels', []),
        // Ion makes the request: it resolves the UUID to the model's URL/key, adds auth and the model
        // name, and returns { ok, status, text } or { error }. opts: { path, body, timeoutMs }.
        callModel: (id, opts) => callApi(runId, 'callModel', [String(id || ''), opts || {}])
    };
    try {
        const factory = new Function('args', 'api',
            toolMeta.code + '\\nreturn (typeof handler === "function") ? handler(args, api) : (() => { throw new Error("Tool file does not define an async function handler(args, api)."); })();'
        );
        const raw = await factory(args, api);

        let output, displayHtml = null, summary = null, image = null;
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'output' in raw) {
            output = raw.output === undefined ? '(no output)' : String(raw.output);
            // raw.displayHtml is deprecated (kept so existing tools keep working); prefer api.showUI().
            displayHtml = (typeof raw.displayHtml === 'string' && raw.displayHtml) ? raw.displayHtml : lastDisplayHtml;
            if (typeof raw.summary === 'string' && raw.summary.trim()) summary = raw.summary;
            // Optional image handed to a vision model alongside the text result (never shown as text).
            if (typeof raw.image === 'string' && raw.image.startsWith('data:image/')) image = raw.image;
        } else {
            output = raw === undefined ? '(no output)' : String(raw);
            displayHtml = lastDisplayHtml;
        }

        self.postMessage({ type: 'done', runId, output, displayHtml, summary, image });
    } catch (e) {
        self.postMessage({ type: 'done', runId, error: e.message || String(e) });
    }
}
`;

function getToolWorker() {
    if (toolWorker) return toolWorker;

    // 1. Sandboxed iframe => opaque origin => origin-scoped storage is unreachable.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts'); // NOTE: no allow-same-origin
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>
        let worker = null;
        window.addEventListener('message', (e) => {
            const m = e.data || {};
            if (m.type === 'tool-init') {
                const blob = new Blob([m.source], { type: 'application/javascript' });
                worker = new Worker(URL.createObjectURL(blob));
                worker.onmessage = (ev) => parent.postMessage({ tool: 'msg',  data: ev.data }, '*');
                worker.onerror   = (ev) => parent.postMessage({ tool: 'err',  message: ev.message }, '*');
                parent.postMessage({ tool: 'ready' }, '*');
            } else if (m.type === 'tool-post' && worker) {
                worker.postMessage(m.data);
            } else if (m.type === 'tool-kill' && worker) {
                worker.terminate(); worker = null;
            }
        });
    <\/script>`;
    document.body.appendChild(iframe);
    toolWorkerIframe = iframe;

    // 2. Route everything from the iframe into the existing message handler.
    window.addEventListener('message', (e) => {
        // Each worker spawn adds its own window listener and old ones are never removed: only accept messages from THIS worker's iframe, or every message is handled once per past spawn.
        if (e.source !== iframe.contentWindow || !e.data || !e.data.tool) return;
        if (e.data.tool === 'ready') {
            toolWorkerReady = true;
            for (const d of toolWorkerOutbox) iframe.contentWindow.postMessage({ type: 'tool-post', data: d }, '*');
            toolWorkerOutbox.length = 0;
            return;
        }
        if (e.data.tool === 'err') {
            for (const [, entry] of toolWorkerPending) {
                clearTimeout(entry.timeoutId);
                entry.reject(new Error(`Tool worker crashed: ${e.data.message || 'unknown error'}`));
            }
            toolWorkerPending.clear();
            reapDeadPendingUI();
            if (iframe.parentNode) iframe.remove();
            toolWorker = toolWorkerIframe = null;
            toolWorkerReady = false;
            return;
        }
        if (e.data.tool === 'msg') handleToolWorkerMessage(e.data.data);
    });

    // 3. Proxy that quacks like a Worker so nothing else in the file changes.
    toolWorker = {
        postMessage(data) {
            if (toolWorkerReady && iframe.contentWindow)
                iframe.contentWindow.postMessage({ type: 'tool-post', data }, '*');
            else
                toolWorkerOutbox.push(data);
        },
        terminate() {
            if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'tool-kill' }, '*');
            if (iframe.parentNode) iframe.remove();
            toolWorker = toolWorkerIframe = null;
            toolWorkerReady = false;
        }
    };

    // 4. Boot once the iframe document is ready.
    iframe.addEventListener('load', () => {
        iframe.contentWindow.postMessage({ type: 'tool-init', source: TOOL_WORKER_SOURCE }, '*');
    }, { once: true });

    return toolWorker;
}

function handleToolWorkerMessage(msg) {
    if (msg.type === 'api') {
        const entry = toolWorkerPending.get(msg.runId);
        const impl = TOOL_API_METHODS[msg.method];
        if (!impl || !entry) {
            toolWorker?.postMessage({ type: 'api-result', id: msg.id, error: `Unknown api method: ${msg.method}` });
            return;
        }
        (async () => {
            try {
                const value = await impl(entry.toolName, msg.args || [], entry.sessionId, entry);
                toolWorker?.postMessage({ type: 'api-result', id: msg.id, value });
            } catch (err) {
                toolWorker?.postMessage({ type: 'api-result', id: msg.id, error: err.message || String(err) });
            }
        })();
    } else if (msg.type === 'done') {
        const entry = toolWorkerPending.get(msg.runId);
        if (!entry) return;
        toolWorkerPending.delete(msg.runId);
        reapDeadPendingUI();
        clearTimeout(entry.timeoutId);
        if (msg.error) entry.reject(new Error(msg.error));
        else {
            const outputStr = msg.output === undefined ? '(no output)' : String(msg.output);
            const failed = outputStr.startsWith('ERROR:');
            entry.resolve({
                output: msg.output,
                displayHtml: msg.displayHtml || entry.displayHtml || null,
                summary: msg.summary || (failed ? null : entry.headerMsg) || null,
                image: msg.image || null
            });
        }
    }
}

function runToolInWorker(toolName, toolMeta, args, sessionId, runningBox) {
    const worker = getToolWorker();
    const runId = ++toolWorkerRunId;
    const timeoutMs = toolMeta.interactive ? Math.max(INTERACTIVE_TOOL_TIMEOUT_MS, getToolTimeoutMs()) : getToolTimeoutMs();
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            toolWorkerPending.delete(runId);
            reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000}s.`));
            if (toolWorker) { toolWorker.terminate(); toolWorker = null; }
            reapDeadPendingUI();
        }, timeoutMs);
        toolWorkerPending.set(runId, {
            resolve, reject, timeoutId, toolName,
            sessionId: sessionId || state.activeSessionId,
            box: runningBox || null,
            abortCtrl: new AbortController()
        });
        worker.postMessage({
            type: 'run',
            runId,
            toolMeta: { mode: state.mode, planFile: PLAN_FILE, code: toolMeta.code, toolName, interactive: !!toolMeta.interactive },
            args
        });
    });
}

// --- AST_EXPORTS_START ---
window.TOOL_WORKER_SOURCE = TOOL_WORKER_SOURCE;
window.getToolWorker = getToolWorker;
window.handleToolWorkerMessage = handleToolWorkerMessage;
window.runToolInWorker = runToolInWorker;
// --- AST_EXPORTS_END ---
