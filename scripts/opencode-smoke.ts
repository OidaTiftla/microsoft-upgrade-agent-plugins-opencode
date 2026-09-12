import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { convertBundledAgents } from "../src/agent-converter.ts";

const SAMPLING_AGENT_NAME = "UpgradeSampler";
const COMMAND_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 5_000;
const SERVER_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_OUTPUT_BYTES = 16 * 1024 * 1024;
const SERVER_OUTPUT_PREFIX = "opencode server: ";

interface CommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface RunningServer {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly readyAt: () => number | undefined;
  readonly startedAt: number;
  readonly spawnError: () => Error | undefined;
}

interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
}

interface EffectiveAgent {
  readonly hidden?: unknown;
  readonly mode?: unknown;
  readonly permission?: Readonly<Record<string, unknown>>;
  readonly prompt?: unknown;
}

function assertBundledExternalDirectory(agent: EffectiveAgent): void {
  const entries = Object.entries(agent.permission?.external_directory ?? {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1], "allow");
  assert.ok(
    entries[0][0]
      .replaceAll("\\", "/")
      .toLowerCase()
      .endsWith(
        "/node_modules/opencode-microsoft-upgrade-agent/plugins/upgrade-agent/**",
      ),
  );
}

function appendOutput(
  current: string,
  chunk: Buffer,
  stream: "stdout" | "stderr",
  maxOutputBytes = MAX_OUTPUT_BYTES,
): string {
  if (Buffer.byteLength(current) >= maxOutputBytes) return current;
  const next = `${current}${chunk}`;
  return Buffer.byteLength(next) <= maxOutputBytes
    ? next
    : `${next.slice(0, maxOutputBytes)}\n[${stream} truncated]`;
}

