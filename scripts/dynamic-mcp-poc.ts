import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createOpencodeClient, type McpStatus } from "@opencode-ai/sdk";

import {
  createLazyMcpPlugin,
  HELLO_MCP_NAME,
} from "../test/fixtures/dynamic-mcp/lazy-mcp-plugin-core.ts";
import {
  getHelloMcpDiagnosticsPath,
  HELLO_MCP_DIAGNOSTICS_ENV,
} from "../test/fixtures/dynamic-mcp/hello-mcp-diagnostics.ts";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const POLL_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const SERVER_READY_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 5_000;

interface RunningServer {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly output: () => string;
  readonly spawnError: () => Error | undefined;
}

interface HelloMcpState {
  readonly pids: readonly number[];
  readonly status: McpStatus | undefined;
}

function appendOutput(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const next = `${current}${chunk}`;
  return Buffer.byteLength(next) <= MAX_OUTPUT_BYTES
    ? next
    : `${next.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fetchWithTimeout(request: Request): Promise<Response> {
  return fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
  if (address === null || typeof address === "string")
    throw new Error("Could not reserve a local OpenCode server port.");
  return address.port;
}

function getServerFailure(server: RunningServer): Error {
  return new Error(
    [
      "OpenCode server exited before becoming ready.",
      `spawn error: ${server.spawnError()?.message ?? "none"}`,
      `output:\n${server.output()}`,
    ].join("\n"),
  );
}

function startServer(
  port: number,
  environment: NodeJS.ProcessEnv,
): RunningServer {
  const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
  const child = spawn(
    executable,
    [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "WARN",
    ],
    {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let error: Error | undefined;
  child.stdout?.on("data", (chunk: Buffer) => {
    output = appendOutput(output, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = appendOutput(output, chunk);
  });
  const exited = new Promise<void>((resolve) => {
    child.once("error", (spawnError) => {
      error = spawnError;
      resolve();
    });
    child.once("close", () => resolve());
  });
  return {
    child,
    exited,
    output: () => output,
    spawnError: () => error,
  };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the portable child-process fallback.
  }
  child.kill(signal);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopServer(server: RunningServer): Promise<void> {
  if (hasExited(server.child)) return;
  terminate(server.child, "SIGTERM");
  await Promise.race([server.exited, delay(TERMINATION_GRACE_MS)]);
  if (hasExited(server.child)) return;
  terminate(server.child, "SIGKILL");
  await Promise.race([server.exited, delay(TERMINATION_GRACE_MS)]);
  if (!hasExited(server.child))
    throw new Error("OpenCode server did not exit after SIGKILL.");
}

async function waitFor<T>(
  description: string,
  server: RunningServer,
  predicate: () => Promise<T | undefined>,
  getLastObservation?: () => unknown,
): Promise<T> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (hasExited(server.child) || server.spawnError() !== undefined)
      throw getServerFailure(server);
    try {
      const result = await predicate();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${description} timed out after ${SERVER_READY_TIMEOUT_MS}ms. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\nLast observation: ${JSON.stringify(
      getLastObservation?.() ?? "none",
    )}\nServer output:\n${server.output()}`,
  );
}

