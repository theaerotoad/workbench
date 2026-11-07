const TOOL_META = {
    name: "sample_tool",
    description: "A sample utility tool served from the local jsutils directory.",
    parameters: {
        type: "object",
        properties: {
            message: {
                type: "string",
                description: "Message to display."
            }
        },
        required: ["message"]
    },
    modes: ["plan", "ask", "code"]
};

async function handler(args, api) {
    const msg = args.message || "";
    return `[jsutils: sample_tool] Received message: ${msg}`;
}