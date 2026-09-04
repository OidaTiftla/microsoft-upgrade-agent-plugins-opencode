import assert from "node:assert/strict";
import test from "node:test";

import type { PluginInput, ToolContext } from "@opencode-ai/plugin";

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
import {
  PerSamplingAuthorizer,
  SessionScopedSamplingAuthorizer,
} from "./fixtures/dynamic-mcp/sampling-authorization.ts";

interface McpCalls {
  add: unknown[];
  connect: unknown[];
  disconnect: unknown[];
  status: unknown[];
}

function createClient(
  input: {
    readonly add?: (request: unknown) => Promise<unknown>;
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
          return (
            (await input.add?.(request)) ?? {
              data: {
                [INVOCATION_CONTEXT_PROXY_NAME]: { status: "connected" },
              },
            }
          );
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

function createToolContext(
  input: {
    readonly ask?: (input: Parameters<ToolContext["ask"]>[0]) => Promise<void>;
    readonly sessionID?: string;
  } = {},
): { readonly asks: unknown[]; readonly context: ToolContext } {
  const asks: unknown[] = [];
  return {
    asks,
    context: {
      ask: async (request) => {
        asks.push(request);
        await input.ask?.(request);
      },
      sessionID: input.sessionID ?? "session-1",
    } as ToolContext,
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

test("createInvocationContextPlugin_ApprovedSession_Expect_AuthorizationBeforeLifecycle", async () => {
  // Arrange
  const events: string[] = [];
  const { calls, client } = createClient({
    add: async () => {
      events.push("add");
    },
  });
  const input = createToolContext({
    ask: async () => {
      events.push("ask");
    },
  });
  const ipcCalls = { start: 0, stop: 0 };
  const plugin = createInvocationContextPlugin(client, () => ({
    start: async () => {
      ipcCalls.start += 1;
      events.push("start");
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
    input.context,
  );
  await tools.enable_invocation_context_proxy.execute({}, input.context);
  await tools.disable_invocation_context_proxy.execute({}, input.context);
  await tools.enable_invocation_context_proxy.execute({}, input.context);

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
  assert.deepEqual(events.slice(0, 3), ["ask", "start", "add"]);
  assert.deepEqual(input.asks, [
    {
      permission: "sampling",
      patterns: ["invocation-context-proxy:session-1"],
      always: ["invocation-context-proxy:session-1"],
      metadata: {
        purpose:
          "Allow future sampling requests from the invocation-context proxy in this session.",
        scope: "session",
      },
    },
  ]);
});

test("enableInvocationContextProxy_DeniedAuthorization_Expect_NoLifecycleCalls", async () => {
  // Arrange
  const { calls, client } = createClient();
  const input = createToolContext({
    ask: async () => {
      throw new Error("sampling denied");
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

  // Act
  const enable = plugin.tool!.enable_invocation_context_proxy.execute(
    {},
    input.context,
  );

  // Assert
  await assert.rejects(enable, /sampling denied/);
  assert.deepEqual(calls, { add: [], connect: [], disconnect: [], status: [] });
  assert.deepEqual(ipcCalls, { start: 0, stop: 0 });
});

test("SessionScopedSamplingAuthorizer_MissingSession_Expect_NotAuthorized", () => {
  // Arrange
  const authorizer = new SessionScopedSamplingAuthorizer();

  // Act
  const authorized = authorizer.isAuthorized("missing-session");

  // Assert
  assert.equal(authorized, false);
});

test("SessionScopedSamplingAuthorizer_ApprovedSession_Expect_CrossSessionIsolation", async () => {
  // Arrange
  const approved = createToolContext();
  const unapproved = createToolContext({ sessionID: "session-2" });
  const authorizer = new SessionScopedSamplingAuthorizer();

  // Act
  await authorizer.enforce(approved.context, { metadata: {} });
  const authorized = authorizer.isAuthorized(approved.context.sessionID);
  const otherSessionAuthorized = authorizer.isAuthorized(
    unapproved.context.sessionID,
  );

  // Assert
  assert.equal(authorized, true);
  assert.equal(otherSessionAuthorized, false);
});

test("SessionScopedSamplingAuthorizer_DeniedSession_Expect_NotAuthorized", async () => {
  // Arrange
  const input = createToolContext({
    ask: async () => {
      throw new Error("sampling denied");
    },
  });
  const authorizer = new SessionScopedSamplingAuthorizer();

  // Act
  const enforce = authorizer.enforce(input.context, { metadata: {} });

  // Assert
  await assert.rejects(enforce, /sampling denied/);
  assert.equal(authorizer.isAuthorized(input.context.sessionID), false);
});

test("PerSamplingAuthorizer_SamplingRequests_Expect_DistinctRequestPatterns", async () => {
  // Arrange
  const input = createToolContext();
  const sessionAuthorizer = new SessionScopedSamplingAuthorizer();
  const authorizer = new PerSamplingAuthorizer();
  const first = {
    metadata: { preview: "first request" },
    requestID: "request-1",
  };
  const second = {
    metadata: { preview: "second request" },
    requestID: "request-2",
  };

  // Act
  await sessionAuthorizer.enforce(input.context, { metadata: {} });
  await authorizer.enforce(input.context, first);
  await authorizer.enforce(input.context, second);

  // Assert
  assert.deepEqual(input.asks, [
    {
      permission: "sampling",
      patterns: ["invocation-context-proxy:session-1"],
      always: ["invocation-context-proxy:session-1"],
      metadata: {},
    },
    {
      permission: "sampling",
      patterns: ["invocation-context-proxy:session-1:sampling:request-1"],
      always: [],
      metadata: first.metadata,
    },
    {
      permission: "sampling",
      patterns: ["invocation-context-proxy:session-1:sampling:request-2"],
      always: [],
      metadata: second.metadata,
    },
  ]);
});

test("disableInvocationContextProxy_DisconnectFails_Expect_IpcStopped", async () => {
  // Arrange
  const { calls, client } = createClient({
    disconnect: async () => {
      throw new Error("disconnect failed");
    },
  });
  const input = createToolContext();
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
  await tools.enable_invocation_context_proxy.execute({}, input.context);

  // Act
  const disable = tools.disable_invocation_context_proxy.execute(
    {},
    input.context,
  );

  // Assert
  await assert.rejects(disable, /disconnect failed/);
  assert.equal(calls.disconnect.length, 1);
  assert.deepEqual(ipcCalls, { start: 1, stop: 1 });
});

test("createInvocationContextPlugin_DisposeEnabled_Expect_DisconnectAndStop", async () => {
  // Arrange
  const { calls, client } = createClient();
  const input = createToolContext();
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
  await plugin.tool!.enable_invocation_context_proxy.execute({}, input.context);

  // Act
  await plugin.dispose!();

  // Assert
  assert.equal(calls.disconnect.length, 1);
  assert.deepEqual(ipcCalls, { start: 1, stop: 1 });
});
