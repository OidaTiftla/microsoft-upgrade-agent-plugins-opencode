import { randomBytes } from "node:crypto";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolContext } from "@opencode-ai/plugin";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createCoreMcpProcessDefinition,
  loadMcpVersionManifest,
  writeHostDiscoveryFiles,
} from "../src/mcp-process-definitions.ts";
import { diagnoseMcpPrerequisites } from "../src/mcp-prerequisites.ts";
import {
  CoreToolExecutionCoordinator,
  primeRepositoryTraits,
  waitForStableMcpTools,
} from "../src/core-mcp-runtime.ts";
import { createPrivateCoreMcpClient } from "../src/private-core-mcp-client.ts";
import {
  UpgradeInvocationRegistry,
  UpgradeMcpProxyServer,
  type UpgradeInvocation,
} from "../src/upgrade-mcp-proxy-transport.ts";

type ToolArguments = Record<string, unknown>;

interface FixtureResult {
  readonly artifactCreated: boolean;
  readonly cancellationObserved: boolean;
  readonly instructions: readonly string[];
  readonly notifications: number;
  readonly rootBound: boolean;
  readonly scenarios?: string;
  readonly sessionContextsObserved: boolean;
  readonly toolNames: readonly string[];
}

const pluginRoot = resolve(
  fileURLToPath(new URL("../plugins/upgrade-agent/", import.meta.url)),
);
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
let nextCallID = 0;
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
  signal = new AbortController().signal,
): ToolContext {
  return {
    abort: signal,
    agent: "CompatibilityGate",
    ask: async () => undefined,
    directory,
    messageID: `${sessionID}-message`,
    metadata: () => undefined,
    sessionID,
    worktree: directory,
  };
}

async function executeProxyTool(
  client: Client,
  registry: UpgradeInvocationRegistry,
  name: string,
  arguments_: ToolArguments,
  context: ToolContext,
): Promise<unknown> {
  const invocation: UpgradeInvocation = {
    callID: `${context.sessionID}-${name}-${nextCallID++}`,
    sessionID: context.sessionID,
    tool: `Upgrade_${name}`,
  };
  registry.register(invocation);
  try {
    return await client.callTool({ arguments: arguments_, name }, undefined, {
      signal: context.abort,
      timeout: 3_600_000,
    });
  } finally {
    registry.release(invocation);
  }
}

