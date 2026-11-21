# Architecture & Implementation Plan: Per-Workspace Tool Isolation via `.agent/tools.json`

## Executive Summary

### The Problem
Currently, tool files, permission settings (`never`, `ask`, `always`), lock states, and custom tool parameters are saved globally in `localStorage` under un-scoped keys (`tool_files_json`, `tool_perm_state`, `tool_lock_state`, `tool_settings_state`). When a user creates or connects to a new workspace (particularly WebDAV or virtual workspaces), `syncAgentFilesWithWorkspace` attempts to synchronize tools. If the workspace does not have `.agent/tools`, the system resurrects all custom tools from the global `localStorage` cache and writes them to the new workspace. Furthermore, in-memory tool definitions in `window.toolRegistry` are never purged upon closing a workspace, causing tools, tool configurations, and model assignments to leak across unrelated projects.

### The Objective
Migrate tool storage, configuration, permissions, and lock states to a workspace-scoped manifest file: `.agent/tools.json`. This mirrors the architecture already established for `.agent/config.json` and `.agent/models.json`:
1. Tool permissions, settings, and installed custom tools become local to each workspace.
2. New workspaces start clean with only built-in tools.
3. Existing workspaces without `tools.json` gracefully degrade by discovering any existing `.agent/tools/*.js` files and generating a default `tools.json`.
4. Workspaces where disk sync is disabled (e.g. WebDAV with `webdav-sync-agent: false`) isolate settings in workspace-keyed `localStorage` (`tools_json_${wsKey}`).
5. `.agent/tools.json` is exposed as a virtual file in the file explorer and Monaco editor for direct inspection and configuration.

---

## Specification: `.agent/tools.json` Schema

The `.agent/tools.json` file serves as the single source of truth for all tool configurations within a workspace:

```json
{
  "version": 1,
  "permissions": {
    "read": "always",
    "edit": "ask",
    "write": "ask",
    "grep": "always",
    "find": "always",
    "rename": "ask",
    "preview_image": "always",
    "load_skill": "always",
    "my_custom_tool": "ask"
  },
  "locks": {
    "edit": false,
    "write": false,
    "my_custom_tool": false
  },
  "models": {
    "my_custom_tool": "uuid-or-provider-model-id"
  },
  "settings": {
    "my_custom_tool": {
      "accentColor": "#4f8cff",
      "timeout": 30
    }
  },
  "customTools": [
    {
      "name": "my_custom_tool",
      "file": ".agent/tools/my_custom_tool.js",
      "enabled": true
    }
  ]
}

```

### Schema Properties

* **`version`** (`number`): Schema version for future migrations.
* **`permissions`** (`Record<string, 'never' | 'ask' | 'always'>`): Execution permissions for built-in and custom tools.
* **`locks`** (`Record<string, boolean>`): Lock toggles preventing tool execution.
* **`models`** (`Record<string, string>`): Dedicated model mappings for tools that support secondary model execution.
* **`settings`** (`Record<string, Record<string, any>>`): Custom user-defined parameter values declared in `TOOL_META.settings`.
* **`customTools`** (`Array<{ name: string, file: string, enabled: boolean }>`): Registry of workspace-specific custom tools.

---

## Implementation Roadmap

The implementation is divided into four self-contained phases.

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Constants, Virtual File & Storage Foundation   │
│ - TOOLS_FILE constant & default config helpers         │
│ - Virtual file registration & Monaco integration       │
│ - Workspace-scoped storage fallback helpers            │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 2: Registry Scoping & Tool Lifecycle Refactor     │
│ - Purge & rehydrate toolRegistry per workspace         │
│ - Workspace-isolated custom tool loader               │
│ - Graceful migration for legacy workspaces             │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 3: Scoping Permissions, Locks & UI Settings      │
│ - Refactor tools_permissions.js to use tools.json      │
│ - Refactor tools_ui.js to mutate tools.json            │
│ - Real-time sync between UI switches and manifest      │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 4: Lifecycle Orchestration & Data Sanitation     │
│ - closeWorkspace teardown & setWorkspace hydration     │
│ - syncAgentFilesWithWorkspace rewrite for tools        │
│ - Clear Data modal & legacy migration cleanup          │
└────────────────────────────────────────────────────────┘

```

---

### Phase 1: Constants, Virtual File & Storage Foundation

#### Goal

Establish `.agent/tools.json` as a first-class agent configuration entity alongside `config.json` and `models.json`.

#### Why

The system needs standardized paths, default states, serialization functions, and virtual filesystem hooks before modules can read/write workspace tool configurations.

#### Modifications Needed

1. **`unpacked/js/constants.js`**
* **Define Path Constant**:
```javascript
const TOOLS_FILE = '.agent/tools.json';

