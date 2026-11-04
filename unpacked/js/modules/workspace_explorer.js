// --- applyExplorerModifierClick.js ---
// Applies a Shift / Ctrl(Cmd) click to the selection. Returns true when it was a modified click.
function applyExplorerModifierClick(path, e) {
    const range = e.shiftKey, additive = e.ctrlKey || e.metaKey;
    if (!range && !additive) return false;
    const rows = visibleExplorerPaths();
    // Selection currently shown as highlighted (may be just the active tab).
    const current = explorerSelection.size ? Array.from(explorerSelection)
        : (!explorerSelectionCleared && rows.includes(state.activeTab) ? [state.activeTab] : []);

    if (range) {
        let anchor = explorerAnchor && rows.includes(explorerAnchor) ? explorerAnchor : (current[0] && rows.includes(current[0]) ? current[0] : path);
        const a = rows.indexOf(anchor), b = rows.indexOf(path);
        const slice = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
        // Shift replaces the selection with the range; Ctrl+Shift adds the range to it.
        setExplorerSelection(additive ? [...current, ...slice] : slice, anchor);
    } else {
        const next = new Set(current);
        if (next.has(path)) next.delete(path); else next.add(path);
        setExplorerSelection(Array.from(next), path);
    }
    return true;
}

// --- AST_EXPORTS_START ---
window.applyExplorerModifierClick = applyExplorerModifierClick;
// --- AST_EXPORTS_END ---

// --- applySidebarWidth.js ---
function applySidebarWidth(w) {
    w = clampSidebarWidth(w);
    sidebarEl.style.width = w + 'px';
    resizerEl.classList.remove('hidden');
    return w;
}

// --- AST_EXPORTS_START ---
window.applySidebarWidth = applySidebarWidth;
// --- AST_EXPORTS_END ---

// --- buildHierarchicalTree.js ---
function buildHierarchicalTree() {
    const root = { name: rootHandle ? rootHandle.name : "workspace", path: "", kind: "directory", children: {} };
    const allPaths = Object.keys(registry.meta).sort();

    allPaths.forEach(p => {
        const parts = p.split('/');
        let curr = root;
        let currentPath = "";

        parts.forEach((part, idx) => {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const isLast = idx === parts.length - 1;

            if (isLast) {
                const meta = registry.meta[p];
                curr.children[part] = {
                    name: part,
                    path: currentPath,
                    kind: meta?.kind || 'file',
                    isBinary: meta?.isBinary || false,
                    size: meta?.size || 0,
                    children: meta?.kind === 'directory' ? {} : null
                };
            } else {
                if (!curr.children[part]) {
                    curr.children[part] = {
                        name: part,
                        path: currentPath,
                        kind: 'directory',
                        children: {}
                    };
                }
                curr = curr.children[part];
            }
        });
    });

    registry.treeRoot = root;
}

// --- AST_EXPORTS_START ---
window.buildHierarchicalTree = buildHierarchicalTree;
// --- AST_EXPORTS_END ---

// --- clampSidebarWidth.js ---
// main pane minimum width in px

        function clampSidebarWidth(w) {
            let maxW = Math.min(SIDEBAR_MAX_W, window.innerWidth - SIDEBAR_MAX_EXTRA);
            maxW = Math.max(maxW, SIDEBAR_MIN_W + 40);
            return Math.round(Math.min(Math.max(w, SIDEBAR_MIN_W), maxW));
        }

// --- AST_EXPORTS_START ---
window.clampSidebarWidth = clampSidebarWidth;
// --- AST_EXPORTS_END ---

