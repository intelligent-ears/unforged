import { readFileSync } from "node:fs";
import { canonicalJSON, type Manifest, type Policy, type SignedAttestation } from "@unforged/core";
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { gunzipSync, strFromU8 } from "fflate";
import { bytesToHex, custom } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  createReadClient,
  createWriteClient,
  decodePayload,
  encodePayload,
  fetchAttestations,
  fetchPolicies,
  findAttestation,
  publishAttestation,
  publishPolicy,
  type ReadClient,
  type WriteClient,
} from "./arkiv.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BUILDER = "0x1111111111111111111111111111111111111111" as const;
const CURATOR = "0x2222222222222222222222222222222222222222" as const;
const READONLY = { readonly: true, permissionlessExtension: false };

const keyOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const manifest = (release: string): Manifest => ({
  version: 1,
  dapp: "demo",
  release,
  commit: "a".repeat(40),
  files: { "/index.html": "b".repeat(64) },
  config: {},
});
const attestation = { statement: { marker: "signed" }, signature: "0x00" } as unknown as SignedAttestation;
const bytesAttr = (payload: Uint8Array) => ({ type: "bytes", value: bytesToHex(payload) });
const body = (release: string) => encodePayload({ attestation, manifest: manifest(release) });

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

/** Answers each fetch with the next page, and records what each query asked for. */
function mockReadClient(pages: unknown[][], payloads: Record<string, Uint8Array> = {}) {
  const queries: { where: unknown[]; createdBy?: string; limit?: number; orderBy?: unknown; selection: unknown }[] = [];
  const select = vi.fn((selection: unknown) => {
    const record: (typeof queries)[number] = { where: [], selection };
    queries.push(record);
    const query = {
      where: (...e: unknown[]) => (record.where.push(...e), query),
      createdBy: (a: string) => ((record.createdBy = a), query),
      limit: (n: number) => ((record.limit = n), query),
      orderBy: (o: unknown) => ((record.orderBy = o), query),
      fetch: async () => ({ entities: pages[queries.length - 1] ?? [], blockNumber: 1n, skipped: 0, count: undefined }),
    };
    return query;
  });
  const getEntity = vi.fn(async (key: string) => ({
    $key: key,
    $attributes: payloads[key] === undefined ? {} : { payload: bytesAttr(payloads[key]!) },
  }));
  return { client: { select, getEntity } as unknown as ReadClient, queries, getEntity };
}

function mockWriteClient() {
  const createEntity = vi.fn(async (..._: unknown[]) => ({ entityKey: "0xkey", txHash: "0xtx", expiresAt: 1n }));
  return { client: { createEntity } as unknown as WriteClient, createEntity };
}

const listed = (key: string, swarmRef = "none", flags: unknown = READONLY) => ({
  $key: key,
  $creationFlags: flags,
  swarm_ref: { type: "str", value: swarmRef },
});

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

describe("clients", () => {
  const httpUrl = (client: { chain: { rpcUrls: { default: { http: readonly string[] } } } }) => client.chain.rpcUrls.default.http[0];

  it("reads keyless by default, on the public Rabdi endpoint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createReadClient();
    warn.mockRestore();
    expect(client.chain.id).toBe(7794095);
    expect(httpUrl(client)).toBe("https://rpc.rabdi.db-chain.testnet.arkiv.network");
  });

  it("puts a supplied access key in the URL only", () => {
    const client = createReadClient("test-access-key");
    expect(httpUrl(client)).toBe("https://rpc.rabdi.db-chain.testnet.arkiv.network/test-access-key");
  });

  it("writes on Rabdi", () => {
    const client = createWriteClient(privateKeyToAccount(generatePrivateKey()), "test-access-key");
    expect(client.chain.id).toBe(7794095);
  });
});

