import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";

import {
  createLazyMcpPlugin,
  HELLO_MCP_NAME,
  HELLO_MCP_QUALIFIED_TOOL_NAME,
  HELLO_MCP_SERVER_PATH,
} from "./fixtures/dynamic-mcp/lazy-mcp-plugin-core.ts";
import {
  getHelloMcpDiagnosticsPath,
  HELLO_MCP_DIAGNOSTICS_ENV,
  HELLO_MCP_DIAGNOSTIC_RETRY_DELAY_MS,
} from "./fixtures/dynamic-mcp/hello-mcp-diagnostics.ts";
import {
  resolveHelloMcpRuntime,
  type HelloMcpRuntimeProbe,
} from "./fixtures/dynamic-mcp/hello-mcp-runtime.ts";
import { HELLO_MCP_TOOL } from "./fixtures/dynamic-mcp/hello-mcp-tool.ts";

const EXPECTED_ENABLE_DESCRIPTION = `Enable the local Hello MCP server; after enabling, invoke ${HELLO_MCP_QUALIFIED_TOOL_NAME} directly; no new chat or tool-list refresh is required.`;
const EXPECTED_ENABLE_RESULT = `Hello MCP enabled; status=connected; available tool: ${HELLO_MCP_QUALIFIED_TOOL_NAME} — ${HELLO_MCP_TOOL.description}; invoke ${HELLO_MCP_QUALIFIED_TOOL_NAME} directly; no new chat or tool-list refresh is required.`;
const HELLO_MCP_STATUS_CASES = [
  {
    name: "Missing",
    entry: undefined,
    statusResult: "Hello MCP status=not registered.",
    listResult: "Hello MCP tools unavailable; status=not registered.",
  },
  {
    name: "Connected",
    entry: { status: "connected" },
    statusResult: `Hello MCP status=connected; available tool: ${HELLO_MCP_QUALIFIED_TOOL_NAME} — ${HELLO_MCP_TOOL.description}; invoke ${HELLO_MCP_QUALIFIED_TOOL_NAME} directly; no new chat or tool-list refresh is required.`,
    listResult: `Hello MCP tools; status=connected; available tool: ${HELLO_MCP_QUALIFIED_TOOL_NAME} — ${HELLO_MCP_TOOL.description}; invoke ${HELLO_MCP_QUALIFIED_TOOL_NAME} directly; no new chat or tool-list refresh is required.`,
  },
  {
    name: "Disabled",
    entry: { status: "disabled" },
    statusResult: "Hello MCP status=disabled.",
    listResult: "Hello MCP tools unavailable; status=disabled.",
  },
  {
    name: "Failed",
    entry: { status: "failed", error: "MCP process failed to start" },
    statusResult: "Hello MCP status=failed; error=MCP process failed to start.",
    listResult:
      "Hello MCP tools unavailable; status=failed; error=MCP process failed to start.",
  },
] as const;

interface McpCalls {
  readonly add: unknown[];
  readonly connect: unknown[];
  readonly disconnect: unknown[];
  readonly status: unknown[];
}

function createClient(input: {
  readonly add?: (request: unknown) => Promise<unknown>;
  readonly connect?: (request: unknown) => Promise<unknown>;
  readonly disconnect?: (request: unknown) => Promise<unknown>;
  readonly status?: (request: unknown) => Promise<unknown>;
}): { readonly calls: McpCalls; readonly client: PluginInput["client"] } {
  const calls: McpCalls = { add: [], connect: [], disconnect: [], status: [] };
  return {
    calls,
    client: {
      mcp: {
        add: async (request: unknown) => {
          calls.add.push(request);
          return (
            (await input.add?.(request)) ?? {
              data: { [HELLO_MCP_NAME]: { status: "connected" } },
            }
          );
        },
        connect: async (request: unknown) => {
          calls.connect.push(request);
          return (await input.connect?.(request)) ?? { data: true };
        },
        disconnect: async (request: unknown) => {
          calls.disconnect.push(request);
          return (await input.disconnect?.(request)) ?? { data: true };
        },
        status: async (request: unknown) => {
          calls.status.push(request);
          return (await input.status?.(request)) ?? { data: {} };
        },
      },
    } as PluginInput["client"],
  };
}

function getTools(
  client: PluginInput["client"],
  serverPath?: string,
  diagnosticsPath?: string,
  runtimeProbe?: HelloMcpRuntimeProbe,
) {
  const tools = createLazyMcpPlugin(
    client,
    serverPath,
    diagnosticsPath,
    runtimeProbe,
  ).tool;
  if (tools === undefined)
    throw new Error("Lazy MCP plugin did not register tools.");
  return tools;
}

