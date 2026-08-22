import assert from "node:assert/strict";
import test from "node:test";

import type { ToolContext } from "@opencode-ai/plugin";
import type { AssistantMessage, Part } from "@opencode-ai/sdk";
import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  OpenCodeSamplingAdapter,
  type SamplingSdkClient,
} from "../src/opencode-sampling-adapter.ts";
import { SAMPLING_AGENT_NAME } from "../src/sampling-agent.ts";

const assistant: AssistantMessage = {
  id: "assistant",
  sessionID: "parent",
  role: "assistant",
  parentID: "user",
  modelID: "parent-model",
  providerID: "parent-provider",
  mode: "build",
  path: { cwd: "/workspace", root: "/workspace" },
  time: { created: 0 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};

function request(text = "Parse this plan."): CreateMessageRequest {
  return {
    method: "sampling/createMessage",
    params: {
      maxTokens: 42,
      messages: [{ role: "user", content: { type: "text", text } }],
      modelPreferences: { hints: [{ name: "gpt-5.4-mini" }] },
    },
  } as CreateMessageRequest;
}

function context(controller = new AbortController()): {
  context: ToolContext;
  asks: unknown[];
} {
  const asks: unknown[] = [];
  return {
    context: {
      sessionID: "parent",
      directory: "/workspace",
      abort: controller.signal,
      ask: async (input) => {
        asks.push(input);
      },
    } as ToolContext,
    asks,
  };
}

function client(): {
  client: SamplingSdkClient;
  calls: {
    abort: string[];
    create: unknown[];
    delete: string[];
    prompt: unknown[];
  };
} {
  const calls = {
    abort: [] as string[],
    create: [] as unknown[],
    delete: [] as string[],
    prompt: [] as unknown[],
  };
  return {
    client: {
      session: {
        messages: async () => [{ info: assistant, parts: [] }],
        create: async (input) => {
          calls.create.push(input);
          return { id: "child" };
        },
        prompt: async (input) => {
          calls.prompt.push(input);
          return {
            info: assistant,
            parts: [{ type: "text", text: "response" }] as Part[],
          };
        },
        abort: async ({ path }) => {
          calls.abort.push(path.id);
          return true;
        },
        delete: async ({ path }) => {
          calls.delete.push(path.id);
          return true;
        },
      },
    },
    calls,
  };
}

test("OpenCodeSamplingAdapter_AskPolicy_Expect_ApprovalAndCleanup", async () => {
  // Arrange
  const sdk = client();
  const input = context();
  const second = context();
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    getSmallModel: () => "small-provider/small-model",
    mcpName: "Upgrade",
  });

  // Act
  const response = await adapter.sample(request(), input.context);
  await adapter.sample(request(), {
    ...second.context,
    sessionID: "second-session",
  } as ToolContext);
  const allowed = client();
  await new OpenCodeSamplingAdapter({
    client: allowed.client,
    mcpName: "Upgrade",
    policy: "allow",
  }).sample(request(), context().context);
  const denied = new OpenCodeSamplingAdapter({
    client: client().client,
    mcpName: "Upgrade",
    policy: "deny",
  });

  // Assert
  assert.equal(input.asks.length, 1);
  assert.deepEqual(input.asks[0], {
    permission: "sampling",
    patterns: ["Upgrade:parent"],
    always: ["Upgrade:parent"],
    metadata: {
      contentScope:
        "MCP-provided text sent to the selected model; OpenAI uses instruction plus post-response token validation; preview is truncated.",
      maxTokens: 42,
      model: "small-provider/small-model",
      mcp: "Upgrade",
      preview: "user:\nParse this plan.",
      provider: "small-provider",
      purpose: "plan parsing",
    },
  });
  assert.deepEqual(sdk.calls.delete, ["child", "child"]);
  assert.deepEqual((second.asks[0] as { always: string[] }).always, [
    "Upgrade:second-session",
  ]);
  assert.equal(allowed.calls.create.length, 1);
  await assert.rejects(
    () => denied.sample(request(), context().context),
    /sampling is denied/,
  );
  assert.equal(response.model, "small-provider/small-model");
  assert.equal(response.content.type, "text");
});

test("OpenCodeSamplingAdapter_StopSequences_Expect_EarliestSequenceTruncatesResponse", async () => {
  // Arrange
  const sdk = client();
  const input = context();
  let prompt: unknown;
  sdk.client.session.prompt = async (value) => {
    prompt = value;
    return {
      info: assistant,
      parts: [
        {
          id: "text",
          messageID: assistant.id,
          sessionID: "parent",
          text: "before END after STOP ignored",
          type: "text",
        },
      ],
    };
  };
  const samplingRequest = request() as CreateMessageRequest & {
    params: { stopSequences: string[] };
  };
  samplingRequest.params.stopSequences = ["STOP", "END"];
  samplingRequest.params.systemPrompt = "Respond with JSON.";
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    mcpName: "Upgrade",
    policy: "allow",
  });

  // Act
  const response = await adapter.sample(samplingRequest, input.context);

  // Assert
  assert.deepEqual(response.content, { type: "text", text: "before " });
  assert.equal(
    (prompt as { body: { system: string } }).body.system,
    "Respond with JSON.\n\nReturn only the requested sampling response within 42 tokens.\n\nDo not emit any of these stop sequences:\nSTOP\nEND",
  );
});

