// map - tool definition.
const TOOL_META = {
    name: "map",
    description: "Map the structure of the codebase using Tree-sitter AST parsing. Extracts accurate function signatures, classes, async/export markers, and line numbers to build a precise navigation index.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Directory path to map (e.g., 'src' or ''). Defaults to root.",
                allowEmpty: true
            },
            extensions: {
                type: "array",
                items: { type: "string" },
                description: "File extensions to include (e.g., ['.js', '.py']). Defaults to all supported languages."
            },
            format: {
                type: "string",
                enum: ["json", "text"],
                description: "Output format for the LLM. JSON is strictly preferred for programmatic consumption; text is human-readable."
            }
        },
        required: ["path"]
    },
    modes: ["plan", "ask", "code"],
    permission: "always",
    toolBox: 1,
    settings: [
        {
            key: "maxFiles",
            label: "Max Files to Parse",
            type: "number",
            default: 50,
            min: 1,
            max: 500,
            description: "Limit the number of files mapped in a single run."
        }
    ]
};

// --- UI helpers -------------------------------------------------------------
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

// --- Non-AST Summarizers ----------------------------------------------------
function truncateLines(lines, limit = 20) {
    if (lines.length <= limit) return lines.join('\n');
    return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
}

function summarizeText(content) {
    return truncateLines(content.split('\n'));
}

function summarizeMarkdown(content) {
    const lines = content.split('\n').filter(line => line.trim().startsWith('#'));
    if (!lines.length) return summarizeText(content);
    return truncateLines(lines);
}

function summarizeStructuredData(data) {
    const lines = [];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object') {
                const typeName = Array.isArray(v) ? 'List' : 'Dict';
                const len = Array.isArray(v) ? v.length : Object.keys(v).length;
                lines.push(`"${k}": <${typeName} len=${len}>`);
            } else {
                let valStr = String(v);
                if (valStr.length > 50) valStr = valStr.slice(0, 47) + "...";
                lines.push(`"${k}": ${valStr}`);
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
        return summarizeStructuredData(data);
    } catch (e) {
        return "(Invalid JSON) " + summarizeText(content);
    }
}

async function summarizeYaml(content) {
    try {
        if (typeof globalThis.jsyaml === 'undefined') {
            if (typeof importScripts === 'function') {
                importScripts('https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js');
            } else {
                const scriptRes = await fetch('https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js');
                const scriptText = await scriptRes.text();
                (new Function(scriptText))();
            }
        }
        const data = globalThis.jsyaml.load(content);
        if (!data || typeof data !== 'object') return summarizeText(content);
        return summarizeStructuredData(data);
    } catch (e) {
        return "(YAML Error) " + summarizeText(content);
    }
}

