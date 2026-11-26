// bash_fs - Inspect, manage, and snapshot files in the active just-bash virtual filesystem
const TOOL_META = {
    name: "bash_fs",
    description: "Inspect or manage files inside the active just-bash in-memory virtual filesystem (shared with bash_run).\n\nACTIONS:\n- 'list': Recursively list virtual files under 'path' (defaults to '/workspace').\n- 'read': Read a virtual file at 'path'.\n- 'write': Create or overwrite a virtual file at 'path' with 'content'.\n- 'delete': Delete a virtual file or directory at 'path' (pass 'recursive: true' for directories).\n- 'reset': Wipe the virtual filesystem and reset cwd back to '/workspace'.\n- 'load_workspace': Copy read-only snapshots of Ion workspace files into '/workspace/...' inside just-bash so you can run grep/rg/awk/jq/sed/find on project files without modifying the host workspace.",
    parameters: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["list", "read", "write", "delete", "reset", "load_workspace"],
                description: "Virtual filesystem operation to perform."
            },
            path: {
                type: "string",
                description: "Target path inside the virtual filesystem (e.g. '/workspace/data.json' or relative 'data.json'). Used by list, read, write, and delete."
            },
            content: {
                type: "string",
                description: "File contents for action 'write'.",
                allowEmpty: true
            },
            recursive: {
                type: "boolean",
                description: "Allow deleting directories recursively for action 'delete'."
            },
            workspacePaths: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of workspace-relative file paths to copy into '/workspace/...' for action 'load_workspace'. If omitted, copies accessible non-ignored files up to the snapshot size cap."
            }
        },
        required: ["action"]
    },
    modes: ["plan", "ask", "code"],
    permission: "ask",
    toolBox: 1,
    expanded: false,
    interactive: false,
    settings: [
        {
            key: "maxSnapshotMb",
            label: "Max workspace snapshot size (MB)",
            type: "number",
            default: 32,
            min: 1,
            max: 128,
            description: "Total byte cap when using action 'load_workspace'."
        },
        {
            key: "autoExpand",
            label: "Auto-expand tool card",
            type: "boolean",
            default: false
        }
    ]
};

const BASH_FS_IGNORED_DIRS = new Set([
    '.agent', '.ion', 'node_modules', '.git', 'venv', '.venv', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', 'target', 'build', 'dist'
]);
const BASH_FS_MAX_SINGLE_FILE = 8 * 1024 * 1024;

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function renderCard(title, badge, bodyHtml) {
    return `<div style="width:100%; border:1px solid var(--border,#2e2e2e); border-radius:8px; overflow:hidden; background:var(--bg-panel,#181818); margin:2px 0; font-family:var(--font-mono, monospace);">
        <div style="display:flex; align-items:center; gap:7px; padding:6px 10px; background:var(--bg-input,rgba(0,0,0,0.25)); border-bottom:1px solid var(--border,#2e2e2e); font-size:11.5px; color:var(--fg,#dcdfe7);">
            <span class="icon" style="font-size:14px; color:var(--primary,#56b6c2);">folder</span>
            <span style="font-weight:600;">${esc(title)}</span>
            <span style="font-size:10px; background:${badge[2]}; color:${badge[1]}; padding:1px 6px; border-radius:3px; font-weight:700;">${esc(badge[0])}</span>
        </div>
        <div style="padding:8px; font-size:11px; color:var(--fg,#dcdfe7);">${bodyHtml}</div>
    </div>`;
}

