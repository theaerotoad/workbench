### Advice on #3 (Virtual Workspace Granularity)

**Keep `vws_<vid>` as a single snapshot for now.** Do not split virtual workspaces into per-file KV keys in this pass.

* **The lease removes the conflict problem.** Splitting `vws_<vid>` was only attractive if two windows were editing different files at the same time. With a single active writer per workspace plus cooperative flush-on-handoff, concurrent writes don't happen when online.
* **Existing transport optimizations already cover typical sizes.** Uploads are debounced (`vfsChanged` 500 ms + `remote_store` 1500 ms), skipped when unchanged (`hash53`), and gzipped above 8 KB.
* **Avoid premature complexity.** Per-file VFS keys require a manifest schema, atomic rename/delete tracking, orphan garbage collection, and N-way hydration—none of which pays off until virtual workspaces routinely hold tens of megabytes of binary assets. If that ever becomes a bottleneck later, **Phase 5's "Promote virtual workspace to server WebDAV"** (or content-addressed blob storage) is a much cleaner solution than per-path KV keys.

---

# Single-Active-Workspace Lease & Read-Only Handoff for Workbench

**Status:** Design & Implementation Spec v1.0 (extends *Durable and Multi-Device Storage for Workbench* v0.2).

**Scope:** `workbench/` only. Assumes Phases 0–4 are already implemented.

**Audience:** Implementer / coding agent. Sections 2 ("Locked decisions") and 8 ("Pitfalls") are binding. Do not re-open locked decisions. If code contradicts this document, stop and report instead of improvising.

---

## 1. Problem statement & goals

With Phases 0–4 in place, opening the same workspace in two tabs or on two devices allows both windows to write to the same `sessions`, `baselines`, and `vws` keys, producing `(conflict copy)` forks even when edits are sequential.

### Goals

1. **One active writer per workspace.** At most one browser tab holds the write lease for a given workspace (`storageKey`) at a time. Different workspaces can remain open and writable in parallel tabs.
2. **Non-blocking Read-Only mode with a "Take Over" banner.** Opening a workspace that is active elsewhere opens it immediately in Read-Only mode with a banner at the top of `#main-pane` showing who holds it and a **Take Over** button.
3. **Instant, conflict-free handoff when idle.** Clicking **Take Over** notifies the old tab over SSE, waits briefly for it to flush its latest local state to SQLite (typically <150 ms, capped at 1500 ms), transfers the lease, and hydrates the new tab—producing zero conflict copies.
4. **Mid-generation protection.** If the current holder is actively streaming an LLM response (`busy: true`), **Take Over** requires an explicit confirmation before aborting the other window's run and transferring control.
5. **Live reload on handoff.** Taking over (or taking back control) reloads chat sessions, checkpoints, WebDAV files, and Virtual Workspace (`VFSNode`) files in place without a page reload.
6. **Zero regression in browser-only / offline mode.** Without `--data-dir` (or when offline), leases are bypassed and existing `412` conflict copies remain the offline safety net.

---

## 2. Locked decisions

| # | Decision | Rationale |
| --- | --- | --- |
| L1 | **Lease scope is per workspace (`storageKey`)**, matching `wsStorageName(handle)`. | Allows working on Workspace A and Workspace B side-by-side while preventing collisions inside one workspace. |
| L2 | **Tab identity (`tabId`) is generated in memory per page load** (`makeSyncId()`), NOT stored in `sessionStorage`. | Chromium/Firefox clone `sessionStorage` on "Duplicate Tab", which would give two live tabs the same `tabId`. An in-memory ID guarantees uniqueness; `pagehide` releases it via `navigator.sendBeacon`. |
| L3 | **Leases are ephemeral and stored in memory on the server** (`lease_manager.py`), not in SQLite. | Avoids writing heartbeats to disk every 10 s and automatically clears stale locks on server restart. |
| L4 | **Single-click instant handoff when idle; confirmation gate when `holder.busy === true`.** Server enforces a TOCTOU check: `force: true` without `abortBusy: true` returns `409 { busyConflict: true }` if the holder started generating in the meantime. | Prevents accidental interruption of an in-flight LLM turn without adding friction to normal switching. |
| L5 | **Cooperative 2-phase handoff via SSE (`/api/v1/leases/{wsKey}/events`) with a 1500 ms ceiling.** | Ensures the old tab flushes debounced VFS/session edits before the new tab hydrates, eliminating `412` races while never hanging if the old tab is dead or throttled. |
| L6 | **Keep `vws_<vid>` as a single snapshot.** Add `remoteReloadVirtualWorkspace()` to refresh the live `VFSNode` tree and open Monaco models on Take Over. | Avoids per-file KV complexity while keeping virtual workspace handoffs seamless. |
| L7 | **Read-only tabs never mutate workspace storage** (IDB `sessions`, `baselines`, `vws`, or disk/WebDAV `.agent/*` files), enforced at both the UI layer and storage/outbox hooks. | Prevents a read-only tab from overwriting `activeSessionId`, creating empty baselines, or triggering `412`s. |
| L8 | **KV endpoints remain un-fenced by lease epoch on the server**; enforcement is cooperative via client read-only gating + handoff flush. | Preserves offline-reconnect behavior where existing `412` conflict copies remain the fallback. |
| L9 | **No new Python dependencies.** Use stdlib `asyncio`, `dataclasses`, `time`, `json`, `uuid`. | Consistent with D11 (`requirements.txt` unchanged). |
| L10 | **Edit `unpacked/` only**; regenerate `index.html` with `python3 build_esbuild.py`. | Consistent with D12. |

