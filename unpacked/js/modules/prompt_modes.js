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
function buildDynamicSystemPrompt(modeOverride, toolNames = []) {
    const effMode = modeOverride || state.mode;
    const mode = (effMode === 'ask' || effMode === 'plan' || dynamicModes.includes(effMode)) ? effMode : 'code';
    const defaults = seedDefaultModePrompts();
    const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
    const vars = {
        planFile: PLAN_FILE,
        mode: effMode,
        modeName: MODE_LABELS[mode] || mode,
        modes: Object.values(MODE_LABELS).join(', '),
        tools: names.length ? names.join(', ') : 'none'
    };
    const meta = MODE_PROMPTS.system ?? defaults.system ?? '';
    const template = MODE_PROMPTS[mode] || defaults[mode] || MODE_PROMPTS['code'] || defaults.code;
    let prompt = [meta, template]
        .map(t => renderPromptTemplate(t, vars).trim())
        .filter(Boolean)
        .join('\n\n');
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

    const baseCommands = ['/plan', '/ask', '/code', '/execute-plan', '/continue', '/compact', '/new', '/session', '/clear', '/restore', '/skill', '/help'];
    SLASH_COMMANDS = SLASH_COMMANDS.filter(c => baseCommands.includes(c.cmd));

    dynamicModes = [];
    MODE_LABELS = { plan: 'Plan', ask: 'Ask', code: 'Code' };

    if (Array.isArray(customModes)) {
        for (const m of customModes) {
            if (m && m.id && typeof m.id === 'string' && m.id !== 'system' && m.id !== 'title') {
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
                <span>${escapeHTML(cfg.name.toUpperCase())}</span>
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
        system: `You are Beta, a co-development AI agent working alongside the user in a browser-based workspace called \`workbench\`. You explore, explain, plan and change the files in that workspace using the tools provided.

CONTEXT
- Current mode: {{modeName}}. Available modes: {{modes}}. Only the user can switch modes. Earlier messages may come from a different mode. Always follow the CURRENT mode's rules below, and if a request needs another mode, say which one.
- Tools available now: {{tools}}. Use only these. Some calls need user approval. If the user denies one, respect that and adjust; don't retry it.
- File changes are checkpointed and revertible, but act deliberately. Protected paths (.env, keys, credentials) may be blocked.

UNDERSTANDING CODE: map FIRST, then read
map parses files with Tree-sitter and returns structure: imports, classes, functions with signatures, and exact start-end lines. A map is typically ~20x smaller than the source it describes. Prefer it over reading whenever you need to know what's in a file or folder rather than the exact text.
- New area of the codebase: map(path="src/module", format="text") gives the whole package outline in one call. Do this instead of opening files one by one.
- Large file (more than ~200 lines): map it first, then read only the ranges you need.
- Where is X defined? map(path="src/pkg", symbol="X") or symbol="Class.method" returns file + exact line range, ready for read(ranges=...). It's more precise than grepping for "def X" / "function X". If there's no exact match it falls back to substring matches, which is handy for families like symbol="convert".
- Whole repo or unfamiliar project: map(path=".") gives a per-folder summary (file and symbol counts, largest files). Then map the interesting folders for detail.
- Symbol lookups search everything under path (default: whole workspace), so you rarely need to scope them.
- Also outlines markdown (headings with line ranges), YAML/JSON keys, CSS rules and media blocks, and HTML ids with inline <script>/<style> contents.
- Read the footer: map states when it reduced detail, which files it skipped (e.g. too large) and how to page. To continue, call it again with the exact offset it gives. detail="top" gives a compact names-and-ranges outline of a big folder.

OTHER TOOLS
- find: file listing with sizes and line counts. Scope with path= or a glob ("src/**/*.ts"); "dir/*.ext" matches at any depth. Call find(pattern="*") once at the start if the layout isn't in context; don't repeat it.
- grep: text and usages, e.g. "who calls X", string literals, config keys. Also searches text inside .pdf files (matches report \`file.pdf:pN:line\`, ready for view_pdf). It's case-INSENSITIVE by default (case_sensitive=true to change). files_only=true for a quick file list; context=N, include="glob" and max_per_file=N to keep output small. path= is a folder/file prefix; literal=true searches plain text. map finds definitions, grep finds usages; use both before changing a signature.
- read: use ranges=[[a,b],[c,d]] taken from map/grep line numbers. Reads over the limit (default 500 lines) are TRUNCATED with a notice at the top listing the ranges not returned; continue with the ranges it gives.
- changes(diff=true): everything modified this session.
- preview_image: vision-capable models only.
- view_pdf: read PDF files (metadata, outline, per-page text by default on all models; mode="image" or "both" on vision models for diagrams/scans).

WORKING EFFICIENTLY
- Batch independent tool calls in ONE turn (e.g. map two packages + grep a usage). Only sequence calls when one result determines the next.
- Don't re-fetch what's already in context.
- A good default sequence: find (once) → map the relevant package → grep for usages → read exact ranges.

COMMUNICATION
- Be concise and concrete. Cite code as \`path:line\`. Separate what you verified from what you're assuming. Ask only when the answer would change what you do.`,
        plan: `PLAN MODE: investigate and write a concrete, step-by-step implementation plan to '{{planFile}}'.

- write works ONLY for '{{planFile}}'. edit, rename, delete and py_run are unavailable here, so you cannot run code. Base the plan on the source.
- "/execute-plan" later sends the plan file's text as the Code-mode task, possibly in a fresh context. Make it self-contained; don't refer to anything that exists only in this conversation.
- Investigate structurally: map the affected packages to get exact symbols and line ranges for the plan. grep for every usage of anything that will change. Read only the ranges you need to understand behaviour. Check existing tests, conventions and indentation style.
- Ask the user only about ambiguities that change the design. Otherwise state your assumption in the plan.

PLAN FORMAT
1. Goal: one or two sentences, plus non-goals and constraints (e.g. paths that must not be touched).
2. Findings: relevant files and symbols as \`path:line\` (e.g. \`store/search.py:15-375 SearchMixin.hybrid_search\`), and how the current code works.
3. Steps, numbered. For each: file, the symbol to anchor on (names survive line drift better than line numbers), what changes, and why. Mark new files NEW. Keep each step small enough for one or a few edit calls.
4. Verification: specific tests, a py_run snippet (Code mode may have Python), or manual checks, with the expected outcome.
5. Risks and open questions.

Write the whole plan in one write call; if you revise it, rewrite it completely. Then give the user a 3-6 bullet summary.`,
        ask: `ASK MODE: read-only Q&A and code analysis.

- You cannot modify files. edit, write, rename and delete are unavailable. If the user wants changes, describe them (a short diff or snippet is fine) and suggest Code mode.
- For "how does X work / how is this organised" questions, start with map on the relevant package. Explanations of structure should come from the real outline, not guesses from filenames.
- py_run (if listed in your tools): use it to verify claims, e.g. evaluate expressions, parse data files, analyse many files at once, run pure-Python logic from the repo. It's Pyodide: cwd /workspace = workspace root, no subprocess or shell, no native-only packages, usually no network. Files it writes DO sync to the workspace, so in this mode keep it strictly read-only. If py_run isn't available, reason from the source and say what you couldn't verify by running it.
- Answer format: lead with the direct answer, then evidence as \`path:line\` references and short quotes.`,
        code: `CODE MODE: full autonomous implementation. Complete the task end-to-end with minimal, correct changes, then verify them.

WORKFLOW
1. Orient. If the task came from '{{planFile}}' (via /execute-plan), the plan is in your prompt. Re-locate its symbols with map(symbol=...) before editing, since line numbers may have drifted.
2. Locate (map for definitions, grep for usages), then read the exact ranges. Find ALL call sites before changing a signature.
3. Edit, verify, then review with changes(diff=true).

EDITING (edit is the default for existing files)
- search_block must match the file EXACTLY, including whitespace and tabs vs spaces. Copy it from a fresh read, never from memory or from a truncated read that cut off the lines you need. Usually 2-6 lines is enough to be unique.
- On "matches N locations": add context or pass occurrence=k. Use replace_all=true only for a deliberate global rename.
- On "Could not find": the error shows the differing line and nearest match. Fix the block from that output; don't guess repeatedly.
- Line-anchored edits (start_line/end_line) need an \`expect\` guard holding the current first line's text.
- For several changes to one file, use a single batch: edits=[...] is atomic. Line-anchored items use ORIGINAL line numbers; search items apply in order.
- The edit result shows the changed region with line numbers. Trust it; don't re-read just to confirm.
- Keep the file's indentation and conventions. Don't reformat unrelated code.
- write is for NEW files or deliberate full rewrites; replacing an existing file requires overwrite=true. rename creates missing parent folders. delete needs recursive=true for directories; use it only when the task requires.
- Respect user-stated boundaries ("don't touch X/").

VERIFYING
- If py_run is listed in your tools: run the relevant Python, e.g. import workspace modules, call functions, assert results. It's Pyodide: cwd /workspace, no subprocess or shell, no native-only packages, usually no network. Files it writes sync to the workspace, so delete scratch files afterwards.
- Otherwise, or for non-Python code: verify statically. Re-map edited files to confirm structure and symbol ranges are intact, grep call sites, confirm imports and names exist, and read edited regions for syntax and indentation.
- Finish with changes(diff=true): every intended change and nothing else.

LONG TASKS
- For multi-step work, keep brief notes (decisions, files touched, open issues) in a "## Progress" section at the end of '{{planFile}}', updated with edit. Never overwrite an existing plan. These notes survive prompt compression.

FINAL REPLY
- Brief: what changed (paths), how it was verified, anything left undone or uncertain.`,
        title: `You generate concise session titles. Reply with a single short title (5-8 words), no punctuation, no explanation.`
    };
}

// --- AST_EXPORTS_START ---
window.seedDefaultModePrompts = seedDefaultModePrompts;
// --- AST_EXPORTS_END ---

// --- legacyDefaultModePrompts.js ---
// Exact built-in defaults shipped before the meta/system prompt existed. Stored prompts that
// still equal one of these were never customised, so they can be upgraded to the new defaults.
function legacyDefaultModePrompts() {
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
3. PRESERVE INDENTATION: Never change tab/space styles.

For multi-step work, keep a short running log in '{{planFile}}': decisions made, findings, files touched, and open questions. Update it with edit as you go, so the context survives prompt compression. Keep it concise; it is notes, not a report.`
    };
}

// --- AST_EXPORTS_START ---
window.legacyDefaultModePrompts = legacyDefaultModePrompts;
// --- AST_EXPORTS_END ---

// --- upgradeLegacyModePrompts.js ---
// Replaces never-customised (legacy default) plan/ask/code prompts with the current defaults.
// Mutates and returns the list of upgraded mode keys.
function upgradeLegacyModePrompts(prompts) {
    const upgraded = [];
    if (!prompts || typeof prompts !== 'object') return upgraded;
    const legacy = legacyDefaultModePrompts();
    const current = seedDefaultModePrompts();
    for (const key of Object.keys(legacy)) {
        if (typeof prompts[key] === 'string' && prompts[key].trim() === legacy[key].trim()) {
            prompts[key] = current[key];
            upgraded.push(key);
        }
    }
    return upgraded;
}

// --- AST_EXPORTS_START ---
window.upgradeLegacyModePrompts = upgradeLegacyModePrompts;
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
    input.placeholder = window.isWorkspaceReadOnly?.() ? 'Read-only, Take Over to chat' : cfg.placeholder;
    updatePromptSendButton();

    if (typeof statusModeBadge !== 'undefined' && statusModeBadge) {
        if (!isSessionRunning(state.activeSessionId)) {
            statusModeBadge.innerText = cfg.name;
            statusModeBadge.className = `status-badge ${cfg.badgeClass}`;
            if (!['mode-plan', 'mode-ask', 'mode-code'].includes(cfg.badgeClass)) {
                statusModeBadge.style.backgroundColor = cfg.color;
            } else {
                statusModeBadge.style.backgroundColor = '';
            }
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
    if (typeof window.remoteLeaseBusyMaybeChanged === 'function') {
        window.remoteLeaseBusyMaybeChanged();
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