function commandFailure(result: CommandResult): Error {
  return new Error(
    [
      `OpenCode command failed: ${result.command}`,
      `exit code: ${result.exitCode ?? "signal"}`,
      `timed out: ${result.timedOut}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join("\n"),
  );
}

function createPrefixedOutputWriter(
  stream: NodeJS.WriteStream,
): (chunk: Buffer) => void {
  let lineStart = true;
  return (chunk) => {
    let output = "";
    for (const character of chunk.toString()) {
      if (lineStart) output += SERVER_OUTPUT_PREFIX;
      output += character;
      lineStart = character === "\n";
    }
    stream.write(output);
  };
}

function getSpawnSpec(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): SpawnSpec {
  if (process.platform !== "win32") return { command, args };
  return {
    command: environment.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `${command}.cmd`, ...args],
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
  directory: string,
  environment: NodeJS.ProcessEnv,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<CommandResult> {
  const displayCommand = `${command} ${args.join(" ")}`;
  const spawnSpec = getSpawnSpec(command, args, environment);
  return new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: directory,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(force);
      resolve({ command: displayCommand, exitCode, stdout, stderr, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      force = setTimeout(() => {
        terminate(child, "SIGKILL");
        finish(null);
      }, TERMINATION_GRACE_MS);
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk, "stdout", maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk, "stderr", maxOutputBytes);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(force);
      reject(error);
    });
    child.on("close", finish);
  });
}

async function expectCommand(
  command: string,
  args: readonly string[],
  directory: string,
  environment: NodeJS.ProcessEnv,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<CommandResult> {
  const result = await runCommand(
    command,
    args,
    directory,
    environment,
    maxOutputBytes,
  );
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure(result);
  return result;
}

function getPackedTarball(output: string, directory: string): string {
  const [package_] = JSON.parse(output) as unknown[];
  const filename =
    package_ !== null && typeof package_ === "object"
      ? (package_ as { filename?: unknown }).filename
      : undefined;
  if (typeof filename !== "string")
    throw new Error("npm pack did not report a package filename.");
  return join(directory, filename);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getDirectoryEntries(directory: string): Promise<string> {
  try {
    const entries = await readdir(directory);
    return entries.length === 0 ? "none" : entries.join(", ");
  } catch {
    return "unavailable";
  }
}

async function getOpenCodeDependencyStatus(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const configHome = environment.XDG_CONFIG_HOME;
  if (configHome === undefined) return "unavailable: XDG_CONFIG_HOME is unset";
  const directories = [join(configHome, "opencode")];
  if (environment.OPENCODE_CONFIG_DIR !== undefined)
    directories.push(environment.OPENCODE_CONFIG_DIR);
  const dependencyDirectories = (
    await Promise.all(
      directories.map(async (directory) => {
        const nodeModules = join(directory, "node_modules");
        const plugin = join(
          nodeModules,
          "@opencode-ai",
          "plugin",
          "package.json",
        );
        return `${directory}: node_modules=${await pathExists(nodeModules)}, plugin=${await pathExists(plugin)}`;
      }),
    )
  ).join("\n");
  const stateHome = environment.XDG_STATE_HOME;
  const locks =
    stateHome === undefined
      ? "unavailable: XDG_STATE_HOME is unset"
      : await getDirectoryEntries(join(stateHome, "opencode", "locks"));
  return `${dependencyDirectories}\ninstall locks: ${locks}`;
}

function getEffectiveAgent(config: unknown, name: string): EffectiveAgent {
  const agents =
    config !== null &&
    typeof config === "object" &&
    "agent" in config &&
    config.agent !== null &&
    typeof config.agent === "object"
      ? config.agent
      : undefined;
  const agent =
    agents !== undefined && Object.hasOwn(agents, name)
      ? (agents as Record<string, unknown>)[name]
      : undefined;
  if (agent === null || typeof agent !== "object")
    throw new Error(
      `OpenCode effective configuration is missing agent "${name}".`,
    );
  return agent as EffectiveAgent;
}

function expectIncludes(output: string, expected: string): void {
  assert.ok(
    output.includes(expected),
    `Expected output to include: ${expected}\nOutput:\n${output}`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getAvailablePort(): Promise<number> {
  const server = createTcpServer();
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

function startServer(
  port: number,
  environment: NodeJS.ProcessEnv,
): RunningServer {
  const startedAt = Date.now();
  const spawnSpec = getSpawnSpec(
    "opencode",
    [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "DEBUG",
    ],
    environment,
  );
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let readyAt: number | undefined;
  let spawnError: Error | undefined;
  const writeStdout = createPrefixedOutputWriter(process.stdout);
  const writeStderr = createPrefixedOutputWriter(process.stderr);
  child.stdout?.on("data", (chunk: Buffer) => {
    writeStdout(chunk);
    output = appendOutput(output, chunk, "stdout");
    if (output.includes("opencode server listening on")) readyAt ??= Date.now();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    writeStderr(chunk);
    output = appendOutput(output, chunk, "stderr");
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  return {
    child,
    output: () => output,
    readyAt: () => readyAt,
    startedAt,
    spawnError: () => spawnError,
  };
}

function serverHasExited(server: RunningServer): boolean {
  return server.child.exitCode !== null || server.child.signalCode !== null;
}

function getServerStatus(server: RunningServer): string {
  const readyAt = server.readyAt();
  const processState = serverHasExited(server)
    ? `exited (${server.child.signalCode ?? server.child.exitCode})`
    : "running";
  const readiness =
    readyAt === undefined
      ? "not observed"
      : `observed after ${readyAt - server.startedAt}ms`;
  return [
    `process ID: ${server.child.pid ?? "unavailable"}`,
    `process state: ${processState}`,
    `server readiness: ${readiness}`,
    `spawn error: ${server.spawnError()?.message ?? "none"}`,
  ].join("\n");
}

function serverFailure(server: RunningServer): Error {
  return new Error(
    [
      "OpenCode server exited before the config API became ready.",
      getServerStatus(server),
      `output:\n${server.output()}`,
    ].join("\n"),
  );
}

async function waitForServerReady(server: RunningServer): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverHasExited(server) || server.spawnError() !== undefined)
      throw serverFailure(server);
    if (server.readyAt() !== undefined) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    [
      `OpenCode server did not report readiness after ${SERVER_READY_TIMEOUT_MS}ms.`,
      getServerStatus(server),
      `output:\n${server.output()}`,
    ].join("\n"),
  );
}

async function probeServerHttp(
  server: RunningServer,
  port: number,
): Promise<void> {
  const requestStartedAt = Date.now();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetch(`http://127.0.0.1:${port}/doc`, {
      signal: timeout,
    });
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status} ${response.statusText} from the OpenCode documentation endpoint.`,
      );
    process.stdout.write(
      `opencode smoke: HTTP probe succeeded in ${Date.now() - requestStartedAt}ms\n`,
    );
  } catch (error) {
    throw new Error(
      [
        "OpenCode server did not respond to an HTTP probe before config loading.",
        `request duration: ${Date.now() - requestStartedAt}ms`,
        `request timed out: ${timeout.aborted}`,
        `error: ${error instanceof Error ? error.message : String(error)}`,
        getServerStatus(server),
        `server output:\n${server.output()}`,
      ].join("\n"),
    );
  } finally {
    await response?.body?.cancel();
  }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (serverHasExited(server)) return;
  terminate(server.child, "SIGTERM");
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (!serverHasExited(server) && Date.now() < deadline)
    await delay(POLL_INTERVAL_MS);
  if (serverHasExited(server)) return;
  terminate(server.child, "SIGKILL");
  while (
    !serverHasExited(server) &&
    Date.now() < deadline + TERMINATION_GRACE_MS
  )
    await delay(POLL_INTERVAL_MS);
  if (!serverHasExited(server))
    throw new Error("OpenCode server did not exit after SIGKILL.");
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONFIG_OUTPUT_BYTES)
    throw new Error("OpenCode config API response exceeded the output limit.");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CONFIG_OUTPUT_BYTES) {
        await reader.cancel();
        throw new Error(
          "OpenCode config API response exceeded the output limit.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getEffectiveConfig(
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const port = await getAvailablePort();
  const server = startServer(port, environment);
  try {
    await waitForServerReady(server);
    await probeServerHttp(server, port);
    const url = `http://127.0.0.1:${port}/config`;
    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    let attempts = 0;
    let lastError: unknown;
    let lastRequestDurationMs = 0;
    let requestTimeouts = 0;
    while (Date.now() < deadline) {
      if (serverHasExited(server) || server.spawnError() !== undefined)
        throw serverFailure(server);
      let response: Response;
      const requestStartedAt = Date.now();
      const requestTimeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      attempts += 1;
      try {
        response = await fetch(url, {
          headers: { "x-opencode-directory": process.cwd() },
          signal: requestTimeout,
        });
      } catch (error) {
        lastError = error;
        lastRequestDurationMs = Date.now() - requestStartedAt;
        if (requestTimeout.aborted) requestTimeouts += 1;
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      if (response.ok) {
        const body = await readBoundedResponse(response);
        return JSON.parse(body) as unknown;
      }
      lastError = new Error(
        `Config API returned HTTP ${response.status} ${response.statusText}.`,
      );
      await response.body?.cancel();
      await delay(POLL_INTERVAL_MS);
    }
    const dependencyStatus = await getOpenCodeDependencyStatus(environment);
    throw new Error(
      [
        `OpenCode config API was not ready after ${SERVER_READY_TIMEOUT_MS}ms.`,
        `requests: ${attempts}, timed out: ${requestTimeouts}, last duration: ${lastRequestDurationMs}ms`,
        `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        `dependency status:\n${dependencyStatus}`,
        getServerStatus(server),
        `server output:\n${server.output()}`,
      ].join("\n"),
    );
  } finally {
    await stopServer(server);
  }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32")
      return void process.kill(-child.pid, signal);
  } catch {
    // Fall through to the portable child-process fallback.
  }
  if (process.platform === "win32" && signal === "SIGTERM") {
    const taskkill = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    taskkill.on("error", () => child.kill(signal));
    taskkill.unref();
    return;
  }
  child.kill(signal);
}

function stripAnsi(output: string): string {
  return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function getMcpNames(output: string): string[] {
  return [...stripAnsi(output).matchAll(/^●\s+[✓○]\s+(\S+)/gm)].map(
    (match) => match[1],
  );
}

async function main(): Promise<void> {
  const home = await mkdtemp(
    join(tmpdir(), "opencode-microsoft-upgrade-smoke-"),
  );
  try {
    const pack = await expectCommand(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", home],
      process.cwd(),
      process.env,
    );
    const tarball = getPackedTarball(pack.stdout, home);
    await expectCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--prefix",
        home,
        tarball,
      ],
      process.cwd(),
      process.env,
    );
    const pluginRoot = join(
      home,
      "node_modules",
      "opencode-microsoft-upgrade-agent",
    );
    const bundledPluginRoot = join(pluginRoot, "plugins", "upgrade-agent");
    const pluginEntry = join(pluginRoot, "src", "index.ts");
    await access(pluginEntry);
    const pluginUrl = pathToFileURL(pluginEntry).href;
    const agents = await convertBundledAgents(
      join(bundledPluginRoot, "agents"),
    );
    assert.ok(agents.agents.length > 0);
    assert.deepEqual(agents.diagnostics, []);

    const environment = {
      ...process.env,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(home, "xdg-config"),
      XDG_DATA_HOME: join(home, "xdg-data"),
      XDG_STATE_HOME: join(home, "xdg-state"),
      XDG_CACHE_HOME: join(home, "xdg-cache"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [pluginUrl],
        model: "openai/smoke-model",
        provider: {
          openai: {
            models: {
              "smoke-model": { name: "Smoke model" },
            },
          },
        },
        agent: {
          Unrelated: {
            description: "Unrelated smoke-test agent.",
            mode: "subagent",
            prompt: "Do not use this agent.",
          },
          Explicit: {
            description: "Explicit sampling policy smoke-test agent.",
            mode: "subagent",
            permission: { sampling: "deny" },
            prompt: "Do not use this agent.",
          },
        },
      }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_UPGRADE_AGENT_DIAGNOSTICS: "1",
      NPM_CONFIG_AUDIT: "false",
    };
    const effectiveConfig = await getEffectiveConfig(environment);
    const mcpList = await expectCommand(
      "opencode",
      ["mcp", "list"],
      process.cwd(),
      environment,
    );
    const mcpOutput = `${mcpList.stdout}\n${mcpList.stderr}`;

    for (const { name } of agents.agents) {
      getEffectiveAgent(effectiveConfig, name);
    }
    const upgrade = getEffectiveAgent(effectiveConfig, "Upgrade");
    const worker = getEffectiveAgent(effectiveConfig, "BuildValidator");
    const unrelated = getEffectiveAgent(effectiveConfig, "Unrelated");
    const explicit = getEffectiveAgent(effectiveConfig, "Explicit");
    const sampler = getEffectiveAgent(effectiveConfig, SAMPLING_AGENT_NAME);
    const upgradePrompt = String(upgrade.prompt);
    assert.equal(upgrade.mode, "primary");
    expectIncludes(upgradePrompt, "## OpenCode host compatibility");
    expectIncludes(
      upgradePrompt,
      "Before an agent's first `Upgrade_<tool>` call in an OpenCode session",
    );
    assert.equal(upgrade.permission?.task, "allow");
    expectIncludes(upgradePrompt, "start_task`: returns the task content");
    assert.ok(
      upgradePrompt.indexOf("Collect the result with **one long-wait") <
        upgradePrompt.indexOf("This supersedes any preceding background"),
    );
    const expectedUpgradePermissions = {
      "*": "deny",
      Upgrade_get_state: "allow",
      open_canvas: "deny",
      sampling: "ask",
      task: "allow",
      Upgrade_open_dashboard: "deny",
      enable_upgrade_mcp: "allow",
      disable_upgrade_mcp: "allow",
      get_upgrade_mcp_status: "allow",
      list_upgrade_mcp_tools: "allow",
    };
    for (const [permission, expected] of Object.entries(
      expectedUpgradePermissions,
    ))
      assert.equal(upgrade.permission?.[permission], expected);
    assertBundledExternalDirectory(upgrade);
    assert.equal(worker.mode, "subagent");
    assert.equal(worker.hidden, true);
    expectIncludes(
      String(worker.prompt),
      "run the build/tests, absorb the huge log, and return only the verdict",
    );
    assertBundledExternalDirectory(worker);
    assert.equal(unrelated.permission?.sampling, "ask");
    assert.equal(explicit.permission?.sampling, "deny");
    assert.equal(sampler.mode, "subagent");
    assert.equal(sampler.hidden, true);
    assert.deepEqual(getMcpNames(mcpOutput), []);
    assert.equal(mcpOutput.includes("Upgrade"), false);
    assert.equal(mcpOutput.includes("upgrade-dotnet"), false);
    assert.equal(mcpOutput.includes("upgrade-typescript"), false);

    process.stdout.write(
      `${JSON.stringify({
        agents: agents.agents.length + 1,
        mcp: "none",
        status: "plugin tools registered",
      })}\n`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

await main();
