import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  tool,
  type Config,
  type Hooks,
  type PluginInput,
} from "@opencode-ai/plugin";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { AgentConversionResult } from "../src/agent-converter.ts";
import * as packageEntry from "../src/index.ts";
import {
  createUpgradeAgentPlugin,
  getPluginOptions,
  type UpgradeAgentPluginDependencies,
  type UpgradeAgentPluginRuntime,
} from "../src/upgrade-agent-plugin.ts";
import type {
  PrivateCoreMcpClient,
  SamplingCallback,
} from "../src/private-core-mcp-client.ts";
import { getMcpStartupRequestOptions } from "../src/private-core-mcp-client.ts";

const convertedAgents: AgentConversionResult = {
  agents: [
    {
      id: "upgrade",
      name: "Upgrade",
      description: "Upgrade projects.",
      mode: "primary",
      hidden: false,
      permission: { "*": "deny", Upgrade_get_state: "allow" },
      system: "Upgrade prompt.",
    },
  ],
  diagnostics: [],
};

function runtime(): UpgradeAgentPluginRuntime {
  return { client: {} as PluginInput["client"], directory: "/workspace" };
}

function samplingPermission(permission: unknown): unknown {
  return (permission as Record<string, unknown> | undefined)?.sampling;
}

function privateClient(disposed: { value: boolean }): PrivateCoreMcpClient {
  return {
    callTool: async () => ({ content: [] }),
    client: {} as Client,
    dispose: async () => {
      disposed.value = true;
    },
    listTools: async () => ({ tools: [] }) as never,
    subscribeToToolListChanges: () => () => undefined,
  };
}

function dependencies(input: {
  disposed: { value: boolean };
  sampling?: { value: SamplingCallback | undefined };
  toolDefinition?: NonNullable<Hooks["tool.definition"]>;
}): UpgradeAgentPluginDependencies {
  return {
    createBridge: async (_client, coordinator) => ({
      coordinator,
      toolDefinition: input.toolDefinition ?? (async () => undefined),
      tools: {
        Upgrade_get_state: tool({
          args: {},
          description: "Get upgrade state.",
          execute: async () => "state",
        }),
      },
    }),
    convertAgents: async () => convertedAgents,
    createPrivateClient: async (_directory, sampling) => {
      if (input.sampling !== undefined) input.sampling.value = sampling;
      return privateClient(input.disposed);
    },
    diagnose: async () => ({ isReady: true, diagnostics: [] }),
    warn: () => undefined,
  };
}

test("packageEntry_Exports_Expect_DefaultPluginOnly", async () => {
  // Arrange
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  // Act
  const exports = Object.keys(packageEntry);

  // Assert
  assert.equal(packageJson.exports, "./src/index.ts");
  assert.deepEqual(exports, ["default"]);
  assert.equal(typeof packageEntry.default, "function");
});

test("getPluginOptions_MissingSampling_Expect_AskPolicy", () => {
  // Arrange
  const options = {};

  // Act
  const result = getPluginOptions(options);

  // Assert
  assert.deepEqual(result, { sampling: "ask" });
});

test("getPluginOptions_InvalidSampling_Expect_ThrowsException", () => {
  // Arrange
  const options = { sampling: "always" };

  // Act
  const action = () => getPluginOptions(options);

  // Assert
  assert.throws(action, /sampling.*ask.*allow.*deny/);
});

test("getPluginOptions_UnknownOption_Expect_ThrowsException", () => {
  // Arrange
  const options = { unsupported: true };

  // Act
  const action = () => getPluginOptions(options);

  // Assert
  assert.throws(action, /Unknown Upgrade plugin option/);
});

test("getMcpStartupRequestOptions_Signal_Expect_ForwardsCancellation", () => {
  // Arrange
  const signal = new AbortController().signal;

  // Act
  const options = getMcpStartupRequestOptions(300_000, signal);

  // Assert
  assert.deepEqual(options, { signal, timeout: 300_000 });
});

