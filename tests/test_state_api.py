import asyncio
import gzip
import json
import os
import sys
import tempfile
import unittest
import urllib.parse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server import create_app

try:
    from starlette.testclient import TestClient
except Exception:
    TestClient = None


def _make_asgi_request(app, method, url, body=b"", headers=None):
    """Direct ASGI request helper (no httpx dependency required)."""
    parts = url.split("?", 1)
    raw_path_str = parts[0]
    query_string = parts[1] if len(parts) > 1 else ""
    decoded_path = urllib.parse.unquote(raw_path_str)

    asgi_headers = []
    for k, v in (headers or {}).items():
        asgi_headers.append((k.lower().encode("latin1"), str(v).encode("latin1")))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": decoded_path,
        "raw_path": raw_path_str.encode("ascii"),
        "query_string": query_string.encode("ascii"),
        "headers": asgi_headers,
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 5050),
    }

    sent_body = False
    response_messages = []

    async def receive():
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        response_messages.append(message)

    asyncio.run(app(scope, receive, send))

    status_code = None
    resp_headers = {}
    body_parts = []
    for msg in response_messages:
        if msg["type"] == "http.response.start":
            status_code = msg["status"]
            resp_headers = {
                k.decode("latin1").lower(): v.decode("latin1")
                for k, v in msg.get("headers", [])
            }
        elif msg["type"] == "http.response.body":
            body_parts.append(msg.get("body", b""))

    raw_bytes = b"".join(body_parts)

    class SimpleResponse:
        def __init__(self, status, hdrs, raw):
            self.status_code = status
            self.headers = hdrs
            self.content = raw

        def json(self):
            payload = self.content
            if self.headers.get("content-encoding") == "gzip":
                payload = gzip.decompress(payload)
            return json.loads(payload.decode("utf-8"))

    return SimpleResponse(status_code, resp_headers, raw_bytes)


class _AppClient:
    """Uses Starlette TestClient if httpx is installed, else falls back to raw ASGI."""

    def __init__(self, app):
        self.app = app
        self._tc = None
        if TestClient is not None:
            try:
                self._tc = TestClient(app)
            except Exception:
                self._tc = None

    def request(self, method, url, data=b"", headers=None):
        if self._tc is not None:
            return self._tc.request(method, url, content=data, headers=headers)
        return _make_asgi_request(self.app, method, url, body=data, headers=headers)

    def get(self, url, headers=None):
        return self.request("GET", url, headers=headers)

    def put(self, url, data=b"", headers=None):
        return self.request("PUT", url, data=data, headers=headers)

    def delete(self, url, headers=None):
        return self.request("DELETE", url, headers=headers)

    def close(self):
        if self._tc is not None:
            self._tc.close()


