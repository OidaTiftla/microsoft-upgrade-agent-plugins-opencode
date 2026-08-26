import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Config } from "@opencode-ai/plugin";

import {
  convertBundledAgents,
  type ConvertedAgentDefinition,
} from "../src/agent-converter.ts";
import {
  getBundledExternalDirectoryPattern,
  registerConvertedAgents,
} from "../src/agent-registration.ts";

const agentDirectory = fileURLToPath(
  new URL("../plugins/upgrade-agent/agents/", import.meta.url),
);

test("registerConvertedAgents_BundledAgents_Expect_PreservedOpenCodeConfiguration", async () => {
  // Arrange
  const converted = await convertBundledAgents(agentDirectory);
  const compatibility = await readFile(
    new URL("../src/copilot-compatibility-instruction.md", import.meta.url),
    "utf8",
  );
  const config: Config = {
    model: "provider/main",
    small_model: "provider/small",
    agent: { Existing: { prompt: "Existing prompt." } },
  };

  // Act
  registerConvertedAgents(
    config,
    converted.agents,
    "/package/plugins/upgrade-agent",
  );

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
    "Upgrade_open_dashboard",
    "external_directory",
  ]);
  assert.deepEqual(
    (config.agent?.Upgrade?.permission as Record<string, unknown>)
      ?.external_directory,
    { "/package/plugins/upgrade-agent/**": "allow" },
  );
  assert.equal(config.agent?.BuildValidator?.mode, "subagent");
  assert.equal(config.agent?.BuildValidator?.hidden, true);
  assert.equal(config.agent?.BuildValidator?.model, "provider/small");
  for (const agent of converted.agents.filter(
    ({ name }) => name !== "Upgrade",
  )) {
    assert.equal(config.agent?.[agent.name]?.mode, "subagent");
    assert.equal(config.agent?.[agent.name]?.hidden, true);
  }
  assert.equal(
    (config.agent?.Upgrade?.permission as Record<string, string> | undefined)
      ?.task,
    "allow",
  );
  assert.equal(config.agent?.Upgrade?.prompt?.endsWith(compatibility), true);
  assert.equal(config.agent?.Upgrade?.model, undefined);
  assert.equal(config.agent?.TaskExecutor?.model, undefined);
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
  const action = () =>
    registerConvertedAgents(
      config,
      converted.agents,
      "/package/plugins/upgrade-agent",
    );

  // Assert
  assert.throws(action, /BuildValidator, Upgrade/);
  assert.equal(config.agent?.TaskExecutor, undefined);
});

test("getBundledExternalDirectoryPattern_AbsoluteRoots_Expect_NativeSubtreePattern", () => {
  // Arrange
  const roots = [
    [
      "/package/plugins/upgrade-agent/",
      "linux",
      "/package/plugins/upgrade-agent/**",
    ],
    [
      "C:\\package\\plugins\\upgrade-agent",
      "win32",
      "C:\\package\\plugins\\upgrade-agent\\**",
    ],
  ] as const;

  // Act / Assert
  for (const [root, platform, expected] of roots)
    assert.equal(getBundledExternalDirectoryPattern(root, platform), expected);
});

test("getBundledExternalDirectoryPattern_RelativeOrTraversalRoot_Expect_ThrowsException", () => {
  // Arrange
  const roots = [
    "plugins/upgrade-agent",
    "/package/../outside",
    "C:\\package\\..\\outside",
  ];

  // Act / Assert
  for (const root of roots)
    assert.throws(
      () =>
        getBundledExternalDirectoryPattern(
          root,
          root.startsWith("C:") ? "win32" : "linux",
        ),
      /trusted bundled plugin root/,
    );
});

test("registerConvertedAgents_FilesystemPermissions_Expect_ScopedExternalDirectoryOnly", () => {
  // Arrange
  const config: Config = { agent: { Unrelated: { prompt: "unchanged" } } };
  const agents: readonly ConvertedAgentDefinition[] = [
    {
      id: "reader",
      name: "Reader",
      description: "Reads files.",
      hidden: false,
      mode: "primary" as const,
      permission: { "*": "deny" as const, read: "allow" as const },
      system: "Reader prompt.",
    },
    {
      id: "mcp-only",
      name: "McpOnly",
      description: "Uses MCP only.",
      hidden: true,
      mode: "subagent" as const,
      permission: { "*": "deny" as const, Upgrade_get_state: "allow" as const },
      system: "MCP prompt.",
    },
    {
      id: "break-glass",
      name: "BreakGlass",
      description: "Existing wildcard access.",
      hidden: true,
      mode: "subagent" as const,
      permission: { "*": "allow" as const },
      system: "BreakGlass prompt.",
    },
  ];

  // Act
  registerConvertedAgents(config, agents, "/package/plugins/upgrade-agent");

  // Assert
  assert.deepEqual(config.agent?.Unrelated, { prompt: "unchanged" });
  assert.deepEqual(config.agent?.Reader?.permission, {
    "*": "deny",
    read: "allow",
    external_directory: { "/package/plugins/upgrade-agent/**": "allow" },
  });
  assert.deepEqual(config.agent?.McpOnly?.permission, {
    "*": "deny",
    Upgrade_get_state: "allow",
  });
  assert.deepEqual(config.agent?.BreakGlass?.permission, { "*": "allow" });
});
