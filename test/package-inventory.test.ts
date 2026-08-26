import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  getRuntimeAssetPaths,
  validatePackageInventory,
} from "../scripts/package-inventory.ts";

test("getRuntimeAssetPaths_RuntimeSources_Expect_AllRequiredAssets", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "package-inventory-"));
  try {
    for (const path of [
      "src/index.ts",
      "plugins/upgrade-agent/agents/upgrade.agent.md",
      "plugins/upgrade-agent/upgrade/skills/system/generate-report/SKILL.md",
      "plugins/upgrade-agent/extenders/example/upgrade-extension.json",
      "plugins/upgrade-agent/extenders/example/upgrade/skills/scenario/SKILL.md",
      "plugins/upgrade-agent/extenders/example/upgrade/skills/scenario/ref.md",
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "source");
    }

    // Act
    const paths = await getRuntimeAssetPaths(root);

    // Assert
    assert.deepEqual(paths, [
      "plugins/upgrade-agent/agents/upgrade.agent.md",
      "plugins/upgrade-agent/extenders/example/upgrade-extension.json",
      "plugins/upgrade-agent/extenders/example/upgrade/skills/scenario/SKILL.md",
      "plugins/upgrade-agent/extenders/example/upgrade/skills/scenario/ref.md",
      "plugins/upgrade-agent/upgrade/skills/system/generate-report/SKILL.md",
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
