// --- abortToolRunsForSession.js ---
// [AST_MERGED]: ./js/worker.js

// Patch for visual tools disappearing when "Show code previews" is disabled
if (typeof document !== 'undefined' && !document.getElementById('fix-tool-ui-wrap')) {
    const style = document.createElement('style');
    style.id = 'fix-tool-ui-wrap';
    style.textContent = `body.hide-code-preview .tool-ui-wrap { display: block !important; }`;
    document.head.appendChild(style);
}

function abortToolRunsForSession(sid, reason = 'Aborted by user') {
    const mine = [...toolWorkerPending].filter(([, e]) => e.sessionId === sid);
    if (!mine.length) return;

    for (const [runId, e] of mine) {
        toolWorkerPending.delete(runId);        // later api calls from the dead run get refused
        clearTimeout(e.timeoutId);
        try { e.abortCtrl && e.abortCtrl.abort(); } catch (_) {}   // cancels host-side fetches
        if (e.box) e.box.dataset.aborted = 'true';
        e.reject(Object.assign(new Error(reason), { aborted: true }));
    }

    // One shared worker: other sessions' runs die with it, so fail them cleanly instead of hanging.
    for (const [runId, e] of [...toolWorkerPending]) {
        toolWorkerPending.delete(runId);
        clearTimeout(e.timeoutId);
        try { e.abortCtrl && e.abortCtrl.abort(); } catch (_) {}
        if (e.box) e.box.dataset.aborted = 'true';
        e.reject(new Error('Tool worker was restarted because another session was stopped. Please retry.'));
    }

    toolWorkerOutbox.length = 0;                // don't replay queued runs into the next worker
    if (toolWorker) toolWorker.terminate();     // kills JS, Pyodide, everything
    reapDeadPendingUI();
}

// --- AST_EXPORTS_START ---
window.abortToolRunsForSession = abortToolRunsForSession;
// --- AST_EXPORTS_END ---

// --- buildToolErrorTooltip.js ---
function buildToolErrorTooltip(iconEl, detail) {
    const tip = getSharedToolErrorTip();
    const d = truncateFailureDetail(detail);
    iconEl.addEventListener('mouseenter', () => {
        tip.textContent = d || '(no details)';
        const r = iconEl.getBoundingClientRect();
        tip.style.left = '0px';
        tip.style.top = '0px';
        tip.classList.add('visible');
        const w = tip.offsetWidth, h = tip.offsetHeight;
        let left = r.right - w + 4;
        let top = r.bottom + 4;
        if (left < 12) left = 12;
        if (top + h > window.innerHeight - 12) top = window.innerHeight - h - 12;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    });
    iconEl.addEventListener('mouseleave', () => {
        tip.classList.remove('visible');
    });
}

// --- AST_EXPORTS_START ---
window.buildToolErrorTooltip = buildToolErrorTooltip;
// --- AST_EXPORTS_END ---

// --- describeToolAction.js ---
function describeToolAction(name, args) {
    args = args || {};
    switch (name) {
        case 'read': return `Read ${args.filepath || ''}`;
        case 'edit': return `Edit ${args.filepath || ''}`;
        case 'write': return `Write ${args.filepath || ''}`;
        case 'grep': return `Search pattern "${args.pattern || ''}"`;
        case 'find': return `Find files "${args.pattern || ''}"`;
        case 'rename': return `Rename ${args.filepath || ''} to ${args.new_name || ''}`;
        case 'PreviewImage': {
            const hasCrop = [args.x, args.y, args.width, args.height].some(v => v !== undefined && v !== null);
            return `Preview ${args.filepath || ''}${hasCrop ? ` (region ${args.x || 0},${args.y || 0} ${args.width || '?'}x${args.height || '?'})` : ''}`;
        }
        default: {
            const preview = summarizeToolArgs(args);
            return `Run ${name}${preview ? `: ${preview}` : ''}`;
        }
    }
}

// --- AST_EXPORTS_START ---
window.describeToolAction = describeToolAction;
// --- AST_EXPORTS_END ---

