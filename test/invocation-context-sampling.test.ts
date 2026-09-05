import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";

import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  INVOCATION_CONTEXT_IPC_CONTROL_TIMEOUT_MS,
  INVOCATION_CONTEXT_IPC_MAX_FRAME_BYTES,
  INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS,
  InvocationContextIpcServer,
  InvocationContextRegistry,
  requestInvocationContext,
  requestInvocationContextSampling,
  type InvocationContext,
  type InvocationContextEndpoint,
} from "./fixtures/dynamic-mcp/invocation-context.ts";
import {
  getProxyInvocationContext,
  requestProxySampling,
  type InvocationContextProxyConfig,
  type InvocationContextProxyRequestDispatch,
} from "./fixtures/dynamic-mcp/invocation-context-proxy-client.ts";

const token = "a".repeat(64);
const invocation: InvocationContext = {
  callID: "call-1",
  sessionID: "session-1",
  tool: "invocation-context-proxy_get_invocation_context",
};

function samplingRequest(text = "sample this"): CreateMessageRequest {
  return {
    method: "sampling/createMessage",
    params: {
      maxTokens: 10,
      messages: [{ content: { text, type: "text" }, role: "user" }],
    },
  };
}

function samplingResult(): CreateMessageResult {
  return {
    content: { text: "sampled", type: "text" },
    model: "fixture-model",
    role: "assistant",
  };
}

function proxySamplingConfig(): InvocationContextProxyConfig {
  return {
    endpoint: { host: "127.0.0.1", port: 1 },
    token,
    tool: invocation.tool,
  };
}

function samplingFrame(
  input: {
    readonly invocation?: InvocationContext;
    readonly request?: CreateMessageRequest;
    readonly requestID?: string;
    readonly token?: string;
    readonly tool?: string;
  } = {},
): string {
  const matchedInvocation = input.invocation ?? invocation;
  return JSON.stringify({
    invocation: matchedInvocation,
    request: input.request ?? samplingRequest(),
    requestID: input.requestID ?? "request-1",
    token: input.token ?? token,
    tool: input.tool ?? matchedInvocation.tool,
    type: "sampling",
    version: 1,
  });
}

function releaseFrame(
  input: {
    readonly invocation?: InvocationContext;
    readonly token?: string;
    readonly tool?: string;
  } = {},
): string {
  const matchedInvocation = input.invocation ?? invocation;
  return JSON.stringify({
    invocation: matchedInvocation,
    token: input.token ?? token,
    tool: input.tool ?? matchedInvocation.tool,
    type: "release",
    version: 1,
  });
}

function requestFrame(
  endpoint: InvocationContextEndpoint,
  frame: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.port, endpoint.host);
    let responseText = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (data: string) => {
      responseText += data;
    });
    socket.once("end", () => {
      try {
        const response: unknown = JSON.parse(responseText);
        if (typeof response !== "object" || response === null)
          throw new Error("Expected an IPC response object.");
        resolve(response as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.end(`${frame}\n`));
  });
}

