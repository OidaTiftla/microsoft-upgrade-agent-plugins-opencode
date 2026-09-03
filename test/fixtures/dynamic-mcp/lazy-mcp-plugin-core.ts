import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import type { McpLocalConfig, McpStatus } from "@opencode-ai/sdk";
import { fileURLToPath } from "node:url";

import {
  getHelloMcpDiagnosticsPath,
  getHelloMcpRuntimeIdentity,
  HELLO_MCP_DIAGNOSTICS_ENV,
  readFinalHelloMcpDiagnosticWithRetry,
} from "./hello-mcp-diagnostics.ts";
import {
  resolveHelloMcpRuntime,
  type HelloMcpRuntime,
  type HelloMcpRuntimeProbe,
} from "./hello-mcp-runtime.ts";
import { HELLO_MCP_TOOL } from "./hello-mcp-tool.ts";

export const HELLO_MCP_NAME = "hello-mcp";
export const HELLO_MCP_QUALIFIED_TOOL_NAME = `${HELLO_MCP_NAME}_${HELLO_MCP_TOOL.name}`;
export const HELLO_MCP_SERVER_PATH = fileURLToPath(
  new URL("./hello-mcp.ts", import.meta.url),
);
const HELLO_MCP_DIRECT_INVOCATION_INSTRUCTION = `invoke ${HELLO_MCP_QUALIFIED_TOOL_NAME} directly; no new chat or tool-list refresh is required`;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getHelloMcpConfig(
  runtime: HelloMcpRuntime,
  serverPath: string,
  diagnosticsPath: string,
): McpLocalConfig {
  return {
    command: [runtime, serverPath],
    environment: { [HELLO_MCP_DIAGNOSTICS_ENV]: diagnosticsPath },
    type: "local",
  };
}

function getAddStatusError(status: McpStatus | undefined): Error {
  if (status?.status === "failed") return new Error(status.error);
  if (status === undefined)
    return new Error(`OpenCode did not return a status for ${HELLO_MCP_NAME}.`);
  return new Error(`OpenCode reported ${HELLO_MCP_NAME} as ${status.status}.`);
}

function getHelloMcpToolAvailability(): string {
  return `available tool: ${HELLO_MCP_QUALIFIED_TOOL_NAME} — ${HELLO_MCP_TOOL.description}; ${HELLO_MCP_DIRECT_INVOCATION_INSTRUCTION}`;
}

async function getHelloMcpStatus(
  client: PluginInput["client"],
): Promise<McpStatus | undefined> {
  const response = await client.mcp.status({ throwOnError: true });
  return response.data[HELLO_MCP_NAME];
}

async function getEnableError(
  error: unknown,
  serverPath: string,
  diagnosticsPath: string,
): Promise<Error> {
  const diagnostic =
    await readFinalHelloMcpDiagnosticWithRetry(diagnosticsPath);
  const diagnosticMessage =
    diagnostic === undefined ? "" : ` Child diagnostic: ${diagnostic}.`;
  const runtime = getHelloMcpRuntimeIdentity();
  return new Error(
    `Unable to enable Hello MCP: ${getErrorMessage(error)}.${diagnosticMessage} Plugin host runtime=${runtime.runtime} executable=${runtime.executable}. Verify the configured runtime can run ${serverPath}. Diagnostics file: ${diagnosticsPath}.`,
  );
}

function getEnableResult(status: McpStatus): string {
  return `Hello MCP enabled; status=${status.status}; ${getHelloMcpToolAvailability()}.`;
}

function getHelloMcpStatusText(status: McpStatus | undefined): string {
  const statusName = status?.status ?? "not registered";
  if (status?.status === "failed")
    return `status=${statusName}; error=${status.error}`;
  return `status=${statusName}`;
}

function getStatusResult(status: McpStatus | undefined): string {
  const statusText = getHelloMcpStatusText(status);
  if (status?.status === "connected")
    return `Hello MCP ${statusText}; ${getHelloMcpToolAvailability()}.`;
  return `Hello MCP ${statusText}.`;
}

function getListResult(status: McpStatus | undefined): string {
  const statusText = getHelloMcpStatusText(status);
  if (status?.status === "connected")
    return `Hello MCP tools; ${statusText}; ${getHelloMcpToolAvailability()}.`;
  return `Hello MCP tools unavailable; ${statusText}.`;
}

export function createLazyMcpPlugin(
  client: PluginInput["client"],
  serverPath = HELLO_MCP_SERVER_PATH,
  diagnosticsPath = getHelloMcpDiagnosticsPath(),
  runtimeProbe?: HelloMcpRuntimeProbe,
): Hooks {
  let connected = false;
  let registered = false;
  let transition = Promise.resolve();

  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = transition.then(action);
    transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const enable = (): Promise<McpStatus> =>
    enqueue(async () => {
      if (connected) return { status: "connected" } as const;
      try {
        if (registered) {
          await client.mcp.connect({
            path: { name: HELLO_MCP_NAME },
            throwOnError: true,
          });
          connected = true;
          return { status: "connected" } as const;
        }
        const response = await client.mcp.add({
          body: {
            config: getHelloMcpConfig(
              await resolveHelloMcpRuntime(runtimeProbe),
              serverPath,
              diagnosticsPath,
            ),
            name: HELLO_MCP_NAME,
          },
          throwOnError: true,
        });
        const status = response.data[HELLO_MCP_NAME];
        registered = status !== undefined;
        if (status?.status !== "connected") throw getAddStatusError(status);
        connected = true;
        return status;
      } catch (error) {
        throw await getEnableError(error, serverPath, diagnosticsPath);
      }
    });

  const disable = async (): Promise<void> => {
    await enqueue(async () => {
      if (!connected) return;
      await client.mcp.disconnect({
        path: { name: HELLO_MCP_NAME },
        throwOnError: true,
      });
      connected = false;
    });
  };

  return {
    tool: {
      disable_hello_mcp: tool({
        args: {},
        description: "Disconnect the local Hello MCP server.",
        execute: async () => {
          await disable();
          return "Hello MCP disabled.";
        },
      }),
      enable_hello_mcp: tool({
        args: {},
        description: `Enable the local Hello MCP server; after enabling, ${HELLO_MCP_DIRECT_INVOCATION_INSTRUCTION}.`,
        execute: async () => {
          return getEnableResult(await enable());
        },
      }),
      get_hello_mcp_status: tool({
        args: {},
        description:
          "Get the local Hello MCP server status without changing it.",
        execute: async () => {
          return getStatusResult(await getHelloMcpStatus(client));
        },
      }),
      list_hello_mcp_tools: tool({
        args: {},
        description:
          "List the available Hello MCP tools without changing server state.",
        execute: async () => {
          return getListResult(await getHelloMcpStatus(client));
        },
      }),
    },
  };
}
