import { appendFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  appendHelloMcpDiagnostic,
  formatHelloMcpFailureDiagnostic,
  formatHelloMcpStartupDiagnostic,
  getHelloMcpDiagnosticsPath,
  getHelloMcpRuntimeIdentity,
  type HelloMcpFailureEvent,
} from "./hello-mcp-diagnostics.ts";
import { HELLO_MCP_TOOL } from "./hello-mcp-tool.ts";

const diagnosticsPath = getHelloMcpDiagnosticsPath();

function exitAfterDiagnostic(
  event: HelloMcpFailureEvent,
  reason: unknown,
): void {
  void appendHelloMcpDiagnostic(
    diagnosticsPath,
    formatHelloMcpFailureDiagnostic(event, reason),
  ).then(() => process.exit(1));
}

process.on("uncaughtException", (error) => {
  exitAfterDiagnostic("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  exitAfterDiagnostic("unhandledRejection", reason);
});

await appendHelloMcpDiagnostic(
  diagnosticsPath,
  formatHelloMcpStartupDiagnostic({
    ...getHelloMcpRuntimeIdentity(),
    cwd: process.cwd(),
  }),
);

const marker = process.env.DYNAMIC_MCP_MARKER;
if (marker !== undefined && marker !== "")
  await appendFile(marker, `${process.pid}\n`);

const server = new McpServer({ name: "hello-mcp", version: "1.0.0" });
server.registerTool(
  HELLO_MCP_TOOL.name,
  { description: HELLO_MCP_TOOL.description },
  async () => ({ content: [{ type: "text", text: "Hello, world!" }] }),
);

await server.connect(new StdioServerTransport());
