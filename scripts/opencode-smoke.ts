import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { convertBundledAgents } from "../src/agent-converter.ts";

const BUNDLED_AGENT_COUNT = 16;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface CommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function appendOutput(
  current: string,
  chunk: Buffer,
  stream: "stdout" | "stderr",
): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const next = `${current}${chunk}`;
  return Buffer.byteLength(next) <= MAX_OUTPUT_BYTES
    ? next
    : `${next.slice(0, MAX_OUTPUT_BYTES)}\n[${stream} truncated]`;
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

async function runOpencode(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const command = `opencode ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk, "stderr");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ command, exitCode, stdout, stderr, timedOut });
    });
  });
}

async function expectOpencode(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runOpencode(args, environment);
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure(result);
  return result;
}

function expectIncludes(output: string, expected: string): void {
  assert.ok(
    output.includes(expected),
    `Expected output to include: ${expected}\nOutput:\n${output}`,
  );
}

function expectOrdered(output: string, expected: readonly string[]): void {
  let position = 0;
  for (const value of expected) {
    position = output.indexOf(value, position);
    assert.notEqual(position, -1, `Expected output to include: ${value}`);
    position += value.length;
  }
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
  const home = await mkdtemp(join(tmpdir(), "opencode-upgrade-smoke-"));
  try {
    const pluginUrl = pathToFileURL(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ).href;
    const agents = await convertBundledAgents(
      fileURLToPath(
        new URL("../plugins/upgrade-agent/agents", import.meta.url),
      ),
    );
    assert.equal(agents.agents.length, BUNDLED_AGENT_COUNT);
    assert.deepEqual(agents.diagnostics, []);

    const environment = {
      ...process.env,
      OPENCODE_TEST_HOME: home,
      OPENCODE_CONFIG_DIR: join(home, "config"),
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
        },
      }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
    };
    const config = await expectOpencode(["debug", "config"], environment);
    const agentList = await expectOpencode(["agent", "list"], environment);
    const upgrade = await expectOpencode(
      ["debug", "agent", "Upgrade"],
      environment,
    );
    const worker = await expectOpencode(
      ["debug", "agent", "BuildValidator"],
      environment,
    );
    const mcpList = await expectOpencode(["mcp", "list"], environment);
    const configOutput = `${config.stdout}\n${config.stderr}`;
    const agentOutput = `${agentList.stdout}\n${agentList.stderr}`;
    const upgradeOutput = `${upgrade.stdout}\n${upgrade.stderr}`;
    const workerOutput = `${worker.stdout}\n${worker.stderr}`;
    const mcpOutput = `${mcpList.stdout}\n${mcpList.stderr}`;

    for (const { name } of agents.agents) {
      expectIncludes(configOutput, name);
      expectIncludes(agentOutput, name);
    }
    expectIncludes(configOutput, "Unrelated");
    expectIncludes(upgradeOutput, "primary");
    expectIncludes(upgradeOutput, "## OpenCode host compatibility");
    expectOrdered(upgradeOutput, [
      '"permission": "*",\n      "action": "deny"',
      '"permission": "Upgrade_get_state",\n      "action": "allow"',
      '"permission": "open_canvas",\n      "action": "deny"',
      '"permission": "Upgrade_open_dashboard",\n      "action": "deny"',
    ]);
    expectIncludes(workerOutput, "subagent");
    expectIncludes(workerOutput, "hidden");
    expectIncludes(mcpOutput, "Upgrade");
    assert.deepEqual(getMcpNames(mcpOutput), ["Upgrade"]);
    assert.match(stripAnsi(mcpOutput), /\b(connected|healthy)\b/i);
    assert.equal(mcpOutput.includes("upgrade-dotnet"), false);
    assert.equal(mcpOutput.includes("upgrade-typescript"), false);

    process.stdout.write(
      `${JSON.stringify({
        agents: agents.agents.length,
        mcp: "Upgrade",
        status: "connected",
      })}\n`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

await main();