// --- deleteExplorerNodes.js ---
async function deleteExplorerNodes(nodes) {
    if (!nodes || !nodes.length || explorerDeleteBusy) return;
    // Drop non-deletable entries, and entries already covered by a selected parent folder.
    const deletable = nodes.filter(n => contextItemApplies('deletable', n));
    const skipped = nodes.length - deletable.length;
    const paths = new Set(deletable.map(n => n.path));
    const targets = deletable.filter(n => {
        const parts = n.path.split('/');
        for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) return false;
        return true;
    });
    if (!targets.length) {
        showToast(nodes.length === 1 ? `${nodes[0].path} can't be deleted` : `None of the ${nodes.length} selected items can be deleted`, 'error');
        return;
    }

    explorerDeleteBusy = true;
    try {
        const label = targets.length === 1 ? `Delete ${targets[0].name}?` : `Delete ${targets.length} items?`;
        if (!await confirmDialog(label, { confirmLabel: 'Delete', danger: true })) return;

        let deletedCount = 0, failed = 0, lastError = null;
        for (const node of targets) {
            try {
                if (isToolFilePath(node.path)) {
                    const toolName = node.path.split('/').pop().replace('.js', '');
                    const tool = Object.values(toolRegistry).find(t => t.fileName === toolName);
                    if (!tool) { failed++; lastError = `Tool "${toolName}" not found in registry.`; continue; }
                    if (tool.locked) { failed++; lastError = `"${tool.name}" is locked. Unlock it first to delete.`; continue; }
                    if (await deleteToolFile(tool.name, tool.fileName)) deletedCount++;
                    else { failed++; lastError = `Could not delete "${tool.name}"`; }
                } else {
                    await deleteFileOrDirectory(node.path);
                    deletedCount++;
                    // Close the tab of the deleted file, or every tab inside a deleted folder.
                    const toClose = state.openTabs.filter(t => t === node.path || t.startsWith(node.path + '/'));
                    for (const t of toClose) await closeTab(t);
                }
            } catch (err) {
                failed++; lastError = `Delete failed: ${err.message || err}`;
            }
        }
        renderToolsList();
        await syncWorkspace(false);

        if (failed || skipped) {
            const bits = [];
            if (deletedCount) bits.push(`Deleted ${deletedCount}`);
            if (failed) bits.push(`${failed} failed`);
            if (skipped) bits.push(`${skipped} protected`);
            showToast(targets.length === 1 && lastError ? lastError : bits.join(', '), deletedCount ? 'success' : 'error');
        }

        // Leave nothing selected: closing tabs may have activated another file, and the highlight (and a
        // following Del) must not land on it or on a neighbouring row.
        explorerSelection.clear();
        explorerAnchor = null;
        explorerSelectionCleared = true;
        updateExplorerSelection();
    } finally {
        explorerDeleteBusy = false;
        fileTreeEl.focus({ preventScroll: true });
    }
}

// --- AST_EXPORTS_START ---
window.deleteExplorerNodes = deleteExplorerNodes;
// --- AST_EXPORTS_END ---

// --- getExplorerSelectedPaths.js ---
// Paths the explorer is acting on: the selection, else the active file tab.
function getExplorerSelectedPaths() {
    const sel = Array.from(explorerSelection).filter(p => registry.meta[p]);
    if (sel.length) return sel;
    if (explorerSelectionCleared) return [];
    return (state.activeTab && registry.meta[state.activeTab]) ? [state.activeTab] : [];
}

// --- AST_EXPORTS_START ---
window.getExplorerSelectedPaths = getExplorerSelectedPaths;
// --- AST_EXPORTS_END ---

// --- highlightSearchMatch.js ---
function highlightSearchMatch(lineText, lowerQuery) {
    const raw = lineText.replace(/\t/g, '  ');
    const idx = raw.toLowerCase().indexOf(lowerQuery);
    if (idx === -1) return escapeHTML(raw.trim().slice(0, 300));
    const before = raw.slice(Math.max(0, idx - 40), idx);
    const match = raw.slice(idx, idx + lowerQuery.length);
    const after = raw.slice(idx + lowerQuery.length, idx + lowerQuery.length + 120);
    return escapeHTML(before.trimStart()) + '<b>' + escapeHTML(match) + '</b>' + escapeHTML(after);
}

// --- AST_EXPORTS_START ---
window.highlightSearchMatch = highlightSearchMatch;
// --- AST_EXPORTS_END ---

// --- isExplorerNodeSelected.js ---
// user clicked empty space: show no highlight instead of following the active tab

        function isExplorerNodeSelected(path) {
            if (explorerSelection.size) return explorerSelection.has(path);
            return !explorerSelectionCleared && state.activeTab === path;
        }

// --- AST_EXPORTS_START ---
window.isExplorerNodeSelected = isExplorerNodeSelected;
// --- AST_EXPORTS_END ---

