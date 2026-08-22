import type { Hooks } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";

import {
  createCoreMcpLifecycle,
  type CoreMcpLifecycle,
} from "./opencode-core-mcp.ts";
import {
  diagnoseMcpPrerequisites,
  type McpPrerequisiteDiagnostics,
} from "./mcp-prerequisites.ts";
import {
  convertBundledAgents,
  type AgentConversionResult,
} from "./agent-converter.ts";
import {
  ensureNoAgentConflicts,
  formatConversionWarnings,
  registerConvertedAgents,
} from "./agent-registration.ts";

export interface UpgradeAgentPluginDependencies {
  readonly diagnose: () => Promise<McpPrerequisiteDiagnostics>;
  readonly createLifecycle: () => Promise<CoreMcpLifecycle>;
  readonly convertAgents: () => Promise<AgentConversionResult>;
  readonly warn: (message: string) => void;
}

function getPrerequisiteError(diagnostics: McpPrerequisiteDiagnostics): Error {
  const messages = diagnostics.diagnostics.map(
    ({ prerequisite, message, remediation }) =>
      `- ${prerequisite}: ${message} ${remediation}`,
  );
  return new Error(
    `MCP prerequisites are not satisfied:\n${messages.join("\n")}`,
  );
}

function createDefaultLifecycle(): Promise<CoreMcpLifecycle> {
  return createCoreMcpLifecycle({
    pluginRoot: fileURLToPath(
      new URL("../plugins/upgrade-agent", import.meta.url),
    ),
    versionManifestPath: new URL("./mcp-versions.json", import.meta.url),
    wrapperPath: fileURLToPath(new URL("./dnx-wrapper.mjs", import.meta.url)),
  });
}

function convertDefaultAgents(): Promise<AgentConversionResult> {
  return convertBundledAgents(
    fileURLToPath(new URL("../plugins/upgrade-agent/agents", import.meta.url)),
  );
}

export async function createUpgradeAgentPlugin(
  dependencies: UpgradeAgentPluginDependencies = {
    diagnose: diagnoseMcpPrerequisites,
    createLifecycle: createDefaultLifecycle,
    convertAgents: convertDefaultAgents,
    warn: (message) => console.warn(message),
  },
): Promise<Hooks> {
  const diagnostics = await dependencies.diagnose();
  if (!diagnostics.isReady) {
    throw getPrerequisiteError(diagnostics);
  }

  const conversion = await dependencies.convertAgents();
  const lifecycle = await dependencies.createLifecycle();
  let warningsEmitted = false;
  return {
    config: async (config) => {
      try {
        ensureNoAgentConflicts(config, conversion.agents);
        lifecycle.config(config);
        registerConvertedAgents(config, conversion.agents);
        if (!warningsEmitted && conversion.diagnostics.length > 0) {
          dependencies.warn(formatConversionWarnings(conversion.diagnostics));
          warningsEmitted = true;
        }
      } catch (error) {
        await lifecycle.dispose();
        throw error;
      }
    },
    dispose: lifecycle.dispose,
  };
}
