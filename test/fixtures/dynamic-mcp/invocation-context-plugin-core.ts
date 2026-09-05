import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  tool,
  type Hooks,
  type PluginInput,
  type ToolContext,
} from "@opencode-ai/plugin";
import type { McpLocalConfig, McpStatus } from "@opencode-ai/sdk";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  OpenCodeSamplingAdapter,
  createOpenCodeSamplingSdkClient,
} from "../../../src/opencode-sampling-adapter.ts";
import { registerSamplingAgent } from "../../../src/sampling-agent.ts";
import {
  INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS,
  InvocationContextIpcServer,
  InvocationContextRegistry,
  type InvocationContextEndpoint,
  type InvocationContextSamplingHandler,
} from "./invocation-context.ts";
import {
  INVOCATION_CONTEXT_PROXY_SAMPLING_TOOL,
  INVOCATION_CONTEXT_PROXY_TOOL,
} from "./invocation-context-proxy-tool.ts";
import { SessionScopedSamplingAuthorizer } from "./sampling-authorization.ts";
import { invokeProxySampling } from "./proxy-sampling.ts";

export const INVOCATION_CONTEXT_PROXY_NAME = "invocation-context-proxy";
export const INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL = `${INVOCATION_CONTEXT_PROXY_NAME}_${INVOCATION_CONTEXT_PROXY_TOOL}`;
export const INVOCATION_CONTEXT_PROXY_QUALIFIED_SAMPLING_TOOL = `${INVOCATION_CONTEXT_PROXY_NAME}_${INVOCATION_CONTEXT_PROXY_SAMPLING_TOOL}`;
export const INVOCATION_CONTEXT_PROXY_SERVER_PATH = fileURLToPath(
  new URL("./invocation-context-proxy-mcp.ts", import.meta.url),
);

const ENABLE_SAMPLING_AUTHORIZATION = {
  metadata: {
    purpose:
      "Allow future sampling requests from the invocation-context proxy in this session.",
    scope: "session",
  },
};

interface InvocationContextIpc {
  start(): Promise<InvocationContextEndpoint>;
  stop(): Promise<void>;
}

type InvocationContextIpcFactory = (
  registry: InvocationContextRegistry,
  token: string,
  samplingHandler: InvocationContextSamplingHandler,
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
    timeout: INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS,
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

function isInvocationContextProxyTool(toolName: string): boolean {
  return (
    toolName === INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL ||
    toolName === INVOCATION_CONTEXT_PROXY_QUALIFIED_SAMPLING_TOOL
  );
}

function createInvocationContextSamplingHandler(
  client: PluginInput["client"],
  directory: string,
  getSmallModel: () => string | undefined,
): {
  readonly applyChatParams: NonNullable<Hooks["chat.params"]>;
  readonly handler: InvocationContextSamplingHandler;
} {
  const sampling = new OpenCodeSamplingAdapter({
    client: createOpenCodeSamplingSdkClient(client),
    getSmallModel,
    mcpName: INVOCATION_CONTEXT_PROXY_NAME,
    policy: "allow",
  });
  const sample = (
    request: CreateMessageRequest,
    context: ToolContext,
  ): Promise<CreateMessageResult> => sampling.sample(request, context);
  return {
    applyChatParams: sampling.applyChatParams,
    handler: (invocation, request, signal) =>
      invokeProxySampling(
        {
          abort: signal,
          directory,
          sessionID: invocation.sessionID,
        } as ToolContext,
        request,
        signal,
        sample,
      ),
  };
}

export function createInvocationContextPlugin(
  client: PluginInput["client"],
  createIpc: InvocationContextIpcFactory = (registry, token, samplingHandler) =>
    new InvocationContextIpcServer(registry, token, samplingHandler),
  samplingHandler?: InvocationContextSamplingHandler,
  directory = process.cwd(),
): Hooks {
  const registry = new InvocationContextRegistry();
  const token = randomBytes(32).toString("hex");
  const samplingAuthorizer = new SessionScopedSamplingAuthorizer();
  let smallModel: string | undefined;
  const sampling = createInvocationContextSamplingHandler(
    client,
    directory,
    () => smallModel,
  );
  const ipc = createIpc(
    registry,
    token,
    async (invocation, request, signal) => {
      if (!samplingAuthorizer.isAuthorized(invocation.sessionID))
        throw new Error("Sampling request unavailable.");
      return (samplingHandler ?? sampling.handler)(invocation, request, signal);
    },
  );
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
  const enable = (context: ToolContext): Promise<void> =>
    enqueue(async () => {
      await samplingAuthorizer.enforce(context, ENABLE_SAMPLING_AUTHORIZATION);
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
    config: async (config) => {
      registerSamplingAgent(config);
      smallModel = config.small_model;
    },
    "chat.params": sampling.applyChatParams,
    dispose: disable,
    "tool.execute.after": async (input) => {
      if (isInvocationContextProxyTool(input.tool)) registry.release(input);
    },
    "tool.execute.before": async (input) => {
      if (isInvocationContextProxyTool(input.tool)) registry.register(input);
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
        execute: async (_, context) => {
          await enable(context);
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

export function createInvocationContextPluginFromInput(
  input: PluginInput,
): Hooks {
  return createInvocationContextPlugin(
    input.client,
    undefined,
    undefined,
    input.directory,
  );
}
