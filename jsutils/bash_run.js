// bash_run - Virtual Bash execution tool powered by just-bash (browser build)
const TOOL_META = {
    name: "bash_run",
    description: "Execute Bash commands and shell pipelines inside a sandboxed, in-browser virtual Bash environment (just-bash) backed by an in-memory filesystem.\n\nENVIRONMENT & CONSTRAINTS:\n- Pure In-Memory Sandbox: Runs in a nested Web Worker using just-bash's virtual InMemoryFs (starting at /workspace). Changes persist across bash_run calls within the session, and do NOT modify the host workspace directly.\n- Supported Built-ins: Standard Unix file/text/data tools including cat, cp, ls, mkdir, mv, rm, stat, touch, tree, find, grep, rg, awk, sed, cut, diff, head, tail, sort, uniq, wc, xargs, tr, printf, base64, sha256sum, jq, and full Bash syntax (pipes, redirects, loops, functions, variables, globs, heredocs).\n- Browser Exclusions: python3/python, sqlite3, js-exec, tar, yq, xan, and native OS binaries are NOT available in the browser build. gzip/gunzip/zcat may be unavailable when loaded via the jsDelivr fallback.\n- Network: Disabled by default (curl is unavailable unless network access is enabled in tool settings).\n- Seeding & Resetting: Pass 'files' to populate virtual files before running, or 'reset: true' to start from a clean /workspace. Use 'ion-info' inside bash to inspect sandbox metadata.",
    parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "Bash command or multi-line shell script to execute. May be empty only when 'reset' is true or 'files' are provided.",
                allowEmpty: true
            },
            cwd: {
                type: "string",
                description: "Optional working directory override for this call only (e.g. '/workspace/src'). Defaults to the current virtual working directory."
            },
            env: {
                type: "object",
                description: "Optional key-value map of environment variables for this execution only.",
                additionalProperties: { type: "string" }
            },
            stdin: {
                type: "string",
                description: "Optional standard input passed to the command.",
                allowEmpty: true
            },
            files: {
                type: "object",
                description: "Optional map of virtual file paths to string contents to write into the in-memory filesystem before executing (relative paths resolve against cwd).",
                additionalProperties: { type: "string" }
            },
            reset: {
                type: "boolean",
                description: "If true, resets the in-memory virtual filesystem and working directory to a clean /workspace before writing any 'files' and running 'command'."
            }
        },
        required: ["command"]
    },
    modes: ["plan", "ask", "code"],
    permission: "ask",
    toolBox: 1,
    expanded: false,
    interactive: false,
    settings: [
        {
            key: "version",
            label: "just-bash npm version",
            type: "text",
            default: "3.6.0",
            description: "Published npm version of just-bash to load (e.g. 3.6.0 or latest)."
        },
        {
            key: "cdnProvider",
            label: "CDN loader strategy",
            type: "select",
            options: ["auto", "esm.sh", "jsdelivr"],
            default: "auto",
            description: "'auto' tries esm.sh first (full node:zlib rewrite) and falls back to jsDelivr with an inline node:zlib browser stub."
        },
        {
            key: "customModuleUrl",
            label: "Custom browser bundle URL (optional)",
            type: "text",
            default: "",
            description: "Optional direct ESM URL overriding version/CDN provider."
        },
        {
            key: "limitProfile",
            label: "Execution limit profile",
            type: "select",
            options: ["normal", "hardened"],
            default: "normal",
            description: "just-bash resource cap profile."
        },
        {
            key: "timeoutSec",
            label: "Command timeout (seconds)",
            type: "number",
            default: 30,
            min: 1,
            max: 300,
            description: "Wall-clock timeout for a single bash_run execution."
        },
        {
            key: "persistCwd",
            label: "Persist working directory (cd) across calls",
            type: "boolean",
            default: true,
            description: "Tracks directory changes made by 'cd' so subsequent calls inherit the new cwd."
        },
        {
            key: "allowNetwork",
            label: "Allow network access (curl / html-to-markdown)",
            type: "boolean",
            default: false,
            description: "Enables just-bash network commands. Disabled by default."
        },
        {
            key: "allowedUrlPrefixes",
            label: "Allowed URL prefixes (comma-separated, optional)",
            type: "text",
            default: "",
            description: "When network is enabled, restrict curl to these URL prefixes. Leave empty to allow any HTTPS/HTTP URL."
        },
        {
            key: "autoExpand",
            label: "Auto-expand tool card",
            type: "boolean",
            default: false,
            description: "Open the tool box automatically when the command finishes."
        }
    ]
};

// --- Constants ---------------------------------------------------------------
const BASH_MAX_OUTPUT_CHARS = 16000;
const BASH_INIT_TIMEOUT_MS = 60000;
const BASH_LIVE_INTERVAL_MS = 250;
const BASH_TERM_LINES = 28;
const BASH_TERM_BOX = `font-size:11px; line-height:1.5; max-height:calc(${BASH_TERM_LINES} * 1.5em + 16px); overflow:auto;`;

