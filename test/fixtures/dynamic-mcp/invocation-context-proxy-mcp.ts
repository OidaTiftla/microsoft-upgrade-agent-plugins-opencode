import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { requestInvocationContext } from "./invocation-context.ts";
import { INVOCATION_CONTEXT_PROXY_TOOL } from "./invocation-context-proxy-tool.ts";
const HOST_ENV = "DYNAMIC_INVOCATION_CONTEXT_HOST";
const PORT_ENV = "DYNAMIC_INVOCATION_CONTEXT_PORT";
const TOKEN_ENV = "DYNAMIC_INVOCATION_CONTEXT_TOKEN";
const TOOL_ENV = "DYNAMIC_INVOCATION_CONTEXT_TOOL";

function getEnvironmentContextRequest(): {
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly token: string;
  readonly tool: string;
} {
  const host = process.env[HOST_ENV];
  const port = Number(process.env[PORT_ENV]);
  const token = process.env[TOKEN_ENV];
  const tool = process.env[TOOL_ENV];
  if (
    host === undefined ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    token === undefined ||
    tool === undefined
  )
    throw new Error("Invocation-context proxy IPC configuration is invalid.");
  return { endpoint: { host, port }, token, tool };
}

const server = new McpServer({
  name: "invocation-context-proxy",
  version: "0.0.0",
});
server.registerTool(
  INVOCATION_CONTEXT_PROXY_TOOL,
  { description: "Get the current OpenCode invocation context." },
  async () => {
    try {
      const context = await requestInvocationContext(
        getEnvironmentContextRequest(),
      );
      return { content: [{ type: "text", text: JSON.stringify(context) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Invocation context unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