```


* **Define Default Tool Configuration Generator**:
Create `toolsDefaults()` returning the default structure:
* Built-in tools permissions (`read`, `grep`, `find`, `preview_image`, `load_skill` -> `'always'`; `edit`, `write`, `rename` -> `'ask'`).
* Built-in locks set to `false`.
* Empty maps for `models`, `settings`, and `customTools`.


* **Update Virtual Files List**:
Add `TOOLS_FILE` to `VIRTUAL_AGENT_FILES`:
```javascript
const VIRTUAL_AGENT_FILES = [MODELS_FILE, CONFIG_FILE, TOOLS_FILE];

```


* **Add File Icon Mapping**:
Ensure `tools.json` displays an appropriate configuration icon in the explorer.
* **Export New Entities**:
Export `TOOLS_FILE` and `toolsDefaults` via window and ES module exports.


2. **`unpacked/js/modules/fs_utils.js`**
* **Update Sensitive / Special File Guards**:
* In `isSensitiveUserFile(path)`: Include `TOOLS_FILE`.
* In `isVirtualAgentFile(path)`: Include `TOOLS_FILE`.
* In `refreshPathMeta(fp)`: Add `TOOLS_FILE` to the bypassed virtual paths so it is not dropped during disk reconciliations.




3. **`unpacked/js/modules/ui_dialogs.js`**
* **Add Virtual File Register**:
Create `registerToolsVirtualFile()`:
* Reads current in-memory workspace tools manifest.
* Registers `registry.files[TOOLS_FILE] = JSON.stringify(data, null, 2)`.
* Sets `registry.meta[TOOLS_FILE] = { kind: 'file', size: text.length, isBinary: false, virtual: true }`.





---

### Phase 2: Tool Registry & Custom Tool Lifecycle Refactoring

#### Goal

Ensure `window.toolRegistry` is strictly isolated to the open workspace, loading only built-in tools and tools registered in `.agent/tools.json` (or present in `.agent/tools/`).

#### Why

Currently, custom tools are aggregated into a single global `filesMap` in `localStorage.getItem('tool_files_json')`. If Workspace A installs `py_run.js`, switching to Workspace B still sees `py_run.js` in memory and on disk.

#### Modifications Needed

1. **`unpacked/js/modules/tools_registry.js`**
* **State Architecture**:
* Introduce a module-level variable `activeWorkspaceToolsConfig` that holds the parsed `tools.json` content for the active workspace.
* Provide `getWorkspaceToolsConfig()` and `setWorkspaceToolsConfig(cfg)`.


* **Registry Reset Function**:
* Implement `resetToolRegistry()`:
* Empties `toolRegistry`.
* Re-seeds only `BUILTIN_TOOL_NAMES` by calling `seedBuiltinToolSources()`.
* Clears out any custom tool entries from `toolRegistry`.




* **Workspace-Scoped Storage Helpers**:
* Create `loadWorkspaceToolsState(wsKey)` and `saveWorkspaceToolsState(wsKey, config)`.
* If `rootHandle` is available and disk sync is active, read/write directly via `readFileContent(TOOLS_FILE)` and `writeAgentFileToDisk(TOOLS_FILE, content)`.
* If WebDAV sync is disabled, fall back to `localStorage.getItem('tools_config_' + wsKey)`.
* **Eliminate** reliance on flat `tool_files_json` for cross-workspace persistence.


* **Graceful Migration for Legacy Workspaces**:
* Implement `reconcileWorkspaceTools(diskToolsDirHandle)`:
* **Case A: `.agent/tools.json` exists**: Load it, validate against schema, merge any new `.js` files found in `.agent/tools/` into `customTools`.
* **Case B: `.agent/tools.json` missing, but `.agent/tools/` has `.js` files**:
* Read each `.js` file, extract `TOOL_META`.
* Generate a new `tools.json` manifest registering these custom tools with default permissions.
* Write `.agent/tools.json` to disk/storage.


* **Case C: Fresh workspace (no `.agent/tools.json` and no `.agent/tools/)**:
* Initialize clean default configuration with only built-ins.
* Do NOT import tools from other workspaces.






