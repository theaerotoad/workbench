// edit - tool definition.
const TOOL_META = {
    "name": "edit",
    "description": "Make targeted edits to a file. Supports: (1) search/replace with search_block + replace_block (fails if ambiguous unless occurrence or replace_all is set), (2) line-anchored edits with start_line, optional end_line, replace_block, and strongly recommended expect guard, or (3) atomic all-or-nothing batch edits via edits: [...]. In a batch, line-anchored items resolve against original line numbers (applied bottom-up) and search/replace items apply in order. Pass an empty string for replace_block to delete. Returns edited regions with context lines, or diagnostics on failure.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Workspace-relative path to the file to edit."
            },
            "search_block": {
                "type": "string",
                "description": "Single search/replace edit: 3-10 lines of existing code context to find."
            },
            "replace_block": {
                "type": "string",
                "description": "Single edit replacement code. Use an empty string to delete the matched block or line range.",
                "allowEmpty": true
            },
            "occurrence": {
                "type": "integer",
                "description": "Optional 1-based index of which match to replace when search_block appears multiple times."
            },
            "replace_all": {
                "type": "boolean",
                "description": "Optional. Set to true to replace every occurrence of search_block."
            },
            "start_line": {
                "type": "integer",
                "description": "Single line-anchored edit: 1-based starting line number."
            },
            "end_line": {
                "type": "integer",
                "description": "Single line-anchored edit: 1-based inclusive ending line number (defaults to start_line)."
            },
            "expect": {
                "type": "string",
                "description": "Strongly recommended for line-anchored edits: expected current text of the first line (or full range) to guard against stale line numbers.",
                "allowEmpty": true
            },
            "edits": {
                "type": "array",
                "description": "Atomic batch of edits applied all-or-nothing. Each item is either { search_block, replace_block, occurrence?, replace_all? } or { start_line, end_line?, replace_block, expect? }.",
                "items": {
                    "type": "object",
                    "properties": {
                        "search_block": {
                            "type": "string",
                            "description": "Existing code block to find."
                        },
                        "replace_block": {
                            "type": "string",
                            "description": "Replacement code, or empty string to delete.",
                            "allowEmpty": true
                        },
                        "occurrence": {
                            "type": "integer",
                            "description": "Optional 1-based index of which match to replace when search_block appears multiple times."
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "Optional. Set to true to replace every occurrence of search_block."
                        },
                        "start_line": {
                            "type": "integer",
                            "description": "1-based starting line number (resolved against original file lines)."
                        },
                        "end_line": {
                            "type": "integer",
                            "description": "1-based inclusive ending line number (defaults to start_line)."
                        },
                        "expect": {
                            "type": "string",
                            "description": "Strongly recommended: expected current text of the first line (or full range) to guard against stale line numbers.",
                            "allowEmpty": true
                        }
                    }
                }
            }
        },
        "required": [
            "filepath"
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

// --- Pure Search, Replace, Batch & Diagnostic Helpers ------------------------

const MAX_UNCLIPPED_REPLACE_LINES = 40;
const CLIP_EDGE_LINES = 20;
const MAX_REPORTED_REGIONS = 12;
const MAX_PREVIEW_DIFF_LINES = 140;

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
        const stepChanges = [];
        const sNewlines = countNewlines(sBlock);
        const rNewlines = countNewlines(rBlock);
        const deltaLines = rNewlines - sNewlines;

        for (const m of targets) {
            const prefix = orig.slice(cursor, m.idx);
            res += prefix;
            currentLine += countNewlines(prefix);
            const startLine = currentLine;
            res += rBlock;
            currentLine += rNewlines;
            const endLine = rBlock === '' ? startLine : currentLine;
            appliedRanges.push({ startLine, endLine });
            stepChanges.push({
                origStartLine: m.line,
                origEndLine: m.line + sNewlines,
                deltaLines
            });
            cursor = m.idx + sBlock.length;
        }
        res += orig.slice(cursor);

        return {
            content: toFileEol(res),
            lineNumber: targets[0].line,
            matchCount: exactMatches.length,
            replacedCount: targets.length,
            matchLines: targets.map(m => m.line),
            appliedRanges,
            stepChanges,
            oldLines: sBlock.split('\n'),
            newLines: rBlock === '' ? [] : rBlock.split('\n')
        };
    }

    // Fallback: line-by-line trim-aware match (collect all non-overlapping matches)
    const origLines = orig.split('\n');
    const sLines    = sBlock.split('\n');
    const rLines    = rBlock === '' ? [] : rBlock.split('\n');
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
        const stepChanges = [];
        let firstOrigSlice = null;
        let firstAdjustedLines = null;
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
            if (firstOrigSlice === null) {
                firstOrigSlice = origLines.slice(m.lineIdx, m.lineIdx + sLines.length);
                firstAdjustedLines = adjustedRLines;
            }
            outLines.push(...adjustedRLines);
            const endLine = adjustedRLines.length === 0 ? startLine : outLines.length;
            appliedRanges.push({ startLine, endLine });
            stepChanges.push({
                origStartLine: m.line,
                origEndLine: m.line + sLines.length - 1,
                deltaLines: adjustedRLines.length - sLines.length
            });
            cursor = m.lineIdx + sLines.length;
        }
        for (let k = cursor; k < origLines.length; k++) outLines.push(origLines[k]);

        return {
            content: toFileEol(outLines.join('\n')),
            lineNumber: targets[0].line,
            matchCount: trimMatches.length,
            replacedCount: targets.length,
            matchLines: targets.map(m => m.line),
            appliedRanges,
            stepChanges,
            oldLines: firstOrigSlice || sLines,
            newLines: firstAdjustedLines || rLines
        };
    }

    const err = new Error("Could not find search_block in target file.");
    err.code = 'NOT_FOUND';
    throw err;
}