test("OpenCodeSamplingAdapter_ModelPreferences_Expect_ExactHintAndIntelligenceSelection", async () => {
  // Arrange
  const sdk = client();
  const input = context();
  let smallModel: string | undefined;
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    getSmallModel: () => smallModel,
    mcpName: "Upgrade",
    policy: "allow",
  });
  const exactHint = request() as CreateMessageRequest & {
    params: { modelPreferences: { hints: { name: string }[] } };
  };
  exactHint.params.modelPreferences = {
    hints: [{ name: "parent-provider/parent-model" }],
  };

  // Act
  await adapter.sample(request(), input.context);
  smallModel = "small-provider/small-model";
  await adapter.sample(exactHint as CreateMessageRequest, input.context);
  smallModel = "new-small-provider/new-small-model";
  await adapter.sample(request(), input.context);
  const intelligence = request() as CreateMessageRequest & {
    params: { modelPreferences: { intelligencePriority: number } };
  };
  intelligence.params.modelPreferences = { intelligencePriority: 1 };
  await adapter.sample(intelligence as CreateMessageRequest, input.context);

  // Assert
  assert.deepEqual(
    (sdk.calls.prompt[0] as { body: { model: unknown } }).body.model,
    {
      providerID: "parent-provider",
      modelID: "parent-model",
    },
  );
  assert.deepEqual(
    (sdk.calls.prompt[1] as { body: { model: unknown } }).body.model,
    {
      providerID: "parent-provider",
      modelID: "parent-model",
    },
  );
  assert.deepEqual(
    (sdk.calls.prompt[2] as { body: { model: unknown } }).body.model,
    {
      providerID: "new-small-provider",
      modelID: "new-small-model",
    },
  );
  assert.deepEqual(
    (sdk.calls.prompt[3] as { body: { model: unknown } }).body.model,
    {
      providerID: "parent-provider",
      modelID: "parent-model",
    },
  );
});

test("OpenCodeSamplingAdapter_CancelledContext_Expect_AbortsAndDeletesChild", async () => {
  // Arrange
  const sdk = client();
  const controller = new AbortController();
  const mcpAbort = new AbortController();
  const input = context(controller);
  let resolvePrompt: (() => void) | undefined;
  sdk.client.session.prompt = async () => {
    await new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    return {
      info: assistant,
      parts: [{ type: "text", text: "response" }] as Part[],
    };
  };
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    mcpName: "Upgrade",
    policy: "allow",
  });

  // Act
  const action = adapter.sample(request(), input.context, mcpAbort.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("Cancelled"));
  resolvePrompt!();

  // Assert
  await assert.rejects(action, /Cancelled/);
  assert.deepEqual(sdk.calls.abort, ["child"]);
  assert.deepEqual(sdk.calls.delete, ["child"]);
});

