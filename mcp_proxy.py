import os
import asyncio
import uuid
import logging
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

logger = logging.getLogger(__name__)

class StdioToSSEProxy:
    """
    Acts as a bridge between an HTTP/SSE frontend and a standard stdio-based MCP tool.
    - GET /sse: Spawns the stdio tool, streams stdout as SSE.
    - POST /messages: Writes incoming JSON-RPC payload to the tool's stdin.
    """
    def __init__(self, command: list[str], env: dict = None):
        self.command = command
        self.env = env or {}
        self.sessions = {}  # Maps session_id -> asyncio.subprocess.Process

    async def handle_sse(self, request: Request):
        session_id = str(uuid.uuid4())
        
        # Merge custom environment with the system environment
        merged_env = os.environ.copy()
        if self.env:
            # Ensure all env values are strings (subprocess requires string values)
            merged_env.update({k: str(v) for k, v in self.env.items()})

        try:
            logger.info(f"[{session_id}] Spawning MCP stdio process: {' '.join(self.command)}")
            process = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=merged_env
            )
        except Exception as e:
            logger.error(f"Failed to start MCP tool: {e}")
            return Response(f"Failed to start tool: {e}", status_code=500)
            
        self.sessions[session_id] = process
        
        async def event_generator():
            try:
                # Tell the client where to send POST messages
                # If request path is /mcp/sse, base_path becomes /mcp
                base_path = request.url.path.rsplit("/sse", 1)[0]
                endpoint_url = f"{base_path}/messages?sessionId={session_id}"
                
                logger.debug(f"[{session_id}] Sending endpoint event: {endpoint_url}")
                yield f"event: endpoint\ndata: {endpoint_url}\n\n"
                
                # Continuously read from stdout and forward as SSE messages
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        break
                    
                    decoded_line = line.decode('utf-8').strip()
                    if decoded_line:
                        yield f"event: message\ndata: {decoded_line}\n\n"
            except asyncio.CancelledError:
                logger.info(f"[{session_id}] Client disconnected.")
            finally:
                # Cleanup the subprocess on disconnect
                if process.returncode is None:
                    process.terminate()
                self.sessions.pop(session_id, None)
                logger.info(f"[{session_id}] Process terminated and session cleaned up.")

        # Stream stderr to the server logs in the background
        async def log_stderr():
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                logger.warning(f"[MCP {session_id} STDERR] {line.decode('utf-8').strip()}")
                
        asyncio.create_task(log_stderr())
        
        return StreamingResponse(event_generator(), media_type="text/event-stream")

    async def handle_messages(self, request: Request):
        session_id = request.query_params.get("sessionId")
        if not session_id or session_id not in self.sessions:
            logger.error(f"Message received for invalid or expired session: {session_id}")
            return Response("Invalid or missing sessionId", status_code=400)
            
        process = self.sessions[session_id]
        body = await request.body()
        
        if body:
            # MCP stdio protocol requires one JSON message per line
            process.stdin.write(body + b"\n")
            await process.stdin.drain()
            
        return Response("Accepted", status_code=202)