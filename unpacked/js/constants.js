const ACCENT_PRESETS = [
    { name: 'Coral',  hex: '#ff7a50' },
    { name: 'Rose',   hex: '#f43f5e' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Blue',   hex: '#3b82f6' },
    { name: 'Teal',   hex: '#14b8a6' },
    { name: 'Green',  hex: '#22c55e' },
    { name: 'Amber',  hex: '#f59e0b' },
];

const CONFIG_DEFAULTS = {
    'read-lines': '250',
    'thinking-timeout': '-1',
    'tool-timeout': '120',
    'keep-skipped-thinking': 'false',
    'glow-enabled': 'true',
    'accent-color': '#ff7a50',
    'ui-theme': 'dark',
    'compress-enabled': 'true',
    'compress-threshold': '75',
    'compress-preserve': '6',
    'hide-agent-files': 'true',
    'sidebar-width': '314',
    'webdav-sync-agent': 'false'
};

const CONFIG_FILE = '.agent/config.json';

const AppConfig = {
    _data: {},
    load() {
        try {
            const stored = JSON.parse(localStorage.getItem('app_config_json') || 'null');
            this._data = (stored && typeof stored === 'object' && !Array.isArray(stored))
                ? { ...CONFIG_DEFAULTS, ...stored }
                : { ...CONFIG_DEFAULTS };
        } catch(e) {
            this._data = { ...CONFIG_DEFAULTS };
        }
        localStorage.setItem('app_config_json', JSON.stringify(this._data));
    },
    save() {
        localStorage.setItem('app_config_json', JSON.stringify(this._data));
        window.writeAgentFileToDisk(CONFIG_FILE, window.configFileText());
    },
    get(key, fallback) {
        const val = this._data[key];
        return val === undefined ? (fallback !== undefined ? fallback : CONFIG_DEFAULTS[key]) : val;
    },
    set(key, value) {
        this._data[key] = value;
        this.save();
        window.registerConfigVirtualFile();
    },
    all() {
        return { ...this._data };
    },
    replaceAll(obj) {
        this._data = { ...CONFIG_DEFAULTS, ...((obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {}) };
        this.save();
    },
    reset() {
        this._data = { ...CONFIG_DEFAULTS };
        this.save();
    }
};

const ATTACHMENTS_DIR = '.agent/attachments';
const BINARY_EXT_AMBIGUOUS = /\.(bin|dat|res|lps|obj|db|img|pb)$/i;
const BINARY_EXT_DEFINITE = /\.(png|jpg|jpeg|gif|ico|bmp|webp|tif|tiff|heic|avif|psd|pdf|zip|tar|gz|xz|bz2|zst|lzma|7z|rar|exe|dll|so|dylib|mp4|mkv|webm|mp3|m4a|aac|wav|flac|ogg|avi|mov|pyc|pyo|ttf|otf|woff|woff2|eot|sqlite|sqlite3|gguf|ggml|ppu|o|a|lib|class|jar|wasm|node|swf|iso|apk|dmg|pkl|npy|npz|parquet|onnx|safetensors|docx|xlsx|pptx|odt|ods|odp|mdb|accdb|dds|tga|pdb)$/i;
const BINARY_MAGIC = [
    [0x89, 0x50, 0x4E, 0x47],                        // PNG
    [0xFF, 0xD8, 0xFF],                              // JPEG
    [0x47, 0x49, 0x46, 0x38],                        // GIF8
    [0x25, 0x50, 0x44, 0x46, 0x2D],                  // %PDF-
    [0x50, 0x4B, 0x03, 0x04], [0x50, 0x4B, 0x05, 0x06], // ZIP (docx, xlsx, jar, apk ...)
    [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C],            // 7z
    [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07],            // RAR
    [0x1F, 0x8B],                                    // gzip
    [0x7F, 0x45, 0x4C, 0x46],                        // ELF
    [0xCF, 0xFA, 0xED, 0xFE], [0xCE, 0xFA, 0xED, 0xFE], [0xCA, 0xFE, 0xBA, 0xBE], // Mach-O / Java class
    [0x00, 0x61, 0x73, 0x6D],                        // WASM
    [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6F, 0x72, 0x6D, 0x61, 0x74, 0x20, 0x33, 0x00], // SQLite
    [0x4F, 0x67, 0x67, 0x53],                        // OggS
    [0x66, 0x4C, 0x61, 0x43],                        // fLaC
    [0x52, 0x49, 0x46, 0x46]                         // RIFF (wav, avi, webp)
];
const BUILTIN_TOOL_NAMES = ['read', 'edit', 'write', 'grep', 'find', 'rename', 'preview_image'];
const CLEARDATA_LS_KEYS = {
    models: ['models_json', 'selected_model'],
    customTools: ['tool_files_json', 'tool_lock_state', 'tool_deleted_names', 'tool_perm_state', 'tool_settings_state'],
    settings: [
        'app_config_json', 'mode_prompts_json', 'prompt-history', 'last_mode',
        'recent_folders_json'
    ]
};
const COMPRESS_PROMPT = `You are a context compression assistant for a coding agent.
Your job is to produce a concise but complete summary of the conversation so far,
so that the agent can continue working without losing critical information.

Preserve in your summary:
- The user's overall goal and any explicit requirements/constraints.

- Key decisions made and why.

- Files created, modified, or read (with paths).

- Important code snippets, function signatures, or API shapes that were established.

- Any errors encountered and how they were resolved.

- Pending TODOs or next steps.

- Tool calls that produced important results.


Format your output as plain text (markdown allowed) with clear sections.
Be thorough on facts, terse on prose. Do NOT omit file paths or identifiers.

Conversation to compress:
---
{{conversation}}
---

Write the summary now.`;
const CUSTOM_TOOLS_DIR = '.agent';
const DB_NAME = 'CodeAgentStore_v34';
const DEFAULT_ACCENT = '#ff7a50';
const DEFAULT_CONTEXT_WINDOW = 32768;
const FILE_ICON_MAP = {
    pas: { icon: 'code', color: 'var(--magenta)' },
    pp: { icon: 'code', color: 'var(--magenta)' },
    lpr: { icon: 'code', color: 'var(--magenta)' },
    lpi: { icon: 'settings_applications', color: 'var(--blue)' },
    lps: { icon: 'view_timeline', color: 'var(--orange)' },
    md: { icon: 'description', color: 'var(--blue)' },
    js: { icon: 'javascript', color: 'var(--yellow)' },
    ts: { icon: 'data_object', color: 'var(--blue)' },
    py: { icon: 'code', color: 'var(--green)' },
    html: { icon: 'html', color: 'var(--orange)' },
    css: { icon: 'css', color: 'var(--primary)' },
    json: { icon: 'data_object', color: 'var(--yellow)' },
    rs: { icon: 'memory', color: 'var(--orange)' },
    go: { icon: 'code', color: 'var(--primary)' },
    c: { icon: 'code', color: 'var(--blue)' },
    cpp: { icon: 'code', color: 'var(--blue)' },
    h: { icon: 'code', color: 'var(--magenta)' },
    ico: { icon: 'star', color: 'var(--yellow)' },
    png: { icon: 'image', color: 'var(--green)' },
    jpg: { icon: 'image', color: 'var(--green)' },
    jpeg: { icon: 'image', color: 'var(--green)' },
    svg: { icon: 'image', color: 'var(--primary)' },
    gguf: { icon: 'deployed_code', color: 'var(--primary)' },
    bin: { icon: 'deployed_code', color: 'var(--dim)' },
    exe: { icon: 'chat', color: 'var(--fg)' },
    res: { icon: 'folder_zip', color: 'var(--red)' },
    gitignore: { icon: 'source_environment', color: 'var(--primary)' }
};
const GITHUB_TOOLS_BRANCH = 'main';
const GITHUB_TOOLS_PATH = '';
const GITHUB_TOOLS_REPO = 'theaerotoad/Ion-tools';
const GLOW_STATUS_COLORS = {
    generating: 'var(--primary-rgb)',
    asking: '224, 108, 117',
    retrying: '140, 140, 140'
};
let HAS_FS_API = typeof window.showDirectoryPicker === 'function' && window.isSecureContext !== false;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'venv', '__pycache__', 'target', 'build', 'dist']);
const IMAGE_FILE_EXT_RE = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i;
const IMG_ZOOM_MAX = 8;
const IMG_ZOOM_MIN = 0.2;
const IMG_ZOOM_STEP_PCT = 20;
const IMPLICIT_DIR_PATTERNS = new Set(['.git', '__pycache__']);
const INTERACTIVE_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const LANG_MAP = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', json: 'json', md: 'markdown',
    xml: 'xml', svg: 'xml', sql: 'sql', yaml: 'yaml', yml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'bat',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
    java: 'java', go: 'go', rs: 'rust', php: 'php', rb: 'ruby',
    swift: 'swift', kt: 'kotlin', lua: 'lua', r: 'r', ini: 'ini',
    toml: 'ini', graphql: 'graphql', pas: 'pascal', pp: 'pascal', lpr: 'pascal', lpi: 'xml', lps: 'xml'
};
const MAX_RECENT_FOLDERS = 5;
const MODE_CONFIG = {
    plan: {
        name: 'PLAN', badgeClass: 'mode-plan', color: 'var(--yellow)', symbolClass: 'yellow',
        icon: 'assignment', placeholder: 'Describe feature to plan in .agent_plan.md...',
        desc: 'Creates step-by-step implementation plan with zero code edits until approved.'
    },
    ask: {
        name: 'ASK', badgeClass: 'mode-ask', color: 'var(--primary)', symbolClass: 'cyan',
        icon: 'chat', placeholder: 'Ask questions about codebase or architecture...',
        desc: 'Safe read-only mode to explore, explain, and query codebase.'
    },
    code: {
        name: 'CODE', badgeClass: 'mode-code', color: 'var(--magenta)', symbolClass: 'magenta',
        icon: 'code', placeholder: 'Ask agent or type / for commands, @ for files...',
        desc: 'Full autonomous implementation with surgical edits.'
    }
};
let MODE_LABELS = { plan: 'Plan', ask: 'Ask', code: 'Code' };
let MODEL_PROVIDERS = [];
const MODELS_FILE = '.agent/models.json';
const MODEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODE_PROMPT_FILES = {
    plan: '.agent/prompts/plan.md',
    ask: '.agent/prompts/ask.md',
    code: '.agent/prompts/code.md',
    title: '.agent/prompts/llm_gen.md'
};
let MODE_PROMPTS = {};
let MONACO = null;

