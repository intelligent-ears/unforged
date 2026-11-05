import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { manifestRoot, type Manifest, type Recipe } from "@unforged/core";
import { z } from "zod";
import { CliError, EXIT_BAD_INPUT } from "./errors.js";
import { readJson } from "./files.js";

export const BUILD_INFO_FILE = "build-info.json";

const buildInfoSchema = z.strictObject({
  manifestRoot: z.string().regex(/^[0-9a-f]{64}$/),
  node: z.string().min(1),
  packageManager: z.string().min(1),
  os: z.string().min(1),
  builtAt: z.iso.datetime(),
});

/** What `unforged build` knows about a build and `unforged attest` can't work out later. */
export type BuildInfo = z.infer<typeof buildInfoSchema>;

export const currentOs = () => `${process.platform}-${process.arch}`;

export async function describeBuild(manifest: Manifest, recipe: Recipe, builtAt: string): Promise<BuildInfo> {
  return {
    manifestRoot: await manifestRoot(manifest),
    node: process.versions.node,
    packageManager: recipe.packageManager,
    os: currentOs(),
    builtAt,
  };
}

/** The build-info.json beside a manifest, or null if there is none. It must describe that manifest. */
export function readBuildInfo(manifestPath: string, root: string): BuildInfo | null {
  const path = join(dirname(manifestPath), BUILD_INFO_FILE);
  if (!existsSync(path)) return null;

  const result = buildInfoSchema.safeParse(readJson(path));
  if (!result.success) throw new CliError(EXIT_BAD_INPUT, `${path} is not valid:\n${z.prettifyError(result.error)}`);
  if (result.data.manifestRoot !== root) {
    throw new CliError(EXIT_BAD_INPUT, `${path} describes another manifest: ${result.data.manifestRoot}, not ${root}`);
  }
  return result.data;
}
