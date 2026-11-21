# Durable and Multi-Device Storage for Workbench

**Status:** Design draft 0.2. Decisions are locked and the work is split into phases ready to implement.
**Scope:** `workbench/` only; `qmdpy/` is intentionally excluded.
**Audience:** Whoever implements this later, possibly an automated coding agent. Sections 3 ("Locked decisions") and 13 ("Pitfalls") are binding. Do not re-open those decisions while implementing. If something in the code contradicts this document, stop and report it instead of improvising.

---

## 1. Problem statement

When Workbench is served from `unpacked/`, almost all application state lives in browser storage, either IndexedDB `CodeAgentStore_v34` or `localStorage`. If the browser profile or site data is cleared (sometimes as a side effect of a browser upgrade), the user loses:

- conversation histories (IndexedDB `sessions`);
- session checkpoints and file-operation history (IndexedDB `baselines`);
- virtual workspaces (IndexedDB `handles`, keys `vws_<vid>`);
- the list of known workspaces (`localStorage.recent_folders_json`);
- settings, model definitions, prompt modes, tool configuration (many `localStorage` keys).

Browser-local storage also prevents opening the same Workbench server from a second machine and continuing a conversation.

**Desired outcome:** an *optional* Python-server copy of this state. It survives browser data loss and is shared between browsers that talk to the same server. Browser-only operation (no server persistence, no WebDAV) must keep working exactly as it does today.

## 2. Goals and non-goals

### Goals

1. **Durability.** Clearing site data and reloading restores workspaces, conversations, checkpoints and settings from the server.
2. **Optionality.** Without `--data-dir`, or when the frontend is served by something other than `server.py`, behavior is identical to today.
3. **Multi-device continuation.** Machine B sees machine A's workspace list, conversations and settings. Returning to machine A shows the updated conversation.
4. **No silent loss.** Concurrent edits never silently overwrite a conversation. The losing side is kept as a "conflict copy".
5. **Minimal intrusion.** The app keeps reading and writing IndexedDB/localStorage exactly as now. Sync is a layer around those writes, not a rewrite of the session code.
6. **Recoverability.** Server data is a single SQLite file that can be backed up with standard tools. A browser-side JSON export/import exists independently of the server.

### Non-goals (v1)

- Multiple users, accounts, sharing or permissions. One server equals one user.
- Application-level authentication (see §3, D9).
- Real-time co-editing, or two machines generating into the same conversation at the same time.
- Merging message arrays. Conflicts fork; they never merge (the session *index* is the one exception, see §8.4).
- Portable File System Access handles. A local folder must be re-picked on each machine.
- A read-only "files not connected" conversation viewer. This can come later.
- Push notifications (SSE/WebSocket). Refresh-on-focus is enough for v1.

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Server persistence is turned on by the server**, by starting `server.py --data-dir <dir>`. The client discovers it via `GET /api/v1/capabilities`. There is **no client-side opt-in toggle**. | A toggle saved in browser storage is lost in the very scenario we are fixing. |
| D2 | **Generic revisioned key/value store** in SQLite, not a typed REST schema. Each record is `(store, key) → value bytes + integer rev + deleted flag`. | The browser data is already key/value (IndexedDB keys like `${wsKey}::session::${id}`). The server never needs to understand the payloads, and schema changes in the app need no server migration. |
| D3 | **The browser is a write-through cache.** The app keeps using IndexedDB/localStorage as its only read source. A sync layer (`remote_store.js`) (a) marks records dirty after local writes and uploads them in the background, and (b) *hydrates* local storage from the server at defined points. | Keeps the existing ~70 storage call sites unchanged. Browser-only mode is "sync layer disabled". Offline tolerance comes for free. |
| D4 | **Server-assigned revisions + optimistic concurrency.** Every write sends the last-seen rev. A mismatch returns `412`. Client clocks are never trusted for ordering. | Simple and correct. |
| D5 | **On conflict:** session records fork into a "(conflict copy)". The session index is merged. Every other store resolves as "server wins". | Conversations are the only thing that is expensive to lose. |
| D6 | **Deletes are tombstones** on the server (`deleted=1`, rev incremented, value cleared). A tombstone beats a stale local copy during hydration. | Prevents deleted sessions from being resurrected by an old browser. |
| D7 | **Workspace data namespace is frozen per catalog entry** (`entry.storageKey`). It is computed once, using today's `wsStorageName()` result, so existing local data is found unchanged. Afterwards it is read from the entry, never recomputed. | `wsStorageName()` hashes the absolute WebDAV URL, so machine B (which reaches the server by a different host name) would compute a different key and see no conversations. Freezing the key also keeps existing data working with zero migration. |
| D8 | **Same-origin WebDAV entries are stored as relative** (`entry.sameOrigin = true`). On every machine their `url` is rewritten to `location.origin`. | `http://127.0.0.1:8111` from machine A is meaningless on machine B. |
| D9 | **No application authentication in v1.** The deployment assumption is a single trusted user, either on localhost, on a dedicated internal network, or behind an HTTPS reverse proxy that does its own authentication (e.g. proxy basic auth, which the browser then sends automatically on same-origin requests). | The user's stated deployment. It avoids building login, CSRF and cookie handling. |
| D10 | **Secrets** (model provider `key` fields and WebDAV `auth.pass`) are **stripped before upload by default**. `server.py --sync-secrets` turns stripping off. The capability response tells the client which mode is active. When applying server data, a missing secret never overwrites a locally present one. | Trusted deployments can opt in to having API keys survive a browser wipe. Everyone else gets safe defaults. |
| D11 | **No new Python dependencies.** Use the standard library `sqlite3`, `gzip`, `uuid`, `json` and `threading`. | Keeps `requirements.txt` unchanged. |
| D12 | **Source of truth for code is `unpacked/`.** Never edit `workbench/index.html` by hand. Regenerate it with `python3 build_esbuild.py` after frontend changes. | `index.html` is a generated bundle. |

## 4. Current architecture (facts the implementation relies on)

### 4.1 IndexedDB (`unpacked/js/db.js`, `constants.js`)

