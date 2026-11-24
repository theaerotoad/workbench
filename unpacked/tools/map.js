// map - tool definition.
const TOOL_META = {
    name: "map",
    description: "Outline code structure with Tree-sitter: classes, functions with signatures, nesting, and exact start-end lines, for a file or a whole directory. Much cheaper than reading files. Also outlines Markdown headings, JSON/YAML keys, CSS rules, and HTML ids plus inline script/style blocks. Pass `symbol` (\"name\" or \"Class.method\"; substring fallback) to locate definitions anywhere under `path` and get line ranges for `read`. Large results degrade to top-level/summary detail and page via `offset`. The output always states what was skipped.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Directory or single file path to map (e.g., 'src', 'src/app.py', or '' / '.' for workspace root). Defaults to root.",
                allowEmpty: true
            },
            symbol: {
                type: "string",
                description: "Optional symbol name (or 'Class.method'; substring fallback) to locate definitions anywhere under `path` with start-end line ranges ready for `read`."
            },
            extensions: {
                type: "array",
                items: { type: "string" },
                description: "File extensions to include (e.g., ['.js', '.py']). Defaults to all supported languages."
            },
            format: {
                type: "string",
                enum: ["text", "json"],
                description: "text (default): compact, best for reading. json: structured object, for scripting."
            },
            detail: {
                type: "string",
                enum: ["auto", "full", "top", "summary"],
                description: "Outline detail level. auto (default) degrades full -> top -> summary to fit maxOutputChars. Explicit values skip stepping and page via offset if needed."
            },
            offset: {
                type: "number",
                description: "0-based starting file index into the sorted file list for paging large outlines."
            }
        },
        required: []
    },
    modes: ["plan", "ask", "code"],
    permission: "always",
    toolBox: 1,
    settings: [
        {
            key: "maxOutputChars",
            label: "Max Output Characters",
            type: "number",
            default: 24000,
            min: 4000,
            max: 200000,
            description: "Output character budget for outline mode before degrading detail or paging."
        },
        {
            key: "maxFileBytes",
            label: "Max File Size (bytes)",
            type: "number",
            default: 524288,
            min: 4096,
            max: 10485760,
            description: "Skip files larger than this byte limit (default 512 KB)."
        },
        {
            key: "maxFiles",
            label: "Max Files Ceiling",
            type: "number",
            default: 1000,
            min: 1,
            max: 5000,
            description: "Hard safety ceiling on files parsed per call."
        }
    ]
};

// --- Pinned Runtime & Grammar Versions --------------------------------------
// web-tree-sitter@0.25.10 supports ABI 13-15 and remains compatible with both
// tree-sitter-wasms@0.1.13 (ABI 13/14) and @lumis-sh/wasm-* (ABI 15).
const TS_RUNTIME_VERSION = '0.25.10';
const TS_GRAMMARS_VERSION = '0.1.13';
const TS_RUNTIME_BASE_URL = `https://cdn.jsdelivr.net/npm/web-tree-sitter@${TS_RUNTIME_VERSION}`;
const TS_GRAMMARS_BASE_URL = `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${TS_GRAMMARS_VERSION}/out`;
// Each @lumis-sh/wasm-* package is published with its own independent patch version.
const TS_LUMIS_GRAMMARS = {
    fortran: 'https://cdn.jsdelivr.net/npm/@lumis-sh/wasm-fortran@0.26.0/tree-sitter-fortran.wasm',
    matlab: 'https://cdn.jsdelivr.net/npm/@lumis-sh/wasm-matlab@0.26.7/tree-sitter-matlab.wasm',
    julia: 'https://cdn.jsdelivr.net/npm/@lumis-sh/wasm-julia@0.26.3/tree-sitter-julia.wasm'
};
const JSYAML_URL = 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js';

const DEFAULT_MAX_OUTPUT_CHARS = 24000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 1000;
const MAX_SYMBOL_MATCHES = 50;
const MAX_SYMBOL_SCAN_BYTES = 50 * 1024 * 1024;
const WALL_CLOCK_BUDGET_MS = 20000;
const READ_CONCURRENCY = 8;
const UI_THROTTLE_MS = 150;

// --- Grammar Mappings -------------------------------------------------------
const EXT_TO_LANG = {
    '.py': 'python',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'c_sharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.css': 'css',
    '.html': 'html',
    '.f': 'fortran',
    '.f90': 'fortran',
    '.m': 'matlab',
    '.jl': 'julia'
};

const NON_AST_EXTS = {
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.txt': 'text'
};

const LANGUAGE_QUERIES = {
    python: `
        (class_definition name: (identifier) @class.name)
        (function_definition name: (identifier) @fn.name parameters: (parameters)? @fn.params) @fn.def
    `,
    css: `
        (rule_set (selectors) @css.selector)
        (media_statement) @css.media_stmt
    `,
    html: `
        (element
            (start_tag
                (tag_name) @html.tag
                (attribute
                    (attribute_name) @attr.name (#eq? @attr.name "id")
                    [(quoted_attribute_value) (attribute_value)] @attr.value))) @html.element
        (element
            (self_closing_tag
                (tag_name) @html.tag
                (attribute
                    (attribute_name) @attr.name (#eq? @attr.name "id")
                    [(quoted_attribute_value) (attribute_value)] @attr.value))) @html.element
        (script_element) @html.script
        (style_element) @html.style
    `,
    fortran: `
        (module_statement (name) @class.name)
        (subroutine_statement (name) @fn.name)
        (function_statement (name) @fn.name)
    `,
    matlab: `
        (class_definition name: (identifier) @class.name)
        (function_definition name: (identifier) @fn.name (function_arguments)? @fn.params)
    `,
    julia: `
        (module_definition name: (identifier) @class.name)
        (struct_definition (type_head (identifier) @class.name))
        (function_definition (signature (call_expression (identifier) @fn.name)))
        (macro_definition (signature (call_expression (identifier) @fn.name)))
    `
};

const HTML_VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const languageCache = (globalThis.__mapLanguageCache ||= {});
const queryCache = (globalThis.__mapQueryCache ||= {});

// --- UI & Formatting Helpers ------------------------------------------------
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&' + 'amp;',
        '<': '&' + 'lt;',
        '>': '&' + 'gt;',
        '"': '&' + 'quot;',
        "'": '&' + '#39;'
    }[c]));
}

function pathHtml(fp) {
    const parts = String(fp || '').split('/');
    const name = parts.pop() || fp;
    const dir = parts.length ? parts.join('/') + '/' : '';
    return `<span class="tool-ui-path-dir">${esc(dir)}</span><span class="tool-ui-path-name" style="color:var(--primary); font-weight:600;">${esc(name)}</span>`;
}

function formatByteSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}

function formatLineRange(s) {
    return (s.end_ln && s.end_ln > s.ln) ? `${s.ln}-${s.end_ln}` : `${s.ln}`;
}

function dirOfPath(fp) {
    const idx = fp.lastIndexOf('/');
    return idx === -1 ? '' : fp.slice(0, idx + 1);
}

// Deterministic directory-grouped lexicographical sort so files in the same
// directory stay contiguous (required for gap-free directory paging in summary mode).
function sortPaths(paths) {
    return [...paths].sort((a, b) => {
        const da = dirOfPath(a);
        const db = dirOfPath(b);
        if (da !== db) return da < db ? -1 : 1;
        return a < b ? -1 : (a > b ? 1 : 0);
    });
}

function getFileExt(fp) {
    const extMatch = String(fp || '').match(/\.[0-9a-z_]+$/i);
    return extMatch ? extMatch[0].toLowerCase() : '';
}

function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(str).length;
    }
    return str.length;
}

// --- Pure Symbol Helpers ----------------------------------------------------
function symbolPrefilter(query) {
    const segments = String(query || '')
        .toLowerCase()
        .split('.')
        .map(s => s.trim())
        .filter(s => s && s !== '(iife)' && s !== '(amd)');
    if (segments.length === 0) return () => true;
    return (text) => {
        const lower = String(text || '').toLowerCase();
        for (let i = 0; i < segments.length; i++) {
            if (lower.indexOf(segments[i]) === -1) return false;
        }
        return true;
    };
}

function flattenSymbols(syms, file, parentName = '') {
    const out = [];
    for (const s of syms || []) {
        const qname = parentName ? `${parentName}.${s.name}` : s.name;
        const entry = {
            file,
            kind: s.kind,
            name: s.name,
            qualified_name: qname,
            start_line: s.ln,
            end_line: s.end_ln || s.ln
        };
        if (s.params) entry.params = s.params;
        if (s.async) entry.async = true;
        if (s.export) entry.export = true;
        out.push(entry);
        if (s.members && s.members.length) {
            out.push(...flattenSymbols(s.members, file, qname));
        }
    }
    return out;
}

function matchSymbols(flatSymbols, query, maxMatches = MAX_SYMBOL_MATCHES) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { matches: [], total: 0, exact: true };
    const hasDot = q.includes('.');
    let exact = true;
    let matched = flatSymbols.filter(s => {
        const nameL = s.name.toLowerCase();
        const qnameL = s.qualified_name.toLowerCase();
        return hasDot ? (qnameL === q || qnameL.endsWith('.' + q)) : nameL === q;
    });
    if (matched.length === 0) {
        exact = false;
        matched = flatSymbols.filter(s =>
            s.name.toLowerCase().includes(q) || s.qualified_name.toLowerCase().includes(q)
        );
    }
    return {
        matches: matched.slice(0, maxMatches),
        total: matched.length,
        exact
    };
}

// --- Non-AST Summarizers ----------------------------------------------------
function truncateLines(lines, limit = 20) {
    if (lines.length <= limit) return lines.join('\n');
    return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
}

function summarizeText(content) {
    return truncateLines(content.split('\n'));
}

function firstNonEmptyLine(content) {
    const lines = content.split('\n');
    for (const line of lines) {
        const t = line.trim();
        if (t) return t.length > 100 ? t.slice(0, 97) + '...' : t;
    }
    return '(empty)';
}

function parseMarkdownHeadings(content) {
    const lines = content.split('\n');
    const headings = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;

    const lastLineNo = (lines.length > 1 && lines[lines.length - 1] === '')
        ? lines.length - 1
        : lines.length;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const openMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (openMatch) {
            const seq = openMatch[1];
            if (!inFence) {
                inFence = true;
                fenceChar = seq[0];
                fenceLen = seq.length;
                continue;
            }
            const closeMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
            if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
                inFence = false;
                fenceChar = '';
                fenceLen = 0;
                continue;
            }
        }
        if (inFence) continue;

        const hm = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
        if (hm) {
            headings.push({
                level: hm[1].length,
                prefix: hm[1],
                text: hm[2].trim(),
                ln: i + 1,
                end_ln: lastLineNo
            });
        }
    }

    for (let i = 0; i < headings.length; i++) {
        for (let j = i + 1; j < headings.length; j++) {
            if (headings[j].level <= headings[i].level) {
                headings[i].end_ln = Math.max(headings[i].ln, headings[j].ln - 1);
                break;
            }
        }
    }

    return headings;
}

function summarizeMarkdown(content) {
    const headings = parseMarkdownHeadings(content);
    if (!headings.length) return summarizeText(content);
    const formatted = headings.map(h => {
        const range = h.end_ln > h.ln ? `${h.ln}-${h.end_ln}` : `${h.ln}`;
        return `${h.prefix} ${h.text} :${range}`;
    });
    return truncateLines(formatted, 40);
}

