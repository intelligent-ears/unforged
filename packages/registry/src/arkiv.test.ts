import { readFileSync } from "node:fs";
import { canonicalJSON, type Manifest, type Policy, type SignedAttestation } from "@unforged/core";
import { gunzipSync, strFromU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  decodePayload,
  encodePayload,
  fetchAttestations,
  fetchPolicies,
  findAttestationKey,
  publishAttestation,
  publishPolicy,
  type ReadClient,
  type WriteClient,
} from "./arkiv.js";

const BUILDER = "0x1111111111111111111111111111111111111111" as const;
const CURATOR = "0x2222222222222222222222222222222222222222" as const;

const manifest = (release: string): Manifest => ({
  version: 1,
  dapp: "demo",
  release,
  commit: "a".repeat(40),
  files: { "/index.html": "b".repeat(64) },
  config: {},
});
const attestation = { statement: { marker: "signed" }, signature: "0x00" } as unknown as SignedAttestation;
const body = (release: string) => encodePayload({ attestation, manifest: manifest(release) });
const str = (value: string) => ({ type: "str", value });

const policy: Policy = {
  dapp: "demo",
  origins: ["http://localhost:8080"],
  repo: "https://example.com/repo",
  builders: [BUILDER],
  threshold: 1,
  acceptLatest: 3,
  thirdParty: {},
  recovery: { gateway: "TODO" },
};

/** A linked list of result pages, the shape of the SDK's QueryResult. */
function pages<T>(...contents: T[][]) {
  const pageAt = (index: number): unknown => ({
    entities: contents[index],
    hasNextPage: () => index < contents.length - 1,
    next: async () => pageAt(index + 1),
  });
  return pageAt(0);
}

/** Records each query and answers it with `result`. getEntity reads `payloads` by key. */
function mockReadClient(result: unknown, payloads: Record<string, Uint8Array> = {}) {
  const query = {
    where: vi.fn(() => query),
    createdBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    fetch: vi.fn(async () => result),
  };
  const select = vi.fn(() => query);
  const getEntity = vi.fn(async (key: string) => ({ key, payload: payloads[key] }));
  return { client: { select, getEntity } as unknown as ReadClient, select, query, getEntity };
}

function mockWriteClient() {
  const createEntity = vi.fn(async (_: unknown) => ({ entityKey: "0xkey", txHash: "0xtx", expiresAt: 1n }));
  return { client: { createEntity } as unknown as WriteClient, createEntity };
}

const attributeOf = (key: string, swarmRef = "none") => ({ key, attributes: { swarm_ref: str(swarmRef) } });

describe("payload", () => {
  it("round-trips through gzip and canonical JSON", () => {
    const value = { b: [1, { d: "é", c: 2 }], a: "x" };
    expect(decodePayload(encodePayload(value))).toEqual(value);
  });

  it("gzips the canonical form, byte-identically for equal values", () => {
    const encoded = encodePayload({ b: 1, a: 2 });
    expect(strFromU8(gunzipSync(encoded))).toBe(canonicalJSON({ a: 2, b: 1 }));
    expect(encodePayload({ a: 2, b: 1 })).toEqual(encoded);
  });
});