function normalizeEditItems(args) {
    const hasBatch = args.edits !== undefined && args.edits !== null;
    const hasTopSingle =
        args.search_block !== undefined ||
        args.start_line !== undefined ||
        args.end_line !== undefined ||
        args.expect !== undefined;

    if (hasBatch && hasTopSingle) {
        throw new Error("Cannot combine 'edits' with top-level search_block or start_line/end_line parameters.");
    }

    const rawList = hasBatch ? args.edits : [args];
    if (hasBatch && (!Array.isArray(rawList) || rawList.length === 0)) {
        throw new Error("'edits' must be a non-empty array of edit objects.");
    }

    const isBatch = hasBatch;
    const normalized = [];

    for (let i = 0; i < rawList.length; i++) {
        const raw = rawList[i];
        const idx = i + 1;
        const prefix = isBatch ? `edit #${idx}: ` : '';

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error(`${prefix}edit entry must be an object.`);
        }

        const hasSearch = raw.search_block !== undefined && raw.search_block !== null;
        const hasLine = (raw.start_line !== undefined && raw.start_line !== null) ||
                        (raw.end_line !== undefined && raw.end_line !== null);

        if (hasSearch && hasLine) {
            throw new Error(`${prefix}cannot specify both search_block and start_line/end_line in the same edit.`);
        }
        if (!hasSearch && !hasLine) {
            throw new Error(`${prefix}must specify either search_block or start_line.`);
        }
        if (typeof raw.replace_block !== 'string') {
            throw new Error(`${prefix}replace_block must be a string (pass "" to delete).`);
        }

        if (hasSearch) {
            if (typeof raw.search_block !== 'string' || raw.search_block === '') {
                throw new Error(`${prefix}search_block must be a non-empty string.`);
            }
            if (raw.expect !== undefined && raw.expect !== null) {
                throw new Error(`${prefix}expect is only valid for line-anchored edits (start_line/end_line).`);
            }
            normalized.push({
                kind: 'search',
                index: idx,
                search_block: raw.search_block,
                replace_block: raw.replace_block,
                occurrence: raw.occurrence,
                replace_all: raw.replace_all === true
            });
        } else {
            if (raw.start_line === undefined || raw.start_line === null) {
                throw new Error(`${prefix}start_line is required when end_line is specified.`);
            }
            const startLine = Number(raw.start_line);
            if (!Number.isInteger(startLine) || startLine < 1) {
                throw new Error(`${prefix}start_line must be a positive 1-based integer.`);
            }
            const endLine = (raw.end_line === undefined || raw.end_line === null)
                ? startLine
                : Number(raw.end_line);
            if (!Number.isInteger(endLine) || endLine < startLine) {
                throw new Error(`${prefix}end_line (${raw.end_line}) must be an integer >= start_line (${startLine}).`);
            }
            if (raw.expect !== undefined && raw.expect !== null && typeof raw.expect !== 'string') {
                throw new Error(`${prefix}expect must be a string when provided.`);
            }
            if (raw.occurrence !== undefined || raw.replace_all !== undefined) {
                throw new Error(`${prefix}occurrence/replace_all are only valid for search_block edits.`);
            }
            normalized.push({
                kind: 'line',
                index: idx,
                start_line: startLine,
                end_line: endLine,
                replace_block: raw.replace_block,
                expect: raw.expect !== undefined && raw.expect !== null ? raw.expect : null
            });
        }
    }

    return { items: normalized, isBatch };
}

