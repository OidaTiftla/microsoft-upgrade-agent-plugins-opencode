import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  UpgradeInvocationRegistry,
  UpgradeMcpProxyServer,
  type UpgradeInvocation,
} from "../src/upgrade-mcp-proxy-transport.ts";

test("UpgradeMcpProxy_TransportBackedTools_Expect_ForwardsListAndCall", async () => {
  // Arrange
  const registry = new UpgradeInvocationRegistry();
  const invocation: UpgradeInvocation = {
    callID: "call",
    sessionID: "session",
    tool: "Upgrade_get_state",
  };
  const calls: unknown[] = [];
  registry.register(invocation);
  const plugin = new UpgradeMcpProxyServer({
    executeCoreTool: async (receivedInvocation, name, arguments_) => {
      calls.push({ arguments_, name, receivedInvocation });
      return { content: [{ text: "complete", type: "text" }] };
    },
    listToolDescriptors: async () => [
      { inputSchema: { type: "object" }, name: "get_state" },
    ],
    registry,
    token: "test-token",
  });
  const endpoint = await plugin.start();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    args: ["src/upgrade-mcp-proxy.ts"],
    command: process.execPath,
    env: {
      ...process.env,
      UPGRADE_MCP_PROXY_HOST: endpoint.host,
      UPGRADE_MCP_PROXY_PORT: String(endpoint.port),
      UPGRADE_MCP_PROXY_TOKEN: "test-token",
    } as Record<string, string>,
  });

  try {
    // Act
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({
      arguments: { path: "/repo" },
      name: "get_state",
    });

    // Assert
    assert.deepEqual(tools.tools, [
      { inputSchema: { type: "object" }, name: "get_state" },
    ]);
    assert.deepEqual(result, { content: [{ text: "complete", type: "text" }] });
    assert.deepEqual(calls, [
      {
        arguments_: { path: "/repo" },
        name: "get_state",
        receivedInvocation: invocation,
      },
    ]);
  } finally {
    await client.close();
    await plugin.stop();
  }
});
