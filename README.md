# workbench

This is a modified version of the [Ion](https://github.com/fredconex/Ion).  It is intended as an entirely browser-based LLM coding / research setup you can run locally, with external OpenAI compatible LLM API calls.

The main changes are:
- Split into smaller, more maintainable (by me and LLMs) chunks, that can be re-minified easily with `esbuild`
- Optionally pull in Network MCP-tools in
- Use WebDAV storage backends
- Optionally serve via simple python backend that:
   - Lets you connect stdio-based MCP tools
   - Serve a local directory over webdav for sharing with the agent

I highly recommend starting from the original, though.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
