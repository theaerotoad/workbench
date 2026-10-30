#!/usr/bin/env python3
import argparse
import urllib.request
import urllib.parse
import json
import threading
import time
import curses
import os
import sys

def fetch_mcp_tools(url):
    print(f"Connecting to MCP SSE endpoint: {url}")
    req = urllib.request.Request(url, headers={'Accept': 'text/event-stream'})
    
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"Failed to connect to {url}: {e}")
        sys.exit(1)
        
    post_endpoint = None
    tools = None
    init_done = False

    def read_sse():
        nonlocal post_endpoint, tools, init_done
        event_type = "message"
        data_buffer = []
        try:
            for line in response:
                line = line.decode('utf-8')
                
                # Strip trailing newlines according to standard SSE spec
                if line.endswith('\r\n'):
                    line = line[:-2]
                elif line.endswith('\n'):
                    line = line[:-1]
                    
                if not line: # Empty line marks the end of an event
                    if data_buffer:
                        data = "\n".join(data_buffer)
                        if event_type == "endpoint":
                            post_endpoint = data
                        elif event_type == "message":
                            try:
                                msg = json.loads(data)
                                if msg.get("id") == 1:
                                    init_done = True
                                elif msg.get("id") == 2:
                                    tools = msg.get("result", {}).get("tools", [])
                                    break
                            except json.JSONDecodeError:
                                pass
                        data_buffer = []
                    event_type = "message"
                    continue
                    
                if line.startswith("event:"):
                    event_type = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    data_buffer.append(line[len("data:"):].lstrip(' '))
        except Exception:
            pass
            
    # Read stream in background so we can send the POST request once endpoint is received
    t = threading.Thread(target=read_sse)
    t.daemon = True
    t.start()
    
    # Wait for endpoint discovery via SSE
    start_time = time.time()
    while post_endpoint is None:
        if time.time() - start_time > 10:
            print("Timeout waiting for 'endpoint' event from SSE stream.")
            sys.exit(1)
        time.sleep(0.1)
        
    target_url = post_endpoint
    if target_url.startswith('/'):
        parsed = urllib.parse.urlparse(url)
        target_url = f"{parsed.scheme}://{parsed.netloc}{target_url}"
    elif not target_url.startswith('http'):
        parsed = urllib.parse.urlparse(url)
        target_url = f"{parsed.scheme}://{parsed.netloc}/{target_url}"
        
    print(f"Discovered POST endpoint: {target_url}")
    print("Initializing MCP connection...")
    
    def post_json(payload_dict):
        req = urllib.request.Request(
            target_url, 
            method="POST", 
            headers={"Content-Type": "application/json"}
        )
        data = json.dumps(payload_dict).encode('utf-8')
        urllib.request.urlopen(req, data=data, timeout=10)

    # 1. Send initialize
    try:
        post_json({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "mcp-to-ion",
                    "version": "1.0.0"
                }
            }
        })
    except Exception as e:
        print(f"Failed to send initialize request: {e}")
        sys.exit(1)

    # Wait for initialize response
    start_time = time.time()
    while not init_done:
        if time.time() - start_time > 10:
            print("Timeout waiting for initialize response.")
            sys.exit(1)
        time.sleep(0.1)

    # 2. Send initialized notification
    try:
        post_json({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        })
    except Exception as e:
        print(f"Failed to send initialized notification: {e}")
        sys.exit(1)

    print("Requesting tools list...")
    
    # 3. Send tools/list request
    try:
        post_json({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        })
    except Exception as e:
        print(f"Failed to send tools/list request: {e}")
        sys.exit(1)
        
    # Wait for the tools response to bubble up in our SSE thread
    start_time = time.time()
    while tools is None:
        if time.time() - start_time > 10:
            print("Timeout waiting for tools response.")
            sys.exit(1)
        time.sleep(0.1)
        
    return tools