- `getDB()` opens `DB_NAME = 'CodeAgentStore_v34'`, **version 5**, with stores `handles`, `baselines`, `cache` and `sessions` (`STORE_*` constants in `constants.js`, around lines 367–370).
- `sessions` store keys:
  - session index: `sessionIndexKey(wsKey)` → `` `${wsKey}::index` ``. The value is `{ sessionIds: [...], activeSessionId, meta: { [id]: {id,title,createdAt,updatedAt,runningTimeMs,msgCount} } }`.
  - session record: `sessionRecordKey(wsKey, id)` → `` `${wsKey}::session::${id}` ``. The value is a plain object (messages, chatHTML, attachments with data URLs, tabs, token state, title, …).
  - `wsKey` comes from `getWorkspaceSessionKey()` (`workspace_core.js`) → `` `codeagent_sessions_${wsStorageName(rootHandle)}` ``.
- `baselines` store key: `baselineKey(wsName, sessionId)` → `` `${wsName}::${sessionId}` `` (`checkpoints_core.js`), where `wsName = currentWsName() = wsStorageName(rootHandle)`. The value is `{wsName, sessionId, originalFiles, modifiedFiles[], opsLog, compressionHistory}`. **`originalFiles` contains full file contents.**
- `handles` store keys: `recent_<folderName>` (a FileSystemDirectoryHandle, **never synced**) and `vws_<vid>` (a virtual workspace snapshot `{vid, name, entries:[{path, kind, blob}], updated}`, **contains Blob objects**).
- `cache` store: scanned metadata. **Never synced.**

Write functions in `db.js`: `saveSessionIndexToDB`, `patchSessionRecordInDB`, `deleteSessionRecordFromDB`, `saveBaselineToDB`, `deleteBaselineFromDB`.

Direct IndexedDB access outside `db.js`:

| File | Function | What it does |
|---|---|---|
| `modules/sessions_core.js` | `clearAllSessions` (around line 46) | deletes the session index key |
| `fs_core.js` | `vfsFlush` | writes `vws_<vid>` |
| `modules/workspace_core.js` | `loadRecentHandleFromDB`, `saveRecentHandleToDB` | local handles (not synced) |
| `modules/workspace_core.js` | workspace switcher (around line 1506) | reads `vws_<vid>` to check that it exists |
| `modules/workspace_transfer.js` | `openVirtualWorkspaceById`, `removeVirtualWorkspace` | read/delete `vws_<vid>` |
| `modules/ui_dialogs.js` | `clearIDBStore` | clears whole stores (Clear Data dialog) |

### 4.2 Workspace identity (`workspace_core.js`)

```js
function wsStorageName(h) {
    if (h && h.isVirtual) return 'virtual_' + h.vid;
    if (h && h.isWebDAV) { if (h.wsKey) return h.wsKey; /* hash of url|path|user|name */ }
    return h ? h.name : '';
}
```

- `WebDAVHandle` (`webdav.js`) has a `get wsKey()` getter that hashes the **absolute** `url`, path, user and name. The result differs per host name.
- Local folders are keyed by folder **name** only. Two different folders with the same name already share history today. This is a known limitation and stays acceptable.

### 4.3 Workspace catalog (`recent_folders_json`)

`getRecentFolders()` and `saveRecentFolders(folders)` in `workspace_core.js`. `saveRecentFolders` is the **only** writer of `recent_folders_json`. Entry shapes today:

- local: `{ name, lastAccessed }`
- virtual: `{ name, virtual: true, vid, lastAccessed }`
- webdav: `{ name, type: 'webdav', url, webdavPath, auth: {user, pass} | null, lastAccessed }`

Entries are built in `addToRecentFolders` (`workspace_core.js`), in the WebDAV dialog (`ui_explorer.js`, around lines 600 and 671) and when a virtual workspace is created (`ui_explorer.js`, around line 504). WebDAV entries are turned into handles with `new WebDAVDirHandle(entry.url, entry.webdavPath || '/', entry.auth, entry.name)` in `renderRecentFoldersList` and in the workspace-switcher click handler (both in `workspace_core.js`).

### 4.4 Workspace open sequence (`setWorkspace(handle)`, `workspace_core.js`)

`rootHandle = handle` → `syncWorkspace` → `syncAgentFilesWithWorkspace` → … → **`selectInitialSession()`** → `syncWorkspace` → **`restoreActiveSessionContent()`** (which calls `loadCheckpointForSession`).

Two behaviors matter for sync:

- `selectInitialSession()` **drops session ids whose record is missing locally** (`sessionRecordExistsInDB`) and rewrites the index.
- `loadCheckpointForSession()` **writes an empty baseline** when none exists locally.

Both would destroy server data if hydration has not finished first (see §13).

### 4.5 Settings in `localStorage`

Read during startup in the `DOMContentLoaded` handler in `ui_chat.js` (around line 527) and in `AppConfig.load()` (`constants.js`). The keys are listed in §9.

### 4.6 Server (`server.py`)

Starlette app built in `create_app(...)`. Routes are appended to `routes` in order. **The static mount `Mount("/", StaticFiles(...))` is appended last and catches everything**, so new API routes must be appended before it. CORS is `*`. WebDAV is anonymous at `/webdav`. Streaming responses exist (`/proxy`, `/api/webdav/events`, MCP SSE). Tests in `tests/test_server_webdav_api.py` use `create_app(...)` with Starlette's `TestClient` when available.

## 5. Architecture overview

```
 Browser (each machine)                                   server.py --data-dir D
 ┌───────────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ existing app code                             │        │ state_api.py (routes)        │
 │   reads/writes IndexedDB + localStorage       │        │   /api/v1/capabilities       │
 │        │ after each write: markDirty()        │        │   /api/v1/kv/{store}[/{key}] │
 │        ▼                                      │  HTTP  │            │                 │
 │ remote_store.js                               │◀──────▶│ state_store.py (SQLite)      │
 │   outbox (IndexedDB 'sync' store)             │        │   D/workbench_state.sqlite3  │
 │   uploader (debounced, X-Base-Rev)            │        │   D/server_id                │
 │   hydrate(store, prefix) → raw local writes   │        └──────────────────────────────┘
 │   conflict handling (fork / merge / server)   │
 └───────────────────────────────────────────────┘
```

Synced stores (the server whitelist):

