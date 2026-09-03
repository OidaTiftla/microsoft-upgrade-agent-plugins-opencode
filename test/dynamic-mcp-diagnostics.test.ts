import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatHelloMcpFailureDiagnostic,
  formatHelloMcpStartupDiagnostic,
  getHelloMcpRuntimeIdentity,
  MAX_HELLO_MCP_DIAGNOSTIC_BYTES,
  MAX_HELLO_MCP_DIAGNOSTIC_ENTRY_LENGTH,
  readFinalHelloMcpDiagnostic,
  readFinalHelloMcpDiagnosticWithRetry,
} from "./fixtures/dynamic-mcp/hello-mcp-diagnostics.ts";

test("formatHelloMcpStartupDiagnostic_RuntimeDetails_Expect_SingleLine", () => {
  // Arrange
  const details = {
    runtime: "node v24.0.0",
    cwd: "/worktree",
    executable: "/usr/bin/node",
  };

  // Act
  const result = formatHelloMcpStartupDiagnostic(details);

  // Assert
  assert.equal(
    result,
    "[hello-mcp] startup runtime=node v24.0.0 cwd=/worktree executable=/usr/bin/node",
  );
});

test("formatHelloMcpFailureDiagnostic_Error_Expect_CompactDetails", () => {
  // Arrange
  const error = new Error("connection failed");

  // Act
  const result = formatHelloMcpFailureDiagnostic("uncaughtException", error);

  // Assert
  assert.match(
    result,
    /^\[hello-mcp\] uncaughtException: Error: connection failed/,
  );
  assert.equal(result.includes("\n"), false);
});

test("getHelloMcpRuntimeIdentity_Process_Expect_RuntimeAndExecutable", () => {
  // Arrange
  const expected = {
    runtime: `${process.release?.name ?? "unknown"} ${process.version}`,
    executable: process.execPath,
  };

  // Act
  const result = getHelloMcpRuntimeIdentity();

  // Assert
  assert.deepEqual(result, expected);
});

test("readFinalHelloMcpDiagnostic_LargeFile_Expect_BoundedFinalEntry", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "hello-mcp-diagnostics-"));
  const path = join(root, "diagnostics.log");
  try {
    const finalEntry = "y".repeat(MAX_HELLO_MCP_DIAGNOSTIC_ENTRY_LENGTH + 1);
    await writeFile(
      path,
      `${"x".repeat(MAX_HELLO_MCP_DIAGNOSTIC_BYTES)}\n${finalEntry}`,
    );

    // Act
    const result = await readFinalHelloMcpDiagnostic(path);

    // Assert
    assert.equal(
      result,
      `${"y".repeat(MAX_HELLO_MCP_DIAGNOSTIC_ENTRY_LENGTH)}…`,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("readFinalHelloMcpDiagnosticWithRetry_DelayedFile_Expect_FinalEntry", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "hello-mcp-diagnostics-"));
  const path = join(root, "diagnostics.log");
  try {
    const write = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(path, "[hello-mcp] uncaughtException: delayed\n").then(
          resolve,
          reject,
        );
      }, 1);
    });

    // Act
    const result = await readFinalHelloMcpDiagnosticWithRetry(path);
    await write;

    // Assert
    assert.equal(result, "[hello-mcp] uncaughtException: delayed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
