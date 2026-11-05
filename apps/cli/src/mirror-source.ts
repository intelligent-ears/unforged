// The checks scripts/publish-mirror.sh runs before it writes anything.
import { canonicalJSON, manifestRoot } from "@unforged/core";
import { CliError, EXIT_MIRROR_MISMATCH } from "./errors.js";
import { readManifest, readText } from "./files.js";
import { diffFiles, hashOutput } from "./manifest.js";
import { parseRecipe } from "./recipe.js";

const ADDED_BY_THE_MIRROR = ["/LICENSE", "/SOURCE.md"];

/**
 * Refuses unless `dir` holds exactly the manifest's files. Config files only have to be there:
 * their bytes are pinned in the policy, not the manifest. Returns how many files it holds.
 */
export async function verifyMirrorDir(dir: string, manifestPath: string): Promise<number> {
  const manifest = readManifest(manifestPath);
  const clashes = ADDED_BY_THE_MIRROR.filter((path) => path in manifest.files || path in manifest.config);
  if (clashes.length > 0) throw new CliError(EXIT_MIRROR_MISMATCH, `the build serves paths the mirror adds itself: ${clashes.join(", ")}`);

  const actual = await hashOutput({ ...manifest, configFiles: manifest.config }, dir);
  const differing = diffFiles(actual, manifest);
  if (differing.length > 0) throw new CliError(EXIT_MIRROR_MISMATCH, `${dir} does not match the manifest:\n  ${differing.join("\n  ")}`);
  return Object.keys(manifest.files).length + Object.keys(manifest.config).length;
}

/** What a mirror's SOURCE.md records. Refuses a recipe that can't be the one this manifest came from. */
export async function describeMirrorSource(manifestPath: string, recipePath: string): Promise<{ repo: string; commit: string; manifestRoot: string }> {
  const manifest = readManifest(manifestPath);
  const recipe = parseRecipe(readText(recipePath));

  const differs = (what: string, a: unknown, b: unknown) => {
    if (canonicalJSON(a) !== canonicalJSON(b)) throw new CliError(EXIT_MIRROR_MISMATCH, `${recipePath} has different ${what} than the manifest`);
  };
  differs("dapp", recipe.dapp, manifest.dapp);
  differs("release", recipe.release, manifest.release);
  differs("commit", recipe.commit, manifest.commit);
  differs("config rules", recipe.configFiles, manifest.config);

  return { repo: recipe.repo, commit: recipe.commit, manifestRoot: await manifestRoot(manifest) };
}
