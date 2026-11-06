import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalJSON, manifestRoot, statementDigest, type Hex, type Manifest, type Policy, type SignedAttestation, type Statement } from "@unforged/core";
import { signPolicy } from "@unforged/core";
import { encodePayload, fetchPolicies, type ReadClient } from "@unforged/registry";
import { bytesToHex } from "viem";
import { emptySyncState, errorText, sync, withFixture, type CachedEntry, type Registry, type SyncState } from "./sync.js";

const CURATOR = "0x9373547bD5171EA42f2A63ED27E631FDCDc43E93";
const NOW = new Date("2026-11-05T10:00:00Z");
const REPO = "https://github.com/example/demo";
const builders = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));

function policy(over: Partial<Policy> = {}): Policy {
  return {
    dapp: "demo",
    origins: ["http://localhost:8080"],
    repo: REPO,
    builders: builders.map((b) => b.address),
    threshold: 2,
    acceptLatest: 3,
    thirdParty: {},
    recovery: { gateway: "https://mirror.example.org/" },
    ...over,
  };
}

function manifest(release: string): Manifest {
  return { version: 1, dapp: "demo", release, commit: "c".repeat(40), files: { "/index.html": "a".repeat(64) }, config: {} };
}

async function entry(builder: number, release: string, key: string): Promise<CachedEntry> {
  const m = manifest(release);
  const statement: Statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `demo@${release}`, digest: { sha256: await manifestRoot(m) } }],
    predicateType: "https://unforged.dev/rebuild/v1",
    predicate: {
      repo: REPO,
      commit: m.commit,
      recipeDigest: "d".repeat(64),
      builder: builders[builder]!.address,
      builtAt: `2026-11-0${release.at(0)}T00:00:00Z`, // newer release, newer build
      toolchain: { node: "24", packageManager: "yarn@4.17.1", os: "linux" },
    },
  };
  const signature = await builders[builder]!.signMessage({ message: { raw: await statementDigest(statement) } });
  return {
    entityKey: key,
    creator: builders[builder]!.address,
    attestation: { statement, signature } satisfies SignedAttestation,
    manifest: m,
    swarmRef: `demo-${release}`,
  };
}

/** A registry over fixed data that records what it was asked. */
function registry(policies: { version: number; policy: unknown }[], entries: CachedEntry[]) {
  const calls: { builder: Hex; dapp: string; skip: string[] }[] = [];
  const reg: Registry = {
    async fetchPolicies(curator) {
      expect(curator).toBe(CURATOR);
      return policies as { version: number; policy: Policy }[];
    },
    async fetchAttestations(builder, dapp, skipKeys) {
      calls.push({ builder, dapp, skip: [...skipKeys].sort() });
      const forDapp = (e: CachedEntry) => typeof e.manifest !== "object" || e.manifest.dapp === dapp; // garbage is listed too
      return entries.filter((e) => e.creator === builder && forDapp(e) && !skipKeys.has(e.entityKey));
    },
  };
  return { reg, calls };
}

const failing: Registry = {
  fetchPolicies: async () => {
    throw new Error("HTTP 503 from rpc");
  },
  fetchAttestations: async () => [],
};

