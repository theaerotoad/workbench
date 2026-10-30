// --- buildCompressionBoxHTML.js ---
function buildCompressionBoxHTML(entry) {
    const when = new Date(entry.ts).toLocaleString();

    const before = entry.approxTokensBefore || 0;
    const after = entry.approxTokensAfter || 0;
    let remainingPct = 100;
    if (before > 0) {
        remainingPct = Math.round((after / before) * 100);
    }
    remainingPct = Math.max(1, Math.min(99, remainingPct));

    const triggerLabel = entry.manual ? 'manual' : 'auto';
    const triggerIcon = entry.manual ? 'touch_app' : 'bolt';

    return `<div class="tool-box done-box compression-box collapsed">
        <div class="tool-box-header">
            <span class="icon icon-chevron">expand_more</span>
            <span class="tool-io-indicator io-mixed"><span class="icon">compress</span></span>
            <span class="tool-badge compress">compact</span>
            <span class="tool-summary">${entry.messagesCompressed} msgs → ~${remainingPct}% of original size</span>
            <span class="icon" style="font-size:14px; color:var(--dim); margin-left:auto;">check</span>
        </div>
        <div class="tool-box-body">
            <div class="compression-metrics">
                <span class="compression-metric"><span class="icon" style="font-size:12px;">history</span>${entry.messagesCompressed} compressed</span>
                <span class="compression-metric"><span class="icon" style="font-size:12px;">bookmark</span>${entry.messagesKept} kept</span>
                <span class="compression-metric"><span class="icon" style="font-size:12px;">trending_down</span>reduced to ~${remainingPct}%</span>
                <span class="compression-metric"><span class="icon" style="font-size:12px;">${triggerIcon}</span>${triggerLabel}</span>
                <span class="compression-metric dim"><span class="icon" style="font-size:12px;">schedule</span>${escapeHTML(when)}</span>
            </div>
            <div class="compression-summary-label">Summary</div>
            <div class="compression-summary md-content">${normalizeBlockHTML(formatMarkdownSnippet(entry.summary))}</div>
        </div>
    </div>`;
}

// --- AST_EXPORTS_START ---
window.buildCompressionBoxHTML = buildCompressionBoxHTML;
// --- AST_EXPORTS_END ---

// --- buildCompressionRunningHTML.js ---
function buildCompressionRunningHTML(meta) {
    const triggerLabel = meta.manual ? 'manual' : 'auto';
    const triggerIcon = meta.manual ? 'touch_app' : 'bolt';
    return `<div class="tool-box done-box compression-box running collapsed">
        <div class="tool-box-header" style="cursor:default;">
            <span class="icon icon-chevron">expand_more</span>
            <span class="tool-io-indicator io-mixed"><span class="icon">compress</span></span>
            <span class="tool-badge compress">compact</span>
            <span class="tool-summary">compressing ${meta.messagesCompressed} message${meta.messagesCompressed === 1 ? '' : 's'}…</span>
            <span class="icon" style="font-size:14px; color:var(--primary); margin-left:auto;">${triggerIcon}</span>
        </div>
        <div class="tool-box-body">
            <div class="compression-progress">
                <span class="spinner-icon">${frames[0]}</span>
                <span class="compression-progress-label">Summarizing earlier messages…</span>
                <span class="compression-progress-elapsed" style="margin-left:auto; color:var(--dim); font-family:var(--font-mono);">0.0s</span>
            </div>
            <div class="compression-metrics">
                <span class="compression-metric"><span class="icon" style="font-size:12px;">history</span>${meta.messagesCompressed} to compress</span>
                <span class="compression-metric"><span class="icon" style="font-size:12px;">bookmark</span>${meta.messagesKept} kept</span>
                <span class="compression-metric"><span class="icon" style="font-size:12px;">hourglass_top</span>estimating savings…</span>
                <span class="compression-metric"><span class="icon" style="font-size:12px;">${triggerIcon}</span>${triggerLabel}</span>
            </div>
        </div>
    </div>`;
}

