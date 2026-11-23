# Remaining Tool Fixes

Follow-up to `TOOL_FIXES_AND_UPGRADES_PLAN.md`. Everything below was found by running the tools in a live session against that plan.
All paths are relative to `workbench/` and refer to the **unpacked** sources (`unpacked/...`, `jsutils/...`).

> Note: the working copy used for testing already contains the edits marked **(applied in test copy)**. They're described in full here, so they can be re-implemented on the real tree. Don't copy files across.

## Status at a glance

| # | Issue | Severity | Files |
|---|-------|----------|-------|
| A | WebDAV: missing paths are reported as existing. This breaks the `read` not-found error (0.2), `delete` directory detection, and checkpoint create-vs-modify. | **High** | `unpacked/js/webdav.js`, `unpacked/js/fs_core.js` |
| B | Hidden (dot) folders are still skipped by the scan. Requested change: show them, except `.agent/`. | Medium | `unpacked/js/modules/fs_utils.js`, `unpacked/js/constants.js`, (`server.py`) |
| C | `fs.del()` decides "is directory" from `registry.meta` only, so a directory that isn't in meta is deleted with no checkpoint data. | **High** (data loss on revert) | `unpacked/js/fs_core.js`, `unpacked/js/constants.js` |
| D | `map` breaks when two calls run in parallel (Tree-sitter init race). | Medium | `unpacked/tools/map.js` |
| E | py_run doesn't sync deletions back. The source is correct, but the installed tool is an old copy. | Low (deployment) | `jsutils/py_run.js` (re-install only) |
| F | 5.2 run-tests skill not created. | Low | `.agent/skills/run-tests/SKILL.md` (user) |
| G | 5.3 notes-file convention not in the prompts. | Low | `unpacked/js/modules/prompt_modes.js` |
| H | 2.1 change notice is implemented but not yet verified end-to-end. | Verify only | — |

Recommended order: **A → C → B → D → G → F → E → H**. A and C together close a revert/data-loss hole. B should land after C, because B makes many more directories visible to `delete`.

---

## A. WebDAV handles never confirm existence

### Symptoms
- `read("does_not_exist_xyz.txt")` and `read("nodir/missing.txt")` both return `1 |` instead of `ERROR: … not found`. The 0.2 check in `readFileContentForTool()` is present, but it never fires.
- `delete("scratch")` removed a non-empty folder **without** `recursive: true` (see C for why that is worse than it sounds).

### Root cause
`WebDAVDirHandle.getFileHandle(name)` and `getDirectoryHandle(name)` (`unpacked/js/webdav.js`) build handle objects **without contacting the server** when `create` is false. They never throw `NotFoundError`, unlike the File System Access API and `vfs.js`. As a result:

- `fileExistsOnDisk(fp)` (`fs_core.js`) is `!!(await getHandleByPath(fp))`, which is **always true** on WebDAV. It's also true when `fp` is actually a directory.
- `workspaceDirExists(dir)` is always true on WebDAV.

Every caller that falls back to these when `registry.meta` has no entry gets the wrong answer:

| Caller | Effect |
|---|---|
| `readFileContentForTool()` (`fs.js`) | The not-found error never fires, and `readFileContent` swallows the 404 and returns `""`. |
| `TOOL_API_METHODS.deleteFile` (`constants.js`) | `fileExistsOnDisk(dir)` is true, so a directory is treated as a file and the `recursive` guard is skipped. |
| `fs.write()` (`fs_core.js`) | A brand-new file counts as `existed`, so the op is recorded as a *modify* with previous content `""`, not a *create*. Reverting leaves an empty file behind instead of removing it. |
| `fs.del()` (`fs_core.js`) | Same mis-detection when capturing previous content. |
| `ui_layout.js` Save-As collision check, `docx_export.js` template check | False "already exists" or "found" results. |

### Fix
1. **`unpacked/js/webdav.js`**: add a server-checked stat on the base `WebDAVHandle` class, next to `_checkExists`:

   ```js
   // Server-checked kind of this handle's path: 'file', 'directory', or null if missing.
   // Needed because getFileHandle/getDirectoryHandle are lazy and never confirm existence.
   async _statKind() {
       const resp = await fetch(this.url + this.path, {
           method: 'PROPFIND',
           headers: { ...this.getHeaders(), 'Depth': '0' },
           cache: 'no-store'
       });
       if (resp.status === 404) return null;
       if (!resp.ok) throw new Error('WebDAV check failed: ' + resp.status);
       const text = await resp.text();
       return /<([a-z0-9_-]+:)?collection\b/i.test(text) ? 'directory' : 'file';
   }
   ```