describe("sync", () => {
  it("keeps the highest policy version and accepts releases with enough builders", async () => {
    const entries = [await entry(0, "2.0.0", "0xa"), await entry(1, "2.0.0", "0xb"), await entry(0, "1.0.0", "0xc")];
    const { reg } = registry([{ version: 1, policy: policy({ threshold: 1 }) }, { version: 2, policy: policy() }], entries);

    const next = await sync(reg, CURATOR, emptySyncState(), NOW);

    expect(next.lastError).toBeNull();
    expect(next.snapshot?.syncedAt).toBe(NOW.toISOString());
    const demo = next.snapshot!.dapps.demo!;
    expect(demo.policyVersion).toBe(2);
    expect(demo.policy.threshold).toBe(2);
    expect(demo.releases.map((r) => r.release)).toEqual(["2.0.0"]);
    expect(demo.releases[0]!.swarmRefs).toEqual(["demo-2.0.0"]);
    expect(Object.keys(next.entries).sort()).toEqual(["0xa", "0xb", "0xc"]);
    expect(next.changed).toBe(true);
  });

  it("downloads only unseen attestations and merges them with the cache", async () => {
    const first = [await entry(0, "2.0.0", "0xa")];
    const later = [...first, await entry(1, "2.0.0", "0xb")];
    const before = await sync(registry([{ version: 1, policy: policy() }], first).reg, CURATOR, emptySyncState(), NOW);
    expect(before.snapshot!.dapps.demo!.releases).toEqual([]);

    const { reg, calls } = registry([{ version: 1, policy: policy() }], later);
    const after = await sync(reg, CURATOR, before, NOW);

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.dapp === "demo" && c.skip.join() === "0xa")).toBe(true);
    expect(after.snapshot!.dapps.demo!.releases.map((r) => r.builders.length)).toEqual([2]);
    expect(after.changed).toBe(true);
  });

  it("reports no change when nothing new arrived", async () => {
    const entries = [await entry(0, "2.0.0", "0xa"), await entry(1, "2.0.0", "0xb")];
    const { reg } = registry([{ version: 1, policy: policy() }], entries);
    const once = await sync(reg, CURATOR, emptySyncState(), NOW);
    const twice = await sync(reg, CURATOR, once, new Date("2026-11-05T10:10:00Z"));
    expect(twice.changed).toBe(false);
    expect(twice.snapshot!.syncedAt).toBe("2026-11-05T10:10:00.000Z");
  });

  it("keeps the last good snapshot and records the error when a fetch fails", async () => {
    const entries = [await entry(0, "2.0.0", "0xa"), await entry(1, "2.0.0", "0xb")];
    const good = await sync(registry([{ version: 1, policy: policy() }], entries).reg, CURATOR, emptySyncState(), NOW);

    const failed = await sync(failing, CURATOR, good, new Date("2026-11-05T10:10:00Z"));
    expect(failed.snapshot).toEqual(good.snapshot);
    expect(failed.entries).toEqual(good.entries);
    expect(failed.lastError).toContain("HTTP 503");
    expect(failed.changed).toBe(false);

    const leaky: Registry = { ...failing, fetchPolicies: () => Promise.reject(new Error("failed: https://rpc/k3y-abc")) };
    expect((await sync(leaky, CURATOR, good, NOW, "k3y-abc")).lastError).not.toContain("k3y-abc");

    const attestationsDown: Registry = { ...registry([{ version: 1, policy: policy() }], []).reg, fetchAttestations: () => Promise.reject(new Error("HTTP 429")) };
    expect((await sync(attestationsDown, CURATOR, good, NOW)).snapshot).toEqual(good.snapshot);
  });

  it("skips undecodable policies and attestations instead of failing", async () => {
    const valid = [await entry(0, "2.0.0", "0xa"), await entry(1, "2.0.0", "0xb")];
    const garbage = { ...(await entry(2, "2.0.0", "0xd")), manifest: "not a manifest" } as unknown as CachedEntry;
    const policies = [
      { version: 9, policy: { dapp: "demo", origins: "http://localhost:8080" } }, // malformed
      { version: 8, policy: null },
      { version: 1, policy: policy() },
      { version: 1, policy: { ...policy(), dapp: "other", origins: [42] } },
    ];
    const next = await sync(registry(policies, [...valid, garbage]).reg, CURATOR, emptySyncState(), NOW);

    expect(next.lastError).toBeNull();
    expect(Object.keys(next.snapshot!.dapps)).toEqual(["demo"]);
    expect(next.snapshot!.dapps.demo!.policyVersion).toBe(1);
    expect(next.snapshot!.dapps.demo!.releases).toHaveLength(1);
    expect(next.entries).not.toHaveProperty("0xd");
  });

  it("drops cached attestations of builders no longer allowlisted", async () => {
    const entries = [await entry(0, "2.0.0", "0xa"), await entry(1, "2.0.0", "0xb")];
    const before = await sync(registry([{ version: 1, policy: policy() }], entries).reg, CURATOR, emptySyncState(), NOW);
    const narrowed = policy({ builders: [builders[0]!.address], threshold: 1 });
    const after = await sync(registry([{ version: 2, policy: narrowed }], entries).reg, CURATOR, before, NOW);
    expect(Object.keys(after.entries)).toEqual(["0xa"]);
    expect(after.snapshot!.dapps.demo!.releases[0]!.builders).toEqual([builders[0]!.address]);
  });

  it("produces a snapshot that is plain JSON", async () => {
    const entries = [await entry(0, "2.0.0", "0xa"), await entry(1, "2.0.0", "0xb")];
    const next = await sync(registry([{ version: 1, policy: policy() }], entries).reg, CURATOR, emptySyncState(), NOW);
    const state: SyncState = { snapshot: next.snapshot, entries: next.entries, lastError: next.lastError };
    expect(JSON.parse(canonicalJSON(state))).toEqual(state);
  });

});