async function collectWorkspaceSnapshot(api, requestedPaths, maxTotalBytes) {
    const enc = new TextEncoder();
    const items = [];
    const skipped = [];
    let total = 0;

    let candidates;
    if (Array.isArray(requestedPaths) && requestedPaths.length > 0) {
        candidates = requestedPaths
            .map(p => String(p || '').trim().replace(/^\/+/, ''))
            .filter(Boolean);
    } else {
        const all = typeof api?.listFiles === 'function' ? await api.listFiles() : [];
        candidates = all.filter((p) => {
            if (typeof p !== 'string') return false;
            const dirs = p.split('/').slice(0, -1);
            return !dirs.some(seg => BASH_FS_IGNORED_DIRS.has(seg));
        });
    }

    const loadOne = async (fp) => {
        try {
            const binary = typeof api?.isBinary === 'function' && await api.isBinary(fp);
            let content;
            let size = 0;
            if (binary && typeof api?.readFileBytes === 'function') {
                const bytes = await api.readFileBytes(fp);
                if (!(bytes instanceof Uint8Array)) {
                    skipped.push(`${fp} (unreadable binary)`);
                    return;
                }
                if (bytes.byteLength > BASH_FS_MAX_SINGLE_FILE) {
                    skipped.push(`${fp} (>8 MB)`);
                    return;
                }
                content = bytes;
                size = bytes.byteLength;
            } else {
                const text = await api.readFile(fp);
                if (typeof text !== 'string' || text.startsWith('ERROR:')) {
                    skipped.push(`${fp} (${typeof text === 'string' ? text : 'unreadable'})`);
                    return;
                }
                size = enc.encode(text).byteLength;
                if (size > BASH_FS_MAX_SINGLE_FILE) {
                    skipped.push(`${fp} (>8 MB)`);
                    return;
                }
                content = text;
            }
            if (total + size > maxTotalBytes) {
                skipped.push(`${fp} (snapshot limit reached)`);
                return;
            }
            total += size;
            items.push({ path: `/workspace/${fp}`, content });
        } catch (err) {
            skipped.push(`${fp} (${err && err.message ? err.message : 'error'})`);
        }
    };

    for (let i = 0; i < candidates.length; i += 6) {
        await Promise.all(candidates.slice(i, i + 6).map(loadOne));
    }

    return { items, skipped, total };
}

