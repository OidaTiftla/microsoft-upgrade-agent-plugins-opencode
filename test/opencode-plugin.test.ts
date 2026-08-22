import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { Config } from "@opencode-ai/plugin";

import type { AgentConversionResult } from "../src/agent-converter.ts";
import * as packageEntry from "../src/index.ts";
import { createUpgradeAgentPlugin } from "../src/upgrade-agent-plugin.ts";
import {
  createCoreMcpLifecycle,
  registerCoreMcp,
} from "../src/opencode-core-mcp.ts";

const manifest = {
  core: { package: "Microsoft.GitHubCopilot.Upgrade.Mcp", version: "1.1.441" },
  dotnet: {
    package: "Microsoft.GitHubCopilot.Upgrade.DotNet.Mcp",
    version: "1.1.441",
  },
  typescript: {
    package: "@microsoft/jsts-upgrade-assistant",
    version: "0.1.6",
  },
};

const definition = {
  name: "Upgrade" as const,
  command: "dnx" as const,
  args: ["Microsoft.GitHubCopilot.Upgrade.Mcp@1.1.441", "--yes"],
  env: { APPMOD_DISABLE_TELEMETRY: "true" },
  timeout_ms: 300000,
};

const convertedAgents: AgentConversionResult = {
  agents: [
    {
      id: "upgrade",
      name: "Upgrade",
      description: "Upgrade projects.",
      mode: "primary",
      hidden: false,
      permission: { "*": "deny", Upgrade_get_state: "allow" },
      system: "Upgrade prompt.",
    },
  ],
  diagnostics: [],
};

test("packageEntry_Exports_Expect_DefaultPluginOnly", async () => {
  // Arrange
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  // Act
  const exports = Object.keys(packageEntry);

  // Assert
  assert.equal(packageJson.exports, "./src/index.ts");
  assert.deepEqual(exports, ["default"]);
  assert.equal(typeof packageEntry.default, "function");
});

test("registerCoreMcp_ExistingConfiguration_Expect_MergedCoreServer", () => {
  // Arrange
  const config: Config = {
    mcp: { Existing: { type: "local", command: ["existing"] } },
  };

  // Act
  registerCoreMcp(config, definition, "/wrapper.mjs");

  // Assert
  assert.deepEqual(config.mcp, {
    Existing: { type: "local", command: ["existing"] },
    Upgrade: {
      type: "local",
      command: [
        "node",
        "/wrapper.mjs",
        "dnx",
        "Microsoft.GitHubCopilot.Upgrade.Mcp@1.1.441",
        "--yes",
      ],
      environment: { APPMOD_DISABLE_TELEMETRY: "true" },
      timeout: 300000,
    },
  });
});

test("registerCoreMcp_ConflictingKey_Expect_ThrowsException", () => {
  // Arrange
  const config: Config = {
    mcp: { Upgrade: { type: "local", command: ["existing"] } },
  };

  // Act
  const action = () => registerCoreMcp(config, definition, "/wrapper.mjs");

  // Assert
  assert.throws(action, /MCP key "Upgrade" is already configured/);
});

test("createCoreMcpLifecycle_ActiveLifecycle_Expect_GeneratedFilesRemovedOnDispose", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "opencode-plugin-"));
  const pluginRoot = join(root, "plugins", "upgrade-agent");
  const versionManifestPath = join(root, "mcp-versions.json");
  try {
    await writeFile(versionManifestPath, JSON.stringify(manifest));
    for (const [id, packageName] of [
      ["upgrade-dotnet", manifest.dotnet.package],
      ["upgrade-typescript", manifest.typescript.package],
    ] as const) {
      const path = join(pluginRoot, "extenders", id, "upgrade-extension.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            args: id === "upgrade-dotnet" ? [packageName] : ["-y", packageName],
          },
        }),
      );
    }

    // Act
    const lifecycle = await createCoreMcpLifecycle({
      pluginRoot,
      versionManifestPath,
      wrapperPath: "/wrapper.mjs",
    });
    const config: Config = {};
    lifecycle.config(config);
    const core = config.mcp?.Upgrade;
    const hostDir =
      core?.type === "local" ? core.environment?.APPMOD_HOST_DIR : undefined;
    await lifecycle.dispose();

    // Assert
    assert.equal(typeof hostDir, "string");
    await assert.rejects(access(hostDir!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createUpgradeAgentPlugin_MissingPrerequisites_Expect_ActionableError", async () => {
  // Arrange
  const createLifecycle = async () => {
    throw new Error("Lifecycle should not be created.");
  };

  // Act
  const action = () =>
    createUpgradeAgentPlugin({
      diagnose: async () => ({
        isReady: false,
        diagnostics: [
          {
            prerequisite: "dnx",
            status: "missing",
            message: 'Required executable "dnx" was not found on PATH.',
            remediation: "Install the .NET SDK 10 or later.",
          },
        ],
      }),
      createLifecycle,
      convertAgents: async () => convertedAgents,
      warn: () => undefined,
    });

  // Assert
  await assert.rejects(action, /dnx.*Install the .NET SDK 10 or later/s);
});

test("createUpgradeAgentPlugin_ConfigConflict_Expect_DisposesLifecycleBeforeRegistration", async () => {
  // Arrange
  let configured = false;
  let disposed = false;
  const plugin = await createUpgradeAgentPlugin({
    diagnose: async () => ({ isReady: true, diagnostics: [] }),
    convertAgents: async () => ({
      ...convertedAgents,
      agents: [
        ...convertedAgents.agents,
        {
          ...convertedAgents.agents[0],
          id: "build-validator",
          name: "BuildValidator",
        },
      ],
    }),
    createLifecycle: async () => ({
      config: () => {
        configured = true;
      },
      dispose: async () => {
        disposed = true;
      },
    }),
    warn: () => undefined,
  });
  const config: Config = {
    agent: {
      Upgrade: { prompt: "existing" },
      BuildValidator: { prompt: "existing" },
    },
  };

  // Act
  const action = () => plugin.config!(config);

  // Assert
  await assert.rejects(action, /BuildValidator, Upgrade/);
  assert.equal(configured, false);
  assert.equal(disposed, true);
  assert.equal(config.agent?.TaskExecutor, undefined);
});

test("createUpgradeAgentPlugin_ConversionWarnings_Expect_EmitsOneAggregatedDiagnostic", async () => {
  // Arrange
  const warnings: string[] = [];
  const plugin = await createUpgradeAgentPlugin({
    diagnose: async () => ({ isReady: true, diagnostics: [] }),
    convertAgents: async () => ({
      ...convertedAgents,
      diagnostics: [
        {
          level: "warning",
          file: "upgrade.agent.md",
          property: "metadata",
          message: "Optional frontmatter property was ignored.",
        },
      ],
    }),
    createLifecycle: async () => ({
      config: () => undefined,
      dispose: async () => undefined,
    }),
    warn: (message) => warnings.push(message),
  });

  // Act
  await plugin.config!({});
  await plugin.config!({});

  // Assert
  assert.deepEqual(warnings, [
    "Agent conversion warnings:\n- upgrade.agent.md metadata: Optional frontmatter property was ignored.",
  ]);
});
