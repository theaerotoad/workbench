import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.parse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from lease_manager import LeaseManager
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
            return json.loads(self.content.decode("utf-8"))

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

    def post(self, url, data=b"", headers=None):
        return self.request("POST", url, data=data, headers=headers)

    def post_json(self, url, obj, headers=None):
        hdrs = {"Content-Type": "application/json"}
        if headers:
            hdrs.update(headers)
        return self.post(url, data=json.dumps(obj).encode("utf-8"), headers=hdrs)

    def close(self):
        if self._tc is not None:
            self._tc.close()


class TestLeaseManager(unittest.TestCase):
    def test_acquire_renew_conflict_and_workspace_isolation(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0)

            st1, b1 = await lm.acquire("ws-1", "tab-a", "client-1", "Chrome on Linux")
            self.assertEqual(st1, 200)
            self.assertTrue(b1["granted"])
            self.assertEqual(b1["lease"]["epoch"], 1)
            self.assertEqual(b1["lease"]["tabId"], "tab-a")

            # Renew by same tab keeps epoch and updates busy flag
            st2, b2 = await lm.acquire("ws-1", "tab-a", "client-1", "Chrome on Linux", busy=True)
            self.assertEqual(st2, 200)
            self.assertTrue(b2["granted"])
            self.assertEqual(b2["lease"]["epoch"], 1)
            self.assertTrue(b2["lease"]["busy"])

            # Another tab on the same workspace gets 409 busyConflict:false
            st3, b3 = await lm.acquire("ws-1", "tab-b", "client-2", "Firefox on macOS")
            self.assertEqual(st3, 409)
            self.assertFalse(b3["granted"])
            self.assertFalse(b3["busyConflict"])
            self.assertEqual(b3["holder"]["tabId"], "tab-a")
            self.assertTrue(b3["holder"]["busy"])

            # Different workspace is independent and granted
            st4, b4 = await lm.acquire("ws-2", "tab-b", "client-2", "Firefox on macOS")
            self.assertEqual(st4, 200)
            self.assertTrue(b4["granted"])
            self.assertEqual(b4["lease"]["epoch"], 1)

        asyncio.run(run())

    def test_ttl_expiry(self):
        async def run():
            lm = LeaseManager(ttl_sec=0.1)
            st1, b1 = await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")
            self.assertEqual(st1, 200)
            self.assertEqual(b1["lease"]["epoch"], 1)

            await asyncio.sleep(0.15)

            st2, b2 = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B")
            self.assertEqual(st2, 200)
            self.assertTrue(b2["granted"])
            self.assertEqual(b2["lease"]["tabId"], "tab-b")
            self.assertEqual(b2["lease"]["epoch"], 2)

        asyncio.run(run())

    def test_stream_keeps_lease_live_past_ttl(self):
        async def run():
            lm = LeaseManager(ttl_sec=0.1)
            st1, _ = await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")
            self.assertEqual(st1, 200)
            q = lm.open_stream("ws-1", "tab-a")

            await asyncio.sleep(0.3)

            # Still live because SSE stream is open
            st2, b2 = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B")
            self.assertEqual(st2, 409)
            self.assertFalse(b2["granted"])
            self.assertTrue(b2["holder"]["connected"])

            # Closing stream starts grace period (ttl_sec)
            lm.close_stream("ws-1", "tab-a", q)
            st3, _ = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B")
            self.assertEqual(st3, 409)

            await asyncio.sleep(0.15)

            # After grace period, B acquires without force
            st4, b4 = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B")
            self.assertEqual(st4, 200)
            self.assertTrue(b4["granted"])
            self.assertEqual(b4["lease"]["tabId"], "tab-b")

        asyncio.run(run())

    def test_release_holder_vs_non_holder(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0)
            await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")

            self.assertFalse(lm.release("ws-1", "tab-b"))
            self.assertIsNotNone(lm.inspect("ws-1"))

            self.assertTrue(lm.release("ws-1", "tab-a"))
            self.assertIsNone(lm.inspect("ws-1"))

            st, body = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B")
            self.assertEqual(st, 200)
            self.assertEqual(body["lease"]["tabId"], "tab-b")
            self.assertEqual(body["lease"]["epoch"], 2)

        asyncio.run(run())

    def test_busy_protection(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0)
            await lm.acquire("ws-1", "tab-a", "client-1", "Tab A", busy=True)

            # force without abort_busy -> 409 busyConflict:true
            st1, b1 = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B", force=True, abort_busy=False)
            self.assertEqual(st1, 409)
            self.assertFalse(b1["granted"])
            self.assertTrue(b1["busyConflict"])
            self.assertEqual(b1["holder"]["tabId"], "tab-a")

            # force with abort_busy -> 200, epoch 2, displacedTabId == tab-a
            st2, b2 = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B", force=True, abort_busy=True)
            self.assertEqual(st2, 200)
            self.assertTrue(b2["granted"])
            self.assertEqual(b2["lease"]["epoch"], 2)
            self.assertEqual(b2["displacedTabId"], "tab-a")
            self.assertFalse(b2["handedOffCleanly"])

        asyncio.run(run())

    def test_cooperative_handoff_and_in_flight_conflicts(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0, handoff_timeout_sec=2.0)
            await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")
            qa = lm.open_stream("ws-1", "tab-a")

            t0 = time.monotonic()
            b_task = asyncio.create_task(
                lm.acquire("ws-1", "tab-b", "client-2", "Tab B", force=True)
            )

            event_name, payload = await asyncio.wait_for(qa.get(), timeout=0.5)
            self.assertEqual(event_name, "revoke")
            self.assertEqual(payload["newLabel"], "Tab B")
            self.assertFalse(payload["abortBusy"])
            handoff_id = payload["handoffId"]
            self.assertTrue(handoff_id)

            # While B is waiting: A's heartbeat gets 409 (new lease already installed)
            st_a, body_a = await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")
            self.assertEqual(st_a, 409)
            self.assertFalse(body_a["granted"])
            self.assertEqual(body_a["holder"]["tabId"], "tab-b")

            # While B is waiting: C's force gets 409 handoffInProgress
            st_c, body_c = await lm.acquire("ws-1", "tab-c", "client-3", "Tab C", force=True)
            self.assertEqual(st_c, 409)
            self.assertFalse(body_c["granted"])
            self.assertTrue(body_c["handoffInProgress"])

            # Wrong handoff id or wrong tab id is rejected
            self.assertFalse(lm.ack("ws-1", "tab-a", "wrong-id"))
            self.assertFalse(lm.ack("ws-1", "tab-c", handoff_id))

            # A acks -> B completes cleanly and quickly
            self.assertTrue(lm.ack("ws-1", "tab-a", handoff_id))
            st_b, body_b = await b_task
            elapsed = time.monotonic() - t0

            self.assertLess(elapsed, 0.2)
            self.assertEqual(st_b, 200)
            self.assertTrue(body_b["granted"])
            self.assertTrue(body_b["handedOffCleanly"])
            self.assertEqual(body_b["displacedTabId"], "tab-a")
            self.assertEqual(body_b["lease"]["epoch"], 2)

        asyncio.run(run())

    def test_handoff_timeout(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0, handoff_timeout_sec=0.15)
            await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")
            qa = lm.open_stream("ws-1", "tab-a")

            t0 = time.monotonic()
            st_b, body_b = await lm.acquire("ws-1", "tab-b", "client-2", "Tab B", force=True)
            elapsed = time.monotonic() - t0

            self.assertGreaterEqual(elapsed, 0.12)
            self.assertLess(elapsed, 0.5)
            self.assertEqual(st_b, 200)
            self.assertTrue(body_b["granted"])
            self.assertFalse(body_b["handedOffCleanly"])
            self.assertEqual(body_b["displacedTabId"], "tab-a")
            self.assertFalse(qa.empty())

        asyncio.run(run())

    def test_old_tab_disconnects_mid_handoff(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0, handoff_timeout_sec=2.0)
            await lm.acquire("ws-1", "tab-a", "client-1", "Tab A")
            qa = lm.open_stream("ws-1", "tab-a")

            t0 = time.monotonic()
            b_task = asyncio.create_task(
                lm.acquire("ws-1", "tab-b", "client-2", "Tab B", force=True)
            )

            await asyncio.wait_for(qa.get(), timeout=0.5)
            lm.close_stream("ws-1", "tab-a", qa)

            st_b, body_b = await b_task
            elapsed = time.monotonic() - t0

            self.assertLess(elapsed, 0.3)
            self.assertEqual(st_b, 200)
            self.assertTrue(body_b["granted"])
            self.assertFalse(body_b["handedOffCleanly"])
            self.assertEqual(body_b["displacedTabId"], "tab-a")

        asyncio.run(run())

    def test_same_client_ghost_reclaim(self):
        async def run():
            lm = LeaseManager(ttl_sec=30.0)
            now = [1000.0]
            with mock.patch("lease_manager.time.time", side_effect=lambda: now[0]):
                st1, b1 = await lm.acquire("ws-1", "tab-a", "client-x", "Chrome")
                self.assertEqual(st1, 200)
                self.assertEqual(b1["lease"]["epoch"], 1)

                # Within 2s guard: same client without stream still gets 409
                now[0] = 1001.5
                st_early, _ = await lm.acquire("ws-1", "tab-a2", "client-x", "Chrome")
                self.assertEqual(st_early, 409)

                # After >2s: different clientId still gets 409
                now[0] = 1003.0
                st_other, _ = await lm.acquire("ws-1", "tab-other", "client-y", "Firefox")
                self.assertEqual(st_other, 409)

                # Same clientId with no stream reclaims without force (epoch + 1)
                st_reclaim, b_reclaim = await lm.acquire("ws-1", "tab-a2", "client-x", "Chrome")
                self.assertEqual(st_reclaim, 200)
                self.assertTrue(b_reclaim["granted"])
                self.assertEqual(b_reclaim["lease"]["epoch"], 2)
                self.assertEqual(b_reclaim["lease"]["tabId"], "tab-a2")
                self.assertEqual(b_reclaim["displacedTabId"], "tab-a")

                # If current tab HAS an open stream (Duplicate Tab), same clientId gets 409 even after >2s
                lm.open_stream("ws-1", "tab-a2")
                now[0] = 1010.0
                st_dup, _ = await lm.acquire("ws-1", "tab-a3", "client-x", "Chrome")
                self.assertEqual(st_dup, 409)

        asyncio.run(run())


