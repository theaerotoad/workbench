// edit - tool definition.
const TOOL_META = {
    "name": "edit",
    "description": "Make targeted edits to a file by replacing an exact code block. Fails if search_block matches multiple locations unless occurrence or replace_all is specified. Returns the edited region with surrounding context lines, or the nearest matching region on failure. To delete code, pass an empty string for replace_block.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string"
            },
            "search_block": {
                "type": "string",
                "description": "3-10 lines of existing code context to find"
            },
            "replace_block": {
                "type": "string",
                "description": "Replacement code. Use an empty string to delete search_block entirely.",
                "allowEmpty": true
            },
            "occurrence": {
                "type": "integer",
                "description": "Optional 1-based index of which match to replace when search_block appears multiple times."
            },
            "replace_all": {
                "type": "boolean",
                "description": "Optional. Set to true to replace every occurrence of search_block."
            }
        },
        "required": [
            "filepath",
            "search_block",
            "replace_block"
        ]
    },
    "modes": [
        "code"
    ],
    "permission": "ask",
    "toolBox": 1,
    "settings": [
        {
            "key": "contextLines",
            "label": "Result Context Lines",
            "type": "number",
            "default": 4,
            "min": 0,
            "max": 50,
            "description": "Lines of surrounding context returned to the model after a successful edit."
        }
    ]
};

// --- Pure Search, Replace & Diagnostic Helpers -------------------------------

const MAX_UNCLIPPED_REPLACE_LINES = 40;
const CLIP_EDGE_LINES = 20;
const MAX_REPORTED_REGIONS = 5;

function normalizeEol(s) {
    return String(s == null ? '' : s).replace(/\r\n/g, '\n');
}

function countNewlines(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) n++;
    }
    return n;
}

function detectIndentation(lines) {
    let tabs = 0, space2 = 0, space4 = 0;
    const limit = Math.min(lines.length, 300);
    for (let i = 0; i < limit; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        if (line.startsWith('\t')) tabs++;
        else if (line.startsWith('    ')) space4++;
        else if (line.startsWith('  ')) space2++;
    }
    if (tabs > 0 && tabs >= space4 && tabs >= space2) return { type: 'tab', char: '\t' };
    if (space4 >= space2 && space4 > 0) return { type: 'space4', char: '    ' };
    if (space2 > 0) return { type: 'space2', char: '  ' };
    return { type: 'space4', char: '    ' };
}