// --- executeTool.js ---
async function executeTool(name, args, sessionId, runningBox) {
    const tool = toolRegistry[name];
    if (!tool) {
        const output = `ERROR: Unknown tool ${name}`;
        return { output, summary: summarizeToolError(output) };
    }
    if (tool.error) {
        const output = `ERROR: Tool "${name}" is broken: ${tool.error}`;
        return { output, summary: summarizeToolError(output) };
    }

    // Defense in depth: such tools aren't offered to text-only models, but a model can still
    // hallucinate a call (or the model may have been switched while a call was in flight).
    if (!isToolAvailableForVision(tool)) {
        const output = `ERROR: Tool "${name}" requires a vision-capable model, but the selected model does not support vision.`;
        return { output, summary: summarizeToolError(output) };
    }

    const perm = await checkPermission(name, describeToolAction(name, args), sessionId);
    if (!perm.allowed) {
        const output = `ERROR: ${perm.error}`;
        return { output, summary: summarizeToolError(output) };
    }

    try {
        const result = await runToolInWorker(name, tool, args, sessionId, runningBox);
        const output = result.output === undefined ? '(no output)' : String(result.output);
        const out = { output };
        if (result.displayHtml) out.displayHtml = result.displayHtml;
        if (result.summary) out.summary = result.summary;
        else if (output.startsWith('ERROR:')) out.summary = summarizeToolError(output);
        if (result.image) out.__imageDataUrl = result.image;
        return out;
    } catch(e) {
        const output = `ERROR: Tool "${name}" failed: ${e.message}`;
        return { output, summary: summarizeToolError(output) };
    }
}

// --- AST_EXPORTS_START ---
window.executeTool = executeTool;
// --- AST_EXPORTS_END ---

