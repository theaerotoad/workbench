// Tracks which installed tools came from the GitHub tools repo: { [fileKey]: { file } }
//   file  = file name in the repo (e.g. "my_tool.js")
// No hashes are stored: the local file is hashed on demand when the list is displayed and compared
// against the `sha` GitHub returns in its listing (see refreshGithubLocalHashes / getGithubEntryStatus).
function loadGithubToolState() {
    try {
        const stored = JSON.parse(localStorage.getItem('tool_github_state') || '{}');
        return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    } catch(e) { return {}; }
}
function saveGithubToolState(state) {
    localStorage.setItem('tool_github_state', JSON.stringify(state));
}
function rememberGithubTool(fileKey, file) {
    const state = loadGithubToolState();
    state[fileKey] = { file };
    saveGithubToolState(state);
}
function forgetGithubTool(fileKey) {
    const state = loadGithubToolState();
    if (!(fileKey in state)) return;
    delete state[fileKey];
    saveGithubToolState(state);
}
// Git blob SHA-1 ("blob <len>\0<bytes>"), the same hash GitHub returns as `sha` in its contents API.
async function gitBlobSha(data) {
    try {
        const body = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        const header = new TextEncoder().encode(`blob ${body.length}\0`);
        const all = new Uint8Array(header.length + body.length);
        all.set(header, 0);
        all.set(body, header.length);
        const digest = await crypto.subtle.digest('SHA-1', all);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
}

let currentBrowseSourceInfo = null;

function getToolsBrowseLocation() {
    const input = document.getElementById('newtool-browse-location');
    if (input && input.value.trim()) {
        return input.value.trim();
    }
    const saved = localStorage.getItem('tools_browse_location');
    if (saved && saved.trim()) {
        return saved.trim();
    }
    return (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
}

function setToolsBrowseLocation(loc) {
    localStorage.setItem('tools_browse_location', loc);
    const input = document.getElementById('newtool-browse-location');
    if (input && input.value !== loc) {
        input.value = loc;
    }
}

function parseToolsSource(sourceStr) {
    let src = (sourceStr || '').trim();
    if (!src) {
        src = (typeof DEFAULT_TOOLS_SOURCE !== 'undefined' ? DEFAULT_TOOLS_SOURCE : '/api/jsutils');
    }

    // 1. Full GitHub web URL: https://github.com/owner/repo or github.com/owner/repo
    const ghHttpMatch = src.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/]+?)(?:\/(?:tree|blob)\/([^\/]+)(?:\/(.*))?)?$/i);
    if (ghHttpMatch) {
        const owner = ghHttpMatch[1];
        const repo = ghHttpMatch[2].replace(/\.git$/i, '');
        const branch = ghHttpMatch[3] || (typeof GITHUB_TOOLS_BRANCH !== 'undefined' ? GITHUB_TOOLS_BRANCH : 'main');
        const path = (ghHttpMatch[4] || '').replace(/^\/+|\/+$/g, '');
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path ? encodeURIComponent(path).replace(/%2F/g, '/') : ''}?ref=${encodeURIComponent(branch)}`;
        return {
            type: 'github',
            label: `${owner}/${repo}${path ? '/' + path : ''} (${branch})`,
            apiUrl
        };
    }

    // 2. Direct GitHub API URL: https://api.github.com/repos/owner/repo/contents/...
    if (/^https?:\/\/api\.github\.com\/repos\//i.test(src)) {
        return {
            type: 'github',
            label: src,
            apiUrl: src
        };
    }

    // 3. Shorthand GitHub repo: "owner/repo" or "owner/repo@branch" or "owner/repo/path"
    const isUrl = /^https?:\/\//i.test(src);
    const isPath = src.startsWith('/') || src.startsWith('.') || src.includes('\\');
    if (!isUrl && !isPath) {
        const ghShortMatch = src.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:@([a-zA-Z0-9_.-]+))?(?:\/(.*))?$/);
        if (ghShortMatch) {
            const owner = ghShortMatch[1];
            const repo = ghShortMatch[2];
            const branch = ghShortMatch[3] || (typeof GITHUB_TOOLS_BRANCH !== 'undefined' ? GITHUB_TOOLS_BRANCH : 'main');
            const path = (ghShortMatch[4] || '').replace(/^\/+|\/+$/g, '');
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path ? encodeURIComponent(path).replace(/%2F/g, '/') : ''}?ref=${encodeURIComponent(branch)}`;
            return {
                type: 'github',
                label: `${owner}/${repo}${path ? '/' + path : ''} (${branch})`,
                apiUrl
            };
        }
    }

    // 4. Server endpoint (default /api/jsutils, or full URL, or relative path)
    return {
        type: 'server',
        label: src,
        url: src
    };
}

