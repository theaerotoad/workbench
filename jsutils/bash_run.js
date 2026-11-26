// bash_run - Virtual Bash execution tool powered by just-bash with MountableFs lazy workspace bridge
const TOOL_META = {
    name: "bash_run",
    description: "Execute Bash commands and shell pipelines inside a sandboxed, in-browser virtual Bash environment (just-bash) mounted directly over Ion's workspace at /workspace.\n\nENVIRONMENT & FILESYSTEM MODEL:\n- Live Workspace (`/workspace`): Default working directory. Workspace files are lazily loaded on demand and cached in memory (auto-refreshed when edited outside bash). By default (`syncMode: 'auto'`), all files created, modified, renamed, or deleted under `/workspace` are automatically synced back to Ion's workspace when the command finishes — no separate sync call is needed. Ion's protected paths (`.git`, `.env`, `.agent/`, etc.) remain enforced by the host; in 'auto' mode, host-rejected writes or deletions are automatically reverted in `/workspace` so virtual state never drifts from Ion.\n- Scratch Space (`/tmp`, `/home/user`): Pure in-memory scratch directories that persist across calls in the session and are never synced back to Ion's workspace.\n- Supported Built-ins: Standard Unix file/text/data tools including cat, cp, ls, mkdir, mv, rm, stat, touch, tree, find, grep, rg, awk, sed, cut, diff, head, tail, sort, uniq, wc, xargs, tr, printf, base64, sha256sum, jq, and full Bash syntax (pipes, redirects, loops, functions, variables, globs, heredocs).\n- Browser Exclusions: python3/python, sqlite3, js-exec, tar, yq, xan, and native OS binaries are NOT available in the browser build. gzip/gunzip/zcat are unavailable in fallback mode.\n- Network: Disabled by default (`curl` requires enabling network access in settings).\n- Built-in Sandbox Command: Run `ion-info` inside bash to inspect runtime, mount, cache, and sync status.",
    parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "Bash command or multi-line shell script to execute. May be empty only when 'reset' is true, 'sync' is true, or 'files' are provided.",
                allowEmpty: true
            },
            cwd: {
                type: "string",
                description: "Optional working directory override for this call only (e.g. '/workspace/src' or '/tmp'). Defaults to the current virtual working directory."
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
                description: "Optional map of virtual file paths to string contents to write before executing (relative paths resolve against cwd).",
                additionalProperties: { type: "string" }
            },
            sync: {
                type: "boolean",
                description: "Forces syncing any unsynced /workspace changes back to Ion after this command (automatic by default when syncMode is 'auto')."
            },
            reset: {
                type: "boolean",
                description: "If true, clears /tmp, resets cwd to /workspace, and remounts a fresh lazy view of Ion's workspace before running."
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
            options: ["auto", "jsdelivr-patched", "esm.sh"],
            default: "auto",
            description: "'auto' loads the jsDelivr browser bundle with es-module-lexer import inlining (recommended), falling back to esm.sh."
        },
        {
            key: "customModuleUrl",
            label: "Custom browser bundle URL (optional)",
            type: "text",
            default: "",
            description: "Optional direct ESM URL overriding version/CDN provider."
        },
        {
            key: "mountWorkspace",
            label: "Mount Ion workspace lazily at /workspace",
            type: "boolean",
            default: true,
            description: "Exposes Ion workspace files under /workspace on demand via MountableFs. Disable for a completely empty sandbox."
        },
        {
            key: "syncMode",
            label: "Workspace write-back mode",
            type: "select",
            options: ["auto", "staged"],
            default: "auto",
            description: "'auto' (default) writes /workspace changes back to Ion automatically after every command and reverts any host-rejected paths. 'staged' holds edits in memory until you run bash_fs sync (or pass sync: true)."
        },
        {
            key: "syncDeletions",
            label: "Sync file deletions back to Ion workspace",
            type: "boolean",
            default: true,
            description: "When syncing /workspace changes, propagate rm deletions to Ion's workspace (via checkpointed api.deleteFile)."
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
const BASH_MAX_TEXT_FILE = 16 * 1024 * 1024;
const BASH_MAX_BIN_FILE = 32 * 1024 * 1024;
const BASH_BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|tgz|7z|rar|wasm|npy|npz|pkl|pickle|parquet|feather|h5|hdf5|joblib|bin|onnx|wav|mp3|mp4|mov|avi|woff2?|ttf|otf|eot|exe|dll|so|dylib|sqlite|db)$/i;
const BASH_IGNORED_DIRS = new Set([
    '.agent', '.ion', 'node_modules', '.git', 'venv', '.venv', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'target', 'build', 'dist'
]);

