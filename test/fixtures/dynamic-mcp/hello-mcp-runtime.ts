import { spawn, type ChildProcess } from "node:child_process";

export const HELLO_MCP_RUNTIME_PROBE_TIMEOUT_MS = 1_000;
export type HelloMcpRuntime = "bun" | "node";
export type HelloMcpRuntimeProbe = (command: string) => Promise<boolean>;

function isCommandRunnable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };

    try {
      child = spawn(command, ["--version"], {
        shell: false,
        stdio: "ignore",
        timeout: HELLO_MCP_RUNTIME_PROBE_TIMEOUT_MS,
      });
    } catch {
      settle(false);
      return;
    }

    child.once("error", () => settle(false));
    child.once("close", (code) => settle(code === 0));
    timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A probe failure should fall back to Node.
      }
      settle(false);
    }, HELLO_MCP_RUNTIME_PROBE_TIMEOUT_MS);
  });
}

export function selectHelloMcpRuntime(isBunRunnable: boolean): HelloMcpRuntime {
  return isBunRunnable ? "bun" : "node";
}

export async function resolveHelloMcpRuntime(
  probe: HelloMcpRuntimeProbe = isCommandRunnable,
): Promise<HelloMcpRuntime> {
  try {
    return selectHelloMcpRuntime(await probe("bun"));
  } catch {
    return selectHelloMcpRuntime(false);
  }
}
