import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  createCoreMcpProcessDefinition,
  type McpVersionManifest,
  parseMcpVersionManifest,
  writeHostDiscoveryFiles,
} from "../src/mcp-process-definitions.ts";

const versionManifest = JSON.parse(
  await readFile(new URL("../src/mcp-versions.json", import.meta.url), "utf8"),
) as McpVersionManifest;

async function writeExtenderManifest(
  pluginRoot: string,
  id: string,
  packageName: string,
): Promise<void> {
  const isDotnet = id === "upgrade-dotnet";
  const path = join(pluginRoot, "upgrade", id, "upgrade-extension.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      id,
      mcp: {
        command: isDotnet ? "dnx" : "npx",
        args: isDotnet
          ? [packageName, "--yes", "--ignore-failed-sources"]
          : ["-y", packageName, "--mcp"],
      },
    }),
  );
}

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
      `${versionManifest.core!.package}@${versionManifest.core!.version}`,
      "--yes",
      "--ignore-failed-sources",
    ],
    env: {
      APPMOD_CALLER_TYPE: "copilot-cli",
      APPMOD_DISABLE_MCP_APPS: "true",
      APPMOD_DISABLE_TELEMETRY: "true",
      DOTNET_CLI_TELEMETRY_OPTOUT: "true",
      DOTNET_NOLOGO: "true",
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
    await mkdir(join(pluginRoot, "upgrade", "skills"), { recursive: true });
    await Promise.all(
      sourceManifests.map(([id, packageName]) =>
        writeExtenderManifest(pluginRoot, id, packageName),
      ),
    );

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
            skillsRoot: join(pluginRoot, "upgrade", "upgrade-dotnet", "skills"),
          },
          {
            manifestPath: files.extenders[1].manifestPath,
            skillsRoot: join(
              pluginRoot,
              "upgrade",
              "upgrade-typescript",
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
      `${versionManifest.dotnet!.package}@${versionManifest.dotnet!.version}`,
    );
    assert.equal(
      JSON.parse(await readFile(files.extenders[1].manifestPath, "utf8")).mcp
        .args[1],
      `${versionManifest.typescript!.package}@${versionManifest.typescript!.version}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeHostDiscoveryFiles_DiscoveredExtenders_Expect_DeterministicOrder", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "mcp-host-discovery-"));
  const pluginRoot = join(root, "plugins", "upgrade-agent");
  const hostDir = join(root, "host");
  const manifest = parseMcpVersionManifest({
    core: versionManifest.core,
    alpha: { package: "Example.Alpha.Mcp", version: "1.2.3" },
    zeta: { package: "Example.Zeta.Mcp", version: "2.3.4" },
  });
  try {
    await writeExtenderManifest(pluginRoot, "zeta", "Example.Zeta.Mcp");
    await writeExtenderManifest(pluginRoot, "alpha", "Example.Alpha.Mcp");

    // Act
    const files = await writeHostDiscoveryFiles(hostDir, pluginRoot, manifest);

    // Assert
    assert.deepEqual(
      files.extenders.map(({ manifestPath }) =>
        basename(dirname(manifestPath)),
      ),
      ["alpha", "zeta"],
    );
    assert.equal(
      JSON.parse(await readFile(files.extenders[0].manifestPath, "utf8")).mcp
        .args[1],
      "Example.Alpha.Mcp@1.2.3",
    );
    assert.equal(
      JSON.parse(await readFile(files.extenders[1].manifestPath, "utf8")).mcp
        .args[1],
      "Example.Zeta.Mcp@2.3.4",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeHostDiscoveryFiles_UnpinnedExtender_Expect_ThrowsException", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "mcp-host-discovery-"));
  const pluginRoot = join(root, "plugins", "upgrade-agent");
  try {
    await writeExtenderManifest(pluginRoot, "new-extender", "Example.New.Mcp");

    // Act
    const action = () =>
      writeHostDiscoveryFiles(
        join(root, "host"),
        pluginRoot,
        parseMcpVersionManifest({ core: versionManifest.core }),
      );

    // Assert
    await assert.rejects(action, /new-extender.*unpinned MCP package argument/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
