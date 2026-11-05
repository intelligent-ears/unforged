import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJSON, manifestRoot, type Manifest, type Recipe } from "@unforged/core";
import { BUILD_INFO_FILE, describeBuild } from "./build-info.js";
import { buildEnv, hostEnv } from "./env.js";
import { CliError, EXIT_BUILD_FAILED, EXIT_NONDETERMINISM } from "./errors.js";
import { diffFiles, hashOutput } from "./manifest.js";
import { nodeVersionMatches, parseRecipe, resolveYarn } from "./recipe.js";

const MAX_REPORTED_PATHS = 10;

export interface BuildOptions {
  check?: boolean;
  allowNodeMismatch?: boolean;
  /** Where manifest.json, build-info.json and build.log go. Never inside buildPath, which --check deletes. */
  outDir?: string;
}

interface StepOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: number;
}

/** Builds the recipe and writes manifest.json and build-info.json. Returns the manifestRoot; throws CliError on failure. */
export async function runBuild(recipePath: string, options: BuildOptions = {}): Promise<string> {
  const { check = false, allowNodeMismatch = false, outDir = process.cwd() } = options;
  const recipe = parseRecipe(readFileSync(recipePath, "utf8"));
  assertNodeVersion(recipe, allowNodeMismatch);
  assertEmptyOrMissing(recipe.buildPath);

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.json");
  const buildInfoPath = join(outDir, BUILD_INFO_FILE);
  // A failed run must not leave an older manifest to attest, or facts about an older build.
  rmSync(manifestPath, { force: true });
  rmSync(buildInfoPath, { force: true });
  const log = openSync(join(outDir, "build.log"), "w");
  try {
    const { manifest, builtAt } = await buildOnce(recipe, log);
    if (check) {
      rmSync(recipe.buildPath, { recursive: true }); // only reached after this run cloned into it
      await assertSameBuild(manifest, (await buildOnce(recipe, log)).manifest);
    }
    writeFileSync(manifestPath, canonicalJSON(manifest));
    writeFileSync(buildInfoPath, canonicalJSON(await describeBuild(manifest, recipe, builtAt)));
    return await manifestRoot(manifest);
  } finally {
    closeSync(log);
  }
}

function assertNodeVersion(recipe: Recipe, allowMismatch: boolean): void {
  const actual = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
  if (allowMismatch || nodeVersionMatches(recipe.node, actual)) return;
  throw new CliError(
    EXIT_BUILD_FAILED,
    `node ${actual} does not match recipe node ${recipe.node} (use --allow-node-mismatch to override)`,
  );
}

function assertEmptyOrMissing(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0) throw new CliError(EXIT_BUILD_FAILED, `buildPath is not empty: ${dir}`);
}

async function assertSameBuild(first: Manifest, second: Manifest): Promise<void> {
  const [rootA, rootB] = await Promise.all([manifestRoot(first), manifestRoot(second)]);
  if (rootA === rootB) return;
  const differing = diffFiles(first, second);
  const shown = differing.slice(0, MAX_REPORTED_PATHS).join("\n  ");
  throw new CliError(
    EXIT_NONDETERMINISM,
    `nondeterministic build: ${rootA} != ${rootB}\n${differing.length} files differ:\n  ${shown}`,
  );
}

async function buildOnce(recipe: Recipe, log: number): Promise<{ manifest: Manifest; builtAt: string }> {
  const repoDir = recipe.buildPath;
  await clone(recipe, log);
  writeRecipeFiles(recipe);

  const step = { cwd: repoDir, env: buildEnv(recipe), log };
  await runShell("install", resolveYarn(recipe.install, recipe.packageManager, repoDir), step);
  await runShell("build", resolveYarn(recipe.build, recipe.packageManager, repoDir), step);
  const manifest = await hashOutput(recipe, join(repoDir, recipe.output));
  return { manifest, builtAt: new Date().toISOString() };
}

/** Fetches only the pinned commit: `git clone --branch` can't take a hash. */
async function clone(recipe: Recipe, log: number): Promise<void> {
  mkdirSync(recipe.buildPath, { recursive: true });
  const step = { cwd: recipe.buildPath, env: { ...hostEnv(), GIT_TERMINAL_PROMPT: "0" }, log };
  progress(`cloning ${recipe.repo} at ${recipe.commit}`);
  await runProcess("clone", "git", ["init", "-q"], step);
  await runProcess("clone", "git", ["remote", "add", "origin", recipe.repo], step);
  await runProcess("clone", "git", ["fetch", "-q", "--depth", "1", "origin", recipe.commit], step);
  await runProcess("clone", "git", ["-c", "core.autocrlf=false", "checkout", "-q", "FETCH_HEAD"], step);
}

function writeRecipeFiles(recipe: Recipe): void {
  for (const [path, content] of Object.entries(recipe.files)) {
    writeInRepo(recipe, path, content);
  }
  const envLines = Object.entries(recipe.env).map(([key, value]) => `${key}=${value}\n`);
  writeInRepo(recipe, recipe.envFile, envLines.join(""));
}

function writeInRepo(recipe: Recipe, path: string, content: string): void {
  const target = join(recipe.buildPath, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runShell(label: string, command: string, step: StepOptions): Promise<void> {
  progress(`${label}: ${command}`);
  return runProcess(label, "/bin/sh", ["-c", command], step);
}

function runProcess(label: string, file: string, args: string[], { cwd, env, log }: StepOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", log, log] });
    child.on("error", (error) => reject(new CliError(EXIT_BUILD_FAILED, `${label} failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new CliError(EXIT_BUILD_FAILED, `${label} failed (${signal ?? `exit ${code}`}), see build.log`));
    });
  });
}

function progress(message: string): void {
  process.stderr.write(`unforged: ${message}\n`);
}