2. **`unpacked/js/fs_core.js`, `fileExistsOnDisk`**: the file must exist **and be a file**:

   ```js
   const handle = await getHandleByPath(filePath);
   if (!handle) return false;
   if (handle.isWebDAV && typeof handle._statKind === 'function') {
       return (await handle._statKind()) === 'file';
   }
   return true;
   ```

3. **`unpacked/js/fs_core.js`, `workspaceDirExists`**: same idea for directories:

   ```js
   const h = await getDirectoryHandleByPath(dirPath, false);
   if (!h) return false;
   if (h.isWebDAV && typeof h._statKind === 'function') return (await h._statKind()) === 'directory';
   return true;
   ```

(Steps 1–3 were **applied in test copy**.)

### Optional hardening
- **Make the lazy getters honest.** `getFileHandle` and `getDirectoryHandle` could throw `NotFoundError` when `!opts.create` and `_statKind()` doesn't match. That fixes every caller at once, but costs one PROPFIND per path segment. Don't do it inside `entries()` iteration or the fast-tree path, where existence is already known. The targeted fix above is cheaper and is enough.
- **Stop swallowing errors in `readFileContent`.** It currently returns `""` on any error (including 404), so a missing file and an empty file look the same. Consider returning `undefined` on `NotFoundError` so callers can tell them apart. Audit callers first, because several rely on the `""` fallback.

### Acceptance (WebDAV workspace)
- `read("missing.txt")` → `ERROR: missing.txt not found`. An existing empty file still reads as empty.
- `write("brand_new.txt")`, then checkpoint revert → the file is **removed**, not emptied.
- `delete("some_dir")` without `recursive` → refused.

---

## B. Show hidden folders (except `.agent/`)

### Symptom
`write(".hidden_dir/inner.txt")` succeeds and `read` works, but `find`, `grep`, `edit` and `fileExists` can't see the file. This is the same pattern as 0.1, one level up: the 0.1 fix allowed dot-*files* but kept skipping dot-*directories*.

### Root cause
`shouldSkipScanEntry()` (`unpacked/js/modules/fs_utils.js`):

```js
if (isDir && name.startsWith('.') && fullPath !== CUSTOM_TOOLS_DIR) return true;
...
if (seg.startsWith('.') && !(i === 0 && seg === CUSTOM_TOOLS_DIR)) return true;
```

### Fix
1. **`fs_utils.js`, `shouldSkipScanEntry`**: drop both dot rules. Rely on `IGNORED_DIRS` for noise, on `isSecurityProtectedPath` for secrets, and on `shouldHideFromTools` / `isAgentPath` (unchanged) for `.agent/` tool access:

   ```js
   function shouldSkipScanEntry(name, fullPath, isDir = false) {
       if (IGNORED_DIRS.has(name)) return true;
       if (fullPath) {
           const parts = fullPath.split('/').filter(Boolean);
           for (let i = 0; i < parts.length - 1; i++) {
               if (IGNORED_DIRS.has(parts[i])) return true;
           }
       }
       return isSecurityProtectedPath(fullPath);
   }
   ```
   `.agent` keeps working as before. It was already scanned (it was the exception), and tool access to it is gated separately by `shouldHideFromTools()` and the `isAgentPath` checks in `TOOL_API_METHODS`. `refreshPathMeta()` and `isScanVisiblePath()` call this function, so they pick up the change automatically.

2. **`constants.js`, `IGNORED_DIRS`**: once dot-folders are visible, add the common heavy or noisy ones so they don't flood `find`/`grep`/snapshots:
   ```js
   const IGNORED_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__',
       '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'target', 'build', 'dist']);
   ```
   (Steps 1–2 **applied in test copy**.) Other candidates, at your discretion: `.cache`, `.idea`, `.next`, `.nuxt`, `.gradle`, `.terraform`, `.parcel-cache`. Leave out anything a user might actually want to edit, such as `.github` and `.vscode`. `.vscode/` is already blocked by the protected-path list anyway.

3. **`server.py`, fast-tree `IGNORED_DIR_NAMES`** (WebDAV listing): keep it in sync with `IGNORED_DIRS`, so the server doesn't walk folders the client will drop anyway. Today the server already skips `.venv` but not the cache folders. This is a performance change only; the client filter is the one that matters.

4. **Already exempt:** `prescanGitignoreFiles()` only skips `IGNORED_DIRS`, so `.gitignore` files inside dot-folders are already honoured. No change is needed there.

### Acceptance
- `write(".hidden_dir/a.txt")`, then `find`, `grep` and `edit` all see it, and it survives a sync.
- `.agent/*` is still refused by `read`/`write`/`find` unless "Show .agent files to tools" is on.
- `.env`, `.ssh/`, `.aws/` and `.git/` are still invisible.
- `.venv/` and `.pytest_cache/` don't appear in `find`.

