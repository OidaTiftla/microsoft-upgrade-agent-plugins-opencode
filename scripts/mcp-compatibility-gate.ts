import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolContext } from "@opencode-ai/plugin";

import {
  createCoreMcpProcessDefinition,
  loadMcpVersionManifest,
  writeHostDiscoveryFiles,
} from "../src/mcp-process-definitions.ts";
import { diagnoseMcpPrerequisites } from "../src/mcp-prerequisites.ts";
import {
  createOpenCodeMcpToolBridge,
  primeRepositoryTraits,
  type McpToolBridge,
} from "../src/opencode-mcp-tool-bridge.ts";
import { createPrivateCoreMcpClient } from "../src/private-core-mcp-client.ts";

type ToolArguments = Record<string, string | string[]>;

interface BridgeFixtureResult {
  readonly artifactCreated: boolean;
  readonly concurrentContextObserved: boolean;
  readonly instructions: readonly string[];
  readonly notifications: number;
  readonly progressNotifications: number;
  readonly rootBound: boolean;
  readonly scenarios?: string;
  readonly toolNames: readonly string[];
}

const pluginRoot = resolve(
  fileURLToPath(new URL("../plugins/upgrade-agent/", import.meta.url)),
);
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
function contains(result: unknown, expected: string): boolean {
  const content = JSON.stringify(result) ?? "";
  return (
    content.includes(expected) && !/not found|no skills found/i.test(content)
  );
}

async function withFixture<T>(
  name: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "opencode-microsoft-upgrade-agent-"),
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

function createToolContext(
  directory: string,
  sessionID: string,
  progress: unknown[],
): ToolContext {
  return {
    abort: new AbortController().signal,
    agent: "CompatibilityGate",
    ask: async () => undefined,
    directory,
    messageID: `${sessionID}-message`,
    metadata: (value) => progress.push({ sessionID, value }),
    sessionID,
    worktree: directory,
  };
}

async function executeBridgeTool(
  bridge: McpToolBridge,
  name: string,
  arguments_: ToolArguments,
  context: ToolContext,
): Promise<{ readonly output: string; readonly title: string }> {
  const definition = bridge.tools[`Upgrade_${name}`];
  if (definition === undefined)
    throw new Error(`Bridge did not expose Upgrade_${name}.`);
  const result = await definition.execute(arguments_, context);
  if (
    result === null ||
    typeof result !== "object" ||
    typeof (result as { output?: unknown }).output !== "string" ||
    typeof (result as { title?: unknown }).title !== "string"
  )
    throw new Error(
      `Bridge tool Upgrade_${name} did not return an OpenCode result.`,
    );
  return result as { readonly output: string; readonly title: string };
}

async function assertBundledResource(path: string): Promise<void> {
  const resolved = resolve(path);
  const relativePath = relative(pluginRoot, resolved);
  if (relativePath === "" || relativePath.startsWith(".."))
    throw new Error(`Bundled resource escaped trusted plugin root: ${path}`);
  await access(resolved);
}

