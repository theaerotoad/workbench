// --- clearRetryStatus.js ---
function clearRetryStatus(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (gen.retryStatusEl) {
        gen.retryStatusEl.remove();
        gen.retryStatusEl = null;
    }
    if (gen.retryStatusActive) {
        gen.retryStatusActive = false;
        if (sid === state.activeSessionId) updateGenGlow();
    }
}

// --- AST_EXPORTS_START ---
window.clearRetryStatus = clearRetryStatus;
// --- AST_EXPORTS_END ---

// --- ensureJumpBtn.js ---
function ensureJumpBtn() {
    if (!jumpBtn) {
        jumpBtn = document.createElement('button');
        jumpBtn.className = 'jump-to-bottom-btn';
        jumpBtn.innerHTML = '<span class="icon">arrow_downward</span>';
        jumpBtn.addEventListener('click', () => {
            term.scrollTop = term.scrollHeight;
            state.userScrolledUp = false;
        });
        document.getElementById('chat-container').appendChild(jumpBtn);
    }
    return jumpBtn;
}

// --- AST_EXPORTS_START ---
window.ensureJumpBtn = ensureJumpBtn;
// --- AST_EXPORTS_END ---

// --- forceScrollToBottomOnLoad.js ---
function forceScrollToBottomOnLoad() {
    state.userScrolledUp = false;
    if (jumpBtn) jumpBtn.style.display = 'none';
    const scrollNow = () => {
        programmaticScroll = true;
        term.scrollTop = term.scrollHeight;
        requestAnimationFrame(() => { programmaticScroll = false; });
    };
    scrollNow();
    requestAnimationFrame(scrollNow);
    requestAnimationFrame(() => requestAnimationFrame(scrollNow));
    setTimeout(scrollNow, 150);
}

// --- AST_EXPORTS_START ---
window.forceScrollToBottomOnLoad = forceScrollToBottomOnLoad;
// --- AST_EXPORTS_END ---

// --- hasScrollableOverflow.js ---
function hasScrollableOverflow() {
    return term.scrollHeight - term.clientHeight > 20;
}

// --- AST_EXPORTS_START ---
window.hasScrollableOverflow = hasScrollableOverflow;
// --- AST_EXPORTS_END ---

// --- persistChatHTML.js ---
// Persist the live chat HTML so UI-only state (e.g. expanded/collapsed tool
// boxes, thought boxes, tool groups) survives a reload even when no new
// message has been added since the toggle.
async function persistChatHTML(sessionId) {
    const id = sessionId || state.activeSessionId;
    const rec = state.sessions[id];
    if (!rec) return;
    rec.chatHTML = serializeTermHTML();
    rec.updatedAt = Date.now();
    const wsKey = getWorkspaceSessionKey();
    await patchSessionRecordInDB(wsKey, id, { chatHTML: rec.chatHTML, updatedAt: rec.updatedAt });
}

// --- AST_EXPORTS_START ---
window.persistChatHTML = persistChatHTML;
// --- AST_EXPORTS_END ---

// --- rebuildPromptRailTicks.js ---
// Rebuild all ticks from current .chat-prompt-wrap elements
function rebuildPromptRailTicks() {
    promptRailTicks.forEach(t => t.remove());
    promptRailTicks = [];
    const wraps = term.querySelectorAll('.chat-prompt-wrap');
    wraps.forEach(wrap => {
        const tick = document.createElement('div');
        tick.className = 'prompt-rail-tick';
        const rawText = wrap.getAttribute('data-raw') || '';
        const label = document.createElement('span');
        label.className = 'tick-label';
        label.textContent = rawText.slice(0, 80);
        tick.appendChild(label);
        const dot = document.createElement('span');
        dot.className = 'tick-dot';
        tick.appendChild(dot);
        tick.addEventListener('click', () => {
            const wrapRect = wrap.getBoundingClientRect();
            const termRect = term.getBoundingClientRect();
            term.scrollTop = term.scrollTop + (wrapRect.top - termRect.top) - 8;
            const bubble = wrap.querySelector('.chat-bubble');
            if (!bubble) return;
            bubble.classList.remove('flash-highlight');
            void bubble.offsetWidth; /* force reflow so the pulse replays */
            bubble.classList.add('flash-highlight');
            bubble.addEventListener('animationend', () => bubble.classList.remove('flash-highlight'), { once: true });
        });
        promptRail.appendChild(tick);
        promptRailTicks.push(tick);
    });
}

