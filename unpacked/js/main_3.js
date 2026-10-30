// Apply the persisted window mode as early as possible so the window renders at
// its final size on first paint (no flash/resize animation on reload).
(function () {
    try {
        const stored = JSON.parse(localStorage.getItem('app_config_json') || 'null');
        const mode = (stored && typeof stored === 'object' && !Array.isArray(stored))
            ? (stored['window-mode'] || 'floating')
            : 'floating';
        if (mode === 'maximized') {
            const w = document.getElementById('window');
            if (w) w.classList.add('window-maximized');
        }
    } catch (e) {}
})();