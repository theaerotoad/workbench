/* ---- Monaco theme (re-applied when the accent changes) ---- */
function defineMonacoThemes() {
    if (!MONACO || !MONACO.editor || !MONACO.editor.defineTheme) return;
    const accent = currentAccent();
    const isLight = document.documentElement.classList.contains('theme-light');
    MONACO.editor.defineTheme('agent2-dark', {
        base: isLight ? 'vs' : 'vs-dark',
        inherit: true,
        rules: [
            { token: '', background: isLight ? 'ffffff' : '0e0e10', foreground: isLight ? '1e1e24' : 'dcdfe7' },
            { token: 'keyword', foreground: 'c678dd', fontStyle: 'bold' },
            { token: 'string', foreground: '98c379' },
            { token: 'number', foreground: 'd19a66' },
            { token: 'comment', foreground: '737791', fontStyle: 'italic' },
            { token: 'type', foreground: 'e5c07b' },
            { token: 'function', foreground: '61afef' },
            { token: 'identifier', foreground: isLight ? '1e1e24' : 'dcdfe7' }
        ],
        colors: {
            'editor.background': isLight ? '#ffffff' : '#0e0e10',
            'editor.foreground': isLight ? '#1e1e24' : '#dcdfe7',
            'editor.lineHighlightBackground': isLight ? '#f0f0f4' : '#17171a',
            'editor.selectionBackground': isLight ? '#e0e0e6' : '#2e2e2e',
            'editorCursor.foreground': accent,
            'editorWhitespace.foreground': isLight ? '#e0e0e6' : '#2e2e2e',
            'editorLineNumber.foreground': isLight ? '#a0a0b0' : '#5a5a5a',
            'editorLineNumber.activeForeground': accent,
            'editorGutter.background': isLight ? '#ffffff' : '#0e0e10',
            'minimap.background': isLight ? '#ffffff' : '#0e0e10',
            'diffEditor.insertedTextBackground': '#98c37922',
            'diffEditor.removedTextBackground': '#e06c7522'
        }
    });
    MONACO.editor.setTheme('agent2-dark');
}

