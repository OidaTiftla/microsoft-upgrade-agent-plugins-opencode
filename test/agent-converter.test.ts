import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentConversionError,
  convertAgentSource,
} from "../src/agent-converter.ts";

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

test("convertAgentSource_CopilotOnlyProperties_Expect_CompatibleVisibility", () => {
  // Arrange
  const input = source(
    "name: Worker\ndescription: Test\ntarget: github-copilot\ndisable-model-invocation: true\ntools: [read]",
  );

  // Act
  const result = convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  assert.equal(result.agent.hidden, true);
  assert.equal(result.agent.mode, "subagent");
  assert.deepEqual(result.diagnostics, []);
});

test("convertAgentSource_InvalidCopilotOnlyProperty_Expect_ThrowsException", () => {
  // Arrange
  const input = source(
    "name: Worker\ndescription: Test\ndisable-model-invocation: no\ntools: [read]",
  );

  // Act
  const action = () =>
    convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  assert.throws(action, /disable-model-invocation.*boolean/s);
});

test("convertAgentSource_DeclaredWorkers_Expect_Accepted", () => {
  // Arrange
  const input = source(
    "name: Worker\ndescription: Test\nagents: [Child]\ntools: [agent]",
  );

  // Act
  const result = convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  assert.equal(result.agent.permission.task, "allow");
});

test("convertAgentSource_JstsMcpTools_Expect_UpgradePermissions", () => {
  // Arrange
  const tools = [
    "typescript_compile_package",
    "typescript_install_dependencies",
    "typescript_prepare_browser_recording",
    "typescript_report_dependabot_validation",
    "typescript_validate_runtime",
  ];
  const input = source(
    `name: Worker\ndescription: Test\ntools: [${tools.map((tool) => `JSTSUpgradeAssistant/${tool}`).join(", ")}]`,
  );

  // Act
  const result = convertAgentSource("worker.agent.md", input, "Compatibility");

  // Assert
  for (const tool of tools)
    assert.equal(result.agent.permission[`Upgrade_${tool}`], "allow");
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