test("createUpgradeAgentPlugin_MissingPrerequisites_Expect_ActionableError", async () => {
  // Arrange
  const disposed = { value: false };
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed }),
    diagnose: async () => ({
      isReady: false,
      diagnostics: [
        {
          prerequisite: "dnx",
          status: "missing",
          message: 'Required executable "dnx" was not found on PATH.',
          remediation: "Install the .NET SDK 10 or later.",
        },
      ],
    }),
  };

  // Act
  const action = () => createUpgradeAgentPlugin(runtime(), {}, input);

  // Assert
  await assert.rejects(action, /dnx.*Install the .NET SDK 10 or later/);
  assert.equal(disposed.value, false);
});

test("createUpgradeAgentPlugin_PrivateBridge_Expect_PrimedDynamicTools", async () => {
  // Arrange
  const disposed = { value: false };
  const sampling = { value: undefined as SamplingCallback | undefined };
  const calls: unknown[] = [];
  let initializationSignal: AbortSignal | undefined;
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed, sampling }),
    createPrivateClient: async (
      directory: string,
      callback: SamplingCallback,
      signal: AbortSignal,
    ) => {
      sampling.value = callback;
      initializationSignal = signal;
      const client = privateClient(disposed);
      client.callTool = async (name, arguments_) => {
        calls.push({ arguments_, name });
        return { content: [] };
      };
      assert.equal(directory, "/workspace");
      return client;
    },
  };

  // Act
  const plugin = await createUpgradeAgentPlugin(
    runtime(),
    { sampling: "allow" },
    input,
  );
  await plugin.config!({});

  // Assert
  assert.deepEqual(calls, [
    { arguments_: { path: "/workspace" }, name: "get_state" },
  ]);
  assert.deepEqual(Object.keys(plugin.tool ?? {}), ["Upgrade_get_state"]);
  assert.equal(initializationSignal?.aborted, false);
  await assert.rejects(
    () =>
      sampling.value!(
        {
          method: "sampling/createMessage",
          params: { maxTokens: 1, messages: [] },
        } as never,
        new AbortController().signal,
      ),
    /not associated/,
  );
});

test("createUpgradeAgentPlugin_ConfigPreflightMcpConflict_Expect_NoPrivateClient", async () => {
  // Arrange
  const disposed = { value: false };
  let privateClientCreated = false;
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed }),
    createPrivateClient: async () => {
      privateClientCreated = true;
      return privateClient(disposed);
    },
  };

  // Act
  const plugin = await createUpgradeAgentPlugin(runtime(), {}, input);
  const action = () =>
    plugin.config!({
      mcp: { Upgrade: { command: ["existing"], type: "local" } },
    });

  // Assert
  await assert.rejects(action, /MCP key "Upgrade"/);
  assert.equal(privateClientCreated, false);
  assert.deepEqual(Object.keys(plugin.tool ?? {}), []);
});

test("createUpgradeAgentPlugin_ConfigPreflightFailure_Expect_DisposedPartialClient", async () => {
  // Arrange
  const disposed = { value: false };
  let privateClientCreated = false;
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed }),
    createBridge: async () => {
      throw new Error("Bridge initialization failed");
    },
    createPrivateClient: async () => {
      privateClientCreated = true;
      return privateClient(disposed);
    },
  };
  const plugin = await createUpgradeAgentPlugin(runtime(), {}, input);

  // Act
  const action = () => plugin.config!({});

  // Assert
  await assert.rejects(action, /Bridge initialization failed/);
  assert.equal(privateClientCreated, true);
  assert.equal(disposed.value, true);
  assert.deepEqual(Object.keys(plugin.tool ?? {}), []);
});

