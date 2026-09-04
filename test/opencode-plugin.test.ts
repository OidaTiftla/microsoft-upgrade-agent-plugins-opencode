import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Config, PluginInput, ToolContext } from "@opencode-ai/plugin";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { AgentConversionResult } from "../src/agent-converter.ts";
import * as packageEntry from "../src/index.ts";
import {
  createUpgradeAgentPlugin,
  getPluginOptions,
  type UpgradeAgentPluginDependencies,
  type UpgradeAgentPluginRuntime,
} from "../src/upgrade-agent-plugin.ts";
import type { PrivateCoreMcpClient } from "../src/private-core-mcp-client.ts";
import type { McpTool } from "../src/core-mcp-runtime.ts";
import type {
  ExecuteUpgradeCoreTool,
  UpgradeInvocationRegistry,
} from "../src/upgrade-mcp-proxy-transport.ts";

const conversion: AgentConversionResult = {
  agents: [
    {
      description: "Upgrade projects.",
      hidden: false,
      id: "upgrade",
      mode: "primary",
      name: "Upgrade",
      permission: { "*": "deny" },
      system: "Upgrade prompt.",
    },
  ],
  diagnostics: [],
};

function context(sessionID = "session"): ToolContext {
  return {
    abort: new AbortController().signal,
    agent: "Upgrade",
    ask: async () => undefined,
    directory: "/workspace",
    messageID: "message",
    metadata: () => undefined,
    sessionID,
    worktree: "/workspace",
  };
}

function output(value: unknown): string {
  return (value as { output: string }).output;
}

function privateClient(
  disposed: { value: boolean },
  calls: unknown[],
): PrivateCoreMcpClient {
  return {
    callTool: async (name, arguments_) => {
      calls.push({ arguments_, name });
      return { content: [] };
    },
    client: {} as Client,
    dispose: async () => {
      disposed.value = true;
    },
    listTools: async () => ({
      tools: [
        {
          description: "Get state.",
          inputSchema: { type: "object" },
          name: "get_state",
        },
      ],
    }),
    subscribeToToolListChanges: () => () => undefined,
  };
}

type ProxyCapture = {
  execute: ExecuteUpgradeCoreTool;
  list: () => Promise<McpTool[]>;
  registry: UpgradeInvocationRegistry;
  started: number;
  stopped: number;
  token: string;
};

function setup(
  policy: "ask" | "allow" | "deny" = "ask",
  addStatus = "connected",
) {
  const calls: unknown[] = [];
  const disposed = { value: false };
  const mcpCalls: unknown[] = [];
  let status: string | undefined;
  let proxy: ProxyCapture | undefined;
  const runtime: UpgradeAgentPluginRuntime = {
    client: {
      mcp: {
        add: async (input: unknown) => {
          mcpCalls.push({ add: input });
          status = addStatus;
          return { data: { Upgrade: { status } } };
        },
        connect: async (input: unknown) => {
          mcpCalls.push({ connect: input });
          status = "connected";
          return { data: true };
        },
        disconnect: async (input: unknown) => {
          mcpCalls.push({ disconnect: input });
          status = "disabled";
          return { data: true };
        },
        status: async () => ({
          data: status === undefined ? {} : { Upgrade: { status } },
        }),
      },
      session: {},
    } as unknown as PluginInput["client"],
    directory: "/workspace",
  };
  const dependencies: UpgradeAgentPluginDependencies = {
    convertAgents: async () => conversion,
    createPrivateClient: async () => privateClient(disposed, calls),
    createProxyServer: (registry, token, list, execute) => {
      proxy = { execute, list, registry, started: 0, stopped: 0, token };
      return {
        start: async () => {
          proxy!.started += 1;
          return { host: "127.0.0.1", port: 43123 };
        },
        stop: async () => {
          proxy!.stopped += 1;
        },
      };
    },
    diagnose: async () => ({ diagnostics: [], isReady: true }),
    warn: () => undefined,
  };
  return {
    calls,
    dependencies,
    disposed,
    mcpCalls,
    proxy: () => proxy,
    runtime,
    setStatus: (value: string | undefined) => {
      status = value;
    },
    policy,
  };
}

test("packageEntry_ExportsServerEntrypoint_Expect_DefaultPluginOnly", async () => {
  // Arrange
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  // Act
  const exports = Object.keys(packageEntry);

  // Assert
  assert.equal(packageJson.exports["./server"], "./src/index.ts");
  assert.deepEqual(exports, ["default"]);
});

test("getPluginOptions_MissingOrUnknown_Expect_DefaultOrError", () => {
  // Arrange
  const options = { unsupported: true };

  // Act
  const result = getPluginOptions({});
  const action = () => getPluginOptions(options);

  // Assert
  assert.deepEqual(result, { sampling: "ask" });
  assert.throws(action, /Unknown Upgrade plugin option/);
});

