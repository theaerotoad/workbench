// grep - tool definition.
const TOOL_META = {
    "name": "grep",
    "description": "Search for regex or text string across text files and PDFs with line numbers (PDF matches report file.pdf:pN:line, ready for view_pdf). Supports context lines, glob include filters, files-only summaries, and per-file match caps.",
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regex or plain text pattern to search for."
            },
            "path": {
                "type": "string",
                "description": "Optional workspace-relative folder or file to search (prefix from the workspace root, e.g. 'src/utils' or 'src/app.py')."
            },
            "include": {
                "type": "string",
                "description": "Optional glob filter for file paths (e.g. '*.py', 'src/**/*.ts', or comma-separated '*.js,*.ts')."
            },
            "case_sensitive": {
                "type": "boolean",
                "description": "Default false (case-insensitive). Set true for exact-case matching, e.g. to tell `Map` from `map`."
            },
            "literal": {
                "type": "boolean",
                "description": "Treat pattern as plain text, not regex (default false)."
            },
            "context": {
                "type": "integer",
                "description": "Number of context lines to show before and after each match (default 0)."
            },
            "files_only": {
                "type": "boolean",
                "description": "If true, list only matching files with their hit counts."
            },
            "max_per_file": {
                "type": "integer",
                "description": "Optional maximum number of matches to return per file."
            }
        },
        "required": [
            "pattern"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "always",
    "toolBox": 1,
    "settings": [
        {
            "key": "maxMatches",
            "label": "Max Matches",
            "type": "number",
            "default": 500,
            "min": 1,
            "max": 100000,
            "description": "Maximum matching lines returned (or matching files when files_only=true). Context lines do not count."
        },
        {
            "key": "previewLines",
            "label": "Preview Matches",
            "type": "number",
            "default": 30,
            "min": 0,
            "max": 500,
            "description": "How many matches are shown in the chat box (the model always receives the full result)."
        },
        {
            "key": "searchPdfs",
            "label": "Search PDF Files",
            "type": "boolean",
            "default": true,
            "description": "Extract and search text inside .pdf files (results include page numbers as file.pdf:pN:line)."
        }
    ]
};

// --- Pure helpers ------------------------------------------------------------

// Same normalization as find.normalizePathPrefix (tools cannot import from each other).
function normalizePathPrefix(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob, pathScoped) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += pathScoped ? '[^/]*' : '.*';
            }
        } else if (ch === '?') {
            re += pathScoped ? '[^/]' : '.';
        } else {
            re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    re += '$';
    return new RegExp(re, 'i');
}

function compileIncludeFilter(includeStr) {
    if (!includeStr || typeof includeStr !== 'string') return null;
    const parts = includeStr
        .split(',')
        .map(s => s.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, ''))
        .filter(Boolean);
    if (!parts.length) return null;
    const matchers = parts.map(part => {
        const hasSlash = part.includes('/');
        const re = globToRegex(part, hasSlash);
        return (fp) => {
            if (hasSlash) return re.test(fp);
            const base = fp.split('/').pop() || fp;
            return re.test(base);
        };
    });
    return (fp) => matchers.some(fn => fn(fp));
}

function buildContextHunks(totalLines, hitIndices, context) {
    if (!hitIndices.length) return [];
    const hunks = [];
    for (const idx of hitIndices) {
        const start = Math.max(0, idx - context);
        const end = Math.min(totalLines - 1, idx + context);
        const prev = hunks[hunks.length - 1];
        if (prev && start <= prev.end + 1) {
            prev.end = Math.max(prev.end, end);
            prev.hits.add(idx);
        } else {
            hunks.push({ start, end, hits: new Set([idx]) });
        }
    }
    return hunks;
}

const GREP_BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|bmp|webp|tif|tiff|heic|avif|psd|zip|tar|gz|xz|bz2|zst|lzma|7z|rar|exe|dll|so|dylib|mp4|mkv|webm|mp3|m4a|aac|wav|flac|ogg|avi|mov|pyc|pyo|ttf|otf|woff|woff2|eot|sqlite|sqlite3|gguf|ggml|ppu|o|a|lib|class|jar|wasm|node|swf|iso|apk|dmg|pkl|npy|npz|parquet|onnx|safetensors|docx|xlsx|pptx|odt|ods|odp|mdb|accdb|dds|tga|pdb)$/i;
const GREP_PDF_EXT = /\.pdf$/i;