function applySearchReplace(original, searchBlock, replaceBlock, opts = {}) {
    const usesCRLF = String(original == null ? '' : original).includes('\r\n');
    const toFileEol = s => usesCRLF ? s.replace(/\n/g, '\r\n') : s;

    const orig   = normalizeEol(original);
    const sBlock = normalizeEol(searchBlock);
    const rBlock = normalizeEol(replaceBlock);

    if (sBlock === '') {
        throw new Error("search_block cannot be empty.");
    }

    const rawOcc = (opts && typeof opts === 'object') ? opts.occurrence : opts;
    const replaceAllFlag = !!(opts && typeof opts === 'object' && (opts.replaceAll === true || opts.replace_all === true));
    if (replaceAllFlag && rawOcc !== undefined && rawOcc !== null && rawOcc !== '' && rawOcc !== 'all') {
        throw new Error("Cannot specify both occurrence and replace_all.");
    }
    const replaceAll = replaceAllFlag || rawOcc === 'all';
    let occNum = null;
    if (!replaceAll && rawOcc !== undefined && rawOcc !== null && rawOcc !== '') {
        const n = Number(rawOcc);
        if (!Number.isInteger(n) || n < 1) {
            throw new Error(`Invalid occurrence "${rawOcc}": must be a positive integer (1-based) or "all".`);
        }
        occNum = n;
    }

    const selectMatches = (matches) => {
        const linesList = matches.map(m => m.line).join(', ');
        if (replaceAll) return matches;
        if (occNum !== null) {
            if (occNum > matches.length) {
                throw new Error(`search_block only matches ${matches.length} location${matches.length === 1 ? '' : 's'} (lines ${linesList}); cannot replace occurrence ${occNum}.`);
            }
            return [matches[occNum - 1]];
        }
        if (matches.length > 1) {
            throw new Error(`search_block matches ${matches.length} locations (lines ${linesList}). Add more context, pass occurrence (1-${matches.length}), or set replace_all: true.`);
        }
        return matches;
    };

    // Fast path: exact match (collect all non-overlapping matches)
    const exactMatches = [];
    let searchFrom = 0;
    while (true) {
        const idx = orig.indexOf(sBlock, searchFrom);
        if (idx === -1) break;
        const line = countNewlines(orig.slice(0, idx)) + 1;
        exactMatches.push({ idx, line });
        searchFrom = idx + sBlock.length;
    }

    if (exactMatches.length > 0) {
        const targets = selectMatches(exactMatches);
        let res = '';
        let cursor = 0;
        let currentLine = 1;
        const appliedRanges = [];
        const rNewlines = countNewlines(rBlock);

        for (const m of targets) {
            const prefix = orig.slice(cursor, m.idx);
            res += prefix;
            currentLine += countNewlines(prefix);
            const startLine = currentLine;
            res += rBlock;
            currentLine += rNewlines;
            const endLine = rBlock === '' ? startLine : currentLine;
            appliedRanges.push({ startLine, endLine });
            cursor = m.idx + sBlock.length;
        }
        res += orig.slice(cursor);

        return {
            content: toFileEol(res),
            lineNumber: targets[0].line,
            matchCount: exactMatches.length,
            replacedCount: targets.length,
            matchLines: targets.map(m => m.line),
            appliedRanges
        };
    }

    // Fallback: line-by-line trim-aware match (collect all non-overlapping matches)
    const origLines = orig.split('\n');
    const sLines    = sBlock.split('\n');
    const rLines    = rBlock.split('\n');
    const fileIndent = detectIndentation(origLines);

    const trimMatches = [];
    for (let i = 0; i <= origLines.length - sLines.length; i++) {
        let match = true;
        for (let j = 0; j < sLines.length; j++) {
            if (origLines[i + j].trim() !== sLines[j].trim()) {
                match = false;
                break;
            }
        }
        if (match) {
            trimMatches.push({ lineIdx: i, line: i + 1 });
            i += sLines.length - 1;
        }
    }

    if (trimMatches.length > 0) {
        const targets = selectMatches(trimMatches);
        const sLead = sLines[0].match(/^\s*/)[0];
        const outLines = [];
        const appliedRanges = [];
        let cursor = 0;

        for (const m of targets) {
            for (let k = cursor; k < m.lineIdx; k++) outLines.push(origLines[k]);
            const startLine = outLines.length + 1;
            const origLead = origLines[m.lineIdx].match(/^\s*/)[0];
            const adjustedRLines = rLines.map((line) => {
                if (!line.trim()) return '';
                const curLead = line.match(/^\s*/)[0];
                const lineContent = line.slice(curLead.length);

                let relativeIndent = curLead.startsWith(sLead) ? curLead.slice(sLead.length) : curLead;
                if (fileIndent.type === 'tab') {
                    relativeIndent = relativeIndent.replace(/ {4}/g, '\t').replace(/ {2}/g, '\t');
                }

                return origLead + relativeIndent + lineContent;
            });
            outLines.push(...adjustedRLines);
            const endLine = Math.max(startLine, outLines.length);
            appliedRanges.push({ startLine, endLine });
            cursor = m.lineIdx + sLines.length;
        }
        for (let k = cursor; k < origLines.length; k++) outLines.push(origLines[k]);

        return {
            content: toFileEol(outLines.join('\n')),
            lineNumber: targets[0].line,
            matchCount: trimMatches.length,
            replacedCount: targets.length,
            matchLines: targets.map(m => m.line),
            appliedRanges
        };
    }

    const err = new Error("Could not find search_block in target file.");
    err.code = 'NOT_FOUND';
    throw err;
}

