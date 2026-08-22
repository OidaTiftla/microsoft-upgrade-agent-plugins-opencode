import { cp, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createCoreMcpProcessDefinition,
  loadMcpVersionManifest,
  writeHostDiscoveryFiles,
  type McpProcessDefinition,
} from "../src/mcp-process-definitions.ts";
import { diagnoseMcpPrerequisites } from "../src/mcp-prerequisites.ts";

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ToolArguments = Record<string, string | string[]>;

const pluginRoot = resolve(
  fileURLToPath(new URL("../plugins/upgrade-agent/", import.meta.url)),
);
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const mcpWorkingDirectory = process.env.HOME ?? homedir();
const proxiedToolNames = [
  "get_dotnet_upgrade_options",
  "typescript_scan_dependencies",
];

function withinTimeout<T>(
  operation: Promise<T>,
  timeout_ms: number,
  name: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutError = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${name} timed out after ${timeout_ms}ms.`)),
      timeout_ms,
    );
  });
  return Promise.race([operation, timeoutError]).finally(() =>
    clearTimeout(timeout),
  );
}

function getProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function getTool(tools: readonly McpTool[], name: string): McpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`MCP tool ${name} was not found.`);
  }
  return tool;
}

function getToolArguments(tool: McpTool, values: ToolArguments): ToolArguments {
  const schema = tool.inputSchema as {
    properties?: unknown;
    required?: unknown;
  };
  const properties = schema.properties;
  if (properties === undefined && Object.keys(values).length === 0) {
    return {};
  }
  if (properties === null || typeof properties !== "object") {
    throw new Error(
      `${tool.name} has invalid input schema: ${JSON.stringify(tool.inputSchema)}`,
    );
  }
  const arguments_ = Object.fromEntries(
    Object.entries(values).filter(([name]) => name in properties),
  );
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (
    required.some((name) => typeof name !== "string" || !(name in arguments_))
  ) {
    throw new Error(
      `${tool.name} requires unsupported inputs: ${JSON.stringify(tool.inputSchema)}`,
    );
  }
  return arguments_;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError === true
  );
}

function contains(result: unknown, expected: string): boolean {
  const content = JSON.stringify(result);
  return (
    content.includes(expected) && !/not found|no skills found/i.test(content)
  );
}

function summarize(result: unknown): string {
  const value = JSON.stringify(result);
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

async function connectMcp(definition: McpProcessDefinition): Promise<Client> {
  const client = new Client({
    name: "opencode-upgrade-agent-compatibility-gate",
    version: "0.0.0",
  });
  const transport = new StdioClientTransport({
    command: definition.command,
    args: [...definition.args],
    env: { ...getProcessEnvironment(), ...definition.env },
    cwd: mcpWorkingDirectory,
    stderr: "inherit",
  });
  await withinTimeout(
    client.connect(transport),
    definition.timeout_ms,
    definition.name,
  );
  return client;
}

async function withCore<T>(
  definition: McpProcessDefinition,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectMcp(definition);
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

async function waitForTools(
  client: Client,
  requiredToolNames: readonly string[],
): Promise<readonly McpTool[]> {
  let lastTools: readonly McpTool[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tools = (await client.listTools()).tools;
    lastTools = tools;
    if (
      requiredToolNames.every((name) =>
        tools.some((tool) => tool.name === name),
      )
    ) {
      return tools;
    }
    await wait(1_000);
  }
  throw new Error(
    `Core did not proxy ${requiredToolNames.join(", ")}: ${lastTools.map((tool) => tool.name).join(", ")}`,
  );
}

async function callTool(
  client: Client,
  tool: McpTool,
  values: ToolArguments,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return withinTimeout(
    client.callTool({
      name: tool.name,
      arguments: getToolArguments(tool, values),
    }),
    60_000,
    tool.name,
  );
}

async function withFixture<T>(
  name: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "opencode-upgrade-agent-"),
  );
  const fixturePath = join(temporaryRoot, name);
  await cp(join(workspaceRoot, "test", "fixtures", name), fixturePath, {
    recursive: true,
  });
  try {
    return await action(fixturePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function getFixtureState(
  client: Client,
  fixturePath: string,
  requiredToolNames: readonly string[],
): Promise<{
  readonly state: Awaited<ReturnType<Client["callTool"]>>;
  readonly tools: readonly McpTool[];
}> {
  const state = await callTool(
    client,
    getTool((await client.listTools()).tools, "get_state"),
    { path: fixturePath },
  );
  return { state, tools: await waitForTools(client, requiredToolNames) };
}

async function runDotnetFixture(
  definition: McpProcessDefinition,
): Promise<Record<string, unknown>> {
  return withFixture("dotnet-framework-upgrade", async (fixturePath) =>
    withCore(definition, async (core) => {
      const { state, tools } = await getFixtureState(core, fixturePath, [
        "get_dotnet_upgrade_options",
      ]);
      const scenarios = await callTool(
        core,
        getTool(tools, "get_scenarios"),
        {},
      );
      const instructions = await callTool(
        core,
        getTool(tools, "get_instructions"),
        { kind: "scenario", query: "dotnet-version-upgrade" },
      );
      const options = await callTool(
        core,
        getTool(tools, "get_dotnet_upgrade_options"),
        {
          solutionPath: join(fixturePath, "FrameworkUpgradeFixture.sln"),
          projectPath: "",
          targetFramework: "",
        },
      );
      return {
        sequence: [
          "get_state",
          "get_scenarios",
          "get_instructions",
          "get_dotnet_upgrade_options",
        ],
        state,
        scenarios,
        instructions,
        options,
        artifactsCreated: [],
      };
    }),
  );
}

async function runTypescriptFixture(
  definition: McpProcessDefinition,
): Promise<Record<string, unknown>> {
  return withFixture("typescript-compiler-upgrade", async (fixturePath) =>
    withCore(definition, async (core) => {
      const { state, tools } = await getFixtureState(core, fixturePath, [
        "typescript_scan_dependencies",
      ]);
      const instructions = await callTool(
        core,
        getTool(tools, "get_instructions"),
        { kind: "skill", query: "typescript-compiler-upgrade" },
      );
      const scan = await callTool(
        core,
        getTool(tools, "typescript_scan_dependencies"),
        {
          rootDirectory: fixturePath,
          requestedPackages: ["typescript"],
          skill: "typescript-compiler-upgrade",
        },
      );
      return {
        sequence: [
          "get_state",
          "get_instructions",
          "typescript_scan_dependencies",
        ],
        state,
        instructions,
        scan,
        artifactsCreated: [".tsupgrader/PROGRESS.md"],
      };
    }),
  );
}

async function runCompatibilityGate(): Promise<void> {
  const prerequisites = await diagnoseMcpPrerequisites();
  if (!prerequisites.isReady) {
    throw new Error(
      `MCP prerequisites failed: ${JSON.stringify(prerequisites.diagnostics)}`,
    );
  }

  const hostDir = await mkdtemp(join(tmpdir(), "opencode-upgrade-host-"));
  try {
    const manifest = await loadMcpVersionManifest(
      new URL("../src/mcp-versions.json", import.meta.url),
    );
    const files = await writeHostDiscoveryFiles(hostDir, pluginRoot, manifest);
    const definition = createCoreMcpProcessDefinition(manifest, {
      hostDir,
      pluginRoot,
    });
    const dotnet = await runDotnetFixture(definition);
    const typescript = await runTypescriptFixture(definition);
    const diagnostics = {
      coreInstances: 2,
      hostExtendersPath: files.hostExtendersPath,
      telemetryOptOut: definition.env.APPMOD_DISABLE_TELEMETRY,
      dotnet: Object.fromEntries(
        Object.entries(dotnet).map(([name, value]) => [name, summarize(value)]),
      ),
      typescript: Object.fromEntries(
        Object.entries(typescript).map(([name, value]) => [
          name,
          summarize(value),
        ]),
      ),
    };
    console.log(JSON.stringify(diagnostics));
    if (
      !contains(dotnet.scenarios, "dotnet-version-upgrade") ||
      !contains(dotnet.instructions, "dotnet-version-upgrade") ||
      isError(dotnet.options) ||
      !contains(typescript.instructions, "typescript-compiler-upgrade") ||
      isError(typescript.scan)
    ) {
      throw new Error("MCP routing failed; see the diagnostic summary above.");
    }
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
}

await runCompatibilityGate();