function formatLineSlice(lines, startIdx, endIdx, maxLines = 30) {
    const clampedEnd = Math.min(endIdx, startIdx + maxLines - 1);
    const out = [];
    for (let i = startIdx; i <= clampedEnd; i++) {
        out.push(`${i + 1} | ${lines[i]}`);
    }
    if (clampedEnd < endIdx) {
        out.push(`… (${endIdx - clampedEnd} more line${endIdx - clampedEnd === 1 ? '' : 's'}) …`);
    }
    return out.join('\n');
}

function validateLineEdit(origLines, origText, spec) {
    const totalLines = origLines.length;
    if (spec.start_line > totalLines || spec.end_line > totalLines) {
        const err = new Error(
            `line range L${spec.start_line}–L${spec.end_line} is out of bounds (file has ${totalLines} line${totalLines === 1 ? '' : 's'}).`
        );
        err.code = 'RANGE_ERROR';
        throw err;
    }

    const startIdx = spec.start_line - 1;
    const endIdx = spec.end_line - 1;
    const oldLines = origLines.slice(startIdx, endIdx + 1);

    if (spec.expect !== null) {
        const expNorm = normalizeEol(spec.expect);
        const expLines = expNorm.split('\n');
        let mismatch = null;

        if (expLines.length > oldLines.length) {
            mismatch = {
                reason: `expect has ${expLines.length} lines but L${spec.start_line}–L${spec.end_line} only spans ${oldLines.length} line${oldLines.length === 1 ? '' : 's'}`
            };
        } else {
            for (let j = 0; j < expLines.length; j++) {
                const expected = expLines[j];
                const actual = oldLines[j];
                if (actual !== expected && actual.trim() !== expected.trim()) {
                    mismatch = {
                        reason: `line ${spec.start_line + j} differs: expected \`${clipInline(expected.trim())}\` found \`${clipInline(actual.trim())}\``
                    };
                    break;
                }
            }
        }

        if (mismatch) {
            const rangeLabel = spec.end_line > spec.start_line
                ? `L${spec.start_line}–L${spec.end_line}`
                : `L${spec.start_line}`;
            const actualSnippet = formatLineSlice(origLines, startIdx, endIdx, 30);
            let hint = mismatch.reason;
            const nearest = expNorm.trim() ? findNearestMatch(origText, expNorm) : null;
            if (nearest && nearest.score >= 0.8 && Math.abs(nearest.startLine - spec.start_line) > 0) {
                hint += ` (expect text appears near L${nearest.startLine}–L${nearest.endLine})`;
            }
            const err = new Error(`expect guard failed at ${rangeLabel}: ${mismatch.reason}.`);
            err.code = 'EXPECT_MISMATCH';
            err.actualSnippet = actualSnippet;
            err.rangeLabel = rangeLabel;
            err.hint = hint;
            throw err;
        }
    }

    const rBlock = normalizeEol(spec.replace_block);
    const newLines = rBlock === '' ? [] : rBlock.split('\n');

    return {
        spec,
        startIdx,
        endIdx,
        startLine: spec.start_line,
        endLine: spec.end_line,
        oldLines,
        newLines
    };
}