function assertOverlappingRegistrationRejected(
  registry: UpgradeInvocationRegistry,
): void {
  const active: UpgradeInvocation = {
    callID: `overlap-${nextCallID++}`,
    sessionID: "overlap",
    tool: "Upgrade_get_state",
  };
  registry.register(active);
  try {
    let rejected = false;
    try {
      registry.register({ ...active, callID: `overlap-${nextCallID++}` });
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error("Overlapping Upgrade registration succeeded.");
    const acquired = registry.acquire(active.tool);
    if (
      acquired.sessionID !== active.sessionID ||
      acquired.callID !== active.callID ||
      acquired.tool !== active.tool
    )
      throw new Error(
        "Overlapping Upgrade registration corrupted the active invocation.",
      );
  } finally {
    registry.release(active);
  }
}

async function assertBundledResource(path: string): Promise<void> {
  const resolved = resolve(path);
  const relativePath = relative(pluginRoot, resolved);
  if (relativePath === "" || relativePath.startsWith(".."))
    throw new Error(`Bundled resource escaped trusted plugin root: ${path}`);
  await access(resolved);
}

async function runProxyFixture(input: {
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
}): Promise<FixtureResult> {
  return withFixture(input.fixture, async (fixturePath) => {
    const core = await createPrivateCoreMcpClient({
      pluginRoot,
      sampling: async () => {
        throw new Error("Compatibility gate must not request sampling.");
      },
      versionManifestPath: new URL("../src/mcp-versions.json", import.meta.url),
    });
    let notifications = 0;
    const unsubscribe = core.subscribeToToolListChanges(() => {
      notifications += 1;
    });
    const coordinator = new CoreToolExecutionCoordinator(core, {
      sample: async () => {
        throw new Error("Compatibility gate must not request sampling.");
      },
    });
    const registry = new UpgradeInvocationRegistry();
    const token = randomBytes(32).toString("hex");
    const observedSessions = new Set<string>();
    let proxyClient: Client | undefined;
    let proxy: UpgradeMcpProxyServer | undefined;
    try {
      await primeRepositoryTraits(core, fixturePath);
      const tools = await waitForStableMcpTools(core);
      proxy = new UpgradeMcpProxyServer({
        executeCoreTool: async (invocation, name, arguments_, signal) => {
          observedSessions.add(invocation.sessionID);
          return coordinator.execute(
            name,
            arguments_,
            createToolContext(fixturePath, invocation.sessionID, signal),
          );
        },
        listToolDescriptors: async () => [...tools],
        registry,
        token,
      });
      const endpoint = await proxy.start();
      proxyClient = new Client(
        { name: "upgrade-compatibility-gate", version: "0.0.0" },
        { capabilities: {} },
      );
      await proxyClient.connect(
        new StdioClientTransport({
          args: [
            fileURLToPath(
              new URL("../src/upgrade-mcp-proxy.ts", import.meta.url),
            ),
          ],
          command: process.execPath,
          env: {
            ...process.env,
            UPGRADE_MCP_PROXY_HOST: endpoint.host,
            UPGRADE_MCP_PROXY_PORT: String(endpoint.port),
            UPGRADE_MCP_PROXY_TOKEN: token,
          } as Record<string, string>,
          stderr: "inherit",
        }),
      );
      const discoveredTools = (await proxyClient.listTools()).tools;
      if (discoveredTools.some(({ inputSchema }) => inputSchema === undefined))
        throw new Error(`${input.fixture} exposed an incomplete MCP schema.`);
      assertOverlappingRegistrationRejected(registry);
      const context = createToolContext(fixturePath, input.fixture);
      const scenarios =
        input.scenario === undefined
          ? undefined
          : await executeProxyTool(
              proxyClient,
              registry,
              "get_scenarios",
              {},
              context,
            );
      const state = await executeProxyTool(
        proxyClient,
        registry,
        "get_state",
        { path: fixturePath },
        context,
      );
      const extender = await executeProxyTool(
        proxyClient,
        registry,
        input.extenderTool,
        input.extenderArguments(fixturePath),
        context,
      );
      const instructions: unknown[] = [];
      for (const { kind, query } of input.instructions)
        instructions.push(
          await executeProxyTool(
            proxyClient,
            registry,
            "get_instructions",
            { kind, query },
            context,
          ),
        );
      const sessionStates: unknown[] = [];
      for (const sessionID of ["first", "second"])
        sessionStates.push(
          await executeProxyTool(
            proxyClient,
            registry,
            "get_state",
            { path: fixturePath },
            createToolContext(fixturePath, sessionID),
          ),
        );
      const cancellation = new AbortController();
      cancellation.abort(new Error("Compatibility gate cancellation."));
      const cancellationObserved = await executeProxyTool(
        proxyClient,
        registry,
        "get_state",
        { path: fixturePath },
        createToolContext(fixturePath, "cancelled", cancellation.signal),
      ).then(
        (result) => contains(result, "isError"),
        () => true,
      );
      for (const resource of input.resources)
        await assertBundledResource(join(pluginRoot, resource));
      if (
        !contains(state, "content") ||
        !contains(extender, input.expectedContent) ||
        !instructions.every((output) => contains(output, "<skill")) ||
        !sessionStates.every((output) => contains(output, "content"))
      )
        throw new Error(
          `${input.fixture} proxy checks failed: state=${contains(state, "content")}, extenderContent=${contains(extender, input.expectedContent)}, instructions=${instructions.every((output) => contains(output, "<skill"))}, sessionStates=${sessionStates.every((output) => contains(output, "content"))}.`,
        );
      return {
        artifactCreated:
          input.artifactPath === undefined
            ? true
            : await access(join(fixturePath, input.artifactPath))
                .then(() => true)
                .catch(() => false),
        cancellationObserved:
          cancellationObserved && !observedSessions.has("cancelled"),
        sessionContextsObserved: ["first", "second"].every((sessionID) =>
          observedSessions.has(sessionID),
        ),
        instructions: instructions.map((output) => JSON.stringify(output)),
        notifications,
        rootBound: contains(extender, fixturePath),
        scenarios:
          scenarios === undefined ? undefined : JSON.stringify(scenarios),
        toolNames: discoveredTools.map(({ name }) => `Upgrade_${name}`).sort(),
      };
    } finally {
      coordinator.dispose();
      await proxyClient?.close();
      await proxy?.stop();
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
      new URL("../src/mcp-versions.json", import.meta.url),
    );
    const files = await writeHostDiscoveryFiles(hostDir, pluginRoot, manifest);
    const definition = createCoreMcpProcessDefinition(manifest, {
      hostDir,
      pluginRoot,
    });
    const dotnet = await runProxyFixture({
      expectedContent: "Upgrade target framework:",
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
    const typescript = await runProxyFixture({
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
        cancellationObserved: dotnet.cancellationObserved,
        proxyExtender: dotnet.toolNames.includes(
          "Upgrade_get_dotnet_upgrade_options",
        ),
        sessionContextsObserved: dotnet.sessionContextsObserved,
        isolatedExtender:
          !dotnet.toolNames.includes("Upgrade_typescript_scan_dependencies") &&
          !dotnet.instructions.some((output) =>
            output.includes("typescript-compiler-upgrade"),
          ),
        lazyReference: dotnet.instructions.some((output) =>
          output.includes("Get-NullableReadiness.ps1"),
        ),
        notifications: dotnet.notifications,
        rootBound: dotnet.rootBound,
      },
      typescript: {
        artifactCreated: typescript.artifactCreated,
        cancellationObserved: typescript.cancellationObserved,
        proxyExtender: typescript.toolNames.includes(
          "Upgrade_typescript_scan_dependencies",
        ),
        sessionContextsObserved: typescript.sessionContextsObserved,
        isolatedExtender: !typescript.instructions.some((output) =>
          output.includes("dotnet-version-upgrade"),
        ),
        guidanceReference: typescript.instructions.some((output) =>
          output.includes("compiler-upgrade.md"),
        ),
        notifications: typescript.notifications,
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
      !dotnet.cancellationObserved ||
      !typescript.cancellationObserved ||
      dotnet.notifications <= 0 ||
      typescript.notifications <= 0 ||
      !dotnet.sessionContextsObserved ||
      !typescript.sessionContextsObserved ||
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