const newToolDefaultSource = `const TOOL_META = {
    name: "my_tool",
    description: "Tool description.",
    parameters: {
        type: "object",
        properties: {
            message: {
                type: "string",
                description: "Message to process and display."
            }
        },
        required: ["message"]
    },
    modes: ["plan", "ask", "code"],
    expanded: true,
    settings: [
        {
            key: "accentColor",
            label: "Accent Color",
            type: "string",
            default: "#4f8cff",
            description: "Badge color for the UI card."
        }
    ]
};

// The handler's return value can be either a plain string, or an object with:
//   - output:      string sent back to the model as the tool result.
//   - summary:      optional final header label for the tool box. If omitted,
//                   the last value passed to api.setHeaderMsg is used, falling
//                   back to the host's arg-based default.
//
// While running, the header can be updated at any time with:
//   await api.setHeaderMsg("Fetching from proxy 2/5…");
//
// UI shown inside the tool box (never sent to the model) is rendered with:
//   await api.showUI(html);                  // final card; the last call wins
//   await api.showUI(html, { live: true });  // transient frame while running
// (Returning { displayHtml } still works but is deprecated.)
async function handler(args, api) {
    const { message } = args;
    const color = await api.getSetting?.("accentColor") || "#4f8cff";

    const output = \`Received message: \${message}\`;

    await api.showUI(\`<div style="padding: 12px; border-radius: 6px; border: 1px solid #333; background: #1e1e1e; font-family: sans-serif;">
        <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; background: \${color}; color: #fff; font-size: 11px; font-weight: 600; line-height: 1;">HELLO WORLD</span>
        <div style="margin-top: 8px; color: #ddd; font-size: 13px;">\${message}</div>
    </div>\`);

    return { output };
}
`;

