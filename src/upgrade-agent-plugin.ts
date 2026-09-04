import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  tool,
  type Hooks,
  type PluginInput,
  type PluginOptions,
  type ToolContext,
} from "@opencode-ai/plugin";

import {
  convertBundledAgents,
  type AgentConversionResult,
} from "./agent-converter.ts";
import {
  ensureNoAgentConflicts,
  formatConversionWarnings,
  registerConvertedAgents,
  registerSamplingAskPermissions,
} from "./agent-registration.ts";
import {
  diagnoseMcpPrerequisites,
  type McpPrerequisiteDiagnostics,
} from "./mcp-prerequisites.ts";
import {
  CoreToolExecutionCoordinator,
  primeRepositoryTraits,
  waitForStableMcpTools,
  type McpTool,
} from "./core-mcp-runtime.ts";
import {
  OpenCodeSamplingAdapter,
  createOpenCodeSamplingSdkClient,
  type SamplingPolicy,
} from "./opencode-sampling-adapter.ts";
import {
  createPrivateCoreMcpClient,
  type PrivateCoreMcpClient,
  type SamplingCallback,
} from "./private-core-mcp-client.ts";
import {
  ensureNoSamplingAgentConflict,
  registerSamplingAgent,
} from "./sampling-agent.ts";
import {
  UpgradeInvocationRegistry,
  UpgradeMcpProxyServer,
  type ExecuteUpgradeCoreTool,
  type UpgradeMcpProxyEndpoint,
} from "./upgrade-mcp-proxy-transport.ts";

const MCP_NAME = "Upgrade";
const MCP_TIMEOUT_MS = 3_600_000;
const DISPOSAL_TIMEOUT_MS = 5_000;
const BUNDLED_PLUGIN_ROOT = fileURLToPath(
  new URL("../plugins/upgrade-agent", import.meta.url),
);
const PROXY_PATH = fileURLToPath(
  new URL("./upgrade-mcp-proxy.ts", import.meta.url),
);

export interface UpgradeAgentPluginOptions {
  readonly sampling: SamplingPolicy;
}
export interface UpgradeAgentPluginRuntime {
  readonly client: PluginInput["client"];
  readonly directory: string;
}
type ProxyServer = {
  start(): Promise<UpgradeMcpProxyEndpoint>;
  stop(): Promise<void>;
};
export interface UpgradeAgentPluginDependencies {
  readonly diagnose: () => Promise<McpPrerequisiteDiagnostics>;
  readonly convertAgents: () => Promise<AgentConversionResult>;
  readonly createPrivateClient: (
    sampling: SamplingCallback,
    signal: AbortSignal,
  ) => Promise<PrivateCoreMcpClient>;
  readonly createProxyServer: (
    registry: UpgradeInvocationRegistry,
    token: string,
    listTools: () => Promise<McpTool[]>,
    execute: ExecuteUpgradeCoreTool,
  ) => ProxyServer;
  readonly warn: (message: string) => void;
}
type Resources = {
  client: PrivateCoreMcpClient;
  coordinator: CoreToolExecutionCoordinator;
  proxy: ProxyServer;
  token: string;
  tools: readonly McpTool[];
};

function getPrerequisiteError(diagnostics: McpPrerequisiteDiagnostics): Error {
  return new Error(
    `MCP prerequisites are not satisfied:\n${diagnostics.diagnostics.map(({ prerequisite, message, remediation }) => `- ${prerequisite}: ${message} ${remediation}`).join("\n")}`,
  );
}

function createDefaultPrivateClient(
  sampling: SamplingCallback,
  signal: AbortSignal,
): Promise<PrivateCoreMcpClient> {
  return createPrivateCoreMcpClient({
    pluginRoot: BUNDLED_PLUGIN_ROOT,
    sampling,
    signal,
    versionManifestPath: new URL("./mcp-versions.json", import.meta.url),
  });
}

