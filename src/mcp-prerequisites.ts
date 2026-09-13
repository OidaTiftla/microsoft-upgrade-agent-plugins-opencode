import { execFile } from "node:child_process";

export type McpPrerequisite = "dnx" | "dotnet" | "node" | "npx";

export interface PrerequisiteCommandResult {
  readonly succeeded: boolean;
  readonly stdout: string;
}

export interface PrerequisiteCommandRunner {
  isExecutableAvailable(executable: string): Promise<boolean>;
  run(
    command: string,
    arguments_: readonly string[],
  ): Promise<PrerequisiteCommandResult>;
}

export interface McpPrerequisiteDiagnostic {
  readonly prerequisite: McpPrerequisite;
  readonly status: "missing" | "unsupported-version" | "unavailable";
  readonly message: string;
  readonly remediation: string;
}

export interface McpPrerequisiteDiagnostics {
  readonly isReady: boolean;
  readonly diagnostics: readonly McpPrerequisiteDiagnostic[];
}

interface PrerequisiteDefinition {
  readonly prerequisite: McpPrerequisite;
  readonly remediation: string;
}

const NODE_MINIMUM_VERSION = [22, 18, 0] as const;
const NODE_REMEDIATION =
  "Install Node.js 22.18.0 or later and ensure node and npx are available on PATH.";
const DOTNET_REMEDIATION =
  "Install the .NET SDK 10 or later and ensure it is available on PATH.";

const prerequisiteDefinitions: readonly PrerequisiteDefinition[] = [
  {
    prerequisite: "dnx",
    remediation: DOTNET_REMEDIATION,
  },
  {
    prerequisite: "dotnet",
    remediation: DOTNET_REMEDIATION,
  },
  {
    prerequisite: "node",
    remediation: NODE_REMEDIATION,
  },
  {
    prerequisite: "npx",
    remediation: NODE_REMEDIATION,
  },
];

function runCommand(
  command: string,
  arguments_: readonly string[],
): Promise<PrerequisiteCommandResult> {
  return new Promise((resolve) => {
    execFile(command, arguments_, (error, stdout) => {
      resolve({ succeeded: error === null, stdout });
    });
  });
}

export const systemPrerequisiteCommandRunner: PrerequisiteCommandRunner = {
  async isExecutableAvailable(executable) {
    const command = process.platform === "win32" ? "where" : "which";
    return (await runCommand(command, [executable])).succeeded;
  },
  run: runCommand,
};

function createMissingDiagnostic(
  definition: PrerequisiteDefinition,
): McpPrerequisiteDiagnostic {
  return {
    prerequisite: definition.prerequisite,
    status: "missing",
    message: `Required executable "${definition.prerequisite}" was not found on PATH.`,
    remediation: definition.remediation,
  };
}

function getDotnetSdkMajor(version: string): number | undefined {
  const match = /^(\d+)(?:\.\d+)*/.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

function createUnreadableDotnetVersionDiagnostic(): McpPrerequisiteDiagnostic {
  return {
    prerequisite: "dotnet",
    status: "unavailable",
    message: "Could not determine the installed .NET SDK version.",
    remediation:
      "Install the .NET SDK 10 or later and ensure dotnet --version succeeds.",
  };
}

function createDotnetVersionDiagnostic(
  version: string,
): McpPrerequisiteDiagnostic | undefined {
  const normalizedVersion = version.trim();
  const majorVersion = getDotnetSdkMajor(normalizedVersion);

  if (majorVersion === undefined) {
    return createUnreadableDotnetVersionDiagnostic();
  }

  if (majorVersion >= 10) {
    return undefined;
  }

  return {
    prerequisite: "dotnet",
    status: "unsupported-version",
    message: `Detected .NET SDK ${normalizedVersion}, but version 10 or later is required.`,
    remediation:
      "Install the .NET SDK 10 or later. Update global.json roll-forward settings if needed.",
  };
}

function createUnreadableNodeVersionDiagnostic(): McpPrerequisiteDiagnostic {
  return {
    prerequisite: "node",
    status: "unavailable",
    message: "Could not determine the installed Node.js version.",
    remediation:
      "Install Node.js 22.18.0 or later and ensure node --version succeeds.",
  };
}

function createNodeVersionDiagnostic(
  version: string,
): McpPrerequisiteDiagnostic | undefined {
  const normalizedVersion = version.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(normalizedVersion);
  if (match === null) return createUnreadableNodeVersionDiagnostic();
  const installed = match.slice(1).map(Number);
  const difference = installed.findIndex(
    (part, index) => part !== NODE_MINIMUM_VERSION[index],
  );
  const isSupported =
    difference === -1 ||
    installed[difference]! > NODE_MINIMUM_VERSION[difference]!;
  if (isSupported) return undefined;
  return {
    prerequisite: "node",
    status: "unsupported-version",
    message: `Detected Node.js ${normalizedVersion}, but version 22.18.0 or later is required.`,
    remediation: NODE_REMEDIATION,
  };
}

export async function diagnoseMcpPrerequisites(
  runner: PrerequisiteCommandRunner = systemPrerequisiteCommandRunner,
): Promise<McpPrerequisiteDiagnostics> {
  const availability = await Promise.all(
    prerequisiteDefinitions.map(async (definition) => ({
      definition,
      isAvailable: await runner.isExecutableAvailable(definition.prerequisite),
    })),
  );
  const diagnostics = availability
    .filter(({ isAvailable }) => !isAvailable)
    .map(({ definition }) => createMissingDiagnostic(definition));

  if (
    availability.find(({ definition }) => definition.prerequisite === "dotnet")
      ?.isAvailable
  ) {
    const dotnetVersion = await runner.run("dotnet", ["--version"]);
    if (!dotnetVersion.succeeded) {
      diagnostics.push(createUnreadableDotnetVersionDiagnostic());
    } else {
      const versionDiagnostic = createDotnetVersionDiagnostic(
        dotnetVersion.stdout,
      );
      if (versionDiagnostic !== undefined) diagnostics.push(versionDiagnostic);
    }
  }

  if (
    availability.find(({ definition }) => definition.prerequisite === "node")
      ?.isAvailable
  ) {
    const nodeVersion = await runner.run("node", ["--version"]);
    const versionDiagnostic = nodeVersion.succeeded
      ? createNodeVersionDiagnostic(nodeVersion.stdout)
      : createUnreadableNodeVersionDiagnostic();
    if (versionDiagnostic !== undefined) diagnostics.push(versionDiagnostic);
  }

  return { isReady: diagnostics.length === 0, diagnostics };
}