function shiftTrackedRanges(ranges, stepChanges) {
    if (!ranges.length || !stepChanges.length) return;
    for (const r of ranges) {
        let shiftStart = 0;
        let shiftEnd = 0;
        for (const ch of stepChanges) {
            if (ch.origEndLine < r.startLine) {
                shiftStart += ch.deltaLines;
                shiftEnd += ch.deltaLines;
            } else if (ch.origStartLine <= r.endLine) {
                if (ch.origStartLine < r.startLine) {
                    shiftStart += Math.min(0, ch.deltaLines);
                }
                shiftEnd += ch.deltaLines;
            }
        }
        r.startLine = Math.max(1, r.startLine + shiftStart);
        r.endLine = Math.max(r.startLine, r.endLine + shiftEnd);
    }
}

function applyEditBatch(original, items, isBatch = false) {
    const usesCRLF = String(original == null ? '' : original).includes('\r\n');
    const toFileEol = s => usesCRLF ? s.replace(/\n/g, '\r\n') : s;
    const origNorm = normalizeEol(original);
    const origLines = origNorm.split('\n');

    const lineItems = items.filter(it => it.kind === 'line');
    const searchItems = items.filter(it => it.kind === 'search');

    const appliedRanges = [];
    const records = [];

    // 1. Validate all line-anchored edits against ORIGINAL lines and check overlaps.
    const validatedLineEdits = [];
    for (const spec of lineItems) {
        try {
            validatedLineEdits.push(validateLineEdit(origLines, origNorm, spec));
        } catch (err) {
            err.editIndex = spec.index;
            err.editSpec = spec;
            err.isBatch = isBatch;
            throw err;
        }
    }

    if (validatedLineEdits.length > 1) {
        const byStart = [...validatedLineEdits].sort((a, b) =>
            a.startLine - b.startLine || a.endLine - b.endLine
        );
        for (let i = 1; i < byStart.length; i++) {
            const prev = byStart[i - 1];
            const cur = byStart[i];
            if (cur.startLine <= prev.endLine) {
                const err = new Error(
                    `edit #${prev.spec.index} (L${prev.startLine}–L${prev.endLine}) overlaps with edit #${cur.spec.index} (L${cur.startLine}–L${cur.endLine}).`
                );
                err.code = 'OVERLAP_ERROR';
                err.editIndex = cur.spec.index;
                err.editSpec = cur.spec;
                err.isBatch = isBatch;
                throw err;
            }
        }
    }

    // 2. Apply line-anchored edits bottom-up so earlier edits never shift later ones.
    let workingLines = origLines.slice();
    const bottomUp = [...validatedLineEdits].sort((a, b) => b.startLine - a.startLine);
    for (const item of bottomUp) {
        const deleteCount = item.endIdx - item.startIdx + 1;
        workingLines.splice(item.startIdx, deleteCount, ...item.newLines);

        const deltaLines = item.newLines.length - deleteCount;
        shiftTrackedRanges(appliedRanges, [{
            origStartLine: item.startLine,
            origEndLine: item.endLine,
            deltaLines
        }]);

        const newStartLine = item.startLine;
        const newEndLine = item.newLines.length === 0
            ? newStartLine
            : newStartLine + item.newLines.length - 1;
        const trackedRange = { startLine: newStartLine, endLine: newEndLine };
        appliedRanges.push(trackedRange);

        records.push({
            index: item.spec.index,
            kind: 'line',
            origStartLine: item.startLine,
            origEndLine: item.endLine,
            trackedRange,
            oldLines: item.oldLines,
            newLines: item.newLines,
            replacedCount: 1,
            matchCount: 1,
            matchLines: [item.startLine],
            occurrence: null
        });
    }

    let workingText = workingLines.join('\n');

    // 3. Apply search/replace edits sequentially in order.
    for (const spec of searchItems) {
        try {
            const res = applySearchReplace(workingText, spec.search_block, spec.replace_block, {
                occurrence: spec.occurrence,
                replaceAll: spec.replace_all
            });
            shiftTrackedRanges(appliedRanges, res.stepChanges);
            const trackedRanges = res.appliedRanges.map(r => ({ startLine: r.startLine, endLine: r.endLine }));
            appliedRanges.push(...trackedRanges);
            workingText = res.content;

            records.push({
                index: spec.index,
                kind: 'search',
                origStartLine: res.lineNumber,
                origEndLine: res.lineNumber + Math.max(0, res.oldLines.length - 1),
                trackedRange: trackedRanges[0],
                oldLines: res.oldLines,
                newLines: res.newLines,
                replacedCount: res.replacedCount || 1,
                matchCount: res.matchCount || 1,
                matchLines: res.matchLines || [res.lineNumber],
                occurrence: spec.occurrence
            });
        } catch (err) {
            err.editIndex = spec.index;
            err.editSpec = spec;
            err.isBatch = isBatch;
            err.workingContent = workingText;
            throw err;
        }
    }

    records.sort((a, b) => a.index - b.index);

    let totalAdded = 0;
    let totalRemoved = 0;
    let totalReplacements = 0;
    for (const rec of records) {
        totalRemoved += rec.oldLines.length * rec.replacedCount;
        totalAdded += rec.newLines.length * rec.replacedCount;
        totalReplacements += rec.replacedCount;
    }

    return {
        content: toFileEol(workingText),
        appliedRanges,
        records,
        totalAdded,
        totalRemoved,
        totalReplacements
    };
}

