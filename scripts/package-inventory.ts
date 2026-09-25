import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const AGENTS_DIRECTORY = "plugins/upgrade-agent/agents";
const UPGRADE_DIRECTORY = "plugins/upgrade-agent/upgrade";
const RUNTIME_SOURCE_EXTENSIONS = new Set([".ts", ".json", ".md"]);

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : [path];
      }),
  );
  return paths.flat();
}

function toPackagePath(packageRoot: string, path: string): string {
  return relative(packageRoot, path).split(sep).join("/");
}

export async function getRuntimeAssetPaths(
  packageRoot: string,
): Promise<readonly string[]> {
  const agentPaths = (
    await listFiles(join(packageRoot, AGENTS_DIRECTORY))
  ).filter((path) => path.endsWith(".agent.md"));
  const sourcePaths = (await listFiles(join(packageRoot, "src"))).filter(
    (path) => RUNTIME_SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))),
  );
  const upgradePaths = await listFiles(join(packageRoot, UPGRADE_DIRECTORY));
  return [...new Set([...agentPaths, ...sourcePaths, ...upgradePaths])]
    .map((path) => toPackagePath(packageRoot, path))
    .sort();
}

export function parseNpmPackFiles(output: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("npm pack produced invalid JSON output.");
  }
  const pack = Array.isArray(value) ? value[0] : undefined;
  if (pack === null || typeof pack !== "object" || !Array.isArray(pack.files))
    throw new Error("npm pack JSON did not include a files array.");
  const paths: string[] = [];
  for (const file of pack.files as unknown[]) {
    const path =
      file !== null && typeof file === "object"
        ? (file as { path?: unknown }).path
        : undefined;
    if (typeof path !== "string" || path.length === 0)
      throw new Error("npm pack JSON included a file without a path.");
    paths.push(path);
  }
  return paths;
}

export function validatePackageInventory(
  runtimeAssets: readonly string[],
  packedFiles: readonly string[],
): void {
  const packed = new Set(packedFiles);
  const missing = runtimeAssets.filter((path) => !packed.has(path));
  if (missing.length > 0) {
    throw new Error(
      `npm pack omitted required runtime assets:\n${missing.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  const runtime = new Set(runtimeAssets);
  const unexpected = packedFiles.filter(
    (path) =>
      !runtime.has(path) &&
      path !== "package.json" &&
      !/(^|\/)README(?:\.[^/]+)?$/i.test(path) &&
      !/(^|\/)LICENSE(?:\.[^/]+)?$/i.test(path),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `npm pack included non-runtime assets:\n${unexpected.map((path) => `- ${path}`).join("\n")}`,
    );
  }
}