async function runBridgeFixture(input: {
  readonly artifactPath?: string;
  readonly extenderArguments: (fixturePath: string) => ToolArguments;
  readonly extenderTool: string;
  readonly fixture: string;
  readonly instructions: readonly {
    readonly kind: string;
    readonly query: string;
  }[];
  readonly resources: readonly string[];
  readonly scenario?: string;
  readonly expectedContent: string;
}): Promise<BridgeFixtureResult> {
  return withFixture(input.fixture, async (fixturePath) => {
    const core = await createPrivateCoreMcpClient({
      pluginRoot,
      sampling: async () => {
        throw new Error("Compatibility gate must not request sampling.");
      },
      versionManifestPath: new URL("../src/mcp-versions/", import.meta.url),
    });
    let notifications = 0;
    const unsubscribe = core.subscribeToToolListChanges(() => {
      notifications += 1;
    });
    try {
      await primeRepositoryTraits(core, fixturePath);
      const bridge = await createOpenCodeMcpToolBridge(core, "Upgrade", {
        sample: async () => {
          throw new Error("Compatibility gate must not request sampling.");
        },
      });
      await Promise.all(
        Object.keys(bridge.tools).map(async (toolID) => {
          const output = { description: "", parameters: {} } as {
            description: string;
            jsonSchema?: unknown;
            parameters: unknown;
          };
          await bridge.toolDefinition({ toolID }, output);
          if (output.jsonSchema === undefined)
            throw new Error(`${toolID} did not expose an MCP JSON Schema.`);
        }),
      );
      const progress: unknown[] = [];
      const context = createToolContext(fixturePath, input.fixture, progress);
      const scenarios =
        input.scenario === undefined
          ? undefined
          : await executeBridgeTool(bridge, "get_scenarios", {}, context);
      const state = await executeBridgeTool(
        bridge,
        "get_state",
        { path: fixturePath },
        context,
      );
      const extender = await executeBridgeTool(
        bridge,
        input.extenderTool,
        input.extenderArguments(fixturePath),
        context,
      );
      const instructions = await Promise.all(
        input.instructions.map(({ kind, query }) =>
          executeBridgeTool(
            bridge,
            "get_instructions",
            { kind, query },
            context,
          ),
        ),
      );
      const concurrent = await Promise.all(
        ["first", "second"].map((sessionID) =>
          executeBridgeTool(
            bridge,
            "get_state",
            { path: fixturePath },
            createToolContext(fixturePath, sessionID, progress),
          ),
        ),
      );
      for (const resource of input.resources)
        await assertBundledResource(join(pluginRoot, resource));
      if (
        state.title !== "Upgrade_get_state" ||
        extender.title !== `Upgrade_${input.extenderTool}`
      )
        throw new Error(
          `${input.fixture} bridge returned an incomplete OpenCode result.`,
        );
      if (
        !contains(extender.output, input.expectedContent) ||
        !instructions.every(({ output }) => output.includes("<skill")) ||
        !concurrent.every(({ title }) => title === "Upgrade_get_state")
      )
        throw new Error(
          `${input.fixture} bridge content or concurrent execution failed.`,
        );
      return {
        artifactCreated:
          input.artifactPath === undefined
            ? true
            : await access(join(fixturePath, input.artifactPath))
                .then(() => true)
                .catch(() => false),
        concurrentContextObserved: ["first", "second"].every((sessionID) =>
          progress.some(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              (entry as { sessionID?: unknown }).sessionID === sessionID,
          ),
        ),
        instructions: instructions.map(({ output }) => output),
        notifications,
        progressNotifications: progress.length,
        rootBound: extender.output.includes(fixturePath),
        scenarios: scenarios?.output,
        toolNames: Object.keys(bridge.tools).sort(),
      };
    } finally {
      unsubscribe();
      await core.dispose();
    }
  });
}

