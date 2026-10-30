/* Folder access (File System Access API): without it only virtual workspaces can be used. */
(function () {
    var ok = typeof window.showDirectoryPicker === 'function' && window.isSecureContext !== false;
    if (!ok) document.documentElement.classList.add('no-fsa');
})();