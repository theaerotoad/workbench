// --- workspace_changes.js ---
// Tracks workspace file snapshots between LLM turns so user edits made in the
// editor or externally on disk are summarized to the model on the next message.

const SNAPSHOT_STAT_CAP = 5000;
const SNAPSHOT_BATCH_SIZE = 32;
const SNAPSHOT_MAX_TEXT_BYTES = 1024 * 1024;            // 1 MB per-file cap for line diffs
const SNAPSHOT_MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024; // 16 MB total text-ref budget per snapshot
const NOTICE_MAX_REFETCH_FILES = 10;                    // Shared cap for external modified + added/rename reads
const NOTICE_REFETCH_TIMEOUT_MS = 3000;                 // Max time to wait on refetch reads before falling back
const NOTICE_SNIPPET_MAX_LINES = 6;                     // Show inline snippets when a file has <= 6 changed lines
const NOTICE_SNIPPET_CONTEXT_CHARS = 60;                // Context kept on each side of an inline change
const NOTICE_SNIPPET_MAX_CHANGE_CHARS = 160;            // Cap per-side removed/inserted text in a single snippet
const NOTICE_MAX_SNIPPET_BYTES = 2048;                  // Total snippet budget across the entire notice
const NOTICE_MAX_RANGES_PER_FILE = 6;                   // Cap displayed line ranges per file
const NOTICE_WORD_BOUNDARY_MAX_STEP = 32;               // Max chars to shift prefix/suffix cut to a word boundary
const RENAME_SIMILARITY_THRESHOLD = 0.5;                // Standard rename+edit similarity threshold
const RENAME_DIR_FALLBACK_THRESHOLD = 0.3;              // 1-to-1 same-dir same-ext fallback similarity threshold
const RENAME_NGRAM_WINDOW_CHARS = 65536;                // Cap n-gram input size for fast similarity checks

const _noticeTextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function _utf8ByteLength(str) {
    return _noticeTextEncoder ? _noticeTextEncoder.encode(str).length : str.length;
}

function _formatByteInt(n) {
    return Math.round(n).toLocaleString('en-US');
}

function _pathDirname(fp) {
    const i = fp.lastIndexOf('/');
    return i === -1 ? '' : fp.slice(0, i);
}

function _pathBasename(fp) {
    const i = fp.lastIndexOf('/');
    return i === -1 ? fp : fp.slice(i + 1);
}

function _pathExtname(fp) {
    const base = _pathBasename(fp);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function _isWordChar(ch) {
    return typeof ch === 'string' && /[\p{L}\p{N}_]/u.test(ch);
}

function _sanitizeSnippetText(str) {
    return String(str)
        .replace(/\r\n/g, '\\r\\n')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, ' ')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/[\[\]⟨⟩]/g, ch => '\\' + ch);
}

