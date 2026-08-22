import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { convertBundledAgents } from "../src/agent-converter.ts";
import { getBundledExternalDirectoryPattern } from "../src/agent-registration.ts";

const BUNDLED_AGENT_COUNT = 16;
const SAMPLING_AGENT_NAME = "UpgradeSampler";
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

async function runCommand(
  command: string,
  args: readonly string[],
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const displayCommand = `${command} ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
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
      resolve({ command: displayCommand, exitCode, stdout, stderr, timedOut });
    });
  });
}

async function expectCommand(
  command: string,
  args: readonly string[],
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runCommand(command, args, directory, environment);
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
    const pluginRoot = join(home, "node_modules", "opencode-upgrade-agent");
    const bundledPluginRoot = join(pluginRoot, "plugins", "upgrade-agent");
    const pluginEntry = join(pluginRoot, "src", "index.ts");
    await access(pluginEntry);
    const pluginUrl = pathToFileURL(pluginEntry).href;
    const agents = await convertBundledAgents(
      join(bundledPluginRoot, "agents"),
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
    };
    const config = await expectCommand(
      "opencode",
      ["debug", "config"],
      process.cwd(),
      environment,
    );
    const agentList = await expectCommand(
      "opencode",
      ["agent", "list"],
      process.cwd(),
      environment,
    );
    const upgrade = await expectCommand(
      "opencode",
      ["debug", "agent", "Upgrade"],
      process.cwd(),
      environment,
    );
    const worker = await expectCommand(
      "opencode",
      ["debug", "agent", "BuildValidator"],
      process.cwd(),
      environment,
    );
    const unrelated = await expectCommand(
      "opencode",
      ["debug", "agent", "Unrelated"],
      process.cwd(),
      environment,
    );
    const explicit = await expectCommand(
      "opencode",
      ["debug", "agent", "Explicit"],
      process.cwd(),
      environment,
    );
    const sampler = await expectCommand(
      "opencode",
      ["debug", "agent", SAMPLING_AGENT_NAME],
      process.cwd(),
      environment,
    );
    const mcpList = await expectCommand(
      "opencode",
      ["mcp", "list"],
      process.cwd(),
      environment,
    );
    const configOutput = `${config.stdout}\n${config.stderr}`;
    const agentOutput = `${agentList.stdout}\n${agentList.stderr}`;
    const upgradeOutput = `${upgrade.stdout}\n${upgrade.stderr}`;
    const workerOutput = `${worker.stdout}\n${worker.stderr}`;
    const unrelatedOutput = `${unrelated.stdout}\n${unrelated.stderr}`;
    const explicitOutput = `${explicit.stdout}\n${explicit.stderr}`;
    const samplerOutput = `${sampler.stdout}\n${sampler.stderr}`;
    const mcpOutput = `${mcpList.stdout}\n${mcpList.stderr}`;

    for (const { name } of agents.agents) {
      expectIncludes(configOutput, name);
      expectIncludes(agentOutput, name);
    }
    expectIncludes(configOutput, "Unrelated");
    expectIncludes(configOutput, "Explicit");
    expectIncludes(configOutput, SAMPLING_AGENT_NAME);
    expectIncludes(upgradeOutput, "primary");
    expectIncludes(upgradeOutput, "## OpenCode host compatibility");
    expectIncludes(
      upgradeOutput,
      '"permission": "task",\n      "action": "allow"',
    );
    expectIncludes(
      upgradeOutput,
      "task` returns the worker result directly and synchronously",
    );
    assert.ok(
      upgradeOutput.indexOf("Collect the result with **one long-wait") <
        upgradeOutput.indexOf("This supersedes any preceding background"),
    );
    expectOrdered(upgradeOutput, [
      '"permission": "*",\n      "action": "deny"',
      '"permission": "Upgrade_get_state",\n      "action": "allow"',
      '"permission": "open_canvas",\n      "action": "deny"',
      '"permission": "Upgrade_open_dashboard",\n      "action": "deny"',
      `"permission": "external_directory",\n      "pattern": "${getBundledExternalDirectoryPattern(bundledPluginRoot)}",\n      "action": "allow"`,
    ]);
    expectIncludes(workerOutput, "subagent");
    expectIncludes(workerOutput, "hidden");
    expectIncludes(workerOutput, "task` returns the worker result directly");
    expectIncludes(workerOutput, '"permission": "external_directory"');
    expectIncludes(
      workerOutput,
      `"pattern": "${getBundledExternalDirectoryPattern(bundledPluginRoot)}"`,
    );
    expectIncludes(
      upgradeOutput,
      '"permission": "sampling",\n      "action": "ask"',
    );
    expectIncludes(
      unrelatedOutput,
      '"permission": "sampling",\n      "action": "ask"',
    );
    expectIncludes(
      explicitOutput,
      '"permission": "sampling",\n      "action": "deny"',
    );
    expectIncludes(samplerOutput, "subagent");
    expectIncludes(samplerOutput, "hidden");
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