| Server store | Local source | Key format (same as local) | Phase |
|---|---|---|---|
| `sessions` | IndexedDB `sessions` | `codeagent_sessions_<ws>::index`, `codeagent_sessions_<ws>::session::<id>` | 2 |
| `baselines` | IndexedDB `baselines` | `<ws>::<sessionId>` | 2 |
| `catalog` | `localStorage.recent_folders_json` (one record per entry) | `<entry.id>` | 2 |
| `settings` | whitelisted `localStorage` keys (§9) | the localStorage key itself | 3 |
| `vws` | IndexedDB `handles` key `vws_<vid>` | `vws_<vid>` | 4 |

## 6. Server design

### 6.1 Files

- `workbench/state_store.py`: class `StateStore`, pure storage with no HTTP.
- `workbench/state_api.py`: `make_state_routes(store, *, sync_secrets, max_record_bytes) -> list[Route]`.
- `workbench/server.py`: new CLI flags; register the routes **before** the static mount.
- `workbench/tests/test_state_store.py` and `workbench/tests/test_state_api.py`.

### 6.2 CLI flags (`server.py main()`)

| Flag | Default | Meaning |
|---|---|---|
| `--data-dir PATH` | unset | Enables persistence. Created if missing (`os.makedirs(..., exist_ok=True)`). `~` is expanded. |
| `--sync-secrets` | off | Client stops stripping API keys and WebDAV passwords. |
| `--max-record-mb N` | `64` | Maximum *decompressed* size of one value. |

`create_app(...)` gets matching keyword arguments: `data_dir=None, sync_secrets=False, max_record_mb=64`. Existing callers (tests) must keep working without passing them.

Update `runme` only if the user asks. Document the new flags in `README.md`.

### 6.3 SQLite schema (`state_store.py`)

File: `<data-dir>/workbench_state.sqlite3`. On open:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS kv (
    store      TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    rev        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    updated_at REAL    NOT NULL,          -- server time.time()
    client_id  TEXT,                      -- diagnostics only
    size       INTEGER NOT NULL DEFAULT 0,
    value      BLOB,                      -- NULL when deleted; stored uncompressed (inspectable)
    PRIMARY KEY (store, key)
);
PRAGMA user_version = 1;   -- only set if currently 0; future migrations branch on this
```

`<data-dir>/server_id`: a UUID4 string, created on first start and never changed. Clients use it to detect that they are talking to a different server.

Use a single `sqlite3.connect(path, check_same_thread=False)` guarded by a `threading.Lock`. Starlette handlers call the store through `run_in_threadpool` (already imported in `server.py`).

### 6.4 `StateStore` API (exact semantics)

```python
class StateStore:
    def __init__(self, data_dir: str): ...
    server_id: str

    def list(self, store: str, prefix: str = "") -> list[dict]:
        # rows where substr(key,1,len(prefix)) = prefix (use substr, NOT LIKE, to avoid escaping bugs)
        # returns [{"key", "rev", "deleted": bool, "updatedAt", "size"}], ordered by key

    def get(self, store: str, key: str) -> dict | None:
        # None if the row does not exist at all.
        # {"rev", "deleted", "updatedAt", "value": bytes | None}

    def put(self, store, key, value: bytes, base_rev: int | None, client_id=None) -> tuple[bool, int]:
        # One transaction. Let cur = current rev, or 0 if the row is missing.
        # If base_rev is not None and base_rev != cur: return (False, cur)        -> caller sends 412
        # else write value, deleted=0, rev=cur+1, updated_at=now; return (True, cur+1)
        # NOTE: a tombstoned row has rev>0, so writing over a tombstone needs base_rev == that rev.

    def delete(self, store, key, base_rev: int | None, client_id=None) -> tuple[bool, int]:
        # Same precondition rule. Missing row -> insert tombstone with rev=1.
        # Sets deleted=1, value=NULL, size=0, rev=cur+1.

    def delete_prefix(self, store, prefix, client_id=None) -> int:
        # Tombstone every non-deleted row with that prefix (unconditional). Returns the count.
```

### 6.5 HTTP API (`state_api.py`)

Allowed `store` values: `sessions`, `baselines`, `catalog`, `settings`, `vws`. Anything else returns `404 {"error":"unknown store"}`. Keys are taken from the URL path (`{key:path}` converter, URL-decoded by Starlette), 1–1024 characters.

Headers:
- Request `X-Base-Rev: <int>`: the rev the client last saw (`0` means "I believe it doesn't exist"). If absent, the write is unconditional.
- Request `X-Client-Id: <string>`: optional, stored for diagnostics.
- Request `Content-Encoding: gzip`: if present, decompress the body with `gzip.decompress` before the size check and storage.
- Response `X-Rev: <int>` on every kv response that concerns a single key.

| Method & path | Behavior |
|---|---|
| `GET /api/v1/capabilities` | **Always registered**, even without `--data-dir`. Returns `{"apiVersion":1,"persistence":bool,"serverId":str\|null,"syncSecrets":bool,"maxRecordBytes":int,"stores":[...]}`. |
| `GET /api/v1/kv/{store}?prefix=P` | `200 {"items":[...]}` from `list`. Tombstones are included. |
| `GET /api/v1/kv/{store}/{key}` | Missing row → `404`. Tombstone → `410` with `X-Rev`. Otherwise `200`, body = raw value bytes, `Content-Type: application/json`, `X-Rev`. If the request has `Accept-Encoding` containing `gzip` and the value is over 1 KB, gzip the body and set `Content-Encoding: gzip`. |
| `PUT /api/v1/kv/{store}/{key}` | Body = value bytes (JSON text). Too large → `413`. Precondition failed → `412 {"rev":cur}` with `X-Rev:cur`. Success → `200 {"rev":new}` with `X-Rev`. |
| `DELETE /api/v1/kv/{store}/{key}` | Same precondition rules. Success → `200 {"rev":new}`. |
| `DELETE /api/v1/kv/{store}?prefix=P` | Requires a non-empty `P`. Returns `200 {"deleted":n}`. |

When persistence is disabled, all `/api/v1/kv/...` routes return `503 {"error":"persistence disabled"}`. Registering them unconditionally is fine.

Do **not** add Starlette's global `GZipMiddleware`. It can buffer the existing SSE/streaming endpoints. Compress manually in the GET handler only.

Add `expose_headers=["X-Rev"]` to the existing `CORSMiddleware` call.

### 6.6 Backup

Document in `README.md`: `sqlite3 <data-dir>/workbench_state.sqlite3 ".backup <file>"` (safe while the server runs). Phase 5 may add `GET /api/v1/backup`, which uses `sqlite3.Connection.backup` into a temporary file and returns it.

## 7. Client design: `unpacked/js/remote_store.js`

A new classic module following the project's conventions: top-level functions, exported via `window.X = X` inside `// --- AST_EXPORTS_START ---` / `// --- AST_EXPORTS_END ---` blocks. Import it from `unpacked/js/ui_editor.js` next to the other imports (e.g. right after `import '../js/db.js';`).

