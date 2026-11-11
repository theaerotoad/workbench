import '../js/constants.js';
import '../js/state_manager.js';
import '../js/dom.js';
import * as FS from '../js/fs_core.js';
import './modules/fs_utils.js';
import './modules/sessions_core.js';
import './modules/sessions_storage.js';
import './modules/checkpoints_core.js';
import './modules/checkpoints_ui.js';
import './modules/tools_registry.js';
import './modules/tools_permissions.js';
import './modules/tools_ui.js';
import './modules/workspace_core.js';
import './modules/workspace_explorer.js';
import './modules/workspace_transfer.js';
import './modules/prompt_modes.js';
import './modules/prompt_compression.js';
import './modules/ui_dialogs.js';
import './modules/ui_layout.js';
import './modules/task_runner.js';
import './modules/chat_render.js';
import './modules/chat_tool_boxes.js';
import './modules/chat_terminal.js';
import './modules/chat_input.js';
import './modules/chat_models.js';

import '../js/db.js';
import '../js/monaco.js';
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
            // Save As; ignore while a dialog (including Save As itself) is already open.
            if (document.getElementById('yesno-modal-overlay').style.display !== 'flex') saveFileAs();
            return false;
        }
        if (state.activeTab && state.activeTab.startsWith('filediff:')) {
            saveDiffModifiedFile();
        } else if (state.activeTab && state.activeTab !== 'chat') {
            saveEditorFile();
        }
        return false;
    }
}, true);

window.openFileDiff = (filepath) => {
    const tabId = `filediff:${filepath}`;
    if (!state.openTabs.includes(tabId)) state.openTabs.push(tabId);
    switchTab(tabId);
};

window.openCheckpointDiff = (filepath, fromIdx, toIdx) => {
    const tabId = `filediff:${filepath}::${fromIdx}::${toIdx}`;
    if (!state.openTabs.includes(tabId)) state.openTabs.push(tabId);
    switchTab(tabId);
};

window.revertFileToCheckpoint = async (filepath, timelineIndex) => {
    const timeline = getFileTimeline(filepath);
    const target = timeline[timelineIndex];
    if (!target) {
        showToast('Checkpoint not found', 'error');
        return;
    }
    if (target.kind === 'current') return;
    const labelMap = {
        baseline: 'the original baseline',
        checkpoint: `the checkpoint from ${new Date(target.ts).toLocaleString()}`,
        delete: 'the point where this file was deleted',
        'rename-in': `the point where ${target.op?.from || 'a file'} was renamed to this file`,
        'rename-out': `the point where this file was renamed to ${target.op?.to || 'a new name'}`,
        mkdir: 'the point where this directory was created',
    };
    const label = labelMap[target.kind] || `the checkpoint from ${new Date(target.ts).toLocaleString()}`;
    if (!await confirmDialog(`Revert ${filepath} to ${label}? Later changes will be discarded.`, { confirmLabel: 'Revert', danger: true })) return;
    try {
        // Truncate the op log: keep only ops strictly before this entry.
        const ops = registry.opsLog[filepath] || [];
        const kept = [];
        for (const op of ops) {
            if (op.ts === target.ts) break;
            kept.push(op);
        }
        registry.opsLog[filepath] = kept;
        // Build a kind-appropriate action for this single file.
        let action;
        if (target.kind === 'delete') {
            action = { kind: 'delete', filepath };
        } else if (target.kind === 'rename-out') {
            // The path no longer exists at this point (renamed away), so revert deletes it.
            action = { kind: 'delete', filepath };
        } else if (target.kind === 'rename-in' || target.kind === 'mkdir') {
            // Structural checkpoint: the log truncation already reflects the state.
            action = null;
        } else if (target.kind === 'baseline') {
            const original = registry.originalFiles[filepath];
            action = (original === undefined)
                ? { kind: 'delete', filepath }
                : { kind: 'restore', filepath, content: target.content };
        } else {
            action = { kind: 'restore', filepath, content: target.content };
        }
        if (action) {
            await executeRevertPlan([action], {});
        } else {
            // Defensive no-action path (rename-in / mkdir): just refresh state from the truncated log.
            recomputeAllModifiedFromOps();
            await recomputeLineStats(sessionCtx(state.activeSessionId), state.activeSessionId);
            await persistCheckpoint();
            renderChangesPanel(); renderExplorerTree(); updateStatusInfo();
            refreshChangesGraph();
            if (state.currentDiffFilepath === filepath) renderFileDiffView(filepath);
        }
    } catch(e) {
        showToast(`Revert error: ${e.message}`, 'error');
    }
};

