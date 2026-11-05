// --- applyPromptFile.js ---
function applyPromptFile(mode, text) {
    const body = stripPromptFileHeader(text);
    if (!body) {
        return { error: `${MODE_PROMPT_FILES[mode]} is empty - keeping the previous prompt for "${mode}".` };
    }
    MODE_PROMPTS[mode] = body;
    saveModePrompts();
    return {};
}

// --- AST_EXPORTS_START ---
window.applyPromptFile = applyPromptFile;
// --- AST_EXPORTS_END ---

// --- buildDynamicSystemPrompt.js ---
function buildDynamicSystemPrompt(modeOverride) {
    const effMode = modeOverride || state.mode;
    const vars = { planFile: PLAN_FILE, mode: effMode };
    const mode = (effMode === 'ask' || effMode === 'plan' || dynamicModes.includes(effMode)) ? effMode : 'code';
    const template = MODE_PROMPTS[mode] || seedDefaultModePrompts()[mode] || MODE_PROMPTS['code'];
    let prompt = renderPromptTemplate(template, vars);
    if (typeof window.formatSkillsSystemPromptSection === 'function') {
        prompt += window.formatSkillsSystemPromptSection();
    }
    return prompt;
}

// --- AST_EXPORTS_START ---
window.buildDynamicSystemPrompt = buildDynamicSystemPrompt;
// --- AST_EXPORTS_END ---

// --- drainQueuedPrompt.js ---
// Sends a prompt queued during generation once the session finishes.
function drainQueuedPrompt(sessionId) {
    const queued = state.queuedPrompts[sessionId];
    if (!queued) return;
    delete state.queuedPrompts[sessionId];
    if (sessionId === state.activeSessionId) renderQueuedPromptBanner();
    if (isSessionRunning(sessionId)) return;

    const wasActive = state.activeSessionId;
    if (sessionId !== state.activeSessionId) {
        // The prompt was queued on a background session; switch to it to submit, then restore.
        state.activeSessionId = sessionId;
    }
    const prevVal = input.value;
    const prevAttachments = state.attachedReferences;
    input.value = queued.val;
    state.attachedReferences = queued.attachedReferences || [];
    submitPrompt().finally(() => {
        if (state.activeSessionId === sessionId && wasActive !== sessionId) {
            state.activeSessionId = wasActive;
        }
        if (wasActive !== sessionId) {
            input.value = prevVal;
            state.attachedReferences = prevAttachments;
        }
    });
}

// --- AST_EXPORTS_START ---
window.drainQueuedPrompt = drainQueuedPrompt;
// --- AST_EXPORTS_END ---

// --- focusPrompt.js ---
function focusPrompt() {
    if (state.activeTab === 'chat' && document.activeElement !== input) {
        input.focus();
    }
}

// --- AST_EXPORTS_START ---
window.focusPrompt = focusPrompt;
// --- AST_EXPORTS_END ---

// --- formatPromptBlame.js ---
function formatPromptBlame(promptInfo) {
    if (!promptInfo) return { text: '(pre-existing content)', manual: true };
    if (promptInfo.id === null) return { text: promptInfo.text || '(manual edit)', manual: true };
    return { text: promptInfo.text, manual: false };
}

// --- AST_EXPORTS_START ---
window.formatPromptBlame = formatPromptBlame;
// --- AST_EXPORTS_END ---

// --- isSlashCommand.js ---
// True when the text is one of the app's slash commands (not just "/some/path ..." prose).
function isSlashCommand(text) {
    const first = (text || '').trim().split(/\s+/)[0].toLowerCase();
    if (first.startsWith('/skill:') || first === '/skill') return true;
    return !!first && SLASH_COMMANDS.some(c => c.cmd === first);
}

// --- AST_EXPORTS_START ---
window.isSlashCommand = isSlashCommand;
// --- AST_EXPORTS_END ---

// --- modePromptFileContent.js ---
function modePromptFileContent(filepath) {
    const mode = PROMPT_FILE_MODES[filepath];
    return mode ? promptFileContent(mode) : '';
}

// --- AST_EXPORTS_START ---
window.modePromptFileContent = modePromptFileContent;
// --- AST_EXPORTS_END ---

// --- promptFileContent.js ---
function promptFileContent(mode) {
    const header = PROMPT_FILE_HEADERS[mode] || '';
    const body = (MODE_PROMPTS[mode] || '').trim();
    return header ? `${header}\n\n${body}\n` : `${body}\n`;
}

