import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { parse } from "yaml";

export interface AgentConversionDiagnostic {
  readonly level: "warning" | "error";
  readonly file: string;
  readonly property: string;
  readonly message: string;
}

export interface ConvertedAgentDefinition {
  readonly id: string;
  // Future OpenCode config uses this source name to preserve orchestrator dispatch names.
  readonly name: string;
  readonly description: string;
  readonly mode: "primary" | "subagent";
  readonly hidden: boolean;
  readonly permission: Readonly<Record<string, "allow" | "deny">>;
  readonly system: string;
  readonly model?: string;
  readonly modelHint?: "small_model";
}

export interface AgentConversionResult {
  readonly agents: readonly ConvertedAgentDefinition[];
  readonly diagnostics: readonly AgentConversionDiagnostic[];
}

export class AgentConversionError extends Error {
  readonly diagnostics: readonly AgentConversionDiagnostic[];

  constructor(diagnostics: readonly AgentConversionDiagnostic[]) {
    super(
      diagnostics
        .map(({ file, property, message }) => `${file} ${property}: ${message}`)
        .join("\n"),
    );
    this.diagnostics = diagnostics;
  }
}

const KNOWN_PROPERTIES = new Set([
  "name",
  "description",
  "user-invocable",
  "model",
  "tools",
  "mcp-servers",
]);
const OPTIONAL_PROPERTIES = new Set(["metadata", "tags"]);
const UPGRADE_TOOLS = new Set([
  "get_state",
  "get_scenarios",
  "get_instructions",
  "initialize_scenario",
  "resume_scenario",
  "start_task",
  "complete_task",
  "open_dashboard",
  "break_down_task",
  "discover_upgrade_scenarios",
  "predict_token_usage",
  "get_dotnet_upgrade_options",
  "generate_dotnet_upgrade_assessment",
]);
const TOOL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  execute: ["bash"],
  read: ["read"],
  edit: ["edit"],
  search: ["glob", "grep"],
  web: ["webfetch"],
  ask_user: ["question"],
  agent: ["task"],
  read_agent: ["task"],
  open_canvas: [],
  open_dashboard: [],
};

function diagnostic(
  file: string,
  property: string,
  message: string,
  level: "warning" | "error" = "error",
): AgentConversionDiagnostic {
  return { level, file, property, message };
}

function parseFrontmatter(
  file: string,
  source: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (match === null) {
    throw new AgentConversionError([
      diagnostic(file, "frontmatter", "YAML frontmatter is required."),
    ]);
  }
  const frontmatter = parse(match[1]);
  if (frontmatter === null || typeof frontmatter !== "object") {
    throw new AgentConversionError([
      diagnostic(file, "frontmatter", "YAML frontmatter must be an object."),
    ]);
  }
  return {
    frontmatter: frontmatter as Record<string, unknown>,
    body: source.slice(match[0].length).replace(/^\r?\n/, ""),
  };
}

function getString(
  file: string,
  frontmatter: Record<string, unknown>,
  property: "name" | "description",
): string {
  const value = frontmatter[property];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentConversionError([
      diagnostic(file, property, "A non-empty string is required."),
    ]);
  }
  return value;
}

function mapTools(
  file: string,
  name: string,
  tools: unknown,
): Readonly<Record<string, "allow" | "deny">> {
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
    throw new AgentConversionError([
      diagnostic(file, "tools", "A string array is required."),
    ]);
  }
  const permission: Record<string, "allow" | "deny"> = {
    "*": name === "BreakGlass" ? "allow" : "deny",
  };
  for (const tool of tools) {
    if (tool === "*") {
      if (name !== "BreakGlass") {
        throw new AgentConversionError([
          diagnostic(
            file,
            "tools",
            "Wildcard access is reserved for BreakGlass.",
          ),
        ]);
      }
      continue;
    }
    if (tool === "Upgrade/*") {
      permission["Upgrade_*"] = "allow";
      continue;
    }
    if (tool.startsWith("Upgrade/")) {
      const mcpTool = tool.slice("Upgrade/".length);
      if (!UPGRADE_TOOLS.has(mcpTool)) {
        throw new AgentConversionError([
          diagnostic(file, "tools", `Unknown MCP tool ${tool}.`),
        ]);
      }
      if (mcpTool === "open_dashboard") continue;
      permission[`Upgrade_${mcpTool}`] = "allow";
      continue;
    }
    const permissions = TOOL_PERMISSIONS[tool];
    if (permissions === undefined) {
      throw new AgentConversionError([
        diagnostic(file, "tools", `Unknown tool ${tool}.`),
      ]);
    }
    for (const key of permissions) {
      permission[key] = "allow";
    }
  }
  // Last-match permission evaluation keeps unsupported Canvas/dashboard calls unavailable.
  permission.open_canvas = "deny";
  permission.Upgrade_open_dashboard = "deny";
  return permission;
}

