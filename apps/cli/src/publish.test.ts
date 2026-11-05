import { createHash } from "node:crypto";
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
const TX_PARAMS = { nonce: 3, gas: 1_000_000n, gasPrice: 1n };
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
    fetch: vi.fn(async () => ({ entities: existingKeys.map((k) => ({ $key: k })), blockNumber: 1n, skipped: 0 })),
  };
  const createEntity = vi.fn(async (..._: unknown[]) => ({ entityKey: "0xnew", txHash: "0xtx", expiresAt: 1n }));
  const prepare = vi.fn(async () => TX_PARAMS);
  const value = { read: { select: () => query, getEntity: vi.fn() }, write: { createEntity }, prepare };
  return { value: value as unknown as PublishClients, createEntity, query, prepare };
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
    const { payload: _, ...attributes } = createEntity.mock.calls[0]?.[1] as Record<string, unknown>;
    const { statement } = await signedBy();
    expect(attributes).toEqual({
      project: "unforged",
      entity_type: "attestation",
      content_type: "application/gzip",
      dapp: "demo",
      release: "1.0.0",
      commit: manifest.commit,
      manifest_root: await manifestRoot(manifest),
      recipe_digest: statement.predicate.recipeDigest,
      swarm_ref: "none",
    });
  });

  it("sends the explicit transaction parameters from prepare", async () => {
    const { value, createEntity, prepare } = clients();
    await runPublish(attestationPath, manifestPath, { env, clients: value });
    expect(prepare).toHaveBeenCalledOnce();
    expect(createEntity.mock.calls[0]?.[3]).toEqual(TX_PARAMS);
  });

  it("needs an access key to reach the registry", async () => {
    await expect(runPublish(attestationPath, manifestPath, { env })).rejects.toThrow(/ARKIV_ACCESS_KEY is not set/);
  });

  it("is idempotent: an existing root for this creator publishes nothing", async () => {
    const { value, createEntity } = clients(["0xexisting"]);
    await expect(runPublish(attestationPath, manifestPath, { env, clients: value })).resolves.toEqual({
      created: false,
      entityKey: "0xexisting",
      creator: account.address,
      swarmRef: null,
    });
    expect(createEntity).not.toHaveBeenCalled();
  });

  describe("with a mirror", () => {
    const GATEWAY = "https://mirror.example/";
    const REF = "demo-1.0.0";
    const BODY = "<html>";
    const mirrored = { ...manifest, files: { "/index.html": createHash("sha256").update(BODY).digest("hex") } };
    const mirror = { mirrorRef: REF, gateway: GATEWAY };
    const serving = (body: string, status = 200) => vi.fn(async (_: string | URL | Request) => new Response(body, { status }));

    beforeEach(async () => {
      writeFileSync(manifestPath, JSON.stringify(mirrored));
      writeFileSync(attestationPath, JSON.stringify(await signedBy(account, mirrored)));
    });

    it("stores the ref in swarm_ref when the mirror check passes", async () => {
      const { value, createEntity } = clients();
      const fetch = serving(BODY);
      await runPublish(attestationPath, manifestPath, { env, clients: value, fetch, ...mirror });

      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]?.[0])).toBe(`${GATEWAY}${REF}/index.html`);
      expect((createEntity.mock.calls[0]?.[1] as Record<string, unknown>).swarm_ref).toBe(REF);
    });

    it.each([
      ["a mismatch", "tampered", 200],
      ["a 404", "", 404],
    ])("refuses on %s, with exit 3, before touching the registry", async (_, body, status) => {
      const { value, createEntity, query } = clients();
      const refused = runPublish(attestationPath, manifestPath, { env, clients: value, fetch: serving(body, status), ...mirror });

      await expect(refused).rejects.toMatchObject({ exitCode: 3, message: expect.stringContaining("0/1 match") });
      expect(query.fetch).not.toHaveBeenCalled();
      expect(createEntity).not.toHaveBeenCalled();
    });

    it("doesn't fetch the mirror for an attestation that doesn't verify", async () => {
      writeFileSync(attestationPath, JSON.stringify(await signedBy(privateKeyToAccount(generatePrivateKey()), mirrored)));
      const fetch = serving(BODY);
      await expect(runPublish(attestationPath, manifestPath, { env, clients: clients().value, fetch, ...mirror })).rejects.toThrow(/does not verify/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["--mirror-ref", { mirrorRef: REF }],
      ["--gateway", { gateway: GATEWAY }],
    ])("refuses %s alone rather than publishing with no mirror", async (_, partial) => {
      const { value, createEntity } = clients();
      await expect(runPublish(attestationPath, manifestPath, { env, clients: value, ...partial })).rejects.toMatchObject({ exitCode: 1 });
      expect(createEntity).not.toHaveBeenCalled();
    });

    it("stays idempotent, and reports the ref the existing entity really holds", async () => {
      const { value, createEntity, query } = clients(["0xexisting"]);
      query.fetch.mockResolvedValue({ entities: [{ $key: "0xexisting", swarm_ref: { type: "str", value: "none" } }], blockNumber: 1n, skipped: 0 } as never);
      const result = await runPublish(attestationPath, manifestPath, { env, clients: value, fetch: serving(BODY), ...mirror });

      expect(result).toEqual({ created: false, entityKey: "0xexisting", creator: account.address, swarmRef: null });
      expect(createEntity).not.toHaveBeenCalled();
    });

    it("never fetches without a mirror", async () => {
      const fetch = serving(BODY);
      await runPublish(attestationPath, manifestPath, { env, clients: clients().value, fetch });
      expect(fetch).not.toHaveBeenCalled();
    });
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