async function loadGithubToolsList(forceRefresh) {
    newToolBrowseSelected = null;
    newToolBrowseRefresh.classList.add('spinning');

    const loc = getToolsBrowseLocation();
    const sourceInfo = parseToolsSource(loc);
    currentBrowseSourceInfo = sourceInfo;

    const safeLabel = (window.escapeHTML || (s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))))(sourceInfo.label);

    if (sourceInfo.type === 'github') {
        newToolBrowseSetStatus(`<span class="icon">hourglass_top</span><span>Loading tools from GitHub (${safeLabel})…</span>`);
        try {
            const resp = await fetch(sourceInfo.apiUrl, { headers: { 'Accept': 'application/vnd.github+json' } });
            if (!resp.ok) {
                if (resp.status === 404) {
                    newToolBrowseFiles = [];
                    newToolBrowseSetStatus(`<span class="icon">folder_off</span><span>No tools found at ${safeLabel}.</span>`);
                    return;
                }
                if (resp.status === 403) {
                    newToolBrowseFiles = null;
                    newToolBrowseSetStatus('<span class="icon">warning</span><span>GitHub rate limit hit. Try again in a bit.</span>');
                    return;
                }
                throw new Error(`GitHub API responded ${resp.status}`);
            }
            const data = await resp.json();
            newToolBrowseFiles = (Array.isArray(data) ? data : [])
                .filter(entry => entry.type === 'file' && /\.js$/i.test(entry.name))
                .sort((a, b) => a.name.localeCompare(b.name));
            newToolBrowseFetchedAt = Date.now();
            await refreshGithubLocalHashes();
            renderGithubToolsList();
        } catch (e) {
            newToolBrowseFiles = null;
            newToolBrowseSetStatus(`<span class="icon">error</span><span>Could not reach GitHub: ${(e && e.message) ? e.message : 'network error'}</span>`);
        } finally {
            newToolBrowseRefresh.classList.remove('spinning');
        }
    } else {
        newToolBrowseSetStatus(`<span class="icon">hourglass_top</span><span>Loading tools from server (${safeLabel})…</span>`);
        try {
            const resp = await fetch(sourceInfo.url);
            if (!resp.ok) {
                if (resp.status === 404) {
                    newToolBrowseFiles = [];
                    newToolBrowseSetStatus(`<span class="icon">folder_off</span><span>Endpoint <code>${safeLabel}</code> not found (ensure server.py is running).</span>`);
                    return;
                }
                throw new Error(`Server responded ${resp.status}`);
            }
            const data = await resp.json();
            if (!Array.isArray(data)) {
                throw new Error('Expected array of tools from server');
            }
            const endpointBase = new URL(sourceInfo.url, window.location.href);
            for (const entry of data) {
                if (entry.download_url) {
                    entry.download_url = new URL(entry.download_url, endpointBase).href;
                }
            }
            newToolBrowseFiles = data
                .filter(entry => (entry.type === 'file' || !entry.type) && /\.js$/i.test(entry.name))
                .sort((a, b) => a.name.localeCompare(b.name));
            newToolBrowseFetchedAt = Date.now();
            await refreshGithubLocalHashes();
            renderGithubToolsList();
        } catch (e) {
            newToolBrowseFiles = null;
            newToolBrowseSetStatus(`<span class="icon">error</span><span>Could not load tools from server: ${(e && e.message) ? e.message : 'network error'}</span>`);
        } finally {
            newToolBrowseRefresh.classList.remove('spinning');
        }
    }
}

function findInstalledToolForEntry(entry) {
    // 1) Tools we installed from this repo file (recorded by file name).
    const state = loadGithubToolState();
    for (const [key, rec] of Object.entries(state)) {
        if (rec && rec.file === entry.name) {
            const t = Object.values(toolRegistry).find(t => (t.fileName || t.name) === key);
            if (t) return t;
        }
    }
    // 2) Prefer the parsed TOOL_META.name; otherwise match by file name.
    if (entry._source) {
        const name = deriveToolNameFromFile(entry.name, entry._source);
        if (toolRegistry[name]) return toolRegistry[name];
    }
    const fileKey = entry.name.replace(/\.js$/i, '');
    return Object.values(toolRegistry).find(t => (t.fileName || t.name) === fileKey) || null;
}