### 7.1 IndexedDB changes (`db.js`, `constants.js`)

- Add `const STORE_SYNC = 'sync';` to `constants.js` and export it like the other `STORE_*` constants. There is a `window.STORE_* = ...` list and a long combined export statement around line 827. Add it to both.
- In `getDB()`, bump the version `5 → 6` and add `if (!db.objectStoreNames.contains(STORE_SYNC)) db.createObjectStore(STORE_SYNC);`.
- `STORE_SYNC` value per record, keyed by `` `${store}|${key}` ``:

```js
{ store, key,
  baseRev: 0,          // last server rev this browser has seen/applied for this key
  pending: null,       // null | 'put' | 'delete'
  dirtyGen: 0,         // incremented on every markDirty/markDeleted
  lastHash: null }     // hash of last successfully uploaded serialized value
```

### 7.2 Public functions

```js
RemoteStore.enabled          // boolean, true only after init() succeeded with persistence:true
RemoteStore.caps             // capability object
async function remoteInit()                       // §7.3
function remoteMarkDirty(store, key)              // fire-and-forget; never throws; no-op if disabled
function remoteMarkDeleted(store, key)            // same
async function remoteHydrate(store, prefix)       // §7.5; returns { changedKeys: [...] }
async function remoteHydrateKey(store, key)       // single key variant (used for vws)
async function remoteFlushNow()                   // forces an upload pass; used on pagehide
```

`remoteMarkDirty` and `remoteMarkDeleted` must return immediately. The app's save paths must never wait on the network. Internally they update `STORE_SYNC` (an async IndexedDB write, not awaited by callers) and schedule an upload.

### 7.3 `remoteInit()`

Called once, as the **first statement** inside the `try` of the `DOMContentLoaded` handler in `ui_chat.js` (before `models_json` is read):

1. `navigator.storage?.persist?.()`, fire-and-forget. This happens even when the server is unavailable (Phase 0).
2. `fetch('/api/v1/capabilities', {cache:'no-store'})` with a 3 s timeout (`AbortController`). Any failure, non-200 status, or `persistence !== true` leaves `RemoteStore.enabled = false` and returns. **Browser-only mode = this early return.**
3. `clientId = localStorage.sync_client_id` (create it if missing; see §12.3 for id generation).
4. If `localStorage.sync_server_id !== caps.serverId`: clear `STORE_SYNC`, set `sync_server_id`, and remove `sync_seeded`. This handles a fresh browser or a different server.
5. If `!localStorage.sync_seeded`: run **seed**. For every local record in the synced stores (all `sessions` keys, all `baselines` keys, every catalog entry, every whitelisted settings key, every `vws_*` key once Phase 4 is in), create a sync meta entry `{baseRev:0, pending:'put'}`. Then set `sync_seeded = '1'`. This uploads pre-existing browser data the first time.
6. `await remoteHydrate('catalog', '')` and, once Phase 3 is in, `await remoteHydrate('settings', '')`. This must finish before the rest of the startup handler reads `localStorage`.
7. Set `RemoteStore.enabled = true`, start the uploader, and register listeners:
  - `visibilitychange` → `hidden`: `remoteFlushNow()`; `visible`: `remoteRefreshCurrentWorkspace()` (§8.5).
  - `pagehide`: `remoteFlushNow()` (best effort).

During steps 5–6 the localStorage patch (§9.2) must not queue uploads for values written by hydration (use the "applying" guard).

### 7.4 Uploader

- `scheduleFlush()`: debounce 1500 ms with a maximum wait of 5000 ms since the first unflushed mark.
- `flush()`: at most **one flush running at a time**. Iterate `STORE_SYNC` entries with `pending !== null`, at most 3 requests in parallel. For each entry:
  1. Capture `gen = meta.dirtyGen`.
  2. `pending === 'put'`: read the current local value with the **reader** for that store (§7.6). If the local value no longer exists, convert to a delete. Serialize with `encodeForTransport` (§7.7) and `JSON.stringify`. Compute `h = hash53(text)`; if `h === meta.lastHash`, skip the request and treat it as success with an unchanged rev. Otherwise gzip if longer than 8 KB and `CompressionStream` exists, then `PUT` with `X-Base-Rev: meta.baseRev`.
  3. `pending === 'delete'`: `DELETE` with `X-Base-Rev`. A response of `404` counts as success.
  4. On `200`: re-read the meta. Set `baseRev = response rev` and `lastHash = h`. **Only if `meta.dirtyGen === gen`** set `pending = null`; otherwise leave it pending so the newer local write is uploaded on the next pass. Save the meta.
  5. On `412`: call `handleConflict(store, key, serverRev)` (§8).
  6. On network error or `5xx`: leave it pending and retry with backoff (2 s, 4 s, … capped at 60 s). On `413`: keep the local copy, set `pending = null`, set `meta.tooLarge = true`, and show one toast per key: "Conversation too large to sync".
- `hash53`: reuse the 53-bit string hash already used in `wsStorageName` (factor it into a helper). Do **not** use `crypto.subtle`; it is unavailable on plain-HTTP LAN origins.

### 7.5 Hydration

`remoteHydrate(store, prefix)`:

1. `GET /api/v1/kv/{store}?prefix=` to fetch the server listing.
2. For each server item, let `meta` be the local sync meta (default `{baseRev:0, pending:null}`):
  - `item.rev === meta.baseRev`: already in sync; skip.
  - `meta.pending !== null` and `item.rev !== meta.baseRev`: **conflict**. Call `handleConflict(store, key, item.rev)`.
  - `item.deleted`: delete locally with the **raw writer** (§7.6), then set `meta = {baseRev:item.rev, pending:null}`.
  - otherwise: `GET` the value, `decodeFromTransport`, apply it with the **raw writer** (for `sessions` index keys, apply via the index rule in §8.4; for `catalog`/`settings`, apply secret preservation per §9.3). Set `baseRev = item.rev` and `pending = null`. Add the key to `changedKeys`.
