import assert from "node:assert/strict";
import test from "node:test";

import { tool, type ToolContext } from "@opencode-ai/plugin";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  CoreToolExecutionCoordinator,
  createOpenCodeMcpToolDefinitions,
  createToolDefinitionHook,
  getOpenCodeToolResult,
  waitForStableMcpTools,
  type CoreMcpToolClient,
  type SamplingAdapter,
} from "../src/opencode-mcp-tool-bridge.ts";

function context(sessionID: string): ToolContext {
  return {
    abort: new AbortController().signal,
    agent: "test",
    ask: async () => undefined,
    directory: "/workspace",
    messageID: "message",
    metadata: () => undefined,
    sessionID,
    worktree: "/workspace",
  };
}

function samplingRequest(): CreateMessageRequest {
  return {
    method: "sampling/createMessage",
    params: { maxTokens: 10, messages: [] },
  } as CreateMessageRequest;
}

function sampling(): SamplingAdapter {
  return {
    sample: async (): Promise<CreateMessageResult> => ({
      content: { text: "response", type: "text" },
      model: "test",
      role: "assistant",
    }),
  };
}

test("getOpenCodeToolResult_ErrorResult_Expect_PreservesErrorStatus", () => {
  // Arrange
  const result = {
    content: [{ text: "Core failed", type: "text" }],
    isError: true,
  };

  // Act
  const action = () => getOpenCodeToolResult("Upgrade_get_state", result);

  // Assert
  assert.throws(action, /Upgrade_get_state failed: Core failed/);
});

test("createToolDefinitionHook_FutureSchema_Expect_PreservesOriginalSchema", async () => {
  // Arrange
  const inputSchema = {
    properties: {
      path: { "x-future-property": ["value"], type: "string" },
    },
    required: ["path"],
    type: "object",
  };
  const output = { description: "Generated", parameters: {} } as {
    description: string;
    jsonSchema?: unknown;
    parameters: unknown;
  };

  // Act
  await createToolDefinitionHook({ Upgrade_get_state: inputSchema })(
    { toolID: "Upgrade_get_state" },
    output,
  );

  // Assert
  assert.equal(output.jsonSchema, inputSchema);
});

test("createOpenCodeMcpToolDefinitions_TopLevelArguments_Expect_RequiredAndOptional", async () => {
  // Arrange
  const calls: unknown[] = [];
  const definitions = createOpenCodeMcpToolDefinitions(
    "Upgrade",
    [
      {
        inputSchema: {
          additionalProperties: true,
          properties: { optional: {}, required: {} },
          required: ["required"],
          type: "object",
        },
        name: "get_state",
      },
    ],
    new CoreToolExecutionCoordinator(
      {
        callTool: async (name, arguments_) => {
          calls.push({ arguments_, name });
          return { content: [] };
        },
        listTools: async () => ({ tools: [] }),
      },
      sampling(),
    ),
  );
  const schema = tool.schema.object(definitions.Upgrade_get_state.args);

  // Act
  const missing = schema.safeParse({});
  const undefinedRequired = schema.safeParse({ required: undefined });
  const valid = schema.safeParse({ required: { nested: "unchanged" } });
  const undefinedOptional = schema.safeParse({
    optional: undefined,
    required: "value",
  });
  await definitions.Upgrade_get_state.execute(
    { future: { property: "preserved" }, required: "value" },
    context("one"),
  );

  // Assert
  assert.equal(missing.success, false);
  assert.equal(undefinedRequired.success, false);
  assert.equal(valid.success, true);
  assert.equal(undefinedOptional.success, true);
  assert.deepEqual(calls, [
    {
      arguments_: { future: { property: "preserved" }, required: "value" },
      name: "get_state",
    },
  ]);
});

test("waitForStableMcpTools_QuietPeriod_Expect_UsesNotificationsAndPolling", async () => {
  // Arrange
  let now = 0;
  let changed: (() => void) | undefined;
  let calls = 0;
  const client: CoreMcpToolClient = {
    callTool: async () => ({ content: [] }),
    listTools: async () => {
      calls += 1;
      if (calls === 2) changed!();
      return {
        tools: [{ inputSchema: { type: "object" }, name: "get_state" }],
      };
    },
    subscribeToToolListChanges: (listener) => {
      changed = listener;
      return () => undefined;
    },
  };

  // Act
  const tools = await waitForStableMcpTools(client, {
    now: () => now,
    poll_ms: 1,
    quiet_ms: 2,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    timeout_ms: 10,
  });

  // Assert
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["get_state"],
  );
  assert.equal(calls, 4);
});

