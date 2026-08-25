import {
  tool,
  type Hooks,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpTool {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly name: string;
}

export interface CoreMcpToolClient {
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    options?: CoreMcpToolRequestOptions,
  ): Promise<unknown>;
  listTools(
    signal?: AbortSignal,
  ): Promise<{ readonly tools: readonly McpTool[] }>;
  subscribeToToolListChanges?(listener: () => void): () => void;
}

export interface CoreMcpToolRequestOptions {
  readonly onProgress?: (progress: {
    readonly message?: string;
    readonly progress: number;
    readonly total?: number;
  }) => void;
  readonly signal?: AbortSignal;
}

export interface SamplingAdapter {
  sample(
    request: CreateMessageRequest,
    context: ToolContext,
  ): Promise<CreateMessageResult>;
}

export interface McpToolBridge {
  readonly coordinator: CoreToolExecutionCoordinator;
  readonly toolDefinition: NonNullable<Hooks["tool.definition"]>;
  readonly tools: Record<string, ToolDefinition>;
}

function getContentText(content: unknown): string {
  if (
    content !== null &&
    typeof content === "object" &&
    "type" in content &&
    content.type === "text" &&
    "text" in content &&
    typeof content.text === "string"
  )
    return content.text;
  return JSON.stringify(content) ?? String(content);
}

function getResultContent(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content) && content.length > 0)
    return content.map(getContentText).join("\n");
  if (content !== undefined && !Array.isArray(content))
    return getContentText(content);
  if (result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}

export function getOpenCodeToolResult(
  toolName: string,
  value: unknown,
): { output: string; title: string } {
  const result =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : { content: value };
  const isError = result.isError === true;
  const output = getResultContent(result);
  if (isError) throw new Error(`${toolName} failed: ${output}`);
  return {
    output,
    title: toolName,
  };
}

export class CoreToolExecutionCoordinator {
  readonly #client: CoreMcpToolClient;
  readonly #sampling: SamplingAdapter;
  #activeContext: ToolContext | undefined;
  #disposed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(client: CoreMcpToolClient, sampling: SamplingAdapter) {
    this.#client = client;
    this.#sampling = sampling;
  }

  async execute(
    name: string,
    arguments_: Record<string, unknown>,
    context: ToolContext,
  ): Promise<unknown> {
    if (this.#disposed) throw new Error("Upgrade MCP bridge is disposed.");
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await waitForQueue(previous, context.abort);
    } catch (error) {
      void previous.catch(() => undefined).then(() => release!());
      throw error;
    }
    if (this.#disposed) {
      release!();
      throw new Error("Upgrade MCP bridge is disposed.");
    }
    this.#activeContext = context;
    try {
      return await this.#client.callTool(name, arguments_, {
        onProgress: (progress) =>
          context.metadata({
            title: `${name}: ${progress.message ?? "in progress"}`,
            metadata: { ...progress },
          }),
        signal: context.abort,
      });
    } finally {
      this.#activeContext = undefined;
      release!();
    }
  }

  dispose(): void {
    this.#disposed = true;
  }

  async sample(
    request: CreateMessageRequest,
    signal: AbortSignal,
  ): Promise<CreateMessageResult> {
    if (this.#disposed) throw new Error("Upgrade MCP bridge is disposed.");
    const context = this.#activeContext;
    if (context === undefined)
      throw new Error(
        "MCP sampling request is not associated with an active tool call.",
      );
    return this.#sampling.sample(request, {
      ...context,
      abort: AbortSignal.any([context.abort, signal]),
    });
  }
}

function waitForQueue(
  operation: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation
      .catch(() => undefined)
      .then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
  });
}

function getOpenCodeToolName(mcpName: string, toolName: string): string {
  return `${mcpName}_${toolName}`;
}

function getJsonObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function getTopLevelToolArguments(
  inputSchema: unknown,
): NonNullable<Parameters<typeof tool.schema.object>[0]> {
  const schema = getJsonObject(inputSchema, "MCP tool inputSchema");
  if (schema.type !== "object")
    throw new Error("MCP tool inputSchema.type must be object.");
  const properties =
    schema.properties === undefined
      ? {}
      : getJsonObject(schema.properties, "MCP tool inputSchema.properties");
  const required = schema.required === undefined ? [] : schema.required;
  if (
    !Array.isArray(required) ||
    required.some((name) => typeof name !== "string")
  )
    throw new Error(
      "MCP tool inputSchema.required must be an array of strings.",
    );
  const requiredNames = new Set(required as string[]);
  return Object.fromEntries(
    Object.keys(properties).map((name) => [
      name,
      requiredNames.has(name)
        ? tool.schema
            .unknown()
            .refine((value) => value !== undefined, `${name} is required.`)
        : tool.schema.unknown().optional(),
    ]),
  ) as NonNullable<Parameters<typeof tool.schema.object>[0]>;
}