test("createUpgradeAgentPlugin_MissingPrerequisites_Expect_NoInitialization", async () => {
  // Arrange
  const fixture = setup();
  const dependencies: UpgradeAgentPluginDependencies = {
    ...fixture.dependencies,
    diagnose: async () => ({
      diagnostics: [
        {
          message: "missing",
          prerequisite: "dnx",
          remediation: "Install it.",
          status: "missing",
        },
      ],
      isReady: false,
    }),
  };

  // Act
  const action = () =>
    createUpgradeAgentPlugin(fixture.runtime, {}, dependencies);

  // Assert
  await assert.rejects(action, /dnx.*Install it/);
  assert.equal(fixture.proxy(), undefined);
});

test("createUpgradeAgentPlugin_Config_Expect_LazyFourControls", async () => {
  // Arrange
  const fixture = setup();
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: fixture.policy },
    fixture.dependencies,
  );
  const config: Config = { small_model: "provider/small" };

  // Act
  await plugin.config!(config);

  // Assert
  assert.deepEqual(Object.keys(plugin.tool ?? {}).sort(), [
    "disable_upgrade_mcp",
    "enable_upgrade_mcp",
    "get_upgrade_mcp_status",
    "list_upgrade_mcp_tools",
  ]);
  assert.equal(fixture.proxy(), undefined);
  assert.equal(config.agent?.UpgradeSampler?.hidden, true);
  assert.equal(config.agent?.Upgrade?.prompt, "Upgrade prompt.");
  assert.equal(plugin["tool.definition"], undefined);
});

test("createUpgradeAgentPlugin_Enable_Expect_ApprovesAddsPrimesAndCorrelates", async () => {
  // Arrange
  const fixture = setup();
  let approvals = 0;
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "ask" },
    fixture.dependencies,
  );
  await plugin.config!({});
  const first = {
    ...context(),
    ask: async () => {
      approvals += 1;
    },
  };

  // Act
  await plugin.tool!.enable_upgrade_mcp.execute({}, first);
  await plugin["tool.execute.before"]!(
    { callID: "call", sessionID: "session", tool: "Upgrade_get_state" },
    { args: {} },
  );
  const result = await fixture.proxy()!.execute!(
    { callID: "call", sessionID: "session", tool: "Upgrade_get_state" },
    "get_state",
    { path: "/repo" },
    new AbortController().signal,
  );
  await plugin["tool.execute.after"]!(
    {
      args: {},
      callID: "call",
      sessionID: "session",
      tool: "Upgrade_get_state",
    },
    {} as never,
  );

  // Assert
  assert.equal(approvals, 1);
  assert.deepEqual(fixture.calls, [
    { arguments_: { path: "/workspace" }, name: "get_state" },
    { arguments_: { path: "/repo" }, name: "get_state" },
  ]);
  assert.deepEqual(result, { content: [] });
  const add = fixture.mcpCalls.find((call) => "add" in (call as object)) as {
    add: {
      body: {
        config: {
          command: string[];
          environment: Record<string, string>;
          timeout: number;
          type: string;
        };
      };
    };
  };
  assert.equal(add.add.body.config.command[0], "node");
  assert.equal(
    add.add.body.config.environment.UPGRADE_MCP_PROXY_HOST,
    "127.0.0.1",
  );
  assert.equal(
    add.add.body.config.environment.UPGRADE_MCP_PROXY_TOKEN.length,
    64,
  );
  assert.equal(add.add.body.config.timeout, 3_600_000);
});

test("createUpgradeAgentPlugin_EnableSessionsAndDisable_Expect_CachesAskAndReconnects", async () => {
  // Arrange
  const fixture = setup();
  let approvals = 0;
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "ask" },
    fixture.dependencies,
  );
  await plugin.config!({});
  const approved = (id: string) => ({
    ...context(id),
    ask: async () => {
      approvals += 1;
    },
  });

  // Act
  await plugin.tool!.enable_upgrade_mcp.execute({}, approved("one"));
  await plugin.tool!.enable_upgrade_mcp.execute({}, approved("one"));
  await plugin.tool!.disable_upgrade_mcp.execute({}, context());
  await plugin.tool!.disable_upgrade_mcp.execute({}, context());
  await plugin.tool!.enable_upgrade_mcp.execute({}, approved("two"));

  // Assert
  assert.equal(approvals, 2);
  assert.equal(
    fixture.mcpCalls.filter((call) => "add" in (call as object)).length,
    1,
  );
  assert.equal(
    fixture.mcpCalls.filter((call) => "connect" in (call as object)).length,
    1,
  );
  assert.equal(
    fixture.mcpCalls.filter((call) => "disconnect" in (call as object)).length,
    1,
  );
  assert.equal(fixture.proxy()!.started, 2);
  assert.equal(fixture.proxy()!.stopped, 1);
});

