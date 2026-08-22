import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AgentConversionError,
  convertAgentSource,
  convertBundledAgents,
} from "../src/agent-converter.ts";

const agentDirectory = fileURLToPath(
  new URL("../plugins/upgrade-agent/agents/", import.meta.url),
);

function source(frontmatter: string, body = "# Original body\n"): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

test("convertAgentSource_KnownTools_Expect_LeastPrivilegePermissions", async (t) => {
  for (const [tool, permission] of [
    ["execute", "bash"],
    ["search", "glob"],
    ["web", "webfetch"],
  ] as const) {
    await t.test(tool, () => {
      // Arrange
      const input = source(
        `name: Worker\ndescription: Test\nuser-invocable: false\ntools: [${tool}]`,
      );

      // Act
      const result = convertAgentSource(
        "worker.agent.md",
        input,
        "Compatibility",
      );

      // Assert
      assert.equal(result.agent.permission[permission], "allow");
      assert.equal(result.agent.permission["*"], "deny");
    });
  }
});

test("convertAgentSource_UnknownTool_Expect_ThrowsException", () => {
  // Arrange
  const input = source(
    "name: Worker\ndescription: Test\ntools: [dangerous_tool]",
  );

  // Act
  const action = () =>
    convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  assert.throws(action, AgentConversionError);
  assert.throws(action, /worker.agent.md.*tools.*dangerous_tool/s);
});

test("convertAgentSource_OptionalProperty_Expect_AggregatedWarning", () => {
  // Arrange
  const input = source(
    "name: Worker\ndescription: Test\nmetadata: legacy\ntools: [read]",
  );

  // Act
  const result = convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  assert.deepEqual(result.diagnostics, [
    {
      level: "warning",
      file: "worker.agent.md",
      property: "metadata",
      message: "Optional frontmatter property was ignored.",
    },
  ]);
});

test("convertAgentSource_UnknownProperty_Expect_ThrowsException", () => {
  // Arrange
  const input = source(
    "name: Worker\ndescription: Test\nbehavior: unsafe\ntools: [read]",
  );

  // Act
  const action = () =>
    convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  assert.throws(action, /worker.agent.md.*behavior/s);
});

test("convertBundledAgents_BundledInventory_Expect_ConvertedAgents", async () => {
  // Arrange
  const original = "# Upgrade Agent\n";
  const canonical = await readFile(
    new URL(
      "../plugins/upgrade-agent/agents/upgrade.agent.md",
      import.meta.url,
    ),
    "utf8",
  );
  const compatibility = await readFile(
    new URL("../src/copilot-compatibility-instruction.md", import.meta.url),
    "utf8",
  );

  // Act
  const result = await convertBundledAgents(agentDirectory);

  // Assert
  const upgrade = result.agents.find((agent) => agent.name === "Upgrade");
  assert.equal(result.agents.length, 16);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.agents.find((agent) => agent.name === "Upgrade")?.mode,
    "primary",
  );
  assert.deepEqual(
    result.agents.find((agent) => agent.name === "BuildValidator")?.mode,
    "subagent",
  );
  assert.equal(
    result.agents
      .filter((agent) => agent.name !== "Upgrade")
      .every((agent) => agent.mode === "subagent" && agent.hidden),
    true,
  );
  assert.equal(
    result.agents.find((agent) => agent.name === "BuildValidator")?.hidden,
    true,
  );
  assert.equal(
    result.agents.find((agent) => agent.name === "BreakGlass")?.permission["*"],
    "allow",
  );
  assert.equal(upgrade?.permission["Upgrade_open_dashboard"], "deny");
  assert.equal(upgrade?.permission.open_canvas, "deny");
  assert.equal(upgrade?.permission["*"], "deny");
  assert.equal(upgrade?.permission.task, "allow");
  assert.equal(
    result.agents.find((agent) => agent.name === "BuildValidator")?.permission
      .webfetch,
    undefined,
  );
  assert.equal(upgrade?.system.startsWith(original), true);
  assert.equal(canonical.includes("one long-wait `read_agent`"), true);
  assert.equal(upgrade?.system.endsWith(compatibility), true);
  assert.ok(
    upgrade!.system.indexOf("one long-wait `read_agent`") <
      upgrade!.system.indexOf("This supersedes any preceding background"),
  );
  assert.equal(upgrade?.system.includes("Upgrade_<tool>"), true);
  assert.equal(
    upgrade?.system.includes(
      "Never run Copilot marketplace or install commands.",
    ),
    true,
  );
  assert.equal(
    upgrade?.system.includes("managing-dotnet-test-installation"),
    true,
  );
  assert.equal(
    upgrade?.system.includes("generating-upgrade-test-baseline"),
    true,
  );
  assert.equal(upgrade?.system.includes("Skip/user-decision path"), true);
  assert.equal(
    result.agents.every((agent) =>
      agent.system.includes(
        "task` returns the worker result directly and synchronously. Never call or poll `read_agent`",
      ),
    ),
    true,
  );
});
