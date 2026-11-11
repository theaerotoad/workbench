// --- applySearchReplace.js ---
// Applies a search/replace edit, preserving the file's LF/CRLF style and falling back to a trim-insensitive line match.
// Returns { content, lineNumber }; throws if the search block isn't found.
function applySearchReplace(original, searchBlock, replaceBlock) {
    // Treat the file as CRLF if it contains any CRLF pair, otherwise LF.
    const usesCRLF = String(original == null ? '' : original).includes('\r\n');

    // Normalize all inputs to bare LF so matching is EOL-agnostic.
    const normalize = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');

    // Convert a normalized (LF-only) result back to the file's EOL style.
    const toFileEol = s => usesCRLF ? s.replace(/\n/g, '\r\n') : s;

    const orig   = normalize(original);
    const sBlock = normalize(searchBlock);
    const rBlock = normalize(replaceBlock);

    // Fast path: exact match; indexOf + slice keeps '$' in the replacement literal.
    const directIdx = orig.indexOf(sBlock);
    if (directIdx !== -1) {
        const before = orig.slice(0, directIdx);
        const after  = orig.slice(directIdx + sBlock.length);
        const res = before + rBlock + after;
        const startLine = before.split('\n').length;
        return { content: toFileEol(res), lineNumber: startLine };
    }

    // Fallback: line-by-line trim-aware match for indentation or trailing-whitespace drift.
    const origLines = orig.split('\n');
    const sLines    = sBlock.split('\n');
    const rLines    = rBlock.split('\n');
    const fileIndent = detectIndentation(origLines);

    let matchIdx = -1;
    for (let i = 0; i <= origLines.length - sLines.length; i++) {
        let match = true;
        for (let j = 0; j < sLines.length; j++) {
            if (origLines[i + j].trim() !== sLines[j].trim()) {
                match = false;
                break;
            }
        }
        if (match) {
            matchIdx = i;
            break;
        }
    }

    if (matchIdx !== -1) {
        const origLead = origLines[matchIdx].match(/^\s*/)[0];
        const sLead    = sLines[0].match(/^\s*/)[0];

        const adjustedRLines = rLines.map((line) => {
            if (!line.trim()) return '';
            const curLead = line.match(/^\s*/)[0];
            const lineContent = line.slice(curLead.length);

            let relativeIndent = '';
            if (curLead.startsWith(sLead)) {
                relativeIndent = curLead.slice(sLead.length);
            } else {
                relativeIndent = curLead;
            }

            if (fileIndent.type === 'tab') {
                relativeIndent = relativeIndent.replace(/ {4}/g, '\t').replace(/ {2}/g, '\t');
            }

            return origLead + relativeIndent + lineContent;
        });

        const before = origLines.slice(0, matchIdx).join('\n');
        const after  = origLines.slice(matchIdx + sLines.length).join('\n');
        const res = (before ? before + '\n' : '') + adjustedRLines.join('\n') + (after ? '\n' + after : '');
        return { content: toFileEol(res), lineNumber: matchIdx + 1 };
    }

    throw new Error("Could not find search_block in target file.");
}

// --- AST_EXPORTS_START ---
window.applySearchReplace = applySearchReplace;
// --- AST_EXPORTS_END ---

// --- attachAssistantCopyAction.js ---
function attachAssistantCopyAction(div, rawText) {
    if (!div || !document.body.contains(div)) return;
    const text = String(rawText || '');
    if (!text.trim()) return;
    div.setAttribute('data-raw-msg', text);
    if (div.querySelector('.assistant-msg-actions') || div.querySelector('.btn-prompt-action.copy')) return;

    const btnHTML = `<button class="btn-prompt-action artifact" title="Extract to File (LLM)" onclick="window.extractMessageArtifact(this)"><span class="icon" style="font-size:13px;">auto_awesome</span></button>` +
                    `<button class="btn-prompt-action copy" title="Copy message" onclick="window.copyAssistantMsg(this)"><span class="icon" style="font-size:13px;">content_copy</span></button>`;

    const actions = document.createElement('div');
    actions.className = 'prompt-actions assistant-msg-actions';
    actions.innerHTML = btnHTML;
    div.appendChild(actions);
}

// --- AST_EXPORTS_START ---
window.attachAssistantCopyAction = attachAssistantCopyAction;
// --- AST_EXPORTS_END ---

