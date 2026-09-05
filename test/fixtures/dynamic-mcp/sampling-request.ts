import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_SAMPLING_MAX_TOKENS = 256;
export const MAX_SAMPLING_TOKENS = 4_096;

export function createSamplingRequest(
  text: string,
  maxTokens: number,
): CreateMessageRequest {
  return {
    method: "sampling/createMessage",
    params: {
      maxTokens,
      messages: [{ content: { text, type: "text" }, role: "user" }],
    },
  };
}
