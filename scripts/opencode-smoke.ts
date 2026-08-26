import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { convertBundledAgents } from "../src/agent-converter.ts";
import { getBundledExternalDirectoryPattern } from "../src/agent-registration.ts";

const SAMPLING_AGENT_NAME = "UpgradeSampler";
const COMMAND_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface CommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface EffectiveAgent {
  readonly hidden?: unknown;
  readonly mode?: unknown;
  readonly permission?: Readonly<Record<string, unknown>>;
  readonly prompt?: unknown;
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
    const mcpList = await expectCommand(
      "opencode",
      ["mcp", "list"],
      process.cwd(),
      environment,
    );
    const effectiveConfig = JSON.parse(config.stdout) as unknown;
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
    const bundledExternalDirectory = {
      [getBundledExternalDirectoryPattern(bundledPluginRoot)]: "allow",
    };
    assert.equal(upgrade.mode, "primary");
    expectIncludes(upgradePrompt, "## OpenCode host compatibility");
    assert.equal(upgrade.permission?.task, "allow");
    expectIncludes(
      upgradePrompt,
      "task` returns the worker result directly and synchronously",
    );
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
    };
    for (const [permission, expected] of Object.entries(
      expectedUpgradePermissions,
    ))
      assert.equal(upgrade.permission?.[permission], expected);
    assert.deepEqual(
      upgrade.permission?.external_directory,
      bundledExternalDirectory,
    );
    assert.equal(worker.mode, "subagent");
    assert.equal(worker.hidden, true);
    expectIncludes(
      String(worker.prompt),
      "task` returns the worker result directly",
    );
    assert.deepEqual(
      worker.permission?.external_directory,
      bundledExternalDirectory,
    );
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