// --- AST_EXPORTS_START ---
window.promptFileContent = promptFileContent;
// --- AST_EXPORTS_END ---

// --- queuePrompt.js ---
function queuePrompt(sessionId, val, attachedReferences) {
    state.queuedPrompts[sessionId] = { val, attachedReferences: attachedReferences || [] };
    if (sessionId === state.activeSessionId) renderQueuedPromptBanner();
}

// --- AST_EXPORTS_START ---
window.queuePrompt = queuePrompt;
// --- AST_EXPORTS_END ---

// --- refreshCustomModes.js ---
function refreshCustomModes() {
    const customModes = AppConfig.get('custom-modes', []);

    for (const key of Object.keys(MODE_CONFIG)) {
        if (!['plan', 'ask', 'code', 'title'].includes(key)) {
            delete MODE_CONFIG[key];
        }
    }

    const baseCommands = ['/plan', '/ask', '/code', '/execute-plan', '/continue', '/compact', '/new', '/session', '/clear', '/restore', '/help'];
    SLASH_COMMANDS = SLASH_COMMANDS.filter(c => baseCommands.includes(c.cmd));

    dynamicModes = [];
    MODE_LABELS = { plan: 'Plan', ask: 'Ask', code: 'Code' };

    if (Array.isArray(customModes)) {
        for (const m of customModes) {
            if (m && m.id && typeof m.id === 'string') {
                const promptFile = `${PROMPTS_DIR}/${m.id}.md`;

                if (MODE_PROMPTS[m.id] || registry.files[promptFile] !== undefined || (rootHandle && m.id)) {
                    MODE_CONFIG[m.id] = {
                        name: m.name || m.id.toUpperCase(),
                        badgeClass: m.badgeClass || 'mode-ask',
                        color: m.color || 'var(--primary)',
                        symbolClass: m.symbolClass || 'cyan',
                        icon: m.icon || 'extension',
                        placeholder: m.placeholder || `Ask agent in ${m.id} mode...`,
                        desc: m.desc
                    };

                    if (!PROMPT_MODE_ORDER.includes(m.id)) {
                        PROMPT_MODE_ORDER.push(m.id);
                        MODE_PROMPT_FILES[m.id] = promptFile;
                        PROMPT_FILE_MODES[promptFile] = m.id;
                    }

                    dynamicModes.push(m.id);
                    MODE_LABELS[m.id] = m.name || m.id;

                    SLASH_COMMANDS.push({
                        cmd: `/${m.id}`,
                        desc: m.desc || `Switch to ${m.name || m.id} mode`
                    });
                }
            }
        }
    }
    renderModeTabs();
}

// --- AST_EXPORTS_START ---
window.refreshCustomModes = refreshCustomModes;
// --- AST_EXPORTS_END ---

// --- registerPromptsVirtualFile.js ---
function registerPromptsVirtualFile() {
    registry.meta[CUSTOM_TOOLS_DIR] = { kind: 'directory' };
    registry.meta[PROMPTS_DIR] = { kind: 'directory' };
    PROMPT_MODE_ORDER.forEach(mode => {
        const filepath = MODE_PROMPT_FILES[mode];
        const text = promptFileContent(mode);
        registry.files[filepath] = text;
        registry.meta[filepath] = { kind: 'file', size: text.length, isBinary: false, virtual: true };
    });
}

// --- AST_EXPORTS_START ---
window.registerPromptsVirtualFile = registerPromptsVirtualFile;
// --- AST_EXPORTS_END ---

// --- renderModeTabs.js ---
function renderModeTabs() {
    const group = document.querySelector('.mode-segmented-group');
    if (!group) return;

    const modesToShow = ['plan', 'ask', 'code', ...dynamicModes];

    group.innerHTML = modesToShow.map(mode => {
        const cfg = MODE_CONFIG[mode];
        if (!cfg) return '';
        const isActive = state.mode === mode;
        return `
            <button class="mode-tab-btn ${isActive ? 'active' : ''}" data-mode="${mode}" title="${escapeHTML(cfg.desc || cfg.placeholder)}">
                <span class="icon" style="font-size:13px;">${escapeHTML(cfg.icon)}</span>
                <span>${escapeHTML(cfg.name)}</span>
            </button>
        `;
    }).join('');

    let styleEl = document.getElementById('dynamic-modes-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-modes-style';
        document.head.appendChild(styleEl);
    }

    styleEl.innerHTML = dynamicModes.map(mode => {
        const cfg = MODE_CONFIG[mode];
        const colorVarMatch = cfg.color.match(/var\(--([^)]+)\)/);
        const rgbVar = colorVarMatch ? `var(--${colorVarMatch[1]}-rgb)` : '255,255,255';

        return `
            .mode-tab-btn.active[data-mode="${mode}"] {
                background: rgba(${rgbVar}, 0.2); color: ${cfg.color}; font-weight: 700;
            }
            .mode-chat-chip.${mode} {
                background: rgba(${rgbVar}, 0.12); border: 1px solid rgba(${rgbVar}, 0.35); color: ${cfg.color};
            }
        `;
    }).join('\n');

    modeTabBtns = document.querySelectorAll('.mode-tab-btn');
    modeTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setMode(btn.getAttribute('data-mode'));
            focusPrompt();
        });
    });
}