function initMonaco() {
    return new Promise((resolve) => {
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const timeoutId = setTimeout(() => {
            console.warn('Monaco editor failed to load within 15s (CDN unreachable?) - continuing without it.');
            settle();
        }, 15000);

        try {
            window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs' } });
        } catch(e) {
            clearTimeout(timeoutId);
            settle();
            return;
        }
        window.MonacoEnvironment = {
            getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent("self.MonacoEnvironment={baseUrl:'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/'};importScripts('https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/base/worker/workerMain.js');")}`
        };
        window.require(['vs/editor/editor.main'], () => {
            try {
                MONACO = window.monaco;

            defineMonacoThemes();

            const editorHost = document.getElementById('monaco-editor-container');
            monacoEditor = MONACO.editor.create(editorHost, {
                theme: 'agent2-dark',
                automaticLayout: true,
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                fontLigatures: true,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                smoothScrolling: false,
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'off',
                renderWhitespace: 'selection',
                bracketPairColorization: { enabled: true },
                glyphMargin: false,
                lineDecorationsWidth: 10,
                tabSize: 4
            });

            monacoEditor.addCommand(MONACO.KeyMod.CtrlCmd | MONACO.KeyCode.KeyS, () => {
                saveEditorFile();
            });

            monacoEditor.addAction({
                id: 'agent.referenceSelection',
                label: 'Reference in Prompt (@)',
                contextMenuGroupId: '1_modification',
                keybindings: [MONACO.KeyMod.CtrlCmd | MONACO.KeyCode.KeyR],
                run: (ed) => {
                    const sel = ed.getSelection();
                    const model = ed.getModel();
                    if (!sel || sel.isEmpty() || !model || !state.currentEditorPath) return;

                    const selectedCode = model.getValueInRange(sel);
                    attachReference({
                        type: 'snippet',
                        filepath: state.currentEditorPath,
                        startLine: sel.startLineNumber,
                        endLine: sel.endLineNumber,
                        code: selectedCode
                    });
                    switchTab('chat');
                }
            });

            monacoEditor.onDidChangeModelContent(() => {
                if (state.currentEditorPath && !state.suppressDirtyTracking) {
                    markFileDirty(state.currentEditorPath);
                }
                scheduleGutterDiffUpdate();
            });

            let _lastPickerLine = -1;
            monacoEditor.onDidChangeCursorPosition((e) => {
                if (!state.currentEditorPath || !state.currentEditorPath.endsWith('models.json')) {
                    hideModelPickerWidget();
                    _lastPickerLine = -1;
                    return;
                }

                const line = e.position.lineNumber;
                const model = monacoEditor.getModel();
                if (!model) return;

                const lineContent = model.getLineContent(line);
                if (getModelValueEndPosition(lineContent)) {
                    if (line !== _lastPickerLine) {
                        _lastPickerLine = line;
                        showModelPickerWidget(line);
                    }
                } else {
                    if (_lastPickerLine !== -1) {
                        hideModelPickerWidget();
                        _lastPickerLine = -1;
                    }
                }
            });

            document.addEventListener('mousedown', (e) => {
                if (!_modelPickerState || !_modelPickerState.visible) return;
                if (modelPickerDropdown.contains(e.target)) return;
                const widgetNode = document.querySelector('.inline-model-picker-btn');
                if (widgetNode && widgetNode.contains(e.target)) return;
                const mmTrigger = e.target.closest && e.target.closest('.mm-model-search-btn');
                if (mmTrigger) return;
                hideModelPicker();
            });

            const diffHost = document.getElementById('monaco-diff-container');
            monacoDiffEditor = MONACO.editor.createDiffEditor(diffHost, {
                theme: 'agent2-dark',
                automaticLayout: true,
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                readOnly: false,
                originalEditable: false,
                renderSideBySide: state.diffSideBySide,
                renderMarginRevertIcon: true,
                glyphMargin: true,
                diffCodeLens: true,
                scrollBeyondLastLine: false,
                smoothScrolling: false,
                enableSplitViewResizing: true,
                renderIndicators: true,
                ignoreTrimWhitespace: false
            });

            monacoDiffEditor.getModifiedEditor().addCommand(MONACO.KeyMod.CtrlCmd | MONACO.KeyCode.KeyS, () => {
                saveDiffModifiedFile();
            });

            monacoDiffEditor.getOriginalEditor().addCommand(MONACO.KeyMod.CtrlCmd | MONACO.KeyCode.KeyS, () => {
                saveDiffModifiedFile();
            });

            clearTimeout(timeoutId);
            settle();
            } catch(e) {
                console.warn('Monaco editor failed to initialize:', e.message);
                clearTimeout(timeoutId);
                settle();
            }
        });
    });
}

function _ensureGutterDiffEditor() {
    if (_gutterDiffEditor) return _gutterDiffEditor;
    _gutterDiffHost = document.createElement('div');
    _gutterDiffHost.style.position = 'absolute';
    _gutterDiffHost.style.width = '1px';
    _gutterDiffHost.style.height = '1px';
    _gutterDiffHost.style.top = '-9999px';
    _gutterDiffHost.style.left = '-9999px';
    _gutterDiffHost.style.visibility = 'hidden';
    document.body.appendChild(_gutterDiffHost);
    _gutterDiffEditor = MONACO.editor.createDiffEditor(_gutterDiffHost, {
        automaticLayout: false,
        renderSideBySide: false,
        ignoreTrimWhitespace: false
    });
    return _gutterDiffEditor;
}

function scheduleGutterDiffUpdate() {
    if (_gutterDiffTimer) clearTimeout(_gutterDiffTimer);
    _gutterDiffTimer = setTimeout(updateGutterDiffMarkers, 250);
}

function clearGutterDiffMarkers() {
    if (monacoEditor && _gutterDecorationIds.length) {
        _gutterDecorationIds = monacoEditor.deltaDecorations(_gutterDecorationIds, []);
    }
}

function updateGutterDiffMarkers() {
    if (!monacoEditor || !MONACO || !state.currentEditorPath) return;
    const filepath = state.currentEditorPath;
    const model = monacoEditor.getModel();
    if (!model) return;

    const originalContent = registry.originalFiles ? registry.originalFiles[filepath] : undefined;
    if (originalContent === undefined && !state.modifiedFiles.has(filepath)) {
        clearGutterDiffMarkers();
        return;
    }

    const baseline = originalContent !== undefined ? originalContent : '';

    const diffEditor = _ensureGutterDiffEditor();
    const originalModel = MONACO.editor.createModel(baseline, model.getLanguageId ? model.getLanguageId() : undefined);
    diffEditor.setModel({ original: originalModel, modified: model });

    const applyFromChanges = () => {
        const changes = diffEditor.getLineChanges() || [];
        const decorations = [];
        if (originalContent === undefined && model.getLineCount() > 0) {
            for (let i = 1; i <= model.getLineCount(); i++) {
                decorations.push(_makeDiffDecoration(i, i, 'added'));
            }
        } else {
            for (const change of changes) {
                const modStart = change.modifiedStartLineNumber;
                const modEnd = change.modifiedEndLineNumber;
                const origStart = change.originalStartLineNumber;
                const origEnd = change.originalEndLineNumber;

                if (modEnd === 0 && origEnd > 0) {
                    decorations.push(_makeDiffDecoration(Math.max(modStart, 1), Math.max(modStart, 1), 'deleted'));
                } else if (origEnd === 0 && modEnd > 0) {
                    decorations.push(_makeDiffDecoration(modStart, modEnd, 'added'));
                } else if (modEnd > 0) {
                    decorations.push(_makeDiffDecoration(modStart, modEnd, 'modified'));
                }
            }
        }

        if (state.currentEditorPath === filepath && monacoEditor.getModel() === model) {
            _gutterDecorationIds = monacoEditor.deltaDecorations(_gutterDecorationIds, decorations);
        }
        diffEditor.setModel(null);
        originalModel.dispose();
    };

    const existing = diffEditor.getLineChanges();
    if (existing !== null) {
        applyFromChanges();
    } else {
        const sub = diffEditor.onDidUpdateDiff(() => {
            sub.dispose();
            applyFromChanges();
        });
    }
}

// --- AST_EXPORTS_START ---
window.defineMonacoThemes = defineMonacoThemes;
window.initMonaco = initMonaco;
window._ensureGutterDiffEditor = _ensureGutterDiffEditor;
window.scheduleGutterDiffUpdate = scheduleGutterDiffUpdate;
window.clearGutterDiffMarkers = clearGutterDiffMarkers;
window.updateGutterDiffMarkers = updateGutterDiffMarkers;
// --- AST_EXPORTS_END ---