const PASTE_LINE_THRESHOLD = 100;
const PERMISSION_LABELS = { never: 'never', ask: 'ask', always: 'always' };
const PLAN_FILE = '.agent_plan.md';
const PROMPT_FILE_HEADERS = {
    plan: `# PLAN MODE system prompt. Sent as the system message when the mode tab is PLAN.\n# Variables: {{planFile}} plan file path, {{mode}} mode id.`,
    ask: `# ASK MODE system prompt (read-only Q&A). Sent as the system message when the mode tab is ASK.\n# Variables: {{planFile}} plan file path, {{mode}} mode id.`,
    code: `# CODE MODE system prompt (full autonomous implementation). Sent when the mode tab is CODE.\n# Variables: {{planFile}} plan file path, {{mode}} mode id.`,
    title: `# SESSION TITLE GENERATION prompt. Used to name a session from its first prompt.\n# The system message is this body; the task prompt follows as a user message.\n# Variables: {{userPrompt}} the prompt the title is generated from.\n# Lines starting with '#' are comments and are stripped. Blank lines are kept.`
};
const PROMPT_FILE_MODES = Object.entries(MODE_PROMPT_FILES).reduce((acc, [mode, fp]) => {
    acc[fp] = mode; return acc;
}, {});
const PROMPT_MODE_ORDER = ['plan', 'ask', 'code', 'title'];
const PROMPTS_DIR = '.agent/prompts';
const PROTECTED_PATTERNS = [
    '.git', '.env', '.env.*', '*.key', '*.pem', '*.p12', '*.pfx', '*.jks', '*.keystore',
    'id_rsa', 'id_rsa.*', 'id_dsa', 'id_dsa.*', 'id_ecdsa', 'id_ecdsa.*', 'id_ed25519', 'id_ed25519.*',
    '.ssh/', '.aws/', '.gnupg/', '*credentials*', '*secret*', '*.sqlite', '*.sqlite3', '*.db',
    '__pycache__/', '*.pyc', 'data/', '.vscode/', '*.crswap'
];
const SEARCH_MAX_FILE_RESULTS = 20;
const SEARCH_MAX_FILE_SIZE = 1024 * 1024;
const SEARCH_MAX_TOTAL_RESULTS = 300;
const SENSITIVE_USER_FILES = [MODELS_FILE, CONFIG_FILE];
const SIDEBAR_BASE_W = 314;
const SIDEBAR_MAX_EXTRA = 420;
const SIDEBAR_MAX_W = SIDEBAR_BASE_W * 1.5;
const SIDEBAR_MIN_W = 264;
let SLASH_COMMANDS = [
    { cmd: '/plan', desc: 'Switch to Plan mode (generates .agent_plan.md)' },
    { cmd: '/ask', desc: 'Switch to Ask mode (read-only Q&A)' },
    { cmd: '/code', desc: 'Switch to Code mode (full execution)' },
    { cmd: '/execute-plan', desc: 'Execute current .agent_plan.md in Code mode' },
    { cmd: '/continue', desc: 'Resume current paused execution' },
    { cmd: '/compact', desc: 'Compress conversation history to free up context' },
    { cmd: '/new', desc: 'Create a new blank session' },
    { cmd: '/session', desc: 'Open session list popover' },
    { cmd: '/clear', desc: 'Reset session: clear messages, chat, and modified files' },
    { cmd: '/restore', desc: 'Discard all modified files to original' },
    { cmd: '/help', desc: 'Show commands and keyboard shortcuts' }
];
const SNIFF_BYTES = 8192;
const STORE_BASELINES = 'baselines';
const STORE_CACHE = 'cache';
const STORE_HANDLES = 'handles';
const STORE_SESSIONS = 'sessions';
const TOAST_ICONS = { success: 'check_circle', info: 'info', error: 'error' };