// --- cleanupText.js ---
function cleanupText(text) {
    if (text === undefined) return '';
    let s = String(text);

    const sampleLen = Math.min(s.length, 4096);
    const sample = s.slice(0, sampleLen);
    const nullCount = (sample.match(/\u0000/g) || []).length;
    const nonPrintableCount = (sample.match(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g) || []).length;
    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
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
    s = s.split('\n').map(line => {
        if (line.length > MAX_LINE_CHARS) {
            return line.slice(0, MAX_LINE_CHARS) + ` […line truncated, ${line.length - MAX_LINE_CHARS} more chars]`;
        }
        return line;
    }).join('\n');
    if (s.length > MAX_TOTAL_CHARS) {
        s = s.slice(0, MAX_TOTAL_CHARS) + `\n\n[…output truncated: ${s.length - MAX_TOTAL_CHARS} more characters omitted]`;
    }

    return s
        .replace(/\s+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// --- AST_EXPORTS_START ---
window.cleanupText = cleanupText;
// --- AST_EXPORTS_END ---

// --- detectIndentation.js ---
function detectIndentation(lines) {
    for (const line of lines) {
        if (line.startsWith('\t')) return { type: 'tab', char: '\t' };
        if (line.startsWith('    ')) return { type: 'space4', char: '    ' };
        if (line.startsWith('  ')) return { type: 'space2', char: '  ' };
    }
    return { type: 'space4', char: '    ' };
}

// --- AST_EXPORTS_START ---
window.detectIndentation = detectIndentation;
// --- AST_EXPORTS_END ---

// --- renderMermaidBlock.js ---
const mermaidSvgCache = new Map();
const mermaidPendingRenders = new Set();
const mermaidQueue = [];
let isMermaidQueueRunning = false;
let mermaidProcessTimer = null;

function unescapeHTML(str) {
    return String(str || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function getMermaidTheme() {
    return document.documentElement.classList.contains('theme-light') ? 'default' : 'dark';
}

function queueMermaidRender(blockId, rawCode, theme) {
    const cacheKey = `${theme}:${rawCode}`;
    if (mermaidSvgCache.has(cacheKey) || mermaidPendingRenders.has(blockId)) {
        return;
    }
    mermaidPendingRenders.add(blockId);
    mermaidQueue.push({ blockId, rawCode, theme, cacheKey });
    scheduleMermaidProcessing();
}

function scheduleMermaidProcessing() {
    if (mermaidProcessTimer) return;
    mermaidProcessTimer = setTimeout(() => {
        mermaidProcessTimer = null;
        processMermaidQueue();
    }, 16);
}

async function processMermaidQueue() {
    if (isMermaidQueueRunning) return;
    if (!mermaidQueue.length) return;

    if (!window.mermaid) {
        if (!window._mermaidLoadAttempts) window._mermaidLoadAttempts = 0;
        window._mermaidLoadAttempts++;
        if (window._mermaidLoadAttempts > 40) {
            while (mermaidQueue.length > 0) {
                const { blockId } = mermaidQueue.shift();
                mermaidPendingRenders.delete(blockId);
                document.querySelectorAll(`.mermaid-box[data-mermaid-id="${blockId}"]`).forEach(box => {
                    box.classList.add('show-code');
                    const rendered = box.querySelector('.mermaid-rendered');
                    if (rendered) {
                        rendered.innerHTML = '<span class="dim" style="font-size:11px;padding:8px;">Mermaid library unavailable</span>';
                    }
                });
            }
            return;
            }
        scheduleMermaidProcessing();
        return;
    }
    window._mermaidLoadAttempts = 0;

    isMermaidQueueRunning = true;
    try {
        while (mermaidQueue.length > 0) {
            const { blockId, rawCode, theme, cacheKey } = mermaidQueue.shift();
            mermaidPendingRenders.delete(blockId);

            let res = mermaidSvgCache.get(cacheKey);
            if (!res) {
                const renderId = 'm-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
                try {
                    window.mermaid.initialize({
                        startOnLoad: false,
                        theme: theme === 'default' ? 'default' : 'dark',
                        securityLevel: 'strict',
                        fontFamily: 'inherit'
                    });

                    const renderPromise = window.mermaid.render(renderId, rawCode);
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Rendering timed out')), 6000)
                    );
                    const { svg, bindFunctions } = await Promise.race([renderPromise, timeoutPromise]);
                    res = { svg, bindFunctions };
                    mermaidSvgCache.set(cacheKey, res);
                } catch (err) {
                    const msg = (err && (err.str || err.message)) || String(err || 'Failed to render diagram');
                    res = { error: msg };
                    mermaidSvgCache.set(cacheKey, res);
                } finally {
                    const stray1 = document.getElementById(renderId);
                    if (stray1 && stray1.parentElement === document.body) stray1.remove();
                    const stray2 = document.getElementById('d' + renderId);
                    if (stray2 && stray2.parentElement === document.body) stray2.remove();
                }
            }

            const targets = document.querySelectorAll(`.mermaid-box[data-mermaid-id="${blockId}"]`);
            targets.forEach(box => {
                const container = box.querySelector('.mermaid-rendered');
                if (!container) return;

                if (res.svg) {
                    container.innerHTML = res.svg;
                    if (typeof res.bindFunctions === 'function') {
                        try { res.bindFunctions(container); } catch (e) {}
                    }
                } else if (res.error) {
                    box.classList.add('show-code');
                    container.innerHTML = `<div class="mermaid-error"><span class="icon" style="font-size:14px;color:var(--red);">error</span><span>${escapeHTML(res.error)}</span></div>`;
                }
            });

            if (targets.length && typeof window.smartScroll === 'function') {
                window.smartScroll();
            }
        }
    } finally {
        isMermaidQueueRunning = false;
        if (mermaidQueue.length > 0) {
            scheduleMermaidProcessing();
        }
    }
}

function renderMermaidBlock(escapedCode) {
    const rawCode = unescapeHTML(escapedCode).trim();
    if (!rawCode) {
        return `<div class="code-box mermaid-box">
            <div class="code-header">
                <span class="tool-badge">mermaid</span>
            </div>
            <div class="mermaid-rendered"><span class="dim" style="font-size:11px;">(empty diagram)</span></div>
        </div>`;
    }

    const theme = getMermaidTheme();
    const cacheKey = `${theme}:${rawCode}`;
    const blockId = 'mmd-' + hashString(cacheKey);
    const cached = mermaidSvgCache.get(cacheKey);

    if (cached && cached.svg) {
        return `<div class="code-box mermaid-box" data-mermaid-id="${blockId}">
            <div class="code-header">
                <span class="tool-badge">mermaid</span>
                <div style="display:flex; gap:4px;">
                    <button class="btn-toggle-mermaid" type="button" title="Toggle code / preview" onclick="this.closest('.mermaid-box').classList.toggle('show-code')"><span class="icon" style="font-size:13px;">code</span></button>
                    <button class="btn-copy-code" type="button" title="Copy code"><span class="icon" style="font-size:13px;">content_copy</span></button>
                </div>
            </div>
            <div class="mermaid-rendered">${cached.svg}</div>
            <div class="code-box-content mermaid-code-view"><pre><code>${escapedCode}</code></pre></div>
        </div>`;
    }

    if (cached && cached.error) {
        return `<div class="code-box mermaid-box show-code" data-mermaid-id="${blockId}">
            <div class="code-header">
                <span class="tool-badge">mermaid</span>
                <div style="display:flex; gap:4px;">
                    <button class="btn-toggle-mermaid" type="button" title="Toggle code / preview" onclick="this.closest('.mermaid-box').classList.toggle('show-code')"><span class="icon" style="font-size:13px;">code</span></button>
                    <button class="btn-copy-code" type="button" title="Copy code"><span class="icon" style="font-size:13px;">content_copy</span></button>
                </div>
            </div>
            <div class="mermaid-error"><span class="icon" style="font-size:14px;color:var(--red);">error</span><span>${escapeHTML(cached.error)}</span></div>
            <div class="mermaid-rendered" style="display:none;"></div>
            <div class="code-box-content mermaid-code-view"><pre><code>${escapedCode}</code></pre></div>
        </div>`;
    }

    queueMermaidRender(blockId, rawCode, theme);

    return `<div class="code-box mermaid-box" data-mermaid-id="${blockId}">
        <div class="code-header">
            <span class="tool-badge">mermaid</span>
            <div style="display:flex; gap:4px;">
                <button class="btn-toggle-mermaid" type="button" title="Toggle code / preview" onclick="this.closest('.mermaid-box').classList.toggle('show-code')"><span class="icon" style="font-size:13px;">code</span></button>
                <button class="btn-copy-code" type="button" title="Copy code"><span class="icon" style="font-size:13px;">content_copy</span></button>
            </div>
        </div>
        <div class="mermaid-rendered">
            <div class="mermaid-loading">
                <span class="icon spinner-icon" style="font-size:13px;">sync</span>
                <span>Rendering diagram...</span>
            </div>
        </div>
        <div class="code-box-content mermaid-code-view"><pre><code>${escapedCode}</code></pre></div>
    </div>`;
}

if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && !window._mermaidThemeObserver) {
    window._lastMermaidTheme = document.documentElement.classList.contains('theme-light') ? 'default' : 'dark';
    window._mermaidThemeObserver = new MutationObserver(() => {
        const curTheme = document.documentElement.classList.contains('theme-light') ? 'default' : 'dark';
        if (window._lastMermaidTheme !== curTheme) {
            window._lastMermaidTheme = curTheme;
            document.querySelectorAll('.mermaid-box').forEach(box => {
                const codeEl = box.querySelector('.mermaid-code-view pre code');
                if (!codeEl) return;
                const rawCode = unescapeHTML(codeEl.innerHTML).trim();
                if (!rawCode) return;
                const cacheKey = `${curTheme}:${rawCode}`;
                const newBlockId = 'mmd-' + hashString(cacheKey);
                box.setAttribute('data-mermaid-id', newBlockId);
                const cached = mermaidSvgCache.get(cacheKey);
                const rendered = box.querySelector('.mermaid-rendered');
                if (rendered) {
                    if (cached && cached.svg) {
                        rendered.innerHTML = cached.svg;
                        if (typeof cached.bindFunctions === 'function') {
                            try { cached.bindFunctions(rendered); } catch (e) {}
                        }
                    } else {
                        rendered.innerHTML = '<div class="mermaid-loading"><span class="icon spinner-icon" style="font-size:13px;">sync</span><span>Rendering diagram...</span></div>';
                        queueMermaidRender(newBlockId, rawCode, curTheme);
                    }
                }
            });
        }
    });
    window._mermaidThemeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class']
    });
}

