/* Accent color — applied before first paint so the UI never flashes with a
   stale accent. Reads the persisted AppConfig, and the full applyTheme()
   below re-runs this whenever the accent changes. */
(function () {
    var saved = localStorage.getItem('app_config_json');
    var c = {};
    try { c = saved ? JSON.parse(saved) : {}; } catch (e) { c = {}; }
    var hex = c['accent-color'] || '#ff7a50';
    var m = hex.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) hex = '#ff7a50';
    var h = m[1].toUpperCase();
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    var root = document.documentElement;
    var theme = c['ui-theme'] || 'dark';
    root.style.colorScheme = theme;
    if (theme === 'light') root.classList.add('theme-light');
    root.style.setProperty('--primary', '#'+h);
    root.style.setProperty('--primary-rgb', r+', '+g+', '+b);
    var dr = Math.round(r*0.82), dg = Math.round(g*0.82), db = Math.round(b*0.82);
    var pad = function (n) { return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0'); };
    root.style.setProperty('--primary-2', '#'+pad(dr)+pad(dg)+pad(db));
})();