function _clipText(str, maxLen) {
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function _formatLineSnippet(lineNo, oldLine, newLine) {
    if (oldLine === null) {
        if (newLine === '') return `    L${lineNo}: ⟨+(blank line)⟩`;
        return `    L${lineNo}: ⟨+${_sanitizeSnippetText(_clipText(newLine, NOTICE_SNIPPET_MAX_CHANGE_CHARS))}⟩`;
    }
    if (newLine === null) {
        if (oldLine === '') return `    L${lineNo}: ⟨−(blank line)⟩`;
        return `    L${lineNo}: ⟨−${_sanitizeSnippetText(_clipText(oldLine, NOTICE_SNIPPET_MAX_CHANGE_CHARS))}⟩`;
    }

    let p = 0;
    const minLen = Math.min(oldLine.length, newLine.length);
    while (p < minLen && oldLine.charCodeAt(p) === newLine.charCodeAt(p)) p++;

    let s = 0;
    const maxSuffix = minLen - p;
    while (s < maxSuffix && oldLine.charCodeAt(oldLine.length - 1 - s) === newLine.charCodeAt(newLine.length - 1 - s)) s++;

    // Snap mid-word cut points to word boundaries (capped so huge tokens/hashes still highlight the edit).
    if (p > 0 && _isWordChar(oldLine[p - 1]) &&
        ((p < oldLine.length && _isWordChar(oldLine[p])) ||
         (p < newLine.length && _isWordChar(newLine[p])))) {
        let p2 = p;
        let steps = 0;
        while (p2 > 0 && _isWordChar(oldLine[p2 - 1]) && steps < NOTICE_WORD_BOUNDARY_MAX_STEP) {
            p2--;
            steps++;
        }
        if (p2 === 0 || !_isWordChar(oldLine[p2 - 1])) {
            p = p2;
        }
    }

    if (s > 0 && _isWordChar(oldLine[oldLine.length - s]) &&
        ((oldLine.length - s > p && _isWordChar(oldLine[oldLine.length - s - 1])) ||
         (newLine.length - s > p && _isWordChar(newLine[newLine.length - s - 1])))) {
        let s2 = s;
        let steps = 0;
        while (s2 > 0 && _isWordChar(oldLine[oldLine.length - s2]) && steps < NOTICE_WORD_BOUNDARY_MAX_STEP) {
            s2--;
            steps++;
        }
        if (s2 === 0 || !_isWordChar(oldLine[oldLine.length - s2])) {
            s = s2;
        }
    }

    if (p + s > minLen) s = Math.max(0, minLen - p);

    const prefix = oldLine.slice(0, p);
    const suffix = s > 0 ? oldLine.slice(oldLine.length - s) : '';
    const removed = oldLine.slice(p, oldLine.length - s);
    const inserted = newLine.slice(p, newLine.length - s);

    const prefixOut = prefix.length > NOTICE_SNIPPET_CONTEXT_CHARS
        ? '…' + prefix.slice(-NOTICE_SNIPPET_CONTEXT_CHARS)
        : prefix;
    const suffixOut = suffix.length > NOTICE_SNIPPET_CONTEXT_CHARS
        ? suffix.slice(0, NOTICE_SNIPPET_CONTEXT_CHARS) + '…'
        : suffix;
    const removedOut = _clipText(removed, NOTICE_SNIPPET_MAX_CHANGE_CHARS);
    const insertedOut = _clipText(inserted, NOTICE_SNIPPET_MAX_CHANGE_CHARS);

    let body = '';
    if (prefixOut) body += _sanitizeSnippetText(prefixOut);
    if (removedOut) body += `⟨−${_sanitizeSnippetText(removedOut)}⟩`;
    if (insertedOut) body += `⟨+${_sanitizeSnippetText(insertedOut)}⟩`;
    if (suffixOut) body += _sanitizeSnippetText(suffixOut);
    return `    L${lineNo}: ${body}`;
}

function _summarizeHunksFromDiff(diffRes) {
    if (!diffRes) return null;
    if (diffRes.approximate || !Array.isArray(diffRes.hunks)) {
        return { ranges: [], snippets: [], approximate: true };
    }
    if (diffRes.hunks.length === 0) return null;

    const ranges = [];
    let totalChangedLines = 0;
    for (const h of diffRes.hunks) {
        const startLine = h.newStart;
        const endLine = h.newLines.length > 0 ? h.newStart + h.newLines.length - 1 : h.newStart;
        const prev = ranges[ranges.length - 1];
        if (prev && startLine <= prev[1] + 1) {
            if (endLine > prev[1]) prev[1] = endLine;
        } else {
            ranges.push([startLine, endLine]);
        }
        totalChangedLines += Math.max(h.oldLines.length, h.newLines.length);
    }

    const snippets = [];
    if (totalChangedLines > 0 && totalChangedLines <= NOTICE_SNIPPET_MAX_LINES) {
        for (const h of diffRes.hunks) {
            const paired = Math.min(h.oldLines.length, h.newLines.length);
            for (let i = 0; i < paired; i++) {
                snippets.push({
                    line: h.newStart + i,
                    before: h.oldLines[i],
                    after: h.newLines[i]
                });
            }
            for (let i = paired; i < h.newLines.length; i++) {
                snippets.push({
                    line: h.newStart + i,
                    before: null,
                    after: h.newLines[i]
                });
            }
            for (let i = paired; i < h.oldLines.length; i++) {
                snippets.push({
                    line: h.newStart + paired,
                    before: h.oldLines[i],
                    after: null
                });
            }
        }
    }

    return { ranges, snippets, approximate: false };
}

function _summarizeHunks(beforeText, afterText) {
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') return null;
    if (beforeText === afterText) return null;
    if (beforeText.length > SNAPSHOT_MAX_TEXT_BYTES || afterText.length > SNAPSHOT_MAX_TEXT_BYTES) return null;
    if (typeof window.computeLineDiffHunks !== 'function') return null;
    return _summarizeHunksFromDiff(window.computeLineDiffHunks(beforeText, afterText));
}

function _formatLineRanges(ranges) {
    if (!Array.isArray(ranges) || ranges.length === 0) return '';
    const shown = ranges.slice(0, NOTICE_MAX_RANGES_PER_FILE);
    const parts = shown.map(([s, e]) => (s === e ? `L${s}` : `L${s}–${e}`));
    if (ranges.length > shown.length) {
        parts.push(`… (+${ranges.length - shown.length} more)`);
    }
    return parts.join(', ');
}

function _getRootHandle() {
    if (typeof rootHandle !== 'undefined' && rootHandle) return rootHandle;
    return window.rootHandle || null;
}

function _isChangeNotifyEnabled() {
    const raw = window.AppConfig?.get('notify-workspace-changes', 'true');
    return String(raw ?? 'true') !== 'false';
}

function _getChangeNotifyMax() {
    const raw = window.AppConfig?.get('notify-workspace-changes-max', '25');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
}

function _fastHashString(str) {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c64e6d ^ str.length;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function _countLines(text) {
    if (typeof window.lineCount === 'function') return window.lineCount(text);
    if (!text) return 0;
    const n = text.split('\n').length;
    return text.endsWith('\n') ? n - 1 : n;
}

// Uses the same visibility rules as TOOL_API_METHODS.listFiles, excluding transient
// prompt attachments (.agent/attachments/*) which are created when sending a message.
function _listSnapshotPaths() {
    const metaMap = window.registry?.meta;
    if (!metaMap) return [];
    const isProtected = window.isSecurityProtectedPath;
    const isSensitive = window.isSensitiveUserFile;
    const shouldHide = window.shouldHideFromTools;
    const isAgent = window.isAgentPath;
    const isToolFile = window.isToolFilePath;
    const isVirtualAgent = window.isVirtualAgentFile;
    const isSkill = window.isSkillPath;
    const isAttachment = window.isAttachmentPath;

    return Object.keys(metaMap).filter(f => {
        const m = metaMap[f];
        if (!m || m.kind !== 'file' || m.attachment) return false;
        if (isAttachment && isAttachment(f)) return false;
        if (isProtected && isProtected(f)) return false;
        if (isSensitive && isSensitive(f)) return false;
        if (shouldHide && shouldHide(f)) return false;
        if (isAgent && isAgent(f) &&
            !(isToolFile && isToolFile(f)) &&
            !(isVirtualAgent && isVirtualAgent(f)) &&
            !(isSkill && isSkill(f))) {
            return false;
        }
        return true;
    }).sort();
}

async function takeWorkspaceSnapshot(opts = {}) {
    const ts = Date.now();
    const root = _getRootHandle();
    const wsKey = typeof window.currentWsName === 'function' ? window.currentWsName() : '';
    const statCap = Number.isFinite(opts.statCap) && opts.statCap > 0 ? opts.statCap : SNAPSHOT_STAT_CAP;
    const paths = _listSnapshotPaths();
    const isWebDAV = !!(root && root.isWebDAV);
    const degraded = !isWebDAV && !!root && paths.length > statCap;

    const files = Object.create(null);
    const toStat = [];
    let totalTextBytes = 0;

    const metaMap = window.registry?.meta || {};
    const cachedFiles = window.registry?.files || {};
    const models = window.monacoModels;
    const checkDirty = typeof window.isFileDirty === 'function' ? window.isFileDirty : null;
    const checkBinContent = typeof window.isBinaryContent === 'function' ? window.isBinaryContent : null;
    const binExtRe = window.BINARY_EXT_DEFINITE;

    for (const fp of paths) {
        const meta = metaMap[fp];
        if (!meta) continue;

        const dirty = !!(checkDirty && checkDirty(fp) && models && models.has(fp));
        let rawText = null;
        if (dirty) {
            rawText = models.get(fp).getValue();
        } else if (typeof cachedFiles[fp] === 'string') {
            rawText = cachedFiles[fp];
        }

        let isBinary = dirty ? false : !!(meta.isBinary || (binExtRe && binExtRe.test(fp)));
        if (rawText !== null && !isBinary && checkBinContent && checkBinContent(rawText)) {
            isBinary = true;
        }

        let hash = null;
        let lines = null;
        let text = null;
        if (rawText !== null && !isBinary) {
            hash = _fastHashString(rawText);
            lines = _countLines(rawText);
            if (rawText.length <= SNAPSHOT_MAX_TEXT_BYTES && totalTextBytes + rawText.length <= SNAPSHOT_MAX_TOTAL_TEXT_BYTES) {
                text = rawText;
                totalTextBytes += rawText.length;
            }
        }

        const entry = {
            size: null,
            mtime: null,
            hash,
            lines,
            text,
            dirty,
            isBinary
        };

        if (meta.virtual || !root) {
            entry.size = rawText !== null ? rawText.length : (typeof meta.size === 'number' ? meta.size : 0);
            entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
        } else if (isWebDAV) {
            entry.size = typeof meta.size === 'number' ? meta.size : null;
            entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
        } else if (degraded) {
            entry.size = typeof meta.size === 'number' && meta.size > 0 ? meta.size : null;
            entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
        } else {
            toStat.push({ fp, meta, entry, hasInMemText: rawText !== null });
        }

        files[fp] = entry;
    }

    if (toStat.length > 0) {
        for (let i = 0; i < toStat.length; i += SNAPSHOT_BATCH_SIZE) {
            if (_getRootHandle() !== root) break;
            const batch = toStat.slice(i, i + SNAPSHOT_BATCH_SIZE);
            await Promise.all(batch.map(async ({ fp, meta, entry, hasInMemText }) => {
                try {
                    const handle = meta.handle || (typeof window.getHandleByPath === 'function'
                        ? await window.getHandleByPath(fp, false, root)
                        : null);
                    if (!handle || typeof handle.getFile !== 'function') {
                        entry.size = typeof meta.size === 'number' ? meta.size : null;
                        entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
                        return;
                    }
                    const file = await handle.getFile();
                    const size = typeof file.size === 'number' ? file.size : null;
                    const mtime = file.lastModified ? file.lastModified / 1000 : null;
                    entry.size = size;
                    entry.mtime = mtime;
                    if (size !== null) meta.size = size;
                    if (mtime !== null) meta.mtime = mtime;
                } catch (err) {
                    if (err && err.name === 'NotFoundError') {
                        if (fp === window.PLAN_FILE && hasInMemText) {
                            entry.size = entry.text !== null ? entry.text.length : null;
                            entry.mtime = null;
                        } else {
                            delete files[fp];
                        }
                    } else {
                        entry.size = typeof meta.size === 'number' ? meta.size : null;
                        entry.mtime = meta.mtime !== undefined ? meta.mtime : null;
                    }
                }
            }));
        }
    }

    return {
        ts,
        wsKey,
        degraded,
        fileCount: Object.keys(files).length,
        files
    };
}

function _classifyModificationSource(fp, prevTs, sessionId) {
    const sid = sessionId || window.state?.activeSessionId;
    const ctx = typeof window.sessionCtx === 'function' ? window.sessionCtx(sid) : null;
    const curOpsLog = ctx?.baseline?.opsLog || window.registry?.opsLog || {};

    let latestEditorOp = null;
    const curOps = curOpsLog[fp];
    if (Array.isArray(curOps)) {
        for (let i = curOps.length - 1; i >= 0; i--) {
            const op = curOps[i];
            if (!op || typeof op.ts !== 'number' || op.ts <= prevTs) continue;
            if (op.mode === 'editor') {
                latestEditorOp = op;
                break;
            }
        }
    }
    if (latestEditorOp) {
        return {
            source: 'saved in editor',
            opContent: typeof latestEditorOp.content === 'string' ? latestEditorOp.content : null
        };
    }

    // Check other loaded sessions' opsLogs for editor saves or cross-session tool writes.
    let latestOtherOp = null;
    const sessions = window.state?.sessions || {};
    for (const [otherId, s] of Object.entries(sessions)) {
        if (otherId === sid) continue;
        const otherOps = s?._baseline?.opsLog?.[fp];
        if (!Array.isArray(otherOps)) continue;
        for (let i = otherOps.length - 1; i >= 0; i--) {
            const op = otherOps[i];
            if (!op || typeof op.ts !== 'number' || op.ts <= prevTs) continue;
            if (!latestOtherOp || op.ts > latestOtherOp.ts) {
                latestOtherOp = op;
            }
            break;
        }
    }
    if (latestOtherOp) {
        const source = latestOtherOp.mode === 'editor' ? 'saved in editor' : 'by another session';
        return {
            source,
            opContent: typeof latestOtherOp.content === 'string' ? latestOtherOp.content : null
        };
    }

    return { source: 'on disk', opContent: null };
}

function _analyzeTextChange(beforeText, afterText) {
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') return null;
    if (beforeText === afterText) return null;
    if (beforeText.length > SNAPSHOT_MAX_TEXT_BYTES || afterText.length > SNAPSHOT_MAX_TEXT_BYTES) return null;

    if (typeof window.computeLineDiffHunks === 'function') {
        const res = window.computeLineDiffHunks(beforeText, afterText);
        if (!res) return null;
        if (res.lineEndingsOnly) {
            return { delta: null, hunks: null, lineEndingsOnly: true };
        }
        if (res.added === 0 && res.removed === 0) {
            return { delta: null, hunks: null, lineEndingsOnly: false };
        }
        return {
            delta: { added: res.added, removed: res.removed },
            hunks: _summarizeHunksFromDiff(res),
            lineEndingsOnly: false
        };
    }

    if (typeof window.computeLineDiffCounts !== 'function') return null;
    if (beforeText.replace(/\r\n?/g, '\n') === afterText.replace(/\r\n?/g, '\n')) {
        return { delta: null, hunks: null, lineEndingsOnly: true };
    }
    const d = window.computeLineDiffCounts(beforeText, afterText);
    if (!d || (d.added === 0 && d.removed === 0)) return null;
    return { delta: d, hunks: null, lineEndingsOnly: false };
}

function _computeDeltaIfCached(beforeText, afterText) {
    const analysis = _analyzeTextChange(beforeText, afterText);
    return analysis ? analysis.delta : null;
}

// Pairs added & deleted entries into renames in-place.
// Pass 1: unique 1-to-1 exact hash match.
// Pass 2 (when allowSizeFallback is true): unique 1-to-1 size > 0 match with same basename or non-empty extension,
// only when at least one side lacks a hash (so known unequal hashes are never paired).
function _detectRenames(added, deleted, renamedOut, { allowSizeFallback = true } = {}) {
    if (!added.length || !deleted.length) return;

    const removeMatched = (matchedAdd, matchedDel) => {
        if (matchedAdd.size > 0) {
            for (let i = added.length - 1; i >= 0; i--) {
                if (matchedAdd.has(added[i])) added.splice(i, 1);
            }
        }
        if (matchedDel.size > 0) {
            for (let i = deleted.length - 1; i >= 0; i--) {
                if (matchedDel.has(deleted[i])) deleted.splice(i, 1);
            }
        }
    };

    // Pass 1: exact 1-to-1 hash match.
    const addByHash = new Map();
    const delByHash = new Map();
    for (const a of added) {
        if (a.hash !== null && a.hash !== undefined) {
            const list = addByHash.get(a.hash) || [];
            list.push(a);
            addByHash.set(a.hash, list);
        }
    }
    for (const d of deleted) {
        if (d.hash !== null && d.hash !== undefined) {
            const list = delByHash.get(d.hash) || [];
            list.push(d);
            delByHash.set(d.hash, list);
        }
    }

    const matchedAdd1 = new Set();
    const matchedDel1 = new Set();
    for (const [h, delList] of delByHash.entries()) {
        const addList = addByHash.get(h);
        if (delList.length === 1 && addList && addList.length === 1) {
            renamedOut.push({ from: delList[0].path, to: addList[0].path });
            matchedDel1.add(delList[0]);
            matchedAdd1.add(addList[0]);
        }
    }
    removeMatched(matchedAdd1, matchedDel1);

    if (!allowSizeFallback || !added.length || !deleted.length) return;

    // Pass 2: unique 1-to-1 non-zero size match + same basename or non-empty extension.
    const addBySize = new Map();
    const delBySize = new Map();
    for (const a of added) {
        if (typeof a.size === 'number' && a.size > 0) {
            const list = addBySize.get(a.size) || [];
            list.push(a);
            addBySize.set(a.size, list);
        }
    }
    for (const d of deleted) {
        if (typeof d.size === 'number' && d.size > 0) {
            const list = delBySize.get(d.size) || [];
            list.push(d);
            delBySize.set(d.size, list);
        }
    }

    const matchedAdd2 = new Set();
    const matchedDel2 = new Set();
    for (const [sz, delList] of delBySize.entries()) {
        const addList = addBySize.get(sz);
        if (delList.length !== 1 || !addList || addList.length !== 1) continue;
        const d = delList[0];
        const a = addList[0];
        // If both hashes are known and didn't pair in Pass 1, they differ — never pair them.
        if (d.hash !== null && d.hash !== undefined && a.hash !== null && a.hash !== undefined) continue;
        const sameBase = _pathBasename(d.path) === _pathBasename(a.path);
        const extD = _pathExtname(d.path);
        const sameExt = extD !== '' && extD === _pathExtname(a.path);
        if (sameBase || sameExt) {
            renamedOut.push({ from: d.path, to: a.path });
            matchedDel2.add(d);
            matchedAdd2.add(a);
        }
    }
    removeMatched(matchedAdd2, matchedDel2);
}

function _isFuzzyRenameCandidate(delPath, delSizeRaw, delText, addPath, addSizeRaw, addText = null) {
    const sameDir = _pathDirname(delPath) === _pathDirname(addPath);
    const extD = _pathExtname(delPath);
    const sameExt = extD !== '' && extD === _pathExtname(addPath);
    if (!sameDir && !sameExt) return false;

    const delSize = typeof delSizeRaw === 'number' && delSizeRaw > 0
        ? delSizeRaw
        : (typeof delText === 'string' ? _utf8ByteLength(delText) : 0);
    const addSize = typeof addSizeRaw === 'number' && addSizeRaw > 0
        ? addSizeRaw
        : (typeof addText === 'string' ? _utf8ByteLength(addText) : 0);
    if (delSize <= 0 || addSize <= 0) return false;

    return Math.min(delSize, addSize) / Math.max(delSize, addSize) >= 0.5;
}

function _stripBlankLines(normText) {
    return normText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .join('\n');
}

function _sampleForNgram(str) {
    if (str.length <= RENAME_NGRAM_WINDOW_CHARS) return str;
    const half = Math.floor(RENAME_NGRAM_WINDOW_CHARS / 2);
    return str.slice(0, half) + '\n' + str.slice(-half);
}

// Sørensen-Dice similarity on character n-grams (4-grams normally, 2-grams for very short text),
// computed over non-blank lines so blank lines never inflate similarity.
function _textNgramDice(normA, normB) {
    const sA = _sampleForNgram(_stripBlankLines(normA));
    const sB = _sampleForNgram(_stripBlankLines(normB));
    if (!sA.length || !sB.length) return 0;
    if (sA === sB) return 1;

    const minLen = Math.min(sA.length, sB.length);
    if (minLen < 2) return sA === sB ? 1 : 0;
    const n = minLen < 12 ? 2 : 4;

    const counts = new Map();
    const totalA = sA.length - n + 1;
    const totalB = sB.length - n + 1;
    for (let i = 0; i < totalA; i++) {
        const g = sA.slice(i, i + n);
        counts.set(g, (counts.get(g) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < totalB; i++) {
        const g = sB.slice(i, i + n);
        const c = counts.get(g);
        if (c > 0) {
            intersection++;
            if (c === 1) counts.delete(g);
            else counts.set(g, c - 1);
        }
    }

    return (2 * intersection) / (totalA + totalB);
}

function _sharedPrefixSuffixLen(a, b) {
    const minLen = Math.min(a.length, b.length);
    let p = 0;
    while (p < minLen && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    const maxS = minLen - p;
    while (s < maxS && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return p + s;
}

// Character-level similarity using line-diff hunks (ignoring blank/whitespace-only lines):
// unchanged non-blank lines plus shared prefix+suffix chars of adjacent paired lines in each hunk.
function _pairedLineCharSimilarity(aLines, bLines, diffRes) {
    let oldChars = 0;
    for (const l of aLines) {
        const t = l.trim();
        if (t.length > 0) oldChars += t.length;
    }
    let newChars = 0;
    for (const l of bLines) {
        const t = l.trim();
        if (t.length > 0) newChars += t.length;
    }
    const maxChars = Math.max(oldChars, newChars);
    if (maxChars === 0) return 0;

    if (!diffRes || diffRes.approximate || !Array.isArray(diffRes.hunks)) {
        return 0;
    }

    let removedChars = 0;
    let pairedChars = 0;
    for (const h of diffRes.hunks) {
        const oldNB = [];
        const newNB = [];
        for (const l of h.oldLines) {
            const t = l.trim();
            if (t.length > 0) {
                removedChars += t.length;
                oldNB.push(t);
            }
        }
        for (const l of h.newLines) {
            const t = l.trim();
            if (t.length > 0) newNB.push(t);
        }
        const pairs = Math.min(oldNB.length, newNB.length);
        for (let k = 0; k < pairs; k++) {
            pairedChars += _sharedPrefixSuffixLen(oldNB[k], newNB[k]);
        }
    }

    const unchangedChars = Math.max(0, oldChars - removedChars);
    return (unchangedChars + pairedChars) / maxChars;
}

function _computeRenameSimilarity(beforeText, afterText, minScore = RENAME_SIMILARITY_THRESHOLD) {
    if (typeof beforeText !== 'string' || typeof afterText !== 'string') return null;
    if (!beforeText.length || !afterText.length) return null;
    if (beforeText.length > SNAPSHOT_MAX_TEXT_BYTES || afterText.length > SNAPSHOT_MAX_TEXT_BYTES) return null;
    if (beforeText === afterText) {
        return { score: 1, delta: null, hunks: null, lineEndingsOnly: false };
    }

    const normA = beforeText.replace(/\r\n?/g, '\n');
    const normB = afterText.replace(/\r\n?/g, '\n');
    if (normA === normB) {
        return { score: 1, delta: null, hunks: null, lineEndingsOnly: true };
    }

    const aLines = normA.split('\n');
    const bLines = normB.split('\n');
    const ngramSim = _textNgramDice(normA, normB);

    if (typeof window.computeLineDiffHunks === 'function') {
        const res = window.computeLineDiffHunks(beforeText, afterText);
        if (!res) return null;
        const pairedSim = _pairedLineCharSimilarity(aLines, bLines, res);
        const score = Math.max(pairedSim, ngramSim);
        if (score < minScore) return null;

        return {
            score,
            delta: (res.added > 0 || res.removed > 0) ? { added: res.added, removed: res.removed } : null,
            hunks: _summarizeHunksFromDiff(res),
            lineEndingsOnly: false
        };
    }

    if (ngramSim < minScore) return null;
    const d = typeof window.computeLineDiffCounts === 'function'
        ? window.computeLineDiffCounts(beforeText, afterText)
        : null;
    return {
        score: ngramSim,
        delta: (d && (d.added > 0 || d.removed > 0)) ? d : null,
        hunks: null,
        lineEndingsOnly: false
    };
}

// Pairs remaining deleted & added files that were both renamed and edited:
// Pass A: standard candidates (same dir or ext, size within ±50%), char similarity >= 0.5, unique 1-to-1.
// Pass B: directory fallback — when a directory has exactly one unpaired deleted and one unpaired added
//         file with the same extension, pair them if char similarity >= 0.3.
function _detectEditedRenames(added, deleted, renamedOut, prevFiles, nextFiles) {
    if (!added.length || !deleted.length || !prevFiles || !nextFiles) return;

    const removeMatched = (matchedAdd, matchedDel) => {
        if (matchedAdd.size > 0) {
            for (let i = added.length - 1; i >= 0; i--) {
                if (matchedAdd.has(added[i])) added.splice(i, 1);
            }
        }
        if (matchedDel.size > 0) {
            for (let i = deleted.length - 1; i >= 0; i--) {
                if (matchedDel.has(deleted[i])) deleted.splice(i, 1);
            }
        }
    };

    // Pass A: standard rename+edit matching (>= 0.5).
    const edgesByDel = new Map();
    const edgesByAdd = new Map();

    for (const d of deleted) {
        const oldText = prevFiles[d.path]?.text;
        if (typeof oldText !== 'string' || !oldText.length || oldText.length > SNAPSHOT_MAX_TEXT_BYTES) continue;

        for (const a of added) {
            if (a.isBinary) continue;
            const newText = nextFiles[a.path]?.text;
            if (typeof newText !== 'string' || !newText.length || newText.length > SNAPSHOT_MAX_TEXT_BYTES) continue;
            if (!_isFuzzyRenameCandidate(d.path, d.size, oldText, a.path, a.size, newText)) continue;

            const analysis = _computeRenameSimilarity(oldText, newText, RENAME_SIMILARITY_THRESHOLD);
            if (!analysis) continue;

            const edge = { d, a, analysis };
            const dList = edgesByDel.get(d) || [];
            dList.push(edge);
            edgesByDel.set(d, dList);

            const aList = edgesByAdd.get(a) || [];
            aList.push(edge);
            edgesByAdd.set(a, aList);
        }
    }

    const matchedAddA = new Set();
    const matchedDelA = new Set();
    for (const [d, dList] of edgesByDel.entries()) {
        if (dList.length !== 1) continue;
        const edge = dList[0];
        const aList = edgesByAdd.get(edge.a);
        if (!aList || aList.length !== 1) continue;

        renamedOut.push({
            from: d.path,
            to: edge.a.path,
            delta: edge.analysis.delta,
            hunks: edge.analysis.hunks,
            lineEndingsOnly: !!edge.analysis.lineEndingsOnly
        });
        matchedDelA.add(d);
        matchedAddA.add(edge.a);
    }
    removeMatched(matchedAddA, matchedDelA);

    if (!added.length || !deleted.length) return;

    // Pass B: directory fallback — sole unpaired deleted + sole unpaired added in same dir with same ext (>= 0.3).
    const delByDir = new Map();
    const addByDir = new Map();
    for (const d of deleted) {
        const dir = _pathDirname(d.path);
        const list = delByDir.get(dir) || [];
        list.push(d);
        delByDir.set(dir, list);
    }
    for (const a of added) {
        const dir = _pathDirname(a.path);
        const list = addByDir.get(dir) || [];
        list.push(a);
        addByDir.set(dir, list);
    }

    const matchedAddB = new Set();
    const matchedDelB = new Set();
    for (const [dir, delList] of delByDir.entries()) {
        const addList = addByDir.get(dir);
        if (delList.length !== 1 || !addList || addList.length !== 1) continue;
        const d = delList[0];
        const a = addList[0];
        if (a.isBinary) continue;
        if (_pathExtname(d.path) !== _pathExtname(a.path)) continue;

        const oldText = prevFiles[d.path]?.text;
        const newText = nextFiles[a.path]?.text;
        if (typeof oldText !== 'string' || !oldText.length || oldText.length > SNAPSHOT_MAX_TEXT_BYTES) continue;
        if (typeof newText !== 'string' || !newText.length || newText.length > SNAPSHOT_MAX_TEXT_BYTES) continue;

        const analysis = _computeRenameSimilarity(oldText, newText, RENAME_DIR_FALLBACK_THRESHOLD);
        if (!analysis) continue;

        renamedOut.push({
            from: d.path,
            to: a.path,
            delta: analysis.delta,
            hunks: analysis.hunks,
            lineEndingsOnly: !!analysis.lineEndingsOnly
        });
        matchedDelB.add(d);
        matchedAddB.add(a);
    }
    removeMatched(matchedAddB, matchedDelB);
}

function diffWorkspaceSnapshot(prev, next, sessionId, opts = {}) {
    const empty = { modified: [], unsaved: [], renamed: [], added: [], deleted: [], total: 0 };
    if (!prev || !next || !prev.files || !next.files) return empty;
    if (prev.wsKey && next.wsKey && prev.wsKey !== next.wsKey) return empty;

    const modified = [];
    const unsaved = [];
    const renamed = [];
    const added = [];
    const deleted = [];

    for (const fp of Object.keys(prev.files)) {
        if (!next.files[fp]) {
            const old = prev.files[fp];
            deleted.push({ path: fp, size: old.size, hash: old.hash });
        }
    }

    for (const fp of Object.keys(next.files)) {
        const cur = next.files[fp];
        const old = prev.files[fp];

        if (!old) {
            if (cur.dirty) {
                unsaved.push({ path: fp, delta: null, hunks: null, lineEndingsOnly: false, lines: cur.lines });
            } else {
                added.push({ path: fp, lines: cur.lines, size: cur.size, isBinary: cur.isBinary, hash: cur.hash });
            }
            continue;
        }

        if (cur.dirty) {
            // Report when a buffer becomes dirty or its unsaved content changes since the last snapshot.
            if (!old.dirty || (cur.hash !== null && old.hash !== null && cur.hash !== old.hash)) {
                const analysis = _analyzeTextChange(old.text, cur.text);
                unsaved.push({
                    path: fp,
                    delta: analysis ? analysis.delta : null,
                    hunks: analysis ? analysis.hunks : null,
                    lineEndingsOnly: !!(analysis && analysis.lineEndingsOnly),
                    lines: cur.lines
                });
            }
            continue;
        }

        const mtimeChanged = old.mtime !== null && cur.mtime !== null && old.mtime !== cur.mtime;
        const sizeChanged = old.size !== null && cur.size !== null && old.size !== cur.size;
        const diskChanged = mtimeChanged || sizeChanged;
        const hashChanged = old.hash !== null && cur.hash !== null && old.hash !== cur.hash;

        // If the buffer was dirty on the previous turn and the user simply saved the
        // exact same text, tools already saw this version — skip reporting a duplicate change.
        if (old.dirty && !cur.dirty && old.hash !== null && cur.hash !== null && old.hash === cur.hash) {
            continue;
        }

        if (!hashChanged && !diskChanged) {
            // In degraded mode (>5,000 local files without stat), fall back to checking opsLog.
            if (prev.degraded || next.degraded) {
                const modInfo = _classifyModificationSource(fp, prev.ts, sessionId);
                if (modInfo.source !== 'on disk') {
                    const afterText = cur.text ?? modInfo.opContent;
                    if (old.text === null || afterText === null || old.text !== afterText) {
                        const analysis = _analyzeTextChange(old.text, afterText);
                        modified.push({
                            path: fp,
                            source: modInfo.source,
                            delta: analysis ? analysis.delta : null,
                            hunks: analysis ? analysis.hunks : null,
                            lineEndingsOnly: !!(analysis && analysis.lineEndingsOnly),
                            oldSize: old.size,
                            newSize: cur.size,
                            isBinary: cur.isBinary
                        });
                    }
                }
            }
            continue;
        }

        const modInfo = _classifyModificationSource(fp, prev.ts, sessionId);

        // Local-folder scans do not invalidate registry.files when a file changes outside
        // Workbench. If disk mtime/size changed while registry.files still matches the old
        // hash, drop the stale cache entry so subsequent tool reads fetch fresh disk content.
        if (diskChanged && !hashChanged && old.hash !== null && cur.hash !== null && old.hash === cur.hash) {
            if (modInfo.source === 'saved in editor') {
                // No-op save in editor (identical bytes).
                continue;
            }
            if (window.registry?.files && fp in window.registry.files) {
                delete window.registry.files[fp];
            }
            cur.text = null;
            cur.hash = null;
            modified.push({
                path: fp,
                source: modInfo.source,
                delta: null,
                hunks: null,
                lineEndingsOnly: false,
                oldSize: old.size,
                newSize: cur.size,
                isBinary: cur.isBinary
            });
            continue;
        }

        const afterText = cur.text ?? modInfo.opContent;
        if (old.text !== null && afterText !== null && old.text === afterText) {
            continue;
        }

        const analysis = _analyzeTextChange(old.text, afterText);
        modified.push({
            path: fp,
            source: modInfo.source,
            delta: analysis ? analysis.delta : null,
            hunks: analysis ? analysis.hunks : null,
            lineEndingsOnly: !!(analysis && analysis.lineEndingsOnly),
            oldSize: old.size,
            newSize: cur.size,
            isBinary: cur.isBinary
        });
    }

    _detectRenames(added, deleted, renamed, { allowSizeFallback: false });
    if (!opts.skipFuzzyRenames) {
        _detectEditedRenames(added, deleted, renamed, prev.files, next.files);
    }
    if (!opts.skipSizeRenameFallback) {
        _detectRenames(added, deleted, renamed, { allowSizeFallback: true });
    }

    const byPath = (a, b) => a.path.localeCompare(b.path);
    modified.sort(byPath);
    unsaved.sort(byPath);
    renamed.sort((a, b) => a.from.localeCompare(b.from));
    added.sort(byPath);
    deleted.sort(byPath);

    const total = modified.length + unsaved.length + renamed.length + added.length + deleted.length;
    return { modified, unsaved, renamed, added, deleted, total };
}

function _formatModifiedFallback(item) {
    const parts = [item.source];
    if (item.isBinary) parts.push('binary');
    const hasOld = typeof item.oldSize === 'number';
    const hasNew = typeof item.newSize === 'number';
    if (hasOld && hasNew) {
        if (item.oldSize !== item.newSize) {
            parts.push(`${_formatByteInt(item.oldSize)} → ${_formatByteInt(item.newSize)} B`);
        } else {
            parts.push(`${_formatByteInt(item.newSize)} B`);
        }
    } else if (hasNew) {
        parts.push(`${_formatByteInt(item.newSize)} B`);
    }
    return `(${parts.join(', ')})`;
}

function formatWorkspaceChangeNotice(diff, max) {
    if (!diff || !diff.total) return '';

    const limit = Number.isFinite(Number(max)) && Number(max) > 0
        ? Math.floor(Number(max))
        : _getChangeNotifyMax();

    const ordered = [
        ...diff.modified.map(item => ({ kind: 'modified', ...item })),
        ...diff.unsaved.map(item => ({ kind: 'unsaved', ...item })),
        ...(diff.renamed || []).map(item => ({ kind: 'renamed', ...item })),
        ...diff.added.map(item => ({ kind: 'added', ...item })),
        ...diff.deleted.map(item => ({ kind: 'deleted', ...item }))
    ];

    if (ordered.length === 0) return '';

    const shown = ordered.slice(0, limit);
    const remaining = ordered.length - shown.length;
    const padWidth = Math.min(
        48,
        shown.reduce((m, item) => (item.kind === 'renamed' ? m : Math.max(m, item.path.length)), 0)
    );

    const lines = ['[Workspace changes since your last turn — not made by you:'];
    let snippetBytesUsed = 0;

    for (const item of shown) {
        const kindCol = item.kind.padEnd(8, ' ');
        const rangeStr = item.hunks && !item.hunks.approximate ? _formatLineRanges(item.hunks.ranges) : '';

        if (item.kind === 'renamed') {
            const renameLabel = `${item.from} → ${item.to}`;
            let detail = '';
            if (item.delta) {
                const counts = `+${item.delta.added} / −${item.delta.removed} lines`;
                detail = rangeStr ? `(${counts}, ${rangeStr})` : `(${counts})`;
            } else if (item.lineEndingsOnly) {
                detail = '(line endings changed)';
            }
            lines.push(detail ? `  ${kindCol}  ${renameLabel}  ${detail}` : `  ${kindCol}  ${renameLabel}`);
        } else {
            let detail = '';

            if (item.kind === 'modified') {
                if (item.delta) {
                    const counts = `+${item.delta.added} / −${item.delta.removed} lines`;
                    detail = rangeStr
                        ? `(${counts}, ${rangeStr})  ${item.source}`
                        : `(${counts})  ${item.source}`;
                } else if (item.lineEndingsOnly) {
                    detail = `(line endings changed)  ${item.source}`;
                } else {
                    detail = _formatModifiedFallback(item);
                }
            } else if (item.kind === 'unsaved') {
                if (item.delta) {
                    const counts = `+${item.delta.added} / −${item.delta.removed} lines`;
                    detail = rangeStr
                        ? `(${counts}, ${rangeStr})  open in editor with unsaved edits — tools see the unsaved version`
                        : `(${counts})  open in editor with unsaved edits — tools see the unsaved version`;
                } else if (item.lineEndingsOnly) {
                    detail = '(line endings changed)  open in editor with unsaved edits — tools see the unsaved version';
                } else {
                    detail = '(open in editor with unsaved edits — tools see the unsaved version)';
                }
            } else if (item.kind === 'added') {
                if (typeof item.lines === 'number') {
                    detail = `(${item.lines} ${item.lines === 1 ? 'line' : 'lines'})`;
                } else if (item.isBinary) {
                    detail = typeof item.size === 'number'
                        ? `(binary, ${_formatByteInt(item.size)} B)`
                        : '(binary)';
                } else if (typeof item.size === 'number') {
                    detail = `(${_formatByteInt(item.size)} B)`;
                }
            }

            if (detail) {
                lines.push(`  ${kindCol}  ${item.path.padEnd(padWidth, ' ')}  ${detail}`);
            } else {
                lines.push(`  ${kindCol}  ${item.path}`);
            }
        }

        if ((item.kind === 'modified' || item.kind === 'unsaved' || item.kind === 'renamed') &&
            item.hunks && !item.hunks.approximate &&
            Array.isArray(item.hunks.snippets) && item.hunks.snippets.length > 0 &&
            snippetBytesUsed < NOTICE_MAX_SNIPPET_BYTES) {
            const snippetLines = item.hunks.snippets.map(s => _formatLineSnippet(s.line, s.before, s.after));
            const blockBytes = _utf8ByteLength(snippetLines.join('\n')) + 1;
            if (snippetBytesUsed + blockBytes <= NOTICE_MAX_SNIPPET_BYTES) {
                for (const sl of snippetLines) lines.push(sl);
                snippetBytesUsed += blockBytes;
            }
        }
    }

    if (remaining > 0) {
        lines.push(`  … and ${remaining} more (use find to inspect)]`);
    } else {
        lines[lines.length - 1] += ']';
    }

    return lines.join('\n');
}

async function buildWorkspaceChangeNoticeForTurn(sessionId) {
    if (!_isChangeNotifyEnabled() || !_getRootHandle()) return '';
    if (typeof window.getGenState !== 'function') return '';

    const sid = sessionId || window.state?.activeSessionId;
    const runCtx = typeof window.sessionCtx === 'function' ? window.sessionCtx(sid) : null;
    // First turn of a session (or immediately after /clear): nothing to compare against.
    if (!runCtx || !Array.isArray(runCtx.messages) || runCtx.messages.length === 0) return '';

    const runGen = window.getGenState(sid);
    if (runGen._pendingSnapshotPromise) {
        try { await runGen._pendingSnapshotPromise; } catch (_) {}
    }

    const prev = runGen.lastWorkspaceSnapshot;
    if (!prev) return '';

    if (typeof window.ensureWorkspaceFresh === 'function') {
        await window.ensureWorkspaceFresh();
    }
    const next = await takeWorkspaceSnapshot();
    const diff = diffWorkspaceSnapshot(prev, next, sid, {
        skipSizeRenameFallback: true,
        skipFuzzyRenames: true
    });
    if (!diff.total) return '';

    // Re-read externally modified files (whose prior text is cached), rename candidates,
    // and newly added text files within a shared 10-file cap and 3-second batch deadline.
    if (typeof window.readFileContent === 'function') {
        const modToRefetch = diff.modified
            .filter(m => {
                if (m.delta || m.lineEndingsOnly) return false;
                if (typeof prev.files[m.path]?.text !== 'string') return false;
                const nextEntry = next.files[m.path];
                if (!nextEntry || nextEntry.isBinary) return false;
                if (typeof nextEntry.size === 'number' && nextEntry.size > SNAPSHOT_MAX_TEXT_BYTES) return false;
                return true;
            })
            .slice(0, NOTICE_MAX_REFETCH_FILES);

        const remainingBudget = NOTICE_MAX_REFETCH_FILES - modToRefetch.length;
        const addToRead = [];
        const pickedAdd = new Set();

        const canReadAdded = (a) => {
            if (pickedAdd.has(a) || a.isBinary) return false;
            if (typeof next.files[a.path]?.text === 'string') return false;
            if (typeof a.size === 'number' && (a.size <= 0 || a.size > SNAPSHOT_MAX_TEXT_BYTES)) return false;
            return true;
        };

        if (remainingBudget > 0 && diff.added.length > 0) {
            if (diff.deleted.length > 0) {
                const hashedDelSizes = new Set();
                const delWithText = [];
                const delByDir = new Map();
                const addByDir = new Map();

                for (const d of diff.deleted) {
                    if (d.hash !== null && d.hash !== undefined && typeof d.size === 'number' && d.size > 0) {
                        hashedDelSizes.add(d.size);
                    }
                    const oldText = prev.files[d.path]?.text;
                    if (typeof oldText === 'string' && oldText.length > 0 && oldText.length <= SNAPSHOT_MAX_TEXT_BYTES) {
                        delWithText.push({ d, oldText });
                    }
                    const dir = _pathDirname(d.path);
                    const list = delByDir.get(dir) || [];
                    list.push(d);
                    delByDir.set(dir, list);
                }
                for (const a of diff.added) {
                    const dir = _pathDirname(a.path);
                    const list = addByDir.get(dir) || [];
                    list.push(a);
                    addByDir.set(dir, list);
                }

                // Priority 1: exact-size match against a hashed deleted file (unmodified rename check).
                if (hashedDelSizes.size > 0) {
                    for (const a of diff.added) {
                        if (addToRead.length >= remainingBudget) break;
                        if (a.hash !== null && a.hash !== undefined) continue;
                        if (!canReadAdded(a)) continue;
                        if (typeof a.size !== 'number' || !hashedDelSizes.has(a.size)) continue;
                        addToRead.push(a);
                        pickedAdd.add(a);
                    }
                }

                // Priority 2: rename + edit candidates (standard fuzzy match or sole-pair directory fallback).
                if (addToRead.length < remainingBudget && delWithText.length > 0) {
                    for (const a of diff.added) {
                        if (addToRead.length >= remainingBudget) break;
                        if (!canReadAdded(a)) continue;

                        const hasFuzzyCand = delWithText.some(({ d, oldText }) =>
                            _isFuzzyRenameCandidate(d.path, d.size, oldText, a.path, a.size)
                        );
                        let hasDirFallbackCand = false;
                        if (!hasFuzzyCand) {
                            const dir = _pathDirname(a.path);
                            const dirDels = delByDir.get(dir);
                            const dirAdds = addByDir.get(dir);
                            if (dirDels && dirDels.length === 1 && dirAdds && dirAdds.length === 1) {
                                const soloDel = dirDels[0];
                                const soloOldText = prev.files[soloDel.path]?.text;
                                if (typeof soloOldText === 'string' &&
                                    soloOldText.length > 0 &&
                                    soloOldText.length <= SNAPSHOT_MAX_TEXT_BYTES &&
                                    _pathExtname(soloDel.path) === _pathExtname(a.path)) {
                                    hasDirFallbackCand = true;
                                }
                            }
                        }

                        if (!hasFuzzyCand && !hasDirFallbackCand) continue;
                        addToRead.push(a);
                        pickedAdd.add(a);
                    }
                }
            }

            // Priority 3: remaining budget — read newly added text files so the notice shows line counts
            // and registry.files is warmed for tool reads and next-turn diffs.
            if (addToRead.length < remainingBudget) {
                for (const a of diff.added) {
                    if (addToRead.length >= remainingBudget) break;
                    if (typeof a.lines === 'number') continue;
                    if (!canReadAdded(a)) continue;
                    addToRead.push(a);
                    pickedAdd.add(a);
                }
            }
        }

        if (modToRefetch.length > 0 || addToRead.length > 0) {
            let timedOut = false;
            let timerId = null;
            const deadline = new Promise(resolve => {
                timerId = setTimeout(() => { timedOut = true; resolve('timeout'); }, NOTICE_REFETCH_TIMEOUT_MS);
            });

            const checkBinContent = typeof window.isBinaryContent === 'function' ? window.isBinaryContent : null;
            const modTasks = modToRefetch.map(m => async () => {
                try {
                    const after = await window.readFileContent(m.path, { force: true, throwOnError: true });
                    if (timedOut || typeof after !== 'string') return;
                    const metaNow = window.registry?.meta?.[m.path];
                    const nowBinary = !!(metaNow?.isBinary || (checkBinContent && checkBinContent(after)));
                    const nextEntry = next.files[m.path];
                    if (nowBinary) {
                        m.isBinary = true;
                        if (nextEntry) {
                            nextEntry.isBinary = true;
                            nextEntry.text = null;
                            nextEntry.hash = null;
                            nextEntry.lines = null;
                        }
                        return;
                    }
                    if (nextEntry) {
                        nextEntry.text = after.length <= SNAPSHOT_MAX_TEXT_BYTES ? after : null;
                        nextEntry.hash = _fastHashString(after);
                        nextEntry.lines = _countLines(after);
                        if (typeof metaNow?.size === 'number') {
                            nextEntry.size = metaNow.size;
                            m.newSize = metaNow.size;
                        }
                    }
                    const oldText = prev.files[m.path].text;
                    if (after === oldText) {
                        // Touch-only change (mtime bumped, identical content): omit from notice
                        // and sync prev snapshot metadata so it isn't re-fetched on an aborted turn.
                        m._unchanged = true;
                        if (prev.files[m.path] && nextEntry) {
                            prev.files[m.path].mtime = nextEntry.mtime;
                            prev.files[m.path].size = nextEntry.size;
                        }
                        return;
                    }
                    const analysis = _analyzeTextChange(oldText, after);
                    if (analysis) {
                        m.delta = analysis.delta;
                        m.hunks = analysis.hunks;
                        m.lineEndingsOnly = analysis.lineEndingsOnly;
                    }
                } catch (_) {
                    // Leave delta null so the notice falls back to byte sizes.
                }
            });

            const addTasks = addToRead.map(a => async () => {
                try {
                    const content = await window.readFileContent(a.path, { force: true, throwOnError: true });
                    if (timedOut || typeof content !== 'string') return;
                    const metaNow = window.registry?.meta?.[a.path];
                    const nowBinary = !!(metaNow?.isBinary || (checkBinContent && checkBinContent(content)));
                    const nextEntry = next.files[a.path];
                    if (nowBinary) {
                        a.isBinary = true;
                        if (nextEntry) nextEntry.isBinary = true;
                        return;
                    }
                    const h = _fastHashString(content);
                    const lines = _countLines(content);
                    a.hash = h;
                    a.lines = lines;
                    if (typeof metaNow?.size === 'number') a.size = metaNow.size;
                    if (nextEntry) {
                        nextEntry.hash = h;
                        nextEntry.lines = lines;
                        if (typeof metaNow?.size === 'number') nextEntry.size = metaNow.size;
                        if (content.length <= SNAPSHOT_MAX_TEXT_BYTES) {
                            nextEntry.text = content;
                        }
                    }
                } catch (_) {
                    // Fall back to size-only rename matching / added size display.
                }
            });

            try {
                await Promise.race([
                    Promise.all([...modTasks, ...addTasks].map(fn => fn())),
                    deadline
                ]);
            } finally {
                if (timerId !== null) clearTimeout(timerId);
            }

            diff.modified = diff.modified.filter(m => !m._unchanged);
        }
    }

    // Complete rename detection in order: exact hash, rename+edit similarity (standard + dir fallback), then size fallback.
    _detectRenames(diff.added, diff.deleted, diff.renamed, { allowSizeFallback: false });
    _detectEditedRenames(diff.added, diff.deleted, diff.renamed, prev.files, next.files);
    _detectRenames(diff.added, diff.deleted, diff.renamed, { allowSizeFallback: true });
    diff.renamed.sort((a, b) => a.from.localeCompare(b.from));
    diff.total = diff.modified.length + diff.unsaved.length + diff.renamed.length + diff.added.length + diff.deleted.length;
    if (!diff.total) return '';

    return formatWorkspaceChangeNotice(diff, _getChangeNotifyMax());
}

function captureWorkspaceSnapshotForSession(sessionId) {
    if (!_isChangeNotifyEnabled() || !_getRootHandle()) return Promise.resolve(null);
    if (typeof window.getGenState !== 'function') return Promise.resolve(null);

    const sid = sessionId || window.state?.activeSessionId;
    const runGen = window.getGenState(sid);
    const expectedWsKey = typeof window.currentWsName === 'function' ? window.currentWsName() : '';

    const p = (async () => {
        try {
            if (typeof window.ensureWorkspaceFresh === 'function') {
                await window.ensureWorkspaceFresh();
            }
            const snap = await takeWorkspaceSnapshot();
            const curWsKey = typeof window.currentWsName === 'function' ? window.currentWsName() : '';
            if (snap && (!expectedWsKey || curWsKey === expectedWsKey)) {
                runGen.lastWorkspaceSnapshot = snap;
            }
            return snap;
        } catch (e) {
            console.warn('Workspace snapshot capture failed:', e);
            return null;
        } finally {
            if (runGen._pendingSnapshotPromise === p) {
                runGen._pendingSnapshotPromise = null;
            }
        }
    })();

    runGen._pendingSnapshotPromise = p;
    return p;
}

// --- AST_EXPORTS_START ---
window.takeWorkspaceSnapshot = takeWorkspaceSnapshot;
window.diffWorkspaceSnapshot = diffWorkspaceSnapshot;
window.formatWorkspaceChangeNotice = formatWorkspaceChangeNotice;
window.buildWorkspaceChangeNoticeForTurn = buildWorkspaceChangeNoticeForTurn;
window.captureWorkspaceSnapshotForSession = captureWorkspaceSnapshotForSession;
// --- AST_EXPORTS_END ---