export function createToolDefinitionHook(
  schemas: Readonly<Record<string, unknown>>,
): NonNullable<Hooks["tool.definition"]> {
  return async ({ toolID }, output) => {
    if (Object.hasOwn(schemas, toolID))
      (output as { jsonSchema?: unknown }).jsonSchema = schemas[toolID];
  };
}

export function createOpenCodeMcpToolDefinitions(
  mcpName: string,
  mcpTools: readonly McpTool[],
  coordinator: CoreToolExecutionCoordinator,
): Record<string, ToolDefinition> {
  const names = mcpTools.map(({ name }) => getOpenCodeToolName(mcpName, name));
  if (new Set(names).size !== names.length)
    throw new Error(`MCP tool names conflict for ${mcpName}.`);
  const definitions = Object.fromEntries(
    mcpTools.map((mcpTool) => {
      const name = getOpenCodeToolName(mcpName, mcpTool.name);
      const args = getTopLevelToolArguments(mcpTool.inputSchema);
      return [
        name,
        tool({
          args,
          description: mcpTool.description ?? mcpTool.name,
          execute: async (arguments_, context) => {
            await context.ask({
              permission: name,
              patterns: ["*"],
              always: ["*"],
              metadata: {},
            });
            return getOpenCodeToolResult(
              name,
              await coordinator.execute(
                mcpTool.name,
                arguments_ as Record<string, unknown>,
                context,
              ),
            );
          },
        }),
      ];
    }),
  );
  return definitions;
}

export async function primeRepositoryTraits(
  client: CoreMcpToolClient,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.callTool("get_state", { path }, { signal });
}

export async function createOpenCodeMcpToolBridge(
  client: CoreMcpToolClient,
  mcpName: string,
  sampling: SamplingAdapter,
  coordinator = new CoreToolExecutionCoordinator(client, sampling),
  signal?: AbortSignal,
): Promise<McpToolBridge> {
  const mcpTools = await waitForStableMcpTools(client, undefined, signal);
  return {
    coordinator,
    toolDefinition: createToolDefinitionHook(
      Object.fromEntries(
        mcpTools.map((mcpTool) => [
          getOpenCodeToolName(mcpName, mcpTool.name),
          mcpTool.inputSchema,
        ]),
      ),
    ),
    tools: createOpenCodeMcpToolDefinitions(mcpName, mcpTools, coordinator),
  };
}

export interface ToolReadinessOptions {
  readonly now: () => number;
  readonly poll_ms: number;
  readonly quiet_ms: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly timeout_ms: number;
}

const DEFAULT_TOOL_READINESS_OPTIONS: ToolReadinessOptions = {
  now: Date.now,
  poll_ms: 1_000,
  quiet_ms: 2_000,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeout_ms: 300_000,
};

function waitForAbort(
  operation: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function waitForStableMcpTools(
  client: CoreMcpToolClient,
  options: ToolReadinessOptions = DEFAULT_TOOL_READINESS_OPTIONS,
  signal?: AbortSignal,
): Promise<readonly McpTool[]> {
  const started = options.now();
  let latest: readonly McpTool[] = [];
  let listed = false;
  let changedAt = started;
  let notified = false;
  const unsubscribe = client.subscribeToToolListChanges?.(() => {
    notified = true;
  });
  try {
    while (options.now() - started < options.timeout_ms) {
      if (signal?.aborted) throw signal.reason;
      const previous = latest;
      const tools = (await client.listTools(signal)).tools;
      const changed =
        notified ||
        previous.length !== tools.length ||
        previous.some(({ name }, index) => name !== tools[index]?.name);
      notified = false;
      latest = tools;
      if (changed) changedAt = options.now();
      if (listed && options.now() - changedAt >= options.quiet_ms)
        return latest;
      listed = true;
      await waitForAbort(options.sleep(options.poll_ms), signal);
    }
  } finally {
    unsubscribe?.();
  }
  throw new Error(
    `MCP tool surface did not stabilize within ${options.timeout_ms}ms.`,
  );
}
