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
  reportUpgradeMcpDiagnostic,
  type UpgradeMcpProxyEndpoint,
} from "./upgrade-mcp-proxy-transport.ts";
import {
  formatPluginError,
  LoggedMcpTransport,
  SAFE_PLUGIN_ERROR_MESSAGES,
  SafePluginError,
  type DiagnosticLogger,
} from "./plugin-logging.ts";

interface ProxyConfig {
  readonly endpoint: UpgradeMcpProxyEndpoint;
  readonly token: string;
}

const TRANSPORT_FAILURE: CallToolResult = {
  content: [
    { text: SAFE_PLUGIN_ERROR_MESSAGES.proxyRequestUnavailable, type: "text" },
  ],
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
    throw new SafePluginError("proxyEnvironment");
  return { endpoint: { host, port }, token };
}

export function createUpgradeMcpProxy(
  config: ProxyConfig,
  log: DiagnosticLogger = () => undefined,
): Server {
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
    } catch (error) {
      log(
        "error",
        `Upgrade proxy tool listing failed: ${formatPluginError(error)}`,
      );
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
    } catch (error) {
      log(
        "error",
        `Upgrade proxy tool call failed: ${formatPluginError(error)}`,
      );
      return TRANSPORT_FAILURE;
    }
  });
  return server;
}

async function run(): Promise<void> {
  const config = readConfig(process.env);
  const log: DiagnosticLogger = (level, message) => {
    void reportUpgradeMcpDiagnostic({ ...config, level, message }).catch(
      (error: unknown) => {
        console.error(
          "Upgrade proxy logging failed:",
          formatPluginError(error),
          message,
        );
      },
    );
  };
  const server = createUpgradeMcpProxy(config, log);
  try {
    await server.connect(
      new LoggedMcpTransport(
        new StdioServerTransport(),
        "Upgrade proxy",
        "outgoing",
        log,
      ),
    );
  } catch (error) {
    await reportUpgradeMcpDiagnostic({
      ...config,
      level: "error",
      message: `Upgrade proxy startup failed: ${formatPluginError(error)}`,
    }).catch(() => undefined);
    throw error;
  }
}

void run().catch((error: unknown) => {
  console.error("Upgrade proxy startup failed:", formatPluginError(error));
  process.exitCode = 1;
});