// --- AST_EXPORTS_START ---
window.renderModeTabs = renderModeTabs;
// --- AST_EXPORTS_END ---

// --- renderPlanActionCard.js ---
function renderPlanActionCard(summaryMessage) {
    const card = document.createElement('div');
    card.className = 'plan-action-card log-entry';
    card.innerHTML = normalizeBlockHTML(`
        <div class="plan-action-header">
            <span class="icon" style="font-size:16px;">assignment_turned_in</span>
            <span>Plan Ready in ${PLAN_FILE}</span>
        </div>
        <div class="plan-action-body md-content">
            ${formatMarkdownSnippet(summaryMessage || "Implementation plan generated. You can review or edit the plan in the editor, or proceed directly to execution.")}
        </div>
        <div class="plan-action-btns">
            <button class="btn-plan-exec" onclick="window.executePlan()">
                <span class="icon" style="font-size:14px;">play_arrow</span>
                <span>Execute Plan in Code Mode</span>
            </button>
            <button class="btn-plan-edit" onclick="openFileTab('${PLAN_FILE}')">
                <span class="icon" style="font-size:14px;">edit_note</span>
                <span>Open ${PLAN_FILE} in Editor</span>
            </button>
        </div>
    `);
    term.appendChild(card);
    reorderSpinnerToBottom();
    smartScroll();
}

// --- AST_EXPORTS_START ---
window.renderPlanActionCard = renderPlanActionCard;
// --- AST_EXPORTS_END ---

// --- renderPromptTemplate.js ---
function renderPromptTemplate(template, vars) {
    return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
    });
}

// --- AST_EXPORTS_START ---
window.renderPromptTemplate = renderPromptTemplate;
// --- AST_EXPORTS_END ---

// --- renderQueuedPromptBanner.js ---
function renderQueuedPromptBanner() {
    const queued = state.queuedPrompts[state.activeSessionId];
    const row = document.getElementById('prompt-input-row');
    if (!queued) {
        queuedPromptBanner.style.display = 'none';
        queuedPromptBanner.innerHTML = '';
        if (row) row.classList.remove('has-queued-prompt');
        return;
    }
    queuedPromptBanner.style.display = 'flex';
    if (row) row.classList.add('has-queued-prompt');
    queuedPromptBanner.innerHTML = `
        <span class="icon">schedule</span>
        <span class="queued-prompt-text">Queued: ${escapeHTML(queued.val || '(referenced items)')}</span>
        <button class="queued-prompt-cancel" title="Cancel queued prompt">
            <span class="icon" style="font-size:13px;">close</span>
        </button>
    `;
    queuedPromptBanner.querySelector('.queued-prompt-cancel').addEventListener('click', () => {
        delete state.queuedPrompts[state.activeSessionId];
        renderQueuedPromptBanner();
    });
}

// --- AST_EXPORTS_START ---
window.renderQueuedPromptBanner = renderQueuedPromptBanner;
// --- AST_EXPORTS_END ---

// --- resizePrompt.js ---
function resizePrompt() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

// --- AST_EXPORTS_START ---
window.resizePrompt = resizePrompt;
// --- AST_EXPORTS_END ---

// --- saveModePrompts.js ---
function saveModePrompts() {
    localStorage.setItem('mode_prompts_json', JSON.stringify(MODE_PROMPTS));
    registerPromptsVirtualFile();
    for (const mode of PROMPT_MODE_ORDER) {
        writeAgentFileToDisk(MODE_PROMPT_FILES[mode], promptFileContent(mode));
    }
}

// --- AST_EXPORTS_START ---
window.saveModePrompts = saveModePrompts;
// --- AST_EXPORTS_END ---

