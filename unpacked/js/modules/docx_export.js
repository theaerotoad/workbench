// docx_export.js — Zero-dependency, fully offline Markdown -> Word (.docx) exporter.
//
// A .docx is just an OPC package: a ZIP of XML parts (plus optional media). We build
// that ZIP on top of the primitives that already exist in this app — window.buildZip()
// and window.crc32() — so no CDN script, no npm package, no network round-trip and no
// CSP exception is needed.
//
// Public surface (window):
//   buildDocxBlob(markdownText, { filepath })  -> Promise<Blob>
//   exportMarkdownToDocx(filepath)             -> Promise<boolean>
//
// Wiring:
//   * an "Export .docx" button on the document control bar (registerDocumentAction),
//   * an "Export as .docx" explorer context-menu item (see index.template.html,
//     fs_utils.js 'markdown' scope, and the click branch in ui_explorer.js).

// --- constants ---
// The download MIME type and the document part's content type are deliberately different.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_PART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/picture/2006/main';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PKG_CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

// US Letter, 1in margins, expressed in twentieths of a point (dxa).
const PAGE_W = 12240, PAGE_H = 15840, PAGE_MARGIN = 1440;
const CONTENT_W = PAGE_W - PAGE_MARGIN * 2;      // 9360 dxa of usable width
const QUOTE_INDENT = 432;                         // blockquote / nesting nudge
const LEVEL_INDENT = 360;                         // per list level
const MAX_LIST_LEVEL = 8;                         // numbering.xml defines levels 0..8

const EMU_PER_INCH = 914400;
const EMU_PER_PX = 9525;                          // 96 dpi
const MAX_IMG_W_EMU = EMU_PER_INCH * 6;           // ~6in — fits inside the margins
const MAX_IMG_H_EMU = Math.round(EMU_PER_INCH * 8);
const IMG_RASTER_SCALE = 2;                       // supersample SVG -> PNG for crisp print

// Private-use marker for placeholder tokens (code spans pulled out before emphasis scanning).
const MARK = '\uE000';
const RE_MARK = new RegExp(MARK, 'g');
const RE_CODE_PH = new RegExp('^c(\\d+)' + MARK);