// --- AST_EXPORTS_START ---
window.renderMermaidBlock = renderMermaidBlock;
// --- AST_EXPORTS_END ---

// --- renderSvgBlock.js ---
function renderSvgBlock(escapedCode) {
    const rawCode = unescapeHTML(escapedCode).trim();
    if (!rawCode.toLowerCase().startsWith('<svg')) {
        return `<div class="code-box svg-box show-code">
            <div class="code-header">
                <span class="tool-badge">svg</span>
                <div style="display:flex; gap:4px; margin-left:auto;">
                    <button class="btn-toggle-svg" type="button" title="Toggle code / preview" onclick="this.closest('.svg-box').classList.toggle('show-code')"><span class="icon" style="font-size:13px;">code</span></button>
                    <button class="btn-copy-code" type="button" title="Copy code"><span class="icon" style="font-size:13px;">content_copy</span></button>
                </div>
            </div>
            <div class="svg-error"><span class="icon" style="font-size:14px;color:var(--red);">error</span><span>Invalid SVG: Must start with &lt;svg</span></div>
            <div class="code-box-content svg-code-view"><pre><code>${escapedCode}</code></pre></div>
        </div>`;
    }

    return `<div class="code-box svg-box">
        <div class="code-header">
            <span class="tool-badge">svg</span>
            <div style="display:flex; gap:4px; margin-left:auto;">
                <button class="btn-toggle-svg" type="button" title="Toggle code / preview" onclick="this.closest('.svg-box').classList.toggle('show-code')"><span class="icon" style="font-size:13px;">code</span></button>
                <button class="btn-copy-code" type="button" title="Copy code"><span class="icon" style="font-size:13px;">content_copy</span></button>
            </div>
        </div>
        <div class="svg-rendered">${rawCode}</div>
        <div class="code-box-content svg-code-view"><pre><code>${escapedCode}</code></pre></div>
    </div>`;
}