// --- AST_EXPORTS_START ---
window.rebuildPromptRailTicks = rebuildPromptRailTicks;
// --- AST_EXPORTS_END ---

// --- reorderSpinnerToBottom.js ---
function reorderSpinnerToBottom(sessionId) {
    const sid = sessionId || state.activeSessionId;
    if (sid !== state.activeSessionId) return;
    const gen = getGenState(sid);
    if (gen.spinEl && gen.spinEl.parentNode === term) {
        // Skip the DOM move if the spinner is already the last child,
        // so streaming doesn't fire a childList mutation every frame
        // (that would trigger the rail observer's rebuild).
        if (term.lastElementChild !== gen.spinEl) {
            term.appendChild(gen.spinEl);
            smartScroll();
        }
    }
}

// --- AST_EXPORTS_START ---
window.reorderSpinnerToBottom = reorderSpinnerToBottom;
// --- AST_EXPORTS_END ---

// --- resetScrollState.js ---
function resetScrollState() {
    state.userScrolledUp = false;
    if (jumpBtn) jumpBtn.style.display = 'none';
}

// --- AST_EXPORTS_START ---
window.resetScrollState = resetScrollState;
// --- AST_EXPORTS_END ---

// --- scheduleSettleScroll.js ---
// Content often keeps growing after the DOM insert (tool output, images, fonts, late
// layout), so re-pin once more on the next frame, after layout has settled.
function scheduleSettleScroll() {
    if (_settleRaf) return;
    _settleRaf = requestAnimationFrame(() => {
        _settleRaf = 0;
        if (state.userScrolledUp) return;
        programmaticScroll = true;
        term.scrollTop = term.scrollHeight;
        _lastTermScrollTop = term.scrollTop;
        requestAnimationFrame(() => { programmaticScroll = false; });
    });
}

// --- AST_EXPORTS_START ---
window.scheduleSettleScroll = scheduleSettleScroll;
// --- AST_EXPORTS_END ---

// --- showRetryStatus.js ---
function showRetryStatus(text, sessionId, opts = {}) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (sid === state.activeSessionId) {
        if (!gen.retryStatusEl) {
            gen.retryStatusEl = document.createElement('div');
            gen.retryStatusEl.className = 'log-entry dim retry-status';
            gen.retryStatusEl.innerHTML = '<span class="retry-status-text"></span>' +
                '<button class="btn-force-reconnect icon-btn" title="Reconnect now">' +
                '<span class="icon" style="font-size:12px;">sync</span></button>';
            if (gen.spinEl && gen.spinEl.parentNode === term) {
                term.insertBefore(gen.retryStatusEl, gen.spinEl);
            } else {
                term.appendChild(gen.retryStatusEl);
            }
            smartScroll();
        }
        const txt = gen.retryStatusEl.querySelector('.retry-status-text');
        if (txt) txt.textContent = text;
        const btn = gen.retryStatusEl.querySelector('.btn-force-reconnect');
        if (btn) btn.style.display = opts.reconnecting ? 'none' : '';
    }
    if (!gen.retryStatusActive) {
        gen.retryStatusActive = true;
        if (sid === state.activeSessionId) updateGenGlow();
    }
}

// --- AST_EXPORTS_START ---
window.showRetryStatus = showRetryStatus;
// --- AST_EXPORTS_END ---

// --- smartScroll.js ---
function smartScroll() {
    if (state.userScrolledUp) return;
    programmaticScroll = true;
    term.scrollTop = term.scrollHeight;
    _lastTermScrollTop = term.scrollTop;
    document.querySelectorAll('.code-box-content').forEach(el => {
        el.scrollTop = el.scrollHeight;
    });
    requestAnimationFrame(() => { programmaticScroll = false; });
    scheduleSettleScroll();
}