---

## 3. Server design

### 3.1 Files

* **New:** `lease_manager.py` — in-memory `LeaseManager` class (no HTTP imports).
* **Modified:** `state_api.py` — add `/api/v1/leases/...` routes and `"leases": enabled` to `GET /api/v1/capabilities`.
* **Modified:** `server.py` — instantiate `LeaseManager()` when `data_dir` is set and pass it to `make_state_routes(state_store, lease_manager=..., ...)`.
* **New:** `tests/test_leases.py` — unit + HTTP/ASGI tests for `LeaseManager` and `/api/v1/leases/...`.

### 3.2 `LeaseManager` (`lease_manager.py`)

Constants:

* `DEFAULT_TTL_SEC = 25.0`
* `HANDOFF_TIMEOUT_SEC = 1.5`

Data structures:

```python
@dataclass
class Lease:
    ws_key: str
    tab_id: str
    client_id: str
    label: str
    busy: bool
    epoch: int
    acquired_at: float
    updated_at: float
    expires_at: float

```

Per-workspace state:

* `_leases: dict[str, Lease]`
* `_subscribers: dict[str, list[_Subscriber]]` where `_Subscriber(tab_id, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop)`
* `_pending_handoffs: dict[str, tuple[asyncio.Event, asyncio.AbstractEventLoop, str]]` keyed by `handoff_id` → `(event, loop, expected_old_tab_id)`

Exact methods & semantics:

1. `_prune_expired(ws_key, now)`: deletes `_leases[ws_key]` if `expires_at <= now`.
2. `_serialize(lease, now)` → `{"wsKey", "tabId", "clientId", "label", "busy", "epoch", "acquiredAt", "updatedAt", "ageMs": max(0, int((now - lease.updated_at) * 1000)), "expiresInMs": max(0, int((lease.expires_at - now) * 1000))}`.
3. `subscribe(ws_key, tab_id) -> _Subscriber` and `unsubscribe(ws_key, sub)`:
* Registers an `asyncio.Queue(maxsize=32)` bound to `asyncio.get_running_loop()`.
* `_notify(ws_key, event_name, data, *, only_tab_id=None, exclude_tab_id=None)`: pushes `(event_name, data)` safely (if `sub.loop.is_closed()`, remove subscriber; if `sub.loop is running_loop`, `put_nowait`; else `sub.loop.call_soon_threadsafe(...)`; drop oldest item if queue full).


4. `async acquire_or_renew(ws_key, tab_id, client_id, label, busy=False, force=False, abort_busy=False) -> dict`:
* Prune expired lease for `ws_key`.
* Let `cur = _leases.get(ws_key)`.
* **Case A: Free or same `tab_id`:**
* Create or refresh `Lease` (`expires_at = now + ttl`, `updated_at = now`, `busy = bool(busy)`, `epoch = cur.epoch if cur else 1`).
* If `cur` existed and `cur.busy != busy`: broadcast `event: status` `{ "holder": _serialize(lease, now) }` to all subscribers except `tab_id`.
* Return `{"granted": True, "lease": _serialize(lease, now)}`.


* **Case B: Held by another `tab_id` and `not force`:**
* Return `{"granted": False, "busyConflict": False, "holder": _serialize(cur, now)}`.


* **Case C: Held by another `tab_id`, `force=True`, `cur.busy=True`, and `not abort_busy`:**
* Return `{"granted": False, "busyConflict": True, "holder": _serialize(cur, now)}`.