class TestLeaseHTTPAPI(unittest.TestCase):
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

        self.app = create_app(
            webdav_dir=self.webdav_dir,
            static_dir=self.static_dir,
            data_dir=self.data_dir,
        )
        self.client = _AppClient(self.app)

    def tearDown(self):
        self.client.close()
        if getattr(self.app.state, "state_store", None) is not None:
            self.app.state.state_store.close()
        self.temp_dir.cleanup()

    def test_capabilities_and_503_when_disabled(self):
        app_disabled = create_app(webdav_dir=self.webdav_dir, static_dir=self.static_dir)
        client = _AppClient(app_disabled)
        try:
            res = client.get("/api/v1/capabilities")
            self.assertEqual(res.status_code, 200)
            caps = res.json()
            self.assertFalse(caps["persistence"])
            self.assertFalse(caps["leases"])
            self.assertEqual(caps["leaseHeartbeatMs"], 10000)
            self.assertEqual(caps["leasePollMs"], 5000)

            self.assertEqual(client.get("/api/v1/leases?wsKey=w1").status_code, 503)
            self.assertEqual(
                client.post_json(
                    "/api/v1/leases",
                    {"wsKey": "w1", "tabId": "t1", "clientId": "c1", "label": "Chrome"},
                ).status_code,
                503,
            )
            self.assertEqual(
                client.post_json(
                    "/api/v1/leases/ack",
                    {"wsKey": "w1", "tabId": "t1", "handoffId": "h1"},
                ).status_code,
                503,
            )
            self.assertEqual(
                client.post_json(
                    "/api/v1/leases/release",
                    {"wsKey": "w1", "tabId": "t1"},
                ).status_code,
                503,
            )
            self.assertEqual(
                client.get("/api/v1/leases/events?wsKey=w1&tabId=t1").status_code,
                503,
            )
        finally:
            client.close()

    def test_capabilities_when_enabled(self):
        res = self.client.get("/api/v1/capabilities")
        self.assertEqual(res.status_code, 200)
        caps = res.json()
        self.assertTrue(caps["persistence"])
        self.assertTrue(caps["leases"])
        self.assertEqual(caps["leaseTtlMs"], 30000)
        self.assertEqual(caps["leaseHeartbeatMs"], 10000)
        self.assertEqual(caps["leasePollMs"], 5000)

    def test_validation_returns_400(self):
        # Missing / invalid wsKey on GET
        self.assertEqual(self.client.get("/api/v1/leases").status_code, 400)
        self.assertEqual(self.client.get("/api/v1/leases?wsKey=").status_code, 400)
        self.assertEqual(self.client.get("/api/v1/leases?wsKey=" + ("a" * 1025)).status_code, 400)

        # Invalid JSON / non-object JSON
        self.assertEqual(self.client.post("/api/v1/leases", data=b"not-json").status_code, 400)
        self.assertEqual(self.client.post("/api/v1/leases", data=b"[]").status_code, 400)

        # Missing or overlong fields on POST /api/v1/leases
        self.assertEqual(
            self.client.post_json("/api/v1/leases", {"wsKey": "", "tabId": "t1", "clientId": "c1"}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post_json("/api/v1/leases", {"wsKey": "w1", "tabId": "x" * 129, "clientId": "c1"}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post_json("/api/v1/leases", {"wsKey": "w1", "tabId": "t1", "clientId": ""}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post_json(
                "/api/v1/leases",
                {"wsKey": "w1", "tabId": "t1", "clientId": "c1", "label": 123},
            ).status_code,
            400,
        )

        # Missing fields on ack / release / events
        self.assertEqual(
            self.client.post_json("/api/v1/leases/ack", {"wsKey": "w1", "tabId": "t1"}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post_json("/api/v1/leases/release", {"wsKey": "w1"}).status_code,
            400,
        )
        self.assertEqual(self.client.get("/api/v1/leases/events?wsKey=w1").status_code, 400)

    def test_acquire_inspect_conflict_and_release_roundtrip(self):
        ws_key = "webdav::http://127.0.0.1:5050/webdav/my project/café"
        encoded_ws = urllib.parse.quote(ws_key, safe="")

        # Initially free
        r0 = self.client.get(f"/api/v1/leases?wsKey={encoded_ws}")
        self.assertEqual(r0.status_code, 200)
        self.assertEqual(r0.json(), {"holder": None})

        # Acquire by Tab A (also verifies label truncation to 80 chars)
        long_label = "L" * 120
        r1 = self.client.post_json(
            "/api/v1/leases",
            {"wsKey": ws_key, "tabId": "tab-a", "clientId": "client-1", "label": long_label},
        )
        self.assertEqual(r1.status_code, 200)
        body1 = r1.json()
        self.assertTrue(body1["granted"])
        self.assertEqual(body1["lease"]["epoch"], 1)
        self.assertEqual(len(body1["lease"]["label"]), 80)

        # Inspect returns holder
        r_insp = self.client.get(f"/api/v1/leases?wsKey={encoded_ws}")
        self.assertEqual(r_insp.status_code, 200)
        self.assertEqual(r_insp.json()["holder"]["tabId"], "tab-a")

        # Tab B without force -> 409
        r2 = self.client.post_json(
            "/api/v1/leases",
            {"wsKey": ws_key, "tabId": "tab-b", "clientId": "client-2", "label": "Tab B"},
        )
        self.assertEqual(r2.status_code, 409)
        self.assertFalse(r2.json()["granted"])
        self.assertFalse(r2.json()["busyConflict"])
        self.assertEqual(r2.json()["holder"]["tabId"], "tab-a")

        # Ack with no pending handoff -> ok: false
        r_ack = self.client.post_json(
            "/api/v1/leases/ack",
            {"wsKey": ws_key, "tabId": "tab-a", "handoffId": "nope"},
        )
        self.assertEqual(r_ack.status_code, 200)
        self.assertEqual(r_ack.json(), {"ok": False})

        # Release with text/plain Content-Type (navigator.sendBeacon compatibility)
        beacon_body = json.dumps({"wsKey": ws_key, "tabId": "tab-a"}).encode("utf-8")
        r_rel = self.client.post(
            "/api/v1/leases/release",
            data=beacon_body,
            headers={"Content-Type": "text/plain;charset=UTF-8"},
        )
        self.assertEqual(r_rel.status_code, 200)
        self.assertEqual(r_rel.json(), {"released": True})

        # Now free again and Tab B can acquire
        r3 = self.client.post_json(
            "/api/v1/leases",
            {"wsKey": ws_key, "tabId": "tab-b", "clientId": "client-2", "label": "Tab B"},
        )
        self.assertEqual(r3.status_code, 200)
        self.assertTrue(r3.json()["granted"])
        self.assertEqual(r3.json()["lease"]["tabId"], "tab-b")
        self.assertEqual(r3.json()["lease"]["epoch"], 2)


if __name__ == "__main__":
    unittest.main()