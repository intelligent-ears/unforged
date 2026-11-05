import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest, manifestRoot, recipeDigest, type SignedAttestation, verifyAttestation } from "@unforged/core";
import { stringify } from "yaml";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { runAttest } from "./attest.js";
import { CliError } from "./errors.js";
import { parseRecipe } from "./recipe.js";

const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;

const recipe = {
  dapp: "demo",
  release: "1.0.0",
  repo: "https://example.com/repo",
  commit: "a".repeat(40),
  node: "24",
  packageManager: "yarn@4.17.1",
  files: {},
  env: {},
  envFile: ".env",
  buildPath: "/unforged/build",
  install: "yarn",
  build: "yarn build",
  output: "out",
  configFiles: {},
};
const manifest: Manifest = {
  version: 1,
  dapp: "demo",
  release: "1.0.0",
  commit: "a".repeat(40),
  files: { "/index.html": "b".repeat(64) },
  config: {},
};

let dir: string;
let manifestPath: string;
let recipePath: string;

const BUILT_AT = "2026-11-05T17:26:52.000Z";

async function buildInfo() {
  return { manifestRoot: await manifestRoot(manifest), node: "24.22.2", packageManager: "yarn@4.17.1", os: "linux-x64", builtAt: BUILT_AT };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "unforged-attest-"));
  manifestPath = join(dir, "manifest.json");
  recipePath = join(dir, "recipe.yaml");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(recipePath, stringify(recipe));
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(await buildInfo()));
});

const attest = (env: NodeJS.ProcessEnv = { BUILDER_PRIVATE_KEY: key }, options: { toolchainFromHost?: boolean } = {}) =>
  runAttest(manifestPath, recipePath, { outDir: dir, env, ...options });
const written = () => JSON.parse(readFileSync(join(dir, "attestation.json"), "utf8")) as SignedAttestation;

describe("runAttest", () => {
  it("writes an attestation that verifies with core", async () => {
    await attest();
    const attestation = written();

    await expect(verifyAttestation(attestation, address)).resolves.toBe(true);
    expect(attestation.statement.subject).toEqual([{ name: "demo@1.0.0", digest: { sha256: await manifestRoot(manifest) } }]);
    expect(attestation.statement.predicate).toMatchObject({
      repo: recipe.repo,
      commit: recipe.commit,
      builder: address,
      recipeDigest: await recipeDigest(parseRecipe(stringify(recipe))),
    });
    expect(attestation.statement.predicate.toolchain.packageManager).toBe("yarn@4.17.1");
  });

  it("describes the build from build-info.json, not the signing", async () => {
    await attest();
    const { predicate } = written().statement;
    expect(predicate.toolchain).toEqual({ node: "24.22.2", packageManager: "yarn@4.17.1", os: "linux-x64" });
    expect(predicate.builtAt).toBe(BUILT_AT);
  });

  it("reads build-info.json from the manifest's directory, not the output directory", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "unforged-attest-out-"));
    await runAttest(manifestPath, recipePath, { outDir, env: { BUILDER_PRIVATE_KEY: key } });
    const out = JSON.parse(readFileSync(join(outDir, "attestation.json"), "utf8")) as SignedAttestation;
    expect(out.statement.predicate.builtAt).toBe(BUILT_AT);
  });

  it("refuses when build-info.json describes another manifest, writing nothing", async () => {
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ ...(await buildInfo()), manifestRoot: "f".repeat(64) }));
    await expect(attest()).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/build-info\.json.*another manifest/) });
    expect(existsSync(join(dir, "attestation.json"))).toBe(false);
  });

  it("refuses that mismatch even with --toolchain-from-host", async () => {
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ ...(await buildInfo()), manifestRoot: "f".repeat(64) }));
    await expect(attest(undefined, { toolchainFromHost: true })).rejects.toThrow(/another manifest/);
  });

  it("refuses a missing build-info.json, naming the flag", async () => {
    rmSync(join(dir, "build-info.json"));
    await expect(attest()).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/--toolchain-from-host/) });
    expect(existsSync(join(dir, "attestation.json"))).toBe(false);
  });

  it("uses the current process when build-info.json is missing and --toolchain-from-host is given", async () => {
    rmSync(join(dir, "build-info.json"));
    const before = Date.now();
    await attest(undefined, { toolchainFromHost: true });
    const { statement } = written();
    expect(statement.predicate.toolchain).toEqual({
      node: process.versions.node,
      packageManager: "yarn@4.17.1",
      os: `${process.platform}-${process.arch}`,
    });
    expect(Date.parse(statement.predicate.builtAt)).toBeGreaterThanOrEqual(before);
    await expect(verifyAttestation(written(), address)).resolves.toBe(true);
  });

  it("prefers build-info.json when it exists, even with --toolchain-from-host", async () => {
    await attest(undefined, { toolchainFromHost: true });
    expect(written().statement.predicate.builtAt).toBe(BUILT_AT);
  });

  it.each([
    ["isn't JSON", "not json"],
    ["lacks fields", "{}"],
    ["has an unparseable time", null],
  ])("refuses a build-info.json that %s", async (_, content) => {
    const bad = content ?? JSON.stringify({ ...(await buildInfo()), builtAt: "yesterday" });
    writeFileSync(join(dir, "build-info.json"), bad);
    await expect(attest()).rejects.toMatchObject({ exitCode: 1 });
    expect(existsSync(join(dir, "attestation.json"))).toBe(false);
  });

  it("returns the root and builder for the summary", async () => {
    await expect(attest()).resolves.toMatchObject({ manifestRoot: await manifestRoot(manifest), builder: address });
  });

  it.each([
    ["dapp", { dapp: "other" }],
    ["release", { release: "2.0.0" }],
    ["commit", { commit: "c".repeat(40) }],
    ["config", { config: { "/x.js": { kind: "window-env-json", allowedKeys: [] } } }],
  ])("refuses a manifest whose %s doesn't match the recipe", async (field, change) => {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...change }));
    await expect(attest()).rejects.toThrow(new RegExp(field));
  });

  it("fails when the key is missing", async () => {
    await expect(attest({})).rejects.toThrow(/BUILDER_PRIVATE_KEY is not set/);
  });

  it("never repeats a malformed key in its error", async () => {
    const bad = "0xnotahexkeybutstillsecret";
    const error = await attest({ BUILDER_PRIVATE_KEY: bad }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toMatch(/BUILDER_PRIVATE_KEY/);
    expect((error as Error).message).not.toContain("notahex");
  });

  it("never writes the key", async () => {
    await attest();
    expect(readFileSync(join(dir, "attestation.json"), "utf8")).not.toContain(key.slice(2));
  });

  it("reports an unreadable manifest as bad input", async () => {
    manifestPath = join(dir, "missing.json");
    await expect(attest()).rejects.toMatchObject({ exitCode: 1 });
  });
});
