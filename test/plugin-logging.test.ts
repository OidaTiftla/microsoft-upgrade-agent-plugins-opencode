import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  createPluginLogger,
  formatPluginError,
  forwardProcessStderr,
  LoggedMcpTransport,
  SAFE_PLUGIN_ERROR_MESSAGES,
  SafePluginError,
} from "../src/plugin-logging.ts";
import { withSensitiveLogging } from "./sensitive-logging.ts";

test("createPluginLogger_Diagnostic_Expect_WritesToOpenCodeLog", async () => {
  // Arrange
  const calls: unknown[] = [];
  const client = {
    app: {
      log: async (input: unknown) => {
        calls.push(input);
      },
    },
  } as unknown as PluginInput["client"];

  // Act
  createPluginLogger(client)("error", "process failed");
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Assert
  assert.deepEqual(calls, [
    {
      body: {
        level: "error",
        message: "process failed",
        service: "opencode-microsoft-upgrade-agent",
      },
    },
  ]);
});

test("createPluginLogger_Info_Expect_WritesLifecycleStateWithoutOptIn", () => {
  // Arrange
  const calls: unknown[] = [];
  const client = {
    app: {
      log: async (input: unknown) => {
        calls.push(input);
      },
    },
  } as unknown as PluginInput["client"];
  // Act
  createPluginLogger(client)("info", "module invoked");

  // Assert
  assert.deepEqual(calls, [
    {
      body: {
        level: "info",
        message: "module invoked",
        service: "opencode-microsoft-upgrade-agent",
      },
    },
  ]);
});

test("forwardProcessStderr_MultilineAndPartialOutput_Expect_LogsAllLines", async () => {
  await withSensitiveLogging(true, async () => {
    // Arrange
    const stderr = new PassThrough();
    const logs: string[] = [];
    forwardProcessStderr(stderr, "Core", (_level, message) =>
      logs.push(message),
    );

    // Act
    stderr.write("failure\nstack");
    stderr.end(" trace");
    await new Promise<void>((resolve) => stderr.once("end", resolve));

    // Assert
    assert.deepEqual(logs, [
      "Core stderr: failure",
      "Core stderr: stack trace",
    ]);
  });
});

test("forwardProcessStderr_WithoutOptIn_Expect_OnlyGenericFailure", async () => {
  await withSensitiveLogging(false, async () => {
    // Arrange
    const stderr = new PassThrough();
    const logs: string[] = [];
    forwardProcessStderr(stderr, "Core", (_level, message) =>
      logs.push(message),
    );

    // Act
    stderr.end("secret\nsecond secret\n");
    await new Promise<void>((resolve) => stderr.once("end", resolve));

    // Assert
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Core stderr output suppressed/);
    assert.doesNotMatch(logs[0], /secret/);
  });
});

test("formatPluginError_OptIn_Expect_RedactsByDefaultAndRevealsStackOnOptIn", async () => {
  // Arrange
  const error = new Error("secret error detail");

  // Act
  const redacted = await withSensitiveLogging(false, () =>
    formatPluginError(error),
  );
  const detailed = await withSensitiveLogging(true, () =>
    formatPluginError(error),
  );

  // Assert
  assert.match(redacted, /details withheld/);
  assert.doesNotMatch(redacted, /secret error detail/);
  assert.match(detailed, /Error: secret error detail/);
});

test("formatPluginError_KnownPluginFailure_Expect_SafeMessageWithoutOptIn", async () => {
  await withSensitiveLogging(false, () => {
    // Arrange
    const known = new SafePluginError("mcpConflict");
    known.message = "private content";
    const forged = new Error(SAFE_PLUGIN_ERROR_MESSAGES.mcpConflict);

    // Act
    const classified = formatPluginError(known);
    const unclassified = formatPluginError(forged);

    // Assert
    assert.equal(classified, 'MCP key "Upgrade" is already configured.');
    assert.match(unclassified, /details withheld/);
    assert.doesNotMatch(classified, /private content/);
  });
});

test("formatPluginError_EachKnownCode_Expect_FixedMessageWithoutOptIn", async () => {
  await withSensitiveLogging(false, () => {
    // Arrange
    const entries = Object.entries(SAFE_PLUGIN_ERROR_MESSAGES) as [
      keyof typeof SAFE_PLUGIN_ERROR_MESSAGES,
      string,
    ][];

    // Act
    const messages = entries.map(([code]) =>
      formatPluginError(new SafePluginError(code)),
    );

    // Assert
    assert.deepEqual(
      messages,
      entries.map(([, message]) => message),
    );
  });
});

