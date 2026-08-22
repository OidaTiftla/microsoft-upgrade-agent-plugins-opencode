import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "@opencode-ai/plugin";

import {
  createCoreMcpProcessDefinition,
  loadMcpVersionManifest,
  writeHostDiscoveryFiles,
  type McpProcessDefinition,
} from "./mcp-process-definitions.ts";

export interface CoreMcpLifecycle {
  config(config: Config): void;
  dispose(): Promise<void>;
}

export interface CoreMcpLifecycleOptions {
  readonly pluginRoot: string;
  readonly versionManifestPath: URL | string;
  readonly wrapperPath: string;
}

const CORE_MCP_KEY = "Upgrade";

export function registerCoreMcp(
  config: Config,
  definition: McpProcessDefinition,
  wrapperPath: string,
): void {
  if (config.mcp !== undefined && Object.hasOwn(config.mcp, CORE_MCP_KEY)) {
    throw new Error(`MCP key "${CORE_MCP_KEY}" is already configured.`);
  }

  config.mcp ??= {};
  config.mcp[CORE_MCP_KEY] = {
    type: "local",
    command: ["node", wrapperPath, definition.command, ...definition.args],
    environment: { ...definition.env },
    timeout: definition.timeout_ms,
  };
}

export async function createCoreMcpLifecycle(
  options: CoreMcpLifecycleOptions,
): Promise<CoreMcpLifecycle> {
  const hostDir = await mkdtemp(join(tmpdir(), "opencode-upgrade-host-"));
  try {
    const manifest = await loadMcpVersionManifest(options.versionManifestPath);
    await writeHostDiscoveryFiles(hostDir, options.pluginRoot, manifest);
    const definition = createCoreMcpProcessDefinition(manifest, {
      hostDir,
      pluginRoot: options.pluginRoot,
    });
    return {
      config: (config) =>
        registerCoreMcp(config, definition, options.wrapperPath),
      dispose: async () => rm(hostDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(hostDir, { recursive: true, force: true });
    throw error;
  }
}
