// --- agentFileKind.js ---
function agentFileKind(path) {
    if (path === MODELS_FILE) return 'models';
    if (path === CONFIG_FILE) return 'config';
    if (isPromptFileMode(path)) return 'prompt';
    if (isToolFilePath(path)) return 'tool';
    return null;
}

// --- AST_EXPORTS_START ---
window.agentFileKind = agentFileKind;
// --- AST_EXPORTS_END ---

// --- applyContextScopes.js ---
function applyContextScopes(node) {
    const entries = Array.from(contextMenu.children);
    const isAgentFile = node && isAgentPath(node.path);
    const isEmptySpace = !node;
    let visible = 0;

    entries.forEach(entry => {
        if (entry.classList.contains('context-menu-separator')) return;
        const scope = entry.getAttribute('data-scope');
        const applies = contextItemApplies(scope, node);

        entry.classList.remove('disabled');
        entry.style.display = '';

        if (applies) {
            visible++;
        } else {
            let shouldDisable = false;

            if (isEmptySpace) {
                shouldDisable = (scope === 'file' || scope === 'changed' || scope === 'restorable' ||
                                scope === 'renameable' || scope === 'deletable');
            } else if (isAgentFile) {
                if (scope === 'dir') {
                    entry.style.display = 'none';
                    return;
                }
                shouldDisable = (scope === 'renameable' || scope === 'deletable' || scope === 'file');
            } else {
                entry.style.display = 'none';
                return;
            }

            if (shouldDisable) {
                entry.classList.add('disabled');
                visible++;
            } else {
                entry.style.display = 'none';
            }
        }
    });

    let lastVisible = null;
    let pending = [];
    entries.forEach(entry => {
        if (entry.classList.contains('context-menu-separator')) { pending.push(entry); return; }
        const shown = entry.style.display !== 'hidden' && entry.style.display !== 'none';
        const separators = shown && lastVisible ? pending : [];
        pending.forEach(sep => { sep.style.display = separators.includes(sep) ? '' : 'none'; });
        pending = [];
        if (shown) lastVisible = entry;
    });
    pending.forEach(sep => { sep.style.display = 'none'; });
    return visible;
}

// --- AST_EXPORTS_START ---
window.applyContextScopes = applyContextScopes;
// --- AST_EXPORTS_END ---

// --- contextItemApplies.js ---
function contextItemApplies(scope, node) {
    if (!scope || scope === 'any') return true;

    if (!node) {
        return scope === 'dir';
    }

    if (scope === 'dir') {
        if (node.kind === 'directory') {
            return !isAgentPath(node.path);
        } else {
            const parentPath = node.path.split('/').slice(0, -1).join('/');
            return !isAgentPath(parentPath) && !isAgentPath(node.path);
        }
    }

    if (scope === 'downloadable') return node.kind !== 'directory' && isDownloadablePath(node.path);
    if (scope === 'downloaddir') return node.kind === 'directory' && isDownloadablePath(node.path);
    if (scope === 'file') return node.kind !== 'directory';
    if (scope === 'changed') return node.kind !== 'directory' && state.modifiedFiles.has(node.path);
    if (scope === 'restorable') return node.kind !== 'directory' && isRestorableAgentFile(node.path) && (!isToolFilePath(node.path) || isToolModified(toolNameFromPath(node.path)));
    if (scope === 'renameable') return !isAgentPath(node.path);
    if (scope === 'deletable') return !isAgentPath(node.path) || isDeletableAgentFile(node.path);
    return true;
}

// --- AST_EXPORTS_START ---
window.contextItemApplies = contextItemApplies;
// --- AST_EXPORTS_END ---

