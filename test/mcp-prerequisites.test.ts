import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnoseMcpPrerequisites,
  type McpPrerequisite,
  type PrerequisiteCommandRunner,
} from "../src/mcp-prerequisites.ts";
import {
  DOTNET_MINIMUM_MAJOR,
  DOTNET_VERSION,
  DOTNET_VERSION_REQUIREMENT,
} from "../src/dotnet-version.ts";
import { NODE_VERSION, NODE_VERSION_REQUIREMENT } from "../src/node-version.ts";

const executableNames: readonly McpPrerequisite[] = [
  "dnx",
  "dotnet",
  "node",
  "npx",
];

function createRunner(
  availableExecutables: readonly McpPrerequisite[],
  dotnetVersion = DOTNET_VERSION,
  nodeVersion = `v${NODE_VERSION}`,
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
              ? `Install the .NET SDK ${DOTNET_VERSION_REQUIREMENT} and ensure it is available on PATH.`
              : `Install Node.js ${NODE_VERSION_REQUIREMENT} and ensure node and npx are available on PATH.`,
        },
      ]);
    });
  }
});

test("diagnoseMcpPrerequisites_OldNodeRuntime_Expect_ActionableDiagnostic", async () => {
  // Arrange
  const runner = createRunner(executableNames, DOTNET_VERSION, "v22.17.1");

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.equal(result.isReady, false);
  assert.deepEqual(result.diagnostics, [
    {
      prerequisite: "node",
      status: "unsupported-version",
      message: `Detected Node.js v22.17.1, but version ${NODE_VERSION_REQUIREMENT} is required.`,
      remediation: `Install Node.js ${NODE_VERSION_REQUIREMENT} and ensure node and npx are available on PATH.`,
    },
  ]);
});

test("diagnoseMcpPrerequisites_CurrentNodeMajor_Expect_ReadyResult", async () => {
  // Arrange
  const runner = createRunner(executableNames, DOTNET_VERSION, "v24.19.0");

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.deepEqual(result, { isReady: true, diagnostics: [] });
});

test("diagnoseMcpPrerequisites_UnreadableNodeRuntime_Expect_ActionableDiagnostic", async () => {
  // Arrange
  const runner = createRunner(executableNames, DOTNET_VERSION, "unknown");

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.equal(result.isReady, false);
  assert.deepEqual(result.diagnostics, [
    {
      prerequisite: "node",
      status: "unavailable",
      message: "Could not determine the installed Node.js version.",
      remediation: `Install Node.js ${NODE_VERSION_REQUIREMENT} and ensure node --version succeeds.`,
    },
  ]);
});

test("diagnoseMcpPrerequisites_OldDotnetSdk_Expect_ActionableDiagnostic", async () => {
  // Arrange
  const oldDotnetVersion = `${DOTNET_MINIMUM_MAJOR - 1}.0.100`;
  const runner = createRunner(executableNames, oldDotnetVersion);

  // Act
  const result = await diagnoseMcpPrerequisites(runner);

  // Assert
  assert.equal(result.isReady, false);
  assert.deepEqual(result.diagnostics, [
    {
      prerequisite: "dotnet",
      status: "unsupported-version",
      message: `Detected .NET SDK ${oldDotnetVersion}, but version ${DOTNET_VERSION_REQUIREMENT} is required.`,
      remediation: `Install the .NET SDK ${DOTNET_VERSION_REQUIREMENT}. Update global.json roll-forward settings if needed.`,
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