// --- AST_EXPORTS_START ---
window.renderSvgBlock = renderSvgBlock;
// --- AST_EXPORTS_END ---

// --- resolveRelativePath.js ---
function resolveRelativePath(baseFileOrDir, relPath) {
    if (!relPath) return '';
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(relPath)) return relPath;

    let cleanRel = relPath.split('?')[0].split('#')[0];
    try { cleanRel = decodeURIComponent(cleanRel); } catch (e) {}

    const isRootRelative = cleanRel.startsWith('/') || cleanRel.startsWith('\\');
    cleanRel = cleanRel.replace(/^[/\\]+/, '');

    let dirParts = [];
    if (baseFileOrDir && !isRootRelative) {
        const parts = baseFileOrDir.split('/').filter(Boolean);
        parts.pop();
        dirParts = parts;
    }

    const segments = cleanRel.split(/[/\\]+/).filter(Boolean);
    const resolved = [...dirParts];
    for (const seg of segments) {
        if (seg === '.') continue;
        if (seg === '..') {
            if (resolved.length > 0) resolved.pop();
        } else {
            resolved.push(seg);
        }
    }
    return resolved.join('/');
}

// --- AST_EXPORTS_START ---
window.resolveRelativePath = resolveRelativePath;
// --- AST_EXPORTS_END ---