// --- renderExplorerTree.js ---
function renderExplorerTree() {
    buildHierarchicalTree();
    for (const p of Array.from(explorerSelection)) if (!registry.meta[p]) explorerSelection.delete(p);
    if (explorerAnchor && !registry.meta[explorerAnchor]) explorerAnchor = null;
    fileTreeEl.innerHTML = '';
    const fileCount = Object.keys(registry.meta).filter(k => registry.meta[k]?.kind === 'file' && !isAgentPath(k)).length;
    fileCountEl.innerText = fileCount;

    // `.agent/*` are always registered as virtual files, so gate the
    // placeholder on the registry being truly empty rather than on the
    // non-agent file count. That keeps the .agent folder visible even
    // before a real workspace has been chosen.
    if (Object.keys(registry.meta).length === 0) {
        fileTreeEl.innerHTML = `<div class="tree-node dim" style="padding: 8px 12px;">(no folder open)</div>`;
        return;
    }

    renderTreeNodeChildren(registry.treeRoot.children, fileTreeEl, 0);
}

// --- AST_EXPORTS_START ---
window.renderExplorerTree = renderExplorerTree;
// --- AST_EXPORTS_END ---

// --- renderTreeNodeChildren.js ---
function renderTreeNodeChildren(childrenMap, containerEl, depth = 0) {
    if (!childrenMap) return;
    const sortedKeys = Object.keys(childrenMap).sort((a, b) => {
        const nodeA = childrenMap[a];
        const nodeB = childrenMap[b];
        if (nodeA.kind === 'directory' && nodeB.kind !== 'directory') return -1;
        if (nodeA.kind !== 'directory' && nodeB.kind === 'directory') return 1;
        return a.localeCompare(b);
    });

    sortedKeys.forEach(key => {
        const node = childrenMap[key];
        const isDir = node.kind === 'directory';
        const isExpanded = state.expandedFolders.has(node.path);
        const isFaint = node.path === CUSTOM_TOOLS_DIR || node.path === TOOLS_DIR || node.path === PROMPTS_DIR || isVirtualAgentFile(node.path);

        const nodeEl = document.createElement('div');
        nodeEl.className = `tree-node ${isExpanded ? 'expanded' : ''} ${isExplorerNodeSelected(node.path) ? 'selected' : ''} ${isFaint ? 'tree-node-faint' : ''}`;
        nodeEl.setAttribute('data-path', node.path);
        const INDENT_PER_LEVEL = 18;
        nodeEl.style.paddingLeft = `${depth * INDENT_PER_LEVEL + 6}px`;

        let iconHTML = '';
        let statusBadge = '';

        if (isDir) {
            iconHTML = `
                <span class="node-chevron icon">${isExpanded ? 'expand_more' : 'chevron_right'}</span>
                <span class="node-icon icon" style="color:${isFaint ? 'inherit' : 'var(--yellow)'}; font-size:14px;">${isExpanded ? 'folder_open' : 'folder'}</span>
            `;
        } else {
            const vInfo = getFileVisualInfo(node.path);
            iconHTML = `
                <span style="width:14px; display:inline-block; flex-shrink:0;"></span>
                <span class="node-icon icon" style="color:${isFaint ? 'inherit' : vInfo.color}; font-size:14px;">${vInfo.icon}</span>
            `;

            if (state.modifiedFiles.has(node.path)) {
                const isUntracked = registry.originalFiles[node.path] === undefined;
                statusBadge = `<span class="node-status ${isUntracked ? 'u' : 'm'}">${isUntracked ? 'U' : 'M'}</span>`;
            }
        }

        nodeEl.innerHTML = `
            ${iconHTML}
            <span class="node-label" title="${escapeHTML(node.path)}">${escapeHTML(node.name)}</span>
            ${statusBadge}
            ${(!isDir && isDownloadablePath(node.path)) ? '<span class="node-dl icon" title="Download">download</span>' : ''}
        `;

        nodeEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Shift / Ctrl(Cmd) click only changes the selection: no editor open, no folder toggle.
            if (applyExplorerModifierClick(node.path, e)) {
                fileTreeEl.focus({ preventScroll: true });
                return;
            }
            explorerSelection.clear();
            explorerSelection.add(node.path);
            explorerAnchor = node.path;
            explorerSelectionCleared = false;
            if (isDir) {
                if (isExpanded) state.expandedFolders.delete(node.path);
                else state.expandedFolders.add(node.path);
                renderExplorerTree();
            } else {
                await openFileTab(node.path, { keepFocus: true });
            }
            // Keep keyboard focus in the explorer (not the editor) so Del / shortcuts act on the selection.
            fileTreeEl.focus({ preventScroll: true });
            if (window.innerWidth <= 768) {
                toggleMobileSidebar(false);
            }
        });

        nodeEl.addEventListener('contextmenu', (e) => showContextMenu(e, node));
        const dlBtn = nodeEl.querySelector('.node-dl');
        if (dlBtn) dlBtn.addEventListener('click', (ev) => { ev.stopPropagation(); downloadPath(node.path); });

        containerEl.appendChild(nodeEl);

        if (isDir && isExpanded && node.children) {
            const childContainer = document.createElement('div');
            childContainer.className = 'tree-children';
            renderTreeNodeChildren(node.children, childContainer, depth + 1);
            containerEl.appendChild(childContainer);
        }
    });
}