3. Local keys that are not on the server are left alone. Seed (§7.3) or later writes will upload them.
4. Download at most 4 values in parallel. Show a single progress toast if more than 10 values are being downloaded.

**Raw writers never call `remoteMarkDirty`.** They write directly to IndexedDB or call the *original* `localStorage.setItem` (§9.2).

### 7.6 Reader/writer table

| Store | Reader (for upload) | Raw writer / deleter (for hydration) |
|---|---|---|
| `sessions` | IDB `STORE_SESSIONS` get(key) | IDB `STORE_SESSIONS` put/delete(key) |
| `baselines` | IDB `STORE_BASELINES` get(key) | IDB `STORE_BASELINES` put/delete(key) |
| `catalog` | the entry with `id === key` in `getRecentFolders()`, after secret stripping | merge into the list (§10.3) and write with the original `setItem('recent_folders_json', …)` |
| `settings` | `localStorage.getItem(key)` parsed as JSON if possible, after secret stripping | original `setItem(key, …)` / `removeItem(key)` after secret preservation |
| `vws` | IDB `STORE_HANDLES` get(key) | IDB `STORE_HANDLES` put/delete(key) |

Put small helpers `idbGetRaw(storeName, key)`, `idbPutRaw(storeName, key, value)`, `idbDeleteRaw(storeName, key)` and `idbKeysRaw(storeName)` in `remote_store.js`. The `db.js` functions must **not** be used for raw writes, because they are the ones that call `remoteMarkDirty`.

### 7.7 Transport encoding

`async encodeForTransport(value)` walks the value recursively and replaces:
- `Blob`/`File` → `{ "__wb_bytes__": base64, "kind": "blob"|"file", "mime": type, "name": file.name|undefined, "lastModified": file.lastModified|undefined }`
- `ArrayBuffer` → `{ "__wb_bytes__": base64, "kind": "ab" }`
- `Uint8Array` (and other typed arrays, which can be viewed as bytes) → `{ "__wb_bytes__": base64, "kind": "u8" }`
- `Set` → `{ "__wb_set__": [...] }` (defensive; `modifiedFiles` is already stored as an array)

`decodeFromTransport(value)` reverses these. Everything else is plain JSON. Encode base64 in chunks of 32 KB to avoid call-stack limits.

## 8. Conflict handling (`handleConflict(store, key, serverRev)`)

### 8.1 `sessions` record (`…::session::<id>`): fork

1. If `isSessionRunning(id)` for the current workspace, do nothing now (leave it pending). It is retried on the next flush after the run ends.
2. Read the local record `L` (raw). Generate `newId` in the same format as the app (`'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6)`).
3. Write the raw record `{...L, id:newId, title:(L.title||'Untitled Session') + ' (conflict copy)', updatedAt: Date.now()}` under `sessionRecordKey(wsKey, newId)`. Copy the local baseline `${ws}::${id}` → `${ws}::${newId}` if it exists. `remoteMarkDirty` both new keys.
4. Add `newId` to the local index (`sessionIds` and `meta`) with a raw write, then `remoteMarkDirty` the index key.
5. Fetch the server value for the original key and apply it raw (or delete locally if `410`). Set `meta = {baseRev:serverRev, pending:null}`. Also re-fetch the server baseline for `${ws}::${id}` and apply it the same way (server wins for the original id).
6. `showToast('This conversation was changed on another device. Your version was kept as "… (conflict copy)".', 'info')`.
7. If the key belongs to the currently open workspace, call `remoteReloadSessions()` (§8.5).

Derive `wsKey`/`ws` by string-splitting the key: session keys split at `'::session::'`, baselines at the last `'::'`. Do not depend on `rootHandle`.

### 8.2 `baselines`: server wins

Except when called from 8.1, fetch the server value and apply it raw. Set `baseRev = serverRev` and `pending = null`.

### 8.3 `catalog`, `settings`, `vws`: server wins

Fetch and apply raw, with secret preservation for catalog/settings. For `vws`, first save the local snapshot under a new vid as a copy named `<name> (conflict copy)` and add a catalog entry for it, then apply the server version. Sessions do not follow the copy; that is acceptable.

### 8.4 Session index (`…::index`): merge

The index is a single shared record that every machine changes when it creates or switches sessions, so it gets a deterministic merge instead of a fork. Used both on `412` and when applying a server index during hydration while the local index exists:

```
merged.sessionIds = union(server.sessionIds, local.sessionIds) in server order, then local-only ids appended,
                    minus ids whose session record is tombstoned on the server or missing both locally and on the server listing
merged.meta[id]   = whichever of server.meta[id] / local.meta[id] has the larger updatedAt
merged.activeSessionId = local.activeSessionId if it is in merged.sessionIds, else server.activeSessionId, else merged.sessionIds[0]
```

On `412`: compute `merged`, raw-write it locally, set `baseRev = serverRev`, keep `pending = 'put'`, and flush again.

`activeSessionId` is effectively device-local: a machine never jumps to another session because a different machine switched.

### 8.5 Refreshing the open workspace

`remoteReloadSessions()`: if `!rootHandle` or `isAnySessionRunning()`, set a flag and retry when generation ends. A cheap way is to also check the flag at the end of `flush()`. Otherwise:

```js
const prevActive = state.activeSessionId;
state.sessions = {};                 // drop in-memory copies so records reload from IDB
await selectInitialSession();        // re-reads the (merged) index; keeps local activeSessionId
await restoreActiveSessionContent();
renderSessionPopoverList();
```

`remoteRefreshCurrentWorkspace()` runs on `visibilitychange → visible`, throttled to once every 10 s. It calls `remoteHydrate('sessions', wsKey + '::')` and `remoteHydrate('baselines', ws + '::')` for the open workspace, plus `remoteHydrate('catalog','')`. If `changedKeys` contains the active session record or the index, it calls `remoteReloadSessions()`. If the catalog changed and the workspace picker is visible, it calls `renderRecentFoldersList()`.

This gives the main multi-device workflow: work on A, walk to B (the tab loads or focuses and hydrates), continue, return to A (focus → hydrate → reload).

## 9. Settings sync (Phase 3)

### 9.1 Whitelist (`SYNC_LS_KEYS` in `constants.js`)

