import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { PluginInput } from "@opencode-ai/plugin";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticLogger = (
  level: DiagnosticLevel,
  message: string,
  options?: { readonly sensitive: boolean },
) => void;

export const SENSITIVE_LOGGING_ENV = "OPENCODE_UPGRADE_AGENT_LOG_SENSITIVE";

export const SAFE_PLUGIN_ERROR_MESSAGES = Object.freeze({
  invalidOptions: "Upgrade plugin options must be an object.",
  invalidSampling:
    'Upgrade plugin option "sampling" must be "ask", "allow", or "deny".',
  mcpConflict: 'MCP key "Upgrade" is already configured.',
  mcpNotConnected: "Upgrade MCP did not connect.",
  pluginDisposed: "Upgrade plugin was disposed.",
  disposedDuringInitialization:
    "Upgrade plugin was disposed during initialization.",
  invocationContextUnavailable: "Upgrade invocation context unavailable.",
  proxyEnvironment: "Upgrade MCP proxy environment is invalid.",
  proxyRequestUnavailable: "Upgrade MCP proxy request unavailable.",
  proxyRequestFailed: "Upgrade MCP proxy request failed.",
  proxyRequestCancelled: "Upgrade MCP proxy request cancelled.",
  proxyListenerUnavailable: "Could not start the Upgrade MCP proxy listener.",
} as const);

export class SafePluginError extends Error {
  readonly #code: keyof typeof SAFE_PLUGIN_ERROR_MESSAGES;

  constructor(code: keyof typeof SAFE_PLUGIN_ERROR_MESSAGES) {
    super(SAFE_PLUGIN_ERROR_MESSAGES[code]);
    this.#code = code;
  }

  get logMessage(): string {
    return SAFE_PLUGIN_ERROR_MESSAGES[this.#code];
  }
}

export function isSensitiveLoggingEnabled(): boolean {
  return process.env[SENSITIVE_LOGGING_ENV] === "1";
}

export function formatPluginError(error: unknown): string {
  if (!isSensitiveLoggingEnabled())
    return error instanceof SafePluginError
      ? error.logMessage
      : `details withheld (set ${SENSITIVE_LOGGING_ENV}=1 to log details)`;
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

export function createPluginLogger(
  client: PluginInput["client"],
): DiagnosticLogger {
  return (level, message, options) => {
    if (options?.sensitive && !isSensitiveLoggingEnabled()) return;
    void client.app
      .log({
        body: { level, message, service: "opencode-microsoft-upgrade-agent" },
      })
      .catch((error: unknown) => {
        console.error(
          "opencode upgrade-agent: logging failed",
          formatPluginError(error),
          message,
        );
      });
  };
}

export function forwardProcessStderr(
  stderr: Readable,
  processName: string,
  log: DiagnosticLogger,
): void {
  const lines = createInterface({ input: stderr });
  let suppressed = false;
  lines.on("line", (line) => {
    if (isSensitiveLoggingEnabled()) {
      log("error", `${processName} stderr: ${line}`, { sensitive: true });
    } else if (!suppressed) {
      log(
        "error",
        `${processName} stderr output suppressed; set ${SENSITIVE_LOGGING_ENV}=1 to log details.`,
      );
      suppressed = true;
    }
  });
  lines.on("error", (error) =>
    log("error", `${processName} stderr: ${formatPluginError(error)}`),
  );
}

export class LoggedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  private readonly transport: Transport;
  private readonly processName: string;
  private readonly stdout: "incoming" | "outgoing";
  private readonly log: DiagnosticLogger;

  constructor(
    transport: Transport,
    processName: string,
    stdout: "incoming" | "outgoing",
    log: DiagnosticLogger,
  ) {
    this.transport = transport;
    this.processName = processName;
    this.stdout = stdout;
    this.log = log;
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => {
      this.log("error", `${this.processName}: ${formatPluginError(error)}`);
      this.onerror?.(error);
    };
    this.transport.onmessage = (message, extra) => {
      if (this.stdout === "incoming" && isSensitiveLoggingEnabled())
        this.log(
          "debug",
          `${this.processName} stdout: ${JSON.stringify(message)}`,
          { sensitive: true },
        );
      this.onmessage?.(message, extra);
    };
    await this.transport.start();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.stdout === "outgoing" && isSensitiveLoggingEnabled())
      this.log(
        "debug",
        `${this.processName} stdout: ${JSON.stringify(message)}`,
        { sensitive: true },
      );
    await this.transport.send(message, options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