* **Case D: Held by another `tab_id`, `force=True` (and either `not cur.busy` or `abort_busy=True`):**
* `old_tab_id = cur.tab_id`
* Check if `old_tab_id` has at least one live SSE subscriber for `ws_key`.
* `handed_off_cleanly = False`
* If live subscriber exists:
* `handoff_id = uuid.uuid4().hex`
* Register `(ev, running_loop, old_tab_id)` in `_pending_handoffs[handoff_id]`.
* Send `event: revoke` `{"handoffId": handoff_id, "newLabel": label, "abortBusy": bool(abort_busy)}` to `only_tab_id=old_tab_id`.
* `try: await asyncio.wait_for(ev.wait(), timeout=HANDOFF_TIMEOUT_SEC); handed_off_cleanly = True`
* `except asyncio.TimeoutError: handed_off_cleanly = False`
* `finally: _pending_handoffs.pop(handoff_id, None)`


* Install new `Lease` with `epoch = cur.epoch + 1`, `tab_id`, `client_id`, `label`, `busy=bool(busy)`.
* Broadcast `event: status` `{"holder": _serialize(new_lease, now)}` to subscribers excluding `tab_id` and `old_tab_id`.
* Return `{"granted": True, "lease": _serialize(new_lease, now), "displacedTabId": old_tab_id, "handedOffCleanly": handed_off_cleanly}`.




5. `ack_handoff(ws_key, tab_id, handoff_id) -> bool`:
* Looks up `handoff_id` in `_pending_handoffs`. If `expected_old_tab_id == tab_id`, signals the `asyncio.Event` (using `call_soon_threadsafe` if needed) and returns `True`. Otherwise returns `False`.


6. `release(ws_key, tab_id) -> bool`:
* If `_leases.get(ws_key)` exists and its `tab_id == tab_id`: delete it, broadcast `event: released` `{"wsKey": ws_key, "previousTabId": tab_id}` to remaining subscribers, return `True`. Otherwise `False`.


7. `inspect(ws_key) -> dict | None`:
* Prunes expired, returns `_serialize(lease, now)` or `None`.



### 3.3 HTTP & SSE API (`state_api.py`)

All routes return `503 {"error": "persistence disabled"}` when `store is None` (same guard as `/api/v1/kv/...`). Registered **before** `Mount("/", StaticFiles(...))`.

Update `GET /api/v1/capabilities` to include `"leases": enabled` and `"leaseTtlMs": int(lease_manager.ttl_sec * 1000)` (or `25000`).

