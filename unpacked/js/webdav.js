class WebDAVHandle {
    constructor(url, path, auth, name, kind) {
        this.url = url.replace(/\/$/, '');
        this.path = path.startsWith('/') ? path : '/' + path;
        this.auth = auth;
        this.name = name || (this.path === '/' ? this.url : this.path.split('/').filter(Boolean).pop());
        this.kind = kind;
        this.isWebDAV = true;
        this.isVirtual = false;
    }
    getHeaders() {
        const headers = {};
        if (this.auth && this.auth.user) {
            headers['Authorization'] = 'Basic ' + btoa(this.auth.user + ':' + this.auth.pass);
        }
        return headers;
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async _checkExists(suffix) {
        try {
            const resp = await fetch(this.url + this.path + suffix, { method: 'PROPFIND', headers: { ...this.getHeaders(), 'Depth': '0' }, cache: 'no-store' });
            if (resp.status === 404) return false;
            if (!resp.ok) throw new Error('WebDAV check failed: ' + resp.status);
            return true;
        } catch (e) { throw e; }
    }
}

class WebDAVFileHandle extends WebDAVHandle {
    constructor(url, path, auth, name) { super(url, path, auth, name, 'file'); }
    async getFile() {
        const resp = await fetch(this.url + this.path, { headers: this.getHeaders(), cache: 'no-store' });
        if (!resp.ok) throw new Error('WebDAV GET failed: ' + resp.status);
        const blob = await resp.blob();
        const lastModified = resp.headers.has('Last-Modified') ? new Date(resp.headers.get('Last-Modified')).getTime() : Date.now();
        return new File([blob], this.name, { type: blob.type, lastModified });
    }
    async move(parentHandle, newName) {
        const destUrl = new URL(this.url + parentHandle.path + newName).href;
        const resp = await fetch(this.url + this.path, {
            method: 'MOVE',
            headers: { ...this.getHeaders(), 'Destination': destUrl, 'Overwrite': 'T' },
            cache: 'no-store'
        });
        if (!resp.ok) throw new Error('WebDAV MOVE failed: ' + resp.status);
    }
    async createWritable(opts) {
        let parts = [];
        return {
            write: async (d) => {
                if (d && d.type === 'truncate') { parts = d.size === 0 ? [] : [new Blob(parts).slice(0, d.size)]; return; }
                if (d && d.type === 'write') d = d.data;
                parts.push(d);
            },
            truncate: async (s) => { parts = s === 0 ? [] : [new Blob(parts).slice(0, s)]; },
            seek: async () => {},
            abort: async () => {},
            close: async () => {
                const blob = new Blob(parts);
                const resp = await fetch(this.url + this.path, {
                    method: 'PUT',
                    headers: this.getHeaders(),
                    body: blob,
                    cache: 'no-store'
                });
                if (!resp.ok) throw new Error('WebDAV PUT failed: ' + resp.status);
            }
        };
    }
}

class WebDAVDirHandle extends WebDAVHandle {
    constructor(url, path, auth, name) {
        const dirPath = (path.startsWith('/') ? path : '/' + path).replace(/\/+$/, '') + '/';
        super(url, dirPath, auth, name, 'directory');
    }

    static async openOrCreate(url, basePath, rootPathStr, auth, customName, fallbackHost) {
        const normUrl = url.replace(/\/+$/, '');
        let base = (basePath && basePath.startsWith('/') ? basePath : '/' + (basePath || '')).replace(/\/+$/, '');
        base = base ? base + '/' : '/';

        const segments = (rootPathStr || '')
            .replace(/\\/g, '/')
            .split('/')
            .map(s => s.trim())
            .filter(Boolean);

        let name = customName && customName.trim();
        if (!name) {
            if (segments.length > 0) {
                name = segments[segments.length - 1];
            } else if (base !== '/') {
                name = base.replace(/^\/+|\/+$/g, '').split('/').pop();
            } else {
                name = fallbackHost || normUrl;
            }
        }

        const headers = {};
        if (auth && auth.user) {
            headers['Authorization'] = 'Basic ' + btoa(auth.user + ':' + (auth.pass || ''));
        }

        // 1. Verify or create the base path
        const baseResp = await fetch(normUrl + base, {
            method: 'PROPFIND',
            headers: { ...headers, 'Depth': '0' },
            cache: 'no-store'
        });
        if (baseResp.status === 401) {
            throw new Error('Authentication required or invalid credentials (401)');
        }
        if (baseResp.status === 403) {
            throw new Error('Access forbidden (403)');
        }
        if (baseResp.status === 404) {
            if (base !== '/') {
                const mkBase = await fetch(normUrl + base, {
                    method: 'MKCOL',
                    headers,
                    cache: 'no-store'
                });
                if (!mkBase.ok && mkBase.status !== 405) {
                    throw new Error(`Base path "${base}" not found and could not be created (${mkBase.status})`);
                }
            } else {
                throw new Error('WebDAV root (/) returned 404 Not Found');
            }
        } else if (!baseResp.ok && baseResp.status !== 405) {
            throw new Error(`Server check failed: ${baseResp.status} ${baseResp.statusText || ''}`);
        }

        // 2. Walk and create subdirectories recursively if needed
        let currentPath = base;
        for (const seg of segments) {
            let cleanSeg = seg;
            try { cleanSeg = decodeURIComponent(seg); } catch (_) {}
            currentPath += cleanSeg + '/';

            const checkResp = await fetch(normUrl + currentPath, {
                method: 'PROPFIND',
                headers: { ...headers, 'Depth': '0' },
                cache: 'no-store'
            });
            if (checkResp.status === 404) {
                const mkResp = await fetch(normUrl + currentPath, {
                    method: 'MKCOL',
                    headers,
                    cache: 'no-store'
                });
                if (!mkResp.ok && mkResp.status !== 405) {
                    throw new Error(`Failed to create directory "${cleanSeg}" (${mkResp.status} ${mkResp.statusText || ''})`);
                }
            } else if (checkResp.status === 401 || checkResp.status === 403) {
                throw new Error(`Permission denied accessing directory "${cleanSeg}" (${checkResp.status})`);
            } else if (!checkResp.ok && checkResp.status !== 405) {
                throw new Error(`Error accessing directory "${cleanSeg}" (${checkResp.status})`);
            }
        }

        return new WebDAVDirHandle(normUrl, currentPath, auth, name);
    }

    async *entries() {
        const resp = await fetch(this.url + this.path, {
            method: 'PROPFIND',
            headers: { ...this.getHeaders(), 'Depth': '1' },
            cache: 'no-store'
        });
        if (!resp.ok) throw new Error('WebDAV PROPFIND failed: ' + resp.status);
        const text = await resp.text();
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        const responses = Array.from(xml.querySelectorAll('response, d\\:response, D\\:response'));

        // Identify the root (self) element by finding the shortest path.
        // In a Depth: 1 PROPFIND, the requested collection is always the shortest path.
        let shortestPath = null;
        let minLength = Infinity;
        for (let i = 0; i < responses.length; i++) {
            const hrefEl = responses[i].querySelector('href, d\\:href, D\\:href');
            if (hrefEl) {
                let p = hrefEl.textContent;
                try { p = new URL(p, 'http://localhost').pathname; } catch (e) {}
                try { p = decodeURIComponent(p); } catch (e) {}
                p = p.replace(/\/$/, '');
                if (p.length < minLength) {
                    minLength = p.length;
                    shortestPath = p;
                }
            }
        }

        for (let i = 0; i < responses.length; i++) {
            const r = responses[i];
            const hrefEl = r.querySelector('href, d\\:href, D\\:href');
            if (!hrefEl) continue;
            
            let p = hrefEl.textContent;
            try { p = new URL(p, 'http://localhost').pathname; } catch (e) {}
            try { p = decodeURIComponent(p); } catch (e) {}
            const decodedHref = p;
            
            if (decodedHref.replace(/\/$/, '') === shortestPath) {
                continue; // This is the directory itself, skip it.
            }

            const isCol = !!r.querySelector('collection, d\\:collection, D\\:collection');
            const name = decodedHref.replace(/\/$/, '').split('/').pop();
            const newPath = this.path + name + (isCol ? '/' : '');

            const handle = isCol
                ? new WebDAVDirHandle(this.url, newPath, this.auth, name)
                : new WebDAVFileHandle(this.url, newPath, this.auth, name);
            yield [name, handle];
        }
    }
    async *values() { for await (const [k, v] of this.entries()) yield v; }
    async *keys() { for await (const [k, v] of this.entries()) yield k; }

    async getFileHandle(name, opts) {
        if (!opts?.create) {
            const exists = await this._checkExists(name);
            if (!exists) throw vfsErr('NotFoundError', 'Not found: ' + name);
        } else {
            const exists = await this._checkExists(name);
            if (!exists) {
                const resp = await fetch(this.url + this.path + name, { method: 'PUT', headers: this.getHeaders(), body: '', cache: 'no-store' });
                if (!resp.ok) throw new Error('WebDAV create file failed: ' + resp.status);
            }
        }
        return new WebDAVFileHandle(this.url, this.path + name, this.auth, name);
    }

    async getDirectoryHandle(name, opts) {
        if (opts?.create) {
            const exists = await this._checkExists(name + '/');
            if (!exists) {
                const resp = await fetch(this.url + this.path + name + '/', { method: 'MKCOL', headers: this.getHeaders(), cache: 'no-store' });
                if (!resp.ok && resp.status !== 405) throw new Error('WebDAV MKCOL failed: ' + resp.status);
            }
        } else {
            const exists = await this._checkExists(name + '/');
            if (!exists) throw vfsErr('NotFoundError', 'Not found: ' + name);
        }
        return new WebDAVDirHandle(this.url, this.path + name + '/', this.auth, name);
    }

    async removeEntry(name, opts) {
        const resp = await fetch(this.url + this.path + name, { method: 'DELETE', headers: this.getHeaders(), cache: 'no-store' });
        if (!resp.ok && resp.status !== 404) throw new Error('WebDAV DELETE failed: ' + resp.status);
    }
}

// --- AST_EXPORTS_START ---
window.WebDAVHandle = WebDAVHandle;
window.WebDAVFileHandle = WebDAVFileHandle;
window.WebDAVDirHandle = WebDAVDirHandle;
// --- AST_EXPORTS_END ---