function createDefaultProxyServer(
  registry: UpgradeInvocationRegistry,
  token: string,
  listTools: () => Promise<McpTool[]>,
  execute: ExecuteUpgradeCoreTool,
): UpgradeMcpProxyServer {
  return new UpgradeMcpProxyServer({
    executeCoreTool: execute,
    listToolDescriptors: listTools,
    registry,
    token,
  });
}

function convertDefaultAgents(): Promise<AgentConversionResult> {
  return convertBundledAgents(join(BUNDLED_PLUGIN_ROOT, "agents"));
}

function isConnected(status: unknown): boolean {
  return (
    status !== null &&
    typeof status === "object" &&
    (status as { status?: unknown }).status === "connected"
  );
}

function getMcpStatus(response: unknown): unknown {
  return (response as { data?: Record<string, unknown> }).data?.[MCP_NAME];
}

function getSamplingPolicy(policy: SamplingPolicy): SamplingPolicy {
  return policy === "deny" ? "deny" : "allow";
}

async function waitForCancellation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  let cancel: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (cancel !== undefined) signal.removeEventListener("abort", cancel);
  }
}

export async function createUpgradeAgentPlugin(
  runtime: UpgradeAgentPluginRuntime,
  options: PluginOptions = {},
  dependencies: UpgradeAgentPluginDependencies = {
    diagnose: diagnoseMcpPrerequisites,
    convertAgents: convertDefaultAgents,
    createPrivateClient: createDefaultPrivateClient,
    createProxyServer: createDefaultProxyServer,
    warn: (message) => console.warn(message),
  },
): Promise<Hooks> {
  const pluginOptions = getPluginOptions(options);
  const diagnostics = await dependencies.diagnose();
  if (!diagnostics.isReady) throw getPrerequisiteError(diagnostics);
  const conversion = await dependencies.convertAgents();
  const registry = new UpgradeInvocationRegistry();
  const contexts = new Map<string, ToolContext>();
  const initializationAbort = new AbortController();
  let smallModel: string | undefined;
  let resources: Resources | undefined;
  let initializing: Promise<Resources> | undefined;
  let added = false;
  let connected = false;
  let possiblyActive = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let transition = Promise.resolve();
  const sampling = new OpenCodeSamplingAdapter({
    client: createOpenCodeSamplingSdkClient(runtime.client),
    getSmallModel: () => smallModel,
    mcpName: MCP_NAME,
    policy: getSamplingPolicy(pluginOptions.sampling),
  });

  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const result = transition.then(action, action);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const cacheContext = async (context: ToolContext): Promise<void> => {
    if (contexts.has(context.sessionID)) return;
    if (pluginOptions.sampling === "ask") {
      const pattern = `${MCP_NAME}:${context.sessionID}`;
      await waitForCancellation(
        context.ask({
          permission: "sampling",
          patterns: [pattern],
          always: [pattern],
          metadata: { scope: "session" },
        }),
        initializationAbort.signal,
      );
    }
    initializationAbort.signal.throwIfAborted();
    contexts.set(context.sessionID, context);
  };
  const createResources = async (): Promise<Resources> => {
    let client: PrivateCoreMcpClient | undefined;
    let coordinator: CoreToolExecutionCoordinator | undefined;
    try {
      client = await dependencies.createPrivateClient(
        async (request, signal) =>
          coordinator === undefined
            ? Promise.reject(new Error("Upgrade MCP is not initialized."))
            : coordinator.sample(request, signal),
        initializationAbort.signal,
      );
      coordinator = new CoreToolExecutionCoordinator(client, sampling);
      await primeRepositoryTraits(
        client,
        runtime.directory,
        initializationAbort.signal,
      );
      const tools = await waitForStableMcpTools(
        client,
        undefined,
        initializationAbort.signal,
      );
      const token = randomBytes(32).toString("hex");
      const proxy = dependencies.createProxyServer(
        registry,
        token,
        async () => [...tools],
        async (invocation, name, arguments_, signal) => {
          registry.match(invocation);
          const context = contexts.get(invocation.sessionID);
          if (context === undefined)
            throw new Error("Upgrade invocation context unavailable.");
          return coordinator!.execute(name, arguments_, {
            ...context,
            abort: signal,
            metadata: () => undefined,
          });
        },
      );
      if (disposed || initializationAbort.signal.aborted)
        throw new Error("Upgrade plugin was disposed during initialization.");
      return { client, coordinator, proxy, token, tools };
    } catch (error) {
      coordinator?.dispose();
      await client?.dispose();
      throw error;
    }
  };
  const getResources = (): Promise<Resources> =>
    (initializing ??= createResources()
      .then((value) => (resources = value))
      .catch((error: unknown) => {
        initializing = undefined;
        throw error;
      }));
  const getStatus = async (
    signal = initializationAbort.signal,
  ): Promise<unknown> =>
    getMcpStatus(
      await waitForCancellation(
        runtime.client.mcp.status({
          query: { directory: runtime.directory },
          signal,
          throwOnError: true,
        }),
        signal,
      ),
    );
  const disconnect = (signal = initializationAbort.signal): Promise<unknown> =>
    waitForCancellation(
      runtime.client.mcp.disconnect({
        path: { name: MCP_NAME },
        query: { directory: runtime.directory },
        signal,
        throwOnError: true,
      }),
      signal,
    );
  const disconnectPossiblyActive = async (
    signal: AbortSignal,
  ): Promise<void> => {
    if (!possiblyActive) return;
    await disconnect(signal);
    possiblyActive = false;
  };
  const cleanupPossiblyActive = (): Promise<void> =>
    disconnectPossiblyActive(AbortSignal.timeout(DISPOSAL_TIMEOUT_MS));
  const enable = async (context: ToolContext): Promise<string> =>
    queue(async () => {
      if (disposed) throw new Error("Upgrade plugin was disposed.");
      await cacheContext(context);
      const signal = initializationAbort.signal;
      const existingStatus = await getStatus(signal);
      if (isConnected(existingStatus)) possiblyActive = true;
      if (connected && isConnected(existingStatus))
        return "Upgrade MCP connected.";
      connected = false;
      added = existingStatus !== undefined;
      let current: Resources | undefined;
      try {
        current = await waitForCancellation(getResources(), signal);
        const endpoint = await waitForCancellation(
          current.proxy.start(),
          signal,
        );
        if (added) {
          if (!isConnected(existingStatus)) {
            possiblyActive = true;
            await waitForCancellation(
              runtime.client.mcp.connect({
                path: { name: MCP_NAME },
                query: { directory: runtime.directory },
                signal,
                throwOnError: true,
              }),
              signal,
            );
          }
        } else {
          possiblyActive = true;
          const result = await waitForCancellation(
            runtime.client.mcp.add({
              body: {
                name: MCP_NAME,
                config: {
                  command: ["node", PROXY_PATH],
                  environment: {
                    UPGRADE_MCP_PROXY_HOST: endpoint.host,
                    UPGRADE_MCP_PROXY_PORT: String(endpoint.port),
                    UPGRADE_MCP_PROXY_TOKEN: current.token,
                  },
                  timeout: MCP_TIMEOUT_MS,
                  type: "local",
                },
              },
              query: { directory: runtime.directory },
              signal,
              throwOnError: true,
            }),
            signal,
          );
          const status = getMcpStatus(result);
          if (status !== undefined) added = true;
          if (!isConnected(status))
            throw new Error("Upgrade MCP did not connect.");
        }
        if (!isConnected(await getStatus(signal)))
          throw new Error("Upgrade MCP did not connect.");
        connected = true;
        return "Upgrade MCP connected.";
      } catch (error) {
        connected = false;
        await current?.proxy.stop().catch(() => undefined);
        await cleanupPossiblyActive().catch(() => undefined);
        throw error;
      }
    });
  const disable = async (): Promise<string> =>
    queue(async () => {
      if (resources === undefined || !possiblyActive)
        return "Upgrade MCP unavailable.";
      try {
        await disconnectPossiblyActive(initializationAbort.signal);
      } finally {
        connected = false;
        await resources.proxy.stop();
      }
      return "Upgrade MCP disconnected.";
    });
  const dispose = async (): Promise<void> =>
    (disposal ??= (async () => {
      disposed = true;
      initializationAbort.abort();
      await transition;
      const current = resources ?? (await initializing?.catch(() => undefined));
      const cleanupSignal = AbortSignal.timeout(DISPOSAL_TIMEOUT_MS);
      try {
        await disconnectPossiblyActive(cleanupSignal).catch(() => undefined);
      } finally {
        connected = false;
        await current?.proxy.stop();
        current?.coordinator.dispose();
        await current?.client.dispose();
        contexts.clear();
      }
    })());
  let warningsEmitted = false;
  const controls: NonNullable<Hooks["tool"]> = {
    enable_upgrade_mcp: tool({
      args: {},
      description: "Enable Upgrade MCP.",
      execute: async (_args, context) => ({
        output: await enable(context),
        title: "Upgrade MCP",
      }),
    }),
    disable_upgrade_mcp: tool({
      args: {},
      description: "Disable Upgrade MCP.",
      execute: async () => ({ output: await disable(), title: "Upgrade MCP" }),
    }),
    get_upgrade_mcp_status: tool({
      args: {},
      description: "Get Upgrade MCP status.",
      execute: async () => {
        const status = await getStatus();
        return {
          output:
            status === undefined ? "not registered" : JSON.stringify(status),
          title: "Upgrade MCP",
        };
      },
    }),
    list_upgrade_mcp_tools: tool({
      args: {},
      description: "List Upgrade MCP tools.",
      execute: async () => ({
        output:
          isConnected(await getStatus()) && resources !== undefined
            ? resources.tools
                .map(
                  ({ name, description }) =>
                    `${MCP_NAME}_${name}${description === undefined ? "" : `: ${description}`}`,
                )
                .sort()
                .join("\n")
            : "Upgrade MCP unavailable.",
        title: "Upgrade MCP",
      }),
    }),
  };
  return {
    config: async (config) => {
      if (disposed) throw new Error("Upgrade plugin was disposed.");
      ensureNoMcpConflict(config);
      ensureNoAgentConflicts(config, conversion.agents);
      ensureNoSamplingAgentConflict(config);
      registerSamplingAgent(config);
      registerConvertedAgents(config, conversion.agents, BUNDLED_PLUGIN_ROOT);
      if (pluginOptions.sampling === "ask")
        registerSamplingAskPermissions(config);
      smallModel = config.small_model;
      if (!warningsEmitted && conversion.diagnostics.length > 0) {
        dependencies.warn(formatConversionWarnings(conversion.diagnostics));
        warningsEmitted = true;
      }
    },
    "chat.params": sampling.applyChatParams,
    dispose,
    tool: controls,
    "tool.execute.before": async ({ tool: name, sessionID, callID }) => {
      if (name.startsWith(`${MCP_NAME}_`))
        registry.register({ callID, sessionID, tool: name });
    },
    "tool.execute.after": async ({ tool: name, sessionID, callID }) => {
      if (name.startsWith(`${MCP_NAME}_`))
        registry.release({ callID, sessionID, tool: name });
    },
  };
}

function ensureNoMcpConflict(
  config: Parameters<NonNullable<Hooks["config"]>>[0],
): void {
  if (config.mcp !== undefined && Object.hasOwn(config.mcp, MCP_NAME))
    throw new Error(`MCP key "${MCP_NAME}" is already configured.`);
}

export function getPluginOptions(
  options: PluginOptions,
): UpgradeAgentPluginOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new Error("Upgrade plugin options must be an object.");
  for (const key of Object.keys(options))
    if (key !== "sampling")
      throw new Error(`Unknown Upgrade plugin option "${key}".`);
  const sampling = options.sampling;
  if (
    sampling !== undefined &&
    sampling !== "ask" &&
    sampling !== "allow" &&
    sampling !== "deny"
  )
    throw new Error(
      'Upgrade plugin option "sampling" must be "ask", "allow", or "deny".',
    );
  return { sampling: sampling ?? "ask" };
}

export function getPluginRuntime(
  input: PluginInput,
): UpgradeAgentPluginRuntime {
  return { client: input.client, directory: input.directory };
}
