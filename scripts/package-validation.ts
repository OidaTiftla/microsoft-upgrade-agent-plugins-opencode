import { spawn } from "node:child_process";

import {
  getRuntimeAssetPaths,
  parseNpmPackFiles,
  validatePackageInventory,
} from "./package-inventory.ts";
import { createNpmCommand } from "./npm-command.ts";

async function runNpmPack(): Promise<string> {
  const npmCommand = createNpmCommand([
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
  ]);
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand.command, npmCommand.args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`npm pack failed with exit code ${code}:\n${stderr}`));
    });
  });
}

const output = await runNpmPack();
const runtimeAssets = await getRuntimeAssetPaths(process.cwd());
const packedFiles = parseNpmPackFiles(output);
validatePackageInventory(runtimeAssets, packedFiles);
process.stdout.write(
  `${JSON.stringify({ runtimeAssets: runtimeAssets.length, packedFiles: packedFiles.length })}\n`,
);
