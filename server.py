import os
import logging
import argparse
import uvicorn
import yaml
import hashlib
import time
import json
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.wsgi import WSGIMiddleware
from starlette.requests import Request
from starlette.responses import StreamingResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
import urllib.request
import urllib.error

# WebDAV imports
from wsgidav.wsgidav_app import WsgiDAVApp

# Local Proxy
from mcp_proxy import StdioToSSEProxy

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("unified_server")

def create_webdav_app(root_path: str):
    """
    Creates a WSGI WebDAV app mapped to the given directory.
    Uses anonymous access and matches the CORS configuration provided.
    """
    config = {
        "provider_mapping": {"/": root_path},
        # simple_dc with "*" : True grants anonymous access to all mapped paths
        "simple_dc": {"user_mapping": {"*": True}},
        "dir_browser": {"enable": True},
        "cors": {
            "enable": True,
            "allow_origin": "*",
            "allow_methods": "OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, COPY, MOVE, MKCOL, PROPFIND, PROPPATCH, LOCK, UNLOCK",
            "allow_headers": "Overwrite, Destination, Content-Type, Depth, User-Agent, Authorization"
        }
    }
    return WsgiDAVApp(config)

def create_app(webdav_dir=".", static_dir="extracted", jsutils_dir="jsutils", stdio_mcp_cfg=None, mcp_command=None):
    routes = []

    # 0. LLM Proxy Endpoint
    async def llm_proxy(request: Request):
        target_url = request.headers.get("x-proxy-target")
        if not target_url:
            return JSONResponse({"error": "Missing x-proxy-target header"}, status_code=400)
            
        method = request.method
        body = await request.body()
        
        headers = {}
        for k, v in request.headers.items():
            # Exclude accept-encoding so urllib doesn't receive compressed (gzip/br) bytes
            # that it does not automatically decompress for the caller.
            if k.lower() not in ("host", "x-proxy-target", "content-length", "connection", "accept-encoding"):
                headers[k] = v
                
        req = urllib.request.Request(target_url, data=body if body else None, headers=headers, method=method)
        
        def _make_request():
            try:
                # 600-second timeout to accommodate long generation runs on local diffusion/LLM backends
                resp = urllib.request.urlopen(req, timeout=600)
                content_type = resp.headers.get("content-type", "")
                is_sse = "text/event-stream" in content_type
                resp_headers = {}
                for k in ("content-type", "cache-control"):
                    if k in resp.headers:
                        resp_headers[k] = resp.headers[k]

                if is_sse:
                    return resp, resp.getcode(), resp_headers, True

                # For non-SSE responses (like /sdapi/v1/txt2img or /models), read the entire response body
                # in the threadpool so network buffers aren't truncated by Starlette's chunk iterator.
                content = resp.read()
                return content, resp.getcode(), resp_headers, False
            except urllib.error.HTTPError as e:
                try:
                    err_content = e.read()
                except Exception:
                    err_content = b""
                err_headers = {"content-type": e.headers.get("content-type", "application/json")}
                return err_content, e.getcode(), err_headers, False
            except Exception as e:
                return e, 500, {}, False

        result, status_code, resp_headers, is_sse = await run_in_threadpool(_make_request)
        
        if isinstance(result, Exception) and not isinstance(result, urllib.error.HTTPError):
            return JSONResponse({"error": str(result)}, status_code=500)
            
        if is_sse:
            def generate():
                try:
                    while True:
                        chunk = result.read(8192)
                        if not chunk:
                            break
                        yield chunk
                except Exception as stream_err:
                    logger.warning(f"SSE stream interrupted: {stream_err}")
                finally:
                    result.close()
                    
            return StreamingResponse(generate(), status_code=status_code, media_type="text/event-stream", headers=resp_headers)

        from starlette.responses import Response
        return Response(content=result, status_code=status_code, headers=resp_headers)

    routes.append(Route("/proxy", llm_proxy, methods=["GET", "POST", "PUT", "DELETE", "PATCH"]))

    # 1. MCP Stdio-to-SSE Proxy
    if stdio_mcp_cfg and os.path.exists(stdio_mcp_cfg):
        logger.info(f"Loading dynamic MCP servers from {stdio_mcp_cfg}")
        try:
            with open(stdio_mcp_cfg, "r") as f:
                config = yaml.safe_load(f)
                
            dynamic_servers = config.get("dynamic_servers", {})
            for name, server_cfg in dynamic_servers.items():
                command_str = server_cfg.get("command")
                command_args = server_cfg.get("args", [])
                mount_path = server_cfg.get("mount_path", name).strip("/")
                env_vars = server_cfg.get("env", {})
                
                if not command_str:
                    logger.warning(f"Server '{name}' is missing a 'command'. Skipping.")
                    continue
                    
                full_command = [command_str] + command_args
                logger.info(f"Configuring MCP Stdio proxy for '{name}' at /{mount_path}/sse")
                proxy = StdioToSSEProxy(full_command, env=env_vars)
                routes.extend([
                    Route(f"/{mount_path}/sse", proxy.handle_sse, methods=["GET"]),
                    Route(f"/{mount_path}/messages", proxy.handle_messages, methods=["POST"])
                ])
        except Exception as e:
            logger.error(f"Failed to load stdio MCP config: {e}")
    elif mcp_command:
        logger.info(f"Configuring single MCP Stdio proxy for command: {' '.join(mcp_command)}")
        proxy = StdioToSSEProxy(mcp_command)
        routes.extend([
            Route("/mcp/sse", proxy.handle_sse, methods=["GET"]),
            Route("/mcp/messages", proxy.handle_messages, methods=["POST"])
        ])
    else:
        logger.info("No --stdio-mcp-cfg or --mcp-command provided; skipping MCP proxy endpoints.")

    # 2. WebDAV File Serving
    webdav_path = os.path.abspath(webdav_dir)
    if os.path.exists(webdav_path):
        logger.info(f"Configuring WebDAV for directory: {webdav_path} at /webdav")
        webdav_wsgi = create_webdav_app(webdav_path)
        # Wrap the synchronous WSGI app in Starlette's WSGIMiddleware (runs it in a threadpool)
        routes.append(Mount("/webdav", app=WSGIMiddleware(webdav_wsgi)))
    else:
        logger.error(f"WebDAV directory '{webdav_path}' does not exist! Skipping.")

    # 2.1 WebDAV Fast Tree Scan Endpoint
    async def webdav_tree(request: Request):
        try:
            base_dir = os.path.abspath(webdav_dir)
            if not os.path.exists(base_dir) or not os.path.isdir(base_dir):
                return JSONResponse({"error": f"WebDAV directory does not exist: {base_dir}"}, status_code=500)

            raw_path = request.query_params.get("path", "").replace("\\", "/").strip("/")
            parts = [p for p in raw_path.split("/") if p and p != "."]
            if any(p == ".." for p in parts):
                return JSONResponse({"error": "Forbidden: Path traversal not allowed"}, status_code=403)

            clean_subpath = os.path.sep.join(parts) if parts else ""
            target_dir = os.path.abspath(os.path.join(base_dir, clean_subpath)) if clean_subpath else base_dir

            # Path Traversal & Boundary Guard
            if os.path.commonpath([base_dir, target_dir]) != base_dir:
                return JSONResponse({"error": "Forbidden: Path outside WebDAV root"}, status_code=403)

            if not os.path.exists(target_dir):
                return JSONResponse({"error": f"Path not found: {raw_path}"}, status_code=404)

            if not os.path.isdir(target_dir):
                return JSONResponse({"error": f"Target is not a directory: {raw_path}"}, status_code=400)

            IGNORED_DIR_NAMES = {
                ".git", "node_modules", "venv", ".venv", "__pycache__",
                "target", "build", "dist"
            }

            def _scan():
                entries = []
                def _walk(curr_dir, rel_prefix):
                    try:
                        with os.scandir(curr_dir) as it:
                            dir_entries = []
                            file_entries = []
                            for entry in it:
                                try:
                                    if entry.is_dir(follow_symlinks=False):
                                        if entry.name in IGNORED_DIR_NAMES:
                                            continue
                                        dir_entries.append(entry)
                                    elif entry.is_file(follow_symlinks=False):
                                        file_entries.append(entry)
                                except (OSError, PermissionError):
                                    continue

                            dir_entries.sort(key=lambda e: e.name)
                            file_entries.sort(key=lambda e: e.name)

                            for entry in dir_entries:
                                rel_path = f"{rel_prefix}/{entry.name}" if rel_prefix else entry.name
                                entries.append({
                                    "path": rel_path,
                                    "kind": "directory"
                                })
                                _walk(entry.path, rel_path)

                            for entry in file_entries:
                                rel_path = f"{rel_prefix}/{entry.name}" if rel_prefix else entry.name
                                try:
                                    stat = entry.stat(follow_symlinks=False)
                                    item = {
                                        "path": rel_path,
                                        "kind": "file",
                                        "size": stat.st_size,
                                        "mtime": round(stat.st_mtime, 3)
                                    }
                                    norm_rel = rel_path.replace("\\", "/")
                                    is_agent_text = (norm_rel.startswith(".agent/") or norm_rel == ".agent") and (
                                        entry.name.endswith(".json") or entry.name.endswith(".md") or entry.name.endswith(".js")
                                    )
                                    if (entry.name == ".gitignore" or is_agent_text) and stat.st_size < 262144:
                                        try:
                                            with open(entry.path, "r", encoding="utf-8", errors="replace") as gf:
                                                item["content"] = gf.read()
                                        except Exception:
                                            pass
                                    entries.append(item)
                                except (OSError, PermissionError):
                                    continue
                    except (OSError, PermissionError):
                        pass

                _walk(target_dir, "")
                root_mtime = 0
                try:
                    root_mtime = round(os.path.getmtime(target_dir), 3)
                except Exception:
                    pass
                return {
                    "root": raw_path,
                    "mtime": root_mtime,
                    "entries": entries
                }

            result = await run_in_threadpool(_scan)
            return JSONResponse(result)
        except Exception as e:
            logger.error(f"Failed to scan webdav tree: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)

    routes.append(Route("/api/webdav/tree", webdav_tree, methods=["GET"]))

    # 2.2 WebDAV SSE Real-Time Change Notification Endpoint
    async def webdav_events(request: Request):
        try:
            base_dir = os.path.abspath(webdav_dir)
            if not os.path.exists(base_dir) or not os.path.isdir(base_dir):
                return JSONResponse({"error": "WebDAV base directory does not exist"}, status_code=500)

            raw_path = request.query_params.get("path", "").replace("\\", "/").strip("/")
            parts = [p for p in raw_path.split("/") if p and p != "."]
            if any(p == ".." for p in parts):
                return JSONResponse({"error": "Forbidden: Path traversal not allowed"}, status_code=403)

            clean_subpath = os.path.sep.join(parts) if parts else ""
            target_dir = os.path.abspath(os.path.join(base_dir, clean_subpath)) if clean_subpath else base_dir

            if os.path.commonpath([base_dir, target_dir]) != base_dir or not os.path.exists(target_dir):
                return JSONResponse({"error": "Forbidden or invalid path"}, status_code=403)

            async def event_generator():
                yield ": connected\n\n"

                try:
                    import watchfiles
                    has_watchfiles = True
                except ImportError:
                    has_watchfiles = False

                if has_watchfiles:
                    try:
                        async for changes in watchfiles.awatch(target_dir, stop_event=None, debounce=150, step=50, rust_timeout=100):
                            if await request.is_disconnected():
                                break
                            valid = []
                            for c_type, c_path in changes:
                                rel = os.path.relpath(c_path, target_dir).replace("\\", "/")
                                if any(p in {".git", "node_modules", "__pycache__", "venv", ".venv"} for p in rel.split("/")):
                                    continue
                                valid.append({"path": rel, "type": c_type.name})
                            if valid:
                                payload = json.dumps({"changes": valid, "ts": round(time.time(), 3)})
                                yield f"event: change\ndata: {payload}\n\n"
                    except Exception:
                        pass
                else:
                    # In-process mtime change scanner
                    last_mtime = 0
                    try:
                        last_mtime = os.path.getmtime(target_dir)
                    except Exception:
                        pass

                    while not await request.is_disconnected():
                        await asyncio.sleep(2.0)
                        try:
                            curr_mtime = os.path.getmtime(target_dir)
                            if curr_mtime != last_mtime:
                                last_mtime = curr_mtime
                                payload = json.dumps({"changes": [{"path": "", "type": "modified"}], "ts": round(curr_mtime, 3)})
                                yield f"event: change\ndata: {payload}\n\n"
                        except Exception:
                            pass

            return StreamingResponse(
                event_generator(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no"
                }
            )
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    routes.append(Route("/api/webdav/events", webdav_events, methods=["GET"]))

    # 2.5 JS Utils File Serving & API
    jsutils_path = os.path.abspath(jsutils_dir)
    os.makedirs(jsutils_path, exist_ok=True)
    logger.info(f"Configuring JS Utils serving for directory: {jsutils_path} at /jsutils and /api/jsutils")

    async def list_jsutils(request: Request):
        try:
            if not os.path.exists(jsutils_path):
                return JSONResponse([])
            items = []
            for entry in sorted(os.listdir(jsutils_path)):
                if entry.endswith(".js") and os.path.isfile(os.path.join(jsutils_path, entry)):
                    fp = os.path.join(jsutils_path, entry)
                    try:
                        with open(fp, "rb") as f:
                            content = f.read()
                        header = f"blob {len(content)}\0".encode("utf-8")
                        sha = hashlib.sha1(header + content).hexdigest()
                        items.append({
                            "name": entry,
                            "type": "file",
                            "size": len(content),
                            "sha": sha,
                            "download_url": f"/jsutils/{entry}"
                        })
                    except Exception as fe:
                        logger.warning(f"Could not read {entry}: {fe}")
            return JSONResponse(items)
        except Exception as e:
            logger.error(f"Failed to list jsutils: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)

    routes.append(Route("/api/jsutils", list_jsutils, methods=["GET"]))
    routes.append(Route("/api/tools", list_jsutils, methods=["GET"]))
    routes.append(Mount("/jsutils", app=StaticFiles(directory=jsutils_path), name="jsutils"))

    # 3. Static Files (Frontend UI)
    static_dir_path = os.path.abspath(static_dir)
    if os.path.exists(static_dir_path):
        logger.info(f"Configuring Static HTML serving for directory: {static_dir_path} at /")
        routes.append(Mount("/", app=StaticFiles(directory=static_dir_path, html=True), name="static"))
    else:
        logger.warning(f"Static frontend directory '{static_dir_path}' does not exist. (If you want to view the UI, make sure this folder is present).")

    # Initialize ASGI App
    app = Starlette(debug=True, routes=routes)
    
    # Global CORS (Catches OPTIONS requests before they hit specific mounts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"]
    )
    return app

def main():
    parser = argparse.ArgumentParser(description="Unified Coding Agent Server")
    parser.add_argument("--port", type=int, default=5050, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--webdav-dir", type=str, default=".", help="Directory to serve via WebDAV")
    parser.add_argument("--static-dir", type=str, default="extracted", help="Directory to serve static HTML frontend from")
    parser.add_argument("--jsutils-dir", type=str, default="jsutils", help="Directory containing JS tool utilities to serve")
    parser.add_argument("--mcp-command", type=str, nargs="+", help="Command to run for MCP stdio (e.g., npx -y @modelcontextprotocol/server-everything)")
    parser.add_argument("--stdio-mcp-cfg", type=str, help="Path to YAML config for multiple dynamic stdio MCP servers")
    
    args = parser.parse_args()
    app = create_app(
        webdav_dir=args.webdav_dir,
        static_dir=args.static_dir,
        jsutils_dir=args.jsutils_dir,
        stdio_mcp_cfg=args.stdio_mcp_cfg,
        mcp_command=args.mcp_command
    )

    logger.info(f"Starting Unified Server on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")

if __name__ == "__main__":
    main()