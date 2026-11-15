// map - tool definition.
const TOOL_META = {
    name: "map",
    description: "Map the structure of the codebase using Tree-sitter AST parsing. Extracts function and class definitions for specified directories to give the model a high-level overview of the code architecture.",
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
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c]));
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
        return { output: "No files found matching the criteria.", summary: `Map: ${targetPath || 'root'} (0 files)` };
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
            // Depending on the sandbox environment, importScripts may be available. 
            // If not, we fallback to fetch + eval.
            if (typeof importScripts === 'function') {
                importScripts('https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/tree-sitter.js');
            } else {
                const scriptRes = await fetch('https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/tree-sitter.js');
                const scriptText = await scriptRes.text();
                eval(scriptText);
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
            return { output: `Failed to initialize Tree-sitter: ${err.message}` };
        }
    }

    const TreeSitter = globalThis.TreeSitter;
    const parser = new TreeSitter();

    const outputLines = [];
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

        const tree = parser.parse(content);
        const outlines = [];
        
        // Generalized AST Walker
        function walk(node, indent) {
            const type = node.type;
            const isInteresting = /class|function|method|struct|interface|impl/i.test(type) && !/call|invocation/i.test(type);
            
            let nextIndent = indent;
            
            if (isInteresting) {
                // Heuristic: Try to find a named field, or default to the first identifier
                let nameNode = node.childForFieldName('name');
                if (!nameNode) {
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (child.type.includes('identifier')) {
                            nameNode = child;
                            break;
                        }
                    }
                }

                if (nameNode) {
                    const cleanType = type.replace(/_definition|_declaration|_item|_specifier/g, '');
                    outlines.push(`${indent}- [${cleanType}] ${nameNode.text}`);
                    nextIndent += '  ';
                }
            }

            for (let i = 0; i < node.childCount; i++) {
                walk(node.child(i), nextIndent);
            }
        }

        walk(tree.rootNode, '  ');
        tree.delete(); // Free WASM memory

        outputLines.push(`${fp}:`);
        if (outlines.length > 0) {
            outputLines.push(outlines.join('\n'));
        } else {
            outputLines.push('  (No top-level functions/classes found)');
        }
        outputLines.push(''); // Blank line padding

        // Build UI row
        let badgeColor = outlines.length > 0 ? 'var(--green)' : 'var(--dim)';
        
        uiHtmlRows.push(`
            <div style="border-bottom: 1px solid var(--border); padding: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-family:var(--font-mono); font-size:12px;">${pathHtml(fp)}</div>
                    <span style="font-size:10px; padding:2px 6px; border-radius:10px; background:var(--bg-input); color:${badgeColor}; border:1px solid var(--border);">
                        ${outlines.length} nodes
                    </span>
                </div>
                ${outlines.length > 0 ? `<pre style="margin:8px 0 0 0; padding:8px; background:var(--bg-input); border-radius:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; line-height:1.4; overflow-x:auto;">${esc(outlines.join('\n'))}</pre>` : ''}
            </div>
        `);

        parsedCount++;
    }

    parser.delete(); // Cleanup parser memory

    const finalOutput = outputLines.join('\n');
    
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