* **Custom Tool Creation & Deletion**:
* When `createToolFile(name, source)` runs:
* Write `.agent/tools/${name}.js`.
* Update `activeWorkspaceToolsConfig.customTools` with `{ name, file: `.agent/tools/${name}.js`, enabled: true }`.
* Persist updated `tools.json`.


* When `deleteToolFile(name)` runs:
* Remove `.agent/tools/${name}.js`.
* Remove entry from `activeWorkspaceToolsConfig.customTools`, `permissions`, `locks`, and `settings`.
* Persist updated `tools.json`.







---

### Phase 3: Scoping Permissions, Locks, and Tool Settings

#### Goal

Decouple permissions, locks, and tool settings from global `localStorage` keys and bind them directly to the active workspace's `tools.json`.

#### Why

Changing a tool's permission to `always` or changing a tool's parameter (e.g. `timeout` or `accentColor`) in one workspace should not alter tool permissions or arguments in another workspace.

#### Modifications Needed

1. **`unpacked/js/modules/tools_permissions.js`**
* **Refactor State Loaders**:
* Update `loadToolPermState()`: Read from `activeWorkspaceToolsConfig.permissions`. Fallback to built-in defaults.
* Update `saveToolPermState(state)`: Mutate `activeWorkspaceToolsConfig.permissions`, persist `tools.json`, and update the virtual file.
* Update `loadToolLockState()`: Read from `activeWorkspaceToolsConfig.locks`.
* Update `saveToolLockState(state)`: Mutate `activeWorkspaceToolsConfig.locks`, persist `tools.json`.


* **Model Assignment**:
* In `_tmpPick(entry)` and `setToolModelBtnLabel`: Save selected model UUID to `activeWorkspaceToolsConfig.models[toolName]`.
* In `checkPermission(toolName, ...)`: Resolve model and permission against the workspace config.




2. **`unpacked/js/modules/tools_ui.js`**
* **Refactor Setting State Loaders**:
* Update `loadToolSettingsState()`: Read from `activeWorkspaceToolsConfig.settings`.
* Update `saveToolSettingsState(state)`: Mutate `activeWorkspaceToolsConfig.settings`, persist `tools.json`.
* In `getToolSettingValue(toolName, key)`: Read from `activeWorkspaceToolsConfig.settings?.[toolName]?.[key]` with fallback to default from `TOOL_META.settings`.
* In `setToolSettingValue(toolName, key, val)`: Store into `activeWorkspaceToolsConfig.settings[toolName][key]` and save.


* **Render Updates**:
* Ensure `renderToolsList()` renders tool rows based on tools active in the workspace configuration, displaying built-in tools first followed by active custom tools.





---

### Phase 4: Lifecycle Orchestration & Data Sanitation

#### Goal

Integrate tool loading and teardown cleanly into `setWorkspace()` and `closeWorkspace()`, ensuring seamless transitions between different WebDAV mounts, local directories, and virtual workspaces.

#### Why

Without clean lifecycle hooks, closing a workspace leaves stale tools registered in memory, while opening a workspace risks running tool operations before the workspace manifest has finished loading.

#### Modifications Needed

1. **`unpacked/js/modules/workspace_core.js`**
* **`closeWorkspace()` Integration**:
* Call `resetToolRegistry()` immediately when closing a workspace.
* Clear in-memory `activeWorkspaceToolsConfig`.
* Re-register virtual files for tools.


* **`syncAgentFilesWithWorkspace()` Rewrite**:
* Check for `.agent/tools.json`.
* If disk sync is active (`!isWebDAV || webdav-sync-agent === 'true'`):
* Check if `.agent/tools.json` exists on disk via `readFileContent(TOOLS_FILE)`.
* If found: parse and set as `activeWorkspaceToolsConfig`.
* If missing: call `reconcileWorkspaceTools()` to auto-discover existing `.agent/tools/*.js` or generate a clean default manifest.
* Load each `.js` listed in `activeWorkspaceToolsConfig.customTools` from disk into `toolRegistry`.


* If disk sync is inactive:
* Read from `localStorage.getItem('tools_json_' + wsStorageName(rootHandle))`.
* If empty, initialize defaults.
* Load custom tool sources from workspace-scoped storage.


* Register virtual file: `registerToolsVirtualFile()`.


* **`setWorkspace(handle)` Integration**:
* Ensure `resetToolRegistry()` runs before syncing.
* After `syncAgentFilesWithWorkspace()`, call `renderToolsList()` and `refreshPermBanner()`.




