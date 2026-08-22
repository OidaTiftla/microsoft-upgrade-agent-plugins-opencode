import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import type { AssistantMessage, Part } from "@opencode-ai/sdk";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import { combineAbortSignals } from "./abort-signal.ts";
import { SAMPLING_AGENT_NAME } from "./sampling-agent.ts";

export type SamplingPolicy = "ask" | "allow" | "deny";
type Model = { providerID: string; modelID: string };
type SessionRequest = { path: { id: string }; query: { directory: string } };

export interface SamplingSdkClient {
  readonly session: {
    messages(input: SessionRequest): Promise<
      readonly {
        info: AssistantMessage | { role: string };
      }[]
    >;
    create(input: {
      body: { parentID: string; title: string };
      query: { directory: string };
    }): Promise<{ id: string }>;
    prompt(input: {
      path: { id: string };
      query: { directory: string };
      body: {
        agent: string;
        model?: { providerID: string; modelID: string };
        parts: { type: "text"; text: string }[];
        system: string;
        tools: Record<string, boolean>;
      };
    }): Promise<{ info: AssistantMessage; parts: readonly Part[] }>;
    abort(input: SessionRequest): Promise<unknown>;
    delete(input: SessionRequest): Promise<unknown>;
  };
}

export interface SamplingAdapterOptions {
  readonly client: SamplingSdkClient;
  readonly getSmallModel?: () => string | undefined;
  readonly mcpName: string;
  readonly policy?: SamplingPolicy;
}

function getResponseData<T>(response: { data?: T; error?: unknown }): T {
  if (response.data !== undefined) return response.data;
  throw new Error(`OpenCode SDK request failed: ${String(response.error)}`);
}

export function createOpenCodeSamplingSdkClient(
  client: PluginInput["client"],
): SamplingSdkClient {
  return {
    session: {
      messages: async (input) =>
        getResponseData(await client.session.messages(input)),
      create: async (input) =>
        getResponseData(await client.session.create(input)),
      prompt: async (input) =>
        getResponseData(await client.session.prompt(input)),
      abort: async (input) =>
        getResponseData(await client.session.abort(input)),
      delete: async (input) =>
        getResponseData(await client.session.delete(input)),
    },
  };
}

function getTextContent(
  content: CreateMessageRequest["params"]["messages"][number]["content"],
): string {
  if (Array.isArray(content)) return content.map(getTextContent).join("\n");
  if (content.type !== "text")
    throw new Error(`Unsupported MCP sampling content: ${content.type}.`);
  return content.text;
}

function getSamplingPrompt(request: CreateMessageRequest): string {
  return request.params.messages
    .map(({ role, content }) => `${role}:\n${getTextContent(content)}`)
    .join("\n\n");
}

function getStopSequences(request: CreateMessageRequest): readonly string[] {
  const stopSequences = request.params.stopSequences ?? [];
  if (stopSequences.some((sequence) => sequence === ""))
    throw new Error(
      "MCP sampling stop sequences must not contain empty strings.",
    );
  return stopSequences;
}

function getSamplingSystemInstruction(
  request: CreateMessageRequest,
  stopSequences: readonly string[],
): string {
  const instructions = [
    request.params.systemPrompt,
    `Return only the requested sampling response within ${request.params.maxTokens} tokens.`,
  ].filter((instruction): instruction is string => instruction !== undefined);
  if (stopSequences.length > 0)
    instructions.push(
      `Do not emit any of these stop sequences:\n${stopSequences.join("\n")}`,
    );
  return instructions.join("\n\n");
}

function getModel(value: string | undefined): Model | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  };
}

