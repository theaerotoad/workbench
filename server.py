import os
import logging
import argparse
import uvicorn
import yaml
import hashlib
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
            if k.lower() not in ("host", "x-proxy-target", "content-length", "connection"):
                headers[k] = v
                
        req = urllib.request.Request(target_url, data=body if body else None, headers=headers, method=method)
        
        def _make_request():
            try:
                resp = urllib.request.urlopen(req)
                return resp, resp.getcode()
            except urllib.error.HTTPError as e:
                return e, e.getcode()
            except Exception as e:
                return e, 500

        result, status_code = await run_in_threadpool(_make_request)
        
        if isinstance(result, Exception) and not isinstance(result, urllib.error.HTTPError):
            return JSONResponse({"error": str(result)}, status_code=500)
            
        def generate():
            try:
                while True:
                    chunk = result.read(8192)
                    if not chunk:
                        break
                    yield chunk
            finally:
                result.close()
                
        return StreamingResponse(generate(), status_code=status_code)

    routes.append(Route("/proxy", llm_proxy, methods=["GET", "POST", "PUT", "DELETE", "PATCH"]))

    # 1. MCP Stdio-to-SSE Proxy
    if args.stdio_mcp_cfg and os.path.exists(args.stdio_mcp_cfg):
        logger.info(f"Loading dynamic MCP servers from {args.stdio_mcp_cfg}")
        try:
            with open(args.stdio_mcp_cfg, "r") as f:
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
    elif args.mcp_command:
        logger.info(f"Configuring single MCP Stdio proxy for command: {' '.join(args.mcp_command)}")
        proxy = StdioToSSEProxy(args.mcp_command)
        routes.extend([
            Route("/mcp/sse", proxy.handle_sse, methods=["GET"]),
            Route("/mcp/messages", proxy.handle_messages, methods=["POST"])
        ])
    else:
        logger.info("No --stdio-mcp-cfg or --mcp-command provided; skipping MCP proxy endpoints.")

    # 2. WebDAV File Serving
    webdav_path = os.path.abspath(args.webdav_dir)
    if os.path.exists(webdav_path):
        logger.info(f"Configuring WebDAV for directory: {webdav_path} at /webdav")
        webdav_wsgi = create_webdav_app(webdav_path)
        # Wrap the synchronous WSGI app in Starlette's WSGIMiddleware (runs it in a threadpool)
        routes.append(Mount("/webdav", app=WSGIMiddleware(webdav_wsgi)))
    else:
        logger.error(f"WebDAV directory '{webdav_path}' does not exist! Skipping.")

    # 2.5 JS Utils File Serving & API
    jsutils_path = os.path.abspath(args.jsutils_dir)
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
    static_dir = os.path.abspath(args.static_dir)
    if os.path.exists(static_dir):
        logger.info(f"Configuring Static HTML serving for directory: {static_dir} at /")
        routes.append(Mount("/", app=StaticFiles(directory=static_dir, html=True), name="static"))
    else:
        logger.warning(f"Static frontend directory '{static_dir}' does not exist. (If you want to view the UI, make sure this folder is present).")

    # Initialize ASGI App
    app = Starlette(debug=True, routes=routes)
    
    # Global CORS (Catches OPTIONS requests before they hit specific mounts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"]
    )

    logger.info(f"Starting Unified Server on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")

if __name__ == "__main__":
    main()