// --- formatMarkdownSnippet.js ---
function formatMarkdownSnippet(text, basePath = "") {
    if (!text) return "";
    const cleanText = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let html = escapeHTML(cleanText);

    const codeBlocks = [];
    html = html.replace(/```[ \t]*(\w*)[ \t]*\n?([\s\S]*?)```/g, (match, lang, code) => {
        const idx = codeBlocks.length;
        const normalizedLang = (lang || '').trim().toLowerCase();
        if (normalizedLang === 'mermaid') {
            codeBlocks.push(renderMermaidBlock(code));
        } else if (normalizedLang === 'svg') {
            codeBlocks.push(renderSvgBlock(code));
        } else {
            codeBlocks.push(`<div class="code-box">
                <div class="code-header">
                    <span class="tool-badge">${escapeHTML(lang || 'code')}</span>
                    <div style="display:flex; gap:4px; margin-left:auto;">
                        <button class="icon-btn" style="color:var(--dim); padding:4px;" title="Save as File" onclick="window.saveCodeArtifact(this)"><span class="icon" style="font-size:13px;">save</span></button>
                        <button class="btn-copy-code" title="Copy code"><span class="icon" style="font-size:13px;">content_copy</span></button>
                    </div>
                </div>
                <div class="code-box-content"><pre><code>${code}</code></pre></div>
            </div>`);
        }
        return `\u0000CODEBLOCK${idx}\u0000`;
    });

    if (html.includes('```')) {
        const lastIndex = html.lastIndexOf('```');
        const afterLast = html.slice(lastIndex + 3);
        const newlineIdx = afterLast.indexOf('\n');
        const lang = newlineIdx !== -1 ? afterLast.slice(0, newlineIdx) : '';
        const code = newlineIdx !== -1 ? afterLast.slice(newlineIdx + 1) : '';
        const idx = codeBlocks.length;
        codeBlocks.push(`<div class="code-box">
            <div class="code-header">
                <span class="tool-badge">${escapeHTML(lang || 'code')} (generating...)</span>
            </div>
            <div class="code-box-content"><pre><code>${code}</code></pre></div>
        </div>`);
        html = html.slice(0, lastIndex) + `\u0000CODEBLOCK${idx}\u0000`;
    }

    const inlineCodes = [];
    html = html.replace(/`([^`\n]+)`/g, (match, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(`<span class="md-inline-code">${code}</span>`);
        return `\u0000ICODE${idx}\u0000`;
    });

    const mathBlocks = [];
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
        const idx = mathBlocks.length;
        if (window.katex) {
            try {
                let tex = math.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
                mathBlocks.push(window.katex.renderToString(tex, { displayMode: true, throwOnError: false }));
            } catch (e) {
                mathBlocks.push(`<span style="color:var(--red);" title="KaTeX error: ${e.message}">${match}</span>`);
            }
        } else {
            mathBlocks.push(match);
        }
        return `\u0000MATH${idx}\u0000`;
    });

    html = html.replace(/\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g, (match, math) => {
        const idx = mathBlocks.length;
        if (window.katex) {
            try {
                let tex = math.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
                mathBlocks.push(window.katex.renderToString(tex, { displayMode: false, throwOnError: false }));
            } catch (e) {
                mathBlocks.push(`<span style="color:var(--red);" title="KaTeX error: ${e.message}">${match}</span>`);
            }
        } else {
            mathBlocks.push(match);
        }
        return `\u0000MATH${idx}\u0000`;
    });

    // Restore safe inline HTML tags that are commonly used in Markdown (e.g., inside tables or text).
    // Only tags without attributes are unescaped to prevent XSS.
    html = html.replace(/&lt;(\/?(?:br|ul|li|ol|b|i|u|strong|em|hr|table|thead|tbody|tr|th|td|kbd|details|summary|sup|sub|p|span|div)\s*\/?)&gt;/gi, '<$1>');

    const lines = html.split('\n');
    const out = [];
    let listStack = [];
    let inBlockquote = false;
    let paragraphBuf = [];

    function closeLists(toIndent = -1) {
        while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
            const top = listStack.pop();
            if (top.liOpen) out.push('</li>');
            out.push(`</${top.type}>`);
        }
    }
    function flushParagraph() {
        if (paragraphBuf.length) {
            out.push(`<p>${paragraphBuf.join('<br>')}</p>`);
            paragraphBuf = [];
        }
    }
    function closeBlockquote() {
        if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
    }

    function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line) || (/\|/.test(line) && line.trim().length); }
    function isTableSeparator(line) { return /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(line); }
    function splitTableRow(line) {
        let l = line.trim();
        if (l.startsWith('|')) l = l.slice(1);
        if (l.endsWith('|')) l = l.slice(0, -1);
        return l.split('|').map(c => c.trim());
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1])) {
            flushParagraph(); closeLists(); closeBlockquote();
            const headerCells = splitTableRow(line);
            const aligns = splitTableRow(lines[i + 1]).map(c => {
                const l = c.startsWith(':'), r = c.endsWith(':');
                return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
            });
            let j = i + 2;
            const rows = [];
            while (j < lines.length && isTableRow(lines[j]) && lines[j].trim()) {
                rows.push(splitTableRow(lines[j]));
                j++;
            }
            let tableHTML = '<table class="md-table"><thead><tr>';
            headerCells.forEach((c, ci) => { tableHTML += `<th${aligns[ci] ? ` style="text-align:${aligns[ci]}"` : ''}>${inlineMarkdown(c, basePath)}</th>`; });
            tableHTML += '</tr></thead><tbody>';
            rows.forEach(r => {
                tableHTML += '<tr>';
                r.forEach((c, ci) => { tableHTML += `<td${aligns[ci] ? ` style="text-align:${aligns[ci]}"` : ''}>${inlineMarkdown(c, basePath)}</td>`; });
                tableHTML += '</tr>';
            });
            tableHTML += '</tbody></table>';
            out.push(tableHTML);
            i = j - 1;
            continue;
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushParagraph(); closeLists(); closeBlockquote();
            out.push('<hr>');
            continue;
        }

        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            flushParagraph(); closeLists(); closeBlockquote();
            const level = headingMatch[1].length;
            out.push(`<h${level} class="md-heading">${inlineMarkdown(headingMatch[2], basePath)}</h${level}>`);
            continue;
        }

        const bqMatch = line.match(/^\s*&gt;\s?(.*)$/);
        if (bqMatch) {
            flushParagraph(); closeLists();
            if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true; }
            out.push(`<div>${inlineMarkdown(bqMatch[1], basePath)}</div>`);
            continue;
        } else {
            closeBlockquote();
        }

        const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
        const olMatch = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
        if (ulMatch || olMatch) {
            flushParagraph();
            const [, indentStr, content] = ulMatch || olMatch;
            const indent = Math.floor(indentStr.length / 2);
            const type = ulMatch ? 'ul' : 'ol';

            while (listStack.length && (listStack[listStack.length - 1].indent > indent ||
                   (listStack[listStack.length - 1].indent === indent && listStack[listStack.length - 1].type !== type))) {
                const top = listStack.pop();
                if (top.liOpen) out.push('</li>');
                out.push(`</${top.type}>`);
                if (listStack.length) listStack[listStack.length - 1].liOpen = true;
            }

            if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
                out.push(`<${type}>`);
                listStack.push({ type, indent, liOpen: false });
            } else {
                if (listStack[listStack.length - 1].liOpen) out.push('</li>');
            }
            out.push(`<li>${inlineMarkdown(content, basePath)}`);
            listStack[listStack.length - 1].liOpen = true;
            continue;
        } else {
            closeLists();
        }

        if (!line.trim()) {
            flushParagraph();
            continue;
        }

        if (/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())) {
            flushParagraph();
            out.push(line.trim());
            continue;
        }

        paragraphBuf.push(inlineMarkdown(line, basePath));
    }
    flushParagraph();
    closeLists();
    closeBlockquote();

    html = out.join('');

    html = html.replace(/\u0000ICODE(\d+)\u0000/g, (m, i) => inlineCodes[Number(i)]);
    html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)]);
    html = html.replace(/\u0000MATH(\d+)\u0000/g, (m, i) => mathBlocks[Number(i)]);

    return html;
}

// --- AST_EXPORTS_START ---
window.formatMarkdownSnippet = formatMarkdownSnippet;
// --- AST_EXPORTS_END ---

// --- inlineMarkdown.js ---
function inlineMarkdown(text, basePath = "") {
    let s = text;

    // Parse images: ![alt](url "title")
    s = s.replace(/!\[([^\]\n]*)\]\(([\s\S]*?)\)/g, (m, alt, target) => {
        target = (target || '').trim();
        if (!target) return m;

        let url = target;
        let title = '';
        const titleMatch = target.match(/^([^\s]+)(?:\s+(?:&quot;|&#39;|["'])(.*?)(?:&quot;|&#39;|["']))?$/);
        if (titleMatch) {
            url = titleMatch[1];
            title = titleMatch[2] || '';
        }

        if (/^javascript:/i.test(url.trim())) return escapeHTML(m);

        const isWebOrData = /^(?:https?:|data:image\/|blob:|\/\/)/i.test(url);
        const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
        const altAttr = alt ? alt.replace(/"/g, '&quot;') : '';

        if (isWebOrData) {
            return `<img class="md-image" src="${url}" alt="${altAttr}"${titleAttr} loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('md-image-error');" />`;
        } else {
            const fileBase = basePath || '';
            const resolvedPath = resolveRelativePath(fileBase, url);
            const baseAttr = fileBase ? ` data-base-path="${fileBase.replace(/"/g, '&quot;')}"` : '';
            const resolvedAttr = resolvedPath ? ` data-resolved-path="${resolvedPath.replace(/"/g, '&quot;')}"` : '';
            const placeholder = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 1 1\'%3E%3C/svg%3E';
            return `<img class="md-image md-image-loading" src="${placeholder}" data-src="${url.replace(/"/g, '&quot;')}"${resolvedAttr}${baseAttr} alt="${altAttr}"${titleAttr} loading="lazy" />`;
        }
    });

    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|#[^\s)]*)\)/g, (m, label, url) => {
        if (/^javascript:|^data:/i.test(url)) return escapeHTML(m);
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`;
    });
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, (m, pre, inner) => `${pre}<em>${inner}</em>`);
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s;
}

// --- AST_EXPORTS_START ---
window.inlineMarkdown = inlineMarkdown;
// --- AST_EXPORTS_END ---

// --- resolveMarkdownImages.js ---
async function resolveMarkdownImages(container, basePath = '') {
    if (!container) return;
    const images = container.querySelectorAll('img[data-src]:not([data-resolved])');
    if (!images.length) return;

    for (const img of images) {
        img.setAttribute('data-resolved', 'pending');
        const rawSrc = img.getAttribute('data-src');
        if (!rawSrc) continue;

        if (/^(?:https?:|data:|blob:|\/\/)/i.test(rawSrc)) {
            img.src = rawSrc;
            img.classList.remove('md-image-loading');
            img.setAttribute('data-resolved', 'true');
            continue;
        }

        const fileBase = img.getAttribute('data-base-path') || basePath || '';
        const targetPath = img.getAttribute('data-resolved-path') || resolveRelativePath(fileBase, rawSrc);

        try {
            let url = null;
            if (window.readImageBlobUrl) {
                url = await window.readImageBlobUrl(targetPath);
            }
            if (!url && window.readImageDataUrl) {
                url = await window.readImageDataUrl(targetPath);
            }
            if (!url && window.vfsReadBlob) {
                const blob = await window.vfsReadBlob(targetPath);
                if (blob) {
                    url = URL.createObjectURL(blob);
                }
            }

            if (url) {
                img.src = url;
                img.classList.remove('md-image-loading');
                img.setAttribute('data-resolved', 'true');
            } else {
                img.classList.remove('md-image-loading');
                img.classList.add('md-image-error');
                img.alt = `[Image not found: ${rawSrc}]`;
                img.setAttribute('data-resolved', 'failed');
            }
        } catch (e) {
            console.warn('Failed to resolve markdown image:', targetPath, e);
            img.classList.remove('md-image-loading');
            img.classList.add('md-image-error');
            img.alt = `[Failed to load image: ${rawSrc}]`;
            img.setAttribute('data-resolved', 'failed');
        }
    }
}

// --- AST_EXPORTS_START ---
window.resolveMarkdownImages = resolveMarkdownImages;
// --- AST_EXPORTS_END ---

let mdImageDebounceTimer = null;
function scheduleChatImageResolution() {
    if (mdImageDebounceTimer) return;
    mdImageDebounceTimer = setTimeout(() => {
        mdImageDebounceTimer = null;
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            resolveMarkdownImages(chatEl, '');
        }
    }, 50);
}

if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && !window._mdImageObserver) {
    window._mdImageObserver = new MutationObserver((mutations) => {
        let hasNewImages = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.tagName === 'IMG' && node.hasAttribute('data-src') && !node.hasAttribute('data-resolved')) {
                        hasNewImages = true;
                        break;
                    }
                    if (node.querySelector && node.querySelector('img[data-src]:not([data-resolved])')) {
                        hasNewImages = true;
                        break;
                    }
                }
            }
            if (hasNewImages) break;
        }
        if (hasNewImages) {
            scheduleChatImageResolution();
        }
    });

    const setupChatImageObserver = () => {
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            scheduleChatImageResolution();
            window._mdImageObserver.observe(chatEl, { childList: true, subtree: true });
        } else {
            setTimeout(setupChatImageObserver, 50);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupChatImageObserver);
    } else {
        setupChatImageObserver();
    }
}

// --- moveCopyActionIntoStatsRow.js ---
function moveCopyActionIntoStatsRow(targetDiv, statsRow) {
    const actionsRow = targetDiv.querySelector('.assistant-msg-actions');
    if (!actionsRow) return;
    const artifactBtn = actionsRow.querySelector('.btn-prompt-action.artifact');
    if (artifactBtn) {
        artifactBtn.style.marginLeft = 'auto';
        statsRow.appendChild(artifactBtn);
    }
    const copyBtn = actionsRow.querySelector('.btn-prompt-action.copy');
    if (copyBtn) {
        if (!artifactBtn) copyBtn.style.marginLeft = 'auto';
        statsRow.appendChild(copyBtn);
    }
    actionsRow.remove();
}

// --- AST_EXPORTS_START ---
window.moveCopyActionIntoStatsRow = moveCopyActionIntoStatsRow;
// --- AST_EXPORTS_END ---

// --- normalizeBlockHTML.js ---
function normalizeBlockHTML(html) {
    if (!html) return html;
    return html
        .replace(/>\s+</g, '><')
        .trim();
}

// --- AST_EXPORTS_START ---
window.normalizeBlockHTML = normalizeBlockHTML;
// --- AST_EXPORTS_END ---

// --- print.js ---
function print(html, cls = "", sessionId) {
    const sid = sessionId || state.activeSessionId;
    const isLive = sid === state.activeSessionId;

    if (!isLive) {
        const s = state.sessions[sid];
        if (s) {
            s.chatHTML = (s.chatHTML || '') + `<div class="log-entry ${cls}">${normalizeBlockHTML(html)}</div>`;
        }
        return null;
    }

    const el = document.createElement('div');
    el.className = `log-entry ${cls}`;
    el.innerHTML = normalizeBlockHTML(html);

    const gen = getGenState(sid);
    if (gen.spinEl && gen.spinEl.parentNode === term) {
        term.insertBefore(el, gen.spinEl);
    } else {
        term.appendChild(el);
    }

    smartScroll();
    return el;
}

// --- AST_EXPORTS_START ---
window.print = print;
// --- AST_EXPORTS_END ---

// --- renderGenStats.js ---
function renderGenStats(sessionId) {
    const sid = sessionId || state.activeSessionId;
    const gen = getGenState(sid);
    if (!gen.genStartTime) return;
    if (gen.genStatsRendered) return;
    gen.genStatsRendered = true;

    const elapsed = ((gen.genEndTime || performance.now()) - gen.genStartTime) / 1000;
    let tks;
    if (gen.genServerTks != null) {
        tks = gen.genServerTks.toFixed(1);
    } else {
        const tokenCount = gen.actualGenTokenCount != null ? gen.actualGenTokenCount : gen.genTokenCount;
        tks = tokenCount > 0 && elapsed > 0 ? (tokenCount / elapsed).toFixed(1) : null;
    }
    gen.genTks = tks;

    let reasonLabel = gen.genFinishReason || 'unknown';
    let reasonIcon = 'help';

    switch (gen.genFinishReason) {
        case 'stop': reasonIcon = 'check_circle'; reasonLabel = 'EOS stop'; break;
        case 'length': reasonIcon = 'timer'; reasonLabel = 'max length'; break;
        case 'tool_calls': reasonIcon = 'build'; reasonLabel = 'tool calls'; break;
        case 'content_filter': reasonIcon = 'block'; reasonLabel = 'content filter'; break;
        case 'abort': reasonIcon = 'cancel'; reasonLabel = 'aborted'; break;
        case 'error': reasonIcon = 'error'; reasonLabel = 'error'; break;
        case 'unknown': reasonIcon = 'warning'; reasonLabel = 'unknown (server omitted)'; break;
        case null:
        case undefined:
        case '': reasonIcon = 'warning'; reasonLabel = 'no finish_reason'; break;
        default: reasonIcon = 'help'; break;
    }

    const tksPill = tks ? `<span class="gen-stat-pill tks"><span class="icon" style="font-size:11px;">speed</span>${tks} tk/s</span>` : '';
    const reasonPill = `<span class="gen-stat-pill reason-null"><span class="icon" style="font-size:11px;">${reasonIcon}</span>${reasonLabel}</span>`;
    const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed/60)}m ${Math.round(elapsed%60)}s` : `${elapsed.toFixed(1)}s`;
    const continueBtn = gen.genFinishReason === 'abort' || gen.genFinishReason === 'error' || gen.genFinishReason === 'stop'
        ? `<button class="gen-stat-pill reason-tool_calls gen-continue-btn" style="cursor:pointer;" onclick="window.continueTask()" title="Continue generation"><span class="icon" style="font-size:11px;">play_arrow</span>Continue</button>`
        : '';

    if (sid !== state.activeSessionId) {
        print(`${tksPill}${reasonPill}${continueBtn}<span class="dim">· ${elapsedStr}</span>`, 'gen-stats-row', sid);
        gen.currentAssistantDiv = null;
        return;
    }

    const targetDiv = gen.currentAssistantDiv;
    if (targetDiv) {
        const statsRow = document.createElement('div');
        statsRow.className = 'gen-stats-row';
        statsRow.innerHTML = `${tksPill}${reasonPill}${continueBtn}<span class="dim">· ${elapsedStr}</span>`;
        moveCopyActionIntoStatsRow(targetDiv, statsRow);
        targetDiv.appendChild(statsRow);
    } else {
        const statsRow = document.createElement('div');
        statsRow.className = 'gen-stats-row log-entry';
        statsRow.innerHTML = `${tksPill}${reasonPill}${continueBtn}<span class="dim">· ${elapsedStr}</span>`;
        term.appendChild(statsRow);
    }
    smartScroll();

    gen.currentAssistantDiv = null;
}

