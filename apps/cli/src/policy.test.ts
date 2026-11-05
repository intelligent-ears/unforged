import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePayload, encodePayload, type ReadClient, type WriteClient } from "@unforged/registry";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPolicy } from "./policy.js";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const builders = [generatePrivateKey(), generatePrivateKey()].map((k) => privateKeyToAccount(k).address);

const policy = {
  dapp: "demo",
  origins: ["http://localhost:8080"],
  repo: "https://example.com/repo",
  builders,
  threshold: 2,
  acceptLatest: 3,
  thirdParty: {},
  recovery: { gateway: "TODO" },
};

function clients(existing: { dapp: string; version: bigint }[] = []) {
  const entities = existing.map(({ dapp, version }) => ({
    payload: encodePayload({ ...policy, dapp }),
    attributes: { version: { type: "u64", value: version } },
  }));
  const query = {
    where: () => query,
    createdBy: vi.fn(() => query),
    limit: () => query,
    fetch: async () => ({ entities, hasNextPage: () => false }),
  };
  const createEntity = vi.fn(async (_: unknown) => ({ entityKey: "0xnew", txHash: "0xtx", expiresAt: 1n }));
  return {
    value: {
      read: { select: () => query, getEntity: vi.fn() } as unknown as ReadClient,
      write: { createEntity } as unknown as WriteClient,
    },
    createEntity,
    query,
  };
}

let path: string;
const env = { CURATOR_PRIVATE_KEY: key };
const write = (value: unknown) => writeFileSync(path, JSON.stringify(value));

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "unforged-policy-")), "policy.json");
  write(policy);
});

describe("runPolicy", () => {
  it("starts at version 1, reading only this curator's policies", async () => {
    const { value, createEntity, query } = clients();
    await expect(runPolicy(path, { env, clients: value })).resolves.toEqual({
      entityKey: "0xnew",
      txHash: "0xtx",
      version: 1,
      curator: account.address,
    });
    expect(query.createdBy).toHaveBeenCalledWith(account.address);
    const params = createEntity.mock.calls[0]?.[0] as { attributes: Record<string, unknown> };
    expect(params.attributes.version).toMatchObject({ value: 1n });
  });

  it("uses previous + 1 for this dapp, ignoring other dapps", async () => {
    const { value } = clients([
      { dapp: "demo", version: 4n },
      { dapp: "demo", version: 2n },
      { dapp: "other", version: 9n },
    ]);
    await expect(runPolicy(path, { env, clients: value })).resolves.toMatchObject({ version: 5 });
  });

  it("does not accept the builder key", async () => {
    const { value } = clients();
    await expect(runPolicy(path, { env: { BUILDER_PRIVATE_KEY: key }, clients: value })).rejects.toThrow(/CURATOR_PRIVATE_KEY is not set/);
  });

  it("normalizes builder addresses to checksummed form", async () => {
    write({ ...policy, builders: builders.map((b) => b.toLowerCase()) });
    const { value, createEntity } = clients();
    await runPolicy(path, { env, clients: value });
    const params = createEntity.mock.calls[0]?.[0] as { payload: Uint8Array };
    expect(decodePayload<{ builders: string[] }>(params.payload).builders).toEqual(builders);
  });

  it.each([
    ["an invalid builder address", { builders: ["0x1234", builders[1]] }],
    ["a threshold above the distinct builder count", { builders: [builders[0], builders[0]] }],
    ["a zero threshold", { threshold: 0 }],
    ["a fractional acceptLatest", { acceptLatest: 1.5 }],
    ["an unknown field", { extra: true }],
    ["a missing recovery", { recovery: undefined }],
  ])("refuses %s without publishing", async (_, change) => {
    write({ ...policy, ...change });
    const { value, createEntity } = clients();
    await expect(runPolicy(path, { env, clients: value })).rejects.toMatchObject({ exitCode: 1 });
    expect(createEntity).not.toHaveBeenCalled();
  });
});