// --- seedDefaultModePrompts.js ---
function seedDefaultModePrompts() {
    return {
        plan: `You are in PLAN MODE.

RULES:
1. FIRST call find(pattern="*") to list all files before acting.

YOUR OBJECTIVE:
Analyze the codebase and construct a comprehensive, step-by-step implementation plan for the requested task.
Save the complete plan into '{{planFile}}' using write('{{planFile}}', content).`,
        ask: `You are in ASK MODE (Read-only Q&A & Code Analysis).

RULES:
1. FIRST call find(pattern="*") to list all files before acting.
2. You are strictly read-only. Do not attempt to modify, edit, or write any files.
3. Provide concise, accurate explanations with code reference.`,
        code: `You are in CODE MODE (Full Autonomous Implementation).

CRITICAL RULES:
1. FIRST call find(pattern="*") to list all files before acting.
2. SURGICAL EDITS: ALWAYS use edit(filepath, search_block, replace_block) for existing code.
3. PRESERVE INDENTATION: Never change tab/space styles.`,
        title: `You generate concise session titles. Reply with a single short title (5-8 words), no punctuation, no explanation.`
    };
}

// --- AST_EXPORTS_START ---
window.seedDefaultModePrompts = seedDefaultModePrompts;
// --- AST_EXPORTS_END ---

// --- setMode.js ---
function setMode(mode) {
    if (!MODE_CONFIG[mode]) return;
    const previousMode = state.mode;
    const isActualChange = previousMode !== mode;
    state.mode = mode;

    modeTabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });

    const cfg = MODE_CONFIG[mode];
    input.placeholder = cfg.placeholder;
    updatePromptSendButton();

    if (!isSessionRunning(state.activeSessionId)) {
        statusModeBadge.innerText = cfg.name;
        statusModeBadge.className = `status-badge ${cfg.badgeClass}`;
        if (!['mode-plan', 'mode-ask', 'mode-code'].includes(cfg.badgeClass)) {
            statusModeBadge.style.backgroundColor = cfg.color;
        } else {
            statusModeBadge.style.backgroundColor = '';
        }
    }

    try { localStorage.setItem('last_mode', mode); } catch(e) {}

    if (isActualChange) {
        const s = state.sessions[state.activeSessionId];
        if (s) s.pendingModeNotice = { from: previousMode, to: mode };
    }
}

// --- AST_EXPORTS_START ---
window.setMode = setMode;
// --- AST_EXPORTS_END ---

// --- stripPromptFileHeader.js ---
function stripPromptFileHeader(text) {
    const lines = String(text || '').split('\n');
    let i = 0;
    while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) {
        i++;
    }
    return lines.slice(i).join('\n').trim();
}

// --- AST_EXPORTS_START ---
window.stripPromptFileHeader = stripPromptFileHeader;
// --- AST_EXPORTS_END ---

// --- updatePromptSendButton.js ---
function updatePromptSendButton() {
    const cfg = MODE_CONFIG[state.mode] || MODE_CONFIG.code;
    updateGenGlow();
    if (isSessionRunning(state.activeSessionId)) {
        promptSymbol.className = 'running';
        promptSymbol.innerHTML = '<span class="stop-rect"></span>';
        const g = state.sessions[state.activeSessionId]?._gen;
        promptSymbol.title = g && g.compressionInFlight ? 'Stop compression (Esc)' : 'Stop generation (Esc)';
    } else {
        promptSymbol.className = cfg.symbolClass;
        promptSymbol.innerText = '>';
        promptSymbol.title = 'Send prompt';
    }
}

// --- AST_EXPORTS_START ---
window.updatePromptSendButton = updatePromptSendButton;
// --- AST_EXPORTS_END ---

// --- updateStatusInfo.js ---
function updateStatusInfo() {
    const modCount = state.modifiedFiles.size;
    const added = state.linesAdded || 0;
    const removed = state.linesRemoved || 0;
    const statusInfoEl = document.getElementById('status-info');
    if (modCount > 0) {
        let html = escapeHTML(`${modCount} modified`);
        if (added || removed) {
            html += ', ';
            if (added) html += `<span style="color: var(--green);">+${added}</span>`;
            if (added && removed) html += ' ';
            if (removed) html += `<span style="color: var(--red);">-${removed}</span>`;
        }
        statusInfoEl.innerHTML = html;
    } else {
        statusInfoEl.innerHTML = '';
    }
}

// --- AST_EXPORTS_START ---
window.updateStatusInfo = updateStatusInfo;
// --- AST_EXPORTS_END ---
