import type { Config } from "@opencode-ai/plugin";

import { ensureNoAgentNameConflicts } from "./agent-registration.ts";

export const SAMPLING_AGENT_NAME = "UpgradeSampler";

type AgentConfig = NonNullable<NonNullable<Config["agent"]>[string]>;

export function createSamplingAgentConfig(): AgentConfig {
  return {
    description: "Internal model-only sampler for Upgrade MCP requests.",
    hidden: true,
    mode: "subagent",
    permission: { "*": "deny" } as NonNullable<AgentConfig["permission"]>,
    prompt:
      "Return only the requested sampling response. Tools are unavailable.",
  };
}

export function ensureNoSamplingAgentConflict(config: Config): void {
  ensureNoAgentNameConflicts(config, [SAMPLING_AGENT_NAME]);
}

export function registerSamplingAgent(config: Config): void {
  ensureNoSamplingAgentConflict(config);
  config.agent ??= {};
  config.agent[SAMPLING_AGENT_NAME] = createSamplingAgentConfig();
}