// --- cropAndEncodeImage.js ---
async function cropAndEncodeImage(dataUrl, { x, y, width, height } = {}) {
return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
        const naturalW = img.naturalWidth || img.width;
        const naturalH = img.naturalHeight || img.height;
        // Inputs are normalized fractions 0.0-1.0 relative to image dimensions. Convert to pixels.
        let sx = 0, sy = 0, sw = naturalW, sh = naturalH;
        const hasCrop = [x, y, width, height].some(v => v !== undefined && v !== null);
        if (hasCrop) {
            const rawX = (x ?? 0) * naturalW, rawY = (y ?? 0) * naturalH;
            const rawW = (width ?? (1 - (x ?? 0))) * naturalW, rawH = (height ?? (1 - (y ?? 0))) * naturalH;
            sx = Math.max(0, Math.min(naturalW - 1, Math.round(rawX)));
            sy = Math.max(0, Math.min(naturalH - 1, Math.round(rawY)));
            sw = Math.max(1, Math.min(naturalW - sx, Math.round(rawW)));
            sh = Math.max(1, Math.min(naturalH - sy, Math.round(rawH)));
        }
        const MAX_SIDE = 1568;
        const MIN_ZOOM_SIDE = 768;
        let outW = sw, outH = sh;
        const longSide = Math.max(outW, outH);
        if (hasCrop && longSide < MIN_ZOOM_SIDE) {
            const scale = MIN_ZOOM_SIDE / longSide;
            outW = Math.round(outW * scale);
            outH = Math.round(outH * scale);
        }
        const longSide2 = Math.max(outW, outH);
        if (longSide2 > MAX_SIDE) {
            const scale = MAX_SIDE / longSide2;
            outW = Math.round(outW * scale);
            outH = Math.round(outH * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
        resolve({
            dataUrl: canvas.toDataURL('image/png'),
            crop: hasCrop ? { x: sx, y: sy, width: sw, height: sh } : null,
            width: outW,
            height: outH,
            sourceWidth: naturalW,
            sourceHeight: naturalH
        });
    };
    img.onerror = () => reject(new Error('Failed to load image for preview'));
    img.src = dataUrl;
});
}

// --- AST_EXPORTS_START ---
window.cropAndEncodeImage = cropAndEncodeImage;
// --- AST_EXPORTS_END ---

// --- dataUrlByteSize.js ---
// Writes an attached image/paste into the virtual, read-only .agent/attachments
// directory so tools can reference it like a normal file instead of having its
// full content dropped inline into the prompt. Returns the virtual file path.
// Idempotent per ref (re-sending an edited prompt won't duplicate the file).
// Re-registers meta entries for whatever attachment content already lives in
// registry.files. Needed because syncWorkspace() rebuilds registry.meta from a
// fresh disk scan (which knows nothing about in-memory attachments), so this
// must be called alongside the other registerXVirtualFile() functions there.

// Approximate decoded byte size of a data URL, for display purposes.
function dataUrlByteSize(dataUrl) {
    const idx = (dataUrl || '').indexOf(',');
    const b64 = idx === -1 ? '' : dataUrl.slice(idx + 1);
    if (!b64) return (dataUrl || '').length;
    const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(b64.length * 3 / 4) - padding);
}

// --- AST_EXPORTS_START ---
window.dataUrlByteSize = dataUrlByteSize;
// --- AST_EXPORTS_END ---

// --- encodingLabel.js ---
function encodingLabel(enc) {
    return enc === 'utf-8-bom' ? 'utf-8' : enc;
}

// --- AST_EXPORTS_START ---
window.encodingLabel = encodingLabel;
// --- AST_EXPORTS_END ---

// --- formatFileSize.js ---
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// --- AST_EXPORTS_START ---
window.formatFileSize = formatFileSize;
// --- AST_EXPORTS_END ---

// --- getFileVisualInfo.js ---
function getFileVisualInfo(filepath) {
    const ext = filepath.split('.').pop().toLowerCase();
    const basename = filepath.split('/').pop().toLowerCase();
    if (basename.startsWith('.git')) return FILE_ICON_MAP.gitignore;
    if (FILE_ICON_MAP[ext]) return FILE_ICON_MAP[ext];
    return { icon: 'draft', color: 'var(--dim)' };
}

