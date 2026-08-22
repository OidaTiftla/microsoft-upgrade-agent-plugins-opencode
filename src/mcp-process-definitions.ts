import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface McpVersionPin {
  readonly package: string;
  readonly version: string;
}

export interface McpVersionManifest {
  readonly core: McpVersionPin;
  readonly dotnet: McpVersionPin;
  readonly typescript: McpVersionPin;
}

export interface CoreHostDiscovery {
  readonly hostDir: string;
  readonly pluginRoot: string;
}

export interface McpProcessDefinition {
  readonly name: "Upgrade";
  readonly command: "dnx";
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
}

export interface HostDiscoveryFiles {
  readonly hostExtendersPath: string;
  readonly extenders: readonly {
    readonly manifestPath: string;
    readonly skillsRoot: string;
  }[];
}

const DNX_TIMEOUT_MS = 300_000;
const PINNED_VERSION = /^\d+\.\d+\.\d+$/;
const extenderDefinitions = [
  { id: "upgrade-dotnet", pin: "dotnet", skillsRoot: "upgrade/skills" },
  { id: "upgrade-typescript", pin: "typescript", skillsRoot: "upgrade/skills" },
] as const;

function getVersionPin(
  manifest: Record<string, unknown>,
  name: string,
): McpVersionPin {
  const pin = manifest[name];
  if (pin === null || typeof pin !== "object") {
    throw new Error(`MCP version manifest requires ${name}.`);
  }

  const { package: packageName, version } = pin as Record<string, unknown>;
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new Error(`MCP version manifest requires ${name}.package.`);
  }
  if (typeof version !== "string" || !PINNED_VERSION.test(version)) {
    throw new Error(
      `MCP version manifest requires ${name}.version must be an explicit version.`,
    );
  }
  return { package: packageName, version };
}

function pinExtenderManifest(
  manifest: unknown,
  pin: McpVersionPin,
): Record<string, unknown> {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("Extender manifest must be an object.");
  }

  const source = manifest as Record<string, unknown>;
  const mcp = source.mcp;
  if (
    mcp === null ||
    typeof mcp !== "object" ||
    !Array.isArray((mcp as { args?: unknown }).args)
  ) {
    throw new Error("Extender manifest requires mcp.args.");
  }
  const args = (mcp as { args: unknown[] }).args;
  const packageIndex = args.findIndex((argument) => argument === pin.package);
  if (packageIndex < 0) {
    throw new Error(`Extender manifest does not reference ${pin.package}.`);
  }
  const pinnedArgs = [...args];
  pinnedArgs[packageIndex] = `${pin.package}@${pin.version}`;
  return {
    ...source,
    mcp: {
      ...(mcp as Record<string, unknown>),
      args: pinnedArgs,
    },
  };
}

export function parseMcpVersionManifest(manifest: unknown): McpVersionManifest {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("MCP version manifest must be an object.");
  }

  const pins = manifest as Record<string, unknown>;
  return {
    core: getVersionPin(pins, "core"),
    dotnet: getVersionPin(pins, "dotnet"),
    typescript: getVersionPin(pins, "typescript"),
  };
}

export async function loadMcpVersionManifest(
  path: URL | string,
): Promise<McpVersionManifest> {
  return parseMcpVersionManifest(JSON.parse(await readFile(path, "utf8")));
}

export function createCoreMcpProcessDefinition(
  manifest: McpVersionManifest,
  discovery: CoreHostDiscovery,
): McpProcessDefinition {
  return {
    name: "Upgrade",
    command: "dnx",
    args: [
      `${manifest.core.package}@${manifest.core.version}`,
      "--yes",
      "--ignore-failed-sources",
    ],
    env: {
      APPMOD_CALLER_TYPE: "copilot-cli",
      APPMOD_DISABLE_MCP_APPS: "true",
      APPMOD_DISABLE_TELEMETRY: "true",
      APPMOD_HOST_DIR: discovery.hostDir,
      MODERNIZE_ORCHESTRATOR_PLUGIN_ROOT: discovery.pluginRoot,
    },
    timeout_ms: DNX_TIMEOUT_MS,
  };
}

export async function writeHostDiscoveryFiles(
  hostDir: string,
  pluginRoot: string,
  manifest: McpVersionManifest,
): Promise<HostDiscoveryFiles> {
  await mkdir(hostDir, { recursive: true });
  const extenders = await Promise.all(
    extenderDefinitions.map(async ({ id, pin, skillsRoot }) => {
      const sourcePath = join(
        pluginRoot,
        "extenders",
        id,
        "upgrade-extension.json",
      );
      const manifestPath = join(
        hostDir,
        "extenders",
        id,
        "upgrade-extension.json",
      );
      const source = JSON.parse(await readFile(sourcePath, "utf8"));
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        `${JSON.stringify(pinExtenderManifest(source, manifest[pin]), null, 2)}\n`,
      );
      return {
        manifestPath,
        skillsRoot: join(pluginRoot, "extenders", id, skillsRoot),
      };
    }),
  );
  const hostExtendersPath = join(hostDir, "host-extenders.json");
  await writeFile(
    hostExtendersPath,
    `${JSON.stringify({ extenders }, null, 2)}\n`,
  );
  return { hostExtendersPath, extenders };
}