---

## C. `fs.del()` can delete a directory without checkpointing its contents

### Symptom
The `delete("scratch")` call above removed a directory and returned `Deleted scratch`, the *file* message.

### Root cause
In `fs.del()` (`unpacked/js/fs_core.js`):

```js
const meta = registry.meta[path];
const isDir = !!(meta && meta.kind === 'directory');
```

If the directory has no meta entry, it's treated as a file:
- `affectedFiles = [path]`, so none of the children's content is captured for the checkpoint;
- `rawDelete` then removes the whole tree.

A directory can lack a meta entry because of a stale registry, a hidden dot-folder (B), or a WebDAV path. In any of those cases the result is a delete that **can't be reverted**.

`TOOL_API_METHODS.deleteFile` (`constants.js`) does work out `isDir` itself, but it relies on `fileExistsOnDisk` (bug A), and it doesn't pass the result on to `fs.del`.

### Fix
1. **`constants.js`, `deleteFile`**: after fix A the existing order (`fileExistsOnDisk`, then `workspaceDirExists`) detects directories correctly. Pass the result through:
   ```js
   const res = await window.fs.del(normFp, { mode: 'tool', sessionId, isDir });
   ```
2. **`fs_core.js`, `fs.del()`**: trust the hint, and when it's a directory, enumerate the children from disk, not only from `registry.meta`:
   ```js
   const isDir = opts.isDir === true || !!(meta && meta.kind === 'directory');
   ...
   if (isDir) {
       // from registry.meta as today, PLUS a disk walk via getDirectoryHandleByPath(path)
       // so children not yet in meta are still captured in prevByPath.
   }
   ```
   A small helper `listFilesUnderDir(path)` that walks the directory handle (skipping `IGNORED_DIRS`) is enough. `deleteFile` already has a similar walk (`findProtected`), so the two can share one helper.
3. **Defensive guard (optional):** in `fs.del()`, if `!isDir` but `affectedFiles` captured no content, and the path turns out to be a directory on disk, return an error instead of deleting.

### Acceptance
- Delete a folder that has no meta entry: without `recursive` it's refused. With `recursive` it's deleted, and checkpoint revert restores **every** file in it.
- The tool output reports the correct file count. Today it says `(0 files)` when the folder wasn't scanned.

---

## D. `map` fails when called in parallel

### Symptoms
Two `map` calls in one batch: one timed out after 120 s, the other failed with `Incompatible language version 14. Compatibility range 0 through 0.` The same calls run one at a time worked.

### Root cause
Tool workers are shared between parallel calls. In `unpacked/tools/map.js` the guard is `typeof globalThis.TreeSitter === 'undefined'`:
- Call 1 runs `importScripts(...)`, which defines `TreeSitter` immediately, and then `await TreeSitter.init()`.
- Call 2 sees that `TreeSitter` is defined, skips init, and calls `Language.load()` against a runtime that isn't initialised yet. That's where "range 0 through 0" comes from.
- The two calls then contend for the half-initialised module, and one of them hangs.

### Fix (**applied in test copy**)
Use a shared init promise and a ready flag instead of checking whether the global exists:

```js
if (hasAstFiles && globalThis.__mapTreeSitterInit) {
    try { await globalThis.__mapTreeSitterInit; } catch (_) { globalThis.__mapTreeSitterInit = null; }
}
if (hasAstFiles && !globalThis.__mapTreeSitterReady) {
    // ...show "Booting Tree-sitter" UI...
    try {
        globalThis.__mapTreeSitterInit = (async () => {
            if (typeof globalThis.TreeSitter === 'undefined') { /* importScripts or fetch+eval, as today */ }
            await globalThis.TreeSitter.init({ locateFile: /* as today */ });
            globalThis.__mapTreeSitterReady = true;
        })();
        await globalThis.__mapTreeSitterInit;
    } catch (err) {
        globalThis.__mapTreeSitterInit = null;   // allow a retry on the next call
        return { output: /* existing error */ };
    }
}
```

Apply the same pattern to the grammar cache. Today `languageCache[langName]` is only set after `await Language.load(url)`, so two parallel calls download the same grammar twice. Store the **promise** instead (`languageCache[lang] ??= TreeSitter.Language.load(url)`) and await it; on failure, delete the entry so a later call can retry. The js-yaml loader near line 120 has the same check-then-load shape and would benefit from the same treatment.

### Acceptance
Run three `map` calls in parallel on a cold worker (Python, JS, Python): all succeed, and the Tree-sitter runtime and each grammar are downloaded once.