const TOOL_API_METHODS = {
    listModels: async () => window.getAllModelEntries().map(e => ({ id: e.uuid, provider: e.providerName, name: e.name })),
    callModel: async (toolName, [id, opts], sessionId, runEntry) => {
        const entry = window.findModelEntryById(id);
        if (!entry || !window.toolMayUseModel(toolName, entry)) {
            return { error: 'model not found or not assigned to this tool' };
        }
        opts = opts || {};
        const path = String(opts.path || '');
        if (!/^\/[A-Za-z0-9._~\-]+(\/[A-Za-z0-9._~\-]+)*$/.test(path) || path.split('/').includes('..')) {
            return { error: 'invalid path' };
        }
        const base = String(entry.url || '').trim().replace(/\/+$/, '');
        let baseUrl;
        try { baseUrl = new URL(base); } catch (e) { return { error: 'model endpoint is not configured' }; }
        if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') return { error: 'model endpoint is not configured' };
        let p = path;
        if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(p)) p = p.slice(3);   
        if (base.toLowerCase().endsWith(p.toLowerCase())) p = '';                
        let target;
        try { target = new URL(base + p); } catch (e) { return { error: 'invalid path' }; }
        if (target.origin !== baseUrl.origin) return { error: 'invalid path' };
        let bodyStr = typeof opts.body === 'string' ? opts.body : (opts.body != null ? JSON.stringify(opts.body) : undefined);
        if (bodyStr) {
            try {
                const o = JSON.parse(bodyStr);
                if (o && typeof o === 'object' && !Array.isArray(o)) { o.model = entry.name; bodyStr = JSON.stringify(o); }
            } catch (e) { /* not JSON: send as-is */ }
        }
        const headers = { 'Content-Type': 'application/json' };
        if (entry.key) headers['Authorization'] = `Bearer ${entry.key}`;
        const ms = Number(opts.timeoutMs);
        const timeoutMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 120000) : 15000;
        const ctrl = new AbortController();
        runEntry?.abortCtrl?.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(target.href, {
                method: 'POST',
                headers,
                body: bodyStr,
                signal: ctrl.signal,
                redirect: 'error',
                credentials: 'omit'
            });
            let text = (await res.text()).slice(0, 2000000);
            if (entry.key) text = text.split(entry.key).join('[redacted]');
            return { ok: res.ok, status: res.status, text };
        } catch (e) {
            return { error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
        } finally {
            clearTimeout(timer);
        }
    },
    httpPost: async (toolName, [url, opts], sessionId, runEntry) => {
        let u;
        try { u = new URL(String(url)); } catch (e) { return { error: 'invalid URL' }; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'only http(s) URLs are allowed' };
        opts = opts || {};
        const ms = Number(opts.timeoutMs);
        const timeoutMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 120000) : 15000;
        const headers = {};
        if (opts.headers && typeof opts.headers === 'object') {
            for (const [k, v] of Object.entries(opts.headers)) headers[String(k)] = String(v);
        }
        const ctrl = new AbortController();
        runEntry?.abortCtrl?.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(u.href, {
                method: 'POST',
                headers,
                body: typeof opts.body === 'string' ? opts.body : undefined,
                signal: ctrl.signal
            });
            const text = await res.text();
            return { ok: res.ok, status: res.status, text: text.slice(0, 2000000) };
        } catch (e) {
            return { error: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)) };
        } finally {
            clearTimeout(timer);
        }
    },
    readFile: async (toolName, [fp]) => {
        const res = await window.readFileContentForTool(fp);
        if (res.error) return res.error;
        return res.content;
    },
    writeFile: async (toolName, [fp, content], sessionId) => {
        if (window.isSecurityProtectedPath(fp)) {
            return `ERROR: ${fp} is a protected path and cannot be written by a tool call.`;
        }
        if (window.isSensitiveUserFile(fp)) {
            return `ERROR: ${fp} is a private user settings file and cannot be written by a tool call.`;
        }
        if (window.shouldHideFromTools(fp)) {
            return `ERROR: ${fp} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.`;
        }
        const res = await window.writeDisk(fp, content, { fromLLMTool: true, sessionId });
        return (res && res.output) ? res.output : null;
    },
    readImage: async (toolName, [fp, crop]) => {
        if (typeof fp !== 'string' || !fp) return { error: 'ERROR: filepath is required.' };
        if (window.isSecurityProtectedPath(fp)) {
            return { error: `ERROR: ${fp} is a protected path and cannot be read by a tool call.` };
        }
        if (window.isSensitiveUserFile(fp)) {
            return { error: `ERROR: ${fp} is a private user settings file and cannot be read by a tool call.` };
        }
        if (window.shouldHideFromTools(fp)) {
            return { error: `ERROR: ${fp} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.` };
        }
        if (window.isAgentPath(fp) && !window.isVirtualAgentFile(fp)) {
            return { error: `ERROR: ${fp} is inside .agent and cannot be read by a tool call.` };
        }
        const dataUrl = await window.readImageDataUrl(fp);
        if (!dataUrl) {
            return { error: `ERROR: ${fp} is not a readable image. It must be an image file (png/jpg/jpeg/gif/bmp/webp/svg/ico) that exists in the open workspace.` };
        }
        try {
            return await window.cropAndEncodeImage(dataUrl, crop || {});
        } catch (e) {
            return { error: `ERROR: Failed to preview ${fp}: ${e.message}` };
        }
    },
    readFileBytes: async (toolName, [fp]) => {
        const MAX_BYTES = 64 * 1024 * 1024; // 64 MB
        if (window.isSecurityProtectedPath(fp)) {
            return `ERROR: ${fp} is a protected path and cannot be read by a tool call.`;
        }
        if (window.isSensitiveUserFile(fp)) {
            return `ERROR: ${fp} is a private user settings file and cannot be read by a tool call.`;
        }
        if (window.shouldHideFromTools(fp)) {
            return `ERROR: ${fp} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.`;
        }
        if (window.isAgentPath(fp) && !window.isToolFilePath(fp) && !window.isVirtualAgentFile(fp)) {
            return `ERROR: ${fp} is inside .agent and cannot be read by a tool call.`;
        }
        try {
            if (window.isVirtualAgentFile(fp) || window.isToolFilePath(fp)) {
                const text = window.registry.files[fp] !== undefined
                    ? window.registry.files[fp]
                    : (await window.readFileContent(fp));
                return new TextEncoder().encode(text || '');
            }
            if (!window.registry.meta[fp]) return `ERROR: ${fp} not found`;
            if (!window.rootHandle) {
                const text = window.registry.files[fp];
                if (text === undefined) return `ERROR: ${fp} not found`;
                return new TextEncoder().encode(text);
            }
            const handle = await window.getHandleByPath(fp);
            if (!handle) return `ERROR: ${fp} not found`;
            const file = await handle.getFile();

            const buf = await file.arrayBuffer();
            return new Uint8Array(buf);
        } catch (e) {
            return `ERROR: ${e.message || String(e)}`;
        }
    },
    renameFile: async (toolName, [oldPath, newPath], sessionId) => {
        if (window.isSecurityProtectedPath(oldPath)) {
            return `ERROR: ${oldPath} is a protected path and cannot be renamed by a tool call.`;
        }
        if (window.isSecurityProtectedPath(newPath)) {
            return `ERROR: ${newPath} is a protected path and cannot be renamed by a tool call.`;
        }
        if (window.isSensitiveUserFile(oldPath)) {
            return `ERROR: ${oldPath} is a private user settings file and cannot be renamed by a tool call.`;
        }
        if (window.isToolOrAgentPath(oldPath)) {
            return `ERROR: ${oldPath} is a virtual settings file and can't be renamed or moved.`;
        }
        if (window.isAgentPath(newPath)) {
            return `ERROR: Cannot rename files into .agent`;
        }
        if (window.shouldHideFromTools(oldPath)) {
            return `ERROR: ${oldPath} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.`;
        }
        if (window.shouldHideFromTools(newPath)) {
            return `ERROR: ${newPath} has .agent extension and is hidden from tool access. You can enable access in Settings > Explorer > Show .agent files to tools.`;
        }
        const res = await window.fs.rename(oldPath, newPath, { mode: 'tool' });
        return (res && res.error) ? res.error : null;
    },
    listFiles: async () => Object.keys(window.registry.meta).filter(f =>
        window.registry.meta[f]?.kind === 'file' &&
        !window.isSecurityProtectedPath(f) &&
        !window.isSensitiveUserFile(f) &&
        !window.shouldHideFromTools(f) &&
        !(window.isAgentPath(f) && !window.isToolFilePath(f) && !window.isVirtualAgentFile(f))
    ).sort(),
    fileExists: async (toolName, [fp]) => !!window.registry.meta[fp] && !window.isSecurityProtectedPath(fp) && !window.isSensitiveUserFile(fp) && !window.shouldHideFromTools(fp),
    isBinary: async (toolName, [fp]) => window.resolveIsBinary(fp),
    isSensitiveFile: async (toolName, [fp]) => window.isSensitiveUserFile(fp),
    getSetting: async (toolName, [key]) => {
        const v = window.getToolSettingValue(toolName, key);
        const def = ((window.toolRegistry[toolName] && window.toolRegistry[toolName].settings) || []).find(s => s.key === key);
        if (def && def.type === 'model' && v) {
            const e = window.findModelEntryById(v);
            return e ? e.uuid : v;
        }
        return v;
    },
    validateDisplayHtml: async (toolName, [html, opts]) => {
        if (typeof html !== 'string' || !html.trim()) {
            return { ok: false, error: 'Empty displayHtml' };
        }
        const timeoutMs = (opts && opts.timeoutMs) || 4000;
        const okMarker = (opts && opts.okMarker) || '__displayHtmlStatusOk';
        const errMarker = (opts && opts.errMarker) || '__displayHtmlStatusErr';

        return await new Promise((resolve) => {
            let settled = false;
            let iframe = null;
            let hardTimer = null;
            let settleTimer = null;

            const cleanup = () => {
                if (hardTimer) clearTimeout(hardTimer);
                if (settleTimer) clearTimeout(settleTimer);
                window.removeEventListener('message', onMessage);
                try { if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch (e) {}
            };
            const finish = (result) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            };

            const onMessage = (ev) => {
                const d = ev && ev.data;
                if (!d || typeof d !== 'object') return;
                if (d[okMarker]) finish({ ok: true });
                else if (d[errMarker]) finish({ ok: false, error: d[errMarker] || 'render error' });
            };
            window.addEventListener('message', onMessage);

            iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.style.position = 'fixed';
            iframe.style.left = '-10000px';
            iframe.style.top = '-10000px';
            iframe.style.width = '1px';
            iframe.style.height = '1px';
            iframe.style.opacity = '0';
            iframe.style.pointerEvents = 'none';

            iframe.addEventListener('load', () => {
                settleTimer = setTimeout(() => finish({ ok: true }), timeoutMs);
            }, { once: true });

            hardTimer = setTimeout(
                () => finish({ ok: false, error: 'Validation timed out' }),
                timeoutMs + 3000
            );

            iframe.srcdoc = html;
            document.body.appendChild(iframe);
        });
    },
    showUI: async (toolName, [html, opts], sessionId, entry) => {
        const hasChoice = typeof html === 'string' && /<[^>]*\sdata-choice\s*=/i.test(html);
        const isInteractive = (opts && opts.autoResolve === false) || (hasChoice && (!opts || !opts.autoResolve));

        if (!isInteractive) {
            if (opts && opts.live) {
                window.liveRenderToolBody(entry, html);
                return { choice: null, autoResolved: true, live: true };
            }
            if (entry) entry.displayHtml = html;
            return { choice: null, autoResolved: true };
        }

        return await new Promise((resolve) => {
            const sid = sessionId || window.state.activeSessionId;
            window.reapDeadPendingUI();
            const req = { sessionId: sid, toolName, html, resolve, el: null, done: false, entry: entry || null };

            const finish = (choice, cancelled) => {
                if (req.done) return;
                req.done = true;
                window.pendingUIQueue = window.pendingUIQueue.filter(r => r !== req);
                if (req.el) {
                    req.el.remove();
                }
                window.updateGenGlow();
                resolve(cancelled ? { choice: null, cancelled: true } : { choice });
            };
            req.finish = finish;

            req.mount = () => {
                if (req.done) return;
                if (req.el && req.el.isConnected) return;
                const el = document.createElement('div');
                el.className = 'tool-ui-wait';
                el.innerHTML = req.html;
                el.addEventListener('click', (ev) => {
                    const btn = ev.target.closest('[data-choice]');
                    if (!btn || req.done || btn.disabled) return;
                    el.querySelectorAll('[data-choice]').forEach(b => {
                        if (b !== btn) b.style.opacity = '0.4';
                    });
                    btn.classList.add('selected');
                    btn.style.borderColor = 'var(--accent, #61afef)';
                    finish(btn.dataset.choice, false);
                });
                req.el = el;

                let runningBox = (entry && entry.box && entry.box.isConnected) ? entry.box : null;
                if (!runningBox) runningBox = document.querySelector('.running-tool-box');
                const boxBody = runningBox ? runningBox.querySelector('.tool-box-body') : null;

                if (boxBody) {
                    boxBody.querySelectorAll(':scope > .tool-ui-wait').forEach(n => { if (!window.pendingUIQueue.some(r => r.el === n)) n.remove(); });
                    boxBody.appendChild(el);
                } else {
                    const target = (runningBox && runningBox.parentNode) ? runningBox.parentNode : window.term;
                    target.appendChild(el);
                }
                const grp = el.closest('.tool-group');
                if (grp) grp.classList.remove('collapsed');
                window.smartScroll();
            };

            window.pendingUIQueue.push(req);
            if (sid === window.state.activeSessionId) req.mount();
            window.updateGenGlow();
        });
    },
    setHeaderMsg: async (toolName, [msg], sessionId, entry) => {
        const text = (msg == null) ? '' : String(msg);
        const liveEntry = entry || [...window.toolWorkerPending.values()]
            .find(e => e.toolName === toolName && e.sessionId === (sessionId || window.state.activeSessionId));
        if (liveEntry && liveEntry.headerMsg === (text || null)) return null;
        if (liveEntry) liveEntry.headerMsg = text || null;
        if (!text) return null;
        const box = liveEntry && liveEntry.box;
        if (box && box.isConnected) {
            const summaryEl = box.querySelector('.tool-summary');
            if (summaryEl && summaryEl.textContent !== text) summaryEl.textContent = text;
        }
        return null;
    }
};