async function runCompatibilityGate(): Promise<void> {
  const prerequisites = await diagnoseMcpPrerequisites();
  if (!prerequisites.isReady) {
    throw new Error(
      `MCP prerequisites failed: ${JSON.stringify(prerequisites.diagnostics)}`,
    );
  }

  const hostDir = await mkdtemp(
    join(tmpdir(), "opencode-microsoft-upgrade-host-"),
  );
  try {
    const manifest = await loadMcpVersionManifest(
      new URL("../src/mcp-versions/", import.meta.url),
    );
    const files = await writeHostDiscoveryFiles(hostDir, pluginRoot, manifest);
    const definition = createCoreMcpProcessDefinition(manifest, {
      hostDir,
      pluginRoot,
    });
    const dotnet = await runBridgeFixture({
      expectedContent: "net10.0",
      extenderArguments: (fixturePath) => ({
        projectPath: "",
        solutionPath: join(fixturePath, "FrameworkUpgradeFixture.sln"),
        targetFramework: "",
      }),
      extenderTool: "get_dotnet_upgrade_options",
      fixture: "dotnet-framework-upgrade",
      instructions: [
        { kind: "scenario", query: "dotnet-version-upgrade" },
        { kind: "skill", query: "migrating-csharp-nullable-references" },
      ],
      resources: [
        "extenders/upgrade-dotnet/upgrade/skills/lazy/common/migrating-csharp-nullable-references/scripts/Get-NullableReadiness.ps1",
      ],
      scenario: "dotnet-version-upgrade",
    });
    const typescript = await runBridgeFixture({
      artifactPath: ".tsupgrader/PROGRESS.md",
      expectedContent: "typeScriptMigrationNeeded",
      extenderArguments: (fixturePath) => ({
        requestedPackages: ["typescript"],
        rootDirectory: fixturePath,
        skill: "typescript-compiler-upgrade",
      }),
      extenderTool: "typescript_scan_dependencies",
      fixture: "typescript-compiler-upgrade",
      instructions: [
        { kind: "skill", query: "typescript-compiler-upgrade" },
        { kind: "skill", query: "typescript-dependencies-upgrade" },
      ],
      resources: [
        "extenders/upgrade-typescript/upgrade/skills/typescript-compiler-upgrade/compiler-upgrade.md",
        "extenders/upgrade-typescript/upgrade/skills/typescript-dependencies-upgrade/upgrade-packages.md",
      ],
    });
    const diagnostics = {
      coreInstances: 2,
      hostExtendersPath: files.hostExtendersPath,
      telemetryOptOut: definition.env.APPMOD_DISABLE_TELEMETRY,
      dotnet: {
        artifactCreated: dotnet.artifactCreated,
        bridgeExtender: dotnet.toolNames.includes(
          "Upgrade_get_dotnet_upgrade_options",
        ),
        concurrentContextObserved: dotnet.concurrentContextObserved,
        isolatedExtender:
          !dotnet.toolNames.includes("Upgrade_typescript_scan_dependencies") &&
          !dotnet.instructions.some((output) =>
            output.includes("typescript-compiler-upgrade"),
          ),
        lazyReference: dotnet.instructions.some((output) =>
          output.includes("Get-NullableReadiness.ps1"),
        ),
        notifications: dotnet.notifications,
        progressNotifications: dotnet.progressNotifications,
        rootBound: dotnet.rootBound,
      },
      typescript: {
        artifactCreated: typescript.artifactCreated,
        bridgeExtender: typescript.toolNames.includes(
          "Upgrade_typescript_scan_dependencies",
        ),
        concurrentContextObserved: typescript.concurrentContextObserved,
        isolatedExtender: !typescript.instructions.some((output) =>
          output.includes("dotnet-version-upgrade"),
        ),
        guidanceReference: typescript.instructions.some((output) =>
          output.includes("compiler-upgrade.md"),
        ),
        notifications: typescript.notifications,
        progressNotifications: typescript.progressNotifications,
        rootBound: typescript.rootBound,
      },
    };
    console.log(JSON.stringify(diagnostics));
    if (
      !dotnet.artifactCreated ||
      !typescript.artifactCreated ||
      !contains(dotnet.scenarios, "dotnet-version-upgrade") ||
      !dotnet.rootBound ||
      !typescript.rootBound ||
      dotnet.notifications <= 0 ||
      typescript.notifications <= 0 ||
      dotnet.progressNotifications <= 0 ||
      typescript.progressNotifications <= 0 ||
      !dotnet.concurrentContextObserved ||
      !typescript.concurrentContextObserved ||
      dotnet.toolNames.includes("Upgrade_typescript_scan_dependencies") ||
      !dotnet.instructions.every(
        (output) => !output.includes("typescript-compiler-upgrade"),
      ) ||
      !typescript.instructions.every(
        (output) => !output.includes("dotnet-version-upgrade"),
      ) ||
      !dotnet.instructions.some((output) =>
        output.includes("Get-NullableReadiness.ps1"),
      ) ||
      !typescript.instructions.some((output) =>
        output.includes("compiler-upgrade.md"),
      )
    ) {
      throw new Error("MCP routing failed; see the diagnostic summary above.");
    }
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
}

await runCompatibilityGate();