function findJsonTopLevelKeyLines(content) {
    const map = Object.create(null);
    let depth = 0;
    let line = 1;
    let inStr = false;
    let escaped = false;
    let strStart = -1;
    let strLine = 1;
    let lastStr = null;
    let lastStrLine = 1;
    let expectKey = false;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (ch === '\n') line++;
        if (inStr) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inStr = false;
                if (depth === 1 && expectKey) {
                    try {
                        lastStr = JSON.parse(content.slice(strStart, i + 1));
                    } catch (_) {
                        lastStr = content.slice(strStart + 1, i);
                    }
                    lastStrLine = strLine;
                }
            }
            continue;
        }
        if (ch === '"') {
            inStr = true;
            strStart = i;
            strLine = line;
        } else if (ch === '{') {
            depth++;
            if (depth === 1) expectKey = true;
        } else if (ch === '}') {
            depth--;
            if (depth === 1) expectKey = false;
        } else if (ch === '[') {
            depth++;
        } else if (ch === ']') {
            depth--;
        } else if (ch === ':' && depth === 1 && lastStr !== null) {
            if (map[lastStr] === undefined) map[lastStr] = lastStrLine;
            lastStr = null;
            expectKey = false;
        } else if (ch === ',' && depth === 1) {
            expectKey = true;
            lastStr = null;
        }
    }
    return map;
}

function findYamlTopLevelKeyLines(content) {
    const map = Object.create(null);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(['"]?)([^:#\s][^:#]*?)\1\s*:(?:\s|$)/);
        if (m) {
            const key = m[2].trim();
            if (key && map[key] === undefined) map[key] = i + 1;
        }
    }
    return map;
}

function summarizeStructuredData(data, keyLines = null) {
    const lines = [];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
            const lnSuffix = (keyLines && keyLines[k]) ? ` :${keyLines[k]}` : '';
            if (v && typeof v === 'object') {
                const typeName = Array.isArray(v) ? 'List' : 'Dict';
                const len = Array.isArray(v) ? v.length : Object.keys(v).length;
                lines.push(`"${k}": <${typeName} len=${len}>${lnSuffix}`);
            } else {
                let valStr = String(v);
                if (valStr.length > 50) valStr = valStr.slice(0, 47) + "...";
                lines.push(`"${k}": ${valStr}${lnSuffix}`);
            }
        }
    } else if (Array.isArray(data)) {
        lines.push(`List with ${data.length} items:`);
        for (let i = 0; i < Math.min(data.length, 20); i++) {
            const item = data[i];
            const typeName = Array.isArray(item) ? 'Array' : (item === null ? 'null' : typeof item);
            lines.push(`  [${i}]: ${typeName}`);
        }
    } else {
        return "(Unknown structure)";
    }
    return truncateLines(lines);
}

function summarizeJson(content) {
    try {
        const data = JSON.parse(content);
        if (!data || typeof data !== 'object') return summarizeText(content);
        const keyLines = Array.isArray(data) ? null : findJsonTopLevelKeyLines(content);
        return summarizeStructuredData(data, keyLines);
    } catch (_) {
        return "(Invalid JSON) " + summarizeText(content);
    }
}

async function summarizeYaml(content) {
    try {
        if (typeof globalThis.jsyaml === 'undefined') {
            let initPromise = globalThis.__mapJsYamlInit;
            if (!initPromise) {
                initPromise = (async () => {
                    if (typeof importScripts === 'function') {
                        importScripts(JSYAML_URL);
                    } else {
                        const scriptRes = await fetch(JSYAML_URL);
                        const scriptText = await scriptRes.text();
                        (new Function(scriptText))();
                    }
                })();
                globalThis.__mapJsYamlInit = initPromise;
            }
            try {
                await initPromise;
            } catch (err) {
                if (globalThis.__mapJsYamlInit === initPromise) globalThis.__mapJsYamlInit = null;
                throw err;
            }
        }
        const data = globalThis.jsyaml.load(content);
        if (!data || typeof data !== 'object') return summarizeText(content);
        const keyLines = Array.isArray(data) ? null : findYamlTopLevelKeyLines(content);
        return summarizeStructuredData(data, keyLines);
    } catch (_) {
        return "(YAML Error) " + summarizeText(content);
    }
}

// --- Lightweight HTML Fallback Scanner --------------------------------------
function buildLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function offsetToLine(lineStarts, offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) lo = mid + 1;
        else hi = mid - 1;
    }
    return Math.max(1, hi + 1);
}

function htmlFallbackOutline(content) {
    const src = String(content || '');
    const lineStarts = buildLineStarts(src);
    const rootSyms = [];
    const stack = []; // { tag, sym }

    function attachSym(sym) {
        for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].sym) {
                if (!stack[k].sym.members) stack[k].sym.members = [];
                stack[k].sym.members.push(sym);
                return;
            }
        }
        rootSyms.push(sym);
    }

    let i = 0;
    const n = src.length;
    while (i < n) {
        const lt = src.indexOf('<', i);
        if (lt === -1) break;

        // Skip HTML comments
        if (src.startsWith('<!--', lt)) {
            const endComment = src.indexOf('-->', lt + 4);
            i = endComment === -1 ? n : endComment + 3;
            continue;
        }
        // Skip doctype / processing instructions / CDATA
        if (src.startsWith('<![CDATA[', lt)) {
            const endCd = src.indexOf(']]>', lt + 9);
            i = endCd === -1 ? n : endCd + 3;
            continue;
        }
        const nextCh = src[lt + 1];
        if (nextCh === '!' || nextCh === '?') {
            const gt = src.indexOf('>', lt + 2);
            i = gt === -1 ? n : gt + 1;
            continue;
        }

        // Closing tag
        if (nextCh === '/') {
            const closeMatch = src.slice(lt + 2, lt + 100).match(/^([a-zA-Z][a-zA-Z0-9:-]*)\s*>/);
            if (!closeMatch) {
                i = lt + 2;
                continue;
            }
            const closeTag = closeMatch[1].toLowerCase();
            const closeLine = offsetToLine(lineStarts, lt);
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k].tag === closeTag) {
                    if (stack[k].sym) stack[k].sym.end_ln = closeLine;
                    stack.length = k;
                    break;
                }
            }
            i = lt + 2 + closeMatch[0].length;
            continue;
        }

        // Opening tag: scan to matching unquoted '>'
        const nameMatch = src.slice(lt + 1, lt + 100).match(/^([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>]|$)/);
        if (!nameMatch) {
            i = lt + 1;
            continue;
        }
        const tag = nameMatch[1].toLowerCase();
        let j = lt + 1 + nameMatch[1].length;
        let quote = '';
        while (j < n) {
            const ch = src[j];
            if (quote) {
                if (ch === quote) quote = '';
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === '>') {
                break;
            }
            j++;
        }
        if (j >= n) break;

        const attrText = src.slice(lt + 1 + nameMatch[1].length, j);
        const selfClosing = /\/\s*$/.test(attrText) || HTML_VOID_TAGS.has(tag);
        const startLine = offsetToLine(lineStarts, lt);

        const idMatch = attrText.match(/(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/]+))/i);
        const idVal = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? '').trim() : '';

        // Raw-text blocks: script & style
        if ((tag === 'script' || tag === 'style') && !selfClosing) {
            const closePattern = new RegExp('<' + '/' + tag + '\\s*>', 'i');
            const rest = src.slice(j + 1);
            const cm = closePattern.exec(rest);
            const endOffset = cm ? (j + 1 + cm.index) : (n - 1);
            const endLine = offsetToLine(lineStarts, endOffset);
            const sym = {
                kind: 'tag',
                name: idVal ? `${tag}#${idVal}` : tag,
                ln: startLine,
                end_ln: endLine
            };
            attachSym(sym);
            i = cm ? (j + 1 + cm.index + cm[0].length) : n;
            continue;
        }

        let sym = null;
        if (idVal) {
            sym = {
                kind: 'tag',
                name: `${tag}#${idVal}`,
                ln: startLine,
                end_ln: startLine
            };
            attachSym(sym);
        }

        if (!selfClosing) {
            stack.push({ tag, sym });
        }

        i = j + 1;
    }

    return rootSyms;
}

// --- IIFE / Module-Wrapper Detection (Pure AST Helpers) ---------------------
function unwrapParens(node) {
    let cur = node;
    while (cur && cur.type === 'parenthesized_expression') {
        const next = (cur.namedChildren && cur.namedChildren[0]) || cur.child(1);
        if (!next || next === cur) break;
        cur = next;
    }
    return cur;
}

function getIifeInfo(stmtNode) {
    if (!stmtNode || stmtNode.type !== 'expression_statement') return null;
    let expr = (stmtNode.namedChildren && stmtNode.namedChildren[0]) || stmtNode.child(0);
    expr = unwrapParens(expr);
    if (!expr) return null;

    if (expr.type === 'unary_expression') {
        const arg = (typeof expr.childForFieldName === 'function' && expr.childForFieldName('argument'))
            || (expr.namedChildren && expr.namedChildren[0]);
        expr = unwrapParens(arg);
    }
    if (!expr || expr.type !== 'call_expression') return null;

    const calleeRaw = (typeof expr.childForFieldName === 'function' && expr.childForFieldName('function'))
        || (expr.namedChildren && expr.namedChildren[0]);
    const callee = unwrapParens(calleeRaw);
    if (!callee) return null;

    let fnNode = null;
    let wrapperName = '(iife)';

    if (callee.type === 'function_expression' || callee.type === 'function' || callee.type === 'arrow_function') {
        fnNode = callee;
    } else if (callee.type === 'member_expression') {
        const prop = typeof callee.childForFieldName === 'function' ? callee.childForFieldName('property') : null;
        const obj = unwrapParens(typeof callee.childForFieldName === 'function' ? callee.childForFieldName('object') : null);
        if (prop && (prop.text === 'call' || prop.text === 'apply') && obj &&
            (obj.type === 'function_expression' || obj.type === 'function' || obj.type === 'arrow_function')) {
            fnNode = obj;
        }
    } else if (callee.type === 'identifier' && callee.text === 'define') {
        const argsNode = typeof expr.childForFieldName === 'function' ? expr.childForFieldName('arguments') : null;
        if (argsNode && argsNode.namedChildren) {
            for (const a of argsNode.namedChildren) {
                const u = unwrapParens(a);
                if (u && (u.type === 'function_expression' || u.type === 'function' || u.type === 'arrow_function')) {
                    fnNode = u;
                    wrapperName = '(amd)';
                    break;
                }
            }
        }
    }

    if (!fnNode) return null;
    const body = (typeof fnNode.childForFieldName === 'function' && fnNode.childForFieldName('body'))
        || (fnNode.namedChildren && fnNode.namedChildren.find(c => c.type === 'statement_block'));
    if (!body || body.type !== 'statement_block') return null;

    return {
        name: wrapperName,
        body,
        ln: stmtNode.startPosition.row + 1,
        end_ln: stmtNode.endPosition.row + 1
    };
}

// --- Tree-sitter Runtime, Grammar & Query Caching ---------------------------
function cleanErrMsg(err) {
    const raw = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
    return String(raw || 'unknown error').replace(/\s+/g, ' ').trim();
}