describe("arkiv.ts", () => {
  it("has no Node imports, because the extension bundles it", () => {
    const source = readFileSync(new URL("./arkiv.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "(node:|fs|path|crypto|os)/);
    expect(source).not.toMatch(/process\.|Buffer/);
  });
});

describe("fetchAttestations", () => {
  it("lists without payloads, scoped to the builder and dapp", async () => {
    const { client, select, query } = mockReadClient(pages([]));
    await fetchAttestations(client, BUILDER, "demo");

    expect(select).toHaveBeenCalledWith({ key: true, attributes: true });
    expect(query.createdBy).toHaveBeenCalledWith(BUILDER);
    expect(query.limit).toHaveBeenCalledWith(200);
    expect(JSON.stringify(query.where.mock.calls)).toContain("attestation");
    expect(JSON.stringify(query.where.mock.calls)).toContain("demo");
    expect(JSON.stringify(query.where.mock.calls)).toContain("unforged");
  });

  it("walks every page", async () => {
    const payloads = { "0xa": body("1"), "0xb": body("2"), "0xc": body("3") };
    const listing = pages([attributeOf("0xa")], [attributeOf("0xb")], [attributeOf("0xc")]);
    const { client } = mockReadClient(listing, payloads);

    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(entries.map((e) => e.entityKey)).toEqual(["0xa", "0xb", "0xc"]);
    expect(entries.map((e) => e.manifest.release)).toEqual(["1", "2", "3"]);
  });

  it("downloads payloads only for keys not in skipKeys", async () => {
    const payloads = { "0xa": body("1"), "0xb": body("2") };
    const { client, getEntity } = mockReadClient(pages([attributeOf("0xa")], [attributeOf("0xb")]), payloads);

    const entries = await fetchAttestations(client, BUILDER, "demo", new Set(["0xa"]));
    expect(getEntity.mock.calls).toEqual([["0xb"]]);
    expect(entries.map((e) => e.entityKey)).toEqual(["0xb"]);
  });

  it("returns the swarm ref from the attribute, with none as null", async () => {
    const ref = "c".repeat(64);
    const payloads = { "0xa": body("1"), "0xb": body("2") };
    const { client } = mockReadClient(pages([attributeOf("0xa"), attributeOf("0xb", ref)]), payloads);

    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(entries.map((e) => e.swarmRef)).toEqual([null, ref]);
  });

  it("returns the decoded entry with the queried creator", async () => {
    const { client } = mockReadClient(pages([attributeOf("0xa")]), { "0xa": body("1") });
    const [entry] = await fetchAttestations(client, BUILDER, "demo");
    expect(entry).toEqual({ entityKey: "0xa", creator: BUILDER, attestation, manifest: manifest("1"), swarmRef: null });
  });

  it("drops an undecodable payload but keeps the rest", async () => {
    const payloads = { "0xa": new Uint8Array([1, 2, 3]), "0xb": body("2") };
    const { client } = mockReadClient(pages([attributeOf("0xa"), attributeOf("0xb")]), payloads);
    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(entries.map((e) => e.entityKey)).toEqual(["0xb"]);
  });

  it("propagates a network failure instead of returning a partial list", async () => {
    const { client, getEntity } = mockReadClient(pages([attributeOf("0xa")]));
    getEntity.mockRejectedValue(new Error("rpc down"));
    await expect(fetchAttestations(client, BUILDER, "demo")).rejects.toThrow("rpc down");
  });
});

describe("fetchPolicies", () => {
  const entity = (version: bigint, payload: Uint8Array) => ({
    payload,
    attributes: { version: { type: "u64", value: version } },
  });

  it("walks every page, scoped to the curator, highest version first", async () => {
    const listing = pages([entity(1n, encodePayload(policy))], [entity(3n, encodePayload(policy)), entity(2n, encodePayload(policy))]);
    const { client, select, query } = mockReadClient(listing);

    const policies = await fetchPolicies(client, CURATOR);
    expect(select).toHaveBeenCalledWith({ payload: true, attributes: true });
    expect(query.createdBy).toHaveBeenCalledWith(CURATOR);
    expect(JSON.stringify(query.where.mock.calls)).toContain("policy");
    expect(policies.map((p) => p.version)).toEqual([3, 2, 1]);
    expect(policies[0]?.policy).toEqual(policy);
  });

  it("drops an entity it can't decode", async () => {
    const { client } = mockReadClient(pages([entity(2n, new Uint8Array([9])), entity(1n, encodePayload(policy))]));
    expect((await fetchPolicies(client, CURATOR)).map((p) => p.version)).toEqual([1]);
  });
});

describe("findAttestationKey", () => {
  it("looks up by manifest root for this creator", async () => {
    const { client, query } = mockReadClient(pages([{ key: "0xa" }]));
    await expect(findAttestationKey(client, BUILDER, "d".repeat(64))).resolves.toBe("0xa");
    expect(query.createdBy).toHaveBeenCalledWith(BUILDER);
    expect(JSON.stringify(query.where.mock.calls)).toContain("d".repeat(64));
  });

  it("returns null when there is none", async () => {
    const { client } = mockReadClient(pages([]));
    await expect(findAttestationKey(client, BUILDER, "d".repeat(64))).resolves.toBeNull();
  });
});

describe("publish", () => {
  const attrs = {
    dapp: "demo",
    release: "1",
    commit: "a".repeat(40),
    manifest_root: "d".repeat(64),
    recipe_digest: "e".repeat(64),
    swarm_ref: "none",
  };
  const NEVER_EXTENDABLE = { readonly: true, permissionlessExtension: false };

  it("creates a readonly gzipped attestation entity with the formats.md attributes", async () => {
    const { client, createEntity } = mockWriteClient();
    const payload = { attestation, manifest: manifest("1") };

    await expect(publishAttestation(client, payload, attrs)).resolves.toEqual({ entityKey: "0xkey", txHash: "0xtx" });

    const params = createEntity.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.contentType).toBe("application/gzip");
    expect(params.flags).toEqual(NEVER_EXTENDABLE);
    expect(params.attributes).toEqual({ project: "unforged", entity_type: "attestation", ...attrs });
    expect(decodePayload(params.payload as Uint8Array)).toEqual(payload);
    expect(params.expires).toBeDefined();
  });

  it("refuses a payload over 120 KB without sending anything", async () => {
    const { client, createEntity } = mockWriteClient();
    // These digits barely compress, like a real manifest's hashes.
    const files = Object.fromEntries(
      Array.from({ length: 6000 }, (_, i) => [`/${i}`, `${Math.sin(i + 1)}${Math.cos(i + 1)}${Math.tan(i + 1)}`]),
    );
    const big = { attestation, manifest: { ...manifest("1"), files } };
    await expect(publishAttestation(client, big, attrs)).rejects.toThrow(/120 KB/);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("creates a policy entity with a u64 version", async () => {
    const { client, createEntity } = mockWriteClient();
    await publishPolicy(client, policy, 7);

    const params = createEntity.mock.calls[0]?.[0] as { attributes: Record<string, any>; payload: Uint8Array; flags: unknown };
    expect(params.attributes.project).toBe("unforged");
    expect(params.attributes.entity_type).toBe("policy");
    expect(params.attributes.dapp).toBe("demo");
    expect(params.attributes.version).toMatchObject({ type: "u64", value: 7n });
    expect(params.flags).toEqual(NEVER_EXTENDABLE);
    expect(decodePayload(params.payload)).toEqual(policy);
  });
});
