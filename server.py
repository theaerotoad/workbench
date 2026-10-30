import os
import logging
import argparse
import uvicorn
import yaml
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.wsgi import WSGIMiddleware

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
    parser.add_argument("--mcp-command", type=str, nargs="+", help="Command to run for MCP stdio (e.g., npx -y @modelcontextprotocol/server-everything)")
    parser.add_argument("--stdio-mcp-cfg", type=str, help="Path to YAML config for multiple dynamic stdio MCP servers")
    
    args = parser.parse_args()
    routes = []

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