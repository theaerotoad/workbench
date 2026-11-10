/**
 * Settings Modal Controller
 * Orchestrates unified modal navigation, deep linking, and lifecycle events.
 */

let _activeSettingsTab = 'workspace';
let _isInitialized = false;

/**
 * Open the Settings Modal focused on a specific category tab.
 * @param {string} [tabId='workspace'] Target tab ID ('workspace', 'appearance', 'models', 'mcp', 'security', 'about')
 * @param {Object} [opts={}] Optional configuration payload (e.g., { focusField: 'apiKey' })
 */
export function openSettingsModal(tabId = 'workspace', opts = {}) {
    ensureSettingsModalInit();

    const overlay = document.getElementById('settings-modal-overlay');
    if (!overlay) return;

    switchSettingsTab(tabId, opts);
    overlay.style.display = 'flex';

    document.dispatchEvent(new CustomEvent('workbench:settings-open', {
        detail: { tabId, opts }
    }));
}

/**
 * Close the Settings Modal.
 */
export function closeSettingsModal() {
    const overlay = document.getElementById('settings-modal-overlay');
    if (!overlay) return;

    overlay.style.display = 'none';

    document.dispatchEvent(new CustomEvent('workbench:settings-close', {
        detail: { tabId: _activeSettingsTab }
    }));
}

/**
 * Switch the currently visible pane inside the Settings Modal.
 * @param {string} tabId Target tab ID
 * @param {Object} [opts={}] Optional payload passed to tab renderers
 */
export function switchSettingsTab(tabId, opts = {}) {
    ensureSettingsModalInit();

    const validTabs = ['workspace', 'appearance', 'models', 'mcp', 'security', 'about'];
    const targetTab = validTabs.includes(tabId) ? tabId : 'workspace';
    _activeSettingsTab = targetTab;

    const navTabs = document.querySelectorAll('.settings-nav-tab');
    const panes = document.querySelectorAll('.settings-pane');

    navTabs.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === targetTab);
    });

    panes.forEach((pane) => {
        pane.classList.toggle('active', pane.dataset.pane === targetTab);
    });

    notifyTabActivated(targetTab, opts);

    document.dispatchEvent(new CustomEvent('workbench:settings-tab-switch', {
        detail: { tabId: targetTab, opts }
    }));
}

/**
 * Returns the currently active tab ID.
 * @returns {string}
 */
export function getActiveSettingsTab() {
    return _activeSettingsTab;
}

/**
 * Trigger tab-specific refresh routines as each tab is rendered or activated.
 */
function notifyTabActivated(tabId, opts = {}) {
    if (tabId === 'models') {
        if (typeof window.renderModelsModal === 'function') {
            window.renderModelsModal(opts.focusField);
        }
    } else if (tabId === 'security') {
        if (typeof window.renderToolsList === 'function') {
            window.renderToolsList();
        }
    } else if (tabId === 'appearance') {
        if (typeof window.renderAccentSwatches === 'function') {
            window.renderAccentSwatches();
        }
    } else if (tabId === 'workspace') {
        if (typeof window.applyConfigToUI === 'function') {
            window.applyConfigToUI();
        }
    }
}

/**
 * Wire event listeners and keyboard shortcuts for modal management.
 */
export function initSettingsModal() {
    if (_isInitialized) return;

    const overlay = document.getElementById('settings-modal-overlay');
    const closeBtn = document.getElementById('settings-modal-close');
    const navEl = document.getElementById('settings-modal-nav');

    if (!overlay) return;

    // Close on backdrop click (outside modal window)
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeSettingsModal();
        }
    });

    // Close button
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            closeSettingsModal();
        });
    }

    // Tab buttons
    if (navEl) {
        navEl.addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.settings-nav-tab');
            if (tabBtn && tabBtn.dataset.tab) {
                switchSettingsTab(tabBtn.dataset.tab);
            }
        });
    }

    // Sidebar settings button opens the unified Settings modal
    const tabNavSettings = document.getElementById('tab-nav-settings');
    if (tabNavSettings) {
        tabNavSettings.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openSettingsModal('workspace');
        });
    }

    // Global keyboard shortcuts (Escape and Cmd+, / Ctrl+,)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.style.display !== 'none') {
            // Only intercept Escape if settings modal is actually open
            e.preventDefault();
            closeSettingsModal();
            return;
        }

        // Cmd+, or Ctrl+, opens Settings
        if ((e.metaKey || e.ctrlKey) && e.key === ',') {
            e.preventDefault();
            if (overlay.style.display !== 'none') {
                closeSettingsModal();
            } else {
                openSettingsModal(_activeSettingsTab || 'workspace');
            }
        }
    });

    _isInitialized = true;
}

function ensureSettingsModalInit() {
    if (!_isInitialized) {
        initSettingsModal();
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsModal);
} else {
    initSettingsModal();
}

// Expose on window for global routing and backward compatibility
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.switchSettingsTab = switchSettingsTab;
window.getActiveSettingsTab = getActiveSettingsTab;