// --- extractPartialJSONStringField.js ---
function extractPartialJSONStringField(partialJson, fieldName) {
    if (!partialJson) return null;
    const keyPat = `"${fieldName}"`;
    const keyIdx = partialJson.indexOf(keyPat);
    if (keyIdx === -1) return null;

    let i = keyIdx + keyPat.length;
    while (i < partialJson.length && partialJson[i] !== ':') i++;
    if (i >= partialJson.length) return null;
    i++;
    while (i < partialJson.length && /\s/.test(partialJson[i])) i++;
    if (i >= partialJson.length || partialJson[i] !== '"') return null;
    i++;

    let out = '';
    while (i < partialJson.length) {
        const ch = partialJson[i];
        if (ch === '"') {
            return out;
        }
        if (ch === '\\') {
            const next = partialJson[i + 1];
            if (next === undefined) {
                return out;
            }
            switch (next) {
                case 'n': out += '\n'; i += 2; break;
                case 't': out += '\t'; i += 2; break;
                case 'r': out += '\r'; i += 2; break;
                case '"': out += '"'; i += 2; break;
                case '\\': out += '\\'; i += 2; break;
                case '/': out += '/'; i += 2; break;
                case 'b': out += '\b'; i += 2; break;
                case 'f': out += '\f'; i += 2; break;
                case 'u': {
                    const hex = partialJson.slice(i + 2, i + 6);
                    if (hex.length < 4) return out;
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 6;
                    break;
                }
                default:
                    out += next; i += 2; break;
            }
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

// --- AST_EXPORTS_START ---
window.extractPartialJSONStringField = extractPartialJSONStringField;
// --- AST_EXPORTS_END ---

// --- getSharedToolErrorTip.js ---
function getSharedToolErrorTip() {
    if (_sharedToolErrorTip) return _sharedToolErrorTip;
    const tip = document.createElement('div');
    tip.className = 'tool-error-tooltip';
    document.body.appendChild(tip);
    _sharedToolErrorTip = tip;
    return tip;
}

// --- AST_EXPORTS_START ---
window.getSharedToolErrorTip = getSharedToolErrorTip;
// --- AST_EXPORTS_END ---

// --- getToolTimeoutMs.js ---
function getToolTimeoutMs() {
    const sec = parseInt(AppConfig.get('tool-timeout', '120'), 10);
    if (!Number.isFinite(sec) || sec <= 0) return TOOL_TIMEOUT_DEFAULT_MS;
    return Math.min(Math.max(sec, 5), 3600) * 1000;
}

// --- AST_EXPORTS_START ---
window.getToolTimeoutMs = getToolTimeoutMs;
// --- AST_EXPORTS_END ---

// --- liveRenderToolBody.js ---
// Streams a transient HTML frame into a RUNNING tool box (api.showUI(html, {live:true})).
// The frame is never stored: the tool's final displayHtml replaces it when the run ends.
// Elements marked data-live-scroll keep their scroll position, or stay pinned to the bottom if they were there.
function liveRenderToolBody(entry, html) {
    if (window.AppConfig && window.AppConfig.get('show-code-preview', 'true') === 'false') {
        const tName = entry && entry.toolName;
        if (tName && ['read', 'edit', 'write', 'grep', 'find', 'rename'].includes(tName)) return;
    }
    const box = entry && entry.box;
    if (!box || !box.isConnected || !box.classList.contains('running-tool-box')) return;
    const body = box.querySelector('.tool-box-body');
    if (!body) return;
    const prev = [...body.querySelectorAll('[data-live-scroll]')].map(el => ({
        top: el.scrollTop,
        pinned: el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }));
    body.innerHTML = normalizeBlockHTML(String(html));
    body.querySelectorAll('[data-live-scroll]').forEach((el, i) => {
        const st = prev[i];
        el.scrollTop = (!st || st.pinned) ? el.scrollHeight : st.top;
    });
    smartScroll();
}

// --- AST_EXPORTS_START ---
window.liveRenderToolBody = liveRenderToolBody;
// --- AST_EXPORTS_END ---

// --- markToolGroupFailed.js ---
function markToolGroupFailed(container, toolName, detail) {
    if (!container) return;
    const header = container.querySelector('.tool-group-header');
    if (!header) return;
    if (!container.classList.contains('failed')) container.classList.add('failed');
    const failures = container._toolGroupFailures || (container._toolGroupFailures = []);
    failures.push({ tool: toolName || 'tool', detail: truncateFailureDetail(detail) });

    let indicator = header.querySelector('.tool-group-fail-indicator');
    if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'icon tool-group-fail-indicator';
        indicator.textContent = 'error';
        header.appendChild(indicator);
        indicator.addEventListener('mouseenter', () => {
            const tip = indicator.querySelector('.tool-group-fail-tooltip');
            if (tip) tip.classList.add('visible');
        });
        indicator.addEventListener('mouseleave', () => {
            const tip = indicator.querySelector('.tool-group-fail-tooltip');
            if (tip) tip.classList.remove('visible');
        });
    }

    let itemsHtml = '';
    failures.forEach(f => {
        itemsHtml += `<div class="tip-item"><span class="tip-tool-name">${escapeHTML(f.tool)}</span> ${escapeHTML(f.detail || '(no details)')}</div>`;
    });
    const oldTip = indicator.querySelector('.tool-group-fail-tooltip');
    if (oldTip) oldTip.remove();
    indicator.insertAdjacentHTML('beforeend', `<div class="tool-group-fail-tooltip">${itemsHtml}</div>`);
}

// --- AST_EXPORTS_START ---
window.markToolGroupFailed = markToolGroupFailed;
// --- AST_EXPORTS_END ---

// --- rehydrateToolErrorTooltips.js ---
function rehydrateToolErrorTooltips() {
    document.querySelectorAll('.tool-box.error-box').forEach(box => {
        const iconEl = box.querySelector('.tool-error-icon');
        if (!iconEl || iconEl._tipRehydrated) return;
        const outEl = box.querySelector('.tool-box-body .tool-output-text');
        let detail = outEl ? outEl.textContent : '';
        detail = detail.replace(/^\s*\[result\]\s*/i, '');
        iconEl._tipRehydrated = true;
        buildToolErrorTooltip(iconEl, detail);
    });
    document.querySelectorAll('.tool-group.failed .tool-group-fail-indicator').forEach(indicator => {
        if (indicator._tipRehydrated) return;
        indicator._tipRehydrated = true;
        indicator.addEventListener('mouseenter', () => {
            const tip = indicator.querySelector('.tool-group-fail-tooltip');
            if (tip) tip.classList.add('visible');
        });
        indicator.addEventListener('mouseleave', () => {
            const tip = indicator.querySelector('.tool-group-fail-tooltip');
            if (tip) tip.classList.remove('visible');
        });
    });
}

// --- AST_EXPORTS_START ---
window.rehydrateToolErrorTooltips = rehydrateToolErrorTooltips;
// --- AST_EXPORTS_END ---

// --- renderPendingToolPreview.js ---
function renderPendingToolPreview(toolBuffer, sessionId) {
    const sid = sessionId || state.activeSessionId;
    if (sid !== state.activeSessionId) return;
    const entries = Object.values(toolBuffer).filter(t => t.name);
    if (!entries.length) return;

    const last = entries[entries.length - 1];
    const rawArgs = last.args || '';

    let preview = extractPartialJSONStringField(rawArgs, 'content');
    if (preview === null) preview = extractPartialJSONStringField(rawArgs, 'replace_block');
    if (preview === null) preview = extractPartialJSONStringField(rawArgs, 'code');
    if (preview === null) preview = extractPartialJSONStringField(rawArgs, 'command');
    if (preview === null) preview = rawArgs;
    if (!preview) return;

    const lastLine = preview.trim().split('\n').pop();
    if (lastLine) updateSpinnerText(`${last.name}: ${lastLine}`, sid);
}

// --- AST_EXPORTS_START ---
window.renderPendingToolPreview = renderPendingToolPreview;
// --- AST_EXPORTS_END ---

// --- renderRunningToolBox.js ---
function renderRunningToolBox(toolName, args, container = null, sessionId) {
    const sid = sessionId || state.activeSessionId;
    if (sid !== state.activeSessionId) return null;

    const box = document.createElement('div');
    box.className = 'tool-box done-box running-tool-box';

    let summaryText = "";


    const isBuiltinBadge = ['read', 'edit', 'write', 'grep', 'find', 'rename'].includes(toolName);

    box.innerHTML = normalizeBlockHTML(`
        <div class="tool-box-header" style="cursor:default;">
            <span class="icon icon-chevron">expand_more</span>
            ${toolIOIndicatorHTML(toolName)}
            <span class="tool-badge ${isBuiltinBadge ? toolName : 'custom-tool'}">${escapeHTML(toolName)}</span>
            <span class="tool-summary">${escapeHTML(summaryText)}</span>
            <span class="spinner-icon running-tool-spinner" style="font-size:12px; margin-left:auto;">${frames[0]}</span>
            <span class="dim running-tool-label" style="font-size:11px;">running...</span>
        </div>
        <div class="tool-box-body"></div>
    `);

    const gen = getGenState(sid);
    const target = container ? (container.querySelector('.tool-group-body') || container) : term;
    if (!container && gen.spinEl && gen.spinEl.parentNode === term) {
        term.insertBefore(box, gen.spinEl);
    } else {
        target.appendChild(box);
    }

    const spinnerGlyph = box.querySelector('.running-tool-spinner');
    let runningFrame = 0;
    box._runningSpinnerInterval = setInterval(() => {
        if (!spinnerGlyph || !spinnerGlyph.isConnected) {
            clearInterval(box._runningSpinnerInterval);
            return;
        }
        runningFrame = (runningFrame + 1) % frames.length;
        spinnerGlyph.innerText = frames[runningFrame];
    }, 80);

    reorderSpinnerToBottom(sid);
    smartScroll();
    return box;
}

// --- AST_EXPORTS_START ---
window.renderRunningToolBox = renderRunningToolBox;
// --- AST_EXPORTS_END ---

// --- renderToolCallBox.js ---
function renderToolCallBox(toolName, args, resultOutput, isDone = false, isError = false, container = null, existingBox = null, sessionId, displayHtml = null, customSummary = null) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    stopRunningToolBox(existingBox);
    const box = existingBox || document.createElement('div');
    const isExpanded = isDone;
    box.className = `tool-box ${isExpanded ? 'done-box' : 'collapsed'} ${isError ? 'error-box' : ''}`;

    // A tool can set the header live (setHeaderMsg) and/or return a final summary;
    // either wins over the host's arg-based fallback.
    let summaryText = typeof customSummary === 'string' && customSummary
        ? customSummary
        : (isError ? (summarizeToolError(resultOutput) || "") : "");

    if (window.AppConfig && window.AppConfig.get('show-code-preview', 'true') === 'false') {
        if (['read', 'edit', 'write', 'grep', 'find', 'rename'].includes(toolName)) {
            displayHtml = null;
        }
    }

    let innerContentHTML = '';

    if (displayHtml) {
        // Rich UI-only markup (e.g. HTML/image previews). This is never what was sent to
        // the model as the tool result — that's resultOutput, kept separate on purpose so
        // large rendered payloads don't get fed back into context.
        innerContentHTML = displayHtml;
    } else {
        innerContentHTML = `
            <div class="tool-output-text${isError ? ' error-output-text' : ''}">${escapeHTML(resultOutput || '(empty response)')}</div>
        `;
    }

    const statusIcon = isError ? 'error' : 'check';
    const statusColor = isError ? 'var(--red)' : 'var(--dim)';
    const isBuiltinBadge = ['read', 'edit', 'write', 'grep', 'find', 'rename'].includes(toolName);

    box.innerHTML = normalizeBlockHTML(`
        <div class="tool-box-header">
            <span class="icon icon-chevron">expand_more</span>
            ${toolIOIndicatorHTML(toolName)}
            <span class="tool-badge ${isBuiltinBadge ? toolName : 'custom-tool'}">${escapeHTML(toolName)}</span>
            <span class="tool-summary">${escapeHTML(summaryText)}</span>
            <span class="icon ${isError ? 'tool-error-icon' : ''}" style="font-size:14px; color:${statusColor}; margin-left:auto;">${statusIcon}</span>
        </div>
        <div class="tool-box-body">
            ${innerContentHTML}
        </div>
    `);
    if (isError) {
        const iconEl = box.querySelector('.tool-error-icon');
        if (iconEl) buildToolErrorTooltip(iconEl, resultOutput);
    }

    const target = container ? (container.querySelector('.tool-group-body') || container) : term;
    if (existingBox && existingBox.isConnected) {
    } else if (!container && gen.spinEl && gen.spinEl.parentNode === term) {
        term.insertBefore(box, gen.spinEl);
    } else {
        target.appendChild(box);
    }
    box.querySelectorAll('.tool-output-text').forEach(el => { el.scrollTop = el.scrollHeight; });
    reorderSpinnerToBottom(sid);
    smartScroll();
    return box;
}

// --- AST_EXPORTS_START ---
window.renderToolCallBox = renderToolCallBox;
// --- AST_EXPORTS_END ---

// --- safeRenderToolCallBox.js ---
function safeRenderToolCallBox(toolName, args, resultOutput, isDone = false, isError = false, container = null, existingBox = null, sessionId, displayHtml = null, customSummary = null) {
    if (window.AppConfig && window.AppConfig.get('show-code-preview', 'true') === 'false') {
        if (['read', 'edit', 'write', 'grep', 'find', 'rename'].includes(toolName)) {
            displayHtml = null;
        }
    }
    const sid = sessionId || state.activeSessionId;
    if (sid !== state.activeSessionId) {
        const isBuiltinBadge = ['read', 'edit', 'write', 'grep', 'find', 'rename'].includes(toolName);
        const errorIcon = isError ? '<span class="icon" style="font-size:14px; color:var(--red); margin-left:auto;">error</span>' : '';
        const fallbackSummary = typeof customSummary === 'string' && customSummary
            ? customSummary
            : (isError ? (summarizeToolError(resultOutput) || '') : JSON.stringify(args || {}).slice(0, 60));
        const html = `<div class="tool-box done-box ${isError ? 'error-box' : ''}">
            <div class="tool-box-header">
                <span class="icon icon-chevron">expand_more</span>
                ${toolIOIndicatorHTML(toolName)}
                <span class="tool-badge ${isBuiltinBadge ? toolName : 'custom-tool'}">${escapeHTML(toolName || 'tool')}</span>
                <span class="tool-summary">${escapeHTML(fallbackSummary)}</span>
                ${errorIcon}
            </div>
            <div class="tool-box-body">
                <div class="tool-output-text ${isError ? 'error-output-text' : ''}">${escapeHTML(String(resultOutput ?? '(no output)'))}</div>
            </div>
        </div>`;
        print(html, "", sid);
        return null;
    }
    try {
        return renderToolCallBox(toolName, args, resultOutput, isDone, isError, container, existingBox, sid, displayHtml, customSummary);
    } catch (renderErr) {
        console.error('renderToolCallBox failed, falling back to plain output:', renderErr);
        try {
            stopRunningToolBox(existingBox);
            const box = existingBox || document.createElement('div');
            box.className = `tool-box done-box ${isError ? 'error-box' : ''}`;
            box.innerHTML = normalizeBlockHTML(`
                <div class="tool-box-header">
                    <span class="icon icon-chevron">expand_more</span>
                    ${toolIOIndicatorHTML(toolName)}
                    <span class="tool-badge custom-tool">${escapeHTML(toolName || 'tool')}</span>
                    <span class="tool-summary">(display error)</span>
                    <span class="icon tool-error-icon" style="font-size:14px; color:var(--red); margin-left:auto;">error</span>
                </div>
                <div class="tool-box-body">
                    <div class="tool-output-text error-output-text">${escapeHTML(String(resultOutput ?? '(no output)'))}</div>
                </div>
            `);
            if (isError) {
                const iconEl = box.querySelector('.tool-error-icon');
                if (iconEl) buildToolErrorTooltip(iconEl, resultOutput);
            }
            if (!existingBox) {
                const gen = getGenState(sid);
                const target = container ? (container.querySelector('.tool-group-body') || container) : term;
                if (!container && gen.spinEl && gen.spinEl.parentNode === term) {
                    term.insertBefore(box, gen.spinEl);
                } else {
                    target.appendChild(box);
                }
            }
            return box;
        } catch (fallbackErr) {
            console.error('safeRenderToolCallBox fallback also failed:', fallbackErr);
            return null;
        }
    }
}

// --- AST_EXPORTS_START ---
window.safeRenderToolCallBox = safeRenderToolCallBox;
// --- AST_EXPORTS_END ---

// --- stopRunningToolBox.js ---
function stopRunningToolBox(box) {
    if (box && box._runningSpinnerInterval) {
        clearInterval(box._runningSpinnerInterval);
        box._runningSpinnerInterval = null;
    }
}

// --- AST_EXPORTS_START ---
window.stopRunningToolBox = stopRunningToolBox;
// --- AST_EXPORTS_END ---

// --- summarizeToolArgs.js ---
function summarizeToolArgs(args) {
    const firstVal = Object.values(args || {})[0];
    return typeof firstVal === 'string'
        ? firstVal.slice(0, 70)
        : JSON.stringify(args || {}).slice(0, 60);
}

// --- AST_EXPORTS_START ---
window.summarizeToolArgs = summarizeToolArgs;
// --- AST_EXPORTS_END ---

// --- summarizeToolError.js ---
// Turns a raw "ERROR: ..." output string into a short, header-friendly summary.
// Keeps the header from either duplicating the full body text verbatim or falling
// back to a generic arg dump when a tool actually failed.
function summarizeToolError(errText) {
    if (!errText) return null;
    const stripped = String(errText).replace(/^ERROR:\s*/i, '').trim();
    if (!stripped) return null;
    const firstLine = stripped.split('\n')[0];
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

// --- AST_EXPORTS_START ---
window.summarizeToolError = summarizeToolError;
// --- AST_EXPORTS_END ---

// --- truncateFailureDetail.js ---
function truncateFailureDetail(detail) {
    if (typeof detail !== 'string') return '';
    let s = detail.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

// --- AST_EXPORTS_START ---
window.truncateFailureDetail = truncateFailureDetail;
// --- AST_EXPORTS_END ---
