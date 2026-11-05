import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatement, type Manifest, manifestRoot, type Recipe, statementDigest } from "@unforged/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPublish, type PublishClients } from "./publish.js";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

const manifest: Manifest = {
  version: 1,
  dapp: "demo",
  release: "1.0.0",
  commit: "a".repeat(40),
  files: { "/index.html": "b".repeat(64) },
  config: {},
};
const recipe = { repo: "https://example.com/repo", commit: manifest.commit, dapp: "demo" } as unknown as Recipe;
const toolchain = { node: "24.0.0", packageManager: "yarn@4", os: "linux-x64" };

async function signedBy(signer = account, m = manifest) {
  const statement = await buildStatement(m, recipe, signer.address, toolchain);
  return { statement, signature: await signer.signMessage({ message: { raw: await statementDigest(statement) } }) };
}

/** A query builder whose fetch returns the existing entity keys. */
function clients(existingKeys: string[] = []) {
  const query = {
    where: () => query,
    createdBy: vi.fn(() => query),
    limit: () => query,
    fetch: vi.fn(async () => ({ entities: existingKeys.map((k) => ({ key: k })), hasNextPage: () => false })),
  };
  const createEntity = vi.fn(async (_: unknown) => ({ entityKey: "0xnew", txHash: "0xtx", expiresAt: 1n }));
  const value = { read: { select: () => query, getEntity: vi.fn() }, write: { createEntity } };
  return { value: value as unknown as PublishClients, createEntity, query };
}

let attestationPath: string;
let manifestPath: string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "unforged-publish-"));
  attestationPath = join(dir, "attestation.json");
  manifestPath = join(dir, "manifest.json");
  writeFileSync(attestationPath, JSON.stringify(await signedBy()));
  writeFileSync(manifestPath, JSON.stringify(manifest));
});

const env = { BUILDER_PRIVATE_KEY: key };

describe("runPublish", () => {
  it("creates the entity with attributes from the verified attestation and swarm_ref none", async () => {
    const { value, createEntity, query } = clients();
    const result = await runPublish(attestationPath, manifestPath, { env, clients: value });

    expect(result).toEqual({ created: true, entityKey: "0xnew", txHash: "0xtx", creator: account.address });
    expect(query.createdBy).toHaveBeenCalledWith(account.address);
    const params = createEntity.mock.calls[0]?.[0] as { attributes: Record<string, unknown> };
    const { statement } = await signedBy();
    expect(params.attributes).toEqual({
      project: "unforged",
      entity_type: "attestation",
      dapp: "demo",
      release: "1.0.0",
      commit: manifest.commit,
      manifest_root: await manifestRoot(manifest),
      recipe_digest: statement.predicate.recipeDigest,
      swarm_ref: "none",
    });
  });

  it("is idempotent: an existing root for this creator publishes nothing", async () => {
    const { value, createEntity } = clients(["0xexisting"]);
    await expect(runPublish(attestationPath, manifestPath, { env, clients: value })).resolves.toEqual({
      created: false,
      entityKey: "0xexisting",
      creator: account.address,
    });
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("refuses an attestation signed by a different key, without spending gas", async () => {
    writeFileSync(attestationPath, JSON.stringify(await signedBy(privateKeyToAccount(generatePrivateKey()))));
    const { value, createEntity } = clients();
    await expect(runPublish(attestationPath, manifestPath, { env, clients: value })).rejects.toMatchObject({ exitCode: 1 });
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("refuses a manifest that isn't the attested one", async () => {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: { "/evil.js": "c".repeat(64) } }));
    const { value, createEntity } = clients();
    await expect(runPublish(attestationPath, manifestPath, { env, clients: value })).rejects.toThrow(/does not verify/);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("reports an RPC failure with the registry exit code", async () => {
    const { value, createEntity } = clients();
    createEntity.mockRejectedValue(new Error("rpc down"));
    await expect(runPublish(attestationPath, manifestPath, { env, clients: value })).rejects.toMatchObject({ exitCode: 4 });
  });
});