function formatChangedRegions(newContent, appliedRanges, contextLines = 4) {
    const norm = normalizeEol(newContent);
    if (norm === '') return '(file is now empty)';
    const lines = norm.split('\n');
    const total = lines.length;
    const ctx = Math.max(0, Number.isFinite(contextLines) ? Math.floor(contextLines) : 4);

    if (!Array.isArray(appliedRanges) || appliedRanges.length === 0) return '';

    const normalized = appliedRanges.slice(0, MAX_REPORTED_REGIONS).map(r => {
        const s = Math.max(1, Math.min(total, r.startLine));
        const e = Math.max(s, Math.min(total, r.endLine));
        const span = e - s + 1;
        return {
            startLine: s,
            endLine: e,
            winStart: Math.max(1, s - ctx),
            winEnd: Math.min(total, e + ctx),
            clipped: span > MAX_UNCLIPPED_REPLACE_LINES
        };
    });

    // Merge overlapping or touching unclipped windows
    const blocks = [];
    for (const item of normalized) {
        const prev = blocks[blocks.length - 1];
        if (prev && !prev.clipped && !item.clipped && item.winStart <= prev.winEnd + 1) {
            prev.winEnd = Math.max(prev.winEnd, item.winEnd);
            prev.endLine = Math.max(prev.endLine, item.endLine);
        } else {
            blocks.push({ ...item });
        }
    }

    const sections = blocks.map(b => {
        const out = [];
        if (!b.clipped) {
            for (let n = b.winStart; n <= b.winEnd; n++) {
                out.push(`${n} | ${lines[n - 1]}`);
            }
        } else {
            const headEnd = Math.min(b.endLine, b.startLine + CLIP_EDGE_LINES - 1);
            const tailStart = Math.max(headEnd + 1, b.endLine - CLIP_EDGE_LINES + 1);
            for (let n = b.winStart; n <= headEnd; n++) {
                out.push(`${n} | ${lines[n - 1]}`);
            }
            const omitted = tailStart - headEnd - 1;
            if (omitted > 0) {
                out.push(`… (${omitted} line${omitted === 1 ? '' : 's'} omitted) …`);
            }
            for (let n = tailStart; n <= b.winEnd; n++) {
                out.push(`${n} | ${lines[n - 1]}`);
            }
        }
        return out.join('\n');
    });

    let text = sections.join('\n…\n');
    if (appliedRanges.length > MAX_REPORTED_REGIONS) {
        const extra = appliedRanges.length - MAX_REPORTED_REGIONS;
        text += `\n… (${extra} more replaced region${extra === 1 ? '' : 's'} omitted)`;
    }
    return text;
}

function bigramDice(a, b) {
    const s1 = a.length > 200 ? a.slice(0, 200) : a;
    const s2 = b.length > 200 ? b.slice(0, 200) : b;
    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return 0;
    const map = new Map();
    for (let i = 0; i < s1.length - 1; i++) {
        const bg = s1.slice(i, i + 2);
        map.set(bg, (map.get(bg) || 0) + 1);
    }
    let overlap = 0;
    for (let i = 0; i < s2.length - 1; i++) {
        const bg = s2.slice(i, i + 2);
        const count = map.get(bg) || 0;
        if (count > 0) {
            overlap++;
            map.set(bg, count - 1);
        }
    }
    return (2 * overlap) / (s1.length - 1 + s2.length - 1);
}

function lineSimilarity(origLine, searchLine) {
    const ta = origLine.trim();
    const tb = searchLine.trim();
    if (ta === tb) return ta === '' ? 0.5 : 1.0;
    if (ta === '' || tb === '') return 0;
    const exactScore = bigramDice(ta, tb);
    if (exactScore >= 0.85) return exactScore;
    const ciScore = bigramDice(ta.toLowerCase(), tb.toLowerCase());
    return Math.max(exactScore, ciScore * 0.92);
}

function clipInline(str, maxLen = 80) {
    const clean = String(str || '').replace(/\t/g, '\\t');
    return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
}

