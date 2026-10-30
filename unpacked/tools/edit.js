// edit - tool definition.
const TOOL_META = {
    "name": "edit",
    "description": "Make targeted edits to a file by replacing an exact code block. To delete code, pass an empty string for replace_block.",
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
    "toolBox": 1
};

async function handler(args, api) {

    // --- Search & Replace Helpers --------------------------------------------

    function detectIndentation(lines) {
        for (const line of lines) {
            if (line.startsWith('\t')) return { type: 'tab', char: '\t' };
            if (line.startsWith('    ')) return { type: 'space4', char: '    ' };
            if (line.startsWith('  ')) return { type: 'space2', char: '  ' };
        }
        return { type: 'space4', char: '    ' };
    }

    function applySearchReplace(original, searchBlock, replaceBlock) {
        const usesCRLF = String(original == null ? '' : original).includes('\r\n');
        const normalize = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');
        const toFileEol = s => usesCRLF ? s.replace(/\n/g, '\r\n') : s;

        const orig   = normalize(original);
        const sBlock = normalize(searchBlock);
        const rBlock = normalize(replaceBlock);

        // Fast path: exact match
        const directIdx = orig.indexOf(sBlock);
        if (directIdx !== -1) {
            const before = orig.slice(0, directIdx);
            const after  = orig.slice(directIdx + sBlock.length);
            const res = before + rBlock + after;
            const startLine = before.split('\n').length;
            return { content: toFileEol(res), lineNumber: startLine };
        }

        // Fallback: line-by-line trim-aware match
        const origLines = orig.split('\n');
        const sLines    = sBlock.split('\n');
        const rLines    = rBlock.split('\n');
        const fileIndent = detectIndentation(origLines);

        let matchIdx = -1;
        for (let i = 0; i <= origLines.length - sLines.length; i++) {
            let match = true;
            for (let j = 0; j < sLines.length; j++) {
                if (origLines[i + j].trim() !== sLines[j].trim()) {
                    match = false;
                    break;
                }
            }
            if (match) {
                matchIdx = i;
                break;
            }
        }

        if (matchIdx !== -1) {
            const origLead = origLines[matchIdx].match(/^\s*/)[0];
            const sLead    = sLines[0].match(/^\s*/)[0];

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

            const before = origLines.slice(0, matchIdx).join('\n');
            const after  = origLines.slice(matchIdx + sLines.length).join('\n');
            const res = (before ? before + '\n' : '') + adjustedRLines.join('\n') + (after ? '\n' + after : '');
            return { content: toFileEol(res), lineNumber: matchIdx + 1 };
        }

        throw new Error("Could not find search_block in target file.");
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Modern Failure View for when search or writes fail
    function renderErrorHtml(filepath, errorMessage) {
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

    try {
        const originalContent = await api.readFile(args.filepath);
        const result = applySearchReplace(originalContent, args.search_block, args.replace_block || "");
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

        const linesRemoved = searchLines.length;
        const linesAdded   = replaceLines.length;
        const delta        = linesAdded - linesRemoved;

        const startLineNum = result.lineNumber;
        const endLineNum   = linesRemoved > 0 ? startLineNum + linesRemoved - 1 : startLineNum;
        const rangeText    = linesRemoved > 1 
            ? `L${startLineNum}–L${endLineNum}` 
            : (linesRemoved === 1 ? `L${startLineNum}` : `L${startLineNum} (ins)`);

        const totalFileLines = result.content.split(/\r?\n/).length;

        // Split filename from directory path for clean breadcrumbs
        const pathParts = args.filepath.split('/');
        const fileName  = pathParts.pop();
        const dirPath   = pathParts.length ? pathParts.join('/') + '/' : '';

        // --- Character-Level Diff Highlight (Single-Line Edits) --------------

        let intraLineDel = null;
        let intraLineAdd = null;

        if (linesRemoved === 1 && linesAdded === 1) {
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
            const lineContent = (linesRemoved === 1 && linesAdded === 1 && intraLineDel) ? intraLineDel : escapeHtml(l);
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
            const lineContent = (linesRemoved === 1 && linesAdded === 1 && intraLineAdd) ? intraLineAdd : escapeHtml(l);
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
                        <span>Applied at line ${startLineNum}</span>
                    </div>
                    <span style="opacity:0.6;">${totalFileLines} total lines</span>
                </div>
            </div>
        `;

        const resultText = `Edited ${args.filepath} at ${rangeText}`;
        const summary = `${args.filepath}:${startLineNum}`;

        await api.showUI(displayHtml);
        return { output: resultText, summary };
    } catch(e) { 
        await api.showUI(renderErrorHtml(args.filepath, e.message));
        return { output: `ERROR: ${e.message}` }; 
    }
}