const TOOL_IO_READ_ONLY = new Set(['read', 'grep', 'find', 'preview_image']);
const TOOL_IO_WRITE = new Set(['edit', 'write', 'rename']);
const TOOLS_DIR = '.agent/tools';
const TOOL_SETTING_TYPES = ['number', 'text', 'boolean', 'select', 'model'];
const TOOL_TIMEOUT_DEFAULT_MS = 120000;
const TRANSIENT_LIVE_SELECTOR = '[data-live-spinner], .retry-status, [data-pending-tool], .tool-ui-wait';
const VFS_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const VIRTUAL_AGENT_FILES = [MODELS_FILE, CONFIG_FILE];

window.ACCENT_PRESETS = ACCENT_PRESETS;
window.AppConfig = AppConfig;
window.ATTACHMENTS_DIR = ATTACHMENTS_DIR;
window.BINARY_EXT_AMBIGUOUS = BINARY_EXT_AMBIGUOUS;
window.BINARY_EXT_DEFINITE = BINARY_EXT_DEFINITE;
window.BINARY_MAGIC = BINARY_MAGIC;
window.BUILTIN_TOOL_NAMES = BUILTIN_TOOL_NAMES;
window.CLEARDATA_LS_KEYS = CLEARDATA_LS_KEYS;
window.COMPRESS_PROMPT = COMPRESS_PROMPT;
window.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
window.CONFIG_FILE = CONFIG_FILE;
window.CUSTOM_TOOLS_DIR = CUSTOM_TOOLS_DIR;
window.DB_NAME = DB_NAME;
window.DEFAULT_ACCENT = DEFAULT_ACCENT;
window.DEFAULT_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW;
window.FILE_ICON_MAP = FILE_ICON_MAP;
window.GITHUB_TOOLS_BRANCH = GITHUB_TOOLS_BRANCH;
window.GITHUB_TOOLS_PATH = GITHUB_TOOLS_PATH;
window.GITHUB_TOOLS_REPO = GITHUB_TOOLS_REPO;
window.GLOW_STATUS_COLORS = GLOW_STATUS_COLORS;
window.HAS_FS_API = HAS_FS_API;
window.IGNORED_DIRS = IGNORED_DIRS;
window.IMAGE_FILE_EXT_RE = IMAGE_FILE_EXT_RE;
window.IMG_ZOOM_MAX = IMG_ZOOM_MAX;
window.IMG_ZOOM_MIN = IMG_ZOOM_MIN;
window.IMG_ZOOM_STEP_PCT = IMG_ZOOM_STEP_PCT;
window.IMPLICIT_DIR_PATTERNS = IMPLICIT_DIR_PATTERNS;
window.INTERACTIVE_TOOL_TIMEOUT_MS = INTERACTIVE_TOOL_TIMEOUT_MS;
window.LANG_MAP = LANG_MAP;
window.MAX_RECENT_FOLDERS = MAX_RECENT_FOLDERS;
window.MODE_CONFIG = MODE_CONFIG;
window.MODE_LABELS = MODE_LABELS;
window.MODEL_PROVIDERS = MODEL_PROVIDERS;
window.MODELS_FILE = MODELS_FILE;
window.MODEL_UUID_RE = MODEL_UUID_RE;
window.MODE_PROMPT_FILES = MODE_PROMPT_FILES;
window.MODE_PROMPTS = MODE_PROMPTS;
window.MONACO = MONACO;
window.newToolDefaultSource = newToolDefaultSource;
window.PASTE_LINE_THRESHOLD = PASTE_LINE_THRESHOLD;
window.PERMISSION_LABELS = PERMISSION_LABELS;
window.PLAN_FILE = PLAN_FILE;
window.PROMPT_FILE_HEADERS = PROMPT_FILE_HEADERS;
window.PROMPT_FILE_MODES = PROMPT_FILE_MODES;
window.PROMPT_MODE_ORDER = PROMPT_MODE_ORDER;
window.PROMPTS_DIR = PROMPTS_DIR;
window.PROTECTED_PATTERNS = PROTECTED_PATTERNS;
window.SEARCH_MAX_FILE_RESULTS = SEARCH_MAX_FILE_RESULTS;
window.SEARCH_MAX_FILE_SIZE = SEARCH_MAX_FILE_SIZE;
window.SEARCH_MAX_TOTAL_RESULTS = SEARCH_MAX_TOTAL_RESULTS;
window.SENSITIVE_USER_FILES = SENSITIVE_USER_FILES;
window.SIDEBAR_BASE_W = SIDEBAR_BASE_W;
window.SIDEBAR_MAX_EXTRA = SIDEBAR_MAX_EXTRA;
window.SIDEBAR_MAX_W = SIDEBAR_MAX_W;
window.SIDEBAR_MIN_W = SIDEBAR_MIN_W;
window.SLASH_COMMANDS = SLASH_COMMANDS;
window.SNIFF_BYTES = SNIFF_BYTES;
window.STORE_BASELINES = STORE_BASELINES;
window.STORE_CACHE = STORE_CACHE;
window.STORE_HANDLES = STORE_HANDLES;
window.STORE_SESSIONS = STORE_SESSIONS;
window.TOAST_ICONS = TOAST_ICONS;
window.TOOL_API_METHODS = TOOL_API_METHODS;
window.TOOL_IO_READ_ONLY = TOOL_IO_READ_ONLY;
window.TOOL_IO_WRITE = TOOL_IO_WRITE;
window.TOOLS_DIR = TOOLS_DIR;
window.TOOL_SETTING_TYPES = TOOL_SETTING_TYPES;
window.TOOL_TIMEOUT_DEFAULT_MS = TOOL_TIMEOUT_DEFAULT_MS;
window.TRANSIENT_LIVE_SELECTOR = TRANSIENT_LIVE_SELECTOR;
window.VFS_MIME = VFS_MIME;
window.VIRTUAL_AGENT_FILES = VIRTUAL_AGENT_FILES;