async function handler(args, api) {
    const bridge = self.__ionBashBridge;
    if (!bridge || typeof bridge.fsOp !== 'function') {
        return {
            output: "ERROR: The just-bash bridge is not available in this worker. Run 'bash_run' first to boot the sandbox. (If 'bash_run' already succeeded in this session, Ion is isolating each tool into its own Worker — in that case, use 'bash_run' directly with its 'files' and 'reset' parameters.)"
        };
    }
    if (!bridge.isReady()) {
        const lastErr = typeof bridge.getLastError === 'function' ? bridge.getLastError() : null;
        if (lastErr) {
            return {
                output: `ERROR: The just-bash sandbox failed to start on the last 'bash_run' call:\n${lastErr}`
            };
        }
        return {
            output: "ERROR: The just-bash virtual sandbox is not active yet. Call 'bash_run' first (for example with command: 'ion-info') to boot the sandbox, then retry 'bash_fs'."
        };
    }

    const action = String(args.action || '').trim();
    const okBadge = ['OK', '#98c379', 'rgba(152,195,121,0.18)'];
    const errBadge = ['ERROR', '#e06c75', 'rgba(224,108,117,0.18)'];

    try {
        if (action === 'list') {
            const res = await bridge.fsOp({ op: 'list', path: args.path || '/workspace' });
            const lines = res.files.length
                ? res.files.map(f => `${f.path} (${fmtBytes(f.size)})`)
                : ['(empty)'];
            const text = `Virtual files under ${res.root} (cwd: ${res.cwd}):\n${lines.join('\n')}${res.truncated ? '\n...[truncated]' : ''}`;
            await api.showUI(renderCard(
                `bash_fs list ${res.root}`,
                [`${res.files.length} FILES`, '#61afef', 'rgba(97,175,239,0.18)'],
                `<div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre-wrap; max-height:320px; overflow:auto;">${esc(lines.join('\n'))}</div>`
            ));
            return { output: text, summary: `bash_fs list (${res.files.length} files)` };
        }

        if (action === 'read') {
            if (!args.path || !String(args.path).trim()) {
                return { output: "ERROR: 'path' is required for action 'read'." };
            }
            const res = await bridge.fsOp({ op: 'read', path: args.path });
            const out = typeof api?.cleanupText === 'function' ? api.cleanupText(res.content) : res.content;
            await api.showUI(renderCard(
                `bash_fs read ${res.path}`,
                okBadge,
                `<div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre-wrap; word-break:break-word; max-height:360px; overflow:auto;">${esc(out)}</div>`
            ));
            return { output: out, summary: `bash_fs read ${res.path}` };
        }

        if (action === 'write') {
            if (!args.path || !String(args.path).trim()) {
                return { output: "ERROR: 'path' is required for action 'write'." };
            }
            if (typeof args.content !== 'string') {
                return { output: "ERROR: 'content' string is required for action 'write'." };
            }
            const res = await bridge.fsOp({ op: 'write', path: args.path, content: args.content });
            await api.showUI(renderCard(
                `bash_fs write ${res.path}`,
                okBadge,
                `Wrote ${esc(fmtBytes(res.bytes))} to <code>${esc(res.path)}</code>.`
            ));
            return { output: `Wrote ${res.bytes} bytes to ${res.path}`, summary: `bash_fs write ${res.path}` };
        }

        if (action === 'delete') {
            if (!args.path || !String(args.path).trim()) {
                return { output: "ERROR: 'path' is required for action 'delete'." };
            }
            const res = await bridge.fsOp({ op: 'delete', path: args.path, recursive: !!args.recursive });
            await api.showUI(renderCard(
                `bash_fs delete ${res.path}`,
                okBadge,
                `Deleted <code>${esc(res.path)}</code>.`
            ));
            return { output: `Deleted ${res.path}`, summary: `bash_fs delete ${res.path}` };
        }

        if (action === 'reset') {
            const res = await bridge.fsOp({ op: 'reset' });
            await api.showUI(renderCard(
                'bash_fs reset',
                okBadge,
                `Virtual filesystem cleared. Working directory reset to <code>${esc(res.cwd)}</code>.`
            ));
            return { output: `Virtual filesystem reset. cwd: ${res.cwd}`, summary: 'bash_fs reset' };
        }

        if (action === 'load_workspace') {
            const maxMb = Math.min(128, Math.max(1, Number(await api?.getSetting?.('maxSnapshotMb')) || 32));
            if (typeof api?.setHeaderMsg === 'function') {
                await api.setHeaderMsg('Reading workspace files for virtual snapshot...');
            }
            const { items, skipped, total } = await collectWorkspaceSnapshot(
                api,
                args.workspacePaths,
                maxMb * 1024 * 1024
            );
            const transfer = items
                .filter(it => it.content instanceof Uint8Array)
                .map(it => it.content.buffer);
            const res = await bridge.fsOp({ op: 'writeBatch', items }, transfer);

            const summaryLines = [
                `Loaded ${res.written.length} workspace file(s) (${fmtBytes(total)}) into /workspace (read-only snapshot; host files are not modified by bash_run).`
            ];
            if (res.failed.length) summaryLines.push(`Failed: ${res.failed.join('; ')}`);
            if (skipped.length) summaryLines.push(`Skipped (${skipped.length}): ${skipped.slice(0, 15).join('; ')}${skipped.length > 15 ? ' ...' : ''}`);

            await api.showUI(renderCard(
                'bash_fs load_workspace',
                [`${res.written.length} LOADED`, '#98c379', 'rgba(152,195,121,0.18)'],
                `<div style="white-space:pre-wrap;">${esc(summaryLines.join('\n'))}</div>`
            ));
            return {
                output: summaryLines.join('\n'),
                summary: `Loaded ${res.written.length} workspace file(s) into /workspace`
            };
        }

        return { output: `ERROR: Unsupported action '${action}'.` };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        try {
            await api.showUI(renderCard(`bash_fs ${action}`, errBadge, `<div style="color:var(--red,#e06c75);">${esc(msg)}</div>`));
        } catch (_) { /* best-effort UI */ }
        return { output: `ERROR: ${msg}`, summary: `bash_fs ${action} failed` };
    }
}