test("createLazyMcpPlugin_Startup_Expect_NoMcpCall", () => {
  // Arrange
  const { calls, client } = createClient({});
  let probeCalls = 0;

  // Act
  const tools = getTools(client, undefined, undefined, async () => {
    probeCalls += 1;
    return false;
  });

  // Assert
  assert.equal(probeCalls, 0);
  assert.deepEqual(calls, { add: [], connect: [], disconnect: [], status: [] });
  assert.deepEqual(Object.keys(tools).sort(), [
    "disable_hello_mcp",
    "enable_hello_mcp",
    "get_hello_mcp_status",
    "list_hello_mcp_tools",
  ]);
});

test("resolveHelloMcpRuntime_BunAvailable_Expect_Bun", async () => {
  // Arrange
  const probedCommands: string[] = [];
  const probe: HelloMcpRuntimeProbe = async (command) => {
    probedCommands.push(command);
    return true;
  };

  // Act
  const result = await resolveHelloMcpRuntime(probe);

  // Assert
  assert.equal(result, "bun");
  assert.deepEqual(probedCommands, ["bun"]);
});

test("resolveHelloMcpRuntime_BunMissing_Expect_Node", async () => {
  // Arrange
  const probe: HelloMcpRuntimeProbe = async () => false;

  // Act
  const result = await resolveHelloMcpRuntime(probe);

  // Assert
  assert.equal(result, "node");
});

test("resolveHelloMcpRuntime_BunProbeFails_Expect_Node", async () => {
  // Arrange
  const probe: HelloMcpRuntimeProbe = async () => {
    throw new Error("bun probe failed");
  };

  // Act
  const result = await resolveHelloMcpRuntime(probe);

  // Assert
  assert.equal(result, "node");
});

test("enableHelloMcp_Request_Expect_LocalRuntimeServerConfig", async () => {
  // Arrange
  const { calls, client } = createClient({});
  const tools = getTools(client, undefined, undefined, async () => false);

  // Act
  const result = await tools.enable_hello_mcp.execute({}, {} as never);

  // Assert
  assert.equal(result, EXPECTED_ENABLE_RESULT);
  assert.equal(tools.enable_hello_mcp.description, EXPECTED_ENABLE_DESCRIPTION);
  assert.deepEqual(calls.add, [
    {
      body: {
        config: {
          command: ["node", HELLO_MCP_SERVER_PATH],
          environment: {
            [HELLO_MCP_DIAGNOSTICS_ENV]: getHelloMcpDiagnosticsPath(),
          },
          type: "local",
        },
        name: HELLO_MCP_NAME,
      },
      throwOnError: true,
    },
  ]);
});

for (const statusCase of HELLO_MCP_STATUS_CASES) {
  test(`getHelloMcpStatus_${statusCase.name}_Expect_ConciseStatusWithoutLifecycleCalls`, async () => {
    // Arrange
    const { calls, client } = createClient({
      status: async () => ({
        data:
          statusCase.entry === undefined
            ? {}
            : { [HELLO_MCP_NAME]: statusCase.entry },
      }),
    });
    const tools = getTools(client);

    // Act
    const result = await tools.get_hello_mcp_status.execute({}, {} as never);

    // Assert
    assert.equal(result, statusCase.statusResult);
    assert.deepEqual(calls.status, [{ throwOnError: true }]);
    assert.deepEqual(calls.add, []);
    assert.deepEqual(calls.connect, []);
    assert.deepEqual(calls.disconnect, []);
  });
}

for (const statusCase of HELLO_MCP_STATUS_CASES) {
  test(`listHelloMcpTools_${statusCase.name}_Expect_StatusWithoutLifecycleCalls`, async () => {
    // Arrange
    const { calls, client } = createClient({
      status: async () => ({
        data:
          statusCase.entry === undefined
            ? {}
            : { [HELLO_MCP_NAME]: statusCase.entry },
      }),
    });
    const tools = getTools(client);

    // Act
    const result = await tools.list_hello_mcp_tools.execute({}, {} as never);

    // Assert
    assert.equal(result, statusCase.listResult);
    assert.deepEqual(calls.status, [{ throwOnError: true }]);
    assert.deepEqual(calls.add, []);
    assert.deepEqual(calls.connect, []);
    assert.deepEqual(calls.disconnect, []);
  });
}