test("createUpgradeAgentPlugin_Config_Expect_AgentsSamplerAndNoMcpRegistration", async () => {
  // Arrange
  const disposed = { value: false };
  const schema = { type: "object" };
  const plugin = await createUpgradeAgentPlugin(
    runtime(),
    {},
    dependencies({
      disposed,
      toolDefinition: async (_input, output) => {
        (output as { jsonSchema?: unknown }).jsonSchema = schema;
      },
    }),
  );
  const config: Config = {
    agent: {
      Explicit: {
        permission: { sampling: "deny" } as never,
        prompt: "No sampling.",
      },
      Unrelated: {
        permission: { "*": "deny" } as never,
        prompt: "Ask when needed.",
      },
    },
    mcp: { Existing: { command: ["existing"], type: "local" } },
    small_model: "provider/small",
  };
  const definition = { description: "State", parameters: {} } as {
    description: string;
    jsonSchema?: unknown;
    parameters: unknown;
  };

  // Act
  await plugin.config!(config);
  await plugin["tool.definition"]!({ toolID: "Upgrade_get_state" }, definition);

  // Assert
  assert.equal(config.mcp?.Existing?.type, "local");
  assert.equal(config.mcp?.Upgrade, undefined);
  assert.equal(config.agent?.Upgrade?.prompt, "Upgrade prompt.");
  assert.equal(samplingPermission(config.permission), "ask");
  assert.equal(samplingPermission(config.agent?.Upgrade?.permission), "ask");
  assert.equal(samplingPermission(config.agent?.Unrelated?.permission), "ask");
  assert.equal(samplingPermission(config.agent?.Explicit?.permission), "deny");
  assert.equal(config.agent?.UpgradeSampler?.hidden, true);
  assert.deepEqual(config.agent?.UpgradeSampler?.permission, {
    "*": "deny",
    sampling: "ask",
  });
  assert.equal(typeof plugin["chat.params"], "function");
  assert.equal(definition.jsonSchema, schema);
  assert.equal(disposed.value, false);
});

test("createUpgradeAgentPlugin_ConcurrentConfig_Expect_SinglePrivateClient", async () => {
  // Arrange
  const disposed = { value: false };
  let privateClientCreated = 0;
  let release: (() => void) | undefined;
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed }),
    createPrivateClient: async () => {
      privateClientCreated += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return privateClient(disposed);
    },
  };
  const plugin = await createUpgradeAgentPlugin(runtime(), {}, input);

  // Act
  const first = plugin.config!({});
  const second = plugin.config!({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  release!();
  await Promise.all([first, second]);

  // Assert
  assert.equal(privateClientCreated, 1);
  assert.deepEqual(Object.keys(plugin.tool ?? {}), ["Upgrade_get_state"]);
});

test("createUpgradeAgentPlugin_DisposeBeforeConfig_Expect_NoPrivateClient", async () => {
  // Arrange
  const disposed = { value: false };
  let privateClientCreated = false;
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed }),
    createPrivateClient: async () => {
      privateClientCreated = true;
      return privateClient(disposed);
    },
  };
  const plugin = await createUpgradeAgentPlugin(runtime(), {}, input);

  // Act
  await plugin.dispose!();
  const action = () => plugin.config!({});

  // Assert
  await assert.rejects(action, /disposed before initialization/);
  assert.equal(privateClientCreated, false);
  assert.deepEqual(Object.keys(plugin.tool ?? {}), []);
});

test("createUpgradeAgentPlugin_DisposeDuringStart_Expect_CleansUpClient", async () => {
  // Arrange
  const disposed = { value: false };
  let signal: AbortSignal | undefined;
  const input: UpgradeAgentPluginDependencies = {
    ...dependencies({ disposed }),
    createBridge: async (_client, _coordinator, _sampling, abort) => {
      signal = abort;
      return new Promise<never>((_resolve, reject) => {
        abort.addEventListener("abort", () => reject(abort.reason), {
          once: true,
        });
      });
    },
  };
  const plugin = await createUpgradeAgentPlugin(runtime(), {}, input);

  // Act
  const config = plugin.config!({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cleanup = plugin.dispose!();

  // Assert
  await assert.rejects(config, /Upgrade plugin was disposed/);
  await cleanup;
  assert.equal(signal?.aborted, true);
  assert.equal(disposed.value, true);
});