function buildMismatchHint(origLines, sLines, startIdx) {
    const fileIndent = detectIndentation(origLines);
    const searchHasTabs = sLines.some(l => l.startsWith('\t'));
    const searchHasSpaces = sLines.some(l => /^ {2,}/.test(l));
    const indentStyleMismatch =
        (fileIndent.type === 'tab' && searchHasSpaces && !searchHasTabs)
            ? 'file uses tabs'
            : (fileIndent.type !== 'tab' && searchHasTabs && !searchHasSpaces)
                ? 'file uses spaces, not tabs'
                : null;

    let firstTrimDiff = null;
    let firstIndentDiff = null;

    for (let j = 0; j < sLines.length; j++) {
        const fileIdx = startIdx + j;
        if (fileIdx >= origLines.length) {
            firstTrimDiff = {
                j,
                fileLine: fileIdx + 1,
                eof: true
            };
            break;
        }
        const fl = origLines[fileIdx];
        const sl = sLines[j];
        if (fl.trim() !== sl.trim()) {
            firstTrimDiff = { j, fileLine: fileIdx + 1, expected: sl.trim(), found: fl.trim() };
            break;
        }
        if (fl !== sl && !firstIndentDiff) {
            firstIndentDiff = { j, fileLine: fileIdx + 1 };
        }
    }

    if (firstTrimDiff) {
        if (firstTrimDiff.eof) {
            return `file ends before line ${firstTrimDiff.j + 1} of search_block`;
        }
        const suffix = indentStyleMismatch ? ` (also: ${indentStyleMismatch})` : '';
        return `line ${firstTrimDiff.j + 1} (file L${firstTrimDiff.fileLine}) differs: expected \`${clipInline(firstTrimDiff.expected)}\` found \`${clipInline(firstTrimDiff.found)}\`${suffix}`;
    }
    if (indentStyleMismatch) {
        return `indentation differs (${indentStyleMismatch})`;
    }
    if (firstIndentDiff) {
        return `indentation or trailing whitespace differs at line ${firstIndentDiff.j + 1} (file L${firstIndentDiff.fileLine})`;
    }
    return 'nearest region differs slightly from search_block';
}