// --- AST_EXPORTS_START ---
window.getFileVisualInfo = getFileVisualInfo;
// --- AST_EXPORTS_END ---

// --- guessImageMimeType.js ---
function guessImageMimeType(filepath) {
const ext = (filepath.match(/\.([a-zA-Z0-9]+)$/)?.[1] || '').toLowerCase();
const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
return map[ext] || 'application/octet-stream';
}

// --- AST_EXPORTS_START ---
window.guessImageMimeType = guessImageMimeType;
// --- AST_EXPORTS_END ---

// --- isAgentPath.js ---
function isAgentPath(path) {
const skillsDir = window.SKILLS_DIR || '.agent/skills';
return path === CUSTOM_TOOLS_DIR ||
       path === TOOLS_DIR ||
       path === PROMPTS_DIR ||
       path === ATTACHMENTS_DIR ||
       path === skillsDir ||
       path.startsWith(CUSTOM_TOOLS_DIR + '/');
}

// --- AST_EXPORTS_START ---
window.isAgentPath = isAgentPath;
// --- AST_EXPORTS_END ---

// --- isSkillPath.js ---
function isSkillPath(path) {
    const dir = window.SKILLS_DIR || '.agent/skills';
    return path === dir || (typeof path === 'string' && path.startsWith(dir + '/'));
}

// --- AST_EXPORTS_START ---
window.isSkillPath = isSkillPath;
// --- AST_EXPORTS_END ---

// --- isAttachmentPath.js ---
// Session attachments: virtual, read-only files under .agent/attachments.
// Always visible to tools regardless of the "hide .agent files" toggle, and
// always excluded from writes/edits/deletes/renames.
function isAttachmentPath(path) {
    return path === ATTACHMENTS_DIR || path.startsWith(ATTACHMENTS_DIR + '/');
}

// --- AST_EXPORTS_START ---
window.isAttachmentPath = isAttachmentPath;
// --- AST_EXPORTS_END ---

// --- isDeletableAgentFile.js ---
function isDeletableAgentFile(path) {
    return agentFileKind(path) === 'tool' && !isRestorableAgentFile(path);
}

// --- AST_EXPORTS_START ---
window.isDeletableAgentFile = isDeletableAgentFile;
// --- AST_EXPORTS_END ---

// --- isGitignoredPath.js ---
function isGitignoredPath(path) {
    if (!path) return false;
    const parts = path.split('/');
    const baseName = parts[parts.length - 1];
    for (const [dir, patterns] of gitignoreCache.entries()) {
        // Only applies to paths inside (or equal to) the directory that owns this .gitignore.
        if (dir && path !== dir && !path.startsWith(dir + '/')) continue;
        const relPath = dir ? path.slice(dir.length + 1) : path;
        const relBase = relPath.split('/').pop();
        for (const pattern of patterns) {
            if (pattern.endsWith('/')) {
                if (isUnderDirPattern(pattern, relPath) || relPath === pattern.slice(0, -1)) return true;
            } else if (matchesPattern(pattern, relPath, relBase, false)) {
                return true;
            }
        }
    }
    return false;
}

// --- AST_EXPORTS_START ---
window.isGitignoredPath = isGitignoredPath;
// --- AST_EXPORTS_END ---

// --- isImageFilePath.js ---
function isImageFilePath(path) {
return IMAGE_FILE_EXT_RE.test(path || '');
}

// --- AST_EXPORTS_START ---
window.isImageFilePath = isImageFilePath;
// --- AST_EXPORTS_END ---

// --- isPromptFileMode.js ---
function isPromptFileMode(path) {
    return Object.prototype.hasOwnProperty.call(PROMPT_FILE_MODES, path);
}

// --- AST_EXPORTS_START ---
window.isPromptFileMode = isPromptFileMode;
// --- AST_EXPORTS_END ---