// --- Grammar Mappings --------------------------------------------------------
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
        (rule_set selectors: (selectors) @css.selector)
        (media_statement (media_query) @css.media)
    `,
    html: `
        (element 
            (start_tag 
                (tag_name) @html.tag
                (attribute 
                    (attribute_name) @attr.name (#eq? @attr.name "id")
                    (quoted_attribute_value) @attr.value))) @html.element
    `,
    fortran: `
        (module_statement name: (identifier) @class.name)
        (subroutine_statement name: (identifier) @fn.name)
        (function_statement name: (identifier) @fn.name)
    `,
    matlab: `
        (classdef_statement name: (identifier) @class.name)
        (function_definition name: (identifier) @fn.name parameters: (parameters)? @fn.params)
    `,
    julia: `
        (module_definition name: (identifier) @class.name)
        (struct_definition name: (identifier) @class.name)
        (function_definition name: (identifier) @fn.name)
        (macro_definition name: (identifier) @fn.name)
    `
};

const languageCache = {};

// --- Handler -----------------------------------------------------------------
async function handler(args, api) {
    const targetPath = (args.path || '').replace(/^\/+/, '');
    const outFormat = args.format || 'json';
    
    let allowedExts = Array.isArray(args.extensions) && args.extensions.length > 0 
        ? args.extensions.map(e => e.toLowerCase())
        : [...Object.keys(EXT_TO_LANG), ...Object.keys(NON_AST_EXTS)];

    await api.setHeaderMsg("Scanning workspace...");
    
    const allFiles = await api.listFiles();
    let filesToMap = allFiles.filter(fp => {
        if (targetPath && !fp.startsWith(targetPath + '/') && fp !== targetPath) return false;
        const extMatch = fp.match(/\.[0-9a-z_]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        return allowedExts.includes(ext) && (!!EXT_TO_LANG[ext] || !!NON_AST_EXTS[ext]);
    });

    if (filesToMap.length === 0) {
        await api.showUI(`<div class="tool-ui-wrap"><div class="tool-ui-empty" style="padding:12px; color:var(--dim);">No supported files found in ${esc(targetPath || 'root')}.</div></div>`);
        return { output: outFormat === 'json' ? "[]" : "No files found matching the criteria.", summary: `Map: ${targetPath || 'root'} (0 files)` };
    }

    let maxFiles = Number(await api.getSetting('maxFiles'));
    if (!Number.isFinite(maxFiles) || maxFiles < 1) maxFiles = 50;

    let hiddenCount = 0;
    if (filesToMap.length > maxFiles) {
        hiddenCount = filesToMap.length - maxFiles;
        filesToMap = filesToMap.slice(0, maxFiles);
    }

    const hasAstFiles = filesToMap.some(fp => {
        const extMatch = fp.match(/\.[0-9a-z_]+$/i);
        return extMatch && EXT_TO_LANG[extMatch[0].toLowerCase()];
    });

    // --- Initialize Tree-sitter ---
    if (hasAstFiles && typeof globalThis.TreeSitter === 'undefined') {
        await api.setHeaderMsg("Downloading Tree-sitter runtime...");
        await api.showUI(`
            <div class="tool-ui-wrap" style="padding: 12px; display:flex; align-items:center; gap:8px;">
                <div class="running-tool-spinner"></div>
                <span style="color:var(--dim); font-size:12px;">Booting Tree-sitter WebAssembly...</span>
            </div>
        `, { live: true });

        try {
            if (typeof importScripts === 'function') {
                importScripts('https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/tree-sitter.js');
            } else {
                const scriptRes = await fetch('https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/tree-sitter.js');
                const scriptText = await scriptRes.text();
                (new Function(scriptText))();
            }

            await globalThis.TreeSitter.init({
                locateFile: (path) => {
                    if (path === 'tree-sitter.wasm') {
                        return 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/tree-sitter.wasm';
                    }
                    return path;
                }
            });
        } catch (err) {
            return { output: outFormat === 'json' ? `{"error": "Failed to initialize Tree-sitter: ${err.message}"}` : `Failed to initialize Tree-sitter: ${err.message}` };
        }
    }

    let TreeSitter, parser;
    if (hasAstFiles) {
        TreeSitter = globalThis.TreeSitter;
        parser = new TreeSitter();
    }

    const results = [];
    const uiHtmlRows = [];
    let parsedCount = 0;

    // --- Process Files ---
    for (const fp of filesToMap) {
        const extMatch = fp.match(/\.[0-9a-z_]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        const langName = EXT_TO_LANG[ext];
        const nonAstLang = NON_AST_EXTS[ext];
        if (!langName && !nonAstLang) continue;

        await api.setHeaderMsg(`Parsing ${fp}...`);
        await api.showUI(`
            <div class="tool-ui-wrap" style="padding: 12px; display:flex; flex-direction:column; gap:8px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div class="running-tool-spinner"></div>
                    <span style="color:var(--dim); font-size:12px;">Parsing ${parsedCount + 1}/${filesToMap.length}...</span>
                </div>
                <div style="font-family:var(--font-mono); font-size:11px; color:var(--primary);">${esc(fp)}</div>
            </div>
        `, { live: true });

        // Load Grammar
        if (!languageCache[langName]) {
            try {
                let url = `https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-${langName}.wasm`;
                if (langName === 'matlab') {
                    url = 'https://cdn.jsdelivr.net/npm/@lumis-sh/wasm-matlab/tree-sitter-matlab.wasm';
                }
                languageCache[langName] = await TreeSitter.Language.load(url);
            } catch (e) {
                console.error(`Failed to load grammar ${langName}: `, e);
                continue;
            }
        }

        parser.setLanguage(languageCache[langName]);
        
        const content = await api.readFile(fp);
        if (typeof content !== 'string' || content.startsWith('ERROR:')) {
            continue;
        }

        const linesCount = content.split('\n').length;
        const sizeBytes = content.length;
        
        if (nonAstLang) {
            let rawSummary = "";
            if (nonAstLang === 'json') rawSummary = summarizeJson(content);
            else if (nonAstLang === 'yaml') rawSummary = await summarizeYaml(content);
            else if (nonAstLang === 'markdown') rawSummary = summarizeMarkdown(content);
            else rawSummary = summarizeText(content);
            
            const fileData = { file: fp, lines: linesCount, size: sizeBytes, rawSummary };
            results.push(fileData);
            
            uiHtmlRows.push(`
            <div style="border-bottom: 1px solid var(--border); padding: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-family:var(--font-mono); font-size:12px;">${pathHtml(fp)} <span class="dim" style="margin-left:6px; font-size:10px;">(${linesCount} lines, ${(sizeBytes/1024).toFixed(1)}kb) [${nonAstLang}]</span></div>
                </div>
                <pre style="margin:8px 0 0 0; padding:8px; background:var(--bg-input); border-radius:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; line-height:1.4; overflow-x:auto;">${esc(rawSummary)}</pre>
            </div>
        `);
            parsedCount++;
            continue;
        }

        const tree = parser.parse(content);
        
        const imports = new Set();
        const exportedNames = new Set();

        // Pass 1: Extract imports and explicit window.X exports
        for (let i = 0; i < tree.rootNode.childCount; i++) {
            const child = tree.rootNode.child(i);
            if (child.type === 'import_statement') {
                child.children.forEach(c => {
                    if (c.type === 'dotted_name') imports.add(c.text);
                    else if (c.type === 'aliased_import') {
                        let dn = c.children.find(cc => cc.type === 'dotted_name');
                        if (dn) imports.add(dn.text);
                    }
                });
            } else if (child.type === 'import_from_statement') {
                let nameNode = child.childForFieldName('module_name');
                if (nameNode) imports.add(nameNode.text);
            } else if (child.type.includes('import') || child.type.includes('use_declaration') || (child.type === 'expression_statement' && child.text.includes('require('))) {
                let match = child.text.match(/['"]([^'"]+)['"]/);
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
            }
        }

        // Pass 2: Extract structured symbols without drilling into inner function bodies
        function extractSymbol(node) {
            if (node.type.includes('comment') || node.type.includes('string')) return null;

            let isExp = node.parent && node.parent.type.includes('export');
            
            if (node.type.includes('class') || node.type.includes('struct') || node.type.includes('interface') || node.type.includes('trait')) {
                let nameNode = node.childForFieldName('name') || node.children.find(c => c.type === 'identifier' || c.type === 'type_identifier');
                if (nameNode) {
                    if (exportedNames.has(nameNode.text)) isExp = true;
                    return { kind: 'class', name: nameNode.text, ln: nameNode.startPosition.row + 1, export: !!isExp };
                }
            }

            let isFunc = (node.type.includes('function') && node.type !== 'arrow_function') || node.type.includes('method');
            let assignedName = null;
            let isVar = false;
            let declToken = 'var';
            
            // Catch assigned arrow functions or variable assignments
            if (!isFunc && (node.type === 'variable_declaration' || node.type === 'lexical_declaration')) {
                 declToken = node.child(0) ? node.child(0).text : 'var';
                 if (!['const', 'let', 'var'].includes(declToken)) declToken = 'var';

                 let decl = node.children.find(c => c.type === 'variable_declarator');
                 if (decl) {
                     let nameNode = decl.childForFieldName('name') || decl.children.find(c => c.type === 'identifier');
                     if (nameNode) assignedName = nameNode.text;
                     
                     let val = decl.childForFieldName('value');
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
                if (!name) {
                    let nameNode = node.childForFieldName('name') || node.children.find(c => c.type === 'identifier' || c.type === 'property_identifier');
                    if (nameNode) name = nameNode.text;
                }
                
                // Drop anonymous functions / callbacks
                if (!name) return null;

                if (name === 'constructor' || name === '__init__') kind = 'ctor';
                if (exportedNames.has(name)) isExp = true;

                let isAsync = node.children.some(c => c.type === 'async' || c.text === 'async');
                
                let params = null;
                let paramNode = node.children.find(c => c.type.includes('parameters') || c.type === 'formal_parameters');
                if (paramNode) {
                    params = paramNode.text.replace(/\s+/g, ' ');
                    if (params.length > 50) params = params.slice(0, 49) + '…';
                }

                let res = { kind, name, ln: node.startPosition.row + 1 };
                if (params) res.params = params;
                if (isAsync) res.async = true;
                if (isExp) res.export = true;
                return res;
            }

            if (isVar) {
                if (exportedNames.has(assignedName)) isExp = true;
                let res = { kind: declToken, name: assignedName, ln: node.startPosition.row + 1 };
                if (isExp) res.export = true;
                return res;
            }

            return null;
        }

        function extractSymbols(node) {
            const syms = [];
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                let sym = extractSymbol(child);
                if (sym) {
                    if (sym.kind === 'class') {
                        let bodyNode = child.children.find(c => c.type.includes('body') || c.type === 'declaration_list' || c.type === 'block');
                        if (bodyNode) {
                            let members = extractSymbols(bodyNode);
                            if (members.length > 0) sym.members = members;
                        }
                    }
                    syms.push(sym);
                } else {
                    // Recurse into containers like exports, namespaces, blocks. Do NOT recurse into function bodies.
                    if (!child.type.includes('function') && !child.type.includes('method') && !child.type.includes('class') && !child.type.includes('string')) {
                        syms.push(...extractSymbols(child));
                    }
                }
            }
            return syms;
        }

        let symbols = [];
        const queryStr = LANGUAGE_QUERIES[langName];

        if (queryStr) {
            try {
                const query = languageCache[langName].query(queryStr);
                const matches = query.matches(tree.rootNode);
                const rawSymbols = [];
                
                for (const match of matches) {
                    let kind = 'unknown';
                    let name = 'unknown';
                    let ln = 1;
                    let params = null;
                    let isAsync = false;
                    let tag = '';
                    let idVal = '';
                    let mainNode = null;

                    for (const capture of match.captures) {
                        if (capture.name === 'class.name') {
                            kind = 'class';
                            name = capture.node.text;
                            ln = capture.node.startPosition.row + 1;
                            mainNode = capture.node.parent || capture.node;
                        } else if (capture.name === 'fn.name') {
                            kind = 'fn';
                            name = capture.node.text;
                            ln = capture.node.startPosition.row + 1;
                            mainNode = capture.node.parent || capture.node;
                        } else if (capture.name === 'fn.params') {
                            params = capture.node.text.replace(/\s+/g, ' ');
                            if (params.length > 50) params = params.slice(0, 49) + '…';
                        } else if (capture.name === 'fn.def') {
                            if (capture.node.text.startsWith('async ')) {
                                isAsync = true;
                            }
                        } else if (capture.name === 'css.selector') {
                            kind = 'rule';
                            name = capture.node.text.replace(/\s+/g, ' ').replace(/\n/g, '');
                            if (name.length > 50) name = name.slice(0, 49) + '…';
                            ln = capture.node.startPosition.row + 1;
                            mainNode = capture.node.parent || capture.node;
                        } else if (capture.name === 'css.media') {
                            kind = 'media';
                            name = capture.node.text.replace(/\s+/g, ' ').replace(/\n/g, '');
                            if (name.length > 50) name = name.slice(0, 49) + '…';
                            ln = capture.node.startPosition.row + 1;
                            mainNode = capture.node.parent || capture.node;
                        } else if (capture.name === 'html.element') {
                            kind = 'tag';
                            ln = capture.node.startPosition.row + 1;
                            mainNode = capture.node;
                        } else if (capture.name === 'html.tag') {
                            tag = capture.node.text;
                        } else if (capture.name === 'attr.value') {
                            idVal = capture.node.text.replace(/['"]/g, '');
                        }
                    }
                    
                    if (kind === 'tag') {
                        name = (tag || 'element') + (idVal ? '#' + idVal : '');
                    }

                    if (kind !== 'unknown') {
                        if (langName === 'python' && params) {
                            params = params.replace(/^\(\s*(?:self|cls)\b[^,)]*(?:,\s*)?/, '(');
                        }
                        
                        let sym = { kind, name, ln, _node: mainNode };
                        if (params) sym.params = params;
                        if (isAsync) sym.async = true;
                        
                        if (!rawSymbols.some(s => s.kind === sym.kind && s.name === sym.name && s.ln === sym.ln)) {
                            rawSymbols.push(sym);
                        }
                    }
                }

                // Reconstruct AST nesting
                const nodeToSym = new Map();
                rawSymbols.forEach(s => {
                    if (s._node && s._node.id !== undefined) nodeToSym.set(s._node.id, s);
                });

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

                    delete sym._node; // cleanup

                    if (parentSym) {
                        if (!parentSym.members) parentSym.members = [];
                        parentSym.members.push(sym);
                    } else {
                        symbols.push(sym);
                    }
                }
            } catch (e) {
                console.error(`Query error for ${langName}:`, e);
            }
        } else {
            symbols = extractSymbols(tree.rootNode);
        }

        tree.delete(); // Free WASM memory

        let fns = 0, vars = 0, classes = 0, asyncs = 0;
        function tally(syms) {
            for (let s of syms) {
                if (s.kind === 'class') classes++;
                else if (s.kind === 'fn' || s.kind === 'ctor') { fns++; if (s.async) asyncs++; }
                else if (s.kind === 'const' || s.kind === 'let' || s.kind === 'var') vars++;
                if (s.members) tally(s.members);
            }
        }
        tally(symbols);
        const stats = { fns, vars, classes, asyncs };

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

        results.push(fileData);

        // --- Build UI Representation ---
        function renderTextTree(fd) {
            let out = [];
            
            function renderSym(s, indent) {
                let line = `${indent}`;
                const isVarKind = s.kind === 'const' || s.kind === 'let' || s.kind === 'var';
                if (s.kind === 'class' || s.kind === 'tag' || s.kind === 'rule' || s.kind === 'media') {
                    line += `${s.kind} ${s.name} :${s.ln}`;
                } else if (isVarKind) {
                    line += `${s.kind} ${s.name} :${s.ln}`;
                } else {
                    let p = s.params || '()';
                    line += `${s.name}${p} :${s.ln}`;
                    if (s.async) line += `  async`;
                }
                if (s.export) line += `  (export)`;
                out.push(line);
                if (s.members) {
                    for (let child of s.members) renderSym(child, indent + '  ');
                }
            }

            if (fd.symbols && fd.symbols.length) {
                fd.symbols.forEach(s => renderSym(s, '  '));
            } else {
                out.push('  (No structures found)');
            }
            return out.join('\n');
        }

        const uiText = renderTextTree(fileData);
        let badgeColor = symbols.length > 0 ? 'var(--green)' : 'var(--dim)';
        let nodeCount = symbols.length + symbols.reduce((acc, s) => acc + (s.members ? s.members.length : 0), 0);
        let statsStr = `fns: ${fns}, vars: ${vars}, classes: ${classes}, async: ${asyncs}`;
        
        uiHtmlRows.push(`
            <div style="border-bottom: 1px solid var(--border); padding: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-family:var(--font-mono); font-size:12px;">${pathHtml(fp)} <span class="dim" style="margin-left:6px; font-size:10px;">(${linesCount} lines, ${(sizeBytes/1024).toFixed(1)}kb) [${statsStr}]</span></div>
                    <span style="font-size:10px; padding:2px 6px; border-radius:10px; background:var(--bg-input); color:${badgeColor}; border:1px solid var(--border);">
                        ${nodeCount} nodes
                    </span>
                </div>
                ${uiText.trim() ? `<pre style="margin:8px 0 0 0; padding:8px; background:var(--bg-input); border-radius:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; line-height:1.4; overflow-x:auto;">${esc(uiText)}</pre>` : ''}
            </div>
        `);

        parsedCount++;
    }

    if (parser) parser.delete(); // Cleanup parser memory

    // Generate output for LLM
    let finalOutput = '';
    if (outFormat === 'json') {
        finalOutput = JSON.stringify(results);
    } else {
        const textBlocks = results.map(fd => {
            let out = [];
            if (fd.rawSummary !== undefined) {
                out.push(`[${results.indexOf(fd) + 1}] ${fd.file}  (${fd.lines} lines, ${(fd.size/1024).toFixed(1)}kb) [data/text]`);
                out.push(fd.rawSummary.split('\n').map(l => `  ${l}`).join('\n'));
                return out.join('\n');
            }
            let st = fd.stats || { fns: 0, vars: 0, classes: 0, asyncs: 0 };
            out.push(`[${results.indexOf(fd) + 1}] ${fd.file}  (${fd.lines} lines, ${(fd.size/1024).toFixed(1)}kb) [fns: ${st.fns}, vars: ${st.vars}, classes: ${st.classes}, async: ${st.asyncs}]`);
            if (fd.imports && fd.imports.length) out.push(`  Imports: ${fd.imports.join(', ')}`);
            function recurseText(s, indent) {
                const isVarKind = s.kind === 'const' || s.kind === 'let' || s.kind === 'var';
                const isNoParens = s.kind === 'class' || isVarKind || s.kind === 'tag' || s.kind === 'rule' || s.kind === 'media';
                let p = s.params || (isNoParens ? '' : '()');
                let kindStr = (s.kind === 'class' || s.kind === 'tag' || s.kind === 'rule' || s.kind === 'media') ? `${s.kind} ` : (isVarKind ? `${s.kind} ` : '');
                let line = `${indent}${kindStr}${s.name}${p} :${s.ln}${s.async ? '  async' : ''}${s.export ? '  (export)' : ''}`;
                out.push(line);
                if (s.members) s.members.forEach(c => recurseText(c, indent + '  '));
            }
            if (fd.symbols && fd.symbols.length) fd.symbols.forEach(s => recurseText(s, '  '));
            else out.push('  (No structures found)');
            return out.join('\n');
        });
        finalOutput = textBlocks.join('\n\n');
    }
    
    let hiddenNotice = '';
    if (hiddenCount > 0) {
        hiddenNotice = `<div style="padding:8px; text-align:center; color:var(--yellow); font-size:11px; border-bottom:1px solid var(--border);">... and ${hiddenCount} more files omitted (Max Files limit reached, consider scoping the 'path' parameter).</div>`;
    }

    const displayHtml = `
        <div class="tool-ui-wrap">
            <div class="tool-ui-bar">
                <div class="tool-ui-header-info">
                    <span class="icon" style="font-size:13px; color:var(--magenta); flex-shrink:0;">account_tree</span>
                    <span style="font-size:12px; font-weight:600; color:var(--fg);">Codebase Map</span>
                </div>
                <div class="tool-ui-header-stats">
                    <span style="color:var(--green); font-weight:600;">${parsedCount} file${parsedCount === 1 ? '' : 's'} mapped</span>
                </div>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                ${hiddenNotice}
                ${uiHtmlRows.join('')}
            </div>
        </div>
    `;

    await api.showUI(displayHtml);

    return {
        output: finalOutput,
        summary: `Map: ${targetPath || 'root'} (${parsedCount} files)`
    };
}