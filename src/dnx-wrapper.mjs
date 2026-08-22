import { spawn } from "node:child_process";
import { homedir } from "node:os";

const [command, ...args] = process.argv.slice(2);

if (command === undefined) {
  throw new Error("Expected an MCP command.");
}

const child = spawn(command, args, {
  cwd: homedir(),
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

function terminate(signal) {
  child.kill(signal);
}

process.once("SIGINT", () => terminate("SIGINT"));
process.once("SIGTERM", () => terminate("SIGTERM"));
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
