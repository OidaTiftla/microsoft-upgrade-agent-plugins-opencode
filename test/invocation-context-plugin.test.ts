import assert from "node:assert/strict";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";

import {
  InvocationContextIpcServer,
  InvocationContextRegistry,
  isValidInvocationContextToken,
  requestInvocationContext,
} from "./fixtures/dynamic-mcp/invocation-context.ts";
import {
  createInvocationContextPlugin,
  INVOCATION_CONTEXT_PROXY_NAME,
  INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL,
} from "./fixtures/dynamic-mcp/invocation-context-plugin-core.ts";

interface McpCalls {
  add: unknown[];
  connect: unknown[];
  disconnect: unknown[];
  status: unknown[];
}

function createClient(
  input: {
    readonly disconnect?: (request: unknown) => Promise<void>;
  } = {},
): {
  readonly calls: McpCalls;
  readonly client: PluginInput["client"];
} {
  const calls: McpCalls = { add: [], connect: [], disconnect: [], status: [] };
  return {
    calls,
    client: {
      mcp: {
        add: async (request: unknown) => {
          calls.add.push(request);
          return {
            data: { [INVOCATION_CONTEXT_PROXY_NAME]: { status: "connected" } },
          };
        },
        connect: async (request: unknown) => {
          calls.connect.push(request);
          return { data: true };
        },
        disconnect: async (request: unknown) => {
          calls.disconnect.push(request);
          await input.disconnect?.(request);
          return { data: true };
        },
        status: async (request: unknown) => {
          calls.status.push(request);
          return { data: {} };
        },
      },
    } as unknown as PluginInput["client"],
  };
}

test("isValidInvocationContextToken_EqualAndDifferent_Expect_Validated", () => {
  // Arrange
  const token = "a".repeat(64);

  // Act
  const result = [
    isValidInvocationContextToken(token, token),
    isValidInvocationContextToken("b".repeat(64), token),
    isValidInvocationContextToken("short", token),
  ];

  // Assert
  assert.deepEqual(result, [true, false, false]);
});

test("InvocationContextRegistry_RegisteredContext_Expect_AcquireAndRelease", () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  const context = {
    callID: "call-1",
    sessionID: "session-1",
    tool: INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL,
  };
  registry.register(context);

  // Act
  const acquired = registry.acquire(context.tool);
  registry.release(context);
  const acquireAfterRelease = () => registry.acquire(context.tool);

  // Assert
  assert.deepEqual(acquired, context);
  assert.throws(acquireAfterRelease, /cannot be matched/);
});

test("InvocationContextIpcServer_AuthenticatedContext_Expect_OnlyMatchingProxyTool", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  const token = "a".repeat(64);
  const context = {
    callID: "call-1",
    sessionID: "session-1",
    tool: INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL,
  };
  registry.register(context);
  const server = new InvocationContextIpcServer(registry, token);
  const endpoint = await server.start();

  // Act
  const acquired = await requestInvocationContext({
    endpoint,
    token,
    tool: context.tool,
  });
  const invalidToken = requestInvocationContext({
    endpoint,
    token: "b".repeat(64),
    tool: context.tool,
  });
  const unmatchedTool = requestInvocationContext({
    endpoint,
    token,
    tool: "another_proxy_tool",
  });

  // Assert
  assert.deepEqual(acquired, context);
  await assert.rejects(invalidToken, /cannot be matched/);
  await assert.rejects(unmatchedTool, /cannot be matched/);
  await server.stop();
});

test("createInvocationContextPlugin_ConcurrentProxyTools_Expect_SingleFlightAndRelease", async () => {
  // Arrange
  const { client } = createClient();
  const plugin = createInvocationContextPlugin(client);
  const context = {
    callID: "call-1",
    sessionID: "session-1",
    tool: INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL,
  };
  await plugin["tool.execute.before"]!(context, { args: {} });

  // Act
  const concurrent = plugin["tool.execute.before"]!(
    {
      ...context,
      callID: "call-2",
    },
    { args: {} },
  );
  await plugin["tool.execute.after"]!(
    { ...context, args: {} },
    {
      metadata: {},
      output: "",
      title: "",
    },
  );
  const reused = plugin["tool.execute.before"]!(
    {
      ...context,
      callID: "call-2",
    },
    { args: {} },
  );

  // Assert
  await assert.rejects(concurrent, /Only one proxy tool invocation/);
  await reused;
});

test("createInvocationContextPlugin_Controls_Expect_IpcAndMcpLifecycleCalls", async () => {
  // Arrange
  const { calls, client } = createClient();
  const ipcCalls = { start: 0, stop: 0 };
  const plugin = createInvocationContextPlugin(client, () => ({
    start: async () => {
      ipcCalls.start += 1;
      return { host: "127.0.0.1", port: 3210 };
    },
    stop: async () => {
      ipcCalls.stop += 1;
    },
  }));
  const tools = plugin.tool!;

  // Act
  const status = await tools.get_invocation_context_proxy_status.execute(
    {},
    {} as never,
  );
  await tools.enable_invocation_context_proxy.execute({}, {} as never);
  await tools.disable_invocation_context_proxy.execute({}, {} as never);
  await tools.enable_invocation_context_proxy.execute({}, {} as never);

  // Assert
  assert.equal(status, "Invocation-context proxy status=not registered.");
  assert.deepEqual(calls.status, [{ throwOnError: true }]);
  assert.equal(calls.add.length, 1);
  assert.deepEqual(calls.connect, [
    { path: { name: INVOCATION_CONTEXT_PROXY_NAME }, throwOnError: true },
  ]);
  assert.deepEqual(calls.disconnect, [
    { path: { name: INVOCATION_CONTEXT_PROXY_NAME }, throwOnError: true },
  ]);
  assert.deepEqual(ipcCalls, { start: 2, stop: 1 });
});

test("disableInvocationContextProxy_DisconnectFails_Expect_IpcStopped", async () => {
  // Arrange
  const { calls, client } = createClient({
    disconnect: async () => {
      throw new Error("disconnect failed");
    },
  });
  const ipcCalls = { start: 0, stop: 0 };
  const plugin = createInvocationContextPlugin(client, () => ({
    start: async () => {
      ipcCalls.start += 1;
      return { host: "127.0.0.1", port: 3210 };
    },
    stop: async () => {
      ipcCalls.stop += 1;
    },
  }));
  const tools = plugin.tool!;
  await tools.enable_invocation_context_proxy.execute({}, {} as never);

  // Act
  const disable = tools.disable_invocation_context_proxy.execute(
    {},
    {} as never,
  );

  // Assert
  await assert.rejects(disable, /disconnect failed/);
  assert.equal(calls.disconnect.length, 1);
  assert.deepEqual(ipcCalls, { start: 1, stop: 1 });
});

test("createInvocationContextPlugin_DisposeEnabled_Expect_DisconnectAndStop", async () => {
  // Arrange
  const { calls, client } = createClient();
  const ipcCalls = { start: 0, stop: 0 };
  const plugin = createInvocationContextPlugin(client, () => ({
    start: async () => {
      ipcCalls.start += 1;
      return { host: "127.0.0.1", port: 3210 };
    },
    stop: async () => {
      ipcCalls.stop += 1;
    },
  }));
  await plugin.tool!.enable_invocation_context_proxy.execute({}, {} as never);

  // Act
  await plugin.dispose!();

  // Assert
  assert.equal(calls.disconnect.length, 1);
  assert.deepEqual(ipcCalls, { start: 1, stop: 1 });
});