function getWarnings(
  file: string,
  frontmatter: Record<string, unknown>,
): AgentConversionDiagnostic[] {
  const warnings: AgentConversionDiagnostic[] = [];
  for (const property of Object.keys(frontmatter)) {
    if (KNOWN_PROPERTIES.has(property)) continue;
    if (OPTIONAL_PROPERTIES.has(property)) {
      warnings.push(
        diagnostic(
          file,
          property,
          "Optional frontmatter property was ignored.",
          "warning",
        ),
      );
      continue;
    }
    throw new AgentConversionError([
      diagnostic(
        file,
        property,
        "Unknown behavior-affecting frontmatter property.",
      ),
    ]);
  }
  return warnings;
}

export function convertAgentSource(
  file: string,
  source: string,
  compatibilityInstruction: string,
): {
  agent: ConvertedAgentDefinition;
  diagnostics: readonly AgentConversionDiagnostic[];
} {
  const { frontmatter, body } = parseFrontmatter(file, source);
  const warnings = getWarnings(file, frontmatter);
  const name = getString(file, frontmatter, "name");
  const description = getString(file, frontmatter, "description");
  const userInvocable = frontmatter["user-invocable"];
  if (userInvocable !== undefined && typeof userInvocable !== "boolean") {
    throw new AgentConversionError([
      diagnostic(file, "user-invocable", "A boolean is required."),
    ]);
  }
  const model = frontmatter.model;
  if (model !== undefined && typeof model !== "string") {
    throw new AgentConversionError([
      diagnostic(file, "model", "A string is required."),
    ]);
  }
  const hidden = userInvocable === false;
  return {
    agent: {
      id: basename(file).replace(/\.agent\.md$/, ""),
      name,
      description,
      mode: hidden ? "subagent" : "primary",
      hidden,
      permission: mapTools(file, name, frontmatter.tools),
      system: `${body}\n\n${compatibilityInstruction}`,
      ...(typeof model === "string" && model.includes("/") ? { model } : {}),
      ...(typeof model === "string" && !model.includes("/")
        ? { modelHint: "small_model" }
        : {}),
    },
    diagnostics: warnings,
  };
}

export async function convertBundledAgents(
  agentDirectory: string,
): Promise<AgentConversionResult> {
  const compatibilityInstruction = await readFile(
    new URL("./copilot-compatibility-instruction.md", import.meta.url),
    "utf8",
  );
  const files = (await readdir(agentDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".agent.md"))
    .map((entry) => entry.name)
    .sort();
  const agents: ConvertedAgentDefinition[] = [];
  const diagnostics: AgentConversionDiagnostic[] = [];
  for (const file of files) {
    try {
      const converted = convertAgentSource(
        file,
        await readFile(join(agentDirectory, file), "utf8"),
        compatibilityInstruction,
      );
      agents.push(converted.agent);
      diagnostics.push(...converted.diagnostics);
    } catch (error) {
      if (error instanceof AgentConversionError)
        diagnostics.push(...error.diagnostics);
      else throw error;
    }
  }
  const errors = diagnostics.filter((entry) => entry.level === "error");
  if (errors.length > 0) throw new AgentConversionError(errors);
  return { agents, diagnostics };
}