function findNearestMatch(original, searchBlock) {
    const orig = normalizeEol(original);
    const sBlock = normalizeEol(searchBlock);
    if (!orig || !sBlock) return null;

    const origLines = orig.split('\n');
    const sLines = sBlock.split('\n');
    if (!origLines.length || !sLines.length) return null;

    // Index trimmed non-blank lines in original for fast anchor lookup
    const lineIndex = new Map();
    for (let i = 0; i < origLines.length; i++) {
        const t = origLines[i].trim();
        if (!t) continue;
        let list = lineIndex.get(t);
        if (!list) {
            list = [];
            lineIndex.set(t, list);
        }
        list.push(i);
    }

    // Collect non-blank search lines with exact trimmed hits, rarest first
    const anchors = [];
    for (let j = 0; j < sLines.length; j++) {
        const t = sLines[j].trim();
        if (!t) continue;
        const hits = lineIndex.get(t);
        if (hits && hits.length > 0) {
            anchors.push({ j, hits, count: hits.length });
        }
    }
    anchors.sort((a, b) => a.count - b.count);

    const candidateStarts = new Set();
    const maxAnchorLines = Math.min(anchors.length, 5);
    for (let a = 0; a < maxAnchorLines; a++) {
        const { j, hits } = anchors[a];
        const cap = Math.min(hits.length, 80);
        for (let k = 0; k < cap; k++) {
            const start = Math.max(0, hits[k] - j);
            candidateStarts.add(start);
        }
    }

    // Fuzzy fallback when no trimmed line matches verbatim (e.g. typo on a 1-line block)
    if (candidateStarts.size === 0) {
        let bestSearchIdx = -1;
        let bestSearchLen = -1;
        for (let j = 0; j < sLines.length; j++) {
            const len = sLines[j].trim().length;
            if (len > bestSearchLen) {
                bestSearchLen = len;
                bestSearchIdx = j;
            }
        }
        if (bestSearchIdx === -1 || bestSearchLen <= 0) return null;

        const targetLine = sLines[bestSearchIdx];
        const scoredLines = [];
        const scanCap = Math.min(origLines.length, 6000);
        for (let i = 0; i < scanCap; i++) {
            const sim = lineSimilarity(origLines[i], targetLine);
            if (sim >= 0.35) scoredLines.push({ i, sim });
        }
        scoredLines.sort((a, b) => b.sim - a.sim);
        const topN = Math.min(scoredLines.length, 30);
        for (let k = 0; k < topN; k++) {
            candidateStarts.add(Math.max(0, scoredLines[k].i - bestSearchIdx));
        }
    }

    if (candidateStarts.size === 0) return null;

    let bestStart = -1;
    let bestScore = -1;
    for (const start of candidateStarts) {
        let scoreSum = 0;
        let weightSum = 0;
        let exactIndentHits = 0;
        for (let j = 0; j < sLines.length; j++) {
            const isBlank = !sLines[j].trim();
            const w = isBlank ? 0.2 : 1.0;
            weightSum += w;
            if (start + j < origLines.length) {
                scoreSum += w * lineSimilarity(origLines[start + j], sLines[j]);
                if (origLines[start + j] === sLines[j]) exactIndentHits++;
            }
        }
        const normScore = (weightSum > 0 ? scoreSum / weightSum : 0) + (exactIndentHits / sLines.length) * 0.02;
        if (normScore > bestScore) {
            bestScore = normScore;
            bestStart = start;
        }
    }

    if (bestStart === -1 || bestScore < 0.35) return null;

    const hint = buildMismatchHint(origLines, sLines, bestStart);
    const regionStart = Math.max(0, bestStart - 2);
    const regionEnd = Math.min(origLines.length - 1, bestStart + sLines.length + 1);
    const maxSnippetLines = 30;
    const clippedEnd = Math.min(regionEnd, regionStart + maxSnippetLines - 1);

    const snippetLines = [];
    for (let i = regionStart; i <= clippedEnd; i++) {
        snippetLines.push(`${i + 1} | ${origLines[i]}`);
    }
    if (clippedEnd < regionEnd) {
        snippetLines.push(`… (${regionEnd - clippedEnd} more lines) …`);
    }

    return {
        startLine: regionStart + 1,
        endLine: clippedEnd + 1,
        score: bestScore,
        hint,
        snippet: snippetLines.join('\n')
    };
}

