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
    '.swift': 'swift'
};

const languageCache = {};

// --- Handler -----------------------------------------------------------------
async function handler(args, api) {
    const targetPath = (args.path || '').replace(/^\/+/, '');
    const outFormat = args.format || 'json';
    
    let allowedExts = Array.isArray(args.extensions) && args.extensions.length > 0 
        ? args.extensions.map(e => e.toLowerCase())
        : Object.keys(EXT_TO_LANG);

    await api.setHeaderMsg("Scanning workspace...");
    
    const allFiles = await api.listFiles();
    let filesToMap = allFiles.filter(fp => {
        if (targetPath && !fp.startsWith(targetPath + '/') && fp !== targetPath) return false;
        const extMatch = fp.match(/\.[0-9a-z_]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        return allowedExts.includes(ext) && !!EXT_TO_LANG[ext];
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

    // --- Initialize Tree-sitter ---
    if (typeof globalThis.TreeSitter === 'undefined') {
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

    const TreeSitter = globalThis.TreeSitter;
    const parser = new TreeSitter();

    const results = [];
    const uiHtmlRows = [];
    let parsedCount = 0;

    // --- Process Files ---
    for (const fp of filesToMap) {
        const extMatch = fp.match(/\.[0-9a-z_]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        const langName = EXT_TO_LANG[ext];
        if (!langName) continue;

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
                const url = `https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-${langName}.wasm`;
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
        
        const tree = parser.parse(content);
        
        // Extract structured symbols without drilling into inner function bodies
        function extractSymbol(node) {
            if (node.type.includes('comment') || node.type.includes('string')) return null;

            let isExp = node.parent && node.parent.type.includes('export');
            
            if (node.type.includes('class') || node.type.includes('struct') || node.type.includes('interface') || node.type.includes('trait')) {
                let nameNode = node.childForFieldName('name') || node.children.find(c => c.type === 'identifier' || c.type === 'type_identifier');
                if (nameNode) {
                    return { kind: 'class', name: nameNode.text, ln: nameNode.startPosition.row + 1, export: !!isExp };
                }
            }

            let isFunc = (node.type.includes('function') && node.type !== 'arrow_function') || node.type.includes('method');
            let assignedName = null;
            let isVar = false;
            
            // Catch assigned arrow functions or variable assignments
            if (!isFunc && (node.type === 'variable_declaration' || node.type === 'lexical_declaration')) {
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
                let res = { kind: 'var', name: assignedName, ln: node.startPosition.row + 1 };
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

        const symbols = extractSymbols(tree.rootNode);
        tree.delete(); // Free WASM memory

        const fileData = {
            file: fp,
            lines: linesCount,
            size: sizeBytes
        };
        if (symbols.length > 0) fileData.symbols = symbols;

        results.push(fileData);

        // --- Build UI Representation ---
        function renderTextTree(fd) {
            let out = [];
            
            function renderSym(s, indent) {
                let line = `${indent}`;
                if (s.kind === 'class') {
                    line += `class ${s.name} :${s.ln}`;
                } else if (s.kind === 'var') {
                    line += `var ${s.name} :${s.ln}`;
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
        
        uiHtmlRows.push(`
            <div style="border-bottom: 1px solid var(--border); padding: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-family:var(--font-mono); font-size:12px;">${pathHtml(fp)} <span class="dim" style="margin-left:6px; font-size:10px;">(${linesCount} lines, ${(sizeBytes/1024).toFixed(1)}kb)</span></div>
                    <span style="font-size:10px; padding:2px 6px; border-radius:10px; background:var(--bg-input); color:${badgeColor}; border:1px solid var(--border);">
                        ${nodeCount} nodes
                    </span>
                </div>
                ${uiText.trim() ? `<pre style="margin:8px 0 0 0; padding:8px; background:var(--bg-input); border-radius:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; line-height:1.4; overflow-x:auto;">${esc(uiText)}</pre>` : ''}
            </div>
        `);

        parsedCount++;
    }

    parser.delete();

    // Generate output for LLM
    let finalOutput = '';
    if (outFormat === 'json') {
        finalOutput = JSON.stringify(results);
    } else {
        const textBlocks = results.map(fd => {
            let out = [];
            out.push(`[${results.indexOf(fd) + 1}] ${fd.file}  (${fd.lines} lines, ${(fd.size/1024).toFixed(1)}kb)`);
            function recurseText(s, indent) {
                let p = s.params || (s.kind === 'class' || s.kind === 'var' ? '' : '()');
                let kindStr = s.kind === 'class' ? 'class ' : (s.kind === 'var' ? 'var ' : '');
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