---

## E. py_run deletion sync (4.3): deployment only

`jsutils/py_run.js` implements this correctly: the worker diffs `before` and `afterSet`, and `finish()` calls `api.deleteFile` when `syncDeletions` is on. But the py_run tool installed in the test session is an older copy: its description lacks "written to or deleted from", and an `os.remove()` did not remove the file from the workspace.

Two ways to deploy it:
- re-import `jsutils/py_run.js` into the tool registry (or the user's tools folder); or
- make the tool loader pick up `jsutils/` updates. `build_esbuild.py` doesn't reference `jsutils/`, so for unpacked serving this depends on how optional tools are installed.

**Small source follow-up:** `gatherWorkspace()` filters out `.agent`, `.ion`, `.git/` and `node_modules/` with its own string checks. After B, hidden folders get mounted into `/workspace` (that's intended). Consider also skipping the paths in `IGNORED_DIRS` here, for example via an `api` helper. That keeps a large `.venv` from being copied into Pyodide if it ever escapes the scan filter.

**Acceptance:** run `py_run` with `os.remove('/workspace/x.txt')` → output ends with `[files deleted: x.txt]`, the explorer drops the file, and checkpoint revert restores it.

---

## F. 5.2 run-tests skill

`load_skill("run-tests")` → "No skills found in .agent/skills/". Tools can't write inside `.agent`, so the user has to create `.agent/skills/run-tests/SKILL.md`. Suggested content:

````markdown
# run-tests
Run a Python project's pytest suite inside py_run (Pyodide).

1. Add the source roots to the path and install pure-Python dependencies:
   ```python
   import sys, micropip
   sys.path[:0] = ["/workspace/<project>", "/workspace/<project>/src"]
   await micropip.install(["pytest", "<pure-python deps, e.g. dateparser>"])
   ```
   (This needs py_run's allowNetwork setting turned on for micropip.)
2. Run the tests quietly and stop at the first failure:
   ```python
   import pytest
   rc = pytest.main(["-q", "-x", "-p", "no:cacheprovider", "<tests path>"])
   print("EXIT", rc)
   ```
3. Report a short summary: passed/failed counts, and each failure's test id plus the last assertion line.
4. Skip modules that can't run in Pyodide (native deps, live services, subprocess, GPU).
   Keep a per-project skip list here, e.g. for qmdpy: test_onnx_live.py, test_live_connectivity.py, test_usearch.py.
````

`-p no:cacheprovider` stops `.pytest_cache` from being written back into the workspace.

---

## G. 5.3 running-notes convention

`unpacked/js/modules/prompt_modes.js` only mentions `{{planFile}}` in the PLAN prompt. Add one paragraph to the **code** prompt (and optionally the plan prompt):

> For multi-step work, keep a short running log in `{{planFile}}`: decisions made, findings, files touched, and open questions. Update it with `edit` as you go, so the context survives prompt compression. Keep it concise; it is notes, not a report.

This depends on 0.1, which works now. If the user has customised prompts under `.agent/prompts/`, those override the defaults, so add the paragraph there too.

---

## H. 2.1 change notice: verify

`workspace_changes.js` and the `task_runner.js` hook (`buildWorkspaceChangeNoticeForTurn`, `captureWorkspaceSnapshotForSession`) are present. The notice can't be triggered from inside a turn, so check it by hand:

1. Send a message, so the end-of-run snapshot is taken.
2. Between turns: edit a file in an external editor, leave an unsaved Monaco edit in another file, create one file, and delete one file.
3. Send the next message and ask the model to quote the `[Workspace changes …]` block. Expect `modified (on disk)`, `unsaved`, `added` and `deleted`, with none of the model's own previous writes.
4. Send another message with no changes: nothing should be appended.
5. After B, a change inside a dot-folder (e.g. `.github/workflows/ci.yml`) should show up. A change under `.agent/` should **not** show up unless "Show .agent files to tools" is on.

---

## Re-test checklist after implementing

1. `read("missing.txt")` → not-found error (WebDAV **and** local folder).
2. `write(".hidden_dir/a.txt")`, then `find` / `grep` / `edit` it, then sync → it's still visible.
3. `write(".agent/x")` → refused. `.env` → refused.
4. `delete(".hidden_dir")` → refused. Then `delete(".hidden_dir", recursive: true)`, then checkpoint revert → contents restored.
5. `write("new.txt")`, then revert → the file is gone, not empty.
6. Three parallel `map` calls on a cold worker → all succeed.
7. `py_run` with `os.remove` → `[files deleted: …]`.
8. `load_skill("run-tests")` → loads.
9. The change-notice scenario in H.