test("createPluginLogger_WithoutOptIn_Expect_SeverityIndependentFromSensitivity", async () => {
  await withSensitiveLogging(false, () => {
    // Arrange
    const calls: unknown[] = [];
    const client = {
      app: {
        log: async (input: unknown) => {
          calls.push(input);
        },
      },
    } as unknown as PluginInput["client"];
    const log = createPluginLogger(client);

    // Act
    for (const level of ["debug", "info", "warn", "error"] as const) {
      log(level, `${level} safe`);
      log(level, `${level} secret`, { sensitive: true });
    }

    // Assert
    assert.deepEqual(
      calls,
      (["debug", "info", "warn", "error"] as const).map((level) => ({
        body: {
          level,
          message: `${level} safe`,
          service: "opencode-microsoft-upgrade-agent",
        },
      })),
    );
  });
});

test("createPluginLogger_WithOptIn_Expect_LogsSensitiveRecordsAtOriginalSeverity", async () => {
  await withSensitiveLogging(true, () => {
    // Arrange
    const calls: unknown[] = [];
    const client = {
      app: {
        log: async (input: unknown) => {
          calls.push(input);
        },
      },
    } as unknown as PluginInput["client"];
    const log = createPluginLogger(client);

    // Act
    log("debug", "raw protocol", { sensitive: true });
    log("warn", "raw warning", { sensitive: true });

    // Assert
    assert.deepEqual(calls, [
      {
        body: {
          level: "debug",
          message: "raw protocol",
          service: "opencode-microsoft-upgrade-agent",
        },
      },
      {
        body: {
          level: "warn",
          message: "raw warning",
          service: "opencode-microsoft-upgrade-agent",
        },
      },
    ]);
  });
});

test("LoggedMcpTransport_IncomingStdoutAndError_Expect_PreservesProtocol", async () => {
  await withSensitiveLogging(true, async () => {
    // Arrange
    const logs: string[] = [];
    const underlying: Transport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => undefined,
    };
    const transport = new LoggedMcpTransport(
      underlying,
      "Core",
      "incoming",
      (_level, message) => logs.push(message),
    );
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    const message = { jsonrpc: "2.0" as const, method: "ping" as const };

    // Act
    underlying.onmessage?.(message);
    underlying.onerror?.(new Error("broken pipe"));

    // Assert
    assert.deepEqual(received, [message]);
    assert.match(logs[0], /Core stdout:.*ping/);
    assert.match(logs[1], /Core: Error: broken pipe/);
  });
});

test("LoggedMcpTransport_OutgoingStdout_Expect_LogsWithoutModifyingMessage", async () => {
  await withSensitiveLogging(true, async () => {
    // Arrange
    const logs: string[] = [];
    const sent: unknown[] = [];
    const underlying: Transport = {
      start: async () => undefined,
      send: async (message) => {
        sent.push(message);
      },
      close: async () => undefined,
    };
    const transport = new LoggedMcpTransport(
      underlying,
      "Proxy",
      "outgoing",
      (_level, message) => logs.push(message),
    );
    const message = { jsonrpc: "2.0" as const, method: "ping" as const };

    // Act
    await transport.start();
    await transport.send(message);

    // Assert
    assert.deepEqual(sent, [message]);
    assert.match(logs[0], /Proxy stdout:.*ping/);
  });
});

test("LoggedMcpTransport_WithoutOptIn_Expect_ProtocolWithoutPayloadLogs", async () => {
  await withSensitiveLogging(false, async () => {
    // Arrange
    const logs: string[] = [];
    const sent: unknown[] = [];
    const underlying: Transport = {
      start: async () => undefined,
      send: async (message) => {
        sent.push(message);
      },
      close: async () => undefined,
    };
    const transport = new LoggedMcpTransport(
      underlying,
      "Proxy",
      "outgoing",
      (_level, message) => logs.push(message),
    );
    const message = { jsonrpc: "2.0" as const, method: "secret" as const };

    // Act
    await transport.start();
    await transport.send(message);

    // Assert
    assert.deepEqual(sent, [message]);
    assert.deepEqual(logs, []);
  });
});