2. **`unpacked/js/modules/ui_dialogs.js`**
* **Clear Data Modal Update**:
* Update `clearSelectedData(opts)`:
* When `customTools` is selected for clearing:
* Wipe workspace-scoped tool entries (`tools_json_*`, `tool_files_*`).
* Reset current workspace's `tools.json` to `toolsDefaults()`.
* Reset `toolRegistry` to built-ins only.









---

## Detailed Step-by-Step Task Breakdown

| Step | Target File | Action | Description |
| --- | --- | --- | --- |
| **1.1** | `unpacked/js/constants.js` | Update | Add `TOOLS_FILE = '.agent/tools.json'`, `toolsDefaults()` template, and append to `VIRTUAL_AGENT_FILES`. |
| **1.2** | `unpacked/js/modules/fs_utils.js` | Update | Add `TOOLS_FILE` to `isSensitiveUserFile`, `isVirtualAgentFile`, and `refreshPathMeta`. |
| **2.1** | `unpacked/js/modules/tools_registry.js` | Update | Add `activeWorkspaceToolsConfig`, `resetToolRegistry()`, `getWorkspaceToolsConfig()`, and `setWorkspaceToolsConfig()`. |
| **2.2** | `unpacked/js/modules/tools_registry.js` | Update | Rewrite `loadToolFilesState()` and `saveToolFilesState()` to scope by `wsKey`. |
| **2.3** | `unpacked/js/modules/tools_registry.js` | Update | Implement `reconcileWorkspaceTools()` for graceful degradation (scan `.agent/tools/*.js` if no `tools.json`). |
| **3.1** | `unpacked/js/modules/tools_permissions.js` | Update | Bind `loadToolPermState`, `saveToolPermState`, locks, and tool models to `activeWorkspaceToolsConfig`. |
| **3.2** | `unpacked/js/modules/tools_ui.js` | Update | Bind `loadToolSettingsState`, `saveToolSettingsState`, `getToolSettingValue`, and `setToolSettingValue` to `activeWorkspaceToolsConfig`. |
| **4.1** | `unpacked/js/modules/workspace_core.js` | Update | Update `closeWorkspace()` to invoke `resetToolRegistry()` and clear tool configs. |
| **4.2** | `unpacked/js/modules/workspace_core.js` | Update | Refactor `syncAgentFilesWithWorkspace()` to load/generate `tools.json` and avoid leaking global custom tools. |
| **4.3** | `unpacked/js/modules/ui_dialogs.js` | Update | Implement `registerToolsVirtualFile()` and update `clearSelectedData()` for scoped tool storage. |

---

## Verification & Validation Plan

### Scenario 1: Fresh WebDAV Workspace Creation

1. Set up a brand new WebDAV directory `/dav-empty/` with no files.
2. In the UI, connect to this WebDAV instance.
3. Open Settings > Tools:
* **Expected**: Only the 8 built-in tools are visible (`read`, `edit`, `write`, `grep`, `find`, `rename`, `preview_image`, `load_skill`).
* **Expected**: No custom tools from any previous workspaces are present.
* **Expected**: In the file tree under `.agent/`, `tools.json` exists with default permissions and an empty `customTools` array.



### Scenario 2: Legacy Workspace Migration

1. Set up a WebDAV directory `/dav-legacy/` that contains `.agent/tools/calculator.js`, but has no `.agent/tools.json`.
2. Connect to `/dav-legacy/`.
3. **Expected**: System discovers `calculator.js`, parses its `TOOL_META`, automatically synthesizes `.agent/tools.json` containing `calculator` in `customTools`, and registers it in `toolRegistry`.
4. **Expected**: `calculator` appears in Settings > Tools and is executable.

### Scenario 3: Cross-Workspace Custom Tool Isolation

1. Open Workspace A: Create a custom tool `workspace_a_tool.js`. Set permission to `always`.
2. Switch to Workspace B (different WebDAV path or virtual workspace).
3. **Expected**: `workspace_a_tool.js` is NOT present in Workspace B's tree, tool list, or memory.
4. Switch back to Workspace A.
5. **Expected**: `workspace_a_tool.js` is present and its permission remains `always`.

### Scenario 4: Setting & Permission Customization Isolation

1. In Workspace A: Change built-in tool `write` permission to `never`. Lock tool `edit`.
2. In Workspace B: Keep `write` as `ask` and `edit` unlocked.
3. Toggle between Workspace A and Workspace B:
* **Expected**: Workspace A always reflects `write: never` and `edit: locked`.
* **Expected**: Workspace B always reflects `write: ask` and `edit: unlocked`.
* **Expected**: Neither workspace overwrites the other.