describe("fetchAttestations", () => {
  it("lists without payloads, scoped to the builder and dapp", async () => {
    const { client, queries } = mockReadClient([[]]);
    await fetchAttestations(client, BUILDER, "demo");

    expect(queries[0]?.selection).toEqual({ $key: true, $creationFlags: true, swarm_ref: true });
    expect(queries[0]?.createdBy).toBe(BUILDER);
    const filters = JSON.stringify(queries[0]?.where, (_, v) => (typeof v === "bigint" ? `${v}` : v));
    for (const value of ["unforged", "attestation", "demo"]) expect(filters).toContain(value);
  });

  it("walks full pages by keyset until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => listed(keyOf(i + 1)));
    const { client, queries } = mockReadClient([fullPage, [listed(keyOf(101))]], {
      [keyOf(1)]: body("1"),
      [keyOf(101)]: body("2"),
    });

    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(queries).toHaveLength(2);
    expect(queries.every((q) => q.limit === 100 && q.orderBy !== undefined)).toBe(true);
    expect(queries[0]?.where).toHaveLength(1); // the filters only
    expect(queries[1]?.where).toHaveLength(2); // the filters, then $key > the last key seen
    expect(JSON.stringify(queries[1]?.where[1])).toContain(keyOf(100));
    expect(entries.map((e) => e.manifest.release)).toEqual(["1", "2"]);
  });

  it("fails rather than looping if the keyset doesn't advance", async () => {
    const stuck = Array.from({ length: 100 }, () => listed(keyOf(1)));
    const { client } = mockReadClient([stuck, stuck], { [keyOf(1)]: body("1") });
    await expect(fetchAttestations(client, BUILDER, "demo")).rejects.toThrow(/advance/);
  });

  it("fails rather than returning a partial list past the page budget", async () => {
    const pageAt = (p: number) => Array.from({ length: 100 }, (_, i) => listed(keyOf(p * 100 + i + 1)));
    const { client } = mockReadClient(Array.from({ length: 60 }, (_, p) => pageAt(p)));
    await expect(fetchAttestations(client, BUILDER, "demo")).rejects.toThrow(/page budget/);
  });

  it("downloads payloads only for keys not in skipKeys", async () => {
    const payloads = { "0xa": body("1"), "0xb": body("2") };
    const { client, getEntity } = mockReadClient([[listed("0xa"), listed("0xb")]], payloads);

    const entries = await fetchAttestations(client, BUILDER, "demo", new Set(["0xa"]));
    expect(getEntity.mock.calls).toEqual([["0xb"]]);
    expect(entries.map((e) => e.entityKey)).toEqual(["0xb"]);
  });

  it("returns the swarm ref from the attribute, with none as null", async () => {
    const ref = "c".repeat(64);
    const payloads = { "0xa": body("1"), "0xb": body("2") };
    const { client } = mockReadClient([[listed("0xa"), listed("0xb", ref)]], payloads);

    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(entries.map((e) => e.swarmRef)).toEqual([null, ref]);
  });

  it("returns the decoded entry with the queried creator", async () => {
    const { client } = mockReadClient([[listed("0xa")]], { "0xa": body("1") });
    const [entry] = await fetchAttestations(client, BUILDER, "demo");
    expect(entry).toEqual({ entityKey: "0xa", creator: BUILDER, attestation, manifest: manifest("1"), swarmRef: null });
  });

  it("drops an undecodable or missing payload but keeps the rest", async () => {
    const payloads = { "0xa": new Uint8Array([1, 2, 3]), "0xc": body("2") };
    const { client } = mockReadClient([[listed("0xa"), listed("0xb"), listed("0xc")]], payloads);
    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(entries.map((e) => e.entityKey)).toEqual(["0xc"]);
  });

  it("drops an entity that isn't readonly, since a transfer could have edited it", async () => {
    const mutable = { readonly: false, permissionlessExtension: false };
    const { client, getEntity } = mockReadClient([[listed("0xa", "none", mutable), listed("0xb")]], { "0xb": body("2") });
    const entries = await fetchAttestations(client, BUILDER, "demo");
    expect(entries.map((e) => e.entityKey)).toEqual(["0xb"]);
    expect(getEntity).toHaveBeenCalledTimes(1);
  });

  it("propagates a network failure instead of returning a partial list", async () => {
    const { client, getEntity } = mockReadClient([[listed("0xa")]]);
    getEntity.mockRejectedValue(new Error("rpc down"));
    await expect(fetchAttestations(client, BUILDER, "demo")).rejects.toThrow("rpc down");
  });
});

