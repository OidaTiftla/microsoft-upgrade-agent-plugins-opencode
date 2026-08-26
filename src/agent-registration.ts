import type { Config } from "@opencode-ai/plugin";
import { posix, win32 } from "node:path";

import type {
  AgentConversionDiagnostic,
  ConvertedAgentDefinition,
} from "./agent-converter.ts";

type OpenCodeAgentConfig = NonNullable<NonNullable<Config["agent"]>[string]>;
type OpenCodePermission = NonNullable<OpenCodeAgentConfig["permission"]>;
type PermissionContainer = { permission?: Record<string, unknown> };
type PathImplementation = typeof posix | typeof win32;

const FILESYSTEM_PERMISSIONS = new Set([
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
]);

function getPathImplementation(platform: NodeJS.Platform): PathImplementation {
  return platform === "win32" ? win32 : posix;
}

export function getBundledExternalDirectoryPattern(
  bundledPluginRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = getPathImplementation(platform);
  const normalized = path.normalize(bundledPluginRoot);
  if (
    !path.isAbsolute(bundledPluginRoot) ||
    bundledPluginRoot.split(/[\\/]+/).includes("..") ||
    normalized === path.parse(normalized).root
  )
    throw new Error(
      "A trusted bundled plugin root must be an absolute non-root path without traversal.",
    );
  const root = normalized.endsWith(path.sep)
    ? normalized.slice(0, -path.sep.length)
    : normalized;
  return `${root}${path.sep}**`;
}

function needsBundledFilesystemAccess(
  agent: ConvertedAgentDefinition,
): boolean {
  if (agent.permission["*"] === "allow") return false;
  return [...FILESYSTEM_PERMISSIONS].some(
    (permission) => agent.permission[permission] === "allow",
  );
}

function getAgentPermission(
  agent: ConvertedAgentDefinition,
  bundledPluginRoot: string,
): OpenCodePermission {
  if (!needsBundledFilesystemAccess(agent))
    return agent.permission as OpenCodePermission;
  return {
    ...agent.permission,
    external_directory: {
      [getBundledExternalDirectoryPattern(bundledPluginRoot)]: "allow",
    },
  } as unknown as OpenCodePermission;
}

function appendSamplingAskPermission(
  permission: OpenCodePermission | undefined,
): OpenCodePermission {
  const values = (permission ?? {}) as Record<string, unknown>;
  return {
    ...values,
    sampling: values.sampling ?? "ask",
  } as OpenCodePermission;
}

export function registerSamplingAskPermissions(config: Config): void {
  const root = config as Config & PermissionContainer;
  root.permission = {
    ...root.permission,
    sampling: root.permission?.sampling ?? "ask",
  };
  for (const agent of Object.values(config.agent ?? {})) {
    if (agent === undefined) continue;
    agent.permission = appendSamplingAskPermission(agent.permission);
  }
}

export function ensureNoAgentConflicts(
  config: Config,
  agents: readonly ConvertedAgentDefinition[],
): void {
  ensureNoAgentNameConflicts(
    config,
    agents.map(({ name }) => name),
  );
}

export function ensureNoAgentNameConflicts(
  config: Config,
  names: readonly string[],
): void {
  const conflicts = names
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
  bundledPluginRoot: string,
): OpenCodeAgentConfig {
  return {
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    permission: getAgentPermission(agent, bundledPluginRoot),
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
  bundledPluginRoot: string,
): void {
  ensureNoAgentConflicts(config, agents);

  config.agent ??= {};
  for (const agent of agents) {
    config.agent[agent.name] = createAgentConfig(
      agent,
      config.small_model,
      bundledPluginRoot,
    );
  }
}
