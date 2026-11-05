import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ConfigRule, type Manifest, manifestRoot } from "@unforged/core";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { describeMirrorSource, verifyMirrorDir } from "./mirror-source.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const RULE: ConfigRule = { kind: "window-env-json", allowedKeys: ["a"] };
const CONFIG_PATH = "/runtime/window-env.js";

const manifest: Manifest = {
  version: 1,
  dapp: "demo",
  release: "1.0.0",
  commit: "a".repeat(40),
  files: { "/index.html": sha256("<html>"), "/_next/[x].js": sha256("x()") },
  config: { [CONFIG_PATH]: RULE },
};

const recipe = {
  dapp: "demo",
  release: "1.0.0",
  repo: "https://github.com/example/demo",
  commit: "a".repeat(40),
  node: "24",
  packageManager: "yarn@4.17.1",
  files: {},
  env: {},
  envFile: ".env",
  buildPath: "/unforged/build",
  install: "true",
  build: "true",
  output: "out",
  configFiles: { [CONFIG_PATH]: RULE },
};

let root: string;
let dir: string;
let manifestPath: string;

function put(path: string, body: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unforged-mirror-"));
  dir = join(root, "out");
  mkdirSync(dir);
  put("/index.html", "<html>");
  put("/_next/[x].js", "x()");
  put(CONFIG_PATH, "window.__env__={}");
  manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
});

describe("verifyMirrorDir", () => {
  it("accepts a folder with exactly the manifest's files, plus its config files with any bytes", async () => {
    await expect(verifyMirrorDir(dir, manifestPath)).resolves.toBe(3);
  });

  it("refuses a changed file", async () => {
    put("/index.html", "<html>evil");
    await expect(verifyMirrorDir(dir, manifestPath)).rejects.toThrow(/\/index\.html/);
  });

  it("refuses a missing file", async () => {
    const without = join(root, "manifest-extra.json");
    writeFileSync(without, JSON.stringify({ ...manifest, files: { ...manifest.files, "/gone.js": sha256("g") } }));
    await expect(verifyMirrorDir(dir, without)).rejects.toThrow(/\/gone\.js/);
  });

  it("refuses a file the manifest doesn't list", async () => {
    put("/extra.js", "evil()");
    await expect(verifyMirrorDir(dir, manifestPath)).rejects.toThrow(/\/extra\.js/);
  });

  it("refuses a missing config file", async () => {
    const without = join(root, "manifest-config.json");
    writeFileSync(without, JSON.stringify({ ...manifest, config: { ...manifest.config, "/other.js": RULE } }));
    await expect(verifyMirrorDir(dir, without)).rejects.toThrow(/\/other\.js/);
  });

  it("refuses a symlink", async () => {
    symlinkSync(join(dir, "index.html"), join(dir, "link.html"));
    await expect(verifyMirrorDir(dir, manifestPath)).rejects.toThrow(/link\.html/);
  });

  it.each(["/LICENSE", "/SOURCE.md"])("refuses a build that serves %s, which the mirror would overwrite", async (path) => {
    put(path, "own");
    const clash = join(root, "manifest-clash.json");
    writeFileSync(clash, JSON.stringify({ ...manifest, files: { ...manifest.files, [path]: sha256("own") } }));
    await expect(verifyMirrorDir(dir, clash)).rejects.toThrow(new RegExp(path));
  });
});

describe("describeMirrorSource", () => {
  const writeRecipe = (overrides: object = {}) => {
    const path = join(root, "recipe.yaml");
    writeFileSync(path, stringify({ ...recipe, ...overrides }));
    return path;
  };

  it("gives the repo, commit and manifest root", async () => {
    await expect(describeMirrorSource(manifestPath, writeRecipe())).resolves.toEqual({
      repo: "https://github.com/example/demo",
      commit: manifest.commit,
      manifestRoot: await manifestRoot(manifest),
    });
  });

  it.each([
    ["dapp", { dapp: "other" }],
    ["release", { release: "2.0.0" }],
    ["commit", { commit: "b".repeat(40) }],
    ["config rules", { configFiles: {} }],
  ])("refuses a recipe with different %s", async (what, overrides) => {
    await expect(describeMirrorSource(manifestPath, writeRecipe(overrides))).rejects.toThrow(new RegExp(what));
  });
});