const RE_FENCE_OPEN = /^(\s*)(`{3,}|~{3,})[ \t]*([^\s`~]*)/;
const RE_FENCE_CLOSE = /^\s*(`{3,}|~{3,})[ \t]*$/;
const RE_HEADING = /^(\s*)(#{1,6})(?:\s+(.*?))?\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_QUOTE = /^\s{0,3}>?[ \t]?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$/;
const RE_CODE_SPAN = /(`+)([\s\S]*?)\1/g;
const RE_IMAGE = /^!\[(?<alt>[^\]]*)\]\([ \t]*(?<src>[^()\s]+)(?:[ \t]+"[^"]*")?[ \t]*\)/;
const RE_LINK = /^\[(?<label>(?:[^\[\]]|\[[^\]]*\])*)\]\([ \t]*(?<href>[^()\s]+)(?:[ \t]+"[^"]*")?[ \t]*\)/;
const RE_AUTOLINK = /^<((?:https?|mailto):[^\s<>]+)>/;
const RE_BARE_URL = /^(?:https?|ftp):\/\/[^\s<>]+[^\s<>.,;:!?)\]'"“”]/;
const RE_ESCAPABLE = /[\\`*_{}\[\]()#+\-.!>~|]/;
const RE_WS = /[ \t\v\f\r\n\u00a0\u3000]/;

const EXT_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tiff'
};
const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff'
};
// Formats Word reliably embeds as-is; everything else is re-encoded to PNG.
const EMBED_AS_IS = new Set(['png', 'jpeg', 'gif']);

// --- xml.js ---
// Escapes for both element text and attribute values, dropping the control characters
// that are illegal in XML 1.0 (a lone 0x01 in a code block otherwise corrupts the part).
function xmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function xmlDecl(inner) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + inner;
}

// --- package_context.js ---
// Collects the pieces that only become known while walking the document: hyperlink
// relationships, media parts, their content types, and ordered-list number instances.
function parseTemplateContext(entries) {
    let maxRelId = 0, hasStyles = false, hasNumbering = false, sectPr = null;
    (entries || []).forEach(e => {
        if (e.path === 'word/styles.xml') hasStyles = true;
        if (e.path === 'word/numbering.xml') hasNumbering = true;
        if (e.path === 'word/_rels/document.xml.rels') {
            const xml = new TextDecoder('utf-8', { fatal: false }).decode(e.data);
            const re = /Id="rId(\d+)"/g;
            let match;
            while ((match = re.exec(xml)) !== null) {
                maxRelId = Math.max(maxRelId, parseInt(match[1], 10));
            }
        }
        if (e.path === 'word/document.xml') {
            const xml = new TextDecoder('utf-8', { fatal: false }).decode(e.data);
            // A document can have multiple sections. The overall document page settings
            // (margins, page numbers, headers/footers) are stored in the *last* sectPr.
            const matches = [...xml.matchAll(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g)];
            if (matches.length) sectPr = matches[matches.length - 1][0];
        }
    });
    return { maxRelId, hasStyles, hasNumbering, sectPr };
}

// Collects the pieces that only become known while walking the document: hyperlink
// relationships, media parts, their content types, and ordered-list number instances.
function makePackageContext(tplCtx) {
    const ctx = {
        rels: [],
        nextRelId: (tplCtx ? tplCtx.maxRelId : 0) + 1,
        media: [],           // { path, data, ext }
        mediaByKey: new Map(),
        exts: new Set(),
        orderedLists: 0,     // number of w:num instances needed for ordered lists
        drawingSeq: 1000,
        hasTemplate: !!(tplCtx && (tplCtx.hasStyles || tplCtx.sectPr)),
        sectPr: tplCtx ? tplCtx.sectPr : null
    };
    if (!tplCtx || !tplCtx.hasStyles) ctx.rels.push({ id: 'rId' + (ctx.nextRelId++), type: 'styles', target: 'styles.xml' });
    if (!tplCtx || !tplCtx.hasNumbering) ctx.rels.push({ id: 'rId' + (ctx.nextRelId++), type: 'numbering', target: 'numbering.xml' });

    ctx.addExternalLink = function (href) {
        if (!/^(?:https?:|mailto:)/i.test(href)) return null;   // only external targets get a rel
        const existing = ctx.rels.find(r => r.type === 'hyperlink' && r.target === href);
        if (existing) return existing.id;
        const id = 'rId' + (ctx.nextRelId++);
        ctx.rels.push({ id, type: 'hyperlink', target: href, external: true });
        return id;
    };
    ctx.addMedia = function (img) {
        const key = img.key || (img.key = 'img' + ctx.media.length);
        if (ctx.mediaByKey.has(key)) return ctx.mediaByKey.get(key);
        const ext = img.ext || 'png';
        const id = 'rId' + (ctx.nextRelId++);
        const path = 'word/media/image' + (ctx.media.length + 1) + '.' + ext;
        ctx.media.push({ path, data: img.data, ext });
        ctx.exts.add(ext);
        ctx.mediaByKey.set(key, id);
        return id;
    };
    ctx.nextOrderedList = function () {
        ctx.orderedLists++;
        // Custom lists are offset to 1001+ to avoid colliding with template lists
        return 1001 + ctx.orderedLists;
    };
    return ctx;
}

// --- inline_tokenizer.js ---
// Inline parsing runs in two steps: code spans are lifted out behind placeholder tokens
// (so `**` inside backticks is never treated as emphasis), then a recursive scanner
// handles images, links, autolinks, escapes and emphasis.
function tokenizeInline(input) {
    const codes = [];
    const text = String(input == null ? '' : input)
        .replace(RE_MARK, '')
        .replace(RE_CODE_SPAN, (m, ticks, body) => {
            codes.push(body.replace(/^ ([\s\S]*) $/, '$1'));
            return MARK + 'c' + (codes.length - 1) + MARK;
        });
    const runs = [];
    scanInline(text, { bold: false, italic: false, strike: false, link: null }, runs, codes);
    return runs;
}

function pushRun(runs, text, fmt) {
    if (!text) return;
    runs.push({
        text: text,
        bold: !!fmt.bold,
        italic: !!fmt.italic,
        strike: !!fmt.strike,
        code: false,
        link: fmt.link || null
    });
}

function scanInline(str, fmt, runs, codes) {
    let buf = '', i = 0;
    const flush = () => { if (buf) { pushRun(runs, buf, fmt); buf = ''; } };

    while (i < str.length) {
        const ch = str[i];

        // Placeholder for a previously extracted code span.
        if (ch === MARK) {
            const ph = RE_CODE_PH.exec(str.slice(i + 1));
            if (ph) {
                flush();
                runs.push({
                    text: codes[+ph[1]] || '',
                    bold: !!fmt.bold, italic: !!fmt.italic, strike: !!fmt.strike,
                    code: true, link: fmt.link || null
                });
                i += 1 + ph[0].length;
                continue;
            }
        }

        // Backslash escapes.
        if (ch === '\\' && i + 1 < str.length && RE_ESCAPABLE.test(str[i + 1])) {
            buf += str[i + 1]; i += 2; continue;
        }

        // Image (before link, so ![...](...) is not swallowed as a label).
        if (ch === '!') {
            const m = RE_IMAGE.exec(str.slice(i));
            if (m) {
                flush();
                runs.push({ image: true, alt: m.groups.alt || '', src: decodeSrc(m.groups.src), link: fmt.link || null });
                i += m[0].length; continue;
            }
        }

        // Link — the label may itself contain an image, e.g. [![alt](img.png)](https://…)
        if (ch === '[') {
            const m = RE_LINK.exec(str.slice(i));
            if (m) {
                flush();
                const href = decodeSrc(m.groups.href);
                scanInline(m.groups.label || '', { bold: fmt.bold, italic: fmt.italic, strike: fmt.strike, link: href }, runs, codes);
                i += m[0].length; continue;
            }
        }

        // <https://…> and bare URLs.
        if (ch === '<' || (fmt.link == null && (ch === 'h' || ch === 'f'))) {
            const auto = RE_AUTOLINK.exec(str.slice(i));
            if (auto) {
                flush();
                runs.push({ text: auto[1], bold: !!fmt.bold, italic: !!fmt.italic, strike: !!fmt.strike, code: false, link: auto[1] });
                i += auto[0].length; continue;
            }
            const bare = ch === 'h' || ch === 'f' ? RE_BARE_URL.exec(str.slice(i)) : null;
            if (bare) {
                flush();
                runs.push({ text: bare[0], bold: !!fmt.bold, italic: !!fmt.italic, strike: !!fmt.strike, code: false, link: bare[0] });
                i += bare[0].length; continue;
            }
        }

        // Strikethrough.
        if (ch === '~' && str.startsWith('~~', i)) {
            const close = findCloser(str, '~~', i + 2);
            if (close !== -1) {
                flush();
                scanInline(str.slice(i + 2, close), { bold: fmt.bold, italic: fmt.italic, strike: true, link: fmt.link }, runs, codes);
                i = close + 2; continue;
            }
        }

        // Emphasis (* / _ , 1..3 delimiters deep).
        if (ch === '*' || ch === '_') {
            const em = matchEmphasis(str, i);
            if (em) {
                flush();
                scanInline(em.body, {
                    bold: !!fmt.bold || em.bold,
                    italic: !!fmt.italic || em.italic,
                    strike: !!fmt.strike,
                    link: fmt.link
                }, runs, codes);
                i = em.end; continue;
            }
        }

        buf += ch; i++;
    }
    flush();
}

// A closing run of `delim` that is preceded by a non-space, non-escape character.
function findCloser(str, delim, from) {
    let idx = str.indexOf(delim, from);
    while (idx !== -1) {
        const before = idx > 0 ? str[idx - 1] : '';
        if (before && !RE_WS.test(before) && before !== '\\') return idx;
        idx = str.indexOf(delim, idx + 1);
    }
    return -1;
}

function matchEmphasis(str, i) {
    const ch = str[i];
    let n = 1;
    while (str[i + n] === ch && n < 3) n++;

    // Intra-word '_' is literal (snake_case); an opener can't be followed by whitespace.
    if (ch === '_') {
        const prev = i > 0 ? str[i - 1] : '';
        if (prev && /[\w\d]/.test(prev)) return null;
    }
    if (RE_WS.test(str[i + n] || ' ')) return null;

    // Try the full delimiter run first, then degrade: *** -> ** -> *
    // `**` is strong only, `*` is emphasis only, `***` is both. Requiring a closing run of
    // the SAME length is what keeps "*a* and *b*" as two italics and "*a **b** c*" as
    // italic wrapping bold, instead of one greedy match swallowing the middle.
    for (let len = n; len >= 1; len--) {
        const close = findCloserRun(str, ch, i + len, len);
        if (close === -1) continue;
        const body = str.slice(i + len, close);
        // A body still starting with the delimiter means the runs don't line up; better to
        // fall through to a shorter opener (or literal text) than to emit stray "*"/"_".
        if (!body || body.charAt(0) === ch) continue;
        return { body, end: close + len, bold: len >= 2, italic: len !== 2 };
    }
    return null;
}

// Index of the first run of exactly `len` copies of `ch` at/after `from` that is preceded
// by a non-space, non-escape character (a delimiter can't close across a space).
function findCloserRun(str, ch, from, len) {
    let i = from;
    while (i < str.length) {
        if (str[i] !== ch) { i++; continue; }
        let runLen = 0;
        while (str[i + runLen] === ch) runLen++;
        const before = i > 0 ? str[i - 1] : '';
        if (runLen === len && before && !RE_WS.test(before) && before !== '\\') return i;
        i += runLen;
    }
    return -1;
}

function decodeSrc(src) {
    let s = String(src || '').trim();
    if (/^<.*>$/.test(s)) s = s.slice(1, -1);
    // External links must remain encoded for valid OPC Relationship Targets.
    // Only decode local workspace paths so the VFS can locate them.
    try { if (!/^data:/i.test(s) && !/^(?:https?:|mailto:)/i.test(s)) s = decodeURI(s); } catch (e) {}
    return s;
}

// --- block_parser.js ---
function parseMarkdown(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    stripFrontmatter(lines);
    const blocks = parseBlockLines(lines, { inQuote: false });
    // Materialize lazy list-item runs so the media pre-pass sees every inline image.
    blocks.forEach(b => { if (b.lines && !b.runs) b.runs = linesToRuns(b.lines); });
    return blocks;
}

// Skill/plan files open with a YAML frontmatter block; it is metadata, not prose.
function stripFrontmatter(lines) {
    if (!lines.length || !/^---[ \t]*$/.test(lines[0])) return;
    for (let k = 1; k < lines.length; k++) {
        if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[k])) { lines.splice(0, k + 1); return; }
        if (k > 60) return;   // no closing fence in sight: not frontmatter after all
    }
}

function indentWidth(line) {
    let w = 0;
    for (const c of line) {
        if (c === ' ') w++;
        else if (c === '\t') w += 4;
        else break;
    }
    return w;
}

function linesToRuns(lines) {
    const out = [];
    (lines || []).forEach((ln, idx) => {
        if (idx) out.push({ br: true });
        tokenizeInline(ln).forEach(r => out.push(r));
    });
    return out;
}

function parseBlockLines(lines, env) {
    const blocks = [];
    let para = [];
    let list = null;          // { items: [] } — bookkeeping for lazy continuations
    // Distinct marker indents, deepest last. Mapping an indent to its position in this
    // stack means 2-space and 4-space nesting both produce levels 0,1,2… rather than
    // 4-space documents jumping straight to level 2.
    const listIndents = [];
    const levelForIndent = (indent) => {
        while (listIndents.length && listIndents[listIndents.length - 1] > indent) listIndents.pop();
        if (!listIndents.length || listIndents[listIndents.length - 1] < indent) listIndents.push(indent);
        return Math.min(MAX_LIST_LEVEL, listIndents.length - 1);
    };

    const flushPara = () => {
        if (!para.length) return;
        blocks.push({ type: 'paragraph', runs: linesToRuns(para), inQuote: env.inQuote });
        para = [];
    };
    const closeList = () => {
        if (!list) return;
        list.items.forEach(it => { if (!it.runs) it.runs = linesToRuns(it.lines); });
        list = null;
        listIndents.length = 0;
    };

    for (let i = 0; i < lines.length; i++) {
        const original = lines[i];
        const line = original.replace(/\t/g, '    ');
        const trimmed = line.trim();

        // Blank line: closes a paragraph, but deliberately does NOT close a list, so
        // `1. a\n\n2. b` keeps counting instead of restarting at 1.
        if (!trimmed) { flushPara(); continue; }

        // Fenced code block.
        const fence = RE_FENCE_OPEN.exec(line);
        if (fence) {
            flushPara(); closeList();
            const marker = fence[2][0], minLen = fence[2].length;
            const lang = (fence[3] || '').trim().toLowerCase();
            const body = [];
            i++;
            for (; i < lines.length; i++) {
                const cand = lines[i].replace(/\t/g, '    ');
                const close = RE_FENCE_CLOSE.exec(cand);
                if (close && close[1][0] === marker && close[1].length >= minLen) break;
                body.push(lines[i]);
            }
            blocks.push({ type: 'code', lang, text: body.join('\n'), inQuote: env.inQuote });
            continue;
        }

        // ATX heading.
        const heading = RE_HEADING.exec(line);
        if (heading) {
            flushPara(); closeList();
            const text = String(heading[3] || '').replace(/[ \t]+#+[ \t]*$/, '').trim();
            blocks.push({ type: 'heading', level: heading[2].length, runs: tokenizeInline(text), inQuote: env.inQuote });
            continue;
        }

        // Horizontal rule (checked before lists: "- - -" is a rule, not a bullet).
        if (RE_HR.test(line)) {
            flushPara(); closeList();
            blocks.push({ type: 'hr', inQuote: env.inQuote });
            continue;
        }

        // Blockquote — recurse with the quote flag set so nested content is still parsed.
        if (/^\s{0,3}>/.test(line)) {
            flushPara(); closeList();
            const inner = [];
            while (i < lines.length && /^\s{0,3}>/.test(lines[i].replace(/\t/g, '    '))) {
                inner.push(RE_QUOTE.exec(lines[i].replace(/\t/g, '    '))[1]);
                i++;
            }
            i--;
            parseBlockLines(inner, { inQuote: true }).forEach(b => blocks.push(b));
            continue;
        }

        // GFM table: header row + alignment row (+ body rows).
        if (trimmed.includes('|') && i + 1 < lines.length) {
            const aligns = parseSeparatorRow(lines[i + 1]);
            if (aligns) {
                flushPara(); closeList();
                const header = splitTableRow(original);
                i += 2;
                const rows = [];
                while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
                    rows.push(splitTableRow(lines[i]));
                    i++;
                }
                i--;
                blocks.push({
                    type: 'table',
                    header: header.map(c => tokenizeInline(c)),
                    aligns: aligns,
                    rows: rows.map(r => r.map(c => tokenizeInline(c))),
                    inQuote: env.inQuote
                });
                continue;
            }
        }

        // List item (unordered or ordered), with indentation-derived nesting level.
        const li = RE_LIST.exec(line);
        if (li) {
            flushPara();
            const indent = indentWidth(line);
            const ordered = /\d/.test(li[2][0]);
            if (!list) list = { items: [] };
            const item = {
                type: 'item', ordered: ordered, level: levelForIndent(indent),
                lines: [], task: null, inQuote: env.inQuote
            };
            let content = li[4];
            const task = RE_TASK.exec(content);
            if (task) { item.task = task[1] === ' ' ? 'todo' : 'done'; content = task[2]; }
            item.markerIndent = indent;
            item.lines.push(content);
            list.items.push(item);
            blocks.push(item);
            continue;
        }

        // Lazy continuation of the previous list item ("  wrapped text").
        if (list && list.items.length) {
            const prev = list.items[list.items.length - 1];
            if (indentWidth(line) >= prev.markerIndent + 2) { prev.lines.push(trimmed); continue; }
        }

        flushPara(); closeList();
        para.push(original);
    }

    flushPara();
    closeList();
    return blocks;
}

function parseSeparatorRow(line) {
    if (line == null) return null;
    let l = String(line).trim();
    if (!l || !/^[|\s:\-]+$/.test(l) || !l.includes('-')) return null;
    // The delimiter row must carry a pipe: a bare "---" is a thematic break (and "==="
    // a setext underline), and stealing those would corrupt every plain document.
    if (!l.includes('|')) return null;
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    const cells = l.split('|');
    if (!cells.length) return null;
    const out = [];
    for (const c of cells) {
        const t = c.trim();
        if (!/^:?-+:?$/.test(t)) return null;
        out.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : '');
    }
    return out;
}

// Splits a table row on unescaped pipes.
function splitTableRow(line) {
    let l = String(line == null ? '' : line).trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let k = 0; k < l.length; k++) {
        const c = l[k];
        if (c === '\\' && l[k + 1] === '|') { cur += '|'; k++; continue; }
        if (c === '|') { cells.push(cur); cur = ''; continue; }
        cur += c;
    }
    cells.push(cur);
    return cells.map(s => s.trim());
}

// --- ooxml_paragraph.js ---
// w:pPr children must appear in schema order or Word rejects the part:
// pStyle -> numPr -> pBdr -> spacing -> ind -> jc. Spacing/keepNext live in styles.xml.
function pPrXml(o) {
    o = o || {};
    const parts = [];
    if (o.style) parts.push(`<w:pStyle w:val="${o.style}"/>`);
    if (o.numId != null) parts.push(`<w:numPr><w:ilvl w:val="${o.ilvl | 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`);
    if (o.bdr) parts.push(`<w:pBdr>${o.bdr}</w:pBdr>`);
    if (o.contextualSpacing) parts.push(`<w:contextualSpacing/>`);
    if (o.ind) parts.push(`<w:ind ${o.ind}/>`);
    if (o.jc) parts.push(`<w:jc w:val="${o.jc}"/>`);
    return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : '';
}