def select_tools_ui(stdscr, tools):
    curses.curs_set(0)
    current_row = 0
    offset = 0
    selected = set()
    
    while True:
        stdscr.clear()
        max_y, max_x = stdscr.getmaxyx()
        visible_items = max_y - 4
        
        if visible_items < 1:
            stdscr.addstr(0, 0, "Terminal too small!")
            stdscr.getch()
            return []
            
        stdscr.addstr(0, 0, "Select MCP tools to bundle into Ion (Space: toggle, Enter: confirm, 'q': quit, 'a': select all)")
        stdscr.addstr(1, 0, "-" * (max_x - 1))
        
        for idx in range(offset, min(offset + visible_items, len(tools))):
            tool = tools[idx]
            y = idx - offset + 2
            marker = "[x]" if idx in selected else "[ ]"
            
            desc = tool.get('description', '')
            desc_clean = desc.replace('\n', ' ')
            max_desc_len = max_x - 10 - len(tool['name'])
            if max_desc_len > 0 and len(desc_clean) > max_desc_len:
                desc_clean = desc_clean[:max_desc_len-3] + "..."
            elif max_desc_len <= 0:
                desc_clean = ""
                
            line = f"{marker} {tool['name']} - {desc_clean}"
            if len(line) >= max_x:
                line = line[:max_x-1]
                
            if idx == current_row:
                stdscr.attron(curses.A_REVERSE)
                stdscr.addstr(y, 2, line)
                stdscr.attroff(curses.A_REVERSE)
            else:
                stdscr.addstr(y, 2, line)
                
        key = stdscr.getch()
        
        if key == curses.KEY_UP and current_row > 0:
            current_row -= 1
            if current_row < offset:
                offset = current_row
        elif key == curses.KEY_DOWN and current_row < len(tools) - 1:
            current_row += 1
            if current_row >= offset + visible_items:
                offset = current_row - visible_items + 1
        elif key == ord(' '):
            if current_row in selected:
                selected.remove(current_row)
            else:
                selected.add(current_row)
        elif key in (ord('a'), ord('A')):
            if len(selected) == len(tools):
                selected.clear()
            else:
                selected = set(range(len(tools)))
        elif key == ord('\n'):
            break
        elif key in (ord('q'), ord('Q')):
            return []
            
    return [tools[i] for i in selected]

def generate_bundle_js(tools, url, out_dir, bundle_name):
    # Construct a robust prompt-friendly description mapping out each nested schema
    desc_lines = ["Provides multiplexed access to the following MCP capabilities:"]
    enum_names = []
    
    for t in tools:
        enum_names.append(t["name"])
        desc_lines.append(f"\n--- Tool: {t['name']} ---")
        if "description" in t:
            desc_lines.append(f"Description: {t['description']}")
        if "inputSchema" in t:
            desc_lines.append(f"Arguments Schema: {json.dumps(t['inputSchema'])}")
            
    full_desc = "\n".join(desc_lines)
    
    # Generate the single bundled file
    js = f"""// Auto-generated Ion tool bundle for MCP capabilities at {url}
const TOOL_META = {{
    name: {json.dumps(bundle_name)},
    description: {json.dumps(full_desc)},
    parameters: {{
        type: "object",
        properties: {{
            tool_name: {{
                type: "string",
                enum: {json.dumps(enum_names)},
                description: "The specific MCP tool to call."
            }},
            tool_args: {{
                type: "object",
                description: "An object containing the arguments required by the specified tool.",
                additionalProperties: true
            }}
        }},
        required: ["tool_name"]
    }},
    modes: ["plan", "ask", "code"],
    permission: "ask",
    toolBox: 1
}};

async function handler(args, api) {{
    const updateStatus = (msg) => {{
        if (typeof api?.setHeaderMsg === 'function') api.setHeaderMsg(msg);
    }};
    
    const mcpUrl = {json.dumps(url)};
    const toolName = args.tool_name;
    
    if (!toolName) {{
        return "ERROR: tool_name is required.";
    }}
    
    const toolArgs = args.tool_args || {{}};

    updateStatus("Connecting to " + toolName + " via MCP...");

    return new Promise((resolve) => {{
        let es;
        try {{
            es = new EventSource(mcpUrl);
        }} catch (err) {{
            return resolve("ERROR: Failed to instantiate EventSource: " + err.message);
        }}

        let messageId = Date.now();
        let timeoutTimer = setTimeout(() => {{
            if (es) es.close();
            resolve("ERROR: MCP request timed out after 60 seconds.");
        }}, 60000);

        const cleanup = () => {{
            clearTimeout(timeoutTimer);
            if (es) es.close();
        }};

        es.onerror = () => {{
            cleanup();
            resolve("ERROR: EventSource error. Could not connect or lost connection to MCP server at " + mcpUrl);
        }};

        let targetUrl = "";

        es.addEventListener("endpoint", async (event) => {{
            const postEndpoint = event.data;
            targetUrl = postEndpoint;
            if (targetUrl.startsWith('/')) {{
                targetUrl = new URL(mcpUrl).origin + targetUrl;
            }} else if (!targetUrl.startsWith('http')) {{
                targetUrl = new URL(mcpUrl).origin + '/' + targetUrl;
            }}

            // 1. Send initialize
            const initPayload = {{
                jsonrpc: "2.0",
                id: messageId,
                method: "initialize",
                params: {{
                    protocolVersion: "2024-11-05",
                    capabilities: {{}},
                    clientInfo: {{ name: "ion-bundled-tool", version: "1.0.0" }}
                }}
            }};

            try {{
                const res = await api.httpPost(targetUrl, {{
                    headers: {{ "Content-Type": "application/json" }},
                    body: JSON.stringify(initPayload),
                    timeoutMs: 10000
                }});
                if (res.error || !res.ok) {{
                    cleanup();
                    resolve("ERROR: Init HTTP POST failed: " + (res.error || res.status));
                }}
            }} catch (e) {{
                cleanup();
                resolve("ERROR: Init POST exception: " + e.message);
            }}
        }});

        es.onmessage = async (event) => {{
            try {{
                const data = JSON.parse(event.data);
                
                // Handle initialize response
                if (data.jsonrpc === "2.0" && data.id === messageId) {{
                    if (data.error) {{
                        cleanup();
                        return resolve("MCP Init Error: " + (data.error.message || JSON.stringify(data.error)));
                    }}

                    // 2. Send notifications/initialized
                    await api.httpPost(targetUrl, {{
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify({{ jsonrpc: "2.0", method: "notifications/initialized" }}),
                        timeoutMs: 10000
                    }});

                    // 3. Send tools/call
                    const callPayload = {{
                        jsonrpc: "2.0",
                        id: messageId + 1,
                        method: "tools/call",
                        params: {{
                            name: toolName,
                            arguments: toolArgs
                        }}
                    }};
                    
                    const res = await api.httpPost(targetUrl, {{
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify(callPayload),
                        timeoutMs: 50000
                    }});
                    
                    if (res.error || !res.ok) {{
                        cleanup();
                        resolve("ERROR: Call HTTP POST failed: " + (res.error || res.status));
                    }}
                }}
                // Handle tools/call response
                else if (data.jsonrpc === "2.0" && data.id === (messageId + 1)) {{
                    cleanup();
                    if (data.error) {{
                        return resolve("MCP Server Error: " + (data.error.message || JSON.stringify(data.error)));
                    }}
                    
                    const contentList = data.result?.content || [];
                    let hasError = data.result?.isError || false;
                    
                    let outputText = "";
                    let html = '<div style="padding: 10px; font-family: var(--font-mono); font-size: 12px; max-height: 400px; overflow-y: auto;">';
                    html += '<div style="color: var(--dim); margin-bottom: 8px; font-weight: 600;">Tool Executed: <span style="color: var(--fg);">' + toolName + '</span></div>';
                    
                    for (const item of contentList) {{
                        if (item.type === "text") {{
                            outputText += item.text + "\\n";
                            const escaped = item.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                            html += '<div style="white-space: pre-wrap; padding: 6px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; margin-bottom: 8px; color: ' + (hasError ? 'var(--red)' : 'var(--fg)') + ';">' + escaped + '</div>';
                        }} else if (item.type === "image") {{
                            outputText += "[Image Data returned]\\n";
                            html += '<div style="color: var(--dim); font-style: italic;">[Image response hidden]</div>';
                        }} else if (item.type === "resource") {{
                            outputText += "[Resource: " + item.resource?.uri + "]\\n" + (item.resource?.text || '') + "\\n";
                        }}
                    }}
                    html += '</div>';
                    
                    await api.showUI(html);
                    resolve({{
                        output: outputText.trim() || "(Empty response from tool)",
                        summary: "MCP: " + toolName + (hasError ? ' (Error)' : ' (Success)')
                    }});
                }}
            }} catch(e) {{}}
        }};
    }});
}}
"""
    filepath = os.path.join(out_dir, f"{bundle_name}.js")
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(js)
    return filepath