// --- AST_EXPORTS_START ---
window.renderTreeNodeChildren = renderTreeNodeChildren;
// --- AST_EXPORTS_END ---

// --- runWorkspaceSearch.js ---
async function runWorkspaceSearch() {
    const query = searchInput.value;
    searchResultsEl.innerHTML = '';
    if (!query) {
        searchCountEl.innerText = '';
        searchResultsEl.innerHTML = '';
        return;
    }

    searchResultsEl.innerHTML = `<div class="search-status">Searching&hellip;</div>`;

    const lower = query.toLowerCase();
    const allPaths = Object.keys(registry.meta)
        .filter(p => registry.meta[p]?.kind === 'file')
        .filter(p => !registry.meta[p]?.isBinary)
        .filter(p => {
            const size = registry.meta[p]?.size || 0;
            return size === 0 || size <= SEARCH_MAX_FILE_SIZE;
        });
    const paths = (rootHandle
        ? allPaths.sort()
        : allPaths.filter(p => registry.meta[p]?.virtual).sort()
    ).filter(p => !shouldHideFromTools(p));

    let totalMatches = 0;
    let fileCount = 0;
    let truncated = false;
    const frag = document.createDocumentFragment();

    for (const fp of paths) {
        if (totalMatches >= SEARCH_MAX_TOTAL_RESULTS) { truncated = true; break; }
        if (await resolveIsBinary(fp)) continue;
        const text = await readFileContent(fp);
        if (!text) continue;
        const lines = text.split('\n');
        const fileMatches = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lower)) {
                fileMatches.push({ lineNo: i + 1, text: lines[i] });
                totalMatches++;
                if (totalMatches >= SEARCH_MAX_TOTAL_RESULTS) { truncated = true; break; }
            }
        }
        if (fileMatches.length === 0) continue;
        fileCount++;

        const fileEl = document.createElement('div');
        fileEl.className = 'search-result-file';
        const vInfo = getFileVisualInfo(fp);
        fileEl.innerHTML = `
            <span class="icon" style="font-size:14px; color:${vInfo.color}; flex-shrink:0;">${vInfo.icon}</span>
            <span class="search-result-file-path" title="${escapeHTML(fp)}">${escapeHTML(fp)}</span>
            <span class="sidebar-badge">${fileMatches.length}</span>
        `;
        fileEl.addEventListener('click', async () => {
            await openFileTab(fp);
            if (monacoEditor && fileMatches[0]) {
                monacoEditor.revealLineInCenter(fileMatches[0].lineNo);
                monacoEditor.setPosition({ lineNumber: fileMatches[0].lineNo, column: 1 });
                monacoEditor.focus();
            }
        });
        frag.appendChild(fileEl);

        for (const m of fileMatches.slice(0, SEARCH_MAX_FILE_RESULTS)) {
            const lineEl = document.createElement('div');
            lineEl.className = 'search-result-line';
            lineEl.title = `${fp}:${m.lineNo}`;
            lineEl.innerHTML = `<span class="search-line-no">${m.lineNo}</span><span class="search-line-text">${highlightSearchMatch(m.text, lower)}</span>`;
            lineEl.addEventListener('click', async () => {
                await openFileTab(fp);
                if (monacoEditor) {
                    monacoEditor.revealLineInCenter(m.lineNo);
                    monacoEditor.setPosition({ lineNumber: m.lineNo, column: 1 });
                    monacoEditor.focus();
                }
            });
            frag.appendChild(lineEl);
        }
        if (fileMatches.length > SEARCH_MAX_FILE_RESULTS) {
            const more = document.createElement('div');
            more.className = 'search-status';
            more.innerText = `+ ${fileMatches.length - SEARCH_MAX_FILE_RESULTS} more matches in this file`;
            frag.appendChild(more);
        }
    }

    if (totalMatches === 0) {
        searchResultsEl.innerHTML = `<div class="search-status">No results found for "${escapeHTML(query)}".</div>`;
        searchCountEl.innerText = '0';
        return;
    }

    searchResultsEl.innerHTML = '';
    searchResultsEl.appendChild(frag);
    if (truncated) {
        const note = document.createElement('div');
        note.className = 'search-status';
        note.innerText = `Results truncated at ${SEARCH_MAX_TOTAL_RESULTS} matches.`;
        searchResultsEl.appendChild(note);
    }
    searchCountEl.innerText = String(totalMatches);
}

