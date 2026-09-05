import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getProxyInvocationContext,
  requestProxySampling,
} from "./invocation-context-proxy-client.ts";
import {
  INVOCATION_CONTEXT_PROXY_SAMPLING_TOOL,
  INVOCATION_CONTEXT_PROXY_TOOL,
} from "./invocation-context-proxy-tool.ts";
import { formatSamplingFailure } from "./sampling-failure.ts";
import {
  DEFAULT_SAMPLING_MAX_TOKENS,
  MAX_SAMPLING_TOKENS,
} from "./sampling-request.ts";
const HOST_ENV = "DYNAMIC_INVOCATION_CONTEXT_HOST";
const PORT_ENV = "DYNAMIC_INVOCATION_CONTEXT_PORT";
const TOKEN_ENV = "DYNAMIC_INVOCATION_CONTEXT_TOKEN";
const TOOL_ENV = "DYNAMIC_INVOCATION_CONTEXT_TOOL";

function getEnvironmentContextRequest(tool = process.env[TOOL_ENV]): {
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly token: string;
  readonly tool: string;
} {
  const host = process.env[HOST_ENV];
  const port = Number(process.env[PORT_ENV]);
  const token = process.env[TOKEN_ENV];
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
      const context = await getProxyInvocationContext(
        getEnvironmentContextRequest(),
      );
      return { content: [{ type: "text", text: JSON.stringify(context) }] };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "Invocation context unavailable.",
          },
        ],
        isError: true,
      };
    }
  },
);
server.registerTool(
  INVOCATION_CONTEXT_PROXY_SAMPLING_TOOL,
  {
    description: "Request a sampled text response for the current invocation.",
    inputSchema: {
      maxTokens: z.number().int().min(1).max(MAX_SAMPLING_TOKENS).optional(),
      text: z.string().min(1),
    },
  },
  async ({ maxTokens, text }, extra) => {
    try {
      const environment = getEnvironmentContextRequest(
        `invocation-context-proxy_${INVOCATION_CONTEXT_PROXY_SAMPLING_TOOL}`,
      );
      const result = await requestProxySampling({
        config: environment,
        maxTokens: maxTokens ?? DEFAULT_SAMPLING_MAX_TOKENS,
        signal: extra.signal,
        text,
      });
      return {
        content: [
          {
            text:
              result.content.type === "text"
                ? result.content.text
                : JSON.stringify(result),
            type: "text",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            text: formatSamplingFailure(error),
            type: "text",
          },
        ],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