describe("fetchPolicies", () => {
  const entity = (n: number, version: bigint, payload: Uint8Array, flags: unknown = READONLY) => ({
    $key: keyOf(n),
    $creationFlags: flags,
    payload: bytesAttr(payload),
    version: { type: "u64", value: version },
  });

  it("walks every page, scoped to the curator, highest version first", async () => {
    const full = Array.from({ length: 100 }, (_, i) => entity(i + 1, BigInt(i + 1), encodePayload(policy)));
    const { client, queries } = mockReadClient([full, [entity(200, 500n, encodePayload(policy))]]);

    const policies = await fetchPolicies(client, CURATOR);
    expect(queries[0]?.createdBy).toBe(CURATOR);
    expect(JSON.stringify(queries[0]?.where)).toContain("policy");
    expect(policies).toHaveLength(101);
    expect(policies.slice(0, 2).map((p) => p.version)).toEqual([500, 100]);
    expect(policies[0]?.policy).toEqual(policy);
  });

  it("drops an entity it can't decode, or with a mistyped version", async () => {
    const bad = { ...entity(3, 3n, encodePayload(policy)), version: { type: "str", value: "3" } };
    const { client } = mockReadClient([[entity(2, 2n, new Uint8Array([9])), bad, entity(1, 1n, encodePayload(policy))]]);
    expect((await fetchPolicies(client, CURATOR)).map((p) => p.version)).toEqual([1]);
  });

  it("drops a policy that isn't readonly", async () => {
    const mutable = { readonly: false, permissionlessExtension: false };
    const { client } = mockReadClient([[entity(2, 2n, encodePayload(policy), mutable), entity(1, 1n, encodePayload(policy))]]);
    expect((await fetchPolicies(client, CURATOR)).map((p) => p.version)).toEqual([1]);
  });
});