async function refreshGithubLocalHashes() {
    if (!newToolBrowseFiles) return;
    const next = new Map();
    for (const entry of newToolBrowseFiles) {
        const tool = findInstalledToolForEntry(entry);
        if (!tool || tool.builtin) continue;
        const local = registry.files[toolFilePath(tool.fileName || tool.name)];
        if (typeof local !== 'string' || next.has(local)) continue;
        next.set(local, githubLocalShaCache.get(local) || await gitBlobSha(local));
    }
    githubLocalShaCache = next;
}

// 'none' (not installed) | 'current' (local file's hash equals GitHub's) | 'update' (differs, or couldn't be hashed)
function getGithubEntryStatus(entry) {
    const tool = findInstalledToolForEntry(entry);
    if (!tool) return 'none';
    if (tool.builtin) return 'current';
    const local = registry.files[toolFilePath(tool.fileName || tool.name)];
    const localSha = typeof local === 'string' ? githubLocalShaCache.get(local) : null;
    return (localSha && entry.sha && localSha === entry.sha) ? 'current' : 'update';
}

function countGithubUpdates() {
    if (!newToolBrowseFiles) return 0;
    return newToolBrowseFiles.filter(e => getGithubEntryStatus(e) === 'update').length;
}

function updateAllGithubTools() {
    const updates = newToolBrowseFiles ? newToolBrowseFiles.filter(e => getGithubEntryStatus(e) === 'update') : [];
    if (!updates.length) return;
    newToolUpdateAllBtn.disabled = true;
    (async () => {
        let ok = 0;
        for (const entry of updates) {
            if (await installGithubEntry(entry)) ok++;
        }
        newToolUpdateAllBtn.disabled = false;
    })();
}

function renderGithubToolsList() {
    if (!newToolBrowseFiles) return;
    const filter = (newToolBrowseSearch.value || '').trim().toLowerCase();
    const files = filter
        ? newToolBrowseFiles.filter(f => f.name.toLowerCase().includes(filter))
        : newToolBrowseFiles;

    if (!files.length) {
        const label = currentBrowseSourceInfo ? currentBrowseSourceInfo.label : 'source';
        const safeLabel = (window.escapeHTML || (s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))))(label);
        newToolBrowseSetStatus(filter
            ? '<span class="icon">search_off</span><span>No tools match that filter.</span>'
            : `<span class="icon">folder_off</span><span>No .js tools found in <code>${safeLabel}</code>.</span>`);
        return;
    }

    newToolBrowseList.innerHTML = '';
    files.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'newtool-browse-item';
        const status = getGithubEntryStatus(entry);
        if (newToolBrowseSelected && newToolBrowseSelected.name === entry.name) item.classList.add('selected');
        if (status === 'current') item.classList.add('installed');
        item.innerHTML = `
            <div class="newtool-browse-item-row">
                <span class="icon icon-chevron">expand_more</span>
                <span class="newtool-browse-row-name">${entry.name}</span>
                ${status === 'current'
                    ? '<button type="button" class="newtool-browse-row-install" disabled>Installed</button>'
                    : status === 'update'
                        ? '<button type="button" class="newtool-browse-row-install update" title="The repo version differs from the installed one">Update</button>'
                        : '<button type="button" class="newtool-browse-row-install">Install</button>'}
            </div>
            <div class="newtool-browse-item-desc dim-placeholder"></div>
        `;
        const descEl = item.querySelector('.newtool-browse-item-desc');
        entry._item = item;
        item.addEventListener('click', (e) => {
            if (e.target.closest('.newtool-browse-row-install')) return;
            if (item.classList.contains('expanded')) {
                item.classList.remove('expanded');
                return;
            }
            selectGithubTool(entry);
        });
        const installBtn = item.querySelector('.newtool-browse-row-install');
        if (installBtn) {
            installBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                selectGithubTool(entry);
                await installGithubEntry(entry);
            });
        }
        newToolBrowseList.appendChild(item);
    });
    const n = countGithubUpdates();
    if (n > 0) {
        newToolUpdateAllBtn.style.display = '';
        newToolUpdateAllBtn.title = `Update all ${n} installed tool${n > 1 ? 's' : ''} that have a newer repo version`;
        newToolUpdateAllBtn.textContent = n > 1 ? `Update all (${n})` : 'Update all';
    } else {
        newToolUpdateAllBtn.style.display = 'none';
    }
}