// --- isRestorableAgentFile.js ---
function isRestorableAgentFile(path) {
    const kind = agentFileKind(path);
    if (!kind) return false;
    if (kind === 'tool') {
        const seeded = seedBuiltinToolSources();
        return Object.prototype.hasOwnProperty.call(seeded, toolNameFromPath(path));
    }
    return true;
}

// --- AST_EXPORTS_START ---
window.isRestorableAgentFile = isRestorableAgentFile;
// --- AST_EXPORTS_END ---

// --- isScanVisiblePath.js ---
// Same visibility rules the scan applies: is this path something a scan would list?
function isScanVisiblePath(fp) {
    const parts = fp.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        if (shouldSkipScanEntry(part, cur)) return false;
    }
    return parts.length > 0;
}

// --- AST_EXPORTS_START ---
window.isScanVisiblePath = isScanVisiblePath;
// --- AST_EXPORTS_END ---

// --- isSecurityProtectedPath.js ---
// Single source of truth: is this path protected from ALL tool calls and hidden from the explorer (regardless of .agent toggle)?
function isSecurityProtectedPath(path) {
    if (!path) return false;
    return isHardProtectedPath(path) || isGitignoredPath(path);
}

// --- AST_EXPORTS_START ---
window.isSecurityProtectedPath = isSecurityProtectedPath;
// --- AST_EXPORTS_END ---

// --- isSensitiveUserFile.js ---
function isSensitiveUserFile(path) {
    return SENSITIVE_USER_FILES.includes(path);
}

// --- AST_EXPORTS_START ---
window.isSensitiveUserFile = isSensitiveUserFile;
// --- AST_EXPORTS_END ---

// --- isToolFilePath.js ---
function isToolFilePath(path) {
    return path.startsWith(TOOLS_DIR + '/') && path.endsWith('.js');
}

// --- AST_EXPORTS_START ---
window.isToolFilePath = isToolFilePath;
// --- AST_EXPORTS_END ---

// --- isToolOrAgentPath.js ---
function isToolOrAgentPath(path) {
    const skillsDir = window.SKILLS_DIR || '.agent/skills';
    return isVirtualAgentFile(path) || path === CUSTOM_TOOLS_DIR || path === TOOLS_DIR || path === PROMPTS_DIR || path === skillsDir;
}

// --- AST_EXPORTS_START ---
window.isToolOrAgentPath = isToolOrAgentPath;
// --- AST_EXPORTS_END ---

// --- isVirtualAgentFile.js ---
function isVirtualAgentFile(path) {
    return VIRTUAL_AGENT_FILES.includes(path) || isToolFilePath(path) || isAttachmentPath(path) || !!PROMPT_FILE_MODES[path];
}

// --- AST_EXPORTS_START ---
window.isVirtualAgentFile = isVirtualAgentFile;
// --- AST_EXPORTS_END ---

// --- langOf.js ---
function langOf(filepath) {
    if (!filepath) return 'plaintext';
    const ext = filepath.split('.').pop().toLowerCase();
    return LANG_MAP[ext] || 'plaintext';
}

// --- AST_EXPORTS_START ---
window.langOf = langOf;
// --- AST_EXPORTS_END ---

