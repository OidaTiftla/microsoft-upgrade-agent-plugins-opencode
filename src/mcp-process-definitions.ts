import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface McpVersionPin {
  readonly package: string;
  readonly version: string;
}

export type McpVersionManifest = Readonly<Record<string, McpVersionPin>>;

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

function getExtenderPackage(
  id: string,
  manifest: unknown,
  pins: readonly McpVersionPin[],
): { packageIndex: number; pin: McpVersionPin } {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error(`Extender ${id} manifest must be an object.`);
  }

  const source = manifest as Record<string, unknown>;
  const mcp = source.mcp;
  if (
    mcp === null ||
    typeof mcp !== "object" ||
    !Array.isArray((mcp as { args?: unknown }).args)
  ) {
    throw new Error(`Extender ${id} manifest requires mcp.args.`);
  }
  const args = (mcp as { args: unknown[] }).args;
  if (args.some((argument) => typeof argument !== "string"))
    throw new Error(`Extender ${id} manifest requires string mcp.args.`);

  const matches = args.flatMap((argument, packageIndex) =>
    pins
      .filter((pin) => pin.package === argument)
      .map((pin) => ({ packageIndex, pin })),
  );
  if (matches.length === 0)
    throw new Error(
      `Extender ${id} has an unpinned MCP package argument. Add an explicit pin to src/mcp-versions.json.`,
    );
  if (matches.length !== 1)
    throw new Error(`Extender ${id} must reference exactly one MCP package.`);
  return matches[0];
}

async function loadExtenderManifest(
  id: string,
  path: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Extender ${id} requires upgrade-extension.json.`);
    if (error instanceof SyntaxError)
      throw new Error(`Extender ${id} has invalid upgrade-extension.json.`);
    throw error;
  }
}

function pinExtenderManifest(
  manifest: Record<string, unknown>,
  packageIndex: number,
  pin: McpVersionPin,
): Record<string, unknown> {
  const mcp = manifest.mcp as Record<string, unknown>;
  const args = mcp.args as unknown[];
  const pinnedArgs = [...args];
  pinnedArgs[packageIndex] = `${pin.package}@${pin.version}`;
  return {
    ...manifest,
    mcp: {
      ...mcp,
      args: pinnedArgs,
    },
  };
}

export function parseMcpVersionManifest(manifest: unknown): McpVersionManifest {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("MCP version manifest must be an object.");
  }

  const pins = manifest as Record<string, unknown>;
  const parsed = Object.fromEntries(
    Object.keys(pins)
      .sort()
      .map((name) => [name, getVersionPin(pins, name)]),
  );
  const packages = Object.values(parsed).map(
    ({ package: packageName }) => packageName,
  );
  if (new Set(packages).size !== packages.length)
    throw new Error("MCP version manifest packages must be unique.");
  getVersionPin(parsed, "core");
  return parsed;
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
  const core = getVersionPin(manifest, "core");
  return {
    name: "Upgrade",
    command: "dnx",
    args: [
      `${core.package}@${core.version}`,
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
  const extendersRoot = join(pluginRoot, "extenders");
  const extenderIds = (await readdir(extendersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const extenders = await Promise.all(
    extenderIds.map(async (id) => {
      const sourcePath = join(extendersRoot, id, "upgrade-extension.json");
      const manifestPath = join(
        hostDir,
        "extenders",
        id,
        "upgrade-extension.json",
      );
      const source = await loadExtenderManifest(id, sourcePath);
      const { packageIndex, pin } = getExtenderPackage(
        id,
        source,
        Object.values(manifest),
      );
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        `${JSON.stringify(pinExtenderManifest(source, packageIndex, pin), null, 2)}\n`,
      );
      return {
        manifestPath,
        skillsRoot: join(extendersRoot, id, "upgrade", "skills"),
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