describe("findAttestation", () => {
  it("looks up by manifest root for this creator", async () => {
    const { client, queries } = mockReadClient([[{ $key: "0xa", swarm_ref: { type: "str", value: "lido-0.161.0" } }]]);
    await expect(findAttestation(client, BUILDER, "d".repeat(64))).resolves.toEqual({ entityKey: "0xa", swarmRef: "lido-0.161.0" });
    expect(queries[0]?.createdBy).toBe(BUILDER);
    expect(JSON.stringify(queries[0]?.where)).toContain("d".repeat(64));
  });

  it("reads swarm_ref none as no mirror", async () => {
    const { client } = mockReadClient([[{ $key: "0xa", swarm_ref: { type: "str", value: "none" } }]]);
    await expect(findAttestation(client, BUILDER, "d".repeat(64))).resolves.toEqual({ entityKey: "0xa", swarmRef: null });
  });

  it("returns null when there is none", async () => {
    const { client } = mockReadClient([[]]);
    await expect(findAttestation(client, BUILDER, "d".repeat(64))).resolves.toBeNull();
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

  it("creates a readonly attestation with the formats.md attributes and a gzip payload column", async () => {
    const { client, createEntity } = mockWriteClient();
    const payload = { attestation, manifest: manifest("1") };

    await expect(publishAttestation(client, payload, attrs)).resolves.toEqual({ entityKey: "0xkey", txHash: "0xtx" });

    const [schema, values, options] = createEntity.mock.calls[0] as [{ tag?: unknown; columns: Record<string, { type: string; isIndexed: boolean }> }, Record<string, unknown>, Record<string, unknown>];
    expect(schema.tag).toBeUndefined(); // unnamed: no extra arkiv.schema attribute
    const { payload: gz, ...rest } = values;
    expect(rest).toEqual({ project: "unforged", entity_type: "attestation", content_type: "application/gzip", ...attrs });
    expect(decodePayload(gz as Uint8Array)).toEqual(payload);
    expect(options.flags).toEqual(READONLY);
    expect(schema.columns.payload?.type).toBe("bytes");
    const indexed = Object.entries(schema.columns).filter(([, c]) => c.isIndexed).map(([n]) => n).sort();
    expect(indexed).toEqual(["commit", "dapp", "entity_type", "manifest_root", "project", "release"]);
  });

  it("uses the longest lifetime the chain allows", async () => {
    const { client, createEntity } = mockWriteClient();
    await publishAttestation(client, { attestation, manifest: manifest("1") }, attrs);
    const options = createEntity.mock.calls[0]?.[2] as { expiration: { minLifetime: bigint } };
    expect(options.expiration.minLifetime).toBe(7_884_000n);
  });

  it("asks prepare for tx params and sends them with the same operation", async () => {
    const { client, createEntity } = mockWriteClient();
    const params = { nonce: 5, gas: 2_000_000n, gasPrice: 1n };
    const unsigned = mockWriteClient();
    const prepare = vi.fn(async (write: (c: WriteClient) => Promise<unknown>) => (await write(unsigned.client), params));

    await publishAttestation(client, { attestation, manifest: manifest("1") }, attrs, prepare);

    const estimated = unsigned.createEntity.mock.calls[0] as unknown[];
    const sent = createEntity.mock.calls[0] as unknown[];
    expect(sent[3]).toEqual(params);
    expect(estimated[1]).toEqual(sent[1]);
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

    const [schema, values, options] = createEntity.mock.calls[0] as [{ columns: Record<string, { type: string; isIndexed: boolean }> }, Record<string, any>, Record<string, unknown>];
    expect(values.project).toBe("unforged");
    expect(values.entity_type).toBe("policy");
    expect(values.dapp).toBe("demo");
    expect(values.version).toMatchObject({ type: "u64", value: 7n });
    expect(schema.columns.version).toMatchObject({ type: "u64", isIndexed: true });
    expect(options.flags).toEqual(READONLY);
    expect(decodePayload(values.payload)).toEqual(policy);
  });
});

describe("through the real SDK, over a fake transport", () => {
  /** A public client whose arkiv_query answers from `pages`, recording the request. */
  function realClient(rows: unknown[]) {
    const requests: { query: string; options: Record<string, unknown> }[] = [];
    const client = createPublicClient({
      chain: rabdi({ accessKey: "test" }),
      transport: custom({
        async request({ method, params }: { method: string; params: unknown[] }) {
          if (method === "arkiv_query") {
            requests.push({ query: params[0] as string, options: params[1] as Record<string, unknown> });
            return { data: rows, blockNumber: "0x1" };
          }
          if (method === "arkiv_getEntity") return rows[0];
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    return { client: client as unknown as ReadClient, requests };
  }

  const rpcRow = {
    key: keyOf(1),
    creator: BUILDER,
    creationFlags: { readonly: true, permissionlessExtension: false, raw: 1 },
    attributes: [
      { name: "swarm_ref", type: "str", value: "none" },
      { name: "payload", type: "bytes", value: bytesToHex(body("1")) },
    ],
  };

  it("renders a query scoped to the creator with a valid page size", async () => {
    const { client, requests } = realClient([]);
    await fetchAttestations(client, BUILDER, "demo");
    const [{ query, options }] = requests as [(typeof requests)[number]];
    expect(query).toContain("$creator");
    expect(query.toLowerCase()).toContain(BUILDER);
    expect(query).toContain("unforged");
    expect(options.limit).toBe("0x64");
    expect(options.attributes ?? (options.select as Record<string, unknown>).attributes).toEqual({ swarm_ref: true });
  });

  it("decodes a real response into an entry", async () => {
    const { client } = realClient([rpcRow]);
    const [entry] = await fetchAttestations(client, BUILDER, "demo");
    expect(entry?.manifest.release).toBe("1");
    expect(entry?.swarmRef).toBeNull();
  });
});
