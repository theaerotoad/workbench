const state = {
    mode: 'code',
    messages: [],
    promptHistory: [],
    historyIdx: -1,
    promptDirty: false,
    activeController: null,
    isRunning: false,
    retryStatusActive: false,
    isSaving: false,
    openTabs: ['chat'],
    activeTab: 'chat',
    currentEditorPath: null,
    currentDiffFilepath: null,
    diffSideBySide: true,
    isEditorDirty: false,
    dirtyFiles: new Set(),
    suppressDirtyTracking: false,
    editorViewMode: 'edit',
    attachedReferences: [],
    preEditAttachedReferences: null,
    attachmentStore: {},
    activeSessionId: 'sess_' + Math.random().toString(36).substring(2, 9),
    sessions: {},
    modifiedFiles: new Set(),
    linesAdded: 0,
    linesRemoved: 0,
    lastTokenUsage: null,
    expandedFolders: new Set(),
    selectedContextItem: null,
    userScrolledUp: false,
    checkpointModalFile: null,
    checkpointModalMode: 'file',
    sessionIds: null,
    sessionMeta: null,
    _lastSavedIndex: null,
    queuedPrompts: {}
};

let _cp1252Rev = null;
const _crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
let _gutterDecorationIds = [];
let _gutterDiffEditor = null;
let _gutterDiffHost = null;
let _gutterDiffTimer = null;
let _lastAutoSync = Date.now();
let _lastTermScrollTop = 0;
let _mmSelectedIdx = 0;
let _modelPickerState = { visible: false, targetLine: null, targetColumn: null, editorOffset: null, modelName: '', modelInfo: null, apiModels: [], loading: false, error: null, filter: '', selectedIdx: 0 };
let _modelPickerWidget = null;
let _modelSelectState = { visible: false, filter: '', selectedIdx: 0 };
const _modelsEndpointCache = {};
let _pendingDeleteMsgId = null;
let _pendingEditMsgId = null;
let _pendingEditRevertIds = [];
let _pendingEditRevert = false;
let _pendingEditText = null;
let _permCtrlDown = false;
let _permHoverBtn = null;
let _railRaf = null;
let _railWrapCount = -1;
let _settleRaf = 0;
let _sharedToolErrorTip = null;
let _spPressOrigin = null;
const _toolModelPicker = { el: null, overlay: null, search: null, list: null, anchor: null, current: '', onPick: null, filter: '', idx: 0, visible: false };

let accentSwatchesBuilt = false;
let acMatches = [];
let acSelectedIdx = 0;
let attachmentIdCounter = 0;
let currentPendingTool = null;
const deletedSessionIds = new Set();
let dynamicModes = [];
let explorerAnchor = null;
let explorerDeleteBusy = false;
let explorerSelectionCleared = false;
const explorerSelection = new Set();
let fIdx = 0;
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let githubLocalShaCache = new Map();
const gitignoreCache = new Map();
const graphBadgeLabelMap = { baseline: 'Baseline', checkpoint: 'Edit', mixed: 'Edit', delete: 'Deleted', 'rename-in': 'Renamed in', 'rename-out': 'Renamed out', mkdir: 'New directory', current: 'Current' };
let imgPanX = 0;
let imgPanY = 0;
let imgZoom = 1;
let isSidebarCollapsed = false;
let jumpBtn = null;
let monacoDiffEditor = null;
let monacoEditor = null;
let monacoModels = new Map();
let newToolActivePane = 'blank';
let newToolBrowseFetchedAt = 0;
let newToolBrowseFiles = null;
let newToolBrowseSelected = null;
let newToolDroppedSource = null;
let newToolNameAutoFilled = false;
let pastedImageCounter = 0;
let pastedTextCounter = 0;
let pendingUIQueue = [];
let permQueue = [];
let programmaticScroll = false;
let promptRailTicks = [];
const railObserver = new MutationObserver(() => {
    if (_railRaf) return;
    _railRaf = requestAnimationFrame(() => {
        _railRaf = null;
        const count = document.getElementById('chat')?.querySelectorAll('.chat-prompt-wrap').length || 0;
        if (count !== _railWrapCount) {
            _railWrapCount = count;
            window.rebuildPromptRailTicks?.();
        }
        window.updatePromptRail?.();
    });
});
const registry = { files: {}, meta: {}, originalFiles: {}, opsLog: {}, compressionHistory: [], treeRoot: { name: "", path: "", kind: "directory", children: {} } };
let resizing = false;
let rootHandle = null;
let savedSidebarWidth = null;
let searchDebounceTimer = null;
let sessionRunTickInterval = null;
const sniffCache = new Map();
let syncQueuedJob = null;
let syncWorkspaceChain = Promise.resolve();
let toolRegistry = {};
let toolWorkerIframe = null;
let toolWorker = null;
const toolWorkerOutbox = [];
const toolWorkerPending = new Map();
let toolWorkerReady = false;
let toolWorkerRunId = 0;
let wsMutationEpoch = 0;
let wsUploadTargetDir = '';