test("enableHelloMcp_DuplicateConcurrent_Expect_SingleAdd", async () => {
  // Arrange
  let resolveAdd: (() => void) | undefined;
  const { calls, client } = createClient({
    add: async () =>
      new Promise<void>((resolve) => {
        resolveAdd = resolve;
      }),
  });
  const tools = getTools(client, undefined, undefined, async () => false);

  // Act
  const first = tools.enable_hello_mcp.execute({}, {} as never);
  const second = tools.enable_hello_mcp.execute({}, {} as never);
  while (resolveAdd === undefined)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  resolveAdd!();
  await Promise.all([first, second]);
  await tools.enable_hello_mcp.execute({}, {} as never);

  // Assert
  assert.equal(calls.add.length, 1);
});

test("enableHelloMcp_AddFailure_Expect_Retry", async () => {
  // Arrange
  let attempts = 0;
  const { calls, client } = createClient({
    add: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("MCP process failed to start");
    },
  });
  const tools = getTools(client);

  // Act
  const failedEnable = tools.enable_hello_mcp.execute({}, {} as never);
  await assert.rejects(
    failedEnable,
    /Unable to enable Hello MCP.*failed to start/,
  );
  const result = await tools.enable_hello_mcp.execute({}, {} as never);

  // Assert
  assert.equal(result, EXPECTED_ENABLE_RESULT);
  assert.equal(calls.add.length, 2);
  assert.equal(calls.connect.length, 0);
});

test("enableHelloMcp_ChildDiagnostic_Expect_IncludedInError", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "hello-mcp-enable-"));
  const diagnosticsPath = join(root, "diagnostics.log");
  await writeFile(diagnosticsPath, "[hello-mcp] uncaughtException: boom\n");
  try {
    const { client } = createClient({
      add: async () => {
        throw new Error("Connection closed");
      },
    });
    const tools = getTools(client, HELLO_MCP_SERVER_PATH, diagnosticsPath);

    // Act
    const failedEnable = tools.enable_hello_mcp.execute({}, {} as never);

    // Assert
    await assert.rejects(
      failedEnable,
      new RegExp(
        `Child diagnostic: \\[hello-mcp\\] uncaughtException: boom\\..*Plugin host runtime=${process.release?.name ?? "unknown"} ${process.version} executable=${process.execPath}`,
      ),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("enableHelloMcp_DelayedChildDiagnostic_Expect_IncludedInError", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "hello-mcp-enable-"));
  const diagnosticsPath = join(root, "diagnostics.log");
  try {
    const childDiagnostic = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(
          diagnosticsPath,
          "[hello-mcp] uncaughtException: delayed boom\n",
        ).then(resolve, reject);
      }, HELLO_MCP_DIAGNOSTIC_RETRY_DELAY_MS);
    });
    const { client } = createClient({
      add: async () => {
        throw new Error("Connection closed");
      },
    });
    const tools = getTools(client, HELLO_MCP_SERVER_PATH, diagnosticsPath);

    // Act
    const failedEnable = tools.enable_hello_mcp.execute({}, {} as never);

    // Assert
    await assert.rejects(
      failedEnable,
      /Child diagnostic: \[hello-mcp\] uncaughtException: delayed boom\./,
    );
    await childDiagnostic;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

for (const status of [
  { status: "failed", error: "MCP process failed to start" },
  { status: "disabled" },
] as const) {
  test(`enableHelloMcp_AddStatus${status.status}_Expect_ActionableErrorAndConnectRetry`, async () => {
    // Arrange
    const { calls, client } = createClient({
      add: async () => ({ data: { [HELLO_MCP_NAME]: status } }),
    });
    const expectedError = new RegExp(status.status);
    const tools = getTools(client);

    // Act
    const failedEnable = tools.enable_hello_mcp.execute({}, {} as never);
    await assert.rejects(failedEnable, expectedError);
    const result = await tools.enable_hello_mcp.execute({}, {} as never);

    // Assert
    assert.equal(result, EXPECTED_ENABLE_RESULT);
    assert.equal(calls.add.length, 1);
    assert.deepEqual(calls.connect, [
      { path: { name: HELLO_MCP_NAME }, throwOnError: true },
    ]);
  });
}

test("disableHelloMcp_ThenEnable_Expect_DisconnectAndReconnect", async () => {
  // Arrange
  const { calls, client } = createClient({});
  const tools = getTools(client);

  // Act
  await tools.enable_hello_mcp.execute({}, {} as never);
  const result = await tools.disable_hello_mcp.execute({}, {} as never);
  await tools.enable_hello_mcp.execute({}, {} as never);

  // Assert
  assert.equal(result, "Hello MCP disabled.");
  assert.equal(calls.add.length, 1);
  assert.deepEqual(calls.connect, [
    { path: { name: HELLO_MCP_NAME }, throwOnError: true },
  ]);
  assert.deepEqual(calls.disconnect, [
    { path: { name: HELLO_MCP_NAME }, throwOnError: true },
  ]);
});
