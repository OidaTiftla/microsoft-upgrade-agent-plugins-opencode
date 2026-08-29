import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diagnoseMcpPrerequisites,
  type McpPrerequisiteDiagnostics,
} from "./mcp-prerequisites.ts";
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
  createOpenCodeMcpToolBridge,
  primeRepositoryTraits,
  CoreToolExecutionCoordinator,
  type McpToolBridge,
} from "./opencode-mcp-tool-bridge.ts";
import {
  createPrivateCoreMcpClient,
  type PrivateCoreMcpClient,
  type SamplingCallback,
} from "./private-core-mcp-client.ts";
import {
  OpenCodeSamplingAdapter,
  createOpenCodeSamplingSdkClient,
  type SamplingPolicy,
} from "./opencode-sampling-adapter.ts";
import {
  ensureNoSamplingAgentConflict,
  registerSamplingAgent,
} from "./sampling-agent.ts";

const MCP_NAME = "Upgrade";
const BUNDLED_PLUGIN_ROOT = fileURLToPath(
  new URL("../plugins/upgrade-agent", import.meta.url),
);

export interface UpgradeAgentPluginOptions {
  readonly sampling: SamplingPolicy;
}

export interface UpgradeAgentPluginRuntime {
  readonly client: PluginInput["client"];
  readonly directory: string;
}

export interface UpgradeAgentPluginDependencies {
  readonly diagnose: () => Promise<McpPrerequisiteDiagnostics>;
  readonly createBridge: (
    client: PrivateCoreMcpClient,
    coordinator: CoreToolExecutionCoordinator,
    sampling: OpenCodeSamplingAdapter,
    signal: AbortSignal,
  ) => Promise<McpToolBridge>;
  readonly convertAgents: () => Promise<AgentConversionResult>;
  readonly createPrivateClient: (
    sampling: SamplingCallback,
    signal: AbortSignal,
  ) => Promise<PrivateCoreMcpClient>;
  readonly warn: (message: string) => void;
}

interface UpgradeAgentResources {
  readonly bridge: McpToolBridge;
  readonly client: PrivateCoreMcpClient;
  readonly coordinator: CoreToolExecutionCoordinator;
}

function getPrerequisiteError(diagnostics: McpPrerequisiteDiagnostics): Error {
  const messages = diagnostics.diagnostics.map(
    ({ prerequisite, message, remediation }) =>
      `- ${prerequisite}: ${message} ${remediation}`,
  );
  return new Error(
    `MCP prerequisites are not satisfied:\n${messages.join("\n")}`,
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

function createDefaultBridge(
  client: PrivateCoreMcpClient,
  coordinator: CoreToolExecutionCoordinator,
  sampling: OpenCodeSamplingAdapter,
  signal: AbortSignal,
): Promise<McpToolBridge> {
  return createOpenCodeMcpToolBridge(
    client,
    MCP_NAME,
    sampling,
    coordinator,
    signal,
  );
}

function convertDefaultAgents(): Promise<AgentConversionResult> {
  return convertBundledAgents(join(BUNDLED_PLUGIN_ROOT, "agents"));
}

export async function createUpgradeAgentPlugin(
  runtime: UpgradeAgentPluginRuntime,
  options: PluginOptions = {},
  dependencies: UpgradeAgentPluginDependencies = {
    diagnose: diagnoseMcpPrerequisites,
    createBridge: createDefaultBridge,
    convertAgents: convertDefaultAgents,
    createPrivateClient: createDefaultPrivateClient,
    warn: (message) => console.warn(message),
  },
): Promise<Hooks> {
  const pluginOptions = getPluginOptions(options);
  const diagnostics = await dependencies.diagnose();
  if (!diagnostics.isReady) {
    throw getPrerequisiteError(diagnostics);
  }

  const conversion = await dependencies.convertAgents();
  let smallModel: string | undefined;
  const sampling = new OpenCodeSamplingAdapter({
    client: createOpenCodeSamplingSdkClient(runtime.client),
    getSmallModel: () => smallModel,
    mcpName: MCP_NAME,
    policy: pluginOptions.sampling,
  });
  let starting: Promise<UpgradeAgentResources> | undefined;
  let disposal: Promise<void> | undefined;
  let disposed = false;
  const initializationAbort = new AbortController();
  const tools: NonNullable<Hooks["tool"]> = {};

  const clearTools = () => {
    for (const name of Object.keys(tools)) delete tools[name];
  };

  const dispose = async () => {
    disposed = true;
    initializationAbort.abort(new Error("Upgrade plugin was disposed."));
    clearTools();
    return (disposal ??= (async () => {
      const resources = await starting?.catch(() => undefined);
      resources?.coordinator.dispose();
      await resources?.client.dispose();
    })());
  };

  const start = async (): Promise<UpgradeAgentResources> => {
    if (disposed)
      throw new Error("Upgrade plugin was disposed before initialization.");
    let client: PrivateCoreMcpClient | undefined;
    let coordinator: CoreToolExecutionCoordinator | undefined;
    try {
      client = await dependencies.createPrivateClient(
        async (request, signal) => {
          if (coordinator === undefined)
            throw new Error(
              "MCP sampling request arrived before bridge initialization.",
            );
          return coordinator.sample(request, signal);
        },
        initializationAbort.signal,
      );
      if (disposed)
        throw new Error("Upgrade plugin was disposed during initialization.");
      coordinator = new CoreToolExecutionCoordinator(client, sampling);
      await primeRepositoryTraits(
        client,
        runtime.directory,
        initializationAbort.signal,
      );
      if (disposed)
        throw new Error("Upgrade plugin was disposed during initialization.");
      const bridge = await dependencies.createBridge(
        client,
        coordinator,
        sampling,
        initializationAbort.signal,
      );
      if (disposed)
        throw new Error("Upgrade plugin was disposed during initialization.");
      return { bridge, client, coordinator };
    } catch (error) {
      coordinator?.dispose();
      await client?.dispose();
      throw error;
    }
  };

  const getResources = () => {
    return (starting ??= start().catch((error: unknown) => {
      starting = undefined;
      throw error;
    }));
  };

  let warningsEmitted = false;
  return {
    config: async (config) => {
      try {
        ensureNoMcpConflict(config);
        ensureNoAgentConflicts(config, conversion.agents);
        ensureNoSamplingAgentConflict(config);
        const resources = await getResources();
        if (disposed)
          throw new Error("Upgrade plugin was disposed before configuration.");
        Object.assign(tools, resources.bridge.tools);
        registerSamplingAgent(config);
        registerConvertedAgents(config, conversion.agents, BUNDLED_PLUGIN_ROOT);
        if (pluginOptions.sampling === "ask")
          registerSamplingAskPermissions(config);
        smallModel = config.small_model;
        if (!warningsEmitted && conversion.diagnostics.length > 0) {
          dependencies.warn(formatConversionWarnings(conversion.diagnostics));
          warningsEmitted = true;
        }
      } catch (error) {
        // OpenCode 1.18.18 ignores config-hook failures after registering tools.
        if (starting !== undefined) await dispose();
        throw error;
      }
    },
    "chat.params": sampling.applyChatParams,
    dispose,
    tool: tools,
    "tool.definition": async (input, output) => {
      const resources = starting === undefined ? undefined : await starting;
      await resources?.bridge.toolDefinition(input, output);
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