window.revertToBeforePrompt = async (promptId, promptLabel, opts) => {
    // Like `git reset --hard`: drops this prompt and every later one. Accepts one id or an array.
    const idSet = new Set(Array.isArray(promptId) ? promptId : [promptId]);
    const files = getAllTrackedFiles();
    // The earliest matching op timestamp is the cut point.
    let cutTs = Infinity;
    let cutFound = false;
    for (const filepath of files) {
        const timeline = getFileTimeline(filepath);
        for (const entry of timeline) {
            if (entry.kind === 'baseline') continue;
            if (entry.prompt && idSet.has(entry.prompt.id)) {
                const ts = entry.ts || 0;
                if (ts < cutTs) cutTs = ts;
                cutFound = true;
            }
        }
    }
    if (!cutFound) return;
    // Forget every prompt at or after the cut, not just the named one.
    const forgetIds = new Set();
    for (const filepath of files) {
        const timeline = getFileTimeline(filepath);
        for (const entry of timeline) {
            if (entry.kind === 'baseline') continue;
            if ((entry.ts || 0) >= cutTs && entry.prompt && entry.prompt.id) {
                forgetIds.add(entry.prompt.id);
            }
        }
    }
    // Replay only ops before the cut from the baseline to get each file's pre-cut state.
    const actions = [];
    for (const filepath of files) {
        const timeline = getFileTimeline(filepath);
        let present = false;
        let content = null;
        for (const entry of timeline) {
            if (entry.kind === 'baseline') { present = entry.content !== null; content = entry.content; continue; }
            if (entry.ts === null) continue;       // the synthetic 'current' entry
            if (entry.ts >= cutTs) break;          // first op at/after the cut
            if (entry.kind === 'delete') { present = false; content = null; }
            else if (entry.kind === 'rename-in' || entry.kind === 'rename-out') { present = true; }
            else if (entry.kind === 'checkpoint') { present = true; content = entry.content; }
        }
        // A rename after the cut means the pre-cut path differs; move the file back first.
        const renameIdx = timeline.findIndex(e => e.kind === 'rename-in' && (e.ts || 0) >= cutTs);
        let moveBackTo = null;
        if (renameIdx !== -1) {
            // The rename-in marker carries op.from — the pre-rename (pre-cut) path.
            moveBackTo = timeline[renameIdx].op && timeline[renameIdx].op.from ? timeline[renameIdx].op.from : null;
        }
        if (present) {
            const finalPath = moveBackTo || filepath;
            if (moveBackTo) actions.push({ kind: 'rename', filepath, targetPath: moveBackTo });
            actions.push({ kind: 'restore', filepath: finalPath, content });
        } else {
            actions.push({ kind: 'delete', filepath });
        }
    }
    // Renames run first so restored content lands at its final path.
    const renamed = actions.filter(a => a.kind === 'rename');
    const rest = actions.filter(a => a.kind !== 'rename');
    rest.sort((a, b) => (a.kind === 'restore' ? 0 : 1) - (b.kind === 'restore' ? 0 : 1));
    const finalActions = [...renamed, ...rest];
    if (actions.length === 0) return;
    const summary = actions.map(p => p.kind === 'delete' ? 'delete' : p.kind === 'rename' ? `rename ${p.filepath} → ${p.targetPath}` : `restore ${p.filepath}`).join(', ');
    const shortLabel = (promptLabel || 'this prompt').slice(0, 120) + (promptLabel && promptLabel.length > 120 ? '…' : '');
    if (!(opts && opts.skipConfirm) && !await confirmDialog(`Revert to right before "${shortLabel}"?\n\nThis will ${summary}. Later changes will be discarded.`, { confirmLabel: 'Revert', danger: true })) return;
    await executeRevertPlan(finalActions, { forgetPromptIds: Array.from(forgetIds) });
};

