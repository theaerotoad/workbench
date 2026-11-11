// --- runTask.js ---
async function runTask(task, msgId, imageUrls, sessionId) {
    const runSessionId = sessionId || state.activeSessionId;
    let { url: apiUrl, model, key: apiKey, vision: runModelVision, useProxy } = getCurrentModelInfo();
    const runCtx = sessionCtx(runSessionId);
    const runGen = getGenState(runSessionId);
    const isRunLive = () => runSessionId === state.activeSessionId;
    const mySeq = runGen.runSeq = (runGen.runSeq || 0) + 1;
    const isSuperseded = () => runGen.runSeq !== mySeq;

    const userContent = (imageUrls && imageUrls.length > 0)
        ? [{ type: "text", text: task }, ...imageUrls.map(url => ({ type: "image_url", image_url: { url } }))]
        : task;

    const resolvedMsgId = msgId || genMessageId();
    runCtx.messages.push({ id: resolvedMsgId, role: "user", content: userContent });
    if (isRunLive()) updateWelcomeVisibility();
    maybeUpdateSessionTitleFromPrompt(task, runSessionId).catch(() => {});

    runGen.isRunning = true;
    runGen.retryCancelled = false;
    if (isRunLive()) updatePromptSendButton();

    try {
        await maybeAutoCompress(runSessionId);
    } catch (e) {
        console.warn('Auto-compress failed:', e);
    }

    if (runGen.retryCancelled) {
        runGen.isRunning = false;
        if (isRunLive()) updatePromptSendButton();
        return;
    }

    // File-change blame (see fs.record/currentPromptCtx) is stamped with this
    // same id, so a revert can be targeted by the unified message id.
    runGen.currentPromptContext = {
        id: resolvedMsgId,
        text: task,
        ts: Date.now()
    };

    let isDone = false;

    const runMode = state.mode;
    let activeTools = getToolsForMode(runMode, !!runModelVision);
    const runModeSession = state.sessions[runSessionId];

    // The system prompt depends only on the mode, so rebuild it each run.
    const currentSystemPrompt = buildDynamicSystemPrompt(runMode);
    if (runModeSession) {
        runModeSession.systemPrompt = currentSystemPrompt;
        runModeSession.systemPromptMode = runMode;
    }
    runGen.retryAttempt = 0;
    runGen.retryCancelled = false;

        let firstIteration = true;
        let iterController = null;
        while (!isDone) {
            if (!firstIteration) {
                try {
                    await maybeAutoCompress(runSessionId);
                } catch (e) {
                    console.warn('Mid-turn auto-compress failed:', e);
                }
                // Aborting auto-compression mid-turn must abort the entire run,
                // otherwise the loop silently starts a fresh generation afterwards.
                if (runGen.retryCancelled) {
                    runGen.genFinishReason = 'abort';
                    if (!runGen.genEndTime) runGen.genEndTime = performance.now();
                    renderGenStats(runSessionId);
                    break;
                }
            }
            firstIteration = false;

            startSpinner(`Running (${runMode} mode...`, runSessionId);
            iterController = new AbortController();
            runGen.activeController = iterController;
            if (runGen.thinkingTimerInterval) {
                clearInterval(runGen.thinkingTimerInterval);
                runGen.thinkingTimerInterval = null;
            }

            // Reset per-request stream state.
            let assistantText = "";
            let streamDiv = null;
            let reasoningText = "";
            let toolBuffer = {};
            let thoughtDiv = null;
            let thinkingStartTime = null;
            let thinkingFinished = false;
            let sseBuffer = "";
            let lastRenderTime = 0;
            let renderPending = false;

            try {
            const reqMessages = sanitizeMessages([
                { role: "system", content: currentSystemPrompt },
                ...(runModelVision ? runCtx.messages : stripImagesFromMessages(runCtx.messages))
            ]);

            const headers = { "Content-Type": "application/json" };
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`;
            }

            let resp;
            try {
                const targetUrl = `${apiUrl}/chat/completions`;
                const reqUrl = useProxy ? '/proxy' : targetUrl;
                if (useProxy) headers["x-proxy-target"] = targetUrl;
                
                resp = await fetch(reqUrl, {
                    method: "POST",
                    headers: headers,
                    signal: runGen.activeController.signal,
                    body: JSON.stringify({
                        model: model,
                        messages: reqMessages,
                        tools: activeTools,
                        tool_choice: "auto",
                        stream: true,
                        stream_options: { include_usage: true }
                    })
                });
            } catch(fetchErr) {
                if (fetchErr.name === 'AbortError') {
                    if (runGen.thinkingTimerInterval) {
                        clearInterval(runGen.thinkingTimerInterval);
                        runGen.thinkingTimerInterval = null;
                    }
                    runGen.isThinkingNow = false;
                    break;
                }
                throw new Error(`Connection reset or server unreachable at ${apiUrl}. Verify local LLM server is running and CORS is enabled.`);
            }

            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}));
                throw new Error(errJson.error?.message || `HTTP ${resp.status}`);
            }

            // Reconnected: strip the retry/reconnect message.
            clearRetryStatus(runSessionId);
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            stopSpinner(runSessionId);
            startSpinner("Generating response...", runSessionId);

            runGen.skipThinkingRequested = false;

            function clearAnyThinkingTimer() {
                if (runGen.thinkingTimerInterval) {
                    clearInterval(runGen.thinkingTimerInterval);
                    runGen.thinkingTimerInterval = null;
                }
            }

            function startThinkingTimer(container) {
                if (thinkingFinished) return;
                clearAnyThinkingTimer();
                thinkingStartTime = Date.now();
                const timeoutSec = parseInt(document.getElementById('settings-thinking-timeout').value, 10) || -1;

                runGen.thinkingTimerInterval = setInterval(() => {
                    if (!container || thinkingFinished) {
                        clearAnyThinkingTimer();
                        return;
                    }
                    const elapsed = Date.now() - thinkingStartTime;
                    const timerEl = container.querySelector('.thought-timer');
                    if (timerEl && thinkingStartTime) {
                        timerEl.innerText = `Thinking (${formatDuration(elapsed)})...`;
                    }
                    if (timeoutSec > 0 && elapsed > timeoutSec * 1000) {
                        clearAnyThinkingTimer();
                        if (runGen.activeController) {
                            runGen.skipThinkingRequested = true;
                            runGen.activeController.abort();
                        }
                    }
                }, 100);
            }

            function stopThinkingTimer(container) {
                clearAnyThinkingTimer();
                if (thinkingFinished) return;
                thinkingFinished = true;
                runGen.isThinkingNow = false;

                if (container) {
                    if (thinkingStartTime) {
                        const elapsed = Date.now() - thinkingStartTime;
                        const timerEl = container.querySelector('.thought-timer');
                        if (timerEl) {
                            timerEl.innerText = `Thought for ${formatDuration(elapsed)}`;
                        }
                        thinkingStartTime = null;
                    }
                    const skipBtn = container.querySelector('.btn-skip-thinking');
                    if (skipBtn) skipBtn.remove();
                    const box = container.querySelector('.thought-box');
                    if (box && !box.classList.contains('collapsed')) {
                        box.classList.add('collapsed');
                    }
                    saveSession(runSessionId);
                }
            }

            while (true) {
                // Abort check before blocking on the reader: if the controller was
                // aborted (user pressed Esc / Stop), cancel the body stream so the
                // connection is actually torn down, not just logically stopped.
                if (!runGen.activeController || runGen.activeController.signal.aborted) {
                    try { reader.cancel(); } catch (_) {}
                    break;
                }

                let chunk;
                try {
                    chunk = await reader.read();
                } catch(readErr) {
                    if (runGen.skipThinkingRequested || runGen.activeController === null) break;
                    throw readErr;
                }
                const { done, value } = chunk;
                if (done) break;

                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop() || "";

                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line.startsWith('data:')) continue;
                    const dataStr = line.replace(/^data:\s*/, '').trim();
                    if (dataStr === '[DONE]') continue;
                    try {
                        const json = JSON.parse(dataStr);

                        if (json.error) {
                            throw new Error(json.error.message || JSON.stringify(json.error));
                        }

                        let hasUsage = false;
                        let latestTokenUsage = null;

                        if (json.usage) {
                            latestTokenUsage = json.usage;
                            if (json.usage.completion_tokens != null) {
                                runGen.actualGenTokenCount = json.usage.completion_tokens;
                            }
                            hasUsage = true;
                        }

                        if (json.timings) {
                            if (!hasUsage) {
                                const promptN = json.timings.prompt_n || 0;
                                const prevTokenUsage = state.sessions[runSessionId]?.lastTokenUsage;
                                const prevPrompt = prevTokenUsage?.prompt_tokens || 0;

                                latestTokenUsage = {
                                    prompt_tokens: Math.max(promptN, prevPrompt),
                                    completion_tokens: json.timings.predicted_n || 0,
                                    total_tokens: Math.max(promptN, prevPrompt) + (json.timings.predicted_n || 0)
                                };
                                if (json.timings.predicted_n != null) {
                                    runGen.actualGenTokenCount = json.timings.predicted_n;
                                }
                            }

                            if (json.timings.predicted_per_second != null) {
                                runGen.genServerTks = json.timings.predicted_per_second;
                            } else if (json.timings.predicted_ms != null && json.timings.predicted_n != null && json.timings.predicted_ms > 0) {
                                runGen.genServerTks = json.timings.predicted_n / (json.timings.predicted_ms / 1000);
                            }
                        }

                        if (latestTokenUsage) {
                            if (state.sessions[runSessionId]) state.sessions[runSessionId].lastTokenUsage = latestTokenUsage;
                            runGen.postCompressTokenOverride = null;
                            if (isRunLive()) {
                                state.lastTokenUsage = latestTokenUsage;
                                updateTokenStatus(latestTokenUsage);
                            }
                        }

                        if (!json.choices || !json.choices.length) continue;

                        const finishReason = json.choices[0].finish_reason;
                        if (finishReason !== undefined && finishReason !== null) {
                            runGen.genFinishReason = finishReason;
                        }

                        const delta = json.choices[0].delta;
                        if (!delta) continue;

                        if (!runGen.genFirstTokenTime && (delta.content || delta.reasoning_content || delta.thinking || delta.tool_calls)) {
                            runGen.genFirstTokenTime = performance.now();
                        }
                        if (delta.content) {
                            runGen.genTokenCount += Math.max(1, Math.round(delta.content.length / 4));
                        }
                        if (delta.reasoning_content || delta.thinking) {
                            runGen.genTokenCount += Math.max(1, Math.round((delta.reasoning_content || delta.thinking || '').length / 4));
                        }

                        let rChunk = delta.reasoning_content || delta.thinking || "";
                        if (rChunk && !thinkingFinished) {
                            runGen.isThinkingNow = true;
                            reasoningText += rChunk;
                            renderPending = true;
                        }

                        if (delta.content) {
                            assistantText += delta.content;
                            renderPending = true;
                        }

                        if (delta.tool_calls) {
                            if (thoughtDiv && !thinkingFinished) {
                                stopThinkingTimer(thoughtDiv);
                            }
                            for (const tc of delta.tool_calls) {
                                if (!toolBuffer[tc.index]) {
                                    toolBuffer[tc.index] = { id: tc.id, name: tc.function?.name || "", args: tc.function?.arguments || "" };
                                } else {
                                    if (tc.function?.name) toolBuffer[tc.index].name += tc.function.name;
                                    if (tc.function?.arguments) toolBuffer[tc.index].args += tc.function.arguments;
                                }
                            }
                            if (isRunLive()) {
                                if (!runGen.pendingToolDiv) {
                                    runGen.pendingToolDiv = print(`<div class="log-entry" data-pending-tool="1" style="color:var(--dim);"><span class="spinner-icon">${frames[0]}</span><span class="pending-tool-label">Preparing tool call...</span></div>`, "", runSessionId);
                                }
                                const pendingLabel = runGen.pendingToolDiv && runGen.pendingToolDiv.querySelector('.pending-tool-label');
                                if (pendingLabel) {
                                    const names = Object.values(toolBuffer).map(t => t.name).filter(n => n).join(', ');
                                    pendingLabel.innerText = names ? `Writing tool: ${names}...` : 'Preparing tool call...';
                                }
                                renderPendingToolPreview(toolBuffer, runSessionId);
                                reorderSpinnerToBottom(runSessionId);
                                smartScroll();
                            }
                        }
                    } catch(e) {}
                }

                if (renderPending && performance.now() - lastRenderTime > 50) {
                    lastRenderTime = performance.now();
                    renderPending = false;

                    if (isRunLive()) {
                        // reasoningText and assistantText are already-clean accumulators.

                        if (reasoningText && !thinkingFinished) {
                            if (!thoughtDiv) {
                                thoughtDiv = print(`
                                    <div class="thought-box collapsed">
                                        <div class="thought-header">
                                            <span class="icon icon-chevron">expand_more</span>
                                            <span class="icon" style="font-size:14px; color:var(--dim);">psychology</span>
                                            <span class="thought-timer">Thinking (0.0s)...</span>
                                            <button class="btn-skip-thinking icon-btn" title="Skip thinking and proceed">
                                                <span class="icon" style="font-size:12px;">fast_forward</span>
                                            </button>
                                        </div>
                                        <div class="thought-body"></div>
                                    </div>
                                `, "", runSessionId);
                                startThinkingTimer(thoughtDiv);
                            }
                            const bodyEl = thoughtDiv.querySelector('.thought-body');
                            if (bodyEl) bodyEl.innerText = reasoningText;
                            reorderSpinnerToBottom(runSessionId);
                            smartScroll();

                            const lastLine = reasoningText.trim().split('\n').pop();
                            if (lastLine) updateSpinnerText(lastLine, runSessionId);
                        }

                        // Visible content means thinking is over.
                        if (assistantText.trim() && thoughtDiv && !thinkingFinished) {
                            stopThinkingTimer(thoughtDiv);
                        }

                        if (assistantText.trim() || streamDiv) {
                            if (!streamDiv && assistantText.trim()) {
                                streamDiv = print("", `log-entry md-content mode-${runMode}`, runSessionId);
                                if (streamDiv) streamDiv.setAttribute('data-mode', runMode);
                                runGen.currentAssistantDiv = streamDiv;
                            }
                            if (streamDiv) {
                                streamDiv.innerHTML = normalizeBlockHTML(formatMarkdownSnippet(assistantText));
                                reorderSpinnerToBottom(runSessionId);
                                smartScroll();
                            }
                        }
                    }
                }
            }

            if (renderPending) {
                if (isRunLive()) {
                    if (reasoningText && !thinkingFinished && thoughtDiv) {
                        const bodyEl = thoughtDiv.querySelector('.thought-body');
                        if (bodyEl) bodyEl.innerText = reasoningText;
                    }

                    if (assistantText.trim() || streamDiv) {
                        if (!streamDiv && assistantText.trim()) {
                            streamDiv = print("", `log-entry md-content mode-${runMode}`, runSessionId);
                            if (streamDiv) streamDiv.setAttribute('data-mode', runMode);
                            runGen.currentAssistantDiv = streamDiv;
                        }
                        if (streamDiv) {
                            streamDiv.innerHTML = normalizeBlockHTML(formatMarkdownSnippet(assistantText));
                        }
                    }
                    reorderSpinnerToBottom(runSessionId);
                    smartScroll();
                }
            }

            runGen.isThinkingNow = false;
            stopSpinner(runSessionId);

            if (!isRunLive()) {
                if (reasoningText && reasoningText.trim()) {
                    print(
                        `<div class="thought-box collapsed">` +
                            `<div class="thought-header">` +
                                `<span class="icon icon-chevron">expand_more</span>` +
                                `<span class="icon" style="font-size:14px; color:var(--dim);">psychology</span>` +
                                `<span class="thought-timer">Thought</span>` +
                            `</div>` +
                            `<div class="thought-body">${escapeHTML(reasoningText)}</div>` +
                        `</div>`,
                        "", runSessionId
                    );
                }
                if (assistantText.trim()) {
                    const el = print(normalizeBlockHTML(formatMarkdownSnippet(assistantText)), `log-entry md-content mode-${runMode}`, runSessionId);
                    if (el) el.setAttribute('data-mode', runMode);
                }
            }

            if (thoughtDiv) {
                stopThinkingTimer(thoughtDiv);
            }

            if (streamDiv) {
                attachAssistantCopyAction(streamDiv, assistantText);
            }

            if (runGen.pendingToolDiv) {
                runGen.pendingToolDiv.remove();
                runGen.pendingToolDiv = null;
            }

            if (runGen.skipThinkingRequested) {
                runGen.skipThinkingRequested = false;

                if (thoughtDiv) {
                    stopThinkingTimer(thoughtDiv);
                    const box = thoughtDiv.querySelector('.thought-box');
                    const timerEl = thoughtDiv.querySelector('.thought-timer');
                    const iconEl = thoughtDiv.querySelector('.thought-header .icon:not(.icon-chevron)');
                    if (box) box.classList.add('skipped');
                    if (timerEl) timerEl.innerText = `Skipped after ${timerEl.innerText.match(/[\d.]+[ms]+/)?.[0] || ''}`.trim();
                    if (iconEl) iconEl.innerText = 'fast_forward';
                }

                let partialContent = '';
                const keepSkipped = getDuoSwitch(document.getElementById('settings-keep-skipped-thinking'));

                if (reasoningText) {
                    if (keepSkipped) {
                        partialContent = `\n[thinking skipped by user - partial reasoning preserved]\n${reasoningText}\n`;
                    } else {
                        partialContent = `\n[thinking skipped by user]\n`;
                    }
                }
                if (assistantText) {
                    partialContent += assistantText;
                }

                runCtx.messages.push({
                    role: "assistant",
                    content: partialContent || "[Thinking stopped by user]"
                });
                runGen.hasNewContent = true;

                runCtx.messages.push({
                    role: "user",
                    content: "The user requested to skip the remaining thinking process. Please proceed directly with answering or executing the necessary tools now."
                });

                saveSession(runSessionId);
                continue;
            }

            const toolCalls = Object.values(toolBuffer).map(t => ({
                id: t.id, type: "function", function: { name: t.name, arguments: t.args }
            }));

            runCtx.messages.push({
                role: "assistant",
                content: assistantText || null,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {})
            });
            runGen.hasNewContent = true;
            saveSession(runSessionId);

            if (toolCalls.length > 0) {
                let toolGroupContainer = null;
                if (toolCalls.length > 1 && isRunLive()) {
                    toolGroupContainer = document.createElement('div');
                    toolGroupContainer.className = 'tool-group collapsed';
                    const groupKinds = new Set(toolCalls.map(c => getToolIOKind(c.function.name)));
                    const groupKind = groupKinds.size > 1 ? 'mixed' : [...groupKinds][0] || 'read';
                    toolGroupContainer.innerHTML = `
                        <div class="tool-group-header">
                            <span class="icon icon-chevron">expand_more</span>
                            ${toolIOIndicatorHTML(null, groupKind)}
                            <span class="tool-badge">tools</span>
                            <span class="tool-summary">${toolCalls.length} tool calls</span>
                        </div>
                        <div class="tool-group-body"></div>
                    `;
                    if (runGen.spinEl && runGen.spinEl.parentNode === term) {
                        term.insertBefore(toolGroupContainer, runGen.spinEl);
                    } else {
                        term.appendChild(toolGroupContainer);
                    }
                }
                // Runs one tool call end-to-end: validate args, render its box, execute, render the
                // result. Safe to run concurrently with sibling calls since it touches no shared
                // mutable state besides DOM append (each call gets its own runningBox/args).
                // Result-message pushes are done separately (commitCallResult) so transcript order
                // always matches the model's original call order regardless of completion order.
                const processSingleCall = async (call) => {
                    let args = {};
                    let parseError = null;
                    try {
                        const raw = (call.function.arguments || '').trim();
                        args = raw ? JSON.parse(raw) : {};
                    } catch(e) { parseError = e; }

                    const validation = validateToolArgs(call.function.name, args, call.function.arguments, parseError);
                    if (!validation.valid) {
                        const errMsg = `ERROR: Invalid arguments for tool "${call.function.name}":\n- ${validation.errors.join('\n- ')}`;
                        safeRenderToolCallBox(call.function.name, args, errMsg, false, true, toolGroupContainer, null, runSessionId, null, summarizeToolError(errMsg));
                        markToolGroupFailed(toolGroupContainer, call.function.name, errMsg);
                        runGen.hasNewContent = true;
                        return { call, args, resStr: errMsg, aborted: false };
                    }

                    const matchingTool = toolRegistry[call.function.name];
                    const usesToolBox = !(matchingTool && Number(matchingTool.toolBox) === 0);
                    const runningBox = usesToolBox
                        ? renderRunningToolBox(call.function.name, args, toolGroupContainer, runSessionId)
                        : null;

                    // Tools marked expanded (TOOL_META.expanded or the autoExpand setting) open their
                    // group right away so live content isn't hidden while the tool is running.
                    if (runningBox && toolGroupContainer) {
                        const earlyAuto = getToolSettingValue(call.function.name, 'autoExpand');
                        if (earlyAuto !== undefined ? !!earlyAuto : !!(matchingTool && matchingTool.expanded)) {
                            toolGroupContainer.classList.remove('collapsed');
                        }
                    }

                    const resObj = await executeTool(call.function.name, args, runSessionId, runningBox);

                    if (runGen.activeController !== iterController || isSuperseded()) {
                        if (runningBox) {
                            if (isSuperseded()) {
                                // Edit / /clear threw this run away: leave no trace in the chat.
                                stopRunningToolBox(runningBox);
                                runningBox.remove();
                            } else if (runningBox.dataset.aborted === 'true') {
                                stopRunningToolBox(runningBox);
                                safeRenderToolCallBox(call.function.name, args, String(resObj.output), true, true, toolGroupContainer, runningBox, runSessionId);
                                runGen.hasNewContent = true;
                                saveSession(runSessionId);
                            } else {
                                stopRunningToolBox(runningBox);
                                runningBox.remove();
                            }
                        }
                        return { call, args, resObj, resStr: String(resObj.output), aborted: true };
                    }

                    const resStr = String(resObj.output);
                    const resIsError = resStr.startsWith('ERROR:');

                    if (resIsError) markToolGroupFailed(toolGroupContainer, call.function.name, resStr);

                    if (!usesToolBox) {
                        if (resStr.trim()) {
                            if (isRunLive()) {
                                const target = toolGroupContainer ? (toolGroupContainer.querySelector('.tool-group-body') || toolGroupContainer) : term;
                                const el = document.createElement('div');
                                el.className = "log-entry md-content";
                                el.innerHTML = normalizeBlockHTML(formatMarkdownSnippet(resStr));
                                target.appendChild(el);
                                smartScroll();
                            } else {
                                print(normalizeBlockHTML(formatMarkdownSnippet(resStr)), "log-entry md-content", runSessionId);
                            }
                        }
                    } else {
                        // Check if tool should be auto-expanded (setting override or TOOL_META.expanded);
                        // never auto-expand a tool that failed.
                        const autoExpandSetting = getToolSettingValue(call.function.name, 'autoExpand');
                        const shouldExpand = resIsError ? false : (autoExpandSetting !== undefined ? !!autoExpandSetting : !!(matchingTool && matchingTool.expanded));

                        if (shouldExpand && toolGroupContainer) {
                            toolGroupContainer.classList.remove('collapsed');
                        }

                        // displayHtml is opt-in, UI-only markup kept separate from resStr so it never reaches the model's context.
                        safeRenderToolCallBox(call.function.name, args, resStr, shouldExpand, resIsError, toolGroupContainer, runningBox, runSessionId, resObj.displayHtml || null, resObj.summary || null);
                    }

                    runGen.hasNewContent = true;
                    return { call, args, resObj, resStr, aborted: false };
                };

                // Pushes the "tool" result message(s) for one processSingleCall() outcome.
                const commitCallResult = async ({ call, args, resObj, resStr }) => {
                    runCtx.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: resStr });
                    if (resObj && resObj.__imageDataUrl && runModelVision) {
                        runCtx.messages.push({
                            role: "user",
                            content: [
                                { type: "text", text: `(Image result from preview_image tool call for ${args.filepath || ''})` },
                                { type: "image_url", image_url: { url: resObj.__imageDataUrl } }
                            ]
                        });
                    }
                    await saveSession(runSessionId);
                };

                // Group consecutive read-only calls (per getToolIOKind) so they execute in parallel;
                // a write/mixed call always runs alone, never overlapping a neighbor. Batches run in
                // sequence, and results are committed in original call order within/after each batch,
                // so e.g. a write depending on an earlier read never starts before that read finishes,
                // and the transcript sent back to the model always lists results in call order.
                let ci = 0;
                while (ci < toolCalls.length) {
                    if (runGen.activeController !== iterController || isSuperseded()) break;

                    let batch;
                    if (getToolIOKind(toolCalls[ci].function.name) === 'read') {
                        batch = [toolCalls[ci]];
                        ci++;
                        while (ci < toolCalls.length && getToolIOKind(toolCalls[ci].function.name) === 'read') {
                            batch.push(toolCalls[ci]);
                            ci++;
                        }
                    } else {
                        batch = [toolCalls[ci]];
                        ci++;
                    }

                    const outcomes = batch.length > 1
                        ? await Promise.all(batch.map(processSingleCall))
                        : [await processSingleCall(batch[0])];

                    // A superseded run (edit + resubmit) must not push orphan tool results
                    // into the already-truncated history.
                    if (isSuperseded()) { isDone = true; break; }
                    for (const outcome of outcomes) {
                        await commitCallResult(outcome);
                    }

                    if (outcomes.some(o => o.aborted) || runGen.activeController !== iterController) {
                        isDone = true;
                        break;
                    }
                }
            } else {
                if (runGen.genFinishReason === 'length') {
                    runCtx.messages.push({
                        role: "user",
                        content: "Your previous response was cut off due to the token limit. Please continue exactly from where you left off."
                    });
                    continue;
                }

                if (runMode === 'plan' && registry.meta[PLAN_FILE] && isRunLive()) {
                    renderPlanActionCard(assistantText);
                    await openFileTab(PLAN_FILE);
                }
                isDone = true;
                runGen.genEndTime = performance.now();
                if (!runGen.genFinishReason) runGen.genFinishReason = 'stop';
                renderGenStats(runSessionId);
                await saveSession(runSessionId);
                break;
            }

        } catch(e) {
            stopSpinner(runSessionId);
            if (runGen.thinkingTimerInterval) {
                clearInterval(runGen.thinkingTimerInterval);
                runGen.thinkingTimerInterval = null;
            }
            if (runGen.pendingToolDiv) {
                runGen.pendingToolDiv.remove();
                runGen.pendingToolDiv = null;
            }
            if (streamDiv) {
                attachAssistantCopyAction(streamDiv, assistantText);
            }

            runGen.genEndTime = performance.now();
            if (e.name === 'AbortError') {
                runGen.genFinishReason = 'abort';
                renderGenStats(runSessionId);
                break;
            }

            const errMsg = String(e.message || '');
            const isJsonError = errMsg.includes("Failed to parse tool call") || 
                                errMsg.includes("json.exception") || 
                                errMsg.includes("missing closing quote");

            if (isJsonError) {
                runGen.genFinishReason = 'error';
                const recoveryMsg = "SYSTEM: Your tool call generated invalid JSON and was rejected by the server. This usually happens when trying to edit too many lines at once, causing the JSON string to be truncated mid-generation. Please try again using a smaller, more surgical edit.";

                print(`<div class="tool-box error-box done-box">
                    <div class="tool-box-header" style="cursor:default">
                        <span class="icon" style="width:14px"></span>
                        <span class="tool-badge custom-tool">syntax error</span>
                        <span class="tool-summary">Tool call JSON truncated</span>
                        <span class="icon" style="font-size:14px; color:var(--red); margin-left:auto;">error</span>
                    </div>
                    <div class="tool-box-body">
                        <div class="tool-output-text error-output-text">${escapeHTML(errMsg)}</div>
                    </div>
                </div>`, "", runSessionId);

                runCtx.messages.push({
                    role: "assistant",
                    content: assistantText || "(Attempted a tool call but failed due to truncated JSON)"
                });
                runCtx.messages.push({
                    role: "user",
                    content: recoveryMsg
                });
                runGen.hasNewContent = true;

                renderGenStats(runSessionId);
                saveSession(runSessionId);
                break;
            }

            if (assistantText === "" && !runGen.retryCancelled) {
                runGen.retryAttempt++;
                const delayMs = 5000 * Math.pow(2, runGen.retryAttempt - 1);
                await waitForRetry(delayMs, runGen.retryAttempt, errMsg, runSessionId);
                if (runGen.retryCancelled) {
                    runGen.genFinishReason = 'abort';
                    renderGenStats(runSessionId);
                    break;
                }
                // Reconnect with whatever model is selected now, in case the user
                // switched models while we were waiting.
                {
                    const cur = getCurrentModelInfo();
                    if (cur.url && cur.model) {
                        apiUrl = cur.url; model = cur.model; apiKey = cur.key; runModelVision = cur.vision; useProxy = !!cur.useProxy;
                        activeTools = getToolsForMode(runMode, !!runModelVision);
                    }
                }
                if (runGen.activeController === iterController) runGen.activeController = null;
                continue;
            }

            clearRetryStatus(runSessionId);
            runGen.genFinishReason = 'error';
            print(`[error] ${escapeHTML(e.message)}`, "red", runSessionId);
            renderGenStats(runSessionId);
            saveSession(runSessionId);
            break;
        }
        if (isSuperseded()) break;
        if (runGen.activeController === iterController) runGen.activeController = null;
        runGen.retryAttempt = 0;
    }

    // Superseded by a newer run on this session: leave shared state/UI to that run.
    if (isSuperseded()) return;

    runGen.isRunning = false;
    if (isRunLive()) updatePromptSendButton();
    runGen.currentPromptContext = null;
    stopSpinner(runSessionId);
    if (isRunLive()) removeAllSkipThinkingButtons();
    if (runGen.thinkingTimerInterval) {
        clearInterval(runGen.thinkingTimerInterval);
        runGen.thinkingTimerInterval = null;
    }
    if (runGen.pendingToolDiv) {
        runGen.pendingToolDiv.remove();
        runGen.pendingToolDiv = null;
    }
    if (runGen.currentAssistantDiv) {
        attachAssistantCopyAction(runGen.currentAssistantDiv, runGen.currentAssistantDiv.innerText);
    }
    if (runGen.genStartTime && !runGen.genEndTime) {
        runGen.genEndTime = performance.now();
        if (!runGen.genFinishReason) runGen.genFinishReason = runGen.activeController ? 'abort' : null;
        renderGenStats(runSessionId);
    }
    await saveSession(runSessionId);
    if (isRunLive()) focusPrompt();
    drainQueuedPrompt(runSessionId);
}

// --- AST_EXPORTS_START ---
window.runTask = runTask;
// --- AST_EXPORTS_END ---