test("createUpgradeAgentPlugin_RepeatedEnableAfterExternalDisconnect_Expect_Reconnects", async () => {
  // Arrange
  const fixture = setup("allow");
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});
  await plugin.tool!.enable_upgrade_mcp.execute({}, context());
  fixture.setStatus("failed");

  // Act
  const result = await plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Assert
  assert.equal(output(result), "Upgrade MCP connected.");
  assert.equal(
    fixture.mcpCalls.filter((call) => "connect" in (call as object)).length,
    1,
  );
});

test("createUpgradeAgentPlugin_DisposeDuringApproval_Expect_CancelsQueuedEnable", async () => {
  // Arrange
  const fixture = setup();
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "ask" },
    fixture.dependencies,
  );
  await plugin.config!({});
  const approval = Promise.withResolvers<void>();
  const enable = plugin.tool!.enable_upgrade_mcp.execute(
    {},
    { ...context(), ask: () => approval.promise },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Act
  await plugin.dispose!();

  // Assert
  await assert.rejects(enable, /disposed|abort|cancel/i);
  assert.equal(fixture.proxy(), undefined);
  approval.resolve();
});

test("createUpgradeAgentPlugin_DisposeDuringMcpStatus_Expect_AbortsRequestAndSettles", async () => {
  // Arrange
  const fixture = setup("allow");
  const requestStarted = Promise.withResolvers<AbortSignal>();
  fixture.runtime.client.mcp.status = async (input) => {
    requestStarted.resolve(input?.signal as AbortSignal);
    return new Promise<never>(() => undefined);
  };
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});
  const enable = plugin.tool!.enable_upgrade_mcp.execute({}, context());
  const signal = await requestStarted.promise;

  // Act
  await plugin.dispose!();

  // Assert
  assert.equal(signal.aborted, true);
  await assert.rejects(enable, /disposed|abort|cancel/i);
});

test("createUpgradeAgentPlugin_ConnectionVerificationFailure_Expect_CleansDynamicMcpAndPreservesError", async () => {
  // Arrange
  const fixture = setup("allow");
  fixture.runtime.client.mcp.status = (async () => ({
    data: { Upgrade: { status: "failed" } },
  })) as unknown as typeof fixture.runtime.client.mcp.status;
  fixture.runtime.client.mcp.disconnect = async (input) => {
    fixture.mcpCalls.push({ disconnect: input });
    throw new Error("cleanup failed");
  };
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});

  // Act
  const action = () => plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Assert
  await assert.rejects(action, /did not connect/);
  assert.equal(fixture.proxy()!.stopped, 1);
  assert.equal(
    fixture.mcpCalls.filter((call) => "disconnect" in (call as object)).length,
    1,
  );
});

test("createUpgradeAgentPlugin_Dispose_Expect_CleansInitializedResources", async () => {
  // Arrange
  const fixture = setup("allow");
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});
  await plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Act
  await Promise.all([plugin.dispose!(), plugin.dispose!()]);

  // Assert
  assert.equal(fixture.disposed.value, true);
  assert.equal(fixture.proxy()!.stopped, 1);
});

test("createUpgradeAgentPlugin_DisposeAfterInitializationAbort_Expect_UsesLiveBoundedDisconnectSignal", async () => {
  // Arrange
  const fixture = setup("allow");
  let initializationSignal: AbortSignal | undefined;
  const dependencies: UpgradeAgentPluginDependencies = {
    ...fixture.dependencies,
    createPrivateClient: async (sampling, signal) => {
      initializationSignal = signal;
      return fixture.dependencies.createPrivateClient(sampling, signal);
    },
  };
  const disconnectStarted = Promise.withResolvers<AbortSignal>();
  const disconnectFinished = Promise.withResolvers<void>();
  fixture.runtime.client.mcp.disconnect = (async (input) => {
    disconnectStarted.resolve(input.signal as AbortSignal);
    await disconnectFinished.promise;
    return { data: true };
  }) as typeof fixture.runtime.client.mcp.disconnect;
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    dependencies,
  );
  await plugin.config!({});
  await plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Act
  const disposal = plugin.dispose!();
  const cleanupSignal = await disconnectStarted.promise;

  // Assert
  assert.equal(initializationSignal?.aborted, true);
  assert.equal(cleanupSignal.aborted, false);
  disconnectFinished.resolve();
  await disposal;
});