// --- AST_EXPORTS_START ---
window.runWorkspaceSearch = runWorkspaceSearch;
// --- AST_EXPORTS_END ---

// --- setExplorerSelection.js ---
function setExplorerSelection(paths, anchor) {
    explorerSelection.clear();
    paths.forEach(p => explorerSelection.add(p));
    explorerSelectionCleared = false;
    if (anchor !== undefined) explorerAnchor = anchor;
    updateExplorerSelection();
}

// --- AST_EXPORTS_START ---
window.setExplorerSelection = setExplorerSelection;
// --- AST_EXPORTS_END ---

// --- setSidebarCollapsed.js ---
function setSidebarCollapsed(collapsed) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) { sidebarEl.classList.remove('collapsed'); toggleMobileSidebar(!collapsed); return; }
    if (collapsed) {
        savedSidebarWidth = parseInt(sidebarEl.style.width, 10) || Number(AppConfig.get('sidebar-width', 314)) || 314;
        isSidebarCollapsed = true;
    } else {
        isSidebarCollapsed = false;
    }
    sidebarEl.classList.toggle('collapsed', collapsed);
    resizerEl.classList.toggle('hidden', collapsed);
    if (collapsed) { sidebarEl.style.width = ''; }
    else { applySidebarWidth(Number(AppConfig.get('sidebar-width', 314)) || 314); }
    btnSidebarCollapse.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btnSidebarCollapse.querySelector('.icon').innerText = collapsed ? 'chevron_right' : 'chevron_left';
}

// --- AST_EXPORTS_START ---
window.setSidebarCollapsed = setSidebarCollapsed;
// --- AST_EXPORTS_END ---

// --- showContextMenu.js ---
function showContextMenu(e, node) {
    e.preventDefault();
    e.stopPropagation();
    state.selectedContextItem = node;
    if (node && !(explorerSelection.size > 1 && explorerSelection.has(node.path))) {
        setExplorerSelection([node.path], node.path);
    }

    if (!applyContextScopes(node)) return;

    const renderMdBtn = document.getElementById('ctx-render-md');
    if (renderMdBtn) {
        if (node && node.kind === 'file' && node.name.toLowerCase().endsWith('.md')) {
            renderMdBtn.style.display = 'flex';
            renderMdBtn.onclick = () => {
                contextMenu.style.display = 'none';
                window.openFileTab('render:' + node.path);
            };
        } else {
            renderMdBtn.style.display = 'none';
        }
    }

    contextMenu.style.display = 'block';
    contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`;
    contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 260)}px`;
}

// --- AST_EXPORTS_START ---
window.showContextMenu = showContextMenu;
// --- AST_EXPORTS_END ---

// --- updateExplorerSelection.js ---
function updateExplorerSelection() {
    document.querySelectorAll('#file-tree .tree-node').forEach(node => {
        if (isExplorerNodeSelected(node.getAttribute('data-path'))) {
            node.classList.add('selected');
        } else {
            node.classList.remove('selected');
        }
    });
}

// --- AST_EXPORTS_START ---
window.updateExplorerSelection = updateExplorerSelection;
// --- AST_EXPORTS_END ---

// --- updateSearchClearButton.js ---
function updateSearchClearButton() {
    searchClearBtn.style.display = searchInput.value ? 'block' : 'none';
}

// --- AST_EXPORTS_START ---
window.updateSearchClearButton = updateSearchClearButton;
// --- AST_EXPORTS_END ---

// --- visibleExplorerPaths.js ---
function visibleExplorerPaths() {
    return Array.from(document.querySelectorAll('#file-tree .tree-node')).map(el => el.getAttribute('data-path'));
}

// --- AST_EXPORTS_START ---
window.visibleExplorerPaths = visibleExplorerPaths;
// --- AST_EXPORTS_END ---
