// bash_fs - Manage the MountableFs lazy workspace bridge and virtual filesystem shared with bash_run
const TOOL_META = {
    name: "bash_fs",
    description: "Optional companion utility for inspecting or resetting the active just-bash MountableFs sandbox (shared with bash_run). By default, bash_run uses 'auto' sync mode so edits under /workspace persist to Ion automatically without calling bash_fs; use bash_fs mainly to inspect sandbox status, clear /tmp or reset the cache, or manage staged diffs/sync/discard when bash_run's syncMode is set to 'staged'.\n\nACTIONS:\n- 'status': Show mount info, lazy vs. cached file counts, and any unsynced changes under /workspace.\n- 'diff': Show unified line diffs between Ion's current host files and unsynced virtual edits under /workspace (optionally scoped to 'path' or 'paths').\n- 'sync': Manually write unsynced /workspace edits (and deletions, unless disabled) back to Ion's host workspace.\n- 'discard': Revert unsynced /workspace edits/deletions back to Ion's host state (optionally scoped to 'path' or 'paths').\n- 'refresh': Re-scan Ion's workspace file list and invalidate cached clean files edited outside bash.\n- 'list': Recursively list virtual files under 'path' (defaults to '/workspace').\n- 'read': Read a virtual file at 'path' (triggers lazy load if uncached).\n- 'write': Create or overwrite a virtual file at 'path' with 'content'.\n- 'delete': Delete a virtual file or directory at 'path' (pass 'recursive: true' for directories).\n- 'reset': Wipe /tmp, reset cwd to /workspace, and remount a clean lazy view of Ion's workspace.",
    parameters: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["status", "diff", "sync", "discard", "refresh", "list", "read", "write", "delete", "reset"],
                description: "Virtual filesystem or workspace-bridge operation to perform."
            },
            path: {
                type: "string",
                description: "Target path (e.g. '/workspace/src/app.js' or 'src/app.js'). Used by list, read, write, delete, diff, sync, or discard."
            },
            paths: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of workspace-relative (or /workspace/...) paths to scope 'diff', 'sync', or 'discard'."
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
            syncDeletions: {
                type: "boolean",
                description: "Override whether action 'sync' propagates /workspace deletions to Ion's host workspace."
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
            key: "autoExpand",
            label: "Auto-expand tool card",
            type: "boolean",
            default: false
        }
    ]
};

const BASH_FS_BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|tgz|7z|rar|wasm|npy|npz|pkl|pickle|parquet|feather|h5|hdf5|joblib|bin|onnx|wav|mp3|mp4|woff2?|ttf|otf|sqlite|db)$/i;

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

// Compact LCS line diff with +/- hunks and 2-line context.
function buildUnifiedDiff(relPath, beforeText, afterText) {
    const a = beforeText === null ? [] : beforeText.replace(/\r\n/g, '\n').split('\n');
    const b = afterText === null ? [] : afterText.replace(/\r\n/g, '\n').split('\n');

    if (a.length * b.length > 400000) {
        return `--- a/${relPath}\n+++ b/${relPath}\n@@ file too large for inline line diff (${a.length} -> ${b.length} lines) @@`;
    }

    // Trim shared prefix/suffix to keep DP small
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length - 1;
    let endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

    const midA = a.slice(start, endA + 1);
    const midB = b.slice(start, endB + 1);
    const m = midA.length;
    const n = midB.length;

    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const ops = [];
    for (let k = 0; k < start; k++) ops.push({ type: ' ', line: a[k] });
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (midA[i] === midB[j]) { ops.push({ type: ' ', line: midA[i++] }); j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: '-', line: midA[i++] });
        else ops.push({ type: '+', line: midB[j++] });
    }
    while (i < m) ops.push({ type: '-', line: midA[i++] });
    while (j < n) ops.push({ type: '+', line: midB[j++] });
    for (let k = endA + 1; k < a.length; k++) ops.push({ type: ' ', line: a[k] });

    const ctx = 2;
    const keep = new Uint8Array(ops.length);
    let hasChange = false;
    for (let idx = 0; idx < ops.length; idx++) {
        if (ops[idx].type !== ' ') {
            hasChange = true;
            for (let c = Math.max(0, idx - ctx); c <= Math.min(ops.length - 1, idx + ctx); c++) keep[c] = 1;
        }
    }
    if (!hasChange) return `--- a/${relPath}\n+++ b/${relPath}\n(no text differences)`;

    const out = [`--- ${beforeText === null ? '/dev/null' : 'a/' + relPath}`, `+++ ${afterText === null ? '/dev/null' : 'b/' + relPath}`];
    let inHunk = false;
    for (let idx = 0; idx < ops.length; idx++) {
        if (keep[idx]) {
            if (!inHunk) {
                out.push('@@ ... @@');
                inHunk = true;
            }
            out.push(`${ops[idx].type}${ops[idx].line}`);
        } else {
            inHunk = false;
        }
    }
    return out.join('\n');
}

