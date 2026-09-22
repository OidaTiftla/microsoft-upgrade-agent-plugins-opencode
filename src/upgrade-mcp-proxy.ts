import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  callUpgradeCoreTool,
  requestUpgradeInvocationContext,
  requestUpgradeMcpTools,
  type UpgradeMcpProxyEndpoint,
} from "./upgrade-mcp-proxy-transport.ts";

interface ProxyConfig {
  readonly endpoint: UpgradeMcpProxyEndpoint;
  readonly token: string;
}

const ENVIRONMENT_ERROR = "Upgrade MCP proxy environment is invalid.";
const TRANSPORT_FAILURE: CallToolResult = {
  content: [{ text: "Upgrade MCP proxy request unavailable.", type: "text" }],
  isError: true,
};

function normalizeSignal(value: unknown): AbortSignal {
  return value instanceof AbortSignal ? value : new AbortController().signal;
}

function readConfig(environment: NodeJS.ProcessEnv): ProxyConfig {
  const host = environment.UPGRADE_MCP_PROXY_HOST;
  const port = Number(environment.UPGRADE_MCP_PROXY_PORT);
  const token = environment.UPGRADE_MCP_PROXY_TOKEN;
  if (
    host !== "127.0.0.1" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    token === undefined ||
    token.length === 0
  )
    throw new Error(ENVIRONMENT_ERROR);
  return { endpoint: { host, port }, token };
}

export function createUpgradeMcpProxy(config: ProxyConfig): Server {
  const server = new Server(
    { name: "opencode-microsoft-upgrade-agent-proxy", version: "0.1.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    try {
      return {
        tools: await requestUpgradeMcpTools({
          ...config,
          signal: normalizeSignal(extra.signal),
        }),
      } as ListToolsResult;
    } catch {
      return { tools: [] };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const signal = normalizeSignal(extra.signal);
      const name = request.params.name;
      const invocation = await requestUpgradeInvocationContext({
        ...config,
        signal,
        tool: `Upgrade_${name}`,
      });
      return (await callUpgradeCoreTool({
        arguments_: request.params.arguments ?? {},
        ...config,
        invocation,
        name,
        signal,
      })) as CallToolResult;
    } catch {
      return TRANSPORT_FAILURE;
    }
  });
  return server;
}

async function run(): Promise<void> {
  const server = createUpgradeMcpProxy(readConfig(process.env));
  await server.connect(new StdioServerTransport());
}

void run().catch(() => {
  process.exitCode = 1;
});