// --- AST_EXPORTS_START ---
window.smartScroll = smartScroll;
// --- AST_EXPORTS_END ---

// --- startSpinner.js ---
function startSpinner(text, sessionId, resume) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    stopSpinner(sid);

    const isLive = sid === state.activeSessionId;

    if (isLive) {
        document.querySelectorAll('.gen-stats-row').forEach(statsRow => {
            const copyBtn = statsRow.querySelector('.btn-prompt-action.copy');
            if (copyBtn) {
                const parentDiv = statsRow.parentElement;
                if (parentDiv) {
                    const actionsRow = document.createElement('div');
                    actionsRow.className = 'prompt-actions assistant-msg-actions';
                    actionsRow.appendChild(copyBtn);
                    parentDiv.appendChild(actionsRow);
                }
            }
            statsRow.remove();
        });
        statusModeBadge.innerText = "BUSY";
        statusModeBadge.style.background = "var(--yellow)";
    }

    // `resume` = re-attaching the spinner after a session switch: keep the
    // running generation's timers/token stats instead of resetting them.
    if (!resume) {
        gen.genSessionStartMs = Date.now();
        gen.genStartTime = performance.now();
        gen.genFirstTokenTime = null;
        gen.genEndTime = null;
        gen.genTokenCount = 0;
        gen.actualGenTokenCount = null;
        gen.genFinishReason = null;
        gen.genTks = null;
        gen.genServerTks = null;
        gen.genStatsRendered = false;
    }
    gen.currentAssistantDiv = null;
    gen._lastSpinnerText = text;

    if (isLive) {
        // Never allow more than one live spinner in the terminal.
        term.querySelectorAll('[data-live-spinner]').forEach(el => el.remove());
        gen.spinEl = document.createElement('div');
        gen.spinEl.className = 'log-entry';
        gen.spinEl.dataset.liveSpinner = '1';
        gen.spinEl.dataset.baseText = text;
        gen.spinEl.innerHTML = `<span class="spinner-icon">${frames[0]}</span><span class="dim">${escapeHTML(text)}</span>`;
        term.appendChild(gen.spinEl);
        smartScroll();

        gen.spinInterval = setInterval(() => {
            fIdx = (fIdx + 1) % frames.length;
            if (gen.spinEl && gen.spinEl.querySelector('.spinner-icon')) {
                gen.spinEl.querySelector('.spinner-icon').innerText = frames[fIdx];
            }
            if (gen.spinEl && !gen.genFirstTokenTime && gen.genStartTime) {
                const textEl = gen.spinEl.querySelector('.dim');
                if (textEl) {
                    const elapsed = (performance.now() - gen.genStartTime) / 1000;
                    textEl.innerText = `${gen.spinEl.dataset.baseText} (${elapsed.toFixed(1)}s)`;
                }
            }
        }, 80);
    }
}

// --- AST_EXPORTS_START ---
window.startSpinner = startSpinner;
// --- AST_EXPORTS_END ---

// --- stopSpinner.js ---
function stopSpinner(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (gen.spinInterval) clearInterval(gen.spinInterval);
    if (gen.spinEl) gen.spinEl.remove();
    gen.spinInterval = null; gen.spinEl = null;
    accumulateSessionRunningTime(sid);
    if (sid === state.activeSessionId) {
        const cfg = MODE_CONFIG[state.mode] || MODE_CONFIG.code;
        statusModeBadge.innerText = cfg.name;
        statusModeBadge.className = `status-badge ${cfg.badgeClass}`;
        if (!['mode-plan', 'mode-ask', 'mode-code'].includes(cfg.badgeClass)) {
            statusModeBadge.style.backgroundColor = cfg.color;
        } else {
            statusModeBadge.style.backgroundColor = '';
        }
    }
}

// --- AST_EXPORTS_START ---
window.stopSpinner = stopSpinner;
// --- AST_EXPORTS_END ---

