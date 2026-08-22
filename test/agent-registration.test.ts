import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Config } from "@opencode-ai/plugin";

import { convertBundledAgents } from "../src/agent-converter.ts";
import {
  formatConversionWarnings,
  registerConvertedAgents,
} from "../src/agent-registration.ts";

const agentDirectory = fileURLToPath(
  new URL("../plugins/upgrade-agent/agents/", import.meta.url),
);

test("registerConvertedAgents_BundledAgents_Expect_PreservedOpenCodeConfiguration", async () => {
  // Arrange
  const converted = await convertBundledAgents(agentDirectory);
  const config: Config = {
    model: "provider/main",
    small_model: "provider/small",
    agent: { Existing: { prompt: "Existing prompt." } },
  };

  // Act
  registerConvertedAgents(config, converted.agents);

  // Assert
  assert.equal(Object.keys(config.agent ?? {}).length, 17);
  assert.deepEqual(
    Object.keys(config.agent ?? {})
      .filter((name) => name !== "Existing")
      .sort(),
    converted.agents.map(({ name }) => name).sort(),
  );
  assert.equal(config.agent?.Existing?.prompt, "Existing prompt.");
  assert.equal(
    config.agent?.Upgrade?.prompt?.startsWith("# Upgrade Agent"),
    true,
  );
  assert.equal(
    config.agent?.Upgrade?.prompt?.includes(
      "Never run Copilot marketplace or install commands.",
    ),
    true,
  );
  assert.equal(
    (config.agent?.Upgrade?.permission as Record<string, string> | undefined)
      ?.Upgrade_open_dashboard,
    "deny",
  );
  const upgradePermissions = Object.keys(
    config.agent?.Upgrade?.permission ?? {},
  );
  assert.equal(upgradePermissions[0], "*");
  assert.deepEqual(upgradePermissions.slice(-2), [
    "open_canvas",
    "Upgrade_open_dashboard",
  ]);
  assert.equal(config.agent?.BuildValidator?.mode, "subagent");
  assert.equal(config.agent?.BuildValidator?.hidden, true);
  assert.equal(config.agent?.BuildValidator?.model, "provider/small");
  assert.equal(config.agent?.Upgrade?.model, undefined);
  assert.equal(config.agent?.TaskExecutor?.model, undefined);
});

test("registerConvertedAgents_NoSmallModel_Expect_WorkersInheritModel", async () => {
  // Arrange
  const converted = await convertBundledAgents(agentDirectory);
  const config: Config = { model: "provider/main" };

  // Act
  registerConvertedAgents(config, converted.agents);

  // Assert
  assert.equal(config.agent?.BuildValidator?.model, undefined);
});

test("registerConvertedAgents_ConflictingNames_Expect_ThrowsException", async () => {
  // Arrange
  const converted = await convertBundledAgents(agentDirectory);
  const config: Config = {
    agent: {
      Upgrade: { prompt: "existing" },
      BuildValidator: { prompt: "existing" },
    },
  };

  // Act
  const action = () => registerConvertedAgents(config, converted.agents);

  // Assert
  assert.throws(action, /BuildValidator, Upgrade/);
  assert.equal(config.agent?.TaskExecutor, undefined);
});

test("formatConversionWarnings_MultipleWarnings_Expect_SingleDiagnostic", () => {
  // Arrange
  const warnings = [
    {
      level: "warning" as const,
      file: "a.agent.md",
      property: "metadata",
      message: "Ignored.",
    },
    {
      level: "warning" as const,
      file: "b.agent.md",
      property: "tags",
      message: "Ignored.",
    },
  ];

  // Act
  const message = formatConversionWarnings(warnings);

  // Assert
  assert.equal(
    message,
    "Agent conversion warnings:\n- a.agent.md metadata: Ignored.\n- b.agent.md tags: Ignored.",
  );
});
