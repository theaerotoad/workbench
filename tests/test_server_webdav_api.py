import os
import sys
import tempfile
import unittest
import json
import asyncio

# Add repository root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server import create_app

try:
    from starlette.testclient import TestClient
except ImportError:
    TestClient = None


def make_asgi_request(app, path, query_string="", method="GET", headers=None):
    """Fallback ASGI caller when TestClient / httpx is not installed."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": query_string.encode("ascii"),
        "headers": headers or [],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 5050),
    }

    response_messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        response_messages.append(message)

    async def _run():
        await app(scope, receive, send)

    asyncio.run(_run())

    status_code = None
    resp_headers = {}
    body_parts = []
    for msg in response_messages:
        if msg["type"] == "http.response.start":
            status_code = msg["status"]
            resp_headers = {k.decode("latin1"): v.decode("latin1") for k, v in msg.get("headers", [])}
        elif msg["type"] == "http.response.body":
            body_parts.append(msg.get("body", b""))

    body_bytes = b"".join(body_parts)
    json_data = None
    try:
        json_data = json.loads(body_bytes.decode("utf-8"))
    except Exception:
        pass

    class SimpleResponse:
        def __init__(self, status, headers, data, raw):
            self.status_code = status
            self.headers = headers
            self.data = data
            self.content = raw
        def json(self):
            return self.data

    return SimpleResponse(status_code, resp_headers, json_data, body_bytes)


class TestWebDAVTreeAPI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root_path = self.temp_dir.name

        # Create root files
        with open(os.path.join(self.root_path, "README.md"), "w") as f:
            f.write("# Sample Workspace\n")
        with open(os.path.join(self.root_path, "package.json"), "w") as f:
            f.write('{"name": "test-pkg"}\n')
        with open(os.path.join(self.root_path, ".gitignore"), "w") as f:
            f.write("node_modules/\n*.log\n")

        # Create a src/ subfolder with files
        src_dir = os.path.join(self.root_path, "src")
        os.makedirs(src_dir, exist_ok=True)
        with open(os.path.join(src_dir, "index.js"), "w") as f:
            f.write("console.log('hello');\n")
        with open(os.path.join(src_dir, "style.css"), "w") as f:
            f.write("body { margin: 0; }\n")

        # Create a subproject folder with nested files
        subproject_dir = os.path.join(self.root_path, "subproject")
        subproject_data = os.path.join(subproject_dir, "data")
        os.makedirs(subproject_data, exist_ok=True)
        with open(os.path.join(subproject_dir, "app.py"), "w") as f:
            f.write("print('subproject app')\n")
        with open(os.path.join(subproject_data, "records.csv"), "w") as f:
            f.write("id,name\n1,alice\n")

        # Create ignored directories that must be skipped by the scan
        git_dir = os.path.join(self.root_path, ".git")
        os.makedirs(git_dir, exist_ok=True)
        with open(os.path.join(git_dir, "config"), "w") as f:
            f.write("[core]\n")

        node_modules_dir = os.path.join(self.root_path, "node_modules", "express")
        os.makedirs(node_modules_dir, exist_ok=True)
        with open(os.path.join(node_modules_dir, "index.js"), "w") as f:
            f.write("// express\n")

        pycache_dir = os.path.join(self.root_path, "__pycache__")
        os.makedirs(pycache_dir, exist_ok=True)
        with open(os.path.join(pycache_dir, "server.cpython-310.pyc"), "wb") as f:
            f.write(b"bytecode")

        venv_dir = os.path.join(self.root_path, "venv", "bin")
        os.makedirs(venv_dir, exist_ok=True)
        with open(os.path.join(venv_dir, "activate"), "w") as f:
            f.write("# activate\n")

        self.app = create_app(webdav_dir=self.root_path)
        if TestClient:
            self.client = TestClient(self.app)
        else:
            self.client = None

    def tearDown(self):
        self.temp_dir.cleanup()

    def _get(self, path):
        if self.client:
            return self.client.get(path)
        parts = path.split("?", 1)
        url_path = parts[0]
        query_string = parts[1] if len(parts) > 1 else ""
        return make_asgi_request(self.app, url_path, query_string=query_string)

    def test_webdav_tree_root(self):
        res = self._get("/api/webdav/tree")
        self.assertEqual(res.status_code, 200)
        data = res.json()

        self.assertIn("entries", data)
        self.assertIn("root", data)
        self.assertEqual(data["root"], "")

        paths = {e["path"]: e for e in data["entries"]}

        # Check root files and directories
        self.assertIn("README.md", paths)
        self.assertEqual(paths["README.md"]["kind"], "file")
        self.assertGreater(paths["README.md"]["size"], 0)
        self.assertIn("mtime", paths["README.md"])

        self.assertIn("src", paths)
        self.assertEqual(paths["src"]["kind"], "directory")

        self.assertIn("src/index.js", paths)
        self.assertEqual(paths["src/index.js"]["kind"], "file")

        # Check .gitignore content is loaded inline
        self.assertIn(".gitignore", paths)
        self.assertIn("content", paths[".gitignore"])
        self.assertIn("node_modules/", paths[".gitignore"]["content"])

        # Check .agent files are inlined
        agent_dir = os.path.join(self.root_path, ".agent")
        os.makedirs(agent_dir, exist_ok=True)
        with open(os.path.join(agent_dir, "models.json"), "w") as f:
            f.write('{"providers": []}')

        res_agent = self._get("/api/webdav/tree")
        self.assertEqual(res_agent.status_code, 200)
        agent_paths = {e["path"]: e for e in res_agent.json()["entries"]}
        self.assertIn(".agent/models.json", agent_paths)
        self.assertIn("content", agent_paths[".agent/models.json"])
        self.assertEqual(agent_paths[".agent/models.json"]["content"], '{"providers": []}')

        # Check ignored directories are filtered out
        for ignored in [".git", "node_modules", "__pycache__", "venv"]:
            self.assertNotIn(ignored, paths)
            for p in paths:
                self.assertFalse(p.startswith(ignored + "/"), f"Found ignored path entry: {p}")

    def test_webdav_tree_subfolder(self):
        res = self._get("/api/webdav/tree?path=subproject")
        self.assertEqual(res.status_code, 200)
        data = res.json()

        self.assertEqual(data["root"], "subproject")
        paths = {e["path"]: e for e in data["entries"]}

        # Paths should be relative to the subproject folder
        self.assertIn("app.py", paths)
        self.assertEqual(paths["app.py"]["kind"], "file")
        self.assertIn("data", paths)
        self.assertEqual(paths["data"]["kind"], "directory")
        self.assertIn("data/records.csv", paths)

        # Root files must not be present
        self.assertNotIn("README.md", paths)
        self.assertNotIn("src", paths)

    def test_webdav_tree_nested_subfolder_with_slashes(self):
        res = self._get("/api/webdav/tree?path=subproject/data/")
        self.assertEqual(res.status_code, 200)
        data = res.json()

        paths = {e["path"]: e for e in data["entries"]}
        self.assertIn("records.csv", paths)
        self.assertEqual(len(paths), 1)

    def test_webdav_tree_path_traversal_forbidden(self):
        # Direct parent directory
        res1 = self._get("/api/webdav/tree?path=../")
        self.assertEqual(res1.status_code, 403)

        # Nested escape
        res2 = self._get("/api/webdav/tree?path=subproject/../../")
        self.assertEqual(res2.status_code, 403)

    def test_webdav_tree_not_found(self):
        res = self._get("/api/webdav/tree?path=nonexistent_directory")
        self.assertEqual(res.status_code, 404)

    def test_webdav_tree_target_is_file_returns_400(self):
        res = self._get("/api/webdav/tree?path=README.md")
        self.assertEqual(res.status_code, 400)

    def test_webdav_events_connect(self):
        res = self._get("/api/webdav/events")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/event-stream", res.headers.get("content-type", ""))


if __name__ == "__main__":
    unittest.main()