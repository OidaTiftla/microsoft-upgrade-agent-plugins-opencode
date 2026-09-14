import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnoseMcpPrerequisites,
  type McpPrerequisite,
  type PrerequisiteCommandRunner,
} from "../src/mcp-prerequisites.ts";

const executableNames: readonly McpPrerequisite[] = [
  "dnx",
  "dotnet",
  "node",
  "npx",
];

function createRunner(
  availableExecutables: readonly McpPrerequisite[],
  dotnetVersion = "10.0.100",
  nodeVersion = "v22.18.0",
): PrerequisiteCommandRunner {
  return {
    isExecutableAvailable: async (executable) =>
      availableExecutables.includes(executable as McpPrerequisite),
    run: async (command) => ({
      succeeded: true,
      stdout: command === "node" ? nodeVersion : dotnetVersion,
    }),
  };
}

test("diagnoseMcpPrerequisites_MissingExecutable_Expect_ActionableDiagnostic", async (t) => {
  for (const executable of executableNames) {
    await t.test(executable, async () => {
      // Arrange
      const runner = createRunner(
        executableNames.filter((name) => name !== executable),
      );

      // Act
      const result = await diagnoseMcpPrerequisites(runner);

      // Assert
      assert.equal(result.isReady, false);
      assert.deepEqual(result.diagnostics, [
        {
          prerequisite: executable,
          status: "missing",
          message: `Required executable "${executable}" was not found on PATH.`,
          remediation:
            executable === "dnx" || executable === "dotnet"
              ? "Install the .NET SDK 10 or later and ensure it is available on PATH."
              : "Install Node.js 22.18.0 or later and ensure node and npx are available on PATH.",
        },
      ]);
    });
  }
});

test("diagnoseMcpPrerequisites_OldNodeRuntime_Expect_ActionableDiagnostic", async () => {
  // Arrange
  const runner = createRunner(executableNames, "10.0.100", "v22.17.1");

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.equal(result.isReady, false);
  assert.deepEqual(result.diagnostics, [
    {
      prerequisite: "node",
      status: "unsupported-version",
      message:
        "Detected Node.js v22.17.1, but version 22.18.0 or later is required.",
      remediation:
        "Install Node.js 22.18.0 or later and ensure node and npx are available on PATH.",
    },
  ]);
});

test("diagnoseMcpPrerequisites_UnreadableNodeRuntime_Expect_ActionableDiagnostic", async () => {
  // Arrange
  const runner = createRunner(executableNames, "10.0.100", "unknown");

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.equal(result.isReady, false);
  assert.deepEqual(result.diagnostics, [
    {
      prerequisite: "node",
      status: "unavailable",
      message: "Could not determine the installed Node.js version.",
      remediation:
        "Install Node.js 22.18.0 or later and ensure node --version succeeds.",
    },
  ]);
});

test("diagnoseMcpPrerequisites_OldDotnetSdk_Expect_ActionableDiagnostic", async () => {
  // Arrange
  const runner = createRunner(executableNames, "9.0.100");

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.equal(result.isReady, false);
  assert.deepEqual(result.diagnostics, [
    {
      prerequisite: "dotnet",
      status: "unsupported-version",
      message:
        "Detected .NET SDK 9.0.100, but version 10 or later is required.",
      remediation:
        "Install the .NET SDK 10 or later. Update global.json roll-forward settings if needed.",
    },
  ]);
});

test("diagnoseMcpPrerequisites_SupportedExecutables_Expect_ReadyResult", async () => {
  // Arrange
  const runner = createRunner(executableNames);

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.deepEqual(result, { isReady: true, diagnostics: [] });
});