class TestStateAPI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = self.temp_dir.name
        self.static_dir = os.path.join(self.root, "static")
        self.webdav_dir = os.path.join(self.root, "webdav")
        self.data_dir = os.path.join(self.root, "data")
        os.makedirs(self.static_dir, exist_ok=True)
        os.makedirs(self.webdav_dir, exist_ok=True)
        with open(os.path.join(self.static_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write("<html><body>workbench</body></html>")
        with open(os.path.join(self.webdav_dir, "hello.txt"), "w", encoding="utf-8") as f:
            f.write("hi")

        self.app = create_app(
            webdav_dir=self.webdav_dir,
            static_dir=self.static_dir,
            data_dir=self.data_dir,
            sync_secrets=False,
            max_record_mb=1,
        )
        self.client = _AppClient(self.app)

    def tearDown(self):
        self.client.close()
        if getattr(self.app.state, "state_store", None) is not None:
            self.app.state.state_store.close()
        self.temp_dir.cleanup()

    def test_capabilities_disabled_and_kv_503(self):
        app_disabled = create_app(webdav_dir=self.webdav_dir, static_dir=self.static_dir)
        client = _AppClient(app_disabled)
        try:
            res = client.get("/api/v1/capabilities")
            self.assertEqual(res.status_code, 200)
            caps = res.json()
            self.assertEqual(caps["apiVersion"], 1)
            self.assertFalse(caps["persistence"])
            self.assertIsNone(caps["serverId"])
            self.assertFalse(caps["syncSecrets"])
            self.assertEqual(caps["stores"], ["sessions", "baselines", "catalog", "settings", "vws"])

            self.assertEqual(client.get("/api/v1/kv/sessions").status_code, 503)
            self.assertEqual(client.get("/api/v1/kv/sessions/abc").status_code, 503)
            self.assertEqual(client.put("/api/v1/kv/sessions/abc", data=b"{}").status_code, 503)
            self.assertEqual(client.delete("/api/v1/kv/sessions/abc").status_code, 503)
            self.assertEqual(client.delete("/api/v1/kv/sessions?prefix=a").status_code, 503)
        finally:
            client.close()

    def test_capabilities_enabled(self):
        res = self.client.get("/api/v1/capabilities")
        self.assertEqual(res.status_code, 200)
        caps = res.json()
        self.assertEqual(caps["apiVersion"], 1)
        self.assertTrue(caps["persistence"])
        self.assertTrue(isinstance(caps["serverId"], str) and len(caps["serverId"]) >= 32)
        self.assertFalse(caps["syncSecrets"])
        self.assertEqual(caps["maxRecordBytes"], 1024 * 1024)

    def test_put_get_roundtrip_and_rev_conflict(self):
        # Missing key -> 404
        res0 = self.client.get("/api/v1/kv/sessions/ws::session::s1")
        self.assertEqual(res0.status_code, 404)

        # Put with X-Base-Rev: 0 succeeds -> rev 1
        body1 = json.dumps({"id": "s1", "title": "First"}).encode("utf-8")
        res1 = self.client.put(
            "/api/v1/kv/sessions/ws::session::s1",
            data=body1,
            headers={"X-Base-Rev": "0", "X-Client-Id": "browser-a"},
        )
        self.assertEqual(res1.status_code, 200)
        self.assertEqual(res1.json(), {"rev": 1})
        self.assertEqual(res1.headers.get("x-rev"), "1")

        # GET returns body and X-Rev
        get1 = self.client.get("/api/v1/kv/sessions/ws::session::s1")
        self.assertEqual(get1.status_code, 200)
        self.assertEqual(get1.headers.get("x-rev"), "1")
        self.assertEqual(get1.json(), {"id": "s1", "title": "First"})

        # X-Base-Rev: 0 on existing key -> 412 with current rev
        res_conflict0 = self.client.put(
            "/api/v1/kv/sessions/ws::session::s1",
            data=b'{"id":"s1","title":"Stale"}',
            headers={"X-Base-Rev": "0"},
        )
        self.assertEqual(res_conflict0.status_code, 412)
        self.assertEqual(res_conflict0.json(), {"rev": 1})
        self.assertEqual(res_conflict0.headers.get("x-rev"), "1")

        # X-Base-Rev mismatch -> 412
        res_conflict9 = self.client.put(
            "/api/v1/kv/sessions/ws::session::s1",
            data=b'{"id":"s1","title":"Wrong"}',
            headers={"X-Base-Rev": "9"},
        )
        self.assertEqual(res_conflict9.status_code, 412)
        self.assertEqual(res_conflict9.json(), {"rev": 1})

        # Matching X-Base-Rev: 1 -> rev 2
        res2 = self.client.put(
            "/api/v1/kv/sessions/ws::session::s1",
            data=b'{"id":"s1","title":"Second"}',
            headers={"X-Base-Rev": "1"},
        )
        self.assertEqual(res2.status_code, 200)
        self.assertEqual(res2.json(), {"rev": 2})
        self.assertEqual(res2.headers.get("x-rev"), "2")

    def test_delete_tombstone_and_recreate(self):
        self.client.put("/api/v1/kv/sessions/k1", data=b'{"v":1}', headers={"X-Base-Rev": "0"})

        # Wrong base rev on delete -> 412
        del_bad = self.client.delete("/api/v1/kv/sessions/k1", headers={"X-Base-Rev": "0"})
        self.assertEqual(del_bad.status_code, 412)
        self.assertEqual(del_bad.json(), {"rev": 1})

        # Correct base rev -> 200, rev 2
        del_ok = self.client.delete("/api/v1/kv/sessions/k1", headers={"X-Base-Rev": "1"})
        self.assertEqual(del_ok.status_code, 200)
        self.assertEqual(del_ok.json(), {"rev": 2})
        self.assertEqual(del_ok.headers.get("x-rev"), "2")

        # GET on tombstone -> 410 with X-Rev
        get_gone = self.client.get("/api/v1/kv/sessions/k1")
        self.assertEqual(get_gone.status_code, 410)
        self.assertEqual(get_gone.headers.get("x-rev"), "2")

        # List includes tombstone with deleted: true
        listing = self.client.get("/api/v1/kv/sessions")
        self.assertEqual(listing.status_code, 200)
        items = listing.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["key"], "k1")
        self.assertEqual(items[0]["rev"], 2)
        self.assertTrue(items[0]["deleted"])

        # Put over tombstone with base_rev=0 fails, base_rev=2 succeeds
        self.assertEqual(
            self.client.put("/api/v1/kv/sessions/k1", data=b'{"v":2}', headers={"X-Base-Rev": "0"}).status_code,
            412,
        )
        put_ok = self.client.put(
            "/api/v1/kv/sessions/k1",
            data=b'{"v":2}',
            headers={"X-Base-Rev": "2"},
        )
        self.assertEqual(put_ok.status_code, 200)
        self.assertEqual(put_ok.json(), {"rev": 3})
        self.assertEqual(self.client.get("/api/v1/kv/sessions/k1").json(), {"v": 2})

    def test_prefix_list_exact_and_special_keys(self):
        keys = [
            "a::one",
            "a::two",
            "a:b",
            "folder/sub/file with spaces",
            "unicode/café/日本語::key",
        ]
        for k in keys:
            encoded = urllib.parse.quote(k, safe="/")
            res = self.client.put(f"/api/v1/kv/sessions/{encoded}", data=json.dumps({"k": k}).encode("utf-8"))
            self.assertEqual(res.status_code, 200, f"failed putting {k}")

        # Exact prefix: "a::" must NOT match "a:b"
        res_list = self.client.get("/api/v1/kv/sessions?prefix=" + urllib.parse.quote("a::"))
        self.assertEqual(res_list.status_code, 200)
        found = [item["key"] for item in res_list.json()["items"]]
        self.assertEqual(found, ["a::one", "a::two"])

        # Verify GET roundtrip for slash, space, and unicode keys
        for k in ("folder/sub/file with spaces", "unicode/café/日本語::key"):
            encoded = urllib.parse.quote(k, safe="/")
            get_res = self.client.get(f"/api/v1/kv/sessions/{encoded}")
            self.assertEqual(get_res.status_code, 200)
            self.assertEqual(get_res.json(), {"k": k})

        # DELETE by prefix requires non-empty prefix
        self.assertEqual(self.client.delete("/api/v1/kv/sessions").status_code, 400)
        del_res = self.client.delete("/api/v1/kv/sessions?prefix=" + urllib.parse.quote("a::"))
        self.assertEqual(del_res.status_code, 200)
        self.assertEqual(del_res.json(), {"deleted": 2})

    def test_gzip_request_and_response_and_size_limit(self):
        big_payload = json.dumps({"text": "hello world " * 300}).encode("utf-8")
        gz_payload = gzip.compress(big_payload)

        put_res = self.client.put(
            "/api/v1/kv/sessions/big",
            data=gz_payload,
            headers={"Content-Encoding": "gzip", "X-Base-Rev": "0"},
        )
        self.assertEqual(put_res.status_code, 200)
        self.assertEqual(put_res.json(), {"rev": 1})

        # Verify raw ASGI response is actually gzip-compressed when Accept-Encoding: gzip
        raw_get = _make_asgi_request(
            self.app,
            "GET",
            "/api/v1/kv/sessions/big",
            headers={"Accept-Encoding": "gzip"},
        )
        self.assertEqual(raw_get.status_code, 200)
        self.assertEqual(raw_get.headers.get("content-encoding"), "gzip")
        self.assertEqual(gzip.decompress(raw_get.content), big_payload)

        # Oversized uncompressed body -> 413 (limit is 1 MB in setUp)
        too_big = b"x" * (1024 * 1024 + 10)
        res_413_plain = self.client.put("/api/v1/kv/sessions/too_big", data=too_big)
        self.assertEqual(res_413_plain.status_code, 413)

        # Oversized after gzip decompression -> 413
        too_big_gz = gzip.compress(too_big)
        self.assertLess(len(too_big_gz), 1024 * 1024)
        res_413_gz = self.client.put(
            "/api/v1/kv/sessions/too_big_gz",
            data=too_big_gz,
            headers={"Content-Encoding": "gzip"},
        )
        self.assertEqual(res_413_gz.status_code, 413)

    def test_unknown_store_404(self):
        self.assertEqual(self.client.get("/api/v1/kv/nope").status_code, 404)
        self.assertEqual(self.client.get("/api/v1/kv/nope/k1").status_code, 404)
        self.assertEqual(self.client.put("/api/v1/kv/nope/k1", data=b"{}").status_code, 404)
        self.assertEqual(self.client.delete("/api/v1/kv/nope/k1").status_code, 404)

    def test_existing_static_and_webdav_routes_still_work(self):
        static_res = self.client.get("/")
        self.assertEqual(static_res.status_code, 200)
        self.assertIn(b"workbench", static_res.content)

        tree_res = self.client.get("/api/webdav/tree")
        self.assertEqual(tree_res.status_code, 200)
        paths = [e["path"] for e in tree_res.json()["entries"]]
        self.assertIn("hello.txt", paths)


if __name__ == "__main__":
    unittest.main()