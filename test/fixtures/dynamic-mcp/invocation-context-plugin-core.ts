import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import type { McpLocalConfig, McpStatus } from "@opencode-ai/sdk";

import {
  InvocationContextIpcServer,
  InvocationContextRegistry,
  type InvocationContextEndpoint,
} from "./invocation-context.ts";
import { INVOCATION_CONTEXT_PROXY_TOOL } from "./invocation-context-proxy-tool.ts";

export const INVOCATION_CONTEXT_PROXY_NAME = "invocation-context-proxy";
export const INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL = `${INVOCATION_CONTEXT_PROXY_NAME}_${INVOCATION_CONTEXT_PROXY_TOOL}`;
export const INVOCATION_CONTEXT_PROXY_SERVER_PATH = fileURLToPath(
  new URL("./invocation-context-proxy-mcp.ts", import.meta.url),
);

interface InvocationContextIpc {
  start(): Promise<InvocationContextEndpoint>;
  stop(): Promise<void>;
}

type InvocationContextIpcFactory = (
  registry: InvocationContextRegistry,
  token: string,
) => InvocationContextIpc;

function getProxyConfig(
  endpoint: InvocationContextEndpoint,
  token: string,
): McpLocalConfig {
  return {
    command: ["node", INVOCATION_CONTEXT_PROXY_SERVER_PATH],
    environment: {
      DYNAMIC_INVOCATION_CONTEXT_HOST: endpoint.host,
      DYNAMIC_INVOCATION_CONTEXT_PORT: String(endpoint.port),
      DYNAMIC_INVOCATION_CONTEXT_TOKEN: token,
      DYNAMIC_INVOCATION_CONTEXT_TOOL: INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL,
    },
    type: "local",
  };
}

function getStatusError(status: McpStatus | undefined): Error {
  return new Error(
    status?.status === "failed"
      ? status.error
      : `Invocation-context proxy is ${status?.status ?? "not registered"}.`,
  );
}

async function getStatus(
  client: PluginInput["client"],
): Promise<McpStatus | undefined> {
  return (await client.mcp.status({ throwOnError: true })).data[
    INVOCATION_CONTEXT_PROXY_NAME
  ];
}

export function createInvocationContextPlugin(
  client: PluginInput["client"],
  createIpc: InvocationContextIpcFactory = (registry, token) =>
    new InvocationContextIpcServer(registry, token),
): Hooks {
  const registry = new InvocationContextRegistry();
  const token = randomBytes(32).toString("hex");
  const ipc = createIpc(registry, token);
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
  const enable = (): Promise<void> =>
    enqueue(async () => {
      if (connected) return;
      const endpoint = await ipc.start();
      try {
        if (registered)
          await client.mcp.connect({
            path: { name: INVOCATION_CONTEXT_PROXY_NAME },
            throwOnError: true,
          });
        else {
          const response = await client.mcp.add({
            body: {
              config: getProxyConfig(endpoint, token),
              name: INVOCATION_CONTEXT_PROXY_NAME,
            },
            throwOnError: true,
          });
          const status = response.data[INVOCATION_CONTEXT_PROXY_NAME];
          registered = status !== undefined;
          if (status?.status !== "connected") throw getStatusError(status);
        }
        connected = true;
      } catch (error) {
        await ipc.stop();
        throw error;
      }
    });
  const disable = (): Promise<void> =>
    enqueue(async () => {
      try {
        if (connected)
          await client.mcp.disconnect({
            path: { name: INVOCATION_CONTEXT_PROXY_NAME },
            throwOnError: true,
          });
      } finally {
        connected = false;
        await ipc.stop();
      }
    });

  return {
    dispose: disable,
    "tool.execute.after": async (input) => {
      if (input.tool === INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL)
        registry.release(input);
    },
    "tool.execute.before": async (input) => {
      if (input.tool === INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL)
        registry.register(input);
    },
    tool: {
      disable_invocation_context_proxy: tool({
        args: {},
        description:
          "Disconnect the local invocation-context proxy MCP server.",
        execute: async () => {
          await disable();
          return "Invocation-context proxy disabled.";
        },
      }),
      enable_invocation_context_proxy: tool({
        args: {},
        description: "Enable the local invocation-context proxy MCP server.",
        execute: async () => {
          await enable();
          return "Invocation-context proxy enabled.";
        },
      }),
      get_invocation_context_proxy_status: tool({
        args: {},
        description: "Get the local invocation-context proxy status.",
        execute: async () => {
          const status = await getStatus(client);
          return `Invocation-context proxy status=${status?.status ?? "not registered"}.`;
        },
      }),
    },
  };
}
