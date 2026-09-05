import assert from "node:assert/strict";
import test from "node:test";

import type { Config, PluginInput, ToolContext } from "@opencode-ai/plugin";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS,
  InvocationContextIpcServer,
  InvocationContextRegistry,
  isValidInvocationContextToken,
  requestInvocationContext,
  type InvocationContextSamplingHandler,
} from "./fixtures/dynamic-mcp/invocation-context.ts";
import {
  createInvocationContextPlugin,
  INVOCATION_CONTEXT_PROXY_NAME,
  INVOCATION_CONTEXT_PROXY_QUALIFIED_SAMPLING_TOOL,
  INVOCATION_CONTEXT_PROXY_QUALIFIED_TOOL,
} from "./fixtures/dynamic-mcp/invocation-context-plugin-core.ts";
import {
  PerSamplingAuthorizer,
  SessionScopedSamplingAuthorizer,
} from "./fixtures/dynamic-mcp/sampling-authorization.ts";
import { invokeProxySampling } from "./fixtures/dynamic-mcp/proxy-sampling.ts";
import { SAMPLING_AGENT_NAME } from "../src/sampling-agent.ts";

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

function createSamplingClient(
  input: {
    readonly prompt?: (request: unknown) => Promise<unknown>;
  } = {},
): {
  readonly calls: {
    readonly mcp: McpCalls;
    readonly session: Record<string, unknown[]>;
  };
  readonly client: PluginInput["client"];
} {
  const base = createClient();
  const sessionCalls = {
    abort: [] as unknown[],
    create: [] as unknown[],
    delete: [] as unknown[],
    messages: [] as unknown[],
    prompt: [] as unknown[],
  };
  const assistant = {
    modelID: "parent-model",
    providerID: "parent-provider",
    tokens: { output: 1 },
  };
  const session = {
    abort: async (request: unknown) => {
      sessionCalls.abort.push(request);
      return { data: true };
    },
    create: async (request: unknown) => {
      sessionCalls.create.push(request);
      return { data: { id: "child-session" } };
    },
    delete: async (request: unknown) => {
      sessionCalls.delete.push(request);
      return { data: true };
    },
    messages: async (request: unknown) => {
      sessionCalls.messages.push(request);
      return { data: [{ info: assistant }] };
    },
    prompt: async (request: unknown) => {
      sessionCalls.prompt.push(request);
      return (
        (await input.prompt?.(request)) ?? {
          data: {
            info: assistant,
            parts: [{ text: "sampled", type: "text" }],
          },
        }
      );
    },
  };
  return {
    calls: { mcp: base.calls, session: sessionCalls },
    client: { ...base.client, session } as PluginInput["client"],
  };
}

function createToolContext(
  input: {
    readonly ask?: (input: Parameters<ToolContext["ask"]>[0]) => Promise<void>;
    readonly abort?: AbortSignal;
    readonly directory?: string;
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
      abort: input.abort ?? new AbortController().signal,
      directory: input.directory ?? "/native-workspace",
      sessionID: input.sessionID ?? "session-1",
    } as ToolContext,
  };
}

function samplingRequest(text = "sample this"): CreateMessageRequest {
  return {
    method: "sampling/createMessage",
    params: {
      maxTokens: 10,
      messages: [{ content: { text, type: "text" }, role: "user" }],
    },
  };
}

test("invokeProxySampling_InvalidMcpSignals_Expect_FreshActiveSignal", async () => {
  // Arrange
  const nativeContext = createToolContext().context;
  const invalidSignals = [
    undefined,
    false,
    {},
    { aborted: "false" },
    Object.create(AbortSignal.prototype),
  ];
  const receivedSignals: AbortSignal[] = [];

  // Act
  await Promise.all(
    invalidSignals.map((signal) =>
      invokeProxySampling(
        nativeContext,
        samplingRequest(),
        signal,
        async (_, context) => {
          receivedSignals.push(context.abort);
        },
      ),
    ),
  );

  // Assert
  assert.equal(receivedSignals.length, invalidSignals.length);
  for (const signal of receivedSignals) {
    assert.equal(signal.aborted, false);
    assert.notEqual(signal, nativeContext.abort);
    signal.addEventListener("abort", () => undefined, { once: true });
  }
  assert.equal(new Set(receivedSignals).size, invalidSignals.length);
});

test("invokeProxySampling_ActiveMcpSignal_Expect_Forwarded", async () => {
  // Arrange
  const nativeContext = createToolContext().context;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;

  // Act
  await invokeProxySampling(
    nativeContext,
    samplingRequest(),
    controller.signal,
    async (_, context) => {
      receivedSignal = context.abort;
    },
  );

  // Assert
  assert.equal(receivedSignal, controller.signal);
  assert.equal(receivedSignal.aborted, false);
});

