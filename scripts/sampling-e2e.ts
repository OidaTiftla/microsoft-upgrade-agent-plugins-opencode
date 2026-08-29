import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrivateCoreMcpClient } from "../src/private-core-mcp-client.ts";

const SCENARIO_ID = "dotnet-version-upgrade";
const TASK_ID = "01-upgrade-framework-project";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_FAILURE_CHARS = 16 * 1024;
const TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 5_000;
const SENSITIVE_OUTPUT =
  /auth|authorization|cookie|credential|header|secret|token|body|api.?key/i;
type CommandResult = {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
};
type ToolUseEvent = {
  readonly part: {
    readonly state: { readonly output?: unknown; readonly status?: unknown };
    readonly tool: string;
  };
  readonly type: "tool_use";
};

function appendOutput(current: string, chunk: Buffer): string {
  const next = `${current}${chunk}`;
  return Buffer.byteLength(current) >= MAX_OUTPUT_BYTES
    ? current
    : next.slice(0, MAX_OUTPUT_BYTES);
}
function getRequiredModel(): string {
  const model = process.env.OPENCODE_UPGRADE_E2E_MODEL;
  if (model === undefined || !/^[^/]+\/[^/]+$/.test(model))
    throw new Error(
      "Set OPENCODE_UPGRADE_E2E_MODEL=provider/model before running this manual test.",
    );
  return model;
}
async function copyExistingAuthentication(
  dataDirectory: string,
): Promise<void> {
  await mkdir(dataDirectory, { mode: 0o700, recursive: true });
  await chmod(dataDirectory, 0o700);
  if (Object.hasOwn(process.env, "OPENCODE_AUTH_CONTENT")) return;
  const directory = join(dataDirectory, "opencode");
  const source =
    process.env.XDG_DATA_HOME === undefined
      ? platform() === "darwin"
        ? join(homedir(), "Library", "Application Support", "opencode")
        : join(homedir(), ".local", "share", "opencode")
      : join(process.env.XDG_DATA_HOME, "opencode");
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const target = join(directory, "auth.json");
    await copyFile(join(source, "auth.json"), target);
    await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function getPlan(): string {
  return `# .NET Version Upgrade Plan\n\n### ${TASK_ID}: Upgrade the framework project\n\nUpgrade FrameworkUpgradeFixture.csproj and required project references.\n\n**Done when**: The project targets the selected framework and builds successfully.\n`;
}
function terminate(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
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
async function runCommand(
  command: string,
  args: readonly string[],
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      resolve({ exitCode, stderr, stdout, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      force = setTimeout(() => {
        terminate(child, "SIGKILL");
        finish(null);
      }, TERMINATION_GRACE_MS);
    }, TIMEOUT_MS);
    child.stdout.on(
      "data",
      (chunk: Buffer) => (stdout = appendOutput(stdout, chunk)),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr = appendOutput(stderr, chunk)),
    );
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
function sanitizeOutput(value: string): string {
  return value
    .slice(0, MAX_FAILURE_CHARS)
    .split("\n")
    .map((line) =>
      SENSITIVE_OUTPUT.test(line)
        ? "<redacted sensitive output>"
        : line.replace(
            /(?:[A-Za-z]:[\\/]|\/private)?\/tmp\/[^\s"']+/g,
            "<temp-path>",
          ),
    )
    .join("\n");
}
function getFailureOutput(result: CommandResult): string {
  return `stdout:\n${sanitizeOutput(result.stdout)}\nstderr:\n${sanitizeOutput(result.stderr)}`;
}
function isToolUseEvent(value: unknown): value is ToolUseEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "tool_use" &&
    typeof (value as { part?: { tool?: unknown } }).part?.tool === "string" &&
    (value as { part?: { state?: unknown } }).part?.state !== null &&
    typeof (value as { part?: { state?: unknown } }).part?.state === "object"
  );
}
function getCompletedToolUse(events: readonly unknown[], tool: string): number {
  const matches = events.flatMap((event, index) =>
    isToolUseEvent(event) && event.part.tool === tool ? [{ event, index }] : [],
  );
  assert.equal(matches.length, 1, `Expected exactly one ${tool} event.`);
  const [{ event, index }] = matches;
  assert.equal(event.part.state.status, "completed");
  return index;
}
function assertSampledTaskStart(output: string): void {
  const events = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
  const resume = getCompletedToolUse(events, "Upgrade_resume_scenario");
  const start = getCompletedToolUse(events, "Upgrade_start_task");
  assert.ok(resume < start, "resume must complete before start.");
  const event = events[start] as ToolUseEvent;
  if (typeof event.part.state.output !== "string")
    throw new Error("Upgrade_start_task completed without tool output.");
  assert.match(
    event.part.state.output,
    /<task_related_skills>[\s\S]*?\S[\s\S]*?<\/task_related_skills>/,
    "A completed start task must contain sampled task-related skills.",
  );
}
async function main(): Promise<void> {
  const model = getRequiredModel();
  if (
    platform() === "win32" &&
    !Object.hasOwn(process.env, "OPENCODE_AUTH_CONTENT")
  )
    throw new Error(
      "On Windows, set OPENCODE_AUTH_CONTENT; secure auth-file copying is unavailable.",
    );
  const root = await mkdtemp(join(tmpdir(), "opencode-microsoft-upgrade-e2e-"));
  const fixture = join(root, "dotnet-framework-upgrade");
  const home = join(root, "opencode");
  const workflow = join(
    fixture,
    ".github",
    "upgrades",
    "scenarios",
    SCENARIO_ID,
  );
  const pluginRoot = resolve(
    fileURLToPath(new URL("../plugins/upgrade-agent", import.meta.url)),
  );
  let result: CommandResult | undefined;
  try {
    await chmod(root, 0o700);
    await copyExistingAuthentication(join(home, "data"));
    await cp(
      new URL("../test/fixtures/dotnet-framework-upgrade", import.meta.url),
      fixture,
      {
        recursive: true,
      },
    );
    const core = await createPrivateCoreMcpClient({
      pluginRoot,
      sampling: async () => {
        throw new Error("E2E setup unexpectedly requested sampling.");
      },
      versionManifestPath: new URL("../src/mcp-versions/", import.meta.url),
    });
    try {
      await core.callTool("get_state", { path: fixture });
      await core.callTool("initialize_scenario", {
        description: "Initialize the FrameworkUpgradeFixture version upgrade.",
        scenarioId: SCENARIO_ID,
      });
    } finally {
      await core.dispose();
    }
    await access(workflow);
    await writeFile(join(workflow, "plan.md"), getPlan());
    const environment = {
      ...process.env,
      OPENCODE_CONFIG_DIR: join(home, "config"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_CONFIG_HOME: join(home, "xdg-config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: {
          UpgradeE2E: {
            mode: "primary",
            permission: {
              "*": "deny",
              Upgrade_resume_scenario: "allow",
              Upgrade_start_task: "allow",
            },
            prompt:
              "Resume the scenario once, then start the task once. Return the raw start result.",
          },
        },
        model,
        plugin: [
          [
            pathToFileURL(
              fileURLToPath(new URL("../src/index.ts", import.meta.url)),
            ).href,
            { sampling: "allow" },
          ],
        ],
        small_model: model,
      }),
    };
    result = await runCommand(
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--agent",
        "UpgradeE2E",
        "--model",
        model,
        `Call Upgrade_resume_scenario exactly once with scenarioId ${SCENARIO_ID}. Only after it succeeds, call Upgrade_start_task exactly once for ${TASK_ID}. Return only the raw start result.`,
      ],
      fixture,
      environment,
    );
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `OpenCode E2E failed: exit=${result.exitCode ?? "signal"}, timedOut=${result.timedOut}.`,
      );
    assertSampledTaskStart(result.stdout);
    await access(join(workflow, "tasks.md"));
    assert.ok(
      (await readdir(workflow, { recursive: true })).some((path) =>
        path.includes(TASK_ID),
      ),
      "Core did not create the task folder.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}${result === undefined ? "" : `\n${getFailureOutput(result)}`}`,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
await main();