// --- AST_EXPORTS_START ---
window.buildCompressionRunningHTML = buildCompressionRunningHTML;
// --- AST_EXPORTS_END ---

// --- buildContextFillIcon.js ---
function buildContextFillIcon(pct) {
    const clamped = Math.max(0, Math.min(1, pct));
    const r = 5;
    const c = 6;
    const circumference = 2 * Math.PI * r;
    const dashOffset = circumference * (1 - clamped);
    let ringColor = 'var(--dim)';
    if (clamped >= 0.9) ringColor = 'var(--red)';
    else if (clamped >= 0.7) ringColor = 'var(--yellow)';
    return `
        <svg width="12" height="12" viewBox="0 0 12 12" style="flex-shrink:0; transform:rotate(-90deg);">
            <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--border-highlight)" stroke-width="2"></circle>
            <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ringColor}" stroke-width="2"
                stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
                stroke-linecap="round" style="transition: stroke-dashoffset 0.2s ease, stroke 0.2s ease;"></circle>
        </svg>
    `;
}

// --- AST_EXPORTS_START ---
window.buildContextFillIcon = buildContextFillIcon;
// --- AST_EXPORTS_END ---

// --- compressContext.js ---
async function compressContext(sessionId, { silent = false, manual = false } = {}) {
    const sid = sessionId || state.activeSessionId;
    const ctx = sessionCtx(sid);
    if (ctx.deleted) return { ok: false, error: 'Session was deleted' };
    const isLive = sid === state.activeSessionId;

    const preserveCount = Math.max(1, parseInt(AppConfig.get('compress-preserve', '6'), 10) || 6);
    const msgs = ctx.messages;

    let splitIdx = Math.max(0, msgs.length - preserveCount);
    while (splitIdx < msgs.length) {
        const m = msgs[splitIdx];
        if (m.role === 'tool') { splitIdx++; continue; }
        break;
    }
    while (splitIdx > 0) {
        const prev = msgs[splitIdx - 1];
        if (prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length) {
            splitIdx--;
        } else {
            break;
        }
    }

    if (splitIdx <= 0) {
        if (!silent) return;
        return { ok: false, error: 'Nothing to compress' };
    }

    const older = msgs.slice(0, splitIdx);
    const recent = msgs.slice(splitIdx);

    const approxTokensBefore = estimateMessagesTokens(older);
    const startedAt = Date.now();

    const liveBox = renderCompressionRunningBox({
        manual: !!manual,
        messagesCompressed: older.length,
        messagesKept: recent.length,
        approxTokensBefore,
        startedAt
    }, sid);
    const liveTick = liveBox ? startCompressionRunningTick(liveBox, startedAt) : null;

    const transcript = serializeMessagesForCompression(older);

    const { url: apiUrl, model, key: apiKey } = getCurrentModelInfo();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = renderPromptTemplate(COMPRESS_PROMPT, { conversation: transcript });

    const gen = getGenState(sid);
    const compressController = new AbortController();
    gen.activeController = compressController;
    gen.compressionInFlight = true;
    if (sid === state.activeSessionId) { updatePromptSendButton(); updateGenGlow(); }

    let summaryText = '';
    try {
        const resp = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers,
            signal: compressController.signal,
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: 'You compress coding-agent conversations into dense, factual summaries.' },
                    { role: 'user', content: body }
                ],
                temperature: 0.2,
                stream: false
            })
        });
        if (!resp.ok) {
            const errJson = await resp.json().catch(() => ({}));
            throw new Error(errJson.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        summaryText = (data.choices?.[0]?.message?.content || '').trim();
        if (!summaryText) throw new Error('Empty summary returned');
    } catch (e) {
        const wasAborted = e.name === 'AbortError' || gen.retryCancelled;
        if (liveTick) clearInterval(liveTick);
        if (liveBox) {
            finalizeCompressionBoxError(liveBox, wasAborted ? 'Cancelled' : (e.message || String(e)), wasAborted);
        } else if (!silent) {
            showToast(wasAborted ? 'Compression cancelled' : `Compression failed: ${e.message}`, wasAborted ? 'info' : 'error');
        }
        return { ok: false, error: wasAborted ? 'Cancelled' : e.message, aborted: wasAborted };
    } finally {
        gen.compressionInFlight = false;
        if (gen.activeController === compressController) gen.activeController = null;
        if (sid === state.activeSessionId) { updatePromptSendButton(); updateGenGlow(); }
    }

    const summaryMsg = {
        role: 'user',
        content: `[COMPRESSED CONTEXT — summary of ${older.length} earlier messages]\n\n${summaryText}`
    };

    ctx.messages.length = 0;
    ctx.messages.push(summaryMsg, ...recent);

    if (!ctx.baseline.compressionHistory) ctx.baseline.compressionHistory = [];
    const entry = {
        ts: Date.now(),
        summary: summaryText,
        messagesCompressed: older.length,
        messagesKept: recent.length,
        manual: !!manual,
        approxTokensBefore: estimateMessagesTokens(older),
        approxTokensAfter: estimateStringTokens(summaryText)
    };
    ctx.baseline.compressionHistory.push(entry);
    if (ctx.baseline.compressionHistory.length > 25) ctx.baseline.compressionHistory.shift();

    if (liveTick) clearInterval(liveTick);
    if (liveBox) {
        finalizeCompressionBox(liveBox, entry);
    } else if (!isLive) {
        const s = state.sessions[sid];
        if (s) s.chatHTML = (s.chatHTML || '') + buildCompressionBoxHTML(entry);
    }

    if (state.sessions[sid]) {
        state.sessions[sid].messages = ctx.messages;
        if (isLive) state.messages = ctx.messages;
        state.sessions[sid]._compressionHistory = ctx.baseline.compressionHistory;
    }
    gen.hasNewContent = true;
    await saveSession(sid);

    gen.postCompressTokenOverride = estimateMessagesTokens(ctx.messages);

    return { ok: true, entry };
}