function openFrameSocket(
  endpoint: InvocationContextEndpoint,
  frame: string,
): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.port, endpoint.host);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${frame}\n`);
      resolve(socket);
    });
  });
}

test("InvocationContextIpcServer_AuthenticatedSampling_Expect_ForwardedToHandler", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  const request = samplingRequest();
  const calls: Array<{
    invocation: InvocationContext;
    request: CreateMessageRequest;
  }> = [];
  registry.register(invocation);
  const server = new InvocationContextIpcServer(
    registry,
    token,
    async (matchedInvocation, matchedRequest) => {
      calls.push({ invocation: matchedInvocation, request: matchedRequest });
      return samplingResult();
    },
  );
  const endpoint = await server.start();

  // Act
  const result = await requestInvocationContextSampling({
    endpoint,
    invocation,
    request,
    requestID: "request-1",
    token,
  });

  // Assert
  assert.deepEqual(result, samplingResult());
  assert.deepEqual(calls, [{ invocation, request }]);
  await server.stop();
});

test("requestInvocationContextSampling_HandlerExceedsControlTimeout_Expect_Success", async (t) => {
  // Arrange
  const registry = new InvocationContextRegistry();
  registry.register(invocation);
  const server = new InvocationContextIpcServer(registry, token, async () => {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, INVOCATION_CONTEXT_IPC_CONTROL_TIMEOUT_MS + 100),
    );
    return samplingResult();
  });
  const endpoint = await server.start();
  t.after(() => server.stop());

  // Act
  const result = await requestInvocationContextSampling({
    endpoint,
    invocation,
    request: samplingRequest(),
    requestID: "exceeds-control-timeout",
    token,
  });

  // Assert
  assert.equal(INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS, 3_600_000);
  assert.deepEqual(result, samplingResult());
});

test("InvocationContextIpcServer_SamplingFailure_Expect_SanitizedIpcResponse", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  const sensitive = [
    "prompt=private request",
    "token=private-token",
    "Authorization: Bearer private-authorization",
    "headers={private-header}",
    "stack trace=private-stack",
  ];
  registry.register(invocation);
  const server = new InvocationContextIpcServer(registry, token, async () => {
    throw new Error(sensitive.join("; "));
  });
  const endpoint = await server.start();

  // Act
  const response = await requestFrame(
    endpoint,
    samplingFrame({ request: samplingRequest(sensitive[0]) }),
  );

  // Assert
  assert.deepEqual(response, {
    error: "Sampling request unavailable.",
    type: "error",
    version: 1,
  });
  for (const value of sensitive)
    assert.equal(JSON.stringify(response).includes(value), false);
  await server.stop();
});

test("InvocationContextIpcServer_InvalidFrames_Expect_FailClosed", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  registry.register(invocation);
  const server = new InvocationContextIpcServer(registry, token, async () =>
    samplingResult(),
  );
  const endpoint = await server.start();

  // Act
  const malformed = await requestFrame(endpoint, "not json");
  const wrongToken = await requestFrame(
    endpoint,
    samplingFrame({ token: "b".repeat(64) }),
  );
  const wrongTool = await requestFrame(
    endpoint,
    samplingFrame({ tool: "another_tool" }),
  );
  const wrongInvocation = await requestFrame(
    endpoint,
    samplingFrame({
      invocation: { ...invocation, sessionID: "another-session" },
      requestID: "wrong-invocation",
    }),
  );
  const invalidRelease = await requestFrame(
    endpoint,
    releaseFrame({ invocation: { ...invocation, callID: "another-call" } }),
  );
  const invalidReleaseToken = await requestFrame(
    endpoint,
    releaseFrame({ token: "b".repeat(64) }),
  );
  const invalidReleaseTool = await requestFrame(
    endpoint,
    releaseFrame({ tool: "another_tool" }),
  );
  const oversized = await requestFrame(
    endpoint,
    `${samplingFrame({ request: samplingRequest("x".repeat(INVOCATION_CONTEXT_IPC_MAX_FRAME_BYTES)) })}`,
  );
  const first = await requestFrame(endpoint, samplingFrame());
  const duplicate = await requestFrame(endpoint, samplingFrame());
  registry.release(invocation);
  const noActiveContext = await requestFrame(
    endpoint,
    samplingFrame({ requestID: "no-active-context" }),
  );

  // Assert
  for (const response of [
    malformed,
    wrongToken,
    wrongTool,
    invalidRelease,
    invalidReleaseToken,
    invalidReleaseTool,
    oversized,
  ]) {
    assert.deepEqual(response, {
      error: "Invocation context cannot be matched.",
      type: "error",
      version: 1,
    });
  }
  for (const response of [wrongInvocation, duplicate, noActiveContext]) {
    assert.deepEqual(response, {
      error: "Sampling request unavailable.",
      type: "error",
      version: 1,
    });
  }
  assert.equal(first.type, "sampling");
  await server.stop();
});

test("getProxyInvocationContext_Success_Expect_ExactContextReleased", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  registry.register(invocation);
  const server = new InvocationContextIpcServer(registry, token);
  const endpoint = await server.start();
  const config = { endpoint, token, tool: invocation.tool };

  // Act
  const context = await getProxyInvocationContext(config);
  const staleContext = requestInvocationContext(config);

  // Assert
  assert.deepEqual(context, invocation);
  await assert.rejects(staleContext, /Invocation context cannot be matched/);
  await server.stop();
});

test("requestProxySampling_SamplingFailure_Expect_ExactContextReleased", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  registry.register(invocation);
  const server = new InvocationContextIpcServer(registry, token);
  const endpoint = await server.start();
  const config = { endpoint, token, tool: invocation.tool };

  // Act
  const sampling = requestProxySampling({
    config,
    maxTokens: 10,
    signal: new AbortController().signal,
    text: "private prompt",
  });
  await assert.rejects(sampling, /Sampling request unavailable/);
  const staleContext = requestInvocationContext(config);

  // Assert
  await assert.rejects(staleContext, /Invocation context cannot be matched/);
  await server.stop();
});

test("requestProxySampling_InvalidSignal_Expect_NormalizedBeforeRequestDispatch", async () => {
  // Arrange
  const config = proxySamplingConfig();
  let receivedSignal: AbortSignal | undefined;
  const requestDispatch: InvocationContextProxyRequestDispatch = {
    requestContext: async () => invocation,
    requestRelease: async () => undefined,
    requestSampling: async (input) => {
      receivedSignal = input.signal;
      return samplingResult();
    },
  };

  // Act
  const result = await requestProxySampling(
    { config, maxTokens: 10, signal: false, text: "sample this" },
    requestDispatch,
  );

  // Assert
  assert.deepEqual(result, samplingResult());
  assert.notEqual(receivedSignal, false);
  assert.equal(receivedSignal?.aborted, false);
});

test("requestProxySampling_ValidSignals_Expect_ForwardedAndCancellationPreserved", async () => {
  // Arrange
  const config = proxySamplingConfig();
  const activeController = new AbortController();
  const abortedController = new AbortController();
  const receivedSignals: Array<AbortSignal | undefined> = [];
  let notifyRequestDispatched: (() => void) | undefined;
  const requestDispatched = new Promise<void>((resolve) => {
    notifyRequestDispatched = resolve;
  });
  const requestDispatch: InvocationContextProxyRequestDispatch = {
    requestContext: async () => invocation,
    requestRelease: async () => undefined,
    requestSampling: (input) => {
      receivedSignals.push(input.signal);
      notifyRequestDispatched?.();
      if (input.signal?.aborted) return Promise.reject(new Error("cancelled"));
      return new Promise<CreateMessageResult>((_, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      });
    },
  };
  abortedController.abort();

  // Act
  const activeSampling = requestProxySampling(
    {
      config,
      maxTokens: 10,
      signal: activeController.signal,
      text: "sample this",
    },
    requestDispatch,
  );
  await requestDispatched;
  activeController.abort();
  await assert.rejects(activeSampling, /cancelled/);
  await assert.rejects(
    requestProxySampling(
      {
        config,
        maxTokens: 10,
        signal: abortedController.signal,
        text: "sample this",
      },
      requestDispatch,
    ),
    /cancelled/,
  );

  // Assert
  assert.deepEqual(receivedSignals, [
    activeController.signal,
    abortedController.signal,
  ]);
  assert.equal(activeController.signal.aborted, true);
  assert.equal(abortedController.signal.aborted, true);
});

test("requestInvocationContextSampling_TerminalPaths_Expect_CleanedUpAndCancelled", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  let notifyHandlerStarted: (() => void) | undefined;
  let notifyHandlerCancelled: (() => void) | undefined;
  const handlerStarted = new Promise<void>((resolve) => {
    notifyHandlerStarted = resolve;
  });
  const handlerCancelled = new Promise<void>((resolve) => {
    notifyHandlerCancelled = resolve;
  });
  registry.register(invocation);
  const server = new InvocationContextIpcServer(
    registry,
    token,
    async (_, request, signal) => {
      if (request.params.messages.length === 0) {
        notifyHandlerStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              notifyHandlerCancelled?.();
              resolve();
            },
            { once: true },
          );
        });
        throw new Error("cancelled");
      }
      return samplingResult();
    },
  );
  const endpoint = await server.start();
  const completedController = new AbortController();
  const failedController = new AbortController();
  const cancelledController = new AbortController();

  // Act
  const completed = await requestInvocationContextSampling({
    endpoint,
    invocation,
    request: samplingRequest(),
    requestID: "complete",
    signal: completedController.signal,
    token,
  });
  const failed = assert.rejects(
    requestInvocationContextSampling({
      endpoint,
      invocation,
      request: samplingRequest(),
      requestID: "failed",
      signal: failedController.signal,
      token: "b".repeat(64),
    }),
    /Invocation context cannot be matched/,
  );
  const cancelled = assert.rejects(
    requestInvocationContextSampling({
      endpoint,
      invocation,
      request: {
        method: "sampling/createMessage",
        params: { maxTokens: 10, messages: [] },
      },
      requestID: "cancelled",
      signal: cancelledController.signal,
      token,
    }),
    /Invocation context cannot be matched/,
  );
  await handlerStarted;
  cancelledController.abort();
  await failed;
  await cancelled;
  await handlerCancelled;

  // Assert
  assert.deepEqual(completed, samplingResult());
  for (const signal of [
    completedController.signal,
    failedController.signal,
    cancelledController.signal,
  ])
    assert.equal(getEventListeners(signal, "abort").length, 0);
  await server.stop();
});

test("InvocationContextIpcServer_StopAndRestart_Expect_ReleasedRequestIDs", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  registry.register(invocation);
  const server = new InvocationContextIpcServer(registry, token, async () =>
    samplingResult(),
  );
  const endpoint = await server.start();
  await requestInvocationContextSampling({
    endpoint,
    invocation,
    request: samplingRequest(),
    requestID: "reused-after-restart",
    token,
  });

  // Act
  const [, restartedEndpoint] = await Promise.all([
    server.stop(),
    server.start(),
  ]);
  const result = await requestInvocationContextSampling({
    endpoint: restartedEndpoint,
    invocation,
    request: samplingRequest(),
    requestID: "reused-after-restart",
    token,
  });

  // Assert
  assert.equal(restartedEndpoint.port, endpoint.port);
  assert.deepEqual(result, samplingResult());
  await server.stop();
});

test("InvocationContextIpcServer_ConcurrentStart_Expect_SingleListener", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  const server = new InvocationContextIpcServer(registry, token);

  // Act
  const [firstEndpoint, secondEndpoint] = await Promise.all([
    server.start(),
    server.start(),
  ]);

  // Assert
  assert.deepEqual(secondEndpoint, firstEndpoint);
  await server.stop();
});

test("InvocationContextIpcServer_DisconnectAndStop_Expect_CancelledHandlersAndIdempotentCleanup", async () => {
  // Arrange
  const registry = new InvocationContextRegistry();
  const aborted: string[] = [];
  const started: Array<() => void> = [];
  const waitForStart = (): Promise<void> =>
    new Promise((resolve) => started.push(resolve));
  registry.register(invocation);
  const server = new InvocationContextIpcServer(
    registry,
    token,
    async (_, request, signal) => {
      started.shift()?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(request.method);
            resolve();
          },
          { once: true },
        );
      });
      throw new Error("cancelled");
    },
  );
  const endpoint = await server.start();

  // Act
  const disconnectedStarted = waitForStart();
  const disconnectedSocket = await openFrameSocket(
    endpoint,
    samplingFrame({ requestID: "disconnect" }),
  );
  await disconnectedStarted;
  disconnectedSocket.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stoppedStarted = waitForStart();
  const stoppedSocket = await openFrameSocket(
    endpoint,
    samplingFrame({ requestID: "stop" }),
  );
  await stoppedStarted;
  await server.stop();
  await server.stop();
  stoppedSocket.destroy();

  // Assert
  assert.deepEqual(aborted, [
    "sampling/createMessage",
    "sampling/createMessage",
  ]);
});
