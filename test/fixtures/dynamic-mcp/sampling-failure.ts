export type SamplingFailureCategory =
  | "cancelled"
  | "sampling agent unavailable"
  | "sampling model/provider unavailable"
  | "sampling response limit exceeded"
  | "sampling session unavailable"
  | "unknown";

export function classifySamplingError(error: unknown): SamplingFailureCategory {
  const message = error instanceof Error ? error.message : "";
  if (/\b(?:abort(?:ed|ing)?|cancel(?:led|ed|lation)?)\b/i.test(message))
    return "cancelled";
  if (
    /OpenCode sampling output token accounting (?:exceeds MCP limit|is unavailable; cannot verify the MCP token limit)/i.test(
      message,
    )
  )
    return "sampling response limit exceeded";
  if (
    /OpenCode sampling assistant failed:\s*(?:API|Model|Provider)Error\b/i.test(
      message,
    ) ||
    /\b(?:model|provider)\b.*\b(?:error|failed|not found|unavailable)\b/i.test(
      message,
    )
  )
    return "sampling model/provider unavailable";
  if (
    /MCP sampling is denied\.|OpenCode sampling assistant failed:|\bsampling agent\b.*\b(?:failed|not found|unavailable)\b/i.test(
      message,
    )
  )
    return "sampling agent unavailable";
  if (
    /\b(?:child |parent )?session\b.*\b(?:error|failed|not found|unavailable)\b/i.test(
      message,
    )
  )
    return "sampling session unavailable";
  return "unknown";
}

export function formatSamplingFailure(error: unknown): string {
  return `Sampling request unavailable: ${classifySamplingError(error)}.`;
}
