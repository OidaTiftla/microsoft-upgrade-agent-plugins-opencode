import assert from "node:assert/strict";
import test from "node:test";

import {
  UpgradeInvocationRegistry,
  UpgradeMcpProxyServer,
  callUpgradeCoreTool,
  requestUpgradeInvocationContext,
  requestUpgradeMcpTools,
  type UpgradeInvocation,
} from "../src/upgrade-mcp-proxy-transport.ts";

function invocation(): UpgradeInvocation {
  return { callID: "call", sessionID: "session", tool: "Upgrade_get_state" };
}

test("UpgradeInvocationRegistry_ConcurrentSameTool_Expect_RejectsSecondAndPreservesFirst", () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const first = invocation();
  const second = { ...first, callID: "second", sessionID: "second" };
  registry.register(first);

  // Act
  let secondRegistrationError: unknown;
  try {
    registry.register(second);
  } catch (error) {
    secondRegistrationError = error;
  }
  const acquiredFirst = registry.acquire(first.tool);
  registry.release(acquiredFirst);

  // Assert
  assert.ok(secondRegistrationError instanceof Error);
  assert.match(secondRegistrationError.message, /request unavailable/);
  assert.deepEqual(acquiredFirst, first);
  assert.throws(() => registry.acquire(first.tool));
});

test("UpgradeMcpProxyServer_ValidRequests_Expect_ReturnsContextToolsAndCoreResult", async () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const currentInvocation = invocation();
  const calls: unknown[] = [];
  registry.register(currentInvocation);
  const server = new UpgradeMcpProxyServer({
    executeCoreTool: async (receivedInvocation, name, arguments_) => {
      calls.push({ arguments_, name, receivedInvocation });
      return { content: [{ text: "complete", type: "text" }] };
    },
    listToolDescriptors: async () => [
      { inputSchema: { type: "object" }, name: "get_state" },
    ],
    registry,
    token: "test-token",
  });
  const endpoint = await server.start();

  try {
    // Act
    const context = await requestUpgradeInvocationContext({
      endpoint,
      token: "test-token",
      tool: currentInvocation.tool,
    });
    const tools = await requestUpgradeMcpTools({
      endpoint,
      token: "test-token",
    });
    const result = await callUpgradeCoreTool({
      arguments_: { path: "/repo" },
      endpoint,
      invocation: context,
      name: "get_state",
      token: "test-token",
    });

    // Assert
    assert.deepEqual(tools, [
      { inputSchema: { type: "object" }, name: "get_state" },
    ]);
    assert.deepEqual(result, { content: [{ text: "complete", type: "text" }] });
    assert.deepEqual(calls, [
      {
        arguments_: { path: "/repo" },
        name: "get_state",
        receivedInvocation: currentInvocation,
      },
    ]);
    assert.throws(() => registry.acquire(currentInvocation.tool));
  } finally {
    await server.stop();
  }
});

test("UpgradeMcpProxyServer_UnauthorizedOrMismatchedCall_Expect_FailsClosed", async () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const currentInvocation = invocation();
  let calls = 0;
  registry.register(currentInvocation);
  const server = new UpgradeMcpProxyServer({
    executeCoreTool: async () => {
      calls += 1;
      return {};
    },
    listToolDescriptors: async () => [],
    registry,
    token: "test-token",
  });
  const endpoint = await server.start();

  try {
    // Act
    const unauthorized = requestUpgradeInvocationContext({
      endpoint,
      token: "wrong-token",
      tool: currentInvocation.tool,
    });
    const mismatched = callUpgradeCoreTool({
      arguments_: {},
      endpoint,
      invocation: { ...currentInvocation, callID: "other" },
      name: "get_state",
      token: "test-token",
    });

    // Assert
    await assert.rejects(unauthorized, /request failed/);
    await assert.rejects(mismatched, /request failed/);
    assert.equal(calls, 0);
    assert.deepEqual(
      registry.acquire(currentInvocation.tool),
      currentInvocation,
    );
  } finally {
    await server.stop();
  }
});