// --- AST_EXPORTS_START ---
window.renderGenStats = renderGenStats;
// --- AST_EXPORTS_END ---

// --- serializeTermHTML.js ---
function serializeTermHTML() {
    const clone = term.cloneNode(true);
    stripTransientLiveUI(clone);
    return clone.innerHTML;
}

// --- AST_EXPORTS_START ---
window.serializeTermHTML = serializeTermHTML;
// --- AST_EXPORTS_END ---

// --- stripTransientLiveUI.js ---
function stripTransientLiveUI(root) {
    root.querySelectorAll(TRANSIENT_LIVE_SELECTOR).forEach(el => el.remove());
    // Legacy sessions saved before the markers existed: unmarked spinner lines.
    Array.from(root.children).forEach(el => {
        if (el.classList && el.classList.contains('log-entry') &&
            el.querySelector(':scope > .spinner-icon') &&
            (el.querySelector(':scope > .dim') || el.querySelector(':scope > .pending-tool-label'))) {
            el.remove();
        }
    });
}

// --- AST_EXPORTS_START ---
window.stripTransientLiveUI = stripTransientLiveUI;
// --- AST_EXPORTS_END ---

// --- updateWelcomeVisibility.js ---
function updateWelcomeVisibility() {
    const hasMessages = state.messages && state.messages.length > 0;

    if (hasMessages) {
        const welcomeMsg = document.getElementById('welcome-msg');
        if (welcomeMsg) welcomeMsg.style.display = 'none';
    } else {
        const welcomeMsg = document.getElementById('welcome-msg');
        if (!welcomeMsg) {
            const div = document.createElement('div');
            div.className = 'log-entry dim';
            div.id = 'welcome-msg';
            const allModes = ['plan', 'ask', 'code', ...dynamicModes];
            const modeDescriptions = allModes.map(m => {
                const c = MODE_CONFIG[m];
                return `<div>- <b style="color:${c.color}">${c.name}</b>: ${escapeHTML(c.desc || c.placeholder)}</div>`;
            }).join('');

            div.innerHTML = `
                <div><span class="welcome-title">Code Agent Chat</span> - Ready.</div>
                <div class="welcome-list">
                    ${modeDescriptions}
                    <div>- Type <span class="cyan">/</span> for command menu (<span class="cyan">/plan</span>, <span class="cyan">/ask</span>, <span class="cyan">/code</span>, <span class="cyan">/execute-plan</span>, <span class="cyan">/restore</span>, <span class="cyan">/compact</span>).</div>
                    <div>- Press <span class="yellow">ESC</span> at any time to cancel generation.</div>
                    <div>- <span class="cyan">↑/↓</span> for history &nbsp;|&nbsp; <span class="cyan">/</span> for commands &nbsp;|&nbsp; <span class="cyan">@</span> for files &nbsp;|&nbsp; <span class="cyan">Tab</span> to accept autocomplete</div>
                </div>
                <div class="welcome-models-card">
                    <div class="welcome-models-header">
                        <span class="icon" style="font-size:14px;">tune</span>
                        <span>Model Settings</span>
                    </div>
                    <div class="welcome-models-body">Pick a model from the dropdown above the prompt, or open settings to edit <code class="cyan">${MODELS_FILE}</code>.</div>
                    <button class="btn-models-edit" onclick="openModelsModal()">
                        <span class="icon" style="font-size:14px;">edit_note</span>
                        <span>Open models settings</span>
                    </button>
                </div>
            `;
            term.appendChild(div);
        } else {
            welcomeMsg.style.display = 'block';
        }
    }
}

