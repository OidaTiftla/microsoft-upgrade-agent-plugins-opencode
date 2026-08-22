import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createCoreMcpProcessDefinition,
  parseMcpVersionManifest,
  writeHostDiscoveryFiles,
} from "../src/mcp-process-definitions.ts";

const versionManifest = {
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

test("parseMcpVersionManifest_MissingVersion_Expect_ThrowsException", () => {
  // Arrange
  const manifest = {
    ...versionManifest,
    dotnet: { package: versionManifest.dotnet.package },
  };

  // Act
  const action = () => parseMcpVersionManifest(manifest);

  // Assert
  assert.throws(action, /dotnet.version must be an explicit version/);
});

test("createCoreMcpProcessDefinition_HostDiscovery_Expect_ConfiguredCore", () => {
  // Arrange
  const manifest = parseMcpVersionManifest(versionManifest);

  // Act
  const definition = createCoreMcpProcessDefinition(manifest, {
    hostDir: "/host",
    pluginRoot: "/plugin",
  });

  // Assert
  assert.deepEqual(definition, {
    name: "Upgrade",
    command: "dnx",
    args: [
      "Microsoft.GitHubCopilot.Upgrade.Mcp@1.1.441",
      "--yes",
      "--ignore-failed-sources",
    ],
    env: {
      APPMOD_CALLER_TYPE: "copilot-cli",
      APPMOD_DISABLE_MCP_APPS: "true",
      APPMOD_DISABLE_TELEMETRY: "true",
      APPMOD_HOST_DIR: "/host",
      MODERNIZE_ORCHESTRATOR_PLUGIN_ROOT: "/plugin",
    },
    timeout_ms: 300000,
  });
});

test("writeHostDiscoveryFiles_PinnedExtenders_Expect_DerivedManifests", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "mcp-host-discovery-"));
  const pluginRoot = join(root, "plugins", "upgrade-agent");
  const hostDir = join(root, "host");
  const sourceManifests = [
    ["upgrade-dotnet", "Microsoft.GitHubCopilot.Upgrade.DotNet.Mcp"],
    ["upgrade-typescript", "@microsoft/jsts-upgrade-assistant"],
  ] as const;
  try {
    for (const [id, packageName] of sourceManifests) {
      const path = join(pluginRoot, "extenders", id, "upgrade-extension.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          id,
          mcp: {
            command: id === "upgrade-dotnet" ? "dnx" : "npx",
            args:
              id === "upgrade-dotnet"
                ? [packageName, "--yes", "--ignore-failed-sources"]
                : ["-y", packageName, "--mcp"],
          },
        }),
      );
    }

    // Act
    const files = await writeHostDiscoveryFiles(
      hostDir,
      pluginRoot,
      parseMcpVersionManifest(versionManifest),
    );

    // Assert
    assert.deepEqual(
      JSON.parse(await readFile(files.hostExtendersPath, "utf8")),
      {
        extenders: [
          {
            manifestPath: files.extenders[0].manifestPath,
            skillsRoot: join(
              pluginRoot,
              "extenders",
              "upgrade-dotnet",
              "upgrade",
              "skills",
            ),
          },
          {
            manifestPath: files.extenders[1].manifestPath,
            skillsRoot: join(
              pluginRoot,
              "extenders",
              "upgrade-typescript",
              "upgrade",
              "skills",
            ),
          },
        ],
      },
    );
    assert.equal(
      files.extenders[0].manifestPath,
      join(hostDir, "extenders", "upgrade-dotnet", "upgrade-extension.json"),
    );
    assert.equal(
      files.extenders[1].manifestPath,
      join(
        hostDir,
        "extenders",
        "upgrade-typescript",
        "upgrade-extension.json",
      ),
    );
    assert.equal(
      JSON.parse(await readFile(files.extenders[0].manifestPath, "utf8")).mcp
        .args[0],
      "Microsoft.GitHubCopilot.Upgrade.DotNet.Mcp@1.1.441",
    );
    assert.equal(
      JSON.parse(await readFile(files.extenders[1].manifestPath, "utf8")).mcp
        .args[1],
      "@microsoft/jsts-upgrade-assistant@0.1.6",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
