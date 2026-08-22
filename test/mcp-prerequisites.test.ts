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
  "npm",
  "npx",
];

function createRunner(
  availableExecutables: readonly McpPrerequisite[],
  dotnetVersion = "10.0.100",
): PrerequisiteCommandRunner {
  return {
    isExecutableAvailable: async (executable) =>
      availableExecutables.includes(executable as McpPrerequisite),
    run: async () => ({ succeeded: true, stdout: dotnetVersion }),
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
              : `Install Node.js, including ${executable}, and ensure it is available on PATH.`,
        },
      ]);
    });
  }
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
