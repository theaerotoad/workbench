class VFSNode {
    constructor(kind, name, parent) {
        this.kind = kind; this.name = name; this.parent = parent; this.mtime = Date.now();
        if (kind === 'file') this.blob = new Blob([]); else this.children = new Map();
    }
}

class VFSFileHandle {
    constructor(n) { this._n = n; this.kind = 'file'; this.isVirtual = true; }
    get name() { return this._n.name; }
    async getFile() {
        const n = this._n, ext = (n.name.split('.').pop() || '').toLowerCase();
        return new File([n.blob], n.name, { lastModified: n.mtime, type: n.blob.type || VFS_MIME[ext] || '' });
    }
    async createWritable(opts) {
        const n = this._n;
        let parts = opts && opts.keepExistingData ? [n.blob] : [];
        return {
            write: async (d) => {
                if (d && d.type === 'truncate') { parts = d.size === 0 ? [] : [new Blob(parts).slice(0, d.size)]; return; }
                if (d && d.type === 'write') d = d.data;
                parts.push(d);
            },
            truncate: async (s) => { parts = s === 0 ? [] : [new Blob(parts).slice(0, s)]; },
            seek: async () => {},
            abort: async () => {},
            close: async () => { n.blob = new Blob(parts, { type: n.blob.type }); n.mtime = Date.now(); vfsChanged(n); }
        };
    }
    async move(a, b) {
        const n = this._n;
        const dir = b === undefined ? n.parent : a._n, newName = b === undefined ? a : b;
        vfsCheckName(newName);
        n.parent.children.delete(n.name);
        n.name = newName; n.parent = dir; dir.children.set(newName, n);
        vfsChanged(n);
    }
    async isSameEntry(o) { return !!o && o._n === this._n; }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
}

class VFSDirHandle {
    constructor(n) { this._n = n; this.kind = 'directory'; this.isVirtual = true; }
    get name() { return this._n.name; }
    get vid() { const r = vfsRoot(this._n); return r._ws && r._ws.vid; }
    async *entries() { for (const [k, c] of Array.from(this._n.children)) yield [k, vfsWrap(c)]; }
    async *values() { for (const c of Array.from(this._n.children.values())) yield vfsWrap(c); }
    async *keys() { for (const k of Array.from(this._n.children.keys())) yield k; }
    [Symbol.asyncIterator]() { return this.entries(); }
    async _get(name, kind, create) {
        const c = this._n.children.get(name);
        if (c) { if (c.kind !== kind) throw vfsErr('TypeMismatchError', 'Entry type mismatch: ' + name); return vfsWrap(c); }
        if (!create) throw vfsErr('NotFoundError', 'Not found: ' + name);
        vfsCheckName(name);
        const n = new VFSNode(kind, name, this._n);
        this._n.children.set(name, n); vfsChanged(n);
        return vfsWrap(n);
    }
    async getFileHandle(name, o) { return this._get(name, 'file', !!(o && o.create)); }
    async getDirectoryHandle(name, o) { return this._get(name, 'directory', !!(o && o.create)); }
    async removeEntry(name, o) {
        const c = this._n.children.get(name);
        if (!c) throw vfsErr('NotFoundError', 'Not found: ' + name);
        if (c.kind === 'directory' && c.children.size && !(o && o.recursive)) throw vfsErr('InvalidModificationError', 'Directory not empty');
        this._n.children.delete(name); vfsChanged(this._n);
    }
    async isSameEntry(o) { return !!o && o._n === this._n; }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
}

// --- AST_EXPORTS_START ---
window.VFSNode = VFSNode;
window.VFSFileHandle = VFSFileHandle;
window.VFSDirHandle = VFSDirHandle;
// --- AST_EXPORTS_END ---