// --- AST_EXPORTS_START ---
    window.updateWelcomeVisibility = updateWelcomeVisibility;
// --- AST_EXPORTS_END ---

// --- detachModeDividers.js ---
function detachModeDividers(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const dividers = scope.querySelectorAll('.mode-divider, .chat-prompt-wrap > .mode-divider');
    dividers.forEach(div => {
        const wrap = div.closest('.chat-prompt-wrap') || div.nextElementSibling;
        const chip = div.querySelector('.mode-chat-chip');
        let mode = 'code';
        if (chip) {
            if (chip.classList.contains('plan')) mode = 'plan';
            else if (chip.classList.contains('ask')) mode = 'ask';
            else if (chip.classList.contains('code')) mode = 'code';
        }
        if (wrap) {
            let next = wrap.nextElementSibling;
            while (next && !next.classList.contains('chat-prompt-wrap')) {
                if (next.classList.contains('md-content') && next.classList.contains('log-entry')) {
                    if (!next.classList.contains('mode-plan') && !next.classList.contains('mode-ask') && !next.classList.contains('mode-code')) {
                        next.classList.add(`mode-${mode}`);
                        next.setAttribute('data-mode', mode);
                    }
                    break;
                }
                next = next.nextElementSibling;
            }
        }
        div.remove();
    });
}

if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && !window._modeDividerObserver) {
    window._modeDividerObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.classList && (node.classList.contains('chat-prompt-wrap') || node.classList.contains('mode-divider'))) {
                        detachModeDividers(node.parentElement || node);
                    } else if (node.querySelectorAll) {
                        detachModeDividers(node);
                    }
                }
            }
        }
    });

    const setupModeDividerObserver = () => {
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            detachModeDividers(chatEl);
            window._modeDividerObserver.observe(chatEl, { childList: true, subtree: true });
        } else {
            setTimeout(setupModeDividerObserver, 50);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupModeDividerObserver);
    } else {
        setupModeDividerObserver();
    }
}

// --- AST_EXPORTS_START ---
    window.detachModeDividers = detachModeDividers;
// --- AST_EXPORTS_END ---