test("createUpgradeAgentPlugin_DisposeDuringMcpAdd_Expect_UsesLiveBoundedDisconnectSignal", async () => {
  // Arrange
  const fixture = setup("allow");
  const addStarted = Promise.withResolvers<void>();
  const disconnectSignals: AbortSignal[] = [];
  fixture.runtime.client.mcp.add = async () => {
    fixture.setStatus("connected");
    addStarted.resolve();
    return new Promise<never>(() => undefined);
  };
  fixture.runtime.client.mcp.disconnect = (async (input) => {
    disconnectSignals.push(input.signal as AbortSignal);
    fixture.setStatus("disabled");
    return { data: true };
  }) as typeof fixture.runtime.client.mcp.disconnect;
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});
  const enable = plugin.tool!.enable_upgrade_mcp.execute({}, context());
  await addStarted.promise;

  // Act
  await plugin.dispose!();

  // Assert
  await assert.rejects(enable, /disposed|abort|cancel/i);
  assert.equal(disconnectSignals.length, 1);
  assert.equal(disconnectSignals[0]?.aborted, false);
});

test("createUpgradeAgentPlugin_ConcurrentEnable_Expect_SingleInitialization", async () => {
  // Arrange
  const fixture = setup("allow");
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});

  // Act
  await Promise.all([
    plugin.tool!.enable_upgrade_mcp.execute({}, context("one")),
    plugin.tool!.enable_upgrade_mcp.execute({}, context("two")),
  ]);

  // Assert
  assert.equal(
    fixture.mcpCalls.filter((call) => "add" in (call as object)).length,
    1,
  );
  assert.equal(fixture.proxy()!.started, 1);
});

test("createUpgradeAgentPlugin_StatusAndList_Expect_ReflectsConnection", async () => {
  // Arrange
  const fixture = setup("allow");
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});
  const before = await plugin.tool!.get_upgrade_mcp_status.execute(
    {},
    context(),
  );
  await plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Act
  const status = await plugin.tool!.get_upgrade_mcp_status.execute(
    {},
    context(),
  );
  const tools = await plugin.tool!.list_upgrade_mcp_tools.execute(
    {},
    context(),
  );
  await plugin.tool!.disable_upgrade_mcp.execute({}, context());
  const unavailable = await plugin.tool!.list_upgrade_mcp_tools.execute(
    {},
    context(),
  );

  // Assert
  assert.equal(output(before), "not registered");
  assert.match(output(status), /connected/);
  assert.equal(output(tools), "Upgrade_get_state: Get state.");
  assert.equal(output(unavailable), "Upgrade MCP unavailable.");
});

test("createUpgradeAgentPlugin_AddStatusNotConnected_Expect_ReconnectRetry", async () => {
  // Arrange
  const fixture = setup("allow", "disabled");
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    fixture.dependencies,
  );
  await plugin.config!({});

  // Act
  await assert.rejects(
    () => plugin.tool!.enable_upgrade_mcp.execute({}, context()),
    /did not connect/,
  );
  await plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Assert
  assert.equal(
    fixture.mcpCalls.filter((call) => "add" in (call as object)).length,
    1,
  );
  assert.equal(
    fixture.mcpCalls.filter((call) => "connect" in (call as object)).length,
    1,
  );
});

test("createUpgradeAgentPlugin_PartialInitialization_Expect_DisposesClient", async () => {
  // Arrange
  const fixture = setup("allow");
  const dependencies: UpgradeAgentPluginDependencies = {
    ...fixture.dependencies,
    createPrivateClient: async () => {
      const client = privateClient(fixture.disposed, fixture.calls);
      client.callTool = async () => Promise.reject(new Error("prime failed"));
      return client;
    },
  };
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    { sampling: "allow" },
    dependencies,
  );
  await plugin.config!({});

  // Act
  const action = () => plugin.tool!.enable_upgrade_mcp.execute({}, context());

  // Assert
  await assert.rejects(action, /prime failed/);
  assert.equal(fixture.disposed.value, true);
  assert.equal(fixture.proxy(), undefined);
});

test("createUpgradeAgentPlugin_ConfigConflictAndDisposeBeforeEnable_Expect_NoInitialization", async () => {
  // Arrange
  const fixture = setup();
  const plugin = await createUpgradeAgentPlugin(
    fixture.runtime,
    {},
    fixture.dependencies,
  );

  // Act
  const conflict = () =>
    plugin.config!({
      mcp: { Upgrade: { command: ["existing"], type: "local" } },
    });
  await assert.rejects(conflict, /MCP key "Upgrade"/);
  await plugin.dispose!();
  const disposed = () => plugin.config!({});

  // Assert
  await assert.rejects(disposed, /disposed/);
  assert.equal(fixture.proxy(), undefined);
});

test("getPluginOptions_InvalidSampling_Expect_ThrowsException", () => {
  // Arrange
  const options = { sampling: "always" };

  // Act
  const action = () => getPluginOptions(options);

  // Assert
  assert.throws(action, /sampling.*ask.*allow.*deny/);
});
