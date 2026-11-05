import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { runBuild } from "./build.js";
import { CliError, EXIT_BUILD_FAILED, EXIT_NONDETERMINISM } from "./errors.js";
import { manifestRoot } from "@unforged/core";

const REPO_URL = "https://example.invalid/fixture";

// A tiny "dapp": build.js writes out/ from the env file, plus random bytes when NONDET is set.
const BUILD_SCRIPT = `
const fs = require("fs");
fs.mkdirSync("out/runtime", { recursive: true });
fs.writeFileSync("out/index.html", "<html>" + fs.readFileSync("info.txt", "utf8") + "</html>");
fs.writeFileSync("out/runtime/window-env.js", "window.__env__=" + JSON.stringify({ A: process.env.A }));
for (let i = 0; i < 12; i++) {
  const content = process.env.NONDET ? String(Math.random()) : "stable";
  fs.writeFileSync("out/chunk-" + String(i).padStart(2, "0") + ".js", content);
}
console.log("BUILD LOG LINE");
`;
const FAKE_YARN = `
require("fs").appendFileSync("yarn-calls.txt", process.argv.slice(2).join(" ") + "\\n");
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixtureRepo(dir: string): string {
  mkdirSync(join(dir, ".yarn/releases"), { recursive: true });
  writeFileSync(join(dir, "build.js"), BUILD_SCRIPT);
  writeFileSync(join(dir, ".yarn/releases/yarn-9.9.9.cjs"), FAKE_YARN);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  return git(dir, "rev-parse", "HEAD");
}

describe("runBuild", () => {
  let root: string;
  let outDir: string;
  let buildPath: string;
  let commit: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unforged-build-"));
    outDir = join(root, "results");
    buildPath = join(root, "work/build");
    mkdirSync(outDir);
    const source = join(root, "source");
    mkdirSync(source);
    commit = createFixtureRepo(source);
    // Lets the recipe keep its https URL while git actually reads the local fixture.
    // HOME is one of the few host variables the build passes on, so git finds this config.
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), `[url "file://${source}"]\n\tinsteadOf = ${REPO_URL}\n`);
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function writeRecipe(overrides: Record<string, unknown> = {}): string {
    const path = join(root, "recipe.yaml");
    const recipe = {
      dapp: "fixture",
      release: "1.0.0",
      repo: REPO_URL,
      commit,
      node: process.versions.node.split(".")[0],
      packageManager: "yarn@9.9.9",
      files: { "info.txt": "from-recipe", "nested/dir/a.txt": "x" },
      env: { A: "from-env", B: "two" },
      envFile: ".env.local",
      buildPath,
      install: "yarn install --immutable",
      build: "node build.js",
      output: "out",
      configFiles: { "/runtime/window-env.js": { kind: "window-env-json", allowedKeys: ["A"] } },
      ...overrides,
    };
    writeFileSync(path, stringify(recipe));
    return path;
  }

  it("clones, writes files and env, builds, and writes a manifest whose hash is the root", async () => {
    const root_ = await runBuild(writeRecipe(), { outDir });

    const bytes = readFileSync(join(outDir, "manifest.json"));
    const manifest = JSON.parse(bytes.toString());
    expect(root_).toBe(await manifestRoot(manifest));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(root_);

    expect(manifest).toMatchObject({ version: 1, dapp: "fixture", release: "1.0.0", commit });
    expect(manifest.files["/index.html"]).toBe(
      createHash("sha256").update("<html>from-recipe</html>").digest("hex"),
    );
    expect(manifest.files["/runtime/window-env.js"]).toBeUndefined();
    expect(manifest.config["/runtime/window-env.js"].allowedKeys).toEqual(["A"]);

    expect(readFileSync(join(buildPath, ".env.local"), "utf8")).toBe("A=from-env\nB=two\n");
    expect(readFileSync(join(buildPath, "nested/dir/a.txt"), "utf8")).toBe("x");
  });

  it("passes recipe env to the build and sends build output to the log, not the console", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    await runBuild(writeRecipe(), { outDir });

    expect(readFileSync(join(outDir, "build.log"), "utf8")).toContain("BUILD LOG LINE");
    expect(readFileSync(join(buildPath, "out/runtime/window-env.js"), "utf8")).toBe(
      'window.__env__={"A":"from-env"}',
    );
    expect(stdout.mock.calls.join("")).not.toContain("BUILD LOG LINE");
    stdout.mockRestore();
  });

  it("runs yarn through the vendored release", async () => {
    await runBuild(writeRecipe(), { outDir });
    expect(readFileSync(join(buildPath, "yarn-calls.txt"), "utf8")).toBe("install --immutable\n");
  });

  it("refuses a non-empty buildPath without touching it", async () => {
    mkdirSync(buildPath, { recursive: true });
    writeFileSync(join(buildPath, "keep.txt"), "mine");

    await expect(runBuild(writeRecipe(), { outDir })).rejects.toMatchObject({
      exitCode: EXIT_BUILD_FAILED,
      message: expect.stringContaining("not empty"),
    });
    expect(readFileSync(join(buildPath, "keep.txt"), "utf8")).toBe("mine");
  });

  it("refuses a non-empty buildPath with --check too", async () => {
    mkdirSync(buildPath, { recursive: true });
    writeFileSync(join(buildPath, "keep.txt"), "mine");

    await expect(runBuild(writeRecipe(), { outDir, check: true })).rejects.toBeInstanceOf(CliError);
    expect(readFileSync(join(buildPath, "keep.txt"), "utf8")).toBe("mine");
  });

  it("accepts an existing empty buildPath", async () => {
    mkdirSync(buildPath, { recursive: true });
    await expect(runBuild(writeRecipe(), { outDir })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a node mismatch unless allowed", async () => {
    const recipe = writeRecipe({ node: "1" });
    await expect(runBuild(recipe, { outDir })).rejects.toMatchObject({
      exitCode: EXIT_BUILD_FAILED,
      message: expect.stringContaining("node"),
    });
    expect(existsSync(buildPath)).toBe(false);

    await expect(runBuild(recipe, { outDir, allowNodeMismatch: true })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("exits 2 when the build command fails and removes any older manifest", async () => {
    writeFileSync(join(outDir, "manifest.json"), "{}");
    await expect(runBuild(writeRecipe({ build: "exit 7" }), { outDir })).rejects.toMatchObject({
      exitCode: EXIT_BUILD_FAILED,
    });
    expect(existsSync(join(outDir, "manifest.json"))).toBe(false);
  });

  it("exits 2 when a declared config file was not produced", async () => {
    const configFiles = { "/missing.js": { kind: "window-env-json", allowedKeys: [] } };
    await expect(runBuild(writeRecipe({ configFiles }), { outDir })).rejects.toMatchObject({
      exitCode: EXIT_BUILD_FAILED,
      message: expect.stringContaining("/missing.js"),
    });
  });

  it("writes build-info.json describing the build, next to the manifest", async () => {
    const before = Date.now();
    const root_ = await runBuild(writeRecipe(), { outDir });
    const info = JSON.parse(readFileSync(join(outDir, "build-info.json"), "utf8"));

    expect(info).toEqual({
      manifestRoot: root_,
      node: process.version,
      packageManager: "yarn@9.9.9",
      os: `${process.platform}-${process.arch}`,
      builtAt: expect.any(String),
    });
    expect(new Date(info.builtAt).toISOString()).toBe(info.builtAt);
    expect(Date.parse(info.builtAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(info.builtAt)).toBeLessThanOrEqual(Date.now());
  });

  it("--check records the first build's time", async () => {
    const stamps = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValueOnce("2026-01-01T00:00:00.000Z")
      .mockReturnValueOnce("2026-01-02T00:00:00.000Z");
    await runBuild(writeRecipe(), { outDir, check: true });
    stamps.mockRestore();
    expect(JSON.parse(readFileSync(join(outDir, "build-info.json"), "utf8")).builtAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("removes an older build-info.json when the build fails", async () => {
    writeFileSync(join(outDir, "build-info.json"), "{}");
    await expect(runBuild(writeRecipe({ build: "exit 7" }), { outDir })).rejects.toThrow(CliError);
    expect(existsSync(join(outDir, "build-info.json"))).toBe(false);
  });

  it("--check writes no build-info.json when the builds differ", async () => {
    await expect(runBuild(writeRecipe({ env: { A: "1", NONDET: "1" } }), { outDir, check: true })).rejects.toThrow(CliError);
    expect(existsSync(join(outDir, "build-info.json"))).toBe(false);
  });

  it("--check passes on a deterministic build", async () => {
    const plain = await runBuild(writeRecipe(), { outDir });
    rmSync(buildPath, { recursive: true });
    await expect(runBuild(writeRecipe(), { outDir, check: true })).resolves.toBe(plain);
  });

  it("--check exits 3, reports the first 10 differing paths, and writes no manifest", async () => {
    const recipe = writeRecipe({ env: { A: "from-env", NONDET: "1" } });
    const failure = await runBuild(recipe, { outDir, check: true }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(CliError);
    const { exitCode, message } = failure as CliError;
    expect(exitCode).toBe(EXIT_NONDETERMINISM);
    expect(message).toContain("12 files differ");
    expect(message).toContain("/chunk-09.js");
    expect(message).not.toContain("/chunk-10.js");
    expect(existsSync(join(outDir, "manifest.json"))).toBe(false);
  });
});