async function ensureTreeSitter(api, progress) {
    if (globalThis.__mapTreeSitterRuntime && globalThis.__mapTreeSitterVersion === TS_RUNTIME_VERSION) {
        return globalThis.__mapTreeSitterRuntime;
    }

    if (progress) {
        await progress.update(
            "Downloading Tree-sitter runtime...",
            `<div class="tool-ui-wrap" style="padding: 12px; display:flex; align-items:center; gap:8px;">
                <div class="running-tool-spinner"></div>
                <span style="color:var(--dim); font-size:12px;">Booting Tree-sitter WebAssembly (${TS_RUNTIME_VERSION})...</span>
            </div>`,
            true
        );
    }

    let initPromise = globalThis.__mapTreeSitterInit;
    if (!initPromise || globalThis.__mapTreeSitterInitVersion !== TS_RUNTIME_VERSION) {
        globalThis.__mapTreeSitterInitVersion = TS_RUNTIME_VERSION;
        initPromise = (async () => {
            const jsUrl = `${TS_RUNTIME_BASE_URL}/tree-sitter.js`;
            let Parser = null;
            let Language = null;
            let Query = null;

            // web-tree-sitter@0.25+ ships ESM (named exports { Parser, Language, Query }).
            const mod = await import(jsUrl);
            Parser = mod.Parser || mod.default || (mod.TreeSitter && mod.TreeSitter.Parser) || globalThis.TreeSitter;
            Language = mod.Language || (Parser && Parser.Language);
            Query = mod.Query || (Parser && Parser.Query) || null;

            if (!Parser || typeof Parser.init !== 'function') {
                throw new Error(`Unexpected web-tree-sitter@${TS_RUNTIME_VERSION} module shape`);
            }

            await Parser.init({
                locateFile: (scriptName) => {
                    if (scriptName === 'tree-sitter.wasm' || scriptName === 'web-tree-sitter.wasm') {
                        return `${TS_RUNTIME_BASE_URL}/${scriptName}`;
                    }
                    return `${TS_RUNTIME_BASE_URL}/${scriptName}`;
                }
            });

            const runtime = { Parser, Language, Query, version: TS_RUNTIME_VERSION };
            // Clear any cached grammars/queries if runtime version changed in a reused worker
            for (const k of Object.keys(languageCache)) delete languageCache[k];
            for (const k of Object.keys(queryCache)) {
                try { queryCache[k]?.query?.delete(); } catch (_) {}
                delete queryCache[k];
            }
            globalThis.__mapTreeSitterRuntime = runtime;
            globalThis.__mapTreeSitterVersion = TS_RUNTIME_VERSION;
            return runtime;
        })();
        globalThis.__mapTreeSitterInit = initPromise;
    }

    try {
        return await initPromise;
    } catch (err) {
        if (globalThis.__mapTreeSitterInit === initPromise) globalThis.__mapTreeSitterInit = null;
        throw err;
    }
}

function getGrammarUrl(langName) {
    if (TS_LUMIS_GRAMMARS[langName]) return TS_LUMIS_GRAMMARS[langName];
    return `${TS_GRAMMARS_BASE_URL}/tree-sitter-${langName}.wasm`;
}

function enqueueGrammarLink(fn) {
    const prev = globalThis.__mapGrammarLinkQueue || Promise.resolve();
    const next = prev.then(fn, fn);
    globalThis.__mapGrammarLinkQueue = next.catch(() => {});
    return next;
}

async function loadGrammar(runtime, langName) {
    let langPromise = languageCache[langName];
    if (!langPromise) {
        const url = getGrammarUrl(langName);
        langPromise = (async () => {
            // Download WASM bytes concurrently across languages, but serialize
            // Language.load(bytes) to prevent Emscripten dynamic-linker races
            // across parallel calls or parallel grammar preloads.
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`Language.load failed with status ${res.status} (${url})`);
            }
            const bytes = new Uint8Array(await res.arrayBuffer());
            return await enqueueGrammarLink(() => runtime.Language.load(bytes));
        })();
        languageCache[langName] = langPromise;
    }
    try {
        return await langPromise;
    } catch (err) {
        if (languageCache[langName] === langPromise) delete languageCache[langName];
        throw err;
    }
}

function getCompiledQuery(runtime, langName, lang) {
    const queryStr = LANGUAGE_QUERIES[langName];
    if (!queryStr) return null;

    const cached = queryCache[langName];
    if (cached && cached.lang === lang && cached.queryStr === queryStr) {
        return cached;
    }
    if (cached && cached.query) {
        try { cached.query.delete(); } catch (_) {}
    }

    try {
        const query = runtime.Query ? new runtime.Query(lang, queryStr) : lang.query(queryStr);
        const entry = { lang, queryStr, query, error: null };
        queryCache[langName] = entry;
        return entry;
    } catch (err) {
        const entry = { lang, queryStr, query: null, error: cleanErrMsg(err) };
        queryCache[langName] = entry;
        return entry;
    }
}

// --- AST Extraction ---------------------------------------------------------
function collectImportsAndExports(rootNode, imports, exportedNames) {
    function scanStatements(container, recurseIife) {
        for (let i = 0; i < container.childCount; i++) {
            const child = container.child(i);
            if (child.type === 'import_statement') {
                child.children.forEach(c => {
                    if (c.type === 'dotted_name') imports.add(c.text);
                    else if (c.type === 'aliased_import') {
                        const dn = c.children.find(cc => cc.type === 'dotted_name');
                        if (dn) imports.add(dn.text);
                    }
                });
            } else if (child.type === 'import_from_statement') {
                const nameNode = child.childForFieldName('module_name');
                if (nameNode) imports.add(nameNode.text);
            } else if (
                child.type.includes('import') ||
                child.type.includes('use_declaration') ||
                (child.type === 'expression_statement' && child.text.includes('require('))
            ) {
                const match = child.text.match(/['"]([^'"]+)['"]/);
                if (match) imports.add(match[1]);
            }

            if (child.type === 'expression_statement') {
                const expr = child.child(0);
                if (expr && expr.type === 'assignment_expression') {
                    const left = expr.childForFieldName('left');
                    if (left && left.type === 'member_expression') {
                        const obj = left.childForFieldName('object');
                        const prop = left.childForFieldName('property');
                        if (obj && obj.text === 'window' && prop) {
                            exportedNames.add(prop.text);
                        }
                    }
                }
                if (recurseIife) {
                    const iife = getIifeInfo(child);
                    if (iife) scanStatements(iife.body, false);
                }
            }
        }
    }
    scanStatements(rootNode, true);
}

function extractDeclaratorFuncInfo(node) {
    let decl = typeof node.childForFieldName === 'function' ? node.childForFieldName('declarator') : null;
    let guard = 0;
    let paramNode = null;
    while (decl && guard++ < 12) {
        if (decl.type === 'function_declarator') {
            if (!paramNode) {
                paramNode = (typeof decl.childForFieldName === 'function' && decl.childForFieldName('parameters'))
                    || decl.children.find(c => c.type === 'parameter_list');
            }
            decl = (typeof decl.childForFieldName === 'function' && decl.childForFieldName('declarator'))
                || decl.children.find(c =>
                    c.type === 'identifier' || c.type === 'field_identifier' ||
                    c.type === 'qualified_identifier' || c.type === 'destructor_name' ||
                    c.type === 'operator_name'
                );
            continue;
        }
        if (
            decl.type === 'identifier' ||
            decl.type === 'field_identifier' ||
            decl.type === 'qualified_identifier' ||
            decl.type === 'destructor_name' ||
            decl.type === 'operator_name'
        ) {
            return { name: decl.text, paramNode };
        }
        const inner = (typeof decl.childForFieldName === 'function' && decl.childForFieldName('declarator'))
            || decl.children.find(c => c.type.includes('declarator'));
        if (!inner || inner === decl) break;
        decl = inner;
    }
    return { name: null, paramNode };
}

function extractSymbolsImperative(rootNode, exportedNames) {
    function extractSymbol(node) {
        if (node.type.includes('comment') || node.type.includes('string')) return null;

        let isExp = node.parent && node.parent.type.includes('export');

        if (
            node.type.includes('class') ||
            node.type.includes('struct') ||
            node.type.includes('interface') ||
            node.type.includes('trait')
        ) {
            const nameNode = node.childForFieldName('name')
                || node.children.find(c => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'constant');
            if (nameNode) {
                if (exportedNames.has(nameNode.text)) isExp = true;
                const res = {
                    kind: 'class',
                    name: nameNode.text,
                    ln: nameNode.startPosition.row + 1,
                    end_ln: node.endPosition.row + 1
                };
                if (isExp) res.export = true;
                return res;
            }
        }

        let isFunc = (node.type.includes('function') && node.type !== 'arrow_function' && node.type !== 'function_declarator') || node.type.includes('method');
        let assignedName = null;
        let isVar = false;
        let declToken = 'var';

        if (!isFunc && (node.type === 'variable_declaration' || node.type === 'lexical_declaration')) {
            declToken = node.child(0) ? node.child(0).text : 'var';
            if (!['const', 'let', 'var'].includes(declToken)) declToken = 'var';

            const decl = node.children.find(c => c.type === 'variable_declarator');
            if (decl) {
                const nameNode = decl.childForFieldName('name') || decl.children.find(c => c.type === 'identifier');
                if (nameNode) assignedName = nameNode.text;

                const val = decl.childForFieldName('value');
                if (val && (val.type.includes('function') || val.type === 'arrow_function')) {
                    isFunc = true;
                    node = val;
                    isExp = node.parent && node.parent.parent && node.parent.parent.type.includes('export');
                } else if (assignedName) {
                    isVar = true;
                }
            }
        }

        if (isFunc) {
            let name = assignedName;
            let kind = 'fn';
            let declParamNode = null;
            if (!name) {
                const nameNode = node.childForFieldName('name')
                    || node.children.find(c => c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'field_identifier');
                if (nameNode) {
                    name = nameNode.text;
                } else {
                    const info = extractDeclaratorFuncInfo(node);
                    name = info.name;
                    declParamNode = info.paramNode;
                }
            }
            if (!name) return null;

            if (name === 'constructor' || name === '__init__' || name === 'initialize') kind = 'ctor';
            if (exportedNames.has(name)) isExp = true;

            const isAsync = node.children.some(c => c.type === 'async' || c.text === 'async');

            let params = null;
            const paramNode = declParamNode
                || (typeof node.childForFieldName === 'function' && node.childForFieldName('parameters'))
                || node.children.find(c =>
                    c.type.includes('parameters') ||
                    c.type === 'formal_parameters' ||
                    c.type === 'parameter_list'
                );
            if (paramNode) {
                params = paramNode.text.replace(/\s+/g, ' ');
                if (params.length > 50) params = params.slice(0, 49) + '…';
            }

            const res = { kind, name, ln: node.startPosition.row + 1, end_ln: node.endPosition.row + 1 };
            if (params) res.params = params;
            if (isAsync) res.async = true;
            if (isExp) res.export = true;
            return res;
        }

        if (isVar) {
            if (exportedNames.has(assignedName)) isExp = true;
            const res = { kind: declToken, name: assignedName, ln: node.startPosition.row + 1, end_ln: node.endPosition.row + 1 };
            if (isExp) res.export = true;
            return res;
        }

        return null;
    }

    function walk(node, isTopLevel) {
        const syms = [];
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);

            if (isTopLevel) {
                const iife = getIifeInfo(child);
                if (iife) {
                    const members = walk(iife.body, false);
                    if (members.length > 0) {
                        syms.push({
                            kind: 'module',
                            name: iife.name,
                            ln: iife.ln,
                            end_ln: iife.end_ln,
                            members
                        });
                    }
                    continue;
                }
            }

            const sym = extractSymbol(child);
            if (sym) {
                if (sym.kind === 'class') {
                    const bodyNode = child.children.find(c =>
                        c.type.includes('body') ||
                        c.type === 'declaration_list' ||
                        c.type === 'field_declaration_list' ||
                        c.type === 'block'
                    );
                    if (bodyNode) {
                        const members = walk(bodyNode, false);
                        if (members.length > 0) sym.members = members;
                    }
                }
                syms.push(sym);
            } else if (
                !child.type.includes('function') &&
                !child.type.includes('method') &&
                !child.type.includes('class') &&
                !child.type.includes('string')
            ) {
                syms.push(...walk(child, false));
            }
        }
        return syms;
    }

    return walk(rootNode, true);
}