```js
const SYNC_LS_KEYS = {
    exact: ['app_config_json', 'models_json', 'selected_model', 'mode_prompts_json', 'last_mode',
            'prompt-history', 'tool_files_json', 'tool_lock_state', 'tool_perm_state',
            'tool_settings_state', 'tool_deleted_names', 'tool_github_state', 'tools_browse_location',
            'tools_config_default'],
    prefixes: ['app_config_', 'models_', 'mode_prompts_', 'tools_config_', 'tool_files_',
               'tool_lock_state_', 'tool_perm_state_', 'tool_settings_state_', 'selected_model_']
};
```

Never synced: `recent_folders_json` (handled by `catalog`), `sync_*` keys, and anything not matched above. Before implementing, grep for `localStorage.setItem(` and confirm that no new keys have appeared since this list was written.

### 9.2 Interception

Rather than editing 70 call sites, wrap `localStorage.setItem` and `removeItem` once in `remote_store.js`:

```js
const _origSet = Storage.prototype.setItem, _origRemove = Storage.prototype.removeItem;
let _applying = false;            // true while hydration writes
Storage.prototype.setItem = function (k, v) {
    _origSet.call(this, k, v);
    if (this === window.localStorage && !_applying && isSyncedLsKey(k)) remoteMarkDirty('settings', k);
};
Storage.prototype.removeItem = function (k) {
    _origRemove.call(this, k);
    if (this === window.localStorage && !_applying && isSyncedLsKey(k)) remoteMarkDeleted('settings', k);
};
```

Install the wrapper at module load (it is harmless when sync is disabled, because `remoteMarkDirty` is a no-op then). Hydration writes go through `_origSet` with `_applying = true`.

Also hook `saveRecentFolders` for the catalog (§10.3). `recent_folders_json` is deliberately not in the whitelist.

### 9.3 Secret stripping and preservation

Unless `caps.syncSecrets`:

- **Upload:** for keys `models_json` and `models_<ws>`, parse the JSON array and set `provider.key = ''` on each provider. For catalog entries, replace `auth.pass` with `''` (keep `auth.user`).
- **Apply:** for the same keys, merge per provider (match on `provider.provider` name and `url`). If the server's `key` is empty and the local one is not, keep the local one. Same for catalog `auth.pass`.

`tool_settings_state*` may contain tool API keys. This has not been verified. Phase 3 must inspect `tools_ui.js` (around lines 336 and 552) and add stripping if it does.

### 9.4 Precedence with `.agent/*` files

When a workspace has `.agent/config.json` etc. on disk, `syncAgentFilesWithWorkspace` already loads from disk and overwrites `app_config_json`/`models_json`. That behavior is unchanged. The disk file wins and the resulting localStorage write simply syncs. For WebDAV with `webdav-sync-agent=false`, the per-workspace `*_<wsKey>` keys are the source, and they are synced. Because `wsKey` is the frozen `storageKey` (§10), those keys resolve to the same name on every machine.

## 10. Workspace identity and catalog (Phase 2)

### 10.1 New catalog entry fields

```js
{ id: '<uuid-ish>',          // catalog identity, assigned once (§12.3)
  storageKey: '<string>',    // frozen data namespace = legacy wsStorageName() result at first sight
  sameOrigin: true|undefined // webdav only: url === location.origin when saved
  ...existing fields }
```

### 10.2 Using `storageKey`

1. In `wsStorageName(h)`, add as the **first line**: `if (h && h._storageKey) return h._storageKey;`
2. Add `ensureCatalogEntry(handle)` in `workspace_core.js`. Call it in `setWorkspace(handle)` **immediately before** `rootHandle = handle;`:
  - Find the matching entry with `entryMatchesHandle(entry, handle)`:
    - virtual: `entry.virtual && entry.vid === handle.vid`
    - webdav: `entry.type === 'webdav' && (entry.webdavPath||'/') === handle.path && (entry.sameOrigin ? handle.url === location.origin : entry.url === handle.url)`
    - local: `!entry.virtual && entry.type !== 'webdav' && entry.name === handle.name`
  - If found and `entry.storageKey` is set: `handle._storageKey = entry.storageKey`.
  - If found without `storageKey`: `entry.storageKey = wsStorageName(handle)` (legacy value, computed *before* `_storageKey` is set), `handle._storageKey = entry.storageKey`, `saveRecentFolders(folders)`.
  - If not found: `handle._storageKey = wsStorageName(handle)`. The entry is created shortly after by `addToRecentFolders` or the WebDAV dialog.
3. In `saveRecentFolders(folders)`, before writing: give every entry without `id` a new id (`makeSyncId()`, §12.3), and set `sameOrigin = true` on webdav entries whose `url === location.origin`. Do **not** fill in `storageKey` here; only `ensureCatalogEntry` sets it, on first open. In `addToRecentFolders(handle)`, include `storageKey: handle._storageKey` and carry the existing `id` forward when replacing an entry (it currently splices and re-inserts, so copy `id`/`storageKey` from the removed entry). Do the same in the two WebDAV-dialog code paths in `ui_explorer.js` (they filter out and re-add entries).

Because existing entries freeze their current key, **all existing local data keeps working without migration.** A WebDAV entry created on A carries A's key to B, so B finds A's conversations.

### 10.3 Catalog sync

- `saveRecentFolders(keep)`: after writing, diff against the previously synced snapshot (keep it in memory, initialized from `getRecentFolders()` at init). Call `remoteMarkDirty('catalog', id)` for new or changed entries and `remoteMarkDeleted('catalog', id)` for removed ones.
- Hydration apply (raw writer for `catalog`): build the list from local entries plus server entries by `id`; the server value replaces the local value for the same id (with `auth.pass` preserved). Tombstones remove entries. **Deduplicate** entries that match the same workspace (same `vid`; or same webdav path with equal `url`/`sameOrigin`; or same local name): keep the server one. Before writing, set `url = location.origin` on every `sameOrigin` entry. Write with the original `setItem`.
- Removing a workspace from the list on one machine removes it everywhere. This is intended.
- `MAX_RECENT_FOLDERS` eviction in `saveRecentFolders` applies to local folders. Evicted entries become tombstones on the server, which is acceptable.

### 10.4 Behavior on a second machine

