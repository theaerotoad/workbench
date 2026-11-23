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
import './modules/docx_export.js';

import '../js/db.js';
import '../js/remote_store.js';
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

async function _resolveExternalConflictsForRevert(actions, { skipConfirm = false } = {}) {
    if (typeof detectExternalRevertConflicts !== 'function') {
        return { cancelled: false, skipPaths: null, externalDiskText: null };
    }
    const { conflicts, conflictPaths, diskTextByPath } = await detectExternalRevertConflicts(actions);
    if (!conflicts.length) {
        return { cancelled: false, skipPaths: null, externalDiskText: null };
    }

    if (skipConfirm) {
        const shown = conflicts.slice(0, 3).map(c => c.filepath).join(', ');
        const more = conflicts.length > 3 ? ` (+${conflicts.length - 3} more)` : '';
        showToast(`Kept external edits in ${shown}${more} (skipped during revert)`, 'info', 4500);
        return { cancelled: false, skipPaths: conflictPaths, externalDiskText: diskTextByPath };
    }

    const lines = conflicts.slice(0, 8).map(c => `• ${c.filepath} (${c.reason})`);
    if (conflicts.length > 8) {
        lines.push(`• … and ${conflicts.length - 8} more`);
    }
    const msg = `The following file${conflicts.length === 1 ? ' has' : 's have'} changes made outside Workbench (or unsaved in the editor):\n\n${lines.join('\n')}\n\nKeep those edits or overwrite them with the checkpoint?`;
    const choice = typeof confirmChoiceDialog === 'function'
        ? await confirmChoiceDialog(msg, {
            primaryLabel: 'Keep External Edits',
            secondaryLabel: 'Overwrite',
            cancelLabel: 'Cancel',
            primaryValue: 'keep',
            secondaryValue: 'overwrite',
            cancelValue: 'cancel',
            danger: false
        })
        : (await confirmDialog(msg, { confirmLabel: 'Overwrite', cancelLabel: 'Keep External Edits', danger: true }) ? 'overwrite' : 'keep');

    if (choice === 'cancel') {
        return { cancelled: true, skipPaths: null, externalDiskText: null };
    }
    if (choice === 'keep') {
        return { cancelled: false, skipPaths: conflictPaths, externalDiskText: diskTextByPath };
    }
    return { cancelled: false, skipPaths: null, externalDiskText: null };
}

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
        // Build a kind-appropriate action for this single file before mutating opsLog.
        const isDir = !!(target.op?.isDir || target.kind === 'mkdir' || registry.meta[filepath]?.kind === 'directory');
        let action;
        if (target.kind === 'delete') {
            action = isDir ? { kind: 'delete-dir', filepath } : { kind: 'delete', filepath };
        } else if (target.kind === 'rename-out') {
            // The path no longer exists at this point (renamed away), so revert deletes it.
            action = { kind: 'delete', filepath };
        } else if (target.kind === 'mkdir') {
            action = { kind: 'mkdir', filepath };
        } else if (target.kind === 'rename-in') {
            action = null;
        } else if (target.kind === 'baseline') {
            const original = registry.originalFiles[filepath];
            action = (original === undefined || original === null)
                ? { kind: 'delete', filepath }
                : { kind: 'restore', filepath, content: target.content };
        } else {
            action = { kind: 'restore', filepath, content: target.content };
        }

        const conflictRes = action
            ? await _resolveExternalConflictsForRevert([action], { skipConfirm: false })
            : { cancelled: false, skipPaths: null, externalDiskText: null };
        if (conflictRes.cancelled) return;

        // Truncate the op log: keep only ops strictly before this entry.
        const ops = registry.opsLog[filepath] || [];
        const kept = [];
        for (const op of ops) {
            if (op.ts === target.ts) break;
            kept.push(op);
        }
        registry.opsLog[filepath] = kept;

        if (action) {
            await executeRevertPlan([action], {
                skipPaths: conflictRes.skipPaths,
                externalDiskText: conflictRes.externalDiskText
            });
        } else {
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
    // Replay only paths that actually have history entries at or after the cut.
    const actions = [];
    for (const filepath of files) {
        const timeline = getFileTimeline(filepath);
        const touchedAtOrAfterCut = timeline.some(
            e => e.kind !== 'baseline' && e.ts !== null && e.ts >= cutTs
        );
        if (!touchedAtOrAfterCut) continue;

        const isDirPath = timeline.some(e => e.kind === 'mkdir' || (e.op && e.op.isDir === true)) ||
            (registry.meta[filepath] && registry.meta[filepath].kind === 'directory');

        let present = false;
        let content = null;
        let firstCutEntry = null;
        for (const entry of timeline) {
            if (entry.kind === 'baseline') {
                present = entry.content !== null && entry.content !== undefined;
                content = entry.content;
                continue;
            }
            if (entry.ts === null) continue;       // the synthetic 'current' entry
            if (entry.ts >= cutTs) {
                firstCutEntry = entry;
                break;                             // first op at/after the cut
            }
            if (entry.kind === 'delete') { present = false; content = null; }
            else if (entry.kind === 'mkdir') { present = true; }
            else if (entry.kind === 'rename-in' || entry.kind === 'rename-out') { present = true; }
            else if (entry.kind === 'checkpoint') { present = true; content = entry.content; }
        }

        if (isDirPath) {
            if (!present && firstCutEntry && firstCutEntry.kind === 'delete' && firstCutEntry.op?.existedBefore) {
                present = true;
            }
            if (present) {
                actions.push({ kind: 'mkdir', filepath });
            } else {
                actions.push({ kind: 'delete-dir', filepath });
            }
            continue;
        }

        if (present && (content === null || content === undefined) && firstCutEntry?.op?.previousContent !== undefined) {
            content = firstCutEntry.op.previousContent;
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
            if (moveBackTo && moveBackTo !== filepath) {
                actions.push({ kind: 'rename', filepath, targetPath: moveBackTo });
            }
            if (content !== null && content !== undefined) {
                actions.push({ kind: 'restore', filepath: finalPath, content });
            }
        } else {
            actions.push({ kind: 'delete', filepath });
        }
    }

    if (actions.length === 0) return;

    const orderRank = { rename: 0, mkdir: 1, restore: 2, delete: 3, 'delete-dir': 4 };
    const pathDepth = (p) => String(p || '').split('/').filter(Boolean).length;
    const finalActions = actions.slice().sort((a, b) => {
        const ra = orderRank[a.kind] ?? 9;
        const rb = orderRank[b.kind] ?? 9;
        if (ra !== rb) return ra - rb;
        if (a.kind === 'mkdir') {
            const dd = pathDepth(a.filepath) - pathDepth(b.filepath);
            return dd !== 0 ? dd : a.filepath.localeCompare(b.filepath);
        }
        if (a.kind === 'delete-dir') {
            const dd = pathDepth(b.filepath) - pathDepth(a.filepath);
            return dd !== 0 ? dd : b.filepath.localeCompare(a.filepath);
        }
        return (a.filepath || '').localeCompare(b.filepath || '');
    });

    const skipConfirm = !!(opts && opts.skipConfirm);
    if (!skipConfirm) {
        const describeAction = (p) => {
            if (p.kind === 'delete') return `delete ${p.filepath}`;
            if (p.kind === 'delete-dir') return `remove folder ${p.filepath}/`;
            if (p.kind === 'mkdir') return `recreate folder ${p.filepath}/`;
            if (p.kind === 'rename') return `rename ${p.filepath} → ${p.targetPath}`;
            return `restore ${p.filepath}`;
        };
        const preview = finalActions.slice(0, 8).map(describeAction).join(', ');
        const more = finalActions.length > 8 ? ` (+${finalActions.length - 8} more)` : '';
        const shortLabel = (promptLabel || 'this prompt').slice(0, 120) + (promptLabel && promptLabel.length > 120 ? '…' : '');
        if (!await confirmDialog(`Revert to right before "${shortLabel}"?\n\nThis will ${preview}${more}. Later changes will be discarded.`, { confirmLabel: 'Revert', danger: true })) return;
    }

    const conflictRes = await _resolveExternalConflictsForRevert(finalActions, { skipConfirm });
    if (conflictRes.cancelled) return;

    await executeRevertPlan(finalActions, {
        forgetPromptIds: Array.from(forgetIds),
        skipPaths: conflictRes.skipPaths,
        externalDiskText: conflictRes.externalDiskText
    });
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
    const actions = (original === undefined || original === null)
        ? [{ kind: 'delete', filepath }]
        : [{ kind: 'restore', filepath, content: original }];
    const conflictRes = await _resolveExternalConflictsForRevert(actions, { skipConfirm: false });
    if (conflictRes.cancelled) return;
    await executeRevertPlan(actions, {
        clearOpsFor: [filepath],
        skipPaths: conflictRes.skipPaths,
        externalDiskText: conflictRes.externalDiskText
    });
    if (state.activeTab === `filediff:${filepath}`) closeTab(`filediff:${filepath}`);
};

window.restoreAllModifiedFiles = async () => {
    if (!state.modifiedFiles.size) return;
    if (!await confirmDialog(`Discard all changes across ${state.modifiedFiles.size} file(s)?`, { confirmLabel: 'Discard all', danger: true })) return;
    const files = Array.from(state.modifiedFiles);
    const actions = files.map(fp => {
        const original = registry.originalFiles[fp];
        return (original === undefined || original === null)
            ? { kind: 'delete', filepath: fp }
            : { kind: 'restore', filepath: fp, content: original };
    });
    const conflictRes = await _resolveExternalConflictsForRevert(actions, { skipConfirm: false });
    if (conflictRes.cancelled) return;
    await executeRevertPlan(actions, {
        clearOpsFor: files,
        skipPaths: conflictRes.skipPaths,
        externalDiskText: conflictRes.externalDiskText
    });
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