// --- UI & formatting helpers -------------------------------------------------
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
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
    let rootFs = null;
    let wsMount = null;
    let currentCwd = '/workspace';
    let trackedCwd = null;
    let rpcSeq = 0;
    const pendingRpcs = new Map();
    let runtimeMeta = {
        version: '',
        loadedVia: '',
        limitProfile: 'normal',
        allowNetwork: false,
        mountWorkspace: true,
        mountMode: 'in-memory',
        syncMode: 'auto'
    };

    const post = (msg, transfer) => self.postMessage(msg, transfer || []);

    function hostRpc(method, params) {
        const rpcId = ++rpcSeq;
        return new Promise((resolve, reject) => {
            pendingRpcs.set(rpcId, { resolve, reject });
            post({ type: 'host_rpc', rpcId, method, params: params || {} });
        });
    }

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

    function utf8ToDataUrl(code) {
        const bytes = new TextEncoder().encode(code);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return 'data:text/javascript;base64,' + btoa(bin);
    }

    const toDataUrl = (code) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code);

    const ZLIB_DATA_URL = toDataUrl([
        'export const constants = {};',
        'function unavail(fn){ throw new Error("node:zlib " + fn + " is unavailable in browser fallback mode"); }',
        'export function gzipSync(){ unavail("gzipSync"); }',
        'export function gunzipSync(){ unavail("gunzipSync"); }',
        'export function deflateSync(){ unavail("deflateSync"); }',
        'export function inflateSync(){ unavail("inflateSync"); }',
        'export function deflateRawSync(){ unavail("deflateRawSync"); }',
        'export function inflateRawSync(){ unavail("inflateRawSync"); }',
        'export default { constants, gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync };'
    ].join('\n'));

    const PROCESS_DATA_URL = toDataUrl([
        'const p = globalThis.process || { env: {}, cwd: () => "/workspace", platform: "browser", versions: {} };',
        'export const env = p.env;',
        'export const cwd = p.cwd;',
        'export const platform = p.platform;',
        'export const versions = p.versions;',
        'export const argv = p.argv || ["node"];',
        'export const nextTick = p.nextTick || ((fn, ...a) => Promise.resolve().then(() => fn(...a)));',
        'export default p;'
    ].join('\n'));

    const BUFFER_CDN_URL = 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm';

    const NODE_BUILTINS = new Set([
        'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'https',
        'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline',
        'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'vm', 'worker_threads', 'zlib'
    ]);

    const nodeStubCache = new Map();
    function getNodeBuiltinUrl(spec) {
        let normalized = spec;
        const esmNodeMatch = String(spec || '').match(/^(?:https?:\/\/esm\.sh)?\/node\/([a-z0-9_/-]+)\.mjs(?:\?.*)?$/i);
        if (esmNodeMatch) normalized = 'node:' + esmNodeMatch[1];
        const bare = normalized.startsWith('node:') ? normalized.slice(5) : normalized;
        const root = bare.split('/')[0];
        if (!normalized.startsWith('node:') && !NODE_BUILTINS.has(root)) return null;
        if (root === 'zlib') return ZLIB_DATA_URL;
        if (root === 'process') return PROCESS_DATA_URL;
        if (root === 'buffer') return BUFFER_CDN_URL;
        if (nodeStubCache.has(bare)) return nodeStubCache.get(bare);
        const code = [
            `const err = () => { throw new Error("Node built-in '${normalized}' is unavailable in the browser sandbox."); };`,
            'const stub = new Proxy(err, { get(_t, k) { if (k === "__esModule") return true; if (k === "default") return stub; return err; } });',
            'export default stub;'
        ].join('\n');
        const url = toDataUrl(code);
        nodeStubCache.set(bare, url);
        return url;
    }

    function unwrapExports(mod) {
        if (mod && typeof mod.Bash === 'function') return mod;
        if (mod && mod.default && typeof mod.default.Bash === 'function') return mod.default;
        throw new Error('Module loaded, but no Bash class export was found.');
    }

    let cachedEsmParse = null;
    async function getEsmParse(timeoutMs) {
        if (cachedEsmParse) return cachedEsmParse;
        const candidates = [
            'https://cdn.jsdelivr.net/npm/es-module-lexer@1.7.0/+esm',
            'https://cdn.jsdelivr.net/npm/es-module-lexer@1.7.0/dist/lexer.asm.js',
            'https://cdn.jsdelivr.net/npm/es-module-lexer@1.7.0/dist/lexer.js'
        ];
        const errs = [];
        for (const url of candidates) {
            try {
                const mod = await withTimeout(import(url), Math.min(timeoutMs, 15000), 'Loading es-module-lexer');
                const initFn = mod.init || (mod.default && mod.default.init);
                const parseFn = mod.parse || (mod.default && mod.default.parse);
                if (typeof parseFn !== 'function') throw new Error('parse() export missing');
                if (initFn) await initFn;
                cachedEsmParse = parseFn;
                return cachedEsmParse;
            } catch (err) {
                errs.push(`${url}: ${err && err.message ? err.message : err}`);
            }
        }
        throw new Error(`Could not load es-module-lexer:\n- ${errs.join('\n- ')}`);
    }

    function collectImportLiterals(src, parseEsm) {
        const [imports] = parseEsm(src);
        const matches = [];
        for (const imp of imports) {
            if (imp.d === -2) continue;
            const spec = imp.n;
            if (typeof spec !== 'string' || !spec) continue;
            let start;
            let end;
            const chAtS = src[imp.s];
            if ((chAtS === '"' || chAtS === "'") && src[imp.e - 1] === chAtS) {
                start = imp.s;
                end = imp.e;
            } else if (imp.s > 0 && (src[imp.s - 1] === '"' || src[imp.s - 1] === "'") && src[imp.e] === src[imp.s - 1]) {
                start = imp.s - 1;
                end = imp.e + 1;
            } else {
                continue;
            }
            matches.push({ start, end, value: spec });
        }
        return matches;
    }

    function resolveBareNpmCandidates(spec, pkgDeps) {
        let pkgName;
        let subpath = '';
        if (spec.startsWith('@')) {
            const parts = spec.split('/');
            if (parts.length < 2) return [];
            pkgName = `${parts[0]}/${parts[1]}`;
            if (parts.length > 2) subpath = '/' + parts.slice(2).join('/');
        } else {
            const slash = spec.indexOf('/');
            if (slash === -1) {
                pkgName = spec;
            } else {
                pkgName = spec.slice(0, slash);
                subpath = spec.slice(slash);
            }
        }

        let targetPkg = pkgName;
        let versionSpec = pkgDeps && typeof pkgDeps[pkgName] === 'string' ? pkgDeps[pkgName].trim() : '';
        if (versionSpec.startsWith('npm:')) {
            const aliased = versionSpec.slice(4);
            const atIdx = aliased.lastIndexOf('@');
            if (atIdx > 0) {
                targetPkg = aliased.slice(0, atIdx);
                versionSpec = aliased.slice(atIdx + 1);
            } else {
                targetPkg = aliased;
                versionSpec = '';
            }
        }

        const cleanVerMatch = versionSpec.match(/^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
        const verPart = cleanVerMatch ? `@${cleanVerMatch[1]}` : '';
        return [
            `https://cdn.jsdelivr.net/npm/${targetPkg}${verPart}${subpath}/+esm`,
            `https://esm.sh/${targetPkg}${verPart}${subpath}?bundle`
        ];
    }

    async function fetchPackageDeps(ver, timeoutMs) {
        try {
            const url = `https://cdn.jsdelivr.net/npm/just-bash@${ver}/package.json`;
            const resp = await withTimeout(fetch(url, { mode: 'cors', credentials: 'omit' }), Math.min(timeoutMs, 10000), 'Fetching package.json');
            if (!resp.ok) return {};
            const pkg = await resp.json();
            return (pkg && typeof pkg.dependencies === 'object' && pkg.dependencies) ? pkg.dependencies : {};
        } catch (_) {
            return {};
        }
    }

    async function importPatchedModuleGraph(entryUrl, { pkgDeps = {}, timeoutMs = 25000 } = {}) {
        const parseEsm = await getEsmParse(timeoutMs);
        const inlineByUrl = new Map();
        const visiting = new Set();
        const rewrittenLog = new Set();
        let fetchedCount = 0;
        const MAX_MODULES = 60;

        async function fetchFirstOk(urls) {
            const errs = [];
            for (const u of urls) {
                try {
                    const resp = await withTimeout(fetch(u, { mode: 'cors', credentials: 'omit' }), timeoutMs, `Fetching ${u}`);
                    if (!resp.ok) {
                        errs.push(`HTTP ${resp.status} on ${u}`);
                        continue;
                    }
                    const text = await resp.text();
                    return { text, finalUrl: resp.url || u, requestedUrl: u };
                } catch (err) {
                    errs.push(`${u}: ${err && err.message ? err.message : err}`);
                }
            }
            throw new Error(errs.join('; '));
        }

        async function loadAndInline(urls, isEntry) {
            const list = Array.isArray(urls) ? urls : [urls];
            for (const u of list) {
                if (inlineByUrl.has(u)) return inlineByUrl.get(u);
            }
            if (list.some(u => visiting.has(u))) return list[0];
            if (++fetchedCount > MAX_MODULES) {
                throw new Error(`Module graph exceeded ${MAX_MODULES} files while loading ${list[0]}`);
            }

            for (const u of list) visiting.add(u);
            try {
                const { text: src, finalUrl, requestedUrl } = await fetchFirstOk(list);
                if (inlineByUrl.has(finalUrl)) return inlineByUrl.get(finalUrl);
                visiting.add(finalUrl);

                const lits = collectImportLiterals(src, parseEsm);
                const replacements = [];

                for (const lit of lits) {
                    const spec = lit.value;
                    let mapped = null;

                    const nodeUrl = getNodeBuiltinUrl(spec);
                    if (nodeUrl) {
                        mapped = /^https?:\/\//i.test(nodeUrl) ? await loadAndInline(nodeUrl, false) : nodeUrl;
                    } else if (/^(data:|blob:)/i.test(spec)) {
                        mapped = null;
                    } else if (/^https?:\/\//i.test(spec)) {
                        mapped = await loadAndInline(spec, false);
                    } else if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) {
                        const resolved = new URL(spec, finalUrl).href;
                        const resolvedNode = getNodeBuiltinUrl(resolved);
                        if (resolvedNode) {
                            mapped = /^https?:\/\//i.test(resolvedNode) ? await loadAndInline(resolvedNode, false) : resolvedNode;
                        } else {
                            mapped = await loadAndInline(resolved, false);
                        }
                    } else {
                        const candidates = resolveBareNpmCandidates(spec, pkgDeps);
                        if (candidates.length) {
                            mapped = await loadAndInline(candidates, false);
                        }
                    }

                    if (mapped && mapped !== spec) {
                        rewrittenLog.add(spec);
                        replacements.push({ start: lit.start, end: lit.end, text: JSON.stringify(mapped) });
                    }
                }

                let out = src;
                if (replacements.length) {
                    replacements.sort((a, b) => a.start - b.start);
                    let cursor = 0;
                    const chunks = [];
                    for (const r of replacements) {
                        if (r.start < cursor) continue;
                        chunks.push(src.slice(cursor, r.start), r.text);
                        cursor = r.end;
                    }
                    chunks.push(src.slice(cursor));
                    out = chunks.join('');
                }

                if (isEntry) return { code: out, finalUrl };

                const dataUrl = utf8ToDataUrl(out);
                inlineByUrl.set(requestedUrl, dataUrl);
                inlineByUrl.set(finalUrl, dataUrl);
                return dataUrl;
            } finally {
                for (const u of list) visiting.delete(u);
            }
        }

        const entry = await loadAndInline(entryUrl, true);
        const rootBlob = URL.createObjectURL(new Blob([entry.code], { type: 'application/javascript' }));
        try {
            try {
                const mod = await withTimeout(import(rootBlob), timeoutMs, `Importing patched module from ${entryUrl}`);
                return unwrapExports(mod);
            } catch (blobErr) {
                const bMsg = blobErr && blobErr.message ? blobErr.message : String(blobErr);
                if (/dynamically imported module|Failed to fetch|Importing a module/i.test(bMsg)) {
                    const rootData = utf8ToDataUrl(entry.code);
                    const mod = await withTimeout(import(rootData), timeoutMs, `Importing data-URI module from ${entryUrl}`);
                    return unwrapExports(mod);
                }
                throw blobErr;
            }
        } catch (err) {
            const specs = [...rewrittenLog].slice(0, 12).join(', ');
            const msg = err && err.message ? err.message : String(err);
            throw new Error(specs ? `${msg} [rewrote: ${specs}]` : msg);
        } finally {
            try { URL.revokeObjectURL(rootBlob); } catch (_) { /* ignore */ }
        }
    }

    async function loadJustBash(cfg) {
        installProcessShim();
        const ver = cfg.version || '3.6.0';
        const jsdRawUrl = `https://cdn.jsdelivr.net/npm/just-bash@${ver}/dist/bundle/browser.js`;
        const esmExternals = 'node:zlib,node:buffer,node:process,node:fs,node:path,node:os,node:tty,node:module,node:worker_threads,node:child_process,node:crypto,node:net,node:http,node:https,node:tls,node:dns,node:readline,node:vm';
        const esmUrl = `https://esm.sh/just-bash@${ver}/browser?bundle&external=${esmExternals}`;
        const errors = [];

        if (cfg.customModuleUrl) {
            post({ type: 'status', text: 'Loading just-bash from custom URL...' });
            try {
                const mod = unwrapExports(await withTimeout(import(cfg.customModuleUrl), 25000, 'Custom module import'));
                return { mod, loadedVia: cfg.customModuleUrl };
            } catch (e1) {
                errors.push(`direct custom import: ${e1.message || e1}`);
                post({ type: 'status', text: 'Retrying custom URL with es-module-lexer browser shim...' });
                const pkgDeps = await fetchPackageDeps(ver, 10000);
                const mod = await importPatchedModuleGraph(cfg.customModuleUrl, { pkgDeps, timeoutMs: 25000 });
                return { mod, loadedVia: cfg.customModuleUrl + ' (inlined)' };
            }
        }

        const provider = cfg.cdnProvider || 'auto';
        const plan = (provider === 'jsdelivr-patched' || provider === 'jsdelivr' || provider === 'jsdelivr-esm')
            ? ['jsdelivr-patched']
            : provider === 'esm.sh'
                ? ['esm.sh']
                : ['jsdelivr-patched', 'esm.sh'];

        for (const source of plan) {
            try {
                if (source === 'jsdelivr-patched') {
                    post({ type: 'status', text: `Loading just-bash@${ver} from jsDelivr (inlining dependencies)...` });
                    const pkgDeps = await fetchPackageDeps(ver, 10000);
                    const mod = await importPatchedModuleGraph(jsdRawUrl, { pkgDeps, timeoutMs: 30000 });
                    return { mod, loadedVia: jsdRawUrl + ' (inlined)' };
                }
                if (source === 'esm.sh') {
                    post({ type: 'status', text: `Loading just-bash@${ver} from esm.sh (inlining dependencies)...` });
                    const mod = await importPatchedModuleGraph(esmUrl, { pkgDeps: {}, timeoutMs: 30000 });
                    return { mod, loadedVia: esmUrl + ' (inlined)' };
                }
            } catch (err) {
                errors.push(`${source}: ${err && err.message ? err.message : String(err)}`);
            }
        }

        throw new Error(`Failed to load just-bash@${ver}:\n- ${errors.join('\n- ')}`);
    }

    function normalizePath(p, base) {
        const raw = String(p || '').replace(/\\/g, '/').trim();
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
            } catch (_) { /* fall through */ }
            const parts = dirPath.split('/').filter(Boolean);
            let cur = '';
            for (const part of parts) {
                cur += '/' + part;
                try { await fs.mkdir(cur); } catch (_) { /* ignore EEXIST */ }
            }
        }
    }

    // --- Lazy Workspace Mount (wraps InMemoryFs, mounted at /workspace in MountableFs) ---
    function createLazyWorkspaceMount(InMemoryFsCtor, enabled) {
        const mem = new InMemoryFsCtor();
        const hostKnown = new Set();        // mount-relative paths known to exist on Ion host (e.g. '/src/a.js')
        const lazySet = new Set();          // paths registered as placeholders, not yet read from Ion
        const materialized = new Map();     // path -> { size, mtime, isBinary } for cached host reads
        const statCache = new Map();        // path -> { size, mtime, isBinary } for lazy stat metadata
        const dirtySet = new Set();         // paths created or modified in /workspace
        const deletedSet = new Set();       // host-known paths deleted in /workspace
        const pendingSync = new Set();      // dirty/deleted paths not yet attempted by auto-sync
        const inFlight = new Map();         // path -> Promise (dedupes concurrent reads)
        const execCounters = { lazyReads: 0, lazyStats: 0 };

        function norm(p) {
            return normalizePath(p || '/', '/');
        }

        function toHostRel(mountPath) {
            return mountPath.startsWith('/') ? mountPath.slice(1) : mountPath;
        }

        function resetExecCounters() {
            execCounters.lazyReads = 0;
            execCounters.lazyStats = 0;
        }

        async function resolveSymlinkIfNeeded(p) {
            const np = norm(p);
            if (typeof mem.realpath === 'function') {
                try { return norm(await mem.realpath(np)); } catch (_) { return np; }
            }
            return np;
        }

        async function resolveLazyKey(rawPath) {
            const np = norm(rawPath);
            if (lazySet.has(np)) return np;
            const real = await resolveSymlinkIfNeeded(np);
            if (lazySet.has(real)) return real;
            if (np.startsWith('/workspace/')) {
                const stripped = np.slice('/workspace'.length);
                if (lazySet.has(stripped)) return stripped;
            }
            return null;
        }

        async function materializeOne(rawPath) {
            const p = await resolveLazyKey(rawPath);
            if (!p) return;
            if (inFlight.has(p)) return inFlight.get(p);

            const job = (async () => {
                const rel = toHostRel(p);
                const res = await hostRpc('readFile', { path: rel });
                if (!lazySet.has(p)) return; // overwritten or deleted while RPC was in flight
                await ensureDir(mem, parentDir(p));
                const payload = res.isBinary
                    ? (res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data || []))
                    : String(res.data == null ? '' : res.data);
                await mem.writeFile(p, payload);
                lazySet.delete(p);
                const meta = {
                    size: typeof res.size === 'number'
                        ? res.size
                        : (payload instanceof Uint8Array ? payload.byteLength : new TextEncoder().encode(payload).byteLength),
                    mtime: typeof res.mtime === 'number' ? res.mtime : null,
                    isBinary: !!res.isBinary
                };
                materialized.set(p, meta);
                statCache.set(p, meta);
                execCounters.lazyReads += 1;
            })();

            inFlight.set(p, job);
            try {
                await job;
            } finally {
                inFlight.delete(p);
            }
        }

        async function materializeSubtree(rawPath) {
            const p = norm(rawPath);
            if (lazySet.has(p)) {
                await materializeOne(p);
                return;
            }
            const prefix = p === '/' ? '/' : p + '/';
            const targets = [];
            for (const lp of lazySet) {
                if (lp === p || lp.startsWith(prefix)) targets.push(lp);
            }
            for (let i = 0; i < targets.length; i += 6) {
                await Promise.all(targets.slice(i, i + 6).map(t => materializeOne(t)));
            }
        }

        function listMemFilesUnder(p) {
            const np = norm(p);
            const prefix = np === '/' ? '/' : np + '/';
            const all = typeof mem.getAllPaths === 'function' ? mem.getAllPaths() : [];
            const matches = [];
            for (const item of all) {
                const ni = norm(item);
                if (ni === np || ni.startsWith(prefix)) matches.push(ni);
            }
            return matches;
        }

        async function filterFilesOnly(paths) {
            const out = [];
            for (const p of paths) {
                try {
                    const st = await mem.lstat(p);
                    const isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : !!st.isDirectory;
                    if (!isDir) out.push(p);
                } catch (_) { /* ignore */ }
            }
            return out;
        }

        async function putPlaceholder(p) {
            await ensureDir(mem, parentDir(p));
            await mem.writeFile(p, new Uint8Array(0));
            lazySet.add(p);
        }

        async function syncManifest(manifestRelPaths) {
            if (!enabled) return { added: 0, removed: 0, invalidated: 0 };
            const incoming = new Set();
            for (const rel of (manifestRelPaths || [])) {
                if (typeof rel !== 'string' || !rel.trim()) continue;
                incoming.add(norm('/' + rel.replace(/^\/+/, '')));
            }

            let added = 0;
            let removed = 0;
            let invalidated = 0;

            // 1. Register new host files as lazy placeholders
            for (const p of incoming) {
                if (!hostKnown.has(p)) {
                    hostKnown.add(p);
                    if (!dirtySet.has(p) && !deletedSet.has(p)) {
                        await putPlaceholder(p);
                        added += 1;
                    }
                }
            }

            // 2. Remove files that disappeared on host (unless locally dirty)
            for (const p of [...hostKnown]) {
                if (!incoming.has(p)) {
                    hostKnown.delete(p);
                    deletedSet.delete(p);
                    statCache.delete(p);
                    if (!dirtySet.has(p)) {
                        lazySet.delete(p);
                        materialized.delete(p);
                        try { await mem.rm(p, { force: true }); } catch (_) { /* ignore */ }
                        removed += 1;
                    }
                }
            }

            // 3. Check already-materialized clean files for external edits in Ion's editor
            const toCheck = [];
            for (const p of materialized.keys()) {
                if (!dirtySet.has(p) && incoming.has(p)) toCheck.push(p);
            }
            if (toCheck.length > 0) {
                try {
                    const hostStats = await hostRpc('statFiles', { paths: toCheck.map(toHostRel) });
                    for (const p of toCheck) {
                        const rel = toHostRel(p);
                        const cur = hostStats && hostStats[rel];
                        const prev = materialized.get(p);
                        if (!cur) continue;
                        const sizeChanged = typeof cur.size === 'number' && prev && cur.size !== prev.size;
                        const mtimeChanged = typeof cur.mtime === 'number' && prev && typeof prev.mtime === 'number' && cur.mtime !== prev.mtime;
                        if (sizeChanged || mtimeChanged) {
                            materialized.delete(p);
                            statCache.set(p, cur);
                            await putPlaceholder(p);
                            invalidated += 1;
                        }
                    }
                } catch (_) { /* best-effort staleness check */ }
            }

            return { added, removed, invalidated };
        }

        async function exportDirty(filterPaths, pendingOnly = false) {
            const filterSet = Array.isArray(filterPaths) && filterPaths.length
                ? new Set(filterPaths.map(p => norm(String(p).replace(/^\/workspace(?=\/|$)/, '') || '/')))
                : null;

            const writes = [];
            for (const p of [...dirtySet].sort()) {
                if (filterSet && !filterSet.has(p)) continue;
                if (pendingOnly && !pendingSync.has(p)) continue;
                let buf;
                if (typeof mem.readFileBytes === 'function') {
                    buf = await mem.readFileBytes(p);
                } else if (typeof mem.readFileBuffer === 'function') {
                    buf = await mem.readFileBuffer(p);
                } else {
                    const txt = await mem.readFile(p);
                    buf = txt instanceof Uint8Array ? txt : new TextEncoder().encode(String(txt));
                }
                const bytes = buf instanceof Uint8Array ? new Uint8Array(buf) : new TextEncoder().encode(String(buf));
                writes.push({
                    mountPath: p,
                    relPath: toHostRel(p),
                    existedOnHost: hostKnown.has(p),
                    bytes
                });
            }

            const deletes = [];
            for (const p of [...deletedSet].sort()) {
                if (filterSet && !filterSet.has(p)) continue;
                if (pendingOnly && !pendingSync.has(p)) continue;
                deletes.push({ mountPath: p, relPath: toHostRel(p) });
            }

            return { writes, deletes };
        }

        async function markSynced(syncedWrites, syncedDeletes, attemptedPaths) {
            for (const rel of (attemptedPaths || [])) {
                const p = norm('/' + String(rel).replace(/^\/+/, ''));
                pendingSync.delete(p);
            }
            for (const item of (syncedWrites || [])) {
                const p = norm('/' + String(item.relPath || item).replace(/^\/+/, ''));
                dirtySet.delete(p);
                deletedSet.delete(p);
                pendingSync.delete(p);
                lazySet.delete(p);
                hostKnown.add(p);
                const meta = item.stat || {
                    size: typeof item.size === 'number' ? item.size : 0,
                    mtime: null,
                    isBinary: !!item.isBinary
                };
                materialized.set(p, meta);
                statCache.set(p, meta);
            }
            for (const rel of (syncedDeletes || [])) {
                const p = norm('/' + String(rel).replace(/^\/+/, ''));
                deletedSet.delete(p);
                dirtySet.delete(p);
                pendingSync.delete(p);
                hostKnown.delete(p);
                lazySet.delete(p);
                materialized.delete(p);
                statCache.delete(p);
            }
        }

        async function discardDirty(filterPaths) {
            const filterSet = Array.isArray(filterPaths) && filterPaths.length
                ? new Set(filterPaths.map(p => norm(String(p).replace(/^\/workspace(?=\/|$)/, '') || '/')))
                : null;

            const reverted = [];
            const removedNew = [];

            for (const p of [...dirtySet]) {
                if (filterSet && !filterSet.has(p)) continue;
                dirtySet.delete(p);
                pendingSync.delete(p);
                materialized.delete(p);
                statCache.delete(p);
                if (hostKnown.has(p)) {
                    await putPlaceholder(p);
                    reverted.push(toHostRel(p));
                } else {
                    try { await mem.rm(p, { force: true }); } catch (_) { /* ignore */ }
                    removedNew.push(toHostRel(p));
                }
            }

            for (const p of [...deletedSet]) {
                if (filterSet && !filterSet.has(p)) continue;
                deletedSet.delete(p);
                pendingSync.delete(p);
                if (hostKnown.has(p)) {
                    await putPlaceholder(p);
                    reverted.push(toHostRel(p));
                }
            }

            return { reverted: reverted.sort(), removedNew: removedNew.sort() };
        }

        function getStatus() {
            const created = [];
            const modified = [];
            for (const p of [...dirtySet].sort()) {
                if (hostKnown.has(p)) modified.push(toHostRel(p));
                else created.push(toHostRel(p));
            }
            const deleted = [...deletedSet].sort().map(toHostRel);
            return {
                enabled,
                hostKnownCount: hostKnown.size,
                lazyCount: lazySet.size,
                materializedCount: materialized.size,
                created,
                modified,
                deleted,
                dirtyTotal: created.length + modified.length + deleted.length,
                pendingSyncTotal: pendingSync.size,
                execLazyReads: execCounters.lazyReads,
                execLazyStats: execCounters.lazyStats
            };
        }

        // Plain-object IFileSystem adapter (NOT `instanceof InMemoryFs`, and hides `*Sync`
        // shortcuts like `readFileSync` / `writeFileSync`) so just-bash always takes the async
        // IFileSystem path and never reads 0-byte placeholders directly from `mem`.
        const HIDDEN_PROPS = new Set(['writeFileLazy']);
        const PASSTHROUGH_METHODS = new Set([
            'exists', 'readdir', 'readdirWithFileTypes', 'mkdir', 'chmod', 'utimes',
            'symlink', 'readlink', 'realpath', 'resolvePath', 'getAllPaths', 'getMemoryUsage',
            'toString', 'valueOf'
        ]);
        const READ_LIKE_RE = /read|open|stream|byte|buf|text|content|slice|range|chunk|limit|load/i;

        function isHiddenProp(prop) {
            if (typeof prop !== 'string') return false;
            return HIDDEN_PROPS.has(prop) || prop.endsWith('Sync');
        }

        const explicit = {
            async readFile(p, opts) {
                await materializeOne(p);
                return mem.readFile(p, opts);
            },
            async readFileBytes(p, opts) {
                await materializeOne(p);
                return typeof mem.readFileBytes === 'function'
                    ? mem.readFileBytes(p, opts)
                    : mem.readFileBuffer(p);
            },
            async readFileBuffer(p, opts) {
                await materializeOne(p);
                return mem.readFileBuffer(p, opts);
            },
            async stat(p) {
                const np = await resolveLazyKey(p);
                const st = await mem.stat(p);
                if (!np) return st;
                let meta = statCache.get(np);
                if (!meta) {
                    try {
                        meta = await hostRpc('statFile', { path: toHostRel(np) });
                        if (meta) {
                            statCache.set(np, meta);
                            execCounters.lazyStats += 1;
                        }
                    } catch (_) { meta = null; }
                }
                if (!meta) return st;
                const copy = Object.assign(Object.create(Object.getPrototypeOf(st)), st);
                if (typeof meta.size === 'number') copy.size = meta.size;
                if (typeof meta.mtime === 'number') copy.mtime = new Date(meta.mtime * 1000);
                return copy;
            },
            async lstat(p) {
                const np = lazySet.has(norm(p)) ? norm(p) : null;
                const st = await mem.lstat(p);
                if (!np) return st;
                let meta = statCache.get(np);
                if (!meta) {
                    try {
                        meta = await hostRpc('statFile', { path: toHostRel(np) });
                        if (meta) {
                            statCache.set(np, meta);
                            execCounters.lazyStats += 1;
                        }
                    } catch (_) { meta = null; }
                }
                if (!meta) return st;
                const copy = Object.assign(Object.create(Object.getPrototypeOf(st)), st);
                if (typeof meta.size === 'number') copy.size = meta.size;
                if (typeof meta.mtime === 'number') copy.mtime = new Date(meta.mtime * 1000);
                return copy;
            },
            async writeFile(p, content, opts) {
                const np = norm(p);
                lazySet.delete(np);
                materialized.delete(np);
                statCache.delete(np);
                const r = await mem.writeFile(p, content, opts);
                dirtySet.add(np);
                deletedSet.delete(np);
                pendingSync.add(np);
                return r;
            },
            async appendFile(p, content, opts) {
                const np = norm(p);
                if (lazySet.has(np)) await materializeOne(np);
                const r = await mem.appendFile(p, content, opts);
                materialized.delete(np);
                statCache.delete(np);
                dirtySet.add(np);
                deletedSet.delete(np);
                pendingSync.add(np);
                return r;
            },
            async rm(p, opts) {
                const np = norm(p);
                const beforeFiles = await filterFilesOnly(listMemFilesUnder(np));
                const r = await mem.rm(p, opts);
                for (const fp of beforeFiles) {
                    lazySet.delete(fp);
                    materialized.delete(fp);
                    statCache.delete(fp);
                    dirtySet.delete(fp);
                    if (hostKnown.has(fp)) {
                        deletedSet.add(fp);
                        pendingSync.add(fp);
                    } else {
                        pendingSync.delete(fp);
                    }
                }
                return r;
            },
            async mv(src, dest) {
                const ns = norm(src);
                const nd = norm(dest);
                await materializeSubtree(ns);
                const beforeFiles = await filterFilesOnly(listMemFilesUnder(ns));
                const r = await mem.mv(src, dest);
                for (const oldP of beforeFiles) {
                    const newP = oldP === ns ? nd : norm(nd + oldP.slice(ns.length));
                    lazySet.delete(oldP);
                    materialized.delete(oldP);
                    statCache.delete(oldP);
                    dirtySet.delete(oldP);
                    if (hostKnown.has(oldP)) {
                        deletedSet.add(oldP);
                        pendingSync.add(oldP);
                    } else {
                        pendingSync.delete(oldP);
                    }

                    lazySet.delete(newP);
                    materialized.delete(newP);
                    statCache.delete(newP);
                    deletedSet.delete(newP);
                    dirtySet.add(newP);
                    pendingSync.add(newP);
                }
                return r;
            },
            async cp(src, dest, opts) {
                const ns = norm(src);
                const nd = norm(dest);
                await materializeSubtree(ns);
                const r = await mem.cp(src, dest, opts);
                const afterFiles = await filterFilesOnly(listMemFilesUnder(nd));
                for (const fp of afterFiles) {
                    lazySet.delete(fp);
                    materialized.delete(fp);
                    statCache.delete(fp);
                    deletedSet.delete(fp);
                    dirtySet.add(fp);
                    pendingSync.add(fp);
                }
                return r;
            },
            async link(existingPath, newPath) {
                const ne = norm(existingPath);
                const nn = norm(newPath);
                if (lazySet.has(ne)) await materializeOne(ne);
                const r = await mem.link(existingPath, newPath);
                lazySet.delete(nn);
                deletedSet.delete(nn);
                dirtySet.add(nn);
                pendingSync.add(nn);
                return r;
            }
        };

        const proxy = new Proxy(explicit, {
            has(target, prop) {
                if (isHiddenProp(prop)) return false;
                if (prop in target) return true;
                return prop in mem;
            },
            get(target, prop) {
                if (isHiddenProp(prop)) return undefined;
                if (Object.prototype.hasOwnProperty.call(target, prop)) {
                    return target[prop];
                }
                const val = mem[prop];
                if (typeof val !== 'function') return val;
                if (typeof prop === 'string') {
                    if (PASSTHROUGH_METHODS.has(prop)) {
                        return val.bind(mem);
                    }
                    // Guard any future async read/open/stream/bytes method added in just-bash
                    if (READ_LIKE_RE.test(prop)) {
                        return async (...args) => {
                            if (typeof args[0] === 'string') {
                                await materializeOne(args[0]);
                            }
                            return val.apply(mem, args);
                        };
                    }
                }
                return val.bind(mem);
            }
        });

        return {
            fs: proxy,
            syncManifest,
            exportDirty,
            markSynced,
            discardDirty,
            getStatus,
            resetExecCounters
        };
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

    async function createSandbox(cfg, initialManifest) {
        const { Bash, InMemoryFs, MountableFs, defineCommand } = modApi;
        currentCwd = '/workspace';

        const wantMount = cfg.mountWorkspace !== false;
        let baseFs = null;

        if (typeof MountableFs === 'function' && typeof InMemoryFs === 'function') {
            baseFs = new InMemoryFs();
            wsMount = createLazyWorkspaceMount(InMemoryFs, wantMount);
            rootFs = new MountableFs({
                base: baseFs,
                mounts: [{ mountPoint: '/workspace', filesystem: wsMount.fs }]
            });
            runtimeMeta.mountMode = wantMount
                ? 'MountableFs (/workspace -> lazy Ion bridge, /tmp -> scratch)'
                : 'MountableFs (/workspace -> scratch InMemoryFs)';
        } else {
            wsMount = createLazyWorkspaceMount(InMemoryFs, false);
            rootFs = wsMount.fs;
            await ensureDir(rootFs, '/workspace');
            runtimeMeta.mountMode = 'InMemoryFs (MountableFs unavailable)';
        }

        if (wantMount && Array.isArray(initialManifest) && initialManifest.length > 0) {
            await wsMount.syncManifest(initialManifest);
        }

        const customCommands = [];
        if (typeof defineCommand === 'function') {
            customCommands.push(defineCommand('__ion_track_cwd', async (args, ctx) => {
                if (ctx && typeof ctx.cwd === 'string') trackedCwd = ctx.cwd;
                const code = parseInt(args[0], 10);
                return { stdout: '', stderr: '', exitCode: Number.isFinite(code) ? code : 0 };
            }));

            customCommands.push(defineCommand('ion-info', async (_args, ctx) => {
                const st = wsMount ? wsMount.getStatus() : null;
                const lines = [
                    `runtime: just-bash@${runtimeMeta.version}`,
                    `source: ${runtimeMeta.loadedVia}`,
                    `cwd: ${ctx && ctx.cwd ? ctx.cwd : currentCwd}`,
                    `profile: ${runtimeMeta.limitProfile}`,
                    `network: ${runtimeMeta.allowNetwork ? 'enabled' : 'disabled'}`,
                    `mount: ${runtimeMeta.mountMode}`,
                    `syncMode: ${runtimeMeta.syncMode}`
                ];
                if (st && st.enabled) {
                    lines.push(
                        `workspace: ${st.hostKnownCount} host files (${st.lazyCount} lazy, ${st.materializedCount} cached)`,
                        `dirty: ${st.created.length} created, ${st.modified.length} modified, ${st.deleted.length} deleted`
                    );
                }
                return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
            }));
        }

        const baseOpts = {
            fs: rootFs,
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
        const netOpt = buildNetworkOption(cfg);
        if (netOpt) baseOpts.network = netOpt;
        if (cfg.limitProfile) baseOpts.executionLimitProfile = cfg.limitProfile;

        try {
            bash = new Bash(baseOpts);
        } catch (err) {
            if (baseOpts.executionLimitProfile && /executionLimitProfile|profile/i.test(String(err && err.message || err))) {
                delete baseOpts.executionLimitProfile;
                bash = new Bash(baseOpts);
            } else {
                throw err;
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
                const st = await fs.lstat(full);
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
            allowNetwork: !!m.cfg.allowNetwork,
            mountWorkspace: m.cfg.mountWorkspace !== false,
            mountMode: 'initializing',
            syncMode: m.cfg.syncMode || 'auto'
        };
        post({ type: 'status', text: 'Mounting lazy workspace (/workspace) via MountableFs...' });
        await createSandbox(m.cfg, m.manifest);
        return { ...runtimeMeta, cwd: currentCwd };
    }

    async function handleExec(m) {
        runtimeMeta.syncMode = (m.cfg && m.cfg.syncMode) || runtimeMeta.syncMode;

        if (m.reset) {
            post({ type: 'status', text: 'Resetting virtual sandbox and remounting /workspace...' });
            await createSandbox(m.cfg, m.manifest);
        } else if (wsMount && Array.isArray(m.manifest)) {
            await wsMount.syncManifest(m.manifest);
        }

        if (wsMount) wsMount.resetExecCounters();

        const explicitCwd = typeof m.cwd === 'string' && m.cwd.trim() !== '';
        const runCwd = explicitCwd ? normalizePath(m.cwd, currentCwd) : currentCwd;

        if (m.files && typeof m.files === 'object') {
            const entries = Object.entries(m.files);
            if (entries.length) {
                post({ type: 'status', text: `Writing ${entries.length} virtual file(s)...` });
                for (const [fp, content] of entries) {
                    const abs = normalizePath(fp, runCwd);
                    await writeVirtualFile(rootFs, abs, content);
                }
            }
        }

        const rawCmd = typeof m.command === 'string' ? m.command : '';
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        let timedOut = false;

        if (rawCmd.trim()) {
            const useCwdTracker = !!m.persistCwd && typeof modApi.defineCommand === 'function' && !/\\\s*$/.test(rawCmd);
            const script = useCwdTracker ? `${rawCmd}\n__ion_track_cwd $?` : rawCmd;
            trackedCwd = null;

            const execOpts = { cwd: runCwd };
            if (m.env && typeof m.env === 'object' && Object.keys(m.env).length) execOpts.env = m.env;
            if (typeof m.stdin === 'string' && m.stdin.length > 0) execOpts.stdin = m.stdin;

            const timeoutMs = Math.max(1000, (m.timeoutSec || 30) * 1000);
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            let timer = null;
            if (controller) {
                execOpts.signal = controller.signal;
                timer = setTimeout(() => {
                    timedOut = true;
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

            if (!explicitCwd && trackedCwd) currentCwd = trackedCwd;
            stdout = typeof res.stdout === 'string' ? res.stdout : String(res.stdout || '');
            stderr = typeof res.stderr === 'string' ? res.stderr : String(res.stderr || '');
            if (useCwdTracker && stderr) {
                stderr = stderr.replace(/^\++ __ion_track_cwd \d+\r?\n?/gm, '');
            }
            exitCode = typeof res.exitCode === 'number' ? res.exitCode : 0;
        }

        const wsStatus = wsMount ? wsMount.getStatus() : null;
        return {
            stdout,
            stderr,
            exitCode,
            cwd: currentCwd,
            runCwd,
            timedOut,
            seeded: m.files ? Object.keys(m.files).length : 0,
            wasReset: !!m.reset,
            wsStatus
        };
    }

    async function handleFsOp(m) {
        if (!rootFs) throw new Error('Virtual filesystem is not initialized.');
        const op = m.op;

        if (op === 'status') {
            return {
                ok: true,
                cwd: currentCwd,
                runtime: { ...runtimeMeta },
                workspace: wsMount ? wsMount.getStatus() : null
            };
        }

        if (op === 'refresh') {
            if (!wsMount) return { ok: true, added: 0, removed: 0, invalidated: 0, workspace: null };
            const diff = await wsMount.syncManifest(m.manifest || []);
            return { ok: true, ...diff, cwd: currentCwd, workspace: wsMount.getStatus() };
        }

        if (op === 'reset') {
            await createSandbox(m.cfg, m.manifest);
            return { ok: true, cwd: currentCwd, workspace: wsMount ? wsMount.getStatus() : null };
        }

        if (op === 'exportDirty') {
            if (!wsMount) return { ok: true, writes: [], deletes: [] };
            const exported = await wsMount.exportDirty(m.paths, !!m.pendingOnly);
            return { ok: true, ...exported };
        }

        if (op === 'markSynced') {
            if (wsMount) await wsMount.markSynced(m.syncedWrites, m.syncedDeletes, m.attemptedPaths);
            return { ok: true, workspace: wsMount ? wsMount.getStatus() : null };
        }

        if (op === 'discard') {
            if (!wsMount) return { ok: true, reverted: [], removedNew: [] };
            const res = await wsMount.discardDirty(m.paths);
            return { ok: true, ...res, workspace: wsMount.getStatus() };
        }

        if (op === 'list') {
            const target = normalizePath(m.path || '/workspace', currentCwd);
            const maxEntries = Math.min(Math.max(1, Number(m.maxEntries) || 500), 5000);
            const items = [];
            await walkFs(rootFs, target, maxEntries, items);
            return { ok: true, root: target, cwd: currentCwd, files: items, truncated: items.length >= maxEntries };
        }

        if (op === 'read') {
            const abs = normalizePath(m.path, currentCwd);
            let text;
            if (typeof rootFs.readFile === 'function') {
                const raw = await rootFs.readFile(abs);
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
            await writeVirtualFile(rootFs, abs, m.content);
            const bytes = m.content instanceof Uint8Array
                ? m.content.byteLength
                : new TextEncoder().encode(String(m.content || '')).byteLength;
            return { ok: true, path: abs, bytes, workspace: wsMount ? wsMount.getStatus() : null };
        }

        if (op === 'delete') {
            const abs = normalizePath(m.path, currentCwd);
            if (abs === '/' || abs === '/workspace') {
                throw new Error(`Refusing to delete protected virtual directory '${abs}'. Use reset instead.`);
            }
            if (typeof rootFs.rm === 'function') {
                await rootFs.rm(abs, { recursive: !!m.recursive, force: false });
            } else {
                const args = m.recursive ? ['-r', abs] : [abs];
                const r = await bash.exec('rm', { args });
                if (r.exitCode !== 0) throw new Error(r.stderr || `Failed to delete ${abs}`);
            }
            return { ok: true, path: abs, workspace: wsMount ? wsMount.getStatus() : null };
        }

        throw new Error(`Unknown fsOp: ${op}`);
    }

    self.onmessage = async (e) => {
        const m = e.data;
        if (!m) return;

        // Resolve host_rpc responses synchronously so suspended bash/FS calls resume immediately.
        if (m.type === 'host_rpc_res') {
            const p = pendingRpcs.get(m.rpcId);
            if (p) {
                pendingRpcs.delete(m.rpcId);
                if (m.ok) p.resolve(m.result);
                else p.reject(new Error(m.error || 'Host RPC failed'));
            }
            return;
        }

        try {
            if (m.type === 'init') {
                post({ id: m.id, type: 'ready', info: await handleInit(m) });
            } else if (m.type === 'exec') {
                post({ id: m.id, type: 'result', data: await handleExec(m) });
            } else if (m.type === 'fsOp') {
                const data = await handleFsOp(m);
                const transfer = (m.op === 'exportDirty' && Array.isArray(data.writes))
                    ? data.writes.filter(w => w.bytes instanceof Uint8Array).map(w => w.bytes.buffer)
                    : [];
                post({ id: m.id, type: 'result', data }, transfer);
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

// --- Host-side workspace helpers (Tool Worker) -------------------------------
async function listWorkspaceManifest(api) {
    if (typeof api?.listFiles !== 'function') return [];
    const all = await api.listFiles();
    if (!Array.isArray(all)) return [];
    return all.filter((p) => {
        if (typeof p !== 'string' || !p) return false;
        const dirs = p.split('/').slice(0, -1);
        return !dirs.some(seg => BASH_IGNORED_DIRS.has(seg));
    });
}

async function handleHostRpc(st, req) {
    const api = st.activeApi;
    const reply = (ok, resultOrErr, transfer) => {
        if (!st.alive) return;
        try {
            if (ok) {
                st.worker.postMessage({ type: 'host_rpc_res', rpcId: req.rpcId, ok: true, result: resultOrErr }, transfer || []);
            } else {
                st.worker.postMessage({ type: 'host_rpc_res', rpcId: req.rpcId, ok: false, error: String(resultOrErr) });
            }
        } catch (_) { /* worker terminated */ }
    };

    if (!api) {
        return reply(false, 'No active Ion tool API context for host_rpc.');
    }

    try {
        const method = req.method;
        const params = req.params || {};

        if (method === 'statFile') {
            const fp = String(params.path || '');
            let stat = null;
            if (typeof api.statFile === 'function') {
                stat = await api.statFile(fp);
            }
            if (!stat && typeof api.fileExists === 'function') {
                const exists = await api.fileExists(fp);
                if (exists) {
                    const isBinary = BASH_BINARY_EXT.test(fp) || (typeof api.isBinary === 'function' && await api.isBinary(fp));
                    stat = { size: 0, mtime: null, isBinary: !!isBinary };
                }
            }
            return reply(true, stat);
        }

        if (method === 'statFiles') {
            const paths = Array.isArray(params.paths) ? params.paths : [];
            const out = {};
            if (typeof api.statFile === 'function') {
                for (let i = 0; i < paths.length; i += 8) {
                    const batch = paths.slice(i, i + 8);
                    const results = await Promise.all(batch.map(p => api.statFile(p).catch(() => null)));
                    for (let j = 0; j < batch.length; j++) out[batch[j]] = results[j];
                }
            }
            return reply(true, out);
        }

        if (method === 'readFile') {
            const fp = String(params.path || '');
            let stat = null;
            if (typeof api.statFile === 'function') {
                try { stat = await api.statFile(fp); } catch (_) { stat = null; }
            }
            const binary = (stat && stat.isBinary)
                || BASH_BINARY_EXT.test(fp)
                || (typeof api.isBinary === 'function' && await api.isBinary(fp));

            if (binary && typeof api.readFileBytes === 'function') {
                const bytes = await api.readFileBytes(fp);
                if (!(bytes instanceof Uint8Array)) {
                    return reply(false, typeof bytes === 'string' ? bytes : `Cannot read binary file '${fp}'`);
                }
                if (bytes.byteLength > BASH_MAX_BIN_FILE) {
                    return reply(false, `File '${fp}' exceeds ${BASH_MAX_BIN_FILE >> 20} MB binary read limit.`);
                }
                const copy = new Uint8Array(bytes);
                return reply(
                    true,
                    { isBinary: true, data: copy, size: copy.byteLength, mtime: stat ? stat.mtime : null },
                    [copy.buffer]
                );
            }

            const text = await api.readFile(fp);
            if (typeof text !== 'string' || text.startsWith('ERROR:')) {
                // Retry as binary if readFile refused a binary file
                if (typeof api.readFileBytes === 'function') {
                    const bytes = await api.readFileBytes(fp);
                    if (bytes instanceof Uint8Array) {
                        if (bytes.byteLength > BASH_MAX_BIN_FILE) {
                            return reply(false, `File '${fp}' exceeds ${BASH_MAX_BIN_FILE >> 20} MB binary read limit.`);
                        }
                        const copy = new Uint8Array(bytes);
                        return reply(
                            true,
                            { isBinary: true, data: copy, size: copy.byteLength, mtime: stat ? stat.mtime : null },
                            [copy.buffer]
                        );
                    }
                }
                return reply(false, typeof text === 'string' ? text : `Failed to read '${fp}'`);
            }
            if (text.length > BASH_MAX_TEXT_FILE) {
                return reply(false, `File '${fp}' exceeds ${BASH_MAX_TEXT_FILE >> 20} MB text read limit.`);
            }
            return reply(true, {
                isBinary: false,
                data: text,
                size: stat && typeof stat.size === 'number' ? stat.size : new TextEncoder().encode(text).byteLength,
                mtime: stat ? stat.mtime : null
            });
        }

        return reply(false, `Unknown host_rpc method: ${method}`);
    } catch (err) {
        return reply(false, err && err.message ? err.message : String(err));
    }
}

async function ensureHostParentDir(api, filePath) {
    const slash = filePath.lastIndexOf('/');
    if (slash <= 0) return;
    const parts = filePath.slice(0, slash).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        for (const method of ['mkdir', 'createDirectory', 'createFolder', 'mkdirp', 'mkdirTree']) {
            if (typeof api?.[method] === 'function') {
                try { await api[method](cur); } catch (_) { /* ignore */ }
                break;
            }
        }
    }
}

async function syncDirtyWorkspaceToHost(st, api, { filterPaths = null, syncDeletions = true, pendingOnly = false, revertOnError = false } = {}) {
    const exportedRes = await bashCall(
        st,
        { type: 'fsOp', cfg: st.cfg, op: 'exportDirty', paths: filterPaths, pendingOnly },
        [],
        null,
        30000,
        'Exporting dirty virtual files timed out.',
        api
    );
    const { writes = [], deletes = [] } = exportedRes.data || {};
    const dec = new TextDecoder('utf-8', { fatal: true });

    const syncedWrites = [];
    const syncedDeletes = [];
    const attemptedPaths = [];
    const failedPaths = [];
    const errors = [];

    for (const w of writes) {
        attemptedPaths.push(w.relPath);
        try {
            await ensureHostParentDir(api, w.relPath);
            const bytes = w.bytes instanceof Uint8Array ? w.bytes : new Uint8Array(w.bytes || []);
            let payload = bytes;
            let isBinary = true;
            if (!BASH_BINARY_EXT.test(w.relPath) && !bytes.includes(0)) {
                try {
                    payload = dec.decode(bytes);
                    isBinary = false;
                } catch (_) {
                    payload = bytes;
                }
            }
            const res = await api.writeFile(w.relPath, payload);
            if (typeof res === 'string' && res.startsWith('ERROR:')) {
                failedPaths.push(w.relPath);
                errors.push(`write ${w.relPath}: ${res.replace(/^ERROR:\s*/, '')}`);
            } else {
                let stat = null;
                if (typeof api.statFile === 'function') {
                    try { stat = await api.statFile(w.relPath); } catch (_) { stat = null; }
                }
                syncedWrites.push({ relPath: w.relPath, stat, size: bytes.byteLength, isBinary });
            }
        } catch (err) {
            failedPaths.push(w.relPath);
            errors.push(`write ${w.relPath}: ${err && err.message ? err.message : err}`);
        }
    }

    for (const d of deletes) {
        attemptedPaths.push(d.relPath);
    }

    if (syncDeletions && typeof api?.deleteFile === 'function') {
        for (const d of deletes) {
            try {
                const res = await api.deleteFile(d.relPath);
                if (typeof res === 'string' && res.startsWith('ERROR:')) {
                    failedPaths.push(d.relPath);
                    errors.push(`delete ${d.relPath}: ${res.replace(/^ERROR:\s*/, '')}`);
                } else {
                    syncedDeletes.push(d.relPath);
                }
            } catch (err) {
                failedPaths.push(d.relPath);
                errors.push(`delete ${d.relPath}: ${err && err.message ? err.message : err}`);
            }
        }
    }

    let wsStatus = null;
    if (syncedWrites.length || syncedDeletes.length || attemptedPaths.length) {
        const markRes = await bashCall(
            st,
            { type: 'fsOp', cfg: st.cfg, op: 'markSynced', syncedWrites, syncedDeletes, attemptedPaths },
            [],
            null,
            15000,
            'Updating synced state timed out.',
            api
        );
        wsStatus = markRes.data ? markRes.data.workspace : null;
    }

    let reverted = [];
    if (revertOnError && failedPaths.length > 0) {
        try {
            const discardRes = await bashCall(
                st,
                { type: 'fsOp', cfg: st.cfg, op: 'discard', paths: failedPaths },
                [],
                null,
                15000,
                'Reverting rejected virtual files timed out.',
                api
            );
            const d = discardRes.data || {};
            reverted = [...(d.reverted || []), ...(d.removedNew || [])].sort();
            if (d.workspace) wsStatus = d.workspace;
        } catch (err) {
            errors.push(`auto-revert failed: ${err && err.message ? err.message : err}`);
        }
    }

    return {
        written: syncedWrites.map(s => s.relPath),
        deleted: syncedDeletes,
        skippedDeletes: !syncDeletions ? deletes.map(d => d.relPath) : [],
        reverted,
        errors,
        wsStatus
    };
}

// --- Worker lifecycle & shared bridge (reused by bash_fs) --------------------
function bashRuntimeSig(cfg) {
    const raw = JSON.stringify({
        v: cfg.version,
        p: cfg.cdnProvider,
        u: cfg.customModuleUrl,
        mw: cfg.mountWorkspace,
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
    st.activeApi = null;
    try { st.worker.terminate(); } catch (_) { /* ignore */ }
    try { URL.revokeObjectURL(st.url); } catch (_) { /* ignore */ }
    for (const l of [...st.listeners]) l({ type: 'fatal', message: 'just-bash worker was terminated.' });
}

function bashGet(cfg) {
    let st = self.__ionBash;
    const sig = bashRuntimeSig(cfg);
    if (st && st.alive && st.sig === sig) {
        st.cfg = cfg;
        return st;
    }
    if (st) bashKill();
    if (typeof Worker === 'undefined') {
        throw new Error('Nested Web Workers are unavailable in this browser.');
    }
    const url = URL.createObjectURL(new Blob([`(${__bashWorkerMain.toString()})()`], { type: 'application/javascript' }));
    const worker = new Worker(url);
    st = { worker, url, sig, cfg, alive: true, seq: 0, listeners: new Set(), ready: null, info: null, activeApi: null };
    worker.onmessage = (e) => {
        if (e.data && e.data.type === 'host_rpc') {
            handleHostRpc(st, e.data);
            return;
        }
        for (const l of [...st.listeners]) l(e.data);
    };
    worker.onerror = (e) => {
        const msg = (e && e.message) ? e.message : 'just-bash worker crashed unexpectedly.';
        st.alive = false;
        for (const l of [...st.listeners]) l({ type: 'fatal', message: msg });
    };
    self.__ionBash = st;
    return st;
}

function bashCall(st, msg, transfer, onEvent, timeoutMs, timeoutMessage, activeApi) {
    const id = ++st.seq;
    const prevApi = st.activeApi;
    if (activeApi) st.activeApi = activeApi;
    return new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn, val) => {
            if (timer) clearTimeout(timer);
            st.listeners.delete(listener);
            if (activeApi) st.activeApi = prevApi;
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

async function ensureBashReady(cfg, manifest, onEvent, activeApi) {
    const st = bashGet(cfg);
    if (!st.ready) {
        st.ready = bashCall(
            st,
            { type: 'init', cfg, manifest },
            [],
            onEvent,
            BASH_INIT_TIMEOUT_MS,
            'Timed out while loading just-bash from CDN. Check your network connection or try another CDN provider in Settings.',
            activeApi
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

// Shared bridge on Tool Worker global so bash_fs shares the exact same MountableFs + lazy workspace.
self.__ionBashMeta = self.__ionBashMeta || { lastCfg: null, lastError: null };
self.__ionBashBridge = {
    isReady: () => !!(self.__ionBash && self.__ionBash.alive && self.__ionBash.info),
    getInfo: () => (self.__ionBash && self.__ionBash.info) ? { ...self.__ionBash.info } : null,
    getConfig: () => (self.__ionBash && self.__ionBash.cfg) ? { ...self.__ionBash.cfg } : (self.__ionBashMeta.lastCfg ? { ...self.__ionBashMeta.lastCfg } : null),
    getLastError: () => self.__ionBashMeta.lastError || null,
    listWorkspaceManifest,
    fsOp: (payload, api, transfer, onEvent) => bashExclusive(async () => {
        let st = self.__ionBash;
        if ((!st || !st.alive || !st.ready) && self.__ionBashMeta.lastCfg) {
            const manifest = self.__ionBashMeta.lastCfg.mountWorkspace !== false ? await listWorkspaceManifest(api) : [];
            st = await ensureBashReady(self.__ionBashMeta.lastCfg, manifest, onEvent, api);
            self.__ionBashMeta.lastError = null;
        }
        if (!st || !st.alive || !st.ready) {
            throw new Error('just-bash sandbox is not running yet. Run a command with bash_run first to start it.');
        }
        await st.ready;
        const extra = {};
        if ((payload.op === 'refresh' || payload.op === 'reset') && st.cfg && st.cfg.mountWorkspace !== false) {
            extra.manifest = await listWorkspaceManifest(api);
        }
        const res = await bashCall(
            st,
            { type: 'fsOp', cfg: st.cfg, ...payload, ...extra },
            transfer || [],
            onEvent,
            30000,
            'Virtual filesystem operation timed out.',
            api
        );
        return res.data;
    }),
    syncToHost: (api, opts) => bashExclusive(async () => {
        const st = self.__ionBash;
        if (!st || !st.alive || !st.ready) {
            throw new Error('just-bash sandbox is not running yet. Run bash_run first.');
        }
        await st.ready;
        const syncDeletions = opts && typeof opts.syncDeletions === 'boolean'
            ? opts.syncDeletions
            : (st.cfg ? st.cfg.syncDeletions !== false : true);
        return await syncDirtyWorkspaceToHost(st, api, {
            filterPaths: opts && opts.paths ? opts.paths : null,
            syncDeletions
        });
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

function buildBashCard({ label, badge, secs, cwd, stdout = '', stderr = '', command = '', status = '', note = '', live = false }) {
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
        if (note) {
            body += `<div style="font-size:10.5px; color:var(--dim,#85858f); padding:2px 2px 0;">${esc(note)}</div>`;
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

    const metaBits = ['just-bash', `${secs}s`];
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
    const forceSync = !!args.sync;
    const files = (args.files && typeof args.files === 'object' && !Array.isArray(args.files)) ? args.files : null;

    if (!command.trim() && !reset && !forceSync && (!files || Object.keys(files).length === 0)) {
        return { output: "ERROR: 'command' must be non-empty unless 'reset', 'sync', or 'files' is provided." };
    }

    const version = String((await api?.getSetting?.('version')) || '3.6.0').trim();
    const cdnProvider = String((await api?.getSetting?.('cdnProvider')) || 'auto').trim();
    const customModuleUrl = String((await api?.getSetting?.('customModuleUrl')) || '').trim();
    const mountWorkspace = (await api?.getSetting?.('mountWorkspace')) !== false;
    const syncMode = String((await api?.getSetting?.('syncMode')) || 'auto').trim();
    const syncDeletions = (await api?.getSetting?.('syncDeletions')) !== false;
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
        mountWorkspace,
        syncMode,
        syncDeletions,
        limitProfile,
        timeoutSec,
        allowNetwork,
        allowedUrlPrefixes
    };
    self.__ionBashMeta.lastCfg = cfg;

    const firstLine = command.trim().split('\n')[0] || (reset ? 'reset sandbox' : forceSync ? 'sync workspace' : 'write virtual files');
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
    let syncReport = null;
    try {
        const manifest = mountWorkspace ? await listWorkspaceManifest(api) : [];

        result = await bashExclusive(async () => {
            const onEvent = (d) => {
                if (d.type === 'status') {
                    setStatus(d.text);
                    live.push();
                }
            };
            const st = await ensureBashReady(cfg, manifest, onEvent, api);
            self.__ionBashMeta.lastError = null;

            const hardTimeoutMs = (timeoutSec + 5) * 1000;
            let execData;
            try {
                const resp = await bashCall(
                    st,
                    {
                        type: 'exec',
                        cfg,
                        manifest,
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
                    `Command exceeded hard timeout (${timeoutSec}s); virtual shell worker terminated.`,
                    api
                );
                execData = resp.data;
            } catch (err) {
                if (err && err.timedOut) bashKill();
                throw err;
            }

            const shouldSync = mountWorkspace && (forceSync || syncMode === 'auto');
            const pendingCount = execData.wsStatus
                ? (forceSync ? execData.wsStatus.dirtyTotal : execData.wsStatus.pendingSyncTotal)
                : 0;
            if (shouldSync && pendingCount > 0) {
                setStatus('Syncing /workspace changes to Ion...');
                live.push();
                syncReport = await syncDirtyWorkspaceToHost(st, api, {
                    syncDeletions,
                    pendingOnly: !forceSync,
                    revertOnError: syncMode === 'auto'
                });
                if (syncReport.wsStatus) execData.wsStatus = syncReport.wsStatus;
            }

            return execData;
        });
    } catch (err) {
        live.stop();
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        const errMsg = err && err.message ? err.message : String(err);
        self.__ionBashMeta.lastError = errMsg;
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
            summary: isTimeout ? `bash_run timed out (${secs}s)` : 'bash_run failed'
        };
    }

    live.stop();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
    const cwd = result.cwd || '/workspace';
    const ws = result.wsStatus || null;

    const badge = result.timedOut
        ? ['TIMED OUT', '#e5c07b', 'rgba(229,192,123,0.18)']
        : exitCode === 0
            ? ['EXIT 0', '#98c379', 'rgba(152,195,121,0.18)']
            : [`EXIT ${exitCode}`, '#e06c75', 'rgba(224,108,117,0.18)'];

    const footer = [];
    if (result.wasReset) footer.push('sandbox reset');
    if (result.seeded > 0) footer.push(`seeded ${result.seeded} file(s)`);
    footer.push(`exit: ${exitCode}`);
    footer.push(`cwd: ${cwd}`);
    if (result.timedOut) footer.push('timed out');

    const cardNotes = [];
    if (ws && ws.enabled) {
        if (ws.execLazyReads > 0) {
            footer.push(`lazy-read: ${ws.execLazyReads}`);
            cardNotes.push(`lazy-loaded ${ws.execLazyReads} file(s) from workspace`);
        }
        if (syncReport) {
            if (syncReport.written.length) {
                footer.push(`synced writes: ${syncReport.written.join(', ')}`);
                cardNotes.push(`synced ${syncReport.written.length} write(s) to workspace`);
            }
            if (syncReport.deleted.length) {
                footer.push(`synced deletes: ${syncReport.deleted.join(', ')}`);
                cardNotes.push(`deleted ${syncReport.deleted.length} file(s) in workspace`);
            }
            if (syncReport.errors.length) {
                footer.push(`sync errors: ${syncReport.errors.join('; ')}`);
                cardNotes.push(`sync errors: ${syncReport.errors.length}`);
            }
            if (syncReport.reverted && syncReport.reverted.length) {
                footer.push(`reverted in /workspace: ${syncReport.reverted.join(', ')}`);
                cardNotes.push(`reverted ${syncReport.reverted.length} rejected path(s) in /workspace`);
            }
        }
        if (ws.dirtyTotal > 0) {
            const parts = [];
            if (ws.created.length) parts.push(`${ws.created.length} created`);
            if (ws.modified.length) parts.push(`${ws.modified.length} modified`);
            if (ws.deleted.length) parts.push(`${ws.deleted.length} deleted`);
            if (syncMode === 'auto') {
                footer.push(`unsynced: ${parts.join(', ')}`);
                cardNotes.push(`unsynced in /workspace: ${parts.join(', ')}`);
            } else {
                footer.push(`staged dirty: ${parts.join(', ')}`);
                cardNotes.push(`staged in /workspace: ${parts.join(', ')} (use bash_fs sync to apply)`);
            }
        }
    }

    try {
        await api.showUI(buildBashCard({
            label: `$ ${shortLabel}`,
            badge,
            secs,
            cwd,
            stdout,
            stderr,
            command,
            note: cardNotes.join(' · ')
        }));
    } catch (_) { /* best-effort UI */ }

    const parts = [];
    if (stdout.trimEnd()) parts.push(clip(stdout.trimEnd()));
    if (stderr.trimEnd()) parts.push(`[stderr]\n${clip(stderr.trimEnd())}`);
    if (!parts.length) parts.push('(no output)');

    const output = `${parts.join('\n\n')}\n\n[${footer.join(' | ')}]`;
    return {
        output: typeof api?.cleanupText === 'function' ? api.cleanupText(output) : output,
        summary: `$ ${shortLabel} (${badge[0]})`
    };
}
