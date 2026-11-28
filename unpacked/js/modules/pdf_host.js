const PDFJS_VERSION = '6.5.438';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_DOCS = 3;
const MAX_OUTLINE_ITEMS = 80;
const MAX_RENDER_SIDE = 1568;
const JPEG_QUALITY = 0.85;

let _pdfjsPromise = null;
let _workerBlobUrl = null;
let _lastRootHandle = null;

// cacheKey -> { key, doc, size, lastUsed, refs, pendingDestroy }
const _docCache = new Map();
// cacheKey -> Promise<entry>
const _inFlightLoads = new Map();

async function loadPdfJs() {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = (async () => {
        const moduleUrl = `${PDFJS_BASE}/build/pdf.min.mjs`;
        const pdfjsLib = await import(moduleUrl);
        if (!_workerBlobUrl) {
            const workerCode = `import "${PDFJS_BASE}/build/pdf.worker.min.mjs";`;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            _workerBlobUrl = URL.createObjectURL(blob);
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = _workerBlobUrl;
        return pdfjsLib;
    })().catch((err) => {
        _pdfjsPromise = null;
        throw err;
    });
    return _pdfjsPromise;
}

function normalizeFp(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

function checkPdfPathAccess(fp) {
    if (!fp) return 'ERROR: filepath is required.';
    if (fp.split('/').some(seg => seg === '.' || seg === '..')) {
        return 'ERROR: Path cannot contain "." or ".." segments.';
    }
    if (window.isSecurityProtectedPath?.(fp)) {
        return `ERROR: ${fp} is a protected path and cannot be read by a tool call.`;
    }
    if (window.isSensitiveUserFile?.(fp)) {
        return `ERROR: ${fp} is a private user settings file and cannot be read by a tool call.`;
    }
    if (window.shouldHideFromTools?.(fp)) {
        return `ERROR: ${fp} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.`;
    }
    if (window.isAgentPath?.(fp) && !window.isAttachmentPath?.(fp) && !window.isSkillPath?.(fp)) {
        return `ERROR: ${fp} is inside .agent and cannot be read by a tool call.`;
    }
    const meta = window.registry?.meta?.[fp];
    if (meta && meta.kind === 'directory') {
        return `ERROR: ${fp} is a directory, not a PDF file.`;
    }
    return null;
}

function hashPasswordKey(pw) {
    if (!pw) return 'nopw';
    const s = String(pw);
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5 ^ 0x9e3779b9;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193);
        h2 ^= (c + i);
        h2 = Math.imul(h2, 0x01000193);
    }
    return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

function dataUrlToBytes(dataUrl) {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const header = dataUrl.slice(0, commaIdx);
    const body = dataUrl.slice(commaIdx + 1);
    if (/;base64/i.test(header)) {
        const bin = atob(body);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
}

function hasPdfHeader(u8) {
    if (!u8 || u8.length < 5) return false;
    const limit = Math.min(u8.length, 1024);
    for (let i = 0; i <= limit - 5; i++) {
        if (
            u8[i] === 0x25 &&
            u8[i + 1] === 0x50 &&
            u8[i + 2] === 0x44 &&
            u8[i + 3] === 0x46 &&
            u8[i + 4] === 0x2D
        ) {
            return true;
        }
    }
    return false;
}

function destroyEntryIfIdle(entry) {
    if (!entry) return;
    if (entry.refs <= 0 && entry.doc) {
        const d = entry.doc;
        entry.doc = null;
        try { Promise.resolve(d.destroy()).catch(() => {}); } catch (_) {}
    } else {
        entry.pendingDestroy = true;
    }
}

function clearPdfCache() {
    for (const entry of _docCache.values()) {
        destroyEntryIfIdle(entry);
    }
    _docCache.clear();
}

function ensureWorkspaceCacheCurrent() {
    const curRoot = window.rootHandle || null;
    if (curRoot !== _lastRootHandle) {
        _lastRootHandle = curRoot;
        clearPdfCache();
    }
}

function evictLruIfNeeded() {
    while (_docCache.size > MAX_CACHED_DOCS) {
        let candidate = null;
        for (const entry of _docCache.values()) {
            if (entry.refs > 0) continue;
            if (!candidate || entry.lastUsed < candidate.lastUsed) {
                candidate = entry;
            }
        }
        if (!candidate) {
            for (const entry of _docCache.values()) {
                if (!candidate || entry.lastUsed < candidate.lastUsed) {
                    candidate = entry;
                }
            }
        }
        if (!candidate) break;
        _docCache.delete(candidate.key);
        destroyEntryIfIdle(candidate);
    }
}

function formatPdfError(fp, err) {
    if (!err) return `ERROR: Failed to read ${fp}.`;
    const name = err.name || '';
    if (name === 'PasswordException') {
        if (err.code === 2) {
            return `ERROR: Incorrect password for ${fp}.`;
        }
        return `ERROR: ${fp} is password-protected. Pass the password parameter to open it.`;
    }
    if (name === 'InvalidPDFException') {
        return `ERROR: ${fp} is not a valid or supported PDF file.`;
    }
    if (name === 'AbortError') {
        return 'ERROR: PDF operation was cancelled.';
    }
    const msg = err.message || String(err);
    return msg.startsWith('ERROR:') ? msg : `ERROR: ${msg}`;
}

async function resolvePdfSource(fp, password) {
    const meta = window.registry?.meta?.[fp] || null;
    const cachedVal = window.registry?.files?.[fp];
    const wsKey = (window.rootHandle && typeof window.wsStorageName === 'function')
        ? window.wsStorageName(window.rootHandle)
        : 'mem';
    const pwKey = hashPasswordKey(password);

    // 1. In-memory Blob / TypedArray / ArrayBuffer / data: URL (attachments, virtual in-memory files)
    if (typeof Blob !== 'undefined' && cachedVal instanceof Blob) {
        if (cachedVal.size > MAX_PDF_BYTES) {
            return { error: `ERROR: ${fp} exceeds the 64 MB PDF size limit (${Math.round(cachedVal.size / (1024 * 1024))} MB).` };
        }
        const key = `${wsKey}|${fp}|blob:${cachedVal.size}:${cachedVal.lastModified || meta?.mtime || 0}|${pwKey}`;
        return {
            key,
            size: cachedVal.size,
            readBytes: async () => new Uint8Array(await cachedVal.arrayBuffer())
        };
    }
    if (cachedVal instanceof ArrayBuffer || ArrayBuffer.isView(cachedVal)) {
        const u8 = cachedVal instanceof ArrayBuffer
            ? new Uint8Array(cachedVal)
            : new Uint8Array(cachedVal.buffer, cachedVal.byteOffset, cachedVal.byteLength);
        if (u8.byteLength > MAX_PDF_BYTES) {
            return { error: `ERROR: ${fp} exceeds the 64 MB PDF size limit.` };
        }
        const key = `${wsKey}|${fp}|buf:${u8.byteLength}:${meta?.mtime || 0}|${pwKey}`;
        return {
            key,
            size: u8.byteLength,
            readBytes: async () => u8
        };
    }
    if (typeof cachedVal === 'string' && cachedVal.startsWith('data:')) {
        const approxSize = Math.floor(cachedVal.length * 0.75);
        if (approxSize > MAX_PDF_BYTES) {
            return { error: `ERROR: ${fp} exceeds the 64 MB PDF size limit.` };
        }
        const key = `${wsKey}|${fp}|data:${cachedVal.length}:${cachedVal.slice(0, 48)}:${cachedVal.slice(-16)}|${pwKey}`;
        return {
            key,
            size: approxSize,
            readBytes: async () => dataUrlToBytes(cachedVal)
        };
    }

    // 2. Workspace handle (WebDAV, Local FS, VFS)
    if (!window.rootHandle) {
        if (typeof cachedVal === 'string') {
            return { error: `ERROR: ${fp} does not appear to be a binary PDF file.` };
        }
        return { error: `ERROR: ${fp} not found` };
    }

    // On WebDAV, handle.getFile() executes a full HTTP GET. Derive the cache key from
    // registry.meta first so repeated page reads reuse the cached PDFDocumentProxy.
    if (window.rootHandle.isWebDAV) {
        if (!meta || meta.kind !== 'file') {
            const exists = typeof window.fileExistsOnDisk === 'function' ? await window.fileExistsOnDisk(fp) : false;
            if (!exists) return { error: `ERROR: ${fp} not found` };
        }
        const metaSize = typeof meta?.size === 'number' ? meta.size : null;
        if (metaSize !== null && metaSize > MAX_PDF_BYTES) {
            return { error: `ERROR: ${fp} exceeds the 64 MB PDF size limit (${Math.round(metaSize / (1024 * 1024))} MB).` };
        }
        const key = `${wsKey}|${fp}|wd:${metaSize ?? 'u'}:${meta?.mtime ?? 'u'}|${pwKey}`;
        return {
            key,
            size: metaSize,
            readBytes: async () => {
                const handle = meta?.handle || await window.getHandleByPath(fp);
                if (!handle || typeof handle.getFile !== 'function') throw new Error(`ERROR: ${fp} not found`);
                const file = await handle.getFile();
                if (file.size > MAX_PDF_BYTES) {
                    throw new Error(`ERROR: ${fp} exceeds the 64 MB PDF size limit (${Math.round(file.size / (1024 * 1024))} MB).`);
                }
                return new Uint8Array(await file.arrayBuffer());
            }
        };
    }

    // Local FS / VFS: handle.getFile() is local/cheap; check size + lastModified before reading bytes.
    let handle = meta?.handle || null;
    if (!handle) {
        try { handle = await window.getHandleByPath(fp); } catch (_) { handle = null; }
    }
    if (!handle || typeof handle.getFile !== 'function') {
        return { error: `ERROR: ${fp} not found` };
    }
    let file;
    try {
        file = await handle.getFile();
    } catch (_) {
        return { error: `ERROR: ${fp} not found` };
    }
    if (file.size > MAX_PDF_BYTES) {
        return { error: `ERROR: ${fp} exceeds the 64 MB PDF size limit (${Math.round(file.size / (1024 * 1024))} MB).` };
    }
    const key = `${wsKey}|${fp}|fs:${file.size}:${file.lastModified || 0}|${pwKey}`;
    return {
        key,
        size: file.size,
        readBytes: async () => new Uint8Array(await file.arrayBuffer())
    };
}

async function acquirePdfDoc(fp, password, signal) {
    ensureWorkspaceCacheCurrent();
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

    const src = await resolvePdfSource(fp, password);
    if (src.error) throw new Error(src.error);

    const existing = _docCache.get(src.key);
    if (existing && existing.doc) {
        existing.lastUsed = Date.now();
        existing.refs++;
        return existing;
    }

    let loadPromise = _inFlightLoads.get(src.key);
    if (!loadPromise) {
        loadPromise = (async () => {
            const pdfjsLib = await loadPdfJs();
            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

            const rawBytes = await src.readBytes();
            if (!rawBytes || !hasPdfHeader(rawBytes)) {
                throw new Error(`ERROR: ${fp} is not a valid PDF file (missing %PDF- header).`);
            }
            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

            // Pass a copy because pdf.js transfers/detaches the underlying ArrayBuffer to its worker.
            const dataCopy = rawBytes.slice();
            const docOpts = {
                data: dataCopy,
                cMapUrl: `${PDFJS_BASE}/cmaps/`,
                cMapPacked: true,
                standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
                wasmUrl: `${PDFJS_BASE}/wasm/`
            };
            if (typeof password === 'string' && password.length > 0) {
                docOpts.password = password;
            }

            const loadingTask = pdfjsLib.getDocument(docOpts);
            const doc = await loadingTask.promise;
            const entry = {
                key: src.key,
                doc,
                size: rawBytes.byteLength,
                lastUsed: Date.now(),
                refs: 0,
                pendingDestroy: false
            };
            _docCache.set(src.key, entry);
            evictLruIfNeeded();
            return entry;
        })().finally(() => {
            _inFlightLoads.delete(src.key);
        });
        _inFlightLoads.set(src.key, loadPromise);
    }

    const entry = await loadPromise;
    if (!entry.doc) {
        throw new Error(`ERROR: PDF cache entry was closed while loading ${fp}; retry the call.`);
    }
    entry.lastUsed = Date.now();
    entry.refs++;
    return entry;
}

async function withPdfDoc(rawFp, password, signal, fn) {
    const fp = normalizeFp(rawFp);
    const accessErr = checkPdfPathAccess(fp);
    if (accessErr) return { error: accessErr };

    let entry = null;
    try {
        entry = await acquirePdfDoc(fp, password, signal);
        return await fn(entry, fp);
    } catch (err) {
        return { error: formatPdfError(fp, err) };
    } finally {
        if (entry) {
            entry.refs = Math.max(0, entry.refs - 1);
            if (entry.pendingDestroy && entry.refs === 0) {
                destroyEntryIfIdle(entry);
            }
        }
    }
}

async function resolveDestPage(doc, dest) {
    try {
        let resolved = dest;
        if (typeof resolved === 'string') {
            resolved = await doc.getDestination(resolved);
        }
        if (!Array.isArray(resolved) || resolved.length === 0) return null;
        const ref = resolved[0];
        if (typeof ref === 'number' && Number.isInteger(ref)) {
            return ref + 1;
        }
        if (ref && typeof ref === 'object') {
            const idx = await doc.getPageIndex(ref);
            return Number.isInteger(idx) ? idx + 1 : null;
        }
    } catch (_) {}
    return null;
}

async function extractOutline(doc) {
    let rawOutline = null;
    try {
        rawOutline = await doc.getOutline();
    } catch (_) {
        return { items: [], truncated: false };
    }
    if (!Array.isArray(rawOutline) || !rawOutline.length) {
        return { items: [], truncated: false };
    }

    const items = [];
    let truncated = false;

    async function walk(nodes, level) {
        for (const node of nodes) {
            if (!node) continue;
            if (items.length >= MAX_OUTLINE_ITEMS) {
                truncated = true;
                return;
            }
            const title = String(node.title || '').replace(/\s+/g, ' ').trim();
            const page = node.dest ? await resolveDestPage(doc, node.dest) : null;
            if (title) {
                items.push({ title, page, level });
            }
            if (Array.isArray(node.items) && node.items.length && items.length < MAX_OUTLINE_ITEMS) {
                await walk(node.items, level + 1);
            }
        }
    }

    await walk(rawOutline, 0);
    return { items, truncated };
}

function reconstructPageText(textContent) {
    const items = (textContent && Array.isArray(textContent.items)) ? textContent.items : [];
    const chunks = [];
    let prevY = null;
    let prevEndX = null;
    let prevFontH = 12;
    let lastChar = '';

    for (const item of items) {
        if (!item || typeof item.str !== 'string') continue;
        const str = item.str;
        const t = Array.isArray(item.transform) ? item.transform : null;
        const x = t ? Number(t[4]) : 0;
        const y = t ? Number(t[5]) : 0;
        const fontH = t
            ? (Math.hypot(Number(t[2]) || 0, Number(t[3]) || 0) || Math.hypot(Number(t[0]) || 0, Number(t[1]) || 0) || 12)
            : 12;

        if (str.length > 0 && prevY !== null && t) {
            const dy = Math.abs(y - prevY);
            const lineThreshold = Math.max(3, Math.min(prevFontH, fontH) * 0.45);
            if (dy > lineThreshold) {
                const paraThreshold = Math.max(prevFontH, fontH) * 1.85;
                if (dy > paraThreshold && lastChar !== '\n') {
                    chunks.push('\n\n');
                } else if (lastChar !== '\n') {
                    chunks.push('\n');
                }
                lastChar = '\n';
                prevEndX = null;
            } else if (prevEndX !== null) {
                const gap = x - prevEndX;
                const spaceThreshold = Math.max(1.5, fontH * 0.22);
                const needsSpace = gap > spaceThreshold &&
                    lastChar && !/\s/.test(lastChar) &&
                    !/^\s/.test(str);
                if (needsSpace) {
                    chunks.push(gap > fontH * 1.6 ? '  ' : ' ');
                    lastChar = ' ';
                }
            }
        }

        if (str.length > 0) {
            chunks.push(str);
            lastChar = str[str.length - 1];
            if (t) {
                prevY = y;
                prevFontH = fontH;
                prevEndX = x + (typeof item.width === 'number' ? item.width : 0);
            }
        }

        if (item.hasEOL) {
            if (lastChar !== '\n') {
                chunks.push('\n');
                lastChar = '\n';
            }
            prevY = null;
            prevEndX = null;
        }
    }

    return chunks
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function pdfInfo(fp, opts = {}, signal = null) {
    const password = typeof opts?.password === 'string' ? opts.password : undefined;
    return withPdfDoc(fp, password, signal, async (entry) => {
        const doc = entry.doc;
        let metaInfo = {};
        try {
            const m = await doc.getMetadata();
            if (m && m.info && typeof m.info === 'object') metaInfo = m.info;
        } catch (_) {}

        const outlineRes = await extractOutline(doc);
        const cleanStr = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

        return {
            numPages: doc.numPages,
            fileSize: entry.size,
            title: cleanStr(metaInfo.Title),
            author: cleanStr(metaInfo.Author),
            subject: cleanStr(metaInfo.Subject),
            creator: cleanStr(metaInfo.Creator),
            producer: cleanStr(metaInfo.Producer),
            encrypted: !!metaInfo.IsAcroFormPresent ? false : Boolean(password),
            outline: outlineRes.items,
            outlineTruncated: outlineRes.truncated
        };
    });
}

async function pdfText(fp, opts = {}, signal = null) {
    const password = typeof opts?.password === 'string' ? opts.password : undefined;
    const rawPages = opts?.pages;
    const maxChars = (typeof opts?.maxChars === 'number' && Number.isFinite(opts.maxChars) && opts.maxChars > 0)
        ? Math.floor(opts.maxChars)
        : null;

    return withPdfDoc(fp, password, signal, async (entry) => {
        const doc = entry.doc;
        const numPages = doc.numPages;

        let targetPages = [];
        if (rawPages === 'all' || rawPages === undefined || rawPages === null) {
            for (let p = 1; p <= numPages; p++) targetPages.push(p);
        } else if (Array.isArray(rawPages)) {
            const seen = new Set();
            for (const p of rawPages) {
                const n = Number(p);
                if (Number.isInteger(n) && n >= 1 && n <= numPages && !seen.has(n)) {
                    seen.add(n);
                    targetPages.push(n);
                }
            }
        } else {
            return { error: 'ERROR: pages must be an array of 1-based page numbers or "all".' };
        }

        const pages = [];
        let totalChars = 0;
        let truncatedByChars = false;

        for (const pageNum of targetPages) {
            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

            let page = null;
            try {
                page = await doc.getPage(pageNum);
                const tc = await page.getTextContent();
                let text = reconstructPageText(tc);
                const nonWsLen = text.replace(/\s+/g, '').length;
                const lowText = nonWsLen < 20;

                if (maxChars !== null && totalChars + text.length > maxChars) {
                    const remaining = Math.max(0, maxChars - totalChars);
                    if (pages.length > 0 && remaining < 200) {
                        truncatedByChars = true;
                        break;
                    }
                    text = text.slice(0, remaining);
                    truncatedByChars = true;
                }

                totalChars += text.length;
                pages.push({
                    page: pageNum,
                    text,
                    charCount: text.length,
                    lowText
                });

                if (truncatedByChars) break;
            } finally {
                if (page) {
                    try { page.cleanup(); } catch (_) {}
                }
            }
        }

        return {
            numPages,
            pages,
            totalChars,
            truncatedByChars
        };
    });
}

function clampVal(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

async function pdfRenderPage(fp, pageNum, opts = {}, signal = null) {
    const n = Number(pageNum);
    if (!Number.isInteger(n) || n < 1) {
        return { error: `ERROR: Invalid page number: ${pageNum}` };
    }
    const password = typeof opts?.password === 'string' ? opts.password : undefined;
    const maxMegapixels = (typeof opts?.maxMegapixels === 'number' && Number.isFinite(opts.maxMegapixels) && opts.maxMegapixels > 0)
        ? opts.maxMegapixels
        : null;
    const crop = (opts && opts.crop && typeof opts.crop === 'object') ? opts.crop : null;

    return withPdfDoc(fp, password, signal, async (entry) => {
        const doc = entry.doc;
        if (n > doc.numPages) {
            return { error: `ERROR: Page ${n} out of range (document has ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}).` };
        }
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

        let page = null;
        let canvas = null;
        try {
            page = await doc.getPage(n);
            const baseVp = page.getViewport({ scale: 1 });
            const baseW = Math.max(1, baseVp.width);
            const baseH = Math.max(1, baseVp.height);

            const hasCrop = !!(crop && ['x', 'y', 'width', 'height'].some(k => typeof crop[k] === 'number' && Number.isFinite(crop[k])));
            let cx = 0, cy = 0, cw = 1, ch = 1;
            if (hasCrop) {
                cx = clampVal(Number.isFinite(crop.x) ? crop.x : 0, 0, 0.999);
                cy = clampVal(Number.isFinite(crop.y) ? crop.y : 0, 0, 0.999);
                cw = clampVal(Number.isFinite(crop.width) ? crop.width : (1 - cx), 0.001, 1 - cx);
                ch = clampVal(Number.isFinite(crop.height) ? crop.height : (1 - cy), 0.001, 1 - cy);
            }

            const regionW = Math.max(1, baseW * cw);
            const regionH = Math.max(1, baseH * ch);

            // Compute dynamic scale to hit MAX_RENDER_SIDE on longest edge, bounded by maxMegapixels.
            let scale = MAX_RENDER_SIDE / Math.max(regionW, regionH);
            scale = clampVal(scale, 0.1, 4.0);

            if (maxMegapixels) {
                const maxPx = maxMegapixels * 1e6;
                const estArea = (regionW * scale) * (regionH * scale);
                if (estArea > maxPx) {
                    scale *= Math.sqrt(maxPx / estArea);
                }
            }

            const fullVp = page.getViewport({ scale });
            const fullW = Math.max(1, Math.round(fullVp.width));
            const fullH = Math.max(1, Math.round(fullVp.height));

            const sx = hasCrop ? Math.min(fullW - 1, Math.max(0, Math.round(cx * fullW))) : 0;
            const sy = hasCrop ? Math.min(fullH - 1, Math.max(0, Math.round(cy * fullH))) : 0;
            const outW = hasCrop ? Math.max(1, Math.min(fullW - sx, Math.round(cw * fullW))) : fullW;
            const outH = hasCrop ? Math.max(1, Math.min(fullH - sy, Math.round(ch * fullH))) : fullH;

            canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, outW, outH);

            const renderTask = page.render({
                canvas,
                canvasContext: ctx,
                viewport: fullVp,
                transform: hasCrop ? [1, 0, 0, 1, -sx, -sy] : null,
                background: 'rgb(255,255,255)'
            });

            if (signal) {
                const onAbort = () => {
                    try { renderTask.cancel(); } catch (_) {}
                };
                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                try {
                    await renderTask.promise;
                } finally {
                    signal.removeEventListener('abort', onAbort);
                }
            } else {
                await renderTask.promise;
            }

            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

            const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
            return {
                page: n,
                numPages: doc.numPages,
                dataUrl,
                width: outW,
                height: outH,
                sourceWidth: fullW,
                sourceHeight: fullH,
                crop: hasCrop ? { x: sx, y: sy, width: outW, height: outH } : null
            };
        } finally {
            if (page) {
                try { page.cleanup(); } catch (_) {}
            }
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
        }
    });
}

const pdfHost = {
    pdfInfo,
    pdfText,
    pdfRenderPage,
    clearCache: clearPdfCache
};

window.pdfHost = pdfHost;

export { pdfHost, pdfInfo, pdfText, pdfRenderPage, clearPdfCache };