test("waitForStableMcpTools_AbortedWait_Expect_StopsImmediately", async () => {
  // Arrange
  const controller = new AbortController();
  const client: CoreMcpToolClient = {
    callTool: async () => ({ content: [] }),
    listTools: async () => ({
      tools: [{ inputSchema: { type: "object" }, name: "get_state" }],
    }),
  };
  const action = waitForStableMcpTools(
    client,
    {
      now: () => 0,
      poll_ms: 1_000,
      quiet_ms: 1,
      sleep: async () => new Promise(() => undefined),
      timeout_ms: 300_000,
    },
    controller.signal,
  );

  // Act
  controller.abort(new Error("Disposed"));

  // Assert
  await assert.rejects(action, /Disposed/);
});

test("CoreToolExecutionCoordinator_Progress_Expect_ReportsToolContextMetadata", async () => {
  // Arrange
  const metadata: unknown[] = [];
  const client: CoreMcpToolClient = {
    callTool: async (_name, _arguments, options) => {
      options?.onProgress?.({ message: "Scanning", progress: 2, total: 3 });
      return { content: [] };
    },
    listTools: async () => ({ tools: [] }),
  };
  const coordinator = new CoreToolExecutionCoordinator(client, sampling());
  const toolContext = {
    ...context("session"),
    metadata: (value: unknown) => metadata.push(value),
  } as ToolContext;

  // Act
  await coordinator.execute("get_state", {}, toolContext);

  // Assert
  assert.deepEqual(metadata, [
    {
      metadata: { message: "Scanning", progress: 2, total: 3 },
      title: "get_state: Scanning",
    },
  ]);
});

test("CoreToolExecutionCoordinator_ActiveCalls_Expect_SerialContextAssociation", async () => {
  // Arrange
  const gates: (() => void)[] = [];
  const calls: string[] = [];
  const contexts: ToolContext[] = [];
  const client: CoreMcpToolClient = {
    callTool: async (name) => {
      calls.push(name);
      await new Promise<void>((resolve) => gates.push(resolve));
      return { content: [] };
    },
    listTools: async () => ({ tools: [] }),
  };
  const coordinator = new CoreToolExecutionCoordinator(client, {
    sample: async (_request, toolContext) => {
      contexts.push(toolContext);
      return {
        content: { text: "response", type: "text" },
        model: "test",
        role: "assistant",
      };
    },
  });
  const firstContext = context("first");
  const secondContext = context("second");

  // Act
  const first = coordinator.execute("first", {}, firstContext);
  const second = coordinator.execute("second", {}, secondContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coordinator.sample(samplingRequest(), new AbortController().signal);
  gates.shift()!();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coordinator.sample(samplingRequest(), new AbortController().signal);
  gates.shift()!();
  await second;

  // Assert
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(
    contexts.map(({ sessionID }) => sessionID),
    ["first", "second"],
  );
  await assert.rejects(
    () => coordinator.sample(samplingRequest(), new AbortController().signal),
    /not associated/,
  );
});

test("CoreToolExecutionCoordinator_SamplingCancellation_Expect_CombinedSignal", async () => {
  // Arrange
  const mcpAbort = new AbortController();
  let samplingSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const client: CoreMcpToolClient = {
    callTool: async () =>
      new Promise((resolve) => {
        release = () => resolve({ content: [] });
      }),
    listTools: async () => ({ tools: [] }),
  };
  const coordinator = new CoreToolExecutionCoordinator(client, {
    sample: async (_request, toolContext) => {
      samplingSignal = toolContext.abort;
      await new Promise<void>((resolve) =>
        toolContext.abort.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return {
        content: { text: "response", type: "text" },
        model: "test",
        role: "assistant",
      };
    },
  });
  const call = coordinator.execute("get_state", {}, context("session"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Act
  const sample = coordinator.sample(samplingRequest(), mcpAbort.signal);
  mcpAbort.abort(new Error("MCP cancelled"));
  await sample;
  release!();
  await call;

  // Assert
  assert.equal(samplingSignal?.aborted, true);
  assert.equal(samplingSignal?.reason.message, "MCP cancelled");
});