// w:rPr children are likewise order-sensitive.
function rPrXml(r) {
    const parts = [];
    if (r.code) parts.push('<w:rStyle w:val="InlineCode"/>');
    else if (r.link) parts.push('<w:rStyle w:val="Hyperlink"/>');
    if (r.font) parts.push(`<w:rFonts w:ascii="${r.font}" w:hAnsi="${r.font}" w:cs="${r.font}"/>`);
    if (r.bold) parts.push('<w:b/><w:bCs/>');
    if (r.italic) parts.push('<w:i/><w:iCs/>');
    if (r.strike) parts.push('<w:strike/>');
    if (r.color) parts.push(`<w:color w:val="${r.color}"/>`);
    if (r.sz) parts.push(`<w:sz w:val="${r.sz}"/><w:szCs w:val="${r.sz}"/>`);
    return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function textRunXml(text, r) {
    return `<w:r>${rPrXml(r || {})}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function breakRunXml(r) {
    return `<w:r>${rPrXml(r || {})}<w:br/></w:r>`;
}

function runsXml(runs, ctx) {
    let xml = '';
    (runs || []).forEach(run => {
        let body = '';
        if (run.br) {
            body = breakRunXml();
        } else if (run.image) {
            body = imageRunXml(run, ctx);
        } else {
            body = String(run.text == null ? '' : run.text).split('\n')
                .map((piece, idx) => (idx ? breakRunXml(run) : '') + (piece ? textRunXml(piece, run) : ''))
                .join('');
        }
        if (!body) return;
        // An image wrapped in a link — [![alt](i.png)](https://…) — keeps its click target.
        const relId = run.link ? ctx.addExternalLink(run.link) : null;
        xml += relId ? `<w:hyperlink r:id="${relId}" w:history="1">${body}</w:hyperlink>` : body;
    });
    return xml;
}

// A fenced code block becomes ONE paragraph holding soft breaks: the shading/border
// then reads as a single box instead of a stack of one-line boxes.
function codeBlockXml(block, ctx) {
    const ind = block.inQuote ? `w:left="${QUOTE_INDENT + 216}" w:right="${QUOTE_INDENT}"` : '';
    const lines = String(block.text == null ? '' : block.text).split('\n');
    let inner = '';
    lines.forEach((ln, idx) => {
        if (idx) inner += '<w:r><w:br/></w:r>';
        if (ln) inner += `<w:r><w:t xml:space="preserve">${xmlEscape(ln)}</w:t></w:r>`;
    });
    if (!inner) inner = '<w:r><w:t xml:space="preserve"> </w:t></w:r>';
    // Map to 'BlockText' instead of 'CodeBlock' so template formatting cleanly applies
    return `<w:p>${pPrXml({ style: 'BlockText', ind })}${inner}</w:p>`;
}

function imageRunXml(run, ctx) {
    const img = run.resolved;
    const label = run.alt || 'image';
    if (!img || !img.data) {
        // Unresolvable image: keep an honest textual trace instead of dropping content.
        // The source is clipped so a failed data: URL can't dump megabytes into a paragraph.
        const src = String(run.src || '');
        const hint = src.length > 80 ? src.slice(0, 80) + '…' : src;
        return textRunXml(`[${label}: ${hint}]`, { color: '8A94A6', italic: true });
    }
    const relId = ctx.addMedia(img);
    const id = ++ctx.drawingSeq;
    let cx = Math.max(1, Math.round((img.width || 640) * EMU_PER_PX));
    let cy = Math.max(1, Math.round((img.height || 480) * EMU_PER_PX));
    if (cx > MAX_IMG_W_EMU) { cy = Math.max(1, Math.round(cy * (MAX_IMG_W_EMU / cx))); cx = MAX_IMG_W_EMU; }
    if (cy > MAX_IMG_H_EMU) { cx = Math.max(1, Math.round(cx * (MAX_IMG_H_EMU / cy))); cy = MAX_IMG_H_EMU; }
    const name = xmlEscape(label);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
        `<wp:docPr id="${id}" name="Picture ${id}" descr="${name}"/>` +
        `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
        `<a:graphic><a:graphicData uri="${PIC_NS}">` +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.${img.ext || 'png'}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
        `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function tableXml(block, ctx) {
    const cols = Math.max(1, block.header.length);
    const colW = Math.floor(CONTENT_W / cols);
    const grid = new Array(cols).fill(`<w:gridCol w:w="${colW}"/>`).join('');
    const alignJc = a => (a === 'center' || a === 'right' || a === 'left') ? a : null;

    const cell = (runs, opts) => {
        const o = opts || {};
        // If a template is present, omit inline cell shading to allow native styles to apply
        const shd = (o.shd && !ctx.hasTemplate) ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>` : '';
        const tcPr = `<w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shd}<w:vAlign w:val="top"/></w:tcPr>`;
        // Header cells force bold on text runs; delegating to runsXml keeps links, images
        // and inline styling intact rather than re-implementing the run writer here.
        const source = o.bold
            ? (runs || []).map(r => (r.br || r.image) ? r : Object.assign({}, r, { bold: true }))
            : runs;
        const body = runsXml(source, ctx);
        return `<w:tc>${tcPr}<w:p>${pPrXml({ style: 'TableCellText', jc: alignJc(o.align) })}${body}</w:p></w:tc>`;
    };

    const borders = ctx.hasTemplate ? '' :
        `<w:tblBorders>` +
        `<w:top w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:left w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:right w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `</w:tblBorders>` +
        `<w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="113" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="113" w:type="dxa"/></w:tblCellMar>`;

    let xml = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>` +
        borders +
        `<w:tblLayout w:type="autofit"/>` +
        `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
        `<w:tblGrid>${grid}</w:tblGrid>`;

    // cantSplit precedes tblHeader: CT_TrPr is order-sensitive.
    xml += `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>` +
        block.header.map((c, idx) => cell(c, { shd: 'F1F5F9', bold: true, align: block.aligns[idx] })).join('') +
        `</w:tr>`;

    block.rows.forEach(row => {
        xml += '<w:tr>' + block.header.map((_, idx) => cell(row[idx] || [], { align: block.aligns[idx] })).join('') + '</w:tr>';
    });

    return xml + '</w:tbl>';
}

const TASK_GLYPHS = { todo: '\u2610 ', done: '\u2611 ' };

function blockXml(block, ctx) {
    switch (block.type) {
        case 'heading':
            return `<w:p>${pPrXml({ style: 'Heading' + Math.min(6, Math.max(1, block.level)) })}${runsXml(block.runs, ctx)}</w:p>`;

        case 'code':
            return codeBlockXml(block, ctx);

        case 'hr':
            return `<w:p>${pPrXml({ bdr: '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="C6CFDB"/>' })}</w:p>`;

        case 'table':
            return tableXml(block, ctx);

        case 'item': {
            const ilvl = Math.min(MAX_LIST_LEVEL, block.level | 0);
            const numId = block.ordered ? (block.numId || 1002) : 1001;
            const ind = block.inQuote
                ? `w:left="${QUOTE_INDENT + LEVEL_INDENT * (ilvl + 1)}" w:hanging="${LEVEL_INDENT}"`
                : '';
            const prefix = block.task ? textRunXml(TASK_GLYPHS[block.task] || '', {}) : '';
            // contextualSpacing collapses the vertical padding between items of the same list
            return `<w:p>${pPrXml({ style: 'ListParagraph', numId, ilvl, ind, contextualSpacing: true })}${prefix}${runsXml(block.runs, ctx)}</w:p>`;
        }

        default: {
            // Detect block-level images that have alt text and emit a caption paragraph
            if (block.runs && block.runs.length === 1 && block.runs[0].image && block.runs[0].alt) {
                const imgP = `<w:p>${pPrXml({ style: 'Normal', jc: 'center' })}${runsXml(block.runs, ctx)}</w:p>`;
                const capP = `<w:p>${pPrXml({ style: 'Caption', jc: 'center' })}${textRunXml(block.runs[0].alt)}</w:p>`;
                return imgP + capP;
            }
            // Detect paragraphs that start with Table/Figure/Caption
            const textStr = (block.runs || []).map(r => r.text || '').join('');
            if (/^(?:Table|Figure|Caption)\s*(?:\d+)?\s*:/i.test(textStr)) {
                return `<w:p>${pPrXml({ style: 'Caption' })}${runsXml(block.runs, ctx)}</w:p>`;
            }
            return `<w:p>${pPrXml({ style: block.inQuote ? 'BlockQuote' : 'Normal' })}${runsXml(block.runs, ctx)}</w:p>`;
        }
    }
}

// Assigns a numId to every ordered-list run. Each contiguous list gets its own w:num
// instance so numbering restarts per list, exactly like a rendered Markdown preview.
function assignListNumbers(blocks, ctx) {
    const stack = [];
    blocks.forEach(b => {
        if (b.type !== 'item') { stack.length = 0; return; }
        const lvl = Math.min(MAX_LIST_LEVEL, b.level | 0);
        stack.length = lvl + 1; // Truncate deeper levels
        if (b.ordered) {
            if (!stack[lvl] || !stack[lvl].ordered) {
                stack[lvl] = { ordered: true, numId: ctx.nextOrderedList() };
            }
            b.numId = stack[lvl].numId;
        } else {
            stack[lvl] = { ordered: false, numId: 1001 };
            b.numId = 1001;
        }
    });
}

function buildDocumentXml(blocks, ctx) {
    assignListNumbers(blocks, ctx);
    let body = blocks.map(b => blockXml(b, ctx)).join('');
    // Word requires at least one paragraph in the document, and specifically requires
    // one after a table if a table is the last element before section properties.
    if (!blocks.length || blocks[blocks.length - 1].type === 'table') {
        body += '<w:p/>';
    }
    // If the template provided its own section properties (margins, page numbers, headers, footers), use them.
    const sect = ctx.sectPr || (
        `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>` +
        `<w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="720" w:footer="720" w:gutter="0"/>` +
        `<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>`
    );
    return xmlDecl(
        `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}">` +
        `<w:body>${body}${sect}</w:body></w:document>`
    );
}

