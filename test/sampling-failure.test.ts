import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySamplingError,
  formatSamplingFailure,
  type SamplingFailureCategory,
} from "./fixtures/dynamic-mcp/sampling-failure.ts";

test("classifySamplingError_KnownAdapterMessages_Expect_StableCategories", () => {
  // Arrange
  const failures: ReadonlyArray<readonly [string, SamplingFailureCategory]> = [
    ["Cancelled", "cancelled"],
    ["MCP sampling is denied.", "sampling agent unavailable"],
    [
      "OpenCode sampling assistant failed: AgentError.",
      "sampling agent unavailable",
    ],
    [
      "OpenCode sampling assistant failed: APIError.",
      "sampling model/provider unavailable",
    ],
    [
      "OpenCode sampling output token accounting exceeds MCP limit (11 > 10).",
      "sampling response limit exceeded",
    ],
    [
      "OpenCode sampling output token accounting is unavailable; cannot verify the MCP token limit.",
      "sampling response limit exceeded",
    ],
    [
      "OpenCode SDK session.messages request failed: session not found",
      "sampling session unavailable",
    ],
  ];

  // Act
  const categories = failures.map(([message]) =>
    classifySamplingError(new Error(message)),
  );

  // Assert
  assert.deepEqual(
    categories,
    failures.map(([, category]) => category),
  );
});

test("formatSamplingFailure_SensitiveError_Expect_CategoryOnly", () => {
  // Arrange
  const sensitive = [
    "prompt=private request",
    "token=private-token",
    "Authorization: Bearer private-authorization",
    "headers={private-header}",
    "stack trace=private-stack",
  ];

  // Act
  const output = formatSamplingFailure(
    new Error(`provider error; ${sensitive.join("; ")}`),
  );

  // Assert
  assert.equal(
    output,
    "Sampling request unavailable: sampling model/provider unavailable.",
  );
  for (const value of sensitive) assert.equal(output.includes(value), false);
});