function formatPageRanges(pageSet, maxRanges = 12) {
    const nums = Array.from(pageSet).sort((a, b) => a - b);
    if (!nums.length) return '';
    const ranges = [];
    let start = nums[0];
    let prev = nums[0];
    for (let i = 1; i < nums.length; i++) {
        const cur = nums[i];
        if (cur === prev) continue;
        if (cur === prev + 1) {
            prev = cur;
        } else {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
            start = prev = cur;
        }
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (ranges.length > maxRanges) {
        return ranges.slice(0, maxRanges).join(', ') + ', …';
    }
    return ranges.join(', ');
}

function isErrorResult(txt) {
    return typeof txt !== 'string' || (txt.length < 500 && /^ERROR: [^\n]*$/.test(txt));
}

// --- UI helpers (display only, never sent to the model) ----------------------

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pathHtml(fp) {
    const parts = String(fp || '').split('/');
    const name = parts.pop() || fp;
    const dir = parts.length ? parts.join('/') + '/' : '';
    return `<span class="tool-ui-path-dir">${esc(dir)}</span><span class="tool-ui-path-name">${esc(name)}</span>`;
}

function badge(text, colorVar) {
    return `<span class="tool-ui-badge" style="color:${colorVar}; background:color-mix(in srgb, ${colorVar} 15%, transparent);">${esc(text)}</span>`;
}

// Escapes text and wraps the first regex hit in a highlight span.
function highlight(text, re) {
    const t = text.length > 200 ? text.slice(0, 200) + '…' : text;
    const m = re.exec(t);
    if (!m || m[0] === '') return esc(t);
    const a = m.index, b = m.index + m[0].length;
    return esc(t.slice(0, a))
        + `<span class="tool-ui-highlight">${esc(t.slice(a, b))}</span>`
        + esc(t.slice(b));
}

// --- Handler -----------------------------------------------------------------

async function handler(args, api) {
    const flags = args.case_sensitive ? '' : 'i';
    const pattern = String(args.pattern == null ? '' : args.pattern);
    let isLiteral = args.literal === true;
    let regexFallbackNote = '';
    let re;
    if (isLiteral) {
        re = new RegExp(escapeRegex(pattern), flags);
    } else {
        try {
            re = new RegExp(pattern, flags);
        } catch (e) {
            re = new RegExp(escapeRegex(pattern), flags);
            isLiteral = true;
            regexFallbackNote = `[note: pattern is not a valid regex (${e.message}); searched as literal text. Pass literal=true to do this on purpose.]`;
        }
    }
    const modeLabel = `${args.case_sensitive ? 'case-sensitive' : 'case-insensitive'} ${isLiteral ? 'literal' : 'regex'}`;
    const noMatches = `(no matches; ${modeLabel})`;

    const maxLines = Math.max(1, Number(await api.getSetting('maxMatches')) || 500);
    const contextLines = Number.isInteger(args.context) && args.context > 0 ? Math.min(args.context, 20) : 0;
    const filesOnly = args.files_only === true;
    const maxPerFile = Number.isInteger(args.max_per_file) && args.max_per_file > 0 ? args.max_per_file : Infinity;
    const rawSearchPdfs = await api.getSetting('searchPdfs');
    const searchPdfs = (rawSearchPdfs === undefined ? true : !!rawSearchPdfs) && typeof api.pdfText === 'function';
    const pathFilter = normalizePathPrefix(args.path);
    const includeFilter = compileIncludeFilter(args.include);

    // Filter by path prefix, include, and known-binary extensions BEFORE hitting api.isBinary/readFile.
    const allFiles = await api.listFiles();
    const underPrefix = (fp) => fp === pathFilter || fp.startsWith(pathFilter + '/');
    const textCandidates = [];
    const pdfCandidates = [];
    let skippedPdfsDisabled = 0;

    for (const fp of allFiles) {
        if (GREP_BINARY_EXT.test(fp)) continue;
        if (pathFilter && !underPrefix(fp)) continue;
        if (includeFilter && !includeFilter(fp)) continue;
        if (GREP_PDF_EXT.test(fp)) {
            if (searchPdfs) pdfCandidates.push(fp);
            else skippedPdfsDisabled++;
        } else {
            textCandidates.push(fp);
        }
    }
    const totalCandidates = textCandidates.length + pdfCandidates.length;

    // path is a prefix; if nothing is under it but the string appears elsewhere, say so.
    let pathHint = '';
    if (pathFilter && !allFiles.some(underPrefix)) {
        const substringHits = allFiles.filter(fp => fp.includes(pathFilter));
        if (substringHits.length > 0) {
            pathHint = `(no files under "${args.path}"; path is a folder/file prefix from the workspace root. "${args.path}" appears inside ${substringHits.length} other path(s), e.g. ${substringHits[0]})`;
        }
    }

    const scopeParts = [];
    if (pathFilter) scopeParts.push(pathFilter);
    if (args.include) scopeParts.push(args.include);
    const scope = scopeParts.length ? scopeParts.join(' · ') : 'all files';
    const header = `pattern "${args.pattern}" in ${scope}`;
    await api.setHeaderMsg(header);

    const matches = [];       // { fp, page?, n, text } (used when !filesOnly && contextLines === 0)
    const fileGroups = [];    // { fp, count, capped, pagesLabel?, hunks: [{ lines: [{ page?, n, text, isMatch }] }] }
    const fileCounts = new Map();
    const skippedPdfErrors = []; // { fp, reason }
    const scannedPdfsNoHits = [];
    let totalMatches = 0;
    let truncated = false;
    let searched = 0;
    let pdfsSearched = 0;

    // 1. Search text files in fast concurrent batches.
    const BATCH = 20;
    for (let start = 0; start < textCandidates.length && !truncated; start += BATCH) {
        const slice = textCandidates.slice(start, start + BATCH);
        const batchData = await Promise.all(slice.map(async (fp) => {
            if (await api.isBinary(fp)) return { fp, skip: true };
            const txt = await api.readFile(fp);
            if (isErrorResult(txt)) return { fp, skip: true };
            return { fp, skip: false, txt };
        }));

        for (const item of batchData) {
            if (item.skip) continue;
            const { fp, txt } = item;
            searched++;
            const lines = txt.split('\n');

            if (filesOnly) {
                let count = 0;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
                    if (re.test(line)) count++;
                }
                if (count > 0) {
                    if (fileGroups.length >= maxLines) {
                        truncated = true;
                        break;
                    }
                    fileGroups.push({ fp, count, capped: false, hunks: [] });
                    fileCounts.set(fp, count);
                    totalMatches += count;
                }
                continue;
            }

            const hitIndices = [];
            let capped = false;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
                if (re.test(line)) {
                    if (totalMatches >= maxLines) {
                        truncated = true;
                        break;
                    }
                    if (hitIndices.length >= maxPerFile) {
                        capped = true;
                        break;
                    }
                    hitIndices.push(i);
                    totalMatches++;
                    // Keep leading indentation so results can be copied into an edit search_block.
                    matches.push({ fp, n: i + 1, text: line.replace(/\s+$/, '') });
                }
            }

            if (hitIndices.length > 0) {
                fileCounts.set(fp, hitIndices.length);
                if (contextLines > 0) {
                    const hunks = buildContextHunks(lines.length, hitIndices, contextLines).map(h => {
                        const hunkLines = [];
                        for (let idx = h.start; idx <= h.end; idx++) {
                            const raw = lines[idx].endsWith('\r') ? lines[idx].slice(0, -1) : lines[idx];
                            hunkLines.push({ n: idx + 1, text: raw, isMatch: h.hits.has(idx) });
                        }
                        return { lines: hunkLines };
                    });
                    fileGroups.push({ fp, count: hitIndices.length, capped, hunks });
                } else {
                    fileGroups.push({ fp, count: hitIndices.length, capped, hunks: [] });
                }
            }

            if (truncated) break;
        }

        if (!truncated && start + BATCH < textCandidates.length) {
            await api.setHeaderMsg(`${header} (${searched}/${totalCandidates} files scanned)`);
        }
    }

    // 2. Search PDF files in small batches (2 at a time) to avoid thrashing PDF.js memory/LRU cache.
    const PDF_BATCH = 2;
    for (let start = 0; start < pdfCandidates.length && !truncated; start += PDF_BATCH) {
        const slice = pdfCandidates.slice(start, start + PDF_BATCH);
        if (pdfCandidates.length > 0) {
            const labelFp = slice[0].split('/').pop() || slice[0];
            await api.setHeaderMsg(`${header} (PDF ${start + 1}/${pdfCandidates.length}: ${labelFp})`);
        }

        const pdfBatchData = await Promise.all(slice.map(async (fp) => {
            try {
                const res = await api.pdfText(fp, { pages: 'all' });
                if (!res || res.error) {
                    return { fp, error: (res && res.error) || 'Failed to read PDF' };
                }
                return { fp, res };
            } catch (e) {
                return { fp, error: e.message || String(e) };
            }
        }));

        for (const item of pdfBatchData) {
            const { fp, res, error } = item;
            if (error) {
                skippedPdfErrors.push({ fp, reason: String(error).replace(/^ERROR:\s*/, '') });
                continue;
            }
            searched++;
            pdfsSearched++;
            const pdfPages = Array.isArray(res.pages) ? res.pages : [];
            const allLowText = pdfPages.length > 0 && pdfPages.every(p => p.lowText);

            if (filesOnly) {
                let count = 0;
                const matchedPages = new Set();
                for (const p of pdfPages) {
                    if (!p.text) continue;
                    const lines = p.text.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
                        if (re.test(line)) {
                            count++;
                            matchedPages.add(p.page);
                        }
                    }
                }
                if (count > 0) {
                    if (fileGroups.length >= maxLines) {
                        truncated = true;
                        break;
                    }
                    fileGroups.push({ fp, count, capped: false, pagesLabel: formatPageRanges(matchedPages), hunks: [] });
                    fileCounts.set(fp, count);
                    totalMatches += count;
                } else if (allLowText) {
                    scannedPdfsNoHits.push(fp);
                }
                continue;
            }

            let fileHitCount = 0;
            let capped = false;
            const fileHunks = [];

            for (const p of pdfPages) {
                if (!p.text) continue;
                const lines = p.text.split('\n');
                const pageHits = [];

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
                    if (re.test(line)) {
                        if (totalMatches >= maxLines) {
                            truncated = true;
                            break;
                        }
                        if (fileHitCount >= maxPerFile) {
                            capped = true;
                            break;
                        }
                        pageHits.push(i);
                        fileHitCount++;
                        totalMatches++;
                        matches.push({ fp, page: p.page, n: i + 1, text: line.replace(/\s+$/, '') });
                    }
                }

                if (contextLines > 0 && pageHits.length > 0) {
                    for (const h of buildContextHunks(lines.length, pageHits, contextLines)) {
                        const hunkLines = [];
                        for (let idx = h.start; idx <= h.end; idx++) {
                            const raw = lines[idx].endsWith('\r') ? lines[idx].slice(0, -1) : lines[idx];
                            hunkLines.push({ page: p.page, n: idx + 1, text: raw, isMatch: h.hits.has(idx) });
                        }
                        fileHunks.push({ lines: hunkLines });
                    }
                }

                if (truncated || capped) break;
            }

            if (fileHitCount > 0) {
                fileCounts.set(fp, fileHitCount);
                fileGroups.push({ fp, count: fileHitCount, capped, hunks: fileHunks });
            } else if (allLowText) {
                scannedPdfsNoHits.push(fp);
            }

            if (truncated) break;
        }
    }

    // --- Format output for model ----------------------------------------------

    let rawOutput;
    if (filesOnly) {
        rawOutput = fileGroups.length
            ? fileGroups.map(g => `${g.fp}  (${g.count} match${g.count === 1 ? '' : 'es'}${g.pagesLabel ? `; pages ${g.pagesLabel}` : ''})`).join('\n')
            : noMatches;
    } else if (contextLines > 0) {
        if (!fileGroups.length) {
            rawOutput = noMatches;
        } else {
            const sections = fileGroups.map(g => {
                const headerLine = g.capped ? `${g.fp}  (capped at ${maxPerFile} matches)` : g.fp;
                const hunkStrs = g.hunks.map(h =>
                    h.lines.map(l => `${l.page ? `p${l.page}:` : ''}${l.n}${l.isMatch ? ':' : '-'} ${l.text}`).join('\n')
                );
                return headerLine + '\n' + hunkStrs.join('\n--\n');
            });
            rawOutput = sections.join('\n\n');
        }
    } else {
        if (!matches.length) {
            rawOutput = noMatches;
        } else {
            const cappedFiles = fileGroups.filter(g => g.capped);
            rawOutput = matches.map(m => `${m.fp}:${m.page ? `p${m.page}:` : ''}${m.n}: ${m.text}`).join('\n');
            if (cappedFiles.length > 0) {
                rawOutput += `\n\n[capped at ${maxPerFile} matches/file in ${cappedFiles.length} file${cappedFiles.length === 1 ? '' : 's'}: ${cappedFiles.map(g => g.fp).slice(0, 10).join(', ')}${cappedFiles.length > 10 ? '…' : ''}]`;
            }
        }
    }

    if (pathHint) rawOutput = pathHint;

    // Notices go first: regex fallback, PDF notes, truncation, then results.
    const topNotices = [];
    if (regexFallbackNote) topNotices.push(regexFallbackNote);
    if (skippedPdfsDisabled > 0 && pathFilter && GREP_PDF_EXT.test(pathFilter)) {
        topNotices.push(`[note: PDF searching is disabled in grep settings (searchPdfs=false); enable it or use view_pdf(filepath="${pathFilter}").]`);
    }
    if (skippedPdfErrors.length > 0) {
        const shown = skippedPdfErrors.slice(0, 5).map(e => `${e.fp} (${e.reason})`).join('; ');
        const more = skippedPdfErrors.length > 5 ? `; +${skippedPdfErrors.length - 5} more` : '';
        topNotices.push(`[note: skipped ${skippedPdfErrors.length} unreadable PDF${skippedPdfErrors.length === 1 ? '' : 's'}: ${shown}${more}]`);
    }
    if (scannedPdfsNoHits.length > 0) {
        const shown = scannedPdfsNoHits.slice(0, 5).join(', ');
        const more = scannedPdfsNoHits.length > 5 ? `, +${scannedPdfsNoHits.length - 5} more` : '';
        topNotices.push(`[note: ${scannedPdfsNoHits.length} PDF${scannedPdfsNoHits.length === 1 ? '' : 's'} had little/no extractable text (likely scanned): ${shown}${more}; inspect visually with view_pdf(..., mode="image").]`);
    }
    if (truncated) {
        topNotices.push(filesOnly
            ? `[TRUNCATED: showing first ${maxLines} matching files; more exist. Narrow with path/include.]`
            : `[TRUNCATED: showing first ${maxLines} matching lines; more exist. Narrow with path/include, set max_per_file, or use files_only=true.]`);
    }
    const output = (topNotices.length ? topNotices.join('\n') + '\n\n' : '') + api.cleanupText(rawOutput);
    const summary = filesOnly
        ? `Grep: ${fileGroups.length} file(s) (${totalMatches} matches)${truncated ? ` (truncated)` : ''}`
        : `Grep: ${totalMatches} match(es) in ${fileCounts.size} file(s)${truncated ? ` (truncated at ${maxLines})` : ''}`;

    // --- Display ---------------------------------------------------------------

    let previewLimit = Number(await api.getSetting('previewLines'));
    if (!Number.isFinite(previewLimit) || previewLimit < 0) previewLimit = 30;

    let rowsHtml = '';
    if (filesOnly) {
        const shown = fileGroups.slice(0, previewLimit);
        const hidden = fileGroups.length - shown.length;
        rowsHtml = shown.map(g => `
            <div class="tool-ui-row">
                <div class="tool-ui-path">${pathHtml(g.fp)}</div>
                <span style="color:var(--dim); font-size:10px; flex-shrink:0; margin-left:8px;">${g.count} match${g.count === 1 ? '' : 'es'}${g.pagesLabel ? ` · p. ${esc(g.pagesLabel)}` : ''}</span>
            </div>`).join('');
        if (hidden > 0) {
            rowsHtml += `<div class="tool-ui-more">… ${hidden} more file${hidden === 1 ? '' : 's'} (full list was sent to the model)</div>`;
        }
        if (!fileGroups.length) {
            rowsHtml = `<div class="tool-ui-empty">(no matches)</div>`;
        }
    } else if (contextLines > 0) {
        let shownRows = 0;
        let totalRows = 0;
        for (const g of fileGroups) {
            for (const h of g.hunks) totalRows += h.lines.length;
        }
        for (const g of fileGroups) {
            if (shownRows >= previewLimit) break;
            rowsHtml += `
                <div class="tool-ui-row">
                    <div class="tool-ui-path">${pathHtml(g.fp)}</div>
                    <span style="color:var(--dim); font-size:10px; flex-shrink:0; margin-left:8px;">${g.count}${g.capped ? '+' : ''}</span>
                </div>`;
            for (let hi = 0; hi < g.hunks.length && shownRows < previewLimit; hi++) {
                if (hi > 0) {
                    rowsHtml += `<div class="tool-ui-line-row" style="opacity:0.45;"><div class="tool-ui-line-no">…</div><div class="tool-ui-line-content">--</div></div>`;
                }
                for (const l of g.hunks[hi].lines) {
                    if (shownRows >= previewLimit) break;
                    shownRows++;
                    const style = l.isMatch ? '' : ' style="opacity:0.55;"';
                    const content = l.isMatch ? highlight(l.text, re) : esc(l.text.length > 200 ? l.text.slice(0, 200) + '…' : l.text);
                    const locLabel = l.page ? `p${l.page}:${l.n}` : `${l.n}`;
                    const locTitle = l.page ? ` title="Page ${l.page}, line ${l.n}"` : '';
                    rowsHtml += `
                        <div class="tool-ui-line-row"${style}>
                            <div class="tool-ui-line-no"${locTitle}>${locLabel}</div>
                            <div class="tool-ui-line-content">${content}</div>
                        </div>`;
                }
            }
        }
        const hidden = totalRows - shownRows;
        if (hidden > 0) {
            rowsHtml += `<div class="tool-ui-more">… ${hidden} more line${hidden === 1 ? '' : 's'} (full result was sent to the model)</div>`;
        }
        if (!fileGroups.length) {
            rowsHtml = `<div class="tool-ui-empty">(no matches)</div>`;
        }
    } else {
        const shown = matches.slice(0, previewLimit);
        const hidden = matches.length - shown.length;
        let lastFile = null;
        shown.forEach(m => {
            if (m.fp !== lastFile) {
                lastFile = m.fp;
                rowsHtml += `
                    <div class="tool-ui-row">
                        <div class="tool-ui-path">${pathHtml(m.fp)}</div>
                        <span style="color:var(--dim); font-size:10px; flex-shrink:0; margin-left:8px;">${fileCounts.get(m.fp)}</span>
                    </div>`;
            }
            const locLabel = m.page ? `p${m.page}:${m.n}` : `${m.n}`;
            const locTitle = m.page ? ` title="Page ${m.page}, line ${m.n}"` : '';
            rowsHtml += `
                <div class="tool-ui-line-row">
                    <div class="tool-ui-line-no"${locTitle}>${locLabel}</div>
                    <div class="tool-ui-line-content">${highlight(m.text, re)}</div>
                </div>`;
        });
        if (hidden > 0) {
            rowsHtml += `<div class="tool-ui-more">… ${hidden} more match${hidden === 1 ? '' : 'es'} (full result was sent to the model)</div>`;
        }
        if (!matches.length) {
            rowsHtml = `<div class="tool-ui-empty">(no matches)</div>`;
        }
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--primary); flex-shrink:0;">search</span>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); font-weight:600;">${esc(args.pattern)}</div>
                    ${badge(scope, 'var(--primary)')}
                    ${args.case_sensitive ? badge('Aa', 'var(--dim)') : ''}
                    ${isLiteral ? badge('literal', 'var(--dim)') : ''}
                    ${contextLines > 0 ? badge(`-C ${contextLines}`, 'var(--dim)') : ''}
                    ${filesOnly ? badge('files only', 'var(--dim)') : ''}
                    ${truncated ? badge('truncated', 'var(--yellow)') : ''}
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:${totalMatches ? 'var(--green)' : 'var(--dim)'}; font-weight:600;">${totalMatches} match${totalMatches === 1 ? '' : 'es'}</span>
                    <span>${fileCounts.size} file${fileCounts.size === 1 ? '' : 's'}</span>
                </div>
            </div>
            <div class="tool-ui-box">${rowsHtml}</div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:10.5px; color:var(--dim); padding:0 2px;">
                <div style="display:flex; align-items:center; gap:4px;">
                    <span class="icon" style="font-size:12px; color:var(--green);">check_circle</span>
                    <span>Searched ${searched} file${searched === 1 ? '' : 's'}${pdfsSearched ? ` (incl. ${pdfsSearched} PDF${pdfsSearched === 1 ? '' : 's'})` : ''}</span>
                </div>
            </div>
        </div>`;

    await api.showUI(displayHtml);
    return { output, summary };
}