// --- updatePromptRail.js ---
// Highlights the tick nearest the viewport center, measured to each message's vertical center so tall messages win.
function updatePromptRail() {
    const wraps = term.querySelectorAll('.chat-prompt-wrap');
    if (!wraps.length) return;
    const termRect = term.getBoundingClientRect();
    const viewTop = termRect.top;
    const viewBottom = termRect.bottom;
    // Reference line sweeps from the top edge (scrolled to top) to the bottom
    // edge (scrolled to bottom), so the first/last tick win at the extremes
    // and the center tick wins in between.
    const maxScroll = Math.max(term.scrollHeight - term.clientHeight, 1);
    const progress = Math.min(Math.max(term.scrollTop / maxScroll, 0), 1);
    const refY = viewTop + (viewBottom - viewTop) * progress;
    // Only consider ticks actually visible in the viewport, then highlight
    // the one whose center is closest to the reference line.
    let best = -1, bestDist = Infinity;
    wraps.forEach((wrap, i) => {
        const r = wrap.getBoundingClientRect();
        if (r.bottom <= viewTop || r.top >= viewBottom) return; // not visible
        const wrapCenter = r.top + r.height / 2;
        const d = Math.abs(wrapCenter - refY);
        if (d < bestDist) { bestDist = d; best = i; }
    });
    // Fallback if no tick is fully visible (very tall turn): pick the nearest.
    if (best === -1) {
        wraps.forEach((wrap, i) => {
            const r = wrap.getBoundingClientRect();
            const d = Math.abs(r.top + r.height / 2 - refY);
            if (d < bestDist) { bestDist = d; best = i; }
        });
    }
    promptRailTicks.forEach((tick, i) => {
        tick.classList.toggle('near', i === best);
    });
}

// --- AST_EXPORTS_START ---
window.updatePromptRail = updatePromptRail;
// --- AST_EXPORTS_END ---

// --- updateSpinnerText.js ---
function updateSpinnerText(text, sessionId) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (gen.spinEl && text && sid === state.activeSessionId) {
        const textEl = gen.spinEl.querySelector('.dim');
        if (textEl) {
            const cleanText = text.replace(/<[^>]*>/g, '').trim();
            let display = cleanText.slice(0, 90);
            if (cleanText) textEl.innerText = display;
        }
        reorderSpinnerToBottom(sid);
    }
}

// --- AST_EXPORTS_START ---
window.updateSpinnerText = updateSpinnerText;
// --- AST_EXPORTS_END ---

// --- waitForRetry.js ---
function waitForRetry(ms, attemptNum, reason = '', sessionId) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    return new Promise((resolve) => {
        const totalSec = Math.ceil(ms / 1000);
        const startedAt = Date.now();
        const reasonSuffix = reason ? ` - ${reason.length > 120 ? reason.slice(0, 117) + '...' : reason}` : '';
        // The status line stays visible while the new attempt is in flight and is
        // only stripped once the reconnection succeeds (see clearRetryStatus calls
        // after a good response) or the run is cancelled / gives up.
        gen.forceReconnect = () => {
            clearTimeout(gen.retryTimeout);
            gen.retryTimeout = null;
            gen.forceReconnect = null;
            gen.retryAttempt = 0;   // reset the backoff timer
            showRetryStatus('Reconnecting...', sid, { reconnecting: true });
            resolve();
        };
        const tick = () => {
            if (gen.retryCancelled || !gen.activeController) {
                clearTimeout(gen.retryTimeout);
                gen.retryTimeout = null;
                gen.forceReconnect = null;
                clearRetryStatus(sid);
                resolve();
                return;
            }
            const remaining = ms - (Date.now() - startedAt);
            const remainingSec = Math.max(0, Math.ceil(remaining / 1000));
            if (remaining <= 0) {
                gen.retryTimeout = null;
                gen.forceReconnect = null;
                showRetryStatus('Reconnecting...', sid, { reconnecting: true });
                resolve();
                return;
            }
            showRetryStatus(`Connection error${reasonSuffix} - retrying in ${remainingSec}s (attempt ${attemptNum})...`, sid);
            gen.retryTimeout = setTimeout(tick, 1000);
        };
        tick();
    });
}

// --- AST_EXPORTS_START ---
window.waitForRetry = waitForRetry;
// --- AST_EXPORTS_END ---