test("UpgradeMcpProxyServer_SubstitutedToolName_Expect_FailsClosedAndReleasesInvocation", async () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const currentInvocation = invocation();
  const calls: string[] = [];
  registry.register(currentInvocation);
  const server = new UpgradeMcpProxyServer({
    executeCoreTool: async (_invocation, name) => {
      calls.push(name);
      return {};
    },
    listToolDescriptors: async () => [],
    registry,
    token: "test-token",
  });
  const endpoint = await server.start();
  const acquired = registry.acquire(currentInvocation.tool);

  try {
    // Act
    const substituted = callUpgradeCoreTool({
      arguments_: {},
      endpoint,
      invocation: currentInvocation,
      name: "delete_state",
      token: "test-token",
    });

    // Assert
    await assert.rejects(substituted, /request failed/);
    assert.deepEqual(acquired, currentInvocation);
    assert.throws(() => registry.acquire(currentInvocation.tool));
    registry.register(currentInvocation);
    assert.deepEqual(
      registry.acquire(currentInvocation.tool),
      currentInvocation,
    );
    assert.deepEqual(calls, []);
  } finally {
    registry.release(currentInvocation);
    await server.stop();
  }
});

test("callUpgradeCoreTool_CallerCancellation_Expect_AbortsHandlerAndReleasesInvocation", async () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const currentInvocation = invocation();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerAborted = Promise.withResolvers<void>();
  registry.register(currentInvocation);
  const server = new UpgradeMcpProxyServer({
    executeCoreTool: async (_invocation, _name, _arguments, signal) => {
      handlerStarted.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      handlerAborted.resolve();
      return {};
    },
    listToolDescriptors: async () => [],
    registry,
    token: "test-token",
  });
  const endpoint = await server.start();
  const controller = new AbortController();

  try {
    // Act
    const call = callUpgradeCoreTool({
      arguments_: {},
      endpoint,
      invocation: currentInvocation,
      name: "get_state",
      signal: controller.signal,
      token: "test-token",
    });
    await handlerStarted.promise;
    controller.abort();

    // Assert
    await assert.rejects(call, /cancelled/);
    await handlerAborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(() => registry.acquire(currentInvocation.tool));
  } finally {
    await server.stop();
  }
});

test("UpgradeMcpProxyServer_StopDuringCall_Expect_AbortsHandler", async () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const currentInvocation = invocation();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerAborted = Promise.withResolvers<void>();
  registry.register(currentInvocation);
  const server = new UpgradeMcpProxyServer({
    executeCoreTool: async (_invocation, _name, _arguments, signal) => {
      handlerStarted.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      handlerAborted.resolve();
      return {};
    },
    listToolDescriptors: async () => [],
    registry,
    token: "test-token",
  });
  const endpoint = await server.start();
  const call = callUpgradeCoreTool({
    arguments_: {},
    endpoint,
    invocation: currentInvocation,
    name: "get_state",
    token: "test-token",
  });
  await handlerStarted.promise;

  try {
    // Act
    await server.stop();

    // Assert
    await handlerAborted.promise;
    await assert.rejects(call, /request failed/);
    assert.throws(() => registry.acquire(currentInvocation.tool));
  } finally {
    await server.stop();
  }
});

test("UpgradeMcpProxyServer_StartStopLifecycle_Expect_ReusesPort", async () => {
  // Arrange
  const server = new UpgradeMcpProxyServer({
    executeCoreTool: async () => ({}),
    listToolDescriptors: async () => [],
    registry: new UpgradeInvocationRegistry(),
    token: "test-token",
  });

  // Act
  const [first, concurrent] = await Promise.all([
    server.start(),
    server.start(),
  ]);
  await Promise.all([server.stop(), server.stop()]);
  const restarted = await server.start();

  // Assert
  assert.deepEqual(concurrent, first);
  assert.equal(restarted.host, "127.0.0.1");
  assert.equal(restarted.port, first.port);
  await server.stop();
});
