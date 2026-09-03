import { appendFile, open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HELLO_MCP_DIAGNOSTICS_ENV = "DYNAMIC_MCP_DIAGNOSTICS_FILE";
export const MAX_HELLO_MCP_DIAGNOSTIC_BYTES = 8 * 1024;
export const MAX_HELLO_MCP_DIAGNOSTIC_ENTRY_LENGTH = 4 * 1024;
export const HELLO_MCP_DIAGNOSTIC_RETRY_COUNT = 5;
export const HELLO_MCP_DIAGNOSTIC_RETRY_DELAY_MS = 25;
export type HelloMcpFailureEvent = "uncaughtException" | "unhandledRejection";

export interface HelloMcpRuntimeIdentity {
  readonly runtime: string;
  readonly executable: string;
}

export interface HelloMcpRuntimeDetails extends HelloMcpRuntimeIdentity {
  readonly cwd: string;
}

export function getHelloMcpDiagnosticsPath(): string {
  const configuredPath = process.env[HELLO_MCP_DIAGNOSTICS_ENV];
  return configuredPath === undefined || configuredPath === ""
    ? join(tmpdir(), `opencode-dynamic-mcp-${process.pid}.diagnostics.log`)
    : configuredPath;
}

export function getHelloMcpRuntimeIdentity(): HelloMcpRuntimeIdentity {
  return {
    runtime: `${process.release?.name ?? "unknown"} ${process.version}`,
    executable: process.execPath,
  };
}

export function formatHelloMcpStartupDiagnostic(
  details: HelloMcpRuntimeDetails,
): string {
  return `[hello-mcp] startup runtime=${details.runtime} cwd=${details.cwd} executable=${details.executable}`;
}

export function formatHelloMcpFailureDiagnostic(
  event: HelloMcpFailureEvent,
  reason: unknown,
): string {
  const message =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  return `[hello-mcp] ${event}: ${message.replace(/\s+/g, " ")}`;
}

export async function appendHelloMcpDiagnostic(
  diagnosticsPath: string,
  entry: string,
): Promise<void> {
  try {
    await appendFile(diagnosticsPath, `${entry}\n`);
  } catch {
    // Diagnostics must not change the MCP server's behavior.
  }
}

export async function readFinalHelloMcpDiagnostic(
  diagnosticsPath: string,
): Promise<string | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(diagnosticsPath, "r");
    const { size } = await file.stat();
    const length = Math.min(size, MAX_HELLO_MCP_DIAGNOSTIC_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const entry = buffer.toString("utf8").trim().split(/\r?\n/).at(-1);
    if (entry === undefined || entry === "") return undefined;
    return entry.length > MAX_HELLO_MCP_DIAGNOSTIC_ENTRY_LENGTH
      ? `${entry.slice(0, MAX_HELLO_MCP_DIAGNOSTIC_ENTRY_LENGTH)}…`
      : entry;
  } catch {
    return undefined;
  } finally {
    try {
      await file?.close();
    } catch {
      // A diagnostic read failure should not mask the MCP error.
    }
  }
}

export async function readFinalHelloMcpDiagnosticWithRetry(
  diagnosticsPath: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < HELLO_MCP_DIAGNOSTIC_RETRY_COUNT; attempt++) {
    const diagnostic = await readFinalHelloMcpDiagnostic(diagnosticsPath);
    if (diagnostic !== undefined) return diagnostic;
    if (attempt + 1 < HELLO_MCP_DIAGNOSTIC_RETRY_COUNT)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, HELLO_MCP_DIAGNOSTIC_RETRY_DELAY_MS),
      );
  }
  return undefined;
}