| Method & path | Request | Response |
| --- | --- | --- |
| `GET /api/v1/leases/{wsKey:path}` | *(none)* | `200 {"holder": lease|null}` (Note: register specific `/ack`, `/release`, `/events` routes **before** `{wsKey:path}` or use query/non-greedy path—see Pitfall #1 below!) |
| `POST /api/v1/leases` | JSON `{"wsKey", "tabId", "clientId", "label", "busy", "force", "abortBusy"}` | `200 {"granted": true, "lease", ...}` or `409 {"granted": false, "busyConflict": bool, "holder"}` |
| `POST /api/v1/leases/ack` | JSON `{"wsKey", "tabId", "handoffId"}` | `200 {"ok": bool}` |
| `POST /api/v1/leases/release` | JSON `{"wsKey", "tabId"}` (supports `navigator.sendBeacon` with `text/plain` or `application/json`) | `200 {"released": bool}` |
| `DELETE /api/v1/leases` | Query `?wsKey=...&tabId=...` | `200 {"released": bool}` |
| `GET /api/v1/leases/events` | Query `?wsKey=...&tabId=...` | `text/event-stream` (`Cache-Control: no-cache`, `X-Accel-Buffering: no`). Emits `: connected\n\n`, 20 s `: ping\n\n` keepalives, and `event: revoke|status|released\ndata: <json>\n\n`. |

> **Routing note:** Passing `wsKey` in the JSON body / query string (instead of `{wsKey:path}`) avoids any Starlette path-converter collision with `/ack`, `/release`, `/events`, and works cleanly with workspace names containing slashes, spaces, or colons.

---

## 4. Client design

### 4.1 Lease Client State (`unpacked/js/remote_store.js`)

New internal state:

```js
const _tabId = makeSyncId();            // per-tab, in-memory only (L2)
const _tabLabel = _detectClientLabel(); // e.g. "Chrome on Linux", "Firefox on macOS"
let _lease = {
    wsKey: null,                        // storageKey of currently open workspace
    mode: 'none',                       // 'none' | 'writer' | 'readonly'
    epoch: 0,
    holder: null,                       // { label, busy, ageMs, tabId } when readonly
    revoked: false,                     // true if we previously held the lease and lost it
    heartbeatTimer: null,
    eventSource: null,
    lastBusySent: false,
    takingOver: false,
    flushingForRevoke: false
};

```

Public exports added to `remote_store.js` (and `AST_EXPORTS`):

* `isWorkspaceReadOnly()` → `RemoteStore.enabled && _lease.wsKey !== null && _lease.mode === 'readonly'`
* `getWorkspaceLeaseState()` → shallow copy of `{ mode, holder, revoked, takingOver, wsKey }`
* `async remoteAcquireWorkspaceLease(wsKey)` → called in `setWorkspace()` before hydration/session load.
* If `!RemoteStore.enabled || !RemoteStore.caps?.leases`: sets `_lease = { wsKey, mode: 'writer', ... }`, updates banner (hidden), returns `{ mode: 'writer' }`.
* Sends `POST /api/v1/leases` (`force: false`).
* On `200`: sets `mode = 'writer'`, starts 10 s heartbeat + SSE subscriber (`_openLeaseEvents(wsKey)`), hides banner, returns `{ mode: 'writer' }`.
* On `409`: sets `mode = 'readonly'`, `holder = data.holder`, `revoked = false`, opens SSE subscriber (so banner updates on `status`/`released`), applies Read-Only mode & shows banner, returns `{ mode: 'readonly', holder: data.holder }`.
* On network error / 5xx: fail open (`mode = 'writer'`, log warning) so offline work continues; re-check lease on next `visibilitychange -> visible`.


* `async remoteTakeOverWorkspace()` → wired to the banner's **Take Over** button:
1. If `_lease.takingOver || !_lease.wsKey` return.
2. `let abortBusy = false;`
3. If `_lease.holder && _lease.holder.busy`:
* Show `confirmDialog('The other window (' + label + ') is currently generating an AI response. Taking over will stop that generation and switch control here. Continue?', { confirmLabel: 'Stop & Take Over', danger: true })`.
* If cancelled, return.
* `abortBusy = true;`


4. Set `_lease.takingOver = true`, update banner button to `"Taking over…"` (disabled).
5. Call `POST /api/v1/leases` with `{ wsKey, tabId: _tabId, clientId: _clientId, label: _tabLabel, busy: false, force: true, abortBusy }`.
6. If server returns `409` with `busyConflict: true` (TOCTOU race where the other tab just started generating):
* Update `_lease.holder = data.holder`, update banner, prompt the confirmation dialog above; if confirmed, retry once with `abortBusy: true`.


7. On `200 { granted: true }`:
* Set `_lease.mode = 'writer'`, `_lease.revoked = false`, `_lease.holder = null`, `_lease.epoch = data.lease.epoch`.
* Start heartbeat (ensure SSE subscriber is open).
* Call `await remoteReloadWorkspace()` (§4.4) to hydrate `vws`, `sessions`, `baselines` and refresh open files/chat.
* Call `setWorkspaceReadOnly(false)`.
* `showToast('Control transferred to this window', 'success')`.


8. `finally`: set `_lease.takingOver = false`, re-render banner.


* `remoteNotifyBusyState(isBusy)` → called when generation starts/stops (`task_runner.js` / `chat_input.js`). If `_lease.mode === 'writer'` and `Boolean(isBusy) !== _lease.lastBusySent`, immediately fires a heartbeat `POST /api/v1/leases` (`force: false, busy: Boolean(isBusy)`).
* `remoteReleaseWorkspaceLease(wsKey, { useBeacon = false } = {})` → stops heartbeat & closes lease SSE; sends `navigator.sendBeacon('/api/v1/leases/release', new Blob([JSON.stringify({ wsKey, tabId: _tabId })], { type: 'application/json' }))` when `useBeacon: true`, else `fetch('/api/v1/leases?...', { method: 'DELETE', keepalive: true })`. Resets `_lease` to `mode: 'none'`.

### 4.2 Cooperative Revoke Handler (`_handleLeaseRevoked`)

Triggered immediately when SSE receives `event: revoke` `{ handoffId, newLabel, abortBusy }` (or if a heartbeat returns `409`, in which case `handoffId` is null):

1. Stop the heartbeat timer.
2. Set `_lease.flushingForRevoke = true` (temporarily permits the final flush below to finish before outbox gating locks).
3. If `isAnySessionRunning()`:
* Abort every running session via `abortGeneration({ showResumeUI: false, sessionId: s.id })`.


4. Flush latest local state to SQLite:
* If `rootHandle && rootHandle.isVirtual`: `await vfsFlushIfDirty()` (await `vfsFlush(rootHandle)` directly if `_n._dirty` so the flush completes before upload).
* If `state.activeSessionId && state.sessions[state.activeSessionId]`: `await saveActiveSession(true)` (only if not already read-only).
* `await remoteFlushNow()`.


5. Set `_lease.flushingForRevoke = false`, `_lease.mode = 'readonly'`, `_lease.revoked = true`, `_lease.holder = { label: newLabel || 'another window', busy: false, ageMs: 0 }`.
6. Apply Read-Only UI (`setWorkspaceReadOnly(true)`) and show banner:
* *"Control moved to another window (`<newLabel>`). This tab is now read-only."*
* If `state.dirtyFiles && state.dirtyFiles.size > 0`, show an extra warning toast: `"You have unsaved editor changes in this tab. Click Take Over to reclaim control or copy your edits."`


7. If `handoffId`: send `POST /api/v1/leases/ack` `{ wsKey, tabId: _tabId, handoffId }`.

### 4.3 Outbox Gating for Read-Only Workspaces

Add helper `_isKeyInReadOnlyWorkspace(store, key)` in `remote_store.js`:

* If `_lease.mode !== 'readonly' || _lease.flushingForRevoke || !_lease.wsKey` → `false`.
* If `store === 'sessions'` and `key.startsWith('codeagent_sessions_' + _lease.wsKey + '::')` → `true`.
* If `store === 'baselines'` and `key.startsWith(_lease.wsKey + '::')` → `true`.
* If `store === 'vws'` and `_lease.wsKey.startsWith('virtual_')` and `key === 'vws_' + _lease.wsKey.slice('virtual_'.length)` → `true`.
* Otherwise `false` (`catalog` and `settings` stay unaffected).

In `remoteMarkDirty(store, key)` and `remoteMarkDeleted(store, key)`: if `_isKeyInReadOnlyWorkspace(store, key)`, return immediately without queueing.

### 4.4 Full Workspace Reload on Take Over (`remoteReloadWorkspace`)

Replaces partial reloads when transitioning `readonly -> writer` (and when clicking **Refresh** in the read-only banner):

1. If `!window.rootHandle`, return.
2. `const wsKey = getWorkspaceSessionKey(); const ws = currentWsName();`
3. **Virtual workspace files (`remoteReloadVirtualWorkspace()`):**
* If `rootHandle.isVirtual`:
* `const vid = rootHandle.vid || rootHandle._n?._ws?.vid;`
* `await remoteHydrateKey('vws', 'vws_' + vid);`
* Read snapshot via `idbGetRaw(STORE_HANDLES, 'vws_' + vid)`.
* If snapshot exists:
* Build fresh `VFSNode('directory', snap.name, null)` with `_ws = { vid }`, populate entries, wrap with `vfsWrap(root)`, set `newHandle._storageKey = rootHandle._storageKey || ws`.
* Replace `rootHandle = newHandle`.
* Drop cached file text from `registry.files` for non-virtual-agent/non-attachment files, run `await syncWorkspace(false)`.
* For each open tab in `state.openTabs` that is a workspace file (not `'chat'`, not `filediff:*`, not attachment):
* If the file still exists and `!isFileDirty(fp)`: reload content and update `monacoModels.get(fp)` via `withDirtyTrackingSuppressed(() => model.setValue(fresh))`.
* If the file was deleted in the other window and `!isFileDirty(fp)`: call `closeTabNoConfirm(fp)`.








4. **WebDAV files:**
* If `rootHandle.isWebDAV`: `await syncWorkspace(false)` (refreshes Explorer + non-dirty open Monaco models).


5. **Sessions & Baselines:**
* `await remoteHydrate('sessions', wsKey + '::');`
* `await remoteHydrate('baselines', ws + '::');`
* `await remoteReloadSessions();`



### 4.5 Read-Only UI & Banner (`index.template.html`, `styles/editor.css`, `ui_layout.js`)

**HTML (`unpacked/index.template.html`):** Place directly after `#tabs-overflow-menu` and before `#chat-view` inside `#main-pane`:

```html
<div id="workspace-lease-banner" class="workspace-lease-banner" role="status" aria-live="polite" style="display:none;">
    <span class="icon lease-banner-icon">lock</span>
    <span id="workspace-lease-msg" class="lease-banner-msg"></span>
    <div class="lease-banner-actions">
        <button type="button" id="btn-lease-refresh" class="pill-btn" title="Refresh read-only view from server">
            <span class="icon" style="font-size:13px;">refresh</span>
            <span>Refresh</span>
        </button>
        <button type="button" id="btn-lease-takeover" class="pill-btn primary" title="Transfer write control to this window">
            <span class="icon" style="font-size:13px;">swap_horiz</span>
            <span>Take Over</span>
        </button>
        <button type="button" id="btn-lease-close" class="pill-btn" title="Close workspace">
            <span>Close</span>
        </button>
    </div>
</div>

```

**CSS (`unpacked/styles/editor.css` + light theme overrides in `modern-theme.css`):**

* `#workspace-lease-banner`: slim flex bar (`padding: 6px 12px`, amber/warning subtle tint border-bottom, `gap: 8px`, `align-items: center`).
* When `body.workspace-readonly`:
* Visually mute write-only controls (`#btn-new-file`, `#btn-new-folder`, `#btn-upload-files`, `#btn-discard-all`, `#btn-doc-save`, `#btn-diff-save`, `#btn-diff-discard`, `#btn-create-session`, `#btn-clear-all-sessions`, `.btn-del-session`, `.btn-prompt-action.edit`, `.btn-prompt-action.del`, `#prompt-attach`) with `opacity: 0.45; pointer-events: none;`.
* Style `#prompt-input-row` as dimmed.



**`setWorkspaceReadOnly(readOnly)` (in `ui_layout.js`, exported on `window`):**

1. `document.body.classList.toggle('workspace-readonly', !!readOnly);`
2. `if (window.monacoEditor) window.monacoEditor.updateOptions({ readOnly: !!readOnly });`
3. `if (window.monacoDiffEditor) window.monacoDiffEditor.getModifiedEditor().updateOptions({ readOnly: !!readOnly });`
4. Toggle `#cmd` `disabled = !!readOnly`, update placeholder (restore `MODE_CONFIG[state.mode].placeholder` when exiting read-only), disable `#prompt-symbol`.
5. Call `updateWorkspaceLeaseBanner()` to sync banner visibility, message text (idle vs busy vs released vs revoked), and button disabled state.

---

## 5. Hooks into existing code (complete list)

| Location | Change |
| --- | --- |
| `server.py` | Instantiate `LeaseManager()` when `data_dir` is set; pass `lease_manager` to `make_state_routes(...)`; store on `app.state.lease_manager`. |
| `state_api.py` | Add `leases` / `leaseTtlMs` to `/api/v1/capabilities`; add `/api/v1/leases`, `/api/v1/leases/ack`, `/api/v1/leases/release`, `/api/v1/leases/events` routes. |
| `workspace_core.js` `setWorkspace` | Immediately after `ensureCatalogEntry(handle)` and `rootHandle = handle`: call `await remoteAcquireWorkspaceLease(currentWsName())`. If `isWorkspaceReadOnly()`, skip `writeAgentFileToDisk` inside `syncAgentFilesWithWorkspace` and skip `markRecentFolderAccessed`. Keep existing hydration before `selectInitialSession()`. Apply `setWorkspaceReadOnly(isWorkspaceReadOnly())`. |
| `workspace_core.js` `closeWorkspace` | Before clearing `rootHandle`: call `remoteReleaseWorkspaceLease(currentWsName())` and `setWorkspaceReadOnly(false)`. |
| `workspace_core.js` `syncAgentFilesWithWorkspace` | If `isWorkspaceReadOnly()`, read `.agent/*` / per-workspace config normally, but **do not** call `writeAgentFileToDisk` or `saveWorkspaceToolsState(..., true)`. |
| `sessions_core.js` `selectInitialSession` | If `isWorkspaceReadOnly()`: never call `saveSessionIndexToDB` when pruning or when empty (render an ephemeral read-only empty session in memory without persisting). |
| `sessions_core.js` `switchSession` | If `isWorkspaceReadOnly()`: skip `await saveActiveSession(true)` and just load/render the selected session in memory. |
| `sessions_core.js` `createNewSession`, `deleteSession`, `clearAllSessions` | Early-return with toast if `isWorkspaceReadOnly()`. |
| `checkpoints_core.js` `loadCheckpointForSession` | If `isWorkspaceReadOnly()` and `!saved`: do **not** call `saveBaselineToDB(...)`. |
| `chat_input.js` `submitPrompt` | Early-return with toast if `isWorkspaceReadOnly()`. |
| `task_runner.js` `runTask` | Call `remoteNotifyBusyState(true)` when generation starts and `remoteNotifyBusyState(false)` in the `finally` block when generation ends (after `gen.isRunning = false`). |
| `fs_core.js` `writeDisk`, `fs.write`, `fs.create`, `fs.edit`, `fs.rename`, `fs.del`, `fs.mkdir` | Guard at top: if `window.isWorkspaceReadOnly?.()` return `{ error: 'Workspace is read-only.' }` (with toast for UI calls). |
| `ui_layout.js` `saveEditorFile`, `saveDiffModifiedFile`, `switchTab` | Guard save functions when `isWorkspaceReadOnly()`; in `switchTab`, re-apply `monacoEditor.updateOptions({ readOnly: isWorkspaceReadOnly() })` so newly created editors inherit read-only state. |
| `ui_explorer.js` | Guard file creation/folder creation/drop/rename/delete handlers if `isWorkspaceReadOnly()`. |
| `ui_chat.js` `pagehide` listener | Call `remoteReleaseWorkspaceLease(currentWsName(), { useBeacon: true })` alongside `remoteFlushNow()`. |
| `remote_store.js` `remoteRefreshCurrentWorkspace` | When `mode === 'readonly'`, refresh via `remoteReloadWorkspace()` if server revisions changed (instead of only sessions) and re-check lease status. When `mode === 'writer'`, send an immediate heartbeat renew to catch any missed revoke while backgrounded. |

---

## 6. Pitfalls (read before coding)

1. **Route ambiguity:** Never put `{wsKey:path}` on `/api/v1/leases/{wsKey:path}` if you also have `/api/v1/leases/events` or `/api/v1/leases/ack`—Starlette's `:path` converter can shadow subpaths or mishandle `%2F`. Keep `wsKey` in the JSON body (POST) or query string (GET/DELETE).
2. **Event-loop isolation in pytest / ASGI tests:** `tests/test_state_api.py` runs each request via `asyncio.run(...)` when `httpx`/`TestClient` is absent, creating a new event loop per call. Always pair stored `asyncio.Queue` / `asyncio.Event` objects with their owning `loop = asyncio.get_running_loop()` and guard against closed/foreign loops.
3. **Do NOT use `sessionStorage` for `tabId`:** Duplicating a tab copies `sessionStorage`, causing two live tabs to share a `tabId` and silently collide. Keep `_tabId` strictly in memory.
4. **Read-only tabs must not auto-write on open:** `selectInitialSession()` (pruning/default creation), `loadCheckpointForSession()` (empty baseline creation), `switchSession()` (`saveActiveSession`), and `syncAgentFilesWithWorkspace()` (writing default `.agent/*` files) all write today. Every one of them must skip writes when `isWorkspaceReadOnly()`.
5. **Flush-before-lock ordering during revoke:** In `_handleLeaseRevoked()`, set `_lease.flushingForRevoke = true` so the final `vfsFlush` + `saveActiveSession` + `remoteFlushNow` are permitted *before* switching `_lease.mode = 'readonly'` and sending `/ack`. Otherwise the outbox guard will block the handoff flush!
6. **`vfsFlush` async wait:** `vfsFlushIfDirty()` in `fs_core.js` currently doesn't `return` the promise from `vfsFlush(window.rootHandle)`. Make `vfsFlushIfDirty()` return the promise (`return vfsFlush(window.rootHandle)`) so `_handleLeaseRevoked` can `await` it before calling `remoteFlushNow()`.
7. **Monaco `readOnly` reset on tab switch / init:** Monaco can be initialized lazily after `setWorkspace()` or reconfigured on tab switch. Apply `readOnly: isWorkspaceReadOnly()` both inside `setWorkspaceReadOnly()` and right after `initMonaco()` / `switchTab()`.
8. **No global GZip middleware** (still forbidden—breaks `/api/v1/leases/events` SSE streaming).
9. **Preserve `AST_EXPORTS_START` / `AST_EXPORTS_END**` in every modified JS file and run `python3 build_esbuild.py` after frontend edits.

---

## 7. Phased delivery & test cases

### Phase A: Server Lease Manager & API

**Deliverables:** `lease_manager.py`, `state_api.py`, `server.py`, `tests/test_leases.py`.

**Automated test cases (`tests/test_leases.py`):**

1. `test_capabilities_reports_leases`: `leases: false` without `--data-dir` (and lease endpoints return `503`); `leases: true` with `--data-dir`.
2. `test_acquire_renew_and_conflict`:
* Tab A acquires `ws1` → `200`, `epoch == 1`.
* Tab A renews `ws1` → `200`, `epoch == 1`, TTL extended.
* Tab B tries `ws1` (`force: false`) → `409`, `busyConflict: false`, `holder.label == Tab A`.
* Tab B acquires a *different* workspace `ws2` → `200` (proves per-workspace scoping).


3. `test_ttl_expiry`: Use a short TTL (`ttl_sec=0.1`) in `LeaseManager`; after sleep `0.15s`, Tab B acquires `ws1` without `force` → `200`.
4. `test_release_via_delete_and_post_beacon`:
* `DELETE /api/v1/leases?wsKey=ws1&tabId=wrong` → `{"released": false}` (cannot release someone else's lease).
* `POST /api/v1/leases/release` with `tabId=tabA` → `{"released": true}`; Tab B immediately acquires `ws1` → `200`.


5. `test_force_takeover_busy_protection`:
* Tab A holds `ws1` with `busy: true`.
* Tab B sends `force: true, abortBusy: false` → `409`, `busyConflict: true`, `holder.busy: true`.
* Tab B sends `force: true, abortBusy: true` → `200`, `epoch == 2`, `displacedTabId == tabA`.


6. `test_cooperative_sse_handoff_and_ack` (async test against `LeaseManager` directly):
* Tab A subscribes to `ws1` events and holds lease.
* Task 1 starts `acquire_or_renew(..., tab_id="B", force=True)`.
* Tab A's queue immediately receives `("revoke", {"handoffId": ...})`.
* Tab A calls `ack_handoff("ws1", "A", handoff_id)`.
* Task 1 finishes immediately (<200 ms) with `handedOffCleanly: True`, `epoch == 2`.


7. `test_cooperative_handoff_timeout_when_old_tab_unresponsive`:
* Use `handoff_timeout_sec=0.15`; Tab A subscribes but never calls `ack_handoff`.
* Tab B's `force=True` completes after ~0.15 s with `granted: True`, `handedOffCleanly: False`.


8. `test_status_and_released_broadcasts`:
* Tab B (read-only subscriber) receives `status` event when Tab A toggles `busy: false -> true`, and receives `released` event when Tab A calls `release()`.


9. Existing `pytest` suite (`test_server_webdav_api.py`, `test_state_store.py`, `test_state_api.py`) continues to pass.

**Done when:** `pytest -v` passes all new and existing tests.

---

### Phase B: Client Lease Lifecycle, Read-Only Mode & Banner

**Deliverables:** `remote_store.js` (lease client + outbox gating), `index.template.html` (`#workspace-lease-banner`), `styles/editor.css` + `styles/modern-theme.css`, `ui_layout.js` (`setWorkspaceReadOnly`, `updateWorkspaceLeaseBanner`), `workspace_core.js`, `sessions_core.js`, `checkpoints_core.js`, `fs_core.js`, `ui_chat.js`, `ui_editor.js`, `ui_explorer.js`, `chat_input.js`.

**Done when:**

* Opening a workspace active in Window A opens it Read-Only in Window B with the banner visible on Chat, Editor, and Diff tabs.
* Window B cannot edit Monaco, send prompts, create/delete sessions, or create/edit/delete files while Read-Only, yet can browse files, view sessions, search, and copy text.
* Closing the workspace or tab in Window A releases the lease immediately.
* Browser-only mode (`server.py` without `--data-dir`) shows no banner and makes zero `/api/v1/leases` calls.

---

### Phase C: Cooperative Handoff Reloads & Busy-State Protection

**Deliverables:** `remoteReloadWorkspace()` + `remoteReloadVirtualWorkspace()` in `remote_store.js`, `remoteNotifyBusyState()` hooks in `task_runner.js` / `chat_input.js`, `vfsFlushIfDirty()` promise return in `fs_core.js`, `Refresh` button wiring in banner, `python3 build_esbuild.py`.

**Manual acceptance scenarios (run with `--data-dir /tmp/wbstate` across two browser profiles A and B):**

1. **Read-Only entry & clean idle handoff (Virtual workspace):**
* Open Virtual Workspace V in A, edit `notes.txt`, send 1 chat turn.
* Open V in B → B opens in Read-Only mode with the banner (*"active in another window"*). Verify Monaco and prompt box are read-only and no `(conflict copy)` is created.
* In A, make another edit to `notes.txt` (do not wait for debounce). Immediately click **Take Over** in B.
* Expected: A switches to Read-Only banner immediately; B finishes Take Over in <1 s and displays A's latest `notes.txt` and chat turn with **zero conflict copies**.


2. **Round-trip handoff back to A:**
* Edit `notes.txt` and add a chat turn in B.
* Click **Take Over** in A.
* Expected: B switches to Read-Only; A reloads `notes.txt` and the chat turn in place (no page refresh) and becomes writable.


3. **Mid-generation (`busy`) protection:**
* Start a long LLM response in A.
* Observe B's banner updates to show A is currently generating.
* Click **Take Over** in B → confirmation dialog appears.
* Click **Cancel** → A keeps generating undisturbed.
* Click **Take Over** again → click **Stop & Take Over** → A's generation aborts cleanly, partial history flushes, B takes control.


4. **Parallel different workspaces:**
* Open Workspace 1 in A and Workspace 2 in B → both are writable with no banners.


5. **Tab close / browser crash recovery:**
* Open Workspace 1 in A and B (B is Read-Only). Close A's tab → B's banner immediately updates to indicate the other window closed; clicking **Take Over** grants instant control.
* Kill A's process without `pagehide` → after 25 s TTL (or immediately on **Take Over**), B acquires control.


6. **Offline divergence fallback:**
* Stop `server.py`, edit in both A and B while offline, restart `server.py` → existing `412` conflict-copy fallback still preserves both versions without data loss.


7. **Browser-only mode:**
* Run `server.py` without `--data-dir` → zero `/api/v1/leases` requests, identical behavior to before.
