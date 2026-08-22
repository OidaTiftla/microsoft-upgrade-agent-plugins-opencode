import type { Config } from "@opencode-ai/plugin";

import type {
  AgentConversionDiagnostic,
  ConvertedAgentDefinition,
} from "./agent-converter.ts";

type OpenCodeAgentConfig = NonNullable<NonNullable<Config["agent"]>[string]>;
type OpenCodePermission = NonNullable<OpenCodeAgentConfig["permission"]>;

export function ensureNoAgentConflicts(
  config: Config,
  agents: readonly ConvertedAgentDefinition[],
): void {
  const conflicts = agents
    .map(({ name }) => name)
    .filter(
      (name) => config.agent !== undefined && Object.hasOwn(config.agent, name),
    )
    .sort();
  if (conflicts.length > 0) {
    throw new Error(
      `Bundled agent keys are already configured: ${conflicts.join(", ")}.`,
    );
  }
}

function createAgentConfig(
  agent: ConvertedAgentDefinition,
  smallModel: string | undefined,
): OpenCodeAgentConfig {
  return {
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    permission: agent.permission as OpenCodePermission,
    prompt: agent.system,
    ...(agent.modelHint === "small_model" && smallModel !== undefined
      ? { model: smallModel }
      : {}),
  };
}

export function formatConversionWarnings(
  diagnostics: readonly AgentConversionDiagnostic[],
): string {
  return `Agent conversion warnings:\n${diagnostics
    .map(({ file, property, message }) => `- ${file} ${property}: ${message}`)
    .join("\n")}`;
}

export function registerConvertedAgents(
  config: Config,
  agents: readonly ConvertedAgentDefinition[],
): void {
  ensureNoAgentConflicts(config, agents);

  config.agent ??= {};
  for (const agent of agents) {
    config.agent[agent.name] = createAgentConfig(agent, config.small_model);
  }
}
