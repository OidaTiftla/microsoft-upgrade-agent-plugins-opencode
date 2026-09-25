import assert from "node:assert/strict";
import test from "node:test";

import { createNpmCommand } from "../scripts/npm-command.ts";

test("createNpmCommand_NpmCliPathAvailable_Expect_CurrentNodeExecutesIt", () => {
  // Arrange
  const npmArguments = ["pack", "--dry-run"];
  const npmExecPath =
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";

  // Act
  const command = createNpmCommand(npmArguments, npmExecPath, "win32");

  // Assert
  assert.deepEqual(command, {
    command: process.execPath,
    args: [npmExecPath, ...npmArguments],
  });
});

test("createNpmCommand_NpmCliPathMissingOnWindows_Expect_DefaultCommandProcessorInvokesNpmCmd", () => {
  // Arrange
  const npmArguments = ["pack", "--dry-run"];

  // Act
  const command = createNpmCommand(npmArguments, "", "win32", "");

  // Assert
  assert.deepEqual(command, {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...npmArguments],
  });
});

test("createNpmCommand_NpmCliPathMissingOnUnix_Expect_NpmExecutable", () => {
  // Arrange
  const npmArguments = ["pack", "--dry-run"];

  // Act
  const command = createNpmCommand(npmArguments, "", "linux");

  // Assert
  assert.deepEqual(command, { command: "npm", args: npmArguments });
});
