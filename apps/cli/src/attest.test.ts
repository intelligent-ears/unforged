import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unforged-attest-"));
  manifestPath = join(dir, "manifest.json");
  recipePath = join(dir, "recipe.yaml");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(recipePath, stringify(recipe));
});

const attest = (env: NodeJS.ProcessEnv = { BUILDER_PRIVATE_KEY: key }) => runAttest(manifestPath, recipePath, { outDir: dir, env });

describe("runAttest", () => {
  it("writes an attestation that verifies with core", async () => {
    await attest();
    const written = JSON.parse(readFileSync(join(dir, "attestation.json"), "utf8")) as SignedAttestation;

    await expect(verifyAttestation(written, address)).resolves.toBe(true);
    expect(written.statement.subject).toEqual([{ name: "demo@1.0.0", digest: { sha256: await manifestRoot(manifest) } }]);
    expect(written.statement.predicate).toMatchObject({
      repo: recipe.repo,
      commit: recipe.commit,
      builder: address,
      recipeDigest: await recipeDigest(parseRecipe(stringify(recipe))),
    });
    expect(written.statement.predicate.toolchain.packageManager).toBe("yarn@4.17.1");
    expect(written.statement.predicate.toolchain.node).toBe(process.versions.node);
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