// --- AST_EXPORTS_START ---
window.compressContext = compressContext;
// --- AST_EXPORTS_END ---

// --- estimateCurrentContextTokens.js ---
function estimateCurrentContextTokens(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const s = state.sessions[sid];
    if (!s) return 0;
    const gen = getGenState(sid);
    if (gen.postCompressTokenOverride != null) {
        return gen.postCompressTokenOverride;
    }
    if (s.lastTokenUsage && s.lastTokenUsage.total_tokens) {
        return s.lastTokenUsage.total_tokens;
    }
    const ctx = sessionCtx(sid);
    return estimateMessagesTokens(ctx.messages);
}

// --- AST_EXPORTS_START ---
window.estimateCurrentContextTokens = estimateCurrentContextTokens;
// --- AST_EXPORTS_END ---

// --- estimateMessagesTokens.js ---
function estimateMessagesTokens(msgs) {
    let total = 0;
    for (const m of msgs) {
        if (!m) continue;
        if (typeof m.content === 'string') total += estimateStringTokens(m.content);
        else if (Array.isArray(m.content)) {
            for (const c of m.content) {
                if (c.type === 'text') total += estimateStringTokens(c.text);
                else total += 256;
            }
        }
        if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                total += estimateStringTokens(tc.function?.arguments || '');
                total += estimateStringTokens(tc.function?.name || '');
            }
        }
        total += 4;
    }
    return total;
}

// --- AST_EXPORTS_START ---
window.estimateMessagesTokens = estimateMessagesTokens;
// --- AST_EXPORTS_END ---

// --- estimateStringTokens.js ---
function estimateStringTokens(s) {
    if (!s) return 0;
    return Math.max(1, Math.round(String(s).length / 4));
}