def main():
    parser = argparse.ArgumentParser(description="Map MCP SSE tools to a bundled Ion JS tool interactively.")
    parser.add_argument("url", help="MCP SSE Endpoint URL (e.g., http://localhost:3001/sse)")
    parser.add_argument("--jsout", default=".agent/tools", help="Output directory for JS tool files (default: .agent/tools)")
    parser.add_argument("--name", default="mcp_tools", help="Name of the bundled tool (default: mcp_tools)")
    args = parser.parse_args()

    # Step 1: Query the endpoint and resolve the tools list via JSON-RPC over SSE
    tools = fetch_mcp_tools(args.url)
    
    if not tools:
        print("No tools found on this MCP server.")
        sys.exit(0)
        
    # Step 2: Show interactive curses terminal for the user to make a selection
    try:
        selected_tools = curses.wrapper(select_tools_ui, tools)
    except Exception as e:
        print(f"Interactive UI failed (are you running in a terminal?): {e}")
        sys.exit(1)
    
    if not selected_tools:
        print("No tools selected. Exiting.")
        sys.exit(0)
        
    # Step 3: Write out a single bundled Ion `.js` file configuration
    if not os.path.exists(args.jsout):
        os.makedirs(args.jsout)
        
    print(f"\nExporting {len(selected_tools)} tools into a single bundle...")
    out_file = generate_bundle_js(selected_tools, args.url, args.jsout, args.name)
    print(f"  -> Generated: {out_file}")
        
    print("\nDone! The bundled tool is now natively available in Ion.")

if __name__ == "__main__":
    main()