// --- normalizeSaveAsPath.js ---
// Normalizes a user-entered workspace path and rejects anything we can't safely write.
// Returns { path } or { error }.
function normalizeSaveAsPath(raw) {
    const p = String(raw || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (!p) return { error: 'Enter a file path.' };
    if (p.endsWith('/')) return { error: 'The path must end with a file name.' };
    if (p.split('/').some(seg => seg === '.' || seg === '..')) return { error: 'Paths can\'t contain "." or ".." segments.' };
    if (/[<>:"|?*\x00-\x1f]/.test(p)) return { error: 'The path contains characters that aren\'t allowed: < > : " | ? *' };
    if (isAgentPath(p) || isVirtualAgentFile(p) || isSecurityProtectedPath(p)) return { error: 'That location is protected and can\'t be written to.' };
    const meta = registry.meta[p];
    if (meta && meta.kind === 'directory') return { error: 'A folder with that name already exists.' };
    return { path: p };
}

// --- AST_EXPORTS_START ---
window.normalizeSaveAsPath = normalizeSaveAsPath;
// --- AST_EXPORTS_END ---

// --- parseGitignoreContent.js ---
function parseGitignoreContent(text) {
    return String(text || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
}

// --- AST_EXPORTS_START ---
window.parseGitignoreContent = parseGitignoreContent;
// --- AST_EXPORTS_END ---

// --- prescanGitignoreFiles.js ---
// Pre-scans every .gitignore so parent rules are known before filtering.
async function prescanGitignoreFiles(handle, path = "") {
    for await (const entry of handle.values()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const fullPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === 'file') {
            if (entry.name === '.gitignore') {
                try {
                    const file = await entry.getFile();
                    const text = await file.text();
                    registerGitignoreRules(fullPath, text);
                } catch(e) {}
            }
        } else if (entry.kind === 'directory') {
            await prescanGitignoreFiles(entry, fullPath);
        }
    }
}

// --- AST_EXPORTS_START ---
window.prescanGitignoreFiles = prescanGitignoreFiles;
// --- AST_EXPORTS_END ---

// --- registerGitignoreRules.js ---
// Maps directory path to the raw pattern lines of its .gitignore.
function registerGitignoreRules(gitignorePath, content) {
    const dir = dirnameOf(gitignorePath);
    gitignoreCache.set(dir, parseGitignoreContent(content));
}

// --- AST_EXPORTS_START ---
window.registerGitignoreRules = registerGitignoreRules;
// --- AST_EXPORTS_END ---

// --- shouldHideFromTools.js ---
function shouldHideFromTools(path) {
    if (isAttachmentPath(path)) return false; // attachments are always readable by tools
    if (isSkillPath(path)) return false; // skills are always readable by tools
    if (AppConfig.get('hide-agent-files', 'true') !== 'true') {
        return false;
    }
    return path === CUSTOM_TOOLS_DIR || path.startsWith(CUSTOM_TOOLS_DIR + '/');
}

// --- AST_EXPORTS_START ---
window.shouldHideFromTools = shouldHideFromTools;
// --- AST_EXPORTS_END ---

// --- shouldSkipScanEntry.js ---
// Single rule for what a workspace scan skips (also used by refreshPathMeta so both agree).
function shouldSkipScanEntry(name, fullPath) {
    if (IGNORED_DIRS.has(name)) return true;
    if (name.startsWith('.') && name !== PLAN_FILE && name !== '.gitignore' && name !== CUSTOM_TOOLS_DIR) return true;
    return isSecurityProtectedPath(fullPath);
}

// --- AST_EXPORTS_START ---
window.shouldSkipScanEntry = shouldSkipScanEntry;
// --- AST_EXPORTS_END ---

// --- toPngDataUrl.js ---
// Re-encodes an image as a PNG data URL.
async function toPngDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                if (!canvas.width || !canvas.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                }
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = reader.result;
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// --- AST_EXPORTS_START ---
window.toPngDataUrl = toPngDataUrl;
// --- AST_EXPORTS_END ---

// --- validateEntryName.js ---
// Validator for file/folder names typed into promptDialog. Returns an error string or null.
function validateEntryName(v, { allowSlash = true } = {}) {
    const s = String(v || '').trim();
    if (!s) return 'Enter a name.';
    if (!allowSlash && /[\/\\]/.test(s)) return 'The name can\'t contain slashes.';
    if (s.replace(/\\/g, '/').split('/').some(seg => seg === '.' || seg === '..')) return 'The name can\'t contain "." or ".." segments.';
    if (/[<>:"|?*\x00-\x1f]/.test(s)) return 'The name contains characters that aren\'t allowed: < > : " | ? *';
    return null;
}

// --- AST_EXPORTS_START ---
window.validateEntryName = validateEntryName;
// --- AST_EXPORTS_END ---