test("OpenCodeSamplingAdapter_ActiveSampler_Expect_AppliesAndClearsChatParameters", async () => {
  // Arrange
  const sdk = client();
  const controller = new AbortController();
  const input = context(controller);
  let resolvePrompt: (() => void) | undefined;
  sdk.client.session.prompt = async () => {
    await new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    return {
      info: assistant,
      parts: [{ text: "response", type: "text" }] as Part[],
    };
  };
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    mcpName: "Upgrade",
    policy: "allow",
  });
  const inputRequest = request() as CreateMessageRequest & {
    params: { temperature: number };
  };
  inputRequest.params.temperature = 0.25;

  // Act
  const action = adapter.sample(
    inputRequest as CreateMessageRequest,
    input.context,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const active = { maxOutputTokens: 100, options: {}, temperature: 0 };
  await adapter.applyChatParams(
    {
      agent: SAMPLING_AGENT_NAME,
      model: { capabilities: { reasoning: true }, providerID: "openai" },
      sessionID: "child",
    } as never,
    active as never,
  );
  const explicit = {
    maxOutputTokens: 100,
    options: { reasoningEffort: "high" },
    temperature: 0,
  };
  await adapter.applyChatParams(
    {
      agent: SAMPLING_AGENT_NAME,
      model: { capabilities: { reasoning: true }, providerID: "openai" },
      sessionID: "child",
    } as never,
    explicit as never,
  );
  const nonOpenAi = { maxOutputTokens: 100, options: {}, temperature: 0 };
  await adapter.applyChatParams(
    {
      agent: SAMPLING_AGENT_NAME,
      model: { capabilities: { reasoning: true }, providerID: "anthropic" },
      sessionID: "child",
    } as never,
    nonOpenAi as never,
  );
  const ordinary = { maxOutputTokens: 100, options: {}, temperature: 0 };
  await adapter.applyChatParams(
    { agent: "Upgrade", sessionID: "child" } as never,
    ordinary as never,
  );
  controller.abort(new Error("Cancelled"));
  resolvePrompt!();
  await assert.rejects(action, /Cancelled/);
  const inactive = { maxOutputTokens: 100, options: {}, temperature: 0 };
  await adapter.applyChatParams(
    { agent: SAMPLING_AGENT_NAME, sessionID: "child" } as never,
    inactive as never,
  );

  // Assert
  assert.deepEqual(active, {
    maxOutputTokens: 100,
    options: { reasoningEffort: "low" },
    temperature: 0.25,
  });
  assert.deepEqual(explicit, {
    maxOutputTokens: 100,
    options: { reasoningEffort: "high" },
    temperature: 0.25,
  });
  assert.deepEqual(nonOpenAi, {
    maxOutputTokens: 42,
    options: {},
    temperature: 0.25,
  });
  assert.deepEqual(ordinary, {
    maxOutputTokens: 100,
    options: {},
    temperature: 0,
  });
  assert.deepEqual(inactive, {
    maxOutputTokens: 100,
    options: {},
    temperature: 0,
  });
});

test("OpenCodeSamplingAdapter_AssistantError_Expect_SanitizedStableName", async () => {
  // Arrange
  const sdk = client();
  const input = context();
  sdk.client.session.prompt = async () => ({
    info: {
      ...assistant,
      error: {
        data: {
          isRetryable: false,
          message: "secret response body must not be exposed",
          responseBody: "secret",
          responseHeaders: { authorization: "secret" },
        },
        name: "APIError",
      },
    } as AssistantMessage,
    parts: [],
  });
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    mcpName: "Upgrade",
    policy: "allow",
  });

  // Act
  const action = () => adapter.sample(request(), input.context);

  // Assert
  await assert.rejects(
    action,
    (error) =>
      error instanceof Error &&
      error.message === "OpenCode sampling assistant failed: APIError.",
  );
  assert.deepEqual(sdk.calls.delete, ["child"]);
});

test("OpenCodeSamplingAdapter_OutputTokenAccounting_Expect_Enforced", async () => {
  for (const [outputTokens, expectedError] of [
    [42, undefined],
    [43, "exceeds MCP limit"],
    [Number.NaN, "token accounting is unavailable"],
    [-1, "token accounting is unavailable"],
  ] as const) {
    await test(String(outputTokens), async () => {
      // Arrange
      const sdk = client();
      const input = context();
      sdk.client.session.prompt = async () => ({
        info: {
          ...assistant,
          tokens: { ...assistant.tokens, output: outputTokens },
        },
        parts: [{ text: "response", type: "text" }] as Part[],
      });
      const adapter = new OpenCodeSamplingAdapter({
        client: sdk.client,
        mcpName: "Upgrade",
        policy: "allow",
      });

      // Act
      const action = () => adapter.sample(request(), input.context);

      // Assert
      if (expectedError === undefined) await action();
      else await assert.rejects(action, new RegExp(expectedError));
      assert.deepEqual(sdk.calls.delete, ["child"]);
    });
  }
});

test("OpenCodeSamplingAdapter_DeleteFailure_Expect_ActionableCleanupError", async () => {
  // Arrange
  const sdk = client();
  const input = context();
  sdk.client.session.delete = async () => {
    throw new Error("Delete cleanup failed");
  };
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    mcpName: "Upgrade",
    policy: "allow",
  });

  // Act
  const action = () => adapter.sample(request(), input.context);

  // Assert
  await assert.rejects(
    action,
    /Failed to clean up Upgrade MCP sampling: Error: Delete cleanup failed/,
  );
});

test("OpenCodeSamplingAdapter_UnsupportedContent_Expect_RejectsBeforeSession", async () => {
  // Arrange
  const sdk = client();
  const input = context();
  const adapter = new OpenCodeSamplingAdapter({
    client: sdk.client,
    mcpName: "Upgrade",
    policy: "allow",
  });
  const unsupported = request() as CreateMessageRequest & {
    params: { messages: unknown[] };
  };
  unsupported.params.messages = [
    {
      role: "user",
      content: { type: "image", data: "x", mimeType: "image/png" },
    },
  ];

  // Act
  const action = () =>
    adapter.sample(unsupported as CreateMessageRequest, input.context);

  // Assert
  await assert.rejects(action, /Unsupported MCP sampling content/);
  assert.equal(sdk.calls.create.length, 0);
});