// --- AST_EXPORTS_START ---
window.estimateStringTokens = estimateStringTokens;
// --- AST_EXPORTS_END ---

// --- finalizeCompressionBox.js ---
function finalizeCompressionBox(wrapper, entry) {
    if (!wrapper || !wrapper.isConnected) return;
    wrapper.innerHTML = buildCompressionBoxHTML(entry);
    smartScroll();
}

// --- AST_EXPORTS_START ---
window.finalizeCompressionBox = finalizeCompressionBox;
// --- AST_EXPORTS_END ---

// --- finalizeCompressionBoxError.js ---
function finalizeCompressionBoxError(wrapper, message, cancelled) {
    if (!wrapper || !wrapper.isConnected) return;
    wrapper.innerHTML = `<div class="tool-box done-box compression-box error-box${cancelled ? ' collapsed' : ''}">
        <div class="tool-box-header">
            <span class="icon icon-chevron">expand_more</span>
            <span class="tool-io-indicator io-mixed"><span class="icon">compress</span></span>
            <span class="tool-badge compress">compact</span>
            <span class="tool-summary">${cancelled ? 'Compression cancelled' : 'Compression failed'}</span>
            <span class="icon" style="font-size:14px; color:${cancelled ? 'var(--dim)' : 'var(--red)'}; margin-left:auto;">${cancelled ? 'cancel' : 'error'}</span>
        </div>
        <div class="tool-box-body">
            <div class="tool-output-text error-output-text">${escapeHTML(message)}</div>
        </div>
    </div>`;
    smartScroll();
}

// --- AST_EXPORTS_START ---
window.finalizeCompressionBoxError = finalizeCompressionBoxError;
// --- AST_EXPORTS_END ---

// --- formatCompactTokens.js ---
function formatCompactTokens(num) {
    if (!num || isNaN(num)) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(num);
}

// --- AST_EXPORTS_START ---
window.formatCompactTokens = formatCompactTokens;
// --- AST_EXPORTS_END ---

// --- maybeAutoCompress.js ---
async function maybeAutoCompress(sessionId) {
    if (AppConfig.get('compress-enabled', 'true') === 'false') return;
    const sid = sessionId || state.activeSessionId;
    const ctx = sessionCtx(sid);
    if (ctx.deleted) return;
    if (ctx.messages.length < 4) return;

    const thresholdPct = Math.max(10, Math.min(99, parseInt(AppConfig.get('compress-threshold', '75'), 10) || 75));
    const { contextWindow } = getCurrentModelInfo();
    const windowSize = contextWindow || DEFAULT_CONTEXT_WINDOW;

    const used = estimateCurrentContextTokens(sid);
    const pct = windowSize > 0 ? (used / windowSize) * 100 : 0;
    if (pct < thresholdPct) return;

    try {
        await compressContext(sid, { silent: false, manual: false });
    } catch (e) {
        console.warn('Auto-compress failed:', e);
    }
}

// --- AST_EXPORTS_START ---
window.maybeAutoCompress = maybeAutoCompress;
// --- AST_EXPORTS_END ---

// --- renderCompressionRunningBox.js ---
function renderCompressionRunningBox(meta, sessionId) {
    const sid = sessionId || state.activeSessionId;
    if (sid !== state.activeSessionId) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'log-entry';
    wrapper.innerHTML = buildCompressionRunningHTML(meta);

    const gen = getGenState(sid);
    if (gen.spinEl && gen.spinEl.parentNode === term) {
        term.insertBefore(wrapper, gen.spinEl);
    } else {
        term.appendChild(wrapper);
    }
    reorderSpinnerToBottom(sid);
    smartScroll();
    return wrapper;
}

// --- AST_EXPORTS_START ---
window.renderCompressionRunningBox = renderCompressionRunningBox;
// --- AST_EXPORTS_END ---