async function selectGithubTool(entry) {
    newToolBrowseSelected = entry;
    // A GitHub selection takes priority over any local dropzone pick.
    newToolClearFile();
    renderGithubToolsList();
    newToolUpdateCreateLabel();
    newToolShowError('');

    const item = entry._item;
    if (!item) return;
    item.classList.add('expanded');
    const descEl = item.querySelector('.newtool-browse-item-desc');
    descEl.className = 'newtool-browse-item-desc dim-placeholder';
    descEl.textContent = 'Loading…';
    try {
        const resp = await fetch(entry.download_url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        entry._source = text; // cache for install
        const meta = parseToolMeta(text);
        const desc = meta && (meta.description || '').trim();
        descEl.className = 'newtool-browse-item-desc' + (desc ? '' : ' dim-placeholder');
        descEl.textContent = desc || (meta ? 'No description provided.' : 'No TOOL_META found in this file.');
    } catch (e) {
        descEl.className = 'newtool-browse-item-desc dim-placeholder';
        descEl.textContent = `Could not load file: ${(e && e.message) ? e.message : 'network error'}`;
    }
}

async function installGithubEntry(entry) {
    // Always download fresh so we install (and compare against) what GitHub serves right now.
    let source;
    try {
        const resp = await fetch(entry.download_url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = await resp.arrayBuffer();
        source = new TextDecoder('utf-8').decode(bytes);
        const remoteSha = await gitBlobSha(bytes);
        if (remoteSha) entry.sha = remoteSha;   // the repo may have moved on since the listing was fetched
    } catch (e) {
        newToolShowError(`Could not download that tool: ${(e && e.message) ? e.message : 'network error'}`);
        return false;
    }
    entry._source = source;

    const existing = findInstalledToolForEntry(entry);
    if (existing && !existing.builtin) {
        // Update in place: keeps the file name plus the tool's lock/permission/settings state.
        const key = existing.fileName || existing.name;
        const fp = toolFilePath(key);
        registry.files[fp] = source;
        registry.meta[fp] = { kind: 'file', size: source.length, isBinary: false, virtual: true };
        persistToolFile(key, source);
        unmarkToolDeleted(key);
        rememberGithubTool(key, entry.name);
        rebuildToolRegistryFromFiles();
        refreshAgentFileTab(fp, source);
        renderExplorerTree();
        renderToolsList();
        await refreshGithubLocalHashes();
        renderGithubToolsList();
        return true;
    }

    const name = deriveToolNameFromFile(entry.name, source);
    const result = createToolFile(name, source);
    if (!result.ok) {
        newToolShowError(result.error);
        return false;
    }
    rememberGithubTool(name, entry.name);
    renderExplorerTree();
    renderToolsList();
    await refreshGithubLocalHashes();
    renderGithubToolsList();
    return true;
}

// --- AST_EXPORTS_START ---
window.loadGithubToolState = loadGithubToolState;
window.saveGithubToolState = saveGithubToolState;
window.rememberGithubTool = rememberGithubTool;
window.forgetGithubTool = forgetGithubTool;
window.gitBlobSha = gitBlobSha;
window.loadGithubToolsList = loadGithubToolsList;
window.findInstalledToolForEntry = findInstalledToolForEntry;
window.refreshGithubLocalHashes = refreshGithubLocalHashes;
window.getGithubEntryStatus = getGithubEntryStatus;
window.countGithubUpdates = countGithubUpdates;
window.updateAllGithubTools = updateAllGithubTools;
window.renderGithubToolsList = renderGithubToolsList;
window.selectGithubTool = selectGithubTool;
window.installGithubEntry = installGithubEntry;
window.getToolsBrowseLocation = getToolsBrowseLocation;
window.setToolsBrowseLocation = setToolsBrowseLocation;
window.parseToolsSource = parseToolsSource;
// --- AST_EXPORTS_END ---