- **WebDAV, same server:** works immediately.
- **WebDAV, external server with a password:** works if `--sync-secrets` is on; otherwise the user re-enters the password via the existing edit dialog. Change the edit dialog so it keeps the entry's `id`/`storageKey`.
- **Local folder:** clicking it finds no local handle, so the existing code opens the folder picker. If the picked folder has the same name, `ensureCatalogEntry` matches and A's conversations appear. File contents are whatever is on B's disk. Checkpoint "original files" from A may not match B's files; this is acceptable and documented.
- **Virtual:** needs Phase 4. Until then, B shows the entry but opening it shows the existing "Virtual workspace data not found" toast.
- **Plain HTTP on a LAN IP is not a secure context.** `showDirectoryPicker` is unavailable there (the app already hides local folders via `HAS_FS_API`). Only WebDAV and virtual workspaces work. HTTPS through the reverse proxy fixes this.

## 11. Hooks into existing code (complete list)

| Location | Change |
|---|---|
| `db.js` `saveSessionIndexToDB` | after the put completes: `remoteMarkDirty('sessions', sessionIndexKey(wsKey))` |
| `db.js` `patchSessionRecordInDB` | after the merged put completes: `remoteMarkDirty('sessions', key)` |
| `db.js` `deleteSessionRecordFromDB` | `remoteMarkDeleted('sessions', sessionRecordKey(wsKey, sessionId))` |
| `db.js` `saveBaselineToDB` | `remoteMarkDirty('baselines', key)` |
| `db.js` `deleteBaselineFromDB` | `remoteMarkDeleted('baselines', baselineKey(wsName, sessionId))` |
| `db.js` `getDB` | version 6 plus the `sync` store |
| `sessions_core.js` `clearAllSessions` | after the direct index delete: `remoteMarkDeleted('sessions', sessionIndexKey(wsKey))` |
| `workspace_core.js` `wsStorageName` | `_storageKey` short-circuit |
| `workspace_core.js` `setWorkspace` | `ensureCatalogEntry(handle)` before `rootHandle = handle`; **then, if `RemoteStore.enabled`, `await remoteHydrate('sessions', getWorkspaceSessionKey() + '::')` and `await remoteHydrate('baselines', currentWsName() + '::')` immediately before `await selectInitialSession()`** |
| `workspace_core.js` `saveRecentFolders`, `addToRecentFolders` | id/storageKey/sameOrigin handling plus catalog diff (§10) |
| `ui_explorer.js` WebDAV dialog (2 places) and virtual creation | preserve or assign `id`/`storageKey` |
| `ui_chat.js` `DOMContentLoaded` handler | `await remoteInit();` as the first statement inside `try` |
| `fs_core.js` `vfsFlush` (Phase 4) | after the put: `window.remoteMarkDirty?.('vws', 'vws_' + r._ws.vid)` (`fs_core.js` is an ES module that uses `window.*`) |
| `workspace_transfer.js` `removeVirtualWorkspace` (Phase 4) | `remoteMarkDeleted('vws', 'vws_' + vid)` |
| `workspace_transfer.js` `openVirtualWorkspaceById` and the switcher read in `workspace_core.js` (Phase 4) | replace both inline reads with a new helper `loadVirtualSnapshot(vid)` that first calls `await remoteHydrateKey('vws', 'vws_' + vid)` when enabled |
| `ui_dialogs.js` Clear Data (Phase 5) | add a checkbox "Also delete from server". When it is checked, call `DELETE /api/v1/kv/<store>?prefix=` with a suitable non-empty prefix (`codeagent_sessions_` for sessions; for baselines, list and delete individually). In all cases also clear `STORE_SYNC` and `sync_seeded`, so an unchecked clear re-downloads on the next load. That is the "restore from server" path. |

Every hook must be safe when `remote_store.js` is disabled (no-op), and must not change the return value or timing of the wrapped function. Do not `await` the mark functions inside the `db.js` promises.

## 12. Edge cases and details

### 12.1 Sizes and traffic
- `saveSession` runs many times per agent turn and also calls `persistCheckpoint`. Coalescing comes from the outbox design: the outbox stores *which* key is dirty, not the value, and the value is read at send time. The `lastHash` check prevents re-uploading an unchanged baseline.
- Expected upload rate during generation: at most one PUT per dirty key per 1.5–5 s.
- Values are gzipped above 8 KB. JSON chat logs typically compress 5–10×.

### 12.2 Offline / server down
Writes stay pending in `STORE_SYNC` and upload when the server returns. Hydration failures (network) are logged and ignored; the app continues on local data.

### 12.3 Id generation
`crypto.randomUUID` exists only in secure contexts. Use:
```js
function makeSyncId() {
    if (window.crypto?.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
    const b = new Uint8Array(16); crypto.getRandomValues(b);   // available in insecure contexts
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
```

### 12.4 Deleted-session guard
`deletedSessionIds` (in `state_manager.js`) is in-memory only. Server tombstones (D6) are what prevent resurrection across devices. Hydration must apply tombstones even when a local record exists. Special case: if that local key is still `pending` (edited here, deleted elsewhere), `handleConflict` sees a `410` and the fork in §8.1 keeps the local edits as a "(conflict copy)", while the original id is deleted locally. Nothing is lost, and the deleted id stays deleted.

### 12.5 Legacy local-folder name collision
Unchanged from today: two different local folders with the same name share a namespace. A possible later improvement is writing `.agent/workspace_id`. It is out of scope.

## 13. Pitfalls (read before coding)

1. **Route order:** register `/api/v1/...` routes before `Mount("/", StaticFiles(...))` in `create_app`, or they will never be reached.
2. **Hydrate before `selectInitialSession()`:** otherwise it prunes session ids whose records have not been downloaded yet, and `loadCheckpointForSession` writes empty baselines that are then uploaded over the server's real baselines. Both hydrations must be awaited in `setWorkspace`.
3. **Raw writes during hydration:** never go through `db.js` write functions or the patched `localStorage.setItem` while applying server data, or every download becomes an upload.
4. **`dirtyGen` race:** a write that happens while an upload is in flight must stay pending (§7.4, step 4).
5. **`_storageKey` must be set before `rootHandle = handle`:** `syncWorkspace`, `AppConfig.load` and `syncAgentFilesWithWorkspace` call `wsStorageName(rootHandle)`.
6. **`WebDAVHandle.wsKey` getter:** the existing `if (h.wsKey) return h.wsKey;` always returns a value for WebDAV handles, which is why the `_storageKey` check must come first.
7. **Settings must be hydrated before they are read:** `remoteInit()` (including the catalog/settings hydration) must be awaited at the very top of the `ui_chat.js` startup handler. Other `DOMContentLoaded` listeners (`settings_modal.js`, `tools_ui.js`) may read `localStorage` earlier. Check them, and if one reads synced keys, make it run after an `await window.remoteReady` promise that `remoteInit` resolves.
8. **No global GZip middleware** (it breaks SSE).
9. **No `crypto.subtle` and no `crypto.randomUUID` without a fallback** (plain-HTTP LAN).
10. **IndexedDB version bump:** `getDB()` must go to version 6. Old tabs still open on version 5 will block the upgrade; that is acceptable (the user reloads).
11. **Never treat "server returned nothing" or a failed request as permission to delete local data.** Only explicit tombstones delete.
12. **Do not edit `index.html`.** Edit `unpacked/` and run `python3 build_esbuild.py`.
13. **Keep the `AST_EXPORTS_START/END` export blocks** pattern in new and changed JS files.