// --- serializeMessagesForCompression.js ---
function serializeMessagesForCompression(msgs) {
    const parts = [];
    for (const m of msgs) {
        if (!m) continue;
        let content = '';
        if (typeof m.content === 'string') {
            content = m.content;
        } else if (Array.isArray(m.content)) {
            content = m.content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join(' ');
        }
        if (m.role === 'user') {
            parts.push(`USER:\n${content}`);
        } else if (m.role === 'assistant') {
            let line = `ASSISTANT:\n${content || '(no text)'}`;
            if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
                const calls = m.tool_calls.map(tc => {
                    const fn = tc.function || {};
                    return `  -> ${fn.name}(${fn.arguments || ''})`;
                }).join('\n');
                line += `\n[TOOL CALLS]\n${calls}`;
            }
            parts.push(line);
        } else if (m.role === 'tool') {
            const trimmed = content.length > 800 ? content.slice(0, 800) + '…[truncated]' : content;
            parts.push(`TOOL RESULT (${m.name || '?'}):\n${trimmed}`);
        } else if (m.role === 'system') {
            parts.push(`SYSTEM:\n${content}`);
        }
    }
    return parts.join('\n\n');
}

// --- AST_EXPORTS_START ---
window.serializeMessagesForCompression = serializeMessagesForCompression;
// --- AST_EXPORTS_END ---

// --- startCompressionRunningTick.js ---
function startCompressionRunningTick(wrapper, startedAt) {
    const glyph = wrapper.querySelector('.compression-progress .spinner-icon');
    const elapsedEl = wrapper.querySelector('.compression-progress-elapsed');
    let f = 0;
    return setInterval(() => {
        if (!wrapper.isConnected) return;
        f = (f + 1) % frames.length;
        if (glyph) glyph.innerText = frames[f];
        if (elapsedEl) elapsedEl.innerText = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
    }, 90);
}

// --- AST_EXPORTS_START ---
window.startCompressionRunningTick = startCompressionRunningTick;
// --- AST_EXPORTS_END ---

// --- updateTokenStatus.js ---
function updateTokenStatus(usage) {
    const el = document.getElementById('status-tokens');
    const modelEl = document.getElementById('status-model');
    if (!usage) {
        el.style.display = 'none';
        modelEl.style.display = 'none';
        return;
    }
    const prompt = usage.prompt_tokens || usage.prompt_n || 0;
    const gen = usage.completion_tokens || usage.predicted_n || 0;
    const total = usage.total_tokens || (prompt + gen);
    const { url: apiUrl, model, key: apiKey, contextWindow: cw } = getCurrentModelInfo();
    const contextWindow = cw || DEFAULT_CONTEXT_WINDOW;
    const pct = contextWindow > 0 ? total / contextWindow : 0;

    el.style.display = 'inline-flex';
    el.innerHTML = `${buildContextFillIcon(pct)}<span>${formatCompactTokens(total)}</span>`;
    el.title = `Model: ${model || '?'} | Prompt: ${prompt.toLocaleString()} | Gen: ${gen.toLocaleString()} | Total: ${total.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${Math.round(pct * 100)}% of context)`;

    modelEl.style.display = 'inline-block';
    modelEl.innerText = shortenModelName(model) || '?';
    modelEl.title = model || '';

        fetchActiveModelName(apiUrl, apiKey, model).then(resolvedName => {
            if (!resolvedName || resolvedName === model) return;
            if (el.style.display !== 'inline-flex') return;
            el.title = `Model: ${resolvedName} | Prompt: ${prompt.toLocaleString()} | Gen: ${gen.toLocaleString()} | Total: ${total.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${Math.round(pct * 100)}% of context)`;
            modelEl.innerText = shortenModelName(resolvedName);
            modelEl.title = resolvedName;
        });
}

// --- AST_EXPORTS_START ---
window.updateTokenStatus = updateTokenStatus;
// --- AST_EXPORTS_END ---
