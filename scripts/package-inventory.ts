import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const AGENTS_DIRECTORY = "plugins/upgrade-agent/agents";
const EXTENDERS_DIRECTORY = "plugins/upgrade-agent/extenders";
const SKILLS_DIRECTORY = "plugins/upgrade-agent/upgrade/skills";
const RUNTIME_DIRECTORIES = ["src", EXTENDERS_DIRECTORY, SKILLS_DIRECTORY];

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
  const runtimePaths = await Promise.all(
    RUNTIME_DIRECTORIES.map((directory) =>
      listFiles(join(packageRoot, directory)),
    ),
  );
  return [...new Set([...agentPaths, ...runtimePaths.flat()])]
    .map((path) => toPackagePath(packageRoot, path))
    .sort();
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