test("invokeProxySampling_AbortedMcpSignal_Expect_Forwarded", async () => {
  // Arrange
  const nativeContext = createToolContext().context;
  const controller = new AbortController();
  controller.abort(new Error("MCP request cancelled."));
  let receivedSignal: AbortSignal | undefined;

  // Act
  await invokeProxySampling(
    nativeContext,
    samplingRequest(),
    controller.signal,
    async (_, context) => {
      receivedSignal = context.abort;
    },
  );

  // Assert
  assert.equal(receivedSignal, controller.signal);
  assert.equal(receivedSignal.aborted, true);
});

test("invokeProxySampling_McpCancellation_Expect_ReachesCallback", async () => {
  // Arrange
  const nativeContext = createToolContext().context;
  const controller = new AbortController();
  let notifyCancelled: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    notifyCancelled = resolve;
  });

  // Act
  const sampling = invokeProxySampling(
    nativeContext,
    samplingRequest(),
    controller.signal,
    async (_, context) => {
      context.abort.addEventListener("abort", notifyCancelled!, { once: true });
      await cancelled;
    },
  );
  controller.abort();
  await sampling;

  // Assert
  assert.equal(controller.signal.aborted, true);
});

test("invokeProxySampling_NativeToolContext_Expect_SessionAndDirectoryPreserved", async () => {
  // Arrange
  const nativeContext = createToolContext({
    directory: "/native-workspace",
    sessionID: "native-session",
  }).context;
  let receivedContext: ToolContext | undefined;

  // Act
  await invokeProxySampling(
    nativeContext,
    samplingRequest(),
    new AbortController().signal,
    async (_, context) => {
      receivedContext = context;
    },
  );

  // Assert
  assert.equal(receivedContext?.directory, nativeContext.directory);
  assert.equal(receivedContext?.sessionID, nativeContext.sessionID);
});

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