// --- UI & formatting helpers -------------------------------------------------
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&',
        '<': '<',
        '>': '>',
        '"': '"',
        "'": '''
    }[c]));
}

function clip(text, limit = BASH_MAX_OUTPUT_CHARS) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit / 5);
    const tail = limit - head;
    return `${text.slice(0, head)}\n...[${text.length - limit} chars omitted]...\n${text.slice(-tail)}`;
}

// --- Nested Worker source (completely self-contained) ------------------------
function __bashWorkerMain() {
    let modApi = null;
    let bash = null;
    let vfs = null;
    let currentCwd = '/workspace';
    let trackedCwd = null;
    let runtimeMeta = { version: '', loadedVia: '', limitProfile: 'normal', allowNetwork: false };

    const post = (msg, transfer) => self.postMessage(msg, transfer || []);

    // Minimal Node.js process shim (works around just-bash Issue #111 in browsers)
    function installProcessShim() {
        if (typeof globalThis.process !== 'undefined') return;
        globalThis.process = {
            env: {},
            cwd: () => currentCwd || '/workspace',
            platform: 'browser',
            version: 'v20.19.0',
            versions: { node: '20.19.0' },
            argv: ['node'],
            nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
            hrtime: Object.assign(
                (prev) => {
                    const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    let sec = Math.floor(ms / 1000);
                    let ns = Math.floor((ms % 1000) * 1e6);
                    if (Array.isArray(prev)) {
                        sec -= prev[0];
                        ns -= prev[1];
                        if (ns < 0) { sec -= 1; ns += 1e9; }
                    }
                    return [sec, ns];
                },
                {
                    bigint: () => {
                        const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        return BigInt(Math.floor(ms * 1e6));
                    }
                }
            ),
            stdout: { write: () => true, isTTY: false },
            stderr: { write: () => true, isTTY: false }
        };
    }

    function blockNetwork() {
        const saved = {};
        const errMsg = 'Network access is disabled for just-bash in tool settings.';
        for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker']) {
            if (!(key in self)) continue;
            saved[key] = self[key];
            try {
                self[key] = key === 'fetch'
                    ? () => Promise.reject(new Error(errMsg))
                    : function () { throw new Error(errMsg); };
            } catch (_) { /* ignore non-writable globals */ }
        }
        return {
            restore() {
                for (const key in saved) {
                    try { self[key] = saved[key]; } catch (_) { /* ignore */ }
                }
            }
        };
    }

    function withTimeout(promise, ms, label) {
        let timer = null;
        return new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
            Promise.resolve(promise).then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); }
            );
        });
    }

    const ZLIB_STUB = [
        'export const constants = {};',
        'function unavail(fn){ throw new Error("node:zlib " + fn + " is unavailable in browser fallback mode (switch CDN provider to esm.sh if you need gzip/gunzip)"); }',
        'export function gzipSync(){ unavail("gzipSync"); }',
        'export function gunzipSync(){ unavail("gunzipSync"); }',
        'export function deflateSync(){ unavail("deflateSync"); }',
        'export function inflateSync(){ unavail("inflateSync"); }',
        'export function deflateRawSync(){ unavail("deflateRawSync"); }',
        'export function inflateRawSync(){ unavail("inflateRawSync"); }',
        'export default { constants, gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync };'
    ].join('\n');
    const ZLIB_DATA_URL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(ZLIB_STUB);

    function unwrapExports(mod) {
        if (mod && typeof mod.Bash === 'function') return mod;
        if (mod && mod.default && typeof mod.default.Bash === 'function') return mod.default;
        throw new Error('Module loaded, but no Bash class export was found.');
    }

    async function importWithZlibPatch(url, timeoutMs) {
        const resp = await withTimeout(fetch(url, { mode: 'cors', credentials: 'omit' }), timeoutMs, `Fetching ${url}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        let src = await resp.text();
        const baseUrl = resp.url || url;

        // Patch bare node:zlib imports (just-bash Issue #510) into an inline data-URI ESM stub.
        src = src.replace(/(from\s*|import\s*\(\s*)(["'])node:zlib\2/g, (_, pre, q) => `${pre}${q}${ZLIB_DATA_URL}${q}`);
        // Rewrite relative .js/.mjs chunk imports against the CDN origin so Blob import resolves them.
        src = src.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"'\s]+\.[cm]?js)\2/g, (full, pre, q, rel) => {
            try {
                return `${pre}${q}${new URL(rel, baseUrl).href}${q}`;
            } catch (_) {
                return full;
            }
        });

        const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        try {
            const mod = await withTimeout(import(blobUrl), timeoutMs, `Importing patched bundle from ${url}`);
            return unwrapExports(mod);
        } finally {
            try { URL.revokeObjectURL(blobUrl); } catch (_) { /* ignore */ }
        }
    }

    async function loadJustBash(cfg) {
        installProcessShim();
        const ver = cfg.version || '3.6.0';
        const esmUrl = `https://esm.sh/just-bash@${ver}/browser`;
        const jsdUrl = `https://cdn.jsdelivr.net/npm/just-bash@${ver}/dist/bundle/browser.js`;
        const errors = [];

        if (cfg.customModuleUrl) {
            post({ type: 'status', text: `Loading just-bash from custom URL...` });
            try {
                const mod = unwrapExports(await withTimeout(import(cfg.customModuleUrl), 25000, 'Custom module import'));
                return { mod, loadedVia: cfg.customModuleUrl };
            } catch (e1) {
                errors.push(`direct custom import: ${e1.message || e1}`);
                post({ type: 'status', text: 'Retrying custom URL with node:zlib browser shim...' });
                const mod = await importWithZlibPatch(cfg.customModuleUrl, 25000);
                return { mod, loadedVia: cfg.customModuleUrl + ' (patched)' };
            }
        }

        const plan = cfg.cdnProvider === 'jsdelivr'
            ? ['jsdelivr']
            : cfg.cdnProvider === 'esm.sh'
                ? ['esm.sh']
                : ['esm.sh', 'jsdelivr'];

        for (const source of plan) {
            try {
                if (source === 'esm.sh') {
                    post({ type: 'status', text: `Loading just-bash@${ver} from esm.sh...` });
                    const mod = unwrapExports(await withTimeout(import(esmUrl), 25000, 'esm.sh import'));
                    return { mod, loadedVia: esmUrl };
                }
                if (source === 'jsdelivr') {
                    post({ type: 'status', text: `Loading just-bash@${ver} from jsDelivr (with node:zlib shim)...` });
                    const mod = await importWithZlibPatch(jsdUrl, 25000);
                    return { mod, loadedVia: jsdUrl + ' (zlib-shimmed)' };
                }
            } catch (err) {
                errors.push(`${source}: ${err && err.message ? err.message : String(err)}`);
            }
        }

        throw new Error(`Failed to load just-bash@${ver}:\n- ${errors.join('\n- ')}`);
    }

    function normalizePath(p, base) {
        const raw = String(p || '').trim();
        if (!raw) return base || '/workspace';
        const joined = raw.startsWith('/') ? raw : `${(base || '/workspace').replace(/\/+$/, '')}/${raw}`;
        const out = [];
        for (const seg of joined.split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') out.pop();
            else out.push(seg);
        }
        return '/' + out.join('/');
    }

    function parentDir(absPath) {
        const idx = absPath.lastIndexOf('/');
        return idx <= 0 ? '/' : absPath.slice(0, idx);
    }

    async function ensureDir(fs, dirPath) {
        if (!dirPath || dirPath === '/') return;
        if (typeof fs.mkdir === 'function') {
            try {
                await fs.mkdir(dirPath, { recursive: true });
                return;
            } catch (_) {
                // Fall through to segment-by-segment creation if recursive option is unsupported
            }
            const parts = dirPath.split('/').filter(Boolean);
            let cur = '';
            for (const part of parts) {
                cur += '/' + part;
                try { await fs.mkdir(cur); } catch (_) { /* ignore EEXIST */ }
            }
        }
    }

    async function writeVirtualFile(fs, absPath, content) {
        await ensureDir(fs, parentDir(absPath));
        if (typeof fs.writeFile === 'function') {
            await fs.writeFile(absPath, content);
            return;
        }
        throw new Error('Virtual filesystem does not expose writeFile().');
    }

    function buildNetworkOption(cfg) {
        if (!cfg.allowNetwork) return undefined;
        const prefixes = String(cfg.allowedUrlPrefixes || '')
            .split(/[,\n]/)
            .map(s => s.trim())
            .filter(Boolean);
        if (prefixes.length > 0) {
            return {
                allowedUrlPrefixes: prefixes,
                allowedMethods: ['GET', 'HEAD', 'POST']
            };
        }
        return { dangerouslyAllowFullInternetAccess: true };
    }

    async function createSandbox(cfg) {
        const { Bash, InMemoryFs, defineCommand } = modApi;
        vfs = typeof InMemoryFs === 'function' ? new InMemoryFs() : null;
        currentCwd = '/workspace';

        const customCommands = [];
        if (typeof defineCommand === 'function') {
            // Internal command used to capture post-command $PWD without temp files or stdout pollution.
            customCommands.push(defineCommand('__ion_track_cwd', async (args, ctx) => {
                if (ctx && typeof ctx.cwd === 'string') trackedCwd = ctx.cwd;
                if (!vfs && ctx && ctx.fs) vfs = ctx.fs;
                const code = parseInt(args[0], 10);
                return { stdout: '', stderr: '', exitCode: Number.isFinite(code) ? code : 0 };
            }));

            // Demo custom command illustrating host-side extensions in just-bash.
            customCommands.push(defineCommand('ion-info', async (_args, ctx) => {
                if (!vfs && ctx && ctx.fs) vfs = ctx.fs;
                const lines = [
                    `runtime: just-bash@${runtimeMeta.version}`,
                    `source: ${runtimeMeta.loadedVia}`,
                    `cwd: ${ctx && ctx.cwd ? ctx.cwd : currentCwd}`,
                    `profile: ${runtimeMeta.limitProfile}`,
                    `network: ${runtimeMeta.allowNetwork ? 'enabled' : 'disabled'}`,
                    `fs: InMemoryFs (demo sandbox; host workspace untouched)`
                ];
                return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
            }));
        }

        const baseOpts = {
            cwd: '/workspace',
            env: {
                HOME: '/home/user',
                PWD: '/workspace',
                TERM: 'xterm-256color',
                ION_SANDBOX: 'just-bash'
            },
            customCommands,
            executionLimits: {
                maxExecutionTimeMs: (cfg.timeoutSec || 30) * 1000
            }
        };
        if (vfs) baseOpts.fs = vfs;
        const netOpt = buildNetworkOption(cfg);
        if (netOpt) baseOpts.network = netOpt;
        if (cfg.limitProfile) baseOpts.executionLimitProfile = cfg.limitProfile;

        try {
            bash = new Bash(baseOpts);
        } catch (err) {
            // Older just-bash builds may reject executionLimitProfile; retry without it.
            if (baseOpts.executionLimitProfile && /executionLimitProfile|profile/i.test(String(err && err.message || err))) {
                delete baseOpts.executionLimitProfile;
                bash = new Bash(baseOpts);
            } else {
                throw err;
            }
        }

        if (!vfs && bash && bash.fs) vfs = bash.fs;
        if (vfs) {
            await ensureDir(vfs, '/workspace');
        } else {
            await bash.exec('mkdir -p /workspace');
        }
    }

    async function walkFs(fs, dirPath, maxEntries, out) {
        if (out.length >= maxEntries) return;
        let entries;
        try {
            entries = await fs.readdir(dirPath);
        } catch (_) {
            return;
        }
        if (!Array.isArray(entries)) return;
        entries.sort((a, b) => {
            const na = typeof a === 'string' ? a : (a && a.name) || '';
            const nb = typeof b === 'string' ? b : (b && b.name) || '';
            return na.localeCompare(nb);
        });
        for (const entry of entries) {
            if (out.length >= maxEntries) break;
            const name = typeof entry === 'string' ? entry : (entry && entry.name);
            if (!name || name === '.' || name === '..') continue;
            const full = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
            let isDir = false;
            let size = 0;
            try {
                const st = await fs.stat(full);
                isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : !!(st && st.isDirectory);
                size = typeof st.size === 'number' ? st.size : 0;
            } catch (_) {
                if (entry && typeof entry === 'object') {
                    isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : !!entry.isDirectory;
                }
            }
            if (isDir) {
                await walkFs(fs, full, maxEntries, out);
            } else {
                out.push({ path: full, size });
            }
        }
    }

    async function handleInit(m) {
        const loaded = await loadJustBash(m.cfg);
        modApi = loaded.mod;
        runtimeMeta = {
            version: m.cfg.version || '3.6.0',
            loadedVia: loaded.loadedVia,
            limitProfile: m.cfg.limitProfile || 'normal',
            allowNetwork: !!m.cfg.allowNetwork
        };
        post({ type: 'status', text: 'Initializing virtual filesystem (/workspace)...' });
        await createSandbox(m.cfg);
        return { ...runtimeMeta, cwd: currentCwd };
    }

    async function handleExec(m) {
        if (m.reset) {
            post({ type: 'status', text: 'Resetting virtual sandbox...' });
            await createSandbox(m.cfg);
        }

        const explicitCwd = typeof m.cwd === 'string' && m.cwd.trim() !== '';
        const runCwd = explicitCwd ? normalizePath(m.cwd, currentCwd) : currentCwd;

        if (m.files && typeof m.files === 'object') {
            const entries = Object.entries(m.files);
            if (entries.length) {
                post({ type: 'status', text: `Writing ${entries.length} virtual file(s)...` });
                for (const [fp, content] of entries) {
                    const abs = normalizePath(fp, runCwd);
                    await writeVirtualFile(vfs, abs, content);
                }
            }
        }

        const rawCmd = typeof m.command === 'string' ? m.command : '';
        if (!rawCmd.trim()) {
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
                cwd: currentCwd,
                seeded: m.files ? Object.keys(m.files).length : 0,
                wasReset: !!m.reset
            };
        }

        const useCwdTracker = !!m.persistCwd && typeof modApi.defineCommand === 'function' && !/\\\s*$/.test(rawCmd);
        const script = useCwdTracker ? `${rawCmd}\n__ion_track_cwd $?` : rawCmd;
        trackedCwd = null;

        const execOpts = { cwd: runCwd };
        if (m.env && typeof m.env === 'object' && Object.keys(m.env).length) execOpts.env = m.env;
        if (typeof m.stdin === 'string' && m.stdin.length > 0) execOpts.stdin = m.stdin;

        const timeoutMs = Math.max(1000, (m.timeoutSec || 30) * 1000);
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let abortedByTimeout = false;
        let timer = null;
        if (controller) {
            execOpts.signal = controller.signal;
            timer = setTimeout(() => {
                abortedByTimeout = true;
                try { controller.abort(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)); } catch (_) { /* ignore */ }
            }, timeoutMs);
        }

        post({ type: 'status', text: 'Running command in just-bash...' });
        const netGuard = m.cfg && m.cfg.allowNetwork ? null : blockNetwork();
        let res;
        try {
            res = await bash.exec(script, execOpts);
        } finally {
            if (timer) clearTimeout(timer);
            if (netGuard) netGuard.restore();
        }

        if (!explicitCwd && trackedCwd) {
            currentCwd = trackedCwd;
        }

        let stdout = typeof res.stdout === 'string' ? res.stdout : String(res.stdout || '');
        let stderr = typeof res.stderr === 'string' ? res.stderr : String(res.stderr || '');
        if (useCwdTracker && stderr) {
            stderr = stderr.replace(/^\++ __ion_track_cwd \d+\r?\n?/gm, '');
        }

        return {
            stdout,
            stderr,
            exitCode: typeof res.exitCode === 'number' ? res.exitCode : 0,
            cwd: currentCwd,
            runCwd,
            timedOut: abortedByTimeout,
            seeded: m.files ? Object.keys(m.files).length : 0,
            wasReset: !!m.reset
        };
    }

    async function handleFsOp(m) {
        if (!vfs) throw new Error('Virtual filesystem is not initialized.');
        const op = m.op;

        if (op === 'reset') {
            await createSandbox(m.cfg);
            return { ok: true, cwd: currentCwd };
        }

        if (op === 'list') {
            const target = normalizePath(m.path || '/workspace', currentCwd);
            const maxEntries = Math.min(Math.max(1, Number(m.maxEntries) || 500), 5000);
            const items = [];
            await walkFs(vfs, target, maxEntries, items);
            return { ok: true, root: target, cwd: currentCwd, files: items, truncated: items.length >= maxEntries };
        }

        if (op === 'read') {
            const abs = normalizePath(m.path, currentCwd);
            let text;
            if (typeof vfs.readFile === 'function') {
                const raw = await vfs.readFile(abs);
                text = raw instanceof Uint8Array ? new TextDecoder('utf-8').decode(raw) : String(raw);
            } else {
                const r = await bash.exec('cat', { args: [abs] });
                if (r.exitCode !== 0) throw new Error(r.stderr || `Failed to read ${abs}`);
                text = r.stdout;
            }
            return { ok: true, path: abs, content: text };
        }

        if (op === 'write') {
            const abs = normalizePath(m.path, currentCwd);
            await writeVirtualFile(vfs, abs, m.content);
            const bytes = m.content instanceof Uint8Array
                ? m.content.byteLength
                : new TextEncoder().encode(String(m.content || '')).byteLength;
            return { ok: true, path: abs, bytes };
        }

        if (op === 'writeBatch') {
            const written = [];
            const failed = [];
            for (const item of (m.items || [])) {
                try {
                    const abs = normalizePath(item.path, '/workspace');
                    await writeVirtualFile(vfs, abs, item.content);
                    written.push(abs);
                } catch (e) {
                    failed.push(`${item.path}: ${e && e.message ? e.message : e}`);
                }
            }
            return { ok: true, written, failed, cwd: currentCwd };
        }

        if (op === 'delete') {
            const abs = normalizePath(m.path, currentCwd);
            if (abs === '/' || abs === '/workspace') {
                throw new Error(`Refusing to delete protected virtual directory '${abs}'. Use reset instead.`);
            }
            if (typeof vfs.rm === 'function') {
                await vfs.rm(abs, { recursive: !!m.recursive, force: false });
            } else {
                const args = m.recursive ? ['-r', abs] : [abs];
                const r = await bash.exec('rm', { args });
                if (r.exitCode !== 0) throw new Error(r.stderr || `Failed to delete ${abs}`);
            }
            return { ok: true, path: abs };
        }

        throw new Error(`Unknown fsOp: ${op}`);
    }

    self.onmessage = async (e) => {
        const m = e.data;
        try {
            if (m.type === 'init') {
                post({ id: m.id, type: 'ready', info: await handleInit(m) });
            } else if (m.type === 'exec') {
                post({ id: m.id, type: 'result', data: await handleExec(m) });
            } else if (m.type === 'fsOp') {
                post({ id: m.id, type: 'result', data: await handleFsOp(m) });
            }
        } catch (err) {
            post({
                id: m.id,
                type: 'error',
                message: String((err && err.message) || err),
                stack: err && err.stack ? String(err.stack) : ''
            });
        }
    };
}

// --- Worker lifecycle & shared bridge (reused by companion tools like bash_fs)
function bashRuntimeSig(cfg) {
    const raw = JSON.stringify({
        v: cfg.version,
        p: cfg.cdnProvider,
        u: cfg.customModuleUrl,
        lp: cfg.limitProfile,
        n: cfg.allowNetwork,
        ap: cfg.allowedUrlPrefixes
    }) + __bashWorkerMain.toString();
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

function bashKill() {
    const st = self.__ionBash;
    self.__ionBash = null;
    if (!st) return;
    st.alive = false;
    try { st.worker.terminate(); } catch (_) { /* ignore */ }
    try { URL.revokeObjectURL(st.url); } catch (_) { /* ignore */ }
    for (const l of [...st.listeners]) l({ type: 'fatal', message: 'just-bash worker was terminated.' });
}

function bashGet(cfg) {
    let st = self.__ionBash;
    const sig = bashRuntimeSig(cfg);
    if (st && st.alive && st.sig === sig) return st;
    if (st) bashKill();
    if (typeof Worker === 'undefined') {
        throw new Error('Nested Web Workers are unavailable in this browser.');
    }
    const url = URL.createObjectURL(new Blob([`(${__bashWorkerMain.toString()})()`], { type: 'application/javascript' }));
    const worker = new Worker(url);
    st = { worker, url, sig, cfg, alive: true, seq: 0, listeners: new Set(), ready: null, info: null };
    worker.onmessage = (e) => { for (const l of [...st.listeners]) l(e.data); };
    worker.onerror = (e) => {
        const msg = (e && e.message) ? e.message : 'just-bash worker crashed unexpectedly.';
        st.alive = false;
        for (const l of [...st.listeners]) l({ type: 'fatal', message: msg });
    };
    self.__ionBash = st;
    return st;
}

function bashCall(st, msg, transfer, onEvent, timeoutMs, timeoutMessage) {
    const id = ++st.seq;
    return new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn, val) => {
            if (timer) clearTimeout(timer);
            st.listeners.delete(listener);
            fn(val);
        };
        const listener = (d) => {
            if (d.type === 'fatal') return done(reject, new Error(d.message));
            if (d.id === id) {
                if (d.type === 'error') return done(reject, new Error(d.message));
                return done(resolve, d);
            }
            if (onEvent && d.type === 'status') onEvent(d);
        };
        st.listeners.add(listener);
        if (timeoutMs) {
            timer = setTimeout(() => {
                done(reject, Object.assign(new Error(timeoutMessage || 'Command timed out.'), { timedOut: true }));
            }, timeoutMs);
        }
        st.worker.postMessage({ ...msg, id }, transfer || []);
    });
}

function bashExclusive(fn) {
    const prev = self.__ionBashLock || Promise.resolve();
    const next = prev.catch(() => { }).then(fn);
    self.__ionBashLock = next.catch(() => { });
    return next;
}

async function ensureBashReady(cfg, onEvent) {
    const st = bashGet(cfg);
    if (!st.ready) {
        st.ready = bashCall(
            st,
            { type: 'init', cfg },
            [],
            onEvent,
            BASH_INIT_TIMEOUT_MS,
            'Timed out while loading just-bash from CDN. Check your network connection or try another CDN provider in Settings.'
        ).then((r) => {
            st.info = r.info || null;
            return r;
        });
        st.ready.catch(() => { });
    }
    try {
        await st.ready;
    } catch (err) {
        bashKill();
        throw err;
    }
    return st;
}

// Expose a shared bridge on the Tool Worker global so companion tools (e.g. bash_fs)
// operate on the exact same warm virtual filesystem and execution queue.
self.__ionBashBridge = {
    isReady: () => !!(self.__ionBash && self.__ionBash.alive && self.__ionBash.info),
    getInfo: () => (self.__ionBash && self.__ionBash.info) ? { ...self.__ionBash.info } : null,
    fsOp: (payload, transfer, onEvent) => bashExclusive(async () => {
        const st = self.__ionBash;
        if (!st || !st.alive || !st.ready) {
            throw new Error('just-bash sandbox is not running yet. Run a command with bash_run first to start it.');
        }
        await st.ready;
        const res = await bashCall(
            st,
            { type: 'fsOp', cfg: st.cfg, ...payload },
            transfer || [],
            onEvent,
            30000,
            'Virtual filesystem operation timed out.'
        );
        return res.data;
    }),
    kill: bashKill
};

// --- Card UI rendering -------------------------------------------------------
const BASH_COPY_JS = `(function(b){
    var c=b.closest('[data-bash-card]');
    var k=c.querySelector('[data-bash-pane=cmd]');
    var p=k&&k.style.display!=='none'?k:c.querySelector('[data-bash-pane=out]');
    var t=p?p.querySelector('[data-bash-copy]'):null;
    var s=t?(t.value!==undefined?t.value:t.textContent):'';
    var i=b.querySelector('.icon');
    var ok=function(){if(!i)return;var o=i.textContent;i.textContent='check';i.style.color='var(--green,#98c379)';setTimeout(function(){i.textContent=o;i.style.color=''},1500)};
    function fb(){
        var a=document.createElement('textarea');
        a.value=s;a.style.position='fixed';a.style.opacity='0';
        document.body.appendChild(a);a.select();
        try{document.execCommand('copy');ok()}catch(e){}
        document.body.removeChild(a);
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(s).then(ok,fb)}else{fb()}
})(this)`.replace(/\s*\n\s*/g, '');

const BASH_TOGGLE_JS = `(function(b){
    var c=b.closest('[data-bash-card]');
    var o=c.querySelector('[data-bash-pane=out]');
    var k=c.querySelector('[data-bash-pane=cmd]');
    var cb=c.querySelector('[data-bash-copy-btn]');
    var i=b.querySelector('.icon');
    var showCmd=k.style.display==='none';
    k.style.display=showCmd?'block':'none';
    o.style.display=showCmd?'none':'flex';
    if(i)i.textContent=showCmd?'terminal':'code';
    b.title=showCmd?'View output':'View command';
    b.setAttribute('aria-label',b.title);
    if(cb){cb.title=showCmd?'Copy command':'Copy output';cb.setAttribute('aria-label',cb.title)}
})(this)`.replace(/\s*\n\s*/g, '');

function buildBashCard({ label, badge, secs, cwd, stdout = '', stderr = '', command = '', status = '', live = false }) {
    let body = '';
    if (live) {
        body = `<div style="color:var(--dim,#85858f); font-size:11px; padding:4px 2px;">${esc(status || 'Running...')}</div>`;
    } else {
        const cleanOut = clip(stdout.trimEnd());
        const cleanErr = clip(stderr.trimEnd());
        const combinedForCopy = cleanOut && cleanErr
            ? `${cleanOut}\n\n[stderr]\n${cleanErr}`
            : (cleanOut || cleanErr || '');

        body += `<textarea data-bash-copy hidden>${esc(combinedForCopy)}</textarea>`;
        if (cleanOut) {
            body += `<div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre-wrap; word-break:break-word; color:var(--fg,#dcdfe7); ${BASH_TERM_BOX}">${esc(cleanOut)}</div>`;
        }
        if (cleanErr) {
            body += `<div style="background:rgba(224,108,117,0.08); border:1px solid rgba(224,108,117,0.35); border-radius:6px; padding:8px; white-space:pre-wrap; word-break:break-word; color:var(--red,#e06c75); ${BASH_TERM_BOX}">${esc(cleanErr)}</div>`;
        }
        if (!cleanOut && !cleanErr) {
            body += `<div style="color:var(--dim,#85858f); font-size:11px; padding:4px 2px;">(no output)</div>`;
        }
    }

    const buttons = live ? '' : `
        <button type="button" class="icon-btn" title="View command" aria-label="View command" onclick="${esc(BASH_TOGGLE_JS)}">
            <span class="icon" style="font-size:15px; color:var(--primary,#56b6c2); pointer-events:none;">code</span>
        </button>
        <button type="button" class="icon-btn" data-bash-copy-btn title="Copy output" aria-label="Copy output" onclick="${esc(BASH_COPY_JS)}">
            <span class="icon" style="font-size:14px; pointer-events:none;">content_copy</span>
        </button>`;

    const cmdPane = live ? '' : `
        <div data-bash-pane="cmd" style="display:none;">
            <textarea data-bash-copy hidden>${esc(command)}</textarea>
            <div style="background:var(--bg-input,#1a1a1d); border:1px solid var(--border); border-radius:6px; padding:8px; white-space:pre-wrap; word-break:break-word; color:var(--fg,#ececf1); ${BASH_TERM_BOX}">${esc(command || '(no command)')}</div>
        </div>`;

    const metaBits = [`just-bash`, `${secs}s`];
    if (cwd) metaBits.push(cwd);

    return `<div data-bash-card style="width:100%; border:1px solid var(--border,#2e2e2e); border-radius:8px; overflow:hidden; background:var(--bg-panel,#181818); margin:2px 0; font-family:var(--font-mono, monospace);">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; background:var(--bg-input,rgba(0,0,0,0.25)); border-bottom:1px solid var(--border,#2e2e2e);">
            <div style="display:flex; align-items:center; gap:7px; min-width:0; font-size:11.5px; color:var(--fg,#dcdfe7);">
                <span class="icon" style="font-size:14px; color:var(--primary,#56b6c2); flex-shrink:0;">${live ? 'hourglass_top' : 'terminal'}</span>
                <span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(label)}</span>
                <span style="font-size:10px; background:${badge[2]}; color:${badge[1]}; padding:1px 6px; border-radius:3px; font-weight:700; flex-shrink:0;">${esc(badge[0])}</span>
                <span style="font-size:10px; color:var(--dim,#85858f); flex-shrink:0;">${esc(metaBits.join(' · '))}</span>
            </div>
            <div style="display:flex; align-items:center; gap:3px; flex-shrink:0;">${buttons}</div>
        </div>
        <div style="padding:8px;">
            <div data-bash-pane="out" style="display:flex; flex-direction:column; gap:6px;">${body}</div>
            ${cmdPane}
        </div>
    </div>`;
}

function makeLive(api, getState) {
    const canShow = typeof api?.showUI === 'function';
    let timer = null;
    let heartbeat = null;
    let lastRun = 0;
    let stopped = false;
    let busy = false;
    let dirty = false;

    function push() {
        if (stopped || timer) return;
        timer = setTimeout(render, Math.max(0, BASH_LIVE_INTERVAL_MS - (Date.now() - lastRun)));
    }

    function render() {
        timer = null;
        if (stopped) return;
        if (busy) { dirty = true; return; }
        lastRun = Date.now();
        dirty = false;
        const s = getState();
        if (!canShow) return;
        busy = true;
        const html = buildBashCard({
            label: s.label,
            badge: ['RUNNING', '#61afef', 'rgba(97,175,239,0.18)'],
            secs: ((Date.now() - s.startedAt) / 1000).toFixed(1),
            cwd: s.cwd,
            status: s.status,
            live: true
        });
        Promise.resolve(api.showUI(html, { live: true })).catch(() => { }).then(() => {
            busy = false;
            if (dirty && !stopped) push();
        });
    }

    heartbeat = setInterval(push, 1000);
    push();
    return {
        push,
        stop() {
            stopped = true;
            clearTimeout(timer);
            clearInterval(heartbeat);
            timer = heartbeat = null;
        }
    };
}

// --- Tool handler ------------------------------------------------------------
async function handler(args, api) {
    const command = typeof args.command === 'string' ? args.command : '';
    const reset = !!args.reset;
    const files = (args.files && typeof args.files === 'object' && !Array.isArray(args.files)) ? args.files : null;

    if (!command.trim() && !reset && (!files || Object.keys(files).length === 0)) {
        return { output: "ERROR: 'command' must be non-empty unless 'reset: true' or 'files' is provided." };
    }

    const version = String((await api?.getSetting?.('version')) || '3.6.0').trim();
    const cdnProvider = String((await api?.getSetting?.('cdnProvider')) || 'auto').trim();
    const customModuleUrl = String((await api?.getSetting?.('customModuleUrl')) || '').trim();
    const limitProfile = String((await api?.getSetting?.('limitProfile')) || 'normal').trim();
    const timeoutSec = Math.min(300, Math.max(1, Number(await api?.getSetting?.('timeoutSec')) || 30));
    const persistCwd = (await api?.getSetting?.('persistCwd')) !== false;
    const allowNetwork = !!(await api?.getSetting?.('allowNetwork'));
    const allowedUrlPrefixes = String((await api?.getSetting?.('allowedUrlPrefixes')) || '').trim();

    if (!customModuleUrl && version !== 'latest' && !/^\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$/.test(version)) {
        return { output: `ERROR: Invalid just-bash version '${version}'.` };
    }
    if (customModuleUrl && !/^https?:\/\//i.test(customModuleUrl)) {
        return { output: "ERROR: 'Custom browser bundle URL' must start with http:// or https://." };
    }

    const cfg = {
        version,
        cdnProvider,
        customModuleUrl,
        limitProfile,
        timeoutSec,
        allowNetwork,
        allowedUrlPrefixes
    };

    const firstLine = command.trim().split('\n')[0] || (reset ? 'reset sandbox' : 'write virtual files');
    const shortLabel = firstLine.length > 68 ? firstLine.slice(0, 65) + '...' : firstLine;
    const startedAt = Date.now();
    let status = 'Starting just-bash...';

    const setStatus = (msg) => {
        status = msg;
        if (typeof api?.setHeaderMsg === 'function') {
            Promise.resolve(api.setHeaderMsg(msg)).catch(() => { });
        }
    };

    const live = makeLive(api, () => ({
        label: `$ ${shortLabel}`,
        cwd: args.cwd || '',
        status,
        startedAt
    }));

    let result;
    try {
        result = await bashExclusive(async () => {
            const onEvent = (d) => {
                if (d.type === 'status') {
                    setStatus(d.text);
                    live.push();
                }
            };
            const st = await ensureBashReady(cfg, onEvent);
            const hardTimeoutMs = (timeoutSec + 5) * 1000;
            try {
                const resp = await bashCall(
                    st,
                    {
                        type: 'exec',
                        cfg,
                        command,
                        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                        env: (args.env && typeof args.env === 'object') ? args.env : undefined,
                        stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
                        files,
                        reset,
                        persistCwd,
                        timeoutSec
                    },
                    [],
                    onEvent,
                    hardTimeoutMs,
                    `Command exceeded hard timeout (${timeoutSec}s); virtual shell worker terminated.`
                );
                return resp.data;
            } catch (err) {
                if (err && err.timedOut) bashKill();
                throw err;
            }
        });
    } catch (err) {
        live.stop();
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        const errMsg = err && err.message ? err.message : String(err);
        const isTimeout = !!(err && err.timedOut);
        const badge = isTimeout
            ? ['TIMED OUT', '#e5c07b', 'rgba(229,192,123,0.18)']
            : ['ERROR', '#e06c75', 'rgba(224,108,117,0.18)'];
        try {
            await api.showUI(buildBashCard({
                label: `$ ${shortLabel}`,
                badge,
                secs,
                stderr: errMsg,
                command
            }));
        } catch (_) { /* best-effort UI */ }
        return {
            output: `ERROR: ${errMsg}`,
            summary: isTimeout ? `bash_run timed out (${secs}s)` : `bash_run failed`
        };
    }

    live.stop();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
    const cwd = result.cwd || '/workspace';

    const badge = result.timedOut
        ? ['TIMED OUT', '#e5c07b', 'rgba(229,192,123,0.18)']
        : exitCode === 0
            ? ['EXIT 0', '#98c379', 'rgba(152,195,121,0.18)']
            : [`EXIT ${exitCode}`, '#e06c75', 'rgba(224,108,117,0.18)'];

    try {
        await api.showUI(buildBashCard({
            label: `$ ${shortLabel}`,
            badge,
            secs,
            cwd,
            stdout,
            stderr,
            command
        }));
    } catch (_) { /* best-effort UI */ }

    const parts = [];
    if (stdout.trimEnd()) parts.push(clip(stdout.trimEnd()));
    if (stderr.trimEnd()) parts.push(`[stderr]\n${clip(stderr.trimEnd())}`);
    if (!parts.length) parts.push('(no output)');

    const footer = [];
    if (result.wasReset) footer.push('sandbox reset');
    if (result.seeded > 0) footer.push(`seeded ${result.seeded} file(s)`);
    footer.push(`exit: ${exitCode}`);
    footer.push(`cwd: ${cwd}`);
    if (result.timedOut) footer.push('timed out');

    const output = `${parts.join('\n\n')}\n\n[${footer.join(' | ')}]`;
    return {
        output: typeof api?.cleanupText === 'function' ? api.cleanupText(output) : output,
        summary: `$ ${shortLabel} (${badge[0]})`
    };
}