describe("errorText", () => {
  it("never contains the access key and stays short", () => {
    const error = new Error(`HTTP request failed.\n\nURL: https://rabdi.example/rpc/s3cret-key\nRequest body: ${"x".repeat(900)}`);
    const text = errorText(error, "s3cret-key");
    expect(text).not.toContain("s3cret-key");
    expect(text.length).toBeLessThanOrEqual(300);
    expect(errorText("plain", "")).toBe("plain");
  });
});

describe("withFixture", () => {
  const entry = (dapp: string, origin: string, policyVersion: number) => ({
    policy: policy({ dapp, origins: [origin] }),
    releases: [],
    policyVersion,
  });
  const fixture = { syncedAt: "2026-11-01T00:00:00Z", dapps: { demo: entry("demo", "http://localhost:8080", 0) } };

  it("fills in fixture dapps the synced snapshot doesn't have", () => {
    const merged = withFixture({ syncedAt: NOW.toISOString(), dapps: {} }, fixture);
    expect(merged?.syncedAt).toBe(NOW.toISOString());
    expect(merged?.dapps.demo).toEqual(fixture.dapps.demo);
    expect(withFixture(null, fixture)).toEqual(fixture);
  });

  it("keeps the synced entry for a dapp both have, and lists synced dapps first", () => {
    const synced = { syncedAt: NOW.toISOString(), dapps: { other: entry("other", "http://other", 2), demo: entry("demo", "http://synced", 3) } };
    const merged = withFixture(synced, { ...fixture, dapps: { extra: entry("extra", "http://extra", 0), ...fixture.dapps } });
    expect(merged?.dapps.demo).toEqual(synced.dapps.demo);
    expect(Object.keys(merged!.dapps)).toEqual(["other", "demo", "extra"]);
  });

  it("is the synced snapshot when there is no fixture", () => {
    const synced = { syncedAt: NOW.toISOString(), dapps: {} };
    expect(withFixture(synced, null)).toBe(synced);
    expect(withFixture(null, null)).toBeNull();
  });
});

describe("sync over the real registry decoder", () => {
  const curator = privateKeyToAccount(generatePrivateKey());
  const forger = privateKeyToAccount(generatePrivateKey());

  /** An Arkiv node that ignores the creator filter and returns whatever rows it likes. */
  function lyingArkiv(rows: { creator: Hex; version: bigint; payload: unknown }[]): Registry {
    const entities = rows.map((r, i) => ({
      $key: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      $creator: r.creator,
      $creationFlags: { readonly: true, permissionlessExtension: false },
      version: { type: "u64", value: r.version },
      payload: { type: "bytes", value: bytesToHex(encodePayload(r.payload)) },
    }));
    const query = { where: () => query, createdBy: () => query, orderBy: () => query, limit: () => query, fetch: async () => ({ entities }) };
    const client = { select: () => query, getEntity: async () => ({}) } as unknown as ReadClient;
    return { fetchPolicies: (c) => fetchPolicies(client, c), fetchAttestations: async () => [] };
  }

  it("ignores forged, tampered, unsigned and wrong-creator policies and keeps the curator's", async () => {
    const genuine = await signPolicy(policy({ threshold: 2 }), curator);
    const permissive = policy({ threshold: 1, builders: [forger.address] });
    const reg = lyingArkiv([
      { creator: curator.address, version: 1n, payload: genuine },
      { creator: curator.address, version: 5n, payload: await signPolicy(permissive, forger) }, // signed by another key
      { creator: curator.address, version: 4n, payload: { ...genuine, policy: permissive } }, // altered after signing
      { creator: curator.address, version: 3n, payload: permissive }, // old unsigned format
      { creator: forger.address, version: 2n, payload: genuine }, // replayed under another creator
    ]);

    const next = await sync(reg, curator.address, emptySyncState(), NOW);
    expect(next.lastError).toBeNull();
    expect(next.snapshot!.dapps.demo).toMatchObject({ policyVersion: 1, policy: { threshold: 2 } });
  });

  it("drops the dapp when its only policy is forged", async () => {
    const reg = lyingArkiv([{ creator: curator.address, version: 1n, payload: await signPolicy(policy(), forger) }]);
    const next = await sync(reg, curator.address, emptySyncState(), NOW);
    expect(next.snapshot!.dapps).toEqual({});
  });
});