test("createInvocationContextPlugin_Config_Expect_HiddenModelOnlySamplingAgent", async () => {
  // Arrange
  const { client } = createClient();
  const plugin = createInvocationContextPlugin(client);
  const config: Config = { small_model: "provider/small" };

  // Act
  await plugin.config!(config);

  // Assert
  assert.equal(config.agent?.[SAMPLING_AGENT_NAME]?.hidden, true);
  assert.equal(config.agent?.[SAMPLING_AGENT_NAME]?.mode, "subagent");
  assert.deepEqual(config.agent?.[SAMPLING_AGENT_NAME]?.permission, {
    "*": "deny",
  });
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
  assert.equal(
    (
      calls.add[0] as {
        readonly body: { readonly config: { readonly timeout: number } };
      }
    ).body.config.timeout,
    INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS,
  );
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

test("createInvocationContextPlugin_SamplingHandler_Expect_OnlyApprovedSessionsForwarded", async () => {
  // Arrange
  const { client } = createClient();
  const input = createToolContext();
  const invocation = {
    callID: "call-1",
    sessionID: input.context.sessionID,
    tool: INVOCATION_CONTEXT_PROXY_QUALIFIED_SAMPLING_TOOL,
  };
  const request: CreateMessageRequest = {
    method: "sampling/createMessage",
    params: {
      maxTokens: 10,
      messages: [
        { content: { text: "sample this", type: "text" }, role: "user" },
      ],
    },
  };
  let ipcSamplingHandler: InvocationContextSamplingHandler | undefined;
  const calls: Array<{
    invocation: Parameters<InvocationContextSamplingHandler>[0];
    request: CreateMessageRequest;
  }> = [];
  const plugin = createInvocationContextPlugin(
    client,
    (_, __, handler) => {
      ipcSamplingHandler = handler;
      return {
        start: async () => ({ host: "127.0.0.1", port: 3210 }),
        stop: async () => undefined,
      };
    },
    async (matchedInvocation, matchedRequest): Promise<CreateMessageResult> => {
      calls.push({ invocation: matchedInvocation, request: matchedRequest });
      return {
        content: { text: "sampled", type: "text" },
        model: "fixture-model",
        role: "assistant",
      };
    },
  );
  if (ipcSamplingHandler === undefined)
    throw new Error("Expected an injected IPC sampling handler.");

  // Act
  const denied = ipcSamplingHandler(
    invocation,
    request,
    new AbortController().signal,
  );
  await plugin.tool!.enable_invocation_context_proxy.execute({}, input.context);
  await plugin["tool.execute.before"]!(invocation, { args: {} });
  const result = await ipcSamplingHandler(
    invocation,
    request,
    new AbortController().signal,
  );
  await plugin["tool.execute.after"]!(
    { ...invocation, args: {} },
    { metadata: {}, output: "", title: "" },
  );

  // Assert
  await assert.rejects(denied, /Sampling request unavailable/);
  assert.equal(input.asks.length, 1);
  assert.deepEqual(calls, [{ invocation, request }]);
  assert.deepEqual(result, {
    content: { text: "sampled", type: "text" },
    model: "fixture-model",
    role: "assistant",
  });
});

test("createInvocationContextPlugin_DefaultSamplingHandler_Expect_ConfiguredChildSessionSampling", async () => {
  // Arrange
  const sdk = createSamplingClient();
  const input = createToolContext();
  const directory = "/fixture-workspace";
  const invocation = {
    callID: "call-1",
    sessionID: input.context.sessionID,
    tool: INVOCATION_CONTEXT_PROXY_QUALIFIED_SAMPLING_TOOL,
  };
  const request: CreateMessageRequest = {
    method: "sampling/createMessage",
    params: {
      maxTokens: 10,
      messages: [
        { content: { text: "sample this", type: "text" }, role: "user" },
      ],
    },
  };
  let ipcSamplingHandler: InvocationContextSamplingHandler | undefined;
  const plugin = createInvocationContextPlugin(
    sdk.client,
    (_, __, handler) => {
      ipcSamplingHandler = handler;
      return {
        start: async () => ({ host: "127.0.0.1", port: 3210 }),
        stop: async () => undefined,
      };
    },
    undefined,
    directory,
  );
  if (ipcSamplingHandler === undefined)
    throw new Error("Expected the default IPC sampling handler.");
  await plugin.config!({
    small_model: "small-provider/small-model",
  } as never);
  await plugin.tool!.enable_invocation_context_proxy.execute({}, input.context);

  // Act
  const result = await ipcSamplingHandler(
    invocation,
    request,
    new AbortController().signal,
  );

  // Assert
  assert.deepEqual(result, {
    content: { text: "sampled", type: "text" },
    model: "small-provider/small-model",
    role: "assistant",
  });
  assert.deepEqual(sdk.calls.session.messages, [
    { path: { id: "session-1" }, query: { directory }, throwOnError: true },
  ]);
  assert.deepEqual(sdk.calls.session.create, [
    {
      body: { parentID: "session-1", title: "Upgrade MCP sampling" },
      query: { directory },
      throwOnError: true,
    },
  ]);
  assert.deepEqual(sdk.calls.session.prompt, [
    {
      body: {
        agent: SAMPLING_AGENT_NAME,
        model: { modelID: "small-model", providerID: "small-provider" },
        parts: [{ text: "user:\nsample this", type: "text" }],
        system: "Return only the requested sampling response within 10 tokens.",
        tools: {},
      },
      path: { id: "child-session" },
      query: { directory },
      throwOnError: true,
    },
  ]);
  assert.deepEqual(sdk.calls.session.delete, [
    {
      path: { id: "child-session" },
      query: { directory },
      throwOnError: true,
    },
  ]);
  assert.equal(input.asks.length, 1);
});

test("createInvocationContextPlugin_DefaultSamplingHandler_AbortedIpc_Expect_ChildSessionAborted", async () => {
  // Arrange
  let promptStarted: (() => void) | undefined;
  let completePrompt: (() => void) | undefined;
  const directory = "/fixture-workspace";
  const sdk = createSamplingClient({
    prompt: async () => {
      promptStarted?.();
      await new Promise<void>((resolve) => {
        completePrompt = resolve;
      });
      return {
        data: {
          info: {
            modelID: "parent-model",
            providerID: "parent-provider",
            tokens: { output: 1 },
          },
          parts: [{ text: "sampled", type: "text" }],
        },
      };
    },
  });
  const input = createToolContext();
  const invocation = {
    callID: "call-1",
    sessionID: input.context.sessionID,
    tool: INVOCATION_CONTEXT_PROXY_QUALIFIED_SAMPLING_TOOL,
  };
  const request: CreateMessageRequest = {
    method: "sampling/createMessage",
    params: {
      maxTokens: 10,
      messages: [
        { content: { text: "sample this", type: "text" }, role: "user" },
      ],
    },
  };
  const promptStartedPromise = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let ipcSamplingHandler: InvocationContextSamplingHandler | undefined;
  const plugin = createInvocationContextPlugin(
    sdk.client,
    (_, __, handler) => {
      ipcSamplingHandler = handler;
      return {
        start: async () => ({ host: "127.0.0.1", port: 3210 }),
        stop: async () => undefined,
      };
    },
    undefined,
    directory,
  );
  if (ipcSamplingHandler === undefined)
    throw new Error("Expected the default IPC sampling handler.");
  await plugin.tool!.enable_invocation_context_proxy.execute({}, input.context);
  const controller = new AbortController();

  // Act
  const sampling = ipcSamplingHandler(invocation, request, controller.signal);
  await promptStartedPromise;
  controller.abort(new Error("IPC sampling cancelled."));
  completePrompt!();

  // Assert
  await assert.rejects(sampling, /IPC sampling cancelled/);
  assert.deepEqual(sdk.calls.session.abort, [
    {
      path: { id: "child-session" },
      query: { directory },
      throwOnError: true,
    },
  ]);
  assert.deepEqual(sdk.calls.session.delete, [
    {
      path: { id: "child-session" },
      query: { directory },
      throwOnError: true,
    },
  ]);
  assert.equal(input.asks.length, 1);
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
