import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  getRuntimeAssetPaths,
  validatePackageInventory,
} from "../scripts/package-inventory.ts";
import { DOTNET_VERSION } from "../src/dotnet-version.ts";
import { NODE_VERSION } from "../src/node-version.ts";

test("nodeVersionDeclarations_RuntimeRequirement_Expect_Synchronized", async () => {
  // Arrange
  const packagePath = new URL("../package.json", import.meta.url);
  const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

  // Act
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const workflow = parse(await readFile(workflowPath, "utf8")) as {
    env: { NODE_VERSION: string };
    jobs: Record<
      string,
      {
        steps: readonly { uses?: string; with?: { "node-version"?: string } }[];
      }
    >;
  };

  // Assert
  assert.equal(packageJson.engines.node, `>=${NODE_VERSION}`);
  assert.equal(workflow.env.NODE_VERSION, NODE_VERSION);
  for (const job of Object.values(workflow.jobs)) {
    const setupNode = job.steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    assert.equal(setupNode?.with?.["node-version"], "${{ env.NODE_VERSION }}");
  }
});

test("dotnetVersionDeclarations_RuntimeRequirement_Expect_Synchronized", async () => {
  // Arrange
  const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

  // Act
  const workflow = parse(await readFile(workflowPath, "utf8")) as {
    env: { DOTNET_VERSION: string };
    jobs: Record<
      string,
      {
        steps: readonly {
          uses?: string;
          with?: { "dotnet-version"?: string };
        }[];
      }
    >;
  };
  const setupDotnetSteps = Object.values(workflow.jobs).flatMap(({ steps }) =>
    steps.filter((step) => step.uses?.startsWith("actions/setup-dotnet@")),
  );

  // Assert
  assert.equal(workflow.env.DOTNET_VERSION, DOTNET_VERSION);
  assert.equal(setupDotnetSteps.length, 2);
  for (const setupDotnet of setupDotnetSteps) {
    assert.equal(
      setupDotnet.with?.["dotnet-version"],
      "${{ env.DOTNET_VERSION }}",
    );
  }
});

test("getRuntimeAssetPaths_RuntimeSources_Expect_AllRequiredAssets", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "package-inventory-"));
  try {
    for (const path of [
      "src/index.ts",
      "src/mcp-versions/obj/generated.cs",
      "plugins/upgrade-agent/agents/upgrade.agent.md",
      "plugins/upgrade-agent/upgrade/skills/system/post-scenario-completion/SKILL.md",
      "plugins/upgrade-agent/upgrade/example/upgrade-extension.json",
      "plugins/upgrade-agent/upgrade/example/skills/scenario/SKILL.md",
      "plugins/upgrade-agent/upgrade/example/skills/scenario/ref.md",
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "source");
    }

    // Act
    const paths = await getRuntimeAssetPaths(root);

    // Assert
    assert.deepEqual(paths, [
      "plugins/upgrade-agent/agents/upgrade.agent.md",
      "plugins/upgrade-agent/upgrade/example/skills/scenario/SKILL.md",
      "plugins/upgrade-agent/upgrade/example/skills/scenario/ref.md",
      "plugins/upgrade-agent/upgrade/example/upgrade-extension.json",
      "plugins/upgrade-agent/upgrade/skills/system/post-scenario-completion/SKILL.md",
      "src/index.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validatePackageInventory_MissingRuntimeAsset_Expect_ThrowsException", () => {
  // Arrange
  const runtimeAssets = ["plugins/upgrade-agent/agents/upgrade.agent.md"];

  // Act
  const action = () => validatePackageInventory(runtimeAssets, []);

  // Assert
  assert.throws(action, /npm pack omitted.*upgrade.agent.md/s);
});

test("validatePackageInventory_NonRuntimeAsset_Expect_ThrowsException", () => {
  // Arrange
  const runtimeAssets = ["src/index.ts"];

  // Act
  const action = () =>
    validatePackageInventory(runtimeAssets, [
      "src/index.ts",
      "test/index.test.ts",
    ]);

  // Assert
  assert.throws(
    action,
    /npm pack included non-runtime assets.*test\/index.test.ts/s,
  );
});