export {
    ACCENT_PRESETS, CONFIG_DEFAULTS, CONFIG_FILE, AppConfig, ATTACHMENTS_DIR, BINARY_EXT_AMBIGUOUS, BINARY_EXT_DEFINITE, BINARY_MAGIC, BUILTIN_TOOL_NAMES, CLEARDATA_LS_KEYS, COMPRESS_PROMPT, CUSTOM_TOOLS_DIR, DB_NAME, DEFAULT_ACCENT, DEFAULT_CONTEXT_WINDOW, FILE_ICON_MAP, GITHUB_TOOLS_BRANCH, GITHUB_TOOLS_PATH, GITHUB_TOOLS_REPO, GLOW_STATUS_COLORS, HAS_FS_API, IGNORED_DIRS, IMAGE_FILE_EXT_RE, IMG_ZOOM_MAX, IMG_ZOOM_MIN, IMG_ZOOM_STEP_PCT, IMPLICIT_DIR_PATTERNS, INTERACTIVE_TOOL_TIMEOUT_MS, LANG_MAP, MAX_RECENT_FOLDERS, MODE_CONFIG, MODE_LABELS, MODEL_PROVIDERS, MODELS_FILE, MODEL_UUID_RE, MODE_PROMPT_FILES, MODE_PROMPTS, MONACO, newToolDefaultSource, PASTE_LINE_THRESHOLD, PERMISSION_LABELS, PLAN_FILE, PROMPT_FILE_HEADERS, PROMPT_FILE_MODES, PROMPT_MODE_ORDER, PROMPTS_DIR, PROTECTED_PATTERNS, SEARCH_MAX_FILE_RESULTS, SEARCH_MAX_FILE_SIZE, SEARCH_MAX_TOTAL_RESULTS, SENSITIVE_USER_FILES, SIDEBAR_BASE_W, SIDEBAR_MAX_EXTRA, SIDEBAR_MAX_W, SIDEBAR_MIN_W, SLASH_COMMANDS, SNIFF_BYTES, STORE_BASELINES, STORE_CACHE, STORE_HANDLES, STORE_SESSIONS, TOAST_ICONS, TOOL_API_METHODS, TOOL_IO_READ_ONLY, TOOL_IO_WRITE, TOOLS_DIR, TOOL_SETTING_TYPES, TOOL_TIMEOUT_DEFAULT_MS, TRANSIENT_LIVE_SELECTOR, VFS_MIME, VIRTUAL_AGENT_FILES
};
