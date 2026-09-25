export interface NpmCommand {
  command: string;
  args: readonly string[];
}

export function createNpmCommand(
  npmArguments: readonly string[],
  npmExecPath = process.env.npm_execpath,
  platform = process.platform,
  commandProcessor = process.env.ComSpec,
): NpmCommand {
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...npmArguments],
    };
  }

  if (platform === "win32") {
    return {
      command: commandProcessor || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...npmArguments],
    };
  }

  return { command: "npm", args: [...npmArguments] };
}