async function getMarkerPids(marker: string): Promise<number[]> {
  try {
    const content = await readFile(marker, "utf8");
    return content
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number(value));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function getMcpStatus(
  client: ReturnType<typeof createOpencodeClient>,
): Promise<Record<string, McpStatus>> {
  return (await client.mcp.status({ throwOnError: true })).data;
}

async function getHelloMcpState(
  client: ReturnType<typeof createOpencodeClient>,
  marker: string,
): Promise<HelloMcpState> {
  const [status, pids] = await Promise.all([
    getMcpStatus(client),
    getMarkerPids(marker),
  ]);
  return { pids, status: status[HELLO_MCP_NAME] };
}

function getBootstrapTools(client: ReturnType<typeof createOpencodeClient>) {
  const tools = createLazyMcpPlugin(client).tool;
  if (tools === undefined)
    throw new Error("Lazy MCP plugin did not register bootstrap tools.");
  return tools;
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "opencode-dynamic-mcp-"));
  const marker = join(home, "DYNAMIC_MCP_MARKER");
  const diagnosticsPath = getHelloMcpDiagnosticsPath();
  const port = await getAvailablePort();
  const pluginUrl = pathToFileURL(
    join(
      process.cwd(),
      "test",
      "fixtures",
      "dynamic-mcp",
      "lazy-mcp-plugin.ts",
    ),
  ).href;
  const environment = {
    ...process.env,
    DYNAMIC_MCP_MARKER: marker,
    [HELLO_MCP_DIAGNOSTICS_ENV]: diagnosticsPath,
    HOME: home,
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pluginUrl] }),
    OPENCODE_CONFIG_DIR: join(home, "config"),
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_TEST_HOME: home,
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_STATE_HOME: join(home, "xdg-state"),
  };
  const server = startServer(port, environment);
  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
    directory: process.cwd(),
    fetch: fetchWithTimeout,
  });
  try {
    await waitFor("OpenCode server readiness", server, async () => {
      const session = await client.session.create({
        body: { title: "Dynamic MCP POC" },
        throwOnError: true,
      });
      return session.data;
    });

    const initialStatus = await getMcpStatus(client);
    assert.equal(initialStatus[HELLO_MCP_NAME], undefined);
    assert.deepEqual(await getMarkerPids(marker), []);

    const tools = getBootstrapTools(client);
    const initialListResult = await tools.list_hello_mcp_tools.execute(
      {},
      {} as never,
    );
    if (typeof initialListResult !== "string")
      throw new Error("List response did not return text.");
    assert.match(initialListResult, /tools unavailable/);
    assert.match(initialListResult, /status=not registered/);
    assert.deepEqual(await getMarkerPids(marker), []);
    const enableResult = await tools.enable_hello_mcp.execute({}, {} as never);
    if (typeof enableResult !== "string")
      throw new Error("Enable response did not return text.");
    assert.match(enableResult, /status=connected/);
    assert.match(enableResult, /hello-mcp_hello_world/);
    assert.match(enableResult, /Return a friendly greeting\./);
    const connectedListResult = await tools.list_hello_mcp_tools.execute(
      {},
      {} as never,
    );
    if (typeof connectedListResult !== "string")
      throw new Error("List response did not return text.");
    assert.match(connectedListResult, /status=connected/);
    assert.match(connectedListResult, /hello-mcp_hello_world/);
    assert.match(connectedListResult, /Return a friendly greeting\./);
    let initialConnectionObservation: HelloMcpState | undefined;
    const initialConnection = await waitFor(
      "Hello MCP initial connection",
      server,
      async () => {
        const state = await getHelloMcpState(client, marker);
        initialConnectionObservation = state;
        if (state.status?.status !== "connected" || state.pids.length !== 1)
          return undefined;
        return state;
      },
      () => initialConnectionObservation,
    );
    const firstPid = initialConnection.pids[0];
    assert.equal(Number.isInteger(firstPid), true);
    assert.equal(isProcessRunning(firstPid), true);

    await tools.enable_hello_mcp.execute({}, {} as never);
    await delay(POLL_INTERVAL_MS);
    const duplicateEnablePids = await getMarkerPids(marker);
    assert.deepEqual(duplicateEnablePids, [firstPid]);

    await tools.disable_hello_mcp.execute({}, {} as never);
    let disconnectionObservation: HelloMcpState | undefined;
    const disconnection = await waitFor(
      "Hello MCP disconnection",
      server,
      async () => {
        const state = await getHelloMcpState(client, marker);
        disconnectionObservation = state;
        return state.status?.status === "disabled" ? state : undefined;
      },
      () => disconnectionObservation,
    );
    const firstProcessExited = await waitFor(
      "Hello MCP process exit",
      server,
      async () => (isProcessRunning(firstPid) ? undefined : true),
    );

    await tools.enable_hello_mcp.execute({}, {} as never);
    let reconnectionObservation: HelloMcpState | undefined;
    const reconnection = await waitFor(
      "Hello MCP reconnection",
      server,
      async () => {
        const state = await getHelloMcpState(client, marker);
        reconnectionObservation = state;
        if (state.status?.status !== "connected" || state.pids.length !== 2)
          return undefined;
        return state;
      },
      () => reconnectionObservation,
    );
    const secondPid = reconnection.pids[1];
    assert.notEqual(secondPid, firstPid);
    assert.equal(isProcessRunning(secondPid), true);
    const result = {
      disable: {
        status: disconnection.status?.status,
      },
      duplicateEnablePids,
      firstProcessExited,
      enable: {
        pid: firstPid,
        status: initialConnection.status?.status,
      },
      reenable: {
        pid: secondPid,
        status: reconnection.status?.status,
      },
    };

    process.stdout.write(
      `${JSON.stringify({
        ...result,
        connectedListResult,
        enableResult,
        initialListResult,
        initialMcp: "absent",
        status: "passed",
        tool: "hello-mcp_hello_world is directly callable after enable",
      })}\n`,
    );
  } finally {
    await stopServer(server);
    await rm(diagnosticsPath, { force: true });
    await rm(home, { force: true, recursive: true });
  }
}

await main();