function getHintedModel(
  request: CreateMessageRequest,
  candidates: readonly Model[],
): Model | undefined {
  for (const { name } of request.params.modelPreferences?.hints ?? []) {
    if (name === undefined) continue;
    const exact = getModel(name);
    const candidate = candidates.find(({ providerID, modelID }) =>
      exact === undefined
        ? modelID === name
        : providerID === exact.providerID && modelID === exact.modelID,
    );
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function getRequestedModel(
  request: CreateMessageRequest,
  smallModel: Model | undefined,
  parentModel: Model | undefined,
): Model | undefined {
  const candidates = [smallModel, parentModel].filter(
    (model): model is Model => model !== undefined,
  );
  const hint = getHintedModel(request, candidates);
  if (hint !== undefined) return hint;
  const preferences = request.params.modelPreferences;
  const intelligence = preferences?.intelligencePriority ?? 0;
  const costOrSpeed = Math.max(
    preferences?.costPriority ?? 0,
    preferences?.speedPriority ?? 0,
  );
  return intelligence > costOrSpeed
    ? (parentModel ?? smallModel)
    : (smallModel ?? parentModel);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function getParentModel(
  messages: readonly { info: AssistantMessage | { role: string } }[],
): Model | undefined {
  const assistant = [...messages]
    .reverse()
    .find(
      (message): message is { info: AssistantMessage } =>
        "providerID" in message.info,
    );
  return assistant === undefined
    ? undefined
    : {
        providerID: assistant.info.providerID,
        modelID: assistant.info.modelID,
      };
}

function getResponseText(parts: readonly Part[]): string {
  const text = parts
    .filter(
      (part): part is Extract<Part, { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  if (text === "")
    throw new Error("OpenCode sampling response did not contain text.");
  return text;
}

function applyStopSequences(
  text: string,
  stopSequences: readonly string[],
): string {
  const index = Math.min(
    ...stopSequences
      .map((sequence) => text.indexOf(sequence))
      .filter((position) => position >= 0),
  );
  return Number.isFinite(index) ? text.slice(0, index) : text;
}

function throwIfAssistantError(message: AssistantMessage): void {
  if (message.error === undefined) return;
  const name = message.error.name;
  throw new Error(
    `OpenCode sampling assistant failed: ${typeof name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : "UnknownError"}.`,
  );
}

function throwIfOutputTokenLimitExceeded(
  message: AssistantMessage,
  maxTokens: number,
): void {
  const outputTokens = message.tokens?.output;
  if (
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  )
    throw new Error(
      "OpenCode sampling output token accounting is unavailable; cannot verify the MCP token limit.",
    );
  if (outputTokens > maxTokens)
    throw new Error(
      `OpenCode sampling output token accounting exceeds MCP limit (${outputTokens} > ${maxTokens}).`,
    );
}

function getModelName(model: Model | undefined): string {
  return model === undefined
    ? "parent-session default"
    : `${model.providerID}/${model.modelID}`;
}

export function getSamplingApprovalMetadata(
  request: CreateMessageRequest,
  mcpName: string,
  model: Model | undefined,
) {
  const prompt = getSamplingPrompt(request);
  return {
    contentScope:
      "MCP-provided text sent to the selected model; OpenAI uses instruction plus post-response token validation; preview is truncated.",
    maxTokens: request.params.maxTokens,
    model: getModelName(model),
    mcp: mcpName,
    preview: prompt.slice(0, 400),
    provider: model?.providerID ?? "parent-session provider",
    purpose: /skill/i.test(prompt)
      ? "skill ranking"
      : /plan/i.test(prompt)
        ? "plan parsing"
        : "MCP sampling",
  };
}

async function getCleanupError(
  abort: Promise<void> | undefined,
  remove: (() => Promise<unknown>) | undefined,
): Promise<unknown> {
  let error: unknown;
  try {
    await abort;
  } catch (value) {
    error = value;
  }
  try {
    await remove?.();
  } catch (value) {
    error ??= value;
  }
  return error;
}

export class OpenCodeSamplingAdapter {
  readonly #client: SamplingSdkClient;
  readonly #getSmallModel: (() => string | undefined) | undefined;
  readonly #mcpName: string;
  readonly #policy: SamplingPolicy;
  readonly #samplingParameters = new Map<
    string,
    { maxTokens: number; temperature: number | undefined }
  >();

  constructor(options: SamplingAdapterOptions) {
    this.#client = options.client;
    this.#getSmallModel = options.getSmallModel;
    this.#mcpName = options.mcpName;
    this.#policy = options.policy ?? "ask";
  }

  readonly applyChatParams: NonNullable<Hooks["chat.params"]> = async (
    input,
    output,
  ) => {
    if (input.agent !== SAMPLING_AGENT_NAME) return;
    const parameters = this.#samplingParameters.get(input.sessionID);
    if (parameters === undefined) return;
    if (input.model.providerID !== "openai")
      output.maxOutputTokens = Math.min(
        output.maxOutputTokens ?? parameters.maxTokens,
        parameters.maxTokens,
      );
    if (parameters.temperature !== undefined)
      output.temperature = parameters.temperature;
    if (
      input.model.providerID === "openai" &&
      input.model.capabilities.reasoning &&
      output.options.reasoningEffort === undefined
    )
      output.options.reasoningEffort = "low";
  };

  async sample(
    request: CreateMessageRequest,
    context: ToolContext,
    mcpAbort?: AbortSignal,
  ): Promise<CreateMessageResult> {
    if (this.#policy === "deny") throw new Error("MCP sampling is denied.");
    const cancellationSignals = [context.abort, mcpAbort].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const combinedAbort = combineAbortSignals(cancellationSignals);
    const prompt = getSamplingPrompt(request);
    const stopSequences = getStopSequences(request);
    let child: { id: string } | undefined;
    let cancellation: Promise<void> | undefined;
    let completed = false;
    const abort = () => {
      if (child !== undefined && cancellation === undefined) {
        cancellation = this.#client.session
          .abort({
            path: { id: child.id },
            query: { directory: context.directory },
          })
          .then(() => undefined);
      }
    };
    combinedAbort.signal.addEventListener("abort", abort, { once: true });
    try {
      throwIfAborted(combinedAbort.signal);
      const parentModel = getParentModel(
        await this.#client.session.messages({
          path: { id: context.sessionID },
          query: { directory: context.directory },
        }),
      );
      throwIfAborted(combinedAbort.signal);
      const model = getRequestedModel(
        request,
        getModel(this.#getSmallModel?.()),
        parentModel,
      );
      if (this.#policy === "ask") {
        const permissionPattern = `${this.#mcpName}:${context.sessionID}`;
        await context.ask({
          permission: "sampling",
          patterns: [permissionPattern],
          always: [permissionPattern],
          metadata: getSamplingApprovalMetadata(request, this.#mcpName, model),
        });
      }
      throwIfAborted(combinedAbort.signal);
      child = await this.#client.session.create({
        body: { parentID: context.sessionID, title: "Upgrade MCP sampling" },
        query: { directory: context.directory },
      });
      this.#samplingParameters.set(child.id, {
        maxTokens: request.params.maxTokens,
        temperature: request.params.temperature,
      });
      throwIfAborted(combinedAbort.signal);
      const response = await this.#client.session.prompt({
        path: { id: child.id },
        query: { directory: context.directory },
        body: {
          agent: SAMPLING_AGENT_NAME,
          ...(model === undefined ? {} : { model }),
          parts: [{ type: "text", text: prompt }],
          // OpenCode 1.18.21 exposes no generic stop-sequence hook; preserve this fallback instruction.
          system: getSamplingSystemInstruction(request, stopSequences),
          tools: {},
        },
      });
      throwIfAborted(combinedAbort.signal);
      throwIfAssistantError(response.info);
      throwIfOutputTokenLimitExceeded(response.info, request.params.maxTokens);
      const result: CreateMessageResult = {
        model: getModelName(
          model ?? {
            providerID: response.info.providerID,
            modelID: response.info.modelID,
          },
        ),
        role: "assistant",
        content: {
          type: "text",
          text: applyStopSequences(
            getResponseText(response.parts),
            stopSequences,
          ),
        },
      };
      completed = true;
      return result;
    } finally {
      combinedAbort.signal.removeEventListener("abort", abort);
      combinedAbort.dispose();
      const childID = child?.id;
      if (childID !== undefined) this.#samplingParameters.delete(childID);
      const cleanupError = await getCleanupError(
        cancellation,
        childID === undefined
          ? undefined
          : () =>
              this.#client.session.delete({
                path: { id: childID },
                query: { directory: context.directory },
              }),
      );
      if (completed && cleanupError !== undefined)
        throw new Error(
          `Failed to clean up Upgrade MCP sampling: ${String(cleanupError)}`,
        );
    }
  }
}
