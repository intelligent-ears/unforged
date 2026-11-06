import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePayload, encodePayload, type ReadClient, type WriteClient } from "@unforged/registry";
import { signPolicy, verifyPolicy, type SignedPolicy } from "@unforged/core";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPolicy } from "./policy.js";

// The CLI's own self-check can be made to fail; everything else uses the real verifyPolicy.
vi.mock("@unforged/core", async (original) => {
  const core = await original<typeof import("@unforged/core")>();
  return { ...core, verifyPolicy: vi.fn(core.verifyPolicy) };
});

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const builders = [generatePrivateKey(), generatePrivateKey()].map((k) => privateKeyToAccount(k).address);

const TX_PARAMS = { nonce: 3, gas: 1_000_000n, gasPrice: 1n };

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

async function clients(existing: { dapp: string; version: bigint }[] = []) {
  const entities = await Promise.all(
    existing.map(async ({ dapp, version }, i) => ({
      $key: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      $creator: account.address,
      $creationFlags: { readonly: true, permissionlessExtension: false },
      payload: { type: "bytes", value: bytesToHex(encodePayload(await signPolicy({ ...policy, dapp }, account))) },
      version: { type: "u64", value: version },
    })),
  );
  const query = {
    where: () => query,
    createdBy: vi.fn(() => query),
    orderBy: () => query,
    limit: () => query,
    fetch: async () => ({ entities, blockNumber: 1n, skipped: 0 }),
  };
  const createEntity = vi.fn(async (..._: unknown[]) => ({ entityKey: "0xnew", txHash: "0xtx", expiresAt: 1n }));
  return {
    value: {
      read: { select: () => query, getEntity: vi.fn() } as unknown as ReadClient,
      write: { createEntity } as unknown as WriteClient,
      prepare: async () => TX_PARAMS,
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
    const { value, createEntity, query } = await clients();
    await expect(runPolicy(path, { env, clients: value })).resolves.toEqual({
      entityKey: "0xnew",
      txHash: "0xtx",
      version: 1,
      curator: account.address,
    });
    expect(query.createdBy).toHaveBeenCalledWith(account.address);
    const values = createEntity.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(values.version).toMatchObject({ value: 1n });
    expect(createEntity.mock.calls[0]?.[3]).toEqual(TX_PARAMS);
  });

  it("publishes the policy signed by the curator key", async () => {
    const { value, createEntity } = await clients();
    await runPolicy(path, { env, clients: value });
    const values = createEntity.mock.calls[0]?.[1] as { payload: Uint8Array };
    const signed = decodePayload<SignedPolicy>(values.payload);
    expect(signed.policy).toEqual(policy);
    expect(await verifyPolicy(signed, account.address)).toBe(true);
  });

  it("refuses to publish when its own signed output does not verify", async () => {
    vi.mocked(verifyPolicy).mockResolvedValueOnce(false);
    const { value, createEntity } = await clients();
    await expect(runPolicy(path, { env, clients: value })).rejects.toThrow(/does not verify/);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("uses previous + 1 for this dapp, ignoring other dapps", async () => {
    const { value } = await clients([
      { dapp: "demo", version: 4n },
      { dapp: "demo", version: 2n },
      { dapp: "other", version: 9n },
    ]);
    await expect(runPolicy(path, { env, clients: value })).resolves.toMatchObject({ version: 5 });
  });

  it("needs an access key to reach the registry", async () => {
    await expect(runPolicy(path, { env })).rejects.toThrow(/ARKIV_ACCESS_KEY is not set/);
  });

  it("does not accept the builder key", async () => {
    const { value } = await clients();
    await expect(runPolicy(path, { env: { BUILDER_PRIVATE_KEY: key }, clients: value })).rejects.toThrow(/CURATOR_PRIVATE_KEY is not set/);
  });

  it("normalizes builder addresses to checksummed form", async () => {
    write({ ...policy, builders: builders.map((b) => b.toLowerCase()) });
    const { value, createEntity } = await clients();
    await runPolicy(path, { env, clients: value });
    const values = createEntity.mock.calls[0]?.[1] as { payload: Uint8Array };
    expect(decodePayload<SignedPolicy>(values.payload).policy.builders).toEqual(builders);
  });

  it("publishes configPins as given", async () => {
    const configPins = { "/runtime/window-env.js": "1dc276f81fab369bcab6cd53b511e4090897b27501adae5b5b5cd9fd46489537" };
    write({ ...policy, configPins });
    const { value, createEntity } = await clients();
    await runPolicy(path, { env, clients: value });
    const values = createEntity.mock.calls[0]?.[1] as { payload: Uint8Array };
    expect(decodePayload<SignedPolicy>(values.payload).policy.configPins).toEqual(configPins);
  });

  it.each([
    ["a config pin that is not 64 lowercase hex", { configPins: { "/runtime/window-env.js": "ABC" } }],
    ["a config pin path without a leading slash", { configPins: { "runtime/window-env.js": "0".repeat(64) } }],
    ["an invalid builder address", { builders: ["0x1234", builders[1]] }],
    ["a threshold above the distinct builder count", { builders: [builders[0], builders[0]] }],
    ["a zero threshold", { threshold: 0 }],
    ["a fractional acceptLatest", { acceptLatest: 1.5 }],
    ["an unknown field", { extra: true }],
    ["a missing recovery", { recovery: undefined }],
  ])("refuses %s without publishing", async (_, change) => {
    write({ ...policy, ...change });
    const { value, createEntity } = await clients();
    await expect(runPolicy(path, { env, clients: value })).rejects.toMatchObject({ exitCode: 1 });
    expect(createEntity).not.toHaveBeenCalled();
  });
});