window.accentSwatchesBuilt = accentSwatchesBuilt;
window.acMatches = acMatches;
window.acSelectedIdx = acSelectedIdx;
window.attachmentIdCounter = attachmentIdCounter;
window.currentPendingTool = currentPendingTool;
window.deletedSessionIds = deletedSessionIds;
window.dynamicModes = dynamicModes;
window.explorerAnchor = explorerAnchor;
window.explorerDeleteBusy = explorerDeleteBusy;
window.explorerSelectionCleared = explorerSelectionCleared;
window.explorerSelection = explorerSelection;
window.fIdx = fIdx;
window.frames = frames;
window.githubLocalShaCache = githubLocalShaCache;
window.gitignoreCache = gitignoreCache;
window.graphBadgeLabelMap = graphBadgeLabelMap;
window.imgPanX = imgPanX;
window.imgPanY = imgPanY;
window.imgZoom = imgZoom;
window.isSidebarCollapsed = isSidebarCollapsed;
window.jumpBtn = jumpBtn;
window.monacoDiffEditor = monacoDiffEditor;
window.monacoEditor = monacoEditor;
window.monacoModels = monacoModels;
window.newToolActivePane = newToolActivePane;
window.newToolBrowseFetchedAt = newToolBrowseFetchedAt;
window.newToolBrowseFiles = newToolBrowseFiles;
window.newToolBrowseSelected = newToolBrowseSelected;
window.newToolDroppedSource = newToolDroppedSource;
window.newToolNameAutoFilled = newToolNameAutoFilled;
window.pastedImageCounter = pastedImageCounter;
window.pastedTextCounter = pastedTextCounter;
window.pendingUIQueue = pendingUIQueue;
window.permQueue = permQueue;
window.programmaticScroll = programmaticScroll;
window.promptRailTicks = promptRailTicks;
window.railObserver = railObserver;
window.registry = registry;
window.resizing = resizing;
window.rootHandle = rootHandle;
window.savedSidebarWidth = savedSidebarWidth;
window.searchDebounceTimer = searchDebounceTimer;
window.sessionRunTickInterval = sessionRunTickInterval;
window.sniffCache = sniffCache;
window.syncQueuedJob = syncQueuedJob;
window.syncWorkspaceChain = syncWorkspaceChain;
window.toolRegistry = toolRegistry;
window.toolWorkerIframe = toolWorkerIframe;
window.toolWorker = toolWorker;
window.toolWorkerOutbox = toolWorkerOutbox;
window.toolWorkerPending = toolWorkerPending;
window.toolWorkerReady = toolWorkerReady;
window.toolWorkerRunId = toolWorkerRunId;
window.wsMutationEpoch = wsMutationEpoch;
window.wsUploadTargetDir = wsUploadTargetDir;

export {
    state, _cp1252Rev, _crcTable, _gutterDecorationIds, _gutterDiffEditor, _gutterDiffHost, _gutterDiffTimer, _lastAutoSync, _lastTermScrollTop, _mmSelectedIdx, _modelPickerState, _modelPickerWidget, _modelSelectState, _modelsEndpointCache, _pendingDeleteMsgId, _pendingEditMsgId, _pendingEditRevertIds, _pendingEditRevert, _pendingEditText, _permCtrlDown, _permHoverBtn, _railRaf, _railWrapCount, _settleRaf, _sharedToolErrorTip, _spPressOrigin, _toolModelPicker, accentSwatchesBuilt, acMatches, acSelectedIdx, attachmentIdCounter, currentPendingTool, deletedSessionIds, dynamicModes, explorerAnchor, explorerDeleteBusy, explorerSelectionCleared, explorerSelection, fIdx, frames, githubLocalShaCache, gitignoreCache, graphBadgeLabelMap, imgPanX, imgPanY, imgZoom, isSidebarCollapsed, jumpBtn, monacoDiffEditor, monacoEditor, monacoModels, newToolActivePane, newToolBrowseFetchedAt, newToolBrowseFiles, newToolBrowseSelected, newToolDroppedSource, newToolNameAutoFilled, pastedImageCounter, pastedTextCounter, pendingUIQueue, permQueue, programmaticScroll, promptRailTicks, railObserver, registry, resizing, rootHandle, savedSidebarWidth, searchDebounceTimer, sessionRunTickInterval, sniffCache, syncQueuedJob, syncWorkspaceChain, toolRegistry, toolWorkerIframe, toolWorker, toolWorkerOutbox, toolWorkerPending, toolWorkerReady, toolWorkerRunId, wsMutationEpoch, wsUploadTargetDir
};

window.state = state;
window._cp1252Rev = _cp1252Rev;
window._crcTable = _crcTable;
window._gutterDecorationIds = _gutterDecorationIds;
window._gutterDiffEditor = _gutterDiffEditor;
window._gutterDiffHost = _gutterDiffHost;
window._gutterDiffTimer = _gutterDiffTimer;
window._lastAutoSync = _lastAutoSync;
window._lastTermScrollTop = _lastTermScrollTop;
window._mmSelectedIdx = _mmSelectedIdx;
window._modelPickerState = _modelPickerState;
window._modelPickerWidget = _modelPickerWidget;
window._modelSelectState = _modelSelectState;
window._modelsEndpointCache = _modelsEndpointCache;
window._pendingDeleteMsgId = _pendingDeleteMsgId;
window._pendingEditMsgId = _pendingEditMsgId;
window._pendingEditRevertIds = _pendingEditRevertIds;
window._pendingEditRevert = _pendingEditRevert;
window._pendingEditText = _pendingEditText;
window._permCtrlDown = _permCtrlDown;
window._permHoverBtn = _permHoverBtn;
window._railRaf = _railRaf;
window._railWrapCount = _railWrapCount;
window._settleRaf = _settleRaf;
window._sharedToolErrorTip = _sharedToolErrorTip;
window._spPressOrigin = _spPressOrigin;
window._toolModelPicker = _toolModelPicker;