document.getElementById('graph-breadcrumb-back').addEventListener('click', () => window.showAllCheckpoints());

window.showAllCheckpoints = () => {
    state.checkpointModalFile = null;
    state.checkpointModalMode = 'all';
    graphBreadcrumb.classList.remove('visible');
    graphBreadcrumbFile.innerText = '';
    graphPanelLabel.style.display = '';
    renderAllPromptGroups();
};

window.showCheckpointTimeline = async (filepath) => {
    state.checkpointModalFile = filepath;
    state.checkpointModalMode = 'file';
    if (registry.files[filepath] === undefined) {
        await readFileContent(filepath);
    }
    activateSidebarView(tabNavChanges, viewChanges);
    graphPanelLabel.style.display = 'none';
    graphBreadcrumb.classList.add('visible');
    graphBreadcrumbFile.innerText = filepath;
    graphBreadcrumbFile.title = filepath;
    renderCheckpointTimeline(filepath);
};

window.discardFile = async (filepath) => {
    if (!await confirmDialog(`Discard all changes in ${filepath} and revert to session checkpoint?`, { confirmLabel: 'Discard', danger: true })) return;
    const original = registry.originalFiles[filepath];
    const actions = (original === undefined)
        ? [{ kind: 'delete', filepath }]
        : [{ kind: 'restore', filepath, content: original }];
    await executeRevertPlan(actions, { clearOpsFor: [filepath] });
    if (state.activeTab === `filediff:${filepath}`) closeTab(`filediff:${filepath}`);
};

window.restoreAllModifiedFiles = async () => {
    if (!state.modifiedFiles.size) return;
    if (!await confirmDialog(`Discard all changes across ${state.modifiedFiles.size} file(s)?`, { confirmLabel: 'Discard all', danger: true })) return;
    const files = Array.from(state.modifiedFiles);
    const actions = files.map(fp => {
        const original = registry.originalFiles[fp];
        return (original === undefined)
            ? { kind: 'delete', filepath: fp }
            : { kind: 'restore', filepath: fp, content: original };
    });
    await executeRevertPlan(actions, { clearOpsFor: files });
};

document.getElementById('btn-discard-all').addEventListener('click', () => window.restoreAllModifiedFiles());

btnDiffToggleInline.addEventListener('click', () => {
    state.diffSideBySide = !state.diffSideBySide;
    diffLayoutText.innerText = state.diffSideBySide ? 'Inline' : 'Side-by-Side';
    diffLayoutIcon.innerText = state.diffSideBySide ? 'view_stream' : 'splitscreen';
    btnDiffToggleInline.classList.toggle('active', !state.diffSideBySide);
    if (monacoDiffEditor) {
        monacoDiffEditor.updateOptions({ renderSideBySide: state.diffSideBySide });
    }
});

btnDiffNextHunk.addEventListener('click', () => {
    if (monacoDiffEditor && monacoDiffEditor.getLineChanges()?.length) {
        monacoDiffEditor.goToDiff('next');
    }
});

btnDiffPrevHunk.addEventListener('click', () => {
    if (monacoDiffEditor && monacoDiffEditor.getLineChanges()?.length) {
        monacoDiffEditor.goToDiff('previous');
    }
});

btnDiffSave.addEventListener('click', saveDiffModifiedFile);
btnDiffDiscard.addEventListener('click', () => {
    if (state.currentDiffFilepath) window.discardFile(state.currentDiffFilepath);
});