## 14. Phased delivery

Each phase must leave the app fully working with and without `--data-dir`.

### Phase 0: Local safety net (no server)
1. `navigator.storage.persist()` at startup (also part of `remoteInit`, but must run even when the server is unavailable).
2. Implement `encodeForTransport`/`decodeFromTransport` and the IndexedDB raw helpers in `remote_store.js`.
3. Add **Settings → Data → "Download backup" / "Restore backup"**. Export = JSON `{format:'workbench-backup', version:1, createdAt, stores:{sessions:{key:value}, baselines:{…}, vws:{…}, settings:{lsKey:value}, catalog:[entries]}}`, encoded with `encodeForTransport`. Secrets are stripped unless the user ticks "include API keys". Import = raw-write everything (existing keys are overwritten after a confirm dialog), then reload the page.

**Done when:** you can export, clear all site data, import, and get every workspace, conversation, checkpoint and setting back.

### Phase 1: Server KV
1. `state_store.py`, `state_api.py`, and the `server.py` flags and route registration (§6).
2. Tests (`tests/test_state_store.py`, `tests/test_state_api.py`, using the `TestClient`/fallback pattern from `test_server_webdav_api.py`):
  - capabilities with and without `--data-dir`;
  - put/get round trip; the rev increments by 1;
  - `X-Base-Rev` mismatch → 412 with the current rev; `X-Base-Rev: 0` on an existing key → 412;
  - delete → GET returns 410; list shows `deleted:true`; put over a tombstone with the correct base rev succeeds;
  - prefix list is exact (prefix `a::` does not match `a:b`); keys containing `/`, `::`, spaces and unicode;
  - gzip request body is accepted; the size limit returns 413;
  - unknown store → 404; kv routes → 503 without `--data-dir`;
  - static files and `/api/webdav/tree` still work (existing tests pass).

**Done when:** all tests pass and `curl` works against a running server.

### Phase 2: Conversations, checkpoints, catalog
1. `remote_store.js`: init, outbox, uploader, hydrate, conflict handling for `sessions`/`baselines`/`catalog`, refresh-on-focus.
2. `storageKey`/`sameOrigin`/`id` handling (§10) and all Phase 2 hooks from §11.

**Done when** the manual scenarios in §15 numbered 1–7 pass.

### Phase 3: Settings
`SYNC_LS_KEYS`, the localStorage interception, secret stripping and preservation, and `settings` hydration in `remoteInit`. **Done when** scenario 8 passes.

### Phase 4: Virtual workspaces
The `vws` store, the `loadVirtualSnapshot` helper, and the `vfsFlush`/`removeVirtualWorkspace` hooks. Show a toast on 413. **Done when** scenario 9 passes.

### Phase 5: Polish (optional, any order)
- "Promote virtual workspace to server WebDAV": create `/webdav/<name>/` via `WebDAVDirHandle.openOrCreate(location.origin, '/webdav', name, null, name)`, upload the files, create a `sameOrigin` catalog entry **reusing the virtual entry's `storageKey`** (so its conversations carry over automatically), and remove the virtual entry.
- The "Also delete from server" checkbox in Clear Data.
- `GET /api/v1/backup`.
- A sync status indicator (pending count / offline) in the status bar.
- Advisory "open on another device" lease per session, with a "take over" button.

## 15. Manual acceptance scenarios

Start the server with `python3 server.py --host 0.0.0.0 --port 8111 --static-dir unpacked --webdav-dir <dir> --data-dir /tmp/wbstate`, and use two browser profiles (A, B) to simulate two machines. Use a different host name for B (e.g. the LAN IP vs `127.0.0.1`).

1. **Cache loss:** in A, open a WebDAV workspace, have a 3-turn conversation, edit a file via the agent. Clear all site data. Reload. The workspace appears in the list, the conversation is intact, and the Changes panel shows the edit.
2. **Pre-existing data upload:** with a browser that has history from before this feature, start the server with `--data-dir` for the first time and load the page. Then use profile B: B sees all of A's workspaces and conversations.
3. **Continuation:** continue A's conversation in B. Focus A's tab: it shows B's new turns without a manual reload.
4. **Conflict:** take both A and B offline (stop the server), add a turn in each, restart the server, and focus both. One machine shows a "(conflict copy)" session; no turn is lost on either side.
5. **Deletion:** delete a session in A. Focus B: it disappears. An old profile C that still has the session locally does not bring it back after loading.
6. **Browser-only mode:** start the server without `--data-dir`. There are no `/api/v1/kv` requests in the network tab and behavior is identical to before. Opening `unpacked/` via another static server (or with the Python server stopped) also works.
7. **Different host name:** the WebDAV workspace opened in A via `127.0.0.1` shows the same conversations in B via the LAN IP.
8. **Settings:** change theme, accent and a model definition in A. Reload B: they match. API keys are not on the server (inspect with `sqlite3`) unless `--sync-secrets` is set, and B's own API keys were not wiped.
9. **Virtual workspace:** create a virtual workspace with a few files including an image in A. Open it in B: the files are identical (including binary content).

## 16. Remaining open questions (non-blocking)

1. Should `prompt-history` stay synced (it is convenient, but lists every prompt typed on any machine)? It is synced in this draft.
2. Should `sidebar-width` (stored inside `app_config_json`) be excluded as device-local? This draft accepts that it syncs, for simplicity.
3. Retention of tombstones: keep them forever in v1 (they are tiny). A purge could come later.