const JS_SCRIPT_TYPES = new Set([
    '',
    'text/javascript',
    'application/javascript',
    'application/ecmascript',
    'text/ecmascript',
    'module'
]);

function isJsScriptType(typeVal) {
    const mime = String(typeVal || '').split(';')[0].trim().toLowerCase();
    return JS_SCRIPT_TYPES.has(mime);
}

function isCssStyleType(typeVal) {
    const mime = String(typeVal || '').split(';')[0].trim().toLowerCase();
    return mime === '' || mime === 'text/css';
}

function inspectHtmlRawElement(elNode) {
    const attrs = Object.create(null);
    let rawTextNode = null;
    for (let i = 0; i < elNode.childCount; i++) {
        const ch = elNode.child(i);
        if (ch.type === 'start_tag') {
            for (let j = 0; j < ch.childCount; j++) {
                const a = ch.child(j);
                if (a.type !== 'attribute') continue;
                let attrName = '';
                let attrVal = '';
                for (let k = 0; k < a.childCount; k++) {
                    const part = a.child(k);
                    if (part.type === 'attribute_name') {
                        attrName = part.text.toLowerCase();
                    } else if (part.type === 'quoted_attribute_value' || part.type === 'attribute_value') {
                        attrVal = part.text.replace(/^['"]|['"]$/g, '').trim();
                    }
                }
                if (attrName && attrs[attrName] === undefined) attrs[attrName] = attrVal;
            }
        } else if (ch.type === 'raw_text') {
            rawTextNode = ch;
        }
    }
    return { attrs, rawTextNode };
}

function formatRawTagName(tagName, attrs) {
    let label = tagName;
    if (attrs.id) label += `#${attrs.id}`;
    if (attrs.src) {
        const src = attrs.src.length > 50 ? attrs.src.slice(0, 47) + '…' : attrs.src;
        label += `[src="${src}"]`;
    }
    if (attrs.type) {
        const mime = attrs.type.split(';')[0].trim().toLowerCase();
        const isDefault = (tagName === 'script' && mime === 'text/javascript')
            || (tagName === 'style' && mime === 'text/css');
        if (!isDefault) label += `[type="${attrs.type}"]`;
    }
    return label;
}

function shiftSymbolLines(syms, lineOffset) {
    if (!lineOffset) return syms;
    for (const s of syms || []) {
        if (typeof s.ln === 'number') s.ln += lineOffset;
        if (typeof s.end_ln === 'number') s.end_ln += lineOffset;
        if (s.members && s.members.length) shiftSymbolLines(s.members, lineOffset);
    }
    return syms;
}

function extractSymbolsFromQuery(query, rootNode, langName) {
    const matches = query.matches(rootNode);
    const rawSymbols = [];

    for (const match of matches) {
        let kind = 'unknown';
        let name = 'unknown';
        let ln = 1;
        let params = null;
        let isAsync = false;
        let tag = '';
        let idVal = '';
        let rawTagLabel = null;
        let embed = null;
        let mainNode = null;

        for (const capture of match.captures) {
            if (capture.name === 'class.name') {
                kind = 'class';
                name = capture.node.text;
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node.parent || capture.node;
                if (langName === 'fortran' && mainNode.parent && mainNode.parent.type === 'module') {
                    mainNode = mainNode.parent;
                } else if (langName === 'julia' && mainNode.type === 'type_head' && mainNode.parent) {
                    mainNode = mainNode.parent;
                }
            } else if (capture.name === 'fn.name') {
                kind = 'fn';
                name = capture.node.text;
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node.parent || capture.node;
                if (langName === 'fortran' && mainNode.parent && (mainNode.parent.type === 'subroutine' || mainNode.parent.type === 'function')) {
                    mainNode = mainNode.parent;
                } else if (langName === 'julia') {
                    let cur = capture.node.parent;
                    while (cur && cur.type !== 'function_definition' && cur.type !== 'macro_definition') {
                        cur = cur.parent;
                    }
                    if (cur) mainNode = cur;
                }
            } else if (capture.name === 'fn.params') {
                params = capture.node.text.replace(/\s+/g, ' ');
                if (params.length > 50) params = params.slice(0, 49) + '…';
            } else if (capture.name === 'fn.def') {
                if (capture.node.text.startsWith('async ')) {
                    isAsync = true;
                }
            } else if (capture.name === 'css.selector') {
                kind = 'rule';
                name = capture.node.text.replace(/\s+/g, ' ').trim();
                if (name.length > 50) name = name.slice(0, 49) + '…';
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node.parent || capture.node;
            } else if (capture.name === 'css.media') {
                kind = 'media';
                name = capture.node.text.replace(/\s+/g, ' ').trim();
                if (name.length > 50) name = name.slice(0, 49) + '…';
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node.parent || capture.node;
            } else if (capture.name === 'css.media_stmt') {
                kind = 'media';
                const rawText = capture.node.text || '';
                const braceIdx = rawText.indexOf('{');
                let head = braceIdx >= 0 ? rawText.slice(0, braceIdx) : rawText;
                head = head.replace(/^@media\b/i, '').replace(/\s+/g, ' ').trim();
                name = head || '@media';
                if (name.length > 50) name = name.slice(0, 49) + '…';
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node;
            } else if (capture.name === 'html.element') {
                kind = 'tag';
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node;
            } else if (capture.name === 'html.tag') {
                tag = capture.node.text;
            } else if (capture.name === 'attr.value') {
                idVal = capture.node.text.replace(/^['"]|['"]$/g, '');
            } else if (capture.name === 'html.script' || capture.name === 'html.style') {
                const isScript = capture.name === 'html.script';
                const tagName = isScript ? 'script' : 'style';
                kind = 'tag';
                ln = capture.node.startPosition.row + 1;
                mainNode = capture.node;
                const { attrs, rawTextNode } = inspectHtmlRawElement(capture.node);
                rawTagLabel = formatRawTagName(tagName, attrs);
                if (rawTextNode && rawTextNode.text && rawTextNode.text.trim().length > 0) {
                    if (isScript && !attrs.src && isJsScriptType(attrs.type)) {
                        embed = {
                            lang: 'javascript',
                            text: rawTextNode.text,
                            lineOffset: rawTextNode.startPosition.row
                        };
                    } else if (!isScript && isCssStyleType(attrs.type)) {
                        embed = {
                            lang: 'css',
                            text: rawTextNode.text,
                            lineOffset: rawTextNode.startPosition.row
                        };
                    }
                }
            }
        }

        if (kind === 'tag') {
            name = rawTagLabel !== null ? rawTagLabel : ((tag || 'element') + (idVal ? '#' + idVal : ''));
        }

        if (kind !== 'unknown') {
            if (langName === 'python' && params) {
                params = params.replace(/^\(\s*(?:self|cls)\b[^,)]*(?:,\s*)?/, '(');
            }

            const end_ln = mainNode ? mainNode.endPosition.row + 1 : ln;
            const sym = { kind, name, ln, end_ln, _node: mainNode };
            if (params) sym.params = params;
            if (isAsync) sym.async = true;
            if (embed) sym._embed = embed;

            const isDup = rawSymbols.some(s =>
                (s._node && mainNode && s._node.id === mainNode.id && s.kind === sym.kind) ||
                (s.kind === sym.kind && s.name === sym.name && s.ln === sym.ln && (!s._node || !mainNode))
            );
            if (!isDup) {
                rawSymbols.push(sym);
            }
        }
    }

    // Reconstruct AST nesting
    const nodeToSym = new Map();
    for (const s of rawSymbols) {
        if (s._node && s._node.id !== undefined) nodeToSym.set(s._node.id, s);
    }

    const symbols = [];
    for (const sym of rawSymbols) {
        let parentNode = sym._node ? sym._node.parent : null;
        let parentSym = null;
        while (parentNode) {
            if (parentNode.id !== undefined && nodeToSym.has(parentNode.id)) {
                parentSym = nodeToSym.get(parentNode.id);
                break;
            }
            parentNode = parentNode.parent;
        }
        delete sym._node;
        if (parentSym) {
            if (!parentSym.members) parentSym.members = [];
            parentSym.members.push(sym);
        } else {
            symbols.push(sym);
        }
    }
    return symbols;
}

function tallySymbols(symbols) {
    let fns = 0, vars = 0, classes = 0, asyncs = 0;
    function walk(syms) {
        for (const s of syms || []) {
            if (s.kind === 'class') classes++;
            else if (s.kind === 'fn' || s.kind === 'ctor') {
                fns++;
                if (s.async) asyncs++;
            } else if (s.kind === 'const' || s.kind === 'let' || s.kind === 'var') {
                vars++;
            }
            if (s.members) walk(s.members);
        }
    }
    walk(symbols);
    return { fns, vars, classes, asyncs };
}

function countAllNodes(symbols) {
    let total = 0;
    for (const s of symbols || []) {
        total++;
        if (s.members) total += countAllNodes(s.members);
    }
    return total;
}

// --- Per-File Isolated Mapper -----------------------------------------------
function recreateParser(ctx) {
    if (ctx.parser) {
        try { ctx.parser.delete(); } catch (_) {}
    }
    ctx.parser = (ctx.runtime && ctx.runtime.Parser) ? new ctx.runtime.Parser() : null;
    ctx.currentLangName = null;
}

async function ensureGrammarInCtx(ctx, langName) {
    if (ctx.loadedGrammars.has(langName)) return ctx.loadedGrammars.get(langName);
    if (ctx.grammarErrors.has(langName)) return null;
    try {
        const lang = await loadGrammar(ctx.runtime, langName);
        ctx.loadedGrammars.set(langName, lang);
        return lang;
    } catch (err) {
        ctx.grammarErrors.set(langName, cleanErrMsg(err));
        return null;
    }
}

async function subParseEmbeddedBlocks(symbols, ctx, imports, exportedNames) {
    const embeds = [];
    function collect(syms) {
        for (const s of syms || []) {
            if (s._embed) {
                embeds.push({ sym: s, embed: s._embed });
                delete s._embed;
            }
            if (s.members && s.members.length) collect(s.members);
        }
    }
    collect(symbols);
    if (embeds.length === 0) return;

    // Preload any needed sub-grammars (javascript / css) once in parallel
    const neededLangs = [...new Set(embeds.map(e => e.embed.lang))];
    await Promise.all(neededLangs.map(l => ensureGrammarInCtx(ctx, l)));

    for (const { sym, embed } of embeds) {
        const subLang = ctx.loadedGrammars.get(embed.lang);
        if (!subLang) continue;

        let subTree = null;
        try {
            if (!ctx.parser) ctx.parser = new ctx.runtime.Parser();
            if (ctx.currentLangName !== embed.lang) {
                ctx.parser.setLanguage(subLang);
                ctx.currentLangName = embed.lang;
            }
            subTree = ctx.parser.parse(embed.text);

            let subSyms = [];
            if (embed.lang === 'javascript') {
                collectImportsAndExports(subTree.rootNode, imports, exportedNames);
                subSyms = extractSymbolsImperative(subTree.rootNode, exportedNames);
            } else if (embed.lang === 'css') {
                const qEntry = getCompiledQuery(ctx.runtime, 'css', subLang);
                if (qEntry && qEntry.query) {
                    subSyms = extractSymbolsFromQuery(qEntry.query, subTree.rootNode, 'css');
                }
            }

            if (subSyms.length > 0) {
                shiftSymbolLines(subSyms, embed.lineOffset);
                if (!sym.members) sym.members = [];
                sym.members.push(...subSyms);
            }
        } catch (_) {
            // Keep the outer <script>/<style> range shell intact if inline parsing traps
            recreateParser(ctx);
        } finally {
            if (subTree) {
                try { subTree.delete(); } catch (_) {}
            }
        }
    }
}

async function mapOneFile(fp, content, ctx) {
    const ext = getFileExt(fp);
    const langName = EXT_TO_LANG[ext];
    const nonAstLang = NON_AST_EXTS[ext];

    const linesCount = content.split('\n').length;
    const sizeBytes = utf8ByteLength(content);

    if (sizeBytes > ctx.maxFileBytes) {
        return {
            ok: false,
            file: fp,
            reason: `too large (${formatByteSize(sizeBytes)} > ${formatByteSize(ctx.maxFileBytes)})`
        };
    }

    if (nonAstLang) {
        try {
            let rawSummary = '';
            let topSummary = '';
            if (nonAstLang === 'json') {
                rawSummary = summarizeJson(content);
                try {
                    const parsed = JSON.parse(content);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        const keys = Object.keys(parsed);
                        topSummary = `Keys (${keys.length}): ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''}`;
                    } else if (Array.isArray(parsed)) {
                        topSummary = `Array (${parsed.length} items)`;
                    } else {
                        topSummary = firstNonEmptyLine(content);
                    }
                } catch (_) {
                    topSummary = '(Invalid JSON)';
                }
            } else if (nonAstLang === 'yaml') {
                rawSummary = await summarizeYaml(content);
                const keyMap = findYamlTopLevelKeyLines(content);
                const keys = Object.keys(keyMap);
                topSummary = keys.length
                    ? `Keys (${keys.length}): ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''}`
                    : firstNonEmptyLine(content);
            } else if (nonAstLang === 'markdown') {
                rawSummary = summarizeMarkdown(content);
                const headings = parseMarkdownHeadings(content).filter(h => h.level <= 2);
                topSummary = headings.length
                    ? truncateLines(headings.map(h => `${h.prefix} ${h.text} :${h.end_ln > h.ln ? `${h.ln}-${h.end_ln}` : h.ln}`), 10)
                    : firstNonEmptyLine(content);
            } else {
                rawSummary = summarizeText(content);
                topSummary = firstNonEmptyLine(content);
            }

            return {
                ok: true,
                fileData: {
                    file: fp,
                    lines: linesCount,
                    size: sizeBytes,
                    nonAstLang,
                    rawSummary,
                    topSummary
                }
            };
        } catch (err) {
            return { ok: false, file: fp, reason: `summarize error: ${err.message || String(err)}` };
        }
    }

    if (!langName) {
        return { ok: false, file: fp, reason: `unsupported extension: ${ext || '(none)'}` };
    }

    const grammarErr = ctx.grammarErrors.get(langName);
    if (grammarErr) {
        return { ok: false, file: fp, reason: `grammar load failed: ${grammarErr}` };
    }

    const lang = ctx.loadedGrammars.get(langName);
    if (!lang) {
        return { ok: false, file: fp, reason: `grammar not loaded for ${langName}` };
    }

    let tree = null;
    try {
        if (!ctx.parser) ctx.parser = new ctx.runtime.Parser();
        if (ctx.currentLangName !== langName) {
            ctx.parser.setLanguage(lang);
            ctx.currentLangName = langName;
        }

        try {
            tree = ctx.parser.parse(content);
        } catch (parseErr) {
            // Parser WASM state may be corrupted after a trap; always recreate.
            recreateParser(ctx);
            const errMsg = cleanErrMsg(parseErr);
            if (langName === 'html') {
                const fbSymbols = htmlFallbackOutline(content);
                const fbStats = tallySymbols(fbSymbols);
                const fileData = {
                    file: fp,
                    lines: linesCount,
                    size: sizeBytes,
                    parser: 'fallback',
                    warning: `HTML Tree-sitter parse failed (${errMsg}); used fallback scanner`
                };
                if (fbSymbols.length > 0) {
                    fileData.symbols = fbSymbols;
                    fileData.stats = fbStats;
                }
                return { ok: true, fileData };
            }
            return { ok: false, file: fp, reason: `parse error: ${errMsg}` };
        }

        const imports = new Set();
        const exportedNames = new Set();
        collectImportsAndExports(tree.rootNode, imports, exportedNames);

        let symbols = [];
        let warning = null;

        if (LANGUAGE_QUERIES[langName]) {
            const qEntry = getCompiledQuery(ctx.runtime, langName, lang);
            if (qEntry && qEntry.query) {
                try {
                    symbols = extractSymbolsFromQuery(qEntry.query, tree.rootNode, langName);
                } catch (qRunErr) {
                    warning = `query error: ${cleanErrMsg(qRunErr)}`;
                    try {
                        symbols = extractSymbolsImperative(tree.rootNode, exportedNames);
                    } catch (_) {}
                }
            } else if (qEntry && qEntry.error) {
                warning = `query error: ${qEntry.error}`;
                try {
                    symbols = extractSymbolsImperative(tree.rootNode, exportedNames);
                } catch (_) {}
            }
        } else {
            symbols = extractSymbolsImperative(tree.rootNode, exportedNames);
        }

        // Free the HTML tree before sub-parsing embedded JS/CSS blocks
        if (langName === 'html' && symbols.length > 0) {
            try { tree.delete(); } catch (_) {}
            tree = null;
            await subParseEmbeddedBlocks(symbols, ctx, imports, exportedNames);
        }

        const stats = tallySymbols(symbols);
        const fileData = {
            file: fp,
            lines: linesCount,
            size: sizeBytes
        };
        if (imports.size > 0) fileData.imports = Array.from(imports);
        if (symbols.length > 0) {
            fileData.symbols = symbols;
            fileData.stats = stats;
        }
        if (warning) fileData.warning = warning;

        return { ok: true, fileData };
    } catch (err) {
        recreateParser(ctx);
        return { ok: false, file: fp, reason: `parse error: ${cleanErrMsg(err)}` };
    } finally {
        if (tree) {
            try { tree.delete(); } catch (_) {}
        }
    }
}

// --- Rendering & Budgeting (Pure Helpers) -----------------------------------
function isNoParensKind(kind) {
    return (
        kind === 'class' ||
        kind === 'module' ||
        kind === 'tag' ||
        kind === 'rule' ||
        kind === 'media' ||
        kind === 'const' ||
        kind === 'let' ||
        kind === 'var'
    );
}

function renderSymbolLines(symbols, indent = '  ') {
    const out = [];
    function walk(s, ind) {
        const noParens = isNoParensKind(s.kind);
        const p = s.params || (noParens ? '' : '()');
        const kindPrefix = noParens ? `${s.kind} ` : '';
        const line = `${ind}${kindPrefix}${s.name}${p} :${formatLineRange(s)}${s.async ? '  async' : ''}${s.export ? '  (export)' : ''}`;
        out.push(line);
        if (s.members && s.members.length) {
            for (const c of s.members) walk(c, ind + '  ');
        }
    }
    for (const s of symbols || []) walk(s, indent);
    return out;
}

function renderFileText(fd, detail = 'full', index1Based = null) {
    const numPrefix = index1Based !== null ? `[${index1Based}] ` : '';
    const kb = (fd.size / 1024).toFixed(1);
    const out = [];

    if (fd.rawSummary !== undefined) {
        if (detail === 'top') {
            out.push(`${numPrefix}${fd.file}  (${fd.lines} lines, ${kb}kb) [data/text]`);
            const sum = fd.topSummary || firstNonEmptyLine(fd.rawSummary);
            out.push(sum.split('\n').map(l => `  ${l}`).join('\n'));
            return out.join('\n');
        }
        out.push(`${numPrefix}${fd.file}  (${fd.lines} lines, ${kb}kb) [data/text]`);
        out.push(fd.rawSummary.split('\n').map(l => `  ${l}`).join('\n'));
        return out.join('\n');
    }

    const fallbackTag = fd.parser === 'fallback' ? ' [fallback]' : '';
    if (detail === 'top') {
        out.push(`${numPrefix}${fd.file}  (${fd.lines} lines, ${kb}kb)${fallbackTag}`);
        if (fd.warning) out.push(`  Warning: ${fd.warning}`);
        if (fd.symbols && fd.symbols.length) {
            for (const s of fd.symbols) {
                const memCount = s.members ? s.members.length : 0;
                const memStr = memCount > 0 ? ` (${memCount} member${memCount === 1 ? '' : 's'})` : '';
                const kindStr = (s.kind === 'fn' || s.kind === 'ctor') ? '' : `${s.kind} `;
                out.push(`  ${kindStr}${s.name} :${formatLineRange(s)}${memStr}${s.export ? '  (export)' : ''}`);
            }
        } else {
            out.push('  (No structures found)');
        }
        return out.join('\n');
    }

    const st = fd.stats || { fns: 0, vars: 0, classes: 0, asyncs: 0 };
    out.push(`${numPrefix}${fd.file}  (${fd.lines} lines, ${kb}kb) [fns: ${st.fns}, vars: ${st.vars}, classes: ${st.classes}, async: ${st.asyncs}]${fallbackTag}`);
    if (fd.warning) out.push(`  Warning: ${fd.warning}`);
    if (fd.imports && fd.imports.length) out.push(`  Imports: ${fd.imports.join(', ')}`);
    if (fd.symbols && fd.symbols.length) {
        out.push(...renderSymbolLines(fd.symbols, '  '));
    } else {
        out.push('  (No structures found)');
    }
    return out.join('\n');
}

function compactFileForJson(fd, detail) {
    if (detail === 'full') {
        const clean = { file: fd.file, lines: fd.lines, size: fd.size };
        if (fd.parser) clean.parser = fd.parser;
        if (fd.warning) clean.warning = fd.warning;
        if (fd.rawSummary !== undefined) {
            clean.rawSummary = fd.rawSummary;
            return clean;
        }
        if (fd.imports && fd.imports.length) clean.imports = fd.imports;
        if (fd.symbols && fd.symbols.length) {
            clean.symbols = fd.symbols;
            if (fd.stats) clean.stats = fd.stats;
        }
        return clean;
    }

    // detail === 'top'
    const clean = { file: fd.file, lines: fd.lines, size: fd.size };
    if (fd.parser) clean.parser = fd.parser;
    if (fd.warning) clean.warning = fd.warning;
    if (fd.rawSummary !== undefined) {
        clean.summary = fd.topSummary || firstNonEmptyLine(fd.rawSummary);
        return clean;
    }
    if (fd.symbols && fd.symbols.length) {
        clean.symbols = fd.symbols.map(s => {
            const o = { kind: s.kind, name: s.name, ln: s.ln, end_ln: s.end_ln };
            if (s.export) o.export = true;
            if (s.members && s.members.length) o.member_count = s.members.length;
            return o;
        });
    }
    return clean;
}

function buildDirectoryBuckets(entries) {
    // Entries are in sortPaths order, so directories are contiguous.
    const buckets = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const dir = dirOfPath(e.fp) || '(root)';
        let bucket = buckets.length ? buckets[buckets.length - 1] : null;
        if (!bucket || bucket.dir !== dir) {
            bucket = {
                dir,
                startIdx: i,
                endIdx: i + 1,
                files: [],
                skipped: [],
                fns: 0,
                classes: 0,
                vars: 0,
                lines: 0
            };
            buckets.push(bucket);
        } else {
            bucket.endIdx = i + 1;
        }

        if (e.ok) {
            const fd = e.fileData;
            bucket.files.push(fd);
            bucket.lines += fd.lines || 0;
            if (fd.stats) {
                bucket.fns += fd.stats.fns || 0;
                bucket.classes += fd.stats.classes || 0;
                bucket.vars += fd.stats.vars || 0;
            }
        } else {
            bucket.skipped.push({ file: e.fp, reason: e.reason });
        }
    }

    return buckets.map(b => {
        const largest = [...b.files]
            .sort((a, c) => (c.lines - a.lines) || (c.size - a.size))
            .slice(0, 3)
            .map(f => ({ file: f.file, lines: f.lines, size: f.size }));
        return {
            dir: b.dir,
            startIdx: b.startIdx,
            endIdx: b.endIdx,
            file_count: b.files.length,
            skipped_count: b.skipped.length,
            fns: b.fns,
            classes: b.classes,
            vars: b.vars,
            lines: b.lines,
            largest_files: largest,
            skipped: b.skipped
        };
    });
}

function renderSummaryLine(b) {
    const largestStr = b.largest_files.length
        ? `  largest: ${b.largest_files.map(f => `${f.file.split('/').pop()} (${f.lines}L)`).join(', ')}`
        : '';
    const skipStr = b.skipped_count ? `, ${b.skipped_count} skipped` : '';
    return `${b.dir}  (${b.file_count} file${b.file_count === 1 ? '' : 's'}${skipStr}, ${b.fns} fns, ${b.classes} classes)${largestStr}`;
}

function formatSkippedText(skipped) {
    if (!skipped || skipped.length === 0) return '';
    const lines = [`Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}:`];
    for (const s of skipped) {
        lines.push(`  ${s.file}: ${s.reason}`);
    }
    return lines.join('\n');
}

function budgetAndPage(entries, opts) {
    const {
        outFormat,
        requestedDetail,
        maxOutputChars,
        offset,
        totalFiles,
        targetPath,
        hitLimitReason
    } = opts;

    const FOOTER_RESERVE = 260;

    function buildFilesPayload(detail, sliceEntries) {
        const files = [];
        const skipped = [];
        for (const e of sliceEntries) {
            if (e.ok) files.push(e.fileData);
            else skipped.push({ file: e.fp, reason: e.reason });
        }
        const countCovered = sliceEntries.length;
        const nextOffset = (offset + countCovered < totalFiles) ? (offset + countCovered) : null;

        if (outFormat === 'json') {
            const obj = {
                files: files.map(fd => compactFileForJson(fd, detail)),
                total_files: totalFiles,
                offset,
                returned: files.length,
                next_offset: nextOffset,
                detail,
                skipped
            };
            if (requestedDetail === 'auto' && detail !== 'full') obj.detail_degraded_from = 'auto';
            if (nextOffset !== null && hitLimitReason && countCovered === entries.length) {
                obj.limit_reason = hitLimitReason;
            }
            return { str: JSON.stringify(obj), countCovered, nextOffset, detail, files, skipped };
        }

        const blocks = files.map((fd, idx) => renderFileText(fd, detail, offset + idx + 1));
        const parts = [];
        if (requestedDetail === 'auto' && detail !== 'full') {
            parts.push(`[Detail auto-degraded to "${detail}" to fit output budget (${maxOutputChars} chars).]`);
        }
        if (blocks.length) parts.push(blocks.join('\n\n'));
        if (skipped.length) parts.push(formatSkippedText(skipped));

        if (nextOffset !== null) {
            const scopeLabel = targetPath ? ` under "${targetPath}"` : '';
            const reasonLabel = (countCovered === entries.length && hitLimitReason)
                ? hitLimitReason
                : 'output budget reached';
            const pathArg = targetPath ? `path:"${targetPath}", ` : '';
            const altHint = detail === 'full'
                ? 'use detail:"top" or detail:"summary", '
                : (detail === 'top' ? 'use detail:"summary", ' : '');
            parts.push(
                `[Showing files ${offset + 1}-${offset + countCovered} of ${totalFiles}${scopeLabel} (${reasonLabel}). Narrow 'path', ${altHint}or call map(${pathArg}detail:"${detail}", offset:${nextOffset}) to continue.]`
            );
        }

        return { str: parts.join('\n\n'), countCovered, nextOffset, detail, files, skipped };
    }

    function pageFilesAtDetail(detail) {
        const fullTry = buildFilesPayload(detail, entries);
        if (fullTry.str.length <= maxOutputChars || entries.length <= 1) {
            if (entries.length === 1 && fullTry.str.length > maxOutputChars && outFormat === 'text') {
                fullTry.str = fullTry.str.slice(0, Math.max(200, maxOutputChars - 80))
                    + '\n... [single file output truncated to fit maxOutputChars]';
            }
            return fullTry;
        }

        // Binary search largest prefix >= 1 that fits within maxOutputChars
        let lo = 1;
        let hi = entries.length;
        let best = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const candidate = buildFilesPayload(detail, entries.slice(0, mid));
            if (candidate.str.length <= maxOutputChars) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best) return best;
        const single = buildFilesPayload(detail, entries.slice(0, 1));
        if (outFormat === 'text' && single.str.length > maxOutputChars) {
            single.str = single.str.slice(0, Math.max(200, maxOutputChars - 80))
                + '\n... [single file output truncated to fit maxOutputChars]';
        }
        return single;
    }

    function buildSummaryPayload(bucketsSlice) {
        const covered = bucketsSlice.length ? bucketsSlice[bucketsSlice.length - 1].endIdx : 0;
        const skipped = [];
        let fileCount = 0;
        for (const b of bucketsSlice) {
            fileCount += b.file_count;
            skipped.push(...b.skipped);
        }
        const nextOffset = (offset + covered < totalFiles) ? (offset + covered) : null;

        if (outFormat === 'json') {
            const dirs = bucketsSlice.map(b => ({
                dir: b.dir,
                files: b.file_count,
                fns: b.fns,
                classes: b.classes,
                vars: b.vars,
                lines: b.lines,
                largest_files: b.largest_files
            }));
            const obj = {
                directories: dirs,
                total_files: totalFiles,
                offset,
                returned: fileCount,
                next_offset: nextOffset,
                detail: 'summary',
                skipped
            };
            if (requestedDetail === 'auto') obj.detail_degraded_from = 'auto';
            if (nextOffset !== null && hitLimitReason && covered === entries.length) {
                obj.limit_reason = hitLimitReason;
            }
            return { str: JSON.stringify(obj), countCovered: covered, nextOffset, detail: 'summary', skipped };
        }

        const parts = [];
        if (requestedDetail === 'auto') {
            parts.push(`[Detail auto-degraded to "summary" to fit output budget (${maxOutputChars} chars).]`);
        }
        if (bucketsSlice.length) {
            parts.push(bucketsSlice.map(renderSummaryLine).join('\n'));
        }
        if (skipped.length) {
            parts.push(formatSkippedText(skipped));
        }
        if (nextOffset !== null) {
            const scopeLabel = targetPath ? ` under "${targetPath}"` : '';
            const reasonLabel = (covered === entries.length && hitLimitReason)
                ? hitLimitReason
                : 'output budget reached';
            const pathArg = targetPath ? `path:"${targetPath}", ` : '';
            parts.push(
                `[Showing summary for files ${offset + 1}-${offset + covered} of ${totalFiles}${scopeLabel} (${reasonLabel}). Narrow 'path' or call map(${pathArg}detail:"summary", offset:${nextOffset}) to continue.]`
            );
        }
        return { str: parts.join('\n\n'), countCovered: covered, nextOffset, detail: 'summary', skipped };
    }

    function pageSummary() {
        const buckets = buildDirectoryBuckets(entries);
        const fullTry = buildSummaryPayload(buckets);
        if (fullTry.str.length <= maxOutputChars || buckets.length <= 1) {
            return fullTry;
        }
        let lo = 1;
        let hi = buckets.length;
        let best = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const cand = buildSummaryPayload(buckets.slice(0, mid));
            if (cand.str.length <= maxOutputChars) {
                best = cand;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best || buildSummaryPayload(buckets.slice(0, 1));
    }

    if (requestedDetail === 'full') return pageFilesAtDetail('full');
    if (requestedDetail === 'top') return pageFilesAtDetail('top');
    if (requestedDetail === 'summary') return pageSummary();

    // requestedDetail === 'auto': degrade full -> top -> summary, then page if needed
    const tryFull = buildFilesPayload('full', entries);
    if (tryFull.str.length <= maxOutputChars) return tryFull;

    const tryTop = buildFilesPayload('top', entries);
    if (tryTop.str.length <= maxOutputChars) return tryTop;

    const trySum = pageSummary();
    // Avoid unused warning; reserve constant kept for readability
    void FOOTER_RESERVE;
    return trySum;
}

// --- Throttled UI Progress Helper -------------------------------------------
function createProgressReporter(api, intervalMs = UI_THROTTLE_MS) {
    let lastEmit = 0;
    return {
        async update(headerMsg, html, force = false) {
            const now = Date.now();
            if (!force && now - lastEmit < intervalMs) return;
            lastEmit = now;
            const tasks = [];
            if (headerMsg && typeof api.setHeaderMsg === 'function') {
                tasks.push(api.setHeaderMsg(headerMsg));
            }
            if (html && typeof api.showUI === 'function') {
                tasks.push(api.showUI(html, { live: true }));
            }
            if (tasks.length) await Promise.all(tasks);
        }
    };
}

// --- Concurrent Prefetch Read Helper ----------------------------------------
async function readFileChecked(api, fp, maxFileBytes) {
    if (typeof api.statFile === 'function') {
        try {
            const st = await api.statFile(fp);
            if (st && typeof st === 'object') {
                if (st.isBinary) {
                    return { ok: false, reason: 'binary file' };
                }
                if (typeof st.size === 'number' && st.size > maxFileBytes) {
                    return {
                        ok: false,
                        reason: `too large (${formatByteSize(st.size)} > ${formatByteSize(maxFileBytes)})`
                    };
                }
            }
        } catch (_) {
            // statFile unavailable or errored; fall back to readFile
        }
    }

    let content;
    try {
        content = await api.readFile(fp);
    } catch (err) {
        return { ok: false, reason: `read error: ${err.message || String(err)}` };
    }

    if (typeof content !== 'string') {
        return { ok: false, reason: 'read error: non-text result' };
    }
    if (content.startsWith('ERROR:')) {
        return { ok: false, reason: content.replace(/^ERROR:\s*/i, '').trim() || 'read error' };
    }

    const sizeBytes = utf8ByteLength(content);
    if (sizeBytes > maxFileBytes) {
        return {
            ok: false,
            reason: `too large (${formatByteSize(sizeBytes)} > ${formatByteSize(maxFileBytes)})`
        };
    }

    return { ok: true, content, sizeBytes };
}

function createPrefetcher(paths, api, maxFileBytes, concurrency = READ_CONCURRENCY) {
    const cache = new Map();
    let nextToStart = 0;

    function fill(limitIdx) {
        const ceiling = Math.min(paths.length, limitIdx + concurrency);
        while (nextToStart < ceiling) {
            const idx = nextToStart++;
            const fp = paths[idx];
            cache.set(idx, readFileChecked(api, fp, maxFileBytes));
        }
    }

    return {
        get(idx) {
            fill(idx);
            const p = cache.get(idx);
            cache.delete(idx);
            return p;
        }
    };
}

async function runPool(items, concurrency, workerFn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = [];
    const n = Math.min(concurrency, items.length);
    for (let w = 0; w < n; w++) {
        workers.push((async () => {
            while (true) {
                const i = cursor++;
                if (i >= items.length) break;
                results[i] = await workerFn(items[i], i);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}

// --- UI Card Builders -------------------------------------------------------
function buildSkippedNoticeHtml(skipped) {
    if (!skipped || skipped.length === 0) return '';
    const shown = skipped.slice(0, 15);
    const items = shown.map(s =>
        `<div style="font-family:var(--font-mono); font-size:10.5px;">${esc(s.file)}: ${esc(s.reason)}</div>`
    ).join('');
    const more = skipped.length > shown.length
        ? `<div style="font-size:10.5px; opacity:0.85;">... and ${skipped.length - shown.length} more skipped</div>`
        : '';
    return `<div style="padding:8px 10px; color:var(--yellow); font-size:11px; border-bottom:1px solid var(--border); background:var(--bg-input);">
        <div style="font-weight:600; margin-bottom:3px;">Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}</div>
        ${items}${more}
    </div>`;
}

function buildFileUiRow(fd) {
    const kb = (fd.size / 1024).toFixed(1);
    if (fd.rawSummary !== undefined) {
        return `
            <div style="border-bottom: 1px solid var(--border); padding: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-family:var(--font-mono); font-size:12px;">${pathHtml(fd.file)} <span class="dim" style="margin-left:6px; font-size:10px;">(${fd.lines} lines, ${kb}kb) [${esc(fd.nonAstLang || 'text')}]</span></div>
                </div>
                <pre style="margin:8px 0 0 0; padding:8px; background:var(--bg-input); border-radius:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; line-height:1.4; overflow-x:auto;">${esc(fd.rawSummary)}</pre>
            </div>`;
    }

    const st = fd.stats || { fns: 0, vars: 0, classes: 0, asyncs: 0 };
    const uiLines = fd.symbols && fd.symbols.length ? renderSymbolLines(fd.symbols, '  ') : ['  (No structures found)'];
    const uiText = uiLines.join('\n');
    const nodeCount = countAllNodes(fd.symbols);
    const badgeColor = nodeCount > 0 ? 'var(--green)' : 'var(--dim)';
    const fallbackBadge = fd.parser === 'fallback'
        ? `<span style="margin-left:6px; font-size:10px; color:var(--yellow);">[fallback]</span>`
        : '';
    const warnLine = fd.warning
        ? `<div style="margin-top:4px; font-size:10.5px; color:var(--yellow);">${esc(fd.warning)}</div>`
        : '';

    return `
        <div style="border-bottom: 1px solid var(--border); padding: 8px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="font-family:var(--font-mono); font-size:12px;">${pathHtml(fd.file)} <span class="dim" style="margin-left:6px; font-size:10px;">(${fd.lines} lines, ${kb}kb) [fns: ${st.fns}, vars: ${st.vars}, classes: ${st.classes}, async: ${st.asyncs}]</span>${fallbackBadge}</div>
                <span style="font-size:10px; padding:2px 6px; border-radius:10px; background:var(--bg-input); color:${badgeColor}; border:1px solid var(--border);">
                    ${nodeCount} node${nodeCount === 1 ? '' : 's'}
                </span>
            </div>
            ${warnLine}
            <pre style="margin:8px 0 0 0; padding:8px; background:var(--bg-input); border-radius:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; line-height:1.4; overflow-x:auto;">${esc(uiText)}</pre>
        </div>`;
}

// --- Handler ----------------------------------------------------------------
async function handler(args, api) {
    args = args || {};
    const startedAt = Date.now();

    let targetPath = String(args.path || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+|\/+$/g, '');
    if (targetPath === '.') targetPath = '';

    const symbolQuery = typeof args.symbol === 'string' ? args.symbol.trim() : '';
    const outFormat = args.format === 'json' ? 'json' : 'text';
    const rawDetail = typeof args.detail === 'string' ? args.detail.trim().toLowerCase() : 'auto';
    const requestedDetail = ['auto', 'full', 'top', 'summary'].includes(rawDetail) ? rawDetail : 'auto';
    const rawOffset = Number(args.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    const allowedExts = Array.isArray(args.extensions) && args.extensions.length > 0
        ? args.extensions.map(e => {
            const s = String(e || '').trim().toLowerCase();
            return s && !s.startsWith('.') ? '.' + s : s;
        }).filter(Boolean)
        : (symbolQuery ? Object.keys(EXT_TO_LANG) : [...Object.keys(EXT_TO_LANG), ...Object.keys(NON_AST_EXTS)]);

    const progress = createProgressReporter(api, UI_THROTTLE_MS);
    await api.setHeaderMsg("Scanning workspace...");

    // Read settings with safe defaults
    let maxOutputChars = Number(await api.getSetting('maxOutputChars'));
    if (!Number.isFinite(maxOutputChars) || maxOutputChars < 500) maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS;

    let maxFileBytes = Number(await api.getSetting('maxFileBytes'));
    if (!Number.isFinite(maxFileBytes) || maxFileBytes < 1024) maxFileBytes = DEFAULT_MAX_FILE_BYTES;

    let maxFiles = Number(await api.getSetting('maxFiles'));
    if (!Number.isFinite(maxFiles) || maxFiles < 1) maxFiles = DEFAULT_MAX_FILES;

    const allFiles = await api.listFiles();
    const candidateFiles = sortPaths(allFiles.filter(fp => {
        if (targetPath && !fp.startsWith(targetPath + '/') && fp !== targetPath) return false;
        const ext = getFileExt(fp);
        if (symbolQuery && !EXT_TO_LANG[ext]) return false;
        return allowedExts.includes(ext) && (!!EXT_TO_LANG[ext] || !!NON_AST_EXTS[ext]);
    }));

    if (candidateFiles.length === 0) {
        await api.showUI(`<div class="tool-ui-wrap"><div class="tool-ui-empty" style="padding:12px; color:var(--dim);">No supported files found in ${esc(targetPath || 'root')}.</div></div>`);
        if (symbolQuery) {
            const out = outFormat === 'json'
                ? JSON.stringify({ symbol: symbolQuery, matches: [], total_matches: 0, returned: 0, files_scanned: 0, files_parsed: 0, truncated: false, skipped: [] })
                : `No definitions matching "${symbolQuery}" found in ${targetPath || 'root'} (0 files scanned).`;
            return { output: out, summary: `Map symbol "${symbolQuery}": 0 matches` };
        }
        const out = outFormat === 'json'
            ? JSON.stringify({ files: [], total_files: 0, offset: 0, returned: 0, next_offset: null, detail: requestedDetail === 'auto' ? 'full' : requestedDetail, skipped: [] })
            : `No supported files found in ${targetPath || 'root'}.`;
        return { output: out, summary: `Map: ${targetPath || 'root'} (0 files)` };
    }

    // Shared runtime context for parsing
    const ctx = {
        runtime: null,
        parser: null,
        currentLangName: null,
        loadedGrammars: new Map(),
        grammarErrors: new Map(),
        maxFileBytes
    };

    async function preloadGrammarsForPaths(paths) {
        const needed = new Set();
        for (const fp of paths) {
            const lang = EXT_TO_LANG[getFileExt(fp)];
            if (lang && !ctx.loadedGrammars.has(lang) && !ctx.grammarErrors.has(lang)) {
                needed.add(lang);
            }
        }
        if (needed.size === 0) return true;

        try {
            ctx.runtime = await ensureTreeSitter(api, progress);
        } catch (err) {
            ctx.initError = cleanErrMsg(err);
            return false;
        }

        await Promise.all([...needed].map(async (langName) => {
            try {
                const lang = await loadGrammar(ctx.runtime, langName);
                ctx.loadedGrammars.set(langName, lang);
            } catch (err) {
                ctx.grammarErrors.set(langName, cleanErrMsg(err));
            }
        }));
        return true;
    }

    try {
        // ==================== SYMBOL LOOKUP MODE ====================
        if (symbolQuery) {
            const prefilter = symbolPrefilter(symbolQuery);
            const skipped = [];
            const survivors = [];
            let totalBytesRead = 0;
            let filesScanned = 0;
            let limitReason = null;

            // Concurrent read + text prefilter in batches so we can stop cleanly on byte/time ceilings
            const BATCH_SIZE = READ_CONCURRENCY * 4;
            for (let start = 0; start < candidateFiles.length; start += BATCH_SIZE) {
                if (totalBytesRead >= MAX_SYMBOL_SCAN_BYTES) {
                    limitReason = `read byte limit (${formatByteSize(MAX_SYMBOL_SCAN_BYTES)}) reached after ${filesScanned} of ${candidateFiles.length} files`;
                    break;
                }
                if (filesScanned > 0 && Date.now() - startedAt >= WALL_CLOCK_BUDGET_MS) {
                    limitReason = `time budget (${WALL_CLOCK_BUDGET_MS / 1000}s) reached after ${filesScanned} of ${candidateFiles.length} files`;
                    break;
                }

                const batch = candidateFiles.slice(start, start + BATCH_SIZE);
                await progress.update(
                    `Scanning ${start + 1}/${candidateFiles.length} for "${symbolQuery}"...`,
                    `<div class="tool-ui-wrap" style="padding: 12px; display:flex; align-items:center; gap:8px;">
                        <div class="running-tool-spinner"></div>
                        <span style="color:var(--dim); font-size:12px;">Scanning ${start + 1}/${candidateFiles.length} files for "${esc(symbolQuery)}"...</span>
                    </div>`
                );

                const readResults = await runPool(batch, READ_CONCURRENCY, (fp) => readFileChecked(api, fp, maxFileBytes));
                for (let i = 0; i < batch.length; i++) {
                    const fp = batch[i];
                    const r = readResults[i];
                    filesScanned++;
                    if (!r.ok) {
                        skipped.push({ file: fp, reason: r.reason });
                        continue;
                    }
                    totalBytesRead += r.sizeBytes;
                    if (prefilter(r.content)) {
                        survivors.push({ fp, content: r.content });
                    }
                }
            }

            let toParse = survivors;
            if (toParse.length > maxFiles) {
                limitReason = limitReason || `maxFiles parse ceiling (${maxFiles}) reached (${survivors.length} candidate files matched text prefilter)`;
                toParse = toParse.slice(0, maxFiles);
            }

            const allFlat = [];
            let filesParsed = 0;

            if (toParse.length > 0) {
                const initOk = await preloadGrammarsForPaths(toParse.map(x => x.fp));
                if (!initOk) {
                    const msg = `Failed to initialize Tree-sitter: ${ctx.initError}`;
                    return {
                        output: outFormat === 'json' ? JSON.stringify({ error: msg }) : msg,
                        summary: 'Map error: Tree-sitter init failed'
                    };
                }

                for (let i = 0; i < toParse.length; i++) {
                    if (i > 0 && Date.now() - startedAt >= WALL_CLOCK_BUDGET_MS) {
                        limitReason = `time budget (${WALL_CLOCK_BUDGET_MS / 1000}s) reached after parsing ${filesParsed} of ${toParse.length} matching files`;
                        break;
                    }
                    const item = toParse[i];
                    await progress.update(
                        `Parsing ${i + 1}/${toParse.length}: ${item.fp}`,
                        `<div class="tool-ui-wrap" style="padding: 12px; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <div class="running-tool-spinner"></div>
                                <span style="color:var(--dim); font-size:12px;">Parsing ${i + 1}/${toParse.length} candidate files...</span>
                            </div>
                            <div style="font-family:var(--font-mono); font-size:11px; color:var(--primary);">${esc(item.fp)}</div>
                        </div>`
                    );

                    const res = await mapOneFile(item.fp, item.content, ctx);
                    if (!res.ok) {
                        skipped.push({ file: res.file, reason: res.reason });
                        continue;
                    }
                    filesParsed++;
                    if (res.fileData.symbols && res.fileData.symbols.length) {
                        allFlat.push(...flattenSymbols(res.fileData.symbols, res.fileData.file));
                    }
                }
            }

            const { matches, total: totalMatches } = matchSymbols(allFlat, symbolQuery, MAX_SYMBOL_MATCHES);
            const isCapped = totalMatches > matches.length;
            const truncated = isCapped || !!limitReason;

            let finalOutput = '';
            if (outFormat === 'json') {
                const payload = {
                    symbol: symbolQuery,
                    matches,
                    total_matches: totalMatches,
                    returned: matches.length,
                    files_scanned: filesScanned,
                    files_parsed: filesParsed,
                    truncated,
                    skipped
                };
                if (isCapped) {
                    payload.match_cap_note = `${matches.length} of ${totalMatches} matches shown; narrow path or use a more specific symbol`;
                }
                if (limitReason) payload.limit_reason = limitReason;
                finalOutput = JSON.stringify(payload);
            } else {
                const parts = [];
                if (matches.length === 0) {
                    parts.push(`No definitions matching "${symbolQuery}" found in ${targetPath || 'root'} (${filesScanned} files scanned, ${filesParsed} parsed).`);
                } else {
                    const lines = matches.map(m => {
                        const noParens = isNoParensKind(m.kind);
                        const p = m.params || (noParens ? '' : '()');
                        const range = m.end_line > m.start_line ? `L${m.start_line}-${m.end_line}` : `L${m.start_line}`;
                        return `${m.file}  ${range}  ${m.kind} ${m.qualified_name}${p}${m.async ? '  async' : ''}${m.export ? '  (export)' : ''}`;
                    });
                    parts.push(lines.join('\n'));
                    if (isCapped) {
                        parts.push(`[${matches.length} of ${totalMatches} matches shown; narrow path or use a more specific symbol.]`);
                    }
                }
                if (limitReason) parts.push(`[Scan incomplete: ${limitReason}.]`);
                if (skipped.length) parts.push(formatSkippedText(skipped));
                finalOutput = parts.join('\n\n');
            }

            const symRows = matches.length
                ? matches.map(m => {
                    const range = m.end_line > m.start_line ? `L${m.start_line}-${m.end_line}` : `L${m.start_line}`;
                    const p = m.params || '';
                    return `
                        <div style="border-bottom: 1px solid var(--border); padding: 7px 10px; display:flex; justify-content:space-between; align-items:center; gap:8px; font-family:var(--font-mono); font-size:11.5px;">
                            <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                <span style="color:var(--magenta);">${esc(m.kind)}</span>
                                <span style="color:var(--fg); font-weight:600; margin-left:4px;">${esc(m.qualified_name)}</span><span class="dim">${esc(p)}</span>
                            </div>
                            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                                <span>${pathHtml(m.file)}</span>
                                <span style="font-size:10px; padding:1px 6px; border-radius:4px; background:var(--bg-input); color:var(--green); border:1px solid var(--border);">${esc(range)}</span>
                            </div>
                        </div>`;
                }).join('')
                : `<div class="tool-ui-empty" style="padding:12px; color:var(--dim);">No definitions matching "${esc(symbolQuery)}" in ${esc(targetPath || 'root')}.</div>`;

            const capBanner = isCapped
                ? `<div style="padding:7px 10px; color:var(--yellow); font-size:11px; border-bottom:1px solid var(--border);">Showing ${matches.length} of ${totalMatches} matches.</div>`
                : '';
            const limitBanner = limitReason
                ? `<div style="padding:7px 10px; color:var(--yellow); font-size:11px; border-bottom:1px solid var(--border);">${esc(limitReason)}</div>`
                : '';

            await api.showUI(`
                <div class="tool-ui-wrap">
                    <div class="tool-ui-bar">
                        <div class="tool-ui-header-info">
                            <span class="icon" style="font-size:13px; color:var(--magenta); flex-shrink:0;">search</span>
                            <span style="font-size:12px; font-weight:600; color:var(--fg);">Symbol: ${esc(symbolQuery)}</span>
                        </div>
                        <div class="tool-ui-header-stats">
                            <span style="color:${matches.length ? 'var(--green)' : 'var(--dim)'}; font-weight:600;">${totalMatches} match${totalMatches === 1 ? '' : 'es'}</span>
                        </div>
                    </div>
                    <div style="max-height: 400px; overflow-y: auto;">
                        ${capBanner}${limitBanner}${buildSkippedNoticeHtml(skipped)}${symRows}
                    </div>
                </div>
            `);

            return {
                output: finalOutput,
                summary: `Map symbol "${symbolQuery}": ${totalMatches} match${totalMatches === 1 ? '' : 'es'}`
            };
        }

        // ==================== OUTLINE MODE ====================
        const totalFiles = candidateFiles.length;
        if (offset >= totalFiles) {
            const msg = `Offset ${offset} is out of range (only ${totalFiles} supported file${totalFiles === 1 ? '' : 's'} under ${targetPath || 'root'}).`;
            await api.showUI(`<div class="tool-ui-wrap"><div class="tool-ui-empty" style="padding:12px; color:var(--dim);">${esc(msg)}</div></div>`);
            const out = outFormat === 'json'
                ? JSON.stringify({ files: [], total_files: totalFiles, offset, returned: 0, next_offset: null, detail: requestedDetail === 'auto' ? 'full' : requestedDetail, skipped: [] })
                : msg;
            return { output: out, summary: `Map: ${targetPath || 'root'} (offset past end)` };
        }

        const remainingFiles = candidateFiles.slice(offset);
        let hitLimitReason = null;
        let filesForRun = remainingFiles;
        if (filesForRun.length > maxFiles) {
            filesForRun = filesForRun.slice(0, maxFiles);
            hitLimitReason = `maxFiles ceiling (${maxFiles}) reached`;
        }

        // Preload grammars up front in parallel for the files we may parse
        const initOk = await preloadGrammarsForPaths(filesForRun);
        if (!initOk) {
            const msg = `Failed to initialize Tree-sitter: ${ctx.initError}`;
            return {
                output: outFormat === 'json' ? JSON.stringify({ error: msg }) : msg,
                summary: 'Map error: Tree-sitter init failed'
            };
        }

        const prefetcher = createPrefetcher(filesForRun, api, maxFileBytes, READ_CONCURRENCY);
        const entries = [];
        let runningCharsEstimate = 0;
        const canEarlyStop = (requestedDetail === 'full' || requestedDetail === 'top');

        for (let i = 0; i < filesForRun.length; i++) {
            if (i > 0 && Date.now() - startedAt >= WALL_CLOCK_BUDGET_MS) {
                hitLimitReason = `time budget (${WALL_CLOCK_BUDGET_MS / 1000}s) reached`;
                break;
            }

            const fp = filesForRun[i];
            await progress.update(
                `Parsing ${i + 1}/${filesForRun.length}: ${fp}`,
                `<div class="tool-ui-wrap" style="padding: 12px; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="running-tool-spinner"></div>
                        <span style="color:var(--dim); font-size:12px;">Parsing ${i + 1}/${filesForRun.length}...</span>
                    </div>
                    <div style="font-family:var(--font-mono); font-size:11px; color:var(--primary);">${esc(fp)}</div>
                </div>`
            );

            const readRes = await prefetcher.get(i);
            if (!readRes.ok) {
                entries.push({ fp, ok: false, reason: readRes.reason });
                continue;
            }

            const mapRes = await mapOneFile(fp, readRes.content, ctx);
            if (!mapRes.ok) {
                entries.push({ fp, ok: false, reason: mapRes.reason });
                continue;
            }

            entries.push({ fp, ok: true, fileData: mapRes.fileData });

            // Early-stop for explicit full/top once we clearly exceed maxOutputChars
            if (canEarlyStop) {
                const piece = outFormat === 'json'
                    ? JSON.stringify(compactFileForJson(mapRes.fileData, requestedDetail))
                    : renderFileText(mapRes.fileData, requestedDetail, offset + i + 1);
                runningCharsEstimate += piece.length + 4;
                if (runningCharsEstimate > maxOutputChars + 500) {
                    break;
                }
            }
        }

        const paged = budgetAndPage(entries, {
            outFormat,
            requestedDetail,
            maxOutputChars,
            offset,
            totalFiles,
            targetPath,
            hitLimitReason
        });

        // Build UI card for the returned slice
        const coveredEntries = entries.slice(0, paged.countCovered);
        const mappedInPage = coveredEntries.filter(e => e.ok).map(e => e.fileData);
        const skippedInPage = paged.skipped || [];

        const uiRows = mappedInPage.slice(0, 100).map(buildFileUiRow).join('');
        const uiMoreFiles = mappedInPage.length > 100
            ? `<div style="padding:8px; text-align:center; color:var(--dim); font-size:11px;">... and ${mappedInPage.length - 100} more files mapped</div>`
            : '';

        const pagingBanner = paged.nextOffset !== null
            ? `<div style="padding:8px; text-align:center; color:var(--yellow); font-size:11px; border-bottom:1px solid var(--border);">Showing files ${offset + 1}-${offset + paged.countCovered} of ${totalFiles} (detail: ${esc(paged.detail)}; next offset: ${paged.nextOffset}).</div>`
            : (requestedDetail === 'auto' && paged.detail !== 'full'
                ? `<div style="padding:8px; text-align:center; color:var(--dim); font-size:11px; border-bottom:1px solid var(--border);">Output auto-degraded to ${esc(paged.detail)} detail to fit budget.</div>`
                : '');

        await api.showUI(`
            <div class="tool-ui-wrap">
                <div class="tool-ui-bar">
                    <div class="tool-ui-header-info">
                        <span class="icon" style="font-size:13px; color:var(--magenta); flex-shrink:0;">account_tree</span>
                        <span style="font-size:12px; font-weight:600; color:var(--fg);">Codebase Map</span>
                    </div>
                    <div class="tool-ui-header-stats">
                        <span style="color:var(--green); font-weight:600;">${mappedInPage.length} file${mappedInPage.length === 1 ? '' : 's'} mapped</span>
                    </div>
                </div>
                <div style="max-height: 400px; overflow-y: auto;">
                    ${pagingBanner}${buildSkippedNoticeHtml(skippedInPage)}${uiRows}${uiMoreFiles}
                </div>
            </div>
        `);

        const pageNote = paged.nextOffset !== null ? `, ${offset + 1}-${offset + paged.countCovered}/${totalFiles}` : '';
        return {
            output: paged.str,
            summary: `Map: ${targetPath || 'root'} (${mappedInPage.length} files${pageNote})`
        };
    } finally {
        if (ctx.parser) {
            try { ctx.parser.delete(); } catch (_) {}
            ctx.parser = null;
        }
    }
}