function renderDiffHtml(diffText) {
    const lines = diffText.split('\n').slice(0, 400);
    const htmlLines = lines.map((line) => {
        if (line.startsWith('+++') || line.startsWith('---')) {
            return `<div style="color:var(--primary,#56b6c2); font-weight:600;">${esc(line)}</div>`;
        }
        if (line.startsWith('@@')) {
            return `<div style="color:var(--dim,#85858f);">${esc(line)}</div>`;
        }
        if (line.startsWith('+')) {
            return `<div style="color:var(--green,#98c379); background:rgba(152,195,121,0.10);">${esc(line)}</div>`;
        }
        if (line.startsWith('-')) {
            return `<div style="color:var(--red,#e06c75); background:rgba(224,108,117,0.10);">${esc(line)}</div>`;
        }
        return `<div style="color:var(--fg,#dcdfe7);">${esc(line)}</div>`;
    });
    return `<div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre; overflow:auto; max-height:420px; line-height:1.45;">${htmlLines.join('')}</div>`;
}

function collectScopedPaths(args) {
    const list = [];
    if (Array.isArray(args.paths)) {
        for (const p of args.paths) {
            if (typeof p === 'string' && p.trim()) list.push(p.trim());
        }
    }
    if (typeof args.path === 'string' && args.path.trim()) {
        list.push(args.path.trim());
    }
    return list.length ? list : null;
}

