import type { ToolContext } from "@opencode-ai/plugin";
import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";

export type ProxySamplingCallback<T> = (
  request: CreateMessageRequest,
  context: ToolContext,
) => Promise<T>;

export function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  const getAborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )?.get;
  try {
    return typeof getAborted?.call(value) === "boolean";
  } catch {
    return false;
  }
}

export function normalizeProxySamplingSignal(value: unknown): AbortSignal {
  return isAbortSignalLike(value) ? value : new AbortController().signal;
}

export function invokeProxySampling<T>(
  nativeContext: ToolContext,
  request: CreateMessageRequest,
  mcpSignal: unknown,
  invoke: ProxySamplingCallback<T>,
): Promise<T> {
  const context = Object.defineProperty(Object.create(nativeContext), "abort", {
    enumerable: true,
    value: normalizeProxySamplingSignal(mcpSignal),
  }) as ToolContext;
  return invoke(request, context);
}