function formatChangedRegions(newContent, appliedRanges, contextLines = 4) {
    const norm = normalizeEol(newContent);
    if (norm === '') return '(file is now empty)';
    const lines = norm.split('\n');
    const total = lines.length;
    const ctx = Math.max(0, Number.isFinite(contextLines) ? Math.floor(contextLines) : 4);

    if (!Array.isArray(appliedRanges) || appliedRanges.length === 0) return '';

    const sorted = [...appliedRanges]
        .map(r => {
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
        })
        .sort((a, b) => a.winStart - b.winStart || a.winEnd - b.winEnd);

    // Merge overlapping or touching unclipped windows
    const blocks = [];
    for (const item of sorted) {
        const prev = blocks[blocks.length - 1];
        if (prev && !prev.clipped && !item.clipped && item.winStart <= prev.winEnd + 1) {
            prev.winEnd = Math.max(prev.winEnd, item.winEnd);
            prev.endLine = Math.max(prev.endLine, item.endLine);
        } else {
            blocks.push({ ...item });
        }
    }

    const limitedBlocks = blocks.slice(0, MAX_REPORTED_REGIONS);
    const sections = limitedBlocks.map(b => {
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
    if (blocks.length > MAX_REPORTED_REGIONS) {
        const extra = blocks.length - MAX_REPORTED_REGIONS;
        text += `\n… (${extra} more edited region${extra === 1 ? '' : 's'} omitted)`;
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
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function buildIntraLineHighlight(s1, s2) {
    let p = 0;
    while (p < s1.length && p < s2.length && s1[p] === s2[p]) p++;

    let s1End = s1.length - 1;
    let s2End = s2.length - 1;
    while (s1End >= p && s2End >= p && s1[s1End] === s2[s2End]) {
        s1End--;
        s2End--;
    }

    const prefix = escapeHtml(s1.slice(0, p));
    const suffix = escapeHtml(s1.slice(s1End + 1));
    const delMid = escapeHtml(s1.slice(p, s1End + 1));
    const addMid = escapeHtml(s2.slice(p, s2End + 1));

    return {
        del: `${prefix}<span style="background:color-mix(in srgb, var(--red) 35%, transparent); border-radius:2px; font-weight:600;">${delMid}</span>${suffix}`,
        add: `${prefix}<span style="background:color-mix(in srgb, var(--green) 35%, transparent); border-radius:2px; font-weight:600;">${addMid}</span>${suffix}`
    };
}

function renderRecordDiffRows(rec, showHeader, remainingBudget) {
    let html = '';
    let used = 0;

    if (showHeader) {
        const rangeLabel = rec.replacedCount > 1
            ? `${rec.replacedCount} matches`
            : (rec.oldLines.length > 1
                ? `L${rec.origStartLine}–L${rec.origStartLine + rec.oldLines.length - 1}`
                : `L${rec.origStartLine}`);
        const kindTag = rec.kind === 'line' ? 'line' : 'search';
        html += `
            <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--primary) 8%, transparent); color:var(--primary); font-size:10.5px; padding:2px 8px; justify-content:space-between;">
                <span>@@ edit #${rec.index} · ${rangeLabel} @@</span>
                <span style="opacity:0.75;">${kindTag}</span>
            </div>`;
    }

    let intra = null;
    if (rec.oldLines.length === 1 && rec.newLines.length === 1) {
        intra = buildIntraLineHighlight(rec.oldLines[0], rec.newLines[0]);
    }

    let lineNum = rec.origStartLine;
    for (let i = 0; i < rec.oldLines.length; i++) {
        if (used >= remainingBudget) {
            return { html, used, truncated: true };
        }
        const lineContent = intra ? intra.del : escapeHtml(rec.oldLines[i]);
        html += `
            <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--red) 12%, transparent); color:var(--red);">
                <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--red) 60%, transparent); border-right-color:color-mix(in srgb, var(--red) 20%, transparent);">${lineNum}</div>
                <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--red) 80%, transparent); flex-shrink:0;">-</div>
                <div class="tool-ui-line-content" style="color:inherit;">${lineContent}</div>
            </div>`;
        lineNum++;
        used++;
    }

    lineNum = rec.trackedRange ? rec.trackedRange.startLine : rec.origStartLine;
    for (let i = 0; i < rec.newLines.length; i++) {
        if (used >= remainingBudget) {
            return { html, used, truncated: true };
        }
        const lineContent = intra ? intra.add : escapeHtml(rec.newLines[i]);
        html += `
            <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--green) 12%, transparent); color:var(--green);">
                <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--green) 60%, transparent); border-right-color:color-mix(in srgb, var(--green) 20%, transparent);">${lineNum}</div>
                <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--green) 80%, transparent); flex-shrink:0;">+</div>
                <div class="tool-ui-line-content" style="color:inherit;">${lineContent}</div>
            </div>`;
        lineNum++;
        used++;
    }

    return { html, used, truncated: false };
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {

    function renderErrorHtml(filepath, errorMessage, hintText = null, failedSpec = null) {
        const pathParts = (filepath || '').split('/');
        const fileName  = pathParts.pop() || filepath;
        const dirPath   = pathParts.length ? pathParts.join('/') + '/' : '';

        const spec = failedSpec || (Array.isArray(args.edits) ? null : args);
        const searchRaw = spec
            ? (spec.search_block != null ? String(spec.search_block) : (spec.expect != null ? String(spec.expect) : ""))
            : "";
        const replaceRaw = spec && spec.replace_block != null ? String(spec.replace_block) : "";
        const searchLines  = searchRaw  === "" ? [] : searchRaw.split('\n');
        const replaceLines = replaceRaw === "" ? [] : replaceRaw.split('\n');

        let diffLinesHTML = '';
        let lineNum = (spec && Number.isInteger(spec.start_line)) ? spec.start_line : 1;
        searchLines.slice(0, 30).forEach(l => {
            diffLinesHTML += `
                <div class="tool-ui-line-row" style="background:color-mix(in srgb, var(--red) 8%, transparent); color:color-mix(in srgb, var(--red) 75%, var(--fg));">
                    <div class="tool-ui-line-no" style="color:color-mix(in srgb, var(--red) 40%, var(--dim)); border-right-color:color-mix(in srgb, var(--red) 15%, transparent);">${lineNum}</div>
                    <div style="width:20px; text-align:center; user-select:none; font-weight:700; color:color-mix(in srgb, var(--red) 60%, transparent); flex-shrink:0;">-</div>
                    <div class="tool-ui-line-content" style="color:inherit;">${escapeHtml(l)}</div>
                </div>`;
            lineNum++;
        });

        lineNum = (spec && Number.isInteger(spec.start_line)) ? spec.start_line : 1;
        replaceLines.slice(0, 30).forEach(l => {
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
        const { items, isBatch } = normalizeEditItems(args);
        originalContent = await api.readFile(args.filepath);
        if (typeof originalContent === 'string' && originalContent.length < 500 && /^ERROR: [^\n]*$/.test(originalContent)) {
            await api.showUI(renderErrorHtml(args.filepath, originalContent));
            return { output: originalContent };
        }

        const batchResult = applyEditBatch(originalContent, items, isBatch);
        const err = await api.writeFile(args.filepath, batchResult.content);
        if (err) {
            await api.showUI(renderErrorHtml(args.filepath, err));
            return { output: err };
        }

        // --- Metrics & Path Splitting ---------------------------------------

        const records = batchResult.records;
        const multiEdit = records.length > 1;
        const firstRec = records[0];

        const linesRemoved = batchResult.totalRemoved;
        const linesAdded   = batchResult.totalAdded;
        const delta        = linesAdded - linesRemoved;

        const startLineNum = firstRec.origStartLine;
        const endLineNum   = firstRec.oldLines.length > 0
            ? startLineNum + firstRec.oldLines.length - 1
            : startLineNum;

        let rangeText;
        if (multiEdit) {
            rangeText = `${records.length} edits`;
        } else if (firstRec.replacedCount > 1) {
            rangeText = `${firstRec.replacedCount} matches`;
        } else if (firstRec.oldLines.length > 1) {
            rangeText = `L${startLineNum}–L${endLineNum}`;
        } else if (firstRec.oldLines.length === 1) {
            rangeText = `L${startLineNum}`;
        } else {
            rangeText = `L${startLineNum} (ins)`;
        }

        const totalFileLines = batchResult.content === '' ? 0 : batchResult.content.split(/\r?\n/).length;

        const pathParts = args.filepath.split('/');
        const fileName  = pathParts.pop();
        const dirPath   = pathParts.length ? pathParts.join('/') + '/' : '';

        // --- Render Diff Lines ----------------------------------------------

        let diffLinesHTML = '';
        let previewRemaining = MAX_PREVIEW_DIFF_LINES;
        let previewTruncated = false;

        for (const rec of records) {
            if (previewRemaining <= 0) {
                previewTruncated = true;
                break;
            }
            const rendered = renderRecordDiffRows(rec, multiEdit, previewRemaining);
            diffLinesHTML += rendered.html;
            previewRemaining -= rendered.used;
            if (rendered.truncated) {
                previewTruncated = true;
                break;
            }
        }
        if (previewTruncated) {
            diffLinesHTML += `<div class="tool-ui-more">… preview truncated (all ${records.length} edit${records.length === 1 ? '' : 's'} applied)</div>`;
        }

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

        // --- Status Line ----------------------------------------------------

        let statusText;
        if (multiEdit) {
            const lineTags = records.slice(0, 8).map(r => `L${r.trackedRange ? r.trackedRange.startLine : r.origStartLine}`);
            statusText = `Applied ${records.length} edits (${lineTags.join(', ')}${records.length > 8 ? '…' : ''})`;
        } else if (firstRec.replacedCount > 1) {
            statusText = `Replaced ${firstRec.replacedCount} occurrences (lines ${firstRec.matchLines.slice(0, 8).join(', ')}${firstRec.matchLines.length > 8 ? '…' : ''})`;
        } else if (firstRec.matchCount > 1) {
            statusText = `Applied at line ${startLineNum} (occurrence ${firstRec.occurrence} of ${firstRec.matchCount})`;
        } else {
            statusText = `Applied at line ${startLineNum}`;
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
                        <span>${escapeHtml(statusText)}</span>
                    </div>
                    <span style="opacity:0.6;">${totalFileLines} total lines</span>
                </div>
            </div>
        `;

        // --- Model Output (changed areas + surrounding context) -------------

        let contextLines = Number(await api.getSetting('contextLines'));
        if (!Number.isFinite(contextLines) || contextLines < 0) contextLines = 4;

        let headline;
        if (multiEdit) {
            const extraRepl = batchResult.totalReplacements > records.length
                ? ` (${batchResult.totalReplacements} total replacements)`
                : '';
            headline = `Edited ${args.filepath}: applied ${records.length} edits${extraRepl}`;
        } else if (firstRec.replacedCount > 1) {
            headline = `Edited ${args.filepath}: replaced ${firstRec.replacedCount} occurrences (lines ${firstRec.matchLines.join(', ')})`;
        } else {
            headline = `Edited ${args.filepath} at ${rangeText}`;
        }

        const changedSnippet = formatChangedRegions(batchResult.content, batchResult.appliedRanges, contextLines);
        const resultText = changedSnippet
            ? api.cleanupText(`${headline}\n\n${changedSnippet}`)
            : headline;

        let summary;
        if (multiEdit) {
            summary = `${args.filepath} (${records.length} edits)`;
        } else if (firstRec.replacedCount > 1) {
            summary = `${args.filepath} (${firstRec.replacedCount}×)`;
        } else {
            summary = `${args.filepath}:${startLineNum}`;
        }

        await api.showUI(displayHtml);
        return { output: resultText, summary };
    } catch (e) {
        let hint = e && e.hint ? e.hint : null;
        const batchPrefix = (e && e.isBatch && e.editIndex) ? `edit #${e.editIndex} failed — ` : '';
        const errMessage = `${batchPrefix}${e.message || String(e)}`;
        let output = `ERROR: ${errMessage}`;

        if (e && e.code === 'EXPECT_MISMATCH' && e.actualSnippet) {
            const hintLine = hint ? `\nHint: ${hint}` : '';
            output = api.cleanupText(
                `ERROR: ${errMessage}${hintLine}\nCurrent content at ${e.rangeLabel}:\n${e.actualSnippet}`
            );
        } else if (e && e.code === 'NOT_FOUND') {
            const searchTarget = e.editSpec ? e.editSpec.search_block : args.search_block;
            const hay = typeof e.workingContent === 'string' ? e.workingContent : originalContent;
            if (typeof hay === 'string' && typeof searchTarget === 'string') {
                const nearest = findNearestMatch(hay, searchTarget);
                if (nearest) {
                    hint = nearest.hint;
                    output = api.cleanupText(
                        `ERROR: ${errMessage}\nHint: ${nearest.hint}\nNearest match (L${nearest.startLine}–L${nearest.endLine}):\n${nearest.snippet}`
                    );
                }
            }
        }

        await api.showUI(renderErrorHtml(args.filepath, errMessage, hint, e && e.editSpec ? e.editSpec : null));
        return { output };
    }
}