async function handler(args, api) {
    const bridge = self.__ionBashBridge;
    if (!bridge || typeof bridge.fsOp !== 'function') {
        return {
            output: "ERROR: The just-bash bridge is not available in this worker. Run 'bash_run' first to boot the sandbox."
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
    const infoBadge = (label) => [label, '#61afef', 'rgba(97,175,239,0.18)'];

    try {
        if (action === 'status') {
            const res = await bridge.fsOp({ op: 'status' }, api);
            const rt = res.runtime || {};
            const ws = res.workspace || {};
            const modeLabel = rt.syncMode || 'auto';
            const changeLabel = modeLabel === 'auto' ? 'Unsynced' : 'Staged';
            const lines = [
                `Runtime: just-bash@${rt.version || '?'} (${rt.mountMode || 'in-memory'})`,
                `CWD: ${res.cwd || '/workspace'}`,
                `Sync mode: ${modeLabel}`
            ];
            if (ws.enabled) {
                lines.push(`Workspace files: ${ws.hostKnownCount} known (${ws.lazyCount} lazy, ${ws.materializedCount} cached in memory)`);
                if (ws.dirtyTotal === 0) {
                    lines.push(`${changeLabel} changes: clean (no unsynced /workspace modifications)`);
                } else {
                    lines.push(`${changeLabel} changes (${ws.dirtyTotal}):`);
                    for (const p of ws.created) lines.push(`  A  ${p}`);
                    for (const p of ws.modified) lines.push(`  M  ${p}`);
                    for (const p of ws.deleted) lines.push(`  D  ${p}`);
                }
            } else {
                lines.push('Workspace mount: disabled (pure in-memory sandbox)');
            }

            const badge = ws.dirtyTotal > 0
                ? [`${ws.dirtyTotal} ${changeLabel.toUpperCase()}`, '#e5c07b', 'rgba(229,192,123,0.18)']
                : okBadge;
            await api.showUI(renderCard(
                'bash_fs status',
                badge,
                `<div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre-wrap;">${esc(lines.join('\n'))}</div>`
            ));
            return { output: lines.join('\n'), summary: ws.dirtyTotal > 0 ? `bash_fs status (${ws.dirtyTotal} ${changeLabel.toLowerCase()})` : 'bash_fs status (clean)' };
        }

        if (action === 'diff') {
            const filterPaths = collectScopedPaths(args);
            const res = await bridge.fsOp({ op: 'exportDirty', paths: filterPaths }, api);
            const writes = res.writes || [];
            const deletes = res.deletes || [];

            if (writes.length === 0 && deletes.length === 0) {
                await api.showUI(renderCard('bash_fs diff', okBadge, 'No staged changes under <code>/workspace</code>.'));
                return { output: 'No staged changes under /workspace.', summary: 'bash_fs diff (clean)' };
            }

            const dec = new TextDecoder('utf-8', { fatal: true });
            const chunks = [];

            for (const w of writes) {
                const bytes = w.bytes instanceof Uint8Array ? w.bytes : new Uint8Array(w.bytes || []);
                const isBin = BASH_FS_BINARY_EXT.test(w.relPath) || bytes.includes(0);
                if (isBin) {
                    chunks.push(`--- ${w.existedOnHost ? 'a/' + w.relPath : '/dev/null'}\n+++ b/${w.relPath}\n[binary file, ${fmtBytes(bytes.byteLength)}]`);
                    continue;
                }
                let afterText;
                try {
                    afterText = dec.decode(bytes);
                } catch (_) {
                    chunks.push(`--- ${w.existedOnHost ? 'a/' + w.relPath : '/dev/null'}\n+++ b/${w.relPath}\n[non-UTF-8 binary file, ${fmtBytes(bytes.byteLength)}]`);
                    continue;
                }
                let beforeText = null;
                if (w.existedOnHost) {
                    const hostRead = await api.readFile(w.relPath);
                    beforeText = (typeof hostRead === 'string' && !hostRead.startsWith('ERROR:')) ? hostRead : '';
                }
                chunks.push(buildUnifiedDiff(w.relPath, beforeText, afterText));
            }

            for (const d of deletes) {
                const isBin = BASH_FS_BINARY_EXT.test(d.relPath) || (typeof api.isBinary === 'function' && await api.isBinary(d.relPath));
                if (isBin) {
                    chunks.push(`--- a/${d.relPath}\n+++ /dev/null\n[deleted binary file]`);
                } else {
                    const hostRead = await api.readFile(d.relPath);
                    const beforeText = (typeof hostRead === 'string' && !hostRead.startsWith('ERROR:')) ? hostRead : '';
                    chunks.push(buildUnifiedDiff(d.relPath, beforeText, null));
                }
            }

            const fullDiff = chunks.join('\n\n');
            const out = typeof api?.cleanupText === 'function' ? api.cleanupText(fullDiff) : fullDiff;
            const total = writes.length + deletes.length;
            await api.showUI(renderCard(`bash_fs diff (${total} file${total === 1 ? '' : 's'})`, infoBadge(`${total} CHANGED`), renderDiffHtml(out)));
            return { output: out, summary: `bash_fs diff (${total} file${total === 1 ? '' : 's'})` };
        }

        if (action === 'sync') {
            const filterPaths = collectScopedPaths(args);
            const opts = { paths: filterPaths };
            if (typeof args.syncDeletions === 'boolean') opts.syncDeletions = args.syncDeletions;
            const rep = await bridge.syncToHost(api, opts);

            const lines = [];
            if (rep.written.length) lines.push(`Synced writes (${rep.written.length}): ${rep.written.join(', ')}`);
            if (rep.deleted.length) lines.push(`Synced deletions (${rep.deleted.length}): ${rep.deleted.join(', ')}`);
            if (rep.skippedDeletes.length) lines.push(`Skipped deletions (syncDeletions=false): ${rep.skippedDeletes.join(', ')}`);
            if (rep.errors.length) lines.push(`Errors (${rep.errors.length}):\n- ${rep.errors.join('\n- ')}`);
            if (!lines.length) lines.push('Nothing to sync (no staged changes under /workspace).');

            const badge = rep.errors.length
                ? ['PARTIAL / ERROR', '#e5c07b', 'rgba(229,192,123,0.18)']
                : okBadge;
            await api.showUI(renderCard(
                'bash_fs sync',
                badge,
                `<div style="white-space:pre-wrap;">${esc(lines.join('\n'))}</div>`
            ));
            return {
                output: lines.join('\n'),
                summary: `bash_fs sync (${rep.written.length} written, ${rep.deleted.length} deleted)`
            };
        }

        if (action === 'discard') {
            const filterPaths = collectScopedPaths(args);
            const res = await bridge.fsOp({ op: 'discard', paths: filterPaths }, api);
            const lines = [];
            if (res.reverted.length) lines.push(`Reverted to Ion workspace (${res.reverted.length}): ${res.reverted.join(', ')}`);
            if (res.removedNew.length) lines.push(`Removed untracked virtual files (${res.removedNew.length}): ${res.removedNew.join(', ')}`);
            if (!lines.length) lines.push('No staged changes to discard.');
            await api.showUI(renderCard('bash_fs discard', okBadge, `<div style="white-space:pre-wrap;">${esc(lines.join('\n'))}</div>`));
            return { output: lines.join('\n'), summary: `bash_fs discard (${res.reverted.length + res.removedNew.length} reverted)` };
        }

        if (action === 'refresh') {
            const res = await bridge.fsOp({ op: 'refresh' }, api);
            const msg = `Workspace mount refreshed: +${res.added} new, -${res.removed} removed, ${res.invalidated} cached file(s) invalidated.`;
            await api.showUI(renderCard('bash_fs refresh', okBadge, esc(msg)));
            return { output: msg, summary: 'bash_fs refresh' };
        }

        if (action === 'list') {
            const res = await bridge.fsOp({ op: 'list', path: args.path || '/workspace' }, api);
            const lines = res.files.length
                ? res.files.map(f => `${f.path} (${fmtBytes(f.size)})`)
                : ['(empty)'];
            const text = `Virtual files under ${res.root} (cwd: ${res.cwd}):\n${lines.join('\n')}${res.truncated ? '\n...[truncated]' : ''}`;
            await api.showUI(renderCard(
                `bash_fs list ${res.root}`,
                infoBadge(`${res.files.length} FILES`),
                `<div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre-wrap; max-height:320px; overflow:auto;">${esc(lines.join('\n'))}</div>`
            ));
            return { output: text, summary: `bash_fs list (${res.files.length} files)` };
        }

        if (action === 'read') {
            if (!args.path || !String(args.path).trim()) {
                return { output: "ERROR: 'path' is required for action 'read'." };
            }
            const res = await bridge.fsOp({ op: 'read', path: args.path }, api);
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
            const res = await bridge.fsOp({ op: 'write', path: args.path, content: args.content }, api);
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
            const res = await bridge.fsOp({ op: 'delete', path: args.path, recursive: !!args.recursive }, api);
            await api.showUI(renderCard(
                `bash_fs delete ${res.path}`,
                okBadge,
                `Deleted <code>${esc(res.path)}</code>.`
            ));
            return { output: `Deleted ${res.path}`, summary: `bash_fs delete ${res.path}` };
        }

        if (action === 'reset') {
            const res = await bridge.fsOp({ op: 'reset' }, api);
            await api.showUI(renderCard(
                'bash_fs reset',
                okBadge,
                `Sandbox reset. Working directory is <code>${esc(res.cwd)}</code> with a clean lazy workspace mount.`
            ));
            return { output: `Sandbox reset. cwd: ${res.cwd}`, summary: 'bash_fs reset' };
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
