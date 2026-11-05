import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, type Manifest, type Recipe } from "@unforged/core";
import { CliError, EXIT_BUILD_FAILED } from "./errors.js";

/** Served paths ("/a/b.js") of every file under `dir`. Anything but a regular file is refused. */
function listServedPaths(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return listServedPaths(dir, path);
    if (entry.isFile()) return [path];
    throw new CliError(EXIT_BUILD_FAILED, `output contains something that is not a regular file: ${path}`);
  });
}

export async function hashOutput(recipe: Pick<Recipe, "dapp" | "release" | "commit" | "configFiles">, outputDir: string): Promise<Manifest> {
  const served = listServedPaths(outputDir);
  if (served.length === 0) throw new CliError(EXIT_BUILD_FAILED, `build output is empty: ${outputDir}`);

  for (const path of Object.keys(recipe.configFiles)) {
    if (!served.includes(path)) throw new CliError(EXIT_BUILD_FAILED, `config file not in build output: ${path}`);
  }

  const files: Record<string, string> = {};
  for (const path of served) {
    if (!(path in recipe.configFiles)) files[path] = await sha256Hex(readFileSync(join(outputDir, path)));
  }
  return {
    version: 1,
    dapp: recipe.dapp,
    release: recipe.release,
    commit: recipe.commit,
    files,
    config: recipe.configFiles,
  };
}

/** Sorted paths whose hash differs between two manifests, including added and removed ones. */
export function diffFiles(a: Manifest, b: Manifest): string[] {
  const paths = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  return [...paths].filter((path) => a.files[path] !== b.files[path]).sort();
}