// --- ooxml_styles.js ---
function headingStyle(id, size, color, before, after, italic) {
    const lvl = id.slice(-1);
    return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="heading ${lvl}"/>` +
        `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="${+lvl - 1}"/></w:pPr>` +
        `<w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:cs="Cambria"/>` +
        `<w:b/><w:bCs/>${italic ? '<w:i/><w:iCs/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

function buildStylesXml() {
    const border = '<w:top w:val="single" w:sz="4" w:space="6" w:color="D5DBE3"/>' +
        '<w:left w:val="single" w:sz="4" w:space="8" w:color="D5DBE3"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="6" w:color="D5DBE3"/>' +
        '<w:right w:val="single" w:sz="4" w:space="8" w:color="D5DBE3"/>';
    return xmlDecl(`<w:styles xmlns:w="${W_NS}">` +
        `<w:docDefaults><w:rPrDefault><w:rPr>` +
        `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>` +
        `<w:color w:val="1F2937"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:bidi="ar-SA"/>` +
        `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +

        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
        headingStyle('Heading1', 32, '1F3864', 400, 140, false) +
        headingStyle('Heading2', 28, '2F5496', 360, 120, false) +
        headingStyle('Heading3', 26, '2F5496', 320, 100, false) +
        headingStyle('Heading4', 24, '2F5496', 280, 80, false) +
        headingStyle('Heading5', 22, '404040', 240, 80, true) +
        headingStyle('Heading6', 22, '595959', 240, 60, true) +

        `<w:style w:type="paragraph" w:styleId="BlockText"><w:name w:val="Block Text"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        // CT_PPrBase order: keepLines -> pBdr -> shd -> spacing.
        `<w:pPr><w:keepLines/><w:pBdr>${border}</w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F5F7FA"/><w:spacing w:before="120" w:after="240" w:line="240" w:lineRule="auto"/></w:pPr>` +
        `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:color w:val="1F2937"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +

        `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="5A6A7E"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +

        `<w:style w:type="paragraph" w:styleId="BlockQuote"><w:name w:val="Block Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        // CT_PPrBase order: pBdr -> spacing -> ind.
        `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="B6C2D0"/></w:pBdr>` +
        `<w:spacing w:before="80" w:after="160" w:line="259" w:lineRule="auto"/><w:ind w:left="${QUOTE_INDENT}" w:right="216"/></w:pPr>` +
        `<w:rPr><w:i/><w:iCs/><w:color w:val="4B5563"/></w:rPr></w:style>` +

        `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:spacing w:after="60" w:line="259" w:lineRule="auto"/><w:contextualSpacing/></w:pPr></w:style>` +

        `<w:style w:type="paragraph" w:styleId="TableCellText"><w:name w:val="Table Cell Text"/><w:basedOn w:val="Normal"/>` +
        `<w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr>` +
        `<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>` +

        `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
        `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
        `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
        `<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:uiPriority w:val="99"/>` +
        `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:color w:val="B03A5B"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="EFF2F6"/></w:rPr></w:style>` +

        `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:unhideWhenUsed/>` +
        `<w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
        `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>` +
        `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>` +
        `<w:tblPr><w:tblBorders>` +
        `<w:top w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="C6CFDB"/>` +
        `</w:tblBorders>` +
        `<w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="113" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="113" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
        `</w:styles>`);
}

// --- ooxml_numbering.js ---
function numberingLevels(fmt) {
    const bullets = ['\u2022', '\u25E6', '\u25AA'];
    let xml = '';
    for (let lvl = 0; lvl <= MAX_LIST_LEVEL; lvl++) {
        const left = LEVEL_INDENT * (lvl + 1);
        // Ordered lists must use the Word variable `%N` (where N is the 1-based level)
        // instead of a hardcoded number, or every item will literally render as "1.".
        const text = fmt === 'bullet' ? bullets[lvl % bullets.length] : '%' + (lvl + 1) + '.';
        xml += `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
            `<w:lvlText w:val="${xmlEscape(text)}"/><w:lvlJc w:val="left"/>` +
            `<w:pPr><w:ind w:left="${left}" w:hanging="${LEVEL_INDENT}"/></w:pPr>` +
            `<w:rPr><w:color w:val="${fmt === 'bullet' ? '6B7280' : '4B5563'}"/></w:rPr>` +
            `</w:lvl>`;
    }
    return xml;
}

// abstractNum 1001 = bullets, abstractNum 1002 = decimal. numId 1001 is the shared bullet
// instance; every ordered list gets an instance with startOverride so it restarts.
function buildNumberingXml(orderedListCount) {
    let xml = xmlDecl(`<w:numbering xmlns:w="${W_NS}">`) +
        `<w:abstractNum w:abstractNumId="1001"><w:multiLevelType w:val="hybridMultilevel"/>${numberingLevels('bullet')}</w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="1002"><w:multiLevelType w:val="hybridMultilevel"/>${numberingLevels('decimal')}</w:abstractNum>` +
        `<w:num w:numId="1001"><w:abstractNumId w:val="1001"/></w:num>`;
    const overrides = Array.from({ length: MAX_LIST_LEVEL + 1 },
        (_, lvl) => `<w:lvlOverride w:ilvl="${lvl}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('');
    for (let n = 1; n <= Math.max(1, orderedListCount); n++) {
        xml += `<w:num w:numId="${1001 + n}"><w:abstractNumId w:val="1002"/>${overrides}</w:num>`;
    }
    return xml + '</w:numbering>';
}

// Appends our high-ID list definitions to a template's numbering.xml so Markdown
// lists continue working without colliding with the template's native list IDs.
function mergeNumberingXml(templateXml, orderedListCount) {
    const abstractNums = 
        `<w:abstractNum w:abstractNumId="1001"><w:multiLevelType w:val="hybridMultilevel"/>${numberingLevels('bullet')}</w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="1002"><w:multiLevelType w:val="hybridMultilevel"/>${numberingLevels('decimal')}</w:abstractNum>`;
    let nums = `<w:num w:numId="1001"><w:abstractNumId w:val="1001"/></w:num>`;
    const overrides = Array.from({ length: MAX_LIST_LEVEL + 1 },
        (_, lvl) => `<w:lvlOverride w:ilvl="${lvl}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('');
    for (let n = 1; n <= Math.max(1, orderedListCount); n++) {
        nums += `<w:num w:numId="${1001 + n}"><w:abstractNumId w:val="1002"/>${overrides}</w:num>`;
    }
    return templateXml.replace('</w:numbering>', abstractNums + nums + '</w:numbering>');
}

// --- ooxml_parts.js ---
function mergeContentTypesXml(templateXml, exts) {
    let xml = templateXml || buildContentTypesXml([]);
    exts.forEach(ext => {
        if (!xml.includes(`Extension="${ext}"`)) {
            xml = xml.replace('</Types>', `<Default Extension="${ext}" ContentType="${MIME_BY_EXT[ext] || 'application/octet-stream'}"/></Types>`);
        }
    });
    if (!xml.includes('PartName="/word/document.xml"')) {
        xml = xml.replace('</Types>', `<Override PartName="/word/document.xml" ContentType="${DOCX_PART_CONTENT_TYPE}"/></Types>`);
    }
    return xml;
}

function mergeDocumentRelsXml(templateXml, newRels) {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    let xml = templateXml || buildDocumentRelsXml([]);
    newRels.forEach(r => {
        const tag = `<Relationship Id="${r.id}" Type="${REL}${r.type}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`;
        xml = xml.replace('</Relationships>', tag + '</Relationships>');
    });
    return xml;
}

function buildContentTypesXml(exts) {
    let xml = xmlDecl(`<Types xmlns="${PKG_CT_NS}">`) +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>`;
    (exts || []).forEach(ext => {
        xml += `<Default Extension="${xmlEscape(ext)}" ContentType="${xmlEscape(MIME_BY_EXT[ext] || 'application/octet-stream')}"/>`;
    });
    xml += `<Override PartName="/word/document.xml" ContentType="${DOCX_PART_CONTENT_TYPE}"/>`;
    xml += `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`;
    xml += `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`;
    return xml + '</Types>';
}

function buildPackageRelsXml() {
    return xmlDecl(`<Relationships xmlns="${PKG_REL_NS}">`) +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`;
}

function buildDocumentRelsXml(rels) {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    let xml = xmlDecl(`<Relationships xmlns="${PKG_REL_NS}">`);
    (rels || []).forEach(r => {
        xml += `<Relationship Id="${r.id}" Type="${REL}${r.type}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`;
    });
    return xml + '</Relationships>';
}

// --- bytes_utils.js ---
function base64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

function bytesToDataUrl(bytes, mime) {
    return `data:${mime || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

function parseDataUrl(src) {
    const m = /^data:([^;,]*)?((?:;[^,]*)?),([\s\S]*)$/.exec(String(src || ''));
    if (!m) return null;
    const mime = (m[1] || 'text/plain').toLowerCase();
    const base64 = /;base64/i.test(m[2] || '');
    try {
        return { mime, data: base64 ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])) };
    } catch (e) {
        return null;
    }
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('could not decode image'));
        img.src = src;
    });
}

async function canvasToPng(canvas) {
    const blob = await new Promise(resolve => {
        try { canvas.toBlob(b => resolve(b), 'image/png'); } catch (e) { resolve(null); }
    });
    if (blob) return new Uint8Array(await blob.arrayBuffer());
    const url = canvas.toDataURL('image/png');
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('PNG encoding unavailable');
    return parsed.data;
}

// --- image_resolver.js ---
// Word has no idea what a workspace path is, so every image source has to be turned
// into raw bytes + a natural pixel size before the document XML is written.
async function resolveImageSource(src, baseFile) {
    if (!src) throw new Error('empty source');

    if (/^data:/i.test(src)) {
        const parsed = parseDataUrl(src);
        if (!parsed) throw new Error('malformed data URL');
        return finalizeImage(parsed.data, parsed.mime, src);
    }

    if (/^(?:https?:|blob:|\/\/)/i.test(src)) {
        const resp = await fetch(src, { mode: 'cors', credentials: 'omit' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return finalizeImage(bytes, blob.type || '', src);
    }

    const path = (typeof window.resolveRelativePath === 'function')
        ? window.resolveRelativePath(baseFile || '', src)
        : String(src).replace(/^\.?\//, '');

    const dataUrl = (typeof window.readImageDataUrl === 'function') ? await window.readImageDataUrl(path) : null;
    if (dataUrl) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) return finalizeImage(parsed.data, parsed.mime, path);
    }
    if (typeof window.vfsReadBlob === 'function') {
        const blob = await window.vfsReadBlob(path);
        if (blob) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return finalizeImage(bytes, blob.type || '', path);
        }
    }
    throw new Error('not found in workspace');
}

// Only ever returns extensions that MIME_BY_EXT knows about: an unknown or reserved
// extension ('xml', 'rels') leaking into [Content_Types].xml would break the whole package.
function extensionFor(mime, hint) {
    const fromMime = EXT_BY_MIME[(mime || '').toLowerCase()];
    if (fromMime && MIME_BY_EXT[fromMime]) return fromMime;
    const m = /\.([a-z0-9]+)$/i.exec(String(hint || '').split('?')[0].split('#')[0]);
    let ext = m ? m[1].toLowerCase() : '';
    if (ext === 'jpg') ext = 'jpeg';
    return MIME_BY_EXT[ext] ? ext : 'png';
}

// Sniffed so a mislabelled .png that is really an SVG still gets rasterized.
function looksLikeSvg(bytes) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).trim().toLowerCase();
    return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

function sniffImageExt(bytes) {
    if (!bytes || bytes.length < 12) return '';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';
    return '';
}

async function finalizeImage(bytes, mime, hint) {
    if (looksLikeSvg(bytes)) return rasterizeSvgBytes(bytes);
    // Magic bytes outrank the declared MIME/filename: writing JPEG bytes into the package
    // as image7.png would produce a file Word refuses to open.
    const ext = sniffImageExt(bytes) || extensionFor(mime, hint);
    const img = await loadImage(bytesToDataUrl(bytes, MIME_BY_EXT[ext] || mime || 'image/png'));
    if (EMBED_AS_IS.has(ext)) {
        // PNG / JPEG / GIF are embedded byte-for-byte: no recompression, no quality loss.
        return {
            data: bytes, ext,
            width: img.naturalWidth || img.width || 640,
            height: img.naturalHeight || img.height || 480
        };
    }
    // webp / bmp / ico / tiff: re-encode as PNG — Word support for the rest is patchy.
    return rasterizeImageElement(img);
}

async function rasterizeImageElement(img) {
    const maxPx = Math.floor(MAX_IMG_W_EMU / EMU_PER_PX);
    let dw = img.naturalWidth || img.width || 640;
    let dh = img.naturalHeight || img.height || 480;
    if (dw > maxPx) { const f = maxPx / dw; dw = Math.round(dw * f); dh = Math.round(dh * f); }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(dw * IMG_RASTER_SCALE));
    canvas.height = Math.max(1, Math.round(dh * IMG_RASTER_SCALE));
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: await canvasToPng(canvas), ext: 'png', width: dw, height: dh };
}

// --- svg_rasterizer.js ---
function svgRootTag(svgText) {
    const m = /<svg\b[^>]*>/i.exec(svgText);
    return m ? m[0] : '';
}

function numericAttr(tag, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
    if (!m) return 0;
    const raw = String(m[1]).trim();
    // A percentage ("100%", mermaid's default) says nothing about real pixels and must
    // not win over the viewBox, so only a plain number counts here.
    if (!/^\d+(\.\d+)?$/.test(raw)) return 0;
    const v = parseFloat(raw);
    return isFinite(v) && v > 0 ? v : 0;
}

function svgIntrinsicSize(tag) {
    const vb = /viewBox\s*=\s*["']\s*([-+.\d.eE]+)[,\s]+([-+.\d.eE]+)[,\s]+([-+.\d.eE]+)[,\s]+([-+.\d.eE]+)\s*["']/i.exec(tag);
    let w = numericAttr(tag, 'width'), h = numericAttr(tag, 'height');
    if ((!w || !h) && vb) { w = parseFloat(vb[3]); h = parseFloat(vb[4]); }
    if (!w || !h || !isFinite(w) || !isFinite(h)) { w = 640; h = 480; }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

// Mermaid emits width="100%" / style="max-width:…", which makes a bare <img> fall back
// to 300x150. Normalizing the root tag gives the raster the real aspect ratio.
function normalizeSvgRoot(svgText, w, h) {
    const root = svgRootTag(svgText);
    if (!root) return null;
    let tag = root;
    if (!/\bxmlns\s*=/.test(tag)) tag = tag.replace(/^<svg/i, `<svg xmlns="http://www.w3.org/2000/svg"`);
    tag = tag.replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, '').replace(/\s(?:width|height)\s*=\s*'[^']*'/gi, '');
    tag = tag.replace(/style\s*=\s*"([^"]*)"/i, (m, css) => `style="${String(css).replace(/(?:max-)?(?:width|height)\s*:[^;]+;?/gi, '')}"`);
    tag = tag.replace(/\s*\/?>$/, '') + ` width="${w}" height="${h}">`;
    return svgText.replace(root, tag);
}

async function rasterizeSvgBytes(svgBytes) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(svgBytes);
    return rasterizeSvgText(text);
}

async function rasterizeSvgText(svgText) {
    const root = svgRootTag(svgText || '');
    if (!root) throw new Error('not an SVG document');
    const size = svgIntrinsicSize(root);
    const maxPx = Math.floor(MAX_IMG_W_EMU / EMU_PER_PX);
    let lw = size.w, lh = size.h;
    if (lw > maxPx) { const f = maxPx / lw; lw = Math.round(lw * f); lh = Math.round(lh * f); }
    const normalized = normalizeSvgRoot(svgText, lw, lh);
    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(normalized));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(lw * IMG_RASTER_SCALE));
    canvas.height = Math.max(1, Math.round(lh * IMG_RASTER_SCALE));
    const c = canvas.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: await canvasToPng(canvas), ext: 'png', width: lw, height: lh };
}

// --- diagrams.js ---
// mermaidSvgCache lives inside chat_render.js and isn't reachable, so we first reuse an
// SVG the app has already rendered into the DOM, and only then ask mermaid itself.
function findRenderedDiagramSvg(code) {
    const want = String(code || '').trim();
    if (!want) return null;
    const boxes = document.querySelectorAll('.mermaid-box, .svg-box');
    for (const box of boxes) {
        const codeEl = box.querySelector('.mermaid-code-view pre code, .svg-code-view pre code');
        const svgEl = box.querySelector('.mermaid-rendered svg, .svg-rendered svg');
        if (!codeEl || !svgEl) continue;
        if (String(codeEl.textContent || '').trim() === want) return svgEl.outerHTML;
    }
    return null;
}

async function renderMermaidToSvg(code) {
    const cached = findRenderedDiagramSvg(code);
    if (cached) return cached;
    if (!window.mermaid) throw new Error('mermaid library not loaded');
    const id = 'docx-mmd-' + Math.random().toString(36).slice(2, 8);
    const sweep = () => {
        [id, 'd' + id].forEach(strayId => {
            const el = document.getElementById(strayId);
            if (el && el.parentElement === document.body) el.remove();
        });
    };
    try {
        // Light theme on purpose: the page it lands on is white.
        window.mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', fontFamily: 'inherit' });
        const raced = await Promise.race([
            window.mermaid.render(id, code),
            new Promise((_, rej) => setTimeout(() => rej(new Error('mermaid render timed out')), 8000))
        ]);
        sweep();
        if (!raced || !raced.svg) throw new Error('no SVG produced');
        return raced.svg;
    } catch (e) {
        sweep();
        throw e;
    }
}

// Mermaid / inline-SVG fences become pictures; if that fails they degrade to plain code
// blocks instead of vanishing.
async function convertDiagramBlocks(blocks) {
    for (let idx = 0; idx < blocks.length; idx++) {
        const b = blocks[idx];
        if (b.type !== 'code') continue;
        const lang = (b.lang || '').toLowerCase();
        const code = String(b.text || '').trim();
        if (!code) continue;
        let svg = null;
        try {
            if (lang === 'mermaid') svg = await renderMermaidToSvg(code);
            else if (lang === 'svg') svg = code;
            else continue;
        } catch (e) {
            console.warn('docx export: diagram render failed, keeping code block:', e);
            continue;
        }
        try {
            const img = await rasterizeSvgText(svg);
            // Per-block key, and a per-block src: two diagrams are never the same image, and
            // a non-URL src must never be handed to the workspace-path resolver later.
            img.key = 'diagram-' + idx;
            blocks[idx] = {
                type: 'paragraph',
                runs: [{ image: true, alt: lang === 'mermaid' ? 'diagram' : 'svg', src: '#' + lang + '-diagram-' + idx, resolved: img }],
                inQuote: b.inQuote
            };
        } catch (e) {
            console.warn('docx export: diagram rasterize failed, keeping code block:', e);
        }
    }
}

// --- media_pass.js ---
function eachRunsBlock(blocks, fn) {
    blocks.forEach(b => {
        if (b.runs) fn(b.runs);
        if (b.type === 'table') {
            (b.header || []).forEach(fn);
            (b.rows || []).forEach(row => (row || []).forEach(fn));
        }
    });
}

// De-duplicated so the same logo referenced 20 times is embedded once.
async function resolveImages(blocks, baseFile) {
    const bySrc = new Map();
    eachRunsBlock(blocks, runs => runs.forEach(run => {
        if (!run || !run.image || run.resolved) return;
        let holders = bySrc.get(run.src);
        if (!holders) { holders = []; bySrc.set(run.src, holders); }
        holders.push(run);
    }));
    const entries = Array.from(bySrc.entries());
    if (!entries.length) return { ok: 0, failed: 0 };
    let ok = 0, failed = 0;
    // Sequential on purpose: keeps peak memory down on image-heavy documents and avoids
    // hammering the workspace handle with parallel reads.
    for (const [src, runs] of entries) {
        try {
            const img = await resolveImageSource(src, baseFile);
            img.key = 'src-' + hashKey(src);
            runs.forEach(run => { run.resolved = img; });
            ok++;
        } catch (e) {
            failed++;
            console.warn('docx export: image unresolved', src, e);
            runs.forEach(run => { run.resolved = null; });
        }
    }
    return { ok, failed };
}

function hashKey(str) {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return Math.abs(h).toString(36);
}

// --- build_docx_blob.js ---
// Markdown text in, ready-to-download .docx Blob out.
async function buildDocxBlob(markdownText, opts) {
    const options = opts || {};
    const baseFile = options.filepath || '';
    const tplEntries = options.templateEntries || []; // [{ path, data: Uint8Array }]

    const tplCtx = parseTemplateContext(tplEntries);
    const blocks = parseMarkdown(markdownText);
    await convertDiagramBlocks(blocks);
    const mediaStats = await resolveImages(blocks, baseFile);

    const ctx = makePackageContext(tplCtx);
    const enc = new TextEncoder();
    const toEntry = (path, xml) => ({ path, data: enc.encode(xml) });

    // document.xml must be generated FIRST: it is what discovers the hyperlink rels, the
    // embedded media, and therefore which image extensions [Content_Types].xml has to declare.
    const documentXml = buildDocumentXml(blocks, ctx);

    const entries = [];
    const tplPaths = new Set(tplEntries.map(e => e.path));
    let tplContentTypes = null, tplDocRels = null, tplNumbering = null;

    // Carry over template files (styles, themes, fonts, settings, etc.)
    tplEntries.forEach(entry => {
        if (entry.path === '[Content_Types].xml') { tplContentTypes = new TextDecoder('utf-8', { fatal: false }).decode(entry.data); return; }
        if (entry.path === 'word/_rels/document.xml.rels') { tplDocRels = new TextDecoder('utf-8', { fatal: false }).decode(entry.data); return; }
        if (entry.path === 'word/numbering.xml') { tplNumbering = new TextDecoder('utf-8', { fatal: false }).decode(entry.data); return; }
        if (entry.path === 'word/document.xml') return; // We always overwrite the core document
        entries.push(entry);
    });

    // Inject missing mandatory files if the template didn't provide them
    if (!tplPaths.has('_rels/.rels')) entries.push(toEntry('_rels/.rels', buildPackageRelsXml()));
    if (!tplPaths.has('word/styles.xml')) entries.push(toEntry('word/styles.xml', buildStylesXml()));

    // Numbering merge: combine template's lists with our dynamic Markdown lists
    if (!tplPaths.has('word/numbering.xml')) {
        entries.push(toEntry('word/numbering.xml', buildNumberingXml(ctx.orderedLists)));
    } else if (tplNumbering) {
        entries.push(toEntry('word/numbering.xml', mergeNumberingXml(tplNumbering, ctx.orderedLists)));
    }

    // Core outputs: Document, modified ContentTypes, and appended Relationships
    entries.push(toEntry('word/document.xml', documentXml));
    entries.push(toEntry('word/_rels/document.xml.rels', mergeDocumentRelsXml(tplDocRels, ctx.rels)));
    entries.push(toEntry('[Content_Types].xml', mergeContentTypesXml(tplContentTypes, Array.from(ctx.exts))));

    ctx.media.forEach(m => entries.push({ path: m.path, data: m.data }));

    if (typeof window.buildZip !== 'function') throw new Error('ZIP builder unavailable');
    // buildZip() types the Blob as application/zip; Word wants the OPC media type.
    const zip = window.buildZip(entries);
    const blob = new Blob([zip], { type: DOCX_MIME });
    blob._docxStats = {
        images: ctx.media.length,
        imagesFailed: mediaStats ? mediaStats.failed : 0,
        orderedLists: ctx.orderedLists
    };
    return blob;
}

function docxFileName(filepath) {
    const base = String(filepath || 'document').split('/').filter(Boolean).pop() || 'document';
    return base.replace(/\.(md|markdown|mdown|mkd)$/i, '') + '.docx';
}

// --- get_markdown_source.js ---
// Prefer the live Monaco buffer so unsaved edits end up in the export.
async function getMarkdownSource(filepath) {
    try {
        if (typeof monacoModels !== 'undefined' && monacoModels && monacoModels.has && monacoModels.has(filepath)) {
            const model = monacoModels.get(filepath);
            if (model && typeof model.getValue === 'function') return model.getValue();
        }
    } catch (e) {}
    if (typeof window.readFileContent === 'function') return await window.readFileContent(filepath);
    return '';
}

// --- export_markdown_to_docx.js ---
let exportInFlight = false;

function setExportBusy(busy) {
    const btn = document.getElementById('doc-action-export-docx');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('busy', !!busy);
    btn.style.opacity = busy ? '0.6' : '';
    const icon = btn.querySelector('.icon');
    if (icon) {
        icon.textContent = busy ? 'sync' : 'download';
        icon.style.animation = busy ? 'spin 0.9s linear infinite' : '';
    }
}

async function exportMarkdownToDocx(filepath, templateFilepath = null) {
    if (!filepath) return false;
    if (exportInFlight) {
        if (typeof window.showToast === 'function') window.showToast('An export is already running…', 'info');
        return false;
    }
    exportInFlight = true;
    setExportBusy(true);
    try {
        const markdown = await getMarkdownSource(filepath);
        if (!markdown || !markdown.trim()) {
            if (typeof window.showToast === 'function') window.showToast(`${filepath} is empty — nothing to export`, 'error');
            return false;
        }

        let templateEntries = [];
        // Hook for caller to inject a template ZIP. Requires an unzipping utility in the environment.
        if (templateFilepath && typeof window.vfsReadBlob === 'function' && typeof window.readZip === 'function') {
            const tplBlob = await window.vfsReadBlob(templateFilepath);
            if (tplBlob) templateEntries = await window.readZip(tplBlob); // Expected format: [{ path, data: Uint8Array }]
        }

        const blob = await buildDocxBlob(markdown, { filepath, templateEntries });
        const name = docxFileName(filepath);
        if (typeof window.triggerDownload !== 'function') throw new Error('download helper unavailable');
        window.triggerDownload(blob, name);
        if (typeof window.showToast === 'function') {
            const stats = blob._docxStats;
            const warn = stats && stats.imagesFailed ? ` (${stats.imagesFailed} image${stats.imagesFailed === 1 ? '' : 's'} skipped)` : '';
            window.showToast(`Exported ${name}${warn}`, warn ? 'info' : 'success');
        }
        return true;
    } catch (e) {
        console.error('docx export failed:', e);
        if (typeof window.showToast === 'function') {
            window.showToast('Export failed: ' + ((e && e.message) || e), 'error');
        }
        return false;
    } finally {
        exportInFlight = false;
        setExportBusy(false);
    }
}

// --- document_bar_action.js ---
// Only Markdown gets the button; the renderer lookup already covers both Edit and
// Render views, and falls back to the extension for robustness.
function docxActionApplies(ctx) {
    if (!ctx || ctx.kind !== 'text' || !ctx.filepath) return false;
    if (ctx.renderer && ctx.renderer.id === 'markdown') return true;
    return /\.(md|markdown|mdown|mkd)$/i.test(ctx.filepath);
}

let docActionRegistered = false;
function registerDocxDocumentAction() {
    if (docActionRegistered) return true;
    if (typeof window.registerDocumentAction !== 'function') return false;
    window.registerDocumentAction({
        id: 'export-docx',
        label: 'Export .docx',
        icon: 'download',
        title: 'Export Markdown as Word document (.docx)',
        appliesTo: docxActionApplies,
        onClick: (ctx) => { exportMarkdownToDocx(ctx.filepath); }
    });
    docActionRegistered = true;
    return true;
}

// ui_layout.js is imported just before this module in normal load order, but a late
// registration is cheap insurance against import-order changes.
if (!registerDocxDocumentAction()) {
    document.addEventListener('DOMContentLoaded', registerDocxDocumentAction);
    setTimeout(registerDocxDocumentAction, 0);
}

// --- AST_EXPORTS_START ---
window.DOCX_MIME = DOCX_MIME;
window.parseMarkdown = parseMarkdown;
window.tokenizeInline = tokenizeInline;
window.buildDocxBlob = buildDocxBlob;
window.exportMarkdownToDocx = exportMarkdownToDocx;
window.docxFileName = docxFileName;
window.registerDocxDocumentAction = registerDocxDocumentAction;
// --- AST_EXPORTS_END ---