// --- UI Helpers --------------------------------------------------------------

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&', '<': '<', '>': '>', '"': '"', "'": '''
    }[c]));
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {

    function renderErrorHtml(filepath, errorMessage, hintText = null) {
        const pathParts = (filepath || '').split('/');
        const fileName  = pathParts.pop() || filepath;
        const dirPath   = pathParts.length ? pathParts.join('/') + '/' : '';

        const searchRaw  = args.search_block  != null ? String(args.search_block)  : "";
        const replaceRaw = args.replace_block != null ? String(args.replace_block) : "";
        const searchLines  = searchRaw  === "" ? [] : searchRaw.split('\n');
        const replaceLines = replaceRaw === "" ? [] : replaceRaw.split('\n');

        let diffLinesHTML = '';
        let lineNum = 1;
        searchLines.forEach(l => {
            diffLinesHTML += `
                <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--red) 8%, transparent); color:color-mix(in srgb, var(--red) 75%, var(--fg));">
                    <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--red) 40%, var(--dim)); border-right-color:color-mix(in srgb, var(--red) 15%, transparent);">${lineNum}</div>
                    <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--red) 60%, transparent); flex-shrink:0;">-</div>
                    <div class="tool-ui-line-content" style="color:inherit;">${escapeHtml(l)}</div>
                </div>`;
            lineNum++;
        });

        lineNum = 1;
        replaceLines.forEach(l => {
            diffLinesHTML += `
                <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--green) 6%, transparent); color:color-mix(in srgb, var(--green) 65%, var(--fg));">
                    <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--green) 30%, var(--dim)); border-right-color:color-mix(in srgb, var(--green) 15%, transparent);">${lineNum}</div>
                    <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--green) 50%, transparent); flex-shrink:0;">+</div>
                    <div class="tool-ui-line-content" style="color:inherit;">${escapeHtml(l)}</div>
                </div>`;
            lineNum++;
        });

        const hintHtml = hintText
            ? `<div style="font-size:10.5px; color:var(--yellow); padding:2px 2px 0; font-family:var(--font-mono); overflow-wrap:anywhere;">Hint: ${escapeHtml(hintText)}</div>`
            : '';

        return `
            <div class="tool-ui-wrap">
                <div class="tool-ui-error-wrap">
                    <div class="tool-ui-header-info">
                        <span class="icon" style="font-size:13px; color:var(--red); flex-shrink:0;">warning</span>
                        <div class="tool-ui-path">
                            <span class="tool-ui-path-dir">${escapeHtml(dirPath)}</span><span class="tool-ui-path-name">${escapeHtml(fileName)}</span>
                        </div>
                        <span class="tool-ui-badge" style="color:var(--red); background:color-mix(in srgb, var(--red) 20%, transparent);">Edit Failed</span>
                    </div>
                    <span style="color:var(--dim); font-size:10px;">no changes applied</span>
                </div>

                ${diffLinesHTML ? `<div class="tool-ui-box" style="border-color:color-mix(in srgb, var(--red) 20%, transparent); opacity:0.85;">${diffLinesHTML}</div>` : ''}

                <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--red); padding:0 2px;">
                    <div class="tool-ui-error-msg">
                        <span class="icon" style="font-size:12px;">error</span>
                        <span>${escapeHtml(errorMessage)}</span>
                    </div>
                    <span style="color:var(--dim); opacity:0.7;">File left untouched</span>
                </div>
                ${hintHtml}
            </div>
        `;
    }

    // --- Mode Guards --------------------------------------------------------

    if (api.mode === 'ask') return { output: "ERROR: Ask mode is strictly read-only. File modification is disabled. Switch to Code mode to apply changes." };
    if (api.mode === 'plan') return { output: `ERROR: Plan mode is for planning only. Do not edit source code files. Write the complete plan to ${api.planFile}.` };

    if (!(await api.fileExists(args.filepath))) {
        const msg = `${args.filepath} not found`;
        await api.showUI(renderErrorHtml(args.filepath, msg));
        return { output: `ERROR: ${msg}` };
    }
    if (await api.isBinary(args.filepath)) {
        const msg = `${args.filepath} is a binary file.`;
        await api.showUI(renderErrorHtml(args.filepath, msg));
        return { output: `ERROR: ${msg}` };
    }

    const header = `${args.filepath}`;
    await api.setHeaderMsg(header);

    let originalContent = null;
    try {
        originalContent = await api.readFile(args.filepath);
        const result = applySearchReplace(originalContent, args.search_block, args.replace_block || "", {
            occurrence: args.occurrence,
            replaceAll: args.replace_all === true
        });
        const err = await api.writeFile(args.filepath, result.content);
        if (err) {
            await api.showUI(renderErrorHtml(args.filepath, err));
            return { output: err };
        }

        // --- Metrics & Path Splitting ---------------------------------------

        const searchRaw  = args.search_block  != null ? String(args.search_block)  : "";
        const replaceRaw = args.replace_block != null ? String(args.replace_block) : "";

        const searchLines  = searchRaw  === "" ? [] : searchRaw.split('\n');
        const replaceLines = replaceRaw === "" ? [] : replaceRaw.split('\n');

        const replacedCount = result.replacedCount || 1;
        const linesRemoved  = searchLines.length * replacedCount;
        const linesAdded    = replaceLines.length * replacedCount;
        const delta         = linesAdded - linesRemoved;

        const startLineNum = result.lineNumber;
        const endLineNum   = searchLines.length > 0 ? startLineNum + searchLines.length - 1 : startLineNum;
        const rangeText    = replacedCount > 1
            ? `${replacedCount} matches`
            : (searchLines.length > 1
                ? `L${startLineNum}–L${endLineNum}`
                : (searchLines.length === 1 ? `L${startLineNum}` : `L${startLineNum} (ins)`));

        const totalFileLines = result.content.split(/\r?\n/).length;

        const pathParts = args.filepath.split('/');
        const fileName  = pathParts.pop();
        const dirPath   = pathParts.length ? pathParts.join('/') + '/' : '';

        // --- Character-Level Diff Highlight (Single-Line Edits) --------------

        let intraLineDel = null;
        let intraLineAdd = null;

        if (searchLines.length === 1 && replaceLines.length === 1) {
            const s1 = searchLines[0];
            const s2 = replaceLines[0];

            let p = 0;
            while (p < s1.length && p < s2.length && s1[p] === s2[p]) p++;

            let s1End = s1.length - 1;
            let s2End = s2.length - 1;
            while (s1End >= p && s2End >= p && s1[s1End] === s2[s2End]) {
                s1End--;
                s2End--;
            }

            const prefix   = escapeHtml(s1.slice(0, p));
            const suffix   = escapeHtml(s1.slice(s1End + 1));
            const delMid   = escapeHtml(s1.slice(p, s1End + 1));
            const addMid   = escapeHtml(s2.slice(p, s2End + 1));

            intraLineDel = `${prefix}<span style="background:color-mix(in srgb, var(--red) 35%, transparent); border-radius:2px; font-weight:600;">${delMid}</span>${suffix}`;
            intraLineAdd = `${prefix}<span style="background:color-mix(in srgb, var(--green) 35%, transparent); border-radius:2px; font-weight:600;">${addMid}</span>${suffix}`;
        }

        // --- Render Diff Lines ----------------------------------------------

        let diffLinesHTML = '';
        let lineNum = startLineNum;

        searchLines.forEach((l) => {
            const lineContent = (searchLines.length === 1 && replaceLines.length === 1 && intraLineDel) ? intraLineDel : escapeHtml(l);
            diffLinesHTML += `
                <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--red) 12%, transparent); color:var(--red);">
                    <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--red) 60%, transparent); border-right-color:color-mix(in srgb, var(--red) 20%, transparent);">${lineNum}</div>
                    <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--red) 80%, transparent); flex-shrink:0;">-</div>
                    <div class="tool-ui-line-content" style="color:inherit;">${lineContent}</div>
                </div>`;
            lineNum++;
        });

        lineNum = startLineNum;
        replaceLines.forEach((l) => {
            const lineContent = (searchLines.length === 1 && replaceLines.length === 1 && intraLineAdd) ? intraLineAdd : escapeHtml(l);
            diffLinesHTML += `
                <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--green) 12%, transparent); color:var(--green);">
                    <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--green) 60%, transparent); border-right-color:color-mix(in srgb, var(--green) 20%, transparent);">${lineNum}</div>
                    <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--green) 80%, transparent); flex-shrink:0;">+</div>
                    <div class="tool-ui-line-content" style="color:inherit;">${lineContent}</div>
                </div>`;
            lineNum++;
        });

        // --- Mini Visual Bar (Git 5-block chart) ----------------------------

        const totalChanges = Math.max(1, linesAdded + linesRemoved);
        const addBlocks = Math.round((linesAdded / totalChanges) * 5);
        const delBlocks = Math.min(5 - addBlocks, linesRemoved > 0 ? Math.max(1, 5 - addBlocks) : 0);
        const neutralBlocks = Math.max(0, 5 - addBlocks - delBlocks);

        let miniBar = '';
        for (let i = 0; i < addBlocks; i++)     miniBar += `<span style="width:4px; height:8px; border-radius:1px; background:var(--green); display:inline-block;"></span>`;
        for (let i = 0; i < delBlocks; i++)     miniBar += `<span style="width:4px; height:8px; border-radius:1px; background:var(--red); display:inline-block;"></span>`;
        for (let i = 0; i < neutralBlocks; i++) miniBar += `<span style="width:4px; height:8px; border-radius:1px; background:color-mix(in srgb, var(--fg) 15%, transparent); display:inline-block;"></span>`;

        // --- Delta Pill -----------------------------------------------------

        let deltaPill = '';
        if (delta > 0) {
            deltaPill = `<span class="tool-ui-badge" style="background:color-mix(in srgb, var(--green) 18%, transparent); color:var(--green);">+${delta}</span>`;
        } else if (delta < 0) {
            deltaPill = `<span class="tool-ui-badge" style="background:color-mix(in srgb, var(--red) 18%, transparent); color:var(--red);">${delta}</span>`;
        } else {
            deltaPill = `<span class="tool-ui-badge" style="background:color-mix(in srgb, var(--fg) 6%, transparent); color:var(--dim); font-weight:600;">±0</span>`;
        }

        // --- Compose Final HTML ---------------------------------------------

        const displayHtml = `
            <div class="tool-ui-wrap">

                <!-- Header Pill Bar -->
                <div class="tool-ui-bar">
                    <div class="tool-ui-header-info">
                        <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">code</span>
                        <div class="tool-ui-path">
                            <span class="tool-ui-path-dir">${escapeHtml(dirPath)}</span><span class="tool-ui-path-name">${escapeHtml(fileName)}</span>
                        </div>
                        <span class="tool-ui-badge" style="background:color-mix(in srgb, var(--primary) 14%, transparent); color:var(--primary);">@@ ${rangeText} @@</span>
                    </div>

                    <div class="tool-ui-header-stats">
                        <span style="color:var(--green); font-weight:600;">+${linesAdded}</span>
                        <span style="color:var(--red); font-weight:600;">-${linesRemoved}</span>
                        <div style="display:inline-flex; gap:1px; align-items:center; margin:0 2px;">${miniBar}</div>
                        ${deltaPill}
                    </div>
                </div>

                <!-- Code Diff Box -->
                <div class="tool-ui-box">
                    ${diffLinesHTML}
                </div>

                <!-- Status Bar -->
                <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                        <span>${replacedCount > 1
                            ? `Replaced ${replacedCount} occurrences (lines ${result.matchLines.slice(0, 8).join(', ')}${result.matchLines.length > 8 ? '…' : ''})`
                            : (result.matchCount > 1 ? `Applied at line ${startLineNum} (occurrence ${args.occurrence} of ${result.matchCount})` : `Applied at line ${startLineNum}`)
                        }</span>
                    </div>
                    <span style="opacity:0.6;">${totalFileLines} total lines</span>
                </div>
            </div>
        `;

        // --- Model Output (changed area + surrounding context) --------------

        let contextLines = Number(await api.getSetting('contextLines'));
        if (!Number.isFinite(contextLines) || contextLines < 0) contextLines = 4;

        const headline = replacedCount > 1
            ? `Edited ${args.filepath}: replaced ${replacedCount} occurrences (lines ${result.matchLines.join(', ')})`
            : `Edited ${args.filepath} at ${rangeText}`;
        const changedSnippet = formatChangedRegions(result.content, result.appliedRanges, contextLines);
        const resultText = changedSnippet
            ? api.cleanupText(`${headline}\n\n${changedSnippet}`)
            : headline;
        const summary = replacedCount > 1
            ? `${args.filepath} (${replacedCount}×)`
            : `${args.filepath}:${startLineNum}`;

        await api.showUI(displayHtml);
        return { output: resultText, summary };
    } catch (e) {
        let hint = null;
        let output = `ERROR: ${e.message}`;
        if (e && e.code === 'NOT_FOUND' && typeof originalContent === 'string') {
            const nearest = findNearestMatch(originalContent, args.search_block);
            if (nearest) {
                hint = nearest.hint;
                output = api.cleanupText(
                    `ERROR: ${e.message}\nHint: ${nearest.hint}\nNearest match (L${nearest.startLine}–L${nearest.endLine}):\n${nearest.snippet}`
                );
            }
        }
        await api.showUI(renderErrorHtml(args.filepath, e.message, hint));
        return { output };
    }
}