// Mouse wheel scrolls the tab strip horizontally
tabsListContainer.addEventListener('wheel', (e) => {
    if (e.deltaY && !e.deltaX && tabsListContainer.scrollWidth > tabsListContainer.clientWidth) {
        tabsListContainer.scrollLeft += e.deltaY;
        e.preventDefault();
    }
}, { passive: false });

tabsListContainer.addEventListener('scroll', () => {
    if (typeof updateTabsOverflowState === 'function') updateTabsOverflowState();
}, { passive: true });

if (typeof ResizeObserver !== 'undefined') {
    const _tabsResizeObs = new ResizeObserver(() => {
        if (typeof updateTabsOverflowState === 'function') updateTabsOverflowState();
    });
    _tabsResizeObs.observe(tabsListContainer);
}

window.addEventListener('resize', () => {
    if (typeof closeTabsOverflowMenu === 'function') closeTabsOverflowMenu();
    if (typeof updateTabsOverflowState === 'function') updateTabsOverflowState();
}, { passive: true });

if (btnTabsOverflow) {
    btnTabsOverflow.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof toggleTabsOverflowMenu === 'function') toggleTabsOverflowMenu();
    });
}

document.addEventListener('click', (e) => {
    if (!tabsOverflowMenu || tabsOverflowMenu.style.display !== 'block') return;
    if (e.target.closest('#tabs-overflow-menu') || e.target.closest('#btn-tabs-overflow')) return;
    if (typeof closeTabsOverflowMenu === 'function') closeTabsOverflowMenu();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tabsOverflowMenu && tabsOverflowMenu.style.display === 'block') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof closeTabsOverflowMenu === 'function') closeTabsOverflowMenu();
    }
}, true);

imgZoomIn.addEventListener('click', () => imgZoomBy(1));
imgZoomOut.addEventListener('click', () => imgZoomBy(-1));
imgScaleLabel.addEventListener('click', () => resetImgView(true));
imgScaleLabel.title = 'Click to reset zoom and position (or double-click the image)';
editorBinaryNotice.addEventListener('wheel', (e) => {
    if (editorImagePreview.style.display === 'none') return;
    e.preventDefault();
    const o = imgOffsetFromCentre(e.clientX, e.clientY);
    imgZoomBy(e.deltaY < 0 ? 1 : -1, o.x, o.y);
}, { passive: false });

// Drag to pan; pointer capture keeps tracking outside the image and works for mouse, pen, and touch.
(function wireImgPan() {
    let drag = null;
    editorImagePreview.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, panX: imgPanX, panY: imgPanY };
        editorImagePreview.classList.add('panning');
        try { editorImagePreview.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    editorImagePreview.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        imgPanX = drag.panX + (e.clientX - drag.startX);
        imgPanY = drag.panY + (e.clientY - drag.startY);
        applyImgTransform(false);
    });
    const end = (e) => {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        try { editorImagePreview.releasePointerCapture(drag.id); } catch (_) {}
        drag = null;
        editorImagePreview.classList.remove('panning');
    };
    editorImagePreview.addEventListener('pointerup', end);
    editorImagePreview.addEventListener('pointercancel', end);
    editorImagePreview.addEventListener('lostpointercapture', () => end());
    editorImagePreview.addEventListener('dblclick', () => resetImgView(true));
})();

tabsListContainer.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
        const tab = e.target.closest('.editor-tab');
        if (tab) e.preventDefault();
    }
});

tabsListContainer.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('.editor-tab');
    if (!tab) return;
    const tabId = tab.getAttribute('data-tab-id');
    if (!tabId || tabId === 'chat') return;
    e.preventDefault();
    closeTab(tabId);
});

window.openAttachmentTab = openAttachmentTab;

document.addEventListener('click', (e) => {
    if (e.target.closest('#editor-save-error-close')) {
        hideEditorSaveError();
    }
});

btnDocEdit.addEventListener('click', () => setEditorSubView('edit'));
btnDocRender.addEventListener('click', () => setEditorSubView('render'));

btnDocSave.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    saveEditorFile();
});

window.saveFileAs = saveFileAs;